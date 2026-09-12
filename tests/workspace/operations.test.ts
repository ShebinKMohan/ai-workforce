import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyWorkspace, validateWorkspace, workspaceReadiness } from '../../src/core/workspace-config.js';
import {
  addAgent,
  addDepartment,
  addProject,
  archiveAgent,
  assignAgent,
  editProject,
  importV1,
  parseWorkspaceOps,
  removeDepartment,
  removeProject,
} from '../../src/workspace/operations.js';
import { build, refusal, sampleWorkspace } from './helpers.js';

const EXAMPLE_V1 = path.resolve('fixtures/agents/example.json');

describe('import from a v1 agents.json', () => {
  it('creates one department, makes the analysis planner its head and places nobody on a project', () => {
    const before = readFileSync(EXAMPLE_V1, 'utf8');
    const withProject = build([{ op: 'project.add', repoPath: '/repos/app' }]);
    const imported = importV1(withProject, { config: JSON.parse(before) });

    expect(validateWorkspace(imported).ok).toBe(true);
    expect(imported.departments).toHaveLength(1);
    const department = imported.departments[0]!;
    expect(department).toMatchObject({ id: 'engineering', name: 'Engineering', headAgentId: 'architect' });
    expect(Object.keys(imported.runtimes).sort()).toEqual(['claude-local', 'codex-local']);
    expect(imported.agents.map((a) => [a.id, a.role, a.projectIds])).toEqual([
      ['engineer', 'worker', []],
      ['architect', 'head', []],
      ['reviewer', 'worker', []],
    ]);
    // Because nobody is on the project, the department cannot receive work there yet.
    const pair = workspaceReadiness(imported, { projectCheckCounts: { app: 1 } }).eligibility[0]!;
    expect(pair.codes).toEqual(['no_worker_on_project']);
    // The source file is untouched.
    expect(readFileSync(EXAMPLE_V1, 'utf8')).toBe(before);
  });

  it('never merges into what exists: a second import gets its own department, note and agent ids', () => {
    const v1 = JSON.parse(readFileSync(EXAMPLE_V1, 'utf8'));
    const twice = importV1(importV1(emptyWorkspace(), { config: v1 }), { config: v1 });
    expect(validateWorkspace(twice).ok).toBe(true);
    expect(twice.departments.map((d) => [d.id, d.name, d.note])).toEqual([
      ['engineering', 'Engineering', undefined],
      ['engineering-imported', 'Engineering', 'Imported'],
    ]);
    expect(twice.agents.filter((a) => a.departmentId === 'engineering-imported').map((a) => a.id)).toEqual(['engineer-2', 'architect-2', 'reviewer-2']);
    expect(twice.agents.every((a) => a.projectIds.length === 0)).toBe(true);
  });

  it('refuses an invalid agents file with every issue, exit 2', () => {
    const error = refusal(() => importV1(emptyWorkspace(), { config: { schemaVersion: 1, runtimes: {}, agents: [] } }));
    expect(error.exitCode).toBe(2);
    expect(error.code).toBe('invalid_agents_file');
    expect(error.details.length).toBeGreaterThan(0);
  });
});

describe('ids are never reused', () => {
  it('gives a folder added after a removal a new id, and refuses the retired id explicitly', () => {
    const first = addProject(emptyWorkspace(), { repoPath: '/repos/one/checkout' });
    expect(first.projects[0]!.id).toBe('checkout');
    const removed = removeProject(first, 'checkout');
    expect(removed.retiredIds.projects).toEqual(['checkout']);
    const again = addProject(removed, { repoPath: '/repos/two/checkout' });
    expect(again.projects[0]!.id).toBe('checkout-2');

    const error = refusal(() => addProject(removed, { repoPath: '/repos/three/checkout', id: 'checkout' }));
    expect([error.exitCode, error.code]).toEqual([2, 'id_retired']);
  });
});

describe('projects', () => {
  it('refuses to change a project folder, leaving the document as it was', () => {
    const config = addProject(emptyWorkspace(), { repoPath: '/repos/app' });
    const snapshot = structuredClone(config);
    const error = refusal(() => editProject(config, { id: 'app', repoPath: '/repos/other' }));
    expect([error.exitCode, error.code]).toEqual([2, 'path_immutable']);
    expect(config).toEqual(snapshot);
  });

  it('refuses the same repository twice and a folder that overlaps the state root', () => {
    const config = addProject(emptyWorkspace(), { repoPath: '/repos/app' });
    expect(refusal(() => addProject(config, { repoPath: '/repos/app/' })).code).toBe('duplicate_project_path');
    expect(refusal(() => addProject(config, { repoPath: '/home/me' }, { stateRoot: '/home/me/.workforce' })).code).toBe('project_overlaps_state_root');
    expect(refusal(() => addProject(config, { repoPath: '/home/me/.workforce/projects/x' }, { stateRoot: '/home/me/.workforce' })).code).toBe('project_overlaps_state_root');
    expect(refusal(() => addProject(config, { repoPath: 'relative' })).code).toBe('invalid_repo_path');
  });

  it('refuses to remove a project with a run in progress (exit 3); otherwise takes every worker off it', () => {
    const config = sampleWorkspace();
    const busy = refusal(() => removeProject(config, 'checkout', { projectHasLiveRun: (id) => id === 'checkout' }));
    expect([busy.exitCode, busy.code]).toEqual([3, 'project_in_use']);

    const removed = removeProject(config, 'checkout', { projectHasLiveRun: () => false });
    expect(validateWorkspace(removed).ok).toBe(true);
    expect(removed.agents.find((a) => a.id === 'probe')!.projectIds).toEqual(['billing']);
    expect(removed.agents.find((a) => a.id === 'nova')!.projectIds).toEqual([]);
  });
});

describe('departments and heads', () => {
  it('lets department names repeat only with a different note', () => {
    const one = addDepartment(emptyWorkspace(), { name: 'Engineering' });
    const two = addDepartment(one, { name: 'Engineering', note: 'Payments' });
    expect(two.departments.map((d) => d.id)).toEqual(['engineering', 'engineering-payments']);
    expect(refusal(() => addDepartment(two, { name: 'engineering ' })).code).toBe('ambiguous_department_name');
    // Colours are handed out so that two departments do not look alike.
    expect(new Set(two.departments.map((d) => d.color)).size).toBe(2);
  });

  it('keeps a head read-only, off projects, and alone in its department', () => {
    const base = build([
      { op: 'project.add', repoPath: '/repos/app' },
      { op: 'department.add', name: 'Engineering' },
    ]);
    const input = { role: 'head', departmentId: 'engineering', runtime: 'codex-local' } as const;
    const withRuntime = build([{ op: 'runtime.set', id: 'codex-local', adapter: 'codex', executable: 'codex' }], base);

    expect(refusal(() => addAgent(withRuntime, { ...input, policy: 'local-development' })).code).toBe('head_not_read_only');
    expect(refusal(() => addAgent(withRuntime, { ...input, projectIds: ['app'] })).code).toBe('head_has_projects');
    expect(refusal(() => addAgent(base, input)).code).toBe('unknown_runtime');

    const headed = addAgent(withRuntime, { ...input, id: 'atlas' });
    expect(headed.departments[0]!.headAgentId).toBe('atlas');
    expect(headed.agents[0]!.policy).toBe('analysis');
    expect(refusal(() => addAgent(headed, { ...input, id: 'second' })).code).toBe('department_has_head');
    expect(refusal(() => assignAgent(headed, 'atlas', 'app')).code).toBe('head_has_projects');

    // Archiving the head frees the department for a new one; the old head's history is kept.
    const archived = archiveAgent(headed, 'atlas');
    expect(archived.departments[0]!.headAgentId).toBeNull();
    const replaced = addAgent(archived, { ...input, id: 'vera' });
    expect(replaced.departments[0]!.headAgentId).toBe('vera');
    expect(validateWorkspace(replaced).ok).toBe(true);
  });

  it('refuses to remove a department that still has agents; removing it later retires its archived agents', () => {
    const config = sampleWorkspace();
    const error = refusal(() => removeDepartment(config, 'engineering-payments'));
    expect([error.exitCode, error.code]).toEqual([2, 'department_has_agents']);

    const emptied = archiveAgent(archiveAgent(config, 'iris'), 'probe');
    const removed = removeDepartment(emptied, 'engineering-payments');
    expect(validateWorkspace(removed).ok).toBe(true);
    expect(removed.agents.some((a) => a.departmentId === 'engineering-payments')).toBe(false);
    expect(removed.retiredIds.agents.sort()).toEqual(['iris', 'old', 'probe']);
    expect(removed.retiredIds.departments).toEqual(['engineering-payments']);
  });
});

describe('ops as a request body', () => {
  it('refuses an unknown op or an unknown field before anything is applied', () => {
    expect(refusal(() => parseWorkspaceOps([{ op: 'project.delete', id: 'x' }])).code).toBe('invalid_ops');
    expect(refusal(() => parseWorkspaceOps([{ op: 'agent.assign', agentId: 'a', projectId: 'p', force: true }])).code).toBe('invalid_ops');
    expect(refusal(() => parseWorkspaceOps([])).code).toBe('invalid_ops');
  });

  it('adds the standard runtime a new agent names, so "codex-local" needs no separate step', () => {
    const config = build([
      { op: 'department.add', name: 'Engineering' },
      { op: 'agent.add', role: 'head', departmentId: 'engineering', runtime: 'codex-local', name: 'Atlas' },
    ]);
    expect(config.runtimes['codex-local']).toEqual({ adapter: 'codex', executable: 'codex' });
    expect(config.agents[0]!.id).toBe('atlas');
  });
});
