/**
 * Conformance targets: one per adapter implementation.
 *
 * The fake target always runs. The two real targets run only under
 * `WORKFORCE_REAL_RUNTIMES=1` and start real processes; the Codex one also
 * spends the signed-in account's quota, so its prompts are deliberately tiny
 * and it runs at most one long turn.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Policy } from '../../../src/core/contracts.js';
import { ClaudeCodeAdapter, TESTED_CLAUDE_VERSION } from '../../../src/adapters/claude-code/adapter.js';
import { CodexAdapter, TESTED_CODEX_VERSION } from '../../../src/adapters/codex/adapter.js';
import { FakeAdapter, FAKE_SCENARIO_ENV } from '../../../src/adapters/fake/adapter.js';
import type { ConformanceSession, ConformanceTarget } from './suite.js';

function workspaceRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'README.md'), '# conformance fixture\n');
  return workspace;
}

// ---------------------------------------------------------------------------
// fake
// ---------------------------------------------------------------------------

const FAKE_SCRIPT = fileURLToPath(new URL('../../../fixtures/fake-runtime/fake-runtime.mjs', import.meta.url));

function fakeSession(scenario: unknown, policy: Policy = 'local-development'): () => Promise<ConformanceSession> {
  return async () => {
    const workspace = workspaceRoot('wf-conf-fake-');
    const scenarioFile = path.join(path.dirname(workspace), 'scenario.json');
    writeFileSync(scenarioFile, JSON.stringify(scenario));
    const adapter = new FakeAdapter({ scriptPath: FAKE_SCRIPT, scenarioPath: scenarioFile, interruptTimeoutMs: 3_000, stopTimeoutMs: 3_000 });
    const handle = await adapter.openSession({
      cwd: workspace,
      allowedWritePaths: [workspace],
      policy,
      systemInstructions: 'conformance',
      env: { [FAKE_SCENARIO_ENV]: scenarioFile },
    });
    return {
      adapter,
      handle,
      workspace,
      close: async () => {
        await adapter.stopOwnedProcesses(handle).catch(() => undefined);
      },
    };
  };
}

const FAKE_QUICK_SCENARIO = { scenarioVersion: 1, steps: [{ action: 'edit_file', path: 'README.md', content: '# edited\n' }, { action: 'message', text: 'done' }] };

export const fakeTarget: ConformanceTarget = {
  name: 'fake',
  adapterId: 'fake',
  expectedTestedVersion: null,
  probeExecutable: FAKE_SCRIPT,
  prompt: 'edit the fixture',
  openQuick: fakeSession(FAKE_QUICK_SCENARIO),
  openSlow: fakeSession({ scenarioVersion: 1, steps: [{ action: 'sleep', ms: 20_000 }] }),
  slowPrompt: 'take your time',
  openNoisy: fakeSession({ scenarioVersion: 1, steps: [{ action: 'unknown_event' }, { action: 'malformed_output' }, { action: 'message', text: 'still alive' }] }),
  // The fake runtime lists the messages it received in the turn it starts.
  observeQueuedDelivery: (events, messageId) =>
    events.some((event) => event.kind === 'turn_started' && JSON.stringify(event.payload['inbox'] ?? []).includes(messageId)),
  policySupport: { analysis: 'opens', 'local-development': 'opens', verification: 'refuses' },
  openWithPolicy: (policy) => fakeSession(FAKE_QUICK_SCENARIO, policy)(),
};

// ---------------------------------------------------------------------------
// claude-code (real)
// ---------------------------------------------------------------------------

const FAKE_CLAUDE = fileURLToPath(new URL('../../../fixtures/claude-code/fake-claude.mjs', import.meta.url));

function claudeScenario(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/claude-code/${name}`, import.meta.url));
}

/** The replay target: the same adapter, driven by the deterministic fake binary. Always runs. */
function replaySession(scenario: string, policy: Policy = 'local-development'): () => Promise<ConformanceSession> {
  return async () => {
    const workspace = workspaceRoot('wf-conf-claude-replay-');
    const adapter = new ClaudeCodeAdapter({
      executablePath: process.execPath,
      extraArgs: [FAKE_CLAUDE],
      startupTimeoutMs: 10_000,
      controlTimeoutMs: 10_000,
      interruptTimeoutMs: 5_000,
      stopTimeoutMs: 3_000,
      deliveryAckTimeoutMs: 3_000,
    });
    const handle = await adapter.openSession({
      cwd: workspace,
      allowedWritePaths: [workspace],
      policy,
      systemInstructions: 'conformance',
      env: { WORKFORCE_FAKE_CLAUDE_SCENARIO: claudeScenario(scenario), WORKFORCE_FAKE_CLAUDE_VARS: JSON.stringify({ cwd: workspace }) },
    });
    return {
      adapter,
      handle,
      workspace,
      close: async () => {
        await adapter.stopOwnedProcesses(handle).catch(() => undefined);
      },
    };
  };
}

export const claudeReplayTarget: ConformanceTarget = {
  name: 'claude-code (recorded replay)',
  adapterId: 'claude-code',
  expectedTestedVersion: TESTED_CLAUDE_VERSION,
  probeSkipReason: 'the replay binary is not the claude executable, so there is nothing to probe passively; the real target probes the installed one',
  prompt: 'Create a file named hello.txt containing exactly: hello',
  openQuick: replaySession('session-hello.synthetic.json'),
  // A scenario whose turn stays open until it is interrupted, and which echoes
  // a second user frame back while that turn is still running — so the suite
  // exercises both the mid-turn delivery receipt and the `observed` interrupt.
  openSlow: replaySession('session-delivery.synthetic.json'),
  slowPrompt: 'search the whole repository',
  openNoisy: replaySession('session-noise.synthetic.json'),
  // The CLI echoes every frame it ingests (`--replay-user-messages`), so a
  // flushed message is visible in the turn that carried it.
  observeQueuedDelivery: (events, messageId) =>
    events.some((event) => event.kind === 'raw' && event.payload['reason'] === 'user_message_replay' && String(event.payload['text'] ?? '').includes(messageId)),
  policySupport: { analysis: 'opens', 'local-development': 'opens', verification: 'refuses' },
  openWithPolicy: (policy) => replaySession('session-hello.synthetic.json', policy)(),
};

export function realClaudeTarget(executablePath: string): ConformanceTarget {
  const open = async (policy: Policy): Promise<ConformanceSession> => {
    const workspace = workspaceRoot('wf-conf-claude-');
    const adapter = new ClaudeCodeAdapter({ executablePath, startupTimeoutMs: 60_000, controlTimeoutMs: 60_000, interruptTimeoutMs: 15_000, stopTimeoutMs: 8_000, deliveryAckTimeoutMs: 5_000 });
    const handle = await adapter.openSession({ cwd: workspace, allowedWritePaths: [workspace], policy, systemInstructions: 'You are a workforce conformance worker. Answer in one short sentence.' });
    return {
      adapter,
      handle,
      workspace,
      close: async () => {
        await adapter.stopOwnedProcesses(handle).catch(() => undefined);
      },
    };
  };
  const openQuick = (): Promise<ConformanceSession> => open('local-development');
  return {
    name: 'claude-code (installed runtime)',
    adapterId: 'claude-code',
    expectedTestedVersion: TESTED_CLAUDE_VERSION,
    probeExecutable: executablePath,
    prompt: 'Reply with the single word: ready',
    openQuick,
    observeQueuedDelivery: (events, messageId) =>
      events.some((event) => event.kind === 'raw' && event.payload['reason'] === 'user_message_replay' && String(event.payload['text'] ?? '').includes(messageId)),
    policySupport: { analysis: 'opens', 'local-development': 'opens', verification: 'refuses' },
    openWithPolicy: open,
    // A turn cannot be held open on a machine whose stored OAuth session is
    // expired: every turn terminates in about 60 ms with an authentication
    // error. See docs/runtime-claude-code.md.
    slowSkipReason:
      'no turn can be kept running against the installed runtime here: the stored claude.ai OAuth session is expired, so every turn ends within ~60 ms with error "authentication_failed". The recorded-replay target covers these cases deterministically',
    noisySkipReason: 'the installed runtime cannot be made to emit malformed output on demand; the recorded-replay target covers it',
  };
}

// ---------------------------------------------------------------------------
// codex (real)
// ---------------------------------------------------------------------------

export function realCodexTarget(executablePath: string, model: string): ConformanceTarget {
  const open = async (policy: 'analysis' | 'local-development'): Promise<ConformanceSession> => {
    const workspace = workspaceRoot('wf-conf-codex-');
    const adapter = new CodexAdapter({ executablePath, startupTimeoutMs: 60_000, requestTimeoutMs: 120_000, interruptTimeoutMs: 20_000, stopTimeoutMs: 8_000 });
    const handle = await adapter.openSession({
      cwd: workspace,
      allowedWritePaths: [workspace],
      policy,
      systemInstructions: 'You are a workforce conformance worker. Answer in one short sentence.',
      model,
      effort: 'low',
    });
    return {
      adapter,
      handle,
      workspace,
      close: async () => {
        await adapter.stopOwnedProcesses(handle).catch(() => undefined);
      },
    };
  };
  return {
    name: 'codex (installed runtime)',
    adapterId: 'codex',
    expectedTestedVersion: TESTED_CODEX_VERSION,
    probeExecutable: executablePath,
    prompt: 'Reply with the single word: ready',
    openQuick: () => open('analysis'),
    openSlow: () => open('local-development'),
    slowPrompt: 'Run exactly this shell command and nothing else: sleep 45',
    noisySkipReason: 'the installed app server cannot be made to emit malformed frames on demand; tests/adapters/codex/adapter.test.ts covers it with a recorded replay',
    // The app server does not echo the turn input back in its event stream, so
    // a queued message's arrival cannot be observed from the events alone; the
    // adapter's own tests assert it is flushed into the next turn/start input.
    deliveryObservationSkipReason: 'the Codex app server does not echo turn input, so a redeemed delivery is not visible in its event stream',
    policySupport: { analysis: 'opens', 'local-development': 'opens', verification: 'refuses' },
    openWithPolicy: (policy) => open(policy as 'analysis' | 'local-development'),
  };
}
