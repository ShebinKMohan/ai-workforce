/**
 * `workforce watch <run-id> [--task <key>]` — one agent, in a terminal of its
 * own (FR081).
 *
 * This is the supported, cross-platform answer to "let each agent spin up its
 * own terminal": open a split, point it at one agent, and watch only that
 * agent's output at full height. Nothing is spawned, nothing is owned, and
 * nothing can be steered from here.
 *
 * ## Why it reads the database and not the log file
 *
 * `events.jsonl` is projected at three checkpoints inside a run, so a
 * `tail -f` on it shows nothing at all until the run is nearly over. That one
 * fact is why every file-tailing version of this idea quietly does not work.
 * The events table, by contrast, gets a row per runtime event as it happens.
 *
 * ## Why it takes no lock
 *
 * `openStateStore(paths, { mode: 'read-only' })` never touches
 * `coordinator.lock` and never migrates; WAL plus the busy timeout makes the
 * concurrent read safe. `workforce status` has proven the pattern since FR061.
 * A reader that took ownership could create duplicate execution, which is the
 * one thing an observer must never do.
 *
 * ## The honest gap
 *
 * Prose with no backing event — most visibly the candidate diff preview, which
 * `run-direct.ts` renders straight to the stream from the patch file — is not
 * in the database and therefore does not appear here. The run's own terminal
 * has it, and so does the patch artifact. The footer says so rather than
 * letting the absence read as "nothing happened".
 */
import path from 'node:path';
import { openStateStore, StateNotFoundError, type StateStore } from '../../storage/db.js';
import { listEvents, type EventRecord } from '../../storage/events.js';
import { SchemaTooNewError } from '../../storage/migrations.js';
import { createStatePaths, resolveStateRoot } from '../../storage/paths.js';
import { findRun, listTasks } from '../../storage/records.js';
import { renderPersistedRuntimeEvent } from '../../telemetry/render.js';
import { redactText, redactedJson } from '../../telemetry/redaction.js';
import { colorEnabled, dim, stripControl, unicodeEnabled } from '../ansi.js';
import { CliError, EXIT_CODES, type CommandResult, type Reporter, type Streams } from '../output.js';
import { renderFrame, type FrameStyle } from '../live/frame.js';
import { computeLayout, MIN_COLUMNS, MIN_ROWS } from '../live/layout.js';
import { createPainter, type PaintTarget } from '../live/paint.js';
import { readKeys, type KeyInput } from '../live/keys.js';
import { initialState, reduce, RUN_LANE, type LiveEvent, type LiveState } from '../live/state.js';
import type { LiveTerminal } from '../live/view.js';

/** Poll interval while rows keep arriving. */
export const POLL_MS = 150;
/** Poll interval once the run has gone quiet. */
export const IDLE_POLL_MS = 500;
/** Idle polls before backing off. Reset by any new row. */
export const IDLE_POLLS_BEFORE_BACKOFF = 20;
/** Rows per query. Always cursored on `sequence`, never a full scan. */
export const PAGE_SIZE = 500;

export interface WatchCommandArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly stateDir?: string;
  /** Plan key, or a task id. Suppresses the board: one lane, full height. */
  readonly task?: string;
  readonly json: boolean;
}

export interface WatchCommandDeps {
  readonly reporter: Reporter;
  readonly streams: Streams;
  readonly stdin?: KeyInput;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so a test can drive the poll loop without waiting on a clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stop after this many polls with no new rows and a finished run. Tests use 0 for a single pass. */
  readonly maxIdlePolls?: number;
}

function requireRunId(args: WatchCommandArgs): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', 'watch requires a <run-id> argument');
  if (args.positionals.length > 1) {
    throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  }
  return runId;
}

/**
 * One database row as a reducer event.
 *
 * The same reducer and the same frame builder as the run's own view, fed from
 * a different source. Human lines for `runtime.*` rows are re-derived through
 * the shared `renderRuntimeEvent`, so a line here is the line the run's
 * terminal printed rather than a second, drifting rendering of the same fact.
 */
export function rowToLiveEvent(row: EventRecord, labels: ReadonlyMap<string, string>, shorten: (value: string) => string): LiveEvent {
  const laneId = row.taskId ?? RUN_LANE;
  const at = Date.parse(row.timestamp);
  const key = labels.get(laneId);
  const line = renderPersistedRuntimeEvent(row.type, row.payload, shorten);
  return {
    at: Number.isNaN(at) ? 0 : at,
    laneId,
    identity: {
      ...(row.runId !== '' ? { runId: row.runId } : {}),
      ...(row.taskId !== null ? { taskId: row.taskId } : {}),
      ...(key !== undefined ? { key } : {}),
    },
    type: row.type,
    payload: row.payload,
    // Every line this reader can produce is a re-rendered `runtime.*` row, so
    // every one of them quotes the runtime. `watch` is the surface where that
    // matters most: it replays a finished run into a fresh terminal on demand,
    // so an unclassified, unstripped line here would be a permanent one.
    ...(line !== null ? { line: stripControl(redactText(line)), origin: 'runtime' as const } : {}),
    ...(row.type === 'task.registered' ? { lifecycle: 'open' as const } : {}),
  };
}

/** Plan key per task id, from the `task.registered` rows, falling back to the owning agent and then a short id. */
function taskLabels(store: StateStore, runId: string, rows: ReadonlyArray<EventRecord>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const task of listTasks(store.db, runId)) labels.set(task.id, task.owner_agent_id ?? task.id.slice(0, 8));
  for (const row of rows) {
    if (row.type !== 'task.registered' || row.taskId === null) continue;
    const key = row.payload['key'];
    if (typeof key === 'string') labels.set(row.taskId, key);
  }
  return labels;
}

export async function commandWatch(args: WatchCommandArgs, deps: WatchCommandDeps): Promise<CommandResult> {
  const runId = requireRunId(args);
  const paths = createStatePaths(resolveStateRoot(args.stateDir));
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let store: StateStore;
  try {
    // read-only: no lock, no migration, no writes of any kind. Safe against a
    // run that is holding the state root right now.
    store = openStateStore(paths, { mode: 'read-only' });
  } catch (error) {
    if (error instanceof StateNotFoundError || error instanceof SchemaTooNewError) {
      throw new CliError(EXIT_CODES.invalidInput, 'state_unavailable', error.message);
    }
    throw error;
  }

  try {
    const run = findRun(store.db, runId);
    if (run === null) throw new CliError(EXIT_CODES.invalidInput, 'unknown_run', `run ${runId} not found under ${paths.root}`);

    const terminal = deps.streams.stderr as unknown as LiveTerminal;
    const interactive = !args.json && (terminal as { isTTY?: boolean }).isTTY === true && (terminal.columns ?? 0) >= MIN_COLUMNS && (terminal.rows ?? 0) >= MIN_ROWS;
    const color = colorEnabled(terminal, env);
    const painter = createPainter(terminal as unknown as PaintTarget);
    let state: LiveState = initialState(now());
    let cursor = 0;
    let idlePolls = 0;
    let detached = false;
    // Paths are shortened against the workspace each task was given, exactly
    // as the run's own terminal shortens them — the `workspace.created` row
    // carries it, so `watch` prints `docs/note.md` rather than eighty
    // characters of temp directory.
    const workspaces = new Map<string, string>();
    const shorten = (value: string): string => {
      for (const root of workspaces.values()) {
        if (value === root) return '.';
        if (value.startsWith(`${root}${path.sep}`)) return value.slice(root.length + 1);
      }
      return value;
    };
    const maxIdlePolls = deps.maxIdlePolls;

    const keys = interactive
      ? readKeys(
          deps.stdin,
          (key) => {
            if (key.kind === 'char' && (key.value === 'q' || key.value === 'Q')) detached = true;
          },
          // Ctrl+C in a read-only reader means "stop reading". There is no run
          // to interrupt from here, so it detaches rather than signalling.
          { onInterrupt: () => (detached = true) },
        )
      : null;

    if (interactive) painter.enter();

    let focus = RUN_LANE;
    const style = (): FrameStyle => ({
      color,
      unicode: unicodeEnabled(env),
      focus,
      frozen: false,
      scroll: 0,
      interleaved: args.task === undefined && focus === RUN_LANE,
      detail: false,
      overlay: false,
      toast: `workforce watch · read-only · events only (the run's own terminal also shows diffs and prose) · q detach`,
      now: now(),
      tick: 0,
    });

    try {
      for (;;) {
        const rows = listEvents(store.db, runId, { afterSequence: cursor, limit: PAGE_SIZE });
        if (rows.length > 0) {
          cursor = rows[rows.length - 1]!.sequence;
          idlePolls = 0;
          const labels = taskLabels(store, runId, rows);
          for (const row of rows) {
            if (row.type === 'workspace.created' && row.taskId !== null && typeof row.payload['path'] === 'string') {
              workspaces.set(row.taskId, row.payload['path']);
            }
            if (args.json) {
              deps.streams.stdout.write(`${redactedJson({ sequence: row.sequence, type: row.type, taskId: row.taskId, timestamp: row.timestamp, payload: row.payload })}\n`);
              continue;
            }
            state = reduce(state, rowToLiveEvent(row, labels, shorten));
          }
          // `--task` pins the pane to that lane; without it the pane
          // interleaves every lane and the board carries the identities.
          if (args.task !== undefined) {
            const lane = state.lanes.find((entry) => entry.label === args.task || entry.id === args.task);
            if (lane !== undefined) focus = lane.id;
          }
        } else {
          idlePolls += 1;
        }

        if (!args.json) {
          if (interactive) {
            const laneCount = args.task === undefined ? state.lanes.length : 0;
            painter.paint(renderFrame(state, computeLayout(terminal.columns ?? 80, terminal.rows ?? 24, laneCount), style()));
          } else if (rows.length > 0) {
            // Not a terminal, or too small for a board: plain lines, in order,
            // exactly what a pipe or a CI log can use.
            for (const row of rows) {
              const laneId = row.taskId ?? RUN_LANE;
              if (args.task !== undefined && !matchesTask(state, laneId, args.task)) continue;
              const line = renderPersistedRuntimeEvent(row.type, row.payload, shorten);
              if (line !== null) deps.reporter.info(line);
            }
          }
        }

        const finished = refreshedFinished(store, runId);
        if (detached || deps.signal?.aborted === true) break;
        if (maxIdlePolls !== undefined && idlePolls > maxIdlePolls) break;
        if (finished && rows.length === 0 && idlePolls >= 1) break;
        await sleep(idlePolls >= IDLE_POLLS_BEFORE_BACKOFF ? IDLE_POLL_MS : POLL_MS);
      }
    } finally {
      keys?.stop();
      painter.leave();
    }

    const lanes = state.lanes.map((lane) => ({ key: lane.label, taskId: lane.id, status: lane.status, tools: lane.tools, files: lane.files, outside: lane.outside }));
    return {
      command: 'watch',
      exitCode: EXIT_CODES.verifiedCandidate,
      data: { runId, runState: run.state, detached, lastSequence: cursor, tasks: lanes },
      lines: [
        `watched run ${runId} (${run.state})`,
        ...lanes.map((lane) => `  ${lane.key}: ${lane.status} — ${lane.tools} tool(s), ${lane.files} file(s)${lane.outside > 0 ? `, ${lane.outside} outside the granted paths` : ''}`),
        dim("read-only; events only — the run's own terminal also shows diffs and prose", color),
      ],
    };
  } finally {
    store.close();
  }
}

function matchesTask(state: LiveState, laneId: string, task: string): boolean {
  const lane = state.lanes.find((entry) => entry.id === laneId);
  return lane !== undefined && (lane.label === task || lane.id === task);
}

/**
 * Whether the run has reached a state nothing more will be appended to.
 *
 * Re-read every poll rather than captured at attach time: a run that was
 * `running` when this reader started is exactly the interesting case, and a
 * watcher that never noticed it finished would poll for ever.
 */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(['ready_for_review', 'failed', 'interrupted', 'cancelled']);

function refreshedFinished(store: StateStore, runId: string): boolean {
  const run = findRun(store.db, runId);
  return run !== null && TERMINAL_RUN_STATES.has(run.state);
}
