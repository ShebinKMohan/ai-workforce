/**
 * `GET /api/events` — recorded events as Server-Sent Events (FR084).
 *
 * The same approach as `workforce watch`: poll the events table read-only,
 * cursored, never a full scan, backing off once it goes quiet. A table's
 * cursor is its `rowid` (see `listEventsAfterCursor`): a row committed later
 * always has a larger one, so a reader that remembers the last one it saw
 * never misses or repeats an event.
 *
 * There is one database per project (`<state-root>/projects/<id>/state.sqlite`)
 * plus the root's own database, which holds runs made before workspaces. The
 * stream has two forms, chosen afresh on every poll:
 *
 * - **Before any workspace** (no `workspace.json`, no project state roots): the
 *   root database alone, and each event's SSE `id` is its plain rowid — exactly
 *   the stream the office view always had.
 * - **With a workspace**: every project database and the root database. Each
 *   event names its `projectId` (null for the root's earlier history), and its
 *   SSE `id` is a composite cursor, `~=<root rowid>,<project>=<rowid>,...`,
 *   holding the position in EVERY source. A browser that reconnects with
 *   `Last-Event-ID` resumes each project exactly where it stopped. A plain
 *   integer cursor from the first form resumes the root; a project the cursor
 *   does not name is read from its beginning, because none of its events were
 *   delivered yet. Order is preserved within a project, never invented across
 *   projects.
 *
 * A source with no database yet is not an error: it is read once it exists.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IDLE_POLL_MS, IDLE_POLLS_BEFORE_BACKOFF, PAGE_SIZE, POLL_MS } from '../cli/commands/watch.js';
import { SLUG_PATTERN } from '../core/workspace-config.js';
import { openStateStore, StateNotFoundError, type StateStore } from '../storage/db.js';
import { listEventsAfterCursor, type CursoredEvent } from '../storage/events.js';
import { SchemaTooNewError } from '../storage/migrations.js';
import { createStatePaths } from '../storage/paths.js';
import { redactedJson } from '../telemetry/redaction.js';
import { projectStatePaths } from '../workspace/paths.js';
import { API_CSP, securityHeaders } from './http.js';
import { formatCompositeCursor, isWorkspaceMode, projectRootIds, ROOT_SOURCE } from './project-reads.js';

export { formatCompositeCursor, ROOT_SOURCE };

export const HEARTBEAT_MS = 15_000;
/** How long a browser waits before reconnecting, sent once per connection. */
export const RETRY_MS = 2_000;
const MAX_CURSOR_CHARS = 16_384;

export interface EventStreamOptions {
  /** The state root: `workspace.json`, `projects/<id>/` and the root's own database. */
  readonly stateRoot: string;
  readonly pollMs?: number;
  readonly idlePollMs?: number;
  readonly pageSize?: number;
  readonly heartbeatMs?: number;
}

/** A plain rowid cursor from `Last-Event-ID` or `?after=`; anything else is null. */
export function parseCursor(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d{1,15}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export type CursorMap = Record<string, number>;

/**
 * A cursor in either form: a plain rowid (the root database) or
 * `key=rowid,key=rowid` where a key is `~` or a project id. Anything malformed
 * is null, and the stream then starts from the beginning.
 */
export function parseCompositeCursor(value: string | null | undefined): CursorMap | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  const plain = parseCursor(trimmed);
  if (plain !== null) return { [ROOT_SOURCE]: plain };
  if (trimmed.length === 0 || trimmed.length > MAX_CURSOR_CHARS) return null;
  const map: CursorMap = {};
  for (const part of trimmed.split(',')) {
    const match = /^([^=]+)=(\d{1,15})$/.exec(part);
    if (match === null) return null;
    const key = match[1]!;
    if (key !== ROOT_SOURCE && !SLUG_PATTERN.test(key)) return null;
    map[key] = Number(match[2]);
  }
  return map;
}

export function eventFrame(row: CursoredEvent, id: string, projectId: string | null): string {
  const { event } = row;
  const data = redactedJson({
    cursor: row.cursor,
    projectId,
    runId: event.runId,
    sequence: event.sequence,
    taskId: event.taskId,
    attemptId: event.attemptId,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
    payloadRef: event.payloadRef,
  });
  // JSON.stringify escapes every newline, so `data` is always one SSE line.
  return `id: ${id}\ndata: ${data}\n\n`;
}

interface Source {
  store: StateStore | null;
  /** The last error reported for this source, so a persistent one is reported once. */
  reported: string | null;
}

/** Serve one SSE connection until the client goes away or the server closes it. */
export function serveEventStream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, options: EventStreamOptions, open: Set<ServerResponse>): void {
  const header = req.headers['last-event-id'];
  const cursor: CursorMap = parseCompositeCursor(Array.isArray(header) ? header[0] : header) ?? parseCompositeCursor(query.get('after')) ?? {};
  const pollMs = options.pollMs ?? POLL_MS;
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  res.writeHead(200, {
    ...securityHeaders(API_CSP),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${RETRY_MS}\n\n`);
  open.add(res);

  const sources = new Map<string, Source>();
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let idlePolls = 0;
  let lastWrite = Date.now();

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const source of sources.values()) source.store?.close();
    sources.clear();
    open.delete(res);
  };
  const fail = (code: string, message: string): void => {
    if (!closed) res.end(`event: stream-error\ndata: ${redactedJson({ code, message })}\n\n`);
    finish();
  };
  const schedule = (ms: number): void => {
    if (!closed) timer = setTimeout(tick, ms);
  };

  /** Open a source read-only; null while it has no database. Throws what the legacy form must fail on. */
  function storeFor(key: string, workspaceMode: boolean): StateStore | null {
    let source = sources.get(key);
    if (source === undefined) {
      source = { store: null, reported: null };
      sources.set(key, source);
    }
    if (source.store !== null) return source.store;
    const paths = key === ROOT_SOURCE ? createStatePaths(options.stateRoot) : projectStatePaths(options.stateRoot, key);
    try {
      source.store = openStateStore(paths, { mode: 'read-only' });
      return source.store;
    } catch (error) {
      if (error instanceof StateNotFoundError) return null;
      if (!workspaceMode) throw error;
      const message = (error as Error).message;
      if (source.reported !== message) {
        source.reported = message;
        res.write(`event: source-error\ndata: ${redactedJson({ projectId: key === ROOT_SOURCE ? null : key, code: error instanceof SchemaTooNewError ? 'state_schema_too_new' : 'source_unreadable', message })}\n\n`);
      }
      return null;
    }
  }

  function tick(): void {
    timer = null;
    if (closed) return;
    try {
      const workspaceMode = isWorkspaceMode(options.stateRoot);
      const keys = workspaceMode ? [ROOT_SOURCE, ...projectRootIds(options.stateRoot)] : [ROOT_SOURCE];
      let flushed = true;
      let delivered = 0;
      let fullPage = false;
      for (const key of keys) {
        let store: StateStore | null;
        try {
          store = storeFor(key, workspaceMode);
        } catch (error) {
          if (error instanceof SchemaTooNewError) return fail('state_schema_too_new', error.message);
          throw error;
        }
        if (store === null) continue;
        let rows: CursoredEvent[];
        try {
          rows = listEventsAfterCursor(store.db, { afterCursor: cursor[key] ?? 0, limit: pageSize });
        } catch (error) {
          if (!workspaceMode) throw error;
          // A project database still being created: close it and read it again next time.
          store.close();
          sources.get(key)!.store = null;
          continue;
        }
        for (const row of rows) {
          cursor[key] = row.cursor;
          const id = workspaceMode ? formatCompositeCursor(cursor) : String(row.cursor);
          flushed = res.write(eventFrame(row, id, key === ROOT_SOURCE ? null : key));
        }
        delivered += rows.length;
        if (rows.length === pageSize) fullPage = true;
      }
      if (delivered > 0) {
        idlePolls = 0;
        lastWrite = Date.now();
      } else {
        idlePolls += 1;
        if (Date.now() - lastWrite >= heartbeatMs) {
          flushed = res.write(': keepalive\n\n');
          lastWrite = Date.now();
        }
      }
      const delay = fullPage ? 0 : idlePolls >= IDLE_POLLS_BEFORE_BACKOFF ? idlePollMs : pollMs;
      // A slow reader is waited for rather than buffered without bound.
      if (!flushed) res.once('drain', () => schedule(delay));
      else schedule(delay);
    } catch (error) {
      fail('stream_failed', (error as Error).message);
    }
  }

  req.on('close', finish);
  res.on('close', finish);
  tick();
}
