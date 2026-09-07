/**
 * Deterministic adapter behaviour, driven by a fake `claude` binary that
 * replays a recorded or hand-built scenario. No network, no model, no quota.
 *
 * The replay is deterministic by construction: every record the fake writes is
 * emitted synchronously from the frame that triggered it (see
 * fixtures/claude-code/fake-claude.mjs), so there is no deferred release for
 * two client frames to race past — the defect WP03's replay fixture shipped.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, type SessionHandle, type SessionInput } from '../../../src/adapters/types.js';
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
      'file_change',
      'tool_result',
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

  it('marks a file change inside the granted paths', async () => {
    const { adapter, handle, workspace } = await session('session-hello.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    const change = firstOfKind(events, 'file_change')!;
    expect(change.payload['withinAllowedPaths']).toBe(true);
    expect(change.payload['resolvedPath']).toBe(path.join(workspace, 'hello.txt'));
    expect(change.payload['tool']).toBe('Write');
  });

  it('marks a file change outside the granted paths', async () => {
    const outside = tempWorkspace('wf-claude-outside-');
    const escapePath = path.join(outside, 'escape.txt');
    const { adapter, handle } = await session('session-escape.synthetic.json', { vars: { escapePath } });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    const events = await collect(adapter, turn);
    const change = firstOfKind(events, 'file_change')!;
    expect(change.payload['withinAllowedPaths']).toBe(false);
    expect(change.payload['resolvedPath']).toBe(escapePath);
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

  it('reports submitted_to_active_turn only when the runtime acknowledges during the turn', async () => {
    const { adapter, handle } = await session('session-delivery.synthetic.json');
    const turn = await adapter.startTurn(handle, { prompt: 'start working' });
    const receipt = await adapter.deliver(handle, { messageId: 'm2', body: 'stop after the first file', correlationId: 'c9' });
    expect(receipt.state).toBe('submitted_to_active_turn');
    expect(receipt.turnId).toBe(turn.turnId);
    expect(receipt.detail).toContain('--replay-user-messages');
    // Nothing was left in the adapter's own queue: the runtime has it.
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
    await adapter.interrupt(turn);
  });

  it('does not claim submission when the runtime never acknowledges', async () => {
    // session-hang answers the handshake and then produces nothing at all.
    const { adapter, handle } = await session('session-hang.synthetic.json', { adapter: replayAdapter({ deliveryAckTimeoutMs: 300 }) });
    const turn = await adapter.startTurn(handle, { prompt: 'go' });
    // The scenario's only `user` step emits an init record; a second delivery
    // gets no echo, so the receipt must not claim submission.
    await adapter.deliver(handle, { messageId: 'm3', body: 'first' });
    const receipt = await adapter.deliver(handle, { messageId: 'm4', body: 'second' });
    expect(receipt.state).toBe('queued');
    expect(receipt.detail).toContain('not acknowledged');
    void turn;
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
