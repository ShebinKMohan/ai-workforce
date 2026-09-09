/**
 * Colour is a courtesy and never a requirement.
 *
 * The rule this holds: a pipe, a redirect, a CI log, `NO_COLOR` and
 * `TERM=dumb` all get exactly the bytes they got before there was any colour
 * at all. Nothing the coordinator says means something different in colour, so
 * degrading is always correct and never an error.
 */
import { describe, expect, it } from 'vitest';
import { colorEnabled, colorForLabel, dim, displayWidth, fit, fitRight, paint, sanitizeRow, stripAnsi, stripControl, truncateTo, TASK_COLORS } from '../../src/cli/ansi.js';

const ESC = '\u001B';
const tty = { isTTY: true };
const pipe = { isTTY: false };

describe('terminal colour', () => {
  it('is off for anything that is not a terminal', () => {
    expect(colorEnabled(pipe, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
    expect(colorEnabled(undefined, {})).toBe(false);
    expect(colorEnabled(tty, {})).toBe(true);
  });

  it('honours NO_COLOR and TERM=dumb even on a terminal', () => {
    expect(colorEnabled(tty, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled(tty, { NO_COLOR: 'anything' })).toBe(false);
    expect(colorEnabled(tty, { TERM: 'dumb' })).toBe(false);
    // An empty NO_COLOR is not a request to disable colour.
    expect(colorEnabled(tty, { NO_COLOR: '' })).toBe(true);
    // NO_COLOR beats an explicit FORCE_COLOR: the user's opt-out wins.
    expect(colorEnabled(tty, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
  });

  it('lets FORCE_COLOR turn colour on without a terminal, but FORCE_COLOR=0 does not', () => {
    expect(colorEnabled(pipe, { FORCE_COLOR: '1' })).toBe(true);
    expect(colorEnabled(pipe, { FORCE_COLOR: '0' })).toBe(false);
    expect(colorEnabled(pipe, { FORCE_COLOR: '' })).toBe(false);
  });

  it('returns the text untouched when colour is off, and wraps it when on', () => {
    expect(paint('alpha', 'cyan', false)).toBe('alpha');
    expect(dim('[', false)).toBe('[');
    const painted = paint('alpha', 'cyan', true);
    expect(painted).toContain(ESC);
    expect(painted.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).toBe('alpha');
    expect(dim('[', true).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).toBe('[');
  });

  it('gives a label the same colour every time, so a task does not change colour mid-run', () => {
    expect(colorForLabel('engineer-codex')).toBe(colorForLabel('engineer-codex'));
    for (const label of ['t1', 't2', 'alpha', 'engineer-codex', '']) {
      expect(TASK_COLORS).toContain(colorForLabel(label));
    }
    // Different labels should not all collapse onto one colour.
    const used = new Set(['t1', 't2', 't3', 't4', 't5', 't6'].map(colorForLabel));
    expect(used.size).toBeGreaterThan(1);
  });
});

/**
 * The half of ANSI that is not colour.
 *
 * A colour-only strip is the dangerous kind of nearly-right: it handles
 * everything this program emits and nothing an agent quotes. These are the
 * exact sequences that reached a real terminal through runtime output.
 */
describe('escape and control stripping', () => {
  const BEL = '\u0007';

  it('recognises the escape sequences a colour-only pattern misses', () => {
    expect(stripAnsi(`${ESC}[?1049lboard`)).toBe('board');
    expect(stripAnsi(`${ESC}[2Jcleared`)).toBe('cleared');
    expect(stripAnsi(`${ESC}creset`)).toBe('reset');
    expect(stripAnsi(`${ESC}]0;pwned${BEL}hello`)).toBe('hello');
    expect(stripAnsi(`${ESC}(Bcharset`)).toBe('charset');
    // Width followed: an OSC used to count as fifteen columns of nothing.
    expect(displayWidth(`${ESC}]0;pwned${BEL}hello`)).toBe(5);
  });

  it('drops the control characters no escape pattern would catch', () => {
    expect(stripControl(`a${BEL}b`)).toBe('ab');
    expect(stripControl('a\u0000b\u007Fc\u009Bd')).toBe('abcd');
    // Whitespace-shaped controls become a space: a tab must not shorten a row
    // and a newline must not open a second one.
    expect(stripControl('one\ttwo\rthree\nfour')).toBe('one two three four');
  });

  it('keeps this program own colour on a composed row, and nothing else', () => {
    const row = `${paint('ok', 'green', true)} ${ESC}[?1049l${ESC}[2J done`;
    const safe = sanitizeRow(row);
    expect(safe).toContain(`${ESC}[92m`);
    expect(safe).not.toContain(`${ESC}[?1049l`);
    expect(safe).not.toContain(`${ESC}[2J`);
    expect(stripAnsi(safe)).toBe('ok  done');
  });
});

/**
 * Width in cells, because that is what the terminal charges for.
 *
 * Counting code points painted a row of Japanese at nearly twice the
 * terminal's width; it wrapped onto the row below, and the painter's row diff
 * never repaired the row it had not itself written.
 */
describe('display width', () => {
  it('counts a wide character as the two cells it occupies', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('ｆｕｌｌ')).toBe(8);
    // A combining mark rides on the previous cell rather than taking one.
    expect(displayWidth('e\u0301')).toBe(1);
    // The board's own non-ASCII glyphs are East-Asian Ambiguous and stay
    // narrow, so no existing frame changes width.
    expect(displayWidth('·…─±✓✗')).toBe(6);
  });

  it('never lets a truncated or padded string exceed its column budget', () => {
    for (const text of ['日本語のテキストです。', '🚀🚀🚀🚀', 'あ tail marker ZZZ', 'plain ascii text', '']) {
      for (const width of [1, 2, 3, 7, 12, 20]) {
        expect(displayWidth(truncateTo(text, width))).toBeLessThanOrEqual(width);
        expect(displayWidth(fit(text, width))).toBe(width);
        expect(displayWidth(fitRight(text, width))).toBe(width);
      }
    }
  });

  it('drops a wide character whole rather than cutting it in half', () => {
    // Two cells do not fit in the one column left over, so the cut lands
    // before it and the row comes out a cell short. That is the only harmless
    // way to be wrong about a boundary.
    expect(truncateTo('あいうえお', 4)).toBe('あ~');
    expect(displayWidth(truncateTo('あいうえお', 4))).toBe(3);
  });
});
