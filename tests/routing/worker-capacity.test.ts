import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import type { RuntimeEvent, SessionHandle, SessionInput, TurnHandle, TurnInput } from '../../src/adapters/types.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { validateAgentConfig } from '../../src/core/contracts.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { createScheduler, simulateSchedule } from '../../src/routing/schedule.js';
import { openStateStore } from '../../src/storage/db.js';
import { listEvents } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

const two = { maxActiveTurns: 2, maxActiveWriters: 2 };
afterEach(() => cleanupAll());

describe('named worker capacity (FR031, FR032)', () => {
  it('serializes one worker without holding up a different worker in declaration order', () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'engineer' },
      { id: 'peer', agentId: 'tester' },
    ], two);

    expect(scheduler.dispatch()).toEqual(['first', 'peer']);
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.snapshot().states.second).toBe('pending');
    expect(scheduler.runningTaskForAgent('engineer')).toBe('first');

    scheduler.complete('peer');
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.blockers).toEqual([]);

    scheduler.complete('first');
    expect(scheduler.dispatch()).toEqual(['second']);
    expect(scheduler.runningTaskForAgent('engineer')).toBe('second');
  });

  it('retains independent turn capacity for tasks with no worker identity', () => {
    const scheduler = createScheduler([{ id: 'first' }, { id: 'second' }], two);
    expect(scheduler.dispatch()).toEqual(['first', 'second']);
  });

  it('releases a failed worker for unrelated work while blocking its failed dependencies', () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'engineer' },
      { id: 'dependent', agentId: 'tester', dependencies: [{ taskId: 'first' }] },
    ], two);
    expect(scheduler.dispatch()).toEqual(['first']);

    scheduler.fail('first', 'the check failed');
    expect(scheduler.runningTaskForAgent('engineer')).toBeUndefined();
    expect(scheduler.dispatch()).toEqual(['second']);
    expect(scheduler.snapshot().states.dependent).toBe('blocked');
    expect(scheduler.blockers[0]?.kind).toBe('failed_dependency');
  });

  it('releases a parked worker, but a resumed task waits until its replacement settles', () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'engineer' },
    ], two);
    expect(scheduler.dispatch()).toEqual(['first']);

    scheduler.park('first', ['second']);
    expect(scheduler.runningTaskForAgent('engineer')).toBeUndefined();
    expect(scheduler.dispatch()).toEqual(['second']);
    scheduler.resume('first');
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.snapshot().states.first).toBe('pending');

    scheduler.complete('second');
    expect(scheduler.dispatch()).toEqual(['first']);
    expect(scheduler.blockers).toEqual([]);
  });

  it('releases a ready dependent immediately while an unrelated worker keeps running', () => {
    const result = simulateSchedule({
      tasks: [
        { id: 'fast', agentId: 'engineer' },
        { id: 'slow', agentId: 'tester' },
        { id: 'dependent', agentId: 'engineer', dependencies: [{ taskId: 'fast', artifact: 'schema', version: 2 }] },
      ],
      limits: two,
      events: [{ type: 'complete', taskId: 'fast', publishes: [{ name: 'schema', version: 2 }] }],
    });

    expect(result.batches).toEqual([['fast', 'slow'], ['dependent']]);
    expect(result.snapshots[1]?.running).toEqual(['slow', 'dependent']);
    expect(result.blockers).toEqual([]);
  });

  it('keeps turn and writer limits while skipping a busy worker', () => {
    const result = simulateSchedule({
      tasks: [
        { id: 'first', agentId: 'engineer' },
        { id: 'second', agentId: 'engineer', writer: false },
        { id: 'peer-write', agentId: 'tester' },
        { id: 'peer-read', agentId: 'reviewer', writer: false },
        { id: 'extra-read', agentId: 'architect', writer: false },
      ],
      limits: { maxActiveTurns: 2, maxActiveWriters: 1 },
      events: [{ type: 'complete', taskId: 'first' }],
    });

    expect(result.batches).toEqual([['first', 'peer-read'], ['second']]);
    for (const snapshot of result.snapshots) {
      expect(snapshot.activeTurns).toBeLessThanOrEqual(2);
      expect(snapshot.activeWriters).toBeLessThanOrEqual(1);
    }
  });

  it('does not release named dependent work on an insufficient artifact version', () => {
    const result = simulateSchedule({
      tasks: [
        { id: 'first', agentId: 'engineer' },
        { id: 'dependent', agentId: 'engineer', dependencies: [{ taskId: 'first', artifact: 'schema', version: 2 }] },
      ],
      limits: two,
      events: [{ type: 'complete', taskId: 'first', publishes: [{ name: 'schema', version: 1 }] }],
    });

    expect(result.batches).toEqual([['first'], []]);
    expect(result.finalStates.dependent).toBe('blocked');
    expect(result.blockers[0]?.kind).toBe('stalled');
  });
});

describe('fallback worker capacity leases', () => {
  it('gives only one concurrent fallback a lease for the same worker', async () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'tester' },
    ], two);
    scheduler.dispatch();

    const [releaseFirst, releaseSecond] = await Promise.all([
      Promise.resolve().then(() => scheduler.tryAcquireAgent('first', 'fallback')),
      Promise.resolve().then(() => scheduler.tryAcquireAgent('second', 'fallback')),
    ]);
    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseSecond).toBeNull();
    expect(scheduler.runningTaskForAgent('fallback')).toBe('first');
    expect(scheduler.activeTurns).toBe(2);
    expect(scheduler.activeWriters).toBe(2);

    releaseFirst!();
    expect(scheduler.tryAcquireAgent('second', 'fallback')).toBeTypeOf('function');
    expect(scheduler.runningTaskForAgent('fallback')).toBe('second');
  });

  it('blocks normal dispatch on the fallback worker and preserves the original assignment', () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'peer', agentId: 'tester' },
      { id: 'fallback-work', agentId: 'fallback' },
      { id: 'original-work', agentId: 'engineer' },
    ], two);
    expect(scheduler.dispatch()).toEqual(['first', 'peer']);
    const release = scheduler.tryAcquireAgent('first', 'fallback');
    expect(release).toBeTypeOf('function');

    scheduler.complete('peer');
    expect(scheduler.dispatch()).toEqual([]);
    expect(scheduler.runningTaskForAgent('engineer')).toBe('first');
    expect(scheduler.runningTaskForAgent('fallback')).toBe('first');

    release!();
    expect(scheduler.dispatch()).toEqual(['fallback-work']);
    expect(scheduler.snapshot().states['original-work']).toBe('pending');
  });

  it('refuses a worker already held by an original assignment or another lease', () => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'tester' },
    ], two);
    scheduler.dispatch();
    expect(scheduler.tryAcquireAgent('first', 'engineer')).toBeNull();
    expect(scheduler.tryAcquireAgent('first', 'tester')).toBeNull();
    expect(scheduler.tryAcquireAgent('first', 'fallback')).toBeTypeOf('function');
    expect(scheduler.tryAcquireAgent('first', 'fallback')).toBeNull();
    expect(scheduler.tryAcquireAgent('second', 'fallback')).toBeNull();
  });

  it.each(['complete', 'fail', 'park'] as const)('clears every lease on %s without allowing stale handles to release their successors', (settlement) => {
    const scheduler = createScheduler([
      { id: 'first', agentId: 'engineer' },
      { id: 'second', agentId: 'tester' },
    ], two);
    scheduler.dispatch();
    const releaseFirst = scheduler.tryAcquireAgent('first', 'fallback');
    const releaseOther = scheduler.tryAcquireAgent('first', 'other-fallback');
    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseOther).toBeTypeOf('function');

    if (settlement === 'park') scheduler.park('first', ['second']);
    else scheduler[settlement]('first');

    expect(scheduler.runningTaskForAgent('fallback')).toBeUndefined();
    expect(scheduler.runningTaskForAgent('other-fallback')).toBeUndefined();
    expect(scheduler.tryAcquireAgent('second', 'fallback')).toBeTypeOf('function');
    expect(scheduler.tryAcquireAgent('second', 'other-fallback')).toBeTypeOf('function');
    releaseFirst!();
    releaseOther!();
    expect(scheduler.runningTaskForAgent('fallback')).toBe('second');
    expect(scheduler.runningTaskForAgent('other-fallback')).toBe('second');
  });

  it('makes explicit release idempotent even after the same task reacquires the worker', () => {
    const scheduler = createScheduler([{ id: 'first', agentId: 'engineer' }], two);
    scheduler.dispatch();
    const releaseFirst = scheduler.tryAcquireAgent('first', 'fallback');
    releaseFirst!();
    releaseFirst!();
    const releaseNext = scheduler.tryAcquireAgent('first', 'fallback');
    expect(releaseNext).toBeTypeOf('function');
    releaseFirst!();
    expect(scheduler.runningTaskForAgent('fallback')).toBe('first');
    releaseNext!();
    expect(scheduler.runningTaskForAgent('fallback')).toBeUndefined();
  });

  it('rejects acquisition outside a running task without reserving the worker', () => {
    const scheduler = createScheduler([{ id: 'first', agentId: 'engineer' }], two);
    expect(() => scheduler.tryAcquireAgent('missing', 'fallback')).toThrow(/unknown task/);
    expect(() => scheduler.tryAcquireAgent('first', 'fallback')).toThrow(/running/);
    scheduler.dispatch();
    scheduler.park('first', []);
    expect(() => scheduler.tryAcquireAgent('first', 'fallback')).toThrow(/running/);
    scheduler.resume('first');
    scheduler.dispatch();
    scheduler.complete('first');
    expect(() => scheduler.tryAcquireAgent('first', 'fallback')).toThrow(/running/);
    expect(scheduler.runningTaskForAgent('fallback')).toBeUndefined();
  });
});

it('routes planned tasks through worker capacity and reports the actual task holding the worker', async () => {
  const fixture = await useFixture('ts-bug');
  const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-worker-capacity-config-')));
  const paths = createStatePaths(path.join(tempDir('workforce-worker-capacity-'), 'state'));
  const store = openStateStore(paths, { mode: 'mutating' });
  registerCleanup(() => store.close());
  const events: Array<Record<string, unknown>> = [];
  const taskKeys = new Map<string, string>();
  const scenarios = new Map(['first', 'second'].map((key) => [key, writeScenario({
    scenarioVersion: 1,
    steps: [
      { action: 'edit_file', path: `docs/${key}.md`, content: `# ${key}\n` },
      { action: 'claim_done', message: `Added ${key}.` },
    ],
  })]));

  const result = await runPlanned({
    allowUnconfinedWrites: true,
    repoPath: fixture.path,
    config: loaded.config,
    configRaw: loaded.raw,
    configPath: loaded.path,
    requestText: 'Add two independent documents using the same worker.',
    requestSource: 'test',
    // One explicit assignment and one inherited assignment must share capacity.
    tasks: [
      { key: 'first', objective: 'Add docs/first.md.', agentId: 'engineer' },
      { key: 'second', objective: 'Add docs/second.md.' },
    ],
    checkFlags: ['node --version'],
    paths,
    db: store.db,
    stream: {
      line: () => {},
      event: (record) => { events.push(record); },
      openTask: (identity) => {
        if (identity.taskId !== undefined && identity.key !== undefined) taskKeys.set(identity.taskId, identity.key);
      },
    },
    adapterFactory: (_runtime, context) => new FakeAdapter({ scenarioPath: scenarios.get(taskKeys.get(context.taskId)!)! }),
  });

  expect(result.tasks.map((task) => ({ key: task.key, accepted: task.accepted }))).toEqual([
    { key: 'first', accepted: true },
    { key: 'second', accepted: true },
  ]);
  expect(events.filter((event) => event.type === 'schedule.dispatch').map((event) => event.tasks)).toEqual([['first'], ['second']]);
  expect(events.filter((event) => event.type === 'schedule.blocked').flatMap((event) => event.blocked)).toContainEqual({
    key: 'second', waitingOn: ['first'], reason: 'worker_busy',
  });
  expect(listEvents(store.db, result.runId).filter((event) => event.type === 'schedule.blocked').map((event) => event.payload)).toEqual([
    { blocked: [{ key: 'second', waitingOn: ['first'], reason: 'worker_busy' }] },
    { blocked: [] },
  ]);
}, 120_000);

it.each([
  { busy: true, outcome: 'refuses a busy worker' },
  { busy: false, outcome: 'uses an idle worker' },
])('runPlanned quota fallback $outcome and never substitutes the department head', async ({ busy }) => {
  const fixture = await useFixture('ts-bug');
  const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-busy-fallback-config-')));
  const config = validateAgentConfig({
    ...loaded.config,
    runtimes: { 'runtime-a': loaded.config.runtimes['fake-local'], 'runtime-b': loaded.config.runtimes['fake-local'] },
    defaults: { ...loaded.config.defaults, workerAgent: 'worker-a', plannerAgent: 'head', reviewerAgent: 'head', maxRepairAttempts: 0 },
    // Put the head first: fallback must skip it before checking the busy worker.
    agents: [
      { ...loaded.config.agents[0], id: 'head', runtime: 'runtime-b', instructions: 'head', policy: 'analysis' },
      { ...loaded.config.agents[0], id: 'worker-a', runtime: 'runtime-a', instructions: 'worker-a' },
      { ...loaded.config.agents[0], id: 'worker-b', runtime: 'runtime-b', instructions: 'worker-b' },
    ],
  });
  const paths = createStatePaths(path.join(tempDir('workforce-busy-fallback-'), 'state'));
  const store = openStateStore(paths, { mode: 'mutating' });
  registerCleanup(() => store.close());
  const scenarios = new Map(['a', 'b'].map((key) => [key, writeScenario({
    scenarioVersion: 1,
    steps: [{ action: 'edit_file', path: `docs/${key}.md`, content: `# ${key}\n` }],
  })]));
  const taskKeys = new Map<string, string>();
  const started: string[] = [];
  const active = new Set<string>();
  const overlaps: string[] = [];
  const probes: string[] = [];
  const peersDuringFallback: string[][] = [];
  let quotaReported = false;
  let markBStarted!: () => void;
  let markASettled!: () => void;
  const bStarted = new Promise<void>((resolve) => { markBStarted = resolve; });
  const aSettled = new Promise<void>((resolve) => { markASettled = resolve; });

  const result = await runPlanned({
    allowUnconfinedWrites: true,
    repoPath: fixture.path,
    config,
    configRaw: JSON.stringify(config),
    configPath: loaded.path,
    requestText: 'Run two workers and preserve their exclusive capacity during recovery.',
    requestSource: 'test',
    tasks: [{ key: 'a', objective: 'Add docs/a.md.', agentId: 'worker-a' }, ...(busy ? [{ key: 'b', objective: 'Add docs/b.md.', agentId: 'worker-b' }] : [])],
    checkFlags: ['node --version'],
    paths,
    db: store.db,
    stream: {
      line: () => {},
      event: (record) => {
        if (record.type === 'task.settled' && record.key === 'a') markASettled();
      },
      openTask: (identity) => {
        if (identity.taskId !== undefined && identity.key !== undefined) taskKeys.set(identity.taskId, identity.key);
      },
    },
    adapterFactory: (runtime, context) => {
      const key = taskKeys.get(context.taskId)!;
      class ControlledAdapter extends FakeAdapter {
        #agentId = '';
        override async probe(executablePath: string) {
          if (quotaReported) {
            probes.push(runtime.id);
            peersDuringFallback.push([...active]);
          }
          return super.probe(executablePath);
        }
        override async openSession(input: SessionInput): Promise<SessionHandle> {
          this.#agentId = input.systemInstructions ?? '';
          return super.openSession(input);
        }
        override async startTurn(session: SessionHandle, input: TurnInput): Promise<TurnHandle> {
          const turn = await super.startTurn(session, input);
          started.push(this.#agentId);
          if (active.has(this.#agentId)) overlaps.push(this.#agentId);
          active.add(this.#agentId);
          if (this.#agentId === 'worker-b' && key === 'b') markBStarted();
          return turn;
        }
        override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
          for await (const event of super.events(turn)) {
            if (event.kind !== 'turn_completed') { yield event; continue; }
            if (this.#agentId === 'worker-a') {
              if (busy) await bStarted;
              active.delete(this.#agentId);
              quotaReported = true;
              yield { ...event, payload: { ...event.payload, status: 'failed', error: 'Quota exhausted', errorClass: 'usage_limit' } };
            } else {
              // Keep B's turn active at the adapter boundary until A finishes
              // fallback selection. A mistaken fallback on B can still finish,
              // exposing duplicate ownership instead of hanging this test.
              if (key === 'b') await aSettled;
              active.delete(this.#agentId);
              yield event;
            }
          }
        }
      }
      return new ControlledAdapter({ scenarioPath: scenarios.get(key)! });
    },
  });

  expect(started).toHaveLength(2);
  expect(started.slice().sort()).toEqual(['worker-a', 'worker-b']);
  expect(overlaps).toEqual([]);
  const first = result.tasks.find((task) => task.key === 'a')!;
  expect(first.attempts).toHaveLength(busy ? 1 : 2);
  expect(first.attempts[0]?.failure?.failureClass).toBe('quota');
  if (busy) expect(result.tasks.find((task) => task.key === 'b')?.accepted).toBe(true);
  else expect(first.accepted).toBe(true);
  // The first two probes after quota are fallback selection. An accepted
  // replacement also gets runDirect's own readiness check before starting.
  expect(probes.slice(0, 2)).toEqual(['runtime-a', 'runtime-b']);
  expect(peersDuringFallback.slice(0, 2)).toEqual(busy ? [['worker-b'], ['worker-b']] : [[], []]);
  const fallback = listEvents(store.db, result.runId).find((event) => event.type === (busy ? 'runtime.fallback_unavailable' : 'runtime.fallback_selected'));
  expect(fallback?.payload['failureClass']).toBe('quota');
  expect(fallback?.payload['toRuntimeId']).toBe(busy ? null : 'runtime-b');
  if (busy) expect(fallback?.payload['refused']).toContain('runtime-b: no configured worker on this runtime has available capacity for this task');
}, 120_000);
