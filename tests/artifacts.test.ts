import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/snapshot.js';
import { ArtifactCorruptError, ArtifactExistsError, ArtifactMissingError, artifactAbsolutePath, readArtifact, verifyArtifact, writeArtifact } from '../src/storage/artifacts.js';
import { openTempState, seedRunAndTask, type TempState } from './helpers/state.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

describe('artifact store', () => {
  it('publishes bytes atomically, records the hash and reads them back verified', () => {
    const { run, task } = seedRunAndTask(state);
    const { db } = state.store;
    const bytes = Buffer.from('diff --git a/x b/x\n+fixed\n');
    const record = writeArtifact(db, state.paths, { runId: run.id, taskId: task.id, type: 'patch', relativePath: 'candidate.patch', bytes, provenance: { producer: 'test' } });
    expect(record.sha256).toBe(sha256Hex(bytes));
    expect(record.sizeBytes).toBe(bytes.length);
    const absolute = artifactAbsolutePath(state.paths, record);
    expect(absolute).toBe(path.join(state.paths.runArtifactsDir(run.id), 'candidate.patch'));
    expect(existsSync(absolute)).toBe(true);
    expect(readdirSync(state.paths.runArtifactsDir(run.id)).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    const read = readArtifact(db, state.paths, record.id);
    expect(read.bytes.equals(bytes)).toBe(true);
    expect(verifyArtifact(db, state.paths, record.id)).toMatchObject({ ok: true, reason: 'ok' });
  });

  it('detects missing and corrupted artifacts on read', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    const record = writeArtifact(db, state.paths, { runId: run.id, type: 'log', relativePath: 'logs/worker.log', bytes: 'line 1\n', provenance: {} });
    const absolute = artifactAbsolutePath(state.paths, record);

    writeFileSync(absolute, 'line 1\nline 2 injected\n');
    expect(() => readArtifact(db, state.paths, record.id)).toThrow(ArtifactCorruptError);
    expect(verifyArtifact(db, state.paths, record.id)).toMatchObject({ ok: false, reason: 'corrupt' });

    writeFileSync(absolute, 'xine 1\n'); // same length, different content
    expect(() => readArtifact(db, state.paths, record.id)).toThrow(ArtifactCorruptError);

    unlinkSync(absolute);
    expect(() => readArtifact(db, state.paths, record.id)).toThrow(ArtifactMissingError);
    expect(verifyArtifact(db, state.paths, record.id)).toMatchObject({ ok: false, reason: 'missing', actualSha256: null });
  });

  it('keeps artifacts immutable and inside the run directory', () => {
    const { run } = seedRunAndTask(state);
    const { db } = state.store;
    writeArtifact(db, state.paths, { runId: run.id, type: 'summary', relativePath: 'summary.md', bytes: '# one', provenance: {} });
    expect(() => writeArtifact(db, state.paths, { runId: run.id, type: 'summary', relativePath: 'summary.md', bytes: '# two', provenance: {} })).toThrow(ArtifactExistsError);
    expect(() => writeArtifact(db, state.paths, { runId: run.id, type: 'x', relativePath: '../escape.txt', bytes: 'x', provenance: {} })).toThrow(/escapes the run artifacts directory/);
    expect(() => writeArtifact(db, state.paths, { runId: run.id, type: 'x', relativePath: '/tmp/abs.txt', bytes: 'x', provenance: {} })).toThrow(/must be relative/);
    expect(existsSync(path.join(state.paths.runDir(run.id), 'escape.txt'))).toBe(false);
  });

  it('never records a receipt without bytes: a failed receipt leaves an orphan file, not a phantom row', () => {
    const { db } = state.store;
    const unknownRun = '00000000-0000-7000-8000-000000000000';
    expect(() => writeArtifact(db, state.paths, { runId: unknownRun, type: 'x', relativePath: 'orphan.txt', bytes: 'x', provenance: {} })).toThrow(/receipt could not be recorded/);
    expect(existsSync(path.join(state.paths.runArtifactsDir(unknownRun), 'orphan.txt'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 0 });
  });
});
