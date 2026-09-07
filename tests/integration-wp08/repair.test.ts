import { afterAll, describe, expect, it } from 'vitest';
import { RepairSession, RepairSessionError, failureEvidenceFromReceipt } from '../../src/integration/repair.js';
import { cleanupAll, makeReceipt } from './support.js';

afterAll(() => cleanupAll());

const CRITERIA = [{ id: 'tests', description: 'the pagination suite passes' }];

function failingReceipt(revision: string) {
  return makeReceipt({
    criterionId: 'tests',
    outcome: 'failed',
    exitCode: 1,
    command: 'npm',
    args: ['test'],
    cwd: '.',
    candidate: { repoRoot: '/repo', revision, patchHash: null },
    stdoutPath: '/logs/stdout.log',
    stderrPath: '/logs/stderr.log',
    stdoutTail: 'not ok 1 - paginate keeps the remainder',
    stderrTail: 'AssertionError: expected 3 to equal 4',
  });
}

describe('bounded repair loop (FR052)', () => {
  it('drives exactly one repair and then reports the budget as exhausted', () => {
    const session = new RepairSession({
      runId: 'run1',
      taskId: 'task-a',
      originAttemptId: 'attempt-1',
      maxRepairAttempts: 1,
      criteria: CRITERIA,
      mintAttemptId: (n) => `attempt-repair-${n}`,
    });

    const first = session.next({ receipts: [failingReceipt('rev-1')], candidateRevision: 'rev-1' });
    expect(first.kind).toBe('repair');
    if (first.kind !== 'repair') throw new Error('unreachable');
    expect(first.attempt.attemptNumber).toBe(1);
    expect(first.attempt.identity.attemptId).toBe('attempt-repair-1');
    expect(first.attempt.identity.supersedesAttemptId).toBe('attempt-1');
    expect(first.attempt.budget).toEqual({ maxRepairAttempts: 1, used: 1, remaining: 0, exhausted: true });

    const second = session.next({ receipts: [failingReceipt('rev-2')], candidateRevision: 'rev-2' });
    expect(second.kind).toBe('exhausted');
    if (second.kind !== 'exhausted') throw new Error('unreachable');
    expect(second.reason).toContain('exhausted after 1 repair attempt(s) (limit 1)');
    expect(second.evidence).toHaveLength(1);
    expect(session.attempts).toHaveLength(1);
  });

  it('carries the exact failure evidence into the repair attempt', () => {
    const receipt = failingReceipt('rev-1');
    const evidence = failureEvidenceFromReceipt(receipt, CRITERIA[0]);
    expect(evidence).toMatchObject({
      criterionId: 'tests',
      criterionDescription: 'the pagination suite passes',
      command: 'npm',
      args: ['test'],
      exitCode: 1,
      outcome: 'failed',
      candidateRevision: 'rev-1',
      receiptId: receipt.id,
      stdoutPath: '/logs/stdout.log',
      stderrPath: '/logs/stderr.log',
      evidenceProvenance: 'verifier_executed',
    });
    expect(evidence.outputExcerpt).toContain('not ok 1 - paginate keeps the remainder');
    expect(evidence.outputExcerpt).toContain('AssertionError: expected 3 to equal 4');

    const session = new RepairSession({ runId: 'run1', taskId: 'task-a', originAttemptId: 'attempt-1', maxRepairAttempts: 2, criteria: CRITERIA });
    const decision = session.next({ receipts: [receipt], candidateRevision: 'rev-1' });
    if (decision.kind !== 'repair') throw new Error('expected a repair');
    expect(decision.attempt.instructions).toContain('npm test');
    expect(decision.attempt.instructions).toContain('exit 1');
    expect(decision.attempt.instructions).toContain('AssertionError: expected 3 to equal 4');
    expect(decision.attempt.instructions).toContain('ran against revision: rev-1');
    expect(decision.attempt.instructions).toContain('Do not modify the checks themselves.');
  });

  it('creates a new candidate identity and invalidates the prior candidate’s results', () => {
    const session = new RepairSession({ runId: 'run1', taskId: 'task-a', originAttemptId: 'attempt-1', maxRepairAttempts: 2, criteria: CRITERIA });
    const stale = failingReceipt('rev-1');
    const decision = session.next({ receipts: [stale], candidateRevision: 'rev-1' });
    if (decision.kind !== 'repair') throw new Error('expected a repair');

    expect(decision.attempt.invalidatedReceiptIds).toEqual([stale.id]);
    expect(session.isInvalidated(stale.id)).toBe(true);
    expect(session.currentAttemptId).toBe(decision.attempt.identity.attemptId);
    expect(session.currentAttemptId).not.toBe('attempt-1');
    // The invalidated receipt no longer counts, even for its own revision.
    expect(session.validReceipts([stale], 'rev-1')).toEqual([]);
    expect(() => session.next({ receipts: [stale], candidateRevision: 'rev-1' })).toThrow(RepairSessionError);
  });

  it('reports satisfaction without spending budget when the checks pass', () => {
    const session = new RepairSession({ runId: 'run1', taskId: 'task-a', originAttemptId: 'attempt-1', maxRepairAttempts: 2, criteria: CRITERIA });
    const decision = session.next({
      receipts: [makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: 'rev-1', patchHash: null } })],
      candidateRevision: 'rev-1',
    });
    expect(decision.kind).toBe('satisfied');
    expect(session.budget.used).toBe(0);
  });

  it('reports exhaustion immediately when the budget is zero', () => {
    const session = new RepairSession({ runId: 'run1', taskId: 'task-a', originAttemptId: 'attempt-1', maxRepairAttempts: 0, criteria: CRITERIA });
    const decision = session.next({ receipts: [failingReceipt('rev-1')], candidateRevision: 'rev-1' });
    expect(decision.kind).toBe('exhausted');
    if (decision.kind !== 'exhausted') throw new Error('unreachable');
    expect(decision.reason).toContain('budget for task task-a is 0');
  });

  it('ignores receipts about a different revision rather than deciding on them', () => {
    const session = new RepairSession({ runId: 'run1', taskId: 'task-a', originAttemptId: 'attempt-1', maxRepairAttempts: 2, criteria: CRITERIA });
    expect(() => session.next({ receipts: [failingReceipt('rev-other')], candidateRevision: 'rev-1' })).toThrow(/no valid check receipts/);
  });
});
