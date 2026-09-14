const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const instant = value => typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN;

/** Elapsed wall time from recorded boundaries; absence is not zero usage. */
export function durationSeconds(start, end, now = Date.now()) {
  const from = instant(start), to = end === null || end === undefined || end === '' ? now : instant(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 1000));
}
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds))), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}
export function renderDuration({ start, end, active = false, label = 'Elapsed', className = '' } = {}) {
  const seconds = end || active ? durationSeconds(start, end) : null;
  const description = Number.isFinite(instant(start)) ? `${new Date(instant(start)).toLocaleString()}${end && Number.isFinite(instant(end)) ? ` → ${new Date(instant(end)).toLocaleString()}` : active ? ' → now' : ' · finish time not recorded'}` : 'Start time not recorded';
  return `<span class="phase-duration ${escape(className)}" data-duration-start="${escape(start)}" data-duration-end="${escape(end)}" data-duration-active="${active ? 'true' : 'false'}" title="${escape(description)}">${label ? `<span class="phase-duration-label">${escape(label)}</span> ` : ''}<span data-duration-value>${formatDuration(seconds)}</span></span>`;
}
/** Update text only: preserve focus, scroll, avatars and keyed task rows. */
export function refreshTimeDisplays(root = document, now = Date.now()) {
  let changed = 0;
  for (const node of root.querySelectorAll('[data-duration-start]')) {
    const target = node.querySelector('[data-duration-value]');
    if (!target) continue;
    const { durationStart: start, durationEnd: end, durationActive: active } = node.dataset;
    const text = formatDuration(end || active === 'true' ? durationSeconds(start, end, now) : null);
    if (target.textContent !== text) { target.textContent = text; changed++; }
  }
  for (const clock of root.querySelectorAll('[data-live-clock]')) {
    const date = new Date(now), text = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    if (clock.textContent !== text) { clock.textContent = text; changed++; }
    clock.setAttribute('datetime', date.toISOString());
    clock.title = `${date.toLocaleDateString([], { weekday:'long', day:'numeric', month:'long', year:'numeric' })} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  }
  return changed;
}
