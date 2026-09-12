import { SCENE, departments, seats, control } from './data.js';
import { createCamera } from './camera.js';
import { createSidebar } from './sidebar.js';
import { createAgentManager } from './agent-manager.js';
import { layoutExtraDesks } from './extra-desks.js';
import { placeLabels } from './label-layout.js';
import { api, subscribeEvents } from './api.js';
import { LIVE_RUN_STATES, buildRoster, communicationFor, departmentCounts, deskState, deskTone, describeEvent, openSeatVeils, runGroup, runtimeStatus, taskOwners } from './office-model.js';

/*
 * The office canvas over the workforce API.
 *
 * Every desk, count, status and runtime on this page is read from the server:
 * GET /api/office (configured agents, passive runtime discovery, coordinator),
 * GET /api/runs (runs, their tasks, attempts and receipts) and the
 * /api/events stream. Events only tell the page *when* to re-read; what a desk
 * says is derived from the rows (office-model.js), so a reload draws the same
 * office. Nothing here starts work except the explicit Start run control in
 * the Assign panel, which goes through the coordinator.
 */

const $ = (id) => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const viewport = $('canvas');
const world = $('world');
const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const RUNS_REFRESH_MS = 20_000;
// While a run's rows say it is live, re-read often: a coordinator that dies sends no event to say so.
const LIVE_RUNS_REFRESH_MS = 3_000;
const OFFICE_REFRESH_MS = 60_000;
const EVENT_REFRESH_DEBOUNCE_MS = 400;
const ACTIVITY_LIMIT = 80;

let camera;
let sidebar;
let manager;
let sceneSize = { ...SCENE };
let selection = { type: 'office' };
let view = 'office';
let noticeTimer;
let overviewScale = 1;
let labelLayoutTimer;
let labelLayoutKey;
let labelRevision = 0;
let runsTimer = null;
let eventRefreshTimer = null;

/** Everything the page knows, all of it read from the server. */
const store = {
  office: null,
  officeError: null,
  runs: [],
  runsLoaded: false,
  runsError: null,
  stateFound: null,
  // The coordinator lock GET /api/runs read alongside the rows.
  lock: null,
  eventCursor: 0,
  stream: 'connecting',
  employees: [],
  desks: new Map(),
  activity: [],
  lastCommunication: null,
};

const findDepartment = id => departments.find(d => d.id === id);
const findEmployee = id => store.employees.find(e => e.id === id);
const coordinatorName = 'Atlas';

function svgElement(tag, attrs = {}) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function departmentSummary(departmentId) {
  const roster = store.employees.filter(e => e.departmentId === departmentId);
  const agents = roster.filter(e => e.kind === 'agent');
  const open = roster.filter(e => e.kind === 'open').length;
  if (!store.office) return 'Loading configuration';
  if (agents.length === 0) return `No agents configured · ${open} open desks`;
  const working = agents.filter(e => store.desks.get(e.id)?.state === 'working').length;
  const review = agents.filter(e => store.desks.get(e.id)?.state === 'review').length;
  const stalled = agents.filter(e => store.desks.get(e.id)?.state === 'stalled').length;
  return `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${working ? `${working} working` : review ? `${review} to review` : stalled ? `${stalled} stalled` : 'none working'}${open ? ` · ${open} open` : ''}`;
}

function createDepartments() {
  $('department-outlines').replaceChildren();
  $('department-labels').replaceChildren();
  $('connection-paths').replaceChildren();
  const counts = departmentCounts(store.employees);
  for (const department of departments) {
    const polygon = svgElement('polygon', { points: department.polygon, class: 'department-outline', 'data-department': department.id });
    polygon.style.setProperty('--department-color', department.color);
    polygon.addEventListener('click', () => focusSelection({ type: 'department', id: department.id }));
    $('department-outlines').append(polygon);
    const button = document.createElement('button');
    button.className = 'department-label world-label';
    button.dataset.department = department.id;
    const firstSeat = seats.find(seat => seat.departmentId === department.id);
    button.style.cssText = `left:${department.x}px;top:${firstSeat.labelY - 62}px;--department-color:${department.color};--department-label-x:${department.x}px;--department-label-y:${department.bounds.y-15}px`;
    const count = store.office ? counts[department.id] ?? 0 : '–';
    const summary = departmentSummary(department.id);
    button.setAttribute('aria-label', `Focus ${department.name}, ${summary}`);
    button.title = `${department.name} · ${summary}`;
    button.innerHTML = `<span class="dept-dot"></span><span><strong>${esc(department.name)}</strong><small>${esc(summary)}</small></span><span class="department-count">${esc(count)}</span>`;
    button.classList.toggle('has-no-agents', store.office !== null && !counts[department.id]);
    button.addEventListener('click', () => focusSelection({ type: 'department', id: department.id }));
    $('department-labels').append(button);
    const route = svgElement('path', { d: curvedPath(control, department), class: 'route-path', 'data-route': department.id });
    $('connection-paths').append(route);
  }
}

function labelParts(employee) {
  const desk = store.desks.get(employee.id) ?? deskState(null, []);
  const tone = deskTone(desk.state);
  const role = employee.kind === 'open' ? 'not configured' : desk.label;
  return { desk, tone, role };
}

function applyLabelState(label, employee) {
  const { desk, tone, role } = labelParts(employee);
  const selected = label.classList.contains('selected');
  const inTeam = label.classList.contains('in-selected-team');
  label.className = `employee-label world-label desk-${desk.state} tone-${tone}${employee.kind === 'open' ? ' open-desk' : ''}${employee.isCustom ? ' custom-agent-label' : ''}${selected ? ' selected' : ''}${inTeam ? ' in-selected-team' : ''}`;
  const department = findDepartment(employee.departmentId)?.name ?? '';
  const text = employee.kind === 'open' ? `Open desk in ${department}, not configured` : `${employee.name}, ${department}, ${desk.label}`;
  label.setAttribute('aria-label', `${text}. Focus`);
  label.title = employee.kind === 'open' ? `Open desk · ${department} · not configured` : `${employee.name} · ${desk.label}`;
  const roleElement = label.querySelector('.employee-role');
  if (roleElement.textContent !== role) roleElement.textContent = role;
}

function createEmployees() {
  labelRevision++;
  $('employee-labels').replaceChildren();
  // The artwork draws a figure at every seat. Veil each seat no configured agent sits at; until the
  // configuration is read, no seat is known to be occupied, so every figure is veiled.
  const veils = store.office ? openSeatVeils(store.employees) : seats.map(({ id, x, y }) => ({ seatId: id, x, y }));
  $('seat-veils').replaceChildren(...veils.map(veil => {
    const element = document.createElement('span');
    element.className = 'open-seat-veil';
    element.dataset.seat = veil.seatId;
    element.style.cssText = `left:${veil.x}px;top:${veil.y}px`;
    return element;
  }));
  const seated = seats.length - veils.length;
  document.querySelector('.office-art').alt = `Illustration of six office islands around the control center, with ${seats.length} drawn desks. ${seated} ${seated === 1 ? 'desk has' : 'desks have'} a configured agent; the figures at the other desks are veiled because no agent sits there.`;
  // DOM order follows the fixed seat order, then additional desks. No seat coordinates are animated.
  for (const employee of store.employees) {
    const hit = document.createElement('button');
    hit.className = 'employee-hit';
    hit.dataset.employee = employee.id;
    hit.style.cssText = `left:${employee.x}px;top:${employee.y}px`;
    hit.setAttribute('aria-label', employee.kind === 'open' ? 'Focus open desk' : `Focus ${employee.name}`);
    hit.tabIndex = -1;
    hit.addEventListener('click', () => focusSelection({ type: 'employee', id: employee.id }));
    $('employee-labels').append(hit);
    const button = document.createElement('button');
    button.style.cssText = `left:${employee.x}px;top:${employee.labelY}px`;
    button.dataset.employee = employee.id;
    button.dataset.departmentId = employee.departmentId;
    button.innerHTML = `<span class="dot"></span><span class="employee-name">${esc(employee.name)}</span><span class="employee-role"></span>`;
    applyLabelState(button, employee);
    button.addEventListener('click', () => focusSelection({ type: 'employee', id: employee.id }));
    $('employee-labels').append(button);
  }
}

function runtimeMark(adapter) {
  const marks = {
    codex: '<path d="m6 5-4 4 4 4m6-8 4 4-4 4m-2-9L8 14"/>',
    claude: '<path d="M9 1v16M1 9h16M3.4 3.4l11.2 11.2m0-11.2L3.4 14.6M5.9 1.6l6.2 14.8M1.6 5.9l14.8 6.2m-10.5 4.3L12.1 1.6M1.6 12.1l14.8-6.2"/>',
    local: '<rect x="3" y="2" width="12" height="6" rx="1.5"/><rect x="3" y="10" width="12" height="6" rx="1.5"/><path d="M6 5h.1M6 13h.1m3-8h3m-3 8h3"/>',
  };
  return marks[adapter === 'claude-code' ? 'claude' : adapter] || marks.local;
}

function createRuntimes() {
  const container = $('runtime-buttons');
  container.replaceChildren();
  const runtimes = store.office?.runtimes;
  if (!store.office) {
    container.innerHTML = `<span class="runtime-button runtime-placeholder"><span><strong>${store.officeError ? 'Server unreachable' : 'Discovering runtimes'}</strong><small>${store.officeError ? esc(store.officeError) : 'passive check, no model turn'}</small></span></span>`;
    return;
  }
  if (runtimes?.error) {
    container.innerHTML = `<span class="runtime-button runtime-placeholder"><span><strong>Discovery failed</strong><small>${esc(runtimes.error)}</small></span></span>`;
    return;
  }
  const reports = runtimes?.reports ?? [];
  if (reports.length === 0) {
    container.innerHTML = '<span class="runtime-button runtime-placeholder"><span><strong>No runtime reported</strong><small>passive discovery found none</small></span></span>';
    return;
  }
  for (const report of reports) {
    const status = runtimeStatus(report);
    const button = document.createElement('button');
    button.className = 'runtime-button';
    button.dataset.runtime = report.adapter === 'claude-code' ? 'claude' : report.adapter;
    button.dataset.adapter = report.adapter;
    button.setAttribute('aria-label', `Inspect ${report.displayName}: ${status.label}${report.version ? `, version ${report.version}` : ''}. Passive discovery`);
    button.innerHTML = `<span class="runtime-mark"><svg viewBox="0 0 18 18">${runtimeMark(report.adapter)}</svg></span><span><strong>${esc(report.displayName)}</strong><small>${esc(report.version ?? 'no version')} · ${esc(status.label)}</small></span><span class="runtime-status tone-${esc(status.tone)}"></span>`;
    button.addEventListener('click', () => {
      document.querySelectorAll('.runtime-button').forEach(b => b.classList.toggle('selected', b === button));
      setView('connections');
      sidebar.showRuntime(report.adapter);
      openMobilePanel();
    });
    container.append(button);
  }
}

function updateHeader() {
  const agents = store.employees.filter(e => e.kind === 'agent').length;
  const open = store.employees.filter(e => e.kind === 'open').length;
  const count = document.querySelector('.office-count');
  count.innerHTML = store.office
    ? `<i class="dot stream-${esc(store.stream)}"></i><strong>${agents}</strong> ${agents === 1 ? 'agent' : 'agents'} <span class="muted">· ${open} open desks · ${departments.length} departments</span>`
    : `<i class="dot stream-${esc(store.stream)}"></i><strong>–</strong> agents <span class="muted">· ${store.officeError ? 'server unreachable' : 'loading'}</span>`;
  count.title = `Event stream: ${store.stream}`;
  $('agent-count').textContent = String(agents);
  const reviews = store.runs.filter(run => runGroup(run) === 'review').length;
  $('review-button').querySelector('span').textContent = store.runsLoaded ? `${reviews} to review` : 'Runs loading';
  $('review-button').classList.toggle('has-none', store.runsLoaded && reviews === 0);
  const lock = store.lock ?? store.office?.coordinator?.lock;
  const version = store.office?.coordinator?.version;
  $('coordinator-name').textContent = lock?.held ? `${coordinatorName} · coordinating a run${lock.pid ? ` (pid ${lock.pid})` : ''}` : `${coordinatorName} · workforce coordinator${version ? ` ${version}` : ''}`;
  $('control-label').setAttribute('aria-label', `${coordinatorName}, the workforce coordinator. Focus control center`);
  const label = $('communication-label');
  const indicator = $('communication-indicator');
  const sample = document.querySelector('.communication-bar .sample-label');
  if (store.lastCommunication) label.textContent = store.lastCommunication.message;
  else label.textContent = store.stream === 'live' ? 'No coordination observed since this page opened' : 'Waiting for the event stream';
  indicator.className = `communication-play stream-${store.stream}`;
  sample.textContent = { live: 'LIVE', reconnecting: 'RECONNECTING', connecting: 'CONNECTING', closed: 'OFFLINE', failed: 'OFFLINE' }[store.stream] ?? 'OFFLINE';
}

function recomputeDesks() {
  store.desks = new Map(store.employees.map(employee => [employee.id, employee.kind === 'agent' ? deskState(employee.agentId, store.runs, store.lock) : deskState(null, [])]));
}

/** Rebuild the roster (configuration changed) and redraw everything. */
function rebuildScene() {
  store.employees = store.office ? buildRoster(store.office, { seats, departments }) : [];
  recomputeDesks();
  sceneSize = layoutExtraDesks({ employees: store.employees, departments, element: $('extra-desks') });
  world.style.width = `${sceneSize.width}px`;
  world.style.height = `${sceneSize.height}px`;
  $('scene-lines').setAttribute('viewBox', `0 0 ${sceneSize.width} ${sceneSize.height}`);
  createDepartments();
  createEmployees();
  createRuntimes();
  updateHeader();
  camera?.setBounds(sceneSize.width, sceneSize.height);
  if (selection.type === 'employee' && !findEmployee(selection.id)) selection = { type: 'office' };
  focusSelection(selection, { move: false });
}

/** Runs changed: update desk states in place, without moving or recreating anything. */
function refreshDesks() {
  recomputeDesks();
  for (const label of document.querySelectorAll('.employee-label')) {
    const employee = findEmployee(label.dataset.employee);
    if (employee) applyLabelState(label, employee);
  }
  for (const department of departments) {
    const heading = document.querySelector(`.department-label[data-department="${department.id}"]`);
    if (!heading) continue;
    const summary = departmentSummary(department.id);
    heading.querySelector('small').textContent = summary;
    heading.title = `${department.name} · ${summary}`;
    heading.setAttribute('aria-label', `Focus ${department.name}, ${summary}`);
  }
  updateHeader();
  labelRevision++;
  if (camera) scheduleLabelLayout(camera.getState());
}

function focusSelection(next, { sync = true, move = true } = {}) {
  selection = next;
  let title = 'Whole office';
  const selectedDepartment = next.type === 'employee' ? findEmployee(next.id)?.departmentId : next.type === 'department' ? next.id : null;
  document.querySelectorAll('[data-department]').forEach(element => element.classList.toggle('selected', element.dataset.department === selectedDepartment));
  document.querySelectorAll('[data-employee]').forEach(element => element.classList.toggle('selected', element.dataset.employee === next.id && next.type === 'employee'));
  $('control-label').classList.toggle('selected', next.type === 'control');
  world.classList.toggle('has-selection', next.type !== 'office');
  world.classList.toggle('control-selected', next.type === 'control');
  document.querySelectorAll('.employee-label').forEach(element => element.classList.toggle('in-selected-team', element.dataset.departmentId === selectedDepartment));
  if (next.type === 'office') {
    if (move) camera?.fit();
  } else if (next.type === 'department') {
    const department = findDepartment(next.id);
    if (!department) return;
    title = department.name;
    const custom = store.employees.filter(employee => employee.departmentId === department.id && employee.isCustom);
    const extraBounds = custom.length ? {x: Math.min(...custom.map(e=>e.x))-110,y:Math.min(...custom.map(e=>e.y))-130,width:Math.max(...custom.map(e=>e.x))-Math.min(...custom.map(e=>e.x))+220,height:Math.max(...custom.map(e=>e.y))-Math.min(...custom.map(e=>e.y))+250} : null;
    if (move) camera?.focus(next.extra && extraBounds ? extraBounds : department.bounds, { zoom: viewport.clientWidth <= 760 && matchMedia('(max-width:760px)').matches ? 3 : 1.5 });
  } else if (next.type === 'employee') {
    const employee = findEmployee(next.id);
    if (!employee) return;
    title = employee.kind === 'open' ? `Open desk · ${findDepartment(employee.departmentId)?.name ?? ''}` : employee.name;
    if (move) camera?.focus({ x: employee.x - 100, y: employee.y - 100, width: 200, height: 200 }, { zoom: matchMedia('(max-width:760px)').matches ? 4.4 : 2.2 });
  } else if (next.type === 'control') {
    title = `${coordinatorName} · Control center`;
    if (move) camera?.focus(control.bounds, { zoom: matchMedia('(max-width:760px)').matches ? 3 : 1.6 });
  }
  $('selection-name').textContent = title;
  if (sync) sidebar?.select(next);
  if (next.type === 'control' && move) { sidebar?.showTab('assign'); openMobilePanel(); }
}

function setView(next) {
  if (manager?.isOpen()) closeAgentManager();
  view = next;
  viewport.classList.toggle('connections-mode', next === 'connections');
  for (const name of ['office', 'connections']) {
    $(`${name}-view`).classList.toggle('active', next === name);
    $(`${name}-view`).setAttribute('aria-pressed', String(next === name));
  }
  if (next === 'connections') sidebar.showTab('connections');
  else sidebar.showTab('assign');
  updateWires();
}

function updateCamera(state) {
  overviewScale = state.fitScale;
  $('zoom-value').textContent = `${Math.round(state.scale / overviewScale * 100)}%`;
  const labelDensity = Math.min(1, Math.max(.82, state.scale / .5));
  world.style.setProperty('--label-scale', String(labelDensity / state.scale));
  world.style.setProperty('--employee-scale', String(labelDensity / state.scale));
  world.classList.toggle('detail-mode', state.scale / overviewScale > 1.35);
  $('zoom-out').disabled = state.scale <= state.minScale + .002;
  $('zoom-in').disabled = state.scale >= state.maxScale - .002;
  scheduleLabelLayout(state);
  updateWires(state);
}

function scheduleLabelLayout(state) {
  const key = `${state.scale}:${viewport.clientWidth}:${selection.type}:${selection.id}:${labelRevision}:${world.classList.contains('detail-mode')}`;
  if (key === labelLayoutKey) return;
  labelLayoutKey = key;
  clearTimeout(labelLayoutTimer);
  // Leave nameplates attached during camera motion; resolve spacing once it settles.
  // Panning keeps the cached arrangement and does not trigger layout work.
  labelLayoutTimer = setTimeout(() => layoutLabels(state), 80);
}

function layoutLabels({ scale }) {
  const density = Math.min(1, Math.max(.82, scale / .5));
  const headings = [...world.querySelectorAll('.department-label, .control-label')];
  const names = [...world.querySelectorAll('.employee-label')].sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
  const items = [...headings, ...names].map((element, id) => {
    const width = element.offsetWidth * density;
    const height = element.offsetHeight * density;
    return { id, element, width, height, x: element.offsetLeft * scale - width / 2, y: element.offsetTop * scale - height };
  });
  const leaders = $('label-leaders');
  leaders.replaceChildren();
  const bounds = { left: -24, right: Math.max(sceneSize.width * scale + 24, ...items.map(item => item.width - 24)) };
  for (const placed of placeLabels(items, { gap: 4, bounds })) {
    const original = items[placed.id];
    const dx = placed.x - original.x;
    const dy = placed.y - original.y;
    placed.element.style.setProperty('--label-dx', `${dx / scale}px`);
    placed.element.style.setProperty('--label-dy', `${dy / scale}px`);
    if (Math.hypot(dx, dy) < 8) continue;
    const anchor = { x: original.x + original.width / 2, y: original.y + original.height };
    const edge = { x: Math.max(placed.x, Math.min(placed.x + placed.width, anchor.x)), y: Math.max(placed.y, Math.min(placed.y + placed.height, anchor.y)) };
    leaders.append(svgElement('line', { x1: anchor.x / scale, y1: anchor.y / scale, x2: edge.x / scale, y2: edge.y / scale, class: 'label-leader' }));
  }
}

function updateWires(state = camera?.getState()) {
  if (!state) return;
  const { x, y, scale } = state;
  // Keep the wires in viewport coordinates but below nameplates in the scene.
  const wires = $('ui-wires');
  wires.style.width = `${viewport.clientWidth}px`;
  wires.style.height = `${viewport.clientHeight}px`;
  wires.style.transformOrigin = '0 0';
  wires.style.transform = `translate(${-x / scale}px, ${-y / scale}px) scale(${1 / scale})`;
  const start = { x: x + 800 * scale, y: y + 544 * scale };
  const end = { x: viewport.clientWidth - 1, y: Math.min(170, viewport.clientHeight * .25) };
  const visible = start.x > -20 && start.x < viewport.clientWidth && start.y > 65 && start.y < viewport.clientHeight - 90;
  $('ui-wires').style.opacity = visible ? '1' : '0';
  $('chat-wire').setAttribute('d', `M ${start.x} ${start.y} C ${start.x + 100} ${start.y}, ${end.x - 75} ${end.y}, ${end.x} ${end.y}`);
  const dock = { x: Math.min(290, viewport.clientWidth * .35), y: viewport.clientHeight - 73 };
  $('runtime-wire').setAttribute('d', `M ${start.x - 80 * scale} ${start.y + 50 * scale} C ${start.x - 100} ${start.y + 95}, ${dock.x} ${dock.y - 110}, ${dock.x} ${dock.y}`);
  $('chat-wire-start').setAttribute('cx', start.x);
  $('chat-wire-start').setAttribute('cy', start.y);
  $('chat-wire-end').setAttribute('cx', end.x);
  $('chat-wire-end').setAttribute('cy', end.y);
}

function endpoint(id) { return id === 'control' ? control : findEmployee(id) || findDepartment(id) || control; }
function curvedPath(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const bend = Math.min(distance * .13, 65);
  return `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - bend} ${to.x} ${to.y}`;
}

/** Draw one pulse for one recorded coordination event. Called only from the event stream. */
function communicate(event) {
  const to = findEmployee(event.to);
  if (!to || !Number.isFinite(to.x)) return;
  const from = endpoint(event.from);
  const group = svgElement('g', { class: 'communication-event' });
  const path = svgElement('path', { d: curvedPath(from, to), class: 'message-trail' });
  group.append(path);
  const packet = svgElement('circle', { r: 6, class: 'message-packet' });
  for (const point of [from, to]) group.append(svgElement('circle', { cx: point.x, cy: point.y, r: 15, class: 'message-endpoint' }));
  group.append(packet);
  $('message-pulses').append(group);
  const length = path.getTotalLength();
  const start = performance.now();
  const duration = 1550;
  const step = now => {
    const progress = Math.min((now - start) / duration, 1);
    const point = path.getPointAtLength(length * progress);
    packet.setAttribute('cx', point.x);
    packet.setAttribute('cy', point.y);
    if (progress < 1 && group.isConnected) requestAnimationFrame(step);
    else setTimeout(() => group.remove(), 650);
  };
  if (reduceMotion.matches || document.hidden) { packet.remove(); setTimeout(() => group.remove(), 2200); }
  else requestAnimationFrame(step);
  store.lastCommunication = { message: event.message, at: Date.now() };
  updateHeader();
}

function notice(text) {
  clearTimeout(noticeTimer);
  $('canvas-notice').textContent = text;
  $('canvas-notice').classList.add('visible');
  noticeTimer = setTimeout(() => $('canvas-notice').classList.remove('visible'), 4200);
}

function openMobilePanel() {
  if (matchMedia('(max-width:760px)').matches) {
    document.body.classList.add('panel-open');
    $('mobile-panel').setAttribute('aria-expanded', 'true');
  }
}

function showAgentManager(mode, id) {
  document.body.classList.add('manager-open');
  openMobilePanel();
  if (mode === 'add') manager.showAddHelp();
  else if (mode === 'agent') manager.showAgent(id);
  else manager.showDirectory();
}
function closeAgentManager() {
  manager.hide();
  document.body.classList.remove('manager-open');
}

// ---------------------------------------------------------------------------
// Data: every value below is read from the workforce server
// ---------------------------------------------------------------------------

async function loadOffice(refresh = false) {
  try {
    const office = await api.office(refresh);
    const agentsChanged = JSON.stringify(office.agents?.map(agent => [agent.id, agent.capabilities, agent.policy])) !== JSON.stringify(store.office?.agents?.map(agent => [agent.id, agent.capabilities, agent.policy])) || JSON.stringify(office.configuration?.defaults) !== JSON.stringify(store.office?.configuration?.defaults);
    store.office = office;
    store.officeError = null;
    if (agentsChanged) rebuildScene();
    else { createRuntimes(); refreshDesks(); }
    if (office.configuration?.error) notice(`${office.configuration.error.message}. Desks show no agents until it is fixed.`);
  } catch (error) {
    store.officeError = error.message;
    if (!store.office) { createRuntimes(); updateHeader(); notice(`Could not read /api/office: ${error.message}`); }
  }
  sidebar?.refresh();
}

async function loadRuns() {
  clearTimeout(runsTimer);
  try {
    const document = await api.runs(50);
    store.runs = Array.isArray(document.runs) ? document.runs : [];
    store.lock = document.coordinator?.lock ?? null;
    store.stateFound = document.stateFound;
    store.runsLoaded = true;
    store.runsError = null;
    if (!store.subscribed) {
      store.eventCursor = Number(document.eventCursor) || 0;
      subscribe();
    }
    refreshDesks();
  } catch (error) {
    store.runsError = error.message;
    updateHeader();
  }
  sidebar?.refresh();
  const live = store.runs.some(run => LIVE_RUN_STATES.has(run.state));
  runsTimer = setTimeout(loadRuns, store.runsError ? 5_000 : live ? LIVE_RUNS_REFRESH_MS : RUNS_REFRESH_MS);
}

function scheduleRunsRefresh() {
  if (eventRefreshTimer !== null) return;
  eventRefreshTimer = setTimeout(() => { eventRefreshTimer = null; loadRuns(); }, EVENT_REFRESH_DEBOUNCE_MS);
}

function subscribe() {
  store.subscribed = true;
  // From the cursor the run list was read at: only what happens next arrives here.
  subscribeEvents(store.eventCursor, {
    onStatus: (status) => {
      store.stream = status;
      updateHeader();
      sidebar?.refresh({ quiet: true });
      if (status === 'live') scheduleRunsRefresh();
    },
    onEvent: (event) => {
      store.eventCursor = Math.max(store.eventCursor, Number(event.cursor) || 0);
      store.activity.push({ event, text: describeEvent(event), receivedAt: Date.now() });
      if (store.activity.length > ACTIVITY_LIMIT) store.activity.splice(0, store.activity.length - ACTIVITY_LIMIT);
      const pulse = communicationFor(event, taskOwners(store.runs));
      if (pulse) communicate(pulse);
      if (event.type !== 'runtime.raw') scheduleRunsRefresh();
      sidebar?.onEvent(event);
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

rebuildScene();
sidebar = createSidebar({
  element: $('sidebar'),
  departments,
  getState: () => store,
  onFocus: next => focusSelection(next, { sync: false }),
  onManageAgents: () => showAgentManager('directory'),
  onAddAgent: () => showAgentManager('add'),
  onShowAgent: id => showAgentManager('agent', id),
  onRefreshRuntimes: () => loadOffice(true),
  onStarted: ({ runId, agentId }) => {
    notice(`Run ${String(runId).slice(0, 8)} recorded by the coordinator. The desk follows the database from here.`);
    loadRuns();
    if (agentId) focusSelection({ type: 'employee', id: `agent:${agentId}` });
  },
});
camera = createCamera({ viewport, world, width: sceneSize.width, height: sceneSize.height, onChange: updateCamera });
manager = createAgentManager({
  element: $('agent-manager'),
  departments,
  getState: () => store,
  onFocus: next => { closeAgentManager(); focusSelection(next); },
  onAssign: agentId => { closeAgentManager(); focusSelection({ type: 'employee', id: `agent:${agentId}` }); sidebar.assignTo(agentId); },
  onClose: closeAgentManager,
});
$('manage-agents').addEventListener('click', () => showAgentManager('directory'));
$('add-agent').addEventListener('click', () => showAgentManager('add'));
$('office-home').addEventListener('click', () => focusSelection({ type: 'office' }));
$('office-view').addEventListener('click', () => setView('office'));
$('connections-view').addEventListener('click', () => setView('connections'));
$('zoom-out').addEventListener('click', () => camera.zoomBy(1 / 1.2));
$('zoom-in').addEventListener('click', () => camera.zoomBy(1.2));
$('zoom-fit').addEventListener('click', () => focusSelection({ type: 'office' }));
$('control-label').addEventListener('click', () => focusSelection({ type: 'control' }));
$('control-hit').addEventListener('click', () => focusSelection({ type: 'control' }));
$('review-button').addEventListener('click', () => { if (manager.isOpen()) closeAgentManager(); sidebar.select({ type: 'office' }); sidebar.showTasks('review'); openMobilePanel(); });
$('runtime-details').addEventListener('click', () => { setView('connections'); openMobilePanel(); });
$('mobile-panel').addEventListener('click', () => {
  if (manager.isOpen()) closeAgentManager();
  const open = document.body.classList.toggle('panel-open');
  $('mobile-panel').setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', event => {
  if (manager?.isOpen()) return;
  if (event.key === 'Escape' && !['TEXTAREA','INPUT','SELECT'].includes(event.target.tagName)) {
    document.body.classList.remove('panel-open');
    $('mobile-panel').setAttribute('aria-expanded', 'false');
    focusSelection({ type: 'office' });
  }
});
viewport.addEventListener('keydown', event => { if (['0', 'Home'].includes(event.key) && event.target === viewport && !event.ctrlKey && !event.metaKey && !event.altKey) focusSelection({ type: 'office' }); });
$('canvas').addEventListener('dblclick', event => {
  if (event.target === viewport || event.target === world) focusSelection({ type: 'office' });
});
setInterval(() => loadOffice(false), OFFICE_REFRESH_MS);
// Read-only diagnostic state for checking what the page derived from the server.
window.officePreview = {
  getState: () => ({
    selection: { ...selection },
    camera: camera.getState(),
    view,
    stream: store.stream,
    agents: store.employees.filter(e => e.kind === 'agent').length,
    openDesks: store.employees.filter(e => e.kind === 'open').length,
    desks: Object.fromEntries([...store.desks].filter(([id]) => id.startsWith('agent:')).map(([id, desk]) => [id, desk.state])),
    runs: store.runs.length,
  }),
  focus: focusSelection,
};
camera.fit();
loadOffice(false);
loadRuns();
