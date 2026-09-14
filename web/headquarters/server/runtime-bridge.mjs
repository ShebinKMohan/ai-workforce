import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const securityHeaders = (csp = API_CSP) => ({
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
});

export class BridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function sendError(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const safe = error instanceof BridgeError ? error : new BridgeError(502, 'runtime_unavailable', 'The local AI Workforce runtime could not be reached. Check that its server is running, then reconnect.');
  res.writeHead(safe.status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message, details: [] } }));
}

function upstreamUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || !url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WORKFORCE_BACKEND_URL must be an HTTP loopback origin with an explicit port.');
  }
  // Resolve locally without consulting DNS, even for the accepted localhost spelling.
  url.hostname = '127.0.0.1';
  return url;
}

function collect(stream, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    stream.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new BridgeError(413, 'body_too_large', 'This request exceeds the local upload limit.'));
        stream.resume();
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('Request interrupted.')));
  });
}

export function createRuntimeBridge({ backendUrl = 'http://127.0.0.1:4421', timeoutMs = 30_000 } = {}) {
  const backend = upstreamUrl(backendUrl);
  const browserToken = randomBytes(32).toString('hex');
  let bootstrapPromise = null;
  let cachedSession = null;

  function openUpstream(path, { method = 'GET', body, headers = {}, signal } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: backend.hostname, port: Number(backend.port), path, method, signal,
        headers: { Host: backend.host, ...headers, ...(body ? { 'Content-Length': body.length } : {}) },
      });
      outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('Local runtime timed out.')));
      outgoing.once('response', response => { outgoing.setTimeout(0); resolve(response); });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  }

  async function bootstrap(refresh = false) {
    if (!refresh && cachedSession && Date.now() - cachedSession.checkedAt < 30_000) return cachedSession;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const identityResponse = await openUpstream('/api/office');
      const identityBytes = await collect(identityResponse, 1024 * 1024);
      if (identityResponse.statusCode !== 200) throw new Error('Coordinator identity unavailable.');
      const identity = JSON.parse(identityBytes.toString('utf8'));
      const server = identity?.coordinator?.server;
      if (identity.ok !== true || identity.coordinator?.name !== 'workforce' || !Number.isSafeInteger(server?.pid) || server.pid < 1 || typeof server.startedAt !== 'string' || new URL(server.url).origin !== backend.origin) {
        throw new BridgeError(502, 'runtime_identity_mismatch', 'The configured local server is not the expected AI Workforce coordinator.');
      }
      const pageResponse = await openUpstream('/');
      const page = await collect(pageResponse, 4 * 1024 * 1024);
      if (pageResponse.statusCode !== 200) throw new Error('Coordinator session unavailable.');
      const token = page.toString('utf8').match(/<meta\s+name=["']workforce-session-token["']\s+content=["']([a-f0-9]{32,128})["']\s*\/?\s*>/i)?.[1];
      if (!token) throw new BridgeError(502, 'runtime_session_unavailable', 'The AI Workforce server did not provide its page session. Reload after updating or restarting the local runtime.');
      cachedSession = { token, checkedAt: Date.now(), server: { pid: server.pid, startedAt: server.startedAt, url: server.url }, version: identity.coordinator.version };
      return cachedSession;
    })();
    try { return await bootstrapPromise; }
    finally { bootstrapPromise = null; }
  }

  function checkRequest(req, port, { write = false } = {}) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map(host => `http://${host}`);
    if (!hosts.includes(req.headers.host)) throw new BridgeError(403, 'host_rejected', 'Open Headquarters using its local loopback address.');
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.includes(origin)) throw new BridgeError(403, 'origin_rejected', 'Requests from another origin are refused.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new BridgeError(403, 'cross_site_rejected', 'Cross-site requests are refused.');
    if (!write) return;
    if (!origins.includes(origin)) throw new BridgeError(403, 'origin_required', 'A write request must come from Headquarters itself.');
    const presented = req.headers['x-workforce-token'];
    if (typeof presented !== 'string' || !presented) throw new BridgeError(403, 'token_required', 'A write request needs the session token from the served Headquarters page.');
    const actual = Buffer.from(presented);
    const expected = Buffer.from(browserToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BridgeError(403, 'token_rejected', 'This Headquarters session has changed. Reload the page and try again.');
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError(415, 'content_type_rejected', 'A write request body must be application/json.');
  }

  async function handle(req, res, port) {
    const method = req.method ?? 'GET';
    checkRequest(req, port, { write: method === 'POST' });
    if (method !== 'GET' && method !== 'POST') throw new BridgeError(405, 'method_not_allowed', 'The local API accepts GET and POST.');
    const rawPath = (req.url ?? '').split('?', 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { throw new BridgeError(400, 'invalid_path', 'The API path is invalid.'); }
    if (!decoded.startsWith('/api/') || decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) {
      throw new BridgeError(400, 'invalid_path', 'The API path is invalid.');
    }
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    let body;
    if (method === 'POST') {
      const maxBytes = decoded === '/api/attachments' ? 36 * 1024 * 1024 : 256 * 1024;
      if (Number(req.headers['content-length']) > maxBytes) { req.resume(); throw new BridgeError(413, 'body_too_large', 'This request exceeds the local upload limit.'); }
      body = await collect(req, maxBytes);
    }
    const session = await bootstrap();
    if (res.destroyed) return;
    if (decoded === '/api/bridge/status') {
      if (method !== 'GET') throw new BridgeError(405, 'method_not_allowed', 'Bridge status accepts GET.');
      res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, connected: true, backend: backend.origin, coordinator: { name: 'workforce', version: session.version, server: session.server } }));
      return;
    }
    const headersFor = token => ({
      Origin: backend.origin,
      'Sec-Fetch-Site': 'same-origin',
      Accept: decoded === '/api/events' ? 'text/event-stream' : 'application/json',
      ...(typeof req.headers['last-event-id'] === 'string' ? { 'Last-Event-ID': req.headers['last-event-id'] } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json', 'x-workforce-token': token } : {}),
    });
    let response = await openUpstream(req.url, { method, body, headers: headersFor(session.token), signal: abort.signal });
    let buffered;
    // A gate rejection is the only safe automatic POST retry: no operation ran.
    // Network failures and uncertain deliveries must retain the clientRequestId.
    if (method === 'POST' && response.statusCode === 403) {
      buffered = await collect(response, 1024 * 1024);
      let code;
      try { code = JSON.parse(buffered.toString('utf8')).error?.code; } catch { /* Forward non-JSON errors unchanged below. */ }
      if (code === 'token_rejected') {
        const renewed = await bootstrap(true);
        response = await openUpstream(req.url, { method, body, headers: headersFor(renewed.token), signal: abort.signal });
        buffered = undefined;
      }
    }
    const type = response.headers['content-type'] ?? '';
    if (!/^(application\/json|text\/event-stream)(\s*;|$)/i.test(type)) {
      response.resume();
      throw new BridgeError(502, 'invalid_runtime_response', 'The AI Workforce API returned an unexpected response.');
    }
    const responseHeaders = { ...securityHeaders(), 'Content-Type': type };
    for (const header of ['allow', 'retry-after']) if (response.headers[header]) responseHeaders[header] = response.headers[header];
    if (type.startsWith('text/event-stream')) responseHeaders['X-Accel-Buffering'] = 'no';
    res.writeHead(response.statusCode ?? 502, responseHeaders);
    if (buffered) { res.end(buffered); return; }
    response.once('error', () => res.destroy());
    res.once('close', () => response.destroy());
    response.pipe(res);
  }

  return {
    handle,
    checkRequest,
    injectSessionToken(html) {
      const meta = `<meta name="workforce-session-token" content="${browserToken}">`;
      return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${meta}\n</head>`) : `${meta}\n${html}`;
    },
  };
}
