import { describe, expect, it } from 'vitest';
import { createScheduler, simulateSchedule, type ScheduleTask } from '../../src/routing/schedule.js';

const two = { maxActiveTurns: 2, maxActiveWriters: 2 };

describe('simulateSchedule (AT09: no global stage barrier)', () => {
  it('releases a dependent as soon as its fast prerequisite completes, while an unrelated slow task still runs', () => {
    const tasks: ScheduleTask[] = [
      { id: 'fast' },
      { id: 'slow' },
      { id: 'dependent', dependencies: [{ taskId: 'fast', artifact: 'schema', version: 1 }] },
    ];
    const result = simulateSchedule({
      tasks,
      limits: two,
      events: [{ type: 'complete', taskId: 'fast', publishes: [{ name: 'schema', version: 1 }] }],
    });

    expect(result.batches[0]).toEqual(['fast', 'slow']);
    expect(result.batches[1]).toEqual(['dependent']);
    // The slow peer is still running: the dependent did not wait for a stage to end.
    expect(result.snapshots[1]?.states['slow']).toBe('running');
    expect(result.snapshots[1]?.states['dependent']).toBe('running');
    expect(result.blockers).toEqual([]);
  });

  it('does not release a dependent when the prerequisite published a lower artifact version', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b', dependencies: [{ taskId: 'a', artifact: 'schema', version: 2 }] }],
      limits: two,
      events: [{ type: 'complete', taskId: 'a', publishes: [{ name: 'schema', version: 1 }] }],
    });
    expect(result.order).toEqual(['a']);
    expect(result.finalStates['b']).toBe('blocked');
    expect(result.blockers.map((b) => b.kind)).toContain('stalled');
  });

  it('treats plain completion as readiness when no artifact is named', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b', dependencies: [{ taskId: 'a' }] }],
      limits: two,
      events: [{ type: 'complete', taskId: 'a' }],
    });
    expect(result.order).toEqual(['a', 'b']);
  });
});

describe('slot limits', () => {
  it('never exceeds maxActiveTurns', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      limits: { maxActiveTurns: 1, maxActiveWriters: 4 },
      events: [{ type: 'complete', taskId: 'a' }, { type: 'complete', taskId: 'b' }],
    });
    expect(result.batches[0]).toEqual(['a']);
    expect(result.batches[1]).toEqual(['b']);
    expect(result.batches[2]).toEqual(['c']);
    for (const snapshot of result.snapshots) expect(snapshot.activeTurns).toBeLessThanOrEqual(1);
  });

  it('holds writers to maxActiveWriters while non-writers keep running', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'w1', writer: true }, { id: 'w2', writer: true }, { id: 'r1', writer: false }],
      limits: { maxActiveTurns: 3, maxActiveWriters: 1 },
    });
    expect(result.batches[0]).toEqual(['w1', 'r1']);
    expect(result.snapshots[0]?.activeWriters).toBe(1);
  });
});

describe('waiting without holding a slot', () => {
  it('frees the turn slot when a running task is parked on a peer', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b' }],
      limits: { maxActiveTurns: 1, maxActiveWriters: 1 },
      events: [{ type: 'park', taskId: 'a', waitingOn: ['b'] }],
    });
    expect(result.batches[0]).toEqual(['a']);
    expect(result.batches[1]).toEqual(['b']);
    expect(result.finalStates['a']).toBe('waiting');
  });

  it('resumes a parked task once its peer is done', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b' }],
      limits: { maxActiveTurns: 1, maxActiveWriters: 1 },
      events: [
        { type: 'park', taskId: 'a', waitingOn: ['b'] },
        { type: 'complete', taskId: 'b' },
        { type: 'resume', taskId: 'a' },
      ],
    });
    expect(result.order).toEqual(['a', 'b', 'a']);
    expect(result.finalStates['a']).toBe('running');
  });

  it('surfaces a wait cycle instead of deadlocking', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b' }],
      limits: two,
      events: [
        { type: 'park', taskId: 'a', waitingOn: ['b'] },
        { type: 'park', taskId: 'b', waitingOn: ['a'] },
      ],
    });
    const cycle = result.blockers.find((b) => b.kind === 'wait_cycle');
    expect(cycle).toBeDefined();
    expect(cycle?.detail).toContain('a -> b -> a');
    expect(result.finalStates['a']).toBe('blocked');
  });
});

describe('graph blockers', () => {
  it('refuses a dependency cycle at construction', () => {
    const scheduler = createScheduler(
      [{ id: 'a', dependencies: [{ taskId: 'b' }] }, { id: 'b', dependencies: [{ taskId: 'a' }] }],
      two,
    );
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.blockers.map((b) => b.kind)).toContain('dependency_cycle');
  });

  it('refuses a dependency that references no task in the run', () => {
    const scheduler = createScheduler([{ id: 'a', dependencies: [{ taskId: 'ghost' }] }], two);
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.blockers.map((b) => b.kind)).toContain('unknown_dependency');
  });

  it('blocks dependents of a failed task and names the cause', () => {
    const result = simulateSchedule({
      tasks: [{ id: 'a' }, { id: 'b', dependencies: [{ taskId: 'a' }] }],
      limits: two,
      events: [{ type: 'fail', taskId: 'a', reason: 'the build did not compile' }],
    });
    const blocker = result.blockers.find((b) => b.kind === 'failed_dependency');
    expect(blocker?.detail).toContain('the build did not compile');
    expect(result.finalStates['b']).toBe('blocked');
  });

  it('is deterministic: the same tasks and events give the same order', () => {
    const input = {
      tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c', dependencies: [{ taskId: 'a', artifact: 'x' }] }],
      limits: two,
      events: [{ type: 'complete' as const, taskId: 'a', publishes: [{ name: 'x' }] }],
    };
    expect(simulateSchedule(input).order).toEqual(simulateSchedule(input).order);
  });

  it('rejects an unknown task id rather than silently ignoring it', () => {
    const scheduler = createScheduler([{ id: 'a' }], two);
    expect(() => scheduler.complete('ghost')).toThrow(/unknown task/);
  });
});
