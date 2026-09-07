/**
 * Operations: durable intent -> dispatch -> receipt (FR065).
 *
 * Invariants enforced here:
 * - Intent is persisted before anything is spawned (callers record, then act).
 * - A receipt is accepted only for the task's current generation; late
 *   receipts from superseded generations are rejected and logged as events.
 * - Receipts are idempotent: recording the same outcome twice returns the
 *   stored record; a conflicting outcome is an error, never a silent overwrite.
 * - Uncertain outcomes are first-class so crash reconciliation can find them.
 */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { appendEvent } from './events.js';
import { getTask } from './records.js';
import { withTransaction } from './tx.js';

export type OperationState = 'intended' | 'dispatched' | 'completed' | 'failed' | 'uncertain';
export type ReceiptOutcome = 'completed' | 'failed' | 'uncertain';

export interface OperationRecord {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly kind: string;
  readonly generation: number;
  readonly intent: Record<string, unknown>;
  readonly state: OperationState;
  readonly receipt: Record<string, unknown> | null;
  readonly uncertainOutcome: boolean;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
}

interface OperationRow {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  kind: string;
  generation: number;
  intent_json: string;
  state: OperationState;
  receipt_json: string | null;
  uncertain_outcome: number;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

function toRecord(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    generation: row.generation,
    intent: JSON.parse(row.intent_json) as Record<string, unknown>,
    state: row.state,
    receipt: row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as Record<string, unknown>),
    uncertainOutcome: row.uncertain_outcome === 1,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
}

export class OperationNotFoundError extends Error {
  constructor(id: string) {
    super(`operation "${id}" not found`);
    this.name = 'OperationNotFoundError';
  }
}

export class StaleGenerationError extends Error {
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly currentGeneration: number;

  constructor(operationId: string, operationGeneration: number, currentGeneration: number) {
    super(
      `receipt for operation ${operationId} belongs to generation ${operationGeneration} but the task is at generation ${currentGeneration}; late results from superseded generations are rejected`,
    );
    this.name = 'StaleGenerationError';
    this.operationId = operationId;
    this.operationGeneration = operationGeneration;
    this.currentGeneration = currentGeneration;
  }
}

export class OperationStateError extends Error {
  constructor(id: string, state: OperationState, action: string) {
    super(`operation ${id} is ${state}; cannot ${action}`);
    this.name = 'OperationStateError';
  }
}

export function getOperation(db: DatabaseSync, id: string): OperationRecord {
  const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
  if (row === undefined) throw new OperationNotFoundError(id);
  return toRecord(row);
}

export interface RecordIntentInput {
  readonly id?: string;
  readonly runId: string;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
  readonly kind: string;
  readonly intent: Record<string, unknown>;
  /** Defaults to the task's current generation when a task is given, else 1. */
  readonly generation?: number;
  readonly now?: string;
}

/** Persist the intent to perform an effect. Must be called (and committed) before the effect starts. */
export function recordIntent(db: DatabaseSync, input: RecordIntentInput): OperationRecord {
  return withTransaction(db, () => {
    const id = input.id ?? newId();
    const now = input.now ?? nowIso();
    const generation = input.generation ?? (input.taskId ? getTask(db, input.taskId).current_generation : 1);
    db.prepare(
      `INSERT INTO operations(id, run_id, task_id, attempt_id, kind, generation, intent_json, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'intended', ?)`,
    ).run(id, input.runId, input.taskId ?? null, input.attemptId ?? null, input.kind, generation, JSON.stringify(input.intent), now);
    appendEvent(db, {
      runId: input.runId,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      type: 'operation.intended',
      payload: { operationId: id, kind: input.kind, generation },
      timestamp: now,
    });
    return getOperation(db, id);
  });
}

export function markDispatched(db: DatabaseSync, id: string, details: Record<string, unknown> = {}, now: string = nowIso()): OperationRecord {
  return withTransaction(db, () => {
    const op = getOperation(db, id);
    if (op.state === 'dispatched') return op; // idempotent
    if (op.state !== 'intended') throw new OperationStateError(id, op.state, 'mark dispatched');
    db.prepare("UPDATE operations SET state = 'dispatched', dispatched_at = ? WHERE id = ?").run(now, id);
    appendEvent(db, {
      runId: op.runId,
      taskId: op.taskId,
      attemptId: op.attemptId,
      type: 'operation.dispatched',
      payload: { operationId: id, kind: op.kind, generation: op.generation, ...details },
      timestamp: now,
    });
    return getOperation(db, id);
  });
}

export interface RecordReceiptInput {
  readonly outcome: ReceiptOutcome;
  readonly receipt: Record<string, unknown>;
  /** Generation the reporter believes it belongs to; must match the operation. */
  readonly generation?: number;
  readonly now?: string;
}

/**
 * Record the completion receipt. Rejects stale generations, tolerates exact
 * duplicates and refuses conflicting outcomes. A stale rejection is itself
 * recorded as a diagnostic event after the rolled-back attempt.
 */
export function recordReceipt(db: DatabaseSync, id: string, input: RecordReceiptInput): OperationRecord {
  const now = input.now ?? nowIso();
  try {
    return withTransaction(db, () => applyReceipt(db, id, input, now));
  } catch (error) {
    if (error instanceof StaleGenerationError) {
      const op = getOperation(db, id);
      appendEvent(db, {
        runId: op.runId,
        taskId: op.taskId,
        attemptId: op.attemptId,
        type: 'operation.receipt_rejected',
        payload: { operationId: op.id, kind: op.kind, reportedGeneration: error.operationGeneration, currentGeneration: error.currentGeneration, reason: 'stale_generation' },
        timestamp: now,
      });
    }
    throw error;
  }
}

function applyReceipt(db: DatabaseSync, id: string, input: RecordReceiptInput, now: string): OperationRecord {
  const op = getOperation(db, id);

  if (input.generation !== undefined && input.generation !== op.generation) {
    throw new StaleGenerationError(op.id, input.generation, op.generation);
  }
  if (op.taskId !== null) {
    const current = getTask(db, op.taskId).current_generation;
    if (op.generation !== current) throw new StaleGenerationError(op.id, op.generation, current);
  }

  if (op.state === 'completed' || op.state === 'failed' || op.state === 'uncertain') {
    if (op.state === input.outcome) return op; // at-least-once delivery: duplicate receipt
    if (op.state === 'uncertain') {
      // reconciliation resolved an uncertain outcome
      db.prepare('UPDATE operations SET state = ?, receipt_json = ?, completed_at = ? WHERE id = ?').run(input.outcome, JSON.stringify(input.receipt), now, id);
      appendEvent(db, { runId: op.runId, taskId: op.taskId, attemptId: op.attemptId, type: 'operation.reconciled', payload: { operationId: id, outcome: input.outcome }, timestamp: now });
      return getOperation(db, id);
    }
    throw new OperationStateError(id, op.state, `record a conflicting ${input.outcome} receipt`);
  }

  db.prepare('UPDATE operations SET state = ?, receipt_json = ?, uncertain_outcome = ?, completed_at = ? WHERE id = ?').run(
    input.outcome,
    JSON.stringify(input.receipt),
    input.outcome === 'uncertain' ? 1 : 0,
    now,
    id,
  );
  appendEvent(db, {
    runId: op.runId,
    taskId: op.taskId,
    attemptId: op.attemptId,
    type: `operation.${input.outcome}`,
    payload: { operationId: id, kind: op.kind, generation: op.generation },
    timestamp: now,
  });
  return getOperation(db, id);
}

/** Mark an in-flight operation as uncertain (for example the coordinator died after dispatch). */
export function markUncertain(db: DatabaseSync, id: string, reason: string, now: string = nowIso()): OperationRecord {
  return withTransaction(db, () => {
    const op = getOperation(db, id);
    if (op.state === 'uncertain') return op;
    if (op.state !== 'intended' && op.state !== 'dispatched') throw new OperationStateError(id, op.state, 'mark uncertain');
    db.prepare("UPDATE operations SET state = 'uncertain', uncertain_outcome = 1, receipt_json = ? WHERE id = ?").run(JSON.stringify({ reason }), id);
    appendEvent(db, { runId: op.runId, taskId: op.taskId, attemptId: op.attemptId, type: 'operation.uncertain', payload: { operationId: id, reason }, timestamp: now });
    return getOperation(db, id);
  });
}

/** Operations that still need reconciliation before the run may continue. */
export function listOpenOperations(db: DatabaseSync, runId: string): OperationRecord[] {
  const rows = db
    .prepare("SELECT * FROM operations WHERE run_id = ? AND state IN ('intended', 'dispatched', 'uncertain') ORDER BY created_at, id")
    .all(runId) as unknown as OperationRow[];
  return rows.map(toRecord);
}
