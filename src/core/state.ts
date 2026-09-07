/**
 * Pure lifecycle state machine for runs, tasks and attempts (plan section 8).
 *
 * The tables below are the only place that knows which transitions are
 * legal. Storage helpers call `assertTransition` before persisting a state
 * change, so an illegal transition can never reach the database.
 *
 * Deliberate omissions encode invariants:
 * - `running -> accepted` does not exist: a worker result must pass through
 *   `validating`; a runtime saying "done" cannot mark a task accepted (FR050).
 * - Nothing leaves `superseded`; a superseded generation is history.
 * - `cancelled -> ready` and `interrupted -> running` exist only for explicit
 *   resume, which the storage layer records as a new attempt generation.
 */
import type { AttemptState, RunState, TaskState, WaitReason } from './contracts.js';

type TransitionTable<S extends string> = Readonly<Record<S, ReadonlyArray<S>>>;

export const TASK_TRANSITIONS: TransitionTable<TaskState> = {
  pending: ['ready', 'waiting', 'failed', 'cancelled', 'superseded'],
  ready: ['running', 'waiting', 'failed', 'cancelled', 'superseded'],
  running: ['validating', 'waiting', 'failed', 'cancelled', 'superseded'],
  validating: ['accepted', 'ready', 'waiting', 'failed', 'cancelled', 'superseded'],
  waiting: ['ready', 'running', 'failed', 'cancelled', 'superseded'],
  accepted: ['superseded'],
  failed: ['ready', 'superseded'],
  cancelled: ['ready', 'superseded'],
  superseded: [],
};

export const RUN_TRANSITIONS: TransitionTable<RunState> = {
  pending: ['running', 'failed', 'cancelled'],
  running: ['waiting', 'ready_for_review', 'failed', 'cancelled', 'interrupted'],
  waiting: ['running', 'failed', 'cancelled', 'interrupted'],
  interrupted: ['running', 'failed', 'cancelled'],
  cancelled: ['running'],
  ready_for_review: [],
  failed: [],
};

export const ATTEMPT_TRANSITIONS: TransitionTable<AttemptState> = {
  pending: ['running', 'failed', 'cancelled', 'superseded'],
  running: ['completed', 'failed', 'interrupted', 'cancelled', 'superseded'],
  interrupted: ['running', 'failed', 'cancelled', 'superseded'],
  completed: ['superseded'],
  failed: ['superseded'],
  cancelled: ['superseded'],
  superseded: [],
};

export type EntityKind = 'run' | 'task' | 'attempt';

type StateOf<K extends EntityKind> = K extends 'run' ? RunState : K extends 'task' ? TaskState : AttemptState;

function tableFor<K extends EntityKind>(kind: K): TransitionTable<StateOf<K>> {
  switch (kind) {
    case 'run':
      return RUN_TRANSITIONS as TransitionTable<StateOf<K>>;
    case 'task':
      return TASK_TRANSITIONS as TransitionTable<StateOf<K>>;
    case 'attempt':
      return ATTEMPT_TRANSITIONS as TransitionTable<StateOf<K>>;
    default: {
      const never: never = kind;
      throw new Error(`unknown entity kind ${String(never)}`);
    }
  }
}

export class IllegalTransitionError extends Error {
  readonly kind: EntityKind;
  readonly from: string;
  readonly to: string;

  constructor(kind: EntityKind, from: string, to: string, allowed: ReadonlyArray<string>) {
    super(
      `illegal ${kind} transition ${from} -> ${to}; allowed from ${from}: ${allowed.length === 0 ? '(terminal state)' : allowed.join(', ')}`,
    );
    this.name = 'IllegalTransitionError';
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

/** True when `from -> to` is a legal transition for the entity kind. Same-state is never a transition. */
export function canTransition<K extends EntityKind>(kind: K, from: StateOf<K>, to: StateOf<K>): boolean {
  const allowed = tableFor(kind)[from] as ReadonlyArray<string> | undefined;
  return allowed !== undefined && allowed.includes(to);
}

/** Throws `IllegalTransitionError` for an illegal transition; returns `to` otherwise. */
export function assertTransition<K extends EntityKind>(kind: K, from: StateOf<K>, to: StateOf<K>): StateOf<K> {
  const allowed = (tableFor(kind)[from] as ReadonlyArray<string> | undefined) ?? [];
  if (!allowed.includes(to)) throw new IllegalTransitionError(kind, from, to, allowed);
  return to;
}

export function isTerminal<K extends EntityKind>(kind: K, state: StateOf<K>): boolean {
  const allowed = tableFor(kind)[state] as ReadonlyArray<string> | undefined;
  return allowed === undefined || allowed.length === 0;
}

/** A task in `waiting` must carry a reason; every other state must not. */
export function validateWaitReason(state: TaskState, reason: WaitReason | null | undefined): void {
  if (state === 'waiting' && (reason === null || reason === undefined)) {
    throw new Error('a waiting task must record an explicit wait reason (dependency, peer, user_intent, provider or pause)');
  }
  if (state !== 'waiting' && reason !== null && reason !== undefined) {
    throw new Error(`wait reason "${reason}" is only valid in state waiting, not ${state}`);
  }
}
