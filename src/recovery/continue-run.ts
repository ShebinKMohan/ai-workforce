/**
 * Continuing an interrupted run (FR039, AT07).
 *
 * `resumeRun` decides what a half-finished run's attempts deserve; this is
 * what acts on that decision. It is deliberately a composition of pieces that
 * already exist — `runDirect` for the work, the storage record helpers for the
 * lifecycle — and adds no orchestration of its own:
 *
 *   1. what the run was started with is read back from the run's own persisted
 *      record (its request row and its configuration snapshot), so the
 *      continuation is bound to the same configuration the interrupted attempt
 *      ran under rather than to whatever the terminal happens to have now;
 *   2. every task that already reached `accepted` is left exactly as it is: it
 *      is never re-dispatched, so a resume cannot produce a second accepted
 *      writer for work that was already accepted;
 *   3. every remaining task is dispatched as one attempt of the run the
 *      caller already owns (`runDirect`'s slot), reusing the attempt id the
 *      resume plan reserved for it;
 *   4. the run is driven to a state that describes reality — `ready_for_review`
 *      when every task is accepted, `failed` when one is not, `interrupted`
 *      when the resume itself was interrupted. A resume never leaves the run
 *      saying `running` with nothing working on it.
 *
 * What it refuses to do matters as much. An attempt the reconciliation could
 * not classify safely is isolated, not raced: a blocked plan is never
 * continued. An attempt classified `resumable` is left alone too — rejoining a
 * live runtime session is not wired here, and starting a second worker beside
 * one that could be rejoined would be exactly the duplicate writer this whole
 * path exists to prevent.
 */
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { LoadedAgentConfig } from '../core/config.js';
import { type AgentConfigFile, validateAgentConfig, validateRunRequest, validateTaskContract } from '../core/contracts.js';
import { newId, nowIso } from '../core/ids.js';
import {
  runDirect,
  SILENT_STREAM,
  type AdapterFactory,
  type RunDirectInput,
  type RunDirectResult,
  type RunStream,
} from '../core/run-direct.js';
import type { StateStore } from '../storage/db.js';
import { appendEvent } from '../storage/events.js';
import {
  beginNewGeneration,
  findRun,
  getTask,
  listTasks,
  transitionRun,
  type RunRow,
  type TaskRow,
} from '../storage/records.js';
import { listTaskAttempts } from './reconcile.js';
import { parkTaskForDispatch, type ResumePlan, type ResumeStep } from './resume.js';

export class ContinueRunError extends Error {
  readonly code: 'unknown_run' | 'configuration_unavailable';
  readonly actions: ReadonlyArray<string>;

  constructor(code: ContinueRunError['code'], message: string, actions: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'ContinueRunError';
    this.code = code;
    this.actions = actions;
  }
}

/** Everything a resumed attempt needs that only the run's own record knows. */
export interface RunContinuationSetup {
  readonly run: RunRow;
  readonly config: AgentConfigFile;
  readonly configRaw: string;
  readonly configPath: string;
  /** The agent the run was started with, when the run recorded one. */
  readonly agentId: string | undefined;
  readonly repoPath: string;
  readonly requestText: string;
  readonly contextRefs: ReadonlyArray<string>;
  /** Anything a reader has to know about how faithful this reconstruction is. */
  readonly notes: ReadonlyArray<string>;
}

const ConfigSnapshotSchema = z.looseObject({
  configPath: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  raw: z.unknown(),
});

/**
 * Read back what the run was started with.
 *
 * Called before a resume mints anything, so a run that cannot be continued is
 * refused without first bumping a generation it will never dispatch.
 */
export function prepareRunContinuation(store: StateStore, runId: string, fallback?: LoadedAgentConfig): RunContinuationSetup {
  const run = findRun(store.db, runId);
  if (run === null) throw new ContinueRunError('unknown_run', `run ${runId} not found under ${store.paths.root}`);
  const request = validateRunRequest(JSON.parse(run.request_json));
  const notes: string[] = [];

  const snapshotPath = store.paths.runConfigSnapshotPath(runId);
  let recorded: { config: AgentConfigFile; raw: string; path: string; agentId: string | undefined } | null = null;
  try {
    const snapshot = ConfigSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath, 'utf8')));
    recorded = {
      config: validateAgentConfig(snapshot.raw),
      raw: JSON.stringify(snapshot.raw),
      path: snapshot.configPath ?? snapshotPath,
      agentId: snapshot.agentId,
    };
  } catch (error) {
    notes.push(`the configuration snapshot this run recorded (${snapshotPath}) could not be used: ${(error as Error).message}`);
  }

  if (recorded === null) {
    if (fallback === undefined) {
      throw new ContinueRunError(
        'configuration_unavailable',
        `run ${runId} has no usable configuration snapshot, so there is nothing to bind a continued attempt to`,
        [
          'pass --agents <file> to continue this run under an explicit configuration',
          `or inspect ${snapshotPath}: it is the record of what this run was started with`,
        ],
      );
    }
    notes.push(
      `continuing under ${fallback.path} instead of the configuration this run was started with; the agent binding of the new attempt may differ from the interrupted one`,
    );
    recorded = { config: fallback.config, raw: fallback.raw, path: fallback.path, agentId: undefined };
  }

  return {
    run,
    config: recorded.config,
    configRaw: recorded.raw,
    configPath: recorded.path,
    agentId: recorded.agentId,
    repoPath: run.repo_path,
    requestText: request.text,
    contextRefs: request.contextRefs,
    notes,
  };
}

export interface ContinueResumedRunDeps {
  readonly stream?: RunStream;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  /** Extra environment for the runtime session (used to select a fake-runtime scenario). */
  readonly sessionEnv?: Readonly<Record<string, string>>;
  /**
   * Carry an explicit acknowledgement that this run's writes are unconfined.
   * A continued attempt dispatches the same profile on the same runtime as the
   * original, so it faces the same write-boundary gate and needs the same
   * acknowledgement; without this a run started with
   * `--allow-unconfined-writes` could not be resumed at all.
   */
  readonly allowUnconfinedWrites?: boolean;
  /** Injection seam for tests; defaults to the real orchestrator. */
  readonly dispatch?: (input: RunDirectInput) => Promise<RunDirectResult>;
  /** Configuration to fall back to when the run's own snapshot is unusable. */
  readonly config?: LoadedAgentConfig;
  /** A setup already read back by the caller, so it is not read twice. */
  readonly setup?: RunContinuationSetup;
  readonly now?: string;
}

export type ContinueOutcome = 'accepted' | 'failed' | 'interrupted' | 'blocked' | 'nothing_to_do';

export interface ContinuedTask {
  readonly taskId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly outcome: RunDirectResult['outcome'];
  readonly accepted: boolean;
}

export interface ContinueResumedRunResult {
  readonly runId: string;
  readonly outcome: ContinueOutcome;
  readonly runState: RunRow['state'];
  readonly continued: ReadonlyArray<ContinuedTask>;
  /** Tasks that were already accepted and were therefore not re-dispatched. */
  readonly preservedTaskIds: ReadonlyArray<string>;
  readonly notContinued: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
  readonly lines: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

/**
 * Continue a run from a reconciled resume plan, and drive it to a terminal
 * state exactly as a fresh run would.
 */
export async function continueResumedRun(
  plan: ResumePlan,
  store: StateStore,
  deps: ContinueResumedRunDeps = {},
): Promise<ContinueResumedRunResult> {
  // Continuing is a mutation of a run this coordinator claims to own; prove
  // that before anything is dispatched.
  store.lock?.assertOwnership();
  const db = store.db;
  const now = deps.now ?? nowIso();
  const dispatch = deps.dispatch ?? runDirect;
  const stream = deps.stream ?? SILENT_STREAM;

  if (plan.blocked) {
    return report(db, plan.runId, 'blocked', [], [], [], ['the plan is blocked; nothing was dispatched'], []);
  }
  if (plan.complete) {
    return report(db, plan.runId, 'nothing_to_do', [], [], [], [`run ${plan.runId} already reached ${plan.runState}; nothing was dispatched`], []);
  }

  const setup = deps.setup ?? prepareRunContinuation(store, plan.runId, deps.config);
  const notes = [...setup.notes];

  const isolated = new Set(plan.steps.filter((s) => s.action === 'isolate' || s.action === 'refuse').map((s) => s.taskId));
  const reconnecting = new Map(plan.steps.filter((s) => s.action === 'reconnect').map((s) => [s.taskId, s] as const));
  const reserved = new Map(plan.steps.filter((s) => s.action === 'replace' && s.newAttemptId !== null).map((s) => [s.taskId, s] as const));

  const continued: ContinuedTask[] = [];
  const preserved: string[] = [];
  const notContinued: Array<{ taskId: string; reason: string }> = [];
  const lines: string[] = [];
  let interrupted = false;
  let dispatchFailed = false;

  const tasks = listTasks(db, plan.runId);
  for (const task of tasks) {
    if (task.state === 'accepted') {
      preserved.push(task.id);
      lines.push(`preserved task ${task.id}: already accepted, so it is neither re-run nor re-judged`);
      continue;
    }
    if (task.state === 'superseded') continue;
    if (isolated.has(task.id)) {
      notContinued.push({ taskId: task.id, reason: 'its attempt is isolated for a human to decide; nothing was dispatched into that workspace' });
      continue;
    }
    const reconnect = reconnecting.get(task.id);
    if (reconnect !== undefined) {
      notContinued.push({
        taskId: task.id,
        reason:
          `attempt ${reconnect.attemptId} was classified resumable on session ${reconnect.sessionId ?? '(unnamed)'}; ` +
          'rejoining a runtime session is not wired here, and dispatching a second worker beside one that could be rejoined would race it',
      });
      continue;
    }
    if (interrupted || dispatchFailed || deps.signal?.aborted === true) {
      if (deps.signal?.aborted === true) interrupted = true;
      notContinued.push({
        taskId: task.id,
        reason: interrupted ? 'the resume was interrupted before this task was dispatched' : 'an earlier task of this run could not be dispatched',
      });
      continue;
    }

    const slot = reserveAttemptSlot(db, task, reserved.get(task.id) ?? null, now);
    parkTaskForDispatch(db, task.id, now);
    appendEvent(db, {
      runId: plan.runId,
      taskId: task.id,
      attemptId: slot.attemptId,
      type: 'recovery.continuing',
      payload: { generation: slot.generation, ownershipEpoch: plan.ownershipEpoch, objective: task.objective },
      timestamp: now,
    });
    stream.line(`continuing task ${task.id} as attempt ${slot.attemptId} (generation ${slot.generation})`);

    const checkFlags = checkFlagsFrom(task);
    const briefing = continuationBriefing(reserved.get(task.id) ?? null);
    const objective = objectiveFor(task, setup.requestText);
    const input: RunDirectInput = {
      repoPath: setup.repoPath,
      config: setup.config,
      configRaw: setup.configRaw,
      configPath: setup.configPath,
      requestText: setup.requestText,
      requestSource: `resume of run ${plan.runId}`,
      contextRefs: setup.contextRefs,
      paths: store.paths,
      db,
      stream,
      slot: {
        runId: plan.runId,
        taskId: task.id,
        attemptId: slot.attemptId,
        objective,
        ...(briefing !== undefined ? { briefing } : {}),
      },
      ...(checkFlags !== undefined ? { checkFlags } : {}),
      ...(setup.agentId !== undefined ? { agentId: setup.agentId } : {}),
      ...(store.lock !== null ? { ownership: store.lock } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
      ...(deps.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
    };

    let result: RunDirectResult;
    try {
      result = await dispatch(input);
    } catch (error) {
      dispatchFailed = true;
      notContinued.push({ taskId: task.id, reason: `dispatch failed: ${(error as Error).message}` });
      lines.push(`task ${task.id}: dispatch failed — ${(error as Error).message}`);
      continue;
    }

    continued.push({
      taskId: task.id,
      attemptId: result.attemptId,
      generation: slot.generation,
      outcome: result.outcome,
      accepted: result.acceptance.accepted,
    });
    lines.push(`task ${task.id}: ${result.outcome} (attempt ${result.attemptId}, generation ${slot.generation})`);
    if (result.outcome === 'interrupted') interrupted = true;
    const recordedBase = setup.run.base_revision;
    const attemptBase = result.manifest.base['revision'];
    if (recordedBase !== null && typeof attemptBase === 'string' && attemptBase !== recordedBase) {
      notes.push(
        `the continued attempt started from ${attemptBase.slice(0, 12)} but the run was started from ${recordedBase.slice(0, 12)}; the repository's HEAD moved since the interruption`,
      );
    }
  }

  const after = listTasks(db, plan.runId);
  const outstanding = after.filter((task) => task.state !== 'accepted' && task.state !== 'superseded');
  let outcome: ContinueOutcome;
  let target: RunRow['state'];
  if (interrupted) {
    outcome = 'interrupted';
    target = 'interrupted';
  } else if (dispatchFailed) {
    outcome = 'failed';
    target = 'failed';
  } else if (notContinued.length > 0) {
    // Nothing failed, but something was deliberately left alone. The run has
    // not reached a decision, and saying it did would be the lie this whole
    // path exists to avoid.
    outcome = 'blocked';
    target = 'interrupted';
  } else if (after.length === 0) {
    outcome = 'failed';
    target = 'failed';
    lines.push(`run ${plan.runId} recorded no task to continue`);
  } else if (outstanding.length === 0) {
    outcome = 'accepted';
    target = 'ready_for_review';
  } else {
    outcome = 'failed';
    target = 'failed';
  }

  const runState = transitionRunSafely(db, plan.runId, target);
  appendEvent(db, {
    runId: plan.runId,
    type: 'recovery.continued',
    payload: {
      outcome,
      runState,
      ownershipEpoch: plan.ownershipEpoch,
      continued: continued.map((entry) => ({ taskId: entry.taskId, attemptId: entry.attemptId, generation: entry.generation, accepted: entry.accepted })),
      preservedTaskIds: preserved,
      notContinued,
    },
    timestamp: now,
  });

  lines.push(`run ${plan.runId}: ${runState}`);
  for (const entry of notContinued) lines.push(`not continued: task ${entry.taskId} — ${entry.reason}`);
  for (const note of notes) lines.push(`note: ${note}`);
  return { runId: plan.runId, outcome, runState, continued, preservedTaskIds: preserved, notContinued, lines, notes };
}

function report(
  db: DatabaseSync,
  runId: string,
  outcome: ContinueOutcome,
  continued: ReadonlyArray<ContinuedTask>,
  preserved: ReadonlyArray<string>,
  notContinued: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>,
  lines: ReadonlyArray<string>,
  notes: ReadonlyArray<string>,
): ContinueResumedRunResult {
  const run = findRun(db, runId);
  return {
    runId,
    outcome,
    runState: run?.state ?? 'pending',
    continued,
    preservedTaskIds: preserved,
    notContinued,
    lines,
    notes,
  };
}

/**
 * The attempt identity the next dispatch will use.
 *
 * The resume plan already reserved one for every attempt it decided to
 * replace, and reusing it is what keeps the plan's report and the dispatched
 * work the same thing. Anything else — a task the plan said nothing about, or
 * a generation something already occupies — gets a fresh identity, and a
 * generation that is already taken is superseded first, because
 * `(task_id, generation)` is unique and a superseded generation is what makes
 * a late result from it refusable.
 */
function reserveAttemptSlot(
  db: DatabaseSync,
  task: TaskRow,
  step: ResumeStep | null,
  now: string,
): { readonly attemptId: string; readonly generation: number } {
  const generation = getTask(db, task.id).current_generation;
  const occupied = listTaskAttempts(db, task.id).some((attempt) => attempt.generation === generation);
  if (!occupied) {
    const reserved = step?.newAttemptId ?? null;
    return { attemptId: reserved !== null && step?.newGeneration === generation ? reserved : newId(), generation };
  }
  return { attemptId: newId(), generation: beginNewGeneration(db, task.id, now) };
}

/**
 * Acceptance must mean the same thing across an interruption.
 *
 * Checks that came from `--check` flags are not in the repository, so
 * re-resolving them would silently judge the continued attempt by whatever the
 * project happens to configure now. The flag values are recoverable verbatim
 * from the persisted contract, because that is exactly what the criterion
 * description records. Anything else came from the repository at the base
 * revision and re-resolves identically, ids, `cwd` and timeouts included, so
 * it is left to resolve rather than flattened into flags that cannot carry
 * them.
 */
const FLAG_DESCRIPTION = /^--check "([\s\S]*)"$/;

function checkFlagsFrom(task: TaskRow): ReadonlyArray<string> | undefined {
  let criteria;
  try {
    criteria = validateTaskContract(JSON.parse(task.contract_json)).acceptanceCriteria;
  } catch {
    return undefined;
  }
  const values: string[] = [];
  for (const criterion of criteria) {
    const match = FLAG_DESCRIPTION.exec(criterion.description);
    if (match === null) return undefined;
    values.push(match[1]!);
  }
  return values.length > 0 ? values : undefined;
}

/**
 * What the continued worker is asked to do.
 *
 * A task row stores the *contract's* objective, which is the request's first
 * line clipped to 200 characters — a summary, not the request. The interrupted
 * attempt was given the request itself, so a continuation that handed over the
 * clipped line would quietly ask for less than the run was for. When the
 * stored objective is exactly what the contract derives from this run's
 * request, the task IS that request and the worker gets it verbatim; a task
 * with an objective of its own (the planned path) keeps it.
 */
function objectiveFor(task: TaskRow, requestText: string): string {
  return task.objective === contractObjectiveOf(requestText) ? requestText : task.objective;
}

/** Mirrors how the orchestrator derives a contract objective from request text. */
function contractObjectiveOf(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? text.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/**
 * What the worker is told about the attempt it is replacing.
 *
 * A continued attempt gets its own workspace from the same committed base, so
 * the honest briefing says the earlier partial work is recorded evidence and
 * not a starting point. Claiming otherwise would invite a worker to assume
 * half the job is already done.
 */
function continuationBriefing(step: ResumeStep | null): string | undefined {
  if (step === null) return undefined;
  return [
    'This task is being continued after an interruption.',
    `A previous attempt (${step.attemptId}, generation ${step.generation}) was stopped before it finished. Whatever it recorded is preserved as evidence of that attempt and is not carried into yours.`,
    'Your workspace starts from the same committed base revision as that attempt did, so treat the objective as unfinished and do not assume any of it is already present.',
  ].join('\n');
}

function transitionRunSafely(db: DatabaseSync, runId: string, to: RunRow['state']): RunRow['state'] {
  try {
    return transitionRun(db, runId, to).state;
  } catch {
    return findRun(db, runId)?.state ?? to;
  }
}
