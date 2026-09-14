/**
 * A request to a department, end to end against the deterministic fake runtime.
 *
 * Every piece is the real one: `workforce run --project --department`, the
 * department head's planning session in a read-only copy, its call to
 * `workforce_propose_plan` through a spawned bridge process and the run's
 * coordination socket, plan validation, the workers' own worktrees, the
 * verifier's checks, integration, Stop and Resume. The fake runtime only
 * decides what each model "says", keyed on the prompt it is given.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFakeRuntimeScript, FAKE_SCENARIO_ENV, FakeAdapter, type RuntimeEvent, type TurnHandle, type SessionInput, type SessionHandle } from '../../src/adapters/index.js';
import type { AdapterFactory } from '../../src/core/run-direct.js';
import { commandResume } from '../../src/cli/commands/resume.js';
import { commandRun } from '../../src/cli/commands/run.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult } from '../../src/cli/output.js';
import { HEAD_REVIEW_TOOL } from '../../src/routing/head-reviewer.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { HEAD_PLAN_TOOL, HEAD_RETRY_HEADING } from '../../src/routing/head-planner.js';
import { isProcessAlive, isProcessGroupAlive, observeProcessIdentity } from '../../src/core/process.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent, listEvents, type EventRecord } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { git } from '../../src/workspaces/git.js';
import { build, sink } from '../workspace/helpers.js';
import { cleanupAll, fingerprintCheckout, registerCleanup, tempDir, useFixture, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

const REQUEST = 'Document the pagination helpers and the search endpoint for the new team members.';

const ALPHA = {
  id: 'alpha',
  objective: 'Add docs/alpha.md describing the pagination helpers.',
  assignee: 'nova',
  acceptanceCriteria: [{ id: 'c1', description: 'docs/alpha.md explains pageCount and paginate' }],
  scope: { allowedPaths: ['docs/alpha.md'] },
};
const BETA = {
  id: 'beta',
  objective: 'Add docs/beta.md describing the search endpoint.',
  assignee: 'mira',
  acceptanceCriteria: [{ id: 'c1', description: 'docs/beta.md explains the endpoint' }],
  scope: { allowedPaths: ['docs/beta.md'] },
};

type Step = Record<string, unknown>;

function propose(tasks: ReadonlyArray<Record<string, unknown>>): Step {
  return { action: 'call_tool', tool: HEAD_PLAN_TOOL, arguments: { planVersion: 2, summary: 'Two independent documents, one per worker.', tasks } };
}

function writes(file: string, marker?: string): Step[] {
  return [
    ...(marker !== undefined ? [{ action: 'message', text: marker }] : []),
    { action: 'edit_file', path: file, content: `# ${file}\n\nWritten for ${REQUEST}\n` },
    { action: 'claim_done', message: `Wrote ${file}.` },
  ];
}

/**
 * One scenario for the whole department. A worker is recognised by the
 * objective its prompt STARTS with (its peers' objectives appear later in the
 * same prompt); the head by the planning tool its prompt names; a retry by the
 * heading the coordinator adds to the second prompt.
 */
function departmentScenario(options: { head: Step[]; retry?: Step[]; alpha?: Step[]; beta?: Step[] }): FakeScenario {
  return {
    scenarioVersion: 1,
    byPrompt: [
      { startsWith: ALPHA.objective, steps: options.alpha ?? writes('docs/alpha.md') },
      { startsWith: BETA.objective, steps: options.beta ?? writes('docs/beta.md') },
      ...(options.retry !== undefined ? [{ includes: HEAD_RETRY_HEADING, steps: options.retry }] : []),
      { includes: HEAD_PLAN_TOOL, steps: options.head },
    ],
    steps: [{ action: 'claim_done', message: 'an unscripted prompt reached the fake runtime' }],
  } as FakeScenario;
}

function useScenario(scenario: FakeScenario): void {
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = writeScenario(scenario);
  registerCleanup(() => {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  });
}

/** Project "app" with a check that passes on every revision; department "eng": head atlas, workers nova and mira; "design": mo. */
function setupWorkspace(stateRoot: string, repoPath: string): void {
  updateWorkspace(
    stateRoot,
    (current) =>
      build(
        [
          { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
          { op: 'project.add', repoPath, id: 'app', name: 'Storefront', checks: ['node --version'] },
          { op: 'department.add', name: 'Engineering', id: 'eng' },
          { op: 'agent.add', id: 'atlas', role: 'head', departmentId: 'eng', runtime: 'fake-local' },
          { op: 'agent.add', id: 'nova', role: 'worker', departmentId: 'eng', runtime: 'fake-local', projectIds: ['app'] },
          { op: 'agent.add', id: 'mira', role: 'worker', departmentId: 'eng', runtime: 'fake-local', projectIds: ['app'] },
          { op: 'department.add', name: 'Design', id: 'design' },
          { op: 'agent.add', id: 'mo', role: 'worker', departmentId: 'design', runtime: 'fake-local', projectIds: ['app'] },
        ],
        current,
      ),
    { createIfMissing: true },
  );
}

/** Compute the actual frozen candidate identity at the test adapter boundary. */
class ReviewAwareFakeAdapter extends FakeAdapter {
  constructor(readonly reviewMode: 'approve' | 'reject' | 'pause' = 'approve') { super(); }
  override async openSession(input: SessionInput): Promise<SessionHandle> {
    if (!input.systemInstructions.includes('For this turn, review the completed candidate as department head.')) return super.openSession(input);
    const revision = await git(['rev-parse', 'HEAD'], { cwd: input.cwd });
    const base = await git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: input.cwd });
    const patch = await git(['diff', '--binary', '--no-ext-diff', `${base.stdout.trim()}..${revision.stdout.trim()}`], { cwd: input.cwd });
    expect(revision.ok && base.ok && patch.ok).toBe(true);
    const scenario = writeScenario({ scenarioVersion: 1, steps: [
      ...(this.reviewMode === 'pause' ? [{ action: 'message', text: 'REVIEW-IN-PROGRESS' }, { action: 'sleep', ms: 60_000 }] : []),
      { action: 'call_tool', tool: HEAD_REVIEW_TOOL, arguments: { reviewVersion: 1, candidateRevision: revision.stdout.trim(), diffHash: sha256Hex(Buffer.from(patch.stdout, 'utf8')), verdict: this.reviewMode === 'reject' ? 'changes_requested' : 'approve', summary: this.reviewMode === 'reject' ? 'The documentation omits concrete endpoint usage. Add a request and response example before delivery.' : 'Added the requested team documentation. The independent project checks passed on the combined candidate, and I reviewed both the changes and the original request. The candidate is ready for your review.', findings: this.reviewMode === 'reject' ? [{ summary: 'Add a concrete endpoint usage example.', file: 'docs/beta.md' }] : [] } },
      { action: 'claim_done', message: 'Department head review recorded.' },
    ] } as FakeScenario);
    return super.openSession({ ...input, env: { ...input.env, [FAKE_SCENARIO_ENV]: scenario } });
  }
}

async function runDepartment(stateRoot: string, signal?: AbortSignal, onOutput?: (chunk: string) => void, adapterFactory?: AdapterFactory): Promise<{ result: CommandResult | null; error: CliError | null; stdout: string }> {
  let stdout = '';
  const streams = { stdout: sink((chunk) => { stdout += chunk; onOutput?.(chunk); }), stderr: sink(() => undefined) };
  try {
    const result = await commandRun(
      { project: 'app', department: 'eng', task: REQUEST, stateDir: stateRoot, allowUnconfinedWrites: true, json: false },
      { reporter: new Reporter(false, streams), streams, ...(signal !== undefined ? { signal } : {}), adapterFactory: adapterFactory ?? (() => new ReviewAwareFakeAdapter()) },
    );
    return { result, error: null, stdout };
  } catch (error) {
    if (error instanceof CliError) return { result: null, error, stdout };
    throw error;
  }
}

function readProject<T>(stateRoot: string, fn: (db: DatabaseSync) => T): T {
  const store = openStateStore(createStatePaths(path.join(stateRoot, 'projects', 'app')), { mode: 'read-only' });
  try {
    return fn(store.db);
  } finally {
    store.close();
  }
}

function onlyRunId(stateRoot: string): string {
  const runs = readdirSync(path.join(stateRoot, 'projects', 'app', 'runs'));
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function ofType(events: ReadonlyArray<EventRecord>, type: string): EventRecord[] {
  return events.filter((event) => event.type === type);
}

describe('a request to a department: the head plans, its workers do the work', () => {
  it('surfaces a rejected runtime model request and starts neither a second head nor a worker', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-model-rejected-');
    setupWorkspace(stateRoot, fixture.path);
    useScenario(departmentScenario({ head: [{ action: 'claim_done', message: 'The provider never started inference.' }] }));
    const message = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
    const errorDetail = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message } });
    class RejectedHead extends FakeAdapter {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          if (event.kind === 'assistant_message') {
            yield { ...event, kind: 'error', payload: { fatal: false, message: errorDetail, errorClass: 'unknown', willRetry: false } };
          } else if (event.kind === 'turn_completed') {
            yield { ...event, payload: { status: 'failed', error: errorDetail, errorClass: 'unknown' } };
          } else yield event;
        }
      }
    }
    const { error } = await runDepartment(stateRoot, undefined, undefined, () => new RejectedHead());
    expect(error?.code).toBe('head_runtime_rejected');
    expect(error?.message).toContain(message);
    expect(error?.details.join('\n')).toContain('choose a supported model and effort');
    const events = readProject(stateRoot, (db) => listEvents(db, onlyRunId(stateRoot)));
    expect(ofType(events, 'head.session_opened')).toHaveLength(1);
    expect(ofType(events, 'head.session_stopped')).toHaveLength(1);
    expect(ofType(events, 'head.planning_finished')[0]?.payload).toMatchObject({ outcome: 'head_runtime_rejected', attempts: 1 });
    expect(ofType(events, 'head.assigned')).toEqual([]);
    expect(ofType(events, 'task.registered')).toEqual([]);
    expect(ofType(events, 'plan.rejected')).toEqual([]);
  }, 120_000);

  it('runs two assigned tasks at once in their own worktrees and accepts only the verified combined candidate', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-');
    setupWorkspace(stateRoot, fixture.path);
    // Global Control Center routes and its separate runtime must not leak into
    // the department-only snapshot used to resume this request.
    updateWorkspace(stateRoot, (current) => build([
      { op: 'runtime.set', id: 'control-only', adapter: 'fake', executable: defaultFakeRuntimeScript() },
      { op: 'project.add', repoPath: path.join(fixture.path, 'other-project'), id: 'other', name: 'Other project', checks: ['node --version'] },
      { op: 'control-center.set', runtime: 'control-only', projectRoutes: [{ projectId: 'app', departmentId: 'eng' }, { projectId: 'other', departmentId: 'design' }] },
    ], current));
    useScenario(departmentScenario({ head: [{ action: 'message', text: 'Reading the project.' }, propose([ALPHA, BETA]), { action: 'claim_done', message: 'Plan proposed.' }] }));
    const before = await fingerprintCheckout(fixture.path);

    const { result, error } = await runDepartment(stateRoot);
    expect(error).toBeNull();
    expect(result!.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(result!.data).toMatchObject({ accepted: true, outcome: 'accepted', project: 'app', department: 'eng', head: 'atlas', workers: ['nova', 'mira'], plan: { attempts: 1 } });
    const runId = result!.data['runId'] as string;
    expect(onlyRunId(stateRoot)).toBe(runId);

    const { tasks, attempts, events, artifacts } = readProject(stateRoot, (db) => ({
      tasks: db.prepare('SELECT id, owner_agent_id, state FROM tasks WHERE run_id = ?').all(runId) as Array<{ id: string; owner_agent_id: string; state: string }>,
      attempts: db
        .prepare('SELECT at.task_id, at.workspace_path, s.agent_id FROM attempts at JOIN agent_snapshots s ON s.hash = at.agent_snapshot_hash WHERE at.run_id = ?')
        .all(runId) as Array<{ task_id: string; workspace_path: string; agent_id: string }>,
      events: listEvents(db, runId),
      artifacts: db.prepare('SELECT id, relative_path FROM artifacts WHERE run_id = ?').all(runId) as Array<{ id: string; relative_path: string }>,
    }));

    const frozenPlanning = JSON.parse(readFileSync(path.join(stateRoot, 'projects', 'app', 'runs', runId, 'artifacts', 'head', 'planning-input.json'), 'utf8')) as { workspace: Record<string, unknown> };
    expect(frozenPlanning.workspace).not.toHaveProperty('controlCenter');

    // The head's decision, stage by stage, in order.
    const order = ['head.planning_started', 'head.session_opened', 'plan.proposed', 'plan.validated', 'head.assigned', 'task.registered'].map(
      (type) => events.find((event) => event.type === type)?.sequence ?? -1,
    );
    expect(order.every((sequence) => sequence > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ofType(events, 'plan.rejected')).toEqual([]);

    // The raw proposal is kept as an artifact, exactly as the head sent it.
    const proposed = ofType(events, 'plan.proposed');
    expect(proposed).toHaveLength(1);
    const artifact = artifacts.find((row) => row.id === proposed[0]!.payload['artifactId']);
    expect(artifact).toBeDefined();
    const recordedProposal = JSON.parse(readFileSync(path.join(stateRoot, 'projects', 'app', 'runs', runId, 'artifacts', artifact!.relative_path), 'utf8')) as { tasks: Array<{ assignee: string }> };
    expect(recordedProposal.tasks.map((t) => t.assignee)).toEqual(['nova', 'mira']);

    // Each task went to the worker the head named, and to nobody else.
    const assigned = ofType(events, 'head.assigned').map((event) => [event.payload['key'], event.payload['agentId'], event.payload['taskId']]);
    expect(assigned.map(([key, agent]) => [key, agent])).toEqual([
      ['alpha', 'nova'],
      ['beta', 'mira'],
    ]);
    expect(tasks.map((task) => [task.id, task.owner_agent_id, task.state]).sort()).toEqual(
      assigned.map(([, agent, taskId]) => [taskId, agent, 'accepted']).sort(),
    );
    expect(attempts.map((attempt) => attempt.agent_id).sort()).toEqual(['mira', 'nova']);
    for (const attempt of attempts) expect(tasks.find((task) => task.id === attempt.task_id)?.owner_agent_id).toBe(attempt.agent_id);

    // Their own worktrees, both registered before either finished: the same dispatch round.
    expect(new Set(attempts.map((attempt) => attempt.workspace_path)).size).toBe(2);
    const registered = ofType(events, 'task.registered').map((event) => event.sequence);
    const settled = ofType(events, 'task.settled').map((event) => event.sequence);
    expect(registered).toHaveLength(2);
    expect(Math.max(...registered)).toBeLessThan(Math.min(...settled));

    // The head's read-only copy is gone; the head wrote nothing.
    const headCopy = ofType(events, 'head.workspace_created')[0]!.payload['path'] as string;
    expect(existsSync(headCopy)).toBe(false);
    expect(ofType(events, 'head.wrote_files')).toEqual([]);

    // Accepted against the combined revision, which holds both documents.
    const manifest = JSON.parse(readFileSync(result!.data['manifest'] as string, 'utf8')) as { accepted: boolean; combination: { status: string; combinedRevision: string; acceptance: { accepted: boolean } } };
    expect(manifest.accepted).toBe(true);
    expect(manifest.combination.status).toBe('combined');
    expect(manifest.combination.acceptance.accepted).toBe(true);
    const files = (await git(['ls-tree', '-r', '--name-only', manifest.combination.combinedRevision], { cwd: fixture.path })).stdout;
    expect(files).toContain('docs/alpha.md');
    expect(files).toContain('docs/beta.md');

    const reviewed = ofType(events, 'head.review_finished');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.payload).toMatchObject({ headAgentId: 'atlas', verdict: 'passed', candidateRevision: manifest.combination.combinedRevision, sessionStopped: true });
    expect(ofType(events, 'integration.combined')[0]!.sequence).toBeLessThan(ofType(events, 'head.review_started')[0]!.sequence);
    expect(reviewed[0]!.sequence).toBeLessThan(ofType(events, 'control.final_reply')[0]!.sequence);
    expect(result!.data['finalReply']).toContain('Added the requested team documentation');
    const reviewDiffArtifact = artifacts.find((row) => row.relative_path.includes('/reviews/') && row.relative_path.endsWith('candidate.patch'))!;
    const reviewDiff = readFileSync(path.join(stateRoot, 'projects', 'app', 'runs', runId, 'artifacts', reviewDiffArtifact.relative_path), 'utf8');
    expect(reviewDiff).toContain('docs/alpha.md');
    expect(reviewDiff).toContain('docs/beta.md');
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  }, 180_000);

  it('retains accepted originals and the combined candidate after bounded head-review repairs exhaust, without a success reply', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-review-rejected-');
    setupWorkspace(stateRoot, fixture.path);
    updateWorkspace(stateRoot, (current) => build([{ op: 'limits.set', limits: { maxRepairAttempts: 2 } }], current));
    useScenario(departmentScenario({ head: [propose([ALPHA, BETA]), { action: 'claim_done', message: 'Plan proposed.' }] }));
    const before = await fingerprintCheckout(fixture.path);
    const response = await runDepartment(stateRoot, undefined, undefined, () => new ReviewAwareFakeAdapter('reject'));
    expect(response.result?.data).toMatchObject({ accepted: false, outcome: 'failed', runState: 'failed', finalReply: null, headReview: { verdict: 'changes_requested' } });
    expect(response.result!.data['reason']).toContain('Task "beta" exhausted its repair budget (2/2)');
    expect(response.result!.data['tasks']).toEqual([
      expect.objectContaining({ key: 'alpha', accepted: true, repairsUsed: 0, attempts: 1 }),
      expect.objectContaining({ key: 'beta', accepted: true, repairsUsed: 2, attempts: 3 }),
    ]);
    const runId = onlyRunId(stateRoot);
    const facts = readProject(stateRoot, (db) => ({
      events: listEvents(db, runId),
      tasks: db.prepare('SELECT id, parent_task_id, owner_agent_id, state, contract_json FROM tasks WHERE run_id = ?').all(runId) as Array<{ id: string; parent_task_id: string | null; owner_agent_id: string; state: string; contract_json: string }>,
      attempts: db.prepare('SELECT task_id FROM attempts WHERE run_id = ?').all(runId) as Array<{ task_id: string }>,
    }));
    const originals = facts.tasks.filter((task) => task.parent_task_id === null);
    const assigned = ofType(facts.events, 'head.assigned');
    expect(originals.map((task) => [task.id, task.owner_agent_id, task.state]).sort()).toEqual(
      assigned.map((event) => [event.payload['taskId'], event.payload['agentId'], 'accepted']).sort(),
    );
    expect(originals.map((task) => task.owner_agent_id).sort()).toEqual(['mira', 'nova']);
    const originalBeta = originals.find((task) => task.owner_agent_id === 'mira')!;
    const repairs = ofType(facts.events, 'head.review_repair_started');
    expect(repairs.map((event) => ({ key: event.payload['key'], agentId: event.payload['agentId'], attemptNumber: event.payload['attemptNumber'], maxRepairAttempts: event.payload['maxRepairAttempts'] }))).toEqual([
      { key: 'beta', agentId: 'mira', attemptNumber: 1, maxRepairAttempts: 2 },
      { key: 'beta', agentId: 'mira', attemptNumber: 2, maxRepairAttempts: 2 },
    ]);
    let previousTaskId = originalBeta.id;
    for (const repair of repairs) {
      expect(repair.payload['sourceTaskId']).toBe(previousTaskId);
      expect(facts.tasks.find((task) => task.id === repair.taskId)).toMatchObject({ parent_task_id: previousTaskId, owner_agent_id: 'mira', state: 'accepted', contract_json: originalBeta.contract_json });
      previousTaskId = repair.taskId!;
    }
    expect(facts.tasks).toHaveLength(originals.length + repairs.length);
    expect(facts.attempts.map((attempt) => attempt.task_id).sort()).toEqual(facts.tasks.map((task) => task.id).sort());
    const reviews = ofType(facts.events, 'head.review_finished');
    expect(reviews.map((event) => event.payload['verdict'])).toEqual(['changes_requested', 'changes_requested', 'changes_requested']);
    expect(reviews.at(-1)!.payload['summary']).toContain('endpoint usage');
    expect(ofType(facts.events, 'integration.combined')).toHaveLength(3);
    expect(ofType(facts.events, 'head.review_repair_blocked')[0]!.payload).toMatchObject({ reason: expect.stringContaining('repair budget (2/2)'), findings: [{ summary: 'Add a concrete endpoint usage example.', file: 'docs/beta.md' }] });
    const manifest = JSON.parse(readFileSync(response.result!.data['manifest'] as string, 'utf8')) as { combination: { status: string; combinedRevision: string } };
    expect(manifest.combination.status).toBe('combined');
    expect(reviews.at(-1)!.payload['candidateRevision']).toBe(manifest.combination.combinedRevision);
    const files = (await git(['ls-tree', '-r', '--name-only', manifest.combination.combinedRevision], { cwd: fixture.path })).stdout;
    expect(files).toContain('docs/alpha.md');
    expect(files).toContain('docs/beta.md');
    expect(ofType(facts.events, 'control.final_reply')).toEqual([]);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  }, 180_000);

  it('stops during review, preserves its required frozen gate, and resumes without repeating accepted worker tasks', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-review-resume-');
    setupWorkspace(stateRoot, fixture.path);
    useScenario(departmentScenario({ head: [propose([ALPHA]), { action: 'claim_done', message: 'Plan proposed.' }] }));
    const controller = new AbortController();
    const response = await runDepartment(stateRoot, controller.signal, (chunk) => { if (chunk.includes('REVIEW-IN-PROGRESS')) controller.abort(); }, () => new ReviewAwareFakeAdapter('pause'));
    expect(response.result?.data).toMatchObject({ accepted: false, outcome: 'interrupted', runState: 'interrupted', finalReply: null, headReview: { verdict: 'blocked', sessionStopped: true } });
    const runId = onlyRunId(stateRoot);
    const projectRoot = path.join(stateRoot, 'projects', 'app');
    const planPath = path.join(projectRoot, 'runs', runId, 'plan.json');
    const saved = readFileSync(planPath, 'utf8');
    const record = JSON.parse(saved) as Record<string, unknown>;
    expect(record['headReview']).toEqual({ headAgentId: 'atlas', required: true });
    delete record['headReview'];
    writeFileSync(planPath, JSON.stringify(record));
    await expect(commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false }, { continuation: { adapterFactory: () => new ReviewAwareFakeAdapter() } })).rejects.toThrow(/head review policy/);
    writeFileSync(planPath, saved);
    const resumed = await commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false }, { continuation: { adapterFactory: () => new ReviewAwareFakeAdapter() } });
    expect(resumed.data).toMatchObject({ status: 'accepted', runState: 'ready_for_review', headReview: { verdict: 'passed' } });
    const facts = readProject(stateRoot, (db) => ({ events: listEvents(db, runId), attempts: db.prepare('SELECT id FROM attempts').all() }));
    expect(facts.attempts).toHaveLength(1);
    expect(ofType(facts.events, 'integration.combined')).toHaveLength(2);
    expect(ofType(facts.events, 'head.review_finished').map((event) => event.payload['verdict'])).toEqual(['blocked', 'passed']);
    expect(ofType(facts.events, 'control.final_reply')).toHaveLength(1);
  }, 180_000);

  it('rejects a plan that gives work to someone outside the roster, twice, and never creates a worker attempt', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-');
    setupWorkspace(stateRoot, fixture.path);
    // "mo" works on this project, but for another department.
    useScenario(departmentScenario({ head: [propose([ALPHA, { ...BETA, assignee: 'mo' }]), { action: 'claim_done', message: 'Plan proposed.' }] }));

    const { error } = await runDepartment(stateRoot);
    expect(error?.exitCode).toBe(EXIT_CODES.executionFailure);
    expect(error?.code).toBe('plan_rejected');
    expect(error?.message).toBe('department head "atlas" did not produce a valid plan in 2 attempt(s), so no worker was started');
    expect(error?.details.join('\n')).toMatch(/\[unknown_assignee\] tasks\[1\]\.assignee: task "beta" is assigned to "mo"/);

    const runId = onlyRunId(stateRoot);
    const facts = readProject(stateRoot, (db) => ({
      state: (db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state,
      tasks: (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
      attempts: (db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n,
      events: listEvents(db, runId),
    }));
    expect(facts).toMatchObject({ state: 'failed', tasks: 0, attempts: 0 });
    expect(ofType(facts.events, 'head.session_opened')).toHaveLength(2);
    expect(ofType(facts.events, 'plan.proposed')).toHaveLength(2);
    expect(ofType(facts.events, 'plan.rejected').map((event) => event.payload['willRetry'])).toEqual([true, false]);
    for (const type of ['plan.validated', 'head.assigned', 'task.registered', 'plan.registered']) expect(ofType(facts.events, type)).toEqual([]);
    const manifest = JSON.parse(readFileSync(path.join(stateRoot, 'projects', 'app', 'runs', runId, 'planned-result.json'), 'utf8')) as { accepted: boolean; reason: string; tasks: unknown[] };
    expect(manifest).toMatchObject({ accepted: false, reason: error!.message, tasks: [] });
  }, 120_000);

  it('creates nothing from a plan written as prose', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-');
    setupWorkspace(stateRoot, fixture.path);
    const prose = `Here is my plan:\n${JSON.stringify({ planVersion: 2, summary: 'as text', tasks: [ALPHA, BETA] })}`;
    useScenario(departmentScenario({ head: [{ action: 'message', text: prose }, { action: 'claim_done', message: 'The plan is above.' }] }));

    const { error } = await runDepartment(stateRoot);
    expect(error?.code).toBe('plan_rejected');
    expect(error?.details.join('\n')).toMatch(/\[no_plan_proposed\] \(head\): the head ended its turn without calling workforce_propose_plan; a plan written as text creates nothing/);

    const runId = onlyRunId(stateRoot);
    const facts = readProject(stateRoot, (db) => ({
      tasks: (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
      attempts: (db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n,
      events: listEvents(db, runId),
    }));
    expect(facts).toMatchObject({ tasks: 0, attempts: 0 });
    expect(ofType(facts.events, 'plan.proposed')).toEqual([]);
    expect(ofType(facts.events, 'plan.rejected').flatMap((event) => (event.payload['issues'] as Array<{ code: string }>).map((issue) => issue.code))).toEqual(['no_plan_proposed', 'no_plan_proposed']);
  }, 120_000);

  it('gives an invalid plan exactly one retry with its issues, then fails with the reason and starts no worker', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-');
    setupWorkspace(stateRoot, fixture.path);
    const cyclic = [
      { ...ALPHA, dependencies: [{ taskId: 'beta' }] },
      { ...BETA, dependencies: [{ taskId: 'alpha' }] },
    ];
    useScenario(
      departmentScenario({
        head: [propose(cyclic), { action: 'claim_done', message: 'Plan proposed.' }],
        retry: [propose([ALPHA, { ...BETA, acceptanceCriteria: [] }]), { action: 'claim_done', message: 'Fixed the cycle.' }],
      }),
    );

    const { error } = await runDepartment(stateRoot);
    expect(error?.code).toBe('plan_rejected');
    expect(error?.details.join('\n')).toMatch(/\[missing_acceptance_criteria\] tasks\[1\]\.acceptanceCriteria/);

    const runId = onlyRunId(stateRoot);
    const facts = readProject(stateRoot, (db) => ({
      tasks: (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
      attempts: (db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n,
      events: listEvents(db, runId),
    }));
    expect(facts).toMatchObject({ tasks: 0, attempts: 0 });
    const rejected = ofType(facts.events, 'plan.rejected').map((event) => ({
      attempt: event.payload['attempt'],
      willRetry: event.payload['willRetry'],
      codes: (event.payload['issues'] as Array<{ code: string }>).map((issue) => issue.code),
    }));
    expect(rejected).toEqual([
      { attempt: 1, willRetry: true, codes: ['dependency_cycle'] },
      { attempt: 2, willRetry: false, codes: ['missing_acceptance_criteria'] },
    ]);
    // The retry was a second planning session, and its prompt carried the first rejection.
    const headTurns = ofType(facts.events, 'runtime.turn_started').filter((event) => event.taskId === null && !String(event.payload['prompt'] ?? '').includes(HEAD_REVIEW_TOOL));
    expect(headTurns).toHaveLength(2);
    expect(String(headTurns[1]!.payload['prompt'])).toContain(HEAD_RETRY_HEADING);
    expect(String(headTurns[1]!.payload['prompt'])).toContain('[dependency_cycle]');
    // Exactly two attempts: a third proposal was never asked for.
    expect(ofType(facts.events, 'head.session_opened')).toHaveLength(2);
  }, 120_000);

  it('starts the workers when the retry fixes the plan', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-');
    setupWorkspace(stateRoot, fixture.path);
    useScenario(
      departmentScenario({
        head: [propose([{ ...ALPHA, assignee: 'atlas' }]), { action: 'claim_done', message: 'I will do it myself.' }],
        retry: [propose([ALPHA]), { action: 'claim_done', message: 'Assigned to nova.' }],
      }),
    );

    const { result, error } = await runDepartment(stateRoot);
    expect(error).toBeNull();
    expect(result!.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(result!.data).toMatchObject({ accepted: true, plan: { attempts: 2 } });
    const events = readProject(stateRoot, (db) => listEvents(db, result!.data['runId'] as string));
    expect(ofType(events, 'plan.rejected').map((event) => (event.payload['issues'] as Array<{ code: string }>)[0]!.code)).toEqual(['assignee_is_head']);
    expect(ofType(events, 'head.assigned').map((event) => event.payload['agentId'])).toEqual(['nova']);
  }, 120_000);
});

describe('Stop and Resume of a planned department run', () => {
  it('preserves a stopped head request and resumes planning once under its original roster and checks', async () => {
    const fixture = await useFixture('ts-bug');
    const before = await fingerprintCheckout(fixture.path);
    const stateRoot = tempDir('workforce-head-planning-stop-');
    setupWorkspace(stateRoot, fixture.path);
    useScenario(departmentScenario({ head: [{ action: 'message', text: 'HEAD-PLANNING-WAIT' }, { action: 'sleep', ms: 60_000 }] }));
    const controller = new AbortController();
    const stopped = await runDepartment(stateRoot, controller.signal, (chunk) => {
      if (chunk.includes('HEAD-PLANNING-WAIT')) controller.abort();
    });
    expect(stopped.error).toMatchObject({ exitCode: EXIT_CODES.interrupted, code: 'interrupted' });
    const runId = onlyRunId(stateRoot);
    const projectRoot = path.join(stateRoot, 'projects', 'app');
    const beforeResume = readProject(stateRoot, (db) => ({
      state: (db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state,
      tasks: (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
      events: listEvents(db, runId),
    }));
    expect(beforeResume.state).toBe('interrupted');
    expect(beforeResume.tasks).toBe(0);
    expect(ofType(beforeResume.events, 'run.failed')).toHaveLength(0);
    expect(ofType(beforeResume.events, 'head.session_stopped')[0]!.payload['state']).toBe('process_tree_terminated');
    const pid = ofType(beforeResume.events, 'head.session_opened')[0]!.payload['processId'] as number;
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    const requestPath = path.join(projectRoot, 'runs', runId, 'request.json');
    const originalRequest = readFileSync(requestPath, 'utf8');

    // Later workspace edits cannot silently rewrite an interrupted request.
    updateWorkspace(stateRoot, (current) => build([
      { op: 'agent.unassign', agentId: 'nova', projectId: 'app' },
      { op: 'project.edit', id: 'app', checks: ['node -e "process.exit(1)"'] },
    ], current));
    useScenario(departmentScenario({ head: [propose([ALPHA]), { action: 'claim_done', message: 'Plan proposed.' }] }));
    const resumed = await commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false }, { continuation: { adapterFactory: () => new ReviewAwareFakeAdapter() } });
    expect(resumed.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(resumed.data).toMatchObject({ runId, status: 'accepted', runState: 'ready_for_review' });
    expect(onlyRunId(stateRoot)).toBe(runId);
    expect(readFileSync(requestPath, 'utf8')).toBe(originalRequest);
    const afterResume = readProject(stateRoot, (db) => ({
      events: listEvents(db, runId),
      attempts: db.prepare('SELECT at.task_id, s.agent_id FROM attempts at JOIN agent_snapshots s ON s.hash = at.agent_snapshot_hash').all() as Array<{ task_id: string; agent_id: string }>,
    }));
    expect(afterResume.attempts).toHaveLength(1);
    expect(afterResume.attempts[0]!.agent_id).toBe('nova');
    expect(ofType(afterResume.events, 'run.created')).toHaveLength(1);
    const opened = ofType(afterResume.events, 'head.session_opened');
    const closed = ofType(afterResume.events, 'head.session_stopped');
    expect(opened).toHaveLength(2);
    expect(closed[0]!.sequence).toBeLessThan(opened[1]!.sequence);
    expect(closed[1]!.sequence).toBeLessThan(ofType(afterResume.events, 'task.created')[0]!.sequence);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  }, 120_000);

  it('keeps corrupt pending planning evidence interrupted and starts no replacement', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-planning-corrupt-');
    setupWorkspace(stateRoot, fixture.path);
    const controller = new AbortController();
    controller.abort();
    const stopped = await runDepartment(stateRoot, controller.signal);
    expect(stopped.error).toMatchObject({ exitCode: EXIT_CODES.interrupted });
    const runId = onlyRunId(stateRoot);
    const projectRoot = path.join(stateRoot, 'projects', 'app');
    writeFileSync(path.join(projectRoot, 'runs', runId, 'artifacts', 'head', 'planning-input.json'), '{}');
    await expect(commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false })).rejects.toThrow(/content hash/);
    const after = readProject(stateRoot, (db) => ({
      state: (db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state,
      events: listEvents(db, runId),
    }));
    expect(after.state).toBe('interrupted');
    expect(ofType(after.events, 'head.session_opened')).toHaveLength(0);
  });

  it.each(['missing_receipt', 'live_session'] as const)('refuses planning resume beside %s ownership and creates no duplicate writer', async (mode) => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-planning-uncertain-');
    setupWorkspace(stateRoot, fixture.path);
    const controller = new AbortController();
    controller.abort();
    await runDepartment(stateRoot, controller.signal);
    const runId = onlyRunId(stateRoot);
    const projectRoot = path.join(stateRoot, 'projects', 'app');
    const store = openStateStore(createStatePaths(projectRoot), { mode: 'mutating' });
    try {
      appendEvent(store.db, { runId, type: 'head.session_requested', payload: { planningId: 'uncertain', attempt: 1 } });
      if (mode === 'live_session') appendEvent(store.db, { runId, type: 'head.session_opened', payload: { planningId: 'uncertain', attempt: 1, sessionId: 'still-live', process: observeProcessIdentity(process.pid) } });
    } finally {
      store.close();
    }
    const result = await commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false });
    expect(result.exitCode).toBe(EXIT_CODES.userActionRequired);
    expect(result.data).toMatchObject({ status: 'blocked', runState: 'interrupted', tasks: [] });
    const events = readProject(stateRoot, (db) => listEvents(db, runId));
    expect(ofType(events, 'head.session_requested')).toHaveLength(1);
    expect(ofType(events, 'task.created')).toHaveLength(0);
  });

  it('ends interrupted, not failed, and resume finishes the same plan under the same assignees', async () => {
    const fixture = await useFixture('ts-bug');
    const stateRoot = tempDir('workforce-head-stop-');
    setupWorkspace(stateRoot, fixture.path);
    const head = [propose([ALPHA, BETA]), { action: 'claim_done', message: 'Plan proposed.' }];
    useScenario(
      departmentScenario({
        head,
        // beta holds its turn open long enough to be stopped mid-flight.
        beta: [{ action: 'message', text: 'SLOW-WORK-STARTED' }, { action: 'edit_file', path: 'docs/beta.md', content: '# beta, half written\n' }, { action: 'sleep', ms: 60_000 }, { action: 'claim_done', message: 'never reached' }],
      }),
    );
    const projectRoot = path.join(stateRoot, 'projects', 'app');

    // Stop once alpha is accepted and beta is in the middle of its turn.
    const controller = new AbortController();
    const stopper = (async (): Promise<boolean> => {
      for (let tick = 0; tick < 1_200; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!existsSync(path.join(projectRoot, 'state.sqlite'))) continue;
        let ready = false;
        try {
          ready = readProject(stateRoot, (db) => {
            const accepted = (db.prepare("SELECT count(*) AS n FROM tasks WHERE state = 'accepted'").get() as { n: number }).n;
            const slow = (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'runtime.assistant_message' AND payload_json LIKE '%SLOW-WORK-STARTED%'").get() as { n: number }).n;
            return accepted >= 1 && slow >= 1;
          });
        } catch {
          // The database is being created; look again.
        }
        if (ready) {
          controller.abort();
          return true;
        }
      }
      return false;
    })();

    const stopped = await runDepartment(stateRoot, controller.signal);
    expect(await stopper).toBe(true);
    expect(stopped.error).toBeNull();
    expect(stopped.result!.exitCode).toBe(EXIT_CODES.interrupted);
    expect(stopped.result!.data).toMatchObject({ outcome: 'interrupted', runState: 'interrupted', accepted: false });
    const runId = stopped.result!.data['runId'] as string;

    const afterStop = readProject(stateRoot, (db) => ({
      run: (db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state,
      tasks: db.prepare('SELECT id, owner_agent_id, state FROM tasks WHERE run_id = ? ORDER BY owner_agent_id').all(runId) as Array<{ id: string; owner_agent_id: string; state: string }>,
      events: listEvents(db, runId),
    }));
    expect(afterStop.run).toBe('interrupted');
    expect(afterStop.tasks.map((task) => [task.owner_agent_id, task.state])).toEqual([
      ['mira', 'cancelled'],
      ['nova', 'accepted'],
    ]);
    expect(ofType(afterStop.events, 'run.failed')).toEqual([]);
    expect(ofType(afterStop.events, 'integration.combined')).toEqual([]);
    const alphaId = afterStop.tasks.find((task) => task.owner_agent_id === 'nova')!.id;
    const betaId = afterStop.tasks.find((task) => task.owner_agent_id === 'mira')!.id;

    // A damaged plan cannot fall through to independent direct-task resume,
    // which would skip combined verification. It also must not burn a new
    // generation before reporting the missing evidence.
    const planPath = path.join(projectRoot, 'runs', runId, 'plan.json');
    const planBytes = readFileSync(planPath, 'utf8');
    writeFileSync(planPath, '{}');
    await expect(commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false })).rejects.toThrow(/no usable plan/);
    writeFileSync(planPath, planBytes);

    // Resume, with beta now able to finish.
    useScenario(departmentScenario({ head, beta: writes('docs/beta.md') }));
    const resumed = await commandResume({ positionals: [runId], stateDir: projectRoot, allowUnconfinedWrites: true, json: false }, { continuation: { adapterFactory: () => new ReviewAwareFakeAdapter() } });
    expect(resumed.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(resumed.data).toMatchObject({ status: 'accepted', runState: 'ready_for_review', preservedTaskIds: [alphaId] });
    expect(resumed.data['tasks']).toMatchObject([{ taskId: betaId, accepted: true, generation: 2 }]);

    const afterResume = readProject(stateRoot, (db) => ({
      run: (db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string }).state,
      alphaAttempts: (db.prepare('SELECT count(*) AS n FROM attempts WHERE task_id = ?').get(alphaId) as { n: number }).n,
      betaAgents: (
        db.prepare('SELECT s.agent_id FROM attempts at JOIN agent_snapshots s ON s.hash = at.agent_snapshot_hash WHERE at.task_id = ? ORDER BY at.generation').all(betaId) as Array<{ agent_id: string }>
      ).map((row) => row.agent_id),
    }));
    // Accepted work is kept, never re-run; the interrupted task went back to its own assignee.
    expect(afterResume).toEqual({ run: 'ready_for_review', alphaAttempts: 1, betaAgents: ['mira', 'mira'] });

    // Accepted only against the combined candidate, re-checked by the resume.
    const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'runs', runId, 'planned-result.json'), 'utf8')) as {
      accepted: boolean;
      combination: { status: string; combinedRevision: string; acceptance: { accepted: boolean } };
      tasks: Array<{ key: string; preserved: boolean; accepted: boolean }>;
    };
    expect(manifest.accepted).toBe(true);
    expect(manifest.combination.acceptance.accepted).toBe(true);
    expect(manifest.tasks.map((task) => [task.key, task.accepted, task.preserved])).toEqual([
      ['alpha', true, true],
      ['beta', true, false],
    ]);
    const files = (await git(['ls-tree', '-r', '--name-only', manifest.combination.combinedRevision], { cwd: fixture.path })).stdout;
    expect(files).toContain('docs/alpha.md');
    expect(files).toContain('docs/beta.md');
    const beta = (await git(['show', `${manifest.combination.combinedRevision}:docs/beta.md`], { cwd: fixture.path })).stdout;
    expect(beta).not.toContain('half written');
  }, 240_000);
});
