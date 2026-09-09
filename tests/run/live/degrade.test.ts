/**
 * Degrading, and the things that must not change when it happens.
 *
 * A pipe, a redirect, a CI log, `TERM=dumb`, `--json`, a single-task run and a
 * terminal too small to draw in all get exactly the bytes they got before this
 * view existed. That is not politeness — those are the destinations the
 * evidence surface actually lands in, and a UI that changed them would change
 * what a run *is*.
 *
 * This file also holds the painter's two behavioural properties: it coalesces
 * bursts instead of painting per event, and it repaints rows rather than
 * clearing the screen.
 */
import { describe, expect, it } from 'vitest';
import { decideView } from '../../../src/cli/commands/run.js';
import { createPainter } from '../../../src/cli/live/paint.js';
import { createPlainRenderer } from '../../../src/cli/live/plain.js';
import { createLiveView } from '../../../src/cli/live/view.js';
import { MIN_COLUMNS, MIN_ROWS } from '../../../src/cli/live/layout.js';
import { Reporter } from '../../../src/cli/output.js';
import { ALT_ENTER, ALT_LEAVE, fakeClock, fakeStreams, fakeTerminal, fakeTimers, identity, playScript, twoTaskScript } from './support.js';

const tty = { isTTY: true, columns: 100, rows: 30 };
const pipe = { isTTY: false };
const term = { TERM: 'xterm-256color' };

function liveView(terminal = fakeTerminal(100, 30), timers = fakeTimers(), streams = fakeStreams()) {
  const view = createLiveView({
    streams,
    terminal,
    now: fakeClock().now,
    env: term,
    heartbeatMs: 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { view, terminal, timers, streams };
}

describe('the degradation ladder', () => {
  it('refuses the board for --json, so stdout stays pure JSONL', () => {
    expect(decideView({ requested: undefined, json: true, taskCount: 5, stdout: tty, stderr: tty, env: term }).view).toBe('plain');
  });

  it('refuses the board for anything that is not a terminal on both streams', () => {
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: pipe, stderr: tty, env: term }).view).toBe('plain');
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: tty, stderr: pipe, env: term }).view).toBe('plain');
  });

  it('refuses the board for TERM=dumb and for an unset TERM', () => {
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: tty, stderr: tty, env: { TERM: 'dumb' } }).view).toBe('plain');
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: tty, stderr: tty, env: {} }).view).toBe('plain');
  });

  it('refuses the board for a run with fewer than two tasks, because it would be a frame around a log', () => {
    expect(decideView({ requested: undefined, json: false, taskCount: 1, stdout: tty, stderr: tty, env: term }).view).toBe('plain');
    // …unless it is asked for explicitly.
    expect(decideView({ requested: 'live', json: false, taskCount: 1, stdout: tty, stderr: tty, env: term }).view).toBe('live');
  });

  it('refuses the board for a terminal too small, and says why', () => {
    const small = { isTTY: true, columns: MIN_COLUMNS - 10, rows: MIN_ROWS };
    const decision = decideView({ requested: undefined, json: false, taskCount: 5, stdout: small, stderr: small, env: term });
    expect(decision.view).toBe('plain');
    expect(decision.reason).toContain('the board needs');
  });

  it('honours WORKFORCE_VIEW=plain and --view plain, over everything', () => {
    expect(decideView({ requested: 'plain', json: false, taskCount: 5, stdout: tty, stderr: tty, env: term }).view).toBe('plain');
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: tty, stderr: tty, env: { ...term, WORKFORCE_VIEW: 'plain' } }).view).toBe('plain');
  });

  it('still draws the board under NO_COLOR, because that is a colour convention and not a cursor one', () => {
    expect(decideView({ requested: undefined, json: false, taskCount: 5, stdout: tty, stderr: tty, env: { ...term, NO_COLOR: '1' } }).view).toBe('live');

    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
    const view = createLiveView({
      streams: fakeStreams(),
      terminal,
      now: fakeClock().now,
      env: { ...term, NO_COLOR: '1' },
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    playScript(view, twoTaskScript(), () => timers.tick());
    const painted = terminal.out();
    view.leave();
    // Cursor control, yes. Colour, none: the only escapes are the screen and
    // cursor sequences the board cannot work without.
    expect(painted).toContain(ALT_ENTER);
    expect(painted).not.toMatch(/\u001B\[(?:9[0-7]|3[0-7]|1|2)m/);
    // And the board is complete, not degraded.
    expect(painted).toContain('alpha');
    expect(painted).toContain('beta');
  });

  it('produces exactly the old bytes when the plain renderer runs a single-task run', () => {
    // One task never labels anything: the direct path's output must be what it
    // always was, byte for byte.
    const streams = fakeStreams();
    const plain = createPlainRenderer(new Reporter(false, streams), streams, { now: fakeClock().now });
    plain.openTask!(identity('only'));
    plain.line('run run-1234abcd');
    plain.writeLine!('  turn started', identity('only'));
    plain.writeLine!('  changed src/a.ts', identity('only'));
    plain.closeTask!(identity('only'));
    plain.dispose();
    expect(streams.stdoutText()).toBe('run run-1234abcd\n  turn started\n  changed src/a.ts\n');
    expect(streams.stdoutText()).not.toContain('\u001B');
  });

  it('leaves the alternate screen exactly once when the terminal is resized too small, and never returns to it', () => {
    const { view, terminal, timers, streams } = liveView();
    playScript(view, twoTaskScript().slice(0, 6), () => timers.tick());
    expect(terminal.out()).toContain(ALT_ENTER);

    terminal.resize(50, 30);
    timers.flushTimeouts();
    timers.tick();

    const leaves = terminal.out().split(ALT_LEAVE).length - 1;
    expect(leaves).toBe(1);
    expect(view.active).toBe(false);

    // From here the run reports itself in plain text on stdout…
    const before = streams.stdoutText().length;
    view.line('a line after the degrade');
    expect(streams.stdoutText().slice(before)).toContain('a line after the degrade');

    // …and growing the window back does not re-enter. A view that flapped in
    // and out of the alternate buffer while someone dragged a panel edge would
    // be worse than one that made a decision.
    terminal.resize(120, 40);
    timers.flushTimeouts();
    timers.tick();
    expect(terminal.out().split(ALT_ENTER).length - 1).toBe(1);
  });

  it('coalesces a burst of events into a handful of frames instead of one frame each', () => {
    const { view, terminal, timers } = liveView();
    view.openTask!(identity('alpha'));
    view.openTask!(identity('beta'));
    terminal.clear();

    // Three hundred events with no timer tick between them: the view must not
    // paint from an event handler.
    for (let index = 0; index < 300; index += 1) {
      view.event({ type: 'runtime.tool_result', payload: { tool: 'Read', status: 'ok' }, ...identity('alpha') });
      view.writeLine!(`  tool Read -> ok (${index})`, identity('alpha'));
    }
    expect(terminal.writes()).toBe(0);

    timers.tick(6);
    // One dirty frame, then five ticks that find nothing to do.
    expect(terminal.writes()).toBeLessThan(10);
    view.leave();
  });

  it('repaints only the rows that changed, and clears the screen only on a full invalidate', () => {
    const target = { writes: [] as string[], write(chunk: string) { this.writes.push(chunk); return true; } };
    const painter = createPainter(target);
    painter.enter();
    painter.paint(['one', 'two', 'three']);
    const first = target.writes.length;
    painter.paint(['one', 'CHANGED', 'three']);
    const delta = target.writes[first]!;
    // One row addressed, one row erased, one row written.
    expect(delta).toContain('CHANGED');
    expect(delta).not.toContain('three');
    expect(delta.split('\u001B[2K').length - 1).toBe(1);
    // An identical frame writes nothing at all: an idle run goes quiet.
    const before = target.writes.length;
    painter.paint(['one', 'CHANGED', 'three']);
    expect(target.writes.length).toBe(before);
    // A resize invalidates, and only then is the screen cleared.
    painter.invalidate();
    painter.paint(['one', 'CHANGED', 'three']);
    expect(target.writes[target.writes.length - 1]).toContain('\u001B[2J');
    painter.leave();
    expect(target.writes[target.writes.length - 1]).toContain('?1049l');
  });

  it('restores the terminal on leave, and leaving twice is not an error', () => {
    const { view, terminal } = liveView();
    view.leave();
    view.leave();
    expect(terminal.out().split(ALT_LEAVE).length - 1).toBe(1);
    // The cursor comes back before the buffer is swapped, so nothing is left
    // hidden on the user's real screen.
    expect(terminal.out()).toContain('\u001B[?25h\u001B[?1049l');
  });

  it('never enters the alternate screen when the terminal is too small to begin with', () => {
    const terminal = fakeTerminal(40, 10);
    const timers = fakeTimers();
    const streams = fakeStreams();
    const view = createLiveView({
      streams,
      terminal,
      now: fakeClock().now,
      env: term,
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(terminal.out()).not.toContain(ALT_ENTER);
    expect(view.active).toBe(false);
    // And it reports itself in plain text straight away, not after the run.
    view.line('a line');
    expect(streams.stdoutText()).toContain('a line');
  });
});
