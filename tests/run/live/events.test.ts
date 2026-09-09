/**
 * The three events the board is not allowed to live without.
 *
 * Each of these exists because the alternative was for the view to *infer*
 * something and then present the inference as fact:
 *
 * - `task.settled` — without it a lane's terminal state would be guessed from
 *   a closed stream plus a trailing check receipt. A runtime saying "done"
 *   never marks a task accepted (AGENTS.md rule 3), and neither does a stream
 *   that stopped.
 * - `checks.planned` — the criteria list lived only in the database operation
 *   intent, so the checks strip read `--` for most of a run.
 * - `schedule.blocked` — `scheduler.blockers` was read only at the end, so a
 *   queued row could not honestly say what it was waiting for.
 *
 * These tests pin them against the real coordinator, so a future refactor that
 * stops emitting one cannot silently blank the board.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../../src/core/config.js';
import { runDirect, type RunStream } from '../../../src/core/run-direct.js';
import { runPlanned } from '../../../src/core/run-planned.js';
import { openStateStore } from '../../../src/storage/db.js';
import { createStatePaths } from '../../../src/storage/paths.js';
import { listEvents } from '../../../src/storage/events.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../../workspaces/support.js';

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

/** A stream that records every event record, and nothing else. */
function recorder(): { stream: RunStream; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    stream: {
      line: () => {},
      event: (record) => {
        events.push(record);
      },
    },
  };
}

describe('the events the live view depends on', () => {
  it('states every task\'s terminal outcome, rather than leaving it to be inferred', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-settled-'), 'state');
    const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-settled-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(addFileScenario('docs/one.md', '# One\n'));

    const capture = recorder();
    const result = await runPlanned({
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add two documents.',
      requestSource: 'test',
      // `beta` depends on `alpha`, so the second dispatch round has something
      // to report as blocked.
      tasks: [
        { key: 'alpha', objective: 'Add docs/one.md.' },
        { key: 'beta', objective: 'Add docs/two.md.', dependencies: ['alpha'] },
      ],
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      stream: capture.stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });

    const settled = capture.events.filter((record) => record['type'] === 'task.settled');
    expect(settled.map((record) => record['key']).sort()).toEqual(['alpha', 'beta']);
    for (const record of settled) {
      expect(typeof record['taskId']).toBe('string');
      expect(typeof record['accepted']).toBe('boolean');
      expect(typeof record['repairsUsed']).toBe('number');
    }
    // The settlement agrees with the run's own result, which is the whole
    // point: the board and the manifest cannot disagree about acceptance.
    for (const task of result.tasks) {
      expect(settled.find((record) => record['key'] === task.key)!['accepted']).toBe(task.accepted);
    }

    // A dependent task says what it is waiting for, from the scheduler.
    const blocked = capture.events.filter((record) => record['type'] === 'schedule.blocked');
    expect(blocked.length).toBeGreaterThan(0);
    const entries = blocked.flatMap((record) => record['blocked'] as Array<Record<string, unknown>>);
    const beta = entries.find((entry) => entry['key'] === 'beta');
    expect(beta).toBeDefined();
    expect(beta!['waitingOn']).toEqual(['alpha']);
    expect(beta!['reason']).toBe('dependency');

    // And the plan key is durable, so a second terminal can say `--task beta`.
    const registered = listEvents(store.db, result.runId).filter((row) => row.type === 'task.registered');
    expect(registered.map((row) => row.payload['key']).sort()).toEqual(['alpha', 'beta']);
    for (const row of registered) expect(row.taskId).toEqual(expect.any(String));
  }, 180_000);

  it('names the criteria before the first check runs, so the checks strip is not blank for most of the run', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-checks-'), 'state');
    const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-planned-checks-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(addFileScenario('docs/only.md', '# Only\n'));

    const capture = recorder();
    await runDirect({
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add docs/only.md.',
      requestSource: 'test',
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      stream: capture.stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });

    const planned = capture.events.find((record) => record['type'] === 'checks.planned');
    expect(planned).toBeDefined();
    const criterionIds = planned!['criterionIds'] as string[];
    expect(criterionIds.length).toBeGreaterThan(0);

    // Every criterion the run announced is one the verifier then reported on:
    // the strip lists real work, not a wish list.
    const completed = capture.events.filter((record) => record['type'] === 'check.completed').map((record) => record['criterionId']);
    for (const id of criterionIds) expect(completed).toContain(id);
    // And it was announced first.
    expect(capture.events.indexOf(planned!)).toBeLessThan(capture.events.findIndex((record) => record['type'] === 'check.completed'));
  }, 120_000);
});
