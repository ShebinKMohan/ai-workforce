/**
 * `workforce watch` — the supported form of "one agent, one terminal".
 *
 * Two properties matter and both are here:
 *
 * 1. **It takes no ownership.** It attaches while a mutating coordinator holds
 *    the state root, reads, and leaves the lock untouched. A reader that took
 *    the lock could create duplicate execution, which is the one thing an
 *    observer must never do.
 * 2. **It re-derives the run's own lines.** `--task <key>` shows that lane's
 *    events, in `sequence` order, rendered through the same
 *    `renderRuntimeEvent` the run's terminal used — not a second, drifting
 *    rendering of the same facts.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import { commandWatch, rowToLiveEvent } from '../../src/cli/commands/watch.js';
import { Reporter, type Streams } from '../../src/cli/output.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

function scenario(file: string): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: `Adding ${file}.` },
      { action: 'edit_file', path: file, content: `# ${file}\n` },
      { action: 'claim_done', message: `Added ${file}.` },
    ],
  };
}

function pipes(): Streams & { stdoutText(): string; stderrText(): string } {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      isTTY: false,
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return {
    stdout: sink((chunk) => (stdout += chunk)),
    stderr: sink((chunk) => (stderr += chunk)),
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

/** A finished two-task run on disk, plus the still-open mutating store that produced it. */
async function twoTaskRun(prefix: string) {
  const fixture = await useFixture('ts-bug');
  const stateDir = path.join(tempDir(prefix), 'state');
  const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir(`${prefix}config-`)));
  const paths = createStatePaths(stateDir);
  const store = openStateStore(paths, { mode: 'mutating' });
  registerCleanup(() => store.close());
  const scenarioPath = writeScenario(scenario('docs/one.md'));

  const result = await runPlanned({
    allowUnconfinedWrites: true,
    repoPath: fixture.path,
    config: loaded.config,
    configRaw: loaded.raw,
    configPath: loaded.path,
    requestText: 'Add two documents.',
    requestSource: 'test',
    tasks: [
      { key: 'alpha', objective: 'Add docs/one.md.' },
      { key: 'beta', objective: 'Add docs/two.md.' },
    ],
    checkFlags: ['node --version'],
    paths,
    db: store.db,
    stream: { line: () => {}, event: () => {} },
    adapterFactory: () => new FakeAdapter({ scenarioPath }),
  });
  return { result, paths, stateDir, store };
}

describe('workforce watch', () => {
  it('attaches to a run while a mutating coordinator holds the state root, and takes no lock', async () => {
    const { result, stateDir, store } = await twoTaskRun('workforce-watch-');
    // The mutating store is still open and still holds `coordinator.lock`.
    expect(store.lock).not.toBeNull();

    const streams = pipes();
    const outcome = await commandWatch(
      { positionals: [result.runId], stateDir, json: false },
      { reporter: new Reporter(false, streams), streams, maxIdlePolls: 0, sleep: async () => {} },
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.data['runId']).toBe(result.runId);
    // Still held by the coordinator that took it: the reader never touched it.
    expect(store.lock!.path).toContain('coordinator.lock');

    const tasks = outcome.data['tasks'] as Array<Record<string, unknown>>;
    expect(tasks.map((task) => task['key']).sort()).toEqual(['alpha', 'beta']);
  }, 180_000);

  it('shows only the named lane under --task, and names it by the plan key a human wrote', async () => {
    const { result, stateDir } = await twoTaskRun('workforce-watch-task-');

    const streams = pipes();
    const outcome = await commandWatch(
      { positionals: [result.runId], stateDir, task: 'alpha', json: false },
      { reporter: new Reporter(false, streams), streams, maxIdlePolls: 0, sleep: async () => {} },
    );

    expect(outcome.exitCode).toBe(0);
    const text = streams.stdoutText();
    // The run's own lines, re-derived from the database rather than a second
    // rendering: this is what `renderRuntimeEvent` prints for a fake turn.
    expect(text).toContain('turn started');
    // And the summary names the lane the way the plan did.
    expect((outcome.data['tasks'] as Array<Record<string, unknown>>).some((task) => task['key'] === 'alpha')).toBe(true);

    // One lane, not two. The same run without `--task` prints strictly more,
    // because both workers ran the same scenario and produced the same lines.
    const both = pipes();
    await commandWatch(
      { positionals: [result.runId], stateDir, json: false },
      { reporter: new Reporter(false, both), streams: both, maxIdlePolls: 0, sleep: async () => {} },
    );
    const oneLane = text.split('\n').filter((line) => line.length > 0).length;
    const allLanes = both.stdoutText().split('\n').filter((line) => line.length > 0).length;
    expect(oneLane).toBeGreaterThan(0);
    expect(oneLane).toBeLessThan(allLanes);
  }, 180_000);

  it('emits one JSON object per event row under --json, in sequence order, with nothing else on stdout', async () => {
    const { result, stateDir } = await twoTaskRun('workforce-watch-json-');

    const streams = pipes();
    await commandWatch(
      { positionals: [result.runId], stateDir, json: true },
      { reporter: new Reporter(true, streams), streams, maxIdlePolls: 0, sleep: async () => {} },
    );

    const lines = streams.stdoutText().split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(5);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const sequences = records.map((record) => record['sequence'] as number);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    // The JSONL contract: not one escape byte on stdout.
    expect(streams.stdoutText()).not.toContain('\u001B');
  }, 180_000);

  it('refuses an unknown run id as invalid input, not as an execution failure', async () => {
    const { stateDir } = await twoTaskRun('workforce-watch-unknown-');
    const streams = pipes();
    await expect(
      commandWatch(
        { positionals: ['no-such-run'], stateDir, json: false },
        { reporter: new Reporter(false, streams), streams, maxIdlePolls: 0, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ exitCode: 2, code: 'unknown_run' });
  }, 180_000);
});

/**
 * `watch` is the *second* place a run's lines are rendered, and the one that
 * can be re-run at any time on any terminal. A stray escape sequence stored in
 * an event row is therefore not a one-off: it is a replayable one, so the
 * guarantee has to hold here too, from the database row inward.
 */
describe('what watch does with an event row it did not write', () => {
  const ESC = '\u001B';
  const BEL = '\u0007';

  it('strips every escape out of a persisted runtime row and never treats its words as evidence', () => {
    const row = {
      sequence: 1,
      runId: 'run-1',
      taskId: 'task-1',
      attemptId: null,
      type: 'runtime.assistant_message',
      timestamp: new Date(1_700_000_000_000).toISOString(),
      payload: { text: `${ESC}[?1049l${ESC}[2J acceptance criterion unit: passed (exit 0) ${ESC}]0;t${BEL}` },
    };
    const event = rowToLiveEvent(row as never, new Map([['task-1', 'api']]), (value) => value);

    expect(event.line).toBeDefined();
    expect(event.line).not.toContain(ESC);
    expect(event.line).not.toContain(BEL);
    expect(event.line).toContain('acceptance criterion unit: passed');
    // And it is the runtime talking, so no renderer may award it a mark.
    expect(event.origin).toBe('runtime');
  });
});
