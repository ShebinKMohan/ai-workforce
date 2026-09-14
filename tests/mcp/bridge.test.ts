import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OfficeClient, validateServerUrl } from '../../src/mcp/client.js';
import { MAX_MCP_LINE_BYTES, runMcpServer } from '../../src/mcp/server.js';
import { callWorkforceTool } from '../../src/mcp/tools.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

const TOKEN = 'ab'.repeat(32);
const identity = { ok: true, officeVersion: 1, coordinator: { name: 'workforce' } };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

async function exchange(frames: unknown[], serverUrl?: string): Promise<Record<string, any>[]> {
  let output = '';
  await runMcpServer({
    input: Readable.from(frames.map((frame) => `${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)),
    output: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }),
    ...(serverUrl !== undefined ? { serverUrl } : {}),
  });
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
}

async function fixture(handler?: (route: string) => { status?: number; headers?: Record<string, string>; body: unknown } | undefined) {
  const requests: { route: string; method: string; body: unknown; token: string | undefined; origin: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body: unknown = text ? JSON.parse(text) : null;
    requests.push({ route: req.url!, method: req.method!, body, token: req.headers['x-workforce-token'] as string | undefined, origin: req.headers['origin'] });
    const custom = handler?.(req.url!);
    if (custom !== undefined) {
      res.writeHead(custom.status ?? 200, { 'content-type': 'application/json', ...custom.headers });
      res.end(typeof custom.body === 'string' ? custom.body : JSON.stringify(custom.body));
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><meta name="workforce-session-token" content="${TOKEN}" /></head></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/office') res.end(JSON.stringify(identity));
    else if (req.url === '/api/workspace') res.end(JSON.stringify({ ok: true, revision: 7, workspace: { projects: [{ id: 'project-one', name: 'One', repoPath: '/fixture/one' }] }, readiness: { status: 'ready' } }));
    else if (req.method === 'POST') res.end(JSON.stringify({ ok: true, issue: { id: 'issue-1', revision: 1, ...(body as Record<string, unknown>) } }));
    else res.end(JSON.stringify({ ok: true, issues: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return { serverUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe('external MCP protocol', () => {
  it('negotiates tools offline and emits only framed JSON; notifications cause no HTTP effects', async () => {
    const { serverUrl, requests } = await fixture();
    const results = await exchange([
      initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...call(3, 'workforce_submit_plan', { start: true }), id: undefined },
      { jsonrpc: '2.0', id: 4, method: 'ping' },
    ], serverUrl);
    expect(requests).toHaveLength(0);
    expect(results.map((result) => result.id)).toEqual([1, 2, 4]);
    expect(results[0]!.result.protocolVersion).toBe('2025-11-25');
    const tools = results[1]!.result.tools as Record<string, any>[];
    expect(tools.map((tool) => tool.name)).toContain('workforce_submit_plan');
    expect(tools).toHaveLength(7);
    expect(tools.filter((tool) => !tool.annotations.readOnlyHint).every((tool) => tool.inputSchema.required.includes('idempotencyKey'))).toBe(true);
  });

  it('enforces initialization and validates requests before contacting the server', async () => {
    const { serverUrl, requests } = await fixture();
    const results = await exchange([
      call(0, 'workforce_list_projects', {}), initialize, initialized,
      '{bad', [{ jsonrpc: '2.0', id: 2, method: 'ping' }],
      call(3, 'workforce_submit_plan', { projectId: 'one', title: 'PRD', description: 'Exact text', start: true }),
      call(4, 'workforce_get_issue', { issueId: '../secrets' }),
      call(5, 'unknown', {}), call(6, 'workforce_update_issue', { issueId: 'one', expectRevision: 0, idempotencyKey: 'a' }),
    ], serverUrl);
    expect(results.map((result) => result.error?.code ?? 0)).toEqual([-32002, 0, -32700, -32600, -32602, -32602, -32602, -32602]);
    expect(requests).toHaveLength(0);
  });

  it('bounds unterminated frames and recovers at the next newline', async () => {
    const results = await exchange(['x'.repeat(MAX_MCP_LINE_BYTES + 1), initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(results.map((result) => result.id)).toEqual([null, 1, 2]);
    expect(results[0]!.error.code).toBe(-32600);
  });

  it('negotiates an older supported version and falls back honestly for unknown versions', async () => {
    for (const [requested, expected] of [['2024-11-05', '2024-11-05'], ['9999-01-01', '2025-11-25']]) {
      const results = await exchange([{ ...initialize, params: { ...initialize.params, protocolVersion: requested } }]);
      expect(results[0]!.result.protocolVersion).toBe(expected);
    }
  });

  it('the actual CLI subprocess discovers tools without startup side effects or trailing CLI output', async () => {
    const { serverUrl, requests } = await fixture();
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/cli/index.ts'), 'mcp', '--server-url', serverUrl], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.end([initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map((frame) => JSON.stringify(frame)).join('\n') + '\n');
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const frames = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.jsonrpc === '2.0')).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe('external MCP local API boundary', () => {
  it('keeps complete PRD text and idempotency keys literal, saving without starting by default', async () => {
    const { serverUrl, requests } = await fixture();
    const description = '# PRD\n\nPreserve literal `$(echo no)` and Unicode: café, 日本語.\n' + 'Acceptance detail.\n'.repeat(3000);
    const args = { projectId: 'project-one', title: 'Long PRD', description, kind: 'prd', idempotencyKey: 'prd:v1' };
    const results = await exchange([initialize, initialized, call(2, 'workforce_submit_plan', args), call(3, 'workforce_submit_plan', args)], serverUrl);
    const mutations = requests.filter((request) => request.method === 'POST');
    expect(mutations).toHaveLength(2);
    expect(mutations.every((request) => request.route === '/api/issues' && request.token === TOKEN && request.origin === serverUrl)).toBe(true);
    expect(mutations[0]!.body).toEqual({ ...args, source: 'mcp', start: false });
    expect(mutations[1]!.body).toEqual(mutations[0]!.body);
    expect(results[1]!.result.structuredContent.issue.description).toBe(description);
    expect(requests.map((request) => request.route)).toEqual(['/api/office', '/', '/api/issues', '/api/office', '/', '/api/issues']);
  });

  it('forwards start and update to the existing issue routes with revision and replay keys', async () => {
    const { serverUrl, requests } = await fixture();
    const client = new OfficeClient({ serverUrl });
    await callWorkforceTool(client, 'workforce_list_projects', {});
    await callWorkforceTool(client, 'workforce_list_issues', { projectId: 'project-one', cursor: 'next-page', limit: 10 });
    await callWorkforceTool(client, 'workforce_start_issue', { issueId: 'issue-one', expectRevision: 1, idempotencyKey: 'start:one' });
    await callWorkforceTool(client, 'workforce_update_issue', { issueId: 'issue-one', expectRevision: 1, idempotencyKey: 'move:one', status: 'todo' });
    expect(requests.some((request) => request.route === '/api/issues?summary=1&limit=10&projectId=project-one&after=next-page')).toBe(true);
    expect(requests.filter((request) => request.method === 'POST').map(({ route, body }) => ({ route, body }))).toEqual([
      { route: '/api/issues/issue-one/start', body: { expectRevision: 1, idempotencyKey: 'start:one' } },
      { route: '/api/issues/issue-one/update', body: { expectRevision: 1, idempotencyKey: 'move:one', status: 'todo' } },
    ]);
  });

  it('refuses network hosts, redirects and another local app before posting or reading a token', async () => {
    for (const url of ['https://127.0.0.1:4421', 'http://localhost:4421', 'http://example.com', 'http://127.0.0.1:4421/api', 'http://x:y@127.0.0.1:4421', 'http://127.0.0.1:4421/?x=1', 'http://127.0.0.1:4421/#token']) {
      expect(() => validateServerUrl(url)).toThrow(/server URL/);
    }
    const wrong = await fixture((route) => route === '/api/office' ? { body: { ...identity, coordinator: { name: 'another-app' } } } : undefined);
    await expect(new OfficeClient({ serverUrl: wrong.serverUrl }).write('/api/issues', {})).rejects.toMatchObject({ code: 'server_identity_mismatch' });
    expect(wrong.requests.map((request) => request.route)).toEqual(['/api/office']);
    const redirect = await fixture(() => ({ status: 302, headers: { location: wrong.serverUrl }, body: '' }));
    await expect(new OfficeClient({ serverUrl: redirect.serverUrl }).read('/api/issues')).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(wrong.requests).toHaveLength(1);
  });

  it('surfaces server refusal as a tool error and preserves conflict details', async () => {
    const { serverUrl } = await fixture((route) => route === '/api/issues' ? { status: 409, body: { ok: false, error: { code: 'idempotency_conflict', message: 'This key belongs to different content.', details: ['Use the original content or a new key.'] } } } : undefined);
    const results = await exchange([initialize, initialized, call(2, 'workforce_create_issue', { projectId: 'one', title: 'one', description: 'two', idempotencyKey: 'same' })], serverUrl);
    expect(results[1]!.result.isError).toBe(true);
    expect(JSON.parse(results[1]!.result.content[0].text).error).toEqual({ code: 'idempotency_conflict', message: 'This key belongs to different content.', details: ['Use the original content or a new key.'] });
  });

  it('reports a refused explicit start as a tool error while retaining the saved issue receipt', async () => {
    const payload = { ok: true, issue: { id: 'issue-1', revision: 1, description: 'Preserved PRD' }, startError: { code: 'no_eligible_department', message: 'Assign a department before starting.' } };
    const { serverUrl } = await fixture((route) => route === '/api/issues' ? { body: payload } : undefined);
    const results = await exchange([initialize, initialized, call(2, 'workforce_submit_plan', { projectId: 'one', title: 'PRD', description: 'Preserved PRD', idempotencyKey: 'prd-one', start: true })], serverUrl);
    expect(results[1]!.result.isError).toBe(true);
    expect(results[1]!.result.structuredContent).toEqual(payload);
  });

  it('explains offline failures without trying to launch another server', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing address');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const results = await exchange([initialize, initialized, call(2, 'workforce_list_projects', {})], `http://127.0.0.1:${address.port}`);
    const error = JSON.parse(results[1]!.result.content[0].text).error;
    expect(error.code).toBe('connection_unavailable');
    expect(error.message).toContain('Start the workspace server');
  });

  it('refuses oversized UTF-8 request bytes before any HTTP operation', async () => {
    const { serverUrl, requests } = await fixture();
    await expect(new OfficeClient({ serverUrl }).write('/api/issues', { projectId: 'one', title: 'PRD', description: '日'.repeat(100_000), idempotencyKey: 'big' })).rejects.toMatchObject({ code: 'body_too_large' });
    expect(requests).toHaveLength(0);
  });
});
