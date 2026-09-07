/**
 * Coordinator lock: one mutating coordinator per state root.
 *
 * The lock file records pid, process start time, hostname, a random token
 * and the acquisition time. Ownership is judged by process identity (pid AND
 * start time on the same host), never by a heartbeat timeout, so a live
 * coordinator can never have its ownership stolen. A stale lock (holder
 * provably dead, or pid reused by a process with a different start time) is
 * reclaimed. Read-only status inspection never touches this file.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { nowIso, randomToken } from '../core/ids.js';

export const LockInfoSchema = z.strictObject({
  lockVersion: z.literal(1),
  pid: z.number().int().positive(),
  /** Epoch milliseconds when the holder process started (as observed via `ps`); null when unobservable. */
  processStartedAtMs: z.number().int().nullable(),
  hostname: z.string().min(1),
  token: z.string().min(8),
  acquiredAt: z.string().datetime(),
});
export type LockInfo = z.infer<typeof LockInfoSchema>;

export class LockHeldError extends Error {
  readonly holder: LockInfo | null;
  readonly lockPath: string;

  constructor(lockPath: string, holder: LockInfo | null, reason: string) {
    super(
      holder === null
        ? `coordinator lock ${lockPath} is held (${reason}); remove it only if no coordinator is running`
        : `coordinator lock ${lockPath} is held by pid ${holder.pid} on ${holder.hostname} since ${holder.acquiredAt} (${reason}); use "workforce status" for read-only inspection`,
    );
    this.name = 'LockHeldError';
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

export interface CoordinatorLock {
  readonly path: string;
  readonly info: LockInfo;
  /** Remove the lock file if it still carries our token. Idempotent. */
  release(): void;
}

/** Start-time tolerance: `ps` reports elapsed time with one-second granularity. */
export const START_TIME_TOLERANCE_MS = 10_000;

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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type HolderStatus = 'alive' | 'dead' | 'pid_reused' | 'unverifiable';

/** Decide whether the recorded holder still owns the lock. Unverifiable holders are treated as alive. */
export function classifyHolder(info: LockInfo, now: number = Date.now()): HolderStatus {
  if (info.hostname !== os.hostname()) return 'unverifiable';
  if (!isProcessAlive(info.pid)) return 'dead';
  if (info.processStartedAtMs === null) return 'unverifiable';
  const observed = observeProcessStartMs(info.pid, now);
  if (observed === null) return 'unverifiable';
  return Math.abs(observed - info.processStartedAtMs) <= START_TIME_TOLERANCE_MS ? 'alive' : 'pid_reused';
}

export function readLockInfo(lockPath: string): LockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return LockInfoSchema.parse(JSON.parse(raw));
  } catch {
    return null; // unreadable content: treated as held-by-unknown by the caller
  }
}

function writeExclusive(lockPath: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface AcquireLockOptions {
  readonly pid?: number;
  readonly now?: number;
}

/** Acquire the coordinator lock or throw `LockHeldError`. Never waits: callers decide about retrying. */
export function acquireCoordinatorLock(lockPath: string, options: AcquireLockOptions = {}): CoordinatorLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const info: LockInfo = {
    lockVersion: 1,
    pid,
    processStartedAtMs: observeProcessStartMs(pid, now),
    hostname: os.hostname(),
    token: randomToken(16),
    acquiredAt: nowIso(now),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (writeExclusive(lockPath, info)) {
      let released = false;
      return {
        path: lockPath,
        info,
        release: () => {
          if (released) return;
          released = true;
          const current = readLockInfo(lockPath);
          if (current !== null && current.token === info.token) {
            try {
              unlinkSync(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        },
      };
    }

    const holder = readLockInfo(lockPath);
    if (holder === null) throw new LockHeldError(lockPath, null, 'lock file exists but is unreadable');
    const status = classifyHolder(holder, now);
    if (status === 'alive') throw new LockHeldError(lockPath, holder, 'holder process is alive');
    if (status === 'unverifiable') throw new LockHeldError(lockPath, holder, 'holder liveness cannot be verified from this host');
    // dead or pid reused: reclaim only the exact file we inspected
    try {
      const recheck = readLockInfo(lockPath);
      if (recheck !== null && recheck.token === holder.token) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new LockHeldError(lockPath, readLockInfo(lockPath), 'could not reclaim a stale lock after repeated attempts');
}
