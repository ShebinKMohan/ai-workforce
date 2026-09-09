/**
 * What the board is allowed to claim.
 *
 * The reducer is where "a runtime saying done never marks a task accepted"
 * (AGENTS.md rule 3) becomes code. These tests hold that line and the two
 * structural properties the view depends on: a lane never moves, and both
 * producers — the live stream and the persisted rows — reduce to the same
 * state.
 */
import { describe, expect, it } from 'vitest';
import { findLane, initialState, liveLaneCount, reduce, RUN_LANE, type LiveEvent, type LiveState } from '../../../src/cli/live/state.js';

const at = (offset: number): number => 1_000 + offset;

function play(events: ReadonlyArray<LiveEvent>): LiveState {
  return events.reduce(reduce, initialState(1_000));
}

const open = (key: string, offset = 0): LiveEvent => ({ at: at(offset), laneId: `task-${key}`, identity: { taskId: `task-${key}`, key }, lifecycle: 'open' });
const event = (key: string, type: string, payload: Record<string, unknown> = {}, offset = 0): LiveEvent => ({
  at: at(offset),
  laneId: `task-${key}`,
  identity: { taskId: `task-${key}`, key },
  type,
  payload,
});

describe('live state', () => {
  it('only ever calls a lane verified because task.settled said so', () => {
    // Everything short of a settlement: a completed turn, a passing check.
    const optimistic = play([
      open('alpha'),
      event('alpha', 'runtime.turn_started'),
      event('alpha', 'runtime.turn_completed'),
      event('alpha', 'checks.planned', { criterionIds: ['unit'] }),
      event('alpha', 'check.completed', { criterionId: 'unit', outcome: 'passed', exitCode: 0 }),
    ]);
    expect(findLane(optimistic, 'task-alpha')!.status).toBe('verifying');
    expect(findLane(optimistic, 'task-alpha')!.settled).toBeNull();

    // And the settlement, which is the only thing that may say verified.
    const settled = reduce(optimistic, event('alpha', 'task.settled', { accepted: true, repairsUsed: 0 }));
    expect(findLane(settled, 'task-alpha')!.status).toBe('verified');
    expect(findLane(settled, 'task-alpha')!.settled).toBe(true);
  });

  it('says "ended", not "verified", when a stream closes with no settlement', () => {
    const state = play([
      open('alpha'),
      event('alpha', 'runtime.turn_started'),
      event('alpha', 'runtime.turn_completed'),
      { at: at(9), laneId: 'task-alpha', identity: { taskId: 'task-alpha', key: 'alpha' }, lifecycle: 'close' },
    ]);
    // A closed stream says the task stopped being reachable. It does not say
    // the task succeeded, and the board must not imply that it did.
    expect(findLane(state, 'task-alpha')!.status).toBe('ended');
    expect(findLane(state, 'task-alpha')!.settled).toBeNull();
  });

  it('never walks a settled lane backwards out of its terminal state', () => {
    const state = play([
      open('alpha'),
      event('alpha', 'task.settled', { accepted: false }),
      // A late event from a task that already failed must not repaint it as
      // busy; the settlement is the last word.
      event('alpha', 'runtime.turn_started', {}, 5),
    ]);
    expect(findLane(state, 'task-alpha')!.status).toBe('failed');
  });

  it('keeps a lane at the board position it was dispatched into, for the whole run', () => {
    let state = play([open('one'), open('two', 1), open('three', 2)]);
    expect(state.lanes.map((lane) => lane.label)).toEqual(['one', 'two', 'three']);
    expect(state.lanes.map((lane) => lane.index)).toEqual([1, 2, 3]);
    // The first lane finishing must not promote the others: a row that jumps
    // is a row the reader has to find again every second.
    state = reduce(state, event('one', 'task.settled', { accepted: true }));
    state = reduce(state, { at: at(20), laneId: 'task-one', identity: { taskId: 'task-one', key: 'one' }, lifecycle: 'close' });
    expect(state.lanes.map((lane) => lane.label)).toEqual(['one', 'two', 'three']);
    expect(state.lanes.find((lane) => lane.label === 'two')!.index).toBe(2);
  });

  it('reads a runtime payload the same whether it arrived nested (stream) or flat (database)', () => {
    // `run-direct.ts` nests the adapter payload under `payload`;
    // `runtimeEventToAppend` spreads it flat over the event's base fields.
    // Same facts, two shapes; one reducer.
    const nested = play([open('alpha'), event('alpha', 'runtime.file_change', { payload: { phase: 'completed', applied: true, withinAllowedPaths: false } })]);
    const flat = play([open('alpha'), event('alpha', 'runtime.file_change', { adapter: 'fake', phase: 'completed', applied: true, withinAllowedPaths: false })]);
    expect(findLane(nested, 'task-alpha')!.outside).toBe(1);
    expect(findLane(flat, 'task-alpha')!.outside).toBe(1);
    expect(findLane(nested, 'task-alpha')!.files).toBe(findLane(flat, 'task-alpha')!.files);
  });

  it('lets a queued lane say what it is waiting for, from the scheduler and not from a guess', () => {
    const state = play([
      open('types'),
      {
        at: at(3),
        laneId: RUN_LANE,
        type: 'schedule.blocked',
        payload: { blocked: [{ key: 'types', waitingOn: ['core', 'api'], reason: 'dependency' }] },
      },
    ]);
    const lane = findLane(state, 'task-types')!;
    expect(lane.status).toBe('queued');
    expect(lane.waitingOn).toEqual(['core', 'api']);
    expect(lane.blockedReason).toBe('dependency');
  });

  it('records planned criteria before any of them has run, so the checks strip is not all dashes', () => {
    const state = play([open('alpha'), event('alpha', 'checks.planned', { criterionIds: ['unit', 'typecheck'] })]);
    expect(state.checks.map((check) => check.criterionId)).toEqual(['unit', 'typecheck']);
    expect(state.checks.every((check) => check.outcome === null)).toBe(true);

    const done = reduce(state, event('alpha', 'check.completed', { criterionId: 'unit', outcome: 'failed', exitCode: 1, durationMs: 412 }));
    // Updated in place, not appended: one criterion is one column.
    expect(done.checks).toHaveLength(2);
    expect(done.checks.find((check) => check.criterionId === 'unit')!.outcome).toBe('failed');
  });

  it('counts a lane as live until it settles, which is what the heartbeat block reports', () => {
    let state = play([open('a'), open('b', 1)]);
    expect(liveLaneCount(state)).toBe(2);
    state = reduce(state, event('a', 'task.settled', { accepted: true }));
    expect(liveLaneCount(state)).toBe(1);
  });

  it("does not let one worker's attempt outcome declare the whole run over", () => {
    // `runDirect` emits `run.accepted` for the attempt it just finished, and on
    // the planned path that record carries a TASK id — one per worker. Read
    // run-wide, the first worker to finish would mark the run accepted while
    // three others were still going.
    const state = play([
      open('a'),
      open('b', 1),
      { at: at(5), laneId: 'task-a', identity: { taskId: 'task-a', key: 'a' }, type: 'run.accepted', payload: { accepted: true } },
    ]);
    expect(state.finished).toBe(false);
    expect(state.accepted).toBeNull();
    // And it is not a settlement either: a repair may still follow, so the lane
    // stays where it was rather than turning green.
    expect(findLane(state, 'task-a')!.status).not.toBe('verified');

    // The run-level record, which belongs to no lane, is the one that counts.
    const done = reduce(state, { at: at(9), laneId: RUN_LANE, type: 'run.accepted', payload: { accepted: true } });
    expect(done.finished).toBe(true);
    expect(done.accepted).toBe(true);
  });

  it('bounds the per-lane ring but counts what it dropped, so nothing is silently shortened', () => {
    let state = initialState(1_000);
    state = reduce(state, open('alpha'));
    for (let index = 0; index < 2_100; index += 1) {
      state = reduce(state, { at: at(index), laneId: 'task-alpha', identity: { taskId: 'task-alpha', key: 'alpha' }, line: `line ${index}` });
    }
    const lane = findLane(state, 'task-alpha')!;
    expect(lane.lines).toHaveLength(2_000);
    expect(lane.dropped).toBe(100);
    // The transcript, which the replay reads, keeps everything: the ring is a
    // display budget, not a record.
    expect(state.transcript).toHaveLength(2_100);
    expect(state.transcriptDropped).toBe(0);
  });
});
