/**
 * Integration wiring: the CLI dispatches doctor/run/status, the run path's
 * adapter registry resolves the real Codex adapter, and --state-dir /
 * --workspace-root reach the coordinator's paths.
 *
 * Nothing here starts a model turn: the Codex branch is exercised with a stub
 * executable that exits immediately, which proves the adapter is constructed
 * and driven without paying for a turn.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, FAKE_SCENARIO_ENV, type CapabilityName, type RuntimeCapabilities, type SessionHandle } from '../../src/adapters/index.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code/index.js';
import { CodexAdapter } from '../../src/adapters/codex/index.js';
import { FAKE_APP_SERVER, fixturePath as codexFixturePath } from '../adapters/codex/helpers.js';
import { runCli } from '../../src/cli/index.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { capabilitiesFor, loadVerifiedCapabilityOverrides } from '../../src/discovery/capabilities.js';
import { AdapterNotRegisteredError, createAdapter, runDirect } from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, fixTheBugScenario, registerCleanup, tempDir, useFixture, writeClaudeAgentsConfig, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

const CODEX_TRANSCRIPT = codexFixturePath('session-hello.synthetic.jsonl');

afterEach(() => cleanupAll());

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function invoke(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const code = await runCli(argv, { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) });
  return { stdout, stderr, code };
}

function useScenario(): void {
  const scenarioPath = writeScenario(fixTheBugScenario());
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = scenarioPath;
  registerCleanup(() => {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  });
}

/** An executable that answers nothing and exits: enough to drive the adapter, never a model turn. */
/**
 * An executable that exits immediately.
 *
 * Every test here that reaches the adapter layer must use one. Naming an
 * installed runtime instead (`executable: 'claude'`) resolves on PATH to the
 * real binary, and `run` then opens a real session and starts a real, paid
 * model turn from the default `npm test` — which is what happened here until
 * this was fixed: the case below passed only while the installed runtime
 * happened to fail authentication in ~47 ms, and started charging the user's
 * account and timing out the moment its credential worked again.
 */
function stubExecutable(dir: string, name = 'runtime-stub'): string {
  const file = path.join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

function writeCodexAgentsConfig(dir: string, executable: string): string {
  const file = path.join(dir, 'agents.json');
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtimes: { 'codex-local': { adapter: 'codex', executable } },
        defaults: {
          workerAgent: 'engineer',
          maxActiveTurns: 2,
          maxActiveWriters: 2,
          maxTasksPerRun: 8,
          maxDelegationDepth: 2,
          maxRepairAttempts: 2,
          maxTransientRetries: 2,
          runTimeoutMinutes: 30,
        },
        agents: [{ id: 'engineer', runtime: 'codex-local', instructions: 'Fix the issue and show evidence.', capabilities: ['coding'], policy: 'local-development' }],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

describe('run-path adapter registry', () => {
  it('resolves "codex" and "claude-code" to their real adapters, keeps "fake" and still refuses an unknown one', () => {
    const logsDir = path.join(tempDir('workforce-registry-'), 'logs');
    const context = { runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', logsDir };

    const codex = createAdapter({ id: 'codex-local', adapter: 'codex', executable: '/usr/local/bin/codex' }, context);
    expect(codex).toBeInstanceOf(CodexAdapter);
    expect(codex.id).toBe('codex');
    // The adapter binds its capability statuses to a tested executable version
    // rather than assuming the installed one behaves the same way.
    expect(codex.capabilities().capabilities.structured_events.testedVersion).not.toBeNull();

    expect(createAdapter({ id: 'fake-local', adapter: 'fake', executable: '/tmp/fake.mjs' }, context)).toBeInstanceOf(FakeAdapter);

    // WP05 registered the second real runtime; nothing else in the direct path
    // changed to accommodate it, which is the point of the shared conformance suite.
    const claude = createAdapter({ id: 'claude-local', adapter: 'claude-code', executable: 'claude' }, context);
    expect(claude).toBeInstanceOf(ClaudeCodeAdapter);
    expect(claude.id).toBe('claude-code');
    expect(claude.capabilities().capabilities.structured_events.testedVersion).not.toBeNull();

    expect(() => createAdapter({ id: 'other', adapter: 'not-a-runtime', executable: 'x' }, context)).toThrow(AdapterNotRegisteredError);
  });

  it('drives the real Codex adapter from "workforce run" and reports its transport failure, not a missing registration', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-codex-state-'), 'state');
    const configDir = tempDir('workforce-codex-config-');
    const configPath = writeCodexAgentsConfig(configDir, stubExecutable(configDir));

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateDir, '--json']);

    expect(result.code).toBe(EXIT_CODES.executionFailure);
    const document = JSON.parse(result.stdout.trimEnd().split('\n').at(-1) as string) as { error?: { code?: string; message?: string } };
    expect(document.error?.code).not.toBe('adapter_not_registered');
    // The failure is the app server refusing to talk, which only the real
    // adapter can produce.
    expect(`${document.error?.message ?? ''}`).toMatch(/app-server/);
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(false);
  });
});

describe('the CLI refuses an unconfined writing run unless a human accepts one', () => {
  it('exits 2 with the missing boundary named, and creates no state', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-boundary-state-'), 'state');
    // The default worker binding fixtures/agents/example.json ships: an agent
    // on claude-code under local-development.
    const configDir = tempDir('workforce-boundary-config-');
    const configPath = writeClaudeAgentsConfig(configDir, { executable: stubExecutable(configDir, 'claude-stub') });

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateDir, '--json']);

    expect(result.code).toBe(EXIT_CODES.invalidInput);
    const document = JSON.parse(result.stdout.trimEnd().split('\n').at(-1) as string) as { error?: { code?: string; message?: string } };
    expect(document.error?.code).toBe('write_boundary_unsupported');
    expect(document.error?.message).toContain('write_containment "unsupported"');
    expect(document.error?.message).toContain('--allow-unconfined-writes');
    // Refused at setup: the state root exists because the command took its
    // lock, but no run was recorded and no candidate workspace was created.
    expect(existsSync(path.join(stateDir, 'runs')) ? readdirSync(path.join(stateDir, 'runs')) : []).toEqual([]);
    expect(existsSync(path.join(stateDir, 'workspaces')) ? readdirSync(path.join(stateDir, 'workspaces')) : []).toEqual([]);
  });

  it('accepts the run when --allow-unconfined-writes is passed, and the flag reaches the coordinator', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-boundary-ok-state-'), 'state');
    const configDir = tempDir('workforce-boundary-ok-config-');
    // A stub binary, never the installed `claude`: this case runs the whole
    // `run` command, so a real executable here would open a real session and
    // spend the user's quota on every `npm test`.
    const configPath = writeClaudeAgentsConfig(configDir, { executable: stubExecutable(configDir, 'claude-stub') });

    // The point is that the gate no longer refuses, so the run proceeds to the
    // adapter and fails there instead — against a stub that exits at once.
    const result = await invoke([
      'run',
      '--repo',
      fixture.path,
      '--agents',
      configPath,
      '--task',
      'Fix the pagination off-by-one.',
      '--state-dir',
      stateDir,
      '--allow-unconfined-writes',
      '--json',
    ]);

    const document = JSON.parse(result.stdout.trimEnd().split('\n').at(-1) as string) as { error?: { code?: string } };
    expect(document.error?.code).not.toBe('write_boundary_unsupported');
    expect(result.stderr).toContain('WARNING: no enforced write boundary');
    // It got as far as the runtime and failed there: the flag reached the
    // coordinator, and no model turn was started by the default test suite.
    expect(result.code).toBe(EXIT_CODES.executionFailure);
  });
});

describe('state and workspace roots reach the coordinator', () => {
  it('puts the candidate workspace under --workspace-root and the coordinator state under --state-dir', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-roots-state-'), 'state');
    const workspaceRoot = path.join(tempDir('workforce-roots-ws-'), 'candidates');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-roots-config-'));
    useScenario();

    const result = await invoke([
      'run',
      '--repo',
      fixture.path,
      '--agents',
      configPath,
      '--task',
      'Fix the pagination off-by-one.',
      '--state-dir',
      stateDir,
      '--workspace-root',
      workspaceRoot,
    ]);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.stdout).toContain(`candidate workspace ${workspaceRoot}`);
    // The state root holds coordinator state only; the default workspace
    // directory under it is never created when a root is supplied.
    expect(existsSync(path.join(stateDir, 'state.sqlite'))).toBe(true);
    expect(existsSync(path.join(stateDir, 'workspaces'))).toBe(false);
    expect(readdirSync(workspaceRoot).length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')) as { workspaceRoot: string };
    expect(manifest.workspaceRoot).toBe(workspaceRoot);
  });

  it('refuses a --workspace-root that disagrees with the one the state root already records', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-roots-state2-'), 'state');
    const firstRoot = path.join(tempDir('workforce-roots-ws1-'), 'candidates');
    const secondRoot = path.join(tempDir('workforce-roots-ws2-'), 'candidates');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-roots-config2-'));
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'manifest.json'),
      `${JSON.stringify({ manifestVersion: 1, stateRoot: stateDir, workspaceRoot: firstRoot, databasePath: path.join(stateDir, 'state.sqlite'), createdAt: new Date().toISOString() }, null, 2)}\n`,
    );

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--workspace-root', secondRoot]);

    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stderr).toContain('already records workspace root');
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(false);
  });
});

describe('the CLI dispatches every implemented command', () => {
  it('runs doctor, run and status against one state root and still reports resume as unimplemented', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-dispatch-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-dispatch-config-'));
    useScenario();

    const doctor = await invoke(['doctor', '--state-dir', stateDir, '--json']);
    expect(doctor.code).toBe(EXIT_CODES.verifiedCandidate);
    const doctorDocument = JSON.parse(doctor.stdout) as { stateRoot: string; runtimes: ReadonlyArray<{ adapter: string }> };
    expect(doctorDocument.stateRoot).toBe(path.resolve(stateDir));
    expect(doctorDocument.runtimes.map((runtime) => runtime.adapter).sort()).toEqual(['claude-code', 'codex']);

    const run = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateDir, '--json']);
    expect(run.code).toBe(EXIT_CODES.verifiedCandidate);
    const runDocument = JSON.parse(run.stdout.trimEnd().split('\n').at(-1) as string) as { runId: string };

    const status = await invoke(['status', runDocument.runId, '--state-dir', stateDir, '--json']);
    expect(status.code).toBe(EXIT_CODES.verifiedCandidate);
    const statusDocument = JSON.parse(status.stdout) as { run: { id: string; state: string } };
    expect(statusDocument.run.id).toBe(runDocument.runId);
    expect(statusDocument.run.state).toBe('ready_for_review');

    const resume = await invoke(['resume', runDocument.runId, '--state-dir', stateDir]);
    expect(resume.code).toBe(EXIT_CODES.executionFailure);
    expect(resume.stdout).toContain('not implemented');
  });
});

/**
 * A fake runtime that also reports token counts the way the Codex app server
 * does, so the manifest's usage handling can be exercised without spending a
 * model turn.
 */
class UsageReportingFakeAdapter extends FakeAdapter {
  readonly reported: unknown;

  constructor(scriptPath: string, reported: unknown) {
    super({ scriptPath });
    this.reported = reported;
  }

  override capabilities(): RuntimeCapabilities {
    const base = super.capabilities();
    const capabilities: Record<CapabilityName, RuntimeCapabilities['capabilities'][CapabilityName]> = { ...base.capabilities };
    capabilities.usage_reporting = { status: 'verified', testedVersion: '0.0.0-test', os: process.platform, note: 'token counts only; the runtime reports no price' };
    return { ...base, capabilities };
  }

  /**
   * The shared contract accessor, not an adapter-private one: the run path
   * reads `RuntimeAdapter.lastTurnUsage` and nothing else, and a stub that
   * exposes some other name would be reported as "no usage" — the defect this
   * suite exists to catch.
   */
  lastTurnUsage(_session: SessionHandle): never {
    return this.reported as never;
  }
}

describe('usage reporting is measured or unavailable, never zero (FR060)', () => {
  async function runWithUsage(reported: unknown): Promise<{ status: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; source: string }> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-usage-state-');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-usage-config-'));
    const scenarioPath = writeScenario(fixTheBugScenario());
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const loaded = loadAgentConfigFile(configPath);
      const result = await runDirect({
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: 'Fix the pagination off-by-one.',
        requestSource: 'argument',
        paths,
        db: store.db,
        sessionEnv: { [FAKE_SCENARIO_ENV]: scenarioPath },
        adapterFactory: (runtime) => new UsageReportingFakeAdapter(runtime.executable, reported),
      });
      return result.manifest.usage;
    } finally {
      store.close();
    }
  }

  it('records the token counts a runtime reports and still refuses to invent a cost', async () => {
    const usage = await runWithUsage({
      inputTokens: 133_961,
      outputTokens: 1_108,
      costUsd: null,
      costStatus: 'unavailable',
      detail: 'token counts reported by the runtime; it reports no currency cost, so cost is unavailable rather than zero',
    });

    expect(usage.status).toBe('measured');
    expect(usage.inputTokens).toBe(133_961);
    expect(usage.outputTokens).toBe(1_108);
    expect(usage.costUsd).toBeNull();
    expect(usage.source).toContain('cost is unavailable rather than zero');
  });

  it('records a currency cost when the runtime measured one', async () => {
    // Claude Code's result record does carry total_cost_usd. A run path that
    // hard-codes cost to null throws away the only price any installed runtime
    // reports; one that passes through an unmeasured zero would be worse.
    const usage = await runWithUsage({
      inputTokens: 1_200,
      outputTokens: 40,
      costUsd: 0.0123,
      costStatus: 'measured',
      detail: 'total_cost_usd reported by the runtime for a turn that reached the provider',
    });

    expect(usage.status).toBe('measured');
    expect(usage.costUsd).toBe(0.0123);
    expect(usage.source).toContain('reached the provider');
  });

  it('reports usage as unavailable when the runtime reports a shape it cannot read', async () => {
    const usage = await runWithUsage({ tokens: 'a lot' });

    expect(usage.status).toBe('unavailable');
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.costUsd).toBeNull();
  });

  it('reports usage as unavailable for an adapter that only exposes a private accessor', async () => {
    // The regression this guards: `run-direct` used to duck-type an
    // adapter-specific `lastTokenUsage` method. Any adapter that named its
    // accessor differently was reported as having measured nothing, however
    // much its own event stream carried.
    const usage = await runWithUsage(undefined);

    expect(usage.status).toBe('unavailable');
    expect(usage.source).toContain('no usage was reported for this turn');
  });
});

describe('the real Codex adapter drives the direct run path (no model turn)', () => {
  it('runs a recorded Codex session end to end, records its token counts and fails honestly when nothing was changed', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-codex-run-');
    const configPath = writeCodexAgentsConfig(tempDir('workforce-codex-run-config-'), process.execPath);
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    let logsDir: string | null = null;
    try {
      const loaded = loadAgentConfigFile(configPath);
      const result = await runDirect({
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: 'Fix the pagination off-by-one.',
        requestSource: 'argument',
        paths,
        db: store.db,
        // The real Codex adapter, pointed at the recorded app-server
        // transcript instead of the installed binary: the whole adapter is
        // exercised, no model turn is started and no quota is spent.
        adapterFactory: (_runtime, context) => {
          logsDir = context.logsDir;
          return new CodexAdapter({
            executablePath: process.execPath,
            appServerArgs: [FAKE_APP_SERVER, '--transcript', CODEX_TRANSCRIPT],
            logsDir: context.logsDir,
            startupTimeoutMs: 15_000,
            requestTimeoutMs: 15_000,
            stopTimeoutMs: 5_000,
          });
        },
      });

      // The recorded turn only talks; the fixture's failing test is still
      // failing, so the run refuses to accept it.
      expect(result.outcome).toBe('failed');
      expect(result.acceptance.accepted).toBe(false);
      expect(result.manifest.runtime).toMatchObject({ adapter: 'codex', turnConclusion: 'completed' });
      // Token counts come from the runtime; cost does not exist for it.
      expect(result.manifest.usage).toMatchObject({ status: 'measured', inputTokens: 1200, outputTokens: 40, costUsd: null });
      // The adapter's raw stdio capture lands in the run's own logs directory.
      expect(readdirSync(logsDir as unknown as string).some((name) => name.startsWith('codex-') && name.endsWith('.jsonl'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('the shipped verified-capabilities file reaches discovery (FR005)', () => {
  it('parses, raises the codex statuses WP03 established, and stops at the version it was established on', () => {
    const overrides = loadVerifiedCapabilityOverrides();

    // A malformed file is ignored with a diagnostic, so an empty diagnostics
    // list is what proves the two packages agree on the schema.
    expect(overrides.present).toBe(true);
    expect(overrides.diagnostics).toEqual([]);

    const tested = capabilitiesFor('codex', '0.147.0', { overrides });
    expect(tested.structured_execution).toMatchObject({ status: 'verified', source: 'override' });
    expect(tested.sandbox_workspace_write.status).toBe('verified');
    expect(tested.token_usage_report.status).toBe('verified');
    expect(tested.structured_execution.note).toContain('real-runtime.test.ts');
    // Never claimed, so it must not have been raised.
    expect(tested.mcp_config_injection).toMatchObject({ status: 'supported_unverified', source: 'table' });
    // Cost stays unsupported: an unavailable price is never reported as zero.
    expect(tested.cost_report.status).toBe('unsupported');

    // The evidence was gathered on 0.147.0 only; a later build falls back to
    // the documented-but-unproved table rather than inheriting the claim.
    const untested = capabilitiesFor('codex', '0.148.0', { overrides });
    expect(untested.structured_execution).toMatchObject({ status: 'supported_unverified', source: 'table' });
  });
});
