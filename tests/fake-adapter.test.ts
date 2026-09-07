import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_RUNTIME_VERSION, FakeAdapter, defaultFakeRuntimeScript, type FakeAdapterOptions } from '../src/adapters/fake/adapter.js';
import { AdapterError, RuntimeEventSchema, type RuntimeEvent, type SessionHandle, type TurnHandle } from '../src/adapters/types.js';
import { listEvents } from '../src/storage/events.js';
import { recordRuntimeEvent, summarizeTurnEvidence } from '../src/telemetry/events.js';
import { openTempState, seedRunAndTask, tempDir } from './helpers/state.js';

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly adapter: FakeAdapter;
}

const fixtures: Fixture[] = [];
const sessions: Array<{ adapter: FakeAdapter; handle: SessionHandle }> = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.adapter.stopOwnedProcesses(session.handle);
  for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true });
});

function fixture(scenario: unknown, options: Omit<FakeAdapterOptions, 'scenarioPath'> = {}): Fixture {
  // realpath: the runtime reports canonical paths (macOS /var -> /private/var), and the tests compare exact paths.
  const root = realpathSync(tempDir('workforce-fake-'));
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd);
  const scenarioPath = path.join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const created = { root, cwd, adapter: new FakeAdapter({ scenarioPath, ...options }) };
  fixtures.push(created);
  return created;
}

async function open(f: Fixture): Promise<SessionHandle> {
  const handle = await f.adapter.openSession({ cwd: f.cwd, allowedWritePaths: [f.cwd], policy: 'local-development', systemInstructions: 'test worker' });
  sessions.push({ adapter: f.adapter, handle });
  return handle;
}

async function collect(adapter: FakeAdapter, turn: TurnHandle): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const event of adapter.events(turn)) out.push(event);
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('fake adapter: passive probe', () => {
  it('reports the script version without starting a turn and marks a missing script not ready', async () => {
    const adapter = new FakeAdapter();
    const readiness = await adapter.probe(defaultFakeRuntimeScript());
    expect(readiness).toMatchObject({ installed: true, version: FAKE_RUNTIME_VERSION, controllable: true, ready: 'verified_ready', probeKind: 'passive', diagnostics: [] });

    const missing = await adapter.probe(path.join(tempDir(), 'nope.mjs'));
    expect(missing).toMatchObject({ installed: false, version: null, controllable: false, ready: 'not_ready', probeKind: 'passive' });
    expect(missing.diagnostics[0]).toMatch(/not found/);

    expect(adapter.capabilities().capabilities.process_tree_stop).toMatchObject({ status: 'verified', testedVersion: FAKE_RUNTIME_VERSION });
    expect(adapter.capabilities().capabilities.usage_reporting.status).toBe('unsupported');
  });

  it('fails session startup honestly when the runtime cannot start', async () => {
    const adapter = new FakeAdapter({ scriptPath: path.join(tempDir(), 'missing-runtime.mjs'), startupTimeoutMs: 3_000 });
    const cwd = tempDir();
    await expect(adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'analysis', systemInstructions: 'x' })).rejects.toMatchObject({ name: 'AdapterError', code: 'startup_failed' });
  });
});

describe('fake adapter: session and turn lifecycle', () => {
  it('streams normalized events for a file edit and makes a bare "done" claim observable as no file change', async () => {
    const f = fixture({
      scenarioVersion: 1,
      turns: [
        [{ action: 'edit_file', path: 'src/fixed.txt', content: 'fixed\n' }, { action: 'claim_done', message: 'All done.' }],
        [{ action: 'claim_done', message: 'Also done (nothing changed).' }],
      ],
    });
    const handle = await open(f);
    expect(handle.sessionId).toMatch(/^fake-/);
    expect(handle.processId).toBeGreaterThan(0);

    const turn1 = await f.adapter.startTurn(handle, { prompt: 'fix it' });
    const events1 = await collect(f.adapter, turn1);
    for (const event of events1) expect(() => RuntimeEventSchema.parse(event)).not.toThrow();
    for (let i = 1; i < events1.length; i += 1) expect(events1[i]!.sequence).toBeGreaterThan(events1[i - 1]!.sequence);
    expect(events1.map((e) => e.kind)).toEqual(['session_started', 'turn_started', 'tool_call', 'file_change', 'tool_result', 'assistant_message', 'turn_completed']);
    expect(events1.every((e) => e.rawRef.startsWith(`fake:${handle.sessionId}:`))).toBe(true);
    // unknown raw fields are preserved in the payload, not dropped and not fatal
    expect(events1[1]!.payload['fakeExtra']).toMatchObject({ ignored: true });

    const changed = path.join(f.cwd, 'src', 'fixed.txt');
    expect(readFileSync(changed, 'utf8')).toBe('fixed\n');
    const evidence1 = summarizeTurnEvidence(events1);
    expect(evidence1).toMatchObject({ claimedDone: true, completed: true, interrupted: false, fileChanges: [changed], fileChangesOutsideAllowedPaths: [], toolCalls: 1 });

    const turn2 = await f.adapter.startTurn(handle, { prompt: 'and again' });
    const evidence2 = summarizeTurnEvidence(await collect(f.adapter, turn2));
    expect(evidence2).toMatchObject({ claimedDone: true, completed: true, fileChanges: [], toolCalls: 0 });

    // Persisting the stream is idempotent per (adapter, session, sequence).
    const state = openTempState();
    try {
      const { run, task } = seedRunAndTask(state);
      for (const event of events1) recordRuntimeEvent(state.store.db, event, { runId: run.id, taskId: task.id });
      for (const event of events1) recordRuntimeEvent(state.store.db, event, { runId: run.id, taskId: task.id });
      const stored = listEvents(state.store.db, run.id);
      expect(stored).toHaveLength(events1.length);
      expect(stored.map((e) => e.type)).toEqual(events1.map((e) => `runtime.${e.kind}`));
      expect(stored[3]!.payloadRef).toBe(events1[3]!.rawRef);
    } finally {
      state.cleanup();
    }
  });

  it('never crashes the stream on unknown event kinds, unknown fields or malformed lines', async () => {
    const f = fixture({ scenarioVersion: 1, steps: [{ action: 'unknown_event' }, { action: 'malformed_output' }, { action: 'message', text: 'still alive' }] });
    const handle = await open(f);
    const events = await collect(f.adapter, await f.adapter.startTurn(handle, { prompt: 'go' }));
    const kinds = events.map((e) => e.kind);
    expect(kinds.slice(-1)).toEqual(['turn_completed']);
    const raw = events.filter((e) => e.kind === 'raw');
    expect(raw).toHaveLength(3);
    expect(raw[0]!.payload).toMatchObject({ fakeEvent: 'fake_custom_event', weird: { nested: [1, 2, 3] } });
    expect(raw[1]!.payload).toMatchObject({ malformed: true, line: 'this line is not json {' });
    expect(raw[2]!.payload).toMatchObject({ malformed: true, reason: 'missing event name' });
    expect(events.find((e) => e.kind === 'assistant_message')?.payload['text']).toBe('still alive');
    expect(summarizeTurnEvidence(events)).toMatchObject({ completed: true, rawEvents: 3, errors: [] });
  });

  it('distinguishes queued from active-turn delivery, observes interruption and rejects a second concurrent turn', async () => {
    const f = fixture({ scenarioVersion: 1, turns: [[{ action: 'sleep', ms: 5_000 }], [{ action: 'message', text: 'second' }]] });
    const handle = await open(f);

    const queued = await f.adapter.deliver(handle, { messageId: 'm1', body: 'queued before any turn' });
    expect(queued).toMatchObject({ messageId: 'm1', state: 'queued', turnId: null });

    const turn = await f.adapter.startTurn(handle, { prompt: 'sleep' });
    await expect(f.adapter.startTurn(handle, { prompt: 'again' })).rejects.toMatchObject({ code: 'turn_active' });

    const submitted = await f.adapter.deliver(handle, { messageId: 'm2', body: 'during the turn' });
    expect(submitted).toMatchObject({ messageId: 'm2', state: 'submitted_to_active_turn', turnId: turn.turnId });

    const interruption = await f.adapter.interrupt(turn);
    expect(interruption).toMatchObject({ turnId: turn.turnId, state: 'observed' });
    const events = await collect(f.adapter, turn);
    const started = events.find((e) => e.kind === 'turn_started');
    expect(started?.payload['inbox']).toEqual([{ messageId: 'm1', body: 'queued before any turn' }]);
    expect(events.some((e) => e.kind === 'raw' && e.payload['fakeEvent'] === 'message_received' && e.payload['messageId'] === 'm2')).toBe(true);
    expect(summarizeTurnEvidence(events)).toMatchObject({ interrupted: true, completed: false });

    // The slot is free again: the next turn runs and the consumed inbox is not redelivered.
    const next = await collect(f.adapter, await f.adapter.startTurn(handle, { prompt: 'next' }));
    expect(next.find((e) => e.kind === 'turn_started' && e.turnId !== turn.turnId)?.payload['inbox']).toEqual([]);
    expect(next.filter((e) => e.turnId !== null && e.turnId !== turn.turnId).map((e) => e.kind)).toEqual(['turn_started', 'assistant_message', 'turn_completed']);
  });

  it('reports a write outside the granted paths as such', async () => {
    const f = fixture({ scenarioVersion: 1, steps: [{ action: 'write_outside', name: 'escape.txt' }, { action: 'claim_done' }] });
    const handle = await open(f);
    const events = await collect(f.adapter, await f.adapter.startTurn(handle, { prompt: 'escape' }));
    const escaped = path.join(f.root, 'escape.txt');
    const change = events.find((e) => e.kind === 'file_change');
    expect(change?.payload).toMatchObject({ path: escaped, withinAllowedPaths: false });
    expect(summarizeTurnEvidence(events)).toMatchObject({ claimedDone: true, fileChanges: [escaped], fileChangesOutsideAllowedPaths: [escaped] });
    // The fake runtime is not sandboxed; the point is that the violation is observable evidence, never a silent success.
    expect(existsSync(escaped)).toBe(true);
  });

  it('ends the stream with a fatal error when the runtime exits unexpectedly and reconciles the dead process', async () => {
    const f = fixture({ scenarioVersion: 1, steps: [{ action: 'message', text: 'about to crash' }, { action: 'exit', code: 3 }] });
    const handle = await open(f);
    const turn = await f.adapter.startTurn(handle, { prompt: 'crash' });
    const events = await collect(f.adapter, turn);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('error');
    expect(last.payload).toMatchObject({ fatal: true, reason: 'process_exited', exitCode: 3, expected: false });
    expect(summarizeTurnEvidence(events)).toMatchObject({ completed: false, interrupted: false });

    const observed = await f.adapter.reconcile(handle);
    expect(observed).toMatchObject({ processId: handle.processId, processAlive: false, processGroupAlive: false, activeTurnId: null, exitCode: 3, signal: null });
    expect(observed.lastEventSequence).toBe(last.sequence);
    const stop = await f.adapter.stopOwnedProcesses(handle);
    expect(stop).toMatchObject({ state: 'process_tree_terminated', signal: null });
  });

  it('terminates a hung runtime together with its child as a process group', async () => {
    const f = fixture({ scenarioVersion: 1, steps: [{ action: 'hang' }] }, { interruptTimeoutMs: 300, stopTimeoutMs: 3_000 });
    const handle = await open(f);
    const turn = await f.adapter.startTurn(handle, { prompt: 'hang' });
    let childPid: number | null = null;
    for await (const event of f.adapter.events(turn)) {
      if (event.kind === 'command_exec') {
        childPid = event.payload['childPid'] as number;
        break;
      }
    }
    expect(childPid).not.toBeNull();
    expect(isAlive(handle.processId!)).toBe(true);
    expect(isAlive(childPid!)).toBe(true);

    const before = await f.adapter.reconcile(handle);
    expect(before).toMatchObject({ processAlive: true, processGroupAlive: true, activeTurnId: turn.turnId });

    const interruption = await f.adapter.interrupt(turn);
    expect(interruption.state).toBe('requested'); // hung: nothing observed within the budget

    const stop = await f.adapter.stopOwnedProcesses(handle);
    expect(stop).toMatchObject({ state: 'process_tree_terminated', signal: 'SIGTERM', processId: handle.processId });
    expect(await waitUntil(() => !isAlive(handle.processId!) && !isAlive(childPid!), 3_000)).toBe(true);

    const after = await f.adapter.reconcile(handle);
    expect(after).toMatchObject({ processAlive: false, processGroupAlive: false, activeTurnId: null, signal: 'SIGTERM' });
    const tail = await collect(f.adapter, turn);
    expect(tail[tail.length - 1]).toMatchObject({ kind: 'error', payload: { fatal: true, reason: 'process_exited', signal: 'SIGTERM' } });
  });

  it('resumes a stopped session under the same identity and refuses to resume a live one', async () => {
    const f = fixture({ scenarioVersion: 1, steps: [{ action: 'message', text: 'hi' }] });
    const handle = await open(f);
    const input = { cwd: f.cwd, allowedWritePaths: [f.cwd], policy: 'local-development' as const, systemInstructions: 'x', sessionId: handle.sessionId };
    await expect(f.adapter.resumeSession(input)).rejects.toMatchObject({ code: 'session_active' });

    expect((await f.adapter.stopOwnedProcesses(handle)).state).toBe('process_tree_terminated');
    const resumed = await f.adapter.resumeSession(input);
    sessions.push({ adapter: f.adapter, handle: resumed });
    expect(resumed.sessionId).toBe(handle.sessionId);
    expect(resumed.processId).not.toBe(handle.processId);
    const events = await collect(f.adapter, await f.adapter.startTurn(resumed, { prompt: 'after resume' }));
    expect(events.find((e) => e.kind === 'session_started')?.payload).toMatchObject({ resumed: true, sessionId: handle.sessionId });
    expect(events.map((e) => e.kind)).toContain('turn_completed');
    expect(f.adapter.stderrOf(resumed)).toEqual([]);
  });
});
