/** Read-only board state. A queue exit code is never a delivery verdict. */
import type { RequestItem } from '../server/requests.js';
import { START_TIME_TOLERANCE_MS } from '../core/process.js';
import { readableProjectPaths } from '../server/project-reads.js';
import { getArtifact, readArtifact } from '../storage/artifacts.js';
import { analysisEvidenceView } from '../storage/analysis-view.js';
import { openStateStore, type StateStore } from '../storage/db.js';
import { headReviewView } from '../storage/head-review-view.js';
import { classifyHolder, readLockInfo } from '../storage/lock.js';
import { findRun } from '../storage/records.js';
import { runEvidenceView } from '../storage/run-evidence.js';
import { redactText } from '../telemetry/redaction.js';
import type { IssueRecord, IssueStatus } from './contracts.js';

export type IssueExecutionState = 'idle' | 'dispatching' | 'queued' | 'running' | 'review' | 'completed' | 'blocked' | 'interrupted' | 'unknown';
export interface IssueView {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly kind: IssueRecord['kind'];
  readonly source: string;
  readonly manualStatus: IssueStatus;
  readonly status: IssueStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestId: string | null;
  readonly runId: string | null;
  readonly execution: {
    readonly state: IssueExecutionState;
    readonly reason: string | null;
    readonly verified: boolean;
    readonly analysisReviewed: boolean;
    readonly workKind: 'analysis' | 'implementation' | null;
    readonly requestState: string | null;
    readonly runState: string | null;
  };
}

const LIVE_RUN_STATES = new Set(['pending', 'running', 'waiting']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const message = (value: unknown): string | null => typeof value === 'string' && value.trim() ? redactText(value) : null;

function latestEvent(store: StateStore, runId: string, type: string): { sequence: number; payload: Record<string, unknown> } | null {
  const row = store.db.prepare('SELECT sequence, payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1').get(runId, type) as { sequence: number; payload_json: string } | undefined;
  if (!row) return null;
  const payload = object(JSON.parse(row.payload_json));
  return payload ? { sequence: row.sequence, payload } : null;
}

/** The registered final gate artifact binds the head's decision to the last
 * accepted combination. Its producer already enforces exact-revision checks,
 * structured review submission, candidate integrity, and stopped processes. */
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
  if (!combined || !finished || combined.sequence >= finished.sequence || combined.payload['accepted'] !== true || !Array.isArray(criteria) || criteria.length !== 0 || combined.payload['combinedRevision'] !== head['candidateRevision']) {
    return 'The review is not bound to the latest verified combined candidate.';
  }
  return null;
}

export function issueView(issue: IssueRecord, stateRoot: string, request: RequestItem | null, dispatchActive = false, relatedRequests: readonly RequestItem[] = []): IssueView {
  const dispatch = issue.dispatch;
  const saved = dispatch?.request ?? null;
  const current = request && dispatch && request.projectId === issue.projectId && request.clientRequestId === dispatch.clientRequestId ? request : null;
  const item = current ?? saved;
  const runId = current?.runId ?? saved?.runId ?? null;
  let runState: string | null = null;
  let workKind: 'analysis' | 'implementation' | null = null;
  const view = (status: IssueStatus, state: IssueExecutionState, reason: string | null, verified = false, analysisReviewed = false): IssueView => ({
    schemaVersion: issue.schemaVersion, id: issue.id, projectId: issue.projectId, revision: issue.revision,
    title: issue.title, description: issue.description, kind: issue.kind, source: issue.source,
    manualStatus: issue.manualStatus, status, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    requestId: item?.id ?? null, runId,
    execution: { state, reason, verified, analysisReviewed, workKind, requestState: current?.state ?? saved?.state ?? null, runState },
  });
  if (!dispatch) return view(issue.manualStatus, 'idle', null);
  if (request && !current) return view('todo', 'unknown', 'The request receipt does not match this issue submission.');

  if (runId) {
    let store: StateStore | undefined;
    try {
      // This also refuses symlinked project roots: another project's evidence
      // must not approve this issue through an aliased state directory.
      const paths = readableProjectPaths(stateRoot, issue.projectId, null);
      store = openStateStore(paths, { mode: 'read-only' });
      store.db.exec('BEGIN');
      const run = findRun(store.db, runId);
      if (!run) return view('todo', 'unknown', 'The linked run is not recorded in this project.');
      runState = run.state;
      const facts = runEvidenceView(store, runId);
      const evidence = analysisEvidenceView(store, runId, facts.manifest, facts.evidenceIssues);
      workKind = evidence.workKind;
      const tasks = facts.taskViews.filter(task => task['state'] !== 'superseded');
      const head = headReviewView(store.db, runId).headReview;
      if (run.state === 'ready_for_review') {
        if (workKind === 'analysis') {
          const analysis = evidence.analysis;
          if (!analysis?.reviewed || !analysis.sourceUnchanged || analysis.reportCount === 0 || analysis.evidenceIssues.length) {
            return view('in_review', 'blocked', analysis?.evidenceIssues.join(' ') || 'The analysis report and its department-head review do not have complete delivery evidence.');
          }
          return view('done', 'completed', 'The department head reviewed the analysis report. The inspected source is unchanged.', false, true);
        }
        if (facts.evidenceIssues.length) return view('in_review', 'blocked', facts.evidenceIssues.join(' '));
        const verifiedTasks = tasks.length > 0 && tasks.every(task => task['state'] === 'accepted' && Number(object(task['receipts'])?.['verifierExecutedPassed'] ?? 0) > 0);
        if (!verifiedTasks) return view('in_review', 'blocked', 'The current task candidates do not all have passing independent verifier evidence.');
        if (facts.outcome?.['accepted'] === false) return view('in_review', 'blocked', 'The saved acceptance result does not approve this candidate.');
        const failure = reviewFailure(store, runId, head);
        if (failure) return view('in_review', 'blocked', failure);
        return view('done', 'completed', 'The candidate passed independent checks and department-head review.', true);
      }
      const reason = message(head?.['summary']) ?? (Array.isArray(facts.outcome?.['reasons']) ? message(facts.outcome['reasons'].join(' ')) : null);
      if (run.state === 'interrupted' || run.state === 'cancelled') return view('todo', 'interrupted', reason ?? 'The run stopped before completion. Resume it to continue.');
      if (run.state === 'failed') return view('todo', 'blocked', reason ?? 'The run failed before verified completion.');
      if (LIVE_RUN_STATES.has(run.state)) {
        const lock = readLockInfo(paths.lockPath);
        const holder = lock ? classifyHolder(lock) : null;
        if (!lock || holder === 'dead' || holder === 'pid_reused') return view('todo', 'interrupted', 'The run is recorded as active, but no coordinator holds this project. Resume it to continue.');
        // A project lock proves only that SOME run owns the project. Bind its
        // PID and observed process start to this exact run's live request (or
        // resume receipt), so an unrelated newer run cannot revive stale rows.
        const owner = [item, ...relatedRequests].find(candidate => candidate !== null
          && candidate.projectId === issue.projectId
          && (candidate.runId === runId || candidate.resumeRunId === runId)
          && (candidate.state === 'starting' || candidate.state === 'running')
          && candidate.pid === lock.pid
          && candidate.pidStartedAtMs !== null && lock.processStartedAtMs !== null
          && Math.abs(candidate.pidStartedAtMs - lock.processStartedAtMs) <= START_TIME_TOLERANCE_MS);
        if (holder !== 'alive' || !owner) return view('todo', 'unknown', 'No live request or resume receipt proves that this run owns the current project coordinator.');
        if (owner.stopRequestedAt) return view('in_progress', 'running', 'A stop was requested; waiting for the run to stop.');
        if (head?.['state'] === 'running') return view('in_review', 'review', workKind === 'analysis' ? 'The department head is reviewing the read-only analysis report.' : 'The department head is reviewing the candidate and its checks.');
        if (tasks.some(task => task['state'] === 'validating') || (tasks.length > 0 && tasks.every(task => task['state'] === 'accepted'))) return view('in_review', 'review', workKind === 'analysis' ? 'The read-only analysis report is being prepared for department-head review.' : 'Independent checks and integration are in progress.');
        return view('in_progress', 'running', tasks.length ? 'The assigned agents are working on this issue.' : 'The department head is planning and assigning the work.');
      }
      return view('todo', 'unknown', 'The linked run has no recognized execution state.');
    } catch (error) {
      return view(runState === 'ready_for_review' ? 'in_review' : 'todo', 'unknown', redactText(`The linked run evidence could not be verified: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      store?.close();
    }
  }

  if (dispatch.state === 'refused') return view('todo', 'blocked', message(dispatch.error) ?? 'The submission was refused before execution.');
  if (dispatch.state === 'pending' && !current) return dispatchActive
    ? view('in_progress', 'dispatching', 'The issue is being submitted to Control Center.')
    : view('todo', 'unknown', 'A submission intent was saved, but no request receipt confirms what started. Reconcile it before submitting again.');
  // An old receipt with no run id cannot prove what happened after queue
  // retention removed it. Keep it visible without inventing a completion.
  if (!current) return view('todo', 'unknown', 'The request is no longer in the queue and no run has been recorded for this issue.');
  if (current.state === 'queued') return view('todo', 'queued', message(current.reason) ?? 'Waiting for Control Center to start this issue.');
  if (current.state === 'held') return view('todo', 'blocked', message(current.reason) ?? 'This submission is held and needs to be started.');
  if (current.state === 'starting' || current.state === 'running') return view('in_progress', 'running', message(current.reason) ?? 'Control Center is routing or starting the issue.');
  if (current.state === 'discarded') return view('todo', 'interrupted', 'The request was discarded before starting.');
  if (current.state === 'failed_to_start') return view('todo', 'blocked', message(current.result?.message) ?? message(current.reason) ?? 'The request could not start.');
  return view('todo', 'blocked', message(current.controlReply) ?? message(current.result?.message) ?? 'The request ended without a verified development run.');
}
