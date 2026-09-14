import { headReviewNeedsRetry, runVerificationFacts } from './task-status.js';

/** Read-only fleet projections. Missing ownership or evidence stays unknown. */
const array = value => Array.isArray(value) ? value : [];
const id = value => typeof value === 'string' ? value : value?.id || '';
const text = value => typeof value === 'string' ? value : '';
const stateOf = value => text(value?.state || value?.status).toLowerCase();
const time = value => Date.parse(value?.updatedAt || value?.endedAt || value?.timestamp || value?.at || value?.receivedAt || value?.createdAt || '') || 0;
const key = (projectId, runId) => `${id(projectId)}:${id(runId)}`;
const runIdOf = request => id(request?.runId || request?.resumeRunId);
const closed = new Set(['cancelled', 'canceled', 'interrupted', 'stopped', 'discarded']);
const activeRequest = new Set(['received', 'routing', 'starting', 'running', 'stopping']);
const titleOf = (request, run) => text(request?.task || request?.text || run?.request?.text).split('\n')[0] || 'Untitled request';
const ownerId = task => id(task?.ownerAgentId || task?.agentId);
const eventId = event => text(event?.id || event?.eventId) || (event?.cursor != null ? `${event.projectId ?? null}:${event.cursor}` : event?.sequence != null && event?.runId ? `${key(event.projectId, event.runId)}:${event.sequence}` : '');
/** A settled attempt no longer owns a live worker, even while coordinator checks continue. */
export const workerAttemptEnded = task => !!task?.attempt?.endedAt || ['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(task?.attempt?.state);

function latestRecords(records, identify) {
  const result = new Map();
  for (const record of array(records)) {
    const identity = identify(record);
    if (!identity) continue;
    const prior = result.get(identity);
    if (!prior || time(record) >= time(prior)) result.set(identity, record);
  }
  return result;
}
function uniqueEvents(events) {
  const result = new Map(), aliases = new Map();
  // Full records establish sequence/cursor aliases before shell summaries.
  const ordered = array(events).slice().sort((a, b) => Number(!!b.payload) - Number(!!a.payload));
  for (const event of ordered) {
    const identity = eventId(event);
    if (!identity) continue;
    const sequenceKey = event?.runId && Number.isInteger(event.sequence) ? `sequence:${key(event.projectId, event.runId)}:${event.sequence}` : null;
    const canonical = aliases.get(identity) || sequenceKey || identity;
    aliases.set(identity, canonical);
    const prior = result.get(canonical);
    // One HTTP page record and its SSE row are the same durable event.
    if (!prior || (!prior.payload && event.payload) || (prior.cursor == null && event.cursor != null)) result.set(canonical, event);
  }
  return [...result.values()];
}
function facts(input) {
  return {
    agents: new Map(array(input.agents).map(agent => [id(agent), agent])),
    departments: new Map(array(input.departments).map(department => [id(department), department])),
    projects: new Map(array(input.projects).map(project => [id(project), project])),
    requests: latestRecords(input.requests, request => id(request)),
    runs: latestRecords(input.runs, run => run?.id ? key(run.projectId, run.id) : ''),
    // Event page rows omit the route's run and project identities. The caller
    // supplies that context on the page envelope; row text cannot override it.
    events: uniqueEvents([...array(input.eventPages).flatMap(page => id(page?.runId) ? array(page.events).map(event => ({ ...event, runId: id(page.runId), projectId: id(page.projectId) })) : []), ...array(input.events)]),
  };
}
function matchingEvents(data, request, run) {
  return data.events.filter(event => event.runId && id(event.runId) === id(run?.id) && id(event.projectId) === id(run?.projectId || request?.projectId)).sort((a, b) => Number.isInteger(a.sequence) && Number.isInteger(b.sequence) ? b.sequence - a.sequence : time(b) - time(a));
}
function cleanEvidence(run) { return runVerificationFacts(run).checksVerified; }

function journeyState(request, run, events) {
  const requestState = stateOf(request), runState = stateOf(run);
  const tasks = array(run?.taskViews).filter(task => stateOf(task) !== 'superseded');
  const review = run?.headReview;
  const latestPlanning = events.find(event => ['head.planning_started', 'head.planning_finished'].includes(event.type));
  const planningActive = run?.headPlanning ? run.headPlanning.state === 'running' : latestPlanning?.type === 'head.planning_started';
  const planningHead = id(run?.headPlanning?.headAgentId || latestPlanning?.payload?.headAgentId);
  const working = tasks.filter(task => stateOf(task) === 'running');
  const checking = tasks.filter(task => stateOf(task) === 'validating');
  const pending = tasks.filter(task => ['pending', 'ready'].includes(stateOf(task)) || (stateOf(task) === 'waiting' && ['dependency', 'peer'].includes(task.waitReason)));
  const blocked = tasks.filter(task => stateOf(task) === 'failed' || (stateOf(task) === 'waiting' && !['dependency', 'peer'].includes(task.waitReason)));
  const stage = review?.state === 'running' ? 'review' : working.length ? 'work' : checking.length ? 'checks' : tasks.length && tasks.every(task => stateOf(task) === 'accepted') ? (cleanEvidence(run) ? 'review' : 'checks') : tasks.length ? 'work' : run || request?.route?.departmentId ? 'planning' : 'intake';
  const state = (status, tone, active = false, waiting = false, ownerIds = [], nextStage = stage) => ({ stage: nextStage, status, tone, active, waiting, ownerIds: [...new Set(ownerIds.filter(Boolean))] });
  // Request cancellation and run settlement override lingering task rows.
  if (headReviewNeedsRetry(request, run)) return state('Review needs retry', 'blocked', false, true, [], 'review');
  if (closed.has(requestState) || closed.has(runState) || request?.signal || request?.result?.code === 'interrupted') return state(requestState === 'discarded' ? 'Discarded' : 'Stopped', 'stopped', false, false, [], stage === 'intake' ? null : stage);
  if (request?.stopRequestedAt && activeRequest.has(requestState)) return state('Stopping', 'running', true);
  if (requestState === 'held') return state('Paused', 'blocked', false, true);
  if (request?.route?.state === 'blocked' || requestState === 'blocked') return state('Needs input', 'blocked', false, true);
  if (['failed', 'failed_to_start'].includes(requestState) || runState === 'failed') return state(review?.state === 'changes_requested' ? 'Changes requested' : 'Needs attention', 'blocked', false, true, [], ['blocked', 'changes_requested'].includes(review?.state) ? 'review' : stage);
  if (requestState === 'queued' || requestState === 'pending') return state('Queued', 'queued', false, true);
  // A direct answer completes the conversation, without engineering phases.
  if (!runIdOf(request) && requestState === 'ended' && request?.controlReply && (request.exitCode == null || request.exitCode === 0)) return state('Answered', 'complete', false, false, [], null);
  if (run?.workKind === 'analysis' && (requestState === 'ended' || runState === 'ready_for_review')) {
    const analysis = run.analysis;
    return analysis?.reviewed === true && analysis?.sourceUnchanged === true && analysis?.reportCount > 0 && Array.isArray(analysis.evidenceIssues) && analysis.evidenceIssues.length === 0
      ? state('Reviewed analysis', 'complete', false, false, [], 'done')
      : state('Analysis evidence incomplete', 'blocked', false, true, [], 'review');
  }
  if (runState === 'ready_for_review' && runVerificationFacts(run).verified) return state('Verified', 'complete', false, false, [], 'done');
  if (requestState === 'ended' && !run) return state('Result not loaded', 'blocked', false, true, [], null);
  if (review?.state === 'running' && !['ended', 'ready_for_review', 'waiting'].includes(requestState) && !['ready_for_review', 'waiting'].includes(runState)) return state('Reviewing', 'running', true, false, [id(review.headAgentId)], 'review');
  if (working.length && requestState !== 'ended' && runState !== 'waiting') return state(blocked.length ? 'Working · needs attention' : 'Working', 'running', true, !!blocked.length, working.filter(task => !workerAttemptEnded(task)).map(ownerId), 'work');
  if (checking.length && requestState !== 'ended' && runState !== 'waiting') return run?.workKind === 'analysis'
    ? state('Preparing report review', 'running', true, false, [], 'review')
    : state('Running checks', 'running', true, false, checking.filter(task => !workerAttemptEnded(task)).map(ownerId), 'checks');
  if (['blocked', 'changes_requested'].includes(review?.state)) return state(review.state === 'changes_requested' ? 'Changes requested' : 'Review needs attention', 'blocked', false, true, [], 'review');
  if (runState === 'ready_for_review' || requestState === 'ended') return state(cleanEvidence(run) ? 'Review not recorded' : 'Evidence incomplete', 'blocked', false, true, [], cleanEvidence(run) ? 'review' : 'checks');
  if (blocked.length || runState === 'waiting') return state('Waiting for input', 'blocked', false, true);
  if (planningActive && (activeRequest.has(requestState) || runState === 'running')) return state('Planning', 'running', true, false, [planningHead], 'planning');
  if (tasks.length && tasks.every(task => stateOf(task) === 'accepted')) return run?.workKind === 'analysis'
    ? state('Awaiting report review', 'queued', false, true, [], 'review')
    : state(cleanEvidence(run) ? 'Awaiting review' : 'Preparing final checks', 'queued', false, true, [], cleanEvidence(run) ? 'review' : 'checks');
  if (pending.length) return state('Waiting for a worker', 'queued', false, true);
  if (run || request?.route?.departmentId) return state('Preparing the team', 'queued', false, true, [], 'planning');
  if (activeRequest.has(requestState)) return state(request?.route?.state === 'pending' || requestState === 'routing' ? 'Routing' : 'Reading request', 'running', true, false, ['control-center'], 'intake');
  return state('Awaiting status', 'idle', false, false, [], null);
}

/** Attention first, then active, queued and settled requests; newest within each. */
export function deriveFleetJourneys(input = {}) {
  const data = facts(input), linked = new Set(), rows = [];
  const add = (request, run) => {
    const identity = request ? id(request) : `run:${key(run.projectId, run.id)}`;
    const projected = journeyState(request, run, matchingEvents(data, request, run));
    rows.push({ id: identity, requestId: request ? id(request) : null, projectId: id(request?.projectId || run?.projectId), runId: runIdOf(request) || id(run?.id), title: titleOf(request, run), ...projected,
      ownerNames: projected.ownerIds.map(agentId => data.agents.get(agentId)?.name || (agentId === 'control-center' ? 'Control Center' : '')).filter(Boolean),
      _time: Math.max(time(request), time(run)) });
  };
  for (const request of data.requests.values()) {
    const identity = key(request.projectId, runIdOf(request));
    const run = runIdOf(request) ? data.runs.get(identity) : null;
    if (run) linked.add(identity);
    add(request, run);
  }
  for (const [identity, run] of data.runs) if (!linked.has(identity)) add(null, run);
  const priority = row => row.waiting && row.tone === 'blocked' ? 3 : row.active ? 2 : row.waiting ? 1 : 0;
  return rows.sort((a, b) => priority(b) - priority(a) || b._time - a._time).map(({ _time, ...row }) => row);
}

function actor(endpoint, data, run) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  const kind = endpoint.kind, identity = id(endpoint);
  if (kind === 'user' && ['you', 'user'].includes(identity)) return { name: 'You' };
  if (['control', 'controlCenter', 'control_center'].includes(kind) && ['control-center', 'control'].includes(identity)) return { name: data.agents.get('control-center')?.name || 'Control Center', agentId: 'control-center', departmentName: 'Control Center' };
  if (kind === 'coordinator' && (!identity || identity === 'coordinator')) return { name: 'Coordinator' };
  if (kind === 'department') { const department = data.departments.get(identity); return department ? { name: department.name, departmentId: identity, departmentName: department.name } : null; }
  if (kind === 'agent') {
    const agent = data.agents.get(identity);
    const department = data.departments.get(id(agent?.departmentId)) || [...data.departments.values()].find(item => id(item.headAgentId) === identity);
    return agent ? { name: agent.name, agentId: identity, departmentId: department?.id || '', departmentName: department?.name || '' } : null;
  }
  if (kind === 'task') {
    const task = array(run?.taskViews).find(item => id(item) === identity);
    return task ? actor({ kind: 'agent', id: ownerId(task) }, data, run) : null;
  }
  return null;
}

function requestForRun(data, run) {
  return [...data.requests.values()].filter(item => runIdOf(item) === id(run?.id) && id(item.projectId) === id(run?.projectId))
    .sort((a, b) => Number(!!a.resumeRunId) - Number(!!b.resumeRunId) || time(b) - time(a))[0];
}
function handoffContext(source, target, request, run, projectId, data, status) {
  return { requestTitle: titleOf(request, run), projectName: data.projects.get(projectId)?.name || projectId || 'Workspace', status,
    fromDepartmentId: source.departmentId || null, fromDepartmentName: source.departmentName || null,
    toDepartmentId: target.departmentId || null, toDepartmentName: target.departmentName || null };
}

/** Only actor-to-actor records become handoffs. Text output never creates one. */
export function deriveFleetHandoffs(input = {}) {
  const data = facts(input), rows = [], messageKeys = new Set();
  for (const run of data.runs.values()) {
    const request = requestForRun(data, run);
    for (const message of array(run.messages)) {
      if (message.type !== 'peer_message' || !id(message.id) || id(message.runId) !== id(run.id) || !Object.hasOwn(message, 'senderTaskId') || !Object.hasOwn(message, 'recipientTaskId')) continue;
      const endpoint = taskId => taskId === null ? { kind: 'coordinator', id: 'coordinator' } : { kind: 'task', id: id(taskId) };
      const source = actor(endpoint(message.senderTaskId), data, run), target = actor(endpoint(message.recipientTaskId), data, run);
      const label = ({ recorded: 'Message recorded', submitted: 'Message awaiting delivery', acknowledged: 'Message acknowledged', expired: 'Message not delivered', rejected: 'Message rejected' })[message.deliveryState];
      if (!source || !target || !label) continue;
      const messageKey = `${key(run.projectId, run.id)}:${id(message.id)}`;
      if (messageKeys.has(messageKey)) continue;
      messageKeys.add(messageKey);
      rows.push({ id: `message:${messageKey}`, from: source.name, to: target.name, label, taskTitle: text(message.subject) || titleOf(request, run), at: text(message.acknowledgedAt || message.submittedAt || message.createdAt), requestId: request ? id(request) : null, projectId: id(run.projectId), runId: id(run.id),
        ...handoffContext(source, target, request, run, id(run.projectId), data, ({ recorded: 'Recorded', submitted: 'Awaiting delivery', acknowledged: 'Acknowledged', expired: 'Not delivered', rejected: 'Rejected' })[message.deliveryState]),
        ...(source.agentId ? { fromAgentId: source.agentId } : {}), ...(target.agentId ? { toAgentId: target.agentId } : {}) });
    }
  }
  for (const event of data.events) {
    const request = event.requestId ? data.requests.get(id(event.requestId)) : event.runId ? requestForRun(data, { id: event.runId, projectId: event.projectId }) : null;
    const projectId = id(event.projectId || request?.projectId), runId = id(event.runId) || runIdOf(request);
    const run = data.runs.get(key(projectId, runId));
    const payload = event.payload || {};
    if (payload.messageId && messageKeys.has(`${key(projectId, runId)}:${id(payload.messageId)}`)) continue;
    const taskId = id(event.taskId || payload.taskId);
    const task = array(run?.taskViews).find(item => id(item) === taskId);
    let from = event.from, to = event.to, label = text(event.label), status = 'Recorded';
    // Adapter output and tool claims do not constitute coordinator handoffs.
    if (/^(runtime|head\.runtime)\./.test(event.type || '')) continue;
    if (event.type === 'head.assigned') {
      from = { kind: 'agent', id: id(payload.headAgentId) }; to = { kind: 'agent', id: id(payload.agentId) }; label = 'Assigned work'; status = 'Assigned';
    } else if (event.type === 'head.planning_started') {
      from = { kind: 'coordinator', id: 'coordinator' }; to = { kind: 'agent', id: id(payload.headAgentId) }; label = 'Started planning the request'; status = 'Started';
    } else if (event.type === 'head.planning_finished') {
      from = { kind: 'agent', id: id(payload.headAgentId) }; to = { kind: 'coordinator', id: 'coordinator' }; label = payload.outcome === 'planned' ? 'Returned the task plan' : payload.outcome === 'interrupted' ? 'Planning stopped' : 'Planning did not complete'; status = payload.outcome === 'planned' ? 'Completed' : payload.outcome === 'interrupted' ? 'Stopped' : 'Incomplete';
    } else if (event.type === 'head.review_started') {
      from = { kind: 'coordinator', id: 'coordinator' }; to = { kind: 'agent', id: id(payload.headAgentId) }; label = run?.workKind === 'analysis' ? 'Requested report review' : 'Requested candidate review'; status = 'Started';
    } else if (event.type === 'head.review_finished') {
      from = { kind: 'agent', id: id(payload.headAgentId) }; to = { kind: 'coordinator', id: 'coordinator' }; label = payload.verdict === 'passed' ? 'Review passed' : payload.verdict === 'changes_requested' ? 'Requested changes' : 'Review blocked'; status = payload.verdict === 'passed' ? 'Passed' : payload.verdict === 'changes_requested' ? 'Changes requested' : 'Blocked';
    } else if (event.type === 'control.final_reply') {
      from = { kind: 'control', id: 'control-center' }; to = { kind: 'user', id: 'you' }; label = payload.verificationStatus === 'reviewed_analysis' ? 'Returned the reviewed analysis' : 'Returned the reviewed result'; status = 'Delivered';
    } else if (event.type === 'coordination.delivery_failed') {
      // A null task explicitly addresses coordinator; an absent field is unknown.
      const endpoint = field => !Object.hasOwn(payload, field) ? null : payload[field] === null ? { kind: 'coordinator', id: 'coordinator' } : { kind: 'task', id: id(payload[field]) };
      from = endpoint('senderTaskId'); to = endpoint('recipientTaskId'); label = 'Message not delivered'; status = 'Not delivered';
    } else if (event.type === 'request.routed') {
      from ||= { kind: 'control', id: 'control-center' };
      to ||= request?.route?.departmentId ? { kind: 'department', id: request.route.departmentId } : null;
      label = 'Routed the request'; status = 'Routed';
    } else if (event.type === 'request.received') {
      from ||= { kind: 'user', id: 'you' }; to ||= { kind: 'control', id: 'control-center' }; label = 'Received your request'; status = 'Received';
    } else if (!from || !to || !['request.ended', 'task.accepted', 'task.settled', 'attempt.started', 'task.started', 'task.dispatched', 'session.started'].includes(event.type)) continue;
    const source = actor(from, data, run), target = actor(to, data, run);
    if (!source || !target || source.name === target.name && source.agentId === target.agentId) continue;
    rows.push({ id: eventId(event), from: source.name, to: target.name, label: label || 'Recorded handoff', taskTitle: text(payload.objective || task?.objective || task?.title) || titleOf(request, run), at: text(event.timestamp || event.at), requestId: request ? id(request) : null, projectId, runId,
      ...handoffContext(source, target, request, run, projectId, data, status),
      ...(source.agentId ? { fromAgentId: source.agentId } : {}), ...(target.agentId ? { toAgentId: target.agentId } : {}) });
  }
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 24);
}

/** Context stays with each request, even when projects reuse run or task IDs. */
export function deriveFleetHandoffGroups(input = {}) {
  const groups = new Map();
  for (const event of deriveFleetHandoffs(input)) {
    const identity = `${event.projectId}:${event.requestId || `run:${event.runId}`}`;
    let group = groups.get(identity);
    if (!group) {
      group = { id: identity, requestId: event.requestId, runId: event.runId, projectId: event.projectId, projectName: event.projectName, title: event.requestTitle, updatedAt: event.at, events: [] };
      groups.set(identity, group);
    }
    group.events.push(event);
  }
  return [...groups.values()];
}
