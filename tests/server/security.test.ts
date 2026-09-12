/**
 * The office server's boundary (FR084, AT27).
 *
 * One route of this server spends a paid model turn, and every route reads a
 * developer's coordinator state. These tests are the attacks a foreign web
 * page or a crafted URL can actually make: a rebinding hostname, a
 * cross-origin fetch, a forged or missing session token, a CORS preflight,
 * and paths built to climb out of the vendored UI.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { defaultWebRoot } from '../../src/server/static.js';
import { cleanupAll, tempDir } from '../workspaces/support.js';
import { openEventStream, originFor, rawRequest, sessionToken, startRequest, type RawResponse } from './support.js';

let server: OfficeServer;
let webRoot: string;
const spawnCalls: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }> = [];
const seen: RawResponse[] = [];

async function request(...args: Parameters<typeof rawRequest>): Promise<RawResponse> {
  const response = await rawRequest(...args);
  seen.push(response);
  return response;
}

beforeAll(async () => {
  const base = tempDir('workforce-serve-security-');
  webRoot = path.join(base, 'web', 'office');
  mkdirSync(path.join(webRoot, 'src'), { recursive: true });
  mkdirSync(path.join(webRoot, 'public', 'assets'), { recursive: true });
  writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><html><head><title>office</title></head><body>page</body></html>\n');
  writeFileSync(path.join(webRoot, 'src', 'app.js'), 'export const ok = 1;\n');
  writeFileSync(path.join(webRoot, 'public', 'assets', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(path.join(webRoot, 'PROVENANCE.md'), 'SECRET-MARKER inside the web root but not a served root\n');
  // Outside the web root, with an extension the server would otherwise serve.
  writeFileSync(path.join(base, 'web', 'secret.js'), 'SECRET-MARKER one level out\n');
  writeFileSync(path.join(base, 'secret.txt'), 'SECRET-MARKER two levels out\n');
  symlinkSync(path.join(base, 'web', 'secret.js'), path.join(webRoot, 'src', 'link.js'));

  server = await startOfficeServer({
    stateRoot: path.join(base, 'state'),
    port: 0,
    webRoot,
    discover: async () => [],
    spawner: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      throw new Error('a refused request must never reach the spawner');
    },
  });
});

afterAll(async () => {
  await server.close();
  cleanupAll();
});

describe('where the office server listens', () => {
  it('binds 127.0.0.1 only, so another interface of this machine is refused', async () => {
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
    if (external === undefined) return;
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: external.address, port: server.port });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
    expect(outcome).not.toBe('connected');
  });

  it('writes a per-process session token into the page, and nowhere else', async () => {
    const page = await request(server, { path: '/' });
    expect(page.status).toBe(200);
    expect(sessionToken(page.body)).toBe(server.token);
    expect(page.headers['cache-control']).toBe('no-store');

    const office = await request(server, { path: '/api/office' });
    expect(office.status).toBe(200);
    expect(office.body).not.toContain(server.token);

    const other = await startOfficeServer({ stateRoot: server.stateRoot, port: 0, webRoot, discover: async () => [] });
    try {
      expect(sessionToken((await rawRequest(other, { path: '/' })).body)).not.toBe(server.token);
    } finally {
      await other.close();
    }
  });
});

describe('Host: a rebinding hostname reaches the socket but not the server', () => {
  it('refuses every route, the token-carrying page included, unless Host is this machine on the bound port', async () => {
    const hosts = ['evil.example', `evil.example:${server.port}`, 'localhost', `localhost:${server.port + 1}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`];
    for (const host of hosts) {
      for (const route of ['/', '/src/app.js', '/api/office', '/api/runs', '/api/events']) {
        const response = await request(server, { path: route, headers: { host } });
        expect({ host, route, status: response.status }).toEqual({ host, route, status: 403 });
        expect(response.body).not.toContain(server.token);
        expect(response.body).not.toContain(host.startsWith('evil') ? 'evil.example' : 'never-echoed');
      }
    }
  });

  it('answers localhost on the bound port, because it is this machine under its other name', async () => {
    // A browser or an embedded preview pane can rewrite 127.0.0.1 to localhost.
    // Both are this machine; a rebinding page still arrives under its own
    // hostname, which the test above keeps refusing.
    for (const route of ['/', '/api/office', '/api/runs']) {
      const response = await request(server, { path: route, headers: { host: `localhost:${server.port}` } });
      expect({ route, status: response.status }).toEqual({ route, status: 200 });
    }
  });
});

describe('Origin and fetch site on reads', () => {
  it('refuses a read from another origin or another site, and allows the page itself', async () => {
    expect((await request(server, { path: '/api/runs', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    // localhost on the bound port is this machine, the same as 127.0.0.1; on any other port it is another origin.
    expect((await request(server, { path: '/api/runs', headers: { origin: `http://localhost:${server.port}` } })).status).toBe(200);
    expect((await request(server, { path: '/api/runs', headers: { origin: `http://localhost:${server.port + 1}` } })).status).toBe(403);
    expect((await request(server, { path: '/api/runs', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await request(server, { path: '/api/runs', headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);

    expect((await request(server, { path: '/api/runs', headers: { origin: originFor(server) } })).status).toBe(200);
    expect((await request(server, { path: '/api/runs', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await request(server, { path: '/api/runs' })).status).toBe(200);
  });

  it('refuses a cross-origin event stream before it streams anything', async () => {
    const stream = openEventStream(server, '/api/events', { origin: 'http://evil.example' });
    expect(await stream.status).toBe(403);
    stream.close();
  });
});

describe('a start request spends a model turn, so it needs all three proofs', () => {
  const valid = () => ({ repo: '/tmp', task: 'Fix it.' });

  it('refuses a missing Origin, a foreign Origin, a missing token, a wrong token and a non-JSON body — each on its own', async () => {
    const json = { 'content-type': 'application/json' };
    const cases: Array<{ headers: Record<string, string>; status: number; code: string }> = [
      { headers: { ...json, 'x-workforce-token': server.token }, status: 403, code: 'origin_required' },
      { headers: { ...json, 'x-workforce-token': server.token, origin: 'http://evil.example' }, status: 403, code: 'origin_rejected' },
      { headers: { ...json, origin: originFor(server) }, status: 403, code: 'token_required' },
      // localhost on the bound port is this machine: it passes the Host and Origin checks, and the token still stops it.
      { headers: { ...json, host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` }, status: 403, code: 'token_required' },
      { headers: { ...json, origin: originFor(server), 'x-workforce-token': 'f'.repeat(server.token.length) }, status: 403, code: 'token_rejected' },
      { headers: { ...json, origin: originFor(server), 'x-workforce-token': server.token.slice(1) }, status: 403, code: 'token_rejected' },
      { headers: { 'content-type': 'text/plain', origin: originFor(server), 'x-workforce-token': server.token }, status: 415, code: 'content_type_rejected' },
    ];
    for (const entry of cases) {
      const response = await request(server, { method: 'POST', path: '/api/runs', headers: entry.headers, body: JSON.stringify(valid()) });
      expect({ status: response.status, code: (JSON.parse(response.body) as { error: { code: string } }).error.code }).toEqual({ status: entry.status, code: entry.code });
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it('passes the gate with all three, and then validates the body before anything else', async () => {
    const response = await startRequest(server, server.token, { repo: '/tmp' });
    seen.push(response);
    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('invalid_body');
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('CORS', () => {
  it('does not answer a preflight, and no response anywhere carries Access-Control-Allow-Origin', async () => {
    const preflight = await request(server, {
      method: 'OPTIONS',
      path: '/api/runs',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-workforce-token, content-type' },
    });
    expect(preflight.status).toBe(405);
    await request(server, { path: '/does-not-exist' });
    await request(server, { path: '/api/nope' });
    expect(seen.length).toBeGreaterThan(20);
    for (const response of seen) {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });
});

describe('static files: the page and nothing but the page', () => {
  it("serves the page's own files with their types", async () => {
    const script = await request(server, { path: '/src/app.js' });
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    const image = await request(server, { path: '/assets/dot.png' });
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
  });

  it('refuses every path out of the tree — raw, encoded, backslashed, NUL-padded, or through a symlink', async () => {
    const attempts = [
      '/src/../../secret.txt',
      '/src/../../../secret.txt',
      '/src/%2e%2e/%2e%2e/secret.txt',
      '/src/..%2f..%2fsecret.js',
      '/src/%2E%2E%2F%2E%2E%2Fsecret.js',
      '/assets/..%2f..%2f..%2fsecret.txt',
      '/%2e%2e/secret.js',
      '/..%5c..%5csecret.txt',
      '/src/..\\..\\secret.js',
      '/src/app.js%00.png',
      '/src/link.js',
      '/PROVENANCE.md',
      '/src/',
      '/src//app.js',
      '//127.0.0.1/secret.txt',
      '/src/%zz.js',
      '/public/assets/dot.png',
    ];
    for (const attempt of attempts) {
      const response = await request(server, { path: attempt });
      expect({ attempt, refused: response.status === 400 || response.status === 404 }).toEqual({ attempt, refused: true });
      expect(response.body).not.toContain('SECRET-MARKER');
    }
  });
});

describe('the workspace UI', () => {
  it('serves the original Claude UI with live bridges and injects its token only in the response', async () => {
    const root = defaultWebRoot();
    expect(path.basename(root)).toBe('claude-office');
    const indexPath = path.join(root, 'index.html');
    const before = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
    const office = await startOfficeServer({ stateRoot: server.stateRoot, port: 0, discover: async () => [] });
    try {
      const page = await rawRequest(office, { path: '/' });
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.body).toContain('<title>Workforce · Local developer workspace</title>');
      expect(page.body).toContain('<script type="module" src="/src/main.js"></script>');
      expect(sessionToken(page.body)).toBe(office.token);
      expect(readFileSync(indexPath, 'utf8')).not.toContain('workforce-session-token');

      for (const file of ['/src/main.js', '/src/live-data.js', '/src/agent-store.js', '/src/sidebar.js', '/src/styles.css']) {
        const response = await rawRequest(office, { path: file });
        expect({ file, status: response.status }).toEqual({ file, status: 200 });
        expect(statSync(path.join(root, file)).size).toBe(Number(response.headers['content-length']));
      }
      expect((await rawRequest(office, { path: '/workspace/src/app.js' })).status).toBe(200);
      expect((await rawRequest(office, { path: '/workspace/../src/main.js' })).status).toBe(404);
      // The selected original artwork is now explicitly vendored into the
      // workspace. Its bytes are served unchanged; the old application is not.
      for (const name of ['office-clean.png']) {
        const artwork = await fetch(`http://127.0.0.1:${office.port}/assets/${name}`);
        expect(artwork.status).toBe(200);
        expect(artwork.headers.get('content-type')).toBe('image/png');
        const served = Buffer.from(await artwork.arrayBuffer());
        expect(served.equals(readFileSync(path.join(root, 'public', 'assets', name)))).toBe(true);
      }
    } finally {
      await office.close();
    }
    expect(createHash('sha256').update(readFileSync(indexPath)).digest('hex')).toBe(before);
  });
});
