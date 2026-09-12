import { SCENE, departments, employees, runtimes, control, loadLiveData } from './live-data.js';
import { reviewTask } from './task-bridge.js';
const demoCommunications = [];
let live = await loadLiveData();
let liveKey = JSON.stringify([live.workspaceDoc?.workspace,live.tasks]);
import { createCamera } from './camera.js';
import { createSidebar } from './sidebar.js';
import { createAgentStore } from './agent-store.js';
import { createAgentManager } from './agent-manager.js';
import { layoutExtraDesks } from './extra-desks.js';
import { placeLabels } from './label-layout.js';

const $ = (id) => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const viewport = $('canvas');
const world = $('world');
let camera;
let sidebar;
let manager;
let sceneSize = { ...SCENE };
const agentStore = createAgentStore({ employees, departments, runtimes, control });
agentStore.setWorkspace(live.workspaceDoc);
let selection = { type: 'office' };
let view = 'office';
let noticeTimer;
let sequenceTimer;
let activeDemo = false;
let demoIndex = 0;
let overviewScale = 1;
let labelLayoutTimer;
let labelLayoutKey;
let labelRevision = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const findDepartment = id => departments.find(d => d.id === id);
const findEmployee = id => employees.find(e => e.id === id);
const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function svgElement(tag, attrs = {}) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function departmentSummary(roster) {
  const review = roster.filter(e => e.status === 'review').length;
  const configured = roster.filter(e => e.status === 'configured').length;
  const idle = roster.filter(e => e.status === 'idle').length;
  if (!roster.length) return 'Unassigned illustration';
  return `${roster.length} agents · ${review ? `${review} to review` : configured ? `${configured} configured` : idle ? `${idle} idle` : `${roster.length} working`}`;
}

function createDepartments() {
  $('department-outlines').replaceChildren();
  $('department-labels').replaceChildren();
  $('connection-paths').replaceChildren();
  for (const department of departments) {
    const polygon = svgElement('polygon', { points: department.polygon, class: 'department-outline', 'data-department': department.id });
    polygon.style.setProperty('--department-color', department.color);
    polygon.addEventListener('click', () => focusSelection({ type: 'department', id: department.id }));
    $('department-outlines').append(polygon);
    const button = document.createElement('button');
    button.className = 'department-label world-label';
    button.dataset.department = department.id;
    const firstSeat = employees.find(e => e.departmentId === department.id && !e.isCustom);
    button.style.cssText = `left:${department.x}px;top:${(firstSeat?.labelY ?? department.bounds.y + 62) - 62}px;--department-color:${department.color};--department-label-x:${department.x}px;--department-label-y:${department.bounds.y-15}px`;
    const roster = employees.filter(e => e.departmentId === department.id);
    button.setAttribute('aria-label', `Focus ${department.name}, ${roster.length} employees`);
    const review = roster.filter(e => e.status === 'review').length;
    const idle = roster.filter(e => e.status === 'idle').length;
    button.title = `${department.name} · ${departmentSummary(roster)}`;
    button.innerHTML = `<span class="dept-dot"></span><span><strong>${esc(department.name)}</strong><small>${departmentSummary(roster)}</small></span><span class="department-count">${roster.length}</span>`;
    button.addEventListener('click', () => focusSelection({ type: 'department', id: department.id }));
    $('department-labels').append(button);
    const route = svgElement('path', { d: curvedPath(control, department), class: 'route-path', 'data-route': department.id });
    $('connection-paths').append(route);
  }
}

function createEmployees() {
  labelRevision++;
  $('employee-labels').replaceChildren();
  // DOM order follows department then fixed seat order. No seat coordinates are animated.
  for (const employee of employees) {
    const hit = document.createElement('button');
    hit.className = 'employee-hit';
    hit.dataset.employee = employee.id;
    hit.style.cssText = `left:${employee.x}px;top:${employee.y}px`;
    hit.setAttribute('aria-label', `Focus ${employee.name}, ${employee.role}, ${findDepartment(employee.departmentId).name}`);
    hit.tabIndex = -1;
    hit.addEventListener('click', () => focusSelection({ type: 'employee', id: employee.id }));
    $('employee-labels').append(hit);
    const button = document.createElement('button');
    button.className = `employee-label world-label ${employee.status}${employee.isCustom ? ' custom-agent-label' : ''}`;
    button.style.cssText = `left:${employee.x}px;top:${employee.labelY}px`;
    button.dataset.employee = employee.id;
    button.dataset.departmentId = employee.departmentId;
    button.setAttribute('aria-label', `${employee.name}, ${employee.role}, ${employee.status}. Focus employee`);
    button.title = `${employee.name} · ${employee.role} · ${employee.status}`;
    button.innerHTML = `<span class="dot"></span><span class="employee-name">${esc(employee.name)}</span><span class="employee-role">${esc(employee.role)}</span>`;
    button.addEventListener('click', () => focusSelection({ type: 'employee', id: employee.id }));
    $('employee-labels').append(button);
  }
}

function createRuntimes() {
  $('runtime-buttons').replaceChildren();
  const marks = {
    codex: '<path d="m6 5-4 4 4 4m6-8 4 4-4 4m-2-9L8 14"/>',
    claude: '<path d="M9 1v16M1 9h16M3.4 3.4l11.2 11.2m0-11.2L3.4 14.6M5.9 1.6l6.2 14.8M1.6 5.9l14.8 6.2m-10.5 4.3L12.1 1.6M1.6 12.1l14.8-6.2"/>',
    local: '<rect x="3" y="2" width="12" height="6" rx="1.5"/><rect x="3" y="10" width="12" height="6" rx="1.5"/><path d="M6 5h.1M6 13h.1m3-8h3m-3 8h3"/>',
  };
  for (const runtime of runtimes) {
    const button = document.createElement('button');
    button.className = 'runtime-button';
    button.dataset.runtime = runtime.id;
    button.setAttribute('aria-label', `Inspect ${runtime.name}, ${runtime.kind}. Runtime configuration and observed status`);
    button.innerHTML = `<span class="runtime-mark"><svg viewBox="0 0 18 18">${marks[runtime.id] || marks.local}</svg></span><span><strong>${esc(runtime.name)}</strong><small>${esc(runtime.model)} · ${runtime.status === 'logged_in' || runtime.status === 'ready' ? 'Signed in' : runtime.status || 'Saved'}</small></span><span class="runtime-status"></span>`;
    button.addEventListener('click', () => {
      document.querySelectorAll('.runtime-button').forEach(b => b.classList.toggle('selected', b === button));
      setView('connections');
      sidebar.showRuntime(runtime.id);
      openMobilePanel();
    });
    $('runtime-buttons').append(button);
  }
}

function focusSelection(next, { sync = true } = {}) {
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
    camera.fit();
  } else if (next.type === 'department') {
    const department = findDepartment(next.id);
    if (!department) return;
    title = department.name;
    const custom = employees.filter(employee => employee.departmentId === department.id && employee.isCustom);
    const extraBounds = custom.length ? {x: Math.min(...custom.map(e=>e.x))-110,y:Math.min(...custom.map(e=>e.y))-130,width:Math.max(...custom.map(e=>e.x))-Math.min(...custom.map(e=>e.x))+220,height:Math.max(...custom.map(e=>e.y))-Math.min(...custom.map(e=>e.y))+250} : null;
    camera.focus(next.extra && extraBounds ? extraBounds : department.bounds, { zoom: viewport.clientWidth <= 760 && matchMedia('(max-width:760px)').matches ? 3 : 1.5 });
  } else if (next.type === 'employee') {
    const employee = findEmployee(next.id);
    if (!employee) return;
    title = employee.name;
    camera.focus({ x: employee.x - 100, y: employee.y - 100, width: 200, height: 200 }, { zoom: matchMedia('(max-width:760px)').matches ? 4.4 : 2.2 });
  } else if (next.type === 'control') {
    title = `${agentStore.get('control').name} · Control center`;
    camera.focus(control.bounds, { zoom: matchMedia('(max-width:760px)').matches ? 3 : 1.6 });
  }
  $('selection-name').textContent = title;
  if (sync) sidebar?.select(next);
  if (next.type === 'control') { sidebar?.showTab('chat'); openMobilePanel(); }
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
  else sidebar.showTab('chat');
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

function communicate(event) {
  const from = endpoint(event.from);
  const to = endpoint(event.to);
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
  if (reduceMotion.matches) { packet.remove(); setTimeout(() => group.remove(), 2200); }
  else requestAnimationFrame(step);
  $('communication-label').textContent = event.message || 'Control center handoff';
  sidebar?.addActivity({ ...event, demo: true, at: Date.now() });
}

function setDemoPlayback(play) {
  activeDemo = play;
  clearTimeout(sequenceTimer);
  $('play-communication').setAttribute('aria-label', play ? 'Pause sample communication' : 'Play sample communication');
  $('play-communication').innerHTML = play ? '<svg viewBox="0 0 18 18"><path d="M6 4v10M12 4v10"/></svg>' : '<svg viewBox="0 0 18 18"><path d="m6 4 7 5-7 5V4Z"/></svg>';
  if (!play) { $('communication-label').textContent = 'Preview an agent handoff'; return; }
  const next = () => {
    if (!activeDemo) return;
    communicate(demoCommunications[demoIndex++ % demoCommunications.length]);
    sequenceTimer = setTimeout(next, 5200);
  };
  next();
}

function notice(text) {
  clearTimeout(noticeTimer);
  $('canvas-notice').textContent = text;
  $('canvas-notice').classList.add('visible');
  noticeTimer = setTimeout(() => $('canvas-notice').classList.remove('visible'), 3200);
}

function openMobilePanel() {
  if (matchMedia('(max-width:760px)').matches) {
    document.body.classList.add('panel-open');
    $('mobile-panel').setAttribute('aria-expanded', 'true');
  }
}

function refreshScene() {
  sceneSize = layoutExtraDesks({ employees, departments, element: $('extra-desks') });
  world.style.width = `${sceneSize.width}px`;
  world.style.height = `${sceneSize.height}px`;
  $('scene-lines').setAttribute('viewBox', `0 0 ${sceneSize.width} ${sceneSize.height}`);
  createDepartments();
  createEmployees();
  createRuntimes();
  const coordinator = agentStore.get('control');
  $('coordinator-name').textContent = `${coordinator.name} · ${coordinator.role}`;
  document.querySelector('.office-count .muted').textContent = `· ${departments.filter(d => d.configured).length} departments`;
  $('review-button').querySelector('span').textContent = `${live.tasks?.filter(t=>t.status === 'review' || t.statusLabel === 'Verified').length || 0} to review`;
  $('control-label').setAttribute('aria-label', `${coordinator.name}, ${coordinator.role}. Focus control center`);
  document.querySelector('.office-count strong').textContent = String(employees.length);
  $('agent-count').textContent = String(employees.length);
  camera?.setBounds(sceneSize.width, sceneSize.height);
}
function showAgentManager(mode, id) {
  document.body.classList.add('manager-open');
  openMobilePanel();
  if (mode === 'create') manager.showCreate(id || (selection.type === 'department' ? selection.id : findEmployee(selection.id)?.departmentId));
  else if (mode === 'edit') manager.showEdit(id);
  else manager.showDirectory();
}
function closeAgentManager() {
  manager.hide();
  document.body.classList.remove('manager-open');
}
refreshScene();
sidebar = createSidebar({ coordinator: agentStore.get('control'), onEditAgent: id => showAgentManager('edit', id), onManageAgents: () => showAgentManager('directory'), onAddAgent: id => showAgentManager('create', id), element: $('sidebar'), departments, employees, runtimes, onFocus: next => focusSelection(next, { sync: false }), onCommunication: communicate, onAssignTask: async context => { const result = await reviewTask(context, live.workspaceDoc); if (!result.cancelled) await refreshLive(); return result; }, onOpenTask: task => { location.href = task.href || `/workspace/#/tasks/q/${encodeURIComponent(task.id)}`; } });
sidebar.updateData(live);
camera = createCamera({ viewport, world, width: sceneSize.width, height: sceneSize.height, onChange: updateCamera });
manager = createAgentManager({ element: $('agent-manager'), store: agentStore,
  onFocus: next => { closeAgentManager(); focusSelection(next); },
  onSaved: async saved => { await refreshLive(); focusSelection(saved.isCoordinator ? {type:'control'} : {type:'employee',id:saved.id}); notice(`${saved.name} saved to your workspace.`); },
  onClose: closeAgentManager,
});
$('manage-agents').addEventListener('click', () => showAgentManager('directory'));
$('add-agent').addEventListener('click', () => showAgentManager('create'));
if (agentStore.storageWarning) notice(agentStore.storageWarning);
$('office-home').addEventListener('click', () => focusSelection({ type: 'office' }));
$('office-view').addEventListener('click', () => setView('office'));
$('connections-view').addEventListener('click', () => setView('connections'));
$('zoom-out').addEventListener('click', () => camera.zoomBy(1 / 1.2));
$('zoom-in').addEventListener('click', () => camera.zoomBy(1.2));
$('zoom-fit').addEventListener('click', () => focusSelection({ type: 'office' }));
$('control-label').addEventListener('click', () => focusSelection({ type: 'control' }));
$('control-hit').addEventListener('click', () => focusSelection({ type: 'control' }));
$('review-button').addEventListener('click', () => { if (manager.isOpen()) closeAgentManager(); sidebar.select({ type: 'office' }); sidebar.showTab('tasks'); openMobilePanel(); });
$('runtime-details').addEventListener('click', () => { setView('connections'); openMobilePanel(); });
$('play-communication').addEventListener('click', () => { sidebar.showTab('tasks'); openMobilePanel(); });
$('play-communication').setAttribute('aria-label','Show recorded tasks');
$('communication-label').textContent = 'Follow recorded work';
document.querySelector('.sample-label').textContent = 'WORKSPACE';
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
$('sidebar').addEventListener('office:reviews-changed', event => {
  $('review-button').querySelector('span').textContent = `${event.detail.count} to review`;
  const employee = findEmployee(event.detail.employeeId);
  if (!employee) return;
  employee.status = event.detail.status;
  const label = document.querySelector(`.employee-label[data-employee="${employee.id}"]`);
  label.classList.remove('review', 'working', 'idle');
  label.classList.add(employee.status);
  label.setAttribute('aria-label', `${employee.name}, ${employee.role}, ${employee.status}. Focus employee`);
  label.title = `${employee.name} · ${employee.role} · ${employee.status}`;
  const roster = employees.filter(e => e.departmentId === employee.departmentId);
  const reviews = roster.filter(e => e.status === 'review').length;
  const idle = roster.filter(e => e.status === 'idle').length;
  const heading = document.querySelector(`.department-label[data-department="${employee.departmentId}"]`);
  heading.querySelector('small').textContent = departmentSummary(roster);
  heading.title = `${findDepartment(employee.departmentId).name} · ${departmentSummary(roster)}`;
});
document.addEventListener('visibilitychange', () => { if (document.hidden && activeDemo) setDemoPlayback(false); });
reduceMotion.addEventListener('change', () => { if (activeDemo) setDemoPlayback(false); });
$('canvas').addEventListener('dblclick', event => {
  if (event.target === viewport || event.target === world) focusSelection({ type: 'office' });
});
// Read-only diagnostic state for acceptance checks and future runtime adapter integration.
window.officePreview = { getState: () => ({ selection: { ...selection }, camera: camera.getState(), view, employees: employees.length, specialists: employees.length, demo: false }), focus: focusSelection, communicate, stopDemo: () => setDemoPlayback(false) };
camera.fit();

async function refreshLive() { const next = await loadLiveData(); const key = JSON.stringify([next.workspaceDoc?.workspace,next.tasks]); live = next; if (key === liveKey) return; liveKey = key; agentStore.setWorkspace(live.workspaceDoc); refreshScene(); sidebar.updateData(live); sidebar.refresh(); }
setInterval(() => { if (!manager.isOpen() && !document.querySelector('dialog[open]') && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) refreshLive().catch(error => notice(error.message)); }, 5000);
