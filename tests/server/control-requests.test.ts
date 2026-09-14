/** Control Center intake and capacity use durable requests, never paid turns
 * for scheduling. Real disposable child processes exercise reservation life. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_CAPABILITIES } from '../../src/adapters/index.js';
import { AdapterError, type RuntimeAdapter } from '../../src/adapters/types.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { routeControlRequest, type ControlIntakeInput, type ControlIntakeResult } from '../../src/routing/control-intake.js';
import { RequestQueue, type RequestItem, type RequestQueueOptions } from '../../src/server/requests.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, gitRepo, tempDir } from '../workspace/helpers.js';

const queues: RequestQueue[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  cleanupAll();
});

const invocation = { command: 'test-node', args: ['test-cli'], cwd: process.cwd() };
const childSource = `
const fs = require('node:fs');
const [release] = process.argv.slice(1);
const runId = 'run-test-' + process.pid;
process.stdout.write(JSON.stringify({ type: 'run.created', runId }) + '\\n');
process.on('SIGINT', () => process.exit(130));
setInterval(() => { if (fs.existsSync(release)) { process.stdout.write(JSON.stringify({ ok: true, command: 'run', exitCode: 0, runId }) + '\\n'); process.exit(0); } }, 10);
`;
const codexReport = () => ({ adapter: 'codex', displayName: 'Codex', installed: true, adapterSupported: true, controllable: true,
  auth: 'logged_in', authDetail: 'test', readiness: 'ready', version: CODEX_CAPABILITIES.write_containment.testedVersion,
  checkedAt: new Date().toISOString() } as unknown as RuntimeReadinessReport);
const reports = (): RuntimeReadinessReport[] => [codexReport(), { ...codexReport(), adapter: 'claude-code', displayName: 'Claude Code', version: '2.1.236' }];

async function workspace(extra: Array<Record<string, unknown>> = []): Promise<string> {
  const root = path.join(tempDir('control-intake-state-'), 'state');
  const [one, two] = await Promise.all([gitRepo({ 'README.md': 'one' }), gitRepo({ 'README.md': 'two' })]);
  updateWorkspace(root, (current) => applyWorkspaceOps(current, parseWorkspaceOps([
    { op: 'project.add', repoPath: one, name: 'one', checks: ['node --version'] },
    { op: 'project.add', repoPath: two, name: 'two', checks: ['node --version'] },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'agent.add', id: 'head', name: 'Head', role: 'head', departmentId: 'eng', runtime: 'codex-local' },
    { op: 'agent.add', id: 'shared', name: 'Shared', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'codex-local', projectIds: ['one', 'two'] },
    { op: 'agent.add', id: 'free', name: 'Free', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'codex-local', projectIds: ['two'] },
    { op: 'department.add', id: 'finance', name: 'Finance' },
    { op: 'agent.add', id: 'finance-head', name: 'Finance head', role: 'head', departmentId: 'finance', runtime: 'codex-local' },
    ...extra,
  ])));
  return root;
}

function harness(root: string, routeControl: NonNullable<RequestQueueOptions['routeControl']>) {
  const control = tempDir('control-intake-children-');
  const calls: string[][] = [];
  const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: process.env, invocation, pollMs: 15,
    readiness: async () => ({ checkedAt: new Date().toISOString(), reports: reports() }), routeControl,
    spawner: (_command, args, options) => {
      calls.push([...args.slice(invocation.args.length)]);
      const child = spawn(process.execPath, ['-e', childSource, path.join(control, `release-${calls.length}`)], { ...options, shell: false });
      children.push(child); return child;
    },
  });
  queues.push(queue);
  return { queue, calls, release: (index: number) => writeFileSync(path.join(control, `release-${index}`), '') };
}

function selected(input: ControlIntakeInput, departmentId = 'eng'): ControlIntakeResult {
  return { route: { state: 'selected', projectId: input.projectId, departmentId, headAgentId: departmentId === 'eng' ? 'head' : 'finance-head',
    reason: 'The department owns the request.', method: 'classifier', decidedAt: new Date().toISOString(), elapsedMs: 1, workspaceRevision: input.workspace.revision } };
}
async function until(queue: RequestQueue, id: string, predicate: (item: RequestItem) => boolean): Promise<RequestItem> {
  const end = Date.now() + 5000;
  for (;;) {
    const item = queue.get(id);
    if (predicate(item)) return item;
    if (Date.now() > end) throw new Error(`Request did not settle: ${JSON.stringify(item)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('automatic Control Center request admission', () => {
  it('persists one pending receipt before classification and deduplicates simultaneous retries through dispatch', async () => {
    const root = await workspace();
    const started = gate(); const finish = gate(); let classifications = 0;
    const h = harness(root, async (input) => { classifications++; started.resolve(); await finish.promise; return selected(input); });
    const body = { projectId: 'one', task: 'Fix the parser.', clientRequestId: 'one-deliberate-message' };
    const [a, b] = await Promise.all([h.queue.submit(body), h.queue.submit(body)]);
    expect(a.id).toBe(b.id);
    expect(a.route?.state).toBe('pending');
    const saved = JSON.parse(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8'));
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].route.state).toBe('pending');
    expect(h.calls).toHaveLength(0);
    await started.promise;
    expect(classifications).toBe(1);
    finish.resolve();
    const live = await until(h.queue, a.id, (item) => item.state === 'running');
    expect(live.route).toMatchObject({ method: 'classifier', departmentId: 'eng' });
    expect(h.calls).toHaveLength(1);
    expect((await h.queue.submit(body)).id).toBe(a.id);
    expect(classifications).toBe(1);
    h.release(1);
    await until(h.queue, a.id, (item) => item.state === 'ended');
  });

  it('retains the semantic Finance destination when it has no workers instead of dispatching Engineering', async () => {
    const root = await workspace();
    const h = harness(root, async (input) => selected(input, 'finance'));
    const receipt = await h.queue.submit({ projectId: 'one', task: 'Review our cash flow.' });
    const blocked = await until(h.queue, receipt.id, (item) => item.state === 'failed_to_start');
    expect(blocked.departmentId).toBe('finance');
    expect(blocked.result?.code).toBe('no_worker_on_project');
    expect(h.calls).toHaveLength(0);
  });

  it('holds an interrupted pending route after restart and never reclassifies it automatically', async () => {
    const root = await workspace(); const started = gate(); const finish = gate(); let classified = 0;
    const h = harness(root, async (input) => { classified++; started.resolve(); await finish.promise; return selected(input); });
    const receipt = await h.queue.submit({ projectId: 'one', task: 'Fix it.', clientRequestId: 'restart-pending' });
    await started.promise;
    h.queue.close();
    const next = harness(root, async (input) => { classified++; return selected(input); });
    expect(next.queue.get(receipt.id)).toMatchObject({ state: 'held', route: { state: 'pending' } });
    finish.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(classified).toBe(1);
    expect(next.calls).toHaveLength(0);
  });

  it('reserves free B while shared A is busy and passes the exact saved subset and workspace revision to the CLI', async () => {
    const root = await workspace(); let classified = 0;
    const h = harness(root, async (input) => { classified++; return selected(input); });
    const a = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Use exactly one worker.' });
    await until(h.queue, a.id, (item) => item.state === 'running');
    const b = await h.queue.submit({ projectId: 'two', departmentId: 'eng', task: 'Work concurrently.' });
    const live = await until(h.queue, b.id, (item) => item.state === 'running');
    expect(classified).toBe(0);
    expect(live.workerIds).toEqual(['free']);
    expect(h.calls[1]?.filter((arg) => arg.startsWith('--worker='))).toEqual(['--worker=free']);
    expect(h.calls[1]).toContain(`--workspace-revision=${loadWorkspace(root).config.revision}`);
    const saved = JSON.parse(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8'));
    expect(saved.items.find((item: RequestItem) => item.id === b.id)).toMatchObject({ workerIds: ['free'], admittedWorkspaceRevision: live.admittedWorkspaceRevision });
    h.release(1); h.release(2);
    await until(h.queue, b.id, (item) => item.state === 'ended');
  });

  it('queues an AI greeting behind an owned intake turn while an explicit directive routes immediately', async () => {
    const root = await workspace(); const started = gate(); const finish = gate(); let classified = 0;
    const h = harness(root, async (input) => {
      classified++;
      if (input.task === 'hello') return { route: { ...selected(input).route, method: 'direct_reply', departmentId: null, headAgentId: null }, reply: 'Hello from Control Center.' };
      started.resolve(); await finish.promise; return selected(input);
    });
    const pending = await h.queue.submit({ projectId: 'one', task: 'Explain this bug.' });
    await started.promise;
    const greeting = await h.queue.submit({ projectId: 'one', task: 'hello' });
    expect(h.queue.get(greeting.id).route?.state).toBe('pending');
    const explicit = await h.queue.submit({ projectId: 'two', task: '@eng fix the test' });
    const live = await until(h.queue, explicit.id, (item) => item.state === 'running');
    expect(live.route?.method).toBe('directive');
    expect(classified).toBe(1);
    h.queue.discard(pending.id); finish.resolve(); h.release(1);
    const answer = await until(h.queue, greeting.id, (item) => item.state === 'ended');
    expect(answer.route?.method).toBe('direct_reply');
    expect(answer.controlReply).toBe('Hello from Control Center.');
    expect(classified).toBe(2);
    expect(h.calls).toHaveLength(1);
    await until(h.queue, explicit.id, (item) => item.state === 'ended');
  });

  it('waits for a live project to end before opening a consented unconfined classifier', async () => {
    const root = await workspace([{ op: 'runtime.set', id: 'claude-local', adapter: 'claude-code', executable: 'claude' }, { op: 'control-center.set', runtime: 'claude-local' }]);
    let classified = 0;
    const h = harness(root, async (input) => { classified++; return selected(input); });
    const active = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Run the current task.' });
    await until(h.queue, active.id, (item) => item.state === 'running');
    const pending = await h.queue.submit({ projectId: 'two', task: 'Fix the issue.', allowUnconfinedWrites: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.queue.get(pending.id).route?.state).toBe('pending');
    expect(classified).toBe(0);
    h.release(1);
    await until(h.queue, pending.id, (item) => item.state === 'running');
    expect(classified).toBe(1);
    h.release(2);
    await until(h.queue, pending.id, (item) => item.state === 'ended');
  });

  it('refuses changed runtime authority while a preflighted request waits without starting a second paid turn', async () => {
    const root = await workspace([{ op: 'runtime.set', id: 'claude-local', adapter: 'claude-code', executable: 'claude' }]);
    let classified = 0;
    const h = harness(root, async (input) => { classified++; return selected(input); });
    const active = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'First task.' });
    await until(h.queue, active.id, (item) => item.state === 'running');
    const pending = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Next task under the approved runtime.' });
    expect(pending.state).toBe('queued');
    updateWorkspace(root, (current) => applyWorkspaceOps(current, parseWorkspaceOps([{ op: 'agent.edit', id: 'head', runtime: 'claude-local' }])));
    h.release(1);
    const refused = await until(h.queue, pending.id, (item) => item.state === 'failed_to_start');
    expect(refused.result?.code).toBe('admission_workspace_changed');
    expect(classified).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('uses available Codex workers without requiring consent for an unselected Claude worker', async () => {
    const root = await workspace([
      { op: 'runtime.set', id: 'claude-local', adapter: 'claude-code', executable: 'claude' },
      { op: 'agent.add', id: 'unconfined', name: 'Unconfined', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'claude-local', projectIds: ['two'] },
    ]);
    const h = harness(root, async (input) => selected(input));
    const receipt = await h.queue.submit({ projectId: 'two', departmentId: 'eng', task: 'Use the available worker.' });
    const live = await until(h.queue, receipt.id, (item) => item.state === 'running');
    expect(live.allowUnconfinedWrites).toBe(false);
    expect(live.workerIds).not.toContain('unconfined');
    expect(live.workerIds.length).toBeGreaterThan(0);
    expect(h.calls[0]).not.toContain('--worker=unconfined');
    expect(h.calls[0]).not.toContain('--allow-unconfined-writes');
    h.release(1);
    await until(h.queue, receipt.id, (item) => item.state === 'ended');
  });

  it.each(['running', 'unknown'] as const)('retains a %s routing process after the finished-history retention limit', async (state) => {
    const root = await workspace();
    const h = harness(root, async (input) => {
      input.onSession?.({ adapter: 'codex', sessionId: 'unconfirmed-routing', process: null, raw: null });
      if (state === 'unknown') input.onStopped?.({ sessionId: 'unconfirmed-routing', state: 'unknown', processId: null, signal: null, at: new Date().toISOString() });
      return { route: { ...selected(input).route, state: 'blocked', code: 'routing_stop_unconfirmed' } };
    });
    const uncertain = await h.queue.submit({ projectId: 'one', task: 'Classify this request.' });
    await until(h.queue, uncertain.id, (item) => item.state === 'failed_to_start');
    for (let index = 0; index < 201; index++) {
      const invalid = await h.queue.submit({ projectId: 'one', task: '@missing-team hello' });
      await until(h.queue, invalid.id, (item) => item.state === 'failed_to_start');
    }
    expect(h.queue.get(uncertain.id).routingSession?.state).toBe(state);
    h.queue.close();
    const restarted = harness(root, async (input) => selected(input));
    expect(restarted.queue.get(uncertain.id).routingSession?.state).toBe('unknown');
    const request = await restarted.queue.submit({ projectId: 'two', departmentId: 'eng', task: 'Do not race the unconfirmed classifier.' });
    expect(request.state).toBe('queued');
    expect(h.calls).toHaveLength(0);
    expect(restarted.calls).toHaveLength(0);
  }, 15_000);

  it.each(['unknown', 'requested', 'process_tree_terminated'] as const)('uses the %s startup cleanup receipt before permitting later project work', async (state) => {
    const root = await workspace();
    let turns = 0;
    const adapter = {
      id: 'codex',
      capabilities: () => ({ capabilities: { write_containment: CODEX_CAPABILITIES.write_containment } }),
      openSession: async () => { throw new AdapterError('codex', 'thread_start_rejected', 'The runtime rejected startup.', {
        sessionId: 'startup-receipt', state, processId: 123456789, signal: null, at: new Date().toISOString(),
      }); },
      startTurn: async () => { turns++; throw new Error('A rejected startup must never start a turn.'); },
    } as unknown as RuntimeAdapter;
    const h = harness(root, (input) => routeControlRequest({ ...input, adapterFactory: () => adapter }));
    const receipt = await h.queue.submit({ projectId: 'one', task: 'Classify this request.' });
    const failed = await until(h.queue, receipt.id, (item) => item.state === 'failed_to_start');
    expect(turns).toBe(0);
    expect(failed.routingSession?.state).toBe(state === 'process_tree_terminated' ? 'stopped' : 'unknown');
    const next = await h.queue.submit({ projectId: 'two', departmentId: 'eng', task: 'Start only after known cleanup.' });
    if (state === 'process_tree_terminated') {
      await until(h.queue, next.id, (item) => item.state === 'running');
      expect(h.calls).toHaveLength(1);
      h.release(1);
      await until(h.queue, next.id, (item) => item.state === 'ended');
    } else {
      expect(next.state).toBe('queued');
      expect(h.calls).toHaveLength(0);
    }
  });
});
