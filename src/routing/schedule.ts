/**
 * Dependency scheduling (FR031, FR032).
 *
 * Readiness is per task, not per stage: a task becomes ready the moment the
 * artifacts it names exist and a slot is free. There is no global barrier, so
 * one fast prerequisite releases its dependent while an unrelated slow task is
 * still running.
 *
 * A task never holds a turn slot while it waits. It is not dispatched until its
 * dependencies are satisfied, and a running task that discovers it needs a peer
 * is parked, which releases its slots. Dependency cycles, wait cycles, failed
 * prerequisites and stalls surface as focused blockers instead of deadlocking.
 *
 * Pure and deterministic: the same task set and the same completion events
 * always produce the same dispatch order.
 */
import type { TaskDependency } from '../core/contracts.js';

export interface ScheduleTask {
  readonly id: string;
  readonly dependencies?: ReadonlyArray<TaskDependency>;
  /** The task writes to the candidate workspace and needs a writer slot. Defaults to true. */
  readonly writer?: boolean;
}

export interface ScheduleLimits {
  readonly maxActiveTurns: number;
  readonly maxActiveWriters: number;
}

/** An artifact or interface a completing task makes available to its dependents. */
export interface ArtifactPublication {
  readonly name: string;
  /** Contract/artifact version. Defaults to 1. Readiness refers to a version, not a process exit. */
  readonly version?: number;
}

export type ScheduleTaskState = 'pending' | 'running' | 'waiting' | 'accepted' | 'failed' | 'blocked';

export type BlockerKind =
  | 'unknown_dependency'
  | 'self_dependency'
  | 'dependency_cycle'
  | 'wait_cycle'
  | 'failed_dependency'
  | 'stalled';

export interface Blocker {
  readonly kind: BlockerKind;
  readonly taskIds: ReadonlyArray<string>;
  /** One sentence naming what must change for the run to move again. */
  readonly detail: string;
}

export interface ScheduleSnapshot {
  readonly states: Readonly<Record<string, ScheduleTaskState>>;
  readonly running: ReadonlyArray<string>;
  readonly activeTurns: number;
  readonly activeWriters: number;
  readonly blockers: ReadonlyArray<Blocker>;
}

interface TaskNode {
  readonly task: ScheduleTask;
  readonly index: number;
  readonly writer: boolean;
  readonly dependencies: ReadonlyArray<TaskDependency>;
  state: ScheduleTaskState;
  waitingOn: ReadonlyArray<string>;
}

export class Scheduler {
  readonly #nodes = new Map<string, TaskNode>();
  readonly #order: string[] = [];
  readonly #limits: ScheduleLimits;
  readonly #publications = new Map<string, Map<string, number>>();
  #blockers: Blocker[] = [];

  constructor(tasks: ReadonlyArray<ScheduleTask>, limits: ScheduleLimits) {
    this.#limits = limits;
    tasks.forEach((task, index) => {
      if (this.#nodes.has(task.id)) return;
      this.#nodes.set(task.id, {
        task,
        index,
        writer: task.writer ?? true,
        dependencies: task.dependencies ?? [],
        state: 'pending',
        waitingOn: [],
      });
      this.#order.push(task.id);
    });
    this.#validateGraph();
  }

  #validateGraph(): void {
    const unknown: string[] = [];
    const selfRefs: string[] = [];
    for (const id of this.#order) {
      const node = this.#nodes.get(id);
      if (node === undefined) continue;
      for (const dep of node.dependencies) {
        if (dep.taskId === id) selfRefs.push(id);
        else if (!this.#nodes.has(dep.taskId)) unknown.push(`${id} -> ${dep.taskId}`);
      }
    }
    if (selfRefs.length > 0) {
      this.#addBlocker({ kind: 'self_dependency', taskIds: [...new Set(selfRefs)], detail: `these tasks depend on themselves: ${[...new Set(selfRefs)].join(', ')}` });
    }
    if (unknown.length > 0) {
      const ids = unknown.map((e) => e.split(' -> ')[0]).filter((v): v is string => v !== undefined);
      this.#addBlocker({ kind: 'unknown_dependency', taskIds: [...new Set(ids)], detail: `dependencies that reference no task in this run: ${unknown.join(', ')}` });
    }
    const cycle = this.#findDependencyCycle();
    if (cycle !== null) {
      this.#addBlocker({ kind: 'dependency_cycle', taskIds: cycle, detail: `dependency cycle ${cycle.join(' -> ')}; no task in it can ever become ready` });
    }
  }

  #findDependencyCycle(): string[] | null {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      const seen = state.get(id);
      if (seen === 'done') return null;
      if (seen === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
      state.set(id, 'visiting');
      stack.push(id);
      const node = this.#nodes.get(id);
      for (const dep of node?.dependencies ?? []) {
        if (dep.taskId === id || !this.#nodes.has(dep.taskId)) continue;
        const found = visit(dep.taskId);
        if (found !== null) return found;
      }
      stack.pop();
      state.set(id, 'done');
      return null;
    };
    for (const id of this.#order) {
      const found = visit(id);
      if (found !== null) return found;
    }
    return null;
  }

  #addBlocker(blocker: Blocker): void {
    const duplicate = this.#blockers.some((b) => b.kind === blocker.kind && b.detail === blocker.detail);
    if (!duplicate) this.#blockers.push(blocker);
    for (const id of blocker.taskIds) {
      const node = this.#nodes.get(id);
      if (node !== undefined && node.state !== 'accepted' && node.state !== 'failed') node.state = 'blocked';
    }
    for (const id of blocker.taskIds) this.#blockDependentsOf(id);
  }

  #blockDependentsOf(id: string): void {
    for (const otherId of this.#order) {
      const node = this.#nodes.get(otherId);
      if (node === undefined || node.state === 'blocked' || node.state === 'accepted' || node.state === 'failed') continue;
      if (node.dependencies.some((d) => d.taskId === id)) {
        node.state = 'blocked';
        this.#blockDependentsOf(otherId);
      }
    }
  }

  get activeTurns(): number {
    return this.#order.filter((id) => this.#nodes.get(id)?.state === 'running').length;
  }

  get activeWriters(): number {
    return this.#order.filter((id) => {
      const node = this.#nodes.get(id);
      return node !== undefined && node.state === 'running' && node.writer;
    }).length;
  }

  /** True when every dependency of `id` is satisfied by an existing artifact version. */
  isReady(id: string): boolean {
    const node = this.#nodes.get(id);
    if (node === undefined) return false;
    return node.dependencies.every((dep) => this.#dependencySatisfied(dep));
  }

  #dependencySatisfied(dep: TaskDependency): boolean {
    const producer = this.#nodes.get(dep.taskId);
    if (producer === undefined) return false;
    const name = dep.artifact ?? dep.interface;
    if (name === undefined) return producer.state === 'accepted';
    const published = this.#publications.get(dep.taskId)?.get(name);
    if (published === undefined) return false;
    return published >= (dep.version ?? 1);
  }

  /**
   * Start every task that is ready and fits the slot budget, in declaration
   * order. Returns the ids started by this call.
   */
  dispatch(): string[] {
    const started: string[] = [];
    for (const id of this.#order) {
      const node = this.#nodes.get(id);
      if (node === undefined || node.state !== 'pending') continue;
      if (!this.isReady(id)) continue;
      if (this.activeTurns >= this.#limits.maxActiveTurns) break;
      if (node.writer && this.activeWriters >= this.#limits.maxActiveWriters) continue;
      node.state = 'running';
      node.waitingOn = [];
      started.push(id);
    }
    this.#detectStall();
    return started;
  }

  #detectStall(): void {
    if (this.activeTurns > 0) return;
    const stuck = this.#order.filter((id) => {
      const state = this.#nodes.get(id)?.state;
      return state === 'pending' || state === 'waiting';
    });
    if (stuck.length === 0) return;
    // Pending work with nothing running and nothing ready means no event can arrive.
    const anyReady = stuck.some((id) => this.#nodes.get(id)?.state === 'pending' && this.isReady(id));
    if (anyReady) return;
    const waiting = stuck.filter((id) => this.#nodes.get(id)?.state === 'waiting');
    if (waiting.length > 0) return; // a parked task is resumable by the coordinator, not a stall
    this.#addBlocker({
      kind: 'stalled',
      taskIds: stuck,
      detail: `no task is running and none of ${stuck.join(', ')} can become ready; their prerequisites will never produce the artifacts they name`,
    });
  }

  /** Mark a task accepted and publish the artifacts its dependents named. */
  complete(id: string, publishes: ReadonlyArray<ArtifactPublication> = []): void {
    const node = this.#requireNode(id);
    node.state = 'accepted';
    node.waitingOn = [];
    const map = this.#publications.get(id) ?? new Map<string, number>();
    for (const pub of publishes) {
      const version = pub.version ?? 1;
      const existing = map.get(pub.name);
      map.set(pub.name, existing === undefined ? version : Math.max(existing, version));
    }
    this.#publications.set(id, map);
  }

  fail(id: string, reason = 'the task failed'): void {
    const node = this.#requireNode(id);
    node.state = 'failed';
    node.waitingOn = [];
    const dependents = this.#order.filter((other) => this.#nodes.get(other)?.dependencies.some((d) => d.taskId === id) === true);
    if (dependents.length > 0) {
      this.#addBlocker({ kind: 'failed_dependency', taskIds: dependents, detail: `${dependents.join(', ')} depend on "${id}", which failed: ${reason}` });
    }
  }

  /**
   * A running task discovered it needs a peer. It yields its turn and writer
   * slots immediately so the peer can take one.
   */
  park(id: string, waitingOn: ReadonlyArray<string>, reason = 'waiting on a peer'): void {
    const node = this.#requireNode(id);
    node.state = 'waiting';
    node.waitingOn = [...waitingOn];
    const cycle = this.#findWaitCycle();
    if (cycle !== null) {
      this.#addBlocker({
        kind: 'wait_cycle',
        taskIds: cycle,
        detail: `wait cycle ${cycle.join(' -> ')}; each task is waiting for the next, so none of them will ever be resumed (${reason})`,
      });
    }
  }

  /** Return a parked task to the pending pool so it can take a slot again. */
  resume(id: string): void {
    const node = this.#requireNode(id);
    if (node.state !== 'waiting') return;
    node.state = 'pending';
    node.waitingOn = [];
  }

  #findWaitCycle(): string[] | null {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      const node = this.#nodes.get(id);
      if (node === undefined || node.state !== 'waiting') return null;
      const seen = state.get(id);
      if (seen === 'done') return null;
      if (seen === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
      state.set(id, 'visiting');
      stack.push(id);
      for (const next of node.waitingOn) {
        const found = visit(next);
        if (found !== null) return found;
      }
      stack.pop();
      state.set(id, 'done');
      return null;
    };
    for (const id of this.#order) {
      const found = visit(id);
      if (found !== null) return found;
    }
    return null;
  }

  #requireNode(id: string): TaskNode {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`unknown task "${id}"; the scheduler only knows ${this.#order.join(', ')}`);
    return node;
  }

  snapshot(): ScheduleSnapshot {
    const states: Record<string, ScheduleTaskState> = {};
    for (const id of this.#order) {
      const node = this.#nodes.get(id);
      if (node !== undefined) states[id] = node.state;
    }
    return {
      states,
      running: this.#order.filter((id) => this.#nodes.get(id)?.state === 'running'),
      activeTurns: this.activeTurns,
      activeWriters: this.activeWriters,
      blockers: [...this.#blockers],
    };
  }

  get blockers(): ReadonlyArray<Blocker> {
    return [...this.#blockers];
  }
}

export function createScheduler(tasks: ReadonlyArray<ScheduleTask>, limits: ScheduleLimits): Scheduler {
  return new Scheduler(tasks, limits);
}

// ---------------------------------------------------------------------------
// Pure simulation: a task set plus completion events yields a dispatch order.
// ---------------------------------------------------------------------------

export type ScheduleEvent =
  | { readonly type: 'complete'; readonly taskId: string; readonly publishes?: ReadonlyArray<ArtifactPublication> }
  | { readonly type: 'fail'; readonly taskId: string; readonly reason?: string }
  | { readonly type: 'park'; readonly taskId: string; readonly waitingOn: ReadonlyArray<string>; readonly reason?: string }
  | { readonly type: 'resume'; readonly taskId: string };

export interface SimulationResult {
  /** One entry per dispatch round; empty rounds are kept so timing is visible. */
  readonly batches: ReadonlyArray<ReadonlyArray<string>>;
  /** Flattened dispatch order. */
  readonly order: ReadonlyArray<string>;
  /** Snapshot after each dispatch round, aligned with `batches`. */
  readonly snapshots: ReadonlyArray<ScheduleSnapshot>;
  readonly blockers: ReadonlyArray<Blocker>;
  readonly finalStates: Readonly<Record<string, ScheduleTaskState>>;
}

export function simulateSchedule(input: {
  readonly tasks: ReadonlyArray<ScheduleTask>;
  readonly limits: ScheduleLimits;
  readonly events?: ReadonlyArray<ScheduleEvent>;
}): SimulationResult {
  const scheduler = new Scheduler(input.tasks, input.limits);
  const batches: string[][] = [];
  const snapshots: ScheduleSnapshot[] = [];

  const round = (): void => {
    batches.push(scheduler.dispatch());
    snapshots.push(scheduler.snapshot());
  };

  round();
  for (const event of input.events ?? []) {
    switch (event.type) {
      case 'complete':
        scheduler.complete(event.taskId, event.publishes ?? []);
        break;
      case 'fail':
        scheduler.fail(event.taskId, event.reason ?? 'the task failed');
        break;
      case 'park':
        scheduler.park(event.taskId, event.waitingOn, event.reason ?? 'waiting on a peer');
        break;
      case 'resume':
        scheduler.resume(event.taskId);
        break;
    }
    round();
  }

  const final = scheduler.snapshot();
  return { batches, order: batches.flat(), snapshots, blockers: final.blockers, finalStates: final.states };
}
