/**
 * Coordinator lock: one mutating coordinator per state root.
 *
 * Ownership is arbitrated by the kernel, not by a file that has to be
 * unlinked by path: `<lock>.sqlite` is a tiny SQLite database and the holder
 * keeps a `BEGIN IMMEDIATE` transaction open on it for its whole lifetime.
 * SQLite implements that transaction with an OS file lock, so a second
 * coordinator (another process or another connection in this process) gets
 * SQLITE_BUSY immediately, and the lock disappears the instant the holder
 * dies, even from SIGKILL. There is no stale lock to reclaim and therefore no
 * reclaim race.
 *
 * The kernel lock lives on the *inode*, not on the path, so that argument
 * holds only while the path still names the inode the holder locked. If the
 * arbiter file is unlinked — by a temp cleaner, or by anything with write
 * access to the state root — a later coordinator would create a fresh inode
 * and take an uncontended lock on it. Two defences close that gap:
 *
 * - acquisition refuses when the info file left behind names a coordinator
 *   process that is still alive (or whose liveness cannot be checked). That
 *   file is written by the winner and removed on release, so its presence
 *   next to an uncontended arbiter means the arbiter is not the one the live
 *   holder locked;
 * - `verifyOwnership` compares the arbiter path's current inode with the one
 *   this lock took, so a holder can find out that its arbiter was replaced
 *   instead of continuing to believe it owns the state root.
 *
 * `<lock>` itself (`coordinator.lock`) is the human-readable companion the
 * winner writes after winning: pid, process start time, hostname, a random
 * token and the acquisition time. It is what "held by pid N" diagnostics and
 * `readLockInfo` read; it is never what decides ownership. The arbiter file
 * is never deleted: unlinking a file another process may have open would
 * silently detach that process's lock.
 *
 * Read-only status inspection never touches either file.
 */
import { closeSync, fsyncSync, openSync, renameSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { nowIso, randomToken } from '../core/ids.js';
import { START_TIME_TOLERANCE_MS, isProcessAlive, matchProcessIdentity, observeProcessStartMs, parseElapsed, type ProcessIdentityStatus } from '../core/process.js';

export { START_TIME_TOLERANCE_MS, isProcessAlive, observeProcessStartMs, parseElapsed };

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
        ? `coordinator lock ${lockPath} is held by another coordinator (${reason}); use "workforce status" for read-only inspection`
        : `coordinator lock ${lockPath} is held by pid ${holder.pid} on ${holder.hostname} since ${holder.acquiredAt} (${reason}); use "workforce status" for read-only inspection`,
    );
    this.name = 'LockHeldError';
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

export type OwnershipStatus = 'held' | 'arbiter_replaced' | 'arbiter_missing' | 'info_replaced' | 'released';

export interface OwnershipCheck {
  readonly status: OwnershipStatus;
  readonly detail: string;
}

export class LockLostError extends Error {
  readonly status: OwnershipStatus;

  constructor(lockPath: string, check: OwnershipCheck) {
    super(`coordinator ownership of ${lockPath} can no longer be proved (${check.status}): ${check.detail}`);
    this.name = 'LockLostError';
    this.status = check.status;
  }
}

export interface CoordinatorLock {
  readonly path: string;
  readonly info: LockInfo;
  /**
   * Re-check that this lock still arbitrates the state root: the arbiter path
   * must still name the inode we locked, and the info file must still carry
   * our token. A caller uses this at points where acting on a stale belief
   * would be expensive — before dispatching a worker, before writing a result.
   */
  verifyOwnership(): OwnershipCheck;
  /** `verifyOwnership`, but throws `LockLostError` when ownership cannot be proved. */
  assertOwnership(): void;
  /** Release ownership (closes the arbiter connection) and remove the info file if it still carries our token. Idempotent. */
  release(): void;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function fileIdentity(target: string): FileIdentity | null {
  try {
    const stats = statSync(target);
    return { dev: Number(stats.dev), ino: Number(stats.ino) };
  } catch {
    return null;
  }
}

/** Path of the kernel-arbitrated lock database that sits beside the info file. */
export function lockArbiterPath(lockPath: string): string {
  return `${lockPath}.sqlite`;
}

export type HolderStatus = ProcessIdentityStatus;

/** Decide whether the recorded holder process still exists. Unverifiable holders are treated as alive by callers. */
export function classifyHolder(info: LockInfo, now: number = Date.now()): HolderStatus {
  if (info.hostname !== os.hostname()) return 'unverifiable';
  return matchProcessIdentity({ pid: info.pid, startedAtMs: info.processStartedAtMs }, now);
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

const SQLITE_BUSY = 5;

function isBusy(error: unknown): boolean {
  const err = error as { errcode?: unknown; message?: unknown };
  return err.errcode === SQLITE_BUSY || (typeof err.message === 'string' && /database is locked/i.test(err.message));
}

/** Open the arbiter and take the write lock, or return null when another coordinator holds it. Never waits. */
function tryOpenArbiter(lockPath: string): DatabaseSync | null {
  const db = new DatabaseSync(lockArbiterPath(lockPath), { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db.close();
    if (isBusy(error)) return null;
    throw error;
  }
}

/** Replace the info file atomically: the arbiter already decided ownership, so no O_EXCL is needed here. */
function writeInfo(lockPath: string, info: LockInfo): void {
  const tempPath = `${lockPath}.${info.token}.tmp`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, lockPath);
}

export interface AcquireLockOptions {
  readonly pid?: number;
  readonly now?: number;
}

/** Acquire the coordinator lock or throw `LockHeldError`. Never waits: callers decide about retrying. */
export function acquireCoordinatorLock(lockPath: string, options: AcquireLockOptions = {}): CoordinatorLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();

  const arbiter = tryOpenArbiter(lockPath);
  if (arbiter === null) {
    const holder = readLockInfo(lockPath);
    if (holder === null) throw new LockHeldError(lockPath, null, 'the holder has not recorded its identity yet');
    const status = classifyHolder(holder, now);
    const reason =
      status === 'alive'
        ? 'holder process is alive'
        : status === 'unverifiable'
          ? 'holder liveness cannot be verified from this host'
          : 'the recorded holder is gone; a newer coordinator holds the lock and has not recorded its identity yet';
    throw new LockHeldError(lockPath, holder, reason);
  }

  // Winning an uncontended arbiter is not proof that nobody owns this state
  // root: the arbiter file may have been unlinked out from under a live
  // coordinator, which would leave that coordinator holding a lock on an inode
  // no longer reachable by path. The info file is the surviving witness.
  const previous = readLockInfo(lockPath);
  if (previous !== null && !(previous.pid === pid && previous.hostname === os.hostname())) {
    const status = classifyHolder(previous, now);
    if (status === 'alive' || status === 'unverifiable') {
      arbiter.close();
      throw new LockHeldError(
        lockPath,
        previous,
        status === 'alive'
          ? `the arbiter database ${lockArbiterPath(lockPath)} was replaced or removed while that coordinator was running, so winning it proves nothing; refusing rather than becoming a second mutating coordinator`
          : `the arbiter database ${lockArbiterPath(lockPath)} is uncontended but the recorded holder's liveness cannot be verified from this host; if that coordinator is gone, delete ${lockPath} and retry`,
      );
    }
  }

  const arbiterIdentity = fileIdentity(lockArbiterPath(lockPath));

  const info: LockInfo = {
    lockVersion: 1,
    pid,
    processStartedAtMs: observeProcessStartMs(pid, now),
    hostname: os.hostname(),
    token: randomToken(16),
    acquiredAt: nowIso(now),
  };
  try {
    writeInfo(lockPath, info);
  } catch (error) {
    arbiter.close();
    throw error;
  }

  let released = false;
  const verifyOwnership = (): OwnershipCheck => {
    if (released) return { status: 'released', detail: 'this lock handle was already released' };
    const current = fileIdentity(lockArbiterPath(lockPath));
    if (current === null) {
      return { status: 'arbiter_missing', detail: `${lockArbiterPath(lockPath)} no longer exists; this process still holds a lock on the deleted file, which no longer excludes anyone` };
    }
    if (arbiterIdentity !== null && (current.dev !== arbiterIdentity.dev || current.ino !== arbiterIdentity.ino)) {
      return { status: 'arbiter_replaced', detail: `${lockArbiterPath(lockPath)} is now a different file (inode ${current.ino}, was ${arbiterIdentity.ino}); another coordinator can lock it` };
    }
    const recorded = readLockInfo(lockPath);
    if (recorded === null || recorded.token !== info.token) {
      return { status: 'info_replaced', detail: `${lockPath} no longer records this coordinator's token` };
    }
    return { status: 'held', detail: `${lockPath} still records this coordinator and the arbiter is the file it locked` };
  };

  return {
    path: lockPath,
    info,
    verifyOwnership,
    assertOwnership: () => {
      const check = verifyOwnership();
      if (check.status !== 'held') throw new LockLostError(lockPath, check);
    },
    release: () => {
      if (released) return;
      released = true;
      try {
        // While we still hold the arbiter no other coordinator can have written its info, so this only ever removes ours.
        const current = readLockInfo(lockPath);
        if (current !== null && current.token === info.token) {
          try {
            unlinkSync(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      } finally {
        arbiter.close();
      }
    },
  };
}
