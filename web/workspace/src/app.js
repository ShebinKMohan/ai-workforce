/**
 * The page: hash router, document loading, live updates and actions.
 *
 * Everything shown is re-read from the server: the workspace, the runs across
 * projects, the request queue, and for a task page its status document and
 * every event. A change arrives as an event on /api/events (or, for the queue,
 * on a short poll); the page then re-reads the documents and patches only the
 * blocks whose inputs changed, never a block that holds keyboard focus.
 *
 * Every write is a POST the server checks (Origin, session token, JSON) and
 * that reaches the engine only through the workspace operations or a spawned
 * `workforce run` / `workforce resume`. Reloading the page changes nothing.
 */
import { api, subscribeEvents } from './api.js';
import { applyPatch, esc, keyed } from './render.js';
import {
  draftOps,
  editDepartmentDraft,
  entryFromStatus,
  findEntry,
  indexWorkspace,
  needsYouList,
  newDepartmentDraft,
  pairSendable,
  setupModel,
  taskDetailModel,
  taskEntries,
} from './model.js';
import { navSection, parseRoute, routeKey, routeTitle } from './routes.js';
import { renderHome } from './pages/home.js';
import { OFFICE_TABS, renderOffice } from './pages/office.js';
import { activateOffice, destroyOffice } from './office/spatial.js';
import { renderTasks } from './pages/tasks.js';
import { renderTask } from './pages/task.js';
import { renderProject, renderProjects } from './pages/projects.js';
import { renderDepartmentEditor, renderDepartments } from './pages/departments.js';
import { LIMIT_FIELDS, renderSettings } from './pages/settings.js';
import { formatTime } from './pages/common.js';
import { renderNewTaskSheet, sheetDefaults } from './sheets/new-task.js';
import { addProjectDefaults, renderAddProjectSheet } from './sheets/add-project.js';
import { ERRORS } from './words.js';

// ---- browser-only conveniences (never records) ------------------------------------
const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: the convenience is lost, nothing else
    }
  },
};

const state = {
  workspaceDoc: null,
  runsDoc: null,
  requestsDoc: null,
  loaded: false,
  loadError: null,
  lastTried: null,
  lastWorkspaceRead: 0,
  stream: { handle: null, status: null, lostAt: null },
  route: parseRoute(location.hash),
  renderedRoute: null,
  ui: {
    expanded: new Set(),
    hidden: new Set(storage.get('workforce.hidden', [])),
    readyHidden: storage.get('workforce.readyHidden', false),
    taskFilter: 'all',
    sheet: null,
    sheetOpener: null,
    drafts: new Map(),
    editorError: null,
    saving: false,
    task: null,
    projectForms: new Map(),
    confirm: null,
    actionError: null,
    notice: null,
    limitsDraft: null,
    resumeConsent: null,
    officeTab: 'assign',
    officeDraft: '',
    officeDepartmentId: '',
  },
  announce: { taskKey: null, signature: null, needs: null, last: 0, timer: null },
};

const $ = (selector) => document.querySelector(selector);

// ---- the view ------------------------------------------------------------------------
function context() {
  const ws = indexWorkspace(state.workspaceDoc);
  const entries = taskEntries(ws, state.runsDoc, state.requestsDoc);
  const setup = setupModel(ws, state.requestsDoc, state.runsDoc);
  const needs = needsYouList(ws, entries, state.ui.hidden);
  const ctx = { ws, entries, setup, needs, runsDoc: state.runsDoc, requestsDoc: state.requestsDoc, ui: state.ui, route: state.route, now: Date.now() };
  ctx.taskView = state.route.name === 'task' ? taskView(ctx) : null;
  return ctx;
}

function taskView(ctx) {
  const task = state.ui.task?.key === routeKey(state.route) ? state.ui.task : null;
  let entry = findEntry(ctx.entries, state.route);
  if (!entry && task?.status && state.route.projectId) {
    const lock = state.runsDoc?.projects?.find((project) => project.projectId === state.route.projectId)?.coordinator?.lock ?? null;
    entry = entryFromStatus(ctx.ws, state.route.projectId, task.status, lock);
  }
  if (!entry) return { loading: !task || task.loading, error: task?.error ?? null, detail: null };
  const detail = taskDetailModel({ ws: ctx.ws, entry, status: task?.status ?? null, events: task?.events ?? [], now: ctx.now });
  return { entry, detail, status: task?.status ?? null, events: task?.events ?? [], loading: task?.loading ?? false, error: task?.error ?? null };
}

function unreachableHtml() {
  const tried = state.lastTried ? formatTime(new Date(state.lastTried).toISOString()) : '';
  return keyed('section', 'unreachable', 'class="section"', `<h1 tabindex="-1">Workforce is not answering</h1><p class="lede">${esc(ERRORS.unreachable)}</p><p class="muted">${tried ? `Last tried ${esc(tried)}. ` : ''}Trying again every 5 seconds.</p><button type="button" class="button" data-action="reload-all">Try again</button>`);
}

function pageHtml(ctx) {
  if (!state.loaded) return state.loadError ? unreachableHtml() : '<p class="muted loading">Reading your workspace…</p>';
  switch (state.route.name) {
    case 'office':
      return renderOffice(ctx);
    case 'tasks':
      return renderTasks(ctx);
    case 'task':
      return renderTask(ctx);
    case 'projects':
      return renderProjects(ctx);
    case 'project':
      return renderProject(ctx);
    case 'departments':
      return renderDepartments(ctx);
    case 'department':
      return renderDepartmentEditor(ctx);
    case 'settings':
      return renderSettings(ctx);
    default:
      return renderHome(ctx);
  }
}

function navHtml(ctx) {
  const { ws, entries, setup } = ctx;
  const section = navSection(state.route);
  const link = (id, href, label, sub = '', count = '') =>
    keyed('a', `nav:${id}`, `href="${href}"${section === id ? ' aria-current="page"' : ''}`, `<span>${esc(label)}${sub ? `<span class="nav-sub">${esc(sub)}</span>` : ''}</span>${count ? `<span class="nav-count">${esc(count)}</span>` : ''}`);
  const items = [link('home', '#/home', 'Home', state.loaded && setup.showChecklist && setup.stepNumber ? `Setup: step ${setup.stepNumber} of 4` : '')];
  if (state.loaded) {
    items.push(link('office', '#/office', 'Office'));
    const moving = entries.filter((entry) => entry.inMotion).length;
    if (entries.length) items.push(link('tasks', '#/tasks', 'Tasks', '', moving ? `${moving} in motion` : ''));
    if (ws.liveProjects.length) items.push(link('projects', '#/projects', 'Projects', '', String(ws.liveProjects.length)));
    if (ws.liveDepartments.length) items.push(link('departments', '#/departments', 'Departments', '', String(ws.liveDepartments.length)));
  }
  items.push(keyed('div', 'nav:bottom', 'class="nav-bottom"', link('settings', '#/settings', 'Settings')));
  return items.join('');
}

let lastBanner = '';
function renderChrome(ctx) {
  document.body.classList.toggle('office-shell', state.route.name === 'office');
  applyPatch($('#nav'), navHtml(ctx));
  $('#office-count').innerHTML = state.loaded ? `<span class="ao-header-divider"></span><strong>${ctx.ws.liveAgents.length}</strong> configured ${ctx.ws.liveAgents.length === 1 ? 'agent' : 'agents'} <span>· ${ctx.ws.liveDepartments.length} ${ctx.ws.liveDepartments.length === 1 ? 'department' : 'departments'}</span>` : '';
  $('#office-agent-count').textContent = String(ctx.ws.liveAgents.length);
  const needs = $('#needs-count');
  const count = ctx.needs.items.length;
  needs.hidden = !state.loaded || count === 0;
  const needsHtml = `<strong>${count}</strong> <span>${count === 1 ? 'needs' : 'need'} you</span>`;
  if (needs.dataset.html !== needsHtml) {
    needs.innerHTML = needsHtml;
    needs.dataset.html = needsHtml;
    needs.setAttribute('aria-label', `${count} ${count === 1 ? 'item needs' : 'items need'} you`);
  }
  $('#new-task').hidden = !state.loaded || !ctx.ws.ok || ctx.setup.showChecklist || !ctx.setup.allDone;

  const parts = [];
  if (state.loaded && state.loadError?.status === 0) parts.push(`<div class="banner banner-failed" role="alert"><span>${esc(ERRORS.unreachable)}</span><button type="button" class="button button-small" data-action="reload-all">Try again</button></div>`);
  else if (state.stream.status === 'lost') parts.push(`<div class="banner" role="status"><span>Live updates stopped${state.stream.lostAt ? ` at ${esc(formatTime(new Date(state.stream.lostAt).toISOString()))}` : ''}. What you see may be out of date. Reconnecting…</span><button type="button" class="button button-small" data-action="reload-page">Reload now</button></div>`);
  if (state.requestsDoc && state.requestsDoc.accepting === false) parts.push(`<div class="banner"><span>${esc(state.requestsDoc.managedElsewhere ?? ERRORS.queueElsewhere)}</span></div>`);
  const banner = parts.join('');
  if (banner !== lastBanner) {
    $('#banner').innerHTML = banner;
    lastBanner = banner;
  }
}

/** An element's identity across a re-render, for giving focus back. */
function focusSignature(element) {
  if (!element || element === document.body) return null;
  if (element.id) return { id: element.id };
  const attributes = ['data-action', 'data-toggle', 'data-id', 'data-index', 'data-project', 'data-sheet', 'data-confirm'];
  if (!element.hasAttribute('data-action')) return null;
  return { selector: attributes.map((name) => (element.hasAttribute(name) ? `[${name}="${CSS.escape(element.getAttribute(name))}"]` : '')).join('') };
}

function replacePreservingFocus(container, html) {
  const active = document.activeElement;
  const inside = active && container.contains(active);
  const signature = inside ? focusSignature(active) : null;
  const selection = inside && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = window.scrollY;
  container.innerHTML = html;
  if (signature) {
    const next = signature.id ? document.getElementById(signature.id) : container.querySelector(signature.selector);
    if (next) {
      next.focus({ preventScroll: true });
      if (selection && typeof next.setSelectionRange === 'function') {
        try {
          next.setSelectionRange(selection[0], selection[1]);
        } catch {
          // not a text control
        }
      }
    }
  }
  window.scrollTo(0, scroll);
}

let focusoutPending = false;
function render({ force = false, focus = null } = {}) {
  const ctx = context();
  renderChrome(ctx);
  const page = $('#page');
  const key = `${routeKey(state.route)}${state.loaded ? '' : ':loading'}${state.loaded && !state.loadError ? '' : ':error'}`;
  const html = pageHtml(ctx);
  if (state.renderedRoute !== key) {
    const firstLoad = state.renderedRoute === null || state.renderedRoute.endsWith(':loading') || state.renderedRoute.endsWith(':error');
    const sameRoute = state.renderedRoute?.startsWith(routeKey(state.route));
    page.innerHTML = html;
    state.renderedRoute = key;
    const title = state.route.name === 'task' && ctx.taskView?.detail ? ctx.taskView.detail.title : routeTitle(state.route);
    document.title = `${title} · Workforce`;
    if (state.loaded && !(firstLoad && sameRoute && state.route.name === 'home' && !location.hash)) {
      if (!sameRoute) window.scrollTo(0, 0);
      page.querySelector('h1')?.focus({ preventScroll: true });
    }
  } else if (force) {
    replacePreservingFocus(page, html);
  } else if (applyPatch(page, html) && !focusoutPending) {
    focusoutPending = true;
    document.addEventListener(
      'focusout',
      () => {
        focusoutPending = false;
        setTimeout(() => render(), 0);
      },
      { once: true },
    );
  }
  if (state.route.name === 'task' && ctx.taskView?.detail) document.title = `${ctx.taskView.detail.title} · Workforce`;
  page.classList.toggle('page-office', state.route.name === 'office');
  if (state.route.name === 'office') activateOffice(page);
  else destroyOffice();
  renderSheet(ctx, force);
  if (focus) document.querySelector(focus)?.focus();
  announce(ctx);
}

let renderedSheet = null;
function renderSheet(ctx, force) {
  const root = $('#sheet-root');
  const sheet = state.ui.sheet;
  if (!sheet) {
    if (renderedSheet !== null) {
      root.innerHTML = '';
      renderedSheet = null;
      const opener = state.ui.sheetOpener;
      state.ui.sheetOpener = null;
      if (opener && document.contains(opener)) opener.focus();
    }
    return;
  }
  const inner = sheet.name === 'new-task' ? renderNewTaskSheet(ctx, sheet) : renderAddProjectSheet(ctx, sheet);
  if (renderedSheet !== sheet.name) {
    root.innerHTML = `<div class="sheet-backdrop" data-action="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">${inner}</div></div>`;
    renderedSheet = sheet.name;
    // The field the person most likely wants: the task text, else the first text field, else the chosen option.
    const first = root.querySelector('.sheet-body textarea:not([disabled])') ?? root.querySelector('.sheet-body input[type="text"]:not([disabled])') ?? root.querySelector('.sheet-body input:not([disabled]):checked');
    (first ?? root.querySelector('.sheet')).focus();
    return;
  }
  const dialog = root.querySelector('.sheet');
  if (force) return replacePreservingFocus(dialog, inner);
  // A data refresh touches only the passive "Before it starts" block, never typed values.
  const template = document.createElement('template');
  template.innerHTML = inner;
  const next = template.content.querySelector('[data-sheet-live]');
  const current = dialog.querySelector('[data-sheet-live]');
  if (next && current && !current.contains(document.activeElement) && current.innerHTML !== next.innerHTML) current.replaceWith(next);
}

function announce(ctx) {
  const messages = [];
  const detail = ctx.taskView?.detail;
  if (detail) {
    const key = ctx.taskView.entry.key;
    if (state.announce.taskKey === key && state.announce.signature && state.announce.signature !== detail.phaseSignature) {
      const now = detail.phases.find((phase) => phase.state === 'now');
      messages.push(`${detail.title}: ${now ? `now at ${now.heading}` : detail.status.word}.`);
    }
    state.announce.taskKey = key;
    state.announce.signature = detail.phaseSignature;
  }
  if (state.loaded) {
    const ids = new Set(ctx.needs.items.map((item) => item.id));
    if (state.announce.needs) for (const item of ctx.needs.items) if (!state.announce.needs.has(item.id)) messages.push(`Needs you: ${item.line}`);
    state.announce.needs = ids;
  }
  if (messages.length === 0) return;
  const text = messages[messages.length - 1];
  clearTimeout(state.announce.timer);
  state.announce.timer = setTimeout(
    () => {
      $('#announcer').textContent = text;
      state.announce.last = Date.now();
    },
    Math.max(0, 2000 - (Date.now() - state.announce.last)),
  );
}

// ---- loading --------------------------------------------------------------------------
async function loadAll({ refreshTools = false } = {}) {
  state.lastTried = Date.now();
  try {
    const [workspace, runs, requests] = await Promise.all([api.workspace(refreshTools), api.runs(), api.requests()]);
    Object.assign(state, { workspaceDoc: workspace, runsDoc: runs, requestsDoc: requests, loadError: null, loaded: true, lastWorkspaceRead: Date.now() });
    if ((!location.hash || location.hash === '#/') && setupModel(indexWorkspace(workspace), requests, runs).allDone) {
      history.replaceState(null, '', '#/office');
      state.route = parseRoute('#/office');
    }
    syncDraft();
    if (state.route.name === 'task') await loadTask();
  } catch (error) {
    state.loadError = error;
  }
  render();
  ensureStream();
  schedulePoll();
}

let refreshing = null;
let refreshAgain = false;
async function refreshLive() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      const [runs, requests] = await Promise.all([api.runs(), api.requests()]);
      state.runsDoc = runs;
      state.requestsDoc = requests;
      state.loadError = null;
      if (state.route.name === 'task') await loadTask();
    } catch (error) {
      if (error.status === 0) state.loadError = error;
    }
    render();
  })();
  await refreshing;
  refreshing = null;
  if (refreshAgain) {
    refreshAgain = false;
    await refreshLive();
  }
}

async function refreshWorkspace(refreshTools = false) {
  try {
    state.workspaceDoc = await api.workspace(refreshTools);
    state.lastWorkspaceRead = Date.now();
    state.loadError = null;
  } catch (error) {
    if (error.status === 0) state.loadError = error;
  }
}

async function loadTask() {
  const route = state.route;
  const ws = indexWorkspace(state.workspaceDoc);
  const entry = findEntry(taskEntries(ws, state.runsDoc, state.requestsDoc), route);
  const projectId = route.projectId ?? entry?.projectId ?? null;
  const runId = route.runId ?? entry?.runId ?? null;
  const key = routeKey(route);
  if (!state.ui.task || state.ui.task.key !== key) state.ui.task = { key, projectId, runId: null, status: null, events: [], lastSequence: 0, loading: true, error: null, diffs: new Map() };
  const task = state.ui.task;
  task.projectId = projectId;
  if (!runId) {
    task.loading = false;
    return;
  }
  if (task.runId !== runId) Object.assign(task, { runId, events: [], lastSequence: 0, status: null });
  try {
    task.status = await api.status(projectId, runId);
    for (;;) {
      const page = await api.eventsPage(projectId, runId, task.lastSequence);
      task.events.push(...page.events);
      if (page.events.length) task.lastSequence = page.events[page.events.length - 1].sequence;
      if (!page.hasMore || page.events.length === 0) break;
    }
    task.error = null;
  } catch (error) {
    task.error = error;
  }
  task.loading = false;
  if (state.ui.expanded.has('changes')) loadDiffs();
}

function loadDiffs() {
  const task = state.ui.task;
  if (!task?.status || !task.runId) return;
  for (const artifact of (task.status.artifacts ?? []).filter((entry) => entry.type === 'candidate_patch')) {
    if (task.diffs.has(artifact.id)) continue;
    task.diffs.set(artifact.id, { loading: true });
    api
      .artifact(task.projectId, task.runId, artifact.id)
      .then(
        (document) => task.diffs.set(artifact.id, { text: document.text }),
        (error) => task.diffs.set(artifact.id, { error }),
      )
      .then(() => render());
  }
}

let pollTimer = null;
function busy() {
  const items = state.requestsDoc?.items ?? [];
  return items.some((item) => ['queued', 'starting', 'running'].includes(item.state)) || (state.runsDoc?.runs ?? []).some((run) => ['pending', 'running', 'waiting'].includes(run.state));
}
function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = !state.loaded || state.loadError ? 5000 : busy() ? 2500 : 10000;
  pollTimer = setTimeout(async () => {
    if (!state.loaded) await loadAll();
    else if (!document.hidden) {
      if (Date.now() - state.lastWorkspaceRead > 30000) await refreshWorkspace();
      await refreshLive();
    }
    schedulePoll();
  }, delay);
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshLive();
  }, 150);
}

function ensureStream() {
  if (state.stream.handle || !state.loaded) return;
  state.stream.handle = subscribeEvents(state.runsDoc?.eventCursor ?? '', {
    onEvent: () => scheduleRefresh(),
    onStatus: (status) => {
      if (status === 'live') {
        const wasLost = state.stream.status === 'lost';
        state.stream.status = 'live';
        state.stream.lostAt = null;
        if (wasLost) loadAll();
      } else if (status === 'reconnecting' && state.stream.status !== 'lost') {
        state.stream.status = 'lost';
        state.stream.lostAt = Date.now();
        render();
      } else if (status === 'closed') {
        state.stream.handle?.close();
        state.stream.handle = null;
        if (state.stream.status !== 'lost') state.stream.lostAt = Date.now();
        state.stream.status = 'lost';
        render();
        setTimeout(() => refreshLive().then(() => ensureStream()), 5000);
      }
    },
  });
}

// ---- routes --------------------------------------------------------------------------
function syncDraft() {
  if (state.route.name !== 'department' || !state.loaded) return;
  const key = state.route.departmentId ?? 'new';
  if (state.ui.drafts.has(key)) return;
  const ws = indexWorkspace(state.workspaceDoc);
  const draft = key === 'new' ? newDepartmentDraft(ws) : editDepartmentDraft(ws, key);
  if (draft) state.ui.drafts.set(key, draft);
}

function closeMenu() {
  $('#nav').classList.remove('is-open');
  $('.menu-button').setAttribute('aria-expanded', 'false');
}

function onRoute() {
  state.route = parseRoute(location.hash);
  state.ui.confirm = null;
  state.ui.actionError = null;
  state.ui.resumeConsent = null;
  state.ui.notice = null;
  closeMenu();
  syncDraft();
  if (state.ui.addWorkerOnArrival && state.route.name === 'department' && state.route.departmentId) {
    state.ui.addWorkerOnArrival = false;
    handlers['add-worker']();
  }
  render();
  if (state.route.name === 'task' && state.loaded) loadTask().then(() => render());
}

// ---- actions --------------------------------------------------------------------------
function closeSheet() {
  state.ui.sheet = null;
  render();
}

async function act(errorKey, fn) {
  state.ui.actionError = null;
  try {
    await fn();
  } catch (error) {
    state.ui.actionError = { key: errorKey, error };
  }
  await refreshLive();
}

async function writeOps(ops) {
  const result = await api.ops(state.workspaceDoc?.revision ?? 0, ops);
  await refreshWorkspace();
  return result;
}

function currentDraft() {
  return state.ui.drafts.get(state.route.departmentId ?? 'new') ?? null;
}

const handlers = {
  'office-tab': (target) => {
    if (!['assign', 'tasks', 'connections'].includes(target.dataset.tab)) return;
    state.ui.officeTab = target.dataset.tab;
    render({ force: true });
  },
  'office-compose': (target) => {
    const ctx = context();
    if (!ctx.setup.allDone || !ctx.ws.ok || ctx.requestsDoc?.accepting === false) return;
    const departmentId = ctx.ws.departmentById.has(state.ui.officeDepartmentId) ? state.ui.officeDepartmentId : undefined;
    const projectId = departmentId ? ctx.ws.liveProjects.find((project) => pairSendable(ctx.ws, departmentId, project.id))?.id : undefined;
    state.ui.sheetOpener = target;
    state.ui.sheet = { ...sheetDefaults(ctx.ws, { departmentId, projectId }), text: state.ui.officeDraft };
    render({ force: true });
  },
  'office-add-agent': () => {
    const ws = indexWorkspace(state.workspaceDoc);
    const department = ws.liveDepartments.find((item) => item.id === state.ui.officeDepartmentId) ?? (ws.liveDepartments.length === 1 ? ws.liveDepartments[0] : null);
    if (!department) {
      location.hash = ws.liveDepartments.length ? '#/departments' : '#/departments/new';
      return;
    }
    state.ui.addWorkerOnArrival = true;
    location.hash = `#/departments/${encodeURIComponent(department.id)}`;
  },
  'open-sheet': (target) => {
    const ws = indexWorkspace(state.workspaceDoc);
    if (!ws.ok) return;
    state.ui.sheetOpener = target;
    state.ui.sheet = target.dataset.sheet === 'new-task' ? sheetDefaults(ws, { projectId: target.dataset.project }) : addProjectDefaults();
    render({ force: true });
  },
  'close-sheet': () => closeSheet(),
  toggle: (target) => {
    const key = target.dataset.toggle;
    if (state.ui.expanded.has(key)) state.ui.expanded.delete(key);
    else state.ui.expanded.add(key);
    if (key === 'changes' && state.ui.expanded.has(key)) loadDiffs();
    render({ force: true });
  },
  'refresh-tools': async (target) => {
    target.disabled = true;
    await loadAll({ refreshTools: true });
  },
  'reload-all': () => loadAll(),
  'reload-page': () => location.reload(),
  'start-held': (target) => act(currentErrorKey(), () => api.startHeld(target.dataset.id)),
  discard: (target) => act(currentErrorKey(), () => api.discard(target.dataset.id)),
  'stop-request': (target) => act(currentErrorKey(), () => api.stopRequest(target.dataset.id)),
  resume: async (target) => {
    const { project, run } = target.dataset;
    const key = currentErrorKey();
    state.ui.actionError = null;
    try {
      await api.resume(project, run, false);
    } catch (error) {
      if (error.code === 'consent_required') state.ui.resumeConsent = { key, projectId: project, runId: run, agents: error.body?.consent?.agents ?? [], checked: false };
      else state.ui.actionError = { key, error };
    }
    await refreshLive();
  },
  'resume-confirm': async () => {
    const consent = state.ui.resumeConsent;
    if (!consent?.checked) return;
    state.ui.resumeConsent = null;
    await act(consent.key, () => api.resume(consent.projectId, consent.runId, true));
  },
  'resume-cancel': () => {
    state.ui.resumeConsent = null;
    render({ force: true });
  },
  'hide-needs': (target) => {
    state.ui.hidden.add(target.dataset.id);
    storage.set('workforce.hidden', [...state.ui.hidden]);
    render({ force: true });
  },
  'hide-finished': () => {
    for (const item of context().needs.items) if (item.hideable) state.ui.hidden.add(item.id);
    storage.set('workforce.hidden', [...state.ui.hidden]);
    render({ force: true });
  },
  'show-hidden': () => {
    state.ui.hidden.clear();
    storage.set('workforce.hidden', []);
    render({ force: true });
  },
  'hide-ready': () => {
    state.ui.readyHidden = true;
    storage.set('workforce.readyHidden', true);
    render({ force: true });
  },
  confirm: (target) => {
    state.ui.confirm = target.dataset.confirm;
    render({ force: true });
  },
  'confirm-cancel': () => {
    state.ui.confirm = null;
    render({ force: true });
  },
  'add-check': async (target) => {
    const projectId = target.dataset.project;
    const form = state.ui.projectForms.get(projectId) ?? { newCheck: '', error: null };
    const command = form.newCheck.trim();
    if (!command) return;
    const project = indexWorkspace(state.workspaceDoc).projectById.get(projectId);
    try {
      await writeOps([{ op: 'project.edit', id: projectId, checks: [...project.checks, command] }]);
      state.ui.projectForms.set(projectId, { newCheck: '', error: null });
    } catch (error) {
      state.ui.projectForms.set(projectId, { ...form, error });
    }
    render({ force: true });
  },
  'remove-check': async (target) => {
    const projectId = target.dataset.project;
    const project = indexWorkspace(state.workspaceDoc).projectById.get(projectId);
    const checks = project.checks.filter((_, index) => index !== Number(target.dataset.index));
    try {
      await writeOps([{ op: 'project.edit', id: projectId, checks }]);
    } catch (error) {
      state.ui.projectForms.set(projectId, { newCheck: '', error });
    }
    render({ force: true });
  },
  'archive-project': (target) => projectOp(target.dataset.project, 'project.archive', false),
  'remove-project': (target) => projectOp(target.dataset.project, 'project.remove', true),
  'add-worker': () => {
    const draft = currentDraft();
    if (!draft) return;
    const ws = indexWorkspace(state.workspaceDoc);
    draft.workers.push({ id: null, key: `w${Date.now()}`, name: '', tool: draft.workers[draft.workers.length - 1]?.tool ?? draft.head.tool, model: '', instructions: '', policy: 'local-development', projectIds: ws.liveProjects.length === 1 ? [ws.liveProjects[0].id] : [] });
    render({ force: true, focus: `#worker-${draft.workers.length - 1}-name` });
  },
  'remove-worker': (target) => {
    const draft = currentDraft();
    if (!draft) return;
    const [worker] = draft.workers.splice(Number(target.dataset.index), 1);
    if (worker?.id) draft.archivedWorkers.push(worker.id);
    render({ force: true });
  },
  'restore-workers': () => {
    const draft = currentDraft();
    if (!draft) return;
    const fresh = editDepartmentDraft(indexWorkspace(state.workspaceDoc), draft.id);
    for (const id of draft.archivedWorkers) {
      const worker = fresh?.workers.find((entry) => entry.id === id);
      if (worker) draft.workers.push(worker);
    }
    draft.archivedWorkers = [];
    render({ force: true });
  },
  'discard-draft': () => {
    state.ui.drafts.delete(state.route.departmentId ?? 'new');
    state.ui.editorError = null;
    if (!location.hash.startsWith('#/departments/')) return;
    syncDraft();
    render({ force: true });
  },
  'save-department': async (target) => {
    const key = state.route.departmentId ?? 'new';
    const draft = state.ui.drafts.get(key);
    if (!draft) return;
    if (target.dataset.again) await refreshWorkspace();
    const ops = draftOps(indexWorkspace(state.workspaceDoc), draft);
    if (ops.length === 0) return;
    state.ui.saving = true;
    state.ui.editorError = null;
    render({ force: true });
    try {
      await writeOps(ops);
      state.ui.drafts.delete(key);
      state.ui.saving = false;
      await refreshLive();
      location.hash = draft.id === null ? (context().setup.allDone ? '#/office' : '#/home') : '#/departments';
    } catch (error) {
      state.ui.saving = false;
      state.ui.editorError = { key, error };
      render({ force: true });
    }
  },
  'archive-department': async (target) => {
    try {
      await writeOps([{ op: 'department.archive', id: target.dataset.id }]);
      state.ui.drafts.delete(target.dataset.id);
      location.hash = '#/departments';
    } catch (error) {
      state.ui.editorError = { key: target.dataset.id, error };
      render({ force: true });
    }
  },
  'inspect-folder': () => inspectFolder(),
  'add-check-row': () => {
    state.ui.sheet.checks.push('');
    render({ force: true, focus: `#project-check-${state.ui.sheet.checks.length - 1}` });
  },
  'remove-check-row': (target) => {
    state.ui.sheet.checks.splice(Number(target.dataset.index), 1);
    render({ force: true });
  },
  'add-project': async () => {
    const sheet = state.ui.sheet;
    if (!sheet?.inspection?.canAdd) return;
    const wasSetup = context().setup.showChecklist;
    const checks = sheet.inspection.checks?.count ? [] : sheet.checks.map((check) => check.trim()).filter(Boolean);
    sheet.saving = true;
    sheet.error = null;
    render({ force: true });
    try {
      const result = await writeOps([{ op: 'project.add', repoPath: sheet.inspection.repositoryRoot, name: sheet.projectName.trim(), ...(checks.length ? { checks } : {}) }]);
      state.ui.sheet = null;
      await refreshLive();
      const id = result.created?.projects?.[0];
      location.hash = wasSetup || !id ? '#/home' : `#/projects/${encodeURIComponent(id)}`;
    } catch (error) {
      sheet.saving = false;
      sheet.error = error;
      render({ force: true });
    }
  },
  'send-task': async () => {
    const sheet = state.ui.sheet;
    if (!sheet || sheet.sending) return;
    sheet.sending = true;
    sheet.error = null;
    render({ force: true });
    try {
      const response = await api.send({ projectId: sheet.projectId, departmentId: sheet.departmentId, task: sheet.text, ...(sheet.consent ? { allowUnconfinedWrites: true } : {}) });
      state.ui.sheet = null;
      await refreshLive();
      location.hash = `#/tasks/q/${encodeURIComponent(response.request.id)}`;
    } catch (error) {
      sheet.sending = false;
      sheet.error = error;
      render({ force: true });
    }
  },
  'save-limits': async () => {
    const ws = indexWorkspace(state.workspaceDoc);
    const patch = {};
    for (const field of LIMIT_FIELDS) {
      const raw = state.ui.limitsDraft?.[field.key];
      if (raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isInteger(value) && value !== ws.limits?.[field.key]) patch[field.key] = value;
    }
    state.ui.actionError = null;
    state.ui.notice = null;
    if (Object.keys(patch).length === 0) state.ui.notice = { key: 'limits', text: 'No limit changed.' };
    else {
      try {
        await writeOps([{ op: 'limits.set', limits: patch }]);
        state.ui.limitsDraft = null;
        state.ui.notice = { key: 'limits', text: 'Limits saved.' };
      } catch (error) {
        state.ui.actionError = { key: 'limits', error };
      }
    }
    render({ force: true });
  },
  'menu-toggle': (target) => {
    const open = !$('#nav').classList.contains('is-open');
    $('#nav').classList.toggle('is-open', open);
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
};

function currentErrorKey() {
  return context().taskView?.entry?.key ?? `route:${routeKey(state.route)}`;
}

async function projectOp(projectId, op, leave) {
  state.ui.confirm = null;
  state.ui.actionError = null;
  try {
    await writeOps([{ op, id: projectId }]);
    if (leave) location.hash = '#/projects';
  } catch (error) {
    state.ui.actionError = { key: `project:${projectId}`, error };
  }
  render({ force: true });
}

async function inspectFolder() {
  const sheet = state.ui.sheet;
  if (!sheet || sheet.name !== 'add-project') return;
  const folder = sheet.path.trim();
  if (!folder) return;
  if (!/^(\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(folder)) {
    sheet.error = { code: 'path_not_absolute', message: 'Use a full folder path, or start with ~/ for your home folder.', details: [] };
    sheet.inspection = null;
    render({ force: true });
    return;
  }
  sheet.inspecting = true;
  sheet.error = null;
  render({ force: true });
  try {
    sheet.inspection = await api.inspect(folder);
    sheet.projectName = sheet.inspection.suggestedName ?? '';
  } catch (error) {
    sheet.inspection = null;
    sheet.error = error;
  }
  sheet.inspecting = false;
  render({ force: true });
}

function setDraft(path, element, value) {
  const draft = currentDraft();
  if (!draft) return;
  const parts = path.split('.');
  if (parts[0] === 'workers') {
    const worker = draft.workers[Number(parts[1])];
    if (!worker) return;
    if (parts[2] === 'projects') {
      const id = element.dataset.project;
      worker.projectIds = value ? [...new Set([...worker.projectIds, id])] : worker.projectIds.filter((entry) => entry !== id);
    } else worker[parts[2]] = value;
  } else if (parts[0] === 'head') draft.head[parts[1]] = value;
  else draft[parts[0]] = value;
}

function setSheet(path, value) {
  const sheet = state.ui.sheet;
  if (!sheet) return;
  const ws = indexWorkspace(state.workspaceDoc);
  if (path === 'projectId') {
    sheet.projectId = value;
    if (!pairSendable(ws, sheet.departmentId, value)) sheet.departmentId = ws.liveDepartments.find((department) => pairSendable(ws, department.id, value))?.id ?? null;
    sheet.consent = false;
  } else if (path === 'departmentId') {
    sheet.departmentId = value;
    sheet.consent = false;
  } else if (path.startsWith('checks.')) sheet.checks[Number(path.slice(7))] = value;
  else sheet[path] = value;
}

function onBind(event) {
  const element = event.target.closest?.('[data-bind]');
  if (!element || event.isComposing) return;
  const choice = element.type === 'checkbox' || element.type === 'radio' || element.tagName === 'SELECT';
  if (event.type === 'input' && choice) return;
  if (event.type === 'change' && !choice) return;
  const bind = element.dataset.bind;
  const value = element.type === 'checkbox' ? element.checked : element.value;
  if (bind === 'filter') state.ui.taskFilter = value;
  else if (bind === 'office:task') state.ui.officeDraft = value;
  else if (bind === 'office:department') state.ui.officeDepartmentId = value;
  else if (bind.startsWith('draft:')) setDraft(bind.slice(6), element, value);
  else if (bind.startsWith('sheet:')) setSheet(bind.slice(6), value);
  else if (bind === 'project-check') {
    const form = state.ui.projectForms.get(element.dataset.project) ?? { newCheck: '', error: null };
    state.ui.projectForms.set(element.dataset.project, { ...form, newCheck: value });
    return;
  } else if (bind === 'limit') {
    state.ui.limitsDraft = { ...(state.ui.limitsDraft ?? {}), [element.dataset.field]: value };
    return;
  } else if (bind === 'resume-consent' && state.ui.resumeConsent) state.ui.resumeConsent.checked = value;
  if (element.hasAttribute('data-rerender')) render({ force: true });
}

function trapFocus(event) {
  const dialog = document.querySelector('#sheet-root .sheet');
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Read every bound text field into state before an action runs, so an action
 * always acts on what is on screen, even when a value arrived without an input
 * event (autofill, some paste paths, assistive tools).
 */
function syncBoundFields() {
  for (const element of document.querySelectorAll('input[data-bind]:not([type="checkbox"]):not([type="radio"]), textarea[data-bind]')) {
    const bind = element.dataset.bind;
    const value = element.value;
    if (bind === 'office:task') state.ui.officeDraft = value;
    else if (bind.startsWith('sheet:') && state.ui.sheet) {
      const path = bind.slice(6);
      const current = path.startsWith('checks.') ? state.ui.sheet.checks[Number(path.slice(7))] : state.ui.sheet[path];
      if (current !== value) setSheet(path, value);
    } else if (bind.startsWith('draft:')) setDraft(bind.slice(6), element, value);
    else if (bind === 'project-check') {
      const form = state.ui.projectForms.get(element.dataset.project) ?? { newCheck: '', error: null };
      state.ui.projectForms.set(element.dataset.project, { ...form, newCheck: value });
    } else if (bind === 'limit') state.ui.limitsDraft = { ...(state.ui.limitsDraft ?? {}), [element.dataset.field]: value };
  }
}

// ---- wiring ----------------------------------------------------------------------------
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'backdrop') {
    if (event.target === target) closeSheet();
    return;
  }
  const handler = handlers[action];
  if (!handler) return;
  syncBoundFields();
  if (target.tagName === 'A') {
    // Links keep navigating; the action only tidies up (close a sheet, drop a draft).
    handler(target);
    return;
  }
  event.preventDefault();
  handler(target);
});
document.addEventListener('input', onBind);
document.addEventListener('change', onBind);
document.addEventListener('keydown', (event) => {
  const officeTab = event.target?.closest?.('[role="tab"][data-action="office-tab"]');
  if (officeTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const index = OFFICE_TABS.indexOf(officeTab.dataset.tab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? OFFICE_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + OFFICE_TABS.length) % OFFICE_TABS.length;
    state.ui.officeTab = OFFICE_TABS[nextIndex];
    render({ force: true, focus: `#office-tab-${state.ui.officeTab}` });
  } else if (event.key === 'Escape') {
    if (state.ui.sheet) {
      event.preventDefault();
      closeSheet();
    } else closeMenu();
  } else if (event.key === 'Tab' && state.ui.sheet) trapFocus(event);
  else if (event.key === 'Enter' && event.target?.id === 'project-path') {
    event.preventDefault();
    syncBoundFields();
    inspectFolder();
  }
});
$('.menu-button').dataset.action = 'menu-toggle';
window.addEventListener('hashchange', onRoute);
window.addEventListener('focus', () => {
  if (state.loaded) refreshWorkspace().then(() => render());
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.loaded) refreshLive();
});

render();
loadAll();
