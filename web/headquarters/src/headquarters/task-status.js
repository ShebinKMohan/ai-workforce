/** Shared presentation of coordinator facts. A stopped session is never completed work. */
const status = (bucket, label, tone) => ({ bucket, label, tone });
const stateOf = record => String(record?.state ?? record?.status ?? '').toLowerCase().replaceAll(' ', '_');
const active = new Set(['received', 'routing', 'starting', 'running', 'stopping']);

export function requestTaskStatus(request = {}, run) {
  const state = stateOf(request);
  if (request.stopRequestedAt && ['queued', ...active].includes(state)) return status('progress', 'Stopping', 'running');
  if (['discarded', 'cancelled', 'canceled', 'interrupted', 'stopped'].includes(state) || request.signal || request.result?.code === 'interrupted') return status('closed', state === 'discarded' ? 'Discarded' : 'Stopped', 'stopped');
  if (state === 'failed_to_start' && !request.runId && (request.result?.code === 'no_worker_on_project' || request.route?.code === 'no_worker_on_project')) return status('closed', 'Did not start', 'stopped');
  if (request.route?.state === 'blocked' || ['held', 'blocked', 'failed', 'failed_to_start'].includes(state)) return status('waiting', state === 'held' ? 'Paused' : state === 'blocked' || request.route?.state === 'blocked' ? 'Needs input' : 'Needs attention', 'blocked');
  if (request.route?.state === 'pending' && ['queued', ...active].includes(state)) return status('progress', 'Routing', 'running');
  if (state === 'queued' || state === 'pending') return status('backlog', 'Queued', 'queued');
  if (active.has(state)) return status('progress', ({received:'Received',routing:'Routing',starting:'Starting',stopping:'Stopping'})[state] || 'Working', 'running');
  if (state === 'ended') {
    const outcome = run?.outcome;
    if (['cancelled', 'interrupted'].includes(run?.state)) return status('closed', 'Stopped', 'stopped');
    if (run?.workKind === 'analysis') {
      if (run.state === 'ready_for_review' && run.analysis?.reviewed === true && run.analysis?.sourceUnchanged === true && run.analysis?.reportCount > 0 && Array.isArray(run.analysis?.evidenceIssues) && run.analysis.evidenceIssues.length === 0) return status('done', 'Reviewed analysis', 'complete');
      return status('waiting', run.state === 'failed' ? 'Analysis needs attention' : 'Analysis evidence incomplete', 'blocked');
    }
    if (run?.state === 'failed' || ['blocked', 'changes_requested'].includes(run?.headReview?.state) || outcome?.accepted === false || outcome?.acceptance?.accepted === false) return status('waiting', 'Needs attention', 'blocked');
    if (request.exitCode === 0 || (request.exitCode == null && request.controlReply)) return status('done', request.runId ? 'Completed' : 'Answered', 'complete');
    return status('waiting', 'Needs attention', 'blocked');
  }
  return status('waiting', state ? 'Needs attention' : 'Awaiting status', 'blocked');
}

export function taskWorkStatus(task = {}) {
  // The task's accepted state is stronger evidence than an attempt merely ending.
  const state = stateOf(task);
  if (state === 'accepted') return status('done', 'Completed', 'complete');
  if (['cancelled', 'superseded', 'interrupted'].includes(state)) return status('closed', state === 'superseded' ? 'Replaced' : 'Stopped', 'stopped');
  if (state === 'running' || state === 'validating') return status('progress', state === 'validating' ? 'Verifying' : 'Working', 'running');
  if (state === 'pending' || state === 'ready') return status('backlog', 'Next', 'queued');
  if (state === 'waiting' && ['dependency', 'peer'].includes(task.waitReason || task.reason)) return status('backlog', 'Waiting on team', 'queued');
  return status('waiting', state === 'failed' ? 'Needs attention' : 'Waiting', 'blocked');
}
