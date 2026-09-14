/** A delivery verdict from immutable current-candidate evidence, shared by
 * run lists, detail and the Issues board. Runtime prose is never sufficient. */
import type { StateStore } from './db.js';
import type { RunRow } from './records.js';
import { getArtifact, readArtifact } from './artifacts.js';
import { headReviewView } from './head-review-view.js';
import { runEvidenceView } from './run-evidence.js';
import { analysisEvidenceView } from './analysis-view.js';
import { redactText } from '../telemetry/redaction.js';

export interface RunDeliveryView {
  readonly state: 'verified' | 'review' | 'blocked' | 'unknown';
  readonly verified: boolean;
  readonly analysisReviewed: boolean;
  /** Current-attempt verifier receipt counts, including failed/other receipts. */
  readonly checks: { passed: number; total: number } | null;
  readonly evidenceIssues: string[];
  readonly reason: string;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function latestEvent(store: StateStore, runId: string, type: string): { sequence: number; payload: Record<string, unknown> } | null {
  const row = store.db.prepare('SELECT sequence, payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1').get(runId, type) as { sequence: number; payload_json: string } | undefined;
  if (!row) return null;
  const payload = object(JSON.parse(row.payload_json));
  return payload ? { sequence: row.sequence, payload } : null;
}

function reviewFailure(store: StateStore, runId: string, head: Record<string, unknown> | null): string | null {
  if (!head || head['state'] !== 'passed' || head['verdict'] !== 'passed') return 'A passing department-head review is not recorded.';
  if (head['sessionStopped'] !== true || head['interrupted'] !== false) return 'The department-head review has no confirmed clean completion.';
  if (typeof head['artifactId'] !== 'string') return 'The department-head review has no registered result artifact.';
  const record = getArtifact(store.db, head['artifactId']);
  if (record.runId !== runId || record.type !== 'head_review_result') return 'The review artifact does not belong to this run and review.';
  const review = object(JSON.parse(readArtifact(store.db, store.paths, record.id).bytes.toString('utf8')));
  if (!review || review['verdict'] !== 'passed' || review['sessionStopped'] !== true || review['interrupted'] !== false) return 'The recorded review artifact does not approve delivery.';
  for (const field of ['reviewId', 'headAgentId', 'candidateRevision', 'diffHash'] as const) {
    if (typeof head[field] !== 'string' || !head[field] || review[field] !== head[field]) return 'The recorded review does not match the reviewed candidate identity.';
  }
  const combined = latestEvent(store, runId, 'integration.combined');
  const finished = latestEvent(store, runId, 'head.review_finished');
  const criteria = combined?.payload['unverifiedCriteria'];
  if (!combined || !finished || combined.sequence >= finished.sequence || combined.payload['accepted'] !== true || !Array.isArray(criteria) || criteria.length !== 0 || combined.payload['combinedRevision'] !== head['candidateRevision']) return 'The review is not bound to the latest verified combined candidate.';
  return null;
}

export function runDeliveryView(store: StateStore, run: RunRow, facts = runEvidenceView(store, run.id), cached: { evidence?: ReturnType<typeof analysisEvidenceView>; head?: Record<string, unknown> | null } = {}): RunDeliveryView {
  let checks: RunDeliveryView['checks'] = null;
  const view = (state: RunDeliveryView['state'], reason: string, evidenceIssues: string[] = [], verified = false, analysisReviewed = false): RunDeliveryView => ({ state, reason, evidenceIssues, verified, analysisReviewed, checks });
  try {
    const tasks = facts.taskViews.filter(task => task['state'] !== 'superseded');
    const counts = tasks.reduce<{ passed: number; total: number }>((sum, task) => {
      const receipts = object(task['receipts']);
      const count = (key: string) => typeof receipts?.[key] === 'number' ? Number(receipts[key]) : 0;
      const passed = count('verifierExecutedPassed');
      return { passed: sum.passed + passed, total: sum.total + passed + count('verifierExecutedCompromised') + count('verifierExecutedFailed') + count('verifierExecutedOther') };
    }, { passed: 0, total: 0 });
    checks = counts.total > 0 ? counts : null;
    if (run.state !== 'ready_for_review') return view(run.state === 'failed' || run.state === 'cancelled' || run.state === 'interrupted' ? 'blocked' : 'unknown', 'The run has not reached verified delivery.');
    const evidence = cached.evidence ?? analysisEvidenceView(store, run.id, facts.manifest, facts.evidenceIssues);
    if (evidence.workKind === 'analysis') {
      const analysis = evidence.analysis;
      if (!analysis?.reviewed || !analysis.sourceUnchanged || analysis.reportCount === 0 || analysis.evidenceIssues.length) {
        const issues = analysis?.evidenceIssues ?? [];
        return view('blocked', issues.join(' ') || 'The analysis report and its department-head review do not have complete delivery evidence.', issues);
      }
      return view('review', 'The department head reviewed the analysis report. The inspected source is unchanged.', [], false, true);
    }
    if (facts.evidenceIssues.length) return view('blocked', facts.evidenceIssues.join(' '), [...facts.evidenceIssues]);
    const verifiedTasks = tasks.length > 0 && tasks.every(task => task['state'] === 'accepted' && Number(object(task['receipts'])?.['verifierExecutedPassed'] ?? 0) > 0);
    if (!verifiedTasks) return view('blocked', 'The current task candidates do not all have passing independent verifier evidence.');
    if (facts.outcome?.['accepted'] === false) return view('blocked', 'The saved acceptance result does not approve this candidate.');
    const failure = reviewFailure(store, run.id, cached.head !== undefined ? cached.head : headReviewView(store.db, run.id).headReview);
    if (failure) return view('blocked', failure);
    return view('verified', 'The candidate passed independent checks and department-head review.', [], true);
  } catch (error) {
    const reason = redactText(`Delivery evidence could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    return view('unknown', reason, [reason]);
  }
}
