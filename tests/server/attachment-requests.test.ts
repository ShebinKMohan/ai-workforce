/** Upload and request-boundary proof. Intake/readiness are injected; only a
 * tiny Node fixture process runs, never an installed coding CLI or model. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlIntakeInput, ControlIntakeResult } from '../../src/routing/control-intake.js';
import { storeAttachments, type AttachmentDescriptor } from '../../src/server/attachments.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { RequestQueue, type RequestItem, type RequestQueueOptions } from '../../src/server/requests.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, gitRepo, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest } from './support.js';

const servers: OfficeServer[] = [];
const queues: RequestQueue[] = [];
const children: ChildProcess[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  for (const release of releases.splice(0)) release();
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  })));
  cleanupAll();
});

async function workspace(): Promise<string> {
  const root = path.join(tempDir('attachment-request-state-'), 'state');
  const repo = await gitRepo({ 'README.md': 'Fixture project.' });
  updateWorkspace(root, current => applyWorkspaceOps(current, parseWorkspaceOps([
    { op: 'project.add', name: 'project', repoPath: repo, checks: ['node --version'] },
    { op: 'runtime.set', id: 'fixture', adapter: 'fake', executable: process.execPath },
    { op: 'control-center.set', runtime: 'fixture' },
    { op: 'department.add', id: 'eng', name: 'Engineering' },
    { op: 'agent.add', id: 'head', name: 'Head', role: 'head', departmentId: 'eng', runtime: 'fixture' },
    { op: 'agent.add', id: 'worker', name: 'Worker', role: 'worker', departmentId: 'eng', runtime: 'fixture', projectIds: ['project'] },
  ])));
  return root;
}

async function office(root: string) {
  const discover = vi.fn(async () => []);
  const spawner = vi.fn(() => { throw new Error('Uploading a file must never launch a runtime.'); });
  const server = await startOfficeServer({ stateRoot: root, port: 0, discover, spawner });
  servers.push(server);
  return { server, discover, spawner };
}

function uploadBody(name: string, bytes: Buffer | string = 'User-provided fixture context.', mimeType = 'text/plain') {
  return { files: [{ name, mimeType, data: Buffer.from(bytes).toString('base64') }] };
}

function headers(server: OfficeServer): Record<string, string> {
  return { origin: originFor(server), 'x-workforce-token': server.token, 'content-type': 'application/json' };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

function reply(input: ControlIntakeInput): ControlIntakeResult {
  return { route: { state: 'selected', method: 'direct_reply', projectId: input.projectId,
    departmentId: null, headAgentId: null, reason: 'Fixture intake read the supplied context.',
    decidedAt: new Date().toISOString(), elapsedMs: 1, workspaceRevision: input.workspace.revision },
  reply: 'The attached context is available.' };
}

const invocation = { command: 'fixture-node', args: ['fixture-cli'], cwd: process.cwd() };
const childSource = `
const fs = require('node:fs');
const release = process.argv[1];
const runId = 'attachment-fixture-' + process.pid;
process.stdout.write(JSON.stringify({ type: 'run.created', runId }) + '\\n');
process.on('SIGINT', () => process.exit(130));
setInterval(() => { if (fs.existsSync(release)) {
  process.stdout.write(JSON.stringify({ ok: true, command: 'run', exitCode: 0, runId }) + '\\n');
  process.exit(0);
} }, 10);
`;

function harness(root: string, intake: NonNullable<RequestQueueOptions['routeControl']> = async input => reply(input)) {
  const control = tempDir('attachment-request-children-');
  const routeControl = vi.fn(intake);
  const calls: Array<{ command: string; args: string[]; shell: unknown }> = [];
  const queue = new RequestQueue({ stateRoot: root, passStateDir: true, env: process.env, invocation, pollMs: 15,
    readiness: async () => ({ checkedAt: new Date().toISOString(), reports: [] }), routeControl,
    spawner: (command, args, options) => {
      calls.push({ command, args: [...args], shell: options.shell });
      const child = spawn(process.execPath, ['-e', childSource, path.join(control, `release-${calls.length}`)], { ...options, shell: false });
      children.push(child);
      return child;
    },
  });
  queues.push(queue);
  return { queue, routeControl, calls, release: (index: number) => writeFileSync(path.join(control, `release-${index}`), '') };
}

async function until(queue: RequestQueue, id: string, predicate: (item: RequestItem) => boolean): Promise<RequestItem> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const item = queue.get(id);
    if (predicate(item)) return item;
    if (Date.now() > deadline) throw new Error(`Attachment request did not settle: ${JSON.stringify(item)}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

function savedItem(root: string, id: string): RequestItem {
  const saved = JSON.parse(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8')) as { items: RequestItem[] };
  return saved.items.find(item => item.id === id)!;
}

describe('attachment uploads and durable request context', () => {
  it('refuses missing/foreign Host or Origin and missing/wrong tokens before creating attachment storage', async () => {
    const root = tempDir('attachment-write-gates-');
    const target = await office(root);
    const valid = headers(target.server);
    const noOrigin = { ...valid }; delete noOrigin.origin;
    const noToken = { ...valid }; delete noToken['x-workforce-token'];
    for (const requestHeaders of [
      { ...valid, host: '' },
      { ...valid, host: `attacker.example:${target.server.port}` },
      noOrigin,
      { ...valid, origin: 'https://attacker.example' },
      noToken,
      { ...valid, 'x-workforce-token': 'not-this-server-token' },
    ]) {
      const response = await rawRequest(target.server, { method: 'POST', path: '/api/attachments',
        headers: requestHeaders, body: JSON.stringify(uploadBody('context.txt')) });
      expect(response.status).toBe(403);
      expect(existsSync(path.join(root, 'serve', 'attachments'))).toBe(false);
    }
    expect(target.discover).not.toHaveBeenCalled();
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('returns opaque upload receipts and forwards verified bytes/identity to intake after persisting the request', async () => {
    const root = await workspace();
    const target = await office(root);
    const text = 'Specific user context that must not become raw argv or request JSON.';
    const response = await rawRequest(target.server, { method: 'POST', path: '/api/attachments',
      headers: headers(target.server), body: JSON.stringify(uploadBody('requirements.txt', text)) });
    expect(response.status).toBe(201);
    const uploaded = JSON.parse(response.body) as { ok: boolean; attachments: AttachmentDescriptor[] };
    expect(uploaded).toEqual({ ok: true, attachments: [{ id: expect.any(String), name: 'requirements.txt', mimeType: 'text/plain', size: Buffer.byteLength(text) }] });
    expect(response.body).not.toContain(root);
    expect(response.body).not.toContain(Buffer.from(text).toString('base64'));
    expect(target.spawner).not.toHaveBeenCalled();
    await target.server.close();
    servers.splice(servers.indexOf(target.server), 1);

    const entered = gate(); const finish = gate();
    const h = harness(root, async input => { entered.resolve(); await finish.promise; return reply(input); });
    const item = await h.queue.submit({ projectId: 'project', task: 'Explain the attached requirements.',
      attachmentIds: uploaded.attachments.map(file => file.id), clientRequestId: 'durable-attachment-message' });
    expect(savedItem(root, item.id)).toMatchObject({ state: 'queued', route: { state: 'pending' }, attachments: uploaded.attachments });
    expect(readFileSync(path.join(root, 'serve', 'requests.json'), 'utf8')).not.toContain(text);
    await entered.promise;
    const input = h.routeControl.mock.calls[0]![0];
    expect(input.attachments).toEqual([{ path: expect.any(String), name: 'requirements.txt', mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }]);
    expect(readFileSync(input.attachments![0]!.path, 'utf8')).toBe(text);
    finish.resolve();
    const ended = await until(h.queue, item.id, value => value.state === 'ended');
    expect(ended.attachments).toEqual(uploaded.attachments);
    expect(h.calls).toHaveLength(0);
  });

  it('deduplicates identical attachment submissions and refuses changed, reordered or omitted attachment identities', async () => {
    const root = await workspace();
    const uploaded = await storeAttachments(root, { files: [uploadBody('one.txt', 'one').files[0], uploadBody('two.txt', 'two').files[0]] });
    const ids = uploaded.attachments.map(file => file.id);
    const h = harness(root);
    const body = { projectId: 'project', task: 'Explain these documents.', attachmentIds: ids, clientRequestId: 'attachment-dedup' };
    const [first, duplicate] = await Promise.all([h.queue.submit(body), h.queue.submit(body)]);
    expect(first.id).toBe(duplicate.id);
    await until(h.queue, first.id, item => item.state === 'ended');
    for (const attachmentIds of [[ids[1]!, ids[0]!], [ids[0]!], [], [randomUUID()]]) {
      await expect(h.queue.submit({ ...body, attachmentIds })).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    }
    const { attachmentIds: _ignored, ...withoutAttachments } = body;
    await expect(h.queue.submit(withoutAttachments)).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' });
    expect((await h.queue.submit(body)).id).toBe(first.id);
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses unknown, duplicate and too many attachment IDs without writing a request or starting intake', async () => {
    const root = await workspace(); const h = harness(root);
    const unknown = randomUUID();
    await expect(h.queue.submit({ projectId: 'project', task: 'Read it.', attachmentIds: [unknown] })).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' });
    for (const attachmentIds of [[unknown, unknown], Array.from({ length: 9 }, () => randomUUID()), ['../../outside']]) {
      await expect(h.queue.submit({ projectId: 'project', task: 'Read it.', attachmentIds })).rejects.toMatchObject({ status: 400 });
    }
    expect(existsSync(path.join(root, 'serve', 'requests.json'))).toBe(false);
    expect(h.routeControl).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('enforces the combined request size across files from separately accepted upload batches', async () => {
    const root = await workspace();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 120);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const saved = await storeAttachments(root, uploadBody(`part-${index}.txt`, bytes));
      ids.push(saved.attachments[0]!.id);
    }
    const h = harness(root);
    await expect(h.queue.submit({ projectId: 'project', task: 'Read the combined context.', attachmentIds: ids }))
      .rejects.toMatchObject({ status: 413, code: 'attachments_too_large' });
    expect(existsSync(path.join(root, 'serve', 'requests.json'))).toBe(false);
    expect(h.routeControl).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('rechecks an attachment that changed while its request waited and blocks before a second intake', async () => {
    const root = await workspace();
    const saved = await storeAttachments(root, uploadBody('context.txt', 'original context'));
    const entered = gate(); const finish = gate();
    const h = harness(root, async input => {
      if (input.task === 'Hold this intake.') { entered.resolve(); await finish.promise; }
      return reply(input);
    });
    const active = await h.queue.submit({ projectId: 'project', task: 'Hold this intake.' });
    await entered.promise;
    const queued = await h.queue.submit({ projectId: 'project', task: 'Read the original attachment.', attachmentIds: [saved.attachments[0]!.id] });
    const file = path.join(root, 'serve', 'attachments', saved.attachments[0]!.id, 'content.bin');
    chmodSync(file, 0o600);
    writeFileSync(file, 'modified context');
    finish.resolve();
    await until(h.queue, active.id, item => item.state === 'ended');
    const blocked = await until(h.queue, queued.id, item => item.state === 'failed_to_start');
    expect(blocked.result?.code).toBe('attachment_integrity_failed');
    expect(blocked.route).toMatchObject({ state: 'blocked', code: 'attachment_integrity_failed' });
    expect(blocked.attachments).toEqual(saved.attachments);
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
  });

  it('dispatches only exact opaque attachment IDs in argument arrays after intake delegates', async () => {
    const root = await workspace();
    const text = 'Literal attachment body $(not-a-command) `not-a-command-either`';
    const uploaded = await storeAttachments(root, { files: [uploadBody('a file.txt', text).files[0], uploadBody('log.txt', 'another input').files[0]] });
    const h = harness(root, async input => ({ route: { state: 'selected', method: 'classifier', projectId: input.projectId,
      departmentId: 'eng', headAgentId: 'head', reason: 'Engineering owns this task.', elapsedMs: 1,
      decidedAt: new Date().toISOString(), workspaceRevision: input.workspace.revision } }));
    const item = await h.queue.submit({ projectId: 'project', task: 'Implement the attached requirements.', attachmentIds: uploaded.attachments.map(file => file.id), allowUnconfinedWrites: true });
    await until(h.queue, item.id, value => value.state === 'running');
    expect(h.routeControl).toHaveBeenCalledTimes(1);
    expect(h.routeControl.mock.calls[0]![0].attachments).toHaveLength(2);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.command).toBe(invocation.command);
    expect(call.shell).toBe(false);
    expect(call.args.filter(arg => arg.startsWith('--attachment='))).toEqual(uploaded.attachments.map(file => `--attachment=${file.id}`));
    expect(call.args).not.toContain(text);
    expect(call.args.join('\n')).not.toContain(Buffer.from(text).toString('base64'));
    expect(call.args.some(arg => arg.includes('content.bin'))).toBe(false);
    h.release(1);
    await until(h.queue, item.id, value => value.state === 'ended');
  });
});
