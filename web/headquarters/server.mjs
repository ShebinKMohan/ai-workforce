import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeBridge, BridgeError, PAGE_CSP, securityHeaders, sendError } from './server/runtime-bridge.mjs';

const defaultRoot = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

export function createHeadquartersServer({ root = defaultRoot, backendUrl = process.env.WORKFORCE_BACKEND_URL ?? 'http://127.0.0.1:4421', timeoutMs } = {}) {
  const bridge = createRuntimeBridge({ backendUrl, timeoutMs });
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      bridge.checkRequest(req, port);
      const raw = (req.url ?? '/').split('?', 1)[0];
      if (raw === '/api' || raw.startsWith('/api/')) { await bridge.handle(req, res, port); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new BridgeError(405, 'method_not_allowed', 'Static files accept GET and HEAD.');
      let pathname;
      try { pathname = decodeURIComponent(raw); } catch { throw new BridgeError(400, 'invalid_path', 'The file path is invalid.'); }
      if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\') || /[\x00-\x1f\x7f]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) throw new BridgeError(404, 'not_found', 'Not found.');
      const relative = pathname === '/' ? 'index.html' : pathname.startsWith('/assets/') ? `public${pathname}` : pathname.slice(1);
      const path = resolve(root, relative);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !['index.html', 'src', 'public'].includes(relative.split('/')[0]) || !mime[extname(path)]) throw new BridgeError(404, 'not_found', 'Not found.');
      let canonical;
      try {
        const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
        if (!realFile.startsWith(realRoot + sep) || !(await stat(realFile)).isFile()) throw new Error('Outside static root.');
        canonical = realFile;
      } catch { throw new BridgeError(404, 'not_found', 'Not found.'); }
      const file = await readFile(canonical);
      const isHtml = extname(path) === '.html';
      const body = isHtml ? bridge.injectSessionToken(file.toString('utf8')) : file;
      res.writeHead(200, { ...securityHeaders(isHtml ? PAGE_CSP : undefined), 'Content-Type': mime[extname(path)], 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) { if (!res.destroyed) sendError(res, error); }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4328);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local TCP port.');
  createHeadquartersServer().listen(port, '127.0.0.1', () => process.stdout.write(`Workforce Headquarters: http://127.0.0.1:${port}/src/headquarters/index.html\n`));
}
