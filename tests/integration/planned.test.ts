/**
 * The planned path, end to end against the test runtime.
 *
 * The property that matters here is AT13's: a run of tasks that each passed on
 * their own branch is NOT an accepted run. Acceptance is decided against the
 * combined candidate, by receipts bound to the combined revision — so this
 * test asserts that the combined revision is a revision neither task produced,
 * that both artifacts are in it, and that the acceptance verdicts point at it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { git } from '../../src/workspaces/git.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

/** A scenario that adds one new file and claims success. */
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

describe('the planned path', () => {
  it('runs two dependent tasks, combines their artifacts and checks the COMBINED candidate', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-planned-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    // Each task writes its own file, so the two artifacts are genuinely
    // independent and the combiner has something real to combine.
    const scenarios = new Map<string, string>([
      ['t1', writeScenario(addFileScenario('docs/alpha.md', '# Alpha\n\nThe first deliverable.\n'))],
      ['t2', writeScenario(addFileScenario('docs/beta.md', '# Beta\n\nThe second deliverable, which depends on the first.\n'))],
    ]);
    // Tasks are dispatched in dependency order, so the first session created is
    // t1's and the second is t2's.
    const order = ['t1', 't2'];
    let sessions = 0;

    const result = await runPlanned({
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add an alpha document, then a beta document that refers to it.',
      requestSource: 'test',
      tasks: [
        { key: 't1', objective: 'Add docs/alpha.md.' },
        { key: 't2', objective: 'Add docs/beta.md, which refers to alpha.', dependencies: ['t1'] },
      ],
      // A check that passes on the base, on each candidate and on the combined
      // revision: what is under test here is the combination, not the fixture's
      // own bug.
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      adapterFactory: () => {
        const key = order[Math.min(sessions, order.length - 1)]!;
        sessions += 1;
        return new FakeAdapter({ scenarioPath: scenarios.get(key)! });
      },
    });

    // Both tasks reached acceptance on their own branches.
    expect(result.tasks.map((task) => task.key)).toEqual(['t1', 't2']);
    for (const task of result.tasks) {
      expect(task.accepted, `task ${task.key} should be accepted`).toBe(true);
      expect(task.approved).not.toBeNull();
    }

    // The run was combined, and the combined revision is not either branch's.
    expect(result.combination).not.toBeNull();
    const combination = result.combination!;
    expect(combination.status).toBe('combined');
    if (combination.status !== 'combined') throw new Error('expected a combined result');
    expect(combination.order).toHaveLength(2);
    const branchRevisions = result.tasks.map((task) => task.approved!.snapshot!.candidateRevision);
    expect(branchRevisions).not.toContain(combination.combinedRevision);

    // AT13: the acceptance verdicts are bound to the combined revision, not to
    // the per-task receipts, which are carried only as context.
    expect(combination.acceptance.combinedRevision).toBe(combination.combinedRevision);
    expect(combination.acceptance.accepted).toBe(true);
    expect(combination.acceptance.unverifiedCriteria).toEqual([]);
    for (const receipt of combination.receipts) {
      expect(receipt.outcome).toBe('passed');
    }
    expect(result.accepted).toBe(true);
    expect(result.outcome).toBe('accepted');
    expect(result.runState).toBe('ready_for_review');

    // Both deliverables really are in the combined tree — the combination is a
    // real merge of both artifacts, not one of them relabelled.
    const combinedFiles = await git(['ls-tree', '-r', '--name-only', combination.combinedRevision], { cwd: fixture.path });
    expect(combinedFiles.stdout).toContain('docs/alpha.md');
    expect(combinedFiles.stdout).toContain('docs/beta.md');

    // Neither task's own branch contains the other's file.
    for (const task of result.tasks) {
      const files = await git(['ls-tree', '-r', '--name-only', task.approved!.snapshot!.candidateRevision], { cwd: fixture.path });
      const alpha = files.stdout.includes('docs/alpha.md');
      const beta = files.stdout.includes('docs/beta.md');
      expect(alpha && beta, `task ${task.key} should carry only its own deliverable`).toBe(false);
    }

    // The run is one run with two tasks, and its manifest records the combination.
    const runRow = store.db.prepare('SELECT state FROM runs WHERE id = ?').get(result.runId) as { state: string };
    expect(runRow.state).toBe('ready_for_review');
    const taskCount = store.db.prepare('SELECT count(*) AS n FROM tasks WHERE run_id = ?').get(result.runId) as { n: number };
    expect(taskCount.n).toBe(2);
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { accepted: boolean; combination: { status: string; combinedRevision: string } };
    expect(manifest.accepted).toBe(true);
    expect(manifest.combination.status).toBe('combined');
    expect(manifest.combination.combinedRevision).toBe(combination.combinedRevision);
  }, 120_000);

  it('refuses to integrate when a task never reaches acceptance', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-fail-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-planned-fail-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    // A worker that claims success without changing anything. "Done" is not
    // acceptance: there is no candidate, so there is nothing to integrate.
    const idle = writeScenario({
      scenarioVersion: 1,
      steps: [{ action: 'claim_done', message: 'All finished.' }],
    });

    const result = await runPlanned({
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add two documents.',
      requestSource: 'test',
      tasks: [
        { key: 't1', objective: 'Add docs/alpha.md.' },
        { key: 't2', objective: 'Add docs/beta.md.', dependencies: ['t1'] },
      ],
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      adapterFactory: () => new FakeAdapter({ scenarioPath: idle }),
    });

    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.combination).toBeNull();
    expect(result.reason).toContain('t1');
    // The dependent task never ran, and the result says so rather than
    // reporting it as passed or silently dropping it.
    expect(result.tasks.find((task) => task.key === 't2')?.accepted).toBe(false);
    const runRow = store.db.prepare('SELECT state FROM runs WHERE id = ?').get(result.runId) as { state: string };
    expect(runRow.state).toBe('failed');
  }, 120_000);
});

describe('the planned path refuses a plan it cannot execute', () => {
  async function setup() {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-bad-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-planned-bad-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenario = writeScenario(addFileScenario('docs/x.md', '# X\n'));
    return {
      base: {
        repoPath: fixture.path,
        config: loaded.config,
        configRaw: loaded.raw,
        configPath: loaded.path,
        requestText: 'Do several things.',
        requestSource: 'test',
        checkFlags: ['node --version'],
        paths,
        db: store.db,
        adapterFactory: () => new FakeAdapter({ scenarioPath: scenario }),
      },
    };
  }

  it('refuses a dependency cycle instead of silently dropping the cycled tasks', async () => {
    const { base } = await setup();
    await expect(
      runPlanned({
        ...base,
        tasks: [
          { key: 't1', objective: 'One.', dependencies: ['t2'] },
          { key: 't2', objective: 'Two.', dependencies: ['t1'] },
          { key: 't3', objective: 'Three.' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'dependency_cycle' });
  });

  it('refuses a self-dependency', async () => {
    const { base } = await setup();
    await expect(
      runPlanned({
        ...base,
        tasks: [
          { key: 't1', objective: 'One.' },
          { key: 't2', objective: 'Two.', dependencies: ['t2'] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'self_dependency' });
  });
});

describe('the planned repair loop', () => {
  it('runs repairs as new generations instead of dying on the attempts unique index', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-repair-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-planned-repair-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenario = writeScenario(addFileScenario('docs/repair.md', '# Repair\n'));

    const result = await runPlanned({
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Do two things that cannot pass.',
      requestSource: 'test',
      // A check that always fails, so every attempt goes through repair.
      checkFlags: ['git rev-parse --verify no-such-ref-here'],
      tasks: [
        { key: 't1', objective: 'One.' },
        { key: 't2', objective: 'Two.' },
      ],
      paths,
      db: store.db,
      adapterFactory: () => new FakeAdapter({ scenarioPath: scenario }),
    });

    // The run finished and wrote its manifest rather than dying with a raw
    // SQLite error part-way through.
    expect(result.accepted).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(existsSync(result.manifestPath)).toBe(true);
    // maxRepairAttempts is 2 in the fake config: the original plus two repairs.
    expect(result.tasks[0]?.attempts.length).toBe(3);
    expect(result.tasks[0]?.repairsUsed).toBe(2);

    const generations = store.db
      .prepare('SELECT task_id, generation FROM attempts WHERE run_id = ? ORDER BY task_id, generation')
      .all(result.runId) as Array<{ task_id: string; generation: number }>;
    const byTask = new Map<string, number[]>();
    for (const row of generations) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row.generation]);
    for (const [, values] of byTask) expect(values).toEqual([1, 2, 3]);

    const runRow = store.db.prepare('SELECT state FROM runs WHERE id = ?').get(result.runId) as { state: string };
    expect(runRow.state).toBe('failed');
  });

  it('runs the tasks of one batch at the same time', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-planned-conc-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-planned-conc-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    let live = 0;
    let maxLive = 0;
    const scenarios = [writeScenario(addFileScenario('docs/one.md', '# One\n')), writeScenario(addFileScenario('docs/two.md', '# Two\n'))];
    let made = 0;

    const result = await runPlanned({
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Two independent deliverables.',
      requestSource: 'test',
      checkFlags: ['node --version'],
      tasks: [
        { key: 't1', objective: 'One.' },
        { key: 't2', objective: 'Two.' },
      ],
      paths,
      db: store.db,
      adapterFactory: () => {
        const adapter = new FakeAdapter({ scenarioPath: scenarios[Math.min(made, 1)]! });
        made += 1;
        // Count how many workers are between "turn started" and "turn ended"
        // at the same instant. Serialized execution can never exceed one.
        const events = adapter.events.bind(adapter);
        Object.defineProperty(adapter, 'events', {
          value: (turn: Parameters<typeof events>[0]) => {
            const inner = events(turn);
            return {
              async *[Symbol.asyncIterator]() {
                live += 1;
                maxLive = Math.max(maxLive, live);
                try {
                  // Give the peer a chance to reach its own turn before this
                  // one drains, so the overlap is observable rather than a
                  // race this test happens to win.
                  await new Promise((resolve) => setTimeout(resolve, 400));
                  for await (const event of inner) yield event;
                } finally {
                  live -= 1;
                }
              },
            };
          },
        });
        return adapter;
      },
    });

    expect(result.tasks).toHaveLength(2);
    // maxActiveTurns is 2 in the fake config, so both tasks belong to one
    // batch and both must be in flight at once.
    expect(maxLive).toBeGreaterThan(1);
  });
});
