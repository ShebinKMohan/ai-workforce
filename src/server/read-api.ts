/**
 * The office view's read model (FR084), assembled from the storage functions
 * the CLI already uses. Every path opens the state store read-only: no lock,
 * no migration, no write — the same guarantee `workforce status` and
 * `workforce watch` rely on while a run holds the state root.
 */
import { existsSync } from 'node:fs';
import { assessContainment, createAdapter } from '../core/run-direct.js';
import { ContractValidationError } from '../core/contracts.js';
import { loadAgentConfigFile } from '../core/config.js';
import { commandStatus } from '../cli/commands/status.js';
import { configSearchPath } from '../cli/commands/launch.js';
import { CliError, Reporter } from '../cli/output.js';
import { readinessReportForRuntime, type RuntimeReadinessReport } from '../discovery/readiness.js';
import { runtimeDescriptor } from '../discovery/runtimes.js';
import {
  ArtifactCorruptError,
  ArtifactError,
  ArtifactMissingError,
  getArtifact,
  readArtifact,
  type ArtifactRecord,
} from '../storage/artifacts.js';
import { openStateStore, StateNotFoundError, type StateStore } from '../storage/db.js';
import { lastEventCursor, lastEventSequence, listEvents } from '../storage/events.js';
import { classifyHolder, readLockInfo } from '../storage/lock.js';
import { SchemaTooNewError } from '../storage/migrations.js';
import type { StatePaths } from '../storage/paths.js';
import { DEFAULT_LIST_RUNS, findRun, listRuns, listTasks, MAX_LIST_RUNS, type RunRow } from '../storage/records.js';
import { headReviewView } from '../storage/head-review-view.js';
import { runEvidenceView } from '../storage/run-evidence.js';
import { redactText } from '../telemetry/redaction.js';
import { ApiError } from './http.js';

/** Largest artifact returned as text. Bigger ones are refused with their size, not truncated silently. */
export const MAX_ARTIFACT_TEXT_BYTES = 1024 * 1024;

/** Run and artifact ids as they appear in a URL: the same shape `paths.ts` accepts as a path segment. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Open read-only; `null` when there is no state yet. */
function withReadOnlyStore<T>(paths: StatePaths, fn: (store: StateStore) => T): T | null {
  let store: StateStore;
  try {
    store = openStateStore(paths, { mode: 'read-only' });
  } catch (error) {
    if (error instanceof StateNotFoundError) return null;
    if (error instanceof SchemaTooNewError) throw new ApiError(409, 'state_schema_too_new', error.message);
    throw error;
  }
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// GET /api/office
// ---------------------------------------------------------------------------

export interface OfficeInputs {
  readonly paths: StatePaths;
  readonly version: string;
  readonly server: { readonly pid: number; readonly startedAt: string; readonly url: string };
  readonly readiness: { readonly checkedAt: string; readonly reports: ReadonlyArray<RuntimeReadinessReport> } | { readonly error: string };
  readonly env: Readonly<Record<string, string | undefined>>;
}

function lockView(lockPath: string): Record<string, unknown> {
  let info;
  try {
    info = readLockInfo(lockPath);
  } catch {
    // An info file that cannot be read proves nothing about a holder either way.
    return { held: null, pid: null, acquiredAt: null, holder: 'unreadable' };
  }
  if (info === null) return { held: false, pid: null, acquiredAt: null, holder: null };
  const holder = classifyHolder(info);
  // The lock's own token is deliberately not forwarded.
  return { held: holder === 'alive' || holder === 'unverifiable', pid: info.pid, acquiredAt: info.acquiredAt, holder };
}

/**
 * The lock as it stood around a read of the rows. It is read before the rows
 * and, when it was free then, again after: a run that started during the read
 * holds it by then. Only a lock free both times reaches the page as
 * `held: false`, the one value that lets the page say no coordinator is
 * running the runs whose rows still say they are live.
 */
function lockAround<T>(lockPath: string, read: () => T): { lock: Record<string, unknown>; value: T } {
  const before = lockView(lockPath);
  const value = read();
  return { lock: before['held'] === false ? lockView(lockPath) : before, value };
}

function runtimeView(report: RuntimeReadinessReport): Record<string, unknown> {
  return {
    adapter: report.adapter,
    displayName: report.displayName,
    // The documented sign-in command, so a signed-out runtime can say how to fix it.
    loginHint: runtimeDescriptor(report.adapter).loginHint,
    installed: report.installed,
    adapterSupported: report.adapterSupported,
    controllable: report.controllable,
    readiness: report.readiness,
    probeKind: report.probeKind,
    auth: report.auth,
    authDetail: report.authDetail,
    version: report.version,
    executable: report.executable,
    writingModeAvailable: report.writingModeAvailable,
    missingWriteBoundary: report.missingWriteBoundary,
    checkedAt: report.checkedAt,
    diagnostics: report.diagnostics,
  };
}

/**
 * Configured agents, passive runtime readiness and the coordinator's identity.
 *
 * The agent configuration is found the way `workforce run` finds it, minus
 * the repository's own `.workforce/agents.json` — there is no repository until
 * a start request names one, and a run consults that file after these.
 */
export function officeDocument(input: OfficeInputs): Record<string, unknown> {
  const { paths } = input;
  const searched = configSearchPath({ env: input.env, repoRoot: paths.root, stateRoot: paths.root, homeDir: paths.root }).filter(
    (candidate) => candidate.source !== 'the repository',
  );
  const found = searched.find((candidate) => existsSync(candidate.path));
  const reports = 'reports' in input.readiness ? input.readiness.reports : [];

  let configuration: Record<string, unknown> = { found: false, path: null, source: null, searched: searched.map((candidate) => candidate.path), error: null, defaults: null };
  let agents: Array<Record<string, unknown>> = [];
  if (found !== undefined) {
    try {
      const loaded = loadAgentConfigFile(found.path);
      configuration = { ...configuration, found: true, path: loaded.path, source: found.source, defaults: loaded.config.defaults };
      agents = loaded.config.agents.map((agent) => {
        const runtime = loaded.config.runtimes[agent.runtime]!;
        const report = readinessReportForRuntime(reports, agent.runtime, runtime);
        // What the coordinator's own gate would say about this binding, from
        // the adapter's declared capability and the passively observed version.
        const containment = assessContainment(
          createAdapter({ id: agent.runtime, adapter: runtime.adapter, executable: runtime.executable }),
          agent.policy,
          false,
          report?.version ?? null,
        );
        return {
          id: agent.id,
          runtime: agent.runtime,
          adapter: runtime.adapter,
          executable: runtime.executable,
          model: agent.model ?? runtime.model ?? null,
          effort: agent.effort ?? runtime.effort ?? null,
          policy: agent.policy,
          capabilities: agent.capabilities,
          instructions: agent.instructions,
          isDefaultWorker: loaded.config.defaults.workerAgent === agent.id,
          isDefaultPlanner: loaded.config.defaults.plannerAgent === agent.id,
          runtimeReadiness: report?.readiness ?? (runtime.adapter === 'fake' ? 'fake_test_runtime' : 'unknown'),
          writeBoundary: {
            writes: containment.writes,
            status: containment.status,
            unconfinedWrites: containment.unconfinedWrites,
            untestedVersion: containment.untestedVersion,
            // The run refuses both an unsupported boundary and one established
            // against another build unless --allow-unconfined-writes is given.
            requiresAllowUnconfinedWrites: containment.unconfinedWrites || containment.untestedVersion,
          },
        };
      });
    } catch (error) {
      if (!(error instanceof ContractValidationError)) throw error;
      configuration = {
        ...configuration,
        found: true,
        path: found.path,
        source: found.source,
        error: { message: `agent configuration ${found.path} is invalid`, issues: error.issues },
      };
    }
  }

  return {
    ok: true,
    officeVersion: 1,
    coordinator: {
      name: 'workforce',
      version: input.version,
      stateRoot: paths.root,
      stateFound: existsSync(paths.databasePath),
      lock: lockView(paths.lockPath),
      server: { ...input.server, readOnlyDatabase: true },
    },
    configuration,
    agents,
    runtimes:
      'reports' in input.readiness
        ? { passive: true, checkedAt: input.readiness.checkedAt, reports: input.readiness.reports.map(runtimeView), error: null }
        : { passive: true, checkedAt: null, reports: [], error: input.readiness.error },
  };
}

// ---------------------------------------------------------------------------
// GET /api/runs
// ---------------------------------------------------------------------------

export function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_LIST_RUNS;
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIST_RUNS) {
    throw new ApiError(400, 'invalid_limit', `limit must be an integer from 1 to ${MAX_LIST_RUNS}`);
  }
  return Number(value);
}


function runSummary(store: StateStore, run: RunRow): Record<string, unknown> {
  const tasks = listTasks(store.db, run.id);
  const facts = runEvidenceView(store, run.id, tasks);
  const byState: Record<string, number> = {};
  for (const task of tasks) byState[task.state] = (byState[task.state] ?? 0) + 1;
  let text: string | null = null;
  try {
    const request = JSON.parse(run.request_json) as { text?: unknown };
    if (typeof request.text === 'string') text = request.text;
  } catch {
    text = null;
  }
  return {
    id: run.id,
    state: run.state,
    ...headReviewView(store.db, run.id),
    repoPath: run.repo_path,
    baseRevision: run.base_revision,
    policy: run.policy,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    endedAt: run.ended_at,
    request: { text },
    tasks: { total: tasks.length, byState, agents: [...new Set(tasks.map((task) => task.owner_agent_id).filter((id): id is string => id !== null))] },
    taskViews: facts.taskViews,
    // How the run ended and why, from its manifest; null while it has none.
    outcome: facts.outcome,
    compromisedReceiptIds: facts.compromisedReceiptIds,
    unverifiedReceiptIds: facts.unverifiedReceiptIds,
    evidenceIssues: facts.evidenceIssues,
    eventCount: lastEventSequence(store.db, run.id),
  };
}

/**
 * Newest first, bounded. `eventCursor` is where a live stream should start to
 * see only what comes next. `coordinator.lock` is the lock as it stood around
 * this read: rows keep saying `running` after the process that owned them has
 * died, and only the lock says whether a coordinator is still there.
 */
export function runsDocument(paths: StatePaths, limit: number): Record<string, unknown> {
  const { lock, value } = lockAround(paths.lockPath, () =>
    withReadOnlyStore(paths, (store) => ({ eventCursor: lastEventCursor(store.db), runs: listRuns(store.db, { limit }).map((run) => runSummary(store, run)) })),
  );
  const coordinator = { lock };
  if (value === null) return { ok: true, stateFound: false, limit, eventCursor: 0, coordinator, runs: [] };
  return { ok: true, stateFound: true, limit, eventCursor: value.eventCursor, coordinator, runs: value.runs };
}

// ---------------------------------------------------------------------------
// GET /api/runs/:id
// ---------------------------------------------------------------------------

/**
 * Exactly the document `workforce status <id> --json` prints: the same
 * command, through the same JSON reporter, captured instead of written to a
 * terminal. Two renderings of one run cannot drift if there is only one.
 */
export function runStatusJson(stateRoot: string, runId: string): string {
  let stdout = '';
  const capture = {
    write(chunk: string | Uint8Array) {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const discard = { write: () => true } as unknown as NodeJS.WritableStream;
  try {
    new Reporter(true, { stdout: capture, stderr: discard }).result(commandStatus({ positionals: [runId], stateDir: stateRoot, json: true }));
  } catch (error) {
    if (error instanceof CliError) {
      const status = error.code === 'unknown_run' || error.code === 'state_unavailable' ? 404 : 400;
      throw new ApiError(status, error.code, error.message, error.details);
    }
    throw error;
  }
  return stdout;
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/runs/:runId/events, GET /api/runs/:id/events
// ---------------------------------------------------------------------------

/** Events per page of the run events route, and the most one page may hold. */
export const DEFAULT_RUN_EVENTS = 2_000;
export const MAX_RUN_EVENTS = 5_000;

function parseCount(value: string | null, name: string, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d{1,15}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ApiError(400, `invalid_${name}`, `${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

/**
 * Every recorded event of one run, in sequence order, a page at a time:
 * `after` is the last sequence already read (0 for the start), `limit` the page
 * size. The status document carries only the newest ten; a page that shows how
 * a task moved needs all of them. Payloads go through the same redaction as
 * every other JSON response.
 */
export function runEventsDocument(paths: StatePaths, runId: string, query: URLSearchParams): Record<string, unknown> {
  const after = parseCount(query.get('after'), 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseCount(query.get('limit'), 'limit', DEFAULT_RUN_EVENTS, 1, MAX_RUN_EVENTS);
  const document = withReadOnlyStore(paths, (store) => {
    if (findRun(store.db, runId) === null) throw new ApiError(404, 'unknown_run', `run ${runId} not found under ${paths.root}`);
    const lastSequence = lastEventSequence(store.db, runId);
    const events = listEvents(store.db, runId, { afterSequence: after, limit }).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      taskId: event.taskId,
      attemptId: event.attemptId,
      payload: event.payload,
      payloadRef: event.payloadRef,
    }));
    const next = events.length === 0 ? after : events[events.length - 1]!.sequence;
    return { ok: true, runId, after, limit, lastSequence, hasMore: next < lastSequence, events };
  });
  if (document === null) throw new ApiError(404, 'state_unavailable', `no coordinator state at ${paths.databasePath}`);
  return document;
}

// ---------------------------------------------------------------------------
// GET /api/runs/:id/artifacts/:artifactId
// ---------------------------------------------------------------------------

function artifactView(record: ArtifactRecord): Record<string, unknown> {
  return {
    id: record.id,
    runId: record.runId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    type: record.type,
    path: record.relativePath,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    baseRevision: record.baseRevision,
    candidateRevision: record.candidateRevision,
    createdAt: record.createdAt,
  };
}

/**
 * One text artifact — a patch, a check log, a summary — hash-verified on read.
 *
 * Bounded and text-only: a larger artifact is refused with its size, a binary
 * one as not text. A missing or corrupted artifact is reported as exactly that,
 * because either one invalidates the acceptance that depended on it. Text is
 * redacted before it leaves the process, and the response says whether
 * anything was.
 */
export function artifactDocument(paths: StatePaths, runId: string, artifactId: string): Record<string, unknown> {
  const document = withReadOnlyStore(paths, (store) => {
    if (findRun(store.db, runId) === null) throw new ApiError(404, 'unknown_run', `run ${runId} not found under ${paths.root}`);
    const unknown = new ApiError(404, 'unknown_artifact', `artifact ${artifactId} is not recorded for run ${runId}`);
    let record: ArtifactRecord;
    try {
      record = getArtifact(store.db, artifactId);
    } catch (error) {
      if (error instanceof ArtifactError) throw unknown;
      throw error;
    }
    if (record.runId !== runId) throw unknown;
    if (record.sizeBytes > MAX_ARTIFACT_TEXT_BYTES) {
      throw new ApiError(413, 'artifact_too_large', `artifact ${record.relativePath} is ${record.sizeBytes} bytes; the office view returns text artifacts up to ${MAX_ARTIFACT_TEXT_BYTES} bytes`);
    }
    let bytes: Buffer;
    try {
      bytes = readArtifact(store.db, paths, artifactId).bytes;
    } catch (error) {
      if (error instanceof ArtifactMissingError) throw new ApiError(410, 'artifact_missing', error.message);
      if (error instanceof ArtifactCorruptError) throw new ApiError(409, 'artifact_corrupt', error.message);
      throw error;
    }
    const notText = new ApiError(415, 'artifact_not_text', `artifact ${record.relativePath} is not UTF-8 text`);
    if (bytes.includes(0)) throw notText;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw notText;
    }
    const redacted = redactText(text);
    return { ok: true, artifact: artifactView(record), encoding: 'utf-8', redacted: redacted !== text, text: redacted };
  });
  if (document === null) throw new ApiError(404, 'state_unavailable', `no coordinator state at ${paths.databasePath}`);
  return document;
}
