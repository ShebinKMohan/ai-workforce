import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterError, FAKE_SCENARIO_ENV, FakeAdapter, type RuntimeEvent, type SessionHandle, type SessionInput, type StopReceipt, type TurnHandle, type TurnInput } from '../../src/adapters/index.js';
import { AnalysisReportRecordSchema, MAX_ANALYSIS_REPORT_BYTES, analysisSessionResumeBlocker, runAnalysisSession, type AnalysisSessionInput } from '../../src/core/analysis-session.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { isProcessAlive, isProcessGroupAlive } from '../../src/core/process.js';
import { computeAgentSnapshot, sha256Hex, verifySnapshot } from '../../src/core/snapshot.js';
import { readArtifact } from '../../src/storage/artifacts.js';
import { appendEvent, listEvents } from '../../src/storage/events.js';
import { getAttempt, getTask, insertRun, insertTask } from '../../src/storage/records.js';
import { openTempState, sampleContract, sampleRequest, TEST_LIMITS, type TempState } from '../helpers/state.js';
import { cleanupAll, fingerprintCheckout, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

const REPORT = 'src/pagination.js exports pageCount and paginate. The endpoint in src/search.js uses the pagination helpers. This was source inspection only; no tests were run.';
type Step = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real fake-runtime process lifecycle, with deterministic simulated inspection events. */
class InspectingFake extends FakeAdapter {
  opened: SessionInput | null = null;
  prompt = '';
  attachments: TurnInput['attachments'];
  override async openSession(input: SessionInput): Promise<SessionHandle> {
    this.opened = input;
    return super.openSession(input);
  }
  override async startTurn(session: SessionHandle, input: TurnInput): Promise<TurnHandle> {
    this.prompt = input.prompt;
    this.attachments = input.attachments;
    return super.startTurn(session, input);
  }
  override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
    let offset = 0;
    for await (const original of super.events(turn)) {
      const event = { ...original, sequence: original.sequence + offset };
      yield event;
      if (event.kind === 'turn_started') {
        const content = readFileSync(path.join(this.opened!.cwd, 'src/pagination.js'), 'utf8');
        offset += 1;
        yield { ...event, sequence: event.sequence + 1, kind: 'command_exec', payload: { itemId: 'read-source', command: 'cat src/pagination.js', phase: 'completed', status: 'completed', exitCode: 0, output: content } };
      }
    }
  }
}

describe('bounded repository analysis session', () => {
  let state: TempState;
  let input: AnalysisSessionInput;

  beforeEach(async () => {
    const fixture = await useFixture('ts-bug');
    state = openTempState();
    const request = { ...sampleRequest(), repoPath: fixture.path, text: 'Explain the features in this codebase.' };
    const run = insertRun(state.store.db, { request, policy: 'analysis', limits: TEST_LIMITS, baseRevision: fixture.headRevision });
    const task = insertTask(state.store.db, { runId: run.id, contract: sampleContract({ objective: 'Inspect the pagination implementation and explain its features.', acceptanceCriteria: [] }), ownerAgentId: 'engineer' });
    input = {
      db: state.store.db, paths: state.paths, runId: run.id, taskId: task.id, agentId: 'engineer', repoPath: fixture.path, baseRevision: fixture.headRevision,
      config: loadAgentConfigFile(writeFakeAgentsConfig(tempDir('analysis-config-'), { model: 'fake-fast', effort: 'low' })).config,
      objective: task.objective, requestText: request.text, deadlineMs: 10_000, allowUnconfinedWrites: true,
      adapterFactory: () => new InspectingFake(), ...scenario([{ action: 'message', text: REPORT }]),
    };
  });
  afterEach(() => { state?.cleanup(); cleanupAll(); });

  function scenario(steps: ReadonlyArray<Step>): Pick<AnalysisSessionInput, 'sessionEnv'> {
    return { sessionEnv: { [FAKE_SCENARIO_ENV]: writeScenario({ scenarioVersion: 1, steps }) } };
  }
  function events(type: string) { return listEvents(state.store.db, input.runId).filter(event => event.type === type); }
  function reports() { return state.store.db.prepare("SELECT id FROM artifacts WHERE type='analysis_report'").all(); }

  it('inspects under a frozen analysis binding, records process and source evidence, and executes no checks', async () => {
    const before = await fingerprintCheckout(input.repoPath);
    const original = computeAgentSnapshot(input.config, input.agentId);
    const adapter = new InspectingFake();
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => adapter });
    expect(outcome).toMatchObject({ ok: true, report: REPORT, reason: null, interrupted: false, sessionStopped: true, sourceUnchanged: true });
    expect(adapter.opened).toMatchObject({ policy: 'analysis', allowedWritePaths: [], model: 'fake-fast', effort: 'low' });
    expect(adapter.opened!.cwd).not.toBe(input.repoPath);
    expect(adapter.prompt).toContain(input.objective);
    expect(adapter.prompt).toContain(input.requestText);
    expect(adapter.prompt).toContain('run no repository tests');
    const attempt = getAttempt(state.store.db, outcome.attemptId);
    expect(attempt).toMatchObject({ state: 'completed', runtime_id: 'fake-local', task_id: input.taskId, uncertain_outcome: 0 });
    expect(attempt.agent_snapshot_hash).not.toBe(original.hash);
    const saved = state.store.db.prepare('SELECT canonical_json FROM agent_snapshots WHERE hash=?').get(attempt.agent_snapshot_hash) as { canonical_json: string };
    expect(verifySnapshot(saved.canonical_json, attempt.agent_snapshot_hash)).toBe(true);
    expect(JSON.parse(saved.canonical_json)).toMatchObject({ policy: 'analysis', runtime: { model: 'fake-fast', effort: 'low' } });
    expect(input.config.agents[0]!.policy).toBe('local-development');
    const artifact = readArtifact(state.store.db, state.paths, outcome.reportArtifactId!);
    expect(artifact.record.type).toBe('analysis_report');
    const report = AnalysisReportRecordSchema.parse(JSON.parse(artifact.bytes.toString('utf8')));
    expect(report).toMatchObject({ analysisVersion: 1, report: REPORT, toolCallCount: 1, sourceUnchanged: true, sessionStopped: true, baseRevision: input.baseRevision, attemptId: outcome.attemptId });
    expect(events('analysis.session_requested')[0]!.sequence).toBeLessThan(events('analysis.session_opened')[0]!.sequence);
    expect(events('analysis.session_stopped')[0]!.sequence).toBeLessThan(events('analysis.integrity_checked')[0]!.sequence);
    expect(isProcessAlive(attempt.process_id!)).toBe(false);
    expect(isProcessGroupAlive(attempt.process_id!)).toBe(false);
    expect(await fingerprintCheckout(input.repoPath)).toEqual(before);
    expect(state.store.db.prepare('SELECT count(*) AS count FROM checks').get()).toEqual({ count: 0 });
    expect(getTask(state.store.db, input.taskId).state).toBe('pending');
  });

  it('does not publish a prose-only answer without observed inspection', async () => {
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new FakeAdapter() });
    expect(outcome).toMatchObject({ ok: false, reportArtifactId: null, report: '', sessionStopped: true, sourceUnchanged: true });
    expect(outcome.reason).toContain('no observed repository inspection');
    expect(reports()).toHaveLength(0);
  });

  it.each(['started', 'denied', 'failed_command', 'failed_tool'] as const)('does not treat a %s action as successful inspection evidence', async status => {
    class FailedInspection extends InspectingFake {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        let offset = 0;
        for await (const original of super.events(turn)) {
          const event = { ...original, sequence: original.sequence + offset };
          if (event.kind !== 'command_exec') { yield event; continue; }
          if (status === 'started') yield { ...event, payload: { itemId: 'read', phase: 'started', status: 'running' } };
          else if (status === 'denied') yield { ...event, payload: { itemId: 'read', phase: 'completed', status: 'declined', denied: true, exitCode: 0 } };
          else if (status === 'failed_command') yield { ...event, payload: { itemId: 'read', phase: 'completed', status: 'completed', exitCode: 1 } };
          else {
            yield { ...event, kind: 'tool_call', payload: { tool: 'Read', toolUseId: 'read', status: 'started' } };
            yield { ...event, sequence: event.sequence + 1, kind: 'tool_result', payload: { tool: 'Read', toolUseId: 'read', status: 'failed', ok: false, isError: true } };
            offset += 1;
          }
        }
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new FailedInspection() });
    expect(outcome).toMatchObject({ ok: false, reportArtifactId: null, sessionStopped: true });
    expect(outcome.reason).toContain('completed successfully');
    expect(reports()).toHaveLength(0);
  });

  it('accepts a successful correlated Read tool result with the same inspection requirement', async () => {
    class ReadTool extends InspectingFake {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        let offset = 0;
        for await (const original of super.events(turn)) {
          const event = { ...original, sequence: original.sequence + offset };
          if (event.kind !== 'command_exec') { yield event; continue; }
          yield { ...event, kind: 'tool_call', payload: { tool: 'Read', toolUseId: 'read', status: 'started' } };
          yield { ...event, sequence: event.sequence + 1, kind: 'tool_result', payload: { tool: 'Read', toolUseId: 'read', status: 'ok', ok: true, isError: false, content: event.payload['output'] } };
          offset += 1;
        }
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new ReadTool() });
    expect(outcome.ok).toBe(true);
    expect(AnalysisReportRecordSchema.parse(JSON.parse(readArtifact(state.store.db, state.paths, outcome.reportArtifactId!).bytes.toString('utf8'))).toolCallCount).toBe(1);
  });

  it('preserves validated uploaded context in the worker turn and frozen input record', async () => {
    const file = path.join(tempDir('analysis-attachment-'), 'requirements.txt');
    writeFileSync(file, 'Explain pagination and cite its source.');
    const attachment = { path: file, name: 'requirements.txt', mimeType: 'text/plain', sha256: sha256Hex(readFileSync(file)), mode: 'reference' as const };
    const adapter = new InspectingFake();
    const outcome = await runAnalysisSession({ ...input, attachments: [attachment], adapterFactory: () => adapter });
    expect(outcome.ok).toBe(true);
    expect(adapter.attachments).toEqual([{ ...attachment, sizeBytes: readFileSync(file).length }]);
    expect(adapter.prompt).toContain(file);
    expect(adapter.prompt).toContain('document content');
    const artifact = state.store.db.prepare("SELECT id FROM artifacts WHERE type='analysis_input'").get() as { id: string };
    expect(JSON.parse(readArtifact(state.store.db, state.paths, artifact.id).bytes.toString('utf8')).attachments).toEqual([{ ...attachment, sizeBytes: readFileSync(file).length }]);
  });

  it('rejects changed attachment content before opening a session', async () => {
    const file = path.join(tempDir('analysis-attachment-'), 'requirements.txt');
    writeFileSync(file, 'Original requirement');
    const attachment = { path: file, name: 'requirements.txt', mimeType: 'text/plain', sha256: sha256Hex(readFileSync(file)) };
    writeFileSync(file, 'Changed requirement');
    const outcome = await runAnalysisSession({ ...input, attachments: [attachment] });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('SHA-256');
    expect(events('analysis.session_requested')).toHaveLength(0);
  });

  it('does not reuse a progress announcement made before the last tool action as a report', async () => {
    class ProgressOnly extends InspectingFake {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          if (event.kind === 'assistant_message') continue;
          yield event;
        }
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new ProgressOnly() });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('no final inspection report');
    expect(reports()).toHaveLength(0);
  });

  it.each(['tracked', 'untracked', 'ignored'] as const)('rejects %s candidate mutations and preserves the original checkout', async kind => {
    const before = await fingerprintCheckout(input.repoPath);
    class MutatingFake extends InspectingFake {
      override async stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt> {
        const result = await super.stopOwnedProcesses(session);
        const cwd = this.opened!.cwd;
        if (kind === 'tracked') writeFileSync(path.join(cwd, 'src/pagination.js'), 'changed source');
        else if (kind === 'untracked') writeFileSync(path.join(cwd, 'generated-report.md'), REPORT);
        else { writeFileSync(path.join(cwd, '.git', '..', 'ignored-output'), 'unexpected output'); writeFileSync(path.join(cwd, '.gitignore'), 'ignored-output\n'); }
        return result;
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new MutatingFake() });
    expect(outcome).toMatchObject({ ok: false, sourceUnchanged: false, reportArtifactId: null });
    expect(outcome.reason).toContain('changed its candidate');
    expect(reports()).toHaveLength(0);
    expect(await fingerprintCheckout(input.repoPath)).toEqual(before);
  });

  it('rejects a reported file change even when final Git status is clean', async () => {
    class WriteReported extends InspectingFake {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          yield event;
          if (event.kind === 'turn_completed') yield { ...event, sequence: event.sequence + 1, kind: 'file_change', payload: { path: 'src/pagination.js', applied: true, withinAllowedPaths: false } };
        }
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new WriteReported() });
    expect(outcome).toMatchObject({ ok: false, sourceUnchanged: true, reportArtifactId: null });
    expect(outcome.reason).toContain('reported a file change');
  });

  it.each(['failed', 'fatal', 'foreign_session'] as const)('rejects a %s result despite a report and a terminal message', async kind => {
    class BrokenResult extends InspectingFake {
      override async *events(turn: TurnHandle): AsyncIterable<RuntimeEvent> {
        for await (const event of super.events(turn)) {
          if (event.kind === 'turn_completed') {
            if (kind === 'failed') yield { ...event, payload: { ...event.payload, status: 'errored', error: 'Quota unavailable.' } };
            else if (kind === 'fatal') yield { ...event, kind: 'error', payload: { fatal: true, message: 'Provider failed.' } };
            else yield { ...event, payload: { ...event.payload, reportedSessionId: 'foreign-session' } };
          } else yield event;
        }
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new BrokenResult() });
    expect(outcome).toMatchObject({ ok: false, reportArtifactId: null, sessionStopped: true });
    expect(reports()).toHaveLength(0);
  });

  it('fails an oversized multibyte report without silently truncating it', async () => {
    const oversized = '界'.repeat(Math.ceil(MAX_ANALYSIS_REPORT_BYTES / 3));
    const outcome = await runAnalysisSession({ ...input, ...scenario([{ action: 'message', text: oversized }]) });
    expect(outcome).toMatchObject({ ok: false, reportArtifactId: null, report: '' });
    expect(outcome.reason).toContain('128 KiB');
    expect(reports()).toHaveLength(0);
  });

  it('stops a running inspection on user cancellation and never publishes its partial report', async () => {
    const controller = new AbortController();
    const outcome = await runAnalysisSession({ ...input, ...scenario([{ action: 'message', text: 'INSPECTION-WAITING' }, { action: 'sleep', ms: 60_000 }]), signal: controller.signal, stream: { event: () => undefined, line: line => { if (line.includes('INSPECTION-WAITING')) controller.abort(); } } });
    expect(outcome).toMatchObject({ ok: false, interrupted: true, sessionStopped: true, reportArtifactId: null });
    expect(getAttempt(state.store.db, outcome.attemptId).state).toBe('interrupted');
    expect(analysisSessionResumeBlocker(state.store.db, input.runId, input.taskId)).toBeNull();
    expect(reports()).toHaveLength(0);
  });

  it('bounds an otherwise hanging turn by its deadline and confirms the process stopped', async () => {
    const deadlineMs = 43_210;
    const realSetTimeout = globalThis.setTimeout;
    let expireDeadline: (() => void) | undefined;
    let turnStarted = false;
    // Drive only the analysis deadline after startup. Process and stop timers
    // stay real, so a slow CI host cannot turn this into a pre-spawn timeout.
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === deadlineMs && !expireDeadline) expireDeadline = () => callback(...args);
      return realSetTimeout(callback, delay, ...args);
    });
    try {
      const outcome = await runAnalysisSession({ ...input, deadlineMs, ...scenario([{ action: 'sleep', ms: 60_000 }]), stream: {
        line: () => undefined,
        event: event => {
          if (event['type'] !== 'analysis.turn_started') return;
          turnStarted = true;
          expect(expireDeadline).toBeTypeOf('function');
          expireDeadline!();
        },
      } });
      expect(turnStarted).toBe(true);
      expect(outcome).toMatchObject({ ok: false, interrupted: false, sessionStopped: true, reportArtifactId: null });
      expect(outcome.reason).toContain('deadline');
      const processId = getAttempt(state.store.db, outcome.attemptId).process_id!;
      expect(processId).toBeTypeOf('number');
      expect(isProcessAlive(processId)).toBe(false);
      expect(isProcessGroupAlive(processId)).toBe(false);
      expect(reports()).toHaveLength(0);
    } finally { timer.mockRestore(); }
  });

  it('fails closed when the adapter cannot confirm its process tree stopped', async () => {
    class UnknownStop extends InspectingFake {
      override async stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt> { return { ...await super.stopOwnedProcesses(session), state: 'unknown' }; }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new UnknownStop() });
    expect(outcome).toMatchObject({ ok: false, sessionStopped: false, sourceUnchanged: false, reportArtifactId: null });
    expect(getAttempt(state.store.db, outcome.attemptId).uncertain_outcome).toBe(1);
    expect(reports()).toHaveLength(0);
  });

  it('cleans up its owned session when a presentation callback throws as startup is recorded', async () => {
    const outcome = await runAnalysisSession({ ...input, stream: { line: () => undefined, event: event => { if (event['type'] === 'analysis.session_opened') throw new Error('Injected presentation failure.'); } } });
    expect(outcome).toMatchObject({ ok: false, sessionStopped: true, reportArtifactId: null });
    expect(outcome.reason).toContain('Injected presentation failure');
    const opened = events('analysis.session_opened')[0]!;
    expect(isProcessAlive(opened.payload['processId'] as number)).toBe(false);
    expect(events('analysis.session_stopped')).toHaveLength(1);
    expect(analysisSessionResumeBlocker(state.store.db, input.runId, input.taskId)).toBeNull();
  });

  it('does not start an unverified runtime without the existing run consent', async () => {
    const outcome = await runAnalysisSession({ ...input, allowUnconfinedWrites: false });
    expect(outcome).toMatchObject({ ok: false, sessionStopped: true, reportArtifactId: null });
    expect(outcome.reason).toContain('no verified file boundary');
    expect(events('analysis.session_requested')).toHaveLength(0);
    expect(events('analysis.workspace_created')).toHaveLength(0);
  });

  it('keeps late startup blocked until its own process stop receipt is recorded', async () => {
    const opened = deferred<SessionHandle>();
    const release = deferred<void>();
    const stopped = deferred<StopReceipt>();
    const controller = new AbortController();
    class LateOpen extends InspectingFake {
      override async openSession(value: SessionInput): Promise<SessionHandle> {
        const session = await super.openSession(value); opened.resolve(session); await release.promise; return session;
      }
      override async stopOwnedProcesses(session: SessionHandle): Promise<StopReceipt> { const result = await super.stopOwnedProcesses(session); stopped.resolve(result); return result; }
    }
    const running = runAnalysisSession({ ...input, signal: controller.signal, adapterFactory: () => new LateOpen() });
    const session = await opened.promise;
    try {
      controller.abort();
      const outcome = await running;
      expect(outcome).toMatchObject({ ok: false, interrupted: true, sessionStopped: false });
      expect(analysisSessionResumeBlocker(state.store.db, input.runId, input.taskId)).not.toBeNull();
    } finally {
      release.resolve(undefined);
      expect((await stopped.promise).state).toBe('process_tree_terminated');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(isProcessAlive(session.processId!)).toBe(false);
    expect(analysisSessionResumeBlocker(state.store.db, input.runId, input.taskId)).toBeNull();
    expect(events('analysis.session_stopped')).toHaveLength(1);
  });

  it.each([true, false])('distinguishes proven pre-spawn rejection (%s) from unknown startup ownership', async preSpawn => {
    class RejectedStart extends FakeAdapter {
      override async openSession(_value: SessionInput): Promise<SessionHandle> {
        if (preSpawn) throw new AdapterError('fake', 'unsupported_setting', 'Unsupported startup setting.');
        throw new Error('Unknown startup failure.');
      }
    }
    const outcome = await runAnalysisSession({ ...input, adapterFactory: () => new RejectedStart() });
    expect(outcome).toMatchObject({ ok: false, sessionStopped: preSpawn, reportArtifactId: null });
    expect(analysisSessionResumeBlocker(state.store.db, input.runId, input.taskId) === null).toBe(preSpawn);
    expect(reports()).toHaveLength(0);
  });

  it('starts nothing for the wrong frozen base or a prior startup without a process receipt', async () => {
    const wrong = await runAnalysisSession({ ...input, baseRevision: 'f'.repeat(40) });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain('frozen run');
    appendEvent(state.store.db, { runId: input.runId, taskId: input.taskId, type: 'analysis.session_requested', payload: {} });
    const blocked = await runAnalysisSession(input);
    expect(blocked.reason).toContain('no process receipt');
    expect(events('analysis.session_requested')).toHaveLength(1);
    expect(state.store.db.prepare('SELECT count(*) AS count FROM attempts').get()).toEqual({ count: 0 });
  });
});
