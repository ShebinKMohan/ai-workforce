/**
 * `workforce run` — the R0 direct path.
 *
 * This command owns the coordinator lock for the duration of the run. It
 * validates configuration and inputs before taking the lock or creating any
 * state, so an invalid invocation exits 2 without side effects.
 *
 * Output:
 * - human mode: a progress line per meaningful step on stdout;
 * - `--json`: JSONL — one JSON object per line, the normalized events first
 *   and the final result object last, so a consumer can stream it.
 *
 * Exit codes: 0 for a verified candidate, 2 for invalid input or
 * configuration, 4 for an execution or validation failure, 130 when
 * interrupted after the interruption was persisted and owned processes were
 * stopped.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ContractValidationError } from '../../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../../core/config.js';
import {
  AdapterNotRegisteredError,
  CheckConfigurationError,
  RunSetupError,
  runDirect,
  type AdapterFactory,
  type RunDirectResult,
  type RunStream,
} from '../../core/run-direct.js';
import { runPlanned, type PlannedTaskInput, type RunPlannedResult } from '../../core/run-planned.js';
import { runWithFallback } from '../../recovery/continue.js';
import { describeFallback } from '../../recovery/fallback.js';
import { z } from 'zod';
import { decideRoute, extractDeliverables, type RouteDecision } from '../../routing/index.js';
import { limitsFromDefaults } from '../../core/contracts.js';
import { LockHeldError, LockLostError } from '../../storage/lock.js';
import { openStateStore } from '../../storage/db.js';
import { createStatePaths, PathsManifestSchema, resolveStateRoot } from '../../storage/paths.js';
import { ProjectInspectionError } from '../../workspaces/project.js';
import { CandidateWorkspaceError } from '../../workspaces/candidate.js';
import { redactedJson } from '../../telemetry/redaction.js';
import { CliError, EXIT_CODES, statusLabel, type CommandResult, type ExitCode, type Reporter, type Streams } from '../output.js';

export interface RunCommandArgs {
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly stateDir?: string;
  /** Candidate workspace root; defaults to `<state-root>/workspaces`. */
  readonly workspaceRoot?: string;
  readonly agent?: string;
  readonly checks?: ReadonlyArray<string>;
  /**
   * `--allow-unconfined-writes`: proceed with a writing profile on a runtime
   * that enforces no write boundary. A per-run human decision, never a
   * configuration default (plan section 8).
   */
  readonly allowUnconfinedWrites?: boolean;
  /** `--path direct|planned`: override what the router decided. */
  readonly path?: string;
  /**
   * `--plan <file>`: a JSON plan naming the tasks and the dependencies between
   * them. This is the only way to express a task graph: the request-derived
   * decomposition deliberately invents no dependencies.
   */
  readonly plan?: string;
  readonly json: boolean;
}

export interface RunCommandDeps {
  readonly reporter: Reporter;
  /** Needed for the JSONL event stream, which bypasses the single-document result writer. */
  readonly streams: Streams;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

function loadConfigOrFail(file: string): LoadedAgentConfig {
  try {
    return loadAgentConfigFile(file);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new CliError(
        EXIT_CODES.invalidInput,
        'invalid_config',
        `agent configuration ${file} is invalid (${error.issues.length} issue${error.issues.length === 1 ? '' : 's'})`,
        error.issues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }
    throw error;
  }
}

export function requireRepo(repo: string | undefined): string {
  if (repo === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_repo', '--repo <path> is required');
  const absolute = path.resolve(repo);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_repo', `--repo ${absolute} is not a directory`);
  }
  return absolute;
}

export function requireTaskText(args: RunCommandArgs): { text: string; source: string } {
  if (args.task !== undefined && args.taskFile !== undefined) {
    throw new CliError(EXIT_CODES.invalidInput, 'ambiguous_task', 'pass either --task or --task-file, not both');
  }
  if (args.task !== undefined) {
    if (args.task.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'empty_task', '--task text is empty');
    return { text: args.task, source: 'argument' };
  }
  if (args.taskFile !== undefined) {
    const file = path.resolve(args.taskFile);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new CliError(EXIT_CODES.invalidInput, 'unreadable_task_file', `cannot read --task-file ${file}: ${(error as Error).message}`);
    }
    if (text.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'empty_task', `--task-file ${file} is empty`);
    return { text, source: file };
  }
  throw new CliError(EXIT_CODES.invalidInput, 'missing_task', 'one of --task <text> or --task-file <file> is required');
}

/**
 * Progress rendering. In human mode every line goes to stdout. With --json
 * stdout carries one JSON object per line (JSONL) and the human lines become
 * stderr diagnostics, so stdout stays machine-readable end to end.
 */
export function createRunStream(reporter: Reporter, streams: Streams): RunStream {
  return {
    line: (text: string) => reporter.info(text),
    event: (record) => {
      if (reporter.json) streams.stdout.write(`${redactedJson(record)}\n`);
    },
  };
}

export async function commandRun(args: RunCommandArgs, deps: RunCommandDeps): Promise<CommandResult> {
  // Validate every input before touching state: an invalid invocation must
  // exit 2 without creating a state root or taking the coordinator lock.
  const repo = requireRepo(args.repo);
  if (args.agents === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_agents', '--agents <file> is required');
  const loaded = loadConfigOrFail(args.agents);
  const task = requireTaskText(args);
  if (args.agent !== undefined && !loaded.config.agents.some((agent) => agent.id === args.agent)) {
    throw new CliError(
      EXIT_CODES.invalidInput,
      'unknown_agent',
      `--agent "${args.agent}" is not defined in ${loaded.path}`,
      [`configured agents: ${loaded.config.agents.map((agent) => `"${agent.id}"`).join(', ')}`],
    );
  }

  const paths = createStatePaths(resolveStateRoot(args.stateDir), args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {});
  // The paths manifest is written once, on the state root's first use. An
  // existing state root that records a different workspace root would make the
  // manifest a lie, so say so instead of silently writing somewhere else.
  if (args.workspaceRoot !== undefined && existsSync(paths.manifestPath)) {
    const recorded = PathsManifestSchema.safeParse(JSON.parse(readFileSync(paths.manifestPath, 'utf8')));
    if (recorded.success && path.resolve(recorded.data.workspaceRoot) !== paths.workspaceRoot) {
      throw new CliError(
        EXIT_CODES.invalidInput,
        'workspace_root_mismatch',
        `state root ${paths.root} already records workspace root ${recorded.data.workspaceRoot}; --workspace-root ${paths.workspaceRoot} disagrees with it`,
        ['use a different --state-dir for a different workspace root, or drop --workspace-root'],
      );
    }
  }
  let store;
  try {
    store = openStateStore(paths, { mode: 'mutating' });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError(EXIT_CODES.executionFailure, 'coordinator_lock_held', error.message, [
        'only one mutating coordinator may own a state root; "workforce status <run-id>" works read-only while a run is in progress',
      ]);
    }
    throw error;
  }

  // ---- Routing (FR021) -------------------------------------------------
  // The direct path is the default and stays the default. The planned path is
  // taken only when the request itself carries more than one deliverable AND
  // the router says so, because a decomposition nobody asked for is a way to
  // turn one bounded task into several unbounded ones.
  if (args.path !== undefined && args.path !== 'direct' && args.path !== 'planned') {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_path', `--path must be "direct" or "planned", not "${args.path}"`);
  }
  // A plan file is an explicit instruction, so it decides the path.
  const planFile = args.plan === undefined ? null : readPlanFile(args.plan);
  const route = decideRoute({
    request: {
      text: task.text,
      ...(planFile !== null ? { forcePath: 'planned' as const } : args.path === 'direct' || args.path === 'planned' ? { forcePath: args.path } : {}),
    },
    project: { repoPath: repo },
    agents: loaded.config.agents.map((agent) => ({ id: agent.id, capabilities: [...agent.capabilities], policy: agent.policy })),
    limits: { maxTasksPerRun: limitsFromDefaults(loaded.config.defaults).maxTasksPerRun },
    defaults: {
      workerAgent: loaded.config.defaults.workerAgent,
      ...(loaded.config.defaults.plannerAgent !== undefined ? { plannerAgent: loaded.config.defaults.plannerAgent } : {}),
    },
  });
  deps.reporter.info(`route: ${route.path} — ${route.reason}`);

  const plannedTasks = planFile !== null ? planFile : route.path === 'planned' ? decomposeRequest(task.text) : [];
  if (route.path === 'planned' && planFile === null && plannedTasks.length < 2) {
    // The router wanted a plan but the request does not yield one that can be
    // built without a planner runtime. Say so and take the proven path rather
    // than inventing a decomposition.
    deps.reporter.info('note: no plan with more than one task could be derived from the request without a planner runtime; running the direct path');
  }

  if (planFile !== null || (route.path === 'planned' && plannedTasks.length >= 2)) {
    let planned: RunPlannedResult;
    try {
      planned = await runPlanned({
        repoPath: repo,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: task.text,
        requestSource: task.source,
        tasks: plannedTasks,
        paths,
        db: store.db,
        stream: createRunStream(deps.reporter, deps.streams),
        ...(store.lock !== null ? { ownership: store.lock } : {}),
        ...(args.agent !== undefined ? { agentId: args.agent } : {}),
        ...(args.checks !== undefined ? { checkFlags: args.checks } : {}),
        ...(args.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
        ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
      });
    } catch (error) {
      throw toCliError(error);
    } finally {
      store.close();
    }
    return plannedCommandResult(planned, paths.root, route);
  }

  let result: RunDirectResult;
  let fallbackNote: string | null = null;
  try {
    const continued = await runWithFallback({
      repoPath: repo,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: task.text,
      requestSource: task.source,
      paths,
      db: store.db,
      stream: createRunStream(deps.reporter, deps.streams),
      ...(store.lock !== null ? { ownership: store.lock } : {}),
      ...(args.agent !== undefined ? { agentId: args.agent } : {}),
      ...(args.checks !== undefined ? { checkFlags: args.checks } : {}),
      ...(args.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
    });
    result = continued.result;
    if (continued.fallback !== null) {
      fallbackNote = describeFallback(continued.fallback);
      deps.reporter.info(fallbackNote);
      if (continued.note !== null) deps.reporter.info(`  ${continued.note}`);
    }
  } catch (error) {
    throw toCliError(error);
  } finally {
    store.close();
  }

  const exitCode: ExitCode =
    result.outcome === 'accepted' ? EXIT_CODES.verifiedCandidate : result.outcome === 'interrupted' ? EXIT_CODES.interrupted : EXIT_CODES.executionFailure;

  const data: Record<string, unknown> = {
    runId: result.runId,
    taskId: result.taskId,
    attemptId: result.attemptId,
    outcome: result.outcome,
    taskState: result.taskState,
    runState: result.runState,
    accepted: result.acceptance.accepted,
    stateRoot: paths.root,
    runDir: result.runDir,
    manifest: result.manifestPath,
    summary: result.summaryPath,
    patch: result.patchPath,
    base: result.manifest.base,
    candidate: result.manifest.candidate,
    requirements: result.manifest.requirements,
    timing: result.manifest.timing,
    usage: result.manifest.usage,
    unresolved: result.manifest.unresolved,
  };

  data['route'] = { path: 'direct', reason: route.reason, signals: route.signals };
  if (fallbackNote !== null) data['fallback'] = fallbackNote;
  data['coordination'] = result.coordination;

  const lines: string[] = [
    `run ${result.runId}: ${result.outcome}`,
    `task ${result.taskId}: ${result.taskState}`,
    ...result.manifest.requirements.map((requirement) => `  ${statusLabel(requirement.status)} ${requirement.criterionId}: ${requirement.detail}`),
    `evidence and manifest: ${result.runDir}`,
  ];
  if (result.manifest.unresolved.length > 0) {
    lines.push('unresolved:');
    for (const item of result.manifest.unresolved) lines.push(`  - ${item}`);
  }

  return { command: 'run', exitCode, data, lines };
}

/**
 * Turn a multi-deliverable request into tasks, without a planner runtime.
 *
 * This is deliberately literal: the deliverables the user enumerated become
 * the tasks, in the order they wrote them, with no invented dependencies and
 * no invented scope. It is not a planner, and it does not pretend to be one —
 * when a request does not enumerate its deliverables, it yields nothing and
 * the run takes the direct path.
 */
const PlanFileSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(64),
        objective: z.string().min(1),
        dependencies: z.array(z.string().min(1)).default([]),
        agentId: z.string().min(1).optional(),
        writer: z.boolean().optional(),
      }),
    )
    .min(1),
});

/**
 * Read `--plan <file>`: the explicit task graph.
 *
 * The request-derived decomposition never invents dependencies, so this is
 * how a caller says "t2 needs t1 first". Validated here, before the lock is
 * taken, so a malformed plan exits 2 with no state written.
 */
export function readPlanFile(file: string): PlannedTaskInput[] {
  const absolute = path.resolve(file);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new CliError(EXIT_CODES.invalidInput, 'unreadable_plan_file', `cannot read --plan ${absolute}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_plan_file', `--plan ${absolute} is not valid JSON: ${(error as Error).message}`);
  }
  const result = PlanFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      EXIT_CODES.invalidInput,
      'invalid_plan_file',
      `--plan ${absolute} is not a valid plan`,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data.tasks.map((task) => ({
    key: task.key,
    objective: task.objective,
    ...(task.dependencies.length > 0 ? { dependencies: task.dependencies } : {}),
    ...(task.agentId !== undefined ? { agentId: task.agentId } : {}),
    ...(task.writer !== undefined ? { writer: task.writer } : {}),
  }));
}

export function decomposeRequest(text: string): PlannedTaskInput[] {
  const deliverables = extractDeliverables(text);
  if (deliverables.length < 2) return [];
  return deliverables.map((objective, index) => ({ key: `t${index + 1}`, objective }));
}

function plannedCommandResult(planned: RunPlannedResult, stateRoot: string, route: RouteDecision): CommandResult {
  const exitCode: ExitCode =
    planned.outcome === 'accepted' ? EXIT_CODES.verifiedCandidate : planned.outcome === 'interrupted' ? EXIT_CODES.interrupted : EXIT_CODES.executionFailure;
  const combined =
    planned.combination === null || planned.combination.status === 'refused'
      ? null
      : { revision: planned.combination.combinedRevision, order: planned.combination.order, acceptance: planned.combination.acceptance };
  const data: Record<string, unknown> = {
    runId: planned.runId,
    path: 'planned',
    route: { path: route.path, reason: route.reason, signals: route.signals },
    outcome: planned.outcome,
    runState: planned.runState,
    accepted: planned.accepted,
    reason: planned.reason,
    stateRoot,
    runDir: planned.runDir,
    manifest: planned.manifestPath,
    base: planned.baseRevision,
    tasks: planned.tasks.map((task) => ({ key: task.key, taskId: task.taskId, objective: task.objective, accepted: task.accepted, repairsUsed: task.repairsUsed, attempts: task.attempts.length })),
    combined,
    review: planned.review,
    unresolved: planned.unresolved,
  };
  const lines: string[] = [
    `run ${planned.runId}: ${planned.outcome} (planned, ${planned.tasks.length} tasks)`,
    ...planned.tasks.map((task) => `  ${statusLabel(task.accepted ? 'passed' : 'failed')} ${task.key}: ${task.objective}${task.repairsUsed > 0 ? ` (after ${task.repairsUsed} repair(s))` : ''}`),
  ];
  if (combined !== null) {
    lines.push(`combined candidate ${combined.revision.slice(0, 12)}: ${combined.acceptance.accepted ? 'accepted' : 'not accepted'} — ${combined.acceptance.reason}`);
  }
  lines.push(`evidence and manifest: ${planned.runDir}`);
  if (planned.unresolved.length > 0) {
    lines.push('unresolved:');
    for (const item of planned.unresolved) lines.push(`  - ${item}`);
  }
  return { command: 'run', exitCode, data, lines };
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof LockLostError) {
    return new CliError(EXIT_CODES.executionFailure, 'coordinator_ownership_lost', error.message, [
      'the coordinator lock stopped excluding other coordinators mid-run; whatever was written is preserved, but this run cannot claim it owned the state root',
    ]);
  }
  if (error instanceof AdapterNotRegisteredError) {
    return new CliError(EXIT_CODES.executionFailure, 'adapter_not_registered', error.message);
  }
  if (error instanceof CheckConfigurationError) {
    return new CliError(EXIT_CODES.invalidInput, `invalid_checks:${error.code}`, error.message);
  }
  if (error instanceof RunSetupError) {
    const invalid =
      error.code === 'not_a_git_repository' ||
      error.code === 'no_committed_base' ||
      error.code === 'unknown_agent' ||
      error.code === 'unsupported_runtime_setting' ||
      error.code === 'write_boundary_unsupported' ||
      error.code === 'no_acceptance_checks' ||
      error.code === 'empty_plan' ||
      error.code === 'duplicate_task_key' ||
      error.code === 'unknown_dependency' ||
      error.code === 'self_dependency' ||
      error.code === 'dependency_cycle' ||
      error.code === 'task_budget_exceeded';
    return new CliError(invalid ? EXIT_CODES.invalidInput : EXIT_CODES.executionFailure, error.code, error.message);
  }
  if (error instanceof ProjectInspectionError) {
    return new CliError(EXIT_CODES.invalidInput, error.code, error.message);
  }
  if (error instanceof CandidateWorkspaceError) {
    return new CliError(EXIT_CODES.executionFailure, error.code, error.message);
  }
  return new CliError(EXIT_CODES.executionFailure, 'run_failed', (error as Error).message ?? String(error));
}
