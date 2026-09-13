import { describe, expect, it, vi } from 'vitest';
import { createTaskNotifications, createTaskOutcomeTracker, taskNotificationOutcome } from '../../web/claude-office/src/task-notifications.js';

const task = (stateKey = 'working', extra = {}) => ({ projectId: 'project', requestId: 'request', runId: 'run', id: 'q:request', title: 'Update the parser', stateKey, verified: stateKey === 'verified', ...extra });
const click = { type: 'click', isTrusted: true };
function browser(permission = 'default') {
  const created = [];
  class Notification {
    static permission = permission;
    static requestPermission = vi.fn(async () => { Notification.permission = 'granted'; return 'granted'; });
    constructor(title, options) { this.title = title; this.options = options; this.close = vi.fn(); created.push(this); }
  }
  return { Notification, created };
}
function storage(enabled = false) {
  const values = new Map([['preferences', JSON.stringify({ version: 1, enabled })]]);
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
}

describe('recorded task outcome transitions', () => {
  it('does not call an answer, a worker report, active head review, cancellation, or partial checks a completed task', () => {
    for (const state of ['answered', 'ended', 'discarded', 'working', 'checking', 'headReviewing']) expect(taskNotificationOutcome(task(state, { verified: true }))).toBeNull();
    expect(taskNotificationOutcome(task('verified', { verified: false }))).toBeNull();
    expect(taskNotificationOutcome(task('verified'))?.kind).toBe('completion');
    expect(taskNotificationOutcome(task('unverified'))?.kind).toBe('blocked');
    expect(taskNotificationOutcome(task('failed'))?.kind).toBe('failure');
    expect(taskNotificationOutcome(task('notStarted', { entry: { item: { route: { state: 'blocked' } } } }))?.kind).toBe('blocked');
  });

  it('baselines historical tasks on first snapshot and first later sighting, including after reload', () => {
    const tracker = createTaskOutcomeTracker();
    expect(tracker.observe([task('verified')])).toEqual([]);
    expect(tracker.observe([task('verified'), task('failed', { requestId: 'older-request', runId: 'older-run' })])).toEqual([]);
    expect(createTaskOutcomeTracker().observe([task('verified')])).toEqual([]);
    // A missing ID is not a title-based notification identity.
    expect(tracker.observe([{ title: 'Unlinked task', stateKey: 'working' }])).toEqual([]);
    expect(tracker.observe([{ title: 'Unlinked task', stateKey: 'failed' }])).toEqual([]);
  });

  it('notifies only new observed outcome states and deduplicates repeated polling and a stale state regression', () => {
    const tracker = createTaskOutcomeTracker();
    tracker.observe([task()]);
    expect(tracker.observe([task('stalled')]).map(event => event.kind)).toEqual(['blocked']);
    expect(tracker.observe([task('stalled')])).toEqual([]);
    tracker.observe([task('working')]);
    expect(tracker.observe([task('stalled')])).toEqual([]);
    expect(tracker.observe([task('failed')]).map(event => event.kind)).toEqual(['failure']);
    tracker.observe([task('working')]);
    expect(tracker.observe([task('verified')]).map(event => event.kind)).toEqual(['completion']);
    expect(tracker.observe([task('verified')])).toEqual([]);
  });

  it('retains identity as a request gains a run or a previously visible run becomes linked to its request', () => {
    const tracker = createTaskOutcomeTracker();
    tracker.observe([task('working', { runId: null })]);
    const [first] = tracker.observe([task('verified')]);
    expect(first.kind).toBe('completion');
    expect(tracker.observe([task('verified', { requestId: null, id: 'r:project:run' })])).toEqual([]);
    tracker.observe([]);
    expect(tracker.observe([task('verified')])).toEqual([]);
    const other = createTaskOutcomeTracker();
    other.observe([task('working', { requestId: null, id: 'r:project:run' })]);
    expect(other.observe([task('verified')])).toHaveLength(1);
  });

  it('keeps equal run IDs in separate projects independent', () => {
    const tracker = createTaskOutcomeTracker();
    tracker.observe([task(), task('working', { projectId: 'second' })]);
    const events = tracker.observe([task('verified'), task('verified', { projectId: 'second' })]);
    expect(events).toHaveLength(2);
    expect(events[0].key).not.toBe(events[1].key);
  });

  it('keeps old notification targets valid when separately observed request and run records are joined', () => {
    const tracker = createTaskOutcomeTracker();
    const requestOnly = task('working', { runId: null });
    const runOnly = task('working', { requestId: null, id: 'r:project:run' });
    tracker.observe([requestOnly, runOnly]);
    const [outcome] = tracker.observe([requestOnly, { ...runOnly, stateKey: 'stalled' }]);
    const linked = task('stalled');
    expect(tracker.observe([linked])).toEqual([]);
    expect(tracker.getTask(outcome.key)).toBe(linked);
  });
});

describe('opt-in browser task notifications', () => {
  it('never prompts on construction or snapshots, and ignores non-user enable attempts', async () => {
    const platform = browser();
    const controller = createTaskNotifications({ ...platform, storage: storage(), storageKey: 'preferences' });
    controller.observe([task()]); controller.observe([task('verified')]);
    await controller.enableFromUserGesture();
    await controller.enableFromUserGesture({ type: 'click', isTrusted: false });
    await controller.enableFromUserGesture({ type: 'change', isTrusted: true });
    expect(platform.Notification.requestPermission).not.toHaveBeenCalled();
    expect(platform.created).toHaveLength(0);
    expect(controller.getStatus().enabled).toBe(false);
  });

  it('asks only on explicit opt-in and never replays outcomes observed while disabled', async () => {
    const platform = browser(); const preferences = storage();
    const controller = createTaskNotifications({ ...platform, storage: preferences, storageKey: 'preferences' });
    controller.observe([task()]); controller.observe([task('failed')]);
    expect((await controller.enableFromUserGesture(click)).enabled).toBe(true);
    expect(platform.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(JSON.parse(preferences.getItem('preferences')).enabled).toBe(true);
    expect(controller.observe([task('failed')])).toEqual([]);
    controller.observe([task('working')]);
    expect(controller.observe([task('verified')])).toHaveLength(1);
    expect(platform.created[0].title).toBe('Task ready for review');
    expect(platform.created[0].options.body).toBe('Update the parser');
    controller.disable();
    expect(platform.created[0].close).toHaveBeenCalled();
    controller.observe([task('stalled')]);
    expect(platform.created).toHaveLength(1);
  });

  it('does not treat existing browser permission as user opt-in, and saved opt-in still baselines a fresh page', async () => {
    const platform = browser('granted');
    const off = createTaskNotifications({ ...platform, storage: storage(), storageKey: 'preferences' });
    off.observe([task()]); off.observe([task('verified')]);
    expect(platform.created).toHaveLength(0);
    const on = createTaskNotifications({ ...platform, storage: storage(true), storageKey: 'preferences' });
    expect(on.getStatus().enabled).toBe(true);
    expect(on.observe([task('verified')])).toEqual([]);
    expect(platform.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('focuses and opens the latest existing task on click, but does nothing after it leaves the current snapshot', () => {
    const platform = browser('granted'); const onOpenTask = vi.fn(); const focusWindow = vi.fn();
    const controller = createTaskNotifications({ ...platform, storage: storage(true), storageKey: 'preferences', onOpenTask, focusWindow });
    controller.observe([task()]); controller.observe([task('stalled')]);
    const latest = task('stalled', { title: 'Current task title' });
    controller.observe([latest]);
    platform.created[0].onclick();
    expect(onOpenTask).toHaveBeenCalledWith(latest);
    expect(focusWindow).toHaveBeenCalledTimes(1);
    controller.observe([task('failed')]);
    controller.observe([]);
    platform.created[1].onclick();
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it('does not prompt again after denial and treats unavailable browsers or blocked storage safely', async () => {
    const denied = browser('denied');
    const controller = createTaskNotifications({ ...denied, storage: null });
    expect((await controller.enableFromUserGesture(click)).enabled).toBe(false);
    expect(denied.Notification.requestPermission).not.toHaveBeenCalled();
    const unsupported = createTaskNotifications({ Notification: null, storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
    expect((await unsupported.enableFromUserGesture(click)).permission).toBe('unsupported');
    expect(() => unsupported.disable()).not.toThrow();
  });

  it('does not re-enable after disabling a pending permission prompt and cleans up notifications on destruction', async () => {
    const platform = browser(); let resolve;
    platform.Notification.requestPermission.mockImplementation(() => new Promise(done => { resolve = done; }));
    const controller = createTaskNotifications({ ...platform, storage: storage(), storageKey: 'preferences' });
    const pending = controller.enableFromUserGesture(click);
    controller.disable();
    platform.Notification.permission = 'granted'; resolve('granted');
    await pending;
    expect(controller.getStatus()).toMatchObject({ enabled: false, requesting: false });
    await controller.enableFromUserGesture(click);
    controller.observe([task()]); controller.observe([task('verified')]);
    controller.destroy();
    expect(platform.created[0].onclick).toBeNull();
    expect(controller.observe([task('failed')])).toEqual([]);
    expect(controller.getStatus().enabled).toBe(false);
  });

  it('contains browser delivery failures without retrying the same task outcome on every refresh', () => {
    const platform = browser('granted');
    const broken = vi.fn(function () { throw new Error('Platform blocked delivery'); });
    broken.permission = 'granted'; broken.requestPermission = platform.Notification.requestPermission;
    const controller = createTaskNotifications({ Notification: broken, storage: storage(true), storageKey: 'preferences' });
    controller.observe([task()]);
    expect(() => controller.observe([task('failed')])).not.toThrow();
    expect(controller.getStatus().error).toBe('The browser could not display a task notification.');
    controller.observe([task('failed')]);
    expect(broken).toHaveBeenCalledTimes(1);
  });
});
