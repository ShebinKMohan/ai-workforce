import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandResume } from '../../src/cli/commands/resume.js';
import { CliError, EXIT_CODES } from '../../src/cli/output.js';
import { acquireCoordinatorLock } from '../../src/storage/lock.js';
import { WORKER_PROCESS, openTempState, seedCrashedRun, type TempState } from './support.js';

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

    const result = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: dead });
    expect(result.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.data['runId']).toBe(crashed.run.id);
    const plan = result.data['plan'] as Record<string, unknown>;
    expect(plan['blocked']).toBe(false);
    expect(result.lines.some((line) => line.includes('replace'))).toBe(true);
  });

  it('exits 3 with the specific action when an interrupted attempt is ambiguous', async () => {
    const crashed = seedCrashedRun(state, { dispatched: true, running: true, process: WORKER_PROCESS });
    state.store.close();

    const result = await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: alive });
    expect(result.exitCode).toBe(EXIT_CODES.userActionRequired);
    expect((result.data['plan'] as Record<string, unknown>)['blocked']).toBe(true);
    expect(result.lines.some((line) => line.startsWith('action required:'))).toBe(true);
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
    await commandResume({ positionals: [crashed.run.id], stateDir: state.root, json: false }, { probeProcess: dead });
    const lock = acquireCoordinatorLock(state.paths.lockPath);
    lock.release();
  });
});
