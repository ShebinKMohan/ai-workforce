/** Project registration and explicit worker assignments use one revisioned save. */
import { getJson, postJson } from '../../workspace/src/api.js';
import { inspectionLines } from '../../workspace/src/sheets/add-project.js';

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const invalid = (message, fields = {}) => Object.assign(new Error(message), { fields });
const configOf = (document) => document?.workspace || document;

function projectId(config, name) {
  const base = String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'project';
  const used = new Set([...(config.projects || []).map((item) => item.id), ...(config.retiredIds?.projects || [])]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function buildProjectOps(values, inspection, document) {
  const config = configOf(document);
  const revision = document?.revision ?? config?.revision;
  if (!config?.projects || !Number.isInteger(revision)) throw invalid('Reload the workspace before adding a project.');
  if (!inspection?.canAdd || !inspection.repositoryRoot || !inspection.headRevision) throw invalid('Inspect a Git repository with at least one commit before saving.', { path: 'Check this repository first.' });
  const name = String(values.name || '').trim();
  if (!name || name.length > 80) throw invalid('Enter a project name from 1 to 80 characters.', { name: 'A project name is required.' });
  const checks = String(values.checks || '').split('\n').map((value) => value.trim()).filter(Boolean);
  if (checks.length > 32 || checks.some((check) => check.length > 500)) throw invalid('Use up to 32 check commands, each no longer than 500 characters.');
  const selected = [...new Set(values.workerIds || [])];
  const workers = new Map((config.agents || []).filter((agent) => !agent.archived && agent.role === 'worker' && config.departments?.some((department) => department.id === agent.departmentId && !department.archived)).map((agent) => [agent.id, agent]));
  if (selected.some((id) => !workers.has(id))) throw invalid('A selected worker is no longer available. Refresh the form and choose the current workers.');
  const id = projectId(config, name);
  return {
    expectRevision: revision,
    projectId: id,
    ops: [
      { op: 'project.add', id, name, repoPath: inspection.repositoryRoot, ...(checks.length ? { checks } : {}) },
      ...selected.map((agentId) => ({ op: 'agent.assign', agentId, projectId: id })),
    ],
  };
}

export async function saveProject(values, inspection, document, commit = postJson) {
  const batch = buildProjectOps(values, inspection, document);
  const result = await commit('/api/workspace/ops', { expectRevision: batch.expectRevision, ops: batch.ops });
  return { document: { ...document, workspace: result.workspace, revision: result.revision }, project: result.workspace.projects.find((project) => project.id === batch.projectId), projectId: batch.projectId };
}

export function createProjectManager({ element, getWorkspace = () => null, onSaved = () => {}, onClose = () => {}, loadWorkspace = () => getJson('/api/workspace'), inspect = (path) => postJson('/api/projects/inspect', { path }), commit = postJson }) {
  let active = false;
  let saving = false;
  let inspecting = false;
  let opening = 0;
  let opener = null;
  let snapshot = null;
  let inspection = null;
  let inspectedPath = '';
  let draft = { path: '', name: '', checks: '', workerIds: [] };
  element.classList.add('agent-manager', 'project-manager');
  element.setAttribute('aria-label', 'Add a project');
  element.hidden = true;

  const header = () => '<header class="am-header"><div class="am-kicker"><span>PROJECT SETUP</span><button type="button" class="am-icon-button" data-pm="close" aria-label="Close project setup">✕</button></div><div class="am-heading-row"><h1>Add a project</h1></div><p>Connect a local repository, define verification, and choose the workers who can receive its tasks.</p></header>';
  function hide() {
    active = false;
    opening += 1;
    element.hidden = true;
    if (![...document.querySelectorAll('.agent-manager')].some((manager) => manager !== element && !manager.hidden)) document.body.classList.remove('manager-open');
  }
  function close() { if (saving) return; hide(); onClose(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  function readForm() {
    const form = element.querySelector('form');
    if (!form) return draft;
    const data = new FormData(form);
    draft = {
      path: String(data.get('path') || ''),
      name: data.has('name') ? String(data.get('name') || '') : draft.name,
      checks: data.has('checks') ? String(data.get('checks') || '') : draft.checks,
      workerIds: form.querySelector('input[name="workerIds"]') ? data.getAll('workerIds').map(String) : draft.workerIds,
    };
    return draft;
  }
  function showError(error) {
    const box = element.querySelector('[data-pm-error]');
    if (!box) return;
    box.hidden = false;
    box.textContent = error?.message || 'Project setup could not be saved.';
    box.focus({ preventScroll: true });
    box.scrollIntoView?.({ block: 'nearest' });
  }
  function workerRows() {
    const config = configOf(snapshot);
    const workers = (config?.agents || []).filter((agent) => agent.role === 'worker' && !agent.archived && config.departments?.some((department) => department.id === agent.departmentId && !department.archived));
    if (!workers.length) return '<div class="pm-empty"><strong>No workers configured</strong><p>Save this project, then add a worker from Agents and assign this project. Tasks become available when a team has an assigned worker.</p></div>';
    return `<div class="pm-workers">${workers.map((worker) => {
      const department = config.departments.find((item) => item.id === worker.departmentId);
      const adapter = config.runtimes?.[worker.runtime]?.adapter;
      return `<label class="pm-worker"><input type="checkbox" name="workerIds" value="${esc(worker.id)}"${draft.workerIds.includes(worker.id) ? ' checked' : ''}><span><strong>${esc(worker.name)}</strong><small>${esc(department?.name || 'Team')}${department?.note ? ` · ${esc(department.note)}` : ''} · ${esc(adapter === 'codex' ? 'Codex' : adapter === 'claude-code' ? 'Claude Code' : worker.runtime)}</small></span><span class="pm-worker-policy">${worker.policy === 'analysis' ? 'Analysis' : 'Development'}</span></label>`;
    }).join('')}</div><p class="am-hint">Only selected workers receive access to this project. Their department head plans its tasks automatically.</p>`;
  }
  function render() {
    const validInspection = inspection && draft.path.trim() === inspectedPath;
    const lines = validInspection ? inspectionLines(inspection) : [];
    const canAdd = validInspection && inspection.canAdd;
    const criteria = inspection?.checks?.criteria || [];
    element.innerHTML = `${header()}<form class="am-form" novalidate><div class="am-scroll am-form-scroll"><div class="am-form-error" data-pm-error role="alert" tabindex="-1" hidden></div><fieldset class="am-section"><legend><span>01</span>Repository</legend><div class="am-field"><label for="pm-path">Repository path</label><div class="pm-path-row"><input id="pm-path" name="path" value="${esc(draft.path)}" placeholder="/Users/you/code/my-app" autocomplete="off" spellcheck="false"><button class="am-button am-secondary" type="button" data-pm="inspect"${inspecting ? ' disabled' : ''}>${inspecting ? 'Inspecting…' : 'Inspect'}</button></div><p class="am-hint">Enter an absolute folder path or use ~/ for your home folder.</p></div>${lines.length ? `<div class="pm-inspection" role="status">${lines.map((line) => `<p class="pm-${line.tone}">${esc(line.text)}</p>`).join('')}${inspection.headRevision ? `<code>HEAD ${esc(inspection.headRevision.slice(0, 12))}</code>` : ''}</div>` : ''}${canAdd ? `<div class="am-field"><label for="pm-name">Project name</label><input id="pm-name" name="name" maxlength="80" value="${esc(draft.name)}"></div>` : ''}</fieldset>${canAdd ? `<fieldset class="am-section"><legend><span>02</span>Verification</legend>${criteria.length ? `<p class="am-hint">Detected from the committed repository. These commands run against the completed candidate.</p><ul class="pm-checks">${criteria.map((criterion) => `<li><code>${esc([criterion.command, ...(criterion.args || [])].join(' '))}</code></li>`).join('')}</ul><details class="pm-advanced"><summary>Use different checks</summary><div class="am-field"><label for="pm-checks">Check commands</label><textarea id="pm-checks" name="checks" rows="3" placeholder="npm test">${esc(draft.checks)}</textarea><p class="am-hint">One command per line. Leave empty to keep the detected checks.</p></div></details>` : `<div class="am-field"><label for="pm-checks">Check commands</label><textarea id="pm-checks" name="checks" rows="3" placeholder="npm test">${esc(draft.checks)}</textarea><p class="am-hint">${inspection.checks?.error ? `${esc(inspection.checks.error.message)} ` : 'No verification commands were detected. '}Enter one command per line. At least one check is required before work can run.</p></div>`}<p class="am-hint">Tasks use committed HEAD in an isolated candidate. Required dependencies must be available to the candidate and its verification environment.</p></fieldset><fieldset class="am-section"><legend><span>03</span>Worker access</legend>${workerRows()}</fieldset>` : ''}</div><footer class="am-form-footer"><button class="am-button am-secondary" type="button" data-pm="close">Cancel</button><button class="am-button am-primary" type="submit"${canAdd && !saving ? '' : ' disabled'}>${saving ? 'Saving…' : 'Add project'}</button></footer></form>`;
    const form = element.querySelector('form');
    form.elements.path.addEventListener('input', () => {
      draft.path = form.elements.path.value;
      if (draft.path.trim() !== inspectedPath) form.querySelector('[type="submit"]').disabled = true;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || inspecting) return;
      readForm();
      if (draft.path.trim() !== inspectedPath) { showError(invalid('The path changed. Inspect this repository before adding it.')); return; }
      saving = true;
      form.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const saved = await saveProject(draft, inspection, snapshot, commit);
        saving = false;
        hide();
        try { await onSaved(saved); } catch { /* Registration succeeded. A refresh error must not offer duplicate creation. */ }
        onClose();
      } catch (error) {
        saving = false;
        if (['workspace_revision_conflict', 'workspace_changed_on_disk'].includes(error.code)) {
          try { snapshot = await loadWorkspace(); error.message = 'The workspace changed while you were editing. Your draft is preserved. Review the current workers and save again.'; }
          catch { error.message = 'The workspace changed and could not be refreshed. Your draft is preserved; reconnect before saving.'; }
        }
        render();
        showError(error);
      }
    });
  }
  async function inspectPath() {
    if (saving || inspecting) return;
    readForm();
    const path = draft.path.trim();
    if (!/^(\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path)) { showError(invalid('Enter an absolute repository path, or start with ~/.')); return; }
    const attempt = opening;
    inspecting = true;
    render();
    try {
      const result = await inspect(path);
      if (!active || attempt !== opening) return;
      const hadNameField = Boolean(element.querySelector('#pm-name'));
      readForm();
      inspection = result;
      inspectedPath = path;
      if (!hadNameField && !draft.name) draft.name = result.suggestedName || '';
      inspecting = false;
      render();
      element.querySelector(result.canAdd ? '#pm-name' : '#pm-path')?.focus({ preventScroll: true });
    } catch (error) {
      if (!active || attempt !== opening) return;
      readForm();
      inspecting = false;
      render();
      showError(error);
    }
  }
  async function showCreate(values = {}) {
    if (saving) return;
    if (!active) opener = document.activeElement;
    active = true;
    inspection = null;
    inspectedPath = '';
    inspecting = false;
    draft = { path: '', name: '', checks: '', workerIds: [], ...values };
    element.hidden = false;
    document.body.classList.add('manager-open');
    const attempt = ++opening;
    snapshot = getWorkspace();
    element.innerHTML = `${header()}<div class="am-scroll am-form-scroll"><p role="status">Reading your workspace…</p></div>`;
    try {
      snapshot = await loadWorkspace();
      if (!active || attempt !== opening) return;
      render();
      element.querySelector('#pm-path')?.focus({ preventScroll: true });
    } catch (error) {
      if (!active || attempt !== opening) return;
      element.innerHTML = `${header()}<div class="am-scroll am-form-scroll"><div class="am-form-error" role="alert">${esc(error.message)}</div><button class="am-button am-secondary" data-pm="retry">Try again</button></div>`;
    }
  }
  element.addEventListener('click', (event) => {
    const action = event.target.closest('[data-pm]');
    if (!action || !element.contains(action)) return;
    if (action.dataset.pm === 'close') close();
    else if (action.dataset.pm === 'inspect') inspectPath();
    else if (action.dataset.pm === 'retry') showCreate(draft);
  });
  element.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  return { showCreate, hide, close, isOpen: () => active };
}
