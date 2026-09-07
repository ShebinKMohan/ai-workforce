/**
 * `workforce status <run-id>` — read-only inspection (FR061).
 *
 * This command must be usable from a second terminal while a run owns the
 * state root, so it opens the database read-only and never touches
 * `coordinator.lock`: inspecting a run must not take execution ownership or
 * create duplicate execution.
 *
 * The exit code reports whether the *command* succeeded, not whether the run
 * was accepted: a successful status of a failed run exits 0 and says
 * `failed` in its output.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listArtifacts } from '../../storage/artifacts.js';
import { openStateStore, StateNotFoundError } from '../../storage/db.js';
import { lastEventSequence, listEvents } from '../../storage/events.js';
import { SchemaTooNewError } from '../../storage/migrations.js';
import { createStatePaths, resolveStateRoot } from '../../storage/paths.js';
import { findRun, listTasks } from '../../storage/records.js';
import { listChecks } from '../../verification/checks.js';
import { redactValue } from '../../telemetry/redaction.js';
import { CliError, EXIT_CODES, statusLabel, type CommandResult } from '../output.js';

export interface StatusCommandArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly stateDir?: string;
  readonly json: boolean;
}

export const RECENT_EVENT_COUNT = 10;

function requireRunId(args: StatusCommandArgs): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', 'status requires a <run-id> argument');
  if (args.positionals.length > 1) {
    throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  }
  return runId;
}

export function commandStatus(args: StatusCommandArgs): CommandResult {
  const runId = requireRunId(args);
  const paths = createStatePaths(resolveStateRoot(args.stateDir));
  let store;
  try {
    // read-only: no lock, no migration, no writes of any kind.
    store = openStateStore(paths, { mode: 'read-only' });
  } catch (error) {
    if (error instanceof StateNotFoundError || error instanceof SchemaTooNewError) {
      throw new CliError(EXIT_CODES.invalidInput, 'state_unavailable', error.message);
    }
    throw error;
  }

  try {
    const run = findRun(store.db, runId);
    if (run === null) throw new CliError(EXIT_CODES.invalidInput, 'unknown_run', `run ${runId} not found under ${paths.root}`);

    const tasks = listTasks(store.db, runId).map((task) => ({
      id: task.id,
      objective: task.objective,
      state: task.state,
      waitReason: task.wait_reason,
      generation: task.current_generation,
      ownerAgentId: task.owner_agent_id,
    }));
    const last = lastEventSequence(store.db, runId);
    const events = listEvents(store.db, runId, { afterSequence: Math.max(0, last - RECENT_EVENT_COUNT) }).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      taskId: event.taskId,
    }));
    const artifacts = listArtifacts(store.db, runId).map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      path: artifact.relativePath,
      sha256: artifact.sha256,
      candidateRevision: artifact.candidateRevision,
    }));
    const checks = listChecks(store.db, runId).map((check) => ({
      id: check.id,
      criterionIds: JSON.parse(check.criterion_ids_json) as string[],
      command: [check.command, ...(JSON.parse(check.args_json) as string[])].join(' '),
      outcome: check.outcome,
      exitCode: check.exit_code,
      candidateRevision: check.candidate_revision,
      evidenceProvenance: check.evidence_provenance,
    }));
    const request = redactValue(JSON.parse(run.request_json) as Record<string, unknown>);

    // The manifest is a projection of persisted state; it is read, never rebuilt here.
    const manifestPath = path.join(paths.runArtifactsDir(runId), 'result.json');
    let manifest: Record<string, unknown> | null = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = redactValue(JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>);
      } catch {
        manifest = null;
      }
    }

    const requirements = (manifest?.['requirements'] as Array<{ criterionId: string; status: string; required: boolean; detail: string }> | undefined) ?? [];

    const data = {
      stateRoot: paths.root,
      readOnly: true,
      run: {
        id: run.id,
        state: run.state,
        repoPath: run.repo_path,
        baseRevision: run.base_revision,
        policy: run.policy,
        ownershipEpoch: run.ownership_epoch,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        endedAt: run.ended_at,
        request,
      },
      tasks,
      checks,
      requirements,
      events,
      artifacts,
      eventCount: last,
      manifestPath: manifest === null ? null : manifestPath,
      candidate: manifest?.['candidate'] ?? null,
      acceptance: manifest?.['acceptance'] ?? null,
      timing: manifest?.['timing'] ?? null,
      unresolved: manifest?.['unresolved'] ?? [],
    };

    const lines = [
      `run ${run.id}: ${run.state}`,
      `repo: ${run.repo_path} (base ${run.base_revision ?? 'unknown'})`,
      `tasks: ${tasks.length === 0 ? '(none)' : ''}`,
      ...tasks.map((task) => `  ${task.id} [${task.state}${task.waitReason ? `: ${task.waitReason}` : ''}] gen ${task.generation} — ${task.objective}`),
      `checks: ${checks.length === 0 ? '(none)' : ''}`,
      ...checks.map((check) => `  ${check.criterionIds.join(',')} ${check.outcome}${check.exitCode === null ? '' : ` (exit ${check.exitCode})`} — ${check.evidenceProvenance} against ${check.candidateRevision?.slice(0, 12) ?? 'unknown candidate'}`),
      ...(requirements.length > 0 ? ['requirements:'] : []),
      ...requirements.map((requirement) => `  ${statusLabel(requirement.status)} ${requirement.criterionId}${requirement.required ? '' : ' (optional)'}: ${requirement.detail}`),
      `events: ${last} recorded; last ${events.length}:`,
      ...events.map((event) => `  #${event.sequence} ${event.timestamp} ${event.type}`),
      `artifacts: ${artifacts.length === 0 ? '(none)' : ''}`,
      ...artifacts.map((artifact) => `  ${artifact.type} ${artifact.path} sha256 ${artifact.sha256.slice(0, 12)}`),
      ...((data.unresolved as string[]).length > 0 ? ['unresolved:', ...(data.unresolved as string[]).map((item) => `  - ${item}`)] : []),
    ];

    return { command: 'status', exitCode: EXIT_CODES.verifiedCandidate, data, lines };
  } finally {
    store.close();
  }
}
