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
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BRIDGE_SERVER_NAME,
  BRIDGE_SOCKET_ENV,
  BRIDGE_TOKEN_ENV,
  bridgeEntryPath,
} from './bridge.js';
import { CoordinationServer, type WorkerIdentity } from './server.js';
import {
  acknowledge as acknowledgeMessage,
  deliverableFor as deliverableForTask,
  listMessages,
  recordMessage as recordMessageInStore,
  type MessageRecord,
  type RecordMessageInput,
  type RecordMessageResult,
} from './messages.js';

export * from './bridge.js';
export * from './delegation.js';
export * from './messages.js';
export * from './server.js';

/** macOS caps `sun_path` at 104 bytes; stay well under it. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Socket path for a run: inside the run directory when it fits, otherwise a
 * short path in the system temp directory (a long state root must not make
 * coordination impossible).
 */
export function coordinationSocketPath(stateRoot: string, runId: string): string {
  const preferred = path.join(path.resolve(stateRoot), 'runs', runId, 'coordination.sock');
  if (Buffer.byteLength(preferred, 'utf8') <= MAX_SOCKET_PATH_BYTES) return preferred;
  const shortId = runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return path.join(os.tmpdir(), `wf-${shortId}-${randomBytes(4).toString('hex')}.sock`);
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
}

export interface CoordinationBridge {
  readonly socketPath: string;
  readonly runId: string;
  readonly server: CoordinationServer;
  /** Configure the bridge for one attempt; identity is read from the attempt row, never from a caller-supplied name. */
  mcpConfigFor(attemptId: string): AttemptBridgeConfig;
  /** Coordinator-side write of a message (for example a coordinator answer to a worker). */
  recordMessage(input: RecordMessageInput): RecordMessageResult;
  /** Bounded inbox for a task. */
  deliverableFor(taskId: string, options?: { limit?: number; includeAcknowledged?: boolean }): MessageRecord[];
  acknowledge(messageId: string): MessageRecord;
  /** Every message of this run, oldest first. */
  messages(limit?: number): MessageRecord[];
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
  const server = await CoordinationServer.start({
    socketPath,
    db: options.db,
    runId: options.runId,
    ...(options.maxMessagesPerAttempt === undefined ? {} : { maxMessagesPerAttempt: options.maxMessagesPerAttempt }),
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
    const command = process.execPath;
    const args = [entry];
    const env = { [BRIDGE_SOCKET_ENV]: socketPath, [BRIDGE_TOKEN_ENV]: token };
    const serverConfig: StdioServerConfig = { type: 'stdio', command, args, env };
    const mcpServers = { [BRIDGE_SERVER_NAME]: serverConfig };
    const claudeMcpConfigJson = JSON.stringify({ mcpServers });
    const prefix = `mcp_servers.${BRIDGE_SERVER_NAME}`;
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
        `${prefix}.env={ ${BRIDGE_SOCKET_ENV} = ${tomlString(socketPath)}, ${BRIDGE_TOKEN_ENV} = ${tomlString(token)} }`,
      ],
      revoke: () => server.revokeWorker(token),
    };
  };

  return {
    socketPath,
    runId: options.runId,
    server,
    mcpConfigFor,
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
    close: () => server.close(),
  };
}
