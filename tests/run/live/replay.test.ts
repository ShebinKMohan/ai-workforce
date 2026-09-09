/**
 * The invariant the whole design rests on.
 *
 * An alternate screen buffer is discarded when you leave it. If the live view
 * kept the run's history only on that screen, using it would destroy the
 * evidence surface this product exists to produce — you would watch a
 * beautiful board and be left with an empty terminal.
 *
 * So: **the stdout bytes a live run leaves behind equal the stdout bytes the
 * same run produces under `--view plain`.** Written first, tested first, and
 * held here against the real renderers with a scripted run both of them see
 * identically.
 */
import { describe, expect, it } from 'vitest';
import { createPlainRenderer } from '../../../src/cli/live/plain.js';
import { createLiveView } from '../../../src/cli/live/view.js';
import { Reporter } from '../../../src/cli/output.js';
import { ALT_ENTER, ALT_LEAVE, fakeClock, fakeStreams, fakeTerminal, fakeTimers, playScript, strip, twoTaskScript } from './support.js';

describe('teardown replay', () => {
  it('leaves behind exactly the bytes the same run produces under --view plain', () => {
    const script = twoTaskScript();

    // The plain run: the renderer the non-TTY path uses, writing to stdout.
    const plainStreams = fakeStreams();
    const plain = createPlainRenderer(new Reporter(false, plainStreams), plainStreams, { now: fakeClock().now, heartbeatMs: 0 });
    playScript(plain, script);
    plain.dispose();

    // The live run: the board owns the terminal for the duration, and the
    // transcript arrives on stdout only when the view leaves.
    const liveStreams = fakeStreams();
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
    const clock = fakeClock();
    const view = createLiveView({
      streams: liveStreams,
      terminal,
      now: clock.now,
      env: { TERM: 'xterm-256color', FORCE_COLOR: '1' },
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    playScript(view, script, () => timers.tick());

    // Nothing on stdout while the board is up: the run's own screen is stderr.
    expect(liveStreams.stdoutText()).toBe('');
    expect(terminal.out()).toContain(ALT_ENTER);

    view.leave();
    expect(terminal.out()).toContain(ALT_LEAVE);
    expect(liveStreams.stdoutText()).toBe(plainStreams.stdoutText());
    expect(liveStreams.stdoutText().length).toBeGreaterThan(200);
  });

  it('replays through the plain renderer, so every line still names the lane that wrote it', () => {
    const streams = fakeStreams();
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
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
    playScript(view, twoTaskScript());
    view.leave();

    // Stripped, because the label is painted in the lane's identity colour;
    // what is asserted here is the text, which colour never carries.
    const lines = strip(streams.stdoutText()).split('\n');
    expect(lines.some((line) => line.startsWith('[alpha] '))).toBe(true);
    expect(lines.some((line) => line.startsWith('[beta] '))).toBe(true);
    // The run's own lines stay unlabelled: they belong to no task.
    expect(lines.some((line) => line.startsWith('run run-1234abcd'))).toBe(true);
  });

  it('keeps a run of consecutive continuation lines under one label instead of stamping every row', () => {
    const streams = fakeStreams();
    const plain = createPlainRenderer(new Reporter(false, streams), streams, { now: fakeClock().now, heartbeatMs: 0 });
    // Two live tasks, so labels are on. Then one lane emits a diff.
    plain.openTask!({ taskId: 'task-alpha', key: 'alpha' });
    plain.openTask!({ taskId: 'task-beta', key: 'beta' });
    plain.writeLine!('candidate diff:', { taskId: 'task-alpha', key: 'alpha' });
    for (let index = 0; index < 5; index += 1) plain.writeLine!(`  +line ${index}`, { taskId: 'task-alpha', key: 'alpha' });
    // An interleave from the other lane, and then alpha again.
    plain.writeLine!('  exec npm test', { taskId: 'task-beta', key: 'beta' });
    plain.writeLine!('  +line after', { taskId: 'task-alpha', key: 'alpha' });

    const lines = strip(streams.stdoutText()).split('\n').filter((line) => line.length > 0);
    const labelled = lines.filter((line) => line.startsWith('[alpha]'));
    // One label for the diff's opening line, and one again after beta cut in —
    // not seven.
    expect(labelled).toHaveLength(2);
    // The five diff rows are aligned under their parent, in the gutter.
    expect(lines.filter((line) => line.startsWith('          +line'))).toHaveLength(5);
    // And attribution is never actually lost: beta's line carries its label.
    expect(lines.some((line) => line.startsWith('[beta]'))).toBe(true);
  });

  it('never lets a token-shaped string reach a painted byte or a replayed byte', () => {
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const streams = fakeStreams();
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
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
    view.openTask!({ taskId: 'task-alpha', key: 'alpha' });
    view.openTask!({ taskId: 'task-beta', key: 'beta' });
    view.writeLine!(`  exec curl -H "authorization: Bearer ${secret}"`, { taskId: 'task-alpha', key: 'alpha' });
    timers.tick();

    // Painted, before the run is over.
    expect(terminal.out()).not.toContain(secret);
    view.leave();
    // And replayed.
    expect(streams.stdoutText()).not.toContain(secret);
    expect(streams.stdoutText()).toContain('exec curl');
  });

  it('says by name when a lane outran the transcript, instead of quietly ending shorter', () => {
    const streams = fakeStreams();
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
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
    view.event({ type: 'run.created', runId: 'run-1234abcd', taskCount: 2 });
    view.openTask!({ taskId: 'task-alpha', key: 'alpha' });
    view.openTask!({ taskId: 'task-beta', key: 'beta' });
    for (let index = 0; index < 50_010; index += 1) view.writeLine!(`  line ${index}`, { taskId: 'task-alpha', key: 'alpha' });
    view.leave();
    expect(streams.stdoutText()).toMatch(/earlier line\(s\) from \[alpha\]/);
  }, 30_000);
});
