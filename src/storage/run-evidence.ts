/**
 * Shared, read-only verifier evidence for a single run (FR050, FR061).
 * Both the CLI status document and the office list use this projection so
 * opening old history never depends on whether a run fits the latest page.
 */
import { listChecks } from '../verification/checks.js';
import { redactText } from '../telemetry/redaction.js';
import type { StateStore } from './db.js';
import { lastEventPerTask } from './events.js';
import { listArtifacts, readArtifact, type ArtifactRecord } from './artifacts.js';
import { listAttempts, listTasks, type AttemptRow, type TaskRow } from './records.js';

/**
 * Each task as a desk needs it: its state, the attempt the database holds for
 * its current generation, its verifier receipts and its newest event.
 *
 * `receipts` counts check rows by provenance so the page can tell a
 * verifier-executed pass from anything else. A runtime's own account of its
 * work is an event, never a receipt, and never appears here. A verifier pass
 * that a manifest marks compromised (the candidate changed the files the check
 * executed) is counted as `verifierExecutedCompromised`, never as a pass.
 */
function taskViews(store: StateStore, runId: string, tasks: ReadonlyArray<TaskRow>, compromised: ReadonlySet<string>, unavailable: ReadonlySet<string>): Array<Record<string, unknown>> {
  const generations = new Map(tasks.map((task) => [task.id, task.current_generation]));
  const currentAttempt = new Map<string, AttemptRow>();
  for (const attempt of listAttempts(store.db, runId)) {
    if (attempt.generation === generations.get(attempt.task_id)) currentAttempt.set(attempt.task_id, attempt);
  }
  const empty = () => ({ verifierExecutedPassed: 0, verifierExecutedCompromised: 0, verifierExecutedFailed: 0, verifierExecutedOther: 0, otherProvenance: 0 });
  const receipts = new Map<string, ReturnType<typeof empty>>();
  for (const check of listChecks(store.db, runId)) {
    if (check.task_id === null) continue;
    // A passing receipt from a replaced generation is historical evidence,
    // not evidence for the task's current candidate. The full status check
    // list retains it; only this current-task projection excludes it.
    const attempt = currentAttempt.get(check.task_id);
    if (attempt === undefined || check.attempt_id !== attempt.id) continue;
    const counts = receipts.get(check.task_id) ?? empty();
    if (check.evidence_provenance !== 'verifier_executed') counts.otherProvenance += 1;
    else if (check.outcome === 'passed' && unavailable.has(check.id)) counts.verifierExecutedOther += 1;
    else if (check.outcome === 'passed' && compromised.has(check.id)) counts.verifierExecutedCompromised += 1;
    else if (check.outcome === 'passed') counts.verifierExecutedPassed += 1;
    else if (check.outcome === 'failed') counts.verifierExecutedFailed += 1;
    else counts.verifierExecutedOther += 1;
    receipts.set(check.task_id, counts);
  }
  const lastEvents = new Map(lastEventPerTask(store.db, runId).map((event) => [event.taskId, event]));
  return tasks.map((task) => {
    const attempt = currentAttempt.get(task.id);
    const last = lastEvents.get(task.id);
    return {
      id: task.id,
      objective: task.objective,
      state: task.state,
      waitReason: task.wait_reason,
      ownerAgentId: task.owner_agent_id,
      generation: task.current_generation,
      attempt: attempt === undefined ? null : { id: attempt.id, generation: attempt.generation, state: attempt.state, startedAt: attempt.started_at, endedAt: attempt.ended_at },
      receipts: receipts.get(task.id) ?? empty(),
      lastEvent: last === undefined ? null : { type: last.type, timestamp: last.timestamp, sequence: last.sequence },
    };
  });
}

function readManifest(store: StateStore, artifact: ArtifactRecord): { manifest: Record<string, unknown> | null; issue: string | null } {
  try {
    // Only bytes whose immutable artifact receipt still matches may explain
    // acceptance. Reading a loose result.json could trust tampering or hide a
    // compromised criterion when its original manifest has disappeared.
    const value: unknown = JSON.parse(readArtifact(store.db, store.paths, artifact.id).bytes.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a manifest object');
    return { manifest: value as Record<string, unknown>, issue: null };
  } catch (error) {
    return { manifest: null, issue: redactText(`Evidence ${artifact.relativePath} is unavailable: ${(error as Error).message}`) };
  }
}

function requirementsOf(manifest: Record<string, unknown>): Array<{ criterionId: string; status: string; receiptId: string | null }> {
  const list = manifest['requirements'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { criterionId, status, receiptId } = entry as Record<string, unknown>;
    if (typeof criterionId !== 'string' || typeof status !== 'string') return [];
    return [{ criterionId, status, receiptId: typeof receiptId === 'string' ? receiptId : null }];
  });
}

/**
 * What a run's manifests say about how it ended, read the way `workforce
 * status` reads them: a projection the coordinator wrote, never rebuilt here.
 *
 * `outcome` comes from the run's `result.json` and is null until the run
 * writes one. A receipt is compromised when that manifest, or one of a planned
 * run's per-attempt manifests under `tasks/`, says the candidate changed the
 * files the receipt executed.
 */
function manifestFacts(store: StateStore, runId: string): {
  manifest: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  compromisedReceiptIds: string[];
  unverifiedReceiptIds: string[];
  evidenceIssues: string[];
} {
  let top: Record<string, unknown> | null = null;
  const manifests: Array<Record<string, unknown>> = [];
  const evidenceIssues: string[] = [];
  for (const artifact of listArtifacts(store.db, runId)) {
    if (artifact.relativePath !== 'result.json' && !/^tasks\/[^/]+\/result\.json$/.test(artifact.relativePath)) continue;
    const read = readManifest(store, artifact);
    if (read.issue !== null) evidenceIssues.push(read.issue);
    if (read.manifest === null) continue;
    manifests.push(read.manifest);
    if (artifact.relativePath === 'result.json') top = read.manifest;
  }
  // A direct run can retry in a successor attempt without rewriting its
  // immutable first result. Select only the artifact belonging to its one
  // current task generation; old failed candidates remain visible as history.
  if (typeof top?.['taskId'] === 'string') {
    const tasks = listTasks(store.db, runId);
    const task = tasks.length === 1 && tasks[0]?.id === top['taskId'] ? tasks[0] : undefined;
    const attempt = task === undefined ? undefined : listAttempts(store.db, runId).find(entry => entry.task_id === task.id && entry.generation === task.current_generation);
    if (attempt !== undefined && attempt.id !== top['attemptId']) {
      const receipt = listArtifacts(store.db, runId).find(entry => entry.type === 'result' && entry.taskId === task!.id && entry.attemptId === attempt.id && entry.relativePath === `tasks/${attempt.id}/result.json`);
      const current = receipt === undefined ? null : readManifest(store, receipt).manifest;
      // Missing or mismatched successor evidence never inherits the old verdict.
      top = current?.['runId'] === runId && current['taskId'] === task!.id && current['attemptId'] === attempt.id ? current : null;
      if (top === null) evidenceIssues.push('The direct run has a newer attempt without a readable matching result manifest.');
    }
  }
  const compromised = new Set<string>();
  const passed = new Set<string>();
  for (const manifest of manifests) {
    for (const requirement of requirementsOf(manifest)) {
      if (requirement.receiptId === null) continue;
      if (requirement.status === 'compromised') compromised.add(requirement.receiptId);
      if (requirement.status === 'passed') passed.add(requirement.receiptId);
    }
  }
  const compromisedReceiptIds = [...compromised].sort();
  const unverifiedReceiptIds = listChecks(store.db, runId)
    .filter((check) => check.task_id !== null && check.outcome === 'passed' && check.evidence_provenance === 'verifier_executed' && !passed.has(check.id) && !compromised.has(check.id))
    .map((check) => check.id)
    .sort();
  if (unverifiedReceiptIds.length > 0) {
    evidenceIssues.push(`${unverifiedReceiptIds.length} passing check receipt(s) have no readable, hash-verified result manifest; their recorded passes do not establish current verification.`);
  }
  const facts = { manifest: top, compromisedReceiptIds, unverifiedReceiptIds, evidenceIssues };
  if (top === null) return { ...facts, outcome: null };
  const acceptance = top['acceptance'] !== null && typeof top['acceptance'] === 'object' ? (top['acceptance'] as Record<string, unknown>) : {};
  const requirements = requirementsOf(top);
  const criteria = (status: string) => requirements.filter((requirement) => requirement.status === status).map((requirement) => requirement.criterionId);
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const reasons = acceptance['reasons'];
  return {
    outcome: {
      accepted: typeof acceptance['accepted'] === 'boolean' ? acceptance['accepted'] : null,
      requiredTotal: count(acceptance['requiredTotal']),
      requiredPassed: count(acceptance['requiredPassed']),
      compromised: criteria('compromised'),
      failed: criteria('failed'),
      noEvidence: criteria('no_evidence'),
      reasons: Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string').map((reason) => redactText(reason)) : [],
    },
    ...facts,
  };
}

/** Evidence for exactly this run, independent of list limits or other projects. */
export function runEvidenceView(store: StateStore, runId: string, tasks: ReadonlyArray<TaskRow> = listTasks(store.db, runId)): {
  taskViews: Array<Record<string, unknown>>;
  outcome: Record<string, unknown> | null;
  compromisedReceiptIds: string[];
  unverifiedReceiptIds: string[];
  evidenceIssues: string[];
  manifest: Record<string, unknown> | null;
} {
  const facts = manifestFacts(store, runId);
  return { ...facts, taskViews: taskViews(store, runId, tasks, new Set(facts.compromisedReceiptIds), new Set(facts.unverifiedReceiptIds)) };
}
