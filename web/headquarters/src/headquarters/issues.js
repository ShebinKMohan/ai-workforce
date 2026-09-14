import { escape as esc, icon } from './ui.js';

export const ISSUE_COLUMNS = [
  { id: 'backlog', label: 'Backlog' }, { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' }, { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
];
const labelFor = status => ISSUE_COLUMNS.find(column => column.id === status)?.label || status;
const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unavailable';
const key = () => `board-${globalThis.crypto.randomUUID()}`;
const readSaved = name => { try { return JSON.parse(localStorage.getItem(name) || 'null'); } catch { return null; } };
const saveLocal = (name, value) => { try { value === null ? localStorage.removeItem(name) : localStorage.setItem(name, JSON.stringify(value)); } catch { /* Local presentation storage is optional. Coordinator records remain authoritative. */ } };

/** Coordinator-backed board data. A stale project read can never replace a newer view or save. */
export class IssueBoardStore {
  constructor(api) { this.api = api; this.projectId = ''; this.issues = []; this.loaded = false; this.error = ''; this.sequence = 0; }
  select(projectId) { if (this.projectId === projectId) return; this.projectId = projectId; this.sequence++; this.issues = []; this.loaded = false; this.error = ''; }
  async load() {
    const sequence = ++this.sequence;
    try {
      const result = await this.api(`/api/issues${this.projectId ? `?projectId=${encodeURIComponent(this.projectId)}` : ''}`);
      if (sequence !== this.sequence) return false;
      this.issues = result.issues || []; this.loaded = true; this.error = ''; return true;
    } catch (error) { if (sequence === this.sequence) this.error = error.message; return false; }
  }
  accept(issue) {
    this.sequence++;
    if (!issue || (this.projectId && issue.projectId !== this.projectId)) return;
    const index = this.issues.findIndex(existing => existing.id === issue.id);
    if (index < 0) this.issues.unshift(issue);
    else if (issue.revision >= this.issues[index].revision) this.issues[index] = issue;
  }
  async create(input) { const result = await this.api('/api/issues', input); this.accept(result.issue); return result; }
  async update(issue, changes) { const result = await this.api(`/api/issues/${encodeURIComponent(issue.id)}/update`, { expectRevision: issue.revision, ...changes }); this.accept(result.issue); return result; }
  async start(issue, allowUnconfinedWrites = false) { const result = await this.api(`/api/issues/${encodeURIComponent(issue.id)}/start`, { expectRevision: issue.revision, ...(allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}) }); this.accept(result.issue); return result; }
}

export function issueEvidenceLabel(issue) {
  if (issue.execution?.analysisReviewed === true && issue.execution?.verified === false && issue.execution?.state === 'completed' && issue.status === 'done') return 'Reviewed analysis';
  if (issue.execution?.verified) return 'Verified candidate';
  const state = issue.execution?.state;
  if (state === 'review' && issue.execution?.workKind === 'analysis') return 'Report review';
  if (!issue.requestId && (!state || state === 'idle')) return issue.status === 'done' ? 'Manually completed' : 'Not sent';
  return ({ dispatching: 'Sending to Control Center', queued: 'Queued', running: 'Working', review: 'In review', completed: 'Completion not verified', blocked: 'Needs attention', interrupted: 'Interrupted', unknown: 'Execution unknown' })[state] || 'Sent to Control Center';
}

export function createIssueBoard({ api, getProjects, notify = () => {}, onRequest = () => {}, onNavigate = () => {} }) {
  const store = new IssueBoardStore(api);
  const saved = readSaved('workforce-issue-board-v1') || {};
  let host = null, timer, loading = false, query = saved.query || '', dialog = null, dialogIssue = null;
  let draft = readSaved('workforce-issue-draft-v1'), editing = false, busy = false, returnFocus = null, boardFingerprint = '', projectFingerprint = '';
  store.select(saved.projectId || '');
  const projects = () => getProjects() || [];
  const projectName = id => projects().find(project => project.id === id)?.name || id;
  const remember = () => saveLocal('workforce-issue-board-v1', { projectId: store.projectId, query });
  const announce = text => { const el = host?.querySelector('[data-issue-announcement]'); if (el) el.textContent = text; };
  const button = (action, text, symbol, attrs = '', primary = false) => `<button type="button" class="issue-button ${primary ? 'issue-primary' : ''}" data-issue-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${text}</button>`;
  const options = (status, { disabled = false } = {}) => ISSUE_COLUMNS.map(column => `<option value="${column.id}" ${status === column.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${column.label}</option>`).join('');

  function render() {
    if (!host) return;
    host.innerHTML = `<section class="issue-workspace" aria-label="Project issues"><header class="issue-page-header"><div><p class="eyebrow">PROJECT WORK</p><h1>Issues</h1><p>Plans become issues. Control Center brings in the right team.</p></div><div class="issue-header-actions">${button('connections', 'Connect an agent', 'connect')}${button('create', 'New issue', 'plus', projects().some(project => !project.archived) ? '' : 'disabled', true)}</div></header><div class="issue-toolbar"><label class="issue-project-filter">${icon('book')}<span class="issue-sr-only">Filter issues by project</span><select data-issue-project aria-label="Filter issues by project"><option value="">All projects</option>${projects().map(project => `<option value="${esc(project.id)}" ${store.projectId === project.id ? 'selected' : ''}>${esc(project.name)}${project.archived ? ' (archived)' : ''}</option>`).join('')}</select></label><label class="issue-search">${icon('search')}<span class="issue-sr-only">Search issues</span><input type="search" data-issue-search placeholder="Search issues…" value="${esc(query)}"></label>${button('refresh', '', 'reset', 'aria-label="Refresh issues" title="Refresh issues"')}<span class="issue-sync" data-issue-sync role="status"></span></div><div data-issue-error></div><div class="issue-board-scroll" tabindex="0" role="region" aria-label="Issue board. Scroll horizontally to see all five columns."><div class="issue-board" data-issue-board></div></div><p class="issue-board-hint">Move a card by dragging it or using its status menu. Sending it to Control Center starts the handoff.</p><p class="issue-sr-only" role="status" aria-live="polite" data-issue-announcement></p></section>`;
    boardFingerprint = ''; renderBoard();
  }
  function filteredIssues() {
    const value = query.trim().toLowerCase();
    return store.issues.filter(issue => !value || [issue.title, issue.description, issue.id, issue.kind, projectName(issue.projectId)].some(part => String(part || '').toLowerCase().includes(value)));
  }
  function card(issue) {
    const sent = Boolean(issue.requestId);
    const evidence = issueEvidenceLabel(issue);
    return `<article class="issue-card" data-issue-id="${esc(issue.id)}" draggable="${!sent && !busy}" aria-label="${esc(issue.title)}"><div class="issue-card-meta"><span class="issue-kind">${esc(issue.kind || 'issue')}</span><span title="${esc(issue.id)}">${esc(issue.id.length > 18 ? issue.id.slice(0, 8) + '…' + issue.id.slice(-4) : issue.id)}</span></div><button type="button" class="issue-card-title" data-issue-action="open" data-id="${esc(issue.id)}">${esc(issue.title)}</button>${issue.description ? `<p class="issue-card-description">${esc(issue.description)}</p>` : ''}<span class="issue-card-project">${icon('book')}${esc(projectName(issue.projectId))}</span><div class="issue-card-evidence ${issue.execution?.verified ? 'is-verified' : ''}">${icon(issue.execution?.verified ? 'circleCheck' : sent ? 'connect' : 'clock')}<span>${esc(evidence)}</span></div>${issue.execution?.reason ? `<p class="issue-card-reason">${esc(issue.execution.reason)}</p>` : ''}<footer class="issue-card-footer"><select data-issue-move="${esc(issue.id)}" aria-label="Move ${esc(issue.title)} to status" ${sent || busy ? 'disabled' : ''} title="${sent ? 'Status follows the linked execution' : 'Move without starting work'}">${options(issue.status)}</select>${button(sent ? 'request' : 'start', sent ? 'Open task' : 'Send', sent ? 'northeast' : 'arrow', `data-id="${esc(issue.id)}" ${busy || (!sent && projects().find(p => p.id === issue.projectId)?.archived) ? 'disabled' : ''} aria-label="${sent ? 'Open task for' : 'Send to Control Center:'} ${esc(issue.title)}"`)}</footer></article>`;
  }
  function renderBoard() {
    if (!host) return;
    const nextProjects = JSON.stringify(projects().map(project => [project.id, project.name, project.archived]));
    if (nextProjects !== projectFingerprint) {
      projectFingerprint = nextProjects;
      if (store.projectId && !projects().some(project => project.id === store.projectId)) { store.select(''); remember(); }
      const select = host.querySelector('[data-issue-project]');
      select.innerHTML = `<option value="">All projects</option>${projects().map(project => `<option value="${esc(project.id)}" ${store.projectId === project.id ? 'selected' : ''}>${esc(project.name)}${project.archived ? ' (archived)' : ''}</option>`).join('')}`;
      const create = host.querySelector('.issue-header-actions [data-issue-action="create"]');
      if (create) create.disabled = !projects().some(project => !project.archived);
    }
    const error = host.querySelector('[data-issue-error]');
    error.innerHTML = store.error ? `<div class="issue-error" role="alert"><span>${esc(store.error)}${store.loaded ? ' Showing the last saved snapshot.' : ''}</span>${button('refresh', 'Retry', 'reset')}</div>` : '';
    if (!projects().length && store.loaded) error.innerHTML += `<div class="issue-setup">${icon('book')}<div><strong>Add your first project</strong><p>Choose a project folder before creating issues or sending plans from your coding agent.</p></div>${button('projects', 'Add project', 'plus', '', true)}</div>`;
    const sync = host.querySelector('[data-issue-sync]');
    sync.textContent = loading ? 'Refreshing…' : store.error ? 'Updates unavailable' : store.loaded ? `${store.issues.length} saved ${store.issues.length === 1 ? 'issue' : 'issues'}` : 'Loading…';
    const list = filteredIssues();
    const fingerprint = JSON.stringify([list, store.loaded, store.projectId, query, busy, projects().map(p => [p.id, p.name, p.archived])]);
    if (boardFingerprint === fingerprint) return;
    boardFingerprint = fingerprint;
    const board = host.querySelector('[data-issue-board]');
    const active = document.activeElement;
    const focusMove = board.contains(active) ? active.dataset?.issueMove : null;
    const focusAction = board.contains(active) ? active.dataset?.issueAction : null;
    const focusId = board.contains(active) ? active.dataset?.id : null;
    board.innerHTML = ISSUE_COLUMNS.map(column => {
      const items = list.filter(issue => issue.status === column.id);
      return `<section class="issue-column" data-issue-column="${column.id}" aria-labelledby="issue-column-${column.id}"><header><span class="issue-column-dot issue-dot-${column.id}" aria-hidden="true"></span><h2 id="issue-column-${column.id}">${column.label}</h2><span class="issue-column-count">${items.length}</span>${!store.projectId || !projects().find(p => p.id === store.projectId)?.archived ? button('create', '', 'plus', `data-status="${column.id}" aria-label="Add issue to ${column.label}" ${projects().some(p => !p.archived) ? '' : 'disabled'}`) : ''}</header><div class="issue-column-cards">${items.length ? items.map(card).join('') : `<div class="issue-column-empty">${!store.loaded ? store.error ? 'Issues unavailable' : 'Loading saved issues…' : query ? 'No matches here' : 'No issues yet'}</div>`}</div></section>`;
    }).join('');
    if (focusMove) [...board.querySelectorAll('[data-issue-move]')].find(el => el.dataset.issueMove === focusMove)?.focus();
    else if (focusAction && focusId) [...board.querySelectorAll('[data-issue-action]')].find(el => el.dataset.issueAction === focusAction && el.dataset.id === focusId)?.focus();
  }
  async function refresh() {
    if (!host || loading || busy) return;
    loading = true; renderBoard();
    await store.load(); loading = false; renderBoard();
    if (dialog && dialogIssue && !editing) { const fresh = store.issues.find(issue => issue.id === dialogIssue.id); if (fresh && JSON.stringify(fresh) !== JSON.stringify(dialogIssue)) { dialogIssue = fresh; renderDialog(); } }
  }
  function closeDialog() {
    if (busy) return;
    const old = dialog; dialog = null; dialogIssue = null; editing = false;
    if (old) { old.close(); old.remove(); }
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function openDialog(issue = null, status = 'backlog') {
    if (dialog) closeDialog();
    returnFocus = document.activeElement; dialogIssue = issue; editing = !issue;
    if (!issue) draft = readSaved('workforce-issue-draft-v1') || { title: '', description: '', kind: 'issue', projectId: store.projectId || projects().find(project => !project.archived)?.id || '', status, idempotencyKey: key() };
    dialog = document.createElement('dialog'); dialog.className = 'issue-dialog'; dialog.setAttribute('aria-labelledby', 'issue-dialog-title');
    dialog.addEventListener('click', handleClick); dialog.addEventListener('input', handleDraft); dialog.addEventListener('change', handleDraft); dialog.addEventListener('submit', handleSubmit);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    document.body.append(dialog); renderDialog(); dialog.showModal();
  }
  function renderDialog() {
    if (!dialog) return;
    const issue = dialogIssue, values = editing ? draft : issue;
    dialog.innerHTML = `<header class="issue-dialog-header"><div><p class="eyebrow">${issue ? esc(projectName(issue.projectId)) : 'NEW PROJECT WORK'}</p><h2 id="issue-dialog-title">${editing ? issue ? 'Edit issue' : 'Create issue' : esc(issue.title)}</h2></div>${button('close', '', 'close', `aria-label="Close issue" ${busy ? 'disabled' : ''}`)}</header>${editing ? `<form data-issue-form><div class="issue-form-fields"><div class="issue-form-row"><label>Project<select name="projectId" required ${issue ? 'disabled' : ''}>${projects().filter(project => !project.archived || project.id === values.projectId).map(project => `<option value="${esc(project.id)}" ${project.id === values.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select></label><label>Type<select name="kind" ${issue ? 'disabled' : ''}>${['issue', 'plan', 'prd'].map(kind => `<option value="${kind}" ${values.kind === kind ? 'selected' : ''}>${kind === 'prd' ? 'PRD' : kind === 'plan' ? 'Plan' : 'Issue'}</option>`).join('')}</select></label><label>Status<select name="status">${options(values.status)}</select></label></div><label>Title<input name="title" value="${esc(values.title)}" maxlength="300" required placeholder="What should your team work on?"></label><label>Description<textarea name="description" rows="12" placeholder="Add your issue, implementation plan, or full PRD. Include the outcome, requirements, and acceptance criteria.">${esc(values.description)}</textarea></label><p class="issue-help">Saving keeps this on the board. Use Send to Control Center when you are ready for the team to start.</p><p class="issue-error" data-issue-form-error role="alert" hidden></p></div><footer class="issue-dialog-footer">${button('close', 'Cancel', null)}<button type="submit" class="issue-button issue-primary">${icon('check')}Save issue</button></footer></form>` : `<div class="issue-detail-body"><div class="issue-detail-tags"><span class="issue-kind">${esc(issue.kind)}</span><span>${esc(labelFor(issue.status))}</span><span class="${issue.execution?.verified ? 'issue-verified' : ''}">${esc(issueEvidenceLabel(issue))}</span></div><div class="issue-description-full">${esc(issue.description || 'No description added.')}</div>${issue.execution?.reason ? `<p class="issue-detail-reason">${esc(issue.execution.reason)}</p>` : ''}<dl class="issue-detail-facts"><div><dt>Source</dt><dd>${esc(issue.source || 'Workspace')}</dd></div><div><dt>Updated</dt><dd>${esc(date(issue.updatedAt))}</dd></div><div><dt>Issue ID</dt><dd>${esc(issue.id)}</dd></div></dl>${!issue.requestId ? `<p class="issue-help">Control Center receives the full description, chooses a department, and delegates through its head. Execution status then updates this board.</p><details class="issue-access"><summary>Runtime access options</summary><label><input type="checkbox" data-issue-consent>Allow this request to use a runtime whose file-write boundary is unverified.</label><p>Only enable when you intend to grant that runtime access for this request.</p></details>` : '<p class="issue-help">This issue follows its recorded execution. Open the linked task to review checks, outputs, and any required action.</p>'}<p class="issue-error" data-issue-form-error role="alert" hidden></p></div><footer class="issue-dialog-footer">${issue.requestId ? '' : button('edit', 'Edit issue', 'pen')}${button(issue.requestId ? 'request' : 'dispatch', issue.requestId ? 'Open linked task' : 'Send to Control Center', issue.requestId ? 'northeast' : 'arrow', `data-id="${esc(issue.id)}" ${busy || (!issue.requestId && projects().find(p => p.id === issue.projectId)?.archived) ? 'disabled' : ''}`, true)}</footer>`}`;
  }
  function handleDraft(event) {
    if (!editing || !event.target.name) return;
    draft[event.target.name] = event.target.value;
    if (!dialogIssue) { draft.idempotencyKey = key(); saveLocal('workforce-issue-draft-v1', draft); }
  }
  function showDialogError(error) {
    const output = dialog?.querySelector('[data-issue-form-error]');
    if (output) { output.hidden = false; output.textContent = `${error.message}${error.status === 409 ? ' Your draft is retained. Reopen the issue to review the latest saved revision before retrying.' : ''}`; }
    else notify(error.message);
  }
  function setBusy(value) {
    busy = value;
    dialog?.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = value || (el.tagName === 'SELECT' && Boolean(dialogIssue) && ['projectId', 'kind'].includes(el.name)); });
    renderBoard();
  }
  async function handleSubmit(event) {
    event.preventDefault(); if (busy || !draft) return;
    const form = event.target; if (!form.matches('[data-issue-form]') || !form.reportValidity()) return;
    if (!draft.title.trim()) { showDialogError(new Error('Give this issue a title.')); return; }
    if (draft.description.length > 64000) { showDialogError(new Error('The description exceeds 64,000 characters. Your complete draft is retained; shorten the brief before saving.')); return; }
    setBusy(true);
    try {
      const result = dialogIssue ? await store.update(dialogIssue, { title: draft.title, description: draft.description, status: draft.status }) : await store.create({ ...draft, source: 'workspace', start: false });
      if (!dialogIssue) { draft = null; saveLocal('workforce-issue-draft-v1', null); }
      dialogIssue = result.issue; editing = false; busy = false; renderDialog(); renderBoard(); notify('Issue saved.');
    } catch (error) { showDialogError(error); }
    finally { setBusy(false); }
  }
  async function move(id, status) {
    const issue = store.issues.find(item => item.id === id);
    if (!issue || issue.requestId || busy || issue.status === status || !ISSUE_COLUMNS.some(column => column.id === status)) return;
    setBusy(true);
    try { await store.update(issue, { status }); announce(`${issue.title} moved to ${labelFor(status)}.`); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); void refresh(); }
  }
  async function handleClick(event) {
    const target = event.target.closest('[data-issue-action]'); if (!target || target.disabled) return;
    const action = target.dataset.issueAction;
    const issue = store.issues.find(item => item.id === target.dataset.id) || dialogIssue;
    if (action === 'create') { openDialog(null, target.dataset.status || 'backlog'); return; }
    if (action === 'open' || action === 'start') { if (issue) openDialog(issue); return; }
    if (action === 'close') { closeDialog(); return; }
    if (action === 'edit') { draft = { ...dialogIssue }; editing = true; renderDialog(); return; }
    if (action === 'refresh') { void refresh(); return; }
    if (action === 'projects' || action === 'connections') { onNavigate(action); return; }
    if (action === 'request') { if (issue?.requestId) { closeDialog(); onRequest(issue.requestId); } return; }
    if (action === 'dispatch' && issue && !busy) {
      const consent = Boolean(dialog?.querySelector('[data-issue-consent]')?.checked); setBusy(true);
      try { const result = await store.start(issue, consent); dialogIssue = result.issue; editing = false; busy = false; renderDialog(); notify('Sent to Control Center.'); renderBoard(); }
      catch (error) { showDialogError(error); }
      finally { setBusy(false); void refresh(); }
    }
  }
  function handleChange(event) {
    if (event.target.matches('[data-issue-project]')) { store.select(event.target.value); remember(); renderBoard(); loading = false; void refresh(); }
    if (event.target.dataset.issueMove) void move(event.target.dataset.issueMove, event.target.value);
  }
  function handleInput(event) { if (event.target.matches('[data-issue-search]')) { query = event.target.value; remember(); renderBoard(); } }
  function dragStart(event) {
    const card = event.target.closest('[data-issue-id]');
    if (!card || card.draggable !== true || event.target.closest('button,select,input,textarea')) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-workforce-issue', card.dataset.issueId); event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(event) { const column = event.target.closest('[data-issue-column]'); if (column && [...event.dataTransfer.types].includes('application/x-workforce-issue')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }
  function drop(event) { const column = event.target.closest('[data-issue-column]'); if (!column) return; const id = event.dataTransfer.getData('application/x-workforce-issue'); if (id) { event.preventDefault(); void move(id, column.dataset.issueColumn); } }
  function unmount() {
    clearInterval(timer); store.sequence++;
    if (host) { host.removeEventListener('click', handleClick); host.removeEventListener('change', handleChange); host.removeEventListener('input', handleInput); host.removeEventListener('dragstart', dragStart); host.removeEventListener('dragover', dragOver); host.removeEventListener('drop', drop); }
    closeDialog(); host = null; loading = false;
  }
  return {
    mount(element) {
      unmount(); host = element;
      if (store.projectId && !projects().some(project => project.id === store.projectId)) store.select('');
      render(); host.addEventListener('click', handleClick); host.addEventListener('change', handleChange); host.addEventListener('input', handleInput); host.addEventListener('dragstart', dragStart); host.addEventListener('dragover', dragOver); host.addEventListener('drop', drop);
      void refresh(); timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 4000);
    },
    refresh, unmount,
  };
}
