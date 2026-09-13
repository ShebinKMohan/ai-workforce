/** Optional browser notifications for recorded task outcomes. This module
 * never requests permission during construction, refresh, or reconciliation. */
const BLOCKED = new Set(['held', 'interrupted', 'stalled', 'headReviewChanges', 'unverified']);
const FAILED = new Set(['failed', 'noPlan', 'notStarted']);
const text = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);

/** Use the status produced by the shared task model, never runtime prose or a
 * worker's individual completion. A direct AI answer is not a completed task. */
export function taskNotificationOutcome(task) {
  const state = task?.stateKey || task?.entry?.status?.key;
  const request = task?.entry?.item;
  if (!state || ['answered', 'discarded', 'ended'].includes(state)) return null;
  if (request?.route?.state === 'blocked' || BLOCKED.has(state)) return { kind: 'blocked', state, title: 'Task needs attention' };
  if (FAILED.has(state)) return { kind: 'failure', state, title: 'Task could not finish' };
  if (state === 'verified' && task?.verified === true) return { kind: 'completion', state, title: 'Task ready for review' };
  return null;
}

function identities(task) {
  const project = task?.projectId || task?.entry?.projectId;
  if (typeof project !== 'string' || !project) return [];
  const request = task?.requestId || task?.entry?.item?.id;
  const run = task?.runId || task?.entry?.runId || task?.entry?.run?.id;
  return [typeof request === 'string' && request ? JSON.stringify(['request', project, request]) : null,
    typeof run === 'string' && run ? JSON.stringify(['run', project, run]) : null].filter(Boolean);
}

/** Page-lifetime dedupe. First sightings establish a baseline, including tasks
 * loaded later from history. Removed rows keep their baseline but cannot open.
 * A request gaining its run ID remains the same notification identity. */
export function createTaskOutcomeTracker() {
  const aliases = new Map();
  let current = new Map();
  return {
    observe(tasks) {
      if (!Array.isArray(tasks)) return [];
      const events = [];
      current = new Map();
      for (const task of tasks) {
        const keys = identities(task);
        if (!keys.length) continue;
        const matching = [...new Set(keys.map(key => aliases.get(key)).filter(Boolean))];
        const known = matching.length > 0;
        const record = matching[0] || { key: keys[0], seen: new Set(), last: null };
        // A request/run linkage can join records that appeared separately.
        for (const other of matching.slice(1)) {
          for (const outcome of other.seen) record.seen.add(outcome);
          for (const [key, value] of aliases) if (value === other) aliases.set(key, record);
        }
        for (const key of keys) aliases.set(key, record);
        current.set(record.key, task);
        const outcome = taskNotificationOutcome(task);
        const next = outcome ? `${outcome.kind}:${outcome.state}` : null;
        if (known && next && record.last !== next && !record.seen.has(next)) events.push({ ...outcome, key: record.key, body: text(task.title || task.entry?.title) || 'Open the recorded task for details.' });
        if (next) record.seen.add(next);
        record.last = next;
      }
      return events;
    },
    getTask(key) { return current.get(aliases.get(key)?.key || key) || null; },
  };
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** Integration contract:
 * - Create once per workspace and observe the first successful live snapshot.
 * - Observe every later successful full snapshot, even while disabled.
 * - Bind enableFromUserGesture directly to an opt-in button's click event.
 * - onOpenTask receives the current existing task; the caller selects it.
 * Browser notifications require this page to remain open. No service worker,
 * background execution, or OS delivery guarantee is implied. */
export function createTaskNotifications({
  Notification: BrowserNotification = globalThis.Notification,
  storage = defaultStorage(), storageKey = 'workforce:task-notifications:v1',
  onOpenTask = () => {}, focusWindow = () => globalThis.window?.focus(),
} = {}) {
  const tracker = createTaskOutcomeTracker();
  const notices = new Set();
  let optedIn = false, requesting = false, destroyed = false, error = null, generation = 0;
  try { const saved = JSON.parse(storage?.getItem(storageKey) || 'null'); optedIn = saved?.version === 1 && saved.enabled === true; } catch { /* An unreadable preference leaves notifications off. */ }
  const supported = typeof BrowserNotification === 'function' && typeof BrowserNotification.requestPermission === 'function';
  const permission = () => supported ? BrowserNotification.permission || 'default' : 'unsupported';
  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify({ version: 1, enabled: optedIn })); } catch { /* Permission can still be used for this page lifetime. */ }
  }
  function closeNotices() {
    for (const notice of notices) { notice.onclick = null; try { notice.close(); } catch { /* Browser already closed it. */ } }
    notices.clear();
  }
  function getStatus() {
    return { supported, permission: permission(), enabled: !destroyed && optedIn && permission() === 'granted', requesting, error };
  }
  return {
    getStatus,
    async enableFromUserGesture(event) {
      // A trusted button click also covers keyboard activation. Programmatic
      // setup cannot accidentally cause the browser permission prompt.
      if (destroyed || requesting || event?.type !== 'click' || event.isTrusted !== true) return getStatus();
      error = null;
      if (!supported || permission() === 'denied') return getStatus();
      const attempt = ++generation;
      requesting = true;
      try {
        const granted = permission() === 'granted' ? 'granted' : await BrowserNotification.requestPermission();
        if (destroyed || generation !== attempt) return getStatus();
        optedIn = granted === 'granted';
        persist();
      } catch {
        if (!destroyed && generation === attempt) { optedIn = false; error = 'Browser notifications could not be enabled.'; persist(); }
      } finally {
        if (generation === attempt) requesting = false;
      }
      return getStatus();
    },
    disable() { generation++; requesting = false; optedIn = false; error = null; persist(); closeNotices(); return getStatus(); },
    observe(tasks) {
      if (destroyed) return [];
      const outcomes = tracker.observe(tasks);
      // Outcomes observed while disabled are consumed, never replayed on opt-in.
      if (!getStatus().enabled) return [];
      const delivered = [];
      for (const outcome of outcomes) {
        try {
          const notice = new BrowserNotification(outcome.title, { body: outcome.body,
            tag: `workforce:${storageKey}:${outcome.key}:${outcome.kind}:${outcome.state}` });
          notices.add(notice);
          notice.onclose = () => notices.delete(notice);
          notice.onclick = () => {
            if (destroyed) return;
            const task = tracker.getTask(outcome.key);
            try { notice.close(); } catch { /* The browser may already have dismissed it. */ }
            notices.delete(notice);
            if (task) { focusWindow(); onOpenTask(task); }
          };
          delivered.push(outcome);
        } catch { error = 'The browser could not display a task notification.'; }
      }
      return delivered;
    },
    destroy() { destroyed = true; generation++; requesting = false; closeNotices(); },
  };
}
