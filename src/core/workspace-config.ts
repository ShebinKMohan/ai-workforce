/**
 * Workspace configuration, schema version 2 (`<state-root>/workspace.json`).
 *
 * One file describes everything a person builds: the coding tools
 * (runtimes), the projects, the departments with their head, and the workers
 * placed on projects. An empty workspace is valid — a fresh install starts
 * with nothing and the user builds it.
 *
 * Everything here is pure: zod shapes, the cross-reference rules that a shape
 * cannot express, and the readiness computation a page or a terminal reads to
 * say what is still missing. Loading, atomic writes and operations live in
 * `src/workspace/`.
 *
 * Rules that are enforced here, and therefore by every writer:
 * - ids are unique within projects, departments and agents, and an id that
 *   was removed (`retiredIds`) is never live again;
 * - department names may repeat, but (name, note) is unique;
 * - a head uses the read-only `analysis` policy, is placed on no project, and
 *   is the one head its department names; a department names at most one;
 * - every agent reference (runtime, department, project) resolves;
 * - a repository belongs to at most one project.
 *
 * Readiness is computed, never a parse error: a workspace with no head is a
 * valid file that cannot accept requests yet.
 */
import path from 'node:path';
import { z } from 'zod';
import { AgentIdSchema, EffortSchema, ModelSchema, PolicySchema, RuntimeConfigSchema, RuntimeIdSchema, formatZodIssues } from './contracts.js';

export const WORKSPACE_SCHEMA_VERSION = 2 as const;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const SlugSchema = z
  .string()
  .regex(SLUG_PATTERN, { message: 'ids use lowercase letters, digits and dashes, start with a letter or digit, and are at most 48 characters' });

/** The page palette families (web/office). Blue comes in two shades, hence `slate`. */
export const DEPARTMENT_COLORS = ['blue', 'rose', 'sand', 'lavender', 'sage', 'slate'] as const;
export const DepartmentColorSchema = z.enum(DEPARTMENT_COLORS);
export type DepartmentColor = z.infer<typeof DepartmentColorSchema>;

export const AgentRoleSchema = z.enum(['head', 'worker']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

const count = (max: number) => z.number().int().min(1).max(max);

/**
 * Workspace limits: how many project runs may be live at once, plus the
 * per-run limits every run is started with (the v1 `defaults` limits).
 */
export const WorkspaceLimitsSchema = z.strictObject({
  maxConcurrentProjectRuns: count(32).default(2),
  maxActiveTurns: count(64).default(2),
  maxActiveWriters: count(64).default(2),
  maxTasksPerRun: count(1000).default(8),
  maxDelegationDepth: z.number().int().min(0).max(16).default(2),
  maxRepairAttempts: z.number().int().min(0).max(100).default(2),
  maxTransientRetries: z.number().int().min(0).max(100).default(2),
  runTimeoutMinutes: count(24 * 60 * 7).default(30),
});
export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;

export const WorkspaceProjectSchema = z.strictObject({
  id: SlugSchema,
  name: z.string().trim().min(1).max(80),
  /** The Git repository root, absolute. Not editable: a different folder is a different project. */
  repoPath: z
    .string()
    .min(1)
    .refine((value) => path.isAbsolute(value), { message: 'must be an absolute path' }),
  /**
   * Acceptance checks in the form `workforce run --check` accepts. Empty means
   * the checks are resolved at the base revision (`.workforce/checks.json`, or
   * detected), exactly as a run resolves them.
   */
  checks: z.array(z.string().trim().min(1).max(500)).max(32).default([]),
  archived: z.boolean().default(false),
});
export type WorkspaceProject = z.infer<typeof WorkspaceProjectSchema>;

export const WorkspaceDepartmentSchema = z.strictObject({
  id: SlugSchema,
  name: z.string().trim().min(1).max(60),
  note: z.string().trim().min(1).max(60).optional(),
  color: DepartmentColorSchema,
  /** The department's head. Null while the department is being built; such a department accepts no requests. */
  headAgentId: AgentIdSchema.nullable().default(null),
  archived: z.boolean().default(false),
});
export type WorkspaceDepartment = z.infer<typeof WorkspaceDepartmentSchema>;

export const WorkspaceAgentSchema = z.strictObject({
  id: AgentIdSchema,
  name: z.string().trim().min(1).max(60),
  role: AgentRoleSchema,
  departmentId: SlugSchema,
  runtime: RuntimeIdSchema,
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  instructions: z.string().min(1),
  capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
  policy: PolicySchema,
  /** Projects this worker receives work on. Empty means on the bench: it receives no work. Always empty for a head. */
  projectIds: z.array(SlugSchema).max(64).default([]),
  archived: z.boolean().default(false),
});
export type WorkspaceAgent = z.infer<typeof WorkspaceAgentSchema>;

export const RetiredIdsSchema = z.strictObject({
  projects: z.array(SlugSchema).default([]),
  departments: z.array(SlugSchema).default([]),
  agents: z.array(AgentIdSchema).default([]),
});

/** The user-facing intake role is configured independently from department agents. */
export const ControlCenterConfigSchema = z.strictObject({
  runtime: RuntimeIdSchema,
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  instructions: z.string().trim().min(1).max(12000).optional(),
  /** Explicit project specialization; missing rules always leave routing to the model. */
  projectRoutes: z.array(z.strictObject({ projectId: SlugSchema, departmentId: SlugSchema })).max(64).optional(),
});
export type ControlCenterConfig = z.infer<typeof ControlCenterConfigSchema>;

const WorkspaceShape = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  /** Compare-and-swap counter. 0 only for the in-memory empty workspace; every write increments it. */
  revision: z.number().int().min(0),
  runtimes: z.record(RuntimeIdSchema, RuntimeConfigSchema).default({}),
  /** Absent in earlier schema-v2 files: select a usable configured runtime automatically. */
  controlCenter: ControlCenterConfigSchema.optional(),
  projects: z.array(WorkspaceProjectSchema).max(64).default([]),
  departments: z.array(WorkspaceDepartmentSchema).max(64).default([]),
  agents: z.array(WorkspaceAgentSchema).max(256).default([]),
  limits: WorkspaceLimitsSchema.prefault({}),
  /** Ids removed from this workspace. They are never issued again, so history never merges two different things. */
  retiredIds: RetiredIdsSchema.prefault({}),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceShape>;
export type WorkspaceConfigInput = z.input<typeof WorkspaceShape>;

export type WorkspaceIssueCode =
  | 'schema'
  | 'duplicate_id'
  | 'retired_id_in_use'
  | 'unknown_runtime'
  | 'unknown_department'
  | 'unknown_project'
  | 'duplicate_assignment'
  | 'duplicate_project_route'
  | 'head_not_read_only'
  | 'head_has_projects'
  | 'unknown_head'
  | 'head_not_a_head'
  | 'head_in_other_department'
  | 'head_archived'
  | 'head_not_assigned'
  | 'ambiguous_department_name'
  | 'duplicate_project_path';

export interface WorkspaceIssue {
  readonly code: WorkspaceIssueCode;
  readonly path: string;
  readonly message: string;
}

export const WorkspaceConfigSchema = WorkspaceShape.superRefine((config, ctx) => {
  for (const issue of workspaceReferenceIssues(config)) {
    ctx.addIssue({ code: 'custom', path: issue.path.length === 0 ? [] : issue.path.split(/[.[\]]+/).filter((s) => s.length > 0).map((s) => (/^\d+$/.test(s) ? Number(s) : s)), message: issue.message, params: { rule: issue.code } });
  }
});

export function emptyWorkspace(): WorkspaceConfig {
  return WorkspaceShape.parse({ schemaVersion: WORKSPACE_SCHEMA_VERSION, revision: 0 });
}

export type WorkspaceValidation = { readonly ok: true; readonly config: WorkspaceConfig } | { readonly ok: false; readonly issues: ReadonlyArray<WorkspaceIssue> };

/** Validate a workspace document: the shape first, then every cross-reference rule. Every issue names its JSON path. */
export function validateWorkspace(input: unknown): WorkspaceValidation {
  const shaped = WorkspaceShape.safeParse(input);
  if (!shaped.success) {
    return { ok: false, issues: formatZodIssues(shaped.error.issues).map((issue) => ({ code: 'schema' as const, path: issue.path, message: issue.message })) };
  }
  const issues = workspaceReferenceIssues(shaped.data);
  return issues.length === 0 ? { ok: true, config: shaped.data } : { ok: false, issues };
}

function list(items: ReadonlyArray<string>): string {
  return items.length === 0 ? '(none)' : items.map((item) => `"${item}"`).join(', ');
}

function foldName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The cross-reference rules a shape cannot express. Runs on a structurally valid document. */
export function workspaceReferenceIssues(config: WorkspaceConfig): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];

  const uniqueIds = (collection: 'projects' | 'departments' | 'agents', ids: ReadonlyArray<string>, noun: string): Map<string, number> => {
    const seen = new Map<string, number>();
    ids.forEach((id, index) => {
      const first = seen.get(id);
      if (first !== undefined) {
        issues.push({ code: 'duplicate_id', path: `${collection}[${index}].id`, message: `duplicate ${noun} id "${id}" (first at ${collection}[${first}]); ids must be unique` });
      } else {
        seen.set(id, index);
      }
      if (config.retiredIds[collection].includes(id)) {
        issues.push({ code: 'retired_id_in_use', path: `${collection}[${index}].id`, message: `${noun} id "${id}" was removed from this workspace and is never issued again; use a new id` });
      }
    });
    return seen;
  };

  const projectIndex = uniqueIds('projects', config.projects.map((p) => p.id), 'project');
  const departmentIndex = uniqueIds('departments', config.departments.map((d) => d.id), 'department');
  const agentIndex = uniqueIds('agents', config.agents.map((a) => a.id), 'agent');
  const runtimeIds = Object.keys(config.runtimes);

  if (config.controlCenter !== undefined) {
    if (!(config.controlCenter.runtime in config.runtimes)) issues.push({ code: 'unknown_runtime', path: 'controlCenter.runtime', message: `Control Center uses unknown runtime "${config.controlCenter.runtime}"; known runtimes: ${list(runtimeIds)}` });
    const routed = new Set<string>();
    for (const [index, route] of (config.controlCenter.projectRoutes ?? []).entries()) {
      const at = `controlCenter.projectRoutes[${index}]`;
      if (!projectIndex.has(route.projectId)) issues.push({ code: 'unknown_project', path: `${at}.projectId`, message: `Control Center route names unknown project "${route.projectId}"` });
      if (!departmentIndex.has(route.departmentId)) issues.push({ code: 'unknown_department', path: `${at}.departmentId`, message: `Control Center route names unknown department "${route.departmentId}"` });
      if (routed.has(route.projectId)) issues.push({ code: 'duplicate_project_route', path: `${at}.projectId`, message: `Control Center has more than one route for project "${route.projectId}"` });
      routed.add(route.projectId);
    }
  }

  // Projects: one repository, one project.
  const paths = new Map<string, string>();
  config.projects.forEach((project, index) => {
    const resolved = path.resolve(project.repoPath);
    const owner = paths.get(resolved);
    if (owner !== undefined) {
      issues.push({ code: 'duplicate_project_path', path: `projects[${index}].repoPath`, message: `${resolved} is already the project "${owner}"; a repository belongs to at most one project` });
    } else {
      paths.set(resolved, project.id);
    }
  });

  // Agents.
  config.agents.forEach((agent, index) => {
    const at = `agents[${index}]`;
    if (!(agent.runtime in config.runtimes)) {
      issues.push({ code: 'unknown_runtime', path: `${at}.runtime`, message: `agent "${agent.id}" uses unknown runtime "${agent.runtime}"; known runtimes: ${list(runtimeIds)}` });
    }
    if (!departmentIndex.has(agent.departmentId)) {
      issues.push({ code: 'unknown_department', path: `${at}.departmentId`, message: `agent "${agent.id}" belongs to unknown department "${agent.departmentId}"; known departments: ${list([...departmentIndex.keys()])}` });
    }
    const assigned = new Set<string>();
    agent.projectIds.forEach((projectId, projectIndexInAgent) => {
      if (!projectIndex.has(projectId)) {
        issues.push({ code: 'unknown_project', path: `${at}.projectIds[${projectIndexInAgent}]`, message: `agent "${agent.id}" is placed on unknown project "${projectId}"; known projects: ${list([...projectIndex.keys()])}` });
      }
      if (assigned.has(projectId)) {
        issues.push({ code: 'duplicate_assignment', path: `${at}.projectIds[${projectIndexInAgent}]`, message: `agent "${agent.id}" is placed on project "${projectId}" twice` });
      }
      assigned.add(projectId);
    });
    if (agent.role === 'head') {
      if (agent.policy !== 'analysis') {
        issues.push({ code: 'head_not_read_only', path: `${at}.policy`, message: `a head reads and plans only; "${agent.id}" must use the analysis policy, not "${agent.policy}"` });
      }
      if (agent.projectIds.length > 0) {
        issues.push({ code: 'head_has_projects', path: `${at}.projectIds`, message: `a head reaches projects through its workers; "${agent.id}" must not be placed on a project` });
      }
      if (!agent.archived) {
        const department = config.departments.find((d) => d.id === agent.departmentId);
        if (department !== undefined && department.headAgentId !== agent.id) {
          issues.push({
            code: 'head_not_assigned',
            path: `${at}.role`,
            message:
              department.headAgentId === null
                ? `"${agent.id}" is a head but department "${department.id}" names no head; set its headAgentId to "${agent.id}"`
                : `department "${department.id}" already has the head "${department.headAgentId}"; a department has one head, so "${agent.id}" cannot be a second`,
          });
        }
      }
    }
  });

  // Departments.
  const names = new Map<string, string>();
  config.departments.forEach((department, index) => {
    const at = `departments[${index}]`;
    const key = `${foldName(department.name)} ${foldName(department.note)}`;
    const other = names.get(key);
    if (other !== undefined) {
      issues.push({
        code: 'ambiguous_department_name',
        path: `${at}.note`,
        message: `departments "${other}" and "${department.id}" are both called ${department.name}${department.note !== undefined ? ` (${department.note})` : ''}; give each a different note`,
      });
    } else {
      names.set(key, department.id);
    }
    if (department.headAgentId !== null) {
      const headIndex = agentIndex.get(department.headAgentId);
      const head = headIndex === undefined ? undefined : config.agents[headIndex];
      if (head === undefined) {
        issues.push({ code: 'unknown_head', path: `${at}.headAgentId`, message: `department "${department.id}" names unknown head "${department.headAgentId}"` });
      } else if (head.role !== 'head') {
        issues.push({ code: 'head_not_a_head', path: `${at}.headAgentId`, message: `department "${department.id}" names "${head.id}" as its head, but "${head.id}" is a worker` });
      } else if (head.departmentId !== department.id) {
        issues.push({ code: 'head_in_other_department', path: `${at}.headAgentId`, message: `department "${department.id}" names "${head.id}" as its head, but "${head.id}" belongs to "${head.departmentId}"` });
      } else if (head.archived) {
        issues.push({ code: 'head_archived', path: `${at}.headAgentId`, message: `department "${department.id}" names the archived agent "${head.id}" as its head` });
      }
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Who can work: the single definition shared by readiness and roster building
// ---------------------------------------------------------------------------

/** The department's head, when it names one that is not archived. */
export function activeHead(config: WorkspaceConfig, departmentId: string): WorkspaceAgent | null {
  const department = config.departments.find((d) => d.id === departmentId);
  if (department === undefined || department.headAgentId === null) return null;
  const head = config.agents.find((agent) => agent.id === department.headAgentId);
  return head !== undefined && head.role === 'head' && !head.archived && head.departmentId === departmentId ? head : null;
}

/** Workers of the department placed on the project, in file order. Archived and benched workers receive no work. */
export function eligibleWorkers(config: WorkspaceConfig, departmentId: string, projectId: string): WorkspaceAgent[] {
  return config.agents.filter((agent) => agent.role === 'worker' && !agent.archived && agent.departmentId === departmentId && agent.projectIds.includes(projectId));
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** What passive discovery established about one coding tool. Structural, so core does not depend on discovery. */
export interface ToolFact {
  readonly adapter: string;
  readonly runtimeId?: string;
  readonly configuredExecutable?: string;
  readonly executable?: string | null;
  readonly realPath?: string | null;
  readonly installed: boolean;
  readonly adapterSupported: boolean;
  readonly controllable?: boolean;
  readonly auth: string;
}

/** A named binding's evidence takes precedence over any other installation of its adapter. */
export function toolFactForRuntime<T extends ToolFact>(tools: ReadonlyArray<T>, runtimeId: string, runtime: { adapter: string; executable: string }): T | undefined {
  const bound = tools.filter((tool) => tool.runtimeId === runtimeId);
  if (bound.length > 0) return bound.find((tool) => tool.adapter === runtime.adapter && tool.configuredExecutable === runtime.executable);
  const standardCommand = runtime.adapter === 'codex' ? 'codex' : runtime.adapter === 'claude-code' ? 'claude' : null;
  return tools.find((tool) => tool.runtimeId === undefined && tool.adapter === runtime.adapter && (
    runtime.executable === standardCommand || runtime.executable === tool.executable || runtime.executable === tool.realPath
  ));
}

export interface ReadinessFacts {
  /** Passive discovery results. Absent means the tools were not checked, which is never reported as done. */
  readonly tools?: ReadonlyArray<ToolFact>;
  /**
   * How many acceptance checks each project resolves at its last commit, by
   * project id. `null` means it could not be determined (missing folder, not a
   * repository, no commit). A project with configured `checks` needs no entry.
   */
  readonly projectCheckCounts?: Readonly<Record<string, number | null>>;
}

export type ReadinessStepId = 'tools' | 'project' | 'department' | 'send';

export interface ReadinessStep {
  readonly id: ReadinessStepId;
  readonly state: 'done' | 'current' | 'locked';
  /** Why the step is not done; null when it is. */
  readonly reason: string | null;
}

export type EligibilityCode =
  | 'project_archived'
  | 'department_archived'
  | 'department_has_no_head'
  | 'no_worker_on_project'
  | 'project_has_no_checks'
  | 'project_checks_unknown'
  | 'runtime_not_ready';

export interface PairEligibility {
  readonly departmentId: string;
  readonly projectId: string;
  /** True only when no code stands in the way. */
  readonly sendable: boolean;
  readonly codes: ReadonlyArray<EligibilityCode>;
  readonly reasons: ReadonlyArray<string>;
  readonly headAgentId: string | null;
  readonly workerIds: ReadonlyArray<string>;
}

export interface WorkspaceReadiness {
  /** No projects, departments or agents at all. */
  readonly empty: boolean;
  readonly steps: ReadonlyArray<ReadinessStep>;
  /** One entry per (department, project) pair. */
  readonly eligibility: ReadonlyArray<PairEligibility>;
}

export function isToolUsable(tool: ToolFact): boolean {
  return tool.installed && tool.adapterSupported && tool.controllable !== false && tool.auth !== 'logged_out';
}

/** Checks a project is known to have: configured ones, else what was resolved at its last commit, else unknown (null). */
export function knownCheckCount(project: WorkspaceProject, facts: ReadinessFacts): number | null {
  if (project.checks.length > 0) return project.checks.length;
  const resolved = facts.projectCheckCounts?.[project.id];
  return resolved === undefined ? null : resolved;
}

export function workspaceReadiness(config: WorkspaceConfig, facts: ReadinessFacts = {}): WorkspaceReadiness {
  /** Once checked, a supported binding needs its own usable evidence. The fake runtime is not passively discovered. */
  const runtimeNotReady = (runtimeId: string): boolean => {
    const runtime = config.runtimes[runtimeId];
    if (runtime === undefined) return true;
    if (runtime.adapter === 'fake' || facts.tools === undefined) return false;
    const tool = toolFactForRuntime(facts.tools, runtimeId, runtime);
    return tool === undefined || !isToolUsable(tool);
  };

  const eligibility: PairEligibility[] = [];
  for (const department of config.departments) {
    for (const project of config.projects) {
      const codes: EligibilityCode[] = [];
      const reasons: string[] = [];
      const head = activeHead(config, department.id);
      const workers = eligibleWorkers(config, department.id, project.id);
      if (project.archived) {
        codes.push('project_archived');
        reasons.push(`project "${project.id}" is archived`);
      }
      if (department.archived) {
        codes.push('department_archived');
        reasons.push(`department "${department.id}" is archived`);
      }
      if (head === null) {
        codes.push('department_has_no_head');
        reasons.push(`department "${department.id}" has no head, so it cannot accept requests`);
      }
      if (workers.length === 0) {
        codes.push('no_worker_on_project');
        reasons.push(`no worker of department "${department.id}" is placed on project "${project.id}"`);
      }
      const checks = knownCheckCount(project, facts);
      if (checks === 0) {
        codes.push('project_has_no_checks');
        reasons.push(`project "${project.id}" has no acceptance check; nothing could verify the result`);
      } else if (checks === null) {
        codes.push('project_checks_unknown');
        reasons.push(`the acceptance checks of project "${project.id}" have not been found yet`);
      }
      if ((head !== null && runtimeNotReady(head.runtime)) || (workers.length > 0 && workers.every((worker) => runtimeNotReady(worker.runtime)))) {
        codes.push('runtime_not_ready');
        reasons.push(head !== null && runtimeNotReady(head.runtime) ? `the head's configured coding tool (${head.runtime}) is missing, unsupported, signed out, or has not been checked` : 'no eligible worker has a configured coding tool available for execution; check its executable and connection status');
      }
      eligibility.push({
        departmentId: department.id,
        projectId: project.id,
        sendable: codes.length === 0,
        codes,
        reasons,
        headAgentId: head?.id ?? null,
        workerIds: workers.map((worker) => worker.id),
      });
    }
  }

  const toolsDone = facts.tools !== undefined && facts.tools.some(isToolUsable);
  const toolsReason =
    facts.tools === undefined ? 'the coding tools have not been checked yet (run "workforce doctor")' : 'no coding tool is installed and signed in: install Codex or Claude Code and sign in';

  const liveProjects = config.projects.filter((project) => !project.archived);
  const projectDone = liveProjects.some((project) => (knownCheckCount(project, facts) ?? 0) > 0);
  const projectReason =
    liveProjects.length === 0
      ? 'add a project: a Git repository with at least one commit'
      : liveProjects.some((project) => knownCheckCount(project, facts) === null)
        ? 'no project is known to have an acceptance check yet'
        : 'no project has an acceptance check: add one (workforce workspace project edit <id> --check "npm test") or commit .workforce/checks.json';

  const departmentDone = config.departments.some(
    (department) => !department.archived && activeHead(config, department.id) !== null && liveProjects.some((project) => eligibleWorkers(config, department.id, project.id).length > 0),
  );
  const departmentReason =
    config.departments.filter((d) => !d.archived).length === 0
      ? 'create a department with a head and at least one worker'
      : 'no department has both a head and a worker placed on a project';

  const sendDone = eligibility.some((pair) => pair.sendable);
  // Explain with a pair someone could actually use, not one that is archived.
  const firstBlocked =
    eligibility.find((pair) => !pair.sendable && !pair.codes.includes('project_archived') && !pair.codes.includes('department_archived')) ??
    eligibility.find((pair) => !pair.sendable);
  const sendReason = eligibility.length === 0 ? 'nothing can be sent yet: there is no department and project pair' : `nothing can be sent yet: ${firstBlocked?.reasons[0] ?? 'no pair is ready'}`;

  const raw: Array<{ id: ReadinessStepId; done: boolean; reason: string }> = [
    { id: 'tools', done: toolsDone, reason: toolsReason },
    { id: 'project', done: projectDone, reason: projectReason },
    { id: 'department', done: departmentDone, reason: departmentReason },
    { id: 'send', done: sendDone, reason: sendReason },
  ];
  let currentAssigned = false;
  const steps: ReadinessStep[] = raw.map((step) => {
    if (step.done) return { id: step.id, state: 'done', reason: null };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id: step.id, state: 'current', reason: step.reason };
    }
    return { id: step.id, state: 'locked', reason: step.reason };
  });

  return {
    empty: config.projects.length === 0 && config.departments.length === 0 && config.agents.length === 0,
    steps,
    eligibility,
  };
}
