/** Per-message Control Center settings belong to the durable request, not to
 * department agents. Intake and readiness are injected: no installed CLI runs. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CAPABILITIES } from '../../src/adapters/index.js';
import type { WorkspaceConfig } from '../../src/core/workspace-config.js';
import { capabilitiesFor } from '../../src/discovery/capabilities.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import type { ControlIntakeInput, ControlIntakeResult } from '../../src/routing/control-intake.js';
import { RequestQueue, type RequestItem, type RequestQueueOptions } from '../../src/server/requests.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, gitRepo, tempDir } from '../workspace/helpers.js';

const queues: RequestQueue[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  })));
  cleanupAll();
});

function change(root: string, ops: Array<Record<string, unknown>>): void {
  updateWorkspace(root, current => applyWorkspaceOps(current, parseWorkspaceOps(ops)));
}

async function workspace(): Promise<string> {
  const root = path.join(tempDir('control-selection-state-'), 'state');
  const [one, two] = await Promise.all([gitRepo({ 'README.md': 'one' }), gitRepo({ 'README.md': 'two' })]);
  change(root, [
    { op: 'project.add', repoPath: one, name: 'one', checks: ['node --version'] },
    { op: 'project.add', repoPath: two, name: 'two', checks: ['node --version'] },
    { op: 'runtime.set', id: 'codex-local', adapter: 'codex', executable: '/fixture/codex', model: 'binding-model', effort: 'low' },
    { op: 'runtime.set', id: 'claude-local', adapter: 'claude-code', executable: '/fixture/claude', model: 'claude-default', effort: 'medium' },
    { op: 'control-center.set', runtime: 'codex-local', model: 'control-default', effort: 'high', instructions: 'Explain the recorded workspace context.' },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'agent.add', id: 'head', name: 'Head', role: 'head', departmentId: 'eng', runtime: 'codex-local', model: 'head-model', effort: 'medium' },
    { op: 'agent.add', id: 'one-worker', name: 'One worker', role: 'worker', departmentId: 'eng', runtime: 'codex-local', model: 'worker-model', effort: 'low', projectIds: ['one'] },
    { op: 'agent.add', id: 'two-worker', name: 'Two worker', role: 'worker', departmentId: 'eng', runtime: 'codex-local', projectIds: ['two'] },
  ]);
  return root;
}

function reports(config: WorkspaceConfig): RuntimeReadinessReport[] {
  return Object.entries(config.runtimes).flatMap(([runtimeId, runtime]) => {
    if (runtime.adapter === 'fake') return [];
    const version = runtime.adapter === 'codex' ? CODEX_CAPABILITIES.write_containment.testedVersion! : '2.1.236';
    return [{
      runtimeId, adapter: runtime.adapter, displayName: runtimeId, configuredExecutable: runtime.executable,
      executable: runtime.executable, realPath: runtime.executable, version,
      installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', readiness: 'controllable',
      capabilities: capabilitiesFor(runtime.adapter, version), checkedAt: new Date().toISOString(),
      minimumSupportedVersion: '0.1.0', installations: [], searchedLocations: [], probes: [], probeKind: 'passive',
      authDetail: 'Injected readiness; no installed CLI or account was accessed.', missingControls: [],
      missingWriteBoundary: [], writingModeAvailable: true, diagnostics: [],
    }];
  });
}

const invocation = { command: 'fixture-node', args: ['fixture-cli'], cwd: process.cwd() };
const childSource = `
const fs = require('node:fs');
const [release] = process.argv.slice(1);
const runId = 'run-selection-' + process.pid;
process.stdout.write(JSON.stringify({ type: 'run.created', runId }) + '\\n');
process.on('SIGINT', () => process.exit(130));
setInterval(() => { if (fs.existsSync(release)) { process.stdout.write(JSON.stringify({ ok: true, command: 'run', exitCode: 0, runId }) + '\\n'); process.exit(0); } }, 10);
`;

function harness(root: string, intake: NonNullable<RequestQueueOptions['routeControl']> = async input => reply(input)) {
  const controls = tempDir('control-selection-children-');
  const calls: string[][] = [];
  const routeControl = vi.fn(intake);
  const validateControl = vi.fn<NonNullable<RequestQueueOptions['validateControl']>>(async () => {});
  const readiness = vi.fn(async () => ({ checkedAt: new Date().toISOString(), reports: reports(loadWorkspace(root).config) }));
  const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: process.env, invocation, pollMs: 15,
    readiness, routeControl, validateControl,
    spawner: (_command, args, options) => {
      calls.push([...args.slice(invocation.args.length)]);
      const child = spawn(process.execPath, ['-e', childSource, path.join(controls, `release-${calls.length}`)], { ...options, shell: false });
      children.push(child);
      return child;
    },
  });
  queues.push(queue);
  return { queue, calls, routeControl, validateControl, readiness,
    release: (index: number) => writeFileSync(path.join(controls, `release-${index}`), '') };
}

function reply(input: ControlIntakeInput): ControlIntakeResult {
  return { route: { state: 'selected', method: 'direct_reply', projectId: input.projectId,
    departmentId: null, headAgentId: null, reason: 'Answer based on the supplied workspace.',
    decidedAt: new Date().toISOString(), elapsedMs: 1, workspaceRevision: input.workspace.revision },
  reply: 'The department head coordinates the project workers.' };
}

async function until(queue: RequestQueue, id: string, predicate: (item: RequestItem) => boolean): Promise<RequestItem> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const item = queue.get(id);
    if (predicate(item)) return item;
    if (Date.now() > deadline) throw new Error(`Request did not settle: ${JSON.stringify(item)}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function savedItem(root: string, id: string): RequestItem {
  const saved = JSON.parse(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8')) as { items: RequestItem[] };
  return saved.items.find(item => item.id === id)!;
}

describe('per-request Control Center selection', () => {
  it('persists original and effective settings before intake without changing department agents or shared runtime defaults', async () => {
    const root = await workspace();
    const before = loadWorkspace(root).config;
    const entered = gate(); const finish = gate();
    const h = harness(root, async input => { entered.resolve(); await finish.promise; return reply(input); });
    const choice = { runtime: 'codex-local', model: 'message-model', effort: 'low' };
    const receipt = await h.queue.submit({ projectId: 'one', task: 'Explain how this workforce operates.', controlCenter: choice });
    const saved = savedItem(root, receipt.id);
    expect(saved).toMatchObject({ state: 'queued', route: { state: 'pending' }, submittedControlCenter: choice,
      controlCenter: choice, controlRuntime: before.runtimes['codex-local'] });
    choice.model = 'mutated-after-send';
    await entered.promise;
    expect(h.routeControl.mock.calls[0]![0].workspace.controlCenter).toMatchObject({ runtime: 'codex-local', model: 'message-model', effort: 'low' });
    expect(h.validateControl.mock.calls[0]![0]).toMatchObject({ runtime: 'codex-local', model: 'message-model', effort: 'low' });
    expect(loadWorkspace(root).config).toEqual(before);
    expect(h.routeControl.mock.calls[0]![0].workspace.agents).toEqual(before.agents);
    finish.resolve();
    await until(h.queue, receipt.id, item => item.state === 'ended');
    expect(h.calls).toHaveLength(0);
  });

  it('rejects reusing a submission ID after changing its original runtime, model, effort, or inherited-choice intent', async () => {
    const root = await workspace(); const h = harness(root);
    const body = { projectId: 'one', task: 'Explain the workflow.', clientRequestId: 'frozen-message',
      controlCenter: { runtime: 'codex-local', model: 'message-model', effort: 'medium' } };
    const receipt = await h.queue.submit(body);
    await until(h.queue, receipt.id, item => item.state === 'ended');
    for (const controlCenter of [
      { ...body.controlCenter, runtime: 'claude-local' },
      { ...body.controlCenter, model: 'changed-model' },
      { ...body.controlCenter, effort: 'high' },
      { runtime: 'codex-local' },
      undefined,
    ]) {
      await expect(h.queue.submit({ ...body, controlCenter })).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    }
    change(root, [{ op: 'control-center.set', runtime: 'claude-local', model: 'new-global', effort: 'high' }]);
    expect((await h.queue.submit(body)).id).toBe(receipt.id);
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.validateControl).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
  });

  it('captures Control Center defaults when omitted and binding defaults when only a runtime is explicitly selected', async () => {
    const root = await workspace(); const h = harness(root);
    const inherited = await h.queue.submit({ projectId: 'one', task: 'Explain the default setup.' });
    const explicit = await h.queue.submit({ projectId: 'one', task: 'Explain with this runtime.', controlCenter: { runtime: 'codex-local' } });
    const other = await h.queue.submit({ projectId: 'one', task: 'Explain with the other runtime.', controlCenter: { runtime: 'claude-local' }, allowUnconfinedWrites: true });
    expect(inherited.submittedControlCenter).toBeUndefined();
    expect(inherited.controlCenter).toMatchObject({ runtime: 'codex-local', model: 'control-default', effort: 'high' });
    expect(explicit.submittedControlCenter).toEqual({ runtime: 'codex-local' });
    expect(explicit.controlCenter).toMatchObject({ runtime: 'codex-local', model: 'binding-model', effort: 'low' });
    expect(other.controlCenter).toMatchObject({ runtime: 'claude-local', model: 'claude-default', effort: 'medium' });
    await until(h.queue, other.id, item => item.state === 'ended');
    expect(h.routeControl.mock.calls.map(([input]) => input.workspace.controlCenter?.model)).toEqual(['control-default', 'binding-model', 'claude-default']);
    expect(h.calls).toHaveLength(0);
  });

  it('keeps a queued message and its retry on the captured global defaults after settings change', async () => {
    const root = await workspace(); const entered = gate(); const finish = gate();
    const h = harness(root, async input => {
      if (input.task === 'Hold the first intake.') { entered.resolve(); await finish.promise; }
      return reply(input);
    });
    await h.queue.submit({ projectId: 'one', task: 'Hold the first intake.' });
    await entered.promise;
    const body = { projectId: 'two', task: 'Explain this setup.', clientRequestId: 'inherit-once' };
    const queued = await h.queue.submit(body);
    const frozen = structuredClone(queued.controlCenter);
    change(root, [{ op: 'control-center.set', runtime: 'claude-local', model: 'new-global', effort: 'medium', instructions: 'New guidance.' }]);
    const retry = await h.queue.submit(body);
    expect(retry.id).toBe(queued.id);
    expect(retry.controlCenter).toEqual(frozen);
    expect(savedItem(root, queued.id).controlCenter).toEqual(frozen);
    finish.resolve();
    const ended = await until(h.queue, queued.id, item => item.state === 'ended');
    expect(ended.controlCenter).toEqual(frozen);
    expect(h.routeControl.mock.calls[1]![0].workspace.controlCenter).toEqual(frozen);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a replaced saved executable before starting a queued intake', async () => {
    const root = await workspace(); const entered = gate(); const finish = gate();
    const h = harness(root, async input => { entered.resolve(); await finish.promise; return reply(input); });
    await h.queue.submit({ projectId: 'one', task: 'Own the current intake.' });
    await entered.promise;
    const queued = await h.queue.submit({ projectId: 'two', task: 'Use the chosen binding.', controlCenter: { runtime: 'codex-local', model: 'message-model', effort: 'medium' } });
    change(root, [{ op: 'runtime.set', id: 'codex-local', adapter: 'codex', executable: '/fixture/replaced-codex', model: 'replacement-model', effort: 'high' }]);
    finish.resolve();
    const failed = await until(h.queue, queued.id, item => item.state === 'failed_to_start');
    expect(failed.result?.code).toBe('control_runtime_changed');
    expect(failed.route).toMatchObject({ state: 'blocked', code: 'control_runtime_changed' });
    expect(failed.controlRuntime?.executable).toBe('/fixture/codex');
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
  });

  it('uses the per-message Claude choice for exclusive admission while department agents retain Codex', async () => {
    const root = await workspace(); const entered = gate(); const finish = gate();
    const h = harness(root, async input => { entered.resolve(); await finish.promise; return reply(input); });
    const active = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Keep the first worker busy.' });
    await until(h.queue, active.id, item => item.state === 'running');
    const control = await h.queue.submit({ projectId: 'two', task: 'Explain this workspace.', allowUnconfinedWrites: true,
      controlCenter: { runtime: 'claude-local', model: 'chosen-claude', effort: 'high' } });
    await until(h.queue, control.id, item => item.reason?.includes('must route this request on its own') === true);
    expect(h.routeControl).not.toHaveBeenCalled();
    h.release(1);
    await entered.promise;
    expect(h.routeControl.mock.calls[0]![0].workspace.controlCenter).toMatchObject({ runtime: 'claude-local', model: 'chosen-claude', effort: 'high' });
    const waiting = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Start after the exclusive intake exits.' });
    expect(waiting.state).toBe('queued');
    expect(h.calls).toHaveLength(1);
    expect(loadWorkspace(root).config.controlCenter?.runtime).toBe('codex-local');
    expect(loadWorkspace(root).config.agents.every(agent => agent.runtime === 'codex-local')).toBe(true);
    finish.resolve();
    await until(h.queue, control.id, item => item.state === 'ended');
    await until(h.queue, waiting.id, item => item.state === 'running');
    expect(h.calls).toHaveLength(2);
    h.release(2);
    await until(h.queue, waiting.id, item => item.state === 'ended');
  });

  it('waits for an existing exclusive department run before opening a selected Codex intake', async () => {
    const root = await workspace();
    change(root, [{ op: 'agent.edit', id: 'head', runtime: 'claude-local' }]);
    const h = harness(root);
    const active = await h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Finish the exclusive department work.', allowUnconfinedWrites: true });
    const running = await until(h.queue, active.id, item => item.state === 'running');
    expect(running.exclusive).toBe(true);
    const control = await h.queue.submit({ projectId: 'two', task: 'Explain this workspace with Codex.',
      controlCenter: { runtime: 'codex-local', model: 'message-model', effort: 'medium' } });
    await until(h.queue, control.id, item => item.reason?.startsWith('waiting:') === true);
    expect(h.routeControl).not.toHaveBeenCalled();
    expect(h.queue.get(control.id).route?.state).toBe('pending');
    h.release(1);
    await until(h.queue, control.id, item => item.state === 'ended');
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.routeControl.mock.calls[0]![0].workspace.controlCenter).toMatchObject({ runtime: 'codex-local', model: 'message-model', effort: 'medium' });
    expect(h.calls).toHaveLength(1);
  });
});
