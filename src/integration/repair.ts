/**
 * Bounded repair loop (FR052).
 *
 * A failed check does not produce "try again". It produces a repair attempt
 * carrying the exact evidence the verifier recorded: the command and its
 * arguments, the exit status, an excerpt of the captured output, the paths to
 * the full logs, the criterion the check was about, and the candidate revision
 * it ran against. Nothing here is a summary of a failure; it is the failure.
 *
 * The loop is bounded. At `maxRepairAttempts` the session reports the budget as
 * exhausted, with the evidence that was never resolved, instead of dispatching
 * another attempt.
 *
 * Each repair creates a NEW candidate identity. The previous candidate's check
 * results are invalidated at that moment: they describe a revision that is no
 * longer the one under consideration, so they can neither establish nor
 * condemn the repaired candidate. `next()` ignores receipts from invalidated
 * candidates by construction.
 */
import { randomToken } from '../core/ids.js';
import type { AcceptanceCriterion } from '../core/contracts.js';
import type { CheckOutcome, CheckReceipt } from '../verification/checks.js';

export const DEFAULT_EXCERPT_LINES = 40;

export interface FailureEvidence {
  readonly criterionId: string;
  readonly criterionDescription: string | null;
  readonly required: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The revision the failing command actually ran against. */
  readonly candidateRevision: string;
  readonly receiptId: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Tail of the captured output; the full logs are at the paths above. */
  readonly outputExcerpt: string;
  readonly outputTruncated: boolean;
  readonly evidenceProvenance: CheckReceipt['evidenceProvenance'];
}

function tail(text: string, lines: number): string {
  const parts = text.split('\n');
  return parts.length <= lines ? text : parts.slice(parts.length - lines).join('\n');
}

/** Turn a verifier receipt into the evidence a repair attempt carries. */
export function failureEvidenceFromReceipt(
  receipt: CheckReceipt,
  criterion?: Pick<AcceptanceCriterion, 'id' | 'description'>,
  excerptLines: number = DEFAULT_EXCERPT_LINES,
): FailureEvidence {
  const combined = [receipt.stdoutTail, receipt.stderrTail].filter((part) => part.trim().length > 0).join('\n');
  return {
    criterionId: receipt.criterionId,
    criterionDescription: criterion?.description ?? receipt.description,
    required: receipt.required,
    command: receipt.command,
    args: receipt.args,
    cwd: receipt.cwd,
    outcome: receipt.outcome,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    timedOut: receipt.timedOut,
    durationMs: receipt.durationMs,
    candidateRevision: receipt.candidate.revision,
    receiptId: receipt.id,
    stdoutPath: receipt.stdoutPath,
    stderrPath: receipt.stderrPath,
    outputExcerpt: tail(combined, excerptLines),
    outputTruncated: receipt.outputTruncated,
    evidenceProvenance: receipt.evidenceProvenance,
  };
}

export function isFailingReceipt(receipt: CheckReceipt): boolean {
  return receipt.outcome !== 'passed' && receipt.outcome !== 'skipped';
}

export interface RepairBudget {
  readonly maxRepairAttempts: number;
  readonly used: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

/** A candidate identity: a repair never reuses the identity it is replacing. */
export interface CandidateIdentity {
  readonly attemptId: string;
  readonly supersedesAttemptId: string;
  readonly supersededCandidateRevision: string | null;
}

export interface RepairAttempt {
  /** 1-based: the first repair is attempt 1. */
  readonly attemptNumber: number;
  readonly runId: string;
  readonly taskId: string;
  readonly identity: CandidateIdentity;
  readonly evidence: ReadonlyArray<FailureEvidence>;
  /** Receipt ids that stopped counting the moment this repair was created. */
  readonly invalidatedReceiptIds: ReadonlyArray<string>;
  readonly budget: RepairBudget;
  /** The instruction handed to the worker, carrying the evidence verbatim. */
  readonly instructions: string;
}

export type RepairDecision =
  | { readonly kind: 'satisfied'; readonly budget: RepairBudget; readonly reason: string }
  | { readonly kind: 'repair'; readonly attempt: RepairAttempt; readonly budget: RepairBudget }
  | { readonly kind: 'exhausted'; readonly budget: RepairBudget; readonly reason: string; readonly evidence: ReadonlyArray<FailureEvidence> };

export interface RepairSessionInput {
  readonly runId: string;
  readonly taskId: string;
  /** The attempt whose candidate is under consideration when the session starts. */
  readonly originAttemptId: string;
  readonly maxRepairAttempts: number;
  readonly criteria?: ReadonlyArray<Pick<AcceptanceCriterion, 'id' | 'description'>>;
  /** Injectable id source so tests are deterministic. */
  readonly mintAttemptId?: (attemptNumber: number) => string;
  readonly excerptLines?: number;
}

export interface EvaluateRepairInput {
  readonly receipts: ReadonlyArray<CheckReceipt>;
  /** The revision these receipts are about. Receipts from other revisions are ignored. */
  readonly candidateRevision: string;
}

export class RepairSessionError extends Error {
  readonly code: 'stale_candidate' | 'no_receipts';

  constructor(code: 'stale_candidate' | 'no_receipts', message: string) {
    super(message);
    this.name = 'RepairSessionError';
    this.code = code;
  }
}

/** Render the repair instruction. Evidence is quoted, never paraphrased. */
export function renderRepairInstructions(runId: string, taskId: string, identity: CandidateIdentity, evidence: ReadonlyArray<FailureEvidence>, budget: RepairBudget): string {
  const header = [
    `Repair attempt ${budget.used} of ${budget.maxRepairAttempts} for task ${taskId} (run ${runId}).`,
    `This is a new candidate: ${identity.attemptId}. It supersedes ${identity.supersedesAttemptId}` +
      (identity.supersededCandidateRevision === null ? '.' : ` at revision ${identity.supersededCandidateRevision}.`),
    'Every check result recorded for the superseded candidate is invalidated; nothing from it establishes this one.',
    '',
    'The following checks were executed by the verifier and did not pass:',
  ];
  const blocks = evidence.map((item, index) => {
    const argv = [item.command, ...item.args].join(' ');
    return [
      `${index + 1}. criterion "${item.criterionId}"${item.criterionDescription === null ? '' : `: ${item.criterionDescription}`}`,
      `   command: ${argv}`,
      `   cwd: ${item.cwd}`,
      `   outcome: ${item.outcome}${item.exitCode === null ? '' : ` (exit ${item.exitCode})`}${item.signal === null ? '' : ` (signal ${item.signal})`}${item.timedOut ? ' (timed out)' : ''}`,
      `   ran against revision: ${item.candidateRevision}`,
      `   full output: ${item.stdoutPath} , ${item.stderrPath}`,
      '   captured output (tail):',
      ...item.outputExcerpt.split('\n').map((line) => `   | ${line}`),
    ].join('\n');
  });
  return [...header, ...blocks, '', 'Fix the underlying cause. Do not modify the checks themselves.'].join('\n');
}

/**
 * Drives the bounded repair loop for one task.
 *
 * Call `next()` with the receipts produced against the current candidate. It
 * returns `satisfied`, a `repair` attempt with a new candidate identity, or
 * `exhausted` when the budget is spent.
 */
export class RepairSession {
  readonly #runId: string;
  readonly #taskId: string;
  readonly #max: number;
  readonly #criteria: ReadonlyMap<string, Pick<AcceptanceCriterion, 'id' | 'description'>>;
  readonly #mint: (attemptNumber: number) => string;
  readonly #excerptLines: number;
  readonly #invalidated = new Set<string>();
  readonly #attempts: RepairAttempt[] = [];
  #currentAttemptId: string;
  #used = 0;

  constructor(input: RepairSessionInput) {
    this.#runId = input.runId;
    this.#taskId = input.taskId;
    this.#max = input.maxRepairAttempts;
    this.#criteria = new Map((input.criteria ?? []).map((criterion) => [criterion.id, criterion]));
    this.#mint = input.mintAttemptId ?? ((attemptNumber) => `${input.originAttemptId}-repair${attemptNumber}-${randomToken(4)}`);
    this.#excerptLines = input.excerptLines ?? DEFAULT_EXCERPT_LINES;
    this.#currentAttemptId = input.originAttemptId;
  }

  get currentAttemptId(): string {
    return this.#currentAttemptId;
  }

  get attempts(): ReadonlyArray<RepairAttempt> {
    return this.#attempts;
  }

  get budget(): RepairBudget {
    return { maxRepairAttempts: this.#max, used: this.#used, remaining: Math.max(0, this.#max - this.#used), exhausted: this.#used >= this.#max };
  }

  /** True when this receipt has been invalidated by a later repair. */
  isInvalidated(receiptId: string): boolean {
    return this.#invalidated.has(receiptId);
  }

  /** Receipts that still speak about `candidateRevision` and were never invalidated. */
  validReceipts(receipts: ReadonlyArray<CheckReceipt>, candidateRevision: string): CheckReceipt[] {
    return receipts.filter((receipt) => receipt.candidate.revision === candidateRevision && !this.#invalidated.has(receipt.id));
  }

  next(input: EvaluateRepairInput): RepairDecision {
    const applicable = this.validReceipts(input.receipts, input.candidateRevision);
    if (applicable.length === 0) {
      throw new RepairSessionError(
        'no_receipts',
        `no valid check receipts were supplied for candidate revision ${input.candidateRevision}; a repair decision needs the verifier's own results, not the absence of them`,
      );
    }
    const failing = applicable.filter(isFailingReceipt);
    if (failing.length === 0) {
      return { kind: 'satisfied', budget: this.budget, reason: `every executed check passed against ${input.candidateRevision}` };
    }

    const evidence = failing.map((receipt) => failureEvidenceFromReceipt(receipt, this.#criteria.get(receipt.criterionId), this.#excerptLines));

    if (this.#used >= this.#max) {
      const budget = this.budget;
      return {
        kind: 'exhausted',
        budget,
        reason:
          this.#max === 0
            ? `the repair budget for task ${this.#taskId} is 0, so a failing check is reported rather than repaired; ${failing.length} check(s) still fail against ${input.candidateRevision}`
            : `the repair budget for task ${this.#taskId} is exhausted after ${this.#used} repair attempt(s) (limit ${this.#max}); ${failing.length} check(s) still fail against ${input.candidateRevision}`,
        evidence,
      };
    }

    this.#used += 1;
    const invalidatedReceiptIds = applicable.map((receipt) => receipt.id);
    for (const id of invalidatedReceiptIds) this.#invalidated.add(id);

    const identity: CandidateIdentity = {
      attemptId: this.#mint(this.#used),
      supersedesAttemptId: this.#currentAttemptId,
      supersededCandidateRevision: input.candidateRevision,
    };
    this.#currentAttemptId = identity.attemptId;
    const budget = this.budget;
    const attempt: RepairAttempt = {
      attemptNumber: this.#used,
      runId: this.#runId,
      taskId: this.#taskId,
      identity,
      evidence,
      invalidatedReceiptIds,
      budget,
      instructions: renderRepairInstructions(this.#runId, this.#taskId, identity, evidence, budget),
    };
    this.#attempts.push(attempt);
    return { kind: 'repair', attempt, budget };
  }
}
