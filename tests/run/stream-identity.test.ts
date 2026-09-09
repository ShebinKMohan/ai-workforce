/**
 * Run output has an identity.
 *
 * Before this, every concurrently dispatched task of a planned run shared ONE
 * `RunStream`. N workers wrote into one flat stream and nothing in a line or a
 * record said which worker produced it, so the only way to route a line was to
 * read its prose. These tests hold the two properties that fix has to have:
 *
 * 1. two tasks that are live at the same time produce lines and events that
 *    are told apart by `taskId` and `agentId` — without reading the text;
 * 2. a direct run's human output is byte for byte what it was, because the
 *    identity travels in the record and the plain renderer shows it only once
 *    more than one task has been live at the same time.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter, defaultFakeRuntimeScript } from '../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { runDirect, type RunStream, type RunStreamIdentity } from '../../src/core/run-direct.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { createRunStream } from '../../src/cli/commands/run.js';
import { Reporter, type Streams } from '../../src/cli/output.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { redactText } from '../../src/telemetry/redaction.js';
import { cleanupAll, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

const ESC = '\u001B';
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (text: string): string => text.replace(ANSI, '');

interface Capture {
  /** The stream handed to the run: the real CLI renderer, with every call recorded on the way through. */
  readonly stream: RunStream;
  /** Every human line, with the identity it arrived with. Index-aligned with the rendered stdout/stderr lines. */
  readonly lines: Array<{ text: string; identity: RunStreamIdentity }>;
  readonly events: Array<Record<string, unknown>>;
  readonly lifecycle: Array<{ kind: 'open' | 'close'; identity: RunStreamIdentity }>;
  stdout(): string;
  stderr(): string;
}

/**
 * The real renderer under test, wrapped so the test can see both what reached
 * it and what it wrote. Nothing is simulated: `createRunStream` is the object
 * the `run` command builds.
 */
function capture(json: boolean): Capture {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const streams: Streams = { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) };
  const inner = createRunStream(new Reporter(json, streams), streams);

  const lines: Array<{ text: string; identity: RunStreamIdentity }> = [];
  const events: Array<Record<string, unknown>> = [];
  const lifecycle: Array<{ kind: 'open' | 'close'; identity: RunStreamIdentity }> = [];

  const stream: RunStream = {
    line: (text) => {
      lines.push({ text, identity: {} });
      inner.line(text);
    },
    writeLine: (text, identity) => {
      lines.push({ text, identity });
      inner.writeLine!(text, identity);
    },
    openTask: (identity) => {
      lifecycle.push({ kind: 'open', identity });
      inner.openTask!(identity);
    },
    closeTask: (identity) => {
      lifecycle.push({ kind: 'close', identity });
      inner.closeTask!(identity);
    },
    event: (record) => {
      events.push(record);
      inner.event(record);
    },
  };

  return { stream, lines, events, lifecycle, stdout: () => stdout, stderr: () => stderr };
}

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

/** Two agents on the test runtime, so the two tasks of a plan carry different agent ids. */
function writeTwoAgentConfig(dir: string): string {
  const file = path.join(dir, 'agents.json');
  const agent = (id: string) => ({
    id,
    runtime: 'fake-local',
    instructions: 'Do the task and submit evidence against the criteria.',
    capabilities: ['coding', 'testing'],
    policy: 'local-development',
  });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtimes: { 'fake-local': { adapter: 'fake', executable: defaultFakeRuntimeScript() } },
        defaults: {
          workerAgent: 'engineer-alpha',
          maxActiveTurns: 2,
          maxActiveWriters: 2,
          maxTasksPerRun: 8,
          maxDelegationDepth: 2,
          maxRepairAttempts: 0,
          maxTransientRetries: 2,
          runTimeoutMinutes: 30,
        },
        agents: [agent('engineer-alpha'), agent('engineer-beta')],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

describe('run output carries the identity of the task that produced it', () => {
  it('tells two concurrently dispatched tasks apart by taskId and agentId, without reading the prose', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-identity-'), 'state');
    const loaded = loadAgentConfigFile(writeTwoAgentConfig(tempDir('workforce-identity-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    const scenarios = new Map<string, string>([
      ['alpha', writeScenario(addFileScenario('docs/alpha.md', '# Alpha\n'))],
      ['beta', writeScenario(addFileScenario('docs/beta.md', '# Beta\n'))],
    ]);

    const recorder = capture(false);
    // Neither task depends on the other and both writer slots are free, so the
    // scheduler dispatches them in the same round and they are genuinely in
    // flight together. The adapter for each is chosen by the task id the
    // coordinator minted, not by the order sessions happen to open.
    const taskKeys = new Map<string, string>();
    const stream: RunStream = {
      ...recorder.stream,
      openTask: (identity) => {
        if (identity.taskId !== undefined && identity.key !== undefined) taskKeys.set(identity.taskId, identity.key);
        recorder.stream.openTask!(identity);
      },
    };

    const result = await runPlanned({
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Add an alpha document and a beta document.',
      requestSource: 'test',
      tasks: [
        { key: 'alpha', objective: 'Add docs/alpha.md.', agentId: 'engineer-alpha' },
        { key: 'beta', objective: 'Add docs/beta.md.', agentId: 'engineer-beta' },
      ],
      checkFlags: ['node --version'],
      paths,
      db: store.db,
      stream,
      adapterFactory: (_runtime, context) => new FakeAdapter({ scenarioPath: scenarios.get(taskKeys.get(context.taskId) ?? 'alpha')! }),
    });

    expect(result.tasks.map((task) => task.key).sort()).toEqual(['alpha', 'beta']);

    // The two tasks really were live at the same time: the second opened
    // before the first closed. Without that this test would prove nothing
    // about interleaved output.
    const opens = recorder.lifecycle.filter((entry) => entry.kind === 'open');
    const firstClose = recorder.lifecycle.findIndex((entry) => entry.kind === 'close');
    const secondOpen = recorder.lifecycle.indexOf(opens[1]!);
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(secondOpen).toBeLessThan(firstClose);

    // Every task line arrived with an identity, and the identity alone is
    // enough to route it: two task ids, two agent ids, two plan keys.
    const taskLines = recorder.lines.filter((entry) => entry.identity.taskId !== undefined);
    expect(taskLines.length).toBeGreaterThan(10);
    const byKey = new Map<string, Set<string>>();
    for (const entry of taskLines) {
      expect(entry.identity.key).toBeDefined();
      expect(entry.identity.agentId).toBeDefined();
      const set = byKey.get(entry.identity.key!) ?? new Set<string>();
      set.add(`${entry.identity.taskId}|${entry.identity.agentId}`);
      byKey.set(entry.identity.key!, set);
    }
    expect([...byKey.keys()].sort()).toEqual(['alpha', 'beta']);
    // One task id and one agent id per key, and the two keys share neither.
    expect([...byKey.get('alpha')!]).toHaveLength(1);
    expect([...byKey.get('beta')!]).toHaveLength(1);
    expect([...byKey.get('alpha')!][0]).not.toBe([...byKey.get('beta')!][0]);
    expect([...byKey.get('alpha')!][0]).toContain('engineer-alpha');
    expect([...byKey.get('beta')!][0]).toContain('engineer-beta');

    // The same is true of the event records, which is what --json emits.
    const created = recorder.events.filter((record) => record['type'] === 'run.created' && record['taskId'] !== undefined);
    expect(created).toHaveLength(2);
    for (const record of created) {
      expect(typeof record['taskId']).toBe('string');
      expect(typeof record['attemptId']).toBe('string');
      expect(typeof record['runtimeId']).toBe('string');
      expect(record['adapter']).toBe('fake');
      expect(['alpha', 'beta']).toContain(record['key']);
    }
    expect(new Set(created.map((record) => record['agentId']))).toEqual(new Set(['engineer-alpha', 'engineer-beta']));
    // Per-task check results are attributable too — the record that says a
    // criterion passed names the task it passed for.
    const checks = recorder.events.filter((record) => record['type'] === 'check.completed');
    expect(checks.length).toBeGreaterThan(0);
    for (const record of checks) expect(['alpha', 'beta']).toContain(record['key']);

    // And the human rendering shows it, because more than one task was live.
    const rendered = strip(recorder.stdout()).split('\n');
    expect(rendered.some((line) => line.startsWith('[alpha] '))).toBe(true);
    expect(rendered.some((line) => line.startsWith('[beta] '))).toBe(true);
    // Run-level lines stay unlabelled: they belong to no task.
    expect(rendered.some((line) => line.startsWith('run ') && !line.startsWith('['))).toBe(true);
  }, 180_000);

  it('leaves a direct run\'s human output byte for byte unchanged', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-identity-direct-'), 'state');
    const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-identity-direct-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(addFileScenario('docs/only.md', '# Only\n'));

    const recorder = capture(false);
    const result = await runDirect({
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
      stream: recorder.stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });
    expect(result.outcome).toBe('accepted');

    // The run's single task did stamp its identity on the lines it wrote —
    // otherwise the next assertion would be vacuous.
    const identified = recorder.lines.filter((entry) => entry.identity.taskId === result.taskId);
    expect(identified.length).toBeGreaterThan(5);
    expect(identified.every((entry) => entry.identity.agentId === 'engineer' && entry.identity.adapter === 'fake')).toBe(true);

    // And the renderer wrote exactly the text it was given, redacted, one line
    // each — no label, no escape code, nothing added or reordered. That is the
    // old rendering, byte for byte.
    const expected = recorder.lines.map((entry) => `${redactText(entry.text)}\n`).join('');
    expect(recorder.stdout()).toBe(expected);
    expect(recorder.stdout()).not.toContain(ESC);
    expect(recorder.stderr()).toBe('');
  }, 120_000);

  it('keeps --json stdout pure JSONL and puts the identity in the records', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-identity-json-'), 'state');
    const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir('workforce-identity-json-config-')));
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(addFileScenario('docs/only.md', '# Only\n'));

    const recorder = capture(true);
    const result = await runDirect({
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
      stream: recorder.stream,
      adapterFactory: () => new FakeAdapter({ scenarioPath }),
    });

    // Every byte on stdout is a JSON object; the human lines went to stderr.
    const stdoutLines = recorder.stdout().split('\n').filter((line) => line.length > 0);
    expect(stdoutLines.length).toBeGreaterThan(0);
    const records = stdoutLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(recorder.stdout()).not.toContain(ESC);
    expect(recorder.stderr().length).toBeGreaterThan(0);

    const created = records.find((record) => record['type'] === 'run.created')!;
    expect(created['taskId']).toBe(result.taskId);
    expect(created['attemptId']).toBe(result.attemptId);
    expect(created['agentId']).toBe('engineer');
    expect(created['adapter']).toBe('fake');
    expect(created['runtimeId']).toBe('fake-local');
    // A record that already names a field keeps its own value: identity is
    // added under the record, never over it.
    expect(created['runId']).toBe(result.runId);
    // Records emitted after the identity was known all carry the task.
    for (const record of records.filter((entry) => String(entry['type']).startsWith('check.'))) {
      expect(record['taskId']).toBe(result.taskId);
      expect(record['agentId']).toBe('engineer');
    }
  }, 120_000);
});
