/**
 * Hand-rolled ANSI, because this package takes no runtime dependency but zod.
 *
 * Colour is a courtesy, never a requirement: when the destination is not a
 * terminal, when `NO_COLOR` is set, or when `TERM=dumb`, every helper here
 * returns the plain text unchanged. Nothing in the coordinator's output means
 * anything different in colour than it does without it, so a pipe, a `> file`
 * and a CI log all keep exactly the bytes they had before.
 *
 * ## Two axes that never touch
 *
 * There are exactly two reasons to colour something, and they draw from
 * disjoint palettes:
 *
 * - **identity** (*who is speaking*) — cyan, magenta, blue, each in a normal
 *   and a faint variant, giving six stable identities. Deterministic in the
 *   label, so a task keeps its colour across its board row, its pane title,
 *   the `[key]` in the transcript, and a re-run tomorrow.
 * - **status** (*how it went*) — green for a verifier-executed fact, red for a
 *   real failure, yellow for something true but unresolved.
 *
 * They used to be one palette of six, so a task could be assigned failure-red
 * for a whole run and its every line would read as broken. `IDENTITY_COLORS`
 * and `STATUS_COLORS` are now disjoint, and a test asserts the intersection is
 * empty.
 *
 * Identity colour paints only the label token and a one-character gutter —
 * never body text, never a whole row. Beyond six lanes the colours repeat, so
 * the lane number and the label are always printed too: colour is a fast
 * index, never the identifier.
 */

/** Foreground colours, bright variants — readable on both dark and light terminals. */
const FOREGROUND = {
  cyan: 96,
  magenta: 95,
  yellow: 93,
  green: 92,
  blue: 94,
  red: 91,
} as const;

export type AnsiColor = keyof typeof FOREGROUND;

/** Axis 1: who. Disjoint from `STATUS_COLORS` — see the module comment. */
export const IDENTITY_COLORS: ReadonlyArray<AnsiColor> = ['cyan', 'magenta', 'blue'];

/** Axis 2: how it went. Never used to identify anybody. */
export const STATUS_COLORS: ReadonlyArray<AnsiColor> = ['green', 'red', 'yellow'];

/** The palette task labels are drawn from. Kept under this name because callers and tests use it. */
export const TASK_COLORS: ReadonlyArray<AnsiColor> = IDENTITY_COLORS;

/** `ESC[`, spelled out so no literal control character ends up in this file. */
const CSI = '\u001B[';

/**
 * Whether to emit escape codes to `target`.
 *
 * `NO_COLOR` (any non-empty value) and `TERM=dumb` win over everything, per
 * the conventions both follow. `FORCE_COLOR` then turns colour on for a
 * non-TTY — it is how a test asks for the coloured rendering without a pty.
 * Otherwise colour follows `isTTY`.
 */
export function colorEnabled(target: unknown, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  if (env['TERM'] === 'dumb') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  return (target as { isTTY?: unknown } | null | undefined)?.isTTY === true;
}

export function paint(text: string, color: AnsiColor, enabled: boolean): string {
  if (!enabled || text.length === 0) return text;
  return `${CSI}${FOREGROUND[color]}m${text}${CSI}39m`;
}

export function dim(text: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text;
  return `${CSI}2m${text}${CSI}22m`;
}

/** Bold. Used exactly twice on screen: the run id in the header and the final verdict line. */
export function bold(text: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text;
  return `${CSI}1m${text}${CSI}22m`;
}

/** A colour and a faint bit: two identity axes over three hues, so six lanes never collide. */
export interface IdentityStyle {
  readonly color: AnsiColor;
  readonly faint: boolean;
}

function hashLabel(label: string): number {
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) % 0x7fffffff;
  }
  return hash;
}

/**
 * A stable style for a label.
 *
 * Deterministic in the label alone, so the same task keeps the same colour
 * across the whole run and across a re-run, and two agents never swap colours
 * because they happened to start in a different order. The hue comes from the
 * hash modulo the palette, the faint bit from a higher digit of the same hash,
 * which is why three hues carry six identities.
 */
export function identityStyle(label: string): IdentityStyle {
  const hash = hashLabel(label);
  return { color: IDENTITY_COLORS[hash % IDENTITY_COLORS.length]!, faint: Math.floor(hash / IDENTITY_COLORS.length) % 2 === 1 };
}

/** The hue half of `identityStyle`, for a caller that paints a bare token. */
export function colorForLabel(label: string): AnsiColor {
  return identityStyle(label).color;
}

/** A label painted in its own identity: hue plus the faint bit, and nothing else. */
export function paintIdentity(text: string, label: string, enabled: boolean): string {
  const style = identityStyle(label);
  const coloured = paint(text, style.color, enabled);
  return style.faint ? dim(coloured, enabled) : coloured;
}

// ---------------------------------------------------------------------------
// Screen control
//
// Absolute addressing and erase-line only: the most portable subset there is.
// No scroll regions, no save/restore cursor. The clear-screen sequence is
// emitted only on a full invalidate, never per frame.
// ---------------------------------------------------------------------------

/** Switch to the alternate screen buffer and hide the cursor. */
export const ENTER_ALT_SCREEN = `${CSI}?1049h${CSI}?25l`;
/** Show the cursor and return to the main buffer, restoring the user's scrollback. */
export const LEAVE_ALT_SCREEN = `${CSI}?25h${CSI}?1049l`;
export const CLEAR_SCREEN = `${CSI}2J`;
export const ERASE_LINE = `${CSI}2K`;

/** Move the cursor to a 1-indexed row, column 1. */
export function cursorTo(row: number): string {
  return `${CSI}${row};1H`;
}

/**
 * Every escape sequence, not only the coloured ones.
 *
 * The old pattern matched CSI alone (`ESC [ ... letter`), which is the half a
 * terminal uses for colour. The half it does not use for colour is the half
 * that does damage: `ESC [?1049l` leaves the alternate screen, `ESC c` resets
 * the terminal outright, and `ESC ] 0 ; title BEL` renames the window. Runtime
 * output quotes captured terminal bytes all the time, so those arrive here as
 * ordinary text and have to be recognised before anything measures or prints
 * them. The alternatives are ordered longest-form first: CSI and OSC both
 * begin with a byte the one-character escape branch would otherwise swallow.
 */
const ANSI_PATTERN = new RegExp(
  [
    '\\u001B\\[[0-?]*[ -/]*[@-~]', // CSI: colour, cursor addressing, private modes (?1049h/l)
    '\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|$)', // OSC: window title and friends, BEL- or ST-terminated
    '\\u001B[P^_X][\\s\\S]*?(?:\\u001B\\\\|\\u0007|$)', // DCS / PM / APC / SOS
    '\\u001B[ -/][@-~]', // two-byte: charset designation, e.g. ESC ( B
    '\\u001B[@-~]', // one-byte: RIS (ESC c), DECSC (ESC 7), ...
    '\\u001B', // a trailing, truncated escape
  ].join('|'),
  'g',
);

/** SGR: the only escape this program emits, and so the only one a painted row may keep. */
const SGR_PATTERN = /^\u001B\[[0-9;]*m$/;

/** Control characters that stand in for a space rather than for nothing. */
const CONTROL_AS_SPACE = /[\t\v\f\r\n\u0085\u2028\u2029]/g;
/** C0 and C1, minus the ones already turned into spaces. */
const CONTROL_REMOVED = /[\u0000-\u001F\u007F-\u009F]/g;

/** The text with every escape sequence removed. What the screen actually says. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Whitespace-shaped controls become a space; every other control character goes. */
function scrubControls(text: string): string {
  return text.replace(CONTROL_AS_SPACE, ' ').replace(CONTROL_REMOVED, '');
}

/**
 * Text this program did not compose, made safe to measure and to print.
 *
 * Every escape sequence and every control character goes, because the sender
 * is a coding runtime quoting whatever it read: a model pasting the output of
 * a coloured test runner, a diff hunk from a file with a stray carriage return
 * in it, a tool result carrying a window-title sequence. One such line used to
 * reach the terminal verbatim, and inside the live view the row-diff painter
 * then re-emitted it on every frame that touched that row, turning one stray
 * sequence into a stream of them for the rest of the run.
 *
 * A tab or an embedded newline becomes a space rather than nothing, so it
 * cannot silently shorten a row or open a second one.
 */
export function stripControl(text: string): string {
  return scrubControls(stripAnsi(text));
}

/**
 * A fully composed row, made safe to write to the screen.
 *
 * The difference from `stripControl` is that a row has already been coloured
 * by this program, so its own SGR sequences must survive intact — including
 * the ESC byte that starts them, which is why this walks the string rather
 * than scrubbing controls over the whole of it. Nothing else survives: an
 * escape that is not `ESC [ ... m` cannot be ours, so whatever it is it
 * arrived inside someone else's text, and it does not get to move the cursor.
 */
export function sanitizeRow(text: string): string {
  ANSI_PATTERN.lastIndex = 0;
  let out = '';
  let cut = 0;
  for (let match = ANSI_PATTERN.exec(text); match !== null; match = ANSI_PATTERN.exec(text)) {
    out += scrubControls(text.slice(cut, match.index));
    if (SGR_PATTERN.test(match[0])) out += match[0];
    cut = match.index + match[0].length;
  }
  return out + scrubControls(text.slice(cut));
}

// ---------------------------------------------------------------------------
// Display width
//
// Cells, not code points. The board's own glyphs are all narrow, but the text
// it *quotes* is whatever an agent wrote, and a Japanese sentence or an emoji
// takes two cells per code point. Counting those as one made every row
// carrying them wider than the terminal; the overflow wraps onto the row
// below, and the painter's row diff never repaints a row it did not itself
// change, so the damage lasted for the rest of the run.
//
// East-Asian *Ambiguous* stays one cell. That is the standard default and it
// is what the board already assumes for the few non-ASCII glyphs it draws
// itself, so no existing frame changes width here.
// ---------------------------------------------------------------------------

/** Combining marks, variation selectors and joiners: they attach to the previous cell. */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x0816, 0x082d],
  [0x0900, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x180b, 0x180e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

/** East-Asian Wide and Fullwidth, plus the emoji blocks terminals render double-width. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b16f],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f978],
  [0x1f97a, 0x1f9cb],
  [0x1f9cd, 0x1f9ff],
  [0x1fa70, 0x1fa74],
  [0x1fa78, 0x1fa7a],
  [0x1fa80, 0x1fa86],
  [0x1fa90, 0x1faa8],
  [0x1fab0, 0x1fab6],
  [0x1fac0, 0x1fac2],
  [0x1fad0, 0x1fad6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function inRanges(codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

/** Cells one code point occupies: 0 for a control or a combining mark, 2 for wide, 1 otherwise. */
export function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (inRanges(codePoint, ZERO_WIDTH)) return 0;
  return inRanges(codePoint, WIDE) ? 2 : 1;
}

/** Display width in terminal cells: what the row will actually occupy. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) width += charWidth(character.codePointAt(0)!);
  return width;
}

/**
 * Cut `text` to `max` display columns, marking the cut.
 *
 * Applied to the PLAIN string, before any colour is wrapped around it, so an
 * escape sequence is never cut in half. Cells rather than code points: cutting
 * a wide character in half by counting it as one column is how a row ends up
 * one cell over the edge and wraps. The mark is `~` rather than an ellipsis
 * because the board is ASCII-only and a one-column mark must stay one column
 * in every locale.
 */
export function truncateTo(text: string, max: number, mark = '~'): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const markWidth = displayWidth(mark);
  if (max <= markWidth) return mark.slice(0, max);
  const budget = max - markWidth;
  let width = 0;
  let kept = '';
  for (const character of text) {
    const next = width + charWidth(character.codePointAt(0)!);
    // A wide character that would straddle the edge is dropped whole: the row
    // comes out a cell short, which is the only harmless way to be wrong.
    if (next > budget) break;
    width = next;
    kept += character;
  }
  return `${kept}${mark}`;
}

/** Pad to exactly `width` columns, truncating when too long. Column alignment, not decoration. */
export function fit(text: string, width: number): string {
  const cut = truncateTo(text, width);
  return cut + ' '.repeat(Math.max(0, width - displayWidth(cut)));
}

/** Right-align to exactly `width` columns. */
export function fitRight(text: string, width: number): string {
  const cut = truncateTo(text, width);
  return ' '.repeat(Math.max(0, width - displayWidth(cut))) + cut;
}

/**
 * Whether this terminal can be trusted with characters outside ASCII.
 *
 * Only the focus pane's one-character status prefix upgrades; nothing aligns
 * after it. The board never does.
 */
export function unicodeEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /UTF-?8/i.test(locale);
}
