/**
 * An image-plane camera with pointer pan, touch pinch and animated focus.
 *
 * focus(rect, { zoom: 1.5 }) caps zoom relative to the current overview fit.
 * Use zoom: 2.2 for an employee. maxScale and scale use absolute CSS scales.
 * Both fit() and focus() accept { immediate: true } to skip animation.
 * Controls inside the viewport can opt out with data-camera-ignore.
 */
export function createCamera({
  viewport,
  world,
  width = 1402,
  height = 1122,
  onChange = () => {},
}) {
  if (!viewport || !world) {
    throw new TypeError('createCamera requires viewport and world elements.');
  }

  const minScale = 0.05;
  const maxScale = 2.4;
  const padding = { top: 90, bottom: 115, left: 35, right: 35 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const originalStyle = {
    transform: world.style.transform,
    transformOrigin: world.style.transformOrigin,
    touchAction: viewport.style.touchAction,
  };
  const originalTabIndex = viewport.getAttribute('tabindex');
  const pointers = new Map();
  const removers = [];
  let state = { x: 0, y: 0, scale: minScale };
  let size = measure();
  let mode = 'overview';
  let focusTarget = null;
  let animationFrame = 0;
  let dragging = false;
  let pinch = null;
  let suppressClickUntil = 0;
  let destroyed = false;

  world.style.transformOrigin = '0 0';
  viewport.style.touchAction = 'none';
  if (originalTabIndex === null) viewport.tabIndex = 0;

  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    removers.push(() => target.removeEventListener(type, listener, options));
  }

  function measure() {
    return {
      width: Math.max(1, viewport.clientWidth),
      height: Math.max(1, viewport.clientHeight),
    };
  }

  function usableArea() {
    // Keep a useful drawing area even inside a very small responsive panel.
    const horizontalRatio = Math.min(1, size.width / 240);
    const verticalRatio = Math.min(1, size.height / 360);
    const left = padding.left * horizontalRatio;
    const right = padding.right * horizontalRatio;
    const top = padding.top * verticalRatio;
    const bottom = padding.bottom * verticalRatio;
    return {
      left,
      top,
      width: Math.max(1, size.width - left - right),
      height: Math.max(1, size.height - top - bottom),
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function fitScale() {
    const area = usableArea();
    return clamp(Math.min(area.width / width, area.height / height), minScale, maxScale);
  }

  function center() {
    const area = usableArea();
    return { x: area.left + area.width / 2, y: area.top + area.height / 2 };
  }

  function constrain(next) {
    const scale = clamp(next.scale, minScale, maxScale);
    const area = usableArea();
    function axis(value, contentSize, origin, availableSize) {
      const slack = Math.min(120, availableSize * 0.2);
      if (contentSize <= availableSize) {
        const middle = origin + (availableSize - contentSize) / 2;
        return clamp(value, middle - slack, middle + slack);
      }
      return clamp(value, origin + availableSize - contentSize - slack, origin + slack);
    }
    return {
      x: axis(next.x, width * scale, area.left, area.width),
      y: axis(next.y, height * scale, area.top, area.height),
      scale,
    };
  }

  function getState() {
    return { ...state, minScale, maxScale, fitScale: fitScale(), mode };
  }

  function render(next) {
    if (destroyed) return;
    state = constrain(next);
    world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    onChange(getState());
  }

  function stopAnimation() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }

  function animateTo(target, options = {}) {
    stopAnimation();
    const next = constrain(target);
    if (options.immediate || reducedMotion.matches) {
      render(next);
      return;
    }
    const previous = { ...state };
    const start = performance.now();
    const duration = options.duration ?? 520;
    if (duration <= 0) {
      render(next);
      return;
    }
    function frame(now) {
      const progress = clamp((now - start) / duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      render({
        x: previous.x + (next.x - previous.x) * eased,
        y: previous.y + (next.y - previous.y) * eased,
        scale: previous.scale + (next.scale - previous.scale) * eased,
      });
      if (progress < 1) animationFrame = requestAnimationFrame(frame);
      else animationFrame = 0;
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function overviewState() {
    const scale = fitScale();
    const middle = center();
    return { x: middle.x - (width * scale) / 2, y: middle.y - (height * scale) / 2, scale };
  }

  function fit(options = {}) {
    mode = 'overview';
    focusTarget = null;
    animateTo(overviewState(), options);
  }

  function focusedState(rect, options) {
    const area = usableArea();
    const inset = options.padding ?? 35;
    const overview = fitScale();
    const relativeZoom = options.zoom ?? (rect.width <= 180 && rect.height <= 220 ? 2.2 : 1.5);
    const cap = options.maxScale ?? overview * relativeZoom;
    const containScale = Math.min(
      Math.max(1, area.width - inset * 2) / Math.max(1, rect.width),
      Math.max(1, area.height - inset * 2) / Math.max(1, rect.height),
    );
    const scale = clamp(
      options.scale ?? Math.min(Math.max(overview, containScale), cap),
      minScale,
      maxScale,
    );
    const middle = center();
    return {
      x: middle.x - (rect.x + rect.width / 2) * scale,
      y: middle.y - (rect.y + rect.height / 2) * scale,
      scale,
    };
  }

  function focus(rect, options = {}) {
    if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite)) {
      throw new TypeError('Camera focus requires a finite x, y, width and height.');
    }
    mode = 'focus';
    focusTarget = { rect: { ...rect }, options: { ...options } };
    animateTo(focusedState(rect, options), options);
  }

  function manual() {
    stopAnimation();
    mode = 'manual';
    focusTarget = null;
  }

  function zoomBy(factor, point = center()) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    manual();
    const scale = clamp(state.scale * factor, minScale, maxScale);
    const ratio = scale / state.scale;
    // point uses coordinates local to the viewport, including its padding.
    render({ x: point.x - (point.x - state.x) * ratio, y: point.y - (point.y - state.y) * ratio, scale });
  }

  function localPoint(event) {
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function ignoresCamera(target) {
    return target instanceof Element && Boolean(target.closest('[data-camera-ignore]'));
  }

  function setDragging(value) {
    dragging = value;
    viewport.classList.toggle('is-panning', value);
  }

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  function capturePointers() {
    for (const id of pointers.keys()) {
      // A released pointer can briefly remain in the queue on some browsers.
      try { viewport.setPointerCapture(id); } catch { /* Already released. */ }
    }
  }

  function pointerDown(event) {
    if (event.button !== 0 || ignoresCamera(event.target)) return;
    stopAnimation();
    const point = localPoint(event);
    pointers.set(event.pointerId, { ...point, startX: point.x, startY: point.y, type: event.pointerType });
    if (pointers.size >= 2) {
      manual();
      setDragging(true);
      pinch = pinchState();
      capturePointers();
    }
    // Leave ordinary presses uncaptured so click targets remain the hotspots.
  }

  function pointerMove(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const previous = { x: pointer.x, y: pointer.y };
    Object.assign(pointer, localPoint(event));
    if (pointers.size >= 2) {
      event.preventDefault();
      const next = pinchState();
      const old = pinch ?? next;
      const scale = clamp(state.scale * next.distance / old.distance, minScale, maxScale);
      const ratio = scale / state.scale;
      render({ x: next.x - (old.x - state.x) * ratio, y: next.y - (old.y - state.y) * ratio, scale });
      pinch = next;
      return;
    }
    const threshold = pointer.type === 'touch' ? 7 : 4;
    const crossedThreshold = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= threshold;
    if (!dragging && !crossedThreshold) return;
    event.preventDefault();
    const origin = dragging ? previous : { x: pointer.startX, y: pointer.startY };
    if (!dragging) {
      manual();
      setDragging(true);
      capturePointers();
    }
    render({ ...state, x: state.x + pointer.x - origin.x, y: state.y + pointer.y - origin.y });
  }

  function pointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    if (dragging) suppressClickUntil = performance.now() + 500;
    pointers.delete(event.pointerId);
    try { viewport.releasePointerCapture(event.pointerId); } catch { /* Not captured. */ }
    if (pointers.size >= 2) pinch = pinchState();
    else pinch = null;
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
    }
    if (!pointers.size) setDragging(false);
  }

  function wheel(event) {
    if (ignoresCamera(event.target)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
    if (event.ctrlKey || event.metaKey) {
      zoomBy(Math.exp(clamp(-event.deltaY * unit * 0.008, -0.5, 0.5)), localPoint(event));
      return;
    }
    manual();
    const horizontal = event.shiftKey && !event.deltaX;
    const dx = (horizontal ? event.deltaY : event.deltaX) * unit;
    const dy = (horizontal ? 0 : event.deltaY) * unit;
    render({ ...state, x: state.x - dx, y: state.y - dy });
  }

  function keyboard(event) {
    if (event.target instanceof Element && event.target.closest(
      '[data-camera-ignore], input, textarea, select, button, a, [role="button"], [contenteditable="true"]',
    )) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const amount = event.shiftKey ? 120 : 60;
    const deltas = {
      ArrowLeft: [amount, 0], ArrowRight: [-amount, 0],
      ArrowUp: [0, amount], ArrowDown: [0, -amount],
    };
    if (deltas[event.key]) {
      event.preventDefault();
      manual();
      const [dx, dy] = deltas[event.key];
      render({ ...state, x: state.x + dx, y: state.y + dy });
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.18);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomBy(1 / 1.18);
    } else if (event.key === '0' || event.key === 'Home') {
      event.preventDefault();
      fit();
    }
  }

  function resize() {
    if (destroyed) return;
    const previous = size;
    const oldCenter = center();
    size = measure();
    if (size.width === previous.width && size.height === previous.height) return;
    stopAnimation();
    if (mode === 'overview') render(overviewState());
    else if (mode === 'focus' && focusTarget) render(focusedState(focusTarget.rect, focusTarget.options));
    else {
      const nextCenter = center();
      render({ ...state, x: state.x + nextCenter.x - oldCenter.x, y: state.y + nextCenter.y - oldCenter.y });
    }
  }

  listen(viewport, 'pointerdown', pointerDown);
  listen(window, 'pointermove', pointerMove, { passive: false });
  listen(window, 'pointerup', pointerEnd);
  listen(window, 'pointercancel', pointerEnd);
  listen(viewport, 'wheel', wheel, { passive: false });
  listen(viewport, 'keydown', keyboard);
  listen(viewport, 'dragstart', (event) => {
    if (!ignoresCamera(event.target)) event.preventDefault();
  });
  listen(viewport, 'click', (event) => {
    if (event.detail !== 0 && performance.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  listen(window, 'blur', () => {
    if (dragging) suppressClickUntil = performance.now() + 500;
    pointers.clear();
    pinch = null;
    setDragging(false);
  });

  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  fit({ immediate: true });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopAnimation();
    observer.disconnect();
    removers.forEach(remove => remove());
    for (const id of pointers.keys()) {
      try { viewport.releasePointerCapture(id); } catch { /* Not captured. */ }
    }
    pointers.clear();
    viewport.classList.remove('is-panning');
    world.style.transform = originalStyle.transform;
    world.style.transformOrigin = originalStyle.transformOrigin;
    viewport.style.touchAction = originalStyle.touchAction;
    if (originalTabIndex === null) viewport.removeAttribute('tabindex');
    else viewport.setAttribute('tabindex', originalTabIndex);
  }

  function setBounds(nextWidth, nextHeight) {
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) return;
    width = nextWidth;
    height = nextHeight;
    stopAnimation();
    if (mode === 'overview') render(overviewState());
    else if (mode === 'focus' && focusTarget) render(focusedState(focusTarget.rect, focusTarget.options));
    else render(state);
  }

  return { fit, focus, zoomBy, getState, setBounds, destroy };
}
