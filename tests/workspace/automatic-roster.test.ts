import { describe, expect, it } from 'vitest';
import { activeHead, eligibleWorkers, validateWorkspace, workspaceReadiness } from '../../src/core/workspace-config.js';
import { buildRoster, rosterAgentConfig } from '../../src/workspace/roster.js';
import { build, refusal } from './helpers.js';

function workforce() {
  return build([
    { op: 'project.add', id: 'existing', repoPath: '/repos/existing', checks: ['npm test'] },
    { op: 'department.add', id: 'engineering', name: 'Engineering' },
    { op: 'agent.add', id: 'head', role: 'head', departmentId: 'engineering', runtime: 'codex-local' },
    { op: 'agent.add', id: 'frontend', role: 'worker', departmentId: 'engineering', runtime: 'codex-local', capabilities: ['frontend', 'accessibility'], projectIds: [] },
    // Existing schema-v2 placement lists were setup metadata, not an explicit scope restriction.
    { op: 'agent.add', id: 'backend', role: 'worker', departmentId: 'engineering', runtime: 'codex-local', capabilities: ['backend', 'databases'], projectIds: ['existing'] },
  ]);
}

describe('automatic project eligibility', () => {
  it('makes the existing workforce immediately eligible for a new project without altering its agents or bindings', () => {
    const before = workforce();
    const originalAgents = structuredClone(before.agents);
    const registered = build([{ op: 'project.add', id: 'new-project', repoPath: '/repos/new-project', checks: ['npm test'] }], before);
    const parsed = validateWorkspace(registered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('valid automatic workspace expected');
    expect(parsed.config.agents).toEqual(originalAgents);
    expect(parsed.config.runtimes).toEqual(before.runtimes);
    for (const projectId of ['existing', 'new-project']) {
      const roster = buildRoster(parsed.config, { projectId, departmentId: 'engineering' });
      expect(roster.workers.map(worker => worker.id)).toEqual(['frontend', 'backend']);
      expect(roster.workers.map(worker => worker.capabilities)).toEqual([['frontend', 'accessibility'], ['backend', 'databases']]);
      expect(workspaceReadiness(parsed.config).eligibility.find(pair => pair.projectId === projectId)).toMatchObject({ sendable: true, workerIds: ['frontend', 'backend'] });
    }
    expect(before.projects.map(project => project.id)).toEqual(['existing']);
  });

  it('honors explicit restricted and empty scopes, and can restore automatic access with one edit', () => {
    const registered = build([{ op: 'project.add', id: 'new-project', repoPath: '/repos/new-project', checks: ['npm test'] }], workforce());
    const restricted = build([
      { op: 'agent.edit', id: 'frontend', projectScope: 'restricted', projectIds: ['existing'] },
      { op: 'agent.edit', id: 'backend', projectScope: 'restricted', projectIds: [] },
    ], registered);
    expect(eligibleWorkers(restricted, 'engineering', 'existing').map(worker => worker.id)).toEqual(['frontend']);
    expect(eligibleWorkers(restricted, 'engineering', 'new-project')).toEqual([]);
    expect(refusal(() => buildRoster(restricted, { projectId: 'new-project', departmentId: 'engineering' })).code).toBe('no_worker_on_project');
    const restored = build([{ op: 'agent.edit', id: 'frontend', projectScope: 'all' }], restricted);
    expect(buildRoster(restored, { projectId: 'new-project', departmentId: 'engineering' }).workers.map(worker => worker.id)).toEqual(['frontend']);
    expect(restored.agents.find(agent => agent.id === 'frontend')?.projectIds).toEqual(['existing']);
  });

  it('never treats unknown, archived projects, archived departments, or archived agents as available', () => {
    const before = workforce();
    expect(eligibleWorkers(before, 'engineering', 'unknown')).toEqual([]);
    expect(eligibleWorkers(before, 'unknown', 'existing')).toEqual([]);
    const archivedWorker = build([{ op: 'agent.archive', id: 'frontend' }], before);
    expect(eligibleWorkers(archivedWorker, 'engineering', 'existing').map(worker => worker.id)).toEqual(['backend']);
    const archivedProject = build([{ op: 'project.archive', id: 'existing' }], before);
    expect(eligibleWorkers(archivedProject, 'engineering', 'existing')).toEqual([]);
    const archivedDepartment = build([{ op: 'department.archive', id: 'engineering' }], before);
    expect(eligibleWorkers(archivedDepartment, 'engineering', 'existing')).toEqual([]);
    expect(activeHead(archivedDepartment, 'engineering')).toBeNull();
  });

  it('keeps an admitted worker pool exact and freezes specialty and policy despite automatic project scope', () => {
    const config = workforce();
    const roster = buildRoster(config, { projectId: 'existing', departmentId: 'engineering', workerIds: ['backend'] });
    const snapshot = rosterAgentConfig(config, roster);
    expect(snapshot.agents.map(agent => agent.id)).toEqual(['head', 'backend']);
    expect(snapshot.agents[1]).toMatchObject({ policy: 'local-development', capabilities: ['backend', 'databases'] });
    expect(snapshot.agents[0]?.policy).toBe('analysis');
    expect(snapshot.defaults.maxActiveTurns).toBe(1);
    expect(snapshot.defaults.maxActiveWriters).toBe(1);
    expect(refusal(() => buildRoster(config, { projectId: 'existing', departmentId: 'engineering', workerIds: [] })).code).toBe('invalid_worker_selection');
  });

  it('makes legacy explicit assignment operations restrict scope without silently regaining omitted projects', () => {
    const registered = build([{ op: 'project.add', id: 'new-project', repoPath: '/repos/new-project' }], workforce());
    const assigned = build([{ op: 'agent.assign', agentId: 'frontend', projectId: 'existing' }], registered);
    expect(assigned.agents.find(agent => agent.id === 'frontend')).toMatchObject({ projectScope: 'restricted', projectIds: ['existing'] });
    const unassigned = build([{ op: 'agent.unassign', agentId: 'backend', projectId: 'existing' }], registered);
    expect(unassigned.agents.find(agent => agent.id === 'backend')).toMatchObject({ projectScope: 'restricted', projectIds: ['new-project'] });
    const future = build([{ op: 'project.add', id: 'future', repoPath: '/repos/future' }], unassigned);
    expect(eligibleWorkers(future, 'engineering', 'future').map(worker => worker.id)).toEqual(['frontend']);
  });

  it('validates explicit scope edits at the same boundary as normal configuration changes', () => {
    const config = workforce();
    expect(refusal(() => build([{ op: 'agent.edit', id: 'frontend', projectScope: 'everything' }], config)).code).toBe('invalid_ops');
    expect(refusal(() => build([{ op: 'agent.edit', id: 'frontend', projectScope: 'restricted', projectIds: ['unknown'] }], config)).code).toBe('unknown_project');
    expect(refusal(() => build([{ op: 'agent.edit', id: 'head', projectScope: 'restricted' }], config)).code).toBe('head_has_project_scope');
    expect(validateWorkspace({ ...config, agents: config.agents.map(agent => agent.id === 'head' ? { ...agent, projectScope: 'restricted' } : agent) }).ok).toBe(false);
  });
});
