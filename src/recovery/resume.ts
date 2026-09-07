/**
 * `resumeRun` — the resume half of FR039, on top of FR054 reconciliation.
 *
 * Order matters and is the whole point:
 *
 *   1. acquire exclusive ownership (the coordinator lock) — nothing is
 *      inspected on the assumption that we are alone;
 *   2. reconcile: inspect persisted operations, attempts, worker process
 *      identities, sessions and artifacts;
 *   3. only then decide, and record the decision as a plan before acting on
 *      it. A new attempt generation is created only where the reconciliation
 *      proved that replacing is safe.
 *
 * Completed work is preserved: settled attempts, their artifacts and their
 * check receipts are never re-run and never discarded. A cancelled run is
 * never silently resurrected — resuming one is refused and says so.
 */
import { nowIso } from '../core/ids.js';
import type { ProcessIdentity, ProcessIdentityStatus } from '../core/process.js';
import { openStateStore, StateNotFoundError, type StateStore } from '../storage/db.js';
import { appendEvent } from '../storage/events.js';
import { createStatePaths, resolveStateRoot } from '../storage/paths.js';
import {
  beginNewGeneration,
  bumpOwnershipEpoch,
  findRun,
  getTask,
  insertAttempt,
  listTasks,
  transitionRun,
  transitionTask,
  type AttemptRow,
  type RunRow,
} from '../storage/records.js';
import { applyReconciliation, listTaskAttempts, reconcileRun, type AttemptFinding, type ReconciliationReport } from './reconcile.js';

export type ResumeAction = 'reconnect' | 'replace' | 'preserve' | 'isolate' | 'refuse';

export interface ResumeStep {
  readonly action: ResumeAction;
  readonly taskId: string;
  /** The attempt the step is about (the interrupted one). */
  readonly attemptId: string;
  readonly generation: number;
  /** For `replace`: the freshly created attempt and its generation. */
  readonly newAttemptId: string | null;
  readonly newGeneration: number | null;
  /** For `reconnect`: the session the runtime must be asked to rejoin. */
  readonly sessionId: string | null;
  readonly runtimeId: string | null;
  readonly workspacePath: string | null;
  readonly reason: string;
}

export interface ResumePlan {
  readonly runId: string;
  readonly runState: RunRow['state'];
  /** The epoch this coordinator owns the run under; callbacks from earlier epochs are stale. */
  readonly ownershipEpoch: number;
  readonly reconciliation: ReconciliationReport;
  readonly steps: ReadonlyArray<ResumeStep>;
  /** True when execution must not continue until a human decides. */
  readonly blocked: boolean;
  readonly blockedReason: string | null;
  /** Specific actions for the user, when there are any. */
  readonly userActions: ReadonlyArray<string>;
  /** True when there is nothing left to do: the run already reached a terminal state. */
  readonly complete: boolean;
  readonly preservedAttemptIds: ReadonlyArray<string>;
  readonly createdAt: string;
}

export class ResumeError extends Error {
  readonly code: 'unknown_run' | 'state_unavailable' | 'ownership_unavailable';

  constructor(code: ResumeError['code'], message: string) {
    super(message);
    this.name = 'ResumeError';
    this.code = code;
  }
}

export interface ResumeRunInput {
  readonly runId: string;
  /** State root to resume under. Ignored when `store` is given. */
  readonly stateRoot?: string;
  /** An already-owned mutating store (the caller holds the lock). Used by tests and by the orchestrator. */
  readonly store?: StateStore;
  readonly probeProcess?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  readonly sessionResumable?: (attempt: AttemptRow) => boolean;
  readonly now?: string;
}

export interface ResumeRunResult {
  readonly plan: ResumePlan;
  /** The store the plan is owned under; the caller closes it (releasing the lock) when it is done. */
  readonly store: StateStore;
  /** True when this call opened the store and the caller must close it. */
  readonly ownsStore: boolean;
}

const TERMINAL_RUN_STATES: ReadonlySet<RunRow['state']> = new Set<RunRow['state']>(['ready_for_review', 'failed']);

/**
 * Reconcile a run and produce the plan for continuing it.
 *
 * Returns the plan *and* the owned store: continuing execution has to happen
 * under the same ownership, so the lock is not released here.
 */
export function resumeRun(input: ResumeRunInput): ResumeRunResult {
  const now = input.now ?? nowIso();
  const provided = input.store;
  let store: StateStore;
  if (provided !== undefined) {
    if (provided.mode !== 'mutating') throw new ResumeError('ownership_unavailable', 'resume needs a mutating state store; a read-only store cannot take ownership of a run');
    store = provided;
  } else {
    const paths = createStatePaths(resolveStateRoot(input.stateRoot));
    try {
      store = openStateStore(paths, { mode: 'mutating' });
    } catch (error) {
      if (error instanceof StateNotFoundError) throw new ResumeError('state_unavailable', error.message);
      throw error;
    }
  }
  const ownsStore = provided === undefined;

  try {
    // Ownership is proven before anything is read for a decision.
    store.lock?.assertOwnership();

    const db = store.db;
    const run = findRun(db, input.runId);
    if (run === null) throw new ResumeError('unknown_run', `run ${input.runId} not found under ${store.paths.root}`);

    const reconciliation = reconcileRun(db, input.runId, {
      ...(input.probeProcess !== undefined ? { probeProcess: input.probeProcess } : {}),
      ...(input.sessionResumable !== undefined ? { sessionResumable: input.sessionResumable } : {}),
      now,
    });

    appendEvent(db, {
      runId: input.runId,
      type: 'recovery.reconciled',
      payload: {
        runState: reconciliation.runState,
        attempts: reconciliation.findings.length,
        openOperations: reconciliation.openOperations.length,
        dispositions: countDispositions(reconciliation),
        blocked: reconciliation.blocked,
      },
      timestamp: now,
    });

    // A cancelled run is never silently resurrected.
    if (run.state === 'cancelled') {
      const plan = refusalPlan(reconciliation, run, now, 'the run was cancelled', [
        `run ${input.runId} was cancelled; start a new run rather than resuming it — resuming would silently resurrect work someone deliberately stopped`,
      ]);
      appendEvent(db, { runId: input.runId, type: 'recovery.resume_refused', payload: { reason: plan.blockedReason }, timestamp: now });
      return { plan, store, ownsStore };
    }

    if (TERMINAL_RUN_STATES.has(run.state)) {
      const preserved = reconciliation.findings.map((finding) => finding.attemptId);
      const plan: ResumePlan = {
        runId: input.runId,
        runState: run.state,
        ownershipEpoch: run.ownership_epoch,
        reconciliation,
        steps: reconciliation.findings.map((finding) => step('preserve', finding, { reason: `run already ${run.state}; recorded work is preserved` })),
        blocked: false,
        blockedReason: null,
        userActions: [],
        complete: true,
        preservedAttemptIds: preserved,
        createdAt: now,
      };
      return { plan, store, ownsStore };
    }

    // New ownership epoch: anything still holding the previous epoch is stale.
    const ownershipEpoch = bumpOwnershipEpoch(db, input.runId, now);
    appendEvent(db, { runId: input.runId, type: 'recovery.ownership_taken', payload: { ownershipEpoch, previousEpoch: run.ownership_epoch }, timestamp: now });

    // The crash is recorded as an interruption before anything replaces it.
    if (run.state === 'running' || run.state === 'waiting') {
      try {
        transitionRun(db, input.runId, 'interrupted', now);
      } catch {
        // Already interrupted, or moved on: not a reason to fail recovery.
      }
    }

    applyReconciliation(db, reconciliation, { now });

    const steps: ResumeStep[] = [];
    const preserved: string[] = [];
    const userActions: string[] = [];

    for (const finding of reconciliation.findings) {
      switch (finding.disposition) {
        case 'settled':
          preserved.push(finding.attemptId);
          steps.push(step('preserve', finding, { reason: finding.reason }));
          break;
        case 'ambiguous':
          steps.push(step('isolate', finding, { reason: finding.reason }));
          userActions.push(
            `attempt ${finding.attemptId} of task ${finding.taskId} is isolated: ${finding.reason}. ` +
              `Inspect ${finding.workspacePath ?? 'its workspace'}${finding.workerProcess === null ? '' : ` and process ${finding.workerProcess.pid}`}, ` +
              'then either stop that worker and resume again, or start a new run.',
          );
          break;
        case 'resumable':
          steps.push(step('reconnect', finding, { reason: finding.reason }));
          break;
        case 'replaceable': {
          const replacement = createReplacementAttempt(store, finding, now);
          steps.push(
            step('replace', finding, {
              reason: finding.reason,
              newAttemptId: replacement.id,
              newGeneration: replacement.generation,
              workspacePath: replacement.workspace_path,
            }),
          );
          break;
        }
      }
    }

    const blocked = reconciliation.blocked;
    const plan: ResumePlan = {
      runId: input.runId,
      runState: 'interrupted',
      ownershipEpoch,
      reconciliation,
      steps,
      blocked,
      blockedReason: reconciliation.blockedReason,
      userActions,
      complete: false,
      preservedAttemptIds: preserved,
      createdAt: now,
    };

    appendEvent(db, {
      runId: input.runId,
      type: 'recovery.plan',
      payload: { ownershipEpoch, blocked, steps: steps.map((s) => ({ action: s.action, taskId: s.taskId, attemptId: s.attemptId, newAttemptId: s.newAttemptId })) },
      timestamp: now,
    });

    // Only an unblocked plan puts the run back into `running`; a blocked one
    // stays interrupted so no other code path treats it as live.
    if (!blocked) {
      try {
        transitionRun(db, input.runId, 'running', now);
      } catch {
        // Left interrupted: the caller sees the state in the plan.
      }
    }

    return { plan: { ...plan, runState: findRun(db, input.runId)?.state ?? 'interrupted' }, store, ownsStore };
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
}

function countDispositions(report: ReconciliationReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of report.findings) counts[finding.disposition] = (counts[finding.disposition] ?? 0) + 1;
  return counts;
}

function step(
  action: ResumeAction,
  finding: AttemptFinding,
  overrides: { reason: string; newAttemptId?: string; newGeneration?: number; workspacePath?: string | null },
): ResumeStep {
  return {
    action,
    taskId: finding.taskId,
    attemptId: finding.attemptId,
    generation: finding.generation,
    newAttemptId: overrides.newAttemptId ?? null,
    newGeneration: overrides.newGeneration ?? null,
    sessionId: finding.sessionId,
    runtimeId: finding.runtimeId,
    workspacePath: overrides.workspacePath ?? finding.workspacePath,
    reason: overrides.reason,
  };
}

function refusalPlan(reconciliation: ReconciliationReport, run: RunRow, now: string, reason: string, userActions: ReadonlyArray<string>): ResumePlan {
  return {
    runId: run.id,
    runState: run.state,
    ownershipEpoch: run.ownership_epoch,
    reconciliation,
    steps: reconciliation.findings.map((finding) => step('refuse', finding, { reason })),
    blocked: true,
    blockedReason: reason,
    userActions,
    complete: false,
    preservedAttemptIds: reconciliation.findings.filter((f) => f.disposition === 'settled').map((f) => f.attemptId),
    createdAt: now,
  };
}

/**
 * Create the attempt that replaces an interrupted one, in a brand new
 * generation. Superseding the old generation is what makes late results from
 * it refusable; the new attempt reuses the same agent snapshot, so the
 * replacement is a retry of the same binding, not a silent re-binding.
 */
function createReplacementAttempt(store: StateStore, finding: AttemptFinding, now: string): AttemptRow {
  const db = store.db;
  const previous = listTaskAttempts(db, finding.taskId).find((attempt) => attempt.id === finding.attemptId);
  const snapshotHash = previous?.agent_snapshot_hash ?? '';
  const generation = beginNewGeneration(db, finding.taskId, now);
  const attempt = insertAttempt(db, {
    taskId: finding.taskId,
    agentSnapshotHash: snapshotHash,
    ...(previous?.runtime_id != null ? { runtimeId: previous.runtime_id } : {}),
    now,
  });
  const run = getTask(db, finding.taskId).run_id;
  const workspacePath = store.paths.workspaceDir(run, finding.taskId, attempt.id);
  db.prepare('UPDATE attempts SET workspace_path = ?, updated_at = ? WHERE id = ?').run(workspacePath, now, attempt.id);

  // The task itself has to be dispatchable again. `running -> ready` is not a
  // legal transition, so an interrupted task passes through `waiting` first,
  // with the reason recorded rather than implied.
  const task = getTask(db, finding.taskId);
  if (task.state === 'running' || task.state === 'validating') {
    try {
      transitionTask(db, finding.taskId, 'waiting', { waitReason: 'pause', now });
    } catch {
      // fall through; the caller sees the task state in the plan
    }
  }
  const afterWait = getTask(db, finding.taskId);
  if (afterWait.state === 'waiting' || afterWait.state === 'failed' || afterWait.state === 'pending') {
    try {
      transitionTask(db, finding.taskId, 'ready', { now });
    } catch {
      // fall through
    }
  }

  appendEvent(db, {
    runId: run,
    taskId: finding.taskId,
    attemptId: attempt.id,
    type: 'recovery.attempt_replaced',
    payload: { previousAttemptId: finding.attemptId, previousGeneration: finding.generation, generation, workspacePath },
    timestamp: now,
  });
  return { ...attempt, workspace_path: workspacePath, generation };
}

/** Tasks of a run in a shape a plan report can print. */
export function planSummaryLines(plan: ResumePlan): string[] {
  const lines = [
    `run ${plan.runId}: ${plan.runState} (ownership epoch ${plan.ownershipEpoch})`,
    `reconciled ${plan.reconciliation.findings.length} attempt${plan.reconciliation.findings.length === 1 ? '' : 's'}, ${plan.reconciliation.openOperations.length} open operation${plan.reconciliation.openOperations.length === 1 ? '' : 's'}`,
  ];
  for (const s of plan.steps) {
    lines.push(
      `  ${s.action} ${s.attemptId} (task ${s.taskId}, gen ${s.generation}${s.newGeneration === null ? '' : ` -> ${s.newGeneration} as ${s.newAttemptId}`}) — ${s.reason}`,
    );
  }
  if (plan.blockedReason !== null) lines.push(`blocked: ${plan.blockedReason}`);
  for (const action of plan.userActions) lines.push(`action required: ${action}`);
  return lines;
}

/** All tasks of the run, for callers that need to continue execution from the plan. */
export function planTasks(store: StateStore, plan: ResumePlan): ReturnType<typeof listTasks> {
  return listTasks(store.db, plan.runId);
}
