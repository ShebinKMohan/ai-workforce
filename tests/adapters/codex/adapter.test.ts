import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, configOverrideArgs, CODEX_CAPABILITIES, UNDISCOVERED_CODEX_SETTINGS } from '../../../src/adapters/codex/adapter.js';
import { classifyCodexError, sandboxModeForPolicy, sandboxPolicyForTurn } from '../../../src/adapters/codex/protocol.js';
import { AdapterError, RuntimeEventSchema, isTurnTerminalEvent, type RuntimeEvent, type SessionHandle } from '../../../src/adapters/types.js';
import { isProcessAlive, isProcessGroupAlive } from '../../../src/core/process.js';
import { summarizeTurnEvidence } from '../../../src/telemetry/events.js';
import { BRIDGE_SERVER_NAME, bridgeEntryPath } from '../../../src/coordination/bridge.js';
import { collect, fixturePath, openReplaySession, replayAdapter, tempWorkspace, writeTranscript } from './helpers.js';

const roots: string[] = [];
const open: Array<{ adapter: CodexAdapter; handle: SessionHandle }> = [];

afterEach(async () => {
  for (const session of open.splice(0)) await session.adapter.stopOwnedProcesses(session.handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const dir = tempWorkspace();
  roots.push(path.dirname(dir));
  return dir;
}

function track(adapter: CodexAdapter, handle: SessionHandle): SessionHandle {
  open.push({ adapter, handle });
  return handle;
}

function kinds(events: ReadonlyArray<RuntimeEvent>): string[] {
  return events.filter((event) => event.kind !== 'raw').map((event) => event.kind);
}

describe('codex adapter: session and turn lifecycle', () => {
  it('opens a thread, streams normalized events and reports what the server actually said', async () => {
    const cwd = workspace();
    const logsDir = path.join(path.dirname(cwd), 'logs');
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'), { logsDir });
    const handle = track(adapter, await openReplaySession(adapter, cwd));

    expect(handle.adapter).toBe('codex');
    expect(handle.sessionId).toBe('01a07b00-0000-7000-8000-000000000001');
    expect(handle.process?.spawnToken).toMatch(/^[0-9a-f]{16}$/);
    // FR006: the effective binding is what the server reports, not what we asked for.
    expect(adapter.effectiveSettings(handle)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'low', modelProvider: 'openai' });

    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);
    for (const event of events) expect(() => RuntimeEventSchema.parse(event)).not.toThrow();

    expect(kinds(events)).toEqual(['turn_started', 'command_exec', 'command_exec', 'file_change', 'file_change', 'assistant_message', 'turn_completed']);

    const assistant = events.find((event) => event.kind === 'assistant_message')!;
    expect(assistant.payload['text']).toBe('Created hello.txt containing exactly: hello');
    expect(assistant.payload['claimsDone']).toBe(true);
    expect(assistant.payload['phaseKnown']).toBe(true);

    const applied = events.filter((event) => event.kind === 'file_change' && event.payload['phase'] === 'completed');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.payload['path']).toBe('hello.txt');
    expect(applied[0]!.payload['withinAllowedPaths']).toBe(true);
    expect(applied[0]!.payload['applied']).toBe(true);

    const command = events.filter((event) => event.kind === 'command_exec' && event.payload['phase'] === 'completed')[0]!;
    expect(command.payload['exitCode']).toBe(0);
    expect(command.payload['output']).toContain('README.md');

    // Sequences are monotonic per process instance and every event names the raw frame it came from.
    const sequences = events.map((event) => event.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(events.every((event) => event.rawRef.startsWith(`codex:${handle.sessionId}:${handle.process!.spawnToken}:`))).toBe(true);
    expect(isTurnTerminalEvent(events.at(-1)!)).toBe(true);

    // The raw JSONL capture holds both directions of the wire, including the frames the normalizer dropped.
    const rawPath = adapter.rawLogPath(handle)!;
    expect(existsSync(rawPath)).toBe(true);
    const raw = readFileSync(rawPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; line: string });
    expect(raw.some((record) => record.dir === 'out' && record.line.includes('"turn/start"'))).toBe(true);
    expect(raw.some((record) => record.dir === 'in' && record.line.includes('item/agentMessage/delta'))).toBe(true);
    expect(events.some((event) => event.payload['method'] === 'item/agentMessage/delta')).toBe(false);
  });

  it('counts one action per item even though the runtime reports it started and completed', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);

    // The stream really does carry the same command and the same file twice.
    expect(events.filter((event) => event.kind === 'command_exec')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'file_change')).toHaveLength(2);

    // The evidence summary counts what the worker did, not how often it was announced.
    const evidence = summarizeTurnEvidence(events);
    expect(evidence.commandsExecuted).toBe(1);
    expect(evidence.fileChanges).toEqual(['hello.txt']);
    // Well-formed output the adapter chose not to normalize is counted, never called malformed.
    expect(evidence.rawEvents).toBeGreaterThan(0);
    expect(evidence.errors).toEqual([]);
  });

  it('keeps unknown notifications and unknown fields instead of failing the stream', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'hello' });
    const events = await collect(adapter, turn);

    const unknown = events.find((event) => event.payload['method'] === 'some/futureMethod/weHaveNeverSeen');
    expect(unknown).toBeDefined();
    expect(unknown!.kind).toBe('raw');
    const assistant = events.find((event) => event.kind === 'assistant_message')!;
    expect(assistant.payload['text']).toContain('hello.txt');
  });

  it('refuses a second concurrent turn in one session', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-interrupt.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'slow work' });
    await expect(adapter.startTurn(handle, { prompt: 'more work' })).rejects.toThrow(/only one turn may be active/);
    await adapter.interrupt(turn);
  });

  it('interrupts an active turn and reports observed only after the server confirms', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-interrupt.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'run a slow loop' });

    const collected = collect(adapter, turn);
    const receipt = await adapter.interrupt(turn);
    expect(receipt.state).toBe('observed');
    expect(receipt.turnId).toBe(turn.turnId);

    const events = await collected;
    expect(kinds(events)).toEqual(['turn_started', 'command_exec', 'command_exec', 'turn_interrupted']);
    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('turn_interrupted');
    expect(terminal.payload['status']).toBe('interrupted');

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.interrupted).toBe(true);
    expect(evidence.completed).toBe(false);

    // Interrupting a turn that already ended is idempotent and still reports observed.
    await expect(adapter.interrupt(turn)).resolves.toMatchObject({ state: 'observed' });
  });

  it('makes a denied escalation and an out-of-workspace write visible in the events', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-denied.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'write outside the workspace' });
    const events = await collect(adapter, turn);

    const denials = adapter.deniedServerRequests(handle);
    expect(denials).toHaveLength(1);
    expect(denials[0]!.method).toBe('item/fileChange/requestApproval');
    expect(denials[0]!.decision.result).toEqual({ decision: 'decline' });

    const outside = events.filter((event) => event.kind === 'file_change' && event.payload['withinAllowedPaths'] === false);
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((event) => event.payload['applied'] !== true)).toBe(true);
    expect(outside.some((event) => event.payload['denied'] === true)).toBe(true);

    const failedCommand = events.find((event) => event.kind === 'command_exec' && event.payload['status'] === 'failed')!;
    expect(String(failedCommand.payload['output'])).toContain('Operation not permitted');

    const evidence = summarizeTurnEvidence(events);
    // The sandbox refused the write, and that is the difference the evidence
    // has to carry: a refused write outside the grant is the boundary working,
    // not an escape. Reporting it as one would make a contained runtime
    // indistinguishable from an uncontained one.
    expect(evidence.deniedFileChangesOutsideAllowedPaths).toContain('/tmp/outside-the-workspace/escape.txt');
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([]);
    expect(evidence.unconfirmedFileChangesOutsideAllowedPaths).toEqual([]);
  });

  it('reports a "done" claim with no file change as an assistant message, never as an accepted result', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-claims-done.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'make sure hello.txt says hello' });
    const events = await collect(adapter, turn);

    expect(kinds(events)).toEqual(['turn_started', 'assistant_message', 'turn_completed']);
    const evidence = summarizeTurnEvidence(events);
    expect(evidence.claimedDone).toBe(true);
    expect(evidence.completed).toBe(true);
    // A completed turn is a runtime claim; no file changed and nothing here says accepted (FR050).
    expect(evidence.fileChanges).toEqual([]);
    const completed = events.at(-1)!;
    expect(completed.payload['evidence']).toBe('runtime_reported');
    expect(Object.keys(completed.payload)).not.toContain('accepted');
    expect(existsSync(path.join(cwd, 'hello.txt'))).toBe(false);
  });

  it('classifies a real recorded provider failure and never reports it as a completed task', async () => {
    const cwd = workspace();
    // The one transcript in this suite recorded from the installed runtime.
    const adapter = replayAdapter(fixturePath('session-usage-limit.real.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);

    const error = events.find((event) => event.kind === 'error')!;
    expect(error.payload['errorClass']).toBe('usage_limit');
    expect(error.payload['fatal']).toBe(false);
    expect(error.payload['willRetry']).toBe(false);

    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('turn_completed');
    expect(terminal.payload['status']).toBe('failed');
    expect(terminal.payload['errorClass']).toBe('usage_limit');
    expect(summarizeTurnEvidence(events).fileChanges).toEqual([]);
  });
});

describe('codex adapter: delivery, stopping and reconciliation', () => {
  it('queues a delivery with no active turn and flushes it into the next turn', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'), { logsDir: path.join(path.dirname(cwd), 'logs') });
    const handle = track(adapter, await openReplaySession(adapter, cwd));

    const receipt = await adapter.deliver(handle, { messageId: 'msg-1', body: 'the reviewer asks for a test', correlationId: 'corr-1' });
    expect(receipt.state).toBe('queued');
    expect(receipt.turnId).toBeNull();
    expect(adapter.pendingDeliveries(handle)).toHaveLength(1);

    const turn = await adapter.startTurn(handle, { prompt: 'do the work' });
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);

    await collect(adapter, turn);
    const raw = readFileSync(adapter.rawLogPath(handle)!, 'utf8');
    const turnStart = raw.split('\n').map((line) => (line.trim() ? (JSON.parse(line) as { dir: string; line: string }) : null)).find((record) => record?.dir === 'out' && record.line.includes('"turn/start"'))!;
    expect(turnStart.line).toContain('msg-1');
    expect(turnStart.line).toContain('the reviewer asks for a test');
    expect(turnStart.line).toContain('do the work');
  });

  it('reads the containment the server says it applied, and reports it when it is not the one that was asked for', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    // The server answers thread/start with a read-only sandbox and an approval
    // policy that prompts, for a session opened under local-development. Both
    // fields used to be typed `unknown`, copied into the session and never
    // looked at, so the only machine-readable statement the server makes about
    // the containment it applied was discarded.
    //
    // thread/started is placed after turn/start so the session_started event it
    // produces lands inside the turn's own event window whatever order the
    // pump and the caller happen to run in.
    const transcript = writeTranscript(root, 'sandbox-echo.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      {
        dir: 'in',
        line: JSON.stringify({
          id: 2,
          result: { thread: { id: 'thread-echo' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request' },
        }),
      },
      { dir: 'out', line: JSON.stringify({ id: 3, method: 'turn/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 3, result: { turn: { id: 'turn-echo', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-echo', cwd: '/workspace', cliVersion: '0.147.0' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-echo', turn: { id: 'turn-echo', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-echo', turn: { id: 'turn-echo', items: [], status: 'completed' } } }) },
    ]);
    const adapter = replayAdapter(transcript);
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const events = await collect(adapter, await adapter.startTurn(handle, { prompt: 'work' }));

    const started = events.find((event) => event.kind === 'session_started')!;
    const mismatches = started.payload['profileMismatch'] as Array<{ aspect: string; requested: string; reported: string; detail: string }>;
    expect(mismatches.map((entry) => entry.aspect).sort()).toEqual(['approvalPolicy', 'sandbox']);
    expect(mismatches.find((entry) => entry.aspect === 'sandbox')).toMatchObject({ requested: 'workspaceWrite', reported: 'readOnly' });
    expect(mismatches.find((entry) => entry.aspect === 'approvalPolicy')).toMatchObject({ requested: 'never', reported: 'on-request' });
    expect(adapter.sessionDiagnostics(handle).join(' ')).toContain('an approval prompt is an escalation');

    // And the part no server statement covers is stated rather than assumed:
    // the writable roots and the /tmp exclusions go out per turn and nothing
    // comes back.
    const unenforceable = started.payload['unenforceable'] as Array<{ aspect: string; reason: string }>;
    expect(unenforceable.map((entry) => entry.aspect)).toContain('sandboxPolicy.writableRoots');
    expect(unenforceable.find((entry) => entry.aspect === 'sandboxPolicy.writableRoots')?.reason).toContain('echoes nothing back');
  });

  it('raises nothing when the server reports the containment that was asked for', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    // The answer codex-cli 0.147.0 actually gives for a local-development
    // thread, including the thread-level exclusions it reports as off.
    const transcript = writeTranscript(root, 'sandbox-echo-ok.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      {
        dir: 'in',
        line: JSON.stringify({
          id: 2,
          result: {
            thread: { id: 'thread-ok' },
            sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            approvalPolicy: 'never',
          },
        }),
      },
      { dir: 'out', line: JSON.stringify({ id: 3, method: 'turn/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 3, result: { turn: { id: 'turn-ok', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-ok', cwd: '/workspace', cliVersion: '0.147.0' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-ok', turn: { id: 'turn-ok', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-ok', turn: { id: 'turn-ok', items: [], status: 'completed' } } }) },
    ]);
    const adapter = replayAdapter(transcript);
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const events = await collect(adapter, await adapter.startTurn(handle, { prompt: 'work' }));

    const started = events.find((event) => event.kind === 'session_started')!;
    expect(started.payload['profileMismatch']).toEqual([]);
    expect(started.payload['reportedApprovalPolicy']).toBe('never');
    expect(adapter.sessionDiagnostics(handle).join(' ')).not.toContain('sandbox');
  });

  it('steers an active turn when the runtime accepts it and says so in the receipt', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const transcript = writeTranscript(root, 'steer.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 2, result: { thread: { id: 'thread-steer' }, model: 'gpt-5.6-sol', reasoningEffort: 'low' } }) },
      { dir: 'out', line: JSON.stringify({ id: 3, method: 'turn/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 3, result: { turn: { id: 'turn-steer', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-steer', turn: { id: 'turn-steer', items: [], status: 'inProgress' } } }) },
      { dir: 'out', line: JSON.stringify({ id: 4, method: 'turn/steer' }) },
      { dir: 'in', line: JSON.stringify({ id: 4, result: { turnId: 'turn-steer' } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-steer', turn: { id: 'turn-steer', items: [], status: 'completed' } } }) },
    ]);
    const adapter = replayAdapter(transcript);
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'work' });

    const receipt = await adapter.deliver(handle, { messageId: 'msg-2', body: 'stop after the first failure' });
    expect(receipt).toMatchObject({ messageId: 'msg-2', state: 'submitted_to_active_turn', turnId: 'turn-steer' });
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
    await collect(adapter, turn);
  });

  it('queues rather than loses a delivery the runtime refuses to steer, and leaves the refusal in the events', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const transcript = writeTranscript(root, 'steer-refused.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 2, result: { thread: { id: 'thread-refuse' } } }) },
      { dir: 'out', line: JSON.stringify({ id: 3, method: 'turn/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 3, result: { turn: { id: 'turn-refuse', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-refuse', turn: { id: 'turn-refuse', items: [], status: 'inProgress' } } }) },
      { dir: 'out', line: JSON.stringify({ id: 4, method: 'turn/steer' }) },
      { dir: 'in', line: JSON.stringify({ id: 4, error: { code: -32600, message: 'expectedTurnId does not match the active turn' } }) },
      { dir: 'out', line: JSON.stringify({ id: 5, method: 'turn/interrupt' }) },
      { dir: 'in', line: JSON.stringify({ id: 5, result: {} }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-refuse', turn: { id: 'turn-refuse', items: [], status: 'interrupted' } } }) },
    ]);
    const adapter = replayAdapter(transcript);
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'work' });

    const receipt = await adapter.deliver(handle, { messageId: 'msg-3', body: 'a message that must not vanish' });
    expect(receipt.state).toBe('queued');
    expect(adapter.pendingDeliveries(handle).map((message) => message.messageId)).toEqual(['msg-3']);

    // A refused steer is evidence, not something to swallow.
    await adapter.interrupt(turn);
    const events = await collect(adapter, turn);
    const refusal = events.find((event) => event.payload['reason'] === 'steer_refused')!;
    expect(refusal.payload['messageId']).toBe('msg-3');
    expect(String(refusal.payload['message'])).toContain('expectedTurnId');
  });

  it('stops the owned process group and reconciles honestly afterwards', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'));
    const handle = await openReplaySession(adapter, cwd);
    const pid = handle.process!.pid;

    const before = await adapter.reconcile(handle);
    expect(before.processAlive).toBe(true);
    expect(before.activeTurnId).toBeNull();
    expect(before.lastEventSequence).toBeGreaterThan(0);

    const receipt = await adapter.stopOwnedProcesses(handle);
    expect(receipt.state).toBe('process_tree_terminated');
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);

    const after = await adapter.reconcile(handle);
    expect(after.processAlive).toBe(false);
    expect(after.processIdentityStatus).toBe('dead');
    expect(after.activeTurnId).toBeNull();
  });

  it('will not signal a process it cannot identify, and says so', async () => {
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'));
    const receipt = await adapter.stopOwnedProcesses({ adapter: 'codex', sessionId: 'thread-from-a-previous-coordinator', processId: 424242, raw: null });
    expect(receipt.state).toBe('unknown');
    expect(receipt.signal).toBeNull();
    expect(receipt.detail).toContain('refusing to signal a process by pid alone');

    const state = await adapter.reconcile({ adapter: 'codex', sessionId: 'thread-from-a-previous-coordinator', processId: 424242, raw: null });
    expect(state.processAlive).toBe('unknown');
    expect(state.lastEventSequence).toBe(0);
  });

  it('refuses to resume a thread whose previous process is still alive', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd));

    await expect(
      adapter.resumeSession({
        cwd,
        allowedWritePaths: [cwd],
        policy: 'local-development',
        systemInstructions: 'test worker',
        sessionId: handle.sessionId,
        previousProcess: handle.process!,
      }),
    ).rejects.toThrow(/still has a live app server|still driven by process/);
  });

  it('resumes a thread through thread/resume once the previous process is gone', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const transcript = writeTranscript(root, 'resume.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/resume' }) },
      { dir: 'in', line: JSON.stringify({ id: 2, result: { thread: { id: 'thread-resumed' }, model: 'gpt-5.6-sol', reasoningEffort: 'medium' } }) },
    ]);
    const adapter = replayAdapter(transcript);
    const handle = track(
      adapter,
      await adapter.resumeSession({
        cwd,
        allowedWritePaths: [cwd],
        policy: 'analysis',
        systemInstructions: 'test worker',
        sessionId: 'thread-resumed',
        previousProcess: null,
      }),
    );
    expect(handle.sessionId).toBe('thread-resumed');
    expect(adapter.effectiveSettings(handle)?.effort).toBe('medium');
  });

  it('reports a rejected thread/start as an adapter error rather than a broken session', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const transcript = writeTranscript(root, 'rejected.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 2, error: { code: -32600, message: 'cwd must be inside a trusted workspace' } }) },
    ]);
    const adapter = replayAdapter(transcript);
    await expect(openReplaySession(adapter, cwd)).rejects.toMatchObject({ name: 'AdapterError', code: 'thread_start_rejected' });
  });

  it('reports the app server exiting mid-turn as a fatal stream error, not as a completed turn', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-interrupt.synthetic.jsonl'), {}, ['--exit-after', '4']);
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'slow work' });
    const events = await collect(adapter, turn);

    const last = events.at(-1)!;
    expect(last.kind).toBe('error');
    expect(last.payload['fatal']).toBe(true);
    expect(last.payload['reason']).toBe('process_exited');
    expect(last.payload['expected']).toBe(false);
    expect(summarizeTurnEvidence(events).completed).toBe(false);
  });
});

describe('codex adapter: policy, settings and capability reporting', () => {
  it('maps execution profiles onto sandbox policies that exclude /tmp and $TMPDIR', () => {
    expect(sandboxModeForPolicy('analysis')).toBe('read-only');
    expect(sandboxModeForPolicy('verification')).toBe('read-only');
    expect(sandboxModeForPolicy('local-development')).toBe('workspace-write');

    expect(sandboxPolicyForTurn('analysis', ['/w'])).toEqual({ type: 'readOnly', networkAccess: false });
    // Codex's workspace-write default leaves /tmp and $TMPDIR writable; both are excluded so the granted roots are the whole writable set.
    expect(sandboxPolicyForTurn('local-development', ['/w'])).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/w'],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    });
  });

  it('sends the granted roots and a never-approve policy on every turn', async () => {
    const cwd = workspace();
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'), { logsDir: path.join(path.dirname(cwd), 'logs') });
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'work' });
    await collect(adapter, turn);

    const raw = readFileSync(adapter.rawLogPath(handle)!, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as { dir: string; line: string });
    const threadStart = JSON.parse(raw.find((record) => record.dir === 'out' && record.line.includes('"thread/start"'))!.line) as { params: Record<string, unknown> };
    expect(threadStart.params['sandbox']).toBe('workspace-write');
    expect(threadStart.params['approvalPolicy']).toBe('never');
    expect(threadStart.params['developerInstructions']).toBe('test worker');

    const turnStart = JSON.parse(raw.find((record) => record.dir === 'out' && record.line.includes('"turn/start"'))!.line) as { params: { sandboxPolicy: Record<string, unknown>; approvalPolicy: string } };
    expect(turnStart.params.approvalPolicy).toBe('never');
    expect(turnStart.params.sandboxPolicy['writableRoots']).toEqual([cwd]);
    expect(turnStart.params.sandboxPolicy['excludeSlashTmp']).toBe(true);
    expect(turnStart.params.sandboxPolicy['excludeTmpdirEnvVar']).toBe(true);
    expect(turnStart.params.sandboxPolicy['networkAccess']).toBe(false);
  });

  it('passes an undiscovered model or effort through unchanged instead of mapping or rejecting it', () => {
    const adapter = new CodexAdapter();
    expect(adapter.capabilities().settings).toEqual(UNDISCOVERED_CODEX_SETTINGS);
    const validation = adapter.validateSettings({ model: 'gpt-5.6-sol', effort: 'ultra' });
    expect(validation.ok).toBe(true);
    expect(validation.model.status).toBe('supported_unverified');
    expect(validation.effort.status).toBe('supported_unverified');
    expect(validation.model.message).toContain('recorded from what the runtime reports');
  });

  it('rejects a model the discovered table does not offer, before anything is spawned', async () => {
    const settings = {
      model: { offered: [{ value: 'gpt-5.6-sol', provenance: 'reported' as const, note: 'runtime default' }], exhaustive: true },
      effort: { offered: [{ value: 'low', provenance: 'reported' as const }], exhaustive: true },
    };
    const adapter = replayAdapter(fixturePath('session-hello.synthetic.jsonl'), { settings });
    expect(adapter.validateSettings({ model: 'gpt-9-imaginary' }).ok).toBe(false);
    await expect(
      adapter.openSession({ cwd: os.tmpdir(), allowedWritePaths: [os.tmpdir()], policy: 'analysis', systemInstructions: 'x', model: 'gpt-9-imaginary' }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'unsupported_setting' });
  });

  it('builds config overrides only from values that cannot reshape the TOML expression', () => {
    expect(configOverrideArgs({ model: 'gpt-5.6-sol', model_reasoning_effort: 'low' })).toEqual(['-c', 'model="gpt-5.6-sol"', '-c', 'model_reasoning_effort="low"']);
    expect(() => configOverrideArgs({ model: 'x", sandbox_mode="danger-full-access' })).toThrow(AdapterError);
  });

  it('classifies the provider error codes the app server reports', () => {
    expect(classifyCodexError('usageLimitExceeded')).toBe('usage_limit');
    expect(classifyCodexError('unauthorized')).toBe('authentication');
    expect(classifyCodexError('serverOverloaded')).toBe('provider_transient');
    expect(classifyCodexError({ httpConnectionFailed: { httpStatusCode: 503 } })).toBe('provider_transient');
    expect(classifyCodexError('sandboxError')).toBe('sandbox');
    // An unrecognised code stays unknown rather than being guessed into a retryable class.
    expect(classifyCodexError('somethingAddedNextYear')).toBe('unknown');
    expect(classifyCodexError(undefined)).toBe('unknown');
  });

  it('records a tested version and platform for every declared capability', () => {
    for (const [name, report] of Object.entries(CODEX_CAPABILITIES)) {
      expect(report.testedVersion, name).toBe('0.147.0');
      expect(report.os, name).toBe('darwin');
      expect(report.note, name).toBeTruthy();
    }
    // Every capability is now claimed as verified, so every one of them has to
    // have a real-runtime check behind it; coordination_bridge is the newest.
    expect(Object.entries(CODEX_CAPABILITIES).filter(([, capability]) => capability.status !== 'verified').map(([name]) => name)).toEqual([]);
    expect(CODEX_CAPABILITIES.coordination_bridge.note).toContain('mcpServer/elicitation/request');
    // Token counts are reported, currency cost is not; the note must not let a caller read cost as zero.
    expect(CODEX_CAPABILITIES.usage_reporting.note).toContain('Currency cost is not reported');
  });
});

describe('codex adapter: temp fixtures', () => {
  it('creates and removes its own temp roots', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-check-'));
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

/**
 * AT05: a planned multi-worker run has to be able to exchange messages. Codex
 * 0.147.0 asks permission before every MCP tool call, so a session that
 * refuses all of them cannot use the coordination bridge the coordinator
 * spawned for it — the frames below are what the real app server sent when a
 * worker called `send_message`, and declining failed the call outright.
 */
describe('codex adapter: the coordination bridge it was configured with', () => {
  const THREAD = 'thread-bridge';

  /** The argv `coordinationArgsFor('codex', config)` splices into the session. */
  function coordinationArgs(): string[] {
    const prefix = `mcp_servers.${BRIDGE_SERVER_NAME}`;
    return [
      '-c',
      `${prefix}.command="${process.execPath}"`,
      '-c',
      `${prefix}.args=["${bridgeEntryPath()}"]`,
      '-c',
      `${prefix}.env={ WORKFORCE_BRIDGE_SOCKET = "/tmp/wf-at05.sock", WORKFORCE_BRIDGE_TOKEN = "session-token" }`,
    ];
  }

  function bridgeTurnTranscript(root: string, name: string): string {
    return writeTranscript(root, name, [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize' }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 2, result: { thread: { id: THREAD } } }) },
      { dir: 'out', line: JSON.stringify({ id: 3, method: 'turn/start' }) },
      { dir: 'in', line: JSON.stringify({ id: 3, result: { turn: { id: 'turn-bridge', items: [], status: 'inProgress' } } }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'turn-bridge', items: [], status: 'inProgress' } } }) },
      {
        dir: 'in',
        line: JSON.stringify({
          method: 'item/started',
          params: { threadId: THREAD, turnId: 'turn-bridge', item: { id: 'exec-1', type: 'mcpToolCall', server: BRIDGE_SERVER_NAME, tool: 'send_message', status: 'inProgress', arguments: { to: 'task-2', body: 'schema is ready' } } },
        }),
      },
      {
        dir: 'in',
        line: JSON.stringify({
          id: 'elicit-1',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: THREAD,
            turnId: 'turn-bridge',
            serverName: BRIDGE_SERVER_NAME,
            mode: 'form',
            message: `Allow the ${BRIDGE_SERVER_NAME} MCP server to run tool "send_message"?`,
            requestedSchema: { type: 'object', properties: {} },
            _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
          },
        }),
      },
      { dir: 'out', line: JSON.stringify({ id: 'elicit-1', result: {} }) },
      {
        dir: 'in',
        line: JSON.stringify({
          method: 'item/completed',
          params: { threadId: THREAD, turnId: 'turn-bridge', item: { id: 'exec-1', type: 'mcpToolCall', server: BRIDGE_SERVER_NAME, tool: 'send_message', status: 'completed', result: { structuredContent: { messageId: 'msg-1', recorded: true } } } },
        }),
      },
      // The very next thing the worker asks for IS an escalation.
      { dir: 'in', line: JSON.stringify({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { command: 'sudo rm -rf /' } }) },
      { dir: 'out', line: JSON.stringify({ id: 'approve-1', result: {} }) },
      { dir: 'in', line: JSON.stringify({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 'turn-bridge', items: [], status: 'completed' } } }) },
    ]);
  }

  it('authorizes a bridge tool call, refuses the escalation beside it, and records both with reasons', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const adapter = replayAdapter(bridgeTurnTranscript(root, 'bridge-attached.jsonl'));
    const handle = track(adapter, await openReplaySession(adapter, cwd, { extraArgs: coordinationArgs() }));
    const turn = await adapter.startTurn(handle, { prompt: 'tell task-2 the schema is ready' });
    await collect(adapter, turn);

    const decisions = adapter.serverRequestDecisions(handle);
    expect(decisions.map((record) => record.method)).toEqual(['mcpServer/elicitation/request', 'item/commandExecution/requestApproval']);

    const authorized = decisions[0]!;
    expect(authorized.decision.denied).toBe(false);
    expect(authorized.decision.result).toEqual({ action: 'accept', content: {} });
    expect(authorized.decision.reason).toContain('send_message');

    const refused = decisions[1]!;
    expect(refused.decision.denied).toBe(true);
    expect(refused.decision.result).toEqual({ decision: 'decline' });

    // The refusals view stays a refusals view: the authorization is not in it.
    expect(adapter.deniedServerRequests(handle).map((record) => record.method)).toEqual(['item/commandExecution/requestApproval']);
  });

  it('refuses the identical tool call when the session was given no bridge', async () => {
    const cwd = workspace();
    const root = path.dirname(cwd);
    const adapter = replayAdapter(bridgeTurnTranscript(root, 'bridge-absent.jsonl'));
    // Same transcript, no coordination arguments: there is nothing this
    // coordinator provisioned, so there is nothing it may authorize.
    const handle = track(adapter, await openReplaySession(adapter, cwd));
    const turn = await adapter.startTurn(handle, { prompt: 'tell task-2 the schema is ready' });
    await collect(adapter, turn);

    const decisions = adapter.serverRequestDecisions(handle);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((record) => record.decision.denied)).toBe(true);
    expect(decisions[0]!.decision.result).toEqual({ action: 'decline' });
    expect(decisions[0]!.decision.reason).toMatch(/not a coordination-bridge tool authorization|never approves an escalation/);
  });
});
