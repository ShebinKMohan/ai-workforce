import { readFileSync } from 'node:fs';
import { validateAgentConfig } from '../../src/core/contracts.js';
import { computeAgentSnapshot } from '../../src/core/snapshot.js';
import type { ProcessIdentity } from '../../src/core/process.js';
import { markDispatched, recordIntent, type OperationRecord } from '../../src/storage/operations.js';
import {
  insertAttempt,
  transitionAttempt,
  transitionRun,
  transitionTask,
  upsertAgentSnapshot,
  type AttemptRow,
  type RunRow,
  type TaskRow,
} from '../../src/storage/records.js';
import { openTempState, seedRunAndTask, type TempState } from '../helpers/state.js';

export { openTempState, type TempState };

export interface CrashedRun {
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly attempt: AttemptRow;
  readonly operation: OperationRecord;
}

export const WORKER_PROCESS: ProcessIdentity = { pid: 424242, startedAtMs: 1_700_000_000_000, spawnToken: 'spawn-token-1' };

export function snapshotHash(state: TempState): string {
  const config = validateAgentConfig(JSON.parse(readFileSync('fixtures/agents/example.json', 'utf8')));
  const snapshot = computeAgentSnapshot(config, 'engineer');
  upsertAgentSnapshot(state.store.db, snapshot);
  return snapshot.hash;
}

/**
 * Seed the exact shape a crashed coordinator leaves behind: intent recorded,
 * optionally dispatched, optionally a running attempt with a worker identity,
 * and never a receipt.
 */
export function seedCrashedRun(
  state: TempState,
  options: { dispatched?: boolean; running?: boolean; process?: ProcessIdentity | null; sessionId?: string | null } = {},
): CrashedRun {
  const db = state.store.db;
  const { run, task } = seedRunAndTask(state);
  const hash = snapshotHash(state);
  transitionRun(db, run.id, 'running');
  transitionTask(db, task.id, 'ready');
  const attempt = insertAttempt(db, { taskId: task.id, agentSnapshotHash: hash, runtimeId: 'codex-local', workspacePath: '/tmp/candidate' });
  const operation = recordIntent(db, { runId: run.id, taskId: task.id, attemptId: attempt.id, kind: 'dispatch_worker', intent: { adapter: 'codex' } });
  if (options.dispatched === true) {
    markDispatched(db, operation.id, { workspacePath: '/tmp/candidate' });
    transitionTask(db, task.id, 'running');
  }
  if (options.running === true) {
    transitionAttempt(db, attempt.id, 'running', {
      runtime: {
        sessionId: options.sessionId ?? 'session-1',
        turnId: 'turn-1',
        ...(options.process !== null && options.process !== undefined ? { process: options.process } : {}),
      },
    });
  }
  return { run, task, attempt, operation };
}
