import { avatar, escape, icon } from './ui.js';
import { deriveOverviewWorkload, deriveFleetAgentState, agentSpecialty } from './live-overview.js';
import { deriveFleetHandoffs, deriveFleetJourneys } from './fleet-activity.js';
import { taskEventLabel } from './task-rail.js';

let instanceCount = 0;
const array = value => Array.isArray(value) ? value : [];
const idOf = value => String(value?.id ?? value ?? '');
const activeBuckets = new Set(['progress', 'backlog', 'waiting']);
const priority = { progress: 4, waiting: 3, backlog: 2, done: 1, closed: 0 };
const capabilityLabel = value => String(value ?? '').replaceAll('_', ' ').replaceAll('-', ' ').trim();
/** A read-only, nonmodal inspector with details for the selected fleet member. */
export function createOfficeInspector({ element, getData = () => ({}), onEditAgent = () => {}, onEditDepartment = () => {}, onShowTasks = () => {}, onRequest = () => {}, onAgent = () => {} } = {}) {
  if (!element?.append) throw new TypeError('Office inspector needs a container.');
  const panel = document.createElement('aside');
  const titleId = `office-inspector-title-${++instanceCount}`;
  panel.className = 'office-inspector';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', titleId);
  panel.tabIndex = -1;
  panel.hidden = true;
  element.append(panel);
  const controller = new AbortController();
  const { signal } = controller;
  let selection = null;
  let returnFocus = null;
  let lastHTML = '';
  let destroyed = false;
  let selectedItems = [];
  let selectedHandoffs = [];
  const disclosures = new Map();

  function snapshot() {
    const data = getData() || {};
    const agents = array(data.agents).filter(agent => !agent.archived);
    const control = data.controlCenter;
    if (control?.id && !agents.some(agent => idOf(agent.id) === idOf(control.id))) agents.push(control);
    const normalized = { ...data, agents, departments: array(data.departments).filter(department => !department.archived), requests: array(data.requests), runs: array(data.runs) };
    return { ...normalized, inspectorJourneys: deriveFleetJourneys(normalized) };
  }
  const agentState = (agent, data, workload) => deriveFleetAgentState(agent, data, workload, data.inspectorJourneys);
  function statusMarkup(state) {
    return `<span class="office-inspector-status" data-tone="${escape(state.tone || 'idle')}"><i></i>${escape(state.label)}</span>`;
  }
  function action(name, label, symbol, extra = '', secondary = false) {
    return `<button type="button" class="office-inspector-button${secondary ? ' office-inspector-secondary' : ''}" data-oi-action="${name}" data-oi-focus="${name}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`;
  }
  function heading(label) {
    return `<header class="office-inspector-header"><span>${label}</span><button type="button" class="office-inspector-close" data-oi-action="close" data-oi-focus="close" aria-label="Close inspector" title="Close inspector">${icon('close')}</button></header>`;
  }
  function taskRecord(item, data) {
    const run = data.runs.find(record => idOf(record.id) === item.runId && idOf(record.projectId) === item.projectId);
    const task = array(run?.taskViews).find(record => idOf(record.id) === item.taskId);
    const request = data.requests.find(record => item.requestIds.includes(idOf(record.id)));
    return { ...item, project: array(data.projects).find(project=>idOf(project.id)===item.projectId)?.name || item.projectId || 'Workspace', action: task?.lastEvent ? taskEventLabel(task.lastEvent) : '', receipts: task?.receipts || {}, title: task?.title || task?.objective || task?.summary || item.title || request?.task || request?.text || `Task ${item.taskId}`, at: task?.lastEvent?.timestamp || task?.updatedAt || task?.createdAt || run?.updatedAt || '' };
  }
  function taskPreview(items, data) {
    const sorted = items.map(item => taskRecord(item, data)).sort((a, b) => (priority[b.bucket] || 0) - (priority[a.bucket] || 0) || String(b.at).localeCompare(String(a.at)));
    return `<div class="office-inspector-task-list">${sorted.map(item => `<button type="button" class="office-inspector-task" data-oi-action="task" data-oi-key="${escape(item.key)}" data-oi-focus="task:${escape(item.key)}" title="${escape(item.title)}"><span class="office-inspector-task-symbol">${icon(item.bucket === 'done' ? 'check' : item.bucket === 'waiting' ? 'flag' : 'tasks')}</span><span><strong>${escape(item.title)}</strong><small class="office-inspector-project">${escape(item.project)} · ${escape(item.label)}</small>${item.action?`<small>${escape(item.action)}</small>`:''}${item.receipts?.verifierExecutedPassed?`<small>${item.receipts.verifierExecutedPassed} independent checks passed</small>`:''}</span>${icon('chevron')}</button>`).join('')}</div>`;
  }
  function agentMarkup(agent, data, workload) {
    const department = data.departments.find(record => idOf(record.id) === idOf(agent.departmentId));
    const state = agentState(agent, data, workload);
    const isControl = agent.isCoordinator || idOf(agent.id) === idOf(data.controlCenter?.id);
    selectedItems = workload.items.filter(item => item.kind === 'task' && item.ownerId === idOf(agent.id));
    for (const journey of data.inspectorJourneys) {
      if (!journey.active || !journey.ownerIds.includes(idOf(agent.id)) || selectedItems.some(item => item.runId === journey.runId && item.projectId === journey.projectId)) continue;
      selectedItems.push({ key: `journey:${journey.id}`, kind: 'brief', title: journey.title, taskId: null, runId: journey.runId, projectId: journey.projectId, requestIds: journey.requestId ? [journey.requestId] : [], departmentId: idOf(agent.departmentId), ownerId: idOf(agent.id), bucket: 'progress', label: journey.status, tone: journey.tone });
    }
    const currentItems = selectedItems.filter(item => activeBuckets.has(item.bucket));
    const pastItems = selectedItems.filter(item => !activeBuckets.has(item.bucket));
    selectedHandoffs = deriveFleetHandoffs(data).filter(item => idOf(item.fromAgentId) === idOf(agent.id) || idOf(item.toAgentId) === idOf(agent.id)).slice(0, 4);
    const provider = ({ codex: 'Codex', 'claude-code': 'Claude Code', openai: 'OpenAI', anthropic: 'Anthropic' })[agent.provider] || agent.provider;
    const role = isControl ? 'Company orchestrator' : agent.isHead || agent.runtimeRole === 'head' || agent.role === 'head' ? 'Department head' : agent.role || 'Agent';
    const capabilities = array(agent.capabilities).map(capabilityLabel).filter(Boolean);
    return `${heading(isControl ? 'CONTROL CENTER' : 'AGENT')}
      <div class="office-inspector-identity">${avatar(agent.name || agent.id, 48, { id:agent.id, avatarId:agent.avatarId })}<div><h2 id="${titleId}">${escape(agent.name || agent.id)}</h2><p>${escape(agentSpecialty(agent, role === 'worker' ? 'Specialist' : role))}</p>${department ? `<button class="office-inspector-department-link" type="button" data-oi-action="department" data-oi-id="${escape(department.id)}" data-oi-focus="department">${escape(department.name)}${icon('chevron')}</button>` : ''}</div></div>
      <div class="office-inspector-state-row">${statusMarkup(state)}</div>
      <section class="office-inspector-section office-inspector-current"><div class="office-inspector-section-title"><h3>${data.connected === false ? 'Last received work' : 'Current work'}</h3><span>${currentItems.length || ''}</span></div>${currentItems.length ? taskPreview(currentItems, data) : `<p class="office-inspector-empty">${state.label === 'Reviewing' ? 'Reviewing the team’s result. Tasks stay with their assigned agents.' : activeBuckets.has(state.bucket) ? `${escape(state.label)}. No specialist assignment is recorded for this agent.` : 'Available for work across your projects. Control Center selects specialists for each request.'}</p>`}</section>
      ${capabilities.length ? `<div class="office-inspector-specialties" aria-label="Specialties">${capabilities.map(capability=>`<span>${escape(capability)}</span>`).join('')}</div>`:''}<section class="office-inspector-section"><div class="office-inspector-section-title"><h3>Recent communication</h3></div>${selectedHandoffs.length ? handoffPreview(selectedHandoffs) : '<p class="office-inspector-empty">No recorded communication yet.</p>'}</section>
      ${pastItems.length ? `<details class="office-inspector-disclosure" data-oi-disclosure="past-work"><summary data-oi-focus="past-work"><span>Past work</span><small>${pastItems.length}</small>${icon('chevron')}</summary>${taskPreview(pastItems, data)}</details>` : ''}
      <details class="office-inspector-disclosure" data-oi-disclosure="about"><summary data-oi-focus="about"><span>About agent</span>${icon('chevron')}</summary><dl class="office-inspector-config"><div><dt>Role</dt><dd>${escape(role === 'worker' ? 'Specialist' : role)}</dd></div><div><dt>Runtime</dt><dd>${escape(provider || agent.runtime || 'Not configured')}${provider && agent.runtime ? `<small>${escape(agent.runtime)}</small>` : ''}</dd></div><div><dt>Model</dt><dd>${escape(agent.effectiveModel || agent.model || 'Runtime default')}</dd></div><div><dt>Effort</dt><dd>${escape(agent.effectiveEffort || agent.effort || 'Runtime default')}</dd></div></dl>${capabilities.length ? `<div class="office-inspector-about-section"><h4>Capabilities</h4><ul class="office-inspector-capabilities">${capabilities.map(capability => `<li>${escape(capability)}</li>`).join('')}</ul></div>` : ''}<div class="office-inspector-about-section"><h4>Instructions</h4><p class="office-inspector-instructions">${escape(agent.instructions || 'No instructions configured.')}</p></div></details>
      <footer class="office-inspector-footer">${action('work', 'View work', 'tasks', selectedItems.length ? '' : 'disabled', true)}${action('edit-agent', 'Edit agent', 'pen', '', true)}</footer>`;
  }
  function handoffPreview(items) {
    return `<div class="office-inspector-handoffs">${items.map(item => {
      const at = new Date(item.at);
      const time = Number.isFinite(at.getTime()) ? `<time datetime="${escape(at.toISOString())}" title="${escape(at.toLocaleString())}">${escape(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time>` : '';
      const content = `<span class="office-inspector-handoff-route"><strong>${escape(item.from)}</strong><span aria-label="to">→</span><strong>${escape(item.to)}</strong>${time}</span><span class="office-inspector-handoff-label">${escape(item.label)}</span>${item.taskTitle ? `<span class="office-inspector-handoff-task">${escape(item.taskTitle)}</span>` : ''}`;
      return item.requestId ? `<button type="button" class="office-inspector-handoff" data-oi-action="handoff" data-oi-id="${escape(item.id)}" data-oi-focus="handoff:${escape(item.id)}">${content}</button>` : `<div class="office-inspector-handoff">${content}</div>`;
    }).join('')}</div>`;
  }
  function rosterButton(agent, role, data, workload) {
    const state = agentState(agent, data, workload);
    const specialty = agentSpecialty(agent, role || agent.role || 'Agent');
    return `<button type="button" class="office-inspector-agent" data-oi-action="agent" data-oi-id="${escape(agent.id)}" data-oi-focus="agent:${escape(agent.id)}" aria-label="${escape(`${agent.name || agent.id}, ${specialty}, ${state.label}`)}">${avatar(agent.name || agent.id, 31, { id:agent.id, avatarId:agent.avatarId })}<span><strong>${escape(agent.name || agent.id)}</strong><small>${escape(specialty)}</small></span><i class="office-inspector-roster-dot" data-tone="${escape(state.tone || 'idle')}" title="${escape(state.label)}" aria-label="${escape(state.label)}"></i>${icon('chevron')}</button>`;
  }
  function departmentMarkup(department, data, workload) {
    const roster = data.agents.filter(agent => idOf(agent.departmentId) === idOf(department.id));
    const headId = idOf(department.headAgentId || department.lead?.id);
    const head = roster.find(agent => idOf(agent.id) === headId) || (department.lead?.id && !department.lead.isVacant ? department.lead : null);
    const specialists = roster.filter(agent => idOf(agent.id) !== idOf(head?.id));
    const counts = workload.byDepartment.get(idOf(department.id))?.counts || { progress: 0, backlog: 0, waiting: 0, done: 0 };
    selectedItems = workload.byDepartment.get(idOf(department.id))?.items || [];
    return `${heading('DEPARTMENT')}<div class="office-inspector-identity"><span class="office-inspector-department-icon">${icon(department.icon || 'org')}</span><div><h2 id="${titleId}">${escape(department.name)}</h2><p>${roster.length} configured agent${roster.length === 1 ? '' : 's'}</p></div></div>${department.purpose || department.note || department.focus ? `<p class="office-inspector-purpose">${escape(department.purpose || department.note || department.focus)}</p>` : ''}<div class="office-inspector-counts" aria-label="Department workload">${[['progress', 'Doing'], ['backlog', 'Next'], ['waiting', 'Waiting'], ['done', 'Done']].map(([key, label]) => `<div><strong>${counts[key] || 0}</strong><span>${label}</span></div>`).join('')}</div><section class="office-inspector-section"><div class="office-inspector-section-title"><h3>Department head</h3></div>${head ? rosterButton(head, 'Department head', data, workload) : '<p class="office-inspector-empty">No department head configured.</p>'}</section><section class="office-inspector-section"><div class="office-inspector-section-title"><h3>Agents</h3><span>${specialists.length}</span></div><div class="office-inspector-roster">${specialists.length ? specialists.map(agent => rosterButton(agent, agent.role === 'worker' ? 'Specialist' : agent.role, data, workload)).join('') : '<p class="office-inspector-empty">No specialists configured.</p>'}</div></section><footer class="office-inspector-footer">${action('work', 'View work', 'tasks', '', true)}${action('edit-department', 'Edit department', 'pen', '', true)}</footer>`;
  }
  function render({ initial = false } = {}) {
    if (!selection || destroyed) return;
    saveDisclosures();
    const data = snapshot();
    const workload = deriveOverviewWorkload(data);
    const record = (selection.type === 'agent' ? data.agents : data.departments).find(item => idOf(item.id) === selection.id);
    if (!record) { close(); return; }
    const html = selection.type === 'agent' ? agentMarkup(record, data, workload) : departmentMarkup(record, data, workload);
    if (html !== lastHTML) {
      const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.oiFocus : null;
      const scrollTop = panel.scrollTop;
      panel.innerHTML = html;
      const expanded = disclosures.get(`${selection.type}:${selection.id}`);
      for (const details of panel.querySelectorAll('[data-oi-disclosure]')) details.open = expanded?.has(details.dataset.oiDisclosure) || false;
      lastHTML = html;
      if (!initial) {
        panel.scrollTop = scrollTop;
        if (focused) ([...panel.querySelectorAll('[data-oi-focus]')].find(node => node.dataset.oiFocus === focused) || panel.querySelector('.office-inspector-close'))?.focus({ preventScroll: true });
      }
    }
    panel.dataset.kind = selection.type;
    panel.dataset.selectedId = selection.id;
    panel.hidden = false;
    element.dataset.officeInspectorOpen = 'true';
    if (initial) { panel.scrollTop = 0; panel.querySelector('.office-inspector-close')?.focus({ preventScroll: true }); }
  }
  function show(type, id) {
    if (destroyed) return;
    saveDisclosures();
    if (!panel.contains(document.activeElement)) returnFocus = document.activeElement;
    if (panel.parentElement !== element) element.append(panel);
    selection = { type, id: idOf(id) };
    render({ initial: true });
  }
  function close({ restoreFocus = true } = {}) {
    delete element.dataset.officeInspectorOpen;
    if (!selection && panel.hidden) return;
    saveDisclosures();
    selection = null; selectedItems = []; selectedHandoffs = []; panel.hidden = true;
    if (restoreFocus && returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function saveDisclosures() {
    if (!selection || panel.dataset.kind !== selection.type || panel.dataset.selectedId !== selection.id) return;
    disclosures.set(`${selection.type}:${selection.id}`, new Set([...panel.querySelectorAll('[data-oi-disclosure][open]')].map(details => details.dataset.oiDisclosure)));
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-oi-action]');
    if (!button || button.disabled || !selection) return;
    const actionName = button.dataset.oiAction;
    if (actionName === 'close') return close();
    if (actionName === 'department') return show('department', button.dataset.oiId);
    if (actionName === 'agent') { onAgent(button.dataset.oiId); return show('agent', button.dataset.oiId); }
    if (actionName === 'handoff') {
      const item = selectedHandoffs.find(record => idOf(record.id) === button.dataset.oiId);
      if (item?.requestId) return onRequest(item.requestId);
      return;
    }
    if (actionName === 'edit-agent') { const id = selection.id; close({ restoreFocus: false }); return onEditAgent(id); }
    if (actionName === 'edit-department') { const id = selection.id; close({ restoreFocus: false }); return onEditDepartment(id); }
    if (actionName === 'work') {
      if (selection.type === 'department') return onShowTasks({ departmentId: selection.id, filter: 'all' });
      const data = snapshot(); const agent = data.agents.find(item => idOf(item.id) === selection.id);
      return onShowTasks({ departmentId: agent?.departmentId || null, agentId: selection.id, filter: 'all', taskIds: selectedItems.map(item => item.taskId).filter(Boolean), requestIds: [...new Set(selectedItems.flatMap(item => item.requestIds))] });
    }
    if (actionName === 'task') {
      const item = selectedItems.find(record => record.key === button.dataset.oiKey);
      if (!item) return;
      if (item.requestIds.length) return onRequest(item.requestIds[0]);
      return onShowTasks({ departmentId: item.departmentId || null, filter: 'all', taskIds: item.taskId ? [item.taskId] : [], requestIds: [] });
    }
  }, { signal });
  document.addEventListener('keydown', event => {
    if (!selection || panel.hidden || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault(); event.stopPropagation(); close();
  }, { signal, capture: true });
  document.addEventListener('pointerdown', event => {
    if (!selection || panel.hidden || panel.contains(event.target)) return;
    // Canvas selection and navigation buttons handle the next inspection themselves.
    if (element.contains(event.target) && event.target.closest('button,[data-lo-action],[data-office-action]')) return;
    close({ restoreFocus: false });
  }, { signal });
  return {
    showAgent: id => show('agent', id),
    showDepartment: id => show('department', id),
    update() { if (selection && panel.isConnected) render(); },
    close,
    destroy() { if (destroyed) return; close(); destroyed = true; controller.abort(); panel.remove(); },
  };
}
