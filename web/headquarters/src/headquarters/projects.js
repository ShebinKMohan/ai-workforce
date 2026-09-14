/** Project management backed by the installed Workforce coordinator. No simulated records. */
import { requestTaskStatus } from './task-status.js';

export function projectRunPresentation(run) {
  if (run.workKind === 'analysis' && ['ready_for_review', 'failed', 'cancelled', 'interrupted'].includes(run.state)) {
    return requestTaskStatus({ state: 'ended', runId: run.id, exitCode: 0 }, run);
  }
  return { label: String(run.state || 'Unknown').replaceAll('_', ' '), tone: 'neutral' };
}
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const symbols = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  up: '<path d="m6 10 6-6 6 6M12 4v16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7v3a4 4 0 0 1-4 4H6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 6"/>',
  archive: '<path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/>',
};
const icon = name => `<svg aria-hidden="true" class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${symbols[name] || symbols.folder}</svg>`;
const button = (action, label, symbol, attributes = '', style = '') => `<button type="button" class="pm-button ${style}" data-pm="${action}" ${attributes}>${symbol ? icon(symbol) : ''}${label}</button>`;
const time = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not started';
const message = error => error?.message || 'The coordinator could not complete this request. Try again.';

/** api(path, body?) uses GET without body and authenticated JSON POST with body.
 * onChange receives a fresh GET /api/workspace envelope after each saved change.
 */
export function createProjectManager({ api, notify = () => {}, onChange = () => {}, onNavigate = () => {} }) {
  let host, document = null, projectId = null, error = '', busy = false, showArchived = false;
  let runs = [], runsError = '', runsLoading = false, readSequence = 0, detailSequence = 0, query = '';
  let dialog = null, picker = null, returnFocus = null, pickerSequence = 0, destroyed = false;
  const projects = () => document?.workspace?.projects || [];
  const current = () => projects().find(project => project.id === projectId);
  const announce = text => { const output = host?.querySelector('[data-pm-status]'); if (output) output.textContent = text; };

  function shell() {
    return `<section class="pm-workspace" aria-label="Projects"><div data-pm-content></div><p class="pm-sr-only" data-pm-status role="status" aria-live="polite"></p></section>`;
  }
  function render() {
    const content = host?.querySelector('[data-pm-content]');
    if (!content) return;
    if (!document && !error) { content.innerHTML = '<div class="pm-loading" role="status"><span class="pm-spinner"></span>Connecting to your projects…</div>'; return; }
    content.innerHTML = projectId && current() ? detail(current()) : directory();
    onNavigate(projectId && current() ? {id:current().id,name:current().name} : null);
  }
  function directory() {
    const list = projects().filter(project => (showArchived || !project.archived) && `${project.name} ${project.repoPath}`.toLowerCase().includes(query.toLowerCase()));
    return `<header class="pm-heading"><div><h1>Projects</h1><p>Your codebases, shared across the team. Add a folder to start.</p></div>${button('browse', 'Add project', 'plus', busy || !document?.workspace ? 'disabled' : '', 'pm-primary')}</header>${error ? `<div class="pm-error" role="alert">${esc(error)}${button('refresh', 'Try again', 'refresh')}</div>` : ''}<div class="pm-toolbar"><label class="pm-search">${icon('search')}<span class="pm-sr-only">Search projects</span><input name="project-search" type="search" placeholder="Search your projects" value="${esc(query)}" autocomplete="off"></label><label class="pm-archive-toggle"><input type="checkbox" name="show-archived" ${showArchived ? 'checked' : ''}>Show archived</label>${button('refresh', '', 'refresh', 'aria-label="Refresh projects" title="Refresh projects"')}</div><div class="pm-project-list" data-pm-list>${cards(list)}</div><p class="pm-footer-note">${icon('folder')}Project folders stay on your computer. Your installed runtimes work through the coordinator.</p>`;
  }
  function cards(list) {
    return list.length ? list.map(project => `<article class="pm-project-card${project.archived ? ' pm-is-archived' : ''}"><div class="pm-folder-tile">${icon('folder')}</div><div class="pm-project-copy"><button type="button" data-pm="open" data-id="${esc(project.id)}" class="pm-project-title">${esc(project.name)}</button><p title="${esc(project.repoPath)}">${esc(project.repoPath)}</p><span class="pm-project-meta">${icon('git')}Git project<span>·</span>${project.archived ? 'Archived' : 'Available to Control Center'}${project.checks?.length ? `<span>·</span>${project.checks.length} verification ${project.checks.length === 1 ? 'command' : 'commands'}` : ''}</span></div>${button('open', 'Open project', 'next', `data-id="${esc(project.id)}" aria-label="Open ${esc(project.name)}"`, 'pm-card-open')}</article>`).join('') : `<div class="pm-empty">${icon('folder')}<h2>${query ? 'No matching projects' : showArchived ? 'No projects yet' : 'Your next project starts here'}</h2><p>${query ? 'Try a different project name or clear your search.' : 'Browse your folders and choose a Git repository with at least one commit.'}</p>${query ? button('clear-search', 'Clear search', null) : button('browse', 'Choose a folder', 'plus', !document?.workspace ? 'disabled' : '', 'pm-primary')}</div>`;
  }
  function detail(project) {
    return `${button('back', 'All projects', 'back', '', 'pm-back')}<header class="pm-heading pm-project-heading"><div class="pm-folder-tile">${icon('folder')}</div><div><p class="eyebrow">${project.archived ? 'ARCHIVED PROJECT' : 'PROJECT WORKSPACE'}</p><h1>${esc(project.name)}</h1><p class="pm-path">${esc(project.repoPath)}</p></div>${button('inspect-project', 'Folder details', 'git', `data-id="${esc(project.id)}"`, 'pm-secondary')}</header>${error ? `<p class="pm-error" role="alert">${esc(error)}</p>` : ''}<div class="pm-detail-grid"><section class="pm-runs"><header class="pm-section-heading"><h2>Recent work</h2>${button('refresh-runs', '', 'refresh', `aria-label="Refresh recent work" ${runsLoading ? 'disabled' : ''}`)}</header><div data-pm-runs>${runList()}</div></section><section class="pm-settings"><h2>Project settings</h2><form data-pm-settings><label for="pm-project-name">Project name</label><input id="pm-project-name" name="name" value="${esc(project.name)}" maxlength="80" required><details class="pm-verification-settings"><summary>Verification commands <span>Optional</span></summary><label for="pm-project-checks">Commands to run</label><textarea id="pm-project-checks" name="checks" rows="5" placeholder="npm test&#10;npm run build">${esc((project.checks || []).join('\n'))}</textarea><p class="pm-hint">Enter one executable command per line, such as npm test. These commands replace the repository’s discovered verification commands. Leave blank to use repository configuration.</p></details><p class="pm-form-error" data-pm-form-error role="alert" hidden></p><button type="submit" class="pm-button pm-primary" ${busy ? 'disabled' : ''}>${icon('check')}Save settings</button></form>${project.archived ? '<p class="pm-archived-note">This project is archived and receives no new assignments. Its files and work history are retained.</p>' : `<div class="pm-archive-section"><h3>Archive project</h3><p>Stop assigning new work to this project. Existing files and work history stay available.</p>${button('archive', 'Archive project', 'archive', `data-id="${esc(project.id)}" ${busy ? 'disabled' : ''}`, 'pm-secondary')}</div>`}</section></div>`;
  }
  function runList() {
    if (runsLoading && !runs.length) return '<div class="pm-loading" role="status"><span class="pm-spinner"></span>Loading recorded work…</div>';
    if (runsError) return `<p class="pm-error" role="alert">${esc(runsError)}</p>`;
    if (!runs.length) return `<div class="pm-empty pm-empty-small">${icon('clock')}<h3>No work recorded yet</h3><p>Select this project in the Control Center conversation and give your team a task.</p></div>`;
    return `<div class="pm-run-list">${runs.map(run => `<article class="pm-run"><div class="pm-run-heading"><h3>${esc(run.request?.text || run.id)}</h3><span class="pm-run-state" data-tone="${esc(projectRunPresentation(run).tone)}">${esc(projectRunPresentation(run).label)}</span></div><p>${esc(time(run.createdAt))}<span>·</span>${run.tasks?.total || 0} task${run.tasks?.total === 1 ? '' : 's'}${run.tasks?.agents?.length ? `<span>·</span>${run.tasks.agents.length} teammate${run.tasks.agents.length === 1 ? '' : 's'}` : ''}</p>${run.outcome?.summary ? `<p class="pm-run-outcome">${esc(run.outcome.summary)}</p>` : ''}<details><summary>Run details</summary><dl><dt>Run ID</dt><dd>${esc(run.id)}</dd><dt>Base revision</dt><dd>${esc(run.baseRevision || 'Unavailable')}</dd><dt>Last update</dt><dd>${esc(time(run.updatedAt))}</dd></dl></details></article>`).join('')}</div>`;
  }
  async function loadRuns() {
    if (!projectId) return;
    const id = projectId, sequence = ++detailSequence;
    runsLoading = true; runsError = '';
    const target = () => host?.querySelector('[data-pm-runs]');
    if (target()) target().innerHTML = runList();
    try { const result = await api(`/api/projects/${encodeURIComponent(id)}/runs?limit=20`); if (sequence !== detailSequence || id !== projectId) return; runs = result.runs || []; }
    catch (err) { if (sequence === detailSequence && id === projectId) runsError = message(err); }
    finally { if (sequence === detailSequence && id === projectId) { runsLoading = false; if (target()) target().innerHTML = runList(); } }
  }
  async function refresh({ preserveForm = false } = {}) {
    const sequence = ++readSequence;
    try {
      const result = await api('/api/workspace');
      if (sequence !== readSequence || destroyed) return;
      if (result.ok === false || !result.workspace) throw new Error(result.error?.message || 'The coordinator workspace is not configured yet.');
      document = result; error = '';
      if (!preserveForm || !host?.querySelector('[data-pm-settings]')) render();
      if (projectId) await loadRuns();
      return result;
    } catch (err) { if (sequence === readSequence && !destroyed) { error = message(err); if (!preserveForm) render(); } }
  }
  async function save(ops) {
    if (busy) return false;
    busy = true;
    try {
      await api('/api/workspace/ops', { expectRevision: document.revision, ops });
      const updated = await api('/api/workspace');
      document = updated; error = ''; await onChange(updated);
      return true;
    } catch (err) {
      // Refresh only the revision on conflicts. Keep every unsaved form value visible.
      if (/revision|conflict/i.test(`${err.code || ''} ${message(err)}`)) {
        try { document = await api('/api/workspace'); } catch { /* Preserve the original error. */ }
      }
      throw err;
    } finally { busy = false; }
  }
  function openProject(id) { projectId = id; runs = []; runsError = ''; render(); host?.scrollTo?.({ top: 0 }); void loadRuns(); }

  function showPicker({ inspectPath = null, detailsOnly = false } = {}) {
    if (dialog) closePicker();
    returnFocus = globalThis.document.activeElement;
    picker = { loading: true, error: '', listing: null, inspection: null, query: '', detailsOnly, selectedName: '' };
    dialog = globalThis.document.createElement('dialog');
    dialog.className = 'pm-picker'; dialog.setAttribute('aria-labelledby', 'pm-picker-title');
    dialog.addEventListener('click', pickerClick); dialog.addEventListener('input', pickerInput); dialog.addEventListener('submit', pickerSubmit);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else closePicker(); });
    dialog.addEventListener('close', () => { if (dialog && !dialog.open) closePicker(); });
    globalThis.document.body.append(dialog); renderPicker(); dialog.showModal();
    if (inspectPath) void inspect(inspectPath); else void browse();
  }
  function closePicker() {
    const old = dialog; dialog = null; picker = null; ++pickerSequence;
    if (old) { old.close(); old.remove(); }
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function renderPicker() {
    if (!dialog || !picker) return;
    const listing = picker.listing, inspection = picker.inspection;
    dialog.innerHTML = `<header class="pm-picker-heading"><div><p class="eyebrow">${picker.detailsOnly ? 'PROJECT FOLDER' : 'ADD A PROJECT'}</p><h2 id="pm-picker-title">${inspection ? picker.detailsOnly ? 'Folder details' : 'Ready for your team?' : 'Choose a folder'}</h2><p>${inspection ? 'Read directly from your computer.' : 'Browse this computer and connected drives.'}</p></div>${button('close-picker', '', 'close', `aria-label="Close folder picker" ${busy ? 'disabled' : ''}`, 'pm-icon-button')}</header>${picker.error ? `<p class="pm-error pm-picker-error" role="alert">${esc(picker.error)}</p>` : ''}${picker.loading ? '<div class="pm-picker-loading" role="status"><span class="pm-spinner"></span>Reading folder…</div>' : ''}${inspection ? inspectionView(inspection) : `<div class="pm-browser${picker.loading ? ' pm-browser-busy' : ''}" aria-busy="${picker.loading}"><aside class="pm-places"><h3>Locations</h3>${(listing?.places || []).map(place => button('place', esc(place.label), 'folder', `data-path="${esc(place.path)}" ${place.path === listing.currentPath ? 'aria-current="location"' : ''}`)).join('')}</aside><section class="pm-folder-content"><div class="pm-folder-location">${button('up-folder', '', 'up', `aria-label="Go to parent folder" ${!listing?.parentPath || picker.loading ? 'disabled' : ''}`)}<div class="pm-folder-breadcrumbs" aria-label="Current folder">${breadcrumbs(listing?.currentPath)}</div></div><label class="pm-search pm-folder-search">${icon('search')}<span class="pm-sr-only">Filter folders</span><input name="folder-search" type="search" placeholder="Filter folders here" value="${esc(picker.query)}" autocomplete="off"></label><div class="pm-folder-list" data-pm-folders>${folderRows()}</div>${listing?.truncated ? '<p class="pm-hint pm-truncated">This folder is large; only the first available folders are shown. Use another location or Go to folder to navigate further.</p>' : ''}</section></div><footer class="pm-picker-footer"><div><strong>${esc(listing?.currentPath?.split('/').filter(Boolean).at(-1) || 'Computer')}</strong><span>${listing?.isGitRepository ? 'Git repository' : 'Choose a folder to inspect its project context'}</span></div>${button('close-picker', 'Cancel', null, busy ? 'disabled' : '', 'pm-secondary')}${button('choose-folder', 'Use this folder', 'check', !listing || picker.loading || busy ? 'disabled' : '', 'pm-primary')}</footer><details class="pm-go-to"><summary>Go to folder</summary><form data-pm-path><label for="pm-folder-path" class="pm-sr-only">Folder location</label><input id="pm-folder-path" name="path" placeholder="~/Projects" autocomplete="off" value="${esc(listing?.currentPath || '')}" required><button class="pm-button pm-secondary" type="submit">Open</button></form></details>`}`;
  }
  function breadcrumbs(path) {
    if (!path) return '<span>Computer</span>';
    const parts = path.split('/').filter(Boolean);
    return `${button('place', 'Computer', null, 'data-path="/"')}${parts.map((part, index) => `${icon('next')}${button('place', esc(part), null, `data-path="/${esc(parts.slice(0, index + 1).join('/'))}" ${index === parts.length - 1 ? 'aria-current="location"' : ''}`)}`).join('')}`;
  }
  function folderRows() {
    const folders = (picker?.listing?.folders || []).filter(folder => folder.name.toLowerCase().includes(picker.query.toLowerCase()));
    return folders.length ? folders.map(folder => `<button type="button" class="pm-folder-row" data-pm="place" data-path="${esc(folder.path)}" aria-label="Open folder ${esc(folder.name)}">${icon('folder')}<span>${esc(folder.name)}</span>${folder.isGitRepository ? `<small>${icon('git')}Git</small>` : ''}${icon('next')}</button>`).join('') : `<div class="pm-no-folders">${icon('folder')}<p>${picker?.query ? 'No matching folders here' : 'No subfolders to show'}</p><span>You can still select the current folder.</span></div>`;
  }
  function inspectionView(inspection) {
    const canAdd = inspection.canAdd && !picker.detailsOnly;
    return `<div class="pm-inspection"><div class="pm-inspection-identity"><div class="pm-folder-tile">${icon('folder')}</div><div><h3>${esc(inspection.suggestedName || inspection.path?.split('/').at(-1) || 'Selected folder')}</h3><p>${esc(inspection.repositoryRoot || inspection.path)}</p></div><span class="pm-inspection-badge${inspection.isGitRepo ? ' pm-good' : ''}">${icon(inspection.isGitRepo ? 'git' : 'folder')}${inspection.isGitRepo ? 'Git repository' : 'Folder'}</span></div>${!inspection.isGitRepo ? '<p class="pm-hint pm-non-git">The installed coordinator currently starts project work from a Git repository with a committed base. Select an existing repository to continue.</p>' : ''}${inspection.reasons?.length && !picker.detailsOnly ? `<ul class="pm-inspection-reasons">${inspection.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}${inspection.isGitRepo ? `<dl class="pm-inspection-facts"><div><dt>Branch</dt><dd>${esc(inspection.branch || (inspection.detachedHead ? 'Detached HEAD' : 'No branch'))}</dd></div><div><dt>Base revision</dt><dd>${esc(inspection.headRevision?.slice(0, 12) || 'No commit yet')}</dd></div><div><dt>Working folder</dt><dd>${inspection.dirty?.clean ? 'Clean' : `${inspection.dirty?.staged || 0} staged · ${inspection.dirty?.unstaged || 0} modified · ${inspection.dirty?.untracked || 0} untracked`}</dd></div><div><dt>Repository checks</dt><dd>${inspection.checks?.count == null ? 'Not discovered' : `${inspection.checks.count} available`}</dd></div></dl>${inspection.checks?.error ? `<p class="pm-error">${esc(inspection.checks.error.message)}</p>` : ''}` : ''}${canAdd ? `<form data-pm-add><label for="pm-new-project-name">Project name</label><input id="pm-new-project-name" name="name" value="${esc(picker.selectedName || inspection.suggestedName)}" maxlength="80" required><p class="pm-hint">Your team will use this name throughout the workspace.</p><div class="pm-inspection-actions">${button('back-to-folders', 'Choose another folder', 'back', busy ? 'disabled' : '', 'pm-secondary')}<button class="pm-button pm-primary" type="submit" ${busy ? 'disabled' : ''}>${icon('plus')}Add project</button></div></form>` : `<div class="pm-inspection-actions">${picker.detailsOnly ? button('close-picker', 'Done', 'check', '', 'pm-primary') : `${button('back-to-folders', 'Choose another folder', 'back', '', 'pm-secondary')}${inspection.existingProjectId ? button('open-existing', 'Open existing project', 'next', '', 'pm-primary') : ''}`}</div>`}</div>`;
  }
  async function browse(path) {
    const sequence = ++pickerSequence;
    picker.loading = true; picker.error = ''; picker.inspection = null; picker.query = ''; renderPicker();
    try {
      const listing = await api('/api/projects/folders', path ? { path } : {});
      if (sequence !== pickerSequence || !picker) return;
      picker.listing = listing;
    } catch (err) { if (sequence === pickerSequence && picker) picker.error = message(err); }
    finally { if (sequence === pickerSequence && picker) { picker.loading = false; renderPicker(); } }
  }
  async function inspect(path) {
    const sequence = ++pickerSequence;
    picker.loading = true; picker.error = ''; renderPicker();
    try {
      const result = await api('/api/projects/inspect', { path });
      if (sequence !== pickerSequence || !picker) return;
      picker.inspection = result; picker.selectedName = result.suggestedName || '';
    } catch (err) { if (sequence === pickerSequence && picker) picker.error = message(err); }
    finally { if (sequence === pickerSequence && picker) { picker.loading = false; renderPicker(); } }
  }
  function pickerClick(event) {
    const target = event.target.closest('[data-pm]'); if (!target || target.disabled || busy || !picker) return;
    switch (target.dataset.pm) {
      case 'close-picker': closePicker(); break;
      case 'place': void browse(target.dataset.path); break;
      case 'up-folder': if (picker.listing?.parentPath) void browse(picker.listing.parentPath); break;
      case 'choose-folder': if (picker.listing) void inspect(picker.listing.currentPath); break;
      case 'back-to-folders': void browse(picker.listing?.currentPath || picker.inspection?.path); break;
      case 'open-existing': { const id = picker.inspection?.existingProjectId; closePicker(); openProject(id); break; }
    }
  }
  function pickerInput(event) {
    if (!picker) return;
    if (event.target.name === 'folder-search') { picker.query = event.target.value; dialog.querySelector('[data-pm-folders]').innerHTML = folderRows(); }
    if (event.target.name === 'name') picker.selectedName = event.target.value;
  }
  async function pickerSubmit(event) {
    event.preventDefault(); if (busy || !picker) return;
    if (event.target.matches('[data-pm-path]')) { void browse(new FormData(event.target).get('path').trim()); return; }
    if (!event.target.matches('[data-pm-add]') || !picker.inspection?.canAdd) return;
    const name = String(new FormData(event.target).get('name') || '').trim();
    if (!name) { picker.error = 'Give this project a name.'; renderPicker(); return; }
    picker.selectedName = name; const repoPath = picker.inspection.repositoryRoot;
    try {
      const pending = save([{ op: 'project.add', repoPath, name }]); renderPicker();
      if (await pending) { const created = projects().find(project => project.repoPath === repoPath); closePicker(); notify(`${name} is ready for Control Center.`); if (created) openProject(created.id); else render(); }
    } catch (err) { if (picker) { picker.error = message(err); renderPicker(); } }
  }
  async function onClick(event) {
    const target = event.target.closest('[data-pm]'); if (!target || target.disabled || busy) return;
    switch (target.dataset.pm) {
      case 'browse': showPicker(); break;
      case 'refresh': await refresh(); break;
      case 'refresh-runs': await loadRuns(); break;
      case 'open': openProject(target.dataset.id); break;
      case 'back': projectId = null; ++detailSequence; error = ''; render(); break;
      case 'clear-search': query = ''; render(); break;
      case 'inspect-project': showPicker({ inspectPath: current()?.repoPath, detailsOnly: true }); break;
      case 'archive': {
        const project = current();
        try { target.disabled = true; if (await save([{ op: 'project.archive', id: project.id }])) { notify(`${project.name} archived. Files and history retained.`); render(); } }
        catch (err) { error = message(err); target.disabled = false; announce(error); notify(error); }
        break;
      }
    }
  }
  function onInput(event) {
    if (event.target.name !== 'project-search') return;
    query = event.target.value;
    host.querySelector('[data-pm-list]').innerHTML = cards(projects().filter(project => (showArchived || !project.archived) && `${project.name} ${project.repoPath}`.toLowerCase().includes(query.toLowerCase())));
  }
  function onChangeInput(event) { if (event.target.name === 'show-archived') { showArchived = event.target.checked; render(); } }
  async function onSubmit(event) {
    if (!event.target.matches('[data-pm-settings]')) return;
    event.preventDefault(); if (busy) return;
    const form = event.target, data = new FormData(form), output = form.querySelector('[data-pm-form-error]');
    const name = String(data.get('name') || '').trim(), checks = String(data.get('checks') || '').split('\n').map(line => line.trim()).filter(Boolean);
    const checksChanged = checks.join('\n') !== (current()?.checks || []).join('\n');
    const invalid = !name ? 'Give this project a name.' : checksChanged && checks.length > 32 ? 'Use up to 32 verification commands.' : checksChanged && checks.some(value => value.length > 500) ? 'Keep each verification command within 500 characters.' : '';
    if (invalid) { output.textContent = invalid; output.hidden = false; return; }
    try {
      form.querySelector('[type="submit"]').disabled = true;
      if (await save([{ op: 'project.edit', id: projectId, name, ...(checksChanged ? { checks } : {}) }])) { notify('Project settings saved.'); render(); }
    } catch (err) { if (form.isConnected) { output.textContent = message(err); output.hidden = false; form.querySelector('[type="submit"]').disabled = false; } }
  }
  function detach() { if (!host) return; host.removeEventListener('click', onClick); host.removeEventListener('input', onInput); host.removeEventListener('change', onChangeInput); host.removeEventListener('submit', onSubmit); }
  function mount(element) {
    detach(); host = element; destroyed = false;
    host.innerHTML = shell(); host.addEventListener('click', onClick); host.addEventListener('input', onInput); host.addEventListener('change', onChangeInput); host.addEventListener('submit', onSubmit);
    render(); return refresh();
  }
  function destroy() { destroyed = true; ++readSequence; ++detailSequence; detach(); closePicker(); host = null; }
  return { mount, refresh, destroy, showDirectory(){projectId=null;++detailSequence;error='';render();} };
}
