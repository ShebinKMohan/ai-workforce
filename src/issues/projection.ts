/** Read-only board state. A queue exit code is never a delivery verdict. */
import type { RequestItem } from '../server/requests.js';
import type { WorkspaceConfig } from '../core/workspace-config.js';
import { START_TIME_TOLERANCE_MS } from '../core/process.js';
import { readableProjectPaths } from '../server/project-reads.js';
import { analysisEvidenceView } from '../storage/analysis-view.js';
import { openStateStore, type StateStore } from '../storage/db.js';
import { headReviewView } from '../storage/head-review-view.js';
import { classifyHolder, readLockInfo } from '../storage/lock.js';
import { findRun } from '../storage/records.js';
import { runEvidenceView } from '../storage/run-evidence.js';
import { runDeliveryView } from '../storage/delivery-view.js';
import { redactText } from '../telemetry/redaction.js';
import type { IssueRecord, IssueStatus } from './contracts.js';
import { selectIssueRequest } from './request-lineage.js';

export type IssueExecutionState = 'idle' | 'dispatching' | 'queued' | 'running' | 'review' | 'completed' | 'answered' | 'cancelled' | 'blocked' | 'interrupted' | 'unknown';
export interface IssueView {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly kind: IssueRecord['kind'];
  readonly source: string;
  readonly priority: IssueRecord['priority'];
  readonly manualStatus: IssueStatus;
  readonly status: IssueStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
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
    readonly phase: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly completedAt: string | null;
    readonly updatedAt: string | null;
    readonly department: { id: string; name: string } | null;
    readonly owners: Array<{ id: string; name: string; role: string | null; avatarId: string | null }>;
    readonly checks: { passed: number; total: number } | null;
  };
}

const LIVE_RUN_STATES = new Set(['pending', 'running', 'waiting']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const message = (value: unknown): string | null => typeof value === 'string' && value.trim() ? redactText(value) : null;
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const latestTime = (...values: unknown[]): string | null => values.map(timestamp).filter((value): value is string => value !== null).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
const earliestTime = (...values: unknown[]): string | null => values.map(timestamp).filter((value): value is string => value !== null).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

function latestEvent(store: StateStore, runId: string, type: string): { sequence: number; payload: Record<string, unknown> } | null {
  const row = store.db.prepare('SELECT sequence, payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY sequence DESC LIMIT 1').get(runId, type) as { sequence: number; payload_json: string } | undefined;
  if (!row) return null;
  const payload = object(JSON.parse(row.payload_json));
  return payload ? { sequence: row.sequence, payload } : null;
}

export function issueView(issue: IssueRecord, stateRoot: string, request: RequestItem | null, dispatchActive = false, relatedRequests: readonly RequestItem[] = [], workspace: WorkspaceConfig | null = null): IssueView {
  const dispatch = issue.dispatch;
  const receipts = request && !relatedRequests.some(item => item.id === request.id) ? [request, ...relatedRequests] : relatedRequests;
  const selection = selectIssueRequest(issue, receipts);
  const saved = selection.current;
  const current = selection.live;
  const item = current ?? saved;
  const runId = item?.runId ?? item?.resumeRunId ?? null;
  let runState: string | null = null;
  let workKind: 'analysis' | 'implementation' | null = null;
  let phase: string | null = null;
  let startedAt = timestamp(item?.startedAt);
  let endedAt = timestamp(item?.endedAt);
  let completionEvidenceAt: string | null = null;
  let updatedAt = latestTime(item?.receivedAt, item?.startedAt, item?.endedAt, item?.stopRequestedAt, item?.route?.decidedAt, dispatch?.startedAt);
  let departmentId = item?.departmentId ?? null;
  let owners: IssueView['execution']['owners'] = [];
  let checks: IssueView['execution']['checks'] = null;
  const owner = (id: string, role: 'head' | 'worker'): IssueView['execution']['owners'][number] => {
    const agent = workspace?.agents.find(agent => agent.id === id);
    return { id, name: agent?.name ?? id, role, avatarId: agent?.avatarId ?? null };
  };
  const view = (status: IssueStatus, state: IssueExecutionState, reason: string | null, verified = false, analysisReviewed = false): IssueView => ({
    schemaVersion: issue.schemaVersion, id: issue.id, projectId: issue.projectId, revision: issue.revision,
    title: issue.title, description: issue.description, kind: issue.kind, source: issue.source, priority: issue.priority,
    manualStatus: issue.manualStatus, status, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    completedAt: !dispatch || dispatch.state === 'refused' ? issue.completedAt : null,
    requestId: item?.id ?? null, runId,
    execution: { state, reason, verified, analysisReviewed, workKind, requestState: current?.state ?? saved?.state ?? null, runState,
      phase: ['idle', 'blocked', 'interrupted', 'unknown', 'completed', 'answered', 'cancelled'].includes(state) ? state === 'idle' ? null : state : phase ?? (state === 'running' ? 'control_center' : state),
      startedAt, endedAt, completedAt: state === 'answered' || state === 'completed' && (verified || analysisReviewed) ? completionEvidenceAt : null, updatedAt,
      department: departmentId ? { id: departmentId, name: workspace?.departments.find(department => department.id === departmentId)?.name ?? departmentId } : null,
      owners, checks },
  });
  if (!dispatch) return issue.manualStatus === 'cancelled'
    ? view('cancelled', 'cancelled', 'This issue was canceled before submission.')
    : view(issue.manualStatus, 'idle', null);
  if (request && (request.projectId !== issue.projectId || request.clientRequestId !== dispatch.clientRequestId || request.task !== dispatch.task)) return view('todo', 'unknown', 'The request receipt does not match this issue submission.');
  if (selection.conflict) return view('todo', 'unknown', selection.conflict);

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
      startedAt = earliestTime(item?.startedAt, run.created_at);
      // A stopped request may have a resumed run. Its original process end is
      // not the current run's end, and old run ended_at values do not end a live resume.
      endedAt = LIVE_RUN_STATES.has(run.state) ? null : timestamp(run.ended_at);
      updatedAt = latestTime(updatedAt, run.updated_at, endedAt);
      const facts = runEvidenceView(store, runId);
      const evidence = analysisEvidenceView(store, runId, facts.manifest, facts.evidenceIssues);
      workKind = evidence.workKind;
      const tasks = facts.taskViews.filter(task => task['state'] !== 'superseded');
      const head = headReviewView(store.db, runId).headReview;
      const planning = latestEvent(store, runId, 'head.planning_started')?.payload;
      if (typeof planning?.['departmentId'] === 'string') departmentId = planning['departmentId'];
      const headId = typeof head?.['headAgentId'] === 'string' ? head['headAgentId'] : typeof planning?.['headAgentId'] === 'string' ? planning['headAgentId'] : null;
      const workerIds = [...new Set(tasks.map(task => task['ownerAgentId']).filter((id): id is string => typeof id === 'string' && id !== headId))];
      owners = [...(headId ? [owner(headId, 'head')] : []), ...workerIds.map(id => owner(id, 'worker'))];
      updatedAt = latestTime(updatedAt, head?.['at'], ...tasks.map(task => object(task['lastEvent'])?.['timestamp']));
      const delivery = runDeliveryView(store, run, facts, { evidence, head });
      checks = delivery.checks;
      completionEvidenceAt = latestTime(endedAt, head?.['at']);
      phase = head?.['state'] === 'running' ? 'head_review' : tasks.some(task => task['state'] === 'validating') || (tasks.length > 0 && tasks.every(task => task['state'] === 'accepted')) ? 'validating' : tasks.length > 0 ? 'working' : 'planning';
      // A valid retry may be queued to resume the same failed run. Retain the
      // run's evidence, while showing the new request's waiting/start phase.
      if (current?.retryOfRequestId && current.kind === 'resume' && run.state !== 'ready_for_review' && run.state !== 'cancelled') {
        if (current.state === 'queued') { phase = 'queued'; endedAt = null; return view('todo', 'queued', message(current.reason) ?? 'The retry is waiting to resume this recorded run.'); }
        if (current.state === 'held') return view('todo', 'blocked', message(current.reason) ?? 'The retry is held before resuming this recorded run.');
        if (current.state === 'starting' && !LIVE_RUN_STATES.has(run.state)) { phase = 'resuming'; endedAt = null; return view('in_progress', 'dispatching', 'The retry is starting the recorded run.'); }
      }
      if (run.state === 'ready_for_review') {
        if (delivery.verified || delivery.analysisReviewed) return view('done', 'completed', delivery.reason, delivery.verified, delivery.analysisReviewed);
        return view('in_review', delivery.state === 'unknown' ? 'unknown' : 'blocked', delivery.reason);
      }
      const reason = message(head?.['summary']) ?? (Array.isArray(facts.outcome?.['reasons']) ? message(facts.outcome['reasons'].join(' ')) : null);
      if (run.state === 'cancelled') return view('cancelled', 'cancelled', 'The run was canceled before completion.');
      if (run.state === 'interrupted') return view('todo', 'interrupted', reason ?? 'The run stopped before completion. Resume it to continue.');
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
      // Cancellation is a durable run lifecycle fact, independent of whether
      // abandoned candidate artifacts can still be inspected.
      if (runState === 'cancelled') return view('cancelled', 'cancelled', 'The run was canceled before completion.');
      return view(runState === 'ready_for_review' ? 'in_review' : 'todo', 'unknown', redactText(`The linked run evidence could not be verified: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      store?.close();
    }
  }

  if (dispatch.state === 'refused') return issue.manualStatus === 'cancelled'
    ? view('cancelled', 'cancelled', 'This issue was canceled after its submission was refused.')
    : view('todo', 'blocked', message(dispatch.error) ?? 'The submission was refused before execution.');
  if (dispatch.state === 'pending' && !current) return dispatchActive
    ? view('in_progress', 'dispatching', 'The issue is being submitted to Control Center.')
    : view('todo', 'unknown', 'A submission intent was saved, but no request receipt confirms what started. Reconcile it before submitting again.');
  // A complete terminal receipt survives queue retention. A direct Control
  // Center answer resolves the conversation, never implementation checks.
  // Match the structured disposition; titles and reply prose are not states.
  if (item?.state === 'discarded') return view('cancelled', 'cancelled', 'The request was canceled before a project run started.');
  const reply = message(item?.controlReply) ?? message(item?.result?.message);
  if (item?.state === 'ended' && item.exitCode === 0 && item.result?.exitCode === 0
      && item.result.code === 'control_reply' && item.route?.state === 'selected' && item.route.method === 'direct_reply'
      && item.route.projectId === issue.projectId && item.route.departmentId === null && item.departmentId === null
      && !item.stopRequestedAt && item.signal === null && (!item.routingSession || item.routingSession.state === 'stopped')
      && endedAt && reply) {
    startedAt = timestamp(item.receivedAt);
    completionEvidenceAt = endedAt;
    owners = [{ id: 'control-center', name: 'Control Center', role: 'control', avatarId: item.controlCenter?.avatarId ?? workspace?.controlCenter?.avatarId ?? null }];
    return view('done', 'answered', reply);
  }
  // A nonterminal old receipt with no run cannot prove what happened after
  // queue retention removed it. Keep it visible without inventing completion.
  if (!current) return view('todo', 'unknown', 'The request is no longer in the queue and no run has been recorded for this issue.');
  if (current.state === 'queued') return view('todo', 'queued', message(current.reason) ?? 'Waiting for Control Center to start this issue.');
  if (current.state === 'held') return view('todo', 'blocked', message(current.reason) ?? 'This submission is held and needs to be started.');
  if (current.state === 'starting' || current.state === 'running') return view('in_progress', 'running', message(current.reason) ?? 'Control Center is routing or starting the issue.');
  if (current.state === 'failed_to_start') return view('todo', 'blocked', message(current.result?.message) ?? message(current.reason) ?? 'The request could not start.');
  return view('todo', 'blocked', message(current.controlReply) ?? message(current.result?.message) ?? 'The request ended without a verified development run.');
}
