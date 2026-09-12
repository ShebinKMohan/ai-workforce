/**
 * Reads across project state roots: each project's runs, events and artifacts
 * are found only under that project, runs made before the workspace are listed
 * apart as earlier history, and every read leaves the databases untouched.
 */
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { writeArtifact } from '../../src/storage/artifacts.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent, listEventsAfterCursor } from '../../src/storage/events.js';
import { createStatePaths, type StatePaths } from '../../src/storage/paths.js';
import { beginNewGeneration, insertRun } from '../../src/storage/records.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { projectStatePaths } from '../../src/workspace/paths.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { sampleRequest, TEST_LIMITS } from '../helpers/state.js';
import { cleanupAll, invoke, registerCleanup, tempDir } from '../workspace/helpers.js';
import { cleanupAll as cleanupFixtures, fixTheBugScenario, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';
import { openEventStream, rawRequest, sleep, type SseEvent } from './support.js';

afterEach(() => {
  cleanupAll();
  cleanupFixtures();
});

interface Seeded {
  readonly runId: string;
  readonly artifactId: string;
}

function seedRun(paths: StatePaths, text: string): Seeded {
  const store = openStateStore(paths, { mode: 'mutating' });
  try {
    const run = insertRun(store.db, { request: { ...sampleRequest(), text }, policy: 'local-development', limits: TEST_LIMITS });
    appendEvent(store.db, { runId: run.id, type: 'run.created', payload: { text } });
    appendEvent(store.db, { runId: run.id, type: 'runtime.assistant_message', payload: { text: `working on ${text}` } });
    const artifact = writeArtifact(store.db, paths, { runId: run.id, type: 'log', relativePath: 'logs/note.log', bytes: `${text}\n`, provenance: { source: 'test' } });
    return { runId: run.id, artifactId: artifact.id };
  } finally {
    store.close();
  }
}

function appendTo(paths: StatePaths, runId: string, type: string): void {
  const store = openStateStore(paths, { mode: 'mutating' });
  try {
    appendEvent(store.db, { runId, type, payload: {} });
  } finally {
    store.close();
  }
}

function eventCount(paths: StatePaths): number {
  const store = openStateStore(paths, { mode: 'read-only' });
  try {
    return listEventsAfterCursor(store.db, { limit: 100_000 }).length;
  } finally {
    store.close();
  }
}

function json(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

async function twoProjects(): Promise<{ stateRoot: string; checkout: Seeded; billing: Seeded; earlier: Seeded; server: OfficeServer }> {
  const stateRoot = path.join(tempDir('workforce-serve-projects-'), 'state');
  const earlier = seedRun(createStatePaths(stateRoot), 'earlier work');
  updateWorkspace(stateRoot, (current) =>
    applyWorkspaceOps(
      current,
      parseWorkspaceOps([
        { op: 'project.add', repoPath: '/repos/checkout', name: 'checkout' },
        { op: 'project.add', repoPath: '/repos/billing', name: 'billing' },
      ]),
    ),
  );
  const checkout = seedRun(projectStatePaths(stateRoot, 'checkout'), 'checkout work');
  const billing = seedRun(projectStatePaths(stateRoot, 'billing'), 'billing work');
  const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [], pollMs: 20 });
  registerCleanup(() => void server.close());
  return { stateRoot, checkout, billing, earlier, server };
}

describe('GET /api/runs with a workspace', () => {
  it("lists every project's runs with its project id, earlier runs apart, and changes no database", async () => {
    const { stateRoot, checkout, billing, earlier, server } = await twoProjects();
    const databases = [createStatePaths(stateRoot), projectStatePaths(stateRoot, 'checkout'), projectStatePaths(stateRoot, 'billing')].map((paths) => paths.databasePath);
    const hashes = () => databases.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const before = hashes();

    const document = json(await rawRequest(server, { path: '/api/runs' }));
    expect(document.mode).toBe('workspace');
    expect(document.runs.map((run: Record<string, string>) => [run['projectId'], run['id'], (run['request'] as unknown as { text: string }).text]).sort()).toEqual(
      [
        ['billing', billing.runId, 'billing work'],
        ['checkout', checkout.runId, 'checkout work'],
      ].sort(),
    );
    expect(document.earlierHistory.runs.map((run: Record<string, unknown>) => [run['projectId'], run['id']])).toEqual([[null, earlier.runId]]);
    expect(document.projects.map((project: Record<string, unknown>) => [project['projectId'], project['inWorkspace'], project['stateFound']])).toEqual([
      ['billing', true, true],
      ['checkout', true, true],
    ]);
    expect(document.eventCursor).toMatch(/^~=\d+,billing=\d+,checkout=\d+$/);

    const one = json(await rawRequest(server, { path: '/api/projects/checkout/runs' }));
    expect(one.runs.map((run: Record<string, unknown>) => [run['projectId'], run['id']])).toEqual([['checkout', checkout.runId]]);
    expect((await rawRequest(server, { path: '/api/projects/nope/runs' })).status).toBe(404);
    expect((await rawRequest(server, { path: '/api/projects/Not_A_Slug/runs' })).status).toBe(404);

    expect(hashes()).toEqual(before);
  });
});

describe("one project's run", () => {
  it('keeps an older verified run self-contained after it falls outside the newest 100 runs', async () => {
    const stateRoot = path.join(tempDir('workforce-serve-old-history-'), 'state');
    const paths = projectStatePaths(stateRoot, 'checkout');
    const fixture = await useFixture('ts-bug');
    const agents = writeFakeAgentsConfig(tempDir('workforce-serve-old-agents-'));
    const previous = process.env[FAKE_SCENARIO_ENV];
    let runId: string;
    process.env[FAKE_SCENARIO_ENV] = writeScenario(fixTheBugScenario());
    try {
      const result = await invoke(['run', '--allow-unconfined-writes', '--repo', fixture.path, '--agents', agents, '--task', 'Fix the pagination bug.', '--state-dir', paths.root, '--json']);
      expect(result.code, result.stderr).toBe(0);
      runId = (JSON.parse(result.stdout.trim().split('\n').pop()!) as { runId: string }).runId;
    } finally {
      if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
      else process.env[FAKE_SCENARIO_ENV] = previous;
    }
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [] });
    try {
      const initial = json(await rawRequest(server, { path: '/api/projects/checkout/runs' })).runs.find((run: Record<string, unknown>) => run['id'] === runId);
      expect(initial.taskViews[0]).toMatchObject({ state: 'accepted', receipts: { verifierExecutedPassed: 1 } });
      const store = openStateStore(paths, { mode: 'mutating' });
      try {
        for (let index = 0; index < 101; index += 1) {
          insertRun(store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS, now: new Date(Date.now() + index + 1).toISOString() });
        }
      } finally {
        store.close();
      }
      const recent = json(await rawRequest(server, { path: '/api/runs?limit=100' }));
      expect(recent.runs).toHaveLength(100);
      expect(recent.runs.some((run: Record<string, unknown>) => run['id'] === runId)).toBe(false);
      const response = await rawRequest(server, { path: `/api/projects/checkout/runs/${runId}` });
      expect(response.status).toBe(200);
      const detail = json(response);
      expect(detail.run.state).toBe('ready_for_review');
      expect(detail.taskViews).toEqual(initial.taskViews);
      expect(detail.compromisedReceiptIds).toEqual(initial.compromisedReceiptIds);
      expect(detail.outcome).toEqual(initial.outcome);
      expect(detail.outcome).toMatchObject({ accepted: true, requiredPassed: 1 });
      expect(response.body).toBe((await invoke(['status', runId, '--state-dir', paths.root, '--json'])).stdout);

      const manifestPath = path.join(paths.runArtifactsDir(runId), 'result.json');
      const recordedManifest = readFileSync(manifestPath);
      try {
        writeFileSync(manifestPath, '{"acceptance":{"accepted":true,"requiredPassed":999}}');
        const corrupt = json(await rawRequest(server, { path: `/api/projects/checkout/runs/${runId}` }));
        expect(corrupt.acceptance).toBeNull();
        expect(corrupt.outcome).toBeNull();
        expect(corrupt.taskViews[0].receipts.verifierExecutedPassed).toBe(0);
        expect(corrupt.unverifiedReceiptIds).toEqual(detail.checks.map((check: Record<string, unknown>) => check['id']));
        expect(corrupt.evidenceIssues.join(' ')).toContain('does not match recorded');
        unlinkSync(manifestPath);
        const missing = json(await rawRequest(server, { path: `/api/projects/checkout/runs/${runId}` }));
        expect(missing.acceptance).toBeNull();
        expect(missing.taskViews[0].receipts.verifierExecutedPassed).toBe(0);
        expect(missing.evidenceIssues.join(' ')).toContain('bytes are missing');
      } finally {
        writeFileSync(manifestPath, recordedManifest);
      }
      const restored = json(await rawRequest(server, { path: `/api/projects/checkout/runs/${runId}` }));
      expect(restored.taskViews).toEqual(detail.taskViews);
      expect(restored.evidenceIssues).toEqual([]);

      // A replacement generation is a different candidate even during the
      // durable interval before its new attempt exists. Old passes remain in
      // history but cannot describe the new generation as verified.
      const replacement = openStateStore(paths, { mode: 'mutating' });
      try {
        beginNewGeneration(replacement.db, detail.taskViews[0].id);
      } finally {
        replacement.close();
      }
      const renewed = json(await rawRequest(server, { path: `/api/projects/checkout/runs/${runId}` }));
      expect(renewed.taskViews[0]).toMatchObject({ generation: 2, attempt: null, receipts: { verifierExecutedPassed: 0 } });
      expect(renewed.checks).toEqual(detail.checks);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('is that project’s `workforce status --json` document, and is never found under another project', async () => {
    const { stateRoot, checkout, billing, earlier, server } = await twoProjects();

    const response = await rawRequest(server, { path: `/api/projects/checkout/runs/${checkout.runId}` });
    expect(response.status).toBe(200);
    const status = await invoke(['status', checkout.runId, '--state-dir', projectStatePaths(stateRoot, 'checkout').root, '--json']);
    expect(status.code).toBe(0);
    expect(response.body).toBe(status.stdout);

    const elsewhere = await rawRequest(server, { path: `/api/projects/billing/runs/${checkout.runId}` });
    expect(elsewhere.status).toBe(404);
    expect(json(elsewhere).error.code).toBe('unknown_run');
    expect((await rawRequest(server, { path: `/api/projects/checkout/runs/${earlier.runId}` })).status).toBe(404);
    expect((await rawRequest(server, { path: `/api/runs/${checkout.runId}` })).status).toBe(404);
    // Earlier history stays readable where it always was.
    expect((await rawRequest(server, { path: `/api/runs/${earlier.runId}` })).status).toBe(200);

    const artifact = await rawRequest(server, { path: `/api/projects/checkout/runs/${checkout.runId}/artifacts/${checkout.artifactId}` });
    expect(artifact.status).toBe(200);
    expect(json(artifact).text).toBe('checkout work\n');
    const crossed = await rawRequest(server, { path: `/api/projects/billing/runs/${billing.runId}/artifacts/${checkout.artifactId}` });
    expect(crossed.status).toBe(404);
    expect(json(crossed).error.code).toBe('unknown_artifact');

    const ownEvents = await rawRequest(server, { path: `/api/projects/checkout/runs/${checkout.runId}/events` });
    expect(ownEvents.status).toBe(200);
    expect(json(ownEvents).events.map((event: Record<string, unknown>) => event['payload'])).toContainEqual({ text: 'working on checkout work' });
    const foreignEvents = await rawRequest(server, { path: `/api/projects/billing/runs/${checkout.runId}/events` });
    expect(foreignEvents.status).toBe(404);
    expect(json(foreignEvents).error.code).toBe('unknown_run');
  });

  it('keeps identical run and artifact ids in different project databases separate', async () => {
    const { stateRoot, checkout, billing, server } = await twoProjects();
    const paths = projectStatePaths(stateRoot, 'billing');
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const copied = insertRun(store.db, { id: checkout.runId, request: sampleRequest(checkout.runId), policy: 'local-development', limits: TEST_LIMITS });
      appendEvent(store.db, { runId: copied.id, type: 'run.created', payload: { text: 'billing identity collision' } });
      const artifact = writeArtifact(store.db, paths, { runId: copied.id, type: 'log', relativePath: 'logs/collision.log', bytes: 'billing only\n', provenance: { source: 'test' } });
      store.db.prepare('UPDATE artifacts SET id = ? WHERE id = ?').run(checkout.artifactId, artifact.id);
    } finally {
      store.close();
    }
    const get = async (project: string, suffix = '') => json(await rawRequest(server, { path: `/api/projects/${project}/runs/${checkout.runId}${suffix}` }));
    expect((await get('checkout', `/artifacts/${checkout.artifactId}`)).text).toBe('checkout work\n');
    expect((await get('billing', `/artifacts/${checkout.artifactId}`)).text).toBe('billing only\n');
    expect((await get('checkout')).run.request.text).toBe('checkout work');
    expect((await get('billing')).run.request.text).toBe(sampleRequest().text);
    expect((await get('billing', '/events')).events.map((event: Record<string, unknown>) => event['payload'])).toEqual([{ text: 'billing identity collision' }]);
    const crossed = await rawRequest(server, { path: `/api/projects/billing/runs/${billing.runId}/artifacts/${checkout.artifactId}` });
    expect(crossed.status).toBe(404);
  });

  it('refuses a symlink that aliases another project state root', async () => {
    const { stateRoot, checkout, server } = await twoProjects();
    symlinkSync(projectStatePaths(stateRoot, 'checkout').root, projectStatePaths(stateRoot, 'checkout-alias').root, 'dir');
    const list = json(await rawRequest(server, { path: '/api/runs' }));
    expect(list.projects.map((project: Record<string, unknown>) => project['projectId'])).not.toContain('checkout-alias');
    for (const suffix of ['', `/${checkout.runId}`, `/${checkout.runId}/events`, `/${checkout.runId}/artifacts/${checkout.artifactId}`]) {
      const response = await rawRequest(server, { path: `/api/projects/checkout-alias/runs${suffix}` });
      expect(response.status).toBe(404);
      expect(json(response).error.code).toBe('unknown_project');
    }
  });
});

describe('GET /api/events with a workspace', () => {
  function key(event: SseEvent): string {
    return `${String(event.data['projectId'])}:${String(event.data['cursor'])}`;
  }

  it('streams every project’s events tagged with their project, resumes each project where it stopped, and picks up a new project', async () => {
    const { stateRoot, checkout, billing, earlier, server } = await twoProjects();
    const total = eventCount(createStatePaths(stateRoot)) + eventCount(projectStatePaths(stateRoot, 'checkout')) + eventCount(projectStatePaths(stateRoot, 'billing'));

    const stream = openEventStream(server);
    let all: SseEvent[];
    try {
      all = await stream.waitFor(total);
      await sleep(150);
      expect(stream.events).toHaveLength(total);
    } finally {
      stream.close();
    }
    const runOf: Record<string, string> = { checkout: checkout.runId, billing: billing.runId, null: earlier.runId };
    for (const event of all) expect(event.data['runId']).toBe(runOf[String(event.data['projectId'])]);
    expect(new Set(all.map((event) => String(event.data['projectId'])))).toEqual(new Set(['null', 'checkout', 'billing']));
    for (const project of ['checkout', 'billing', 'null']) {
      const cursors = all.filter((event) => String(event.data['projectId']) === project).map((event) => event.data['cursor'] as number);
      expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    }
    expect(all[all.length - 1]!.id).toMatch(/^~=\d+,billing=\d+,checkout=\d+$/);

    // Resume from the middle: exactly the events after it, per project, nothing repeated.
    const middle = Math.floor(all.length / 2);
    const resumed = openEventStream(server, '/api/events', { 'last-event-id': all[middle]!.id });
    try {
      const expected = all.slice(middle + 1).map(key).sort();
      await resumed.waitFor(expected.length);
      await sleep(150);
      expect(resumed.events.map(key).sort()).toEqual(expected);

      // New events in one project, and a project state root created after the stream opened.
      appendTo(projectStatePaths(stateRoot, 'billing'), billing.runId, 'runtime.turn_completed');
      const search = seedRun(projectStatePaths(stateRoot, 'search'), 'search work');
      const more = await resumed.waitFor(expected.length + 1 + eventCount(projectStatePaths(stateRoot, 'search')));
      const fresh = more.slice(expected.length);
      expect(fresh.filter((event) => event.data['projectId'] === 'billing').map((event) => event.data['type'])).toEqual(['runtime.turn_completed']);
      expect(fresh.filter((event) => event.data['projectId'] === 'search').every((event) => event.data['runId'] === search.runId)).toBe(true);
      expect(fresh[fresh.length - 1]!.id).toContain('search=');
    } finally {
      resumed.close();
    }
  });

  it('switches a stream opened before any workspace to project cursors once one exists, and a plain cursor resumes the root', async () => {
    const stateRoot = path.join(tempDir('workforce-serve-switch-'), 'state');
    const earlier = seedRun(createStatePaths(stateRoot), 'earlier work');
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [], pollMs: 20 });
    registerCleanup(() => void server.close());
    const rootEvents = eventCount(createStatePaths(stateRoot));

    const stream = openEventStream(server);
    try {
      const legacy = await stream.waitFor(rootEvents);
      expect(legacy.map((event) => event.id)).toEqual(legacy.map((event) => String(event.data['cursor'])));

      updateWorkspace(stateRoot, (current) => applyWorkspaceOps(current, parseWorkspaceOps([{ op: 'project.add', repoPath: '/repos/checkout', name: 'checkout' }])));
      const checkout = seedRun(projectStatePaths(stateRoot, 'checkout'), 'checkout work');
      const after = await stream.waitFor(rootEvents + eventCount(projectStatePaths(stateRoot, 'checkout')));
      const projectEvents = after.slice(rootEvents);
      expect(projectEvents.every((event) => event.data['projectId'] === 'checkout' && event.data['runId'] === checkout.runId)).toBe(true);
      expect(projectEvents[0]!.id).toMatch(/^~=\d+,checkout=\d+$/);
    } finally {
      stream.close();
    }

    // A browser that last saw root event 1 as a plain id gets the rest of the root and every project event.
    const resumed = openEventStream(server, '/api/events', { 'last-event-id': '1' });
    try {
      const expected = rootEvents - 1 + eventCount(projectStatePaths(stateRoot, 'checkout'));
      await resumed.waitFor(expected);
      await sleep(150);
      expect(resumed.events).toHaveLength(expected);
      expect(resumed.events.filter((event) => event.data['projectId'] === null).every((event) => event.data['runId'] === earlier.runId && (event.data['cursor'] as number) > 1)).toBe(true);
    } finally {
      resumed.close();
    }
  });
});
