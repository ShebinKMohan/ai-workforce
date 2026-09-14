import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runsDocument, runStatusJson } from '../../src/server/read-api.js';
import { writeArtifact } from '../../src/storage/artifacts.js';
import { appendEvent } from '../../src/storage/events.js';
import { beginNewGeneration, transitionRun, transitionTask } from '../../src/storage/records.js';
import { seedAttempt, seedRun, seedTask } from '../coordination/helpers.js';
import { openTempState } from '../helpers/state.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const state = openTempState(); cleanups.push(state.cleanup);
  const { store, paths } = state; const run = seedRun(store.db); const task = seedTask(store.db, run.id); const attempt = seedAttempt(store.db, task.id);
  const candidateRevision = 'a'.repeat(40); const diffHash = 'b'.repeat(64); const checkId = randomUUID();
  transitionRun(store.db, run.id, 'running'); transitionTask(store.db, task.id, 'ready'); transitionTask(store.db, task.id, 'running');
  store.db.prepare(`INSERT INTO checks(id, run_id, task_id, attempt_id, criterion_ids_json, command, args_json, cwd, env_identity, candidate_revision, outcome, exit_code, evidence_provenance, created_at)
    VALUES (?, ?, ?, ?, '["test"]', 'node', '["test.js"]', '.', '{}', ?, 'passed', 0, 'verifier_executed', ?)`).run(checkId, run.id, task.id, attempt.id, candidateRevision, new Date().toISOString());
  const manifest = writeArtifact(store.db, paths, { runId: run.id, taskId: task.id, attemptId: attempt.id, type: 'result_manifest', relativePath: `tasks/${attempt.id}/result.json`, bytes: JSON.stringify({ requirements: [{ criterionId: 'test', status: 'passed', receiptId: checkId }], acceptance: { accepted: true } }), provenance: { producer: 'test coordinator fixture' } });
  transitionTask(store.db, task.id, 'validating'); transitionTask(store.db, task.id, 'accepted'); transitionRun(store.db, run.id, 'ready_for_review');
  function review(fields: Record<string, unknown> = {}, combinedRevision = candidateRevision) {
    appendEvent(store.db, { runId: run.id, type: 'integration.combined', payload: { combinedRevision, accepted: true, unverifiedCriteria: [] } });
    const decision = { reviewId: randomUUID(), headAgentId: 'head', candidateRevision, diffHash, verdict: 'passed', sessionStopped: true, interrupted: false, ...fields };
    const artifact = writeArtifact(store.db, paths, { runId: run.id, type: 'head_review_result', relativePath: `head/${decision.reviewId}.json`, bytes: JSON.stringify(decision), provenance: { producer: 'headReviewer' } });
    appendEvent(store.db, { runId: run.id, type: 'head.review_finished', payload: { ...decision, artifactId: artifact.id } });
    return path.join(paths.runArtifactsDir(run.id), artifact.relativePath);
  }
  const summary = () => (runsDocument(paths, 10)['runs'] as Array<Record<string, any>>).find(entry => entry['id'] === run.id)!;
  return { ...state, run, task, manifestPath: path.join(paths.runArtifactsDir(run.id), manifest.relativePath), review, summary };
}

describe('authoritative delivery summaries', () => {
  it('recognizes a verified planned candidate without a direct-run outcome and shares the verdict with detail', () => {
    const f = fixture(); f.review(); const summary = f.summary();
    expect(summary['outcome']).toBeNull();
    expect(summary['delivery']).toMatchObject({ state: 'verified', verified: true, analysisReviewed: false, checks: { passed: 1, total: 1 }, evidenceIssues: [] });
    const detail = JSON.parse(runStatusJson(f.root, f.run.id));
    expect(detail.delivery).toEqual(summary['delivery']); expect(detail.run.delivery).toEqual(summary['delivery']);
  });

  it('never treats a passing head event without its registered artifact as verified delivery', () => {
    const f = fixture(); appendEvent(f.store.db, { runId: f.run.id, type: 'head.review_finished', payload: { verdict: 'passed', sessionStopped: true, interrupted: false } });
    expect(f.summary()['delivery']).toMatchObject({ verified: false, state: 'blocked', reason: expect.stringContaining('registered result artifact') });
  });

  it.each(['missing-review', 'corrupt-review', 'different-candidate', 'newer-combination', 'missing-check-manifest', 'superseded-generation'] as const)('refuses %s evidence', defect => {
    const f = fixture(); const reviewFile = f.review({}, defect === 'different-candidate' ? 'c'.repeat(40) : undefined);
    if (defect === 'missing-review') unlinkSync(reviewFile);
    if (defect === 'corrupt-review') writeFileSync(reviewFile, '{}');
    if (defect === 'newer-combination') appendEvent(f.store.db, { runId: f.run.id, type: 'integration.combined', payload: { combinedRevision: 'd'.repeat(40), accepted: true, unverifiedCriteria: [] } });
    if (defect === 'missing-check-manifest') unlinkSync(f.manifestPath);
    if (defect === 'superseded-generation') beginNewGeneration(f.store.db, f.task.id);
    expect(f.summary()['delivery']).toMatchObject({ verified: false });
  });
});
