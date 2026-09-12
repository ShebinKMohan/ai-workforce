/**
 * The agent-callable coordination bridge (FR033).
 *
 * This module is BOTH the protocol definition shared with the coordinator and
 * the executable stdio MCP server that is spawned once per worker session.
 * It is deliberately self-contained: it has no relative *value* imports, so it
 * can be launched directly as a script by the same Node that runs the
 * coordinator (TypeScript in development, the compiled sibling in `dist`).
 *
 * The bridge is a thin client. It owns no state and makes no decisions: every
 * tool call is forwarded over a local unix socket to the coordinator, which
 * stamps sender identity from the connection's pre-shared token. Nothing the
 * model writes can name the sender, so a worker cannot impersonate a peer.
 *
 * Only a real JSON-RPC `tools/call` on stdin produces a forwarded request.
 * Prose, logs, or arbitrary JSON that merely looks like a tool call are
 * ignored (AT08).
 */
import { createConnection } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Protocol constants (shared with server.ts)
// ---------------------------------------------------------------------------

export const COORDINATION_PROTOCOL_VERSION = 1;
export const BRIDGE_SOCKET_ENV = 'WORKFORCE_BRIDGE_SOCKET';
export const BRIDGE_TOKEN_ENV = 'WORKFORCE_BRIDGE_TOKEN';
export const BRIDGE_SERVER_NAME = 'workforce';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Inbox reads are always bounded; a worker cannot ask for an unbounded stream. */
export const DEFAULT_INBOX_LIMIT = 20;
export const MAX_INBOX_LIMIT = 100;
/** Upper bound for one message body, so a worker cannot bloat the state store. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Upper bound for one stdin line; longer lines are refused, not buffered. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** The tools a worker session is offered. */
export const BRIDGE_TOOL_NAMES = [
  'request_task',
  'send_message',
  'read_inbox',
  'ack_message',
  'publish_artifact',
  'report_result',
] as const;
export type WorkerBridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];

/**
 * The tools a department head's planning session is offered, and nobody else.
 *
 * Prefixed on purpose: codex-cli 0.147.0 has a built-in `send_message` that
 * silently captured a bridge call of the same name (docs/evidence/r1), so a
 * head tool must never share a name with a tool a runtime ships.
 */
export const HEAD_BRIDGE_TOOL_NAMES = ['workforce_propose_plan'] as const;
export type HeadBridgeToolName = (typeof HEAD_BRIDGE_TOOL_NAMES)[number];

/** Review sessions cannot plan, dispatch, or report worker results. */
export const HEAD_REVIEW_BRIDGE_TOOL_NAMES = ['workforce_review_result'] as const;
export type HeadReviewBridgeToolName = (typeof HEAD_REVIEW_BRIDGE_TOOL_NAMES)[number];

/** Every operation the coordinator's socket understands. Which ones a session may call is decided by its role. */
export const ALL_BRIDGE_TOOL_NAMES = [...BRIDGE_TOOL_NAMES, ...HEAD_BRIDGE_TOOL_NAMES, ...HEAD_REVIEW_BRIDGE_TOOL_NAMES] as const;
export type BridgeToolName = (typeof ALL_BRIDGE_TOOL_NAMES)[number];

/**
 * Which tool list a bridge process advertises. Presentation only: the
 * coordinator enforces the role from the session token, so a worker that
 * starts a bridge with `head` in its environment still cannot propose a plan.
 */
export const BRIDGE_ROLE_ENV = 'WORKFORCE_BRIDGE_ROLE';
export type BridgeRole = 'worker' | 'head' | 'head-review';

export function isHeadBridgeTool(name: string): name is HeadBridgeToolName {
  return (HEAD_BRIDGE_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

export function isHeadReviewBridgeTool(name: string): name is HeadReviewBridgeToolName {
  return (HEAD_REVIEW_BRIDGE_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

/** The coordinator validates this before invoking the token's review handler. */
export const HeadReviewResultSchema = z.object({
  reviewVersion: z.literal(1),
  candidateRevision: z.string().min(1).max(128),
  diffHash: z.string().min(1).max(128),
  verdict: z.enum(['approve', 'changes_requested']),
  summary: z.string().min(1).max(8_000),
  findings: z.array(z.object({
    summary: z.string().min(1).max(8_000),
    file: z.string().min(1).max(1_024).optional(),
    line: z.number().int().min(1).optional(),
  }).strict()).max(100),
}).strict();
export type HeadReviewResult = z.infer<typeof HeadReviewResultSchema>;

export interface BridgeToolDefinition {
  readonly name: BridgeToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function obj(properties: Record<string, unknown>, required: ReadonlyArray<string>): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

export const BRIDGE_TOOLS: ReadonlyArray<BridgeToolDefinition> = [
  {
    name: 'request_task',
    description:
      'Ask the coordinator to create a delegated sub-task. The coordinator validates the request against the run delegation depth and task budget and may reject it. Requesting a task never grants extra permissions.',
    inputSchema: obj(
      {
        objective: { type: 'string', minLength: 1, description: 'What the sub-task must achieve.' },
        rationale: { type: 'string', description: 'Why this work should be delegated instead of done here.' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        idempotencyKey: { type: 'string', description: 'Repeat the same key to retry safely; it will not create a second request.' },
      },
      ['objective'],
    ),
  },
  {
    name: 'send_message',
    description:
      'Send a message to the coordinator, or to a peer task by id. The sender is stamped by the coordinator from this session; any sender field you supply is ignored.',
    inputSchema: obj(
      {
        to: { type: 'string', description: 'Recipient task id. Omit to address the coordinator.' },
        subject: { type: 'string' },
        body: { description: 'Message body: a string or a JSON object.' },
        correlationId: { type: 'string', description: 'Ties a reply to an earlier message.' },
        idempotencyKey: { type: 'string', description: 'Repeat the same key to retry safely; it will not create a second message.' },
      },
      ['body'],
    ),
  },
  {
    name: 'read_inbox',
    description: 'Read messages addressed to this task. Results are capped; call again after acknowledging rather than polling in a loop.',
    inputSchema: obj(
      {
        limit: { type: 'integer', minimum: 1, maximum: MAX_INBOX_LIMIT, description: `Maximum messages to return (default ${DEFAULT_INBOX_LIMIT}, cap ${MAX_INBOX_LIMIT}).` },
        includeAcknowledged: { type: 'boolean', description: 'Include messages this task already acknowledged (default false).' },
      },
      [],
    ),
  },
  {
    name: 'ack_message',
    description: 'Acknowledge a message addressed to this task, so the coordinator stops delivering it.',
    inputSchema: obj({ messageId: { type: 'string', minLength: 1 }, note: { type: 'string' } }, ['messageId']),
  },
  {
    name: 'publish_artifact',
    description:
      'Announce an artifact produced in this workspace so peers and the coordinator can find it. This records a reference; it does not grant anyone write access.',
    inputSchema: obj(
      {
        path: { type: 'string', minLength: 1, description: 'Workspace-relative path of the artifact.' },
        kind: { type: 'string', description: 'Artifact kind, for example "patch", "log", "note".' },
        description: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      ['path'],
    ),
  },
  {
    name: 'report_result',
    description:
      'Report what this task produced. Reporting a result is a claim, not an acceptance: the coordinator decides acceptance from contained checks, never from this report.',
    inputSchema: obj(
      {
        status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
        summary: { type: 'string', minLength: 1 },
        evidence: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        idempotencyKey: { type: 'string' },
      },
      ['status', 'summary'],
    ),
  },
];

const PLAN_TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: 'Task id, unique in this plan, for example "t1". Dependencies name it.' },
    objective: { type: 'string', minLength: 1, description: 'What the assigned worker must achieve, in one or two sentences.' },
    assignee: { type: 'string', minLength: 1, description: 'The id of exactly one worker from the roster in your prompt. Never your own id.' },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 } },
        required: ['id', 'description'],
        additionalProperties: false,
      },
      description: 'How the worker knows the task is done. Guidance only: the coordinator runs the project checks itself.',
    },
    dependencies: {
      type: 'array',
      items: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'], additionalProperties: false },
      description: 'Tasks in this plan that must be accepted before this one starts.',
    },
    scope: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        allowedPaths: { type: 'array', items: { type: 'string', minLength: 1 } },
        forbiddenPaths: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      additionalProperties: false,
    },
    constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
    evidenceRequirements: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['id', 'objective', 'assignee', 'acceptanceCriteria'],
  additionalProperties: false,
};

export const HEAD_BRIDGE_TOOLS: ReadonlyArray<BridgeToolDefinition> = [
  {
    name: 'workforce_propose_plan',
    description:
      'Propose the plan for this request: tasks, each assigned to one worker on your roster. This is the only way a plan reaches the coordinator; a plan written as text in your reply creates nothing. The coordinator validates the plan in code and answers with any issues; a valid plan is what starts the workers.',
    inputSchema: obj(
      {
        planVersion: { type: 'integer', enum: [2], description: 'Always 2.' },
        summary: { type: 'string', minLength: 1, description: 'One or two sentences: how you split the request and why.' },
        tasks: { type: 'array', minItems: 1, items: PLAN_TASK_SCHEMA },
      },
      ['planVersion', 'summary', 'tasks'],
    ),
  },
];

export const HEAD_REVIEW_BRIDGE_TOOLS: ReadonlyArray<BridgeToolDefinition> = [
  {
    name: 'workforce_review_result',
    description:
      'Submit your review of the frozen combined candidate and verifier evidence. Use the exact candidate revision and diff hash supplied by the coordinator. Only this tool submits a review; prose submits nothing. Review approval does not replace required verifier checks or authorize applying, merging, or publishing the candidate.',
    inputSchema: obj(
      {
        reviewVersion: { type: 'integer', enum: [1], description: 'Always 1.' },
        candidateRevision: { type: 'string', minLength: 1, maxLength: 128 },
        diffHash: { type: 'string', minLength: 1, maxLength: 128 },
        verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
        summary: { type: 'string', minLength: 1, maxLength: 8_000 },
        findings: {
          type: 'array',
          maxItems: 100,
          items: obj({
            summary: { type: 'string', minLength: 1, maxLength: 8_000 },
            file: { type: 'string', minLength: 1, maxLength: 1_024 },
            line: { type: 'integer', minimum: 1 },
          }, ['summary']),
        },
      },
      ['reviewVersion', 'candidateRevision', 'diffHash', 'verdict', 'summary', 'findings'],
    ),
  },
];

/** The tools a session in `role` is offered. */
export function bridgeToolsFor(role: BridgeRole): ReadonlyArray<BridgeToolDefinition> {
  if (role === 'head-review') return HEAD_REVIEW_BRIDGE_TOOLS;
  return role === 'head' ? HEAD_BRIDGE_TOOLS : BRIDGE_TOOLS;
}

// ---------------------------------------------------------------------------
// Bridge <-> coordinator wire protocol (newline-delimited JSON over a unix socket)
// ---------------------------------------------------------------------------

export interface WireRequest {
  readonly v: number;
  readonly id: string;
  /** Pre-shared connection token; the coordinator derives identity from this alone. */
  readonly token: string;
  readonly op: BridgeToolName;
  readonly params: Record<string, unknown>;
}

export interface WireSuccess {
  readonly v: number;
  readonly id: string;
  readonly ok: true;
  readonly result: Record<string, unknown>;
}

export interface WireFailure {
  readonly v: number;
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type WireResponse = WireSuccess | WireFailure;

export const WireRequestSchema = z.object({
  v: z.number().int(),
  id: z.string().min(1).max(128),
  token: z.string().min(1).max(256),
  op: z.enum(ALL_BRIDGE_TOOL_NAMES),
  params: z.record(z.string(), z.unknown()).default({}),
});

const WireResponseSchema = z.union([
  z.object({ v: z.number().int(), id: z.string(), ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.object({ v: z.number().int(), id: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/**
 * Send one request to the coordinator and read one response.
 *
 * A connection per call: there is no session state to keep, and a dead
 * coordinator surfaces immediately as a call failure instead of a silent hang.
 */
export function callCoordinator(
  socketPath: string,
  token: string,
  op: BridgeToolName,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<WireResponse> {
  return new Promise((resolve) => {
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    let buffer = '';
    const finish = (response: WireResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const fail = (code: string, message: string): void => finish({ v: COORDINATION_PROTOCOL_VERSION, id, ok: false, error: { code, message } });

    const socket = createConnection(socketPath);
    const timer = setTimeout(() => fail('timeout', `coordinator did not answer "${op}" within ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.on('error', (error: Error) => fail('transport_error', `coordination socket error: ${error.message}`));
    socket.on('close', () => fail('transport_closed', 'coordination socket closed before a response arrived'));
    socket.on('connect', () => {
      const request: WireRequest = { v: COORDINATION_PROTOCOL_VERSION, id, token, op, params };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        if (buffer.length > MAX_LINE_BYTES) fail('protocol_error', 'coordinator response exceeded the line limit');
        return;
      }
      const line = buffer.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail('protocol_error', 'coordinator response was not valid JSON');
        return;
      }
      const result = WireResponseSchema.safeParse(parsed);
      if (!result.success) {
        fail('protocol_error', 'coordinator response did not match the coordination protocol');
        return;
      }
      finish(result.data as WireResponse);
    });
  });
}

// ---------------------------------------------------------------------------
// MCP over stdio (JSON-RPC 2.0, newline-delimited)
// ---------------------------------------------------------------------------

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

type RpcId = string | number | null;

interface RpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: RpcId;
  readonly method?: string;
  readonly params?: unknown;
}

const RpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

function rpcResult(id: RpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: RpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Render a coordinator answer as an MCP tool result. */
function toolResult(payload: Record<string, unknown>, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  };
}

export interface BridgeOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly callTimeoutMs?: number;
  /** Which tool list to advertise. Defaults to `worker`. The coordinator enforces the real role. */
  readonly role?: BridgeRole;
}

/**
 * Run the stdio MCP server until `input` ends.
 *
 * Every line is treated as data. A line that is not a well-formed JSON-RPC 2.0
 * request is answered with a protocol error (or ignored when it carries no id)
 * and never reaches the coordinator.
 */
export function runBridge(options: BridgeOptions): Promise<void> {
  const { socketPath, token, input, output } = options;
  const callTimeoutMs = options.callTimeoutMs ?? 15_000;
  const role: BridgeRole = options.role ?? 'worker';
  const offered = bridgeToolsFor(role);
  const offeredNames: ReadonlyArray<string> = offered.map((tool) => tool.name);
  const write = (line: string): void => {
    output.write(`${line}\n`);
  };

  let queue: Promise<void> = Promise.resolve();

  /**
   * Answers already produced for a JSON-RPC request id.
   *
   * An MCP client that times out and re-sends the SAME request id is retrying
   * one call, not making a second one. Without this the retry would be
   * forwarded again and recorded again, so a transport retry would become two
   * peer messages (AT08 clause 2). Bounded, because a worker controls the ids.
   */
  const answered = new Map<string, Promise<Record<string, unknown>>>();
  const MAX_REMEMBERED_CALLS = 512;
  const rememberCall = (key: string, answer: Promise<Record<string, unknown>>): void => {
    answered.set(key, answer);
    while (answered.size > MAX_REMEMBERED_CALLS) {
      const oldest = answered.keys().next();
      if (oldest.done === true) break;
      answered.delete(oldest.value);
    }
  };

  const handle = async (message: RpcMessage): Promise<void> => {
    const id: RpcId = message.id ?? null;
    const isNotification = message.id === undefined;
    const method = message.method;
    if (method === undefined) {
      // A response or a malformed frame: the bridge never issues requests, so there is nothing to correlate.
      if (!isNotification) write(rpcError(id, JSONRPC_INVALID_REQUEST, 'expected a JSON-RPC request with a "method"'));
      return;
    }

    if (method === 'initialize') {
      write(
        rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: `${COORDINATION_PROTOCOL_VERSION}.0.0` },
          instructions:
            role === 'head-review'
              ? 'Review the supplied candidate and evidence. Submit the structured decision with workforce_review_result; prose submits nothing. You cannot plan, dispatch, or accept a candidate without its required verifier evidence.'
              : role === 'head'
              ? 'Planning tool for this request. Deliver your plan by calling workforce_propose_plan; a plan written as text creates nothing. You plan; your workers do the work.'
              : 'Coordination tools for this run. Your identity is fixed by the coordinator; you cannot send as another worker, raise your own budgets, or accept your own result.',
        }),
      );
      return;
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;
    if (method === 'ping') {
      if (!isNotification) write(rpcResult(id, {}));
      return;
    }
    if (method === 'tools/list') {
      write(rpcResult(id, { tools: offered.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }));
      return;
    }
    if (method !== 'tools/call') {
      if (!isNotification) write(rpcError(id, JSONRPC_METHOD_NOT_FOUND, `unknown method "${method}"`));
      return;
    }

    const params = z
      .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
      .safeParse(message.params);
    if (!params.success) {
      if (!isNotification) write(rpcError(id, JSONRPC_INVALID_PARAMS, 'tools/call requires { name, arguments }'));
      return;
    }
    const name = params.data.name;
    if (!offeredNames.includes(name)) {
      if (!isNotification) write(rpcError(id, JSONRPC_INVALID_PARAMS, `unknown tool "${name}"; available: ${offeredNames.join(', ')}`));
      return;
    }

    // A repeat of THIS frame is one call, not two. The coordinator dedupes
    // durably as well (an omitted idempotency key is derived from the
    // message's own content), so a retry that outlives this process is still
    // one logical message; this cache is what stops the second forward.
    const callKey = id === null ? null : `${typeof id}:${String(id)}`;
    if (callKey !== null) {
      const previous = answered.get(callKey);
      if (previous !== undefined) {
        const replayed = await previous;
        if (!isNotification) write(rpcResult(id, toolResult({ ...replayed, replayedRequestId: true }, replayed['error'] !== undefined)));
        return;
      }
    }

    const pending = callCoordinator(socketPath, token, name as BridgeToolName, params.data.arguments, callTimeoutMs).then((response) =>
      response.ok ? response.result : { error: response.error.code, message: response.error.message },
    );
    if (callKey !== null) rememberCall(callKey, pending);

    const payload = await pending;
    // Only a real answer is replayed. A timeout or a refusal is forgotten, so
    // a client that retries after one actually reaches the coordinator again —
    // safely, because the derived idempotency key makes that one message.
    if (callKey !== null && payload['error'] !== undefined) answered.delete(callKey);
    if (isNotification) return;
    write(rpcResult(id, toolResult(payload, payload['error'] !== undefined)));
  };

  return new Promise((resolve) => {
    const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    reader.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_BYTES) {
        write(rpcError(null, JSONRPC_INVALID_REQUEST, 'request line exceeded the size limit'));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Prose, logs, or a half-written frame: not a request, so nothing happens.
        return;
      }
      const message = RpcMessageSchema.safeParse(parsed);
      if (!message.success) {
        // JSON that merely looks like a tool call is data, never an operation (AT08).
        return;
      }
      queue = queue.then(() => handle(message.data as RpcMessage)).catch((error: unknown) => {
        write(rpcError(message.data.id ?? null, JSONRPC_INVALID_REQUEST, `bridge failure: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
    reader.on('close', () => {
      void queue.then(() => resolve());
    });
  });
}

/** Absolute path of this module's executable form (`.ts` in development, `.js` in `dist`). */
export function bridgeEntryPath(): string {
  return fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  const socketPath = process.env[BRIDGE_SOCKET_ENV];
  const token = process.env[BRIDGE_TOKEN_ENV];
  if (socketPath === undefined || socketPath.length === 0 || token === undefined || token.length === 0) {
    process.stderr.write(`workforce coordination bridge: ${BRIDGE_SOCKET_ENV} and ${BRIDGE_TOKEN_ENV} must be set\n`);
    process.exitCode = 2;
    return;
  }
  const configuredRole = process.env[BRIDGE_ROLE_ENV];
  const role: BridgeRole = configuredRole === 'head-review' || configuredRole === 'head' ? configuredRole : 'worker';
  await runBridge({ socketPath, token, input: process.stdin, output: process.stdout, role });
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && path.resolve(invokedAs) === bridgeEntryPath()) {
  void main();
}
