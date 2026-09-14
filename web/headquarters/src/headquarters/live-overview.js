import { avatar, escape, icon } from './ui.js';
import { requestTaskStatus, taskWorkStatus } from './task-status.js';
import { deriveFleetJourneys, deriveFleetHandoffs } from './fleet-activity.js';

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
    const linked = linkedRequests[0];
    if (asArray(run.taskViews).length) representedRuns.add(key);
    for (const task of asArray(run.taskViews)) {
      if (!task.id) continue;
      const ownerId = recordAgentId(task);
      const owner = agentList.find(agent => idOf(agent.id) === ownerId);
      const departmentId = recordDepartmentId(task) || recordDepartmentId(linked) || recordDepartmentId(owner);
      let status = taskWorkStatus(task, run);
      const journey = journeyFor(run, linked);
      if (activeBuckets.has(status.bucket) && journey && !journey.active) {
        status = journey.waiting ? { bucket: journey.tone === 'queued' ? 'backlog' : 'waiting', label: journey.status, tone: journey.tone } : { bucket: 'closed', label: journey.status, tone: journey.tone };
      }
      if (activeBuckets.has(status.bucket) && (['failed_to_start', 'failed'].includes(linked?.state) || linked?.state === 'ended' && linked?.exitCode != null && linked.exitCode !== 0)) status = { bucket: 'closed', label: 'Run failed', tone: 'error' };
      const item = { key: `${key}:${idOf(task.id)}`, kind: 'task', taskId: idOf(task.id), runId: idOf(run.id), projectId: idOf(run.projectId), requestIds: linkedRequests.map(request => idOf(request.id)), departmentId, ownerId, state: task.state, ...status };
      itemsByKey.set(item.key, item);
    }
  }
  const pendingBriefs = new Map();
  for (const request of requestList) {
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
    if (!item.ownerId) continue;
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
  const activeOwners = new Set(items.filter(item => item.bucket === 'progress').map(item => item.ownerId).filter(Boolean));
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
  return { bucket: 'idle', tone: 'idle', label: 'Available', title: 'Ready for work across projects' };
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
function ageLabel(start, end = Date.now()) {
  const from = dateValue(start), to = typeof end === 'number' ? end : dateValue(end);
  if (!from || !to) return '';
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function timeMarkup(at, suffix = 'ago', end) {
  const label = ageLabel(at, end);
  return label ? `<time datetime="${escape(at)}" data-fleet-time="${escape(suffix)}"${end ? ` data-fleet-end="${escape(typeof end === 'number' ? new Date(end).toISOString() : end)}"` : ''} title="${escape(new Date(at).toLocaleString())}">${escape(label)}${suffix ? ` ${suffix}` : ''}</time>` : '';
}
function activityLabel(event) {
  return visibleActivity(event) ? compactSummary(activityText(event), 140) : '';
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
  for (const request of requests) {
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
      const at = activity?.timestamp || activity?.at || task?.lastEvent?.timestamp || task?.updatedAt || task?.attempt?.startedAt;
      return { ...item, title: String(task?.objective || task?.title || 'Assigned task'), ownerName: asArray(data.agents).find(agent => idOf(agent.id) === item.ownerId)?.name || item.ownerId || 'Unassigned', activity: activityLabel(activity) || activityLabel(task?.lastEvent), updatedAt: at, startedAt: task?.attempt?.startedAt, endedAt: task?.attempt?.endedAt, receipts: task?.receipts || {} };
    });
    const activity = latestActivity(events, journey.projectId, journey.runId, journey.requestId);
    const failed = ['failed_to_start', 'failed'].includes(request?.state) || request?.state === 'ended' && request?.exitCode != null && request.exitCode !== 0;
    const historical = failed ? { status: run ? 'Run failed' : 'No work started', tone: 'error', active: false, waiting: false, stage: run ? journey.stage : null } : {};
    return { ...journey, ...historical, workKind: run?.workKind || request?.workKind || 'implementation', analysis: run?.analysis, projectName: projectName(journey.projectId, data), tasks, completed: tasks.filter(task => task.bucket === 'done').length, total: tasks.length, bucket: failed ? 'closed' : journey.active ? 'progress' : journey.waiting ? journey.tone === 'queued' ? 'backlog' : 'waiting' : journey.tone === 'complete' ? 'done' : 'closed',
      activity: activityLabel(activity), updatedAt: activity?.timestamp || activity?.at || request?.endedAt || run?.updatedAt || request?.startedAt || request?.receivedAt,
      startedAt: request?.startedAt || request?.receivedAt || run?.createdAt, endedAt: failed || request?.state === 'held' || !journey.active && !journey.waiting ? request?.endedAt || request?.heldAt || run?.updatedAt || request?.receivedAt : null,
      reason: operationReason(request, run), requestState: request?.state,
    };
  });
}

function taskMarkup(task, operation, data) {
  const status = data.connected === false ? { tone: 'unknown', label: 'Status unavailable' } : task;
  return `<article class="fleet-task-row" data-fleet-key="task:${escape(task.key)}"><div class="fleet-task-owner">${task.ownerId ? `<button type="button" data-lo-action="agent" data-lo-id="${escape(task.ownerId)}" aria-label="Inspect ${escape(task.ownerName)}">${avatar(task.ownerName, 28, { id:task.ownerId })}<span>${escape(task.ownerName)}</span></button>` : '<span>Owner not assigned</span>'}</div><div class="fleet-task-detail"><div><strong>${escape(compactWorkTitle(task.title))}</strong>${statusPill(status)}</div>${task.activity ? `<p class="fleet-latest-action">${escape(task.activity)}</p>` : `<p class="fleet-latest-action">${escape(task.bucket === 'backlog' ? 'Queued for its dependency or an available worker' : 'Waiting for the next recorded action')}</p>`}<span class="fleet-task-meta">${task.startedAt ? `${timeMarkup(task.startedAt, task.endedAt ? 'total' : 'elapsed', task.endedAt || undefined)}` : ''}${task.updatedAt ? `<span>Updated ${timeMarkup(task.updatedAt)}</span>` : ''}${task.receipts.verifierExecutedPassed ? `<span>${task.receipts.verifierExecutedPassed} checks passed</span>` : ''}</span></div>${operation.requestId ? `<button type="button" class="fleet-row-open" data-lo-action="task" data-lo-id="${escape(task.taskId)}" data-lo-request="${escape(operation.requestId)}" data-lo-project="${escape(task.projectId)}" data-lo-run="${escape(task.runId)}" aria-label="Open task: ${escape(compactWorkTitle(task.title))}">${icon('northeast')}</button>` : ''}</article>`;
}
function operationMarkup(operation, data) {
  const owners = operation.ownerNames.length ? operation.ownerNames.join(' · ') : operation.active ? 'Assigning an owner' : '';
  const displayedOwners = operation.ownerNames.filter((_, index) => !operation.tasks.some(task => task.ownerId === operation.ownerIds[index])).join(' · ');
  return `<article class="fleet-operation" data-fleet-key="operation:${escape(operation.id)}" data-fleet-operation data-project="${escape(operation.projectId)}" data-work-bucket="${operation.bucket}" data-fleet-search="${escape(`${operation.projectName} ${operation.title} ${owners} ${operation.tasks.map(task => `${task.title} ${task.ownerName} ${task.activity}`).join(' ')}`.toLowerCase())}"><header class="fleet-operation-heading"><div class="fleet-operation-main"><span class="fleet-project-label">${icon('book')}${escape(operation.projectName)}</span><h3>${escape(compactWorkTitle(operation.title))}</h3></div>${statusPill(data.connected === false ? { tone: 'unknown', label: 'Status unavailable' } : operation)}</header><div class="fleet-operation-summary"><span class="fleet-phase">${escape(operation.status === 'No work started' ? 'Not started' : operation.workKind === 'analysis' && operation.stage === 'work' ? 'Codebase analysis' : phaseLabel(operation.stage))}</span>${operation.workKind === 'analysis' ? `<span>${operation.analysis?.sourceUnchanged === true ? 'Source unchanged' : 'Read-only investigation'}</span>${operation.analysis?.reportCount ? `<span>${operation.analysis.reportCount} report${operation.analysis.reportCount === 1 ? '' : 's'}</span>` : ''}` : operation.total ? `<span>${operation.completed} of ${operation.total} tasks checked</span>` : ''}${displayedOwners ? `<span>${escape(displayedOwners)}</span>` : ''}${operation.startedAt ? timeMarkup(operation.startedAt, operation.endedAt ? 'total' : 'elapsed', operation.endedAt || undefined) : ''}${operation.requestId ? `<button type="button" class="fleet-text-button" data-lo-action="request" data-lo-id="${escape(operation.requestId)}">Open request ${icon('northeast')}</button>` : ''}</div>${operation.reason ? `<p class="fleet-operation-reason">${escape(operation.reason)}</p>` : ''}${operation.tasks.length ? `<div class="fleet-task-list">${operation.tasks.map(task => taskMarkup(task, operation, data)).join('')}</div>` : `<div class="fleet-request-activity"><span>${escape(operation.activity || (operation.active ? 'Waiting for the next recorded action' : operation.status))}</span>${operation.updatedAt ? `<small>Updated ${timeMarkup(operation.updatedAt)}</small>` : ''}</div>`}</article>`;
}
function workEmptyState() {
  const filtered = !!view.project || !!view.query.trim() || ['progress', 'waiting'].includes(view.workFilter);
  return { filtered, title: filtered ? 'No work matches these filters' : 'No work running' };
}
function renderWork(data, operations) {
  const empty = workEmptyState();
  const latestResult = operations.filter(operation => operation.bucket === 'done' && operation.requestId).sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt))[0];
  return `<section class="fleet-work" aria-label="Work across projects"><div class="fleet-section-heading"><h2>Work across projects</h2><div class="fleet-work-filters" role="group" aria-label="Filter work">${[['open', 'Open'], ['progress', 'Running'], ['waiting', 'Needs attention'], ['all', 'Include history']].map(([key, label]) => `<button type="button" data-lo-action="work-filter" data-lo-id="${key}" aria-pressed="${view.workFilter === key}">${label}</button>`).join('')}</div></div><div class="fleet-operations">${operations.map(operation => operationMarkup(operation, data)).join('')}</div><div class="fleet-work-empty"${operations.some(operation => activeBuckets.has(operation.bucket)) ? ' hidden' : ''}><span class="fleet-empty-label">${escape(empty.title)}</span>${latestResult ? `<button type="button" class="fleet-last-result" data-lo-action="request" data-lo-id="${escape(latestResult.requestId)}"${empty.filtered ? ' hidden' : ''}><span>${escape(latestResult.status)}</span><strong>${escape(latestResult.projectName)} · ${escape(compactWorkTitle(latestResult.title))}</strong>${icon('northeast')}</button>` : ''}</div></section>`;
}
function agentMarkup(agent, data, workload, journeys, operations) {
  const state = deriveFleetAgentState(agent, data, workload, journeys);
  const assignments = operations.flatMap(operation => operation.tasks.filter(task => task.ownerId === idOf(agent.id) && activeBuckets.has(task.bucket)).map(task => ({ ...task, projectName: operation.projectName, projectId: operation.projectId, requestId: operation.requestId })));
  if (!assignments.length && activeBuckets.has(state.bucket)) {
    const operation = operations.find(item => item.id === state.requestIds?.[0] || item.runId && item.runId === state.runId && item.projectId === state.projectId);
    assignments.push({ title: state.title, projectName: projectName(state.projectId, data), projectId: state.projectId, activity: operation?.activity, updatedAt: operation?.updatedAt, requestId: operation?.requestId });
  }
  const department = asArray(data.departments).find(item => idOf(item.id) === recordDepartmentId(agent));
  const match = `${agent.name} ${agentSpecialty(agent)} ${department?.name || ''} ${assignments.map(item => `${item.projectName} ${item.title} ${item.activity}`).join(' ')}`.toLowerCase();
  const projectIds = [...new Set(assignments.map(item => item.projectId).filter(Boolean))];
  const name = agent.name || agent.id;
  const specialty = agentSpecialty(agent);
  const visibleAssignments = assignments.map(item => ({ ...item, title: compactWorkTitle(item.title) }));
  const work = visibleAssignments.map(item => `<span class="fleet-agent-assignment"><span class="fleet-agent-task" title="${escape(`${item.projectName} · ${item.title}`)}"><span class="fleet-agent-project">${escape(item.projectName)}</span><span aria-hidden="true"> · </span>${escape(item.title)}</span>${item.activity ? `<span class="fleet-agent-action" title="${escape(item.activity)}">${escape(item.activity)}</span>` : ''}</span>`).join('');
  return `<button type="button" class="fleet-agent" data-lo-action="agent" data-lo-id="${escape(agent.id)}" data-lo-node="agent:${escape(agent.id)}" data-fleet-search="${escape(match)}" data-bucket="${escape(state.bucket)}" data-fleet-department-id="${escape(recordDepartmentId(agent))}" data-projects="${escape(JSON.stringify(projectIds))}" data-has-work="${assignments.length > 0}" data-office-selected="${view.selectedAgent === agent.id}" aria-label="Inspect ${escape(name)}: ${escape(specialty)}, ${escape(state.label)}${assignments.length ? `, ${escape(visibleAssignments.map(item => `${item.projectName}: ${item.title}`).join('; '))}` : ''}"><span class="fleet-agent-person">${avatar(name, 36, { id:agent.id, avatarId:agent.avatarId })}<span class="fleet-agent-identity"><strong>${escape(name)}</strong><span title="${escape(specialty)}">${escape(specialty)}</span></span></span><span class="fleet-agent-work">${work}</span><span class="fleet-agent-state">${statusPill(state)}${assignments.length > 1 ? `<small>${assignments.length} assignments</small>` : ''}</span>${icon('chevron')}</button>`;
}
function activityMarkup(data) {
  const handoffs = deriveFleetHandoffs(data).slice(0, 4);
  if (!handoffs.length) return '';
  return `<details class="fleet-recent" data-fleet-details="handoffs"><summary>Recent handoffs <span>${handoffs.length}</span>${icon('down')}</summary><div class="fleet-handoff-list">${handoffs.map(event => `<${event.requestId ? 'button type="button"' : 'div'} class="fleet-handoff" data-fleet-key="handoff:${escape(event.id)}" data-project="${escape(event.projectId)}"${event.requestId ? ` data-lo-action="request" data-lo-id="${escape(event.requestId)}"` : ''}><span class="fleet-handoff-people">${escape(event.from)} ${icon('arrow')} ${escape(event.to)}</span><span class="fleet-handoff-label">${escape(event.label)} · ${escape(projectName(event.projectId, data))}</span>${timeMarkup(event.at)}</${event.requestId ? 'button' : 'div'}>`).join('')}</div></details>`;
}

/** The whole live workforce is visible; selection never selects an execution project. */
function systemStrip(data, running, waiting, available) {
  const mcp = data.mcp || { state:'checking', readyCount:0, description:'Checking coding-agent setup' };
  const connectionsReady = mcp.state === 'ready' || mcp.state === 'attention' && mcp.readyCount > 0;
  const mcpValue = connectionsReady ? `${mcp.readyCount} ready` : mcp.state === 'checking' ? 'Checking' : mcp.state === 'unavailable' ? 'Unavailable' : 'Set up';
  const values = [
    ['runtime','Runtime',data.connected === false ? 'Offline' : 'Online',data.connected === false ? 'attention' : 'ready','runtimes',data.connected === false ? 'Reconnect the local coordinator' : 'Local coordinator connected'],
    ['mcp','MCP link',mcpValue,connectionsReady ? mcp.state : mcp.state === 'checking' ? 'idle' : 'attention','connections',mcp.description],
    ['queue','Work queue',`${running} running`,running ? 'working' : waiting ? 'attention' : 'ready','assignments',`${waiting} queued or waiting`],
    ['team','Team',`${available} available`,available ? 'ready' : 'working','people','Specialists are selected automatically for each project'],
  ];
  return `<div class="deck-status-grid" aria-label="Workspace systems">${values.map(([id,label,value,status,nav,title])=>`<button type="button" class="deck-system" data-system="${id}" data-state="${status}" data-nav="${nav}" aria-label="${escape(label)}: ${escape(value)}" title="${escape(title)}"><span>${label}</span><i aria-hidden="true"></i><strong>${escape(value)}</strong>${icon('northeast')}</button>`).join('')}</div>`;
}

export function renderOverview(data = {}) {
  const departments = asArray(data.departments).filter(item => !item.archived);
  const agents = asArray(data.agents).filter(agent => !agent.archived && !agent.isCoordinator && agent.id !== data.controlCenter?.id && agent.departmentId !== 'company');
  const control = data.controlCenter?.id ? { ...data.controlCenter, isCoordinator: true } : null;
  const people = [...(control ? [control] : []), ...agents];
  data = { ...data, departments, agents: people };
  const workload = deriveOverviewWorkload(data), journeys = deriveFleetJourneys(data), operations = deriveFleetOperations(data, workload);
  const open = operations.filter(item => activeBuckets.has(item.bucket)), running = operations.filter(item => item.active), activeProjects = new Set(running.map(item => item.projectId));
  const counts = { all: people.length, progress: 0, waiting: 0, idle: 0 };
  people.forEach(agent => { const state = deriveFleetAgentState(agent, data, workload, journeys); if (state.bucket === 'progress') counts.progress++; if (['waiting', 'backlog'].includes(state.bucket)) counts.waiting++; if (state.bucket === 'idle') counts.idle++; });
  const projects = new Map(asArray(data.projects).filter(project => !project.archived).map(project => [idOf(project.id), project]));
  operations.forEach(item => { if (item.projectId && !projects.has(item.projectId)) projects.set(item.projectId, { id: item.projectId, name: item.projectName }); });
  const ordered = people.slice().sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || ({ progress: 4, waiting: 3, backlog: 2, idle: 1 }[deriveFleetAgentState(b, data, workload, journeys).bucket] || 0) - ({ progress: 4, waiting: 3, backlog: 2, idle: 1 }[deriveFleetAgentState(a, data, workload, journeys).bucket] || 0));
  return `<section class="live-overview fleet-dashboard" data-lo-root aria-label="Interactive agent fleet"><header class="fleet-toolbar"><div><div class="deck-eyebrow">${icon('compass')}Live operations</div><h1>Headquarters</h1><p>${data.connected === false ? 'Connection lost · last received state' : `${running.length} running request${running.length === 1 ? '' : 's'} across ${activeProjects.size} project${activeProjects.size === 1 ? '' : 's'}`}<span>·</span>${people.length} agents</p></div><button type="button" class="fleet-primary" data-chat-open>${icon('plus')}New request</button></header><div class="fleet-scroll"><div class="fleet-content">${systemStrip(data,running.length,open.filter(item=>!item.active).length,counts.idle)}<div class="fleet-global-filters"><label class="fleet-project-filter"><span>Project</span><select data-fleet-project aria-label="Filter projects"><option value="">All projects</option>${[...projects.values()].map(project => `<option value="${escape(project.id)}"${view.project === project.id ? ' selected' : ''}>${escape(project.name || project.id)}</option>`).join('')}</select></label><label class="fleet-search">${icon('search')}<input type="search" data-fleet-search-input placeholder="Find a project, task or agent…" aria-label="Find a project, task or agent" value="${escape(view.query)}"></label></div>${renderWork(data, operations)}<section class="fleet-people" aria-label="Your departments and agents"><div class="fleet-section-heading"><div><h2>Team workload</h2><p class="fleet-section-note">Current assignments, actions and availability across projects</p></div><div class="fleet-filters" role="group" aria-label="Filter agents">${[['all', 'Everyone'], ['progress', 'Working'], ['waiting', 'Waiting'], ['idle', 'Available']].map(([key, label]) => `<button type="button" data-lo-action="filter" data-lo-id="${key}" aria-pressed="${view.filter === key}">${label}<span>${counts[key]}</span></button>`).join('')}</div></div>${departments.length > 1 ? `<select data-fleet-department aria-label="Filter departments"><option value="">All departments</option>${departments.map(department => `<option value="${escape(department.id)}"${view.department === department.id ? ' selected' : ''}>${escape(department.name)}</option>`).join('')}</select>` : ''}<div class="fleet-agent-grid">${ordered.map(agent => agentMarkup(agent, data, workload, journeys, operations)).join('')}</div><div class="fleet-empty-fleet"${people.length ? ' hidden' : ''}><h2>Your workforce is empty</h2><p>Add a team to start handling project requests.</p><button type="button" class="fleet-text-button" data-nav="company">Open team setup ${icon('arrow')}</button></div><div class="fleet-no-results" hidden><h3>No agents match these filters</h3><p>Available agents stay visible when you select a project.</p><button type="button" class="fleet-text-button" data-lo-action="clear">Clear filters</button></div></section>${activityMarkup(data)}<footer class="fleet-footer">Statuses and task counts come from recorded work. Open a request or inspect an agent for its full activity.</footer></div></div><span class="fleet-announcement sr-only" role="status" aria-live="polite"></span></section>`;
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
  let destroyed = false;
  const setInput = (selector, value) => { const input = root.querySelector(selector); if (input) input.value = value; };
  function applyFilters() {
    const query = view.query.toLowerCase().trim();
    root.querySelectorAll('[data-lo-action="filter"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.loId === view.filter)));
    root.querySelectorAll('[data-lo-action="work-filter"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.loId === view.workFilter)));
    let visibleOperations = 0;
    for (const operation of root.querySelectorAll('[data-fleet-operation]')) {
      const { project, workBucket, fleetSearch } = operation.dataset;
      const statusMatch = view.workFilter === 'all' || view.workFilter === 'open' && activeBuckets.has(workBucket) || workBucket === view.workFilter;
      operation.hidden = !statusMatch || !!view.project && project !== view.project || !!query && !fleetSearch.includes(query);
      if (!operation.hidden) visibleOperations++;
    }
    const workEmpty = root.querySelector('.fleet-work-empty');
    if (workEmpty) {
      workEmpty.hidden = visibleOperations > 0;
      const empty = workEmptyState();
      const label = workEmpty.querySelector('.fleet-empty-label');
      if (label) label.textContent = empty.title;
      const latestResult = workEmpty.querySelector('.fleet-last-result');
      if (latestResult) latestResult.hidden = empty.filtered;
    }
    let visibleAgents = 0;
    for (const node of root.querySelectorAll('.fleet-agent')) {
      const { bucket, fleetDepartmentId: department, fleetSearch } = node.dataset;
      let projectIds = []; try { projectIds = JSON.parse(node.dataset.projects || '[]'); } catch { /* missing context stays unassigned */ }
      const projectMatch = !view.project || bucket === 'idle' || node.dataset.loNode === 'agent:control-center' || projectIds.includes(view.project);
      const statusMatch = view.filter === 'all' || view.filter === 'waiting' && ['waiting', 'backlog'].includes(bucket) || bucket === view.filter;
      node.hidden = !projectMatch || !statusMatch || !!view.department && department !== view.department || !!query && !fleetSearch.includes(query);
      if (!node.hidden) visibleAgents++;
    }
    const noResults = root.querySelector('.fleet-no-results');
    if (noResults) noResults.hidden = visibleAgents > 0 || !root.querySelector('.fleet-agent');
    for (const node of root.querySelectorAll('.fleet-handoff')) node.hidden = !!view.project && node.dataset.project !== view.project;
    const recent = root.querySelector('.fleet-recent');
    if (recent) recent.hidden = ![...recent.querySelectorAll('.fleet-handoff')].some(node => !node.hidden);
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
  function updateTimes() {
    if (document.hidden) return;
    for (const time of root.querySelectorAll('time[data-fleet-time]')) {
      const suffix = time.dataset.fleetTime, label = ageLabel(time.getAttribute('datetime'), time.dataset.fleetEnd || undefined);
      if (label) time.textContent = `${label}${suffix ? ` ${suffix}` : ''}`;
    }
  }
  const clock = setInterval(updateTimes, 5000);
  const controller = { root, animateEvent, update(data) {
    if (destroyed || !root.isConnected) return false;
    const template = document.createElement('template'); template.innerHTML = renderOverview(data);
    patchNode(root, template.content.firstElementChild); applyFilters(); return true;
  }, focusAgent, focusDepartment(id) { view.department = id; setInput('[data-fleet-department]', id); applyFilters(); return true; }, fit: resetFilters, refreshConnections() {}, getCamera: () => null,
    destroy() { if (destroyed) return; destroyed = true; abort.abort(); clearInterval(clock); if (lastController === controller) lastController = null; } };
  applyFilters(); lastController = controller; return controller;
}
export function animateEvent(event, element) {
  if (element && lastController?.root !== element && !element.contains?.(lastController?.root)) return false;
  return lastController?.animateEvent(event) || false;
}
