/**
 * Plan v2 and the head's planning tool, without a runtime.
 *
 * What is under test is the part that must hold whatever a model does: a plan
 * is accepted only when every task goes to a worker on this request's roster,
 * the head is told exactly which workers and which project, and the planning
 * tool can be reached by a head's session and by nothing else.
 */
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_TOOL_NAMES, HEAD_BRIDGE_TOOL_NAMES, bridgeToolsFor, runBridge } from '../../src/coordination/bridge.js';
import { CoordinationError, handleCoordinationRequest, listMessages, type WorkerIdentity } from '../../src/coordination/index.js';
import { composeHeadPrompt, HEAD_PLAN_TOOL, HEAD_RETRY_HEADING, workerObjective } from '../../src/routing/head-planner.js';
import { validateHeadPlan, validatePlan, type PlannerRequest } from '../../src/routing/plan.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { seedAttempt, seedRun, seedTask } from '../coordination/helpers.js';

const ROSTER = { headId: 'atlas', workerIds: ['nova', 'mira'] };
const LIMITS = { maxTasksPerRun: 8 };

function task(id: string, assignee: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, objective: `Deliver ${id}.`, assignee, acceptanceCriteria: [{ id: 'c1', description: `${id} is delivered` }], ...extra };
}

function plan(tasks: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return { planVersion: 2, summary: 'Two independent pieces.', tasks };
}

describe('plan v2: every task goes to a worker on the roster', () => {
  it('accepts a plan assigned to roster workers and orders it by its dependencies', () => {
    const result = validateHeadPlan(plan([task('docs', 'mira', { dependencies: [{ taskId: 'code' }] }), task('code', 'nova')]), ROSTER, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.order).toEqual(['code', 'docs']);
    expect(result.plan.tasks.map((t) => [t.id, t.assignee])).toEqual([
      ['docs', 'mira'],
      ['code', 'nova'],
    ]);
  });

  it('rejects a task given to someone off the roster or to the head, naming each, and repairs nothing', () => {
    const result = validateHeadPlan(plan([task('a', 'mo'), task('b', 'atlas'), task('c', 'nova')]), ROSTER, LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['unknown_assignee', 'tasks[0].assignee'],
      ['assignee_is_head', 'tasks[1].assignee'],
    ]);
    expect(result.issues[0]!.message).toMatch(/"mo".*not a worker on this request's roster.*"nova", "mira"/);
  });

  it('rejects a plan without assignees: a head that does not assign has not planned', () => {
    const v1 = { planVersion: 1, summary: 'no owners', tasks: [{ id: 't1', objective: 'x', acceptanceCriteria: [{ id: 'c1', description: 'y' }] }] };
    const result = validateHeadPlan(v1, ROSTER, LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.code === 'schema')).toBe(true);
    expect(result.issues.map((issue) => issue.path).join(' ')).toMatch(/tasks\[0\]\.assignee/);
  });

  it('applies every rule a v1 plan has: cycles, the budget, criteria and overlapping paths, all in one answer', () => {
    const cyclic = validateHeadPlan(plan([task('a', 'nova', { dependencies: [{ taskId: 'b' }] }), task('b', 'mira', { dependencies: [{ taskId: 'a' }] })]), ROSTER, LIMITS);
    expect(cyclic.ok ? [] : cyclic.issues.map((issue) => issue.code)).toEqual(['dependency_cycle']);

    const tooMany = validateHeadPlan(plan([task('a', 'nova'), task('b', 'mira'), task('c', 'nova')]), ROSTER, { maxTasksPerRun: 2 });
    expect(tooMany.ok ? [] : tooMany.issues.map((issue) => issue.code)).toEqual(['task_budget_exceeded']);

    const sloppy = validateHeadPlan(
      plan([
        { ...task('a', 'nova', { scope: { allowedPaths: ['src/'] } }), acceptanceCriteria: [] },
        task('b', 'mo', { scope: { allowedPaths: ['src/api/'] } }),
      ]),
      ROSTER,
      LIMITS,
    );
    expect(sloppy.ok ? [] : sloppy.issues.map((issue) => issue.code).sort()).toEqual(['missing_acceptance_criteria', 'path_ownership_conflict', 'unknown_assignee']);
  });

  it('leaves a v1 plan valid under validatePlan, which has no roster', () => {
    const v1 = { planVersion: 1, summary: 's', tasks: [{ id: 't1', objective: 'x', acceptanceCriteria: [{ id: 'c1', description: 'y' }] }] };
    expect(validatePlan(v1, LIMITS).ok).toBe(true);
  });

  it('tells the assigned worker the head\'s objective first and its criteria as guidance', () => {
    const result = validateHeadPlan(plan([task('code', 'nova', { scope: { allowedPaths: ['src/pagination.js'] } })]), ROSTER, LIMITS);
    if (!result.ok) throw new Error('expected a valid plan');
    const text = workerObjective(result.plan.tasks[0]!);
    expect(text.split('\n')[0]).toBe('Deliver code.');
    expect(text).toContain('Stay within: src/pagination.js');
    expect(text).toContain('- code is delivered');
    expect(text).toMatch(/the coordinator runs the project's own checks/);
  });
});

describe('the head prompt', () => {
  const request: PlannerRequest = {
    requestText: 'Fix the pagination off-by-one.\nAnd document it.',
    repoPath: '/repos/app',
    contextRefs: [],
    limits: { maxTasksPerRun: 4 },
    project: { id: 'app', name: 'Storefront' },
    department: { id: 'eng', name: 'Engineering' },
    roster: [
      { id: 'nova', name: 'Nova', capabilities: ['coding', 'testing'], runtime: 'codex-local (codex)' },
      { id: 'mira', name: 'Mira', capabilities: [], runtime: 'claude-local (claude-code)' },
    ],
    attempt: 1,
    maxAttempts: 2,
  };

  it('starts with the request verbatim, names only this project, lists the roster and says prose creates nothing', () => {
    const prompt = composeHeadPrompt({ request, headId: 'atlas', workspacePath: '/state/ws/head', baseRevision: 'abc123' });
    expect(prompt.startsWith('Fix the pagination off-by-one.\nAnd document it.\n')).toBe(true);
    expect(prompt).toContain('one project only: "Storefront" (id app)');
    expect(prompt).toContain('- nova — Nova; runtime codex-local (codex); capabilities: coding, testing');
    expect(prompt).toContain('- mira — Mira; runtime claude-local (claude-code); capabilities: (none listed)');
    expect(prompt).toContain(`calling the tool ${HEAD_PLAN_TOOL}`);
    expect(prompt).toMatch(/a plan written as text in your reply creates nothing/);
    expect(prompt).toContain('1 to 4 task(s)');
    expect(prompt).toContain('"planVersion": 2');
    expect(prompt).not.toContain(HEAD_RETRY_HEADING);
  });

  it('feeds the issues of a rejected proposal back into the retry, and says it is the last attempt', () => {
    const prompt = composeHeadPrompt({
      request: { ...request, attempt: 2, previousIssues: [{ code: 'unknown_assignee', path: 'tasks[0].assignee', message: 'task "a" is assigned to "mo"' }] },
      headId: 'atlas',
      workspacePath: '/state/ws/head',
      baseRevision: 'abc123',
    });
    expect(prompt).toContain(`--- ${HEAD_RETRY_HEADING} (attempt 1 of 2) ---`);
    expect(prompt).toContain('- [unknown_assignee] tasks[0].assignee: task "a" is assigned to "mo"');
    expect(prompt).toMatch(/This is your last attempt/);
  });
});

describe("the planning tool is the head's alone", () => {
  let state: TempState | null = null;
  afterEach(() => {
    state?.cleanup();
    state = null;
  });

  it('is namespaced, and shares a name with no worker tool and no known runtime built-in', () => {
    // codex-cli 0.147.0 captured a bridge call named send_message with its own built-in (docs/evidence/r1).
    const builtIns = ['send_message', 'update_plan', 'apply_patch', 'shell', 'read_file', 'Task', 'TodoWrite'];
    for (const name of HEAD_BRIDGE_TOOL_NAMES) {
      expect(name.startsWith('workforce_')).toBe(true);
      expect(builtIns).not.toContain(name);
      expect(BRIDGE_TOOL_NAMES as ReadonlyArray<string>).not.toContain(name);
    }
    expect(bridgeToolsFor('head').map((tool) => tool.name)).toEqual([HEAD_PLAN_TOOL]);
    expect(bridgeToolsFor('worker').map((tool) => tool.name)).toEqual([...BRIDGE_TOOL_NAMES]);
  });

  it('is listed to a head bridge process and refused by a worker bridge process before anything reaches the coordinator', async () => {
    const ask = async (role: 'head' | 'worker', frames: ReadonlyArray<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> => {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = '';
      output.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      const done = runBridge({ socketPath: '/nonexistent/socket', token: 't', input, output, role });
      for (const frame of frames) input.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
      input.end();
      await done;
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const [headList] = await ask('head', [{ id: 1, method: 'tools/list' }]);
    expect(((headList!['result'] as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name)).toEqual([HEAD_PLAN_TOOL]);

    const [workerCall] = await ask('worker', [{ id: 2, method: 'tools/call', params: { name: HEAD_PLAN_TOOL, arguments: {} } }]);
    expect((workerCall!['error'] as { message: string }).message).toMatch(/unknown tool "workforce_propose_plan"/);
  });

  it('refuses a proposal from a worker session and a worker tool from a head session, from the identity the coordinator minted', () => {
    state = openTempState();
    const db = state.store.db;
    const run = seedRun(db);
    const taskRow = seedTask(db, run.id);
    const attempt = seedAttempt(db, taskRow.id);
    const worker: WorkerIdentity = { runId: run.id, taskId: taskRow.id, attemptId: attempt.id };
    const head: WorkerIdentity = { runId: run.id, taskId: 'head:atlas', attemptId: 'planning-1', role: 'head', agentId: 'atlas' };
    const received: Array<Record<string, unknown>> = [];
    const proposePlan = (_identity: WorkerIdentity, params: Record<string, unknown>): Record<string, unknown> => {
      received.push(params);
      return { received: true };
    };

    // A worker handed the handler anyway still cannot use it.
    expect(() => handleCoordinationRequest(db, worker, 'workforce_propose_plan', plan([task('a', 'nova')]), { proposePlan })).toThrow(CoordinationError);
    try {
      handleCoordinationRequest(db, worker, 'workforce_propose_plan', {}, { proposePlan });
    } catch (error) {
      expect((error as CoordinationError).code).toBe('forbidden');
    }
    for (const op of ['send_message', 'read_inbox', 'request_task'] as const) {
      expect(() => handleCoordinationRequest(db, head, op, { body: 'hello' }, {})).toThrow(/a planning session can only call workforce_propose_plan/);
    }
    expect(received).toEqual([]);
    expect(listMessages(db, run.id)).toHaveLength(0);

    expect(handleCoordinationRequest(db, head, 'workforce_propose_plan', { planVersion: 2 }, { proposePlan })).toEqual({ received: true });
    expect(received).toEqual([{ planVersion: 2 }]);
    // A head whose session has no handler (planning is over) is told so rather than silently dropped.
    expect(() => handleCoordinationRequest(db, head, 'workforce_propose_plan', {}, {})).toThrow(/no longer taking proposals/);
  });
});
