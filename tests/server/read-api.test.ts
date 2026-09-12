/**
 * The office view's read model (FR084, AT27): what a browser is told about a
 * run is what the coordinator recorded, read the same way the CLI reads it.
 *
 * The fixture is a real, finished run on the deterministic fake runtime —
 * events, checks, a candidate patch and a manifest all written by the
 * coordinator itself — not rows invented for the test.
 */
import { createHash } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { runCli } from '../../src/cli/index.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { nowIso } from '../../src/core/ids.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { artifactAbsolutePath, writeArtifact } from '../../src/storage/artifacts.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent, listEventsAfterCursor } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { insertRun, listRuns } from '../../src/storage/records.js';
import { openTempState, sampleRequest, seedRunAndTask, TEST_LIMITS, type TempState } from '../helpers/state.js';
import { cleanupAll, fixTheBugScenario, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';
import { openEventStream, rawRequest, sleep } from './support.js';

async function invoke(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const code = await runCli(argv, { stdout: sink((chunk) => (stdout += chunk)), stderr: sink((chunk) => (stderr += chunk)) });
  return { stdout, stderr, code };
}

function json(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

let stateDir: string;
let runId: string;
let server: OfficeServer;

beforeAll(async () => {
  const fixture = await useFixture('ts-bug');
  stateDir = path.join(tempDir('workforce-serve-read-'), 'state');
  const configPath = writeFakeAgentsConfig(tempDir('workforce-serve-read-config-'));
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = writeScenario(fixTheBugScenario());
  try {
    const run = await invoke(['run', '--allow-unconfined-writes', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--json']);
    expect(run.code).toBe(EXIT_CODES.verifiedCandidate);
    runId = (JSON.parse(run.stdout.trim().split('\n').pop()!) as { runId: string }).runId;
  } finally {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  }
  server = await startOfficeServer({ stateRoot: stateDir, port: 0, discover: async () => [], pollMs: 20 });
}, 120_000);

afterAll(async () => {
  await server?.close();
  cleanupAll();
});

describe('GET /api/runs/:id', () => {
  it('is, byte for byte, the document `workforce status <id> --json` prints', async () => {
    const status = await invoke(['status', runId, '--state-dir', stateDir, '--json']);
    expect(status.code).toBe(0);
    const response = await rawRequest(server, { path: `/api/runs/${runId}` });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.body).toBe(status.stdout);

    const document = json(response);
    expect(document.readOnly).toBe(true);
    expect(document.run.state).toBe('ready_for_review');
    expect(document.tasks[0].state).toBe('accepted');
    expect(document.checks[0].evidenceProvenance).toBe('verifier_executed');
  });

  it('answers an unknown or malformed run id with 404 and a code, not a crash', async () => {
    const unknown = await rawRequest(server, { path: '/api/runs/0190aaaa-no-such-run' });
    expect(unknown.status).toBe(404);
    expect(json(unknown).error.code).toBe('unknown_run');
    const malformed = await rawRequest(server, { path: '/api/runs/..%2f..%2fetc' });
    expect(malformed.status).toBe(404);
    expect(json(malformed).error.code).toBe('not_found');
  });
});

describe('GET /api/runs', () => {
  it('lists the recorded run with its task states and where a live stream should start', async () => {
    const response = await rawRequest(server, { path: '/api/runs' });
    expect(response.status).toBe(200);
    const document = json(response);
    expect(document.stateFound).toBe(true);
    expect(document.runs[0]).toMatchObject({ id: runId, state: 'ready_for_review', request: { text: 'Fix it.' }, tasks: { total: 1, byState: { accepted: 1 }, agents: ['engineer'] } });
    expect(document.eventCursor).toBeGreaterThan(0);
    // What a desk is derived from: the task row, its attempt row, receipts by provenance, and its newest event.
    expect(document.runs[0].taskViews).toEqual([
      expect.objectContaining({
        state: 'accepted',
        ownerAgentId: 'engineer',
        attempt: expect.objectContaining({ state: 'completed', generation: 1 }),
        receipts: { verifierExecutedPassed: 1, verifierExecutedCompromised: 0, verifierExecutedFailed: 0, verifierExecutedOther: 0, otherProvenance: 0 },
        lastEvent: expect.objectContaining({ type: expect.any(String), sequence: expect.any(Number) }),
      }),
    ]);
    expect((await rawRequest(server, { path: '/api/runs?limit=0' })).status).toBe(400);
    expect((await rawRequest(server, { path: '/api/runs?limit=abc' })).status).toBe(400);
  });

  it('orders runs newest first and bounds the list', () => {
    const state = openTempState();
    try {
      const ids = ['2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'].map(
        (now) => insertRun(state.store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS, now }).id,
      );
      expect(listRuns(state.store.db).map((run) => run.id)).toEqual([ids[1], ids[2], ids[0]]);
      expect(listRuns(state.store.db, { limit: 2 })).toHaveLength(2);
      expect(listRuns(state.store.db, { limit: 0 })).toHaveLength(1);
    } finally {
      state.cleanup();
    }
  });

  it('says there is no state yet instead of failing, before the first run', async () => {
    const empty = await startOfficeServer({ stateRoot: path.join(tempDir('workforce-serve-empty-'), 'state'), port: 0, discover: async () => [] });
    try {
      const document = json(await rawRequest(empty, { path: '/api/runs' }));
      expect(document).toMatchObject({ stateFound: false, runs: [], eventCursor: 0 });
    } finally {
      await empty.close();
    }
  });
});

describe('recorded head review and final reply in run list and detail', () => {
  async function withReviewOffice(test: (state: TempState, office: OfficeServer, id: string) => Promise<void>): Promise<void> {
    const state = openTempState();
    const { run } = seedRunAndTask(state);
    const office = await startOfficeServer({ stateRoot: state.root, port: 0, discover: async () => [] });
    try {
      await test(state, office, run.id);
    } finally {
      await office.close();
      state.cleanup();
    }
  }

  async function runViews(office: OfficeServer, id: string): Promise<Array<Record<string, any>>> {
    const [list, detail] = await Promise.all([
      rawRequest(office, { path: '/api/runs' }),
      rawRequest(office, { path: `/api/runs/${id}` }),
    ]);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    const listed = (json(list).runs as Array<Record<string, any>>).find((run) => run.id === id);
    expect(listed).toBeDefined();
    return [listed!, json(detail).run as Record<string, any>];
  }

  it('shows a running head review, then its recorded finish and final reply without waiting for a worker-state change', async () => {
    await withReviewOffice(async (state, office, id) => {
      const headAgentId = 'engineering-head';
      const reviewId = 'combined-review';
      const startedAt = '2026-09-12T10:00:00.000Z';
      appendEvent(state.store.db, { runId: id, type: 'head.review_started', timestamp: startedAt, payload: { headAgentId, reviewId } });
      for (const view of await runViews(office, id)) {
        expect(view.headReview).toEqual({ headAgentId, reviewId, state: 'running', at: startedAt });
        expect(view.finalReply).toBeNull();
      }

      const finishedAt = '2026-09-12T10:01:00.000Z';
      const reply = 'The pagination and search documentation is complete. Both independent checks passed on the combined candidate.';
      appendEvent(state.store.db, { runId: id, type: 'head.review_finished', timestamp: finishedAt, payload: { headAgentId, reviewId, verdict: 'passed', summary: reply, candidateRevision: 'combined-candidate' } });
      appendEvent(state.store.db, { runId: id, type: 'control.final_reply', payload: { text: reply, headAgentId, candidateRevision: 'combined-candidate' } });
      // Later runtime chatter must not replace the recorded review or reply.
      appendEvent(state.store.db, { runId: id, type: 'runtime.assistant_message', payload: { text: 'I have a newer message.', verdict: 'changes_requested' } });
      for (const view of await runViews(office, id)) {
        expect(view.headReview).toEqual({ headAgentId, reviewId, verdict: 'passed', state: 'passed', summary: reply, candidateRevision: 'combined-candidate', at: finishedAt });
        expect(view.finalReply).toBe(reply);
      }
      const detail = await rawRequest(office, { path: `/api/runs/${id}` });
      const cli = await invoke(['status', id, '--state-dir', state.root, '--json']);
      expect(cli.code).toBe(0);
      expect(detail.body).toBe(cli.stdout);
    });
  });

  it.each(['changes_requested', 'blocked'])('keeps a finished %s review visible and uses the latest review phase', async (verdict) => {
    await withReviewOffice(async (state, office, id) => {
      appendEvent(state.store.db, { runId: id, type: 'head.review_finished', payload: { headAgentId: 'previous-head', reviewId: 'previous-review', verdict: 'passed' } });
      const at = '2026-09-12T11:00:00.000Z';
      const headAgentId = 'current-head';
      const reviewId = 'current-review';
      appendEvent(state.store.db, { runId: id, type: 'head.review_started', timestamp: at, payload: { headAgentId, reviewId } });
      for (const view of await runViews(office, id)) expect(view.headReview).toEqual({ headAgentId, reviewId, state: 'running', at });
      const finishedAt = '2026-09-12T11:01:00.000Z';
      appendEvent(state.store.db, { runId: id, type: 'head.review_finished', timestamp: finishedAt, payload: { headAgentId, reviewId, verdict } });
      for (const view of await runViews(office, id)) {
        expect(view.headReview).toEqual({ headAgentId, reviewId, verdict, state: verdict, at: finishedAt });
        expect(view.finalReply).toBeNull();
      }
    });
  });

  it('returns null for absent or unrelated events and never borrows another run’s review or reply', async () => {
    await withReviewOffice(async (state, office, id) => {
      for (const view of await runViews(office, id)) expect(view).toMatchObject({ headReview: null, finalReply: null });
      const other = insertRun(state.store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS });
      appendEvent(state.store.db, { runId: other.id, type: 'head.review_started', payload: { headAgentId: 'other-head', reviewId: 'other-review' } });
      appendEvent(state.store.db, { runId: other.id, type: 'control.final_reply', payload: { text: 'This belongs to another run.' } });
      appendEvent(state.store.db, { runId: id, type: 'head.planning_finished', payload: { headAgentId: 'planner', verdict: 'passed' } });
      appendEvent(state.store.db, { runId: id, type: 'runtime.assistant_message', payload: { text: 'head.review_finished control.final_reply: approved', headReview: { state: 'passed' }, finalReply: 'invented' } });
      for (const view of await runViews(office, id)) expect(view).toMatchObject({ headReview: null, finalReply: null });
    });
  });

  it('reads the newest recorded final reply and does not render a non-text payload as a reply', async () => {
    await withReviewOffice(async (state, office, id) => {
      appendEvent(state.store.db, { runId: id, type: 'control.final_reply', payload: { text: 'Earlier reply.' } });
      appendEvent(state.store.db, { runId: id, type: 'control.final_reply', payload: { text: 'Latest recorded reply.' } });
      for (const view of await runViews(office, id)) {
        expect(view.finalReply).toBe('Latest recorded reply.');
        expect(view.headReview).toBeNull();
      }
      appendEvent(state.store.db, { runId: id, type: 'control.final_reply', payload: { text: { state: 'passed' } } });
      for (const view of await runViews(office, id)) expect(view.finalReply).toBeNull();
    });
  });
});

describe('GET /api/runs/:id/artifacts/:artifactId', () => {
  it('returns a recorded text artifact whose bytes match the recorded hash', async () => {
    const status = json(await rawRequest(server, { path: `/api/runs/${runId}` }));
    const patch = (status.artifacts as Array<{ id: string; path: string; sha256: string }>).find((artifact) => artifact.path === 'candidate.patch')!;
    const response = await rawRequest(server, { path: `/api/runs/${runId}/artifacts/${patch.id}` });
    expect(response.status).toBe(200);
    const document = json(response);
    expect(document.artifact).toMatchObject({ id: patch.id, runId, path: 'candidate.patch', sha256: patch.sha256 });
    expect(document.text).toContain('pagination');
    expect(document.redacted).toBe(false);
    expect(createHash('sha256').update(document.text as string, 'utf8').digest('hex')).toBe(patch.sha256);

    const elsewhere = await rawRequest(server, { path: `/api/runs/${runId}/artifacts/0190aaaa-not-recorded` });
    expect(elsewhere.status).toBe(404);
    expect(json(elsewhere).error.code).toBe('unknown_artifact');
  });

  it('refuses binary, oversized, missing, corrupted and other-run artifacts, each as what it is, and redacts secrets', async () => {
    const state = openTempState();
    registerCleanup(() => state.cleanup());
    const { run } = seedRunAndTask(state);
    const other = insertRun(state.store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS });
    const write = (relativePath: string, bytes: string | Uint8Array) =>
      writeArtifact(state.store.db, state.paths, { runId: run.id, type: 'log', relativePath, bytes, provenance: { source: 'test' } });
    const binary = write('logs/binary.bin', Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    const huge = write('logs/huge.log', 'x'.repeat(1024 * 1024 + 1));
    const missing = write('logs/missing.log', 'gone soon\n');
    const corrupt = write('logs/corrupt.log', 'original\n');
    const secret = write('logs/secret.log', 'exported OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv for the check\n');
    unlinkSync(artifactAbsolutePath(state.paths, missing));
    writeFileSync(artifactAbsolutePath(state.paths, corrupt), 'tampered\n');

    const office = await startOfficeServer({ stateRoot: state.root, port: 0, discover: async () => [] });
    try {
      const get = async (runIdentity: string, artifactId: string) => {
        const response = await rawRequest(office, { path: `/api/runs/${runIdentity}/artifacts/${artifactId}` });
        return { status: response.status, document: json(response) };
      };
      expect((await get(run.id, binary.id)).document.error.code).toBe('artifact_not_text');
      expect((await get(run.id, binary.id)).status).toBe(415);
      expect(await get(run.id, huge.id)).toMatchObject({ status: 413, document: { error: { code: 'artifact_too_large' } } });
      expect(await get(run.id, missing.id)).toMatchObject({ status: 410, document: { error: { code: 'artifact_missing' } } });
      expect(await get(run.id, corrupt.id)).toMatchObject({ status: 409, document: { error: { code: 'artifact_corrupt' } } });
      expect(await get(other.id, secret.id)).toMatchObject({ status: 404, document: { error: { code: 'unknown_artifact' } } });

      const redacted = await get(run.id, secret.id);
      expect(redacted.status).toBe(200);
      expect(redacted.document.redacted).toBe(true);
      expect(redacted.document.text).not.toContain('sk-abcdefghijklmnopqrstuv');
      expect(redacted.document.text).toContain('[REDACTED]');
    } finally {
      await office.close();
    }
  });
});

describe('GET /api/events', () => {
  it('delivers every recorded event across the state root in write order, each with its cursor as the SSE id', async () => {
    const reader = openStateStore(createStatePaths(stateDir), { mode: 'read-only' });
    const recorded = listEventsAfterCursor(reader.db, { limit: 100_000 });
    reader.close();
    expect(recorded.length).toBeGreaterThan(5);

    const stream = openEventStream(server);
    try {
      const events = await stream.waitFor(recorded.length);
      expect(events.map((event) => Number(event.id))).toEqual(recorded.map((row) => row.cursor));
      expect(events.map((event) => event.data['type'])).toEqual(recorded.map((row) => row.event.type));
      expect(events.every((event) => event.data['runId'] === runId)).toBe(true);
      const sequences = events.map((event) => event.data['sequence'] as number);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      await sleep(150);
      expect(stream.events).toHaveLength(recorded.length);
    } finally {
      stream.close();
    }
  });

  it('resumes after Last-Event-ID with nothing missed and nothing repeated', async () => {
    const first = openEventStream(server);
    const all = await first.waitFor(1).then(async () => {
      await sleep(200);
      return [...first.events];
    });
    first.close();
    const middle = Math.floor(all.length / 2);

    const resumed = openEventStream(server, '/api/events', { 'last-event-id': all[middle]!.id });
    try {
      const rest = await resumed.waitFor(all.length - middle - 1);
      await sleep(150);
      expect(resumed.events.map((event) => event.id)).toEqual(all.slice(middle + 1).map((event) => event.id));
      expect(rest[0]!.id).toBe(all[middle + 1]!.id);
    } finally {
      resumed.close();
    }

    const fromQuery = openEventStream(server, `/api/events?after=${all[all.length - 2]!.id}`);
    try {
      await fromQuery.waitFor(1);
      await sleep(150);
      expect(fromQuery.events.map((event) => event.id)).toEqual([all[all.length - 1]!.id]);
    } finally {
      fromQuery.close();
    }
  });

  it('waits for a state root that does not exist yet, then streams events as they are written', async () => {
    const root = path.join(tempDir('workforce-serve-live-'), 'state');
    const office = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => [], pollMs: 20 });
    const stream = openEventStream(office);
    try {
      expect(await stream.status).toBe(200);
      await sleep(100);
      expect(stream.events).toHaveLength(0);

      const store = openStateStore(createStatePaths(root), { mode: 'mutating' });
      registerCleanup(() => store.close());
      const run = insertRun(store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS });
      appendEvent(store.db, { runId: run.id, type: 'run.created', payload: { at: nowIso() } });
      appendEvent(store.db, { runId: run.id, type: 'runtime.assistant_message', payload: { text: 'reading the code' } });
      const early = await stream.waitFor(2);
      expect(early.map((event) => event.data['type'])).toEqual(['run.created', 'runtime.assistant_message']);

      appendEvent(store.db, { runId: run.id, type: 'runtime.turn_completed', payload: {} });
      const later = await stream.waitFor(3);
      expect(later[2]!.data['type']).toBe('runtime.turn_completed');
      expect(Number(later[2]!.id)).toBeGreaterThan(Number(later[1]!.id));
    } finally {
      stream.close();
      await office.close();
    }
  });
});

describe('GET /api/office', () => {
  it('reports the configured agents with the write-boundary gate they face, passive readiness, and the coordinator', async () => {
    const root = tempDir('workforce-serve-office-');
    writeFakeAgentsConfig(root);
    let discoveries = 0;
    const office = await startOfficeServer({
      stateRoot: root,
      port: 0,
      discover: async () => {
        discoveries += 1;
        return [];
      },
    });
    try {
      const document = json(await rawRequest(office, { path: '/api/office' }));
      expect(document.coordinator).toMatchObject({ name: 'workforce', stateRoot: root, lock: { held: false }, server: { readOnlyDatabase: true } });
      expect(document.configuration).toMatchObject({ found: true, path: path.join(root, 'agents.json'), source: 'the coordinator state root', error: null });
      expect(document.agents).toEqual([
        expect.objectContaining({
          id: 'engineer',
          adapter: 'fake',
          policy: 'local-development',
          isDefaultWorker: true,
          writeBoundary: expect.objectContaining({ writes: true, status: 'unsupported', requiresAllowUnconfinedWrites: true }),
        }),
      ]);
      expect(document.runtimes).toMatchObject({ passive: true, reports: [], error: null });

      await rawRequest(office, { path: '/api/office' });
      expect(discoveries).toBe(1);
      await rawRequest(office, { path: '/api/office?refresh=1' });
      expect(discoveries).toBe(2);
    } finally {
      await office.close();
    }
  });

  it('shows an invalid configuration as invalid, with its issues, rather than as no agents', async () => {
    const root = tempDir('workforce-serve-office-invalid-');
    writeFileSync(path.join(root, 'agents.json'), JSON.stringify({ schemaVersion: 1, agents: 'not a list' }));
    const office = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => Promise.reject(new Error('probe exploded')) });
    try {
      const document = json(await rawRequest(office, { path: '/api/office' }));
      expect(document.configuration.found).toBe(true);
      expect(document.configuration.error.issues.length).toBeGreaterThan(0);
      expect(document.agents).toEqual([]);
      expect(document.runtimes.error).toContain('probe exploded');
    } finally {
      await office.close();
    }
  });
});
