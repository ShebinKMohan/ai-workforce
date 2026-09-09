/**
 * The painter: the only stateful thing in the live view, and the only thing
 * that writes an escape sequence to the terminal.
 *
 * ## Row diff, not clear
 *
 * It holds `previous` — the exact bytes written to each screen row last frame
 * — and writes only the rows whose bytes changed, each as an absolute cursor
 * address plus an erase-line. In steady state a frame touches three to eight
 * rows and costs one `write` syscall. Clearing the screen every frame instead
 * would make the whole board flicker at the frame rate for no information.
 *
 * Absolute addressing and erase-line only: the most portable subset there is.
 * No scroll regions, no save/restore cursor. The clear-screen sequence is
 * emitted only on a full invalidate — that is, a resize.
 *
 * ## Restore, always
 *
 * `leave()` is idempotent and every path out of the process is wired to it:
 * the `try/finally` around the run, `exit`, `SIGINT`, `SIGTERM`,
 * `uncaughtException`, `unhandledRejection`. A UI that leaves a terminal with
 * a hidden cursor and an alternate buffer is worse than no UI. `SIGKILL` is
 * the accepted residual risk, the same one `less`, `htop` and `vim` take; the
 * cure is `reset`.
 */
import { CLEAR_SCREEN, cursorTo, ENTER_ALT_SCREEN, ERASE_LINE, LEAVE_ALT_SCREEN } from '../ansi.js';

export interface PaintTarget {
  write(chunk: string): unknown;
  readonly columns?: number;
  readonly rows?: number;
}

export interface Painter {
  /** Enter the alternate screen. Idempotent; returns false if already inside. */
  enter(): boolean;
  /** Draw `next`, writing only the rows that changed. */
  paint(next: ReadonlyArray<string>): void;
  /** Next paint redraws everything, after one clear. For a resize. */
  invalidate(): void;
  /** Restore the terminal. Idempotent, and safe to call from a signal handler. */
  leave(): boolean;
  readonly active: boolean;
}

export function createPainter(target: PaintTarget): Painter {
  let previous: string[] = [];
  let active = false;
  let left = false;
  let clearNext = false;

  return {
    get active() {
      return active;
    },
    enter: () => {
      if (active || left) return false;
      active = true;
      previous = [];
      clearNext = true;
      target.write(ENTER_ALT_SCREEN);
      return true;
    },
    invalidate: () => {
      previous = [];
      clearNext = true;
    },
    paint: (next) => {
      if (!active) return;
      let out = clearNext ? CLEAR_SCREEN : '';
      clearNext = false;
      for (let index = 0; index < next.length; index += 1) {
        const row = next[index]!;
        if (row === previous[index]) continue;
        out += `${cursorTo(index + 1)}${ERASE_LINE}${row}`;
      }
      previous = [...next];
      // One syscall per frame. Colour codes live inside the row string, so a
      // colour-only change is a changed row and repaints correctly.
      if (out.length > 0) target.write(out);
    },
    leave: () => {
      if (!active) return false;
      active = false;
      left = true;
      previous = [];
      target.write(LEAVE_ALT_SCREEN);
      return true;
    },
  };
}
