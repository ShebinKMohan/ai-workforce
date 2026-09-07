/**
 * Runtime event normalization and the events.jsonl projection.
 *
 * SQLite is authoritative. `events.jsonl` is a regenerable projection with
 * redaction applied; projecting twice appends nothing new.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '../adapters/types.js';
import { ensureRunDir, type StatePaths } from '../storage/paths.js';
import { appendEvent, listEvents, type AppendEventInput, type AppendEventResult, type EventRecord } from '../storage/events.js';
import { redactValue } from './redaction.js';

export interface EventContext {
  readonly runId: string;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
}

/** Map a normalized runtime event to an application event row. Idempotent per (session, sequence). */
export function runtimeEventToAppend(event: RuntimeEvent, ctx: EventContext): AppendEventInput {
  return {
    runId: ctx.runId,
    taskId: ctx.taskId ?? null,
    attemptId: ctx.attemptId ?? null,
    type: `runtime.${event.kind}`,
    payload: {
      adapter: event.adapter,
      sessionId: event.sessionId,
      turnId: event.turnId,
      runtimeSequence: event.sequence,
      ...event.payload,
    },
    payloadRef: event.rawRef,
    idempotencyKey: `${event.adapter}:${event.sessionId}:${event.sequence}`,
    timestamp: event.timestamp,
  };
}

export function recordRuntimeEvent(db: DatabaseSync, event: RuntimeEvent, ctx: EventContext): AppendEventResult {
  return appendEvent(db, runtimeEventToAppend(event, ctx));
}

/** Evidence summary of one turn's events: what the runtime claimed versus what was observed. */
export interface TurnEvidence {
  readonly claimedDone: boolean;
  readonly completed: boolean;
  readonly interrupted: boolean;
  readonly fileChanges: ReadonlyArray<string>;
  readonly fileChangesOutsideAllowedPaths: ReadonlyArray<string>;
  readonly commandsExecuted: number;
  readonly toolCalls: number;
  readonly errors: ReadonlyArray<Record<string, unknown>>;
  readonly rawEvents: number;
}

export function summarizeTurnEvidence(events: Iterable<RuntimeEvent>): TurnEvidence {
  let claimedDone = false;
  let completed = false;
  let interrupted = false;
  const fileChanges: string[] = [];
  const outside: string[] = [];
  let commandsExecuted = 0;
  let toolCalls = 0;
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
        const changed = typeof event.payload['path'] === 'string' ? (event.payload['path'] as string) : '(unknown path)';
        fileChanges.push(changed);
        if (event.payload['withinAllowedPaths'] === false) outside.push(changed);
        break;
      }
      case 'command_exec':
        commandsExecuted += 1;
        break;
      case 'tool_call':
        toolCalls += 1;
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
  return { claimedDone, completed, interrupted, fileChanges, fileChangesOutsideAllowedPaths: outside, commandsExecuted, toolCalls, errors, rawEvents };
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
