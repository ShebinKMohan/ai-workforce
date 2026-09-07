import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import {
  checksFromFlags,
  resolveAcceptanceChecks,
  runDirect,
  tokenizeCheckCommand,
  type RunDirectResult,
  type RunStream,
} from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { getAttempt, getRun, getTask, listTasks } from '../../src/storage/records.js';
import { listEvents } from '../../src/storage/events.js';
import { listArtifacts } from '../../src/storage/artifacts.js';
import { listChecks } from '../../src/verification/checks.js';
import { gitTextOrNull } from '../../src/workspaces/git.js';
import {
  claimDoneWithoutEditingScenario,
  cleanupAll,
  fingerprintCheckout,
  fixedPaginationSource,
  fixTheBugScenario,
  fixThePythonBugScenario,
  longRunningScenario,
  registerCleanup,
  runtimeExitsScenario,
  tempDir,
  useFixture,
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
  run(scenario: FakeScenario, options?: { checkFlags?: string[]; signal?: AbortSignal }): Promise<RunDirectResult>;
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

  it('stops the worker, preserves the work and reports an interruption on abort (FR039)', async () => {
    const h = await harness();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);

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
  });

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

  it('refuses to start when no acceptance checks can be resolved', async () => {
    const h = await harness('py-bug');
    // Remove the Python tests from the base revision so nothing is detectable.
    await execFileAsync('git', ['rm', '-r', '--quiet', 'tests'], { cwd: h.repo });
    await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-verify', '-m', 'drop tests'], { cwd: h.repo });

    await expect(h.run(fixTheBugScenario())).rejects.toMatchObject({ code: 'no_acceptance_checks' });
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
