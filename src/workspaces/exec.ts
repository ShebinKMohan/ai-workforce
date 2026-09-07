/**
 * Bounded subprocess execution.
 *
 * Every process this package starts goes through here, so the rules hold in
 * one place:
 *
 * - `spawn(executable, argsArray, { shell: false })`. No shell string is ever
 *   built from task text, repository content or check configuration.
 * - The child gets its own process group (`detached: true`) and a timeout is
 *   enforced in Node (there is no `gtimeout` on the target machine): SIGTERM
 *   to the whole group, then SIGKILL after a grace period, so a test that
 *   forks children cannot outlive its deadline.
 * - The environment is exactly what the caller passes. Nothing is inherited
 *   implicitly, so a check can never read the coordinator's environment.
 * - Output is bounded. `maxOutputBytes` caps what is kept in memory and what
 *   is written to a log file; the excess is counted, not silently dropped.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/ids.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 2_000;

export interface RunCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Complete environment for the child. Nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Wall-clock deadline enforced in Node. Omit or 0 for no deadline. */
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /** When set, output is also appended to these files (created, parents made). */
  readonly stdoutFile?: string;
  readonly stderrFile?: string;
  /** Aborting terminates the process group the same way a timeout does. */
  readonly signal?: AbortSignal;
  readonly input?: string;
}

export interface CommandRun {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Non-null when the executable could not be started at all (for example ENOENT). */
  readonly spawnError: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Captured text, truncated to `maxOutputBytes`. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  /** Signals actually sent to the process group, in order. */
  readonly signalsSent: ReadonlyArray<NodeJS.Signals>;
  readonly ok: boolean;
}

class BoundedSink {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #kept = 0;
  #total = 0;
  #fd: number | null = null;

  constructor(limit: number, filePath?: string) {
    this.#limit = limit;
    if (filePath !== undefined) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      this.#fd = openSync(filePath, 'w', 0o600);
    }
  }

  write(chunk: Buffer): void {
    this.#total += chunk.length;
    const room = this.#limit - this.#kept;
    if (room <= 0) return;
    const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#kept += slice.length;
    this.#chunks.push(slice);
    if (this.#fd !== null) {
      let offset = 0;
      while (offset < slice.length) offset += writeSync(this.#fd, slice, offset, slice.length - offset);
    }
  }

  close(note: string): { text: string; bytes: number; truncated: boolean } {
    const truncated = this.#total > this.#kept;
    if (this.#fd !== null) {
      if (truncated) {
        const tail = Buffer.from(`\n[${note}: output truncated at ${this.#kept} of ${this.#total} bytes]\n`, 'utf8');
        let offset = 0;
        while (offset < tail.length) offset += writeSync(this.#fd, tail, offset, tail.length - offset);
      }
      closeSync(this.#fd);
      this.#fd = null;
    }
    return { text: Buffer.concat(this.#chunks).toString('utf8'), bytes: this.#total, truncated };
  }
}

/**
 * Run one command to completion. Never rejects for a non-zero exit: the
 * outcome is data the caller records as evidence.
 */
export async function runCommand(input: RunCommandInput): Promise<CommandRun> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = nowIso();
  const startedHr = Date.now();
  const args = [...input.args];

  const stdout = new BoundedSink(maxOutputBytes, input.stdoutFile);
  const stderr = new BoundedSink(maxOutputBytes, input.stderrFile);
  const signalsSent: NodeJS.Signals[] = [];

  return await new Promise<CommandRun>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(input.command, args, {
      cwd: input.cwd,
      env: { ...input.env },
      shell: false,
      detached: true, // own process group: the whole tree is killable
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      signalsSent.push(signal);
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          try {
            child.kill(signal);
          } catch {
            // the process is already gone
          }
        }
      }
    };

    const terminate = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
      killTimer.unref?.();
    };

    const onAbort = (): void => {
      if (settled || aborted) return;
      aborted = true;
      terminate();
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) queueMicrotask(onAbort);
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, input.timeoutMs);
      timer.unref?.();
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));
    child.stdin?.on('error', () => {
      // EPIPE when the child exits before reading stdin.
    });
    if (input.input !== undefined) child.stdin?.end(input.input);
    else child.stdin?.end();

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', onAbort);
      const out = stdout.close('stdout');
      const err = stderr.close('stderr');
      const endedAt = nowIso();
      resolve({
        command: input.command,
        args,
        cwd: input.cwd,
        exitCode: code,
        signal,
        timedOut,
        aborted,
        spawnError,
        startedAt,
        endedAt,
        durationMs: Date.now() - startedHr,
        stdout: out.text,
        stderr: err.text,
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        truncated: out.truncated || err.truncated,
        signalsSent,
        ok: spawnError === null && code === 0 && !timedOut && !aborted,
      });
    };

    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
