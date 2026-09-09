/**
 * The plain renderer: today's output, moved out of `run.ts` intact, plus two
 * things it was missing.
 *
 * This is the renderer for every non-TTY destination — a pipe, a redirect, a
 * CI log, `--json`, `TERM=dumb`, a terminal too small to draw a board — and it
 * is also what the live view replays into the user's scrollback when it exits.
 * That second role is why it is a separate module rather than a fallback
 * inside the live view: the durable, greppable account of a run must not
 * depend on whether a board happened to be drawn.
 *
 * What is new here:
 *
 * - **the continuation gutter.** `renderRuntimeEvent` and `previewPatch` both
 *   emit two-space-indented lines. Labelling each of a 120-line diff's rows
 *   `[api]` turns one event into 120 rows of noise, so a continuation that
 *   directly follows a line from the same lane gets a blank gutter of the same
 *   width instead — aligned under its parent, and still unambiguous, because
 *   the moment another lane interleaves the full label comes back.
 * - **the heartbeat status block.** An ordinary set of lines, entering
 *   scrollback like everything else, printed while two or more tasks are live.
 *   No cursor state, no carriage returns, nothing `tee` can mangle. That is
 *   the whole "is anything still alive?" answer for a CI log and for a
 *   terminal too small for the board.
 */
import type { LineOrigin, RunStream, RunStreamIdentity } from '../../core/run-stream.js';
import { colorEnabled, dim, paintIdentity, stripControl } from '../ansi.js';
import type { Reporter, Streams } from '../output.js';
import { redactedJson } from '../../telemetry/redaction.js';
import { formatElapsed } from './frame.js';
import { initialState, liveLaneCount, reduce, RUN_LANE, type LiveState } from './state.js';

/** How often the status block prints while two or more tasks are live. */
export const HEARTBEAT_MS = 10_000;

export interface PlainRendererOptions {
  /** 0 disables the periodic block; the event-driven ones still print. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  /** Injected so a test can drive the heartbeat without a real timer. */
  readonly setInterval?: (handler: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
}

export interface PlainRenderer extends RunStream {
  /** Print the status block now, whatever the timer is doing. Wired to dispatch, close and SIGINT. */
  statusBlock(reason?: string): void;
  /** Stop the heartbeat. Idempotent. */
  dispose(): void;
}

/**
 * How a task is named in front of its own lines.
 *
 * The plan key ("t1", "docs") is what a human wrote and what the rest of the
 * output already calls the task, so it wins. Failing that, the configured
 * agent id says which agent is talking, which is the next most useful thing;
 * a shortened task id is the last resort.
 */
export function taskLabel(identity: RunStreamIdentity): string | null {
  if (identity.key !== undefined) return identity.key;
  if (identity.agentId !== undefined) return identity.agentId;
  if (identity.taskId !== undefined) return identity.taskId.slice(0, 8);
  return null;
}

export function createPlainRenderer(reporter: Reporter, streams: Streams, options: PlainRendererOptions = {}): PlainRenderer {
  // Colour follows whichever stream the human lines actually land on: stdout
  // in human mode, stderr under --json. stdout in JSON mode carries JSONL and
  // never gets an escape code either way.
  const color = colorEnabled(reporter.json ? streams.stderr : streams.stdout);
  const now = options.now ?? (() => Date.now());
  const startInterval = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as { unref?: () => void });
  const stopInterval = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));

  const live = new Set<string>();
  let labelled = false;
  /** The lane whose line was printed last, so a continuation knows whether it is still under its own parent. */
  let lastLane: string | null = null;
  let state: LiveState = initialState(now());
  let heartbeat: { unref?: () => void } | null = null;
  let disposed = false;

  const laneOf = (identity: RunStreamIdentity): string => identity.taskId ?? RUN_LANE;

  const ingest = (partial: {
    identity?: RunStreamIdentity;
    type?: string;
    payload?: Record<string, unknown>;
    line?: string;
    origin?: LineOrigin;
    lifecycle?: 'open' | 'close';
  }): void => {
    const identity = partial.identity ?? {};
    state = reduce(state, {
      at: now(),
      laneId: laneOf(identity),
      identity,
      ...(partial.type !== undefined ? { type: partial.type } : {}),
      ...(partial.payload !== undefined ? { payload: partial.payload } : {}),
      ...(partial.line !== undefined ? { line: partial.line } : {}),
      ...(partial.origin !== undefined ? { origin: partial.origin } : {}),
      ...(partial.lifecycle !== undefined ? { lifecycle: partial.lifecycle } : {}),
    });
  };

  const render = (text: string, identity: RunStreamIdentity): string => {
    const lane = laneOf(identity);
    if (!labelled) {
      lastLane = lane;
      return text;
    }
    const label = taskLabel(identity);
    if (label === null) {
      lastLane = lane;
      return text;
    }
    // A continuation that follows its own lane keeps the column but drops the
    // label. Any interleave brings the label straight back, so attribution is
    // never actually lost — only deduplicated.
    if (text.startsWith('  ') && lastLane === lane) return `${' '.repeat(label.length + 3)}${text}`;
    lastLane = lane;
    return `${dim('[', color)}${paintIdentity(label, label, color)}${dim(']', color)} ${text}`;
  };

  const statusBlock = (reason?: string): void => {
    if (state.lanes.length === 0) return;
    const at = now();
    const head = `workforce ${state.runId === null ? '' : `${state.runId.slice(0, 8)} `}· ${formatElapsed(at - state.startedAt)} · ${liveLaneCount(state)} live${reason === undefined ? '' : ` · ${reason}`}`;
    reporter.info(dim(`--- ${head} ---`, color));
    for (const lane of state.lanes) {
      const detail = lane.status === 'queued' && lane.waitingOn.length > 0 ? `waiting on: ${lane.waitingOn.join(', ')}` : lane.now.trim();
      reporter.info(
        `    ${dim('[', color)}${paintIdentity(lane.label, lane.label, color)}${dim(']', color)} ${lane.status.padEnd(11)}${formatElapsed(at - lane.openedAt).padStart(5)}  ${detail}`,
      );
    }
    // The block is a print, not a cursor line, so the next ordinary line must
    // not look like it belongs to the last lane above.
    lastLane = null;
  };

  const armHeartbeat = (): void => {
    const period = options.heartbeatMs ?? HEARTBEAT_MS;
    if (period <= 0 || heartbeat !== null || disposed) return;
    heartbeat = startInterval(() => {
      if (liveLaneCount(state) >= 2) statusBlock();
    }, period);
    heartbeat.unref?.();
  };

  const renderer: PlainRenderer = {
    line: (text: string) => {
      // Stripped before it is labelled, so the label's own colour survives and
      // nothing the runtime quoted can move the cursor. `Reporter.info` strips
      // again on the way out; that pass has to keep this renderer's SGR, so it
      // cannot be the one that decides what counts as untrusted.
      const safe = stripControl(text);
      ingest({ line: safe });
      reporter.info(render(safe, {}));
    },
    writeLine: (text: string, identity: RunStreamIdentity, origin?: LineOrigin) => {
      const safe = stripControl(text);
      // The plain renderer prints a line the same way whatever its origin is:
      // it has no marks to award, and its output bytes are the contract the
      // live view's teardown replay is compared against.
      ingest({ identity, line: safe, ...(origin !== undefined ? { origin } : {}) });
      reporter.info(render(safe, identity));
    },
    openTask: (identity: RunStreamIdentity) => {
      if (identity.taskId === undefined) return;
      ingest({ identity, lifecycle: 'open' });
      live.add(identity.taskId);
      if (live.size > 1) {
        // Once two tasks have overlapped the labels stay on for the rest of
        // the run: dropping them the moment one worker finishes would leave
        // the survivor's remaining lines looking like run-level output.
        labelled = true;
        armHeartbeat();
      }
    },
    closeTask: (identity: RunStreamIdentity) => {
      if (identity.taskId === undefined) return;
      ingest({ identity, lifecycle: 'close' });
      live.delete(identity.taskId);
      if (labelled && liveLaneCount(state) >= 1 && state.lanes.length > 1) statusBlock();
    },
    event: (record) => {
      const { type, ...rest } = record;
      ingest({ identity: identityOf(rest), type, payload: record });
      if (type === 'schedule.dispatch' && labelled) statusBlock('dispatched');
      if (reporter.json) streams.stdout.write(`${redactedJson(record)}\n`);
    },
    statusBlock,
    dispose: () => {
      disposed = true;
      if (heartbeat !== null) stopInterval(heartbeat);
      heartbeat = null;
    },
  };
  return renderer;
}

/**
 * The identity fields a stamped event record carries, back out of the record.
 *
 * `forTask` stamps them ON the record, so a renderer that only sees
 * `event(record)` can still route it without a second channel.
 */
export function identityOf(record: Record<string, unknown>): RunStreamIdentity {
  const pick = (key: string): string | undefined => (typeof record[key] === 'string' ? (record[key] as string) : undefined);
  return {
    ...(pick('runId') !== undefined ? { runId: pick('runId')! } : {}),
    ...(pick('taskId') !== undefined ? { taskId: pick('taskId')! } : {}),
    ...(pick('attemptId') !== undefined ? { attemptId: pick('attemptId')! } : {}),
    ...(pick('agentId') !== undefined ? { agentId: pick('agentId')! } : {}),
    ...(pick('runtimeId') !== undefined ? { runtimeId: pick('runtimeId')! } : {}),
    ...(pick('adapter') !== undefined ? { adapter: pick('adapter')! } : {}),
    ...(pick('key') !== undefined ? { key: pick('key')! } : {}),
  };
}
