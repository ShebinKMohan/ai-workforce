import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadquartersServer } from '../../server.mjs';

let root, upstream, bridge, upstreamOrigin, origin, browserToken;
let upstreamToken = 'a'.repeat(64);
let identityValid = true;
let received = [];
let eventsClosed = 0;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const raw = (target, options = {}) => new Promise((resolve, reject) => {
  const url = new URL(origin);
  const req = request({ hostname: url.hostname, port: url.port, path: target, method: options.method ?? 'GET', headers: options.headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(options.body);
});
const post = (path, value, headers = {}) => raw(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'x-workforce-token': browserToken, ...headers }, body: JSON.stringify(value) });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'headquarters-bridge-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'index.html'), '<html><head><title>Headquarters</title></head><body></body></html>');
  await writeFile(join(root, 'src', 'app.js'), 'export const ready = true;');
  await writeFile(join(root, 'private.js'), 'private data');
  await symlink(join(root, 'private.js'), join(root, 'src', 'inside.js'));
  await symlink('/etc/hosts', join(root, 'src', 'outside.js'));
  upstream = createServer(async (req, res) => {
    if (req.url === '/api/office') return json(res, 200, { ok: true, coordinator: { name: identityValid ? 'workforce' : 'other', version: 'test', server: { pid: 123, startedAt: '2026-09-13T00:00:00Z', url: `${upstreamOrigin}/` } } });
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<head><meta name="workforce-session-token" content="${upstreamToken}" /></head>`); return; }
    if (req.headers.host !== new URL(upstreamOrigin).host || req.headers.origin !== upstreamOrigin) return json(res, 403, { error: { code: 'wrong_origin' } });
    if (req.method === 'POST' && req.headers['x-workforce-token'] !== upstreamToken) return json(res, 403, { ok: false, error: { code: 'token_rejected' } });
    if (req.url.startsWith('/api/events')) {
      received.push({ path: req.url, lastEventId: req.headers['last-event-id'] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      const timer = setTimeout(() => res.write('id: ~=1\ndata: {"type":"agent.started"}\n\n'), 15);
      res.once('close', () => { clearTimeout(timer); eventsClosed++; });
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, method: req.method, body, token: req.headers['x-workforce-token'], origin: req.headers.origin });
    if (req.url === '/api/disconnect') { req.socket.destroy(); return; }
    if (req.url === '/api/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('Unexpected page'); return; }
    if (req.url === '/api/refused') return json(res, 409, { ok: false, revision: 7, error: { code: 'revision_conflict', message: 'Workspace changed.' } });
    json(res, 200, { ok: true, path: req.url, body: body ? JSON.parse(body) : null });
  });
  upstreamOrigin = await listen(upstream);
  bridge = createHeadquartersServer({ root, backendUrl: upstreamOrigin, timeoutMs: 1000 });
  origin = await listen(bridge);
  browserToken = (await raw('/')).text.match(/name="workforce-session-token" content="([a-f0-9]+)"/)[1];
});

after(async () => { await stop(bridge); await stop(upstream); await rm(root, { recursive: true, force: true }); });

test('injects a separate browser session without exposing the upstream session', async () => {
  const response = await raw('/');
  assert.equal(response.status, 200);
  assert.match(browserToken, /^[a-f0-9]{64}$/);
  assert.notEqual(browserToken, upstreamToken);
  assert.equal(response.text.includes(upstreamToken), false);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('refuses foreign Host, Origin and fetch site before accessing the backend', async () => {
  const start = received.length;
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await raw('/api/workspace', { headers })).status, 403);
    assert.equal((await raw('/', { headers })).status, 403);
  }
  assert.equal(received.length, start);
});

test('writes require own Origin, current browser session and JSON', async () => {
  const start = received.length;
  assert.equal((await post('/api/requests', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/requests', {}, { 'x-workforce-token': 'invalid' })).status, 403);
  assert.equal((await post('/api/requests', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await raw('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(received.length, start);
});

test('forwards model catalogs, exact control choices, upload bytes and operation revisions', async () => {
  assert.equal((await raw('/api/runtimes/codex-local/models?refresh=1')).status, 200);
  const payload = { projectId: 'project-one', clientRequestId: 'stable-id', task: 'Read the attached file', mode: 'discuss', priorRequestId: 'previous-request', controlCenter: { runtime: 'codex-local', model: 'runtime-model', effort: 'high' }, attachmentIds: ['file-id'] };
  assert.deepEqual(JSON.parse((await post('/api/requests', payload)).text).body, payload);
  const files = { files: [{ name: 'brief.png', mimeType: 'image/png', data: Buffer.from([0, 255, 10, 13]).toString('base64') }] };
  assert.deepEqual(JSON.parse((await post('/api/attachments', files)).text).body, files);
  const ops = { expectRevision: 17, ops: [{ op: 'control-center.set', runtime: 'codex-local', model: 'runtime-model', effort: 'high' }] };
  assert.deepEqual(JSON.parse((await post('/api/workspace/ops', ops)).text).body, ops);
  assert.equal(received.at(-1).token, upstreamToken);
  assert.equal(received.at(-1).origin, upstreamOrigin);
});

test('forwards structured backend errors and revision conflicts without invented success', async () => {
  const response = await post('/api/refused', {});
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.text).revision, 7);
  assert.equal(JSON.parse(response.text).error.code, 'revision_conflict');
});

test('refreshes a rotated upstream page session only after explicit token rejection', async () => {
  upstreamToken = 'b'.repeat(64);
  const response = await post('/api/requests', { clientRequestId: 'rotated-session' });
  assert.equal(response.status, 200);
  assert.equal(received.filter(item => item.body?.includes('rotated-session')).length, 1);
  assert.equal((await raw('/')).text.includes(upstreamToken), false);
});

test('never retries a POST after an uncertain network failure', async () => {
  const before = received.filter(item => item.path === '/api/disconnect').length;
  assert.equal((await post('/api/disconnect', { clientRequestId: 'uncertain' })).status, 502);
  assert.equal(received.filter(item => item.path === '/api/disconnect').length, before + 1);
});

test('streams live events without buffering, preserves cursor and disconnects upstream', async () => {
  const closed = eventsClosed;
  await new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = request({ hostname: url.hostname, port: url.port, path: '/api/events?after=~=2', headers: { 'Last-Event-ID': '~=4,project=7' } }, res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk;
        if (text.includes('agent.started')) { res.destroy(); resolve(); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(received.at(-1).lastEventId, '~=4,project=7');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(eventsClosed, closed + 1);
});

test('blocks traversal, external symlinks and unexpected HTML from API', async () => {
  for (const path of ['/src/../private.js', '/src/%2e%2e/private.js', '/api/%2e%2e/', '/src/outside.js', '//src/app.js', '/server/runtime-bridge.mjs']) {
    assert.ok([400, 404].includes((await raw(path)).status), path);
  }
  assert.equal((await raw('/api/html')).status, 502);
});

test('bounds JSON posts while permitting actual file bytes up to the upload limit', async () => {
  const payload = { value: 'x'.repeat(270_000) };
  assert.equal((await post('/api/requests', payload)).status, 413);
  assert.equal((await post('/api/attachments', payload)).status, 200);
});

test('returns a useful disconnected state and rejects nonloopback backend configuration', async () => {
  assert.throws(() => createHeadquartersServer({ backendUrl: 'https://example.com' }), /loopback/);
  const status = JSON.parse((await raw('/api/bridge/status')).text);
  assert.equal(status.connected, true);
  assert.equal(status.coordinator.name, 'workforce');
  assert.equal(JSON.stringify(status).includes(upstreamToken), false);
  const disconnected = createHeadquartersServer({ root, backendUrl: 'http://127.0.0.1:1', timeoutMs: 100 });
  const disconnectedOrigin = await listen(disconnected);
  const response = await fetch(`${disconnectedOrigin}/api/workspace`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'runtime_unavailable');
  await stop(disconnected);
});

test('refuses an unrelated loopback service before forwarding any operation', async () => {
  identityValid = false;
  const independent = createHeadquartersServer({ root, backendUrl: upstreamOrigin });
  const independentOrigin = await listen(independent);
  const response = await fetch(`${independentOrigin}/api/workspace`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'runtime_identity_mismatch');
  await stop(independent);
  identityValid = true;
});
