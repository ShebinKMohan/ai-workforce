const escapeHTML = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const providers = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['ollama', 'Ollama'], ['custom', 'Custom provider']];
const runtimes = [['codex-cli', 'Codex CLI'], ['claude-code', 'Claude Code'], ['ollama', 'Ollama'], ['api', 'Direct model API']];
const examples = { openai: [], anthropic: [], google: [], ollama: [], custom: [] };
const runtimeDefaults = { openai: 'codex-cli', anthropic: 'claude-code', google: 'api', ollama: 'ollama', custom: 'api' };
const icon = (name) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{ plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', arrow: '<path d="m9 5-7 7 7 7M2 12h19"/>', focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="3"/>', edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>', check: '<path d="m5 12 4 4L19 6"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2"/>' }[name] || ''}</svg>`;

/** Local agent configuration UI. Runtime execution belongs to the host application. */
export function createAgentManager({ element, store, onFocus = () => {}, onSaved = () => {}, onClose = () => {} }) {
  let active = false;
  let currentAgent = null;
  let departmentFilter = '';
  let searchQuery = '';
  let opener = null;
  let runtimeTouched = false;
  let previousProvider = 'openai';
  let formRevision = 0;
  let saving = false;
  element.classList.add('agent-manager');
  element.setAttribute('aria-label', 'Agent directory and settings');
  element.hidden = true;
  const departmentName = (id) => id === 'control' ? 'Control center' : (store.departments.find((department) => department.id === id)?.name || 'Unassigned');
  const initialLetters = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');

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

  function header(title, description, { form = false } = {}) {
    return `<header class="am-header"><div class="am-kicker">${form ? '<button type="button" class="am-back" data-am="directory">' + icon('arrow') + 'All agents</button>' : icon('people') + '<span>YOUR WORKFORCE</span>'}<button type="button" class="am-icon-button" data-am="close" aria-label="Close agent settings">${icon('close')}</button></div><div class="am-heading-row"><h1 id="am-title">${escapeHTML(title)}</h1>${!form ? '<button type="button" class="am-button am-primary am-add" data-am="create">' + icon('plus') + 'Add agent</button>' : ''}</div><p>${escapeHTML(description)}</p></header>`;
  }

  function renderRows() {
    const allAgents = store.list();
    const query = searchQuery.trim().toLocaleLowerCase();
    const visible = allAgents.filter((agent) => (!departmentFilter || agent.departmentId === departmentFilter) && (!query || [agent.name, agent.role, agent.model, departmentName(agent.departmentId), agent.customProvider, agent.provider].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
    element.querySelector('.am-results-count').textContent = `${visible.length} ${visible.length === 1 ? 'agent' : 'agents'}${visible.length !== allAgents.length ? ` of ${allAgents.length}` : ''}`;
    element.querySelector('.am-agent-list').innerHTML = visible.length ? visible.map((agent) => {
      const department = store.departments.find((item) => item.id === agent.departmentId);
      const provider = agent.provider === 'custom' ? (agent.customProvider || 'Custom') : (providers.find(([id]) => id === agent.provider)?.[1] || agent.provider || 'Unassigned');
      const runtime = runtimes.find(([id]) => id === agent.runtime)?.[1] || agent.runtime || 'No runtime';
      const locallySaved = Boolean(agent.isCustom);
      return `<article class="am-agent-card"><div class="am-agent-identity"><span class="am-avatar" style="--am-person-color:${escapeHTML(department?.color || '#638270')}">${escapeHTML(initialLetters(agent.name))}</span><div><h2>${escapeHTML(agent.name)}</h2><p>${escapeHTML(agent.role)}<span aria-hidden="true"> · </span>${escapeHTML(departmentName(agent.departmentId))}</p></div></div><div class="am-agent-model"><span>${escapeHTML(provider)}</span><strong>${escapeHTML(agent.model || 'Model not set')}</strong></div><div class="am-agent-meta"><span>${escapeHTML(runtime)}</span><span class="am-agent-status">${escapeHTML(agent.statusLabel || agent.status || 'Configured')}</span></div><div class="am-card-actions"><button type="button" class="am-button am-secondary" data-am="edit" data-agent-id="${escapeHTML(agent.id)}" aria-label="Edit ${escapeHTML(agent.name)}">${icon('edit')}Edit agent</button><button type="button" class="am-button am-quiet" data-am="focus" data-agent-id="${escapeHTML(agent.id)}" aria-label="Find ${escapeHTML(agent.name)} on canvas">${icon('focus')}Find on canvas</button></div></article>`;
    }).join('') : `<div class="am-empty">${icon('search')}<h2>No agents found</h2><p>Try another name, role, or model, or choose a different department.</p><button class="am-button am-secondary" type="button" data-am="reset-filters">Clear filters</button></div>`;
  }

  function showDirectory({ departmentId, message = '' } = {}) {
    currentAgent = null;
    if (departmentId !== undefined) departmentFilter = departmentId === 'control' || store.departments.some((department) => department.id === departmentId) ? departmentId : '';
    open();
    element.innerHTML = `${header('Agents', 'Every name, role, and model in your office.')}<div class="am-directory-tools"><label class="am-search">${icon('search')}<span class="am-sr-only">Search agents</span><input type="search" id="am-search" placeholder="Search by name, role, or model" autocomplete="off" value="${escapeHTML(searchQuery)}"/></label><label class="am-sr-only" for="am-department-filter">Filter agents by department</label><select id="am-department-filter"><option value="">All departments</option><option value="control" ${departmentFilter === 'control' ? 'selected' : ''}>Control center</option>${store.departments.map((department) => `<option value="${escapeHTML(department.id)}" ${departmentFilter === department.id ? 'selected' : ''}>${escapeHTML(department.name)}</option>`).join('')}</select><div class="am-results-row"><span class="am-results-count" role="status"></span><span>LOCAL CONFIGURATIONS</span></div></div><div class="am-scroll am-directory-scroll">${message ? `<div class="am-success" role="status">${icon('check')}<span>${escapeHTML(message)}</span></div>` : ''}<div class="am-agent-list"></div></div><p class="am-footnote">Saved in your Workforce workspace. Adding an agent saves its setup; it does not start a runtime.</p>`;
    renderRows();
    element.querySelector('#am-search').addEventListener('input', (event) => { searchQuery = event.target.value; renderRows(); });
    element.querySelector('#am-department-filter').addEventListener('change', (event) => { departmentFilter = event.target.value; renderRows(); });
    element.querySelector('#am-search').focus({ preventScroll: true });
  }

  function field(name, label, control, hint = '') {
    return `<div class="am-field" data-field="${name}"><label for="am-${name}">${label}</label>${control}${hint ? `<p class="am-hint" id="am-${name}-hint">${hint}</p>` : ''}<p class="am-field-error" id="am-${name}-error" hidden></p></div>`;
  }

  function textField(name, label, value, { required = false, placeholder = '', hint = '', maxLength = 120, type = 'text' } = {}) {
    return field(name, label, `<input id="am-${name}" name="${name}" type="${type}" value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}" maxlength="${maxLength}" ${required ? 'required' : ''} ${hint ? `aria-describedby="am-${name}-hint"` : ''} autocomplete="off"/>`, hint);
  }

  function showForm(agent, requestedDepartmentId) {
    currentAgent = agent;
    formRevision = store.revision;
    runtimeTouched = Boolean(agent);
    const values = agent || { name: '', role: 'worker', departmentId: store.departments.some((department) => department.id === requestedDepartmentId) ? requestedDepartmentId : store.departments[0]?.id || '', provider: 'openai', model: '', runtime: 'codex-cli', instructions: '', endpoint: '', credentialEnv: '', temperature: null, customProvider: '', projectIds: store.projects.length === 1 ? [store.projects[0].id] : [] };
    previousProvider = values.provider || 'openai';
    const coordinator = Boolean(values.isCoordinator || values.id === 'control');
    const fixedDepartment = Boolean(agent && !agent.isCustom);
    const provider = values.provider || 'openai';
    open();
    element.innerHTML = `${header(agent ? 'Agent settings' : 'Create an agent', agent ? `Configure ${agent.name} and their work.` : 'Give your new teammate a name and a purpose.', { form: true })}<form class="am-form" id="am-agent-form" novalidate><div class="am-scroll am-form-scroll"><div class="am-local-note"><span class="am-local-dot"></span><p><strong>Local setup</strong><br>Saved to your Workforce workspace. No runtime will start.</p></div><div id="am-form-error" class="am-form-error" role="alert" hidden></div><fieldset class="am-section"><legend><span>01</span>Identity</legend>${textField('name', 'Full name', values.name, { required: true, placeholder: 'e.g. Riley Adams', maxLength: 60 })}${textField('role', 'Role', values.role, { required: true, placeholder: 'worker', maxLength: 60, hint: 'Roles are head or worker. Put specialized responsibilities in Instructions.' })}${field('departmentId', 'Department', `<select id="am-departmentId" name="departmentId" required ${fixedDepartment ? 'disabled' : ''}>${coordinator ? '<option value="control">Control center</option>' : store.departments.map((department) => `<option value="${escapeHTML(department.id)}" ${values.departmentId === department.id ? 'selected' : ''}>${escapeHTML(department.name)}</option>`).join('')}</select>`, coordinator ? 'The coordinator belongs to the control center.' : fixedDepartment ? 'This agent keeps their original department and seat.' : '')}${!coordinator && values.role !== 'head' ? field('projectIds', 'Projects this worker can work on', `<div class="am-project-options">${store.projects.map(project => `<label><input type="checkbox" name="projectIds" value="${escapeHTML(project.id)}" ${(values.projectIds || []).includes(project.id) ? 'checked' : ''}/> ${escapeHTML(project.name)}</label>`).join('') || '<p>No projects registered yet.</p>'}</div>`, 'Choose explicitly. With none selected, this worker stays on the bench.') : ''}</fieldset><fieldset class="am-section"><legend><span>02</span>Model & runtime</legend>${field('provider', 'Provider', `<select id="am-provider" name="provider" required>${providers.map(([id, name]) => `<option value="${id}" ${provider === id ? 'selected' : ''}>${name}</option>`).join('')}</select>`)}<div id="am-custom-provider-wrap" ${provider !== 'custom' ? 'hidden' : ''}>${textField('customProvider', 'Provider name', values.customProvider || '', { placeholder: 'Your provider or gateway', maxLength: 80 })}</div>${field('model', 'Model ID', `<input id="am-model" name="model" type="text" list="am-model-examples" value="${escapeHTML(values.model)}" placeholder="Enter the exact model ID" maxlength="120" autocomplete="off" spellcheck="false" aria-describedby="am-model-hint"/><datalist id="am-model-examples">${(examples[provider] || []).map((model) => `<option value="${model}"></option>`).join('')}</datalist>`, 'Use the installed tool’s exact model ID, or leave blank for its configured default.')}${field('runtime', 'Runtime', `<select id="am-runtime" name="runtime" required aria-describedby="am-runtime-hint">${runtimes.map(([id, name]) => `<option value="${id}" ${values.runtime === id ? 'selected' : ''}>${name}</option>`).join('')}</select>`, 'Codex CLI and Claude Code are supported. Ollama and direct API connections are not implemented.')}</fieldset><fieldset class="am-section"><legend><span>03</span>Instructions</legend>${field('instructions', 'What should this agent do?', `<textarea id="am-instructions" name="instructions" rows="6" maxlength="12000" required placeholder="Describe their responsibilities, how they should work, and what a good result looks like." aria-describedby="am-instructions-hint">${escapeHTML(values.instructions)}</textarea>`, 'Define their responsibilities, boundaries, and preferred output.')}</fieldset><details class="am-advanced" ${values.endpoint || values.credentialEnv ? 'open' : ''}><summary>Advanced settings<span>Optional</span></summary><div>${textField('endpoint', 'Endpoint URL', values.endpoint || '', { placeholder: 'https://your-provider.example/v1', maxLength: 500, hint: 'For a custom API or local runtime. Saving does not contact this endpoint.' })}${textField('credentialEnv', 'Credential environment variable', values.credentialEnv || '', { placeholder: 'e.g. OPENAI_API_KEY', maxLength: 120, hint: 'Enter the variable name, never the API key itself.' })}${field('temperature', 'Temperature', `<input id="am-temperature" name="temperature" type="number" inputmode="decimal" min="0" max="2" step="0.1" value="${escapeHTML(values.temperature ?? '')}" placeholder="Provider default" aria-describedby="am-temperature-hint"/>`, '0–2, where supported. Leave blank to use the provider default.')}</div></details></div><footer class="am-form-footer"><button type="button" class="am-button am-secondary" data-am="directory">Cancel</button><button type="submit" class="am-button am-primary">${agent ? 'Save changes' : 'Create agent'}${icon(agent ? 'check' : 'plus')}</button></footer></form>`;
    const form = element.querySelector('form');
    form.addEventListener('submit', submitForm);
    form.addEventListener('input', (event) => { if (event.target.name) clearFieldError(event.target.name); });
    form.addEventListener('change', (event) => {
      if (event.target.name) clearFieldError(event.target.name);
      if (event.target.name === 'runtime') runtimeTouched = true;
      if (event.target.name === 'provider') {
        const nextProvider = event.target.value;
        element.querySelector('#am-custom-provider-wrap').hidden = nextProvider !== 'custom';
        element.querySelector('#am-model-examples').innerHTML = (examples[nextProvider] || []).map((model) => `<option value="${model}"></option>`).join('');
        const runtime = form.elements.namedItem('runtime');
        if (!runtimeTouched && runtime.value === runtimeDefaults[previousProvider]) runtime.value = runtimeDefaults[nextProvider];
        previousProvider = nextProvider;
      }
    });
    element.querySelector('#am-name').focus({ preventScroll: true });
  }

  function clearFieldError(name) {
    const input = element.querySelector(`[name="${name}"]`);
    const error = element.querySelector(`#am-${name}-error`);
    if (!input || !error) return;
    input.removeAttribute('aria-invalid');
    const hint = element.querySelector(`#am-${name}-hint`);
    if (hint) input.setAttribute('aria-describedby', hint.id);
    else input.removeAttribute('aria-describedby');
    error.hidden = true;
    error.textContent = '';
  }

  function showErrors(errors) {
    let firstInput;
    for (const [name, message] of Object.entries(errors)) {
      const input = [...element.querySelectorAll('[name]')].find((item) => item.name === name);
      const error = element.querySelector(`#am-${name}-error`);
      if (!input || !error) continue;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${element.querySelector(`#am-${name}-hint`) ? `am-${name}-hint ` : ''}am-${name}-error`);
      error.hidden = false;
      error.textContent = message;
      const details = input.closest('details');
      if (details) details.open = true;
      firstInput ||= input;
    }
    firstInput?.focus();
    firstInput?.scrollIntoView({ block: 'center', behavior: 'auto' });
    return Boolean(firstInput);
  }

  async function submitForm(event) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const raw = Object.fromEntries(formData);
    raw.projectIds = formData.getAll('projectIds');
    raw.expectRevision = formRevision;
    const values = { ...raw, ...(currentAgent ? { id: currentAgent.id, isCoordinator: currentAgent.isCoordinator || currentAgent.id === 'control' } : {}), departmentId: currentAgent && !currentAgent.isCustom ? currentAgent.departmentId : raw.departmentId };
    for (const [name, value] of Object.entries(values)) if (typeof value === 'string') values[name] = value.trim();
    values.temperature = raw.temperature === '' ? null : Number(raw.temperature);
    const errors = {};
    if (!values.name) errors.name = 'Enter a name for this agent.';
    if (!values.role) errors.role = 'Enter this agent’s role.';
    if (!values.departmentId) errors.departmentId = 'Choose a department.';
    if (values.provider === 'custom' && !values.customProvider) errors.customProvider = 'Enter the custom provider’s name.';
    if (!values.instructions) errors.instructions = 'Add instructions so this agent knows what to do.';
    if (values.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(values.credentialEnv)) errors.credentialEnv = 'Use an environment variable name, such as OPENAI_API_KEY.';
    if (values.endpoint) {
      try {
        const endpoint = new URL(values.endpoint);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) errors.endpoint = 'Use an HTTP or HTTPS URL without embedded credentials.';
      } catch { errors.endpoint = 'Enter a valid URL beginning with http:// or https://.'; }
    }
    if (values.temperature !== null && (!Number.isFinite(values.temperature) || values.temperature < 0 || values.temperature > 2)) errors.temperature = 'Use a temperature from 0 to 2, or leave it blank.';
    form.querySelectorAll('[name]').forEach((input) => clearFieldError(input.name));
    const errorBox = element.querySelector('#am-form-error');
    errorBox.hidden = true;
    if (Object.keys(errors).length) { showErrors(errors); return; }
    let saved;
    saving = true;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try { saved = await store.save(values); }
    catch (error) {
      saving = false;
      submit.disabled = false;
      let focusedField = false;
      if ((error.fieldErrors || error.fields) && typeof (error.fieldErrors || error.fields) === 'object') focusedField = showErrors(error.fieldErrors || error.fields);
      else if (error.field) focusedField = showErrors({ [error.field]: error.message || 'Check this field.' });
      errorBox.textContent = error.fields?.storage || error.message || 'We could not save this agent. Your changes are still here. Please try again.';
      errorBox.hidden = false;
      if (!focusedField) errorBox.scrollIntoView({ block: 'center' });
      return;
    }
    saving = false;
    try { await onSaved(saved); } catch { /* The workspace save succeeded; a view refresh must not invite duplicate creation. */ }
    departmentFilter = '';
    searchQuery = '';
    showDirectory({ message: `${saved.name} ${currentAgent ? 'updated' : 'created'}. Saved to your Workforce workspace. No task was started.` });
  }

  element.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-am]');
    if (!button || !element.contains(button)) return;
    const action = button.dataset.am;
    if (saving) return;
    if (action === 'close') close();
    else if (action === 'directory') showDirectory();
    else if (action === 'create') showForm(null, departmentFilter);
    else if (action === 'edit') { const agent = store.get(button.dataset.agentId); if (agent) showForm(agent); }
    else if (action === 'focus') {
      const agent = store.get(button.dataset.agentId);
      if (!agent) return;
      close();
      onFocus({ type: agent.id === 'control' || agent.isCoordinator ? 'control' : 'employee', id: agent.id });
    } else if (action === 'reset-filters') { searchQuery = ''; departmentFilter = ''; showDirectory(); }
  });
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!saving) close(); }
  });

  return { showDirectory, showCreate(departmentId) { showForm(null, departmentId); }, showEdit(id) { const agent = store.get(id); if (agent?.isCoordinator) showDirectory({message:'The coordinator is the system scheduler. Edit a department head to change its model and instructions.'}); else if (agent) showForm(agent); }, isOpen: () => active, hide };
}
