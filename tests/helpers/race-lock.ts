// Child process used by lock.test.ts: wait for "GO" on stdin, then race for the coordinator lock.
// Prints WON or LOST <reason>; a winner holds the lock until stdin closes or SIGTERM.
import { createInterface } from 'node:readline';
import { LockHeldError, acquireCoordinatorLock } from '../../src/storage/lock.js';

const lockPath = process.argv[2];
if (lockPath === undefined) {
  process.stderr.write('usage: race-lock <lock-path>\n');
  process.exit(2);
}

const rl = createInterface({ input: process.stdin });
process.stdout.write('READY\n');
rl.once('line', (line) => {
  if (line.trim() !== 'GO') {
    process.stderr.write(`unexpected input ${line}\n`);
    process.exit(2);
  }
  let lock;
  try {
    lock = acquireCoordinatorLock(lockPath);
  } catch (error) {
    const reason = error instanceof LockHeldError ? `held holder=${error.holder?.pid ?? 'none'}` : `error ${(error as Error).message}`;
    process.stdout.write(`LOST ${reason}\n`);
    process.exit(0);
  }
  process.stdout.write(`WON ${process.pid}\n`);
  const release = (): void => {
    lock.release();
    process.exit(0);
  };
  rl.once('close', release);
  process.on('SIGTERM', release);
});
