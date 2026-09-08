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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentConfigFile,
  type Limits,
  type Policy,
  RUN_REQUEST_VERSION,
  limitsFromDefaults,
  validateRunRequest,
} from './contracts.js';
import { newId, nowIso } from './ids.js';
import { computeAgentSnapshot } from './snapshot.js';
import {
  RunSetupError,
  SILENT_STREAM,
  listFilesAtRevision,
  resolveAcceptanceChecks,
  runDirect,
  type AdapterFactory,
  type RunDirectResult,
  type RunOutcome,
  type RunStream,
} from './run-direct.js';
import { createCoordinationBridge, type CoordinationBridge } from '../coordination/index.js';
import { appendEvent } from '../storage/events.js';
import { ensureRunDir, type StatePaths } from '../storage/paths.js';
import { beginNewGeneration, insertRun, transitionRun } from '../storage/records.js';
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
import type { CheckReceipt, CheckSpec } from '../verification/checks.js';

export const PLANNED_MANIFEST_VERSION = 1 as const;

/** One task of a planned run. Ids are minted here; the plan supplies the shape. */
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
  /** True only when the COMBINED candidate's own receipts satisfied every required criterion. */
  readonly accepted: boolean;
  readonly reason: string;
  readonly manifestPath: string;
  readonly unresolved: ReadonlyArray<string>;
}

/**
 * Run a plan.
 *
 * The run row, the run directory and the coordination bridge are created here
 * and belong to the whole run; each task then goes through `runDirect` with a
 * slot naming its place in the run.
 */
export async function runPlanned(input: RunPlannedInput): Promise<RunPlannedResult> {
  const stream = input.stream ?? SILENT_STREAM;
  const { db, paths } = input;
  const contextRefs = [...(input.contextRefs ?? [])];
  const unresolved: string[] = [];

  if (input.tasks.length === 0) {
    throw new RunSetupError('empty_plan', 'a planned run needs at least one task; an empty plan is not a run');
  }
  const keys = new Set<string>();
  for (const task of input.tasks) {
    if (keys.has(task.key)) throw new RunSetupError('duplicate_task_key', `task key "${task.key}" appears twice in the plan`);
    keys.add(task.key);
  }
  for (const task of input.tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (!keys.has(dependency)) {
        throw new RunSetupError('unknown_dependency', `task "${task.key}" depends on "${dependency}", which is not in the plan`);
      }
      if (dependency === task.key) {
        throw new RunSetupError('self_dependency', `task "${task.key}" depends on itself; it could never be dispatched`);
      }
    }
  }
  const cycle = findDependencyCycle(input.tasks);
  if (cycle !== null) {
    // A cycle is refused here rather than discovered by the scheduler. The
    // scheduler would block the cycled tasks and the run would finish with
    // them silently missing; a plan that cannot be executed is not a run.
    throw new RunSetupError('dependency_cycle', `the plan has a dependency cycle (${cycle.join(' -> ')}); no task in it could ever be dispatched`);
  }

  // ---- Run-level setup ---------------------------------------------------
  const inspection = await inspectProject(input.repoPath);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new RunSetupError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository`);
  }
  if (inspection.headRevision === null) {
    throw new RunSetupError('no_committed_base', `${inspection.repositoryRoot} has no commits; there is no committed base revision to start from`);
  }
  const projectRoot = inspection.repositoryRoot;
  const baseRevision = inspection.headRevision;

  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  if (!input.config.agents.some((agent) => agent.id === agentId)) {
    throw new RunSetupError('unknown_agent', `agent "${agentId}" is not defined in ${input.configPath}`);
  }
  const snapshot = computeAgentSnapshot(input.config, agentId);
  const policy: Policy = snapshot.binding.policy;
  const limits: Limits = limitsFromDefaults(input.config.defaults);

  if (input.tasks.length > limits.maxTasksPerRun) {
    throw new RunSetupError(
      'task_budget_exceeded',
      `the plan has ${input.tasks.length} tasks but maxTasksPerRun is ${limits.maxTasksPerRun}; the budget is refused before any work starts, not after`,
    );
  }

  // The acceptance checks are resolved once, at the base revision, and are the
  // same for every task and for the combined candidate. That is what makes the
  // combined result comparable to the per-task ones.
  const resolvedChecks = await resolveAcceptanceChecks(projectRoot, baseRevision, input.checkFlags ?? []);
  if (resolvedChecks.checks.length === 0) {
    throw new RunSetupError('no_acceptance_checks', `${resolvedChecks.detail}. A run cannot be accepted without independently executed evidence.`);
  }
  await listFilesAtRevision(projectRoot, baseRevision);

  const runId = newId();
  const createdAt = nowIso();
  ensureRunDir(paths, runId);
  const runDir = paths.runDir(runId);
  const request = validateRunRequest({
    requestVersion: RUN_REQUEST_VERSION,
    runId,
    text: input.requestText,
    contextRefs,
    repoPath: projectRoot,
    baseMode: 'head',
    submittedAt: createdAt,
  });
  const project = registerProject(db, { inspection, dataLocation: paths.root, checks: resolvedChecks.checks, now: createdAt });
  insertRun(db, { request, policy, limits, projectId: project.id, baseRevision, now: createdAt });
  writeFileSync(paths.runRequestPath(runId), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    paths.runConfigSnapshotPath(runId),
    `${JSON.stringify({ configPath: input.configPath, agentId, snapshotHash: snapshot.hash, binding: snapshot.binding, raw: JSON.parse(input.configRaw) as unknown }, null, 2)}\n`,
    { mode: 0o600 },
  );
  appendEvent(db, {
    runId,
    type: 'run.created',
    payload: { repoPath: projectRoot, baseRevision, agentId, path: 'planned', taskCount: input.tasks.length, checkSource: resolvedChecks.source },
    timestamp: createdAt,
  });
  transitionRun(db, runId, 'running');

  stream.line(`run ${runId} (planned, ${input.tasks.length} tasks)`);
  stream.line(`repo ${projectRoot} @ ${baseRevision.slice(0, 12)}`);
  stream.line(`acceptance: ${resolvedChecks.detail}`);
  stream.event({ type: 'run.created', runId, path: 'planned', taskCount: input.tasks.length, repo: projectRoot, baseRevision });

  // ---- One bridge for the whole run --------------------------------------
  let bridge: CoordinationBridge | null = null;
  if (input.coordinationEnabled !== false) {
    try {
      bridge = await createCoordinationBridge({ stateRoot: paths.root, runId, db });
      stream.line(`coordination: ${bridge.socketPath}`);
    } catch (error) {
      unresolved.push(`no coordination bridge was started for this run (${(error as Error).message}); its workers had no channel to the coordinator`);
      stream.line(`note: the coordination bridge could not start: ${(error as Error).message}`);
    }
  }

  const taskIds = new Map<string, string>(input.tasks.map((task) => [task.key, newId()]));
  const byKey = new Map<string, PlannedTaskInput>(input.tasks.map((task) => [task.key, task]));
  const results = new Map<string, PlannedTaskResult>();

  try {
    // ---- Scheduling ------------------------------------------------------
    const scheduleTasks: ScheduleTask[] = input.tasks.map((task) => ({
      id: task.key,
      ...(task.dependencies !== undefined && task.dependencies.length > 0
        ? { dependencies: task.dependencies.map((dependency) => ({ taskId: dependency, kind: 'completion' as const })) }
        : {}),
      ...(task.writer !== undefined ? { writer: task.writer } : {}),
    }));
    const scheduler = createScheduler(scheduleTasks, { maxActiveTurns: limits.maxActiveTurns, maxActiveWriters: limits.maxActiveWriters });

    let failedKey: string | null = null;
    /** One task's outcome, carried out of its own promise so a rejection is that task's failure. */
    interface Settlement {
      readonly key: string;
      readonly result: PlannedTaskResult | null;
      readonly error: Error | null;
    }
    const inFlight = new Map<string, Promise<Settlement>>();

    // A dispatched task becomes an in-flight promise immediately. There is no
    // join across dispatched tasks: the loop below reacts to the FIRST one to
    // settle, so a satisfied prerequisite releases its dependent while every
    // unrelated task is still running (FR031/FR032, AT09). Concurrency is
    // still bounded — the scheduler hands out turn and writer slots and only
    // frees one when `complete`/`fail` records that task — and only the
    // repository-mutating setup is serialized, inside `withRepositoryLock`.
    const start = (key: string): void => {
      const task = byKey.get(key)!;
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
                peers: input.tasks
                  .filter((peer) => peer.key !== key)
                  .map((peer) => ({ key: peer.key, taskId: taskIds.get(peer.key)!, objective: peer.objective })),
                stream,
              }),
              error: null,
            };
          } catch (error) {
            // One task throwing is that task failing, not the run dying with
            // no manifest: the run still has to finish and record what it did.
            return { key, result: null, error: error instanceof Error ? error : new Error(String(error)) };
          }
        })(),
      );
    };

    const record = (entry: Settlement): void => {
      if (entry.error !== null || entry.result === null) {
        const detail = entry.error?.message ?? 'the task produced no result';
        unresolved.push(`task "${entry.key}" ended with an error before it could be assessed: ${detail}`);
        stream.line(`task "${entry.key}" failed: ${detail}`);
        results.set(entry.key, {
          key: entry.key,
          taskId: taskIds.get(entry.key)!,
          objective: byKey.get(entry.key)!.objective,
          accepted: false,
          attempts: [],
          approved: null,
          repairsUsed: 0,
        });
        scheduler.fail(entry.key, detail);
        failedKey ??= entry.key;
        return;
      }
      results.set(entry.key, entry.result);
      if (entry.result.accepted) {
        scheduler.complete(entry.key);
      } else {
        scheduler.fail(entry.key, `task "${entry.key}" did not reach acceptance`);
        failedKey ??= entry.key;
      }
    };

    for (;;) {
      const started = scheduler.dispatch();
      if (started.length > 0) {
        stream.event({ type: 'schedule.dispatch', runId, tasks: started, activeTurns: scheduler.activeTurns, activeWriters: scheduler.activeWriters });
        for (const key of started) start(key);
      }
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

    for (const blocker of scheduler.blockers) {
      unresolved.push(`task(s) ${blocker.taskIds.join(', ')} never ran (${blocker.kind}): ${blocker.detail}`);
    }
    // A task the scheduler blocked never ran, so it never "failed" either.
    // It still means the plan was not executed, and a plan that was not
    // executed cannot produce an accepted run.
    const neverRan = input.tasks.map((task) => task.key).filter((key) => !results.has(key));
    if (neverRan.length > 0) {
      const detail = scheduler.blockers.map((blocker) => `${blocker.kind}: ${blocker.detail}`).join('; ');
      unresolved.push(`the plan was not executed: ${neverRan.join(', ')} never ran${detail.length > 0 ? ` (${detail})` : ''}`);
      failedKey ??= neverRan[0]!;
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
    for (const task of input.tasks) {
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
    const combination = await combineArtifacts({
      runId,
      projectRoot,
      baseRevision,
      artifacts: approved,
      integrationRoot: path.join(runDir, 'integration'),
      checks: resolvedChecks.checks,
      checkOutputRoot: path.join(runDir, 'integration-verification'),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });

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
      if (input.reviewer === undefined) {
        unresolved.push(`a review was warranted (${reviewDecision.reason}) but no reviewer was configured for this run; nothing was reviewed`);
      } else {
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

    const accepted = combination.acceptance.accepted;
    transitionRun(db, runId, accepted ? 'ready_for_review' : 'failed');
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
      reason: accepted ? withReview.note : combination.acceptance.reason,
      combination,
      reviewDecision,
      review,
    });
  } finally {
    if (bridge !== null) {
      try {
        await bridge.close();
      } catch {
        // The socket is gone either way; a close failure is not a run outcome.
      }
    }
  }

  function finish(outcome: {
    accepted: boolean;
    outcome: RunOutcome;
    runState: string;
    reason: string;
    combination: CombineResult | null;
    reviewDecision: ReviewDecision | null;
    review: ReviewOutcome | null;
  }): RunPlannedResult {
    const taskResults = input.tasks.map(
      (task) =>
        results.get(task.key) ?? {
          key: task.key,
          taskId: taskIds.get(task.key)!,
          objective: task.objective,
          accepted: false,
          attempts: [],
          approved: null,
          repairsUsed: 0,
        },
    );
    const manifest = {
      manifestVersion: PLANNED_MANIFEST_VERSION,
      runId,
      path: 'planned',
      createdAt,
      request: { text: input.requestText, source: input.requestSource, contextRefs },
      base: { revision: baseRevision, repoPath: projectRoot },
      accepted: outcome.accepted,
      reason: outcome.reason,
      tasks: taskResults.map((task) => ({
        key: task.key,
        taskId: task.taskId,
        objective: task.objective,
        accepted: task.accepted,
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
      unresolved,
    };
    const manifestPath = path.join(runDir, 'planned-result.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
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
      accepted: outcome.accepted,
      reason: outcome.reason,
      manifestPath,
      unresolved,
    };
  }
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
  readonly input: RunPlannedInput;
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
    });
    const result = continued.result;
    for (const attempt of continued.attempts) attempts.push(attempt);
    if (continued.fallback !== null) {
      stream.line(`task "${key}": ${describeFallback(continued.fallback)}`);
      if (continued.note !== null) stream.line(`  ${continued.note}`);
    }

    if (result.acceptance.accepted) {
      return { key, taskId, objective: task.objective, accepted: true, attempts, approved: result, repairsUsed };
    }
    if (result.outcome === 'interrupted') {
      return { key, taskId, objective: task.objective, accepted: false, attempts, approved: null, repairsUsed };
    }

    // Repair needs the verifier's own results about a real candidate. Without
    // a candidate revision or receipts there is nothing to repair against.
    const candidateRevision = result.snapshot?.candidateRevision ?? null;
    const receipts: ReadonlyArray<CheckReceipt> = result.receipts;
    if (candidateRevision === null || receipts.length === 0 || limits.maxRepairAttempts === 0) {
      return { key, taskId, objective: task.objective, accepted: false, attempts, approved: null, repairsUsed };
    }

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
      return { key, taskId, objective: task.objective, accepted: false, attempts, approved: null, repairsUsed };
    }

    if (decision.kind !== 'repair') {
      if (decision.kind === 'exhausted') {
        stream.line(`task "${key}": repair budget exhausted after ${repairsUsed} repair(s); ${decision.reason}`);
      }
      return { key, taskId, objective: task.objective, accepted: false, attempts, approved: null, repairsUsed };
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
