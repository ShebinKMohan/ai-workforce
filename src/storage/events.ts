/**
 * Ordered, normalized application events (FR058, FR065).
 *
 * The `sequence` column is monotonic per run and allocated inside the
 * BEGIN IMMEDIATE transaction that inserts the row, so two writers can never
 * interleave. An optional idempotency key makes ingestion replay-safe: the
 * same key returns the existing event instead of appending a duplicate.
 */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { withTransaction } from './tx.js';

export interface EventRecord {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly payloadRef: string | null;
  readonly idempotencyKey: string | null;
  readonly timestamp: string;
}

export interface AppendEventInput {
  readonly runId: string;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
  /** Reference to a large payload stored elsewhere (artifact id or raw ref). */
  readonly payloadRef?: string | null;
  readonly idempotencyKey?: string | null;
  readonly timestamp?: string;
}

interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  task_id: string | null;
  attempt_id: string | null;
  type: string;
  payload_json: string;
  payload_ref: string | null;
  idempotency_key: string | null;
  timestamp: string;
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    payloadRef: row.payload_ref,
    idempotencyKey: row.idempotency_key,
    timestamp: row.timestamp,
  };
}

export interface AppendEventResult {
  readonly event: EventRecord;
  /** False when an idempotency key matched an existing event. */
  readonly appended: boolean;
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput): AppendEventResult {
  return withTransaction(db, () => {
    if (input.idempotencyKey) {
      const existing = db
        .prepare('SELECT * FROM events WHERE run_id = ? AND idempotency_key = ?')
        .get(input.runId, input.idempotencyKey) as EventRow | undefined;
      if (existing !== undefined) return { event: toRecord(existing), appended: false };
    }
    const next = (db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE run_id = ?').get(input.runId) as { next: number }).next;
    const id = newId();
    db.prepare(
      `INSERT INTO events(id, run_id, sequence, task_id, attempt_id, type, payload_json, payload_ref, idempotency_key, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.runId,
      next,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.payloadRef ?? null,
      input.idempotencyKey ?? null,
      input.timestamp ?? nowIso(),
    );
    return { event: toRecord(db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow), appended: true };
  });
}

export interface ListEventsOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export function listEvents(db: DatabaseSync, runId: string, options: ListEventsOptions = {}): EventRecord[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?')
    .all(runId, options.afterSequence ?? 0, options.limit ?? 1_000_000) as unknown as EventRow[];
  return rows.map(toRecord);
}

export function lastEventSequence(db: DatabaseSync, runId: string): number {
  return (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM events WHERE run_id = ?').get(runId) as { last: number }).last;
}

/**
 * Replay events in order through `handler`, starting after `afterSequence`.
 * Returns the last sequence delivered so callers can persist a cursor and
 * resume without re-applying events.
 */
export function replayEvents(
  db: DatabaseSync,
  runId: string,
  handler: (event: EventRecord) => void,
  options: { afterSequence?: number; batchSize?: number } = {},
): number {
  let cursor = options.afterSequence ?? 0;
  const batchSize = options.batchSize ?? 500;
  for (;;) {
    const batch = listEvents(db, runId, { afterSequence: cursor, limit: batchSize });
    if (batch.length === 0) return cursor;
    for (const event of batch) {
      if (event.sequence <= cursor) throw new Error(`event sequence went backwards: ${event.sequence} after ${cursor}`);
      handler(event);
      cursor = event.sequence;
    }
    if (batch.length < batchSize) return cursor;
  }
}
