import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IssuesApi } from '../../src/server/issues-api.js';
import { ApiError } from '../../src/server/http.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { RequestQueue, type RequestItem } from '../../src/server/requests.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest } from './support.js';

const servers: OfficeServer[] = []; const queues: RequestQueue[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const queue of queues.splice(0)) queue.close(); cleanupAll(); });
function workspace() {
  const root = path.join(tempDir(), 'state');
  updateWorkspace(root, config => applyWorkspaceOps(config, parseWorkspaceOps([
    { op: 'project.add', name: 'one', repoPath: '/fixture/project-one' },
    { op: 'project.add', name: 'two', repoPath: '/fixture/project-two' },
  ])));
  return root;
}
const input = (extra = {}) => ({ projectId: 'one', title: 'Implement the PRD', description: '# PRD\n\nDo the work exactly.\n', kind: 'prd', source: 'codex', idempotencyKey: 'prd-1', ...extra });
const noQueue = () => ({ list: () => ({ items: [] }), submit: vi.fn(async (_body: unknown) => { throw new ApiError(409, 'consent_required', 'Explicit runtime consent required.'); }) });
async function server(root: string) {
  const result = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => [], spawner: () => { throw new Error('No runtime should launch in this HTTP test'); } });
  servers.push(result); return result;
}
function post(target: OfficeServer, route: string, body: unknown, headers = {}) {
  return rawRequest(target, { path: route, method: 'POST', headers: { origin: originFor(target), 'x-workforce-token': target.token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('issue API admission', () => {
  it('rejects unknown or archived projects and oversized briefs without making a card or submission', async () => {
    const root = workspace(); const queue = noQueue(); const api = new IssuesApi(root, queue);
    await expect(api.create(input({ projectId: 'missing' }))).rejects.toMatchObject({ code: 'unknown_project' });
    await expect(api.create(input({ description: 'x'.repeat(64001) }))).rejects.toMatchObject({ status: 400 });
    updateWorkspace(root, config => applyWorkspaceOps(config, parseWorkspaceOps([{ op: 'project.archive', id: 'one' }])));
    await expect(api.create(input())).rejects.toMatchObject({ code: 'project_archived' });
    expect(api.list().issues).toEqual([]); expect(queue.submit).not.toHaveBeenCalled(); expect(existsSync(api.store.filename)).toBe(false);
  });

  it('keeps a refused auto-start PRD and returns a useful error without hiding the saved issue', async () => {
    const root = workspace(); const queue = noQueue(); const api = new IssuesApi(root, queue);
    const result = await api.create(input({ start: true }));
    expect(result).toMatchObject({ ok: true, startError: { code: 'consent_required' }, issue: { title: input().title, description: input().description, execution: { verified: false } } });
    expect(api.get(result.issue.id).issue.description).toBe(input().description);
    expect(queue.submit).toHaveBeenCalledWith(expect.objectContaining({ task: `${input().title}\n\n${input().description}`, mode: 'delegate', projectId: 'one', clientRequestId: `issue:${result.issue.id}`, allowUnconfinedWrites: false }));
    expect(queue.submit.mock.calls[0]?.[0]).not.toHaveProperty('departmentId');
  });

  it('does not use a replayed original create request to auto-start subsequently edited content', async () => {
    const root = workspace(); const queue = noQueue(); const api = new IssuesApi(root, queue);
    const original = input({ start: true }); const saved = await api.create(original);
    api.update(saved.issue.id, { expectRevision: saved.issue.revision, title: 'Changed objective', description: 'Implement different work.' });
    const replay = await api.create(original);
    expect(replay).toMatchObject({ startError: { code: 'issue_changed_after_creation' }, issue: { title: 'Changed objective' } });
    expect(queue.submit).toHaveBeenCalledTimes(1);
  });

  it('preserves an oversized combined brief but refuses dispatch without truncating either field', async () => {
    const root = workspace(); const queue = noQueue(); const api = new IssuesApi(root, queue);
    const saved = await api.create(input({ description: 'x'.repeat(64000), start: true }));
    expect(saved).toMatchObject({ startError: { code: 'issue_brief_too_large' }, issue: { description: 'x'.repeat(64000), requestId: null } });
    expect(queue.submit).not.toHaveBeenCalled();
  });

  it('mirrors run links before finished-queue retention, and retains receipts when mirroring fails', async () => {
    const root = workspace(); const api = new IssuesApi(root, noQueue()); const saved = await api.create(input());
    const intent = api.store.beginDispatch(saved.issue.id, { expectRevision: 1, allowUnconfinedWrites: false }).issue.dispatch!;
    const item = (index: number): RequestItem => ({ id: randomUUID(), clientRequestId: index === 0 ? intent.clientRequestId : `old-${index}`, kind: 'request', projectId: 'one', departmentId: null,
      task: index === 0 ? intent.task : 'Other work', resumeRunId: null, allowUnconfinedWrites: false, state: 'ended', reason: null,
      receivedAt: '2026-09-13T12:00:00.000Z', startedAt: null, endedAt: '2026-09-13T12:01:00.000Z', heldAt: null,
      agentIds: [], workerIds: [], exclusive: false, unconfinedRuntimes: [], launchId: null, pid: null, pidStartedAtMs: null, stdoutPath: null, stderrPath: null,
      runId: index === 0 ? 'durable-original-run' : null, stopRequestedAt: null, exitCode: 0, signal: null, result: null });
    const history = Array.from({ length: 201 }, (_, index) => item(index));
    const filename = path.join(root, 'serve', 'requests.json'); mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify({ schemaVersion: 1, items: history }));
    const broken = new RequestQueue({ stateRoot: root, passStateDir: true, env: {}, pollMs: 10000,
      readiness: async () => ({ checkedAt: new Date().toISOString(), reports: [] }),
      onPersist: () => { throw new Error('simulated issue database unavailable'); } }); queues.push(broken);
    expect(broken.list()['items']).toHaveLength(201);
    expect(JSON.parse(readFileSync(filename, 'utf8')).items).toHaveLength(201);
    expect(broken.list()['notice']).toMatch(/retained/);
    const accepted = await broken.submit({ projectId: 'one', task: '@missing-team queued receipt remains successful', clientRequestId: 'mirror-failure-accepted' });
    expect(broken.get(accepted.id).id).toBe(accepted.id);
    expect(JSON.parse(readFileSync(filename, 'utf8')).items.some((record: RequestItem) => record.id === accepted.id)).toBe(true);
    broken.close();
    const repaired = new RequestQueue({ stateRoot: root, passStateDir: true, env: {}, pollMs: 10000,
      readiness: async () => ({ checkedAt: new Date().toISOString(), reports: [] }), onPersist: records => api.store.recordRequests(records) }); queues.push(repaired);
    const retained = repaired.list()['items'] as RequestItem[];
    expect(retained.filter(record => record.state === 'ended')).toHaveLength(200);
    expect(retained.some(record => record.id === history[0]!.id)).toBe(false);
    expect(api.store.get(saved.issue.id).dispatch?.request).toMatchObject({ id: history[0]!.id, runId: 'durable-original-run' });
    expect(JSON.parse(readFileSync(filename, 'utf8')).items).toHaveLength(retained.length);
  });

  it('sends one exact PRD into real Control Center intake for concurrent starts and retains its receipt across restart', async () => {
    const root = workspace(); const seen: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: {}, pollMs: 10000, readiness: async () => ({ checkedAt: new Date().toISOString(), reports: [] }),
      routeControl: async request => { seen.push(request.task); await gate; return { route: { state: 'blocked', projectId: request.projectId, departmentId: null, headAgentId: null, reason: 'Fixture needs a department.', method: 'classifier', code: 'routing_clarification_required', decidedAt: new Date().toISOString(), elapsedMs: 1 } }; },
      spawner: () => { throw new Error('Blocked intake must not execute workers'); },
    }); queues.push(queue);
    const api = new IssuesApi(root, queue); const saved = await api.create(input());
    const [a, b] = await Promise.all([api.start(saved.issue.id, { expectRevision: 1 }), api.start(saved.issue.id, { expectRevision: 1 })]);
    expect(a.issue.requestId).toBeTruthy(); expect(a.issue.requestId).toBe(b.issue.requestId);
    const receipts = queue.list()['items'] as Array<{ task: string; clientRequestId: string }>;
    expect(receipts).toHaveLength(1); expect(receipts[0]?.task).toBe(`${input().title}\n\n${input().description}`);
    expect((await new IssuesApi(root, queue).start(saved.issue.id, { expectRevision: 1 })).issue.requestId).toBe(a.issue.requestId);
    release();
    for (let attempt = 0; attempt < 50 && queue.get(a.issue.requestId!).state !== 'failed_to_start'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual([`${input().title}\n\n${input().description}`]);
    expect(api.get(saved.issue.id).issue.execution.verified).toBe(false);
  });

  it('refuses replay of a crash-window intent with no retained receipt rather than spawning duplicate work', async () => {
    const root = workspace(); const queue = noQueue(); const api = new IssuesApi(root, queue); const saved = await api.create(input());
    api.store.beginDispatch(saved.issue.id, { expectRevision: 1, allowUnconfinedWrites: false });
    const restarted = new IssuesApi(root, queue);
    await expect(restarted.start(saved.issue.id, { expectRevision: 1 })).rejects.toMatchObject({ code: 'issue_dispatch_unconfirmed' });
    expect(queue.submit).not.toHaveBeenCalled();
  });
});

describe('loopback issue routes', () => {
  it('supports project filtering, concurrent retries and revision conflicts across a server restart', async () => {
    const root = workspace(); const target = await server(root);
    const [first, retry] = await Promise.all([post(target, '/api/issues', input()), post(target, '/api/issues', input())]);
    expect(first.status).toBe(201); expect(retry.status).toBe(201);
    const issue = JSON.parse(first.body).issue; expect(JSON.parse(retry.body).issue.id).toBe(issue.id);
    const moved = await post(target, `/api/issues/${issue.id}/update`, { expectRevision: 1, status: 'todo', idempotencyKey: 'move-1' });
    expect(moved.status).toBe(200);
    expect((await post(target, `/api/issues/${issue.id}/update`, { expectRevision: 1, title: 'Stale edit' })).status).toBe(409);
    expect(JSON.parse((await rawRequest(target, { path: '/api/issues?projectId=two' })).body).issues).toEqual([]);
    await target.close(); servers.splice(servers.indexOf(target), 1);
    const next = await server(root);
    const persisted = JSON.parse((await rawRequest(next, { path: `/api/issues/${issue.id}` })).body).issue;
    expect(persisted).toMatchObject({ revision: 2, status: 'todo', description: input().description, execution: { state: 'idle', verified: false } });
  });

  it('pages compact issue summaries without losing the complete brief on detail reads', async () => {
    const root = workspace(); const api = new IssuesApi(root, noQueue());
    for (let index = 0; index < 5; index++) await api.create(input({ idempotencyKey: `page-${index}`, description: 'Original PRD '.repeat(4000) }));
    const target = await server(root);
    const first = JSON.parse((await rawRequest(target, { path: '/api/issues?summary=1&projectId=one&limit=2' })).body);
    expect(first.issues).toHaveLength(2); expect(first.hasMore).toBe(true); expect(first.issues[0]).not.toHaveProperty('description');
    const next = JSON.parse((await rawRequest(target, { path: `/api/issues?summary=1&projectId=one&limit=2&after=${first.nextCursor}` })).body);
    const last = JSON.parse((await rawRequest(target, { path: `/api/issues?summary=1&projectId=one&limit=2&after=${next.nextCursor}` })).body);
    expect(last).toMatchObject({ hasMore: false, nextCursor: null }); expect(last.issues).toHaveLength(1);
    expect(new Set([...first.issues, ...next.issues, ...last.issues].map(issue => issue.id)).size).toBe(5);
    expect(JSON.parse((await rawRequest(target, { path: `/api/issues/${first.issues[0].id}` })).body).issue.description).toBe('Original PRD '.repeat(4000));
    expect((await rawRequest(target, { path: '/api/issues?summary=1&limit=101' })).status).toBe(400);
  });

  it('uses the existing Host, Origin and token protection for create, edit and start', async () => {
    const target = await server(workspace()); const created = JSON.parse((await post(target, '/api/issues', input())).body).issue;
    for (const route of ['/api/issues', `/api/issues/${created.id}/update`, `/api/issues/${created.id}/start`]) {
      expect((await post(target, route, input(), { origin: 'https://foreign.invalid' })).status).toBe(403);
      expect((await post(target, route, input(), { 'x-workforce-token': 'wrong' })).status).toBe(403);
      expect((await rawRequest(target, { method: 'POST', path: route, headers: { 'content-type': 'application/json', 'x-workforce-token': target.token }, body: '{}' })).status).toBe(403);
    }
    expect((await rawRequest(target, { path: '/api/issues', headers: { host: 'foreign.invalid' } })).status).toBe(403);
  });
});
