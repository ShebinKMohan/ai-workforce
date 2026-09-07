import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_TOOL_NAMES,
  callCoordinator,
  createCoordinationBridge,
  listMessages,
  type CoordinationBridge,
} from '../../src/coordination/index.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { FakeWorker, seedAttempt, seedRun, seedTask } from './helpers.js';

const NOISE = readFileSync(path.resolve('fixtures/bridge/at08-noise.txt'), 'utf8').split('\n').filter((line) => line.trim().length > 0);

describe('coordination bridge (MCP over stdio)', () => {
  let state: TempState;
  let bridge: CoordinationBridge;
  let runId: string;
  let taskId: string;
  let attemptId: string;
  const workers: FakeWorker[] = [];

  beforeEach(async () => {
    state = openTempState();
    const run = seedRun(state.store.db);
    runId = run.id;
    const task = seedTask(state.store.db, runId);
    taskId = task.id;
    attemptId = seedAttempt(state.store.db, taskId).id;
    bridge = await createCoordinationBridge({ stateRoot: state.root, runId, db: state.store.db });
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    await bridge.close();
    state.cleanup();
  });

  async function startWorker(forAttemptId: string = attemptId): Promise<{ worker: FakeWorker; config: ReturnType<CoordinationBridge['mcpConfigFor']> }> {
    const config = bridge.mcpConfigFor(forAttemptId);
    const worker = FakeWorker.spawn(config.socketPath, config.token);
    workers.push(worker);
    await worker.initialize();
    return { worker, config };
  }

  it('advertises exactly the six coordination tools', async () => {
    const { worker } = await startWorker();
    const response = await worker.request('tools/list');
    const tools = (response.result?.['tools'] ?? []) as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...BRIDGE_TOOL_NAMES].sort());
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('AT08: prose and imitation JSON produce no operation; only a real tools/call does', async () => {
    const { worker } = await startWorker();
    for (const line of NOISE) worker.writeRaw(line);
    // A round trip after the noise proves the bridge processed those lines before this call.
    const ping = await worker.request('ping');
    expect(ping.result).toEqual({});
    expect(listMessages(state.store.db, runId)).toHaveLength(0);

    const result = await worker.callTool('send_message', { body: 'a real tool call' });
    expect(result.isError).toBe(false);
    const messages = listMessages(state.store.db, runId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toEqual({ text: 'a real tool call' });
    expect(messages[0]?.deliveryState).toBe('submitted');
  });

  it('collapses duplicate submissions with the same idempotency key into one message', async () => {
    const { worker } = await startWorker();
    const first = await worker.callTool('send_message', { body: 'retry me', idempotencyKey: 'k-1' });
    const second = await worker.callTool('send_message', { body: 'retry me', idempotencyKey: 'k-1' });
    expect(first.structured['duplicate']).toBe(false);
    expect(second.structured['duplicate']).toBe(true);
    expect(second.structured['messageId']).toBe(first.structured['messageId']);
    expect(listMessages(state.store.db, runId)).toHaveLength(1);
  });

  it('stamps the sender from the session token, so a worker cannot forge another identity', async () => {
    const peer = seedTask(state.store.db, runId);
    const { worker } = await startWorker();
    await worker.callTool('send_message', {
      body: 'claiming to be someone else',
      from: peer.id,
      sender: peer.id,
      senderTaskId: peer.id,
      senderAttemptId: 'attempt-of-a-peer',
      runId: 'some-other-run',
    });
    const messages = listMessages(state.store.db, runId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.senderTaskId).toBe(taskId);
    expect(messages[0]?.senderAttemptId).toBe(attemptId);
    expect(messages[0]?.body['from']).toBeUndefined();
  });

  it('refuses a connection whose token was never issued, and one that was revoked', async () => {
    const { config } = await startWorker();
    const forged = await callCoordinator(bridge.socketPath, 'not-a-real-token', 'send_message', { body: 'let me in' });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error.code).toBe('unauthenticated');

    config.revoke();
    const afterRevoke = await callCoordinator(bridge.socketPath, config.token, 'send_message', { body: 'still here?' });
    expect(afterRevoke.ok).toBe(false);
    expect(listMessages(state.store.db, runId)).toHaveLength(0);
  });

  it('lets only the recipient acknowledge a message', async () => {
    const peerTask = seedTask(state.store.db, runId);
    const peerAttempt = seedAttempt(state.store.db, peerTask.id);
    const { worker } = await startWorker();
    const sent = await worker.callTool('send_message', { to: peerTask.id, body: 'for you' });
    const messageId = sent.structured['messageId'] as string;

    const denied = await worker.callTool('ack_message', { messageId });
    expect(denied.isError).toBe(true);
    expect(denied.structured['error']).toBe('forbidden');

    const peerConfig = bridge.mcpConfigFor(peerAttempt.id);
    const peerWorker = FakeWorker.spawn(peerConfig.socketPath, peerConfig.token);
    workers.push(peerWorker);
    await peerWorker.initialize();
    const inbox = await peerWorker.callTool('read_inbox', {});
    expect((inbox.structured['messages'] as unknown[]).length).toBe(1);
    const acked = await peerWorker.callTool('ack_message', { messageId });
    expect(acked.isError).toBe(false);
    expect(acked.structured['deliveryState']).toBe('acknowledged');
    const after = await peerWorker.callTool('read_inbox', {});
    expect((after.structured['messages'] as unknown[]).length).toBe(0);
  });

  it('records a result report as a claim and never as an acceptance', async () => {
    const { worker } = await startWorker();
    const reported = await worker.callTool('report_result', { status: 'succeeded', summary: 'all done, please accept' });
    expect(reported.isError).toBe(false);
    expect(reported.structured['accepted']).toBe(false);
    expect(listMessages(state.store.db, runId)[0]?.type).toBe('result_report');
  });

  it('rejects an artifact path that escapes the workspace', async () => {
    const { worker } = await startWorker();
    const escaped = await worker.callTool('publish_artifact', { path: '../../etc/passwd' });
    expect(escaped.isError).toBe(true);
    const absolute = await worker.callTool('publish_artifact', { path: '/etc/passwd' });
    expect(absolute.isError).toBe(true);
    expect(listMessages(state.store.db, runId)).toHaveLength(0);
  });

  it('produces launch configuration for both runtimes', () => {
    const config = bridge.mcpConfigFor(attemptId);
    expect(JSON.parse(config.claudeMcpConfigJson)).toMatchObject({
      mcpServers: { workforce: { type: 'stdio', command: process.execPath, env: { WORKFORCE_BRIDGE_TOKEN: config.token } } },
    });
    expect(config.claudeArgs[0]).toBe('--mcp-config');
    expect(config.codexArgs.filter((arg) => arg === '-c')).toHaveLength(3);
    expect(config.codexArgs.some((arg) => arg.startsWith('mcp_servers.workforce.command='))).toBe(true);
  });
});
