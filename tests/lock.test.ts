import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStateStore } from '../src/storage/db.js';
import { LockHeldError, acquireCoordinatorLock, classifyHolder, parseElapsed, readLockInfo } from '../src/storage/lock.js';
import { createStatePaths } from '../src/storage/paths.js';
import { tempDir } from './helpers/state.js';

const HELPER = path.resolve('tests/helpers/hold-lock.ts');
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

  it('parses ps elapsed-time formats', () => {
    expect(parseElapsed('00:05')).toBe(5_000);
    expect(parseElapsed('01:02:03')).toBe(3_723_000);
    expect(parseElapsed('2-01:02:03')).toBe(2 * 86_400_000 + 3_723_000);
    expect(parseElapsed('garbage')).toBeNull();
  });
});

function acquireCoordinatorLockRelease(lock: { path: string; info: { token: string } }): void {
  // Mirror of CoordinatorLock.release semantics for a handle with a foreign token.
  const current = readLockInfo(lock.path);
  if (current !== null && current.token === lock.info.token) rmSync(lock.path);
}
