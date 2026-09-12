/**
 * String rendering helpers and the keyed patch that applies a re-render
 * without losing what the person is doing.
 *
 * Every page is a pure function from documents to an HTML string. Live
 * updates re-render the page and patch it into the DOM:
 * - each section and row carries `data-key` (what it is) and `data-sig` (a hash
 *   of what it was rendered from); only keys whose signature changed are touched;
 * - a node that holds focus on a control (a field, button or link) is never
 *   replaced: its update waits until focus leaves it; task lifecycle actions
 *   explicitly opt out so Stop, Resume and required consent cannot become stale;
 *   a focused page heading gets focus back after the replacement;
 * - disclosure state lives in the UI state the templates read, not in the DOM,
 *   so a replaced node comes back open if it was open;
 * - the window scroll position is kept.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML content or a quoted attribute. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** A short, stable hash of anything JSON can hold: the `data-sig` of a rendered node. */
export function sig(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** `<tag data-key data-sig ...>` for a keyed block. The signature covers the rendered inner HTML. */
export function keyed(tag, key, attributes, inner) {
  const rest = attributes ? ` ${attributes}` : '';
  return `<${tag} data-key="${esc(key)}" data-sig="${sig(inner + rest)}"${rest}>${inner}</${tag}>`;
}

/** `data-record` marks identifiers and record words; primary text never holds them. */
export function record(inner, tag = 'div', className = 'record') {
  return `<${tag} class="${className}" data-record>${inner}</${tag}>`;
}

/**
 * Which keyed nodes to keep, replace, insert or remove, as a pure plan.
 *
 * `oldNodes` and `newNodes` are `{ key, sig }` in document order. A node whose
 * key holds focus (`focusedKey`) is never replaced or removed; it is reported
 * as `defer`, so the caller re-applies once focus leaves.
 */
export function planPatch(oldNodes, newNodes, focusedKey = null) {
  const before = new Map(oldNodes.map((node) => [node.key, node]));
  const after = new Set(newNodes.map((node) => node.key));
  const ops = [];
  newNodes.forEach((node, index) => {
    const previous = before.get(node.key);
    if (previous === undefined) ops.push({ op: 'insert', key: node.key, index });
    else if (previous.sig === node.sig) ops.push({ op: 'keep', key: node.key, index });
    else if (node.key === focusedKey) ops.push({ op: 'defer', key: node.key, index });
    else ops.push({ op: 'replace', key: node.key, index });
  });
  for (const node of oldNodes) {
    if (after.has(node.key)) continue;
    ops.push({ op: node.key === focusedKey ? 'defer' : 'remove', key: node.key, index: -1 });
  }
  return ops;
}

function keyedChildren(parent) {
  return Array.from(parent.children);
}

function allKeyed(children) {
  return children.every((child) => child.hasAttribute('data-key'));
}

/**
 * Patch `container`'s children to match `html`. Returns true when an update had
 * to wait for focus to leave a node, so the caller can re-apply on focusout.
 */
export function applyPatch(container, html, doc = container.ownerDocument) {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const scroll = doc.defaultView ? doc.defaultView.scrollY : 0;
  const lifecycleAction = doc.activeElement?.matches?.('[data-live-action]') ? doc.activeElement : null;
  const deferred = patchChildren(container, template.content, doc);
  // A lifecycle action may disappear as the task changes state. Keep keyboard
  // users oriented at the task heading instead of trapping an obsolete button.
  if (lifecycleAction && !doc.contains(lifecycleAction)) container.querySelector?.('h1')?.focus?.({ preventScroll: true });
  if (doc.defaultView && doc.defaultView.scrollY !== scroll) doc.defaultView.scrollTo(0, scroll);
  return deferred;
}

/** Focus worth protecting: a control the person is using. A focused page heading (route focus) is not. */
function protectedFocus(doc) {
  const active = doc.activeElement;
  if (!active || active === doc.body) return null;
  if (active.matches('[data-live-action]')) return null;
  return active.matches('input, textarea, select, button, a[href], summary, [contenteditable="true"]') ? active : null;
}

/** After a node holding the focused page heading is replaced, give focus back to the new heading without scrolling. */
function refocusHeading(doc, heading, container) {
  if (!heading || doc.activeElement === heading || doc.contains(heading)) return;
  const next = container.querySelector?.(heading.tagName.toLowerCase());
  next?.focus?.({ preventScroll: true });
}

function patchChildren(oldParent, newParent, doc) {
  const oldChildren = keyedChildren(oldParent);
  const newChildren = keyedChildren(newParent);
  const active = protectedFocus(doc);
  const heading = !active && doc.activeElement && /^H[1-6]$/.test(doc.activeElement.tagName) ? doc.activeElement : null;
  if (!allKeyed(oldChildren) || !allKeyed(newChildren)) {
    if (active && oldParent.contains(active)) return true;
    oldParent.replaceChildren(...Array.from(newParent.childNodes));
    refocusHeading(doc, heading, oldParent);
    return false;
  }
  const focusedChild = oldChildren.find((child) => active && child.contains(active)) ?? null;
  const focusedKey = focusedChild?.getAttribute('data-key') ?? null;
  const describe = (children) => children.map((child) => ({ key: child.getAttribute('data-key'), sig: child.getAttribute('data-sig') }));
  const ops = planPatch(describe(oldChildren), describe(newChildren), focusedKey);
  const oldByKey = new Map(oldChildren.map((child) => [child.getAttribute('data-key'), child]));
  const newByKey = new Map(newChildren.map((child) => [child.getAttribute('data-key'), child]));
  let deferred = false;
  const placed = [];
  for (const op of ops) {
    if (op.op === 'remove') oldByKey.get(op.key)?.remove();
    else if (op.op === 'keep') placed.push(oldByKey.get(op.key));
    else if (op.op === 'insert') placed.push(newByKey.get(op.key));
    else if (op.op === 'replace') {
      const next = newByKey.get(op.key);
      oldByKey.get(op.key).replaceWith(next);
      placed.push(next);
    } else if (op.op === 'defer') {
      const current = oldByKey.get(op.key);
      if (op.index >= 0) {
        // Patch inside the focused node where it is keyed all the way down; otherwise wait.
        const next = newByKey.get(op.key);
        const inner = patchChildren(current, next, doc);
        if (!inner) current.setAttribute('data-sig', next.getAttribute('data-sig') ?? '');
        deferred = deferred || inner;
        placed.push(current);
      } else {
        deferred = true;
      }
    }
  }
  // Order: move nodes only when they are out of place, so a focused node is not detached.
  let cursor = null;
  for (const node of placed) {
    const expected = cursor === null ? oldParent.firstElementChild : cursor.nextElementSibling;
    if (expected !== node) {
      if (cursor === null) oldParent.prepend(node);
      else cursor.after(node);
    }
    cursor = node;
  }
  refocusHeading(doc, heading, oldParent);
  return deferred;
}
