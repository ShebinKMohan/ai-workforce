import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateIssueSchema, StartIssueSchema, UpdateIssueSchema } from '../../src/issues/contracts.js';
import { IssueStore } from '../../src/issues/store.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';

afterEach(cleanupAll);
const create = (extra = {}) => CreateIssueSchema.parse({ projectId: 'project-a', title: 'Build the issue board', description: '# PRD\n\nExact text, including `code` and $().\n', idempotencyKey: 'submission-1', ...extra });

describe('durable project issue records', () => {
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
