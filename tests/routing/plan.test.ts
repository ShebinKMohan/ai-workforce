import { describe, expect, it } from 'vitest';
import { planRun, validatePlan, formatPlanIssues, type PlannerClient } from '../../src/routing/plan.js';

const limits = { maxTasksPerRun: 10 };

function task(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    objective: `do ${id}`,
    scope: { allowedPaths: [`src/${id}`], forbiddenPaths: [] },
    acceptanceCriteria: [{ id: `${id}-ok`, description: `${id} works` }],
    dependencies: [],
    ...extra,
  };
}

function plan(tasks: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return { planVersion: 1, summary: 'a plan', tasks };
}

function codes(result: ReturnType<typeof validatePlan>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe('validatePlan', () => {
  it('accepts a well-formed graph and reports a stable topological order', () => {
    const result = validatePlan(plan([task('a'), task('b', { dependencies: [{ taskId: 'a', artifact: 'schema' }] })]), limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.order).toEqual(['a', 'b']);
    expect(result.plan.tasks[0]?.contract.contractVersion).toBe(1);
  });

  it('rejects a structurally invalid proposal without repairing it', () => {
    const result = validatePlan({ planVersion: 1, summary: 'x', tasks: [{ id: 'a' }] }, limits);
    expect(codes(result)).toContain('schema');
  });

  it('rejects unknown fields rather than dropping them', () => {
    const result = validatePlan(plan([{ ...task('a'), sessionId: 'abc' }]), limits);
    expect(codes(result)).toContain('schema');
  });

  it('rejects a dependency cycle and names it', () => {
    const result = validatePlan(
      plan([task('a', { dependencies: [{ taskId: 'b' }] }), task('b', { dependencies: [{ taskId: 'a' }] })]),
      limits,
    );
    expect(codes(result)).toContain('dependency_cycle');
    if (result.ok) return;
    expect(result.issues.find((i) => i.code === 'dependency_cycle')?.message).toContain('a -> b -> a');
  });

  it('rejects a dependency that resolves to nothing', () => {
    const result = validatePlan(plan([task('a', { dependencies: [{ taskId: 'ghost' }] })]), limits);
    expect(codes(result)).toContain('unresolved_dependency');
  });

  it('rejects a self dependency', () => {
    const result = validatePlan(plan([task('a', { dependencies: [{ taskId: 'a' }] })]), limits);
    expect(codes(result)).toContain('self_dependency');
  });

  it('rejects duplicate task ids', () => {
    const result = validatePlan(plan([task('a'), { ...task('a'), objective: 'do something else', scope: { allowedPaths: ['src/other'], forbiddenPaths: [] } }]), limits);
    expect(codes(result)).toContain('duplicate_task_id');
  });

  it('rejects two tasks with the same objective', () => {
    const result = validatePlan(plan([task('a'), { ...task('b'), objective: 'Do A.', scope: { allowedPaths: ['src/b'], forbiddenPaths: [] } }, { ...task('c'), objective: 'do a', scope: { allowedPaths: ['src/c'], forbiddenPaths: [] } }]), limits);
    expect(codes(result)).toContain('duplicate_objective');
  });

  it('rejects a task claiming a path another task owns', () => {
    const result = validatePlan(
      plan([task('a'), { ...task('b'), scope: { allowedPaths: ['src/a/inner'], forbiddenPaths: [] } }]),
      limits,
    );
    expect(codes(result)).toContain('path_ownership_conflict');
    if (result.ok) return;
    expect(result.issues.find((i) => i.code === 'path_ownership_conflict')?.message).toContain('src/a');
  });

  it('rejects a task with no acceptance criteria', () => {
    const result = validatePlan(plan([{ ...task('a'), acceptanceCriteria: [] }]), limits);
    expect(codes(result)).toContain('missing_acceptance_criteria');
  });

  it('rejects a plan larger than the task budget instead of truncating it', () => {
    const tasks = ['a', 'b', 'c'].map((id) => task(id));
    const result = validatePlan(plan(tasks), { maxTasksPerRun: 2 });
    expect(codes(result)).toContain('task_budget_exceeded');
  });

  it('reports every problem in one pass', () => {
    const result = validatePlan(
      plan([{ ...task('a'), acceptanceCriteria: [] }, task('b', { dependencies: [{ taskId: 'ghost' }] })]),
      limits,
    );
    expect(codes(result)).toEqual(expect.arrayContaining(['missing_acceptance_criteria', 'unresolved_dependency']));
    expect(formatPlanIssues(result.ok ? [] : result.issues)).toContain('rejected');
  });
});

describe('planRun', () => {
  it('validates whatever the planner returns', async () => {
    const planner: PlannerClient = { propose: async () => plan([task('a'), task('b')]) };
    const result = await planRun({ planner, requestText: 'do things', repoPath: '/repo', limits });
    expect(result.ok).toBe(true);
    expect(result.proposal).not.toBeNull();
  });

  it('passes the request and limits to the planner', async () => {
    let seen: unknown = null;
    const planner: PlannerClient = {
      propose: async (request) => {
        seen = request;
        return plan([task('a')]);
      },
    };
    await planRun({ planner, requestText: 'do things', repoPath: '/repo', contextRefs: ['notes.md'], limits });
    expect(seen).toEqual({ requestText: 'do things', repoPath: '/repo', contextRefs: ['notes.md'], limits });
  });

  it('turns a planner failure into a specific issue, not a crash', async () => {
    const planner: PlannerClient = {
      propose: async () => {
        throw new Error('runtime exited 1');
      },
    };
    const result = await planRun({ planner, requestText: 'do things', repoPath: '/repo', limits });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('planner_error');
    expect(result.issues[0]?.message).toContain('runtime exited 1');
  });
});
