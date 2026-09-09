/**
 * The interactive launcher: what it works out for itself, what it insists on
 * asking, and what it refuses to start.
 *
 * These are behaviour tests. Every one of them drives a whole session — the
 * questions in order, the answers a person would give — and asserts on what
 * the session then did: the arguments handed to the run, the file written to
 * disk, the exit code, the checkout left alone.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { runCli } from '../../src/cli/index.js';
import { commandLaunch, agentUnavailable, configSearchPath, defaultAgentConfig, describeRuntime, equivalentCommand } from '../../src/cli/commands/launch.js';
import type { RunCommandArgs } from '../../src/cli/commands/run.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult, type Streams } from '../../src/cli/output.js';
import { createReadlinePrompter, type Choice, type Prompter } from '../../src/cli/prompt.js';
import { validateAgentConfig } from '../../src/core/contracts.js';
import { discoverRuntimes, type RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { gitOrThrow, gitText } from '../../src/workspaces/git.js';
import { fakeClaude, fakeCodex, writeExecutable } from '../discovery/helpers.js';
import { cleanupAll, fingerprintCheckout, fixTheBugScenario, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

// ---------------------------------------------------------------------------
// A scripted person at the terminal
// ---------------------------------------------------------------------------

interface ScriptedPrompter extends Prompter {
  /** Everything the launcher said, in order. */
  readonly transcript: string[];
  /** Every question it asked, in order. */
  readonly questions: string[];
  readonly unanswered: () => number;
}

function scriptedPrompter(answers: ReadonlyArray<string>): ScriptedPrompter {
  const queue = [...answers];
  const transcript: string[] = [];
  const questions: string[] = [];
  const next = (question: string): string => {
    questions.push(question);
    if (queue.length === 0) throw new Error(`the script ran out of answers at "${question}"`);
    return queue.shift()!;
  };
  return {
    transcript,
    questions,
    unanswered: () => queue.length,
    say: (line = '') => void transcript.push(line),
    note: (line) => void transcript.push(line),
    heading: (line) => void transcript.push(line),
    async ask(question, options = {}) {
      const answer = next(question);
      if (answer.length > 0) return answer;
      if (options.defaultValue !== undefined) return options.defaultValue;
      return '';
    },
    async choose(question, choices: ReadonlyArray<Choice>, options = {}) {
      for (const choice of choices) transcript.push(`${choice.label}  ${choice.unavailable ?? choice.detail ?? ''}`);
      const answer = next(question);
      if (answer.length === 0 && options.defaultValue !== undefined) return options.defaultValue;
      const picked = /^[0-9]+$/.test(answer) ? choices[Number(answer) - 1] : choices.find((choice) => choice.value === answer);
      if (picked === undefined) throw new Error(`the script answered "${answer}", which is not one of ${choices.map((c) => c.value).join(', ')}`);
      if (picked.unavailable !== undefined) throw new Error(`the script picked the unavailable choice "${answer}"`);
      return picked.value;
    },
    async confirm(question, fallback) {
      const answer = next(question).toLowerCase();
      if (answer.length === 0) return fallback;
      return answer === 'y' || answer === 'yes';
    },
    async suspend(action) {
      return action();
    },
    close: () => undefined,
  };
}

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly streams: Streams;
}

function capture(): Captured {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): NodeJS.WritableStream =>
    ({
      write(chunk: string | Uint8Array) {
        append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  return { stdout: () => stdout, stderr: () => stderr, streams: { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) } };
}

/** Real discovery over real (fake) executables, so the reports are the ones `doctor` would produce. */
async function discover(installed: { codex?: 'in' | 'out'; claude?: 'in' | 'out' }): Promise<ReadonlyArray<RuntimeReadinessReport>> {
  const bin = tempDir('workforce-launch-bin-');
  if (installed.codex !== undefined) writeExecutable(bin, 'codex', fakeCodex({ login: installed.codex }));
  if (installed.claude !== undefined) writeExecutable(bin, 'claude', fakeClaude({ auth: installed.claude === 'in' ? 'json-in' : 'json-out' }));
  return discoverRuntimes({ pathValue: bin, knownLocations: [], homeDir: tempDir('workforce-launch-home-') });
}

/** A committed repository with nothing that could be mistaken for an acceptance suite. */
async function repositoryWithoutChecks(): Promise<string> {
  const dir = tempDir('workforce-launch-plain-repo-');
  writeFileSync(path.join(dir, 'README.md'), 'A repository with no tests at all.\n');
  const identity = { name: 'launcher test', email: 'test@workforce.invalid' } as const;
  const base = { cwd: dir, identity } as const;
  await gitOrThrow(['init', '--quiet', '--initial-branch=main'], base);
  await gitOrThrow(['config', 'user.name', identity.name], base);
  await gitOrThrow(['config', 'user.email', identity.email], base);
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], base);
  await gitOrThrow(['add', '-A'], base);
  await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', 'initial'], base);
  await gitText(['rev-parse', 'HEAD'], { cwd: dir });
  return dir;
}

function useScenario(): void {
  const scenarioPath = writeScenario(fixTheBugScenario());
  const previous = process.env[FAKE_SCENARIO_ENV];
  process.env[FAKE_SCENARIO_ENV] = scenarioPath;
  registerCleanup(() => {
    if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
    else process.env[FAKE_SCENARIO_ENV] = previous;
  });
}

/** A run seam that records what the launcher assembled instead of dispatching a runtime. */
function recordingRun(): { calls: RunCommandArgs[]; run: (args: RunCommandArgs) => Promise<CommandResult> } {
  const calls: RunCommandArgs[] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return { command: 'run', exitCode: EXIT_CODES.verifiedCandidate, data: { runId: 'run-test' }, lines: ['run run-test: accepted'] };
    },
  };
}

async function launch(options: {
  answers: ReadonlyArray<string>;
  cwd: string;
  stateDir: string;
  agents?: string;
  task?: string;
  agent?: string;
  checks?: ReadonlyArray<string>;
  allowUnconfinedWrites?: boolean;
  installed?: { codex?: 'in' | 'out'; claude?: 'in' | 'out' };
  homeDir?: string;
  run?: (args: RunCommandArgs) => Promise<CommandResult>;
  env?: Record<string, string | undefined>;
}): Promise<{ code: number; error: CliError | null; prompter: ScriptedPrompter; captured: Captured; result: CommandResult | null }> {
  const captured = capture();
  const prompter = scriptedPrompter(options.answers);
  const reporter = new Reporter(false, captured.streams);
  try {
    const result = await commandLaunch(
      {
        json: false,
        stateDir: options.stateDir,
        ...(options.agents !== undefined ? { agents: options.agents } : {}),
        ...(options.task !== undefined ? { task: options.task } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.checks !== undefined ? { checks: options.checks } : {}),
        ...(options.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
      },
      {
        reporter,
        streams: captured.streams,
        prompter,
        cwd: options.cwd,
        homeDir: options.homeDir ?? tempDir('workforce-launch-home-'),
        env: options.env ?? {},
        discover: () => discover(options.installed ?? {}),
        ...(options.run !== undefined ? { run: options.run } : {}),
      },
    );
    return { code: result.exitCode, error: null, prompter, captured, result };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { code: error.exitCode, error, prompter, captured, result: null };
  }
}

// ---------------------------------------------------------------------------

describe('the real prompter, driven the way a person drives it', () => {
  it('asks on stderr, keeps stdout for the run alone, and assembles the same run', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    // Answers are typed only once a question has actually been written, which
    // is what makes this a test of the questions and their order.
    const answers = ['y', 'y', 'Fix the pagination off-by-one.', 'y'];
    const input = new PassThrough();
    let index = 0;
    let stdout = '';
    let stderr = '';
    const sink = (append: (chunk: string) => void, onPrompt?: () => void): NodeJS.WritableStream =>
      ({
        write(chunk: string | Uint8Array) {
          const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          append(value);
          if (value.endsWith(': ')) onPrompt?.();
          return true;
        },
      }) as unknown as NodeJS.WritableStream;
    const streams: Streams = {
      stdout: sink((c) => (stdout += c)),
      stderr: sink(
        (c) => (stderr += c),
        () => {
          if (index >= answers.length) {
            setImmediate(() => input.end());
            return;
          }
          const answer = answers[index]!;
          index += 1;
          setImmediate(() => input.write(`${answer}\n`));
        },
      ),
    };

    const result = await commandLaunch(
      { json: false, stateDir: path.join(tempDir('workforce-launch-'), 'state'), agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')) },
      {
        reporter: new Reporter(false, streams),
        streams,
        prompter: createReadlinePrompter({ input, output: streams.stderr, env: { NO_COLOR: '1' } }),
        cwd: fixture.path,
        homeDir: tempDir('workforce-launch-home-'),
        env: {},
        discover: async () => [],
        run: recorder.run,
      },
    );

    expect(result.exitCode).toBe(EXIT_CODES.verifiedCandidate);
    expect(index).toBe(answers.length);
    expect(stderr).toContain('use these checks?');
    expect(stderr).toContain('what should the agent do?');
    expect(stderr).toContain('start this run?');
    // Every question went to stderr. stdout is the run's, and in --json mode
    // it is a machine contract; the questions must have no way of reaching it.
    expect(stdout).not.toContain('what should the agent do?');
    expect(stdout).not.toContain('?');
    expect(recorder.calls[0]?.task).toBe('Fix the pagination off-by-one.');
    expect(recorder.calls[0]?.allowUnconfinedWrites).toBe(true);
  });
});

describe('the interactive launcher runs a job without a single flag', () => {
  it('defaults the repository, shows the checks, and dispatches the run it described', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-launch-'), 'state');
    const agents = writeFakeAgentsConfig(tempDir('workforce-launch-config-'));
    useScenario();
    const before = await fingerprintCheckout(fixture.path);

    const session = await launch({
      // checks? y · unconfined writes? y · the task · start? y
      answers: ['y', 'y', 'Fix the pagination off-by-one.', 'y'],
      cwd: fixture.path,
      stateDir,
      agents,
    });

    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    const transcript = session.prompter.transcript.join('\n');
    // The repository was stated, not asked about.
    expect(session.prompter.questions.join('\n')).not.toMatch(/which repository/);
    expect(transcript).toContain(fixture.path);
    // The acceptance check was shown before the run, by its criterion id and
    // the exact argv the verifier will execute.
    expect(transcript).toContain('node-tests-pass: node --test test/');
    // And the flag form was taught, not hidden.
    expect(transcript).toMatch(/workforce run --repo .* --agents .* --task/);

    // The verdict is the verifier's, against the frozen candidate.
    expect(session.result?.lines.join('\n')).toContain('PASS node-tests-pass');
    expect(session.result?.data['accepted']).toBe(true);
    const stdout = session.captured.stdout();
    expect(stdout).toContain('accepted');
    // Not one question reached stdout: --json is a contract about that stream.
    expect(stdout).not.toContain('what should the agent do?');

    const after = await fingerprintCheckout(fixture.path);
    expect(after.tree).toBe(before.tree);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
  });

  it('asks for a repository when the working directory is not one, and gives up honestly', async () => {
    const empty = tempDir('workforce-launch-empty-');
    const session = await launch({
      answers: [empty, empty, empty],
      cwd: empty,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
    });
    expect(session.code).toBe(EXIT_CODES.invalidInput);
    expect(session.error?.code).toBe('invalid_repo');
    expect(session.prompter.questions.filter((q) => /which repository/.test(q))).toHaveLength(3);
    expect(session.prompter.transcript.join('\n')).toContain('is not inside a Git repository');
  });
});

describe('it finds or writes the agent configuration rather than demanding a path', () => {
  it('writes a default configuration for the runtimes that are actually installed, in the state root', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-launch-'), 'state');
    const recorder = recordingRun();

    const session = await launch({
      // write the config? y · which agent · checks? y · task · start? y
      answers: ['y', 'engineer', 'y', 'Fix the off-by-one.', 'y'],
      cwd: fixture.path,
      stateDir,
      installed: { codex: 'in' },
      run: recorder.run,
    });

    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    const written = path.join(stateDir, 'agents.json');
    expect(existsSync(written)).toBe(true);
    // It is loadable by the same validator every other entry point uses.
    const config = validateAgentConfig(JSON.parse(readFileSync(written, 'utf8')));
    expect(Object.values(config.runtimes).map((runtime) => runtime.adapter)).toEqual(['codex']);
    expect(config.agents.map((agent) => agent.id)).toEqual(['engineer', 'architect']);
    // Nothing was written into the user's repository.
    expect(existsSync(path.join(fixture.path, '.workforce', 'agents.json'))).toBe(false);
    // And the run was pointed at the file it just wrote.
    expect(recorder.calls[0]?.agents).toBe(written);
    expect(session.prompter.transcript.join('\n')).toContain(written);
  });

  it('prefers a configuration it found over writing one, and says where it came from', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-launch-'), 'state');
    mkdirSync(stateDir, { recursive: true });
    const existing = writeFakeAgentsConfig(stateDir);
    expect(existing).toBe(path.join(stateDir, 'agents.json'));
    const recorder = recordingRun();

    const session = await launch({
      answers: ['y', 'y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir,
      installed: { codex: 'in' },
      run: recorder.run,
    });

    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(recorder.calls[0]?.agents).toBe(existing);
    expect(session.prompter.questions.join('\n')).not.toMatch(/write .*agents\.json/);
  });

  it('refuses with exit 3 when no installed runtime could back a configuration', async () => {
    const fixture = await useFixture('ts-bug');
    const session = await launch({
      answers: [],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      installed: {},
    });
    expect(session.code).toBe(EXIT_CODES.userActionRequired);
    expect(session.error?.code).toBe('no_usable_runtime');
  });
});

describe('a signed-out runtime is named, with the command that fixes it', () => {
  it('marks the agent unavailable and exits 3 when nothing else can take the work', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-launch-'), 'state');
    mkdirSync(stateDir, { recursive: true });
    // An agent bound to Claude Code, which the discovery below reports as signed out.
    writeFileSync(
      path.join(stateDir, 'agents.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runtimes: { 'claude-local': { adapter: 'claude-code', executable: 'claude' } },
        defaults: {
          workerAgent: 'engineer',
          maxActiveTurns: 2,
          maxActiveWriters: 2,
          maxTasksPerRun: 8,
          maxDelegationDepth: 2,
          maxRepairAttempts: 2,
          maxTransientRetries: 2,
          runTimeoutMinutes: 30,
        },
        agents: [{ id: 'engineer', runtime: 'claude-local', instructions: 'Fix it.', capabilities: ['coding'], policy: 'local-development' }],
      })}\n`,
    );

    const session = await launch({
      answers: [],
      cwd: fixture.path,
      stateDir,
      installed: { claude: 'out' },
    });

    expect(session.code).toBe(EXIT_CODES.userActionRequired);
    expect(session.error?.code).toBe('no_usable_agent');
    expect([session.error?.message, ...(session.error?.details ?? [])].join('\n')).toContain('claude auth login');
    expect(session.prompter.transcript.join('\n')).toContain('claude auth login');
  });
});

describe('acceptance is shown before it is executed, and never assumed', () => {
  it('refuses to run when the repository has no checks and none is given', async () => {
    const repo = await repositoryWithoutChecks();
    const session = await launch({
      // checks: nothing offered
      answers: [''],
      cwd: repo,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
    });
    expect(session.code).toBe(EXIT_CODES.invalidInput);
    expect(session.error?.code).toBe('no_acceptance_checks');
    expect(session.prompter.transcript.join('\n')).toContain('acceptance cannot mean anything without one');
  });

  it('takes an override and passes it to the run as a --check', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      // use these checks? n · the replacement · unconfined writes? y · task · start? y
      answers: ['n', 'node --test test/', 'y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(recorder.calls[0]?.checks).toEqual(['node --test test/']);
  });

  it('rejects a check that needs a shell and asks again', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['n', 'npm test | tee out.txt', 'npm test', 'y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(recorder.calls[0]?.checks).toEqual(['npm test']);
    expect(session.prompter.transcript.join('\n')).toContain('never through a shell');
  });

  it('does not ask at all when --check was given', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      checks: ['node --test test/'],
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(session.prompter.questions.join('\n')).not.toMatch(/use these checks/);
    expect(recorder.calls[0]?.checks).toEqual(['node --test test/']);
  });
});

describe('the unconfined-writes decision is explained and answered, never assumed', () => {
  it('refuses the run when the acknowledgement is declined', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['y', 'n'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.invalidInput);
    expect(session.error?.code).toBe('write_boundary_unsupported');
    expect(recorder.calls).toHaveLength(0);
    expect(session.prompter.transcript.join('\n')).toContain('write_containment "unsupported"');
  });

  it('passes the flag when it is accepted, and does not ask when the flag was already given', async () => {
    const fixture = await useFixture('ts-bug');
    const accepted = recordingRun();
    const yes = await launch({
      answers: ['y', 'y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      run: accepted.run,
    });
    expect(yes.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(accepted.calls[0]?.allowUnconfinedWrites).toBe(true);

    const preapproved = recordingRun();
    const already = await launch({
      answers: ['y', 'Fix it.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      allowUnconfinedWrites: true,
      run: preapproved.run,
    });
    expect(already.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(already.prompter.questions.join('\n')).not.toMatch(/run anyway/);
    expect(preapproved.calls[0]?.allowUnconfinedWrites).toBe(true);
  });
});

describe('the task comes from a prompt, an editor or the flags', () => {
  it('does not ask when --task was given', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['y', 'y', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      task: 'Fix the pagination off-by-one.',
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(session.prompter.questions.join('\n')).not.toMatch(/what should the agent do/);
    expect(recorder.calls[0]?.task).toBe('Fix the pagination off-by-one.');
  });
});

describe('a longer brief comes from the editor', () => {
  it('opens $EDITOR on an empty answer and takes the whole file as the task', async () => {
    const fixture = await useFixture('ts-bug');
    const brief = ['Fix pageCount and paginate.', '', 'Both are off by one; the tests in test/ describe the expected behaviour.'].join('\n');
    // A real editor: a script that writes into the file it is handed.
    const editor = writeExecutable(tempDir('workforce-launch-editor-'), 'fake-editor', `#!/bin/sh\ncat > "$1" <<'BRIEF'\n${brief}\nBRIEF\n`);
    const recorder = recordingRun();

    const session = await launch({
      // checks? y · unconfined writes? y · task: empty, so the editor opens · start? y
      answers: ['y', 'y', '', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      env: { EDITOR: editor },
      run: recorder.run,
    });

    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(recorder.calls[0]?.task).toContain('Both are off by one');
    expect(recorder.calls[0]?.task?.split('\n').length).toBeGreaterThan(2);
    expect(session.prompter.transcript.join('\n')).toContain('line(s) from the editor');
  });

  it('says so and asks again when there is no editor to open', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['y', 'y', '', 'Fix it on one line.', 'y'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      env: {},
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.verifiedCandidate);
    expect(session.prompter.transcript.join('\n')).toContain('set $EDITOR');
    expect(recorder.calls[0]?.task).toBe('Fix it on one line.');
  });
});

describe('cancelling starts nothing', () => {
  it('exits 130 when the final confirmation is declined, and dispatches no run', async () => {
    const fixture = await useFixture('ts-bug');
    const recorder = recordingRun();
    const session = await launch({
      answers: ['y', 'y', 'Fix it.', 'n'],
      cwd: fixture.path,
      stateDir: path.join(tempDir('workforce-launch-'), 'state'),
      agents: writeFakeAgentsConfig(tempDir('workforce-launch-config-')),
      run: recorder.run,
    });
    expect(session.code).toBe(EXIT_CODES.interrupted);
    expect(session.error?.code).toBe('cancelled');
    expect(recorder.calls).toHaveLength(0);
  });
});

describe('without a terminal the front door is the flag form, unchanged', () => {
  it('exits 2 with usage when stdin is not a TTY', async () => {
    const captured = capture();
    const code = await runCli([], captured.streams);
    expect(code).toBe(EXIT_CODES.invalidInput);
    expect(captured.stdout()).toBe('');
    expect(captured.stderr()).toContain('needs a terminal');
    expect(captured.stderr()).toContain('Usage:');
    expect(captured.stderr()).toContain('workforce run --repo');
  });

  it('refuses --json, because questions and a machine-readable stdout cannot share a stream', async () => {
    const piped = capture();
    expect(await runCli(['--json'], piped.streams)).toBe(EXIT_CODES.invalidInput);

    // And on a real terminal, where the launcher would otherwise start, it is
    // refused by name rather than by the absence of a TTY.
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const terminal = capture();
      expect(await runCli(['--json'], terminal.streams)).toBe(EXIT_CODES.invalidInput);
      const document = JSON.parse(terminal.stdout().trim()) as { error: { code: string } };
      expect(document.error.code).toBe('interactive_json');
    } finally {
      if (original === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', original);
    }
  });

  it('names the flag form when commandLaunch itself is reached without a terminal', async () => {
    const captured = capture();
    await expect(
      commandLaunch({ json: false }, { reporter: new Reporter(false, captured.streams), streams: captured.streams }),
    ).rejects.toMatchObject({ code: 'no_interactive_terminal', exitCode: EXIT_CODES.invalidInput });
  });
});

describe('the pieces the session is assembled from', () => {
  it('searches for an agent configuration in order and never invents duplicates', () => {
    const found = configSearchPath({ explicit: '/tmp/explicit.json', env: { WORKFORCE_AGENTS: '/tmp/env.json' }, repoRoot: '/repo', stateRoot: '/state', homeDir: '/home/me' });
    expect(found.map((candidate) => candidate.path)).toEqual([
      '/tmp/explicit.json',
      '/tmp/env.json',
      path.join('/state', 'agents.json'),
      path.join('/repo', '.workforce', 'agents.json'),
      path.join('/home/me', '.workforce', 'agents.json'),
    ]);
    const deduplicated = configSearchPath({ explicit: path.join('/state', 'agents.json'), env: {}, repoRoot: '/repo', stateRoot: '/state', homeDir: '/home/me' });
    expect(deduplicated.filter((candidate) => candidate.path === path.join('/state', 'agents.json'))).toHaveLength(1);
  });

  it('reports a signed-out runtime as unavailable and an unreadable login as usable', async () => {
    const [codexIn] = await discover({ codex: 'in' });
    const [codexOut] = await discover({ codex: 'out' });
    expect(agentUnavailable(codexIn)).toBeUndefined();
    expect(agentUnavailable(codexOut)).toMatch(/signed out — run: codex login/);
    expect(describeRuntime(codexOut!)).toContain('codex login');
    const [missing] = await discover({});
    expect(agentUnavailable(missing)).toMatch(/not installed/);
    expect(defaultAgentConfig([missing!])).toBeNull();
  });

  it('prints a flag form that quotes what a shell would need quoted', () => {
    const line = equivalentCommand({
      repo: '/tmp/my repo',
      agents: '/tmp/agents.json',
      agent: 'engineer',
      task: 'Fix the off-by-one, please.',
      checks: ['npm test'],
      allowUnconfinedWrites: true,
      stateDir: undefined,
      workspaceRoot: undefined,
    });
    expect(line).toContain('--repo "/tmp/my repo"');
    expect(line).toContain('--check "npm test"');
    expect(line).toContain('--allow-unconfined-writes');
    expect(line).toContain('--task "Fix the off-by-one, please."');
  });
});
