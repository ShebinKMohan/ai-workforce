const icon = (name, size = 18) => {
  const paths = {
    center: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="15" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6M6 9v6m12-6v6M9 18h6"/>',
    arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
    send: '<path d="m12 19 0-14m-5 5 5-5 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
    sparkle: '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/>',
    focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.center}</svg>`;
};

const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const taskText = (task) => typeof task === 'string' ? task : task?.title || task?.name || 'Ready for the next task';
const initials = (name = '') => name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('');


/** Original office panel. Profiles and canvas callbacks are preserved; task truth comes from workspace records. */
export function createSidebar({ element, departments = [], employees = [], runtimes = [], coordinator = {}, onFocus = () => {}, onCommunication = () => {}, onEditAgent = () => {}, onManageAgents = () => {}, onAddAgent = () => {}, onAssignTask = null, onOpenTask = () => {} }) {
  let selection = { type: 'office' };
  let activeTab = 'chat';
  let expandedTask = null;
  let expandedRuntime = null;
  let taskFilter = 'all';
  let draft = '';
  let messages = [];
  let activities = [];
  let destroyed = false;
  let liveData = { tasks: [], projects: [], reports: [], error: null };
  let sending = false;
  let submitError = '';

  const departmentById = (id) => departments.find((item) => item.id === id);
  const employeeById = (id) => employees.find((item) => item.id === id);
  const runtimeById = (id) => runtimes.find((item) => item.id === id);
  const coordinatorName = () => coordinator.name || 'Office coordinator';
  const configurationFor = (employee = {}) => {
    const mapping = runtimeById(employee.runtimeId);
    return {
      model: employee.model || mapping?.model || 'Model unassigned',
      provider: employee.provider === 'custom' ? employee.customProvider : ({openai:'OpenAI',anthropic:'Anthropic',google:'Google',ollama:'Ollama / local'}[employee.provider || mapping?.provider] || 'Provider unassigned'),
      runtime: {'codex-cli':'Codex CLI','claude-code':'Claude Code',ollama:'Ollama',api:'Direct model API'}[employee.runtime || mapping?.runtime] || mapping?.name || 'Runtime unassigned',
      instructions: employee.instructions || '',
    };
  };
  const selectedEmployees = () => selection.type === 'employee' ? employees.filter((employee) => employee.id === selection.id) : selection.type === 'department' ? employees.filter((employee) => employee.departmentId === selection.id) : employees;
  const contextName = () => selection.type === 'employee' ? employeeById(selection.id)?.name || 'Employee' : selection.type === 'department' ? departmentById(selection.id)?.name || 'Department' : 'Whole office';
  const hasTask = (employee) => Boolean(typeof employee.task === 'string' ? employee.task.trim() : employee.task?.title || employee.task?.name);
  const tasks = [];
  const normaliseTask = (record) => {
    const key = typeof record.status === 'string' ? record.status : record.status?.key;
    const status = ['verified', 'accepted'].includes(key) ? 'review' : ['interrupted', 'failed', 'needs-repair', 'head-failed'].includes(key) ? 'failed' : record.inMotion ? 'running' : ['running', 'queued', 'review', 'done', 'failed'].includes(key) ? key : 'queued';
    return { ...record, id: String(record.id || record.key || record.runId || record.requestId), title: record.title || record.taskText || record.request?.taskText || 'Recorded task', status, statusLabel: record.statusLabel || record.status?.word || ({ review: 'Verified · ready for review', running: 'In progress', queued: 'Waiting to start', done: 'Finished', failed: 'Needs attention' }[status]), summary: record.summary || record.status?.line || '', employeeId: record.employeeId || record.workerId };
  };

  function contextOptions() {
    return `<option value="office">Whole office</option>${departments.map((department) => `<optgroup label="${esc(department.name)}"><option value="department:${esc(department.id)}">${esc(department.name)}</option>${employees.filter((employee) => employee.departmentId === department.id).map((employee) => `<option value="employee:${esc(employee.id)}">${esc(employee.name)} · ${esc(employee.role)}</option>`).join('')}</optgroup>`).join('')}`;
  }

  element.classList.add('office-sidebar');
  element.setAttribute('aria-label', 'Control center');
  element.innerHTML = `
    <header class="sidebar-heading">
      <div class="sidebar-heading-top"><span class="coordinator-kicker"><i></i> OFFICE COORDINATOR</span><span class="sidebar-demo-label">LOCAL WORKSPACE</span></div>
      <div class="sidebar-title-row"><h1>Control center<span>.</span></h1><span class="coordinator-mark">${icon('center', 22)}</span></div>
      <p><span class="sidebar-coordinator-name">${esc(coordinatorName())}</span> · your office coordinator.</p>
      <div class="sidebar-agent-actions"><button type="button" class="sidebar-roster-button" data-manage-agents>${icon('center', 14)}Agents <span class="sidebar-agent-count">${employees.length}</span></button><button type="button" class="sidebar-add-agent" data-add-agent><span aria-hidden="true">+</span> Add agent</button></div>
    </header>
    <div class="sidebar-context-row">
      <span class="context-icon">${icon('focus', 15)}</span>
      <label class="sr-only" for="office-context-select">Conversation and canvas context</label>
      <select id="office-context-select" class="sidebar-context-select">
        ${contextOptions()}
      </select>
      <button class="sidebar-icon-button context-focus" title="Focus selected area on canvas" aria-label="Focus selected area on canvas">${icon('arrow', 16)}</button>
    </div>
    <div class="sidebar-tabs" role="tablist" aria-label="Control center views">
      <button class="sidebar-tab is-active" type="button" role="tab" id="office-tab-chat" aria-controls="office-panel" aria-selected="true" data-tab="chat">Chat</button>
      <button class="sidebar-tab" type="button" role="tab" id="office-tab-tasks" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="tasks">Tasks <span class="tab-task-count">${tasks.filter((task) => task.status === 'review').length}</span></button>
      <button class="sidebar-tab" type="button" role="tab" id="office-tab-connections" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="connections">Connections</button>
    </div>
    <section class="sidebar-scroll" id="office-panel" role="tabpanel" aria-labelledby="office-tab-chat" tabindex="0"></section>
    <div class="sidebar-composer-wrap"></div>
    <div class="sidebar-demo-note">Live task records · independent checks</div>`;

  const scroll = element.querySelector('.sidebar-scroll');
  const composerWrap = element.querySelector('.sidebar-composer-wrap');
  const contextSelect = element.querySelector('.sidebar-context-select');

  function renderConfiguration(employee, isCoordinator = false) {
    const config = configurationFor(employee);
    return `<div class="person-configuration"><span class="sidebar-small-label">${employee.isCustom ? 'SAVED CONFIGURATION' : 'AGENT CONFIGURATION'}</span><strong>${esc(config.model)}</strong><p>${esc(config.provider)} · ${esc(config.runtime)}</p><span class="person-config-status">Configured locally · execution recorded per task</span></div>
      ${config.instructions ? `<details class="person-instructions"><summary>Instructions <span>${esc(config.instructions.slice(0, 84))}${config.instructions.length > 84 ? '…' : ''}</span></summary><p>${esc(config.instructions)}</p></details>` : '<p class="person-instructions-empty">No instructions added yet.</p>'}
      <button type="button" class="person-edit" data-edit-agent="${esc(employee.id || 'control')}">${isCoordinator ? 'Configure coordinator' : 'Edit agent'}${icon('arrow', 13)}</button>`;
  }

  function renderSelection() {
    if (selection.type === 'employee') {
      const employee = employeeById(selection.id);
      if (!employee) return '';
      const department = departmentById(employee.departmentId);
      return `<section class="selected-employee">
        <div class="selected-person-top"><span class="employee-monogram" style="--department-color:${esc(department?.color || '#628273')}">${esc(initials(employee.name))}</span><div><h2>${esc(employee.name)}</h2><p>${esc(employee.role)} · ${esc(department?.name || '')}</p></div><button class="sidebar-icon-button" data-focus="employee" data-id="${esc(employee.id)}" aria-label="Focus ${esc(employee.name)} on canvas">${icon('focus', 16)}</button></div>
        <p class="person-task"><span>${!hasTask(employee) ? 'ASSIGNMENT' : employee.status === 'idle' ? 'LAST ASSIGNMENT' : employee.status === 'review' ? 'AWAITING REVIEW' : 'WORKING ON'}</span>${esc(hasTask(employee) ? taskText(employee.task) : 'No task assigned')}</p>
        ${renderConfiguration(employee)}
      </section>`;
    }
    if (selection.type === 'department') {
      const department = departmentById(selection.id);
      if (!department) return '';
      return `<section class="selected-department"><div><i style="background:${esc(department.color || '#628273')}"></i><h2>${esc(department.name)}</h2></div><p>${selectedEmployees().length} agents · tasks scoped to this team</p><button type="button" class="person-edit" data-add-agent="${esc(department.id)}">Add agent to team<span aria-hidden="true">+</span></button>${selectedEmployees().some(employee => employee.isCustom) ? `<button type="button" class="person-edit" data-focus-extra="${esc(department.id)}">Show additional desks${icon('arrow', 13)}</button>` : ''}</section>`;
    }
    if (selection.type !== 'control') return `<div class="coordinator-quick-settings"><span>${esc(coordinatorName())} coordinates your team</span><button type="button" class="person-edit" data-edit-agent="control">Settings ${icon('arrow', 13)}</button></div>`;
    return `<section class="selected-coordinator"><div class="selected-person-top"><span class="employee-monogram">${esc(initials(coordinatorName()))}</span><div><h2>${esc(coordinatorName())}</h2><p>${esc(coordinator.role || 'Office coordinator')} · Control center</p></div></div>${renderConfiguration(coordinator, true)}</section>`;
  }

  function renderChat() {
    const visibleMessages = messages.slice(-30);
    scroll.innerHTML = `${renderSelection()}
      <div class="chat-conversation" role="log" aria-label="Coordinator conversation" aria-live="polite">
        <div class="coordinator-intro"><div class="chat-avatar">${icon('center', 18)}</div><div><div class="chat-author">${esc(coordinatorName())} <span>COORDINATOR</span></div><p>Good work starts with a clear view.</p><p class="chat-intro-detail">Pick a team on the canvas, then describe the work. Review the project and checks before sending it to the department head.</p></div></div>
        ${visibleMessages.map((message) => `<article class="chat-message ${message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}"><div class="chat-message-meta">${message.role === 'user' ? 'You' : esc(coordinatorName())}${message.role === 'user' && message.context !== 'Whole office' ? `<span>${esc(message.context)}</span>` : ''}</div><p>${esc(message.text)}</p></article>`).join('')}
      </div>
      ${submitError ? `<p class="person-instructions-empty" role="alert">${esc(submitError)}</p>` : ''}${liveData.error ? `<p class="person-instructions-empty" role="alert">${esc(liveData.error)}</p>` : ''}${visibleMessages.length ? '' : `<div class="chat-suggestions"><span class="sidebar-small-label">A PLACE TO START</span><button data-show-tab="tasks"><span>See team activity</span>${icon('arrow', 15)}</button><button data-show-tab="tasks"><span>Show tasks to review</span>${icon('arrow', 15)}</button><button data-show-tab="connections"><span>How is the team connected?</span>${icon('arrow', 15)}</button></div>`}
      ${!visibleMessages.length ? `<div class="chat-office-note"><div class="mini-avatar-stack">${employees.slice(0, 4).map((employee) => `<span>${esc(initials(employee.name))}</span>`).join('')}</div><p>${employees.length} specialists. ${departments.filter(d=>d.configured).length} departments.<br><span>One place to bring everything together.</span></p></div>` : ''}`;
    composerWrap.hidden = false;
    composerWrap.innerHTML = `<form class="sidebar-composer" aria-label="Message office coordinator"><label class="sr-only" for="coordinator-message">Message the control center</label><textarea id="coordinator-message" rows="2" maxlength="1800" placeholder="Message the control center…">${esc(draft)}</textarea><div class="composer-bottom"><span class="composer-scope">${icon('center', 13)}<span>${esc(contextName())}</span></span><button class="composer-send" type="submit" aria-label="Review task before sending" ${draft.trim() && !sending ? '' : 'disabled'}>${icon('send', 18)}</button></div></form><div class="composer-help"><span>Enter to review <span aria-hidden="true">↵</span></span><span>Shift + Enter for a new line</span></div>`;
    const textarea = composerWrap.querySelector('textarea');
    textarea.addEventListener('input', () => {
      draft = textarea.value;
      composerWrap.querySelector('.composer-send').disabled = !draft.trim() || sending;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(textarea.value); }
    });
    composerWrap.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); submitMessage(textarea.value); });
  }

  async function submitMessage(raw) {
    const value = String(raw || '').trim().slice(0, 1800);
    if (!value || sending) return;
    if (!onAssignTask) { submitError = 'Task intake is still loading. Please try again.'; render(); return; }
    sending = true;
    submitError = '';
    composerWrap.querySelector('.composer-send')?.setAttribute('disabled', '');
    try {
      const result = await onAssignTask({ text: value, selection: { ...selection }, departmentId: selection.type === 'department' ? selection.id : selection.type === 'employee' ? employeeById(selection.id)?.departmentId : null, employeeId: selection.type === 'employee' ? selection.id : null });
      if (result?.cancelled || !result) return;
      draft = '';
      messages.push({ role: 'user', text: value, context: contextName() });
      if (result.message) messages.push({ role: 'assistant', text: result.message, context: contextName() });
      if (result.task && !tasks.some((task) => task.id === String(result.task.id))) tasks.unshift(normaliseTask(result.task));
      messages = messages.slice(-30);
    } catch (error) { submitError = error?.message || 'The task could not be sent. Your draft is still here.'; }
    finally { sending = false; render(); scroll.scrollTop = scroll.scrollHeight; composerWrap.querySelector('textarea')?.focus(); }
  }

  function renderTasks() {
    const selected = selection.type === 'employee' ? employeeById(selection.id) : null;
    const departmentId = selection.type === 'department' ? selection.id : selected?.departmentId;
    const scopedTasks = tasks.filter((task) => !departmentId || task.departmentId === departmentId);
    const filteredTasks = scopedTasks.filter((task) => taskFilter === 'all' || task.status === taskFilter);
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Team workspace</h2><p>Small steps. Visible progress.</p></div><span class="sample-pill">LIVE RECORDS</span></div>
      <div class="task-filter-row" aria-label="Filter tasks">${[['all', 'All'], ['review', 'Review'], ['running', 'Running'], ['failed', 'Needs you']].map(([id, label]) => `<button class="task-filter ${taskFilter === id ? 'is-active' : ''}" data-task-filter="${id}" aria-pressed="${taskFilter === id}">${label}<span>${id === 'all' ? scopedTasks.length : scopedTasks.filter((task) => task.status === id).length}</span></button>`).join('')}</div>
      ${liveData.error ? `<p role="alert">${esc(liveData.error)}</p>` : ''}<div class="sidebar-task-list">${filteredTasks.map((task) => {
        const employee = employeeById(task.employeeId);
        const department = departmentById(task.departmentId);
        const expanded = expandedTask === task.id;
        return `<article class="sidebar-task ${expanded ? 'is-expanded' : ''}"><button class="task-summary" data-task="${esc(task.id)}" aria-expanded="${expanded}" aria-controls="details-${esc(task.id)}"><span class="task-state-dot task-state-${esc(task.status)}">${task.status === 'review' ? icon('check', 10) : ''}</span><span class="task-summary-content"><span class="task-title">${esc(task.title)}</span><span class="task-byline">${esc(department?.name || task.projectName || '')}${employee ? ` <span>·</span> ${esc(employee.name)}` : ''}</span><span class="task-status-label task-status-${esc(task.status)}">${esc(task.statusLabel)}</span></span><span class="task-chevron">${icon('chevron', 14)}</span></button>
          ${expanded ? `<div class="task-details" id="details-${esc(task.id)}"><span class="sidebar-small-label">RECORDED RESULT</span><p>${esc(task.summary || 'Open the task to follow its department head, worker, checks and candidate changes.')}</p><div class="task-detail-actions"><button class="task-approve" data-open-task="${esc(task.id)}">${icon('arrow', 14)}Open task and evidence</button>${employee ? `<button class="task-revise" data-focus="employee" data-id="${esc(employee.id)}">${icon('focus', 14)}Find employee</button>` : ''}</div></div>` : ''}</article>`;
      }).join('') || '<div class="sidebar-empty"><span>All clear.</span><p>No recorded tasks in this view.</p></div>'}</div>`;
    composerWrap.hidden = true;
  }

  function renderConnections() {
    const scopedIds = new Set(selectedEmployees().map((employee) => employee.runtimeId));
    const scopedRuntimes = selection.type === 'department' || selection.type === 'employee' ? runtimes.filter((runtime) => scopedIds.has(runtime.id)) : runtimes;
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Behind the office</h2><p>Models, providers, and runtimes.</p></div>${icon('link', 20)}</div>
      <div class="connection-overview"><span class="connection-overview-mark">${icon('center', 20)}</span><div><strong>${esc(coordinatorName())} · Control center</strong><p>Routes your request to the right specialist</p></div><span class="connection-overview-line"></span><span class="connection-overview-count">${scopedRuntimes.length}<small>CONFIGS</small></span></div>
      <p class="connection-explainer">${scopedRuntimes.length} configured runtimes. Installation and sign-in reports are passive; each task records its actual execution.</p>
      <div class="connection-list">${scopedRuntimes.length ? scopedRuntimes.map((runtime) => {
        const connectedEmployees = employees.filter((employee) => employee.runtimeId === runtime.id);
        const includesCoordinator = coordinator.runtimeId === runtime.id;
        const connectedDepartments = departments.filter((department) => connectedEmployees.some((employee) => employee.departmentId === department.id));
        const expanded = expandedRuntime === runtime.id;
        return `<article class="runtime-item ${expanded ? 'is-expanded' : ''}"><button class="runtime-summary" data-runtime="${esc(runtime.id)}" aria-expanded="${expanded}" aria-controls="runtime-details-${esc(runtime.id)}"><span class="runtime-monogram">${esc(initials(runtime.name).slice(0, 2))}</span><span class="runtime-main"><strong>${esc(runtime.name)}</strong><span>${esc(runtime.model || runtime.kind || 'Model configuration')}</span></span><span class="runtime-demo">${esc(runtime.connectionLabel || 'Configured')}</span><span class="task-chevron">${icon('chevron', 14)}</span></button><div class="runtime-assignment-preview">${includesCoordinator ? `<button data-focus="control" data-id="control">${esc(coordinatorName())}</button>` : ''}${connectedDepartments.map((department) => `<button data-focus="department" data-id="${esc(department.id)}"><i style="background:${esc(department.color || '#628273')}"></i>${esc(department.name)}</button>`).join('') || (includesCoordinator ? '' : '<span>No employees assigned</span>')}</div>
          ${expanded ? `<div class="runtime-details" id="runtime-details-${esc(runtime.id)}"><dl><div><dt>Model</dt><dd>${esc(runtime.model || 'Not specified')}</dd></div><div><dt>Provider</dt><dd>${esc(runtime.provider || 'Not specified')}</dd></div><div><dt>Runtime</dt><dd>${esc(runtime.runtime || runtime.kind || runtime.name)}</dd></div><div><dt>Connection</dt><dd>${esc(runtime.connectionLabel || 'Configured · sign-in not checked')}</dd></div></dl>${runtime.description ? `<p>${esc(runtime.description)}</p>` : ''}<span class="sidebar-small-label">ASSIGNED AGENTS · ${connectedEmployees.length + (includesCoordinator ? 1 : 0)}</span><div class="runtime-employees">${includesCoordinator ? `<button data-focus="control" data-id="control"><span>${esc(initials(coordinatorName()))}</span>${esc(coordinatorName())}${icon('arrow', 12)}</button>` : ''}${connectedEmployees.map((employee) => `<button data-focus="employee" data-id="${esc(employee.id)}"><span>${esc(initials(employee.name))}</span>${esc(employee.name)}${icon('arrow', 12)}</button>`).join('') || (includesCoordinator ? '' : '<p>No assigned agents.</p>')}</div></div>` : ''}</article>`;
      }).join('') : '<div class="sidebar-empty"><span>No runtime assigned.</span><p>This specialist is waiting for a configuration.</p></div>'}</div>
      <div class="connection-route-note">${icon('sparkle', 16)}<p>Your message → control center → specialist.<br><span>Department heads plan and assign the work.</span></p></div>`;
    composerWrap.hidden = true;
  }

  function render() {
    if (destroyed) return;
    contextSelect.value = selection.type === 'office' || selection.type === 'control' ? 'office' : `${selection.type}:${selection.id}`;
    element.querySelectorAll('.sidebar-tab').forEach((tab) => {
      const isActive = tab.dataset.tab === activeTab;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    element.querySelector('.tab-task-count').textContent = String(tasks.filter((task) => task.status === 'review').length);
    scroll.setAttribute('aria-labelledby', `office-tab-${activeTab}`);
    if (activeTab === 'tasks') renderTasks();
    else if (activeTab === 'connections') renderConnections();
    else renderChat();
  }

  function refresh() {
    if (destroyed) return;
    tasks.splice(0, tasks.length, ...(liveData.tasks || []).map(normaliseTask));
    if (selection.type === 'employee' && !employeeById(selection.id) || selection.type === 'department' && !departmentById(selection.id)) selection = { type: 'office' };
    if (expandedTask && !tasks.some((task) => task.id === expandedTask)) expandedTask = null;
    if (expandedRuntime && !runtimeById(expandedRuntime)) expandedRuntime = null;
    contextSelect.innerHTML = contextOptions();
    element.querySelector('.sidebar-agent-count').textContent = String(employees.length);
    element.querySelector('.sidebar-coordinator-name').textContent = coordinatorName();
    render();
  }

  function select(nextSelection) {
    const next = nextSelection || { type: 'office' };
    if (next.type === 'employee' && !employeeById(next.id) || next.type === 'department' && !departmentById(next.id)) return;
    selection = { type: next.type || 'office', ...(next.id ? { id: next.id } : {}) };
    render();
    scroll.scrollTop = 0;
  }

  function showTab(tab) {
    if (!['chat', 'tasks', 'connections'].includes(tab)) return;
    activeTab = tab;
    render();
    scroll.scrollTop = 0;
  }

  function showRuntime(runtimeId) {
    if (!runtimeById(runtimeId)) return;
    selection = { type: 'control' };
    onFocus(selection);
    activeTab = 'connections';
    expandedRuntime = runtimeId;
    render();
    requestAnimationFrame(() => {
      const target = [...scroll.querySelectorAll('.runtime-summary')].find((button) => button.dataset.runtime === runtimeId);
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  contextSelect.addEventListener('change', () => {
    const [type, ...idParts] = contextSelect.value.split(':');
    const next = { type, ...(idParts.length ? { id: idParts.join(':') } : {}) };
    select(next);
    onFocus(next);
  });

  element.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    if (button.hasAttribute('data-manage-agents')) onManageAgents();
    else if (button.hasAttribute('data-add-agent')) onAddAgent(button.dataset.addAgent || (selection.type === 'department' ? selection.id : selection.type === 'employee' ? employeeById(selection.id)?.departmentId : undefined));
    else if (button.hasAttribute('data-edit-agent')) onEditAgent(button.dataset.editAgent);
    else if (button.dataset.focusExtra) { const next = {type:'department',id:button.dataset.focusExtra,extra:true};select(next);onFocus(next); }
    else if (button.dataset.tab) showTab(button.dataset.tab);
    else if (button.classList.contains('context-focus')) onFocus(selection);
    else if (button.dataset.showTab) showTab(button.dataset.showTab);
    else if (button.dataset.openTask) { const task = tasks.find((item) => item.id === button.dataset.openTask); if (task) onOpenTask(task); }
    else if (button.dataset.taskFilter) { taskFilter = button.dataset.taskFilter; render(); }
    else if (button.dataset.task) { expandedTask = expandedTask === button.dataset.task ? null : button.dataset.task; render(); }
    else if (button.hasAttribute('data-runtime')) {
      if (!runtimeById(button.dataset.runtime)) return;
      if (activeTab !== 'connections') showRuntime(button.dataset.runtime);
      else { expandedRuntime = expandedRuntime === button.dataset.runtime ? null : button.dataset.runtime; render(); }
    } else if (button.dataset.focus) {
      const next = { type: button.dataset.focus, id: button.dataset.id };
      select(next);
      onFocus(next);
    }
  });

  element.querySelector('.sidebar-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = ['chat', 'tasks', 'connections'];
    const index = tabs.indexOf(activeTab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
    showTab(tabs[nextIndex]);
    element.querySelector(`[data-tab="${activeTab}"]`).focus();
  });

  render();
  return {
    select,
    showTab,
    showRuntime,
    refresh,
    updateData(next = {}) {
      liveData = { ...liveData, ...next };
      const focused = element.contains(document.activeElement) ? document.activeElement : null;
      const focusId = focused?.id;
      const selectionRange = focused?.tagName === 'TEXTAREA' ? [focused.selectionStart, focused.selectionEnd] : null;
      if (focused?.tagName === 'TEXTAREA') draft = focused.value;
      refresh();
      if (focusId) {
        const replacement = document.getElementById(focusId);
        replacement?.focus({ preventScroll: true });
        if (selectionRange) replacement?.setSelectionRange?.(...selectionRange);
      }
    },
    addActivity(event) { activities.push({ ...(event || {}), at: Date.now() }); activities = activities.slice(-12); if (activeTab === 'tasks') render(); },
    destroy() { destroyed = true; element.replaceChildren(); },
  };
}
