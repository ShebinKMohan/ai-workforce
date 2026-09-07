import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { EXIT_CODES } from '../src/cli/output.js';
import { appendEvent } from '../src/storage/events.js';
import { insertRun } from '../src/storage/records.js';
import { openTempState, sampleRequest, TEST_LIMITS, tempDir } from './helpers/state.js';

const EXAMPLE = path.resolve('fixtures/agents/example.json');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir('workforce-cli-');
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
  expect(lines).toHaveLength(1); // --json: exactly one machine-readable document on stdout
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('cli argument handling and exit codes', () => {
  it('exits 2 for a missing command, unknown command or unknown flag, with usage on stderr only', async () => {
    for (const argv of [[], ['frobnicate'], ['doctor', '--bogus']]) {
      const result = await invoke(argv);
      expect(result.code).toBe(EXIT_CODES.invalidInput);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/error: /);
    }
    expect((await invoke([])).stderr).toContain('Usage:');
    expect((await invoke(['--help'])).code).toBe(EXIT_CODES.verifiedCandidate);
    expect((await invoke(['--help'])).stdout).toContain('Exit codes: 0 verified candidate');
  });

  it('requires --repo, --agents and exactly one task source for run', async () => {
    const repo = scratch();
    expect((await invoke(['run', '--agents', EXAMPLE, '--task', 'x'])).stderr).toMatch(/--repo <path> is required/);
    expect((await invoke(['run', '--repo', repo, '--task', 'x'])).stderr).toMatch(/--agents <file> is required/);
    const both = await invoke(['run', '--repo', repo, '--agents', EXAMPLE, '--task', 'x', '--task-file', path.join(repo, 'brief.md')]);
    expect(both.code).toBe(EXIT_CODES.invalidInput);
    expect(both.stderr).toMatch(/either --task or --task-file/);
    const neither = await invoke(['run', '--repo', repo, '--agents', EXAMPLE, '--state-dir', scratch()]);
    expect(neither.code).toBe(EXIT_CODES.invalidInput);
    expect(neither.stderr).toMatch(/one of --task <text> or --task-file <file> is required/);
  });
});

describe('cli configuration validation happens before execution', () => {
  it('rejects an invalid agent configuration with exit 2 and touches no state', async () => {
    const repo = scratch();
    const stateDir = path.join(scratch(), 'state');
    const badConfig = path.join(repo, 'agents.json');
    writeFileSync(
      badConfig,
      JSON.stringify({
        schemaVersion: 1,
        runtimes: { 'codex-local': { adapter: 'codex', executable: 'codex' } },
        defaults: { workerAgent: 'engineer', maxActiveTurns: 2, maxActiveWriters: 2, maxTasksPerRun: 8, maxDelegationDepth: 2, maxRepairAttempts: 2, maxTransientRetries: 2, runTimeoutMinutes: 30 },
        agents: [{ id: 'engineer', runtime: 'claude-local', instructions: 'fix', capabilities: [], policy: 'local-development', temperature: 0.1 }],
      }),
    );

    const human = await invoke(['run', '--repo', repo, '--agents', badConfig, '--task', 'fix the bug', '--state-dir', stateDir]);
    expect(human.code).toBe(EXIT_CODES.invalidInput);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('references unknown runtime "claude-local"');
    expect(human.stderr).toContain('unknown field "temperature"');
    expect(existsSync(stateDir)).toBe(false);

    const machine = await invoke(['run', '--repo', repo, '--agents', badConfig, '--task', 'fix the bug', '--state-dir', stateDir, '--json']);
    expect(machine.code).toBe(EXIT_CODES.invalidInput);
    const doc = jsonDocument(machine);
    expect(doc).toMatchObject({ ok: false, command: 'run', exitCode: 2, error: { code: 'invalid_config' } });
    const details = (doc['error'] as { details: string[] }).details;
    expect(details.some((d) => d.includes('unknown runtime "claude-local"'))).toBe(true);
    expect(machine.stderr).toContain('error:'); // diagnostics still go to stderr in --json mode
    expect(existsSync(stateDir)).toBe(false);

    for (const command of [['doctor', '--agents', badConfig], ['resume', 'run-1', '--agents', badConfig]]) {
      expect((await invoke([...command, '--state-dir', stateDir])).code).toBe(EXIT_CODES.invalidInput);
    }
  });

  it('accepts a valid configuration and refuses to run against a directory that is not a Git repository', async () => {
    const repo = scratch();
    const stateDir = path.join(scratch(), 'state');
    const brief = path.join(repo, 'brief.md');
    writeFileSync(brief, 'Fix the login endpoint.\n');

    // The configuration is valid, so the run gets as far as inspecting the
    // repository and then refuses honestly: a scratch directory is not a Git
    // project, and the direct path needs a committed base revision.
    const result = await invoke(['run', '--repo', repo, '--agents', EXAMPLE, '--task-file', brief, '--state-dir', stateDir, '--json']);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    const doc = jsonDocument(result);
    expect(doc).toMatchObject({ ok: false, command: 'run', exitCode: 2, error: { code: 'not_a_git_repository' } });
    expect((doc['error'] as { message: string }).message).toContain('is not a Git repository');
    // The lock is released again whatever happens.
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(false);

    // doctor is informational (WP02): it reports what it found and still exits 0.
    const doctor = await invoke(['doctor', '--agents', EXAMPLE, '--state-dir', stateDir]);
    expect(doctor.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(doctor.stdout).toContain(`state root: ${path.resolve(stateDir)}`);
    expect(doctor.stdout).toContain('agent engineer: runtime claude-local (claude-code via claude)');
  });
});

describe('cli status is read-only', () => {
  it('reports exit 2 when no state exists or the run is unknown, exit 0 for a persisted run, and never takes the lock', async () => {
    const empty = path.join(scratch(), 'nothing-here');
    const missing = await invoke(['status', 'run-x', '--state-dir', empty]);
    expect(missing.code).toBe(EXIT_CODES.invalidInput);
    expect(missing.stderr).toMatch(/no coordinator state/);
    expect(existsSync(empty)).toBe(false);

    const state = openTempState();
    roots.push(state.root);
    const request = { ...sampleRequest(), text: 'Rotate the key: API_TOKEN=abc123secretvalue and Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret' };
    const run = insertRun(state.store.db, { request, policy: 'local-development', limits: TEST_LIMITS });
    appendEvent(state.store.db, { runId: run.id, type: 'run.created', payload: { note: 'seeded' } });
    state.store.close();
    mkdirSync(path.join(state.root, 'runs'), { recursive: true });

    const unknown = await invoke(['status', 'does-not-exist', '--state-dir', state.root]);
    expect(unknown.code).toBe(EXIT_CODES.invalidInput);
    expect(unknown.stderr).toMatch(/not found/);

    const human = await invoke(['status', run.id, '--state-dir', state.root]);
    expect(human.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(human.stdout).toContain(`run ${run.id}: pending`);
    expect(human.stdout).toContain('events: 1 recorded');
    expect(human.stderr).toBe('');

    const machine = await invoke(['status', run.id, '--state-dir', state.root, '--json']);
    expect(machine.code).toBe(EXIT_CODES.verifiedCandidate);
    const doc = jsonDocument(machine);
    expect(doc).toMatchObject({ ok: true, command: 'status', run: { id: run.id, state: 'pending' }, eventCount: 1 });
    // Human-readable output is redacted; the original wording stays intact in the database.
    expect(machine.stdout).not.toContain('abc123secretvalue');
    expect(machine.stdout).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(machine.stdout).toContain('[REDACTED]');
    expect(existsSync(path.join(state.root, 'coordinator.lock'))).toBe(false);
  });
});
