/**
 * Claude Code runtime adapter (FR004; the FR005/FR006 half only a second
 * runtime can prove; FR042 containment truth).
 *
 * Mode: the documented programmatic mode, held open across turns —
 *
 *     claude --print --verbose
 *            --output-format stream-json --input-format stream-json
 *            --replay-user-messages --session-id <uuid we minted> …
 *
 * One owned `claude` process per conversation session. The transport shape is
 * nothing like the Codex adapter's JSON-RPC app server: there is no request /
 * response protocol for turns. A turn is a user message written to stdin; its
 * events arrive as newline-delimited JSON records on stdout; it ends with a
 * `result` record. Alongside that record stream the CLI speaks a small
 * `control_request` / `control_response` protocol on the same pipes, which is
 * how this adapter interrupts a turn and how it asks the runtime what models
 * and effort levels it offers without starting a model turn.
 *
 * Two decisions in this file are load-bearing and are argued in
 * docs/runtime-claude-code.md:
 *
 *   1. The coordinator owns the session identity. The uuid is minted here and
 *      passed as `--session-id`, so the id is known before the process starts
 *      and before any output arrives, and `--resume` addresses it later.
 *
 *   2. `local-development` does not grant a shell. Claude Code has no OS
 *      sandbox; `--restricted` confines its *file tools* to the working
 *      directories, and a shell command is not a file tool. Granting `Bash`
 *      therefore removes the only write boundary the runtime has, so it is off
 *      by default and turning it on downgrades this adapter's containment
 *      claim rather than silently broadening the profile.
 *
 * Validated against claude 2.1.260 on darwin; docs/runtime-claude-code.md says
 * exactly what was executed, what could not be executed on this machine and
 * why.
 */
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { Policy } from '../../core/contracts.js';
import { nowIso, uuidv7 } from '../../core/ids.js';
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
  AssistantRecordSchema,
  CLAUDE_CODE_ADAPTER,
  CLAUDE_EFFORT_LEVELS,
  ContentBlockSchema,
  DEFAULT_CLAUDE_EXECUTABLE,
  FILE_MUTATING_TOOLS,
  InitializeResponseSchema,
  ResultRecordSchema,
  SystemInitSchema,
  TESTED_CLAUDE_VERSION,
  UserRecordSchema,
  buildClaudeArgs,
  classifyClaudeError,
  isDeltaRecord,
  mapPolicy,
  parseClaudeVersion,
  type ClaudeErrorClass,
  type ContentBlock,
  type PolicyMapping,
} from './protocol.js';
import { ClaudeTransport, ClaudeTransportError, type RawRecord, type StreamRecord } from './transport.js';

export { CLAUDE_CODE_ADAPTER, DEFAULT_CLAUDE_EXECUTABLE, TESTED_CLAUDE_VERSION };

/** Strings longer than this are truncated inside event payloads; the raw capture keeps the full text. */
const MAX_PAYLOAD_STRING = 4_000;

export interface ClaudeCodeAdapterOptions {
  readonly executablePath?: string;
  /** Arguments prepended to every spawn. Tests point this at a replay script; production leaves it empty. */
  readonly extraArgs?: ReadonlyArray<string>;
  /** Directory for the raw JSONL capture of each session's stdio (the run artifacts logs dir). */
  readonly logsDir?: string;
  readonly onRawRecord?: (sessionId: string, record: RawRecord) => void;
  readonly probeTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** How long `deliver` waits for the runtime's `--replay-user-messages` acknowledgement. */
  readonly deliveryAckTimeoutMs?: number;
  /** Include `stream_event` partial-message chunks in the normalized stream. Off by default; always captured raw. */
  readonly includeDeltas?: boolean;
  /** Cap passed to `--max-budget-usd`. */
  readonly maxBudgetUsd?: number;
  /**
   * Grant the `Bash` tool. Off by default: see the file header. Turning this on
   * makes `write_containment` unsupported for the session and raises a session
   * diagnostic saying so.
   */
  readonly allowCommandExecution?: boolean;
  /** Model/effort table discovered from the `initialize` control response. */
  readonly settings?: RuntimeSettingsSupport;
}

/**
 * Settings support before the runtime has been asked.
 *
 * Model: nothing offered and not exhaustive — `--model` takes an alias or a
 * full model name, so an unlisted value is passed through unchanged and the
 * effective model is recorded from what the runtime reports in its `init`
 * record.
 *
 * Effort: exhaustive from the start. `--effort <unknown>` on this build prints
 * `Warning: Unknown --effort value '…' — ignoring it and using the default
 * effort` and continues, which is exactly the silent mapping plan section 8
 * forbids, so an unknown level is refused before anything is spawned.
 */
export const UNDISCOVERED_CLAUDE_SETTINGS: RuntimeSettingsSupport = {
  model: { offered: [], exhaustive: false },
  effort: {
    offered: CLAUDE_EFFORT_LEVELS.map((value) => ({ value, provenance: 'configured' as const, note: "listed by the installed executable's own --help" })),
    exhaustive: true,
  },
};

/** What the runtime reported for this session, as opposed to what was requested (FR006). */
export interface ClaudeEffectiveSettings {
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly tools: ReadonlyArray<string> | null;
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string | null }> | null;
  readonly apiKeySource: string | null;
  readonly cliVersion: string | null;
  readonly outputStyle: string | null;
  readonly cwd: string | null;
  readonly runtimeCapabilities: ReadonlyArray<string> | null;
  /** `account.tokenSource` from the `initialize` control response; `"none"` means the CLI holds no usable credential. */
  readonly tokenSource: string | null;
}

const EMPTY_EFFECTIVE: ClaudeEffectiveSettings = {
  model: null,
  permissionMode: null,
  tools: null,
  mcpServers: null,
  apiKeySource: null,
  cliVersion: null,
  outputStyle: null,
  cwd: null,
  runtimeCapabilities: null,
  tokenSource: null,
};

/** Usage the runtime reported for a turn. `costUsd` is null whenever the number cannot be trusted as measured. */
export interface ClaudeTurnUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly costUsd: number | null;
  /** `measured` only when the turn actually reached the provider; otherwise `unavailable` with a reason. */
  readonly costStatus: 'measured' | 'unavailable';
  readonly costDetail: string;
  readonly durationMs: number | null;
  readonly durationApiMs: number | null;
}

interface ClaudeSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly allowedWritePaths: ReadonlyArray<string>;
  readonly policy: Policy;
  readonly mapping: PolicyMapping;
  readonly transport: ClaudeTransport;
  readonly identity: ProcessIdentity;
  readonly handle: SessionHandle;
  readonly buffer: RuntimeEvent[];
  waiters: Array<() => void>;
  sequence: number;
  turnCounter: number;
  activeTurnId: string | null;
  readonly turnStartIndex: Map<string, number>;
  /**
   * Runtime turns whose `system/init` record has arrived but whose `result`
   * record has not. The runtime may schedule a message delivered mid-turn as a
   * turn of its own, so "one adapter turn" is not "one runtime turn": a result
   * only ends the adapter's turn when it leaves none outstanding.
   */
  openRuntimeTurns: number;
  /**
   * Turns the runtime says it still has queued, from the `queued_turn_count`
   * field of the last `result` record and from `still_queued` in an interrupt
   * response. Each of those turns produces a `result` of its own that belongs
   * to no adapter turn.
   */
  runtimeQueuedTurns: number;
  /** `system/init` records seen since the current adapter turn started; more than one means the runtime began an extra turn. */
  runtimeTurnsInCurrentTurn: number;
  /** Tool name per `tool_use` id, so a `tool_result` can name the tool it answers. */
  readonly toolCalls: Map<string, string>;
  /** File-mutating `tool_use` calls awaiting their `tool_result`: the request, not yet an applied change. */
  readonly pendingFileChanges: Map<string, { readonly tool: string; readonly path: string | null; readonly resolvedPath: string | null; readonly withinAllowedPaths: boolean | null; readonly rawRef: string }>;
  /** Turns for which an interrupt control request was accepted; their `result` normalizes to `turn_interrupted`. */
  readonly interruptRequested: Set<string>;
  /** Deliveries held by the adapter because no live turn could take them; flushed into the next `startTurn`. */
  readonly queued: DeliveryInput[];
  effective: ClaudeEffectiveSettings;
  readonly diagnostics: string[];
  lastUsage: ClaudeTurnUsage | null;
  sessionStartedEmitted: boolean;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  rawLogFd: number | null;
  readonly rawLogPath: string | null;
  closed: boolean;
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

function truncate(value: string): string {
  return value.length <= MAX_PAYLOAD_STRING ? value : `${value.slice(0, MAX_PAYLOAD_STRING)}…[truncated ${value.length - MAX_PAYLOAD_STRING} chars; full text is in the raw capture]`;
}

/** Shrink an arbitrary tool input for an event payload without losing its shape. */
function summarizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(summarizeUnknown);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) out[key] = summarizeUnknown(member);
    return out;
  }
  return value;
}

function requestedSettingsOf(input: SessionInput): RequestedSettings {
  return { ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
}

function report(status: CapabilityStatus, note: string): CapabilityReport {
  return { status, testedVersion: TESTED_CLAUDE_VERSION, os: 'darwin', note };
}

/**
 * Capability statuses for claude 2.1.260 on macOS.
 *
 * `verified` means this package executed the control against the installed
 * runtime. Everything that needs a *completed model turn* is
 * `supported_unverified`, because on the recording machine the stored
 * claude.ai OAuth session is expired: every turn ends in ~60 ms with
 * `error: "authentication_failed"` and `result.terminal_reason: "api_error"`,
 * and re-authenticating is an interactive action. The stream, the control
 * protocol, the session identity, the process group and the tool surface were
 * all still exercised against the real binary, because none of them needs the
 * provider.
 *
 * `write_containment` is `unsupported`, and that is the point of FR042 rather
 * than a gap in the testing: this runtime provides no process boundary at all.
 */
export const CLAUDE_CODE_CAPABILITIES: Readonly<Record<CapabilityName, CapabilityReport>> = {
  structured_events: report(
    'verified',
    '`--print --verbose --output-format stream-json` produced system/init, user (incl. --replay-user-messages echoes), assistant and result records plus control_response frames on real sessions, all normalized. Bare non-JSON stdout lines occur (`No conversation found with session ID: …`) and are preserved as raw events instead of breaking the stream',
  ),
  session_identity: report(
    'verified',
    'the uuid is minted by this adapter and passed as --session-id, so the coordinator knows the session id before the process starts; the installed build echoes it on every record and rejects a non-uuid value before starting',
  ),
  resume_session: report(
    'supported_unverified',
    '`--resume <id>` reuses the id (verified against the installed build; `--resume <id> --fork-session --session-id <new>` mints the new id, and an unknown id yields result subtype "error_during_execution" with an `errors` array). Whether the resumed turn actually continues the earlier conversation could not be executed on this machine: it needs a model turn and the stored OAuth session is expired',
  ),
  interrupt_turn: report(
    'supported_unverified',
    'the control round-trip is verified against the installed build: `{"type":"control_request","request":{"subtype":"interrupt"}}` on stdin is answered with `{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}`, and the init record advertises `interrupt_cancel_queued_v1`. Interrupting a *running model turn* and observing its terminal record could not be executed here (no credentials); the observed path is covered deterministically by the recorded-fixture replay',
  ),
  active_turn_delivery: report(
    'supported_unverified',
    'a user message written to the live process\'s stdin is acknowledged by the runtime (`--replay-user-messages` echoes it with isReplay=true) — verified. Whether the runtime injects it into the *running* turn or schedules it as the next one could not be observed here, and the runtime\'s own fields (`queued_turn_count`, `still_queued`) describe a queue. While this status is not `verified`, the adapter never issues the contract\'s strongest receipt on that evidence: an acknowledged mid-turn delivery is reported as `queued` with holder `runtime`, and `submitted_to_active_turn` is emitted only once this entry says `verified`',
  ),
  queued_delivery: report(
    'verified',
    'a delivery recorded with no active turn is held by the adapter and flushed into the next turn\'s user frame; the installed runtime echoed the combined frame back through --replay-user-messages',
  ),
  process_tree_stop: report(
    'verified',
    'the CLI is spawned as a process-group leader (detached); stdin close, then SIGTERM, then SIGKILL against the group. Executed: SIGTERM to the group ended the process with exit code 143 and left no group members',
  ),
  write_containment: report(
    'unsupported',
    'Claude Code 2.1.260 has no OS sandbox. Executed proof: a SessionStart hook the runtime itself launched wrote outside every granted directory, wrote to /tmp, read a file outside them and reached https://example.com — under `--restricted --permission-mode plan --permission-prompts none` as well as without them. What the flags do bound is the *tool surface* offered to the model (verified: `--restricted --tools …` yields exactly the named tools), which is a permission boundary, not a containment boundary. A kernel-level boundary must come from the environment around the process',
  ),
  model_selection: report(
    'verified',
    'the `initialize` control response lists the models the runtime offers with their resolved ids and supported effort levels; `--model sonnet` was reflected in the session\'s init record as `claude-sonnet-5`',
  ),
  effort_selection: report(
    'supported_unverified',
    '`--effort` is accepted and the runtime lists `low, medium, high, xhigh, max` per model in the initialize control response. An unknown value is warned about on stderr and silently replaced by the default, so this adapter refuses one before spawning. The runtime does not report the *effective* effort back in any record, so what actually took effect cannot be recorded',
  ),
  usage_reporting: report(
    'supported_unverified',
    'the result record carries `usage` (input/output/cache tokens), `modelUsage` and `total_cost_usd`. On this machine every turn failed authentication before reaching the provider, so the only values observed were the zeros of a turn that made no API call. The adapter therefore reports cost as `measured` only when the turn actually reached the provider and as `unavailable` otherwise — never zero for unknown',
  ),
  coordination_bridge: report('unsupported', 'the agent-callable bridge arrives with WP06; `--mcp-config` plus `--strict-mcp-config` is the intended injection point and is not exercised here'),
};

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = CLAUDE_CODE_ADAPTER;
  readonly #options: Required<
    Pick<
      ClaudeCodeAdapterOptions,
      'executablePath' | 'extraArgs' | 'probeTimeoutMs' | 'startupTimeoutMs' | 'controlTimeoutMs' | 'interruptTimeoutMs' | 'stopTimeoutMs' | 'deliveryAckTimeoutMs' | 'includeDeltas' | 'allowCommandExecution'
    >
  > &
    Pick<ClaudeCodeAdapterOptions, 'logsDir' | 'onRawRecord' | 'maxBudgetUsd'>;
  readonly #sessions = new Map<string, ClaudeSession>();
  #settings: RuntimeSettingsSupport;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#options = {
      executablePath: options.executablePath ?? DEFAULT_CLAUDE_EXECUTABLE,
      extraArgs: options.extraArgs ?? [],
      probeTimeoutMs: options.probeTimeoutMs ?? 15_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      controlTimeoutMs: options.controlTimeoutMs ?? 30_000,
      interruptTimeoutMs: options.interruptTimeoutMs ?? 15_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 5_000,
      deliveryAckTimeoutMs: options.deliveryAckTimeoutMs ?? 5_000,
      includeDeltas: options.includeDeltas ?? false,
      allowCommandExecution: options.allowCommandExecution ?? false,
      ...(options.logsDir !== undefined ? { logsDir: options.logsDir } : {}),
      ...(options.onRawRecord !== undefined ? { onRawRecord: options.onRawRecord } : {}),
      ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
    };
    this.#settings = options.settings ?? UNDISCOVERED_CLAUDE_SETTINGS;
  }

  // -------------------------------------------------------------------------
  // Discovery (FR001, FR002, FR005, FR006)
  // -------------------------------------------------------------------------

  /**
   * Passive readiness probe: `claude --version` and the documented
   * `claude auth status`. Neither starts a model turn, runs repository hooks
   * nor reads a credential store. Pass `{ live: true }` to additionally run the
   * `initialize` control round-trip, which starts a process but no model turn.
   */
  async probe(executablePath: string, options: { readonly live?: boolean } = {}): Promise<RuntimeReadiness> {
    const observedAt = nowIso();
    const diagnostics: string[] = [];
    const version = await this.#runVersion(executablePath, diagnostics);
    if (version === null) {
      return {
        adapter: CLAUDE_CODE_ADAPTER,
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
    const authentication = await this.#authStatus(executablePath, diagnostics);
    if (version !== TESTED_CLAUDE_VERSION) {
      diagnostics.push(`installed Claude Code ${version} differs from the tested version ${TESTED_CLAUDE_VERSION}; capability statuses were established against the tested version`);
    }

    if (options.live !== true) {
      return {
        adapter: CLAUDE_CODE_ADAPTER,
        executablePath,
        installed: true,
        version,
        adapterSupported: true,
        // Passively, the only evidence of controllability is that this is the
        // version the capability statuses were established against.
        controllable: version === TESTED_CLAUDE_VERSION,
        authentication,
        // Installed and adapter-supported is not readiness.
        ready: 'unknown',
        probeKind: 'passive',
        diagnostics,
        observedAt,
      };
    }

    let controllable = false;
    let tokenSource: string | null = null;
    try {
      const discovered = await this.discoverSettings(executablePath);
      this.#settings = discovered.settings;
      tokenSource = discovered.tokenSource;
      controllable = true;
      if (discovered.settings.model.offered.length === 0) diagnostics.push('the initialize control response listed no models');
    } catch (error) {
      diagnostics.push(`the initialize control round-trip failed: ${(error as Error).message}`);
    }

    // `claude auth status` reporting loggedIn=true is a claim about a stored
    // profile, not about a usable credential: on the recording machine it said
    // loggedIn=true while the CLI itself reported tokenSource "none" and every
    // turn failed with "OAuth session expired and could not be refreshed".
    let effectiveAuth = authentication;
    if (tokenSource !== null && tokenSource !== 'none') {
      effectiveAuth = 'logged_in';
    } else if (tokenSource === 'none') {
      effectiveAuth = 'logged_out';
      diagnostics.push('the runtime reports account.tokenSource "none": it holds no usable credential, whatever `claude auth status` says. Run `claude auth login` before dispatching a turn');
    }

    return {
      adapter: CLAUDE_CODE_ADAPTER,
      executablePath,
      installed: true,
      version,
      adapterSupported: true,
      controllable,
      authentication: effectiveAuth,
      ready: controllable && effectiveAuth === 'logged_in' ? 'verified_ready' : 'not_ready',
      probeKind: 'live',
      diagnostics,
      observedAt,
    };
  }

  #runVersion(executablePath: string, diagnostics: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(executablePath, ['--version'], { timeout: this.#options.probeTimeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) {
          diagnostics.push(`claude --version failed: ${error.message}`);
          resolve(null);
          return;
        }
        const version = parseClaudeVersion(stdout);
        if (version === null) {
          diagnostics.push(`could not parse a version from "${stdout.trim()}" (expected "2.1.260 (Claude Code)")`);
          resolve(null);
          return;
        }
        resolve(version);
      });
    });
  }

  /** Documented status command only. No credential store is read and no token is extracted. */
  #authStatus(executablePath: string, diagnostics: string[]): Promise<RuntimeReadiness['authentication']> {
    return new Promise((resolve) => {
      execFile(executablePath, ['auth', 'status'], { timeout: this.#options.probeTimeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        const text = `${stdout}${stderr}`;
        if (error !== null && text.trim().length === 0) {
          diagnostics.push(`claude auth status failed: ${error.message}`);
          resolve('unknown');
          return;
        }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, end + 1));
            const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
            if (loggedIn === true) {
              resolve('logged_in');
              return;
            }
            if (loggedIn === false) {
              resolve('logged_out');
              return;
            }
          } catch {
            // fall through to the text check
          }
        }
        const lower = text.toLowerCase();
        if (lower.includes('not logged in') || lower.includes('not signed in')) {
          resolve('logged_out');
          return;
        }
        if (lower.includes('logged in') || lower.includes('signed in')) {
          resolve('logged_in');
          return;
        }
        diagnostics.push(`claude auth status output was not recognised: ${text.trim().slice(0, 200)}`);
        resolve('unknown');
      });
    });
  }

  /**
   * Ask the running CLI what it offers, through the `initialize` control
   * request. This starts a process but no model turn, so it is safe for an
   * explicit connection check and costs nothing.
   */
  async discoverSettings(executablePath: string = this.#options.executablePath): Promise<{ readonly settings: RuntimeSettingsSupport; readonly tokenSource: string | null; readonly raw: unknown }> {
    const sessionId = uuidv7();
    const mapping = mapPolicy('analysis');
    const args = [
      ...this.#options.extraArgs,
      ...buildClaudeArgs({ sessionId, policy: 'analysis', mapping, allowedWritePaths: [], systemInstructions: '' }),
      // Discovery must leave nothing behind: no resumable session on disk.
      '--no-session-persistence',
    ];
    const transport = new ClaudeTransport({
      executablePath,
      args,
      cwd: process.cwd(),
      controlTimeoutMs: this.#options.controlTimeoutMs,
      stopTimeoutMs: this.#options.stopTimeoutMs,
    });
    transport.start();
    try {
      const raw = await transport.initialize(this.#options.startupTimeoutMs);
      const parsed = InitializeResponseSchema.safeParse(raw);
      if (!parsed.success) throw new AdapterError(CLAUDE_CODE_ADAPTER, 'protocol_error', `the initialize control response had an unexpected shape: ${parsed.error.message}`);
      const models: OfferedSetting[] = [];
      const efforts = new Map<string, OfferedSetting>();
      for (const model of parsed.data.models ?? []) {
        models.push({
          value: model.value,
          provenance: 'reported',
          ...(model.resolvedModel !== undefined && model.resolvedModel !== model.value ? { note: `resolves to ${model.resolvedModel}` } : {}),
        });
        for (const level of model.supportedEffortLevels ?? []) {
          if (!efforts.has(level)) efforts.set(level, { value: level, provenance: 'reported' });
        }
      }
      const effortOffered = efforts.size > 0 ? [...efforts.values()] : UNDISCOVERED_CLAUDE_SETTINGS.effort.offered;
      const settings: RuntimeSettingsSupport = {
        // `--model` documents both aliases and full model names, so an unlisted
        // value is passed through rather than refused.
        model: { offered: models, exhaustive: false },
        // `--effort` silently falls back on an unknown value, so the list must bite.
        effort: { offered: effortOffered, exhaustive: true },
      };
      this.#settings = settings;
      return { settings, tokenSource: parsed.data.account?.tokenSource ?? null, raw };
    } finally {
      await transport.stop();
    }
  }

  capabilities(): RuntimeCapabilities {
    const capabilities = {} as Record<CapabilityName, CapabilityReport>;
    for (const name of CAPABILITY_NAMES) capabilities[name] = CLAUDE_CODE_CAPABILITIES[name];
    return { adapter: CLAUDE_CODE_ADAPTER, capabilities, settings: this.#settings };
  }

  validateSettings(requested: RequestedSettings): SettingsValidation {
    return validateSettingsAgainst(CLAUDE_CODE_ADAPTER, this.#settings, requested);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async openSession(input: SessionInput): Promise<SessionHandle> {
    // The coordinator owns the identity: minted here, passed as --session-id,
    // known before the process starts and before any output arrives.
    return this.#openSession(input, uuidv7(), null);
  }

  async resumeSession(input: ResumeInput): Promise<SessionHandle> {
    const existing = this.#sessions.get(input.sessionId);
    if (existing !== undefined && !existing.closed && isProcessAlive(existing.identity.pid)) {
      throw new AdapterError(CLAUDE_CODE_ADAPTER, 'session_active', `session ${input.sessionId} still has a live claude process (pid ${existing.identity.pid}); stop it before resuming`);
    }
    const previous = input.previousProcess ?? null;
    if (previous !== null) {
      const status = matchProcessIdentity(previous);
      if (status === 'alive') {
        throw new AdapterError(CLAUDE_CODE_ADAPTER, 'session_active', `session ${input.sessionId} is still driven by process ${previous.pid} (spawn ${previous.spawnToken}); stop it before resuming`);
      }
      if (status === 'unverifiable') {
        throw new AdapterError(CLAUDE_CODE_ADAPTER, 'session_unverifiable', `pid ${previous.pid} exists but cannot be verified as the previous claude process for session ${input.sessionId}; isolate a successor instead of resuming`);
      }
    }
    return this.#openSession(input, input.sessionId, input.sessionId);
  }

  async #openSession(input: SessionInput, sessionId: string, resumeId: string | null): Promise<SessionHandle> {
    if (input.policy === 'verification') {
      throw new AdapterError(
        CLAUDE_CODE_ADAPTER,
        'unsupported_policy',
        'the verification profile runs configured check commands against a frozen candidate copy; it is the check runner\'s job, not a runtime session. Refusing to open a Claude Code session under it',
      );
    }
    const settings = this.validateSettings(requestedSettingsOf(input));
    if (!settings.ok) {
      const problems = [settings.model, settings.effort].filter((r) => r.status === 'unsupported').map((r) => r.message);
      throw new AdapterError(CLAUDE_CODE_ADAPTER, 'unsupported_setting', problems.join('; '));
    }

    const mapping = mapPolicy(input.policy, { allowCommandExecution: this.#options.allowCommandExecution });
    const allowedWritePaths = input.allowedWritePaths.map(canonicalPath);
    // `--add-dir` is the file tools' reach. The session cwd is always part of
    // it; the granted candidate paths are added explicitly.
    const addDirs = [...new Set([canonicalPath(input.cwd), ...allowedWritePaths])];

    const args = [
      ...this.#options.extraArgs,
      ...buildClaudeArgs({
        sessionId,
        policy: input.policy,
        mapping,
        allowedWritePaths: addDirs,
        systemInstructions: input.systemInstructions,
        model: input.model,
        effort: input.effort,
        maxBudgetUsd: this.#options.maxBudgetUsd,
        resume: resumeId ?? undefined,
        includeDeltas: this.#options.includeDeltas,
      }),
    ];

    const pendingRaw: RawRecord[] = [];
    let session: ClaudeSession | null = null;
    const transport = new ClaudeTransport({
      executablePath: this.#options.executablePath,
      args,
      cwd: input.cwd,
      controlTimeoutMs: this.#options.controlTimeoutMs,
      stopTimeoutMs: this.#options.stopTimeoutMs,
      ...(input.env !== undefined ? { env: input.env } : {}),
      onRaw: (record: RawRecord): void => {
        if (session === null) pendingRaw.push(record);
        else this.#writeRaw(session, record);
      },
    });

    const identity = transport.start();

    // The `initialize` control round-trip is the liveness handshake: it proves
    // the process is speaking the protocol before any turn is dispatched, and
    // it starts no model turn.
    let initializeRaw: unknown = null;
    const diagnostics: string[] = [];
    try {
      initializeRaw = await transport.initialize(this.#options.startupTimeoutMs);
    } catch (error) {
      await transport.stop();
      const stderr = transport.stderrLines.slice(-3).join(' | ');
      if (error instanceof ClaudeTransportError) {
        throw new AdapterError(CLAUDE_CODE_ADAPTER, `transport_${error.reason}`, `${error.message}${stderr ? ` (stderr: ${stderr})` : ''}`);
      }
      throw error;
    }

    const parsedInit = InitializeResponseSchema.safeParse(initializeRaw);
    const effective: ClaudeEffectiveSettings = {
      ...EMPTY_EFFECTIVE,
      permissionMode: parsedInit.success ? (parsedInit.data.current_permission_mode ?? null) : null,
      outputStyle: parsedInit.success ? (parsedInit.data.output_style ?? null) : null,
      tokenSource: parsedInit.success ? (parsedInit.data.account?.tokenSource ?? null) : null,
    };
    if (effective.tokenSource === 'none') {
      diagnostics.push('the runtime reports account.tokenSource "none": it holds no usable credential, so every turn will fail authentication. Run `claude auth login`');
    }
    if (effective.permissionMode !== null && effective.permissionMode !== mapping.permissionMode) {
      diagnostics.push(`requested permission mode "${mapping.permissionMode}" but the runtime reports "${effective.permissionMode}"`);
    }
    if (this.#options.allowCommandExecution) {
      diagnostics.push(
        'command execution (Bash) was explicitly granted: `--restricted` confines the file tools to the granted directories, but a shell command is not a file tool, so writes outside the candidate are no longer bounded by this runtime',
      );
    }

    const { fd, streamPath } = this.#openRawLog(sessionId, identity.spawnToken);
    const handle: SessionHandle = {
      adapter: CLAUDE_CODE_ADAPTER,
      sessionId,
      processId: identity.pid,
      process: identity,
      raw: { kind: 'claude-code-session', cwd: input.cwd, executablePath: this.#options.executablePath, args },
    };
    session = {
      sessionId,
      cwd: input.cwd,
      allowedWritePaths: addDirs,
      policy: input.policy,
      mapping,
      transport,
      identity,
      handle,
      buffer: [],
      waiters: [],
      sequence: 0,
      turnCounter: 0,
      activeTurnId: null,
      turnStartIndex: new Map(),
      openRuntimeTurns: 0,
      runtimeQueuedTurns: 0,
      runtimeTurnsInCurrentTurn: 0,
      toolCalls: new Map(),
      pendingFileChanges: new Map(),
      interruptRequested: new Set(),
      queued: [],
      effective,
      diagnostics,
      lastUsage: null,
      sessionStartedEmitted: false,
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
   * The raw capture is written with `writeSync` rather than a buffered stream:
   * a crash mid-turn must leave the frames that already arrived on disk,
   * because they are the only evidence of what the worker did.
   */
  #openRawLog(sessionId: string, spawnToken: string): { fd: number | null; streamPath: string | null } {
    const dir = this.#options.logsDir;
    if (dir === undefined) return { fd: null, streamPath: null };
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `claude-code-${sessionId}-${spawnToken}.jsonl`);
    return { fd: openSync(file, 'a'), streamPath: file };
  }

  #writeRaw(session: ClaudeSession, record: RawRecord): void {
    if (session.rawLogFd !== null) {
      try {
        writeSync(session.rawLogFd, `${JSON.stringify({ ...record, sessionId: session.sessionId, spawnToken: session.identity.spawnToken })}\n`);
      } catch {
        // A closed or full log must not take the session down; the normalized events remain.
      }
    }
    this.#options.onRawRecord?.(session.sessionId, record);
  }

  #closeRawLog(session: ClaudeSession): void {
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

  /** What the runtime reported for this session, as opposed to what was requested (FR006). */
  effectiveSettings(handle: SessionHandle): ClaudeEffectiveSettings | null {
    return this.#sessions.get(handle.sessionId)?.effective ?? null;
  }

  /** Diagnostics raised while opening the session (credential state, mismatched mode, widened profile). */
  sessionDiagnostics(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.diagnostics ?? [];
  }

  /** The policy mapping this session runs under, including everything the runtime cannot enforce. */
  policyMapping(handle: SessionHandle): PolicyMapping | null {
    return this.#sessions.get(handle.sessionId)?.mapping ?? null;
  }

  /** Usage the runtime reported for the most recent completed turn; `costStatus` says whether the number may be believed. */
  lastUsage(handle: SessionHandle): ClaudeTurnUsage | null {
    return this.#sessions.get(handle.sessionId)?.lastUsage ?? null;
  }

  /**
   * The same numbers in the shared contract shape (`RuntimeAdapter.lastTurnUsage`).
   *
   * The coordinator reads this and nothing else, so an adapter-shaped accessor
   * alone would leave the run manifest saying "no usage was reported" about a
   * turn whose usage the adapter measured. Unlike Codex, this runtime does
   * report `total_cost_usd`, and it reaches the manifest through here.
   */
  lastTurnUsage(handle: SessionHandle): TurnUsageReport | null {
    const usage = this.lastUsage(handle);
    if (usage === null) return null;
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      costStatus: usage.costStatus,
      detail: usage.costDetail,
    };
  }

  /** Deliveries the adapter is holding because no live turn could take them. */
  pendingDeliveries(handle: SessionHandle): ReadonlyArray<DeliveryInput> {
    return this.#sessions.get(handle.sessionId)?.queued ?? [];
  }

  /** Diagnostic access to captured stderr for a session. */
  stderrOf(handle: SessionHandle): ReadonlyArray<string> {
    return this.#sessions.get(handle.sessionId)?.transport.stderrLines ?? [];
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  #pump(session: ClaudeSession): void {
    void (async () => {
      try {
        for await (const record of session.transport.records(0, 250)) this.#normalize(session, record);
      } catch (error) {
        this.#push(session, 'error', session.activeTurnId, { fatal: true, reason: 'stream_failed', message: (error as Error).message }, this.#rawRef(session, 'stream'));
      }
      const exit = session.transport.exited;
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

  #rawRef(session: ClaudeSession, suffix: string | number): string {
    return `claude-code:${session.sessionId}:${session.identity.spawnToken}:${suffix}`;
  }

  #normalize(session: ClaudeSession, record: StreamRecord): void {
    const rawRef = this.#rawRef(session, record.sequence);
    const decoded = record.decoded;
    if (decoded.kind === 'text') {
      // The CLI prints bare lines on stdout (e.g. `No conversation found with
      // session ID: …`). Evidence, not a crash.
      this.#push(session, 'raw', session.activeTurnId, { reason: 'non_json_stdout_line', line: truncate(decoded.line) }, rawRef);
      return;
    }
    if (decoded.kind === 'foreign') {
      this.#push(session, 'raw', session.activeTurnId, { reason: 'json_without_type', value: summarizeUnknown(decoded.value) }, rawRef);
      return;
    }
    if (isDeltaRecord(decoded.type)) {
      if (this.#options.includeDeltas) this.#push(session, 'raw', session.activeTurnId, { reason: 'partial_message', record: summarizeUnknown(decoded.value) }, rawRef);
      return;
    }

    switch (decoded.type) {
      case 'system':
        this.#normalizeSystem(session, decoded.value, rawRef);
        return;
      case 'assistant':
        this.#normalizeAssistant(session, decoded.value, rawRef);
        return;
      case 'user':
        this.#normalizeUser(session, decoded.value, rawRef);
        return;
      case 'result':
        this.#normalizeResult(session, decoded.value, rawRef);
        return;
      case 'control_response': {
        // The `initialize` response is tens of kilobytes of command and agent
        // descriptions. The event records that it arrived and what it settled;
        // the raw capture keeps every byte.
        const response = (decoded.value['response'] ?? {}) as Record<string, unknown>;
        this.#push(
          session,
          'raw',
          session.activeTurnId,
          { reason: 'control_response', subtype: response['subtype'] ?? null, requestId: response['request_id'] ?? null, bytes: JSON.stringify(decoded.value).length },
          rawRef,
        );
        return;
      }
      default:
        // control_request and anything a later build adds.
        this.#push(session, 'raw', session.activeTurnId, { reason: 'runtime_record', recordType: decoded.type, record: summarizeUnknown(decoded.value) }, rawRef);
    }
  }

  #normalizeSystem(session: ClaudeSession, value: Record<string, unknown>, rawRef: string): void {
    const parsed = SystemInitSchema.safeParse(value);
    if (!parsed.success || parsed.data.subtype !== 'init') {
      this.#push(session, 'raw', session.activeTurnId, { reason: 'system_record', record: summarizeUnknown(value) }, rawRef);
      return;
    }
    const init = parsed.data;
    session.effective = {
      ...session.effective,
      model: init.model ?? session.effective.model,
      permissionMode: init.permissionMode ?? session.effective.permissionMode,
      tools: init.tools ?? session.effective.tools,
      mcpServers: init.mcp_servers?.map((s) => ({ name: s.name, status: s.status ?? null })) ?? session.effective.mcpServers,
      apiKeySource: init.apiKeySource ?? session.effective.apiKeySource,
      cliVersion: init.claude_code_version ?? session.effective.cliVersion,
      outputStyle: init.output_style ?? session.effective.outputStyle,
      cwd: init.cwd ?? session.effective.cwd,
      runtimeCapabilities: init.capabilities ?? session.effective.runtimeCapabilities,
    };
    if (init.session_id !== undefined && init.session_id !== session.sessionId) {
      session.diagnostics.push(`the runtime reported session id "${init.session_id}" for a session opened as "${session.sessionId}"`);
    }
    // One `init` record per *runtime* turn. Count it: the runtime may run a
    // turn this adapter did not start (a message delivered mid-turn that it
    // scheduled as its own turn), and its `result` must not be allowed to
    // terminate whichever adapter turn happens to be active.
    session.openRuntimeTurns += 1;
    session.runtimeTurnsInCurrentTurn += 1;

    // The runtime emits one `init` record per turn, not one per process. The
    // first one is also this process's session start.
    if (!session.sessionStartedEmitted) {
      session.sessionStartedEmitted = true;
      this.#push(
        session,
        'session_started',
        null,
        {
          sessionId: session.sessionId,
          reportedSessionId: init.session_id ?? null,
          cwd: init.cwd ?? null,
          cliVersion: init.claude_code_version ?? null,
          model: init.model ?? null,
          permissionMode: init.permissionMode ?? null,
          tools: init.tools ?? null,
          mcpServers: session.effective.mcpServers,
          apiKeySource: init.apiKeySource ?? null,
          runtimeCapabilities: init.capabilities ?? null,
          policy: session.policy,
          allowedWritePaths: session.allowedWritePaths,
          unenforceable: session.mapping.unenforceable,
        },
        rawRef,
      );
    }
    if (session.openRuntimeTurns > 1) {
      // The signal that a second runtime turn began while one was still open.
      // Recorded rather than smoothed over: it is why the next `result` may not
      // be read as this adapter turn's terminal record.
      this.#push(
        session,
        'raw',
        session.activeTurnId,
        {
          reason: 'extra_runtime_turn_started',
          adapterTurnId: session.activeTurnId,
          openRuntimeTurns: session.openRuntimeTurns,
          note: 'the runtime started another turn of its own (one system/init record per runtime turn) while this adapter turn was still open; a result record only ends the adapter turn once no runtime turn is left outstanding',
        },
        `${rawRef}#extra-init`,
      );
    }
    this.#push(
      session,
      'turn_started',
      session.activeTurnId,
      { permissionMode: init.permissionMode ?? null, model: init.model ?? null, tools: init.tools ?? null, openRuntimeTurns: session.openRuntimeTurns, runtimeTurnsInCurrentTurn: session.runtimeTurnsInCurrentTurn },
      rawRef,
    );
  }

  #normalizeAssistant(session: ClaudeSession, value: Record<string, unknown>, rawRef: string): void {
    const parsed = AssistantRecordSchema.safeParse(value);
    if (!parsed.success) {
      this.#push(session, 'raw', session.activeTurnId, { reason: 'assistant_record', record: summarizeUnknown(value) }, rawRef);
      return;
    }
    const turnId = session.activeTurnId;
    const record = parsed.data;
    const blocks = this.#contentBlocks(record.message.content);

    if (record.is_api_error_message === true) {
      const text = blocks.map((b) => b.text ?? '').join('').trim();
      this.#push(
        session,
        'error',
        turnId,
        {
          // Not fatal to the stream: a result record still follows with the turn's status.
          fatal: false,
          message: truncate(text),
          errorClass: classifyClaudeError({ error: record.error, message: text }),
          runtimeError: record.error ?? null,
          willRetry: false,
        },
        rawRef,
      );
      return;
    }

    blocks.forEach((block, index) => {
      const ref = blocks.length === 1 ? rawRef : `${rawRef}#${index}`;
      this.#normalizeAssistantBlock(session, turnId, block, ref, record.parent_tool_use_id ?? null);
    });
  }

  #contentBlocks(content: unknown): ContentBlock[] {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    const blocks: ContentBlock[] = [];
    for (const entry of content) {
      const parsed = ContentBlockSchema.safeParse(entry);
      blocks.push(parsed.success ? parsed.data : { type: 'unknown' });
    }
    return blocks;
  }

  #normalizeAssistantBlock(session: ClaudeSession, turnId: string | null, block: ContentBlock, rawRef: string, parentToolUseId: string | null): void {
    switch (block.type) {
      case 'text': {
        this.#push(
          session,
          'assistant_message',
          turnId,
          {
            text: truncate(block.text ?? ''),
            parentToolUseId,
            // This runtime marks no message as the terminal answer, so nothing
            // here may be read as a completion claim (FR050). A model saying
            // "done" is an assistant message and nothing more.
            claimsDone: false,
            phaseKnown: false,
            claimsDoneNote: 'claude 2.1.260 emits no terminal-answer marker; a completion claim is never derived from the prose',
          },
          rawRef,
        );
        return;
      }
      case 'tool_use': {
        const tool = block.name ?? 'unknown';
        const input = block.input;
        if (block.id != null) session.toolCalls.set(block.id, tool);
        this.#push(session, 'tool_call', turnId, { tool, toolUseId: block.id ?? null, parentToolUseId, status: 'started', input: summarizeUnknown(input) }, rawRef);
        if (FILE_MUTATING_TOOLS.includes(tool)) this.#pushFileChange(session, turnId, tool, block.id ?? null, input, `${rawRef}#file`);
        if (tool === 'Bash') {
          const command = typeof (input as { command?: unknown })?.command === 'string' ? ((input as { command: string }).command) : null;
          this.#push(session, 'command_exec', turnId, { tool, toolUseId: block.id ?? null, command: command === null ? null : truncate(command), cwd: session.cwd, phase: 'started' }, `${rawRef}#exec`);
        }
        return;
      }
      case 'thinking':
      case 'redacted_thinking': {
        this.#push(session, 'raw', turnId, { reason: 'thinking_block', hasText: typeof block.text === 'string' }, rawRef);
        return;
      }
      default:
        this.#push(session, 'raw', turnId, { reason: 'assistant_block', blockType: block.type, block: summarizeUnknown(block) }, rawRef);
    }
  }

  /**
   * The model's *request* to change a file.
   *
   * `applied` is `null`, not `false`: at this point the outcome is unknown, and
   * `false` would be indistinguishable from a write the runtime refused. The
   * matching `tool_result` supplies the answer through `#completeFileChange`,
   * and the request is remembered until it arrives so the two can be
   * correlated by `tool_use` id. A request whose result never arrives stays
   * `applied: null` — unconfirmed, which the coordinator treats as an escape
   * it cannot rule out rather than as a change it can dismiss.
   */
  #pushFileChange(session: ClaudeSession, turnId: string | null, tool: string, toolUseId: string | null, input: unknown, rawRef: string): void {
    const filePath = typeof (input as { file_path?: unknown })?.file_path === 'string' ? (input as { file_path: string }).file_path : null;
    const resolved = filePath === null ? null : canonicalPath(path.isAbsolute(filePath) ? filePath : path.join(session.cwd, filePath));
    const withinAllowedPaths = resolved === null ? null : session.allowedWritePaths.some((root) => isWithin(root, resolved));
    if (toolUseId !== null) session.pendingFileChanges.set(toolUseId, { tool, path: filePath, resolvedPath: resolved, withinAllowedPaths, rawRef });
    this.#push(
      session,
      'file_change',
      turnId,
      {
        tool,
        toolUseId,
        path: filePath,
        resolvedPath: resolved,
        withinAllowedPaths,
        applied: null,
        denied: false,
        phase: 'requested',
        ...(filePath === null ? { note: 'the tool call carried no file_path' } : {}),
      },
      rawRef,
    );
  }

  /**
   * The answer to a file-mutating tool call: the second `file_change` for the
   * same path, carrying whether the write actually happened.
   *
   * This is the distinction the containment argument turns on for a runtime
   * with no OS sandbox (docs/runtime-claude-code.md section 5.5): a write
   * outside the grant that the runtime *denied* is the tool boundary working,
   * and a write it *applied* is an escape. Without correlating the result back
   * to the request the two are the same event.
   */
  #completeFileChange(session: ClaudeSession, turnId: string | null, toolUseId: string, isError: boolean, content: unknown, rawRef: string): void {
    const pending = session.pendingFileChanges.get(toolUseId);
    if (pending === undefined) return;
    session.pendingFileChanges.delete(toolUseId);
    this.#push(
      session,
      'file_change',
      turnId,
      {
        tool: pending.tool,
        toolUseId,
        path: pending.path,
        resolvedPath: pending.resolvedPath,
        withinAllowedPaths: pending.withinAllowedPaths,
        applied: !isError,
        denied: isError,
        phase: 'completed',
        ...(isError ? { detail: truncate(typeof content === 'string' ? content : JSON.stringify(content ?? null)) } : {}),
      },
      rawRef,
    );
  }

  #normalizeUser(session: ClaudeSession, value: Record<string, unknown>, rawRef: string): void {
    const parsed = UserRecordSchema.safeParse(value);
    if (!parsed.success) {
      this.#push(session, 'raw', session.activeTurnId, { reason: 'user_record', record: summarizeUnknown(value) }, rawRef);
      return;
    }
    const record = parsed.data;
    const turnId = session.activeTurnId;
    const blocks = this.#contentBlocks(record.message.content);

    if (record.isReplay === true) {
      // `--replay-user-messages`: the runtime acknowledging a message we wrote
      // to its stdin. This is the only submission receipt the CLI gives.
      const text = typeof record.message.content === 'string' ? record.message.content : blocks.map((b) => b.text ?? '').join('');
      this.#push(session, 'raw', turnId, { reason: 'user_message_replay', text: truncate(text) }, rawRef);
      return;
    }

    let emitted = false;
    blocks.forEach((block, index) => {
      if (block.type !== 'tool_result') return;
      emitted = true;
      const ref = blocks.length === 1 ? rawRef : `${rawRef}#${index}`;
      const toolUseId = block.tool_use_id ?? null;
      const isError = block.is_error === true;
      // `tool`/`status`/`ok` are the shared vocabulary every consumer reads
      // (src/core/run-direct.ts renderRuntimeEvent, src/telemetry/events.ts).
      // The runtime names the tool only on the *call*, so the id is correlated
      // back to it here rather than leaving the reader with "tool unknown".
      const tool = toolUseId === null ? null : (session.toolCalls.get(toolUseId) ?? null);
      this.#push(
        session,
        'tool_result',
        turnId,
        {
          tool,
          toolUseId,
          status: isError ? 'failed' : 'ok',
          ok: !isError,
          isError,
          content: summarizeUnknown(block.content),
        },
        ref,
      );
      if (toolUseId !== null) {
        this.#completeFileChange(session, turnId, toolUseId, isError, block.content, `${ref}#file`);
        session.toolCalls.delete(toolUseId);
      }
    });
    if (!emitted) this.#push(session, 'raw', turnId, { reason: 'user_record', record: summarizeUnknown(value) }, rawRef);
  }

  /**
   * A `result` record: the end of one *runtime* turn.
   *
   * Two rules, both of them about not attributing evidence to the wrong turn:
   *
   *  - a record whose body this adapter cannot parse still ends a turn. The
   *    alternative — demoting it to `raw` — leaves `activeTurnId` set, so the
   *    turn's event stream never returns and the run hangs to its deadline
   *    over one unexpected `null`. Plan section 9 asks for raw output plus a
   *    protocol diagnostic instead, which is what this emits;
   *  - a record only ends the *adapter's* turn when no other runtime turn can
   *    own it. The runtime may schedule a message delivered mid-turn as a turn
   *    of its own, and that turn's result must not terminate the next adapter
   *    turn's stream with another turn's usage, cost and result text. Two
   *    signals say when that is happening, and neither is guesswork: an
   *    unmatched `system/init` (a second runtime turn began while one was
   *    open), and the runtime's own `queued_turn_count` on the previous result
   *    (turns it says it still has to run). A result claimed by either is kept
   *    as a `raw` event with the mismatch recorded, and the adapter's turn
   *    stays open for its own result.
   */
  #normalizeResult(session: ClaudeSession, value: Record<string, unknown>, rawRef: string): void {
    const parsed = ResultRecordSchema.safeParse(value);
    const result = parsed.success ? parsed.data : null;
    const protocolError = parsed.success ? null : parsed.error.message;
    const turnId = session.activeTurnId;

    // A result closes one open runtime turn. A result with none open (a resume
    // failure answers before any init) closes the adapter's turn on its own.
    session.openRuntimeTurns = Math.max(0, session.openRuntimeTurns - 1);
    const anotherRuntimeTurnIsOpen = session.openRuntimeTurns > 0;
    const runtimeStillHasQueuedTurns = session.runtimeQueuedTurns > 0;
    const endsAdapterTurn = !anotherRuntimeTurnIsOpen && !runtimeStillHasQueuedTurns;
    if (!endsAdapterTurn && session.runtimeQueuedTurns > 0) session.runtimeQueuedTurns -= 1;
    // The runtime's own statement of its queue depth wins over the count above.
    if (result !== null && typeof result.queued_turn_count === 'number') session.runtimeQueuedTurns = Math.max(0, result.queued_turn_count);

    if (result === null) {
      this.#push(
        session,
        'error',
        turnId,
        {
          fatal: false,
          reason: 'malformed_result_record',
          message: `the runtime's result record did not match the expected shape: ${protocolError ?? 'unknown validation error'}`,
          errorClass: 'unknown' satisfies ClaudeErrorClass,
          record: summarizeUnknown(value),
        },
        `${rawRef}#protocol`,
      );
    }

    const usage = readUsage(result ?? {});
    if (endsAdapterTurn) session.lastUsage = usage;

    if (!endsAdapterTurn) {
      // Evidence of a turn this adapter did not start. Keep it verbatim and
      // leave the adapter's turn open; the record belongs to nothing here.
      this.#push(
        session,
        'raw',
        null,
        {
          reason: 'unattributed_result_record',
          adapterTurnId: turnId,
          openRuntimeTurns: session.openRuntimeTurns,
          runtimeQueuedTurns: session.runtimeQueuedTurns,
          cause: anotherRuntimeTurnIsOpen ? 'another runtime turn was still open' : 'the runtime reported turns of its own still queued',
          note: 'this result belongs to a runtime turn this adapter did not start (a message delivered mid-turn that the runtime scheduled as its own turn); it is kept as evidence and does not terminate the active adapter turn, whose own result is still to come',
          record: summarizeUnknown(value),
        },
        `${rawRef}#unattributed`,
      );
      return;
    }

    const interruptedByUs = turnId !== null && session.interruptRequested.has(turnId);
    const terminal = (result?.terminal_reason ?? '').toLowerCase();
    const interruptedByRuntime = terminal.includes('interrupt') || terminal.includes('cancel') || terminal.includes('abort');
    const kind: RuntimeEventKind = interruptedByUs || interruptedByRuntime ? 'turn_interrupted' : 'turn_completed';

    if (turnId !== null) session.interruptRequested.delete(turnId);
    session.activeTurnId = null;
    const runtimeTurns = session.runtimeTurnsInCurrentTurn;
    session.runtimeTurnsInCurrentTurn = 0;

    this.#push(
      session,
      kind,
      turnId,
      {
        subtype: result?.subtype ?? null,
        isError: result === null ? true : result.is_error === true,
        terminalReason: result === null ? 'malformed_result_record' : (result.terminal_reason ?? null),
        numTurns: result?.num_turns ?? null,
        durationMs: result?.duration_ms ?? null,
        durationApiMs: result?.duration_api_ms ?? null,
        queuedTurnCount: result?.queued_turn_count ?? null,
        permissionDenials: summarizeUnknown(result?.permission_denials ?? []),
        resultText: result?.result == null ? null : truncate(result.result),
        errors: summarizeUnknown(result?.errors ?? []),
        errorClass: result === null ? 'unknown' : result.is_error === true ? classifyClaudeError({ subtype: result.subtype, terminalReason: result.terminal_reason, message: result.result }) : null,
        usage: { ...usage },
        interruptRequestedByCoordinator: interruptedByUs,
        // How many runtime turns ran under this one adapter turn. More than one
        // means the runtime scheduled work of its own; the extra results are
        // `raw` events, not this turn's evidence.
        runtimeTurnsObserved: runtimeTurns,
        ...(result === null ? { protocolError, record: summarizeUnknown(value) } : {}),
        // A finished turn is a runtime claim, never an acceptance (FR050).
        evidence: 'runtime_reported',
      },
      rawRef,
    );
  }

  #push(session: ClaudeSession, kind: RuntimeEventKind, turnId: string | null, payload: Record<string, unknown>, rawRef: string): void {
    session.sequence += 1;
    session.buffer.push({
      kind,
      adapter: CLAUDE_CODE_ADAPTER,
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

  #wake(session: ClaudeSession): void {
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  #session(handle: Pick<SessionHandle, 'sessionId'>): ClaudeSession {
    const session = this.#sessions.get(handle.sessionId);
    if (session === undefined) throw new AdapterError(CLAUDE_CODE_ADAPTER, 'unknown_session', `session ${handle.sessionId} is not owned by this adapter instance`);
    return session;
  }

  async startTurn(handle: SessionHandle, input: TurnInput): Promise<TurnHandle> {
    const session = this.#session(handle);
    if (session.activeTurnId !== null) {
      throw new AdapterError(CLAUDE_CODE_ADAPTER, 'turn_active', `session ${session.sessionId} already has active turn ${session.activeTurnId}; only one turn may be active per session`);
    }
    if (session.closed) throw new AdapterError(CLAUDE_CODE_ADAPTER, 'session_closed', `session ${session.sessionId} has no live claude process`);

    const queued = session.queued.splice(0);
    const text = [
      ...queued.map((message) => `[coordinator message ${message.messageId}${message.correlationId ? ` re ${message.correlationId}` : ''}]\n${message.body}`),
      ...(input.contextRefs !== undefined && input.contextRefs.length > 0 ? [`[context references]\n${input.contextRefs.join('\n')}`] : []),
      input.prompt,
    ].join('\n\n');

    session.turnCounter += 1;
    const turnId = `turn-${session.turnCounter}`;
    const startIndex = session.buffer.length;
    session.runtimeTurnsInCurrentTurn = 0;
    try {
      session.transport.sendUserMessage(session.sessionId, text);
    } catch (error) {
      // The turn never started: put the queued messages back so they are not lost.
      session.queued.unshift(...queued);
      session.turnCounter -= 1;
      if (error instanceof ClaudeTransportError) throw new AdapterError(CLAUDE_CODE_ADAPTER, `transport_${error.reason}`, error.message);
      throw error;
    }
    session.activeTurnId = turnId;
    session.turnStartIndex.set(turnId, startIndex);
    return { adapter: CLAUDE_CODE_ADAPTER, sessionId: session.sessionId, turnId, startedAt: nowIso() };
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
   * Deliver a coordinator message.
   *
   * Every receipt names a holder, because a receipt that names none is a
   * message nobody will deliver:
   *
   *  - no live turn → the adapter holds it and flushes it into the next
   *    `startTurn`; `queued`, holder `adapter`;
   *  - a live turn, and the runtime echoed the frame back
   *    (`--replay-user-messages`) while that turn was still active → the
   *    runtime holds it; holder `runtime`. The *state* is only
   *    `submitted_to_active_turn` when `active_turn_delivery` is `verified`
   *    for this runtime — the echo proves ingestion, not injection into the
   *    running turn, and this build's own `queued_turn_count` / `still_queued`
   *    fields describe a queue;
   *  - a live turn, but the write failed or no acknowledgement arrived → the
   *    adapter takes the message back and flushes it into the next turn;
   *    `queued`, holder `adapter`. Delivery is at-least-once with idempotent
   *    ingestion (plan section 8), so a re-send the runtime had already
   *    received is suppressed by its message id, whereas a message held by
   *    nobody is simply lost;
   *  - a session whose process is gone → an error, not a receipt. `startTurn`
   *    on such a session always throws, so "queued for the next turn" would be
   *    a promise the adapter cannot keep.
   *
   */
  async deliver(handle: SessionHandle, input: DeliveryInput): Promise<DeliveryReceipt> {
    const session = this.#session(handle);
    if (session.closed) {
      // The same refusal `startTurn` gives. A receipt promising the next turn
      // would name a turn this session can never have.
      throw new AdapterError(
        CLAUDE_CODE_ADAPTER,
        'session_closed',
        `session ${session.sessionId} has no live claude process, so message ${input.messageId} cannot be delivered or held for a later turn; open a new session for it`,
      );
    }
    const activeTurn = session.activeTurnId;
    if (activeTurn === null) {
      session.queued.push(input);
      return {
        messageId: input.messageId,
        state: 'queued',
        turnId: null,
        holder: 'adapter',
        at: nowIso(),
        detail: 'no turn was active; the adapter holds this message and flushes it into the next turn',
      };
    }

    const marker = `[coordinator message ${input.messageId}${input.correlationId ? ` re ${input.correlationId}` : ''}]`;
    const body = `${marker}\n${input.body}`;
    const fromIndex = session.buffer.length;
    try {
      session.transport.sendUserMessage(session.sessionId, body);
    } catch (error) {
      session.queued.push(input);
      this.#push(session, 'raw', activeTurn, { reason: 'delivery_write_failed', messageId: input.messageId, message: (error as Error).message }, this.#rawRef(session, `deliver-${input.messageId}`));
      return {
        messageId: input.messageId,
        state: 'queued',
        turnId: null,
        holder: 'adapter',
        at: nowIso(),
        detail: `the runtime would not accept input (${(error as Error).message}); the adapter holds this message for the next turn`,
      };
    }

    const acknowledged = await this.#waitForEvent(
      session,
      fromIndex,
      (event) => event.kind === 'raw' && event.payload['reason'] === 'user_message_replay' && typeof event.payload['text'] === 'string' && (event.payload['text'] as string).includes(marker),
      this.#options.deliveryAckTimeoutMs,
    );
    if (acknowledged !== null && session.activeTurnId === activeTurn) {
      // The runtime has it. Whether it joins the running turn is the open
      // question `active_turn_delivery` records, so the stronger state is
      // claimed only once that capability is verified against a real turn.
      const verified = CLAUDE_CODE_CAPABILITIES.active_turn_delivery.status === 'verified';
      return verified
        ? {
            messageId: input.messageId,
            state: 'submitted_to_active_turn',
            turnId: activeTurn,
            holder: 'runtime',
            at: nowIso(),
            detail: 'written to the live runtime during an active turn and echoed back by --replay-user-messages',
          }
        : {
            messageId: input.messageId,
            state: 'queued',
            turnId: null,
            holder: 'runtime',
            at: nowIso(),
            detail: `the runtime acknowledged this message during ${activeTurn} (--replay-user-messages echoed it back) and holds it; whether it joins that running turn or is scheduled as the next one is not established for claude ${TESTED_CLAUDE_VERSION} (active_turn_delivery is supported_unverified), so submission into the active turn is not claimed`,
          };
    }

    // Nobody acknowledged it, so the adapter takes it back rather than leaving
    // it with a runtime that may never have read it. A duplicate is suppressed
    // by the message id in the marker; a lost message is not recoverable.
    if (session.closed) {
      throw new AdapterError(
        CLAUDE_CODE_ADAPTER,
        'session_closed',
        `message ${input.messageId} was written to the claude process but the process ended before acknowledging it; the message is not held by the runtime or by the adapter and must be delivered in a new session`,
      );
    }
    session.queued.unshift(input);
    return {
      messageId: input.messageId,
      state: 'queued',
      turnId: null,
      holder: 'adapter',
      at: nowIso(),
      detail:
        acknowledged === null
          ? `the message was written to the runtime but not acknowledged within ${this.#options.deliveryAckTimeoutMs}ms; the adapter holds it and flushes it into the next turn (the message id suppresses a duplicate if the runtime did receive it)`
          : 'the turn ended before the runtime acknowledged the message; the adapter holds it and flushes it into the next turn',
    };
  }

  /**
   * Request interruption, then wait for the runtime to end the turn.
   * `requested` means the control request was accepted; `observed` means a
   * terminal record for that turn actually arrived.
   */
  async interrupt(turn: TurnHandle): Promise<InterruptionReceipt> {
    const session = this.#session({ sessionId: turn.sessionId });
    const alreadyEnded = (): boolean => session.buffer.some((e) => e.turnId === turn.turnId && (e.kind === 'turn_completed' || e.kind === 'turn_interrupted'));
    if (alreadyEnded()) return { turnId: turn.turnId, state: 'observed', at: nowIso(), detail: 'the turn had already produced a terminal record before the interrupt was requested' };

    const startIndex = session.buffer.length;
    const requestedAt = nowIso();
    session.interruptRequested.add(turn.turnId);
    try {
      const response = await session.transport.interrupt(this.#options.interruptTimeoutMs);
      const stillQueued = (response as { still_queued?: unknown } | null)?.still_queued;
      // The runtime's own statement of what it still has queued. The installed
      // build advertises `interrupt_cancel_queued_v1`, so an interrupt that
      // answers with an empty list has cancelled the queue, and no further
      // result records are owed to turns this adapter did not start.
      session.runtimeQueuedTurns = Array.isArray(stillQueued) ? stillQueued.length : 0;
      this.#push(session, 'raw', turn.turnId, { reason: 'interrupt_acknowledged', stillQueued: summarizeUnknown(stillQueued ?? []) }, this.#rawRef(session, `interrupt-${turn.turnId}`));
    } catch (error) {
      if (error instanceof ClaudeTransportError && error.reason === 'closed') {
        // The process is gone, so the turn cannot still be running; say what is observed.
        return { turnId: turn.turnId, state: alreadyEnded() ? 'observed' : 'requested', at: nowIso(), detail: `the claude process had already exited (${error.message})` };
      }
      throw error instanceof ClaudeTransportError ? new AdapterError(CLAUDE_CODE_ADAPTER, `transport_${error.reason}`, error.message) : error;
    }

    const observed = await this.#waitForEvent(
      session,
      startIndex,
      (event) => event.turnId === turn.turnId && (event.kind === 'turn_interrupted' || event.kind === 'turn_completed'),
      this.#options.interruptTimeoutMs,
    );
    return observed === null
      ? { turnId: turn.turnId, state: 'requested', at: requestedAt, detail: `the runtime accepted the interrupt but produced no terminal record within ${this.#options.interruptTimeoutMs}ms` }
      : { turnId: turn.turnId, state: 'observed', at: nowIso(), detail: `terminal record observed: ${observed.kind}` };
  }

  async #waitForEvent(session: ClaudeSession, fromIndex: number, predicate: (event: RuntimeEvent) => boolean, timeoutMs: number): Promise<RuntimeEvent | null> {
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
      const result = await session.transport.stop();
      session.closed = true;
      this.#closeRawLog(session);
      const terminated = result.exited && !result.groupAlive;
      return {
        sessionId: handle.sessionId,
        state: terminated ? 'process_tree_terminated' : result.signalled === null ? 'unknown' : 'requested',
        processId: session.identity.pid,
        signal: result.signalled,
        at,
        ...(terminated
          ? { detail: `process group ${session.identity.pid} is empty after ${result.signalled ?? 'stdin close'}` }
          : { detail: `claude process group ${session.identity.pid} still has members after ${result.signalled ?? 'stdin close'}` }),
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
        return { sessionId: handle.sessionId, state: 'unknown', processId: identity.pid, signal: null, at, detail: `pid ${identity.pid} exists but cannot be verified as the owned claude process; nothing was signalled` };
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
      detail: dead ? `process group ${pid} is empty` : `process group ${pid} still has members after SIGTERM+SIGKILL`,
    };
  }

  async reconcile(handle: SessionHandle): Promise<ObservedRuntimeState> {
    const observedAt = nowIso();
    const session = this.#sessions.get(handle.sessionId);
    if (session !== undefined) {
      const exit = session.transport.exited;
      const status: ProcessIdentityStatus = exit !== null ? 'dead' : matchProcessIdentity(session.identity);
      return {
        adapter: CLAUDE_CODE_ADAPTER,
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
      adapter: CLAUDE_CODE_ADAPTER,
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
}

/**
 * Read usage off a result record.
 *
 * `total_cost_usd` is only believed when the turn actually reached the
 * provider: a turn that died on a local authentication failure reports
 * `total_cost_usd: 0`, `duration_api_ms: 0` and all-zero token counts, and
 * reporting that as a measured zero cost would be a lie (AT14: "unavailable
 * cost is not reported as zero").
 */
export function readUsage(result: {
  readonly usage?: unknown;
  readonly total_cost_usd?: number | null | undefined;
  readonly duration_ms?: number | null | undefined;
  readonly duration_api_ms?: number | null | undefined;
}): ClaudeTurnUsage {
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const num = (key: string): number | null => (typeof usage[key] === 'number' ? (usage[key] as number) : null);
  const inputTokens = num('input_tokens');
  const outputTokens = num('output_tokens');
  const cacheRead = num('cache_read_input_tokens');
  const cacheCreation = num('cache_creation_input_tokens');
  const apiMs = result.duration_api_ms ?? null;
  const reachedProvider = (apiMs !== null && apiMs > 0) || (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0;
  const cost = result.total_cost_usd;

  if (!reachedProvider) {
    return {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      costUsd: null,
      costStatus: 'unavailable',
      costDetail: 'the turn made no provider call (duration_api_ms is 0 and no tokens were counted), so the reported total_cost_usd is not a measurement',
      durationMs: result.duration_ms ?? null,
      durationApiMs: apiMs,
    };
  }
  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    return {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      costUsd: null,
      costStatus: 'unavailable',
      costDetail: 'the result record reported no usable total_cost_usd',
      durationMs: result.duration_ms ?? null,
      durationApiMs: apiMs,
    };
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    costUsd: cost,
    costStatus: 'measured',
    costDetail: 'total_cost_usd reported by the runtime for a turn that reached the provider',
    durationMs: result.duration_ms ?? null,
    durationApiMs: apiMs,
  };
}
