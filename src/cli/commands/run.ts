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
  type RunStreamIdentity,
} from '../../core/run-direct.js';
import { createPlainRenderer, taskLabel, type PlainRenderer } from '../live/plain.js';
import { createLiveView, type LiveTerminal, type LiveView } from '../live/view.js';
import { MIN_COLUMNS, MIN_ROWS } from '../live/layout.js';
import { runPlanned, type PlannedTaskInput, type RunPlannedResult } from '../../core/run-planned.js';
import { runWithFallback } from '../../recovery/continue.js';
import { describeFallback } from '../../recovery/fallback.js';
import { z } from 'zod';
import { decideRoute, extractDeliverables, type RouteDecision } from '../../routing/index.js';
import { limitsFromDefaults } from '../../core/contracts.js';
import { LockHeldError, LockLostError } from '../../storage/lock.js';
import { openStateStore } from '../../storage/db.js';
import { createStatePaths, PathsManifestSchema, resolveStateRoot } from '../../storage/paths.js';
import { configSearchPath } from './launch.js';
import { ProjectInspectionError } from '../../workspaces/project.js';
import { CandidateWorkspaceError } from '../../workspaces/candidate.js';
import { redactedJson } from '../../telemetry/redaction.js';
import { CliError, EXIT_CODES, statusLabel, type CommandResult, type ExitCode, type Reporter, type Streams } from '../output.js';
import type { HeadPlanner } from '../../workspace/planning.js';
import { commandRunProject } from './run-project.js';

export interface RunCommandArgs {
  readonly capacityTurns?: number;
  readonly capacityWriters?: number;
  /**
   * `--project <id> --department <id>`: a request to a department of the
   * workspace. Mutually exclusive with --repo/--agents; see run-project.ts.
   */
  readonly project?: string;
  readonly department?: string;
  /** Exact capacity reservation for this project request; omitted for the ordinary CLI roster. */
  readonly workerIds?: ReadonlyArray<string>;
  /** Analysis captures reviewed reports with unchanged-source evidence. */
  readonly workKind?: string;
  /** Admission revision. A changed workspace must be admitted again before any model turn. */
  readonly workspaceRevision?: number;
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly attachmentIds?: ReadonlyArray<string>;
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
  /** `--view live|plain`: force or refuse the board. Absent means the ladder in `decideView` decides. */
  readonly view?: string;
  /** `--watch`: print a ready-to-paste `workforce watch` line per planned task before the run starts. */
  readonly watch?: boolean;
  readonly json: boolean;
}

export interface RunCommandDeps {
  readonly reporter: Reporter;
  /** Needed for the JSONL event stream, which bypasses the single-document result writer. */
  readonly streams: Streams;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
  /** stdin, for the live view's keys. Absent means no keys, which is a degrade and not an error. */
  readonly stdin?: NodeJS.ReadStream;
  /**
   * The department head's planner for `--project --department`. Absent means
   * `headPlanningUnavailable`, which refuses rather than guessing a plan.
   */
  readonly headPlanner?: HeadPlanner;
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
 * Which renderer draws this run, decided once, before a byte is written.
 *
 * The ladder is checked in order and every rung is a real destination someone
 * actually has:
 *
 * | # | condition | result |
 * |---|---|---|
 * | 1 | `--json` | plain. stdout is JSONL and must not carry one escape byte. |
 * | 2 | `--view plain` or `WORKFORCE_VIEW=plain` | plain. |
 * | 3 | stdout or stderr is not a TTY (a pipe, `> file`, CI, `tee`) | plain, zero escapes. |
 * | 4 | `TERM` is `dumb` or unset | plain. |
 * | 5 | the terminal is smaller than the board needs | plain, and it says why. |
 * | 6 | fewer than two tasks | plain: a board around one agent is a frame around a log. `--view live` overrides. |
 *
 * `NO_COLOR` is deliberately NOT on this ladder. It is a colour convention,
 * not a cursor convention: the board still draws, in monochrome. Nor is a
 * non-TTY stdin — the keys are simply disabled, with no warning, because a
 * board nobody can steer is still a board worth reading.
 *
 * Rung 6 is why single-task and non-TTY output stay byte-identical to what
 * this command produced before the view existed.
 */
export interface ViewDecision {
  readonly view: 'live' | 'plain';
  /** Present when a live view was possible but declined; printed as one dim line. */
  readonly reason: string | null;
}

export function decideView(input: {
  readonly requested: string | undefined;
  readonly json: boolean;
  readonly taskCount: number;
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ViewDecision {
  const requested = input.requested ?? input.env['WORKFORCE_VIEW'];
  if (requested === 'plain') return { view: 'plain', reason: null };
  if (input.json) return { view: 'plain', reason: null };
  const isTty = (target: unknown): boolean => (target as { isTTY?: unknown } | null | undefined)?.isTTY === true;
  if (!isTty(input.stdout) || !isTty(input.stderr)) return { view: 'plain', reason: null };
  const term = input.env['TERM'];
  if (term === undefined || term === '' || term === 'dumb') return { view: 'plain', reason: null };
  const columns = (input.stderr as { columns?: number }).columns ?? 80;
  const rows = (input.stderr as { rows?: number }).rows ?? 24;
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return { view: 'plain', reason: `live view off: this terminal is ${columns}x${rows}; the board needs ${MIN_COLUMNS}x${MIN_ROWS}` };
  }
  if (requested === 'live') return { view: 'live', reason: null };
  if (input.taskCount < 2) return { view: 'plain', reason: null };
  return { view: 'live', reason: null };
}

export interface RendererOptions {
  /** `--view live|plain`; `WORKFORCE_VIEW` is consulted when this is absent. */
  readonly view?: string;
  /** How many tasks this run will dispatch. One means no board. */
  readonly taskCount?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: NodeJS.ReadStream;
}

/** The renderer plus, when there is one, the live view whose terminal must be restored. */
export interface Renderer {
  readonly stream: RunStream;
  /** Null in plain mode. Non-null exactly when the alternate screen is in use. */
  readonly view: LiveView | null;
  /** Restore the terminal and replay, or stop the plain renderer's heartbeat. Idempotent. */
  finish(): void;
}

export function createRenderer(reporter: Reporter, streams: Streams, options: RendererOptions = {}): Renderer {
  const env = options.env ?? process.env;
  const decision = decideView({
    requested: options.view,
    json: reporter.json,
    taskCount: options.taskCount ?? 1,
    stdout: streams.stdout,
    stderr: streams.stderr,
    env,
  });
  if (decision.reason !== null) reporter.diagnostic(decision.reason);
  if (decision.view === 'plain') {
    const plain: PlainRenderer = createPlainRenderer(reporter, streams);
    return { stream: plain, view: null, finish: () => plain.dispose() };
  }
  const live = createLiveView({
    streams,
    terminal: streams.stderr as unknown as LiveTerminal,
    env,
    restoreOnExit: true,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
  });
  return { stream: live, view: live, finish: () => live.leave() };
}

/**
 * Progress rendering. In human mode every line goes to stdout. With --json
 * stdout carries one JSON object per line (JSONL) and the human lines become
 * stderr diagnostics, so stdout stays machine-readable end to end.
 *
 * Kept under its original name and signature because `cli/index.ts` and the
 * stream-identity tests both import it. It is now the plain rung of
 * `createRenderer`.
 */
export function createRunStream(reporter: Reporter, streams: Streams): RunStream {
  return createPlainRenderer(reporter, streams);
}

export { taskLabel };

/**
 * A stream that, the first time it sees `run.created`, writes one ready-to-paste
 * `workforce watch` line per planned task.
 *
 * A wrapper rather than a branch inside the renderers: the hint is a property
 * of this invocation (`--watch`), not of how the run happens to be drawn, and
 * both renderers should show it the same way.
 */
export function withWatchHints(stream: RunStream, keys: ReadonlyArray<string>): RunStream {
  let printed = false;
  return {
    ...stream,
    event: (record) => {
      stream.event(record);
      if (printed || record.type !== 'run.created' || typeof record['runId'] !== 'string') return;
      printed = true;
      const runId = record['runId'];
      stream.line('attach one agent in another terminal:');
      for (const key of keys) stream.line(`  workforce watch ${runId} --task ${key}`);
    },
  };
}

export async function commandRun(args: RunCommandArgs, deps: RunCommandDeps): Promise<CommandResult> {
  // A request to a department is its own path; the single-file form below is
  // untouched by it.
  if (args.project !== undefined || args.department !== undefined) return commandRunProject(args, deps);
  if (args.capacityTurns !== undefined || args.capacityWriters !== undefined || args.workerIds !== undefined || args.workspaceRevision !== undefined || args.workKind !== undefined) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_selection_required', '--worker, --workspace-revision and --work-kind require --project and --department');
  }
  // Validate every input before touching state: an invalid invocation must
  // exit 2 without creating a state root or taking the coordinator lock.
  const repo = requireRepo(args.repo);
  // `--agents` is not the only way to say where the configuration is. The
  // launcher already knows the places one lives — the state root, the
  // repository, the home directory — and a user who has a config in one of
  // them should not have to name it on every run. The flag still wins when it
  // is given; this only removes the need to repeat what is already true.
  //
  // The home directory is deliberately NOT a separate candidate here. The
  // state root already defaults to ~/.workforce, so a config living there is
  // found anyway — while an explicit --state-dir means "use this coordinator
  // state, not this machine's default", and a discovery that reached past it
  // into the real home directory would make a run depend on whatever the
  // machine happens to have. That is also what keeps the tests honest.
  const stateRoot = resolveStateRoot(args.stateDir);
  const configPath =
    args.agents ??
    configSearchPath({ env: process.env, repoRoot: repo, stateRoot, homeDir: stateRoot }).find((candidate) => existsSync(candidate.path))?.path;
  if (configPath === undefined) {
    throw new CliError(EXIT_CODES.invalidInput, 'missing_agents', 'no agent configuration was found', [
      `looked in: ${stateRoot}/agents.json and ${repo}/.workforce/agents.json`,
      'pass --agents <file>, set WORKFORCE_AGENTS, or run `workforce` with no arguments to have one written for the runtimes you have installed',
    ]);
  }
  const loaded = loadConfigOrFail(configPath);
  if (args.attachmentIds?.length) throw new CliError(EXIT_CODES.invalidInput, 'attachment_project_required', '--attachment requires a saved --project and --department so uploads resolve in the correct workspace.');
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
    // The renderer is chosen from the task count, which is only known here.
    const renderer = createRenderer(deps.reporter, deps.streams, {
      taskCount: plannedTasks.length,
      ...(args.view !== undefined ? { view: args.view } : {}),
      ...(deps.stdin !== undefined ? { stdin: deps.stdin } : {}),
    });
    // `--watch` prints the commands ready to paste rather than describing
    // them, because "the commands and the steps are too hard" is the whole
    // complaint. They can only be printed once the run id exists, which is
    // when `run.created` arrives — and they go through the stream, not around
    // it, so in the live view they land in the run lane and in the replay
    // rather than corrupting the board's screen.
    const stream = args.watch === true ? withWatchHints(renderer.stream, plannedTasks.map((task) => task.key)) : renderer.stream;
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
        stream,
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
      // The terminal is restored and the transcript replayed BEFORE the
      // result document is written, so the verdict lands under the history
      // that produced it rather than into a buffer about to be discarded.
      renderer.finish();
      store.close();
    }
    return plannedCommandResult(planned, paths.root, route);
  }

  // The direct path dispatches one task, so the ladder resolves to plain
  // unless `--view live` says otherwise: a board around one agent is a frame
  // around a log.
  const directRenderer = createRenderer(deps.reporter, deps.streams, {
    taskCount: 1,
    ...(args.view !== undefined ? { view: args.view } : {}),
    ...(deps.stdin !== undefined ? { stdin: deps.stdin } : {}),
  });
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
      stream: directRenderer.stream,
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
    directRenderer.finish();
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

/** `route` is null for a department run, whose path is decided by its head rather than by the router. */
export function plannedCommandResult(planned: RunPlannedResult, stateRoot: string, route: RouteDecision | null): CommandResult {
  const exitCode: ExitCode =
    planned.outcome === 'accepted' ? EXIT_CODES.verifiedCandidate : planned.outcome === 'interrupted' ? EXIT_CODES.interrupted : EXIT_CODES.executionFailure;
  const combined =
    planned.combination === null || planned.combination.status === 'refused'
      ? null
      : { revision: planned.combination.combinedRevision, order: planned.combination.order, acceptance: planned.combination.acceptance };
  const data: Record<string, unknown> = {
    runId: planned.runId,
    path: 'planned',
    ...(route !== null ? { route: { path: route.path, reason: route.reason, signals: route.signals } } : {}),
    outcome: planned.outcome,
    runState: planned.runState,
    accepted: planned.accepted,
    ...(planned.workKind ? { workKind: planned.workKind, analysisReviewed: planned.analysisReviewed === true } : {}),
    reason: planned.reason,
    stateRoot,
    runDir: planned.runDir,
    manifest: planned.manifestPath,
    base: planned.baseRevision,
    tasks: planned.tasks.map((task) => ({ key: task.key, taskId: task.taskId, objective: task.objective, accepted: task.accepted, repairsUsed: task.repairsUsed, attempts: task.attempts.length })),
    combined,
    review: planned.review,
    headReview: planned.headReview ?? null,
    finalReply: planned.finalReply ?? null,
    unresolved: planned.unresolved,
  };
  const lines: string[] = [
    `run ${planned.runId}: ${planned.analysisReviewed ? 'reviewed analysis' : planned.outcome} (planned, ${planned.tasks.length} tasks)`,
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

export function toCliError(error: unknown): CliError {
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
    // Exit 3 means "a human has to do something outside this tool, and no
    // retry will help". A signed-out runtime is that condition exactly: it is
    // fixed by an interactive login and by nothing else. Reporting it as 4
    // made it indistinguishable from a crashed provider or broken code, so a
    // wrapper that branches on the exit code could never prompt for the login.
    const userAction = error.code === 'runtime_not_logged_in';
    if (userAction) return new CliError(EXIT_CODES.userActionRequired, error.code, error.message);
    const invalid =
      error.code === 'write_boundary_untested_version' ||
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
