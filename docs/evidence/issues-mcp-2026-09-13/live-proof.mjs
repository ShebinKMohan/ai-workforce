/** Real external MCP -> Control Center -> head -> one Codex worker -> independent checks -> head review.
 * Run from package root after building the private runtime with the command in README.md.
 * All mutation is limited to this evidence directory and a fresh /private/tmp fixture/state root.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfficeServer } from './runtime/dist/server/index.js';
import { updateWorkspace } from './runtime/dist/workspace/store.js';
import { applyWorkspaceOps, parseWorkspaceOps } from './runtime/dist/workspace/operations.js';
import { discoverWorkspaceRuntimes } from './runtime/dist/discovery/readiness.js';
import { discoverRuntimeModels } from './runtime/dist/discovery/model-catalog.js';

const out = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(out, '../../..');
const cli = path.join(out, 'runtime/dist/cli/index.js');
const proofRoot = await fs.mkdtemp('/private/tmp/wf-mcp-proof-');
const repo = path.join(proofRoot, 'fixture');
const stateRoot = path.join(proofRoot, 'state');
await fs.mkdir(path.join(repo, 'src'), { recursive: true });
await fs.mkdir(path.join(repo, 'test'));
const save = async (name, data) => fs.writeFile(path.join(out, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const command = (executable, args, cwd = repo) => {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', shell: false, timeout: 30_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const git = (args) => { const result = command('/usr/bin/git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const fileMap = {
  'package.json': JSON.stringify({ name: 'issues-mcp-math-fixture', private: true, type: 'module', scripts: { test: 'node --test test/math.test.mjs' } }, null, 2) + '\n',
  'AGENTS.md': 'This is a disposable proof fixture. Change only src/math.mjs. Preserve test/ and package.json. Do not push, deploy, install packages or create commits. The coordinator owns candidate capture and independent checks.\n',
  'src/math.mjs': 'export function add(a, b) {\n  return a - b;\n}\n',
  'test/math.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('adds positive integers', () => assert.equal(add(2, 3), 5));\ntest('adds negative and positive integers', () => assert.equal(add(-2, 5), 3));\ntest('adds decimal numbers', () => assert.equal(add(1.25, 2.5), 3.75));\n",
};
for (const [name, text] of Object.entries(fileMap)) await fs.writeFile(path.join(repo, name), text);
git(['init', '--initial-branch=fixture-base']);
git(['config', 'user.name', 'AI Workforce Fixture']);
git(['config', 'user.email', 'fixture@localhost']);
git(['add', 'package.json', 'AGENTS.md', 'src/math.mjs', 'test/math.test.mjs']);
git(['commit', '-m', 'Disposable fixture: reproduce addition bug']);
const original = { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain']), files: Object.fromEntries(Object.entries(fileMap).map(([name, data]) => [name, hash(data)])) };
const baseline = command(process.execPath, ['--test', 'test/math.test.mjs']);
assert.notEqual(baseline.status, 0, 'baseline bug must reproduce');
await save('baseline-check.json', baseline);
await save('fixture-files.json', fileMap);

const runtime = { adapter: 'codex', executable: '/opt/homebrew/bin/codex' };
const reports = await discoverWorkspaceRuntimes({ 'codex-local': runtime });
const catalog = await discoverRuntimeModels({ runtimeId: 'codex-local', runtime, reports });
assert.equal(catalog.status, 'available');
assert.equal(reports[0].writingModeAvailable, true, 'verified confinement is required; proof never grants unconfined consent');
const selected = catalog.models.find(model => model.id === 'gpt-6-astra' && model.efforts.includes('low'))
  ?? catalog.models.find(model => model.efforts.includes('low'));
assert(selected, 'an actually advertised model with low effort is required');
await save('runtime-catalog.json', { reports, catalog, selectedModel: selected.id, selectedEffort: 'low' });
const projectId = 'mcp-math';
const workspace = updateWorkspace(stateRoot, current => applyWorkspaceOps(current, parseWorkspaceOps([
  { op: 'runtime.set', id: 'codex-local', ...runtime, model: selected.id, effort: 'low' },
  { op: 'project.add', id: projectId, name: 'MCP math proof', repoPath: repo, checks: ['node --test test/math.test.mjs'] },
  { op: 'department.add', id: 'engineering', name: 'Engineering', note: 'Owns source code bugs and tests.' },
  { op: 'agent.add', id: 'engineering-head', name: 'Engineering Head', role: 'head', departmentId: 'engineering', runtime: 'codex-local', model: selected.id, effort: 'low', instructions: 'Plan exactly one task, assigned to engineer-one, fixing only src/math.mjs. The request is a tiny addition bug. Use the required actual workforce_propose_plan tool. Preserve original acceptance tests and package configuration. On final review inspect the actual diff and verifier receipts, and use the required structured review tool. Do not call other agents or install packages.' },
  { op: 'agent.add', id: 'engineer-one', name: 'Engineer One', role: 'worker', departmentId: 'engineering', runtime: 'codex-local', model: selected.id, effort: 'low', projectIds: [projectId], instructions: 'Fix only src/math.mjs. Preserve test/ and package.json. Reproduce the provided bug, make the smallest source fix, run the existing tests, and finish. Do not spawn subagents, install packages, commit, push or deploy.' },
  { op: 'control-center.set', runtime: 'codex-local', model: selected.id, effort: 'low', instructions: 'This workspace contains only a disposable math repository. Delegate the explicitly requested addition code fix to Engineering. Preserve all task requirements. Do not answer as if the code has been fixed.' },
  { op: 'limits.set', limits: { maxConcurrentProjectRuns: 1, maxActiveTurns: 1, maxActiveWriters: 1, maxTasksPerRun: 1, maxDelegationDepth: 0, maxRepairAttempts: 1, maxTransientRetries: 0, runTimeoutMinutes: 5 } },
]), { stateRoot }));
await save('workspace-config.json', workspace.config);
await fs.writeFile(path.join(out, 'runtime/package.json'), JSON.stringify({ name: 'workforce-proof-runtime', private: true, version: '0.1.0', type: 'module' }));
const startedAt = new Date().toISOString();
const server = await startOfficeServer({ stateRoot, port: 0, webRoot: path.join(root, 'web/headquarters'), cliInvocation: { command: process.execPath, args: [cli], cwd: root }, queuePollMs: 150, env: process.env });
const summary = { schemaVersion: 1, startedAt, proofRoot, stateRoot, fixtureRepo: repo, serverUrl: server.url, runtimeVersion: catalog.version, model: selected.id, effort: 'low', original, stages: [], passed: false };
await save('progress.json', summary);
console.log(JSON.stringify({ phase: 'prepared', url: server.url, proofRoot, version: catalog.version, model: selected.id }));

const frames = [];
const pending = new Map();
let nextId = 0;
let buffered = '';
let bridgeStderr = '';
const bridge = spawn(process.execPath, [cli, 'mcp', '--server-url', server.url], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
bridge.stderr.on('data', chunk => { bridgeStderr += chunk.toString(); });
bridge.stdout.on('data', chunk => {
  buffered += chunk.toString();
  for (;;) {
    const newline = buffered.indexOf('\n'); if (newline < 0) break;
    const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line); frames.push({ direction: 'response', at: new Date().toISOString(), ...frame });
    const call = pending.get(frame.id); if (call) { pending.delete(frame.id); clearTimeout(call.timer); frame.error ? call.reject(new Error(JSON.stringify(frame.error))) : call.resolve(frame.result); }
  }
});
bridge.on('exit', code => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`MCP bridge exited ${code}`)); } pending.clear(); });
const send = (method, params, notification = false) => {
  const frame = { jsonrpc: '2.0', ...(notification ? {} : { id: ++nextId }), method, ...(params ? { params } : {}) };
  frames.push({ direction: 'request', at: new Date().toISOString(), ...frame });
  if (notification) { bridge.stdin.write(`${JSON.stringify(frame)}\n`); return; }
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(frame.id); reject(new Error(`MCP ${method} timed out`)); }, 30_000); pending.set(frame.id, { resolve, reject, timer }); bridge.stdin.write(`${JSON.stringify(frame)}\n`); });
};
const tool = async (name, args) => { const response = await send('tools/call', { name, arguments: args }); assert.equal(response.isError, false, JSON.stringify(response)); return response.structuredContent ?? JSON.parse(response.content[0].text); };
const read = async route => { const response = await fetch(new URL(route, server.url), { signal: AbortSignal.timeout(20_000), headers: { Origin: new URL(server.url).origin } }); const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data; };
try {
  const handshake = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-live-proof', version: '1.0.0' } });
  assert.equal(handshake.serverInfo.name, 'ai-workforce');
  send('notifications/initialized', {}, true);
  const list = await send('tools/list', {});
  assert(list.tools.some(tool => tool.name === 'workforce_submit_plan'));
  const projects = await tool('workforce_list_projects', {});
  assert(projects.projects.some(project => project.id === projectId));
  const description = `PRD: Correct numeric addition in the disposable math project.\n\nProblem: add(2, 3) currently returns -1 instead of 5.\n\nImplement now with exactly one Engineering worker. Fix only src/math.mjs so add(a, b) returns the numeric sum for the existing supported numbers. Preserve the original test/ files, package.json and repository instructions. No installation, network calls, subagents, commits, pushes, merges or deployment.\n\nAcceptance: the existing command node --test test/math.test.mjs passes for positive integers, mixed-sign integers and decimal values. The coordinator must independently run the existing checks against its frozen candidate and the Engineering head must review that candidate. Return a verified local candidate only; do not apply it to the original repository.\n\nPreserve this original PRD's line breaks and wording — including this evidence marker: MCP-PRD-2026-09-13.\n`;
  const args = { projectId, title: 'Correct addition in the math module', description, kind: 'prd', source: 'codex-proof', idempotencyKey: 'proof:2026-09-13:math:v1', start: true };
  await save('submitted-prd.md', description);
  const first = await tool('workforce_submit_plan', args);
  assert(first.issue?.id, JSON.stringify(first));
  assert(!first.startError, JSON.stringify(first));
  assert.equal(first.issue.description, description);
  const second = await tool('workforce_submit_plan', args);
  assert.equal(second.issue.id, first.issue.id, 'same idempotency key must return the same issue');
  assert.equal(second.issue.requestId, first.issue.requestId, 'duplicate must retain original request identity');
  assert(first.issue.requestId, 'start:true must have a request receipt');
  summary.issueId = first.issue.id; summary.requestId = first.issue.requestId;
  summary.idempotency = { sameIssue: true, sameRequest: true };
  await save('submit-receipts.json', { first, second });
  console.log(JSON.stringify({ phase: 'submitted', issueId: summary.issueId, requestId: summary.requestId }));
  let finalIssue;
  let lastState = '';
  const deadline = Date.now() + 390_000;
  while (Date.now() < deadline) {
    const { issue } = await tool('workforce_get_issue', { issueId: summary.issueId });
    const request = (await read(`/api/requests/${summary.requestId}`)).request;
    const state = JSON.stringify([issue.status, issue.execution.state, request.state, request.route?.state, request.runId]);
    if (state !== lastState) { lastState = state; summary.stages.push({ at: new Date().toISOString(), status: issue.status, execution: issue.execution, requestState: request.state, route: request.route, runId: request.runId }); console.log(JSON.stringify({ phase: 'progress', ...summary.stages.at(-1) })); await save('progress.json', summary); }
    await save('issue-final.json', issue); await save('request-final.json', request);
    if (request.runId) summary.runId = request.runId;
    if (['ended', 'failed_to_start', 'discarded'].includes(request.state)) { finalIssue = issue; summary.request = request; break; }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  if (summary.runId) {
    summary.run = await read(`/api/projects/${projectId}/runs/${summary.runId}`);
    summary.events = await read(`/api/projects/${projectId}/runs/${summary.runId}/events?limit=1000`);
    await save('run-final.json', summary.run); await save('run-events.json', summary.events);
  }
  assert(finalIssue, 'actual model execution exceeded the bounded proof deadline');
  assert.equal(finalIssue.execution.verified, true, JSON.stringify(finalIssue));
  assert.equal(finalIssue.status, 'done');
  assert.deepEqual(summary.request.workerIds, ['engineer-one']);
  assert.equal(summary.request.submittedDepartmentId, null, 'external plan must go through Control Center routing');
  assert.equal(summary.request.route.departmentId, 'engineering');
  assert.equal(summary.request.route.method, 'classifier');
  const allIssues = await tool('workforce_list_issues', { projectId });
  assert.equal(allIssues.issues.length, 1, 'duplicate submission must create one issue');
  const queue = await read('/api/requests');
  summary.queue = queue;
  const finalOriginal = { head: git(['rev-parse', 'HEAD']), status: git(['status', '--porcelain']), files: {} };
  for (const name of Object.keys(fileMap)) finalOriginal.files[name] = hash(await fs.readFile(path.join(repo, name)));
  summary.finalOriginal = finalOriginal;
  assert.deepEqual(finalOriginal, original, 'original fixture source and branch must remain byte-identical');
  const unchangedBaseline = command(process.execPath, ['--test', 'test/math.test.mjs']);
  assert.notEqual(unchangedBaseline.status, 0, 'original checkout should retain its deliberately unfixed bug');
  summary.originalStillReproducesBug = true;
  summary.passed = true;
  console.log(JSON.stringify({ phase: 'passed', issueId: summary.issueId, runId: summary.runId, originalUnchanged: true }));
} catch (error) {
  summary.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  console.error(JSON.stringify({ phase: 'failed', error: summary.error }));
  process.exitCode = 1;
} finally {
  summary.finishedAt = new Date().toISOString();
  summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(startedAt);
  await save('mcp-frames.json', frames);
  await save('mcp-stderr.txt', bridgeStderr);
  await save('proof-result.json', summary);
  bridge.stdin.end();
  await new Promise(resolve => { if (bridge.exitCode !== null) return resolve(); const timer = setTimeout(() => { bridge.kill('SIGTERM'); resolve(); }, 2000); bridge.once('exit', () => { clearTimeout(timer); resolve(); }); });
  await server.close();
}
