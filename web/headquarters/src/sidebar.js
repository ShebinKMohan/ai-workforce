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
const STORE_KEY = 'agent-office-conversation-v1';

/** A self-contained, local-demo coordinator panel. All canvas changes use callbacks. */
export function createSidebar({ element, departments = [], employees = [], runtimes = [], coordinator = {}, onFocus = () => {}, onCommunication = () => {}, onEditAgent = () => {}, onManageAgents = () => {}, onAddAgent = () => {} }) {
  let selection = { type: 'office' };
  let activeTab = 'chat';
  let expandedTask = null;
  let expandedRuntime = null;
  let taskFilter = 'all';
  let draft = '';
  let messages = [];
  let activities = [];
  let destroyed = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (Array.isArray(saved)) messages = saved.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.text === 'string').slice(-30).map((message) => ({ role: message.role, text: message.text.slice(0, 2500), context: String(message.context || 'Whole office').slice(0, 120) }));
  } catch { /* Private browser contexts can disable storage. */ }

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
  const saveMessages = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-30))); } catch { /* The panel remains usable without storage. */ } };

  const hasTask = (employee) => Boolean(typeof employee.task === 'string' ? employee.task.trim() : employee.task?.title || employee.task?.name);
  const createTask = (employee, index) => ({
    id: `task-${employee.id}`,
    employeeId: employee.id,
    departmentId: employee.departmentId,
    title: taskText(employee.task),
    status: /review/i.test(employee.status || '') ? 'review' : /idle|available/i.test(employee.status || '') ? 'queued' : 'running',
    progress: [68, 42, 80, 56, 34, 72, 91][index % 7],
  });
  const tasks = employees.filter(hasTask).map(createTask);

  function contextOptions() {
    return `<option value="office">Whole office</option>${departments.map((department) => `<optgroup label="${esc(department.name)}"><option value="department:${esc(department.id)}">${esc(department.name)}</option>${employees.filter((employee) => employee.departmentId === department.id).map((employee) => `<option value="employee:${esc(employee.id)}">${esc(employee.name)} · ${esc(employee.role)}</option>`).join('')}</optgroup>`).join('')}`;
  }

  element.classList.add('office-sidebar');
  element.setAttribute('aria-label', 'Control center');
  element.innerHTML = `
    <header class="sidebar-heading">
      <div class="sidebar-heading-top"><span class="coordinator-kicker"><i></i> OFFICE COORDINATOR</span><span class="sidebar-demo-label">LOCAL DEMO</span></div>
      <div class="sidebar-title-row"><h1>Control center<span>.</span></h1><span class="coordinator-mark">${icon('center', 22)}</span></div>
      <p><span class="sidebar-coordinator-name">${esc(coordinatorName())}</span> · your office coordinator.</p>
      <div class="sidebar-agent-actions"><button type="button" class="sidebar-roster-button" data-manage-agents>${icon('center', 14)}Agents <span class="sidebar-agent-count">${employees.length + 1}</span></button><button type="button" class="sidebar-add-agent" data-add-agent><span aria-hidden="true">+</span> Add agent</button></div>
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
    <div class="sidebar-demo-note">Interactive preview · no live AI calls</div>`;

  const scroll = element.querySelector('.sidebar-scroll');
  const composerWrap = element.querySelector('.sidebar-composer-wrap');
  const contextSelect = element.querySelector('.sidebar-context-select');

  function renderConfiguration(employee, isCoordinator = false) {
    const config = configurationFor(employee);
    return `<div class="person-configuration"><span class="sidebar-small-label">${employee.isCustom ? 'SAVED CONFIGURATION' : 'AGENT CONFIGURATION'}</span><strong>${esc(config.model)}</strong><p>${esc(config.provider)} · ${esc(config.runtime)}</p><span class="person-config-status">Configured locally · runtime not connected</span></div>
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
      return `<section class="selected-department"><div><i style="background:${esc(department.color || '#628273')}"></i><h2>${esc(department.name)}</h2></div><p>${selectedEmployees().length} specialists · conversation scoped to this team</p><button type="button" class="person-edit" data-add-agent="${esc(department.id)}">Add agent to team<span aria-hidden="true">+</span></button>${selectedEmployees().some(employee => employee.isCustom) ? `<button type="button" class="person-edit" data-focus-extra="${esc(department.id)}">Show additional desks${icon('arrow', 13)}</button>` : ''}</section>`;
    }
    if (selection.type !== 'control') return `<div class="coordinator-quick-settings"><span>${esc(coordinatorName())} coordinates your team</span><button type="button" class="person-edit" data-edit-agent="control">Settings ${icon('arrow', 13)}</button></div>`;
    return `<section class="selected-coordinator"><div class="selected-person-top"><span class="employee-monogram">${esc(initials(coordinatorName()))}</span><div><h2>${esc(coordinatorName())}</h2><p>${esc(coordinator.role || 'Office coordinator')} · Control center</p></div></div>${renderConfiguration(coordinator, true)}</section>`;
  }

  function renderChat() {
    const visibleMessages = messages.slice(-30);
    scroll.innerHTML = `${renderSelection()}
      <div class="chat-conversation" role="log" aria-label="Coordinator conversation" aria-live="polite">
        <div class="coordinator-intro"><div class="chat-avatar">${icon('center', 18)}</div><div><div class="chat-author">${esc(coordinatorName())} <span>DEMO</span></div><p>Good work starts with a clear view.</p><p class="chat-intro-detail">Pick a team on the canvas, or ask me for a quick look around the office.</p></div></div>
        ${visibleMessages.map((message) => `<article class="chat-message ${message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}"><div class="chat-message-meta">${message.role === 'user' ? 'You' : esc(coordinatorName())}${message.role === 'user' && message.context !== 'Whole office' ? `<span>${esc(message.context)}</span>` : ''}</div><p>${esc(message.text)}</p></article>`).join('')}
      </div>
      ${visibleMessages.length ? '' : `<div class="chat-suggestions"><span class="sidebar-small-label">A PLACE TO START</span><button data-suggestion="Summarize team activity"><span>Summarize team activity</span>${icon('arrow', 15)}</button><button data-suggestion="Show tasks to review"><span>Show tasks to review</span>${icon('arrow', 15)}</button><button data-suggestion="How is the team connected?"><span>How is the team connected?</span>${icon('arrow', 15)}</button></div>`}
      ${!visibleMessages.length ? `<div class="chat-office-note"><div class="mini-avatar-stack">${employees.slice(0, 4).map((employee) => `<span>${esc(initials(employee.name))}</span>`).join('')}</div><p>${employees.length} specialists. ${departments.length} departments.<br><span>One place to bring everything together.</span></p></div>` : ''}`;
    composerWrap.hidden = false;
    composerWrap.innerHTML = `<form class="sidebar-composer" aria-label="Message office coordinator"><label class="sr-only" for="coordinator-message">Message the control center</label><textarea id="coordinator-message" rows="2" maxlength="1800" placeholder="Message the control center…">${esc(draft)}</textarea><div class="composer-bottom"><span class="composer-scope">${icon('center', 13)}<span>${esc(contextName())}</span></span><button class="composer-send" type="submit" aria-label="Send message" ${draft.trim() ? '' : 'disabled'}>${icon('send', 18)}</button></div></form><div class="composer-help"><span>Enter to send <span aria-hidden="true">↵</span></span><span>Shift + Enter for a new line</span></div>`;
    const textarea = composerWrap.querySelector('textarea');
    textarea.addEventListener('input', () => {
      draft = textarea.value;
      composerWrap.querySelector('.composer-send').disabled = !draft.trim();
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(textarea.value); }
    });
    composerWrap.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); submitMessage(textarea.value); });
  }

  function responseFor(text) {
    const team = selectedEmployees();
    const teamTasks = tasks.filter((task) => team.some((employee) => employee.id === task.employeeId));
    const review = teamTasks.filter((task) => task.status === 'review');
    if (/connect|model|runtime|headless|wired/i.test(text)) return `The office has ${employees.length} specialists and ${runtimes.length} model and runtime configurations. Open Connections to explore the saved and sample mappings. Configuring an agent does not connect its runtime; no AI runtime is currently connected.`;
    if (/review|approv/i.test(text)) return `${contextName()} has ${review.length} sample ${review.length === 1 ? 'task' : 'tasks'} awaiting review.${review.length ? ` First up: “${review[0].title}.” Open Tasks to inspect the sample output and try the review flow.` : ' There is nothing waiting for review in this view.'} Decisions are stored only for this demo session.`;
    if (/summari|activity|status|working|progress|update/i.test(text)) return `${contextName()}: ${teamTasks.filter((task) => task.status === 'running').length} sample tasks in progress, ${review.length} awaiting review, and ${teamTasks.filter((task) => task.status === 'queued').length} queued.${team[0] && hasTask(team[0]) ? ` ${team[0].name} is assigned to “${taskText(team[0].task)}.”` : ''} ${teamTasks.length ? 'This is a snapshot of the demo data.' : 'No task has been assigned in this view.'}`;
    const receiver = selection.type === 'employee' ? employeeById(selection.id)?.name : selection.type === 'department' ? departmentById(selection.id)?.name : 'the department leads';
    return `Your message is scoped to ${receiver || 'the office'}. The canvas pulse shows the communication route. This is a local interaction preview, so no AI request was sent and no work was started. You can explore sample activity, task reviews, and runtime mappings here.`;
  }

  function submitMessage(raw) {
    const value = String(raw || '').trim().slice(0, 1800);
    if (!value) return;
    draft = '';
    messages.push({ role: 'user', text: value, context: contextName() });
    messages.push({ role: 'assistant', text: responseFor(value), context: contextName() });
    messages = messages.slice(-30);
    saveMessages();
    const targets = selection.type === 'employee' || selection.type === 'department' ? [selection.id] : departments.slice(0, 3).map((department) => department.id);
    targets.forEach((target) => onCommunication({ from: 'control', to: target, message: value }));
    render();
    scroll.scrollTop = scroll.scrollHeight;
    composerWrap.querySelector('textarea')?.focus();
  }

  function renderTasks() {
    const teamIds = new Set(selectedEmployees().map((employee) => employee.id));
    const scopedTasks = tasks.filter((task) => teamIds.has(task.employeeId));
    const filteredTasks = scopedTasks.filter((task) => taskFilter === 'all' || task.status === taskFilter);
    const reviews = scopedTasks.filter((task) => task.status === 'review').length;
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Team workspace</h2><p>Small steps. Visible progress.</p></div><span class="sample-pill">SAMPLE DATA</span></div>
      <div class="task-filter-row" aria-label="Filter tasks">${[['all', 'All'], ['review', 'Review'], ['running', 'Running'], ['done', 'Done']].map(([id, label]) => `<button class="task-filter ${taskFilter === id ? 'is-active' : ''}" data-task-filter="${id}" aria-pressed="${taskFilter === id}">${label}<span>${id === 'all' ? scopedTasks.length : scopedTasks.filter((task) => task.status === id).length}</span></button>`).join('')}</div>
      ${reviews && taskFilter === 'all' ? `<p class="task-review-notice"><i></i>${reviews} ${reviews === 1 ? 'task needs' : 'tasks need'} a second look</p>` : ''}
      <div class="sidebar-task-list">${filteredTasks.length ? filteredTasks.sort((a, b) => (a.status === 'review' ? 0 : 1) - (b.status === 'review' ? 0 : 1)).map((task) => {
        const employee = employeeById(task.employeeId);
        const department = departmentById(task.departmentId);
        const expanded = expandedTask === task.id;
        return `<article class="sidebar-task ${expanded ? 'is-expanded' : ''}"><button class="task-summary" data-task="${esc(task.id)}" aria-expanded="${expanded}" aria-controls="details-${esc(task.id)}"><span class="task-state-dot task-state-${task.status}">${task.status === 'done' ? icon('check', 10) : ''}</span><span class="task-summary-content"><span class="task-title">${esc(task.title)}</span><span class="task-byline">${esc(department?.name || '')} <span>·</span> ${esc(employee?.name || '')}</span><span class="task-status-label task-status-${task.status}">${{ review: 'Needs review', running: `In progress · ${task.progress}%`, queued: 'In the queue', done: 'Approved in demo' }[task.status]}</span>${task.status === 'running' ? `<span class="task-progress-track"><span style="width:${task.progress}%;background:${esc(department?.color || '#628273')}"></span></span>` : ''}</span><span class="task-chevron">${icon('chevron', 14)}</span></button>
          ${expanded ? `<div class="task-details" id="details-${esc(task.id)}"><span class="sidebar-small-label">SAMPLE OUTPUT</span><p>A working draft for “${esc(task.title)}” is ready for a first pass. The proposed approach, key observations, and next steps would appear here when a runtime is connected.</p><div class="task-detail-actions">${task.status === 'review' ? `<button class="task-approve" data-task-action="approve" data-id="${esc(task.id)}">${icon('check', 14)}Approve</button><button class="task-revise" data-task-action="revise" data-id="${esc(task.id)}">Request changes</button>` : `<button class="task-revise" data-focus="employee" data-id="${esc(task.employeeId)}">${icon('focus', 14)}Find employee</button>`}</div><small>Demo interaction. No external task will be changed.</small></div>` : ''}</article>`;
      }).join('') : '<div class="sidebar-empty"><span>All clear.</span><p>No sample tasks in this view.</p></div>'}</div>
      ${activities.length ? `<div class="sidebar-local-activity"><span class="sidebar-small-label">RECENT CANVAS ACTIVITY</span>${activities.slice(-3).reverse().map((activity) => `<p><i></i>${esc(activity.message || activity.label || 'Communication preview')}</p>`).join('')}</div>` : ''}`;
    composerWrap.hidden = true;
  }

  function renderConnections() {
    const scopedIds = new Set(selectedEmployees().map((employee) => employee.runtimeId));
    const scopedRuntimes = selection.type === 'department' || selection.type === 'employee' ? runtimes.filter((runtime) => scopedIds.has(runtime.id)) : runtimes;
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Behind the office</h2><p>Models, providers, and runtimes.</p></div>${icon('link', 20)}</div>
      <div class="connection-overview"><span class="connection-overview-mark">${icon('center', 20)}</span><div><strong>${esc(coordinatorName())} · Control center</strong><p>Routes your request to the right specialist</p></div><span class="connection-overview-line"></span><span class="connection-overview-count">${scopedRuntimes.length}<small>CONFIGS</small></span></div>
      <p class="connection-explainer">${scopedRuntimes.filter((runtime) => runtime.status === 'configured').length} saved configurations · ${scopedRuntimes.filter((runtime) => runtime.status !== 'configured').length} sample mappings. No runtime is connected and no AI calls are sent.</p>
      <div class="connection-list">${scopedRuntimes.length ? scopedRuntimes.map((runtime) => {
        const connectedEmployees = employees.filter((employee) => employee.runtimeId === runtime.id);
        const includesCoordinator = coordinator.runtimeId === runtime.id;
        const connectedDepartments = departments.filter((department) => connectedEmployees.some((employee) => employee.departmentId === department.id));
        const expanded = expandedRuntime === runtime.id;
        return `<article class="runtime-item ${expanded ? 'is-expanded' : ''}"><button class="runtime-summary" data-runtime="${esc(runtime.id)}" aria-expanded="${expanded}" aria-controls="runtime-details-${esc(runtime.id)}"><span class="runtime-monogram">${esc(initials(runtime.name).slice(0, 2))}</span><span class="runtime-main"><strong>${esc(runtime.name)}</strong><span>${esc(runtime.model || runtime.kind || 'Model configuration')}</span></span><span class="runtime-demo">${runtime.status === 'configured' ? 'Saved' : 'Demo'}</span><span class="task-chevron">${icon('chevron', 14)}</span></button><div class="runtime-assignment-preview">${includesCoordinator ? `<button data-focus="control" data-id="control">${esc(coordinatorName())}</button>` : ''}${connectedDepartments.map((department) => `<button data-focus="department" data-id="${esc(department.id)}"><i style="background:${esc(department.color || '#628273')}"></i>${esc(department.name)}</button>`).join('') || (includesCoordinator ? '' : '<span>No employees assigned</span>')}</div>
          ${expanded ? `<div class="runtime-details" id="runtime-details-${esc(runtime.id)}"><dl><div><dt>Model</dt><dd>${esc(runtime.model || 'Not specified')}</dd></div><div><dt>Provider</dt><dd>${esc(runtime.provider || 'Not specified')}</dd></div><div><dt>Runtime</dt><dd>${esc(runtime.runtime || runtime.kind || runtime.name)}</dd></div><div><dt>Connection</dt><dd>${runtime.status === 'configured' ? 'Saved locally' : 'Sample mapping'} · not connected</dd></div></dl>${runtime.description ? `<p>${esc(runtime.description)}</p>` : ''}<span class="sidebar-small-label">ASSIGNED AGENTS · ${connectedEmployees.length + (includesCoordinator ? 1 : 0)}</span><div class="runtime-employees">${includesCoordinator ? `<button data-focus="control" data-id="control"><span>${esc(initials(coordinatorName()))}</span>${esc(coordinatorName())}${icon('arrow', 12)}</button>` : ''}${connectedEmployees.map((employee) => `<button data-focus="employee" data-id="${esc(employee.id)}"><span>${esc(initials(employee.name))}</span>${esc(employee.name)}${icon('arrow', 12)}</button>`).join('') || (includesCoordinator ? '' : '<p>No assigned agents.</p>')}</div></div>` : ''}</article>`;
      }).join('') : '<div class="sidebar-empty"><span>No runtime assigned.</span><p>This specialist is waiting for a configuration.</p></div>'}</div>
      <div class="connection-route-note">${icon('sparkle', 16)}<p>Your message → control center → specialist.<br><span>Canvas pulses make the route visible.</span></p></div>`;
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
    const oldTasks = new Map(tasks.map((task) => [task.employeeId, task]));
    const nextTasks = employees.filter(hasTask).map((employee, index) => {
      const existing = oldTasks.get(employee.id);
      return existing ? { ...existing, departmentId: employee.departmentId, title: taskText(employee.task) } : createTask(employee, index);
    });
    tasks.splice(0, tasks.length, ...nextTasks);
    if (selection.type === 'employee' && !employeeById(selection.id) || selection.type === 'department' && !departmentById(selection.id)) selection = { type: 'office' };
    if (expandedTask && !tasks.some((task) => task.id === expandedTask)) expandedTask = null;
    if (expandedRuntime && !runtimeById(expandedRuntime)) expandedRuntime = null;
    contextSelect.innerHTML = contextOptions();
    element.querySelector('.sidebar-agent-count').textContent = String(employees.length + 1);
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
    else if (button.dataset.suggestion) submitMessage(button.dataset.suggestion);
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
    } else if (button.dataset.taskAction) {
      const task = tasks.find((item) => item.id === button.dataset.id);
      if (!task) return;
      task.status = button.dataset.taskAction === 'approve' ? 'done' : 'running';
      if (button.dataset.taskAction === 'revise') task.progress = 15;
      onCommunication({ from: 'control', to: task.employeeId, message: button.dataset.taskAction === 'approve' ? 'Demo review approved' : 'Demo revision requested' });
      render();
      element.dispatchEvent(new CustomEvent('office:reviews-changed', { bubbles: true, detail: { count: tasks.filter((item) => item.status === 'review').length, employeeId: task.employeeId, status: task.status === 'done' ? 'idle' : 'working' } }));
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
    addActivity(event) { activities.push({ ...(event || {}), at: Date.now() }); activities = activities.slice(-12); if (activeTab === 'tasks') render(); },
    destroy() { destroyed = true; element.replaceChildren(); },
  };
}
