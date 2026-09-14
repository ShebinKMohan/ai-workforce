import { avatar, escape, icon } from './ui.js';
import { latestRunRequests, requestTaskStatus, taskWorkStatus } from './task-status.js';
import { deriveFleetJourneys, workerAttemptEnded } from './fleet-activity.js';
import { renderDuration } from './time-display.js';
import { taskEventLabel } from './task-rail.js';

const asArray = value => Array.isArray(value) ? value : [];
const idOf = value => String(typeof value === 'object' && value !== null ? value.id ?? '' : value ?? '');
let lastController = null;
const view = { query: '', filter: 'all', workFilter: 'open', project: '', department: '', selectedAgent: '' };
const activeBuckets = new Set(['progress', 'backlog', 'waiting']);

function recordAgentId(record) { return idOf(record?.agentId ?? record?.ownerAgentId ?? record?.employeeId ?? record?.ownerId ?? record?.agent); }
function recordDepartmentId(record) { return idOf(record?.departmentId ?? record?.department ?? record?.route?.departmentId); }
function recordTime(record) { return new Date(record?.updatedAt ?? record?.lastEvent?.timestamp ?? record?.receivedAt ?? record?.createdAt ?? record?.at ?? 0).getTime() || 0; }
const runKey = (projectId, runId) => `${idOf(projectId)}:${idOf(runId)}`;
const emptyCounts = () => ({ progress: 0, backlog: 0, waiting: 0, done: 0, closed: 0 });
const statePriority = { progress: 4, waiting: 3, backlog: 2, done: 1, closed: 0 };

/** Count durable tasks, with pending briefs only until a run has actual task rows. */
export function deriveOverviewWorkload(data = {}) {
  const { departments = [], agents = [], requests = [], runs = [] } = data;
  const journeys = deriveFleetJourneys(data);
  const journeyFor = (run, request) => journeys.find(journey => request && journey.requestId === idOf(request.id)) || journeys.find(journey => journey.runId === idOf(run.id) && journey.projectId === idOf(run.projectId));
  const agentList = asArray(agents).filter(agent => !agent.archived);
  const requestList = asArray(requests);
  const runMap = new Map();
  for (const run of asArray(runs)) {
    const key = runKey(run.projectId, run.id);
    if (!runMap.has(key) || recordTime(run) >= recordTime(runMap.get(key))) runMap.set(key, run);
  }
  const requestsByRun = new Map();
  for (const request of requestList) {
    const linkedRunId = request.runId || request.resumeRunId;
    if (!linkedRunId) continue;
    const key = runKey(request.projectId, linkedRunId);
    const list = requestsByRun.get(key) || [];
    list.push(request);
    requestsByRun.set(key, list);
  }
  const itemsByKey = new Map();
  const representedRuns = new Set();
  for (const [key, run] of runMap) {
    const linkedRequests = (requestsByRun.get(key) || []).slice().sort((a, b) => recordTime(b) - recordTime(a));
    const linked = latestRunRequests(linkedRequests)[0];
    if (asArray(run.taskViews).length) representedRuns.add(key);
    for (const task of asArray(run.taskViews)) {
      if (!task.id || task.state === 'superseded') continue;
      const ownerId = recordAgentId(task);
      const owner = agentList.find(agent => idOf(agent.id) === ownerId);
      const departmentId = recordDepartmentId(task) || recordDepartmentId(linked) || recordDepartmentId(owner);
      let status = taskWorkStatus(task, run);
      if (run.workKind === 'analysis' && task.state === 'validating') status = { bucket: 'backlog', label: 'Report ready', tone: 'queued' };
      if (run.workKind === 'analysis' && task.state === 'accepted') status = { bucket: 'done', label: 'Reviewed report', tone: 'complete' };
      const journey = journeyFor(run, linked);
      if (activeBuckets.has(status.bucket) && journey && !journey.active) {
        status = journey.waiting ? { bucket: journey.tone === 'queued' ? 'backlog' : 'waiting', label: journey.status, tone: journey.tone } : { bucket: 'closed', label: journey.status, tone: journey.tone };
      }
      if (activeBuckets.has(status.bucket) && (['failed_to_start', 'failed'].includes(linked?.state) || linked?.state === 'ended' && linked?.exitCode != null && linked.exitCode !== 0)) status = { bucket: 'closed', label: 'Run failed', tone: 'error' };
      const item = { key: `${key}:${idOf(task.id)}`, kind: 'task', taskId: idOf(task.id), runId: idOf(run.id), projectId: idOf(run.projectId), requestIds: linkedRequests.map(request => idOf(request.id)), departmentId, ownerId, state: task.state, runtimeEnded: workerAttemptEnded(task), ...status };
      itemsByKey.set(item.key, item);
    }
  }
  const pendingBriefs = new Map();
  for (const request of latestRunRequests(requestList)) {
    const linkedRunId = request.runId || request.resumeRunId;
    const key = linkedRunId ? runKey(request.projectId, linkedRunId) : `request:${idOf(request.id)}`;
    if (representedRuns.has(key)) continue;
    const previous = pendingBriefs.get(key);
    if (previous && recordTime(previous) > recordTime(request)) continue;
    pendingBriefs.set(key, request);
  }
  for (const [key, request] of pendingBriefs) {
    if (request.mode === 'discuss' || request.route?.method === 'direct_reply') continue;
    if (['failed_to_start', 'failed'].includes(request.state) || request.state === 'ended' && request.exitCode != null && request.exitCode !== 0) continue;
    const status = requestTaskStatus(request, runMap.get(key));
    if (status.bucket === 'done' || status.bucket === 'closed') continue;
    itemsByKey.set(`brief:${key}`, { key: `brief:${key}`, kind: 'brief', taskId: null, runId: idOf(request.runId || request.resumeRunId), projectId: idOf(request.projectId), requestIds: [idOf(request.id)], departmentId: recordDepartmentId(request), ownerId: '', state: request.state, ...status });
  }
  const items = [...itemsByKey.values()];
  const counts = emptyCounts();
  const agentStates = new Map();
  for (const item of items) {
    counts[item.bucket]++;
    if (!item.ownerId || item.runtimeEnded && ['progress', 'backlog'].includes(item.bucket)) continue;
    const previous = agentStates.get(item.ownerId);
    if (!previous || statePriority[item.bucket] > statePriority[previous.bucket]) agentStates.set(item.ownerId, item);
  }
  for (const run of runMap.values()) {
    const review = run.headReview;
    const journey = journeyFor(run);
    if (review?.state === 'running' && review.headAgentId && journey?.active && journey.stage === 'review') {
      const id = idOf(review.headAgentId), prior = agentStates.get(id);
      if (!prior || statePriority[prior.bucket] < statePriority.progress) agentStates.set(id, { bucket: 'progress', label: 'Reviewing', tone: 'running', runId: idOf(run.id), projectId: idOf(run.projectId) });
    }
  }
  for (const journey of journeys) if (journey.active && ['planning', 'review'].includes(journey.stage)) {
    for (const agentId of journey.ownerIds) agentStates.set(agentId, { bucket:'progress', label:journey.status, tone:'running', runId:journey.runId, projectId:journey.projectId, requestIds:[journey.requestId].filter(Boolean) });
  }
  const activeOwners = new Set(items.filter(item => item.bucket === 'progress' && !item.runtimeEnded).map(item => item.ownerId).filter(Boolean));
  for (const [agentId, state] of agentStates) if (state.bucket === 'progress') activeOwners.add(agentId);
  const activeAgentIds = agentList.filter(agent => activeOwners.has(idOf(agent.id))).map(agent => idOf(agent.id));
  const byDepartment = new Map(asArray(departments).filter(department => !department.archived).map(department => {
    const id = idOf(department.id), departmentItems = items.filter(item => item.departmentId === id), departmentCounts = emptyCounts();
    departmentItems.forEach(item => { departmentCounts[item.bucket]++; });
    const activeAgents = activeAgentIds.filter(agentId => recordDepartmentId(agentList.find(agent => idOf(agent.id) === agentId)) === id);
    return [id, { items: departmentItems, counts: departmentCounts, activeAgentIds: activeAgents, tasks: departmentItems.filter(item => item.kind === 'task').length, briefs: departmentItems.filter(item => item.kind === 'brief').length }];
  }));
  return { items, counts, byDepartment, agentStates, activeAgentIds, loadedRuns: runMap.size, tasks: items.filter(item => item.kind === 'task').length, completedTasks: items.filter(item => item.kind === 'task' && item.bucket === 'done').length, unplannedBriefs: items.filter(item => item.kind === 'brief').length };
}

export function agentSpecialty(agent) {
  if (agent.isCoordinator || agent.id === 'control-center') return 'Control Center · Intake & coordination';
  if (typeof agent.jobTitle === 'string' && agent.jobTitle.trim()) return agent.jobTitle.trim();
  const explicit = String(agent.instructions || '').match(/^ROLE:\s*([^\n]+)/i)?.[1];
  if (explicit) return explicit.toLowerCase().replace(/(^|[ /&–-])([a-z])/g, (_, space, letter) => space + letter.toUpperCase()).replace(/\b(ui|api|qa|mcp|sdk)\b/gi, word => word.toUpperCase());
  if (agent.isHead || agent.runtimeRole === 'head' || agent.role === 'head') return 'Department head';
  const skills = asArray(agent.skills || agent.capabilities).slice(0,2).map(value => String(value).replaceAll('-', ' '));
  return skills.length ? skills.join(' · ') : agent.role === 'worker' ? 'Specialist' : agent.role || 'Specialist';
}
function workTitle(item, data) {
  if (!item) return '';
  const run = asArray(data.runs).find(r => idOf(r.id) === item.runId && idOf(r.projectId) === item.projectId);
  const task = asArray(run?.taskViews).find(t => idOf(t.id) === item.taskId);
  const request = asArray(data.requests).find(r => asArray(item.requestIds).includes(idOf(r.id)));
  return String(task?.title || task?.objective || task?.summary || request?.task || request?.text || (item.taskId ? `Task ${item.taskId}` : 'Assigned work'));
}
export function deriveFleetAgentState(agent, data = {}, workload = deriveOverviewWorkload(data), journeys = deriveFleetJourneys(data)) {
  const recorded = workload.agentStates.get(idOf(agent.id));
  const owned = journeys.find(j => j.active && asArray(j.ownerIds).includes(idOf(agent.id)));
  if (data.connected === false) return { bucket: 'unknown', tone: 'unknown', label: 'Connection lost', title: recorded ? workTitle(recorded,data) : 'Waiting for live status' };
  if (recorded && activeBuckets.has(recorded.bucket)) return { ...recorded, title: recorded.taskId ? workTitle(recorded,data) : owned?.title || 'Reviewing the team result' };
  if (owned) return { bucket: owned.waiting ? 'waiting' : 'progress', tone: owned.tone, label: owned.status, title: owned.title, projectId: owned.projectId, runId: owned.runId, requestIds: [owned.requestId].filter(Boolean) };
  const reservation = asArray(data.requests).find(request => ['starting', 'running', 'stopping'].includes(request.state) && request.admissionReady && asArray(request.workerIds).includes(idOf(agent.id)));
  if (reservation) return { bucket: 'backlog', tone: 'queued', label: 'Reserved', title: String(reservation.task || 'Reserved for the current request'), projectId: idOf(reservation.projectId), runId: idOf(reservation.runId), requestIds: [idOf(reservation.id)] };
  const readiness = asArray(data.runtimeReadiness?.reports || data.runtimeReadiness).find(report => report.runtimeId === agent.runtime);
  if (readiness?.auth === 'logged_out') return { bucket: 'unavailable', tone: 'blocked', label: 'Sign-in needed', title: 'Connect this runtime account to make this agent available' };
  if (readiness?.installed === false || readiness?.readiness === 'missing') return { bucket: 'unavailable', tone: 'blocked', label: 'Runtime missing', title: 'Install or connect this agent’s runtime' };
  if (readiness?.usable === false) return { bucket: 'unavailable', tone: 'blocked', label: 'Runtime unavailable', title: 'This runtime is not ready to accept work' };
  if (data.runtimeReadiness && agent.runtime && (!readiness || data.runtimeReadiness.error)) return { bucket: 'unknown', tone: 'unknown', label: 'Readiness unknown', title: 'Waiting for this runtime’s status' };
  if (agent.isCoordinator || agent.id === 'control-center') {
    const intake = asArray(data.requests).filter(request => ['queued', 'received', 'routing', 'starting', 'running'].includes(request.state) && request.route?.state === 'pending' && !request.stopRequestedAt);
    if (intake.length) return { bucket: 'backlog', tone: 'queued', label: 'Requests in intake', title: 'Requests awaiting department routing', note: `${intake.length} request${intake.length === 1 ? '' : 's'} awaiting routing`, intakeCount: intake.length, requestIds: intake.map(request => idOf(request.id)) };
  }
  return { bucket: 'idle', tone: 'idle', label: 'Available', title: 'Ready for work across projects' };
}
/** Visual signals consume the same availability state as counts and assignment labels. */
export function fleetAgentSignal(state = {}) {
  if (state.bucket === 'idle' && state.label === 'Available') return 'available';
  if (state.bucket === 'progress' && state.tone === 'running') return 'working';
  if (state.bucket === 'unavailable') return state.label === 'Sign-in needed' ? 'sign-in' : 'unavailable';
  if (state.bucket === 'waiting') return 'attention';
  if (state.bucket === 'backlog') return 'waiting';
  return 'unknown';
}
const statusPill = state => `<span class="fleet-status" data-tone="${escape(state.tone || 'idle')}"><i aria-hidden="true"></i>${escape(state.label || state.status)}</span>`;
const shortText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360) : '';
function compactSummary(value, limit = 150) {
  const lines = String(value || '').split(/\r?\n/).filter(line => line.trim() && !/^\s*```/.test(line));
  const line = lines.find(line => !/^\s*#{1,6}\s/.test(line)) || lines[0] || '';
  const firstLine = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/\*([^*]+)\*/g, '$1');
  const firstSentence = firstLine.match(/^.*?[.!?](?=\s+[A-Z]|$)/)?.[0] || firstLine;
  const title = shortText(firstSentence);
  return title.length <= limit ? title : `${title.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`;
}
const compactWorkTitle = value => compactSummary(value);
const visibleActivity = event => !/(?:^|\.)(?:raw|reasoning(?:[._].*)?|usage|token_usage|output_delta)$/i.test(String(event?.type || ''));
function commandActivity(payload) {
  const command = shortText(payload.command).replace(/^(?:\/[\w./-]+\/)?(?:bash|zsh|sh)\s+-[a-z]*c\s+["']?/, '').replace(/["']$/, '');
  if (payload.denied) return command ? `Command denied: ${command}` : 'Command was denied';
  const complete = payload.phase === 'completed';
  if (complete && typeof payload.exitCode === 'number' && payload.exitCode !== 0) return `Command failed (${payload.exitCode})${command ? `: ${command}` : ''}`;
  const files = [...command.matchAll(/(?:^|[;|&])\s*(?:nl\s+-ba|cat|head(?:\s+-\d+)?|tail(?:\s+-\d+)?)\s+["']?([^\s;|&"']+)/g)].map(match => match[1]).filter(file => !file.startsWith('-'));
  if (files.length && (!complete || payload.exitCode === 0)) return `${complete ? 'Read' : 'Reading'}: ${[...new Set(files)].slice(0, 3).join(', ')}${new Set(files).size > 3 ? ` +${new Set(files).size - 3} more` : ''}`;
  return command ? `${complete ? 'Completed' : 'Running'}: ${command}` : complete ? 'Command finished' : 'Running a command';
}
const projectName = (projectId, data) => asArray(data.projects).find(project => idOf(project.id) === idOf(projectId))?.name || projectId || 'Workspace';
const dateValue = at => Date.parse(at || '') || 0;
const phaseLabel = phase => ({ intake: 'Intake', planning: 'Planning', work: 'Implementation', checks: 'Verification', review: 'Head review', done: 'Delivered' })[phase] || 'Recorded work';
function updatedMarkup(at) {
  if (!dateValue(at)) return '';
  return `<time datetime="${escape(at)}" title="${escape(new Date(at).toLocaleString())}">${escape(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time>`;
}
/** Worker time is the current attempt's own interval, never the request's queue time. */
function workerTiming(task, active, connected = true) {
  const attempt = task?.attempt;
  const start = dateValue(attempt?.startedAt) ? attempt.startedAt : null;
  const end = dateValue(attempt?.endedAt) && dateValue(attempt.endedAt) >= dateValue(start) ? attempt.endedAt : null;
  return { startedAt: start, endedAt: end, timingActive: connected !== false && active && task.state === 'running' && !!start && !attempt.endedAt && (!attempt.state || attempt.state === 'running'), timingLabel: end ? 'Worker time' : 'Elapsed', timingSource: 'attempt' };
}
/** Pair lifecycle records within one actor, project, run and review/planning generation. */
export function deriveAgentPhaseTiming(agentId, operation, data = {}, phase) {
  if (!operation?.runId || !operation.projectId) return null;
  const run = asArray(data.runs).find(item => idOf(item.id) === operation.runId && idOf(item.projectId) === operation.projectId);
  const kinds = phase ? [phase] : ['planning', 'review'];
  const records = eventRecords(data).filter(event => idOf(event.projectId) === operation.projectId && idOf(event.runId) === operation.runId && [event.agentId, event.headAgentId, event.payload?.agentId, event.payload?.headAgentId].some(value => idOf(value) === idOf(agentId)))
    .sort((a, b) => dateValue(a.timestamp || a.at) - dateValue(b.timestamp || b.at) || Number(a.sequence || a.cursor || 0) - Number(b.sequence || b.cursor || 0));
  const intervals = [];
  for (const kind of kinds) {
    const expectedId = kind === 'review' ? run?.headReview?.reviewId : run?.headPlanning?.planningId;
    const identity = event => event?.payload?.[`${kind === 'review' ? 'review' : 'planning'}Id`] || event?.[`${kind === 'review' ? 'review' : 'planning'}Id`];
    const started = records.filter(event => event.type === `head.${kind}_started` && (!expectedId || identity(event) === expectedId)).at(-1);
    const summary = kind === 'review' ? run?.headReview : run?.headPlanning;
    const startedAt = started?.timestamp || started?.at || (summary?.state === 'running' && idOf(summary.headAgentId) === idOf(agentId) ? summary.startedAt || summary.at : null);
    if (!dateValue(startedAt)) continue;
    const finished = started && records.slice(records.indexOf(started) + 1).find(event => event.type === `head.${kind}_finished` && dateValue(event.timestamp || event.at) >= dateValue(startedAt) && (!identity(event) || identity(event) === identity(started)));
    const endedAt = finished?.timestamp || finished?.at || null;
    intervals.push({ startedAt, endedAt, timingActive: data.connected !== false && !endedAt && operation.active && operation.stage === kind, timingLabel: kind === 'review' ? 'Review time' : 'Planning time', timingSource: `head.${kind}`, phase: kind === 'review' ? operation.workKind === 'analysis' ? 'Report review' : 'Head review' : 'Planning' });
  }
  return intervals.sort((a, b) => dateValue(b.endedAt || b.startedAt) - dateValue(a.endedAt || a.startedAt))[0] || null;
}
function activityLabel(event) {
  return event && visibleActivity(event) ? compactSummary(taskEventLabel({ ...event, type:String(event.type || '').replace(/^head\.runtime\./, 'runtime.') }), 140) : '';
}
function activityText(event) {
  if (!event || !visibleActivity(event)) return '';
  const type = String(event.type || ''), payload = event.payload || {};
  const kind = type.replace(/^head\./, '').replace(/^runtime\./, '');
  if (kind === 'assistant_message') return shortText(payload.text) ? `Agent update: ${compactSummary(payload.text, 126)}` : '';
  if (kind === 'command_exec') return commandActivity(payload);
  if (kind === 'tool_call') return shortText(payload.tool) ? `Using ${shortText(payload.tool)}${payload.path ? ` · ${shortText(payload.path)}` : ''}` : 'Using a tool';
  if (kind === 'tool_result') return shortText(payload.tool) ? `${shortText(payload.tool)} returned${payload.isError === true || payload.ok === false ? ' an error' : ' a result'}` : 'Tool result received';
  if (kind === 'file_change') return `${payload.denied ? 'Change denied' : payload.applied === true ? 'Changed' : 'File change reported'}${payload.path ? `: ${shortText(payload.path)}` : ''}`;
  if (kind === 'error') return 'Runtime reported an error';
  const labels = { 'head.planning_started': 'Department head is planning the work', 'head.planning_finished': 'Planning finished', 'head.assigned': 'Specialist assigned', 'head.review_started': 'Department head is reviewing the candidate', 'head.review_finished': payload.verdict === 'passed' ? 'Head review passed' : 'Head review finished', 'task.accepted': 'Task checks passed', 'task.started': 'Task started', 'task.settled': 'Task attempt settled', 'attempt.started': 'Worker attempt started', 'request.received': 'Request received', 'request.routed': 'Request routed to the department', 'request.ended': 'Request ended', 'control.final_reply': 'Final response recorded', 'runtime.turn_started': 'Agent turn started', 'runtime.turn_completed': 'Agent turn ended' };
  return labels[type] || shortText(event.label);
}
function eventRecords(data) {
  return [...asArray(data.eventPages).flatMap(page => asArray(page.events).map(event => ({ ...event, projectId: page.projectId, runId: page.runId }))), ...asArray(data.events)].filter(visibleActivity);
}
function latestActivity(events, projectId, runId, requestId, taskId, attemptId) {
  return events.filter(event => {
    const sameRun = runId && idOf(event.runId) === runId && idOf(event.projectId) === projectId;
    const sameRequest = requestId && idOf(event.requestId) === requestId && (!event.projectId || idOf(event.projectId) === projectId);
    const currentAttempt = !attemptId || !event.attemptId || idOf(event.attemptId) === attemptId;
    return (sameRun || sameRequest) && currentAttempt && (!taskId || idOf(event.taskId || event.payload?.taskId) === taskId) && activityLabel(event);
  }).sort((a, b) => dateValue(b.timestamp || b.at) - dateValue(a.timestamp || a.at) || Number(b.sequence || 0) - Number(a.sequence || 0))[0];
}
function operationReason(request, run) {
  const blocked = request?.route?.state === 'blocked';
  const failed = ['failed_to_start', 'failed', 'held'].includes(request?.state) || ['failed', 'interrupted'].includes(run?.state) || request?.state === 'ended' && request?.exitCode != null && request.exitCode !== 0;
  if (!blocked && !failed) return '';
  const reason = shortText(request?.reason || request?.result?.error?.message || (blocked ? request.route.reason : ''));
  if (/no[_ ]workers?|on the bench|not (?:placed|configured|assigned).*project/i.test(reason)) return 'This earlier request stopped at the team setup check, before any work began.';
  return reason;
}

/** One operation per current run; a resumed request supersedes its older display row. */
export function deriveFleetOperations(data = {}, workload = deriveOverviewWorkload(data)) {
  const requests = asArray(data.requests), runs = asArray(data.runs), events = eventRecords(data);
  const latest = new Map();
  for (const request of latestRunRequests(requests)) {
    const runId = request.runId || request.resumeRunId;
    if (!runId) continue;
    const identity = runKey(request.projectId, runId), prior = latest.get(identity);
    if (!prior || recordTime(request) >= recordTime(prior)) latest.set(identity, request);
  }
  return deriveFleetJourneys(data).filter(journey => !journey.runId || !latest.has(runKey(journey.projectId, journey.runId)) || idOf(latest.get(runKey(journey.projectId, journey.runId)).id) === journey.requestId).map(journey => {
    const request = requests.find(record => idOf(record.id) === journey.requestId);
    const run = runs.filter(record => idOf(record.id) === journey.runId && idOf(record.projectId) === journey.projectId).sort((a, b) => recordTime(b) - recordTime(a))[0];
    const items = workload.items.filter(item => item.kind === 'task' && item.runId === journey.runId && item.projectId === journey.projectId);
    const tasks = items.map(item => {
      const task = asArray(run?.taskViews).find(record => idOf(record.id) === item.taskId);
      const activity = latestActivity(events, journey.projectId, journey.runId, journey.requestId, item.taskId, idOf(task?.attempt?.id));
      const at = activity?.timestamp || activity?.at || (activityLabel(task?.lastEvent) ? task.lastEvent.timestamp : null) || task?.updatedAt || task?.attempt?.startedAt;
      return { ...item, title: String(task?.objective || task?.title || 'Assigned task'), ownerName: asArray(data.agents).find(agent => idOf(agent.id) === item.ownerId)?.name || item.ownerId || 'Unassigned', activity: activityLabel(activity) || activityLabel(task?.lastEvent), updatedAt: at, ...workerTiming(task, activeBuckets.has(item.bucket) && journey.active, data.connected), receipts: task?.receipts || {} };
    });
    const activity = latestActivity(events, journey.projectId, journey.runId, journey.requestId);
    const failed = ['failed_to_start', 'failed'].includes(request?.state) || request?.state === 'ended' && request?.exitCode != null && request.exitCode !== 0;
    const historical = failed ? { status: run ? 'Run failed' : 'No work started', tone: 'error', active: false, waiting: false, stage: run ? journey.stage : null } : {};
    return { ...journey, ...historical, workKind: run?.workKind || request?.workKind || 'implementation', analysis: run?.analysis, projectName: projectName(journey.projectId, data), tasks, completed: tasks.filter(task => task.bucket === 'done').length, total: tasks.length, bucket: failed ? 'closed' : journey.active ? 'progress' : journey.waiting ? journey.tone === 'queued' ? 'backlog' : 'waiting' : journey.tone === 'complete' ? 'done' : 'closed',
      activity: activityLabel(activity), updatedAt: activity?.timestamp || activity?.at || request?.endedAt || run?.updatedAt || request?.startedAt || request?.receivedAt,
      startedAt: request?.receivedAt || request?.startedAt || run?.createdAt, endedAt: failed || request?.state === 'held' || !journey.active && !journey.waiting ? request?.endedAt || request?.heldAt || run?.updatedAt || request?.receivedAt : null,
      reason: operationReason(request, run), requestState: request?.state,
    };
  }).sort((a, b) => statePriority[b.bucket] - statePriority[a.bucket] || dateValue(b.startedAt) - dateValue(a.startedAt) || a.id.localeCompare(b.id));
}

/** A person's assignment combines ownership, current stage and its own latest event. */
export function deriveFleetAgentView(agent, data = {}, workload = deriveOverviewWorkload(data), journeys = deriveFleetJourneys(data), operations = deriveFleetOperations(data, workload)) {
  const state = deriveFleetAgentState(agent, data, workload, journeys);
  const assignments = operations.flatMap(operation => operation.tasks.filter(task => task.ownerId === idOf(agent.id) && activeBuckets.has(task.bucket)).map(task => ({
    ...task, projectName: operation.projectName, projectId: operation.projectId, requestId: operation.requestId,
    phase: operation.workKind === 'analysis' ? task.state === 'validating' ? 'Report review' : 'Codebase analysis' : task.label,
    ...(task.runtimeEnded ? { completed:true, completionLabel:'Worker finished', activity:'', updatedAt:null, timingActive:false } : {}),
  })));
  if (!assignments.length && activeBuckets.has(state.bucket) && !state.intakeCount) {
    const operation = operations.find(item => item.id === state.requestIds?.[0] || item.runId && item.runId === state.runId && item.projectId === state.projectId);
    // A run's newest event may belong to another worker. A head or coordinator
    // row only attributes an action when the record names that actor.
    const ownedEvents = eventRecords(data).filter(event => [event.agentId, event.headAgentId, event.payload?.agentId, event.payload?.headAgentId].some(identity => idOf(identity) === idOf(agent.id)));
    const event = latestActivity(ownedEvents, state.projectId, state.runId, operation?.requestId);
    const activity = operation?.workKind === 'analysis' && event?.type === 'head.review_started' ? 'Reviewing the analysis report' : activityLabel(event);
    const timing = deriveAgentPhaseTiming(agent.id, operation, data, operation?.stage);
    assignments.push({ title: state.title, phase: state.label, projectName: projectName(state.projectId, data), projectId: state.projectId, activity, updatedAt: event?.timestamp || event?.at, requestId: operation?.requestId, ...timing });
  }
  if (!assignments.length && !activeBuckets.has(state.bucket)) {
    const completed = operations.flatMap(operation => {
      const tasks = operation.tasks.filter(task => task.ownerId === idOf(agent.id) && ['done', 'closed'].includes(task.bucket) && task.startedAt && task.endedAt).map(task => ({ ...task, phase: task.label, projectName: operation.projectName, projectId: operation.projectId, requestId: operation.requestId, activity: '', updatedAt: null, completed: true, completionLabel: task.bucket === 'done' ? 'Completed' : 'Attempt ended' }));
      const timing = deriveAgentPhaseTiming(agent.id, operation, data);
      if (timing?.endedAt) tasks.push({ ...timing, title: operation.title, projectName: operation.projectName, projectId: operation.projectId, requestId: operation.requestId, completed: true, completionLabel: 'Finished' });
      return tasks;
    }).sort((a, b) => dateValue(b.endedAt) - dateValue(a.endedAt));
    // One latest owned result keeps completion visible without recreating a history feed.
    if (completed[0]) assignments.push(completed[0]);
  }
  const department = asArray(data.departments).find(item => idOf(item.id) === recordDepartmentId(agent));
  const headId = idOf(department?.headAgentId || department?.lead?.id);
  const head = asArray(data.agents).find(item => idOf(item.id) === headId);
  return { agent, state, assignments, jobTitle: agentSpecialty(agent), departmentId: idOf(department?.id), departmentName: department?.name || '', isHead: headId ? idOf(agent.id) === headId : !!agent.isHead,
    reportsTo: headId && headId !== idOf(agent.id) ? { id: headId, name: head?.name || department?.lead?.name || headId } : null };
}

export function deriveFleetTeams(data = {}, workload = deriveOverviewWorkload(data), journeys = deriveFleetJourneys(data), operations = deriveFleetOperations(data, workload)) {
  const agents = asArray(data.agents).filter(agent => !agent.archived && !agent.isCoordinator && agent.id !== 'control-center');
  const departments = asArray(data.departments).filter(department => !department.archived);
  const represented = new Set();
  const groups = departments.map(department => {
    const people = agents.filter(agent => recordDepartmentId(agent) === idOf(department.id));
    people.forEach(agent => represented.add(idOf(agent.id)));
    const members = people.map(agent => deriveFleetAgentView(agent, data, workload, journeys, operations)).sort((a, b) => Number(b.isHead) - Number(a.isHead));
    const tasks = workload.items.filter(item => item.departmentId === idOf(department.id) && item.kind === 'task');
    return { id: idOf(department.id), name: department.name || department.id, purpose: department.purpose || department.note || '', colorName: department.colorName || department.color || 'blue', icon: department.icon || 'layers', members,
      head: members.find(member => member.isHead) || null, working: members.filter(member => member.state.bucket === 'progress').length, ready: members.filter(member => member.state.bucket === 'idle').length,
      taskCount: tasks.filter(task => activeBuckets.has(task.bucket)).length, completedTasks: tasks.filter(task => task.bucket === 'done').length };
  });
  const unassigned = agents.filter(agent => !represented.has(idOf(agent.id)));
  if (unassigned.length) { const members = unassigned.map(agent => deriveFleetAgentView(agent, data, workload, journeys, operations)); groups.push({ id: 'unassigned', name: 'Unassigned team', purpose: 'Agents without a current department', icon: 'people', members, head: null, working: members.filter(member => member.state.bucket === 'progress').length, ready: members.filter(member => member.state.bucket === 'idle').length, taskCount: 0, completedTasks: 0 }); }
  return groups;
}

function operationMarkup(operation, data) {
  const owners = operation.ownerNames.length ? operation.ownerNames.join(' · ') : operation.active ? 'Assigning an owner' : '';
  const displayedOwners = operation.ownerNames.join(' · ');
  return `<article class="fleet-operation" data-fleet-key="operation:${escape(operation.id)}" data-fleet-operation data-project="${escape(operation.projectId)}" data-work-bucket="${operation.bucket}" data-fleet-search="${escape(`${operation.projectName} ${operation.title} ${owners} ${operation.tasks.map(task => `${task.title} ${task.ownerName} ${task.activity}`).join(' ')}`.toLowerCase())}"><header class="fleet-operation-heading"><div class="fleet-operation-main"><span class="fleet-project-label">${icon('book')}${escape(operation.projectName)}</span><h3>${escape(compactWorkTitle(operation.title))}</h3></div>${statusPill(data.connected === false ? { tone: 'unknown', label: 'Status unavailable' } : operation)}</header><div class="fleet-operation-summary"><span class="fleet-phase">${escape(operation.status === 'No work started' ? 'Not started' : operation.workKind === 'analysis' && operation.stage === 'work' ? 'Codebase analysis' : phaseLabel(operation.stage))}</span>${operation.workKind === 'analysis' ? `<span>${operation.analysis?.sourceUnchanged === true ? 'Source unchanged' : 'Read-only investigation'}</span>${operation.analysis?.reportCount ? `<span>${operation.analysis.reportCount} report${operation.analysis.reportCount === 1 ? '' : 's'}</span>` : ''}` : operation.total ? `<span>${operation.completed} of ${operation.total} tasks checked</span>` : ''}${displayedOwners ? `<span>${escape(displayedOwners)}</span>` : ''}${operation.startedAt ? renderDuration({ start: operation.startedAt, end: operation.endedAt, active: data.connected !== false && activeBuckets.has(operation.bucket), label: 'Request time' }) : ''}${operation.requestId ? `<button type="button" class="fleet-text-button" data-lo-action="request" data-lo-id="${escape(operation.requestId)}">Open request ${icon('northeast')}</button>` : ''}</div>${operation.reason ? `<p class="fleet-operation-reason">${escape(operation.reason)}</p>` : ''}${!operation.tasks.length && operation.activity ? `<div class="fleet-request-activity"><span>${escape(operation.activity)}</span> ${operation.updatedAt ? `<small><span aria-hidden="true">·</span> Updated ${updatedMarkup(operation.updatedAt)}</small>` : ''}</div>` : ''}</article>`;
}
function renderWork(data, operations) {
  const current = operations.filter(operation => activeBuckets.has(operation.bucket));
  return `<section class="fleet-work" aria-label="Work across projects"${current.length ? '' : ' hidden'}><div class="fleet-section-heading"><h2>Active work</h2><span class="fleet-section-note">${current.length} open request${current.length === 1 ? '' : 's'}</span></div><div class="fleet-operations">${current.map(operation => operationMarkup(operation, data)).join('')}</div></section>`;
}
function agentMarkup(agent, data, workload, journeys, operations, supplied) {
  const person = supplied || deriveFleetAgentView(agent, data, workload, journeys, operations);
  const { state, assignments, jobTitle, departmentName, isHead, reportsTo } = person;
  const match = `${agent.name} ${jobTitle} ${departmentName} ${assignments.map(item => `${item.projectName} ${item.title} ${item.activity}`).join(' ')}`.toLowerCase();
  const projectIds = [...new Set(assignments.map(item => item.projectId).filter(Boolean))];
  const name = agent.name || agent.id;
  const work = assignments.map(item => `<span class="fleet-agent-assignment"><span class="fleet-agent-task" title="${escape(item.title)}">${item.completed ? `<span class="fleet-completed-label">${escape(item.completionLabel || 'Completed')} · </span>` : ''}${escape(compactWorkTitle(item.title))}</span><span class="fleet-agent-context"><span class="fleet-agent-project">${escape(item.projectName)}</span><span aria-hidden="true">·</span><span>${escape(item.phase || state.label)}</span></span>${item.activity ? `<span class="fleet-agent-action" title="${escape(item.activity)}">${escape(item.activity)}</span>` : ''}${item.startedAt ? `<span class="fleet-agent-duration">${renderDuration({ start: item.startedAt, end: item.endedAt, active: item.timingActive, label: item.timingLabel || 'Elapsed' })}</span>` : ''}${item.updatedAt ? `<span class="fleet-agent-updated">Updated ${updatedMarkup(item.updatedAt)}</span>` : ''}</span>`).join('');
  return `<button type="button" class="fleet-agent" data-lo-action="agent" data-lo-id="${escape(agent.id)}" data-lo-node="agent:${escape(agent.id)}" data-fleet-search="${escape(match)}" data-bucket="${escape(state.bucket)}" data-fleet-signal="${fleetAgentSignal(state)}" data-fleet-department-id="${escape(recordDepartmentId(agent))}" data-projects="${escape(JSON.stringify(projectIds))}" data-has-work="${assignments.some(item => !item.completed)}" data-office-selected="${view.selectedAgent === agent.id}" aria-label="Inspect ${escape(name)}: ${escape(jobTitle)}, ${escape(state.label)}${reportsTo ? `, reports to ${escape(reportsTo.name)}` : ''}${assignments.length ? `, ${escape(assignments.map(item => `${item.completed ? 'Finished: ' : ''}${item.projectName}: ${compactWorkTitle(item.title)}`).join('; '))}` : ''}"><span class="fleet-agent-person">${avatar(name, 44, { id:agent.id, avatarId:agent.avatarId })}<span class="fleet-agent-identity"><strong>${escape(name)}${isHead ? '<span class="fleet-head-badge">Head</span>' : ''}</strong><span class="fleet-agent-job" title="${escape(jobTitle)}">${escape(jobTitle)}</span></span></span><span class="fleet-agent-state">${statusPill(state)}${state.note ? `<small>${escape(state.note)}</small>` : ''}${assignments.length > 1 ? `<small>${assignments.length} assignments</small>` : ''}</span><span class="fleet-agent-work">${work}</span>${icon('chevron')}</button>`;
}
function departmentMarkup(team, data, workload, journeys, operations) {
  const description = team.head ? `Led by ${team.head.agent.name || team.head.agent.id}` : 'Department head not configured';
  return `<section class="fleet-department" data-color="${escape(team.colorName || 'blue')}" data-lo-department="${escape(team.id)}" aria-label="${escape(team.name)} team"><header class="fleet-department-heading"><button type="button" class="fleet-department-title" data-lo-action="department" data-lo-id="${escape(team.id)}">${icon(team.icon)}<span><strong>${escape(team.name)}</strong><span>${escape(description)}</span></span>${icon('northeast')}</button><span class="fleet-department-count">${team.members.length} agents · ${team.ready} ready${team.working ? ` · ${team.working} working` : ''}${team.taskCount ? ` · ${team.taskCount} open tasks` : ''}</span></header><div class="fleet-agent-grid">${team.members.map(person => agentMarkup(person.agent, data, workload, journeys, operations, person)).join('')}</div>${team.members.length ? '' : '<p class="fleet-department-empty">No agents in this department.</p>'}</section>`;
}
export function deriveFleetMetrics(data = {}, model = overviewModel(data)) {
  const known = data.connected !== false;
  return { working:known ? model.counts.progress : null, available:known ? model.counts.idle : null, reserved:known ? model.counts.reserved : null, needsAuth:known ? model.counts.needsAuth : null, activeProjects:known ? model.activeProjects.size : null };
}
function metricsMarkup(data, model) {
  const metrics = deriveFleetMetrics(data, model);
  return `<dl class="fleet-metrics" aria-label="${data.connected === false ? 'Live counts unavailable — connection lost' : 'Live workforce counts'}">${[['working','Working'],['available','Available'],...(metrics.reserved > 0 ? [['reserved','Reserved']] : []),['needsAuth','Needs sign-in'],['activeProjects','Active projects']].map(([key,label])=>`<div class="fleet-metric" data-fleet-metric="${key}"${metrics[key] === null ? ' title="Connection lost; current count unavailable"' : ''}><dt>${label}</dt><dd>${metrics[key] === null ? '—' : metrics[key]}</dd></div>`).join('')}</dl>`;
}

/** The whole live workforce is visible; selection never selects an execution project. */
function overviewModel(data = {}) {
  const departments = asArray(data.departments).filter(item => !item.archived);
  const agents = asArray(data.agents).filter(agent => !agent.archived && !agent.isCoordinator && agent.id !== data.controlCenter?.id && agent.departmentId !== 'company');
  const control = data.controlCenter?.id ? { ...data.controlCenter, isCoordinator: true } : null;
  const people = [...(control ? [control] : []), ...agents];
  data = { ...data, departments, agents: people };
  const workload = deriveOverviewWorkload(data), journeys = deriveFleetJourneys(data), operations = deriveFleetOperations(data, workload);
  const teams = deriveFleetTeams(data, workload, journeys, operations);
  const running = operations.filter(item => item.active), activeProjects = new Set(running.map(item => item.projectId).filter(Boolean));
  const counts = { all: people.length, progress: 0, waiting: 0, idle: 0, reserved:0, needsAuth:0 };
  people.forEach(agent => { const state = deriveFleetAgentState(agent, data, workload, journeys); if (state.bucket === 'progress') counts.progress++; if (['waiting', 'backlog', 'unavailable'].includes(state.bucket)) counts.waiting++; if (state.bucket === 'idle') counts.idle++; if (state.label === 'Reserved') counts.reserved++; if (state.label === 'Sign-in needed') counts.needsAuth++; });
  const projects = new Map(asArray(data.projects).filter(project => !project.archived).map(project => [idOf(project.id), project]));
  operations.forEach(item => { if (item.projectId && !projects.has(item.projectId)) projects.set(item.projectId, { id: item.projectId, name: item.projectName }); });
  const coordinator = control ? deriveFleetAgentView(control, data, workload, journeys, operations) : null;
  return { data, departments, people, control, coordinator, workload, journeys, operations, teams, running, activeProjects, counts, projects };
}
/** Only rendered facts participate: polling metadata and elapsed wall time do not. */
export function overviewStructureSignature(data = {}, model = overviewModel(data)) {
  const { connected } = model.data;
  const assignment = item => [item.title, item.phase, item.projectName, item.projectId, item.activity, item.updatedAt, item.startedAt, item.endedAt, item.timingActive, item.timingLabel, item.completed, item.completionLabel];
  const person = value => value && [value.agent.id, value.agent.name, value.agent.avatarId, recordDepartmentId(value.agent), value.jobTitle, value.departmentName, value.isHead, value.reportsTo, value.state.bucket, value.state.tone, value.state.label, value.state.note, value.assignments.map(assignment)];
  return JSON.stringify([
    connected !== false, model.counts, [...model.projects.values()].map(project => [project.id, project.name]), person(model.coordinator),
    model.operations.filter(operation => activeBuckets.has(operation.bucket)).map(operation => [operation.id, operation.projectId, operation.projectName, operation.title, operation.bucket, operation.active, operation.waiting, operation.status, operation.tone, operation.stage, operation.workKind, operation.analysis?.sourceUnchanged, operation.analysis?.reportCount, operation.completed, operation.total, operation.ownerNames, operation.startedAt, operation.endedAt, operation.requestId, operation.reason, !operation.tasks.length && [operation.activity, operation.activity && operation.updatedAt], operation.tasks.map(task => [task.title, task.ownerName, task.activity])]),
    model.teams.map(team => [team.id, team.name, team.colorName, team.icon, team.ready, team.working, team.taskCount, team.members.map(person)]),
  ]);
}
export function renderOverview(data = {}, model = overviewModel(data)) {
  const { departments, people, control, coordinator, workload, journeys, operations, teams, running, activeProjects, counts, projects } = model;
  data = model.data;
  return `<section class="live-overview fleet-dashboard" data-lo-root aria-label="Interactive agent fleet"><header class="fleet-toolbar"><div class="fleet-heading-row"><div class="fleet-title"><h1>Headquarters</h1><p>${departments.length} department${departments.length === 1 ? '' : 's'}<span>·</span>${people.length} agents<span class="sr-only">${data.connected === false ? 'Connection lost · last received state' : `${running.length} running request${running.length === 1 ? '' : 's'} across ${activeProjects.size} project${activeProjects.size === 1 ? '' : 's'}`}</span></p></div>${metricsMarkup(data,model)}</div><div class="fleet-controls"><label class="fleet-project-filter"><select data-fleet-project aria-label="Filter projects"><option value="">All projects</option>${[...projects.values()].map(project => `<option value="${escape(project.id)}"${view.project === project.id ? ' selected' : ''}>${escape(project.name || project.id)}</option>`).join('')}</select></label><label class="fleet-search">${icon('search')}<input type="search" data-fleet-search-input placeholder="Search people or tasks…" aria-label="Find a project, task or agent" value="${escape(view.query)}"></label><div class="fleet-filters" role="group" aria-label="Filter workforce status">${[['all', 'All'], ['progress', 'Working'], ['waiting', 'Waiting']].map(([key, label]) => `<button type="button" data-lo-action="filter" data-lo-id="${key}" aria-pressed="${view.filter === key}">${label}${key !== 'all' && counts[key] ? `<span>${counts[key]}</span>` : ''}</button>`).join('')}</div><button type="button" class="fleet-primary" data-chat-open>${icon('plus')}New request</button></div></header><div class="fleet-scroll"><div class="fleet-content">${control ? `<section class="fleet-control-row" data-fleet-signal="${fleetAgentSignal(coordinator.state)}" aria-label="Control Center coordination">${agentMarkup(control,data,workload,journeys,operations,coordinator)}<button type="button" class="fleet-control-message" aria-label="Message Control Center" data-lo-action="control" data-lo-id="${escape(control.id)}">${icon('connect')}Message</button></section>` : ''}${renderWork(data,operations)}<section class="fleet-people" aria-label="Your departments and agents"><div class="fleet-department-grid">${teams.map(team => departmentMarkup(team,data,workload,journeys,operations)).join('')}</div><div class="fleet-empty-fleet"${people.length ? ' hidden' : ''}><h2>Your workforce is empty</h2><p>Add a team to start handling project requests.</p><button type="button" class="fleet-text-button" data-nav="company">Open team setup ${icon('arrow')}</button></div><div class="fleet-no-results" hidden><strong>No agents match these filters</strong><button type="button" class="fleet-text-button" data-lo-action="clear">Clear filters</button></div></section><span class="sr-only">Task counts come from recorded work.</span></div></div><span class="fleet-announcement sr-only" role="status" aria-live="polite"></span></section>`;
}

function domKey(node) {
  if(node.nodeType!==1)return null;
  const d=node.dataset;
  return d.fleetKey|| (d.loDepartment?`department:${d.loDepartment}`:d.loNode?`node:${d.loNode}`:d.loAction?`action:${d.loAction}:${d.loId||''}`:d.fleetDetails?`details:${d.fleetDetails}`:null);
}
function patchNode(current,next) {
  if(current.nodeType!==next.nodeType||current.nodeName!==next.nodeName){current.replaceWith(next.cloneNode(true));return;}
  if(current.nodeType===3){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
  if(current.nodeType!==1||current.isEqualNode(next))return;
  if(current.matches('.fleet-announcement'))return;
  for(const a of [...current.attributes])if(!next.hasAttribute(a.name)&&!(current.tagName==='DETAILS'&&a.name==='open'))current.removeAttribute(a.name);
  for(const a of [...next.attributes])if(!(current.tagName==='DETAILS'&&a.name==='open')&&current.getAttribute(a.name)!==a.value)current.setAttribute(a.name,a.value);
  const previous=[...current.childNodes],keyed=new Map(previous.map(n=>[domKey(n),n]).filter(([k])=>k)),used=new Set();let cursor=current.firstChild;
  for(const child of [...next.childNodes]){const key=domKey(child);let match=key?keyed.get(key):cursor&&!domKey(cursor)&&cursor.nodeType===child.nodeType&&cursor.nodeName===child.nodeName?cursor:null;if(match&&used.has(match))match=null;if(!match){match=child.cloneNode(true);current.insertBefore(match,cursor);}else{if(match!==cursor)current.insertBefore(match,cursor);patchNode(match,child);}used.add(match);cursor=match.nextSibling;}
  for(const child of previous)if(!used.has(child)&&child.parentNode===current)child.remove();
}
export function wireOverview(element, { onDepartment, onAgent, onRequest, onControlCenter, onTask } = {}) {
  const root = element?.matches?.('[data-lo-root]') ? element : element?.querySelector?.('[data-lo-root]');
  if (!root) return { update: () => false, animateEvent: () => false, destroy() {} };
  if (lastController && !lastController.root.isConnected) lastController.destroy();
  const abort = new AbortController(), seen = new Set();
  let destroyed = false, currentSignature = null;
  const setInput = (selector, value) => { const input = root.querySelector(selector); if (input) input.value = value; };
  function applyFilters() {
    const query = view.query.toLowerCase().trim();
    root.querySelectorAll('[data-lo-action="filter"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.loId === view.filter)));
    let visibleOperations = 0;
    for (const operation of root.querySelectorAll('[data-fleet-operation]')) {
      const { project, workBucket, fleetSearch } = operation.dataset;
      const statusMatch = view.filter === 'all' || view.filter === 'waiting' && ['waiting', 'backlog'].includes(workBucket) || workBucket === view.filter;
      operation.hidden = !statusMatch || !!view.project && project !== view.project || !!query && !fleetSearch.includes(query);
      if (!operation.hidden) visibleOperations++;
    }
    const work = root.querySelector('.fleet-work');
    if (work) work.hidden = visibleOperations === 0;
    let visibleAgents = 0;
    for (const node of root.querySelectorAll('.fleet-agent')) {
      const { bucket, fleetDepartmentId: department, fleetSearch } = node.dataset;
      let projectIds = []; try { projectIds = JSON.parse(node.dataset.projects || '[]'); } catch { /* missing context stays unassigned */ }
      const projectMatch = !view.project || ['idle', 'unavailable', 'unknown'].includes(bucket) || node.dataset.loNode === 'agent:control-center' || projectIds.includes(view.project);
      const statusMatch = view.filter === 'all' || view.filter === 'waiting' && ['waiting', 'backlog', 'unavailable'].includes(bucket) || bucket === view.filter;
      node.hidden = !projectMatch || !statusMatch || !!view.department && department !== view.department || !!query && !fleetSearch.includes(query);
      if (!node.hidden) visibleAgents++;
    }
    const noResults = root.querySelector('.fleet-no-results');
    if (noResults) noResults.hidden = visibleAgents > 0 || !root.querySelector('.fleet-agent');
    for (const department of root.querySelectorAll('.fleet-department')) {
      const members = [...department.querySelectorAll('.fleet-agent')];
      department.hidden = members.length ? !members.some(node => !node.hidden) : !!view.query || !!view.department && department.dataset.loDepartment !== view.department || view.filter !== 'all';
    }
    const control = root.querySelector('.fleet-control-row');
    if (control) control.hidden = control.querySelector('.fleet-agent')?.hidden;
  }
  function resetFilters() {
    view.query = ''; view.filter = 'all'; view.workFilter = 'open'; view.department = ''; view.project = '';
    setInput('[data-fleet-search-input]', ''); setInput('[data-fleet-department]', ''); setInput('[data-fleet-project]', ''); applyFilters();
  }
  function focusAgent(id) {
    const node = [...root.querySelectorAll('.fleet-agent')].find(item => item.dataset.loNode === `agent:${id}`);
    if (!node) return false;
    view.selectedAgent = id;
    if (node.hidden) resetFilters();
    root.querySelectorAll('.fleet-agent').forEach(item => { item.dataset.officeSelected = String(item === node); });
    return true;
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-lo-action]');
    if (!button || !root.contains(button)) return;
    const { loAction: action, loId: id } = button.dataset;
    if (action === 'agent') { focusAgent(id); onAgent?.(id); }
    if (action === 'department') onDepartment?.(id);
    if (action === 'request') onRequest?.(id);
    if (action === 'task') {
      if (onTask) onTask({ taskId: id, requestId: button.dataset.loRequest, projectId: button.dataset.loProject, runId: button.dataset.loRun });
      else onRequest?.(button.dataset.loRequest);
    }
    if (action === 'control') onControlCenter?.(id);
    if (action === 'filter') { view.filter = id; applyFilters(); }
    if (action === 'work-filter') { view.workFilter = id; applyFilters(); }
    if (action === 'clear') resetFilters();
  }, { signal: abort.signal });
  root.addEventListener('input', event => {
    if (event.target.matches('[data-fleet-search-input]')) { view.query = event.target.value; applyFilters(); }
  }, { signal: abort.signal });
  root.addEventListener('change', event => {
    if (event.target.matches('[data-fleet-department]')) { view.department = event.target.value; applyFilters(); }
    if (event.target.matches('[data-fleet-project]')) { view.project = event.target.value; applyFilters(); }
  }, { signal: abort.signal });
  function animateEvent(event) {
    const key = String(event?.id || `${event?.projectId}:${event?.cursor}`);
    if (!event || seen.has(key)) return false;
    seen.add(key); if (seen.size > 200) seen.delete(seen.values().next().value);
    // Arrival updates the records; it never invents avatar movements or progress.
    return true;
  }
  const controller = { root, animateEvent, update(data) {
    if (destroyed || !root.isConnected) return false;
    const model = overviewModel(data), signature = overviewStructureSignature(data, model);
    if (signature === currentSignature) return false;
    const template = document.createElement('template'); template.innerHTML = renderOverview(data, model);
    patchNode(root, template.content.firstElementChild); applyFilters(); currentSignature = signature; return true;
  }, focusAgent, focusDepartment(id) { view.department = id; setInput('[data-fleet-department]', id); applyFilters(); return true; }, fit: resetFilters, refreshConnections() {}, getCamera: () => null,
    destroy() { if (destroyed) return; destroyed = true; abort.abort(); if (lastController === controller) lastController = null; } };
  applyFilters(); lastController = controller; return controller;
}
export function animateEvent(event, element) {
  if (element && lastController?.root !== element && !element.contains?.(lastController?.root)) return false;
  return lastController?.animateEvent(event) || false;
}
