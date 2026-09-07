import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_INBOX_LIMIT,
  MessageTransitionError,
  acknowledge,
  deliverableFor,
  expireMessage,
  listMessages,
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

  it('gives distinct messages distinct auto keys when none is supplied', () => {
    const { run, sender, attempt, db } = fixture();
    const senderIdentity = { runId: run.id, taskId: sender.id, attemptId: attempt.id };
    recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'a' } });
    recordMessage(db, { sender: senderIdentity, type: 'peer_message', body: { text: 'a' } });
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
