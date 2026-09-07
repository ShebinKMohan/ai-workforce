/**
 * FakeAdapter: drives fixtures/fake-runtime/fake-runtime.mjs through the
 * RuntimeAdapter contract. It is the deterministic runtime for lifecycle,
 * containment and recovery tests, and the reference for real adapters:
 * owned process groups, a spawn token per process instance, normalized
 * events with raw references, partial and malformed line tolerance,
 * receipts that distinguish requested from observed, settings validated
 * before anything is spawned, and reconciliation from full process identity
 * (pid + start time + spawn token), never from a reusable pid alone.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { newId, nowIso } from '../../core/ids.js';
import { isProcessAlive, isProcessGroupAlive, matchProcessIdentity, newSpawnToken, observeProcessIdentity, type ProcessIdentity, type ProcessIdentityStatus } from '../../core/process.js';
import { isWithin } from '../../storage/paths.js';
import {
  AdapterError,
  CAPABILITY_NAMES,
  validateSettingsAgainst,
  type CapabilityName,
  type CapabilityReport,
  type DeliveryInput,
  type DeliveryReceipt,
  type EffectiveRuntimeSettings,
  type InterruptionReceipt,
  type ObservedRuntimeState,
  type RequestedSettings,
  type ResumeInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeReadiness,
  type RuntimeSettingsSupport,
  type SessionHandle,
  type SessionInput,
  type SettingsValidation,
  type StopReceipt,
  type TurnHandle,
  type TurnInput,
} from '../types.js';

export const FAKE_RUNTIME_VERSION = 'fake-runtime/1';
export const FAKE_SCENARIO_ENV = 'WORKFORCE_FAKE_SCENARIO';

/** What the fake runtime accepts; mirrors fixtures/fake-runtime/fake-runtime.mjs, which exits 64 on anything else. */
export const FAKE_SETTINGS: RuntimeSettingsSupport = {
  model: {
    offered: [
      { value: 'fake-default', provenance: 'reported', note: 'runtime default' },
      { value: 'fake-fast', provenance: 'reported' },
    ],
    exhaustive: true,
  },
  effort: {
    offered: [
      { value: 'low', provenance: 'configured' },
      { value: 'medium', provenance: 'configured', note: 'runtime default' },
      { value: 'high', provenance: 'configured' },
    ],
    exhaustive: true,
  },
};

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
  readonly identity: ProcessIdentity;
  handle: SessionHandle;
  readonly buffer: RuntimeEvent[];
  waiters: Array<() => void>;
  sequence: number;
  lineNo: number;
  activeTurnId: string | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stdoutRemainder: string;
  readonly stderrLines: string[];
  /** What the runtime echoed back in `session_started`, not what was requested (FR006). */
  effective: EffectiveRuntimeSettings;
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

function requestedSettings(input: SessionInput): RequestedSettings {
  return { ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
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
    return { adapter: 'fake', capabilities, settings: FAKE_SETTINGS };
  }

  validateSettings(requested: RequestedSettings): SettingsValidation {
    return validateSettingsAgainst('fake', FAKE_SETTINGS, requested);
  }

  async openSession(input: SessionInput): Promise<SessionHandle> {
    return this.#spawnSession(input, null);
  }

  async resumeSession(input: ResumeInput): Promise<SessionHandle> {
    const existing = this.#sessions.get(input.sessionId);
    if (existing !== undefined && existing.exit === null && isProcessAlive(existing.identity.pid)) {
      throw new AdapterError('fake', 'session_active', `session ${input.sessionId} still has a live process ${existing.identity.pid}; stop it before resuming`);
    }
    const previous = input.previousProcess ?? null;
    if (previous !== null) {
      // A restarted coordinator knows the old worker only by its recorded identity: verify it before spawning a second writer.
      const status = matchProcessIdentity(previous);
      if (status === 'alive') {
        throw new AdapterError('fake', 'session_active', `session ${input.sessionId} is still driven by process ${previous.pid} (spawn ${previous.spawnToken}); stop it before resuming`);
      }
      if (status === 'unverifiable') {
        throw new AdapterError('fake', 'session_unverifiable', `pid ${previous.pid} exists but cannot be verified as the previous process of session ${input.sessionId}; isolate a successor instead of resuming`);
      }
    }
    return this.#spawnSession(input, input.sessionId);
  }

  async #spawnSession(input: SessionInput, resumeSessionId: string | null): Promise<SessionHandle> {
    if (input.policy === 'verification') {
      // The test runtime answers openSession for the same policies as the real
      // ones: the verification profile belongs to the check runner, never to a
      // model session, and the shared conformance suite asserts that every
      // adapter refuses it.
      throw new AdapterError('fake', 'unsupported_policy', 'the verification profile runs configured check commands against a frozen candidate copy; it is the check runner\'s job, not a runtime session');
    }
    const settings = this.validateSettings(requestedSettings(input));
    if (!settings.ok) {
      const problems = [settings.model, settings.effort].filter((r) => r.status === 'unsupported').map((r) => r.message);
      throw new AdapterError('fake', 'unsupported_setting', problems.join('; '));
    }

    const scenarioPath = input.env?.[FAKE_SCENARIO_ENV] ?? this.#options.scenarioPath;
    const args = [this.#options.scriptPath];
    if (scenarioPath !== undefined) args.push('--scenario', scenarioPath);
    if (resumeSessionId !== null) args.push('--session', resumeSessionId);
    if (input.model !== undefined) args.push('--model', input.model);
    if (input.effort !== undefined) args.push('--effort', input.effort);

    // Workers get a minimal environment: never the coordinator's full env.
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, input.env ?? {});

    const spawnToken = newSpawnToken();
    const child = spawn(this.#options.nodeExecutable, args, {
      cwd: input.cwd,
      env,
      shell: false,
      detached: true, // own process group so the whole tree can be terminated
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) throw new AdapterError('fake', 'spawn_failed', 'child process has no pid');
    const identity = observeProcessIdentity(child.pid, spawnToken);

    const pendingId = resumeSessionId ?? `pending-${child.pid}`;
    const session: FakeSession = {
      sessionId: pendingId,
      cwd: input.cwd,
      allowedWritePaths: input.allowedWritePaths.map(canonicalPath),
      child,
      identity,
      handle: { adapter: 'fake', sessionId: pendingId, processId: child.pid, process: identity, raw: { kind: 'fake-session', cwd: input.cwd } satisfies FakeHandleRaw },
      buffer: [],
      waiters: [],
      sequence: 0,
      lineNo: 0,
      activeTurnId: null,
      exit: null,
      stdoutRemainder: '',
      stderrLines: [],
      effective: { model: null, effort: null },
    };
    this.#wire(session);

    const started = await this.#waitFor(session, (event) => event.kind === 'session_started', this.#options.startupTimeoutMs);
    if (started === null) {
      await this.#terminateGroup(session);
      const stderr = session.stderrLines.slice(-5).join(' | ');
      throw new AdapterError('fake', 'startup_failed', `fake runtime did not report session_started within ${this.#options.startupTimeoutMs}ms${stderr ? ` (stderr: ${stderr})` : ''}`);
    }
    const reported = started.payload['sessionId'];
    // The fake runtime echoes the --model/--effort it was actually given, so
    // the effective values come from the runtime's own report, never from the
    // request (FR006).
    session.effective = {
      model: typeof started.payload['model'] === 'string' ? (started.payload['model'] as string) : null,
      effort: typeof started.payload['effort'] === 'string' ? (started.payload['effort'] as string) : null,
    };
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

  #rawRef(session: FakeSession, suffix: string | number): string {
    return `fake:${session.sessionId}:${session.identity.spawnToken}:${suffix}`;
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
      }, this.#rawRef(session, 'exit'));
      session.activeTurnId = null;
      this.#wake(session);
    });
    child.on('error', (error) => {
      this.#push(session, 'error', session.activeTurnId, { fatal: true, reason: 'spawn_error', message: error.message }, this.#rawRef(session, 'spawn'));
      session.exit = { code: null, signal: null };
      this.#wake(session);
    });
  }

  #ingestLine(session: FakeSession, line: string, partial: boolean): void {
    session.lineNo += 1;
    const rawRef = this.#rawRef(session, session.lineNo);
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
    session.buffer.push({
      kind,
      adapter: 'fake',
      sessionId: session.sessionId,
      turnId,
      spawnToken: session.identity.spawnToken,
      sequence: session.sequence,
      timestamp: nowIso(),
      payload,
      rawRef,
    });
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
    // The message goes straight to the fake runtime, which holds it in its own
    // inbox and reports it on the next turn it starts — so the holder is the
    // runtime in both cases, and the receipt says so rather than leaving a
    // reader to guess who will deliver it.
    return {
      messageId: input.messageId,
      state: activeTurn === null ? 'queued' : 'submitted_to_active_turn',
      turnId: activeTurn,
      holder: 'runtime',
      at: nowIso(),
      detail: activeTurn === null ? 'written to the runtime, which holds it in its inbox until the next turn starts' : `written to the runtime during ${activeTurn}`,
    };
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

  /**
   * Stop the session's process tree. A session spawned by this instance is
   * ours by construction. Anything else (a handle reconstructed after a
   * coordinator restart) is signalled only when its recorded identity still
   * matches the running process; a reused pid is never signalled.
   */
  async stopOwnedProcesses(handle: SessionHandle): Promise<StopReceipt> {
    const session = this.#sessions.get(handle.sessionId);
    if (session !== undefined) return this.#terminateGroup(session);

    const identity = handle.process ?? null;
    const at = nowIso();
    if (identity === null) {
      const pid = handle.processId ?? null;
      return { sessionId: handle.sessionId, state: 'unknown', processId: pid, signal: null, at, detail: pid === null ? 'no process id recorded' : `pid ${pid} has no recorded start time or spawn token; refusing to signal a process by pid alone` };
    }
    const status = matchProcessIdentity(identity);
    switch (status) {
      case 'pid_reused':
        // A pid cannot be reassigned while its old process group still has members, so the owned tree is already gone.
        return { sessionId: handle.sessionId, state: 'process_tree_terminated', processId: identity.pid, signal: null, at, detail: `pid ${identity.pid} now belongs to an unrelated process (start time mismatch); the owned process tree is already gone and nothing was signalled` };
      case 'unverifiable':
        return { sessionId: handle.sessionId, state: 'unknown', processId: identity.pid, signal: null, at, detail: `pid ${identity.pid} exists but cannot be verified as the owned process; nothing was signalled` };
      case 'alive':
      case 'dead':
        // dead: the leader is gone but orphans may keep the group alive; the group id is still ours.
        return this.#terminateGroupByPid(handle.sessionId, identity.pid);
      default: {
        const never: never = status;
        throw new Error(`unexpected identity status ${String(never)}`);
      }
    }
  }

  async #terminateGroup(session: FakeSession): Promise<StopReceipt> {
    const receipt = await this.#terminateGroupByPid(session.sessionId, session.identity.pid, session);
    if (session.child.stdin && !session.child.stdin.destroyed) session.child.stdin.destroy();
    return receipt;
  }

  async #terminateGroupByPid(sessionId: string, pid: number, session?: FakeSession): Promise<StopReceipt> {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGKILL'];
    let lastSignal: NodeJS.Signals | null = null;
    for (const signal of signals) {
      if (!isProcessGroupAlive(pid) && !isProcessAlive(pid)) break;
      try {
        process.kill(-pid, signal);
        lastSignal = signal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + this.#options.stopTimeoutMs;
      while (Date.now() < deadline) {
        const childDone = session === undefined ? !isProcessAlive(pid) : session.exit !== null;
        if (childDone && !isProcessGroupAlive(pid)) break;
        await delay(25);
      }
    }
    const treeDead = !isProcessGroupAlive(pid) && !isProcessAlive(pid) && (session === undefined || session.exit !== null);
    return {
      sessionId,
      state: treeDead ? 'process_tree_terminated' : lastSignal === null ? 'unknown' : 'requested',
      processId: pid,
      signal: lastSignal,
      at: nowIso(),
      ...(treeDead ? {} : { detail: `process group ${pid} still has members after ${signals.join('+')}` }),
    };
  }

  /** What the fake runtime echoed back for this session, as opposed to what was requested (FR006). */
  effectiveSettings(handle: SessionHandle): EffectiveRuntimeSettings | null {
    return this.#sessions.get(handle.sessionId)?.effective ?? null;
  }

  async reconcile(handle: SessionHandle): Promise<ObservedRuntimeState> {
    const session = this.#sessions.get(handle.sessionId);
    const observedAt = nowIso();
    if (session !== undefined) {
      const status: ProcessIdentityStatus = session.exit !== null ? 'dead' : matchProcessIdentity(session.identity);
      return {
        adapter: 'fake',
        sessionId: handle.sessionId,
        processId: session.identity.pid,
        process: session.identity,
        processIdentityStatus: status,
        processAlive: status === 'alive',
        processGroupAlive: isProcessGroupAlive(session.identity.pid),
        activeTurnId: session.activeTurnId,
        exitCode: session.exit?.code ?? null,
        signal: session.exit?.signal ?? null,
        lastEventSequence: session.sequence,
        observedAt,
      };
    }

    const identity = handle.process ?? null;
    const pid = identity?.pid ?? handle.processId ?? null;
    const status = identity === null ? null : matchProcessIdentity(identity);
    return {
      adapter: 'fake',
      sessionId: handle.sessionId,
      processId: pid,
      process: identity,
      processIdentityStatus: status,
      // A pid alone proves nothing: without an identity, or with one we cannot compare, the answer is honestly unknown.
      processAlive: status === null || status === 'unverifiable' ? 'unknown' : status === 'alive',
      processGroupAlive: pid === null || status === 'pid_reused' ? (pid === null ? 'unknown' : false) : isProcessGroupAlive(pid),
      activeTurnId: null,
      exitCode: null,
      signal: null,
      lastEventSequence: 0,
      observedAt,
    };
  }

  /** Test/diagnostic access to captured stderr lines for a session. */
  stderrOf(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.stderrLines ?? [];
  }
}
