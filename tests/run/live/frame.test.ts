/**
 * What the screen says, and what colour is allowed to mean.
 *
 * The load-bearing property: strip every escape sequence and the frame says
 * exactly the same thing. Colour is a fast index, never the message — so a
 * monochrome terminal, a colour-blind reader and `NO_COLOR=1` all get a
 * complete board rather than a degraded one.
 */
import { describe, expect, it } from 'vitest';
import { IDENTITY_COLORS, STATUS_COLORS, displayWidth, identityStyle } from '../../../src/cli/ansi.js';
import { renderFrame, type FrameStyle } from '../../../src/cli/live/frame.js';
import { computeLayout } from '../../../src/cli/live/layout.js';
import { initialState, reduce, RUN_LANE, type LineOrigin, type LiveEvent, type LiveState } from '../../../src/cli/live/state.js';
import { strip } from './support.js';

const GREEN = '\u001B[92m';
const RED = '\u001B[91m';

function style(overrides: Partial<FrameStyle> = {}): FrameStyle {
  return {
    color: true,
    unicode: false,
    focus: RUN_LANE,
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
const event = (key: string, type: string, payload: Record<string, unknown> = {}): LiveEvent => ({
  at: 1_000,
  laneId: `task-${key}`,
  identity: { taskId: `task-${key}`, key },
  type,
  payload,
});
const line = (key: string, text: string, origin: LineOrigin = 'coordinator'): LiveEvent => ({ at: 1_000, laneId: `task-${key}`, identity: { taskId: `task-${key}`, key }, line: text, origin });

function threeLaneRun(): LiveState {
  return [
    { at: 1_000, laneId: RUN_LANE, type: 'run.created', payload: { runId: 'run-7f3a19c2', repo: '/tmp/repo', baseRevision: '4b21ff0abc', taskCount: 3 } } as LiveEvent,
    open('core'),
    open('api'),
    open('docs'),
    event('core', 'runtime.turn_started'),
    line('core', '  turn started'),
    event('core', 'task.settled', { accepted: true, repairsUsed: 0 }),
    event('api', 'runtime.turn_started'),
    line('api', '  exec npm test'),
    line('docs', '  changed docs/pagination.md'),
    event('docs', 'runtime.turn_started'),
  ].reduce(reduce, initialState(1_000));
}

describe('live frame', () => {
  it('draws exactly as many rows as the terminal has, none of them wider than it is', () => {
    const state = threeLaneRun();
    for (const [columns, rows] of [
      [100, 30],
      [80, 14],
      [60, 12],
      [140, 44],
    ] as const) {
      const frame = renderFrame(state, computeLayout(columns, rows, state.lanes.length), style());
      expect(frame).toHaveLength(rows);
      for (const row of frame) expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it('says everything in words and shapes, so stripping the colour loses nothing', () => {
    const state = threeLaneRun();
    const layout = computeLayout(100, 30, state.lanes.length);
    const coloured = renderFrame(state, layout, style({ color: true }));
    const mono = renderFrame(state, layout, style({ color: false }));
    expect(coloured.map(strip)).toEqual(mono);
    // And the monochrome frame really does carry every semantic: the marks are
    // distinct ASCII shapes, not the same glyph in different colours.
    const text = mono.join('\n');
    expect(text).toContain('ok');
    expect(text).toContain('>>');
    expect(text).toContain('core');
    expect(text).toContain('api');
    expect(text).toContain('docs');
  });

  it('emits no escape byte at all when colour is off', () => {
    const state = threeLaneRun();
    const mono = renderFrame(state, computeLayout(100, 30, state.lanes.length), style({ color: false })).join('');
    expect(mono).not.toContain('\u001B');
  });

  it('paints nothing green until the verifier has settled a task', () => {
    // A completed turn and a passing check are a claim and an ingredient. Only
    // `task.settled {accepted:true}` is the verdict.
    //
    // The lines fed in are the ones a real agent produces, not the one runtime
    // line that happens to match no pattern: this test used to pass `  turn
    // completed` and would have passed with the pane painting a model's own
    // "the suite: passed" bright green.
    const claimed = [
      open('api'),
      event('api', 'runtime.turn_started'),
      line('api', '  message: I ran the acceptance suite: passed, 41 tests', 'runtime'),
      line('api', '  message: acceptance criterion node-tests-pass: passed (exit 0) in 42ms', 'runtime'),
      line('api', '  exec -> exit 0', 'runtime'),
      event('api', 'runtime.turn_completed'),
      line('api', '  turn completed', 'runtime'),
    ].reduce(reduce, initialState(1_000));
    const frame = renderFrame(claimed, computeLayout(100, 30, 1), style({ focus: 'task-api' })).join('');
    expect(frame).not.toContain(GREEN);
    // Not the colour and not the mark: a tick beside a model's sentence reads
    // as a receipt even in monochrome.
    expect(strip(frame)).not.toMatch(/ v .*acceptance suite/);

    const settled = reduce(claimed, event('api', 'task.settled', { accepted: true, repairsUsed: 0 }));
    expect(renderFrame(settled, computeLayout(100, 30, 1), style({ focus: 'task-api' })).join('')).toContain(GREEN);
  });

  it('gives the green tick to the verifier receipt and to nothing that merely sounds like one', () => {
    // Both strings below are real: the first is what the fake runtime says
    // when it is told to claim success, the second is what `runChecks`
    // actually printed on an accepted run. Before provenance they rendered to
    // the same bytes.
    const claim = '  message: acceptance criterion node-tests-pass: passed (exit 0) in 42ms';
    const receipt = '  check node-tests-pass: passed (exit 0) in 82ms';
    const state = [open('api'), line('api', claim, 'runtime'), line('api', receipt, 'verifier')].reduce(reduce, initialState(1_000));
    const rows = renderFrame(state, computeLayout(120, 30, 1), style({ focus: 'task-api' }));

    // The pane's rows, not the board's: a board row repeats the lane's last
    // line in its `now` column and would answer for the wrong thing.
    const ticked = rows.filter((row) => strip(row).startsWith(' v '));
    const plainPaneRows = rows.filter((row) => strip(row).startsWith('   '));
    expect(ticked).toHaveLength(1);
    expect(strip(ticked[0]!)).toContain('check node-tests-pass');
    expect(ticked[0]!).toContain(GREEN);
    const claimRow = plainPaneRows.find((row) => strip(row).includes('acceptance criterion'))!;
    expect(claimRow).toBeDefined();
    expect(claimRow).not.toContain(GREEN);
    // The lane itself is still unsettled: only the pane line went green, and
    // only because a verifier wrote it.
    expect(state.lanes[0]!.settled).toBeNull();
  });

  it('paints a failed lane red, and never paints an identity red', () => {
    const failed = [open('cli'), event('cli', 'task.settled', { accepted: false, repairsUsed: 0 })].reduce(reduce, initialState(1_000));
    expect(renderFrame(failed, computeLayout(100, 30, 1), style()).join('')).toContain(RED);
    // The identity palette cannot produce red at all, so no task can be
    // assigned failure-red for a whole run.
    for (const label of ['cli', 'api', 'docs', 'core', 'types', 'schema', 'migrate', 'ui']) {
      expect(STATUS_COLORS).not.toContain(identityStyle(label).color);
    }
  });

  it('keeps the identity and status palettes disjoint', () => {
    const overlap = IDENTITY_COLORS.filter((colour) => STATUS_COLORS.includes(colour));
    expect(overlap).toEqual([]);
  });

  it('tells a lane what it is waiting for instead of leaving it blank', () => {
    const state = [
      open('types'),
      { at: 1_000, laneId: RUN_LANE, type: 'schedule.blocked', payload: { blocked: [{ key: 'types', waitingOn: ['core', 'api'], reason: 'dependency' }] } } as LiveEvent,
    ].reduce(reduce, initialState(1_000));
    const text = renderFrame(state, computeLayout(100, 30, 1), style({ color: false })).join('\n');
    expect(text).toContain('waiting on: core, api');
  });

  it('marks a silent lane idle with the fact, rather than spinning at it', () => {
    const state = [open('api'), event('api', 'runtime.turn_started'), line('api', '  exec npm test')].reduce(reduce, initialState(1_000));
    // Twelve seconds after the last event from that lane.
    const text = renderFrame(state, computeLayout(100, 30, 1), style({ color: false, now: 13_000 })).join('\n');
    expect(text).toMatch(/idle \d+:\d\d/);
  });

  it('accounts for every lane even when they do not all fit as rows', () => {
    let state = initialState(1_000);
    for (let index = 0; index < 12; index += 1) state = reduce(state, open(`t${index}`));
    const layout = computeLayout(100, 20, state.lanes.length);
    expect(layout.compact).toBe(true);
    const text = renderFrame(state, layout, style({ color: false })).join('\n');
    expect(text).toMatch(/\(\+\d+ more\)/);
  });

  it("puts the ready-to-paste watch command in the ? overlay, one per lane", () => {
    const state = threeLaneRun();
    const text = renderFrame(state, computeLayout(100, 30, state.lanes.length), style({ color: false, overlay: true })).join('\n');
    expect(text).toContain('workforce watch run-7f3a19c2 --task core');
    expect(text).toContain('workforce watch run-7f3a19c2 --task api');
    expect(text).toContain('workforce watch run-7f3a19c2 --task docs');
  });

  it('labels every line in the interleaved view, which is where causality is read', () => {
    const state = threeLaneRun();
    const text = renderFrame(state, computeLayout(100, 30, state.lanes.length), style({ color: false, interleaved: true })).join('\n');
    expect(text).toContain('[core]');
    expect(text).toContain('[api]');
    expect(text).toContain('[docs]');
  });
});
