import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_INBOX_LIMIT,
  MessageTransitionError,
  acknowledge,
  deliverableFor,
  expireMessage,
  expireUndelivered,
  listMessages,
  listSentBy,
  pendingDeliveries,
  recordMessage,
  rejectMessage,
  submitMessage,
} from '../../src/coordination/index.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { seedAttempt, seedRun, seedTask } from './helpers.js';

describe('coordination message store', () => {
  let state: TempState;

  beforeEach(() => {
    state = openTempState();
  });
  afterEach(() => state.cleanup());

  function fixture() {
    const run = seedRun(state.store.db);
    const sender = seedTask(state.store.db, run.id);
    const recipient = seedTask(state.store.db, run.id);
    const attempt = seedAttempt(state.store.db, sender.id);
    return { run, sender, recipient, attempt, db: state.store.db };
  }

  it('moves recorded -> submitted -> acknowledged and stamps the times', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const { message } = recordMessage(db, {
      sender: { runId: run.id, taskId: sender.id, attemptId: attempt.id },
      type: 'peer_message',
      recipientTaskId: recipient.id,
      body: { text: 'hello' },
    });
    expect(message.deliveryState).toBe('recorded');
    expect(message.submittedAt).toBeNull();
    const submitted = submitMessage(db, message.id);
    expect(submitted.deliveryState).toBe('submitted');
    expect(submitted.submittedAt).not.toBeNull();
    const acked = acknowledge(db, message.id);
    expect(acked.deliveryState).toBe('acknowledged');
    expect(acked.acknowledgedAt).not.toBeNull();
    // Acknowledging twice is a no-op, so a retrying worker does not fail.
    expect(acknowledge(db, message.id).deliveryState).toBe('acknowledged');
  });

  it('refuses an illegal delivery transition', () => {
    const { run, sender, attempt, db } = fixture();
    const { message } = recordMessage(db, {
      sender: { runId: run.id, taskId: sender.id, attemptId: attempt.id },
      type: 'peer_message',
      body: { text: 'x' },
    });
    rejectMessage(db, message.id);
    expect(() => submitMessage(db, message.id)).toThrow(MessageTransitionError);
    expect(() => acknowledge(db, message.id)).toThrow(MessageTransitionError);
  });

  it('supports expired as a terminal outcome', () => {
    const { run, sender, attempt, db } = fixture();
    const { message } = recordMessage(db, {
      sender: { runId: run.id, taskId: sender.id, attemptId: attempt.id },
      type: 'peer_message',
      body: { text: 'x' },
    });
    submitMessage(db, message.id);
    expect(expireMessage(db, message.id).deliveryState).toBe('expired');
  });

  it('treats one idempotency key as one logical message, whatever the body says', () => {
    const { run, sender, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const first = recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'one' }, idempotencyKey: 'same' });
    const second = recordMessage(db, { sender: senderIdentity, type: 'result_report', body: { text: 'different body' }, idempotencyKey: 'same' });
    expect(second.duplicate).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.body).toEqual({ text: 'one' });
    expect(listMessages(db, run.id)).toHaveLength(1);
  });

  it('collapses an identical resubmission even when no key is supplied', () => {
    // AT08 clause 2: a worker that retries without volunteering a key must not
    // produce two messages. The key is derived from the message's own content,
    // so the same message twice is one message.
    const { run, sender, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const first = recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'a' } });
    const second = recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'a' } });
    expect(second.duplicate).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(listMessages(db, run.id)).toHaveLength(1);
  });

  it('keeps genuinely different messages apart when no key is supplied', () => {
    const { run, sender, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'a' } });
    recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'b' } });
    expect(listMessages(db, run.id)).toHaveLength(2);
  });

  it('does not let one sender squat another sender\'s idempotency key', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const attacker = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const victim = { runId: run.id, taskId: recipient.id, attemptId: null };
    const first = recordMessage(db, { sender: attacker, type: 'peer_message', body: { text: 'attacker note' }, idempotencyKey: 'shared-key-7' });
    const second = recordMessage(db, { sender: victim, type: 'peer_message', body: { text: 'the build is broken, stop' }, idempotencyKey: 'shared-key-7' });
    expect(second.duplicate).toBe(false);
    expect(second.message.id).not.toBe(first.message.id);
    expect(second.message.senderTaskId).toBe(recipient.id);
    expect(second.message.idempotencyKey).toBe('shared-key-7');
    expect(listMessages(db, run.id)).toHaveLength(2);
  });

  it('bounds the inbox no matter what limit is asked for', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    for (let i = 0; i < MAX_INBOX_LIMIT + 25; i += 1) {
      const { message } = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { i } });
      submitMessage(db, message.id);
    }
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id })).toHaveLength(20);
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id, limit: 10_000 })).toHaveLength(MAX_INBOX_LIMIT);
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id, limit: Number.NaN })).toHaveLength(20);
  });

  it('reports what is still in flight without the inbox cap, and only for real recipients', () => {
    // The inbox cap protects a worker from a flood. The coordinator's own
    // "is anything still undelivered?" question must not be capped, or the
    // cap becomes the silent loss it exists to prevent.
    const { run, sender, recipient, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    for (let i = 0; i < MAX_INBOX_LIMIT + 5; i += 1) {
      const { message } = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { i } });
      submitMessage(db, message.id);
    }
    // A report to the coordinator has already reached its recipient by being recorded.
    recordMessage(db, { sender: senderIdentity, type: 'result_report', recipientTaskId: null, body: { text: 'claim' } });
    expect(pendingDeliveries(db, run.id)).toHaveLength(MAX_INBOX_LIMIT + 5);
    expect(pendingDeliveries(db, run.id, { recipientTaskId: recipient.id })).toHaveLength(MAX_INBOX_LIMIT + 5);
    expect(pendingDeliveries(db, run.id, { recipientTaskId: sender.id })).toHaveLength(0);
  });

  it('gives up on undelivered messages explicitly, and leaves resolved ones alone', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const arrived = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { text: 'read' } }).message;
    const stranded = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { text: 'never read' } }).message;
    acknowledge(db, submitMessage(db, arrived.id).id);
    submitMessage(db, stranded.id);

    const expired = expireUndelivered(db, run.id);
    expect(expired.map((message) => message.id)).toEqual([stranded.id]);
    expect(listMessages(db, run.id).find((message) => message.id === stranded.id)?.deliveryState).toBe('expired');
    // A delivered message is history, not something to retroactively fail.
    expect(listMessages(db, run.id).find((message) => message.id === arrived.id)?.deliveryState).toBe('acknowledged');
    // Sweeping twice changes nothing: everything is already terminal.
    expect(expireUndelivered(db, run.id)).toHaveLength(0);
  });

  it('lets a sender see its own messages and what became of them', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const mine = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { text: 'my question' } }).message;
    recordMessage(db, { sender: { runId: run.id, taskId: recipient.id, attemptId: null }, type: 'peer_message', recipientTaskId: sender.id, body: { text: 'not mine' } });
    submitMessage(db, mine.id);

    const sent = listSentBy(db, run.id, sender.id);
    expect(sent.map((message) => message.id)).toEqual([mine.id]);
    expect(sent[0]?.deliveryState).toBe('submitted');
    expireUndelivered(db, run.id, { recipientTaskId: recipient.id });
    expect(listSentBy(db, run.id, sender.id)[0]?.deliveryState).toBe('expired');
  });

  it('excludes acknowledged messages and messages addressed elsewhere', () => {
    const { run, sender, recipient, attempt, db } = fixture();
    const other = seedTask(db, run.id);
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    const mine = recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: recipient.id, body: { text: 'mine' } }).message;
    recordMessage(db, { sender: senderIdentity, type: 'peer_message', recipientTaskId: other.id, body: { text: 'theirs' } });
    recordMessage(db, { sender: senderIdentity, type: 'result_report', recipientTaskId: null, body: { text: 'coordinator' } });
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id })).toHaveLength(1);
    acknowledge(db, submitMessage(db, mine.id).id);
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id })).toHaveLength(0);
    expect(deliverableFor(db, { runId: run.id, recipientTaskId: recipient.id, includeAcknowledged: true })).toHaveLength(1);
  });
});
