import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/core/snapshot.js';
import { evaluateCombinedAcceptance } from '../../src/integration/combine.js';
import {
  ReviewIntegrityError,
  applyReviewToAcceptance,
  changeShapeFromDiff,
  decideReview,
  requestReview,
  type ReviewRequest,
  type Reviewer,
} from '../../src/integration/review.js';
import { cleanupAll, makeReceipt, tempDir } from './support.js';

afterAll(() => cleanupAll());

const COVERED = [{ id: 'tests', description: 'the suite passes', check: { command: 'npm', args: ['test'] } }];

function recordingReviewer(findings: ReviewRequest[] = []): Reviewer & { readonly seen: ReviewRequest[] } {
  const seen: ReviewRequest[] = findings;
  return {
    id: 'reviewer-1',
    seen,
    async review(request: ReviewRequest) {
      seen.push(request);
      return { findings: [{ severity: 'concern' as const, file: 'src/a.ts', line: 3, summary: 'the new branch is not covered', criterionId: 'tests' }], summary: 'one concern' };
    },
  };
}

describe('risk-based review (FR051)', () => {
  it('does not warrant review for a small, narrow, fully covered change', () => {
    const decision = decideReview({ shape: { changedFiles: ['src/a.ts'], addedLines: 4, removedLines: 1 }, acceptanceCriteria: COVERED });
    expect(decision.warranted).toBe(false);
    expect(decision.triggers).toEqual([]);
  });

  it('warrants review when configured, when the change is large, when it is broad, or when nothing executable covers it', () => {
    expect(decideReview({ shape: { changedFiles: ['a'], addedLines: 1, removedLines: 0 }, acceptanceCriteria: COVERED, configured: true }).triggers[0]!.reason).toBe('configured');

    const large = decideReview({ shape: { changedFiles: ['a'], addedLines: 500, removedLines: 10 }, acceptanceCriteria: COVERED });
    expect(large.triggers.map((trigger) => trigger.reason)).toEqual(['large_change']);
    expect(large.triggers[0]!.detail).toContain('510 line(s)');

    const broad = decideReview({ shape: { changedFiles: Array.from({ length: 11 }, (_, i) => `f${i}`), addedLines: 3, removedLines: 0 }, acceptanceCriteria: COVERED });
    expect(broad.triggers.map((trigger) => trigger.reason)).toEqual(['many_files']);

    const uncovered = decideReview({ shape: { changedFiles: ['a'], addedLines: 3, removedLines: 0 }, acceptanceCriteria: [{ id: 'looks-right', description: 'it reads well' }] });
    expect(uncovered.triggers.map((trigger) => trigger.reason)).toEqual(['no_test_coverage']);
    expect(uncovered.warranted).toBe(true);
  });

  it('measures the shape of a real diff', () => {
    const shape = changeShapeFromDiff(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-old', '+new', '+extra'].join('\n'));
    expect(shape).toEqual({ changedFiles: ['src/a.ts'], addedLines: 2, removedLines: 1 });
  });

  it('hands the reviewer the actual diff and the acceptance criteria', async () => {
    const dir = tempDir('wf-wp08-review-');
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
    const patchPath = path.join(dir, 'candidate.patch');
    writeFileSync(patchPath, diff, 'utf8');
    const reviewer = recordingReviewer();

    const outcome = await requestReview({
      taskId: 'task-a',
      attemptId: 'attempt-1',
      objective: 'fix the off-by-one',
      patchPath,
      patchHash: sha256Hex(Buffer.from(diff, 'utf8')),
      acceptanceCriteria: COVERED,
      reviewer,
      decision: decideReview({ shape: changeShapeFromDiff(diff), acceptanceCriteria: COVERED, configured: true }),
    });

    expect(reviewer.seen).toHaveLength(1);
    expect(reviewer.seen[0]!.diff).toBe(diff);
    expect(reviewer.seen[0]!.acceptanceCriteria).toEqual(COVERED);
    expect(reviewer.seen[0]!.changedFiles).toEqual(['src/a.ts']);
    expect(outcome.advisory).toBe(true);
    expect(outcome.findings).toHaveLength(1);
  });

  it('refuses to review content that is not the approved change', async () => {
    const dir = tempDir('wf-wp08-review-');
    const patchPath = path.join(dir, 'candidate.patch');
    writeFileSync(patchPath, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n', 'utf8');
    const error = await requestReview({
      taskId: 'task-a',
      attemptId: 'attempt-1',
      objective: 'fix',
      patchPath,
      patchHash: 'deadbeef',
      acceptanceCriteria: COVERED,
      reviewer: recordingReviewer(),
      decision: decideReview({ shape: { changedFiles: ['x'], addedLines: 1, removedLines: 1 }, acceptanceCriteria: COVERED, configured: true }),
    })
      .then(() => null)
      .catch((caught: unknown) => caught as ReviewIntegrityError);
    expect(error).toBeInstanceOf(ReviewIntegrityError);
    expect(error!.code).toBe('diff_hash_mismatch');
  });

  it('refuses to review an empty diff', async () => {
    const dir = tempDir('wf-wp08-review-');
    const patchPath = path.join(dir, 'candidate.patch');
    writeFileSync(patchPath, '', 'utf8');
    await expect(
      requestReview({
        taskId: 'task-a',
        attemptId: 'attempt-1',
        objective: 'fix',
        patchPath,
        patchHash: sha256Hex(Buffer.from('', 'utf8')),
        acceptanceCriteria: COVERED,
        reviewer: recordingReviewer(),
        decision: decideReview({ shape: { changedFiles: [], addedLines: 0, removedLines: 0 }, acceptanceCriteria: COVERED, configured: true }),
      }),
    ).rejects.toThrow(/actual change/);
  });

  it('never lets a review substitute for a missing required check', () => {
    const acceptance = evaluateCombinedAcceptance({
      combinedRevision: 'combined-rev',
      requiredCriteria: [{ id: 'tests' }],
      receipts: [makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: 'branch-rev', patchHash: null } })],
    });
    expect(acceptance.accepted).toBe(false);

    const cleanReview = {
      reviewerId: 'reviewer-1',
      taskId: 'task-a',
      attemptId: 'attempt-1',
      diffHash: 'abc',
      findings: [],
      summary: 'looks correct to me',
      triggers: [],
      advisory: true as const,
      reviewedAt: '2026-01-01T00:00:00.000Z',
    };
    const combined = applyReviewToAcceptance(acceptance, cleanReview);
    expect(combined.acceptance.accepted).toBe(false);
    expect(combined.acceptance).toBe(acceptance);
    expect(combined.note).toContain('does not substitute');
    expect(combined.note).toContain('tests');
  });
});
