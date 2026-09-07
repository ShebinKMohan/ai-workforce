import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRpcClient, CodexRpcError, CodexTransportError, denyServerRequest } from '../../../src/adapters/codex/rpc.js';
import { SERVER_REQUEST, decodeFrame } from '../../../src/adapters/codex/protocol.js';
import { isProcessAlive, isProcessGroupAlive } from '../../../src/core/process.js';
import { FAKE_APP_SERVER, writeTranscript } from './helpers.js';

const roots: string[] = [];
const clients: CodexRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-rpc-'));
  roots.push(root);
  return root;
}

function client(transcript: string, extraArgs: ReadonlyArray<string> = [], options: Partial<ConstructorParameters<typeof CodexRpcClient>[0]> = {}): CodexRpcClient {
  const created = new CodexRpcClient({
    executablePath: process.execPath,
    args: [FAKE_APP_SERVER, '--transcript', transcript, ...extraArgs],
    cwd: os.tmpdir(),
    requestTimeoutMs: 5_000,
    stopTimeoutMs: 3_000,
    ...options,
  });
  clients.push(created);
  return created;
}

const out = (obj: unknown) => ({ dir: 'out', line: JSON.stringify(obj) });
const inn = (obj: unknown) => ({ dir: 'in', line: JSON.stringify(obj) });

describe('codex json-rpc transport', () => {
  it('correlates responses, buffers partial lines and keeps unknown fields', async () => {
    const root = tempRoot();
    // A long payload written in 7-byte chunks guarantees every frame is split across several stdout chunks.
    const transcript = writeTranscript(root, 'framing.jsonl', [
      out({ id: 1, method: 'initialize' }),
      inn({ id: 1, result: { userAgent: 'fake', unknownField: { nested: 'x'.repeat(400) } } }),
      out({ method: 'initialized' }),
      inn({ method: 'thread/started', params: { thread: { id: 'thread-1' }, futureField: 'y'.repeat(300) }, emittedAtMs: 1 }),
      out({ id: 2, method: 'model/list' }),
      inn({ id: 2, result: { data: [{ id: 'model-a', extra: true }] } }),
    ]);
    const rpc = client(transcript, ['--chunk', '7']);
    rpc.start();

    const initialize = (await rpc.initialize('workforce', '0.1.0')) as Record<string, unknown>;
    expect(initialize['userAgent']).toBe('fake');
    expect((initialize['unknownField'] as Record<string, string>)['nested']).toHaveLength(400);

    const models = (await rpc.request('model/list', {})) as { data: Array<{ id: string }> };
    expect(models.data[0]!.id).toBe('model-a');

    const notification = await rpc.waitForNotification((n) => n.method === 'thread/started', 5_000);
    expect(notification).not.toBeNull();
    expect((notification!.params as { futureField: string }).futureField).toHaveLength(300);
    expect(notification!.sequence).toBe(1);
    expect(rpc.undecodableFrames).toHaveLength(0);
  });

  it('surfaces a json-rpc error as CodexRpcError without killing the connection', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'error.jsonl', [
      out({ id: 1, method: 'initialize' }),
      inn({ id: 1, result: {} }),
      out({ method: 'initialized' }),
      out({ id: 2, method: 'turn/interrupt' }),
      inn({ id: 2, error: { code: -32600, message: 'no active turn to interrupt' } }),
      out({ id: 3, method: 'model/list' }),
      inn({ id: 3, result: { data: [] } }),
    ]);
    const rpc = client(transcript);
    rpc.start();
    await rpc.initialize('workforce', '0.1.0');

    await expect(rpc.request('turn/interrupt', {})).rejects.toBeInstanceOf(CodexRpcError);
    // The connection survives a rejected request.
    await expect(rpc.request('model/list', {})).resolves.toEqual({ data: [] });
  });

  it('times out a request that is never answered and keeps the process usable', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'silent.jsonl', [out({ id: 1, method: 'initialize' }), inn({ id: 1, result: {} }), out({ method: 'initialized' }), out({ id: 2, method: 'model/list' })]);
    const rpc = client(transcript);
    rpc.start();
    await rpc.initialize('workforce', '0.1.0');

    const started = Date.now();
    await expect(rpc.request('model/list', {}, 300)).rejects.toMatchObject({ name: 'CodexTransportError', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(rpc.exited).toBeNull();
  });

  it('denies every server -> client escalation and never approves one', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'approvals.jsonl', [
      out({ id: 1, method: 'initialize' }),
      inn({ id: 1, result: {} }),
      out({ method: 'initialized' }),
      inn({ id: 'a1', method: SERVER_REQUEST.commandExecutionApproval, params: { command: 'rm -rf /' } }),
      out({ id: 'a1', result: {} }),
      inn({ id: 'a2', method: SERVER_REQUEST.fileChangeApproval, params: { grantRoot: '/etc' } }),
      out({ id: 'a2', result: {} }),
      inn({ id: 'a3', method: SERVER_REQUEST.chatgptAuthTokensRefresh, params: {} }),
      out({ id: 'a3', result: {} }),
      inn({ method: 'thread/started', params: { thread: { id: 't' } } }),
    ]);
    // A policy that tries to approve is discarded: only refusals reach the wire.
    const rpc = client(transcript, [], { serverRequestPolicy: () => ({ result: { decision: 'accept' }, denied: false, reason: 'a misconfigured policy trying to approve' }) });
    rpc.start();
    await rpc.initialize('workforce', '0.1.0');
    await rpc.waitForNotification((n) => n.method === 'thread/started', 5_000);

    const answered = rpc.serverRequests;
    expect(answered.map((r) => r.method)).toEqual([SERVER_REQUEST.commandExecutionApproval, SERVER_REQUEST.fileChangeApproval, SERVER_REQUEST.chatgptAuthTokensRefresh]);
    expect(answered.every((r) => r.decision.denied)).toBe(true);
    expect(answered[0]!.decision.result).toEqual({ decision: 'decline' });
    expect(answered[1]!.decision.result).toEqual({ decision: 'decline' });
    // A credential request is answered with a json-rpc error, never with data.
    expect(answered[2]!.decision.result).toBeNull();
  });

  it('keeps an undecodable frame as evidence instead of crashing', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'garbage.jsonl', [
      out({ id: 1, method: 'initialize' }),
      { dir: 'in', line: '{ this is not json' },
      { dir: 'in', line: '"a bare string frame"' },
      inn({ id: 1, result: {} }),
      out({ method: 'initialized' }),
      inn({ method: 'thread/started', params: { thread: { id: 't' } } }),
    ]);
    const rpc = client(transcript);
    rpc.start();
    await expect(rpc.initialize('workforce', '0.1.0')).resolves.toEqual({});
    const notification = await rpc.waitForNotification((n) => n.method === 'thread/started', 5_000);
    expect(notification).not.toBeNull();
    expect(rpc.undecodableFrames.map((f) => f.reason)).toEqual(['invalid json', 'not a json-rpc frame']);
  });

  it('shuts down cleanly by closing stdin, and escalates to SIGKILL when the server ignores SIGTERM', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'shutdown.jsonl', [out({ id: 1, method: 'initialize' }), inn({ id: 1, result: {} }), out({ method: 'initialized' })]);

    const polite = client(transcript);
    const politeIdentity = polite.start();
    await polite.initialize('workforce', '0.1.0');
    const politeStop = await polite.stop();
    expect(politeStop.exited).toBe(true);
    expect(politeStop.signalled).toBeNull();
    expect(isProcessAlive(politeIdentity.pid)).toBe(false);

    const stubborn = client(transcript, ['--hang']);
    const stubbornIdentity = stubborn.start();
    await stubborn.initialize('workforce', '0.1.0');
    const stubbornStop = await stubborn.stop();
    expect(stubbornStop.exited).toBe(true);
    expect(stubbornStop.signalled).toBe('SIGKILL');
    expect(stubbornStop.groupAlive).toBe(false);
    expect(isProcessGroupAlive(stubbornIdentity.pid)).toBe(false);
  });

  it('ends the notification stream when the server exits so consumers cannot hang', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'exit.jsonl', [
      out({ id: 1, method: 'initialize' }),
      inn({ id: 1, result: {} }),
      out({ method: 'initialized' }),
      inn({ method: 'thread/started', params: { thread: { id: 't' } } }),
    ]);
    const rpc = client(transcript, ['--exit-after', '2']);
    rpc.start();
    await rpc.initialize('workforce', '0.1.0');

    const seen: string[] = [];
    for await (const notification of rpc.notifications(0, 200)) seen.push(notification.method);
    expect(seen).toEqual(['thread/started']);
    expect(rpc.exited).not.toBeNull();
  });

  it('decodes each json-rpc frame shape the installed server sends, including frames without a jsonrpc member', () => {
    expect(decodeFrame(JSON.stringify({ id: 1, result: { ok: true } }))).toMatchObject({ kind: 'response', id: 1 });
    expect(decodeFrame(JSON.stringify({ id: 1, error: { code: -1, message: 'no' } }))).toMatchObject({ kind: 'error', id: 1 });
    expect(decodeFrame(JSON.stringify({ method: 'turn/started', params: {}, emittedAtMs: 5 }))).toMatchObject({ kind: 'notification', method: 'turn/started' });
    expect(decodeFrame(JSON.stringify({ id: 'a', method: 'item/tool/call', params: {} }))).toMatchObject({ kind: 'server_request', method: 'item/tool/call' });
    expect(decodeFrame('nonsense')).toMatchObject({ kind: 'undecodable' });
  });

  it('has a refusal for every server -> client request the protocol defines', () => {
    for (const method of Object.values(SERVER_REQUEST)) {
      const decision = denyServerRequest(method);
      expect(decision.denied).toBe(true);
      expect(decision.reason.length).toBeGreaterThan(0);
      const asJson = JSON.stringify(decision.result ?? {});
      expect(asJson).not.toContain('"accept"');
      expect(asJson).not.toContain('"approved"');
    }
  });
});

describe('the replay fixture answers every client frame, however they are chunked', () => {
  /**
   * `initialize` -> `initialized` -> `model/list` is the real client's opening
   * sequence, and the last two routinely land in one stdin chunk. The fixture
   * used to advance its transcript cursor outside the write chain, so the
   * second frame skipped its own `out` record and its response was never
   * emitted — a real client then waited for a reply that could not come.
   */
  it('answers two requests that arrive in a single stdin write', async () => {
    const root = tempRoot();
    const transcript = writeTranscript(root, 'batched.jsonl', [
      out({ id: 1, method: 'initialize' }),
      inn({ id: 1, result: { userAgent: 'fake' } }),
      out({ method: 'initialized' }),
      inn({ method: 'thread/started', params: { thread: { id: 'thread-1' } } }),
      out({ id: 2, method: 'model/list' }),
      inn({ id: 2, result: { data: [{ id: 'model-a' }] } }),
    ]);

    const server = spawn(process.execPath, [FAKE_APP_SERVER, '--transcript', transcript], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    try {
      const frames: Array<Record<string, unknown>> = [];
      let buffer = '';
      server.stdout.setEncoding('utf8');
      server.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) frames.push(JSON.parse(line) as Record<string, unknown>);
          newline = buffer.indexOf('\n');
        }
      });

      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      await waitForFrames(frames, 1);
      // Both in one write: this is what makes the ordering matter.
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })}\n`,
      );
      await waitForFrames(frames, 3);

      expect(frames.map((frame) => frame['id'] ?? frame['method'])).toEqual([1, 'thread/started', 2]);
      expect(frames[2]!['result']).toEqual({ data: [{ id: 'model-a' }] });
    } finally {
      server.kill('SIGKILL');
      await new Promise((resolve) => server.once('exit', resolve));
    }
  });
});

async function waitForFrames(frames: ReadonlyArray<unknown>, count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (frames.length < count) throw new Error(`the replay fixture emitted ${frames.length} frame(s); expected at least ${count} within ${timeoutMs}ms`);
}
