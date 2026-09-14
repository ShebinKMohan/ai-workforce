/**
 * Repeatable queue/admission proof. No coding model is invoked.
 * A real local HTTP server owns controlled Node processes in disposable state.
 * The real execution argv is captured but replaced at the injected Spawner seam.
 * Developer reproduction: node --import tsx docs/evidence/automatic-workforce-2026-09-14/concurrency-proof.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { CODEX_CAPABILITIES } from '../../../src/adapters/index.js';
import type { RuntimeReadinessReport } from '../../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer } from '../../../src/server/index.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../../src/workspace/operations.js';
import { loadWorkspace, updateWorkspace } from '../../../src/workspace/store.js';

const evidenceDir = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wf-concurrency-proof-')));
const stateRoot = path.join(temporary, 'state');
const control = path.join(temporary, 'process-controls');
mkdirSync(control);
const cliArgs = ['--import', 'tsx', path.join(packageRoot, 'src/cli/index.ts')];
const startedAt = new Date().toISOString();
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const calls: Array<{ projectId: string; name: string; requestedCommand: string; requestedArgs: string[]; cliArgv: string[]; shell: boolean; detached: boolean; pid: number | undefined; spawnAt: string; exitAt?: string; exitCode?: number | null; signal?: string | null }> = [];
const children: ChildProcess[] = [];
const cleanup: { serverClosed: boolean; ownedChildrenStopped: boolean; temporaryRemoved: boolean } = { serverClosed: false, ownedChildrenStopped: false, temporaryRemoved: false };
let server: OfficeServer | undefined;
let result: Record<string, unknown> = {};
let failure: unknown;

const stub = `
const fs = process.getBuiltinModule('fs');
const path = process.getBuiltinModule('path');
const [control, name] = process.argv.slice(1);
const receipt = { name, pid: process.pid, startedAt: new Date().toISOString(), runId: 'controlled-' + name + '-' + process.pid };
fs.writeFileSync(path.join(control, name + '.started.json'), JSON.stringify(receipt));
process.stdout.write(JSON.stringify({ type: 'run.created', runId: receipt.runId }) + '\\n');
let finishing = false;
function finish(code) {
  if (finishing) return;
  finishing = true;
  fs.writeFileSync(path.join(control, name + '.ended.json'), JSON.stringify({ ...receipt, endedAt: new Date().toISOString(), exitCode: code }));
  process.stdout.write(JSON.stringify({ ok: code === 0, command: 'run', exitCode: code, runId: receipt.runId, ...(code ? {error:{code:'interrupted',message:'Controlled process stopped',details:[]}} : {}) }) + '\\n', () => process.exit(code));
}
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(130));
setInterval(() => { if (fs.existsSync(path.join(control, 'release-' + name))) finish(0); }, 20);
`;
function git(repo: string, args: string[]): string {
  const ran = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: repo, encoding: 'utf8', shell: false });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}
function makeRepo(name: string): string {
  const repo = path.join(temporary, name); mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), `# ${name}\nControlled admission proof fixture.\n`);
  git(repo, ['init', '--quiet', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Workforce Controlled Proof']);
  git(repo, ['config', 'user.email', 'proof@workforce.invalid']);
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'Initial proof fixture']);
  // Deliberately dirty originals: admission must preserve both tracked and untracked content.
  writeFileSync(path.join(repo, 'README.md'), `# ${name}\nLocal unsaved user changes must remain intact.\n`);
  writeFileSync(path.join(repo, 'local-notes.txt'), `Untracked note for ${name}.\n`);
  return repo;
}
function fingerprint(repo: string) {
  const files = Object.fromEntries(readdirSync(repo).filter(name => name !== '.git').sort().map(name => [name, digest(readFileSync(path.join(repo, name)))]));
  return { head: git(repo, ['rev-parse', 'HEAD']), status: git(repo, ['status', '--porcelain=v1', '--untracked-files=all']), files };
}
async function request(route: string, body?: unknown): Promise<any> {
  assert.ok(server);
  const response = await fetch(`${new URL(server.url).origin}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { Origin: new URL(server.url).origin, 'x-workforce-token': server.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const json = await response.json();
  assert.equal(response.status, body === undefined ? 200 : 202, JSON.stringify(json));
  return json;
}
async function until(id: string, state: string): Promise<any> {
  const deadline = Date.now() + 10000;
  let last: any;
  while (Date.now() < deadline) {
    last = (await request(`/api/requests/${id}`)).request;
    if (last.state === state) return last;
    await pause(30);
  }
  throw new Error(`Request did not reach ${state}: ${JSON.stringify(last)}`);
}
function release(index: number) { writeFileSync(path.join(control, `release-${calls[index]!.name}`), ''); }
function workersOf(call: typeof calls[number]) { return call.cliArgv.filter(arg => arg.startsWith('--worker=')).map(arg => arg.slice('--worker='.length)); }

try {
  const repos = { api: makeRepo('api'), website: makeRepo('website'), reporting: makeRepo('reporting') };
  const before = Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, fingerprint(repo)]));
  updateWorkspace(stateRoot, current => applyWorkspaceOps(current, parseWorkspaceOps([
    { op: 'runtime.set', id: 'controlled', adapter: 'codex', executable: process.execPath },
    ...Object.entries(repos).map(([id, repoPath]) => ({ op: 'project.add', id, name: id, repoPath, checks: ['node --version'] })),
    { op: 'department.add', id: 'engineering', name: 'Engineering' },
    { op: 'agent.add', id: 'head', name: 'Planning head', role: 'head', departmentId: 'engineering', runtime: 'controlled' },
    // Frontend comes first on purpose; capability selection must override roster order.
    { op: 'agent.add', id: 'frontend', name: 'Frontend specialist', role: 'worker', departmentId: 'engineering', runtime: 'controlled', capabilities: ['frontend', 'ui', 'design'], projectIds: [] },
    { op: 'agent.add', id: 'backend', name: 'Backend specialist', role: 'worker', departmentId: 'engineering', runtime: 'controlled', capabilities: ['backend', 'api', 'database'], projectIds: [] },
    { op: 'limits.set', limits: { maxConcurrentProjectRuns: 2, maxActiveTurns: 2, maxActiveWriters: 2, maxTasksPerRun: 4 } },
  ])));
  const configBefore = readFileSync(path.join(stateRoot, 'workspace.json'));
  const config = loadWorkspace(stateRoot).config;
  for (const worker of config.agents.filter(agent => agent.role === 'worker')) {
    assert.deepEqual(worker.projectIds, []);
    assert.notEqual(worker.projectScope, 'restricted');
  }
  server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [{ adapter: 'codex', runtimeId: 'controlled', configuredExecutable: process.execPath, executable: process.execPath, realPath: realpathSync(process.execPath), displayName: 'Controlled queue fixture (injected readiness)', installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', authDetail: 'Injected fixture metadata; no login probe or model call', readiness: 'controllable', version: CODEX_CAPABILITIES.write_containment.testedVersion, checkedAt: new Date().toISOString() } as unknown as RuntimeReadinessReport], queuePollMs: 30,
    cliInvocation: { command: process.execPath, args: cliArgs, cwd: packageRoot },
    spawner: (command, args, options: SpawnOptions) => {
      const cliArgv = args.slice(cliArgs.length);
      const projectId = cliArgv.find(arg => arg.startsWith('--project='))!.slice('--project='.length);
      const name = `${projectId}-${calls.length + 1}`;
      const child = spawn(process.execPath, ['-e', stub, control, name], { ...options, shell: false });
      const call: typeof calls[number] = { projectId, name, requestedCommand: command, requestedArgs: [...args], cliArgv, shell: options.shell === true, detached: options.detached === true, pid: child.pid, spawnAt: new Date().toISOString() };
      calls.push(call); children.push(child);
      child.once('exit', (code, signal) => { call.exitAt = new Date().toISOString(); call.exitCode = code; call.signal = signal; });
      return child;
    },
  });
  const send = async (projectId: string, task: string, clientRequestId: string) => (await request('/api/requests', { projectId, departmentId: 'engineering', workKind: 'implementation', task, clientRequestId })).request;
  const first = await send('api', 'Fix the backend API response using exactly one worker.', 'concurrency-api');
  const second = await send('website', 'Fix the frontend UI layout using exactly one worker.', 'concurrency-website');
  const firstRunning = await until(first.id, 'running');
  const secondRunning = await until(second.id, 'running');
  assert.deepEqual(workersOf(calls[0]!), ['backend']);
  assert.deepEqual(workersOf(calls[1]!), ['frontend']);
  assert.equal(firstRunning.exclusive, false); assert.equal(secondRunning.exclusive, false);
  assert.notEqual(firstRunning.pid, secondRunning.pid);
  const overlapSnapshot = { at: new Date().toISOString(), queue: await request('/api/requests') };
  assert.equal(overlapSnapshot.queue.live.length, 2);
  assert.deepEqual(overlapSnapshot.queue.live.map((run: any) => run.projectId).sort(), ['api', 'website']);
  const third = await send('reporting', 'Fix the backend database report using exactly one worker.', 'concurrency-reporting');
  const queuedSnapshot = { at: new Date().toISOString(), queue: await request('/api/requests') };
  assert.equal(third.state, 'queued');
  assert.match(third.reason, /busy|limit|already running/);
  assert.equal(calls.length, 2, 'Queued third request must not spawn.');
  // A repeated HTTP submission must remain one logical queued request.
  const repeatedThird = await send('reporting', 'Fix the backend database report using exactly one worker.', 'concurrency-reporting');
  assert.equal(repeatedThird.id, third.id); assert.equal(calls.length, 2);
  await pause(300);
  for (const child of children) assert.equal(child.exitCode, null, 'Both controlled processes must still be alive.');
  release(0);
  const firstEnded = await until(first.id, 'ended');
  const thirdRunning = await until(third.id, 'running');
  assert.equal(calls.length, 3);
  assert.deepEqual(workersOf(calls[2]!), ['backend']);
  assert.equal((await request(`/api/requests/${second.id}`)).request.state, 'running');
  const reuseSnapshot = { at: new Date().toISOString(), queue: await request('/api/requests') };
  assert.equal(reuseSnapshot.queue.live.length, 2);
  assert.deepEqual(reuseSnapshot.queue.live.map((run: any) => run.projectId).sort(), ['reporting', 'website']);
  assert.ok(Date.parse(calls[2]!.spawnAt) >= Date.parse(calls[0]!.exitAt!), 'A worker is reused only after its old process exits.');
  release(1); release(2);
  const completed = [firstEnded, await until(second.id, 'ended'), await until(third.id, 'ended')];
  const finalQueue = await request('/api/requests');
  assert.equal(finalQueue.live.length, 0);
  assert.equal(finalQueue.items.length, 3);
  assert.ok(completed.every(item => item.exitCode === 0));
  const after = Object.fromEntries(Object.entries(repos).map(([name, repo]) => [name, fingerprint(repo)]));
  assert.deepEqual(after, before);
  assert.equal(digest(readFileSync(path.join(stateRoot, 'workspace.json'))), digest(configBefore), 'Admission must not silently assign workers or rewrite the workspace.');
  const processReceipts = calls.map(call => ({ started: JSON.parse(readFileSync(path.join(control, `${call.name}.started.json`), 'utf8')), ended: JSON.parse(readFileSync(path.join(control, `${call.name}.ended.json`), 'utf8')) }));
  const overlapMs = Math.min(Date.parse(processReceipts[0]!.ended.endedAt), Date.parse(processReceipts[1]!.ended.endedAt)) - Math.max(Date.parse(processReceipts[0]!.started.startedAt), Date.parse(processReceipts[1]!.started.startedAt));
  assert.ok(overlapMs >= 300, 'Two real owned process lifetimes must overlap.');
  result = { schemaVersion: 1, proofLayer: 'controlled-runtime HTTP admission and real owned process concurrency; no coding-model execution or verification claim', passed: true, startedAt, completedAt: new Date().toISOString(), nodeVersion: process.version, origin: server.url, readinessProvenance: 'Injected known-version Codex metadata tests the nonexclusive admission branch; actual executable is replaced by a controlled Node process. This is not a Codex containment or model-execution proof.',
    workspace: { revision: config.revision, limits: config.limits, workers: config.agents.filter(agent => agent.role === 'worker').map(({ id, capabilities, projectIds, projectScope, policy }) => ({ id, capabilities, projectIds, projectScope: projectScope ?? 'all (legacy default)', policy })), configurationUnchanged: true },
    assertions: { concurrentProjects: 2, maximumObservedLiveRequests: 2, overlappingProcessMilliseconds: overlapMs, workerSelectedByCapabilities: true, manualProjectAssignments: 0, thirdQueuedWithoutSpawn: true, duplicateRequestReusedReceipt: true, workerReusedOnlyAfterProcessExit: true, noConcurrentDuplicateWorker: true, dirtyOriginalRepositoriesUnchanged: true, allRequestsSettled: true },
    requests: { first: firstRunning, second: secondRunning, thirdQueued: third, thirdAfterAutomaticAdmission: thirdRunning, final: completed }, snapshots: { overlap: overlapSnapshot, queued: queuedSnapshot, automaticReuse: reuseSnapshot, final: finalQueue }, calls, processReceipts, repositories: { before, after },
  };
} catch (error) {
  failure = error;
  result = { schemaVersion: 1, proofLayer: 'controlled-runtime HTTP admission and real process proof', passed: false, startedAt, failedAt: new Date().toISOString(), error: error instanceof Error ? error.stack : String(error), calls };
} finally {
  if (server) { await server.close(); cleanup.serverClosed = true; }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await pause(30);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await pause(40);
  cleanup.ownedChildrenStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  if (cleanup.ownedChildrenStopped) { rmSync(temporary, { recursive: true, force: true }); cleanup.temporaryRemoved = !existsSync(temporary); }
  writeFileSync(path.join(evidenceDir, 'concurrency-receipts.json'), `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
}
if (failure || !cleanup.ownedChildrenStopped || !cleanup.temporaryRemoved) {
  console.error(JSON.stringify({ passed: false, error: failure instanceof Error ? failure.message : String(failure), cleanup }));
  process.exitCode = 1;
} else console.log(JSON.stringify({ passed: true, ...(result.assertions as object), cleanup, evidence: path.join(evidenceDir, 'concurrency-receipts.json') }, null, 2));
