import { escape as esc, icon, avatar } from './ui.js';
import { renderDuration } from './time-display.js';

export const ISSUE_COLUMNS = [
  { id: 'backlog', label: 'Backlog' }, { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' }, { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' }, { id: 'cancelled', label: 'Canceled' },
];
export const ISSUE_PRIORITIES = [
  { id: 'none', label: 'No priority', rank: 0 }, { id: 'urgent', label: 'Urgent', rank: 4 },
  { id: 'high', label: 'High', rank: 3 }, { id: 'medium', label: 'Medium', rank: 2 }, { id: 'low', label: 'Low', rank: 1 },
];
const labelFor = status => ISSUE_COLUMNS.find(column => column.id === status)?.label || status;
const priorityFor = value => ISSUE_PRIORITIES.find(priority => priority.id === value) || ISSUE_PRIORITIES[0];
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded';
const key = () => `board-${globalThis.crypto.randomUUID()}`;
export const shortIssueId = issue => `#${String(issue.id).slice(-8)}`;
const readSaved = name => { try { return JSON.parse(localStorage.getItem(name) || 'null'); } catch { return null; } };
const saveLocal = (name, value) => { try { value === null ? localStorage.removeItem(name) : localStorage.setItem(name, JSON.stringify(value)); } catch { /* Local presentation storage is optional; coordinator records remain authoritative. */ } };
const LIVE = new Set(['dispatching', 'queued', 'running', 'review']);
const execution = issue => issue?.execution || {};
const completedAt = issue => execution(issue).state === 'cancelled' || issue.status === 'cancelled' ? null : execution(issue).completedAt || (!issue.requestId && issue.status === 'done' ? issue.completedAt : null);
const ownersOf = issue => execution(issue).owners || [];
const manual = issue => !issue.requestId && !LIVE.has(execution(issue).state) && !['unknown', 'completed'].includes(execution(issue).state);
const archivedProject = (issue, projects) => projects.find(project => project.id === issue.projectId)?.archived === true;

/** Coordinator-backed data. Newer project reads and committed writes invalidate older snapshots. */
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
  async update(issue, changes) {
    try { const result = await this.api(`/api/issues/${encodeURIComponent(issue.id)}/update`, { expectRevision: issue.revision, ...changes }); this.accept(result.issue); return result; }
    catch (error) { if (error.data?.issue) this.accept(error.data.issue); throw error; }
  }
  async start(issue, allowUnconfinedWrites = false) {
    try { const result = await this.api(`/api/issues/${encodeURIComponent(issue.id)}/start`, { expectRevision: issue.revision, ...(allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}) }); this.accept(result.issue); return result; }
    catch (error) { if (error.data?.issue) this.accept(error.data.issue); throw error; }
  }
}

/** Editor drafts have their own saved base revision; polling never rebases unsaved requirements. */
export class IssueDraftStore {
  constructor({ read = readSaved, write = saveLocal, makeKey = key } = {}) { this.read = read; this.write = write; this.makeKey = makeKey; }
  storageKey(issue) { return issue ? `workforce-issue-edit-v2:${issue.id}` : 'workforce-issue-draft-v1'; }
  open(issue, defaults = {}) {
    const saved = this.read(this.storageKey(issue));
    if (saved && typeof saved.title === 'string' && typeof saved.description === 'string' && typeof saved.idempotencyKey === 'string') return saved;
    const draft = issue ? { title: issue.title, description: issue.description, projectId: issue.projectId, status: issue.status, priority: issue.priority || 'none', kind: issue.kind, expectRevision: issue.revision, issueId: issue.id, idempotencyKey: this.makeKey() } : { title: '', description: '', kind: 'issue', status: 'backlog', priority: 'none', ...defaults, idempotencyKey: this.makeKey() };
    this.write(this.storageKey(issue), draft); return draft;
  }
  change(issue, draft, field, value) {
    if (!['title', 'description', 'projectId', 'status', 'priority', 'kind'].includes(field) || draft[field] === value) return draft;
    const next = { ...draft, [field]: value, idempotencyKey: this.makeKey() }; this.write(this.storageKey(issue), next); return next;
  }
  clearSaved(issue, submittedKey) { const saved = this.read(this.storageKey(issue)); if (saved?.idempotencyKey === submittedKey) this.write(this.storageKey(issue), null); }
  reset(issue) { this.write(this.storageKey(issue), null); }
}

const detailLink = issue => JSON.stringify([issue?.id, issue?.projectId, issue?.requestId, issue?.runId]);
const detailSnapshot = issue => JSON.stringify([detailLink(issue), issue?.revision, execution(issue).state, execution(issue).updatedAt, execution(issue).endedAt]);
const HANDOFF_EVENTS = new Set(['head.planning_started', 'head.planning_finished', 'head.assigned', 'task.accepted', 'run.accepted', 'task.settled', 'integration.combined', 'head.review_started', 'head.review_finished', 'control.final_reply']);
export class IssueDetailStore {
  constructor(api) { this.api = api; this.id = null; this.link = null; this.sequence = 0; this.request = null; this.status = null; this.events = []; this.eventCursor = 0; this.eventsRunId = null; this.hasMore = false; this.snapshot = null; this.error = ''; this.loading = false; }
  select(issue) {
    const link = detailLink(issue); if (this.link === link) return;
    this.sequence++; this.id = issue?.id || null; this.link = link; this.request = null; this.status = null; this.events = []; this.eventCursor = 0; this.eventsRunId = null; this.hasMore = false; this.snapshot = null; this.error = ''; this.loading = false;
  }
  needsRefresh(issue) { return this.snapshot !== detailSnapshot(issue) || this.hasMore; }
  async load(issue) {
    this.select(issue); const sequence = ++this.sequence; this.loading = true; this.error = '';
    let request = this.request, status = this.status, events = [...this.events], cursor = this.eventCursor, hasMore = this.hasMore; const errors = [];
    if (issue.requestId) {
      try { const result = await this.api(`/api/requests/${encodeURIComponent(issue.requestId)}`); const item = result.request || result.task; if (item?.projectId !== issue.projectId || item?.id !== issue.requestId) throw new Error('The linked request does not match this issue.'); request = item; }
      catch (error) { errors.push(error.message); }
    }
    const runId = issue.runId || request?.runId;
    if (runId) {
      if (runId !== this.eventsRunId) { status = null; events = []; cursor = 0; hasMore = false; }
      const base = `/api/projects/${encodeURIComponent(issue.projectId)}/runs/${encodeURIComponent(runId)}`;
      try { const result = await this.api(base); if (result.run?.id && result.run.id !== runId) throw new Error('The linked run does not match this issue.'); status = result; }
      catch (error) { errors.push(error.message); }
      try {
        // Read only the unseen tail. Each refresh is bounded; large histories continue at the saved cursor.
        for (let page = 0; page < 4 && (hasMore || !status || !Number.isFinite(status.eventCount) || cursor < status.eventCount); page++) {
          if (sequence !== this.sequence) return false;
          const result = await this.api(`${base}/events?after=${cursor}&limit=500`);
          if (result.runId && result.runId !== runId) throw new Error('Activity belongs to a different run.');
          const rows = result.events || [];
          let next = cursor;
          for (const event of rows) {
            if (!Number.isSafeInteger(event.sequence) || event.sequence <= next) throw new Error('Activity pagination did not advance in order.');
            next = event.sequence;
          }
          hasMore = result.hasMore === true;
          if (hasMore && next === cursor) throw new Error('More activity is recorded, but its next page is unavailable.');
          events.push(...rows.filter(event => HANDOFF_EVENTS.has(event.type))); cursor = next;
          if (!hasMore) break;
        }
      } catch (error) { errors.push(error.message); }
    }
    if (sequence !== this.sequence || this.link !== detailLink(issue)) return false;
    this.request = request; this.status = status; this.events = events; this.eventCursor = cursor; this.eventsRunId = runId || null; this.hasMore = hasMore; this.snapshot = errors.length ? null : detailSnapshot(issue); this.error = errors.join(' '); this.loading = false; return true;
  }
}

/** Read the reviewed form at submission time, including select changes without an input event. */
export function captureIssueDraft(drafts, original, draft, form) {
  for (const field of ['projectId', 'kind', 'title', 'description', 'status', 'priority']) {
    if (original && ['projectId', 'kind'].includes(field)) continue;
    const control = form?.elements?.namedItem(field);
    if (control && typeof control.value === 'string') draft = drafts.change(original, draft, field, control.value);
  }
  return draft;
}

/** Named, recorded workflow milestones; a missing phase boundary never becomes an estimated duration. */
export function issueHandoffs(issue, request, status, events = []) {
  const rows = [], people = new Map(ownersOf(issue).map(person => [person.id, person.name || person.id]));
  const name = (id, fallback) => people.get(id) || id || fallback;
  const tasks = status?.taskViews || [], ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  if (request?.route?.departmentId) rows.push({ id: 'route', label: `Control Center → ${execution(issue).department?.name || request.route.departmentId}`, context: `${name(request.route.headAgentId, 'Department head')} received the brief`, timestamp: request.route.decidedAt });
  for (const event of ordered) {
    const payload = event.payload || {}, task = tasks.find(task => task.id === event.taskId);
    if (event.type === 'head.planning_started' || event.type === 'head.review_started') {
      const planning = event.type === 'head.planning_started', endType = planning ? 'head.planning_finished' : 'head.review_finished';
      const nextStart = ordered.find(candidate => candidate.sequence > event.sequence && candidate.type === event.type && candidate.payload?.headAgentId === payload.headAgentId);
      const finish = ordered.find(candidate => candidate.sequence > event.sequence && (!nextStart || candidate.sequence < nextStart.sequence) && candidate.type === endType && (!payload.reviewId || candidate.payload?.reviewId === payload.reviewId) && (!payload.headAgentId || candidate.payload?.headAgentId === payload.headAgentId));
      const label = `${name(payload.headAgentId, 'Department head')} · ${planning ? 'Planning' : 'Candidate review'}`;
      const context = finish ? planning ? Number.isFinite(finish.payload?.taskCount) && finish.payload?.outcome === 'planned' ? `${finish.payload.taskCount} task${finish.payload.taskCount === 1 ? '' : 's'} prepared` : `Planning ${String(finish.payload?.outcome || 'finished').replaceAll('_', ' ')}` : `Review ${String(finish.payload?.verdict || 'finished').replaceAll('_', ' ')}` : 'Finish time not yet recorded';
      rows.push({ id: `event-${event.sequence}`, label, context, timestamp: event.timestamp, start: event.timestamp, end: finish?.timestamp || null, active: !finish && LIVE.has(execution(issue).state) });
    } else if (event.type === 'head.assigned') {
      rows.push({ id: `event-${event.sequence}`, label: `${name(payload.headAgentId, 'Department head')} → ${name(payload.agentId, 'Worker')}`, context: payload.objective || task?.objective || 'Task assigned', timestamp: event.timestamp });
    } else if (event.type === 'run.accepted' || event.type === 'task.accepted') {
      const current = !event.attemptId || task?.attempt?.id === event.attemptId;
      const passed = current && payload.accepted !== false ? task?.receipts?.verifierExecutedPassed || 0 : 0;
      rows.push({ id: `event-${event.sequence}`, label: passed > 0 ? 'Independent checks passed' : 'Coordinator recorded task acceptance', context: passed > 0 ? `${passed} passing verifier receipt${passed === 1 ? '' : 's'} for ${name(task?.ownerAgentId, 'the assigned worker')}` : 'Open Checks for the current evidence.', timestamp: event.timestamp });
    } else if (event.type === 'integration.combined') rows.push({ id: `event-${event.sequence}`, label: 'Candidate changes combined', context: payload.accepted === true ? 'Candidate prepared for department review' : 'Combination needs attention', timestamp: event.timestamp });
    else if (event.type === 'control.final_reply') rows.push({ id: `event-${event.sequence}`, label: 'Control Center returned the result', context: payload.verificationStatus === 'verified' ? 'Result recorded as verified after department review' : 'The recorded result is available above.', timestamp: event.timestamp });
  }
  for (const task of tasks) {
    if (!task.attempt?.startedAt) continue;
    rows.push({ id: `worker-${task.attempt.id}`, label: `${name(task.ownerAgentId, 'Worker')} · ${status?.workKind === 'analysis' || execution(issue).workKind === 'analysis' ? 'Analysis' : 'Implementation'}`, context: `${String(task.state || '').replaceAll('_', ' ')} · ${task.objective || 'Assigned task'}`, timestamp: task.attempt.startedAt, start: task.attempt.startedAt, end: task.attempt.endedAt || null, active: !task.attempt.endedAt && ['running', 'validating'].includes(task.state) });
  }
  return rows.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
}

export function issueEvidenceLabel(issue) {
  if (execution(issue).analysisReviewed === true && execution(issue).verified === false && execution(issue).state === 'completed' && issue.status === 'done') return 'Reviewed analysis';
  if (execution(issue).verified) return 'Verified candidate';
  const state = execution(issue).state;
  if (state === 'review' && execution(issue).workKind === 'analysis') return 'Report review';
  if (!issue.requestId && (!state || state === 'idle')) return issue.status === 'cancelled' ? 'Canceled' : issue.status === 'done' ? 'Manually completed' : 'Not sent';
  return ({ dispatching: 'Sending to Control Center', queued: 'Queued', running: 'Working', review: 'In review', completed: 'Completion not verified', blocked: 'Needs attention', interrupted: 'Interrupted', answered: 'Answer delivered', cancelled: 'Canceled', unknown: 'Execution unknown' })[state] || 'Sent to Control Center';
}

/** Default result copy follows coordinator receipts, never free-form review claims. */
export function issueResultSummary(issue) {
  const work = execution(issue);
  if (work.state === 'cancelled' || issue.status === 'cancelled') return 'This issue was canceled.';
  if (work.state === 'answered') return 'Control Center delivered an answer. No implementation run was started.';
  if (work.analysisReviewed === true && work.state === 'completed' && issue.status === 'done') return 'The analysis report is ready. Department review completed.';
  if (work.verified === true) {
    const counts = work.checks;
    const checks = counts && Number.isSafeInteger(counts.passed) && Number.isSafeInteger(counts.total) && counts.total > 0 ? `${counts.passed} of ${counts.total} independent checks passed` : 'Independent checks passed';
    return `${checks}. Department review completed. Proposed changes are ready to inspect.`;
  }
  if (!issue.requestId && issue.status === 'done') return 'Marked done manually. No execution has been verified.';
  if (work.state === 'completed') return 'This task ended without verified completion. Review the recorded details below.';
  return '';
}

/** Match chat's deliverable policy; internal JSON and review receipts stay in technical files. */
export function issueArtifactGroups(artifacts = []) {
  const deliverables = artifacts.filter(item => ['analysis_report', 'candidate_patch', 'summary'].includes(item.type) && !(item.type === 'summary' && /\.json$/i.test(item.path || item.relativePath || '')));
  const technical = artifacts.filter(item => !deliverables.includes(item));
  return { deliverables, technical };
}

export function filterIssueRows(issues, { query = '', owner = '', priority = '', sort = 'updated' } = {}, projects = []) {
  const value = query.trim().toLowerCase();
  const result = issues.filter(issue => {
    if (owner === 'unassigned' ? ownersOf(issue).length : owner && !ownersOf(issue).some(person => person.id === owner)) return false;
    if (priority && (issue.priority || 'none') !== priority) return false;
    return !value || [issue.title, issue.description, issue.id, shortIssueId(issue), issue.kind, projects.find(project => project.id === issue.projectId)?.name, execution(issue).department?.name, ...ownersOf(issue).map(person => person.name)].some(part => String(part || '').toLowerCase().includes(value));
  });
  return result.sort((left, right) => {
    if (sort === 'priority') { const rank = priorityFor(right.priority).rank - priorityFor(left.priority).rank; if (rank) return rank; }
    const field = sort === 'created' ? 'createdAt' : 'updatedAt';
    const a = Date.parse(field === 'updatedAt' ? execution(left).updatedAt || left[field] : left[field]) || 0;
    const b = Date.parse(field === 'updatedAt' ? execution(right).updatedAt || right[field] : right[field]) || 0;
    return b - a || String(left.id).localeCompare(String(right.id));
  });
}

const button = (action, text, symbol, attrs = '', primary = false) => `<button type="button" class="issue-button${primary ? ' issue-primary' : ''}" data-issue-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${text ? `<span>${text}</span>` : ''}</button>`;
const options = status => ISSUE_COLUMNS.map(column => `<option value="${column.id}" ${status === column.id ? 'selected' : ''}>${column.label}</option>`).join('');
const priorityOptions = priority => ISSUE_PRIORITIES.map(item => `<option value="${item.id}" ${priority === item.id ? 'selected' : ''}>${item.label}</option>`).join('');
const priorityIcon = priority => `<svg class="issue-priority-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13V9M7 13V6M11 13V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="${priority === 'none' ? '.35' : '1'}"/></svg>`;
const durationLabel = issue => execution(issue).state === 'answered' ? 'Reply' : execution(issue).state === 'cancelled' || issue.status === 'cancelled' ? 'Elapsed' : 'Execution';
const duration = (issue, label = 'Execution time') => renderDuration({ start: execution(issue).startedAt, end: execution(issue).endedAt, active: LIVE.has(execution(issue).state), label, className: 'issue-elapsed-value' });
const ownerFaces = (owners, { detail = false } = {}) => {
  if (!owners.length) return `${icon('people')}<span>Unassigned</span>`;
  const name = person => person.name || person.id;
  if (detail) return owners.map(person => `<span class="issue-owner-person">${avatar(name(person), 22)}<span class="issue-owner-details"><span>${esc(name(person))}</span>${person.role ? `<span class="issue-owner-role">${esc(String(person.role).replaceAll('_', ' '))}</span>` : ''}</span></span>`).join('');
  const names = owners.map(name).join(', ');
  return `<span class="issue-owner-avatars">${owners.slice(0, 3).map(person => `<span title="${esc(name(person))}">${avatar(name(person), 22)}</span>`).join('')}</span><span class="issue-owner-names" title="${esc(names)}">${esc(names)}</span>`;
};

export function createIssueBoard({ api, getProjects, notify = () => {}, onRequest = () => {}, onNavigate = () => {}, workspaceEvents = globalThis.window }) {
  const store = new IssueBoardStore(api), details = new IssueDetailStore(api), drafts = new IssueDraftStore();
  const saved = readSaved('workforce-issue-board-v1') || {};
  const filters = { query: typeof saved.query === 'string' ? saved.query : '', owner: saved.owner || '', priority: saved.priority || '', sort: saved.sort || 'updated', hideEmpty: Boolean(saved.hideEmpty) };
  let host = null, timer, resizeObserver = null, observedScroller = null, mounted = 0, refreshSequence = 0, refreshing = false, busy = false;
  let selectedId = null, selectedIssue = null, dialog = null, dialogIssue = null, draft = null, returnFocus = null;
  let boardFingerprint = '', toolbarFingerprint = '', inspectorFingerprint = '', inspectorError = '', consent = false;
  let artifactPreview = null, artifactSequence = 0;
  store.select(saved.projectId || '');
  const projects = () => getProjects() || [];
  const projectName = id => projects().find(project => project.id === id)?.name || id;
  const remember = () => saveLocal('workforce-issue-board-v1', { projectId: store.projectId, ...filters });
  const selected = () => store.issues.find(issue => issue.id === selectedId) || selectedIssue;
  const announce = text => { const output = host?.querySelector('[data-issue-announcement]'); if (output) output.textContent = text; };

  function render() {
    if (!host) return;
    const scrollLeft = observedScroller?.scrollLeft || 0;
    unbindColumnNavigation();
    host.innerHTML = `<section class="issue-workspace" aria-label="Project issues"><h1 class="issue-sr-only">Issues</h1><div class="issue-toolbar"><label class="issue-project-filter">${icon('book')}<select data-issue-project aria-label="Filter issues by project"></select></label><label class="issue-search">${icon('search')}<input type="search" data-issue-search aria-label="Search issues" placeholder="Search issues…" value="${esc(filters.query)}"></label><label class="issue-filter-select">${icon('people')}<select data-issue-owner aria-label="Filter issues by assignee"></select></label><label class="issue-filter-select">${priorityIcon('medium')}<select data-issue-priority aria-label="Filter issues by priority"><option value="">All priorities</option>${priorityOptions(filters.priority)}</select></label><div class="issue-toolbar-end"><label class="issue-sort"><span>Sort</span><select data-issue-sort aria-label="Sort issues">${[['updated', 'Last updated'], ['created', 'Newest first'], ['priority', 'Priority']].map(([value, label]) => `<option value="${value}" ${filters.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="issue-hide-empty"><input type="checkbox" data-issue-hide-empty ${filters.hideEmpty ? 'checked' : ''}>Hide empty</label><span class="issue-column-navigation" data-issue-scroll-controls hidden>${button('scroll-left', '', 'back', 'aria-label="Previous columns" title="Previous columns"')}${button('scroll-right', '', 'arrow', 'aria-label="Next columns" title="Next columns"')}</span>${button('refresh', '', 'reset', 'aria-label="Refresh issues" title="Refresh issues"')}</div></div><div data-issue-error></div><div class="issue-work-area"><div class="issue-board-scroll" tabindex="0" role="region" aria-label="Issue board. Use the arrow keys to scroll through its columns."><div class="issue-board" data-issue-board></div></div><aside class="issue-inspector" id="issue-inspector" data-issue-inspector aria-label="Issue details" hidden></aside></div><footer class="issue-board-footer"><span data-issue-sync role="status"></span><span>Drag to move · Status menus support keyboard</span></footer><p class="issue-sr-only" role="status" aria-live="polite" data-issue-announcement></p></section>`;
    toolbarFingerprint = ''; boardFingerprint = ''; inspectorFingerprint = ''; renderBoard(); renderInspector();
    host.querySelector('.issue-board-scroll').scrollLeft = scrollLeft; bindColumnNavigation();
  }
  function card(issue) {
    return `<button type="button" class="issue-card issue-card--minimal${selectedId === issue.id ? ' is-selected' : ''}" data-issue-id="${esc(issue.id)}" data-issue-action="open" data-id="${esc(issue.id)}" draggable="${manual(issue) && !busy}" aria-label="${esc(issue.title)} — open issue details" aria-controls="issue-inspector" aria-expanded="${selectedId === issue.id}"><span class="issue-card-title">${esc(issue.title)}</span><span class="issue-card-project">${icon('book')}<span title="${esc(projectName(issue.projectId))}">${esc(projectName(issue.projectId))}</span></span><span class="issue-card-timing">${icon('clock')}${duration(issue, durationLabel(issue))}</span><span class="issue-card-owner">${ownerFaces(ownersOf(issue))}</span></button>`;
  }
  function renderToolbar() {
    if (!host) return;
    const people = [...new Map(store.issues.flatMap(ownersOf).map(person => [person.id, person])).values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    const fingerprint = JSON.stringify([projects().map(project => [project.id, project.name, project.archived]), people, store.projectId, filters.owner]);
    if (fingerprint === toolbarFingerprint) return;
    toolbarFingerprint = fingerprint;
    const select = host.querySelector('[data-issue-project]');
    select.innerHTML = `<option value="">All projects</option>${store.projectId && !projects().some(project => project.id === store.projectId) ? `<option value="${esc(store.projectId)}" selected disabled>Selected project (unavailable)</option>` : ''}${projects().map(project => `<option value="${esc(project.id)}" ${store.projectId === project.id ? 'selected' : ''}>${esc(project.name)}${project.archived ? ' (archived)' : ''}</option>`).join('')}`;
    host.querySelector('[data-issue-owner]').innerHTML = `<option value="">All assignees</option><option value="unassigned" ${filters.owner === 'unassigned' ? 'selected' : ''}>Unassigned</option>${people.map(person => `<option value="${esc(person.id)}" ${filters.owner === person.id ? 'selected' : ''}>${esc(person.name || person.id)}</option>`).join('')}${filters.owner && filters.owner !== 'unassigned' && !people.some(person => person.id === filters.owner) ? `<option value="${esc(filters.owner)}" selected>Selected assignee (no current issues)</option>` : ''}`;
  }
  function renderBoard() {
    if (!host) return;
    renderToolbar();
    const error = host.querySelector('[data-issue-error]');
    error.innerHTML = store.error ? `<div class="issue-error" role="alert"><span>${esc(store.error)}${store.loaded ? ' Showing the last saved snapshot.' : ''}</span>${button('refresh', 'Retry', 'reset')}</div>` : '';
    if (!projects().length && store.loaded) error.innerHTML += `<div class="issue-setup">${icon('book')}<div><strong>Add your first project</strong><p>Choose a project folder to organize your issues and send work to the team.</p></div>${button('projects', 'Add project', 'plus', '', true)}</div>`;
    const list = filterIssueRows(store.issues, filters, projects());
    host.querySelector('[data-issue-sync]').textContent = refreshing ? 'Updating…' : store.error ? 'Updates unavailable' : store.loaded ? `${list.length} of ${store.issues.length} issues` : 'Loading issues…';
    const fingerprint = JSON.stringify([list, store.loaded, store.error, filters, store.projectId, busy, selectedId, projects()]);
    if (boardFingerprint === fingerprint) return;
    boardFingerprint = fingerprint;
    const board = host.querySelector('[data-issue-board]'), active = document.activeElement;
    const focusMove = board.contains(active) ? active.dataset?.issueMove : null, focusAction = board.contains(active) ? active.dataset?.issueAction : null, focusId = board.contains(active) ? active.dataset?.id : null;
    const scrolls = new Map([...board.querySelectorAll('[data-issue-column]')].map(column => [column.dataset.issueColumn, column.querySelector('.issue-column-cards')?.scrollTop || 0]));
    const columns = ISSUE_COLUMNS.filter(column => !filters.hideEmpty || list.some(issue => issue.status === column.id));
    board.style.setProperty('--issue-columns', String(columns.length || 1));
    board.innerHTML = columns.length ? columns.map(column => {
      const items = list.filter(issue => issue.status === column.id), canCreate = projects().some(project => !project.archived) && !projects().find(project => project.id === store.projectId)?.archived;
      return `<section class="issue-column" data-issue-column="${column.id}" aria-labelledby="issue-column-${column.id}"><header><span class="issue-column-dot issue-dot-${column.id}" aria-hidden="true"></span><h2 id="issue-column-${column.id}">${column.label}</h2><span class="issue-column-count">${items.length}</span>${button('create', '', 'plus', `data-status="${column.id}" aria-label="Add issue to ${column.label}" ${!canCreate || busy ? 'disabled' : ''}`)}</header><div class="issue-column-cards">${items.length ? items.map(card).join('') : `<div class="issue-column-empty">${!store.loaded ? store.error ? 'Issues unavailable' : 'Loading…' : filters.query || filters.owner || filters.priority ? 'No matching issues' : 'No issues'}${canCreate && store.loaded ? button('create', 'Add issue', 'plus', `data-status="${column.id}"`) : ''}</div>`}</div></section>`;
    }).join('') : `<div class="issue-board-empty">${icon('board')}<h2>${store.issues.length ? 'No matching issues' : 'Your project board is ready'}</h2><p>${store.issues.length ? 'Try a different search or filter.' : 'Add an issue or send a plan from your connected coding agent.'}</p>${button('clear-filters', 'Show all columns', 'reset')}</div>`;
    for (const column of board.querySelectorAll('[data-issue-column]')) column.querySelector('.issue-column-cards').scrollTop = scrolls.get(column.dataset.issueColumn) || 0;
    syncColumnNavigation();
    if (focusMove) [...board.querySelectorAll('[data-issue-move]')].find(element => element.dataset.issueMove === focusMove)?.focus();
    else if (focusAction && focusId) [...board.querySelectorAll('[data-issue-action]')].find(element => element.dataset.issueAction === focusAction && element.dataset.id === focusId)?.focus();
  }
  function renderInspector() {
    const panel = host?.querySelector('[data-issue-inspector]'); if (!panel) return;
    const issue = selected(); panel.hidden = !issue;
    host.querySelector('.issue-work-area').classList.toggle('has-inspector', Boolean(issue));
    if (!issue) { panel.innerHTML = ''; return; }
    const work = execution(issue), editable = manual(issue), report = details.status, request = details.request;
    const fingerprint = JSON.stringify([issue, projectName(issue?.projectId), details.loading && !report, details.error, request, report, details.events, details.hasMore, inspectorError, busy, artifactPreview]);
    if (fingerprint === inspectorFingerprint) return; inspectorFingerprint = fingerprint;
    const scrollTop = panel.querySelector('.issue-inspector-body')?.scrollTop || 0;
    const openSections = [...panel.querySelectorAll('details[open]')].map(element => element.dataset.issueSection);
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusedMove = focused?.dataset?.issueMove, focusedAction = focused?.dataset?.issueAction, focusedPriority = focused?.dataset?.issueSetPriority, focusedArtifact = focused?.dataset?.artifact, focusedConsent = focused?.hasAttribute('data-issue-consent');
    const tasks = report?.taskViews || report?.tasks || [];
    const checks = report?.checks || [], compromised = new Set(report?.compromisedReceiptIds || []), unavailable = new Set(report?.unverifiedReceiptIds || []);
    const artifacts = issueArtifactGroups(report?.artifacts || []);
    const artifactRows = items => items.map(item => `<div class="issue-artifact">${icon('file')}<span>${esc(({ analysis_report: 'Analysis report', candidate_patch: 'Proposed code changes', summary: 'Summary' })[item.type] || String(item.type || 'File').replaceAll('_', ' '))}</span>${button('artifact', 'View', 'eye', `data-artifact="${esc(item.id)}"`)}</div>${artifactPreview?.id === item.id ? `<pre class="issue-artifact-preview">${esc(artifactPreview.text)}</pre>` : ''}`).join('');
    const handoffs = issueHandoffs(issue, request, report, details.events);
    const resultText = report?.run?.finalReply || request?.controlReply || report?.outcome?.summary;
    const resultSummary = issueResultSummary(issue) || (resultText ? 'A response has been recorded. Open the technical review for its full text.' : '');
    panel.innerHTML = `<header class="issue-inspector-header"><span title="${esc(issue.id)}">${esc(shortIssueId(issue))}</span><span class="issue-card-kind">${esc(issue.kind)}</span>${button('close-inspector', '', 'close', 'aria-label="Close issue details" data-issue-close-inspector')}</header><div class="issue-inspector-body"><h2>${esc(issue.title)}</h2><div class="issue-detail-status"><span class="issue-column-dot issue-dot-${esc(issue.status)}"></span><span>${esc(labelFor(issue.status))}</span><strong class="${work.verified || work.analysisReviewed ? 'issue-verified' : ''}">${esc(issueEvidenceLabel(issue))}</strong></div><dl class="issue-properties"><div><dt>Project</dt><dd>${icon('book')}${esc(projectName(issue.projectId))}</dd></div><div><dt>Status</dt><dd><select data-issue-move="${esc(issue.id)}" aria-label="Move ${esc(issue.title)} to status" ${!editable || busy ? 'disabled' : ''} title="${editable ? 'Change planning status' : 'Status follows recorded execution'}">${options(issue.status)}</select></dd></div><div><dt>Assignees</dt><dd class="issue-detail-owners">${ownerFaces(ownersOf(issue), { detail: true })}</dd></div><div><dt>Department</dt><dd>${esc(work.department?.name || (issue.requestId ? 'Control Center' : 'Unassigned'))}</dd></div><div><dt>Priority</dt><dd><select data-issue-set-priority="${esc(issue.id)}" aria-label="Issue priority" ${busy ? 'disabled' : ''}>${priorityOptions(issue.priority || 'none')}</select></dd></div><div><dt>Created</dt><dd>${esc(date(issue.createdAt))}</dd></div><div><dt>Updated</dt><dd>${esc(date(work.updatedAt || issue.updatedAt))}</dd></div><div><dt>Started</dt><dd>${esc(date(work.startedAt))}</dd></div><div><dt>${completedAt(issue) ? 'Completed' : 'Ended'}</dt><dd>${esc(date(completedAt(issue) || work.endedAt))}</dd></div><div><dt>${durationLabel(issue)} time</dt><dd>${duration(issue, '')}</dd></div></dl>${work.reason ? `<p class="issue-detail-reason${['blocked', 'unknown', 'interrupted'].includes(work.state) ? ' is-warning' : ''}">${esc(work.reason)}</p>` : ''}<section class="issue-brief"><header><h3>Description</h3>${editable ? button('edit', 'Edit', 'pen') : ''}</header><div class="issue-description-full">${esc(issue.description || 'No description added.')}</div></section>${inspectorError ? `<p class="issue-error" role="alert">${esc(inspectorError)}</p>` : ''}${!issue.requestId ? `<details class="issue-access" data-issue-section="access"><summary>Runtime access options</summary><label><input type="checkbox" data-issue-consent ${consent ? 'checked' : ''}>Allow this request to use a runtime whose file-write boundary is unverified.</label><p>This grants the selected runtime access for this request.</p></details>` : ''}${details.loading && !report ? '<p class="issue-detail-loading" role="status">Loading linked work…</p>' : ''}${details.error ? `<p class="issue-detail-error" role="alert">${esc(details.error)} ${button('refresh-details', 'Retry', 'reset')}</p>` : ''}${resultSummary ? `<section class="issue-result"><h3>Result</h3><p>${esc(resultSummary)}</p></section>` : ''}${resultText ? `<details class="issue-evidence-section" data-issue-section="technical-review"><summary><span>Technical review</span>${icon('down')}</summary><div class="issue-technical-review">${esc(resultText)}</div></details>` : ''}${tasks.length ? `<details class="issue-evidence-section" data-issue-section="tasks"><summary><span>Assigned work</span><span>${tasks.length}</span>${icon('down')}</summary><div>${tasks.map(task => { const person = ownersOf(issue).find(owner => owner.id === task.ownerAgentId); return `<article class="issue-task-evidence"><strong>${esc(task.objective || task.id)}</strong><p>${esc(person?.name || task.ownerAgentId || 'Unassigned')}<span>·</span>${esc(String(task.state || '').replaceAll('_', ' '))}</p>${task.attempt?.startedAt ? renderDuration({ start: task.attempt.startedAt, end: task.attempt.endedAt, active: !task.attempt.endedAt && ['running', 'validating'].includes(task.state), label: 'Task time', className: 'issue-task-duration' }) : ''}</article>`; }).join('')}</div></details>` : ''}${checks.length ? `<details class="issue-evidence-section" data-issue-section="checks"><summary><span>Checks</span><span>${checks.length}</span>${icon('down')}</summary><div>${checks.map(check => { const validPass = check.outcome === 'passed' && check.evidenceProvenance === 'verifier_executed' && !compromised.has(check.id) && !unavailable.has(check.id); return `<article class="issue-check-evidence"><span class="${validPass ? 'issue-verified' : ''}">${icon(validPass ? 'circleCheck' : 'flag')}${esc(compromised.has(check.id) ? 'Integrity concern' : unavailable.has(check.id) ? 'Evidence unavailable' : check.evidenceProvenance !== 'verifier_executed' ? `${check.outcome} · agent reported` : check.outcome)}</span><code>${esc(check.command)}</code></article>`; }).join('')}</div></details>` : ''}${handoffs.length || details.hasMore ? `<details class="issue-evidence-section" data-issue-section="handoffs"><summary><span>Handoffs & activity</span>${icon('down')}</summary><div class="issue-handoff-list">${handoffs.map(item => `<div><span class="issue-handoff-dot"></span><p>${esc(item.label)}</p>${item.context ? `<p class="issue-handoff-context" title="${esc(item.context)}">${esc(item.context)}</p>` : ''}<time>${esc(date(item.timestamp))}</time>${item.start ? renderDuration({ start: item.start, end: item.end, active: item.active, label: 'Elapsed', className: 'issue-handoff-duration' }) : ''}</div>`).join('')}${details.hasMore ? `<p class="issue-handoff-more">More recorded activity is loading. ${button('refresh-details', 'Load next events', 'down')}</p>` : ''}</div></details>` : ''}${artifacts.deliverables.length ? `<section class="issue-evidence-section issue-deliverables"><h3>Deliverables</h3><div>${artifactRows(artifacts.deliverables)}</div></section>` : ''}${artifacts.technical.length ? `<details class="issue-evidence-section" data-issue-section="technical-files"><summary><span>Technical files</span><span>${artifacts.technical.length}</span>${icon('down')}</summary><div>${artifactRows(artifacts.technical)}</div></details>` : ''}<details class="issue-evidence-section" data-issue-section="record"><summary><span>Record details</span>${icon('down')}</summary><dl class="issue-record-facts"><dt>Issue ID</dt><dd>${esc(issue.id)}</dd><dt>Source</dt><dd>${esc(issue.source || 'Workspace')}</dd>${issue.requestId ? `<dt>Request</dt><dd>${esc(issue.requestId)}</dd>` : ''}${issue.runId ? `<dt>Run</dt><dd>${esc(issue.runId)}</dd>` : ''}</dl></details></div><footer class="issue-inspector-footer">${button(issue.requestId ? 'request' : 'dispatch', issue.requestId ? 'Open task & results' : 'Send to Control Center', issue.requestId ? 'northeast' : 'arrow', `data-id="${esc(issue.id)}" ${busy || (!issue.requestId && archivedProject(issue, projects())) ? 'disabled' : ''}`, true)}</footer>`;
    panel.querySelector('.issue-inspector-body').scrollTop = scrollTop;
    for (const name of openSections) [...panel.querySelectorAll('[data-issue-section]')].find(section => section.dataset.issueSection === name)?.setAttribute('open', '');
    if (focusedMove) panel.querySelector('[data-issue-move]')?.focus({ preventScroll: true });
    else if (focusedPriority) panel.querySelector('[data-issue-set-priority]')?.focus({ preventScroll: true });
    else if (focusedConsent) panel.querySelector('[data-issue-consent]')?.focus({ preventScroll: true });
    else if (focusedAction) [...panel.querySelectorAll('[data-issue-action]')].find(element => element.dataset.issueAction === focusedAction && (!focusedArtifact || element.dataset.artifact === focusedArtifact))?.focus({ preventScroll: true });
  }
  async function refreshDetails() {
    const issue = selected(); if (!issue || !host) return;
    const generation = mounted; const pending = details.load(issue); renderInspector(); await pending;
    if (generation === mounted && host && selectedId === issue.id) renderInspector();
  }
  async function refresh() {
    if (!host || refreshing || busy) return;
    const generation = mounted, sequence = ++refreshSequence; refreshing = true; renderBoard();
    await store.load();
    if (generation !== mounted || sequence !== refreshSequence || !host) return;
    refreshing = false;
    if (selectedId) { const issue = store.issues.find(item => item.id === selectedId); if (issue) selectedIssue = issue; }
    renderBoard(); renderInspector();
    if (selectedId && (LIVE.has(execution(selected()).state) || details.needsRefresh(selected()))) void refreshDetails();
  }
  function showInspector(issue, { focus = true } = {}) {
    if (!issue) return;
    if (selectedId !== issue.id) { inspectorError = ''; consent = false; artifactPreview = null; artifactSequence++; details.select(issue); }
    selectedId = issue.id; selectedIssue = issue; inspectorFingerprint = ''; renderBoard(); renderInspector();
    if (focus) host.querySelector('[data-issue-close-inspector]')?.focus();
    if (issue.requestId || issue.runId) void refreshDetails();
  }
  function closeInspector() {
    const prior = selectedId; selectedId = null; selectedIssue = null; details.select(null); inspectorError = ''; artifactPreview = null; artifactSequence++;
    renderBoard(); renderInspector(); [...(host?.querySelectorAll('[data-issue-action="open"][data-id]') || [])].find(element => element.dataset.id === prior)?.focus();
  }
  function closeDialog({ force = false, focus = true } = {}) {
    if (busy && !force) return;
    const old = dialog; dialog = null; dialogIssue = null; draft = null;
    if (old) { old.close(); old.remove(); }
    if (focus && returnFocus?.isConnected) returnFocus.focus();
  }
  function openDialog(issue = null, status = 'backlog') {
    if (busy) return; closeDialog();
    returnFocus = document.activeElement; dialogIssue = issue;
    const projectId = projects().find(project => project.id === store.projectId && !project.archived)?.id || projects().find(project => !project.archived)?.id || '';
    draft = drafts.open(issue, { projectId, status });
    // Keep a saved draft's unavailable project explicit instead of submitting the visible fallback.
    dialog = document.createElement('dialog'); dialog.className = 'issue-dialog'; dialog.setAttribute('aria-labelledby', 'issue-dialog-title');
    dialog.addEventListener('click', handleClick); dialog.addEventListener('input', handleDraft); dialog.addEventListener('change', handleDraft); dialog.addEventListener('submit', handleSubmit);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    document.body.append(dialog); renderDialog(); dialog.showModal();
  }
  function renderDialog() {
    if (!dialog || !draft) return;
    const issue = dialogIssue, available = projects().filter(project => !project.archived || project.id === issue?.projectId);
    const missing = !available.some(project => project.id === draft.projectId);
    dialog.innerHTML = `<header class="issue-dialog-header"><div><p class="eyebrow">${issue ? esc(shortIssueId(issue)) : 'PROJECT WORK'}</p><h2 id="issue-dialog-title">${issue ? 'Edit issue' : 'New issue'}</h2></div>${button('close', '', 'close', 'aria-label="Close issue editor"')}</header><form data-issue-form><div class="issue-form-fields"><div class="issue-form-row"><label>Project<select name="projectId" required ${issue ? 'disabled' : ''}>${missing ? `<option value="${esc(draft.projectId)}" selected disabled>Choose an available project</option>` : ''}${available.map(project => `<option value="${esc(project.id)}" ${project.id === draft.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}</select></label><label>Type<select name="kind" ${issue ? 'disabled' : ''}>${['issue', 'plan', 'prd'].map(kind => `<option value="${kind}" ${draft.kind === kind ? 'selected' : ''}>${kind === 'prd' ? 'PRD' : kind === 'plan' ? 'Plan' : 'Issue'}</option>`).join('')}</select></label></div><label>Title<input name="title" value="${esc(draft.title)}" maxlength="300" required placeholder="What needs to be done?"></label><label>Description<textarea name="description" rows="9" placeholder="Describe the outcome, requirements, and acceptance criteria. You can paste your full plan or PRD.">${esc(draft.description)}</textarea></label><div class="issue-form-row"><label>Status<select name="status">${options(draft.status)}</select></label><label>Priority<select name="priority">${priorityOptions(draft.priority || 'none')}</select></label></div><p class="issue-help">${issue ? 'Save changes to this issue.' : 'Create & start sends this brief to Control Center. Save issue keeps it on your board for later.'}</p>${issue && draft.expectRevision !== issue.revision ? '<p class="issue-draft-warning">This issue changed since your draft began. Your draft is preserved; review the latest saved issue before replacing it.</p>' : ''}<p class="issue-error" data-issue-form-error role="alert" hidden></p></div><footer class="issue-dialog-footer">${button('discard-draft', 'Discard draft', null)}${button('close', 'Keep draft', null)}<button type="submit" name="submitAction" value="save" class="issue-button${issue ? ' issue-primary' : ''}">${icon('check')}Save issue</button>${!issue ? `<button type="submit" name="submitAction" value="start" class="issue-button issue-primary">${icon('arrow')}Create & start</button>` : ''}</footer></form>`;
  }
  function refreshDialogProjects() {
    const select = dialog?.querySelector('select[name="projectId"]');
    if (!select || !draft || busy) return;
    draft = captureIssueDraft(drafts, dialogIssue, draft, dialog.querySelector('[data-issue-form]'));
    const available = projects().filter(project => !project.archived || project.id === dialogIssue?.projectId);
    const missing = !available.some(project => project.id === draft.projectId);
    // Only replace options; the editor, input focus, draft and expected revision remain intact.
    select.innerHTML = `${missing ? `<option value="${esc(draft.projectId)}" selected disabled>Choose an available project</option>` : ''}${available.map(project => `<option value="${esc(project.id)}" ${project.id === draft.projectId ? 'selected' : ''}>${esc(project.name)}</option>`).join('')}`;
  }
  function workspaceUpdated() {
    if (!host) return;
    renderBoard(); renderInspector(); refreshDialogProjects();
  }
  function handleDraft(event) { if (draft && event.target.name) draft = drafts.change(dialogIssue, draft, event.target.name, event.target.value); }
  function showDialogError(error) {
    const output = dialog?.querySelector('[data-issue-form-error]');
    if (output) { output.hidden = false; output.textContent = `${error.message}${error.status === 409 ? ' Your draft is retained. Close this editor to review the current issue; discard the draft only when you choose to use the saved version.' : ''}`; }
    else notify(error.message);
  }
  function setBusy(value) {
    busy = value;
    dialog?.querySelectorAll('button,input,select,textarea').forEach(element => { element.disabled = value || (element.tagName === 'SELECT' && Boolean(dialogIssue) && ['projectId', 'kind'].includes(element.name)); });
    toolbarFingerprint = ''; renderBoard(); renderInspector();
  }
  async function handleSubmit(event) {
    event.preventDefault(); if (busy || !draft) return;
    if (!event.target.matches('[data-issue-form]') || !event.target.reportValidity()) return;
    draft = captureIssueDraft(drafts, dialogIssue, draft, event.target);
    const start = !dialogIssue && event.submitter?.value === 'start';
    if (!draft.title.trim()) { showDialogError(new Error('Give this issue a title.')); return; }
    if (draft.description.length > 64000) { showDialogError(new Error('The description exceeds 64,000 characters. Your complete draft is retained; shorten the brief before saving.')); return; }
    if (!projects().some(project => project.id === draft.projectId && !project.archived)) { showDialogError(new Error('Choose an available project before saving.')); return; }
    const generation = mounted, submitted = { ...draft }, original = dialogIssue, editor = dialog;
    setBusy(true);
    try {
      const fields = { title: submitted.title, description: submitted.description, status: submitted.status, priority: submitted.priority || 'none', idempotencyKey: submitted.idempotencyKey };
      const result = original ? await store.update({ ...original, revision: submitted.expectRevision }, fields) : await store.create({ ...fields, projectId: submitted.projectId, kind: submitted.kind, source: 'workspace', start });
      drafts.clearSaved(original, submitted.idempotencyKey);
      if (generation === mounted && editor === dialog && host) { closeDialog({ force: true, focus: false }); showInspector(result.issue); if (result.startError) { inspectorError = result.startError.message; renderInspector(); } }
      notify(result.startError ? `Issue saved. ${result.startError.message}` : start ? 'Issue created and sent to Control Center.' : 'Issue saved.');
    } catch (error) { if (generation === mounted && editor === dialog) showDialogError(error); else notify(error.message); }
    finally { setBusy(false); }
  }
  async function updateField(id, field, value) {
    const issue = store.issues.find(item => item.id === id) || selected();
    if (!issue || busy || (field === 'status' && !manual(issue)) || issue[field] === value) return;
    if (field === 'status' && !ISSUE_COLUMNS.some(column => column.id === value)) return;
    if (field === 'priority' && !ISSUE_PRIORITIES.some(priority => priority.id === value)) return;
    const generation = mounted; setBusy(true);
    try { const result = await store.update(issue, { [field]: value, idempotencyKey: key() }); if (selectedId === issue.id) selectedIssue = result.issue; if (generation === mounted) announce(`${issue.title}: ${field === 'status' ? labelFor(value) : priorityFor(value).label}.`); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); void refresh(); }
  }
  async function handleClick(event) {
    const target = event.target.closest('[data-issue-action]'); if (!target || target.disabled) return;
    const action = target.dataset.issueAction, issue = store.issues.find(item => item.id === target.dataset.id) || selected();
    if (action === 'scroll-left' || action === 'scroll-right') { scrollColumns(action === 'scroll-left' ? -1 : 1); return; }
    if (action === 'create') { openDialog(null, target.dataset.status || 'backlog'); return; }
    if (action === 'open' || action === 'start') { showInspector(issue); return; }
    if (action === 'close') { closeDialog(); return; }
    if (action === 'close-inspector') { closeInspector(); return; }
    if (action === 'edit') { openDialog(issue); return; }
    if (action === 'discard-draft') { drafts.reset(dialogIssue); closeDialog(); return; }
    if (action === 'refresh') { void refresh(); return; }
    if (action === 'refresh-details') { void refreshDetails(); return; }
    if (action === 'clear-filters') { Object.assign(filters, { query: '', owner: '', priority: '', hideEmpty: false }); remember(); render(); return; }
    if (action === 'projects' || action === 'connections') { onNavigate(action); return; }
    if (action === 'request') { if (issue?.requestId) onRequest(issue.requestId); return; }
    if (action === 'artifact' && issue?.runId) {
      const generation = mounted, sequence = ++artifactSequence; target.disabled = true;
      try { const result = await api(`/api/projects/${encodeURIComponent(issue.projectId)}/runs/${encodeURIComponent(issue.runId)}/artifacts/${encodeURIComponent(target.dataset.artifact)}`); if (generation === mounted && selectedId === issue.id && sequence === artifactSequence) { artifactPreview = { id: target.dataset.artifact, text: typeof result.text === 'string' ? result.text.slice(0, 30000) + (result.text.length > 30000 ? '\n\nPreview shortened. Open the task for the full output.' : '') : 'This output has no text preview. Open the task to inspect its files.' }; renderInspector(); } }
      catch (error) { notify(error.message); } finally { if (target.isConnected) target.disabled = false; }
      return;
    }
    if (action === 'dispatch' && issue && !busy) {
      const generation = mounted; setBusy(true); inspectorError = '';
      try { const result = await store.start(issue, consent); if (generation === mounted && selectedId === issue.id) { selectedIssue = result.issue; renderInspector(); } notify('Sent to Control Center.'); }
      catch (error) { if (generation === mounted && selectedId === issue.id) { inspectorError = error.message; selectedIssue = store.issues.find(item => item.id === issue.id) || issue; } else notify(error.message); }
      finally { setBusy(false); void refresh(); }
    }
  }
  function handleChange(event) {
    const target = event.target;
    if (target.matches('[data-issue-project]')) { store.select(target.value); filters.owner = ''; refreshSequence++; refreshing = false; closeInspector(); remember(); renderBoard(); void refresh(); }
    if (target.matches('[data-issue-owner]')) { filters.owner = target.value; remember(); renderBoard(); }
    if (target.matches('[data-issue-priority]')) { filters.priority = target.value; remember(); renderBoard(); }
    if (target.matches('[data-issue-sort]')) { filters.sort = target.value; remember(); renderBoard(); }
    if (target.matches('[data-issue-hide-empty]')) { filters.hideEmpty = target.checked; remember(); renderBoard(); }
    if (target.matches('[data-issue-consent]')) consent = target.checked;
    if (target.dataset.issueMove) void updateField(target.dataset.issueMove, 'status', target.value);
    if (target.dataset.issueSetPriority) void updateField(target.dataset.issueSetPriority, 'priority', target.value);
  }
  function handleInput(event) { if (event.target.matches('[data-issue-search]')) { filters.query = event.target.value; remember(); renderBoard(); } }
  function handleKey(event) {
    if (event.key === 'Escape' && selectedId && !dialog) { event.preventDefault(); closeInspector(); }
    if (!event.target.matches?.('.issue-board-scroll')) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); scrollColumns(event.key === 'ArrowLeft' ? -1 : 1, event.key === 'Home' ? 'start' : event.key === 'End' ? 'end' : null);
    }
  }
  function syncColumnNavigation() {
    const scroller = host?.querySelector('.issue-board-scroll'), controls = host?.querySelector('[data-issue-scroll-controls]');
    if (!scroller || !controls) return;
    const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth), overflow = maximum > 2;
    controls.hidden = !overflow;
    controls.querySelector('[data-issue-action="scroll-left"]').disabled = !overflow || scroller.scrollLeft <= 1;
    controls.querySelector('[data-issue-action="scroll-right"]').disabled = !overflow || scroller.scrollLeft >= maximum - 1;
  }
  function scrollColumns(direction, edge = null) {
    const scroller = host?.querySelector('.issue-board-scroll'); if (!scroller) return;
    const column = scroller.querySelector('.issue-column'), board = scroller.querySelector('[data-issue-board]');
    const gap = Number.parseFloat(board && globalThis.getComputedStyle?.(board).columnGap) || 0;
    const amount = (column?.getBoundingClientRect?.().width || scroller.clientWidth * .8) + gap;
    const left = edge === 'start' ? 0 : edge === 'end' ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollLeft + direction * amount;
    scroller.scrollTo({ left: Math.max(0, left), behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function unbindColumnNavigation() {
    resizeObserver?.disconnect(); resizeObserver = null;
    observedScroller?.removeEventListener('scroll', syncColumnNavigation); observedScroller = null;
  }
  function bindColumnNavigation() {
    observedScroller = host?.querySelector('.issue-board-scroll'); if (!observedScroller) return;
    observedScroller.addEventListener('scroll', syncColumnNavigation, { passive: true });
    if (globalThis.ResizeObserver) { resizeObserver = new ResizeObserver(syncColumnNavigation); resizeObserver.observe(observedScroller); resizeObserver.observe(host.querySelector('[data-issue-board]')); }
    syncColumnNavigation();
  }
  function dragStart(event) {
    const card = event.target.closest('[data-issue-id]');
    if (!card || !card.draggable || event.target.closest('select,input,textarea')) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-workforce-issue', card.dataset.issueId); event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(event) { const column = event.target.closest('[data-issue-column]'); if (column && [...event.dataTransfer.types].includes('application/x-workforce-issue')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }
  function drop(event) { const column = event.target.closest('[data-issue-column]'); if (!column) return; const id = event.dataTransfer.getData('application/x-workforce-issue'); if (id) { event.preventDefault(); void updateField(id, 'status', column.dataset.issueColumn); } }
  const handlers = { click: handleClick, change: handleChange, input: handleInput, keydown: handleKey, dragstart: dragStart, dragover: dragOver, drop };
  function unmount() {
    unbindColumnNavigation();
    workspaceEvents?.removeEventListener('workforce:workspace-updated', workspaceUpdated);
    clearInterval(timer); mounted++; refreshSequence++; store.sequence++; details.sequence++;
    if (host) for (const [name, handler] of Object.entries(handlers)) host.removeEventListener(name, handler);
    closeDialog({ force: true, focus: false }); host = null; refreshing = false;
  }
  return {
    mount(element) {
      unmount(); host = element;
      if (store.projectId && !projects().some(project => project.id === store.projectId)) store.select('');
      render(); for (const [name, handler] of Object.entries(handlers)) host.addEventListener(name, handler);
      workspaceEvents?.addEventListener('workforce:workspace-updated', workspaceUpdated);
      void refresh(); timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 4000);
    }, openCreate(status = 'backlog') { if (host) openDialog(null, status); }, refresh, unmount,
  };
}
