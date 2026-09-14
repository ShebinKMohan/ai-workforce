import { avatar } from './ui.js';
import { requestTaskStatus, taskWorkStatus } from './task-status.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const asArray = value => Array.isArray(value) ? value : [];
const idOf = value => String(typeof value === 'object' && value !== null ? value.id ?? '' : value ?? '');
const palette = [['#e5dfce', '#747e61', '#d4a37b', '#433e34'], ['#dce6e7', '#536f8c', '#d9ac86', '#393a40'], ['#e9dce8', '#82617e', '#ba805c', '#403033'], ['#efdfce', '#af7651', '#e7bb91', '#5a4638'], ['#dce6dd', '#647e70', '#a97550', '#303e36'], ['#e0e4ef', '#767391', '#ddb395', '#4d4038']];
const hash = value => [...String(value)].reduce((total, character) => total + character.charCodeAt(0), 0);
const icons = {
  office: 'M3 21V7h8v14M11 3h10v18M6 11h2M6 15h2M15 7h2M15 11h2M15 15h2M2 21h20',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1',
  arrow: 'M4 12h16m-5-5 5 5-5 5',
  file: 'M13 3H5v18h14V9Zm0 0v6h6M8 13h8M8 17h5',
  chevron: 'm9 5 7 7-7 7',
  empty: 'M4 7h16v13H4ZM8 7V4h8v3M9 12h6',
  focus: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 12h8M12 8v8',
  canvas: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', fit: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  location: 'M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12ZM15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  down: 'm7 10 5 5 5-5', hand: 'M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-3l2 3',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.file}"/></svg>`;
let lastController = null;
let viewMode = 'workspace';
const animatedEventKeys = new Set();

function recordAgentId(record) { return idOf(record?.agentId ?? record?.ownerAgentId ?? record?.employeeId ?? record?.ownerId ?? record?.agent); }
function recordDepartmentId(record) { return idOf(record?.departmentId ?? record?.department ?? record?.route?.departmentId); }
function recordTime(record) { return new Date(record?.updatedAt ?? record?.lastEvent?.timestamp ?? record?.receivedAt ?? record?.createdAt ?? record?.at ?? 0).getTime() || 0; }
const runKey = (projectId, runId) => `${idOf(projectId)}:${idOf(runId)}`;
const emptyCounts = () => ({ progress: 0, backlog: 0, waiting: 0, done: 0, closed: 0 });
const statePriority = { waiting: 4, progress: 3, backlog: 2, done: 1, closed: 0 };

/** Count durable tasks, with pending briefs only until a run has actual task rows. */
export function deriveOverviewWorkload({ departments = [], agents = [], requests = [], runs = [] } = {}) {
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
      const status = taskWorkStatus(task, run);
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
    if (review?.state === 'running' && review.headAgentId) {
      const id = idOf(review.headAgentId), prior = agentStates.get(id);
      if (!prior || statePriority[prior.bucket] < statePriority.progress) agentStates.set(id, { bucket: 'progress', label: 'Reviewing', tone: 'running' });
    }
  }
  const activeOwners = new Set(items.filter(item => item.bucket === 'progress').map(item => item.ownerId).filter(Boolean));
  for (const run of runMap.values()) if (run.headReview?.state === 'running' && run.headReview.headAgentId) activeOwners.add(idOf(run.headReview.headAgentId));
  const activeAgentIds = agentList.filter(agent => activeOwners.has(idOf(agent.id))).map(agent => idOf(agent.id));
  const byDepartment = new Map(asArray(departments).filter(department => !department.archived).map(department => {
    const id = idOf(department.id), departmentItems = items.filter(item => item.departmentId === id), departmentCounts = emptyCounts();
    departmentItems.forEach(item => { departmentCounts[item.bucket]++; });
    const activeAgents = activeAgentIds.filter(agentId => recordDepartmentId(agentList.find(agent => idOf(agent.id) === agentId)) === id);
    return [id, { items: departmentItems, counts: departmentCounts, activeAgentIds: activeAgents, tasks: departmentItems.filter(item => item.kind === 'task').length, briefs: departmentItems.filter(item => item.kind === 'brief').length }];
  }));
  return { items, counts, byDepartment, agentStates, activeAgentIds, loadedRuns: runMap.size, tasks: items.filter(item => item.kind === 'task').length, completedTasks: items.filter(item => item.kind === 'task' && item.bucket === 'done').length, unplannedBriefs: items.filter(item => item.kind === 'brief').length };
}

function currentAgentStatus(agent, workload) {
  const recorded = workload.agentStates.get(idOf(agent.id));
  return recorded && ['progress', 'backlog', 'waiting'].includes(recorded.bucket) ? recorded : { tone: 'idle', label: 'No active work' };
}

function departmentRoster(department, agents) {
  const isConfigured = agent => !!idOf(agent?.id) && !agent.isVacant && !agent.archived;
  const ids = new Set(asArray(department.members).map(idOf).filter(Boolean));
  const roster = agents.filter(agent => isConfigured(agent) && (recordDepartmentId(agent) === idOf(department.id) || ids.has(idOf(agent.id))));
  const declaredLead = typeof department.lead === 'object' ? department.lead : agents.find(agent => idOf(agent.id) === idOf(department.lead ?? department.headAgentId));
  let lead = isConfigured(declaredLead) ? declaredLead : null;
  lead ||= roster.find(agent => agent.isHead || agent.kind === 'department_head');
  const members = roster.filter(agent => idOf(agent.id) !== idOf(lead?.id));
  return { lead, people: [...(lead ? [lead] : []), ...members] };
}

function arrangeOffice(departments, agents) {
  const columns = departments.length <= 3 ? Math.max(1, departments.length) : 2;
  const slotWidth = columns === 3 ? 380 : 460;
  const width = Math.max(840, columns * slotWidth + 110);
  const rows = [];
  const clusters = departments.map((department, index) => {
    const roster = departmentRoster(department, agents);
    const people = roster.people;
    const seats = people.map((person, seat) => {
      if (people.length === 1) return { person, x: 175, y: 181, lead: !!roster.lead };
      if (people.length === 2) return { person, x: seat ? 268 : 92, y: 193 + (seat ? 26 : 0), lead: seat === 0 && !!roster.lead };
      if (seat === 0 && roster.lead) return { person, x: 175, y: 205, lead: true };
      const offset = roster.lead ? seat - 1 : seat;
      const count = people.length - (roster.lead ? 1 : 0);
      const rowColumns = count === 4 ? 2 : count <= 3 ? count : 3;
      const spacing = rowColumns === 2 ? 158 : 116;
      return { person, x: 175 + ((offset % rowColumns) - (rowColumns - 1) / 2) * spacing, y: (roster.lead ? 371 : 184) + Math.floor(offset / rowColumns) * 166, lead: false };
    });
    const height = Math.max(310, ...seats.map(seat => seat.y + 98));
    const row = Math.floor(index / columns);
    rows[row] = Math.max(rows[row] || 0, height);
    return { department, seats, height, index, row };
  });
  let bottom = 275;
  const rowOffsets = rows.map(height => { const top = bottom; bottom += height + 80; return top; });
  clusters.forEach(cluster => {
    const inRow = Math.min(columns, departments.length - cluster.row * columns);
    const rowStart = (width - (inRow - 1) * slotWidth) / 2;
    cluster.x = rowStart + (cluster.index % columns) * slotWidth - 175;
    cluster.y = rowOffsets[cluster.row] + (columns === 3 && cluster.index % columns === 1 ? 35 : 0);
  });
  return { width, height: Math.max(700, bottom + 5), clusters };
}

function officeDesk() {
  return `<svg class="office-desk" viewBox="0 0 128 55" fill="none" aria-hidden="true"><ellipse cx="64" cy="46" rx="54" ry="7" fill="currentColor" opacity=".07"/><path d="m11 29 61-14 47 15-58 17Z" fill="var(--office-desk-top)"/><path d="m11 29 50 18v4L11 33Z" fill="var(--office-desk-front)"/><path d="m61 47 58-17v4L61 51Z" fill="var(--office-desk-side)"/><path d="m82 8 21 5v16l-21-6Z" fill="var(--office-monitor-frame)"/><path d="m84 11 17 4v10l-17-4Z" fill="var(--office-monitor-screen)"/><path d="m91 27 1 5-6 2 14 3 6-2-11-3v-4" fill="var(--office-monitor-frame)"/><path d="m22 29 17-4 12 4-17 5Z" fill="var(--paper)" opacity=".85"/></svg>`;
}

function officePerson(seat, workload) {
  const { person, x, y, lead } = seat;
  const status = currentAgentStatus(person, workload);
  return `<button type="button" class="office-person ${lead ? 'is-lead' : ''}" data-lo-action="agent" data-lo-id="${escape(person.id)}" data-lo-node="agent:${escape(person.id)}" data-lo-name="${escape(person.name)}" data-office-tone="${status.tone}" style="left:${x}px;top:${y}px" aria-label="${escape(`${person.name}, ${lead ? 'department head' : person.role || 'agent'}, ${status.label}`)}" title="${escape(`${person.name} · ${status.label}`)}"><span class="office-seat-shadow"></span><span class="office-avatar">${avatar(person.name || person.id, lead ? 76 : 68)}</span>${officeDesk()}<span class="office-person-label"><strong>${escape(person.name || person.id)}</strong><span><i class="office-led" data-tone="${status.tone}"></i>${escape(lead ? 'Department head' : person.role || 'Agent')}</span></span>${lead ? '<span class="office-lead-pin" aria-hidden="true"></span>' : ''}</button>`;
}

function workloadButton(department, workload, filter, label, className = 'office-stat') {
  const items = workload.byDepartment.get(idOf(department.id))?.items.filter(item => filter === 'all' || item.bucket === filter) || [];
  return `<button type="button" class="${className}" data-lo-action="workload" data-lo-id="${escape(department.id)}" data-lo-filter="${filter}" data-lo-task-ids="${escape(JSON.stringify(items.filter(item => item.taskId).map(item => item.taskId)))}" data-lo-request-ids="${escape(JSON.stringify([...new Set(items.flatMap(item => item.requestIds))]))}" aria-label="${escape(`${department.name}: ${items.length} ${label.toLowerCase()}`)}" title="${escape(filter === 'done' ? 'Accepted task records in the loaded history.' : 'Recorded tasks, or unplanned briefs until a run has task records. Each is counted once.')}" data-bucket="${filter}"><span>${label}</span><strong data-lo-count="${filter}">${items.length}</strong></button>`;
}

function officeCluster(cluster, workload) {
  const { department, seats, x, y, height } = cluster;
  const info = workload.byDepartment.get(idOf(department.id));
  const color = /^#[\da-f]{3,8}$/i.test(department.color || '') ? department.color : palette[hash(department.id) % palette.length][1];
  return `<section class="office-cluster" data-lo-department="${escape(department.id)}" data-office-height="${height}" style="left:${x}px;top:${y}px;width:350px;height:${height}px;--office-team-color:${color}" aria-label="${escape(department.name)} team workspace"><div class="office-floor" aria-hidden="true"></div><div class="office-floor-label" aria-hidden="true">${escape(department.name)}</div><div class="office-summary" data-lo-node="department:${escape(department.id)}" data-lo-name="${escape(department.name)}"><div class="office-summary-heading"><button type="button" data-lo-action="department" data-lo-id="${escape(department.id)}"><i class="office-team-dot"></i><strong>${escape(department.name)}</strong><span class="office-agent-count">${seats.length} agent${seats.length === 1 ? '' : 's'}</span></button><button type="button" class="office-focus-button" data-lo-action="focus-department" data-lo-id="${escape(department.id)}" aria-label="Focus on ${escape(department.name)}">${icon('focus')}</button></div><div class="office-summary-stats">${workloadButton(department, workload, 'progress', 'Doing')}${workloadButton(department, workload, 'backlog', 'Next')}${workloadButton(department, workload, 'done', 'Done')}</div>${info?.counts.waiting ? workloadButton(department, workload, 'waiting', 'Waiting', 'office-waiting') : ''}</div><div class="office-workstations">${seats.length ? seats.map(seat => officePerson(seat, workload)).join('') : '<p class="office-no-agents">No agents configured yet.</p>'}</div><svg class="office-plant" viewBox="0 0 50 76" fill="none" aria-hidden="true"><ellipse cx="25" cy="68" rx="18" ry="5" fill="currentColor" opacity=".07"/><path d="M15 51h21l-3 15q-8 5-15 0Z" fill="var(--office-planter)"/><path d="M25 53V26m0 12c-21-2-22-24-11-16l11 14c-2-37 19-31 13-11L27 45c27-19 27 3 0 6" stroke="var(--office-leaf)" stroke-width="6" stroke-linecap="round"/><path d="M24 43c-16 0-17-12-10-8l10 8" stroke="var(--office-leaf)" stroke-width="6" stroke-linecap="round"/></svg></section>`;
}

/** A real organization scene. No agents, work, or motion events are synthesized. */
export function renderOverview({ departments = [], agents = [], controlCenter = {}, requests = [], runs = [], events = [] } = {}) {
  const activeDepartments = asArray(departments).filter(department => !department.archived);
  const activeAgents = asArray(agents).filter(agent => !agent.archived);
  const workload = deriveOverviewWorkload({ departments: activeDepartments, agents: activeAgents, requests, runs });
  const layout = arrangeOffice(activeDepartments, activeAgents);
  const controlId = idOf(controlCenter.id) || 'control';
  const controlName = controlCenter.name || 'Control Center';
  const controlRequest = asArray(requests).find(request => !request.runId && ['progress', 'backlog'].includes(requestTaskStatus(request).bucket));
  const controlState = controlRequest ? requestTaskStatus(controlRequest) : { tone: 'idle', label: 'Ready for your next idea' };
  return `<section class="live-overview office-canvas" data-lo-root data-lo-mode="${viewMode}" aria-label="Interactive company office"><header class="office-toolbar"><div class="office-title"><h1>Your office</h1><span>${activeDepartments.length} team${activeDepartments.length === 1 ? '' : 's'}<i></i>${activeAgents.length} agents</span></div><div class="office-toolbar-actions"><label class="office-jump">${icon('location')}<select data-office-jump aria-label="Jump to a department"><option value="">Explore a team</option><option value="__all__">Whole office</option><option value="__control__">${escape(controlName)}</option>${activeDepartments.map(department => `<option value="${escape(department.id)}">${escape(department.name)}</option>`).join('')}</select>${icon('down')}</label><div class="office-view-toggle" role="group" aria-label="Office view"><button type="button" data-lo-action="view" data-lo-mode="workspace" aria-pressed="${viewMode === 'workspace'}">${icon('canvas')}Canvas</button><button type="button" data-lo-action="view" data-lo-mode="list" aria-pressed="${viewMode === 'list'}">${icon('list')}List</button></div><button type="button" class="office-new-task" data-chat-open>${icon('plus')}New task</button></div></header><div class="office-viewport" tabindex="0" role="region" aria-label="Office canvas. Drag to pan. Use plus or minus to zoom, zero to fit, and arrow keys to pan."><div class="office-world" data-office-width="${layout.width}" data-office-height="${layout.height}" style="width:${layout.width}px;height:${layout.height}px"><svg class="office-connections" aria-hidden="true"></svg><span class="office-message-entry" data-lo-node="user:user" data-lo-name="You" style="left:${layout.width / 2}px;top:28px">${icon('file')}Your next idea</span><button type="button" class="office-hub" data-lo-action="control" data-lo-id="${escape(controlId)}" data-lo-node="control:${escape(controlId)}" data-lo-name="${escape(controlName)}" style="left:${layout.width / 2}px;top:103px"><span class="office-hub-mark"><img src="./assets/atlas-mark.svg" alt=""></span><span><strong>${escape(controlName)}</strong><small><i class="office-led" data-tone="${controlState.tone}"></i>${escape(controlState.label)}</small></span>${icon('arrow')}</button>${layout.clusters.map(cluster => officeCluster(cluster, workload)).join('')}${!layout.clusters.length ? `<div class="office-empty" style="left:${layout.width / 2}px;top:360px">${icon('office')}<h3>Room for your next team.</h3><p>Add a department and its agents to bring your office to life.</p></div>` : ''}<div class="office-packets" aria-hidden="true"></div></div></div><div class="office-bottom-bar"><span class="office-pan-hint">${icon('hand')}Drag to explore<span>Ctrl + scroll to zoom</span></span><span class="office-history" title="Task counts cover the loaded runtime history, not lifetime totals.">${workload.activeAgentIds.length} active agents<i></i>${workload.completedTasks} tasks done<span>${workload.loadedRuns} loaded runs</span></span><div class="office-zoom-controls" role="group" aria-label="Canvas zoom"><button type="button" data-lo-action="zoom-out" aria-label="Zoom out">${icon('minus')}</button><button type="button" data-lo-action="zoom-reset" class="office-zoom-value" aria-label="Set canvas zoom to 100 percent">100%</button><button type="button" data-lo-action="zoom-in" aria-label="Zoom in">${icon('plus')}</button><span></span><button type="button" data-lo-action="fit" aria-label="Fit whole office" title="Fit whole office">${icon('fit')}</button></div></div><span class="office-announcement" role="status" aria-live="polite" aria-atomic="true"></span></section>`;
}

function eventKey(event) { return String(event.id ?? event.eventId ?? `${event.type || ''}:${event.requestId || ''}:${event.at || event.timestamp || ''}:${event.label || event.message || ''}`); }
function nodeKey(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || !endpoint.kind) return null;
  const kind = ['controlCenter', 'control_center'].includes(endpoint.kind) ? 'control' : endpoint.kind;
  return ['user', 'control', 'department', 'agent'].includes(kind) ? `${kind}:${idOf(endpoint.id) || (kind === 'control' ? 'control' : kind === 'user' ? 'user' : '')}` : null;
}
function domKey(node) {
  if (node.nodeType !== 1) return null;
  const data = node.dataset;
  if (data.loDepartment) return `department:${data.loDepartment}`;
  if (data.loNode) return `node:${data.loNode}`;
  if (data.loAction) return `action:${data.loAction}:${data.loId || ''}:${data.loFilter || data.loMode || ''}`;
  return null;
}
function patchOverviewNode(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); return; }
  if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
  if (current.nodeType !== 1 || current.isEqualNode(next)) return;
  if (current.matches('.office-packets,.office-connections,.office-announcement')) return;
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name) && !['data-office-selected','data-office-detail'].includes(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  const previous = [...current.childNodes], keyed = new Map(previous.map(node => [domKey(node), node]).filter(([key]) => key)), used = new Set();
  let cursor = current.firstChild;
  for (const child of [...next.childNodes]) {
    const key = domKey(child);
    let match = key ? keyed.get(key) : cursor && !domKey(cursor) && cursor.nodeType === child.nodeType && cursor.nodeName === child.nodeName ? cursor : null;
    if (match && used.has(match)) match = null;
    if (!match) { match = child.cloneNode(true); current.insertBefore(match, cursor); }
    else { if (match !== cursor) current.insertBefore(match, cursor); patchOverviewNode(match, child); }
    used.add(match); cursor = match.nextSibling;
  }
  for (const child of previous) if (!used.has(child) && child.parentNode === current) child.remove();
}

export function wireOverview(element, { onDepartment, onAgent, onRequest, onControlCenter, onDepartmentWorkload } = {}) {
  const root = element?.matches?.('[data-lo-root]') ? element : element?.querySelector?.('[data-lo-root]');
  if (!root) return { animateEvent: () => false, update: () => false, refreshConnections() {}, fit() {}, zoomBy() {}, focusDepartment() {}, focusAgent() {}, getCamera: () => null, destroy() {} };
  if (lastController && !lastController.root.isConnected) lastController.destroy();
  const viewport = root.querySelector('.office-viewport'), world = root.querySelector('.office-world'), svg = root.querySelector('.office-connections'), packets = root.querySelector('.office-packets');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'), abort = new AbortController(), animations = new Set(), pointers = new Map();
  const camera = { x: 0, y: 0, zoom: 1 }, minimumZoom = .28, maximumZoom = 1.8;
  let frame = null, destroyed = false, initialized = false, fitted = true, suppressClickUntil = 0, drag = null, pinch = null, selectedAgent = null;
  const findNode = key => [...world.querySelectorAll('[data-lo-node]')].find(node => node.dataset.loNode === key) || (key?.startsWith('control:') ? world.querySelector('.office-hub') : key?.startsWith('user:') ? world.querySelector('.office-message-entry') : null);
  const dimensions = () => ({ width: Number(world.dataset.officeWidth), height: Number(world.dataset.officeHeight), viewportWidth: viewport.clientWidth, viewportHeight: viewport.clientHeight });
  function applyCamera() {
    world.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;
    world.style.setProperty('--office-detail-scale', String(Math.min(1.34, Math.max(1, .82 / camera.zoom))));
    world.style.setProperty('--office-summary-scale', String(Math.min(1.8, Math.max(1, .8 / camera.zoom))));
    root.dataset.officeDetail = camera.zoom < .5 ? 'overview' : 'full';
    root.querySelector('.office-zoom-value').textContent = `${Math.round(camera.zoom * 100)}%`;
    root.querySelector('[data-lo-action="zoom-in"]').disabled = camera.zoom >= maximumZoom - .01;
    root.querySelector('[data-lo-action="zoom-out"]').disabled = camera.zoom <= minimumZoom + .01;
    viewport.style.setProperty('--office-grid-size', `${24 * camera.zoom}px`);
    viewport.style.setProperty('--office-grid-x', `${camera.x}px`);
    viewport.style.setProperty('--office-grid-y', `${camera.y}px`);
  }
  function zoomTo(value, point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
    const zoom = Math.max(minimumZoom, Math.min(maximumZoom, value));
    const worldX = (point.x - camera.x) / camera.zoom, worldY = (point.y - camera.y) / camera.zoom;
    camera.x = point.x - worldX * zoom; camera.y = point.y - worldY * zoom; camera.zoom = zoom; fitted = false;
    applyCamera(); scheduleConnections();
  }
  function fit() {
    const size = dimensions(); if (!size.viewportWidth || !size.viewportHeight) return;
    camera.zoom = Math.max(minimumZoom, Math.min(1.08, (size.viewportWidth - 48) / size.width, (size.viewportHeight - 34) / size.height));
    camera.x = (size.viewportWidth - size.width * camera.zoom) / 2; camera.y = (size.viewportHeight - size.height * camera.zoom) / 2; fitted = true;
    root.querySelector('[data-office-jump]').value = '__all__'; applyCamera(); scheduleConnections();
  }
  function focusDepartment(id) {
    if (id === '__control__') {
      camera.zoom = Math.min(1.1, (viewport.clientWidth - 45) / 330);
      camera.x = viewport.clientWidth / 2 - Number(world.dataset.officeWidth) / 2 * camera.zoom; camera.y = viewport.clientHeight / 2 - 110 * camera.zoom;
    } else {
      const cluster = [...world.querySelectorAll('[data-lo-department]')].find(node => node.dataset.loDepartment === id);
      if (!cluster) return false;
      const height = Number(cluster.dataset.officeHeight), x = parseFloat(cluster.style.left), y = parseFloat(cluster.style.top);
      camera.zoom = Math.max(minimumZoom, Math.min(1.15, (viewport.clientWidth - 45) / 385, (viewport.clientHeight - 45) / (height + 85)));
      camera.x = viewport.clientWidth / 2 - (x + 175) * camera.zoom; camera.y = viewport.clientHeight / 2 - (y + height / 2 - 10) * camera.zoom;
    }
    fitted = false; root.querySelector('[data-office-jump]').value = id; applyCamera(); scheduleConnections(); return true;
  }
  function focusAgent(id) {
    const node = findNode(`agent:${id}`), cluster = node?.closest('[data-lo-department]');
    if (!node || !cluster) return false;
    if (viewMode !== 'workspace') setMode('workspace');
    selectedAgent = id;
    world.querySelectorAll('.office-person').forEach(person => person.dataset.officeSelected = String(person.dataset.loId === id));
    const x = parseFloat(cluster.style.left) + parseFloat(node.style.left), y = parseFloat(cluster.style.top) + parseFloat(node.style.top);
    camera.zoom = Math.min(1.25, Math.max(.98, camera.zoom));
    camera.x = viewport.clientWidth * (viewport.clientWidth > 750 ? .4 : .5) - x * camera.zoom;
    camera.y = viewport.clientHeight * .46 - y * camera.zoom;
    fitted = false; root.querySelector('[data-office-jump]').value = cluster.dataset.loDepartment;
    applyCamera(); scheduleConnections(); return true;
  }
  function setMode(mode) {
    viewMode = mode; root.dataset.loMode = mode;
    root.querySelectorAll('[data-lo-action="view"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.loMode === mode)));
    animations.forEach(animation => animation.cancel());
    if (mode === 'workspace') { applyCamera(); scheduleConnections(); }
  }
  function point(node, edge = 'center') {
    const box = node.getBoundingClientRect(), origin = world.getBoundingClientRect();
    return { x: (box.left - origin.left + box.width / 2) / camera.zoom, y: (box.top - origin.top + (edge === 'bottom' ? box.height : edge === 'top' ? 0 : box.height / 2)) / camera.zoom };
  }
  function refreshConnections() {
    if (destroyed || !root.isConnected || viewMode === 'list') return;
    const { width, height } = dimensions(); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const start = point(world.querySelector('.office-hub'), 'bottom');
    svg.innerHTML = [...world.querySelectorAll('.office-summary')].map(node => {
      const end = point(node, 'top'), difference = Math.abs(end.x - start.x), bend = Math.min(120, Math.max(55, difference * .3));
      return `<path d="M${start.x} ${start.y} C${start.x} ${start.y + bend},${end.x} ${end.y - bend},${end.x} ${end.y}"/>`;
    }).join('');
  }
  function scheduleConnections() { if (frame) cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = null; refreshConnections(); }); }
  function receiveEvent(event) {
    if (destroyed || !root.isConnected || !event || typeof event !== 'object') return false;
    const key = eventKey(event); if (animatedEventKeys.has(key)) return false;
    animatedEventKeys.add(key); if (animatedEventKeys.size > 400) animatedEventKeys.delete(animatedEventKeys.values().next().value);
    root.querySelector('.office-announcement').textContent = String(event.label || event.message || event.type || 'Runtime event');
    const source = findNode(nodeKey(event.from)), target = findNode(nodeKey(event.to));
    if (!source || !target || source === target || reducedMotion.matches || viewMode === 'list' || document.hidden || animations.size >= 4) return true;
    const from = point(source), to = point(target), packet = document.createElement('span');
    packet.className = 'office-packet'; packet.innerHTML = icon('file'); packets.append(packet);
    const controlX = (from.x + to.x) / 2, controlY = Math.min(from.y, to.y) - Math.min(65, Math.abs(to.x - from.x) * .15);
    const frames = Array.from({ length: 13 }, (_, index) => { const t = index / 12, x = (1-t)**2*from.x + 2*(1-t)*t*controlX + t*t*to.x, y = (1-t)**2*from.y + 2*(1-t)*t*controlY + t*t*to.y; return { transform: `translate(${x - 13}px,${y - 14}px)`, opacity: t === 0 || t === 1 ? 0 : 1, offset: t }; });
    const animation = packet.animate(frames, { duration: 620, easing: 'cubic-bezier(.22,.68,.3,1)', fill: 'both' }); animations.add(animation);
    const cleanup = () => { animations.delete(animation); packet.remove(); }; animation.finished.then(cleanup, cleanup); return true;
  }
  root.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
    const button = event.target.closest('[data-lo-action]'); if (!button || !root.contains(button)) return;
    const { loAction: action, loId: id } = button.dataset;
    if (action === 'department') { focusDepartment(id); onDepartment?.(id); }
    if (action === 'focus-department') focusDepartment(id);
    if (action === 'agent') { focusAgent(id); onAgent?.(id); }
    if (action === 'request') onRequest?.(id);
    if (action === 'control') onControlCenter?.(id);
    if (action === 'workload') { const selection = { departmentId: id, filter: button.dataset.loFilter || 'all', taskIds: JSON.parse(button.dataset.loTaskIds || '[]'), requestIds: JSON.parse(button.dataset.loRequestIds || '[]') }; if (onDepartmentWorkload) onDepartmentWorkload(selection); else onDepartment?.(id); root.dispatchEvent(new CustomEvent('workforce:department-workload', { detail: selection, bubbles: true })); }
    if (action === 'view') setMode(button.dataset.loMode);
    if (action === 'zoom-in') zoomTo(camera.zoom * 1.2);
    if (action === 'zoom-out') zoomTo(camera.zoom / 1.2);
    if (action === 'zoom-reset') zoomTo(1);
    if (action === 'fit') fit();
  }, { signal: abort.signal });
  root.addEventListener('pointerdown', () => { suppressClickUntil = 0; }, { capture: true, signal: abort.signal });
  root.querySelector('[data-office-jump]').addEventListener('change', event => { const value = event.target.value; if (viewMode !== 'workspace') setMode('workspace'); if (value === '__all__') fit(); else if (value) focusDepartment(value); }, { signal: abort.signal });
  viewport.addEventListener('wheel', event => {
    if (viewMode !== 'workspace') return; event.preventDefault();
    const bounds = viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) zoomTo(camera.zoom * Math.exp(-event.deltaY * .006), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    else { camera.x -= event.deltaX; camera.y -= event.deltaY; fitted = false; applyCamera(); }
  }, { passive: false, signal: abort.signal });
  viewport.addEventListener('pointerdown', event => {
    if (viewMode !== 'workspace' || event.button > 0 || (event.pointerType !== 'touch' && event.target.closest('button,select'))) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); viewport.setPointerCapture(event.pointerId);
    if (pointers.size === 1) drag = { x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false };
    if (pointers.size === 2) { const [a,b] = [...pointers.values()], bounds = viewport.getBoundingClientRect(), mid = { x: (a.x+b.x)/2 - bounds.left, y: (a.y+b.y)/2 - bounds.top }; pinch = { distance: Math.hypot(a.x-b.x,a.y-b.y), zoom: camera.zoom, worldX: (mid.x-camera.x)/camera.zoom, worldY: (mid.y-camera.y)/camera.zoom }; drag = null; }
  }, { signal: abort.signal });
  viewport.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) { const [a,b] = [...pointers.values()], bounds = viewport.getBoundingClientRect(), zoom = Math.max(minimumZoom, Math.min(maximumZoom, pinch.zoom * Math.hypot(a.x-b.x,a.y-b.y) / Math.max(1,pinch.distance))); camera.zoom = zoom; camera.x = (a.x+b.x)/2 - bounds.left - pinch.worldX*zoom; camera.y = (a.y+b.y)/2 - bounds.top - pinch.worldY*zoom; suppressClickUntil = performance.now()+300; }
    else if (drag) { const dx = event.clientX-drag.x, dy = event.clientY-drag.y; if (Math.hypot(dx,dy)>4) { drag.moved=true; viewport.classList.add('is-panning'); camera.x=drag.cameraX+dx; camera.y=drag.cameraY+dy; suppressClickUntil=performance.now()+300; } }
    fitted=false; applyCamera();
  }, { signal: abort.signal });
  function pointerEnd(event) { const moved=drag?.moved||!!pinch; pointers.delete(event.pointerId); if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId); if(moved)suppressClickUntil=performance.now()+300; if(!pointers.size){drag=null;pinch=null;viewport.classList.remove('is-panning');}else{const point=[...pointers.values()][0];drag={x:point.x,y:point.y,cameraX:camera.x,cameraY:camera.y,moved:true};pinch=null;} }
  viewport.addEventListener('pointerup',pointerEnd,{signal:abort.signal}); viewport.addEventListener('pointercancel',pointerEnd,{signal:abort.signal});
  viewport.addEventListener('keydown', event => {
    if(viewMode!=='workspace'||event.target!==viewport)return;
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','0'].includes(event.key))event.preventDefault();else return;
    if(event.key==='0')fit();else if(event.key==='+'||event.key==='=')zoomTo(camera.zoom*1.2);else if(event.key==='-')zoomTo(camera.zoom/1.2);else{camera.x+=event.key==='ArrowLeft'?55:event.key==='ArrowRight'?-55:0;camera.y+=event.key==='ArrowUp'?55:event.key==='ArrowDown'?-55:0;fitted=false;applyCamera();}
  },{signal:abort.signal});
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches){animations.forEach(animation=>animation.cancel());packets.replaceChildren();}},{signal:abort.signal});
  const resize = new ResizeObserver(()=>{
    if(!initialized){initialized=true;if(fitted){fit();if(viewport.clientWidth<600){const first=world.querySelector('[data-lo-department]');if(first)focusDepartment(first.dataset.loDepartment);}}else{applyCamera();scheduleConnections();}}
    else if(fitted)fit();else{applyCamera();scheduleConnections();}
  }); resize.observe(viewport);
  const controller={root,animateEvent:receiveEvent,refreshConnections,fit,zoomBy:factor=>zoomTo(camera.zoom*factor),focusDepartment,focusAgent,getCamera:()=>({...camera}),update(data){
    if(destroyed||!root.isConnected)return false;const jump=root.querySelector('[data-office-jump]').value;const template=document.createElement('template');template.innerHTML=renderOverview(data);patchOverviewNode(root,template.content.firstElementChild);root.querySelector('[data-office-jump]').value=jump;world.querySelectorAll('.office-person').forEach(node=>node.dataset.officeSelected=String(node.dataset.loId===selectedAgent));if(fitted)fit();else applyCamera();scheduleConnections();return true;
  },destroy(){if(destroyed)return;destroyed=true;abort.abort();resize.disconnect();if(frame)cancelAnimationFrame(frame);animations.forEach(animation=>animation.cancel());packets.replaceChildren();if(lastController===controller)lastController=null;}};
  lastController=controller;return controller;
}
export function animateEvent(event,element){if(element&&lastController?.root!==element&&!element.contains?.(lastController?.root))return false;return lastController?.animateEvent(event)||false;}
