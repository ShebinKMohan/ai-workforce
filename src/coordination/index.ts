/**
 * Coordination transport factory.
 *
 * `createCoordinationBridge` starts the coordinator-side socket for one run
 * and hands out per-attempt worker configuration. The orchestrator gets the
 * message-store API it needs; the worker gets nothing but a socket path and a
 * token whose meaning only the coordinator knows.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BRIDGE_ROLE_ENV,
  BRIDGE_SERVER_NAME,
  BRIDGE_SOCKET_ENV,
  BRIDGE_TOKEN_ENV,
  bridgeEntryPath,
  bridgeToolsFor,
} from './bridge.js';
import { CoordinationServer, MAX_COORDINATION_SOCKET_PATH_BYTES, type CoordinationNotice, type HeadReviewResultHandler, type PlanProposalHandler, type ReceiverRegistry, type WorkerIdentity } from './server.js';
import {
  acknowledge as acknowledgeMessage,
  deliverableFor as deliverableForTask,
  expireUndelivered,
  listMessages,
  pendingDeliveries,
  recordMessage as recordMessageInStore,
  type MessageRecord,
  type RecordMessageInput,
  type RecordMessageResult,
} from './messages.js';

export * from './bridge.js';
export * from './delegation.js';
export * from './messages.js';
export * from './server.js';

/**
 * Socket path for a run: inside the run directory when it fits, otherwise a
 * short endpoint in a fresh private temporary directory. Both the state
 * path and TMPDIR can exceed the Unix socket limit during verification.
 * The server exclusively creates and later removes the fallback parent.
 */
export function coordinationSocketPath(stateRoot: string, runId: string): string {
  const preferred = path.join(path.resolve(stateRoot), 'runs', runId, 'coordination.sock');
  if (Buffer.byteLength(preferred, 'utf8') <= MAX_COORDINATION_SOCKET_PATH_BYTES) return preferred;
  // TMPDIR may itself be a deeply nested, sanitized verification directory.
  // Measure the complete UTF-8 endpoint, including its private parent; never
  // assume that an environment-selected temporary root is short enough.
  const directory = `wf-${randomBytes(12).toString('hex')}`;
  for (const candidateRoot of [os.tmpdir(), '/tmp']) {
    let root: string;
    try { root = realpathSync(candidateRoot); } catch { continue; }
    const candidate = path.join(root, directory, 'c.sock');
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_COORDINATION_SOCKET_PATH_BYTES) return candidate;
  }
  throw new Error('No available temporary root can fit a private coordination socket within the platform path limit.');
}

export interface StdioServerConfig {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

/** Everything needed to attach one worker session to the bridge. */
export interface AttemptBridgeConfig {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly serverName: string;
  readonly socketPath: string;
  /** Session token. Treat as a credential: it is the worker's whole identity. */
  readonly token: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** Object shaped for an MCP client config file. */
  readonly mcpServers: Readonly<Record<string, StdioServerConfig>>;
  /** Ready for `claude --mcp-config <json>`. */
  readonly claudeMcpConfigJson: string;
  /** Ready to splice into a `claude` argv. */
  readonly claudeArgs: ReadonlyArray<string>;
  /** Ready to splice into a `codex` argv (`-c mcp_servers.<name>....`). */
  readonly codexArgs: ReadonlyArray<string>;
  /** Drop this session's token; later calls with it are unauthenticated. */
  revoke(): void;
}

export interface CoordinationBridgeOptions {
  readonly stateRoot: string;
  readonly runId: string;
  readonly db: DatabaseSync;
  readonly socketPath?: string;
  readonly maxMessagesPerAttempt?: number;
  /**
   * Raised when a message will not reach anyone. The owner of the run passes
   * this so the operator sees the fact while the run is still going, instead
   * of only in the manifest afterwards.
   */
  readonly onNotice?: (notice: CoordinationNotice) => void;
}

export interface CoordinationBridge {
  readonly socketPath: string;
  readonly runId: string;
  readonly server: CoordinationServer;
  /** Configure the bridge for one attempt; identity is read from the attempt row, never from a caller-supplied name. */
  mcpConfigFor(attemptId: string): AttemptBridgeConfig;
  /**
   * Configure the bridge for a department head's planning session. The
   * session is offered `workforce_propose_plan` alone, and every proposal it
   * makes is handed to `onProposePlan`. `planningId` names the session in the
   * identity (a head plans outside any task row, so it is not an attempt id).
   */
  headConfigFor(input: { readonly planningId: string; readonly agentId: string; readonly onProposePlan: PlanProposalHandler }): AttemptBridgeConfig;
  /** Separate review-only authority, scoped to this review's token and callback. */
  headReviewConfigFor(input: { readonly reviewId: string; readonly agentId: string; readonly onReviewResult: HeadReviewResultHandler }): AttemptBridgeConfig;
  /** Coordinator-side write of a message (for example a coordinator answer to a worker). */
  recordMessage(input: RecordMessageInput): RecordMessageResult;
  /** Bounded inbox for a task. */
  deliverableFor(taskId: string, options?: { limit?: number; includeAcknowledged?: boolean }): MessageRecord[];
  acknowledge(messageId: string): MessageRecord;
  /** Every message of this run, oldest first. */
  messages(limit?: number): MessageRecord[];
  /**
   * Declare that a task has a live worker session that can be handed a
   * message, and be told when one arrives for it. Call the returned function
   * when that session can no longer receive; from then on the coordinator
   * knows the task is not reachable and says so to its senders instead of
   * accepting messages nobody will read.
   */
  openReceiver(taskId: string, onMessage: (message: MessageRecord) => void): () => void;
  /** Messages addressed to a task (or to any task) that have not arrived and have not failed. */
  pending(taskId?: string): MessageRecord[];
  /** Give up explicitly on every message that never arrived, so none is left looking like it still might. */
  expireUndelivered(taskId?: string): MessageRecord[];
  close(): Promise<void>;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Start the coordination transport for one run.
 *
 * The socket lives beside the run's state, outside every candidate workspace,
 * so a worker can only reach it through the bridge it was given.
 */
export async function createCoordinationBridge(options: CoordinationBridgeOptions): Promise<CoordinationBridge> {
  const socketPath = options.socketPath ?? coordinationSocketPath(options.stateRoot, options.runId);
  // One entry per task, because a task has at most one live worker session at
  // a time: the coordinator never spawns a second writer for the same task.
  const receiverByTask = new Map<string, (message: MessageRecord) => void>();
  const receivers: ReceiverRegistry = {
    has: (taskId) => receiverByTask.has(taskId),
    notify: (message) => {
      if (message.recipientTaskId === null) return;
      receiverByTask.get(message.recipientTaskId)?.(message);
    },
  };
  const server = await CoordinationServer.start({
    socketPath,
    ...(options.socketPath === undefined && socketPath !== path.join(path.resolve(options.stateRoot), 'runs', options.runId, 'coordination.sock') ? { createPrivateSocketDirectory: true } : {}),
    db: options.db,
    runId: options.runId,
    receivers,
    ...(options.maxMessagesPerAttempt === undefined ? {} : { maxMessagesPerAttempt: options.maxMessagesPerAttempt }),
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
  });
  const entry = bridgeEntryPath();

  const mcpConfigFor = (attemptId: string): AttemptBridgeConfig => {
    const row = options.db.prepare('SELECT task_id, run_id FROM attempts WHERE id = ?').get(attemptId) as
      | { task_id: string; run_id: string }
      | undefined;
    if (row === undefined) throw new Error(`attempt "${attemptId}" is not in the state store; the bridge cannot issue an identity for it`);
    if (row.run_id !== options.runId) throw new Error(`attempt "${attemptId}" belongs to run "${row.run_id}", not "${options.runId}"`);
    const identity: WorkerIdentity = { runId: row.run_id, taskId: row.task_id, attemptId };
    const token = server.registerWorker(identity);
    return configFor(identity, token, {});
  };

  const headConfigFor: CoordinationBridge['headConfigFor'] = (input) => {
    const identity: WorkerIdentity = { runId: options.runId, taskId: `head:${input.agentId}`, attemptId: input.planningId, role: 'head', agentId: input.agentId };
    const token = server.registerHead(identity, input.onProposePlan);
    return configFor(identity, token, { [BRIDGE_ROLE_ENV]: 'head' });
  };

  const headReviewConfigFor: CoordinationBridge['headReviewConfigFor'] = (input) => {
    const identity: WorkerIdentity = { runId: options.runId, taskId: `head-review:${input.agentId}`, attemptId: input.reviewId, role: 'head-review', agentId: input.agentId };
    const token = server.registerHeadReview(identity, input.onReviewResult);
    return configFor(identity, token, { [BRIDGE_ROLE_ENV]: 'head-review' });
  };

  const configFor = (identity: WorkerIdentity, token: string, extraEnv: Readonly<Record<string, string>>): AttemptBridgeConfig => {
    const attemptId = identity.attemptId;
    const command = process.execPath;
    const args = [entry];
    const env: Record<string, string> = { [BRIDGE_SOCKET_ENV]: socketPath, [BRIDGE_TOKEN_ENV]: token, ...extraEnv };
    const serverConfig: StdioServerConfig = { type: 'stdio', command, args, env };
    const mcpServers = { [BRIDGE_SERVER_NAME]: serverConfig };
    const claudeMcpConfigJson = JSON.stringify({ mcpServers });
    const prefix = `mcp_servers.${BRIDGE_SERVER_NAME}`;
    const toolNames = bridgeToolsFor(identity.role ?? 'worker').map(tool => tool.name);
    return {
      runId: identity.runId,
      taskId: identity.taskId,
      attemptId,
      serverName: BRIDGE_SERVER_NAME,
      socketPath,
      token,
      command,
      args,
      env,
      mcpServers,
      claudeMcpConfigJson,
      claudeArgs: ['--mcp-config', claudeMcpConfigJson],
      codexArgs: [
        '-c',
        `${prefix}.command=${tomlString(command)}`,
        '-c',
        `${prefix}.args=[${args.map(tomlString).join(', ')}]`,
        '-c',
        `${prefix}.env={ ${Object.entries(env)
          .map(([key, value]) => `${key} = ${tomlString(value)}`)
          .join(', ')} }`,
        // This is the coordinator's own, token-scoped control channel. Recent
        // Codex builds reject its tool calls under the global never policy
        // before emitting an elicitation. Authorize exactly the offered role
        // tools at session creation; never authorize a server-wide wildcard.
        '-c',
        `${prefix}.enabled_tools=[${toolNames.map(tomlString).join(', ')}]`,
        ...toolNames.flatMap(tool => ['-c', `${prefix}.tools.${tool}.approval_mode="approve"`]),
      ],
      revoke: () => server.revokeWorker(token),
    };
  };

  return {
    socketPath,
    runId: options.runId,
    server,
    mcpConfigFor,
    headConfigFor,
    headReviewConfigFor,
    recordMessage: (input) => recordMessageInStore(options.db, input),
    deliverableFor: (taskId, query) =>
      deliverableForTask(options.db, {
        runId: options.runId,
        recipientTaskId: taskId,
        ...(query?.limit === undefined ? {} : { limit: query.limit }),
        ...(query?.includeAcknowledged === undefined ? {} : { includeAcknowledged: query.includeAcknowledged }),
      }),
    acknowledge: (messageId) => acknowledgeMessage(options.db, messageId),
    messages: (limit) => listMessages(options.db, options.runId, limit),
    openReceiver: (taskId, onMessage) => {
      receiverByTask.set(taskId, onMessage);
      return () => {
        // Only close the registration this call opened: a repair attempt for
        // the same task registers a new one, and the old closer running late
        // must not silently unregister the live session.
        if (receiverByTask.get(taskId) === onMessage) receiverByTask.delete(taskId);
      };
    },
    pending: (taskId) => pendingDeliveries(options.db, options.runId, taskId === undefined ? {} : { recipientTaskId: taskId }),
    expireUndelivered: (taskId) => expireUndelivered(options.db, options.runId, taskId === undefined ? {} : { recipientTaskId: taskId }),
    close: () => server.close(),
  };
}
