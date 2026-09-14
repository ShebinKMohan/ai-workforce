import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateIssueSchema, StartIssueSchema, type IssueRecord } from '../../src/issues/contracts.js';
import { IssueStore } from '../../src/issues/store.js';
import { issueView } from '../../src/issues/projection.js';
import type { RequestItem } from '../../src/server/requests.js';
import { writeArtifact } from '../../src/storage/artifacts.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/events.js';
import { acquireCoordinatorLock } from '../../src/storage/lock.js';
import { beginNewGeneration, transitionRun, transitionTask } from '../../src/storage/records.js';
import { projectStatePaths } from '../../src/workspace/paths.js';
import { seedAttempt, seedRun, seedTask } from '../coordination/helpers.js';
import { sampleWorkspace } from '../workspace/helpers.js';

const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const now = '2026-09-13T12:00:00.000Z';

function issue(): IssueRecord {
  return { schemaVersion: 1, id: randomUUID(), projectId: 'example', revision: 1, title: 'Fix login', description: 'Restore the documented login behavior.', kind: 'issue', source: 'codex', manualStatus: 'backlog', priority: 'none', createdAt: now, updatedAt: now, completedAt: null, dispatch: null };
}

function request(overrides: Partial<RequestItem> = {}): RequestItem {
  return { id: randomUUID(), clientRequestId: 'issue-submission', kind: 'request', projectId: 'example', departmentId: 'engineering', task: 'Fix login', resumeRunId: null, allowUnconfinedWrites: false, state: 'queued', reason: null, receivedAt: now, startedAt: null, endedAt: null, heldAt: null, agentIds: [], workerIds: [], exclusive: false, unconfinedRuntimes: [], launchId: null, pid: null, pidStartedAtMs: null, stdoutPath: null, stderrPath: null, runId: null, stopRequestedAt: null, exitCode: null, signal: null, result: null, ...overrides };
}

function submitted(item: RequestItem | null): IssueRecord {
  return { ...issue(), dispatch: { clientRequestId: 'issue-submission', task: item?.task ?? 'Frozen submitted task', allowUnconfinedWrites: false, startedAt: now, state: 'submitted', request: item, retryRequest: null, retryConflict: null, error: null } };
}

function answered(overrides: Partial<RequestItem> = {}): RequestItem {
  return request({ state: 'ended', departmentId: null, exitCode: 0, endedAt: '2026-09-13T12:00:19.000Z',
    controlReply: 'Understood. No project work was requested.',
    result: { exitCode: 0, code: 'control_reply', message: 'Understood. No project work was requested.', details: [] },
    route: { state: 'selected', projectId: 'example', departmentId: null, headAgentId: null, reason: 'A direct response is sufficient.', method: 'direct_reply', decidedAt: '2026-09-13T12:00:18.000Z', elapsedMs: 18000 },
    routingSession: { sessionId: 'answer-session', process: null, state: 'stopped' }, ...overrides });
}

/** Real storage rows and registered immutable artifacts; no runtime is invoked.
 * The fixture represents the coordinator's recorded acceptance contract. */
function runFixture(accepted = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workforce-issue-projection-'));
  roots.push(root);
  const paths = projectStatePaths(root, 'example');
  const store = openStateStore(paths, { mode: 'mutating' });
  cleanups.push(() => store.close());
  const run = seedRun(store.db);
  const task = seedTask(store.db, run.id);
  const attempt = seedAttempt(store.db, task.id);
  transitionRun(store.db, run.id, 'running');
  transitionTask(store.db, task.id, 'ready');
  transitionTask(store.db, task.id, 'running');
  const item = request({ runId: run.id, state: 'running', pid: store.lock!.info.pid, pidStartedAtMs: store.lock!.info.processStartedAtMs });
  const record = submitted(item);
  const candidateRevision = 'a'.repeat(40);
  const diffHash = 'b'.repeat(64);
  function receipt(attemptId: string, outcome: 'passed' | 'compromised' = 'passed') {
    const checkId = randomUUID();
    store.db.prepare(`INSERT INTO checks(id, run_id, task_id, attempt_id, criterion_ids_json, command, args_json, cwd, env_identity, candidate_revision, outcome, exit_code, evidence_provenance, created_at)
      VALUES (?, ?, ?, ?, '["tests-pass"]', 'node', '["test.js"]', '.', '{}', ?, 'passed', 0, 'verifier_executed', ?)`).run(checkId, run.id, task.id, attemptId, candidateRevision, now);
    const artifact = writeArtifact(store.db, paths, { runId: run.id, taskId: task.id, attemptId, type: 'result_manifest', relativePath: `tasks/${attemptId}/result.json`, bytes: JSON.stringify({ requirements: [{ criterionId: 'tests-pass', status: outcome, receiptId: checkId }], acceptance: { accepted: outcome === 'passed' } }), provenance: { producer: 'test coordinator fixture' } });
    return { checkId, file: path.join(paths.runArtifactsDir(run.id), artifact.relativePath) };
  }
  let manifest: ReturnType<typeof receipt> | null = null;
  if (accepted) {
    manifest = receipt(attempt.id);
    transitionTask(store.db, task.id, 'validating');
    transitionTask(store.db, task.id, 'accepted');
    transitionRun(store.db, run.id, 'ready_for_review');
  }
  function review(fields: Record<string, unknown> = {}, combinedRevision = candidateRevision) {
    appendEvent(store.db, { runId: run.id, type: 'integration.combined', payload: { combinedRevision, accepted: true, unverifiedCriteria: [] } });
    const decision = { reviewVersion: 1, reviewId: randomUUID(), headAgentId: 'engineering-head', candidateRevision, diffHash, verdict: 'passed', summary: 'Checked and approved.', sessionStopped: true, interrupted: false, artifactId: null, ...fields };
    const artifact = writeArtifact(store.db, paths, { runId: run.id, type: 'head_review_result', relativePath: `head/reviews/${decision.reviewId}/result.json`, bytes: JSON.stringify(decision), provenance: { producer: 'headReviewer' } });
    appendEvent(store.db, { runId: run.id, type: 'head.review_finished', payload: { ...decision, artifactId: artifact.id } });
    return { artifact, file: path.join(paths.runArtifactsDir(run.id), artifact.relativePath) };
  }
  return { root, paths, store, run, task, attempt, item, record, receipt, review, manifest, candidateRevision };
}

/** Captured read-only reports intentionally have no code-check receipts. */
function analysisFixture(reportFields: Record<string, unknown> = {}) {
  const fixture = runFixture(false);
  const { store, paths, run, task, candidateRevision } = fixture;
  appendEvent(store.db, { runId: run.id, type: 'run.created', payload: { workKind: 'analysis' } });
  const report = writeArtifact(store.db, paths, {
    runId: run.id, taskId: task.id, type: 'analysis_report', relativePath: 'analysis/report.json', provenance: { producer: 'analysisRunner' },
    bytes: JSON.stringify({ runId: run.id, taskId: task.id, baseRevision: candidateRevision, report: 'The API handles login in src/login.ts.', sourceUnchanged: true, sessionStopped: true, toolCallCount: 3, ...reportFields }),
  });
  const review = { verdict: 'passed', sessionStopped: true, reviewId: randomUUID(), candidateRevision };
  const head = writeArtifact(store.db, paths, { runId: run.id, type: 'head_review_result', relativePath: 'analysis/review.json', provenance: { producer: 'headReviewer' }, bytes: JSON.stringify(review) });
  const manifest = writeArtifact(store.db, paths, {
    runId: run.id, type: 'analysis_result', relativePath: 'result.json', provenance: { producer: 'analysisRunner' },
    bytes: JSON.stringify({ runId: run.id, base: { revision: candidateRevision }, workKind: 'analysis', analysisReviewed: true, accepted: false, reportArtifactIds: [report.id], headReview: { ...review, artifactId: head.id } }),
  });
  appendEvent(store.db, { runId: run.id, type: 'control.final_reply', payload: { verificationStatus: 'reviewed_analysis', source: 'department_head_analysis_review', artifactId: head.id, reportArtifactIds: [report.id] } });
  appendEvent(store.db, { runId: run.id, type: 'run.analysis_reviewed', payload: { analysisReviewed: true, reportArtifactIds: [report.id] } });
  transitionTask(store.db, task.id, 'validating');
  transitionTask(store.db, task.id, 'accepted');
  transitionRun(store.db, run.id, 'ready_for_review');
  return { ...fixture, analysisFiles: { report: path.join(paths.runArtifactsDir(run.id), report.relativePath), head: path.join(paths.runArtifactsDir(run.id), head.relativePath), manifest: path.join(paths.runArtifactsDir(run.id), manifest.relativePath) }, headArtifact: head };
}

describe('issue board execution projection', () => {
  it('follows a validated retry to its verified run and retains that lineage after queue pruning', () => {
    const fixture = runFixture(); fixture.review();
    const store = new IssueStore(fixture.root);
    const card = store.create(CreateIssueSchema.parse({ projectId: 'example', title: 'Fix login', description: '', idempotencyKey: 'original-issue' }));
    const intent = store.beginDispatch(card.id, StartIssueSchema.parse({ expectRevision: card.revision })).issue.dispatch!;
    const original = request({ clientRequestId: intent.clientRequestId, state: 'ended', exitCode: 1, endedAt: now });
    store.recordRequest(card.id, original);
    const firstRetry = request({ clientRequestId: 'retry-first', state: 'ended', exitCode: 1, endedAt: now, retryOfRequestId: original.id, retryRootRequestId: original.id, retryAttempt: 1, retryReason: 'manual' });
    const retry = { ...fixture.item, clientRequestId: 'retry-second', state: 'ended' as const, exitCode: 0, endedAt: now, retryOfRequestId: firstRetry.id, retryRootRequestId: original.id, retryAttempt: 2, retryReason: 'manual' as const };
    expect(issueView(store.get(card.id), fixture.root, original, false, [original, firstRetry, retry])).toMatchObject({ requestId: retry.id, runId: fixture.run.id, status: 'done', execution: { verified: true } });
    store.recordRequests([original, firstRetry]);
    // Queue retention has removed both preceding failures before this update.
    store.recordRequests([retry]);
    const reopened = new IssueStore(fixture.root).get(card.id);
    expect(reopened.dispatch).toMatchObject({ clientRequestId: intent.clientRequestId, task: intent.task, request: { id: original.id }, retryRequest: { id: retry.id } });
    expect(issueView(reopened, fixture.root, null)).toMatchObject({ id: card.id, title: card.title, description: card.description, requestId: retry.id, runId: fixture.run.id, status: 'done', execution: { verified: true } });
    expect(store.create(CreateIssueSchema.parse({ projectId: 'example', title: 'Fix login', description: '', idempotencyKey: 'original-issue' })).id).toBe(card.id);
  });

  it('never adopts another project, a changed brief, or a retry of a stopped original as issue completion', () => {
    const fixture = runFixture(); fixture.review();
    const original = request({ state: 'ended', exitCode: 1, endedAt: now });
    const retry = { ...fixture.item, clientRequestId: 'retry-foreign', retryOfRequestId: original.id, retryRootRequestId: original.id, retryAttempt: 1, retryReason: 'manual' as const };
    for (const candidate of [{ ...retry, projectId: 'other' }, { ...retry, task: 'Different work' }, { ...retry, retryRootRequestId: 'unrelated' }]) {
      expect(issueView(submitted(original), fixture.root, original, false, [original, candidate])).toMatchObject({ requestId: original.id, runId: null, execution: { verified: false } });
    }
    const stopped = { ...original, stopRequestedAt: now, exitCode: 130 };
    expect(issueView(submitted(stopped), fixture.root, stopped, false, [stopped, retry])).toMatchObject({ requestId: original.id, runId: null, execution: { verified: false } });
  });

  it('retains an ambiguous retry result as unknown after the conflicting queue history is pruned', () => {
    const fixture = runFixture(); fixture.review();
    const store = new IssueStore(fixture.root);
    const card = store.create(CreateIssueSchema.parse({ projectId: 'example', title: 'Fix login', description: '', idempotencyKey: 'ambiguous-issue' }));
    const intent = store.beginDispatch(card.id, StartIssueSchema.parse({ expectRevision: card.revision })).issue.dispatch!;
    const original = request({ clientRequestId: intent.clientRequestId, state: 'ended', exitCode: 1, endedAt: now });
    const first = { ...fixture.item, clientRequestId: 'retry-first', state: 'ended' as const, exitCode: 0, endedAt: now, retryOfRequestId: original.id, retryRootRequestId: original.id, retryAttempt: 1, retryReason: 'manual' as const };
    const competing = { ...first, id: randomUUID(), clientRequestId: 'retry-competing' };
    store.recordRequests([original, first]);
    expect(issueView(store.get(card.id), fixture.root, null).status).toBe('done');
    store.recordRequests([original, first, competing]);
    expect(store.get(card.id).dispatch?.retryConflict).toBeTruthy();
    store.recordRequest(card.id, { ...original, reason: 'Original failure retained.' });
    const reopened = new IssueStore(fixture.root).get(card.id);
    expect(issueView(reopened, fixture.root, null)).toMatchObject({ status: 'todo', execution: { state: 'unknown', verified: false, completedAt: null } });
    store.recordRequests([first]);
    expect(issueView(store.get(card.id), fixture.root, null).execution.state).toBe('unknown');
  });

  it('shows a cancelled retry as cancelled and never borrows a separate successful run', () => {
    const original = request({ state: 'ended', exitCode: 1, endedAt: now });
    const retry = request({ clientRequestId: 'cancelled-retry', state: 'discarded', retryOfRequestId: original.id, retryRootRequestId: original.id, retryAttempt: 1, retryReason: 'manual', endedAt: now });
    expect(issueView(submitted(original), '/does-not-exist', original, false, [original, retry])).toMatchObject({ requestId: retry.id, runId: null, status: 'cancelled', execution: { state: 'cancelled', verified: false, completedAt: null } });
  });

  it('shows a queued same-run retry while the previous run is failed, and refuses cancelled-run completion', () => {
    const fixture = runFixture(false);
    transitionRun(fixture.store.db, fixture.run.id, 'failed');
    const original = { ...fixture.item, state: 'ended' as const, exitCode: 1, endedAt: now };
    const retry = request({ kind: 'resume', clientRequestId: 'retry-resume', resumeRunId: fixture.run.id, runId: fixture.run.id, retryOfRequestId: original.id, retryRootRequestId: original.id, retryAttempt: 1, retryReason: 'manual', retryFailed: true });
    expect(issueView(submitted(original), fixture.root, original, false, [original, retry])).toMatchObject({ requestId: retry.id, runId: fixture.run.id, status: 'todo', execution: { state: 'queued', runState: 'failed', completedAt: null, endedAt: null } });
    fixture.store.db.prepare("UPDATE runs SET state = 'cancelled' WHERE id = ?").run(fixture.run.id);
    expect(issueView(submitted(original), fixture.root, original, false, [original, retry])).toMatchObject({ status: 'cancelled', execution: { state: 'cancelled', verified: false, completedAt: null } });
  });

  it('keeps planning metadata separate from actual assignees and execution completion', () => {
    const record = { ...issue(), priority: 'high' as const, manualStatus: 'done' as const, completedAt: now, updatedAt: '2026-09-14T12:00:00.000Z' };
    expect(issueView(record, '/does-not-exist', null)).toMatchObject({ priority: 'high', completedAt: now, execution: { owners: [], startedAt: null, endedAt: null, completedAt: null, checks: null } });
    const queued = request({ departmentId: 'engineering-platform', agentIds: ['atlas', 'nova'], workerIds: ['nova'] });
    expect(issueView(submitted(queued), '/does-not-exist', queued, false, [], sampleWorkspace()).execution).toMatchObject({ department: { id: 'engineering-platform', name: 'Engineering' }, owners: [], startedAt: null, endedAt: null, completedAt: null, checks: null, phase: 'queued' });
  });

  it('enriches owners only from current assignments and recorded head work, with validated check counts', () => {
    const fixture = runFixture();
    fixture.store.db.prepare('UPDATE tasks SET owner_agent_id = ? WHERE id = ?').run('nova', fixture.task.id);
    const replaced = seedTask(fixture.store.db, fixture.run.id);
    fixture.store.db.prepare("UPDATE tasks SET owner_agent_id = 'forge', state = 'superseded' WHERE id = ?").run(replaced.id);
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'head.planning_started', payload: { headAgentId: 'atlas', departmentId: 'engineering-platform', workers: ['nova', 'forge', 'bench'] } });
    fixture.review({ headAgentId: 'atlas' });
    const result = issueView({ ...fixture.record, updatedAt: '2099-01-01T00:00:00.000Z' }, fixture.root, fixture.item, false, [], sampleWorkspace());
    expect(result.execution).toMatchObject({ department: { id: 'engineering-platform', name: 'Engineering' }, checks: { passed: 1, total: 1 }, owners: [{ id: 'atlas', name: 'Atlas', role: 'head', avatarId: null }, { id: 'nova', name: 'Nova', role: 'worker', avatarId: null }], state: 'completed', verified: true });
    expect(result.execution.startedAt).toBeTruthy(); expect(result.execution.endedAt).toBeTruthy(); expect(result.execution.completedAt).toBeTruthy();
    expect(result.execution.completedAt).not.toBe(result.updatedAt);
    const reassigned = sampleWorkspace();
    reassigned.agents.find(agent => agent.id === 'atlas')!.role = 'worker';
    reassigned.agents.find(agent => agent.id === 'nova')!.role = 'head';
    expect(issueView(fixture.record, fixture.root, fixture.item, false, [], reassigned).execution.owners.map(person => [person.id, person.role])).toEqual([['atlas', 'head'], ['nova', 'worker']]);
    unlinkSync(fixture.manifest!.file);
    const unavailable = issueView(fixture.record, fixture.root, fixture.item);
    expect(unavailable.execution).toMatchObject({ state: 'blocked', completedAt: null, checks: { passed: 0, total: 1 } });
  });

  it('does not reuse an old ended timestamp for a live resumed run or infer completion from metadata updates', () => {
    const fixture = runFixture(false);
    fixture.store.db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run('2026-09-13T11:00:00.000Z', fixture.run.id);
    const result = issueView({ ...fixture.record, completedAt: now }, fixture.root, fixture.item);
    expect(result).toMatchObject({ completedAt: null, execution: { state: 'running', endedAt: null, completedAt: null } });
  });

  it('respects every manual draft status without claiming verification or exposing dispatch secrets', () => {
    for (const status of ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const) {
      const record = { ...issue(), manualStatus: status };
      expect(issueView(record, '/does-not-exist', null)).toMatchObject({ status, title: record.title, description: record.description, execution: { state: 'idle', verified: false }, runId: null, requestId: null });
      expect(issueView(record, '/does-not-exist', null)).not.toHaveProperty('dispatch');
    }
  });

  it.each([
    ['queued', 'todo', 'queued'], ['held', 'todo', 'blocked'], ['starting', 'in_progress', 'running'], ['running', 'in_progress', 'running'], ['discarded', 'cancelled', 'cancelled'], ['failed_to_start', 'todo', 'blocked'],
  ] as const)('projects queue state %s before a run exists', (state, status, execution) => {
    const item = request({ state });
    expect(issueView(submitted(item), '/does-not-exist', item)).toMatchObject({ status, execution: { state: execution, verified: false, requestState: state } });
  });

  it('resolves a recorded direct reply as Answered without claiming verified development, including after retention', () => {
    const workspace = sampleWorkspace(); workspace.controlCenter = { runtime: 'codex-local', avatarId: 'portrait-03' };
    const item = answered({ controlCenter: { runtime: 'codex-local', avatarId: 'portrait-02' } });
    for (const live of [item, null]) {
      expect(issueView(submitted(item), '/does-not-exist', live, false, [], workspace)).toMatchObject({
        status: 'done', runId: null, completedAt: null,
        execution: { state: 'answered', phase: 'answered', reason: item.controlReply, verified: false, analysisReviewed: false, workKind: null,
          startedAt: now, endedAt: item.endedAt, completedAt: item.endedAt, department: null, checks: null,
          owners: [{ id: 'control-center', name: 'Control Center', role: 'control', avatarId: 'portrait-02' }] },
      });
    }
  });

  it('requires the complete structured direct-reply disposition and never accepts an ordinary successful exit', () => {
    const base = answered();
    const invalid: Partial<RequestItem>[] = [
      { result: null }, { result: { exitCode: 0, code: 'run_completed', message: 'Done.', details: [] } },
      { result: { ...base.result!, exitCode: 1 } }, { exitCode: 1 }, { endedAt: null },
      { route: { ...base.route!, method: 'classifier' } }, { route: { ...base.route!, state: 'blocked' } },
      { route: { ...base.route!, projectId: 'other' } }, { departmentId: 'engineering' },
      { state: 'queued' }, { stopRequestedAt: now }, { signal: 'SIGINT' },
      { routingSession: { sessionId: 'answer-session', process: null, state: 'unknown' } },
      { controlReply: '', result: { ...base.result!, message: '' } },
    ];
    for (const overrides of invalid) {
      const item = answered(overrides);
      const projected = issueView(submitted(item), '/does-not-exist', item);
      expect(projected.execution.state).not.toBe('answered');
      expect(projected).not.toMatchObject({ status: 'done' });
      expect(projected.execution).toMatchObject({ verified: false, completedAt: null });
    }
  });

  it('does not interpret title or response cancellation keywords as a cancellation action', () => {
    const item = answered({ task: 'Do not run — cancelled UI project-selection test', controlReply: 'Understood. I will not dispatch or execute this cancelled test.' });
    const record = { ...submitted(item), title: item.task! };
    expect(issueView(record, '/does-not-exist', item)).toMatchObject({ status: 'done', execution: { state: 'answered', verified: false } });
    const queued = { ...item, state: 'queued' as const, endedAt: null, exitCode: null, result: null };
    expect(issueView(submitted(queued), '/does-not-exist', queued)).toMatchObject({ status: 'todo', execution: { state: 'queued' } });
  });

  it('retains explicit cancellation after pruning and keeps manual cancellation separate from execution', () => {
    const item = request({ state: 'discarded', endedAt: now });
    expect(issueView(submitted(item), '/does-not-exist', null)).toMatchObject({ status: 'cancelled', execution: { state: 'cancelled', endedAt: now, completedAt: null, verified: false } });
    const manual = { ...issue(), manualStatus: 'cancelled' as const };
    expect(issueView(manual, '/does-not-exist', null)).toMatchObject({ status: 'cancelled', requestId: null, execution: { state: 'cancelled', startedAt: null, endedAt: null, completedAt: null } });
  });

  it('does not let a conversational result bypass the linked run verification gate', () => {
    const fixture = runFixture();
    const item = answered({ runId: fixture.run.id });
    expect(issueView(submitted(item), fixture.root, item)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', verified: false, completedAt: null } });
    fixture.review();
    expect(issueView(submitted(item), fixture.root, item)).toMatchObject({ status: 'done', execution: { state: 'completed', verified: true } });
  });

  it('keeps a pruned request without a recorded run explicitly unknown', () => {
    const item = request({ state: 'running' });
    expect(issueView(submitted(item), '/does-not-exist', null)).toMatchObject({ status: 'todo', execution: { state: 'unknown', verified: false } });
  });

  it('distinguishes durable dispatch intent from a refused submission', () => {
    const record = submitted(null);
    record.dispatch!.state = 'pending';
    expect(issueView(record, '/does-not-exist', null).execution.state).toBe('unknown');
    expect(issueView(record, '/does-not-exist', null, true).execution.state).toBe('dispatching');
    record.dispatch!.state = 'refused';
    record.dispatch!.error = 'No configured department';
    expect(issueView(record, '/does-not-exist', null)).toMatchObject({ status: 'todo', execution: { state: 'blocked', reason: 'No configured department' } });
  });

  it('finds an exact verified run after queue pruning and favors its verdict over a stale running receipt', () => {
    const fixture = runFixture();
    fixture.review();
    const before = readFileSync(fixture.paths.databasePath);
    for (const current of [null, fixture.item]) {
      expect(issueView(fixture.record, fixture.root, current)).toMatchObject({ status: 'done', runId: fixture.run.id, execution: { state: 'completed', runState: 'ready_for_review', verified: true } });
    }
    expect(readFileSync(fixture.paths.databasePath)).toEqual(before);
    // Planned runs have per-attempt manifests, not a top-level result.json.
    expect(fixture.store.db.prepare("SELECT id FROM artifacts WHERE relative_path = 'result.json'").get()).toBeUndefined();
  });

  it('cannot approve another project or another submission through a mismatched request', () => {
    const fixture = runFixture();
    fixture.review();
    expect(issueView(fixture.record, fixture.root, { ...fixture.item, clientRequestId: 'someone-else' }).execution.state).toBe('unknown');
    expect(issueView({ ...fixture.record, projectId: 'other' }, fixture.root, null)).toMatchObject({ status: 'todo', execution: { state: 'unknown', verified: false } });
  });

  it.each(['missing', 'corrupt'] as const)('withdraws Done when task acceptance evidence is %s', mode => {
    const fixture = runFixture();
    fixture.review();
    if (mode === 'missing') unlinkSync(fixture.manifest!.file);
    else writeFileSync(fixture.manifest!.file, '{"acceptance":{"accepted":true}}');
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', verified: false } });
  });

  it.each(['missing', 'corrupt'] as const)('withdraws Done when the registered head review artifact is %s', mode => {
    const fixture = runFixture();
    const head = fixture.review();
    if (mode === 'missing') unlinkSync(head.file);
    else writeFileSync(head.file, '{"verdict":"passed"}');
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'unknown', verified: false } });
  });

  it.each([{ verdict: 'changes_requested' }, { sessionStopped: false }, { interrupted: true }])('requires a clean head approval %j', flags => {
    const fixture = runFixture();
    fixture.review(flags);
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', verified: false } });
  });

  it('requires a review bound to the latest accepted integration, not an earlier candidate', () => {
    const fixture = runFixture();
    fixture.review({}, 'c'.repeat(40));
    expect(issueView(fixture.record, fixture.root, null).execution.verified).toBe(false);
    fixture.review();
    expect(issueView(fixture.record, fixture.root, null).execution.verified).toBe(true);
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'integration.combined', payload: { combinedRevision: fixture.candidateRevision, accepted: true, unverifiedCriteria: [] } });
    expect(issueView(fixture.record, fixture.root, null).execution.verified).toBe(false);
  });

  it('never carries passing evidence into a replacement task generation', () => {
    const fixture = runFixture();
    fixture.review();
    beginNewGeneration(fixture.store.db, fixture.task.id);
    seedAttempt(fixture.store.db, fixture.task.id);
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', verified: false } });
  });

  it('uses current evidence while retaining a compromised historical generation', () => {
    const fixture = runFixture(false);
    fixture.receipt(fixture.attempt.id, 'compromised');
    beginNewGeneration(fixture.store.db, fixture.task.id);
    const fresh = seedAttempt(fixture.store.db, fixture.task.id);
    fixture.receipt(fresh.id);
    transitionTask(fixture.store.db, fixture.task.id, 'validating');
    transitionTask(fixture.store.db, fixture.task.id, 'accepted');
    transitionRun(fixture.store.db, fixture.run.id, 'ready_for_review');
    fixture.review();
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'done', execution: { verified: true } });
  });

  it('requires a coordinator for live worker and head-review phases', () => {
    const fixture = runFixture(false);
    fixture.store.lock!.release();
    expect(issueView(fixture.record, fixture.root, fixture.item)).toMatchObject({ status: 'todo', execution: { state: 'interrupted' } });
    const lock = acquireCoordinatorLock(fixture.paths.lockPath);
    cleanups.push(() => lock.release());
    expect(issueView(fixture.record, fixture.root, fixture.item)).toMatchObject({ status: 'in_progress', execution: { state: 'running' } });
    transitionTask(fixture.store.db, fixture.task.id, 'validating');
    expect(issueView(fixture.record, fixture.root, fixture.item)).toMatchObject({ status: 'in_review', execution: { state: 'review' } });
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'head.review_started', payload: { reviewId: randomUUID(), headAgentId: 'engineering-head' } });
    expect(issueView(fixture.record, fixture.root, fixture.item)).toMatchObject({ status: 'in_review', execution: { state: 'review' } });
    lock.release();
    expect(issueView(fixture.record, fixture.root, fixture.item).execution.state).toBe('interrupted');
  });

  it('does not revive an ended issue when another run holds the same project lock', () => {
    const fixture = runFixture(false);
    const ended = { ...fixture.item, state: 'ended' as const, endedAt: now, exitCode: 0 };
    const otherRun = seedRun(fixture.store.db);
    transitionRun(fixture.store.db, otherRun.id, 'running');
    const otherRequest = request({ clientRequestId: 'unrelated-submission', state: 'running', runId: otherRun.id, pid: fixture.store.lock!.info.pid, pidStartedAtMs: fixture.store.lock!.info.processStartedAtMs });
    expect(issueView(fixture.record, fixture.root, ended, false, [otherRequest])).toMatchObject({ status: 'todo', execution: { state: 'unknown', verified: false, runState: 'running' } });
  });

  it('recognizes a matching resume process without relying on the ended original request', () => {
    const fixture = runFixture(false);
    const ended = { ...fixture.item, state: 'ended' as const, endedAt: now };
    const resume = request({ kind: 'resume', clientRequestId: undefined, state: 'running', runId: null, resumeRunId: fixture.run.id, pid: fixture.store.lock!.info.pid, pidStartedAtMs: fixture.store.lock!.info.processStartedAtMs });
    expect(issueView(fixture.record, fixture.root, ended, false, [resume])).toMatchObject({ status: 'in_progress', execution: { state: 'running' } });
    expect(issueView(fixture.record, fixture.root, ended, false, [{ ...resume, pidStartedAtMs: 1 }])).toMatchObject({ status: 'todo', execution: { state: 'unknown' } });
  });

  it('completes hash-validated reviewed analysis without claiming code acceptance or requiring code checks', () => {
    const fixture = analysisFixture();
    const before = readFileSync(fixture.paths.databasePath);
    for (const current of [fixture.item, null]) {
      expect(issueView(fixture.record, fixture.root, current)).toMatchObject({ status: 'done', execution: { state: 'completed', workKind: 'analysis', analysisReviewed: true, verified: false, reason: 'The department head reviewed the analysis report. The inspected source is unchanged.' } });
    }
    expect(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM checks').get()).toMatchObject({ count: 0 });
    expect(readFileSync(fixture.paths.databasePath)).toEqual(before);
  });

  it.each(['report', 'head', 'manifest'] as const)('withdraws analysis completion if its registered %s evidence is missing or corrupt', part => {
    for (const mode of ['missing', 'corrupt']) {
      const fixture = analysisFixture();
      if (mode === 'missing') unlinkSync(fixture.analysisFiles[part]);
      else writeFileSync(fixture.analysisFiles[part], '{}');
      expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', workKind: 'analysis', analysisReviewed: false, verified: false } });
    }
  });

  it.each([{ sourceUnchanged: false }, { sessionStopped: false }, { toolCallCount: 0 }, { report: '' }, { runId: 'another-run' }, { baseRevision: 'another-revision' }])('does not complete analysis without matching inspection evidence: %j', fields => {
    const fixture = analysisFixture(fields);
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', analysisReviewed: false, verified: false } });
  });

  it('does not complete analysis from reports when the final delivery receipt names other reports', () => {
    const fixture = analysisFixture();
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'control.final_reply', payload: { verificationStatus: 'reviewed_analysis', source: 'department_head_analysis_review', artifactId: fixture.headArtifact.id, reportArtifactIds: [] } });
    expect(issueView(fixture.record, fixture.root, null)).toMatchObject({ status: 'in_review', execution: { state: 'blocked', analysisReviewed: false, verified: false } });
  });

  it('keeps analysis without a saved report in review even when the process claims success', () => {
    const fixture = runFixture(false);
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'run.created', payload: { workKind: 'analysis' } });
    transitionRun(fixture.store.db, fixture.run.id, 'ready_for_review');
    expect(issueView(fixture.record, fixture.root, { ...fixture.item, state: 'ended', exitCode: 0 })).toMatchObject({ status: 'in_review', execution: { state: 'blocked', analysisReviewed: false, verified: false } });
  });

  it('labels live analysis validation and head review as read-only report work', () => {
    const fixture = runFixture(false);
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'run.created', payload: { workKind: 'analysis' } });
    transitionTask(fixture.store.db, fixture.task.id, 'validating');
    expect(issueView(fixture.record, fixture.root, fixture.item)).toMatchObject({ status: 'in_review', execution: { state: 'review', workKind: 'analysis', analysisReviewed: false, verified: false, reason: 'The read-only analysis report is being prepared for department-head review.' } });
    appendEvent(fixture.store.db, { runId: fixture.run.id, type: 'head.review_started', payload: { reviewId: randomUUID(), headAgentId: 'engineering-head' } });
    expect(issueView(fixture.record, fixture.root, fixture.item).execution.reason).toBe('The department head is reviewing the read-only analysis report.');
  });
});
