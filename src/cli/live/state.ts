/**
 * What the live view knows, as a pure reducer.
 *
 * No I/O, no ANSI, no clock of its own. `reduce(state, event)` takes one
 * `LiveEvent` and returns the next `LiveState`; everything on screen is a
 * function of that state and the terminal's size.
 *
 * ## Why it consumes records, not stream calls
 *
 * There are two producers and they must agree. `view.ts` adapts the
 * coordinator's `RunStream` calls into `LiveEvent`s during a run; `watch.ts`
 * adapts persisted event rows into the same shape from a second terminal,
 * against the same run or a finished one. If the reducer took stream calls,
 * `watch` would need a second reducer, and two reducers that disagree about
 * what "verified" means are two different accounts of the same run.
 *
 * ## The one rule this file exists to enforce
 *
 * A lane's terminal state is *stated*, never inferred. `verified` comes from
 * `task.settled {accepted:true}` and from nothing else — not from a closed
 * stream, not from a trailing `check.completed`, not from `turn completed`. A
 * runtime saying "done" never marks a task accepted (AGENTS.md rule 3), and a
 * view that inferred acceptance would present the inference as fact.
 */
import { stripControl } from '../ansi.js';
import type { LineOrigin, RunStreamIdentity } from '../../core/run-stream.js';

export type { LineOrigin };

/** The lane a run-level line belongs to. Not a task, so it can never collide with a task id. */
export const RUN_LANE = '';

/** How far a lane's own scrollback is kept for the focus pane. */
export const LANE_RING_LIMIT = 2000;

/** How much of the whole run is kept for the teardown replay. Separate from the ring: the replay must not be silently shortened. */
export const TRANSCRIPT_LIMIT = 50_000;

/** A lane produces no event for this long and its `now` gains an idle suffix. Not a spinner: a fact. */
export const IDLE_AFTER_MS = 10_000;

export type LaneStatus =
  | 'queued'
  | 'workspace'
  | 'starting'
  | 'working'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'interrupted'
  | 'ended'
  | 'run';

/** One record the reducer consumes. `view.ts` builds these from stream calls; `watch.ts` from database rows. */
export interface LiveEvent {
  readonly at: number;
  /** Which lane. `RUN_LANE` for run-level output. */
  readonly laneId: string;
  readonly identity?: RunStreamIdentity;
  /** A normalized event record, when there is one. */
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
  /** A human line, already rendered and already redacted. The reducer strips control characters from it. */
  readonly line?: string;
  /** Who composed `line`. Absent means `coordinator`; see `LineOrigin`. */
  readonly origin?: LineOrigin;
  /** Lane lifecycle. `open` registers a board row; `close` ends it. */
  readonly lifecycle?: 'open' | 'close';
}

export interface CheckState {
  readonly criterionId: string;
  readonly laneId: string;
  readonly outcome: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export interface Lane {
  readonly id: string;
  /** 1-based board position, in dispatch order. 0 is the run lane. A lane never moves once it appears. */
  readonly index: number;
  /** What a human calls it: the plan key, else the agent id, else a short task id. */
  readonly label: string;
  readonly agentId: string | null;
  readonly adapter: string | null;
  readonly runtimeId: string | null;
  readonly sessionId: string | null;
  readonly workspace: string | null;
  readonly status: LaneStatus;
  readonly openedAt: number;
  readonly lastAt: number;
  /** Last non-empty line this lane produced, trimmed. Never invented. */
  readonly now: string;
  /** The keys this lane is waiting on, from `schedule.blocked`. */
  readonly waitingOn: ReadonlyArray<string>;
  readonly blockedReason: string | null;
  readonly turn: number;
  readonly tools: number;
  readonly files: number;
  /** Writes the runtime reported OUTSIDE the granted paths. Yellow, never hidden. */
  readonly outside: number;
  readonly settled: boolean | null;
  readonly repairsUsed: number;
  /** Newest last. Bounded by `LANE_RING_LIMIT`; the replay reads the transcript instead. */
  readonly lines: ReadonlyArray<LaneLine>;
  /** Lines dropped from the ring, so the pane can say so rather than quietly shortening. */
  readonly dropped: number;
}

/**
 * One line in a lane's ring, with the provenance the pane needs to decide
 * whether it may put a mark on it.
 *
 * A bare `string[]` was the whole reason the focus pane could not tell a
 * verifier's receipt from a model claiming the same words: by the time the
 * renderer saw the line, the only thing left to classify it by was its prose.
 */
export interface LaneLine {
  readonly text: string;
  readonly origin: LineOrigin;
}

export interface TranscriptEntry {
  readonly laneId: string;
  readonly text: string;
  readonly origin: LineOrigin;
}

export interface LiveState {
  readonly runId: string | null;
  readonly repo: string | null;
  readonly baseRevision: string | null;
  readonly branch: string | null;
  readonly plannedTaskCount: number;
  readonly startedAt: number;
  readonly lastAt: number;
  readonly interrupted: boolean;
  readonly finished: boolean;
  readonly accepted: boolean | null;
  readonly activeTurns: number;
  readonly activeWriters: number;
  /** In dispatch order. The run lane is not in here; it is `run`. */
  readonly lanes: ReadonlyArray<Lane>;
  readonly run: Lane;
  readonly checks: ReadonlyArray<CheckState>;
  /** Arrival order, every lane interleaved. The replay's source; never the ring. */
  readonly transcript: ReadonlyArray<TranscriptEntry>;
  readonly transcriptDropped: number;
  /** Per lane, how many transcript entries were dropped, so the replay can name them. */
  readonly droppedByLane: Readonly<Record<string, number>>;
}

function emptyLane(id: string, index: number, label: string, at: number, status: LaneStatus): Lane {
  return {
    id,
    index,
    label,
    agentId: null,
    adapter: null,
    runtimeId: null,
    sessionId: null,
    workspace: null,
    status,
    openedAt: at,
    lastAt: at,
    now: '',
    waitingOn: [],
    blockedReason: null,
    turn: 0,
    tools: 0,
    files: 0,
    outside: 0,
    settled: null,
    repairsUsed: 0,
    lines: [],
    dropped: 0,
  };
}

export function initialState(at = 0): LiveState {
  return {
    runId: null,
    repo: null,
    baseRevision: null,
    branch: null,
    plannedTaskCount: 0,
    startedAt: at,
    lastAt: at,
    interrupted: false,
    finished: false,
    accepted: null,
    activeTurns: 0,
    activeWriters: 0,
    lanes: [],
    run: emptyLane(RUN_LANE, 0, 'run', at, 'run'),
    checks: [],
    transcript: [],
    transcriptDropped: 0,
    droppedByLane: {},
  };
}

/** What a human calls this lane. The plan key wins: it is what the operator wrote and what the rest of the output already says. */
export function laneLabel(identity: RunStreamIdentity | undefined, laneId: string): string {
  if (identity?.key !== undefined) return identity.key;
  if (identity?.agentId !== undefined) return identity.agentId;
  if (identity?.taskId !== undefined) return identity.taskId.slice(0, 8);
  return laneId === RUN_LANE ? 'run' : laneId.slice(0, 8);
}

/** Rank of a lane status, so a later event can never walk a lane backwards out of a terminal state. */
const TERMINAL: ReadonlySet<LaneStatus> = new Set<LaneStatus>(['verified', 'failed', 'interrupted']);

/**
 * The runtime payload, whichever shape it arrived in.
 *
 * On the live stream `run-direct.ts` nests the adapter payload under
 * `payload`; in the database `runtimeEventToAppend` spreads it flat over the
 * event's base fields. Same facts, two shapes, one accessor — so the reducer
 * never has to know which producer it is reading.
 */
function runtimePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (payload === undefined) return {};
  const inner = payload['payload'];
  return inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : payload;
}

function withLane(state: LiveState, laneId: string, change: (lane: Lane) => Lane): LiveState {
  if (laneId === RUN_LANE) return { ...state, run: change(state.run) };
  const index = state.lanes.findIndex((lane) => lane.id === laneId);
  if (index === -1) return state;
  const lanes = [...state.lanes];
  lanes[index] = change(lanes[index]!);
  return { ...state, lanes };
}

function advance(lane: Lane, status: LaneStatus): Lane {
  if (TERMINAL.has(lane.status) && status !== 'interrupted') return lane;
  return { ...lane, status };
}

function pushLine(lane: Lane, text: string, origin: LineOrigin, at: number): Lane {
  const lines: LaneLine[] = [...lane.lines, { text, origin }];
  const dropped = lane.dropped + Math.max(0, lines.length - LANE_RING_LIMIT);
  return {
    ...lane,
    lines: lines.length > LANE_RING_LIMIT ? lines.slice(lines.length - LANE_RING_LIMIT) : lines,
    dropped,
    lastAt: at,
    now: text.trim().length > 0 ? text.trim() : lane.now,
  };
}

/**
 * A continuation line: two leading spaces and nothing structural.
 *
 * `renderRuntimeEvent` and `previewPatch` both emit `"  …"`, so this is not a
 * heuristic about prose — it is the shape those two functions actually
 * produce. The plain renderer uses it to keep a 120-line diff attached to one
 * labelled lane instead of stamping 120 labels on it.
 */
export function isContinuation(text: string): boolean {
  return text.startsWith('  ');
}

export function reduce(state: LiveState, event: LiveEvent): LiveState {
  let next: LiveState = { ...state, lastAt: Math.max(state.lastAt, event.at) };
  const laneId = event.laneId;

  if (event.lifecycle === 'open' && laneId !== RUN_LANE && !next.lanes.some((lane) => lane.id === laneId)) {
    // In dispatch order, and a lane never moves once it appears — not when it
    // finishes, not when another lane settles. A row that jumps is a row a
    // reader has to find again every second.
    const lane = emptyLane(laneId, next.lanes.length + 1, laneLabel(event.identity, laneId), event.at, 'queued');
    next = { ...next, lanes: [...next.lanes, lane] };
  }

  if (event.identity !== undefined && laneId !== RUN_LANE) {
    const identity = event.identity;
    next = withLane(next, laneId, (lane) => ({
      ...lane,
      label: identity.key ?? lane.label,
      agentId: identity.agentId ?? lane.agentId,
      adapter: identity.adapter ?? lane.adapter,
      runtimeId: identity.runtimeId ?? lane.runtimeId,
    }));
  }

  if (event.type !== undefined) next = reduceEvent(next, laneId, event.type, event.payload ?? {}, event.at);

  if (event.line !== undefined) {
    // Producers strip on the way in — they have to, because their own plain
    // output never passes through here. This second pass is what makes the
    // ring's contents a property of the reducer rather than of whoever fed it:
    // no escape sequence can be in a lane's scrollback, so no renderer reading
    // that scrollback has to be careful.
    const text = stripControl(event.line);
    const origin = event.origin ?? 'coordinator';
    next = withLane(next, laneId, (lane) => pushLine(lane, text, origin, event.at));
    const transcript = [...next.transcript, { laneId, text, origin }];
    if (transcript.length > TRANSCRIPT_LIMIT) {
      const removed = transcript.splice(0, transcript.length - TRANSCRIPT_LIMIT);
      const droppedByLane = { ...next.droppedByLane };
      for (const entry of removed) droppedByLane[entry.laneId] = (droppedByLane[entry.laneId] ?? 0) + 1;
      next = { ...next, transcriptDropped: next.transcriptDropped + removed.length, droppedByLane };
    }
    next = { ...next, transcript };
  }

  if (event.lifecycle === 'close' && laneId !== RUN_LANE) {
    // A stream that closed without a settlement says only that the task
    // stopped being reachable. It does not say the task succeeded, so the row
    // says `ended` and stays uncoloured.
    next = withLane(next, laneId, (lane) => (lane.settled === null && !TERMINAL.has(lane.status) ? { ...lane, status: 'ended', lastAt: event.at } : lane));
  }

  return next;
}

function reduceEvent(state: LiveState, laneId: string, type: string, payload: Record<string, unknown>, at: number): LiveState {
  let next = state;
  const str = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null);

  switch (type) {
    case 'run.created':
      next = {
        ...next,
        runId: str('runId') ?? next.runId,
        repo: str('repo') ?? next.repo,
        baseRevision: str('baseRevision') ?? next.baseRevision,
        plannedTaskCount: typeof payload['taskCount'] === 'number' ? (payload['taskCount'] as number) : next.plannedTaskCount,
      };
      break;
    case 'workspace.created':
      next = withLane(next, laneId, (lane) => ({ ...advance(lane, 'workspace'), workspace: str('path') ?? lane.workspace, lastAt: at }));
      if (next.branch === null) next = { ...next, branch: str('branch') };
      break;
    case 'session.opened':
      next = withLane(next, laneId, (lane) => ({ ...advance(lane, 'starting'), sessionId: str('sessionId') ?? lane.sessionId, adapter: str('adapter') ?? lane.adapter, lastAt: at }));
      break;
    case 'runtime.turn_started':
      next = withLane(next, laneId, (lane) => ({ ...advance(lane, 'working'), turn: lane.turn + 1, lastAt: at }));
      break;
    case 'runtime.turn_completed':
      // Plain foreground, never green. Only the verifier may turn something
      // green; a runtime saying "done" is a claim, not evidence.
      next = withLane(next, laneId, (lane) => ({ ...advance(lane, 'verifying'), lastAt: at }));
      break;
    case 'runtime.tool_call':
      next = withLane(next, laneId, (lane) => ({ ...lane, tools: lane.tools + 1, lastAt: at }));
      break;
    case 'runtime.file_change': {
      const inner = runtimePayload(payload);
      const phase = typeof inner['phase'] === 'string' ? inner['phase'] : null;
      const outside = inner['withinAllowedPaths'] === false;
      next = withLane(next, laneId, (lane) => ({
        ...lane,
        files: phase === 'completed' && inner['applied'] !== false && inner['denied'] !== true ? lane.files + 1 : lane.files,
        outside: outside ? lane.outside + 1 : lane.outside,
        lastAt: at,
      }));
      break;
    }
    case 'checks.planned': {
      const ids = Array.isArray(payload['criterionIds']) ? (payload['criterionIds'] as unknown[]).filter((id): id is string => typeof id === 'string') : [];
      const known = new Set(next.checks.map((check) => `${check.laneId}:${check.criterionId}`));
      const added = ids.filter((id) => !known.has(`${laneId}:${id}`)).map((id) => ({ criterionId: id, laneId, outcome: null, exitCode: null, durationMs: null }));
      next = { ...next, checks: [...next.checks, ...added] };
      next = withLane(next, laneId, (lane) => ({ ...advance(lane, 'verifying'), lastAt: at }));
      break;
    }
    case 'check.completed': {
      const criterionId = str('criterionId');
      if (criterionId !== null) {
        const outcome = str('outcome');
        const exitCode = typeof payload['exitCode'] === 'number' ? (payload['exitCode'] as number) : null;
        const durationMs = typeof payload['durationMs'] === 'number' ? (payload['durationMs'] as number) : null;
        const index = next.checks.findIndex((check) => check.criterionId === criterionId && check.laneId === laneId);
        const record: CheckState = { criterionId, laneId, outcome, exitCode, durationMs };
        const checks = index === -1 ? [...next.checks, record] : next.checks.map((check, position) => (position === index ? record : check));
        next = { ...next, checks };
      }
      break;
    }
    case 'task.settled': {
      const accepted = payload['accepted'] === true;
      const repairsUsed = typeof payload['repairsUsed'] === 'number' ? (payload['repairsUsed'] as number) : 0;
      // The only place `verified` is ever written.
      next = withLane(next, laneId, (lane) => ({ ...lane, status: accepted ? 'verified' : 'failed', settled: accepted, repairsUsed, lastAt: at, waitingOn: [], blockedReason: null }));
      break;
    }
    case 'schedule.dispatch':
      next = {
        ...next,
        activeTurns: typeof payload['activeTurns'] === 'number' ? (payload['activeTurns'] as number) : next.activeTurns,
        activeWriters: typeof payload['activeWriters'] === 'number' ? (payload['activeWriters'] as number) : next.activeWriters,
      };
      break;
    case 'schedule.blocked': {
      const blocked = Array.isArray(payload['blocked']) ? (payload['blocked'] as Array<Record<string, unknown>>) : [];
      const byKey = new Map<string, { waitingOn: string[]; reason: string }>();
      for (const entry of blocked) {
        const key = typeof entry['key'] === 'string' ? entry['key'] : null;
        if (key === null) continue;
        const waitingOn = Array.isArray(entry['waitingOn']) ? (entry['waitingOn'] as unknown[]).filter((value): value is string => typeof value === 'string') : [];
        byKey.set(key, { waitingOn, reason: typeof entry['reason'] === 'string' ? entry['reason'] : 'dependency' });
      }
      next = {
        ...next,
        lanes: next.lanes.map((lane) => {
          const found = byKey.get(lane.label);
          if (found === undefined) return lane;
          return { ...lane, waitingOn: found.waitingOn, blockedReason: found.reason };
        }),
      };
      break;
    }
    // `runDirect` emits `run.<outcome>` for the attempt it just finished, and
    // on the planned path that record carries a TASK id — one per worker, long
    // before the run itself is over. Read run-wide, four of them would declare
    // the run accepted four times while three tasks were still running. So an
    // outcome record is run-level only when it belongs to no lane; on a lane it
    // is that attempt's outcome, which is not a settlement (a repair may
    // follow) and never moves the lane out of `verifying`.
    case 'run.interrupted':
      next =
        laneId === RUN_LANE
          ? { ...next, interrupted: true, finished: true, lanes: next.lanes.map((lane) => (TERMINAL.has(lane.status) ? lane : { ...lane, status: 'interrupted' })) }
          : withLane(next, laneId, (lane) => (TERMINAL.has(lane.status) ? lane : { ...lane, status: 'interrupted', lastAt: at }));
      break;
    case 'run.accepted':
      if (laneId === RUN_LANE) next = { ...next, finished: true, accepted: true };
      break;
    case 'run.failed':
      if (laneId === RUN_LANE) next = { ...next, finished: true, accepted: false };
      break;
    default:
      break;
  }
  return next;
}

/** Every lane, run lane first: the order the `0`-`9` keys and the `a` view use. */
export function allLanes(state: LiveState): ReadonlyArray<Lane> {
  return [state.run, ...state.lanes];
}

export function findLane(state: LiveState, id: string): Lane | undefined {
  return id === RUN_LANE ? state.run : state.lanes.find((lane) => lane.id === id);
}

/** How many lanes have not reached a terminal state. What the heartbeat block counts. */
export function liveLaneCount(state: LiveState): number {
  return state.lanes.filter((lane) => !TERMINAL.has(lane.status) && lane.status !== 'ended').length;
}
