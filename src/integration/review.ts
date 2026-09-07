/**
 * Risk-based review (FR051).
 *
 * Review is not run on everything and it is not run on nothing: it is warranted
 * when it is configured for the task, or when the change is large, or touches
 * many files, or when acceptance rests on criteria that have no executable
 * check behind them. Those conditions are reported individually so a report can
 * say *why* a reviewer was asked.
 *
 * Two hard properties:
 *
 *  - The reviewer receives the ACTUAL diff. `requestReview` reads the patch
 *    bytes and refuses to send anything whose sha256 does not match the hash
 *    recorded for the artifact, so a review can never be about a summary,
 *    a stale patch, or a description of a change.
 *  - Findings are advisory. `applyReviewToAcceptance` attaches them and returns
 *    the acceptance decision unchanged. A review can never satisfy a criterion
 *    whose required check did not run or did not pass.
 */
import { readFileSync } from 'node:fs';
import { nowIso } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import type { AcceptanceCriterion } from '../core/contracts.js';
import type { CombinedAcceptance } from './combine.js';

// ---------------------------------------------------------------------------
// Deciding whether review is warranted
// ---------------------------------------------------------------------------

export interface ReviewThresholds {
  /** Changed lines (added + removed) above which the change counts as large. */
  readonly largeChangeLines: number;
  /** Changed files above which the change counts as broad. */
  readonly manyFilesCount: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  largeChangeLines: 400,
  manyFilesCount: 10,
};

export type ReviewTriggerReason = 'configured' | 'large_change' | 'many_files' | 'no_test_coverage';

export interface ReviewTrigger {
  readonly reason: ReviewTriggerReason;
  readonly detail: string;
}

export interface ChangeShape {
  readonly changedFiles: ReadonlyArray<string>;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface ReviewDecisionInput {
  readonly shape: ChangeShape;
  /** Acceptance criteria for the task; a criterion with no `check` has no executable coverage. */
  readonly acceptanceCriteria: ReadonlyArray<Pick<AcceptanceCriterion, 'id' | 'description' | 'check'>>;
  /** Review requested by configuration for this task or agent. */
  readonly configured?: boolean;
  readonly thresholds?: ReviewThresholds;
}

export interface ReviewDecision {
  readonly warranted: boolean;
  readonly triggers: ReadonlyArray<ReviewTrigger>;
  readonly thresholds: ReviewThresholds;
  readonly reason: string;
}

/** Measure a unified diff without interpreting it. */
export function changeShapeFromDiff(diff: string): ChangeShape {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') files.add(value.startsWith('b/') ? value.slice(2) : value);
      continue;
    }
    if (line.startsWith('--- ')) {
      const value = line.slice(4).trim();
      if (value !== '/dev/null') files.add(value.startsWith('a/') ? value.slice(2) : value);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { changedFiles: [...files].sort(), addedLines: added, removedLines: removed };
}

export function decideReview(input: ReviewDecisionInput): ReviewDecision {
  const thresholds = input.thresholds ?? DEFAULT_REVIEW_THRESHOLDS;
  const triggers: ReviewTrigger[] = [];

  if (input.configured === true) {
    triggers.push({ reason: 'configured', detail: 'review is configured for this task' });
  }

  const changedLines = input.shape.addedLines + input.shape.removedLines;
  if (changedLines > thresholds.largeChangeLines) {
    triggers.push({
      reason: 'large_change',
      detail: `the change is ${changedLines} line(s) (${input.shape.addedLines} added, ${input.shape.removedLines} removed), above the ${thresholds.largeChangeLines}-line threshold`,
    });
  }

  if (input.shape.changedFiles.length > thresholds.manyFilesCount) {
    triggers.push({
      reason: 'many_files',
      detail: `the change touches ${input.shape.changedFiles.length} file(s), above the ${thresholds.manyFilesCount}-file threshold`,
    });
  }

  const uncovered = input.acceptanceCriteria.filter((criterion) => criterion.check === undefined).map((criterion) => criterion.id);
  if (input.acceptanceCriteria.length === 0) {
    triggers.push({ reason: 'no_test_coverage', detail: 'the task declares no acceptance criteria, so nothing executable establishes it' });
  } else if (uncovered.length === input.acceptanceCriteria.length) {
    triggers.push({ reason: 'no_test_coverage', detail: `no acceptance criterion has an executable check (${uncovered.join(', ')})` });
  } else if (uncovered.length > 0) {
    triggers.push({ reason: 'no_test_coverage', detail: `${uncovered.length} acceptance criterion/criteria have no executable check (${uncovered.join(', ')})` });
  }

  const warranted = triggers.length > 0;
  return {
    warranted,
    triggers,
    thresholds,
    reason: warranted ? triggers.map((trigger) => `${trigger.reason}: ${trigger.detail}`).join('; ') : 'the change is small, narrow and fully covered by executable checks',
  };
}

// ---------------------------------------------------------------------------
// The reviewer
// ---------------------------------------------------------------------------

export type FindingSeverity = 'info' | 'concern' | 'blocking_recommendation';

export interface ReviewFinding {
  readonly severity: FindingSeverity;
  readonly file: string | null;
  readonly line: number | null;
  readonly summary: string;
  /** Criterion this finding speaks to, when the reviewer named one. */
  readonly criterionId: string | null;
}

export interface ReviewRequest {
  readonly taskId: string;
  readonly attemptId: string;
  /** The exact patch bytes, verified against the artifact's recorded hash. */
  readonly diff: string;
  readonly diffHash: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<Pick<AcceptanceCriterion, 'id' | 'description' | 'check'>>;
  readonly objective: string;
  readonly triggers: ReadonlyArray<ReviewTrigger>;
}

export interface ReviewResponse {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly summary: string;
}

/** Injectable so review is testable without a runtime. */
export interface Reviewer {
  readonly id: string;
  review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResponse>;
}

export class ReviewIntegrityError extends Error {
  readonly code: 'diff_hash_mismatch' | 'empty_diff' | 'diff_unreadable';

  constructor(code: 'diff_hash_mismatch' | 'empty_diff' | 'diff_unreadable', message: string) {
    super(message);
    this.name = 'ReviewIntegrityError';
    this.code = code;
  }
}

export interface RequestReviewInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly objective: string;
  readonly patchPath: string;
  /** sha256 of the approved patch bytes. Verified before anything is sent. */
  readonly patchHash: string;
  readonly acceptanceCriteria: ReadonlyArray<Pick<AcceptanceCriterion, 'id' | 'description' | 'check'>>;
  readonly reviewer: Reviewer;
  readonly decision: ReviewDecision;
  readonly signal?: AbortSignal;
  readonly readPatch?: (patchPath: string) => string;
}

export interface ReviewOutcome {
  readonly reviewerId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly diffHash: string;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly summary: string;
  readonly triggers: ReadonlyArray<ReviewTrigger>;
  /** Always true. Review findings never establish or block acceptance on their own. */
  readonly advisory: true;
  readonly reviewedAt: string;
}

/**
 * Send the actual diff and the acceptance criteria to a reviewer.
 *
 * Refuses to review an empty diff or a patch whose bytes do not match the hash
 * the artifact was approved under.
 */
export async function requestReview(input: RequestReviewInput): Promise<ReviewOutcome> {
  const read = input.readPatch ?? ((patchPath: string) => readFileSync(patchPath, 'utf8'));
  let diff: string;
  try {
    diff = read(input.patchPath);
  } catch (error) {
    throw new ReviewIntegrityError('diff_unreadable', `could not read the diff at ${input.patchPath} to review it: ${(error as Error).message}`);
  }
  if (diff.trim().length === 0) {
    throw new ReviewIntegrityError('empty_diff', `the patch at ${input.patchPath} is empty; a reviewer must be given the actual change, never a placeholder`);
  }
  const actualHash = sha256Hex(Buffer.from(diff, 'utf8'));
  if (actualHash !== input.patchHash) {
    throw new ReviewIntegrityError(
      'diff_hash_mismatch',
      `the diff at ${input.patchPath} hashes to ${actualHash} but the approved artifact recorded ${input.patchHash}; refusing to review content that is not the approved change`,
    );
  }

  const shape = changeShapeFromDiff(diff);
  const request: ReviewRequest = {
    taskId: input.taskId,
    attemptId: input.attemptId,
    diff,
    diffHash: actualHash,
    changedFiles: shape.changedFiles,
    acceptanceCriteria: input.acceptanceCriteria,
    objective: input.objective,
    triggers: input.decision.triggers,
  };
  const response = await input.reviewer.review(request, input.signal);
  return {
    reviewerId: input.reviewer.id,
    taskId: input.taskId,
    attemptId: input.attemptId,
    diffHash: actualHash,
    findings: response.findings,
    summary: response.summary,
    triggers: input.decision.triggers,
    advisory: true,
    reviewedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Review is advisory
// ---------------------------------------------------------------------------

export interface AcceptanceWithReview {
  readonly acceptance: CombinedAcceptance;
  readonly review: ReviewOutcome | null;
  /** Findings the reviewer marked as blocking recommendations. Still advisory. */
  readonly blockingRecommendations: ReadonlyArray<ReviewFinding>;
  readonly note: string;
}

/**
 * Attach a review to an acceptance decision without changing it.
 *
 * A clean review does not satisfy a criterion whose required check did not run
 * or did not pass; a critical review does not by itself reject a candidate that
 * every required check established. The acceptance object returned is the one
 * that came in.
 */
export function applyReviewToAcceptance(acceptance: CombinedAcceptance, review: ReviewOutcome | null): AcceptanceWithReview {
  const blocking = (review?.findings ?? []).filter((finding) => finding.severity === 'blocking_recommendation');
  const unsatisfied = acceptance.verdicts.filter((verdict) => verdict.required && !verdict.satisfied);
  const note =
    review === null
      ? 'no review was performed; acceptance rests entirely on the executed checks'
      : unsatisfied.length > 0
        ? `the review is advisory and does not substitute for ${unsatisfied.length} required check(s) that did not establish the candidate: ${unsatisfied.map((verdict) => verdict.criterionId).join(', ')}`
        : `the review is advisory; acceptance rests on the executed checks, and the reviewer raised ${blocking.length} blocking recommendation(s) for a human to weigh`;
  return { acceptance, review, blockingRecommendations: blocking, note };
}
