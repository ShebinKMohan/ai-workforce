/**
 * Where the rows go. One algorithm, no modes.
 *
 * A pane-per-agent layout needs two layouts, two test matrices, and degrades
 * to board+focus at five tasks in twenty-four rows anyway — which is most runs
 * in an IDE's bottom panel. So there is one layout, always: a board of
 * one row per dispatched task, and one focus pane under it.
 *
 * Pure: numbers in, numbers out. Nothing here writes, measures a string, or
 * knows a colour.
 */

/** Below this the alt-screen view degrades to the plain renderer rather than drawing something unreadable. */
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 12;

/** The focus pane is never worth less than this; below it the board takes the compact strip instead. */
export const MIN_FOCUS_ROWS = 4;

/** At or above this width the board shows every column. */
export const WIDE_COLUMNS = 96;

export interface Layout {
  readonly columns: number;
  readonly rows: number;
  readonly headerRows: number;
  /** Board rows actually drawn. Equal to the lane count, or 1 for the compact chips strip. */
  readonly boardRows: number;
  /** True when `boardRows` is the chips strip rather than one row per lane. */
  readonly compact: boolean;
  readonly focusTitleRow: number;
  readonly focusRows: number;
  readonly footerRows: number;
  /** Whether this terminal is big enough to draw at all. */
  readonly usable: boolean;
}

export function computeLayout(columns: number, rows: number, laneCount: number): Layout {
  const usable = columns >= MIN_COLUMNS && rows >= MIN_ROWS;
  // A rule under the header, and the checks strip in the footer, are the first
  // things to go: they are chrome, and the board is not.
  const headerRows = rows >= 20 ? 2 : 1;
  const footerRows = rows >= 20 ? 3 : rows >= 16 ? 2 : 1;
  const focusTitleRow = 1;
  const available = rows - headerRows - footerRows - focusTitleRow - MIN_FOCUS_ROWS;
  const compact = laneCount > available;
  const boardRows = laneCount === 0 ? 0 : compact ? 1 : laneCount;
  const focusRows = Math.max(0, rows - headerRows - boardRows - focusTitleRow - footerRows);
  return { columns, rows, headerRows, boardRows, compact, focusTitleRow, focusRows, footerRows, usable };
}

/** The width of each board column, for this terminal width. */
export interface BoardColumns {
  readonly status: number;
  readonly index: number;
  readonly task: number;
  /** 0 when the runtime column has been dropped. */
  readonly runtime: number;
  readonly state: number;
  readonly elapsed: number;
  /** `now` absorbs the remainder and is truncated, never wrapped. */
  readonly now: number;
  /** 0 when the counters have been dropped. */
  readonly counters: number;
}

/**
 * Columns drop in a fixed order as the terminal narrows: the runtime first
 * (the board still names the agent), then the counters, then the task name
 * narrows. `now` always takes what is left, because the single most useful
 * thing a row can say is what that agent is doing right now.
 */
export function boardColumns(columns: number): BoardColumns {
  const status = 2;
  const index = 1;
  const state = 9;
  const elapsed = 5;
  const wide = columns >= WIDE_COLUMNS;
  const medium = columns >= 80;
  const task = wide ? 9 : medium ? 8 : 7;
  const runtime = wide ? 11 : 0;
  const counters = columns >= 74 ? 8 : 0;
  // Leading space, then one space between every pair of columns.
  const fixed = 1 + status + 1 + index + 1 + task + 1 + (runtime > 0 ? runtime + 1 : 0) + state + 1 + elapsed + 2 + (counters > 0 ? counters + 1 : 0);
  const now = Math.max(8, columns - fixed);
  return { status, index, task, runtime, state, elapsed, now, counters };
}
