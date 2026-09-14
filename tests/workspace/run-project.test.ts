import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFakeRuntimeScript, FAKE_SCENARIO_ENV, FakeAdapter, type SessionInput, type SessionHandle } from '../../src/adapters/index.js';
import { HEAD_REVIEW_TOOL } from '../../src/routing/head-reviewer.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { git } from '../../src/workspaces/git.js';
import { commandRun } from '../../src/cli/commands/run.js';
import { CliError, EXIT_CODES, Reporter } from '../../src/cli/output.js';
import type { HeadPlanner, HeadPlanningInput } from '../../src/workspace/planning.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import {
  cleanupAll as cleanupFixtures,
  fingerprintCheckout,
  fixTheBugScenario,
  registerCleanup as registerFixtureCleanup,
  useFixture,
  writeScenario,
} from '../workspaces/support.js';
import { build, cleanupAll, gitRepo, invoke, jsonOf, sink, tempDir } from './helpers.js';

afterEach(() => {
  cleanupAll();
  cleanupFixtures();
});

/**
 * Project "app" (the given repository) and project "other" (a folder that does
 * not exist). Department "eng": head atlas, worker nova on app, bench on no
 * project, elsewhere on other. Department "design": no head, worker mo on app.
 */
function setupWorkspace(stateRoot: string, repoPath: string, extra: ReadonlyArray<Record<string, unknown>> = []): void {
  updateWorkspace(
    stateRoot,
    (current) =>
      build(
        [
          { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
          { op: 'project.add', repoPath, id: 'app' },
          { op: 'project.add', repoPath: path.join(tempDir('workforce-ws-gone-'), 'missing'), id: 'other' },
          { op: 'department.add', name: 'Engineering', id: 'eng' },
          { op: 'agent.add', id: 'atlas', role: 'head', departmentId: 'eng', runtime: 'fake-local' },
          { op: 'agent.add', id: 'nova', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'fake-local', projectIds: ['app'] },
          { op: 'agent.add', id: 'bench', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'fake-local' },
          { op: 'agent.add', id: 'elsewhere', role: 'worker', projectScope: 'restricted', departmentId: 'eng', runtime: 'fake-local', projectIds: ['other'] },
          { op: 'department.add', name: 'Design', id: 'design' },
          { op: 'agent.add', id: 'mo', role: 'worker', projectScope: 'restricted', departmentId: 'design', runtime: 'fake-local', projectIds: ['app'] },
          ...extra,
        ],
        current,
      ),
    { createIfMissing: true },
  );
}

function runArgs(stateRoot: string, project: string, department: string, ...more: string[]): string[] {
  return ['run', '--project', project, '--department', department, '--task', 'Fix the pagination off-by-one.', '--state-dir', stateRoot, ...more];
}

function useScenario(): void {
  const scenarioPath = writeScenario(fixTheBugScenario());
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = scenarioPath;
  registerFixtureCleanup(() => {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  });
}

/** Script the head decision against the real combined candidate identity. */
class ReviewAwareFakeAdapter extends FakeAdapter {
  override async openSession(input: SessionInput): Promise<SessionHandle> {
    if (!input.systemInstructions.includes('For this turn, review the completed candidate as department head.')) return super.openSession(input);
    const revision = await git(['rev-parse', 'HEAD'], { cwd: input.cwd });
    const base = await git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: input.cwd });
    const patch = await git(['diff', '--binary', '--no-ext-diff', `${base.stdout.trim()}..${revision.stdout.trim()}`], { cwd: input.cwd });
    expect(revision.ok && base.ok && patch.ok).toBe(true);
    expect(patch.stdout).toContain('src/pagination.js');
    const scenario = writeScenario({ scenarioVersion: 1, steps: [
      { action: 'call_tool', tool: HEAD_REVIEW_TOOL, arguments: { reviewVersion: 1, candidateRevision: revision.stdout.trim(), diffHash: sha256Hex(Buffer.from(patch.stdout, 'utf8')), verdict: 'approve', summary: 'Corrected both pagination boundary errors. The unchanged project tests pass on the combined candidate; the head reviewed the implementation against the original request.', findings: [] } },
      { action: 'claim_done', message: 'Review submitted through the bridge.' },
    ] });
    return super.openSession({ ...input, env: { ...input.env, [FAKE_SCENARIO_ENV]: scenario } });
  }
}

async function runWithPlanner(stateRoot: string, planner: HeadPlanner) {
  let stdout = '';
  let stderr = '';
  const streams = { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) };
  try {
    const result = await commandRun(
      { project: 'app', department: 'eng', task: 'Fix the pagination off-by-one.', stateDir: stateRoot, allowUnconfinedWrites: true, json: false },
      { reporter: new Reporter(false, streams), streams, headPlanner: planner, adapterFactory: () => new ReviewAwareFakeAdapter() },
    );
    return { result, error: null, stdout, stderr };
  } catch (error) {
    if (error instanceof CliError) return { result: null, error, stdout, stderr };
    throw error;
  }
}

describe('workforce run --project --department: refusals before any state exists', () => {
  it('refuses to mix the department form with --repo, --agents or --check, and needs both ids', async () => {
    const stateRoot = tempDir();
    for (const extra of [['--repo', '/tmp'], ['--agents', 'agents.json'], ['--check', 'npm test']]) {
      const result = await invoke(runArgs(stateRoot, 'app', 'eng', ...extra));
      expect({ extra, code: result.code }).toEqual({ extra, code: EXIT_CODES.invalidInput });
      expect(result.stderr).toMatch(/cannot be combined with/);
    }
    const noDepartment = await invoke(['run', '--project', 'app', '--task', 'x', '--state-dir', stateRoot, '--json']);
    expect([noDepartment.code, (jsonOf(noDepartment)['error'] as { code: string }).code]).toEqual([2, 'missing_department']);
    const noProject = await invoke(['run', '--department', 'eng', '--task', 'x', '--state-dir', stateRoot, '--json']);
    expect([noProject.code, (jsonOf(noProject)['error'] as { code: string }).code]).toEqual([2, 'missing_project']);
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  it('refuses an unknown project in a state root with no workspace, and says so', async () => {
    const stateRoot = tempDir();
    const result = await invoke([...runArgs(stateRoot, 'app', 'eng'), '--json']);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    const error = jsonOf(result)['error'] as { code: string; details: string[] };
    expect(error.code).toBe('unknown_project');
    expect(error.details.join('\n')).toMatch(/there is no workspace/);
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  it('refuses an unknown or archived id, a headless department and a project nobody is placed on, each with exit 2', async () => {
    const repo = await gitRepo({ 'README.md': 'app\n' });
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, repo, [
      { op: 'department.add', name: 'Ops', id: 'ops' },
      { op: 'agent.add', id: 'opshead', role: 'head', departmentId: 'ops', runtime: 'fake-local' },
      { op: 'department.add', name: 'Old', id: 'old' },
      { op: 'department.archive', id: 'old' },
      { op: 'project.add', repoPath: path.join(repo, 'nested-not-a-repo-root'), id: 'shelved' },
      { op: 'project.archive', id: 'shelved' },
    ]);
    const cases: Array<[string, string, string]> = [
      ['ghost', 'eng', 'unknown_project'],
      ['app', 'ghost', 'unknown_department'],
      ['shelved', 'eng', 'project_archived'],
      ['app', 'old', 'department_archived'],
      ['app', 'design', 'department_has_no_head'],
      ['app', 'ops', 'no_worker_on_project'],
      ['other', 'eng', 'project_unavailable'],
    ];
    for (const [project, department, code] of cases) {
      const result = await invoke([...runArgs(stateRoot, project, department), '--json']);
      const error = jsonOf(result)['error'] as { code: string; message: string };
      expect({ project, department, exit: result.code, code: error.code }).toEqual({ project, department, exit: EXIT_CODES.invalidInput, code });
      expect(error.message.length).toBeGreaterThan(10);
    }
    expect(existsSync(path.join(stateRoot, 'projects'))).toBe(false);
  });

  it('refuses a project with no acceptance check before taking any lock or writing any state', async () => {
    const repo = await gitRepo({ 'README.md': 'no tests here\n' });
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, repo);
    const result = await invoke([...runArgs(stateRoot, 'app', 'eng'), '--json']);
    expect(result.code).toBe(EXIT_CODES.invalidInput);
    const error = jsonOf(result)['error'] as { code: string; details: string[] };
    expect(error.code).toBe('project_has_no_checks');
    expect(error.details.join('\n')).toMatch(/workspace project edit app --check/);
    expect(existsSync(path.join(stateRoot, 'projects'))).toBe(false);
  });
});

describe('workforce run --project --department: the head decides', () => {
  it('asks the department head by default: a head that answers in prose starts no worker, and the run records only the roster', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, fixture.path);
    const before = await fingerprintCheckout(fixture.path);

    // No scenario: the fake head only says "done", which is not a plan.
    const result = await invoke([...runArgs(stateRoot, 'app', 'eng'), '--json']);
    expect(result.code).toBe(EXIT_CODES.executionFailure);
    const error = jsonOf(result)['error'] as { code: string; message: string; details: string[] };
    expect(error.code).toBe('plan_rejected');
    expect(error.message).toBe('department head "atlas" did not produce a valid plan in 2 attempt(s), so no worker was started');
    expect(error.details.join('\n')).toMatch(/no_plan_proposed/);

    const projectRoot = path.join(stateRoot, 'projects', 'app');
    const runs = readdirSync(path.join(projectRoot, 'runs'));
    expect(runs).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'runs', runs[0]!, 'planned-result.json'), 'utf8')) as { accepted: boolean; tasks: unknown[] };
    expect(manifest).toMatchObject({ accepted: false, tasks: [] });
    const rosters = readdirSync(path.join(projectRoot, 'rosters'));
    expect(rosters).toHaveLength(1);
    const snapshot = JSON.parse(readFileSync(path.join(projectRoot, 'rosters', rosters[0]!), 'utf8')) as { agents: Array<{ id: string }>; defaults: Record<string, unknown> };
    // bench is on no project, elsewhere is on another project, mo is in another department.
    expect(snapshot.agents.map((a) => a.id)).toEqual(['atlas', 'nova']);
    expect(snapshot.defaults).toMatchObject({ plannerAgent: 'atlas', workerAgent: 'nova' });
    // The coordinator lock of the project was released, and nothing was written at the top of the state root.
    expect(existsSync(path.join(projectRoot, 'coordinator.lock'))).toBe(false);
    expect(existsSync(path.join(stateRoot, 'state.sqlite'))).toBe(false);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  });

  it('refuses a plan that assigns work to the head or to anyone off the roster, and starts no worker', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, fixture.path);
    for (const assignee of ['mo', 'atlas', 'bench']) {
      const outcome = await runWithPlanner(stateRoot, async () => ({ ok: true, summary: null, tasks: [{ key: 'fix', objective: 'Fix it', agentId: assignee }] }));
      expect(outcome.error?.exitCode).toBe(EXIT_CODES.executionFailure);
      expect(outcome.error?.code).toBe('plan_rejected');
      expect(outcome.error?.details.join('\n')).toMatch(new RegExp(`"${assignee}"`));
    }
    expect(readdirSync(path.join(stateRoot, 'projects', 'app', 'runs'))).toEqual([]);
  });

  it('passes a planner refusal through with its own code and exit code', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, fixture.path);
    const outcome = await runWithPlanner(stateRoot, async () => ({ ok: false, code: 'head_runtime_not_logged_in', reason: 'the head is signed out', exitCode: 3 }));
    expect([outcome.error?.exitCode, outcome.error?.code, outcome.error?.message]).toEqual([3, 'head_runtime_not_logged_in', 'the head is signed out']);
  });

  it('runs the head\'s tasks through the roster worker in the project\'s own state root, to a verified candidate', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir();
    setupWorkspace(stateRoot, fixture.path);
    useScenario();
    const before = await fingerprintCheckout(fixture.path);

    let seen: HeadPlanningInput | null = null;
    const outcome = await runWithPlanner(stateRoot, async (input) => {
      seen = input;
      return { ok: true, summary: 'one bounded fix', tasks: [{ key: 'fix', objective: 'Fix the pagination off-by-one.', agentId: 'nova' }] };
    });
    expect(outcome.error).toBeNull();
    const result = outcome.result!;
    expect(result.exitCode).toBe(EXIT_CODES.verifiedCandidate);

    const projectRoot = path.join(stateRoot, 'projects', 'app');
    expect(result.data).toMatchObject({ accepted: true, stateRoot: projectRoot, project: 'app', department: 'eng', head: 'atlas', workers: ['nova'] });
    expect(result.data).not.toHaveProperty('route');
    expect(result.data['headReview']).toMatchObject({ headAgentId: 'atlas', verdict: 'passed', sessionStopped: true });
    expect(result.data['finalReply']).toContain('Corrected both pagination boundary errors');

    // The planner was given the roster and the project's own state, with the lock held.
    const input = seen as HeadPlanningInput | null;
    expect(input?.paths.root).toBe(projectRoot);
    expect(input?.roster.workers.map((w) => w.id)).toEqual(['nova']);
    expect(input?.repoPath).toBe(fixture.path);

    // The run recorded the roster as its configuration, so a resume can only bind roster agents.
    const runDir = result.data['runDir'] as string;
    expect(runDir.startsWith(path.join(projectRoot, 'runs'))).toBe(true);
    const recorded = JSON.parse(readFileSync(path.join(runDir, 'config-snapshot.json'), 'utf8')) as { raw: { agents: Array<{ id: string }> }; configPath: string };
    expect(recorded.raw.agents.map((a) => a.id)).toEqual(['atlas', 'nova']);
    expect(recorded.configPath).toBe(result.data['rosterSnapshot']);

    expect(existsSync(path.join(stateRoot, 'state.sqlite'))).toBe(false);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  });
});
