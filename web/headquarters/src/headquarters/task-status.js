/** Shared presentation of coordinator facts. A stopped session is never completed work. */
const status = (bucket, label, tone) => ({ bucket, label, tone });
const stateOf = record => String(record?.state ?? record?.status ?? '').toLowerCase().replaceAll(' ', '_');
const active = new Set(['received', 'routing', 'starting', 'running', 'stopping']);

/** A resume is another receipt for the same run, not a second current task. */
export function latestRunRequests(requests = []) {
  const latest = new Map();
  const received = request => Date.parse(request.receivedAt || request.createdAt || '') || 0;
  for (const request of requests) {
    const runId = request.runId || request.resumeRunId;
    const key = runId ? JSON.stringify([request.projectId, runId]) : `request:${request.id}`;
    const previous = latest.get(key);
    if (!previous || received(request) > received(previous) || received(request) === received(previous) && String(request.id) > String(previous.id)) latest.set(key, request);
  }
  return [...latest.values()];
}

export function newerRunRequest(request = {}, requests = []) {
  const runId = request.runId || request.resumeRunId;
  if (!runId) return null;
  return latestRunRequests([request, ...requests]).find(item => item.projectId === request.projectId && (item.runId || item.resumeRunId) === runId && item.id !== request.id) || null;
}

export function savedRequestText(request = {}, run) {
  if (typeof request.task === 'string' && request.task.trim()) return request.task;
  const runId = request.runId || request.resumeRunId;
  return runId && run?.id === runId && (!run.projectId || run.projectId === request.projectId) && typeof run.request?.text === 'string' ? run.request.text : '';
}

/** A missing review decision is recoverable final review, not an owner cancellation. */
export function headReviewNeedsRetry(request = {}, run) {
  const linkedRunId = request?.runId || request?.resumeRunId;
  if (!linkedRunId || run?.id !== linkedRunId || run.projectId && run.projectId !== request.projectId) return false;
  if (request.stopRequestedAt || request.signal || !['ended', 'failed', 'interrupted'].includes(stateOf(request))) return false;
  if (!['interrupted', 'failed', 'waiting'].includes(stateOf(run))) return false;
  const review = run.headReview;
  if (review?.state !== 'blocked' || review.sessionStopped !== true || review.interrupted === true) return false;
  return review.failureCode === 'head_review_invalid' || /^The head did not submit a structured review decision\.(?:\s|$)/.test(review.summary || '');
}

/** Consume the server's immutable delivery gate; legacy direct runs carry a checked outcome. */
export function runVerificationFacts(run = {}) {
  const outcome = run?.outcome, delivery = run?.delivery;
  const runIssues = ['compromisedReceiptIds','unverifiedReceiptIds','evidenceIssues'].some(key => run?.[key] != null && (!Array.isArray(run[key]) || run[key].length > 0));
  const count = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  if (delivery != null) {
    const passed = count(delivery.checks?.passed), total = count(delivery.checks?.total);
    const contradictory = outcome?.accepted === false || outcome?.acceptance?.accepted === false || ['blocked','changes_requested'].includes(run.headReview?.state) || run.headReview?.interrupted === true || run.headReview?.sessionStopped === false;
    const verified = !contradictory && run.state === 'ready_for_review' && run.workKind !== 'analysis' && delivery.verified === true && Array.isArray(delivery.evidenceIssues) && delivery.evidenceIssues.length === 0 && !runIssues;
    // Explicit failed or unknown delivery evidence cannot inherit a prior outcome.
    return { verified, checksVerified: verified, passed, total, source: 'delivery', reason: typeof delivery.reason === 'string' ? delivery.reason : '' };
  }
  const passed = count(outcome?.requiredPassed), total = count(outcome?.requiredTotal);
  const checksVerified = run?.workKind !== 'analysis' && outcome?.accepted === true && total > 0 && passed === total && !runIssues &&
    !['compromised','failed','noEvidence'].some(key => outcome[key] != null && (!Array.isArray(outcome[key]) || outcome[key].length > 0));
  const review = run?.headReview;
  return { verified: run?.state === 'ready_for_review' && checksVerified && review?.state === 'passed' && review.interrupted !== true && review.sessionStopped !== false,
    checksVerified, passed, total, source: outcome ? 'outcome' : null, reason: '' };
}

export function requestTaskStatus(request = {}, run, requests = [], { runsLoaded = true } = {}) {
  if (newerRunRequest(request, requests)) return status('closed', 'Continued in newer attempt', 'stopped');
  const state = stateOf(request);
  const linkedRunId = request.runId || request.resumeRunId;
  if (run && (run.id && run.id !== linkedRunId || run.projectId && request.projectId && run.projectId !== request.projectId)) run = null;
  if (request.stopRequestedAt && ['queued', ...active].includes(state)) return status('progress', 'Stopping', 'running');
  if (headReviewNeedsRetry(request, run)) return status('waiting', 'Review needs retry', 'blocked');
  if (['discarded', 'cancelled', 'canceled', 'interrupted', 'stopped'].includes(state) || request.signal || request.result?.code === 'interrupted') return status('closed', state === 'discarded' ? 'Discarded' : 'Stopped', 'stopped');
  if (state === 'failed_to_start' && !request.runId && (request.result?.code === 'no_worker_on_project' || request.route?.code === 'no_worker_on_project')) return status('closed', 'Did not start', 'stopped');
  if (request.route?.state === 'blocked' || ['held', 'blocked', 'failed', 'failed_to_start'].includes(state)) return status('waiting', state === 'held' ? 'Paused' : state === 'blocked' || request.route?.state === 'blocked' ? 'Needs input' : 'Needs attention', 'blocked');
  if (request.route?.state === 'pending' && ['queued', ...active].includes(state)) return status('progress', 'Routing', 'running');
  if (state === 'queued' || state === 'pending') return status('backlog', 'Queued', 'queued');
  if (active.has(state)) return status('progress', ({received:'Received',routing:'Routing',starting:'Starting',stopping:'Stopping'})[state] || 'Working', 'running');
  if (state === 'ended') {
    if (linkedRunId && !run && !runsLoaded) return status('loading', 'Loading result', 'idle');
    const outcome = run?.outcome;
    if (['cancelled', 'interrupted'].includes(run?.state)) return status('closed', 'Stopped', 'stopped');
    if (run?.workKind === 'analysis') {
      if (run.state === 'ready_for_review' && run.analysis?.reviewed === true && run.analysis?.sourceUnchanged === true && run.analysis?.reportCount > 0 && Array.isArray(run.analysis?.evidenceIssues) && run.analysis.evidenceIssues.length === 0) return status('done', 'Reviewed analysis', 'complete');
      return status('waiting', run.state === 'failed' ? 'Analysis needs attention' : 'Analysis evidence incomplete', 'blocked');
    }
    if (run?.state === 'failed' || ['blocked', 'changes_requested'].includes(run?.headReview?.state) || outcome?.accepted === false || outcome?.acceptance?.accepted === false) return status('waiting', 'Needs attention', 'blocked');
    if (linkedRunId) {
      if (!run) return status('waiting', 'Evidence not loaded', 'blocked');
      const accepted = runVerificationFacts(run).verified;
      return accepted ? status('done', 'Verified', 'complete') : status('waiting', 'Evidence incomplete', 'blocked');
    }
    if ((request.exitCode === 0 || request.exitCode == null) && request.controlReply) return status('done', 'Answered', 'complete');
    return status('waiting', 'Needs attention', 'blocked');
  }
  return status('waiting', state ? 'Needs attention' : 'Awaiting status', 'blocked');
}

export function taskWorkStatus(task = {}, run) {
  // The task's accepted state is stronger evidence than an attempt merely ending.
  const state = stateOf(task);
  if (state === 'accepted') return status('done', run?.workKind === 'analysis' ? 'Reviewed report' : 'Completed', 'complete');
  if (state === 'validating' && run?.workKind === 'analysis') return status('backlog', 'Report ready', 'queued');
  if (['cancelled', 'superseded', 'interrupted'].includes(state)) return status('closed', state === 'superseded' ? 'Replaced' : 'Stopped', 'stopped');
  if (state === 'running' || state === 'validating') return status('progress', state === 'validating' ? 'Verifying' : 'Working', 'running');
  if (state === 'pending' || state === 'ready') return status('backlog', 'Next', 'queued');
  if (state === 'waiting' && ['dependency', 'peer'].includes(task.waitReason || task.reason)) return status('backlog', 'Waiting on team', 'queued');
  return status('waiting', state === 'failed' ? 'Needs attention' : 'Waiting', 'blocked');
}
