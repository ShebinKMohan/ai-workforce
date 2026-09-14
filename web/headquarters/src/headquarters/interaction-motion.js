import { animate } from './assets/motion.js';

// Motion is a progressive enhancement. Live receipts and controls never wait for it.
const running = new Map();
const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let inputMode = 'pointer';
export function canAnimate() { return !reduced?.matches && inputMode !== 'keyboard'; }
function transition(element, keyframes, duration = .18) {
  if (!element || !canAnimate() || !element.animate) return;
  running.get(element)?.cancel();
  const playback = animate(element, keyframes, { duration, ease: [.22, 1, .36, 1] });
  running.set(element, playback);
  Promise.resolve(playback).then(() => { if (running.get(element) === playback) running.delete(element); });
}
export function revealPanel(element) { transition(element, { opacity: [.5, 1], transform: ['translateY(5px)', 'translateY(0px)'] }, .2); }
export function revealTask(element) { transition(element, { opacity: [.4, 1], transform: ['translateY(5px)', 'translateY(0px)'] }); }
export function acknowledgeStatus(element) { transition(element, { opacity: [.45, 1] }, .16); }
export function installInteractionMotion(root = document) {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  root.addEventListener('keydown', () => { inputMode = 'keyboard'; }, options);
  root.addEventListener('pointerdown', event => {
    inputMode = 'pointer';
    const button = event.target.closest?.('button:not(:disabled)');
    if (!button || button.closest('.fleet-filters,.fleet-work-filters,.cc-task-filters')) return;
    transition(button, { transform: ['scale(.985)', 'scale(1)'] }, .14);
  }, options);
  root.addEventListener('toggle', event => {
    if (event.target.open) revealPanel(event.target.querySelector(':scope > :not(summary)'));
  }, options);
  const stop = () => { for (const playback of running.values()) playback.cancel(); running.clear(); };
  reduced?.addEventListener('change', stop, { signal: controller.signal });
  return () => { controller.abort(); stop(); };
}
