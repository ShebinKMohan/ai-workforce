/**
 * Crash reconciliation (FR054).
 *
 * A coordinator that restarts after a crash knows one thing for certain: what
 * it persisted. It does not know whether the effects it intended actually
 * happened. So reconciliation *inspects* before it decides — persisted
 * operations, attempts, recorded worker process identities, sessions and
 * artifacts — and classifies every interrupted attempt as
 *
 * - `resumable`   the worker is gone, its session is nameable and the adapter
 *                 can rejoin it; reconnect rather than start over;
 * - `replaceable` nothing is running and nothing can be rejoined, so a new
 *                 attempt generation may safely take over;
 * - `ambiguous`   a writer may still exist, or one may have existed and left
 *                 no identity behind. Nothing is spawned: the old work is
 *                 isolated and the user is asked.
 * - `settled`     the attempt already reached a terminal state; its work is
 *                 preserved and never re-run.
 *
 * The asymmetry is deliberate. Wrongly calling something replaceable spawns a
 * second writer into a workspace a live process is still writing; wrongly
 * calling something ambiguous only costs a question. Everything unproven is
 * therefore ambiguous.
 *
 * Nothing in this file mutates state. `applyReconciliation` (called by
 * `resume.ts` under the coordinator lock) is where the writes happen.
 */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../core/ids.js';
import { matchProcessIdentity, type ProcessIdentity, type ProcessIdentityStatus } from '../core/process.js';
import { listArtifacts } from '../storage/artifacts.js';
import { appendEvent } from '../storage/events.js';
import {
  StaleGenerationError,
  listOpenOperations,
  markUncertain,
  recordReceipt,
  type OperationRecord,
  type ReceiptOutcome,
} from '../storage/operations.js';
import { attemptProcessIdentity, getRun, getTask, listTasks, transitionAttempt, type AttemptRow, type RunRow, type TaskRow } from '../storage/records.js';

export type AttemptDisposition = 'resumable' | 'replaceable' | 'ambiguous' | 'settled';

/** How the recorded worker process compares with what is running now. */
export type WorkerStatus = ProcessIdentityStatus | 'never_recorded';

export interface AttemptFinding {
  readonly attemptId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly attemptState: AttemptRow['state'];
  readonly runtimeId: string | null;
  readonly sessionId: string | null;
  readonly workspacePath: string | null;
  readonly worker: WorkerStatus;
  readonly workerProcess: ProcessIdentity | null;
  /** Operations for this attempt that never reached a receipt. */
  readonly openOperationIds: ReadonlyArray<string>;
  readonly dispatched: boolean;
  readonly artifactCount: number;
  readonly disposition: AttemptDisposition;
  readonly reason: string;
  /** True when a human has to decide before anything else happens. */
  readonly requiresUserDecision: boolean;
}

export interface ReconciliationReport {
  readonly runId: string;
  readonly runState: RunRow['state'];
  readonly ownershipEpoch: number;
  readonly observedAt: string;
  readonly findings: ReadonlyArray<AttemptFinding>;
  /** Open operations of the run, including any not bound to an attempt. */
  readonly openOperations: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly state: OperationRecord['state']; readonly generation: number; readonly taskId: string | null; readonly attemptId: string | null }>;
  readonly ambiguous: ReadonlyArray<AttemptFinding>;
  /** True when the run itself must not be resumed without an explicit instruction. */
  readonly blocked: boolean;
  readonly blockedReason: string | null;
}

export interface ReconcileOptions {
  /**
   * How to check a recorded worker process. Injectable so tests are
   * deterministic; defaults to the real pid + start-time comparison.
   */
  readonly probeProcess?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  /**
   * Whether the session of a dead worker can be rejoined by its adapter.
   * Defaults to `false`: without evidence that an adapter can resume, the
   * honest answer is "replace", not "reconnect".
   */
  readonly sessionResumable?: (attempt: AttemptRow) => boolean;
  readonly now?: string;
}

const OPEN_ATTEMPT_STATES: ReadonlySet<AttemptRow['state']> = new Set<AttemptRow['state']>(['pending', 'running', 'interrupted']);

export function listRunAttempts(db: DatabaseSync, runId: string): AttemptRow[] {
  return db.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at, id').all(runId) as unknown as AttemptRow[];
}

export function listTaskAttempts(db: DatabaseSync, taskId: string): AttemptRow[] {
  return db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY generation, created_at, id').all(taskId) as unknown as AttemptRow[];
}

/**
 * Inspect the persisted state of a run and classify every attempt. Read-only:
 * safe to call before ownership is proven, and safe to call twice.
 */
export function reconcileRun(db: DatabaseSync, runId: string, options: ReconcileOptions = {}): ReconciliationReport {
  const now = options.now ?? nowIso();
  const probe = options.probeProcess ?? ((identity: ProcessIdentity) => matchProcessIdentity(identity));
  const resumable = options.sessionResumable ?? (() => false);

  const run = getRun(db, runId);
  const attempts = listRunAttempts(db, runId);
  const openOperations = listOpenOperations(db, runId);
  const artifacts = listArtifacts(db, runId);

  const opsByAttempt = new Map<string, OperationRecord[]>();
  for (const op of openOperations) {
    if (op.attemptId === null) continue;
    const bucket = opsByAttempt.get(op.attemptId) ?? [];
    bucket.push(op);
    opsByAttempt.set(op.attemptId, bucket);
  }
  const artifactCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.attemptId === null) continue;
    artifactCounts.set(artifact.attemptId, (artifactCounts.get(artifact.attemptId) ?? 0) + 1);
  }

  const findings = attempts.map((attempt) =>
    classifyAttempt({
      attempt,
      operations: opsByAttempt.get(attempt.id) ?? [],
      artifactCount: artifactCounts.get(attempt.id) ?? 0,
      currentGeneration: getTask(db, attempt.task_id).current_generation,
      probe,
      resumable,
    }),
  );

  const ambiguous = findings.filter((finding) => finding.disposition === 'ambiguous');
  const cancelled = run.state === 'cancelled';
  return {
    runId,
    runState: run.state,
    ownershipEpoch: run.ownership_epoch,
    observedAt: now,
    findings,
    openOperations: openOperations.map((op) => ({ id: op.id, kind: op.kind, state: op.state, generation: op.generation, taskId: op.taskId, attemptId: op.attemptId })),
    ambiguous,
    blocked: cancelled || ambiguous.length > 0,
    blockedReason: cancelled
      ? 'the run was cancelled; a cancelled run is never silently resurrected'
      : ambiguous.length > 0
        ? `${ambiguous.length} interrupted attempt${ambiguous.length === 1 ? '' : 's'} cannot be classified safely; the old work is isolated rather than replaced`
        : null,
  };
}

interface ClassifyInput {
  readonly attempt: AttemptRow;
  readonly operations: ReadonlyArray<OperationRecord>;
  readonly artifactCount: number;
  readonly currentGeneration: number;
  readonly probe: (identity: ProcessIdentity) => ProcessIdentityStatus;
  readonly resumable: (attempt: AttemptRow) => boolean;
}

function classifyAttempt(input: ClassifyInput): AttemptFinding {
  const { attempt, operations, artifactCount, currentGeneration } = input;
  const identity = attemptProcessIdentity(attempt);
  const worker: WorkerStatus = identity === null ? 'never_recorded' : input.probe(identity);
  const dispatched = operations.some((op) => op.state === 'dispatched' || op.state === 'uncertain');
  const openOperationIds = operations.map((op) => op.id);

  const base = {
    attemptId: attempt.id,
    taskId: attempt.task_id,
    generation: attempt.generation,
    attemptState: attempt.state,
    runtimeId: attempt.runtime_id,
    sessionId: attempt.session_id,
    workspacePath: attempt.workspace_path,
    worker,
    workerProcess: identity,
    openOperationIds,
    dispatched,
    artifactCount,
  } as const;

  const settle = (reason: string): AttemptFinding => ({ ...base, disposition: 'settled', reason, requiresUserDecision: false });
  const decide = (disposition: Exclude<AttemptDisposition, 'settled'>, reason: string): AttemptFinding => ({
    ...base,
    disposition,
    reason,
    requiresUserDecision: disposition === 'ambiguous',
  });

  if (!OPEN_ATTEMPT_STATES.has(attempt.state)) {
    return settle(`attempt is ${attempt.state}; its recorded work is preserved and never re-run`);
  }
  if (attempt.generation < currentGeneration) {
    return settle(`attempt belongs to superseded generation ${attempt.generation} (task is at ${currentGeneration}); its results are refused`);
  }

  // A worker that may still be running is never replaced, and never joined by
  // a second writer.
  if (worker === 'alive') {
    return decide(
      'ambiguous',
      `the recorded worker process ${identity?.pid ?? '?'} is still alive; a competing writer must not be spawned into ${attempt.workspace_path ?? 'its workspace'}`,
    );
  }
  if (worker === 'unverifiable') {
    return decide(
      'ambiguous',
      `the recorded worker process ${identity?.pid ?? '?'} exists but cannot be identified as the one this attempt spawned; it is not safe to assume it is gone`,
    );
  }

  // No process identity was ever recorded. If an effect was dispatched, a
  // worker may have been spawned in the window between dispatch and the
  // identity write — exactly the crash this rule exists for (AT10).
  if (worker === 'never_recorded' && dispatched) {
    return decide(
      'ambiguous',
      'an effect was dispatched but no worker process identity was ever recorded; whether a writer exists cannot be established from persisted state',
    );
  }

  if (worker === 'never_recorded' && !dispatched) {
    return decide(
      'replaceable',
      operations.length === 0
        ? 'no effect was dispatched and no worker was recorded; nothing was started for this attempt'
        : 'the intent was persisted but never dispatched, so no worker was ever started',
    );
  }

  // The recorded worker is provably gone (dead, or its pid was reused).
  const gone = worker === 'pid_reused' ? `the recorded worker pid ${identity?.pid ?? '?'} now belongs to a different process` : `the recorded worker process ${identity?.pid ?? '?'} is gone`;
  if (attempt.session_id !== null && input.resumable(attempt)) {
    return decide('resumable', `${gone}, and its session ${attempt.session_id} can be rejoined by the runtime`);
  }
  return decide('replaceable', `${gone}${attempt.session_id === null ? ' and no session was recorded' : `; session ${attempt.session_id} cannot be rejoined`}, so a new generation may take over`);
}

// ---------------------------------------------------------------------------
// Applying a reconciliation (writes; call under the coordinator lock)
// ---------------------------------------------------------------------------

export interface AppliedOperation {
  readonly operationId: string;
  readonly outcome: 'uncertain' | 'failed' | 'left_open';
  readonly reason: string;
}

export interface ReconciliationEffects {
  readonly operations: ReadonlyArray<AppliedOperation>;
  readonly interruptedAttemptIds: ReadonlyArray<string>;
}

/**
 * Close the books on what the crashed coordinator left open, without deciding
 * what happens next.
 *
 * - An intent that was never dispatched is closed as `failed`: no effect can
 *   have happened, so calling it uncertain would be a lie in the other
 *   direction.
 * - A dispatched operation whose worker is gone is closed as `uncertain`: the
 *   effect may or may not have landed, and that is exactly what `uncertain`
 *   means. It is never guessed into `completed`.
 * - Operations belonging to an ambiguous attempt are left open: they are the
 *   evidence a human needs.
 */
export function applyReconciliation(db: DatabaseSync, report: ReconciliationReport, options: { now?: string } = {}): ReconciliationEffects {
  const now = options.now ?? nowIso();
  const operations: AppliedOperation[] = [];
  const interrupted: string[] = [];

  for (const finding of report.findings) {
    if (finding.disposition === 'ambiguous') {
      for (const id of finding.openOperationIds) {
        operations.push({ operationId: id, outcome: 'left_open', reason: 'the attempt is ambiguous; its operations stay open as evidence' });
      }
      appendEvent(db, {
        runId: report.runId,
        taskId: finding.taskId,
        attemptId: finding.attemptId,
        type: 'recovery.attempt_isolated',
        payload: { disposition: finding.disposition, reason: finding.reason, worker: finding.worker, workspacePath: finding.workspacePath, sessionId: finding.sessionId },
        timestamp: now,
      });
      continue;
    }
    if (finding.disposition === 'settled') continue;

    for (const id of finding.openOperationIds) {
      operations.push(closeOperation(db, id, finding.dispatched ? 'uncertain' : 'failed', finding.reason, now));
    }
    // `running` attempts of a crashed coordinator are recorded as interrupted
    // before anything replaces or rejoins them, so the history says what
    // happened rather than jumping straight to the next generation.
    if (finding.attemptState === 'running') {
      try {
        transitionAttempt(db, finding.attemptId, 'interrupted', {
          outcome: { recovered: true, reason: finding.reason },
          uncertain: finding.dispatched,
          now,
        });
        interrupted.push(finding.attemptId);
      } catch {
        // An attempt that moved on under us is not a reason to fail recovery.
      }
    }
    appendEvent(db, {
      runId: report.runId,
      taskId: finding.taskId,
      attemptId: finding.attemptId,
      type: 'recovery.attempt_classified',
      payload: { disposition: finding.disposition, reason: finding.reason, worker: finding.worker, dispatched: finding.dispatched, artifactCount: finding.artifactCount },
      timestamp: now,
    });
  }

  // Operations with no attempt of their own still have to be closed honestly.
  const claimed = new Set(operations.map((op) => op.operationId));
  for (const op of report.openOperations) {
    if (op.attemptId !== null || claimed.has(op.id)) continue;
    operations.push(closeOperation(db, op.id, op.state === 'intended' ? 'failed' : 'uncertain', 'the coordinator that recorded it did not survive', now));
  }

  return { operations, interruptedAttemptIds: interrupted };
}

function closeOperation(db: DatabaseSync, operationId: string, outcome: 'uncertain' | 'failed', reason: string, now: string): AppliedOperation {
  try {
    if (outcome === 'uncertain') {
      markUncertain(db, operationId, `coordinator restarted: ${reason}`, now);
      return { operationId, outcome: 'uncertain', reason };
    }
    recordReceipt(db, operationId, { outcome: 'failed', receipt: { reason: 'coordinator_crashed_before_dispatch', detail: reason }, now });
    return { operationId, outcome: 'failed', reason };
  } catch (error) {
    return { operationId, outcome: 'left_open', reason: `could not close: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Late callbacks from superseded generations
// ---------------------------------------------------------------------------

export interface ReceiptAdmission {
  readonly accepted: boolean;
  readonly reason: string;
  readonly operationGeneration?: number;
  readonly currentGeneration?: number;
}

/**
 * Record a receipt only if it belongs to the current generation.
 *
 * A worker from a superseded generation can still be alive and still call
 * back; its result must never replace the current one. The storage layer
 * already refuses such a write — this turns that refusal into a value the
 * caller can act on, and never lets a stale callback become an exception that
 * crashes the coordinator handling it.
 */
export function admitReceipt(
  db: DatabaseSync,
  operationId: string,
  input: { readonly outcome: ReceiptOutcome; readonly receipt: Record<string, unknown>; readonly generation?: number; readonly now?: string },
): ReceiptAdmission {
  try {
    recordReceipt(db, operationId, {
      outcome: input.outcome,
      receipt: input.receipt,
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return { accepted: true, reason: 'receipt belongs to the current generation' };
  } catch (error) {
    if (error instanceof StaleGenerationError) {
      return {
        accepted: false,
        reason: `receipt from generation ${error.operationGeneration} rejected; the task is at generation ${error.currentGeneration}`,
        operationGeneration: error.operationGeneration,
        currentGeneration: error.currentGeneration,
      };
    }
    return { accepted: false, reason: (error as Error).message };
  }
}

/** Tasks of a run with their current generation, for reports that group by task. */
export function taskGenerations(db: DatabaseSync, runId: string): Map<string, TaskRow> {
  return new Map(listTasks(db, runId).map((task) => [task.id, task]));
}
