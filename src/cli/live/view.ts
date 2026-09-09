/**
 * The live run view: a `RunStream` that paints a board instead of a log, and
 * replays the log into the scrollback when it exits.
 *
 * ## What it is, and what it is not
 *
 * It is a lens. The durable record was never the screen: SQLite records every
 * runtime event as it happens, `events.jsonl` is projected at checkpoints, the
 * artifact store holds the patch and the receipts, and `workforce status
 * <run-id>` reads all of it read-only. None of that changes here. A view that
 * became the ledger would be a view that could lose a run.
 *
 * ## The two rules that shape the code
 *
 * 1. **Nothing paints from an event handler.** `event`, `line`, `writeLine`,
 *    `openTask` and `closeTask` redact, push into the reducer, and set a dirty
 *    flag. A timer paints, and only when dirty. A worker emitting five hundred
 *    tool results in two hundred milliseconds costs a handful of frames, not
 *    five hundred; and because clocks render at one-second granularity, an
 *    idle run changes one row per second and the painter goes quiet on its own.
 * 2. **Redaction happens at ingest, before anything enters a buffer.**
 *    `Reporter.info` is where redaction lives today, and this view bypasses
 *    the reporter for the whole duration of the run. A token-shaped string
 *    must appear in no painted byte and in no replayed byte, so it is scrubbed
 *    on the way in rather than on the way out.
 *
 * ## The teardown replay, and why it cannot drift
 *
 * There is exactly one plain renderer, built at construction. Every call this
 * view receives is forwarded to it, in order, unchanged. Its output goes into
 * a buffer while the board owns the screen; on `leave()` the buffer is written
 * to the normal screen and the same renderer switches to writing straight
 * through. So the invariant — *the post-run stdout bytes of a live run equal
 * the stdout bytes of the same run under `--view plain`* — is not something
 * this file tries to maintain. It is the same renderer, receiving the same
 * calls, in the same order. There is no second rendering path that could
 * disagree.
 *
 * ## Degrading is a decision, not a flap
 *
 * `degradeToPlain` is one-way. Leave the alt buffer, say why in one dim line,
 * flush what happened so far, and let the plain renderer carry on with its
 * label state intact. Growing the window back does not re-enter: a view that
 * flapped in and out of the alternate buffer while someone dragged a panel
 * edge would be worse than one that made a decision and stuck to it.
 */
import type { LineOrigin, RunStream, RunStreamIdentity } from '../../core/run-stream.js';
import { redactText } from '../../telemetry/redaction.js';
import { colorEnabled, dim, stripControl, unicodeEnabled } from '../ansi.js';
import { Reporter, type Streams } from '../output.js';
import { renderFrame, type FrameStyle } from './frame.js';
import { computeLayout, MIN_COLUMNS, MIN_ROWS } from './layout.js';
import { createPainter, type PaintTarget, type Painter } from './paint.js';
import { createPlainRenderer, identityOf, type PlainRenderer } from './plain.js';
import { readKeys, type Key, type KeyInput, type KeyReader } from './keys.js';
import { installRestoreHandlers, registerActiveView } from './restore.js';
import { initialState, reduce, RUN_LANE, type LiveState } from './state.js';

/** How often the painter may run. Fast enough to feel live, slow enough that a burst costs a handful of frames. */
export const FRAME_MS = 80;
/** A resize storm — dragging a panel edge fires one event per pixel row — is collapsed into one relayout. */
export const RESIZE_DEBOUNCE_MS = 50;
/** How long the `q` toast stays in the footer. */
export const TOAST_MS = 3_000;

export interface LiveTerminal extends PaintTarget {
  readonly isTTY?: boolean;
  on?(event: 'resize', handler: () => void): unknown;
  off?(event: 'resize', handler: () => void): unknown;
  removeListener?(event: 'resize', handler: () => void): unknown;
}

export interface LiveViewOptions {
  /** Where the transcript lands once the board is gone. Human mode only: the live view is never built under `--json`. */
  readonly streams: Streams;
  /** Where the board is painted. stderr, always: during the run nothing is written to stdout. */
  readonly terminal: LiveTerminal;
  readonly stdin?: KeyInput;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly heartbeatMs?: number;
  /** Register with the process-wide restore handlers. The CLI passes true; tests leave it off. */
  readonly restoreOnExit?: boolean;
  readonly setInterval?: (handler: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
  readonly setTimeout?: (handler: () => void, ms: number) => { unref?: () => void };
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface LiveView extends RunStream {
  /** Restore the terminal and replay the transcript. Idempotent, safe from a signal handler, and the FIRST thing an interrupt must do. */
  leave(reason?: string): void;
  /** Give up the board for good and finish in plain text. One-way. */
  degradeToPlain(reason: string): void;
  /** True while the alternate screen is in use. */
  readonly active: boolean;
  /** What the board is drawn from. Exposed for tests and for the `?` overlay's watch lines. */
  readonly state: LiveState;
}

/**
 * A pair of streams that buffer until told to pass through.
 *
 * This is how the replay is guaranteed byte-identical rather than merely
 * intended to be. The plain renderer writes here for the whole run; `drain()`
 * hands back exactly what it wrote, and `passThrough()` connects it to the
 * real terminal so it carries on from where it left off with its label state
 * intact.
 */
function switchableStreams(real: Streams): { streams: Streams; drain(): string; passThrough(): void } {
  let buffer = '';
  let direct = false;
  const wrap = (target: NodeJS.WritableStream): NodeJS.WritableStream =>
    ({
      // `isTTY` is carried through deliberately: the plain renderer decides
      // whether to colour from the stream it writes to, and the replay lands
      // on the same real terminal the board was drawn on.
      isTTY: (target as { isTTY?: boolean }).isTTY,
      write(chunk: string | Uint8Array) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        if (direct) return target.write(text);
        buffer += text;
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    streams: { stdout: wrap(real.stdout), stderr: wrap(real.stderr) },
    drain: () => {
      const value = buffer;
      buffer = '';
      return value;
    },
    passThrough: () => {
      direct = true;
    },
  };
}

export function createLiveView(options: LiveViewOptions): LiveView {
  const { streams, terminal } = options;
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const startInterval = options.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as { unref?: () => void });
  const stopInterval = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const startTimeout = options.setTimeout ?? ((handler, ms) => globalThis.setTimeout(handler, ms) as unknown as { unref?: () => void });
  const stopTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  // One plain renderer for the whole run: the transcript while the board is
  // up, the live output afterwards. `json` is false because the live view is
  // only ever built in human mode (see the degradation ladder in run.ts).
  const sink = switchableStreams(streams);
  const transcript: PlainRenderer = createPlainRenderer(new Reporter(false, sink.streams), sink.streams, {
    now,
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
  });

  const painter: Painter = createPainter(terminal);
  let state = initialState(now());
  let dirty = true;
  let tick = 0;
  let degraded = false;
  let entered = false;
  let frameTimer: { unref?: () => void } | null = null;
  let resizeTimer: unknown = null;
  let toastTimer: unknown = null;
  let keys: KeyReader | null = null;
  let unregister: (() => void) | null = null;

  const style: { focus: string; frozen: boolean; scroll: number; interleaved: boolean; detail: boolean; overlay: boolean; toast: string | null } = {
    focus: RUN_LANE,
    frozen: false,
    scroll: 0,
    interleaved: false,
    detail: false,
    overlay: false,
    toast: null,
  };

  const color = colorEnabled(terminal, env);
  const unicode = unicodeEnabled(env);

  const laneOf = (identity: RunStreamIdentity | undefined): string => identity?.taskId ?? RUN_LANE;

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
      // Redacted and stripped HERE, before the text enters any buffer: this
      // view bypasses Reporter.info, which is where both normally happen. A
      // control character that got as far as the ring would be re-emitted by
      // the row-diff painter on every frame that touched its row.
      ...(partial.line !== undefined ? { line: stripControl(redactText(partial.line)) } : {}),
      ...(partial.origin !== undefined ? { origin: partial.origin } : {}),
      ...(partial.lifecycle !== undefined ? { lifecycle: partial.lifecycle } : {}),
    });
    dirty = true;
    // The first lane to open takes the focus, so the pane is never empty while
    // an agent is talking.
    if (partial.lifecycle === 'open' && style.focus === RUN_LANE && state.lanes.length === 1) style.focus = state.lanes[0]!.id;
  };

  const size = (): { columns: number; rows: number } => ({ columns: terminal.columns ?? 80, rows: terminal.rows ?? 24 });

  const frameStyle = (): FrameStyle => ({
    color,
    unicode,
    focus: style.focus,
    frozen: style.frozen,
    scroll: style.scroll,
    interleaved: style.interleaved,
    detail: style.detail,
    overlay: style.overlay,
    toast: style.toast,
    now: now(),
    tick,
  });

  const paint = (): void => {
    if (!painter.active || degraded) return;
    const { columns, rows } = size();
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      degradeToPlain(`terminal too small (${columns}x${rows}; the board needs ${MIN_COLUMNS}x${MIN_ROWS})`);
      return;
    }
    tick += 1;
    painter.paint(renderFrame(state, computeLayout(columns, rows, state.lanes.length), frameStyle()));
    dirty = false;
  };

  const onResize = (): void => {
    if (resizeTimer !== null) stopTimeout(resizeTimer);
    resizeTimer = startTimeout(() => {
      resizeTimer = null;
      painter.invalidate();
      dirty = true;
      paint();
    }, RESIZE_DEBOUNCE_MS);
  };

  const teardown = (): void => {
    if (frameTimer !== null) stopInterval(frameTimer);
    frameTimer = null;
    if (resizeTimer !== null) stopTimeout(resizeTimer);
    resizeTimer = null;
    if (toastTimer !== null) stopTimeout(toastTimer);
    toastTimer = null;
    keys?.stop();
    keys = null;
    unregister?.();
    unregister = null;
    (terminal.off ?? terminal.removeListener)?.call(terminal, 'resize', onResize);
  };

  /** The complete transcript, written back to the normal screen in arrival order, then straight through from here on. */
  const flush = (reason?: string): void => {
    const text = sink.drain();
    sink.passThrough();
    if (reason !== undefined) streams.stdout.write(`${dim(stripControl(redactText(reason)), color)}\n`);
    if (text.length > 0) streams.stdout.write(text);
    for (const [laneId, dropped] of Object.entries(state.droppedByLane)) {
      if (dropped <= 0) continue;
      const lane = state.lanes.find((entry) => entry.id === laneId);
      // A truncated transcript says so by name rather than quietly ending
      // shorter than the same run under --view plain would have.
      streams.stdout.write(
        `${dim(`… ${dropped} earlier line(s) from [${lane?.label ?? 'run'}] are in this run's events.jsonl; "workforce status ${state.runId ?? ''}" has the full record`.trimEnd(), color)}\n`,
      );
    }
  };

  function leave(reason?: string): void {
    if (!entered) {
      // Never entered (a too-small terminal), or already left: either way the
      // renderer must still be connected to the real screen.
      flush(reason);
      return;
    }
    entered = false;
    teardown();
    painter.leave();
    flush(reason);
  }

  function degradeToPlain(reason: string): void {
    if (degraded) return;
    degraded = true;
    leave(`live view off: ${reason}`);
  }

  const setToast = (text: string): void => {
    style.toast = text;
    dirty = true;
    if (toastTimer !== null) stopTimeout(toastTimer);
    toastTimer = startTimeout(() => {
      style.toast = null;
      toastTimer = null;
      dirty = true;
    }, TOAST_MS);
  };

  const focusIndex = (): number => {
    const all = [RUN_LANE, ...state.lanes.map((lane) => lane.id)];
    const at = all.indexOf(style.focus);
    return at === -1 ? 0 : at;
  };

  const focusTo = (position: number): void => {
    const all = [RUN_LANE, ...state.lanes.map((lane) => lane.id)];
    const wrapped = ((position % all.length) + all.length) % all.length;
    style.focus = all[wrapped]!;
    style.interleaved = false;
    style.frozen = false;
    style.scroll = 0;
    dirty = true;
  };

  const onKey = (key: Key): void => {
    if (style.overlay && !(key.kind === 'char' && key.value === '?')) {
      style.overlay = false;
      dirty = true;
      return;
    }
    if (key.kind === 'char') {
      const value = key.value;
      if (value >= '1' && value <= '9') {
        if (state.lanes[Number(value) - 1] !== undefined) focusTo(Number(value));
        return;
      }
      if (value === '0') return focusTo(0);
      switch (value) {
        case 'f':
          style.frozen = !style.frozen;
          if (!style.frozen) style.scroll = 0;
          dirty = true;
          return;
        case 'a':
          style.interleaved = !style.interleaved;
          dirty = true;
          return;
        case 'd':
          style.detail = !style.detail;
          dirty = true;
          return;
        case '?':
          style.overlay = !style.overlay;
          dirty = true;
          return;
        case 'p':
          degradeToPlain('switched to plain text');
          return;
        case 'q':
          // Deliberately not a quit. A reflex `q` must never look like it
          // killed a five-minute run.
          setToast('^C interrupts this run; p leaves this view; workforce watch attaches from another terminal.');
          return;
        default:
          return;
      }
    }
    switch (key.kind) {
      case 'tab':
      case 'right':
        return focusTo(focusIndex() + 1);
      case 'shifttab':
      case 'left':
        return focusTo(focusIndex() - 1);
      case 'up':
        style.frozen = true;
        style.scroll += 1;
        dirty = true;
        return;
      case 'down':
        style.frozen = true;
        style.scroll = Math.max(0, style.scroll - 1);
        dirty = true;
        return;
      case 'pageup':
        style.frozen = true;
        style.scroll += Math.max(1, size().rows - 8);
        dirty = true;
        return;
      case 'pagedown':
        style.frozen = true;
        style.scroll = Math.max(0, style.scroll - Math.max(1, size().rows - 8));
        dirty = true;
        return;
      case 'end':
      case 'home':
        style.frozen = false;
        style.scroll = 0;
        dirty = true;
        return;
      default:
        return;
    }
  };

  // ---- enter -------------------------------------------------------------
  const initial = size();
  if (initial.columns < MIN_COLUMNS || initial.rows < MIN_ROWS) {
    degraded = true;
    sink.passThrough();
    streams.stdout.write(`${dim(`live view off: terminal too small (${initial.columns}x${initial.rows}; the board needs ${MIN_COLUMNS}x${MIN_ROWS})`, color)}\n`);
  } else {
    entered = painter.enter();
    frameTimer = startInterval(() => {
      if (dirty) paint();
    }, FRAME_MS);
    frameTimer.unref?.();
    terminal.on?.('resize', onResize);
    keys = readKeys(options.stdin, onKey);
    paint();
  }

  const view: LiveView = {
    get active() {
      return entered && !degraded;
    },
    get state() {
      return state;
    },
    leave,
    degradeToPlain,
    line: (text: string) => {
      transcript.line(text);
      if (!degraded) ingest({ line: text });
    },
    writeLine: (text: string, identity: RunStreamIdentity, origin?: LineOrigin) => {
      transcript.writeLine!(text, identity, origin);
      if (!degraded) ingest({ identity, line: text, ...(origin !== undefined ? { origin } : {}) });
    },
    openTask: (identity: RunStreamIdentity) => {
      transcript.openTask!(identity);
      if (!degraded && identity.taskId !== undefined) ingest({ identity, lifecycle: 'open' });
    },
    closeTask: (identity: RunStreamIdentity) => {
      transcript.closeTask!(identity);
      if (!degraded && identity.taskId !== undefined) ingest({ identity, lifecycle: 'close' });
    },
    event: (record) => {
      transcript.event(record);
      if (degraded) return;
      const { type, ...rest } = record;
      ingest({ identity: identityOf(rest), type, payload: record });
    },
  };

  if (entered && options.restoreOnExit === true) {
    installRestoreHandlers();
    unregister = registerActiveView(view);
  }
  return view;
}
