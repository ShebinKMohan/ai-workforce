import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandResume } from '../../src/cli/commands/resume.js';
import { CliError, EXIT_CODES } from '../../src/cli/output.js';
import { openStateStore } from '../../src/storage/db.js';
import { acquireCoordinatorLock } from '../../src/storage/lock.js';
import { getRun, getTask, insertAttempt, insertTask } from '../../src/storage/records.js';
import { listRunAttempts } from '../../src/recovery/reconcile.js';
import { sampleContract } from '../helpers/state.js';
import { WORKER_PROCESS, openTempState, seedCrashedRun, snapshotHash, type TempState } from './support.js';

let state: TempState;
beforeEach(() => {
  state = openTempState();
});
afterEach(() => {
  state.cleanup();
});

const dead = () => 'dead' as const;
const alive = () => 'alive' as const;

describe('workforce resume', () => {
  it('reconciles under exclusive ownership and exits 0 when nothing is blocked', async () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    state.store.close(); // the crashed coordinator is gone; its lock is released

    const result = await commandResume(
      { positionals: [crashed.run.id], stateDir: state.root, json: false },
      { probeProcess: dead, continue: () => ({ command: 'resume', exitCode: EXIT_CODES.verifiedCandidate, data: {}, lines: [] }) },
    );
    expect(result.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.data['runId']).toBe(crashed.run.id);
    const plan = result.data['plan'] as Record<string, unknown>;
    expect(plan['blocked']).toBe(false);
    expect(result.lines.some((line) => line.includes('replace'))).toBe(true);
  });

  it('refuses to mint a generation for a run it has no configuration to continue', async () => {
    // The seeded run has no configuration snapshot, so there is nothing to
    // bind a continued attempt to. Refusing BEFORE reconciliation mints
    // anything is the point: a resume that continues nothing must leave no
    // trace of a generation nobody will ever dispatch.
    const crashed = seedCrashedRun(state, { dispatched: false });
    const before = {
      generation: getTask(state.store.db, crashed.task.id).current_generation,
      attempts: listRunAttempts(state.store.db, crashed.run.id).length,
      runState: getRun(state.store.db, crashed.run.id).state,
      epoch: getRun(state.store.db, crashed.run.id).ownership_epoch,
    };
    state.store.close();

    const error = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: dead }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODES.userActionRequired);
    expect((error as CliError).code).toBe('configuration_unavailable');

    const store = openStateStore(state.paths, { mode: 'read-only' });
    try {
      expect(getTask(store.db, crashed.task.id).current_generation).toBe(before.generation);
      expect(listRunAttempts(store.db, crashed.run.id)).toHaveLength(before.attempts);
      expect(getRun(store.db, crashed.run.id).state).toBe(before.runState);
      expect(getRun(store.db, crashed.run.id).ownership_epoch).toBe(before.epoch);
    } finally {
      store.close();
    }
  });

  it('exits 3 with the specific action when an interrupted attempt is ambiguous', async () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    state.store.close();

    const result = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: alive });
    expect(result.exitCode).toBe(EXIT_CODES.userActionRequired);
    expect((result.data['plan'] as Record<string, unknown>)['blocked']).toBe(true);
    expect(result.lines.some((line) => line.startsWith('action required:'))).toBe(true);
  });

  it('mints nothing for a sibling task while another attempt is ambiguous, however often it is resumed', async () => {
    // A blocked run continues nothing, so it must replace nothing either.
    // Burning a generation for the sibling on every call is how repeated
    // resumes used to leave a trail of attempts nobody ever dispatched.
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    const db = state.store.db;
    const sibling = insertTask(db, { runId: crashed.run.id, contract: sampleContract({ objective: 'The sibling task' }) });
    insertAttempt(db, { taskId: sibling.id, agentSnapshotHash: snapshotHash(state), runtimeId: 'codex-local' });
    state.store.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: alive });
      expect(result.exitCode).toBe(EXIT_CODES.userActionRequired);
      const store = openStateStore(state.paths, { mode: 'read-only' });
      try {
        expect(getTask(store.db, sibling.id).current_generation).toBe(1);
        expect(getTask(store.db, crashed.task.id).current_generation).toBe(1);
        expect(listRunAttempts(store.db, crashed.run.id)).toHaveLength(2);
        expect(getRun(store.db, crashed.run.id).state).toBe('interrupted');
      } finally {
        store.close();
      }
    }
  });

  it('exits 2 for a missing run id and for an unknown run', async () => {
    state.store.close();
    await expect(commandResume({ positionals: [], stateDir: state.root, json: false })).rejects.toMatchObject({ exitCode: EXIT_CODES.invalidInput });
    await expect(commandResume({ positionals: ['nope'], stateDir: state.root, json: false })).rejects.toMatchObject({
      exitCode: EXIT_CODES.invalidInput,
      code: 'unknown_run',
    });
  });

  it('exits 3 rather than becoming a second coordinator when the state root is owned', async () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    // state.store still holds the coordinator lock.
    const error = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: dead }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODES.userActionRequired);
    expect((error as CliError).code).toBe('ownership_unavailable');
  });

  it('hands an unblocked plan to the injected continuation under the same ownership', async () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    state.store.close();

    let sawLock = false;
    const result = await commandResume(
      { positionals: [crashed.run.id], stateDir: state.root, json: false },
      {
        probeProcess: dead,
        continue: (plan, store) => {
          sawLock = store.mode === 'mutating' && store.lock !== null;
          return { command: 'resume', exitCode: EXIT_CODES.verifiedCandidate, data: { continuedSteps: plan.steps.length }, lines: ['continued'] };
        },
      },
    );
    expect(sawLock).toBe(true);
    expect(result.data['continued']).toBe(true);
    expect(result.data['continuedSteps']).toBe(1);
  });

  it('releases ownership when it is done, so a second resume can take it', async () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    state.store.close();
    await commandResume(
      { positionals: [crashed.run.id], stateDir: state.root, json: false },
      { probeProcess: dead, continue: () => ({ command: 'resume', exitCode: EXIT_CODES.verifiedCandidate, data: {}, lines: [] }) },
    );
    const lock = acquireCoordinatorLock(state.paths.lockPath);
    lock.release();
  });

  it('releases ownership even when it refuses, so the refusal does not strand the state root', async () => {
    const crashed = seedCrashedRun(state, { dispatched: false });
    state.store.close();
    await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: dead }).catch(() => undefined);
    const lock = acquireCoordinatorLock(state.paths.lockPath);
    lock.release();
  });
});
