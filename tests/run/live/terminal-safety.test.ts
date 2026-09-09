/**
 * Nothing an agent says may reach the terminal as an instruction.
 *
 * Two failures live here, and both of them ended with a shell that needed
 * `reset`:
 *
 * 1. A line that FITS kept every byte it contained. `  message: ` plus
 *    `ESC[?1049l` is eleven columns wide, so the clamp never rebuilt it — the
 *    agent's own text left the alternate screen mid-run, and the row-diff
 *    painter then wrote several hundred absolutely addressed rows onto the
 *    user's real scrollback, plus a full terminal reset every time that row
 *    was touched again. `workforce watch` replayed the same bytes out of
 *    SQLite on demand, on any terminal.
 * 2. Width was counted in code points, so a row of Japanese or emoji was
 *    painted at up to twice the terminal's width. The overflow wrapped onto
 *    the row below, and the painter never repaints a row it did not itself
 *    change, so that row stayed corrupted for the rest of the run.
 *
 * Both are asserted here against the real frame builder and the real view,
 * with the byte sequences that reproduced them.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../../src/core/config.js';
import { runDirect } from '../../../src/core/run-direct.js';
import { openStateStore } from '../../../src/storage/db.js';
import { createStatePaths } from '../../../src/storage/paths.js';
import { Reporter } from '../../../src/cli/output.js';
import { createPlainRenderer } from '../../../src/cli/live/plain.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../../workspaces/support.js';
import { displayWidth } from '../../../src/cli/ansi.js';
import { renderFrame, type FrameStyle } from '../../../src/cli/live/frame.js';
import { computeLayout } from '../../../src/cli/live/layout.js';
import { createLiveView } from '../../../src/cli/live/view.js';
import { initialState, reduce, RUN_LANE, type LineOrigin, type LiveEvent } from '../../../src/cli/live/state.js';
import { fakeClock, fakeStreams, fakeTerminal, fakeTimers, identity } from './support.js';

afterEach(() => cleanupAll());

const ESC = '\u001B';
const BEL = '\u0007';
/** The only thing this program is allowed to emit inside a row. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function style(overrides: Partial<FrameStyle> = {}): FrameStyle {
  return {
    color: true,
    unicode: false,
    focus: 'task-api',
    frozen: false,
    scroll: 0,
    interleaved: false,
    detail: false,
    overlay: false,
    toast: null,
    now: 100_000,
    tick: 0,
    ...overrides,
  };
}

const open = (key: string): LiveEvent => ({ at: 1_000, laneId: `task-${key}`, identity: { taskId: `task-${key}`, key, adapter: 'codex' }, lifecycle: 'open' });
const line = (key: string, text: string, origin: LineOrigin = 'runtime'): LiveEvent => ({
  at: 1_000,
  laneId: `task-${key}`,
  identity: { taskId: `task-${key}`, key },
  line: text,
  origin,
});

/** What an agent emits when it quotes captured terminal output. All of it survived a colour-only strip. */
const HOSTILE = [
  `  message: ${ESC}[?1049l${ESC}[2J`,
  `  message: ${ESC}cRIS-just-happened`,
  `  message: ${ESC}]0;PWNED-TITLE${BEL}and-the-title-is-gone`,
  `  tool write_file src/pagination.js ${ESC}[?25l${ESC}[41m`,
  `  +const x = 1;${ESC}[8;5;196m`,
];

/** Escapes no rendered row may contain, whoever asked for them. */
const FORBIDDEN = [`${ESC}[?1049l`, `${ESC}[?1049h`, `${ESC}[2J`, `${ESC}c`, `${ESC}]0;`, BEL, `${ESC}[41m`, `${ESC}[?25l`];

/**
 * The subset that stays forbidden in the painter's own byte stream.
 *
 * The painter legitimately writes alt-screen entry, cursor hide and one clear;
 * what it must never write is a sequence that arrived in somebody's text.
 */
const AGENT_ONLY = [`${ESC}c`, `${ESC}]0;`, BEL, `${ESC}[41m`];

describe('an agent cannot drive the terminal through its own output', () => {
  it('keeps no escape but its own colour in a painted frame, including on rows that fit', () => {
    const state = [open('api'), ...HOSTILE.map((text) => line('api', text))].reduce(reduce, initialState(1_000));
    const frame = renderFrame(state, computeLayout(120, 30, 1), style()).join('\n');

    // The reproduction was exactly this: eleven columns wide, so the row was
    // returned verbatim and the board left the alternate screen.
    expect(displayWidth(HOSTILE[0]!)).toBeLessThan(120);
    expect(FORBIDDEN.filter((sequence) => frame.includes(sequence)).map((s) => JSON.stringify(s))).toEqual([]);
    // Stronger, and the property that actually matters: every escape byte left
    // in the frame belongs to a colour sequence this program wrote.
    expect(frame.replace(SGR, '')).not.toContain(ESC);
    // And the readable text is still there, minus the sequences. The window
    // title is not: `0;PWNED-TITLE` is the OSC's payload, so it leaves with it.
    expect(frame).not.toContain('PWNED-TITLE');
    expect(frame).toContain('RIS-just-happened');
    expect(frame).toContain('and-the-title-is-gone');
  });

  it('paints no row wider than the terminal, whatever alphabet the agent used', () => {
    const wide = [
      `  message: ${'日本語のテキストです。'.repeat(30)}`,
      `  message: ${'🚀'.repeat(80)}`,
      `  message: ${'あ'.repeat(40)} tail marker ZZZ`,
      `  message: ${'a'.repeat(400)}`,
    ];
    const state = [open('api'), ...wide.map((text) => line('api', text))].reduce(reduce, initialState(1_000));
    for (const [columns, rows] of [
      [100, 30],
      [62, 13],
      [140, 44],
    ] as const) {
      const frame = renderFrame(state, computeLayout(columns, rows, 1), style());
      expect(frame).toHaveLength(rows);
      for (const row of frame) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it('lets neither the board nor the teardown replay carry an agent escape', () => {
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
    const streams = fakeStreams();
    const view = createLiveView({
      streams,
      terminal,
      now: fakeClock().now,
      env: { TERM: 'xterm-256color' },
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const api = identity('api');
    view.openTask!(api);
    for (const text of HOSTILE) view.writeLine!(text, api, 'runtime');
    timers.tick();
    const board = terminal.out();
    view.leave();

    // The painter writes alt-screen and cursor addressing of its own, so the
    // board's property is not "no escapes" but "no escape the agent asked for".
    expect(AGENT_ONLY.filter((sequence) => board.includes(sequence))).toEqual([]);
    // The agent asked to leave the alternate screen; only the teardown may.
    expect(board.split(`${ESC}[?1049l`).length - 1).toBe(0);
    // The replay lands on the user's normal screen, where nothing may move a
    // cursor at all: colour only.
    expect(streams.stdoutText().replace(SGR, '')).not.toContain(ESC);
    // Still a complete, readable transcript: only the sequences went.
    expect(streams.stdoutText()).toContain('RIS-just-happened');
    expect(streams.stdoutText()).toContain('and-the-title-is-gone');
    expect(streams.stdoutText()).toContain('tool write_file src/pagination.js');
  });

  it('carries the same guarantee on the run lane, which no task identity ever reaches', () => {
    const state = reduce(initialState(1_000), { at: 1_000, laneId: RUN_LANE, line: `candidate diff: ${ESC}[?1049l`, origin: 'runtime' });
    const frame = renderFrame(state, computeLayout(100, 30, 0), style({ focus: RUN_LANE })).join('');
    expect(frame.replace(SGR, '')).not.toContain(ESC);
  });
});

/**
 * The same guarantee, through the real coordinator rather than a hand-built
 * state.
 *
 * The reproduction that mattered most did not need a hostile "message" at all:
 * a source file whose content ends in an escape sequence reaches the terminal
 * through the candidate diff preview, on a run that is ACCEPTED and exits 0. A
 * green run and a broken shell is the worst combination available.
 */
describe('a run whose worker writes escape sequences into a file', () => {
  it('prints the diff preview without handing the terminal a single one of them', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-escape-'), 'state');
    const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-escape-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const poisoned = `export const banner = '${ESC}[?1049l${ESC}[2J${ESC}c${ESC}]0;PWNED${BEL}${ESC}[41m';\n`;
    const scenarioPath = writeScenario({
      scenarioVersion: 1,
      steps: [
        { action: 'message', text: `Done. ${ESC}[?1049lterminal is mine now` },
        { action: 'edit_file', path: 'src/banner.ts', content: poisoned },
        { action: 'claim_done', message: 'Added the banner.' },
      ],
    });

    const streams = fakeStreams(false);
    const renderer = createPlainRenderer(new Reporter(false, streams), streams, { heartbeatMs: 0 });
    await runDirect({
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add a banner.',
      requestSource: 'test',
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      stream: renderer,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });
    renderer.dispose();

    const out = streams.stdoutText();
    // The diff really did reach the terminal, and the poisoned line with it.
    expect(out).toContain('src/banner.ts');
    expect(out).toContain('export const banner');
    // Not one escape byte, and not one control character either.
    expect(out.replace(SGR, '')).not.toContain(ESC);
    expect(out).not.toContain(BEL);
  }, 180_000);
});
