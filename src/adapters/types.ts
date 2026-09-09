/**
 * RuntimeAdapter contract (plan section 6).
 *
 * The coordinator distinguishes the executable/process, the conversation
 * session, the turn and the application task attempt. Only one turn may be
 * active per session. Adapters normalize raw runtime output into
 * `RuntimeEvent`s and must never crash on unknown raw fields.
 */
import { z } from 'zod';
import { AdapterIdSchema, PolicySchema, type AdapterId, type EffectiveAgentBinding, type Policy } from '../core/contracts.js';
import { type ProcessIdentity, type ProcessIdentityStatus } from '../core/process.js';

export type { ProcessIdentity, ProcessIdentityStatus };

// ---------------------------------------------------------------------------
// Readiness and capabilities (FR002, FR005)
// ---------------------------------------------------------------------------

export type CapabilityStatus = 'unsupported' | 'supported_unverified' | 'verified';

export const CAPABILITY_NAMES = [
  'structured_events',
  'session_identity',
  'resume_session',
  'interrupt_turn',
  'active_turn_delivery',
  'queued_delivery',
  'process_tree_stop',
  'write_containment',
  'model_selection',
  'effort_selection',
  'usage_reporting',
  'coordination_bridge',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export interface CapabilityReport {
  readonly status: CapabilityStatus;
  /** Executable version the status was established against; `null` when never tested. */
  readonly testedVersion: string | null;
  /** `process.platform` value the status was established on; `null` when never tested. */
  readonly os: NodeJS.Platform | null;
  readonly note?: string;
}

export interface RuntimeCapabilities {
  readonly adapter: AdapterId;
  readonly capabilities: Readonly<Record<CapabilityName, CapabilityReport>>;
  /** Model and effort values the adapter offers, with their provenance (FR006). */
  readonly settings: RuntimeSettingsSupport;
}

// ---------------------------------------------------------------------------
// Model / effort settings (FR006): offer only reported or configured values,
// validate requests, and preserve unknown effective values honestly.
// ---------------------------------------------------------------------------

export type SettingName = 'model' | 'effort';

/** `reported`: the runtime itself listed the value; `configured`: the adapter knows it from documentation or explicit configuration. */
export type SettingProvenance = 'reported' | 'configured';

export interface OfferedSetting {
  readonly value: string;
  readonly provenance: SettingProvenance;
  readonly note?: string;
}

export interface SettingSupport {
  readonly offered: ReadonlyArray<OfferedSetting>;
  /**
   * True when values outside `offered` are known to be rejected by the runtime.
   * False when the runtime accepts values the adapter cannot list (they are then
   * `supported_unverified`, never silently mapped).
   */
  readonly exhaustive: boolean;
}

export interface RuntimeSettingsSupport {
  readonly model: SettingSupport;
  readonly effort: SettingSupport;
}

export type SettingStatus = 'runtime_default' | 'supported' | 'supported_unverified' | 'unsupported';

export interface SettingReport {
  readonly setting: SettingName;
  /** The requested value; null when omitted (the runtime's own default applies and is reported after the fact). */
  readonly requested: string | null;
  readonly status: SettingStatus;
  readonly provenance: SettingProvenance | null;
  readonly offered: ReadonlyArray<string>;
  readonly message: string;
}

export interface RequestedSettings {
  readonly model?: string;
  readonly effort?: string;
}

export interface SettingsValidation {
  readonly adapter: AdapterId;
  /** False when any requested setting is `unsupported`; such a binding must not reach dispatch. */
  readonly ok: boolean;
  readonly model: SettingReport;
  readonly effort: SettingReport;
}

function reportSetting(setting: SettingName, support: SettingSupport, requested: string | undefined): SettingReport {
  const offered = support.offered.map((o) => o.value);
  if (requested === undefined) {
    return { setting, requested: null, status: 'runtime_default', provenance: null, offered, message: `${setting} not configured; the runtime's own default applies and is recorded from what the runtime reports` };
  }
  const match = support.offered.find((o) => o.value === requested);
  if (match !== undefined) {
    return { setting, requested, status: 'supported', provenance: match.provenance, offered, message: `${setting} "${requested}" is ${match.provenance}${match.note ? ` (${match.note})` : ''}` };
  }
  if (support.exhaustive) {
    return { setting, requested, status: 'unsupported', provenance: null, offered, message: `${setting} "${requested}" is not supported; offered: ${offered.length === 0 ? '(none)' : offered.map((o) => `"${o}"`).join(', ')}` };
  }
  return { setting, requested, status: 'supported_unverified', provenance: null, offered, message: `${setting} "${requested}" is not in the list the adapter can verify; it is passed through unchanged and the effective value is recorded from what the runtime reports` };
}

/** Validate requested settings against what an adapter offers. Adapters may use this to implement `validateSettings`. */
export function validateSettingsAgainst(adapter: AdapterId, support: RuntimeSettingsSupport, requested: RequestedSettings): SettingsValidation {
  const model = reportSetting('model', support.model, requested.model);
  const effort = reportSetting('effort', support.effort, requested.effort);
  return { adapter, ok: model.status !== 'unsupported' && effort.status !== 'unsupported', model, effort };
}

export type AuthenticationStatus = 'unknown' | 'logged_in' | 'logged_out' | 'not_required';
export type ReadyStatus = 'unknown' | 'not_ready' | 'verified_ready';

export interface RuntimeReadiness {
  readonly adapter: AdapterId;
  readonly executablePath: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly adapterSupported: boolean;
  readonly controllable: boolean;
  readonly authentication: AuthenticationStatus;
  /** Never `verified_ready` by assumption; only a live check can set it. */
  readonly ready: ReadyStatus;
  /** `passive` probes must not start a model turn or run repository hooks. */
  readonly probeKind: 'passive' | 'live';
  readonly diagnostics: ReadonlyArray<string>;
  readonly observedAt: string;
}

// ---------------------------------------------------------------------------
// Sessions and turns
// ---------------------------------------------------------------------------

export interface SessionInput {
  readonly cwd: string;
  /** Absolute paths the worker may write to; everything else is a policy violation. */
  readonly allowedWritePaths: ReadonlyArray<string>;
  readonly policy: Policy;
  readonly model?: string;
  readonly effort?: string;
  readonly systemInstructions: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra argv entries spliced into the runtime's own command line, used by the
   * coordinator to attach a session to the run's coordination bridge
   * (`--mcp-config` for Claude Code, `-c mcp_servers.*` for Codex).
   *
   * Additive and optional: an adapter that cannot take extra arguments ignores
   * it, and the coordinator then records the session as running without a
   * bridge rather than assuming one attached.
   */
  readonly extraArgs?: ReadonlyArray<string>;
}

export interface ResumeInput extends SessionInput {
  readonly sessionId: string;
  /**
   * Identity of the process that last drove this session, when the coordinator
   * recorded one. The adapter refuses to resume while that process is still
   * alive, so a resumed session never gets a second writer.
   */
  readonly previousProcess?: ProcessIdentity | null;
}

export interface SessionHandle {
  readonly adapter: AdapterId;
  readonly sessionId: string;
  /** Convenience copy of `process.pid`; never enough on its own to act on a process. */
  readonly processId?: number;
  /** Full process identity (pid, start time, spawn token); persist this so a restarted coordinator can verify before it signals. */
  readonly process?: ProcessIdentity | null;
  /** Adapter-private data needed to drive the session (never persisted verbatim). */
  readonly raw: unknown;
}

export interface TurnInput {
  readonly prompt: string;
  readonly contextRefs?: ReadonlyArray<string>;
}

export interface TurnHandle {
  readonly adapter: AdapterId;
  readonly sessionId: string;
  readonly turnId: string;
  readonly startedAt: string;
}

export interface DeliveryInput {
  readonly messageId: string;
  readonly body: string;
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Normalized events (FR058 foundation)
// ---------------------------------------------------------------------------

export const RUNTIME_EVENT_KINDS = [
  'session_started',
  'turn_started',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_change',
  'command_exec',
  'turn_completed',
  'turn_interrupted',
  'error',
  'raw',
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export const RuntimeEventSchema = z.strictObject({
  kind: z.enum(RUNTIME_EVENT_KINDS),
  adapter: AdapterIdSchema,
  sessionId: z.string().min(1),
  turnId: z.string().min(1).nullable(),
  /** Spawn token of the process instance that produced the event; a resumed session gets a new one, so sequences never collide across processes. */
  spawnToken: z.string().min(1),
  /** Monotonic per process instance (per spawn token) as observed by the adapter. */
  sequence: z.number().int().min(1),
  timestamp: z.string().datetime(),
  /** Normalized fields; unknown raw fields are preserved here rather than dropped. */
  payload: z.record(z.string(), z.unknown()),
  /** Reference to the raw runtime record this was derived from (for example `fake:<session>:<line>`). */
  rawRef: z.string().min(1),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

// ---------------------------------------------------------------------------
// Receipts (plan section 6: queued vs submitted, requested vs observed)
// ---------------------------------------------------------------------------

/**
 * Who is holding a delivered message, for a receipt that is not
 * `submitted_to_active_turn`.
 *
 * `adapter`: this adapter holds the message and will flush it into the next
 * turn it starts on this session. `runtime`: the runtime acknowledged the
 * message and holds it in its own queue; the adapter will not send it again.
 *
 * A `queued` receipt must always name one of the two. "Written to the runtime
 * but never acknowledged, and nobody holds it" is not a legal outcome: the
 * adapter either re-queues the message (`adapter`) or fails the delivery
 * (plan section 8: submission is at least once with idempotent ingestion).
 */
export type DeliveryHolder = 'adapter' | 'runtime';

export interface DeliveryReceipt {
  readonly messageId: string;
  readonly state: 'queued' | 'submitted_to_active_turn';
  readonly turnId: string | null;
  readonly at: string;
  /**
   * Which of the several ways of being `queued` happened, as a value rather
   * than as prose: a coordinator reading receipts from two adapters must not
   * have to parse `detail` to learn whether anyone will deliver the message.
   * `submitted_to_active_turn` always means `runtime`.
   */
  readonly holder?: DeliveryHolder;
  /**
   * Optional: what the adapter actually observed, in the adapter's own words.
   * `state` and `holder` stay the contract; this explains them.
   * `StopReceipt` already carries the same field.
   */
  readonly detail?: string;
}

export interface InterruptionReceipt {
  readonly turnId: string;
  readonly state: 'requested' | 'observed';
  readonly at: string;
  /** Optional: what the adapter observed, for example which terminal event made this `observed`. */
  readonly detail?: string;
}

export interface StopReceipt {
  readonly sessionId: string;
  readonly state: 'requested' | 'process_tree_terminated' | 'unknown';
  readonly processId: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: string;
  readonly detail?: string;
}

/**
 * Usage an adapter observed for the most recent completed turn (FR060).
 *
 * This is the *contract* shape, so the coordinator never has to duck-type one
 * adapter's private accessor: `costStatus` is `measured` only when the number
 * was actually reported for a turn that reached the provider, and
 * `unavailable` otherwise — never a zero standing in for "unknown" (AT14).
 */
export interface TurnUsageReport {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: 'measured' | 'unavailable';
  /** Why the numbers are what they are, in the adapter's own words. */
  readonly detail: string;
}

/**
 * What the *runtime itself* reported as in effect for a session, as opposed to
 * what the configuration requested (FR006: "preserve unknown effective values
 * honestly").
 *
 * Both installed runtimes echo the settings that actually took effect — Codex
 * in its `thread/start` response, Claude Code in the `system.init` record of
 * each turn — and both adapters already captured them. Until this contract
 * shape existed they captured them into adapter-shaped accessors the
 * coordinator could not read, so a manifest could only ever repeat the model
 * the *configuration* asked for. A requested value that the provider silently
 * substituted, or an unknown value the adapter passed through unvalidated
 * (`supported_unverified`), is exactly the case where the two differ.
 *
 * `effort` is optional because not every runtime reports one back: Claude Code
 * 2.1.260 accepts `--effort` but names no effort in its init record.
 */
export interface EffectiveRuntimeSettings {
  readonly model: string | null;
  readonly effort?: string | null;
}

export interface ObservedRuntimeState {
  readonly adapter: AdapterId;
  readonly sessionId: string;
  readonly processId: number | null;
  readonly process: ProcessIdentity | null;
  /** How the recorded identity compares with what is running now; null when no identity was available. */
  readonly processIdentityStatus: ProcessIdentityStatus | null;
  /** `unknown` when the adapter cannot verify the process (no recorded identity, or an identity it cannot compare). */
  readonly processAlive: boolean | 'unknown';
  readonly processGroupAlive: boolean | 'unknown';
  readonly activeTurnId: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lastEventSequence: number;
  readonly observedAt: string;
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
  readonly id: AdapterId;
  /**
   * Passive readiness probe: must not start a paid model turn or run
   * repository hooks.
   *
   * `{ live: true }` additionally asks the runtime itself — the control
   * handshake, not a model turn — which is the only check that may report
   * `verified_ready`. An adapter that has no live check may ignore it.
   */
  probe(executablePath: string, options?: { readonly live?: boolean }): Promise<RuntimeReadiness>;
  capabilities(): RuntimeCapabilities;
  /** Validate a model/effort request against offered values. `openSession` must refuse a binding this reports as not ok. */
  validateSettings(requested: RequestedSettings): SettingsValidation;
  openSession(input: SessionInput): Promise<SessionHandle>;
  resumeSession(input: ResumeInput): Promise<SessionHandle>;
  startTurn(session: SessionHandle, input: TurnInput): Promise<TurnHandle>;
  events(turn: TurnHandle): AsyncIterable<RuntimeEvent>;
  deliver(session: SessionHandle, input: DeliveryInput): Promise<DeliveryReceipt>;
  interrupt(turn: TurnHandle): Promise<InterruptionReceipt>;
  stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt>;
  reconcile(session: SessionHandle): Promise<ObservedRuntimeState>;
  /**
   * Usage the runtime reported for this session's last completed turn, in the
   * shared shape. Optional: an adapter whose runtime reports nothing omits it,
   * and the coordinator then records usage as unavailable. Implement this
   * rather than a private accessor — the coordinator reads only this method,
   * so an adapter-shaped one is invisible to the manifest.
   */
  lastTurnUsage?(session: SessionHandle): TurnUsageReport | null;
  /**
   * The settings the runtime reported for this session (FR006). Optional: an
   * adapter whose runtime echoes nothing back omits it, and the coordinator
   * then records the effective values as unreported rather than assuming the
   * requested ones took effect. Same rule as `lastTurnUsage`: the coordinator
   * reads only this method, so an adapter-shaped accessor stays invisible to
   * the manifest.
   */
  effectiveSettings?(session: SessionHandle): EffectiveRuntimeSettings | null;
}

export class AdapterError extends Error {
  readonly adapter: AdapterId;
  readonly code: string;

  constructor(adapter: AdapterId, code: string, message: string) {
    super(`${adapter}: ${message}`);
    this.name = 'AdapterError';
    this.adapter = adapter;
    this.code = code;
  }
}

/** Validate an effective binding's runtime settings with the adapter it is bound to, before any intent is recorded. */
export function validateBindingSettings(adapter: RuntimeAdapter, binding: EffectiveAgentBinding): SettingsValidation {
  if (binding.runtime.adapter !== adapter.id) {
    throw new AdapterError(adapter.id, 'adapter_mismatch', `binding for agent "${binding.agentId}" targets adapter "${binding.runtime.adapter}"`);
  }
  return adapter.validateSettings({
    ...(binding.runtime.model !== undefined ? { model: binding.runtime.model } : {}),
    ...(binding.runtime.effort !== undefined ? { effort: binding.runtime.effort } : {}),
  });
}

/** True for the event kinds that end a turn's event stream. */
export function isTurnTerminalEvent(event: RuntimeEvent): boolean {
  return event.kind === 'turn_completed' || event.kind === 'turn_interrupted' || (event.kind === 'error' && event.payload['fatal'] === true);
}

export { PolicySchema };
