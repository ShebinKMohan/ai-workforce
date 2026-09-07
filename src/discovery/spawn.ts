/**
 * Bounded probe execution (FR002).
 *
 * A probe runs `<executable> <documented flags>` with `shell: false`, in a
 * neutral temporary working directory, with a sanitized environment, with
 * stdin closed and with a deadline. On timeout the whole process group is
 * terminated, so a probe can never leave a grandchild behind.
 *
 * The spawner is injectable so tests can record exactly which argv discovery
 * would run. `assertDocumentedProbeArgv` is the hard guard: any argument list
 * that is not one of the documented flag sets throws before a spawn happens,
 * which is what keeps a prompt out of a passive probe.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiscoveryError, RUNTIME_DESCRIPTORS, type DiscoverableAdapter } from './runtimes.js';

export const PROBE_TIMEOUT_MS = 10_000;
/** Grace between SIGTERM and SIGKILL for a timed-out probe's process group. */
export const PROBE_KILL_GRACE_MS = 500;
/** Output beyond this is dropped; a version line is short and a probe must not be able to exhaust memory. */
export const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ProbeCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface ProbeResult {
  readonly command: ProbeCommand;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT, EACCES, ...). */
  readonly spawnError: string | null;
  readonly pid: number | null;
  readonly durationMs: number;
}

export type ProbeSpawner = (command: ProbeCommand) => Promise<ProbeResult>;

// ---------------------------------------------------------------------------
// Documented probe argv (the only argument lists passive discovery may run)
// ---------------------------------------------------------------------------

export const ALLOWED_PROBE_ARGV: Readonly<Record<DiscoverableAdapter, ReadonlyArray<ReadonlyArray<string>>>> = {
  codex: [RUNTIME_DESCRIPTORS.codex.versionArgs, RUNTIME_DESCRIPTORS.codex.authArgs],
  'claude-code': [RUNTIME_DESCRIPTORS['claude-code'].versionArgs, RUNTIME_DESCRIPTORS['claude-code'].authArgs],
};

function argvEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Throws unless `args` is exactly one of the documented flag sets for the
 * adapter. Passive discovery must never pass a prompt, a file, `-p`, `exec`
 * or anything else that could start a model turn.
 */
export function assertDocumentedProbeArgv(adapter: DiscoverableAdapter, args: ReadonlyArray<string>): void {
  const allowed = ALLOWED_PROBE_ARGV[adapter];
  if (allowed.some((candidate) => argvEquals(candidate, args))) return;
  throw new DiscoveryError(
    'undocumented_probe_argv',
    `refusing to probe ${adapter} with [${args.map((a) => JSON.stringify(a)).join(', ')}]: passive discovery may only run ${allowed
      .map((candidate) => JSON.stringify(candidate))
      .join(' or ')}`,
  );
}

// ---------------------------------------------------------------------------
// Sanitized environment and neutral working directory
// ---------------------------------------------------------------------------

/**
 * Variables forwarded to a probe. Provider credentials are deliberately absent:
 * a status probe reads the runtime's own login state, and nothing in discovery
 * needs an API key. TERM/NO_COLOR keep the output plain and parseable.
 */
export const PROBE_ENV_ALLOWLIST: ReadonlyArray<string> = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];

export function sanitizedProbeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  env['TERM'] = 'dumb';
  env['NO_COLOR'] = '1';
  return env;
}

/** Create a neutral temporary directory, run `fn` in it, then remove it. */
export async function withNeutralCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workforce-probe-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The real spawner
// ---------------------------------------------------------------------------

function truncate(chunks: ReadonlyArray<Buffer>, limit: number): string {
  const joined = Buffer.concat(chunks as Buffer[]);
  return joined.length <= limit ? joined.toString('utf8') : `${joined.subarray(0, limit).toString('utf8')}\n[output truncated at ${limit} bytes]`;
}

export const nodeProbeSpawner: ProbeSpawner = (command) =>
  new Promise<ProbeResult>((resolve) => {
    const startedAt = Date.now();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, pid: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(graceTimer);
      clearTimeout(forceTimer);
      resolve({
        command,
        stdout: truncate(stdout, PROBE_MAX_OUTPUT_BYTES),
        stderr: truncate(stderr, PROBE_MAX_OUTPUT_BYTES),
        exitCode,
        signal,
        timedOut,
        spawnError,
        pid,
        durationMs: Date.now() - startedAt,
      });
    };

    let deadline: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    let child;
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: { ...command.env },
        shell: false,
        // Own process group, so a timeout can terminate the whole tree.
        detached: true,
        // stdin closed: a probe can never be handed input, and cannot block on a prompt.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = (error as Error).message;
      finish(null, null, null);
      return;
    }

    const pid = child.pid ?? null;

    const killGroup = (signal: NodeJS.Signals): void => {
      if (pid === null) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          /* already gone */
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= PROBE_MAX_OUTPUT_BYTES) return;
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= PROBE_MAX_OUTPUT_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null, pid);
    });
    child.on('close', (code, signal) => finish(code, signal, pid));

    deadline = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        killGroup('SIGKILL');
        // Pipes may still be held by a grandchild; do not wait for `close` forever.
        forceTimer = setTimeout(() => finish(null, 'SIGKILL', pid), 250);
      }, PROBE_KILL_GRACE_MS);
    }, command.timeoutMs);
  });

/** Build a probe command after checking the argv against the documented list. */
export function probeCommand(
  adapter: DiscoverableAdapter,
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number } = {},
): ProbeCommand {
  assertDocumentedProbeArgv(adapter, args);
  return { executable, args: [...args], cwd, env: options.env ?? sanitizedProbeEnv(), timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS };
}
