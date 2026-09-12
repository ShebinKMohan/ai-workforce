import { ADAPTER_NAMES, runtimeStatus } from './office-model.js';

const escapeHTML = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{ plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', arrow: '<path d="m9 5-7 7 7 7M2 12h19"/>', focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="3"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2"/>', send: '<path d="m12 19 0-14m-5 5 5-5 5 5"/>' }[name] || ''}</svg>`;
const initialLetters = (name) => String(name || '?').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

/**
 * The agent directory, read-only.
 *
 * Agents are defined in the coordinator's agents.json and nowhere else. This
 * panel shows what GET /api/office read from that file; it has no form, saves
 * nothing, and says where to edit instead. Live editing comes later.
 */
export function createAgentManager({ element, departments = [], getState, onFocus = () => {}, onAssign = () => {}, onClose = () => {} }) {
  let active = false;
  let departmentFilter = '';
  let searchQuery = '';
  let opener = null;
  element.classList.add('agent-manager');
  element.setAttribute('aria-label', 'Agent directory, read-only');
  element.hidden = true;

  const office = () => getState().office;
  const agents = () => office()?.agents ?? [];
  const employeeFor = (id) => getState().employees.find((employee) => employee.agentId === id);
  const deskFor = (id) => { const employee = employeeFor(id); return employee ? getState().desks.get(employee.id) : null; };
  const departmentOf = (id) => departments.find((department) => department.id === employeeFor(id)?.departmentId);
  const configPath = () => office()?.configuration?.path ?? null;

  function open() {
    if (!active) opener = document.activeElement;
    active = true;
    element.hidden = false;
    document.body.classList.add('manager-open');
  }

  function hide() {
    active = false;
    element.hidden = true;
    document.body.classList.remove('manager-open');
  }

  function close() {
    hide();
    onClose();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function header(title, description, { back = false } = {}) {
    return `<header class="am-header"><div class="am-kicker">${back ? `<button type="button" class="am-back" data-am="directory">${icon('arrow')}All agents</button>` : `${icon('people')}<span>YOUR WORKFORCE · READ-ONLY</span>`}<button type="button" class="am-icon-button" data-am="close" aria-label="Close agent directory">${icon('close')}</button></div><div class="am-heading-row"><h1 id="am-title">${escapeHTML(title)}</h1>${back ? '' : `<button type="button" class="am-button am-primary am-add" data-am="add">${icon('plus')}Add agent</button>`}</div><p>${escapeHTML(description)}</p></header>`;
  }

  const footnote = () => `<p class="am-footnote">Read-only. Agents are defined in ${escapeHTML(configPath() ?? '~/.workforce/agents.json')}: edit that file, then reload this page. Live editing comes later; this page never writes it.</p>`;

  function renderRows() {
    const all = agents();
    const query = searchQuery.trim().toLocaleLowerCase();
    const visible = all.filter((agent) => (!departmentFilter || employeeFor(agent.id)?.departmentId === departmentFilter) && (!query || [agent.id, agent.runtime, agent.adapter, agent.model, agent.policy, ...(agent.capabilities || []), departmentOf(agent.id)?.name].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
    element.querySelector('.am-results-count').textContent = `${visible.length} ${visible.length === 1 ? 'agent' : 'agents'}${visible.length !== all.length ? ` of ${all.length}` : ''}`;
    const list = element.querySelector('.am-agent-list');
    if (!all.length) {
      const configuration = office()?.configuration;
      list.innerHTML = `<div class="am-empty">${icon('people')}<h2>No agents configured</h2><p>${escapeHTML(configuration?.error ? configuration.error.message : configuration?.found === false ? 'No agents.json was found.' : office() ? 'The agent configuration defines no agents.' : 'Reading the agent configuration…')}</p><button class="am-button am-secondary" type="button" data-am="add">How to add an agent</button></div>`;
      return;
    }
    list.innerHTML = visible.length ? visible.map((agent) => {
      const department = departmentOf(agent.id);
      const desk = deskFor(agent.id);
      return `<article class="am-agent-card"><div class="am-agent-identity"><span class="am-avatar" style="--am-person-color:${escapeHTML(department?.color || '#638270')}">${escapeHTML(initialLetters(agent.id))}</span><div><h2>${escapeHTML(agent.id)}</h2><p>${escapeHTML(department?.name || 'No seat')}<span aria-hidden="true"> · </span>${escapeHTML(agent.policy)} profile${agent.isDefaultWorker ? ' · default worker' : ''}${agent.isDefaultPlanner ? ' · default planner' : ''}</p></div></div><div class="am-agent-model"><span>${escapeHTML(ADAPTER_NAMES[agent.adapter] || agent.adapter)}</span><strong>${escapeHTML(agent.model || 'runtime default model')}</strong></div><div class="am-agent-meta"><span>runtime ${escapeHTML(agent.runtime)}</span><span>${escapeHTML((agent.capabilities || []).join(', '))}</span><span class="am-agent-status">${escapeHTML(desk?.label || '')}</span></div><div class="am-card-actions"><button type="button" class="am-button am-secondary" data-am="agent" data-agent-id="${escapeHTML(agent.id)}" aria-label="Details for ${escapeHTML(agent.id)}">Details</button><button type="button" class="am-button am-quiet" data-am="focus" data-agent-id="${escapeHTML(agent.id)}" aria-label="Find ${escapeHTML(agent.id)} on canvas">${icon('focus')}Find on canvas</button></div></article>`;
    }).join('') : `<div class="am-empty">${icon('search')}<h2>No agents found</h2><p>Try another id, runtime or capability, or choose a different department.</p><button class="am-button am-secondary" type="button" data-am="reset-filters">Clear filters</button></div>`;
  }

  function showDirectory() {
    open();
    element.innerHTML = `${header('Agents', `Every agent in ${configPath() ?? 'the agent configuration'}, as the coordinator reads it.`)}<div class="am-directory-tools"><label class="am-search">${icon('search')}<span class="am-sr-only">Search agents</span><input type="search" id="am-search" placeholder="Search by id, runtime or capability" autocomplete="off" value="${escapeHTML(searchQuery)}"/></label><label class="am-sr-only" for="am-department-filter">Filter agents by department</label><select id="am-department-filter"><option value="">All departments</option>${departments.map((department) => `<option value="${escapeHTML(department.id)}" ${departmentFilter === department.id ? 'selected' : ''}>${escapeHTML(department.name)}</option>`).join('')}</select><div class="am-results-row"><span class="am-results-count" role="status"></span><span>FROM AGENTS.JSON</span></div></div><div class="am-scroll am-directory-scroll"><div class="am-agent-list"></div></div>${footnote()}`;
    renderRows();
    element.querySelector('#am-search').focus({ preventScroll: true });
  }

  const row = (term, value) => `<div><dt>${escapeHTML(term)}</dt><dd>${value}</dd></div>`;

  function showAgent(id) {
    const agent = agents().find((entry) => entry.id === id);
    if (!agent) return showDirectory();
    const department = departmentOf(agent.id);
    const employee = employeeFor(agent.id);
    const desk = deskFor(agent.id);
    const report = (office()?.runtimes?.reports ?? []).find((entry) => entry.adapter === agent.adapter);
    const runtime = report ? runtimeStatus(report) : null;
    const boundary = agent.writeBoundary || {};
    open();
    element.innerHTML = `${header(agent.id, `${department?.name || 'No seat'} · ${desk?.label || ''}`, { back: true })}<div class="am-scroll am-form-scroll">
      <div class="am-local-note"><span class="am-local-dot"></span><p><strong>Read-only</strong><br>Defined in ${escapeHTML(configPath() ?? 'agents.json')}. Edit that file to change this agent; live editing comes later.</p></div>
      <section class="am-section"><h2 class="am-section-title"><span>01</span>Identity</h2><dl class="am-dl">${row('Agent id', escapeHTML(agent.id))}${row('Seat', escapeHTML(employee?.seatId ? `${department?.name} · desk ${Number(employee.seatId.split('-').pop()) + 1}` : employee ? `${department?.name} · additional desk` : 'none'))}${row('Role in configuration', escapeHTML([agent.isDefaultWorker ? 'default worker' : '', agent.isDefaultPlanner ? 'default planner' : ''].filter(Boolean).join(', ') || 'agent'))}${row('Capabilities', escapeHTML((agent.capabilities || []).join(', ') || 'none'))}</dl></section>
      <section class="am-section"><h2 class="am-section-title"><span>02</span>Runtime</h2><dl class="am-dl">${row('Runtime binding', escapeHTML(agent.runtime))}${row('Adapter', escapeHTML(ADAPTER_NAMES[agent.adapter] || agent.adapter))}${row('Executable', escapeHTML(agent.executable || ''))}${row('Model', escapeHTML(agent.model || 'runtime default'))}${row('Effort', escapeHTML(agent.effort || 'runtime default'))}${row('Passive discovery', runtime ? `${escapeHTML(runtime.label)}${report.version ? ` · ${escapeHTML(report.version)}` : ''}${runtime.tone !== 'ready' && runtime.detail ? ` · ${escapeHTML(runtime.detail)}` : ''}` : agent.adapter === 'fake' ? 'test runtime, not probed' : 'no report')}</dl></section>
      <section class="am-section"><h2 class="am-section-title"><span>03</span>Policy</h2><dl class="am-dl">${row('Profile', escapeHTML(agent.policy))}${row('Changes files', boundary.writes ? 'yes' : 'no')}${row('Write containment', escapeHTML(boundary.status || 'unknown'))}${row('Consent to start', boundary.requiresAllowUnconfinedWrites ? 'asks for --allow-unconfined-writes' : 'not needed')}</dl></section>
      <section class="am-section"><h2 class="am-section-title"><span>04</span>Instructions</h2><p class="am-instructions">${escapeHTML(agent.instructions || 'No instructions.')}</p></section>
    </div><footer class="am-form-footer"><button type="button" class="am-button am-secondary" data-am="focus" data-agent-id="${escapeHTML(agent.id)}">${icon('focus')}Find on canvas</button><button type="button" class="am-button am-primary" data-am="assign" data-agent-id="${escapeHTML(agent.id)}">Assign a task${icon('send')}</button></footer>`;
    element.querySelector('.am-back')?.focus({ preventScroll: true });
  }

  function showAddHelp() {
    const configuration = office()?.configuration;
    const runtimeId = agents()[0]?.runtime ?? '<a runtime id from "runtimes">';
    const example = JSON.stringify({ id: 'engineer-2', runtime: runtimeId, instructions: 'Inspect the relevant code, fix the underlying issue, and submit evidence against the task criteria.', capabilities: ['coding', 'testing'], policy: 'local-development' }, null, 2);
    open();
    element.innerHTML = `${header('Add an agent', 'Agents are defined in a file the coordinator reads, not in this page.', { back: true })}<div class="am-scroll am-form-scroll">
      <div class="am-local-note"><span class="am-local-dot"></span><p><strong>Live editing comes later</strong><br>This page never writes agents.json, so there is no form here that could pretend to configure a runtime.</p></div>
      ${configuration?.found ? `<p class="am-help-text">1. Open <code>${escapeHTML(configuration.path)}</code>.<br>2. Add an entry to <code>agents</code>, bound to one of its <code>runtimes</code>.<br>3. Reload this page. The agent takes the next open desk by the seat rule.</p>` : `<p class="am-help-text">No agents.json was found. Searched:</p><ul class="am-help-list">${(configuration?.searched ?? []).map((file) => `<li><code>${escapeHTML(file)}</code></li>`).join('')}</ul><p class="am-help-text">Run <code>workforce</code> with no arguments in a terminal: it offers to write one for the runtimes it finds.</p>`}
      ${configuration?.error ? `<div class="am-form-error">${escapeHTML(configuration.error.message)}<ul>${(configuration.error.issues || []).map((issue) => `<li>${escapeHTML(issue.path)}: ${escapeHTML(issue.message)}</li>`).join('')}</ul></div>` : ''}
      <p class="am-help-text">An entry looks like this:</p><pre class="am-code">${escapeHTML(example)}</pre>
    </div>${footnote()}`;
    element.querySelector('.am-back')?.focus({ preventScroll: true });
  }

  element.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-am]');
    if (!button || !element.contains(button)) return;
    const action = button.dataset.am;
    if (action === 'close') close();
    else if (action === 'directory') showDirectory();
    else if (action === 'add') showAddHelp();
    else if (action === 'agent') showAgent(button.dataset.agentId);
    else if (action === 'assign') onAssign(button.dataset.agentId);
    else if (action === 'focus') {
      const employee = employeeFor(button.dataset.agentId);
      if (!employee) return;
      close();
      onFocus({ type: 'employee', id: employee.id });
    } else if (action === 'reset-filters') { searchQuery = ''; departmentFilter = ''; showDirectory(); }
  });
  element.addEventListener('input', (event) => { if (event.target.id === 'am-search') { searchQuery = event.target.value; renderRows(); } });
  element.addEventListener('change', (event) => { if (event.target.id === 'am-department-filter') { departmentFilter = event.target.value; renderRows(); } });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });

  return { showDirectory, showAgent, showAddHelp, isOpen: () => active, hide };
}
