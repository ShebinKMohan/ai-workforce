import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskContractSchema, type Limits, type RunRequest, type TaskContract } from '../../src/core/contracts.js';
import { newId, nowIso } from '../../src/core/ids.js';
import { openStateStore, type StateStore } from '../../src/storage/db.js';
import { createStatePaths, type StatePaths } from '../../src/storage/paths.js';
import { insertRun, insertTask, type RunRow, type TaskRow } from '../../src/storage/records.js';

export const TEST_LIMITS: Limits = {
  maxActiveTurns: 2,
  maxActiveWriters: 2,
  maxTasksPerRun: 8,
  maxDelegationDepth: 2,
  maxRepairAttempts: 2,
  maxTransientRetries: 2,
  runTimeoutMinutes: 30,
};

export function tempDir(prefix = 'workforce-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TempState {
  readonly root: string;
  readonly paths: StatePaths;
  readonly store: StateStore;
  cleanup(): void;
}

export function openTempState(): TempState {
  const root = tempDir();
  const paths = createStatePaths(root);
  const store = openStateStore(paths, { mode: 'mutating' });
  return {
    root,
    paths,
    store,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function sampleRequest(runId: string = newId()): RunRequest {
  return { requestVersion: 1, runId, text: 'Fix the failing login test', contextRefs: [], repoPath: '/tmp/repo', baseMode: 'head', submittedAt: nowIso() };
}

export function sampleContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return TaskContractSchema.parse({
    contractVersion: 1,
    objective: 'Make the login test pass',
    scope: { allowedPaths: ['src/'] },
    acceptanceCriteria: [{ id: 'tests-pass', description: 'npm test passes', check: { command: 'npm', args: ['test'] } }],
    ...overrides,
  });
}

export function seedRunAndTask(state: TempState): { run: RunRow; task: TaskRow } {
  const run = insertRun(state.store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS });
  const task = insertTask(state.store.db, { runId: run.id, contract: sampleContract() });
  return { run, task };
}
