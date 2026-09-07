// AT09 support probe: the scheduler unit in isolation (no runtimes involved).
// Shows what the scheduler alone would allow, independently of whether the
// orchestrator can express dependencies or run tasks concurrently.
import { createScheduler } from '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/routing/schedule.js';
const s = createScheduler(
  [
    { id: 'fast-prereq', writer: true },
    { id: 'dependent', writer: true, dependencies: [{ taskId: 'fast-prereq', kind: 'completion' }] },
    { id: 'slow-unrelated', writer: true },
  ],
  { maxActiveTurns: 2, maxActiveWriters: 2 },
);
const log = [];
log.push({ step: 'dispatch#1', tasks: s.dispatch(), activeTurns: s.activeTurns, activeWriters: s.activeWriters });
log.push({ step: 'dispatch#2 (nothing new: caps are full)', tasks: s.dispatch(), activeTurns: s.activeTurns });
s.complete('fast-prereq');
log.push({ step: 'after fast-prereq completes, slow-unrelated still active', activeTurns: s.activeTurns });
log.push({ step: 'dispatch#3', tasks: s.dispatch(), activeTurns: s.activeTurns, activeWriters: s.activeWriters });
console.log(JSON.stringify(log, null, 2));
