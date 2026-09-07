import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../src/core/state.js';
import { computeAgentSnapshot } from '../src/core/snapshot.js';
import { validateAgentConfig } from '../src/core/contracts.js';
import { readFileSync } from 'node:fs';
import { listEvents } from '../src/storage/events.js';
import { OperationStateError, StaleGenerationError, listOpenOperations, markDispatched, markUncertain, recordIntent, recordReceipt } from '../src/storage/operations.js';
import { beginNewGeneration, getAttempt, getTask, insertAttempt, transitionTask, upsertAgentSnapshot } from '../src/storage/records.js';
import { withTransaction } from '../src/storage/tx.js';
import { openTempState, seedRunAndTask, type TempState } from './helpers/state.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

describe('operations: intent -> dispatched -> receipt', () => {
  it('persists intent and receipts with ordered events and idempotent duplicate receipts', () => {
    const { run, task } = seedRunAndTask(state);
    const db = state.store.db;

    const op = recordIntent(db, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: { executable: 'fake' } });
    expect(op.state).toBe('intended');
    expect(op.generation).toBe(1);
    expect(listOpenOperations(db, run.id).map((o) => o.id)).toEqual([op.id]);

    const dispatched = markDispatched(db, op.id, { pid: 4242 });
    expect(dispatched.state).toBe('dispatched');
    expect(dispatched.dispatchedAt).not.toBeNull();
    expect(markDispatched(db, op.id).state).toBe('dispatched'); // idempotent

    const completed = recordReceipt(db, op.id, { outcome: 'completed', receipt: { exitCode: 0 } });
    expect(completed.state).toBe('completed');
    expect(completed.receipt).toEqual({ exitCode: 0 });
    expect(listOpenOperations(db, run.id)).toEqual([]);

    const eventsBefore = listEvents(db, run.id).length;
    const duplicate = recordReceipt(db, op.id, { outcome: 'completed', receipt: { exitCode: 0, late: true } });
    expect(duplicate.receipt).toEqual({ exitCode: 0 }); // first receipt wins, no overwrite
    expect(listEvents(db, run.id).length).toBe(eventsBefore); // no duplicate event

    expect(() => recordReceipt(db, op.id, { outcome: 'failed', receipt: {} })).toThrow(OperationStateError);

    const types = listEvents(db, run.id).map((e) => e.type);
    expect(types).toEqual(['operation.intended', 'operation.dispatched', 'operation.completed']);
    expect(listEvents(db, run.id).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('rejects late receipts from a superseded generation and records the rejection', () => {
    const { run, task } = seedRunAndTask(state);
    const db = state.store.db;
    const op = recordIntent(db, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: {} });
    markDispatched(db, op.id);

    expect(beginNewGeneration(db, task.id)).toBe(2);
    expect(getTask(db, task.id).current_generation).toBe(2);

    expect(() => recordReceipt(db, op.id, { outcome: 'completed', receipt: { exitCode: 0 } })).toThrow(StaleGenerationError);
    expect(listOpenOperations(db, run.id).map((o) => o.id)).toEqual([op.id]); // still open, never marked completed
    const rejected = listEvents(db, run.id).find((e) => e.type === 'operation.receipt_rejected');
    expect(rejected?.payload).toMatchObject({ operationId: op.id, reportedGeneration: 1, currentGeneration: 2, reason: 'stale_generation' });

    // A reporter that claims the wrong generation is rejected even before the task check.
    const fresh = recordIntent(db, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: {} });
    expect(fresh.generation).toBe(2);
    expect(() => recordReceipt(db, fresh.id, { outcome: 'completed', receipt: {}, generation: 1 })).toThrow(StaleGenerationError);
    expect(recordReceipt(db, fresh.id, { outcome: 'completed', receipt: {}, generation: 2 }).state).toBe('completed');
  });

  it('keeps uncertain outcomes open until reconciliation resolves them', () => {
    const { run, task } = seedRunAndTask(state);
    const db = state.store.db;
    const op = recordIntent(db, { runId: run.id, taskId: task.id, kind: 'spawn_worker', intent: {} });
    markDispatched(db, op.id);
    const uncertain = markUncertain(db, op.id, 'coordinator restarted after dispatch');
    expect(uncertain.state).toBe('uncertain');
    expect(uncertain.uncertainOutcome).toBe(true);
    expect(listOpenOperations(db, run.id).map((o) => o.state)).toEqual(['uncertain']);
    const resolved = recordReceipt(db, op.id, { outcome: 'failed', receipt: { reason: 'process not found' } });
    expect(resolved.state).toBe('failed');
    expect(listEvents(db, run.id).map((e) => e.type)).toContain('operation.reconciled');
  });

  it('rolls back the whole transaction when a nested step fails', () => {
    const { run, task } = seedRunAndTask(state);
    const db = state.store.db;
    const committed: string[] = [];
    expect(() =>
      withTransaction(db, (tx) => {
        recordIntent(db, { runId: run.id, taskId: task.id, kind: 'a', intent: {} });
        tx.onCommit(() => committed.push('outer'));
        withTransaction(db, () => {
          recordIntent(db, { runId: run.id, taskId: task.id, kind: 'b', intent: {} });
          throw new Error('boom');
        });
      }),
    ).toThrow('boom');
    expect(listOpenOperations(db, run.id)).toEqual([]);
    expect(listEvents(db, run.id)).toEqual([]);
    expect(committed).toEqual([]);

    withTransaction(db, (tx) => {
      recordIntent(db, { runId: run.id, taskId: task.id, kind: 'c', intent: {} });
      tx.onCommit(() => committed.push('after-commit'));
      expect(committed).toEqual([]);
    });
    expect(committed).toEqual(['after-commit']);
  });
});

describe('records enforce lifecycle transitions and immutable snapshots', () => {
  it('refuses illegal task transitions and requires wait reasons', () => {
    const { task } = seedRunAndTask(state);
    const db = state.store.db;
    expect(() => transitionTask(db, task.id, 'accepted')).toThrow(IllegalTransitionError);
    expect(getTask(db, task.id).state).toBe('pending');
    transitionTask(db, task.id, 'ready');
    transitionTask(db, task.id, 'running');
    expect(() => transitionTask(db, task.id, 'accepted')).toThrow(IllegalTransitionError);
    expect(() => transitionTask(db, task.id, 'waiting')).toThrow(/explicit wait reason/);
    const waiting = transitionTask(db, task.id, 'waiting', { waitReason: 'peer' });
    expect(waiting.wait_reason).toBe('peer');
    const running = transitionTask(db, task.id, 'running');
    expect(running.wait_reason).toBeNull();
  });

  it('supersedes open attempts when a new generation begins and keeps snapshots immutable', () => {
    const { task } = seedRunAndTask(state);
    const db = state.store.db;
    const config = validateAgentConfig(JSON.parse(readFileSync('fixtures/agents/example.json', 'utf8')));
    const snapshot = computeAgentSnapshot(config, 'engineer');
    upsertAgentSnapshot(db, snapshot);
    upsertAgentSnapshot(db, snapshot); // idempotent
    expect(() => upsertAgentSnapshot(db, { ...snapshot, canonicalJson: '{"tampered":true}' })).toThrow(/immutable/);

    const attempt = insertAttempt(db, { taskId: task.id, agentSnapshotHash: snapshot.hash });
    expect(attempt.generation).toBe(1);
    beginNewGeneration(db, task.id);
    expect(getAttempt(db, attempt.id).state).toBe('superseded');
    const next = insertAttempt(db, { taskId: task.id, agentSnapshotHash: snapshot.hash });
    expect(next.generation).toBe(2);
  });
});
