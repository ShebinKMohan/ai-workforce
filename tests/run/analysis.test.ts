import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFakeRuntimeScript, FAKE_SCENARIO_ENV, FakeAdapter, type SessionInput, type SessionHandle, type RuntimeEvent, type TurnHandle } from '../../src/adapters/index.js';
import { commandRun } from '../../src/cli/commands/run.js';
import { commandResume } from '../../src/cli/commands/resume.js';
import { Reporter } from '../../src/cli/output.js';
import { HEAD_PLAN_TOOL } from '../../src/routing/head-planner.js';
import { HEAD_REVIEW_TOOL } from '../../src/routing/head-reviewer.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { listArtifacts, readArtifact } from '../../src/storage/artifacts.js';
import { listEvents } from '../../src/storage/events.js';
import { openStateStore } from '../../src/storage/db.js';
import { projectStatePaths } from '../../src/workspace/paths.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { git } from '../../src/workspaces/git.js';
import { build, cleanupAll, gitRepo, sink, tempDir } from '../workspace/helpers.js';
import { cleanupAll as cleanupScenarios, fingerprintCheckout, writeScenario } from '../workspaces/support.js';

afterEach(() => { cleanupAll(); cleanupScenarios(); });

const REPORT = 'The README.md describes a catalog API. src/catalog.mjs exports lookup(id), which returns a catalog record. No files were changed and no tests were run.';
const FINAL = 'This codebase provides a catalog lookup API. src/catalog.mjs exports lookup(id); README.md records its purpose. This was a read-only source review, and no code tests were run.';

async function setup() {
  const repoPath = await gitRepo({ 'README.md': '# Catalog API\n', 'src/catalog.mjs': 'export const lookup = id => ({ id, name: "Catalog record" });\n' });
  const root = tempDir();
  updateWorkspace(root, current => build([
    { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
    { op: 'department.add', id: 'engineering', name: 'Engineering' },
    { op: 'agent.add', id: 'head', role: 'head', departmentId: 'engineering', runtime: 'fake-local' },
    { op: 'agent.add', id: 'worker', role: 'worker', departmentId: 'engineering', runtime: 'fake-local' },
    { op: 'project.add', id: 'catalog', repoPath },
  ], current));
  return { root, repoPath };
}

function fixtureAdapter(options: { report?: boolean; firstReviewMissing?: boolean; firstReviewInvalid?: boolean; reject?: boolean; fullPlanner?: boolean } = {}) {
  let reviewCount = 0;
  let workerCount = 0;
  const sessions: SessionInput[] = [];
  class AnalysisFixture extends FakeAdapter {
    override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
      for await (const event of super.events(turn)) yield event.kind === 'command_exec' ? { ...event, payload: { ...event.payload, itemId: 'read-catalog', command: 'cat src/catalog.mjs', phase: 'completed', status: 'completed', exitCode: 0 } } : event;
    }
    override async openSession(input: SessionInput): Promise<SessionHandle> {
      sessions.push(input);
      const review = input.systemInstructions.includes('review the completed candidate as department head');
      let steps: Array<Record<string, unknown>>;
      if (options.fullPlanner && !review && !input.systemInstructions.includes('For this assignment inspect and explain only.')) {
        steps = [
          { action: 'call_tool', tool: HEAD_PLAN_TOOL, arguments: { planVersion: 2, summary: 'Inspect the catalog with one worker.', tasks: [{ id: 'inspect', objective: 'Inspect the catalog source and report its features.', assignee: 'worker', acceptanceCriteria: [{ id: 'features', description: 'Explain lookup(id) with source references.' }], scope: { allowedPaths: ['src/catalog.mjs', 'README.md'] } }] } },
          { action: 'claim_done', message: 'Inspection plan submitted.' },
        ];
      } else if (review) {
        reviewCount++;
        const revision = (await git(['rev-parse', 'HEAD'], { cwd: input.cwd })).stdout.trim();
        steps = options.firstReviewMissing && reviewCount === 1 ? [{ action: 'claim_done', message: 'No decision submitted.' }] : [
          { action: 'call_tool', tool: HEAD_REVIEW_TOOL, arguments: { reviewVersion: 1, candidateRevision: revision, diffHash: sha256Hex(''), verdict: options.reject ? 'changes_requested' : 'approve', summary: options.firstReviewInvalid && reviewCount === 1 ? 'x'.repeat(8001) : options.reject ? 'The report omits the catalog API.' : FINAL, findings: options.reject ? [{ summary: 'Explain lookup(id).' }] : [] } },
          { action: 'claim_done', message: 'Decision recorded.' },
        ];
      } else {
        workerCount++;
        // Fixture-only observation; the integration test checks lifecycle and
        // receipt authority, not a fake runtime's semantic understanding.
        expect(readFileSync(path.join(input.cwd, 'src/catalog.mjs'), 'utf8')).toContain('lookup');
        steps = [{ action: 'sleep', ms: 1 }, ...(options.report === false ? [] : [{ action: 'claim_done', message: REPORT }])];
      }
      return super.openSession({ ...input, env: { ...input.env, [FAKE_SCENARIO_ENV]: writeScenario({ scenarioVersion: 1, steps }) } });
    }
  }
  return { factory: () => new AnalysisFixture(), sessions, get workers() { return workerCount; }, get reviews() { return reviewCount; } };
}

async function run(root: string, adapter: ReturnType<typeof fixtureAdapter>, workKind = 'analysis') {
  const streams = { stdout: sink(() => {}), stderr: sink(() => {}) };
  return commandRun({ project: 'catalog', department: 'engineering', task: 'Run through this codebase and explain its features.', stateDir: root, workKind, allowUnconfinedWrites: true, json: true },
    { streams, reporter: new Reporter(true, streams), adapterFactory: adapter.factory, headPlanner: async () => ({ ok: true, summary: 'One inspection task for one worker.', tasks: [{ key: 'inspect', objective: 'Inspect the catalog source and report its features.', agentId: 'worker' }] }) });
}

describe('read-only analysis without project checks or placement', () => {
  it('captures inspection and unchanged-source receipts, reviews the report, and never claims code acceptance', async () => {
    const { root, repoPath } = await setup();
    const before = await fingerprintCheckout(repoPath);
    const adapter = fixtureAdapter();
    const result = await run(root, adapter);
    expect(result.exitCode, JSON.stringify(result.data)).toBe(0);
    expect(result.data).toMatchObject({ workKind: 'analysis', analysisReviewed: true, accepted: false, finalReply: FINAL });
    expect(adapter.workers).toBe(1); expect(adapter.reviews).toBe(1);
    expect(adapter.sessions.every(session => session.policy === 'analysis' && session.allowedWritePaths.length === 0)).toBe(true);
    const store = openStateStore(projectStatePaths(root, 'catalog'), { mode: 'read-only' });
    try {
      const runId = String(result.data['runId']);
      const artifacts = listArtifacts(store.db, runId);
      const report = artifacts.find(artifact => artifact.type === 'analysis_report')!;
      expect(JSON.parse(readArtifact(store.db, store.paths, report.id).bytes.toString())).toMatchObject({ report: REPORT, sourceUnchanged: true, sessionStopped: true, toolCallCount: 1 });
      const manifest = artifacts.find(artifact => artifact.relativePath === 'result.json')!;
      expect(JSON.parse(readArtifact(store.db, store.paths, manifest.id).bytes.toString())).toMatchObject({ workKind: 'analysis', analysisReviewed: true, accepted: false, reportArtifactIds: [report.id] });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM checks').get()).toMatchObject({ n: 0 });
      expect(listEvents(store.db, runId).find(event => event.type === 'control.final_reply')?.payload).toMatchObject({ verificationStatus: 'reviewed_analysis', reportArtifactIds: [report.id] });
    } finally { store.close(); }
    expect(await fingerprintCheckout(repoPath)).toEqual(before);
  }, 60_000);

  it('lets the real head-planning tool dispatch an analysis task without a configured check', async () => {
    const { root } = await setup();
    const adapter = fixtureAdapter({ fullPlanner: true });
    const streams = { stdout: sink(() => {}), stderr: sink(() => {}) };
    const result = await commandRun({ project: 'catalog', department: 'engineering', task: 'Explain this codebase without changing it.', stateDir: root, workKind: 'analysis', allowUnconfinedWrites: true, json: true }, { streams, reporter: new Reporter(true, streams), adapterFactory: adapter.factory });
    expect(result.exitCode, JSON.stringify(result.data)).toBe(0);
    expect(result.data).toMatchObject({ workKind: 'analysis', analysisReviewed: true, accepted: false, finalReply: FINAL });
    expect(adapter.workers).toBe(1); expect(adapter.reviews).toBe(1);
    const store = openStateStore(projectStatePaths(root, 'catalog'), { mode: 'read-only' });
    try {
      const events = listEvents(store.db, String(result.data['runId']));
      expect(events.some(event => event.type === 'plan.validated')).toBe(true);
      expect(events.find(event => event.type === 'plan.registered')?.payload).toMatchObject({ workKind: 'analysis', taskCount: 1 });
      expect(events.find(event => event.type === 'run.created')?.payload).toMatchObject({ workKind: 'analysis' });
    } finally { store.close(); }
  }, 60_000);

  it('keeps implementation blocked without real acceptance checks', async () => {
    const { root } = await setup();
    const adapter = fixtureAdapter();
    await expect(run(root, adapter, 'implementation')).rejects.toMatchObject({ code: 'project_has_no_checks' });
    expect(adapter.sessions).toHaveLength(0);
  });

  it('does not finish a missing report or a report rejected by the department head', async () => {
    for (const options of [{ report: false }, { reject: true }]) {
      const { root } = await setup();
      const result = await run(root, fixtureAdapter(options));
      expect(result.exitCode).toBe(4);
      expect(result.data).toMatchObject({ analysisReviewed: false, accepted: false, finalReply: null });
    }
  }, 60_000);

  it('refuses changing the frozen analysis into implementation during Resume before another runtime opens', async () => {
    const { root } = await setup();
    const adapter = fixtureAdapter({ firstReviewMissing: true });
    const first = await run(root, adapter);
    expect(first.exitCode).toBe(130);
    const runId = String(first.data['runId']);
    const paths = projectStatePaths(root, 'catalog');
    const planPath = path.join(paths.runDir(runId), 'plan.json');
    const changedPlan = { ...JSON.parse(readFileSync(planPath, 'utf8')), workKind: 'implementation', checkFlags: ['node --version'] };
    const raw = `${JSON.stringify(changedPlan, null, 2)}\n`;
    writeFileSync(planPath, raw);
    const store = openStateStore(paths, { mode: 'mutating' });
    try {
      const registration = listEvents(store.db, runId).find(event => event.type === 'plan.registered')!;
      // Even a matching edited plan-registration record cannot override the
      // independently frozen kind recorded when the run was created.
      store.db.prepare("UPDATE events SET payload_json = ? WHERE run_id = ? AND type = 'plan.registered'").run(JSON.stringify({ ...registration.payload, workKind: 'implementation', sha256: sha256Hex(raw) }), runId);
    } finally { store.close(); }
    const before = adapter.sessions.length;
    await expect(commandResume({ positionals: [runId], stateDir: paths.root, allowUnconfinedWrites: true, json: true }, { continuation: { adapterFactory: adapter.factory } })).rejects.toThrow('cannot change an implementation request into analysis or analysis into implementation');
    expect(adapter.sessions).toHaveLength(before);
  }, 60_000);

  it.each(['missing', 'invalid'] as const)('resumes a %s structured review using the captured report without redispatching its worker or overwriting earlier evidence', async mode => {
    const { root } = await setup();
    const adapter = fixtureAdapter(mode === 'missing' ? { firstReviewMissing: true } : { firstReviewInvalid: true });
    const first = await run(root, adapter);
    expect(first.exitCode, JSON.stringify(first.data)).toBe(130);
    expect(first.data).toMatchObject({ analysisReviewed: false, runState: 'interrupted' });
    const initial = openStateStore(projectStatePaths(root, 'catalog'), { mode: 'read-only' });
    try {
      const finished = listEvents(initial.db, String(first.data['runId'])).find(event => event.type === 'head.review_finished');
      expect(finished?.payload).toMatchObject({ verdict: 'blocked', failureCode: 'head_review_invalid', interrupted: false, sessionStopped: true });
    } finally { initial.close(); }
    const resumed = await commandResume({ positionals: [String(first.data['runId'])], stateDir: projectStatePaths(root, 'catalog').root, allowUnconfinedWrites: true, json: true }, { continuation: { adapterFactory: adapter.factory } });
    expect(resumed.exitCode, JSON.stringify(resumed.data)).toBe(0);
    expect(adapter.workers).toBe(1); expect(adapter.reviews).toBe(2);
    const store = openStateStore(projectStatePaths(root, 'catalog'), { mode: 'read-only' });
    try {
      const artifacts = listArtifacts(store.db, String(first.data['runId']));
      expect(artifacts.filter(artifact => artifact.type === 'analysis_report')).toHaveLength(1);
      expect(artifacts.filter(artifact => artifact.type === 'analysis_result')).toHaveLength(2);
      expect(artifacts.some(artifact => artifact.relativePath === 'result.json')).toBe(true);
    } finally { store.close(); }
  }, 60_000);
});
