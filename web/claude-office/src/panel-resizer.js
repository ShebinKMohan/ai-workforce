/** A pointer- and keyboard-operable split pane; storage is a preference only. */
export function createPanelResizer(element, { storageKey = 'workforce-panel-width-v1', defaultWidth = 430 } = {}) {
  const root = document.documentElement;
  let width = defaultWidth;
  try { const saved = Number(localStorage.getItem(storageKey)); if (saved >= 340 && saved <= 760) width = saved; } catch {}
  let preferredWidth = width;
  const bounds = () => ({ min: 340, max: Math.min(760, Math.max(340, innerWidth - 365)) });
  function apply(next, persist = false) {
    const { min, max } = bounds();
    width = Math.round(Math.min(max, Math.max(min, next)));
    root.style.setProperty('--panel-width', `${width}px`);
    element.setAttribute('aria-valuemin', String(min));
    element.setAttribute('aria-valuemax', String(max));
    element.setAttribute('aria-valuenow', String(width));
    element.setAttribute('aria-valuetext', `${width} pixels wide`);
    if (persist) {
      preferredWidth = width;
      try { localStorage.setItem(storageKey, String(width)); } catch {}
    }
  }
  let pointer = null;
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, width };
    element.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-panel');
    event.preventDefault();
  });
  element.addEventListener('pointermove', event => {
    if (pointer?.id === event.pointerId) apply(pointer.width + pointer.x - event.clientX);
  });
  const finish = event => {
    if (pointer?.id !== event.pointerId) return;
    pointer = null;
    document.body.classList.remove('resizing-panel');
    apply(width, true);
  };
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  element.addEventListener('lostpointercapture', finish);
  element.addEventListener('dblclick', () => apply(defaultWidth, true));
  element.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const { min, max } = bounds();
    apply(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 64 : 16), true);
  });
  const resize = () => apply(preferredWidth);
  addEventListener('resize', resize);
  apply(width);
  return { destroy: () => removeEventListener('resize', resize) };
}
