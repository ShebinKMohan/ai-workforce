/**
 * Coordinator side of the coordination transport (FR033, FR035, FR036).
 *
 * A unix socket under the state root, outside every worker's writable
 * workspace. Each worker session is issued a pre-shared token when its bridge
 * is configured; the coordinator maps that token to the sender identity
 * (runId, taskId, attemptId) it recorded when it created the attempt.
 *
 * Identity is NEVER taken from the request body. Parameter schemas are plain
 * zod objects, which strip unknown keys, so a model that writes
 * `{"from": "other-task"}` has that field removed before the handler runs.
 * There is no code path in which a value the model produced becomes a sender,
 * a budget, or an acceptance.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { nowIso } from '../core/ids.js';
import {
  BRIDGE_TOOL_NAMES,
  COORDINATION_PROTOCOL_VERSION,
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  MAX_LINE_BYTES,
  HeadReviewResultSchema,
  WireRequestSchema,
  isHeadBridgeTool,
  isHeadReviewBridgeTool,
  type BridgeRole,
  type BridgeToolName,
  type HeadReviewResult,
  type WireResponse,
} from './bridge.js';
import { appendEvent } from '../storage/events.js';
import { evaluateDelegation } from './delegation.js';
import {
  acknowledge,
  countMessagesFromAttempt,
  deliverableFor,
  findMessage,
  listSentBy,
  recordMessage,
  submitMessage,
  type MessageRecord,
} from './messages.js';

/** A worker session's authenticated identity. Only the coordinator can mint one. */
export interface WorkerIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /**
   * `head` for planning only, `head-review` for reviewing only; absent or
   * `worker` for a worker. Minted by the coordinator with the
   * token, never read from a request.
   */
  readonly role?: BridgeRole;
  /** The configured agent behind the session, when the coordinator recorded one. */
  readonly agentId?: string;
}

/**
 * What the coordinator does with a head's `workforce_propose_plan` call. The
 * planning code registers it with the head's token; its return value is the
 * tool result the head reads. It may throw `CoordinationError` to refuse.
 */
export type PlanProposalHandler = (identity: WorkerIdentity, params: Record<string, unknown>) => Record<string, unknown>;

/** The review owner validates candidate identity and persists its decision before returning. */
export type HeadReviewResultHandler = (result: HeadReviewResult) => Record<string, unknown>;

/** Upper bound on messages one attempt may produce, so a looping worker cannot flood the store. */
export const DEFAULT_MAX_MESSAGES_PER_ATTEMPT = 200;

export class CoordinationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
  }
}

const StringBody = z.union([z.string().max(64_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const SendMessageParams = z.object({
  to: z.string().min(1).max(128).nullish(),
  subject: z.string().max(512).optional(),
  body: StringBody,
  correlationId: z.string().min(1).max(128).nullish(),
  idempotencyKey: z.string().min(1).max(128).nullish(),
});

const ReadInboxParams = z.object({
  limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
  includeAcknowledged: z.boolean().optional(),
});

const AckMessageParams = z.object({
  messageId: z.string().min(1).max(128),
  note: z.string().max(2_000).optional(),
});

const RequestTaskParams = z.object({
  objective: z.string().min(1).max(8_000),
  rationale: z.string().max(8_000).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  idempotencyKey: z.string().min(1).max(128).nullish(),
});

const PublishArtifactParams = z.object({
  path: z.string().min(1).max(1_024),
  kind: z.string().min(1).max(64).optional(),
  description: z.string().max(8_000).optional(),
  idempotencyKey: z.string().min(1).max(128).nullish(),
});

const ReportResultParams = z.object({
  status: z.enum(['succeeded', 'failed', 'blocked']),
  summary: z.string().min(1).max(8_000),
  evidence: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  idempotencyKey: z.string().min(1).max(128).nullish(),
});

function normalizeBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return { text: body };
  if (Array.isArray(body)) return { items: body };
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  return { value: body };
}

function describePosture(posture: RecipientPosture): string {
  if (posture.kind === 'receiving') return 'The recipient has a live worker session and is being handed this message now.';
  if (posture.kind === 'not_started') {
    return `The recipient has not started its turn yet (${posture.taskState}); the message is held and read into its prompt before it starts. Keep working; do not wait for an answer.`;
  }
  return `The recipient has no worker session right now (${posture.taskState}), so nothing is holding this message. It will only arrive if that task starts another attempt, and it is reported as undelivered at the end of the run otherwise. Do not wait for an answer.`;
}

/**
 * Record, and raise, the fact that a message will not reach anyone.
 *
 * Both halves matter: the event is the durable evidence, the notice is what
 * puts a line in front of the operator while the run is still going. Neither
 * may take the coordinator down, so both are best effort.
 */
function noteUndeliverable(
  db: DatabaseSync,
  identity: WorkerIdentity,
  message: MessageRecord,
  code: string,
  detail: string,
  options: HandlerOptions,
): void {
  try {
    appendEvent(db, {
      runId: identity.runId,
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      type: 'coordination.delivery_failed',
      payload: {
        messageId: message.id,
        code,
        reason: detail,
        senderTaskId: message.senderTaskId,
        recipientTaskId: message.recipientTaskId,
        deliveryState: message.deliveryState,
      },
    });
  } catch {
    // An event that cannot be written must not turn a refusal into a crash;
    // the message row itself already carries the terminal state.
  }
  try {
    options.onNotice?.({
      kind: 'message_undeliverable',
      messageId: message.id,
      senderTaskId: message.senderTaskId,
      recipientTaskId: message.recipientTaskId,
      code,
      detail,
    });
  } catch {
    // A reporting hook is never allowed to change an outcome.
  }
}

function summarize(message: MessageRecord): Record<string, unknown> {
  return {
    messageId: message.id,
    from: message.senderTaskId,
    type: message.type,
    correlationId: message.correlationId,
    deliveryState: message.deliveryState,
    createdAt: message.createdAt,
    body: message.body,
  };
}

// ---------------------------------------------------------------------------
// Who can receive right now (FR033, FR035)
// ---------------------------------------------------------------------------

/**
 * The orchestrator's own statement about which tasks have a worker session
 * that can take a message *now*.
 *
 * The message store cannot answer this and neither can the task row: an
 * attempt stays `running` while its checks are being executed, long after its
 * session was stopped, and a task is `pending` both before it has ever run and
 * while it waits for a repair. Only the code holding the session knows, so it
 * says so here and the coordinator stops guessing.
 */
export interface ReceiverRegistry {
  /** True when a live worker session for this task can be handed a message. */
  has(taskId: string): boolean;
  /** Tell that session a message for it exists, so it delivers at its next safe boundary. */
  notify(message: MessageRecord): void;
}

/** Something the operator has to be able to see, raised from inside the coordinator. */
export interface CoordinationNotice {
  readonly kind: 'message_undeliverable';
  readonly messageId: string;
  readonly senderTaskId: string | null;
  readonly recipientTaskId: string | null;
  readonly code: string;
  readonly detail: string;
}

/** Task states after which no attempt of that task will run again in this run. */
const FINISHED_TASK_STATES: ReadonlySet<string> = new Set(['accepted', 'failed', 'cancelled', 'superseded']);
/** Task states from which the task has not yet had (or is between) its worker sessions. */
const NOT_STARTED_TASK_STATES: ReadonlySet<string> = new Set(['pending', 'ready', 'waiting']);

export type RecipientPosture =
  /** A worker session is live and will be handed this message. */
  | { readonly kind: 'receiving' }
  /** No session yet; the task reads its inbox into the prompt before its turn starts. */
  | { readonly kind: 'not_started'; readonly taskState: string }
  /** The task has run but has no session now: only a further attempt could deliver this. */
  | { readonly kind: 'no_active_session'; readonly taskState: string }
  /** The task is over. Nothing addressed to it can ever arrive. */
  | { readonly kind: 'finished'; readonly taskState: string };

/**
 * Can this recipient still be reached?
 *
 * Answered from the recorded task state and the live receiver registry, never
 * from optimism. `finished` is the case that used to be accepted as if it
 * would arrive: the message was recorded `submitted`, reported to the sender
 * as sent, and then read by nobody for ever.
 */
export function recipientPosture(db: DatabaseSync, runId: string, taskId: string, receivers?: ReceiverRegistry): RecipientPosture {
  const row = db.prepare('SELECT state FROM tasks WHERE id = ? AND run_id = ?').get(taskId, runId) as { state: string } | undefined;
  const taskState = row?.state ?? 'unknown';
  if (FINISHED_TASK_STATES.has(taskState)) return { kind: 'finished', taskState };
  if (receivers?.has(taskId) === true) return { kind: 'receiving' };
  if (NOT_STARTED_TASK_STATES.has(taskState)) return { kind: 'not_started', taskState };
  return { kind: 'no_active_session', taskState };
}

/**
 * One message this task sent, from the sender's point of view.
 *
 * The three outcomes are kept apart rather than collapsed into one boolean:
 * `delivered` (the recipient took it), `failed` (it never arrived and never
 * will), and neither of the two (still on its way).
 */
function summarizeSent(message: MessageRecord): Record<string, unknown> {
  const failed = message.deliveryState === 'expired' || message.deliveryState === 'rejected';
  return {
    messageId: message.id,
    to: message.recipientTaskId,
    type: message.type,
    correlationId: message.correlationId,
    deliveryState: message.deliveryState,
    delivered: message.deliveryState === 'acknowledged',
    failed,
    createdAt: message.createdAt,
    ...(failed ? { note: 'this message never reached its recipient; no answer to it is coming' } : {}),
  };
}

export interface HandlerOptions {
  readonly maxMessagesPerAttempt?: number;
  readonly now?: () => string;
  /** Live worker sessions, so the coordinator knows who can actually receive. */
  readonly receivers?: ReceiverRegistry;
  /** Raised when a message will not reach anyone, so the operator sees it as it happens. */
  readonly onNotice?: (notice: CoordinationNotice) => void;
  /** The planning session's handler for `workforce_propose_plan`; only a head identity reaches it. */
  readonly proposePlan?: PlanProposalHandler;
  /** Token-scoped review callback; receives only a validated structured result. */
  readonly reviewResult?: HeadReviewResultHandler;
}

/**
 * Execute one authenticated coordination request.
 *
 * Exported so the behaviour can be exercised without a socket; the socket
 * server is only a transport in front of this function.
 */
export function handleCoordinationRequest(
  db: DatabaseSync,
  identity: WorkerIdentity,
  op: BridgeToolName,
  rawParams: Record<string, unknown>,
  options: HandlerOptions = {},
): Record<string, unknown> {
  const now = options.now ?? nowIso;
  const cap = options.maxMessagesPerAttempt ?? DEFAULT_MAX_MESSAGES_PER_ATTEMPT;
  const sender = { runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId };

  // Roles are enforced here, from the identity the coordinator minted, not
  // from which tools a bridge process chose to advertise. Planning, reviewing,
  // and worker operations have separate token scopes.
  if (isHeadReviewBridgeTool(op)) {
    if (identity.role !== 'head-review') {
      throw new CoordinationError('forbidden', `"${op}" is offered to a department head's review session only`);
    }
    if (options.reviewResult === undefined) {
      throw new CoordinationError('review_closed', 'this review session is no longer taking results');
    }
    const parsed = HeadReviewResultSchema.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    return options.reviewResult(parsed.data);
  }
  if (identity.role === 'head-review') {
    throw new CoordinationError('forbidden', `a review session can only call workforce_review_result; "${op}" is outside its scope`);
  }
  if (isHeadBridgeTool(op)) {
    if (identity.role !== 'head') {
      throw new CoordinationError('forbidden', `"${op}" is offered to a department head's planning session only; a worker cannot propose a plan`);
    }
    if (options.proposePlan === undefined) {
      throw new CoordinationError('planning_closed', 'this planning session is no longer taking proposals');
    }
    return options.proposePlan(identity, rawParams);
  }
  if (identity.role === 'head') {
    throw new CoordinationError('forbidden', `a planning session can only call workforce_propose_plan; "${op}" belongs to the workers`);
  }

  const assertUnderCap = (): void => {
    if (countMessagesFromAttempt(db, identity.attemptId) >= cap) {
      throw new CoordinationError('message_budget_exceeded', `this attempt has already produced ${cap} coordination messages; no further messages are accepted`);
    }
  };

  if (op === 'send_message') {
    const parsed = SendMessageParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const params = parsed.data;
    const recipient = params.to ?? null;
    const body = { ...(params.subject === undefined ? {} : { subject: params.subject }), ...normalizeBody(params.body) };
    if (recipient !== null) {
      const row = db.prepare('SELECT run_id FROM tasks WHERE id = ?').get(recipient) as { run_id: string } | undefined;
      if (row === undefined || row.run_id !== identity.runId) {
        throw new CoordinationError('unknown_recipient', `no task "${recipient}" in this run; address a peer task id from your context or omit "to" to reach the coordinator`);
      }
    }
    // The coordinator, addressed by a null recipient, is always receiving: it
    // is the process asking this question.
    const posture: RecipientPosture =
      recipient === null ? { kind: 'receiving' } : recipientPosture(db, identity.runId, recipient, options.receivers);
    assertUnderCap();

    // A recipient whose task is over will never read anything. Accepting the
    // message here would report it as sent, park it at `submitted` for ever
    // and answer nobody. It is refused instead, and the refusal is persisted
    // as evidence before the sender is told, exactly like a refused
    // delegation request.
    if (posture.kind === 'finished') {
      const refused = recordMessage(db, {
        sender,
        type: 'peer_message',
        recipientTaskId: recipient,
        correlationId: params.correlationId ?? null,
        idempotencyKey: params.idempotencyKey ?? null,
        deliveryState: 'rejected',
        body: { ...body, undeliverable: true, code: 'recipient_finished', recipientTaskState: posture.taskState },
        now: now(),
      });
      // Says what is true now and nothing about the future: the task has no
      // worker session and this message was not taken for delivery. Promising
      // that it will "never" arrive would be the same kind of overclaim the
      // silent "submitted" was.
      const detail = `task "${recipient}" has already finished (${posture.taskState}); it has no worker session, so this message was not accepted for delivery. Whatever that task produced is already recorded — do not wait for an answer; continue with what you can establish yourself and say in your own result what you could not learn.`;
      noteUndeliverable(db, identity, refused.message, 'recipient_finished', detail, options);
      throw new CoordinationError('recipient_finished', `${detail} (message recorded as ${refused.message.id})`);
    }

    const recorded = recordMessage(db, {
      sender,
      type: 'peer_message',
      recipientTaskId: recipient,
      correlationId: params.correlationId ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      body,
      now: now(),
    });
    const delivered = recorded.duplicate ? recorded.message : submitMessage(db, recorded.message.id, now());
    // Wake the recipient's session now rather than at whatever boundary it
    // happens to reach next: a question that arrives after the last tool call
    // of a turn is still answerable, and one that waits is not.
    if (posture.kind === 'receiving' && recipient !== null && delivered.deliveryState === 'submitted') {
      try {
        options.receivers?.notify(delivered);
      } catch {
        // A notification failure only costs promptness: the recipient still
        // drains at its own boundaries, and the run-end sweep still resolves it.
      }
    }
    const deliverable = posture.kind === 'receiving' || posture.kind === 'not_started';
    return {
      messageId: delivered.id,
      deliveryState: delivered.deliveryState,
      duplicate: recorded.duplicate,
      from: delivered.senderTaskId,
      to: delivered.recipientTaskId,
      deliverable,
      recipientState: posture.kind,
      note: describePosture(posture),
    };
  }

  if (op === 'read_inbox') {
    const parsed = ReadInboxParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const limit = parsed.data.limit ?? DEFAULT_INBOX_LIMIT;
    const messages = deliverableFor(db, {
      runId: identity.runId,
      recipientTaskId: identity.taskId,
      limit,
      ...(parsed.data.includeAcknowledged === undefined ? {} : { includeAcknowledged: parsed.data.includeAcknowledged }),
    });
    // What this task itself sent, and what became of it. A worker that asked a
    // question and got no reply has to be able to tell "not answered yet" from
    // "never delivered, stop waiting", and this is where it reads that.
    const sent = listSentBy(db, identity.runId, identity.taskId).map(summarizeSent);
    const undelivered = sent.filter((entry) => entry['failed'] === true);
    return {
      messages: messages.map(summarize),
      count: messages.length,
      limit: Math.min(limit, MAX_INBOX_LIMIT),
      truncated: messages.length >= Math.min(limit, MAX_INBOX_LIMIT),
      sent,
      undeliveredCount: undelivered.length,
      note:
        undelivered.length === 0
          ? 'Acknowledge what you have handled and continue working; do not poll this tool in a loop.'
          : `Acknowledge what you have handled and continue working; do not poll this tool in a loop. ${undelivered.length} message(s) you sent never reached their recipient — see "sent"; no answer to those is coming, so proceed without one and say so in your result.`,
    };
  }

  if (op === 'ack_message') {
    const parsed = AckMessageParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const message = findMessage(db, parsed.data.messageId);
    if (message === null || message.runId !== identity.runId) {
      throw new CoordinationError('unknown_message', `no message "${parsed.data.messageId}" in this run`);
    }
    if (message.recipientTaskId !== identity.taskId) {
      throw new CoordinationError('forbidden', `message "${message.id}" is not addressed to this task; only its recipient can acknowledge it`);
    }
    const acked = acknowledge(db, message.id, now());
    return { messageId: acked.id, deliveryState: acked.deliveryState, acknowledgedAt: acked.acknowledgedAt };
  }

  if (op === 'request_task') {
    const parsed = RequestTaskParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const params = parsed.data;
    // The cap is asserted before anything is written, refusal included: a
    // worker that loops on a request the coordinator refuses must not be able
    // to write an unbounded number of rejection rows into the state store.
    assertUnderCap();
    const decision = evaluateDelegation(db, { runId: identity.runId, parentTaskId: identity.taskId });
    const body = {
      objective: params.objective,
      ...(params.rationale === undefined ? {} : { rationale: params.rationale }),
      ...(params.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: params.acceptanceCriteria }),
      requestedDepth: decision.depth,
    };
    if (!decision.allowed) {
      // The refusal is persisted as evidence before the worker is told, so a rejected request is auditable.
      const rejected = recordMessage(db, {
        sender,
        type: 'task_request',
        recipientTaskId: null,
        idempotencyKey: params.idempotencyKey ?? null,
        deliveryState: 'rejected',
        body: { ...body, rejected: true, code: decision.code, reason: decision.reason },
        now: now(),
      });
      throw new CoordinationError(decision.code, `${decision.reason} (request recorded as ${rejected.message.id})`);
    }
    const recorded = recordMessage(db, {
      sender,
      type: 'task_request',
      recipientTaskId: null,
      idempotencyKey: params.idempotencyKey ?? null,
      body,
      now: now(),
    });
    const delivered = recorded.duplicate ? recorded.message : submitMessage(db, recorded.message.id, now());
    return {
      requestId: delivered.id,
      accepted: false,
      queued: true,
      duplicate: recorded.duplicate,
      depth: decision.depth,
      note: 'The request is queued for the coordinator. A sub-task exists only once the coordinator creates it; keep working on what you can do now.',
    };
  }

  if (op === 'publish_artifact') {
    const parsed = PublishArtifactParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const params = parsed.data;
    if (path.isAbsolute(params.path) || params.path.split(/[\\/]/).includes('..')) {
      throw new CoordinationError('invalid_params', 'artifact path must be relative to your workspace and must not contain ".."');
    }
    assertUnderCap();
    const recorded = recordMessage(db, {
      sender,
      type: 'artifact_published',
      recipientTaskId: null,
      idempotencyKey: params.idempotencyKey ?? null,
      body: {
        path: params.path,
        ...(params.kind === undefined ? {} : { kind: params.kind }),
        ...(params.description === undefined ? {} : { description: params.description }),
      },
      now: now(),
    });
    const delivered = recorded.duplicate ? recorded.message : submitMessage(db, recorded.message.id, now());
    return { messageId: delivered.id, path: params.path, duplicate: recorded.duplicate, deliveryState: delivered.deliveryState };
  }

  if (op === 'report_result') {
    const parsed = ReportResultParams.safeParse(rawParams);
    if (!parsed.success) throw new CoordinationError('invalid_params', formatIssues(parsed.error));
    const params = parsed.data;
    assertUnderCap();
    const recorded = recordMessage(db, {
      sender,
      type: 'result_report',
      recipientTaskId: null,
      idempotencyKey: params.idempotencyKey ?? null,
      body: {
        status: params.status,
        summary: params.summary,
        ...(params.evidence === undefined ? {} : { evidence: params.evidence }),
      },
      now: now(),
    });
    const delivered = recorded.duplicate ? recorded.message : submitMessage(db, recorded.message.id, now());
    return {
      messageId: delivered.id,
      recorded: true,
      accepted: false,
      duplicate: recorded.duplicate,
      note: 'Recorded as a claim. Acceptance is decided by the coordinator from contained checks, never from this report.',
    };
  }

  throw new CoordinationError('unknown_op', `unsupported coordination operation "${String(op)}"`);
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

export interface CoordinationServerOptions {
  readonly socketPath: string;
  readonly db: DatabaseSync;
  readonly runId: string;
  readonly maxMessagesPerAttempt?: number;
  /** Observability hook; never used for authorization. */
  readonly onRequest?: (info: { op: BridgeToolName; identity: WorkerIdentity | null; ok: boolean; code?: string }) => void;
  /** Live worker sessions, so a message to a finished task is refused instead of parked. */
  readonly receivers?: ReceiverRegistry;
  /** Raised when a message will not reach anyone. */
  readonly onNotice?: (notice: CoordinationNotice) => void;
}

export class CoordinationServer {
  readonly socketPath: string;
  readonly runId: string;
  readonly #db: DatabaseSync;
  readonly #server: net.Server;
  readonly #tokens = new Map<string, WorkerIdentity>();
  readonly #planHandlers = new Map<string, PlanProposalHandler>();
  readonly #reviewHandlers = new Map<string, HeadReviewResultHandler>();
  readonly #options: CoordinationServerOptions;
  #closed = false;

  private constructor(options: CoordinationServerOptions) {
    this.socketPath = options.socketPath;
    this.runId = options.runId;
    this.#db = options.db;
    this.#options = options;
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    this.#server.on('error', () => {
      // A transport-level error must never take the coordinator down; per-connection errors are handled below.
    });
  }

  static async start(options: CoordinationServerOptions): Promise<CoordinationServer> {
    const server = new CoordinationServer(options);
    await server.#listen();
    return server;
  }

  /**
   * Issue a token for one worker session. The identity is supplied by the
   * coordinator from its own records; nothing a worker sends can change it.
   */
  registerWorker(identity: WorkerIdentity): string {
    const token = randomBytes(32).toString('hex');
    this.#tokens.set(token, identity);
    return token;
  }

  /**
   * Issue a token for a department head's planning session. The identity's
   * role is fixed to `head` here, and proposals made with the token go to
   * `onProposePlan` and nowhere else.
   */
  registerHead(identity: Omit<WorkerIdentity, 'role'>, onProposePlan: PlanProposalHandler): string {
    const token = randomBytes(32).toString('hex');
    this.#tokens.set(token, { ...identity, role: 'head' });
    this.#planHandlers.set(token, onProposePlan);
    return token;
  }

  /** Issue a separate review-only token; this cannot reuse planning authority. */
  registerHeadReview(identity: Omit<WorkerIdentity, 'role'>, onReviewResult: HeadReviewResultHandler): string {
    const token = randomBytes(32).toString('hex');
    this.#tokens.set(token, { ...identity, role: 'head-review' });
    this.#reviewHandlers.set(token, onReviewResult);
    return token;
  }

  revokeWorker(token: string): void {
    this.#tokens.delete(token);
    this.#planHandlers.delete(token);
    this.#reviewHandlers.delete(token);
  }

  identityFor(token: string): WorkerIdentity | null {
    return this.#tokens.get(token) ?? null;
  }

  get workerCount(): number {
    return this.#tokens.size;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#tokens.clear();
    this.#planHandlers.clear();
    this.#reviewHandlers.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    try {
      rmSync(this.socketPath, { force: true });
    } catch {
      // Best effort: a missing socket file is the desired end state anyway.
    }
  }

  #listen(): Promise<void> {
    const dir = path.dirname(this.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      // A leftover socket from a dead coordinator; the coordinator lock guarantees we are the only writer.
      try {
        if (statSync(this.socketPath).isSocket()) rmSync(this.socketPath, { force: true });
      } catch {
        // Fall through and let listen() report a real error.
      }
    }
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen(this.socketPath, () => {
        this.#server.removeListener('error', onError);
        try {
          chmodSync(this.socketPath, 0o600);
        } catch {
          // Not fatal: the socket already lives in a 0700 state root.
        }
        resolve();
      });
    });
  }

  #onConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = this.#dispatch(line);
        if (response !== null) socket.write(`${JSON.stringify(response)}\n`);
        newline = buffer.indexOf('\n');
      }
    });
  }

  #dispatch(line: string): WireResponse | null {
    if (line.trim().length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { v: COORDINATION_PROTOCOL_VERSION, id: 'unknown', ok: false, error: { code: 'protocol_error', message: 'request was not valid JSON' } };
    }
    const request = WireRequestSchema.safeParse(parsed);
    if (!request.success) {
      return { v: COORDINATION_PROTOCOL_VERSION, id: 'unknown', ok: false, error: { code: 'protocol_error', message: 'request did not match the coordination protocol' } };
    }
    const { id, token, op, params } = request.data;
    const identity = this.identityFor(token);
    if (identity === null) {
      this.#options.onRequest?.({ op, identity: null, ok: false, code: 'unauthenticated' });
      return { v: COORDINATION_PROTOCOL_VERSION, id, ok: false, error: { code: 'unauthenticated', message: 'this connection is not a registered worker session' } };
    }
    if (identity.runId !== this.runId) {
      return { v: COORDINATION_PROTOCOL_VERSION, id, ok: false, error: { code: 'forbidden', message: 'session belongs to a different run' } };
    }
    try {
      const result = handleCoordinationRequest(this.#db, identity, op as BridgeToolName, params, {
        ...(this.#options.maxMessagesPerAttempt === undefined ? {} : { maxMessagesPerAttempt: this.#options.maxMessagesPerAttempt }),
        ...(this.#options.receivers === undefined ? {} : { receivers: this.#options.receivers }),
        ...(this.#options.onNotice === undefined ? {} : { onNotice: this.#options.onNotice }),
        ...(this.#planHandlers.has(token) ? { proposePlan: this.#planHandlers.get(token)! } : {}),
        ...(this.#reviewHandlers.has(token) ? { reviewResult: this.#reviewHandlers.get(token)! } : {}),
      });
      this.#options.onRequest?.({ op, identity, ok: true });
      return { v: COORDINATION_PROTOCOL_VERSION, id, ok: true, result };
    } catch (error) {
      const code = error instanceof CoordinationError ? error.code : 'internal_error';
      const message = error instanceof Error ? error.message : String(error);
      this.#options.onRequest?.({ op, identity, ok: false, code });
      return { v: COORDINATION_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
    }
  }
}

export { BRIDGE_TOOL_NAMES };
