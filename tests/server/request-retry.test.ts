import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestQueue, type RequestItem, type RequestQueueOptions } from '../../src/server/requests.js';
import { updateWorkspace, loadWorkspace } from '../../src/workspace/store.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';
import type { ControlIntakeInput, ControlIntakeResult } from '../../src/routing/control-intake.js';

const queues: RequestQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.close(); cleanupAll(); });
function workspace() {
  const root = path.join(tempDir(), 'state');
  updateWorkspace(root, config => applyWorkspaceOps(config, parseWorkspaceOps([{ op: 'project.add', name: 'one', repoPath: '/fixture/one' }])));
  return root;
}
function blocked(input: ControlIntakeInput, reason: string): ControlIntakeResult {
  return { route: { state: 'blocked', projectId: input.projectId, departmentId: null, headAgentId: null,
    reason, code: 'routing_runtime_failed', method: 'classifier', elapsedMs: 1, decidedAt: new Date().toISOString() } };
}
function harness(root: string, route: NonNullable<RequestQueueOptions['routeControl']>, extra: Partial<RequestQueueOptions> = {}) {
  const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: {}, pollMs: 10, retryBaseDelayMs: 10,
    readiness: async () => ({ checkedAt: new Date().toISOString(), reports: [] }), routeControl: route,
    spawner: () => { throw new Error('These intake fixtures must not execute workers'); }, ...extra });
  queues.push(queue); return queue;
}
async function until(test: () => boolean) {
  for (let n = 0; n < 300; n++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('request state did not settle');
}
const records = (queue: RequestQueue) => queue.list()['items'] as RequestItem[];

describe('recorded request recovery', () => {
  it('retries a known temporary intake failure twice with durable backoff, then exposes explicit Retry', async () => {
    const root = workspace(); let attempts = 0;
    const queue = harness(root, async input => { attempts++; return blocked(input, 'ECONNRESET from provider'); });
    const first = await queue.submit({ projectId: 'one', task: 'Implement the preserved PRD.' });
    await until(() => attempts === 3 && records(queue).every(item => item.state === 'failed_to_start'));
    expect(records(queue)).toHaveLength(3);
    expect(records(queue).filter(item => item.retryReason === 'provider_transient')).toHaveLength(2);
    const last = records(queue).find(item => item.retryAttempt === 2)!;
    expect(last.recovery).toMatchObject({ canRetry: true, automaticRetriesRemaining: 0, failureClass: 'provider_transient' });
    expect(queue.get(first.id).recovery).toMatchObject({ canRetry: false, nextRequestId: expect.any(String) });
    expect(JSON.parse(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8')).items).toHaveLength(3);
    await new Promise(resolve => setTimeout(resolve, 60)); expect(attempts).toBe(3);
  });

  it.each(['not logged in', 'usage limit reached', 'permission denied', 'malformed model configuration'])('does not automatically retry %s', async reason => {
    const root = workspace(); let attempts = 0;
    const queue = harness(root, async input => { attempts++; return blocked(input, reason); });
    const item = await queue.submit({ projectId: 'one', task: 'Complete this request.' });
    await until(() => queue.get(item.id).state === 'failed_to_start');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(attempts).toBe(1); expect(queue.get(item.id).recovery?.canRetry).toBe(true);
  });

  it('deduplicates different simultaneous retry click keys, preserves wording/config, and retains prior failure', async () => {
    const root = workspace(); const observed: ControlIntakeInput[] = [];
    const queue = harness(root, async input => { observed.push(input); return blocked(input, 'not logged in'); });
    const first = await queue.submit({ projectId: 'one', task: '  Exact original task\nwith markdown.\n', mode: 'discuss', clientRequestId: 'original' });
    await until(() => queue.get(first.id).state === 'failed_to_start');
    const [a, b] = await Promise.all([queue.retry(first.id, { clientRequestId: 'click-a' }), queue.retry(first.id, { clientRequestId: 'click-b' })]);
    expect(a.id).toBe(b.id); expect(a.id).not.toBe(first.id);
    await until(() => queue.get(a.id).state === 'failed_to_start');
    expect(observed.map(input => input.task)).toEqual([first.task, first.task]);
    expect(a).toMatchObject({ retryOfRequestId: first.id, retryRootRequestId: first.id, retryAttempt: 1, mode: 'discuss' });
    expect(queue.get(first.id).state).toBe('failed_to_start');
    expect((await queue.retry(first.id, { clientRequestId: 'click-a' })).id).toBe(a.id);
  });

  it('never retries a queued, successful, discarded or unresolved-routing request', async () => {
    const root = workspace(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = harness(root, async input => { await gate; return blocked(input, 'not logged in'); });
    const first = await queue.submit({ projectId: 'one', task: 'Wait for a decision.' });
    await expect(queue.retry(first.id, { clientRequestId: 'queued' })).rejects.toMatchObject({ code: 'request_not_retryable' });
    queue.discard(first.id); release();
    await expect(queue.retry(first.id, { clientRequestId: 'discarded' })).rejects.toMatchObject({ code: 'request_not_retryable' });
    const unresolved = harness(workspace(), async input => {
      input.onStartupStopped?.({ sessionId: 'uncertain', state: 'unknown', processId: 99999, signal: null, at: new Date().toISOString() });
      return blocked(input, 'ECONNRESET');
    });
    const item = await unresolved.submit({ projectId: 'one', task: 'Do not race unknown runtime.' });
    await until(() => unresolved.get(item.id).state === 'failed_to_start');
    await expect(unresolved.retry(item.id, { clientRequestId: 'unknown-owner' })).rejects.toMatchObject({ code: 'request_not_retryable' });
    expect(records(unresolved)).toHaveLength(1);
  });

  it('holds a saved delayed retry across restart and never resets its retry budget', async () => {
    const root = workspace(); let attempts = 0;
    const route = async (input: ControlIntakeInput) => { attempts++; return blocked(input, 'ETIMEDOUT'); };
    const queue = harness(root, route, { retryBaseDelayMs: 1000 });
    await queue.submit({ projectId: 'one', task: 'Preserve delayed retry intent.' });
    await until(() => records(queue).length === 2);
    const retry = records(queue).find(item => item.retryAttempt === 1)!;
    queue.close();
    const restarted = harness(root, route);
    expect(restarted.get(retry.id)).toMatchObject({ state: 'held', retryAttempt: 1, recoveryPolicy: retry.recoveryPolicy });
    await new Promise(resolve => setTimeout(resolve, 60)); expect(attempts).toBe(1);
    expect(loadWorkspace(root).config.projects).toHaveLength(1);
  });

  it('keeps the spent automatic budget when old queue history is removed and the user retries manually', async () => {
    const root = workspace(); let attempts = 0;
    const route = async (input: ControlIntakeInput) => { attempts++; return blocked(input, 'ECONNRESET'); };
    const queue = harness(root, route);
    await queue.submit({ projectId: 'one', task: 'Do not reset spent retry budget.' });
    await until(() => attempts === 3 && records(queue).every(item => item.state === 'failed_to_start'));
    const last = records(queue).find(item => item.retryAttempt === 2)!; queue.close();
    const file = path.join(root, 'serve', 'requests.json'); const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.items = saved.items.filter((item: RequestItem) => item.id === last.id); writeFileSync(file, JSON.stringify(saved));
    const restarted = harness(root, route);
    const retry = await restarted.retry(last.id, { clientRequestId: 'after-retention' });
    await until(() => restarted.get(retry.id).state === 'failed_to_start');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(attempts).toBe(4); expect(restarted.get(retry.id)).toMatchObject({ automaticRetriesUsed: 2, recovery: { automaticRetriesRemaining: 0 } });
  });

});
