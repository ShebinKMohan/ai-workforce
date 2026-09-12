/**
 * Ordered, normalized application events (FR058, FR065).
 *
 * The `sequence` column is monotonic per run and allocated inside the
 * BEGIN IMMEDIATE transaction that inserts the row, so two writers can never
 * interleave. An optional idempotency key makes ingestion replay-safe: the
 * same key returns the existing event instead of appending a duplicate.
 *
 * Rows stay small: a payload above `MAX_EVENT_PAYLOAD_BYTES` is refused here.
 * Large payloads belong in the artifact store with only the artifact id in
 * `payload_ref` (see `telemetry/events.ts`, which does that spill).
 */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { withTransaction } from './tx.js';

/** Upper bound for `payload_json` in one event row (plan section 8: large logs and patches go to the artifact store). */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

export class EventPayloadTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(type: string, bytes: number, limit: number) {
    super(`event "${type}" payload is ${bytes} bytes, above the ${limit}-byte row limit; publish it as an artifact and reference it via payloadRef`);
    this.name = 'EventPayloadTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function payloadByteLength(payload: Record<string, unknown> | undefined): number {
  return Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
}

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

export function findEventByKey(db: DatabaseSync, runId: string, idempotencyKey: string): EventRecord | null {
  const row = db.prepare('SELECT * FROM events WHERE run_id = ? AND idempotency_key = ?').get(runId, idempotencyKey) as EventRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput): AppendEventResult {
  const payloadJson = JSON.stringify(input.payload ?? {});
  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) throw new EventPayloadTooLargeError(input.type, bytes, MAX_EVENT_PAYLOAD_BYTES);
  return withTransaction(db, () => {
    if (input.idempotencyKey) {
      const existing = findEventByKey(db, input.runId, input.idempotencyKey);
      if (existing !== null) return { event: existing, appended: false };
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
      payloadJson,
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

/** One event row together with its position in the whole table. */
export interface CursoredEvent {
  /** Monotonic across every run; resume after it with `afterCursor`. */
  readonly cursor: number;
  readonly event: EventRecord;
}

/**
 * Every run's events after a table-wide cursor, in the order they were written
 * (FR084's live stream).
 *
 * `sequence` is only monotonic within one run, so it cannot order two runs'
 * rows against each other. The row's `rowid` can: `events` is an ordinary rowid
 * table, every insert happens inside the single writer's BEGIN IMMEDIATE
 * transaction, SQLite allocates `max(rowid) + 1`, and nothing in this codebase
 * deletes an event row — so a row committed later always has a larger rowid,
 * and a reader that remembers the last one it saw never misses or repeats one.
 */
export function listEventsAfterCursor(db: DatabaseSync, options: { readonly afterCursor?: number; readonly limit?: number } = {}): CursoredEvent[] {
  const rows = db
    .prepare('SELECT rowid AS event_cursor, * FROM events WHERE rowid > ? ORDER BY rowid ASC LIMIT ?')
    .all(options.afterCursor ?? 0, options.limit ?? 500) as unknown as Array<EventRow & { event_cursor: number }>;
  return rows.map((row) => ({ cursor: row.event_cursor, event: toRecord(row) }));
}

/** The cursor of the newest event row in any run; 0 when there is none. */
export function lastEventCursor(db: DatabaseSync): number {
  return (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM events').get() as { last: number }).last;
}

/** A task's newest recorded event: when it was last observed doing anything, and what. */
export interface LastTaskEvent {
  readonly taskId: string;
  readonly type: string;
  readonly timestamp: string;
  readonly sequence: number;
}

/**
 * Each task's newest event in one run (FR084's activity indicator).
 *
 * An office desk shows how long ago its task last produced an event instead
 * of a percentage nobody measured. Uses the `(run_id, sequence)` index.
 */
export function lastEventPerTask(db: DatabaseSync, runId: string): LastTaskEvent[] {
  const rows = db
    .prepare(
      `SELECT e.task_id AS task_id, e.type AS type, e.timestamp AS timestamp, e.sequence AS sequence
         FROM events e
         JOIN (SELECT task_id, MAX(sequence) AS last FROM events WHERE run_id = ? AND task_id IS NOT NULL GROUP BY task_id) newest
           ON e.task_id = newest.task_id AND e.sequence = newest.last
        WHERE e.run_id = ?`,
    )
    .all(runId, runId) as unknown as Array<{ task_id: string; type: string; timestamp: string; sequence: number }>;
  return rows.map((row) => ({ taskId: row.task_id, type: row.type, timestamp: row.timestamp, sequence: row.sequence }));
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
