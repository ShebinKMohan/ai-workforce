/**
 * The planned path: more than one task in one run.
 *
 * This is the composition layer over the pieces WP06-WP08 built. It owns
 * nothing the direct path owns — each task still goes through `runDirect`,
 * which means each task still gets its own candidate workspace, its own
 * verifier-executed checks and its own honest acceptance decision.
 *
 * What this file adds is the part a single task does not need:
 *
 * - one coordination bridge for the whole run, so every worker speaks to the
 *   same coordinator and every message is persisted before it is acted on;
 * - a scheduler that decides which tasks may run, bounded by `maxActiveTurns`
 *   and `maxActiveWriters`;
 * - a bounded repair loop when a task's checks fail;
 * - a single integration owner that combines the approved artifacts and
 *   re-runs the checks against the COMBINED revision.
 *
 * The last one carries the rule this whole path exists for: a run of tasks
 * that each passed on their own branch is not an accepted run. Acceptance is
 * decided against the combined candidate, by receipts bound to the combined
 * revision. Per-task receipts are carried as context and establish nothing.
 *
 * Two lifecycle rules matter for Stop and Resume:
 *
 * - An interruption ends the run `interrupted`, never `failed`. `failed` is
 *   terminal and a resume refuses it, so a stopped request would otherwise be
 *   unrecoverable. Once the signal is aborted no further task is dispatched.
 * - The plan is recorded (`runs/<id>/plan.json`) before any task is
 *   dispatched, so `continuePlannedRun` can finish the same plan: accepted
 *   tasks are kept, the rest run under their own assignees, and the combined
 *   candidate is checked again before anything is accepted.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  type AgentConfigFile,
  type Limits,
  type Policy,
  RUN_REQUEST_VERSION,
  limitsFromDefaults,
  validateRunRequest,
} from './contracts.js';
import { newId, nowIso } from './ids.js';
import { computeAgentSnapshot, sha256Hex } from './snapshot.js';
import {
  RUN_MANIFEST_VERSION,
  RunSetupError,
  SILENT_STREAM,
  listFilesAtRevision,
  resolveAcceptanceChecks,
  type AdapterFactory,
  type ResolvedChecks,
  type RunDirectResult,
  type RunOutcome,
  type RunStream,
  type TaskStream,
} from './run-direct.js';
import { forTask } from './run-stream.js';
import { createCoordinationBridge, type CoordinationBridge, type MessageRecord } from '../coordination/index.js';
import { appendEvent } from '../storage/events.js';
import { ensureRunDir, type StatePaths } from '../storage/paths.js';
import { beginNewGeneration, getRun, insertRun, transitionRun } from '../storage/records.js';
import { registerProject } from '../workspaces/project.js';
import { inspectProject } from '../workspaces/project.js';
import { createScheduler, type ScheduleTask } from '../routing/schedule.js';
import {
  combineArtifacts,
  type ApprovedArtifact,
  type CombineResult,
} from '../integration/combine.js';
import {
  applyReviewToAcceptance,
  changeShapeFromDiff,
  decideReview,
  requestReview,
  type ReviewDecision,
  type ReviewOutcome,
  type Reviewer,
} from '../integration/review.js';
import { RepairSession } from '../integration/repair.js';
import { runWithFallback } from '../recovery/continue.js';
import { describeFallback } from '../recovery/fallback.js';
import { parkTaskForDispatch } from '../recovery/resume.js';
import type { CheckReceipt, CheckSpec } from '../verification/checks.js';
import { reviewWithHead, headReviewResumeBlocker, type HeadReviewPolicy, type HeadReviewOutcome } from '../routing/head-reviewer.js';

export const PLANNED_MANIFEST_VERSION = 1 as const;

/** One task of a planned run. Ids are minted here unless the plan supplies one; the plan supplies the shape. */
export interface PlannedTaskInput {
  /** Stable key used for dependencies. Not the task id. */
  readonly key: string;
  readonly objective: string;
  /** Keys of tasks that must be accepted before this one may be dispatched. */
  readonly dependencies?: ReadonlyArray<string>;
  /** Worker agent for this task; defaults to the run's agent. */
  readonly agentId?: string;
  /** False for a task that reads but does not write; it needs no writer slot. */
  readonly writer?: boolean;
  /**
   * The task id to use. A head's plan mints its task ids when it records the
   * assignment, so `head.assigned` and the task row name the same task.
   */
  readonly taskId?: string;
}

export interface RunPlannedInput {
  readonly repoPath: string;
  readonly config: AgentConfigFile;
  readonly configRaw: string;
  readonly configPath: string;
  readonly requestText: string;
  readonly requestSource: string;
  readonly tasks: ReadonlyArray<PlannedTaskInput>;
  readonly contextRefs?: ReadonlyArray<string>;
  readonly agentId?: string;
  readonly checkFlags?: ReadonlyArray<string>;
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly stream?: RunStream;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
  readonly ownership?: { assertOwnership(): void };
  readonly allowUnconfinedWrites?: boolean;
  readonly runDeadlineMs?: number;
  readonly keepCheckCopies?: boolean;
  /** Reviewer for the combined candidate. Without one, review is decided and recorded but not performed. */
  readonly reviewer?: Reviewer;
  readonly coordinationEnabled?: boolean;
  /** Review requested by configuration rather than by the change's shape. */
  readonly reviewRequested?: boolean;
  /** Workspace delivery additionally requires its frozen department head's semantic review. */
  readonly headReview?: HeadReviewPolicy;
  /**
   * Execute the tasks inside a run that `createPlannedRun` already created
   * (a department head planned inside it). Without it the run is created here.
   */
  readonly run?: PlannedRun;
}

export interface PlannedTaskResult {
  readonly key: string;
  readonly taskId: string;
  readonly objective: string;
  readonly accepted: boolean;
  /** Every attempt made for this task, the repairs last. */
  readonly attempts: ReadonlyArray<RunDirectResult>;
  /** The attempt whose candidate is offered for integration; null when none was accepted. */
  readonly approved: RunDirectResult | null;
  readonly repairsUsed: number;
  /** True when the task stopped because the run was interrupted, not because its work failed. */
  readonly interrupted: boolean;
}

export interface RunPlannedResult {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly runState: string;
  readonly runDir: string;
  readonly baseRevision: string;
  readonly tasks: ReadonlyArray<PlannedTaskResult>;
  /** Null when the run never reached integration (a task failed, or nothing was produced). */
  readonly combination: CombineResult | null;
  readonly reviewDecision: ReviewDecision | null;
  readonly review: ReviewOutcome | null;
  readonly headReview?: HeadReviewOutcome | null;
  readonly finalReply?: string | null;
  /** True only when the COMBINED candidate's own receipts satisfied every required criterion. */
  readonly accepted: boolean;
  readonly reason: string;
  readonly manifestPath: string;
  readonly unresolved: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

export interface PlannedRunSetup {
  /** Resume a head's unassigned request under the caller's reconciled ownership. */
  readonly existingRunId?: string;
  readonly repoPath: string;
  readonly config: AgentConfigFile;
  readonly configRaw: string;
  readonly configPath: string;
  readonly requestText: string;
  readonly requestSource: string;
  readonly contextRefs?: ReadonlyArray<string>;
  readonly agentId?: string;
  readonly checkFlags?: ReadonlyArray<string>;
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly stream?: RunStream;
  readonly coordinationEnabled?: boolean;
  /**
   * The number of tasks, checked against `maxTasksPerRun` before anything is
   * written. Null when a department head will decide the tasks inside the run.
   */
  readonly taskCount: number | null;
}

/** A created planned run: its row, directory, checks and bridge, before any task is dispatched. */
export interface PlannedRun {
  readonly runId: string;
  readonly runDir: string;
  readonly createdAt: string;
  readonly projectRoot: string;
  readonly baseRevision: string;
  readonly checks: ResolvedChecks;
  readonly limits: Limits;
  /** The run's default worker agent. */
  readonly agentId: string;
  readonly contextRefs: ReadonlyArray<string>;
  readonly bridge: CoordinationBridge | null;
  /** Run-level unresolved issues. Everything that happens inside the run appends here. */
  readonly unresolved: string[];
  /**
   * End a run that will never dispatch a task (a head's plan was refused, or
   * the run was stopped while the head planned): the reason is recorded as an
   * event and in the manifest, the run reaches the given state, the bridge is
   * closed. Nothing is ever integrated.
   */
  abandon(outcome: 'failed' | 'interrupted', reason: string, extra?: Record<string, unknown>): Promise<RunPlannedResult>;
  /** Idempotent. */
  closeBridge(): Promise<void>;
}

/**
 * Create a planned run: inspect the project, resolve the acceptance checks at
 * the base revision, write the run row, its request and configuration
 * snapshot, and start the run's coordination bridge. Refusals throw
 * `RunSetupError` before anything is written.
 */
export async function createPlannedRun(setup: PlannedRunSetup): Promise<PlannedRun> {
  const stream = setup.stream ?? SILENT_STREAM;
  const { db, paths } = setup;
  const contextRefs = [...(setup.contextRefs ?? [])];

  const inspection = await inspectProject(setup.repoPath);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new RunSetupError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository`);
  }
  if (inspection.headRevision === null) {
    throw new RunSetupError('no_committed_base', `${inspection.repositoryRoot} has no commits; there is no committed base revision to start from`);
  }
  const projectRoot = inspection.repositoryRoot;
  const existing = setup.existingRunId === undefined ? null : getRun(db, setup.existingRunId);
  if (existing !== null && (existing.state !== 'running' || existing.repo_path !== projectRoot || existing.base_revision !== inspection.headRevision)) {
    throw new RunSetupError('planning_resume_base_changed', 'the pending planning run must be owned, running, and on its original repository revision; restore that revision or submit a new request');
  }
  const baseRevision = inspection.headRevision;

  const agentId = setup.agentId ?? setup.config.defaults.workerAgent;
  if (!setup.config.agents.some((agent) => agent.id === agentId)) {
    throw new RunSetupError('unknown_agent', `agent "${agentId}" is not defined in ${setup.configPath}`);
  }
  const snapshot = computeAgentSnapshot(setup.config, agentId);
  const policy: Policy = snapshot.binding.policy;
  const limits: Limits = limitsFromDefaults(setup.config.defaults);

  if (setup.taskCount !== null && setup.taskCount > limits.maxTasksPerRun) {
    throw new RunSetupError(
      'task_budget_exceeded',
      `the plan has ${setup.taskCount} tasks but maxTasksPerRun is ${limits.maxTasksPerRun}; the budget is refused before any work starts, not after`,
    );
  }

  // The acceptance checks are resolved once, at the base revision, and are the
  // same for every task and for the combined candidate. That is what makes the
  // combined result comparable to the per-task ones.
  const resolvedChecks = await resolveAcceptanceChecks(projectRoot, baseRevision, setup.checkFlags ?? []);
  if (resolvedChecks.checks.length === 0) {
    throw new RunSetupError('no_acceptance_checks', `${resolvedChecks.detail}. A run cannot be accepted without independently executed evidence.`);
  }
  await listFilesAtRevision(projectRoot, baseRevision);

  const runId = existing?.id ?? newId();
  const createdAt = existing?.created_at ?? nowIso();
  ensureRunDir(paths, runId);
  const runDir = paths.runDir(runId);
  const request = validateRunRequest({
    requestVersion: RUN_REQUEST_VERSION,
    runId,
    text: setup.requestText,
    contextRefs,
    repoPath: projectRoot,
    baseMode: 'head',
    submittedAt: createdAt,
  });
  if (existing === null) {
    const project = registerProject(db, { inspection, dataLocation: paths.root, checks: resolvedChecks.checks, now: createdAt });
    insertRun(db, { request, policy, limits, projectId: project.id, baseRevision, now: createdAt });
    writeFileSync(paths.runRequestPath(runId), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      paths.runConfigSnapshotPath(runId),
      `${JSON.stringify({ configPath: setup.configPath, agentId, snapshotHash: snapshot.hash, binding: snapshot.binding, raw: JSON.parse(setup.configRaw) as unknown }, null, 2)}\n`,
      { mode: 0o600 },
    );
    appendEvent(db, {
      runId,
      type: 'run.created',
      payload: {
        repoPath: projectRoot,
        baseRevision,
        agentId,
        path: 'planned',
        taskCount: setup.taskCount,
        checkSource: resolvedChecks.source,
        ...(setup.taskCount === null ? { planning: 'head' } : {}),
      },
      timestamp: createdAt,
    });
    transitionRun(db, runId, 'running');
  }

  stream.line(`run ${runId} (planned, ${setup.taskCount === null ? 'tasks decided by the department head' : `${setup.taskCount} tasks`})`);
  stream.line(`repo ${projectRoot} @ ${baseRevision.slice(0, 12)}`);
  stream.line(`acceptance: ${resolvedChecks.detail}`);
  stream.event({ type: 'run.created', runId, path: 'planned', taskCount: setup.taskCount, repo: projectRoot, baseRevision });

  const unresolved: string[] = [];
  const bridge = setup.coordinationEnabled === false ? null : await startRunBridge(paths, db, runId, stream, unresolved);

  const run: PlannedRun = {
    runId,
    runDir,
    createdAt,
    projectRoot,
    baseRevision,
    checks: resolvedChecks,
    limits,
    agentId,
    contextRefs,
    bridge,
    unresolved,
    closeBridge: closerFor(bridge),
    abandon: async (outcome, reason, extra = {}) => {
      try {
        transitionRun(db, runId, outcome);
      } catch {
        // Already moved on; the manifest still records why this run ends here.
      }
      appendEvent(db, { runId, type: `run.${outcome}`, payload: { reason, tasksDispatched: 0, ...extra } });
      stream.line(`${outcome === 'interrupted' ? 'interrupted' : 'not accepted'}: ${reason}`);
      stream.event({ type: `run.${outcome}`, runId, accepted: false, reason });
      await run.closeBridge();
      const manifestPath = writePlannedManifest(runDir, {
        runId,
        createdAt,
        request: { text: setup.requestText, source: setup.requestSource, contextRefs },
        base: { revision: baseRevision, repoPath: projectRoot },
        accepted: false,
        reason,
        tasks: [],
        combination: null,
        review: null,
        reviewDecision: null,
        unresolved,
        ...extra,
      });
      stream.line(`evidence and manifest: ${runDir}`);
      return {
        runId,
        outcome: outcome === 'interrupted' ? 'interrupted' : 'failed',
        runState: getRun(db, runId).state,
        runDir,
        baseRevision,
        tasks: [],
        combination: null,
        reviewDecision: null,
        review: null,
        accepted: false,
        reason,
        manifestPath,
        unresolved,
      };
    },
  };
  return run;
}

/**
 * One bridge for the whole run.
 *
 * A message that will not reach anyone is a fact about the run, not a detail
 * of one task: the sender is told at once by the coordinator, and the same
 * fact is put in front of the operator here and kept in the run's unresolved
 * list. Recorded by message id, so a retried send does not say it twice.
 */
async function startRunBridge(paths: StatePaths, db: DatabaseSync, runId: string, stream: RunStream, unresolved: string[]): Promise<CoordinationBridge | null> {
  const undeliverable = new Set<string>();
  try {
    const bridge = await createCoordinationBridge({
      stateRoot: paths.root,
      runId,
      db,
      onNotice: (notice) => {
        if (undeliverable.has(notice.messageId)) return;
        undeliverable.add(notice.messageId);
        stream.line(`coordination: a message from ${notice.senderTaskId ?? 'the coordinator'} to ${notice.recipientTaskId ?? 'the coordinator'} was refused: ${notice.detail}`);
        stream.event({ type: 'coordination.delivery_failed', messageId: notice.messageId, code: notice.code, from: notice.senderTaskId, to: notice.recipientTaskId });
        unresolved.push(
          `a coordination message (${notice.messageId}) from ${notice.senderTaskId ?? 'the coordinator'} to ${notice.recipientTaskId ?? 'the coordinator'} was never delivered (${notice.code}): ${notice.detail}`,
        );
      },
    });
    stream.line(`coordination: ${bridge.socketPath}`);
    return bridge;
  } catch (error) {
    unresolved.push(`no coordination bridge was started for this run (${(error as Error).message}); its workers had no channel to the coordinator`);
    stream.line(`note: the coordination bridge could not start: ${(error as Error).message}`);
    return null;
  }
}

function closerFor(bridge: CoordinationBridge | null): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed || bridge === null) return;
    closed = true;
    try {
      await bridge.close();
    } catch {
      // The socket is gone either way; a close failure is not a run outcome.
    }
  };
}

function writePlannedManifest(runDir: string, body: Record<string, unknown>): string {
  const manifestPath = path.join(runDir, 'planned-result.json');
  writeFileSync(manifestPath, `${JSON.stringify({ manifestVersion: PLANNED_MANIFEST_VERSION, path: 'planned', ...body }, null, 2)}\n`, { mode: 0o600 });
  return manifestPath;
}

// ---------------------------------------------------------------------------
// The plan record (what resume continues)
// ---------------------------------------------------------------------------

export const PLAN_RECORD_VERSION = 1 as const;

const PlanRecordSchema = z.object({
  planRecordVersion: z.literal(PLAN_RECORD_VERSION),
  runId: z.string().min(1),
  tasks: z
    .array(
      z.object({
        key: z.string().min(1),
        taskId: z.string().min(1),
        objective: z.string().min(1),
        agentId: z.string().min(1),
        dependencies: z.array(z.string().min(1)),
        writer: z.boolean(),
      }),
    )
    .min(1),
  /** The `--check` values the run was started with (a project's configured checks); absent when they came from the repository. */
  checkFlags: z.array(z.string().min(1)).optional(),
  headReview: z.object({ headAgentId: z.string().min(1), required: z.literal(true), deadlineMs: z.number().int().positive().max(300_000).optional() }).optional(),
});
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export function planRecordPath(paths: StatePaths, runId: string): string {
  return path.join(paths.runDir(runId), 'plan.json');
}

/** The plan a planned run recorded before dispatching anything; null for a run that has none (a direct run, or a run from before plans were recorded). */
export function readPlanRecord(paths: StatePaths, runId: string): PlanRecord | null {
  const file = planRecordPath(paths, runId);
  if (!existsSync(file)) return null;
  try {
    const parsed = PlanRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success && parsed.data.runId === runId ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Run a plan.
 *
 * The run row, the run directory and the coordination bridge are created here
 * (or were created by `createPlannedRun`) and belong to the whole run; each
 * task then goes through `runDirect` with a slot naming its place in the run.
 */
export async function runPlanned(input: RunPlannedInput): Promise<RunPlannedResult> {
  try {
    validateTaskList(input.tasks);
  } catch (error) {
    // A run a head already planned in must not be left `running` by a plan
    // this function refuses.
    if (input.run !== undefined && error instanceof RunSetupError) await input.run.abandon('failed', error.message, { refusal: error.code });
    throw error;
  }

  let run: PlannedRun;
  if (input.run === undefined) {
    run = await createPlannedRun({ ...input, taskCount: input.tasks.length });
  } else {
    run = input.run;
    if (input.tasks.length > run.limits.maxTasksPerRun) {
      const message = `the plan has ${input.tasks.length} tasks but maxTasksPerRun is ${run.limits.maxTasksPerRun}; the budget is refused before any work starts, not after`;
      await run.abandon('failed', message, { refusal: 'task_budget_exceeded' });
      throw new RunSetupError('task_budget_exceeded', message);
    }
  }
  return executePlan({ input, run, tasks: input.tasks, preAccepted: new Map(), continuation: false });
}

function validateTaskList(tasks: ReadonlyArray<PlannedTaskInput>): void {
  if (tasks.length === 0) {
    throw new RunSetupError('empty_plan', 'a planned run needs at least one task; an empty plan is not a run');
  }
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) throw new RunSetupError('duplicate_task_key', `task key "${task.key}" appears twice in the plan`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (!keys.has(dependency)) {
        throw new RunSetupError('unknown_dependency', `task "${task.key}" depends on "${dependency}", which is not in the plan`);
      }
      if (dependency === task.key) {
        throw new RunSetupError('self_dependency', `task "${task.key}" depends on itself; it could never be dispatched`);
      }
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle !== null) {
    // A cycle is refused here rather than discovered by the scheduler. The
    // scheduler would block the cycled tasks and the run would finish with
    // them silently missing; a plan that cannot be executed is not a run.
    throw new RunSetupError('dependency_cycle', `the plan has a dependency cycle (${cycle.join(' -> ')}); no task in it could ever be dispatched`);
  }
}

type ExecuteInput = Omit<RunPlannedInput, 'tasks' | 'run'>;

interface ExecuteContext {
  readonly input: ExecuteInput;
  readonly run: PlannedRun;
  readonly tasks: ReadonlyArray<PlannedTaskInput>;
  /** Tasks already accepted before this execution (a resume), with the artifact each one produced. */
  readonly preAccepted: ReadonlyMap<string, ApprovedArtifact | null>;
  /** True when this finishes a plan an earlier process started. */
  readonly continuation: boolean;
}

async function executePlan(context: ExecuteContext): Promise<RunPlannedResult> {
  const { input, run, tasks, preAccepted } = context;
  const stream = input.stream ?? SILENT_STREAM;
  const { db } = input;
  const { runId, runDir, bridge, unresolved, limits, projectRoot, baseRevision } = run;
  const contextRefs = run.contextRefs;
  const resolvedChecks = run.checks;
  const aborted = (): boolean => input.signal?.aborted === true;

  const taskIds = new Map<string, string>(tasks.map((task) => [task.key, task.taskId ?? newId()]));
  const byKey = new Map<string, PlannedTaskInput>(tasks.map((task) => [task.key, task]));
  const results = new Map<string, PlannedTaskResult>();
  const agentOf = (task: PlannedTaskInput): string => task.agentId ?? input.agentId ?? run.agentId;

  // ---- The plan, recorded before anything is dispatched -----------------
  if (!context.continuation || !existsSync(planRecordPath(input.paths, runId))) {
    const record: PlanRecord = {
      planRecordVersion: PLAN_RECORD_VERSION,
      runId,
      tasks: tasks.map((task) => ({
        key: task.key,
        taskId: taskIds.get(task.key)!,
        objective: task.objective,
        agentId: agentOf(task),
        dependencies: [...(task.dependencies ?? [])],
        writer: task.writer ?? true,
      })),
      ...(input.checkFlags !== undefined && input.checkFlags.length > 0 ? { checkFlags: [...input.checkFlags] } : {}),
      ...(input.headReview ? { headReview: input.headReview } : {}),
    };
    const raw = `${JSON.stringify(record, null, 2)}\n`;
    writeFileSync(planRecordPath(input.paths, runId), raw, { mode: 0o600 });
    appendEvent(db, { runId, type: 'plan.registered', payload: { taskCount: tasks.length, sha256: sha256Hex(raw), keys: tasks.map((task) => task.key), ...(input.headReview ? { headReview: input.headReview } : {}) } });
  }

  for (const [key] of preAccepted) {
    const task = byKey.get(key);
    if (task === undefined) continue;
    results.set(key, { key, taskId: taskIds.get(key)!, objective: task.objective, accepted: true, attempts: [], approved: null, repairsUsed: 0, interrupted: false });
  }

  try {
    // ---- Scheduling ------------------------------------------------------
    const scheduleTasks: ScheduleTask[] = tasks.map((task) => ({
      id: task.key,
      agentId: agentOf(task),
      ...(task.dependencies !== undefined && task.dependencies.length > 0
        ? { dependencies: task.dependencies.map((dependency) => ({ taskId: dependency, kind: 'completion' as const })) }
        : {}),
      ...(task.writer !== undefined ? { writer: task.writer } : {}),
    }));
    const scheduler = createScheduler(scheduleTasks, { maxActiveTurns: limits.maxActiveTurns, maxActiveWriters: limits.maxActiveWriters });
    // Work accepted before this process started is done: it releases its
    // dependents and is never dispatched again.
    for (const [key] of preAccepted) if (byKey.has(key)) scheduler.complete(key);

    let failedKey: string | null = null;
    const interruptedKeys: string[] = [];
    /** One task's outcome, carried out of its own promise so a rejection is that task's failure. */
    interface Settlement {
      readonly key: string;
      readonly result: PlannedTaskResult | null;
      readonly error: Error | null;
    }
    const inFlight = new Map<string, Promise<Settlement>>();
    /** The per-task stream of every dispatched task, so a line written about a task after it settled still names it. */
    const taskStreams = new Map<string, TaskStream>();

    // A dispatched task becomes an in-flight promise immediately. There is no
    // join across dispatched tasks: the loop below reacts to the FIRST one to
    // settle, so a satisfied prerequisite releases its dependent while every
    // unrelated task is still running (FR031/FR032, AT09). Concurrency is
    // still bounded — the scheduler hands out turn and writer slots and only
    // frees one when `complete`/`fail` records that task — and only the
    // repository-mutating setup is serialized, inside `withRepositoryLock`.
    //
    // Every dispatched task gets its OWN stream. Handing them all the run's
    // shared one is what made concurrent output unreadable: N workers wrote
    // into one flat stream and nothing in a line said who wrote it. The
    // derived stream stamps this task's identity on every record and line, and
    // is closed when the task settles so a renderer knows how many tasks are
    // live at any moment.
    //
    // The whole dispatch round is opened before any of it is started, so a
    // renderer knows two tasks are about to speak before the first one does.
    // Opening each stream at the moment its task starts would leave the first
    // task's opening line looking like run-level output.
    const open = (key: string): void => {
      const task = byKey.get(key)!;
      const taskId = taskIds.get(key)!;
      const ownerAgentId = agentOf(task);
      // A task an earlier process already dispatched is continued as a new
      // attempt generation of the same task row.
      if (context.continuation) prepareTaskForContinuation(db, taskId);
      // The plan key is what a human wrote and what every line of output calls
      // this task, but until now it existed only in memory: the tasks table
      // stores an objective and an owner, never a key. A second terminal
      // therefore had no way to say `--task docs`. This is that name, made
      // durable, once per dispatched task.
      appendEvent(db, { runId, taskId, type: 'task.registered', payload: { key, agentId: ownerAgentId, objective: task.objective } });
      taskStreams.set(key, forTask(stream, { runId, taskId, key, agentId: ownerAgentId }));
    };

    /**
     * Why each task that is not running is not running.
     *
     * Derived from the scheduler's own state, never guessed: a pending task
     * whose dependencies are unsatisfied is waiting on those tasks; one whose
     * dependencies ARE satisfied is waiting on a slot, and which slot is
     * decided the same way `dispatch()` decides it. A `queued` row that cannot
     * name what it is waiting for is exactly the idle-looking output this
     * exists to remove, so nothing here reports a reason it cannot support.
     */
    const describeBlocked = (): Array<{ key: string; waitingOn: string[]; reason: 'dependency' | 'worker_busy' | 'turn_slot' | 'writer_slot' }> => {
      const snapshot = scheduler.snapshot();
      const out: Array<{ key: string; waitingOn: string[]; reason: 'dependency' | 'worker_busy' | 'turn_slot' | 'writer_slot' }> = [];
      for (const task of tasks) {
        const state = snapshot.states[task.key];
        if (state !== 'pending' && state !== 'waiting') continue;
        const unsatisfied = (task.dependencies ?? []).filter((dependency) => results.get(dependency)?.accepted !== true);
        if (unsatisfied.length > 0 || !scheduler.isReady(task.key)) {
          out.push({ key: task.key, waitingOn: [...unsatisfied], reason: 'dependency' });
          continue;
        }
        const workerTask = scheduler.runningTaskForAgent(agentOf(task));
        if (workerTask !== undefined) {
          out.push({ key: task.key, waitingOn: [workerTask], reason: 'worker_busy' });
          continue;
        }
        const writer = task.writer ?? true;
        const reason = writer && snapshot.activeWriters >= limits.maxActiveWriters ? 'writer_slot' : 'turn_slot';
        out.push({ key: task.key, waitingOn: [...snapshot.running], reason });
      }
      return out;
    };

    const start = (key: string): void => {
      const task = byKey.get(key)!;
      const taskStream = taskStreams.get(key)!;
      inFlight.set(
        key,
        (async (): Promise<Settlement> => {
          try {
            return {
              key,
              result: await runTaskWithRepair({
                input,
                runId,
                runDir,
                key,
                task,
                taskId: taskIds.get(key)!,
                limits,
                bridge,
                // Read at start, not at dispatch-round time: by now every
                // dependency this task named has already been recorded.
                briefing: briefingFor(task, results),
                peers: tasks
                  .filter((peer) => peer.key !== key)
                  .map((peer) => ({ key: peer.key, taskId: taskIds.get(peer.key)!, objective: peer.objective })),
                stream: taskStream,
                acquireFallbackAgent: (agentId) => {
                  // The frozen project config also contains its head. Planning
                  // and review identities never become replacement workers.
                  if (agentId === input.config.defaults.plannerAgent || agentId === input.config.defaults.reviewerAgent) return null;
                  return scheduler.tryAcquireAgent(key, agentId);
                },
              }),
              error: null,
            };
          } catch (error) {
            // One task throwing is that task failing, not the run dying with
            // no manifest: the run still has to finish and record what it did.
            return { key, result: null, error: error instanceof Error ? error : new Error(String(error)) };
          } finally {
            taskStream.close();
          }
        })(),
      );
    };

    const record = (entry: Settlement): void => {
      if (entry.error !== null || entry.result === null) {
        const detail = entry.error?.message ?? 'the task produced no result';
        // A task that threw because the run was being stopped was interrupted,
        // not failed: its work is not judged, and a resume runs it again.
        const stoppedByInterruption = aborted();
        unresolved.push(
          stoppedByInterruption
            ? `task "${entry.key}" was stopped by the interruption before it could be assessed: ${detail}`
            : `task "${entry.key}" ended with an error before it could be assessed: ${detail}`,
        );
        (taskStreams.get(entry.key) ?? stream).line(`task "${entry.key}" ${stoppedByInterruption ? 'was interrupted' : 'failed'}: ${detail}`);
        // A task's terminal state is stated, never inferred. Without this a
        // live view would have to guess "accepted" from a closed stream plus
        // a trailing check receipt, and then present the guess as fact — the
        // exact move AGENTS.md rule 3 forbids.
        const settledPayload = { key: entry.key, accepted: false, repairsUsed: 0, detail, ...(stoppedByInterruption ? { interrupted: true } : {}) };
        appendEvent(db, { runId, taskId: taskIds.get(entry.key)!, type: 'task.settled', payload: settledPayload });
        (taskStreams.get(entry.key) ?? stream).event({ type: 'task.settled', runId, taskId: taskIds.get(entry.key)!, ...settledPayload });
        results.set(entry.key, {
          key: entry.key,
          taskId: taskIds.get(entry.key)!,
          objective: byKey.get(entry.key)!.objective,
          accepted: false,
          attempts: [],
          approved: null,
          repairsUsed: 0,
          interrupted: stoppedByInterruption,
        });
        scheduler.fail(entry.key, stoppedByInterruption ? 'it was interrupted' : detail);
        if (stoppedByInterruption) interruptedKeys.push(entry.key);
        else failedKey ??= entry.key;
        return;
      }
      results.set(entry.key, entry.result);
      // Durable as well as live. `workforce watch` reads rows, not the stream,
      // and without this row a second terminal would show every lane stuck at
      // "verifying" for ever — an observer that cannot see a task finish is
      // an observer that misreports the run.
      const settledPayload = {
        key: entry.key,
        accepted: entry.result.accepted,
        repairsUsed: entry.result.repairsUsed,
        ...(entry.result.interrupted ? { interrupted: true } : {}),
      };
      appendEvent(db, { runId, taskId: entry.result.taskId, type: 'task.settled', payload: settledPayload });
      (taskStreams.get(entry.key) ?? stream).event({ type: 'task.settled', runId, taskId: entry.result.taskId, ...settledPayload });
      if (entry.result.accepted) {
        scheduler.complete(entry.key);
      } else if (entry.result.interrupted) {
        scheduler.fail(entry.key, 'it was interrupted');
        interruptedKeys.push(entry.key);
      } else {
        scheduler.fail(entry.key, `task "${entry.key}" did not reach acceptance`);
        failedKey ??= entry.key;
      }
    };

    let lastBlocked = '[]';
    for (;;) {
      // Once the run is being stopped nothing new starts: a task dispatched
      // now would only be created to be interrupted.
      const started = aborted() ? [] : scheduler.dispatch();
      if (started.length > 0) {
        stream.event({ type: 'schedule.dispatch', runId, tasks: started, activeTurns: scheduler.activeTurns, activeWriters: scheduler.activeWriters });
        for (const key of started) open(key);
        for (const key of started) start(key);
      }
      // Why the rest are not running. `scheduler.blockers` is otherwise only
      // read once the run is over, so a queued row could say "queued" and
      // nothing more; a row that cannot say what it is waiting for is the
      // kind of idle-looking output this view exists to remove.
      const waiting = aborted() ? [] : describeBlocked();
      const blockedFingerprint = JSON.stringify(waiting);
      if (blockedFingerprint !== lastBlocked) {
        appendEvent(db, { runId, type: 'schedule.blocked', payload: { blocked: waiting } });
        lastBlocked = blockedFingerprint;
      }
      if (waiting.length > 0) stream.event({ type: 'schedule.blocked', runId, blocked: waiting });
      // Nothing running and nothing newly ready: the plan has been executed as
      // far as it can be.
      if (inFlight.size === 0) break;
      // Whichever task settles first is recorded at once, freeing its slot and
      // satisfying its dependents before the next dispatch. A task that is
      // already settled but not yet raced stays in the map and wins the next
      // race immediately, so no completion is lost.
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.key);
      record(settled);
    }

    const interrupted = interruptedKeys.length > 0 || aborted();
    // A task the scheduler blocked never ran, so it never "failed" either.
    const neverRan = tasks.map((task) => task.key).filter((key) => !results.has(key));
    if (interrupted) {
      // Nothing is blocked for ever by an interruption: resume starts these.
      if (neverRan.length > 0) unresolved.push(`the run was interrupted before ${neverRan.map((key) => `"${key}"`).join(', ')} started; resume continues them`);
    } else {
      for (const blocker of scheduler.blockers) {
        unresolved.push(`task(s) ${blocker.taskIds.join(', ')} never ran (${blocker.kind}): ${blocker.detail}`);
      }
      // It still means the plan was not executed, and a plan that was not
      // executed cannot produce an accepted run.
      if (neverRan.length > 0) {
        const detail = scheduler.blockers.map((blocker) => `${blocker.kind}: ${blocker.detail}`).join('; ');
        unresolved.push(`the plan was not executed: ${neverRan.join(', ')} never ran${detail.length > 0 ? ` (${detail})` : ''}`);
        failedKey ??= neverRan[0]!;
      }
    }

    // Every worker of this run is finished, so nothing can still be delivered.
    // Whatever is left waiting is given up on explicitly: a message parked at
    // "submitted" for ever reads as still on its way, which is the same class
    // of lie as an unverified acceptance.
    if (bridge !== null) {
      let stranded: ReadonlyArray<MessageRecord> = [];
      try {
        stranded = bridge.expireUndelivered();
      } catch (error) {
        unresolved.push(`this run could not establish what became of its coordination messages: ${(error as Error).message}`);
      }
      for (const message of stranded) {
        appendEvent(db, {
          runId,
          taskId: message.recipientTaskId,
          type: 'coordination.delivery_failed',
          payload: {
            messageId: message.id,
            code: 'never_delivered',
            reason: 'the run ended with this message still undelivered',
            senderTaskId: message.senderTaskId,
            recipientTaskId: message.recipientTaskId,
            deliveryState: message.deliveryState,
          },
        });
        stream.line(`coordination: message ${message.id} from ${message.senderTaskId ?? 'the coordinator'} never reached ${message.recipientTaskId ?? 'anyone'}`);
        unresolved.push(
          `a coordination message (${message.id}) sent by ${message.senderTaskId ?? 'the coordinator'} to ${message.recipientTaskId ?? 'nobody'} was never delivered and is recorded as expired; whatever it asked was never answered`,
        );
      }
    }

    // ---- Interruption ----------------------------------------------------
    //
    // Checked before failure. A run with an interrupted task has not reached a
    // decision, and `failed` is terminal: recording it as failed would make
    // Stop destroy the request, because resume refuses a failed run. A task
    // that genuinely failed beside it is run again by the resume.
    if (interrupted) {
      const stopped = interruptedKeys.length > 0 ? `task(s) ${interruptedKeys.map((key) => `"${key}"`).join(', ')} stopped before acceptance` : 'it was stopped before any task settled';
      const reason = `the run was interrupted: ${stopped}${neverRan.length > 0 ? `, and ${neverRan.map((key) => `"${key}"`).join(', ')} never started` : ''}; nothing was integrated or accepted. Resume continues it.`;
      return interruptRun(reason, interruptedKeys, neverRan);
    }

    // ---- Integration -----------------------------------------------------
    if (failedKey !== null) {
      transitionRun(db, runId, 'failed');
      const reason = results.has(failedKey)
        ? `task "${failedKey}" did not reach acceptance, so there was nothing to integrate`
        : `task "${failedKey}" never ran, so the plan was not executed and there was nothing to integrate`;
      stream.line(`not accepted: ${reason}`);
      return finish({ accepted: false, outcome: 'failed', runState: 'failed', reason, combination: null, reviewDecision: null, review: null });
    }

    const approved: ApprovedArtifact[] = [];
    for (const task of tasks) {
      if (preAccepted.has(task.key)) {
        const artifact = preAccepted.get(task.key) ?? null;
        if (artifact !== null) approved.push(artifact);
        continue;
      }
      const result = results.get(task.key);
      if (result?.approved == null) continue;
      const attempt = result.approved;
      if (attempt.snapshot === null || !attempt.snapshot.checkpointCreated) continue;
      approved.push({
        artifactId: attempt.attemptId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        contractVersion: attempt.manifest.manifestVersion,
        baseRevision: attempt.snapshot.baseRevision,
        patchPath: attempt.snapshot.patchPath,
        patchHash: attempt.snapshot.patchHash,
        branchReceipts: attempt.receipts,
      });
    }

    if (approved.length === 0) {
      transitionRun(db, runId, 'failed');
      const reason = 'every task was accepted on its own branch but none produced a change to integrate';
      unresolved.push(reason);
      return finish({ accepted: false, outcome: 'failed', runState: 'failed', reason, combination: null, reviewDecision: null, review: null });
    }

    stream.line(`integrating ${approved.length} approved artifact(s) and re-running the checks against the combined revision`);
    let combination: CombineResult;
    try {
      combination = await combineArtifacts({
        runId,
        projectRoot,
        baseRevision,
        artifacts: approved,
        integrationRoot: path.join(runDir, 'integration'),
        checks: resolvedChecks.checks,
        checkOutputRoot: path.join(runDir, 'integration-verification'),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (!aborted()) throw error;
      return interruptRun('the run was interrupted while the approved artifacts were being combined; nothing was accepted. Resume integrates them again.', [], []);
    }
    if (aborted()) {
      return interruptRun('the run was interrupted while the combined candidate was being checked; nothing was accepted. Resume integrates the approved artifacts again.', [], []);
    }

    if (combination.status === 'refused') {
      transitionRun(db, runId, 'failed');
      appendEvent(db, { runId, type: 'integration.refused', payload: { conflicts: combination.conflicts.length, summary: combination.summary } });
      const reason = `the approved artifacts could not be combined: ${combination.summary}`;
      unresolved.push(reason);
      stream.line(`not accepted: ${reason}`);
      return finish({ accepted: false, outcome: 'failed', runState: 'failed', reason, combination, reviewDecision: null, review: null });
    }

    appendEvent(db, {
      runId,
      type: 'integration.combined',
      payload: {
        combinedRevision: combination.combinedRevision,
        order: combination.order,
        accepted: combination.acceptance.accepted,
        unverifiedCriteria: combination.acceptance.unverifiedCriteria,
      },
    });
    for (const receipt of combination.receipts) {
      stream.line(`  combined check ${receipt.criterionId}: ${receipt.outcome}${receipt.exitCode !== null ? ` (exit ${receipt.exitCode})` : ''}`);
    }

    // ---- Review ----------------------------------------------------------
    const combinedDiff = readCombinedDiff(approved);
    const reviewDecision = decideReview({
      shape: changeShapeFromDiff(combinedDiff),
      acceptanceCriteria: criteriaOf(resolvedChecks.checks),
      ...(input.reviewRequested !== undefined ? { configured: input.reviewRequested } : {}),
    });
    let review: ReviewOutcome | null = null;
    if (reviewDecision.warranted) {
      stream.line(`review warranted: ${reviewDecision.reason}`);
      if (input.reviewer === undefined && !input.headReview) {
        unresolved.push(`a review was warranted (${reviewDecision.reason}) but no reviewer was configured for this run; nothing was reviewed`);
      } else if (input.reviewer !== undefined) {
        const first = approved[0]!;
        review = await requestReview({
          taskId: first.taskId,
          attemptId: first.attemptId,
          objective: input.requestText,
          patchPath: first.patchPath,
          patchHash: first.patchHash,
          acceptanceCriteria: criteriaOf(resolvedChecks.checks),
          reviewer: input.reviewer,
          decision: reviewDecision,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        appendEvent(db, { runId, type: 'review.completed', payload: { findings: review.findings.length, reviewerId: review.reviewerId, advisory: review.advisory } });
      }
    }

    // A review never overturns the executed checks in either direction: it can
    // only add advisory findings beside them.
    const withReview = applyReviewToAcceptance(combination.acceptance, review);
    for (const finding of withReview.blockingRecommendations) {
      unresolved.push(`review finding (advisory, blocking recommendation): ${finding.summary}`);
    }
    for (const criterion of combination.acceptance.unverifiedCriteria) {
      unresolved.push(`criterion "${criterion}" has no receipt bound to the combined revision ${combination.combinedRevision}`);
    }

    // Independent checks remain mandatory. A real head review adds a delivery
    // gate; its approval cannot manufacture or replace verifier evidence.
    let headReview: HeadReviewOutcome | null = null;
    if (input.headReview && combination.acceptance.accepted) {
      headReview = await reviewWithHead({
        policy: input.headReview, config: input.config, runId, repoPath: projectRoot,
        baseRevision, combinedRevision: combination.combinedRevision,
        requestText: input.requestText, tasks, checks: resolvedChecks.checks,
        receipts: combination.receipts, paths: input.paths, db, bridge: run.bridge,
        stream: forTask(stream, { runId, agentId: input.headReview.headAgentId, key: 'head-review' }),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.adapterFactory ? { adapterFactory: input.adapterFactory } : {}),
        ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}),
        ...(input.ownership ? { ownership: input.ownership } : {}),
      });
      if (headReview.verdict !== 'passed') {
        const reason = headReview.summary;
        unresolved.push(`Department head review: ${reason}`);
        // Infrastructure failure or Stop remains explicitly resumable; a
        // semantic rejection retains its candidate and feedback for the user.
        const stopped = headReview.verdict === 'blocked';
        const runState = stopped ? 'interrupted' : 'failed';
        transitionRun(db, runId, runState);
        appendEvent(db, { runId, type: `run.${runState}`, payload: { reason, phase: 'head_review', headAgentId: headReview.headAgentId, verdict: headReview.verdict, candidateRevision: combination.combinedRevision } });
        stream.line(`head review ${headReview.verdict}: ${reason}`);
        return finish({ accepted: false, outcome: stopped ? 'interrupted' : 'failed', runState, reason, combination, reviewDecision, review, headReview });
      }
    }
    const accepted = combination.acceptance.accepted && (!input.headReview || headReview?.verdict === 'passed');
    if (aborted()) return interruptRun('The run was stopped after review and before delivery. The candidate and review evidence are preserved.', [], []);
    transitionRun(db, runId, accepted ? 'ready_for_review' : 'failed');
    const finalReply = accepted && headReview ? headReview.summary : null;
    if (finalReply) {
      const payload = { text: finalReply, summary: finalReply, headAgentId: headReview!.headAgentId, verificationStatus: 'verified', source: 'department_head_review', candidateRevision: combination.combinedRevision, artifactId: headReview!.artifactId };
      appendEvent(db, { runId, type: 'control.final_reply', payload });
      stream.event({ type: 'control.final_reply', runId, ...payload });
      stream.line(finalReply);
    }
    stream.line(
      accepted
        ? `accepted: the combined candidate ${combination.combinedRevision.slice(0, 12)} passed every required criterion with verifier-executed evidence`
        : `not accepted: ${combination.acceptance.reason}`,
    );
    stream.event({ type: `run.${accepted ? 'accepted' : 'failed'}`, runId, accepted, combinedRevision: combination.combinedRevision });
    return finish({
      accepted,
      outcome: accepted ? 'accepted' : 'failed',
      runState: accepted ? 'ready_for_review' : 'failed',
      reason: accepted ? finalReply ?? withReview.note : combination.acceptance.reason,
      combination,
      reviewDecision,
      review,
      headReview,
      finalReply,
    });
  } finally {
    await run.closeBridge();
  }

  function interruptRun(reason: string, interruptedTasks: ReadonlyArray<string>, notStarted: ReadonlyArray<string>): RunPlannedResult {
    transitionRun(db, runId, 'interrupted');
    appendEvent(db, { runId, type: 'run.interrupted', payload: { reason, interruptedTasks, notStarted } });
    stream.line(`interrupted: ${reason}`);
    stream.event({ type: 'run.interrupted', runId, accepted: false, reason });
    return finish({ accepted: false, outcome: 'interrupted', runState: 'interrupted', reason, combination: null, reviewDecision: null, review: null });
  }

  function finish(outcome: {
    accepted: boolean;
    outcome: RunOutcome;
    runState: string;
    reason: string;
    combination: CombineResult | null;
    reviewDecision: ReviewDecision | null;
    review: ReviewOutcome | null;
    headReview?: HeadReviewOutcome | null;
    finalReply?: string | null;
  }): RunPlannedResult {
    const taskResults = tasks.map(
      (task) =>
        results.get(task.key) ?? {
          key: task.key,
          taskId: taskIds.get(task.key)!,
          objective: task.objective,
          accepted: false,
          attempts: [],
          approved: null,
          repairsUsed: 0,
          interrupted: false,
        },
    );
    const manifestPath = writePlannedManifest(runDir, {
      runId,
      createdAt: run.createdAt,
      request: { text: input.requestText, source: input.requestSource, contextRefs },
      base: { revision: baseRevision, repoPath: projectRoot },
      accepted: outcome.accepted,
      reason: outcome.reason,
      tasks: taskResults.map((task) => ({
        key: task.key,
        taskId: task.taskId,
        objective: task.objective,
        agentId: agentOf(byKey.get(task.key)!),
        accepted: task.accepted,
        interrupted: task.interrupted,
        preserved: preAccepted.has(task.key),
        repairsUsed: task.repairsUsed,
        attempts: task.attempts.map((attempt) => ({ attemptId: attempt.attemptId, outcome: attempt.outcome, candidateRevision: attempt.snapshot?.candidateRevision ?? null })),
      })),
      combination:
        outcome.combination === null
          ? null
          : outcome.combination.status === 'refused'
            ? { status: 'refused', conflicts: outcome.combination.conflicts, summary: outcome.combination.summary }
            : {
                status: 'combined',
                combinedRevision: outcome.combination.combinedRevision,
                order: outcome.combination.order,
                acceptance: outcome.combination.acceptance,
                checks: outcome.combination.receipts.map((receipt) => ({ criterionId: receipt.criterionId, outcome: receipt.outcome, exitCode: receipt.exitCode })),
              },
      review: outcome.review,
      reviewDecision: outcome.reviewDecision,
      headReview: outcome.headReview ?? null,
      finalReply: outcome.finalReply ?? null,
      unresolved,
    });
    stream.line(`evidence and manifest: ${runDir}`);
    return {
      runId,
      outcome: outcome.outcome,
      runState: outcome.runState,
      runDir,
      baseRevision,
      tasks: taskResults,
      combination: outcome.combination,
      reviewDecision: outcome.reviewDecision,
      review: outcome.review,
      headReview: outcome.headReview ?? null,
      finalReply: outcome.finalReply ?? null,
      accepted: outcome.accepted,
      reason: outcome.reason,
      manifestPath,
      unresolved,
    };
  }
}

// ---------------------------------------------------------------------------
// Resume: finish a recorded plan
// ---------------------------------------------------------------------------

export interface ContinuePlannedRunInput extends Omit<RunPlannedInput, 'tasks' | 'run' | 'coordinationEnabled'> {
  readonly runId: string;
}

/**
 * Finish a planned run an earlier process started and was stopped.
 *
 * The recorded plan decides everything: each task keeps its key, id, objective,
 * dependencies and assignee. A task already accepted is never re-dispatched or
 * re-judged; its recorded candidate joins the integration. Every other task is
 * dispatched again as a new attempt generation, in dependency order, under the
 * scheduler's caps. Acceptance is still decided only against the combined
 * candidate, re-checked here.
 *
 * The caller owns the run (it holds the coordinator lock and has reconciled
 * the run, which leaves it `running`).
 */
export async function continuePlannedRun(input: ContinuePlannedRunInput): Promise<RunPlannedResult> {
  const stream = input.stream ?? SILENT_STREAM;
  const { db, paths, runId } = input;
  const record = readPlanRecord(paths, runId);
  if (record === null) throw new RunSetupError('no_plan_record', `run ${runId} recorded no plan (${planRecordPath(paths, runId)}), so there is no plan to continue`);
  const row = getRun(db, runId);
  const registered = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'plan.registered' ORDER BY sequence DESC LIMIT 1").get(runId) as { payload_json: string } | undefined;
  const recordedPolicy = registered ? (JSON.parse(registered.payload_json) as { headReview?: HeadReviewPolicy }).headReview : undefined;
  if (recordedPolicy && (!record.headReview || record.headReview.headAgentId !== recordedPolicy.headAgentId || record.headReview.required !== true)) throw new RunSetupError('head_review_policy_missing', 'The required head review policy is missing or changed in the saved plan. Restore its recorded policy before resuming.');
  const headReview = record.headReview ? { headAgentId: record.headReview.headAgentId, required: true as const, ...(record.headReview.deadlineMs !== undefined ? { deadlineMs: record.headReview.deadlineMs } : {}) } : undefined;
  if (headReview) {
    const blocker = headReviewResumeBlocker(db, runId);
    if (blocker) throw new RunSetupError('head_review_stop_unconfirmed', blocker);
  }

  const inspection = await inspectProject(input.repoPath);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new RunSetupError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository`);
  }
  const projectRoot = inspection.repositoryRoot;
  const baseRevision = row.base_revision ?? inspection.headRevision;
  if (baseRevision === null) throw new RunSetupError('no_committed_base', `${projectRoot} has no commits; there is no committed base revision to continue from`);
  if (inspection.headRevision !== null && inspection.headRevision !== baseRevision) {
    stream.line(`note: the repository's HEAD moved since this run started (${baseRevision.slice(0, 12)} -> ${inspection.headRevision.slice(0, 12)}); continued attempts start from the new HEAD and integration may refuse to combine them`);
  }

  const limits = limitsFromDefaults(input.config.defaults);
  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  // Acceptance means the same thing across an interruption: the checks the run
  // was started with, not whatever the repository happens to configure now.
  const checkFlags = input.checkFlags ?? record.checkFlags;
  const resolvedChecks = await resolveAcceptanceChecks(projectRoot, baseRevision, checkFlags ?? []);
  if (resolvedChecks.checks.length === 0) {
    throw new RunSetupError('no_acceptance_checks', `${resolvedChecks.detail}. A run cannot be accepted without independently executed evidence.`);
  }

  const unresolved: string[] = [];
  const bridge = await startRunBridge(paths, db, runId, stream, unresolved);
  const runDir = paths.runDir(runId);
  const run: PlannedRun = {
    runId,
    runDir,
    createdAt: row.created_at,
    projectRoot,
    baseRevision,
    checks: resolvedChecks,
    limits,
    agentId,
    contextRefs: [...(input.contextRefs ?? [])],
    bridge,
    unresolved,
    closeBridge: closerFor(bridge),
    abandon: async () => {
      throw new Error('a continued planned run is never abandoned; it finishes through executePlan');
    },
  };

  const preAccepted = new Map<string, ApprovedArtifact | null>();
  for (const task of record.tasks) {
    const state = db.prepare('SELECT state FROM tasks WHERE id = ? AND run_id = ?').get(task.taskId, runId) as { state: string } | undefined;
    if (state?.state === 'accepted') preAccepted.set(task.key, approvedArtifactFor(db, paths, runId, task.taskId));
  }
  stream.line(`continuing planned run ${runId}: ${preAccepted.size} accepted task(s) kept, ${record.tasks.length - preAccepted.size} to run`);

  return executePlan({
    input: { ...input, ...(checkFlags !== undefined ? { checkFlags } : {}), ...(headReview ? { headReview } : {}) },
    run,
    tasks: record.tasks.map((task) => ({
      key: task.key,
      taskId: task.taskId,
      objective: task.objective,
      agentId: task.agentId,
      writer: task.writer,
      ...(task.dependencies.length > 0 ? { dependencies: task.dependencies } : {}),
    })),
    preAccepted,
    continuation: true,
  });
}

/** The candidate an accepted task's newest completed attempt recorded, for integration. Null when it changed nothing. */
function approvedArtifactFor(db: DatabaseSync, paths: StatePaths, runId: string, taskId: string): ApprovedArtifact | null {
  const attempts = db
    .prepare("SELECT id FROM attempts WHERE task_id = ? AND state = 'completed' ORDER BY generation DESC")
    .all(taskId) as Array<{ id: string }>;
  for (const attempt of attempts) {
    const event = db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'candidate.snapshot' ORDER BY sequence DESC LIMIT 1")
      .get(runId, attempt.id) as { payload_json: string } | undefined;
    if (event === undefined) continue;
    const payload = JSON.parse(event.payload_json) as { baseRevision?: unknown; patchHash?: unknown; checkpointCreated?: unknown };
    if (payload.checkpointCreated !== true || typeof payload.baseRevision !== 'string' || typeof payload.patchHash !== 'string') return null;
    return {
      artifactId: attempt.id,
      taskId,
      attemptId: attempt.id,
      contractVersion: RUN_MANIFEST_VERSION,
      baseRevision: payload.baseRevision,
      patchPath: path.join(paths.runDir(runId), 'snapshots', `${attempt.id}.patch`),
      patchHash: payload.patchHash,
    };
  }
  return null;
}

/**
 * Make an existing, unaccepted task dispatchable as a new attempt.
 *
 * `(task_id, generation)` is unique, so a generation that already holds an
 * attempt is superseded first; the task is then parked one step short of
 * `ready`, which `runDirect` takes it to itself.
 */
function prepareTaskForContinuation(db: DatabaseSync, taskId: string): void {
  const task = db.prepare('SELECT state, current_generation FROM tasks WHERE id = ?').get(taskId) as { state: string; current_generation: number } | undefined;
  if (task === undefined) return;
  const occupied = db.prepare('SELECT 1 FROM attempts WHERE task_id = ? AND generation = ?').get(taskId, task.current_generation) !== undefined;
  if (occupied) beginNewGeneration(db, taskId);
  parkTaskForDispatch(db, taskId);
}

/** Acceptance criteria in the shape the review module reads them. */
function criteriaOf(checks: ReadonlyArray<CheckSpec>): ReadonlyArray<{ id: string; description: string; check: { command: string; args: string[] } }> {
  return checks.map((check) => ({
    id: check.criterionId,
    description: check.description ?? check.criterionId,
    check: { command: check.command, args: [...(check.args ?? [])] },
  }));
}

/** What this task's dependencies produced, for its prompt. */
function briefingFor(task: PlannedTaskInput, results: ReadonlyMap<string, PlannedTaskResult>): string | undefined {
  const dependencies = task.dependencies ?? [];
  if (dependencies.length === 0) return undefined;
  const lines: string[] = [];
  for (const key of dependencies) {
    const result = results.get(key);
    if (result === undefined) continue;
    const snapshot = result.approved?.snapshot ?? null;
    lines.push(`Task "${key}" (${result.objective}) is accepted.`);
    if (snapshot !== null) {
      lines.push(
        `  It changed ${snapshot.changedFiles.length} file(s) on branch ${snapshot.branch} at ${snapshot.candidateRevision.slice(0, 12)}: ${snapshot.changedFiles.slice(0, 20).join(', ')}`,
      );
      lines.push('  Those changes are NOT in your workspace: your candidate starts from the same base as theirs, and the coordinator combines them afterwards. Do not re-implement their work, and do not edit the files they changed.');
    }
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** The combined pre-image of every approved patch, for measuring the change's shape. */
function readCombinedDiff(approved: ReadonlyArray<ApprovedArtifact>): string {
  const parts: string[] = [];
  for (const artifact of approved) {
    try {
      parts.push(readFileSync(artifact.patchPath, 'utf8'));
    } catch {
      // A patch that cannot be read here is still verified by the combiner,
      // which hashes it before use; missing it only makes the shape smaller.
    }
  }
  return parts.join('\n');
}

interface TaskRunInput {
  readonly input: ExecuteInput;
  readonly runId: string;
  readonly runDir: string;
  readonly key: string;
  readonly task: PlannedTaskInput;
  readonly taskId: string;
  readonly limits: Limits;
  readonly bridge: CoordinationBridge | null;
  readonly briefing: string | undefined;
  /** Every other task of this run, so this worker can address one by id. */
  readonly peers: ReadonlyArray<{ key: string; taskId: string; objective: string }>;
  readonly stream: RunStream;
  readonly acquireFallbackAgent: (agentId: string) => (() => void) | null;
}

/**
 * One task, plus a bounded repair loop when its checks fail.
 *
 * Every repair is a NEW attempt with a new candidate: the failed candidate's
 * receipts are invalidated by `RepairSession` and never count toward the
 * repaired one. The loop stops at `maxRepairAttempts`, so a task that cannot
 * be repaired fails rather than looping.
 */
async function runTaskWithRepair(context: TaskRunInput): Promise<PlannedTaskResult> {
  const { input, runId, key, task, taskId, limits, bridge, stream } = context;
  const attempts: RunDirectResult[] = [];
  let repairsUsed = 0;
  let briefing = context.briefing;
  let attemptId = newId();
  let session: RepairSession | null = null;
  const settle = (accepted: boolean, approved: RunDirectResult | null, interrupted = false): PlannedTaskResult => ({
    key,
    taskId,
    objective: task.objective,
    accepted,
    attempts,
    approved,
    repairsUsed,
    interrupted,
  });

  for (;;) {
    stream.line(`task "${key}"${repairsUsed > 0 ? ` (repair ${repairsUsed})` : ''}: ${task.objective}`);
    // `runWithFallback` runs the attempt and, when it stopped for a reason a
    // second runtime could get past (an expired credential, an exhausted
    // quota, a provider that fell over), hands the work to that runtime with
    // a handoff packet. It returns the attempt whose result stands.
    const continued = await runWithFallback({
      repoPath: input.repoPath,
      config: input.config,
      configRaw: input.configRaw,
      configPath: input.configPath,
      requestText: input.requestText,
      requestSource: input.requestSource,
      paths: input.paths,
      db: input.db,
      stream,
      slot: {
        runId,
        taskId,
        attemptId,
        key,
        objective: task.objective,
        peers: context.peers,
        ...(briefing !== undefined ? { briefing } : {}),
      },
      coordination: bridge,
      ...(input.contextRefs !== undefined ? { contextRefs: input.contextRefs } : {}),
      ...(task.agentId ?? input.agentId ? { agentId: (task.agentId ?? input.agentId)! } : {}),
      ...(input.checkFlags !== undefined ? { checkFlags: input.checkFlags } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.adapterFactory !== undefined ? { adapterFactory: input.adapterFactory } : {}),
      ...(input.sessionEnv !== undefined ? { sessionEnv: input.sessionEnv } : {}),
      ...(input.ownership !== undefined ? { ownership: input.ownership } : {}),
      ...(input.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
      ...(input.runDeadlineMs !== undefined ? { runDeadlineMs: input.runDeadlineMs } : {}),
      ...(input.keepCheckCopies !== undefined ? { keepCheckCopies: input.keepCheckCopies } : {}),
    }, { acquireFallbackAgent: context.acquireFallbackAgent });
    const result = continued.result;
    for (const attempt of continued.attempts) attempts.push(attempt);
    if (continued.fallback !== null) {
      stream.line(`task "${key}": ${describeFallback(continued.fallback)}`);
      if (continued.note !== null) stream.line(`  ${continued.note}`);
    }

    if (result.acceptance.accepted) return settle(true, result);
    if (result.outcome === 'interrupted') return settle(false, null, true);

    // Repair needs the verifier's own results about a real candidate. Without
    // a candidate revision or receipts there is nothing to repair against.
    const candidateRevision = result.snapshot?.candidateRevision ?? null;
    const receipts: ReadonlyArray<CheckReceipt> = result.receipts;
    if (candidateRevision === null || receipts.length === 0 || limits.maxRepairAttempts === 0) return settle(false, null);
    // A stop requested while the checks ran is not a reason to start a repair.
    if (input.signal?.aborted === true) return settle(false, null, true);

    session ??= new RepairSession({
      runId,
      taskId,
      originAttemptId: result.attemptId,
      maxRepairAttempts: limits.maxRepairAttempts,
      mintAttemptId: () => newId(),
    });

    let decision;
    try {
      decision = session.next({ receipts: [...receipts], candidateRevision });
    } catch {
      // `RepairSessionError` means the receipts do not describe this candidate;
      // that is a reason to stop, not to retry blindly.
      return settle(false, null);
    }

    if (decision.kind !== 'repair') {
      if (decision.kind === 'exhausted') {
        stream.line(`task "${key}": repair budget exhausted after ${repairsUsed} repair(s); ${decision.reason}`);
      }
      return settle(false, null);
    }

    appendEvent(input.db, {
      runId,
      taskId,
      attemptId: decision.attempt.identity.attemptId,
      type: 'task.repair_started',
      payload: {
        attemptNumber: decision.attempt.attemptNumber,
        supersedes: decision.attempt.identity.supersedesAttemptId,
        invalidatedReceiptIds: decision.attempt.invalidatedReceiptIds,
      },
    });
    repairsUsed = decision.attempt.attemptNumber;
    attemptId = decision.attempt.identity.attemptId;
    // A repair is a NEW generation of this task. Without this the new attempt
    // would be written at the task's current generation and violate
    // UNIQUE(task_id, generation), which killed the whole run.
    beginNewGeneration(input.db, taskId);
    briefing = [context.briefing, decision.attempt.instructions].filter((part) => part !== undefined && part.length > 0).join('\n\n');
  }
}

/**
 * The first dependency cycle in a plan, or null when the graph is acyclic.
 *
 * Depth-first with an explicit stack colour, so the returned path names the
 * tasks the user has to break rather than just asserting a cycle exists.
 */
function findDependencyCycle(tasks: ReadonlyArray<PlannedTaskInput>): ReadonlyArray<string> | null {
  const edges = new Map<string, ReadonlyArray<string>>(tasks.map((task) => [task.key, task.dependencies ?? []]));
  const colour = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (key: string): ReadonlyArray<string> | null => {
    const state = colour.get(key);
    if (state === 'done') return null;
    if (state === 'visiting') return [...path.slice(path.indexOf(key)), key];
    colour.set(key, 'visiting');
    path.push(key);
    for (const dependency of edges.get(key) ?? []) {
      const found = visit(dependency);
      if (found !== null) return found;
    }
    path.pop();
    colour.set(key, 'done');
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.key);
    if (found !== null) return found;
  }
  return null;
}
