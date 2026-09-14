/** Durable board metadata. Engine databases remain the only execution authority. */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { ApiError } from '../server/http.js';
import type { RequestItem } from '../server/requests.js';
import { IssueRecordSchema, issueTask, type CreateIssue, type IssueRecord, type StartIssue, type UpdateIssue } from './contracts.js';
import { MAX_TASK_CHARS } from '../server/launch.js';

const encode = (value: unknown) => JSON.stringify(value);
const digest = (value: unknown) => sha256Hex(encode(value));
const decode = (row: unknown): IssueRecord | null => row ? IssueRecordSchema.parse(JSON.parse((row as { record_json: string }).record_json)) : null;
const unknown = () => new ApiError(404, 'unknown_issue', 'This issue is not recorded in this workspace.');
function conflict(issue: IssueRecord): never {
  throw new ApiError(409, 'issue_revision_conflict', 'This issue changed. Reload it before saving your edit.', [], { revision: issue.revision });
}

export class IssueStore {
  readonly filename: string;
  constructor(stateRoot: string) { this.filename = path.join(path.resolve(stateRoot), 'serve', 'issues.sqlite'); }

  private use<T>(write: boolean, operation: (db: DatabaseSync | null) => T): T {
    if (!write && !existsSync(this.filename)) return operation(null);
    const directory = path.dirname(this.filename);
    if (write) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || existsSync(this.filename) && !lstatSync(this.filename).isFile()) {
      throw new ApiError(409, 'issue_storage_unsafe', 'Issue storage must be a regular file in the workspace state directory.');
    }
    const db = new DatabaseSync(this.filename, { readOnly: !write });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      if (write) db.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== 1 && !(write && version === 0)) throw new ApiError(409, 'issue_schema_unsupported', 'The issue database has an unsupported schema version.');
      if (write) {
        if (version === 0) db.exec(`
          CREATE TABLE issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, creation_key TEXT NOT NULL,
            creation_hash TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(project_id, creation_key));
          CREATE INDEX issues_project ON issues(project_id);
          CREATE TABLE issue_updates (issue_id TEXT NOT NULL, key TEXT NOT NULL, body_hash TEXT NOT NULL,
            record_json TEXT NOT NULL, PRIMARY KEY(issue_id, key));
          PRAGMA user_version = 1;
        `);
      }
      try { const result = operation(db); if (write) db.exec('COMMIT'); return result; }
      catch (error) { if (write) db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }

  private read(db: DatabaseSync | null, id: string): IssueRecord {
    return decode(db?.prepare('SELECT record_json FROM issues WHERE id = ?').get(id)) ?? (() => { throw unknown(); })();
  }
  private save(db: DatabaseSync, issue: IssueRecord): IssueRecord {
    IssueRecordSchema.parse(issue);
    db.prepare('UPDATE issues SET record_json = ? WHERE id = ?').run(encode(issue), issue.id);
    return issue;
  }
  list(projectId?: string, page?: { limit: number; after?: string }): IssueRecord[] {
    return this.use(false, db => {
      if (!db) return [];
      const filters: string[] = []; const params: Array<string | number> = [];
      if (projectId !== undefined) { filters.push('project_id = ?'); params.push(projectId); }
      if (page?.after !== undefined) { filters.push('id < ?'); params.push(page.after); }
      const sql = `SELECT record_json FROM issues${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY id DESC${page ? ' LIMIT ?' : ''}`;
      if (page) params.push(page.limit);
      return db.prepare(sql).all(...params).map(row => decode(row)!);
    });
  }
  get(id: string): IssueRecord { return this.use(false, db => this.read(db, id)); }
  create(body: CreateIssue): IssueRecord {
    return this.use(true, db => {
      const previous = db!.prepare('SELECT record_json, creation_hash FROM issues WHERE project_id = ? AND creation_key = ?').get(body.projectId, body.idempotencyKey) as { record_json: string; creation_hash: string } | undefined;
      if (previous) {
        if (previous.creation_hash !== digest(body)) throw new ApiError(409, 'issue_idempotency_conflict', 'This idempotency key was already used with different issue content. Use the original request or a new key.');
        return decode(previous)!;
      }
      const at = nowIso();
      const issue: IssueRecord = { schemaVersion: 1, id: newId(), projectId: body.projectId, revision: 1,
        title: body.title, description: body.description, kind: body.kind, source: body.source,
        manualStatus: body.status, createdAt: at, updatedAt: at, dispatch: null };
      db!.prepare('INSERT INTO issues (id, project_id, creation_key, creation_hash, record_json) VALUES (?, ?, ?, ?, ?)')
        .run(issue.id, issue.projectId, body.idempotencyKey, digest(body), encode(issue));
      return issue;
    });
  }
  update(id: string, body: UpdateIssue): IssueRecord {
    return this.use(true, db => {
      const issue = this.read(db, id);
      if (body.idempotencyKey) {
        const prior = db!.prepare('SELECT body_hash, record_json FROM issue_updates WHERE issue_id = ? AND key = ?').get(id, body.idempotencyKey) as { body_hash: string; record_json: string } | undefined;
        if (prior) {
          if (prior.body_hash !== digest(body)) throw new ApiError(409, 'issue_idempotency_conflict', 'This update key was already used with different content.');
          return decode(prior)!;
        }
      }
      if (issue.revision !== body.expectRevision) conflict(issue);
      if (issue.dispatch && issue.dispatch.state !== 'refused' && (body.title !== undefined || body.description !== undefined)) {
        throw new ApiError(409, 'issue_content_frozen', 'This issue was sent to Control Center. Its submitted title and brief are preserved; create another issue for changed requirements.');
      }
      if (body.title !== undefined) issue.title = body.title;
      if (body.description !== undefined) issue.description = body.description;
      if (body.status !== undefined) issue.manualStatus = body.status;
      issue.revision++; issue.updatedAt = nowIso();
      this.save(db!, issue);
      if (body.idempotencyKey) db!.prepare('INSERT INTO issue_updates (issue_id, key, body_hash, record_json) VALUES (?, ?, ?, ?)').run(id, body.idempotencyKey, digest(body), encode(issue));
      return issue;
    });
  }
  beginDispatch(id: string, body: StartIssue): { issue: IssueRecord; claimed: boolean } {
    return this.use(true, db => {
      const issue = this.read(db, id);
      if (issue.dispatch && issue.dispatch.state !== 'refused') return { issue, claimed: false };
      if (issue.revision !== body.expectRevision) conflict(issue);
      const task = issueTask(issue);
      if (task.length > MAX_TASK_CHARS) throw new ApiError(400, 'issue_brief_too_large', `The title and complete description exceed the ${MAX_TASK_CHARS}-character Control Center task limit. Shorten the brief before starting; no content was truncated.`);
      const at = nowIso();
      issue.dispatch = { clientRequestId: `issue:${id}`, task,
        allowUnconfinedWrites: body.allowUnconfinedWrites, startedAt: at, state: 'pending', request: null, error: null };
      issue.revision++; issue.updatedAt = at;
      return { issue: this.save(db!, issue), claimed: true };
    });
  }
  recordRequest(id: string, request: RequestItem): IssueRecord {
    return this.use(true, db => {
      const issue = this.read(db, id);
      if (!issue.dispatch || issue.dispatch.clientRequestId !== request.clientRequestId || issue.projectId !== request.projectId || issue.dispatch.task !== request.task) {
        throw new ApiError(409, 'issue_request_mismatch', 'The request receipt does not belong to this issue.');
      }
      issue.dispatch.state = 'submitted'; issue.dispatch.request = request; issue.dispatch.error = null;
      return this.save(db!, issue);
    });
  }
  /** Mirror durable queue receipts before its bounded history is pruned. */
  recordRequests(requests: readonly RequestItem[]): void {
    if (!existsSync(this.filename)) return;
    const byKey = new Map(requests.filter(request => request.clientRequestId?.startsWith('issue:')).map(request => [request.clientRequestId!, request]));
    if (!byKey.size) return;
    this.use(true, db => {
      for (const row of db!.prepare('SELECT record_json FROM issues').all()) {
        const issue = decode(row)!;
        if (!issue.dispatch) continue;
        const request = byKey.get(issue.dispatch.clientRequestId);
        if (!request || request.projectId !== issue.projectId || request.task !== issue.dispatch.task) continue;
        if (JSON.stringify(request) === JSON.stringify(issue.dispatch.request)) continue;
        issue.dispatch.state = 'submitted'; issue.dispatch.request = request; issue.dispatch.error = null;
        this.save(db!, issue);
      }
    });
  }
  recordRefusal(id: string, message: string): IssueRecord {
    return this.use(true, db => {
      const issue = this.read(db, id);
      if (issue.dispatch?.state === 'pending') {
        issue.dispatch.state = 'refused'; issue.dispatch.error = message;
        issue.revision++; issue.updatedAt = nowIso(); this.save(db!, issue);
      }
      return issue;
    });
  }
}
