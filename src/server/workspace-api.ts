/**
 * The workspace routes of the office server: read the workspace, change it,
 * and look at a folder before it becomes a project.
 *
 * Every change goes through the same in-process operations the `workforce
 * workspace` CLI uses (`applyWorkspaceOps` inside `updateWorkspace`), so a
 * refusal reads the same on the page and in a terminal, and every write is
 * zod-validated, compare-and-swap on the revision the page last saw, and a temp
 * file renamed into place. Exit codes map to HTTP: 2 → 400, 3 → 409 (with the
 * fresh revision), 4 → 503.
 *
 * Reads never write: a missing workspace is the empty one at revision 0, and a
 * file that cannot be read is reported with its issues and left as it is.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAgentConfigFile } from '../core/config.js';
import { formatZodIssues } from '../core/contracts.js';
import { CheckConfigurationError, resolveAcceptanceChecks } from '../core/run-direct.js';
import { isToolUsable, validateWorkspace, type WorkspaceConfig } from '../core/workspace-config.js';
import type { RuntimeReadinessReport } from '../discovery/readiness.js';
import { runtimeDescriptor } from '../discovery/runtimes.js';
import { isWithin } from '../storage/paths.js';
import { WorkspaceError } from '../workspace/errors.js';
import { applyWorkspaceOps, createdIds, parseWorkspaceOps, standardRuntimeId, type WorkspaceOp } from '../workspace/operations.js';
import { workspaceFilePath } from '../workspace/paths.js';
import { computeWorkspaceReadiness, toolFacts } from '../workspace/readiness.js';
import { adapterWriteContainment } from '../workspace/roster.js';
import { loadWorkspace, updateWorkspace, type LoadedWorkspace } from '../workspace/store.js';
import { describeDirty, expandHomePath, inspectProject, ProjectInspectionError } from '../workspaces/project.js';
import { ApiError } from './http.js';

/** Passive runtime discovery as the server caches it. */
export type PassiveReadiness = { readonly checkedAt: string; readonly reports: ReadonlyArray<RuntimeReadinessReport> } | { readonly error: string };

/** A workspace refusal as HTTP: exit 2 → 400, 3 → 409, 4 → 503. */
export function httpErrorFromWorkspace(error: WorkspaceError, extra: Readonly<Record<string, unknown>> = {}): ApiError {
  const status = error.exitCode === 2 ? 400 : error.exitCode === 3 ? 409 : 503;
  return new ApiError(status, error.code, error.message, error.details, extra);
}

export interface ReadableWorkspace {
  readonly loaded: LoadedWorkspace | null;
  /** Why the file could not be used; null when it could. */
  readonly error: { readonly code: string; readonly message: string; readonly details: ReadonlyArray<string> } | null;
}

/** Load for a read: an unreadable or invalid file is reported, never thrown and never rewritten. */
export function readWorkspace(stateRoot: string): ReadableWorkspace {
  try {
    return { loaded: loadWorkspace(stateRoot), error: null };
  } catch (error) {
    if (error instanceof WorkspaceError) return { loaded: null, error: { code: error.code, message: error.message, details: [...error.details] } };
    throw error;
  }
}

export function invalidBody(issues: ReadonlyArray<z.core.$ZodIssue>, what = 'the request'): ApiError {
  return new ApiError(400, 'invalid_body', `${what} is not valid`, formatZodIssues(issues).map((issue) => `${issue.path}: ${issue.message}`));
}

function reportsOf(readiness: PassiveReadiness): ReadonlyArray<RuntimeReadinessReport> | null {
  return 'reports' in readiness ? readiness.reports : null;
}

function runtimesView(readiness: PassiveReadiness): Record<string, unknown> {
  if (!('reports' in readiness)) return { passive: true, checkedAt: null, error: readiness.error, reports: [] };
  return {
    passive: true,
    checkedAt: readiness.checkedAt,
    error: null,
    reports: readiness.reports.map((report) => ({
      adapter: report.adapter,
      displayName: report.displayName,
      installed: report.installed,
      adapterSupported: report.adapterSupported,
      auth: report.auth,
      authDetail: report.authDetail,
      readiness: report.readiness,
      version: report.version,
      loginHint: runtimeDescriptor(report.adapter).loginHint,
      usable: isToolUsable(report),
      writeContainment: adapterWriteContainment(report.adapter),
    })),
  };
}

/** Each configured runtime's write containment, and whether a run using it must run on its own (decision Q2). */
function runtimeRules(config: WorkspaceConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config.runtimes).map(([id, runtime]) => {
      const status = adapterWriteContainment(runtime.adapter);
      return [id, { adapter: runtime.adapter, executable: runtime.executable, writeContainment: status, runsOnItsOwn: status !== 'verified' }];
    }),
  );
}

function legacyAgents(stateRoot: string): Record<string, unknown> | null {
  const file = path.join(path.resolve(stateRoot), 'agents.json');
  if (!existsSync(file)) return null;
  let agentCount: number | null = null;
  try {
    agentCount = loadAgentConfigFile(file).config.agents.length;
  } catch {
    agentCount = null;
  }
  return {
    path: file,
    agentCount,
    note: 'an agent configuration from before workspaces. Importing it places nobody on a project.',
    command: `workforce workspace import --agents ${file}`,
  };
}

const STARTER_DEPARTMENT = 'Engineering';

/**
 * The starter department setup offers (decision Q4) once there is a project
 * and no department: Engineering, a head, and one worker placed on that
 * project. The head runs on Codex when Codex is installed and signed in, since
 * Codex's write containment is verified and a department on it can work beside
 * other projects (decision Q2).
 *
 * It is a proposal only: `saved` is false, nothing is written, and applying it
 * is an ordinary `POST /api/workspace/ops` with the ops and revision it names.
 * Ids are explicit, computed against this revision, so what is applied is
 * exactly what was shown.
 */
export function suggestStarter(config: WorkspaceConfig, reports: ReadonlyArray<RuntimeReadinessReport> | null): Record<string, unknown> | null {
  const project = config.projects.find((entry) => !entry.archived);
  if (project === undefined || config.departments.some((department) => !department.archived)) return null;
  const usable = (adapter: string): boolean => reports?.some((report) => report.adapter === adapter && isToolUsable(report)) === true;
  const codexReady = usable('codex');
  const claudeReady = usable('claude-code');
  const tool = codexReady || !claudeReady ? 'codex' : 'claude-code';
  const runtime = standardRuntimeId(tool);
  const reason =
    reports === null
      ? 'The coding tools could not be checked, so this uses Codex, the recommended tool for heads.'
      : codexReady
        ? 'Codex is installed and signed in. Heads are recommended on Codex: its file boundary is verified, so this department can work beside other projects.'
        : claudeReady
          ? 'Codex is not installed and signed in, so this uses Claude Code. Claude Code has no verified file boundary, so a task for this department runs on its own.'
          : 'Neither Codex nor Claude Code is installed and signed in yet. This uses Codex, the recommended tool for heads; install it and sign in before sending work.';

  try {
    const step = (base: WorkspaceConfig, raw: Record<string, unknown>) => {
      const after = applyWorkspaceOps(base, parseWorkspaceOps([raw]));
      return { after, created: createdIds(base, after) };
    };
    const headName = `${STARTER_DEPARTMENT} head`;
    const workerName = `${STARTER_DEPARTMENT} worker`;
    const department = step(config, { op: 'department.add', name: STARTER_DEPARTMENT });
    const departmentId = department.created.departments[0]!;
    const head = step(department.after, { op: 'agent.add', role: 'head', departmentId, runtime, name: headName });
    const headId = head.created.agents[0]!;
    const worker = step(head.after, { op: 'agent.add', role: 'worker', departmentId, runtime, name: workerName, projectIds: [project.id] });
    const workerId = worker.created.agents[0]!;

    const ops = parseWorkspaceOps([
      { op: 'department.add', id: departmentId, name: STARTER_DEPARTMENT },
      { op: 'agent.add', id: headId, name: headName, role: 'head', departmentId, runtime },
      { op: 'agent.add', id: workerId, name: workerName, role: 'worker', departmentId, runtime, projectIds: [project.id] },
    ]);
    const proposed = applyWorkspaceOps(config, ops);
    if (!validateWorkspace({ ...proposed, revision: config.revision + 1 }).ok) return null;
    const adapter = proposed.runtimes[runtime]!.adapter;
    const view = (id: string) => {
      const agent = proposed.agents.find((entry) => entry.id === id)!;
      return { id: agent.id, name: agent.name, role: agent.role, runtime: agent.runtime, adapter, policy: agent.policy, projectIds: agent.projectIds };
    };
    return {
      suggested: true,
      saved: false,
      note: 'A starting point to review. Nothing is saved until you apply it, and you can change anything first.',
      apply: { method: 'POST', path: '/api/workspace/ops', expectRevision: config.revision },
      ops,
      projectId: project.id,
      department: { id: departmentId, name: STARTER_DEPARTMENT, color: proposed.departments.find((entry) => entry.id === departmentId)!.color },
      head: view(headId),
      workers: [view(workerId)],
      runtimeChoice: { tool, codexReady, claudeReady, reason },
      runsOnItsOwn: adapterWriteContainment(adapter) !== 'verified',
    };
  } catch (error) {
    if (error instanceof WorkspaceError) return null;
    throw error;
  }
}

/**
 * `GET /api/workspace`: the document, its revision, readiness (with each
 * project's acceptance checks resolved at its last commit, read-only), passive
 * runtime facts, each runtime's containment rule, and the starter suggestion.
 */
export async function workspaceDocument(stateRoot: string, readiness: PassiveReadiness): Promise<Record<string, unknown>> {
  const file = workspaceFilePath(stateRoot);
  const read = readWorkspace(stateRoot);
  const runtimes = runtimesView(readiness);
  if (read.loaded === null) {
    return {
      ok: true,
      path: file,
      exists: true,
      revision: null,
      schemaVersion: null,
      workspace: null,
      error: read.error,
      readiness: null,
      checks: [],
      runtimes,
      runtimeRules: {},
      suggestedStarter: null,
      legacyAgents: legacyAgents(stateRoot),
    };
  }
  const { config, exists } = read.loaded;
  const reports = reportsOf(readiness);
  const computed = await computeWorkspaceReadiness(config, reports === null ? {} : { tools: toolFacts(reports) });
  return {
    ok: true,
    path: file,
    exists,
    revision: config.revision,
    schemaVersion: config.schemaVersion,
    workspace: config,
    error: null,
    readiness: computed.readiness,
    checks: computed.checks,
    runtimes,
    runtimeRules: runtimeRules(config),
    suggestedStarter: suggestStarter(config, reports),
    legacyAgents: legacyAgents(stateRoot),
  };
}

const WriteBodySchema = z.strictObject({
  expectRevision: z.number().int().min(0),
  ops: z.array(z.unknown()).min(1).max(64),
});

export interface WorkspaceWriteContext {
  readonly stateRoot: string;
  /** True while the project has a live run, from this server's launcher or its coordinator lock. */
  readonly projectBusy: (projectId: string) => boolean;
}

/**
 * What the page sends, made into what the operations expect, exactly as the
 * CLI does it: a standard tool name becomes its runtime id, and a project
 * folder becomes its repository root (and must be a Git repository).
 */
async function normalizeOp(op: WorkspaceOp): Promise<WorkspaceOp> {
  if (op.op === 'agent.add') return { ...op, runtime: standardRuntimeId(op.runtime) };
  if (op.op === 'agent.edit' && op.runtime !== undefined) return { ...op, runtime: standardRuntimeId(op.runtime) };
  if (op.op !== 'project.add') return op;
  const expanded = expandHomePath(op.repoPath);
  if (!path.isAbsolute(expanded)) return op;
  const folder = path.resolve(expanded);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new ApiError(400, 'project_folder_missing', `${folder} is not a folder on this machine`);
  let inspection;
  try {
    inspection = await inspectProject(folder);
  } catch (error) {
    if (error instanceof ProjectInspectionError) throw new ApiError(400, 'not_a_git_repository', error.message);
    throw error;
  }
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new ApiError(400, 'not_a_git_repository', `${folder} is not inside a Git repository; a project is a Git repository`);
  }
  return { ...op, repoPath: inspection.repositoryRoot };
}

/** `POST /api/workspace/ops` `{expectRevision, ops[]}`: apply the ops in order, all or nothing. */
export async function applyWorkspaceWrite(raw: unknown, context: WorkspaceWriteContext): Promise<Record<string, unknown>> {
  const parsed = WriteBodySchema.safeParse(raw);
  if (!parsed.success) throw invalidBody(parsed.error.issues, 'the workspace change');
  let ops: WorkspaceOp[];
  try {
    ops = parseWorkspaceOps(parsed.data.ops);
  } catch (error) {
    if (error instanceof WorkspaceError) throw httpErrorFromWorkspace(error);
    throw error;
  }
  const normalized = await Promise.all(ops.map((op) => normalizeOp(op)));
  const seen: { before: WorkspaceConfig | null } = { before: null };
  try {
    const result = updateWorkspace(
      context.stateRoot,
      (current) => {
        seen.before = current;
        return applyWorkspaceOps(current, normalized, { stateRoot: context.stateRoot, projectHasLiveRun: context.projectBusy });
      },
      { expectRevision: parsed.data.expectRevision },
    );
    return {
      ok: true,
      action: normalized.map((op) => op.op),
      path: result.path,
      previousRevision: result.previousRevision,
      revision: result.revision,
      written: result.written,
      created: seen.before === null ? { projects: [], departments: [], agents: [] } : createdIds(seen.before, result.config),
      workspace: result.config,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw httpErrorFromWorkspace(error, error.exitCode === 3 ? { revision: readWorkspace(context.stateRoot).loaded?.config.revision ?? null } : {});
    }
    throw error;
  }
}

/** The op names a single-op route accepts: `project.add`, `agent.assign`, `import.v1`, ... */
export const OP_NAME_PATTERN = /^[a-z]+\.[a-z0-9]+$/;

/** `POST /api/workspace/ops/<op>` `{expectRevision, ...fields}`: one operation, the same code path. */
export async function applySingleWorkspaceOp(opName: string, raw: unknown, context: WorkspaceWriteContext): Promise<Record<string, unknown>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'invalid_body', 'the workspace change is not valid', ['(root): expected an object with expectRevision and the operation fields']);
  }
  const { expectRevision, ...fields } = raw as Record<string, unknown>;
  return applyWorkspaceWrite({ expectRevision, ops: [{ ...fields, op: opName }] }, context);
}

const noNul = (value: string): boolean => !value.includes('\0');
const InspectBodySchema = z.strictObject({ path: z.string().min(1).max(4096).refine(noNul, 'must not contain a NUL character') });

/**
 * `POST /api/projects/inspect` `{path}`: what a folder is before it becomes a
 * project — Git repository or not, its committed base, a summary of uncommitted
 * changes, and the acceptance checks a run would find at that base. It reads
 * with Git and changes nothing; a folder that is not a usable project is an
 * answer with reasons, not an error. Only a path that is not absolute is refused.
 */
export async function inspectFolder(raw: unknown, stateRoot: string): Promise<Record<string, unknown>> {
  const parsed = InspectBodySchema.safeParse(raw);
  if (!parsed.success) throw invalidBody(parsed.error.issues, 'the inspect request');
  const expanded = expandHomePath(parsed.data.path);
  if (!path.isAbsolute(expanded)) throw new ApiError(400, 'path_not_absolute', 'use an absolute folder path or ~/ for your home folder');
  const folder = path.resolve(expanded);
  const base = { ok: true, path: folder, note: 'read with Git only; nothing was changed and nothing was started' };
  const unusable = (fields: Record<string, unknown>, reason: string) => ({
    ...base,
    exists: true,
    isDirectory: true,
    isGitRepo: false,
    repositoryRoot: null,
    headRevision: null,
    checks: null,
    existingProjectId: null,
    canAdd: false,
    reasons: [reason],
    ...fields,
  });
  if (!existsSync(folder)) return unusable({ exists: false, isDirectory: false }, `${folder} does not exist`);
  if (!statSync(folder).isDirectory()) return unusable({ isDirectory: false }, `${folder} is a file, not a folder`);

  let inspection;
  try {
    inspection = await inspectProject(folder);
  } catch (error) {
    if (error instanceof ProjectInspectionError) return unusable({}, error.message);
    throw error;
  }
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) return unusable({}, `${folder} is not inside a Git repository; a project is a Git repository`);

  const root = inspection.repositoryRoot;
  const head = inspection.headRevision;
  const reasons: string[] = [];
  const existing = readWorkspace(stateRoot).loaded?.config.projects.find((project) => path.resolve(project.repoPath) === root) ?? null;
  if (existing !== null) reasons.push(`${root} is already the project "${existing.id}"`);
  const resolvedStateRoot = path.resolve(stateRoot);
  const overlapsStateRoot = isWithin(root, resolvedStateRoot) || isWithin(resolvedStateRoot, root);
  if (overlapsStateRoot) reasons.push(`${root} overlaps the Workforce state root ${resolvedStateRoot}; a project must not contain Workforce's own state or live inside it`);
  if (head === null) reasons.push(`${root} has no commit yet, so there is no base revision to start work from`);

  let checks: Record<string, unknown> = { count: null, source: null, detail: 'no commit to read checks from', criteria: [], error: null };
  if (head !== null) {
    try {
      const resolved = await resolveAcceptanceChecks(root, head);
      checks = {
        count: resolved.checks.length,
        source: resolved.source,
        detail: resolved.detail,
        criteria: resolved.checks.map((check) => ({ criterionId: check.criterionId, description: check.description ?? null, command: check.command, args: check.args ?? [] })),
        error: null,
      };
    } catch (error) {
      if (!(error instanceof CheckConfigurationError)) throw error;
      checks = { count: null, source: null, detail: error.message, criteria: [], error: { code: `invalid_checks:${error.code}`, message: error.message } };
    }
  }
  const group = (entry: { count: number }) => entry.count;
  return {
    ...base,
    exists: true,
    isDirectory: true,
    isGitRepo: true,
    repositoryRoot: root,
    headRevision: head,
    branch: inspection.branch,
    detachedHead: inspection.detachedHead,
    workingTree: describeDirty(inspection.dirty),
    dirty: {
      clean: inspection.dirty.clean,
      staged: group(inspection.dirty.staged),
      unstaged: group(inspection.dirty.unstaged),
      untracked: group(inspection.dirty.untracked),
      conflicted: group(inspection.dirty.conflicted),
    },
    diagnostics: inspection.diagnostics,
    checks,
    suggestedName: path.basename(root),
    existingProjectId: existing?.id ?? null,
    overlapsStateRoot,
    canAdd: existing === null && !overlapsStateRoot && head !== null,
    reasons,
  };
}
