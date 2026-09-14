/**
 * `workforce resume <run-id>` — recovery under exclusive ownership (FR039,
 * FR054, FR061).
 *
 * Unlike `status`, which is deliberately read-only, resume takes the
 * coordinator lock: it is going to decide what happens to a half-finished
 * run. It reconciles first, and then it continues — it creates the attempt
 * generation the reconciliation decided on, dispatches the work that remains,
 * and drives the run to a terminal state exactly as a fresh run would, leaving
 * everything already accepted untouched.
 *
 * The order is what keeps that safe. Whatever a continued attempt needs is
 * read back before anything is minted, so a run that cannot be continued is
 * refused without first burning a generation nothing will ever dispatch. A
 * cancelled run is refused outright. A run whose reconciliation could not
 * classify an attempt safely is reported, not raced.
 *
 * Exit codes (AGENTS.md): 0 nothing is blocked · 2 invalid input · 3 a person
 * has to decide (a live or unidentifiable worker, a cancelled run, or a lock
 * someone else holds) · 4 execution failure · 130 interrupted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { LockHeldError } from '../../storage/lock.js';
import { openStateStore, StateNotFoundError, type StateStore } from '../../storage/db.js';
import { SchemaTooNewError } from '../../storage/migrations.js';
import { createStatePaths, PathsManifestSchema, resolveStateRoot } from '../../storage/paths.js';
import { findRun, transitionRun } from '../../storage/records.js';
import { appendEvent } from '../../storage/events.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../../core/config.js';
import { reconcileRun } from '../../recovery/reconcile.js';
import { ResumeError, planSummaryLines, resumeRun, TERMINAL_RUN_STATES, type ResumePlan } from '../../recovery/resume.js';
import {
  ContinueRunError,
  continueResumedRun,
  prepareRunContinuation,
  type ContinueResumedRunDeps,
  type ContinueResumedRunResult,
  type RunContinuationSetup,
} from '../../recovery/continue-run.js';
import type { ProcessIdentity, ProcessIdentityStatus } from '../../core/process.js';
import type { AttemptRow } from '../../storage/records.js';
import { CliError, EXIT_CODES, type CommandResult, type ExitCode } from '../output.js';

export interface ResumeCommandArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly stateDir?: string;
  readonly agents?: string;
  /** Accept a continued attempt whose runtime enforces no write boundary, exactly as `run` does. */
  readonly allowUnconfinedWrites?: boolean;
  readonly retryFailed?: boolean;
  readonly json: boolean;
}

/**
 * How the command continues an unblocked plan. It defaults to the real
 * continuation; injecting one replaces it, which is how a test drives the
 * command without an orchestrator behind it.
 */
export type ResumeContinuation = (plan: ResumePlan, store: StateStore) => Promise<CommandResult> | CommandResult;

export interface ResumeCommandOptions {
  readonly continue?: ResumeContinuation;
  readonly probeProcess?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  readonly sessionResumable?: (attempt: AttemptRow) => boolean;
  readonly signal?: AbortSignal;
  /** Passed through to the real continuation (adapter factory, fake-runtime scenario, progress). */
  readonly continuation?: Omit<ContinueResumedRunDeps, 'setup' | 'config' | 'signal'>;
}

function requireRunId(args: ResumeCommandArgs): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', 'resume requires a <run-id> argument');
  if (args.positionals.length > 1) {
    throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  }
  return runId;
}

/**
 * The state paths of an existing state root.
 *
 * `resume` has no `--workspace-root`, so the root the run actually used is
 * read back from the manifest rather than guessed; guessing would send a
 * continued attempt's workspace somewhere the run never wrote.
 */
function pathsFor(stateDir: string | undefined): ReturnType<typeof createStatePaths> {
  const root = resolveStateRoot(stateDir);
  const bare = createStatePaths(root);
  if (!existsSync(bare.manifestPath)) return bare;
  const recorded = PathsManifestSchema.safeParse(JSON.parse(readFileSync(bare.manifestPath, 'utf8')));
  return recorded.success ? createStatePaths(root, { workspaceRoot: recorded.data.workspaceRoot }) : bare;
}

export async function commandResume(args: ResumeCommandArgs, options: ResumeCommandOptions = {}): Promise<CommandResult> {
  const runId = requireRunId(args);

  let store: StateStore;
  try {
    store = openStateStore(pathsFor(args.stateDir), { mode: 'mutating' });
  } catch (error) {
    throw toCliError(error);
  }

  try {
    const run = findRun(store.db, runId);
    if (run === null) throw new CliError(EXIT_CODES.invalidInput, 'unknown_run', `run ${runId} not found under ${store.paths.root}`);

    // Everything a continued attempt needs is read back BEFORE reconciliation
    // mints a generation, so a run that cannot be continued is refused without
    // leaving a fresh empty generation behind. Whether it will be continued at
    // all is asked of a read-only reconciliation first: a run that is going to
    // be blocked, cancelled or already finished continues nothing, and
    // demanding a configuration for it would refuse a report it can honestly
    // give.
    const preview = reconcileRun(store.db, runId, {
      ...(args.retryFailed ? { retryFailed: true } : {}),
      ...(options.probeProcess !== undefined ? { probeProcess: options.probeProcess } : {}),
      ...(options.sessionResumable !== undefined ? { sessionResumable: options.sessionResumable } : {}),
    });
    const continuable = run.state !== 'cancelled' && (!TERMINAL_RUN_STATES.has(run.state) || args.retryFailed === true && run.state === 'failed') && !preview.blocked;
    // `--agents` is the fallback binding, not the primary one: the run's own
    // recorded configuration is what its attempts ran under.
    let fallback: LoadedAgentConfig | undefined;
    if (args.agents !== undefined) {
      try {
        fallback = loadAgentConfigFile(args.agents);
      } catch {
        // An invalid --agents is already an exit-2 invocation at the CLI
        // boundary; here it simply is not a usable fallback.
        fallback = undefined;
      }
    }
    let setup: RunContinuationSetup | null = null;
    if (continuable && options.continue === undefined) {
      try {
        setup = prepareRunContinuation(store, runId, fallback);
      } catch (error) {
        throw toCliError(error);
      }
    }

    let started;
    try {
      started = resumeRun({
        ...(args.retryFailed ? { retryFailed: true } : {}),
        runId,
        store,
        // The continuation inserts the attempt row for the slot it dispatches,
        // so recovery reserves the identity rather than writing a row that
        // would collide with it.
        replacementAttempts: 'reserved',
        ...(options.probeProcess !== undefined ? { probeProcess: options.probeProcess } : {}),
        ...(options.sessionResumable !== undefined ? { sessionResumable: options.sessionResumable } : {}),
      });
    } catch (error) {
      throw toCliError(error);
    }

    const { plan } = started;

    if (options.signal?.aborted === true) {
      if (!plan.complete && !plan.blocked && findRun(store.db, runId)?.state === 'running') {
        transitionRun(store.db, runId, 'interrupted');
        appendEvent(store.db, { runId, type: 'recovery.interrupted', payload: { reason: 'interrupted before continuing; no successor was dispatched' } });
      }
      return {
        command: 'resume',
        exitCode: EXIT_CODES.interrupted,
        data: { runId, plan: planData(plan), status: 'interrupted', runState: findRun(store.db, runId)?.state },
        lines: [...planSummaryLines(plan), 'interrupted before continuing; the reconciled state is persisted'],
      };
    }

    if (plan.blocked) {
      return {
        command: 'resume',
        exitCode: EXIT_CODES.userActionRequired,
        data: { runId, plan: planData(plan), status: 'blocked' },
        lines: planSummaryLines(plan),
      };
    }

    if (plan.complete) {
      return {
        command: 'resume',
        exitCode: EXIT_CODES.verifiedCandidate,
        data: { runId, plan: planData(plan), status: 'already_finished' },
        lines: [...planSummaryLines(plan), `run ${runId} already reached ${plan.runState}; nothing to resume and recorded work is preserved`],
      };
    }

    if (options.continue !== undefined) {
      const result = await options.continue(plan, store);
      // The plan is part of what resume reports, whoever continues it.
      return {
        ...result,
        data: { runId, plan: planData(plan), continued: true, ...result.data },
        lines: [...planSummaryLines(plan), ...result.lines],
      };
    }

    let continued: ContinueResumedRunResult;
    try {
      continued = await continueResumedRun(plan, store, {
        ...options.continuation,
        // The invocation's own acknowledgement, not the injected deps': a
        // continued attempt faces the same write-boundary gate as the run it
        // continues.
        ...(args.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
        ...(setup !== null ? { setup } : {}),
        ...(fallback !== undefined ? { config: fallback } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw toCliError(error);
    }

    return {
      command: 'resume',
      exitCode: exitCodeFor(continued),
      data: {
        runId,
        plan: planData(plan),
        continued: true,
        status: continued.outcome,
        headReview: continued.headReview ?? null,
        finalReply: continued.finalReply ?? null,
        runState: continued.runState,
        tasks: continued.continued,
        preservedTaskIds: continued.preservedTaskIds,
        notContinued: continued.notContinued,
        notes: continued.notes,
      },
      lines: [...planSummaryLines(plan), ...continued.lines],
    };
  } finally {
    store.close();
  }
}

function exitCodeFor(result: ContinueResumedRunResult): ExitCode {
  switch (result.outcome) {
    case 'accepted':
    case 'nothing_to_do':
      return EXIT_CODES.verifiedCandidate;
    case 'interrupted':
      return EXIT_CODES.interrupted;
    case 'blocked':
      return EXIT_CODES.userActionRequired;
    case 'failed':
      return EXIT_CODES.executionFailure;
  }
}

function planData(plan: ResumePlan): Record<string, unknown> {
  return {
    runState: plan.runState,
    ownershipEpoch: plan.ownershipEpoch,
    blocked: plan.blocked,
    blockedReason: plan.blockedReason,
    complete: plan.complete,
    userActions: plan.userActions,
    preservedAttemptIds: plan.preservedAttemptIds,
    steps: plan.steps,
    reconciliation: {
      runState: plan.reconciliation.runState,
      openOperations: plan.reconciliation.openOperations,
      findings: plan.reconciliation.findings.map((finding) => ({
        attemptId: finding.attemptId,
        taskId: finding.taskId,
        generation: finding.generation,
        attemptState: finding.attemptState,
        worker: finding.worker,
        disposition: finding.disposition,
        reason: finding.reason,
        sessionId: finding.sessionId,
        dispatched: finding.dispatched,
        artifactCount: finding.artifactCount,
      })),
    },
  };
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof LockHeldError) {
    return new CliError(EXIT_CODES.userActionRequired, 'ownership_unavailable', error.message, [
      'another coordinator owns this state root; stop it (or wait for it) and resume again',
      'use "workforce status <run-id>" for read-only inspection in the meantime',
    ]);
  }
  if (error instanceof StateNotFoundError || error instanceof SchemaTooNewError) {
    return new CliError(EXIT_CODES.invalidInput, 'state_unavailable', error.message);
  }
  if (error instanceof ContinueRunError) {
    return new CliError(
      error.code === 'unknown_run' ? EXIT_CODES.invalidInput : EXIT_CODES.userActionRequired,
      error.code,
      error.message,
      error.actions,
    );
  }
  if (error instanceof ResumeError) {
    const exitCode: ExitCode = error.code === 'unknown_run' || error.code === 'state_unavailable' ? EXIT_CODES.invalidInput : EXIT_CODES.userActionRequired;
    return new CliError(exitCode, error.code, error.message);
  }
  return new CliError(EXIT_CODES.executionFailure, 'resume_failed', (error as Error).message ?? String(error));
}
