/** AT01 — `workforce doctor`: informational exit 0, exit 2 only for bad arguments, and no invocation that could start a model turn. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
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
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badConfig, JSON.stringify({ schemaVersion: 1, runtimes: {}, defaults: {}, agents: [] }));

    const result = await invoke(['doctor', '--agents', badConfig]);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stdout).toBe('');
  });
});
