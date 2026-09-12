import { api } from './api.js';
import { ADAPTER_NAMES, acceptanceView, ago, checkView, deskTone, describeEvent, diffLines, phaseSteps, requirementViews, runGroup, runStatusLine, runTitle, runTone, runtimeStatus } from './office-model.js';

const icon = (name, size = 18) => {
  const paths = {
    center: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="15" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6M6 9v6m12-6v6M9 18h6"/>',
    arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
    send: '<path d="m12 19 0-14m-5 5 5-5 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
    sparkle: '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/>',
    focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.center}</svg>`;
};

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = (name = '') => String(name).split(/[\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const basename = (value) => String(value ?? '').split('/').filter(Boolean).pop() || '';
const short = (value, length = 12) => String(value ?? '').slice(0, length);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const REPO_KEY = 'workforce-office-repo-v1';
const TABS = ['assign', 'tasks', 'connections'];
const STREAM_LABELS = { live: 'LIVE · READ-ONLY', connecting: 'CONNECTING', reconnecting: 'RECONNECTING', closed: 'OFFLINE', failed: 'STREAM FAILED' };
const GROUP_ORDER = { running: 0, stalled: 1, review: 2, failed: 3 };

/** A per-viewer convenience only: the last repository path typed here. */
function readStoredRepo() {
  try {
    const value = localStorage.getItem(REPO_KEY);
    return typeof value === 'string' && value.length <= 4096 ? value : '';
  } catch {
    return '';
  }
}
function storeRepo(value) {
  try { localStorage.setItem(REPO_KEY, value); } catch { /* Storage can be unavailable; the field still works. */ }
}

/**
 * The control-center panel: Assign (start a real run), Tasks (recorded runs
 * and their evidence) and Connections (passive runtime discovery). It reads
 * everything from `getState()`, which main.js fills from the server, and it
 * holds no task truth of its own.
 */
export function createSidebar({ element, departments = [], getState, onFocus = () => {}, onManageAgents = () => {}, onAddAgent = () => {}, onShowAgent = () => {}, onRefreshRuntimes = () => {}, onStarted = () => {} }) {
  let selection = { type: 'office' };
  let activeTab = 'assign';
  let taskFilter = 'all';
  let expandedRun = null;
  let expandedRuntime = null;
  let destroyed = false;
  let renderTimer = null;
  let detailTimer = null;
  const details = new Map();
  const diffs = new Map();
  const form = { repo: readStoredRepo(), agentId: '', task: '' };
  let preview = { key: null, loading: false, result: null, error: null };
  let consent = false;
  let starting = false;
  let outcome = null;

  const state = () => getState();
  const agents = () => state().office?.agents ?? [];
  const agentById = (id) => agents().find((agent) => agent.id === id);
  const departmentById = (id) => departments.find((department) => department.id === id);
  const employeeById = (id) => state().employees.find((employee) => employee.id === id);
  const deskOf = (id) => state().desks.get(id);
  const runById = (id) => state().runs.find((run) => run.id === id);
  const reportFor = (adapter) => (state().office?.runtimes?.reports ?? []).find((report) => report.adapter === adapter);
  // The lock as GET /api/runs read it alongside the rows: fresher than the office document's.
  const coordinatorLock = () => state().lock ?? null;

  element.classList.add('office-sidebar');
  element.setAttribute('aria-label', 'Control center');
  element.innerHTML = `
    <header class="sidebar-heading">
      <div class="sidebar-heading-top"><span class="coordinator-kicker"><i></i> WORKFORCE COORDINATOR</span><span class="sidebar-demo-label" data-stream-label>CONNECTING</span></div>
      <div class="sidebar-title-row"><h1>Control center<span>.</span></h1><span class="coordinator-mark">${icon('center', 22)}</span></div>
      <p><span class="sidebar-coordinator-name">Atlas</span> · the workforce coordinator.</p>
      <div class="sidebar-agent-actions"><button type="button" class="sidebar-roster-button" data-manage-agents>${icon('center', 14)}Agents <span class="sidebar-agent-count">0</span></button><button type="button" class="sidebar-add-agent" data-add-agent><span aria-hidden="true">+</span> Add agent</button></div>
    </header>
    <div class="sidebar-context-row">
      <span class="context-icon">${icon('focus', 15)}</span>
      <label class="sr-only" for="office-context-select">Panel and canvas scope</label>
      <select id="office-context-select" class="sidebar-context-select"></select>
      <button class="sidebar-icon-button context-focus" title="Focus selected area on canvas" aria-label="Focus selected area on canvas">${icon('arrow', 16)}</button>
    </div>
    <div class="sidebar-tabs" role="tablist" aria-label="Control center views">
      <button class="sidebar-tab is-active" type="button" role="tab" id="office-tab-assign" aria-controls="office-panel" aria-selected="true" data-tab="assign">Assign</button>
      <button class="sidebar-tab" type="button" role="tab" id="office-tab-tasks" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="tasks">Tasks <span class="tab-task-count">0</span></button>
      <button class="sidebar-tab" type="button" role="tab" id="office-tab-connections" aria-controls="office-panel" aria-selected="false" tabindex="-1" data-tab="connections">Connections</button>
    </div>
    <section class="sidebar-scroll" id="office-panel" role="tabpanel" aria-labelledby="office-tab-assign" tabindex="0"></section>
    <div class="sidebar-composer-wrap"></div>
    <div class="sidebar-demo-note">Reads the coordinator's state read-only · work starts only from Start run</div>`;

  const scroll = element.querySelector('.sidebar-scroll');
  const composerWrap = element.querySelector('.sidebar-composer-wrap');
  const contextSelect = element.querySelector('.sidebar-context-select');
  const streamLabel = element.querySelector('[data-stream-label]');

  // -------------------------------------------------------------------------
  // Scope
  // -------------------------------------------------------------------------

  /** Agent ids in the current selection; null means the whole office. */
  function scopedAgentIds() {
    if (selection.type === 'employee') {
      const agentId = employeeById(selection.id)?.agentId;
      return agentId ? [agentId] : [];
    }
    if (selection.type === 'department') return state().employees.filter((employee) => employee.departmentId === selection.id && employee.agentId).map((employee) => employee.agentId);
    return null;
  }

  function defaultAgentId() {
    const selected = selection.type === 'employee' ? employeeById(selection.id)?.agentId : null;
    if (selected && agentById(selected)) return selected;
    if (form.agentId && agentById(form.agentId)) return form.agentId;
    const worker = state().office?.configuration?.defaults?.workerAgent;
    if (worker && agentById(worker)) return worker;
    return agents()[0]?.id ?? '';
  }

  function contextOptions() {
    const employees = state().employees;
    return `<option value="office">Whole office</option>${departments.map((department) => {
      const members = employees.filter((employee) => employee.departmentId === department.id && employee.kind === 'agent');
      return `<optgroup label="${esc(department.name)}"><option value="department:${esc(department.id)}">${esc(department.name)} · ${plural(members.length, 'agent')}</option>${members.map((employee) => `<option value="employee:${esc(employee.id)}">${esc(employee.name)}</option>`).join('')}</optgroup>`;
    }).join('')}`;
  }

  // -------------------------------------------------------------------------
  // Selection summary (top of every tab)
  // -------------------------------------------------------------------------

  function renderSelection() {
    const s = state();
    if (selection.type === 'employee') {
      const employee = employeeById(selection.id);
      if (!employee) return '';
      const department = departmentById(employee.departmentId);
      if (employee.kind === 'open') {
        return `<section class="selected-employee open-desk-panel"><div class="selected-person-top"><span class="employee-monogram" style="--department-color:${esc(department?.color || '#8a9185')}">–</span><div><h2>Open desk</h2><p>${esc(department?.name || '')} · not configured</p></div></div><p class="person-task"><span>NO AGENT HERE</span>No configured agent sits at this desk, so it has no status. Desks are filled from ${esc(s.office?.configuration?.path || 'agents.json')} by the seat rule.</p><button type="button" class="person-edit" data-add-agent>How to add an agent${icon('arrow', 13)}</button></section>`;
      }
      const agent = employee.agent ?? agentById(employee.agentId) ?? {};
      const desk = deskOf(employee.id);
      const run = desk?.runId ? runById(desk.runId) : null;
      const tone = deskTone(desk?.state);
      const report = reportFor(agent.adapter);
      const runtime = report ? runtimeStatus(report) : null;
      const lastSeen = desk?.lastEvent?.timestamp ? ago(desk.lastEvent.timestamp, Date.now()) : null;
      return `<section class="selected-employee">
        <div class="selected-person-top"><span class="employee-monogram" style="--department-color:${esc(department?.color || '#628273')}">${esc(initials(employee.name))}</span><div><h2>${esc(employee.name)}</h2><p>${esc(ADAPTER_NAMES[agent.adapter] || agent.adapter || 'unknown runtime')} · ${esc(agent.model || 'runtime default model')} · ${esc(agent.policy || '')}</p></div><button class="sidebar-icon-button" data-focus="employee" data-id="${esc(employee.id)}" aria-label="Focus ${esc(employee.name)} on canvas">${icon('focus', 16)}</button></div>
        <p class="person-task"><span>NOW · FROM THE DATABASE</span><strong class="tone-text-${esc(tone)}">${esc(desk?.label || 'Idle · no task')}</strong>${run ? `<br>${esc(runTitle(run))}` : ''}${lastSeen ? `<br><small>last recorded event ${esc(lastSeen)} · ${esc(describeEvent({ type: desk.lastEvent.type }))}</small>` : ''}${desk?.detail ? `<br><small>${esc(desk.detail)}</small>` : ''}</p>
        <div class="person-configuration"><span class="sidebar-small-label">AGENT CONFIGURATION · READ-ONLY</span><p>runtime <strong>${esc(agent.runtime || '')}</strong>${runtime ? ` · <span class="tone-text-${esc(runtime.tone === 'ready' ? 'active' : runtime.tone)}">${esc(runtime.label)}</span>` : agent.adapter === 'fake' ? ' · test runtime, not probed' : ''}</p><p>capabilities ${esc((agent.capabilities || []).join(', ') || 'none')}</p>${agent.writeBoundary?.requiresAllowUnconfinedWrites ? '<p class="tone-text-warning">No established write boundary · starting a run asks for explicit consent</p>' : ''}</div>
        ${agent.instructions ? `<details class="person-instructions"><summary>Instructions <span>${esc(agent.instructions.slice(0, 84))}${agent.instructions.length > 84 ? '…' : ''}</span></summary><p>${esc(agent.instructions)}</p></details>` : ''}
        <div class="selection-actions"><button type="button" class="person-edit" data-assign-agent="${esc(agent.id)}">Assign a task${icon('arrow', 13)}</button>${run ? `<button type="button" class="person-edit" data-open-run="${esc(run.id)}">Open run${icon('arrow', 13)}</button>` : ''}<button type="button" class="person-edit" data-show-agent="${esc(agent.id)}">Details${icon('arrow', 13)}</button></div>
      </section>`;
    }
    if (selection.type === 'department') {
      const department = departmentById(selection.id);
      if (!department) return '';
      const roster = s.employees.filter((employee) => employee.departmentId === department.id);
      const members = roster.filter((employee) => employee.kind === 'agent');
      const open = roster.filter((employee) => employee.kind === 'open').length;
      return `<section class="selected-department"><div><i style="background:${esc(department.color || '#628273')}"></i><h2>${esc(department.name)}</h2></div><p>${members.length ? `${plural(members.length, 'configured agent')} · ${plural(open, 'open desk')}` : `No agents configured here · ${plural(open, 'open desk')}`}</p><div class="selection-actions">${members.map((employee) => `<button type="button" class="person-edit" data-focus="employee" data-id="${esc(employee.id)}">${esc(employee.name)} · ${esc(deskOf(employee.id)?.label || '')}</button>`).join('')}${members.some((employee) => employee.isCustom) ? `<button type="button" class="person-edit" data-focus-extra="${esc(department.id)}">Show additional desks${icon('arrow', 13)}</button>` : ''}</div></section>`;
    }
    if (selection.type === 'control') {
      const coordinator = s.office?.coordinator;
      const lock = s.lock ?? coordinator?.lock;
      const configuration = s.office?.configuration;
      return `<section class="selected-coordinator"><div class="selected-person-top"><span class="employee-monogram">AT</span><div><h2>Atlas</h2><p>The workforce coordinator · Control center</p></div></div>
        <div class="person-configuration"><span class="sidebar-small-label">COORDINATOR · RECORDED STATE</span>${coordinator ? `<p>workforce ${esc(coordinator.version)}</p><p>state root <code>${esc(coordinator.stateRoot)}</code>${coordinator.stateFound ? '' : ' · no state store yet'}</p><p>${lock?.held ? `coordinator lock held by pid ${esc(lock.pid)} since ${esc(lock.acquiredAt)}` : lock?.held === null ? 'coordinator lock unreadable · whether a coordinator is running is unknown' : 'coordinator lock free · no coordinator is running'}</p><p>agents from ${configuration?.path ? `<code>${esc(configuration.path)}</code>` : 'no agents.json found'}</p><p>this page reads the database read-only</p>` : `<p>${esc(s.officeError ? `Could not read /api/office: ${s.officeError}` : 'Reading coordinator state…')}</p>`}</div>
        <p class="person-instructions-empty">Atlas dispatches each run to an agent's runtime, holds the coordinator lock, and runs the acceptance checks itself. Only those checks can mark work verified.</p></section>`;
    }
    return `<div class="coordinator-quick-settings"><span>Atlas coordinates ${plural(agents().length, 'configured agent')}</span><button type="button" class="person-edit" data-manage-agents>Agents ${icon('arrow', 13)}</button></div>`;
  }

  // -------------------------------------------------------------------------
  // Assign: preview through POST /api/runs/preview, start through POST /api/runs
  // -------------------------------------------------------------------------

  const currentKey = () => `${form.repo.trim()}\u0000${form.agentId}`;

  function agentOptions() {
    const list = agents();
    if (!list.length) return '<option value="">No configured agents</option>';
    return list.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.id)} · ${esc(ADAPTER_NAMES[agent.adapter] || agent.adapter)} · ${esc(agent.policy)}</option>`).join('');
  }

  function errorBlock(error) {
    return `<div class="assign-status tone-failed" role="alert"><strong>${esc(error?.code || 'error')}</strong> · ${esc(error?.message || 'the request failed')}${error?.details?.length ? `<ul>${error.details.map((detail) => `<li>${esc(detail)}</li>`).join('')}</ul>` : ''}</div>`;
  }

  function findingList(items, tone) {
    return items?.length ? `<ul class="evidence-list">${items.map((item) => `<li class="tone-text-${esc(tone)}"><strong>${esc(item.code)}</strong> · ${esc(item.message)}</li>`).join('')}</ul>` : '';
  }

  function renderPreview() {
    const parts = [];
    if (starting) parts.push('<div class="assign-status tone-pending" role="status">Starting <code>workforce run</code> through the coordinator and waiting for it to record the run (up to two minutes). Nothing shows as working until the database says so.</div>');
    if (outcome?.runId) parts.push(`<div class="assign-status tone-pending" role="status">Run <code>${esc(short(outcome.runId, 8))}</code> was recorded by the coordinator${outcome.pid ? ` (pid ${esc(outcome.pid)})` : ''}. ${esc(outcome.agentId)}'s desk follows the database from here.<div class="task-detail-actions"><button type="button" class="task-revise" data-open-run="${esc(outcome.runId)}">Open in Tasks</button></div></div>`);
    if (outcome?.error) parts.push(errorBlock(outcome.error));
    if (state().office && !agents().length) parts.push(`<div class="assign-status tone-warning">No agents are configured, so there is no one to assign a task to. ${esc(state().office?.configuration?.error?.message || 'Add agents to agents.json and reload.')}</div>`);
    if (preview.loading) {
      parts.push('<div class="assign-status tone-pending" role="status">Inspecting the repository and resolving its acceptance checks. Nothing is started.</div>');
    } else if (preview.error) {
      parts.push(errorBlock(preview.error));
    } else if (!preview.result) {
      parts.push('<p class="assign-hint">Preview shows the repository, the agent, the checks the verifier will run, and any write-boundary question, before anything starts.</p>');
    } else {
      const result = preview.result;
      const stale = preview.key !== currentKey();
      const repository = result.repository ?? {};
      const agent = result.agent ?? {};
      const runtime = result.runtime;
      const runtimeLine = runtime ? runtimeStatus(runtime) : null;
      const boundary = result.writeBoundary ?? {};
      const checks = result.checks ?? {};
      parts.push(`<section class="assign-preview${stale ? ' is-stale' : ''}" aria-label="Run preview">
        ${stale ? '<p class="tone-text-warning"><strong>The repository or agent changed.</strong> Preview again before starting.</p>' : ''}
        <span class="sidebar-small-label">REPOSITORY</span>
        <p><code>${esc(repository.root)}</code></p>
        <p>base <code>${esc(short(repository.headRevision))}</code> on ${esc(repository.branch || 'a detached HEAD')} · working tree ${esc(repository.workingTree)}</p>
        <p class="assign-note">${esc(repository.note)}</p>
        <span class="sidebar-small-label">AGENT</span>
        <p><strong>${esc(agent.id)}</strong> · ${esc(ADAPTER_NAMES[agent.adapter] || agent.adapter)} · ${esc(agent.model || 'runtime default model')} · ${esc(agent.policy)} profile</p>
        ${runtimeLine ? `<p class="tone-text-${esc(runtimeLine.tone === 'ready' ? 'active' : runtimeLine.tone)}">${esc(runtime.displayName)} ${esc(runtime.version || '')} · ${esc(runtimeLine.label)}${runtimeLine.tone !== 'ready' && runtimeLine.detail ? ` · ${esc(runtimeLine.detail)}` : ''} <span class="evidence-muted">(passive discovery)</span></p>` : agent.adapter === 'fake' ? '<p class="assign-note">Fake test runtime: not probed by discovery.</p>' : ''}
        ${findingList(result.warnings, 'warning')}
        <span class="sidebar-small-label">ACCEPTANCE CHECKS · EXECUTED BY THE VERIFIER</span>
        ${checks.detail ? `<p class="assign-note">${esc(checks.detail)}</p>` : ''}
        ${checks.criteria?.length ? `<ul class="evidence-list">${checks.criteria.map((criterion) => `<li><div class="evidence-row"><code>${esc([criterion.command, ...(criterion.args || [])].join(' '))}</code><span class="evidence-muted">${esc(criterion.criterionId)}${criterion.required ? '' : ' · optional'}</span></div>${criterion.description ? `<span class="evidence-muted">${esc(criterion.description)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${findingList(result.blockers, 'failed')}
        <span class="sidebar-small-label">WRITE BOUNDARY</span>
        ${boundary.requiresAllowUnconfinedWrites
          ? `<div class="consent-box"><p><strong>${boundary.unconfinedWrites ? 'This runtime has no enforced write boundary.' : 'This runtime’s write boundary was not established for the installed version.'}</strong> ${esc(boundary.explanation || '')}</p><label class="consent" for="assign-consent"><input type="checkbox" id="assign-consent" ${consent ? 'checked' : ''} /><span>Allow unconfined writes for this run (<code>--allow-unconfined-writes</code>). The run manifest records it.</span></label></div>`
          : boundary.writes
            ? `<p>write containment ${esc(boundary.status)}${boundary.installedVersion ? ` for ${esc(boundary.installedVersion)}` : ''} · no extra consent needed</p>`
            : '<p>Read-only profile · this agent does not change files</p>'}
      </section>`);
    }
    return parts.join('');
  }

  function startCheck() {
    if (starting) return { ok: false, reason: 'Starting…' };
    if (!agents().length) return { ok: false, reason: 'No configured agents' };
    if (!preview.result || preview.key !== currentKey()) return { ok: false, reason: 'Preview the run first' };
    if (preview.result.blockers?.length) return { ok: false, reason: 'The coordinator would refuse this run' };
    if (preview.result.writeBoundary?.requiresAllowUnconfinedWrites && !consent) return { ok: false, reason: 'Answer the write-boundary question' };
    if (!form.task.trim()) return { ok: false, reason: 'Describe the task' };
    return { ok: true, reason: 'Ready · Start run spends a model turn' };
  }

  function updateComposer() {
    const button = composerWrap.querySelector('.composer-send');
    if (!button) return;
    const check = startCheck();
    button.disabled = !check.ok;
    composerWrap.querySelector('[data-start-help]').textContent = check.reason;
    composerWrap.querySelector('[data-composer-scope]').textContent = `${form.agentId || 'no agent'} · ${basename(form.repo.trim()) || 'no repository'}`;
  }

  function buildAssign() {
    form.agentId = defaultAgentId();
    scroll.innerHTML = `<div data-region="selection"></div>
      <div class="panel-section-heading"><div><h2>Assign a task</h2><p>Run by the coordinator, judged by the verifier.</p></div>${icon('send', 20)}</div>
      <form id="assign-form" class="assign-form" novalidate>
        <label class="assign-field" for="assign-repo"><span>REPOSITORY</span><input id="assign-repo" type="text" spellcheck="false" autocomplete="off" placeholder="/absolute/path/to/a/git/repository" value="${esc(form.repo)}" /></label>
        <p class="assign-hint">A Git repository with at least one commit. The run works in its own workspace; your checkout is never modified.</p>
        <label class="assign-field" for="assign-agent"><span>AGENT</span><select id="assign-agent"></select></label>
        <button type="submit" class="person-edit assign-preview-button">${icon('focus', 13)}Preview the run</button>
      </form>
      <div data-region="preview"></div>`;
    composerWrap.hidden = false;
    composerWrap.innerHTML = `<form class="sidebar-composer" id="assign-composer" aria-label="Task for the agent"><label class="sr-only" for="assign-task">Describe the engineering task</label><textarea id="assign-task" rows="2" maxlength="64000" placeholder="Describe the engineering task…">${esc(form.task)}</textarea><div class="composer-bottom"><span class="composer-scope">${icon('center', 13)}<span data-composer-scope></span></span><button class="composer-send" type="submit" aria-label="Start run through the coordinator" title="Start run" disabled>${icon('send', 18)}</button></div></form><div class="composer-help"><span data-start-help></span><span>Start run spends a model turn</span></div>`;
    updateAssign();
  }

  function updateAssign() {
    const selectionRegion = scroll.querySelector('[data-region="selection"]');
    if (selectionRegion) {
      const html = renderSelection();
      if (selectionRegion.dataset.html !== html) { selectionRegion.innerHTML = html; selectionRegion.dataset.html = html; }
    }
    const select = scroll.querySelector('#assign-agent');
    if (select && document.activeElement !== select) {
      const options = agentOptions();
      if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
      if (!agentById(form.agentId)) form.agentId = defaultAgentId();
      select.value = form.agentId;
    }
    const previewRegion = scroll.querySelector('[data-region="preview"]');
    if (previewRegion) {
      const html = renderPreview();
      if (previewRegion.dataset.html !== html) { previewRegion.innerHTML = html; previewRegion.dataset.html = html; }
    }
    updateComposer();
  }

  async function runPreview() {
    const repo = form.repo.trim();
    const key = currentKey();
    outcome = null;
    consent = false;
    if (!repo) {
      preview = { key, loading: false, result: null, error: { code: 'repo_required', message: 'Enter the absolute path of a Git repository.', details: [] } };
      updateAssign();
      return;
    }
    preview = { key, loading: true, result: null, error: null };
    updateAssign();
    let next;
    try {
      next = { key, loading: false, result: await api.preview({ repo, ...(form.agentId ? { agent: form.agentId } : {}) }), error: null };
    } catch (error) {
      next = { key, loading: false, result: null, error: { code: error.code, message: error.message, details: error.details || [] } };
    }
    if (preview.key !== key || !preview.loading) return;
    preview = next;
    if (activeTab === 'assign') updateAssign();
  }

  async function startRun() {
    if (!startCheck().ok) return;
    const agentId = form.agentId;
    const body = {
      repo: form.repo.trim(),
      task: form.task,
      ...(agentId ? { agent: agentId } : {}),
      // Sent only when the preview asked the question and the person answered yes.
      ...(preview.result.writeBoundary?.requiresAllowUnconfinedWrites && consent ? { allowUnconfinedWrites: true } : {}),
    };
    starting = true;
    outcome = null;
    updateAssign();
    try {
      const result = await api.start(body);
      outcome = { runId: result.runId, agentId, pid: result.pid };
      form.task = '';
      consent = false;
      const textarea = composerWrap.querySelector('#assign-task');
      if (textarea) textarea.value = '';
      onStarted({ runId: result.runId, agentId });
    } catch (error) {
      outcome = { error: { code: error.code, message: error.message, details: error.details || [] } };
    } finally {
      starting = false;
      if (activeTab === 'assign') updateAssign();
    }
  }

  // -------------------------------------------------------------------------
  // Tasks: recorded runs and their evidence
  // -------------------------------------------------------------------------

  function fetchDetail(runId) {
    const previous = details.get(runId);
    if (previous?.loading) return;
    const summary = runById(runId);
    details.set(runId, { ...(previous || {}), loading: true });
    api.run(runId)
      .then((status) => details.set(runId, { status, error: null, loading: false, seen: summary ? `${summary.updatedAt}:${summary.eventCount}` : null }))
      .catch((error) => details.set(runId, { ...(details.get(runId) || {}), loading: false, error: { code: error.code, message: error.message, details: error.details || [] } }))
      .finally(() => { if (activeTab === 'tasks') scheduleRender(); });
  }

  function toggleDiff(runId, artifactId) {
    const existing = diffs.get(artifactId);
    if (existing && !existing.loading && !existing.error) {
      diffs.set(artifactId, { ...existing, open: !existing.open });
      render();
      return;
    }
    diffs.set(artifactId, { open: true, loading: true });
    render();
    api.artifact(runId, artifactId)
      .then((document) => diffs.set(artifactId, { open: true, loading: false, text: document.text, redacted: document.redacted }))
      .catch((error) => diffs.set(artifactId, { open: true, loading: false, error: { code: error.code, message: error.message, details: error.details || [] } }))
      .finally(() => { if (activeTab === 'tasks') render(); });
  }

  function renderDiff(diff) {
    if (diff.loading) return '<p class="evidence-muted">Reading candidate.patch (hash-verified on the server)…</p>';
    if (diff.error) return errorBlock(diff.error);
    return `${diff.redacted ? '<p class="tone-text-warning">Secrets were redacted from this diff before it reached the page.</p>' : ''}<pre class="diff-view" tabindex="0" aria-label="Candidate diff">${diffLines(diff.text).map((line) => `<span class="diff-${line.kind}">${esc(line.text) || ' '}</span>`).join('')}</pre>`;
  }

  function renderRunDetail(run) {
    const entry = details.get(run.id);
    const id = `details-${esc(run.id)}`;
    if (!entry?.status) return `<div class="task-details" id="${id}">${entry?.error ? errorBlock(entry.error) : '<p>Reading <code>workforce status</code> for this run…</p>'}</div>`;
    const status = entry.status;
    const verdict = acceptanceView(status, coordinatorLock());
    const requirements = requirementViews(status);
    // Each receipt is read with the requirements and the run summary, which say when the candidate compromised it.
    const checks = (status.checks || []).map((check) => checkView(check, status, run));
    const candidate = status.candidate;
    const changed = candidate?.changedFiles || [];
    const diff = candidate?.patchArtifactId ? diffs.get(candidate.patchArtifactId) : null;
    const unresolved = Array.isArray(status.unresolved) ? status.unresolved : [];
    return `<div class="task-details" id="${id}">
      <div class="evidence-block"><span class="sidebar-small-label">VERDICT</span><p class="evidence-verdict tone-${esc(verdict.tone)}">${verdict.tone === 'verified' ? icon('check', 12) : ''}${esc(verdict.text)}</p>${entry.error ? `<p class="tone-text-warning">Last refresh failed: ${esc(entry.error.message)}</p>` : ''}</div>
      <div class="evidence-block"><span class="sidebar-small-label">REQUIREMENTS</span>${requirements.length ? `<ul class="evidence-list">${requirements.map((requirement) => `<li><div class="evidence-row"><strong>${esc(requirement.criterionId)}</strong><span class="evidence-tag tone-text-${esc(requirement.tone)}">${esc(requirement.label)}</span></div>${requirement.description ? `<span>${esc(requirement.description)}</span><br>` : ''}<span class="evidence-muted">${esc(requirement.detail || '')}${requirement.required === false ? ' · optional' : ''}</span></li>`).join('')}</ul>` : '<p class="evidence-muted">No requirement results recorded yet.</p>'}</div>
      <div class="evidence-block"><span class="sidebar-small-label">CHECK RECEIPTS</span>${checks.length ? `<ul class="evidence-list">${checks.map((check) => `<li><div class="evidence-row"><code>${esc(check.command)}</code><span class="evidence-tag tone-text-${esc(check.tone)}">${esc(check.outcome)}${check.exitCode === null || check.exitCode === undefined ? '' : ` · exit ${esc(check.exitCode)}`}${check.compromised ? ' · compromised' : ''}</span></div><span class="evidence-muted">${check.compromised ? 'executed by the verifier, but the candidate changed the files this check runs, so its pass does not establish the criterion' : check.verifier ? 'executed by the verifier' : `provenance ${esc(check.evidenceProvenance)} · not verifier evidence`} · ${esc((check.criterionIds || []).join(', '))} · candidate ${esc(short(check.candidateRevision))}</span></li>`).join('')}</ul>` : '<p class="evidence-muted">No check receipts recorded yet.</p>'}</div>
      <div class="evidence-block"><span class="sidebar-small-label">CANDIDATE</span>${candidate ? `<p>branch <code>${esc(candidate.branch)}</code></p><p>revision <code>${esc(short(candidate.revision))}</code> · ${plural(changed.length, 'changed file')}</p>${changed.length ? `<ul class="evidence-list">${changed.map((file) => `<li><code>${esc(file.status)}</code> ${esc(file.path)}</li>`).join('')}</ul>` : ''}${candidate.patchArtifactId ? `<div class="task-detail-actions"><button type="button" class="task-revise" data-diff="${esc(candidate.patchArtifactId)}" data-run-id="${esc(run.id)}" aria-expanded="${Boolean(diff?.open)}">${diff?.open ? 'Hide diff' : 'Show diff'}</button></div>` : ''}${diff?.open ? renderDiff(diff) : ''}` : '<p class="evidence-muted">No candidate recorded yet.</p>'}</div>
      <div class="evidence-block"><span class="sidebar-small-label">UNRESOLVED</span>${unresolved.length ? `<ul class="evidence-list">${unresolved.map((item) => `<li class="tone-text-warning">${esc(item)}</li>`).join('')}</ul>` : '<p class="evidence-muted">Nothing unresolved recorded.</p>'}</div>
      <div class="evidence-block"><span class="sidebar-small-label">TASKS</span><ul class="evidence-list">${(status.tasks || []).map((task) => `<li><div class="evidence-row"><span>${esc(task.objective)}</span><span class="evidence-tag">${esc(task.state)}${task.waitReason ? ` · ${esc(task.waitReason)}` : ''}</span></div>${task.ownerAgentId ? `<button type="button" class="task-link" data-focus="employee" data-id="agent:${esc(task.ownerAgentId)}">${esc(task.ownerAgentId)}</button>` : ''}</li>`).join('')}</ul></div>
      <div class="evidence-block"><span class="sidebar-small-label">LAST RECORDED EVENTS · ${esc(status.eventCount)} IN TOTAL</span><ul class="evidence-list">${(status.events || []).slice().reverse().map((event) => `<li><div class="evidence-row"><span>${esc(describeEvent({ type: event.type }))}</span><span class="evidence-muted">#${esc(event.sequence)}</span></div></li>`).join('')}</ul></div>
      <small>The same document as <code>workforce status ${esc(run.id)} --json</code>. Workforce records no delivery decision yet: review the candidate branch in your repository.</small>
    </div>`;
  }

  function renderRun(run) {
    const expanded = expandedRun === run.id;
    const lock = coordinatorLock();
    const tone = runTone(run, lock);
    const steps = phaseSteps(run, lock);
    const owners = [...new Set((run.taskViews || []).map((task) => task.ownerAgentId).filter(Boolean))];
    const created = ago(run.createdAt, Date.now());
    return `<article class="sidebar-task ${expanded ? 'is-expanded' : ''}"><button class="task-summary" data-run="${esc(run.id)}" aria-expanded="${expanded}" aria-controls="details-${esc(run.id)}"><span class="task-state-dot run-dot tone-${esc(tone)}">${tone === 'verified' ? icon('check', 10) : ''}</span><span class="task-summary-content"><span class="task-title">${esc(runTitle(run))}</span><span class="task-byline">${esc(owners.join(', ') || 'no agent yet')} <span>·</span> ${esc(basename(run.repoPath))}${created ? ` <span>·</span> ${esc(created)}` : ''}</span><span class="task-status-label tone-text-${esc(tone)}">${esc(runStatusLine(run, lock))}</span><span class="phase-strip" aria-label="Observed phases: ${esc(steps.map((step) => `${step.name} ${step.status}`).join(', '))}">${steps.map((step) => `<span class="phase phase-${esc(step.status)}">${esc(step.name)}</span>`).join('')}</span></span><span class="task-chevron">${icon('chevron', 14)}</span></button>${expanded ? renderRunDetail(run) : ''}</article>`;
  }

  function renderActivity() {
    const items = state().activity.filter((item) => item.event.type !== 'runtime.raw').slice(-6).reverse();
    return `<div class="sidebar-local-activity"><span class="sidebar-small-label">EVENTS OBSERVED SINCE THIS PAGE OPENED</span>${items.length ? items.map((item) => `<p><i></i><span>${esc(item.text)} <span class="evidence-muted">· run ${esc(short(item.event.runId, 8))}</span></span></p>`).join('') : '<p class="evidence-muted">None yet. Each run above carries its own recorded history.</p>'}</div>`;
  }

  function renderTasks() {
    const top = scroll.scrollTop;
    const s = state();
    const ids = scopedAgentIds();
    const runs = s.runs.filter((run) => ids === null || (run.taskViews || []).some((task) => ids.includes(task.ownerAgentId)));
    const lock = coordinatorLock();
    const counts = { all: runs.length, review: 0, running: 0, stalled: 0, failed: 0, accepted: 0 };
    for (const run of runs) counts[runGroup(run, lock)] += 1;
    const filtered = runs.filter((run) => taskFilter === 'all' || runGroup(run, lock) === taskFilter).sort((a, b) => GROUP_ORDER[runGroup(a, lock)] - GROUP_ORDER[runGroup(b, lock)]);
    let empty;
    if (!s.runsLoaded) empty = s.runsError ? `Could not read /api/runs: ${s.runsError}` : 'Reading recorded runs…';
    else if (taskFilter === 'accepted') empty = 'Workforce does not record a human delivery decision yet, so no run is shown as accepted. Candidates the verifier accepted wait under Needs review, with their evidence.';
    else if (!runs.length) empty = s.stateFound === false ? 'There is no state store yet. The first run creates it.' : ids === null ? 'No runs recorded yet.' : 'No runs recorded for this selection.';
    else empty = 'No runs in this group.';
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Runs</h2><p>As the coordinator recorded them: observed phases, no percentages.</p></div><span class="sample-pill stream-${esc(s.stream)}">${esc(STREAM_LABELS[s.stream] || 'OFFLINE')}</span></div>
      <div class="task-filter-row" aria-label="Filter runs">${[['all', 'All'], ['review', 'Review'], ['running', 'Running'], ['stalled', 'Stalled'], ['failed', 'Failed'], ['accepted', 'Accepted']].map(([id, label]) => `<button class="task-filter ${taskFilter === id ? 'is-active' : ''}" data-task-filter="${id}" aria-pressed="${taskFilter === id}">${label}<span>${counts[id]}</span></button>`).join('')}</div>
      ${counts.review && taskFilter === 'all' ? `<p class="task-review-notice"><i></i>${counts.review} ${counts.review === 1 ? 'run needs' : 'runs need'} your review</p>` : ''}
      <div class="sidebar-task-list">${filtered.length ? filtered.map(renderRun).join('') : `<div class="sidebar-empty"><span>${taskFilter === 'accepted' ? 'Not recorded yet.' : 'Nothing here.'}</span><p>${esc(empty)}</p></div>`}</div>
      ${renderActivity()}`;
    composerWrap.hidden = true;
    scroll.scrollTop = top;
  }

  // -------------------------------------------------------------------------
  // Connections: passive runtime discovery and the agent configuration
  // -------------------------------------------------------------------------

  function renderRuntime(report) {
    const status = runtimeStatus(report);
    const users = agents().filter((agent) => agent.adapter === report.adapter);
    const expanded = expandedRuntime === report.adapter;
    const tone = status.tone === 'ready' ? 'active' : status.tone;
    return `<article class="runtime-item ${expanded ? 'is-expanded' : ''}"><button class="runtime-summary" data-runtime="${esc(report.adapter)}" aria-expanded="${expanded}" aria-controls="runtime-details-${esc(report.adapter)}"><span class="runtime-monogram">${esc(initials(report.displayName).slice(0, 2))}</span><span class="runtime-main"><strong>${esc(report.displayName)}</strong><span>${esc(report.version ? 'version ' + report.version : 'version unknown')}</span></span><span class="runtime-demo tone-text-${esc(tone)}">${esc(status.label)}</span><span class="task-chevron">${icon('chevron', 14)}</span></button>
      <div class="runtime-assignment-preview">${users.length ? users.map((agent) => `<button data-focus="employee" data-id="agent:${esc(agent.id)}">${esc(agent.id)}</button>`).join('') : '<span>No configured agent uses it</span>'}</div>
      ${expanded ? `<div class="runtime-details" id="runtime-details-${esc(report.adapter)}"><dl>
        <div><dt>Installed</dt><dd>${report.installed ? 'yes' : 'no'}</dd></div>
        <div><dt>Executable</dt><dd>${esc(report.executable || 'not found')}</dd></div>
        <div><dt>Version</dt><dd>${esc(report.version || 'unknown')}</dd></div>
        <div><dt>Sign-in</dt><dd>${esc(report.auth)} · ${esc(report.authDetail)}</dd></div>
        <div><dt>Readiness</dt><dd>${esc(report.readiness)} · ${esc(report.probeKind)} probe</dd></div>
        <div><dt>Controllable</dt><dd>${report.controllable ? 'yes' : 'no'}</dd></div>
        <div><dt>Writing mode</dt><dd>${report.writingModeAvailable ? 'available with a write boundary' : `needs explicit consent${report.missingWriteBoundary?.length ? ` · missing ${esc(report.missingWriteBoundary.join(', '))}` : ''}`}</dd></div>
        <div><dt>Checked</dt><dd>${esc(report.checkedAt)}</dd></div>
      </dl>${report.auth === 'logged_out' && report.loginHint ? `<p class="tone-text-failed">Signed out. Run <code>${esc(report.loginHint)}</code> in a terminal, then check again.</p>` : ''}${report.diagnostics?.length ? `<ul class="evidence-list">${report.diagnostics.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}</div>` : ''}</article>`;
  }

  function renderConfiguration(configuration) {
    if (!configuration) return '';
    if (!configuration.found) return `<div class="evidence-block config-block"><span class="sidebar-small-label">AGENT CONFIGURATION</span><p class="tone-text-warning">No agents.json was found. Searched:</p><ul class="evidence-list">${(configuration.searched || []).map((file) => `<li><code>${esc(file)}</code></li>`).join('')}</ul></div>`;
    if (configuration.error) return `<div class="evidence-block config-block"><span class="sidebar-small-label">AGENT CONFIGURATION · INVALID</span><p class="tone-text-failed"><code>${esc(configuration.path)}</code> · ${esc(configuration.error.message)}</p><ul class="evidence-list">${(configuration.error.issues || []).map((issue) => `<li>${esc(issue.path)}: ${esc(issue.message)}</li>`).join('')}</ul></div>`;
    return `<div class="evidence-block config-block"><span class="sidebar-small-label">AGENT CONFIGURATION · READ-ONLY</span><p><code>${esc(configuration.path)}</code> · ${esc(configuration.source)}</p></div>`;
  }

  function renderConnections() {
    const s = state();
    const office = s.office;
    const runtimes = office?.runtimes;
    const reports = runtimes?.reports || [];
    const ids = scopedAgentIds();
    const scopedAgents = ids === null ? agents() : agents().filter((agent) => ids.includes(agent.id));
    const adapters = new Set(scopedAgents.map((agent) => agent.adapter));
    const shown = ids === null ? reports : reports.filter((report) => adapters.has(report.adapter));
    const unprobed = scopedAgents.filter((agent) => !reports.some((report) => report.adapter === agent.adapter));
    const explainer = !office
      ? s.officeError ? `Could not read /api/office: ${s.officeError}` : 'Running passive discovery…'
      : runtimes?.error
        ? runtimes.error
        : `Passive discovery ran each runtime's version and sign-in status commands${runtimes?.checkedAt ? ` at ${new Date(runtimes.checkedAt).toLocaleTimeString()}` : ''}. It never opens a session or starts a model turn.`;
    scroll.innerHTML = `${renderSelection()}<div class="panel-section-heading"><div><h2>Behind the office</h2><p>Runtimes, as passive discovery sees them.</p></div>${icon('link', 20)}</div>
      <div class="connection-overview"><span class="connection-overview-mark">${icon('center', 20)}</span><div><strong>Atlas · Control center</strong><p>Dispatches each run to its agent's runtime</p></div><span class="connection-overview-line"></span><span class="connection-overview-count">${shown.length}<small>RUNTIMES</small></span></div>
      <p class="connection-explainer">${esc(explainer)}</p>
      <div class="connection-actions"><button type="button" class="person-edit" data-refresh-runtimes>${icon('refresh', 13)}Check again</button></div>
      <div class="connection-list">${shown.length ? shown.map(renderRuntime).join('') : `<div class="sidebar-empty"><span>No runtime reported.</span><p>${ids === null ? 'Passive discovery reported no supported runtime.' : 'No discovered runtime is bound to this selection.'}</p></div>`}${unprobed.length ? `<article class="runtime-item"><div class="runtime-summary"><span class="runtime-monogram">–</span><span class="runtime-main"><strong>Not probed by discovery</strong><span>${esc(unprobed.map((agent) => agent.id + ' (' + (ADAPTER_NAMES[agent.adapter] || agent.adapter) + ')').join(', '))}</span></span></div></article>` : ''}</div>
      ${renderConfiguration(office?.configuration)}
      <div class="connection-route-note">${icon('sparkle', 16)}<p>Your task → control center → agent runtime → verifier.<br><span>Canvas pulses appear only for recorded coordination events.</span></p></div>`;
    composerWrap.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Rendering and public API
  // -------------------------------------------------------------------------

  function scheduleRender() {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150);
  }

  function render({ resetScroll = false } = {}) {
    if (destroyed) return;
    const s = state();
    streamLabel.textContent = STREAM_LABELS[s.stream] || 'OFFLINE';
    streamLabel.className = `sidebar-demo-label stream-${s.stream}`;
    element.querySelector('.sidebar-agent-count').textContent = String(agents().length);
    const options = contextOptions();
    if (contextSelect.dataset.options !== options && document.activeElement !== contextSelect) { contextSelect.innerHTML = options; contextSelect.dataset.options = options; }
    contextSelect.value = selection.type === 'office' || selection.type === 'control' ? 'office' : `${selection.type}:${selection.id}`;
    if (contextSelect.selectedIndex === -1) contextSelect.value = 'office';
    element.querySelectorAll('.sidebar-tab').forEach((tab) => {
      const isActive = tab.dataset.tab === activeTab;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });
    element.querySelector('.tab-task-count').textContent = String(s.runs.filter((run) => runGroup(run) === 'review').length);
    scroll.setAttribute('aria-labelledby', `office-tab-${activeTab}`);
    if (activeTab === 'tasks') renderTasks();
    else if (activeTab === 'connections') renderConnections();
    else if (!scroll.querySelector('#assign-form')) buildAssign();
    else updateAssign();
    if (resetScroll) scroll.scrollTop = 0;
  }

  function refresh() {
    if (destroyed) return;
    if (selection.type === 'employee' && !employeeById(selection.id)) selection = { type: 'office' };
    if (expandedRun) {
      const summary = runById(expandedRun);
      const key = summary ? `${summary.updatedAt}:${summary.eventCount}` : null;
      if (details.get(expandedRun)?.seen !== key) fetchDetail(expandedRun);
    }
    render();
  }

  function select(nextSelection) {
    const next = nextSelection || { type: 'office' };
    if ((next.type === 'employee' && !employeeById(next.id)) || (next.type === 'department' && !departmentById(next.id))) return;
    selection = { type: next.type || 'office', ...(next.id ? { id: next.id } : {}) };
    const agentId = selection.type === 'employee' ? employeeById(selection.id)?.agentId : null;
    if (agentId) form.agentId = agentId;
    render({ resetScroll: true });
  }

  function showTab(tab) {
    if (!TABS.includes(tab)) return;
    activeTab = tab;
    render({ resetScroll: true });
  }

  function openRun(runId) {
    taskFilter = 'all';
    expandedRun = runId;
    fetchDetail(runId);
    showTab('tasks');
  }

  function showRuntime(adapter) {
    selection = { type: 'control' };
    onFocus(selection);
    activeTab = 'connections';
    expandedRuntime = adapter;
    render();
    requestAnimationFrame(() => {
      const target = [...scroll.querySelectorAll('.runtime-summary')].find((button) => button.dataset.runtime === adapter);
      target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  element.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    if (button.hasAttribute('data-manage-agents')) onManageAgents();
    else if (button.hasAttribute('data-add-agent')) onAddAgent();
    else if (button.dataset.showAgent) onShowAgent(button.dataset.showAgent);
    else if (button.dataset.assignAgent) { form.agentId = button.dataset.assignAgent; showTab('assign'); scroll.querySelector('#assign-repo')?.focus(); }
    else if (button.dataset.openRun) openRun(button.dataset.openRun);
    else if (button.dataset.focusExtra) { const next = { type: 'department', id: button.dataset.focusExtra, extra: true }; select(next); onFocus(next); }
    else if (button.dataset.tab) showTab(button.dataset.tab);
    else if (button.classList.contains('context-focus')) onFocus(selection);
    else if (button.dataset.taskFilter) { taskFilter = button.dataset.taskFilter; render(); }
    else if (button.dataset.diff) toggleDiff(button.dataset.runId, button.dataset.diff);
    else if (button.dataset.run) {
      expandedRun = expandedRun === button.dataset.run ? null : button.dataset.run;
      if (expandedRun && !details.get(expandedRun)?.status) fetchDetail(expandedRun);
      render();
    } else if (button.hasAttribute('data-refresh-runtimes')) onRefreshRuntimes();
    else if (button.hasAttribute('data-runtime')) {
      if (activeTab !== 'connections') showRuntime(button.dataset.runtime);
      else { expandedRuntime = expandedRuntime === button.dataset.runtime ? null : button.dataset.runtime; render(); }
    } else if (button.dataset.focus) {
      const next = { type: button.dataset.focus, id: button.dataset.id };
      select(next);
      onFocus(next);
    }
  });

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id === 'assign-form') runPreview();
    else if (event.target.id === 'assign-composer') startRun();
  });

  element.addEventListener('input', (event) => {
    const target = event.target;
    if (target.id === 'assign-repo') {
      form.repo = target.value;
      storeRepo(target.value);
      updateAssign();
    } else if (target.id === 'assign-task') {
      form.task = target.value;
      target.style.height = 'auto';
      target.style.height = `${Math.min(target.scrollHeight, 132)}px`;
      updateComposer();
    }
  });

  element.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'assign-agent') {
      form.agentId = target.value;
      updateAssign();
    } else if (target.id === 'assign-consent') {
      consent = target.checked;
      updateComposer();
    } else if (target.id === 'office-context-select') {
      const value = target.value;
      const colon = value.indexOf(':');
      const next = colon === -1 ? { type: value } : { type: value.slice(0, colon), id: value.slice(colon + 1) };
      select(next);
      onFocus(next);
    }
  });

  element.querySelector('.sidebar-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.indexOf(activeTab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    showTab(TABS[nextIndex]);
    element.querySelector(`[data-tab="${activeTab}"]`).focus();
  });

  render();
  return {
    select,
    showTab,
    showTasks(filter = 'all') { taskFilter = ['all', 'review', 'running', 'stalled', 'failed', 'accepted'].includes(filter) ? filter : 'all'; showTab('tasks'); },
    showRuntime,
    assignTo(agentId) { form.agentId = agentId; showTab('assign'); },
    refresh,
    onEvent(event) {
      if (event?.runId && event.runId === expandedRun) {
        clearTimeout(detailTimer);
        detailTimer = setTimeout(() => { if (expandedRun) fetchDetail(expandedRun); }, 900);
      }
      if (activeTab === 'tasks' && event?.type !== 'runtime.raw') scheduleRender();
    },
    destroy() { destroyed = true; element.replaceChildren(); },
  };
}
