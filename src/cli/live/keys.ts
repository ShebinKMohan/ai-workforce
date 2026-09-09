/**
 * Raw-mode key reading, and the one trap that must not be got wrong.
 *
 * ## Ctrl+C
 *
 * Raw mode suppresses the tty-generated SIGINT, so `\x03` arrives as an
 * ordinary keystroke. If the view swallowed it, Ctrl+C would stop working
 * mid-run. It is re-raised as a real signal instead, which re-enters the
 * existing handler in `cli/index.ts` and preserves its two-strike behaviour
 * byte for byte — the view adds no interrupt semantics of its own.
 *
 * ## Degradation
 *
 * Every `setRawMode` call is guarded. A piped stdin, a stdin that is not a
 * TTY, a `setRawMode` that throws: all of them mean "no keys", never "crash".
 * The board still draws; the footer still shows the bindings, because they
 * are true of the terminal the user could attach from.
 *
 * No key mutates run state. There is no kill-agent, no retry, no approve, and
 * deliberately no text input: those are decisions with receipts behind them,
 * and steering a live turn is a different feature with real safety questions.
 * The live view observes; the CLI decides.
 */

export interface KeyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: 'utf8'): unknown;
  on(event: 'data', handler: (chunk: string) => void): unknown;
  off?(event: 'data', handler: (chunk: string) => void): unknown;
  removeListener?(event: 'data', handler: (chunk: string) => void): unknown;
}

/** One decoded keystroke. Single characters and the few named keys the view binds. */
export type Key =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown' | 'home' | 'end' | 'tab' | 'shifttab' | 'escape' };

export interface KeyReader {
  /** False when this stdin could not be put in raw mode; the caller shows no warning and carries on. */
  readonly enabled: boolean;
  stop(): void;
}

const NAMED: Readonly<Record<string, Key['kind']>> = {
  '\u001B[A': 'up',
  '\u001B[B': 'down',
  '\u001B[C': 'right',
  '\u001B[D': 'left',
  '\u001B[5~': 'pageup',
  '\u001B[6~': 'pagedown',
  '\u001B[H': 'home',
  '\u001B[F': 'end',
  '\u001B[1~': 'home',
  '\u001B[4~': 'end',
  '\u001B[Z': 'shifttab',
};

export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === '\u001B') {
      // Longest match first: `ESC[5~` must not be read as `ESC[5` plus `~`.
      const found = Object.keys(NAMED)
        .filter((sequence) => chunk.startsWith(sequence, index))
        .sort((a, b) => b.length - a.length)[0];
      if (found !== undefined) {
        keys.push({ kind: NAMED[found]! } as Key);
        index += found.length;
        continue;
      }
      if (chunk.length === index + 1) {
        keys.push({ kind: 'escape' });
        index += 1;
        continue;
      }
      // An unrecognized escape sequence is consumed whole rather than
      // delivered as a stream of stray characters that would look like key
      // presses the user never made.
      const terminator = /[A-Za-z~]/.exec(chunk.slice(index + 1));
      index += terminator === null ? chunk.length - index : terminator.index + 2;
      continue;
    }
    const character = chunk[index]!;
    if (character === '\t') keys.push({ kind: 'tab' });
    else keys.push({ kind: 'char', value: character });
    index += 1;
  }
  return keys;
}

export interface KeyReaderOptions {
  /** Called for `\x03`. Defaults to re-raising SIGINT at this process. */
  readonly onInterrupt?: () => void;
}

export function readKeys(input: KeyInput | undefined, handle: (key: Key) => void, options: KeyReaderOptions = {}): KeyReader {
  const interrupt =
    options.onInterrupt ??
    (() => {
      // Re-enter the CLI's own handler rather than reimplementing it here.
      process.kill(process.pid, 'SIGINT');
    });

  if (input === undefined || input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return { enabled: false, stop: () => {} };
  }
  try {
    input.setRawMode(true);
  } catch {
    return { enabled: false, stop: () => {} };
  }
  try {
    input.setEncoding?.('utf8');
    input.resume?.();
  } catch {
    // A stdin that cannot be resumed simply delivers nothing.
  }

  const onData = (chunk: string): void => {
    for (const key of decodeKeys(typeof chunk === 'string' ? chunk : String(chunk))) {
      if (key.kind === 'char' && key.value === '\u0003') {
        interrupt();
        return;
      }
      handle(key);
    }
  };
  input.on('data', onData);

  let stopped = false;
  return {
    enabled: true,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        (input.off ?? input.removeListener)?.call(input, 'data', onData);
      } catch {
        // Nothing to detach from.
      }
      try {
        input.setRawMode?.(false);
        input.pause?.();
      } catch {
        // Restoring a stdin that has already gone away is not an error.
      }
    },
  };
}
