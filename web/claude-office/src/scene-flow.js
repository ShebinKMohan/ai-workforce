import * as THREE from './vendor/three.module.min.js';
import { createSceneActivityTracker } from './scene-activity.js';

const COLORS = { active: '#397fad', review: '#8472ae', attention: '#b98331', verified: '#408263', neutral: '#708393' };
const STAGES = ['routing', 'planning', 'working', 'checking', 'reviewing', 'verified'];

/** Bounded transient paths and small workstation lights. Each moving packet is
 * backed by a new receipt; it runs once. The only loop is a quiet light while a
 * known actor has an owned active turn. Rendering stops at idle and when hidden. */
export function createSceneFlow({ element, scene, getNode, requestRender, onOpenTask = () => {} }) {
  const tracker = createSceneActivityTracker(), reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const layer = new THREE.Group(); layer.name = 'recorded-communication'; scene.add(layer);
  const legend = document.createElement('section'); legend.className = 'scene-activity'; legend.setAttribute('aria-label', 'Recorded workspace activity');
  legend.innerHTML = '<div class="scene-activity-heading"><span class="scene-activity-signal" aria-hidden="true"></span><strong role="status" aria-live="polite"></strong><button type="button" class="scene-motion-toggle" aria-label="Pause scene motion"></button></div><button type="button" class="scene-activity-detail"></button><ol class="scene-flow-stages" aria-label="Execution flow"><li>Intake</li><li>Head</li><li>Work</li><li>Checks</li><li>Review</li><li>Reply</li></ol>';
  element.append(legend);
  const title = legend.querySelector('strong'), detail = legend.querySelector('.scene-activity-detail'), toggle = legend.querySelector('.scene-motion-toggle'), steps = [...legend.querySelectorAll('li')];
  detail.onclick = () => { if (model.phase.taskId) onOpenTask(model.phase.taskId); };
  let model = { phase: { stage: 'idle', label: 'No active execution', detail: 'Communication follows recorded task events', tone: 'neutral' }, activeNodes: [], transfers: [] };
  let paused = false, closed = false, effects = [], hardware = [], rings = [], expiry = 0;
  try { paused = localStorage.getItem('workforce.scene.motion.v1') === 'paused'; } catch {}
  const moving = () => !paused && !reduced.matches && !document.hidden;
  function dispose(object) { object.traverse(child => { child.geometry?.dispose(); for (const material of [].concat(child.material || [])) material.dispose(); }); }
  function clearEffects() { for (const item of effects) { layer.remove(item.group); dispose(item.group); } effects = []; clearTimeout(expiry); }
  function clearHardware() {
    for (const item of hardware) item.material.opacity = 0;
    hardware = [];
    for (const ring of rings) { ring.parent?.remove(ring); dispose(ring); } rings = [];
  }
  function refreshLegend() {
    title.textContent = model.phase.label;
    detail.textContent = model.phase.detail || 'Communication follows recorded task events';
    detail.disabled = !model.phase.taskId; detail.title = model.phase.taskId ? `Open recorded task: ${detail.textContent}` : detail.textContent;
    detail.setAttribute('aria-label', detail.title);
    legend.dataset.tone = model.phase.tone;
    const current = STAGES.indexOf(model.phase.stage);
    steps.forEach((step, index) => { step.classList.toggle('is-current', index === current); if (index === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current'); });
    toggle.disabled = reduced.matches;
    toggle.setAttribute('aria-label', reduced.matches ? 'Scene motion off: reduced motion preference' : paused ? 'Resume scene motion' : 'Pause scene motion');
    toggle.setAttribute('aria-pressed', String(paused || reduced.matches)); toggle.title = toggle.getAttribute('aria-label');
    toggle.innerHTML = paused || reduced.matches ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5Z"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10"/></svg>';
    element.classList.toggle('scene-motion-paused', !moving());
  }
  function rebuild() {
    clearHardware();
    // A maximum of 32 visible actor halos keeps large workforces inexpensive.
    // The phase legend remains authoritative when there are more live actors.
    for (const active of model.activeNodes.slice(0, 32)) {
      const group = getNode(active.node); if (!group) continue;
      const color = ['checking', 'reviewing'].includes(active.stage) ? COLORS.review : COLORS.active;
      group.traverse(object => { if (object.name === 'recorded-activity-light') { object.material.color.set(color); object.material.opacity = .75; hardware.push(object); } });
      const ring = new THREE.Mesh(new THREE.RingGeometry(.73, .77, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .52, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(0, .016, .32); ring.name = 'recorded-actor-halo'; group.add(ring); rings.push(ring);
    }
    requestRender();
  }
  function position(key) {
    if (key === 'message') return new THREE.Vector3(3.7, 1.4, 4.1);
    const group = getNode(key); if (!group) return null;
    const point = group.getWorldPosition(new THREE.Vector3()); point.y += 1.9; return point;
  }
  function addTransfer(receipt) {
    const from = position(receipt.from), to = position(receipt.to); if (!from || !to) return;
    let curve;
    if (receipt.from === receipt.to) {
      const points = Array.from({ length: 25 }, (_, i) => new THREE.Vector3(from.x + Math.cos(i / 24 * Math.PI * 2) * .85, from.y - 1.45, from.z + Math.sin(i / 24 * Math.PI * 2) * .85));
      curve = new THREE.CatmullRomCurve3(points);
    } else {
      const middle = from.clone().lerp(to, .5); middle.y += Math.min(2, from.distanceTo(to) * .11 + .45); curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    }
    const color = ['checking', 'reviewing'].includes(receipt.stage) ? COLORS.review : COLORS[receipt.tone] || COLORS.active;
    const group = new THREE.Group(); group.name = `receipt-${receipt.stage}`;
    const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, .025, 5, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .40, depthWrite: false, toneMapped: false })); group.add(line);
    const packet = new THREE.Mesh(new THREE.SphereGeometry(.13, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, toneMapped: false })); group.add(packet);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(.11, .30, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .8, depthWrite: false, toneMapped: false }));
    arrow.position.copy(curve.getPoint(.94)); arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(.94).normalize()); group.add(arrow);
    // When several receipts arrive in one snapshot, preserve the direction of
    // the handoff: a packet reaches the head before leaving for its worker.
    // Independent workers and separate requests may travel concurrently.
    const now = performance.now();
    const predecessors = moving() ? effects.filter(item => item.receipt.taskId === receipt.taskId && item.receipt.to === receipt.from).map(item => item.start + 1600) : [];
    const start = Math.max(now, ...predecessors);
    packet.position.copy(curve.getPoint(moving() ? 0 : .5)); packet.visible = moving(); layer.add(group);
    effects.push({ group, line, packet, arrow, curve, start, end: start + (moving() ? 1900 : 3200), receipt });
  }
  function tick(now = performance.now()) {
    if (closed) return false;
    for (let index = effects.length - 1; index >= 0; index--) {
      const item = effects[index];
      if (now >= item.end) { layer.remove(item.group); dispose(item.group); effects.splice(index, 1); continue; }
      if (!moving()) continue;
      const progress = Math.max(0, Math.min(1, (now - item.start) / 1600));
      item.group.visible = now >= item.start;
      item.packet.position.copy(item.curve.getPoint(progress));
      const opacity = Math.min(1, Math.max(0, (item.end - now) / 300));
      item.line.material.opacity = .4 * opacity; item.arrow.material.opacity = .8 * opacity; item.packet.material.opacity = opacity;
    }
    const illumination = moving() ? .68 + Math.sin(now / 1200) * .08 : .75;
    for (const item of hardware) item.material.opacity = illumination;
    return moving() && (effects.length > 0 || hardware.length > 0);
  }
  function update(input) {
    model = tracker.update(input);
    if (!model.connected || (model.phase.stage === 'attention' && !model.activeNodes.length)) clearEffects();
    // Hidden pages consume receipts without queuing a burst on return.
    if (!document.hidden && model.transfers.length) {
      const latest = model.transfers.slice(-8);
      for (const receipt of latest) {
        if (effects.length >= 8) { const oldest = effects.shift(); layer.remove(oldest.group); dispose(oldest.group); }
        addTransfer(receipt);
      }
      clearTimeout(expiry);
      expiry = setTimeout(() => { tick(); requestRender(); }, Math.max(...effects.map(item => item.end - performance.now()), 0) + 40);
    }
    refreshLegend(); rebuild();
  }
  function preferenceChanged() { clearEffects(); refreshLegend(); requestRender(); }
  toggle.onclick = () => { paused = !paused; try { localStorage.setItem('workforce.scene.motion.v1', paused ? 'paused' : 'enabled'); } catch {} preferenceChanged(); };
  const visibilityChanged = () => { clearEffects(); refreshLegend(); requestRender(); };
  reduced.addEventListener('change', preferenceChanged); document.addEventListener('visibilitychange', visibilityChanged);
  refreshLegend();
  return { update, rebuild, tick, getSnapshot: () => ({ phase: model.phase.stage, activeNodes: model.activeNodes, transferCount: effects.length, transfers: effects.map(item => ({ stage: item.receipt.stage, from: item.receipt.from, to: item.receipt.to })), paused: paused || reduced.matches, visible: !document.hidden }),
    destroy() { closed = true; clearEffects(); clearHardware(); reduced.removeEventListener('change', preferenceChanged); document.removeEventListener('visibilitychange', visibilityChanged); scene.remove(layer); legend.remove(); } };
}
