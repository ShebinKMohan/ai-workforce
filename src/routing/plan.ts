/**
 * Planning (FR030): ask a configured agent for a task graph, then validate it
 * in code before anything is dispatched.
 *
 * A runtime proposing a plan is a suggestion, never an authority. Every plan
 * passes structural validation (schema), graph validation (cycles, resolvable
 * dependencies, duplicate objectives) and ownership validation (no two tasks
 * claim the same path) before it becomes dispatchable. Invalid plans are
 * rejected with specific reasons and are never silently repaired.
 *
 * The planner call sits behind `PlannerClient` so tests run without a runtime.
 */
import { z } from 'zod';
import {
  IdSchema,
  TASK_CONTRACT_VERSION,
  TaskContractSchema,
  AcceptanceCriterionSchema,
  TaskDependencySchema,
  formatZodIssues,
  type Limits,
  type TaskContract,
} from '../core/contracts.js';

export const PROPOSED_PLAN_VERSION = 1 as const;

export const ProposedTaskSchema = z.strictObject({
  id: IdSchema,
  objective: z.string().min(1),
  scope: z
    .strictObject({
      description: z.string().optional(),
      allowedPaths: z.array(z.string().min(1)).default([]),
      forbiddenPaths: z.array(z.string().min(1)).default([]),
    })
    .default({ allowedPaths: [], forbiddenPaths: [] }),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  dependencies: z.array(TaskDependencySchema).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  evidenceRequirements: z.array(z.string().min(1)).default([]),
});
export type ProposedTask = z.infer<typeof ProposedTaskSchema>;

export const ProposedPlanSchema = z.strictObject({
  planVersion: z.literal(PROPOSED_PLAN_VERSION),
  summary: z.string().min(1),
  tasks: z.array(ProposedTaskSchema).min(1),
});
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;

export interface PlannedTask {
  readonly id: string;
  readonly contract: TaskContract;
}

export interface ValidatedPlan {
  readonly planVersion: typeof PROPOSED_PLAN_VERSION;
  readonly summary: string;
  readonly tasks: ReadonlyArray<PlannedTask>;
  /** Deterministic topological order; a valid plan always has one. */
  readonly order: ReadonlyArray<string>;
}

export type PlanIssueCode =
  | 'schema'
  | 'duplicate_task_id'
  | 'duplicate_objective'
  | 'unresolved_dependency'
  | 'self_dependency'
  | 'dependency_cycle'
  | 'task_budget_exceeded'
  | 'missing_acceptance_criteria'
  | 'path_ownership_conflict'
  | 'planner_error';

export interface PlanIssue {
  readonly code: PlanIssueCode;
  readonly path: string;
  readonly message: string;
}

export type PlanValidation =
  | { readonly ok: true; readonly plan: ValidatedPlan }
  | { readonly ok: false; readonly issues: ReadonlyArray<PlanIssue> };

// ---------------------------------------------------------------------------
// Planner interface (injectable)
// ---------------------------------------------------------------------------

export interface PlannerRequest {
  readonly requestText: string;
  readonly repoPath: string;
  readonly contextRefs: ReadonlyArray<string>;
  readonly limits: Pick<Limits, 'maxTasksPerRun'>;
}

export interface PlannerClient {
  /** Returns the planner's raw proposal. It is untrusted until validated here. */
  propose(request: PlannerRequest): Promise<unknown>;
}

export interface PlanRunInput {
  readonly planner: PlannerClient;
  readonly requestText: string;
  readonly repoPath: string;
  readonly contextRefs?: ReadonlyArray<string>;
  readonly limits: Pick<Limits, 'maxTasksPerRun'>;
}

/** Ask the planner, then validate. The proposal is returned either way for evidence. */
export async function planRun(input: PlanRunInput): Promise<PlanValidation & { readonly proposal: unknown }> {
  const request: PlannerRequest = {
    requestText: input.requestText,
    repoPath: input.repoPath,
    contextRefs: input.contextRefs ?? [],
    limits: input.limits,
  };
  let proposal: unknown;
  try {
    proposal = await input.planner.propose(request);
  } catch (error) {
    return {
      ok: false,
      proposal: null,
      issues: [{ code: 'planner_error', path: '(planner)', message: `the planner did not return a plan: ${errorMessage(error)}` }],
    };
  }
  return { ...validatePlan(proposal, input.limits), proposal };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a proposed plan. Returns every issue found, so one round trip tells
 * the planner everything that is wrong. Nothing is repaired.
 */
export function validatePlan(proposal: unknown, limits: Pick<Limits, 'maxTasksPerRun'>): PlanValidation {
  const parsed = ProposedPlanSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, issues: formatZodIssues(parsed.error.issues).map((i) => ({ code: 'schema' as const, path: i.path, message: i.message })) };
  }
  const plan = parsed.data;
  const issues: PlanIssue[] = [];

  if (plan.tasks.length > limits.maxTasksPerRun) {
    issues.push({
      code: 'task_budget_exceeded',
      path: 'tasks',
      message: `the plan has ${plan.tasks.length} tasks but maxTasksPerRun is ${limits.maxTasksPerRun}; ask for a smaller plan rather than truncating this one`,
    });
  }

  // Task ids and objectives.
  const byId = new Map<string, ProposedTask>();
  const objectives = new Map<string, string>();
  plan.tasks.forEach((task, index) => {
    const first = byId.get(task.id);
    if (first !== undefined) {
      issues.push({ code: 'duplicate_task_id', path: `tasks[${index}].id`, message: `duplicate task id "${task.id}"; task ids must be unique within a plan` });
    } else {
      byId.set(task.id, task);
    }
    const key = normalizeObjective(task.objective);
    const owner = objectives.get(key);
    if (owner !== undefined) {
      issues.push({
        code: 'duplicate_objective',
        path: `tasks[${index}].objective`,
        message: `task "${task.id}" repeats the objective of task "${owner}"; two tasks doing the same work cannot both be accepted`,
      });
    } else {
      objectives.set(key, task.id);
    }
    if (task.acceptanceCriteria.length === 0) {
      issues.push({
        code: 'missing_acceptance_criteria',
        path: `tasks[${index}].acceptanceCriteria`,
        message: `task "${task.id}" has no acceptance criteria; without them nothing can decide whether it is done`,
      });
    }
  });

  // Dependency references.
  plan.tasks.forEach((task, index) => {
    task.dependencies.forEach((dep, depIndex) => {
      const path = `tasks[${index}].dependencies[${depIndex}].taskId`;
      if (dep.taskId === task.id) {
        issues.push({ code: 'self_dependency', path, message: `task "${task.id}" depends on itself` });
        return;
      }
      if (!byId.has(dep.taskId)) {
        issues.push({
          code: 'unresolved_dependency',
          path,
          message: `task "${task.id}" depends on unknown task "${dep.taskId}"; known tasks: ${[...byId.keys()].map((id) => `"${id}"`).join(', ')}`,
        });
      }
    });
  });

  // Path ownership.
  for (const conflict of findPathConflicts(plan.tasks)) issues.push(conflict);

  // Cycles (only meaningful once every reference resolves).
  const resolvable = issues.every((i) => i.code !== 'unresolved_dependency' && i.code !== 'duplicate_task_id');
  if (resolvable) {
    const cycle = findCycle(plan.tasks);
    if (cycle !== null) {
      issues.push({
        code: 'dependency_cycle',
        path: 'tasks',
        message: `dependency cycle: ${cycle.join(' -> ')}; no task in a cycle can ever become ready`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const tasks: PlannedTask[] = plan.tasks.map((task) => ({
    id: task.id,
    contract: TaskContractSchema.parse({
      contractVersion: TASK_CONTRACT_VERSION,
      objective: task.objective,
      scope: task.scope,
      acceptanceCriteria: task.acceptanceCriteria,
      dependencies: task.dependencies,
      constraints: task.constraints,
      evidenceRequirements: task.evidenceRequirements,
    }),
  }));

  return { ok: true, plan: { planVersion: plan.planVersion, summary: plan.summary, tasks, order: topologicalOrder(plan.tasks) } };
}

function normalizeObjective(objective: string): string {
  return objective.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
}

/** Normalize a repository-relative path for ownership comparison. */
export function normalizeOwnedPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function findPathConflicts(tasks: ReadonlyArray<ProposedTask>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const claims: Array<{ taskId: string; path: string; index: number; pathIndex: number }> = [];
  tasks.forEach((task, index) => {
    task.scope.allowedPaths.forEach((raw, pathIndex) => {
      const normalized = normalizeOwnedPath(raw);
      if (normalized.length > 0) claims.push({ taskId: task.id, path: normalized, index, pathIndex });
    });
  });
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i];
      const b = claims[j];
      if (a === undefined || b === undefined) continue;
      if (a.taskId === b.taskId) continue;
      if (!pathsOverlap(a.path, b.path)) continue;
      issues.push({
        code: 'path_ownership_conflict',
        path: `tasks[${b.index}].scope.allowedPaths[${b.pathIndex}]`,
        message: `task "${b.taskId}" claims "${b.path}", which overlaps "${a.path}" already owned by task "${a.taskId}"; two tasks writing the same path cannot run independently`,
      });
    }
  }
  return issues;
}

/** Return one cycle as a task-id path, or null when the graph is acyclic. */
export function findCycle(tasks: ReadonlyArray<ProposedTask>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const task of tasks) edges.set(task.id, task.dependencies.map((d) => d.taskId).filter((id) => id !== task.id));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found !== null) return found;
  }
  return null;
}

/** Kahn's algorithm with declaration-order tie-breaking, so the order is stable. */
export function topologicalOrder(tasks: ReadonlyArray<ProposedTask>): string[] {
  const ids = tasks.map((t) => t.id);
  const remaining = new Map<string, Set<string>>();
  for (const task of tasks) {
    remaining.set(task.id, new Set(task.dependencies.map((d) => d.taskId).filter((id) => ids.includes(id) && id !== task.id)));
  }
  const out: string[] = [];
  const emitted = new Set<string>();
  while (out.length < ids.length) {
    let progressed = false;
    for (const id of ids) {
      if (emitted.has(id)) continue;
      const deps = remaining.get(id);
      if (deps === undefined) continue;
      let ready = true;
      for (const dep of deps) if (!emitted.has(dep)) ready = false;
      if (!ready) continue;
      out.push(id);
      emitted.add(id);
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

/** Render plan issues as one operator-facing message. */
export function formatPlanIssues(issues: ReadonlyArray<PlanIssue>): string {
  return `the proposed plan was rejected:\n${issues.map((i) => `  - [${i.code}] ${i.path}: ${i.message}`).join('\n')}`;
}
