/**
 * `workforce resume <run-id>` — recovery under exclusive ownership (FR039,
 * FR054, FR061).
 *
 * Unlike `status`, which is deliberately read-only, resume takes the
 * coordinator lock: it is going to decide what happens to a half-finished
 * run. It reconciles first, prints the plan it derived from persisted state,
 * and only then hands execution on.
 *
 * Exit codes (AGENTS.md): 0 nothing is blocked · 2 invalid input · 3 a person
 * has to decide (a live or unidentifiable worker, a cancelled run, or a lock
 * someone else holds) · 4 execution failure · 130 interrupted.
 */
import { LockHeldError } from '../../storage/lock.js';
import { StateNotFoundError } from '../../storage/db.js';
import { SchemaTooNewError } from '../../storage/migrations.js';
import type { StateStore } from '../../storage/db.js';
import { ResumeError, planSummaryLines, resumeRun, type ResumePlan } from '../../recovery/resume.js';
import type { ProcessIdentity, ProcessIdentityStatus } from '../../core/process.js';
import type { AttemptRow } from '../../storage/records.js';
import { CliError, EXIT_CODES, type CommandResult, type ExitCode } from '../output.js';

export interface ResumeCommandArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly stateDir?: string;
  readonly agents?: string;
  readonly json: boolean;
}

/**
 * How the command continues an unblocked plan. The orchestrator injects this;
 * without it `resume` reconciles, reports and stops — it never pretends to
 * have re-dispatched work it did not.
 */
export type ResumeContinuation = (plan: ResumePlan, store: StateStore) => Promise<CommandResult> | CommandResult;

export interface ResumeCommandOptions {
  readonly continue?: ResumeContinuation;
  readonly probeProcess?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  readonly sessionResumable?: (attempt: AttemptRow) => boolean;
  readonly signal?: AbortSignal;
}

function requireRunId(args: ResumeCommandArgs): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', 'resume requires a <run-id> argument');
  if (args.positionals.length > 1) {
    throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  }
  return runId;
}

export async function commandResume(args: ResumeCommandArgs, options: ResumeCommandOptions = {}): Promise<CommandResult> {
  const runId = requireRunId(args);

  let started;
  try {
    started = resumeRun({
      runId,
      ...(args.stateDir !== undefined ? { stateRoot: args.stateDir } : {}),
      ...(options.probeProcess !== undefined ? { probeProcess: options.probeProcess } : {}),
      ...(options.sessionResumable !== undefined ? { sessionResumable: options.sessionResumable } : {}),
    });
  } catch (error) {
    throw toCliError(error);
  }

  const { plan, store, ownsStore } = started;
  try {
    if (options.signal?.aborted === true) {
      return {
        command: 'resume',
        exitCode: EXIT_CODES.interrupted,
        data: { runId, plan: planData(plan), status: 'interrupted' },
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

    if (options.continue === undefined) {
      return {
        command: 'resume',
        exitCode: EXIT_CODES.verifiedCandidate,
        data: { runId, plan: planData(plan), status: 'reconciled', continued: false },
        lines: [...planSummaryLines(plan), 'state reconciled under this coordinator; execution continuation is not wired in this build'],
      };
    }

    const result = await options.continue(plan, store);
    return { ...result, data: { runId, plan: planData(plan), continued: true, ...result.data } };
  } finally {
    if (ownsStore) store.close();
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
  if (error instanceof ResumeError) {
    const exitCode: ExitCode = error.code === 'unknown_run' || error.code === 'state_unavailable' ? EXIT_CODES.invalidInput : EXIT_CODES.userActionRequired;
    return new CliError(exitCode, error.code, error.message);
  }
  return new CliError(EXIT_CODES.executionFailure, 'resume_failed', (error as Error).message ?? String(error));
}
