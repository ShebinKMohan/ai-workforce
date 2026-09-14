import { portraitById } from './avatar-catalog.js';

const hashIdentity = value => {
  const hash = [...String(value)].reduce((number, character) => (Math.imul(number, 31) + character.charCodeAt(0)) >>> 0, 7);
  const mixed = Math.imul(hash ^ (hash >>> 16), 2246822507) >>> 0;
  return (mixed ^ (mixed >>> 13)) >>> 0;
};
const sequence = Object.freeze([
  { frame: 0, duration: 4800 }, { frame: 1, duration: 130 },
  { frame: 0, duration: 1800 }, { frame: 2, duration: 650 },
  { frame: 0, duration: 4200 }, { frame: 1, duration: 150 },
  { frame: 0, duration: 2200 }, { frame: 3, duration: 950 },
]);

/** Decorative human expressions only. Operational status comes from the surrounding recorded task UI. */
export function renderAnimatedAvatar(portrait, size = 28, identityKey = '') {
  const known = portraitById(portrait?.id);
  if (!known?.spriteSrc) return '';
  const dimension = Math.max(16, Math.min(320, Number(size) || 28));
  const seed = hashIdentity(`${identityKey}:${known.id}`);
  return `<span class="avatar avatar-portrait avatar-human" data-avatar-id="${known.id}" data-avatar-animated data-avatar-seed="${seed}" style="width:${dimension}px;height:${dimension}px" aria-hidden="true"><span class="avatar-human-frame" style="background-image:url('${known.spriteSrc}');background-position:0% 0%"></span></span>`;
}

/** No animation loop is scheduled while hidden, reduced-motion, detached, or outside the viewport. */
export function startAvatarAnimations(root = globalThis.document) {
  const doc = root?.ownerDocument || root;
  const win = doc?.defaultView || globalThis;
  if (!root?.querySelectorAll || !doc?.addEventListener || !win.IntersectionObserver || !win.MutationObserver || !win.matchMedia) return () => {};
  const preference = win.matchMedia('(prefers-reduced-motion: reduce)');
  const records = new Map();
  let disposed = false;
  const setFrame = (record, frame) => {
    record.frame.style.backgroundPosition = `${frame * 100 / 3}% 0%`;
    record.node.dataset.avatarFrame = String(frame);
  };
  const stop = record => {
    if (record.timer !== null) win.clearTimeout(record.timer);
    record.timer = null;
    record.step = 0;
    setFrame(record, 0);
  };
  const allowed = record => !disposed && !preference.matches && !doc.hidden && record.visible && record.node.isConnected;
  const schedule = (record, initial = false) => {
    if (!allowed(record) || record.timer !== null) return;
    const stage = sequence[record.step];
    const delay = stage.duration + (initial ? record.seed % 2900 : stage.frame === 0 ? record.seed % 700 : 0);
    record.timer = win.setTimeout(() => {
      record.timer = null;
      if (!allowed(record)) { stop(record); return; }
      record.step = (record.step + 1) % sequence.length;
      setFrame(record, sequence[record.step].frame);
      schedule(record);
    }, delay);
  };
  const intersection = new win.IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (!record) continue;
      record.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      if (allowed(record)) schedule(record, true); else stop(record);
    }
  }, { threshold: 0.05 });
  const scan = () => {
    if (disposed) return;
    for (const [node, record] of records) if (!node.isConnected || !root.contains(node)) { stop(record); intersection.unobserve(node); records.delete(node); }
    for (const node of root.querySelectorAll('[data-avatar-animated]')) {
      if (records.has(node)) continue;
      const frame = node.querySelector('.avatar-human-frame');
      if (!frame) continue;
      const record = { node, frame, timer: null, step: 0, visible: false, seed: Number(node.dataset.avatarSeed) || 0 };
      records.set(node, record); setFrame(record, 0); intersection.observe(node);
    }
  };
  const synchronize = () => {
    for (const record of records.values()) if (allowed(record)) schedule(record, true); else stop(record);
  };
  const mutation = new win.MutationObserver(changes => {
    // Clock and elapsed-time text changes never add or remove an avatar.
    // Avoid rescanning the entire dashboard for those one-second updates.
    if (!changes || changes.some(change => [...change.addedNodes, ...change.removedNodes].some(node =>
      node.nodeType === 1 && (node.matches?.('[data-avatar-animated]') || node.querySelector?.('[data-avatar-animated]'))
    ))) scan();
  });
  mutation.observe(root, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', synchronize);
  preference.addEventListener('change', synchronize);
  scan();
  return () => {
    disposed = true;
    mutation.disconnect(); intersection.disconnect();
    doc.removeEventListener('visibilitychange', synchronize);
    preference.removeEventListener('change', synchronize);
    for (const record of records.values()) stop(record);
    records.clear();
  };
}
