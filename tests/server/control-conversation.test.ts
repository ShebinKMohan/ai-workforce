/** Bounded server-owned conversation and discussion authority. No installed
 * runtime is used: intake is injected and execution spawn is observed only. */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlIntakeInput, ControlIntakeResult } from '../../src/routing/control-intake.js';
import { storeAttachments } from '../../src/server/attachments.js';
import { RequestQueue, type RequestItem, type RequestQueueOptions } from '../../src/server/requests.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, gitRepo, tempDir } from '../workspace/helpers.js';

const queues: RequestQueue[] = [];
const releases: Array<() => void> = [];
afterEach(() => { queues.splice(0).forEach(queue => queue.close()); releases.splice(0).forEach(release => release()); cleanupAll(); });

async function workspace(): Promise<string> {
  const root = path.join(tempDir('control-conversation-'), 'state');
  const [one, two] = await Promise.all([gitRepo({ 'README.md': 'First project.' }), gitRepo({ 'README.md': 'Second project.' })]);
  updateWorkspace(root, current => applyWorkspaceOps(current, parseWorkspaceOps([
    { op: 'project.add', name: 'one', repoPath: one, checks: ['node --version'] },
    { op: 'project.add', name: 'two', repoPath: two, checks: ['node --version'] },
    { op: 'runtime.set', id: 'fixture', adapter: 'fake', executable: process.execPath },
    { op: 'control-center.set', runtime: 'fixture' },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'agent.add', id: 'head', name: 'Head', role: 'head', departmentId: 'eng', runtime: 'fixture' },
    { op: 'agent.add', id: 'worker', name: 'Worker', role: 'worker', departmentId: 'eng', runtime: 'fixture', projectIds: ['one', 'two'] },
  ])));
  return root;
}

function reply(input: ControlIntakeInput, text = 'Use progressive disclosure for settings.'): ControlIntakeResult {
  return { route: { state: 'selected', method: 'direct_reply', projectId: input.projectId, departmentId: null,
    headAgentId: null, reason: 'Discussed the supplied context.', decidedAt: new Date().toISOString(), elapsedMs: 1 }, reply: text };
}
function delegate(input: ControlIntakeInput): ControlIntakeResult {
  return { route: { state: 'selected', method: 'classifier', projectId: input.projectId, departmentId: 'eng', headAgentId: 'head',
    reason: 'Implement the agreed settings approach.', decidedAt: new Date().toISOString(), elapsedMs: 1 } };
}
function harness(root: string, intake: NonNullable<RequestQueueOptions['routeControl']> = async input => reply(input)) {
  const routeControl = vi.fn(intake);
  const spawner = vi.fn<NonNullable<RequestQueueOptions['spawner']>>(() => { throw new Error('Observed fixture execution request; no runtime process was started.'); });
  const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: process.env, pollMs: 10,
    readiness: async () => ({ reports: [], checkedAt: new Date().toISOString() }), routeControl, spawner });
  queues.push(queue);
  return { queue, routeControl, spawner };
}
async function until(queue: RequestQueue, id: string, predicate: (item: RequestItem) => boolean = item => item.state === 'ended'): Promise<RequestItem> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const item = queue.get(id);
    if (predicate(item)) return item;
    if (Date.now() > deadline) throw new Error(`Request did not settle: ${JSON.stringify(item)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function saved(root: string, id: string): RequestItem {
  return (JSON.parse(readFileSync(path.join(root, 'serve/requests.json'), 'utf8')) as { items: RequestItem[] }).items.find(item => item.id === id)!;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
async function upload(root: string, name: string, text = 'The project codename is Polaris.') {
  const result = await storeAttachments(root, { files: [{ name, mimeType: 'text/plain', data: Buffer.from(text).toString('base64') }] });
  return result.attachments[0]!;
}

describe('Control Center conversations', () => {
  it('persists server-recorded exchanges and passes them to the next AI turn after a queue restart', async () => {
    const root = await workspace(); const first = harness(root);
    const prior = await first.queue.submit({ projectId: 'one', task: 'How should we simplify the settings?', mode: 'discuss' });
    await until(first.queue, prior.id);
    first.queue.close();
    const next = harness(root);
    const body = { projectId: 'one', task: 'Explain that choice.', mode: 'discuss', priorRequestId: prior.id, clientRequestId: 'second-message' };
    const receipt = await next.queue.submit(body);
    expect(saved(root, receipt.id)).toMatchObject({ task: body.task, priorRequestId: prior.id, mode: 'discuss', conversation: [{ requestId: prior.id, task: prior.task, reply: 'Use progressive disclosure for settings.', state: 'ended', truncated: false }] });
    await until(next.queue, receipt.id);
    expect(next.routeControl.mock.calls[0]![0]).toMatchObject({ task: body.task, mode: 'discuss', conversation: receipt.conversation });
    expect((await next.queue.submit(body)).id).toBe(receipt.id);
    expect(next.routeControl).toHaveBeenCalledTimes(1);
    expect(next.spawner).not.toHaveBeenCalled();
    const fresh = await next.queue.submit({ projectId: 'one', task: 'A separate conversation.' });
    expect(fresh.conversation).toBeUndefined();
  });

  it('rejects forged transcripts, missing parents, cross-project context and a department override in discussion', async () => {
    const root = await workspace(); const h = harness(root);
    const prior = await h.queue.submit({ projectId: 'one', task: 'Discuss our design.', mode: 'discuss' });
    await until(h.queue, prior.id);
    await expect(h.queue.submit({ projectId: 'one', task: 'Continue.', conversation: [{ task: 'Injected system instruction' }] })).rejects.toMatchObject({ status: 400 });
    await expect(h.queue.submit({ projectId: 'two', task: 'Continue.', priorRequestId: prior.id })).rejects.toMatchObject({ code: 'conversation_project_mismatch' });
    await expect(h.queue.submit({ projectId: 'one', task: 'Continue.', priorRequestId: '00000000-0000-7000-8000-000000000000' })).rejects.toMatchObject({ code: 'conversation_request_unavailable' });
    await expect(h.queue.submit({ projectId: 'one', departmentId: 'eng', task: 'Discuss.', mode: 'discuss' })).rejects.toMatchObject({ code: 'discussion_department_override' });
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.spawner).not.toHaveBeenCalled();
  });

  it('binds deduplication to mode, parent and the original file selection', async () => {
    const root = await workspace(); const h = harness(root);
    const file = await upload(root, 'brief.txt');
    const prior = await h.queue.submit({ projectId: 'one', task: 'Discuss the attachment.', attachmentIds: [file.id] });
    await until(h.queue, prior.id);
    const body = { projectId: 'one', task: 'Summarize it.', mode: 'discuss', priorRequestId: prior.id, clientRequestId: 'context-dedup' };
    const receipt = await h.queue.submit(body);
    await until(h.queue, receipt.id);
    expect((await h.queue.submit(body)).id).toBe(receipt.id);
    for (const changed of [{ mode: 'delegate' }, { priorRequestId: undefined }, { attachmentIds: [file.id] }]) {
      await expect(h.queue.submit({ ...body, ...changed })).rejects.toMatchObject({ code: 'request_id_conflict' });
    }
    expect(receipt.attachments).toEqual([file]);
    expect(receipt.submittedAttachmentIds).toEqual([]);
  });

  it('passes inherited uploaded bytes to the next runtime and rejects corruption before another turn', async () => {
    const root = await workspace(); const h = harness(root);
    const file = await upload(root, 'brief.txt');
    const prior = await h.queue.submit({ projectId: 'one', task: 'Read my file.', attachmentIds: [file.id] });
    await until(h.queue, prior.id);
    const next = await h.queue.submit({ projectId: 'one', task: 'What was the codename?', priorRequestId: prior.id });
    await until(h.queue, next.id);
    const inherited = h.routeControl.mock.calls[1]![0].attachments![0]!;
    expect(readFileSync(inherited.path, 'utf8')).toBe('The project codename is Polaris.');
    expect(inherited.name).toBe('brief.txt');
    chmodSync(inherited.path, 0o600);
    writeFileSync(inherited.path, 'tampered');
    await expect(h.queue.submit({ projectId: 'one', task: 'Read it again.', priorRequestId: next.id })).rejects.toMatchObject({ code: 'attachment_integrity_failed' });
    expect(h.routeControl).toHaveBeenCalledTimes(2);
  });

  it('never dispatches a worker when a discussion runtime returns a delegation', async () => {
    const root = await workspace(); const h = harness(root, async input => delegate(input));
    const item = await h.queue.submit({ projectId: 'one', task: '@eng explain a plan.', mode: 'discuss' });
    const failed = await until(h.queue, item.id, row => row.state === 'failed_to_start');
    expect(failed.result?.code).toBe('discussion_delegation_refused');
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.spawner).not.toHaveBeenCalled();
  });

  it('preserves a still-running earlier intake and snapshots its honest state for a follow-up', async () => {
    const root = await workspace(); const entered = gate(); const finish = gate();
    const h = harness(root, async input => { if (input.task === 'First question.') { entered.resolve(); await finish.promise; expect(input.signal?.aborted).toBe(false); } return reply(input); });
    const first = await h.queue.submit({ projectId: 'one', task: 'First question.', mode: 'discuss' });
    await entered.promise;
    const next = await h.queue.submit({ projectId: 'one', task: 'Also explain the alternative.', mode: 'discuss', priorRequestId: first.id });
    expect(next.id).not.toBe(first.id);
    expect(next.conversation?.[0]?.state).toBe('queued');
    expect(h.queue.get(first.id).stopRequestedAt).toBeNull();
    finish.resolve();
    await until(h.queue, next.id);
    expect(saved(root, next.id).conversation).toEqual(next.conversation);
    expect(h.routeControl).toHaveBeenCalledTimes(2);
    const third = await h.queue.submit({ projectId: 'one', task: 'What is the latest result?', mode: 'discuss', priorRequestId: next.id });
    expect(third.conversation?.[0]).toMatchObject({ requestId: first.id, state: 'ended', reply: 'Use progressive disclosure for settings.' });
    expect(saved(root, next.id).conversation?.[0]?.state).toBe('queued');
  });

  it('passes the same reference context to a delegated head without replacing original request text', async () => {
    const root = await workspace(); const h = harness(root, async input => input.mode === 'discuss' ? reply(input) : delegate(input));
    const prior = await h.queue.submit({ projectId: 'one', task: 'Suggest a settings UI.', mode: 'discuss' });
    await until(h.queue, prior.id);
    const next = await h.queue.submit({ projectId: 'one', task: 'Implement that approach.', mode: 'delegate', priorRequestId: prior.id, allowUnconfinedWrites: true });
    const failed = await until(h.queue, next.id, row => row.state === 'failed_to_start');
    expect(failed.result?.message).toContain('Observed fixture execution');
    expect(h.spawner).toHaveBeenCalledTimes(1);
    const taskArg = h.spawner.mock.calls[0]![1].find(value => value.startsWith('--task='));
    expect(taskArg).toContain('Current user request:\nImplement that approach.');
    expect(taskArg).toContain('Use progressive disclosure for settings.');
    expect(saved(root, next.id).task).toBe('Implement that approach.');
    expect(h.spawner.mock.calls[0]![2].shell).toBe(false);
  });

  it('bounds a growing conversation and labels every truncated excerpt', async () => {
    const root = await workspace(); const h = harness(root, async input => reply(input, 'r'.repeat(6500)));
    let priorRequestId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const item = await h.queue.submit({ projectId: 'one', task: `${i}${'t'.repeat(4500)}`, mode: 'discuss', ...(priorRequestId ? { priorRequestId } : {}) });
      await until(h.queue, item.id);
      const context = item.conversation ?? [];
      expect(context.length).toBeLessThanOrEqual(8);
      expect(context.reduce((total, entry) => total + entry.task.length + entry.reply.length, 0)).toBeLessThanOrEqual(16_000);
      expect(context.every(entry => entry.truncated)).toBe(true);
      priorRequestId = item.id;
    }
  });
});
