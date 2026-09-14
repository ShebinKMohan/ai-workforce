import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/core/snapshot.js';
import { CreateIssueSchema, StartIssueSchema, UpdateIssueSchema } from '../../src/issues/contracts.js';
import { IssueStore } from '../../src/issues/store.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';

afterEach(() => { vi.useRealTimers(); cleanupAll(); });
const create = (extra = {}) => CreateIssueSchema.parse({ projectId: 'project-a', title: 'Build the issue board', description: '# PRD\n\nExact text, including `code` and $().\n', idempotencyKey: 'submission-1', ...extra });

describe('durable project issue records', () => {
  it('persists an explicit cancelled column and refuses dispatch until the issue is reopened', () => {
    const root = tempDir(); const store = new IssueStore(root); const saved = store.create(create({ status: 'cancelled' }));
    expect(new IssueStore(root).get(saved.id)).toMatchObject({ manualStatus: 'cancelled', completedAt: null, dispatch: null });
    expect(() => store.beginDispatch(saved.id, StartIssueSchema.parse({ expectRevision: saved.revision }))).toThrow(/Reopen/);
    expect(store.get(saved.id)).toEqual(saved);
    const reopened = store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 1, status: 'todo', idempotencyKey: 'reopen' }));
    expect(store.beginDispatch(saved.id, StartIssueSchema.parse({ expectRevision: reopened.revision })).claimed).toBe(true);
  });

  it('preserves legacy records and their original creation receipts without inventing a completion time', () => {
    const store = new IssueStore(tempDir()); const body = create({ status: 'done' }); const saved = store.create(body);
    const { priority: _priority, completedAt: _completedAt, ...legacyRecord } = saved;
    const { priority: _default, ...legacyBody } = body;
    const db = new DatabaseSync(store.filename);
    try { db.prepare('UPDATE issues SET record_json = ?, creation_hash = ? WHERE id = ?').run(JSON.stringify(legacyRecord), sha256Hex(JSON.stringify(legacyBody)), saved.id); }
    finally { db.close(); }
    expect(store.get(saved.id)).toMatchObject({ priority: 'none', completedAt: null, manualStatus: 'done' });
    expect(store.create(body)).toMatchObject({ id: saved.id, priority: 'none', completedAt: null });
    expect(() => store.create(create({ status: 'done', priority: 'high' }))).toThrow(/idempotency key/);
  });

  it('stores priority changes after dispatch without changing the frozen task, and deduplicates update receipts', () => {
    const store = new IssueStore(tempDir()); const saved = store.create(create({ priority: 'urgent' }));
    expect(saved.priority).toBe('urgent');
    store.beginDispatch(saved.id, StartIssueSchema.parse({ expectRevision: saved.revision }));
    const body = UpdateIssueSchema.parse({ expectRevision: 2, priority: 'low', idempotencyKey: 'priority-change' });
    const changed = store.update(saved.id, body);
    expect(changed).toMatchObject({ revision: 3, priority: 'low', dispatch: { task: `${saved.title}\n\n${saved.description}` } });
    store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 3, priority: 'medium' }));
    expect(store.update(saved.id, body)).toEqual(changed);
    expect(store.get(saved.id).priority).toBe('medium');
    expect(() => store.update(saved.id, { ...body, priority: 'high' })).toThrow(/different content/);
    expect(() => create({ priority: 'critical' })).toThrow();
  });

  it('records only actual manual Done transitions and keeps completion separate from later edits', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-09-14T10:00:00.000Z');
    const store = new IssueStore(tempDir()); const saved = store.create(create());
    expect(saved.completedAt).toBeNull();
    vi.setSystemTime('2026-09-14T11:00:00.000Z');
    const done = store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 1, status: 'done', idempotencyKey: 'mark-done' }));
    expect(done.completedAt).toBe('2026-09-14T11:00:00.000Z');
    vi.setSystemTime('2026-09-14T12:00:00.000Z');
    const edited = store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 2, status: 'done', priority: 'high' }));
    expect(edited.completedAt).toBe(done.completedAt); expect(edited.updatedAt).not.toBe(done.completedAt);
    const reopened = store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 3, status: 'todo' }));
    expect(reopened.completedAt).toBeNull();
    vi.setSystemTime('2026-09-14T13:00:00.000Z');
    const finished = store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 4, status: 'done' }));
    expect(finished.completedAt).toBe('2026-09-14T13:00:00.000Z');
    expect(store.update(saved.id, UpdateIssueSchema.parse({ expectRevision: 1, status: 'done', idempotencyKey: 'mark-done' })).completedAt).toBe(done.completedAt);
    expect(store.get(saved.id).completedAt).toBe(finished.completedAt);
  });

  it('keeps an empty read passive and preserves exact PRD and manual columns after reopening', () => {
    const root = tempDir(); const first = new IssueStore(root);
    expect(first.list()).toEqual([]); expect(existsSync(first.filename)).toBe(false);
    const issue = first.create(create({ kind: 'prd', source: 'codex' }));
    const reopened = new IssueStore(root);
    expect(reopened.get(issue.id)).toEqual(issue);
    const updated = reopened.update(issue.id, UpdateIssueSchema.parse({ expectRevision: 1, status: 'done' }));
    expect(new IssueStore(root).get(issue.id)).toMatchObject({ revision: 2, manualStatus: 'done', dispatch: null, description: create().description });
    expect(updated.createdAt).toBe(issue.createdAt);
  });

  it('deduplicates retries across store instances and refuses a changed payload for the same project key', async () => {
    const root = tempDir(); const a = new IssueStore(root); const b = new IssueStore(root);
    const [one, two] = await Promise.all([Promise.resolve().then(() => a.create(create())), Promise.resolve().then(() => b.create(create()))]);
    expect(one.id).toBe(two.id); expect(a.list('project-a')).toHaveLength(1);
    expect(() => b.create(create({ description: 'different PRD' }))).toThrow(/idempotency key/);
    expect(b.create(create({ projectId: 'project-b' })).id).not.toBe(one.id);
    expect(a.list('project-a')).toHaveLength(1); expect(a.list('project-b')).toHaveLength(1);
  });

  it('serializes first-write initialization and duplicate submissions from separate processes', async () => {
    const root = tempDir();
    const source = `import { IssueStore } from './src/issues/store.ts'; import { CreateIssueSchema } from './src/issues/contracts.ts';
      const issue = new IssueStore(process.argv[1]).create(CreateIssueSchema.parse({ projectId: 'project-a', title: 'Concurrent create', idempotencyKey: 'same-key' }));
      process.stdout.write(JSON.stringify({ id: issue.id }));`;
    const writer = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, root], { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout).id) : reject(new Error(stderr)));
    });
    const ids = await Promise.all([writer(), writer(), writer()]);
    expect(new Set(ids).size).toBe(1); expect(new IssueStore(root).list()).toHaveLength(1);
  }, 15000);

  it('allows one revision winner and durably replays an uncertain update without overwriting later work', async () => {
    const root = tempDir(); const a = new IssueStore(root); const b = new IssueStore(root); const issue = a.create(create());
    const body = UpdateIssueSchema.parse({ expectRevision: 1, status: 'todo', idempotencyKey: 'move-1' });
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => a.update(issue.id, body)),
      Promise.resolve().then(() => b.update(issue.id, UpdateIssueSchema.parse({ expectRevision: 1, title: 'Stale title' }))),
    ]);
    expect(outcomes.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
    const second = b.update(issue.id, UpdateIssueSchema.parse({ expectRevision: 2, status: 'in_review' }));
    expect(a.update(issue.id, body)).toMatchObject({ revision: 2, manualStatus: 'todo' });
    expect(a.get(issue.id)).toEqual(second);
    expect(() => b.update(issue.id, { ...body, status: 'done' })).toThrow(/different content/);
  });

  it('writes a stable exact dispatch intent before execution and never claims the same issue twice', () => {
    const root = tempDir(); const store = new IssueStore(root); const issue = store.create(create());
    const started = store.beginDispatch(issue.id, StartIssueSchema.parse({ expectRevision: 1 }));
    expect(started.claimed).toBe(true);
    expect(new IssueStore(root).get(issue.id)).toMatchObject({ revision: 2, dispatch: {
      state: 'pending', clientRequestId: `issue:${issue.id}`, task: `${create().title}\n\n${create().description}`, request: null, allowUnconfinedWrites: false,
    } });
    expect(store.beginDispatch(issue.id, StartIssueSchema.parse({ expectRevision: 1 })).claimed).toBe(false);
    expect(() => store.update(issue.id, UpdateIssueSchema.parse({ expectRevision: 2, description: 'silently replaced' }))).toThrow(/preserved/);
    store.update(issue.id, UpdateIssueSchema.parse({ expectRevision: 2, status: 'todo' }));
    expect(store.get(issue.id).dispatch?.task).toBe(`${create().title}\n\n${create().description}`);
  });

  it('lets a known preflight refusal be corrected and started with fresh revision, preserving stable identity', () => {
    const store = new IssueStore(tempDir()); const issue = store.create(create({ description: '' }));
    store.beginDispatch(issue.id, StartIssueSchema.parse({ expectRevision: 1 }));
    const refused = store.recordRefusal(issue.id, 'consent required');
    expect(refused.dispatch?.task).toBe(issue.title);
    expect(() => store.beginDispatch(issue.id, StartIssueSchema.parse({ expectRevision: 1 }))).toThrow(/changed/);
    const retried = store.beginDispatch(issue.id, StartIssueSchema.parse({ expectRevision: refused.revision, allowUnconfinedWrites: true }));
    expect(retried.claimed).toBe(true);
    expect(retried.issue.dispatch).toMatchObject({ clientRequestId: `issue:${issue.id}`, allowUnconfinedWrites: true });
  });
});
