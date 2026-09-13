/**
 * `POST /api/requests` — sending work to a department, and the queue that
 * decides when it starts.
 *
 * A request names a project and a department. It is validated the way
 * `workforce run --project --department` would validate it (the roster, the
 * project folder, its acceptance checks, passive runtime readiness and the
 * unconfined-writes consent), then either started or queued. Starting it is
 * exactly one `workforce run --json --project=<id> --department=<id>
 * --task=<text>` process, spawned with an argument array and `shell: false`;
 * the engine is never reached any other way. Resuming a project run is one
 * `workforce resume <run-id> --json --state-dir=<project state root>` process
 * and goes through the same queue.
 *
 * When a queued item may start, in receipt order:
 *
 * 1. **One live run per project.** A project's runs share its coordinator lock,
 *    so a second request waits: "waiting: another task is running on checkout".
 *    Requests for one project start in the order they arrived.
 * 2. **Runs on its own (decision Q2).** A roster with any agent on a runtime
 *    whose write containment is not verified (Claude Code today, for every
 *    policy) starts only when no other project run is live, and nothing starts
 *    beside it: "waiting: a Claude Code task runs on its own". Once such a
 *    request is waiting, requests that arrived after it wait too, so it is not
 *    starved.
 * 3. **The global cap**, `limits.maxConcurrentProjectRuns`.
 * 4. **A worker is never in two live runs**: "waiting: probe is busy on billing-api".
 *
 * A run started outside this page (a terminal) counts as live from its project
 * lock. Its roster is read from its recorded configuration; when that cannot be
 * read, it is treated as running on its own, because isolation is the rule and
 * nothing here can prove otherwise.
 *
 * The queue is persisted under `<state-root>/serve/requests.json`, and the
 * intent to start is written before the process is spawned. Items still queued
 * when a server stopped become `held` when the next server takes the queue: they
 * start only when someone presses Start, never on their own. A run process is
 * detached and outlives this server; stop sends SIGINT to its tracked pid, which
 * stops it the way Ctrl+C would.
 */
import { type ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validateAgentConfig, ModelSchema, EffortSchema, RuntimeIdSchema, RuntimeConfigSchema, type RuntimeConfig, type AgentConfigFile } from '../core/contracts.js';
import { newId, nowIso, randomToken } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { isProcessAlive, isProcessGroupAlive, matchProcessIdentity, observeProcessStartMs, ProcessIdentitySchema } from '../core/process.js';
import { assessContainment, createAdapter } from '../core/run-direct.js';
import { isToolUsable, toolFactForRuntime, ControlCenterConfigSchema, type ControlCenterConfig, type WorkspaceConfig } from '../core/workspace-config.js';
import { controlRuntimeId, controlRoutingExclusive, directControlRoute, RouteDecisionSchema, routeControlRequest, type ControlIntakeInput, type ControlIntakeResult } from '../routing/control-intake.js';
import { readinessReportForRuntime, type RuntimeReadinessReport } from '../discovery/readiness.js';
import { openStateStore, StateNotFoundError } from '../storage/db.js';
import { acquireCoordinatorLock, classifyHolder, LockHeldError, readLockInfo, type CoordinatorLock, type LockInfo } from '../storage/lock.js';
import { findRun, listRuns } from '../storage/records.js';
import { WorkspaceError } from '../workspace/errors.js';
import { projectHasLiveRun, projectStateRoot, projectStatePaths } from '../workspace/paths.js';
import { resolveProjectChecks, toolFacts } from '../workspace/readiness.js';
import { adapterWriteContainment, buildRoster, rosterAgentIds, type Roster } from '../workspace/roster.js';
import { loadWorkspace } from '../workspace/store.js';
import { AttachmentDescriptorSchema, AttachmentIdsSchema, resolveAttachments } from './attachments.js';
import type { RuntimeAttachment } from '../adapters/types.js';
import { validateAttachments } from '../adapters/attachments.js';
import { ApiError } from './http.js';
import { defaultCliInvocation, MAX_TASK_CHARS, type CliInvocation, type Spawner } from './launch.js';
import { projectRootIds, readableProjectPaths } from './project-reads.js';
import { ID_PATTERN } from './read-api.js';
import { httpErrorFromWorkspace, invalidBody, readWorkspace, type PassiveReadiness } from './workspace-api.js';

export const SERVE_DIR_NAME = 'serve';
export const REQUESTS_FILE_NAME = 'requests.json';
export const DEFAULT_QUEUE_POLL_MS = 1_000;
/** Ended, failed and discarded items kept in the file; waiting, live, and
 * unresolved routing-session ownership records are always kept. */
export const MAX_FINISHED_ITEMS = 200;

export const HELD_REASON = 'held: this request was still waiting when the page server stopped, so it was not started. Start it or discard it.';

const noNul = (value: string): boolean => !value.includes('\0');
export const ControlSelectionSchema = z.strictObject({
  runtime: RuntimeIdSchema,
  model: ModelSchema.refine((value) => !/[\r\n\0]/.test(value)).optional(),
  effort: EffortSchema.refine((value) => !/[\r\n\0]/.test(value)).optional(),
});
const controlSelectionKey = (selection?: z.infer<typeof ControlSelectionSchema>) => JSON.stringify(selection ? [selection.runtime, selection.model ?? null, selection.effort ?? null] : null);

export const RequestBodySchema = z.strictObject({
  /** One logical composer submission. Retrying it must not start another paid turn. */
  clientRequestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).optional(),
  projectId: z.string().min(1).max(64),
  departmentId: z.string().min(1).max(64).optional(),
  controlCenter: ControlSelectionSchema.optional(),
  attachmentIds: AttachmentIdsSchema.optional(),
  task: z
    .string()
    .max(MAX_TASK_CHARS)
    .refine((value) => value.trim().length > 0, 'task text is empty')
    .refine(noNul, 'must not contain a NUL character'),
  allowUnconfinedWrites: z.boolean().optional(),
});

export const ResumeBodySchema = z.strictObject({ allowUnconfinedWrites: z.boolean().optional() });
export const EmptyBodySchema = z.strictObject({});

export const REQUEST_STATES = ['queued', 'held', 'starting', 'running', 'ended', 'failed_to_start', 'discarded'] as const;

const ResultSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  details: z.array(z.string()),
});

export const RequestItemSchema = z.strictObject({
  id: z.string().min(1),
  /** Optional for queues written before submission deduplication was added. */
  clientRequestId: z.string().min(1).max(128).optional(),
  /** Original routing override, before automatic intake selected a department. */
  submittedDepartmentId: z.string().nullable().optional(),
  submittedControlCenter: ControlSelectionSchema.optional(),
  attachments: z.array(AttachmentDescriptorSchema).max(8).optional(),
  /** Frozen orchestration settings and executable. Department bindings are separate. */
  controlCenter: ControlCenterConfigSchema.optional(),
  controlRuntime: RuntimeConfigSchema.optional(),
  route: RouteDecisionSchema.optional(),
  controlReply: z.string().optional(),
  admissionReady: z.boolean().optional(),
  admittedWorkspaceRevision: z.number().int().optional(),
  approvedRosterHash: z.string().optional(),
  admissionElapsedMs: z.number().nonnegative().optional(),
  routingSession: z.strictObject({ sessionId: z.string(), process: ProcessIdentitySchema.nullable(), processId: z.number().int().positive().nullable().optional(), state: z.enum(['running', 'stopped', 'unknown']) }).optional(),
  kind: z.enum(['request', 'resume']),
  projectId: z.string().min(1),
  departmentId: z.string().nullable(),
  task: z.string().nullable(),
  resumeRunId: z.string().nullable(),
  allowUnconfinedWrites: z.boolean(),
  state: z.enum(REQUEST_STATES),
  /** The plain reason an item is waiting, held or stopping; null otherwise. */
  reason: z.string().nullable(),
  receivedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  heldAt: z.string().nullable(),
  agentIds: z.array(z.string()),
  workerIds: z.array(z.string()),
  exclusive: z.boolean(),
  /** Display names of the runtimes that make the roster run on its own, e.g. "Claude Code". */
  unconfinedRuntimes: z.array(z.string()),
  launchId: z.string().nullable(),
  pid: z.number().int().nullable(),
  pidStartedAtMs: z.number().nullable(),
  stdoutPath: z.string().nullable(),
  stderrPath: z.string().nullable(),
  runId: z.string().nullable(),
  stopRequestedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  /** What the process printed as its result: its exit code and, on a refusal, its error. Never a verdict of this server's own. */
  result: ResultSchema.nullable(),
});
export type RequestItem = z.infer<typeof RequestItemSchema>;

const QueueFileSchema = z.strictObject({ schemaVersion: z.literal(1), items: z.array(RequestItemSchema) });

const LIVE_STATES: ReadonlySet<RequestItem['state']> = new Set(['starting', 'running']);
const WAITING_STATES: ReadonlySet<RequestItem['state']> = new Set(['queued', 'held']);

export function runtimeLabel(adapter: string): string {
  if (adapter === 'codex') return 'Codex';
  if (adapter === 'claude-code') return 'Claude Code';
  if (adapter === 'fake') return 'test runtime';
  return adapter;
}

export interface RequestQueueOptions {
  readonly stateRoot: string;
  /** Pass `--state-dir=<stateRoot>` to `workforce run`: only when the server itself was given a state root. */
  readonly passStateDir: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly spawner?: Spawner;
  readonly invocation?: CliInvocation;
  readonly pollMs?: number;
  readonly readiness: () => Promise<PassiveReadiness>;
  /** Injectable classification only; it never launches project work. */
  readonly routeControl?: (input: ControlIntakeInput) => Promise<ControlIntakeResult>;
  readonly validateControl?: (settings: ControlCenterConfig, runtime: RuntimeConfig, reports: ReadonlyArray<RuntimeReadinessReport>, attachments?: ReadonlyArray<RuntimeAttachment>) => Promise<void>;
}

/** A project run that is live now, from this server's queue or from a project lock. */
interface LiveRun {
  readonly projectId: string;
  readonly requestId: string | null;
  readonly pid: number | null;
  readonly workerIds: ReadonlySet<string>;
  readonly exclusive: boolean;
  readonly label: string | null;
  /** False when a run started elsewhere could not be read; it is then treated as running on its own. */
  readonly known: boolean;
}

interface RosterFacts {
  readonly agentIds: string[];
  readonly workerIds: string[];
  readonly exclusive: boolean;
  readonly unconfinedRuntimes: string[];
}

function uniqueLabels(adapters: ReadonlyArray<string>): string[] {
  return [...new Set(adapters.map(runtimeLabel))];
}

function exclusiveRuntime(runtimeId: string, runtime: AgentConfigFile['runtimes'][string] | undefined, reports?: ReadonlyArray<RuntimeReadinessReport> | null): boolean {
  if (runtime === undefined || adapterWriteContainment(runtime.adapter) !== 'verified') return true;
  if (reports === undefined) return false;
  const report = readinessReportForRuntime(reports ?? [], runtimeId, runtime);
  return assessContainment(createAdapter({ id: runtimeId, ...runtime }), 'local-development', false, report?.version ?? null).untestedVersion;
}

function workspaceRosterFacts(config: WorkspaceConfig, roster: Roster, reports?: ReadonlyArray<RuntimeReadinessReport> | null): RosterFacts {
  const agents = [roster.head, ...roster.workers];
  const unconfined = agents.filter((agent) => exclusiveRuntime(agent.runtime, config.runtimes[agent.runtime], reports)).map((agent) => config.runtimes[agent.runtime]?.adapter ?? agent.runtime);
  return { agentIds: rosterAgentIds(roster), workerIds: roster.workers.map((worker) => worker.id), exclusive: unconfined.length > 0, unconfinedRuntimes: uniqueLabels(unconfined) };
}

/** The same facts from a recorded v1 configuration (a roster snapshot or a run's config snapshot). */
function snapshotRosterFacts(config: AgentConfigFile, reports?: ReadonlyArray<RuntimeReadinessReport> | null): RosterFacts {
  const planner = config.defaults.plannerAgent;
  const unconfined = config.agents.filter((agent) => exclusiveRuntime(agent.runtime, config.runtimes[agent.runtime], reports)).map((agent) => config.runtimes[agent.runtime]?.adapter ?? agent.runtime);
  return {
    agentIds: config.agents.map((agent) => agent.id),
    workerIds: config.agents.filter((agent) => agent.id !== planner).map((agent) => agent.id),
    exclusive: unconfined.length > 0,
    unconfinedRuntimes: uniqueLabels(unconfined),
  };
}

interface ConsentAgent {
  readonly agentId: string;
  readonly name: string;
  readonly runtime: string;
  readonly adapter: string;
  readonly policy: string;
  readonly writeContainment: string;
  readonly installedVersion: string | null;
  readonly testedVersion: string | null;
  readonly line: string;
}

/** Agents whose run the coordinator refuses without `--allow-unconfined-writes`, by the coordinator's own gate. */
function consentNeeded(
  agents: ReadonlyArray<{ id: string; name?: string; runtime: string; policy: AgentConfigFile['agents'][number]['policy'] }>,
  runtimes: AgentConfigFile['runtimes'],
  reports: ReadonlyArray<RuntimeReadinessReport> | null,
): ConsentAgent[] {
  return agents.flatMap((agent) => {
    const runtime = runtimes[agent.runtime];
    if (runtime === undefined) return [];
    const report = readinessReportForRuntime(reports ?? [], agent.runtime, runtime);
    const containment = assessContainment(createAdapter({ id: agent.runtime, adapter: runtime.adapter, executable: runtime.executable }), agent.policy, false, report?.version ?? null);
    if (!containment.unconfinedWrites && !containment.untestedVersion) return [];
    const name = agent.name ?? agent.id;
    const line = containment.unconfinedWrites
      ? `${name} changes files on ${runtimeLabel(runtime.adapter)}, which has no file boundary`
      : `${name} changes files on ${runtimeLabel(runtime.adapter)} ${containment.installedVersion ?? '(version not read)'}, but its file boundary was established on ${containment.testedVersion ?? 'no stated version'}`;
    return [
      {
        agentId: agent.id,
        name,
        runtime: agent.runtime,
        adapter: runtime.adapter,
        policy: agent.policy,
        writeContainment: containment.status,
        installedVersion: containment.installedVersion,
        testedVersion: containment.testedVersion,
        line,
      },
    ];
  });
}

interface StdoutTail {
  offset: number;
  partial: Buffer;
  runId: string | null;
  final: Record<string, unknown> | null;
}

export class RequestQueue {
  private readonly root: string;
  private readonly file: string;
  private readonly lockPath: string;
  private readonly spawner: Spawner;
  private readonly invocation: CliInvocation;
  private items: RequestItem[] = [];
  private readonly handles = new Map<string, ChildProcess>();
  private readonly tails = new Map<string, StdoutTail>();
  private lock: CoordinatorLock | null = null;
  /** Why this server does not manage the queue (another server does); null when it does or can. */
  private ownerRefusal: string | null = null;
  /** Set when a queue file could not be read and was set aside. */
  private notice: string | null = null;
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private routing: { id: string; controller: AbortController; exclusive: boolean } | null = null;
  private reports: ReadonlyArray<RuntimeReadinessReport> | null = null;
  private readonly directRouting = new Set<string>();

  constructor(private readonly options: RequestQueueOptions) {
    this.root = path.resolve(options.stateRoot);
    this.file = path.join(this.root, SERVE_DIR_NAME, REQUESTS_FILE_NAME);
    this.lockPath = path.join(this.root, SERVE_DIR_NAME, 'requests.lock');
    this.spawner = options.spawner ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.invocation = options.invocation ?? defaultCliInvocation();
    // A queue a previous server left behind is taken now, so its waiting items show as held at once.
    if (existsSync(this.file)) this.takeOwnership();
    this.timer = setInterval(() => this.tick(), options.pollMs ?? DEFAULT_QUEUE_POLL_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.routing?.controller.abort();
    this.lock?.release();
    this.lock = null;
  }

  // ---- ownership and persistence --------------------------------------------

  private takeOwnership(): boolean {
    if (this.lock !== null) return true;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      this.lock = acquireCoordinatorLock(this.lockPath);
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
      this.ownerRefusal = `another workforce serve process manages the request queue of ${this.root}; use the page that process serves, or stop it first`;
      return false;
    }
    this.ownerRefusal = null;
    this.items = this.readItems(true);
    const now = nowIso();
    for (const item of this.items) {
      const routing = item.routingSession;
      if (routing !== undefined && routing.state !== 'stopped') {
        routing.state = 'unknown';
        if (routing.process !== null && matchProcessIdentity(routing.process) === 'alive') {
          try { process.kill(-routing.process.pid, 'SIGTERM'); } catch { /* identity remains guarded until a poll proves it is gone */ }
        }
      }
      if (item.state === 'queued') {
        item.state = 'held';
        item.heldAt = now;
        item.reason = HELD_REASON;
      } else if (LIVE_STATES.has(item.state)) {
        this.scan(item);
        if (this.processGone(item)) this.finalize(item, null, null, false);
      }
    }
    this.persist();
    return true;
  }

  private ensureOwner(): void {
    if (this.closed) throw new ApiError(503, 'server_closing', 'the page server is stopping');
    if (!this.takeOwnership()) throw new ApiError(409, 'queue_managed_elsewhere', this.ownerRefusal ?? 'another server manages the request queue');
  }

  private readItems(setAsideInvalid: boolean): RequestItem[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    let parsed: ReturnType<typeof QueueFileSchema.safeParse> | null = null;
    try {
      parsed = QueueFileSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (parsed !== null && parsed.success) return parsed.data.items;
    if (setAsideInvalid) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      renameSync(this.file, aside);
      this.notice = `the request queue file could not be read, so it was set aside as ${aside}; nothing in it was started`;
    }
    return [];
  }

  private persist(): void {
    const finished = this.items.filter((item) => !LIVE_STATES.has(item.state) && !WAITING_STATES.has(item.state) &&
      (item.routingSession === undefined || item.routingSession.state === 'stopped'));
    if (finished.length > MAX_FINISHED_ITEMS) {
      const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED_ITEMS).map((item) => item.id));
      this.items = this.items.filter((item) => !drop.has(item.id));
    }
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(QueueFileSchema.parse({ schemaVersion: 1, items: this.items }), null, 2)}\n`;
    const temp = `${this.file}.${randomToken(8)}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
  }

  // ---- process observation ----------------------------------------------------

  /** Read what the process printed since the last look: the recorded run id, and its final result document. */
  private scan(item: RequestItem): StdoutTail {
    let tail = this.tails.get(item.id);
    if (tail === undefined) {
      tail = { offset: 0, partial: Buffer.alloc(0), runId: null, final: null };
      this.tails.set(item.id, tail);
    }
    if (item.stdoutPath === null) return tail;
    let fd: number;
    try {
      fd = openSync(item.stdoutPath, 'r');
    } catch {
      return tail;
    }
    try {
      const size = fstatSync(fd).size;
      if (size > tail.offset) {
        const chunk = Buffer.alloc(size - tail.offset);
        readSync(fd, chunk, 0, chunk.length, tail.offset);
        tail.offset = size;
        let buffer = Buffer.concat([tail.partial, chunk]);
        for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a)) {
          const line = buffer.subarray(0, newline).toString('utf8');
          buffer = buffer.subarray(newline + 1);
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
          const object = record as Record<string, unknown>;
          if (tail.runId === null && object['type'] === 'run.created' && typeof object['runId'] === 'string') tail.runId = object['runId'];
          if ('ok' in object) tail.final = object;
        }
        tail.partial = Buffer.from(buffer);
      }
    } finally {
      closeSync(fd);
    }
    if (item.runId === null && tail.runId !== null) {
      item.runId = tail.runId;
      if (item.state === 'starting') item.state = 'running';
    }
    return tail;
  }

  /** For a process this server did not spawn (it survived a restart): gone, or its pid now belongs to someone else. */
  private processGone(item: RequestItem): boolean {
    if (this.handles.has(item.id)) return false;
    if (item.pid === null) return true;
    // Printing a result is not evidence that the process has stopped. After a
    // server restart we must keep its worker and exclusive-runtime reservations
    // until its process identity is actually gone, just as an owned child keeps
    // its reservations until the exit event.
    if (item.pidStartedAtMs !== null) {
      const status = matchProcessIdentity({ pid: item.pid, startedAtMs: item.pidStartedAtMs });
      return status === 'dead' || status === 'pid_reused';
    }
    return !isProcessAlive(item.pid);
  }

  private finalize(item: RequestItem, code: number | null, signal: string | null, pump = true): void {
    const tail = this.scan(item);
    const final = tail.final;
    const printedExit = typeof final?.['exitCode'] === 'number' ? (final['exitCode'] as number) : null;
    item.state = 'ended';
    item.endedAt = nowIso();
    item.exitCode = code ?? printedExit;
    item.signal = signal;
    item.reason = null;
    if (item.runId === null && typeof final?.['runId'] === 'string') item.runId = final['runId'] as string;
    const error = final?.['error'] as { code?: unknown; message?: unknown; details?: unknown } | undefined;
    item.result =
      final === null
        ? {
            exitCode: item.exitCode,
            code: null,
            message:
              item.exitCode === null
                ? `the process ended${signal !== null ? ` on ${signal}` : ''} without printing a result`
                : `the process exited ${item.exitCode} without printing a result`,
            details: item.stderrPath === null ? [] : [`stderr: ${item.stderrPath}`],
          }
        : {
            exitCode: printedExit ?? item.exitCode,
            code: typeof error?.code === 'string' ? error.code : null,
            message: typeof error?.message === 'string' ? error.message : null,
            details: Array.isArray(error?.details) ? error.details.filter((entry): entry is string => typeof entry === 'string') : [],
          };
    if (typeof final?.['finalReply'] === 'string') item.controlReply = final['finalReply'];
    else if (item.result.message !== null) item.controlReply = item.result.message;
    this.handles.delete(item.id);
    this.tails.delete(item.id);
    if (pump) {
      this.persist();
      this.pump();
      this.queueRouting();
    }
  }

  private tick(): void {
    if (this.closed || this.lock === null) return;
    try {
      let changed = false;
      for (const item of this.items) {
        const routing = item.routingSession;
        if (routing?.state === 'unknown' && routing.process !== null && !isProcessGroupAlive(routing.process.pid) && ['dead', 'pid_reused'].includes(matchProcessIdentity(routing.process))) {
          routing.state = 'stopped'; changed = true;
        }
        if (!LIVE_STATES.has(item.state)) continue;
        const before = item.state;
        this.scan(item);
        if (item.state !== before) changed = true;
        if (this.processGone(item)) {
          this.finalize(item, null, null, false);
          changed = true;
        }
      }
      if (changed) this.persist();
      this.pump();
      this.queueRouting();
    } catch {
      // A failed poll is retried on the next one; the file and the processes are the truth.
    }
  }

  // ---- admission ----------------------------------------------------------------

  /** The newest recorded configuration of a run holding a project's lock, when it can be read. */
  private externalRosterFacts(projectId: string, info: LockInfo): RosterFacts | null {
    const paths = projectStatePaths(this.root, projectId);
    const candidates: unknown[] = [];
    const acquired = Date.parse(info.acquiredAt);
    try {
      const store = openStateStore(paths, { mode: 'read-only' });
      try {
        // Interrupted/crashed runs can remain pending or running in history.
        // Their rosters do not describe a later process holding this lock.
        const active = listRuns(store.db, { limit: 20 }).find(
          (run) => (run.state === 'pending' || run.state === 'running' || run.state === 'waiting') && Number.isFinite(acquired) && Date.parse(run.updated_at) >= acquired,
        );
        if (active !== undefined) candidates.push((JSON.parse(readFileSync(paths.runConfigSnapshotPath(active.id), 'utf8')) as { raw?: unknown }).raw);
      } finally {
        store.close();
      }
    } catch {
      // not readable: fall through to the roster snapshots
    }
    try {
      const dir = path.join(paths.root, 'rosters');
      const newest = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ file: path.join(dir, name), mtime: statSync(path.join(dir, name)).mtimeMs }))
        .filter((entry) => Number.isFinite(acquired) && entry.mtime >= acquired)
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest !== undefined) candidates.push(JSON.parse(readFileSync(newest.file, 'utf8')));
    } catch {
      // no roster snapshots
    }
    for (const candidate of candidates) {
      try {
        return snapshotRosterFacts(validateAgentConfig(candidate));
      } catch {
        // try the next one
      }
    }
    return null;
  }

  private liveRuns(workspace: WorkspaceConfig | null, items: ReadonlyArray<RequestItem> = this.items): LiveRun[] {
    const own: LiveRun[] = items
      .filter((item) => LIVE_STATES.has(item.state))
      .map((item) => ({
        projectId: item.projectId,
        requestId: item.id,
        pid: item.pid,
        workerIds: new Set(item.workerIds),
        exclusive: item.exclusive,
        label: item.unconfinedRuntimes[0] ?? null,
        known: true,
      }));
    const ownPids = new Set(own.map((run) => run.pid).filter((pid): pid is number => pid !== null));
    const ownProjects = new Set(own.map((run) => run.projectId));
    const ids = new Set([...(workspace?.projects.map((project) => project.id) ?? []), ...projectRootIds(this.root)]);
    const external: LiveRun[] = [];
    for (const projectId of ids) {
      if (ownProjects.has(projectId)) continue;
      let info: LockInfo | null;
      try {
        info = readLockInfo(projectStatePaths(this.root, projectId).lockPath);
      } catch {
        continue;
      }
      if (info === null) continue;
      const holder = classifyHolder(info);
      if (holder !== 'alive' && holder !== 'unverifiable') continue;
      if (ownPids.has(info.pid)) continue;
      const facts = this.externalRosterFacts(projectId, info);
      external.push({
        projectId,
        requestId: null,
        pid: info.pid,
        workerIds: new Set(facts?.workerIds ?? []),
        exclusive: facts === null ? true : facts.exclusive,
        label: facts?.unconfinedRuntimes[0] ?? null,
        known: facts !== null,
      });
    }
    return [...own, ...external];
  }

  private pump(): void {
    if (this.closed || this.lock === null) return;
    if (this.routing?.exclusive === true || this.items.some((item) => item.routingSession?.state === 'unknown')) return;
    const queued = this.items.filter((item) => item.state === 'queued').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
    if (queued.length === 0) return;
    const workspace = readWorkspace(this.root).loaded?.config ?? null;
    const projectName = (id: string) => workspace?.projects.find((project) => project.id === id)?.name ?? id;
    const agentName = (id: string) => workspace?.agents.find((agent) => agent.id === id)?.name ?? id;
    const max = workspace?.limits.maxConcurrentProjectRuns ?? 2;
    const live = this.liveRuns(workspace);
    const projectsAhead = new Set<string>();
    let exclusiveAhead: RequestItem | null = null;
    let changed = false;

    const wait = (item: RequestItem, reason: string): void => {
      if (item.reason !== reason) {
        item.reason = reason;
        changed = true;
      }
    };

    for (const item of queued) {
      const admissionBegan = performance.now();
      if (item.route?.state === 'pending' || item.admissionReady === false) {
        wait(item, item.route?.state === 'pending' ? (item.reason?.startsWith('waiting: Control Center') ? item.reason : 'Control Center is routing your request.') : 'Checking the selected department before dispatch.');
        projectsAhead.add(item.projectId);
        continue;
      }
      if (live.some((run) => run.projectId === item.projectId)) {
        wait(item, `waiting: another task is running on ${projectName(item.projectId)}`);
        projectsAhead.add(item.projectId);
        continue;
      }
      let facts: RosterFacts;
      if (item.kind === 'request') {
        if (workspace === null) {
          wait(item, 'waiting: the workspace file cannot be read right now');
          projectsAhead.add(item.projectId);
          continue;
        }
        try {
          const roster = buildRoster(workspace, { projectId: item.projectId, departmentId: item.departmentId ?? '' });
          if (!this.workerReady(workspace, roster.head.runtime)) {
            this.failBeforeStart(item, 'runtime_not_ready', 'The selected department head runtime is unavailable. Check its runtime settings before sending the request again.');
            changed = true; continue;
          }
          if (item.approvedRosterHash !== undefined && item.approvedRosterHash !== this.rosterHash(workspace, roster)) {
            this.failBeforeStart(item, 'admission_workspace_changed', 'The selected department, its runtime settings, workers, or project checks changed while this request waited. Send the request again to approve the current configuration.');
            changed = true; continue;
          }
          const free = roster.workers.filter((worker) => !live.some((run) => run.workerIds.has(worker.id)) && this.workerReady(workspace, worker.runtime) && (item.allowUnconfinedWrites || consentNeeded([worker], workspace.runtimes, this.reports).length === 0));
          if (free.length === 0) {
            const busy = roster.workers.map((worker) => ({ worker, run: live.find((run) => run.workerIds.has(worker.id)) })).find((entry) => entry.run !== undefined);
            wait(item, busy === undefined ? `waiting: no available worker in ${roster.department.name} for ${projectName(item.projectId)}` : `waiting: ${agentName(busy.worker.id)} is busy on ${projectName(busy.run!.projectId)}`);
            projectsAhead.add(item.projectId);
            continue;
          }
          const explicitlyOne = /\b(?:exactly|only|just)\s+(?:one|1)\s+(?:worker|task)\b|\b(?:one|1)\s+(?:worker|task)\s+(?:only|total)\b/i.test(item.task ?? '');
          const capacity = explicitlyOne ? 1 : Math.min(workspace.limits.maxActiveTurns, workspace.limits.maxActiveWriters, workspace.limits.maxTasksPerRun);
          const selected = buildRoster(workspace, { projectId: item.projectId, departmentId: item.departmentId ?? '', workerIds: free.slice(0, capacity).map((worker) => worker.id) });
          facts = workspaceRosterFacts(workspace, selected, this.reports ?? undefined);
          item.admittedWorkspaceRevision = workspace.revision;
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          this.failBeforeStart(item, error.code, `the workspace changed while this request waited, and it can no longer start: ${error.message}`, [...error.details]);
          changed = true;
          continue;
        }
      } else {
        facts = { agentIds: item.agentIds, workerIds: item.workerIds, exclusive: item.exclusive, unconfinedRuntimes: item.unconfinedRuntimes };
      }
      // Admission recorded an exact-runtime version check. A synchronous
      // roster refresh must not erase that restriction using an adapter-wide
      // capability claim while this item is waiting.
      if (item.exclusive && !facts.exclusive && (item.kind === 'resume' || this.reports === null)) facts = { ...facts, exclusive: true, unconfinedRuntimes: [...item.unconfinedRuntimes] };
      const label = facts.unconfinedRuntimes[0] ?? 'runtime without a file boundary';
      const project = projectName(item.projectId);
      const exclusiveLive = live.find((run) => run.exclusive);
      const busyWorker = facts.workerIds.map((id) => ({ id, run: live.find((run) => run.workerIds.has(id)) })).find((entry) => entry.run !== undefined);

      let reason: string | null = null;
      if (live.some((run) => run.projectId === item.projectId)) reason = `waiting: another task is running on ${project}`;
      else if (projectsAhead.has(item.projectId)) reason = `waiting: an earlier request for ${project} goes first`;
      else if (exclusiveLive !== undefined) {
        reason = exclusiveLive.known
          ? `waiting: a ${exclusiveLive.label ?? 'runtime without a file boundary'} task runs on its own`
          : `waiting: a task started outside this page is running on ${projectName(exclusiveLive.projectId)}, and what it runs on could not be read, so nothing starts beside it`;
      } else if (exclusiveAhead !== null) reason = `waiting: a ${exclusiveAhead.unconfinedRuntimes[0] ?? 'runtime without a file boundary'} task that arrived earlier runs on its own first`;
      else if (facts.exclusive && live.length > 0) {
        reason = `waiting: a ${label} task runs on its own, so this starts when ${live.length === 1 ? 'the running task finishes' : `the ${live.length} running tasks finish`}`;
      } else if (live.length >= max) reason = `waiting: ${live.length} tasks are already running (your limit is ${max})`;
      else if (busyWorker !== undefined) reason = `waiting: ${agentName(busyWorker.id)} is busy on ${projectName(busyWorker.run!.projectId)}`;

      if (reason !== null) {
        wait(item, reason);
        projectsAhead.add(item.projectId);
        if (facts.exclusive && exclusiveAhead === null) exclusiveAhead = item;
        continue;
      }
      item.admissionElapsedMs = performance.now() - admissionBegan;
      if (this.launch(item, facts)) {
        live.push({ projectId: item.projectId, requestId: item.id, pid: item.pid, workerIds: new Set(facts.workerIds), exclusive: facts.exclusive, label: facts.unconfinedRuntimes[0] ?? null, known: true });
      }
      changed = true;
    }
    if (changed) this.persist();
  }

  private failBeforeStart(item: RequestItem, code: string, message: string, details: string[] = []): void {
    item.state = 'failed_to_start';
    item.endedAt = nowIso();
    item.reason = null;
    item.result = { exitCode: null, code, message, details };
    item.controlReply = message;
  }

  /** The argv after the CLI entry: every value its own element, the task text one `--task=` element. */
  argvFor(item: RequestItem): string[] {
    if (item.kind === 'resume') {
      return ['resume', item.resumeRunId!, '--json', `--state-dir=${projectStateRoot(this.root, item.projectId)}`, ...(item.allowUnconfinedWrites ? ['--allow-unconfined-writes'] : [])];
    }
    return [
      'run',
      '--json',
      `--project=${item.projectId}`,
      `--department=${item.departmentId!}`,
      ...item.workerIds.map((id) => `--worker=${id}`),
      ...(item.admittedWorkspaceRevision === undefined ? [] : [`--workspace-revision=${item.admittedWorkspaceRevision}`]),
      `--task=${item.task!}`,
      ...(item.attachments ?? []).map((file) => `--attachment=${file.id}`),
      ...(item.allowUnconfinedWrites ? ['--allow-unconfined-writes'] : []),
      ...(this.options.passStateDir ? [`--state-dir=${this.root}`] : []),
    ];
  }

  private launch(item: RequestItem, facts: RosterFacts): boolean {
    const launchId = newId();
    const dir = path.join(this.root, SERVE_DIR_NAME, 'launches');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    item.agentIds = facts.agentIds;
    item.workerIds = facts.workerIds;
    item.exclusive = facts.exclusive;
    item.unconfinedRuntimes = facts.unconfinedRuntimes;
    item.launchId = launchId;
    item.stdoutPath = path.join(dir, `${launchId}.stdout.jsonl`);
    item.stderrPath = path.join(dir, `${launchId}.stderr.log`);
    item.state = 'starting';
    item.startedAt = nowIso();
    item.reason = null;
    // The intent is on disk before the process exists.
    this.persist();

    const stdoutFd = openSync(item.stdoutPath, 'a', 0o600);
    const stderrFd = openSync(item.stderrPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = this.spawner(this.invocation.command, [...this.invocation.args, ...this.argvFor(item)], {
        cwd: this.invocation.cwd,
        env: this.options.env,
        stdio: ['ignore', stdoutFd, stderrFd],
        detached: true,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      this.failBeforeStart(item, 'spawn_failed', `could not start workforce: ${(error as Error).message}`);
      return false;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    child.unref();
    this.handles.set(item.id, child);
    item.pid = child.pid ?? null;
    item.pidStartedAtMs = item.pid === null ? null : observeProcessStartMs(item.pid);
    child.once('exit', (code, signal) => {
      const current = this.items.find((entry) => entry.id === item.id);
      if (current !== undefined && LIVE_STATES.has(current.state) && !this.closed) this.finalize(current, code, signal);
    });
    child.once('error', (error) => {
      const current = this.items.find((entry) => entry.id === item.id);
      if (current === undefined || !LIVE_STATES.has(current.state) || current.pid !== null || this.closed) return;
      this.handles.delete(current.id);
      this.failBeforeStart(current, 'spawn_failed', `could not start workforce: ${error.message}`, current.stderrPath === null ? [] : [`stderr: ${current.stderrPath}`]);
      this.persist();
      this.pump();
    });
    return true;
  }

  // ---- routes ---------------------------------------------------------------------

  private newItem(fields: Pick<RequestItem, 'kind' | 'projectId' | 'departmentId' | 'task' | 'resumeRunId' | 'allowUnconfinedWrites' | 'clientRequestId'> & RosterFacts): RequestItem {
    return {
      id: newId(),
      ...fields,
      state: 'queued',
      reason: null,
      receivedAt: nowIso(),
      startedAt: null,
      endedAt: null,
      heldAt: null,
      launchId: null,
      pid: null,
      pidStartedAtMs: null,
      stdoutPath: null,
      stderrPath: null,
      runId: null,
      stopRequestedAt: null,
      exitCode: null,
      signal: null,
      result: null,
    };
  }

  private accept(item: RequestItem): RequestItem {
    this.items.push(item);
    this.persist();
    this.pump();
    this.queueRouting();
    return structuredClone(item);
  }

  /** Recover the original receipt, including after a response is lost or the server restarts. */
  private previousSubmission(body: z.infer<typeof RequestBodySchema>): RequestItem | null {
    if (body.clientRequestId === undefined) return null;
    const items = this.lock !== null ? this.items : this.readItems(false);
    const previous = items.find((item) => item.kind === 'request' && item.clientRequestId === body.clientRequestId);
    if (previous === undefined) return null;
    const submittedDepartment = previous.submittedDepartmentId !== undefined ? previous.submittedDepartmentId : previous.departmentId;
    if (previous.projectId !== body.projectId || submittedDepartment !== (body.departmentId ?? null) || previous.task !== body.task || previous.allowUnconfinedWrites !== (body.allowUnconfinedWrites === true) || controlSelectionKey(previous.submittedControlCenter) !== controlSelectionKey(body.controlCenter) || JSON.stringify((previous.attachments ?? []).map((file) => file.id)) !== JSON.stringify(body.attachmentIds ?? [])) {
      throw new ApiError(409, 'request_id_conflict', 'this submission ID already belongs to a different request; send a new submission ID for changed task text or routing', [], { requestId: previous.id });
    }
    return structuredClone(previous);
  }

  private workerReady(config: WorkspaceConfig, runtimeId: string): boolean {
    const runtime = config.runtimes[runtimeId];
    if (runtime === undefined) return false;
    if (runtime.adapter === 'fake' || this.reports === null) return true;
    const fact = toolFactForRuntime(toolFacts(this.reports), runtimeId, runtime);
    return fact !== undefined && isToolUsable(fact);
  }

  private rosterHash(config: WorkspaceConfig, roster: Roster): string {
    const full = buildRoster(config, { projectId: roster.project.id, departmentId: roster.department.id });
    const agents = [full.head, ...full.workers];
    return sha256Hex(JSON.stringify({ project: full.project, department: full.department, agents, runtimes: agents.map((agent) => [agent.runtime, config.runtimes[agent.runtime]]) }));
  }

  /** Classification starts after the durable HTTP receipt and is serialized.
   * It never waits for a project's execution lock or claims a worker. */
  private queueRouting(): void {
    if (this.closed || this.lock === null || this.routing !== null) return;
    const item = this.items.find((entry) => entry.state === 'queued' && entry.route?.state === 'pending' && !this.directRouting.has(entry.id));
    if (item === undefined) return;
    const controller = new AbortController();
    if (this.items.some((entry) => entry.routingSession?.state === 'unknown')) return;
    this.routing = { id: item.id, controller, exclusive: false };
    setImmediate(() => {
      void this.resolveRouting(item, controller.signal).finally(() => {
        this.routing = null;
        this.pump();
        if (item.route?.state !== 'pending') this.queueRouting();
      });
    });
  }

  private async resolveRouting(item: RequestItem, signal: AbortSignal): Promise<void> {
    const active = (): boolean => !this.closed && !signal.aborted && this.lock !== null && item.state === 'queued';
    try {
      if (!active()) return;
      const config = loadWorkspace(this.root).config;
      if (!config.projects.some((project) => project.id === item.projectId && !project.archived)) throw new ApiError(409, 'routing_project_unavailable', 'The selected project is no longer available. Select an active project and send this message again.');
      if (item.controlCenter && item.controlRuntime && JSON.stringify(config.runtimes[item.controlCenter.runtime]) !== JSON.stringify(item.controlRuntime)) throw new ApiError(409, 'control_runtime_changed', 'The selected Control Center runtime binding changed while this request waited. Send a new request to use the current binding.');
      // This copy is only for intake. Worker preflight below always reads the original workspace.
      const controlWorkspace = item.controlCenter ? { ...config, controlCenter: item.controlCenter } : config;
      const files = item.attachments?.length ? await resolveAttachments(this.root, item.attachments.map((file) => file.id)) : [];
      if (!active()) return;
      const attachments = files.map((file) => ({ path: file.path, name: file.name, mimeType: file.mimeType, sizeBytes: file.size, sha256: file.sha256 }));
      const input = { workspace: controlWorkspace, projectId: item.projectId, task: item.task!, ...(attachments.length ? { attachments } : {}) };
      const direct = directControlRoute(input);
      if (direct === null) {
        const readiness = await this.options.readiness();
        if (!active()) return;
        this.reports = 'reports' in readiness ? readiness.reports : null;
      }
      if (direct === null) {
        const live = this.liveRuns(config);
        if (live.some((run) => run.exclusive)) { item.reason = 'waiting: Control Center must wait for the active task without a verified file boundary to finish.'; return; }
        if (controlRoutingExclusive(controlWorkspace, this.reports ?? []) && item.allowUnconfinedWrites) {
          if (live.length > 0) { item.reason = 'waiting: Control Center uses a runtime without a verified file boundary and must route this request on its own.'; return; }
          if (this.routing !== null) this.routing.exclusive = true;
        }
      }
      const decision = direct ?? await (this.options.routeControl ?? routeControlRequest)({ ...input, reports: this.reports ?? [], allowUnconfinedWrites: item.allowUnconfinedWrites, signal,
        onSession: (session) => {
          if (!active()) throw new Error('Routing ownership ended before the model turn.');
          item.routingSession = { sessionId: session.sessionId, process: session.process ?? null, state: 'running' };
          this.persist();
        },
        onStopped: (receipt) => {
          if (item.routingSession === undefined) return;
          item.routingSession.state = receipt?.state === 'process_tree_terminated' ? 'stopped' : 'unknown';
          if (!this.closed && this.lock !== null) this.persist();
        },
        onStartupStopped: (receipt) => {
          item.routingSession = { sessionId: receipt?.sessionId ?? `routing-${item.id}`, process: null, processId: receipt?.processId ?? null,
            state: receipt?.state === 'process_tree_terminated' ? 'stopped' : 'unknown' };
          if (!this.closed && this.lock !== null) this.persist();
        },
      });
      if (!active()) return;
      item.route = RouteDecisionSchema.parse(decision.route);
      if (item.route.projectId !== item.projectId || (item.route.state === 'selected' && item.route.method !== 'direct_reply' && !config.departments.some((department) => department.id === item.route!.departmentId && !department.archived))) throw new ApiError(409, 'routing_invalid_response', 'Control Center selected a destination outside this request and its saved departments. No project work started.');
      item.departmentId = item.route.departmentId;
      item.controlReply = decision.reply ?? item.route.reason;
      this.persist(); // The chosen destination exists on disk before its setup or execution is consulted.
      if (item.route.state === 'blocked') {
        this.failBeforeStart(item, item.route.code ?? 'routing_blocked', item.route.reason);
      } else if (item.route.method === 'direct_reply') {
        item.state = 'ended'; item.endedAt = nowIso(); item.exitCode = 0;
        item.result = { exitCode: 0, code: 'control_reply', message: item.controlReply, details: [] };
      } else {
        if (loadWorkspace(this.root).config.revision !== config.revision) throw new ApiError(409, 'routing_workspace_changed', 'Workspace routing configuration changed during classification. Send the message again to use the current departments.');
        const ready = await this.preflight({ projectId: item.projectId, departmentId: item.departmentId!, allowUnconfinedWrites: item.allowUnconfinedWrites });
        if (!active()) return;
        Object.assign(item, workspaceRosterFacts(ready.config, ready.roster, ready.reports));
        item.approvedRosterHash = this.rosterHash(ready.config, ready.roster);
        item.admissionReady = true;
        item.controlReply = `Routed to ${ready.roster.department.name}. ${ready.roster.head.name} will plan the work and assign available workers.`;
      }
    } catch (error) {
      if (!active()) return;
      const code = error instanceof ApiError || error instanceof WorkspaceError ? error.code : 'routing_failed';
      const message = error instanceof Error ? error.message : 'Control Center could not route this request.';
      const details = error instanceof ApiError || error instanceof WorkspaceError ? [...error.details] : [];
      if (item.route !== undefined) item.route = { ...item.route, state: 'blocked', code, reason: message, decidedAt: nowIso() };
      this.failBeforeStart(item, code, message, details);
    } finally {
      if (!this.closed && this.lock !== null) { this.persist(); this.pump(); }
    }
  }

  private async preflight(body: {projectId: string; departmentId: string; allowUnconfinedWrites?: boolean}): Promise<{config: WorkspaceConfig; roster: Roster; reports: ReadonlyArray<RuntimeReadinessReport> | null}> {
    let config: WorkspaceConfig;
    let roster: Roster;
    try {
      const loaded = loadWorkspace(this.root);
      if (!loaded.exists) throw new ApiError(400, 'no_workspace', 'there is no workspace yet: add a project and a department with a head and a worker before sending work');
      config = loaded.config;
      roster = buildRoster(config, { projectId: body.projectId, departmentId: body.departmentId });
    } catch (error) { if (error instanceof WorkspaceError) throw httpErrorFromWorkspace(error); throw error; }
    const checks = await resolveProjectChecks(roster.project);
    if (checks.count === null) throw new ApiError(400, 'project_unavailable', `project "${roster.project.id}" cannot be worked on: ${checks.detail}`);
    const readiness = await this.options.readiness();
    const reports = 'reports' in readiness ? readiness.reports : null;
    this.reports = reports;
    const readyWorkers = roster.workers.filter((worker) => this.workerReady(config, worker.runtime));
    if (reports !== null && (!this.workerReady(config, roster.head.runtime) || readyWorkers.length === 0)) throw new ApiError(409, 'runtime_not_ready', 'The selected department needs an available head runtime and at least one available worker runtime. Check its runtime settings.');
    if (readyWorkers.length > 0) roster = buildRoster(config, { projectId: body.projectId, departmentId: body.departmentId, workerIds: readyWorkers.map((worker) => worker.id) });
    if (checks.count === 0) throw new ApiError(400, 'project_has_no_checks', `project "${roster.project.id}" has no acceptance check, so nothing could verify the result: ${checks.detail}`, [`add one: workforce workspace project edit ${roster.project.id} --check "npm test"`, 'or commit .workforce/checks.json to the repository']);
    const consentFree = roster.workers.filter((worker) => consentNeeded([worker], config.runtimes, reports).length === 0);
    if (body.allowUnconfinedWrites !== true && consentFree.length > 0) roster = buildRoster(config, { projectId: body.projectId, departmentId: body.departmentId, workerIds: consentFree.map((worker) => worker.id) });
    const consent = consentNeeded([roster.head, ...roster.workers], config.runtimes, reports);
    if (consent.length > 0 && body.allowUnconfinedWrites !== true) throw new ApiError(409, 'consent_required', 'This department requires explicit consent for a runtime without a verified file boundary. Review the named runtimes and resend with consent.', consent.map((agent) => agent.line), { consent: { required: true, agents: consent } });
    return { config, roster, reports };
  }

  /** `POST /api/requests`. Refusals are synchronous and start nothing; an accepted request is started or queued. */
  async submit(raw: unknown): Promise<RequestItem> {
    const parsed = RequestBodySchema.safeParse(raw);
    if (!parsed.success) throw invalidBody(parsed.error.issues, 'the request');
    const body = parsed.data;
    if (this.closed) throw new ApiError(503, 'server_closing', 'the page server is stopping');
    const previous = this.previousSubmission(body);
    if (previous !== null) return previous;
    const files = body.attachmentIds?.length ? await resolveAttachments(this.root, body.attachmentIds) : [];
    const attachments = files.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));

    if (body.departmentId === undefined) {
      const loaded = loadWorkspace(this.root);
      const project = loaded.config.projects.find((project) => project.id === body.projectId && !project.archived);
      if (!loaded.exists || project === undefined) throw new ApiError(400, 'unknown_project', 'Select a saved, active project before sending a message to Control Center.');
      if (body.controlCenter && !loaded.config.runtimes[body.controlCenter.runtime]) throw new ApiError(400, 'unknown_control_runtime', 'Select a configured runtime for Control Center.');
      const observed = await this.options.readiness();
      const reports = 'reports' in observed ? observed.reports : [];
      const runtimeId = body.controlCenter?.runtime ?? controlRuntimeId(loaded.config, reports);
      const runtime = runtimeId ? loaded.config.runtimes[runtimeId] : undefined;
      let controlCenter: ControlCenterConfig | undefined;
      if (runtimeId && runtime) {
        const inherited = body.controlCenter ? body.controlCenter : loaded.config.controlCenter;
        controlCenter = ControlCenterConfigSchema.parse({ ...loaded.config.controlCenter, runtime: runtimeId,
          model: inherited?.model ?? runtime.model, effort: inherited?.effort ?? runtime.effort });
        // Passive model metadata is normally warm from the composer; never start a turn to list choices.
        await this.options.validateControl?.(controlCenter, runtime, reports, files.map((file) => ({ path: file.path, name: file.name, mimeType: file.mimeType, sizeBytes: file.size, sha256: file.sha256 })));
        if (files.length) {
          try { validateAttachments(runtime.adapter, files.map((file) => ({ path: file.path, name: file.name, mimeType: file.mimeType, sizeBytes: file.size, sha256: file.sha256 }))); }
          catch (error) { throw new ApiError(400, 'unsupported_attachment', error instanceof Error ? error.message : 'This runtime cannot read one of the attachments.'); }
        }
      }
      if (loadWorkspace(this.root).config.revision !== loaded.config.revision) throw new ApiError(409, 'workspace_changed', 'Workspace settings changed while preparing this request. Retry with the current configuration.');
      this.ensureOwner();
      const acceptedWhileChecking = this.previousSubmission(body);
      if (acceptedWhileChecking !== null) return acceptedWhileChecking;
      const item = this.newItem({ kind: 'request', ...(body.clientRequestId === undefined ? {} : { clientRequestId: body.clientRequestId }), projectId: body.projectId,
        departmentId: null, task: body.task, resumeRunId: null, allowUnconfinedWrites: body.allowUnconfinedWrites === true,
        agentIds: [], workerIds: [], exclusive: false, unconfinedRuntimes: [] });
      item.submittedDepartmentId = null;
      if (attachments.length) item.attachments = attachments;
      if (body.controlCenter) item.submittedControlCenter = structuredClone(body.controlCenter);
      if (controlCenter && runtime) { item.controlCenter = structuredClone(controlCenter); item.controlRuntime = structuredClone(runtime); }
      item.admissionReady = false;
      item.route = { state: 'pending', projectId: body.projectId, departmentId: null, headAgentId: null, reason: 'Control Center is routing your request.',
        decidedAt: null, elapsedMs: 0, method: 'pending', workspaceRevision: loaded.config.revision };
      this.items.push(item);
      this.persist();
      const receipt = structuredClone(item);
      if (directControlRoute({ workspace: { ...loaded.config, ...(controlCenter ? { controlCenter } : {}) }, projectId: item.projectId, task: item.task! }) !== null) {
        this.directRouting.add(item.id);
        setImmediate(() => { void this.resolveRouting(item, new AbortController().signal).finally(() => { this.directRouting.delete(item.id); this.queueRouting(); }); });
      } else this.queueRouting();
      return receipt;
    }
    const { config, roster, reports } = await this.preflight({ projectId: body.projectId, departmentId: body.departmentId, ...(body.allowUnconfinedWrites === undefined ? {} : { allowUnconfinedWrites: body.allowUnconfinedWrites }) });
    // Only an accepted request takes the queue (and writes its file); every refusal above wrote nothing.
    this.ensureOwner();
    // The check must also happen under queue ownership after every await:
    // two simultaneous retries can both finish preflight before either accepts.
    const acceptedWhileChecking = this.previousSubmission(body);
    if (acceptedWhileChecking !== null) return acceptedWhileChecking;
    const item = this.newItem({
        kind: 'request',
        ...(body.clientRequestId !== undefined ? { clientRequestId: body.clientRequestId } : {}),
        projectId: roster.project.id,
        departmentId: roster.department.id,
        task: body.task,
        resumeRunId: null,
        allowUnconfinedWrites: body.allowUnconfinedWrites === true,
        ...workspaceRosterFacts(config, roster, reports),
      });
    item.submittedDepartmentId = body.departmentId;
    if (attachments.length) item.attachments = attachments;
    if (body.controlCenter) item.submittedControlCenter = structuredClone(body.controlCenter);
    item.approvedRosterHash = this.rosterHash(config, roster);
    item.route = { state: 'selected', projectId: body.projectId, departmentId: body.departmentId, headAgentId: roster.head.id,
      reason: 'The request explicitly selected this department.', decidedAt: nowIso(), elapsedMs: 0, method: 'explicit', workspaceRevision: config.revision };
    return this.accept(item);
  }

  /** `POST /api/projects/:id/runs/:runId/resume`: `workforce resume` with the project's state root, through the queue. */
  async resume(projectId: string, runId: string, raw: unknown): Promise<RequestItem> {
    const parsed = ResumeBodySchema.safeParse(raw);
    if (!parsed.success) throw invalidBody(parsed.error.issues, 'the resume request');
    const workspace = readWorkspace(this.root).loaded?.config ?? null;
    const paths = readableProjectPaths(this.root, projectId, workspace);
    const unknownRun = new ApiError(404, 'unknown_run', `run ${runId} is not recorded for project "${projectId}"`);
    if (!ID_PATTERN.test(runId)) throw unknownRun;
    try {
      const store = openStateStore(paths, { mode: 'read-only' });
      try {
        if (findRun(store.db, runId) === null) throw unknownRun;
      } finally {
        store.close();
      }
    } catch (error) {
      if (error instanceof StateNotFoundError) throw unknownRun;
      throw error;
    }
    let snapshot: { configPath?: unknown; raw?: unknown };
    let config: AgentConfigFile;
    try {
      snapshot = JSON.parse(readFileSync(paths.runConfigSnapshotPath(runId), 'utf8')) as { configPath?: unknown; raw?: unknown };
      config = validateAgentConfig(snapshot.raw);
    } catch (error) {
      throw new ApiError(409, 'run_configuration_unreadable', `the recorded configuration of run ${runId} cannot be read, so it cannot be resumed from this page: ${(error as Error).message}`);
    }
    const readiness = await this.options.readiness();
    const consent = consentNeeded(config.agents, config.runtimes, 'reports' in readiness ? readiness.reports : null);
    if (consent.length > 0 && parsed.data.allowUnconfinedWrites !== true) {
      throw new ApiError(409, 'consent_required', 'this run changes files on a coding tool without a verified file boundary; send allowUnconfinedWrites: true to accept that', consent.map((agent) => agent.line), {
        consent: { required: true, agents: consent },
      });
    }
    const department = typeof snapshot.configPath === 'string' ? /^([a-z0-9][a-z0-9-]{0,47})\.r\d+\./.exec(path.basename(snapshot.configPath))?.[1] ?? null : null;
    this.ensureOwner();
    // Keep the duplicate check and acceptance together, after every await and
    // after loading the durable queue under ownership. Concurrent resume clicks
    // must not both pass admission while passive discovery is still pending.
    if (this.items.some((item) => item.kind === 'resume' && item.resumeRunId === runId && item.projectId === projectId && (LIVE_STATES.has(item.state) || WAITING_STATES.has(item.state)))) {
      throw new ApiError(409, 'resume_already_requested', `run ${runId} already has a resume waiting or in progress`);
    }
    return this.accept(
      this.newItem({ kind: 'resume', projectId, departmentId: department, task: null, resumeRunId: runId, allowUnconfinedWrites: parsed.data.allowUnconfinedWrites === true, ...snapshotRosterFacts(config, 'reports' in readiness ? readiness.reports : null) }),
    );
  }

  private find(id: string): RequestItem {
    const item = (this.lock !== null ? this.items : this.readItems(false)).find((entry) => entry.id === id);
    if (item === undefined) throw new ApiError(404, 'unknown_request', `no request ${id} in this server's queue`);
    return item;
  }

  get(id: string): RequestItem {
    return structuredClone(this.find(id));
  }

  /** Held → queued. It then starts when the rules allow, in its original place. */
  start(id: string): RequestItem {
    this.ensureOwner();
    const item = this.find(id);
    if (item.state !== 'held') throw new ApiError(409, 'not_held', `request ${id} is ${item.state}; only a held request can be started`);
    item.state = 'queued';
    item.reason = null;
    if (item.kind === 'request' && item.route?.state !== 'pending') {
      item.admissionReady = false;
      item.reason = 'Checking current runtime readiness before restarting this held request.';
      void this.preflight({ projectId: item.projectId, departmentId: item.departmentId!, allowUnconfinedWrites: item.allowUnconfinedWrites }).then((ready) => {
        if (this.closed || item.state !== 'queued') return;
        Object.assign(item, workspaceRosterFacts(ready.config, ready.roster, ready.reports));
        item.admissionReady = true;
      }, (error: unknown) => {
        if (this.closed || item.state !== 'queued') return;
        this.failBeforeStart(item, error instanceof ApiError ? error.code : 'admission_failed', error instanceof Error ? error.message : 'This held request cannot start.');
      }).finally(() => { if (!this.closed && this.lock !== null) { this.persist(); this.pump(); } });
    }
    this.persist();
    this.pump();
    this.queueRouting();
    return structuredClone(item);
  }

  /** Queued or held → discarded. Nothing was started, and nothing is. */
  discard(id: string): RequestItem {
    this.ensureOwner();
    const item = this.find(id);
    if (!WAITING_STATES.has(item.state)) throw new ApiError(409, 'not_waiting', `request ${id} is ${item.state}; only a queued or held request can be discarded`);
    item.state = 'discarded';
    if (this.routing?.id === item.id) this.routing.controller.abort();
    item.endedAt = nowIso();
    item.reason = null;
    this.persist();
    this.pump();
    return structuredClone(item);
  }

  /** SIGINT to the tracked pid: the run stops the way Ctrl+C would stop it, and the item ends when the process does. */
  stop(id: string): RequestItem {
    this.ensureOwner();
    const item = this.find(id);
    if (!LIVE_STATES.has(item.state) || item.pid === null) {
      throw new ApiError(409, 'not_running', `request ${id} is ${item.state}; there is no process to stop${WAITING_STATES.has(item.state) ? ' (discard it instead)' : ''}`);
    }
    const child = this.handles.get(item.id);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT');
    } else {
      const identity = item.pidStartedAtMs === null ? 'unverifiable' : matchProcessIdentity({ pid: item.pid, startedAtMs: item.pidStartedAtMs });
      if (identity !== 'alive') {
        throw new ApiError(409, 'process_unverifiable', `pid ${item.pid} cannot be confirmed to still be this run, so no signal was sent`, [`check it, then stop it from a terminal: kill -INT ${item.pid}`]);
      }
      process.kill(item.pid, 'SIGINT');
    }
    item.stopRequestedAt = nowIso();
    item.reason = 'stopping: an interrupt (Ctrl+C) was sent; the run records what it has and stops';
    this.persist();
    return structuredClone(item);
  }

  /** Stop by run id: only a run this server started has a process it tracks. */
  stopRun(projectId: string, runId: string): RequestItem {
    const item = (this.lock !== null ? this.items : this.readItems(false)).find((entry) => entry.projectId === projectId && entry.runId === runId && LIVE_STATES.has(entry.state));
    if (item === undefined) {
      throw new ApiError(409, 'not_started_here', `run ${runId} is not a live run this page server started, so it has no process to interrupt here`, [
        'stop it with Ctrl+C in the terminal where it runs',
      ]);
    }
    return this.stop(item.id);
  }

  /** True while a project has a live run, from this queue or from its coordinator lock. Project remove refuses then. */
  projectBusy(projectId: string): boolean {
    return this.items.some((item) => item.projectId === projectId && LIVE_STATES.has(item.state)) || projectHasLiveRun(this.root, projectId);
  }

  /** `GET /api/requests`: every item newest first, what is live now, and the limit. */
  list(): Record<string, unknown> {
    const items = this.lock !== null ? this.items : this.readItems(false);
    const workspace = readWorkspace(this.root).loaded?.config ?? null;
    const live = this.liveRuns(workspace, items).map((run) => ({
      projectId: run.projectId,
      requestId: run.requestId,
      startedOutsideThisPage: run.requestId === null,
      pid: run.pid,
      workerIds: [...run.workerIds],
      runsOnItsOwn: run.exclusive,
      runsOnItsOwnBecause: run.exclusive ? (run.known ? `${run.label ?? 'a runtime'} has no verified file boundary` : 'what it runs on could not be read') : null,
    }));
    return {
      ok: true,
      accepting: this.ownerRefusal === null && !this.closed,
      managedElsewhere: this.ownerRefusal,
      notice: this.notice,
      limits: { maxConcurrentProjectRuns: workspace?.limits.maxConcurrentProjectRuns ?? 2 },
      live,
      items: [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id)).map((item) => structuredClone(item)),
    };
  }
}
