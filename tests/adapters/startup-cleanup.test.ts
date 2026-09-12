import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code/adapter.js';
import { ClaudeTransport } from '../../src/adapters/claude-code/transport.js';
import { CodexRpcClient } from '../../src/adapters/codex/rpc.js';
import { FakeAdapter } from '../../src/adapters/fake/adapter.js';
import { AdapterError, type RuntimeAdapter, type SessionInput, type StopReceipt } from '../../src/adapters/types.js';
import { isProcessAlive, isProcessGroupAlive } from '../../src/core/process.js';
import { replayAdapter, writeTranscript } from './codex/helpers.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; input: SessionInput } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wf-startup-cleanup-')));
  roots.push(root);
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd);
  return { root, input: { cwd, allowedWritePaths: [cwd], policy: 'analysis', systemInstructions: 'startup fixture; no model turn' } };
}

async function failedStartup(adapter: RuntimeAdapter, input: SessionInput): Promise<AdapterError> {
  try {
    const handle = await adapter.openSession(input);
    await adapter.stopOwnedProcesses(handle);
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('fixture unexpectedly opened a session');
}

function receiptOf(error: AdapterError): StopReceipt {
  expect(error.startupStopReceipt).toBeDefined();
  const receipt = error.startupStopReceipt!;
  expect(receipt.sessionId).toEqual(expect.any(String));
  expect(receipt.sessionId.length).toBeGreaterThan(0);
  expect(receipt.processId).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(receipt.at))).toBe(false);
  return receipt;
}

function expectTerminated(error: AdapterError, signal: NodeJS.Signals | null): StopReceipt {
  const receipt = receiptOf(error);
  expect(receipt).toMatchObject({ state: 'process_tree_terminated', signal });
  // Check the OS independently of the receipt: startup rejection is not proof
  // that the owned process or its group stopped.
  expect(isProcessAlive(receipt.processId!)).toBe(false);
  expect(isProcessGroupAlive(receipt.processId!)).toBe(false);
  return receipt;
}

function codexRejection(root: string) {
  return writeTranscript(root, 'codex-rejection.jsonl', [
    { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize', params: {} }) },
    { dir: 'in', line: JSON.stringify({ id: 1, error: { code: -32000, message: 'startup fixture refused initialization' } }) },
  ]);
}

/** The standard Claude replay always answers initialize successfully. This
 * temporary process supplies the two failure paths without any model turn. */
function claudeFailure(root: string, mode: 'reject' | 'timeout', ignoreTerm = false): string {
  const script = path.join(root, 'claude-startup.mjs');
  writeFileSync(script, `
import { writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync('fixture-pid.txt', String(process.pid));
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
setInterval(() => {}, 1000);
setTimeout(() => process.exit(99), 10000);
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  appendFileSync('fixture-requests.jsonl', JSON.stringify(frame) + '\\n');
  if (${JSON.stringify(mode)} === 'reject') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'error', request_id: frame.request_id, error: 'startup fixture refused initialization'
    } }) + '\\n');
  }
});
`);
  return script;
}

describe('adapter startup failures retain observed process cleanup receipts', () => {
  it('Codex preserves RPC rejection and records SIGKILL escalation before rejecting startup', async () => {
    const { root, input } = workspace();
    const adapter = replayAdapter(codexRejection(root), { stopTimeoutMs: 100 }, ['--hang']);
    const error = await failedStartup(adapter, input);
    expect(error).toMatchObject({ adapter: 'codex', code: 'thread_start_rejected' });
    expect(error.message).toContain('startup fixture refused initialization');
    expectTerminated(error, 'SIGKILL');
  });

  it('Codex keeps a startup timeout distinct from rejection and records graceful cleanup', async () => {
    const { root, input } = workspace();
    const transcript = writeTranscript(root, 'codex-timeout.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize', params: {} }) },
    ]);
    const adapter = replayAdapter(transcript, { startupTimeoutMs: 250, stopTimeoutMs: 1_000 });
    const error = await failedStartup(adapter, input);
    expect(error).toMatchObject({ adapter: 'codex', code: 'transport_timeout' });
    expect(error.message).toContain('initialize');
    expectTerminated(error, null);
  });

  it('Codex preserves protocol_error when thread/start has a malformed result', async () => {
    const { root, input } = workspace();
    const transcript = writeTranscript(root, 'codex-malformed-thread.jsonl', [
      { dir: 'out', line: JSON.stringify({ id: 1, method: 'initialize', params: {} }) },
      { dir: 'in', line: JSON.stringify({ id: 1, result: {} }) },
      { dir: 'out', line: JSON.stringify({ method: 'initialized' }) },
      { dir: 'out', line: JSON.stringify({ id: 2, method: 'thread/start', params: {} }) },
      { dir: 'in', line: JSON.stringify({ id: 2, result: { thread: {} } }) },
    ]);
    const error = await failedStartup(replayAdapter(transcript), input);
    expect(error).toMatchObject({ adapter: 'codex', code: 'protocol_error' });
    expect(error.message).toContain('thread/start returned an unexpected shape');
    expect(error.cause).toBeInstanceOf(AdapterError);
    expect(error.cause).toMatchObject({ code: error.code, message: error.message });
    expectTerminated(error, null);
  });

  it('Claude preserves control rejection and records SIGTERM settlement of the fixture process', async () => {
    const { root, input } = workspace();
    const adapter = new ClaudeCodeAdapter({ executablePath: process.execPath, extraArgs: [claudeFailure(root, 'reject')], stopTimeoutMs: 100 });
    const error = await failedStartup(adapter, input);
    expect(error).toMatchObject({ adapter: 'claude-code', code: 'transport_control_error' });
    expect(error.message).toContain('startup fixture refused initialization');
    const receipt = expectTerminated(error, 'SIGTERM');
    expect(receipt.processId).toBe(Number(readFileSync(path.join(input.cwd, 'fixture-pid.txt'), 'utf8')));
    const frames = readFileSync(path.join(input.cwd, 'fixture-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
  });

  it('Claude preserves timeout and records SIGKILL when startup ignores SIGTERM', async () => {
    const { root, input } = workspace();
    const adapter = new ClaudeCodeAdapter({ executablePath: process.execPath, extraArgs: [claudeFailure(root, 'timeout', true)], startupTimeoutMs: 250, stopTimeoutMs: 100 });
    const error = await failedStartup(adapter, input);
    expect(error).toMatchObject({ adapter: 'claude-code', code: 'transport_timeout' });
    expect(error.message).toContain('initialize');
    const receipt = expectTerminated(error, 'SIGKILL');
    expect(receipt.processId).toBe(Number(readFileSync(path.join(input.cwd, 'fixture-pid.txt'), 'utf8')));
  });

  it('Fake preserves startup_failed with SIGKILL cleanup when no session handshake arrives', async () => {
    const { root, input } = workspace();
    const script = path.join(root, 'fake-no-handshake.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
writeFileSync('fixture-pid.txt', String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
setTimeout(() => process.exit(99), 10000);
`);
    const error = await failedStartup(new FakeAdapter({ scriptPath: script, startupTimeoutMs: 250, stopTimeoutMs: 100 }), input);
    expect(error).toMatchObject({ adapter: 'fake', code: 'startup_failed' });
    expect(error.message).toContain('did not report session_started');
    const receipt = expectTerminated(error, 'SIGKILL');
    expect(receipt.processId).toBe(Number(readFileSync(path.join(input.cwd, 'fixture-pid.txt'), 'utf8')));
  });

  it('Fake records already-exited startup failure without inventing a termination signal', async () => {
    const { root, input } = workspace();
    const script = path.join(root, 'fake-rejected.mjs');
    writeFileSync(script, "process.stderr.write('startup fixture refused configuration\\n'); process.exitCode = 2;\n");
    const error = await failedStartup(new FakeAdapter({ scriptPath: script, startupTimeoutMs: 1_000 }), input);
    expect(error).toMatchObject({ adapter: 'fake', code: 'startup_failed' });
    expect(error.message).toContain('startup fixture refused configuration');
    expectTerminated(error, null);
  });

  for (const observation of [{ exited: true, groupAlive: true }, { exited: false, groupAlive: false }]) {
    it(`Codex does not claim termination for incomplete cleanup observations ${JSON.stringify(observation)}`, async () => {
      const { root, input } = workspace();
      const realStop = CodexRpcClient.prototype.stop;
      vi.spyOn(CodexRpcClient.prototype, 'stop').mockImplementation(async function (this: CodexRpcClient) {
        // Settle the actual fixture first; only the reported observation is
        // injected, so this negative test never deliberately leaks a process.
        const actual = await realStop.call(this);
        expect(actual).toMatchObject({ exited: true, groupAlive: false });
        return { ...actual, ...observation };
      });
      const error = await failedStartup(replayAdapter(codexRejection(root)), input);
      expect(error.code).toBe('thread_start_rejected');
      expect(receiptOf(error).state).not.toBe('process_tree_terminated');
    });

    it(`Claude does not claim termination for incomplete cleanup observations ${JSON.stringify(observation)}`, async () => {
      const { root, input } = workspace();
      const realStop = ClaudeTransport.prototype.stop;
      vi.spyOn(ClaudeTransport.prototype, 'stop').mockImplementation(async function (this: ClaudeTransport) {
        const actual = await realStop.call(this);
        expect(actual).toMatchObject({ exited: true, groupAlive: false });
        return { ...actual, ...observation };
      });
      const adapter = new ClaudeCodeAdapter({ executablePath: process.execPath, extraArgs: [claudeFailure(root, 'reject')], stopTimeoutMs: 100 });
      const error = await failedStartup(adapter, input);
      expect(error.code).toBe('transport_control_error');
      expect(receiptOf(error).state).not.toBe('process_tree_terminated');
    });
  }
});
