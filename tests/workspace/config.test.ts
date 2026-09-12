import { describe, expect, it } from 'vitest';
import { emptyWorkspace, validateWorkspace, workspaceReadiness, type WorkspaceConfig } from '../../src/core/workspace-config.js';
import { sampleWorkspace } from './helpers.js';

function mutated(edit: (doc: Record<string, any>) => void): unknown {
  const doc = structuredClone(sampleWorkspace()) as unknown as Record<string, any>;
  edit(doc);
  return doc;
}

function codesOf(input: unknown): string[] {
  const result = validateWorkspace(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function issueAt(input: unknown, code: string): { path: string; message: string } {
  const result = validateWorkspace(input);
  if (result.ok) throw new Error(`expected ${code}, but the workspace validated`);
  const issue = result.issues.find((i) => i.code === code);
  if (issue === undefined) throw new Error(`expected ${code}, got ${result.issues.map((i) => i.code).join(', ')}`);
  return issue;
}

const USABLE = { installed: true, adapterSupported: true, auth: 'logged_in' };

describe('workspace schema v2', () => {
  it('accepts an empty workspace, which is what a fresh install starts with', () => {
    const empty = emptyWorkspace();
    expect(empty.revision).toBe(0);
    expect(empty.projects).toEqual([]);
    expect(empty.departments).toEqual([]);
    expect(empty.agents).toEqual([]);
    expect(empty.limits.maxConcurrentProjectRuns).toBe(2);
    expect(validateWorkspace(empty).ok).toBe(true);
    // A hand-written minimal file is valid too: every collection defaults to empty.
    expect(validateWorkspace({ schemaVersion: 2, revision: 1 }).ok).toBe(true);
  });

  it('accepts two departments with the same name when their notes differ, and a department with no head', () => {
    const result = validateWorkspace(sampleWorkspace());
    expect(result.ok).toBe(true);
  });

  it('refuses a malformed document structurally, naming the path', () => {
    expect(issueAt(mutated((d) => (d.projects[0].repoPath = 'relative/path')), 'schema').path).toBe('projects[0].repoPath');
    expect(issueAt(mutated((d) => (d.departments[0].color = 'neon')), 'schema').path).toBe('departments[0].color');
    expect(issueAt(mutated((d) => (d.projects[0].id = 'Not A Slug')), 'schema').path).toBe('projects[0].id');
    expect(issueAt(mutated((d) => (d.agents[0].surprise = true)), 'schema').message).toMatch(/unknown field/);
    expect(codesOf(mutated((d) => (d.schemaVersion = 1)))).toContain('schema');
  });

  it('refuses every broken cross-reference with its own code', () => {
    const cases: Array<[string, (doc: Record<string, any>) => void, string]> = [
      ['duplicate agent id', (d) => (d.agents[1].id = d.agents[0].id), 'duplicate_id'],
      ['duplicate project id', (d) => (d.projects[1].id = d.projects[0].id), 'duplicate_id'],
      ['unknown runtime', (d) => (d.agents[1].runtime = 'gemini-local'), 'unknown_runtime'],
      ['unknown department', (d) => (d.agents[1].departmentId = 'marketing'), 'unknown_department'],
      ['unknown project', (d) => d.agents[1].projectIds.push('ghost'), 'unknown_project'],
      ['same project twice', (d) => d.agents[1].projectIds.push('checkout'), 'duplicate_assignment'],
      ['head that writes', (d) => (d.agents[0].policy = 'local-development'), 'head_not_read_only'],
      ['head on a project', (d) => (d.agents[0].projectIds = ['checkout']), 'head_has_projects'],
      ['a second head', (d) => (d.agents[3].role = 'head') && (d.agents[3].policy = 'analysis'), 'head_not_assigned'],
      ['department names a ghost head', (d) => (d.departments[0].headAgentId = 'nobody'), 'unknown_head'],
      ['department names a worker as head', (d) => (d.departments[0].headAgentId = 'nova'), 'head_not_a_head'],
      ['department names another department\'s head', (d) => (d.departments[0].headAgentId = 'iris'), 'head_in_other_department'],
      ['same name, same note', (d) => (d.departments[1].note = 'Platform'), 'ambiguous_department_name'],
      ['same repository twice', (d) => (d.projects[1].repoPath = `${d.projects[0].repoPath}/`), 'duplicate_project_path'],
      ['a retired id in use', (d) => d.retiredIds.agents.push('nova'), 'retired_id_in_use'],
    ];
    for (const [name, edit, code] of cases) {
      expect({ name, codes: codesOf(mutated(edit)) }).toEqual({ name, codes: expect.arrayContaining([code]) });
    }
  });
});

describe('workspace readiness', () => {
  it('shows an empty workspace as empty, with the tools step first and nothing claimed done', () => {
    const readiness = workspaceReadiness(emptyWorkspace());
    expect(readiness.empty).toBe(true);
    expect(readiness.eligibility).toEqual([]);
    expect(readiness.steps.map((s) => [s.id, s.state])).toEqual([
      ['tools', 'current'],
      ['project', 'locked'],
      ['department', 'locked'],
      ['send', 'locked'],
    ]);
    // Tools that were never checked are not reported ready.
    expect(readiness.steps[0]!.reason).toMatch(/not been checked/);

    const withTools = workspaceReadiness(emptyWorkspace(), { tools: [{ adapter: 'codex', ...USABLE }] });
    expect(withTools.steps.map((s) => [s.id, s.state])).toEqual([
      ['tools', 'done'],
      ['project', 'current'],
      ['department', 'locked'],
      ['send', 'locked'],
    ]);
  });

  it('decides each (department, project) pair from heads, placed workers, checks and tool readiness', () => {
    const config: WorkspaceConfig = sampleWorkspace();
    const readiness = workspaceReadiness(config, {
      tools: [
        { adapter: 'codex', ...USABLE },
        { adapter: 'claude-code', installed: true, adapterSupported: true, auth: 'logged_out' },
      ],
      projectCheckCounts: { checkout: 1, billing: 0 },
    });
    const pair = (departmentId: string, projectId: string) => readiness.eligibility.find((p) => p.departmentId === departmentId && p.projectId === projectId)!;

    expect(pair('engineering-platform', 'checkout')).toMatchObject({ sendable: true, codes: [], headAgentId: 'atlas', workerIds: ['nova'] });
    // forge is the only platform worker on billing and its tool is signed out; billing has no check.
    expect(pair('engineering-platform', 'billing').codes).toEqual(['project_has_no_checks', 'runtime_not_ready']);
    // iris (the head) is on the signed-out tool; the archived worker "old" is not counted.
    expect(pair('engineering-payments', 'checkout')).toMatchObject({ sendable: false, codes: ['runtime_not_ready'], workerIds: ['probe'] });
    expect(pair('design', 'billing').codes).toEqual(['department_has_no_head', 'project_has_no_checks', 'runtime_not_ready']);
    expect(pair('design', 'checkout').codes).toContain('no_worker_on_project');

    expect(readiness.steps.every((step) => step.state === 'done')).toBe(true);
    expect(readiness.empty).toBe(false);
  });

  it('never calls a pair sendable when its checks are unknown or its tools were not checked', () => {
    const config = sampleWorkspace();
    const unknownChecks = workspaceReadiness(config, { tools: [{ adapter: 'codex', ...USABLE }, { adapter: 'claude-code', ...USABLE }] });
    const platformCheckout = unknownChecks.eligibility.find((p) => p.departmentId === 'engineering-platform' && p.projectId === 'checkout')!;
    expect(platformCheckout.codes).toEqual(['project_checks_unknown']);
    expect(unknownChecks.steps.find((s) => s.id === 'send')!.state).not.toBe('done');

    const noTools = workspaceReadiness(config, { projectCheckCounts: { checkout: 2, billing: 1 } });
    expect(noTools.steps.find((s) => s.id === 'tools')!.state).toBe('current');
    // The pair itself is sendable (no discovery fact contradicts it), but setup still says the tools are unchecked.
    expect(noTools.eligibility.some((p) => p.sendable)).toBe(true);
  });

  it('counts configured project checks without needing to look at the repository', () => {
    const config = sampleWorkspace();
    config.projects[1]!.checks = ['npm test'];
    const readiness = workspaceReadiness(config, { projectCheckCounts: { checkout: 0 } });
    expect(readiness.eligibility.find((p) => p.departmentId === 'engineering-payments' && p.projectId === 'billing')!.codes).toEqual([]);
  });

  it('marks an archived project and department in every pair they appear in', () => {
    const config = sampleWorkspace();
    config.projects[0]!.archived = true;
    config.departments[1]!.archived = true;
    const readiness = workspaceReadiness(config, { projectCheckCounts: { checkout: 1, billing: 1 } });
    expect(readiness.eligibility.filter((p) => p.projectId === 'checkout').every((p) => p.codes.includes('project_archived'))).toBe(true);
    expect(readiness.eligibility.filter((p) => p.departmentId === 'engineering-payments').every((p) => p.codes.includes('department_archived'))).toBe(true);
  });
});
