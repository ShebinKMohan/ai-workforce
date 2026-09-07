/** AT01 — `workforce doctor`: informational exit 0, exit 2 only for bad arguments, and no invocation that could start a model turn. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { commandDoctor } from '../../src/cli/commands/doctor.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { fakeClaude, fakeCodex, tempDir, writeExecutable } from './helpers.js';

const EXAMPLE_AGENTS = path.resolve('fixtures/agents/example.json');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir('workforce-doctor-');
  roots.push(dir);
  return dir;
}

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

function jsonDocument(captured: Captured): Record<string, unknown> {
  const lines = captured.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

interface RuntimeJson {
  adapter: string;
  executable: string | null;
  realPath: string | null;
  version: string | null;
  installed: boolean;
  adapterSupported: boolean;
  controllable: boolean;
  auth: string;
  readiness: string;
  capabilities: Record<string, { status: string }>;
  checkedAt: string;
  probes: Array<{ argv: string[] }>;
  probeKind: string;
}

function runtimes(doc: Record<string, unknown>): RuntimeJson[] {
  return doc['runtimes'] as RuntimeJson[];
}

describe('workforce doctor reports what it found', () => {
  it('reports both runtimes with the full readiness record and exits 0', async () => {
    const bin = scratch();
    const argvLog = path.join(bin, 'argv.log');
    const codex = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0', login: 'in', argvLog }));
    const claude = writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260', auth: 'json-in', argvLog }));

    const result = await invoke(['doctor', '--codex-path', codex, '--claude-path', claude, '--state-dir', path.join(scratch(), 'state'), '--json']);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    const doc = jsonDocument(result);
    expect(doc).toMatchObject({ ok: true, command: 'doctor', exitCode: 0, passive: true });

    const [codexReport, claudeReport] = runtimes(doc);
    expect(codexReport).toMatchObject({
      adapter: 'codex',
      executable: codex,
      version: '0.147.0',
      installed: true,
      adapterSupported: true,
      controllable: true,
      auth: 'logged_in',
      readiness: 'controllable',
      probeKind: 'passive',
    });
    expect(typeof codexReport?.realPath).toBe('string');
    expect(Date.parse(codexReport!.checkedAt)).not.toBeNaN();
    expect(Object.keys(codexReport!.capabilities)).toContain('observed_cancellation');
    expect(claudeReport).toMatchObject({ adapter: 'claude-code', version: '2.1.260', readiness: 'controllable', auth: 'logged_in' });

    // Every argument either runtime was invoked with, as the executables themselves recorded it.
    const invocations = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(invocations.sort()).toEqual(['--version', '--version', 'auth status', 'login status'].sort());
  });

  it('says which runtime has no write boundary, and which agent that blocks', async () => {
    // The fact a run manifest must never be able to hide: claude-code 2.1.260
    // has no OS sandbox, so an agent bound to it under "local-development"
    // cannot be dispatched without an explicit acknowledgement.
    const bin = scratch();
    const codex = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0' }));
    const claude = writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260' }));

    const result = await invoke(['doctor', '--codex-path', codex, '--claude-path', claude, '--agents', EXAMPLE_AGENTS, '--state-dir', path.join(scratch(), 'state'), '--json']);
    const doc = jsonDocument(result);
    const [codexReport, claudeReport] = runtimes(doc) as unknown as Array<RuntimeJson & { missingWriteBoundary: string[]; writingModeAvailable: boolean }>;

    expect(codexReport!.missingWriteBoundary).toEqual([]);
    expect(codexReport!.writingModeAvailable).toBe(true);
    // Verified against the installed build: no OS sandbox at all.
    expect(claudeReport!.missingWriteBoundary).toEqual(['sandbox_workspace_write']);
    expect(claudeReport!.writingModeAvailable).toBe(false);

    const config = doc['config'] as { agents: Array<{ id: string; policy: string; writeBoundaryBlocked: boolean }> };
    // fixtures/agents/example.json binds the default worker to claude-code
    // under local-development, which is exactly the binding this must catch.
    expect(config.agents.find((agent) => agent.id === 'engineer')).toMatchObject({ policy: 'local-development', writeBoundaryBlocked: true });
    expect(config.agents.find((agent) => agent.id === 'architect')).toMatchObject({ policy: 'analysis', writeBoundaryBlocked: false });

    const human = await invoke(['doctor', '--codex-path', codex, '--claude-path', claude, '--agents', EXAMPLE_AGENTS, '--state-dir', path.join(scratch(), 'state')]);
    expect(human.stdout).toContain('write boundary: NONE');
    expect(human.stdout).toContain('BLOCKED: policy "local-development"');
  });

  it('says that a login-status command is not evidence of a usable credential', async () => {
    const bin = scratch();
    const claude = writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260', auth: 'json-in' }));
    const result = await invoke(['doctor', '--claude-path', claude, '--state-dir', path.join(scratch(), 'state'), '--json']);

    const claudeReport = runtimes(jsonDocument(result)).find((report) => report.adapter === 'claude-code') as unknown as RuntimeJson & {
      authDetail: string;
      diagnostics: string[];
    };
    expect(claudeReport.auth).toBe('logged_in');
    expect(claudeReport.authDetail).toContain('stored profile');
    // The disagreement WP05 found on the recording machine, stated where a
    // user reads it rather than only in the adapter.
    expect(claudeReport.diagnostics.join(' ')).toContain('account.tokenSource');
    expect(claudeReport.diagnostics.join(' ')).toContain('--connect');
    expect(claudeReport.readiness).not.toBe('verified_ready');
  });

  it('--connect believes the runtime over the status command and can reach verified_ready', async () => {
    const bin = scratch();
    const codex = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0' }));
    const claude = writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260', auth: 'json-in' }));
    const stateDir = path.join(scratch(), 'state');

    // The runtime disagrees with its own status command: this is the state the
    // recording machine was actually in (auth status said loggedIn=true while
    // the runtime held no usable credential).
    const disagreeing = await commandDoctor(
      { codexPath: codex, claudePath: claude, stateDir, connect: true },
      {
        liveProbe: async (adapter, executable) => ({
          adapter,
          executablePath: executable,
          installed: true,
          version: adapter === 'codex' ? '0.147.0' : '2.1.260',
          adapterSupported: true,
          controllable: true,
          authentication: adapter === 'claude-code' ? ('logged_out' as const) : ('logged_in' as const),
          ready: adapter === 'claude-code' ? ('not_ready' as const) : ('verified_ready' as const),
          probeKind: 'live' as const,
          diagnostics: adapter === 'claude-code' ? ['the runtime reports account.tokenSource "none": it holds no usable credential'] : [],
          observedAt: new Date().toISOString(),
        }),
      },
    );

    const data = disagreeing.data as { connectionChecked: boolean; passive: boolean; runtimes: Array<{ adapter: string; auth: string; readiness: string; authDetail: string; probeKind: string; diagnostics: string[] }> };
    expect(data.connectionChecked).toBe(true);
    expect(data.passive).toBe(false);

    const claudeReport = data.runtimes.find((report) => report.adapter === 'claude-code')!;
    expect(claudeReport.auth).toBe('logged_out');
    expect(claudeReport.authDetail).toContain("the runtime's own answer is the one recorded");
    expect(claudeReport.diagnostics.join(' ')).toContain('connection check: the runtime reports account.tokenSource');
    expect(claudeReport.readiness).not.toBe('verified_ready');

    // And a runtime the check agrees with does become verified_ready — the
    // state passive discovery is not allowed to reach.
    const codexReport = data.runtimes.find((report) => report.adapter === 'codex')!;
    expect(codexReport.probeKind).toBe('live');
    expect(codexReport.readiness).toBe('verified_ready');
  });

  it('exits 0 when a runtime is missing and says so instead of failing', async () => {
    const missing = path.join(scratch(), 'no-such-codex');
    const result = await invoke(['doctor', '--codex-path', missing, '--claude-path', missing, '--state-dir', path.join(scratch(), 'state'), '--json']);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    for (const report of runtimes(jsonDocument(result))) {
      expect(report.readiness).toBe('missing');
      expect(report.installed).toBe(false);
      expect(report.probes).toEqual([]);
      expect(report.capabilities['structured_execution']?.status).toBe('unsupported');
    }
  });

  it('never reports verified_ready and never creates coordinator state', async () => {
    const bin = scratch();
    const stateDir = path.join(scratch(), 'state');
    const codex = writeExecutable(bin, 'codex', fakeCodex());
    const claude = writeExecutable(bin, 'claude', fakeClaude());

    const result = await invoke(['doctor', '--codex-path', codex, '--claude-path', claude, '--state-dir', stateDir, '--json']);

    for (const report of runtimes(jsonDocument(result))) expect(report.readiness).not.toBe('verified_ready');
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(false);
    expect(existsSync(path.join(stateDir, 'state.sqlite'))).toBe(false);
  });

  it('prints a readable table and per-runtime detail in human mode', async () => {
    const bin = scratch();
    const codex = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0' }));
    const claude = writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260', auth: 'text-out' }));

    const result = await invoke(['doctor', '--codex-path', codex, '--claude-path', claude, '--state-dir', path.join(scratch(), 'state')]);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.stdout).toContain('no model turn is started');
    expect(result.stdout).toMatch(/RUNTIME\s+VERSION\s+READINESS\s+AUTH\s+EXECUTABLE/);
    expect(result.stdout).toMatch(/codex\s+0\.147\.0\s+controllable\s+logged_in/);
    expect(result.stdout).toMatch(/claude-code\s+2\.1\.260\s+controllable\s+logged_out/);
    expect(result.stdout).toContain('structured_execution');
    expect(result.stdout).toContain('login status');
  });

  it('validates each configured agent\'s settings against the discovered version', async () => {
    const bin = scratch();
    const codex = writeExecutable(bin, 'codex', fakeCodex());
    const claude = writeExecutable(bin, 'claude', fakeClaude());

    const result = await invoke(['doctor', '--agents', EXAMPLE_AGENTS, '--codex-path', codex, '--claude-path', claude, '--state-dir', path.join(scratch(), 'state')]);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.stdout).toContain('agent engineer: runtime claude-local (claude-code via claude), policy local-development');
    expect(result.stdout).toContain('policy controls: --permission-mode acceptEdits');
    expect(result.stdout).toContain('agent architect: runtime codex-local (codex via codex), policy analysis');
    expect(result.stdout).toContain('--sandbox read-only --ask-for-approval never');
    expect(result.stdout).toContain('unsupported permissions.network');
  });
});

describe('a configured executable is probed, not assumed (FR001, FR002)', () => {
  function configWith(dir: string, codexExecutable: string): string {
    const file = path.join(dir, 'agents.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        runtimes: { 'codex-local': { adapter: 'codex', executable: codexExecutable } },
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
        agents: [{ id: 'engineer', runtime: 'codex-local', instructions: 'fix the bug', capabilities: ['coding'], policy: 'local-development' }],
      }),
    );
    return file;
  }

  it('reports a configured path that is not installed as missing, not as the discovered binary', async () => {
    const bin = scratch();
    const discovered = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0', login: 'in' }));
    const config = configWith(scratch(), path.join(scratch(), 'not-installed', 'codex'));

    const result = await invoke(['doctor', '--agents', config, '--codex-path', discovered, '--state-dir', path.join(scratch(), 'state'), '--json']);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    const configured = (jsonDocument(result)['config'] as { runtimes: Array<Record<string, unknown>> }).runtimes[0]!;
    expect(configured['readiness']).toBe('missing');
    expect(configured['version']).toBeNull();
    expect(configured['probedConfiguredPath']).toBe(true);
    // The discovered runtime is still reported on its own; it is just not this runtime's readiness.
    expect(runtimes(jsonDocument(result))[0]!.readiness).toBe('controllable');
  });

  it('probes the configured binary itself, so its version and capabilities are the ones reported', async () => {
    const configuredDir = scratch();
    const configured = writeExecutable(configuredDir, 'codex', fakeCodex({ version: '9.9.9', login: 'out' }));
    const discovered = writeExecutable(scratch(), 'codex', fakeCodex({ version: '0.147.0', login: 'in' }));
    const config = configWith(scratch(), configured);

    const result = await invoke(['doctor', '--agents', config, '--codex-path', discovered, '--state-dir', path.join(scratch(), 'state'), '--json']);

    const doc = jsonDocument(result);
    const runtime = (doc['config'] as { runtimes: Array<Record<string, unknown>> }).runtimes[0]!;
    expect(runtime['version']).toBe('9.9.9');
    expect(runtime['auth']).toBe('logged_out');
    expect(runtime['probedExecutable']).toBe(configured);
    // 0.147.0's verified capabilities are not carried over to an unprobed version.
    const capabilities = runtime['capabilities'] as Record<string, { status: string; source: string }>;
    expect(Object.values(capabilities).every((entry) => entry.source !== 'override')).toBe(true);
    expect(runtimes(doc)[0]!.version).toBe('0.147.0');
  });

  it('leaves a bare command name to PATH and says so rather than probing a guessed path', async () => {
    const bin = scratch();
    const discovered = writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0' }));
    const config = configWith(scratch(), 'codex');

    const result = await invoke(['doctor', '--agents', config, '--codex-path', discovered, '--state-dir', path.join(scratch(), 'state')]);

    expect(result.stdout).toContain('is resolved through PATH at spawn time');
  });
});

describe('doctor argument handling', () => {
  it('exits 2 for an empty runtime path and for an unknown flag, and never for a missing runtime', async () => {
    const empty = await invoke(['doctor', '--codex-path', '  ']);
    expect(empty.code).toBe(EXIT_CODES.invalidInput);
    expect(empty.stderr).toContain('--codex-path needs a path');

    expect((await invoke(['doctor', '--codex-paths', '/x'])).code).toBe(EXIT_CODES.invalidInput);
    expect((await invoke(['doctor', 'extra-positional', '--codex-path', '/definitely/not/here', '--claude-path', '/definitely/not/here'])).code).toBe(EXIT_CODES.verifiedCandidate);
  });

  it('rejects an invalid agent configuration before probing anything', async () => {
    const root = scratch();
    const badConfig = path.join(root, 'agents.json');
    writeExecutable(root, 'unused', '#!/bin/sh\nexit 0\n');
    rmSync(path.join(root, 'unused'));
    writeFileSync(badConfig, JSON.stringify({ schemaVersion: 1, runtimes: {}, defaults: {}, agents: [] }));

    const result = await invoke(['doctor', '--agents', badConfig]);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stdout).toBe('');
  });
});
