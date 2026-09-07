import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEvents } from '../../src/storage/events.js';
import { getOperation, recordIntent, recordReceipt } from '../../src/storage/operations.js';
import { getAttempt, getRun, getTask, transitionRun } from '../../src/storage/records.js';
import { admitReceipt, listRunAttempts, reconcileRun } from '../../src/recovery/reconcile.js';
import { resumeRun } from '../../src/recovery/resume.js';
import { WORKER_PROCESS, openTempState, seedCrashedRun, type TempState } from './support.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

const alive = () => 'alive' as const;
const dead = () => 'dead' as const;

describe('AT10: crash after the dispatch intent and before the receipt', () => {
  it('reconciles actual state and refuses to launch a competing writer while the recorded worker is alive', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    const db = state.store.db;

    const report = reconcileRun(db, crashed.run.id, { probeProcess: alive });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.disposition).toBe('ambiguous');
    expect(report.findings[0]?.worker).toBe('alive');
    expect(report.blocked).toBe(true);

    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: alive });
    expect(plan.blocked).toBe(true);
    expect(plan.steps.map((s) => s.action)).toEqual(['isolate']);
    expect(plan.userActions[0]).toMatch(/isolated/);

    // Nothing was spawned and no new generation exists.
    expect(listRunAttempts(db, crashed.run.id)).toHaveLength(1);
    expect(getTask(db, crashed.task.id).current_generation).toBe(1);
    // The operation stays open: it is the evidence a human needs.
    expect(getOperation(db, crashed.operation.id).state).toBe('dispatched');
    // The run is not put back into `running` while a writer may exist.
    expect(getRun(db, crashed.run.id).state).toBe('interrupted');
    expect(listEvents(db, crashed.run.id).map((e) => e.type)).toContain('recovery.attempt_isolated');
  });

  it('classifies a dispatched effect with no recorded worker identity as ambiguous rather than replaceable', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: false });
    const report = reconcileRun(state.store.db, crashed.run.id, { probeProcess: dead });
    expect(report.findings[0]?.worker).toBe('never_recorded');
    expect(report.findings[0]?.disposition).toBe('ambiguous');
    expect(report.findings[0]?.reason).toMatch(/no worker process identity/);
  });

  it('treats an intent that was never dispatched as replaceable and closes it as failed, not uncertain', () => {
    const crashed = seedCrashedRun(state, { dispatched: false, running: false });
    const db = state.store.db;

    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead });
    expect(plan.blocked).toBe(false);
    expect(plan.steps.map((s) => s.action)).toEqual(['replace']);

    const closed = getOperation(db, crashed.operation.id);
    expect(closed.state).toBe('failed');
    expect(closed.receipt?.['reason']).toBe('coordinator_crashed_before_dispatch');

    const attempts = listRunAttempts(db, crashed.run.id);
    expect(attempts).toHaveLength(2);
    expect(getTask(db, crashed.task.id).current_generation).toBe(2);
    expect(plan.steps[0]?.newGeneration).toBe(2);
    expect(getRun(db, crashed.run.id).state).toBe('running');
  });

  it('marks a dispatched effect whose worker is gone as uncertain, never as completed', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    const db = state.store.db;

    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead });
    expect(plan.steps.map((s) => s.action)).toEqual(['replace']);

    const closed = getOperation(db, crashed.operation.id);
    expect(closed.state).toBe('uncertain');
    expect(closed.uncertainOutcome).toBe(true);
    expect(getAttempt(db, crashed.attempt.id).state).toBe('superseded');
    expect(getAttempt(db, crashed.attempt.id).uncertain_outcome).toBe(1);
  });

  it('reconnects instead of replacing when the adapter can rejoin the dead worker session', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS, sessionId: 'thread-77' });
    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead, sessionResumable: () => true });
    expect(plan.steps.map((s) => s.action)).toEqual(['reconnect']);
    expect(plan.steps[0]?.sessionId).toBe('thread-77');
    // A reconnect keeps the attempt; it does not burn a generation.
    expect(getTask(state.store.db, crashed.task.id).current_generation).toBe(1);
  });
});

describe('AT11: results from superseded generations', () => {
  it('cannot replace the current result', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    const db = state.store.db;
    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead });
    const replacement = plan.steps[0];
    expect(replacement?.newAttemptId).not.toBeNull();

    // The new generation does its work and records the current result.
    const current = recordIntent(db, {
      runId: crashed.run.id,
      taskId: crashed.task.id,
      attemptId: replacement?.newAttemptId ?? null,
      kind: 'dispatch_worker',
      intent: { generation: 2 },
    });
    recordReceipt(db, current.id, { outcome: 'completed', receipt: { candidateRevision: 'cafebabe' } });

    // The old worker calls back late, from generation 1.
    const admission = admitReceipt(db, crashed.operation.id, { outcome: 'completed', receipt: { candidateRevision: 'deadbeef' } });
    expect(admission.accepted).toBe(false);
    expect(admission.operationGeneration).toBe(1);
    expect(admission.currentGeneration).toBe(2);

    // The current result is untouched and the rejection is recorded.
    expect(getOperation(db, current.id).receipt).toEqual({ candidateRevision: 'cafebabe' });
    expect(getOperation(db, crashed.operation.id).state).toBe('uncertain');
    expect(listEvents(db, crashed.run.id).map((e) => e.type)).toContain('operation.receipt_rejected');
  });
});

describe('run-level guards', () => {
  it('never silently resurrects a cancelled run', () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    const db = state.store.db;
    transitionRun(db, crashed.run.id, 'cancelled');

    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead });
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReason).toMatch(/cancelled/);
    expect(plan.steps.every((s) => s.action === 'refuse')).toBe(true);
    expect(getRun(db, crashed.run.id).state).toBe('cancelled');
    // No ownership was taken and no generation was created.
    expect(getRun(db, crashed.run.id).ownership_epoch).toBe(0);
    expect(getTask(db, crashed.task.id).current_generation).toBe(1);
    expect(listEvents(db, crashed.run.id).map((e) => e.type)).toContain('recovery.resume_refused');
  });

  it('preserves completed work of a finished run and reports nothing to resume', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    const db = state.store.db;
    recordReceipt(db, crashed.operation.id, { outcome: 'completed', receipt: { candidateRevision: 'abc123' } });
    transitionRun(db, crashed.run.id, 'ready_for_review');

    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: alive });
    expect(plan.complete).toBe(true);
    expect(plan.blocked).toBe(false);
    expect(plan.steps.map((s) => s.action)).toEqual(['preserve']);
    expect(getOperation(db, crashed.operation.id).receipt).toEqual({ candidateRevision: 'abc123' });
  });

  it('takes a new ownership epoch so callbacks from the previous owner are stale', () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    const before = getRun(state.store.db, crashed.run.id).ownership_epoch;
    const { plan } = resumeRun({ runId: crashed.run.id, store: state.store, probeProcess: dead });
    expect(plan.ownershipEpoch).toBe(before + 1);
    expect(getRun(state.store.db, crashed.run.id).ownership_epoch).toBe(before + 1);
  });
});
