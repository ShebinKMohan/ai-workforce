import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, FAKE_SCENARIO_ENV, FakeAdapter, type RuntimeEvent, type SessionHandle, type SessionInput, type StopReceipt, type TurnHandle, type TurnInput } from '../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { isProcessAlive, isProcessGroupAlive, observeProcessIdentity } from '../../src/core/process.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { callCoordinator, createCoordinationBridge, type CoordinationBridge, type HeadReviewResult } from '../../src/coordination/index.js';
import { HEAD_REVIEW_TOOL, headReviewResumeBlocker, reviewWithHead, type HeadReviewInput } from '../../src/routing/head-reviewer.js';
import { readArtifact, verifyArtifact } from '../../src/storage/artifacts.js';
import { appendEvent, listEvents } from '../../src/storage/events.js';
import { runChecks, type CheckSpec } from '../../src/verification/checks.js';
import { createCandidateWorkspace, removeCandidateWorkspace, snapshotCandidate } from '../../src/workspaces/candidate.js';
import { git } from '../../src/workspaces/git.js';
import { seedRun } from '../coordination/helpers.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { cleanupAll, fingerprintCheckout, tempDir, useFixture, writeFakeAgentsConfig, writeInto, writeScenario } from '../workspaces/support.js';

const REQUEST = 'Document the pagination helpers and search endpoint for new team members.';
const ALPHA = '# Pagination helpers\n\npageCount counts pages. paginate returns the requested page.\n';
const BETA = '# Search endpoint\n\nGET /search accepts page and pageSize.\n';
type Step = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('department head reviews the checked combined candidate', () => {
  let state: TempState;
  let bridge: CoordinationBridge;
  let input: HeadReviewInput;
  let decision: HeadReviewResult;

  beforeEach(async () => {
    const fixture = await useFixture('ts-bug');
    state = openTempState();
    const runId = seedRun(state.store.db).id;
    // Two independent document changes become separate commits in a real
    // combined candidate. Neither changes the fixture's original checkout.
    const candidate = await createCandidateWorkspace({ projectRoot: fixture.path, baseRevision: fixture.headRevision, runId, taskId: 'combined', attemptId: 'documents', workspaceRoot: state.paths.workspaceRoot });
    writeInto(candidate.path, 'docs/alpha.md', ALPHA);
    await snapshotCandidate(candidate);
    writeInto(candidate.path, 'docs/beta.md', BETA);
    const combined = await snapshotCandidate(candidate);
    await removeCandidateWorkspace(candidate, { disposition: 'integrated' });
    const checks: CheckSpec[] = [
      { criterionId: 'alpha', command: process.execPath, args: ['-e', `require('node:assert/strict').equal(require('node:fs').readFileSync('docs/alpha.md','utf8'),${JSON.stringify(ALPHA)})`], required: true, description: 'Pagination documentation is present.' },
      { criterionId: 'beta', command: process.execPath, args: ['-e', `require('node:assert/strict').equal(require('node:fs').readFileSync('docs/beta.md','utf8'),${JSON.stringify(BETA)})`], required: true, description: 'Search endpoint documentation is present.' },
    ];
    const receipts = await runChecks({ candidate: { repoRoot: fixture.path, revision: combined.candidateRevision }, checks, outputRoot: path.join(state.paths.runArtifactsDir(runId), 'combined-checks'), stateRoot: state.root });
    expect(receipts.map((receipt) => [receipt.criterionId, receipt.outcome, receipt.evidenceProvenance])).toEqual([
      ['alpha', 'passed', 'verifier_executed'], ['beta', 'passed', 'verifier_executed'],
    ]);
    const patch = await git(['diff', '--binary', '--no-ext-diff', `${fixture.headRevision}..${combined.candidateRevision}`], { cwd: fixture.path });
    expect(patch.ok).toBe(true);
    decision = { reviewVersion: 1, candidateRevision: combined.candidateRevision, diffHash: sha256Hex(Buffer.from(patch.stdout, 'utf8')), verdict: 'approve', summary: 'Both documents satisfy the original request. Two independent checks passed on this combined revision.', findings: [] };
    bridge = await createCoordinationBridge({ stateRoot: state.root, runId, db: state.store.db });
    input = {
      policy: { required: true, headAgentId: 'planner', deadlineMs: 20_000 },
      config: loadAgentConfigFile(writeFakeAgentsConfig(tempDir('head-review-config-'), { planner: true })).config,
      runId, repoPath: fixture.path, baseRevision: fixture.headRevision, combinedRevision: combined.candidateRevision,
      requestText: REQUEST,
      tasks: [{ key: 'alpha', objective: 'Document pageCount and paginate.', agentId: 'nova' }, { key: 'beta', objective: 'Document GET /search.', agentId: 'mira' }],
      checks, receipts, paths: state.paths, db: state.store.db, bridge,
      stream: { line: () => undefined, event: () => undefined },
    };
  });

  afterEach(async () => {
    await bridge?.close();
    state?.cleanup();
    cleanupAll();
  });

  function scenario(steps: ReadonlyArray<Step>): Pick<HeadReviewInput, 'sessionEnv'> {
    return { sessionEnv: { [FAKE_SCENARIO_ENV]: writeScenario({ scenarioVersion: 1, steps }) } };
  }

  function submit(result: HeadReviewResult = decision): Step {
    return { action: 'call_tool', tool: HEAD_REVIEW_TOOL, arguments: result };
  }

  function events(type: string) {
    return listEvents(state.store.db, input.runId).filter((event) => event.type === type);
  }

  it('reviews both patches and verifier receipts through a real tool call, stops the session and preserves the checkout', async () => {
    const before = await fingerprintCheckout(input.repoPath);
    let opened: SessionInput | undefined;
    let prompt = '';
    class InspectingHead extends FakeAdapter {
      override async openSession(value: SessionInput): Promise<SessionHandle> {
        opened = value;
        expect(readFileSync(path.join(value.cwd, 'docs/alpha.md'), 'utf8')).toBe(ALPHA);
        expect(readFileSync(path.join(value.cwd, 'docs/beta.md'), 'utf8')).toBe(BETA);
        return super.openSession(value);
      }
      override async startTurn(session: SessionHandle, turn: TurnInput): Promise<TurnHandle> {
        prompt = turn.prompt;
        return super.startTurn(session, turn);
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done', message: 'Review submitted.' }]), adapterFactory: () => new InspectingHead() });
    expect(outcome).toMatchObject({ verdict: 'passed', candidateRevision: decision.candidateRevision, diffHash: decision.diffHash, summary: decision.summary, findings: [], sessionStopped: true, interrupted: false });
    expect(opened).toMatchObject({ policy: 'analysis', allowedWritePaths: [] });
    for (const content of [REQUEST, 'docs/alpha.md', 'docs/beta.md', 'pageCount', 'GET /search', 'nova', 'mira', decision.candidateRevision, decision.diffHash, ...input.receipts.map((receipt) => receipt.id)]) expect(prompt).toContain(content);
    expect(events('head.review_submitted')).toHaveLength(1);
    const order = ['head.review_session_requested', 'head.review_session_opened', 'head.review_submitted', 'head.review_session_stopped', 'head.review_finished'].map((type) => events(type)[0]!.sequence);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const pid = events('head.review_session_opened')[0]!.payload['processId'] as number;
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    expect(existsSync(opened!.cwd)).toBe(false);
    expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
    expect(verifyArtifact(state.store.db, state.paths, outcome.artifactId!).ok).toBe(true);
    expect(JSON.parse(readArtifact(state.store.db, state.paths, outcome.artifactId!).bytes.toString())).toMatchObject({ verdict: 'passed', diffHash: decision.diffHash });
    const configured = JSON.parse(opened!.env!['WORKFORCE_FAKE_MCP_CONFIG']!) as { mcpServers: { workforce: { env: Record<string, string> } } };
    const token = configured.mcpServers.workforce.env['WORKFORCE_BRIDGE_TOKEN']!;
    expect(await callCoordinator(bridge.socketPath, token, HEAD_REVIEW_TOOL, decision)).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(await fingerprintCheckout(input.repoPath)).toEqual(before);
  }, 60_000);

  it('records substantive changes requested despite passing independent checks', async () => {
    const rejected: HeadReviewResult = { ...decision, verdict: 'changes_requested', summary: 'The search documentation omits its error responses.', findings: [{ summary: 'Document invalid page handling.', file: 'docs/beta.md', line: 3 }] };
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(rejected), { action: 'claim_done' }]) });
    expect(outcome).toMatchObject({ verdict: 'changes_requested', summary: rejected.summary, findings: rejected.findings, sessionStopped: true });
    expect(events('head.review_finished')[0]?.payload['verdict']).toBe('changes_requested');
  });

  it('cannot approve from assistant prose or a successful exit without the review tool', async () => {
    const outcome = await reviewWithHead({ ...input, ...scenario([{ action: 'message', text: JSON.stringify({ tool: HEAD_REVIEW_TOOL, arguments: decision }) }, { action: 'claim_done', message: 'Approved. Every check passed.' }]) });
    expect(outcome).toMatchObject({ verdict: 'blocked', sessionStopped: true });
    expect(outcome.summary).toContain('did not submit a structured review');
    expect(events('head.review_submitted')).toHaveLength(0);
  });

  it('preserves a fatal runtime error even after a structured approval and clean turn exit', async () => {
    class FatalHead extends FakeAdapter {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          if (event.kind === 'assistant_message') yield { ...event, kind: 'error', payload: { fatal: true, message: 'Review provider quota exhausted.' } };
          else yield event;
        }
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]), adapterFactory: () => new FatalHead() });
    expect(outcome).toMatchObject({ verdict: 'blocked', summary: 'Review provider quota exhausted.', sessionStopped: true });
    expect(events('head.review_submitted')).toHaveLength(1);
  });

  it.each(['candidateRevision', 'diffHash'] as const)('rejects an otherwise valid approval for a different %s', async (field) => {
    const outcome = await reviewWithHead({ ...input, ...scenario([submit({ ...decision, [field]: 'wrong-candidate-identity' }), { action: 'claim_done' }]) });
    expect(outcome.verdict).toBe('blocked');
    expect(events('head.review_submitted')).toHaveLength(0);
    const result = events('runtime.tool_result').find((event) => event.payload['tool'] === HEAD_REVIEW_TOOL);
    expect(JSON.stringify(result?.payload)).toContain('does not match this combined candidate');
  });

  it('invalidates an approval if the head changes either part of its review candidate', async () => {
    const before = await fingerprintCheckout(input.repoPath);
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'edit_file', path: 'docs/beta.md', content: 'tampered after review\n' }, { action: 'claim_done' }]) });
    expect(outcome).toMatchObject({ verdict: 'blocked', sessionStopped: true });
    expect(outcome.summary).toContain('changed its candidate');
    expect(events('head.review_submitted')).toHaveLength(1);
    const reviewCopy = events('head.review_workspace_created')[0]!.payload['path'] as string;
    expect(readFileSync(path.join(reviewCopy, 'docs/beta.md'), 'utf8')).toBe('tampered after review\n');
    expect(await fingerprintCheckout(input.repoPath)).toEqual(before);
    expect((await git(['show', `${input.combinedRevision}:docs/beta.md`], { cwd: input.repoPath })).stdout).toBe(BETA);
  });

  it('stops a live head, records interruption and allows a later bounded replacement', async () => {
    const controller = new AbortController();
    const outcome = await reviewWithHead({ ...input, ...scenario([{ action: 'message', text: 'REVIEW-WAITING' }, { action: 'sleep', ms: 60_000 }]), signal: controller.signal, stream: { event: () => undefined, line: (line) => { if (line.includes('REVIEW-WAITING')) controller.abort(); } } });
    expect(outcome).toMatchObject({ verdict: 'blocked', interrupted: true, sessionStopped: true });
    expect(outcome.summary).toContain('was stopped');
    const pid = events('head.review_session_opened')[0]!.payload['processId'] as number;
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
    expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
    const resumed = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]) });
    expect(resumed.verdict).toBe('passed');
    expect(resumed.reviewId).not.toBe(outcome.reviewId);
    expect(events('head.review_session_stopped')[0]!.sequence).toBeLessThan(events('head.review_session_requested')[1]!.sequence);
  }, 60_000);

  it('does not deliver approval without observed process-tree termination', async () => {
    class UncertainStopHead extends FakeAdapter {
      override async stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt> {
        const stopped = await super.stopOwnedProcesses(session);
        return { ...stopped, state: 'unknown', detail: 'Injected missing stop acknowledgement.' };
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]), adapterFactory: () => new UncertainStopHead() });
    expect(outcome).toMatchObject({ verdict: 'blocked', sessionStopped: false });
    expect(outcome.summary).toContain('no confirmed stopped process tree');
    expect(events('head.review_submitted')).toHaveLength(1);
  });

  it.each(['missing', 'stale', 'failed'] as const)('starts no head when independent verifier evidence is %s', async (mode) => {
    const receipts = mode === 'missing' ? input.receipts.slice(0, 1) : input.receipts.map((receipt) => mode === 'stale' ? { ...receipt, candidate: { ...receipt.candidate, revision: input.baseRevision } } : { ...receipt, outcome: 'failed' as const });
    const outcome = await reviewWithHead({ ...input, receipts, ...scenario([submit(), { action: 'claim_done' }]) });
    expect(outcome.verdict).toBe('blocked');
    expect(outcome.summary).toContain('verifier evidence');
    expect(events('head.review_session_requested')).toHaveLength(0);
  });

  it.each(['missing_process_receipt', 'live_process', 'unknown_process'] as const)('blocks resume beside %s and starts no replacement', async (mode) => {
    const reviewId = 'uncertain-review';
    appendEvent(state.store.db, { runId: input.runId, type: 'head.review_session_requested', payload: { reviewId } });
    if (mode !== 'missing_process_receipt') {
      appendEvent(state.store.db, { runId: input.runId, type: 'head.review_session_opened', payload: { reviewId, sessionId: 'uncertain-session', process: mode === 'live_process' ? observeProcessIdentity(process.pid) : null } });
    }
    expect(headReviewResumeBlocker(state.store.db, input.runId)).not.toBeNull();
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]) });
    expect(outcome.verdict).toBe('blocked');
    expect(events('head.review_session_requested')).toHaveLength(1);
    expect(events('head.review_submitted')).toHaveLength(0);
    if (mode !== 'missing_process_receipt') {
      appendEvent(state.store.db, { runId: input.runId, type: 'head.review_session_stopped', payload: { reviewId, state: 'process_tree_terminated' } });
      expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
    }
  });

  it('keeps a late-opening session blocked until its owned process stop is durably recorded', async () => {
    const opened = deferred<SessionHandle>();
    const release = deferred<void>();
    const stopped = deferred<StopReceipt>();
    const controller = new AbortController();
    class LateHead extends FakeAdapter {
      override async openSession(value: SessionInput): Promise<SessionHandle> {
        const session = await super.openSession(value);
        opened.resolve(session);
        await release.promise;
        return session;
      }
      override async stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt> {
        const receipt = await super.stopOwnedProcesses(session);
        stopped.resolve(receipt);
        return receipt;
      }
    }
    const review = reviewWithHead({ ...input, ...scenario([{ action: 'claim_done' }]), signal: controller.signal, adapterFactory: () => new LateHead() });
    const session = await opened.promise;
    try {
      controller.abort();
      const outcome = await review;
      expect(outcome).toMatchObject({ verdict: 'blocked', interrupted: true, sessionStopped: false });
      expect(headReviewResumeBlocker(state.store.db, input.runId)).not.toBeNull();
      expect(events('head.review_session_opened')).toHaveLength(0);
    } finally {
      release.resolve(undefined);
      expect((await stopped.promise).state).toBe('process_tree_terminated');
      // stopOwnedProcesses returns before its owner appends the final receipt.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(events('head.review_session_opened')).toHaveLength(1);
    expect(events('head.review_session_stopped')).toHaveLength(1);
    expect(events('head.review_session_stopped')[0]?.payload['state']).toBe('process_tree_terminated');
    expect(isProcessAlive(session.processId!)).toBe(false);
    expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
  }, 60_000);

  it('records a known pre-start rejection without an owned session and permits a later retry', async () => {
    class RejectedStartupHead extends FakeAdapter {
      override async openSession(_value: SessionInput): Promise<SessionHandle> {
        throw new AdapterError('fake', 'unsupported_setting', 'Runtime rejected startup before creating a session.');
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]), adapterFactory: () => new RejectedStartupHead() });
    expect(outcome.verdict).toBe('blocked');
    expect(outcome.summary).toContain('Runtime rejected startup');
    expect(events('head.review_session_opened')).toHaveLength(0);
    expect(events('head.review_session_start_failed')).toHaveLength(1);
    expect(events('head.review_session_start_failed')[0]?.payload).toMatchObject({ state: 'no_session_started' });
    expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
    const retried = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]) });
    expect(retried.verdict).toBe('passed');
  });

  it('keeps a generic startup failure blocked when no process cleanup evidence exists', async () => {
    class UnknownStartupHead extends FakeAdapter {
      override async openSession(_value: SessionInput): Promise<SessionHandle> {
        throw new Error('Startup failed with unknown process ownership.');
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]), adapterFactory: () => new UnknownStartupHead() });
    expect(outcome).toMatchObject({ verdict: 'blocked', sessionStopped: false });
    expect(events('head.review_session_start_failed').filter((event) => event.payload['state'] === 'no_session_started')).toHaveLength(0);
    expect(headReviewResumeBlocker(state.store.db, input.runId)).not.toBeNull();
  });

  it.each(['process_tree_terminated', 'requested', 'unknown'] as const)('uses a post-start failure’s %s receipt to decide whether a replacement may start', async (reportedState) => {
    let startupReceipt: StopReceipt | undefined;
    class FailedStartedHead extends FakeAdapter {
      override async openSession(value: SessionInput): Promise<SessionHandle> {
        const started = await super.openSession(value);
        const observed = await super.stopOwnedProcesses(started);
        expect(observed.state).toBe('process_tree_terminated');
        // The process really ran and stopped. The two weaker variants model
        // an adapter that cannot attest to that stop; no process is leaked.
        startupReceipt = { ...observed, state: reportedState };
        throw new AdapterError('fake', 'startup_failed', 'Started runtime failed before returning its session handle.', startupReceipt);
      }
    }
    const outcome = await reviewWithHead({ ...input, ...scenario([{ action: 'claim_done' }]), adapterFactory: () => new FailedStartedHead() });
    const safelyStopped = reportedState === 'process_tree_terminated';
    expect(outcome).toMatchObject({ verdict: 'blocked', sessionStopped: safelyStopped });
    expect(outcome.summary).toContain('Started runtime failed');
    expect(startupReceipt).toBeDefined();
    expect(isProcessAlive(startupReceipt!.processId!)).toBe(false);
    expect(isProcessGroupAlive(startupReceipt!.processId!)).toBe(false);
    expect(events('head.review_session_opened')).toHaveLength(0);
    expect(events('head.review_session_start_failed')).toHaveLength(1);
    expect(events('head.review_session_start_failed')[0]?.payload).toMatchObject({ state: reportedState, processId: startupReceipt!.processId, stopReceipt: startupReceipt });
    if (safelyStopped) expect(headReviewResumeBlocker(state.store.db, input.runId)).toBeNull();
    else expect(headReviewResumeBlocker(state.store.db, input.runId)).not.toBeNull();

    const retried = await reviewWithHead({ ...input, ...scenario([submit(), { action: 'claim_done' }]) });
    expect(retried.verdict).toBe(safelyStopped ? 'passed' : 'blocked');
    expect(events('head.review_session_requested')).toHaveLength(safelyStopped ? 2 : 1);
    expect(events('head.review_submitted')).toHaveLength(safelyStopped ? 1 : 0);
  });
});
