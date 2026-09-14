/** Read-only independent audit and portable export of the completed fixture evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStateStore } from './runtime/dist/storage/db.js';
import { createStatePaths } from './runtime/dist/storage/paths.js';
import { listArtifacts, readArtifact } from './runtime/dist/storage/artifacts.js';

const out = path.dirname(fileURLToPath(import.meta.url));
const proof = JSON.parse(await fs.readFile(path.join(out, 'proof-result.json'), 'utf8'));
const run = JSON.parse(await fs.readFile(path.join(out, 'run-final.json'), 'utf8'));
const issue = JSON.parse(await fs.readFile(path.join(out, 'issue-final.json'), 'utf8'));
const request = JSON.parse(await fs.readFile(path.join(out, 'request-final.json'), 'utf8'));
const originalPrd = await fs.readFile(path.join(out, 'submitted-prd.md'), 'utf8');
assert.equal(proof.passed, true);
assert.equal(proof.queue.items.length, 1, 'the completed proof must have exactly one persisted request');
assert.equal(proof.queue.items[0].id, proof.requestId);
assert.equal(run.run.id, proof.runId);
assert.equal(run.run.state, 'ready_for_review');
assert.equal(run.tasks.length, 1);
assert.equal(run.tasks[0].ownerAgentId, 'engineer-one');
assert.equal(run.tasks[0].state, 'accepted');
assert.deepEqual(run.compromisedReceiptIds, []);
assert.deepEqual(run.unverifiedReceiptIds, []);
assert.deepEqual(run.evidenceIssues, []);
assert.equal(request.task, `${issue.title}\n\n${originalPrd}`);
assert.equal(request.allowUnconfinedWrites, false);
assert.equal(request.controlRuntime.executable, '/opt/homebrew/bin/codex');
assert.equal(request.controlRuntime.model, proof.model);
assert.equal(request.controlRuntime.effort, 'low');
assert.equal(run.run.headReview.verdict, 'passed');
assert.equal(run.run.headReview.sessionStopped, true);
assert.equal(run.run.headReview.interrupted, false);
assert(run.run.finalReply?.length > 0);
const store = openStateStore(createStatePaths(path.join(proof.stateRoot, 'projects/mcp-math')), { mode: 'read-only' });
const artifactExports = [];
const receipts = [];
const versions = new Set();
const allowed = new Set(['head_planning_input', 'head_plan_proposal', 'check_receipt', 'check_stdout', 'check_stderr', 'candidate_patch', 'head_review_diff', 'head_review_input', 'head_review_result', 'result', 'summary']);
await fs.mkdir(path.join(out, 'artifacts'), { recursive: true });
try {
  const events = store.db.prepare('SELECT sequence, type, timestamp, payload_json FROM events WHERE run_id = ? ORDER BY sequence').all(proof.runId).map(row => ({ sequence: row.sequence, type: row.type, at: row.timestamp, payload: JSON.parse(row.payload_json) }));
  const selectedEvents = events.filter(event => !event.type.startsWith('runtime.'));
  const raw = events.filter(event => event.type.startsWith('runtime.'));
  const actualToolCalls = raw.filter(event => ['runtime.tool_call', 'runtime.tool_result'].includes(event.type) && event.payload.server === 'workforce' && ['workforce_propose_plan', 'workforce_review_result'].includes(event.payload.tool));
  for (const tool of ['workforce_propose_plan', 'workforce_review_result']) assert(actualToolCalls.some(event => event.type === 'runtime.tool_result' && event.payload.tool === tool && event.payload.status === 'completed' && event.payload.error === null), `actual completed ${tool} must appear in runtime records`);
  for (const event of events) {
    const value = JSON.stringify(event.payload);
    if (value.includes('0.154.0')) versions.add('0.154.0');
  }
  for (const artifact of listArtifacts(store.db, proof.runId)) {
    if (!allowed.has(artifact.type)) continue;
    // readArtifact verifies the registered content hash before returning bytes.
    const { bytes } = readArtifact(store.db, store.paths, artifact.id);
    const relative = `artifacts/${artifact.relativePath}`;
    await fs.mkdir(path.dirname(path.join(out, relative)), { recursive: true });
    await fs.writeFile(path.join(out, relative), bytes);
    artifactExports.push({ id: artifact.id, type: artifact.type, path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (artifact.type === 'check_receipt') receipts.push(JSON.parse(bytes.toString('utf8')));
  }
  assert(receipts.length > 0);
  for (const receipt of receipts) {
    assert.equal(receipt.evidenceProvenance, 'verifier_executed');
    assert.equal(receipt.outcome, 'passed');
    assert.equal(receipt.outputSummary.testsRun, 3);
    assert.equal(receipt.copyStrategy, 'git_archive');
    assert.equal(receipt.integrity.mutated, false);
    assert.deepEqual(receipt.stateRootGuard.violations, []);
  }
  const runPath = path.join(store.paths.root, 'runs', proof.runId);
  const plan = JSON.parse(await fs.readFile(path.join(runPath, 'plan.json'), 'utf8'));
  const plannedResult = JSON.parse(await fs.readFile(path.join(runPath, 'planned-result.json'), 'utf8'));
  assert.equal(plannedResult.accepted, true);
  assert.equal(plannedResult.combination.acceptance.accepted, true);
  assert.equal(plannedResult.combination.combinedRevision, run.run.headReview.candidateRevision);
  assert.deepEqual(plannedResult.combination.acceptance.unverifiedCriteria, []);
  assert(plannedResult.combination.acceptance.ignoredReceiptIds.includes(receipts[0].id), 'combined gate must ignore earlier worker-candidate receipt');
  assert.equal(plannedResult.combination.acceptance.verdicts.length, 1);
  assert.equal(plannedResult.combination.acceptance.verdicts[0].outcome, 'passed');
  await fs.writeFile(path.join(out, 'planned-result.json'), `${JSON.stringify(plannedResult, null, 2)}\n`);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].agentId, 'engineer-one');
  assert.equal(plan.headReview.required, true);
  await fs.writeFile(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await fs.writeFile(path.join(out, 'lifecycle-events.json'), `${JSON.stringify(selectedEvents, null, 2)}\n`);
  await fs.writeFile(path.join(out, 'head-mcp-tool-events.json'), `${JSON.stringify(actualToolCalls, null, 2)}\n`);
  const summary = { schemaVersion: 1, auditedAt: new Date().toISOString(), passed: true, issueId: proof.issueId, requestId: proof.requestId, runId: proof.runId, runtimeVersion: proof.runtimeVersion, model: proof.model, effort: proof.effort, elapsedMs: proof.elapsedMs, workers: [run.tasks[0].ownerAgentId], independentCheckReceipts: receipts.length, testsPerReceipt: receipts.map(receipt => receipt.outputSummary.testsRun), combinedAcceptance: plannedResult.combination.acceptance, headReview: run.run.headReview, finalReply: run.run.finalReply, originalUnchanged: JSON.stringify(proof.original) === JSON.stringify(proof.finalOriginal), candidateRevision: run.run.headReview.candidateRevision, candidateDiffHash: run.run.headReview.diffHash, preservedFullPrd: request.task === `${issue.title}\n\n${originalPrd}`, idempotency: proof.idempotency, artifactExports };
  await fs.writeFile(path.join(out, 'audit-result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, runId: proof.runId, workers: summary.workers, receipts: receipts.length, headReview: summary.headReview.verdict, originalUnchanged: summary.originalUnchanged, exportedArtifacts: artifactExports.length }));
} finally { store.close(); }
