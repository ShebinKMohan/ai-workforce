// Fake worker used by the coordination tests: a process that speaks MCP over
// stdio to a real bridge child process, exactly as a runtime would.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSnapshot, Limits } from '../../src/core/contracts.js';
import { newId } from '../../src/core/ids.js';
import { bridgeEntryPath } from '../../src/coordination/bridge.js';
import { insertAttempt, insertRun, insertTask, upsertAgentSnapshot, type AttemptRow, type RunRow, type TaskRow } from '../../src/storage/records.js';
import { TEST_LIMITS, sampleContract, sampleRequest } from '../helpers/state.js';

const SNAPSHOT: AgentSnapshot = {
  hash: 'sha256:coordination-test-snapshot',
  binding: {
    bindingVersion: 1,
    agentId: 'tester',
    instructions: 'test',
    capabilities: [],
    policy: 'local-development',
    runtime: { id: 'fake', adapter: 'fake', executable: 'fake' },
    limits: TEST_LIMITS,
  },
  canonicalJson: '{"agentId":"tester"}',
};

export function seedRun(db: DatabaseSync, limits: Limits = TEST_LIMITS): RunRow {
  upsertAgentSnapshot(db, SNAPSHOT);
  return insertRun(db, { request: sampleRequest(newId()), policy: 'local-development', limits });
}

export function seedTask(db: DatabaseSync, runId: string, parentTaskId?: string): TaskRow {
  return insertTask(db, { runId, contract: sampleContract(), ...(parentTaskId === undefined ? {} : { parentTaskId }) });
}

export function seedAttempt(db: DatabaseSync, taskId: string): AttemptRow {
  return insertAttempt(db, { taskId, agentSnapshotHash: SNAPSHOT.hash });
}

export interface RpcResponse {
  readonly id?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

/** Structured payload of an MCP tool result. */
export interface ToolCallResult {
  readonly isError: boolean;
  readonly structured: Record<string, unknown>;
}

export class FakeWorker {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (message: RpcResponse) => void>();
  readonly stderr: string[] = [];
  #nextId = 1;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      if (typeof parsed.id === 'number') this.#pending.get(parsed.id)?.(parsed);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  static spawn(socketPath: string, token: string): FakeWorker {
    const child = spawn(process.execPath, [bridgeEntryPath()], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WORKFORCE_BRIDGE_SOCKET: socketPath, WORKFORCE_BRIDGE_TOKEN: token },
    }) as ChildProcessWithoutNullStreams;
    return new FakeWorker(child);
  }

  /** Write a raw line to the bridge: prose, an imitation tool call, anything. */
  writeRaw(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.#nextId++;
    const frame: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame['params'] = params;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 10s; stderr: ${this.stderr.join('')}`)), 10_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(message);
      });
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  async initialize(): Promise<RpcResponse> {
    const response = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-worker', version: '1' } });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return response;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result;
    if (result === undefined) throw new Error(`tools/call ${name} failed: ${JSON.stringify(response.error)}`);
    return { isError: result['isError'] === true, structured: (result['structuredContent'] ?? {}) as Record<string, unknown> };
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL');
        resolve();
      }, 5_000);
      this.#child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
