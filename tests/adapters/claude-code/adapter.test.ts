/**
 * Deterministic adapter behaviour, driven by a fake `claude` binary that
 * replays a recorded or hand-built scenario. No network, no model, no quota.
 *
 * The replay is deterministic by construction: every record the fake writes is
 * emitted synchronously from the frame that triggered it (see
 * fixtures/claude-code/fake-claude.mjs), so there is no deferred release for
 * two client frames to race past — the defect WP03's replay fixture shipped.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, type RuntimeEvent, type SessionHandle, type SessionInput } from '../../../src/adapters/types.js';
import { ClaudeCodeAdapter as ClaudeCodeAdapterClass, CLAUDE_CODE_CAPABILITIES } from '../../../src/adapters/claude-code/adapter.js';
import { TESTED_CLAUDE_VERSION } from '../../../src/adapters/claude-code/protocol.js';
import { summarizeTurnEvidence } from '../../../src/telemetry/events.js';
import type { ClaudeCodeAdapter } from '../../../src/adapters/claude-code/adapter.js';
import { allOfKind, argAfter, collect, firstOfKind, kinds, readArgvLog, replayAdapter, scenarioEnv, scenarioPath, tempWorkspace, variadicAfter } from './helpers.js';

const open: Array<{ adapter: ClaudeCodeAdapter; handle: SessionHandle }> = [];

afterEach(async () => {
  while (open.length > 0) {
    const entry = open.pop()!;
    await entry.adapter.stopOwnedProcesses(entry.handle).catch(() => undefined);
  }
});

interface Fixture {
  readonly adapter: ClaudeCodeAdapter;
  readonly handle: SessionHandle;
  readonly workspace: string;
}

async function session(
  scenario: string,
  options: { readonly vars?: Record<string, string>; readonly argvOut?: string; readonly policy?: SessionInput['policy']; readonly adapter?: ClaudeCodeAdapter; readonly model?: string } = {},
): Promise<Fixture> {
  const workspace = tempWorkspace();
  const adapter = options.adapter ?? replayAdapter();
  const input: SessionInput = {
    cwd: workspace,
    allowedWritePaths: [workspace],
    policy: options.policy ?? 'local-development',
    systemInstructions: 'You are a workforce worker.',
    env: scenarioEnv(scenarioPath(scenario), {
      vars: { cwd: workspace, ...(options.vars ?? {}) },
      ...(options.argvOut !== undefined ? { argvOut: options.argvOut } : {}),
    }),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
  const handle = await adapter.openSession(input);
  open.push({ adapter, handle });
  return { adapter, handle, workspace };
}

describe('session identity (FR004, plan section 6)', () => {
  it('the coordinator knows the session id before the runtime has produced a turn', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    const { adapter, handle } = await session('session-hello.synthetic.json', { argvOut });
    // The id is ours: minted before the spawn and handed to the process, not
    // read out of its output. A valid uuid, which this build requires.
    expect(handle.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(argAfter(readArgvLog(argvOut)[0]!.argv, '--session-id')).toBe(handle.sessionId);
    const state = await adapter.reconcile(handle);
    expect(state.sessionId).toBe(handle.sessionId);
    expect(state.activeTurnId).toBeNull();
  });

  it('passes that id to the runtime as --session-id and every event carries it', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    const { adapter, handle } = await session('session-hello.synthetic.json', { argvOut });
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);

    const argv = readArgvLog(argvOut)[0]!.argv;
    expect(argAfter(argv, '--session-id')).toBe(handle.sessionId);
    expect(events.every((e) => e.sessionId === handle.sessionId)).toBe(true);
    const started = firstOfKind(events, 'session_started');
    expect(started?.payload['reportedSessionId']).toBe(handle.sessionId);
  });

  it('reports the tool surface the runtime says it granted when it is wider than the profile asked for', async () => {
    // Claude Code has no OS sandbox, so the granted tool surface IS the write
    // boundary. The runtime states it in every `init` record; the adapter used
    // to copy that record into `effective` — overwriting the field the
    // initialize-time check had looked at — and compare nothing.
    //
    // This scenario's init grants Read, Glob, Grep, Edit and Write. Under the
    // read-only `analysis` profile, Edit and Write are two tools the profile
    // never asked for.
    const { adapter, handle } = await session('session-hello.synthetic.json', { policy: 'analysis' });
    const events = await collect(adapter, await adapter.startTurn(handle, { prompt: 'have a look' }));

    const started = firstOfKind(events, 'session_started')!;
    const mismatches = started.payload['profileMismatch'] as Array<{ aspect: string; requested: string; reported: string; detail: string }>;
    expect(mismatches.map((entry) => entry.aspect).sort()).toEqual(['permissionMode', 'tools']);
    const tools = mismatches.find((entry) => entry.aspect === 'tools')!;
    expect(tools).toMatchObject({ requested: 'Glob, Grep, Read' });
    expect(tools.detail).toContain('Edit, Write');
    expect(tools.detail).toContain('the only write boundary this runtime has');
    // The permission mode is the same story: `analysis` asks for plan mode and
    // the runtime says it is accepting edits.
    expect(mismatches.find((entry) => entry.aspect === 'permissionMode')).toMatchObject({ requested: 'plan', reported: 'acceptEdits' });
    // The requested surface is on the record beside the granted one, so a
    // reader of the events never has to guess which is which.
    expect(started.payload['requestedTools']).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('reports no mismatch when the runtime grants exactly the profile that was requested', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json', { policy: 'local-development' });
    const events = await collect(adapter, await adapter.startTurn(handle, { prompt: 'do the work' }));

    const started = firstOfKind(events, 'session_started')!;
    expect(started.payload['profileMismatch']).toEqual([]);
    expect(started.payload['permissionMode']).toBe('acceptEdits');
  });

  it('refuses a second concurrent turn in the same session', async () => {
    const { adapter, handle } = await session('session-interrupt.synthetic.json');
    await adapter.startTurn(handle, { prompt: 'first' });
    await expect(adapter.startTurn(handle, { prompt: 'second' })).rejects.toThrow(/only one turn may be active/);
  });

  it('refuses to resume while the recorded process is still alive', async () => {
    const { adapter, handle, workspace } = await session('session-hang.synthetic.json');
    await expect(
      adapter.resumeSession({
        cwd: workspace,
        allowedWritePaths: [workspace],
        policy: 'local-development',
        systemInstructions: '',
        sessionId: handle.sessionId,
        previousProcess: handle.process ?? null,
      }),
    ).rejects.toThrow(/still/);
  });
});

describe('argv against the installed flag surface', () => {
  it('grants the analysis profile no writers and no shell', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    await session('session-hello.synthetic.json', { argvOut, policy: 'analysis' });
    const argv = readArgvLog(argvOut)[0]!.argv;
    expect(variadicAfter(argv, '--tools')).toEqual(['Read', 'Glob', 'Grep']);
    expect(argAfter(argv, '--permission-mode')).toBe('plan');
    expect(argv).toContain('--restricted');
  });

  it('grants local-development the file writers, the candidate directory and still no shell', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    const { workspace } = await session('session-hello.synthetic.json', { argvOut });
    const argv = readArgvLog(argvOut)[0]!.argv;
    expect(variadicAfter(argv, '--tools')).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    expect(variadicAfter(argv, '--add-dir')).toEqual([workspace]);
    expect(argAfter(argv, '--permission-mode')).toBe('acceptEdits');
    expect(argAfter(argv, '--permission-prompts')).toBe('none');
    expect(argv).not.toContain('Bash');
  });

  it('refuses to open a session under the verification profile', async () => {
    const adapter = replayAdapter();
    const workspace = tempWorkspace();
    await expect(
      adapter.openSession({ cwd: workspace, allowedWritePaths: [workspace], policy: 'verification', systemInstructions: '' }),
    ).rejects.toThrow(/check runner/);
  });

  it('refuses an unsupported effort before anything is spawned', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    const adapter = replayAdapter();
    const workspace = tempWorkspace();
    await expect(
      adapter.openSession({
        cwd: workspace,
        allowedWritePaths: [workspace],
        policy: 'local-development',
        systemInstructions: '',
        effort: 'turbo',
        env: scenarioEnv(scenarioPath('session-hello.synthetic.json'), { argvOut }),
      }),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(existsSync(argvOut)).toBe(false);
  });
});

describe('event normalization', () => {
  it('produces the documented kinds with a monotonic sequence and a raw reference', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);

    expect(kinds(events)).toEqual([
      'session_started',
      'turn_started',
      'raw', // the --replay-user-messages acknowledgement of our own frame
      'assistant_message',
      'tool_call',
      'file_change', // the model's request to write
      'tool_result',
      'file_change', // and the answer: the write was applied
      'assistant_message',
      'turn_completed',
    ]);
    for (let i = 1; i < events.length; i += 1) expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
    expect(events.every((e) => e.rawRef.startsWith(`claude-code:${handle.sessionId}:`))).toBe(true);
    expect(new Set(events.map((e) => e.spawnToken)).size).toBe(1);
  });

  it('records the effective settings the runtime reports in its init record (FR006)', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    await collect(adapter, turn);
    const effective = adapter.effectiveSettings(handle);
    expect(effective?.model).toBe('claude-opus-5[1m]');
    expect(effective?.permissionMode).toBe('acceptEdits');
    expect(effective?.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
    expect(effective?.cliVersion).toBe('2.1.260');
    expect(effective?.mcpServers).toEqual([]);
  });

  it('marks a file change inside the granted paths, as a request and then as an applied write', async () => {
    const { adapter, handle, workspace } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    const changes = allOfKind(events, 'file_change');
    expect(changes).toHaveLength(2);

    const [requested, applied] = changes as [RuntimeEvent, RuntimeEvent];
    // The request says nothing about whether the write happened.
    expect(requested.payload).toMatchObject({ tool: 'Write', phase: 'requested', applied: null, denied: false, withinAllowedPaths: true, toolUseId: 'toolu_01' });
    expect(requested.payload['resolvedPath']).toBe(path.join(workspace, 'hello.txt'));
    // The matching tool_result does, and is correlated back by tool_use id.
    expect(applied.payload).toMatchObject({ tool: 'Write', phase: 'completed', applied: true, denied: false, withinAllowedPaths: true, toolUseId: 'toolu_01' });
    expect(applied.payload['resolvedPath']).toBe(path.join(workspace, 'hello.txt'));

    // The shared tool_result vocabulary every consumer reads: which tool, and
    // whether it succeeded. Without the correlation this said "tool unknown".
    const result = firstOfKind(events, 'tool_result')!;
    expect(result.payload).toMatchObject({ tool: 'Write', status: 'ok', ok: true, isError: false, toolUseId: 'toolu_01' });

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.fileChanges).toEqual([path.join(workspace, 'hello.txt')]);
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([]);
  });

  it('marks an applied file change outside the granted paths as an escape', async () => {
    const outside = tempWorkspace('wf-claude-outside-');
    const escapePath = path.join(outside, 'escape.txt');
    const { adapter, handle } = await session('session-escape.synthetic.json', { vars: { escapePath } });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    const change = firstOfKind(events, 'file_change')!;
    expect(change.payload['withinAllowedPaths']).toBe(false);
    expect(change.payload['resolvedPath']).toBe(escapePath);

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([escapePath]);
    expect(evidence.deniedFileChangesOutsideAllowedPaths).toEqual([]);
    expect(evidence.unconfirmedFileChangesOutsideAllowedPaths).toEqual([]);
  });

  it('distinguishes a write the runtime refused from one it applied', async () => {
    const outside = tempWorkspace('wf-claude-denied-');
    const escapePath = path.join(outside, 'denied.txt');
    const { adapter, handle } = await session('session-denied-write.synthetic.json', { vars: { escapePath } });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    const changes = allOfKind(events, 'file_change');
    expect(changes).toHaveLength(2);
    expect(changes[0]!.payload).toMatchObject({ phase: 'requested', applied: null, denied: false });
    expect(changes[1]!.payload).toMatchObject({ phase: 'completed', applied: false, denied: true });
    expect(String(changes[1]!.payload['detail'])).toContain('Permission denied');
    expect(firstOfKind(events, 'tool_result')!.payload).toMatchObject({ tool: 'Write', status: 'failed', ok: false, isError: true });

    // The boundary working is not an escape: it is recorded, and separately.
    const evidence = summarizeTurnEvidence(events);
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([]);
    expect(evidence.deniedFileChangesOutsideAllowedPaths).toEqual([escapePath]);
  });

  it('treats a write whose outcome the runtime never reports as an escape it cannot rule out', async () => {
    // session-hang emits an init for the first user frame and nothing else, so
    // the delivered tool_use below never gets its tool_result.
    const outside = tempWorkspace('wf-claude-unconfirmed-');
    const escapePath = path.join(outside, 'unconfirmed.txt');
    const { adapter, handle } = await session('session-escape-unconfirmed.synthetic.json', { vars: { escapePath } });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    const changes = allOfKind(events, 'file_change');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ phase: 'requested', applied: null });

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([escapePath]);
    expect(evidence.unconfirmedFileChangesOutsideAllowedPaths).toEqual([escapePath]);
    expect(evidence.deniedFileChangesOutsideAllowedPaths).toEqual([]);
  });

  it('reports a completion claim as an assistant message, never as success (FR050)', async () => {
    const { adapter, handle } = await session('session-claims-done.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    const message = firstOfKind(events, 'assistant_message')!;
    expect(message.payload['text']).toContain('Done.');
    // This runtime marks no message as the terminal answer, so nothing is a claim.
    expect(message.payload['claimsDone']).toBe(false);
    expect(message.payload['phaseKnown']).toBe(false);
    expect(allOfKind(events, 'file_change')).toHaveLength(0);
    const completed = firstOfKind(events, 'turn_completed')!;
    expect(completed.payload['evidence']).toBe('runtime_reported');
  });

  it('survives bare text, malformed JSON, unknown record types and unknown fields', async () => {
    const { adapter, handle } = await session('session-noise.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    // The stream still reached its terminal event.
    expect(firstOfKind(events, 'turn_completed')).toBeDefined();
    const raws = allOfKind(events, 'raw');
    const reasons = raws.map((e) => e.payload['reason']);
    expect(reasons).toContain('non_json_stdout_line');
    expect(reasons).toContain('runtime_record'); // the record type from the future
    expect(reasons).toContain('system_record'); // the system subtype from the future
    expect(reasons).toContain('assistant_block'); // the content block from the future
    // A malformed line arrived as text; a bare `42` is valid JSON without a
    // `type`, so it is kept separately. Neither threw.
    expect(raws.filter((e) => e.payload['reason'] === 'non_json_stdout_line').length).toBeGreaterThanOrEqual(2);
    expect(reasons).toContain('json_without_type');
    // Unknown fields on a known record are preserved, not dropped.
    const message = firstOfKind(events, 'assistant_message')!;
    expect(message.payload['text']).toBe('still here');
  });
});

describe('delivery receipts (plan section 6: queued vs submitted)', () => {
  it('queues in the adapter when no turn is active, and flushes into the next turn', async () => {
    const argvOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-argv-')), 'argv.jsonl');
    const { adapter, handle } = await session('session-hello.synthetic.json', { argvOut });
    const receipt = await adapter.deliver(handle, { messageId: 'm1', body: 'peer says the interface changed' });
    expect(receipt.state).toBe('queued');
    expect(receipt.turnId).toBeNull();
    expect(receipt.detail).toContain('adapter holds');
    expect(adapter.pendingDeliveries(handle).map((d) => d.messageId)).toEqual(['m1']);

    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    // The runtime echoed the combined frame back, so the flush actually reached it.
    const replay = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'user_message_replay')!;
    expect(String(replay.payload['text'])).toContain('[coordinator message m1]');
    expect(String(replay.payload['text'])).toContain('peer says the interface changed');
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
  });

  it('does not claim submission into the active turn on an acknowledgement alone', async () => {
    const { adapter, handle } = await session('session-delivery.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'start working' });
    const receipt = await adapter.deliver(handle, { messageId: 'm2', body: 'stop after the first file', correlationId: 'c9' });

    // The echo proves the runtime ingested the frame during the turn, not that
    // the running turn will see it — and `active_turn_delivery` is
    // supported_unverified for this build, so the contract's strongest receipt
    // is not issued on that evidence.
    expect(CLAUDE_CODE_CAPABILITIES.active_turn_delivery.status).toBe('supported_unverified');
    expect(receipt.state).toBe('queued');
    expect(receipt.turnId).toBeNull();
    // Who has it is a value, not prose: the runtime does.
    expect(receipt.holder).toBe('runtime');
    expect(receipt.detail).toContain('--replay-user-messages');
    expect(receipt.detail).toContain(turn.turnId);
    // And because the runtime has it, the adapter does not hold a second copy.
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
    await adapter.interrupt(turn);
  });

  it('holds an unacknowledged message itself and flushes it into the next turn', async () => {
    // The failure this guards against: a receipt saying "queued" for a message
    // that is in neither queue, so the next turn never carries it and the
    // runtime that was supposed to hold it may never have read it.
    const { adapter, handle } = await session('session-hang-then-answer.synthetic.json', { adapter: replayAdapter({ deliveryAckTimeoutMs: 300 }) });
    const first = await adapter.startTurn(handle, { prompt: 'go' });
    const receipt = await adapter.deliver(handle, { messageId: 'm4', body: 'the peer changed the interface' });

    expect(receipt.state).toBe('queued');
    expect(receipt.holder).toBe('adapter');
    expect(receipt.detail).toContain('not acknowledged');
    // The adapter took it back rather than leaving it with nobody.
    expect(adapter.pendingDeliveries(handle).map((d) => d.messageId)).toEqual(['m4']);

    await adapter.interrupt(first);
    await collect(adapter, first);

    const second = await adapter.startTurn(handle, { prompt: 'carry on' });
    const events = await collect(adapter, second);
    const replayed = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'user_message_replay')!;
    expect(String(replayed.payload['text'])).toContain('[coordinator message m4]');
    expect(String(replayed.payload['text'])).toContain('the peer changed the interface');
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
  });

  it('refuses a delivery to a session whose process is gone instead of promising a next turn', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json');
    await adapter.stopOwnedProcesses(handle);

    // startTurn on this session always throws, so a "queued for the next turn"
    // receipt would name a turn that can never happen.
    await expect(adapter.deliver(handle, { messageId: 'm-after-death', body: 'hello' })).rejects.toMatchObject({ name: 'AdapterError', code: 'session_closed' });
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
    await expect(adapter.startTurn(handle, { prompt: 'anything' })).rejects.toMatchObject({ code: 'session_closed' });
  });
});

describe('interrupt receipts (plan section 6: requested vs observed)', () => {
  it('reports observed only when a terminal record actually arrives', async () => {
    const { adapter, handle } = await session('session-interrupt.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'search the whole repository' });
    const receipt = await adapter.interrupt(turn);
    expect(receipt.state).toBe('observed');
    expect(receipt.detail).toContain('turn_interrupted');

    const events = await collect(adapter, turn);
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('turn_interrupted');
    expect(terminal.payload['terminalReason']).toBe('interrupted');
    expect(terminal.payload['interruptRequestedByCoordinator']).toBe(true);
  });

  it('reports requested when the runtime accepts the interrupt but never ends the turn', async () => {
    const { adapter, handle } = await session('session-hang.synthetic.json', { adapter: replayAdapter({ interruptTimeoutMs: 400 }) });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const receipt = await adapter.interrupt(turn);
    expect(receipt.state).toBe('requested');
    expect(receipt.detail).toContain('no terminal record');
  });

  it('reports observed without asking again when the turn already ended', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    await collect(adapter, turn);
    const receipt = await adapter.interrupt(turn);
    expect(receipt.state).toBe('observed');
    expect(receipt.detail).toContain('already produced a terminal record');
  });
});

describe('stopping and reconciliation', () => {
  it('reports the observed state of the owned process group', async () => {
    const { adapter, handle } = await session('session-hang.synthetic.json');
    const before = await adapter.reconcile(handle);
    expect(before.processAlive).toBe(true);
    expect(before.processGroupAlive).toBe(true);

    const receipt = await adapter.stopOwnedProcesses(handle);
    expect(receipt.state).toBe('process_tree_terminated');
    expect(receipt.processId).toBe(handle.process?.pid);
    expect(receipt.detail).toContain('is empty');

    const after = await adapter.reconcile(handle);
    expect(after.processAlive).toBe(false);
    expect(after.activeTurnId).toBeNull();
  });

  it('refuses to signal a process it can only identify by pid', async () => {
    const adapter = replayAdapter();
    const receipt = await adapter.stopOwnedProcesses({ adapter: 'claude-code', sessionId: 'unknown-session', processId: 999_999, raw: null });
    expect(receipt.state).toBe('unknown');
    expect(receipt.detail).toContain('refusing to signal a process by pid alone');
  });

  it('reports an unknown session honestly rather than claiming liveness', async () => {
    const adapter = replayAdapter();
    const state = await adapter.reconcile({ adapter: 'claude-code', sessionId: 'unknown-session', raw: null });
    expect(state.processAlive).toBe('unknown');
    expect(state.processGroupAlive).toBe('unknown');
    expect(state.lastEventSequence).toBe(0);
  });
});

describe('one adapter turn is not one runtime turn', () => {
  it('does not end a turn on the result of a turn the runtime scheduled for itself', async () => {
    // The runtime's own fields describe a queue: a message delivered during a
    // turn can become a turn of its own. Its result must not terminate the
    // NEXT adapter turn's stream with another turn's text, usage and cost.
    const { adapter, handle } = await session('session-queued-turn.synthetic.json');
    const first = await adapter.startTurn(handle, { prompt: 'first' });
    const firstEvents = await collect(adapter, first);
    expect(firstOfKind(firstEvents, 'turn_completed')!.payload['resultText']).toBe('turn 1 done');
    // The runtime said it still has one turn of its own to run.
    expect(firstOfKind(firstEvents, 'turn_completed')!.payload['queuedTurnCount']).toBe(1);

    const second = await adapter.startTurn(handle, { prompt: 'second' });
    const events = await collect(adapter, second);

    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('turn_completed');
    expect(terminal.turnId).toBe(second.turnId);
    // Turn two's own result, not the queued turn's.
    expect(terminal.payload['resultText']).toBe('turn 2 done');
    expect((terminal.payload['usage'] as { costUsd: number | null }).costUsd).toBe(0.0123);

    // The stray result is kept as evidence, attributed to nothing.
    const stray = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'unattributed_result_record');
    expect(stray, 'the queued turn\'s result is recorded as evidence').toBeDefined();
    expect(stray!.turnId).toBeNull();
    expect(JSON.stringify(stray!.payload['record'])).toContain('queued turn done');
  });

  it('does the same when the extra runtime turn starts before the previous one ends', async () => {
    const { adapter, handle } = await session('session-queued-turn-interleaved.synthetic.json');
    const first = await adapter.startTurn(handle, { prompt: 'first' });
    await collect(adapter, first);

    const second = await adapter.startTurn(handle, { prompt: 'second' });
    const events = await collect(adapter, second);

    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('turn_completed');
    expect(terminal.payload['resultText']).toBe('turn 2 done');
    // Two runtime turns ran under one adapter turn, and the event stream says so.
    expect(terminal.payload['runtimeTurnsObserved']).toBe(2);
    const extra = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'extra_runtime_turn_started');
    expect(extra, 'the second system/init is recorded as the signal it is').toBeDefined();
  });
});

describe('a result record always ends its turn (plan section 9)', () => {
  it('accepts a result whose optional fields are JSON null', async () => {
    const { adapter, handle } = await session('session-null-fields-result.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('turn_completed');
    expect(terminal.payload['terminalReason']).toBeNull();
    expect(terminal.payload['resultText']).toBe('done');
    // No protocol failure: nulls are read as absent values, not as a broken record.
    expect(allOfKind(events, 'error')).toHaveLength(0);
    // `total_cost_usd: null` is "no number", which is unavailable — never zero.
    const usage = terminal.payload['usage'] as { costStatus: string; costUsd: number | null; inputTokens: number | null };
    expect(usage).toMatchObject({ costStatus: 'unavailable', costUsd: null, inputTokens: null });
    expect(await adapter.reconcile(handle)).toMatchObject({ activeTurnId: null });
  });

  it('ends the turn with a protocol diagnostic when the result body cannot be read at all', async () => {
    const { adapter, handle } = await session('session-unreadable-result.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);

    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('turn_completed');
    expect(terminal.payload['terminalReason']).toBe('malformed_result_record');
    expect(terminal.payload['isError']).toBe(true);
    expect(String(terminal.payload['protocolError'])).toContain('subtype');
    // The raw body is retained, and the failure is reported rather than guessed at.
    expect(JSON.stringify(terminal.payload['record'])).toContain('"subtype":7');
    const error = firstOfKind(events, 'error')!;
    expect(error.payload['reason']).toBe('malformed_result_record');
    expect(error.payload['fatal']).toBe(false);
    // The session is free to take another turn: nothing is left hanging.
    expect(await adapter.reconcile(handle)).toMatchObject({ activeTurnId: null });
  });
});

describe('usage and cost from the result record (FR060)', () => {
  it('reports a measured cost when the turn reached the provider', async () => {
    const { adapter, handle } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    const usage = adapter.lastUsage(handle)!;
    expect(usage.costStatus).toBe('measured');
    expect(usage.costUsd).toBe(0.0123);
    expect(usage.inputTokens).toBe(1200);
    const completed = firstOfKind(events, 'turn_completed')!;
    expect((completed.payload['usage'] as { costStatus: string }).costStatus).toBe('measured');
  });

  it('never reports zero cost for a turn that made no provider call', async () => {
    const { adapter, handle } = await session('session-no-api-call.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    await collect(adapter, turn);
    const usage = adapter.lastUsage(handle)!;
    expect(usage.costStatus).toBe('unavailable');
    expect(usage.costUsd).toBeNull();
  });

  it('answers the shared contract accessor the coordinator actually reads', async () => {
    // The manifest reads RuntimeAdapter.lastTurnUsage and nothing else. An
    // adapter-shaped accessor alone is invisible to it, which is how a run
    // ends up recording "no usage was reported" about a measured turn.
    const { adapter, handle } = await session('session-hello.synthetic.json');
    expect(typeof (adapter as unknown as { lastTurnUsage?: unknown }).lastTurnUsage).toBe('function');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    await collect(adapter, turn);

    expect(adapter.lastTurnUsage(handle)).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      costUsd: 0.0123,
      costStatus: 'measured',
      detail: adapter.lastUsage(handle)!.costDetail,
    });
  });
});

describe('the recorded real transcript', () => {
  it('replays the authentication-failure path the installed runtime really produced', async () => {
    const { adapter, handle } = await session('session-auth-failure.real.json');
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);

    const error = firstOfKind(events, 'error')!;
    expect(error.payload['errorClass']).toBe('authentication');
    expect(error.payload['fatal']).toBe(false);
    expect(String(error.payload['message'])).toContain('OAuth session expired');

    const completed = firstOfKind(events, 'turn_completed')!;
    expect(completed.payload['isError']).toBe(true);
    expect(completed.payload['terminalReason']).toBe('api_error');
    // The runtime's own total_cost_usd is 0 here, and reporting that as a
    // measured cost would be a lie: nothing was spent because nothing ran.
    expect((completed.payload['usage'] as { costStatus: string }).costStatus).toBe('unavailable');
    // Nothing in the stream can be read as a completion.
    expect(allOfKind(events, 'file_change')).toHaveLength(0);
  });
});

describe('raw capture', () => {
  it('writes every framed line in both directions into the run logs directory', async () => {
    const logsDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-logs-')), 'logs');
    const { adapter, handle } = await session('session-hello.synthetic.json', { adapter: replayAdapter({ logsDir }) });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    await collect(adapter, turn);

    const file = adapter.rawLogPath(handle)!;
    expect(readdirSync(logsDir)).toHaveLength(1);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; line: string });
    expect(lines.some((l) => l.dir === 'out' && l.line.includes('control_request'))).toBe(true);
    expect(lines.some((l) => l.dir === 'out' && l.line.includes('"type":"user"'))).toBe(true);
    expect(lines.some((l) => l.dir === 'in' && l.line.includes('"subtype":"init"'))).toBe(true);
    expect(lines.some((l) => l.dir === 'in' && l.line.includes('"type":"result"'))).toBe(true);
  });

  it('creates nothing when the session is refused before it is spawned', async () => {
    const logsDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'wf-logs-')), 'logs');
    const adapter = replayAdapter({ logsDir });
    const workspace = tempWorkspace();
    await expect(adapter.openSession({ cwd: workspace, allowedWritePaths: [workspace], policy: 'verification', systemInstructions: '' })).rejects.toThrow();
    expect(existsSync(logsDir)).toBe(false);
  });
});

describe('capability table (FR005)', () => {
  it('states every capability against the tested version and OS', () => {
    const capabilities = replayAdapter().capabilities();
    expect(capabilities.adapter).toBe('claude-code');
    for (const [name, report] of Object.entries(capabilities.capabilities)) {
      expect(['unsupported', 'supported_unverified', 'verified'], name).toContain(report.status);
      expect(report.testedVersion, name).toBe('2.1.260');
      expect(report.os, name).toBe('darwin');
      expect(report.note, name).toBeTruthy();
    }
  });

  it('does not claim a write boundary this runtime does not provide (FR042)', () => {
    const report = replayAdapter().capabilities().capabilities.write_containment;
    expect(report.status).toBe('unsupported');
    expect(report.note).toContain('no OS sandbox');
  });
});

/**
 * The adapter reads a login-status command the same way passive discovery
 * does, because this reading is the one a run records.
 *
 * This file used to carry a second, looser copy of the parser: it ignored the
 * exit code entirely, read stdout and stderr together, and answered
 * `logged_in` for `{"loggedIn": true}` printed by a command that then exited 1
 * or died on a signal. `doctor --connect` lets the adapter's answer replace
 * the probe's, so the conservative reading was computed and then overwritten
 * by the permissive one — a false readiness claim, which is the failure this
 * coordinator exists to prevent.
 */
describe('the adapter reads `claude auth status` by the one set of rules (FR002)', () => {
  function stub(body: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-auth-stub-'));
    const file = path.join(dir, 'claude');
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${TESTED_CLAUDE_VERSION} (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n${body}\nfi\nexit 64\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
    return file;
  }

  it('never reports logged_in for a status command that failed, however cheerful its output', async () => {
    const adapter = new ClaudeCodeAdapterClass({ probeTimeoutMs: 5_000 });

    // A signed-in JSON answer from a command that then exits 1.
    const claiming = stub('echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'\nexit 1');
    expect((await adapter.probe(claiming)).authentication).toBe('unknown');

    // The same answer from a command that printed it and then died.
    const crashing = stub('echo \'{"loggedIn": true}\'\nkill -SEGV $$');
    expect((await adapter.probe(crashing)).authentication).toBe('unknown');

    // And a crash whose wording happens to contain "not logged in" is not an
    // answer either — it is a failure that mentions a login.
    const proxy = stub('echo "fatal: proxy rejected request: you are not logged in to corp-proxy" >&2\nexit 70');
    expect((await adapter.probe(proxy)).authentication).toBe('unknown');
  });

  it('still reads the answer the installed build actually gives when it is signed out', async () => {
    const adapter = new ClaudeCodeAdapterClass({ probeTimeoutMs: 5_000 });
    // 2.1.260 signed out: exit 1, the complete JSON answer on stdout.
    const signedOut = stub('echo \'{"loggedIn": false, "authMethod": "none"}\'\nexit 1');
    const readiness = await adapter.probe(signedOut);

    expect(readiness.authentication).toBe('logged_out');
    expect(readiness.ready).not.toBe('verified_ready');
  });
});
