import { describe, expect, it } from 'vitest';
import { buildSceneActivity, createSceneActivityTracker } from '../../web/claude-office/src/scene-activity.js';

const START = Date.parse('2026-09-13T10:00:00Z');
const at = offset => new Date(START + offset).toISOString();
function task(overrides = {}) {
  const result = { id: 'q:request-1', projectId: 'project-1', title: 'Fix the implementation', stateKey: 'working', inMotion: true, verified: false,
    entry: { item: { id: 'request-1', receivedAt: at(1000), state: 'running', workerIds: ['worker-1', 'worker-2'], route: { state: 'selected', headAgentId: 'head-1', decidedAt: at(1100), method: 'classification' } },
      run: { id: 'run-1', state: 'running', projectLock: { held: true }, taskViews: [{ id: 'task-1', ownerAgentId: 'worker-1', state: 'running', attempt: { id: 'attempt-1', state: 'running', startedAt: at(1200) }, receipts: {} }] } }, ...overrides };
  return result;
}
const model = value => buildSceneActivity({ tasks: [value] });
const stages = value => value.transfers.map(row => row.stage);
describe('scene activity from recorded execution', () => {
  it('baselines initial history, then emits each newly recorded handoff once', () => {
    const tracker = createSceneActivityTracker({ now: () => START });
    expect(tracker.update({ tasks: [] }).transfers).toEqual([]);
    expect(stages(tracker.update({ tasks: [task()] }))).toEqual(['received', 'routed', 'dispatched']);
    expect(tracker.update({ tasks: [task()] }).transfers).toEqual([]);
    const baseline = createSceneActivityTracker({ now: () => START });
    expect(baseline.update({ tasks: [task()] }).transfers).toEqual([]);
  });
  it('does not dispatch every reserved worker or treat a plan as execution', () => {
    const value = task();
    expect(model(value).activeNodes).toEqual([{ node: 'agent:worker-1', stage: 'working', taskId: value.id }]);
    expect(model(value).receipts.filter(row => row.stage === 'dispatched').map(row => row.to)).toEqual(['agent:worker-1']);
    value.entry.run.taskViews[0].state = 'ready';
    value.entry.run.taskViews[0].attempt = null;
    expect(model(value).activeNodes).toEqual([]);
    expect(model(value).receipts.map(row => row.stage)).toEqual(['received', 'routed']);
  });
  it.each([false, undefined])('requires the live project lock, held=%s', held => {
    const value = task(); value.entry.run.projectLock = { held };
    expect(model(value).activeNodes).toEqual([]);
    expect(model(value).phase.stage).not.toBe('working');
  });
  it('stops work signals for termination and lost connection', () => {
    const value = task(); value.entry.run.state = 'interrupted'; value.stateKey = 'interrupted'; value.inMotion = false;
    expect(model(value).activeNodes).toEqual([]);
    expect(model(value).phase.tone).toBe('attention');
    expect(buildSceneActivity({ tasks: [task()], connected: false }).activeNodes).toEqual([]);
    const stopping = task({ stateKey: 'stopping' });
    expect(model(stopping).activeNodes).toEqual([]);
  });
  it('shows actual intake and planning actors, never an inferred current head', () => {
    const value = task({ stateKey: 'planning' }); value.entry.run.taskViews = [];
    expect(model(value).activeNodes[0].node).toBe('agent:head-1');
    value.entry.item.route = { state: 'pending' }; value.entry.item.routingSession = { state: 'running' };
    expect(model(value).activeNodes).toEqual([{ node: 'control', stage: 'routing', taskId: value.id }]);
    value.entry.item.routingSession.state = 'stopped';
    expect(model(value).activeNodes).toEqual([]);
  });
  it('records checks once per attempt, then returns only actual participants to head review', () => {
    const tracker = createSceneActivityTracker({ now: () => START }); const value = task(); tracker.update({ tasks: [value] });
    const row = value.entry.run.taskViews[0]; row.state = 'validating'; row.attempt.state = 'succeeded';
    expect(stages(tracker.update({ tasks: [value] }))).toEqual(['checking']);
    row.lastEvent = { timestamp: at(3000), type: 'verifier.started' };
    expect(tracker.update({ tasks: [value] }).transfers).toEqual([]);
    row.state = 'accepted'; row.receipts.verifierExecutedPassed = 1;
    value.entry.run.headReview = { state: 'running', reviewId: 'review-1', headAgentId: 'head-1', at: at(4000) };
    const review = tracker.update({ tasks: [value] });
    expect(stages(review)).toEqual(['reviewing']); expect(review.transfers[0].from).toBe('agent:worker-1');
    expect(review.activeNodes).toEqual([{ node: 'agent:head-1', stage: 'reviewing', taskId: value.id }]);
    value.entry.run.headReview = { ...value.entry.run.headReview, state: 'passed', at: at(5000) };
    expect(tracker.update({ tasks: [value] }).transfers).toEqual([]);
    value.entry.run.finalReply = 'Reviewed result'; value.entry.run.state = 'ready_for_review'; value.inMotion = false;
    expect(tracker.update({ tasks: [value] }).transfers[0]).toMatchObject({ stage: 'replied', tone: 'neutral', from: 'agent:head-1', to: 'control' });
    value.verified = true;
    expect(model(value).receipts.find(row => row.stage === 'replied').tone).toBe('verified');
    expect(model(value).phase.stage).toBe('verified');
  });
  it('does not invent successful head review from final prose', () => {
    const value = task(); value.entry.run.finalReply = 'Everything is done'; value.verified = true;
    expect(model(value).receipts.some(row => row.stage === 'replied')).toBe(false);
  });
  it('keeps direct AI replies at Control Center without a worker flow or green success', () => {
    const value = task({ stateKey: 'answered', inMotion: false });
    value.entry.run = null;
    Object.assign(value.entry.item, { state: 'ended', route: { state: 'selected', method: 'direct_reply' }, controlReply: 'Hello', result: { code: 'control_reply', exitCode: 0 }, endedAt: at(2000) });
    expect(model(value).receipts.map(row => row.stage)).toEqual(['received', 'answered']);
    expect(model(value).activeNodes).toEqual([]);
    expect(model(value).receipts.at(-1).tone).toBe('neutral');
  });
  it('quietly consumes reconnect snapshots and old history fetched later', () => {
    const tracker = createSceneActivityTracker({ now: () => START }); tracker.update({ tasks: [] });
    const old = task(); old.entry.item.receivedAt = at(-100000);
    expect(tracker.update({ tasks: [old] }).transfers).toEqual([]);
    tracker.update({ tasks: [old], connected: false });
    old.entry.run.headReview = { state: 'running', reviewId: 'review-1', headAgentId: 'head-1', at: at(4000) };
    expect(tracker.update({ tasks: [old] }).transfers).toEqual([]);
    old.entry.run.taskViews[0].attempt = { id: 'attempt-2', state: 'running', startedAt: at(5000) };
    expect(stages(tracker.update({ tasks: [old] }))).toEqual(['dispatched']);
  });
  it('does not replay a large unchanged snapshot when the receipt cache is bounded', () => {
    const tracker = createSceneActivityTracker({ now: () => START, limit: 1 });
    tracker.update({ tasks: [task()] });
    expect(tracker.update({ tasks: [task()] }).transfers).toEqual([]);
  });
});
