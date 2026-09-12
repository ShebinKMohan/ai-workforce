/** The user's selected office artwork, with only workspace-derived occupants and status. */
import { esc } from '../render.js';
import { createCamera } from './raster-camera.js';
import { placeLabels } from './raster-label-layout.js';

// Geometry of the user-owned image. A slot is a place in the illustration, not a configured department.
export const RASTER_SCENE = { width: 1402, height: 1122 };
export const OCCUPIED_OFFICE_ART_URL = '/assets/office-inward.png';
export const EMPTY_SEAT_ART_URL = '/assets/office-inward-empty.png';
export const RASTER_ISLANDS = [
  { id: 'research', name: 'Research', color: '#5595c4', veil: '#dfeaf5', x: 440, y: 232, label: [440, 30], seats: [[408, 110], [307, 193], [456, 270], [568, 187]] },
  { id: 'engineering', name: 'Engineering', color: '#5b8daa', veil: '#dce8f3', x: 1030, y: 235, label: [1030, 30], seats: [[1050, 110], [893, 191], [1008, 276], [1152, 192]] },
  { id: 'design', name: 'Design', color: '#d48897', veil: '#eed9d6', x: 245, y: 548, label: [245, 355], seats: [[241, 444], [130, 520], [260, 593], [349, 520]] },
  { id: 'marketing', name: 'Marketing & Sales', color: '#c7a160', veil: '#eee8da', x: 1160, y: 589, label: [1160, 378], seats: [[1158, 455], [1060, 537], [1154, 614], [1268, 530]] },
  { id: 'operations', name: 'Operations & Finance', color: '#a391bb', veil: '#e7e0ed', x: 422, y: 872, label: [422, 675], seats: [[402, 758], [305, 835], [441, 903], [527, 824]] },
  { id: 'support', name: 'Customer Support', color: '#7b9f8e', veil: '#dbe7de', x: 967, y: 894, label: [967, 683], seats: [[972, 775], [876, 858], [963, 925], [1072, 857]] },
];

// Full source-image workstation bounds, separate from each person's interaction anchor.
// Including the whole monitor avoids splicing its occupied and empty screen artwork.
const WORKSTATION_BOUNDS = {
  research: [[359, 65, 505, 215], [261, 151, 408, 299], [405, 229, 551, 370], [516, 146, 649, 298]],
  engineering: [[958, 64, 1098, 216], [812, 150, 947, 299], [914, 226, 1061, 372], [1056, 150, 1202, 296]],
  design: [[197, 397, 335, 529], [85, 474, 216, 604], [217, 545, 349, 680], [303, 474, 425, 606]],
  marketing: [[1076, 410, 1206, 548], [982, 490, 1109, 621], [1064, 568, 1205, 703], [1185, 489, 1316, 623]],
  operations: [[360, 713, 491, 842], [259, 791, 394, 921], [385, 857, 522, 991], [485, 779, 610, 911]],
  support: [[888, 728, 1015, 856], [795, 802, 920, 929], [881, 880, 1004, 1015], [990, 810, 1123, 944]],
};

const activeWord = (word) => ['Planning', 'Working', 'Being checked', 'Waiting'].includes(word);
export const initialRasterMode = (width, savedMode = null) => savedMode ?? (width <= 680 ? 'team' : 'map');

/** Label matching chooses a visual island only; department membership always comes from workspace records. */
export function rasterModel(floor) {
  const remaining = new Set(RASTER_ISLANDS.map((island) => island.id));
  const mapping = new Map();
  const overflowDepartments = [];
  const words = { research: /research|knowledge|analysis/i, engineering: /engineering|development|software|coding/i, design: /design|creative|ux/i, marketing: /marketing|sales|content/i, operations: /operations|finance|admin/i, support: /support|customer/i };
  // Reserve name-matched slots first, so a custom first department cannot displace Engineering.
  const waiting = [];
  for (const department of floor.departments) {
    const slot = RASTER_ISLANDS.find((island) => remaining.has(island.id) && words[island.id].test(department.label));
    if (!slot) { waiting.push(department); continue; }
    mapping.set(slot.id, department);
    remaining.delete(slot.id);
  }
  for (const department of waiting) {
    const id = remaining.values().next().value;
    if (!id) { overflowDepartments.push(department); continue; }
    mapping.set(id, department);
    remaining.delete(id);
  }
  const islands = RASTER_ISLANDS.map((slot) => {
    const department = mapping.get(slot.id) ?? null;
    return { ...slot, department, seats: slot.seats.map(([x, y], index) => ({ id: `${slot.id}-${index}`, x, y, desk: department?.desks[index] ?? null })) };
  });
  const overflow = [...islands.flatMap((island) => island.department?.desks.slice(4) ?? []), ...overflowDepartments.flatMap((department) => department.desks)];
  return { islands, overflow, overflowDepartments, totalAgents: floor.departments.reduce((sum, department) => sum + department.desks.length, 0), assignedSeats: islands.flatMap((island) => island.seats).filter((seat) => seat.desk).length };
}

/** A source-aligned whole workstation crop. Configured seats retain the occupied artwork. */
export function seatPatch(seat) {
  const [islandId, index] = seat.id.split('-');
  const [left, top, right, bottom] = WORKSTATION_BOUNDS[islandId][Number(index)];
  return { left, top, width: right - left, height: bottom - top };
}

function openSeatOverlay(seat, island, emptyArtUrl) {
  if (emptyArtUrl && /^\/assets\/[a-zA-Z0-9_./-]+$/.test(emptyArtUrl)) {
    const patch = seatPatch(seat);
    return `<span class="raster-seat-patch" data-raster-open-seat="${seat.id}" style="left:${patch.left}px;top:${patch.top}px;width:${patch.width}px;height:${patch.height}px;background-image:url('${esc(emptyArtUrl)}');background-position:-${patch.left}px -${patch.top}px" aria-hidden="true"></span>`;
  }
  return `<span class="raster-seat-veil" data-raster-open-seat="${seat.id}" style="left:${seat.x}px;top:${seat.y}px;--veil-color:${island.veil}" aria-hidden="true"></span>`;
}

function departmentLabel(island, floor) {
  const department = island.department;
  const title = department ? department.label : `${island.name} island`;
  const count = department ? department.desks.length : 0;
  const line = department ? `${department.counts}${department.desks.length > 4 ? ' · more in Team list' : ''}` : 'Unassigned · add a department';
  const href = department ? department.href : floor.createTile.enabled ? floor.createTile.href : '#/home';
  return `<a class="raster-label raster-department${department ? '' : ' is-unassigned'}" href="${esc(href)}" data-raster-label data-raster-x="${island.label[0]}" data-raster-y="${island.label[1]}" aria-label="${esc(title)}. ${esc(line)}" style="left:${island.label[0]}px;top:${island.label[1]}px;--island-color:${esc(department?.colorHex || island.color)}"><span class="raster-dot" aria-hidden="true"></span><span><strong>${esc(title)}</strong><small>${esc(line)}</small></span>${department ? `<span class="raster-department-count">${count}</span>` : ''}</a>`;
}

function personLabel(seat, island) {
  const desk = seat.desk;
  const x = seat.x;
  const y = seat.y - 36;
  if (!desk) return `<span class="raster-label raster-person raster-open" data-raster-label data-raster-x="${x}" data-raster-y="${y}" style="left:${x}px;top:${y}px" aria-label="Open desk. No agent configured.">Open desk</span>`;
  const line = `${desk.role === 'head' ? 'Head · ' : ''}${desk.statusWord}`;
  return `<a class="raster-person-hit" href="${esc(desk.href)}" style="left:${x}px;top:${seat.y}px" aria-hidden="true" tabindex="-1"></a><a class="raster-label raster-person${activeWord(desk.statusWord) ? ' is-active' : ''} tone-${esc(desk.tone)}" href="${esc(desk.href)}" data-raster-agent="${esc(desk.agentId)}" data-raster-label data-raster-x="${x}" data-raster-y="${y}" aria-label="${esc(desk.ariaLabel)}" title="${esc(desk.ariaLabel)}" style="left:${x}px;top:${y}px"><span class="raster-dot" aria-hidden="true"></span><span><strong>${esc(desk.name)}</strong><small>${esc(line)}</small></span></a>`;
}

function teamHtml(floor) {
  return `<div class="raster-team-list" data-raster-team hidden><header><h2>Your team</h2><p>Every configured person, including anyone beyond the illustration's seats.</p></header>${floor.departments.map((department) => `<section><div class="raster-team-heading"><h3><a href="${esc(department.href)}">${esc(department.label)}</a></h3><span>${esc(department.counts)}</span></div><ul>${department.desks.map((desk) => `<li><a href="${esc(desk.href)}" aria-label="${esc(desk.ariaLabel)}"><span class="raster-team-avatar" aria-hidden="true">${esc(desk.name.slice(0, 1))}</span><span><strong>${esc(desk.name)}</strong><small>${desk.role === 'head' ? 'Department head' : esc(desk.roleLine || 'Worker')}</small></span><span class="raster-team-status tone-${esc(desk.tone)}">${esc(desk.statusWord)}</span></a></li>`).join('') || '<li class="muted">No team members yet.</li>'}</ul></section>`).join('') || '<p class="raster-team-empty">Add a project and a department to bring your team into the office.</p>'}<a class="button" href="${floor.createTile.enabled ? esc(floor.createTile.href) : '#/home'}">${floor.createTile.enabled ? 'Add a department' : 'Set up your workspace'}</a></div>`;
}

export function rasterOfficeHtml(floor, counts = { active: 0, queued: 0 }, { runtimeHtml = '', emptyArtUrl = EMPTY_SEAT_ART_URL } = {}) {
  const model = rasterModel(floor);
  const veils = model.islands.flatMap((island) => island.seats.filter((seat) => !seat.desk).map((seat) => openSeatOverlay(seat, island, emptyArtUrl))).join('');
  const routes = model.islands.filter((island) => island.department).map((island) => `<path d="M714 529 Q${island.x} 529 ${island.x} ${island.y}"/>`).join('');
  const art = `<div class="raster-world" data-raster-world><img class="raster-art" src="${OCCUPIED_OFFICE_ART_URL}" width="1402" height="1122" draggable="false" alt="Illustrated office with six islands, ${model.assignedSeats} configured people at their desks and ${24 - model.assignedSeats} open desks. The center represents the system scheduler." />${veils}<svg class="raster-routes" viewBox="0 0 1402 1122" aria-hidden="true">${routes}</svg>${model.islands.map((island) => departmentLabel(island, floor)).join('')}${model.islands.flatMap((island) => island.seats.map((seat) => personLabel(seat, island))).join('')}<a class="raster-label raster-control" href="#/tasks" data-raster-label data-raster-x="714" data-raster-y="437" style="left:714px;top:437px" aria-label="Coordinator, system scheduler. ${counts.active} active tasks and ${counts.queued} queued. Open tasks."><span class="raster-control-symbol" aria-hidden="true">⌘</span><span><strong>COORDINATOR</strong><small>System scheduler · ${counts.active} active · ${counts.queued} queued</small></span></a></div>`;
  return `<section class="raster-office-scene" data-raster-office aria-label="Agent office"><div class="raster-scene-top" data-camera-ignore><div class="raster-breadcrumb"><span>Office</span><span aria-hidden="true">/</span><strong data-raster-view-label>Overview</strong></div><div class="raster-view-switch" role="group" aria-label="Office view"><button type="button" data-live-action data-raster-mode="map" aria-pressed="true">Office</button><button type="button" data-live-action data-raster-mode="connections" aria-pressed="false">Connections</button><button type="button" data-live-action data-raster-mode="team" aria-pressed="false">Team list</button></div></div><div class="raster-viewport" data-raster-viewport tabindex="0" aria-label="Office map. Drag to pan, pinch or use plus and minus to zoom. Press zero to fit." aria-describedby="raster-help">${art}</div>${teamHtml(floor)}<div class="raster-scene-bottom" data-camera-ignore><p id="raster-help" class="raster-help" data-raster-help>${model.totalAgents ? 'Your configured team · Open desks are unassigned' : 'No team configured yet · Add your first department'}${model.overflow.length ? `<button type="button" data-live-action data-raster-mode="team">${model.overflow.length} more ${model.overflow.length === 1 ? 'person' : 'people'} in Team list ↗</button>` : ''}</p><div class="raster-footer-row">${runtimeHtml || '<a class="raster-tools-link" href="#/settings">Tools & runtime settings ↗</a>'}<div class="raster-camera-controls" role="group" aria-label="Office map zoom"><button type="button" data-live-action data-raster-zoom="out" aria-label="Zoom out">−</button><span data-raster-zoom-label>100%</span><button type="button" data-live-action data-raster-zoom="in" aria-label="Zoom in">+</button><span class="raster-control-divider"></span><button type="button" data-live-action data-raster-zoom="fit" aria-label="Fit office to view">⛶</button></div></div></div></section>`;
}

const preferences = { mode: null, camera: null };
let active = null;
let frame = 0;

export function destroyRasterOffice() {
  if (!active) return;
  preferences.camera = active.camera.getState();
  active.camera.destroy();
  active = null;
  cancelAnimationFrame(frame);
}

/** Mount exactly once per rendered scene; destroy the old camera before attaching another. */
export function activateRasterOffice(container) {
  const scene = container?.querySelector?.('[data-raster-office]');
  if (!scene) { destroyRasterOffice(); return; }
  if (active?.scene === scene) return;
  destroyRasterOffice();
  const viewport = scene.querySelector('[data-raster-viewport]');
  const world = scene.querySelector('[data-raster-world]');
  const labels = [...world.querySelectorAll('[data-raster-label]')];
  const layoutLabels = (state) => {
    if (!scene.isConnected || viewport.hidden || viewport.clientWidth <= 16 || viewport.clientHeight <= 0) return;
    const density = viewport.clientWidth < 550 ? .87 : 1;
    world.style.setProperty('--raster-label-scale', String(density / state.scale));
    for (const label of labels) { label.style.setProperty('--label-dx', '0px'); label.style.setProperty('--label-dy', '0px'); }
    const compact = viewport.clientWidth < 680 && state.scale / state.fitScale < 1.7;
    scene.dataset.rasterCompact = String(compact);
    const items = labels.filter((label) => !(compact && label.classList.contains('raster-open'))).map((label, index) => {
      const box = label.getBoundingClientRect();
      return { id: String(index), x: state.x + Number(label.dataset.rasterX) * state.scale - box.width / 2, y: state.y + Number(label.dataset.rasterY) * state.scale - box.height, width: Math.min(box.width, viewport.clientWidth - 16), height: box.height, label };
    }).filter((item) => item.x + item.width > -20 && item.x < viewport.clientWidth + 20 && item.y + item.height > -20 && item.y < viewport.clientHeight + 20);
    const placed = placeLabels(items, { gap: 5, bounds: { left: 8, right: viewport.clientWidth - 8 } });
    placed.forEach((item, i) => {
      item.label.style.setProperty('--label-dx', `${(item.x - items[i].x) / state.scale}px`);
      item.label.style.setProperty('--label-dy', `${(item.y - items[i].y) / state.scale}px`);
    });
  };
  const previousCamera = preferences.camera;
  const camera = createCamera({ viewport, world, ...RASTER_SCENE, onChange(state) {
    preferences.camera = state;
    const label = scene.querySelector('[data-raster-zoom-label]');
    if (label) label.textContent = `${Math.round(state.scale / state.fitScale * 100)}%`;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => layoutLabels(state));
  } });
  active = { scene, camera };
  if (previousCamera) camera.restore(previousCamera);
  const setMode = (mode) => {
    preferences.mode = mode;
    const team = mode === 'team';
    scene.dataset.rasterView = mode;
    scene.parentElement?.classList.toggle('raster-team-active', team);
    viewport.hidden = team;
    scene.querySelector('[data-raster-team]').hidden = !team;
    scene.querySelector('.raster-scene-bottom').hidden = team;
    scene.querySelector('[data-raster-view-label]').textContent = team ? 'Your team' : mode === 'connections' ? 'Configured routing' : 'Overview';
    scene.querySelectorAll('[data-raster-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rasterMode === mode)));
    if (!team) requestAnimationFrame(() => layoutLabels(camera.getState()));
  };
  scene.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.rasterMode) setMode(button.dataset.rasterMode);
    if (button?.dataset.rasterZoom === 'in') camera.zoomBy(1.18);
    if (button?.dataset.rasterZoom === 'out') camera.zoomBy(1 / 1.18);
    if (button?.dataset.rasterZoom === 'fit') camera.fit({ immediate: true });
  });
  setMode(initialRasterMode(window.innerWidth, preferences.mode));
}
