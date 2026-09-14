import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandWorkspace } from '../../src/cli/commands/workspace.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import type { ToolFact } from '../../src/core/workspace-config.js';
import { loadWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, gitRepo, invoke, jsonOf, tempDir } from './helpers.js';

afterEach(() => { cleanupAll(); vi.unstubAllEnvs(); });

const BOTH_TOOLS: ToolFact[] = [
  { adapter: 'codex', installed: true, adapterSupported: true, auth: 'logged_in' },
  { adapter: 'claude-code', installed: true, adapterSupported: true, auth: 'logged_in' },
];

async function ws(stateRoot: string, ...argv: string[]) {
  return invoke(['workspace', ...argv, '--state-dir', stateRoot, '--json']);
}

async function show(stateRoot: string) {
  return commandWorkspace({ positionals: ['show'], json: true, stateDir: stateRoot }, { discover: async () => BOTH_TOOLS });
}

describe('workforce workspace', () => {
  it('removes only unused runtime bindings and leaves refused changes unwritten', async () => {
    const stateRoot = tempDir();
    expect((await ws(stateRoot, 'runtime', 'set', 'codex-desktop', '--adapter', 'codex', '--executable', '/Applications/Codex.app/codex')).code).toBe(0);
    expect((await ws(stateRoot, 'runtime', 'remove', 'codex-desktop')).code).toBe(0);
    expect(loadWorkspace(stateRoot).config.runtimes).toEqual({});
    await ws(stateRoot, 'department', 'add', '--name', 'Engineering');
    await ws(stateRoot, 'agent', 'add', '--department', 'engineering', '--role', 'head', '--runtime', 'codex', '--name', 'Atlas');
    const before = readFileSync(path.join(stateRoot, 'workspace.json'), 'utf8');
    const refused = await ws(stateRoot, 'runtime', 'remove', 'codex-local');
    expect([refused.code, (jsonOf(refused)['error'] as { code: string }).code]).toEqual([2, 'runtime_in_use']);
    expect(readFileSync(path.join(stateRoot, 'workspace.json'), 'utf8')).toBe(before);
  });

  it('accepts a quoted ~/ project folder without relying on shell expansion', async () => {
    const stateRoot = tempDir();
    const repo = await gitRepo({ 'README.md': 'home-relative project\n' });
    vi.stubEnv('HOME', path.dirname(repo));
    const result = await ws(stateRoot, 'project', 'add', `~/${path.basename(repo)}`, '--name', 'Home project');
    expect(result.code).toBe(0);
    expect(loadWorkspace(stateRoot).config.projects).toMatchObject([{ repoPath: repo, name: 'Home project' }]);
  });

  it('shows an empty workspace without creating a file', async () => {
    const stateRoot = tempDir();
    const result = await show(stateRoot);
    expect(result.data).toMatchObject({ exists: false, revision: 0 });
    expect((result.data['readiness'] as { empty: boolean }).empty).toBe(true);
    expect(result.lines.join('\n')).toMatch(/ready to send: nothing yet/);
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  it('builds a workspace from nothing, one revision per change, until a request can be sent', async () => {
    const stateRoot = tempDir();
    const repo = await gitRepo({ 'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'node -e 0' } }) });
    const steps: string[][] = [
      ['init'],
      ['project', 'add', repo, '--name', 'Shop'],
      ['department', 'add', '--name', 'Engineering'],
      ['agent', 'add', '--department', 'engineering', '--role', 'head', '--runtime', 'codex', '--name', 'Atlas'],
      ['agent', 'add', '--department', 'engineering', '--role', 'worker', '--runtime', 'claude-code', '--name', 'Nova'],
      ['assign', 'nova', 'shop'],
    ];
    for (const [index, step] of steps.entries()) {
      const result = await ws(stateRoot, ...step);
      expect({ step, code: result.code }).toEqual({ step, code: EXIT_CODES.verifiedCandidate });
      expect(jsonOf(result)).toMatchObject({ revision: index + 1, written: true });
    }

    const config = loadWorkspace(stateRoot).config;
    expect(config.projects).toMatchObject([{ id: 'shop', name: 'Shop', repoPath: repo }]);
    expect(config.runtimes).toEqual({ 'codex-local': { adapter: 'codex', executable: 'codex' }, 'claude-local': { adapter: 'claude-code', executable: 'claude' } });
    expect(config.departments[0]!.headAgentId).toBe('atlas');
    expect(config.agents.map((a) => [a.id, a.role, a.policy, a.projectIds])).toEqual([
      ['atlas', 'head', 'analysis', []],
      ['nova', 'worker', 'local-development', ['shop']],
    ]);

    const ready = await show(stateRoot);
    const readiness = ready.data['readiness'] as { steps: Array<{ id: string; state: string }>; eligibility: Array<{ sendable: boolean }> };
    expect(readiness.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(readiness.eligibility).toMatchObject([{ sendable: true }]);
    expect(ready.lines.join('\n')).toContain('workforce run --project shop --department engineering');

    // Taking the only worker off the project makes the department unable to receive work there.
    expect((await ws(stateRoot, 'unassign', 'nova', 'shop')).code).toBe(0);
    const unready = await show(stateRoot);
    expect((unready.data['readiness'] as { eligibility: Array<{ codes: string[] }> }).eligibility[0]!.codes).toEqual(['no_worker_on_project']);
  });

  it('refuses invalid input with exit 2 and a revision conflict with exit 3, writing nothing either way', async () => {
    const stateRoot = tempDir();
    const repo = await gitRepo({ 'README.md': 'x\n' });
    await ws(stateRoot, 'init');
    await ws(stateRoot, 'project', 'add', repo, '--id', 'app');
    const file = path.join(stateRoot, 'workspace.json');
    const before = readFileSync(file, 'utf8');

    const refusals: Array<[string[], number, string]> = [
      [['agent', 'add', '--department', 'x', '--role', 'boss', '--runtime', 'codex'], 2, 'invalid_role'],
      [['department', 'add'], 2, 'invalid_workspace_command'],
      [['project', 'edit', 'app', '--repo', '/somewhere/else'], 2, 'path_immutable'],
      [['project', 'add', tempDir('workforce-ws-plain-')], 2, 'not_a_git_repository'],
      [['project', 'add', repo], 2, 'duplicate_project_path'],
      [['assign', 'nobody', 'app'], 2, 'unknown_agent'],
      [['department', 'add', '--name', 'Eng', '--expect-revision', 'two'], 2, 'invalid_expect_revision'],
      [['department', 'add', '--name', 'Eng', '--expect-revision', '1'], 3, 'workspace_revision_conflict'],
      [['frobnicate'], 2, 'invalid_workspace_command'],
    ];
    for (const [argv, exit, code] of refusals) {
      const result = await ws(stateRoot, ...argv);
      expect({ argv, exit: result.code, code: (jsonOf(result)['error'] as { code: string }).code }).toEqual({ argv, exit, code });
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes a project from the workspace without touching its folder, and retires the id', async () => {
    const stateRoot = tempDir();
    const repo = await gitRepo({ 'README.md': 'keep me\n' });
    await ws(stateRoot, 'project', 'add', repo, '--id', 'app');
    const removed = await ws(stateRoot, 'project', 'remove', 'app');
    expect(removed.code).toBe(0);
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('keep me\n');
    expect(existsSync(path.join(repo, '.git'))).toBe(true);
    expect(loadWorkspace(stateRoot).config.retiredIds.projects).toEqual(['app']);
    const readd = await ws(stateRoot, 'project', 'add', repo, '--id', 'app');
    expect([readd.code, (jsonOf(readd)['error'] as { code: string }).code]).toEqual([2, 'id_retired']);
  });

  it('imports a v1 agents.json with nobody placed on a project', async () => {
    const stateRoot = tempDir();
    const result = await ws(stateRoot, 'import', '--agents', path.resolve('fixtures/agents/example.json'));
    expect(result.code).toBe(0);
    expect(jsonOf(result)['created']).toMatchObject({ departments: ['engineering'], agents: ['engineer', 'architect', 'reviewer'] });
    expect(loadWorkspace(stateRoot).config.agents.every((agent) => agent.projectIds.length === 0)).toBe(true);
  });

  it('keeps the workspace flags on workspace, and --project/--department on run and workspace', async () => {
    const onRun = await invoke(['run', '--name', 'x', '--task', 'y']);
    expect(onRun.code).toBe(EXIT_CODES.invalidInput);
    expect(onRun.stderr).toMatch(/--name applies only to "workforce workspace"/);
    const onStatus = await invoke(['status', 'some-run', '--project', 'app']);
    expect(onStatus.code).toBe(EXIT_CODES.invalidInput);
    expect(onStatus.stderr).toMatch(/--project applies only to "workforce run" and "workforce workspace"/);
    const help = await invoke(['--help']);
    expect(help.stdout).toContain('workforce run --project <id> --department <id>');
    expect(help.stdout).toContain('workforce workspace project add <folder>');
  });
});
