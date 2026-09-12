/** Department and head creation, using the original office's agent form styles. */
import { getJson, postJson } from '../../workspace/src/api.js';

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const DEPARTMENT_COLORS = [['blue', 'Blue'], ['rose', 'Rose'], ['sand', 'Sand'], ['lavender', 'Lavender'], ['sage', 'Sage'], ['slate', 'Slate']];
const fold = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const invalid = (fields, message = 'Please check the highlighted department settings.') => Object.assign(new Error(message), { fields });
const slug = (value, fallback) => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '') || fallback;
function allocateId(config, collection, value, fallback) {
  const base = slug(value, fallback);
  const used = new Set([...(config[collection] || []).map((item) => item.id), ...(config.retiredIds?.[collection] || [])]);
  if (collection === 'agents') used.add('control');
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const id = `${base.slice(0, 47 - String(suffix).length)}-${suffix}`;
    if (!used.has(id)) return id;
  }
}

export function departmentRuntimeOptions(document) {
  const config = document?.workspace || document;
  const result = Object.entries(config?.runtimes || {}).filter(([, runtime]) => ['codex', 'claude-code'].includes(runtime.adapter)).map(([id, runtime]) => ({ id, name: `${runtime.adapter === 'codex' ? 'Codex CLI' : 'Claude Code'}${['codex-local', 'claude-local'].includes(id) ? '' : ` · ${id}`}` }));
  for (const [id, name] of [['codex-local', 'Codex CLI'], ['claude-local', 'Claude Code']]) if (!config?.runtimes?.[id]) result.push({ id, name });
  return result;
}

/** A single revisioned batch: the head cannot be saved without its department. */
export function buildDepartmentOps(values, document) {
  const config = document?.workspace || document;
  if (!config?.departments || !config?.agents) throw invalid({}, 'The workspace could not be read. Reload it before creating a department.');
  const name = String(values.name || '').trim();
  const note = String(values.note || '').trim();
  const headName = String(values.headName || '').trim();
  const runtime = String(values.runtime || 'codex-local');
  const model = String(values.model || '').trim();
  const instructions = String(values.instructions || '').trim();
  const color = String(values.color || 'sage');
  const fields = {};
  if (!name || name.length > 60) fields.name = 'Enter a department name from 1 to 60 characters.';
  if (note.length > 60) fields.note = 'Keep the note within 60 characters.';
  if (config.departments.some((department) => fold(department.name) === fold(name) && fold(department.note) === fold(note))) fields.name = 'A department already has this name and note. Choose another name or add a distinguishing note.';
  if (!headName || headName.length > 60) fields.headName = 'Enter a head name from 1 to 60 characters.';
  if (!DEPARTMENT_COLORS.some(([id]) => id === color)) fields.color = 'Choose a department color.';
  if (!departmentRuntimeOptions(document).some((option) => option.id === runtime)) fields.runtime = 'Choose a supported coding runtime.';
  if (model.length > 128) fields.model = 'Keep the model ID within 128 characters.';
  if (instructions.length > 12000) fields.instructions = 'Keep the instructions within 12,000 characters.';
  if (Object.keys(fields).length) throw invalid(fields);
  const departmentId = allocateId(config, 'departments', note ? `${name} ${note}` : name, 'department');
  const headId = allocateId(config, 'agents', headName, 'head');
  const revision = document?.revision ?? config.revision;
  if (!Number.isInteger(revision) || revision < 0) throw invalid({}, 'The workspace revision is unavailable. Reload before saving.');
  return {
    expectRevision: revision,
    departmentId,
    headId,
    ops: [
      { op: 'department.add', id: departmentId, name, color, ...(note ? { note } : {}) },
      { op: 'agent.add', id: headId, name: headName, role: 'head', departmentId, runtime, policy: 'analysis', projectIds: [], ...(model ? { model } : {}), ...(instructions ? { instructions } : {}) },
    ],
  };
}

export async function saveDepartment(values, document, commit = postJson) {
  const batch = buildDepartmentOps(values, document);
  const result = await commit('/api/workspace/ops', { expectRevision: batch.expectRevision, ops: batch.ops });
  return { document: { ...document, workspace: result.workspace, revision: result.revision }, department: result.workspace.departments.find((item) => item.id === batch.departmentId), head: result.workspace.agents.find((item) => item.id === batch.headId) };
}

export function createDepartmentManager({ element, getWorkspace = () => null, onSaved = () => {}, onClose = () => {}, loadWorkspace = () => getJson('/api/workspace'), commit = postJson }) {
  let active = false;
  let saving = false;
  let opening = 0;
  let opener = null;
  let snapshot = null;
  element.classList.add('agent-manager', 'department-manager');
  element.setAttribute('aria-label', 'Create a department');
  element.hidden = true;
  const field = (name, label, input, hint = '') => `<div class="am-field"><label for="dm-${name}">${label}</label>${input}${hint ? `<p class="am-hint" id="dm-${name}-hint">${hint}</p>` : ''}<p class="am-field-error" id="dm-${name}-error" hidden></p></div>`;
  const text = (name, label, value, max = 60, hint = '') => field(name, label, `<input id="dm-${name}" name="${name}" value="${esc(value)}" maxlength="${max}" autocomplete="off"${hint ? ` aria-describedby="dm-${name}-hint"` : ''}>`, hint);
  const header = () => '<header class="am-header"><div class="am-kicker"><span>WORKFORCE SETUP</span><button type="button" class="am-icon-button" data-dm="close" aria-label="Close department setup">✕</button></div><div class="am-heading-row"><h1>Create a department</h1></div><p>Create a department and bind its head to a local runtime.</p></header>';
  function hide() {
    active = false;
    opening += 1;
    element.hidden = true;
    if (![...document.querySelectorAll('.agent-manager')].some((manager) => manager !== element && !manager.hidden)) document.body.classList.remove('manager-open');
  }
  function close() { if (saving) return; hide(); onClose(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  function showErrors(error) {
    const box = element.querySelector('[data-dm-error]');
    if (box) { box.hidden = false; box.textContent = error?.message || 'The department could not be saved.'; }
    let first;
    for (const [name, message] of Object.entries(error?.fields || {})) {
      const input = element.querySelector(`#dm-${name}`);
      const detail = element.querySelector(`#dm-${name}-error`);
      if (!input || !detail) continue;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', detail.id);
      detail.textContent = message;
      detail.hidden = false;
      first ||= input;
    }
    (first || box)?.focus?.({ preventScroll: true });
    (first || box)?.scrollIntoView?.({ block: 'nearest' });
  }
  function renderForm(values = {}) {
    const colors = DEPARTMENT_COLORS.map(([id, name]) => `<option value="${id}"${(values.color || 'sage') === id ? ' selected' : ''}>${name}</option>`).join('');
    const runtimes = departmentRuntimeOptions(snapshot).map((runtime) => `<option value="${esc(runtime.id)}"${(values.runtime || 'codex-local') === runtime.id ? ' selected' : ''}>${esc(runtime.name)}</option>`).join('');
    element.innerHTML = `${header()}<form class="am-form" novalidate><div class="am-scroll am-form-scroll"><div class="am-local-note"><span class="am-local-dot"></span><p><strong>Department and head saved together</strong><br>The head plans requests and delegates to assigned workers. Add workers and choose their projects after creating the department.</p></div><div class="am-form-error" data-dm-error role="alert" tabindex="-1" hidden></div><fieldset class="am-section"><legend>Department</legend>${text('name', 'Department name', values.name || '')}${text('note', 'Note (optional)', values.note || '', 60, 'Use a note to distinguish departments that share a name.')}${field('color', 'Department color', `<select name="color" id="dm-color">${colors}</select>`)}</fieldset><fieldset class="am-section"><legend>Department head</legend>${text('headName', 'Agent name', values.headName || '')}${field('runtime', 'Installed coding runtime', `<select name="runtime" id="dm-runtime">${runtimes}</select>`, 'Uses the CLI’s existing sign-in. Heads read and plan with the analysis policy.')}${text('model', 'Model ID (optional)', values.model || '', 128, 'Leave blank for the installed tool’s configured default.')}${field('instructions', 'Instructions (optional)', `<textarea name="instructions" id="dm-instructions" rows="5" maxlength="12000" placeholder="Describe the department’s responsibilities and how its head should plan and delegate.">${esc(values.instructions || '')}</textarea>`, 'Leave blank for the standard planning instructions.')}<p class="am-hint">A head reaches projects through its workers. You can create this department before adding any projects.</p></fieldset></div><footer class="am-form-footer"><button type="button" class="am-button am-secondary" data-dm="close">Cancel</button><button type="submit" class="am-button am-primary">Create department <span aria-hidden="true">+</span></button></footer></form>`;
    const form = element.querySelector('form');
    let headEdited = Boolean(values.headName);
    form.elements.name.addEventListener('input', () => { if (!headEdited) form.elements.headName.value = `${form.elements.name.value.trim()} head`.trim(); });
    form.elements.headName.addEventListener('input', () => { headEdited = true; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      const values = Object.fromEntries(new FormData(form));
      form.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
      form.querySelectorAll('.am-field-error').forEach((error) => { error.hidden = true; });
      element.querySelector('[data-dm-error]').hidden = true;
      saving = true;
      form.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const saved = await saveDepartment(values, snapshot, commit);
        saving = false;
        hide();
        try { await onSaved(saved); } catch { /* Save succeeded; a refresh failure must not invite duplicate creation. */ }
        onClose();
      } catch (error) {
        saving = false;
        form.querySelectorAll('button').forEach((button) => { button.disabled = false; });
        if (['workspace_revision_conflict', 'workspace_changed_on_disk'].includes(error.code)) {
          try { snapshot = await loadWorkspace(); error.message = 'The workspace changed while you were editing. Your draft is still here; review it and click Create department again to save against the latest version.'; } catch { error.message = 'The workspace changed and could not be refreshed. Your draft is still here; close and reopen this form when the server is available.'; }
        }
        showErrors(error);
      }
    });
    element.querySelector('#dm-name').focus({ preventScroll: true });
  }
  async function showCreate(values = {}) {
    if (saving) return;
    if (!active) opener = document.activeElement;
    active = true;
    element.hidden = false;
    document.body.classList.add('manager-open');
    const attempt = ++opening;
    element.innerHTML = `${header()}<div class="am-scroll am-form-scroll"><p>Reading your workspace…</p></div>`;
    snapshot = getWorkspace();
    try { snapshot = await loadWorkspace(); if (attempt === opening && active) renderForm(values); }
    catch (error) {
      if (attempt !== opening || !active) return;
      element.innerHTML = `${header()}<div class="am-scroll am-form-scroll"><div class="am-form-error" role="alert">${esc(error.message || 'Could not read your workspace.')}</div><button class="am-button am-secondary" data-dm="retry">Try again</button></div>`;
    }
  }
  element.addEventListener('click', (event) => { const button = event.target.closest('[data-dm]'); if (!button || !element.contains(button)) return; if (button.dataset.dm === 'close') close(); else if (button.dataset.dm === 'retry') showCreate(); });
  element.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  return { showCreate, hide, close, isOpen: () => active };
}
