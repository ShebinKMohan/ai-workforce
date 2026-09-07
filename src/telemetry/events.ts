/**
 * Runtime event normalization and the events.jsonl projection.
 *
 * SQLite is authoritative. `events.jsonl` is a regenerable projection with
 * redaction applied; projecting twice appends nothing new.
 *
 * Idempotency key: `<adapter>:<session>:<spawnToken>:<sequence>`. The spawn
 * token names the process instance, so a resumed session (a new process
 * numbering its events from 1 again) never collides with the events the
 * previous process already stored; replaying the same process's stream is a
 * no-op.
 *
 * Row size: a payload above `MAX_EVENT_PAYLOAD_BYTES` (tool output, diffs,
 * malformed raw lines with file contents) is published to the artifact store
 * as `events/<adapter>/<session>/<spawnToken>-<sequence>.json` and the row
 * keeps a truncated summary plus the artifact id in `payloadRef`. The
 * artifact path is deterministic, so a replay after a crash between
 * publication and the event insert reuses the published bytes.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '../adapters/types.js';
import { findArtifactByPath, writeArtifact } from '../storage/artifacts.js';
import { ensureRunDir, type StatePaths } from '../storage/paths.js';
import { MAX_EVENT_PAYLOAD_BYTES, appendEvent, findEventByKey, listEvents, payloadByteLength, type AppendEventInput, type AppendEventResult, type EventRecord } from '../storage/events.js';
import { withTransaction } from '../storage/tx.js';
import { redactValue } from './redaction.js';

export interface EventContext {
  readonly runId: string;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
  /** Needed to spill oversized payloads into the run's artifact store. */
  readonly paths: StatePaths;
}

export const RUNTIME_EVENT_PAYLOAD_ARTIFACT_TYPE = 'runtime_event_payload';

export function runtimeEventIdempotencyKey(event: RuntimeEvent): string {
  return `${event.adapter}:${event.sessionId}:${event.spawnToken}:${event.sequence}`;
}

/** Map a normalized runtime event to an application event row. Idempotent per (adapter, session, spawn token, sequence). */
export function runtimeEventToAppend(event: RuntimeEvent, ctx: Pick<EventContext, 'runId' | 'taskId' | 'attemptId'>): AppendEventInput {
  return {
    runId: ctx.runId,
    taskId: ctx.taskId ?? null,
    attemptId: ctx.attemptId ?? null,
    type: `runtime.${event.kind}`,
    payload: { ...baseFields(event), ...event.payload },
    payloadRef: null,
    idempotencyKey: runtimeEventIdempotencyKey(event),
    timestamp: event.timestamp,
  };
}

function baseFields(event: RuntimeEvent): Record<string, unknown> {
  return {
    adapter: event.adapter,
    sessionId: event.sessionId,
    turnId: event.turnId,
    spawnToken: event.spawnToken,
    runtimeSequence: event.sequence,
    rawRef: event.rawRef,
  };
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned.length === 0 ? '_' : cleaned.slice(0, 128);
}

const INLINE_FIELD_BUDGET = 256;
const PREVIEW_CHARS = 200;

/** Keep short fields, truncate long strings, drop large structures; the full payload lives in the artifact. */
function truncatePayload(event: RuntimeEvent, artifactId: string, bytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...baseFields(event), payloadTruncated: true, payloadBytes: bytes, payloadArtifactId: artifactId };
  for (const [key, value] of Object.entries(event.payload)) {
    if (key in out) continue;
    const json = JSON.stringify(value) ?? 'null';
    if (Buffer.byteLength(json, 'utf8') <= INLINE_FIELD_BUDGET) {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = `${value.slice(0, PREVIEW_CHARS)}… [truncated: ${Buffer.byteLength(value, 'utf8')} bytes in artifact ${artifactId}]`;
    } else {
      out[key] = `[omitted: ${Buffer.byteLength(json, 'utf8')} bytes in artifact ${artifactId}]`;
    }
  }
  if (payloadByteLength(out) > MAX_EVENT_PAYLOAD_BYTES) {
    return { ...baseFields(event), payloadTruncated: true, payloadBytes: bytes, payloadArtifactId: artifactId, payloadKeys: Object.keys(event.payload).slice(0, 64) };
  }
  return out;
}

/**
 * Persist a runtime event durably. Small payloads go straight into the row;
 * large ones are published as an artifact first (inside the same
 * transaction as the event insert) and the row references the artifact.
 */
export function recordRuntimeEvent(db: DatabaseSync, event: RuntimeEvent, ctx: EventContext): AppendEventResult {
  const input = runtimeEventToAppend(event, ctx);
  const bytes = payloadByteLength(input.payload);
  if (bytes <= MAX_EVENT_PAYLOAD_BYTES) return appendEvent(db, input);

  return withTransaction(db, () => {
    const existing = findEventByKey(db, ctx.runId, input.idempotencyKey!);
    if (existing !== null) return { event: existing, appended: false };

    const relativePath = `events/${safeSegment(event.adapter)}/${safeSegment(event.sessionId)}/${safeSegment(event.spawnToken)}-${event.sequence}.json`;
    const artifact =
      findArtifactByPath(db, ctx.runId, relativePath) ??
      writeArtifact(db, ctx.paths, {
        runId: ctx.runId,
        taskId: ctx.taskId ?? null,
        attemptId: ctx.attemptId ?? null,
        type: RUNTIME_EVENT_PAYLOAD_ARTIFACT_TYPE,
        relativePath,
        bytes: JSON.stringify(event.payload),
        provenance: { ...baseFields(event), kind: event.kind, timestamp: event.timestamp, producer: 'recordRuntimeEvent' },
        now: event.timestamp,
      });
    return appendEvent(db, { ...input, payload: truncatePayload(event, artifact.id, bytes), payloadRef: artifact.id });
  });
}

/**
 * Evidence summary of one turn's events: what the runtime claimed versus what
 * was observed.
 *
 * Counting rule: an adapter reports one *action* through several events — a
 * command execution arrives as `phase: "started"` and again as
 * `phase: "completed"`, and the same file can be written more than once. The
 * counts below are per logical action, keyed on the adapter's own item id
 * where it supplies one, so "10 commands" never means "5 commands, seen
 * twice". `rawEvents` counts events the adapter chose not to normalize; they
 * are well-formed runtime output kept verbatim as evidence, not malformed
 * lines.
 */
export interface TurnEvidence {
  readonly claimedDone: boolean;
  readonly completed: boolean;
  readonly interrupted: boolean;
  /**
   * Distinct paths the runtime reported writing — applied, or with an outcome
   * it never reported — in the order first reported. A write the runtime
   * refused is not one of them; it is in `deniedFileChanges`.
   */
  readonly fileChanges: ReadonlyArray<string>;
  /** Paths whose every reported write the runtime refused. Evidence that a worker tried, never that it succeeded. */
  readonly deniedFileChanges: ReadonlyArray<string>;
  /**
   * Writes outside the granted paths that the runtime reported as *applied*,
   * or never reported an outcome for. An escape it applied and an escape whose
   * outcome is unknown are both untrusted; a write the runtime *denied* is the
   * boundary working and is listed separately.
   */
  readonly fileChangesOutsideAllowedPaths: ReadonlyArray<string>;
  /**
   * Writes outside the granted paths the runtime reported denying. Recorded as
   * evidence that a worker tried, never as evidence that it succeeded — for a
   * runtime with no OS sandbox this is the only place the prevented /
   * not-prevented distinction exists.
   */
  readonly deniedFileChangesOutsideAllowedPaths: ReadonlyArray<string>;
  /** Of `fileChangesOutsideAllowedPaths`, the ones whose outcome the runtime never reported. */
  readonly unconfirmedFileChangesOutsideAllowedPaths: ReadonlyArray<string>;
  /** Distinct command executions, not event count. */
  readonly commandsExecuted: number;
  readonly toolCalls: number;
  readonly errors: ReadonlyArray<Record<string, unknown>>;
  /** Well-formed runtime events the adapter kept verbatim rather than normalizing. */
  readonly rawEvents: number;
}

/** The adapter's own identity for the item an event belongs to, when it supplies one. */
function itemKey(event: RuntimeEvent): string | null {
  const id = event.payload['itemId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Counts distinct items by id, and falls back to counting events for adapters that report none. */
class ItemCounter {
  readonly #ids = new Set<string>();
  #withoutId = 0;

  add(event: RuntimeEvent): void {
    const id = itemKey(event);
    if (id === null) this.#withoutId += 1;
    else this.#ids.add(id);
  }

  get total(): number {
    return this.#ids.size + this.#withoutId;
  }
}

type FileChangeOutcome = 'applied' | 'denied' | 'unconfirmed';

/** The adapter's identity for the tool call or item a `file_change` belongs to, when it supplies one. */
function requestIdentity(event: RuntimeEvent): string | null {
  for (const field of ['toolUseId', 'itemId'] as const) {
    const value = event.payload[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * What one `file_change` event says about whether the write happened.
 *
 * `applied === true` is the only claim that a file changed. An explicit
 * `denied === true`, or a completed phase whose `applied` is false, is the
 * runtime reporting a refusal. Anything else — a request still awaiting its
 * result, or an adapter that reports neither field — is `unconfirmed`: not
 * proof of a write, and not proof there was none.
 */
function fileChangeOutcome(payload: Record<string, unknown>): FileChangeOutcome {
  if (payload['applied'] === true) return 'applied';
  if (payload['denied'] === true) return 'denied';
  if (payload['phase'] === 'completed' && payload['applied'] === false) return 'denied';
  // An adapter that reports no outcome fields at all reports the change itself:
  // treat a bare report as an unconfirmed write rather than as a denial.
  return 'unconfirmed';
}

export function summarizeTurnEvidence(events: Iterable<RuntimeEvent>): TurnEvidence {
  let claimedDone = false;
  let completed = false;
  let interrupted = false;
  /**
   * File changes grouped by path, and within a path by the *request* that asked
   * for them. An adapter reports one write twice — the request, then its
   * outcome — and both events carry the same tool-call / item id, so the
   * outcome supersedes the request instead of being counted beside it.
   *
   * A path counts as changed if any request for it was applied or its outcome
   * was never reported; a path whose every request was refused counts as
   * denied and is listed separately. That distinction is what lets the evidence
   * say "the runtime refused this write" rather than "the worker wrote here",
   * which for a runtime with no OS sandbox is the whole containment argument.
   */
  const byPath = new Map<string, { reported: string; within: boolean | null; requests: Map<string, FileChangeOutcome> }>();
  let unkeyedChanges = 0;
  const commands = new ItemCounter();
  const tools = new ItemCounter();
  const errors: Record<string, unknown>[] = [];
  let rawEvents = 0;
  for (const event of events) {
    switch (event.kind) {
      case 'assistant_message':
        if (event.payload['claimsDone'] === true) claimedDone = true;
        break;
      case 'turn_completed':
        completed = true;
        break;
      case 'turn_interrupted':
        interrupted = true;
        break;
      case 'file_change': {
        const reported = typeof event.payload['path'] === 'string' ? (event.payload['path'] as string) : null;
        const resolved = typeof event.payload['resolvedPath'] === 'string' ? (event.payload['resolvedPath'] as string) : null;
        // Identity is the resolved path where the adapter supplies one, because
        // the reported path may be relative. A report with no path at all is
        // kept on its own: two of them are not the same file.
        unkeyedChanges += 1;
        const identity = resolved ?? reported ?? `#unnamed-${unkeyedChanges}`;
        const entry = byPath.get(identity) ?? {
          reported: reported ?? '(unknown path)',
          within: typeof event.payload['withinAllowedPaths'] === 'boolean' ? (event.payload['withinAllowedPaths'] as boolean) : null,
          requests: new Map<string, FileChangeOutcome>(),
        };
        if (event.payload['withinAllowedPaths'] === false) entry.within = false;
        entry.requests.set(requestIdentity(event) ?? `unkeyed-${unkeyedChanges}`, fileChangeOutcome(event.payload));
        byPath.set(identity, entry);
        break;
      }
      case 'command_exec':
        commands.add(event);
        break;
      case 'tool_call':
        tools.add(event);
        break;
      case 'error':
        errors.push(event.payload);
        break;
      case 'raw':
        rawEvents += 1;
        break;
      default:
        break;
    }
  }

  const fileChanges: string[] = [];
  const deniedChanges: string[] = [];
  const escaped: string[] = [];
  const deniedOutside: string[] = [];
  const unconfirmedOutside: string[] = [];
  for (const { reported, within, requests } of byPath.values()) {
    const outcomes = [...requests.values()];
    const applied = outcomes.includes('applied');
    const unconfirmed = !applied && outcomes.includes('unconfirmed');
    if (!applied && !unconfirmed) {
      deniedChanges.push(reported);
      if (within === false) deniedOutside.push(reported);
      continue;
    }
    fileChanges.push(reported);
    if (within === false) {
      escaped.push(reported);
      if (unconfirmed) unconfirmedOutside.push(reported);
    }
  }

  return {
    claimedDone,
    completed,
    interrupted,
    fileChanges,
    deniedFileChanges: deniedChanges,
    fileChangesOutsideAllowedPaths: escaped,
    deniedFileChangesOutsideAllowedPaths: deniedOutside,
    unconfirmedFileChangesOutsideAllowedPaths: unconfirmedOutside,
    commandsExecuted: commands.total,
    toolCalls: tools.total,
    errors,
    rawEvents,
  };
}

export interface ProjectionResult {
  readonly appended: number;
  readonly lastSequence: number;
  readonly path: string;
}

function lastProjectedSequence(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as { sequence?: unknown };
      if (typeof parsed.sequence === 'number') return parsed.sequence;
    } catch {
      // partial trailing line from an interrupted write: keep looking backwards
    }
  }
  return 0;
}

/** Append events newer than the file's last sequence as redacted JSON lines. Safe to call repeatedly. */
export function projectEventsJsonl(db: DatabaseSync, paths: StatePaths, runId: string): ProjectionResult {
  ensureRunDir(paths, runId);
  const filePath = paths.runEventsJsonlPath(runId);
  const start = lastProjectedSequence(filePath);
  const pending: EventRecord[] = listEvents(db, runId, { afterSequence: start });
  if (pending.length === 0) return { appended: 0, lastSequence: start, path: filePath };
  const lines = pending.map((event) => JSON.stringify(redactValue(event))).join('\n');
  appendFileSync(filePath, `${lines}\n`);
  return { appended: pending.length, lastSequence: pending[pending.length - 1]!.sequence, path: filePath };
}
