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
 * The stored key is namespaced by SENDER. Two workers that happen to pick the
 * same key ("retry-1", a hash of the objective) are two different messages;
 * without the namespace the second worker's message would be swallowed and it
 * would be handed the first worker's record as if it were its own.
 *
 * When no key is supplied one is DERIVED from the message's own content, so a
 * worker that submits the same message twice produces one message whether or
 * not it thought to volunteer a key.
 *
 * Sender identity is a parameter of these functions, never a field of the
 * body. Callers must pass the identity they authenticated, so a body written
 * by a model can never name a different sender.
 *
 * Every message ends somewhere. `submitted` is a promise the coordinator makes
 * to the sender, so it is not allowed to be the resting place of a message
 * nobody ever read: a message that reached no recipient is moved to `expired`
 * (accepted, then never delivered) or `rejected` (refused at submission),
 * both of which are visible outcomes. `pendingDeliveries` is how the
 * coordinator asks what is still in flight, and `expireUndelivered` is how it
 * closes the ones that never arrived.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createHash } from 'node:crypto';
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
    idempotencyKey: unscopeKey(row.idempotency_key),
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
  const supplied = input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey.length > 0 ? input.idempotencyKey : null;
  const key = supplied ?? autoKey(input, bodyJson);
  const storedKey = scopeKey(input.sender.taskId, key);
  const now = input.now ?? nowIso();
  const state = input.deliveryState ?? 'recorded';

  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM messages WHERE run_id = ? AND idempotency_key = ?').get(input.sender.runId, storedKey) as MessageRow | undefined;
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
      storedKey,
      input.type,
      bodyJson,
      MESSAGE_CONTRACT_VERSION,
      state,
      now,
    );
    return { message: getMessage(db, id), duplicate: false };
  });
}


/** The sender's namespace, so one worker cannot squat another's key. */
const KEY_SEPARATOR = '\u0000';

function scopeKey(senderTaskId: string | null, key: string): string {
  return `${senderTaskId ?? 'coordinator'}${KEY_SEPARATOR}${key}`;
}

function unscopeKey(stored: string): string {
  const index = stored.indexOf(KEY_SEPARATOR);
  return index < 0 ? stored : stored.slice(index + KEY_SEPARATOR.length);
}

/**
 * A key derived from the message itself.
 *
 * Two submissions that agree on sender, recipient, type, correlation and body
 * are the same message: recording them twice would deliver one question twice
 * and get it answered twice. A worker that means to say the same thing again
 * can say it again with an explicit key.
 */
function autoKey(input: RecordMessageInput, bodyJson: string): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.sender.taskId ?? null,
        input.sender.attemptId ?? null,
        input.recipientTaskId ?? null,
        input.type,
        input.correlationId ?? null,
        input.deliveryState ?? 'recorded',
        bodyJson,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `auto:${digest}`;
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

/** Delivery states that mean "this message has not reached anyone yet, and has not been given up on". */
export const UNDELIVERED_STATES: ReadonlyArray<MessageDeliveryState> = ['recorded', 'submitted'];

/**
 * Every message addressed to a task that is still waiting to be delivered.
 *
 * `deliverableFor` answers a worker's inbox and is deliberately capped, so a
 * chatty peer cannot turn it into a stream. This answers the coordinator's own
 * question at the end of a task or a run — "is anything still in flight?" —
 * where a cap would be exactly the silent loss the cap exists to prevent, so
 * this one is not capped and messages addressed to the coordinator itself
 * (null recipient) are excluded: those reached their recipient by being
 * recorded.
 */
export function pendingDeliveries(db: DatabaseSync, runId: string, options: { readonly recipientTaskId?: string } = {}): MessageRecord[] {
  const placeholders = UNDELIVERED_STATES.map(() => '?').join(', ');
  const rows =
    options.recipientTaskId === undefined
      ? (db
          .prepare(
            `SELECT * FROM messages WHERE run_id = ? AND recipient_task_id IS NOT NULL AND delivery_state IN (${placeholders}) ORDER BY created_at, id`,
          )
          .all(runId, ...UNDELIVERED_STATES) as unknown as MessageRow[])
      : (db
          .prepare(
            `SELECT * FROM messages WHERE run_id = ? AND recipient_task_id = ? AND delivery_state IN (${placeholders}) ORDER BY created_at, id`,
          )
          .all(runId, options.recipientTaskId, ...UNDELIVERED_STATES) as unknown as MessageRow[]);
  return rows.map(toRecord);
}

/**
 * What one task sent, oldest first and bounded.
 *
 * A sender that asked a question is entitled to know what became of it. The
 * delivery state on these records is that answer: `acknowledged` means the
 * recipient took it, `expired` and `rejected` mean it never arrived.
 */
export function listSentBy(db: DatabaseSync, runId: string, senderTaskId: string, limit = 50): MessageRecord[] {
  const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 50, 200));
  const rows = db
    .prepare('SELECT * FROM messages WHERE run_id = ? AND sender_task_id = ? ORDER BY created_at, id LIMIT ?')
    .all(runId, senderTaskId, bounded) as unknown as MessageRow[];
  return rows.map(toRecord);
}

/**
 * Give up, explicitly, on every message that was accepted and never arrived.
 *
 * Called when the last worker that could have received them is gone. Each
 * message moves to `expired`, which is a terminal state the sender and the run
 * record can both read; nothing is deleted and nothing is left at `submitted`
 * pretending to still be on its way.
 */
export function expireUndelivered(
  db: DatabaseSync,
  runId: string,
  options: { readonly recipientTaskId?: string; readonly now?: string } = {},
): MessageRecord[] {
  const now = options.now ?? nowIso();
  const expired: MessageRecord[] = [];
  for (const message of pendingDeliveries(db, runId, options.recipientTaskId === undefined ? {} : { recipientTaskId: options.recipientTaskId })) {
    try {
      expired.push(expireMessage(db, message.id, now));
    } catch {
      // A message that reached a terminal state between the query and here is
      // already resolved; that is the outcome this function wanted.
    }
  }
  return expired;
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
