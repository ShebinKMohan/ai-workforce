/** Chat routing uses the same eligibility facts as the workspace task sheet. */
import { indexWorkspace, pairBlockers, runtimeBoundary, isDirectControlReply } from '../../workspace/src/model.js';

export function chatRoute(document, preferences = {}, selectedDepartmentId = null) {
  const ws = indexWorkspace(document);
  const projects = ws.liveProjects;
  const departments = ws.liveDepartments;
  // A selected department is an explicit route: never substitute a different team.
  const departmentId = selectedDepartmentId || preferences.departmentId || departments[0]?.id || '';
  const projectId = preferences.projectId || projects.find(project => ws.eligibility.get(`${departmentId}|${project.id}`)?.sendable)?.id || projects[0]?.id || '';
  const pair = ws.eligibility.get(`${departmentId}|${projectId}`);
  const head = pair?.headAgentId ? ws.agentById.get(pair.headAgentId) : null;
  const workers = (pair?.workerIds || []).map(id => ws.agentById.get(id)).filter(Boolean);
  const roster = [head, ...workers].filter(Boolean);
  const blockers = !document ? ['Loading workspace configuration…'] : !projects.length ? ['Add a Git project before sending a task.'] : !departments.length ? ['Create a department and its head before sending a task.'] : pairBlockers(ws, departmentId, projectId);
  const unconfined = roster.some(agent => ws.runtimeRules[agent.runtime]?.requiresWriteConsent === true || !runtimeBoundary(ws, agent.runtime).verified);
  return { projectId, departmentId, projects, departments, pair, head, workers, blockers, unconfined, sendable: pair?.sendable === true && blockers.length === 0, checks: ws.checks.get(projectId), project: ws.projectById.get(projectId), department: ws.departmentById.get(departmentId) };
}

export function submissionPayload(context, document) {
  const route = chatRoute(document, context);
  if (!context.projectId || !context.departmentId) throw new Error('Choose the project and department for this request.');
  if (!route.sendable) throw new Error(route.blockers.join(' ') || 'This project and department are not ready to receive work.');
  const task = String(context.text || '').trim();
  if (!task) throw new Error('Describe the task before sending it.');
  if (task.length > 20_000) throw new Error('Keep this task under 20,000 characters.');
  if (route.unconfined && !context.allowUnconfinedWrites) throw new Error('Confirm the displayed runtime file boundary before sending this task.');
  return { projectId: context.projectId, departmentId: context.departmentId, task, ...(route.unconfined ? { allowUnconfinedWrites: true } : {}), ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}) };
}

/** Merge browser receipts with server history by request identity, preserving exact user wording. */
export function conversationEntries(messages, tasks, departmentId = null) {
  const result = new Map();
  for (const task of tasks) {
    if (departmentId && task.departmentId !== departmentId) continue;
    const requestId = task.requestId || task.entry?.item?.id;
    result.set(requestId || task.id, { id: requestId || task.id, requestId, projectId: task.projectId, departmentId: task.departmentId, text: task.entry?.item?.task || task.entry?.run?.request?.text || task.entry?.title || task.title, at: task.at || task.entry?.item?.receivedAt, task });
  }
  for (const message of messages) {
    if (departmentId && message.departmentId !== departmentId) continue;
    const key = message.requestId || message.id;
    const existing = result.get(key);
    result.set(key, { ...message, ...(existing ? { task: existing.task } : {}) });
  }
  return [...result.values()].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0)).slice(-30);
}

export function readChatState(storage, key) {
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved?.version !== 1) return { version: 1, contexts: {}, messages: [] };
    return { version: 1, contexts: saved.contexts && typeof saved.contexts === 'object' && !Array.isArray(saved.contexts) ? saved.contexts : {}, messages: Array.isArray(saved.messages) ? saved.messages.filter(message => typeof message?.text === 'string' && typeof message?.requestId === 'string').slice(-100) : [] };
  } catch { return { version: 1, contexts: {}, messages: [] }; }
}

/** The composer supplies repository context only. The coordinator owns all team selection. */
export function controlCenterRoute(document, projectId = '') {
  const ws = indexWorkspace(document);
  const projects = ws.liveProjects;
  const selectedProjectId = projectId || projects[0]?.id || '';
  const project = ws.projectById.get(selectedProjectId);
  const candidates = [...ws.eligibility.values()].filter(pair => pair.projectId === selectedProjectId && pair.sendable);
  const blockers = !document ? ['Loading workspace configuration…']
    : !projects.length ? ['Add a Git project before sending a task.']
      : !project || project.archived ? ['Choose an active project for this request.']
        : !ws.liveDepartments.length ? ['Create a department and its head before sending a task.']
          : !candidates.length ? ['No configured team can receive work on this project. Assign workers and configure project checks.'] : [];
  return { projectId: selectedProjectId, project, projects, candidates, blockers, checks: ws.checks.get(selectedProjectId), sendable: blockers.length === 0 };
}

export function controlCenterSubmission(context, document) {
  if (!context.projectId) throw new Error('Choose the project for this request.');
  const route = controlCenterRoute(document, context.projectId);
  if (!route.sendable) throw new Error(route.blockers.join(' '));
  const task = String(context.text || '').trim();
  if (!task) throw new Error('Describe the task before sending it.');
  if (task.length > 20_000) throw new Error('Keep this task under 20,000 characters.');
  return { projectId: context.projectId, task,
    ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}),
    ...(context.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
    // Only a displayed, server-selected route can be reused after explicit runtime consent.
    ...(context.allowUnconfinedWrites === true && context.consentDepartmentId ? { departmentId: context.consentDepartmentId } : {}) };
}

/** The Control Center's answer and assignments must come from recorded execution, never roster guesses. */
export function controlFlowModel(task, detail = null, events = [], status = null) {
  const request = task.entry?.item || {};
  const route = request.route || null;
  const startedReview = events.filter(event => event.type === 'head.review_started').at(-1);
  const finishedReview = events.filter(event => event.type === 'head.review_finished').at(-1);
  const run = status?.run || task.entry?.run;
  const savedReview = run?.headReview || status?.headReview || null;
  const latestReviewEvent = events.filter(event => event.type === 'head.review_started' || event.type === 'head.review_finished').at(-1);
  const summaryIsNewer = savedReview && (!latestReviewEvent || Date.parse(savedReview.at || '') >= Date.parse(latestReviewEvent.timestamp || ''));
  const review = summaryIsNewer ? savedReview : finishedReview?.payload || savedReview;
  const reviewing = Boolean(review?.state === 'running' || startedReview && (!finishedReview || startedReview.sequence > finishedReview.sequence));
  const directReply = isDirectControlReply(request);
  const replyEvent = events.filter(event => event.type === 'control.final_reply').at(-1);
  const finalText = typeof replyEvent?.payload?.text === 'string' ? replyEvent.payload.text : typeof run?.finalReply === 'string' ? run.finalReply : null;
  const verified = detail ? detail.verdict === 'verified' : task.verified === true;
  const routePending = route?.state === 'pending';
  const routeBlocked = route?.state === 'blocked';
  const consentNeeded = /consent|unconfined|untested.*version|containment/i.test(request.result?.code || '');
  const controlReply = typeof request.controlReply === 'string' ? request.controlReply : request.controlReply?.text;
  const reply = finalText ? { text: finalText, at: replyEvent?.timestamp || review?.at, headAgentId: replyEvent?.payload?.headAgentId || review?.headAgentId, source: replyEvent?.payload?.source || 'department_head_review', final: true }
    : review?.summary && ['changes_requested', 'blocked'].includes(review.verdict) ? { text: review.summary, at: finishedReview?.timestamp, headAgentId: review.headAgentId, source: 'department_head_review', final: false }
      : controlReply || request.result?.message ? { text: controlReply || request.result.message, at: request.endedAt, source: 'coordinator', final: false } : null;
  let label = detail?.status?.word || task.statusLabel || 'Received';
  let tone = verified ? 'verified' : task.inMotion ? 'active' : task.needsYou ? 'attention' : 'neutral';
  if (directReply) { label = 'Answered'; tone = 'neutral'; }
  else if (routePending) { label = 'Routing your request'; tone = 'active'; }
  else if (consentNeeded) { label = 'Runtime permission needed'; tone = 'attention'; }
  else if (routeBlocked) { label = 'Routing needs attention'; tone = 'attention'; }
  else if (reviewing) { label = 'Department head reviewing'; tone = 'active'; }
  else if (review?.verdict === 'changes_requested') { label = 'Head requested changes'; tone = 'attention'; }
  else if (review?.verdict === 'blocked') { label = 'Head review blocked'; tone = 'attention'; }
  else if (finalText) { label = verified ? 'Reviewed and verified' : 'Reviewed · verification needs attention'; tone = verified ? 'verified' : 'attention'; }
  else if (verified) label = route ? 'Checks passed · awaiting head review' : 'Checks verified';
  const stage = key => detail?.phases?.find(phase => phase.key === key)?.state || 'not_yet';
  const phases = [
    { key: 'route', label: 'Route', state: routePending ? 'now' : routeBlocked ? 'stopped' : route?.state === 'selected' || request.departmentId ? 'done' : 'not_yet' },
    { key: 'plan', label: 'Plan', state: stage('decide') },
    { key: 'work', label: 'Work', state: stage('change') },
    { key: 'checks', label: 'Checks', state: stage('check') },
    { key: 'review', label: 'Review', state: reviewing ? 'now' : review?.verdict === 'passed' ? 'done' : review ? 'stopped' : 'not_yet' },
    { key: 'reply', label: 'Reply', state: finalText ? 'done' : 'not_yet' },
  ];
  const parts = (detail?.parts || []).map(part => ({ ...part }));
  const completedTasks = parts.filter(part => part.state === 'accepted').length;
  const reservedWorkerIds = ['starting', 'running'].includes(request.state) ? [...new Set(request.workerIds || [])] : [];
  const ownerByTask = new Map((status?.tasks || run?.taskViews || []).map(row => [row.id, row.ownerAgentId]));
  const runningWorkers = new Set(parts.filter(part => part.state === 'running').map(part => part.agentId || ownerByTask.get(part.taskId) || part.taskId));
  const blocked = events.filter(event => event.type === 'schedule.blocked').at(-1)?.payload?.blocked || [];
  const waitByKey = new Map(blocked.map(row => [row.key, row]));
  for (const part of parts) {
    const waiting = waitByKey.get(part.key);
    if (waiting && ['pending', 'ready', 'waiting'].includes(part.state)) part.waitReason = waiting.reason;
  }
  return { request, route, directReply, routePending, routeBlocked, consentNeeded, review, reviewing, reply, verified, label, tone, phases: directReply ? [] : phases, parts, completedTasks, totalTasks: parts.length, reservedWorkerIds, runningWorkerCount: runningWorkers.size,
    routeReason: route?.reason || (request.departmentId ? 'Recorded department assignment' : ''),
    headAgentId: route?.headAgentId || startedReview?.payload?.headAgentId || review?.headAgentId || null,
    hasHeadReview: Boolean(startedReview || review),
    legacyCheckResult: verified && !route && !review && !reviewing && !finalText };
}
