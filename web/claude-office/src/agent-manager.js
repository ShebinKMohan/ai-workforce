const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{ plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', arrow: '<path d="m9 5-7 7 7 7M2 12h19"/>', focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>', edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>', check: '<path d="m5 12 4 4L19 6"/>', archive: '<path d="M4 8v12h16V8M3 3h18v5H3zM9 12h6"/>', copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2"/>' }[name] || ''}</svg>`;
const colors = { blue: '#56809e', rose: '#a16b79', sand: '#9c7e45', lavender: '#8774a2', sage: '#608672', slate: '#6e7886' };
const initialLetters = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const defaultInstructions = { head: 'Read the request and the project. Split the work into small tasks that each have a clear check, and assign each task to one of your workers.', worker: 'Inspect the relevant code, fix the underlying issue, and submit evidence against the task criteria.' };

/** The directory edits configuration. Running tasks retain their saved agent snapshot. */
export function createAgentManager({ element, store, onFocus = () => {}, onSaved = () => {}, onArchived = () => {}, onClose = () => {} }) {
  let active = false;
  let currentAgent = null;
  let replacementId = null;
  let departmentFilter = '';
  let archivedFilter = false;
  let searchQuery = '';
  let opener = null;
  let formRevision = 0;
  let saving = false;
  let pendingArchive = null;
  element.classList.add('agent-manager');
  element.setAttribute('aria-label', 'Agent directory and settings');
  element.hidden = true;
  const departmentName = (id) => {
    const department = store.departments.find((item) => item.id === id);
    return department ? `${department.name}${department.note ? ` · ${department.note}` : ''}` : 'Archived department';
  };
  const runtimeName = (agent) => store.runtimeBindings.find((binding) => binding.id === agent.workspaceRuntimeId)?.name || agent.workspaceRuntimeId || 'Runtime unavailable';
  function open() {
    if (!active) opener = document.activeElement;
    active = true;
    element.hidden = false;
    document.body.classList.add('manager-open');
  }
  function hide() {
    active = false;
    element.hidden = true;
    if (![...document.querySelectorAll('.agent-manager')].some((manager) => manager !== element && !manager.hidden)) document.body.classList.remove('manager-open');
  }
  function close() { if (saving) return; hide(); onClose(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  function header(title, description, { form = false } = {}) {
    return `<header class="am-header"><div class="am-kicker">${form ? `<button type="button" class="am-back" data-am="directory">${icon('arrow')}All agents</button>` : `${icon('people')}<span>WORKFORCE</span>`}<button type="button" class="am-icon-button" data-am="close" aria-label="Close agent settings">${icon('close')}</button></div><div class="am-heading-row"><h1 id="am-title">${esc(title)}</h1>${!form ? `<button type="button" class="am-button am-primary am-add" data-am="create">${icon('plus')}Add agent</button>` : ''}</div><p>${esc(description)}</p></header>`;
  }
  function archivePrompt(agent) {
    return `<div class="am-archive-confirm" role="group" aria-label="Confirm archive ${esc(agent.name)}"><strong>Archive ${esc(agent.name)}?</strong><p>This removes the agent from the active directory and workspace. Its configuration and task history remain available. Existing runs keep their saved configuration.${agent.role === 'head' ? ` <strong>${esc(departmentName(agent.departmentId))} will accept no new requests until a new head is added.</strong>` : ''}</p><div class="am-inline-actions"><button type="button" class="am-button am-danger" data-am="confirm-archive" data-agent-id="${esc(agent.id)}">Archive agent</button><button type="button" class="am-button am-secondary" data-am="cancel-archive">Cancel</button></div><p class="am-field-error" data-archive-error role="alert" hidden></p></div>`;
  }
  function renderRows() {
    const allAgents = store.list({ archived: archivedFilter });
    const query = searchQuery.trim().toLocaleLowerCase();
    const visible = allAgents.filter((agent) => (!departmentFilter || agent.departmentId === departmentFilter) && (!query || [agent.name, agent.role, agent.model, departmentName(agent.departmentId), runtimeName(agent)].join(' ').toLocaleLowerCase().includes(query)));
    element.querySelector('.am-results-count').textContent = `${visible.length} ${archivedFilter ? 'archived ' : ''}${visible.length === 1 ? 'agent' : 'agents'}${visible.length !== allAgents.length ? ` of ${allAgents.length}` : ''}`;
    element.querySelector('.am-agent-list').innerHTML = visible.length ? visible.map((agent) => {
      const department = store.departments.find((item) => item.id === agent.departmentId);
      const color = colors[department?.color] || (/^#[0-9a-f]{6}$/i.test(department?.color || '') ? department.color : colors.sage);
      const projects = (agent.projectIds || []).map((id) => store.projects.find((project) => project.id === id)?.name).filter(Boolean);
      const status = agent.archived ? 'Archived' : agent.role === 'head' ? 'Department head' : projects.length ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}` : 'No projects';
      return `<article class="am-agent-card" data-agent-row="${esc(agent.id)}"><div class="am-agent-identity"><span class="am-avatar" style="--am-person-color:${color}">${esc(initialLetters(agent.name))}</span><div><h2>${esc(agent.name)}</h2><p>${esc(departmentName(agent.departmentId))}</p></div><span class="am-role-chip ${!agent.archived && agent.role === 'worker' && !projects.length ? 'am-chip-warning' : ''}">${esc(status)}</span></div><div class="am-agent-model"><span>${esc(runtimeName(agent))}</span><strong>${esc(agent.model || 'Runtime default')}</strong></div><div class="am-agent-meta"><span>${esc(agent.archived ? 'Kept for history' : agent.role === 'head' ? 'Plans and delegates · Analysis policy' : projects.join(', ') || 'Assign a project to receive work')}</span>${!agent.archived && agent.statusLabel && !['Configured', 'On the bench'].includes(agent.statusLabel) ? `<span class="am-agent-status">${esc(agent.statusLabel)}</span>` : ''}</div><div class="am-card-actions">${agent.archived ? `<button type="button" class="am-button am-secondary" data-am="inspect" data-agent-id="${esc(agent.id)}">View configuration</button>` : `<button type="button" class="am-button am-secondary" data-am="edit" data-agent-id="${esc(agent.id)}" aria-label="Edit ${esc(agent.name)}">${icon('edit')}Edit</button><button type="button" class="am-button am-quiet" data-am="focus" data-agent-id="${esc(agent.id)}" aria-label="Focus ${esc(agent.name)}">${icon('focus')}Focus</button><button type="button" class="am-icon-button am-row-archive" data-am="archive" data-agent-id="${esc(agent.id)}" aria-label="Archive ${esc(agent.name)}" title="Archive agent">${icon('archive')}</button>`}</div>${pendingArchive?.id === agent.id ? archivePrompt(agent) : ''}</article>`;
    }).join('') : `<div class="am-empty">${icon(archivedFilter ? 'archive' : 'people')}<h2>${archivedFilter ? 'No archived agents' : allAgents.length ? 'No matching agents' : 'Build your workforce'}</h2><p>${archivedFilter ? 'Archived agents remain here with their saved configuration.' : allAgents.length ? 'Try another name, runtime, or department.' : 'Add a worker, choose its runtime, and assign the projects it can work on.'}</p>${query || departmentFilter ? '<button class="am-button am-secondary" type="button" data-am="reset-filters">Clear filters</button>' : !archivedFilter ? '<button class="am-button am-secondary" type="button" data-am="create">Add agent</button>' : ''}</div>`;
  }
  function showDirectory({ departmentId, message = '' } = {}) {
    currentAgent = null;
    replacementId = null;
    pendingArchive = null;
    if (departmentId !== undefined) departmentFilter = store.departments.some((department) => department.id === departmentId) ? departmentId : '';
    open();
    const headless = store.departments.filter((department) => !store.list().some((agent) => agent.role === 'head' && agent.departmentId === department.id));
    element.innerHTML = `${header('Agents', 'Configure roles, runtime bindings, and project access.')}<div class="am-directory-tools"><div class="am-filter-tabs" aria-label="Agent status"><button type="button" data-am="active-filter" aria-pressed="${!archivedFilter}">Active <span>${store.list().length}</span></button><button type="button" data-am="archived-filter" aria-pressed="${archivedFilter}">Archived <span>${store.list({ archived: true }).length}</span></button></div><label class="am-search">${icon('search')}<span class="am-sr-only">Search agents</span><input type="search" id="am-search" placeholder="Search agents or runtimes" autocomplete="off" value="${esc(searchQuery)}"></label><label class="am-sr-only" for="am-department-filter">Filter by department</label><select id="am-department-filter"><option value="">All departments</option>${store.departments.map((department) => `<option value="${esc(department.id)}" ${departmentFilter === department.id ? 'selected' : ''}>${esc(departmentName(department.id))}</option>`).join('')}</select><div class="am-results-row"><span class="am-results-count" role="status"></span><span>LOCAL CONFIGURATION</span></div></div><div class="am-scroll am-directory-scroll">${message ? `<div class="am-success" role="status">${icon('check')}<span>${esc(message)}</span></div>` : ''}${!archivedFilter ? headless.map((department) => `<div class="am-headless"><div><strong>${esc(departmentName(department.id))}</strong><p>Add a head to route new requests.</p></div><button type="button" class="am-button am-secondary" data-am="add-head" data-department-id="${esc(department.id)}">Add head</button></div>`).join('') : ''}<div class="am-agent-list"></div></div><p class="am-footnote">${archivedFilter ? 'Archive keeps history. Create from a saved configuration to add a new agent with a new identity.' : 'Changes apply to future work. Running tasks retain their saved configuration.'}</p>`;
    renderRows();
    element.querySelector('#am-search').addEventListener('input', (event) => { searchQuery = event.target.value; pendingArchive = null; renderRows(); });
    element.querySelector('#am-department-filter').addEventListener('change', (event) => { departmentFilter = event.target.value; pendingArchive = null; renderRows(); });
    element.querySelector('#am-search').focus({ preventScroll: true });
  }
  function field(name, label, control, hint = '') {
    return `<div class="am-field" data-field="${name}"><label for="am-${name}">${label}</label>${control}${hint ? `<p class="am-hint" id="am-${name}-hint">${hint}</p>` : ''}<p class="am-field-error" id="am-${name}-error" hidden></p></div>`;
  }
  function textField(name, label, value, { required = false, placeholder = '', hint = '', maxLength = 128 } = {}) {
    return field(name, label, `<input id="am-${name}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${maxLength}" ${required ? 'required' : ''} ${hint ? `aria-describedby="am-${name}-hint"` : ''} autocomplete="off">`, hint);
  }
  function showForm(agent, requestedDepartmentId, { copy = false, replace = false, role = 'worker' } = {}) {
    currentAgent = copy || replace ? null : agent;
    replacementId = replace ? agent.id : null;
    pendingArchive = null;
    formRevision = store.revision;
    const values = agent ? { ...agent, name: replace ? `${departmentName(agent.departmentId)} head` : copy ? `${agent.name} copy` : agent.name, model: agent.modelOverride ?? '' } : { name: '', role, departmentId: store.departments.some((department) => department.id === requestedDepartmentId) ? requestedDepartmentId : store.departments[0]?.id || '', model: '', workspaceRuntimeId: store.runtimeBindings.find((binding) => binding.configured)?.id || 'codex-local', instructions: defaultInstructions[role], projectIds: [] };
    const head = values.role === 'head';
    const title = replace ? 'Replace department head' : currentAgent ? 'Agent settings' : copy ? 'Create from configuration' : head ? 'Add department head' : 'Add agent';
    open();
    if (!store.departments.length) {
      element.innerHTML = `${header(title, 'A department owns the head and its workers.', { form: true })}<div class="am-scroll am-form-scroll"><div class="am-empty"><h2>Create a department first</h2><p>Use Add department in the workspace to create a team and its head, then add workers here.</p><button type="button" class="am-button am-secondary" data-am="close">Back to workspace</button></div></div>`;
      return;
    }
    const availableDepartments = head && !agent ? store.departments.filter((department) => !store.list().some((item) => item.role === 'head' && item.departmentId === department.id)) : store.departments;
    element.innerHTML = `${header(title, currentAgent ? `${agent.name} · ${head ? 'Department head' : 'Worker'}` : 'Define the role, then connect it to your local tools.', { form: true })}<form class="am-form" id="am-agent-form" novalidate><div class="am-scroll am-form-scroll">${replace ? `<div class="am-local-note"><p><strong>One atomic replacement</strong><br>${esc(agent.name)} will be archived and the new head assigned together. Previous task history is preserved.</p></div>` : copy ? '<div class="am-local-note"><p><strong>A new agent identity</strong><br>The saved configuration is copied. Existing task history stays with the original agent.</p></div>' : ''}<div id="am-form-error" class="am-form-error" role="alert" tabindex="-1" hidden></div><fieldset class="am-section"><legend>Identity & role</legend>${textField('name', 'Agent name', values.name, { required: true, placeholder: 'e.g. Frontend engineer', maxLength: 60 })}<input type="hidden" name="role" value="${head ? 'head' : 'worker'}"><div class="am-role-description"><strong>${head ? 'Department head' : 'Worker'}</strong><span>${head ? 'Plans and delegates · Analysis policy' : 'Executes assigned tasks · Local development policy'}</span></div>${field('departmentId', 'Department', `<select id="am-departmentId" name="departmentId" required ${head && agent ? 'disabled' : ''}>${availableDepartments.map((department) => `<option value="${esc(department.id)}" ${values.departmentId === department.id ? 'selected' : ''}>${esc(departmentName(department.id))}</option>`).join('')}</select>`, head ? 'A department has one head. Its workers determine project access.' : 'Requests reach this department’s head before being delegated to workers.')}</fieldset><fieldset class="am-section"><legend>Runtime binding</legend>${field('runtime', 'Installed coding runtime', `<select id="am-runtime" name="workspaceRuntimeId" aria-describedby="am-runtime-hint">${store.runtimeBindings.map((binding) => `<option value="${esc(binding.id)}" ${binding.id === values.workspaceRuntimeId ? 'selected' : ''}>${esc(binding.name)}</option>`).join('')}</select>`, 'Uses the CLI’s existing sign-in and configuration.')}<div class="am-runtime-detail" data-runtime-detail role="status"></div>${textField('model', 'Model override (optional)', values.model, { placeholder: 'Runtime configured default', maxLength: 128, hint: 'Leave empty to inherit the selected runtime’s model. Enter an exact model ID only when supported by that CLI.' })}</fieldset>${!head ? `<fieldset class="am-section"><legend>Project access</legend>${field('projectIds', 'Projects this worker can receive', `<div class="am-project-options" id="am-projectIds">${store.projects.map((project) => `<label><input type="checkbox" name="projectIds" value="${esc(project.id)}" ${(values.projectIds || []).includes(project.id) ? 'checked' : ''}><span><strong>${esc(project.name)}</strong><small>${esc(project.repoPath || project.id)}</small></span></label>`).join('') || '<p>No registered projects. Add a project in the workspace, then assign it here.</p>'}</div>`, 'With no project selected, this agent receives no work. Changes do not alter running task snapshots.')}</fieldset>` : ''}<fieldset class="am-section"><legend>Instructions</legend>${field('instructions', 'Responsibilities & working rules', `<textarea id="am-instructions" name="instructions" rows="7" maxlength="12000" required aria-describedby="am-instructions-hint">${esc(values.instructions)}</textarea>`, 'Describe responsibilities, scope, and the evidence required for a good result.')}</fieldset>${currentAgent ? `<section class="am-lifecycle"><h2>Agent lifecycle</h2><p>Archive removes this agent from the active workspace while preserving its history.</p><div class="am-inline-actions">${head ? `<button type="button" class="am-button am-secondary" data-am="replace-head" data-agent-id="${esc(agent.id)}">Replace head</button>` : `<button type="button" class="am-button am-secondary" data-am="duplicate" data-agent-id="${esc(agent.id)}">${icon('copy')}Duplicate</button>`}<button type="button" class="am-button am-danger-quiet" data-am="archive" data-agent-id="${esc(agent.id)}">${icon('archive')}Archive agent</button></div><div data-form-archive></div></section>` : ''}</div><footer class="am-form-footer"><button type="button" class="am-button am-secondary" data-am="directory">Cancel</button><button type="submit" class="am-button am-primary">${replace ? 'Replace head' : currentAgent ? 'Save changes' : 'Create agent'}${icon(currentAgent || replace ? 'check' : 'plus')}</button></footer></form>`;
    const form = element.querySelector('form');
    form.addEventListener('submit', submitForm);
    form.addEventListener('input', (event) => { if (event.target.name) clearFieldError(event.target.name === 'workspaceRuntimeId' ? 'runtime' : event.target.name); });
    const showRuntime = () => {
      const binding = store.runtimeBindings.find((item) => item.id === form.elements.workspaceRuntimeId.value);
      const detail = element.querySelector('[data-runtime-detail]');
      detail.innerHTML = binding ? `<span class="am-status-dot ${binding.ready ? 'is-ready' : ''}"></span><div><strong>${esc(binding.status)}</strong><p>${esc(binding.executable || (binding.adapter === 'codex' ? 'codex' : 'claude'))}${binding.model ? `<br>Default model: ${esc(binding.model)}` : ''}</p><small>Passive check · execution is verified when work runs</small></div>` : '<p>This runtime binding is unavailable.</p>';
    };
    form.elements.workspaceRuntimeId.addEventListener('change', showRuntime);
    showRuntime();
    element.querySelector('#am-name').focus({ preventScroll: true });
  }
  function showArchived(agent) {
    open();
    currentAgent = null;
    const canCopy = store.departments.some((department) => department.id === agent.departmentId) && (agent.role !== 'head' || !store.list().some((item) => item.role === 'head' && item.departmentId === agent.departmentId));
    element.innerHTML = `${header(agent.name, 'Archived configuration · preserved for history', { form: true })}<div class="am-scroll am-form-scroll"><dl class="am-config-summary"><dt>Role</dt><dd>${esc(agent.role === 'head' ? 'Department head' : 'Worker')}</dd><dt>Department</dt><dd>${esc(departmentName(agent.departmentId))}</dd><dt>Runtime</dt><dd>${esc(runtimeName(agent))}</dd><dt>Model</dt><dd>${esc(agent.model || 'Runtime default')}</dd></dl><fieldset class="am-section"><legend>Saved instructions</legend><pre class="am-saved-instructions">${esc(agent.instructions)}</pre></fieldset><p class="am-hint">This agent cannot receive new work. Its configuration and history remain saved.${!canCopy ? ' A head already exists or the original department is no longer active.' : ' Create from this configuration to add a new agent with a new identity.'}</p></div><footer class="am-form-footer"><button type="button" class="am-button am-secondary" data-am="directory">Back</button>${canCopy ? `<button type="button" class="am-button am-primary" data-am="duplicate" data-agent-id="${esc(agent.id)}">Create from configuration</button>` : ''}</footer>`;
  }
  function clearFieldError(name) {
    const input = element.querySelector(`#am-${name}`);
    const error = element.querySelector(`#am-${name}-error`);
    if (!input || !error) return;
    input.removeAttribute('aria-invalid');
    error.hidden = true;
  }
  function showError(error) {
    const box = element.querySelector('#am-form-error');
    box.textContent = error.message || 'The agent could not be saved.';
    box.hidden = false;
    let first;
    for (const [name, message] of Object.entries(error.fields || {})) {
      const input = element.querySelector(`#am-${name}`);
      const detail = element.querySelector(`#am-${name}-error`);
      if (!input || !detail) continue;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', detail.id);
      detail.textContent = message;
      detail.hidden = false;
      first ||= input.matches('input,textarea,select') ? input : input.querySelector('input');
    }
    (first || box).focus({ preventScroll: true });
    (first || box).scrollIntoView({ block: 'nearest' });
  }
  async function submitForm(event) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = { ...Object.fromEntries(data), projectIds: data.getAll('projectIds'), expectRevision: formRevision, ...(currentAgent ? { id: currentAgent.id } : {}), ...(replacementId ? { replaceId: replacementId } : {}) };
    if (form.elements.departmentId.disabled) values.departmentId = form.elements.departmentId.value;
    for (const name of ['name', 'departmentId', 'runtime', 'model', 'instructions', 'projectIds']) clearFieldError(name);
    element.querySelector('#am-form-error').hidden = true;
    saving = true;
    element.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const wasEdit = Boolean(currentAgent);
    const wasReplacement = Boolean(replacementId);
    try {
      const saved = await store.save(values);
      saving = false;
      try { await onSaved(saved); } catch { /* The committed operation must not be retried because a view refresh failed. */ }
      departmentFilter = ''; searchQuery = ''; archivedFilter = false;
      showDirectory({ message: `${saved.name} ${wasReplacement ? 'assigned as head' : wasEdit ? 'updated' : 'created'}. ${store.storageWarning || 'Saved for future work.'}` });
    } catch (error) {
      saving = false;
      element.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      if (['workspace_revision_conflict', 'workspace_changed_on_disk'].includes(error.code)) {
        try { await store.refresh(); formRevision = store.revision; error.message = 'The workspace changed while you were editing. Your draft is preserved. Review it and save again against the latest revision.'; } catch { error.message = 'The workspace changed and could not be refreshed. Your draft is preserved. Reopen settings when the server is available.'; }
      }
      showError(error);
    }
  }
  async function commitArchive(id) {
    if (!pendingArchive || pendingArchive.id !== id || saving) return;
    saving = true;
    element.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const saved = await store.archive(id, pendingArchive.revision);
      saving = false;
      try { await onArchived(saved); } catch { /* Archiving already succeeded. */ }
      showDirectory({ message: `${saved.name} archived. Configuration and task history are preserved.` });
    } catch (error) {
      saving = false;
      element.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      const box = element.querySelector('[data-archive-error]');
      if (box) { box.hidden = false; box.textContent = ['workspace_revision_conflict', 'workspace_changed_on_disk'].includes(error.code) ? 'The workspace changed. Reopen the directory before archiving this agent.' : error.message; }
    }
  }
  element.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-am]');
    if (!button || !element.contains(button) || saving) return;
    const action = button.dataset.am;
    const agent = button.dataset.agentId ? store.get(button.dataset.agentId, { includeArchived: true }) : null;
    if (action === 'close') close();
    else if (action === 'directory') showDirectory();
    else if (action === 'create') showForm(null, departmentFilter);
    else if (action === 'add-head') showForm(null, button.dataset.departmentId, { role: 'head' });
    else if (action === 'edit' && agent) showForm(agent);
    else if (action === 'inspect' && agent) showArchived(agent);
    else if (action === 'duplicate' && agent) showForm(agent, agent.departmentId, { copy: true });
    else if (action === 'replace-head' && agent) showForm(agent, agent.departmentId, { replace: true });
    else if (action === 'archive' && agent && !agent.archived) {
      pendingArchive = { id: agent.id, revision: currentAgent ? formRevision : store.revision };
      const formSlot = element.querySelector('[data-form-archive]');
      if (formSlot) formSlot.innerHTML = archivePrompt(agent); else renderRows();
      element.querySelector('[data-am="confirm-archive"]')?.focus({ preventScroll: true });
      element.querySelector('.am-archive-confirm')?.scrollIntoView({ block: 'nearest' });
    } else if (action === 'cancel-archive') { pendingArchive = null; const slot = element.querySelector('[data-form-archive]'); if (slot) slot.innerHTML = ''; else renderRows(); }
    else if (action === 'confirm-archive') commitArchive(button.dataset.agentId);
    else if (action === 'active-filter' || action === 'archived-filter') { archivedFilter = action === 'archived-filter'; showDirectory(); }
    else if (action === 'focus' && agent) { close(); onFocus({ type: 'employee', id: agent.id }); }
    else if (action === 'reset-filters') { searchQuery = ''; departmentFilter = ''; showDirectory(); }
  });
  element.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); if (!saving) close(); } });
  return { showDirectory, showCreate(departmentId) { showForm(null, departmentId); }, showEdit(id) { const agent = store.get(id); if (agent?.isCoordinator) showDirectory({ message: 'The coordinator is the system scheduler. Edit a department head to change its model and instructions.' }); else if (agent) showForm(agent); }, isOpen: () => active, hide };
}
