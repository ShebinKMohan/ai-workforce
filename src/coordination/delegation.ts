/**
 * Delegation admission control (FR036).
 *
 * `request_task` is a request, not a grant. Every request is checked against
 * the limits recorded on the run row — `maxDelegationDepth` and
 * `maxTasksPerRun` — which are read from storage at decision time. Nothing a
 * peer sends can raise them: the limits never travel in a message body, so
 * there is no field a model could set to widen its own budget.
 *
 * Rejections carry a reason a human can act on.
 */
import type { DatabaseSync } from 'node:sqlite';
import { LimitsSchema, type Limits } from '../core/contracts.js';

/** Guard against a cycle in `parent_task_id` (a corrupted store must not hang the coordinator). */
const MAX_PARENT_WALK = 64;

export type DelegationRejectionCode = 'depth_exceeded' | 'task_budget_exceeded' | 'unknown_run' | 'unknown_task';

export interface DelegationAllowed {
  readonly allowed: true;
  readonly depth: number;
  readonly taskCount: number;
  readonly limits: Limits;
}

export interface DelegationRejected {
  readonly allowed: false;
  readonly code: DelegationRejectionCode;
  readonly reason: string;
  readonly depth: number;
  readonly taskCount: number;
  readonly limits: Limits | null;
}

export type DelegationDecision = DelegationAllowed | DelegationRejected;

/** Limits of a run, parsed from the row the coordinator persisted. */
export function runLimits(db: DatabaseSync, runId: string): Limits | null {
  const row = db.prepare('SELECT limits_json FROM runs WHERE id = ?').get(runId) as { limits_json: string } | undefined;
  if (row === undefined) return null;
  return LimitsSchema.parse(JSON.parse(row.limits_json));
}

/** Depth of a task in the delegation tree: a root task is 0. */
export function taskDepth(db: DatabaseSync, taskId: string): number | null {
  const statement = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?');
  let current: string | null = taskId;
  let depth = 0;
  for (let step = 0; step < MAX_PARENT_WALK; step += 1) {
    const row = statement.get(current) as { parent_task_id: string | null } | undefined;
    if (row === undefined) return step === 0 ? null : depth;
    if (row.parent_task_id === null) return depth;
    current = row.parent_task_id;
    depth += 1;
  }
  throw new Error(`task "${taskId}" parent chain is longer than ${MAX_PARENT_WALK}; refusing to walk further`);
}

export function countTasks(db: DatabaseSync, runId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE run_id = ?').get(runId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface DelegationRequest {
  readonly runId: string;
  /** The task asking to delegate. Its depth plus one is the depth of the child. */
  readonly parentTaskId: string;
  /** How many sub-tasks this request would create (default 1). */
  readonly requestedTasks?: number;
}

/**
 * Decide whether a delegated task may be created.
 *
 * Reads the authoritative run limits and the current task tree; returns a
 * decision instead of throwing, so the caller can persist the refusal as
 * evidence before answering the worker.
 */
export function evaluateDelegation(db: DatabaseSync, request: DelegationRequest): DelegationDecision {
  const limits = runLimits(db, request.runId);
  if (limits === null) {
    return { allowed: false, code: 'unknown_run', reason: `run "${request.runId}" is not in the state store`, depth: 0, taskCount: 0, limits: null };
  }
  const parentDepth = taskDepth(db, request.parentTaskId);
  if (parentDepth === null) {
    return {
      allowed: false,
      code: 'unknown_task',
      reason: `task "${request.parentTaskId}" is not in the state store, so its delegation depth cannot be established`,
      depth: 0,
      taskCount: countTasks(db, request.runId),
      limits,
    };
  }

  const childDepth = parentDepth + 1;
  const taskCount = countTasks(db, request.runId);
  const requested = Math.max(1, Math.floor(request.requestedTasks ?? 1));

  if (childDepth > limits.maxDelegationDepth) {
    return {
      allowed: false,
      code: 'depth_exceeded',
      reason: `delegation refused: the requested sub-task would sit at depth ${childDepth}, above maxDelegationDepth ${limits.maxDelegationDepth}. Do the work in this task or report it as out of scope.`,
      depth: childDepth,
      taskCount,
      limits,
    };
  }
  if (taskCount + requested > limits.maxTasksPerRun) {
    return {
      allowed: false,
      code: 'task_budget_exceeded',
      reason: `delegation refused: this run already has ${taskCount} task${taskCount === 1 ? '' : 's'} and maxTasksPerRun is ${limits.maxTasksPerRun}. Finish or narrow existing work before asking for more.`,
      depth: childDepth,
      taskCount,
      limits,
    };
  }
  return { allowed: true, depth: childDepth, taskCount, limits };
}
