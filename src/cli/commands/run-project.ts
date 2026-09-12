/**
 * `workforce run --project <id> --department <id>` — a request to a department.
 *
 * The workspace decides everything the legacy form takes as flags: the
 * repository comes from the project, the agents from the department's roster
 * (its head plus its workers placed on that project), the checks from the
 * project, and the state from the project's own state root
 * (`<state-root>/projects/<id>`), so two projects never share a database, a
 * lock or a candidate path.
 *
 * Order, so that every refusal happens before anything costly:
 *   1. flags, task text, workspace, roster, project folder, committed base and
 *      acceptance checks — all refused with exit 2 and no state written;
 *   2. the project's coordinator lock (a run already in progress: exit 4);
 *   3. the roster snapshot, a v1 configuration of ONLY the roster, which the
 *      run records as its configuration, so resume and fallback stay on it;
 *   4. the department head plans (src/routing/head-planner.ts): it proposes
 *      tasks through its planning tool inside a new run, code validates them,
 *      and a refusal ends that run with the reason and starts no worker;
 *   5. the head's tasks, each owned by one roster worker, through runPlanned
 *      in the same run.
 */
import { existsSync, statSync } from 'node:fs';
import { CheckConfigurationError, resolveAcceptanceChecks } from '../../core/run-direct.js';
import { runPlanned, type RunPlannedResult } from '../../core/run-planned.js';
import { openStateStore } from '../../storage/db.js';
import { LockHeldError } from '../../storage/lock.js';
import { resolveStateRoot } from '../../storage/paths.js';
import { WorkspaceError } from '../../workspace/errors.js';
import { projectStatePaths } from '../../workspace/paths.js';
import { createHeadPlanner } from '../../routing/head-planner.js';
import { headTaskIssues, type HeadPlanner } from '../../workspace/planning.js';
import { buildRoster, rosterAgentConfig, writeRosterSnapshot, type Roster } from '../../workspace/roster.js';
import { loadWorkspace } from '../../workspace/store.js';
import { inspectProject, ProjectInspectionError } from '../../workspaces/project.js';
import { CliError, EXIT_CODES, type CommandResult } from '../output.js';
import { createRenderer, plannedCommandResult, requireTaskText, toCliError, withWatchHints, type RunCommandArgs, type RunCommandDeps } from './run.js';

function fromWorkspaceError(error: WorkspaceError, details: ReadonlyArray<string> = []): CliError {
  return new CliError(error.exitCode, error.code, error.message, [...error.details, ...details]);
}

export async function commandRunProject(args: RunCommandArgs, deps: RunCommandDeps & { readonly headPlanner?: HeadPlanner }): Promise<CommandResult> {
  // ---- 1. Everything that can be refused without touching state ----------
  const conflicting = (
    [
      ['--repo', args.repo],
      ['--agents', args.agents],
      ['--agent', args.agent],
      ['--plan', args.plan],
      ['--path', args.path],
      ['--check', args.checks],
      ['--workspace-root', args.workspaceRoot],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([flag]) => flag);
  if (conflicting.length > 0) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_mode_conflict', `--project and --department cannot be combined with ${conflicting.join(', ')}`, [
      "a department run takes its repository from the project, its agents from the department's roster and its checks from the project",
      'the single-file form is unchanged: workforce run --repo <path> --agents <file> --task <text>',
    ]);
  }
  if (args.project === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_project', '--department needs --project <id>: a request goes to one department on one project');
  if (args.department === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_department', '--project needs --department <id>: all work goes through a department head');
  const task = requireTaskText(args);

  const stateRoot = resolveStateRoot(args.stateDir);
  let roster: Roster;
  let workspace;
  try {
    workspace = loadWorkspace(stateRoot);
    if (args.workspaceRevision !== undefined) {
      if (!Number.isSafeInteger(args.workspaceRevision) || args.workspaceRevision < 0) {
        throw new CliError(EXIT_CODES.invalidInput, 'invalid_workspace_revision', '--workspace-revision must be a non-negative safe integer');
      }
      if (workspace.config.revision !== args.workspaceRevision) {
        throw new CliError(EXIT_CODES.userActionRequired, 'admission_workspace_changed', `the workspace changed after admission (reserved revision ${args.workspaceRevision}, current revision ${workspace.config.revision}); no head or worker was started`, [
          'Send the request again so the coordinator can reserve the current available workers.',
        ]);
      }
    }
    roster = buildRoster(workspace.config, { projectId: args.project, departmentId: args.department, ...(args.workerIds !== undefined ? { workerIds: args.workerIds } : {}) });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const noFile = workspace !== undefined && !workspace.exists ? [`there is no workspace at ${workspace.path} yet; build one with "workforce workspace" (see workforce --help)`] : [];
      throw fromWorkspaceError(error, noFile);
    }
    throw error;
  }
  const project = roster.project;

  if (!existsSync(project.repoPath) || !statSync(project.repoPath).isDirectory()) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_unavailable', `the folder of project "${project.id}" (${project.repoPath}) does not exist`);
  }
  let inspection;
  try {
    inspection = await inspectProject(project.repoPath);
  } catch (error) {
    if (error instanceof ProjectInspectionError) throw new CliError(EXIT_CODES.invalidInput, 'project_unavailable', `project "${project.id}": ${error.message}`);
    throw error;
  }
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_unavailable', `project "${project.id}" (${project.repoPath}) is not a Git repository`);
  }
  if (inspection.headRevision === null) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_unavailable', `project "${project.id}" (${inspection.repositoryRoot}) has no commit, so there is no base revision to start from`);
  }
  const repoRoot = inspection.repositoryRoot;
  const baseRevision = inspection.headRevision;

  const checkFlags = [...project.checks];
  let checkCount: number;
  let checkDetail: string;
  try {
    const resolved = await resolveAcceptanceChecks(repoRoot, baseRevision, checkFlags);
    checkCount = resolved.checks.length;
    checkDetail = resolved.detail;
  } catch (error) {
    if (error instanceof CheckConfigurationError) throw new CliError(EXIT_CODES.invalidInput, `invalid_checks:${error.code}`, `project "${project.id}": ${error.message}`);
    throw error;
  }
  if (checkCount === 0) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_has_no_checks', `project "${project.id}" has no acceptance check, so nothing could verify the result: ${checkDetail}`, [
      `add one: workforce workspace project edit ${project.id} --check "npm test"`,
      'or commit .workforce/checks.json to the repository',
    ]);
  }

  let rosterConfig;
  try {
    rosterConfig = rosterAgentConfig(workspace.config, roster);
  } catch (error) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_roster', `the roster of department "${roster.department.id}" on project "${project.id}" does not form a valid configuration: ${(error as Error).message}`);
  }

  // ---- 2. The project's own coordinator lock ------------------------------
  const paths = projectStatePaths(stateRoot, project.id);
  let store;
  try {
    store = openStateStore(paths, { mode: 'mutating' });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError(EXIT_CODES.executionFailure, 'project_run_in_progress', `project "${project.id}" already has a run in progress; a project runs one request at a time`, [error.message]);
    }
    throw error;
  }

  let planned: RunPlannedResult;
  let snapshotPath: string;
  let plan: { summary: string | null; attempts: number | null } = { summary: null, attempts: null };
  try {
    // ---- 3. The roster, recorded before anyone is asked to do anything ----
    const snapshot = writeRosterSnapshot(paths, roster, rosterConfig);
    snapshotPath = snapshot.path;
    deps.reporter.info(`workspace ${workspace.path} (revision ${workspace.config.revision})`);
    deps.reporter.info(`project ${project.id} · department ${roster.department.id} · head ${roster.head.id} · workers ${roster.workers.map((w) => w.id).join(', ')}`);
    deps.reporter.info(`acceptance: ${checkDetail}`);

    // ---- 4. The head decides ---------------------------------------------
    const planner = deps.headPlanner ?? createHeadPlanner();
    const planningRenderer = createRenderer(deps.reporter, deps.streams, { taskCount: 1, view: 'plain' });
    let outcome;
    try {
      outcome = await planner({
        requestText: task.text,
        requestSource: task.source,
        repoPath: repoRoot,
        baseRevision,
        workspace: workspace.config,
        roster,
        snapshot,
        paths,
        db: store.db,
        ...(store.lock !== null ? { ownership: store.lock } : {}),
        checkFlags,
        maxTasksPerRun: rosterConfig.defaults.maxTasksPerRun,
        allowUnconfinedWrites: args.allowUnconfinedWrites === true,
        stream: planningRenderer.stream,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
        ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
      });
    } finally {
      planningRenderer.finish();
    }
    if (!outcome.ok) throw new CliError(outcome.exitCode ?? EXIT_CODES.executionFailure, outcome.code, outcome.reason, outcome.details ?? []);
    plan = { summary: outcome.summary, attempts: outcome.attempts ?? null };
    // Enforced whatever planner produced the tasks: a planner is never trusted.
    const issues = headTaskIssues(roster, outcome.tasks, rosterConfig.defaults.maxTasksPerRun);
    if (issues.length > 0) {
      if (outcome.run !== undefined) await outcome.run.abandon('failed', `the head's plan was refused, so no worker was started: ${issues.join('; ')}`, { refusal: 'plan_rejected' });
      throw new CliError(EXIT_CODES.executionFailure, 'plan_rejected', `the head's plan was refused, so no worker was started`, issues);
    }

    // ---- 5. The workers ---------------------------------------------------
    const tasks = outcome.tasks.map((t) => ({
      key: t.key,
      objective: t.objective,
      agentId: t.agentId,
      ...(t.taskId !== undefined ? { taskId: t.taskId } : {}),
      ...(t.dependencies !== undefined && t.dependencies.length > 0 ? { dependencies: [...t.dependencies] } : {}),
      ...(t.writer !== undefined ? { writer: t.writer } : {}),
    }));
    const renderer = createRenderer(deps.reporter, deps.streams, {
      taskCount: tasks.length,
      ...(args.view !== undefined ? { view: args.view } : {}),
      ...(deps.stdin !== undefined ? { stdin: deps.stdin } : {}),
    });
    const stream = args.watch === true ? withWatchHints(renderer.stream, tasks.map((t) => t.key)) : renderer.stream;
    try {
      planned = await runPlanned({
        repoPath: repoRoot,
        config: rosterConfig,
        configRaw: snapshot.raw,
        configPath: snapshot.path,
        requestText: task.text,
        requestSource: task.source,
        headReview: { headAgentId: roster.head.id, required: true },
        tasks,
        paths,
        db: store.db,
        stream,
        ...(store.lock !== null ? { ownership: store.lock } : {}),
        ...(outcome.run !== undefined ? { run: outcome.run } : {}),
        ...(checkFlags.length > 0 ? { checkFlags } : {}),
        ...(args.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
        ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
      });
    } finally {
      renderer.finish();
    }
  } catch (error) {
    throw toCliError(error);
  } finally {
    store.close();
  }

  const result = plannedCommandResult(planned, paths.root, null);
  return {
    ...result,
    data: {
      ...result.data,
      workspace: { path: workspace.path, revision: workspace.config.revision },
      project: project.id,
      department: roster.department.id,
      head: roster.head.id,
      workers: roster.workers.map((worker) => worker.id),
      rosterSnapshot: snapshotPath,
      plan,
    },
  };
}
