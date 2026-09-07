/**
 * Durable coordination messages (FR035).
 *
 * Messages live in the existing `messages` table. Intent is persisted before
 * any effect: a message is `recorded` inside the same transaction that
 * validated it, then `submitted` for delivery, then `acknowledged` by its
 * recipient. `rejected` and `expired` are terminal outcomes that keep the
 * evidence of a request that was refused or timed out.
 *
 * Idempotency is enforced by the database: `UNIQUE(run_id, idempotency_key)`
 * means the same key submitted twice is one logical message. The second
 * submission returns the first record and reports `duplicate: true`.
 *
 * Sender identity is a parameter of these functions, never a field of the
 * body. Callers must pass the identity they authenticated, so a body written
 * by a model can never name a different sender.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { newId, nowIso } from '../core/ids.js';
import { withTransaction } from '../storage/tx.js';
import { DEFAULT_INBOX_LIMIT, MAX_BODY_BYTES, MAX_INBOX_LIMIT } from './bridge.js';

export const MESSAGE_CONTRACT_VERSION = 1;

export const MessageTypeSchema = z.enum(['peer_message', 'task_request', 'artifact_published', 'result_report']);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageDeliveryStateSchema = z.enum(['recorded', 'submitted', 'acknowledged', 'expired', 'rejected']);
export type MessageDeliveryState = z.infer<typeof MessageDeliveryStateSchema>;

const MESSAGE_TRANSITIONS: Readonly<Record<MessageDeliveryState, ReadonlyArray<MessageDeliveryState>>> = {
  recorded: ['submitted', 'rejected', 'expired'],
  submitted: ['acknowledged', 'expired', 'rejected'],
  acknowledged: [],
  expired: [],
  rejected: [],
};

export class MessageTransitionError extends Error {
  constructor(id: string, from: MessageDeliveryState, to: MessageDeliveryState) {
    super(
      `message ${id} cannot move from "${from}" to "${to}"; allowed: ${
        MESSAGE_TRANSITIONS[from].length === 0 ? '(terminal)' : MESSAGE_TRANSITIONS[from].join(', ')
      }`,
    );
    this.name = 'MessageTransitionError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(id: string) {
    super(`message "${id}" not found`);
    this.name = 'MessageNotFoundError';
  }
}

export class MessageBodyTooLargeError extends Error {
  constructor(bytes: number) {
    super(`message body is ${bytes} bytes, above the ${MAX_BODY_BYTES}-byte limit; publish large content as an artifact and reference it`);
    this.name = 'MessageBodyTooLargeError';
  }
}

export interface MessageRecord {
  readonly id: string;
  readonly runId: string;
  readonly senderTaskId: string | null;
  readonly senderAttemptId: string | null;
  readonly recipientTaskId: string | null;
  readonly correlationId: string | null;
  readonly idempotencyKey: string;
  readonly type: MessageType;
  readonly body: Record<string, unknown>;
  readonly contractVersion: number;
  readonly deliveryState: MessageDeliveryState;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly acknowledgedAt: string | null;
}

interface MessageRow {
  id: string;
  run_id: string;
  sender_task_id: string | null;
  sender_attempt_id: string | null;
  recipient_task_id: string | null;
  correlation_id: string | null;
  idempotency_key: string;
  type: string;
  body_json: string;
  contract_version: number;
  delivery_state: string;
  created_at: string;
  submitted_at: string | null;
  acknowledged_at: string | null;
}

function toRecord(row: MessageRow): MessageRecord {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body_json);
    body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    body = { value: row.body_json };
  }
  return {
    id: row.id,
    runId: row.run_id,
    senderTaskId: row.sender_task_id,
    senderAttemptId: row.sender_attempt_id,
    recipientTaskId: row.recipient_task_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    type: MessageTypeSchema.parse(row.type),
    body,
    contractVersion: row.contract_version,
    deliveryState: MessageDeliveryStateSchema.parse(row.delivery_state),
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

/** Sender identity, always supplied by the authenticated caller. */
export interface MessageSender {
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
}

export interface RecordMessageInput {
  readonly sender: MessageSender;
  readonly type: MessageType;
  readonly body: Record<string, unknown>;
  /** Recipient task id; null addresses the coordinator. */
  readonly recipientTaskId?: string | null;
  readonly correlationId?: string | null;
  /** Stable retry key. Generated when absent, so an omitted key never collapses two distinct messages. */
  readonly idempotencyKey?: string | null;
  /** Record straight into a terminal state (used for refused requests kept as evidence). */
  readonly deliveryState?: MessageDeliveryState;
  readonly now?: string;
}

export interface RecordMessageResult {
  readonly message: MessageRecord;
  /** True when an existing message with the same idempotency key was returned instead of a new one. */
  readonly duplicate: boolean;
}

/**
 * Record a message. The same `(runId, idempotencyKey)` pair always maps to one
 * logical message: a repeat returns the stored record untouched.
 */
export function recordMessage(db: DatabaseSync, input: RecordMessageInput): RecordMessageResult {
  const bodyJson = JSON.stringify(input.body ?? {});
  const bytes = Buffer.byteLength(bodyJson, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new MessageBodyTooLargeError(bytes);
  const key = input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey.length > 0 ? input.idempotencyKey : `auto:${newId()}`;
  const now = input.now ?? nowIso();
  const state = input.deliveryState ?? 'recorded';

  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM messages WHERE run_id = ? AND idempotency_key = ?').get(input.sender.runId, key) as MessageRow | undefined;
    if (existing !== undefined) return { message: toRecord(existing), duplicate: true };
    const id = newId();
    db.prepare(
      `INSERT INTO messages(id, run_id, sender_task_id, sender_attempt_id, recipient_task_id, correlation_id, idempotency_key, type, body_json, contract_version, delivery_state, created_at, submitted_at, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.sender.runId,
      input.sender.taskId,
      input.sender.attemptId,
      input.recipientTaskId ?? null,
      input.correlationId ?? null,
      key,
      input.type,
      bodyJson,
      MESSAGE_CONTRACT_VERSION,
      state,
      now,
    );
    return { message: getMessage(db, id), duplicate: false };
  });
}

export function getMessage(db: DatabaseSync, id: string): MessageRecord {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  if (row === undefined) throw new MessageNotFoundError(id);
  return toRecord(row);
}

export function findMessage(db: DatabaseSync, id: string): MessageRecord | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row === undefined ? null : toRecord(row);
}

function transition(db: DatabaseSync, id: string, to: MessageDeliveryState, now: string): MessageRecord {
  return withTransaction(db, () => {
    const current = getMessage(db, id);
    if (current.deliveryState === to) return current;
    if (!MESSAGE_TRANSITIONS[current.deliveryState].includes(to)) throw new MessageTransitionError(id, current.deliveryState, to);
    db.prepare(
      `UPDATE messages SET delivery_state = ?,
         submitted_at = CASE WHEN ? = 'submitted' AND submitted_at IS NULL THEN ? ELSE submitted_at END,
         acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END
       WHERE id = ?`,
    ).run(to, to, now, to, now, id);
    return getMessage(db, id);
  });
}

/** Mark a recorded message as handed to delivery. */
export function submitMessage(db: DatabaseSync, id: string, now: string = nowIso()): MessageRecord {
  return transition(db, id, 'submitted', now);
}

/**
 * Acknowledge a message. Acknowledgement is idempotent, so a worker that
 * retries after a crash does not fail.
 */
export function acknowledge(db: DatabaseSync, id: string, now: string = nowIso()): MessageRecord {
  return transition(db, id, 'acknowledged', now);
}

export function rejectMessage(db: DatabaseSync, id: string, now: string = nowIso()): MessageRecord {
  return transition(db, id, 'rejected', now);
}

export function expireMessage(db: DatabaseSync, id: string, now: string = nowIso()): MessageRecord {
  return transition(db, id, 'expired', now);
}

export interface InboxQuery {
  readonly runId: string;
  /** Recipient task; messages addressed to the coordinator (null recipient) are excluded. */
  readonly recipientTaskId: string;
  readonly limit?: number;
  readonly includeAcknowledged?: boolean;
}

/**
 * Messages addressed to one task, oldest first and always bounded.
 *
 * The cap is enforced here, not by the caller: a worker cannot turn the inbox
 * into an unbounded stream by asking for a larger limit.
 */
export function deliverableFor(db: DatabaseSync, query: InboxQuery): MessageRecord[] {
  const requested = query.limit ?? DEFAULT_INBOX_LIMIT;
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT));
  const states = query.includeAcknowledged === true ? ['recorded', 'submitted', 'acknowledged'] : ['recorded', 'submitted'];
  const placeholders = states.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE run_id = ? AND recipient_task_id = ? AND delivery_state IN (${placeholders})
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(query.runId, query.recipientTaskId, ...states, limit) as unknown as MessageRow[];
  return rows.map(toRecord);
}

/** Every message of a run, oldest first (coordinator-side inspection, not a worker tool). */
export function listMessages(db: DatabaseSync, runId: string, limit = 500): MessageRecord[] {
  const rows = db.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY created_at, id LIMIT ?').all(runId, limit) as unknown as MessageRow[];
  return rows.map(toRecord);
}

/** Number of messages a single attempt has produced, used to bound a chatty worker. */
export function countMessagesFromAttempt(db: DatabaseSync, attemptId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_attempt_id = ?').get(attemptId) as { n: number } | undefined;
  return row?.n ?? 0;
}
