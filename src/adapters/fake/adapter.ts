/**
 * FakeAdapter: drives fixtures/fake-runtime/fake-runtime.mjs through the
 * RuntimeAdapter contract. It is the deterministic runtime for lifecycle,
 * containment and recovery tests, and the reference for real adapters:
 * owned process groups, normalized events with raw references, partial and
 * malformed line tolerance, receipts that distinguish requested from
 * observed, and reconciliation from process identity.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { newId, nowIso } from '../../core/ids.js';
import { isWithin } from '../../storage/paths.js';
import {
  AdapterError,
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityReport,
  type DeliveryInput,
  type DeliveryReceipt,
  type InterruptionReceipt,
  type ObservedRuntimeState,
  type ResumeInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeReadiness,
  type SessionHandle,
  type SessionInput,
  type StopReceipt,
  type TurnHandle,
  type TurnInput,
} from '../types.js';

export const FAKE_RUNTIME_VERSION = 'fake-runtime/1';
export const FAKE_SCENARIO_ENV = 'WORKFORCE_FAKE_SCENARIO';

export function defaultFakeRuntimeScript(): string {
  return fileURLToPath(new URL('../../../fixtures/fake-runtime/fake-runtime.mjs', import.meta.url));
}

export interface FakeAdapterOptions {
  readonly scriptPath?: string;
  readonly scenarioPath?: string;
  readonly nodeExecutable?: string;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  /** Raw stream capture hook (every stdout/stderr line before normalization). */
  readonly onRawLine?: (sessionId: string, stream: 'stdout' | 'stderr', line: string) => void;
}

const RawEventSchema = z.looseObject({ event: z.string().min(1), turnId: z.string().nullish() });

const KIND_BY_EVENT: Readonly<Record<string, RuntimeEventKind>> = {
  session_started: 'session_started',
  turn_started: 'turn_started',
  assistant_message: 'assistant_message',
  tool_call: 'tool_call',
  tool_result: 'tool_result',
  file_change: 'file_change',
  command_exec: 'command_exec',
  turn_completed: 'turn_completed',
  turn_interrupted: 'turn_interrupted',
  error: 'error',
};

interface FakeSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly allowedWritePaths: ReadonlyArray<string>;
  child: ChildProcess;
  pid: number;
  handle: SessionHandle;
  readonly buffer: RuntimeEvent[];
  waiters: Array<() => void>;
  sequence: number;
  lineNo: number;
  activeTurnId: string | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stdoutRemainder: string;
  readonly stderrLines: string[];
}

interface FakeHandleRaw {
  readonly kind: 'fake-session';
  readonly cwd: string;
}

/**
 * Canonical absolute path for containment checks: symlinked temp roots
 * (macOS `/var` -> `/private/var`) must not make an in-workspace edit look
 * like an escape. Falls back to the parent's realpath for files that do not
 * exist yet, then to plain resolution.
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FakeAdapter implements RuntimeAdapter {
  readonly id = 'fake' as const;
  readonly #options: Required<Pick<FakeAdapterOptions, 'scriptPath' | 'nodeExecutable' | 'startupTimeoutMs' | 'stopTimeoutMs' | 'interruptTimeoutMs'>> &
    Pick<FakeAdapterOptions, 'scenarioPath' | 'onRawLine'>;
  readonly #sessions = new Map<string, FakeSession>();

  constructor(options: FakeAdapterOptions = {}) {
    this.#options = {
      scriptPath: options.scriptPath ?? defaultFakeRuntimeScript(),
      nodeExecutable: options.nodeExecutable ?? process.execPath,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
      interruptTimeoutMs: options.interruptTimeoutMs ?? 1_000,
      ...(options.scenarioPath !== undefined ? { scenarioPath: options.scenarioPath } : {}),
      ...(options.onRawLine !== undefined ? { onRawLine: options.onRawLine } : {}),
    };
  }

  async probe(executablePath: string): Promise<RuntimeReadiness> {
    const observedAt = nowIso();
    const diagnostics: string[] = [];
    let installed = false;
    try {
      installed = statSync(executablePath).isFile();
    } catch {
      diagnostics.push(`fake runtime script not found at ${executablePath}`);
    }
    if (!installed) {
      return { adapter: 'fake', executablePath, installed: false, version: null, adapterSupported: true, controllable: false, authentication: 'not_required', ready: 'not_ready', probeKind: 'passive', diagnostics, observedAt };
    }
    const version = await new Promise<string | null>((resolve) => {
      execFile(this.#options.nodeExecutable, [executablePath, '--version'], { timeout: 5_000, cwd: path.dirname(executablePath) }, (error, stdout) => {
        if (error) {
          diagnostics.push(`version probe failed: ${error.message}`);
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });
    });
    const controllable = version === FAKE_RUNTIME_VERSION;
    if (version !== null && !controllable) diagnostics.push(`unexpected fake runtime version "${version}" (expected ${FAKE_RUNTIME_VERSION})`);
    return {
      adapter: 'fake',
      executablePath,
      installed,
      version,
      adapterSupported: true,
      controllable,
      authentication: 'not_required',
      ready: controllable ? 'verified_ready' : 'not_ready',
      probeKind: 'passive',
      diagnostics,
      observedAt,
    };
  }

  capabilities(): RuntimeCapabilities {
    const report: CapabilityReport = { status: 'verified', testedVersion: FAKE_RUNTIME_VERSION, os: process.platform };
    const capabilities = {} as Record<CapabilityName, CapabilityReport>;
    for (const name of CAPABILITY_NAMES) capabilities[name] = report;
    capabilities.usage_reporting = { status: 'unsupported', testedVersion: FAKE_RUNTIME_VERSION, os: process.platform, note: 'fake runtime has no model usage' };
    capabilities.coordination_bridge = { status: 'unsupported', testedVersion: FAKE_RUNTIME_VERSION, os: process.platform, note: 'bridge arrives with WP06' };
    return { adapter: 'fake', capabilities };
  }

  async openSession(input: SessionInput): Promise<SessionHandle> {
    return this.#spawnSession(input, null);
  }

  async resumeSession(input: ResumeInput): Promise<SessionHandle> {
    const existing = this.#sessions.get(input.sessionId);
    if (existing !== undefined && existing.exit === null && processAlive(existing.pid)) {
      throw new AdapterError('fake', 'session_active', `session ${input.sessionId} still has a live process ${existing.pid}; stop it before resuming`);
    }
    return this.#spawnSession(input, input.sessionId);
  }

  async #spawnSession(input: SessionInput, resumeSessionId: string | null): Promise<SessionHandle> {
    const scenarioPath = input.env?.[FAKE_SCENARIO_ENV] ?? this.#options.scenarioPath;
    const args = [this.#options.scriptPath];
    if (scenarioPath !== undefined) args.push('--scenario', scenarioPath);
    if (resumeSessionId !== null) args.push('--session', resumeSessionId);

    // Workers get a minimal environment: never the coordinator's full env.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, input.env ?? {});

    const child = spawn(this.#options.nodeExecutable, args, {
      cwd: input.cwd,
      env,
      shell: false,
      detached: true, // own process group so the whole tree can be terminated
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) throw new AdapterError('fake', 'spawn_failed', 'child process has no pid');

    const pendingId = resumeSessionId ?? `pending-${child.pid}`;
    const session: FakeSession = {
      sessionId: pendingId,
      cwd: input.cwd,
      allowedWritePaths: input.allowedWritePaths.map(canonicalPath),
      child,
      pid: child.pid,
      handle: { adapter: 'fake', sessionId: pendingId, processId: child.pid, raw: { kind: 'fake-session', cwd: input.cwd } satisfies FakeHandleRaw },
      buffer: [],
      waiters: [],
      sequence: 0,
      lineNo: 0,
      activeTurnId: null,
      exit: null,
      stdoutRemainder: '',
      stderrLines: [],
    };
    this.#wire(session);

    const started = await this.#waitFor(session, (event) => event.kind === 'session_started', this.#options.startupTimeoutMs);
    if (started === null) {
      await this.#terminateGroup(session);
      const stderr = session.stderrLines.slice(-5).join(' | ');
      throw new AdapterError('fake', 'startup_failed', `fake runtime did not report session_started within ${this.#options.startupTimeoutMs}ms${stderr ? ` (stderr: ${stderr})` : ''}`);
    }
    const reported = started.payload['sessionId'];
    const sessionId = typeof reported === 'string' && reported.length > 0 ? reported : pendingId;
    const finalSession: FakeSession = Object.assign(session, { sessionId, handle: { ...session.handle, sessionId } });
    // Re-key events (and their raw references) already buffered under the pending id.
    const pendingPrefix = `fake:${pendingId}:`;
    for (let i = 0; i < finalSession.buffer.length; i += 1) {
      const buffered = finalSession.buffer[i]!;
      const rawRef = buffered.rawRef.startsWith(pendingPrefix) ? `fake:${sessionId}:${buffered.rawRef.slice(pendingPrefix.length)}` : buffered.rawRef;
      finalSession.buffer[i] = { ...buffered, sessionId, rawRef };
    }
    this.#sessions.set(sessionId, finalSession);
    return finalSession.handle;
  }

  #wire(session: FakeSession): void {
    const { child } = session;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      session.stdoutRemainder += chunk;
      let newline = session.stdoutRemainder.indexOf('\n');
      while (newline >= 0) {
        const line = session.stdoutRemainder.slice(0, newline);
        session.stdoutRemainder = session.stdoutRemainder.slice(newline + 1);
        this.#ingestLine(session, line, false);
        newline = session.stdoutRemainder.indexOf('\n');
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.length === 0) continue;
        session.stderrLines.push(line);
        this.#options.onRawLine?.(session.sessionId, 'stderr', line);
      }
    });
    child.stdin!.on('error', () => {
      // EPIPE after the runtime exited: surfaced through the exit event instead.
    });
    child.on('exit', (code, signal) => {
      if (session.stdoutRemainder.length > 0) {
        this.#ingestLine(session, session.stdoutRemainder, true);
        session.stdoutRemainder = '';
      }
      session.exit = { code, signal };
      this.#push(session, 'error', session.activeTurnId, {
        fatal: true,
        reason: 'process_exited',
        exitCode: code,
        signal,
        expected: session.activeTurnId === null,
      }, `fake:${session.sessionId}:exit`);
      session.activeTurnId = null;
      this.#wake(session);
    });
    child.on('error', (error) => {
      this.#push(session, 'error', session.activeTurnId, { fatal: true, reason: 'spawn_error', message: error.message }, `fake:${session.sessionId}:spawn`);
      session.exit = { code: null, signal: null };
      this.#wake(session);
    });
  }

  #ingestLine(session: FakeSession, line: string, partial: boolean): void {
    session.lineNo += 1;
    const rawRef = `fake:${session.sessionId}:${session.lineNo}`;
    this.#options.onRawLine?.(session.sessionId, 'stdout', line);
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#push(session, 'raw', session.activeTurnId, { malformed: true, partial, line }, rawRef);
      return;
    }
    const result = RawEventSchema.safeParse(parsed);
    if (!result.success) {
      this.#push(session, 'raw', session.activeTurnId, { malformed: true, partial, line, reason: 'missing event name' }, rawRef);
      return;
    }
    const { event: name, turnId, ...rest } = result.data;
    const kind = KIND_BY_EVENT[name];
    const effectiveTurn = typeof turnId === 'string' ? turnId : null;
    if (kind === undefined) {
      this.#push(session, 'raw', effectiveTurn, { fakeEvent: name, ...rest }, rawRef);
      return;
    }
    const payload: Record<string, unknown> = { ...rest };
    if (kind === 'file_change' && typeof rest['path'] === 'string') {
      const changed = canonicalPath(rest['path'] as string);
      payload['withinAllowedPaths'] = session.allowedWritePaths.some((root) => isWithin(root, changed));
    }
    if (kind === 'turn_completed' || kind === 'turn_interrupted') {
      if (session.activeTurnId === effectiveTurn) session.activeTurnId = null;
    }
    this.#push(session, kind, effectiveTurn, payload, rawRef);
  }

  #push(session: FakeSession, kind: RuntimeEventKind, turnId: string | null, payload: Record<string, unknown>, rawRef: string): void {
    session.sequence += 1;
    session.buffer.push({ kind, adapter: 'fake', sessionId: session.sessionId, turnId, sequence: session.sequence, timestamp: nowIso(), payload, rawRef });
    this.#wake(session);
  }

  #wake(session: FakeSession): void {
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async #waitFor(session: FakeSession, predicate: (event: RuntimeEvent) => boolean, timeoutMs: number): Promise<RuntimeEvent | null> {
    const deadline = Date.now() + timeoutMs;
    let index = 0;
    for (;;) {
      for (; index < session.buffer.length; index += 1) {
        const event = session.buffer[index]!;
        if (predicate(event)) return event;
      }
      if (session.exit !== null) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        session.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  #session(handle: SessionHandle): FakeSession {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) throw new AdapterError('fake', 'unknown_session', `session ${handle.sessionId} is not owned by this adapter instance`);
    return session;
  }

  #send(session: FakeSession, command: Record<string, unknown>): void {
    if (session.exit !== null || !session.child.stdin || session.child.stdin.destroyed) {
      throw new AdapterError('fake', 'session_closed', `session ${session.sessionId} process has exited`);
    }
    session.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async startTurn(handle: SessionHandle, input: TurnInput): Promise<TurnHandle> {
    const session = this.#session(handle);
    if (session.activeTurnId !== null) {
      throw new AdapterError('fake', 'turn_active', `session ${session.sessionId} already has active turn ${session.activeTurnId}; only one turn may be active per session`);
    }
    const turnId = newId();
    session.activeTurnId = turnId;
    this.#send(session, { cmd: 'turn', turnId, prompt: input.prompt, contextRefs: input.contextRefs ?? [] });
    return { adapter: 'fake', sessionId: session.sessionId, turnId, startedAt: nowIso() };
  }

  async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
    const session = this.#session({ adapter: 'fake', sessionId: turn.sessionId, raw: null });
    let index = 0;
    for (;;) {
      while (index < session.buffer.length) {
        const event = session.buffer[index]!;
        index += 1;
        if (event.turnId !== null && event.turnId !== turn.turnId) continue;
        yield event;
        if (event.kind === 'turn_completed' || event.kind === 'turn_interrupted') return;
        if (event.kind === 'error' && event.payload['fatal'] === true) return;
      }
      if (session.exit !== null) return;
      await new Promise<void>((resolve) => session.waiters.push(resolve));
    }
  }

  async deliver(handle: SessionHandle, input: DeliveryInput): Promise<DeliveryReceipt> {
    const session = this.#session(handle);
    const activeTurn = session.activeTurnId;
    this.#send(session, { cmd: 'deliver', messageId: input.messageId, body: input.body, correlationId: input.correlationId ?? null });
    return { messageId: input.messageId, state: activeTurn === null ? 'queued' : 'submitted_to_active_turn', turnId: activeTurn, at: nowIso() };
  }

  async interrupt(turn: TurnHandle): Promise<InterruptionReceipt> {
    const session = this.#session({ adapter: 'fake', sessionId: turn.sessionId, raw: null });
    const alreadyEnded = session.buffer.some((e) => e.turnId === turn.turnId && (e.kind === 'turn_completed' || e.kind === 'turn_interrupted'));
    if (alreadyEnded) return { turnId: turn.turnId, state: 'observed', at: nowIso() };
    const startIndex = session.buffer.length;
    this.#send(session, { cmd: 'interrupt', turnId: turn.turnId });
    const requestedAt = nowIso();
    const observed = await this.#waitFor(
      session,
      (event) => event.sequence > startIndex && event.turnId === turn.turnId && (event.kind === 'turn_interrupted' || event.kind === 'turn_completed'),
      this.#options.interruptTimeoutMs,
    );
    return { turnId: turn.turnId, state: observed === null ? 'requested' : 'observed', at: observed === null ? requestedAt : nowIso() };
  }

  async stopOwnedProcesses(handle: SessionHandle): Promise<StopReceipt> {
    const session = this.#sessions.get(handle.sessionId);
    const pid = session?.pid ?? handle.processId ?? null;
    if (pid === null) return { sessionId: handle.sessionId, state: 'unknown', processId: null, signal: null, at: nowIso(), detail: 'no process id recorded' };
    if (session === undefined) {
      // Not spawned by this instance (for example after a coordinator restart): act on the recorded process group.
      return this.#terminateGroupByPid(handle.sessionId, pid);
    }
    return this.#terminateGroup(session);
  }

  async #terminateGroup(session: FakeSession): Promise<StopReceipt> {
    const receipt = await this.#terminateGroupByPid(session.sessionId, session.pid, session);
    if (session.child.stdin && !session.child.stdin.destroyed) session.child.stdin.destroy();
    return receipt;
  }

  async #terminateGroupByPid(sessionId: string, pid: number, session?: FakeSession): Promise<StopReceipt> {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGKILL'];
    let lastSignal: NodeJS.Signals | null = null;
    for (const signal of signals) {
      if (!processGroupAlive(pid) && !processAlive(pid)) break;
      try {
        process.kill(-pid, signal);
        lastSignal = signal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + this.#options.stopTimeoutMs;
      while (Date.now() < deadline) {
        const childDone = session === undefined ? !processAlive(pid) : session.exit !== null;
        if (childDone && !processGroupAlive(pid)) break;
        await delay(25);
      }
    }
    const treeDead = !processGroupAlive(pid) && !processAlive(pid) && (session === undefined || session.exit !== null);
    return {
      sessionId,
      state: lastSignal === null && treeDead ? 'process_tree_terminated' : treeDead ? 'process_tree_terminated' : lastSignal === null ? 'unknown' : 'requested',
      processId: pid,
      signal: lastSignal,
      at: nowIso(),
      ...(treeDead ? {} : { detail: `process group ${pid} still has members after ${signals.join('+')}` }),
    };
  }

  async reconcile(handle: SessionHandle): Promise<ObservedRuntimeState> {
    const session = this.#sessions.get(handle.sessionId);
    const pid = session?.pid ?? handle.processId ?? null;
    return {
      adapter: 'fake',
      sessionId: handle.sessionId,
      processId: pid,
      processAlive: pid === null ? 'unknown' : session?.exit !== null && session !== undefined ? false : processAlive(pid),
      processGroupAlive: pid === null ? 'unknown' : processGroupAlive(pid),
      activeTurnId: session?.activeTurnId ?? null,
      exitCode: session?.exit?.code ?? null,
      signal: session?.exit?.signal ?? null,
      lastEventSequence: session?.sequence ?? 0,
      observedAt: nowIso(),
    };
  }

  /** Test/diagnostic access to captured stderr lines for a session. */
  stderrOf(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.stderrLines ?? [];
  }
}
