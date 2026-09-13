import { api, getJson } from '../../workspace/src/api.js';
import { indexWorkspace, taskDetailModel, isDirectControlReply } from '../../workspace/src/model.js';
import { checkView, describeEvent } from '../../workspace/src/truth.js';
import { chatRoute, controlCenterRoute, controlCenterBinding, controlSubmissionFingerprint, consentRetryBinding, controlFlowModel, conversationEntries, readChatState } from './chat-model.js';
import { catalogForRuntime, reconcileModelSelection } from '../../workspace/src/runtime-model-options.js';
import { renderRecordedOutput } from './recorded-output.js';
import { usageSummary } from './usage-model.js';
import { renderChatResponse, renderUserMessage } from './chat-presentation.js';
import { createChatDisclosures } from './chat-disclosures.js';
import { ATTACHMENT_LIMITS, attachmentDescriptors, attachmentSelectionError, formatAttachmentSize, persistDraftAttachments, restoreDraftAttachments, consentRetryAttachmentIds } from './attachment-model.js';

const icon = (name, size = 18) => {
  const paths = {
    center: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="15" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6M6 9v6m12-6v6M9 18h6"/>',
    arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
    send: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    attach: '<path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-6 9 7-7a1 1 0 0 1 2 2l-7 7"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.center}</svg>`;
};
const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = (name = '') => name.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('');
const time = at => { const date = new Date(at); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const uid = () => globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const STATUS_TONE = { verified: 'verified', failed: 'failed', noPlan: 'failed', notStarted: 'failed', interrupted: 'attention', stalled: 'attention', held: 'attention', unverified: 'attention', running: 'active', planning: 'active', checking: 'active', starting: 'active' };

/** A durable task conversation over the existing coordinator API, with no simulated replies. */
export function createSidebar({ element, departments = [], employees = [], runtimes = [], coordinator = {}, onFocus = () => {}, onEditAgent = () => {}, onRemoveAgent = null, onManageAgents = () => {}, onAddAgent = () => {}, onAddDepartment = () => {}, onAddProject = () => { location.href = '/workspace/#/projects'; }, onManageRuntimes = () => { location.href = '/workspace/#/settings'; }, onAssignTask = null, onOpenTask = () => {} }) {
  let selection = { type: 'office' };
  let activeTab = 'chat';
  let taskFilter = 'all';
  let expandedTask = null;
  let focusedChatTask = null;
  let expandedRuntime = null;
  let liveData = { tasks: [], projects: [], reports: [], error: null };
  let tasks = [];
  let destroyed = false;
  let sending = false;
  let submitError = '';
  let actionError = '';
  let runtimeChecking = false;
  let consent = false;
  let pendingAction = null;
  let storageKey = '';
  let state = { version: 1, contexts: {}, messages: [] };
  let draft = '';
  let draftAttachments = [];
  let attachmentError = '';
  const attachmentFiles = new Map();
  const attachmentUploads = new Map();
  let routePreferences = {};
  let orchestratorPreferences = { runtime: '', model: '', effort: '' };
  let submission = null;
  let consentSubmissions = {};
  let detailPending = false;
  let composerReady = false;
  let composerRouteSignature = '';
  const details = new Map();
  const modelCatalogs = new Map();
  const catalogSignatures = new Map();
  const catalogRequests = new Map();
  const disclosureState = createChatDisclosures();
  const viewportStates = new Map();
  let renderedViewport = '';
  let revealFrame = null;
  let expectedScrollTop = null;
  const employeeById = id => employees.find(item => item.id === id);
  const departmentById = id => departments.find(item => item.id === id);
  const runtimeById = id => runtimes.find(item => item.id === id);
  const workspaceDocument = () => liveData.workspaceDocument || liveData.workspaceDoc;
  const selectedDepartment = () => selection.type === 'department' ? selection.id : selection.type === 'employee' ? employeeById(selection.id)?.departmentId : null;
  const contextKey = () => 'control';
  const contextName = () => selection.type === 'employee' ? employeeById(selection.id)?.name || 'Agent' : selection.type === 'department' ? departmentById(selection.id)?.name || 'Department' : 'Control center';
  const route = () => controlCenterRoute(workspaceDocument(), routePreferences.projectId, orchestratorPreferences);
  const binding = () => {
    const initial = controlCenterBinding(workspaceDocument(), orchestratorPreferences);
    return controlCenterBinding(workspaceDocument(), orchestratorPreferences, catalogForRuntime(modelCatalogs, initial.runtimeId, initial.runtime));
  };
  const scopedTasks = () => tasks.filter(task => !isDirectControlReply(task.entry?.item));
  const roleLabel = agent => agent.workspaceRole === 'head' || /head|lead/i.test(agent.role || '') ? 'Department head' : 'Worker';
  const taskKey = task => `${task.projectId}:${task.runId}`;
  const taskById = id => tasks.find(task => task.id === id || task.requestId === id);

  function persist() {
    if (!storageKey) return;
    state.contexts[contextKey()] = { draft, attachments: persistDraftAttachments(draftAttachments), ...routePreferences, controlCenter: orchestratorPreferences, submission, consentSubmissions };
    try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage can be disabled; coordinator records remain authoritative. */ }
  }
  function restoreContext() {
    const saved = state.contexts[contextKey()] || {};
    draft = typeof saved.draft === 'string' ? saved.draft : '';
    draftAttachments = restoreDraftAttachments(saved.attachments);
    attachmentError = '';
    routePreferences = { projectId: saved.projectId || '', departmentId: saved.departmentId || '' };
    orchestratorPreferences = Object.fromEntries(['runtime', 'model', 'effort'].map(key => [key, typeof saved.controlCenter?.[key] === 'string' ? saved.controlCenter[key] : '']));
    submission = saved.submission || null;
    consentSubmissions = saved.consentSubmissions && typeof saved.consentSubmissions === 'object' ? saved.consentSubmissions : {};
    submitError = '';
    consent = false;
    composerRouteSignature = '';
  }
  function loadPersistence() {
    const path = workspaceDocument()?.path;
    if (!path) return;
    const key = `workforce:chat:v1:${path}`;
    if (key === storageKey) return;
    attachmentFiles.clear();
    attachmentUploads.clear();
    storageKey = key;
    try { state = readChatState(localStorage, key); } catch { state = { version: 1, contexts: {}, messages: [] }; }
    restoreContext();
  }

  element.classList.add('office-sidebar');
  element.setAttribute('aria-label', 'Control center');
  element.innerHTML = `<header class="sidebar-heading"><div class="sidebar-title-row"><span class="coordinator-mark">${icon('terminal', 18)}</span><div class="sidebar-title-copy"><h1>Control Center</h1><p class="sidebar-orchestrator-binding" title="The AI orchestrator for your next message. Department agents retain their own settings.">AI orchestrator</p></div><button type="button" class="sidebar-icon-button" data-manage-agents title="Manage agents" aria-label="Manage agents">${icon('center', 17)}</button></div></header>
    <div class="sidebar-context-row"><span class="context-icon">${icon('focus', 14)}</span><label class="sr-only" for="office-context-select">Inspect an agent or team</label><select id="office-context-select" class="sidebar-context-select"></select><button class="sidebar-icon-button context-focus" aria-label="Focus selected area on canvas" title="Focus selected area on canvas">${icon('arrow', 14)}</button></div>
    <div class="sidebar-tabs" role="tablist" aria-label="Control center views"><button class="sidebar-tab is-active" type="button" role="tab" id="office-tab-chat" aria-controls="office-panel" aria-selected="true" data-tab="chat">Chat</button><button class="sidebar-tab" type="button" role="tab" id="office-tab-tasks" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="tasks">Activity <span class="tab-task-count">0</span></button><button class="sidebar-tab" type="button" role="tab" id="office-tab-connections" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="connections">Runtimes</button></div>
    <section class="sidebar-scroll" id="office-panel" role="tabpanel" aria-labelledby="office-tab-chat" tabindex="0"></section><div class="chat-jump-wrap" hidden><button type="button" class="chat-jump-latest" data-jump-latest><span>Jump to latest</span><span aria-hidden="true">↓</span></button></div><div class="sidebar-composer-wrap"></div><div class="sidebar-demo-note"><span class="sidebar-sync-dot"></span><span data-sync-note>Connecting to local coordinator</span></div>`;
  const scroll = element.querySelector('.sidebar-scroll');
  const composerWrap = element.querySelector('.sidebar-composer-wrap');
  const contextSelect = element.querySelector('.sidebar-context-select');
  const jumpWrap = element.querySelector('.chat-jump-wrap');
  const viewportKey = () => `control|${activeTab}`;
  const viewportVisible = () => scroll.clientHeight > 0 && scroll.getClientRects().length > 0;
  function viewportState() {
    const key = viewportKey();
    if (!viewportStates.has(key)) viewportStates.set(key, { top: 0, following: activeTab === 'chat', unseen: false });
    return viewportStates.get(key);
  }
  function updateJumpControl() {
    const view = viewportState();
    jumpWrap.hidden = activeTab !== 'chat' || view.following || scroll.scrollHeight <= scroll.clientHeight + 70;
    const button = jumpWrap.querySelector('button');
    button.classList.toggle('has-new-activity', view.unseen);
    button.firstElementChild.textContent = view.unseen ? 'New activity · Jump to latest' : 'Jump to latest';
  }
  function applyViewport() {
    if (destroyed || !viewportVisible()) return;
    const view = viewportState();
    scroll.scrollTop = activeTab === 'chat' && view.following ? scroll.scrollHeight : view.top;
    expectedScrollTop = scroll.scrollTop;
    view.top = scroll.scrollTop;
    updateJumpControl();
  }
  function rememberViewport() {
    if (!viewportVisible() || renderedViewport !== viewportKey()) return;
    const view = viewportState();
    view.top = scroll.scrollTop;
  }
  function jumpToLatest() {
    const view = viewportState();
    view.following = true;
    view.unseen = false;
    applyViewport();
  }
  /** Call after revealing a previously hidden mobile panel; hidden geometry is never a scroll preference. */
  function reveal() {
    if (destroyed) return;
    if (revealFrame !== null) cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(() => { revealFrame = null; applyViewport(); });
  }
  scroll.addEventListener('scroll', () => {
    if (!viewportVisible() || renderedViewport !== viewportKey()) return;
    if (expectedScrollTop !== null && Math.abs(scroll.scrollTop - expectedScrollTop) < 1) { expectedScrollTop = null; return; }
    expectedScrollTop = null;
    const view = viewportState();
    view.top = scroll.scrollTop;
    if (activeTab === 'chat') {
      view.following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
      if (view.following) view.unseen = false;
    }
    updateJumpControl();
  }, { passive: true });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { applyViewport(); }) : null;
  resizeObserver?.observe(scroll);

  function renderSelection() {
    if (selection.type === 'employee') {
      const employee = employeeById(selection.id);
      if (!employee) return '';
      const runtime = runtimeById(employee.runtimeId);
      return `<details class="context-details" data-disclosure="profile:${esc(employee.id)}"><summary><span class="employee-monogram">${esc(initials(employee.name))}</span><span><strong>${esc(employee.name)}</strong><small>${esc(roleLabel(employee))} · ${esc(departmentById(employee.departmentId)?.name)}</small></span><span class="context-details-label">Agent details</span></summary><div class="context-details-body"><dl class="compact-facts"><div><dt>Runtime</dt><dd>${esc(runtime?.name || employee.runtime || 'Unassigned')}</dd></div><div><dt>Model</dt><dd>${esc(employee.model || runtime?.model || 'Runtime default')}</dd></div><div><dt>Status</dt><dd>${esc(employee.statusLabel || 'No active task')}</dd></div></dl><p class="person-instructions">${esc(employee.instructions || 'No instructions configured.')}</p><div class="inline-actions"><button type="button" data-edit-agent="${esc(employee.id)}">Edit agent</button>${onRemoveAgent ? `<button class="text-danger" type="button" data-remove-agent="${esc(employee.id)}">Remove agent</button>` : ''}</div></div></details>`;
    }
    if (selection.type === 'department') {
      const members = employees.filter(agent => agent.departmentId === selection.id);
      return `<details class="context-details" data-disclosure="team:${esc(selection.id)}"><summary><span class="employee-monogram">${icon('center', 16)}</span><span><strong>${esc(contextName())}</strong><small>${members.filter(agent => roleLabel(agent) === 'Department head').length} head · ${members.filter(agent => roleLabel(agent) === 'Worker').length} workers</small></span><span class="context-details-label">Team details</span></summary><div class="context-details-body"><div class="runtime-employees">${members.map(agent => `<button type="button" data-focus="employee" data-id="${esc(agent.id)}"><span>${esc(initials(agent.name))}</span>${esc(agent.name)}<small>${esc(roleLabel(agent))}</small></button>`).join('')}</div><div class="inline-actions"><button type="button" data-add-agent="${esc(selection.id)}">Add agent</button><button type="button" data-manage-agents>Manage team</button></div></div></details>`;
    }
    return '';
  }

  function taskDetail(task) {
    if (!task?.entry) return null;
    const cached = details.get(taskKey(task));
    try { return taskDetailModel({ ws: indexWorkspace(workspaceDocument()), entry: task.entry, status: cached?.status || null, events: cached?.events || [] }); } catch { return null; }
  }
  function renderTaskProgress(task) {
    const detail = taskDetail(task);
    const cached = details.get(taskKey(task));
    const events = cached?.events || [];
    const flow = controlFlowModel(task, detail, events, cached?.status);
    const item = flow.request;
    if (flow.directReply) return renderChatResponse({ id: task.id, flow });
    const assigned = flow.parts;
    const usage = usageSummary({ events, status: cached?.status, request: item, now: Date.now() });
    const elapsedSeconds = usage.elapsedMs == null ? null : Math.max(0, Math.floor(usage.elapsedMs / 1000));
    const elapsed = elapsedSeconds == null ? 'Time not reported' : elapsedSeconds < 60 ? `${elapsedSeconds}s elapsed` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s elapsed`;
    const tokenCount = value => value == null ? '—' : value.toLocaleString();
    const usageText = usage.tokenStatus === 'measured' ? `Run tokens · ${tokenCount(usage.inputTokens)} in / ${tokenCount(usage.outputTokens)} out${usage.tokenScope === 'partial' ? ' · partial' : ''}` : 'Run tokens not reported';
    const costText = usage.costStatus === 'measured' && usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}${usage.costScope === 'partial' ? ' · partial cost' : ''}` : 'Cost not reported';
    const headId = flow.headAgentId || events.find(event => event.type === 'head.planning_started')?.payload?.headAgentId;
    const headName = employeeById(headId)?.name || (headId ? headId : null);
    const teamId = flow.route?.departmentId || item.departmentId;
    const teamName = departmentById(teamId)?.name || teamId;
    const runtimeMessages = events.filter(event => event.type === 'runtime.assistant_message' && event.payload?.text).slice(-5);
    const latestEvents = events.filter(event => event.type !== 'runtime.raw' && event.type !== 'runtime.assistant_message' && event.type !== 'runtime.usage').slice(-7);
    const checks = cached?.status?.checks || [];
    const actions = [];
    if (detail?.canStop) actions.push(`<button type="button" data-task-action="stop" data-id="${esc(task.id)}" ${pendingAction ? 'disabled' : ''}>Stop task</button>`);
    if (detail?.canResume) actions.push(`<button type="button" data-task-action="resume" data-id="${esc(task.id)}" ${pendingAction ? 'disabled' : ''}>Resume</button>`);
    if (item.state === 'held') actions.push(`<button type="button" data-task-action="start" data-id="${esc(task.id)}" ${pendingAction ? 'disabled' : ''}>Start held task</button>`);
    if (['held', 'queued'].includes(item.state)) actions.push(`<button type="button" data-task-action="discard" data-id="${esc(task.id)}" ${pendingAction ? 'disabled' : ''}>Discard</button>`);
    if (flow.consentNeeded && item.state === 'failed_to_start') actions.push(`<button type="button" data-task-action="routing-consent" data-id="${esc(task.id)}" ${pendingAction ? 'disabled' : ''}>Review runtime permission</button>`);
    const actors = `${flow.reservedWorkerIds.length ? `<div class="chat-capacity"><span>${flow.reservedWorkerIds.length} worker${flow.reservedWorkerIds.length === 1 ? '' : 's'} reserved</span><span>${flow.runningWorkerCount} running</span></div>` : ''}<div class="chat-actors">${headName ? `<div><strong>${esc(headName)} <small>Department head</small></strong><span>${flow.reviewing ? 'Reviewing the completed candidate and checks.' : flow.review ? esc(flow.review.verdict === 'passed' ? 'Review passed.' : 'Review requires attention.') : esc(detail?.actors?.find(actor => actor.role === 'head')?.line || 'Assigned by Control Center.')}</span></div>` : ''}${assigned.map(part => `<div><strong>${esc(part.worker)} <small>Assigned worker</small></strong><span>${esc(part.title)} · ${esc(({worker_busy:'Waiting for worker',dependency:'Waiting for dependency',turn_slot:'Waiting for runtime slot',writer_slot:'Waiting for write slot'})[part.waitReason] || ({pending:'Awaiting dispatch',ready:'Awaiting dispatch',running:'Running',validating:'Independent checks',accepted:'Accepted',failed:'Needs attention',cancelled:'Stopped'})[part.state] || part.state || 'Assigned')}</span></div>`).join('')}${!assigned.length && headName && !flow.routeBlocked ? '<p>No worker has been assigned yet.</p>' : ''}</div>`;
    const progress = `<div class="chat-execution"><div class="chat-progress-heading"><span class="status-indicator status-${flow.tone}">${flow.tone === 'verified' ? icon('check',12) : '<i></i>'}${esc(flow.label)}</span>${flow.totalTasks ? `<small title="Accepted worker tasks, not an estimate of remaining time">Completed tasks · ${flow.completedTasks}/${flow.totalTasks}</small>` : ''}</div><ol class="chat-phases" aria-label="Recorded execution phases">${flow.phases.map(phase => `<li class="phase-${phase.state}"><i></i><span>${phase.label}</span></li>`).join('')}</ol>${flow.totalTasks ? `<progress class="chat-completion" max="${flow.totalTasks}" value="${flow.completedTasks}" aria-label="Completed worker tasks">${flow.completedTasks}/${flow.totalTasks}</progress>` : ''}<p class="chat-status-line">${esc(flow.routePending ? flow.routeReason || 'Control Center is selecting the department for this request.' : flow.routeBlocked ? item.reason || flow.routeReason || 'A routing decision is needed.' : detail?.overlay?.line || (flow.reviewing ? 'The department head is reviewing the candidate against the request and recorded checks.' : detail?.status?.line) || task.summary || 'Waiting for the next recorded step.')}</p>${teamName ? `<div class="chat-route-decision"><span>Control Center</span><span>→</span><strong>${esc(teamName)}</strong>${flow.route?.elapsedMs != null ? `<small>${(flow.route.elapsedMs/1000).toFixed(1)}s to route</small>` : ''}</div>` : ''}${actors}${flow.legacyCheckResult ? '<p class="chat-status-line">This earlier task has verified checks. No department-head review or Control Center final reply was recorded.</p>' : ''}</div>`;
    const diagnostics = `${runtimeMessages.length ? `<details class="chat-record" data-disclosure="runtime-output:${esc(task.id)}"><summary>Agent activity <span>${runtimeMessages.length} recent replies</span></summary><div class="chat-runtime-messages">${runtimeMessages.map(event => `<article><div class="chat-message-meta">${esc(employeeById(cached?.status?.tasks?.find(row => row.id === event.taskId)?.ownerAgentId)?.name || headName || 'Runtime')} <span>Recorded output · ${esc(time(event.timestamp))}</span></div>${renderRecordedOutput(event.payload.text).replace('class="recorded-original"', `class="recorded-original" data-disclosure="output:${esc(task.id)}:${event.sequence}"`)}</article>`).join('')}</div></details>` : ''}${checks.length ? `<details class="chat-record" data-disclosure="checks:${esc(task.id)}"><summary>Independent checks <span>${checks.length}</span></summary><ul>${checks.map(row => { const view = checkView(row, cached.status, task.entry?.run); const label = view.compromised ? 'Does not count — criteria changed' : view.evidenceUnavailable ? 'Evidence unavailable' : view.verifier && row.outcome === 'passed' ? 'Passed · verifier' : row.outcome === 'failed' ? 'Failed' : 'Reported · unverified'; return `<li class="${view.tone === 'verified' ? 'check-verified' : ''}"><strong>${esc(label)}</strong><code>${esc(row.command)}</code></li>`; }).join('')}</ul></details>` : ''}${latestEvents.length ? `<details class="chat-record" data-disclosure="events:${esc(task.id)}"><summary>Event log <span>${events.length}</span></summary><ul>${latestEvents.map(event => `<li><small>#${event.sequence} · ${esc(time(event.timestamp))}</small>${esc(describeEvent(event))}</li>`).join('')}</ul></details>` : ''}`;
    const usageHTML = `<footer class="chat-usage" title="${esc('Recorded run usage; a separate routing session is not included. '+usage.detail)}"><span>${esc(elapsed)}</span><span>${esc(usageText)}</span><span>${esc(costText)}</span></footer>`;
    const consentHTML = pendingAction === `resume-consent:${task.id}` || pendingAction === `routing-consent:${task.id}` ? `<div class="chat-action-consent"><p>${esc(pendingAction.startsWith('routing-consent:') ? item.result?.message || item.reason || 'This runtime requires explicit write permission for its installed version.' : 'This task uses a runtime without a verified OS file boundary and will run alone.')}</p><label><input type="checkbox" data-resume-consent="${esc(task.id)}"> Allow this runtime to write without the verified boundary</label><div class="inline-actions"><button type="button" data-task-action="${pendingAction.startsWith('routing-consent:') ? 'routing-confirm' : 'resume-confirm'}" data-id="${esc(task.id)}" disabled>${pendingAction.startsWith('routing-consent:') ? 'Allow and retry' : 'Confirm resume'}</button><button type="button" data-task-action="cancel-consent" data-id="${esc(task.id)}">Cancel</button></div></div>` : '';
    const statusLine = flow.routePending ? flow.routeReason || 'Control Center is selecting the department for this request.' : flow.routeBlocked ? item.reason || flow.routeReason || 'A routing decision is needed.' : detail?.overlay?.line || (flow.reviewing ? 'The department head is reviewing the candidate against the request and recorded checks.' : detail?.status?.line) || task.summary || 'Waiting for the next recorded step.';
    return renderChatResponse({ id: task.id, flow, elapsedMs: usage.elapsedMs,
      traceHTML: `${progress}${diagnostics}${usageHTML}`, actionsHTML: actions.join(''), consentHTML,
      refreshError: cached?.error, statusLine, overlayLine: detail?.overlay?.line, stopRequested: Boolean(item.stopRequestedAt && !detail?.canResume),
      reviewer: flow.reply?.headAgentId ? employeeById(flow.reply.headAgentId)?.name || flow.reply.headAgentId : '',
    });
  }

  function renderChat() {
    const entries = conversationEntries(state.messages, tasks);
    const focused = taskById(focusedChatTask);
    if (focused && !entries.some(message => message.task?.id === focused.id)) {
      entries.push(...conversationEntries([], [focused]));
      entries.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
    }
    return `${renderSelection()}${liveData.error ? `<p class="sidebar-error" role="status">${esc(liveData.error)}. Showing the last received records.</p>` : ''}<div class="chat-conversation" role="log" aria-label="Task conversation">${entries.length ? entries.map(message => `<article class="chat-turn" data-request-id="${esc(message.requestId || message.id)}">${renderUserMessage({ id: message.requestId || message.id, text: message.text, attachments: message.attachments, project: liveData.projects?.find(project => project.id === message.projectId)?.name || message.projectId || '', at: time(message.at) })}${message.task ? renderTaskProgress(message.task) : '<p class="chat-response-status">Control Center is reading your request…</p>'}</article>`).join('') : `<div class="chat-empty"><span class="chat-empty-icon">${icon('terminal', 25)}</span><h2>What are we building?</h2><p>Send a task or ask a question. Your team’s progress and reviewed response will appear here.</p><div class="chat-empty-actions">${!liveData.projects?.length ? `<button type="button" data-add-project>${icon('plus', 14)}Add project</button>` : ''}${!departments.length ? `<button type="button" data-add-department>${icon('plus', 14)}Create department</button>` : ''}</div></div>`}</div>`;
  }

  function catalogSignature(runtimeId) {
    const document = workspaceDocument();
    const runtime = document?.workspace?.runtimes?.[runtimeId];
    const report = document?.runtimes?.reports?.find(row => row.runtimeId === runtimeId);
    return JSON.stringify([document?.path, runtimeId, runtime?.adapter, runtime?.executable, report?.version || runtimeById(runtimeId)?.version]);
  }
  function ensureModels(force = false) {
    const selected = controlCenterBinding(workspaceDocument(), orchestratorPreferences);
    if (!selected.runtime || !selected.runtimeId) return;
    const runtimeId = selected.runtimeId;
    const signature = catalogSignature(runtimeId);
    if (!force && catalogSignatures.get(runtimeId) === signature && modelCatalogs.has(runtimeId)) return;
    const request = { signature };
    catalogRequests.set(runtimeId, request);
    catalogSignatures.set(runtimeId, signature);
    const identity = { runtimeId, adapter: selected.runtime.adapter, configuredExecutable: selected.runtime.executable };
    modelCatalogs.set(runtimeId, { ...identity, status: 'loading', models: [], diagnostics: [] });
    const read = api.runtimeModels ? api.runtimeModels(runtimeId, force) : getJson(`/api/runtimes/${encodeURIComponent(runtimeId)}/models${force ? '?refresh=1' : ''}`);
    void read.then(catalog => {
      if (catalog.runtimeId !== runtimeId || catalog.adapter !== selected.runtime.adapter || catalog.configuredExecutable !== selected.runtime.executable) throw new Error('The runtime binding changed while its models were loading. Refresh models.');
      if (!destroyed && catalogRequests.get(runtimeId) === request && catalogSignature(runtimeId) === signature) modelCatalogs.set(runtimeId, catalog);
    }).catch(error => {
      if (!destroyed && catalogRequests.get(runtimeId) === request && catalogSignature(runtimeId) === signature) modelCatalogs.set(runtimeId, { ...identity, status: 'unavailable', models: [], diagnostics: [error.message || 'Could not read this runtime’s model choices.'] });
    }).finally(() => {
      if (catalogRequests.get(runtimeId) === request) catalogRequests.delete(runtimeId);
      if (!destroyed) renderComposer();
    });
  }
  function setChoiceOptions(select, options, value) {
    const html = options.map(option => `<option value="${esc(option.value)}"${option.unavailable ? ' disabled' : ''}>${esc(option.label)}</option>`).join('');
    // Browsers normalize boolean attributes in innerHTML. Compare our own bytes
    // so polling never rebuilds an unchanged open native selector.
    if (select.dataset.optionsMarkup !== html) { select.innerHTML = html; select.dataset.optionsMarkup = html; }
    select.value = value;
  }
  function renderOrchestrator() {
    if (activeTab === 'chat') ensureModels();
    const selected = binding();
    const catalog = catalogForRuntime(modelCatalogs, selected.runtimeId, selected.runtime);
    const runtime = selected.runtimes.find(row => row.id === selected.runtimeId);
    const reportedModel = catalog?.models?.find(model => model.id === selected.effortOptions.effectiveModel);
    const modelLabel = reportedModel?.label || selected.model || selected.inheritedModel || 'Runtime default';
    const effort = selected.effort || selected.inheritedEffort || reportedModel?.defaultEffort;
    const identity = runtime ? `${runtime.name} · ${modelLabel}` : 'Choose an AI runtime';
    const title = `${identity}${effort ? ` · ${effort} effort` : ' · effort inherited'}. Runtime binding: ${selected.runtimeId || 'not selected'}. Used by Control Center for this message. Department heads and workers keep their own settings.`;
    const heading = element.querySelector('.sidebar-orchestrator-binding');
    heading.textContent = identity;
    heading.title = title;
    const runtimeSelect = composerWrap.querySelector('[name=control-runtime]');
    const runtimeOptions = [{ value: '', label: selected.defaultRuntimeId ? `${selected.runtimes.find(row => row.id === selected.defaultRuntimeId)?.name || selected.defaultRuntimeId} · default` : 'Workspace default', unavailable: false }, ...selected.runtimes.map(row => ({ value: row.id, label: `${row.name}${selected.runtimes.filter(other => other.binding.adapter === row.binding.adapter).length > 1 ? ` · ${row.id}` : ''}${row.ready ? '' : ` · ${row.status}`}`, unavailable: !row.ready }))];
    if (orchestratorPreferences.runtime && !runtimeOptions.some(option => option.value === orchestratorPreferences.runtime)) runtimeOptions.push({ value: orchestratorPreferences.runtime, label: `${orchestratorPreferences.runtime} · unavailable`, unavailable: true });
    setChoiceOptions(runtimeSelect, runtimeOptions, orchestratorPreferences.runtime);
    runtimeSelect.disabled = sending || !selected.runtimes.length;
    runtimeSelect.title = title;
    const modelSelect = composerWrap.querySelector('[name=control-model]');
    const inheritedModelId = selected.inheritedModel || catalog?.defaultModel || catalog?.models?.find(model => model.isDefault)?.id;
    const inheritedModelLabel = catalog?.models?.find(model => model.id === inheritedModelId)?.label || inheritedModelId;
    setChoiceOptions(modelSelect, selected.modelOptions.options.map(option => !option.value && inheritedModelLabel ? { ...option, label: `${inheritedModelLabel} · ${option.unavailable ? 'unavailable' : 'default'}` } : option), selected.model);
    modelSelect.disabled = sending || !selected.runtime || selected.modelOptions.disabled;
    modelSelect.title = `${selected.modelOptions.hint}${reportedModel?.description ? ` ${reportedModel.description}` : ''}`;
    const effortSelect = composerWrap.querySelector('[name=control-effort]');
    const inheritedEffort = selected.inheritedEffort || reportedModel?.defaultEffort;
    setChoiceOptions(effortSelect, selected.effortOptions.options.map(option => !option.value ? { ...option, label: `${inheritedEffort || 'Default'}${inheritedEffort ? ' · default' : ''}${option.unavailable ? ' · unavailable' : ''}` } : option), selected.effort);
    effortSelect.disabled = sending || !selected.runtime || selected.effortOptions.disabled;
    effortSelect.title = selected.effortOptions.hint;
    const hint = composerWrap.querySelector('.composer-binding-status');
    const message = catalog?.status === 'loading' ? 'Reading runtime models…' : catalog?.status !== 'available' ? selected.modelOptions.hint : selected.effortOptions.disabled ? 'Effort is inherited; this runtime does not report its reasoning options.' : '';
    hint.textContent = message;
    hint.hidden = !message || !selected.runtime;
    const refresh = composerWrap.querySelector('[data-refresh-models]');
    refresh.disabled = sending || !selected.runtime || catalog?.status === 'loading';
    refresh.setAttribute('aria-label', catalog?.status === 'loading' ? 'Reading model choices' : 'Refresh model choices');
    return selected;
  }

  function attachmentsReady() { return draftAttachments.every(file => file.status === 'ready' && file.id); }
  function renderAttachments() {
    const list = composerWrap.querySelector('.composer-attachments');
    list.hidden = !draftAttachments.length;
    const html = `<ul aria-label="Files for this message">${draftAttachments.map(file => `<li class="composer-attachment attachment-${file.status}" title="${esc(`${file.name} · ${file.mimeType} · ${formatAttachmentSize(file.size)}`)}"><span class="attachment-kind" aria-hidden="true">${file.mimeType?.startsWith('image/') ? 'IMG' : 'FILE'}</span><span class="attachment-copy"><strong>${esc(file.name)}</strong><small>${esc(formatAttachmentSize(file.size))} · ${file.status === 'uploading' ? 'Uploading…' : file.status === 'ready' ? 'Attached' : 'Upload failed'}</small>${file.error ? `<span class="attachment-file-error">${esc(file.error)}</span>` : ''}</span>${file.status === 'error' && attachmentFiles.has(file.key) ? `<button type="button" class="attachment-retry" data-retry-attachment="${esc(file.key)}" aria-label="Retry uploading ${esc(file.name)}" ${sending ? 'disabled' : ''}>Retry</button>` : ''}<button type="button" class="attachment-remove" data-remove-attachment="${esc(file.key)}" aria-label="Remove ${esc(file.name)}" ${sending ? 'disabled' : ''}>×</button></li>`).join('')}</ul>`;
    if (list.dataset.markup !== html) { list.innerHTML = html; list.dataset.markup = html; }
    const uploading = draftAttachments.filter(file => file.status === 'uploading').length;
    const failed = draftAttachments.some(file => file.status === 'error');
    const hint = composerWrap.querySelector('.composer-attachment-hint');
    hint.textContent = uploading ? `Uploading ${uploading} file${uploading === 1 ? '' : 's'}…` : failed ? 'Retry or remove the failed uploads before sending.' : draftAttachments.length ? !draft.trim() ? 'Add a message to send these files.' : 'Format support depends on the selected runtime.' : '';
    hint.title = 'Format support depends on the selected runtime. 10 MB per file; 5 MB per image.';
    hint.hidden = !hint.textContent;
    const error = composerWrap.querySelector('.composer-attachment-error');
    error.textContent = attachmentError;
    error.hidden = !attachmentError;
    composerWrap.querySelector('[data-add-attachment]').disabled = sending || draftAttachments.length >= ATTACHMENT_LIMITS.count;
    composerWrap.querySelector('[name=attachments]').disabled = sending;
  }
  async function uploadRows(rows) {
    const targetStorage = storageKey;
    const operation = {};
    for (const row of rows) { row.status = 'uploading'; delete row.error; attachmentUploads.set(row.key, operation); }
    submission = null; attachmentError = ''; persist(); renderComposer();
    try {
      const result = await api.uploadAttachments(rows.map(row => attachmentFiles.get(row.key)));
      const uploaded = attachmentDescriptors(result?.attachments);
      if (uploaded.length !== rows.length || new Set(uploaded.map(file => file.id)).size !== rows.length) throw new Error('The server did not return all uploaded files. Retry this upload.');
      if (destroyed || storageKey !== targetStorage) return;
      rows.forEach((row, index) => {
        const current = draftAttachments.find(file => file.key === row.key);
        if (!current || attachmentUploads.get(row.key) !== operation) return;
        Object.assign(current, uploaded[index], { status: 'ready' });
        delete current.error;
        attachmentFiles.delete(row.key);
      });
    } catch (error) {
      if (destroyed || storageKey !== targetStorage) return;
      for (const row of rows) {
        const current = draftAttachments.find(file => file.key === row.key);
        if (current && attachmentUploads.get(row.key) === operation) { current.status = 'error'; current.error = error?.message || 'Upload failed. Try again.'; }
      }
    } finally {
      for (const row of rows) if (attachmentUploads.get(row.key) === operation) attachmentUploads.delete(row.key);
      if (!destroyed && storageKey === targetStorage) { persist(); renderComposer(); }
    }
  }
  function addAttachments(files) {
    const selected = Array.from(files || []);
    if (!selected.length || sending) return;
    attachmentError = attachmentSelectionError(selected, draftAttachments);
    if (attachmentError) { renderComposer(); return; }
    const rows = selected.map(file => {
      const row = { key: uid(), name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, status: 'uploading' };
      attachmentFiles.set(row.key, file);
      return row;
    });
    draftAttachments.push(...rows);
    void uploadRows(rows);
  }
  function removeAttachment(key) {
    if (sending) return;
    draftAttachments = draftAttachments.filter(file => file.key !== key);
    attachmentFiles.delete(key); attachmentUploads.delete(key);
    submission = null; attachmentError = ''; persist(); renderComposer();
    composerWrap.querySelector('textarea')?.focus({ preventScroll: true });
  }
  function retryAttachment(key) {
    if (sending) return;
    const row = draftAttachments.find(file => file.key === key);
    if (row?.status === 'error' && attachmentFiles.has(key)) void uploadRows([row]);
  }

  function mountComposer() {
    if (composerReady) return;
    composerWrap.innerHTML = `<div class="composer-readiness" role="status"></div><form class="sidebar-composer" aria-label="Message Control Center"><div class="composer-attachments" hidden></div><label class="sr-only" for="coordinator-message">Message Control Center</label><textarea id="coordinator-message" name="task" rows="3" maxlength="20000" placeholder="Ask anything or describe a task…"></textarea><div class="composer-orchestrator" role="group" aria-label="Control Center AI settings"><label><span>Runtime</span><select name="control-runtime" aria-label="Control Center runtime"></select></label><label><span>Model</span><select name="control-model" aria-label="Control Center model"></select></label><label><span>Effort</span><select name="control-effort" aria-label="Control Center reasoning effort"></select></label><button type="button" class="composer-model-refresh" data-refresh-models title="Refresh choices reported by this runtime" aria-label="Refresh model choices">↻</button></div><p class="composer-binding-status" role="status" hidden></p><div class="composer-boundary" hidden><label><input type="checkbox" name="consent"> <span>Allow runtime writes without a verified OS file boundary. This task will run alone.</span></label></div><div class="composer-bottom"><input class="sr-only" type="file" name="attachments" multiple tabindex="-1" aria-label="Choose files or images" hidden><button class="composer-attach" type="button" data-add-attachment aria-label="Attach files or images" title="Attach files or images · 8 maximum · 10 MB per file; 5 MB per image · 25 MB total">${icon('attach', 17)}</button><div class="composer-routing">${icon('terminal',14)}<label><span class="sr-only">Project</span><select name="project" id="chat-project" aria-label="Task project"></select></label></div><span class="composer-scope" title="Control Center replies, asks a focused question, or delegates to a department. Coding tasks use an isolated candidate."></span><button class="composer-send" type="submit" aria-label="Send to Control Center">${icon('send', 17)}</button></div></form><p class="composer-attachment-hint" role="status" hidden></p><p class="composer-attachment-error" role="alert" hidden></p><p class="composer-error" role="alert" hidden></p><div class="composer-help"><span>Each message starts a new request</span><span title="Enter to send. Shift + Enter for a new line.">Shift + Enter for a new line</span></div>`;
    composerReady = true;
    const textarea = composerWrap.querySelector('textarea');
    composerWrap.querySelector('[name=attachments]').addEventListener('change', event => {
      addAttachments(event.target.files);
      event.target.value = '';
    });
    textarea.addEventListener('input', () => {
      draft = textarea.value;
      submission = null;
      persist();
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
      updateComposerButton();
    });
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(); }
    });
    composerWrap.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submitMessage(); });
    composerWrap.querySelector('[name=project]').addEventListener('change', event => {
      routePreferences.projectId = event.target.value;
      consent = false; submission = null; persist(); renderComposer();
    });
    composerWrap.querySelector('[name=consent]').addEventListener('change', event => { consent = event.target.checked; updateComposerButton(); });
    composerWrap.querySelector('[name=control-runtime]').addEventListener('change', event => {
      orchestratorPreferences = { runtime: event.target.value, model: '', effort: '' };
      submission = null; submitError = ''; persist(); renderComposer();
    });
    composerWrap.querySelector('[name=control-model]').addEventListener('change', event => {
      orchestratorPreferences.model = event.target.value;
      const selected = binding();
      const catalog = catalogForRuntime(modelCatalogs, selected.runtimeId, selected.runtime);
      const next = reconcileModelSelection({ catalog, model: orchestratorPreferences.model, effort: orchestratorPreferences.effort, inheritedModel: selected.inheritedModel, changed: 'model' });
      orchestratorPreferences = { ...orchestratorPreferences, ...next };
      submission = null; submitError = ''; persist(); renderComposer();
    });
    composerWrap.querySelector('[name=control-effort]').addEventListener('change', event => {
      orchestratorPreferences.effort = event.target.value;
      submission = null; submitError = ''; persist(); renderComposer();
    });
  }
  function updateComposerButton() {
    const current = route();
    const button = composerWrap.querySelector('.composer-send');
    button.disabled = sending || !draft.trim() || !current.sendable || !binding().sendable || !attachmentsReady();
    button.classList.toggle('is-sending', sending);
    button.setAttribute('aria-label', sending ? 'Sending task' : 'Send to Control Center');
    renderAttachments();
  }
  function renderComposer() {
    mountComposer();
    const selected = renderOrchestrator();
    composerWrap.hidden = activeTab !== 'chat';
    if (activeTab !== 'chat') return;
    const current = route();
    routePreferences = { projectId: current.projectId };
    const project = composerWrap.querySelector('[name=project]');
    const signature = JSON.stringify(current.projects.map(p => [p.id, p.name]));
    if (signature !== composerRouteSignature) {
      project.innerHTML = current.projects.length ? current.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') : '<option value="">Add a project</option>';
      composerRouteSignature = signature;
    }
    project.value = current.projectId;
    project.disabled = sending || !current.projects.length;
    const textarea = composerWrap.querySelector('textarea');
    if (textarea.value !== draft) textarea.value = draft;
    textarea.disabled = sending;
    composerWrap.querySelector('.composer-boundary').hidden = true;
    composerWrap.querySelector('[name=consent]').checked = consent;
    composerWrap.querySelector('[name=consent]').disabled = sending;
    const readiness = composerWrap.querySelector('.composer-readiness');
    const blockers = [...new Set([...current.blockers, ...selected.blockers])];
    readiness.hidden = blockers.length === 0;
    readiness.innerHTML = `${blockers.map(line => `<p>${esc(line)}</p>`).join('')}<div class="inline-actions">${!current.projects.length ? '<button type="button" data-add-project>Add project</button>' : selected.blockers.length || !current.runtimeId ? '<button type="button" data-manage-runtimes>Runtime settings</button>' : '<button type="button" data-add-project>Project settings</button>'}</div>`;
    composerWrap.querySelector('.composer-scope').innerHTML = current.sendable ? 'Auto route' : '';
    const error = composerWrap.querySelector('.composer-error');
    error.hidden = !submitError; error.textContent = submitError;
    updateComposerButton();
  }

  async function submitMessage() {
    if (sending || !draft.trim() || !attachmentsReady()) return;
    const current = route();
    const selected = binding();
    if (!current.sendable || !selected.sendable) { renderComposer(); return; }
    if (!onAssignTask) { submitError = 'Task intake is not available yet. Your draft is saved.'; renderComposer(); return; }
    const text = draft.trim();
    const controlCenter = selected.payload;
    const attachments = attachmentDescriptors(draftAttachments);
    const attachmentIds = attachments.map(file => file.id);
    const fingerprint = controlSubmissionFingerprint({ text, projectId: current.projectId, controlCenter, attachmentIds });
    if (submission?.fingerprint !== fingerprint) submission = { fingerprint, id: uid() };
    const clientRequestId = submission.id;
    const sentContext = contextKey();
    sending = true; submitError = ''; persist(); renderComposer();
    try {
      const result = await onAssignTask({ text, projectId: current.projectId, clientRequestId, ...(attachmentIds.length ? { attachmentIds } : {}), ...(controlCenter ? { controlCenter } : {}) });
      if (!result?.task?.id) throw new Error('The coordinator did not return a request receipt. Your draft is saved; retry uses the same request identity.');
      state.messages.push({ id: clientRequestId, requestId: result.task.id, text, attachments: Array.isArray(result.task.attachments) ? attachmentDescriptors(result.task.attachments) : attachments, projectId: current.projectId, ...(controlCenter ? { controlCenter } : {}), departmentId: result.task.departmentId || null, at: result.task.receivedAt || new Date().toISOString() });
      state.messages = state.messages.slice(-100);
      if (sentContext === contextKey()) { draft = ''; draftAttachments = []; attachmentError = ''; submission = null; consent = false; }
      else state.contexts[sentContext] = { ...state.contexts[sentContext], draft: '', attachments: [], submission: null };
      persist();
    } catch (error) { submitError = `${error?.message || 'The task could not be sent.'} Your draft is saved.`; }
    finally { sending = false; render(); jumpToLatest(); composerWrap.querySelector('textarea')?.focus({ preventScroll: true }); }
  }

  function renderActivity() {
    const scoped = scopedTasks();
    const filtered = scoped.filter(task => taskFilter === 'all' || taskFilter === 'running' && task.inMotion || taskFilter === 'review' && task.verified || taskFilter === 'attention' && task.needsYou);
    return `${renderSelection()}<div class="panel-section-heading"><div><h2>Task activity</h2><p>Live records from your local coordinator.</p></div></div><div class="task-filter-row" aria-label="Filter tasks">${[['all','All'],['running','Active'],['review','Verified'],['attention','Needs you']].map(([key,label]) => `<button type="button" class="task-filter ${taskFilter === key ? 'is-active' : ''}" data-task-filter="${key}" aria-pressed="${taskFilter === key}">${label}</button>`).join('')}</div><div class="sidebar-task-list">${filtered.map(task => `<article class="sidebar-task"><button type="button" class="task-summary" data-task="${esc(task.id)}" aria-expanded="${expandedTask === task.id}"><span class="task-state-dot status-${task.verified ? 'verified' : task.inMotion ? 'active' : task.needsYou ? 'attention' : 'neutral'}"></span><span class="task-summary-content"><strong>${esc(task.title)}</strong><span>${esc(departmentById(task.departmentId)?.name || '')} · ${esc(task.statusLabel)}</span></span><span class="task-chevron">${icon('chevron',14)}</span></button>${expandedTask === task.id ? renderTaskProgress(task) : ''}</article>`).join('') || '<div class="sidebar-empty"><h3>No tasks here yet</h3><p>Send a task in Chat to follow its progress.</p></div>'}</div>`;
  }

  function renderRuntimes() {
    const reports = liveData.reports || [];
    return `<div class="panel-section-heading"><div><h2>Local runtimes</h2><p>Installed CLIs power your heads and workers.</p></div><button class="sidebar-icon-button" type="button" data-manage-runtimes aria-label="Manage runtime installations" title="Manage runtime installations">${icon('arrow',16)}</button></div><div class="connection-list">${runtimes.map(runtime => {
      const report = reports.find(item => item.runtimeId === runtime.id) || runtime.report || reports.find(item => !item.runtimeId && item.adapter === runtime.adapter);
      const members = employees.filter(employee => employee.runtimeId === runtime.id);
      const expanded = expandedRuntime === runtime.id;
      const installed = report?.installed;
      const auth = report?.auth === 'logged_in' ? 'Signed in' : report?.auth === 'logged_out' ? 'Sign-in required' : 'Sign-in unknown';
      const blocked = installed === false || report?.auth === 'logged_out' || report?.adapterSupported === false || report?.controllable === false;
      const needsConsent = workspaceDocument()?.runtimeRules?.[runtime.id]?.requiresWriteConsent === true;
      const active = members.filter(member => ['working', 'running'].includes(member.status));
      return `<article class="runtime-item ${expanded ? 'is-expanded' : ''}"><button class="runtime-summary" type="button" data-runtime="${esc(runtime.id)}" aria-expanded="${expanded}"><span class="runtime-monogram">${icon('terminal',18)}</span><span class="runtime-main"><strong>${esc(runtime.name)}</strong><span>${esc(runtime.version || report?.version || 'Version not checked')}</span></span><span class="runtime-status ${blocked || needsConsent ? 'runtime-blocked' : active.length ? 'runtime-active' : ''}"><i></i>${blocked ? 'Needs setup' : active.length ? `${active.length} active` : needsConsent ? 'Consent required' : installed ? 'Available' : 'Not checked'}</span><span class="task-chevron">${icon('chevron',13)}</span></button><div class="runtime-facts"><span>${installed === true ? 'CLI installed' : installed === false ? 'CLI missing' : 'Installation unknown'}</span><span>${esc(auth)}</span><span>${members.length} assigned</span></div>${expanded ? `<div class="runtime-details"><dl class="compact-facts"><div><dt>Executable</dt><dd><code>${esc(report?.executablePath || report?.executable || 'Configured path')}</code></dd></div><div><dt>Control adapter</dt><dd>${report?.adapterSupported === true ? 'Supported' : report?.adapterSupported === false ? 'Unsupported' : 'Not checked'}</dd></div><div><dt>File boundary</dt><dd>${needsConsent ? 'Consent required for this installed version' : esc(report?.writeContainment || workspaceDocument()?.runtimeRules?.[runtime.id]?.writeContainment || 'Not verified')}</dd></div><div><dt>Model</dt><dd>${esc(runtime.model || 'Runtime default')}</dd></div></dl>${report?.loginHint ? `<p class="runtime-login-hint">${esc(report.loginHint)}</p>` : ''}<div class="runtime-employees">${members.map(agent => `<button type="button" data-focus="employee" data-id="${esc(agent.id)}"><span>${esc(initials(agent.name))}</span>${esc(agent.name)}<small>${esc(roleLabel(agent))}</small></button>`).join('') || '<p>No agents assigned to this runtime.</p>'}</div><div class="inline-actions"><button type="button" data-manage-runtimes>Configure runtime</button></div></div>` : ''}</article>`;
    }).join('') || '<div class="sidebar-empty"><h3>No runtimes discovered</h3><p>Configure an installed Codex or Claude Code CLI to run your agents.</p></div>'}</div><p class="connection-explainer">Installation and sign-in are checked without starting a model turn. Actual execution and verification are recorded with each task.</p><div class="inline-actions"><button type="button" data-recheck-runtimes ${runtimeChecking ? 'disabled' : ''}>${runtimeChecking ? 'Checking tools…' : 'Recheck tools'}</button><button type="button" data-manage-runtimes>Manage runtime paths ${icon('arrow',12)}</button><button type="button" data-manage-agents>Assign agents</button></div>`;
  }

  function render() {
    if (destroyed) return;
    rememberViewport();
    const view = viewportState();
    const sameViewport = renderedViewport === viewportKey();
    const focused = scroll.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.closest('[data-disclosure]')?.dataset.disclosure;
    disclosureState.remember(renderedViewport, scroll);
    const checkedConsent = scroll.querySelector('[data-resume-consent]:checked')?.dataset.resumeConsent;
    const options = `<option value="office">Control Center · inspect team</option>${departments.map(department => `<optgroup label="${esc(department.name)}"><option value="department:${esc(department.id)}">${esc(department.name)}</option>${employees.filter(employee => employee.departmentId === department.id).map(employee => `<option value="employee:${esc(employee.id)}">${esc(employee.name)} · ${esc(roleLabel(employee))}</option>`).join('')}</optgroup>`).join('')}`;
    if (contextSelect.innerHTML !== options) contextSelect.innerHTML = options;
    contextSelect.value = selection.type === 'office' || selection.type === 'control' ? 'office' : `${selection.type}:${selection.id}`;
    contextSelect.disabled = sending;
    element.querySelector('.sidebar-context-row').hidden = activeTab === 'chat' && ['office', 'control'].includes(selection.type);
    element.querySelectorAll('.sidebar-tab').forEach(tab => { const active = tab.dataset.tab === activeTab; tab.classList.toggle('is-active', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
    element.querySelector('.tab-task-count').textContent = String(scopedTasks().length);
    scroll.setAttribute('aria-labelledby', `office-tab-${activeTab}`);
    const html = activeTab === 'tasks' ? renderActivity() : activeTab === 'connections' ? renderRuntimes() : renderChat();
    // Leave unchanged transcripts in place so polling preserves text selection and disclosures.
    if (scroll.dataset.renderedHtml !== html) {
      if (sameViewport && scroll.dataset.renderedHtml && activeTab === 'chat' && !view.following) view.unseen = true;
      scroll.innerHTML = html;
      scroll.dataset.renderedHtml = html;
      disclosureState.restore(viewportKey(), scroll);
      for (const node of scroll.querySelectorAll('details[data-disclosure]')) { if (node.dataset.disclosure === focusKey) node.querySelector('summary')?.focus({ preventScroll: true }); }
      if (checkedConsent && pendingAction?.endsWith(`:${checkedConsent}`)) {
        const checkbox = [...scroll.querySelectorAll('[data-resume-consent]')].find(node => node.dataset.resumeConsent === checkedConsent);
        if (checkbox) checkbox.checked = true;
        for (const button of scroll.querySelectorAll('[data-task-action="resume-confirm"], [data-task-action="routing-confirm"]')) { if (button.dataset.id === checkedConsent) button.disabled = false; }
      }
    }
    renderedViewport = viewportKey();
    renderComposer();
    applyViewport();
    element.querySelector('[data-sync-note]').textContent = liveData.error ? 'Connection interrupted · draft saved locally' : liveData.updatedAt ? 'Connected to local coordinator' : 'Connecting to local coordinator';
    element.querySelector('.sidebar-sync-dot').classList.toggle('is-offline', Boolean(liveData.error));
    let error = element.querySelector('.sidebar-action-error');
    if (actionError && !error) { error = document.createElement('p'); error.className = 'sidebar-error sidebar-action-error'; error.setAttribute('role','alert'); composerWrap.before(error); }
    if (error) { error.textContent = actionError; error.hidden = !actionError; }
  }

  async function refreshDetails() {
    if (destroyed || detailPending || activeTab === 'connections') return;
    const recent = conversationEntries(state.messages, tasks).filter(message => message.task).slice(-4).map(message => message.task);
    const inspected = [...scroll.querySelectorAll('details[open][data-trace-task]')].map(node => taskById(node.dataset.traceTask)).filter(Boolean);
    // A growing queue must never stop updates for the older task actually running.
    const candidates = activeTab === 'tasks' ? scopedTasks().filter(task => task.id === expandedTask) : [...new Map([...scopedTasks().filter(task => task.inMotion), ...recent, ...inspected].map(task => [taskKey(task), task])).values()];
    const pending = candidates.filter(task => task.runId && task.projectId && (!details.get(taskKey(task)) || task.inMotion || details.get(taskKey(task))?.signature !== JSON.stringify([task.stateKey, task.at, task.entry?.item?.state])));
    if (!pending.length) return;
    detailPending = true;
    await Promise.allSettled(pending.map(async task => {
      const key = taskKey(task);
      const cached = details.get(key) || { events: [], after: 0 };
      const results = await Promise.allSettled([api.status(task.projectId, task.runId), api.eventsPage(task.projectId, task.runId, cached.after || 0)]);
      if (results[0].status === 'fulfilled') {
        cached.status = results[0].value;
        const summaries = (cached.status.artifacts || []).filter(artifact => artifact.type === 'summary');
        cached.summaries ||= {};
        await Promise.allSettled(summaries.filter(artifact => !cached.summaries[artifact.id]).map(async artifact => {
          const result = await api.artifact(task.projectId, task.runId, artifact.id);
          if (typeof result.text === 'string') cached.summaries[artifact.id] = result.text;
        }));
      }
      if (results[1].status === 'fulfilled') {
        const rows = results[1].value.events || [];
        const known = new Set(cached.events.map(event => event.sequence));
        cached.events.push(...rows.filter(event => !known.has(event.sequence)));
        if (rows.length) cached.after = rows.at(-1).sequence;
        cached.hasMore = results[1].value.hasMore;
      }
      cached.error = results.find(result => result.status === 'rejected')?.reason?.message || null;
      cached.signature = cached.error || cached.hasMore ? null : JSON.stringify([task.stateKey, task.at, task.entry?.item?.state]);
      details.set(key, cached);
    }));
    detailPending = false;
    if (!destroyed) render();
  }

  async function runTaskAction(action, id) {
    const task = taskById(id);
    if (!task || pendingAction && !['resume-confirm','routing-confirm','cancel-consent'].includes(action)) return;
    actionError = '';
    if (action === 'cancel-consent') { pendingAction = null; render(); return; }
    if (action === 'routing-consent') { pendingAction = `routing-consent:${task.id}`; render(); return; }
    if (action === 'resume') {
      const current = chatRoute(workspaceDocument(), { projectId: task.projectId, departmentId: task.departmentId });
      if (current.unconfined || task.entry?.item?.allowUnconfinedWrites) { pendingAction = `resume-consent:${task.id}`; render(); return; }
    }
    pendingAction = action;
    render();
    try {
      if (action === 'routing-confirm') {
        const item = task.entry.item;
        const savedMessage = state.messages.find(message => message.requestId === item.id);
        const savedChoice = savedMessage?.controlCenter;
        const previous = consentSubmissions[task.id];
        const controlCenter = consentRetryBinding(item, savedChoice, previous);
        const attachmentIds = consentRetryAttachmentIds(item, savedMessage, previous);
        const clientRequestId = typeof previous === 'string' ? previous : previous?.id || uid();
        consentSubmissions[task.id] = { id: clientRequestId, attachmentIds, ...(controlCenter ? { controlCenter } : {}) }; persist();
        const text = item.task || task.entry?.run?.request?.text || task.title;
        const result = await onAssignTask({ text, projectId: task.projectId, clientRequestId, allowUnconfinedWrites: true, ...(attachmentIds.length ? { attachmentIds } : {}), ...(controlCenter ? { controlCenter } : {}), ...(item.route?.state === 'selected' || item.route?.departmentId ? { consentDepartmentId: item.route.departmentId } : {}) });
        if (!result?.task?.id) throw new Error('The coordinator did not return a receipt. Retrying uses the same request identity.');
        if (!state.messages.some(message => message.requestId === result.task.id)) state.messages.push({ id: clientRequestId, requestId: result.task.id, text, attachments: attachmentDescriptors(result.task.attachments || item.attachments || savedMessage?.attachments), projectId: task.projectId, ...(controlCenter ? { controlCenter } : {}), departmentId: result.task.departmentId || null, at: result.task.receivedAt });
        delete consentSubmissions[task.id]; persist();
      }
      if (action === 'stop') await api.stopRequest(task.requestId || task.entry.item.id);
      if (action === 'start') await api.startHeld(task.requestId || task.entry.item.id);
      if (action === 'discard') await api.discard(task.requestId || task.entry.item.id);
      if (action === 'resume' || action === 'resume-confirm') await api.resume(task.projectId, task.runId, action === 'resume-confirm');
      // Read-only refresh is requested through the shell's live-data event loop.
      window.dispatchEvent(new CustomEvent('workforce-task-changed'));
      await refreshDetails();
    } catch (error) { actionError = error.message || 'The task action failed.'; }
    finally { pendingAction = null; render(); }
  }

  function select(next = { type: 'office' }) {
    if (sending) return;
    if (next.type === 'employee' && !employeeById(next.id) || next.type === 'department' && !departmentById(next.id)) return;
    if (next.type === selection.type && next.id === selection.id) return;
    rememberViewport();
    persist();
    selection = { type: next.type || 'office', ...(next.id ? { id: next.id } : {}) };
    render(); reveal(); void refreshDetails();
  }
  function showTab(tab) {
    tab = ({activity:'tasks',runtimes:'connections'})[tab] || tab;
    if (!['chat','tasks','connections'].includes(tab)) return;
    rememberViewport();
    activeTab = tab; render(); reveal(); void refreshDetails();
  }
  function showRuntime(runtimeId) { if (!runtimeById(runtimeId)) return; expandedRuntime = runtimeId; showTab('connections'); }
  function showTask(id) {
    const task = taskById(id);
    if (!task) return false;
    focusedChatTask = task.id;
    showTab('chat');
    const turn = [...scroll.querySelectorAll('.chat-turn')].find(node => node.dataset.requestId === (task.requestId || task.entry?.item?.id || task.id));
    if (!turn) return false;
    const trace = turn.querySelector('details.chat-trace');
    if (trace) trace.open = true;
    disclosureState.remember(viewportKey(), scroll);
    const view = viewportState();
    view.following = false; view.unseen = false;
    view.top = Math.max(0, scroll.scrollTop + turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12);
    applyViewport();
    void refreshDetails();
    return true;
  }
  function refresh() {
    if (destroyed) return;
    tasks = [...(liveData.tasks || [])];
    loadPersistence();
    if (selection.type === 'employee' && !employeeById(selection.id) || selection.type === 'department' && !departmentById(selection.id)) { persist(); selection = { type: 'office' }; }
    render(); void refreshDetails();
  }
  contextSelect.addEventListener('change', () => { const [type, ...id] = contextSelect.value.split(':'); const next = { type, ...(id.length ? { id: id.join(':') } : {}) }; select(next); onFocus(next); });
  // Native disclosure toggles do not bubble. Expanding old history fetches that run on demand.
  scroll.addEventListener('toggle', event => {
    if (!event.target.matches('details[data-disclosure]')) return;
    disclosureState.remember(viewportKey(), scroll);
    if (event.target.open && event.target.dataset.traceTask) void refreshDetails();
  }, true);
  scroll.addEventListener('click', event => {
    // Native summary activation includes keyboard Enter/Space; restoring .open must not change follow mode.
    if (activeTab !== 'chat' || !event.target.closest('summary')) return;
    const view = viewportState(); view.following = false; view.top = scroll.scrollTop; updateJumpControl();
  });
  element.addEventListener('change', event => { if (event.target.matches('[data-resume-consent]')) { const button = [...element.querySelectorAll('[data-task-action="resume-confirm"], [data-task-action="routing-confirm"]')].find(node => node.dataset.id === event.target.dataset.resumeConsent); if (button) button.disabled = !event.target.checked; } });
  element.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    if (button.hasAttribute('data-jump-latest')) jumpToLatest();
    else if (button.hasAttribute('data-add-attachment') && !button.disabled) composerWrap.querySelector('[name=attachments]').click();
    else if (button.hasAttribute('data-remove-attachment')) removeAttachment(button.dataset.removeAttachment);
    else if (button.hasAttribute('data-retry-attachment')) retryAttachment(button.dataset.retryAttachment);
    else if (button.hasAttribute('data-refresh-models')) { ensureModels(true); renderComposer(); }
    else if (button.hasAttribute('data-manage-agents')) onManageAgents();
    else if (button.hasAttribute('data-manage-runtimes')) onManageRuntimes();
    else if (button.hasAttribute('data-recheck-runtimes') && !runtimeChecking) {
      runtimeChecking = true; actionError = ''; render();
      api.workspace(true).then(document => {
        liveData.workspaceDoc = document; liveData.workspaceDocument = document;
        liveData.reports = document.runtimes?.reports || [];
        window.dispatchEvent(new CustomEvent('workforce-task-changed'));
      }).catch(error => { actionError = error.message || 'Could not recheck runtimes.'; }).finally(() => { runtimeChecking = false; render(); });
    }
    else if (button.hasAttribute('data-add-project')) onAddProject();
    else if (button.hasAttribute('data-add-department')) onAddDepartment();
    else if (button.hasAttribute('data-add-agent')) onAddAgent(button.dataset.addAgent || selectedDepartment());
    else if (button.hasAttribute('data-edit-agent')) onEditAgent(button.dataset.editAgent);
    else if (button.hasAttribute('data-remove-agent')) onRemoveAgent?.(button.dataset.removeAgent);
    else if (button.dataset.tab) showTab(button.dataset.tab);
    else if (button.dataset.showTab) showTab(button.dataset.showTab);
    else if (button.classList.contains('context-focus')) onFocus(selection);
    else if (button.dataset.taskAction) void runTaskAction(button.dataset.taskAction, button.dataset.id);
    else if (button.dataset.openTask) { const task = taskById(button.dataset.openTask); if (task) onOpenTask(task); }
    else if (button.dataset.taskFilter) { taskFilter = button.dataset.taskFilter; render(); }
    else if (button.dataset.task) { expandedTask = expandedTask === button.dataset.task ? null : button.dataset.task; render(); void refreshDetails(); }
    else if (button.hasAttribute('data-runtime')) { expandedRuntime = expandedRuntime === button.dataset.runtime ? null : button.dataset.runtime; render(); }
    else if (button.dataset.focus) { const next = { type: button.dataset.focus, id: button.dataset.id }; select(next); onFocus(next); }
  });
  element.querySelector('.sidebar-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const tabs = ['chat','tasks','connections']; const index = tabs.indexOf(activeTab);
    showTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3]);
    element.querySelector(`[data-tab="${activeTab}"]`).focus({ preventScroll: true });
  });
  const interval = setInterval(() => { void refreshDetails(); }, 3000);
  render();
  return { select, showTab, showRuntime, showTask, reveal, refresh, updateData(next = {}) { liveData = { ...liveData, ...next }; refresh(); }, addActivity() {}, destroy() { persist(); destroyed = true; clearInterval(interval); resizeObserver?.disconnect(); if (revealFrame !== null) cancelAnimationFrame(revealFrame); element.replaceChildren(); } };
}
