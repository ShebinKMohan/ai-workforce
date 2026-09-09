/**
 * A terminal that is not a terminal.
 *
 * The live view is driven entirely through injected clocks, timers and
 * streams, so every test in this directory runs without a pty: a fake stderr
 * carrying `isTTY`, `columns`, `rows` and a `resize` listener is all the view
 * ever asks for. The point is not speed — it is that a frame can be asserted
 * on as a string, which is the only way to hold "the screen says exactly this"
 * as a property.
 */
import type { Streams } from '../../../src/cli/output.js';
import type { LineOrigin } from '../../../src/core/run-stream.js';

const ESC = '\u001B';
export const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
export const strip = (text: string): string => text.replace(ANSI, '');
export const ALT_ENTER = `${ESC}[?1049h`;
export const ALT_LEAVE = `${ESC}[?1049l`;

export interface FakeTerminal {
  isTTY: boolean;
  columns: number;
  rows: number;
  write(chunk: string): boolean;
  on(event: 'resize', handler: () => void): void;
  off(event: 'resize', handler: () => void): void;
  /** Everything written, concatenated. */
  readonly out: () => string;
  /** How many times `write` was called: one call is one painted frame. */
  readonly writes: () => number;
  resize(columns: number, rows: number): void;
  clear(): void;
}

export function fakeTerminal(columns = 100, rows = 30, isTTY = true): FakeTerminal {
  let out = '';
  let writes = 0;
  const handlers = new Set<() => void>();
  const terminal: FakeTerminal = {
    isTTY,
    columns,
    rows,
    write: (chunk: string) => {
      out += chunk;
      writes += 1;
      return true;
    },
    on: (_event, handler) => {
      handlers.add(handler);
    },
    off: (_event, handler) => {
      handlers.delete(handler);
    },
    out: () => out,
    writes: () => writes,
    resize: (nextColumns, nextRows) => {
      terminal.columns = nextColumns;
      terminal.rows = nextRows;
      for (const handler of [...handlers]) handler();
    },
    clear: () => {
      out = '';
      writes = 0;
    },
  };
  return terminal;
}

export interface CapturedStreams extends Streams {
  stdoutText(): string;
  stderrText(): string;
}

export function fakeStreams(stdoutIsTTY = true): CapturedStreams {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void, isTTY: boolean): NodeJS.WritableStream =>
    ({
      isTTY,
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    stdout: sink((chunk) => (stdout += chunk), stdoutIsTTY),
    stderr: sink((chunk) => (stderr += chunk), stdoutIsTTY),
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

/** Timers under the test's control: nothing in the view fires until the test says so. */
export interface FakeTimers {
  setInterval(handler: () => void, ms: number): { unref?: () => void };
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): { unref?: () => void };
  clearTimeout(handle: unknown): void;
  /** Run every live interval once. */
  tick(times?: number): void;
  /** Fire every pending timeout. */
  flushTimeouts(): void;
  pendingIntervals(): number;
}

export function fakeTimers(): FakeTimers {
  const intervals = new Map<object, () => void>();
  const timeouts = new Map<object, () => void>();
  return {
    setInterval: (handler) => {
      const handle = {};
      intervals.set(handle, handler);
      return handle as { unref?: () => void };
    },
    clearInterval: (handle) => {
      intervals.delete(handle as object);
    },
    setTimeout: (handler) => {
      const handle = {};
      timeouts.set(handle, handler);
      return handle as { unref?: () => void };
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as object);
    },
    tick: (times = 1) => {
      for (let index = 0; index < times; index += 1) for (const handler of [...intervals.values()]) handler();
    },
    flushTimeouts: () => {
      for (const [handle, handler] of [...timeouts.entries()]) {
        timeouts.delete(handle);
        handler();
      }
    },
    pendingIntervals: () => intervals.size,
  };
}

/** A clock the test advances by hand, so elapsed times in a frame are exact rather than flaky. */
export function fakeClock(start = 1_700_000_000_000): { now: () => number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** One task's worth of identity, as `forTask` would stamp it. */
export interface ScriptIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly key: string;
  readonly agentId: string;
  readonly adapter: string;
}

export function identity(key: string, taskId = `task-${key}`): ScriptIdentity {
  return { runId: 'run-1234abcd', taskId, key, agentId: `engineer-${key}`, adapter: 'fake' };
}

/**
 * A scripted run: the exact sequence of stream calls a two-task planned run
 * makes, in the order `run-planned.ts` makes them.
 *
 * Written out rather than generated so that a change to the coordinator's own
 * call order shows up here as a deliberate edit, and so the replay-equality
 * test compares two renderings of provably identical input.
 */
export interface ScriptCall {
  readonly kind: 'line' | 'writeLine' | 'event' | 'open' | 'close';
  readonly text?: string;
  readonly key?: string;
  /** Who composed the line, as `run-direct.ts` tags it. Absent means the coordinator did. */
  readonly origin?: LineOrigin;
  readonly record?: Record<string, unknown> & { readonly type: string };
}

export function twoTaskScript(): ScriptCall[] {
  const alpha = identity('alpha');
  const beta = identity('beta');
  return [
    { kind: 'event', record: { type: 'run.created', runId: 'run-1234abcd', path: 'planned', taskCount: 2, repo: '/tmp/repo', baseRevision: '4b21ff0abcdef' } },
    { kind: 'line', text: 'run run-1234abcd (planned, 2 tasks)' },
    { kind: 'event', record: { type: 'schedule.dispatch', runId: 'run-1234abcd', tasks: ['alpha', 'beta'], activeTurns: 2, activeWriters: 2 } },
    { kind: 'open', key: 'alpha' },
    { kind: 'open', key: 'beta' },
    { kind: 'event', record: { type: 'workspace.created', path: '/tmp/ws/alpha', branch: 'wf/alpha', ...alpha } },
    { kind: 'writeLine', key: 'alpha', text: 'workspace /tmp/ws/alpha' },
    { kind: 'event', record: { ...alpha, type: 'session.opened', adapter: 'fake', sessionId: 'sess-a' } },
    { kind: 'event', record: { type: 'runtime.turn_started', payload: {}, ...alpha } },
    { kind: 'writeLine', key: 'alpha', text: '  turn started', origin: 'runtime' },
    { kind: 'event', record: { type: 'runtime.tool_call', payload: { tool: 'Read', path: 'src/a.ts' }, ...alpha } },
    { kind: 'writeLine', key: 'alpha', text: '  tool Read src/a.ts', origin: 'runtime' },
    { kind: 'event', record: { type: 'workspace.created', path: '/tmp/ws/beta', branch: 'wf/beta', ...beta } },
    { kind: 'writeLine', key: 'beta', text: 'workspace /tmp/ws/beta' },
    { kind: 'event', record: { type: 'runtime.turn_started', payload: {}, ...beta } },
    { kind: 'writeLine', key: 'beta', text: '  turn started', origin: 'runtime' },
    { kind: 'writeLine', key: 'alpha', text: '  changed src/a.ts', origin: 'runtime' },
    { kind: 'writeLine', key: 'alpha', text: '  diff line one', origin: 'runtime' },
    { kind: 'writeLine', key: 'alpha', text: '  diff line two', origin: 'runtime' },
    { kind: 'event', record: { type: 'runtime.turn_completed', payload: {}, ...alpha } },
    { kind: 'writeLine', key: 'alpha', text: '  turn completed', origin: 'runtime' },
    { kind: 'event', record: { ...alpha, type: 'checks.planned', criterionIds: ['unit', 'typecheck'] } },
    { kind: 'writeLine', key: 'alpha', text: 'running 2 acceptance check(s) against the frozen candidate' },
    { kind: 'event', record: { type: 'check.completed', criterionId: 'unit', outcome: 'passed', exitCode: 0, durationMs: 80, ...alpha } },
    { kind: 'writeLine', key: 'alpha', text: '  check unit: passed (exit 0) in 80ms', origin: 'verifier' },
    { kind: 'event', record: { type: 'task.settled', runId: 'run-1234abcd', key: 'alpha', taskId: alpha.taskId, accepted: true, repairsUsed: 0 } },
    { kind: 'close', key: 'alpha' },
    { kind: 'writeLine', key: 'beta', text: '  runtime error: provider refused', origin: 'runtime' },
    { kind: 'event', record: { type: 'task.settled', runId: 'run-1234abcd', key: 'beta', taskId: beta.taskId, accepted: false, repairsUsed: 1 } },
    { kind: 'close', key: 'beta' },
    { kind: 'line', text: 'evidence and manifest: /tmp/state/runs/run-1234abcd' },
  ];
}

/** Replay a script into any `RunStream`-shaped object. */
export function playScript(
  stream: {
    line(text: string): void;
    writeLine?(text: string, identity: ScriptIdentity, origin?: LineOrigin): void;
    openTask?(identity: ScriptIdentity): void;
    closeTask?(identity: ScriptIdentity): void;
    event(record: Record<string, unknown> & { readonly type: string }): void;
  },
  script: ReadonlyArray<ScriptCall>,
  between?: () => void,
): void {
  for (const call of script) {
    switch (call.kind) {
      case 'line':
        stream.line(call.text!);
        break;
      case 'writeLine':
        stream.writeLine!(call.text!, identity(call.key!), call.origin);
        break;
      case 'open':
        stream.openTask!(identity(call.key!));
        break;
      case 'close':
        stream.closeTask!(identity(call.key!));
        break;
      case 'event':
        stream.event(call.record!);
        break;
    }
    between?.();
  }
}
