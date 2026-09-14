import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type RuntimeEvent, type SessionHandle, type SessionInput, type TurnHandle } from '../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { continuePlannedRun, runPlanned, type RunPlannedInput } from '../../src/core/run-planned.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { HEAD_REVIEW_TOOL } from '../../src/routing/head-reviewer.js';
import { listEvents } from '../../src/storage/events.js';
import { transitionRun } from '../../src/storage/records.js';
import { git } from '../../src/workspaces/git.js';
import { openTempState } from '../helpers/state.js';
import { cleanupAll, fingerprintCheckout, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

async function setup(options: { max?: number; rejectAlways?: boolean; proseOnly?: boolean; failedRepair?: boolean; stopRepair?: boolean; initialCheckFailure?: boolean; twoWorkers?: boolean; alternateRuntime?: boolean } = {}) {
  const fixture = await useFixture('ts-bug');
  const state = openTempState();
  registerCleanup(() => state.cleanup());
  const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('review-repair-config-'), { planner: true }));
  const worker = loaded.config.agents.find((agent) => agent.id === 'engineer')!;
  const config = { ...loaded.config, runtimes: { ...loaded.config.runtimes, ...(options.alternateRuntime ? { 'alternate-local': loaded.config.runtimes[worker.runtime]! } : {}) }, defaults: { ...loaded.config.defaults, maxRepairAttempts: options.max ?? 1 }, agents: [...loaded.config.agents, { ...worker, id: 'other-worker', instructions: 'Write the beta document.', runtime: options.alternateRuntime ? 'alternate-local' : worker.runtime }] };
  const controller = new AbortController();
  let reviewCount = 0;
  let workerCount = 0;
  let stopping = options.stopRepair ?? false;
  let providerFailure = false;
  let alternateFactoryCount = 0;
  const seededContent: string[] = [];
  const activeWorkers = new Set<string>();
  let peakWorkers = 0;
  const adapterFactory: NonNullable<RunPlannedInput['adapterFactory']> = (runtime, context) => {
    if (runtime.id === 'alternate-local') alternateFactoryCount++;
    const scenarioPath = writeScenario({ scenarioVersion: 1, steps: [{ action: 'claim_done' }] });
    if (context.taskId === 'head-review') {
      class Head extends FakeAdapter {
        override async openSession(input: SessionInput): Promise<SessionHandle> {
          reviewCount++;
          const revision = (await git(['rev-parse', 'HEAD'], { cwd: input.cwd })).stdout.trim();
          const diff = await git(['diff', '--binary', '--no-ext-diff', `${fixture.headRevision}..${revision}`], { cwd: input.cwd });
          const text = readFileSync(path.join(input.cwd, 'docs/alpha.md'), 'utf8');
          const rejected = options.rejectAlways || !text.includes('Error responses');
          const decision = { reviewVersion: 1, candidateRevision: revision, diffHash: sha256Hex(Buffer.from(diff.stdout)), verdict: rejected ? 'changes_requested' : 'approve', summary: rejected ? 'Document error responses in the alpha guide.' : 'The alpha guide now documents error responses and the independent checks pass.', findings: rejected ? [{ summary: 'Add the missing error responses.', file: 'docs/alpha.md', line: 3 }] : [] };
          writeFileSync(scenarioPath, JSON.stringify({ scenarioVersion: 1, steps: options.proseOnly ? [{ action: 'claim_done', message: JSON.stringify(decision) }] : [{ action: 'call_tool', tool: HEAD_REVIEW_TOOL, arguments: decision }, { action: 'claim_done' }] }));
          return super.openSession(input);
        }
      }
      return new Head({ scenarioPath });
    }
    class Worker extends FakeAdapter {
      override async openSession(input: SessionInput): Promise<SessionHandle> {
        workerCount++;
        const seeded = existsSync(path.join(input.cwd, 'docs/alpha.md'));
        const beta = input.systemInstructions === 'Write the beta document.';
        if (seeded) seededContent.push(readFileSync(path.join(input.cwd, 'docs/alpha.md'), 'utf8'));
        const steps = options.initialCheckFailure && workerCount === 1
          ? [{ action: 'edit_file', path: 'docs/alpha.md', content: '# Alpha\nOriginal content preserved.\n' }, { action: 'edit_file', path: 'fail-marker', content: 'bad' }, { action: 'claim_done' }]
          : seeded && stopping
          ? [{ action: 'message', text: 'REVIEW-REPAIR-WAITING' }, { action: 'sleep', ms: 60_000 }]
          : seeded && providerFailure
          ? [{ action: 'message', text: 'Provider quota exhausted.' }, { action: 'claim_done' }]
          : options.failedRepair && seeded
            ? [{ action: 'edit_file', path: 'fail-marker', content: 'bad' }, { action: 'claim_done' }]
            : [{ action: 'edit_file', path: beta ? 'docs/beta.md' : 'docs/alpha.md', content: beta ? '# Beta\nUnchanged sibling deliverable.\n' : seeded ? '# Alpha\nOriginal content preserved.\nError responses are 400 for invalid input.\n' : '# Alpha\nOriginal content preserved.\n' }, { action: 'claim_done' }];
        writeFileSync(scenarioPath, JSON.stringify({ scenarioVersion: 1, steps }));
        activeWorkers.add(context.taskId);
        peakWorkers = Math.max(peakWorkers, activeWorkers.size);
        return super.openSession(input);
      }
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          if (providerFailure && event.kind === 'turn_completed') yield { ...event, payload: { status: 'failed', httpStatus: 429, error: 'Provider quota exhausted.' } };
          else yield event;
        }
      }
      override async stopOwnedProcesses(handle: SessionHandle) {
        const result = await super.stopOwnedProcesses(handle);
        activeWorkers.delete(context.taskId);
        return result;
      }
    }
    return new Worker({ scenarioPath });
  };
  const input: RunPlannedInput = {
    repoPath: fixture.path, config, configRaw: JSON.stringify(config), configPath: loaded.path,
    requestText: 'Write the alpha guide including error responses.', requestSource: 'test',
    tasks: [{ key: 'alpha', objective: 'Write docs/alpha.md including error responses.', agentId: 'engineer' }, ...(options.twoWorkers ? [{ key: 'beta', objective: 'Write docs/beta.md.', agentId: 'other-worker' }] : [])],
    paths: state.paths, db: state.store.db, checkFlags: ["node -e \"process.exit(require('node:fs').existsSync('fail-marker') ? 1 : 0)\""],
    allowUnconfinedWrites: true, headReview: { required: true, headAgentId: 'planner', deadlineMs: 15_000 },
    adapterFactory, signal: controller.signal,
    stream: { event: () => undefined, line: (line) => { if (line.includes('REVIEW-REPAIR-WAITING')) controller.abort(); } },
  };
  return { input, fixture, state, seededContent, counts: () => ({ reviewCount, workerCount, peakWorkers, alternateFactoryCount }), stopSleeping: () => { stopping = false; }, failProvider: () => { providerFailure = true; } };
}

describe('bounded repair of department-head findings', () => {
  it('returns findings to their original owner, preserves prior work and sibling artifacts, and rechecks the combined candidate', async () => {
    const test = await setup({ twoWorkers: true });
    const before = await fingerprintCheckout(test.fixture.path);
    const result = await runPlanned(test.input);
    expect(result.accepted, result.reason).toBe(true);
    expect(test.counts()).toMatchObject({ reviewCount: 2, workerCount: 3 });
    expect(test.seededContent).toEqual(['# Alpha\nOriginal content preserved.\n']);
    expect(result.tasks.find((task) => task.key === 'alpha')?.repairsUsed).toBe(1);
    expect(result.tasks.find((task) => task.key === 'beta')?.repairsUsed).toBe(0);
    const events = listEvents(test.state.store.db, result.runId);
    const repairs = events.filter((event) => event.type === 'head.review_repair_started');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.payload).toMatchObject({ key: 'alpha', agentId: 'engineer', attemptNumber: 1 });
    expect(events.filter((event) => event.type === 'control.final_reply')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'head.review_finished').map((event) => event.payload['verdict'])).toEqual(['changes_requested', 'passed']);
    if (result.combination?.status !== 'combined') throw new Error('Missing final combination');
    const finalRevision = result.combination.combinedRevision;
    expect(result.combination.receipts.every((receipt) => receipt.candidate.revision === finalRevision && receipt.outcome === 'passed')).toBe(true);
    expect((await git(['show', `${result.combination.combinedRevision}:docs/beta.md`], { cwd: test.fixture.path })).stdout).toContain('Unchanged sibling');
    expect(await fingerprintCheckout(test.fixture.path)).toEqual(before);
  }, 60_000);

  it('stops with precise findings after the existing repair budget is exhausted', async () => {
    const test = await setup({ rejectAlways: true, max: 1 });
    const result = await runPlanned(test.input);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('repair budget (1/1)');
    expect(result.reason).toContain('Document error responses');
    expect(test.counts()).toMatchObject({ reviewCount: 2, workerCount: 2 });
    expect(listEvents(test.state.store.db, result.runId).filter((event) => event.type === 'control.final_reply')).toHaveLength(0);
    expect(result.headReview?.findings[0]?.file).toBe('docs/alpha.md');
  }, 60_000);


  it('shares one budget with earlier failed-check repairs instead of granting review a new budget', async () => {
    const test = await setup({ initialCheckFailure: true, max: 1 });
    const result = await runPlanned(test.input);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('repair budget (1/1)');
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 2 });
    const events = listEvents(test.state.store.db, result.runId);
    expect(events.filter((event) => event.type === 'task.repair_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'head.review_repair_started')).toHaveLength(0);
  }, 60_000);

  it('starts no repair when the budget is zero', async () => {
    const test = await setup({ max: 0 });
    const result = await runPlanned(test.input);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('(0/0)');
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 1 });
  }, 60_000);

  it('cannot approve or start semantic repair from review prose', async () => {
    const test = await setup({ proseOnly: true });
    const result = await runPlanned(test.input);
    expect(result.accepted).toBe(false);
    expect(result.headReview?.verdict).toBe('blocked');
    expect(result.reason).toContain('did not submit a structured review');
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 1 });
  }, 60_000);

  it('does not reuse the old passing combined receipts when the repair fails its independent checks', async () => {
    const test = await setup({ failedRepair: true, max: 1 });
    const result = await runPlanned(test.input);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('did not pass independent checks');
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 2 });
    expect(result.tasks[0]?.attempts.at(-1)?.receipts.some((receipt) => receipt.outcome === 'failed')).toBe(true);
    expect(listEvents(test.state.store.db, result.runId).filter((event) => event.type === 'control.final_reply')).toHaveLength(0);
  }, 60_000);

  it('stops a repair without dispatching more work, then resumes the same saved owner, patch and repair budget', async () => {
    const test = await setup({ stopRepair: true, max: 1 });
    const stopped = await runPlanned(test.input);
    expect(stopped.outcome).toBe('interrupted');
    expect(stopped.accepted).toBe(false);
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 2 });
    test.stopSleeping();
    transitionRun(test.state.store.db, stopped.runId, 'running');
    const { signal: _signal, tasks: _tasks, ...continuation } = test.input;
    const resumed = await continuePlannedRun({ ...continuation, runId: stopped.runId });
    expect(resumed.accepted, resumed.reason).toBe(true);
    expect(resumed.tasks[0]?.repairsUsed).toBe(1);
    expect(test.seededContent).toHaveLength(2);
    expect(listEvents(test.state.store.db, stopped.runId).filter((event) => event.type === 'head.review_repair_started')).toHaveLength(1);
  }, 60_000);

  it('retains the saved repair owner when a resumed provider fails, without probing or dispatching a replacement worker', async () => {
    const test = await setup({ stopRepair: true, max: 1, alternateRuntime: true });
    const stopped = await runPlanned(test.input);
    expect(stopped.outcome).toBe('interrupted');
    test.stopSleeping();
    test.failProvider();
    transitionRun(test.state.store.db, stopped.runId, 'running');
    const { signal: _signal, tasks: _tasks, ...continuation } = test.input;
    const resumed = await continuePlannedRun({ ...continuation, runId: stopped.runId });
    expect(resumed.accepted).toBe(false);
    expect(resumed.tasks[0]?.attempts.at(-1)?.failure?.failureClass, resumed.reason).toBe('quota');
    expect(resumed.tasks[0]?.repairsUsed).toBe(1);
    expect(test.counts()).toMatchObject({ reviewCount: 1, workerCount: 3, alternateFactoryCount: 0 });
    const events = listEvents(test.state.store.db, stopped.runId);
    expect(events.filter((event) => event.type === 'head.review_repair_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'runtime.fallback_selected')).toHaveLength(0);
    expect(test.seededContent).toHaveLength(2);
  }, 60_000);
});
