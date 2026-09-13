/**
 * Process transport for the Claude Code CLI in programmatic mode.
 *
 * Responsibilities, all of which the adapter above it depends on:
 *   - spawn `claude` in its own process group with `shell: false` and a
 *     sanitized environment (the coordinator's own environment carries
 *     `CLAUDE_CODE_*` variables that reconfigure a child session);
 *   - frame newline-delimited JSON on stdout, buffering partial lines across
 *     chunks and keeping non-JSON lines as evidence instead of throwing (the
 *     CLI does print bare text: `No conversation found with session ID: …`);
 *   - write newline-delimited JSON to stdin. A line the CLI cannot parse makes
 *     it log `Error parsing streaming input line` and exit, so encoding is
 *     centralised here and nothing else is ever written;
 *   - correlate `control_request` frames with their `control_response`, with a
 *     Node-implemented deadline (there is no `timeout(1)` on the target
 *     machine);
 *   - expose records as a buffered async stream that never drops a frame a
 *     consumer has not read yet;
 *   - shut down: close stdin, wait, then SIGTERM and SIGKILL the process group,
 *     reporting what was observed rather than what was requested.
 *
 * Nothing here knows about runs, tasks or attempts; that is the adapter's job.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nowIso, randomToken } from '../../core/ids.js';
import { isProcessAlive, isProcessGroupAlive, newSpawnToken, observeProcessIdentity, type ProcessIdentity } from '../../core/process.js';
import { CONTROL_SUBTYPE, ControlResponseSchema, controlRequestFrame, decodeStreamLine, userFrame, type DecodedLine, type UserContentBlock } from './protocol.js';

/**
 * Environment variables a worker process inherits. Never the coordinator's own
 * environment: a coordinator that is itself running under Claude Code exports
 * `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
 * `ANTHROPIC_BASE_URL` and more, and a child that inherits them is not the
 * session we configured.
 */
const INHERITED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'] as const;

export interface RawRecord {
  /** `out`: coordinator -> CLI stdin. `in`: CLI stdout -> coordinator. `stderr`: the CLI's stderr. */
  readonly dir: 'out' | 'in' | 'stderr';
  /** Milliseconds since the transport was constructed; makes recorded transcripts replayable and timings honest. */
  readonly atMs: number;
  readonly line: string;
}

export class ClaudeTransportError extends Error {
  readonly reason: 'timeout' | 'closed' | 'spawn_failed' | 'control_error';

  constructor(reason: ClaudeTransportError['reason'], message: string) {
    super(message);
    this.name = 'ClaudeTransportError';
    this.reason = reason;
  }
}

export interface StreamRecord {
  readonly decoded: DecodedLine;
  /** Monotonic per transport instance, starting at 1. */
  readonly sequence: number;
  readonly at: string;
}

/** Buffered async stream; each consumer reads from its own cursor so nothing is dropped. */
class RecordBuffer {
  readonly #items: StreamRecord[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  get length(): number {
    return this.#items.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  at(index: number): StreamRecord | undefined {
    return this.#items[index];
  }

  push(item: StreamRecord): void {
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

export interface ClaudeTransportOptions {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Extra environment entries merged over the inherited allowlist. */
  readonly env?: Readonly<Record<string, string>>;
  readonly controlTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onRaw?: (record: RawRecord) => void;
}

interface PendingControl {
  readonly subtype: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface StopOutcome {
  readonly signalled: NodeJS.Signals | null;
  readonly exited: boolean;
  readonly groupAlive: boolean;
}

export class ClaudeTransport {
  readonly #options: Required<Pick<ClaudeTransportOptions, 'executablePath' | 'args' | 'cwd' | 'controlTimeoutMs' | 'stopTimeoutMs'>> & Pick<ClaudeTransportOptions, 'env' | 'onRaw'>;
  readonly #records = new RecordBuffer();
  readonly #pending = new Map<string, PendingControl>();
  readonly #stderr: string[] = [];
  readonly #emitter = new EventEmitter();
  readonly #startedAtMs = Date.now();

  #child: ChildProcess | null = null;
  #identity: ProcessIdentity | null = null;
  #stdoutRemainder = '';
  #stderrRemainder = '';
  #sequence = 0;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #spawnFailure: string | null = null;

  constructor(options: ClaudeTransportOptions) {
    this.#options = {
      executablePath: options.executablePath,
      args: options.args,
      cwd: options.cwd,
      controlTimeoutMs: options.controlTimeoutMs ?? 30_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.onRaw !== undefined ? { onRaw: options.onRaw } : {}),
    };
    this.#emitter.setMaxListeners(0);
  }

  get process(): ProcessIdentity | null {
    return this.#identity;
  }

  get exited(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.#exit;
  }

  get recordCount(): number {
    return this.#records.length;
  }

  get stderrLines(): ReadonlyArray<string> {
    return this.#stderr;
  }

  /** Spawn the CLI. The process is its own group leader so its whole tool tree can be stopped later. */
  start(): ProcessIdentity {
    if (this.#child !== null) throw new ClaudeTransportError('spawn_failed', 'transport already started');
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
    if (child.pid === undefined) throw new ClaudeTransportError('spawn_failed', `could not spawn ${this.#options.executablePath}`);
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
      // EPIPE after the CLI exited; the exit handler reports the real reason.
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
      this.#failAllPending(new ClaudeTransportError('closed', `claude exited (code ${String(code)}, signal ${String(signal)})`));
      this.#records.close();
      this.#emitter.emit('exit');
    });
    child.on('error', (error) => {
      this.#exit = { code: null, signal: null };
      this.#spawnFailure = error.message;
      this.#failAllPending(new ClaudeTransportError('spawn_failed', `claude failed to start: ${error.message}`));
      this.#records.close();
      this.#emitter.emit('exit');
    });
  }

  #raw(dir: RawRecord['dir'], line: string): void {
    this.#options.onRaw?.({ dir, atMs: Date.now() - this.#startedAtMs, line });
  }

  #ingest(line: string): void {
    if (line.trim().length === 0) return;
    this.#raw('in', line);
    const decoded = decodeStreamLine(line);
    if (decoded.kind === 'record' && decoded.type === 'control_response') {
      this.#settleControl(decoded.value);
      // The frame is still published: it is part of the evidence stream.
    }
    this.#sequence += 1;
    this.#records.push({ decoded, sequence: this.#sequence, at: nowIso() });
  }

  #settleControl(value: Record<string, unknown>): void {
    const parsed = ControlResponseSchema.safeParse(value);
    if (!parsed.success) return;
    const { request_id: requestId, subtype, error } = parsed.data.response;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (subtype === 'success') pending.resolve(parsed.data.response.response ?? null);
    else pending.reject(new ClaudeTransportError('control_error', `claude control request "${pending.subtype}" failed: ${JSON.stringify(error ?? subtype)}`));
  }

  #failAllPending(error: Error): void {
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** The only place a line is written to the CLI's stdin. Every frame is JSON-encoded here. */
  #write(frame: unknown): void {
    const child = this.#child;
    if (child === null || this.#exit !== null || !child.stdin || child.stdin.destroyed) {
      throw new ClaudeTransportError('closed', `claude is not accepting input${this.#spawnFailure !== null ? ` (${this.#spawnFailure})` : ''}`);
    }
    const line = JSON.stringify(frame);
    this.#raw('out', line);
    child.stdin.write(`${line}\n`);
  }

  /** Submit a user message. Returns the text that was written, for correlation with its `--replay-user-messages` echo. */
  sendUserMessage(sessionId: string, content: string | ReadonlyArray<UserContentBlock>): void {
    this.#write(userFrame(sessionId, content));
  }

  /** Send a control request and await its `control_response`. */
  control(subtype: string, extra: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const requestId = `wf_${randomToken(6)}`;
    const deadline = timeoutMs ?? this.#options.controlTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ClaudeTransportError('timeout', `claude control request "${subtype}" did not answer within ${deadline}ms`));
      }, deadline);
      this.#pending.set(requestId, { subtype, resolve, reject, timer });
      try {
        this.#write(controlRequestFrame(requestId, subtype, extra));
      } catch (error) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  /** `control_request { subtype: "initialize" }`. Starts no model turn; returns the CLI's own capability report. */
  initialize(timeoutMs?: number): Promise<unknown> {
    return this.control(CONTROL_SUBTYPE.initialize, {}, timeoutMs);
  }

  /** `control_request { subtype: "interrupt" }`. Returns `{ still_queued: [...] }` on this build. */
  interrupt(timeoutMs?: number): Promise<unknown> {
    return this.control(CONTROL_SUBTYPE.interrupt, {}, timeoutMs);
  }

  /** Every record from `startIndex` onwards. The iterator ends when the process exits, so `stop()` always terminates a consumer. */
  async *records(startIndex = 0, idleTimeoutMs = 250): AsyncGenerator<StreamRecord> {
    let index = startIndex;
    for (;;) {
      while (index < this.#records.length) {
        const item = this.#records.at(index);
        index += 1;
        if (item !== undefined) yield item;
      }
      if (this.#exit !== null) return;
      await this.#records.wait(idleTimeoutMs);
    }
  }

  /**
   * Close stdin, give the CLI a bounded chance to exit, then signal its process
   * group: SIGTERM, then SIGKILL if the group still has members. Reports what
   * was observed, not what was requested.
   */
  async stop(): Promise<StopOutcome> {
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
    // "the CLI exited" is not "the tree is gone": tool subprocesses live in the
    // same group, so both must hold before we stop without signalling.
    const graceful = Math.min(this.#options.stopTimeoutMs, 1_500);
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
