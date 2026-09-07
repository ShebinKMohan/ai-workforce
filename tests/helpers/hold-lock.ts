// Child process used by lock.test.ts: acquire the coordinator lock and hold it until stdin closes or SIGTERM.
import { acquireCoordinatorLock } from '../../src/storage/lock.js';

const lockPath = process.argv[2];
if (lockPath === undefined) {
  process.stderr.write('usage: hold-lock <lock-path>\n');
  process.exit(2);
}
const lock = acquireCoordinatorLock(lockPath);
process.stdout.write(`HELD ${process.pid}\n`);
const release = (): void => {
  lock.release();
  process.exit(0);
};
process.stdin.resume();
process.stdin.on('end', release);
process.on('SIGTERM', release);
