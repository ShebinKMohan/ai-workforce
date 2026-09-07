import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TurnUsageReport } from '../../src/adapters/types.js';
import { listEvents } from '../../src/storage/events.js';
import { classifyFailure } from '../../src/recovery/classify.js';
import {
  buildHandoffPacket,
  describeFallback,
  recordFallback,
  renderHandoffPrompt,
  selectFallbackRuntime,
  usageEvidence,
  type RuntimeCandidate,
} from '../../src/recovery/fallback.js';
import { openTempState, seedCrashedRun, type TempState } from './support.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

const codex: RuntimeCandidate = { runtimeId: 'codex-local', adapter: 'codex', adapterSupported: true, ready: 'verified_ready', writeContainment: 'verified' };
const claude: RuntimeCandidate = { runtimeId: 'claude-local', adapter: 'claude-code', adapterSupported: true, ready: 'verified_ready', writeContainment: 'unsupported' };
const unready: RuntimeCandidate = { runtimeId: 'codex-spare', adapter: 'codex', adapterSupported: true, ready: 'unknown', writeContainment: 'verified' };
const unsupported: RuntimeCandidate = { runtimeId: 'aider', adapter: 'aider', adapterSupported: false, ready: 'verified_ready' };

describe('FR055: configured runtime fallback', () => {
  it('reassigns only to a runtime that is supported, ready and permitted by the policy', () => {
    const selection = selectFallbackRuntime({ candidates: [unsupported, unready, claude, codex], policy: 'local-development', exclude: ['codex-old'] });
    expect(selection.selected?.runtimeId).toBe('codex-local');
    expect(selection.refused.map((r) => r.runtimeId)).toEqual(['aider', 'codex-spare', 'claude-local']);
    expect(selection.refused[0]?.reason).toMatch(/no adapter/);
    expect(selection.refused[1]?.reason).toMatch(/verified_ready/);
    expect(selection.refused[2]?.reason).toMatch(/write_containment/);
  });

  it('never silently substitutes: with nothing eligible it selects none and names the account action', () => {
    const selection = selectFallbackRuntime({ candidates: [claude, unready], policy: 'local-development' });
    expect(selection.selected).toBeNull();
    expect(selection.userAction).toMatch(/doctor --connect/);
    expect(describeFallback(recordFallback(state.store.db, fallbackInput(selection)))).toMatch(/^no runtime fallback/);
  });

  it('refuses the runtime the work came from even when it is otherwise eligible', () => {
    const selection = selectFallbackRuntime({ candidates: [codex], policy: 'local-development', exclude: ['codex-local'] });
    expect(selection.selected).toBeNull();
    expect(selection.refused[0]?.reason).toMatch(/handed off from/);
  });

  it('allows a runtime without write containment only when the user acknowledged it', () => {
    const refused = selectFallbackRuntime({ candidates: [claude], policy: 'local-development' });
    expect(refused.selected).toBeNull();
    const allowed = selectFallbackRuntime({ candidates: [claude], policy: 'local-development', allowUnconfinedWrites: true });
    expect(allowed.selected?.runtimeId).toBe('claude-local');
    // A read-only profile never needs the boundary in the first place.
    expect(selectFallbackRuntime({ candidates: [claude], policy: 'analysis' }).selected?.runtimeId).toBe('claude-local');
  });

  it('carries the handoff packet and records the actual replacement in evidence', () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true });
    const classification = classifyFailure({ adapter: 'codex', errorTag: 'usageLimitExceeded' });
    const selection = selectFallbackRuntime({ candidates: [codex, claude], policy: 'local-development', exclude: ['codex-local'], allowUnconfinedWrites: true });
    expect(selection.selected?.runtimeId).toBe('claude-local');

    const handoff = buildHandoffPacket({
      runId: crashed.run.id,
      taskId: crashed.task.id,
      objective: crashed.task.objective,
      fromAttemptId: crashed.attempt.id,
      fromRuntimeId: 'codex-local',
      fromAdapter: 'codex',
      to: selection.selected!,
      generation: 2,
      baseRevision: 'base123',
      candidateRevision: 'cand456',
      workspacePath: '/tmp/candidate',
      preservedArtifactIds: ['artifact-1'],
      completedWork: ['wrote src/login.ts', 'npm test recorded as failing'],
      classification,
      usage: null,
    });
    expect(handoff.candidateRevision).toBe('cand456');
    expect(handoff.preservedArtifactIds).toEqual(['artifact-1']);
    const prompt = renderHandoffPrompt(handoff);
    expect(prompt).toMatch(/cand456/);
    expect(prompt).toMatch(/do not redo/i);
    expect(prompt).toMatch(/verifier/);

    const evidence = recordFallback(state.store.db, {
      runId: crashed.run.id,
      taskId: crashed.task.id,
      attemptId: crashed.attempt.id,
      fromRuntimeId: 'codex-local',
      fromAdapter: 'codex',
      selection,
      classification,
      handoff,
    });
    expect(evidence.toRuntimeId).toBe('claude-local');
    expect(describeFallback(evidence)).toMatch(/codex-local \(codex\) -> claude-local \(claude-code\)/);

    const event = listEvents(state.store.db, crashed.run.id).find((e) => e.type === 'runtime.fallback_selected');
    expect(event?.payload['toRuntimeId']).toBe('claude-local');
    expect(event?.payload['fromRuntimeId']).toBe('codex-local');
    expect(event?.payload['failureClass']).toBe('quota');
  });

  function fallbackInput(selection: ReturnType<typeof selectFallbackRuntime>) {
    const crashed = seedCrashedRun(state, { dispatched: false });
    return {
      runId: crashed.run.id,
      taskId: crashed.task.id,
      fromRuntimeId: 'codex-local',
      fromAdapter: 'codex',
      selection,
      classification: classifyFailure({ httpStatus: 401 }),
    };
  }
});

describe('FR060/AT14: cost is never reported as zero when it is unavailable', () => {
  it('reports null and unavailable when the adapter reported nothing', () => {
    expect(usageEvidence(null)).toMatchObject({ costUsd: null, costStatus: 'unavailable' });
    expect(usageEvidence(undefined)).toMatchObject({ costUsd: null, costStatus: 'unavailable' });
  });

  it('does not turn an unavailable cost into 0 even when the adapter sent a number', () => {
    const report: TurnUsageReport = { inputTokens: 120, outputTokens: 40, costUsd: 0, costStatus: 'unavailable', detail: 'this runtime reports no cost' };
    const evidence = usageEvidence(report);
    expect(evidence.costUsd).toBeNull();
    expect(evidence.costStatus).toBe('unavailable');
    expect(evidence.inputTokens).toBe(120);
    expect(evidence.detail).toMatch(/no cost/);
  });

  it('keeps a measured cost, including a genuine zero', () => {
    const report: TurnUsageReport = { inputTokens: 10, outputTokens: 2, costUsd: 0, costStatus: 'measured', detail: 'free tier turn' };
    expect(usageEvidence(report)).toMatchObject({ costUsd: 0, costStatus: 'measured' });
    const paid: TurnUsageReport = { inputTokens: 10, outputTokens: 2, costUsd: 0.42, costStatus: 'measured', detail: 'reported by the runtime' };
    expect(usageEvidence(paid).costUsd).toBe(0.42);
  });

  it('a handoff packet carries the unavailable cost honestly', () => {
    const packet = buildHandoffPacket({
      runId: 'r1',
      taskId: 't1',
      objective: 'fix it',
      fromAttemptId: 'a1',
      to: codex,
      generation: 2,
      classification: classifyFailure({ code: 'ECONNRESET' }),
      usage: null,
    });
    expect(packet.usage.costUsd).toBeNull();
    expect(packet.usage.costStatus).toBe('unavailable');
  });
});
