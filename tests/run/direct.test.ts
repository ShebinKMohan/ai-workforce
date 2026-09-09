import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { ClaudeCodeAdapter, FakeAdapter, FAKE_RUNTIME_VERSION, FAKE_SCENARIO_ENV, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeEvent } from '../../src/adapters/index.js';
import {
  checksFromFlags,
  observeWriteBoundary,
  readUnplaceableChanges,
  resolveAcceptanceChecks,
  RunSetupError,
  runDirect,
  tokenizeCheckCommand,
  type ContainmentAssessment,
  type RunDirectResult,
  type RunStream,
} from '../../src/core/run-direct.js';
import { summarizeTurnEvidence, type TurnEvidence } from '../../src/telemetry/events.js';
import { openStateStore } from '../../src/storage/db.js';
import { LockLostError } from '../../src/storage/lock.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { getAttempt, getRun, getTask, listTasks } from '../../src/storage/records.js';
import { listEvents } from '../../src/storage/events.js';
import { listArtifacts } from '../../src/storage/artifacts.js';
import { listChecks } from '../../src/verification/checks.js';
import { HANDOFF_FAILURE_CLASSES } from '../../src/recovery/continue.js';
import { gitTextOrNull } from '../../src/workspaces/git.js';
import {
  claimDoneWithoutEditingScenario,
  cleanupAll,
  deleteTheTestsScenario,
  fingerprintCheckout,
  fixAndEscapeScenario,
  fixedPaginationSource,
  fixTheBugScenario,
  fixThenExitCleanlyScenario,
  fixThePythonBugScenario,
  hangScenario,
  hideTheTestsFromTheArchiveScenario,
  longRunningScenario,
  registerCleanup,
  rewriteTheTestsScenario,
  runtimeExitsScenario,
  tempDir,
  useFixture,
  writeClaudeAgentsConfig,
  writeFakeAgentsConfig,
  writeScenario,
  type FakeScenario,
} from '../workspaces/support.js';

const execFileAsync = promisify(execFile);

afterEach(() => cleanupAll());

const REQUEST_TEXT =
  'The paginated search endpoint drops results. With 7 matches and a page size of 3 the API reports 2 pages, so the last match is never shown. Find the cause and fix it.';

interface Harness {
  readonly repo: string;
  readonly headRevision: string;
  readonly stateRoot: string;
  readonly configPath: string;
  readonly lines: string[];
  readonly jsonEvents: Array<Record<string, unknown>>;
  readonly stream: RunStream;
  run(scenario: FakeScenario, options?: { checkFlags?: string[]; signal?: AbortSignal; runDeadlineMs?: number; ownership?: { assertOwnership(): void } }): Promise<RunDirectResult>;
}

async function harness(fixtureName: 'ts-bug' | 'py-bug' = 'ts-bug'): Promise<Harness> {
  const fixture = await useFixture(fixtureName);
  const stateRoot = tempDir('workforce-state-');
  const configDir = tempDir('workforce-config-');
  const configPath = writeFakeAgentsConfig(configDir);
  const lines: string[] = [];
  const jsonEvents: Array<Record<string, unknown>> = [];
  const stream: RunStream = { line: (text) => lines.push(text), event: (record) => jsonEvents.push(record) };

  return {
    repo: fixture.path,
    headRevision: fixture.headRevision,
    stateRoot,
    configPath,
    lines,
    jsonEvents,
    stream,
    run: async (scenario, options = {}) => {
      const scenarioPath = writeScenario(scenario);
      const paths = createStatePaths(stateRoot);
      const store = openStateStore(paths, { mode: 'mutating' });
      try {
        const loaded = loadAgentConfigFile(configPath);
        return await runDirect({
          // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
          allowUnconfinedWrites: true,
          repoPath: fixture.path,
          config: loaded.config,
          configRaw: loaded.raw,
          configPath: loaded.path,
          requestText: REQUEST_TEXT,
          requestSource: 'argument',
          paths,
          db: store.db,
          stream,
          sessionEnv: { [FAKE_SCENARIO_ENV]: scenarioPath },
          ...(options.checkFlags !== undefined ? { checkFlags: options.checkFlags } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.runDeadlineMs !== undefined ? { runDeadlineMs: options.runDeadlineMs } : {}),
          ...(options.ownership !== undefined ? { ownership: options.ownership } : {}),
        });
      } finally {
        store.close();
      }
    },
  };
}

function readState<T>(stateRoot: string, fn: (db: import('node:sqlite').DatabaseSync) => T): T {
  const paths = createStatePaths(stateRoot);
  const store = openStateStore(paths, { mode: 'read-only' });
  try {
    return fn(store.db);
  } finally {
    store.close();
  }
}

describe('the direct path produces a verified candidate (FR019, FR020, FR041, FR049)', () => {
  it('accepts the "fix the bug" scenario with verifier-executed evidence and preserves the checkout', async () => {
    const h = await harness();
    const before = await fingerprintCheckout(h.repo);

    const result = await h.run(fixTheBugScenario());

    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
    expect(result.acceptance.requiredPassed).toBe(1);
    expect(result.acceptance.requiredTotal).toBe(1);
    expect(result.receipts.map((r) => r.outcome)).toEqual(['passed']);
    expect(result.receipts[0]!.evidenceProvenance).toBe('verifier_executed');
    // The check ran against the frozen candidate, not against the workspace.
    expect(result.receipts[0]!.candidate.revision).toBe(result.snapshot!.candidateRevision);

    // Candidate identity.
    expect(result.snapshot!.checkpointCreated).toBe(true);
    expect(result.snapshot!.changedFiles).toEqual(['src/pagination.js']);
    expect(result.snapshot!.candidateRevision).not.toBe(h.headRevision);
    expect(await gitTextOrNull(['rev-parse', 'main'], { cwd: h.repo })).toBe(h.headRevision);
    expect(await gitTextOrNull(['rev-parse', result.snapshot!.branch], { cwd: h.repo })).toBe(result.snapshot!.candidateRevision);

    // Artifacts: result.json, summary.md, candidate.patch, checks/, logs/.
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(existsSync(result.summaryPath)).toBe(true);
    expect(existsSync(result.patchPath!)).toBe(true);
    const artifactPaths = readState(h.stateRoot, (db) => listArtifacts(db, result.runId).map((a) => a.relativePath));
    expect(artifactPaths).toEqual(expect.arrayContaining(['candidate.patch', 'result.json', 'summary.md', 'checks/node-tests-pass/stdout.log', 'logs/runtime-events.jsonl']));

    // The manifest carries requirement-by-requirement status and both identities.
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as Record<string, any>;
    expect(manifest.outcome).toBe('accepted');
    expect(manifest.request.text).toBe(REQUEST_TEXT); // the original wording, preserved
    expect(manifest.base.revision).toBe(h.headRevision);
    expect(manifest.candidate.revision).toBe(result.snapshot!.candidateRevision);
    expect(manifest.candidate.patchHash).toBe(result.snapshot!.patchHash);
    expect(manifest.requirements).toEqual([expect.objectContaining({ criterionId: 'node-tests-pass', status: 'passed', required: true })]);
    expect(manifest.candidate.changedFiles).toEqual([{ status: 'M', path: 'src/pagination.js' }]);
    expect(manifest.timing).toEqual(
      expect.objectContaining({ dispatchMs: expect.any(Number), startupMs: expect.any(Number), runtimeMs: expect.any(Number), validationMs: expect.any(Number) }),
    );
    expect(manifest.usage.status).toBe('unavailable');
    expect(manifest.evidence.runtimeClaimedDone).toBe(true);

    // The summary explains the same thing to a human.
    const summary = readFileSync(result.summaryPath, 'utf8');
    expect(summary).toContain('# Run ');
    expect(summary).toContain('node-tests-pass');
    expect(summary).toContain(result.snapshot!.candidateRevision);

    // Durable state.
    readState(h.stateRoot, (db) => {
      expect(getRun(db, result.runId).state).toBe('ready_for_review');
      expect(getTask(db, result.taskId).state).toBe('accepted');
      expect(getAttempt(db, result.attemptId).state).toBe('completed');
      const checks = listChecks(db, result.runId);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.outcome).toBe('passed');
      const types = listEvents(db, result.runId).map((e) => e.type);
      expect(types).toEqual(expect.arrayContaining(['run.created', 'operation.intended', 'operation.dispatched', 'workspace.created', 'candidate.snapshot', 'run.accepted']));
      // Dispatch intent was committed before the workspace existed.
      expect(types.indexOf('operation.intended')).toBeLessThan(types.indexOf('workspace.created'));
    });

    // events.jsonl projection exists next to the run.
    expect(existsSync(path.join(result.runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'request.json'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'contract.json'))).toBe(true);
    expect(existsSync(path.join(result.runDir, 'config-snapshot.json'))).toBe(true);

    // The user's checkout is untouched, and the fixture source is still broken.
    const after = await fingerprintCheckout(h.repo);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe(before.status);
    expect(after.tree).toBe(before.tree);
    expect(readFileSync(path.join(h.repo, 'src', 'pagination.js'), 'utf8')).toContain('Math.floor(total / pageSize)');
  });

  it('fails the "claim done without editing" scenario and never marks it accepted (FR050)', async () => {
    const h = await harness();

    const result = await h.run(claimDoneWithoutEditingScenario());

    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    // The runtime said it was done...
    expect(result.evidence!.claimedDone).toBe(true);
    expect(result.evidence!.fileChanges).toEqual([]);
    // ... and the verifier disagreed on the evidence.
    expect(result.receipts[0]!.outcome).toBe('failed');
    expect(result.snapshot!.checkpointCreated).toBe(false);
    expect(result.snapshot!.candidateRevision).toBe(h.headRevision);
    expect(result.manifest.unresolved.join(' ')).toContain('produced no change');

    readState(h.stateRoot, (db) => {
      const task = getTask(db, result.taskId);
      expect(task.state).toBe('failed');
      expect(getRun(db, result.runId).state).toBe('failed');
      // No event ever recorded acceptance.
      expect(listEvents(db, result.runId).map((e) => e.type)).not.toContain('run.accepted');
    });
  });

  it('records an unexpected runtime exit on the attempt and refuses acceptance', async () => {
    const h = await harness();

    const result = await h.run(runtimeExitsScenario());

    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.attemptState).toBe('failed');
    expect(result.manifest.runtime.turnConclusion).toBe('runtime_exited');
    expect(result.manifest.unresolved.join(' ')).toContain('runtime process ended before the turn completed');
    // The partial work the runtime managed to write is still preserved as a candidate.
    expect(result.snapshot!.checkpointCreated).toBe(true);
    expect(result.snapshot!.changedFiles).toEqual(['src/pagination.js']);
    expect(result.receipts[0]!.outcome).toBe('failed');

    readState(h.stateRoot, (db) => {
      const attempt = getAttempt(db, result.attemptId);
      expect(attempt.state).toBe('failed');
      expect(JSON.parse(attempt.outcome_json!).turnConclusion).toBe('runtime_exited');
      expect(getTask(db, result.taskId).state).toBe('failed');
    });
    // The candidate branch keeps the partial work: nothing is discarded.
    expect(await gitTextOrNull(['rev-parse', result.snapshot!.branch], { cwd: h.repo })).toBe(result.snapshot!.candidateRevision);
  });

  it('stops an unresponsive runtime instead of waiting for it forever (FR039)', async () => {
    const h = await harness();
    const controller = new AbortController();
    // Interrupt once the runtime is provably unresponsive, not after a guessed
    // delay: the fake runtime spawns a child and stops reading stdin, so from
    // that point nothing it is asked to do can end the turn.
    void (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !h.lines.some((line) => line.includes('exec hang'))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      controller.abort();
    })();

    const started = Date.now();
    const result = await h.run(hangScenario(), { signal: controller.signal });
    const elapsed = Date.now() - started;

    expect(result.outcome).toBe('interrupted');
    expect(elapsed).toBeLessThan(30_000);
    expect(result.stopReceipt?.state).toBe('process_tree_terminated');
    expect(h.lines.join('\n')).toContain('terminating the owned process group');
    // The work the runtime managed before hanging is preserved.
    expect(result.snapshot!.checkpointCreated).toBe(true);

    readState(h.stateRoot, (db) => {
      const types = listEvents(db, result.runId).map((e) => e.type);
      expect(types).toContain('run.interrupt_requested');
      expect(types).toContain('run.interrupt_acknowledged');
      expect(types).toContain('runtime.stopped');
      // The persisted run and task are not left saying "running".
      expect(getRun(db, result.runId).state).toBe('interrupted');
      expect(getTask(db, result.taskId).state).toBe('cancelled');
      expect(getAttempt(db, result.attemptId).state).toBe('interrupted');
    });
  }, 60_000);

  it('enforces the configured run deadline rather than only reporting it (FR014)', async () => {
    const h = await harness();

    const result = await h.run(longRunningScenario(30_000), { runDeadlineMs: 600 });

    expect(result.outcome).toBe('interrupted');
    expect(result.manifest.runtime['interruptReason']).toBe('run_deadline');
    expect(result.manifest.unresolved.join(' ')).toContain('deadline before acceptance');
    expect(h.lines.join('\n')).toContain('run deadline of 600ms reached');
    readState(h.stateRoot, (db) => {
      const interrupt = listEvents(db, result.runId).find((e) => e.type === 'run.interrupt_requested');
      expect(interrupt!.payload['reason']).toBe('run_deadline');
    });
  }, 60_000);

  it('stops the worker, preserves the work and reports an interruption on abort (FR039)', async () => {
    const h = await harness();
    const controller = new AbortController();
    // Interrupt once the worker has provably made its edit, not after a guessed
    // delay. Under load `git worktree add` can still be running at 700ms, and
    // aborting then kills that git child instead of the worker: the run dies
    // with a GitError and never reaches the interruption this test is about.
    // Waiting for the change also guarantees there is work to preserve, which
    // is what the checkpoint assertion below depends on.
    void (async () => {
      const deadline = Date.now() + 20_000;
      const edited = (): boolean => h.lines.some((line) => line.includes('changed') && line.includes('pagination.js'));
      while (Date.now() < deadline && !edited()) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      controller.abort();
    })();

    const result = await h.run(longRunningScenario(30_000), { signal: controller.signal });

    expect(result.outcome).toBe('interrupted');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.receipts).toEqual([]); // no checks run, so nothing could be accepted
    expect(result.stopReceipt?.state).toBe('process_tree_terminated');
    // The edit the worker had already made is preserved on the candidate branch.
    expect(result.snapshot!.checkpointCreated).toBe(true);
    expect(await gitTextOrNull(['rev-parse', result.snapshot!.branch], { cwd: h.repo })).toBe(result.snapshot!.candidateRevision);

    readState(h.stateRoot, (db) => {
      expect(getRun(db, result.runId).state).toBe('interrupted');
      expect(getTask(db, result.taskId).state).toBe('cancelled');
      const attempt = getAttempt(db, result.attemptId);
      expect(attempt.state).toBe('interrupted');
      expect(attempt.interrupted).toBe(1);
      const types = listEvents(db, result.runId).map((e) => e.type);
      expect(types).toContain('run.interrupt_requested');
      expect(types).toContain('run.interrupted');
      expect(types).not.toContain('run.accepted');
    });
  }, 60_000);

  it('runs the Python fixture through detected checks and accepts the fix', async () => {
    const h = await harness('py-bug');
    const before = await fingerprintCheckout(h.repo);

    const result = await h.run(fixThePythonBugScenario());

    expect(result.outcome).toBe('accepted');
    expect(result.manifest.evidence['checkSource']).toBe('detected');
    expect(result.receipts[0]!.command).toBe('python3');
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.snapshot!.changedFiles).toEqual(['src/ranges.py']);
    expect((await fingerprintCheckout(h.repo)).tree).toBe(before.tree);
  });

  it('shows the resulting diff and summarizes unnormalized runtime output instead of printing every frame', async () => {
    const h = await harness();

    const result = await h.run({
      scenarioVersion: 1,
      steps: [
        { action: 'message', text: 'Reading src/pagination.js.' },
        { action: 'unknown_event' },
        { action: 'unknown_event' },
        { action: 'unknown_event' },
        { action: 'edit_file', path: 'src/pagination.js', content: fixedPaginationSource() },
        { action: 'claim_done', message: 'Fixed both off-by-one errors.' },
      ],
    });
    expect(result.outcome).toBe('accepted');

    // R0's terminal shows the change itself, not only a path to a patch file.
    const output = h.lines.join('\n');
    expect(output).toContain(`candidate diff (${result.snapshot!.baseRevision.slice(0, 12)} → ${result.snapshot!.candidateRevision.slice(0, 12)})`);
    expect(output).toContain('-  return Math.floor(total / pageSize);');
    expect(output).toContain('+  return Math.ceil(total / pageSize);');
    // Paths are shown relative to the candidate workspace, not as absolute temp paths.
    expect(h.lines).toContain('  changed src/pagination.js');
    expect(h.lines).toContain('  M src/pagination.js');

    // Unnormalized runtime frames are counted once, never printed one per line...
    expect(result.evidence!.rawEvents).toBeGreaterThanOrEqual(3);
    expect(h.lines.filter((line) => line.includes('fake_custom_event'))).toEqual([]);
    expect(h.lines.filter((line) => /further runtime event\(s\) kept verbatim as evidence/.test(line))).toHaveLength(1);
    // ... and the machine-readable stream still carries every one of them.
    expect(h.jsonEvents.filter((event) => event['type'] === 'runtime.raw').length).toBe(result.evidence!.rawEvents);

    // The manifest names them for what they are.
    expect(result.manifest.evidence['unnormalizedRuntimeEvents']).toBe(result.evidence!.rawEvents);
    expect(Object.keys(result.manifest.evidence)).not.toContain('malformedRuntimeLines');
  });

  it('refuses acceptance when the candidate rewrites the tests its own criterion executes', async () => {
    const h = await harness();

    const result = await h.run(rewriteTheTestsScenario());

    // The rewritten suite really does exit 0 — that is the whole point of the attack.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.receipts[0]!.exitCode).toBe(0);
    // ... and it still does not accept, because the candidate changed the code the criterion runs.
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.criteria[0]!.status).toBe('compromised');
    expect(result.acceptance.reasons.join(' ')).toContain('test/pagination.test.js');
    expect(result.manifest.unresolved.join(' ')).toContain('files that criterion "node-tests-pass" executes');
    expect(result.manifest.evidence['acceptanceFixtureMutations']).toEqual([
      { criterionId: '*', changedPaths: ['M test/pagination.test.js'] },
      { criterionId: 'node-tests-pass', changedPaths: ['M test/pagination.test.js'] },
    ]);
    // The bug is still there; nothing pretends otherwise.
    expect(result.snapshot!.changedFiles).toEqual(['test/pagination.test.js']);

    readState(h.stateRoot, (db) => {
      expect(getTask(db, result.taskId).state).toBe('failed');
      expect(listEvents(db, result.runId).map((e) => e.type)).not.toContain('run.accepted');
    });
  });

  it('refuses acceptance when the candidate hides the acceptance suite from the verifier\'s copy', async () => {
    const h = await harness();

    const result = await h.run(hideTheTestsFromTheArchiveScenario());

    // Nothing the acceptance surface pins was modified or deleted: the diff is
    // two additions, so the fixture-mutation rule never fires.
    expect(result.snapshot!.changes.every((change) => change.status.startsWith('A'))).toBe(true);
    expect(result.manifest.evidence['acceptanceFixtureMutations']).toEqual([]);
    // The verifier still ran the suite the base revision defined, and it fails.
    expect(result.receipts[0]!.outcome).toBe('failed');
    expect(result.receipts[0]!.copyStrategy).toBe('git_archive_repaired');
    expect(result.receipts[0]!.diagnostics.join(' ')).toContain('export-ignore');
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    // And the change that tried it is named for a reader rather than left silent.
    expect(result.manifest.unresolved.join(' ')).toContain('.gitattributes');
  });

  it('does not read a suite that executed zero tests as a passing check', async () => {
    const h = await harness();

    const result = await h.run(deleteTheTestsScenario());

    // `node --test <dir>` exits 0 when the directory holds nothing runnable; the receipt says what really happened.
    expect(result.receipts[0]!.exitCode).toBe(0);
    expect(result.receipts[0]!.outcome).toBe('no_tests_executed');
    expect(result.receipts[0]!.outputSummary).toEqual({ runner: 'node_test', testsRun: 0, note: 'node --test reported that it executed 0 tests' });
    expect(result.acceptance.criteria[0]!.detail).toContain('without executing any test');
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.snapshot!.changes).toEqual([
      { status: 'A', path: 'test/NOTES.md' },
      { status: 'D', path: 'test/pagination.test.js' },
    ]);
    // The deletion compromises the criterion; the added file is recorded, not held against the worker.
    expect(result.manifest.evidence['acceptanceFixtureAdditions']).toEqual(['test/NOTES.md']);
  });

  it('tells the worker which files are acceptance fixtures instead of only catching it afterwards', async () => {
    const h = await harness();
    await h.run(fixTheBugScenario());
    const contract = JSON.parse(readFileSync(path.join(h.stateRoot, 'runs', (h.jsonEvents[0] as { runId: string }).runId, 'contract.json'), 'utf8')) as {
      scope: { forbiddenPaths: string[] };
    };
    expect(contract.scope.forbiddenPaths).toEqual(['.git', '.workforce/checks.json', 'test', 'test/pagination.test.js']);
    expect(h.lines.join('\n')).toContain('acceptance fixtures (the worker must not rewrite these; new test files are fine)');
  });

  it('does not accept a run whose worker wrote outside its granted paths (AT12)', async () => {
    const h = await harness();

    const result = await h.run(fixAndEscapeScenario());

    // The fix itself is good and the check passes on it.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.snapshot!.changedFiles).toEqual(['src/pagination.js']);
    // The escape is still not an accepted run.
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('wrote outside its granted paths');
    expect(result.evidence!.fileChangesOutsideAllowedPaths).toHaveLength(1);
    readState(h.stateRoot, (db) => expect(getTask(db, result.taskId).state).toBe('failed'));
  });

  it('does not accept a candidate produced by a turn whose runtime died, even with a passing check', async () => {
    const h = await harness();

    const result = await h.run(fixThenExitCleanlyScenario());

    expect(result.manifest.runtime['turnConclusion']).toBe('runtime_exited');
    expect(result.receipts[0]!.outcome).toBe('passed'); // the partial work happens to be the whole fix
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('ended before the turn completed');
    readState(h.stateRoot, (db) => {
      // The attempt failed and so did the task it belongs to: they cannot disagree.
      expect(getAttempt(db, result.attemptId).state).toBe('failed');
      expect(getTask(db, result.taskId).state).toBe('failed');
    });
  });

  it('does not accept a run that changed nothing, even when every configured check passes', async () => {
    const h = await harness();

    // A check that passes whatever the candidate contains, plus a worker that edits nothing.
    const result = await h.run(claimDoneWithoutEditingScenario(), { checkFlags: ['node --version'] });

    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.snapshot!.checkpointCreated).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('no change, so there is no candidate to accept');
  });

  it('stops the run honestly when exclusive ownership of the state root can no longer be proved', async () => {
    const h = await harness();
    // Ownership holds while the worker is dispatched and is gone by the time a
    // result would be written — the shape `lock.assertOwnership` produces when
    // the arbiter file is replaced mid-run.
    let calls = 0;
    const ownership = {
      assertOwnership: () => {
        calls += 1;
        if (calls > 1) throw new LockLostError('/state/coordinator.lock', { status: 'arbiter_replaced', detail: 'the arbiter is now a different file' });
      },
    };

    await expect(h.run(fixTheBugScenario(), { ownership })).rejects.toBeInstanceOf(LockLostError);
    expect(calls).toBe(2);

    readState(h.stateRoot, (db) => {
      const runId = (h.jsonEvents.find((event) => event['type'] === 'run.created') as { runId: string }).runId;
      expect(getRun(db, runId).state).toBe('failed');
      expect(listEvents(db, runId).map((e) => e.type)).toContain('run.ownership_lost');
      // No acceptance was recorded for a run that could not prove it owned the state root.
      expect(listEvents(db, runId).map((e) => e.type)).not.toContain('run.accepted');
      expect(listChecks(db, runId)).toEqual([]);
    });
  });

  it('refuses to start when no acceptance checks can be resolved', async () => {
    const h = await harness('py-bug');
    // Remove the Python tests from the base revision so nothing is detectable.
    await execFileAsync('git', ['rm', '-r', '--quiet', 'tests'], { cwd: h.repo });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-verify', '-m', 'drop tests'], { cwd: h.repo });

    await expect(h.run(fixTheBugScenario())).rejects.toMatchObject({ code: 'no_acceptance_checks' });
  });
});

describe('a writing profile needs a write boundary (plan sections 6, 8 and 9; FR005, FR042)', () => {
  const CLAUDE_REPLAY = fileURLToPath(new URL('../../fixtures/claude-code/fake-claude.mjs', import.meta.url));

  function claudeScenarioEnv(scenario: string, vars: Record<string, string>): Record<string, string> {
    return {
      WORKFORCE_FAKE_CLAUDE_SCENARIO: fileURLToPath(new URL(`../../fixtures/claude-code/${scenario}`, import.meta.url)),
      WORKFORCE_FAKE_CLAUDE_VARS: JSON.stringify(vars),
    };
  }

  async function runClaude(
    options: { allowUnconfinedWrites?: boolean; policy?: 'analysis' | 'local-development'; scenario?: string; vars?: Record<string, string> } = {},
  ): Promise<{
    result: RunDirectResult | null;
    error: unknown;
    lines: string[];
    stateRoot: string;
  }> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-claude-run-');
    const configPath = writeClaudeAgentsConfig(tempDir('workforce-claude-config-'), options.policy === undefined ? {} : { policy: options.policy });
    const lines: string[] = [];
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const loaded = loadAgentConfigFile(configPath);
      const result = await runDirect({
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: REQUEST_TEXT,
        requestSource: 'argument',
        paths,
        db: store.db,
        stream: { line: (text) => lines.push(text), event: () => {} },
        // The real Claude Code adapter, driven by its deterministic replay
        // binary: the whole adapter runs, no model turn is started.
        adapterFactory: (_runtime, context) =>
          new ClaudeCodeAdapter({
            executablePath: process.execPath,
            extraArgs: [CLAUDE_REPLAY],
            logsDir: context.logsDir,
            startupTimeoutMs: 10_000,
            controlTimeoutMs: 10_000,
            stopTimeoutMs: 3_000,
          }),
        sessionEnv: claudeScenarioEnv(options.scenario ?? 'session-fix-pagination.synthetic.json', { fix: fixedPaginationSource(), ...(options.vars ?? {}) }),
        ...(options.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
      });
      return { result, error: null, lines, stateRoot };
    } catch (error) {
      return { result: null, error, lines, stateRoot };
    } finally {
      store.close();
    }
  }

  it('refuses to dispatch a writing profile to a runtime that enforces no write boundary', async () => {
    const { result, error, lines } = await runClaude();

    expect(result).toBeNull();
    expect(error).toBeInstanceOf(RunSetupError);
    expect((error as RunSetupError).code).toBe('write_boundary_unsupported');
    expect((error as Error).message).toContain('write_containment "unsupported"');
    expect((error as Error).message).toContain('--allow-unconfined-writes');
    // Refused at setup: before a workspace, a session or a process exists.
    expect(lines.join('\n')).not.toContain('candidate workspace');
  });

  it('opens a read-only profile on the same runtime without a boundary it does not need', async () => {
    const { result, error } = await runClaude({ policy: 'analysis' });

    // The analysis profile writes nothing, so the missing boundary does not
    // block it: the run proceeds and fails for its own reason (the worker's
    // scenario writes, but nothing accepts an unchanged candidate).
    expect(error).toBeNull();
    expect(result!.manifest.evidence['containment']).toMatchObject({ policy: 'analysis', profileWrites: false, enforcedWriteBoundary: null });
  });

  it('records the missing boundary in the manifest when a human explicitly accepts one', async () => {
    const { result, error, lines } = await runClaude({ allowUnconfinedWrites: true });

    expect(error).toBeNull();
    const manifest = result!.manifest;
    // The run works: the fix lands, the verifier executes the criteria itself.
    expect(result!.outcome).toBe('accepted');
    expect(result!.receipts[0]!.outcome).toBe('passed');

    // And its evidence cannot be mistaken for a contained run's.
    expect(manifest.evidence['containment']).toMatchObject({
      adapter: 'claude-code',
      policy: 'local-development',
      profileWrites: true,
      writeContainment: 'unsupported',
      enforcedWriteBoundary: false,
      unconfinedWritesAcknowledged: true,
    });
    const unenforceable = (manifest.evidence['containment'] as { unenforceable: Array<{ aspect: string }> }).unenforceable;
    expect(unenforceable.map((entry) => entry.aspect)).toContain('process_containment');
    expect(String(manifest.evidence['containmentNote'])).toContain('THIS RUN HAD NO ENFORCED WRITE BOUNDARY');
    expect(manifest.unresolved.join(' ')).toContain('no enforced write boundary');
    expect(lines.join('\n')).toContain('WARNING: no enforced write boundary');
    expect(lines.join('\n')).toContain('write boundary: claude-code reports write_containment "unsupported"');

    // The usage the adapter measured reaches the manifest, cost included.
    expect(manifest.usage).toMatchObject({ status: 'measured', inputTokens: 1200, outputTokens: 40, costUsd: 0.0123 });

    // And the human trace says what the worker's tools actually did.
    expect(lines.join('\n')).toContain('tool Write -> ok');
    expect(lines.join('\n')).toContain('changed src/pagination.js');

    // The summary a person reads carries the same fact.
    const summary = readFileSync(result!.summaryPath, 'utf8');
    expect(summary).toContain('this run had no enforced write boundary');
    expect(summary).toContain('not enforced by the runtime');
  });
});

/**
 * The containment note is the one place a reader is told what this run's
 * boundary actually was. It has to move when the boundary moves: once checks
 * run outside the coordinator state root and that root is fingerprinted across
 * each check window, a note that still says only "test code could write
 * anything, including the state root" understates what happened — and a note
 * that stops saying there is no OS containment would overstate it.
 */
describe('the containment note describes the boundary this run actually had (FR042, FR049, FR050)', () => {
  it('names the check placement and the state-root guard without claiming confinement', async () => {
    const h = await harness();

    const result = await h.run(fixTheBugScenario());

    expect(result.outcome).toBe('accepted');
    const note = String(result.manifest.evidence['containmentNote']);
    // What is now true, and is the point of running checks outside the state root.
    expect(note).toContain('outside the coordinator state root');
    expect(note).toContain('no relative path from a check reaches coordinator state');
    expect(note).toContain('fingerprinted on both sides of each check window');
    // What is still not true, said in the same breath.
    expect(note).toContain('not confinement');
    expect(note).toContain('can name any absolute path');
    expect(note).toContain('(FR042) is an R1 gate and is not claimed here');

    // And the receipt backs the note rather than the note standing alone.
    const receipt = result.receipts[0]!;
    expect(receipt.containment!.outsideStateRoot).toBe(true);
    expect(receipt.containment!.stateRoot).not.toBeNull();
    expect(receipt.containment!.cwd.startsWith(receipt.containment!.stateRoot!)).toBe(false);
    // Evidence stays where it belongs: under the run directory, inside the state root.
    expect(receipt.containment!.evidenceRoot.startsWith(result.runDir)).toBe(true);
    expect(receipt.stateRootGuard!.checked).toBe(true);
    expect(receipt.stateRootGuard!.violations).toEqual([]);
  });
});

describe('what the runtime says about its own turn is read as a claim, not as a result (FR003, FR004, FR042, FR050)', () => {
  const CLAUDE_REPLAY = fileURLToPath(new URL('../../fixtures/claude-code/fake-claude.mjs', import.meta.url));

  async function runReplay(scenario: string, vars: Record<string, string> = {}): Promise<RunDirectResult> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-claude-claims-');
    const configPath = writeClaudeAgentsConfig(tempDir('workforce-claude-claims-config-'));
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const loaded = loadAgentConfigFile(configPath);
      return await runDirect({
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: REQUEST_TEXT,
        requestSource: 'argument',
        paths,
        db: store.db,
        stream: { line: () => {}, event: () => {} },
        adapterFactory: (_runtime, context) =>
          new ClaudeCodeAdapter({
            executablePath: process.execPath,
            extraArgs: [CLAUDE_REPLAY],
            logsDir: context.logsDir,
            startupTimeoutMs: 10_000,
            controlTimeoutMs: 10_000,
            stopTimeoutMs: 3_000,
          }),
        sessionEnv: {
          WORKFORCE_FAKE_CLAUDE_SCENARIO: fileURLToPath(new URL(`../../fixtures/claude-code/${scenario}`, import.meta.url)),
          WORKFORCE_FAKE_CLAUDE_VARS: JSON.stringify({ fix: fixedPaginationSource(), ...vars }),
        },
        allowUnconfinedWrites: true,
      });
    } finally {
      store.close();
    }
  }

  it('refuses a candidate whose evidence carries a session id the coordinator never minted', async () => {
    const result = await runReplay('session-foreign-session-id.synthetic.json');

    // The fix itself is real and the check passes on the frozen candidate...
    expect(result.receipts[0]!.outcome).toBe('passed');
    // ...and the run is still refused, because the records that describe the
    // work name a conversation this coordinator did not open.
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(result.acceptance.reasons.join(' ')).toContain('session id this coordinator did not mint');
    expect(result.evidence!.sessionIdentityMismatches.join(' ')).toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(String(result.manifest.evidence['sessionIdentityMismatches'])).toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(result.manifest.unresolved.join(' ')).toContain('a session this coordinator did not open');
  });

  it('does not record a terminal record that reports failure as a completed turn', async () => {
    const result = await runReplay('session-error-result.synthetic.json');

    // Same real fix, same passing verifier-executed check.
    expect(result.receipts[0]!.outcome).toBe('passed');
    // The runtime said the turn failed, so the manifest says so too.
    expect(result.manifest.runtime['turnConclusion']).toBe('turn_failed');
    expect(String(result.manifest.evidence['runtimeReportedTurnFailure'])).toContain('error_during_execution');
    expect(result.outcome).toBe('failed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('terminal record says the turn failed');
    expect(result.manifest.unresolved.join(' ')).toContain('reporting that it failed');
    expect(readFileSync(result.summaryPath, 'utf8')).toContain('reporting that it failed');
  });

  it('classifies a recorded authentication failure from the runtime\'s own tag, so a fallback is reachable (AT04)', async () => {
    // The whole point of classifying in the run path: this recorded transcript
    // is a real expired-credential failure, and until the adapter's structured
    // fields reached `classifyFailure` the class was derived from prose — a
    // real Codex transport failure came out `unknown`, which is not a handoff
    // class, so no fallback runtime could ever be selected.
    const result = await runReplay('session-auth-failure.real.json');

    expect(result.acceptance.accepted).toBe(false);
    expect(result.failure).not.toBeNull();
    const failure = result.failure!;
    expect(failure.failureClass).toBe('authentication');
    // Decided by the machine-readable tag the CLI itself reported, not by the
    // sentence around it.
    expect(failure.signal).toBe('runtime tag "authentication_failed"');
    expect(failure.retryable).toBe(false);
    expect(failure.userAction).toMatch(/re-authenticate/);
    expect(HANDOFF_FAILURE_CLASSES.has(failure.failureClass)).toBe(true);
  });

  it('does not present an empty escape list as a checked negative on a runtime with no write boundary', async () => {
    const outside = path.join(tempDir('workforce-claude-escape-'), 'ESCAPED.txt');
    const result = await runReplay('session-unreported-write.synthetic.json', { escape: outside });

    // The write really happened, and the runtime never reported it, so the
    // list of observed escapes is empty...
    expect(existsSync(outside)).toBe(true);
    expect(result.manifest.evidence['writesOutsideGrantedPaths']).toEqual([]);
    // ...which is exactly why the manifest has to say what that emptiness is
    // worth on a runtime that enforces nothing.
    expect(result.manifest.evidence['writeObservation']).toMatchObject({
      basis: 'runtime_reported_tool_events',
      enforcedWriteBoundary: false,
      complete: false,
    });
    const note = String((result.manifest.evidence['writeObservation'] as { note: string }).note);
    expect(note).toContain('An empty list means nothing was reported, NOT that nothing was written.');
    expect(readFileSync(result.summaryPath, 'utf8')).toContain('nothing was reported');
  });
});

describe('the manifest records what the runtime said ran, not only what was asked for (FR006, FR059)', () => {
  async function runWithSettings(settings: { model?: string; effort?: string }): Promise<RunDirectResult> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-effective-state-');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-effective-config-'), settings);
    const scenarioPath = writeScenario(fixTheBugScenario());
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const loaded = loadAgentConfigFile(configPath);
      return await runDirect({
        // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
        allowUnconfinedWrites: true,
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: REQUEST_TEXT,
        requestSource: 'argument',
        paths,
        db: store.db,
        stream: { line: () => {}, event: () => {} },
        sessionEnv: { [FAKE_SCENARIO_ENV]: scenarioPath },
      });
    } finally {
      store.close();
    }
  }

  it('records the model and effort the runtime reported beside the ones requested', async () => {
    const result = await runWithSettings({ model: 'fake-fast', effort: 'high' });
    const runtime = result.manifest.runtime as Record<string, unknown>;

    expect(runtime['model']).toBe('fake-fast');
    // The values the runtime echoed back, read through the shared contract
    // method — not the request repeated as if it had been confirmed.
    expect(runtime['effectiveModel']).toBe('fake-fast');
    expect(runtime['effectiveEffort']).toBe('high');
    expect(runtime['effectiveSettingsSource']).toBe('runtime_reported');
  });

  it('records the runtime default when nothing was requested, which the requested field cannot express', async () => {
    const result = await runWithSettings({});
    const runtime = result.manifest.runtime as Record<string, unknown>;

    expect(runtime['model']).toBeNull();
    expect(runtime['effectiveModel']).toBe('fake-default');
    expect(runtime['effectiveEffort']).toBe('medium');
    expect(runtime['effectiveSettingsSource']).toBe('runtime_reported');
  });

  it('says the effective values are unreported rather than assuming the requested ones took effect', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-effective-none-state-');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-effective-none-config-'), { model: 'fake-fast' });
    const scenarioPath = writeScenario(fixTheBugScenario());
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
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
        paths,
        db: store.db,
        stream: { line: () => {}, event: () => {} },
        sessionEnv: { [FAKE_SCENARIO_ENV]: scenarioPath },
        // A conforming adapter that simply does not implement the optional
        // method — the case where nothing may be assumed about what ran.
        adapterFactory: (runtimeRef) => {
          const inner = new FakeAdapter({ scriptPath: runtimeRef.executable });
          const withoutEffectiveSettings: RuntimeAdapter = {
            id: inner.id,
            probe: (executable) => inner.probe(executable),
            capabilities: () => inner.capabilities(),
            validateSettings: (requested) => inner.validateSettings(requested),
            openSession: (sessionInput) => inner.openSession(sessionInput),
            resumeSession: (resumeInput) => inner.resumeSession(resumeInput),
            startTurn: (session, turnInput) => inner.startTurn(session, turnInput),
            events: (turn) => inner.events(turn),
            deliver: (session, delivery) => inner.deliver(session, delivery),
            interrupt: (turn) => inner.interrupt(turn),
            stopOwnedProcesses: (session) => inner.stopOwnedProcesses(session),
            reconcile: (session) => inner.reconcile(session),
          };
          return withoutEffectiveSettings;
        },
      });
      const runtime = result.manifest.runtime as Record<string, unknown>;
      expect(runtime['model']).toBe('fake-fast');
      expect(runtime['effectiveModel']).toBeNull();
      expect(runtime['effectiveSettingsSource']).toBe('not_reported');
    } finally {
      store.close();
    }
  });
});

describe('acceptance check resolution', () => {
  it('prefers --check flags, then .workforce/checks.json at the base, then detection', async () => {
    const tsFixture = await useFixture('ts-bug');
    const fromConfig = await resolveAcceptanceChecks(tsFixture.path, tsFixture.headRevision, []);
    expect(fromConfig.source).toBe('repository_config');
    expect(fromConfig.checks[0]!.criterionId).toBe('node-tests-pass');

    const fromFlags = await resolveAcceptanceChecks(tsFixture.path, tsFixture.headRevision, ['node --test test/']);
    expect(fromFlags.source).toBe('cli_flags');
    expect(fromFlags.checks[0]).toMatchObject({ criterionId: 'check-1', command: 'node', args: ['--test', 'test/'] });

    const pyFixture = await useFixture('py-bug');
    const detected = await resolveAcceptanceChecks(pyFixture.path, pyFixture.headRevision, []);
    expect(detected.source).toBe('detected');
    expect(detected.checks[0]).toMatchObject({ criterionId: 'python-unittest', command: 'python3' });
  });

  it('reads the checks from the base revision, so a worker cannot rewrite acceptance', async () => {
    const fixture = await useFixture('ts-bug');
    // Someone replaces the check definition in the working tree after the base was taken.
    writeFileSync(
      path.join(fixture.path, '.workforce', 'checks.json'),
      JSON.stringify({ checksVersion: 1, checks: [{ criterionId: 'always-passes', command: 'true' }] }),
    );
    const resolved = await resolveAcceptanceChecks(fixture.path, fixture.headRevision, []);
    expect(resolved.checks.map((c) => c.criterionId)).toEqual(['node-tests-pass']);
  });

  it('rejects an invalid .workforce/checks.json instead of silently ignoring it', async () => {
    const fixture = await useFixture('ts-bug');
    writeFileSync(path.join(fixture.path, '.workforce', 'checks.json'), JSON.stringify({ checksVersion: 1, checks: [{ criterionId: 'x' }] }));
    await execFileAsync('git', ['add', '-A'], { cwd: fixture.path });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-verify', '-m', 'break checks'], { cwd: fixture.path });
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path })).stdout.trim();

    await expect(resolveAcceptanceChecks(fixture.path, head, [])).rejects.toThrow(/is invalid/);
  });
});

describe('--check tokenization never builds a shell string', () => {
  it('splits on whitespace with quoting support', () => {
    expect(tokenizeCheckCommand('npm test')).toEqual(['npm', 'test']);
    expect(tokenizeCheckCommand('node --test "test dir/"')).toEqual(['node', '--test', 'test dir/']);
    expect(tokenizeCheckCommand("python3 -m unittest discover -s 'my tests'")).toEqual(['python3', '-m', 'unittest', 'discover', '-s', 'my tests']);
    expect(checksFromFlags(['npm test', 'npm run lint'])).toEqual([
      expect.objectContaining({ criterionId: 'check-1', command: 'npm', args: ['test'] }),
      expect.objectContaining({ criterionId: 'check-2', command: 'npm', args: ['run', 'lint'] }),
    ]);
  });

  it('refuses shell metacharacters rather than pretending they work', () => {
    for (const value of ['npm test | tee log', 'a && b', 'echo $HOME', 'cat < file', 'rm -rf /; echo done']) {
      expect(() => tokenizeCheckCommand(value)).toThrow(/never through a shell/);
    }
    expect(() => tokenizeCheckCommand('node "unterminated')).toThrow(/unterminated/);
    expect(() => tokenizeCheckCommand('   ')).toThrow(/must name a command/);
  });
});

describe('the prompt keeps the user wording and states the rules', () => {
  it('sends the original request verbatim plus repository context', async () => {
    const h = await harness();
    const result = await h.run(fixTheBugScenario());
    const events = readFileSync(path.join(result.runDir, 'artifacts', 'logs', 'runtime-events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    const started = events.find((event) => event.kind === 'turn_started');
    const prompt = String(started!.payload['prompt']);

    expect(prompt.startsWith(REQUEST_TEXT)).toBe(true);
    expect(prompt).toContain(`Base revision: ${h.headRevision}`);
    expect(prompt).toContain('Changed-file rules:');
    expect(prompt).toContain('do not touch .git');
    expect(prompt).toContain('node-tests-pass');
    expect(prompt).toContain('reporting success does not mark the task accepted');
  });
});

describe('tasks are listed under their run', () => {
  it('records exactly one task with the request objective', async () => {
    const h = await harness();
    const result = await h.run(fixTheBugScenario());
    readState(h.stateRoot, (db) => {
      const tasks = listTasks(db, result.runId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.objective).toBe(REQUEST_TEXT);
      expect(tasks[0]!.owner_agent_id).toBe('engineer');
    });
  });
});

/**
 * The defect this exercises: the run-level boundary claim used to be read off
 * the adapter's static capability table, so a run whose OWN EVIDENCE listed a
 * successful write outside the granted paths still recorded that a boundary
 * had held. A table states what is expected of a runtime; only evidence can
 * state what happened in one run (plan section 8; AT12).
 */
describe('the run records the write boundary it observed, not the one its adapter claims (AT12)', () => {
  /** An adapter that asserts a boundary the fake runtime does not have. */
  class ClaimsAWriteBoundary extends FakeAdapter {
    override capabilities(): RuntimeCapabilities {
      const base = super.capabilities();
      return {
        ...base,
        capabilities: {
          ...base.capabilities,
          write_containment: {
            status: 'verified',
            testedVersion: FAKE_RUNTIME_VERSION,
            os: process.platform,
            note: 'asserted by this table and enforced by nothing, which is exactly what a run must not take on trust',
          },
        },
      };
    }
  }

  async function runClaiming(scenario: FakeScenario): Promise<{ result: RunDirectResult; lines: string[] }> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-claimed-boundary-state-');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-claimed-boundary-config-'));
    const scenarioPath = writeScenario(scenario);
    const lines: string[] = [];
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const loaded = loadAgentConfigFile(configPath);
      // No --allow-unconfined-writes: the claimed boundary is what gets this
      // run past the setup gate, which is the whole point.
      const result = await runDirect({
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: REQUEST_TEXT,
        requestSource: 'argument',
        paths,
        db: store.db,
        stream: { line: (text) => lines.push(text), event: () => {} },
        adapterFactory: () => new ClaimsAWriteBoundary({ scenarioPath }),
      });
      return { result, lines };
    } finally {
      store.close();
    }
  }

  it('records that the boundary did NOT hold when the run\'s own evidence lists an escape', async () => {
    const { result, lines } = await runClaiming(fixAndEscapeScenario());

    const containment = result.manifest.evidence['containment'] as Record<string, unknown>;
    // The table said one thing; the run saw another, and the run records what it saw.
    expect(containment['writeContainment']).toBe('verified');
    expect(containment['expectedWriteBoundary']).toBe(true);
    expect(containment['enforcedWriteBoundary']).toBe(false);
    expect((containment['boundaryFindings'] as string[]).join(' ')).toContain('wrote outside the granted paths');
    expect(String(result.manifest.evidence['containmentNote'])).toContain('THE WRITE BOUNDARY DID NOT HOLD IN THIS RUN');
    expect(result.manifest.evidence['writeObservation']).toMatchObject({ enforcedWriteBoundary: false, expectedWriteBoundary: true, complete: false });

    // And a person watching the run is told, rather than having to read a manifest.
    expect(lines.join('\n')).toContain('WARNING: THE WRITE BOUNDARY DID NOT HOLD IN THIS RUN');
    expect(result.manifest.unresolved.join(' ')).toContain('does not record that its write boundary held');
    expect(readFileSync(result.summaryPath, 'utf8')).toContain('the boundary did NOT hold');
    // The escape still blocks acceptance, as it always did.
    expect(result.acceptance.accepted).toBe(false);
  });

  it('still records that the boundary held when nothing the run observed contradicts it', async () => {
    const { result, lines } = await runClaiming(fixTheBugScenario());

    const containment = result.manifest.evidence['containment'] as Record<string, unknown>;
    expect(containment['enforcedWriteBoundary']).toBe(true);
    expect(containment['boundaryFindings']).toEqual([]);
    expect(result.manifest.evidence['writeObservation']).toMatchObject({ enforcedWriteBoundary: true, complete: true });
    expect(lines.join('\n')).toContain('write boundary: held in this run');
    expect(result.outcome).toBe('accepted');
  });

  it('records an escape on a runtime that never claimed a boundary as one too (AT12)', async () => {
    const h = await harness();

    const result = await h.run(fixAndEscapeScenario());

    const containment = result.manifest.evidence['containment'] as Record<string, unknown>;
    expect(containment['writeContainment']).toBe('unsupported');
    expect(containment['expectedWriteBoundary']).toBe(false);
    expect(containment['enforcedWriteBoundary']).toBe(false);
    expect((containment['boundaryFindings'] as string[]).join(' ')).toContain('wrote outside the granted paths');
    expect(result.acceptance.accepted).toBe(false);
  });
});

describe('observeWriteBoundary reads the run, not the table', () => {
  const enforcing: ContainmentAssessment = {
    policy: 'local-development',
    writes: true,
    status: 'verified',
    note: 'a runtime with a real sandbox',
    testedVersion: '1.0.0',
    os: 'darwin',
    unconfinedWrites: false,
    installedVersion: '1.0.0',
    untestedVersion: false,
    acknowledged: false,
  };

  function change(payload: Record<string, unknown>): RuntimeEvent {
    return { kind: 'file_change', adapter: 'codex', sessionId: 's', turnId: 't', spawnToken: 'k', sequence: 1, timestamp: new Date().toISOString(), payload, rawRef: 'raw:1' };
  }

  /** A real evidence summary — an empty turn — so the shape is never hand-rolled. */
  function evidenceWith(overrides: Partial<TurnEvidence> = {}): TurnEvidence {
    return { ...summarizeTurnEvidence([]), ...overrides };
  }

  function sessionStarted(payload: Record<string, unknown>): RuntimeEvent {
    return { kind: 'session_started', adapter: 'codex', sessionId: 's', turnId: null, spawnToken: 'k', sequence: 0, timestamp: new Date().toISOString(), payload, rawRef: 'raw:0' };
  }

  it('holds when a boundary is expected and the run saw nothing against it', () => {
    const observed = observeWriteBoundary({ containment: enforcing, evidence: evidenceWith(), events: [] });
    expect(observed).toMatchObject({ expected: true, held: true, findings: [] });
  });

  it('does not hold when the runtime reports it applied a different profile than the one requested', () => {
    // Both installed runtimes state what took effect — codex echoes the
    // sandbox it started the thread with, Claude Code states the tool surface
    // it granted — and both answers used to be dropped. A run whose runtime
    // says it applied something else has not observed an escape and has not
    // observed the requested boundary either: "not established", never "held".
    const events = [
      sessionStarted({
        profileMismatch: [
          {
            aspect: 'sandbox',
            requested: 'workspaceWrite',
            reported: 'readOnly',
            detail: 'the server reports it started this thread with "readOnly"',
          },
        ],
      }),
    ];
    const observed = observeWriteBoundary({ containment: enforcing, evidence: evidenceWith(), events });

    expect(observed.held).toBeNull();
    expect(observed.findings.join(' ')).toContain('applied a different sandbox');
    expect(observed.findings.join(' ')).toContain('reported readOnly');
  });

  it('still records an escape as an escape when the runtime also contradicted the profile', () => {
    const events = [
      change({ itemId: 'item-1', withinAllowedPaths: false, path: '/elsewhere/x', phase: 'completed' }),
      sessionStarted({ profileMismatch: [{ aspect: 'tools', requested: 'Glob, Grep, Read', reported: 'Bash, Glob, Grep, Read', detail: 'Bash was granted' }] }),
    ];
    const observed = observeWriteBoundary({
      containment: enforcing,
      evidence: evidenceWith({ fileChangesOutsideAllowedPaths: ['/elsewhere/x'] }),
      events,
    });

    expect(observed.held).toBe(false);
    expect(observed.findings.join(' ')).toContain('wrote outside the granted paths');
    expect(observed.findings.join(' ')).toContain('applied a different tools');
  });

  it('does not hold when a change cannot be placed inside the granted paths', () => {
    // The Codex adapter reports exactly this for a fileChange item that names
    // no path: a change happened, and nothing says where.
    const events = [change({ itemId: 'item-1', withinAllowedPaths: null, phase: 'completed' })];
    const observed = observeWriteBoundary({ containment: enforcing, evidence: evidenceWith(), events });

    expect(observed.held).toBe(false);
    expect(observed.unplaceable).toHaveLength(1);
    expect(observed.findings.join(' ')).toContain('cannot be placed inside the granted paths');
  });

  it('ignores a change the runtime refused: nothing was written, so there is nothing to place', () => {
    const events = [change({ itemId: 'item-1', withinAllowedPaths: null, denied: true, phase: 'completed' })];
    expect(observeWriteBoundary({ containment: enforcing, evidence: evidenceWith(), events }).held).toBe(true);
  });

  it('counts the two halves of one reported change once', () => {
    const events = [
      change({ itemId: 'item-1', withinAllowedPaths: null, phase: 'started' }),
      change({ itemId: 'item-1', withinAllowedPaths: null, phase: 'completed' }),
    ];
    expect(readUnplaceableChanges(events)).toHaveLength(1);
  });

  it('establishes nothing when there is no turn evidence at all', () => {
    const observed = observeWriteBoundary({ containment: enforcing, evidence: null, events: [] });
    expect(observed.held).toBeNull();
    expect(observed.findings.join(' ')).toContain('no turn evidence was collected');
  });

  it('says nothing about a profile that grants no writes', () => {
    const readOnly: ContainmentAssessment = { ...enforcing, policy: 'analysis', writes: false };
    expect(observeWriteBoundary({ containment: readOnly, evidence: evidenceWith(), events: [] })).toMatchObject({ expected: null, held: null });
  });
});

/**
 * The run refuses before it builds anything when the runtime cannot work
 * (findings on run-direct: no credential preflight, and a containment status
 * read without reading the version it was established against).
 *
 * What this closes: a run against a signed-out runtime used to create a
 * worktree and a branch, open a session, spend 26 seconds inside the
 * provider's own reconnect loop, get `401 Unauthorized`, run an acceptance
 * check against an unchanged base and exit 4 under the headline "criterion
 * node-tests-pass failed" — a code-failure framing for a credential problem.
 */
describe('the run asks whether the runtime can work before it creates anything', () => {
  /** A fake runtime whose readiness probe answers whatever a test needs. */
  class ProbesAs extends FakeAdapter {
    sessionsOpened = 0;
    constructor(
      private readonly readiness: { authentication?: 'logged_in' | 'logged_out' | 'unknown' | 'not_required'; version?: string | null },
      options: ConstructorParameters<typeof FakeAdapter>[0],
    ) {
      super(options);
    }

    override async probe(executablePath: string): Promise<Awaited<ReturnType<FakeAdapter['probe']>>> {
      const base = await super.probe(executablePath);
      return { ...base, ...this.readiness };
    }

    override capabilities(): RuntimeCapabilities {
      const base = super.capabilities();
      return {
        ...base,
        capabilities: {
          ...base.capabilities,
          write_containment: { status: 'verified', testedVersion: FAKE_RUNTIME_VERSION, os: process.platform, note: 'a boundary established for one build only' },
        },
      };
    }

    override async openSession(input: Parameters<FakeAdapter['openSession']>[0]): ReturnType<FakeAdapter['openSession']> {
      this.sessionsOpened += 1;
      return super.openSession(input);
    }
  }

  async function runWith(
    readiness: { authentication?: 'logged_in' | 'logged_out' | 'unknown' | 'not_required'; version?: string | null },
    options: { allowUnconfinedWrites?: boolean } = {},
  ): Promise<{ error: unknown; adapters: ProbesAs[]; lines: string[] }> {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-preflight-state-');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-preflight-config-'));
    const scenarioPath = writeScenario(fixTheBugScenario());
    const paths = createStatePaths(stateRoot);
    const store = openStateStore(paths, { mode: 'mutating' });
    const adapters: ProbesAs[] = [];
    const lines: string[] = [];
    try {
      const loaded = loadAgentConfigFile(configPath);
      let error: unknown = null;
      try {
        await runDirect({
          repoPath: fixture.path,
          config: loaded.config,
          configRaw: loaded.raw,
          configPath: loaded.path,
          requestText: REQUEST_TEXT,
          requestSource: 'argument',
          paths,
          db: store.db,
          stream: { line: (text) => lines.push(text), event: () => {} },
          sessionEnv: { [FAKE_SCENARIO_ENV]: scenarioPath },
          ...(options.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
          adapterFactory: (runtimeRef) => {
            const adapter = new ProbesAs(readiness, { scriptPath: runtimeRef.executable });
            adapters.push(adapter);
            return adapter;
          },
        });
      } catch (caught) {
        error = caught;
      }
      return { error, adapters, lines };
    } finally {
      store.close();
    }
  }

  it('refuses a signed-out runtime with the one code that means "only you can fix this"', async () => {
    const { error, adapters } = await runWith({ authentication: 'logged_out' });

    expect(error).toBeInstanceOf(RunSetupError);
    expect((error as RunSetupError).code).toBe('runtime_not_logged_in');
    expect((error as Error).message).toContain('log in interactively');
    // Nothing was dispatched: no session, so no turn, so no retry storm.
    expect(adapters.every((adapter) => adapter.sessionsOpened === 0)).toBe(true);
  });

  it('refuses a writing profile on a build the write boundary was never established against', async () => {
    const { error } = await runWith({ version: '99.0.0' });

    expect(error).toBeInstanceOf(RunSetupError);
    expect((error as RunSetupError).code).toBe('write_boundary_untested_version');
    expect((error as Error).message).toContain('99.0.0');
    expect((error as Error).message).toContain(FAKE_RUNTIME_VERSION);
  });

  it('lets an explicitly accepted unconfined run past that gate, and records why it was needed', async () => {
    const { error, lines } = await runWith({ version: '99.0.0' }, { allowUnconfinedWrites: true });

    expect(error).toBeNull();
    expect(lines.join('\n')).toContain('the write boundary was never established for this build');
  });

  it('does not refuse a run whose readiness could not be established, and says so', async () => {
    // The direction that must never be blocked: `claude auth status` and the
    // runtime have disagreed in both directions on the installed build, so a
    // probe that could not establish a login must not be able to stop a run
    // that would have worked.
    const { error, lines } = await runWith({ authentication: 'unknown' });

    expect(error).toBeNull();
    expect(lines.join('\n')).toContain('could not establish whether the runtime is logged in');
  });
});
