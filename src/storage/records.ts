/**
 * Minimal row helpers for runs, tasks, attempts and agent snapshots.
 *
 * State changes go through `assertTransition`, so an illegal lifecycle
 * transition cannot be persisted. Later packages add richer repositories;
 * they must keep using these transition-checked writers.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentSnapshot,
  type AttemptState,
  type Limits,
  type Policy,
  type RunRequest,
  type RunState,
  type TaskContract,
  type TaskState,
  type WaitReason,
} from '../core/contracts.js';
import { newId, nowIso } from '../core/ids.js';
import type { ProcessIdentity } from '../core/process.js';
import { assertTransition, validateWaitReason } from '../core/state.js';
import { withTransaction } from './tx.js';

export interface RunRow {
  id: string;
  project_id: string | null;
  request_json: string;
  repo_path: string;
  base_revision: string | null;
  contract_version: number;
  policy: string;
  limits_json: string;
  state: RunState;
  ownership_epoch: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface TaskRow {
  id: string;
  run_id: string;
  parent_task_id: string | null;
  objective: string;
  contract_json: string;
  contract_version: number;
  context_refs_json: string;
  owner_agent_id: string | null;
  state: TaskState;
  wait_reason: WaitReason | null;
  current_generation: number;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: string;
  task_id: string;
  run_id: string;
  generation: number;
  agent_snapshot_hash: string;
  runtime_id: string | null;
  runtime_version: string | null;
  process_id: number | null;
  process_started_at_ms: number | null;
  process_spawn_token: string | null;
  session_id: string | null;
  turn_id: string | null;
  workspace_path: string | null;
  state: AttemptState;
  outcome_json: string | null;
  interrupted: number;
  uncertain_outcome: number;
  superseded_by: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export class RecordNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} "${id}" not found`);
    this.name = 'RecordNotFoundError';
  }
}

export function insertRun(
  db: DatabaseSync,
  input: { id?: string; request: RunRequest; policy: Policy; limits: Limits; projectId?: string; baseRevision?: string; now?: string },
): RunRow {
  const id = input.id ?? input.request.runId;
  const now = input.now ?? nowIso();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO runs(id, project_id, request_json, repo_path, base_revision, contract_version, policy, limits_json, state, ownership_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(id, input.projectId ?? null, JSON.stringify(input.request), input.request.repoPath, input.baseRevision ?? null, 1, input.policy, JSON.stringify(input.limits), now, now);
  });
  return getRun(db, id);
}

export function getRun(db: DatabaseSync, id: string): RunRow {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  if (row === undefined) throw new RecordNotFoundError('run', id);
  return row;
}

export function findRun(db: DatabaseSync, id: string): RunRow | null {
  return (db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;
}

/** The most `listRuns` will return in one call, whatever the caller asks for. */
export const MAX_LIST_RUNS = 200;
export const DEFAULT_LIST_RUNS = 50;

/**
 * Runs, newest first, bounded (FR084's run list).
 *
 * Read-only: a reader holding no lock may call it while a coordinator writes.
 * Run ids are UUIDv7, so `id` breaks a `created_at` tie in creation order too.
 */
export function listRuns(db: DatabaseSync, options: { readonly limit?: number } = {}): RunRow[] {
  const requested = options.limit ?? DEFAULT_LIST_RUNS;
  const limit = Math.max(1, Math.min(MAX_LIST_RUNS, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_LIST_RUNS));
  return db.prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as RunRow[];
}

export function transitionRun(db: DatabaseSync, id: string, to: RunState, now: string = nowIso()): RunRow {
  return withTransaction(db, () => {
    const run = getRun(db, id);
    assertTransition('run', run.state, to);
    const ended = to === 'ready_for_review' || to === 'failed' || to === 'cancelled' ? now : null;
    db.prepare('UPDATE runs SET state = ?, updated_at = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?').run(to, now, ended, id);
    return getRun(db, id);
  });
}

/** Bump the ownership epoch when a coordinator takes exclusive ownership of a run (resume). */
export function bumpOwnershipEpoch(db: DatabaseSync, id: string, now: string = nowIso()): number {
  return withTransaction(db, () => {
    const run = getRun(db, id);
    const next = run.ownership_epoch + 1;
    db.prepare('UPDATE runs SET ownership_epoch = ?, updated_at = ? WHERE id = ?').run(next, now, id);
    return next;
  });
}

export function insertTask(
  db: DatabaseSync,
  input: { id?: string; runId: string; contract: TaskContract; parentTaskId?: string; ownerAgentId?: string; contextRefs?: ReadonlyArray<string>; now?: string },
): TaskRow {
  const id = input.id ?? newId();
  const now = input.now ?? nowIso();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks(id, run_id, parent_task_id, objective, contract_json, contract_version, context_refs_json, owner_agent_id, state, wait_reason, current_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1, ?, ?)`,
    ).run(
      id,
      input.runId,
      input.parentTaskId ?? null,
      input.contract.objective,
      JSON.stringify(input.contract),
      input.contract.contractVersion,
      JSON.stringify(input.contextRefs ?? []),
      input.ownerAgentId ?? null,
      now,
      now,
    );
  });
  return getTask(db, id);
}

export function getTask(db: DatabaseSync, id: string): TaskRow {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (row === undefined) throw new RecordNotFoundError('task', id);
  return row;
}

export function listTasks(db: DatabaseSync, runId: string): TaskRow[] {
  return db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, id').all(runId) as unknown as TaskRow[];
}

export function transitionTask(
  db: DatabaseSync,
  id: string,
  to: TaskState,
  options: { waitReason?: WaitReason; now?: string } = {},
): TaskRow {
  const now = options.now ?? nowIso();
  return withTransaction(db, () => {
    const task = getTask(db, id);
    assertTransition('task', task.state, to);
    const reason = to === 'waiting' ? (options.waitReason ?? null) : null;
    validateWaitReason(to, reason);
    db.prepare('UPDATE tasks SET state = ?, wait_reason = ?, updated_at = ? WHERE id = ?').run(to, reason, now, id);
    return getTask(db, id);
  });
}

/**
 * Start a new attempt generation for a task. Every open attempt of the older
 * generation is marked superseded, so late receipts from it are rejected.
 */
export function beginNewGeneration(db: DatabaseSync, taskId: string, now: string = nowIso()): number {
  return withTransaction(db, () => {
    const task = getTask(db, taskId);
    const next = task.current_generation + 1;
    db.prepare('UPDATE tasks SET current_generation = ?, updated_at = ? WHERE id = ?').run(next, now, taskId);
    const open = db
      .prepare("SELECT id, state FROM attempts WHERE task_id = ? AND generation < ? AND state NOT IN ('superseded')")
      .all(taskId, next) as Array<{ id: string; state: AttemptState }>;
    for (const attempt of open) {
      assertTransition('attempt', attempt.state, 'superseded');
      db.prepare("UPDATE attempts SET state = 'superseded', updated_at = ? WHERE id = ?").run(now, attempt.id);
    }
    return next;
  });
}

export function upsertAgentSnapshot(db: DatabaseSync, snapshot: AgentSnapshot, now: string = nowIso()): void {
  withTransaction(db, () => {
    const existing = db.prepare('SELECT canonical_json FROM agent_snapshots WHERE hash = ?').get(snapshot.hash) as { canonical_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.canonical_json !== snapshot.canonicalJson) {
        throw new Error(`agent snapshot ${snapshot.hash} already exists with different content; snapshots are immutable`);
      }
      return;
    }
    db.prepare('INSERT INTO agent_snapshots(hash, agent_id, binding_version, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
      snapshot.hash,
      snapshot.binding.agentId,
      snapshot.binding.bindingVersion,
      snapshot.canonicalJson,
      now,
    );
  });
}

export function insertAttempt(
  db: DatabaseSync,
  input: { id?: string; taskId: string; agentSnapshotHash: string; runtimeId?: string; workspacePath?: string; now?: string },
): AttemptRow {
  const id = input.id ?? newId();
  const now = input.now ?? nowIso();
  withTransaction(db, () => {
    const task = getTask(db, input.taskId);
    db.prepare(
      `INSERT INTO attempts(id, task_id, run_id, generation, agent_snapshot_hash, runtime_id, workspace_path, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, task.id, task.run_id, task.current_generation, input.agentSnapshotHash, input.runtimeId ?? null, input.workspacePath ?? null, now, now);
  });
  return getAttempt(db, id);
}

export function getAttempt(db: DatabaseSync, id: string): AttemptRow {
  const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow | undefined;
  if (row === undefined) throw new RecordNotFoundError('attempt', id);
  return row;
}

/**
 * Every attempt of a run, each task's generations in order (FR084's desk state).
 *
 * Read-only. A desk says "working" only while the attempt the database holds
 * for its task is `running`, so the view reads the attempt rows themselves
 * rather than inferring a live worker from a task state.
 */
export function listAttempts(db: DatabaseSync, runId: string): AttemptRow[] {
  return db.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY task_id, generation').all(runId) as unknown as AttemptRow[];
}

/** The recorded worker process identity of an attempt, when one was recorded. */
export function attemptProcessIdentity(attempt: AttemptRow): ProcessIdentity | null {
  if (attempt.process_id === null || attempt.process_spawn_token === null) return null;
  return { pid: attempt.process_id, startedAtMs: attempt.process_started_at_ms, spawnToken: attempt.process_spawn_token };
}

export interface AttemptRuntimeDetails {
  readonly sessionId?: string;
  /** Prefer `process`: a pid alone cannot be verified after a coordinator restart. */
  readonly processId?: number;
  readonly process?: ProcessIdentity;
  readonly turnId?: string;
  readonly version?: string;
}

export function transitionAttempt(
  db: DatabaseSync,
  id: string,
  to: AttemptState,
  options: { outcome?: unknown; uncertain?: boolean; runtime?: AttemptRuntimeDetails; now?: string } = {},
): AttemptRow {
  const now = options.now ?? nowIso();
  return withTransaction(db, () => {
    const attempt = getAttempt(db, id);
    assertTransition('attempt', attempt.state, to);
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'superseded';
    const process = options.runtime?.process;
    db.prepare(
      `UPDATE attempts SET state = ?, outcome_json = COALESCE(?, outcome_json), interrupted = CASE WHEN ? = 'interrupted' THEN 1 ELSE interrupted END,
         uncertain_outcome = CASE WHEN ? THEN 1 ELSE uncertain_outcome END,
         session_id = COALESCE(?, session_id), process_id = COALESCE(?, process_id),
         process_started_at_ms = COALESCE(?, process_started_at_ms), process_spawn_token = COALESCE(?, process_spawn_token),
         turn_id = COALESCE(?, turn_id), runtime_version = COALESCE(?, runtime_version),
         started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
         ended_at = CASE WHEN ? THEN ? ELSE ended_at END, updated_at = ?
       WHERE id = ?`,
    ).run(
      to,
      options.outcome === undefined ? null : JSON.stringify(options.outcome),
      to,
      options.uncertain === true ? 1 : 0,
      options.runtime?.sessionId ?? null,
      process?.pid ?? options.runtime?.processId ?? null,
      process?.startedAtMs ?? null,
      process?.spawnToken ?? null,
      options.runtime?.turnId ?? null,
      options.runtime?.version ?? null,
      to,
      now,
      terminal ? 1 : 0,
      now,
      now,
      id,
    );
    return getAttempt(db, id);
  });
}
