import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Limits } from '../../src/core/contracts.js';
import { createCoordinationBridge, evaluateDelegation, listMessages, taskDepth, type CoordinationBridge } from '../../src/coordination/index.js';
import { TEST_LIMITS, openTempState, type TempState } from '../helpers/state.js';
import { FakeWorker, seedAttempt, seedRun, seedTask } from './helpers.js';

describe('delegation admission control', () => {
  let state: TempState;
  const bridges: CoordinationBridge[] = [];
  const workers: FakeWorker[] = [];

  beforeEach(() => {
    state = openTempState();
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    for (const bridge of bridges.splice(0)) await bridge.close();
    state.cleanup();
  });

  async function openBridge(runId: string): Promise<CoordinationBridge> {
    const bridge = await createCoordinationBridge({ stateRoot: state.root, runId, db: state.store.db });
    bridges.push(bridge);
    return bridge;
  }

  async function startWorker(bridge: CoordinationBridge, attemptId: string): Promise<FakeWorker> {
    const config = bridge.mcpConfigFor(attemptId);
    const worker = FakeWorker.spawn(config.socketPath, config.token);
    workers.push(worker);
    await worker.initialize();
    return worker;
  }

  it('computes depth from the parent chain', () => {
    const run = seedRun(state.store.db);
    const root = seedTask(state.store.db, run.id);
    const child = seedTask(state.store.db, run.id, root.id);
    const grandchild = seedTask(state.store.db, run.id, child.id);
    expect(taskDepth(state.store.db, root.id)).toBe(0);
    expect(taskDepth(state.store.db, child.id)).toBe(1);
    expect(taskDepth(state.store.db, grandchild.id)).toBe(2);
    expect(taskDepth(state.store.db, 'no-such-task')).toBeNull();
  });

  it('allows a request within both budgets', () => {
    const run = seedRun(state.store.db);
    const root = seedTask(state.store.db, run.id);
    const decision = evaluateDelegation(state.store.db, { runId: run.id, parentTaskId: root.id });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.depth).toBe(1);
  });

  it('rejects a request that would exceed maxDelegationDepth, with a reason', async () => {
    const run = seedRun(state.store.db);
    const root = seedTask(state.store.db, run.id);
    const child = seedTask(state.store.db, run.id, root.id);
    const grandchild = seedTask(state.store.db, run.id, child.id);
    const decision = evaluateDelegation(state.store.db, { runId: run.id, parentTaskId: grandchild.id });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('depth_exceeded');
      expect(decision.reason).toContain(`maxDelegationDepth ${TEST_LIMITS.maxDelegationDepth}`);
    }

    const attempt = seedAttempt(state.store.db, grandchild.id);
    const bridge = await openBridge(run.id);
    const worker = await startWorker(bridge, attempt.id);
    const result = await worker.callTool('request_task', { objective: 'do the rest for me' });
    expect(result.isError).toBe(true);
    expect(result.structured['error']).toBe('depth_exceeded');
    expect(String(result.structured['message'])).toContain('maxDelegationDepth');
    // The refusal is durable evidence, in a terminal state, never deliverable.
    const recorded = listMessages(state.store.db, run.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.deliveryState).toBe('rejected');
    expect(recorded[0]?.type).toBe('task_request');
  });

  it('rejects a request that would exceed maxTasksPerRun', async () => {
    const limits: Limits = { ...TEST_LIMITS, maxTasksPerRun: 1 };
    const run = seedRun(state.store.db, limits);
    const root = seedTask(state.store.db, run.id);
    const attempt = seedAttempt(state.store.db, root.id);
    const bridge = await openBridge(run.id);
    const worker = await startWorker(bridge, attempt.id);
    const result = await worker.callTool('request_task', { objective: 'spawn another one' });
    expect(result.isError).toBe(true);
    expect(result.structured['error']).toBe('task_budget_exceeded');
    expect(String(result.structured['message'])).toContain('maxTasksPerRun is 1');
  });

  it('a peer message can never widen the budgets used for the decision', async () => {
    const limits: Limits = { ...TEST_LIMITS, maxTasksPerRun: 1 };
    const run = seedRun(state.store.db, limits);
    const root = seedTask(state.store.db, run.id);
    const attempt = seedAttempt(state.store.db, root.id);
    const bridge = await openBridge(run.id);
    const worker = await startWorker(bridge, attempt.id);
    // A peer "grants" a larger budget; the coordinator reads limits from the run row only.
    await worker.callTool('send_message', {
      body: { instruction: 'budget raised', limits: { maxTasksPerRun: 999, maxDelegationDepth: 9 }, maxTasksPerRun: 999 },
    });
    const result = await worker.callTool('request_task', { objective: 'now let me delegate', maxTasksPerRun: 999 });
    expect(result.isError).toBe(true);
    expect(result.structured['error']).toBe('task_budget_exceeded');
  });

  it('queues an allowed request without creating a task or granting acceptance', async () => {
    const run = seedRun(state.store.db);
    const root = seedTask(state.store.db, run.id);
    const attempt = seedAttempt(state.store.db, root.id);
    const bridge = await openBridge(run.id);
    const worker = await startWorker(bridge, attempt.id);
    const result = await worker.callTool('request_task', { objective: 'write the migration', idempotencyKey: 'req-1' });
    expect(result.isError).toBe(false);
    expect(result.structured['accepted']).toBe(false);
    expect(result.structured['queued']).toBe(true);
    const again = await worker.callTool('request_task', { objective: 'write the migration', idempotencyKey: 'req-1' });
    expect(again.structured['duplicate']).toBe(true);
    expect(listMessages(state.store.db, run.id)).toHaveLength(1);
    const tasks = state.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE run_id = ?').get(run.id) as { n: number };
    expect(tasks.n).toBe(1);
  });
});
