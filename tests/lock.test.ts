import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStateStore } from '../src/storage/db.js';
import { LockHeldError, LockLostError, acquireCoordinatorLock, classifyHolder, lockArbiterPath, parseElapsed, readLockInfo, type LockInfo } from '../src/storage/lock.js';
import { createStatePaths } from '../src/storage/paths.js';
import { nowIso } from '../src/core/ids.js';
import { tempDir } from './helpers/state.js';

const HELPER = path.resolve('tests/helpers/hold-lock.ts');
const RACER = path.resolve('tests/helpers/race-lock.ts');
const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function spawnHolder(lockPath: string): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, ['--import', 'tsx', HELPER, lockPath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  children.push(child);
  const pid = await new Promise<number>((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      err += chunk;
    });
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      const match = /HELD (\d+)/.exec(out);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`holder exited early with ${code}: ${err}`)));
  });
  return { child, pid };
}

describe('coordinator lock', () => {
  it('blocks a second mutating coordinator while the holder is alive, allows read-only access, and reclaims a dead holder', async () => {
    const root = tempDir();
    roots.push(root);
    const paths = createStatePaths(root);
    // Create the state once so a read-only opener has something to read.
    openStateStore(paths, { mode: 'mutating' }).close();
    expect(existsSync(paths.lockPath)).toBe(false);

    const { child, pid } = await spawnHolder(paths.lockPath);
    const holder = readLockInfo(paths.lockPath);
    expect(holder?.pid).toBe(pid);
    expect(holder?.hostname).toBe(os.hostname());
    expect(classifyHolder(holder!)).toBe('alive');

    expect(() => acquireCoordinatorLock(paths.lockPath)).toThrow(LockHeldError);
    expect(() => openStateStore(paths, { mode: 'mutating' })).toThrow(/held by pid/);

    const reader = openStateStore(paths, { mode: 'read-only' });
    expect(reader.lock).toBeNull();
    expect(reader.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    reader.close();
    expect(readLockInfo(paths.lockPath)?.token).toBe(holder!.token); // untouched by the reader

    // Kill the holder without giving it a chance to release: the stale file must be reclaimed by identity, not by timeout.
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(existsSync(paths.lockPath)).toBe(true);
    expect(classifyHolder(holder!)).toBe('dead');

    const mine = acquireCoordinatorLock(paths.lockPath);
    expect(mine.info.pid).toBe(process.pid);
    expect(readLockInfo(paths.lockPath)?.token).toBe(mine.info.token);
    mine.release();
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('does not treat a reused pid as the live holder and never releases someone else\'s lock', () => {
    const root = tempDir();
    roots.push(root);
    const lockPath = path.join(root, 'coordinator.lock');
    const mine = acquireCoordinatorLock(lockPath);
    const info = readLockInfo(lockPath)!;
    expect(classifyHolder(info)).toBe('alive');
    expect(classifyHolder({ ...info, processStartedAtMs: info.processStartedAtMs! - 86_400_000 })).toBe('pid_reused');
    expect(classifyHolder({ ...info, hostname: `${info.hostname}-elsewhere` })).toBe('unverifiable');

    // A second handle for the same file whose token no longer matches must not delete the current lock.
    const stale = { ...mine, info: { ...mine.info, token: 'not-the-token-anymore' } };
    acquireCoordinatorLockRelease(stale);
    expect(existsSync(lockPath)).toBe(true);
    mine.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a second acquisition from the same process and never deletes the arbiter file', () => {
    const root = tempDir();
    roots.push(root);
    const lockPath = path.join(root, 'coordinator.lock');
    const mine = acquireCoordinatorLock(lockPath);
    expect(() => acquireCoordinatorLock(lockPath)).toThrow(/held by pid/);
    expect(readLockInfo(lockPath)?.token).toBe(mine.info.token); // the loser did not disturb the holder's info
    mine.release();
    mine.release(); // idempotent
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(lockArbiterPath(lockPath))).toBe(true);
    const again = acquireCoordinatorLock(lockPath);
    expect(again.info.token).not.toBe(mine.info.token);
    again.release();
  });

  it('lets exactly one of several concurrent coordinators win a lock left behind by a dead holder', async () => {
    const root = tempDir();
    roots.push(root);
    const lockPath = path.join(root, 'coordinator.lock');
    // A stale info file from a coordinator that died without releasing (its pid is provably gone).
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', shell: false });
    await new Promise((resolve) => dead.once('exit', resolve));
    const stale: LockInfo = { lockVersion: 1, pid: dead.pid!, processStartedAtMs: Date.now() - 3_600_000, hostname: os.hostname(), token: 'deadbeefdeadbeef', acquiredAt: nowIso(Date.now() - 3_600_000) };
    writeFileSync(lockPath, `${JSON.stringify(stale)}\n`);
    expect(classifyHolder(stale)).toBe('dead');

    const racers = await Promise.all(Array.from({ length: 5 }, () => spawnRacer(lockPath)));
    for (const racer of racers) racer.child.stdin!.write('GO\n');
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));
    const winners = outcomes.filter((o) => o.startsWith('WON'));
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((o) => o.startsWith('LOST'))).toHaveLength(4);
    expect(outcomes.filter((o) => o.startsWith('LOST error'))).toEqual([]);

    const winnerPid = Number(winners[0]!.split(' ')[1]);
    const info = readLockInfo(lockPath);
    expect(info?.pid).toBe(winnerPid);
    expect(info?.token).not.toBe(stale.token);
    expect(() => acquireCoordinatorLock(lockPath)).toThrow(/held by pid/);

    // Killing the winner without cleanup frees the lock immediately; nothing has to be reclaimed by path.
    const winner = racers.find((r) => r.child.pid === winnerPid)!;
    winner.child.kill('SIGKILL');
    await new Promise((resolve) => winner.child.once('exit', resolve));
    const mine = acquireCoordinatorLock(lockPath);
    expect(mine.info.pid).toBe(process.pid);
    mine.release();
  });

  it('refuses to become a second coordinator when the arbiter file is deleted under a live holder', async () => {
    const root = tempDir();
    roots.push(root);
    const paths = createStatePaths(root);
    openStateStore(paths, { mode: 'mutating' }).close();

    const { child } = await spawnHolder(paths.lockPath);
    const holder = readLockInfo(paths.lockPath)!;
    expect(classifyHolder(holder)).toBe('alive');

    // Anything with write access to the state root can unlink the arbiter — a
    // temp cleaner, or (until FR042 lands) a repository test. The kernel lock
    // lives on the inode, so a fresh file would be uncontended.
    rmSync(lockArbiterPath(paths.lockPath), { force: true });

    expect(() => acquireCoordinatorLock(paths.lockPath)).toThrow(LockHeldError);
    expect(() => acquireCoordinatorLock(paths.lockPath)).toThrow(/was replaced or removed while that coordinator was running/);
    expect(() => openStateStore(paths, { mode: 'mutating' })).toThrow(/held by pid/);
    // The live holder's own record is untouched by the refusal.
    expect(readLockInfo(paths.lockPath)?.token).toBe(holder.token);

    // Once that coordinator is really gone, the state root is available again.
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const mine = acquireCoordinatorLock(paths.lockPath);
    expect(mine.info.pid).toBe(process.pid);
    mine.release();
  });

  it('reports that ownership can no longer be proved once its arbiter is replaced', () => {
    const root = tempDir();
    roots.push(root);
    const lockPath = path.join(root, 'coordinator.lock');
    const mine = acquireCoordinatorLock(lockPath);
    expect(mine.verifyOwnership().status).toBe('held');
    expect(() => mine.assertOwnership()).not.toThrow();

    rmSync(lockArbiterPath(lockPath), { force: true });
    expect(mine.verifyOwnership().status).toBe('arbiter_missing');
    expect(() => mine.assertOwnership()).toThrow(LockLostError);

    // A different coordinator recreating the arbiter is just as detectable.
    acquireCoordinatorLock(`${lockPath}.other`).release();
    writeFileSync(lockArbiterPath(lockPath), '');
    expect(mine.verifyOwnership().status).toBe('arbiter_replaced');
    mine.release();
  });

  it('parses ps elapsed-time formats', () => {
    expect(parseElapsed('00:05')).toBe(5_000);
    expect(parseElapsed('01:02:03')).toBe(3_723_000);
    expect(parseElapsed('2-01:02:03')).toBe(2 * 86_400_000 + 3_723_000);
    expect(parseElapsed('garbage')).toBeNull();
  });
});

async function spawnRacer(lockPath: string): Promise<{ child: ChildProcess; outcome: Promise<string> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', RACER, lockPath], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    err += chunk;
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout!.on('data', (chunk: string) => {
    out += chunk;
    const parts = out.split('\n');
    out = parts.pop() ?? '';
    for (const line of parts) {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const queued = lines.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      waiters.push(resolve);
      child.once('exit', (code) => reject(new Error(`racer exited early with ${code}: ${err}`)));
    });
  expect(await nextLine()).toBe('READY');
  return { child, outcome: nextLine() };
}

function acquireCoordinatorLockRelease(lock: { path: string; info: { token: string } }): void {
  // Mirror of CoordinatorLock.release semantics for a handle with a foreign token.
  const current = readLockInfo(lock.path);
  if (current !== null && current.token === lock.info.token) rmSync(lock.path);
}
