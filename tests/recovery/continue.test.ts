/**
 * The handoff actually happening.
 *
 * The recovery library was previously reachable only from its own tests: no
 * run path classified a failure, selected a fallback runtime, built a packet
 * or applied one, so a task could never be continued on a second runtime
 * (AT04, AT14). These tests drive `runWithFallback`, which is the caller that
 * closes that gap, with the orchestrator itself stubbed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateAgentConfig } from '../../src/core/contracts.js';
import type { RunDirectInput, RunDirectResult } from '../../src/core/run-direct.js';
import { runWithFallback } from '../../src/recovery/continue.js';
import { listEvents } from '../../src/storage/events.js';
import { insertAttempt, upsertAgentSnapshot } from '../../src/storage/records.js';
import { computeAgentSnapshot } from '../../src/core/snapshot.js';
import { openTempState, seedRunAndTask, sampleContract } from '../helpers/state.js';
import { parseHandoffPacket } from '../../src/routing/handoff.js';

const CONFIG = validateAgentConfig(JSON.parse(readFileSync('fixtures/agents/example.json', 'utf8')));

function failedResult(runId: string, taskId: string, attemptId: string, overrides: Partial<RunDirectResult> = {}): RunDirectResult {
  const contract = sampleContract();
  return {
    runId,
    taskId,
    attemptId,
    outcome: 'failed',
    contract,
    runtime: { runtimeId: 'claude-local', adapter: 'claude-code' },
    failure: {
      failureClass: 'quota',
      retryable: false,
      signal: 'usage limit',
      detail: 'the provider reported the usage limit was reached',
      userAction: 'wait for the quota to reset or switch runtime',
    },
    taskState: 'failed',
    attemptState: 'failed',
    runState: 'failed',
    acceptance: { accepted: false, criteria: [], requiredTotal: 1, requiredPassed: 0, reasons: ['no evidence'] },
    receipts: [],
    snapshot: null,
    workspace: null,
    manifest: {
      manifestVersion: 1,
      runId,
      taskId,
      attemptId,
      outcome: 'failed',
      createdAt: new Date().toISOString(),
      request: { text: 'do the thing', source: 'test', contextRefs: [] },
      project: {},
      base: { revision: 'b'.repeat(40) },
      candidate: {},
      agent: { policy: 'local-development' },
      runtime: {},
      requirements: [],
      checks: [],
      acceptance: { accepted: false, requiredTotal: 1, requiredPassed: 0, reasons: [] },
      evidence: {},
      timing: { dispatchMs: 1, startupMs: 1, runtimeMs: 1, validationMs: 1, elapsedMs: 4 },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, source: 'unavailable' },
      unresolved: [],
      artifacts: [],
    } as unknown as RunDirectResult['manifest'],
    manifestPath: '/tmp/manifest.json',
    summaryPath: '/tmp/summary.md',
    patchPath: null,
    runDir: '/tmp/does-not-exist-run-dir',
    evidence: null,
    stopReceipt: null,
    coordination: { attached: false, socketPath: null, reason: 'test', messagesDelivered: 0, messagesRecorded: 0 },
    ...overrides,
  };
}

function inputFor(state: ReturnType<typeof openTempState>, runId: string): RunDirectInput {
  return {
    repoPath: '/repo',
    config: CONFIG,
    configRaw: JSON.stringify(CONFIG),
    configPath: 'fixtures/agents/example.json',
    requestText: 'do the thing',
    requestSource: 'test',
    agentId: 'engineer',
    paths: state.paths,
    db: state.store.db,
  } as unknown as RunDirectInput;
}

describe('continuing a task on a second runtime', () => {
  it('classifies, selects, hands off and runs a second attempt on the other runtime', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    const snapshot = computeAgentSnapshot(CONFIG, 'engineer');
    upsertAgentSnapshot(state.store.db, snapshot);
    const first = insertAttempt(state.store.db, { taskId: task.id, agentSnapshotHash: snapshot.hash });

    const calls: Array<{ agentId: string | undefined; briefing: string | undefined }> = [];
    const result = await runWithFallback(inputFor(state, run.id), {
      run: async (input) => {
        calls.push({ agentId: input.agentId, briefing: input.slot?.briefing });
        return calls.length === 1
          ? failedResult(run.id, task.id, first.id)
          : { ...failedResult(run.id, task.id, 'attempt-2'), outcome: 'accepted', acceptance: { accepted: true, criteria: [], requiredTotal: 1, requiredPassed: 1, reasons: [] } };
      },
    });

    // Two attempts, the second on an agent bound to the OTHER runtime.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.agentId).toBe('engineer');
    expect(calls[1]?.agentId).not.toBe('engineer');
    expect(CONFIG.agents.find((agent) => agent.id === calls[1]?.agentId)?.runtime).toBe('codex-local');

    // The second attempt was briefed from the packet, not from thin air.
    expect(calls[1]?.briefing).toContain('continuing work another worker started');
    expect(result.packet).not.toBeNull();
    expect(() => parseHandoffPacket(result.packet)).not.toThrow();
    expect(result.result.acceptance.accepted).toBe(true);

    // The handoff is on the record, naming both sides.
    expect(result.fallback?.fromRuntimeId).toBe('claude-local');
    expect(result.fallback?.toRuntimeId).toBe('codex-local');
    const events = listEvents(state.store.db, run.id).map((event) => event.type);
    expect(events).toContain('runtime.fallback_selected');

    // The second attempt is a new generation, so it cannot collide with the
    // first on UNIQUE(task_id, generation), and the first is superseded.
    const taskRow = state.store.db.prepare('SELECT current_generation FROM tasks WHERE id = ?').get(task.id) as { current_generation: number };
    expect(taskRow.current_generation).toBe(2);
    const firstRow = state.store.db.prepare('SELECT state FROM attempts WHERE id = ?').get(first.id) as { state: string };
    expect(firstRow.state).toBe('superseded');
    state.store.close();
  });

  it('does not hand off a failure a second runtime would hit in the same way', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    let calls = 0;
    const result = await runWithFallback(inputFor(state, run.id), {
      run: async () => {
        calls += 1;
        return failedResult(run.id, task.id, 'attempt-1', {
          failure: { failureClass: 'code_failure', retryable: false, signal: 'check exit 1', detail: 'the tests failed', userAction: null },
        });
      },
    });
    expect(calls).toBe(1);
    expect(result.fallback).toBeNull();
    expect(result.note).toContain('code_failure');
    state.store.close();
  });

  it('runs one attempt and hands nothing off when the first one is accepted', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    let calls = 0;
    const result = await runWithFallback(inputFor(state, run.id), {
      run: async () => {
        calls += 1;
        return { ...failedResult(run.id, task.id, 'attempt-1'), outcome: 'accepted', failure: null, acceptance: { accepted: true, criteria: [], requiredTotal: 1, requiredPassed: 1, reasons: [] } };
      },
    });
    expect(calls).toBe(1);
    expect(result.fallback).toBeNull();
    state.store.close();
  });
});
