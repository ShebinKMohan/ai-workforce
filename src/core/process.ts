/**
 * Process identity beyond a reusable pid (plan section 8: "use a lock and
 * process identity including more than a reusable PID").
 *
 * A `ProcessIdentity` is the pid, the process start time observed via `ps`
 * and a random token minted by whoever spawned the process. The start time
 * detects pid reuse after the original process died; the spawn token gives
 * every spawned process instance a name that survives coordinator restarts,
 * so events and raw references from two processes driving the same runtime
 * session can never be confused with each other.
 */
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { randomToken } from './ids.js';

/** Start-time tolerance: `ps` reports elapsed time with one-second granularity. */
export const START_TIME_TOLERANCE_MS = 10_000;

export const ProcessIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  /** Epoch milliseconds when the process started (as observed via `ps`); null when unobservable. */
  startedAtMs: z.number().int().nullable(),
  /** Random token minted at spawn time; unique per spawned process instance. */
  spawnToken: z.string().min(8),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

/** Parse `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into milliseconds. */
export function parseElapsed(etime: string): number | null {
  const trimmed = etime.trim();
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match === null) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Observe a process start time via `ps`. Returns null when the process is gone or `ps` is unavailable. */
export function observeProcessStartMs(pid: number, now: number = Date.now()): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    const elapsed = parseElapsed(out);
    return elapsed === null ? null : now - elapsed;
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (EPERM means it exists but belongs to another user). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the process group still has members. */
export function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function newSpawnToken(): string {
  return randomToken(8);
}

/** Record the identity of a process we just spawned. Call immediately after spawn, while the pid is certainly ours. */
export function observeProcessIdentity(pid: number, spawnToken: string = newSpawnToken(), now: number = Date.now()): ProcessIdentity {
  return { pid, startedAtMs: observeProcessStartMs(pid, now), spawnToken };
}

/**
 * `alive`: the pid exists and its start time matches the recorded one.
 * `dead`: no process with that pid exists.
 * `pid_reused`: a process exists but started at a different time, so the recorded process is gone.
 * `unverifiable`: the pid exists but the start time cannot be compared; callers must not assume ownership.
 */
export type ProcessIdentityStatus = 'alive' | 'dead' | 'pid_reused' | 'unverifiable';

export function matchProcessIdentity(identity: Pick<ProcessIdentity, 'pid' | 'startedAtMs'>, now: number = Date.now()): ProcessIdentityStatus {
  if (!isProcessAlive(identity.pid)) return 'dead';
  if (identity.startedAtMs === null) return 'unverifiable';
  const observed = observeProcessStartMs(identity.pid, now);
  if (observed === null) return 'unverifiable';
  return Math.abs(observed - identity.startedAtMs) <= START_TIME_TOLERANCE_MS ? 'alive' : 'pid_reused';
}
