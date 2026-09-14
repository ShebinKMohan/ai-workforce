/**
 * Workspace operations: every change a person can make, as a pure function
 * over the document.
 *
 * The CLI verbs and the server's config routes both call these, through
 * `applyWorkspaceOps` and `updateWorkspace`, so a refusal reads the same in a
 * terminal and on the page. Each function takes the current document and
 * returns a new one; it never touches disk, and in particular removing a
 * project never deletes its source.
 *
 * Project, department and agent ids are never reused. A generated id is a slug of the name with `-2`, `-3`
 * suffixes when taken, where "taken" means live in the file or listed in
 * `retiredIds`. Every remove retires the id in the same write, so a folder
 * added later under a removed project's name gets a new id and two different
 * repositories never share one history.
 */
import path from 'node:path';
import { z } from 'zod';
import {
  AdapterIdSchema,
  AgentIdSchema,
  ContractValidationError,
  EffortSchema,
  ModelSchema,
  PolicySchema,
  RuntimeConfigSchema,
  RuntimeIdSchema,
  validateAgentConfig,
  type AgentConfigFile,
} from '../core/contracts.js';
import { canonicalJson } from '../core/snapshot.js';
import {
  AgentRoleSchema,
  AgentAvatarIdSchema,
  type AgentAvatarId,
  AgentProjectScopeSchema,
  ControlCenterConfigSchema,
  DEPARTMENT_COLORS,
  DepartmentColorSchema,
  SlugSchema,
  activeHead,
  type WorkspaceAgent,
  type AgentProjectScope,
  type ControlCenterConfig,
  type WorkspaceConfig,
  type WorkspaceDepartment,
  type WorkspaceProject,
} from '../core/workspace-config.js';
import { isWithin } from '../storage/paths.js';
import { WorkspaceError, invalidWorkspaceInput as invalid } from './errors.js';

export const HEAD_INSTRUCTIONS =
  'Read the request and the project. Split the work into small tasks that each have a clear check, and assign each task to one of your workers.';
export const WORKER_INSTRUCTIONS = 'Inspect the relevant code, fix the underlying issue, and submit evidence against the task criteria.';

/** The runtime ids `defaultAgentConfig` uses, with the executables it would write. */
export const STANDARD_RUNTIMES = {
  'codex-local': { adapter: 'codex', executable: 'codex' },
  'claude-local': { adapter: 'claude-code', executable: 'claude' },
} as const;

/** `codex` and `claude-code` (or `claude`) name the standard runtime for that tool; any other value is a runtime id. */
export function standardRuntimeId(name: string): string {
  if (name === 'codex') return 'codex-local';
  if (name === 'claude-code' || name === 'claude') return 'claude-local';
  return name;
}

export interface OpContext {
  /** The state root, so a project that contains it (or lies inside it) is refused. */
  readonly stateRoot?: string;
  /** True when the project has a run in progress. Remove refuses then. */
  readonly projectHasLiveRun?: (projectId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

type Collection = 'projects' | 'departments' | 'agents';

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function isTaken(config: WorkspaceConfig, collection: Collection, id: string): boolean {
  const live = config[collection].some((item) => item.id === id);
  return live || config.retiredIds[collection].includes(id);
}

function issueId(config: WorkspaceConfig, collection: Collection, preferred: string, fallback: string): string {
  const base = slugify(preferred) || fallback;
  if (!isTaken(config, collection, base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!isTaken(config, collection, candidate)) return candidate;
  }
}

const NOUN: Record<Collection, string> = { projects: 'project', departments: 'department', agents: 'agent' };

function claimExplicitId(config: WorkspaceConfig, collection: Collection, id: string): string {
  const schema = collection === 'agents' ? AgentIdSchema : SlugSchema;
  const parsed = schema.safeParse(id);
  if (!parsed.success) throw invalid('invalid_id', `"${id}" is not a valid ${NOUN[collection]} id: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  if (config.retiredIds[collection].includes(id)) {
    throw invalid('id_retired', `${NOUN[collection]} id "${id}" was removed from this workspace and is never issued again; choose another id`);
  }
  if (config[collection].some((item) => item.id === id)) throw invalid('duplicate_id', `a ${NOUN[collection]} with id "${id}" already exists`);
  return id;
}

function known(items: ReadonlyArray<{ id: string }>): string {
  return items.length === 0 ? '(none)' : items.map((item) => `"${item.id}"`).join(', ');
}

function findProject(config: WorkspaceConfig, id: string): WorkspaceProject {
  const project = config.projects.find((p) => p.id === id);
  if (project === undefined) throw invalid('unknown_project', `unknown project "${id}"; known projects: ${known(config.projects)}`);
  return project;
}

function findDepartment(config: WorkspaceConfig, id: string): WorkspaceDepartment {
  const department = config.departments.find((d) => d.id === id);
  if (department === undefined) throw invalid('unknown_department', `unknown department "${id}"; known departments: ${known(config.departments)}`);
  return department;
}

function findAgent(config: WorkspaceConfig, id: string): WorkspaceAgent {
  const agent = config.agents.find((a) => a.id === id);
  if (agent === undefined) throw invalid('unknown_agent', `unknown agent "${id}"; known agents: ${known(config.agents)}`);
  return agent;
}

function fold(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function assertDistinctDepartmentName(config: WorkspaceConfig, name: string, note: string | undefined, selfId: string | null): void {
  const clash = config.departments.find((d) => d.id !== selfId && fold(d.name) === fold(name) && fold(d.note) === fold(note));
  if (clash !== undefined) {
    throw invalid(
      'ambiguous_department_name',
      `a department called ${name}${note !== undefined ? ` (${note})` : ''} already exists ("${clash.id}"); department names may repeat, but each needs a different note`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runtimes and limits
// ---------------------------------------------------------------------------

export interface RuntimeSetInput {
  readonly id: string;
  readonly adapter: string;
  readonly executable: string;
  readonly model?: string;
  readonly effort?: string;
}

export function setRuntime(config: WorkspaceConfig, input: RuntimeSetInput): WorkspaceConfig {
  const id = RuntimeIdSchema.safeParse(input.id);
  if (!id.success) throw invalid('invalid_id', `"${input.id}" is not a valid runtime id: ${id.error.issues[0]?.message ?? 'invalid'}`);
  const runtime = RuntimeConfigSchema.safeParse({
    adapter: input.adapter,
    executable: input.executable,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  if (!runtime.success) throw invalid('invalid_runtime', `runtime "${input.id}" is invalid: ${runtime.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const draft = structuredClone(config);
  draft.runtimes[id.data] = runtime.data;
  return draft;
}

/** Remove an unused binding only; installed software and immutable run history are untouched. */
export function removeRuntime(config: WorkspaceConfig, id: string): WorkspaceConfig {
  if (!Object.hasOwn(config.runtimes, id)) throw invalid('unknown_runtime', `unknown runtime "${id}"`);
  const references = [
    ...(config.controlCenter?.runtime === id ? ['Control Center'] : []),
    ...config.agents.filter((agent) => agent.runtime === id).map((agent) => `agent "${agent.id}"${agent.archived ? ' (archived)' : ''}`),
  ];
  if (references.length > 0) {
    throw invalid('runtime_in_use', `runtime "${id}" is still used by ${references.join(', ')}; move those references to another configured runtime before removing it`, references);
  }
  const draft = structuredClone(config);
  delete draft.runtimes[id];
  return draft;
}

/** Full replacement, or null runtime to restore automatic Control Center selection. */
export function setControlCenter(config: WorkspaceConfig, input: { readonly runtime: string | null; readonly avatarId?: AgentAvatarId; readonly model?: string; readonly effort?: string; readonly instructions?: string; readonly projectRoutes?: ControlCenterConfig['projectRoutes'] }): WorkspaceConfig {
  const draft = structuredClone(config);
  if (input.runtime === null) {
    if (input.avatarId !== undefined || input.model !== undefined || input.effort !== undefined || input.instructions !== undefined || input.projectRoutes !== undefined) throw invalid('invalid_control_center', 'automatic Control Center selection cannot include runtime-specific overrides or project routes');
    delete draft.controlCenter;
    return draft;
  }
  const parsed = ControlCenterConfigSchema.safeParse(input);
  if (!parsed.success) throw invalid('invalid_control_center', 'Control Center settings are invalid', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  if (!(parsed.data.runtime in config.runtimes)) throw invalid('unknown_runtime', `Control Center uses unknown runtime "${parsed.data.runtime}"; configure that runtime first`);
  const projects = new Set<string>();
  for (const route of parsed.data.projectRoutes ?? []) {
    findProject(config, route.projectId);
    findDepartment(config, route.departmentId);
    if (projects.has(route.projectId)) throw invalid('duplicate_project_route', `Control Center has more than one route for project "${route.projectId}"`);
    projects.add(route.projectId);
  }
  draft.controlCenter = parsed.data;
  return draft;
}

/** Add `codex-local` or `claude-local` with its default executable when it is named and not yet defined. */
export function ensureStandardRuntime(config: WorkspaceConfig, runtimeId: string): WorkspaceConfig {
  if (runtimeId in config.runtimes) return config;
  const standard = STANDARD_RUNTIMES[runtimeId as keyof typeof STANDARD_RUNTIMES];
  return standard === undefined ? config : setRuntime(config, { id: runtimeId, adapter: standard.adapter, executable: standard.executable });
}

export const LimitsPatchSchema = z.strictObject({
  maxConcurrentProjectRuns: z.number().int().min(1).max(32).optional(),
  maxActiveTurns: z.number().int().min(1).max(64).optional(),
  maxActiveWriters: z.number().int().min(1).max(64).optional(),
  maxTasksPerRun: z.number().int().min(1).max(1000).optional(),
  maxDelegationDepth: z.number().int().min(0).max(16).optional(),
  maxRepairAttempts: z.number().int().min(0).max(100).optional(),
  maxTransientRetries: z.number().int().min(0).max(100).optional(),
  runTimeoutMinutes: z.number().int().min(1).max(24 * 60 * 7).optional(),
});
export type LimitsPatch = z.infer<typeof LimitsPatchSchema>;

export function setLimits(config: WorkspaceConfig, patch: LimitsPatch): WorkspaceConfig {
  const draft = structuredClone(config);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (draft.limits as Record<string, number>)[key] = value;
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectAddInput {
  /** The repository root, absolute. The CLI resolves a folder to its repository root before calling this. */
  readonly repoPath: string;
  readonly name?: string;
  readonly id?: string;
  readonly checks?: ReadonlyArray<string>;
}

export function addProject(config: WorkspaceConfig, input: ProjectAddInput, context: OpContext = {}): WorkspaceConfig {
  if (!path.isAbsolute(input.repoPath)) throw invalid('invalid_repo_path', `a project folder must be an absolute path, not "${input.repoPath}"`);
  const repoPath = path.resolve(input.repoPath);
  const existing = config.projects.find((p) => path.resolve(p.repoPath) === repoPath);
  if (existing !== undefined) throw invalid('duplicate_project_path', `${repoPath} is already the project "${existing.id}"; a repository belongs to at most one project`);
  if (context.stateRoot !== undefined) {
    const stateRoot = path.resolve(context.stateRoot);
    if (isWithin(repoPath, stateRoot) || isWithin(stateRoot, repoPath)) {
      throw invalid('project_overlaps_state_root', `${repoPath} overlaps the Workforce state root ${stateRoot}; a project must not contain Workforce's own state or live inside it`);
    }
  }
  const draft = structuredClone(config);
  const name = (input.name ?? path.basename(repoPath)).trim();
  const id = input.id !== undefined ? claimExplicitId(draft, 'projects', input.id) : issueId(draft, 'projects', name, 'project');
  draft.projects.push({ id, name: name.length > 0 ? name : id, repoPath, checks: [...(input.checks ?? [])], archived: false });
  return draft;
}

export interface ProjectEditInput {
  readonly id: string;
  readonly name?: string;
  readonly checks?: ReadonlyArray<string>;
  /** Accepted only so it can be refused by name: a project's folder is not editable. */
  readonly repoPath?: string;
}

export function editProject(config: WorkspaceConfig, input: ProjectEditInput): WorkspaceConfig {
  findProject(config, input.id);
  if (input.repoPath !== undefined) {
    throw invalid('path_immutable', `the folder of project "${input.id}" cannot be changed; remove this project and add the other folder as a new project`);
  }
  const draft = structuredClone(config);
  const project = findProject(draft, input.id);
  if (input.name !== undefined) project.name = input.name.trim();
  if (input.checks !== undefined) project.checks = [...input.checks];
  return draft;
}

export function archiveProject(config: WorkspaceConfig, id: string): WorkspaceConfig {
  const draft = structuredClone(config);
  findProject(draft, id).archived = true;
  return draft;
}

/** Remove a project from the workspace. Its source folder is never touched; its run history stays on disk. */
export function removeProject(config: WorkspaceConfig, id: string, context: OpContext = {}): WorkspaceConfig {
  findProject(config, id);
  if (context.projectHasLiveRun?.(id) === true) {
    throw new WorkspaceError(3, 'project_in_use', `project "${id}" has a run in progress; wait for it to finish or stop it, then remove the project`);
  }
  const draft = structuredClone(config);
  draft.projects = draft.projects.filter((p) => p.id !== id);
  for (const agent of draft.agents) agent.projectIds = agent.projectIds.filter((projectId) => projectId !== id);
  if (draft.controlCenter?.projectRoutes !== undefined) draft.controlCenter.projectRoutes = draft.controlCenter.projectRoutes.filter((route) => route.projectId !== id);
  draft.retiredIds.projects.push(id);
  return draft;
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export interface DepartmentAddInput {
  readonly name: string;
  readonly note?: string;
  readonly color?: string;
  readonly id?: string;
}

function parseColor(color: string): (typeof DEPARTMENT_COLORS)[number] {
  const parsed = DepartmentColorSchema.safeParse(color);
  if (!parsed.success) throw invalid('invalid_color', `"${color}" is not a department colour; use one of ${DEPARTMENT_COLORS.join(', ')}`);
  return parsed.data;
}

export function addDepartment(config: WorkspaceConfig, input: DepartmentAddInput): WorkspaceConfig {
  const name = input.name.trim();
  if (name.length === 0) throw invalid('invalid_name', 'a department needs a name');
  const note = input.note !== undefined && input.note.trim().length > 0 ? input.note.trim() : undefined;
  assertDistinctDepartmentName(config, name, note, null);
  const draft = structuredClone(config);
  const color =
    input.color !== undefined
      ? parseColor(input.color)
      : (DEPARTMENT_COLORS.find((c) => !draft.departments.some((d) => d.color === c)) ?? DEPARTMENT_COLORS[draft.departments.length % DEPARTMENT_COLORS.length]!);
  const id = input.id !== undefined ? claimExplicitId(draft, 'departments', input.id) : issueId(draft, 'departments', note !== undefined ? `${name} ${note}` : name, 'department');
  draft.departments.push({ id, name, ...(note !== undefined ? { note } : {}), color, headAgentId: null, archived: false });
  return draft;
}

export interface DepartmentEditInput {
  readonly id: string;
  readonly name?: string;
  /** null removes the note. */
  readonly note?: string | null;
  readonly color?: string;
}

export function editDepartment(config: WorkspaceConfig, input: DepartmentEditInput): WorkspaceConfig {
  const current = findDepartment(config, input.id);
  const name = input.name !== undefined ? input.name.trim() : current.name;
  const note = input.note === null ? undefined : input.note !== undefined ? input.note.trim() || undefined : current.note;
  assertDistinctDepartmentName(config, name, note, current.id);
  const draft = structuredClone(config);
  const department = findDepartment(draft, input.id);
  department.name = name;
  if (note === undefined) delete department.note;
  else department.note = note;
  if (input.color !== undefined) department.color = parseColor(input.color);
  return draft;
}

export function archiveDepartment(config: WorkspaceConfig, id: string): WorkspaceConfig {
  const draft = structuredClone(config);
  findDepartment(draft, id).archived = true;
  return draft;
}

/**
 * Remove a department. Refused while it has an agent that is not archived.
 * Its archived agents go with it and their ids are retired; a run that used
 * them keeps its own recorded configuration.
 */
export function removeDepartment(config: WorkspaceConfig, id: string): WorkspaceConfig {
  findDepartment(config, id);
  const active = config.agents.filter((agent) => agent.departmentId === id && !agent.archived);
  if (active.length > 0) {
    throw invalid('department_has_agents', `department "${id}" still has ${active.length} agent${active.length === 1 ? '' : 's'} (${known(active)}); archive them first`);
  }
  const draft = structuredClone(config);
  for (const agent of draft.agents.filter((a) => a.departmentId === id)) draft.retiredIds.agents.push(agent.id);
  draft.agents = draft.agents.filter((agent) => agent.departmentId !== id);
  draft.departments = draft.departments.filter((d) => d.id !== id);
  if (draft.controlCenter?.projectRoutes !== undefined) draft.controlCenter.projectRoutes = draft.controlCenter.projectRoutes.filter((route) => route.departmentId !== id);
  draft.retiredIds.departments.push(id);
  return draft;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentAddInput {
  readonly id?: string;
  readonly name?: string;
  readonly avatarId?: AgentAvatarId;
  readonly role: 'head' | 'worker';
  readonly departmentId: string;
  readonly runtime: string;
  readonly model?: string;
  readonly effort?: string;
  readonly instructions?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly policy?: 'analysis' | 'local-development' | 'verification';
  readonly projectIds?: ReadonlyArray<string>;
  readonly projectScope?: AgentProjectScope;
}

function assertRuntime(config: WorkspaceConfig, runtime: string): void {
  if (!(runtime in config.runtimes)) {
    const ids = Object.keys(config.runtimes);
    throw invalid('unknown_runtime', `unknown runtime "${runtime}"; known runtimes: ${ids.length === 0 ? '(none)' : ids.map((id) => `"${id}"`).join(', ')}`, [
      'use codex or claude-code for the standard tool, or define one: workforce workspace runtime set <id> --adapter codex|claude-code --executable <path>',
    ]);
  }
}

function assertPlaceable(config: WorkspaceConfig, projectId: string): void {
  const project = findProject(config, projectId);
  if (project.archived) throw invalid('project_archived', `project "${projectId}" is archived; archived projects receive no new work`);
}

export function addAgent(config: WorkspaceConfig, input: AgentAddInput): WorkspaceConfig {
  if (input.avatarId !== undefined && !AgentAvatarIdSchema.safeParse(input.avatarId).success) throw invalid('invalid_avatar', 'Choose a bundled agent portrait.');
  const role = AgentRoleSchema.safeParse(input.role);
  if (!role.success) throw invalid('invalid_role', `role must be "head" or "worker", not "${String(input.role)}"`);
  const department = findDepartment(config, input.departmentId);
  if (department.archived) throw invalid('department_archived', `department "${department.id}" is archived; it takes no new agents`);
  assertRuntime(config, input.runtime);
  const policy = input.policy ?? (role.data === 'head' ? 'analysis' : 'local-development');
  const projectIds = [...new Set(input.projectIds ?? [])];
  if (input.projectScope !== undefined && !AgentProjectScopeSchema.safeParse(input.projectScope).success) throw invalid('invalid_project_scope', 'project scope must be all or restricted');
  if (role.data === 'head') {
    if (policy !== 'analysis') throw invalid('head_not_read_only', `a head reads and plans only; it must use the analysis policy, not "${policy}"`);
    if (projectIds.length > 0) throw invalid('head_has_projects', 'a head reaches projects through its workers; place workers on projects instead');
    if (input.projectScope === 'restricted') throw invalid('head_has_project_scope', 'a head plans through its admitted workers; set project restrictions on workers instead');
    const current = activeHead(config, department.id);
    if (current !== null) throw invalid('department_has_head', `department "${department.id}" already has the head "${current.id}"; a department has one head`);
  }
  for (const projectId of projectIds) assertPlaceable(config, projectId);
  for (const [field, schema, value] of [
    ['model', ModelSchema, input.model],
    ['effort', EffortSchema, input.effort],
  ] as const) {
    if (value !== undefined && !schema.safeParse(value).success) throw invalid(`invalid_${field}`, `"${value}" is not a valid ${field}`);
  }

  const draft = structuredClone(config);
  const name = (input.name ?? input.id ?? `${department.name} ${role.data}`).trim();
  const id = input.id !== undefined ? claimExplicitId(draft, 'agents', input.id) : issueId(draft, 'agents', name, role.data);
  draft.agents.push({
    id,
    name: name.length > 0 ? name.slice(0, 60) : id,
    ...(input.avatarId !== undefined ? { avatarId: input.avatarId } : {}),
    role: role.data,
    departmentId: department.id,
    runtime: input.runtime,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    instructions: input.instructions ?? (role.data === 'head' ? HEAD_INSTRUCTIONS : WORKER_INSTRUCTIONS),
    capabilities: [...(input.capabilities ?? (role.data === 'head' ? ['planning'] : ['coding', 'testing']))],
    policy,
    projectIds,
    ...(input.projectScope !== undefined ? { projectScope: input.projectScope } : {}),
    archived: false,
  });
  if (role.data === 'head') findDepartment(draft, department.id).headAgentId = id;
  return draft;
}

export interface AgentEditInput {
  readonly id: string;
  readonly name?: string;
  /** null restores the original illustrated identity. */
  readonly avatarId?: AgentAvatarId | null;
  readonly runtime?: string;
  /** null clears the setting so the runtime's own default applies. */
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly instructions?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly policy?: 'analysis' | 'local-development' | 'verification';
  readonly departmentId?: string;
  readonly projectScope?: AgentProjectScope;
  readonly projectIds?: ReadonlyArray<string>;
}

export function editAgent(config: WorkspaceConfig, input: AgentEditInput): WorkspaceConfig {
  if (input.avatarId !== undefined && input.avatarId !== null && !AgentAvatarIdSchema.safeParse(input.avatarId).success) throw invalid('invalid_avatar', 'Choose a bundled agent portrait.');
  const current = findAgent(config, input.id);
  if (current.archived) throw invalid('agent_archived', `agent "${current.id}" is archived; add a new agent instead`);
  if (input.projectScope !== undefined && !AgentProjectScopeSchema.safeParse(input.projectScope).success) throw invalid('invalid_project_scope', 'project scope must be all or restricted');
  if (current.role === 'head' && input.projectScope === 'restricted') throw invalid('head_has_project_scope', 'a head plans through its admitted workers; set project restrictions on workers instead');
  if (current.role === 'head' && input.projectIds !== undefined && input.projectIds.length > 0) throw invalid('head_has_projects', 'a head reaches projects through its admitted workers');
  for (const projectId of input.projectIds ?? []) assertPlaceable(config, projectId);
  if (input.runtime !== undefined) assertRuntime(config, input.runtime);
  if (current.role === 'head' && input.policy !== undefined && input.policy !== 'analysis') {
    throw invalid('head_not_read_only', `a head reads and plans only; "${current.id}" must keep the analysis policy`);
  }
  if (input.departmentId !== undefined && input.departmentId !== current.departmentId) {
    if (current.role === 'head') throw invalid('head_department_immutable', `a head stays in its department; archive "${current.id}" and add a head to the other department`);
    const target = findDepartment(config, input.departmentId);
    if (target.archived) throw invalid('department_archived', `department "${target.id}" is archived; it takes no new agents`);
  }
  const draft = structuredClone(config);
  const agent = findAgent(draft, input.id);
  if (input.name !== undefined) agent.name = input.name.trim();
  if (input.avatarId === null) delete agent.avatarId;
  else if (input.avatarId !== undefined) agent.avatarId = input.avatarId;
  if (input.runtime !== undefined) agent.runtime = input.runtime;
  if (input.model === null) delete agent.model;
  else if (input.model !== undefined) agent.model = input.model;
  if (input.effort === null) delete agent.effort;
  else if (input.effort !== undefined) agent.effort = input.effort;
  if (input.instructions !== undefined) agent.instructions = input.instructions;
  if (input.capabilities !== undefined) agent.capabilities = [...input.capabilities];
  if (input.policy !== undefined) agent.policy = input.policy;
  if (input.departmentId !== undefined) agent.departmentId = input.departmentId;
  if (input.projectScope !== undefined) agent.projectScope = input.projectScope;
  if (input.projectIds !== undefined) agent.projectIds = [...new Set(input.projectIds)];
  return draft;
}

/** Archive an agent: it receives no new work, its history stays readable. A run already under way keeps its own snapshot. */
export function archiveAgent(config: WorkspaceConfig, id: string): WorkspaceConfig {
  const current = findAgent(config, id);
  if (current.archived) return config;
  const draft = structuredClone(config);
  const agent = findAgent(draft, id);
  agent.archived = true;
  if (agent.role === 'head') {
    const department = draft.departments.find((d) => d.id === agent.departmentId);
    if (department !== undefined && department.headAgentId === id) department.headAgentId = null;
  }
  return draft;
}

export function assignAgent(config: WorkspaceConfig, agentId: string, projectId: string): WorkspaceConfig {
  const agent = findAgent(config, agentId);
  if (agent.archived) throw invalid('agent_archived', `agent "${agent.id}" is archived; archived agents receive no new work`);
  if (agent.role === 'head') throw invalid('head_has_projects', `"${agent.id}" is a head; a head reaches projects through its workers`);
  assertPlaceable(config, projectId);
  if (agent.projectScope === 'restricted' && agent.projectIds.includes(projectId)) return config;
  const draft = structuredClone(config);
  const target = findAgent(draft, agentId);
  target.projectScope = 'restricted';
  if (!target.projectIds.includes(projectId)) target.projectIds.push(projectId);
  return draft;
}

export function unassignAgent(config: WorkspaceConfig, agentId: string, projectId: string): WorkspaceConfig {
  const agent = findAgent(config, agentId);
  if (agent.archived) throw invalid('agent_archived', `agent "${agent.id}" is archived; archived agents receive no new work`);
  if (agent.role === 'head') throw invalid('head_has_projects', `"${agent.id}" is a head; a head reaches projects through its workers`);
  findProject(config, projectId);
  if (agent.projectScope === 'restricted' && !agent.projectIds.includes(projectId)) return config;
  const draft = structuredClone(config);
  const target = findAgent(draft, agentId);
  // Removing a project from automatic scope preserves access to other current projects.
  target.projectIds = (agent.projectScope === 'restricted' ? target.projectIds : config.projects.filter((project) => !project.archived).map((project) => project.id)).filter((id) => id !== projectId);
  target.projectScope = 'restricted';
  return draft;
}

// ---------------------------------------------------------------------------
// Import from a v1 agents.json
// ---------------------------------------------------------------------------

export interface ImportV1Input {
  /** The parsed agents.json document; validated here. */
  readonly config: unknown;
  readonly departmentName?: string;
  readonly departmentNote?: string;
}

/**
 * Bring a v1 `agents.json` into the workspace as one new department.
 *
 * The runtimes are copied (a same-named runtime with different settings gets a
 * suffixed id), the configured planner becomes the head when its policy is
 * `analysis`, and every other agent becomes a worker **on no project**:
 * nobody is placed on a project automatically. The file itself is not
 * modified. When the workspace has no agents yet, the v1 limits are adopted.
 */
export function importV1(config: WorkspaceConfig, input: ImportV1Input): WorkspaceConfig {
  let v1: AgentConfigFile;
  try {
    v1 = validateAgentConfig(input.config);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw invalid('invalid_agents_file', `the agents file is invalid (${error.issues.length} issue${error.issues.length === 1 ? '' : 's'})`, error.issues.map((i) => `${i.path}: ${i.message}`));
    }
    throw error;
  }

  let draft = structuredClone(config);
  const runtimeIds = new Map<string, string>();
  for (const [id, runtime] of Object.entries(v1.runtimes)) {
    const existing = draft.runtimes[id];
    if (existing === undefined || canonicalJson(existing) === canonicalJson(runtime)) {
      draft.runtimes[id] = runtime;
      runtimeIds.set(id, id);
      continue;
    }
    let n = 2;
    while (`${id}-${n}` in draft.runtimes) n += 1;
    draft.runtimes[`${id}-${n}`] = runtime;
    runtimeIds.set(id, `${id}-${n}`);
  }

  if (draft.agents.length === 0) {
    const d = v1.defaults;
    draft.limits = {
      ...draft.limits,
      maxActiveTurns: d.maxActiveTurns,
      maxActiveWriters: d.maxActiveWriters,
      maxTasksPerRun: d.maxTasksPerRun,
      maxDelegationDepth: d.maxDelegationDepth,
      maxRepairAttempts: d.maxRepairAttempts,
      maxTransientRetries: d.maxTransientRetries,
      runTimeoutMinutes: d.runTimeoutMinutes,
    };
  }

  const name = (input.departmentName ?? 'Engineering').trim() || 'Engineering';
  let note = input.departmentNote?.trim() || undefined;
  if (note === undefined && draft.departments.some((d) => fold(d.name) === fold(name) && d.note === undefined)) {
    note = 'Imported';
    for (let n = 2; draft.departments.some((d) => fold(d.name) === fold(name) && fold(d.note) === fold(note)); n += 1) note = `Imported ${n}`;
  }
  const before = new Set(draft.departments.map((d) => d.id));
  draft = addDepartment(draft, { name, ...(note !== undefined ? { note } : {}) });
  const departmentId = draft.departments.find((d) => !before.has(d.id))!.id;

  const planner = v1.defaults.plannerAgent;
  for (const agent of v1.agents) {
    let id = agent.id;
    for (let n = 2; isTaken(draft, 'agents', id); n += 1) id = `${agent.id}-${n}`;
    const role = agent.id === planner && agent.policy === 'analysis' ? 'head' : 'worker';
    draft.agents.push({
      id,
      name: agent.id,
      role,
      departmentId,
      runtime: runtimeIds.get(agent.runtime) ?? agent.runtime,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      instructions: agent.instructions,
      capabilities: [...agent.capabilities],
      policy: agent.policy,
      projectIds: [],
      archived: false,
    });
    if (role === 'head') findDepartment(draft, departmentId).headAgentId = id;
  }
  return draft;
}

// ---------------------------------------------------------------------------
// One entry point for the CLI and the server
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const checks = z.array(z.string().trim().min(1).max(500)).max(32);

export const WorkspaceOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('runtime.set'), id: z.string().min(1), adapter: AdapterIdSchema, executable: z.string().min(1), model: ModelSchema.optional(), effort: EffortSchema.optional() }),
  z.strictObject({ op: z.literal('runtime.remove'), id: RuntimeIdSchema }),
  z.strictObject({ op: z.literal('control-center.set'), runtime: RuntimeIdSchema.nullable(), avatarId: AgentAvatarIdSchema.optional(), model: ModelSchema.optional(), effort: EffortSchema.optional(), instructions: z.string().trim().min(1).max(12000).optional(), projectRoutes: ControlCenterConfigSchema.shape.projectRoutes }),
  z.strictObject({ op: z.literal('limits.set'), limits: LimitsPatchSchema }),
  z.strictObject({ op: z.literal('project.add'), repoPath: z.string().min(1), name: text(80).optional(), id: z.string().min(1).optional(), checks: checks.optional() }),
  z.strictObject({ op: z.literal('project.edit'), id: z.string().min(1), name: text(80).optional(), checks: checks.optional(), repoPath: z.string().optional() }),
  z.strictObject({ op: z.literal('project.archive'), id: z.string().min(1) }),
  z.strictObject({ op: z.literal('project.remove'), id: z.string().min(1) }),
  z.strictObject({ op: z.literal('department.add'), name: text(60), note: text(60).optional(), color: z.string().optional(), id: z.string().min(1).optional() }),
  z.strictObject({ op: z.literal('department.edit'), id: z.string().min(1), name: text(60).optional(), note: text(60).nullable().optional(), color: z.string().optional() }),
  z.strictObject({ op: z.literal('department.archive'), id: z.string().min(1) }),
  z.strictObject({ op: z.literal('department.remove'), id: z.string().min(1) }),
  z.strictObject({
    op: z.literal('agent.add'),
    avatarId: AgentAvatarIdSchema.optional(),
    id: z.string().min(1).optional(),
    name: text(60).optional(),
    role: AgentRoleSchema,
    departmentId: z.string().min(1),
    runtime: z.string().min(1),
    model: ModelSchema.optional(),
    effort: EffortSchema.optional(),
    instructions: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
    policy: PolicySchema.optional(),
    projectIds: z.array(z.string().min(1)).max(64).optional(),
    projectScope: AgentProjectScopeSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('agent.edit'),
    avatarId: AgentAvatarIdSchema.nullable().optional(),
    id: z.string().min(1),
    name: text(60).optional(),
    runtime: z.string().min(1).optional(),
    model: ModelSchema.nullable().optional(),
    effort: EffortSchema.nullable().optional(),
    instructions: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
    policy: PolicySchema.optional(),
    departmentId: z.string().min(1).optional(),
    projectIds: z.array(z.string().min(1)).max(64).optional(),
    projectScope: AgentProjectScopeSchema.optional(),
  }),
  z.strictObject({ op: z.literal('agent.archive'), id: z.string().min(1) }),
  z.strictObject({ op: z.literal('agent.assign'), agentId: z.string().min(1), projectId: z.string().min(1) }),
  z.strictObject({ op: z.literal('agent.unassign'), agentId: z.string().min(1), projectId: z.string().min(1) }),
  z.strictObject({ op: z.literal('import.v1'), config: z.unknown(), departmentName: text(60).optional(), departmentNote: text(60).optional() }),
]);
export type WorkspaceOp = z.infer<typeof WorkspaceOpSchema>;

/** Validate untrusted ops (a request body, an ops file). Throws `WorkspaceError` exit 2 naming every issue. */
export function parseWorkspaceOps(input: unknown): WorkspaceOp[] {
  const parsed = z.array(WorkspaceOpSchema).min(1).safeParse(input);
  if (!parsed.success) {
    throw invalid('invalid_ops', 'the workspace change is not valid', parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  return parsed.data;
}

/** Keys whose value may be undefined become optional-and-absent, so the result satisfies exactOptionalPropertyTypes. */
type Stripped<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

function strip<T extends Record<string, unknown>>(value: T): Stripped<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Stripped<T>;
}

export function applyWorkspaceOp(config: WorkspaceConfig, op: WorkspaceOp, context: OpContext = {}): WorkspaceConfig {
  switch (op.op) {
    case 'runtime.set':
      return setRuntime(config, strip({ id: op.id, adapter: op.adapter, executable: op.executable, model: op.model, effort: op.effort }));
    case 'runtime.remove':
      return removeRuntime(config, op.id);
    case 'control-center.set':
      return setControlCenter(config, strip({ runtime: op.runtime, avatarId: op.avatarId, model: op.model, effort: op.effort, instructions: op.instructions, projectRoutes: op.projectRoutes }));
    case 'limits.set':
      return setLimits(config, op.limits);
    case 'project.add':
      return addProject(config, strip({ repoPath: op.repoPath, name: op.name, id: op.id, checks: op.checks }), context);
    case 'project.edit':
      return editProject(config, strip({ id: op.id, name: op.name, checks: op.checks, repoPath: op.repoPath }));
    case 'project.archive':
      return archiveProject(config, op.id);
    case 'project.remove':
      return removeProject(config, op.id, context);
    case 'department.add':
      return addDepartment(config, strip({ name: op.name, note: op.note, color: op.color, id: op.id }));
    case 'department.edit':
      return editDepartment(config, strip({ id: op.id, name: op.name, note: op.note, color: op.color }));
    case 'department.archive':
      return archiveDepartment(config, op.id);
    case 'department.remove':
      return removeDepartment(config, op.id);
    case 'agent.add':
      return addAgent(
        ensureStandardRuntime(config, op.runtime),
        strip({
          id: op.id,
          name: op.name,
          avatarId: op.avatarId,
          role: op.role,
          departmentId: op.departmentId,
          runtime: op.runtime,
          model: op.model,
          effort: op.effort,
          instructions: op.instructions,
          capabilities: op.capabilities,
          policy: op.policy,
          projectIds: op.projectIds,
          projectScope: op.projectScope,
        }),
      );
    case 'agent.edit':
      return editAgent(
        op.runtime !== undefined ? ensureStandardRuntime(config, op.runtime) : config,
        strip({
          id: op.id,
          name: op.name,
          avatarId: op.avatarId,
          runtime: op.runtime,
          model: op.model,
          effort: op.effort,
          instructions: op.instructions,
          capabilities: op.capabilities,
          policy: op.policy,
          departmentId: op.departmentId,
          projectIds: op.projectIds,
          projectScope: op.projectScope,
        }),
      );
    case 'agent.archive':
      return archiveAgent(config, op.id);
    case 'agent.assign':
      return assignAgent(config, op.agentId, op.projectId);
    case 'agent.unassign':
      return unassignAgent(config, op.agentId, op.projectId);
    case 'import.v1':
      // `config` is `unknown`, which strip would make optional; it is required, so it is passed as is.
      return importV1(config, { config: op.config, ...strip({ departmentName: op.departmentName, departmentNote: op.departmentNote }) });
  }
}

/** Apply ops in order. The first refusal stops the whole change; the caller writes nothing. */
export function applyWorkspaceOps(config: WorkspaceConfig, ops: ReadonlyArray<WorkspaceOp>, context: OpContext = {}): WorkspaceConfig {
  return ops.reduce((current, op) => applyWorkspaceOp(current, op, context), config);
}

/** Ids present in `after` and not in `before`, per collection: what a change created. */
export function createdIds(before: WorkspaceConfig, after: WorkspaceConfig): { projects: string[]; departments: string[]; agents: string[] } {
  const diff = (collection: Collection): string[] => {
    const had = new Set(before[collection].map((item) => item.id));
    return after[collection].map((item) => item.id).filter((id) => !had.has(id));
  };
  return { projects: diff('projects'), departments: diff('departments'), agents: diff('agents') };
}
