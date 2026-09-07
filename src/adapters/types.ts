/**
 * RuntimeAdapter contract (plan section 6).
 *
 * The coordinator distinguishes the executable/process, the conversation
 * session, the turn and the application task attempt. Only one turn may be
 * active per session. Adapters normalize raw runtime output into
 * `RuntimeEvent`s and must never crash on unknown raw fields.
 */
import { z } from 'zod';
import { AdapterIdSchema, PolicySchema, type AdapterId, type Policy } from '../core/contracts.js';

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
}

export interface ResumeInput extends SessionInput {
  readonly sessionId: string;
}

export interface SessionHandle {
  readonly adapter: AdapterId;
  readonly sessionId: string;
  readonly processId?: number;
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
  /** Monotonic per session as observed by the adapter. */
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

export interface DeliveryReceipt {
  readonly messageId: string;
  readonly state: 'queued' | 'submitted_to_active_turn';
  readonly turnId: string | null;
  readonly at: string;
}

export interface InterruptionReceipt {
  readonly turnId: string;
  readonly state: 'requested' | 'observed';
  readonly at: string;
}

export interface StopReceipt {
  readonly sessionId: string;
  readonly state: 'requested' | 'process_tree_terminated' | 'unknown';
  readonly processId: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: string;
  readonly detail?: string;
}

export interface ObservedRuntimeState {
  readonly adapter: AdapterId;
  readonly sessionId: string;
  readonly processId: number | null;
  /** `unknown` when the adapter cannot observe the process (for example after a coordinator restart on another host). */
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
  /** Passive readiness probe: must not start a paid model turn or run repository hooks. */
  probe(executablePath: string): Promise<RuntimeReadiness>;
  capabilities(): RuntimeCapabilities;
  openSession(input: SessionInput): Promise<SessionHandle>;
  resumeSession(input: ResumeInput): Promise<SessionHandle>;
  startTurn(session: SessionHandle, input: TurnInput): Promise<TurnHandle>;
  events(turn: TurnHandle): AsyncIterable<RuntimeEvent>;
  deliver(session: SessionHandle, input: DeliveryInput): Promise<DeliveryReceipt>;
  interrupt(turn: TurnHandle): Promise<InterruptionReceipt>;
  stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt>;
  reconcile(session: SessionHandle): Promise<ObservedRuntimeState>;
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

/** True for the event kinds that end a turn's event stream. */
export function isTurnTerminalEvent(event: RuntimeEvent): boolean {
  return event.kind === 'turn_completed' || event.kind === 'turn_interrupted' || (event.kind === 'error' && event.payload['fatal'] === true);
}

export { PolicySchema };
