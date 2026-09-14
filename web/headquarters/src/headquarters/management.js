import { avatarCatalog, portraitById } from './avatar-catalog.js';
import * as defaultOrganization from './organization.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function preferredRuntime(organization) {
  const ids = organization.runtimes.map(([id]) => id);
  const preferred = ids.includes(organization.orchestrator?.runtime) ? organization.orchestrator.runtime : '';
  const usable = id => organization.runtimeReport?.(id)?.usable === true;
  return (preferred && usable(preferred) ? preferred : ids.find(usable)) || preferred || ids[0] || '';
}

/** Management writes the same revisioned workspace used by the installed runtimes. */
export function createCompanyManagement({ organization = defaultOrganization, icon = () => '', avatar = name => `<span class="cm-initials">${escape(name.slice(0, 2))}</span>`, notify = () => {}, onNavigate = () => {} } = {}) {
  let host; let controller; let current = { tab: 'agents' }; let query = ''; let departmentFilter = ''; let roleFilter = ''; let flash = ''; let modelRequest = 0;
  const department = id => organization.departments.find(d => d.id === id);
  const departmentName = id => id === 'company' ? 'Company leadership' : department(id)?.name || 'Department';
  const optionList = (list, selected) => list.map(([id, label]) => `<option value="${escape(id)}"${id === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const button = (action, label, symbol = '', extra = '', variant = '') => `<button type="button" class="cm-button ${variant}" data-cm="${action}" ${extra}>${symbol ? icon(symbol) : ''}${label}</button>`;
  const notice = () => `<div class="cm-save-note">${icon('connect')}<span><strong>${organization.connected ? 'Connected workspace' : 'Connecting to your workspace'}</strong>${organization.connected ? ` · Revision ${organization.revision}. Settings are shared across your workforce.` : ' · Organization controls become available after the workspace loads.'}</span></div>`;
  function render(options = {}) {
    current = { tab: 'agents', ...options };
    if (!['agents', 'departments', 'archived'].includes(current.tab)) current.tab = 'agents';
    return `<div class="company-management cm-workspace">${current.editAgentId !== undefined ? agentForm(current.editAgentId) : current.editDepartmentId !== undefined ? departmentForm(current.editDepartmentId) : directory()}<div class="cm-announcement sr-only" role="status" aria-live="polite"></div></div>`;
  }
  function header() {
    return `<header class="cm-header"><div><h1>${current.tab === 'archived' ? 'Archived team records' : 'Team'}</h1><p class="cm-subtitle">People, responsibilities, and reporting lines in one place.</p></div><div class="cm-header-actions">${organization.activeDepartments().length < 5 ? button('setup-tech-team', 'Set up tech team', 'layers', organization.connected ? '' : 'disabled', 'cm-secondary') : ''}${button('new-department', 'New department', 'org', organization.connected ? '' : 'disabled', 'cm-secondary')}${button('new-agent', 'Add agent', 'plus', organization.connected ? '' : 'disabled', 'cm-primary')}</div></header>`;
  }
  function directory() {
    const employees = organization.allAgents(); const depts = organization.activeDepartments();
    const archivedCount = organization.departments.filter(d => d.archived).length + organization.allAgents({ includeArchived: true }).filter(a => a.archived).length;
    return `${header()}<div class="cm-metrics"><span><strong>${employees.length}</strong> agents</span><span><strong>${depts.length}</strong> departments</span><span><strong>${depts.filter(d => d.lead.id).length}</strong> department heads</span><span>${icon('shield')}Connected to your workspace</span></div><div class="cm-tabs" role="tablist" aria-label="Company management">${[['agents', 'People', employees.length], ['departments', 'Departments', depts.length], ['archived', 'Archived', archivedCount]].map(([id, label, count]) => `<button type="button" role="tab" id="cm-tab-${id}" aria-controls="cm-results" tabindex="${current.tab === id ? 0 : -1}" aria-selected="${current.tab === id}" class="${current.tab === id ? 'active' : ''}" data-cm="tab" data-tab="${id}">${label}<span>${count}</span></button>`).join('')}</div>${organization.storageWarning ? `<p class="cm-error-summary" role="alert">${escape(organization.storageWarning)}</p>` : ''}${flash ? `<p class="cm-success" role="status">${icon('check')}${escape(flash)}</p>` : ''}<div class="cm-toolbar"><label class="cm-search">${icon('search')}<span class="sr-only">Search organization</span><input type="search" id="cm-search" placeholder="Search names, roles, models…" value="${escape(query)}" autocomplete="off"></label>${current.tab === 'agents' ? `<label class="cm-filter"><span class="sr-only">Filter by department</span><select id="cm-department-filter"><option value="">All departments</option><option value="company" ${departmentFilter === 'company' ? 'selected' : ''}>Company leadership</option>${optionList(depts.map(d => [d.id, d.name]), departmentFilter)}</select></label><label class="cm-filter"><span class="sr-only">Filter by responsibility</span><select id="cm-role-filter">${optionList([['', 'All roles'], ['heads', 'Department heads'], ['specialists', 'Team members']], roleFilter)}</select></label>` : ''}</div><div id="cm-results" role="tabpanel" aria-labelledby="cm-tab-${current.tab}" tabindex="0">${results()}</div>${notice()}`;
  }
  const matches = value => value.toLowerCase().includes(query.trim().toLowerCase());
  function results() {
    if (current.tab === 'departments') {
      const list = organization.activeDepartments().filter(d => matches(`${d.name} ${d.purpose} ${d.lead.name}`));
      return `<div class="cm-results-label">${list.length} department${list.length === 1 ? '' : 's'}</div><div class="cm-department-grid">${list.map(departmentCard).join('')}</div>${list.length ? '' : empty('No matching departments.', 'Try another name or create a department.')}`;
    }
    if (current.tab === 'archived') {
      const depts = organization.departments.filter(d => d.archived && matches(`${d.name} ${d.purpose}`));
      const agents = organization.allAgents({ includeArchived: true }).filter(a => a.archived && matches(`${a.name} ${a.role} ${departmentName(a.departmentId)}`));
      return `<p class="cm-archive-explanation">Archived records keep their run history. This runtime workspace does not support restoring an archived identity; create a new teammate or department when needed.</p>${depts.length ? `<h2 class="cm-section-title">Departments</h2><div class="cm-department-grid">${depts.map(departmentCard).join('')}</div>` : ''}${agents.length ? `<h2 class="cm-section-title">Agents</h2><div class="cm-agent-list">${agents.map(agentCard).join('')}</div>` : ''}${!depts.length && !agents.length ? empty(query ? 'No matching archived records.' : 'Nothing archived.', 'Archived records will appear here.') : ''}`;
    }
    const list = organization.allAgents().filter(a => (!departmentFilter || a.departmentId === departmentFilter) && (!roleFilter || (roleFilter === 'heads' ? a.isHead : !a.isHead && !a.isCoordinator)) && matches(`${a.name} ${a.role} ${departmentName(a.departmentId)} ${a.effectiveModel || ''} ${a.provider || ''} ${a.skills.join(' ')}`));
    const chief = list.find(a => a.isCoordinator); const people = list.filter(a => !a.isCoordinator);
    return `<div class="cm-results-label">${list.length} team agent${list.length === 1 ? '' : 's'}<span>MODEL / RUNTIME</span></div><div class="cm-agent-list">${[...(chief ? [chief] : []), ...people].map(agentCard).join('')}</div>${!list.length ? empty('No matching agents.', 'Try another name, model, or department.') : ''}`;
  }
  function empty(title, description) { return `<div class="cm-empty">${icon('people')}<h2>${title}</h2><p>${description}</p>${query || departmentFilter || roleFilter ? button('clear-filters', 'Clear filters', 'reset', '', 'cm-secondary') : ''}</div>`; }
  function agentCard(agent) {
    const d = department(agent.departmentId); const report = organization.runtimeReport(agent.runtime);
    const model = organization.modelCatalog(agent.runtime)?.models?.find(m => m.id === agent.effectiveModel);
    const modelLabel = model?.label || agent.effectiveModel || 'Runtime default';
    const state = agent.archived ? 'Archived' : report?.usable ? 'Runtime available' : report?.installed ? 'Runtime needs attention' : 'Runtime not verified';
    return `<article class="cm-agent-card${agent.archived ? ' cm-is-archived' : ''}"><div class="cm-person">${avatar(agent.name, 38, { id: agent.id, avatarId: agent.avatarId })}<div><h2>${escape(agent.name)}${agent.isHead ? '<span class="cm-head-badge">Head</span>' : ''}</h2><p>${escape(agent.role)}</p><span class="cm-department-label"><i style="background:${escape(d?.color || 'var(--green)')}"></i>${escape(departmentName(agent.departmentId))}${!agent.isHead ? ` · ${agent.projectScope !== 'restricted' ? 'All projects · automatic' : `${agent.projectIds.length} selected projects`}` : ''}</span></div></div><div class="cm-runtime"><strong>${escape(modelLabel)}${agent.effectiveEffort ? `<em>${escape(agent.effectiveEffort)}</em>` : ''}</strong>${agent.effectiveModel ? `<code>${escape(model?.resolvedModel || agent.effectiveModel)}</code>` : ''}<span>${escape(organization.runtimes.find(([id]) => id === agent.runtime)?.[1] || agent.runtime)}</span><small data-ready="${Boolean(report?.usable)}">${escape(state)}${report?.version ? ` · ${escape(report.version)}` : ''}</small></div><div class="cm-person-actions">${!agent.archived ? `${button('edit-agent', 'Edit', 'pen', `data-agent-id="${escape(agent.id)}" aria-label="Edit ${escape(agent.name)}"`, 'cm-secondary')}${!agent.isHead && !agent.isCoordinator ? button('archive-agent', '', 'archive', `data-agent-id="${escape(agent.id)}" aria-label="Archive agent ${escape(agent.name)}" title="Archive agent"`, 'cm-icon-button') : ''}` : '<span class="cm-readonly-label">Read only</span>'}</div></article>`;
  }
  function departmentCard(d) {
    const size = d.members.filter(a => !a.archived).length + (d.lead.id ? 1 : 0);
    return `<article class="cm-department-card" style="--cm-department:${escape(d.color)}"><div class="cm-department-top"><span class="cm-department-icon">${icon(d.icon)}</span><span class="cm-department-size">${size} teammates${d.archived ? ' · Archived' : ''}</span></div><h2>${escape(d.name)}</h2><p class="cm-department-purpose">${escape(d.purpose || 'Define this department’s focus in its settings.')}</p><div class="cm-department-head">${avatar(d.lead.name, 28, { id: d.lead.id, avatarId: d.lead.avatarId })}<span><strong>${escape(d.lead.name)}</strong><small>${d.lead.id ? 'Department head' : 'Add a head to accept work'}</small></span></div><footer>${!d.archived ? `${button('edit-department', 'Manage department', 'arrow', `data-department-id="${escape(d.id)}"`, 'cm-secondary')}${button('archive-department', '', 'archive', `data-department-id="${escape(d.id)}" aria-label="Archive department ${escape(d.name)}" title="Archive department"`, 'cm-icon-button')}` : '<span class="cm-readonly-label">Read only</span>'}</footer></article>`;
  }
  function field(name, label, control, hint = '', wide = false) {
    return `<div class="cm-field${wide ? ' cm-field-wide' : ''}" data-cm-field="${name}"><label for="cm-${name}">${label}</label>${control}${hint ? `<p class="cm-hint" id="cm-${name}-hint">${hint}</p>` : ''}<p class="cm-field-error" id="cm-${name}-error" hidden></p></div>`;
  }
  const input = (name, label, value, { hint = '', placeholder = '', max = 120, required = false, wide = false, type = 'text', extra = '' } = {}) => field(name, label, `<input id="cm-${name}" name="${name}" type="${type}" value="${escape(value)}" maxlength="${max}" placeholder="${escape(placeholder)}" autocomplete="off" ${required ? 'required' : ''} ${extra} ${hint ? `aria-describedby="cm-${name}-hint"` : ''}>`, hint, wide);
  function formHeader(title, subtitle) { return `<header class="cm-form-header">${button('back', 'Back to organization', 'back', '', 'cm-back')}<p class="eyebrow">AGENT WORKSPACE</p><h1>${escape(title)}</h1><p class="cm-subtitle">${escape(subtitle)}</p></header>${notice()}<div class="cm-error-summary" id="cm-form-error" role="alert" tabindex="-1" hidden></div>`; }
  function runtimeFields(d, head = false) {
    const names = head ? ['headRuntime', 'headModel', 'headEffort'] : ['runtime', 'model', 'effort'];
    const groupId = head ? 'head' : 'agent';
    return `<div class="cm-runtime-fields cm-form-grid" data-runtime-group="${groupId}" aria-busy="true">${field(names[0], 'Runtime', `<select id="cm-${names[0]}" name="${names[0]}" data-runtime-select>${optionList(organization.runtimes, d.runtime)}</select>`)}${field(names[1], 'Model', `<select id="cm-${names[1]}" name="${names[1]}" data-model-select data-initial="${escape(d.model || '')}" aria-describedby="cm-model-${groupId}-identity cm-catalog-${groupId}" disabled><option value="${escape(d.model || '')}">Loading models…</option></select><div class="cm-model-identity" id="cm-model-${groupId}-identity" data-model-identity></div>`)}${field(names[2], 'Reasoning effort', `<select id="cm-${names[2]}" name="${names[2]}" data-effort-select data-initial="${escape(d.effort || '')}" aria-describedby="cm-catalog-${groupId}" disabled><option value="${escape(d.effort || '')}">Loading supported effort…</option></select>`)}<div class="cm-catalog-meta cm-field-wide"><p class="cm-catalog-status" id="cm-catalog-${groupId}" data-catalog-status role="status">Reading the installed runtime’s model catalog…</p><span data-catalog-action></span></div></div>`;
  }
  function formSection(title, symbol, content, description = '') {
    return `<fieldset class="cm-form-section"><legend class="sr-only">${title}</legend><div class="cm-card-heading"><span class="cm-section-icon">${icon(symbol)}</span><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div></div>${content}</fieldset>`;
  }
  function avatarPicker(agent, fieldName = 'avatarId') {
    const chosen = portraitById(agent.avatarId);
    const choices = [{ id: '', label: 'Automatic', description: 'Choose a consistent 3D human avatar automatically' }, ...avatarCatalog];
    return `<fieldset class="cm-avatar-picker" data-cm-field="${fieldName}" data-avatar-picker data-avatar-name="${escape(agent.name || 'New teammate')}"><legend>Choose an animated avatar</legend><div class="cm-avatar-preview" aria-live="polite"><span data-avatar-preview>${avatar(agent.name || 'New teammate', 58, { avatarId: chosen?.id || null })}</span><div><strong data-avatar-preview-label>${escape(chosen?.label || 'Automatic avatar')}</strong><span>A face for your teammate, everywhere they work.</span></div><span class="cm-avatar-local">16 included</span></div><div class="cm-avatar-grid">${choices.map(portrait => `<label class="cm-avatar-option" title="${escape(portrait.description)}"><input type="radio" name="${fieldName}" value="${portrait.id}" aria-label="${escape(portrait.label)} avatar" ${portrait.id === (chosen?.id || '') ? 'checked' : ''}><span class="cm-avatar-choice">${avatar(agent.name || 'New teammate', 44, { avatarId: portrait.id || null })}<span>${escape(portrait.label)}</span><i>${icon('check')}</i></span></label>`).join('')}</div><p class="cm-field-error" id="cm-${fieldName}-error" hidden></p></fieldset>`;
  }
  function updateAvatarPreview(input) {
    const picker = input.closest('[data-avatar-picker]');
    if (!picker) return;
    const portrait = portraitById(input.value);
    picker.querySelector('[data-avatar-preview]').innerHTML = avatar(picker.dataset.avatarName, 58, { avatarId: portrait?.id || null });
    picker.querySelector('[data-avatar-preview-label]').textContent = portrait?.label || 'Automatic avatar';
  }
  function agentForm(id) {
    const agent = id ? organization.getAgent(id) : null;
    if (id && !agent) return `${formHeader('Agent unavailable', 'This person could not be found.')}${button('back', 'Back to organization')}`;
    if (agent?.archived || (agent && department(agent.departmentId)?.archived)) return `${formHeader('Archived record', 'This record is read-only. Create a new agent to fill the role.')}${button('archived', 'View archived records')}`;
    const d = agent ? { ...agent } : { name: '', avatarId: 'portrait-01', runtimeRole: 'worker', departmentId: organization.activeDepartments()[0]?.id || '', model: '', effort: '', runtime: preferredRuntime(organization), instructions: 'Complete assigned work within your role, verify the result, and report evidence to your department head. Resolve routine obstacles before escalating a genuine blocker.', skills: [], projectIds: [], policy: 'local-development' };
    if (d.isCoordinator && current.preferredRuntimeId && organization.runtimes.some(([id]) => id === current.preferredRuntimeId)) Object.assign(d, { runtime: current.preferredRuntimeId, model: '', effort: '' });
    const identity = d.isCoordinator ? `<div class="cm-identity-summary cm-field-wide">${avatar(d.name, 44, { id: d.id, avatarId: d.avatarId })}<div><strong>${escape(d.name)}</strong><p>Company orchestrator</p></div><span class="cm-head-badge">Company leadership</span></div>` : `${input('name', 'Name', d.name, { max: 60, required: true, placeholder: 'e.g. Kara Foster' })}${input('jobTitle', 'Job title', d.jobTitle || (agent ? organization.agentJobTitle?.(agent) || agent.role : ''), { max: 100, placeholder: 'e.g. Frontend Developer', hint: 'Your editable specialty, shown everywhere and included in task planning.' })}${field('role', 'Team responsibility', `<select id="cm-role" name="role">${optionList([['worker', 'Team member'], ['head', 'Department head']], d.runtimeRole)}</select>`, 'Department heads plan and review work. Team members deliver their specialty.')}${field('departmentId', 'Department', `<select id="cm-departmentId" name="departmentId" required><option value="">Choose a department</option>${optionList(organization.activeDepartments().map(dep => [dep.id, dep.name]), d.departmentId)}</select>`, 'This department’s head coordinates the teammate’s work.')}`;
    const projectControls = `<div id="cm-worker-options" ${d.isHead ? 'hidden' : ''}>${field('policy', 'Execution policy', `<select id="cm-policy" name="policy">${optionList([['local-development', 'Develop and verify locally'], ['analysis', 'Read and analyze'], ['verification', 'Verify results']], d.policy)}</select>`, 'The harness enforces this policy when it invokes the runtime.')}${field('projectScope', 'Project access', `<select id="cm-projectScope" name="projectScope">${optionList([['all', 'All projects · automatic (recommended)'], ['restricted', 'Only selected projects']], d.projectScope || 'all')}</select>`, 'Available specialists are selected automatically by skill and workload. New projects are included automatically.')}${field('projectIds', 'Optional project restriction', `<div class="cm-project-options" role="group" aria-label="Optional project restriction">${organization.projects.filter(p => !p.archived).map(p => `<label><input type="checkbox" name="projectIds" value="${escape(p.id)}" ${d.projectIds.includes(p.id) ? 'checked' : ''}><span><strong>${escape(p.name)}</strong><small>${escape(p.repoPath)}</small></span></label>`).join('') || '<p>No projects configured. Add one in Projects.</p>'}</div>`, 'Only used when project access is set to selected projects. Leave the default to let this specialist work across your projects.', true)}</div>`;
    const limitControls = `<details class="cm-advanced cm-settings-card"><summary><span>Execution limits</span><small>Shared across the company</small>${icon('down')}</summary><div class="cm-form-grid">${[['maxConcurrentProjectRuns','Concurrent project runs',1,32],['maxActiveTurns','Active turns per run',1,64],['maxActiveWriters','Active writers per run',1,64],['maxTasksPerRun','Tasks per run',1,1000],['maxRepairAttempts','Repair attempts',0,100],['maxTransientRetries','Transient retries',0,100],['maxDelegationDepth','Delegation depth',0,16],['runTimeoutMinutes','Run timeout (minutes)',1,10080]].map(([name,label,min,max]) => input(name,label,organization.limits[name],{type:'number',extra:`min="${min}" max="${max}" step="1"`})).join('')}</div></details>`;
    const routeControls = `<details class="cm-advanced cm-settings-card" data-cm-field="projectRoutes"><summary><span>Project routing</span><small>Let Control Center choose, or set a department</small>${icon('down')}</summary><div class="cm-form-grid">${organization.projects.filter(p => !p.archived).map(p => field(`route-${p.id}`, escape(p.name), `<select id="cm-route-${escape(p.id)}" name="route-${escape(p.id)}" data-project-route="${escape(p.id)}">${optionList([['', 'Control Center decides'], ...organization.activeDepartments().map(dep => [dep.id, dep.name])], d.projectRoutes?.find(r => r.projectId === p.id)?.departmentId || '')}</select>`, 'The selected department still needs eligible specialists for this project.', true)).join('') || '<p class="cm-hint">Add a project to configure routing.</p>'}</div></details>`;
    return `${formHeader(agent ? `${agent.isCoordinator ? 'Configure' : 'Edit'} ${agent.name}` : 'Add an agent', agent?.isCoordinator ? 'Select the runtime that understands requests and coordinates your workforce.' : 'Configure an agent in your connected runtime workspace.')}<form class="cm-form" id="cm-agent-form" novalidate>${formSection('Identity & responsibility', 'people', `<div class="cm-form-grid">${identity}</div>${avatarPicker(d)}`)}${formSection('Model & runtime', 'connect', runtimeFields(d), 'Choose from the models your installed runtime reports.')}${formSection('Instructions & capabilities', 'pen', `<div class="cm-form-grid">${field('instructions', d.isCoordinator ? 'Additional orchestration instructions' : 'How should this teammate work?', `<textarea id="cm-instructions" name="instructions" rows="6" maxlength="12000" ${d.isCoordinator ? '' : 'required'}>${escape(d.instructions)}</textarea>`, d.isCoordinator ? 'Optional. The harness supplies the Control Center role and routing tools; these instructions add your working preferences.' : 'Define responsibilities, working methods, and what a verified result looks like.', true)}${!d.isCoordinator ? input('skills', 'Capabilities', d.skills.join(', '), { wide: true, max: 2080, placeholder: 'coding, testing, research', hint: 'Separate capabilities with commas. These inform task assignment; tools come from the runtime.' }) : ''}</div>${!d.isCoordinator ? projectControls : ''}`)}${d.isCoordinator ? routeControls + limitControls : ''}<footer class="cm-form-footer"><span>Saved to the connected workspace.</span>${button('back', 'Cancel', '', '', 'cm-secondary')}<button class="cm-button cm-primary" type="submit">${icon('check')}${agent ? 'Save changes' : 'Create agent'}</button></footer></form>`;
  }
  function departmentForm(id) {
    const existing = id ? department(id) : null;
    if (id && !existing) return `${formHeader('Department unavailable', 'This department could not be found.')}${button('back', 'Back to organization')}`;
    if (existing?.archived) return `${formHeader('Archived department', 'This department is read-only.')}${button('archived', 'View archived records')}`;
    const d = existing || { name: '', purpose: '', colorName: 'blue' };
    const headDefaults = { runtime: existing?.lead.runtime || preferredRuntime(organization), model: existing?.lead.model || '', effort: existing?.lead.effort || '' };
    return `${formHeader(existing ? `${existing.name} department` : 'Build a new department.', 'Define its purpose, leadership, and place in your workforce.')}<form class="cm-form" id="cm-department-form" novalidate>${formSection('Department identity', 'org', `<div class="cm-form-grid">${input('name', 'Department name', d.name, { max: 60, wide: true, required: true, placeholder: 'e.g. Customer Success' })}${input('purpose', 'Focus', d.purpose, { max: 60, wide: true, placeholder: 'What is this department accountable for?', hint: 'A short focus distinguishes departments with similar names.' })}${field('color', 'Department color', `<div class="cm-colors" role="group" aria-label="Department color">${organization.departmentColors.map(color => `<label class="cm-color-option" style="--cm-swatch:${organization.colorValues[color]}"><input name="color" type="radio" value="${color}" aria-label="${color}" ${color === d.colorName ? 'checked' : ''}><span>${icon('check')}</span></label>`).join('')}</div>`)}</div>`)}${formSection('Department leadership', 'people', `${existing?.lead.id ? `<div class="cm-current-head">${avatar(existing.lead.name, 32, { id: existing.lead.id, avatarId: existing.lead.avatarId })}<span><strong>${escape(existing.lead.name)}</strong><small>Current department head</small></span>${button('edit-agent','Edit head','pen',`data-agent-id="${escape(existing.lead.id)}"`,'cm-secondary')}</div>` : '<p class="cm-hint">A department needs a head and available specialists. Project access is automatic.</p>'}<details class="cm-advanced" ${existing?.lead.id ? '' : 'open'}><summary><span>${existing?.lead.id ? 'Replace department head' : 'Add a department head'}</span><small>${existing?.lead.id ? 'Preserves the previous head’s history' : 'Optional during setup'}</small>${icon('down')}</summary><div class="cm-form-grid">${input('headName', existing?.lead.id ? 'New head’s name' : 'Department head’s name', '', { max: 60, wide: true, placeholder: 'e.g. Customer Success head', hint: existing?.lead.id ? 'Saving a new name archives the current head and creates the replacement in one workspace update.' : 'Leave blank to add the head later.' })}</div>${avatarPicker({ name: 'Department head', avatarId: 'portrait-01' }, 'headAvatarId')}${runtimeFields(headDefaults, true)}</details>`)}${existing ? `<div class="cm-department-roster"><h2>Team members<span>${existing.members.filter(a => !a.archived && !a.isHead).length}</span></h2>${existing.members.filter(a => !a.archived && !a.isHead).map(a => `<div>${avatar(a.name, 27, { id: a.id, avatarId: a.avatarId })}<span><strong>${escape(a.name)}</strong><small>${escape(a.jobTitle || a.role)} · ${a.projectScope !== 'restricted' ? 'All projects · automatic' : `${a.projectIds.length} selected projects`}</small></span>${button('edit-agent', 'Edit', 'pen', `data-agent-id="${escape(a.id)}"`, 'cm-secondary')}</div>`).join('') || '<p>Add people from Team; project access is automatic.</p>'}</div>` : ''}<footer class="cm-form-footer"><span>Changes apply to the connected workspace.</span>${button('back', 'Cancel', '', '', 'cm-secondary')}<button class="cm-button cm-primary" type="submit">${icon('check')}${existing ? 'Save department' : 'Create department'}</button></footer></form>`;
  }
  function navigate(options) {
    if (!host) return;
    host.innerHTML = render(options); mount(host); onNavigate({ view: 'company', ...options }); host.scrollTop = 0;
  }
  function updateResults() { const target = host?.querySelector('#cm-results'); if (target) target.innerHTML = results(); }
  function errors(error) {
    const form = host.querySelector('form'); const box = host.querySelector('#cm-form-error');
    if (!form || !box) { notify(Object.values(error.fields || {})[0] || error.message); return; }
    let first;
    for (const [name, message] of Object.entries(error.fields || {})) {
      const wrapper = [...form.querySelectorAll('[data-cm-field]')].find(node => node.dataset.cmField === name);
      const named = form.elements.namedItem(name);
      const control = named?.setAttribute ? named : wrapper?.querySelector('input,select,textarea');
      const output = wrapper?.querySelector('.cm-field-error');
      if (control) { control.setAttribute('aria-invalid', 'true'); if (output) control.setAttribute('aria-describedby', [...new Set([...(control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), output.id])].join(' ')); first ||= control; }
      if (output) { output.hidden = false; output.textContent = message; }
      const details = (wrapper || control)?.closest('details'); if (details) details.open = true;
    }
    const details = [...new Set(Object.values(error.fields || {}))];
    box.hidden = false; box.textContent = `${details.length ? details.join(' ') : error.message || 'Could not save.'} Your draft is still here.`; (first || box).focus();
  }
  function clearError(target) {
    if (!target.name) return;
    const controls = target.type === 'checkbox' || target.type === 'radio' ? [...host.querySelectorAll('input')].filter(input => input.name === target.name) : [target];
    const hint = host.querySelector(`#cm-${target.name}-hint`);
    const errorId = `cm-${target.name}-error`;
    for (const control of controls) {
      control.removeAttribute('aria-invalid');
      const descriptions = (control.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== errorId);
      if (hint && !descriptions.includes(hint.id)) descriptions.push(hint.id);
      if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' ')); else control.removeAttribute('aria-describedby');
    }
    const output = host.querySelector(`#${errorId}`); if (output) output.hidden = true;
  }
  async function submit(event) {
    if (!event.target.matches('#cm-agent-form, #cm-department-form')) return;
    event.preventDefault(); const form = event.target; if (form.dataset.saving) return;
    if (form.querySelector('[data-runtime-group][data-loading]')) { notify('The runtime model catalog is still loading. Your draft is preserved.'); return; }
    form.querySelectorAll('[name]').forEach(clearError); host.querySelector('#cm-form-error').hidden = true;
    const data = new FormData(form); const values = Object.fromEntries(data); values.projectIds = data.getAll('projectIds');
    const disabledStates = [...new Set([...form.querySelectorAll('input,select,textarea,button'), ...host.querySelectorAll('[data-cm]')])].map(control => [control, control.disabled]);
    const submitButton = form.querySelector('[type="submit"]'); const label = submitButton.innerHTML; submitButton.disabled = true; submitButton.textContent = 'Saving…'; form.dataset.saving = 'true'; form.setAttribute('aria-busy', 'true'); disabledStates.forEach(([control]) => { control.disabled = true; });
    try {
      let result;
      if (form.id === 'cm-agent-form') {
        const previous = current.editAgentId ? organization.getAgent(current.editAgentId) : null;
        if (previous) values.id = previous.id;
        if (previous?.isCoordinator) values.departmentId = previous.departmentId;
        if (previous?.isCoordinator) values.projectRoutes = [...form.querySelectorAll('[data-project-route]')].filter(control => control.value).map(control => ({ projectId: control.dataset.projectRoute, departmentId: control.value }));
        if (values.role === 'head') values.projectIds = [];
        result = await organization.saveAgent(values); flash = `${result.name} ${previous ? 'updated' : 'added'} in your workspace.`;
      } else {
        if (current.editDepartmentId) values.id = current.editDepartmentId;
        result = await organization.saveDepartment(values); flash = `${result.name} ${current.editDepartmentId ? 'updated' : 'created'} in your workspace.`;
      }
      query = ''; departmentFilter = ''; roleFilter = ''; if (form.isConnected && host.contains(form)) navigate({ tab: form.id === 'cm-agent-form' ? 'agents' : 'departments' }); notify(flash);
    } catch (error) { disabledStates.forEach(([control, wasDisabled]) => { if (control.isConnected) control.disabled = wasDisabled; }); if (form.isConnected && host.contains(form)) errors(error); else notify(Object.values(error.fields || {})[0] || error.message); }
    finally { delete form.dataset.saving; form.removeAttribute('aria-busy'); disabledStates.forEach(([control, wasDisabled]) => { if (control.isConnected) control.disabled = wasDisabled; }); if (submitButton.isConnected) submitButton.innerHTML = label; }
  }
  async function click(event) {
    const target = event.target.closest('[data-cm]'); if (!target || !host.contains(target) || target.disabled) return;
    if (host.querySelector('form[data-saving]')) return;
    const action = target.dataset.cm; flash = '';
    if (action === 'tab') { query = ''; const tab = target.dataset.tab; navigate({ tab }); host.querySelector(`#cm-tab-${tab}`)?.focus(); }
    if (action === 'setup-tech-team') {
      target.disabled = true; target.textContent = 'Setting up team…';
      try { const result = await organization.setupTechTeam(); flash = result.message; navigate({ tab: 'departments' }); notify(flash); }
      catch (error) { notify(error.message); target.disabled = false; target.textContent = 'Set up tech team'; }
      return;
    }
    if (action === 'new-agent') navigate({ tab: 'agents', editAgentId: '' });
    if (action === 'new-department') navigate({ tab: 'departments', editDepartmentId: '' });
    if (action === 'edit-agent') navigate({ tab: 'agents', editAgentId: target.dataset.agentId });
    if (action === 'edit-department') navigate({ tab: 'departments', editDepartmentId: target.dataset.departmentId });
    if (action === 'back') { try { await organization.refreshOrganization(); } catch (error) { notify(error.message); } navigate({ tab: current.editDepartmentId !== undefined ? 'departments' : 'agents' }); }
    if (action === 'archived') navigate({ tab: 'archived' });
    if (action === 'clear-filters') { query = ''; departmentFilter = ''; roleFilter = ''; navigate({ tab: current.tab }); }
    if (action === 'refresh-models') loadRuntimeGroup(target.closest('[data-runtime-group]'), { force: true });
    const mutations = { 'archive-agent': ['archiveAgent', target.dataset.agentId, 'Agent archived. Existing run history remains available.'], 'archive-department': ['archiveDepartment', target.dataset.departmentId, 'Department archived. It receives no new work.'] };
    if (mutations[action]) {
      const [method, id, message] = mutations[action]; target.disabled = true;
      try { await organization[method](id); flash = message; navigate({ tab: current.tab }); notify(message); }
      catch (error) { notify(Object.values(error.fields || {})[0] || error.message); target.disabled = false; }
    }
  }
  function updateModelIdentity(group, catalog) {
    const value = group.querySelector('[data-model-select]').value;
    const id = value || organization.runtimeInfo(group.querySelector('[data-runtime-select]').value)?.model || catalog.defaultModel;
    const model = catalog.models?.find(m => m.id === id);
    const output = group.querySelector('[data-model-identity]');
    if (!output) return;
    output.innerHTML = model ? `<code>${escape(model.resolvedModel || model.id)}</code>${model.resolvedModel && model.resolvedModel !== model.id ? `<span>Selected as ${escape(model.id)}</span>` : ''}` : id ? `<code>${escape(id)}</code>` : '<span>Uses the runtime’s configured model.</span>';
  }
  function updateEfforts(group, catalog, preferred = '') {
    const model = group.querySelector('[data-model-select]').value || organization.runtimeInfo(group.querySelector('[data-runtime-select]').value)?.model || catalog.defaultModel;
    const found = catalog.models?.find(m => m.id === model); const select = group.querySelector('[data-effort-select]');
    const inheritedEffort = organization.runtimeInfo(group.querySelector('[data-runtime-select]').value)?.effort || found?.defaultEffort;
    const choices = [['', `Runtime default${inheritedEffort ? ` · ${inheritedEffort}` : ''}`], ...(found?.efforts || []).map(e => [e, e.charAt(0).toUpperCase() + e.slice(1)])];
    if (preferred && !choices.some(([id]) => id === preferred)) choices.push([preferred, `${preferred} · not reported by this model`]);
    select.innerHTML = optionList(choices, preferred); select.disabled = false; updateModelIdentity(group, catalog);
  }
  async function loadRuntimeGroup(group, { changed = false, force = false } = {}) {
    if (!group) return;
    const runtime = group.querySelector('[data-runtime-select]'); const model = group.querySelector('[data-model-select]'); const effort = group.querySelector('[data-effort-select]'); const status = group.querySelector('[data-catalog-status]'); const action = group.querySelector('[data-catalog-action]');
    const request = String(++modelRequest); group.dataset.request = request; group.dataset.loading = 'true'; group.setAttribute('aria-busy', 'true');
    const selected = changed ? '' : model.dataset.initial ?? model.value; const selectedEffort = changed ? '' : effort.dataset.initial ?? effort.value;
    delete model.dataset.initial; delete effort.dataset.initial;
    model.disabled = true; effort.disabled = true; status.textContent = 'Reading models from the installed runtime…'; action.innerHTML = '';
    try {
      const catalog = await organization.loadModels(runtime.value, { force }); if (!group.isConnected || group.dataset.request !== request) return;
      const inherited = organization.runtimeInfo(runtime.value)?.model || catalog.defaultModel;
      const options = [['', `Runtime default${inherited ? ` · ${inherited}` : ''}`], ...(catalog.models || []).map(m => [m.id, m.label || m.id])];
      if (selected && !options.some(([id]) => id === selected)) options.push([selected, `${selected} · configured, not in current catalog`]);
      model.innerHTML = optionList(options, selected); model.disabled = false; updateEfforts(group, catalog, selectedEffort);
      status.textContent = catalog.status === 'available' ? `${catalog.models.length} models · ${catalog.runtimeLabel || catalog.adapter || 'Installed runtime'}${catalog.version ? ` ${catalog.version}` : ''}` : (catalog.diagnostics || []).join(' ') || 'Model catalog unavailable. Runtime defaults remain available.'; action.innerHTML = button('refresh-models', 'Refresh models', 'reset', '', 'cm-catalog-refresh');
    } catch (error) {
      if (!group.isConnected || group.dataset.request !== request) return;
      model.innerHTML = optionList([['', 'Runtime default'], ...(selected ? [[selected, `${selected} · saved setting`]] : [])], selected); model.disabled = false;
      effort.innerHTML = optionList([['', 'Runtime default'], ...(selectedEffort ? [[selectedEffort, `${selectedEffort} · saved setting`]] : [])], selectedEffort); effort.disabled = false;
      status.textContent = error.message || 'Could not read runtime models.'; action.innerHTML = button('refresh-models', 'Retry', 'reset', '', 'cm-catalog-refresh'); updateModelIdentity(group, { models: [] });
    } finally { if (group.dataset.request === request) { delete group.dataset.loading; group.setAttribute('aria-busy', 'false'); } }
  }
  function mount(element) {
    host = element; controller?.abort(); controller = new AbortController(); const { signal } = controller;
    host.addEventListener('keydown', event => {
      const tab = event.target.closest('[role=tab][data-tab]'); if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const tabs = ['agents','departments','archived']; const index = tabs.indexOf(tab.dataset.tab); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      query = ''; navigate({ tab: next }); host.querySelector(`#cm-tab-${next}`)?.focus();
    }, { signal });
    host.addEventListener('click', click, { signal }); host.addEventListener('submit', submit, { signal });
    host.addEventListener('input', event => {
      if (event.target.id === 'cm-search') { query = event.target.value; updateResults(); }
      else {
        if (['cm-name', 'cm-headName'].includes(event.target.id)) {
          const field = event.target.id === 'cm-headName' ? 'headAvatarId' : 'avatarId';
          const picker = host.querySelector(`[data-avatar-picker][data-cm-field="${field}"]`);
          if (picker) {
            picker.dataset.avatarName = event.target.value.trim() || 'New teammate';
            const original = picker.querySelector('input[value=""] + .cm-avatar-choice .avatar');
            if (original) original.outerHTML = avatar(picker.dataset.avatarName, 44, { avatarId: null });
            const selected = picker.querySelector('input:checked');
            if (selected?.value === '') updateAvatarPreview(selected);
          }
        }
        clearError(event.target);
      }
    }, { signal });
    host.addEventListener('change', event => {
      if (event.target.matches('[data-avatar-picker] input[type=radio]')) updateAvatarPreview(event.target);
      if (event.target.id === 'cm-department-filter') { departmentFilter = event.target.value; updateResults(); }
      if (event.target.id === 'cm-role-filter') { roleFilter = event.target.value; updateResults(); }
      if (event.target.matches('[data-runtime-select]')) loadRuntimeGroup(event.target.closest('[data-runtime-group]'), { changed: true });
      if (event.target.matches('[data-model-select]')) { const group = event.target.closest('[data-runtime-group]'); updateEfforts(group, organization.modelCatalog(group.querySelector('[data-runtime-select]').value) || { models: [] }); }
      if (event.target.id === 'cm-projectScope') host.querySelector('[data-cm-field="projectIds"]').hidden = event.target.value !== 'restricted';
      if (event.target.id === 'cm-role') host.querySelector('#cm-worker-options').hidden = event.target.value === 'head';
      clearError(event.target);
    }, { signal });
    const scopeControl = host.querySelector('#cm-projectScope');
    if (scopeControl) host.querySelector('[data-cm-field="projectIds"]').hidden = scopeControl.value !== 'restricted';
    host.querySelectorAll('[data-runtime-group]').forEach(group => loadRuntimeGroup(group));
    if (host.querySelector('#cm-results')) Promise.allSettled([...new Set(organization.allAgents().map(agent => agent.runtime).filter(Boolean))].map(id => organization.loadModels(id))).then(() => { if (!signal.aborted) updateResults(); });
  }
  return { render, mount };
}
