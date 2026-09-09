/**
 * Keys, and the one that must not be swallowed.
 *
 * Raw mode suppresses the tty-generated SIGINT, so Ctrl+C reaches the process
 * as an ordinary byte. A view that consumed it would silently break the only
 * way to stop a run — so it is re-raised as a real signal, and the CLI's own
 * two-strike handler stays the single place interruption is decided.
 *
 * The rest of these hold the smaller promise: no key mutates run state, and a
 * stdin that cannot be put in raw mode degrades to "no keys" rather than to a
 * crash.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeKeys, readKeys, type Key, type KeyInput } from '../../../src/cli/live/keys.js';
import { createLiveView } from '../../../src/cli/live/view.js';
import { fakeClock, fakeStreams, fakeTerminal, fakeTimers, identity } from './support.js';

const ESC = '\u001B';

function fakeStdin(overrides: Partial<KeyInput> = {}): KeyInput & { send(chunk: string): void; raw: boolean[] } {
  let handler: ((chunk: string) => void) | null = null;
  const raw: boolean[] = [];
  return {
    isTTY: true,
    setRawMode(mode: boolean) {
      raw.push(mode);
      return this;
    },
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    on(_event, next) {
      handler = next;
      return this;
    },
    off() {
      handler = null;
      return this;
    },
    send(chunk: string) {
      handler?.(chunk);
    },
    raw,
    ...overrides,
  } as KeyInput & { send(chunk: string): void; raw: boolean[] };
}

describe('key decoding', () => {
  it('reads the named keys as whole sequences, never as stray characters', () => {
    expect(decodeKeys(`${ESC}[A`)).toEqual([{ kind: 'up' }]);
    expect(decodeKeys(`${ESC}[5~`)).toEqual([{ kind: 'pageup' }]);
    expect(decodeKeys(`${ESC}[Z`)).toEqual([{ kind: 'shifttab' }]);
    expect(decodeKeys('\t')).toEqual([{ kind: 'tab' }]);
    expect(decodeKeys('af')).toEqual([
      { kind: 'char', value: 'a' },
      { kind: 'char', value: 'f' },
    ]);
  });

  it('swallows an escape sequence it does not know rather than reporting key presses nobody made', () => {
    // A mouse report, a bracketed-paste marker, a terminal query answer: all
    // arrive unbidden, and none of them is five keystrokes.
    expect(decodeKeys(`${ESC}[200~`)).toEqual([]);
    expect(decodeKeys(`${ESC}[?1;2c`)).toEqual([]);
  });
});

describe('the Ctrl+C trap', () => {
  it('re-raises Ctrl+C as a signal instead of handling it, so the CLI keeps deciding what an interrupt means', () => {
    const onInterrupt = vi.fn();
    const seen: Key[] = [];
    const stdin = fakeStdin();
    readKeys(stdin, (key) => seen.push(key), { onInterrupt });
    stdin.send('\u0003');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    // And it is not delivered as a key: nothing in the view may react to it.
    expect(seen).toEqual([]);
  });

  it('puts stdin in raw mode and takes it back out again', () => {
    const stdin = fakeStdin();
    const reader = readKeys(stdin, () => {});
    expect(reader.enabled).toBe(true);
    expect(stdin.raw).toEqual([true]);
    reader.stop();
    expect(stdin.raw).toEqual([true, false]);
    // Stopping twice is not an error: it runs from both a finally and a
    // signal handler.
    reader.stop();
    expect(stdin.raw).toEqual([true, false]);
  });

  it('degrades to no keys when stdin is a pipe or refuses raw mode, and never throws', () => {
    expect(readKeys(undefined, () => {}).enabled).toBe(false);
    expect(readKeys(fakeStdin({ isTTY: false }), () => {}).enabled).toBe(false);
    const hostile = fakeStdin({
      setRawMode: () => {
        throw new Error('inappropriate ioctl for device');
      },
    });
    expect(readKeys(hostile, () => {}).enabled).toBe(false);
  });
});

describe('what the keys do to the view', () => {
  function view() {
    const terminal = fakeTerminal(100, 30);
    const timers = fakeTimers();
    const streams = fakeStreams();
    const stdin = fakeStdin();
    const live = createLiveView({
      streams,
      terminal,
      stdin,
      now: fakeClock().now,
      env: { TERM: 'xterm-256color' },
      heartbeatMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    live.openTask!(identity('alpha'));
    live.openTask!(identity('beta'));
    live.writeLine!('  alpha is working', identity('alpha'));
    live.writeLine!('  beta is working', identity('beta'));
    timers.tick();
    terminal.clear();
    return { live, terminal, timers, streams, stdin };
  }

  it('moves the focus pane between lanes without touching the run', () => {
    const { live, terminal, timers, stdin } = view();
    stdin.send('2');
    timers.tick();
    expect(terminal.out()).toContain('beta is working');
    stdin.send('1');
    timers.tick();
    expect(terminal.out()).toContain('alpha is working');
    // Two lanes are still live: nothing a key did changed the run.
    expect(live.state.lanes.map((lane) => lane.status)).toEqual(['queued', 'queued']);
  });

  it('answers a reflex q with a toast, and does not quit', () => {
    const { live, terminal, timers, stdin } = view();
    stdin.send('q');
    timers.tick();
    expect(terminal.out()).toContain('^C interrupts this run');
    expect(live.active).toBe(true);
  });

  it('leaves the view for good on p, and finishes in plain text', () => {
    const { live, terminal, timers, streams, stdin } = view();
    stdin.send('p');
    timers.tick();
    expect(live.active).toBe(false);
    expect(terminal.out()).toContain('?1049l');
    live.line('after');
    expect(streams.stdoutText()).toContain('after');
  });

  it('takes the ? overlay down again on the next key, whatever it is', () => {
    const { terminal, timers, stdin } = view();
    stdin.send('?');
    timers.tick();
    expect(terminal.out()).toContain('workforce watch');
    terminal.clear();
    stdin.send('j');
    timers.tick();
    expect(terminal.out()).not.toContain('workforce watch');
  });
});
