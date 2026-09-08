/**
 * A message is delivered or it fails. It is never lost quietly.
 *
 * The hole this covers: `send_message` accepted anything addressed to a task
 * in the run, recorded it `submitted`, told the sender it was sent — and then,
 * if that task's worker had already finished, nobody ever read it. It stayed
 * `submitted` for ever, no event was written, and the run's evidence said
 * nothing. With two genuinely concurrent workers that is the common case, and
 * it is why AT05 failed three real-runtime runs in a row.
 *
 * Everything here goes through the real bridge over a real unix socket, driven
 * by a child process speaking MCP over stdio, because the defect was in what a
 * worker is told rather than in an internal helper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCoordinationBridge,
  listMessages,
  pendingDeliveries,
  type CoordinationBridge,
  type CoordinationNotice,
} from '../../src/coordination/index.js';
import { listEvents } from '../../src/storage/events.js';
import { transitionTask } from '../../src/storage/records.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { FakeWorker, seedAttempt, seedRun, seedTask } from './helpers.js';

describe('the life of a coordination message', () => {
  let state: TempState;
  let bridge: CoordinationBridge;
  let runId: string;
  let senderTaskId: string;
  let senderAttemptId: string;
  let peerTaskId: string;
  const notices: CoordinationNotice[] = [];
  const workers: FakeWorker[] = [];

  beforeEach(async () => {
    state = openTempState();
    notices.length = 0;
    const run = seedRun(state.store.db);
    runId = run.id;
    const sender = seedTask(state.store.db, runId);
    senderTaskId = sender.id;
    senderAttemptId = seedAttempt(state.store.db, senderTaskId).id;
    peerTaskId = seedTask(state.store.db, runId).id;
    bridge = await createCoordinationBridge({
      stateRoot: state.root,
      runId,
      db: state.store.db,
      onNotice: (notice) => notices.push(notice),
    });
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    await bridge.close();
    state.cleanup();
  });

  async function startSender(): Promise<FakeWorker> {
    const config = bridge.mcpConfigFor(senderAttemptId);
    const worker = FakeWorker.spawn(config.socketPath, config.token);
    workers.push(worker);
    await worker.initialize();
    return worker;
  }

  /** Drive the peer task to a terminal state the way a finished run does. */
  function finishPeer(): void {
    transitionTask(state.store.db, peerTaskId, 'ready');
    transitionTask(state.store.db, peerTaskId, 'running');
    transitionTask(state.store.db, peerTaskId, 'validating');
    transitionTask(state.store.db, peerTaskId, 'accepted');
  }

  it('refuses a message to a task that has already finished, and says why', async () => {
    finishPeer();
    const worker = await startSender();
    const result = await worker.callTool('send_message', { to: peerTaskId, body: 'What codename did you pick?' });

    expect(result.isError).toBe(true);
    expect(result.structured['error']).toBe('recipient_finished');
    // The sender is told what to do about it, not just that something failed.
    expect(String(result.structured['message'])).toContain('has already finished');
    expect(String(result.structured['message'])).toContain('do not wait for an answer');
  });

  it('keeps the refused message as evidence in a terminal state, never as "submitted"', async () => {
    finishPeer();
    const worker = await startSender();
    await worker.callTool('send_message', { to: peerTaskId, body: 'What codename did you pick?' });

    const messages = listMessages(state.store.db, runId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deliveryState).toBe('rejected');
    expect(messages[0]?.recipientTaskId).toBe(peerTaskId);
    expect(messages[0]?.body['code']).toBe('recipient_finished');
    // Nothing is left looking like it is still on its way.
    expect(pendingDeliveries(state.store.db, runId)).toHaveLength(0);
  });

  it('makes the refusal visible: an event and a notice the operator can be shown', async () => {
    finishPeer();
    const worker = await startSender();
    await worker.callTool('send_message', { to: peerTaskId, body: 'anyone there?' });

    const failures = listEvents(state.store.db, runId).filter((event) => event.type === 'coordination.delivery_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload['code']).toBe('recipient_finished');
    expect(failures[0]?.payload['recipientTaskId']).toBe(peerTaskId);

    expect(notices).toHaveLength(1);
    expect(notices[0]?.code).toBe('recipient_finished');
    expect(notices[0]?.recipientTaskId).toBe(peerTaskId);
    expect(notices[0]?.senderTaskId).toBe(senderTaskId);
  });

  it('accepts a message for a live recipient and wakes that session at once', async () => {
    const woken: string[] = [];
    const close = bridge.openReceiver(peerTaskId, (message) => woken.push(message.id));
    try {
      transitionTask(state.store.db, peerTaskId, 'ready');
      transitionTask(state.store.db, peerTaskId, 'running');
      const worker = await startSender();
      const result = await worker.callTool('send_message', { to: peerTaskId, body: 'a question mid-turn' });

      expect(result.isError).toBe(false);
      expect(result.structured['deliverable']).toBe(true);
      expect(result.structured['recipientState']).toBe('receiving');
      expect(woken).toEqual([result.structured['messageId']]);
    } finally {
      close();
    }
  });

  it('accepts a message for a task that has not started, because its prompt will carry it', async () => {
    const worker = await startSender();
    const result = await worker.callTool('send_message', { to: peerTaskId, body: 'read this before you start' });
    expect(result.isError).toBe(false);
    expect(result.structured['deliverable']).toBe(true);
    expect(result.structured['recipientState']).toBe('not_started');
    expect(bridge.deliverableFor(peerTaskId)).toHaveLength(1);
  });

  it('tells the sender when nothing is holding the message, instead of implying delivery', async () => {
    // The recipient has run and has no session now: only a further attempt of
    // that task could ever deliver this, and the sender is told so.
    transitionTask(state.store.db, peerTaskId, 'ready');
    transitionTask(state.store.db, peerTaskId, 'running');
    const worker = await startSender();
    const result = await worker.callTool('send_message', { to: peerTaskId, body: 'is anyone holding this?' });

    expect(result.isError).toBe(false);
    expect(result.structured['deliverable']).toBe(false);
    expect(result.structured['recipientState']).toBe('no_active_session');
    expect(String(result.structured['note'])).toContain('undelivered at the end of the run');
  });

  it('a closed receiver stops the coordinator claiming the task can be reached', async () => {
    transitionTask(state.store.db, peerTaskId, 'ready');
    transitionTask(state.store.db, peerTaskId, 'running');
    const close = bridge.openReceiver(peerTaskId, () => undefined);
    const worker = await startSender();
    const live = await worker.callTool('send_message', { to: peerTaskId, body: 'while the session is up' });
    expect(live.structured['recipientState']).toBe('receiving');

    close();
    const afterClose = await worker.callTool('send_message', { to: peerTaskId, body: 'after the session is gone' });
    expect(afterClose.structured['recipientState']).toBe('no_active_session');
    expect(afterClose.structured['deliverable']).toBe(false);
  });

  it('lets a sender read what became of its own messages', async () => {
    const worker = await startSender();
    const sent = await worker.callTool('send_message', { to: peerTaskId, body: 'did you get this?' });
    const messageId = sent.structured['messageId'] as string;

    const before = await worker.callTool('read_inbox', {});
    const stillGoing = (before.structured['sent'] as Array<Record<string, unknown>>).find((entry) => entry['messageId'] === messageId);
    expect(stillGoing?.['failed']).toBe(false);
    expect(before.structured['undeliveredCount']).toBe(0);

    // The run ends without that message ever arriving.
    expect(bridge.expireUndelivered()).toHaveLength(1);

    const after = await worker.callTool('read_inbox', {});
    const failed = (after.structured['sent'] as Array<Record<string, unknown>>).find((entry) => entry['messageId'] === messageId);
    expect(failed?.['deliveryState']).toBe('expired');
    expect(failed?.['failed']).toBe(true);
    expect(after.structured['undeliveredCount']).toBe(1);
    expect(String(after.structured['note'])).toContain('never reached their recipient');
  });

  it('a message to the coordinator is never treated as undeliverable', async () => {
    const worker = await startSender();
    await worker.callTool('send_message', { body: 'for the coordinator' });
    await worker.callTool('report_result', { status: 'blocked', summary: 'stuck' });
    // Both reached their recipient by being recorded; sweeping peer traffic
    // must not retroactively call them failures.
    expect(bridge.expireUndelivered()).toHaveLength(0);
    expect(listMessages(state.store.db, runId).every((message) => message.deliveryState === 'submitted')).toBe(true);
  });
});
