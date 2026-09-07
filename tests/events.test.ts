import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../src/adapters/types.js';
import { nowIso } from '../src/core/ids.js';
import { findArtifactByPath, listArtifacts, readArtifact, writeArtifact } from '../src/storage/artifacts.js';
import { openDatabase, openStateStore } from '../src/storage/db.js';
import { EventPayloadTooLargeError, MAX_EVENT_PAYLOAD_BYTES, appendEvent, lastEventSequence, listEvents, replayEvents } from '../src/storage/events.js';
import { SchemaTooNewError, getSchemaVersion } from '../src/storage/migrations.js';
import { projectEventsJsonl, recordRuntimeEvent, runtimeEventIdempotencyKey } from '../src/telemetry/events.js';
import { openTempState, seedRunAndTask, type TempState } from './helpers/state.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

describe('event log', () => {
  it('allocates a monotonic per-run sequence, independent across runs and across connections', () => {
    const { run } = seedRunAndTask(state);
    const { run: other } = seedRunAndTask(state);
    const { db } = state.store;
    appendEvent(db, { runId: run.id, type: 'a' });
    appendEvent(db, { runId: other.id, type: 'x' });
    const second = openDatabase(state.paths.databasePath, { busyTimeoutMs: 2_000 });
    try {
      appendEvent(second, { runId: run.id, type: 'b' });
      appendEvent(db, { runId: run.id, type: 'c' });
    } finally {
      second.close();
    }
    expect(listEvents(db, run.id).map((e) => [e.sequence, e.type])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(listEvents(db, other.id).map((e) => e.sequence)).toEqual([1]);
    expect(lastEventSequence(db, run.id)).toBe(3);
  });

  it('ingests replayed events idempotently by key and replays in order from a cursor', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    const first = appendEvent(db, { runId: run.id, type: 'runtime.tool_call', idempotencyKey: 'fake:s1:1', payload: { n: 1 } });
    const again = appendEvent(db, { runId: run.id, type: 'runtime.tool_call', idempotencyKey: 'fake:s1:1', payload: { n: 'different' } });
    expect(again.appended).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    expect(again.event.payload).toEqual({ n: 1 });
    appendEvent(db, { runId: run.id, type: 'runtime.tool_result', idempotencyKey: 'fake:s1:2' });
    expect(lastEventSequence(db, run.id)).toBe(2);

    const seen: number[] = [];
    const cursor = replayEvents(db, run.id, (event) => seen.push(event.sequence), { batchSize: 1 });
    expect(seen).toEqual([1, 2]);
    expect(cursor).toBe(2);
    const later: number[] = [];
    expect(replayEvents(db, run.id, (event) => later.push(event.sequence), { afterSequence: cursor })).toBe(2);
    expect(later).toEqual([]);
  });

  it('projects events.jsonl as a redacted, append-only, idempotent view', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    appendEvent(db, { runId: run.id, type: 'runtime.command_exec', payload: { command: 'curl', env: { API_TOKEN: 'abc123secret' }, note: 'Authorization: Bearer eyJhbGciOi.payload.sig' } });
    appendEvent(db, { runId: run.id, type: 'runtime.turn_completed' });

    const first = projectEventsJsonl(db, state.paths, run.id);
    expect(first).toMatchObject({ appended: 2, lastSequence: 2 });
    const second = projectEventsJsonl(db, state.paths, run.id);
    expect(second).toMatchObject({ appended: 0, lastSequence: 2 });

    appendEvent(db, { runId: run.id, type: 'runtime.turn_started' });
    expect(projectEventsJsonl(db, state.paths, run.id)).toMatchObject({ appended: 1, lastSequence: 3 });

    const lines = readFileSync(state.paths.runEventsJsonlPath(run.id), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence)).toEqual([1, 2, 3]);
    expect(lines[0]).not.toContain('abc123secret');
    expect(lines[0]).not.toContain('eyJhbGciOi');
    expect(lines[0]).toContain('[REDACTED]');
    // the database keeps the raw value: redaction is a projection concern
    expect(JSON.stringify(listEvents(db, run.id)[0]!.payload)).toContain('abc123secret');
  });
});

describe('event row size', () => {
  function bigEvent(sequence: number, output: string): RuntimeEvent {
    return { kind: 'tool_result', adapter: 'fake', sessionId: 'fake-s1', turnId: 't1', spawnToken: 'spawn0001', sequence, timestamp: nowIso(), payload: { tool: 'shell', ok: true, output, nested: { lines: output.split('\n') } }, rawRef: `fake:fake-s1:spawn0001:${sequence}` };
  }

  it('refuses oversized payloads in appendEvent and spills runtime payloads to the artifact store instead', () => {
    const { run, task } = seedRunAndTask(state);
    const { db } = state.store;
    const output = 'x'.repeat(100 * 1024);
    expect(() => appendEvent(db, { runId: run.id, type: 'runtime.tool_result', payload: { output } })).toThrow(EventPayloadTooLargeError);
    expect(listEvents(db, run.id)).toEqual([]);

    const event = bigEvent(4, output);
    const ctx = { runId: run.id, taskId: task.id, paths: state.paths };
    const first = recordRuntimeEvent(db, event, ctx);
    expect(first.appended).toBe(true);
    const stored = first.event;
    expect(Buffer.byteLength(JSON.stringify(stored.payload))).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    expect(stored.payload).toMatchObject({ adapter: 'fake', sessionId: 'fake-s1', spawnToken: 'spawn0001', runtimeSequence: 4, rawRef: event.rawRef, tool: 'shell', ok: true, payloadTruncated: true, payloadBytes: expect.any(Number) });
    expect(String(stored.payload['output'])).toMatch(/^x{200}… \[truncated: 102400 bytes in artifact /);
    expect(String(stored.payload['nested'])).toMatch(/^\[omitted: \d+ bytes in artifact /);
    expect(stored.payloadRef).not.toBeNull();

    // The full payload is an artifact with a verified hash, referenced from the row.
    const artifact = readArtifact(db, state.paths, stored.payloadRef!);
    expect(artifact.record.type).toBe('runtime_event_payload');
    expect(artifact.record.relativePath).toBe('events/fake/fake-s1/spawn0001-4.json');
    expect(JSON.parse(artifact.bytes.toString('utf8'))).toEqual(event.payload);

    // Replaying the same runtime event is a no-op for both the row and the artifact.
    const again = recordRuntimeEvent(db, event, ctx);
    expect(again.appended).toBe(false);
    expect(again.event.id).toBe(stored.id);
    expect(listArtifacts(db, run.id)).toHaveLength(1);

    // Small events still land inline with no artifact.
    const small = recordRuntimeEvent(db, { ...bigEvent(5, 'short'), sequence: 5, rawRef: 'fake:fake-s1:spawn0001:5' }, ctx);
    expect(small.event.payloadRef).toBeNull();
    expect(small.event.payload).toMatchObject({ output: 'short' });
    expect(small.event.payload).not.toHaveProperty('payloadTruncated');
    expect(listArtifacts(db, run.id)).toHaveLength(1);
  });

  it('reuses bytes published before a crash between artifact receipt and event insert', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    const event = bigEvent(9, 'y'.repeat(50 * 1024));
    const relativePath = 'events/fake/fake-s1/spawn0001-9.json';
    const published = writeArtifact(db, state.paths, { runId: run.id, type: 'runtime_event_payload', relativePath, bytes: JSON.stringify(event.payload), provenance: { producer: 'earlier attempt' } });
    const result = recordRuntimeEvent(db, event, { runId: run.id, paths: state.paths });
    expect(result.appended).toBe(true);
    expect(result.event.payloadRef).toBe(published.id);
    expect(result.event.idempotencyKey).toBe(runtimeEventIdempotencyKey(event));
    expect(findArtifactByPath(db, run.id, relativePath)?.id).toBe(published.id);
    expect(listArtifacts(db, run.id)).toHaveLength(1);
  });
});

describe('schema migrations', () => {
  it('refuses a newer-than-supported schema without erasing it, in both modes', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    appendEvent(db, { runId: run.id, type: 'keep-me' });
    expect(getSchemaVersion(db)).toBe(1);
    db.exec('PRAGMA user_version = 99');
    state.store.close();

    expect(() => openStateStore(state.paths, { mode: 'read-only' })).toThrow(SchemaTooNewError);
    expect(() => openStateStore(state.paths, { mode: 'mutating' })).toThrow(SchemaTooNewError);

    const raw = new DatabaseSync(state.paths.databasePath, { readOnly: true });
    try {
      expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(99);
    } finally {
      raw.close();
    }
    // the mutating attempt must have released the lock even though it failed
    const reopened = new DatabaseSync(state.paths.databasePath);
    reopened.exec('PRAGMA user_version = 1');
    reopened.close();
    const store = openStateStore(state.paths, { mode: 'mutating' });
    store.close();
    // re-open the fixture store so cleanup can close it
    Object.assign(state, { store: openStateStore(state.paths, { mode: 'mutating' }) });
  });
});
