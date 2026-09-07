/**
 * JSON-RPC client for the Codex app-server stdio transport
 * (`codex app-server --stdio`, equivalently `--listen stdio://`).
 *
 * Responsibilities, all of which the adapter above it depends on:
 *   - spawn the server in its own process group with `shell: false`;
 *   - frame newline-delimited JSON, buffering partial lines across chunks;
 *   - correlate responses to requests, with a Node-implemented deadline
 *     (there is no `timeout(1)` on the target machine);
 *   - expose notifications as an async stream that never drops a frame a
 *     consumer has not read yet;
 *   - answer every server -> client request from an explicit policy. Approval
 *     and elicitation requests are escalations by definition, so the default
 *     policy denies them and no policy can be configured to approve one;
 *   - tolerate unknown methods and unknown fields;
 *   - shut down cleanly: close stdin, wait, then signal the process group.
 *
 * Nothing here knows about runs, tasks or attempts; that is the adapter's job.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nowIso } from '../../core/ids.js';
import { isProcessAlive, isProcessGroupAlive, newSpawnToken, observeProcessIdentity, type ProcessIdentity } from '../../core/process.js';
import {
  CLIENT_METHOD,
  INITIALIZED_NOTIFICATION,
  SERVER_REQUEST,
  decodeFrame,
  type DecodedFrame,
  type RequestId,
  type RpcErrorBody,
} from './protocol.js';

export const DEFAULT_APP_SERVER_ARGS: ReadonlyArray<string> = ['app-server', '--stdio'];

/** Environment variables a worker process inherits. Never the coordinator's full environment. */
const INHERITED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const;

export interface RawRecord {
  /** `out`: coordinator -> server. `in`: server -> coordinator. */
  readonly dir: 'out' | 'in' | 'stderr';
  /** Milliseconds since the client was constructed; makes recorded transcripts replayable and timings honest. */
  readonly atMs: number;
  readonly line: string;
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, body: RpcErrorBody) {
    super(`codex ${method} failed: ${body.message} (code ${body.code})`);
    this.name = 'CodexRpcError';
    this.code = body.code;
    this.data = body.data;
    this.method = method;
  }
}

export class CodexTransportError extends Error {
  readonly reason: 'timeout' | 'closed' | 'spawn_failed';

  constructor(reason: 'timeout' | 'closed' | 'spawn_failed', message: string) {
    super(message);
    this.name = 'CodexTransportError';
    this.reason = reason;
  }
}

/**
 * How a server -> client request is answered.
 *
 * Every entry is a refusal. Approvals exist so a human can widen a worker's
 * reach mid-turn; a coordinator that answers them automatically has silently
 * broadened the execution profile, which plan section 8 forbids ("Do not
 * silently broaden a profile because a check fails"). The adapter therefore
 * denies and records, and a run that needs more reach must be configured with
 * more reach before it starts.
 */
export interface ServerRequestDecision {
  /** JSON-RPC result to return, or `null` to answer with a JSON-RPC error instead. */
  readonly result: unknown | null;
  readonly denied: boolean;
  readonly reason: string;
}

const DENY_REASON = 'workforce policy: the coordinator never approves an escalation mid-turn; configure the run with the access it needs before it starts';

export function denyServerRequest(method: string): ServerRequestDecision {
  switch (method) {
    case SERVER_REQUEST.commandExecutionApproval:
      // CommandExecutionApprovalDecision: `decline` refuses this command but lets the turn continue.
      return { result: { decision: 'decline' }, denied: true, reason: DENY_REASON };
    case SERVER_REQUEST.fileChangeApproval:
      return { result: { decision: 'decline' }, denied: true, reason: DENY_REASON };
    case SERVER_REQUEST.legacyExecCommandApproval:
    case SERVER_REQUEST.legacyApplyPatchApproval:
      // ReviewDecision: the object form carries the rejection text back to the model.
      return { result: { decision: { denied: { rejection: DENY_REASON } } }, denied: true, reason: DENY_REASON };
    case SERVER_REQUEST.permissionsApproval:
      // GrantedPermissionProfile with no entries grants nothing, for this turn only.
      return { result: { permissions: {}, scope: 'turn' }, denied: true, reason: DENY_REASON };
    case SERVER_REQUEST.mcpElicitation:
      return { result: { action: 'decline' }, denied: true, reason: DENY_REASON };
    case SERVER_REQUEST.toolUserInput:
      // No answers: the coordinator is not the user and must not invent intent (plan section 7).
      return { result: { answers: {} }, denied: true, reason: 'workforce policy: required user intent is routed to the human decision queue, never answered by the coordinator' };
    case SERVER_REQUEST.toolCall:
      return { result: { success: false, contentItems: [{ type: 'inputText', text: DENY_REASON }] }, denied: true, reason: DENY_REASON };
    default:
      // Includes credential and attestation requests: answered with an error, never with data.
      return { result: null, denied: true, reason: `workforce policy: unhandled server request "${method}" is refused` };
  }
}

export interface CodexRpcOptions {
  readonly executablePath: string;
  /** Defaults to `app-server --stdio`. Extra `-c key=value` overrides may be prefixed by the caller. */
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Raw capture of every framed line in both directions, plus stderr. */
  readonly onRaw?: (record: RawRecord) => void;
  /** Overrides the refusal payload per method; it cannot be used to approve (see `answerServerRequest`). */
  readonly serverRequestPolicy?: (method: string, params: unknown) => ServerRequestDecision;
}

export interface ServerRequestRecord {
  readonly id: RequestId;
  readonly method: string;
  readonly params: unknown;
  readonly decision: ServerRequestDecision;
  readonly at: string;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** A frame the client could not decode; kept as evidence instead of being dropped. */
export interface UndecodableFrame {
  readonly reason: string;
  readonly line: string;
  readonly at: string;
}

export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
  /** Monotonic per client instance, starting at 1. */
  readonly sequence: number;
  readonly at: string;
}

/**
 * Buffered async stream. Notifications are queued from the moment the client
 * starts, so a consumer that attaches after `thread/start` still sees every
 * frame; each consumer reads the whole buffer from its own cursor.
 */
class NotificationBuffer {
  readonly #items: CodexNotification[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  get length(): number {
    return this.#items.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  at(index: number): CodexNotification | undefined {
    return this.#items[index];
  }

  push(item: CodexNotification): void {
    this.#items.push(item);
    this.wake();
  }

  close(): void {
    this.#closed = true;
    this.wake();
  }

  wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolves when a new item arrives, the stream closes, or `timeoutMs` elapses. */
  wait(timeoutMs: number): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export class CodexRpcClient {
  readonly #options: Required<Pick<CodexRpcOptions, 'executablePath' | 'args' | 'cwd' | 'requestTimeoutMs' | 'stopTimeoutMs'>> &
    Pick<CodexRpcOptions, 'env' | 'onRaw' | 'serverRequestPolicy'>;
  readonly #pending = new Map<string, Pending>();
  readonly #notifications = new NotificationBuffer();
  readonly #serverRequests: ServerRequestRecord[] = [];
  readonly #undecodable: UndecodableFrame[] = [];
  readonly #stderr: string[] = [];
  readonly #emitter = new EventEmitter();
  readonly #startedAtMs = Date.now();

  #child: ChildProcess | null = null;
  #identity: ProcessIdentity | null = null;
  #stdoutRemainder = '';
  #stderrRemainder = '';
  #nextId = 0;
  #sequence = 0;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #closeReason: string | null = null;

  constructor(options: CodexRpcOptions) {
    this.#options = {
      executablePath: options.executablePath,
      args: options.args ?? DEFAULT_APP_SERVER_ARGS,
      cwd: options.cwd,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.onRaw !== undefined ? { onRaw: options.onRaw } : {}),
      ...(options.serverRequestPolicy !== undefined ? { serverRequestPolicy: options.serverRequestPolicy } : {}),
    };
    // Nothing else listens for 'exit'; the emitter is an internal wake-up channel.
    this.#emitter.setMaxListeners(0);
  }

  get process(): ProcessIdentity | null {
    return this.#identity;
  }

  get pid(): number | null {
    return this.#identity?.pid ?? null;
  }

  get exited(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.#exit;
  }

  get notificationCount(): number {
    return this.#notifications.length;
  }

  get serverRequests(): ReadonlyArray<ServerRequestRecord> {
    return this.#serverRequests;
  }

  get undecodableFrames(): ReadonlyArray<UndecodableFrame> {
    return this.#undecodable;
  }

  get stderrLines(): ReadonlyArray<string> {
    return this.#stderr;
  }

  /** Spawn the app server. The process is its own group leader so the whole tool tree can be stopped later. */
  start(): ProcessIdentity {
    if (this.#child !== null) throw new CodexTransportError('spawn_failed', 'client already started');
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.#options.env ?? {});

    const spawnToken = newSpawnToken();
    const child = spawn(this.#options.executablePath, [...this.#options.args], {
      cwd: this.#options.cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) throw new CodexTransportError('spawn_failed', `could not spawn ${this.#options.executablePath}`);
    this.#child = child;
    this.#identity = observeProcessIdentity(child.pid, spawnToken);
    this.#wire(child);
    return this.#identity;
  }

  #wire(child: ChildProcess): void {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.#stdoutRemainder += chunk;
      let newline = this.#stdoutRemainder.indexOf('\n');
      while (newline >= 0) {
        const line = this.#stdoutRemainder.slice(0, newline).replace(/\r$/, '');
        this.#stdoutRemainder = this.#stdoutRemainder.slice(newline + 1);
        this.#ingest(line);
        newline = this.#stdoutRemainder.indexOf('\n');
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.#stderrRemainder += chunk;
      let newline = this.#stderrRemainder.indexOf('\n');
      while (newline >= 0) {
        const line = this.#stderrRemainder.slice(0, newline);
        this.#stderrRemainder = this.#stderrRemainder.slice(newline + 1);
        if (line.length > 0) {
          this.#stderr.push(line);
          this.#raw('stderr', line);
        }
        newline = this.#stderrRemainder.indexOf('\n');
      }
    });
    child.stdin!.on('error', () => {
      // EPIPE after the server exited; the exit handler reports the real reason.
    });
    child.on('exit', (code, signal) => {
      // A final line without its newline is still evidence: ingest it before closing.
      if (this.#stdoutRemainder.trim().length > 0) {
        this.#ingest(this.#stdoutRemainder);
        this.#stdoutRemainder = '';
      }
      if (this.#stderrRemainder.trim().length > 0) {
        this.#stderr.push(this.#stderrRemainder);
        this.#raw('stderr', this.#stderrRemainder);
        this.#stderrRemainder = '';
      }
      this.#exit = { code, signal };
      this.#failAllPending(new CodexTransportError('closed', `codex app-server exited (code ${String(code)}, signal ${String(signal)})`));
      this.#notifications.close();
      this.#emitter.emit('exit');
    });
    child.on('error', (error) => {
      this.#exit = { code: null, signal: null };
      this.#closeReason = error.message;
      this.#failAllPending(new CodexTransportError('spawn_failed', `codex app-server failed: ${error.message}`));
      this.#notifications.close();
      this.#emitter.emit('exit');
    });
  }

  #raw(dir: RawRecord['dir'], line: string): void {
    this.#options.onRaw?.({ dir, atMs: Date.now() - this.#startedAtMs, line });
  }

  #ingest(line: string): void {
    if (line.trim().length === 0) return;
    this.#raw('in', line);
    const frame = decodeFrame(line);
    switch (frame.kind) {
      case 'response':
      case 'error':
        this.#settle(frame);
        return;
      case 'notification':
        this.#sequence += 1;
        this.#notifications.push({ method: frame.method, params: frame.params, sequence: this.#sequence, at: nowIso() });
        return;
      case 'server_request':
        this.#answerServerRequest(frame.id, frame.method, frame.params);
        return;
      case 'undecodable':
        this.#undecodable.push({ reason: frame.reason, line, at: nowIso() });
        return;
      default: {
        const never: never = frame;
        throw new Error(`unhandled frame ${String(never)}`);
      }
    }
  }

  #settle(frame: Extract<DecodedFrame, { kind: 'response' | 'error' }>): void {
    const key = String(frame.id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      // A late or duplicate response for a request we already gave up on.
      this.#undecodable.push({ reason: `response for unknown request id ${key}`, line: JSON.stringify(frame), at: nowIso() });
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    if (frame.kind === 'error') pending.reject(new CodexRpcError(pending.method, frame.error));
    else pending.resolve(frame.result);
  }

  /**
   * Answer a server -> client request. The policy hook may only change the
   * shape of a refusal: a decision that claims not to be denied is discarded
   * and the built-in denial is sent instead, so no configuration mistake can
   * turn this client into an auto-approver.
   */
  #answerServerRequest(id: RequestId, method: string, params: unknown): void {
    const proposed = this.#options.serverRequestPolicy?.(method, params);
    const decision = proposed !== undefined && proposed.denied ? proposed : denyServerRequest(method);
    this.#serverRequests.push({ id, method, params, decision, at: nowIso() });
    if (decision.result === null) {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32601, message: decision.reason } });
    } else {
      this.#write({ jsonrpc: '2.0', id, result: decision.result });
    }
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === null || this.#exit !== null || !child.stdin || child.stdin.destroyed) {
      throw new CodexTransportError('closed', `codex app-server is not accepting input${this.#closeReason ? ` (${this.#closeReason})` : ''}`);
    }
    const line = JSON.stringify(message);
    this.#raw('out', line);
    child.stdin.write(`${line}\n`);
  }

  #failAllPending(error: Error): void {
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** Send a request and await its response. Rejects with `CodexTransportError('timeout')` past the deadline. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    this.#nextId += 1;
    const id = this.#nextId;
    const key = String(id);
    const deadline = timeoutMs ?? this.#options.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new CodexTransportError('timeout', `codex ${method} did not answer within ${deadline}ms`));
      }, deadline);
      this.#pending.set(key, { method, resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(key);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** `initialize` followed by the `initialized` notification, as the installed protocol requires. */
  async initialize(clientName: string, clientVersion: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.request(CLIENT_METHOD.initialize, { clientInfo: { name: clientName, version: clientVersion } }, timeoutMs);
    this.notify(INITIALIZED_NOTIFICATION);
    return result;
  }

  /**
   * Every notification from `startIndex` onwards, as an async stream.
   * The iterator ends when the process exits; `stop()` therefore always
   * terminates a consumer.
   */
  async *notifications(startIndex = 0, idleTimeoutMs = 1_000): AsyncGenerator<CodexNotification> {
    let index = startIndex;
    for (;;) {
      while (index < this.#notifications.length) {
        const item = this.#notifications.at(index);
        index += 1;
        if (item !== undefined) yield item;
      }
      if (this.#exit !== null) return;
      await this.#notifications.wait(idleTimeoutMs);
    }
  }

  /** Wait for the first notification at or after `fromIndex` that matches. Resolves to null on timeout or exit. */
  async waitForNotification(predicate: (n: CodexNotification) => boolean, timeoutMs: number, fromIndex = 0): Promise<CodexNotification | null> {
    const deadline = Date.now() + timeoutMs;
    let index = fromIndex;
    for (;;) {
      while (index < this.#notifications.length) {
        const item = this.#notifications.at(index);
        index += 1;
        if (item !== undefined && predicate(item)) return item;
      }
      if (this.#exit !== null) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.#notifications.wait(remaining);
    }
  }

  /**
   * Close stdin, give the server a bounded chance to exit, then signal its
   * process group: SIGTERM, and SIGKILL if the group still has members.
   * Reports what was actually observed rather than what was requested.
   */
  async stop(): Promise<{ readonly signalled: NodeJS.Signals | null; readonly exited: boolean; readonly groupAlive: boolean }> {
    const child = this.#child;
    if (child === null) return { signalled: null, exited: true, groupAlive: false };
    const pid = this.#identity?.pid ?? child.pid ?? null;

    if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    }
    // The app server spawns its own children (configured MCP servers among
    // them) into our process group, so "the server exited" is not the same as
    // "the tree is gone"; both must hold before we stop without signalling.
    const graceful = Math.min(this.#options.stopTimeoutMs, 1_000);
    if (await this.#awaitExit(graceful, () => pid === null || !isProcessGroupAlive(pid))) {
      return { signalled: null, exited: true, groupAlive: false };
    }
    if (pid === null) return { signalled: null, exited: this.#exit !== null, groupAlive: false };

    let signalled: NodeJS.Signals | null = null;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!isProcessGroupAlive(pid) && !isProcessAlive(pid)) break;
      try {
        process.kill(-pid, signal);
        signalled = signal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await this.#awaitExit(this.#options.stopTimeoutMs, () => !isProcessGroupAlive(pid));
      if (this.#exit !== null && !isProcessGroupAlive(pid)) break;
    }
    return { signalled, exited: this.#exit !== null, groupAlive: isProcessGroupAlive(pid) };
  }

  #awaitExit(timeoutMs: number, alsoRequire: () => boolean = () => true): Promise<boolean> {
    if (this.#exit !== null && alsoRequire()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = (): void => {
        if (this.#exit !== null && alsoRequire()) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, 25);
      };
      this.#emitter.once('exit', () => setTimeout(check, 0));
      check();
    });
  }
}
