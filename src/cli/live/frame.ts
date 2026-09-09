/**
 * One frame, as strings. Pure: state in, exactly `layout.rows` lines out.
 *
 * ## The invariant, and it is the test
 *
 * Strip every escape sequence and the screen says exactly the same thing.
 * Every semantic carried by colour is also a word (`PASS`/`FAIL`/`COMP`/
 * `NONE`) or a distinct-shaped ASCII mark (`ok`, `>>`, `xx`, `..`, `!!`), so
 * `NO_COLOR=1` yields a complete monochrome board rather than a degraded one.
 *
 * ## Why the board is ASCII and the pane is not quite
 *
 * The board's columns align. The obvious status glyphs are East-Asian-Width
 * *Ambiguous* and render double-width in a CJK locale, which would shear every
 * column to the right of them. So the board is ASCII, always. The focus pane's
 * one-character prefix may upgrade under a UTF-8 locale because nothing aligns
 * after it.
 *
 * ## Colour discipline
 *
 * Identity colour paints the label token and the leading gutter, never body
 * text. Green means a verifier-executed fact and nothing else — `turn
 * completed` renders in plain foreground, because only the verifier may turn
 * something green. Bold appears exactly twice: the run id, and the final
 * verdict.
 */
import { bold, dim, displayWidth, fit, fitRight, paint, paintIdentity, sanitizeRow, stripAnsi, truncateTo } from '../ansi.js';
import { statusLabel } from '../output.js';
import { boardColumns, type Layout } from './layout.js';
import { IDLE_AFTER_MS, RUN_LANE, type Lane, type LaneStatus, type LineOrigin, type LiveState } from './state.js';

export interface FrameStyle {
  readonly color: boolean;
  readonly unicode: boolean;
  /** Lane id the focus pane is showing. `RUN_LANE` is the run's own lane. */
  readonly focus: string;
  /** True when the pane is pinned rather than tailing. */
  readonly frozen: boolean;
  /** Lines back from the newest, when frozen. */
  readonly scroll: number;
  /** `a`: the pane interleaves every lane with its `[key]` label. */
  readonly interleaved: boolean;
  /** `d`: include the events `renderRuntimeEvent` returns null for. Reserved; the reducer keeps them out of the ring. */
  readonly detail: boolean;
  /** `?`: the key legend plus the ready-to-paste watch lines. */
  readonly overlay: boolean;
  /** A transient footer message, e.g. the `q` toast. */
  readonly toast: string | null;
  readonly now: number;
  /** Header spinner phase; driven by the run clock, so it only claims the process is alive. */
  readonly tick: number;
}

const SPINNER = ['|', '/', '-', '\\'] as const;

/** ASCII marks. Distinct in shape, so the board reads correctly with colour off. */
const MARKS: Readonly<Record<LaneStatus, string>> = {
  queued: '..',
  workspace: '..',
  starting: '..',
  working: '>>',
  verifying: '>>',
  verified: 'ok',
  failed: 'xx',
  interrupted: '!!',
  ended: '--',
  run: '::',
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function rule(width: number, title: string, style: FrameStyle, trailing = ''): string {
  const glyph = style.unicode ? '─' : '-';
  // An untitled rule is a plain line. `--- ` followed by nothing but more
  // dashes reads as a title that failed to render.
  const head = title.length === 0 ? glyph.repeat(3) : `${glyph.repeat(3)} ${title} `;
  const tailText = trailing.length > 0 ? ` ${trailing} ` : '';
  const fillWidth = Math.max(0, width - [...head].length - [...tailText].length);
  const line = truncateTo(`${head}${glyph.repeat(fillWidth)}${tailText}`, width);
  return dim(line, style.color);
}

/** Green is reserved for a verifier-executed fact. Everything else that could look like success does not get it. */
function markCell(lane: Lane, style: FrameStyle): string {
  const mark = MARKS[lane.status];
  if (lane.status === 'verified') return paint(mark, 'green', style.color);
  if (lane.status === 'failed') return paint(mark, 'red', style.color);
  if (lane.status === 'interrupted') return paint(mark, 'yellow', style.color);
  return dim(mark, style.color);
}

/**
 * How long this lane has been going.
 *
 * A finished lane's clock stops at the moment it finished; a live one runs to
 * now. A row that keeps counting after its task ended is a row that lies about
 * how long the task took.
 */
export function laneElapsed(lane: Lane, now: number): number {
  const terminal = lane.status === 'verified' || lane.status === 'failed' || lane.status === 'interrupted' || lane.status === 'ended';
  return Math.max(0, (terminal ? lane.lastAt : now) - lane.openedAt);
}

function laneNow(lane: Lane, at: number): string {
  if (lane.status === 'queued' && lane.waitingOn.length > 0) return `waiting on: ${lane.waitingOn.join(', ')}`;
  if (lane.status === 'queued' && lane.blockedReason !== null) return `waiting for a ${lane.blockedReason.replace('_', ' ')}`;
  const text = lane.now.trim();
  const idle = at - lane.lastAt;
  const terminal = lane.status === 'verified' || lane.status === 'failed' || lane.status === 'interrupted' || lane.status === 'ended';
  // A spinner that spins while nothing happens is a lie. The stall signal is
  // the fact: how long this lane has produced nothing.
  if (!terminal && idle > IDLE_AFTER_MS) return `${text} · idle ${formatElapsed(idle)}`;
  return text;
}

function boardRow(lane: Lane, layout: Layout, style: FrameStyle): string {
  const columns = boardColumns(layout.columns);
  const parts: string[] = [];
  parts.push(' ');
  parts.push(markCell(lane, style));
  parts.push(' ');
  parts.push(paintIdentity(String(lane.index).slice(0, 1), lane.label, style.color));
  parts.push(' ');
  parts.push(paintIdentity(fit(lane.label, columns.task), lane.label, style.color));
  parts.push(' ');
  if (columns.runtime > 0) {
    parts.push(dim(fit(lane.adapter ?? lane.runtimeId ?? '', columns.runtime), style.color));
    parts.push(' ');
  }
  parts.push(fit(lane.status, columns.state));
  parts.push(' ');
  parts.push(dim(fitRight(formatElapsed(laneElapsed(lane, style.now)), columns.elapsed), style.color));
  parts.push('  ');
  parts.push(fit(laneNow(lane, style.now), columns.now));
  if (columns.counters > 0) {
    parts.push(' ');
    parts.push(dim(fitRight(`${lane.tools}t ${lane.files}f`, columns.counters), style.color));
  }
  return parts.join('');
}

/** The compact strip: every lane accounted for, even the ones that do not fit as rows. */
function chipsRow(state: LiveState, layout: Layout, style: FrameStyle): string {
  const chips: string[] = [];
  let width = 1;
  let shown = 0;
  for (const lane of state.lanes) {
    const text = `${lane.index} ${lane.label} ${MARKS[lane.status]}`;
    if (width + text.length + 2 > layout.columns - 12) break;
    chips.push(`${paintIdentity(`${lane.index} ${lane.label}`, lane.label, style.color)} ${lane.status === 'verified' ? paint(MARKS[lane.status], 'green', style.color) : lane.status === 'failed' ? paint(MARKS[lane.status], 'red', style.color) : dim(MARKS[lane.status], style.color)}`);
    width += text.length + 2;
    shown += 1;
  }
  const rest = state.lanes.length - shown;
  return ` ${chips.join('  ')}${rest > 0 ? dim(`  (+${rest} more)`, style.color) : ''}`;
}

/**
 * The one-character prefix in the focus pane. Nothing aligns after it, so it
 * may upgrade under UTF-8.
 *
 * Provenance decides first, prose second. A `runtime` line carries words the
 * model chose, so it is never classified at all: the pane used to run its
 * regexes over that text, which meant a model writing "the acceptance suite:
 * passed" was rendered byte-for-byte identically to a verifier receipt saying
 * the same thing — the exact confusion between a claim and evidence this
 * program exists to prevent. Green then narrows further: only the `verifier`
 * origin can reach it, because only a check this coordinator executed against
 * a frozen candidate is a fact about the work.
 */
function focusPrefix(text: string, origin: LineOrigin, style: FrameStyle): { prefix: string; body: string } {
  const body = text.startsWith('  ') ? text.slice(2) : text;
  const glyph = (ascii: string, unicode: string): string => (style.unicode ? unicode : ascii);
  if (origin === 'runtime') return { prefix: ' ', body };
  if (/^(changed |write to )/.test(body)) return { prefix: glyph('+', '±'), body };
  if (/OUTSIDE the granted paths|not confirmed by the runtime|^WARNING|refused/.test(body)) return { prefix: glyph('!', '!'), body };
  if (/^(runtime error|change denied|exec denied)|: failed|exit [1-9]/.test(body)) return { prefix: glyph('x', '✗'), body };
  if (origin === 'verifier' && /: passed\b/.test(body)) return { prefix: glyph('v', '✓'), body };
  return { prefix: ' ', body };
}

function focusLine(text: string, origin: LineOrigin, laneLabel: string | null, layout: Layout, style: FrameStyle): string {
  const { prefix, body } = focusPrefix(text, origin, style);
  const marked = prefix === ' ' ? '   ' : ` ${prefix} `;
  const label = laneLabel === null ? '' : `${paintIdentity(`[${laneLabel}]`, laneLabel, style.color)} `;
  const budget = layout.columns - 3 - (laneLabel === null ? 0 : laneLabel.length + 3);
  const cut = truncateTo(body, Math.max(4, budget));
  const painted =
    prefix === 'x' || prefix === '✗'
      ? paint(cut, 'red', style.color)
      : prefix === '!'
        ? paint(cut, 'yellow', style.color)
        : prefix === 'v' || prefix === '✓'
          ? paint(cut, 'green', style.color)
          : cut;
  const head = prefix === 'x' || prefix === '✗' ? paint(marked, 'red', style.color) : prefix === '!' ? paint(marked, 'yellow', style.color) : prefix === 'v' || prefix === '✓' ? paint(marked, 'green', style.color) : marked;
  return `${head}${label}${painted}`;
}

function checksStrip(state: LiveState, layout: Layout, style: FrameStyle): string {
  if (state.checks.length === 0) return dim(' checks   none planned yet', style.color);
  // Several lanes run criteria of the same name, so a bare `unit PASS | unit
  // FAIL` would say nothing about which task passed. The lane qualifies it
  // whenever more than one lane has checks at all.
  const lanesWithChecks = new Set(state.checks.map((check) => check.laneId));
  const nameOf = (laneId: string): string => state.lanes.find((lane) => lane.id === laneId)?.label ?? 'run';
  const cells = state.checks.slice(0, 8).map((check) => {
    const name = lanesWithChecks.size > 1 ? `${nameOf(check.laneId)}:${check.criterionId}` : check.criterionId;
    if (check.outcome === null) return dim(`${name} --`, style.color);
    const label = statusLabel(check.outcome);
    const colour = check.outcome === 'passed' ? 'green' : check.outcome === 'failed' ? 'red' : 'yellow';
    const suffix = check.durationMs === null ? '' : ` ${(check.durationMs / 1000).toFixed(1)}s`;
    return `${paintIdentity(name, nameOf(check.laneId), style.color)} ${paint(label, colour, style.color)}${dim(suffix, style.color)}`;
  });
  return clamp(` ${dim('checks', style.color)}   ${cells.join(dim(' | ', style.color))}`, layout.columns);
}

function keysFooter(style: FrameStyle, layout: Layout): string {
  if (style.toast !== null) return dim(truncateTo(` ${style.toast}`, layout.columns), style.color);
  const full = ' 1-9 focus  0 run  f freeze  up/dn scroll  a all  d detail  ? keys  p plain  ^C interrupt';
  const short = ' 1-9 focus  f freeze  a all  ? keys  p plain  ^C interrupt';
  return dim(truncateTo(layout.columns >= 92 ? full : short, layout.columns), style.color);
}

function overlayLines(state: LiveState, layout: Layout, style: FrameStyle, rows: number): string[] {
  const out: string[] = [];
  out.push(rule(layout.columns, 'keys', style, 'any key closes'));
  const bindings = [
    '1-9   focus that lane          0     focus the run lane',
    'Tab   cycle focus              f     freeze / follow',
    'up/dn scroll the focus pane    End   back to following',
    'a     all lanes, interleaved   d     detail: requested vs observed',
    'p     leave this view, finish in plain text',
    '^C    interrupt the run (q does not quit)',
  ];
  for (const line of bindings) out.push(`   ${dim(line, style.color)}`);
  out.push('');
  out.push(`   ${dim('attach one agent in another terminal:', style.color)}`);
  for (const lane of state.lanes) {
    out.push(`   ${paintIdentity(`workforce watch ${state.runId ?? '<run-id>'} --task ${lane.label}`, lane.label, style.color)}`);
  }
  while (out.length < rows) out.push('');
  return out.slice(0, rows);
}

export function renderFrame(state: LiveState, layout: Layout, style: FrameStyle): string[] {
  const rows: string[] = [];

  // ---- header ----
  const spinner = SPINNER[style.tick % SPINNER.length]!;
  const elapsed = formatElapsed(style.now - state.startedAt);
  const runId = state.runId === null ? '' : state.runId.slice(0, 8);
  const settled = state.lanes.filter((lane) => lane.settled !== null).length;
  const okCount = state.lanes.filter((lane) => lane.status === 'verified').length;
  const failCount = state.lanes.filter((lane) => lane.status === 'failed').length;
  const tail = state.finished ? dim(`[${state.accepted === true ? 'ok' : 'end'}] ${elapsed}`, style.color) : dim(`[${spinner}] ${elapsed}`, style.color);

  // The clock and the counts are what a glance is for, so they are never the
  // thing that gets cut. The repository path is: it is context, it is long,
  // and it is on the run lane and in the replay either way.
  const required = [
    ' workforce',
    layout.columns >= 88 ? ` run ${bold(runId, style.color)}` : ` ${bold(runId, style.color)}`,
    `  ${state.plannedTaskCount > state.lanes.length ? `${state.lanes.length} of ${state.plannedTaskCount}` : state.lanes.length} tasks`,
    settled > 0 ? dim(`  ${okCount} ok  ${failCount} failed`, style.color) : '',
  ].join('');
  const context =
    state.repo === null ? '' : dim(`  ${shortenHome(state.repo)}${state.baseRevision === null ? '' : ` @ ${state.baseRevision.slice(0, 7)}`}`, style.color);
  const room = layout.columns - displayWidth(required) - displayWidth(tail) - 2;
  const head = context.length > 0 && displayWidth(context) <= room ? ` workforce${required.slice(' workforce'.length)}${context}` : required;
  rows.push(padTail(head, tail, layout.columns));
  if (layout.headerRows > 1) rows.push(rule(layout.columns, '', style));

  // ---- board ----
  if (layout.boardRows > 0) {
    if (layout.compact) {
      rows.push(chipsRow(state, layout, style));
    } else {
      for (const lane of state.lanes) rows.push(boardRow(lane, layout, style));
    }
  }

  // ---- focus pane ----
  const focusLane = style.focus === RUN_LANE ? state.run : (state.lanes.find((lane) => lane.id === style.focus) ?? state.run);
  const source: Array<{ text: string; origin: LineOrigin; label: string | null }> = style.interleaved
    ? state.transcript.map((entry) => ({
        text: entry.text,
        origin: entry.origin,
        label: entry.laneId === RUN_LANE ? null : (state.lanes.find((lane) => lane.id === entry.laneId)?.label ?? null),
      }))
    : focusLane.lines.map((entry) => ({ text: entry.text, origin: entry.origin, label: null }));
  const behind = style.frozen ? style.scroll : 0;
  const end = Math.max(0, source.length - behind);
  const visible = source.slice(Math.max(0, end - layout.focusRows), end);
  const title = style.interleaved
    ? 'all lanes'
    : `[${focusLane.index}] ${focusLane.label}${focusLane.adapter === null ? '' : `  ${focusLane.adapter}`}  ${focusLane.status} ${formatElapsed(laneElapsed(focusLane, style.now))}`;
  const paneTail = `${style.frozen ? `frozen ^${behind}` : 'follow'}  ${source.length} lines`;
  rows.push(rule(layout.columns, title, style, paneTail));
  if (style.overlay) {
    for (const line of overlayLines(state, layout, style, layout.focusRows)) rows.push(line);
  } else {
    for (const entry of visible) rows.push(focusLine(entry.text, entry.origin, entry.label, layout, style));
    for (let index = visible.length; index < layout.focusRows; index += 1) rows.push('');
  }

  // ---- footer ----
  // Exactly `layout.footerRows` rows, keys last. Pushing one more than the
  // layout allotted would silently drop the bottom row on the way out — and
  // the bottom row is the one that says how to leave.
  if (layout.footerRows >= 3) rows.push(runFooter(state, layout, style), checksStrip(state, layout, style));
  else if (layout.footerRows === 2) rows.push(runFooter(state, layout, style));
  rows.push(keysFooter(style, layout));

  // Exactly `rows` entries, always: the painter addresses rows absolutely and
  // a short frame would leave last frame's bytes on screen.
  while (rows.length < layout.rows) rows.push('');
  return rows.slice(0, layout.rows).map((line) => clamp(line, layout.columns));
}

function runFooter(state: LiveState, layout: Layout, style: FrameStyle): string {
  const waiting = state.lanes.filter((lane) => lane.status === 'queued').length;
  const parts = [
    ` ${dim('run', style.color)}      ${state.lanes.filter((lane) => lane.settled === true).length} of ${Math.max(state.lanes.length, state.plannedTaskCount)} verified`,
    waiting > 0 ? dim(`  waiting on ${waiting}`, style.color) : '',
    dim(`  turns ${state.activeTurns}  writers ${state.activeWriters}`, style.color),
    state.interrupted ? `  ${paint('interrupted', 'yellow', style.color)}` : '',
  ];
  return clamp(parts.join(''), layout.columns);
}

function padTail(head: string, tail: string, columns: number): string {
  const gap = Math.max(1, columns - displayWidth(head) - displayWidth(tail) - 1);
  return `${head}${' '.repeat(gap)}${tail}`;
}

/**
 * No row is ever wider than the terminal, and no row carries an escape this
 * program did not write.
 *
 * The sanitising pass is unconditional, and that is the whole point: the old
 * version only rebuilt a row that *overflowed*, so a short row kept every byte
 * it contained. `  message: ` plus `ESC[?1049l` is eleven columns wide, fits
 * any terminal, and left the alternate screen — after which every absolutely
 * addressed row this painter wrote landed on the user's scrollback instead.
 *
 * Width is measured in cells, so a row of CJK or emoji is cut where it
 * actually reaches the edge rather than where its code points run out. A row
 * that still overflows is rebuilt from its stripped text and cut there, so a
 * truncation can never land inside an escape sequence; losing colour on an
 * overflowing row is the cheap half of that trade.
 */
function clamp(line: string, columns: number): string {
  const safe = sanitizeRow(line);
  return displayWidth(safe) <= columns ? safe : truncateTo(stripAnsi(safe), columns);
}

function shortenHome(value: string): string {
  const home = process.env['HOME'];
  return home !== undefined && home.length > 0 && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}
