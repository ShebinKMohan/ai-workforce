import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { runCli } from '../../src/cli/index.js';
import { EXIT_CODES } from '../../src/cli/output.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import {
  claimDoneWithoutEditingScenario,
  cleanupAll,
  fingerprintCheckout,
  fixTheBugScenario,
  registerCleanup,
  tempDir,
  useFixture,
  writeFakeAgentsConfig,
  writeScenario,
} from '../workspaces/support.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

afterEach(() => cleanupAll());

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

async function invoke(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const code = await runCli(argv, { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) });
  return { stdout, stderr, code };
}

function useScenario(scenario: ReturnType<typeof fixTheBugScenario>): void {
  const scenarioPath = writeScenario(scenario);
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = scenarioPath;
  registerCleanup(() => {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  });
}

describe('workforce run end to end', () => {
  it('exits 0 with a verified candidate and leaves the checkout alone', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(fixTheBugScenario());
    const before = await fingerprintCheckout(fixture.path);

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateDir]);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(result.stdout).toContain('accepted');
    expect(result.stdout).toContain('PASS node-tests-pass');
    // The coordinator lock is released again.
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(false);

    const after = await fingerprintCheckout(fixture.path);
    expect(after.tree).toBe(before.tree);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
  });

  it('takes the planned path from a --plan file, dependencies and all', async () => {
    // The dependency graph reaching the orchestrator from the CLI is the
    // point: `decomposeRequest` never emits dependencies, so without a plan
    // file `PlannedTaskInput.dependencies` is unreachable from the product.
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-plan-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-plan-config-'), { planner: true });
    useScenario(fixTheBugScenario());
    const planPath = path.join(tempDir('workforce-cli-plan-file-'), 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        tasks: [
          { key: 'fix', objective: 'Fix the pagination off-by-one.' },
          { key: 'after', objective: 'Fix the pagination off-by-one.', dependencies: ['fix'] },
        ],
      }),
    );

    const result = await invoke([
      'run',
      '--repo',
      fixture.path,
      '--agents',
      configPath,
      '--task',
      'Fix the pagination off-by-one.',
      '--plan',
      planPath,
      '--state-dir',
      stateDir,
      '--json',
    ]);

    // Both tasks were dispatched, in dependency order, on the planned path.
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const final = lines[lines.length - 1] as { path?: string; route?: { path?: string }; tasks?: Array<{ key: string; accepted: boolean }> };
    expect(final.path).toBe('planned');
    expect(final.route?.path).toBe('planned');
    // Both tasks were dispatched, in the order the plan named them, and each
    // reached acceptance on its own branch. (They edit the same file here, so
    // the combination is then correctly refused — which is AT13's rule, not
    // this test's subject.)
    expect(final.tasks?.map((task) => task.key)).toEqual(['fix', 'after']);
    expect(final.tasks?.every((task) => task.accepted)).toBe(true);
  });

  it('refuses a plan whose dependencies form a cycle, before any work starts', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-cycle-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-cycle-config-'), { planner: true });
    useScenario(fixTheBugScenario());
    const planPath = path.join(tempDir('workforce-cli-cycle-file-'), 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        tasks: [
          { key: 'a', objective: 'One.', dependencies: ['b'] },
          { key: 'b', objective: 'Two.', dependencies: ['a'] },
        ],
      }),
    );

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Do both.', '--plan', planPath, '--state-dir', stateDir]);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stderr).toContain('dependency cycle');
  });

  it('exits 4 when the runtime claims success without changing anything', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(claimDoneWithoutEditingScenario());

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateDir]);

    expect(result.code).toBe(EXIT_CODES.executionFailure);
    expect(result.stdout).toContain('FAIL node-tests-pass');
    expect(result.stdout).not.toContain('run accepted');
  });

  it('--json emits JSONL: events first, the result object last', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(fixTheBugScenario());

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--json']);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    const documents = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(documents.length).toBeGreaterThan(3);
    expect(documents.map((d) => d['type'])).toEqual(expect.arrayContaining(['run.created', 'workspace.created', 'check.completed', 'run.accepted']));
    const final = documents[documents.length - 1]!;
    expect(final).toMatchObject({ ok: true, command: 'run', exitCode: 0, outcome: 'accepted', accepted: true });
    // Human progress goes to stderr so stdout stays machine-readable.
    expect(result.stderr).toContain('candidate workspace');
  });

  it('accepts repeated --check flags in place of the repository configuration', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(fixTheBugScenario());

    const result = await invoke([
      'run',
      '--repo',
      fixture.path,
      '--agents',
      configPath,
      '--task',
      'Fix it.',
      '--state-dir',
      stateDir,
      '--check',
      'node --test test/',
      '--check',
      'node -e "process.exit(0)"',
      '--json',
    ]);

    expect(result.code).toBe(EXIT_CODES.verifiedCandidate);
    const final = JSON.parse(result.stdout.trim().split('\n').pop()!) as { requirements: Array<{ criterionId: string; status: string }> };
    expect(final.requirements.map((r) => r.criterionId)).toEqual(['check-1', 'check-2']);
    expect(final.requirements.every((r) => r.status === 'passed')).toBe(true);
  });

  it('rejects a --check that needs a shell with exit 2 and no state', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(fixTheBugScenario());

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--check', 'npm test | tee out.log']);

    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stderr).toContain('never through a shell');
  });

  it('rejects an unknown --agent before taking the lock', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));

    const result = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--agent', 'nobody']);

    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stderr).toContain('is not defined in');
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe('workforce status is read-only and works from another process (FR061)', () => {
  it('reports a finished run from a separate process while this one holds the coordinator lock', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-cli-config-'));
    useScenario(fixTheBugScenario());

    const run = await invoke(['run', '--repo', fixture.path, '--agents', configPath, '--task', 'Fix it.', '--state-dir', stateDir, '--json']);
    expect(run.code).toBe(EXIT_CODES.verifiedCandidate);
    const final = JSON.parse(run.stdout.trim().split('\n').pop()!) as { runId: string };

    // Hold the coordinator lock, exactly as a second run in progress would.
    const paths = createStatePaths(stateDir);
    const holder = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => holder.close());
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(true);

    // A separate OS process inspects the run while the lock is held.
    const status = await execFileAsync(process.execPath, ['--import', 'tsx', CLI_ENTRY, 'status', final.runId, '--state-dir', stateDir, '--json'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const document = JSON.parse(status.stdout.trim()) as Record<string, any>;

    expect(document.ok).toBe(true);
    expect(document.command).toBe('status');
    expect(document.readOnly).toBe(true);
    expect(document.run.id).toBe(final.runId);
    expect(document.run.state).toBe('ready_for_review');
    expect(document.tasks[0].state).toBe('accepted');
    expect(document.checks[0]).toMatchObject({ outcome: 'passed', evidenceProvenance: 'verifier_executed' });
    expect(document.requirements[0]).toMatchObject({ criterionId: 'node-tests-pass', status: 'passed' });
    expect(document.candidate.revision).toEqual(expect.any(String));
    expect(document.artifacts.map((a: { path: string }) => a.path)).toEqual(expect.arrayContaining(['result.json', 'summary.md', 'candidate.patch']));

    // The other process did not steal ownership: our lock is still the one on disk.
    expect(existsSync(path.join(stateDir, 'coordinator.lock'))).toBe(true);
    holder.close();
  }, 60_000);

  it('exits 2 for an unknown run id', async () => {
    const stateDir = path.join(tempDir('workforce-cli-'), 'state');
    const paths = createStatePaths(stateDir);
    openStateStore(paths, { mode: 'mutating' }).close();

    const result = await invoke(['status', 'not-a-run', '--state-dir', stateDir]);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    expect(result.stderr).toContain('not found');
  });
});
