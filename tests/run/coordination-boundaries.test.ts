/**
 * The boundaries at which a worker can still be reached, and the one at which
 * it cannot.
 *
 * A message handed to a session whose turn has ended is handed to nobody: the
 * adapter or the runtime "queues" it for a next turn that this session will
 * never have, because the coordinator stops the process a moment later. Taking
 * that receipt as delivery and acknowledging the message is how a question
 * disappears without a trace — the same class of defect as accepting a result
 * nobody verified.
 *
 * So the last drain on a session accepts only a submission into a live turn.
 * Anything else is recorded as a failed delivery, left undelivered, and ends
 * the run as an explicit expiry with an unresolved fact.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import { recordMessage, submitMessage } from '../../src/coordination/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { runDirect, type RunStream } from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { listEvents } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, fixTheBugScenario, fixedPaginationSource, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

describe('a message that arrives as the turn ends', () => {
  it('is not acknowledged by a session that is about to be stopped; it fails visibly instead', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-boundary-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-boundary-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(fixTheBugScenario());

    const lines: string[] = [];
    let lateMessageId: string | null = null;
    const failures: string[] = [];

    // The turn is over the moment the runtime says so. Recording the message
    // here puts it in the store between the end of the event stream and the
    // coordinator's last delivery attempt: the exact window in which a queued
    // receipt names a turn that will never exist.
    const stream: RunStream = {
      line: (text) => lines.push(text),
      event: (record) => {
        if (record['type'] !== 'runtime.turn_completed' || lateMessageId !== null) return;
        try {
          const run = store.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1').get() as { id: string };
          const task = store.db.prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1').get(run.id) as { id: string };
          const recorded = recordMessage(store.db, {
            sender: { runId: run.id, taskId: null, attemptId: null },
            type: 'peer_message',
            recipientTaskId: task.id,
            body: { text: 'one more thing, before you stop' },
          });
          lateMessageId = submitMessage(store.db, recorded.message.id).id;
        } catch (error) {
          failures.push((error as Error).message);
        }
      },
    };

    const result = await runDirect({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Fix the pagination off-by-one.',
      requestSource: 'test',
      paths,
      db: store.db,
      stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });

    expect(failures).toEqual([]);
    expect(lateMessageId).not.toBeNull();

    const events = listEvents(store.db, result.runId);
    const delivered = events.filter((event) => event.type === 'coordination.delivered' && event.payload['messageId'] === lateMessageId);
    const failed = events.filter((event) => event.type === 'coordination.delivery_failed' && event.payload['messageId'] === lateMessageId);

    // Never reported as delivered, because it was not.
    expect(delivered).toHaveLength(0);
    expect(result.coordination.messagesDelivered).toBe(0);
    // The attempt says the turn had already ended; the run says it expired.
    expect(failed.map((event) => event.payload['code'])).toEqual(['turn_already_ended', 'never_delivered']);

    const row = store.db.prepare('SELECT delivery_state FROM messages WHERE id = ?').get(lateMessageId!) as { delivery_state: string };
    expect(row.delivery_state).toBe('expired');

    // The operator sees both halves: the failed hand-off and the run-level giving up.
    expect(lines.some((line) => line.includes('could not be delivered') && line.includes('turn had already ended'))).toBe(true);
    expect(lines.some((line) => line.includes(`message ${lateMessageId!}`) && line.includes('never reached'))).toBe(true);

    // And the manifest a person reads afterwards carries it.
    expect(result.manifest.unresolved.some((fact) => fact.includes(lateMessageId!) && fact.includes('never delivered'))).toBe(true);

    // None of this changed the verdict on the work itself.
    expect(result.acceptance.accepted).toBe(true);
  }, 180_000);

  it('is delivered into the live turn when it arrives while the worker is still working', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-boundary-live-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-boundary-live-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    // The worker keeps working after its tool call, so the turn is genuinely
    // still open when the coordinator reaches the next safe boundary. Without
    // the pause the fake runtime finishes the whole turn before the
    // coordinator has read its first event, and there is no live turn to
    // deliver into for anyone.
    const scenarioPath = writeScenario({
      scenarioVersion: 1,
      steps: [
        { action: 'message', text: 'Reading the pagination helpers.' },
        { action: 'edit_file', path: 'src/pagination.js', content: fixedPaginationSource() },
        { action: 'sleep', ms: 1_500 },
        { action: 'claim_done', message: 'Fixed both off-by-one errors.' },
      ],
    });

    const lines: string[] = [];
    let liveMessageId: string | null = null;
    const failures: string[] = [];

    // Mid-turn: the worker has called a tool and the turn is still open.
    const stream: RunStream = {
      line: (text) => lines.push(text),
      event: (record) => {
        if (record['type'] !== 'runtime.tool_call' || liveMessageId !== null) return;
        try {
          const run = store.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1').get() as { id: string };
          const task = store.db.prepare('SELECT id FROM tasks WHERE run_id = ? ORDER BY created_at LIMIT 1').get(run.id) as { id: string };
          const recorded = recordMessage(store.db, {
            sender: { runId: run.id, taskId: null, attemptId: null },
            type: 'peer_message',
            recipientTaskId: task.id,
            body: { text: 'the codename is meadow' },
          });
          liveMessageId = submitMessage(store.db, recorded.message.id).id;
        } catch (error) {
          failures.push((error as Error).message);
        }
      },
    };

    const result = await runDirect({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Fix the pagination off-by-one.',
      requestSource: 'test',
      paths,
      db: store.db,
      stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });

    expect(failures).toEqual([]);
    expect(liveMessageId).not.toBeNull();

    const delivered = listEvents(store.db, result.runId).filter(
      (event) => event.type === 'coordination.delivered' && event.payload['messageId'] === liveMessageId,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload['state']).toBe('submitted_to_active_turn');
    expect(result.coordination.messagesDelivered).toBe(1);

    const row = store.db.prepare('SELECT delivery_state FROM messages WHERE id = ?').get(liveMessageId!) as { delivery_state: string };
    expect(row.delivery_state).toBe('acknowledged');
    // Delivered means delivered: nothing about it is reported as unresolved.
    expect(result.manifest.unresolved.some((fact) => fact.includes(liveMessageId!))).toBe(false);
    expect(lines.some((line) => line.includes('delivered a message to this worker (submitted_to_active_turn'))).toBe(true);
  }, 180_000);
});
