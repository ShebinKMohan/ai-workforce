/**
 * AT07 — cancellation during editing, then an explicit resume that actually
 * continues the run.
 *
 * One narrative, in order, against the deterministic fake runtime: a real run
 * is interrupted mid-edit, so what it leaves behind is the real thing — a
 * checkpointed candidate, an interrupted attempt, a cancelled task and an
 * interrupted run. Then `resume` is asked to finish the job, and what it
 * produces has to be a run that reached a terminal state with exactly one
 * accepted writer and the earlier work still on the record.
 *
 * The steps share one run deliberately: each is the state the next one starts
 * from, which is what a resume actually has to cope with.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { commandResume } from '../../src/cli/commands/resume.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { computeAgentSnapshot } from '../../src/core/snapshot.js';
import { runDirect, type RunDirectInput, type RunDirectResult, type RunStream } from '../../src/core/run-direct.js';
import { continueResumedRun } from '../../src/recovery/continue-run.js';
import { resumeRun } from '../../src/recovery/resume.js';
import { listRunAttempts } from '../../src/recovery/reconcile.js';
import { listArtifacts, type ArtifactRecord } from '../../src/storage/artifacts.js';
import { listChecks } from '../../src/verification/checks.js';
import { openStateStore } from '../../src/storage/db.js';
import { listEvents } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import {
  getAttempt,
  getRun,
  getTask,
  insertAttempt,
  insertRun,
  insertTask,
  listTasks,
  transitionRun,
  transitionTask,
  upsertAgentSnapshot,
} from '../../src/storage/records.js';
import { openTempState, sampleContract, sampleRequest, TEST_LIMITS, type TempState } from '../helpers/state.js';
import {
  cleanupAll,
  fixTheBugScenario,
  longRunningScenario,
  tempDir,
  useFixture,
  writeFakeAgentsConfig,
  writeScenario,
} from '../workspaces/support.js';

afterAll(() => cleanupAll());

const CHECK = 'node --test test/';
const REQUEST_TEXT =
  'The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2 pages, so the last match is never shown. Find the cause and fix it.';

interface Interrupted {
  readonly repo: string;
  readonly stateRoot: string;
  readonly result: RunDirectResult;
}

function readState<T>(stateRoot: string, fn: (db: import('node:sqlite').DatabaseSync) => T): T {
  const store = openStateStore(createStatePaths(stateRoot), { mode: 'read-only' });
  try {
    return fn(store.db);
  } finally {
    store.close();
  }
}

function fixesTheBug(): { readonly sessionEnv: Readonly<Record<string, string>> } {
  return { sessionEnv: { [FAKE_SCENARIO_ENV]: writeScenario(fixTheBugScenario()) } };
}

/** Start a real direct run against the fake runtime and abort it mid-edit. */
async function interruptedRun(): Promise<Interrupted> {
  const fixture = await useFixture('ts-bug');
  const stateRoot = tempDir('workforce-state-');
  const configPath = writeFakeAgentsConfig(tempDir('workforce-config-'));
  const paths = createStatePaths(stateRoot);
  const store = openStateStore(paths, { mode: 'mutating' });
  const lines: string[] = [];
  const stream: RunStream = { line: (text) => lines.push(text), event: () => {} };
  const controller = new AbortController();
  // Abort once the worker has provably edited a file, so the interruption
  // lands mid-edit rather than before any work existed.
  void (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('src/pagination.js'))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    controller.abort();
  })();

  try {
    const loaded = loadAgentConfigFile(configPath);
    const result = await runDirect({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: REQUEST_TEXT,
      requestSource: 'argument',
      // The fixture's own check command, given as a flag rather than left to
      // resolve: acceptance from `--check` lives nowhere in the repository, so
      // it is the case a continued attempt has to recover from its contract.
      checkFlags: [CHECK],
      paths,
      db: store.db,
      stream,
      signal: controller.signal,
      sessionEnv: { [FAKE_SCENARIO_ENV]: writeScenario(longRunningScenario(30_000)) },
      ...(store.lock !== null ? { ownership: store.lock } : {}),
    });
    return { repo: fixture.path, stateRoot, result };
  } finally {
    // The coordinator that was interrupted is gone; its lock is released.
    store.close();
  }
}

describe('AT07: an interrupted run is continued by resume', () => {
  let run: Interrupted;
  let preservedArtifacts: ReadonlyArray<ArtifactRecord>;

  beforeAll(async () => {
    run = await interruptedRun();
  }, 120_000);

  it('leaves an interrupted run whose partial work is preserved and whose task is not accepted', () => {
    expect(run.result.outcome).toBe('interrupted');
    expect(run.result.acceptance.accepted).toBe(false);
    // The work the worker managed before the interruption is a real checkpoint.
    expect(run.result.snapshot?.checkpointCreated).toBe(true);
    preservedArtifacts = readState(run.stateRoot, (db) => {
      expect(getRun(db, run.result.runId).state).toBe('interrupted');
      expect(getTask(db, run.result.taskId).state).toBe('cancelled');
      expect(getAttempt(db, run.result.attemptId).state).toBe('interrupted');
      return listArtifacts(db, run.result.runId).filter((artifact) => artifact.attemptId === run.result.attemptId);
    });
    expect(preservedArtifacts.length).toBeGreaterThan(0);
  });

  it('continues the run to a terminal state with exactly one accepted writer', async () => {
    const resumed = await commandResume(
      // The fake runtime enforces no write boundary, so continuing a writing
      // profile on it needs the same explicit acknowledgement the run did.
      { positionals: [run.result.runId], stateDir: run.stateRoot, json: false, allowUnconfinedWrites: true },
      { continuation: fixesTheBug() },
    );

    expect(resumed.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(resumed.data['continued']).toBe(true);
    expect(resumed.data['status']).toBe('accepted');
    expect(resumed.data['runState']).toBe('ready_for_review');

    readState(run.stateRoot, (db) => {
      // The run reached a terminal state: nothing is left saying "running"
      // with nothing working on it.
      expect(getRun(db, run.result.runId).state).toBe('ready_for_review');
      const tasks = listTasks(db, run.result.runId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.state).toBe('accepted');

      // The pre-interruption attempt is preserved as history, superseded
      // rather than discarded, and its artifacts are still on the record.
      const attempts = listRunAttempts(db, run.result.runId);
      expect(attempts).toHaveLength(2);
      const original = getAttempt(db, run.result.attemptId);
      expect(original.state).toBe('superseded');
      expect(original.interrupted).toBe(1);
      const stillThere = listArtifacts(db, run.result.runId).filter((artifact) => artifact.attemptId === run.result.attemptId);
      expect(stillThere.map((artifact) => artifact.relativePath).sort()).toEqual(preservedArtifacts.map((artifact) => artifact.relativePath).sort());

      // Exactly one accepted writer: the continuation's attempt, in the new
      // generation, in its own workspace, and nothing else.
      const completed = attempts.filter((attempt) => attempt.state === 'completed');
      expect(completed).toHaveLength(1);
      const continued = completed[0]!;
      expect(continued.id).not.toBe(run.result.attemptId);
      expect(continued.generation).toBe(2);
      expect(continued.workspace_path).toBe(path.join(run.stateRoot, 'workspaces', run.result.runId, run.result.taskId, continued.id));
      expect(existsSync(path.dirname(continued.workspace_path!))).toBe(true);

      // Acceptance means the same thing across the interruption: the check
      // the run was started with, recovered from the persisted contract,
      // rather than whatever the project would resolve now.
      const executed = listChecks(db, run.result.runId).filter((check) => check.attempt_id === continued.id);
      expect(executed.map((check) => [check.command, ...(JSON.parse(check.args_json) as string[])].join(' '))).toEqual([CHECK]);

      const types = listEvents(db, run.result.runId).map((event) => event.type);
      expect(types).toContain('recovery.reconciled');
      expect(types).toContain('recovery.continuing');
      expect(types).toContain('recovery.continued');
    });
  }, 120_000);

  it('is idempotent: resuming the finished run mints no generation and flips no state', async () => {
    const before = readState(run.stateRoot, (db) => ({
      state: getRun(db, run.result.runId).state,
      epoch: getRun(db, run.result.runId).ownership_epoch,
      generation: getTask(db, run.result.taskId).current_generation,
      attempts: listRunAttempts(db, run.result.runId).map((attempt) => attempt.id),
    }));

    const again = await commandResume({ positionals: [run.result.runId], stateDir: run.stateRoot, json: false });
    expect(again.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect((again.data['plan'] as Record<string, unknown>)['complete']).toBe(true);
    expect(again.data['continued']).toBeUndefined();

    readState(run.stateRoot, (db) => {
      expect(getRun(db, run.result.runId).state).toBe(before.state);
      expect(getRun(db, run.result.runId).ownership_epoch).toBe(before.epoch);
      expect(getTask(db, run.result.taskId).current_generation).toBe(before.generation);
      expect(listRunAttempts(db, run.result.runId).map((attempt) => attempt.id)).toEqual(before.attempts);
    });
  });

  it('never re-dispatches or re-judges a task that was already accepted', async () => {
    // A coordinator that dies after acceptance leaves the run mid-flight with
    // the task already accepted. Resuming that must preserve the acceptance,
    // not race a second writer against it.
    const store = openStateStore(createStatePaths(run.stateRoot), { mode: 'mutating' });
    const accepted = listRunAttempts(store.db, run.result.runId).find((attempt) => attempt.state === 'completed');
    store.db.prepare("UPDATE runs SET state = 'interrupted' WHERE id = ?").run(run.result.runId);
    store.close();

    const resumed = await commandResume(
      // The fake runtime enforces no write boundary, so continuing a writing
      // profile on it needs the same explicit acknowledgement the run did.
      { positionals: [run.result.runId], stateDir: run.stateRoot, json: false, allowUnconfinedWrites: true },
      { continuation: fixesTheBug() },
    );
    expect(resumed.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(resumed.data['preservedTaskIds']).toEqual([run.result.taskId]);
    expect(resumed.data['tasks']).toEqual([]);

    readState(run.stateRoot, (db) => {
      expect(getRun(db, run.result.runId).state).toBe('ready_for_review');
      expect(getTask(db, run.result.taskId).state).toBe('accepted');
      // No second writer was created for work that was already accepted.
      const completed = listRunAttempts(db, run.result.runId).filter((attempt) => attempt.state === 'completed');
      expect(completed.map((attempt) => attempt.id)).toEqual([accepted?.id]);
    });
  }, 60_000);
});

/**
 * What the continued worker is actually asked to do. The task row stores the
 * contract's objective — the request's first line, clipped to 200 characters —
 * so a continuation that handed that over would quietly ask for less than the
 * interrupted attempt was asked for.
 */
describe('the continued attempt is dispatched as the run recorded it', () => {
  let state: TempState;
  afterEach(() => state.cleanup());

  it('hands the worker the run request verbatim rather than the clipped task objective', async () => {
    state = openTempState();
    const db = state.store.db;
    // Longer than the 200 characters a contract objective keeps, so the
    // stored objective really is a clipped summary of the request.
    const longRequest = `${REQUEST_TEXT} Keep the public signatures unchanged, add a regression test for the final page, and explain the fix in the summary.`;
    const request = { ...sampleRequest(), text: longRequest };
    const run = insertRun(db, { request, policy: 'local-development', limits: TEST_LIMITS });
    // The direct path stores exactly this as the task's objective.
    const clipped = `${longRequest.slice(0, 197)}...`;
    const task = insertTask(db, { runId: run.id, contract: sampleContract({ objective: clipped }) });
    upsertAgentSnapshot(db, computeAgentSnapshot(loadAgentConfigFile('fixtures/agents/example.json').config, 'engineer'));
    transitionRun(db, run.id, 'running');
    transitionTask(db, task.id, 'ready');
    insertAttempt(db, { taskId: task.id, agentSnapshotHash: computeAgentSnapshot(loadAgentConfigFile('fixtures/agents/example.json').config, 'engineer').hash });

    const { plan } = resumeRun({ runId: run.id, store: state.store, probeProcess: () => 'dead' as const, replacementAttempts: 'reserved' });
    let dispatched: RunDirectInput | null = null;
    await continueResumedRun(plan, state.store, {
      config: loadAgentConfigFile('fixtures/agents/example.json'),
      dispatch: (input) => {
        dispatched = input;
        throw new Error('stopped before the orchestrator ran');
      },
    });

    expect(dispatched).not.toBeNull();
    const slot = (dispatched as unknown as RunDirectInput).slot;
    expect(longRequest.length).toBeGreaterThan(200);
    expect(slot?.objective).toBe(longRequest);
    expect(slot?.objective).not.toBe(clipped);
    // The reserved identity is what gets dispatched, and its row is the
    // dispatcher's to insert.
    expect(slot?.attemptId).toBe(plan.steps.find((step) => step.action === 'replace')?.newAttemptId);
    expect(slot?.runId).toBe(run.id);
  });
});
