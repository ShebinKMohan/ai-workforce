/**
 * Static files for the workspace UI in `web/workspace` (FR084).
 *
 * `web/office` (the raster office prototype) stays in the repository but is no
 * longer served: it cannot draw an empty workspace, repeated departments or a
 * team larger than its drawn seats without inventing people.
 *
 * The mapping: `/` and `/index.html` → `index.html`, `/assets/*` →
 * `public/assets/*`, `/src/*` → `src/*`. Nothing else under the web root is
 * reachable.
 *
 * A path is refused, not normalized, when it could name anything outside
 * those roots: an undecodable escape, a NUL or backslash, a `.` or `..`
 * segment (encoded or not), an empty segment, an extension outside a short
 * allowlist, or a file whose realpath leaves the web root — a symlink
 * pointing out of the tree is refused like `..` is.
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithin } from '../storage/paths.js';
import { TOKEN_META_NAME } from './http.js';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** The package root: two levels above this module in both `src/server` and `dist/server`. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultWebRoot(): string {
  return path.join(packageRoot(), 'web', 'workspace');
}

export type StaticResolution =
  | { readonly ok: true; readonly file: string; readonly contentType: string }
  | { readonly ok: false; readonly status: 400 | 404 };

const NOT_FOUND: StaticResolution = { ok: false, status: 404 };
const BAD_REQUEST: StaticResolution = { ok: false, status: 400 };

/** Resolve a raw request target to a file under `webRoot`, or refuse it. */
export function resolveStaticFile(webRoot: string, rawTarget: string): StaticResolution {
  const rawPath = rawTarget.split('?', 1)[0]!.split('#', 1)[0]!;
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return BAD_REQUEST;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return BAD_REQUEST;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return BAD_REQUEST;

  const segments = decoded.split('/').slice(1);
  if (segments.some((segment) => segment === '.' || segment === '..')) return NOT_FOUND;

  let relative: string[];
  if (decoded === '/' || decoded === '/index.html') relative = ['index.html'];
  else if (segments[0] === 'assets' && segments.length > 1) relative = ['public', ...segments];
  else if (segments[0] === 'src' && segments.length > 1) relative = segments;
  else return NOT_FOUND;
  if (relative.some((segment) => segment.length === 0)) return NOT_FOUND;

  const contentType = MIME[path.extname(relative[relative.length - 1]!).toLowerCase()];
  if (contentType === undefined) return NOT_FOUND;

  const root = path.resolve(webRoot);
  const candidate = path.resolve(root, ...relative);
  if (!isWithin(root, candidate) || candidate === root) return NOT_FOUND;
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(candidate);
  } catch {
    return NOT_FOUND;
  }
  if (!isWithin(realRoot, real) || real === realRoot) return NOT_FOUND;
  try {
    if (!statSync(real).isFile()) return NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
  return { ok: true, file: real, contentType };
}

/**
 * Add the session token to served HTML, just before `</head>`.
 *
 * The token is hex, so it needs no escaping; anything else is refused rather
 * than written into markup.
 */
export function injectSessionToken(html: string, token: string): string {
  if (!/^[0-9a-f]{32,128}$/.test(token)) throw new Error('session token must be lower-case hex');
  const meta = `<meta name="${TOKEN_META_NAME}" content="${token}" />`;
  const index = html.search(/<\/head>/i);
  return index === -1 ? `${meta}\n${html}` : `${html.slice(0, index)}  ${meta}\n${html.slice(index)}`;
}
