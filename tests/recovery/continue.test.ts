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
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAgentConfig } from '../../src/core/contracts.js';
import { createAdapter, type RunDirectInput, type RunDirectResult } from '../../src/core/run-direct.js';
import { runWithFallback } from '../../src/recovery/continue.js';
import type { CapabilityStatus, RuntimeAdapter, RuntimeReadiness } from '../../src/adapters/types.js';
import { listEvents } from '../../src/storage/events.js';
import { insertAttempt, upsertAgentSnapshot } from '../../src/storage/records.js';
import { computeAgentSnapshot } from '../../src/core/snapshot.js';
import { openTempState, seedRunAndTask, sampleContract } from '../helpers/state.js';
import { parseHandoffPacket } from '../../src/routing/handoff.js';
import { Scheduler } from '../../src/routing/schedule.js';

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

/**
 * A runtime that answers a readiness probe without a process.
 *
 * Fallback selection now probes each configured runtime instead of assuming
 * every configured one is ready, so a test that did not inject this would
 * spawn whatever `codex` happens to be installed on the machine running it —
 * and pass or fail depending on that machine's login state.
 */
function stubAdapter(id: string, readiness: Partial<RuntimeReadiness>, containment: CapabilityStatus, testedVersion: string | null = '1.0.0', testedVersions: ReadonlyArray<string> = []): RuntimeAdapter {
  return {
    id,
    probe: async (executablePath: string) =>
      ({
        adapter: id,
        executablePath,
        installed: true,
        version: '1.0.0',
        adapterSupported: true,
        controllable: true,
        authentication: 'logged_in',
        ready: 'verified_ready',
        probeKind: 'live',
        diagnostics: [],
        observedAt: new Date().toISOString(),
        ...readiness,
      }) as RuntimeReadiness,
    capabilities: () => ({ capabilities: { write_containment: { status: containment, testedVersion, testedVersions, os: process.platform, note: 'stub' } } }),
  } as unknown as RuntimeAdapter;
}

function inputFor(
  state: ReturnType<typeof openTempState>,
  runId: string,
  adapters: Readonly<Record<string, RuntimeAdapter>> = {
    'codex-local': stubAdapter('codex', {}, 'verified'),
    'claude-local': stubAdapter('claude-code', {}, 'unsupported'),
  },
): RunDirectInput {
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
    adapterFactory: (runtime: { id: string }) => adapters[runtime.id] ?? stubAdapter(runtime.id, { ready: 'not_ready' }, 'unsupported'),
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

  it('refuses a replacement runtime that was never shown to be ready, instead of calling every configured one ready', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);

    // The failing case this closes: candidate readiness was the literal
    // `verified_ready` for every runtime in the configuration, so the
    // selector's readiness gate could never fire. Here the only replacement is
    // signed out — the common case on a machine where the first runtime failed
    // to authenticate — and handing it the work would burn a second full turn
    // to fail identically.
    const result = await runWithFallback(
      inputFor(state, run.id, {
        'codex-local': stubAdapter('codex', { ready: 'not_ready', authentication: 'logged_out' }, 'verified'),
        'claude-local': stubAdapter('claude-code', {}, 'unsupported'),
      }),
      { run: async () => failedResult(run.id, task.id, 'attempt-1') },
    );

    expect(result.fallback?.toRuntimeId ?? null).toBeNull();
    expect(result.note).toContain('no fallback runtime was eligible');
    expect(result.note).toContain('readiness is "not_ready"');
    expect(result.attempts).toHaveLength(1);
    state.store.close();
  });

  it('allows recovery onto a separately tested exact build without relabeling the baseline', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    let calls = 0;
    try {
      const result = await runWithFallback(inputFor(state, run.id, {
        'codex-local': stubAdapter('codex', { version: '0.154.0-alpha.6.2' }, 'verified', '0.147.0', ['0.154.0-alpha.6.2']),
        'claude-local': stubAdapter('claude-code', {}, 'unsupported'),
      }), { run: async () => { calls += 1; return failedResult(run.id, task.id, `attempt-${calls}`); } });
      expect(result.fallback?.toRuntimeId).toBe('codex-local');
      expect(calls).toBe(2);
    } finally { state.store.close(); }
  });

  it('refuses a runtime whose write boundary was established against another build, and one that has none at all', async () => {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);

    // Two ways a "verified" status is not a boundary for THIS run: the
    // deterministic test runtime, which enforces nothing and used to be
    // hardcoded as `verified` by adapter name, and a real runtime whose status
    // was established against a build that is not the installed one.
    const result = await runWithFallback(
      inputFor(state, run.id, {
        // Ready, and its capability table says verified — for 0.147.0, which is
        // not what answered the probe.
        'codex-local': stubAdapter('codex', { version: '0.160.0' }, 'verified', '0.147.0'),
        'claude-local': stubAdapter('claude-code', {}, 'unsupported'),
      }),
      { run: async () => failedResult(run.id, task.id, 'attempt-1') },
    );

    // The first attempt ran under local-development, so a replacement needs a
    // boundary established for the build that would actually run.
    expect(result.fallback?.toRuntimeId ?? null).toBeNull();
    expect(result.note).toContain('write_containment "supported_unverified"');
    expect(result.attempts).toHaveLength(1);
    state.store.close();
  });

  it('never hands a writing task to the deterministic test runtime', async () => {
    // The exact case this project's own AT03 evidence configuration produced:
    // codex fails to authenticate, and the fallback selector picked
    // `fake-local` — the scripted fixture runtime — because the candidate list
    // hardcoded write_containment "verified" for the adapter named "fake". Its
    // scripted patch then went through the real verifier and could be accepted.
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    const withFake = validateAgentConfig({
      ...JSON.parse(readFileSync('fixtures/agents/example.json', 'utf8')),
      runtimes: {
        'codex-local': { adapter: 'codex', executable: 'codex' },
        'claude-local': { adapter: 'claude-code', executable: 'claude' },
        'fake-local': { adapter: 'fake', executable: path.resolve('fixtures/fake-runtime/fake-runtime.mjs') },
      },
    });

    const input = {
      ...inputFor(state, run.id),
      config: withFake,
      // The real FakeAdapter for the fake runtime — its own capability table
      // is what must refuse it — and unreachable stand-ins for the rest.
      adapterFactory: (runtime: { id: string; adapter: string; executable: string }) =>
        runtime.adapter === 'fake' ? createAdapter(runtime) : stubAdapter(runtime.adapter, { ready: 'not_ready' }, 'unsupported'),
    } as unknown as RunDirectInput;

    const result = await runWithFallback(input, { run: async () => failedResult(run.id, task.id, 'attempt-1') });

    expect(result.fallback?.toRuntimeId ?? null).not.toBe('fake-local');
    expect(result.fallback?.toRuntimeId ?? null).toBeNull();
    expect(result.attempts).toHaveLength(1);
    const refusals = (result.fallback?.refused ?? []).map((entry) => `${entry.runtimeId}: ${entry.reason}`).join(' | ');
    expect(refusals).toContain('fake-local');
    expect(refusals).toContain('write_containment "unsupported"');
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

describe('fallback worker reservations', () => {
  const config = validateAgentConfig({ ...CONFIG,
    agents: [...CONFIG.agents, { ...CONFIG.agents[0]!, id: 'worker-b', runtime: 'codex-local', model: 'worker-model' }],
  });
  function fixture() {
    const state = openTempState();
    const { run, task } = seedRunAndTask(state);
    const snapshot = computeAgentSnapshot(config, 'engineer');
    upsertAgentSnapshot(state.store.db, snapshot);
    const first = insertAttempt(state.store.db, { taskId: task.id, agentSnapshotHash: snapshot.hash });
    const input = { ...inputFor(state, run.id), config, configRaw: JSON.stringify(config) };
    return { state, run, task, first, input };
  }
  const acquire = (scheduler: Scheduler) => (id: string) =>
    id === 'worker-b' ? scheduler.tryAcquireAgent('a', id) : null;

  it('refuses A quota fallback when worker B already runs another task; the head is never substituted', async () => {
    const f = fixture();
    const scheduler = new Scheduler([{ id: 'a', agentId: 'engineer' }, { id: 'b', agentId: 'worker-b' }], { maxActiveTurns: 2, maxActiveWriters: 2 });
    scheduler.dispatch();
    const called: Array<string | undefined> = [];
    try {
      const result = await runWithFallback(f.input, {
        acquireFallbackAgent: acquire(scheduler),
        run: async (input) => { called.push(input.agentId); return failedResult(f.run.id, f.task.id, f.first.id); },
      });
      expect(called).toEqual(['engineer']);
      expect(result.fallback?.toRuntimeId).toBeNull();
      expect(result.fallback?.refused.some((entry) => entry.reason.includes('available capacity'))).toBe(true);
      expect(scheduler.runningTaskForAgent('worker-b')).toBe('b');
    } finally { f.state.store.close(); }
  });

  it.each(['failed', 'interrupted', 'throw'] as const)('holds idle B exclusively through fallback and releases it after %s', async (outcome) => {
    const f = fixture();
    const scheduler = new Scheduler([{ id: 'a', agentId: 'engineer' }, { id: 'c', agentId: 'worker-c' }], { maxActiveTurns: 2, maxActiveWriters: 2 });
    scheduler.dispatch();
    let calls = 0;
    try {
      const promise = runWithFallback(f.input, {
        acquireFallbackAgent: acquire(scheduler),
        run: async (input) => {
          calls += 1;
          if (calls === 1) return failedResult(f.run.id, f.task.id, f.first.id);
          expect(input.agentId).toBe('worker-b');
          expect(scheduler.runningTaskForAgent('worker-b')).toBe('a');
          expect(scheduler.tryAcquireAgent('c', 'worker-b')).toBeNull();
          if (outcome === 'throw') throw new Error('replacement stopped unexpectedly');
          return failedResult(f.run.id, f.task.id, 'attempt-2', { outcome });
        },
      });
      if (outcome === 'throw') await expect(promise).rejects.toThrow('replacement stopped unexpectedly');
      else {
        const result = await promise;
        expect(result.attempts).toHaveLength(2);
        expect(result.fallback?.toRuntimeId).toBe('codex-local');
      }
      expect(calls).toBe(2);
      expect(scheduler.runningTaskForAgent('worker-b')).toBeUndefined();
      expect(scheduler.runningTaskForAgent('engineer')).toBe('a');
    } finally { f.state.store.close(); }
  });

  it('rechecks capacity after an async readiness probe, so a newly busy B cannot be double assigned', async () => {
    const f = fixture();
    const scheduler = new Scheduler([{ id: 'a', agentId: 'engineer' }, { id: 'c', agentId: 'worker-c' }], { maxActiveTurns: 2, maxActiveWriters: 2 });
    scheduler.dispatch();
    let probeStarted!: () => void;
    let finishProbe!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishProbe = resolve; });
    const adapter = stubAdapter('codex', {}, 'verified');
    let calls = 0;
    let release: (() => void) | null = null;
    try {
      const resultPromise = runWithFallback({ ...f.input, adapterFactory: (runtime) => runtime.id === 'codex-local'
        ? { ...adapter, probe: async (...args) => { probeStarted(); await gate; return adapter.probe(...args); } }
        : stubAdapter('claude-code', {}, 'unsupported') }, {
        acquireFallbackAgent: acquire(scheduler),
        run: async () => { calls += 1; return failedResult(f.run.id, f.task.id, f.first.id); },
      });
      await started;
      release = scheduler.tryAcquireAgent('c', 'worker-b');
      expect(release).not.toBeNull();
      finishProbe();
      const result = await resultPromise;
      expect(calls).toBe(1);
      expect(result.fallback?.toRuntimeId).toBeNull();
      expect(scheduler.runningTaskForAgent('worker-b')).toBe('c');
    } finally { release?.(); finishProbe(); f.state.store.close(); }
  });
});
