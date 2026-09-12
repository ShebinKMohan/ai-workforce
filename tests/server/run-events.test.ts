/**
 * GET /api/projects/:id/runs/:runId/events and GET /api/runs/:id/events: every
 * recorded event of one run, in sequence order, a page at a time. The status
 * document carries only the newest ten; the task page needs all of them to
 * show how a task moved. Read-only, like every other read route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startOfficeServer } from '../../src/server/index.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent, lastEventSequence } from '../../src/storage/events.js';
import { insertRun } from '../../src/storage/records.js';
import { projectStatePaths } from '../../src/workspace/paths.js';
import { sampleRequest, TEST_LIMITS } from '../helpers/state.js';
import { cleanupAll, registerCleanup, tempDir } from '../workspaces/support.js';
import { rawRequest } from './support.js';

afterEach(() => cleanupAll());

function seed(root: string, count: number): string {
  const store = openStateStore(projectStatePaths(root, 'app'), { mode: 'mutating' });
  try {
    const run = insertRun(store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS });
    appendEvent(store.db, { runId: run.id, type: 'run.created', payload: { planning: 'head' } });
    for (let index = 1; index < count; index += 1) appendEvent(store.db, { runId: run.id, type: 'runtime.assistant_message', payload: { text: `step ${index}` } });
    expect(lastEventSequence(store.db, run.id)).toBe(count);
    return run.id;
  } finally {
    store.close();
  }
}

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, any>;

describe('the run events route', () => {
  it('returns every event of a project run in order, a page at a time, and says when there is more', async () => {
    const root = tempDir('workforce-serve-events-');
    const runId = seed(root, 5);
    const office = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => [] });
    registerCleanup(() => void office.close());

    const first = await rawRequest(office, { path: `/api/projects/app/runs/${runId}/events?limit=2` });
    expect(first.status).toBe(200);
    expect(first.headers['content-security-policy']).toContain("default-src 'none'");
    expect(json(first)).toMatchObject({ ok: true, runId, after: 0, limit: 2, lastSequence: 5, hasMore: true });
    expect(json(first).events.map((event: { sequence: number; type: string }) => [event.sequence, event.type])).toEqual([
      [1, 'run.created'],
      [2, 'runtime.assistant_message'],
    ]);
    expect(json(first).events[1]).toMatchObject({ taskId: null, attemptId: null, payload: { text: 'step 1' } });

    const rest = json(await rawRequest(office, { path: `/api/projects/app/runs/${runId}/events?after=2` }));
    expect(rest.events.map((event: { sequence: number }) => event.sequence)).toEqual([3, 4, 5]);
    expect(rest.hasMore).toBe(false);
  });

  it('refuses an unknown run, an unknown project and a bad page, and serves earlier history from the root', async () => {
    const root = tempDir('workforce-serve-events-refusals-');
    const runId = seed(root, 1);
    const office = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => [] });
    registerCleanup(() => void office.close());

    const unknownRun = await rawRequest(office, { path: '/api/projects/app/runs/0190aaaa-not-a-run/events' });
    expect([unknownRun.status, json(unknownRun).error.code]).toEqual([404, 'unknown_run']);
    const unknownProject = await rawRequest(office, { path: `/api/projects/nope/runs/${runId}/events` });
    expect([unknownProject.status, json(unknownProject).error.code]).toEqual([404, 'unknown_project']);
    for (const query of ['limit=0', 'limit=5001', 'after=-1', 'limit=abc']) {
      const refused = await rawRequest(office, { path: `/api/projects/app/runs/${runId}/events?${query}` });
      expect({ query, status: refused.status }).toEqual({ query, status: 400 });
    }
    const earlier = await rawRequest(office, { path: `/api/runs/${runId}/events` });
    expect([earlier.status, json(earlier).error.code]).toEqual([404, 'state_unavailable']);
  });
});
