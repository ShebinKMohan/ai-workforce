/**
 * Continuing a task on a second runtime (AT04, AT14).
 *
 * This is the caller that makes the recovery library reachable from a real
 * run. When an attempt stops for a reason no repair can fix — an expired
 * credential, an exhausted quota, a provider that fell over mid-turn — the
 * work already done is not lost and not silently abandoned:
 *
 *   1. `classifyFailure` says what kind of failure it was (runDirect records
 *      the classification on its result);
 *   2. `selectFallbackRuntime` picks the replacement, or refuses with a
 *      reason and the action the user has to take;
 *   3. a handoff packet is built from the FIRST attempt's own evidence — its
 *      contract, its patch reference, its executed checks — validated by the
 *      packet contract, and written beside the run's other evidence;
 *   4. `applyHandoffPacket` renders the runtime-neutral continuation brief,
 *      which becomes the second attempt's briefing;
 *   5. `recordFallback` writes the `runtime.fallback_selected` event naming
 *      both sides.
 *
 * The second attempt is a NEW generation of the SAME task, so it goes through
 * the same verifier and the same acceptance decision. A handoff never carries
 * acceptance with it: it carries work.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../core/contracts.js';
import { newId } from '../core/ids.js';
import { runDirect, type RunDirectInput, type RunDirectResult } from '../core/run-direct.js';
import { beginNewGeneration } from '../storage/records.js';
import {
  applyHandoffPacket,
  buildHandoffPacket,
  serializeHandoffPacket,
  type HandoffPacket,
} from '../routing/handoff.js';
import type { FailureClass } from './classify.js';
import { recordFallback, selectFallbackRuntime, type FallbackEvidence, type RuntimeCandidate } from './fallback.js';

/** Failure classes a second runtime could plausibly get past. */
export const HANDOFF_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>(['authentication', 'quota', 'provider_transient']);

export interface RunWithFallbackResult {
  /** The attempt whose result stands: the fallback's when one ran, otherwise the first. */
  readonly result: RunDirectResult;
  /** Every attempt in order, the handoff target last. */
  readonly attempts: ReadonlyArray<RunDirectResult>;
  readonly fallback: FallbackEvidence | null;
  readonly packet: HandoffPacket | null;
  readonly packetPath: string | null;
  /** Why no handoff happened, when none did. Null when one did. */
  readonly note: string | null;
}

export interface RunWithFallbackOptions {
  /** False to run exactly one attempt (the default is to hand off when it is warranted). */
  readonly enabled?: boolean;
  /** Injection seam for tests; defaults to the real orchestrator. */
  readonly run?: (input: RunDirectInput) => Promise<RunDirectResult>;
}

/**
 * Run a task, and continue it on a second runtime when the first stopped for
 * a reason a second one could get past.
 */
export async function runWithFallback(input: RunDirectInput, options: RunWithFallbackOptions = {}): Promise<RunWithFallbackResult> {
  const run = options.run ?? runDirect;
  const first = await run(input);
  const attempts: RunDirectResult[] = [first];

  if (options.enabled === false) return { result: first, attempts, fallback: null, packet: null, packetPath: null, note: 'handoff disabled for this run' };
  if (first.acceptance.accepted) return { result: first, attempts, fallback: null, packet: null, packetPath: null, note: null };
  if (first.outcome === 'interrupted') return { result: first, attempts, fallback: null, packet: null, packetPath: null, note: 'the run was interrupted; an interruption is not handed to another runtime' };

  const classification = first.failure;
  if (classification === null || !HANDOFF_FAILURE_CLASSES.has(classification.failureClass)) {
    return {
      result: first,
      attempts,
      fallback: null,
      packet: null,
      packetPath: null,
      note: `the failure classified as "${classification?.failureClass ?? 'unclassified'}", which another runtime would hit in the same way; nothing was handed off`,
    };
  }

  const policy = policyOf(input, first);
  const selection = selectFallbackRuntime({
    candidates: candidatesFrom(input, first.runtime.runtimeId),
    policy,
    exclude: [first.runtime.runtimeId],
    ...(input.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
  });

  const packet = selection.selected === null ? null : packetFor(input, first, selection.selected, classification.failureClass);
  let packetPath: string | null = null;
  if (packet !== null) {
    packetPath = path.join(first.runDir, 'handoff', `${first.attemptId}.json`);
    try {
      writeFileSync(packetPath, serializeHandoffPacket(packet), { mode: 0o600 });
    } catch {
      // The packet is carried in memory either way; failing to persist it is
      // not a reason to abandon the work.
      packetPath = null;
    }
  }

  const evidence = recordFallback(input.db, {
    runId: first.runId,
    taskId: first.taskId,
    attemptId: first.attemptId,
    fromRuntimeId: first.runtime.runtimeId,
    fromAdapter: first.runtime.adapter,
    selection,
    classification,
  });

  if (selection.selected === null || packet === null) {
    return {
      result: first,
      attempts,
      fallback: evidence,
      packet: null,
      packetPath: null,
      note: `no fallback runtime was eligible: ${selection.reason}${selection.userAction === null ? '' : ` — ${selection.userAction}`}`,
    };
  }

  const agent = agentFor(input, selection.selected.runtimeId);
  if (agent === null) {
    return { result: first, attempts, fallback: evidence, packet, packetPath, note: `no agent in the configuration is bound to runtime "${selection.selected.runtimeId}"` };
  }

  const brief = applyHandoffPacket(packet, {
    runtimeEnforcesWrites: selection.selected.writeContainment === 'verified',
  });

  // A new generation of the same task: the first attempt is superseded, so the
  // second is not a second attempt at the same generation.
  beginNewGeneration(input.db, first.taskId);

  const second = await run({
    ...input,
    agentId: agent.id,
    slot: {
      runId: first.runId,
      taskId: first.taskId,
      attemptId: newId(),
      objective: first.contract.objective,
      briefing: brief.prompt,
    },
  });
  attempts.push(second);
  return { result: second, attempts, fallback: evidence, packet, packetPath, note: null };
}

function policyOf(input: RunDirectInput, first: RunDirectResult): AgentDefinition['policy'] {
  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  const agent = input.config.agents.find((candidate) => candidate.id === agentId);
  return agent?.policy ?? (first.manifest.agent['policy'] as AgentDefinition['policy'] | undefined) ?? 'analysis';
}

/** Every runtime the configuration defines, as fallback candidates. */
function candidatesFrom(input: RunDirectInput, failedRuntimeId: string): ReadonlyArray<RuntimeCandidate> {
  return Object.entries(input.config.runtimes).map(([runtimeId, runtime]): RuntimeCandidate => {
    const agent = input.config.agents.find((candidate) => candidate.runtime === runtimeId);
    return {
      runtimeId,
      adapter: runtime.adapter,
      adapterSupported: runtime.adapter === 'codex' || runtime.adapter === 'claude-code' || runtime.adapter === 'fake',
      // The configuration alone does not establish readiness. `workforce
      // doctor` is what verifies a runtime, so an unverified one is offered as
      // a candidate and refused by the selector's own gates when it must be.
      ready: 'verified_ready',
      writeContainment: runtime.adapter === 'codex' || runtime.adapter === 'fake' ? ('verified' as const) : ('unsupported' as const),
      ...(agent?.model !== undefined ? { model: agent.model } : {}),
      ...(agent?.effort !== undefined ? { effort: agent.effort } : {}),
      ...(runtimeId === failedRuntimeId ? { note: 'this is the runtime whose attempt failed' } : {}),
      ...(agent === undefined ? { note: `no agent in the configuration is bound to runtime "${runtimeId}"` } : {}),
    };
  });
}

function agentFor(input: RunDirectInput, runtimeId: string): AgentDefinition | null {
  return input.config.agents.find((agent) => agent.runtime === runtimeId) ?? null;
}

function packetFor(input: RunDirectInput, first: RunDirectResult, to: RuntimeCandidate, failureClass: FailureClass): HandoffPacket | null {
  const snapshot = first.snapshot;
  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  const agent = input.config.agents.find((candidate) => candidate.id === agentId);
  const baseRevision = snapshot?.baseRevision ?? (first.manifest.base['revision'] as string | undefined) ?? null;
  if (baseRevision === null) return null;

  try {
    return buildHandoffPacket({
      packetVersion: 1,
      createdAt: new Date().toISOString(),
      runId: first.runId,
      taskId: first.taskId,
      originalRequest: { text: input.requestText, contextRefs: [...(input.contextRefs ?? [])] },
      contract: first.contract,
      contractVersion: first.contract.contractVersion,
      revisions: { repoPath: input.repoPath, base: baseRevision, candidate: snapshot?.candidateRevision ?? null },
      patch:
        snapshot === null || !snapshot.checkpointCreated || first.patchPath === null
          ? { format: 'none', hash: null, ref: null }
          : { format: 'git-diff', hash: snapshot.patchHash, ref: first.patchPath, bytes: snapshot.patchBytes },
      checks: first.receipts
        .filter((receipt) => receipt.evidenceProvenance === 'verifier_executed')
        .map((receipt) => ({
          criterionId: receipt.criterionId,
          command: receipt.command,
          args: [...receipt.args],
          outcome: receipt.outcome,
          required: receipt.required,
          exitCode: receipt.exitCode,
          startedAt: receipt.startedAt,
          endedAt: receipt.endedAt,
          durationMs: receipt.durationMs,
          evidenceProvenance: 'verifier_executed' as const,
        })),
      remainingWork: first.acceptance.criteria
        .filter((criterion) => criterion.status !== 'passed')
        .map((criterion) => ({
          id: `criterion:${criterion.criterionId}`,
          description: `criterion "${criterion.criterionId}" is not established: ${criterion.detail}`,
          acceptanceCriterionId: first.contract.acceptanceCriteria.some((entry) => entry.id === criterion.criterionId) ? criterion.criterionId : undefined,
        })),
      findings: [
        {
          id: `handoff:${first.attemptId}`,
          severity: 'info' as const,
          summary: `the previous attempt stopped with a ${failureClass} failure on runtime "${first.runtime.runtimeId}" (${first.runtime.adapter}); it is being continued on "${to.runtimeId}" (${to.adapter})`,
          sources: [{ kind: 'request' as const, ref: `attempt:${first.attemptId}` }],
        },
      ],
      scopeLimits: {
        policy: agent?.policy ?? 'analysis',
        allowedPaths: [...first.contract.scope.allowedPaths],
        forbiddenPaths: [...first.contract.scope.forbiddenPaths],
        notes: [],
      },
      producedBy: {
        ...(agent !== undefined ? { agentId: agent.id } : {}),
        adapterId: first.runtime.adapter as 'codex' | 'claude-code' | 'fake',
        attemptNumber: 1,
      },
    });
  } catch {
    // A packet that does not validate is not sent. The refusal is honest: the
    // caller reports that no handoff happened rather than handing a peer a
    // packet whose contract it cannot rely on.
    return null;
  }
}
