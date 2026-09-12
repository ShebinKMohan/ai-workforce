import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFakeRuntimeScript } from '../../src/adapters/index.js';
import { parseCliArgs } from '../../src/cli/index.js';
import { commandRun, type RunCommandArgs } from '../../src/cli/commands/run.js';
import { Reporter } from '../../src/cli/output.js';
import type { HeadPlanner, HeadPlanningInput } from '../../src/workspace/planning.js';
import { buildRoster, rosterAgentConfig, writeRosterSnapshot } from '../../src/workspace/roster.js';
import { projectStatePaths } from '../../src/workspace/paths.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { build, cleanupAll, gitRepo, invoke, jsonOf, refusal, sink, tempDir } from './helpers.js';

afterEach(cleanupAll);

function setup(stateRoot: string, repoPath: string) {
  updateWorkspace(stateRoot, current => build([
    { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
    { op: 'project.add', id: 'app', repoPath, checks: ['node --version'] },
    { op: 'project.add', id: 'other', repoPath: path.join(repoPath, 'other') },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'department.add', id: 'design', name: 'Design' },
    { op: 'agent.add', id: 'head', departmentId: 'eng', role: 'head', runtime: 'fake-local' },
    { op: 'agent.add', id: 'busy', departmentId: 'eng', role: 'worker', runtime: 'fake-local', projectIds: ['app', 'other'] },
    { op: 'agent.add', id: 'free', departmentId: 'eng', role: 'worker', runtime: 'fake-local', projectIds: ['app'] },
    { op: 'agent.add', id: 'bench', departmentId: 'eng', role: 'worker', runtime: 'fake-local' },
    { op: 'agent.add', id: 'elsewhere', departmentId: 'design', role: 'worker', runtime: 'fake-local', projectIds: ['app'] },
  ], current), { createIfMissing: true });
  return loadWorkspace(stateRoot).config;
}

function run(stateRoot: string, headPlanner: HeadPlanner, extra: Partial<RunCommandArgs> = {}) {
  const streams = { stdout: sink(() => {}), stderr: sink(() => {}) };
  return commandRun({ project: 'app', department: 'eng', task: 'Inspect the candidate.', stateDir: stateRoot, allowUnconfinedWrites: true, json: true, ...extra }, { reporter: new Reporter(true, streams), streams, headPlanner });
}

describe('admitted worker pool', () => {
  it('keeps the exact selected free worker and excludes other eligible workers from planning and fallback configuration', () => {
    const config = setup(tempDir(), '/repos/admission');
    const roster = buildRoster(config, { projectId: 'app', departmentId: 'eng', workerIds: ['free'] });
    expect(roster.workers.map(worker => worker.id)).toEqual(['free']);
    const recorded = rosterAgentConfig(config, roster);
    expect(recorded.agents.map(agent => agent.id)).toEqual(['head', 'free']);
    expect(recorded.defaults.workerAgent).toBe('free');
    expect(buildRoster(config, { projectId: 'app', departmentId: 'eng' }).workers.map(worker => worker.id)).toEqual(['busy', 'free']);
  });

  it('refuses empty, duplicate, foreign, head, archived, and unassigned workers instead of expanding or substituting the pool', () => {
    const config = setup(tempDir(), '/repos/admission');
    for (const workerIds of [[], ['free', 'free']]) expect(refusal(() => buildRoster(config, { projectId: 'app', departmentId: 'eng', workerIds })).code).toBe('invalid_worker_selection');
    for (const workerIds of [['head'], ['bench'], ['elsewhere'], ['missing']]) expect(refusal(() => buildRoster(config, { projectId: 'app', departmentId: 'eng', workerIds })).code).toBe('worker_not_eligible');
    const archived = build([{ op: 'agent.archive', id: 'free' }], config);
    expect(refusal(() => buildRoster(archived, { projectId: 'app', departmentId: 'eng', workerIds: ['free'] })).code).toBe('worker_not_eligible');
  });

  it('freezes the admitted subset for resume even after the current workspace gains another worker', () => {
    const stateRoot = tempDir();
    const config = setup(stateRoot, '/repos/admission');
    const roster = buildRoster(config, { projectId: 'app', departmentId: 'eng', workerIds: ['free'] });
    const snapshot = writeRosterSnapshot(projectStatePaths(stateRoot, 'app'), roster, rosterAgentConfig(config, roster));
    updateWorkspace(stateRoot, current => build([{ op: 'agent.add', id: 'new-worker', departmentId: 'eng', role: 'worker', runtime: 'fake-local', projectIds: ['app'] }], current));
    expect(buildRoster(loadWorkspace(stateRoot).config, { projectId: 'app', departmentId: 'eng' }).workers.map(worker => worker.id)).toEqual(['busy', 'free', 'new-worker']);
    const saved = JSON.parse(readFileSync(snapshot.path, 'utf8')) as { agents: Array<{ id: string }> };
    expect(saved.agents.map(agent => agent.id)).toEqual(['head', 'free']);
  });

  it('passes only admitted workers to the head and rejects a plan that reaches outside them', async () => {
    const stateRoot = tempDir();
    const repo = await gitRepo({ 'README.md': 'admission test\n' });
    const config = setup(stateRoot, repo);
    let seen: HeadPlanningInput | null = null;
    const planner: HeadPlanner = async input => {
      seen = input;
      return { ok: true, summary: 'Attempt to expand the admitted pool', tasks: [{ key: 'outside', objective: 'Should never run', agentId: 'busy' }] };
    };
    await expect(run(stateRoot, planner, { workerIds: ['free'], workspaceRevision: config.revision })).rejects.toMatchObject({ code: 'plan_rejected' });
    expect((seen as HeadPlanningInput | null)?.roster.workers.map(worker => worker.id)).toEqual(['free']);
    expect((seen as HeadPlanningInput | null)?.snapshot.config.agents.map(agent => agent.id)).toEqual(['head', 'free']);
    expect(readdirSync(path.join(stateRoot, 'projects', 'app', 'runs'))).toEqual([]);
  });

  it('refuses a workspace edit between queue reservation and CLI startup before any planning or execution state', async () => {
    const stateRoot = tempDir();
    const config = setup(stateRoot, '/repos/does-not-need-to-exist');
    updateWorkspace(stateRoot, current => build([{ op: 'agent.edit', id: 'free', name: 'Edited after reservation' }], current));
    const planner = vi.fn<HeadPlanner>();
    await expect(run(stateRoot, planner, { workerIds: ['free'], workspaceRevision: config.revision })).rejects.toMatchObject({ exitCode: 3, code: 'admission_workspace_changed' });
    expect(planner).not.toHaveBeenCalled();
    expect(existsSync(path.join(stateRoot, 'projects'))).toBe(false);
    const cli = await invoke(['run', '--project=app', '--department=eng', '--task=Work', '--worker=free', `--workspace-revision=${config.revision}`, `--state-dir=${stateRoot}`, '--json']);
    expect(cli.code).toBe(3);
    expect(jsonOf(cli)).toMatchObject({ error: { code: 'admission_workspace_changed' } });
    expect(existsSync(path.join(stateRoot, 'projects'))).toBe(false);
  });

  it('parses repeated worker reservations in order and rejects ignored or malformed launch guards', () => {
    const base = ['run', '--project=app', '--department=eng', '--task=Work'];
    expect(parseCliArgs([...base, '--worker=second', '--worker=first', '--workspace-revision=42'])).toMatchObject({ workerIds: ['second', 'first'], workspaceRevision: 42 });
    for (const revision of ['-1', '1.5', 'NaN', '9007199254740992']) expect(() => parseCliArgs([...base, `--workspace-revision=${revision}`])).toThrow(/safe integer/);
    for (const command of [['doctor'], ['workspace', 'show'], ['run', '--repo=/repos/example', '--task=Work']]) expect(() => parseCliArgs([...command, '--worker=free'])).toThrow(/workforce run --project/);
  });
});
