/**
 * The assembled local service must deliver a verified candidate, not merely
 * exit cleanly. Only model decisions are scripted; the request queue, CLI,
 * department-head MCP bridge, workspaces and contained verifier are real.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFakeRuntimeScript, FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, fingerprintCheckout, fixedPaginationSource, tempDir, useFixture, writeScenario } from '../workspaces/support.js';
import { originFor, rawRequest, tokenFrom, sleep } from './support.js';

const servers: OfficeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  cleanupAll();
});

const objective = 'Fix the pagination helpers in src/pagination.js.';
const plan = {
  planVersion: 2,
  summary: 'One worker repairs the pagination helpers.',
  tasks: [{
    id: 'pagination', objective, assignee: 'worker',
    acceptanceCriteria: [{ id: 'pagination-checks', description: 'The existing pagination tests pass without changes to tests.' }],
    scope: { allowedPaths: ['src/pagination.js'] },
  }],
};

async function setup(falseDone: boolean) {
  const fixture = await useFixture('ts-bug');
  const before = await fingerprintCheckout(fixture.path);
  const stateRoot = tempDir('workforce-dogfood-');
  updateWorkspace(stateRoot, current => applyWorkspaceOps(current, parseWorkspaceOps([
    { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
    { op: 'project.add', repoPath: fixture.path, id: 'app', name: 'Practice pagination' },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'agent.add', id: 'head', role: 'head', departmentId: 'eng', runtime: 'fake-local' },
    { op: 'agent.add', id: 'worker', role: 'worker', departmentId: 'eng', runtime: 'fake-local', projectIds: ['app'] },
    { op: 'limits.set', limits: { maxRepairAttempts: 0 } },
  ])));
  const scenario = writeScenario({
    scenarioVersion: 1,
    ...{ byPrompt: [
      { startsWith: objective, steps: falseDone
        ? [{ action: 'claim_done', message: 'All done. Every test passes.' }]
        : [{ action: 'edit_file', path: 'src/pagination.js', content: fixedPaginationSource() }, { action: 'claim_done', message: 'The verifier must decide.' }] },
      { includes: 'workforce_propose_plan', steps: [
        { action: 'call_tool', tool: 'workforce_propose_plan', arguments: plan },
        { action: 'claim_done', message: 'Plan submitted through the actual bridge.' },
      ] },
    ] },
    steps: [{ action: 'claim_done', message: 'Unexpected prompt; cannot claim successful execution.' }],
  });
  const server = await startOfficeServer({
    stateRoot, port: 0, discover: async () => [], queuePollMs: 40,
    cliInvocation: {
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url))],
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
    },
    env: { ...process.env, NODE_NO_WARNINGS: '1', [FAKE_SCENARIO_ENV]: scenario },
  });
  servers.push(server);
  const token = await tokenFrom(server);
  const submitted = await rawRequest(server, {
    method: 'POST', path: '/api/requests',
    headers: { origin: originFor(server), 'x-workforce-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'app', departmentId: 'eng', task: 'Repair the two pagination off-by-one bugs without modifying tests.', allowUnconfinedWrites: true }),
  });
  expect(submitted.status, submitted.body).toBe(202);
  const item = JSON.parse(submitted.body).request;
  expect(item.exclusive).toBe(true); // A fake runtime never establishes sandbox/concurrency proof.
  const deadline = Date.now() + 90_000;
  let ended;
  while (Date.now() < deadline) {
    ended = JSON.parse((await rawRequest(server, { path: `/api/requests/${item.id}` })).body).request;
    if (ended.state === 'ended') break;
    await sleep(30);
  }
  expect(ended?.state, JSON.stringify(ended)).toBe('ended');
  const route = `/api/projects/app/runs/${ended.runId}`;
  const status = JSON.parse((await rawRequest(server, { path: route })).body);
  const events = JSON.parse((await rawRequest(server, { path: `${route}/events` })).body).events as Array<{ type: string }>;
  expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  return { ended, status, events };
}

describe('assembled department request with the real CLI and verifier', () => {
  it('returns a verified candidate only after the head calls its bridge, the worker edits, and verifier checks pass', async () => {
    const { ended, status, events } = await setup(false);
    expect(ended.exitCode, JSON.stringify(ended.result)).toBe(0);
    expect(status.run.state).toBe('ready_for_review');
    expect(status.tasks, JSON.stringify(ended.result)).toHaveLength(1);
    expect(status.tasks[0].state).toBe('accepted');
    expect(status.checks).toHaveLength(1);
    expect(status.checks[0]).toMatchObject({ outcome: 'passed', evidenceProvenance: 'verifier_executed', exitCode: 0 });
    const types = events.map(event => event.type);
    const phases = ['head.planning_started', 'plan.proposed', 'plan.validated', 'head.assigned', 'task.registered', 'candidate.snapshot', 'run.accepted', 'integration.combined'];
    const positions = phases.map(type => types.indexOf(type));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }, 120_000);

  it('rejects a worker that claims every test passes without fixing the bug', async () => {
    const { ended, status, events } = await setup(true);
    expect(ended.exitCode).toBe(4);
    expect(status.run.state).toBe('failed');
    expect(status.tasks, JSON.stringify(ended.result)).toHaveLength(1);
    expect(status.tasks[0].state).toBe('failed');
    expect(status.checks).toHaveLength(1);
    expect(status.checks[0]).toMatchObject({ outcome: 'failed', evidenceProvenance: 'verifier_executed', exitCode: 1 });
    expect(events.some(event => event.type === 'run.accepted')).toBe(false);
  }, 120_000);
});
