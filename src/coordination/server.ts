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
  WireRequestSchema,
  type BridgeToolName,
  type WireResponse,
} from './bridge.js';
import { evaluateDelegation } from './delegation.js';
import {
  acknowledge,
  countMessagesFromAttempt,
  deliverableFor,
  findMessage,
  recordMessage,
  submitMessage,
  type MessageRecord,
} from './messages.js';

/** A worker session's authenticated identity. Only the coordinator can mint one. */
export interface WorkerIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

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

export interface HandlerOptions {
  readonly maxMessagesPerAttempt?: number;
  readonly now?: () => string;
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
    if (recipient !== null) {
      const row = db.prepare('SELECT run_id FROM tasks WHERE id = ?').get(recipient) as { run_id: string } | undefined;
      if (row === undefined || row.run_id !== identity.runId) {
        throw new CoordinationError('unknown_recipient', `no task "${recipient}" in this run; address a peer task id from your context or omit "to" to reach the coordinator`);
      }
    }
    assertUnderCap();
    const recorded = recordMessage(db, {
      sender,
      type: 'peer_message',
      recipientTaskId: recipient,
      correlationId: params.correlationId ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      body: { ...(params.subject === undefined ? {} : { subject: params.subject }), ...normalizeBody(params.body) },
      now: now(),
    });
    const delivered = recorded.duplicate ? recorded.message : submitMessage(db, recorded.message.id, now());
    return {
      messageId: delivered.id,
      deliveryState: delivered.deliveryState,
      duplicate: recorded.duplicate,
      from: delivered.senderTaskId,
      to: delivered.recipientTaskId,
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
    return {
      messages: messages.map(summarize),
      count: messages.length,
      limit: Math.min(limit, MAX_INBOX_LIMIT),
      truncated: messages.length >= Math.min(limit, MAX_INBOX_LIMIT),
      note: 'Acknowledge what you have handled and continue working; do not poll this tool in a loop.',
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
    assertUnderCap();
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
}

export class CoordinationServer {
  readonly socketPath: string;
  readonly runId: string;
  readonly #db: DatabaseSync;
  readonly #server: net.Server;
  readonly #tokens = new Map<string, WorkerIdentity>();
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

  revokeWorker(token: string): void {
    this.#tokens.delete(token);
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
