/**
 * Codex runtime adapter (FR003, FR058, initial FR042 boundary checks).
 *
 * Primary mode: the Codex app server over stdio (`codex app-server --stdio`),
 * one owned server process per conversation session. That mode is primary
 * because it is the only one of the two installed interfaces that gives us
 * every control the adapter contract requires: a stable thread identity,
 * structured streamed items, mid-turn steering (`turn/steer`), interruption
 * (`turn/interrupt`), resumption (`thread/resume`), per-turn sandbox policy
 * with explicit writable roots, and server -> client approval requests we can
 * refuse. `codex exec --json` gives one prompt, one process and no steering
 * or interruption channel, so it is not used here.
 *
 * Validated against codex-cli 0.147.0 on darwin; see docs/runtime-codex.md
 * for exactly what was executed and what remains unverified.
 */
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Policy } from '../../core/contracts.js';
import { nowIso } from '../../core/ids.js';
import { isProcessAlive, isProcessGroupAlive, matchProcessIdentity, type ProcessIdentity, type ProcessIdentityStatus } from '../../core/process.js';
import { isWithin } from '../../storage/paths.js';
import {
  AdapterError,
  CAPABILITY_NAMES,
  validateSettingsAgainst,
  type CapabilityName,
  type CapabilityReport,
  type CapabilityStatus,
  type DeliveryInput,
  type DeliveryReceipt,
  type InterruptionReceipt,
  type ObservedRuntimeState,
  type OfferedSetting,
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
  type TurnUsageReport,
} from '../types.js';
import {
  CLIENT_METHOD,
  ErrorNotificationSchema,
  ItemNotificationSchema,
  ModelListResultSchema,
  SERVER_NOTIFICATION,
  ThreadStartResultSchema,
  ThreadStartedNotificationSchema,
  TokenUsageNotificationSchema,
  TurnNotificationSchema,
  TurnStartResultSchema,
  TurnSteerResultSchema,
  classifyCodexError,
  isDeltaMethod,
  sandboxModeForPolicy,
  sandboxPolicyForTurn,
  type ThreadItem,
} from './protocol.js';
import { provisionedBridgeFromArgs } from './coordination-bridge.js';
import { CodexRpcClient, CodexRpcError, CodexTransportError, DEFAULT_APP_SERVER_ARGS, denyServerRequest, type RawRecord, type ServerRequestRecord } from './rpc.js';

export const CODEX_ADAPTER = 'codex' as const;
export const DEFAULT_CODEX_EXECUTABLE = 'codex';

/** The version this adapter's capability statuses were established against. */
export const TESTED_CODEX_VERSION = '0.147.0';

/**
 * The token-usage shape this adapter reads off `thread/tokenUsage/updated`.
 * Loose and validated rather than trusted: an unexpected shape yields no usage
 * at all instead of a guessed number.
 */
const ThreadTokenUsageSchema = z.looseObject({
  total: z.looseObject({ inputTokens: z.number().int().min(0).optional(), outputTokens: z.number().int().min(0).optional() }).optional(),
});

const CLIENT_NAME = 'workforce';
const CLIENT_VERSION = '0.1.0';

/** Config override values are interpolated into TOML; keep them to characters that cannot change the expression's shape. */
const SAFE_CONFIG_VALUE = /^[A-Za-z0-9._:-]+$/;

export interface CodexAdapterOptions {
  readonly executablePath?: string;
  /** Extra `-c key=value` overrides, appended after the transport arguments (accepted there by codex-cli 0.147.0). */
  readonly configOverrides?: ReadonlyArray<string>;
  /** Arguments that select the stdio transport. Defaults to `app-server --stdio`; tests point this at a replay script. */
  readonly appServerArgs?: ReadonlyArray<string>;
  /** Directory for the raw JSONL capture of each session's stdio (the run artifacts logs dir). */
  readonly logsDir?: string;
  readonly onRawRecord?: (sessionId: string, record: RawRecord) => void;
  readonly probeTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Include streaming delta notifications in the normalized stream. Off by default: they are captured raw regardless. */
  readonly includeDeltas?: boolean;
  /** Model/effort table discovered from `model/list`; `discoverSettings` fills this in. */
  readonly settings?: RuntimeSettingsSupport;
}

/**
 * Settings support before `model/list` has been consulted: nothing is offered
 * and the lists are not exhaustive, so a requested value is reported as
 * `supported_unverified` and passed through unchanged rather than being
 * silently mapped or rejected (FR006).
 */
export const UNDISCOVERED_CODEX_SETTINGS: RuntimeSettingsSupport = {
  model: { offered: [], exhaustive: false },
  effort: { offered: [], exhaustive: false },
};

interface CodexHandleRaw {
  readonly kind: 'codex-thread';
  readonly cwd: string;
  readonly executablePath: string;
}

interface CodexSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly allowedWritePaths: ReadonlyArray<string>;
  readonly policy: Policy;
  readonly rpc: CodexRpcClient;
  readonly identity: ProcessIdentity;
  readonly handle: SessionHandle;
  readonly buffer: RuntimeEvent[];
  waiters: Array<() => void>;
  sequence: number;
  activeTurnId: string | null;
  readonly turnStartIndex: Map<string, number>;
  readonly queued: DeliveryInput[];
  readonly reported: CodexEffectiveSettings;
  readonly diagnostics: string[];
  tokenUsage: unknown;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  rawLogFd: number | null;
  readonly rawLogPath: string | null;
  closed: boolean;
}

/** What the server actually reports for this thread; `null` means the server did not report it (never guessed). */
export interface CodexEffectiveSettings {
  readonly model: string | null;
  readonly effort: string | null;
  readonly sandbox: unknown;
  readonly approvalPolicy: unknown;
  readonly modelProvider: string | null;
}

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

function requestedSettingsOf(input: SessionInput): RequestedSettings {
  return { ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
}

function report(status: CapabilityStatus, note: string): CapabilityReport {
  return { status, testedVersion: TESTED_CODEX_VERSION, os: 'darwin', note };
}

/**
 * Capability statuses for codex-cli 0.147.0 on macOS. `verified` means this
 * package executed the control against the installed runtime; anything that
 * needs a completed model turn is `supported_unverified` because the account
 * on this machine is over its usage limit (see docs/runtime-codex.md).
 */
export const CODEX_CAPABILITIES: Readonly<Record<CapabilityName, CapabilityReport>> = {
  structured_events: report('verified', 'thread/started, turn/started, item/started, item/completed, thread/tokenUsage/updated, error and turn/completed observed on real sessions and normalized'),
  session_identity: report('verified', 'thread/start returns a stable thread id that every later request, notification and resume uses'),
  resume_session: report('verified', 'a thread was resumed by id in a second app-server process after the first was terminated, and answered from the earlier turn\'s history'),
  interrupt_turn: report('verified', 'turn/interrupt ended a running shell loop; the receipt reports observed only after turn/completed with status interrupted, and -32600 "no active turn to interrupt" is handled as a receipt rather than a crash'),
  active_turn_delivery: report('verified', 'turn/steer with expectedTurnId was accepted mid-turn and the receipt reports submitted_to_active_turn'),
  queued_delivery: report('verified', 'a delivery recorded with no active turn is queued by the adapter and flushed into the next turn/start input'),
  process_tree_stop: report('verified', 'the app server is spawned as a process-group leader; stdin close, then SIGTERM, then SIGKILL, with the observed group state reported. Its MCP server children live in the same group and are waited for'),
  write_containment: report(
    'verified',
    'workspace-write with explicit writableRoots plus excludeSlashTmp and excludeTmpdirEnvVar: writes inside the granted root succeed while writes to a sibling workspace, to /tmp and to $TMPDIR are denied, network is denied, and read-only denies every write. Checked both through command/exec and through a model-driven turn asked to write outside its workspace',
  ),
  model_selection: report('verified', 'model/list reports available ids; -c model="<id>" is reflected in the thread/start response and used by the turn'),
  effort_selection: report('verified', 'model/list reports supported reasoning efforts per model; -c model_reasoning_effort="<value>" is reflected in the thread/start response'),
  usage_reporting: report('verified', 'thread/tokenUsage/updated reports input, cached input, output and reasoning token counts per turn. Currency cost is not reported by the app server at all and must never be presented as zero'),
  coordination_bridge: report(
    'verified',
    'the coordination bridge is injected as `-c mcp_servers.<name>....` and used: on a real 0.147.0 turn a worker called the bridge tool send_message, the app server asked for authorization through mcpServer/elicitation/request, the adapter authorized that one request because the server name and tool are the ones it provisioned, the mcpToolCall item completed with status "completed", and the coordinator stored the message. Every other server -> client request stays refused',
  ),
};

/** Build `-c key=value` argument pairs for the app-server process. */
export function configOverrideArgs(overrides: Readonly<Record<string, string>>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!SAFE_CONFIG_VALUE.test(value)) {
      throw new AdapterError(CODEX_ADAPTER, 'unsafe_config_value', `config override ${key} value "${value}" contains characters that are not allowed in a config override`);
    }
    args.push('-c', `${key}="${value}"`);
  }
  return args;
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = CODEX_ADAPTER;
  readonly #options: Required<
    Pick<CodexAdapterOptions, 'executablePath' | 'configOverrides' | 'appServerArgs' | 'probeTimeoutMs' | 'startupTimeoutMs' | 'requestTimeoutMs' | 'interruptTimeoutMs' | 'stopTimeoutMs' | 'includeDeltas'>
  > &
    Pick<CodexAdapterOptions, 'logsDir' | 'onRawRecord'>;
  readonly #sessions = new Map<string, CodexSession>();
  #settings: RuntimeSettingsSupport;

  constructor(options: CodexAdapterOptions = {}) {
    this.#options = {
      executablePath: options.executablePath ?? DEFAULT_CODEX_EXECUTABLE,
      configOverrides: options.configOverrides ?? [],
      appServerArgs: options.appServerArgs ?? DEFAULT_APP_SERVER_ARGS,
      probeTimeoutMs: options.probeTimeoutMs ?? 10_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      interruptTimeoutMs: options.interruptTimeoutMs ?? 15_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
      includeDeltas: options.includeDeltas ?? false,
      ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {}),
      ...(options.onRawRecord !== undefined ? { onRawRecord: options.onRawRecord } : {}),
    };
    this.#settings = options.settings ?? UNDISCOVERED_CODEX_SETTINGS;
  }

  // -------------------------------------------------------------------------
  // Discovery (FR001, FR002, FR005, FR006)
  // -------------------------------------------------------------------------

  /**
   * Passive readiness probe: `codex --version` and the documented
   * `codex login status`. Neither starts a model turn, runs repository hooks
   * nor reads credential stores. Pass `{ live: true }` to additionally run the
   * app-server handshake and `model/list`, which is a live control check that
   * still costs no model tokens.
   */
  async probe(executablePath: string, options: { readonly live?: boolean } = {}): Promise<RuntimeReadiness> {
    const observedAt = nowIso();
    const diagnostics: string[] = [];
    const version = await this.#runVersion(executablePath, diagnostics);
    if (version === null) {
      return {
        adapter: CODEX_ADAPTER,
        executablePath,
        installed: false,
        version: null,
        adapterSupported: true,
        controllable: false,
        authentication: 'unknown',
        ready: 'not_ready',
        probeKind: 'passive',
        diagnostics,
        observedAt,
      };
    }
    const authentication = await this.#loginStatus(executablePath, diagnostics);
    if (version !== TESTED_CODEX_VERSION) {
      diagnostics.push(`installed codex-cli ${version} differs from the tested version ${TESTED_CODEX_VERSION}; capability statuses were established against the tested version`);
    }

    if (options.live !== true) {
      return {
        adapter: CODEX_ADAPTER,
        executablePath,
        installed: true,
        version,
        adapterSupported: true,
        // Passively, the only evidence of controllability is that this is the version the
        // capability statuses were established against. A live probe replaces this with
        // evidence that the protocol was actually spoken.
        controllable: version === TESTED_CODEX_VERSION,
        authentication,
        // Installed and adapter-supported is not readiness: only a live check may say verified_ready.
        ready: 'unknown',
        probeKind: 'passive',
        diagnostics,
        observedAt,
      };
    }

    let controllable = false;
    try {
      const discovered = await this.discoverSettings(executablePath);
      this.#settings = discovered;
      controllable = true;
      if (discovered.model.offered.length === 0) diagnostics.push('model/list returned no models');
    } catch (error) {
      diagnostics.push(`app-server handshake failed: ${(error as Error).message}`);
    }
    return {
      adapter: CODEX_ADAPTER,
      executablePath,
      installed: true,
      version,
      adapterSupported: true,
      controllable,
      authentication,
      ready: controllable && authentication === 'logged_in' ? 'verified_ready' : 'not_ready',
      probeKind: 'live',
      diagnostics,
      observedAt,
    };
  }

  #runVersion(executablePath: string, diagnostics: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(executablePath, ['--version'], { timeout: this.#options.probeTimeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) {
          diagnostics.push(`codex --version failed: ${error.message}`);
          resolve(null);
          return;
        }
        // "codex-cli 0.147.0"
        const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
        if (match === null) {
          diagnostics.push(`could not parse a version from "${stdout.trim()}"`);
          resolve(null);
          return;
        }
        resolve(match[1]!);
      });
    });
  }

  /** Documented login-status command only. No credential store is read and no token is extracted. */
  #loginStatus(executablePath: string, diagnostics: string[]): Promise<RuntimeReadiness['authentication']> {
    return new Promise((resolve) => {
      execFile(executablePath, ['login', 'status'], { timeout: this.#options.probeTimeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`.toLowerCase();
        if (error !== null && text.length === 0) {
          diagnostics.push(`codex login status failed: ${error.message}`);
          resolve('unknown');
          return;
        }
        if (text.includes('not logged in')) {
          resolve('logged_out');
          return;
        }
        if (text.includes('logged in')) {
          resolve('logged_in');
          return;
        }
        diagnostics.push(`codex login status output was not recognised: ${text.trim().slice(0, 200)}`);
        resolve('unknown');
      });
    });
  }

  /**
   * Ask the running app server which models and reasoning efforts it offers.
   * This starts a server process but no model turn, so it is safe for an
   * explicit connection check; it is not part of passive discovery.
   */
  async discoverSettings(executablePath: string = this.#options.executablePath): Promise<RuntimeSettingsSupport> {
    const rpc = new CodexRpcClient({
      executablePath,
      args: [...this.#options.appServerArgs, ...this.#options.configOverrides],
      cwd: process.cwd(),
      requestTimeoutMs: this.#options.requestTimeoutMs,
      stopTimeoutMs: this.#options.stopTimeoutMs,
    });
    rpc.start();
    try {
      await rpc.initialize(CLIENT_NAME, CLIENT_VERSION, this.#options.startupTimeoutMs);
      const raw = await rpc.request(CLIENT_METHOD.modelList, {});
      const parsed = ModelListResultSchema.safeParse(raw);
      if (!parsed.success) throw new AdapterError(CODEX_ADAPTER, 'protocol_error', `model/list returned an unexpected shape: ${parsed.error.message}`);
      const models: OfferedSetting[] = [];
      const efforts = new Map<string, OfferedSetting>();
      for (const model of parsed.data.data) {
        if (model.hidden === true) continue;
        models.push({ value: model.id, provenance: 'reported', ...(model.isDefault === true ? { note: 'runtime default' } : {}) });
        for (const effort of model.supportedReasoningEfforts ?? []) {
          if (!efforts.has(effort.reasoningEffort)) efforts.set(effort.reasoningEffort, { value: effort.reasoningEffort, provenance: 'reported' });
        }
      }
      // Exhaustive: the server rejects ids it did not list, so an unlisted value must not reach dispatch.
      const settings: RuntimeSettingsSupport = { model: { offered: models, exhaustive: true }, effort: { offered: [...efforts.values()], exhaustive: true } };
      this.#settings = settings;
      return settings;
    } finally {
      await rpc.stop();
    }
  }

  capabilities(): RuntimeCapabilities {
    const capabilities = {} as Record<CapabilityName, CapabilityReport>;
    for (const name of CAPABILITY_NAMES) capabilities[name] = CODEX_CAPABILITIES[name];
    return { adapter: CODEX_ADAPTER, capabilities, settings: this.#settings };
  }

  validateSettings(requested: RequestedSettings): SettingsValidation {
    return validateSettingsAgainst(CODEX_ADAPTER, this.#settings, requested);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async openSession(input: SessionInput): Promise<SessionHandle> {
    return this.#openThread(input, null);
  }

  async resumeSession(input: ResumeInput): Promise<SessionHandle> {
    const existing = this.#sessions.get(input.sessionId);
    if (existing !== undefined && !existing.closed && isProcessAlive(existing.identity.pid)) {
      throw new AdapterError(CODEX_ADAPTER, 'session_active', `thread ${input.sessionId} still has a live app server (pid ${existing.identity.pid}); stop it before resuming`);
    }
    const previous = input.previousProcess ?? null;
    if (previous !== null) {
      const status = matchProcessIdentity(previous);
      if (status === 'alive') {
        throw new AdapterError(CODEX_ADAPTER, 'session_active', `thread ${input.sessionId} is still driven by process ${previous.pid} (spawn ${previous.spawnToken}); stop it before resuming`);
      }
      if (status === 'unverifiable') {
        throw new AdapterError(CODEX_ADAPTER, 'session_unverifiable', `pid ${previous.pid} exists but cannot be verified as the previous app server for thread ${input.sessionId}; isolate a successor instead of resuming`);
      }
    }
    return this.#openThread(input, input.sessionId);
  }

  async #openThread(input: SessionInput, resumeThreadId: string | null): Promise<SessionHandle> {
    if (input.policy === 'verification') {
      // The same refusal the Claude Code adapter gives, and for the same
      // reason: the verification profile runs configured check commands
      // against a frozen candidate copy (src/verification/), which is the check
      // runner's job. A model session opened under it would let a runtime
      // "verify" its own work. Both adapters answering openSession the same way
      // for the same profile is asserted by the shared conformance suite.
      throw new AdapterError(
        CODEX_ADAPTER,
        'unsupported_policy',
        'the verification profile runs configured check commands against a frozen candidate copy; it is the check runner\'s job, not a runtime session. Refusing to open a Codex session under it',
      );
    }
    const settings = this.validateSettings(requestedSettingsOf(input));
    if (!settings.ok) {
      const problems = [settings.model, settings.effort].filter((r) => r.status === 'unsupported').map((r) => r.message);
      throw new AdapterError(CODEX_ADAPTER, 'unsupported_setting', problems.join('; '));
    }

    // Model and effort go through process-level config overrides because
    // thread/start has no `effort` parameter in this protocol version; the
    // thread/start response then reports the values that actually took effect.
    const overrides: Record<string, string> = {};
    if (input.model !== undefined) overrides['model'] = input.model;
    if (input.effort !== undefined) overrides['model_reasoning_effort'] = input.effort;

    const args = [...this.#options.appServerArgs, ...this.#options.configOverrides, ...configOverrideArgs(overrides), ...(input.extraArgs ?? [])];
    // Codex gates every MCP tool call behind an approval request, including
    // calls to the coordination bridge the coordinator itself configured for
    // this session. The adapter has to be able to tell that bridge apart from
    // an escalation, so it reads back which server this session's own argv
    // provisions; when it provisions none, nothing is ever approved.
    const provisionedBridge = provisionedBridgeFromArgs(args);

    const rpc = new CodexRpcClient({
      executablePath: this.#options.executablePath,
      args,
      cwd: input.cwd,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      stopTimeoutMs: this.#options.stopTimeoutMs,
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(provisionedBridge !== null ? { provisionedBridge } : {}),
      serverRequestPolicy: (method) => denyServerRequest(method),
      // The sink closes over `session`, which only exists once the thread id is
      // known; records from the handshake are buffered until then and replayed.
      onRaw: (record: RawRecord): void => {
        if (session === null) pendingRaw.push(record);
        else this.#writeRaw(session, record);
      },
    });

    const pendingRaw: RawRecord[] = [];
    let session: CodexSession | null = null;
    const identity = rpc.start();

    let started: ReturnType<typeof ThreadStartResultSchema.parse>;
    try {
      await rpc.initialize(CLIENT_NAME, CLIENT_VERSION, this.#options.startupTimeoutMs);
      const params: Record<string, unknown> = {
        cwd: input.cwd,
        sandbox: sandboxModeForPolicy(input.policy),
        // Never `on-request`: an approval prompt would be an escalation the coordinator must not grant.
        approvalPolicy: 'never',
        developerInstructions: input.systemInstructions,
        ...(input.model !== undefined ? { model: input.model } : {}),
      };
      const raw =
        resumeThreadId === null
          ? await rpc.request(CLIENT_METHOD.threadStart, params, this.#options.startupTimeoutMs)
          : await rpc.request(CLIENT_METHOD.threadResume, { ...params, threadId: resumeThreadId }, this.#options.startupTimeoutMs);
      const parsed = ThreadStartResultSchema.safeParse(raw);
      if (!parsed.success) throw new AdapterError(CODEX_ADAPTER, 'protocol_error', `${resumeThreadId === null ? 'thread/start' : 'thread/resume'} returned an unexpected shape: ${parsed.error.message}`);
      started = parsed.data;
    } catch (error) {
      await rpc.stop();
      if (error instanceof AdapterError) throw error;
      if (error instanceof CodexRpcError) throw new AdapterError(CODEX_ADAPTER, 'thread_start_rejected', error.message);
      if (error instanceof CodexTransportError) {
        const stderr = rpc.stderrLines.slice(-3).join(' | ');
        throw new AdapterError(CODEX_ADAPTER, `transport_${error.reason}`, `${error.message}${stderr ? ` (stderr: ${stderr})` : ''}`);
      }
      throw error;
    }

    const sessionId = started.thread.id;
    const reported: CodexEffectiveSettings = {
      model: started.model ?? null,
      effort: started.reasoningEffort ?? null,
      sandbox: started.sandbox ?? null,
      approvalPolicy: started.approvalPolicy ?? null,
      modelProvider: started.modelProvider ?? null,
    };
    const diagnostics: string[] = [];
    if (input.model !== undefined && reported.model !== null && reported.model !== input.model) {
      diagnostics.push(`requested model "${input.model}" but the server reports "${reported.model}"`);
    }
    if (input.effort !== undefined && reported.effort !== null && reported.effort !== input.effort) {
      diagnostics.push(`requested effort "${input.effort}" but the server reports "${reported.effort}"`);
    }
    const offeredModels = this.#settings.model.offered.map((o) => o.value);
    if (reported.model !== null && offeredModels.length > 0 && !offeredModels.includes(reported.model)) {
      diagnostics.push(`the server started this thread with model "${reported.model}", which model/list does not offer; turns are likely to be rejected by the provider`);
    }

    const { fd, streamPath } = this.#openRawLog(sessionId, identity.spawnToken);
    const handle: SessionHandle = {
      adapter: CODEX_ADAPTER,
      sessionId,
      processId: identity.pid,
      process: identity,
      raw: { kind: 'codex-thread', cwd: input.cwd, executablePath: this.#options.executablePath } satisfies CodexHandleRaw,
    };
    session = {
      sessionId,
      cwd: input.cwd,
      allowedWritePaths: input.allowedWritePaths.map(canonicalPath),
      policy: input.policy,
      rpc,
      identity,
      handle,
      buffer: [],
      waiters: [],
      sequence: 0,
      activeTurnId: null,
      turnStartIndex: new Map(),
      queued: [],
      reported,
      diagnostics,
      tokenUsage: null,
      requestedModel: input.model ?? null,
      requestedEffort: input.effort ?? null,
      rawLogFd: fd,
      rawLogPath: streamPath,
      closed: false,
    };
    for (const record of pendingRaw) this.#writeRaw(session, record);
    this.#sessions.set(sessionId, session);
    this.#pump(session);
    return handle;
  }

  /**
   * The raw capture is written with `writeSync` rather than a buffered
   * stream: a crash mid-turn must leave the frames that already arrived on
   * disk, because they are the only evidence of what the worker did.
   */
  #openRawLog(sessionId: string, spawnToken: string): { fd: number | null; streamPath: string | null } {
    const dir = this.#options.logsDir;
    if (dir === undefined) return { fd: null, streamPath: null };
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `codex-${sessionId}-${spawnToken}.jsonl`);
    return { fd: openSync(file, 'a'), streamPath: file };
  }

  #writeRaw(session: CodexSession, record: RawRecord): void {
    if (session.rawLogFd !== null) {
      try {
        writeSync(session.rawLogFd, `${JSON.stringify({ ...record, sessionId: session.sessionId, spawnToken: session.identity.spawnToken })}\n`);
      } catch {
        // A closed or full log must not take the session down; the normalized events remain.
      }
    }
    this.#options.onRawRecord?.(session.sessionId, record);
  }

  #closeRawLog(session: CodexSession): void {
    if (session.rawLogFd === null) return;
    try {
      closeSync(session.rawLogFd);
    } catch {
      // already closed
    }
    session.rawLogFd = null;
  }

  /** Path of the raw stdio capture for a session, when a logs directory was configured. */
  rawLogPath(handle: SessionHandle): string | null {
    return this.#sessions.get(handle.sessionId)?.rawLogPath ?? null;
  }

  /** What the server reported for this thread, as opposed to what was requested (FR006). */
  effectiveSettings(handle: SessionHandle): CodexEffectiveSettings | null {
    return this.#sessions.get(handle.sessionId)?.reported ?? null;
  }

  /** Diagnostics raised while opening the session (mismatched or unavailable model/effort). */
  sessionDiagnostics(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.diagnostics ?? [];
  }

  /**
   * The most recent token usage the server reported for this thread, or null
   * when it never reported any. Currency cost is not available from the app
   * server, so a caller must label cost unavailable rather than reporting zero.
   */
  lastTokenUsage(handle: SessionHandle): unknown {
    return this.#sessions.get(handle.sessionId)?.tokenUsage ?? null;
  }

  /**
   * The same numbers in the shared contract shape (`RuntimeAdapter.lastTurnUsage`),
   * which is what the coordinator reads. The app server reports no currency
   * figure at all, so cost is `unavailable` with the reason — never a zero
   * standing in for "not reported" (AT14).
   */
  lastTurnUsage(handle: SessionHandle): TurnUsageReport | null {
    const parsed = ThreadTokenUsageSchema.safeParse(this.#sessions.get(handle.sessionId)?.tokenUsage ?? null);
    const total = parsed.success ? parsed.data.total : undefined;
    const inputTokens = total?.inputTokens ?? null;
    const outputTokens = total?.outputTokens ?? null;
    if (inputTokens === null && outputTokens === null) return null;
    return {
      inputTokens,
      outputTokens,
      costUsd: null,
      costStatus: 'unavailable',
      detail: 'thread/tokenUsage/updated reports token counts for this thread; the app server reports no currency cost, so cost is unavailable rather than zero',
    };
  }

  /** Deliveries recorded while no turn was active; flushed into the next turn. */
  pendingDeliveries(handle: SessionHandle): ReadonlyArray<DeliveryInput> {
    return this.#sessions.get(handle.sessionId)?.queued ?? [];
  }

  /**
   * Every server -> client request answered for this session, approved or
   * refused, each with the reason it was decided that way. This is the audit
   * trail a reviewer reads to see exactly what the coordinator authorized.
   */
  serverRequestDecisions(handle: SessionHandle): ReadonlyArray<ServerRequestRecord> {
    return this.#sessions.get(handle.sessionId)?.rpc.serverRequests ?? [];
  }

  /** The subset of those decisions that refused the request. */
  deniedServerRequests(handle: SessionHandle): ReadonlyArray<ServerRequestRecord> {
    return this.serverRequestDecisions(handle).filter((record) => record.decision.denied);
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  #pump(session: CodexSession): void {
    void (async () => {
      try {
        for await (const notification of session.rpc.notifications(0, 250)) {
          this.#normalize(session, notification.method, notification.params, notification.sequence);
        }
      } catch (error) {
        this.#push(session, 'error', session.activeTurnId, { fatal: true, reason: 'stream_failed', message: (error as Error).message }, this.#rawRef(session, 'stream'));
      }
      const exit = session.rpc.exited;
      session.closed = true;
      this.#push(
        session,
        'error',
        session.activeTurnId,
        { fatal: true, reason: 'process_exited', exitCode: exit?.code ?? null, signal: exit?.signal ?? null, expected: session.activeTurnId === null },
        this.#rawRef(session, 'exit'),
      );
      session.activeTurnId = null;
      this.#closeRawLog(session);
      this.#wake(session);
    })();
  }

  #rawRef(session: CodexSession, suffix: string | number): string {
    return `codex:${session.sessionId}:${session.identity.spawnToken}:${suffix}`;
  }

  #normalize(session: CodexSession, method: string, params: unknown, sequence: number): void {
    const rawRef = this.#rawRef(session, sequence);
    if (isDeltaMethod(method)) {
      if (this.#options.includeDeltas) this.#push(session, 'raw', this.#turnIdOf(params) ?? session.activeTurnId, { method, params }, rawRef);
      return;
    }
    switch (method) {
      case SERVER_NOTIFICATION.threadStarted: {
        const parsed = ThreadStartedNotificationSchema.safeParse(params);
        this.#push(session, 'session_started', null, parsed.success ? { threadId: parsed.data.thread.id, cwd: parsed.data.thread.cwd ?? null, cliVersion: parsed.data.thread.cliVersion ?? null } : { method, params }, rawRef);
        return;
      }
      case SERVER_NOTIFICATION.turnStarted: {
        const parsed = TurnNotificationSchema.safeParse(params);
        if (!parsed.success) {
          this.#push(session, 'raw', null, { method, params }, rawRef);
          return;
        }
        this.#push(session, 'turn_started', parsed.data.turn.id, { status: parsed.data.turn.status ?? null }, rawRef);
        return;
      }
      case SERVER_NOTIFICATION.turnCompleted: {
        const parsed = TurnNotificationSchema.safeParse(params);
        if (!parsed.success) {
          this.#push(session, 'raw', null, { method, params }, rawRef);
          return;
        }
        const turn = parsed.data.turn;
        const status = turn.status ?? 'completed';
        const kind: RuntimeEventKind = status === 'interrupted' ? 'turn_interrupted' : 'turn_completed';
        if (session.activeTurnId === turn.id) session.activeTurnId = null;
        this.#push(
          session,
          kind,
          turn.id,
          {
            status,
            durationMs: turn.durationMs ?? null,
            ...(turn.error != null ? { error: turn.error.message, errorClass: classifyCodexError(turn.error.codexErrorInfo) } : {}),
            // A finished turn is a runtime claim, never an acceptance (FR050).
            evidence: 'runtime_reported',
          },
          rawRef,
        );
        return;
      }
      case SERVER_NOTIFICATION.error: {
        const parsed = ErrorNotificationSchema.safeParse(params);
        if (!parsed.success) {
          this.#push(session, 'raw', null, { method, params }, rawRef);
          return;
        }
        this.#push(
          session,
          'error',
          parsed.data.turnId ?? session.activeTurnId,
          {
            // Not fatal to the stream: turn/completed still follows and carries the final status.
            fatal: false,
            message: parsed.data.error.message,
            errorClass: classifyCodexError(parsed.data.error.codexErrorInfo),
            willRetry: parsed.data.willRetry ?? false,
          },
          rawRef,
        );
        return;
      }
      case SERVER_NOTIFICATION.tokenUsageUpdated: {
        const parsed = TokenUsageNotificationSchema.safeParse(params);
        if (parsed.success) session.tokenUsage = parsed.data.tokenUsage;
        this.#push(session, 'raw', this.#turnIdOf(params), { method, params }, rawRef);
        return;
      }
      case SERVER_NOTIFICATION.itemStarted:
      case SERVER_NOTIFICATION.itemCompleted: {
        const parsed = ItemNotificationSchema.safeParse(params);
        if (!parsed.success) {
          this.#push(session, 'raw', this.#turnIdOf(params), { method, params }, rawRef);
          return;
        }
        this.#normalizeItem(session, method === SERVER_NOTIFICATION.itemCompleted ? 'completed' : 'started', parsed.data.turnId ?? session.activeTurnId, parsed.data.item, rawRef);
        return;
      }
      default:
        this.#push(session, 'raw', this.#turnIdOf(params), { method, params }, rawRef);
    }
  }

  #turnIdOf(params: unknown): string | null {
    if (typeof params !== 'object' || params === null) return null;
    const turnId = (params as { turnId?: unknown }).turnId;
    return typeof turnId === 'string' ? turnId : null;
  }

  #normalizeItem(session: CodexSession, phase: 'started' | 'completed', turnId: string | null, item: ThreadItem, rawRef: string): void {
    const base = { phase, itemId: item.id ?? null, itemType: item.type };
    switch (item.type) {
      case 'agentMessage': {
        if (phase !== 'completed') return; // the text is only final on completion; deltas carry the rest
        const rawPhase = (item as { phase?: unknown }).phase;
        const messagePhase = typeof rawPhase === 'string' ? rawPhase : null;
        this.#push(
          session,
          'assistant_message',
          turnId,
          {
            ...base,
            text: item.text ?? '',
            messagePhase,
            // The runtime's own terminal-answer marker, not our reading of the prose.
            claimsDone: messagePhase === 'final_answer',
            phaseKnown: messagePhase !== null,
          },
          rawRef,
        );
        return;
      }
      case 'commandExecution': {
        this.#push(
          session,
          'command_exec',
          turnId,
          {
            ...base,
            command: item.command ?? null,
            cwd: item.cwd ?? null,
            status: item.status ?? null,
            exitCode: item.exitCode ?? null,
            durationMs: item.durationMs ?? null,
            denied: item.status === 'declined',
            ...(phase === 'completed' && typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
          },
          rawRef,
        );
        return;
      }
      case 'fileChange': {
        const changes = item.changes ?? [];
        if (changes.length === 0) {
          this.#push(session, 'file_change', turnId, { ...base, status: item.status ?? null, path: null, withinAllowedPaths: null }, rawRef);
          return;
        }
        changes.forEach((change, index) => {
          const changed = canonicalPath(path.isAbsolute(change.path) ? change.path : path.join(session.cwd, change.path));
          this.#push(
            session,
            'file_change',
            turnId,
            {
              ...base,
              path: change.path,
              resolvedPath: changed,
              changeKind: change.kind?.type ?? null,
              status: item.status ?? null,
              applied: phase === 'completed' && item.status === 'completed',
              denied: item.status === 'declined',
              withinAllowedPaths: session.allowedWritePaths.some((root) => isWithin(root, changed)),
            },
            `${rawRef}#${index}`,
          );
        });
        return;
      }
      case 'mcpToolCall':
      case 'dynamicToolCall':
      case 'collabAgentToolCall':
      case 'webSearch': {
        this.#push(
          session,
          phase === 'completed' ? 'tool_result' : 'tool_call',
          turnId,
          { ...base, tool: item.tool ?? null, server: item.server ?? null, status: item.status ?? null, ...(item.error !== undefined ? { error: item.error } : {}) },
          rawRef,
        );
        return;
      }
      default:
        this.#push(session, 'raw', turnId, { ...base, item }, rawRef);
    }
  }

  #push(session: CodexSession, kind: RuntimeEventKind, turnId: string | null, payload: Record<string, unknown>, rawRef: string): void {
    session.sequence += 1;
    session.buffer.push({
      kind,
      adapter: CODEX_ADAPTER,
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

  #wake(session: CodexSession): void {
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  #session(handle: Pick<SessionHandle, 'sessionId'>): CodexSession {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) throw new AdapterError(CODEX_ADAPTER, 'unknown_session', `thread ${handle.sessionId} is not owned by this adapter instance`);
    return session;
  }

  async startTurn(handle: SessionHandle, input: TurnInput): Promise<TurnHandle> {
    const session = this.#session(handle);
    if (session.activeTurnId !== null) {
      throw new AdapterError(CODEX_ADAPTER, 'turn_active', `thread ${session.sessionId} already has active turn ${session.activeTurnId}; only one turn may be active per session`);
    }
    if (session.closed) throw new AdapterError(CODEX_ADAPTER, 'session_closed', `thread ${session.sessionId} has no live app server`);

    const queued = session.queued.splice(0);
    const text = [
      ...queued.map((message) => `[coordinator message ${message.messageId}${message.correlationId ? ` re ${message.correlationId}` : ''}]\n${message.body}`),
      ...(input.contextRefs !== undefined && input.contextRefs.length > 0 ? [`[context references]\n${input.contextRefs.join('\n')}`] : []),
      input.prompt,
    ].join('\n\n');

    const startIndex = session.buffer.length;
    let raw: unknown;
    try {
      raw = await this.#request(session, CLIENT_METHOD.turnStart, {
        threadId: session.sessionId,
        input: [{ type: 'text', text }],
        approvalPolicy: 'never',
        // The writable roots are turn-scoped: thread/start only takes the coarse sandbox mode.
        sandboxPolicy: sandboxPolicyForTurn(session.policy, session.allowedWritePaths),
        ...(session.requestedEffort !== null ? { effort: session.requestedEffort } : {}),
        ...(session.requestedModel !== null ? { model: session.requestedModel } : {}),
      });
    } catch (error) {
      // The turn never started: put the queued messages back so they are not lost.
      session.queued.unshift(...queued);
      throw error;
    }
    const parsed = TurnStartResultSchema.safeParse(raw);
    if (!parsed.success) throw new AdapterError(CODEX_ADAPTER, 'protocol_error', `turn/start returned an unexpected shape: ${parsed.error.message}`);
    const turnId = parsed.data.turn.id;
    session.activeTurnId = turnId;
    session.turnStartIndex.set(turnId, startIndex);
    return { adapter: CODEX_ADAPTER, sessionId: session.sessionId, turnId, startedAt: nowIso() };
  }

  async #request(session: CodexSession, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      return await session.rpc.request(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof CodexRpcError) throw new AdapterError(CODEX_ADAPTER, 'request_rejected', error.message);
      if (error instanceof CodexTransportError) throw new AdapterError(CODEX_ADAPTER, `transport_${error.reason}`, error.message);
      throw error;
    }
  }

  async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
    const session = this.#session({ sessionId: turn.sessionId });
    let index = session.turnStartIndex.get(turn.turnId) ?? 0;
    for (;;) {
      while (index < session.buffer.length) {
        const event = session.buffer[index]!;
        index += 1;
        if (event.turnId !== null && event.turnId !== turn.turnId) continue;
        yield event;
        if (event.kind === 'turn_completed' || event.kind === 'turn_interrupted') return;
        if (event.kind === 'error' && event.payload['fatal'] === true) return;
      }
      if (session.closed) return;
      await new Promise<void>((resolve) => session.waiters.push(resolve));
    }
  }

  /**
   * Steer the active turn where the runtime supports it, otherwise queue.
   * The receipt says which happened; it never claims submission for a message
   * that is only sitting in our queue (plan section 6).
   */
  async deliver(handle: SessionHandle, input: DeliveryInput): Promise<DeliveryReceipt> {
    const session = this.#session(handle);
    const activeTurn = session.activeTurnId;
    if (activeTurn === null || session.closed) {
      session.queued.push(input);
      return { messageId: input.messageId, state: 'queued', turnId: null, holder: 'adapter', at: nowIso(), detail: 'no turn was active; the adapter holds this message and flushes it into the next turn' };
    }
    const body = `[coordinator message ${input.messageId}${input.correlationId ? ` re ${input.correlationId}` : ''}]\n${input.body}`;
    try {
      const raw = await this.#request(session, CLIENT_METHOD.turnSteer, {
        threadId: session.sessionId,
        expectedTurnId: activeTurn,
        input: [{ type: 'text', text: body }],
      });
      const parsed = TurnSteerResultSchema.safeParse(raw);
      return {
        messageId: input.messageId,
        state: 'submitted_to_active_turn',
        turnId: parsed.success ? parsed.data.turnId : activeTurn,
        holder: 'runtime',
        at: nowIso(),
        detail: 'turn/steer accepted the message for the running turn (active_turn_delivery is verified for this runtime)',
      };
    } catch (error) {
      // The turn ended between the check and the call, or steering was refused: queue
      // instead of losing the message, and leave the refusal in the event stream.
      session.queued.push(input);
      this.#push(session, 'raw', activeTurn, { reason: 'steer_refused', messageId: input.messageId, message: (error as Error).message }, this.#rawRef(session, `steer-${input.messageId}`));
      return {
        messageId: input.messageId,
        state: 'queued',
        turnId: null,
        holder: 'adapter',
        at: nowIso(),
        detail: `turn/steer was refused (${(error as Error).message}); the adapter holds this message and flushes it into the next turn`,
      };
    }
  }

  /**
   * Request interruption, then wait for the server to confirm it.
   * `requested` means the call was accepted; `observed` means a terminal turn
   * event actually arrived.
   */
  async interrupt(turn: TurnHandle): Promise<InterruptionReceipt> {
    const session = this.#session({ sessionId: turn.sessionId });
    const alreadyEnded = session.buffer.some((e) => e.turnId === turn.turnId && (e.kind === 'turn_completed' || e.kind === 'turn_interrupted'));
    if (alreadyEnded) return { turnId: turn.turnId, state: 'observed', at: nowIso() };

    const startIndex = session.buffer.length;
    const requestedAt = nowIso();
    try {
      await this.#request(session, CLIENT_METHOD.turnInterrupt, { threadId: session.sessionId, turnId: turn.turnId }, this.#options.interruptTimeoutMs);
    } catch (error) {
      // "no active turn to interrupt" means the turn is already over; anything else is a real failure to report.
      if (error instanceof AdapterError && error.code === 'request_rejected' && /no active turn/i.test(error.message)) {
        const ended = session.buffer.some((e) => e.turnId === turn.turnId && (e.kind === 'turn_completed' || e.kind === 'turn_interrupted'));
        return { turnId: turn.turnId, state: ended ? 'observed' : 'requested', at: nowIso() };
      }
      throw error;
    }
    const observed = await this.#waitForEvent(
      session,
      startIndex,
      (event) => event.turnId === turn.turnId && (event.kind === 'turn_interrupted' || event.kind === 'turn_completed'),
      this.#options.interruptTimeoutMs,
    );
    return { turnId: turn.turnId, state: observed === null ? 'requested' : 'observed', at: observed === null ? requestedAt : nowIso() };
  }

  async #waitForEvent(session: CodexSession, fromIndex: number, predicate: (event: RuntimeEvent) => boolean, timeoutMs: number): Promise<RuntimeEvent | null> {
    const deadline = Date.now() + timeoutMs;
    let index = fromIndex;
    for (;;) {
      while (index < session.buffer.length) {
        const event = session.buffer[index]!;
        index += 1;
        if (predicate(event)) return event;
      }
      if (session.closed) return null;
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

  // -------------------------------------------------------------------------
  // Stopping and reconciliation
  // -------------------------------------------------------------------------

  async stopOwnedProcesses(handle: SessionHandle): Promise<StopReceipt> {
    const at = nowIso();
    const session = this.#sessions.get(handle.sessionId);
    if (session !== undefined) {
      const result = await session.rpc.stop();
      session.closed = true;
      this.#closeRawLog(session);
      const terminated = result.exited && !result.groupAlive;
      return {
        sessionId: handle.sessionId,
        state: terminated ? 'process_tree_terminated' : result.signalled === null ? 'unknown' : 'requested',
        processId: session.identity.pid,
        signal: result.signalled,
        at,
        ...(terminated ? {} : { detail: `app server process group ${session.identity.pid} still has members after ${result.signalled ?? 'stdin close'}` }),
      };
    }

    // A handle rebuilt after a coordinator restart: never signal by pid alone.
    const identity = handle.process ?? null;
    if (identity === null) {
      const pid = handle.processId ?? null;
      return {
        sessionId: handle.sessionId,
        state: 'unknown',
        processId: pid,
        signal: null,
        at,
        detail: pid === null ? 'no process id recorded' : `pid ${pid} has no recorded start time or spawn token; refusing to signal a process by pid alone`,
      };
    }
    const status = matchProcessIdentity(identity);
    switch (status) {
      case 'pid_reused':
        return {
          sessionId: handle.sessionId,
          state: 'process_tree_terminated',
          processId: identity.pid,
          signal: null,
          at,
          detail: `pid ${identity.pid} now belongs to an unrelated process (start time mismatch); the owned process tree is already gone and nothing was signalled`,
        };
      case 'unverifiable':
        return { sessionId: handle.sessionId, state: 'unknown', processId: identity.pid, signal: null, at, detail: `pid ${identity.pid} exists but cannot be verified as the owned app server; nothing was signalled` };
      case 'alive':
      case 'dead':
        return this.#terminateGroupByPid(handle.sessionId, identity.pid);
      default: {
        const never: never = status;
        throw new Error(`unexpected identity status ${String(never)}`);
      }
    }
  }

  async #terminateGroupByPid(sessionId: string, pid: number): Promise<StopReceipt> {
    let lastSignal: NodeJS.Signals | null = null;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!isProcessGroupAlive(pid) && !isProcessAlive(pid)) break;
      try {
        process.kill(-pid, signal);
        lastSignal = signal;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + this.#options.stopTimeoutMs;
      while (Date.now() < deadline) {
        if (!isProcessGroupAlive(pid) && !isProcessAlive(pid)) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    const dead = !isProcessGroupAlive(pid) && !isProcessAlive(pid);
    return {
      sessionId,
      state: dead ? 'process_tree_terminated' : lastSignal === null ? 'unknown' : 'requested',
      processId: pid,
      signal: lastSignal,
      at: nowIso(),
      ...(dead ? {} : { detail: `process group ${pid} still has members after SIGTERM+SIGKILL` }),
    };
  }

  async reconcile(handle: SessionHandle): Promise<ObservedRuntimeState> {
    const observedAt = nowIso();
    const session = this.#sessions.get(handle.sessionId);
    if (session !== undefined) {
      const exit = session.rpc.exited;
      const status: ProcessIdentityStatus = exit !== null ? 'dead' : matchProcessIdentity(session.identity);
      return {
        adapter: CODEX_ADAPTER,
        sessionId: handle.sessionId,
        processId: session.identity.pid,
        process: session.identity,
        processIdentityStatus: status,
        processAlive: status === 'alive',
        processGroupAlive: isProcessGroupAlive(session.identity.pid),
        activeTurnId: session.activeTurnId,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        lastEventSequence: session.sequence,
        observedAt,
      };
    }

    const identity = handle.process ?? null;
    const pid = identity?.pid ?? handle.processId ?? null;
    const status = identity === null ? null : matchProcessIdentity(identity);
    return {
      adapter: CODEX_ADAPTER,
      sessionId: handle.sessionId,
      processId: pid,
      process: identity,
      processIdentityStatus: status,
      // Without a comparable identity the honest answer is unknown, never "alive because a pid exists".
      processAlive: status === null || status === 'unverifiable' ? 'unknown' : status === 'alive',
      processGroupAlive: pid === null ? 'unknown' : status === 'pid_reused' ? false : isProcessGroupAlive(pid),
      activeTurnId: null,
      exitCode: null,
      signal: null,
      lastEventSequence: 0,
      observedAt,
    };
  }

  /** Diagnostic access to captured stderr for a session. */
  stderrOf(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.rpc.stderrLines ?? [];
  }

  /**
   * Run one command inside the app server's sandbox without creating a thread
   * or a turn (`command/exec`). This is how the execution boundary is checked
   * before a writing adapter is called supported (FR042): it exercises the
   * same `SandboxPolicy` a turn uses and costs no model tokens.
   */
  async execInSandbox(
    input: { readonly cwd: string; readonly command: ReadonlyArray<string>; readonly policy: Policy; readonly writableRoots: ReadonlyArray<string>; readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    if (input.command.length === 0) throw new AdapterError(CODEX_ADAPTER, 'invalid_command', 'command argv must not be empty');
    const rpc = new CodexRpcClient({
      executablePath: this.#options.executablePath,
      args: [...this.#options.appServerArgs, ...this.#options.configOverrides],
      cwd: input.cwd,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      stopTimeoutMs: this.#options.stopTimeoutMs,
      serverRequestPolicy: (method) => denyServerRequest(method),
    });
    rpc.start();
    try {
      await rpc.initialize(CLIENT_NAME, CLIENT_VERSION, this.#options.startupTimeoutMs);
      const raw = await rpc.request(
        'command/exec',
        {
          command: [...input.command],
          cwd: input.cwd,
          sandboxPolicy: sandboxPolicyForTurn(input.policy, input.writableRoots.map(canonicalPath)),
          timeoutMs: input.timeoutMs ?? 20_000,
        },
        (input.timeoutMs ?? 20_000) + 10_000,
      );
      const body = raw as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        exitCode: typeof body.exitCode === 'number' ? body.exitCode : -1,
        stdout: typeof body.stdout === 'string' ? body.stdout : '',
        stderr: typeof body.stderr === 'string' ? body.stderr : '',
      };
    } finally {
      await rpc.stop();
    }
  }
}
