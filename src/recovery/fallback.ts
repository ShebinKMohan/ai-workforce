/**
 * Configured runtime fallback (FR055).
 *
 * Fallback is a *configured* move, never an improvisation. A replacement
 * runtime is eligible only when it is
 *
 *   - configured for this project (it is in the candidate list the caller
 *     built from the agent configuration — never discovered ad hoc),
 *   - supported by an adapter in this build,
 *   - actually ready (`verified_ready` — a login-status guess is not ready),
 *   - permitted by the policy the task runs under (a writing profile needs a
 *     runtime that contains writes, unless the user acknowledged the missing
 *     boundary for this run),
 *   - and not the runtime that just failed.
 *
 * Nothing is ever silently substituted: every refusal is named, the selection
 * carries a handoff packet describing the work already done, and the actual
 * replacement is recorded in evidence.
 */
import type { DatabaseSync } from 'node:sqlite';
import { POLICY_PROFILES, type Policy } from '../core/contracts.js';
import { nowIso } from '../core/ids.js';
import type { CapabilityStatus, TurnUsageReport } from '../adapters/types.js';
import { appendEvent } from '../storage/events.js';
import type { FailureClassification } from './classify.js';

export interface RuntimeCandidate {
  readonly runtimeId: string;
  readonly adapter: string;
  /** False when this build has no adapter for it. */
  readonly adapterSupported: boolean;
  /** Only `verified_ready` is ready; `unknown` and `not_ready` are not. */
  readonly ready: 'unknown' | 'not_ready' | 'verified_ready';
  /** The runtime's `write_containment` capability status, when known. */
  readonly writeContainment?: CapabilityStatus;
  readonly model?: string | null;
  readonly effort?: string | null;
  /** Reason this candidate is excluded regardless of the checks above (for example: it is the one that just failed). */
  readonly note?: string;
}

export interface RefusedCandidate {
  readonly runtimeId: string;
  readonly reason: string;
}

export interface FallbackSelection {
  readonly selected: RuntimeCandidate | null;
  readonly refused: ReadonlyArray<RefusedCandidate>;
  readonly reason: string;
  /** What the user must do when nothing is eligible. */
  readonly userAction: string | null;
}

export interface SelectFallbackInput {
  readonly candidates: ReadonlyArray<RuntimeCandidate>;
  readonly policy: Policy;
  /** Runtime ids that must not be selected (the failed one, and any already tried). */
  readonly exclude?: ReadonlyArray<string>;
  /** True when the user accepted running a writing profile without runtime write containment for this run. */
  readonly allowUnconfinedWrites?: boolean;
}

/**
 * Pick the replacement runtime, or none. Deterministic: the first candidate
 * that passes every gate, in the order the configuration listed them.
 */
export function selectFallbackRuntime(input: SelectFallbackInput): FallbackSelection {
  const exclude = new Set(input.exclude ?? []);
  const writes = POLICY_PROFILES[input.policy].writeCandidate;
  const refused: RefusedCandidate[] = [];

  for (const candidate of input.candidates) {
    if (exclude.has(candidate.runtimeId)) {
      refused.push({ runtimeId: candidate.runtimeId, reason: candidate.note ?? 'excluded: it is the runtime the work was handed off from, or one already tried' });
      continue;
    }
    if (!candidate.adapterSupported) {
      refused.push({ runtimeId: candidate.runtimeId, reason: `no adapter in this build drives "${candidate.adapter}"` });
      continue;
    }
    if (candidate.ready !== 'verified_ready') {
      refused.push({ runtimeId: candidate.runtimeId, reason: `readiness is "${candidate.ready}"; only a verified_ready runtime may take over work` });
      continue;
    }
    if (writes && candidate.writeContainment !== 'verified' && input.allowUnconfinedWrites !== true) {
      refused.push({
        runtimeId: candidate.runtimeId,
        reason: `the "${input.policy}" profile writes, and ${candidate.adapter} reports write_containment "${candidate.writeContainment ?? 'unknown'}"; re-run with --allow-unconfined-writes to accept that deliberately`,
      });
      continue;
    }
    return {
      selected: candidate,
      refused,
      reason: `${candidate.runtimeId} (${candidate.adapter}) is configured, verified ready and permitted by the "${input.policy}" profile`,
      userAction: null,
    };
  }

  return {
    selected: null,
    refused,
    reason: input.candidates.length === 0 ? 'no fallback runtime is configured for this project' : 'no configured runtime is eligible to take over',
    userAction:
      input.candidates.length === 0
        ? 'configure a second runtime in the agent configuration if you want automatic fallback; nothing is substituted without configuration'
        : `make one of the configured runtimes ready (see "workforce doctor --connect"): ${refused.map((r) => `${r.runtimeId} — ${r.reason}`).join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// Handoff packet
// ---------------------------------------------------------------------------

/**
 * What the replacement runtime is told about the work it is taking over.
 * It carries facts, never the failed runtime's opinions: the objective, the
 * boundaries, what was actually produced and why the previous runtime stopped.
 */
export interface HandoffPacket {
  readonly handoffVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly fromAttemptId: string;
  readonly fromRuntimeId: string | null;
  readonly fromAdapter: string | null;
  readonly toRuntimeId: string;
  readonly toAdapter: string;
  readonly generation: number;
  readonly baseRevision: string | null;
  /** The candidate revision the previous attempt reached, when it produced one. */
  readonly candidateRevision: string | null;
  readonly workspacePath: string | null;
  /** Artifacts and check receipts already recorded; the replacement must not redo them. */
  readonly preservedArtifactIds: ReadonlyArray<string>;
  readonly completedWork: ReadonlyArray<string>;
  readonly failureClass: FailureClassification['failureClass'];
  readonly failureDetail: string;
  readonly usage: UsageEvidence;
  readonly createdAt: string;
}

export interface BuildHandoffInput {
  readonly runId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly fromAttemptId: string;
  readonly fromRuntimeId?: string | null;
  readonly fromAdapter?: string | null;
  readonly to: RuntimeCandidate;
  readonly generation: number;
  readonly baseRevision?: string | null;
  readonly candidateRevision?: string | null;
  readonly workspacePath?: string | null;
  readonly preservedArtifactIds?: ReadonlyArray<string>;
  readonly completedWork?: ReadonlyArray<string>;
  readonly classification: FailureClassification;
  readonly usage?: TurnUsageReport | null;
  readonly now?: string;
}

export function buildHandoffPacket(input: BuildHandoffInput): HandoffPacket {
  return {
    handoffVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    objective: input.objective,
    fromAttemptId: input.fromAttemptId,
    fromRuntimeId: input.fromRuntimeId ?? null,
    fromAdapter: input.fromAdapter ?? null,
    toRuntimeId: input.to.runtimeId,
    toAdapter: input.to.adapter,
    generation: input.generation,
    baseRevision: input.baseRevision ?? null,
    candidateRevision: input.candidateRevision ?? null,
    workspacePath: input.workspacePath ?? null,
    preservedArtifactIds: input.preservedArtifactIds ?? [],
    completedWork: input.completedWork ?? [],
    failureClass: input.classification.failureClass,
    failureDetail: input.classification.detail,
    usage: usageEvidence(input.usage ?? null),
    createdAt: input.now ?? nowIso(),
  };
}

/** Render the packet as the prose a replacement worker is given. */
export function renderHandoffPrompt(packet: HandoffPacket): string {
  const lines = [
    `You are taking over work started by another runtime (${packet.fromAdapter ?? 'unknown adapter'} via ${packet.fromRuntimeId ?? 'unknown runtime'}).`,
    `Objective: ${packet.objective}`,
    `The previous attempt stopped with a ${packet.failureClass} failure: ${packet.failureDetail}`,
  ];
  if (packet.candidateRevision !== null) lines.push(`Its work is preserved at candidate revision ${packet.candidateRevision}; build on it rather than starting over.`);
  else lines.push('It produced no recorded candidate revision; start from the base revision.');
  if (packet.completedWork.length > 0) {
    lines.push('Already done (do not redo):');
    for (const item of packet.completedWork) lines.push(`  - ${item}`);
  }
  lines.push('Acceptance is decided by the verifier running the configured checks, not by you reporting completion.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Usage evidence: never a zero standing in for "unknown" (AT14)
// ---------------------------------------------------------------------------

export interface UsageEvidence {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costStatus: 'measured' | 'unavailable';
  readonly detail: string;
}

/**
 * Normalize what an adapter reported. A missing report, or a report whose
 * `costStatus` is not `measured`, yields `costUsd: null` — reporting 0 for an
 * unknown cost would state a fact nobody measured.
 */
export function usageEvidence(report: TurnUsageReport | null | undefined): UsageEvidence {
  if (report === null || report === undefined) {
    return { inputTokens: null, outputTokens: null, costUsd: null, costStatus: 'unavailable', detail: 'the runtime reported no usage for this turn' };
  }
  if (report.costStatus !== 'measured' || typeof report.costUsd !== 'number' || !Number.isFinite(report.costUsd)) {
    return {
      inputTokens: report.inputTokens ?? null,
      outputTokens: report.outputTokens ?? null,
      costUsd: null,
      costStatus: 'unavailable',
      detail: report.detail || 'the runtime did not report a measured cost',
    };
  }
  return {
    inputTokens: report.inputTokens ?? null,
    outputTokens: report.outputTokens ?? null,
    costUsd: report.costUsd,
    costStatus: 'measured',
    detail: report.detail,
  };
}

// ---------------------------------------------------------------------------
// Recording the actual replacement
// ---------------------------------------------------------------------------

export interface FallbackEvidence {
  readonly runId: string;
  readonly taskId: string;
  readonly fromRuntimeId: string | null;
  readonly fromAdapter: string | null;
  readonly toRuntimeId: string | null;
  readonly toAdapter: string | null;
  readonly attempted: boolean;
  readonly failureClass: FailureClassification['failureClass'];
  readonly reason: string;
  readonly refused: ReadonlyArray<RefusedCandidate>;
  readonly handoff: HandoffPacket | null;
  readonly recordedAt: string;
}

export interface RecordFallbackInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId?: string | null;
  readonly fromRuntimeId?: string | null;
  readonly fromAdapter?: string | null;
  readonly selection: FallbackSelection;
  readonly classification: FailureClassification;
  readonly handoff?: HandoffPacket | null;
  readonly now?: string;
}

/**
 * Record what actually happened: which runtime took over, or that none did and
 * why. The event names both sides, so evidence never shows work continuing
 * under a runtime nobody can account for.
 */
export function recordFallback(db: DatabaseSync, input: RecordFallbackInput): FallbackEvidence {
  const now = input.now ?? nowIso();
  const selected = input.selection.selected;
  const evidence: FallbackEvidence = {
    runId: input.runId,
    taskId: input.taskId,
    fromRuntimeId: input.fromRuntimeId ?? null,
    fromAdapter: input.fromAdapter ?? null,
    toRuntimeId: selected?.runtimeId ?? null,
    toAdapter: selected?.adapter ?? null,
    attempted: selected !== null,
    failureClass: input.classification.failureClass,
    reason: input.selection.reason,
    refused: input.selection.refused,
    handoff: input.handoff ?? null,
    recordedAt: now,
  };
  appendEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId ?? null,
    type: selected === null ? 'runtime.fallback_unavailable' : 'runtime.fallback_selected',
    payload: {
      fromRuntimeId: evidence.fromRuntimeId,
      fromAdapter: evidence.fromAdapter,
      toRuntimeId: evidence.toRuntimeId,
      toAdapter: evidence.toAdapter,
      failureClass: evidence.failureClass,
      reason: evidence.reason,
      refused: evidence.refused.map((r) => `${r.runtimeId}: ${r.reason}`),
      handoffCandidateRevision: evidence.handoff?.candidateRevision ?? null,
      usageCostStatus: evidence.handoff?.usage.costStatus ?? null,
    },
    timestamp: now,
  });
  return evidence;
}

/** One line naming the replacement, for the human report. */
export function describeFallback(evidence: FallbackEvidence): string {
  if (!evidence.attempted) {
    return `no runtime fallback: ${evidence.reason}${evidence.refused.length === 0 ? '' : ` (${evidence.refused.map((r) => `${r.runtimeId} — ${r.reason}`).join('; ')})`}`;
  }
  return `runtime fallback: ${evidence.fromRuntimeId ?? 'unknown'} (${evidence.fromAdapter ?? 'unknown'}) -> ${evidence.toRuntimeId} (${evidence.toAdapter}) after a ${evidence.failureClass} failure`;
}
