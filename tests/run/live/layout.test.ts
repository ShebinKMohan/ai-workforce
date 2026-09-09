/**
 * The layout is arithmetic, and these are the properties that arithmetic has
 * to have for the screen to be usable.
 *
 * The one that matters most: whatever the terminal size, the rows add up
 * exactly. A layout that over-allocates by one row scrolls the alternate
 * screen, which breaks absolute cursor addressing for every subsequent frame —
 * the board would appear to slide upward for the rest of the run.
 */
import { describe, expect, it } from 'vitest';
import { boardColumns, computeLayout, MIN_COLUMNS, MIN_FOCUS_ROWS, MIN_ROWS } from '../../../src/cli/live/layout.js';

describe('live layout', () => {
  it('always allocates exactly the rows the terminal has', () => {
    for (const rows of [12, 14, 16, 20, 24, 30, 44, 80]) {
      for (const lanes of [0, 1, 2, 3, 5, 9, 40]) {
        const layout = computeLayout(100, rows, lanes);
        const total = layout.headerRows + layout.boardRows + layout.focusTitleRow + layout.focusRows + layout.footerRows;
        expect(`${rows}x${lanes}: ${total}`).toBe(`${rows}x${lanes}: ${rows}`);
      }
    }
  });

  it('never squeezes the focus pane below the minimum, taking the chips strip instead', () => {
    // Twelve lanes cannot each own a row in a twenty-row terminal without
    // eating the pane, so the board compacts rather than leaving a two-line
    // window on what the focused agent is saying.
    const layout = computeLayout(100, 20, 12);
    expect(layout.compact).toBe(true);
    expect(layout.boardRows).toBe(1);
    expect(layout.focusRows).toBeGreaterThanOrEqual(MIN_FOCUS_ROWS);
  });

  it('gives every lane a row when they fit', () => {
    const layout = computeLayout(100, 30, 5);
    expect(layout.compact).toBe(false);
    expect(layout.boardRows).toBe(5);
    expect(layout.focusRows).toBeGreaterThanOrEqual(MIN_FOCUS_ROWS);
  });

  it('marks a terminal too small to draw in, rather than drawing something unreadable', () => {
    expect(computeLayout(MIN_COLUMNS - 1, 30, 3).usable).toBe(false);
    expect(computeLayout(100, MIN_ROWS - 1, 3).usable).toBe(false);
    expect(computeLayout(MIN_COLUMNS, MIN_ROWS, 3).usable).toBe(true);
  });

  it('drops board columns in a fixed order as the terminal narrows, and never starves "now"', () => {
    const wide = boardColumns(120);
    const medium = boardColumns(88);
    const narrow = boardColumns(64);
    // The runtime goes first: the board still names the agent either way.
    expect(wide.runtime).toBeGreaterThan(0);
    expect(medium.runtime).toBe(0);
    // Then the counters.
    expect(medium.counters).toBeGreaterThan(0);
    expect(narrow.counters).toBe(0);
    // And the task name narrows last.
    expect(narrow.task).toBeLessThan(wide.task);
    // "what it is doing right now" always survives, because it is the single
    // most useful thing a row can say.
    for (const columns of [60, 64, 72, 80, 88, 100, 140]) {
      expect(boardColumns(columns).now).toBeGreaterThanOrEqual(8);
    }
  });
});
