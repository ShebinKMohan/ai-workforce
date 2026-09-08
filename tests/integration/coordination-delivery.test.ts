/**
 * What a planned run does with a message that never arrives.
 *
 * The failure this pins is the one that made AT05 fail three real-runtime runs
 * in a row: a worker asked a peer a question after that peer had finished, the
 * coordinator accepted it, recorded it `submitted`, and then nobody delivered
 * it and nobody failed it. The run's evidence said nothing at all.
 *
 * So the run has to end in one of two states for every message: delivered, or
 * explicitly failed and visible — in the message row, in the event log, on the
 * operator's screen and in the run's unresolved facts.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import { recipientPosture, recordMessage, submitMessage } from '../../src/coordination/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { type RunStream } from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { listEvents } from '../../src/storage/events.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

function addFileScenario(file: string, content: string): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: `Adding ${file}.` },
      { action: 'edit_file', path: file, content },
      { action: 'claim_done', message: `Added ${file}.` },
    ],
  };
}

describe('a planned run and a message that never arrives', () => {
  it('expires it, records it, prints it and carries it into the run\'s unresolved facts', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-coord-delivery-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-coord-delivery-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    const scenarios = ['t1', 't2'].map((key) => writeScenario(addFileScenario(`docs/${key}.md`, `# ${key}\n\nWritten by ${key}.\n`)));
    const lines: string[] = [];
    let runId: string | null = null;
    let recipientTaskId: string | null = null;
    let senderTaskId: string | null = null;
    let strandedMessageId: string | null = null;
    let sessions = 0;
    const askFailures: string[] = [];

    // The second worker session of the run is t2's, and by then t1 is over.
    // Asking t1 something at that moment is exactly the shape of the defect.
    const askTheFinishedPeer = (): void => {
      try {
        const run = store.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1').get() as { id: string };
        runId = run.id;
        const tasks = store.db.prepare('SELECT id, state FROM tasks WHERE run_id = ? ORDER BY created_at').all(run.id) as Array<{ id: string; state: string }>;
        recipientTaskId = tasks[0]!.id;
        senderTaskId = tasks[1]!.id;
        // The peer really is over: a live coordinator refuses this send
        // outright, which is the other half of the fix.
        expect(tasks[0]!.state).toBe('accepted');
        expect(recipientPosture(store.db, run.id, recipientTaskId).kind).toBe('finished');
        const recorded = recordMessage(store.db, {
          sender: { runId: run.id, taskId: senderTaskId, attemptId: null },
          type: 'peer_message',
          recipientTaskId,
          body: { text: 'Which codename did you use?' },
        });
        strandedMessageId = submitMessage(store.db, recorded.message.id).id;
      } catch (error) {
        askFailures.push((error as Error).message);
      }
    };

    const stream: RunStream = {
      line: (text) => lines.push(text),
      event: (record) => {
        if (record['type'] !== 'session.opened') return;
        sessions += 1;
        if (sessions === 2) askTheFinishedPeer();
      },
    };

    const result = await runPlanned({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Two documents, the second after the first.',
      requestSource: 'test',
      // t2 depends on t1, so by the time t2 has a worker t1 is over: exactly
      // the shape in which a question to t1 can never be answered.
      tasks: [
        { key: 't1', objective: 'Add docs/t1.md.' },
        { key: 't2', objective: 'Add docs/t2.md.', dependencies: ['t1'] },
      ],
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath: scenarios[Math.min(sessions, scenarios.length - 1)]! }),
    });

    expect(askFailures).toEqual([]);
    expect(runId).not.toBeNull();
    expect(strandedMessageId).not.toBeNull();

    // 1. The message row is terminal. It does not sit at "submitted" pretending
    //    to still be on its way.
    const row = store.db.prepare('SELECT delivery_state FROM messages WHERE id = ?').get(strandedMessageId!) as { delivery_state: string };
    expect(row.delivery_state).toBe('expired');

    // 2. The event log says it failed, and names both ends.
    const failures = listEvents(store.db, runId!).filter((event) => event.type === 'coordination.delivery_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload['messageId']).toBe(strandedMessageId);
    expect(failures[0]?.payload['code']).toBe('never_delivered');
    expect(failures[0]?.payload['recipientTaskId']).toBe(recipientTaskId);

    // 3. The operator saw it while the run was going.
    expect(lines.some((line) => line.includes(`message ${strandedMessageId!}`) && line.includes('never reached'))).toBe(true);

    // 4. The run carries it as an unresolved fact, so the manifest a person
    //    reads afterwards says the question was never answered.
    expect(result.unresolved.some((fact) => fact.includes(strandedMessageId!) && fact.includes('never delivered'))).toBe(true);
  }, 180_000);
});
