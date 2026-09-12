/**
 * The HTTP boundary of the local office view (FR084).
 *
 * The server is a view over coordinator state on a developer's own machine,
 * and one of its routes spends a paid model turn. Everything that keeps a
 * *foreign* web page from using it lives here:
 *
 * - **Loopback bind.** `127.0.0.1` only, never `0.0.0.0` or `::`.
 * - **Host.** Every request, static files included, must name exactly the
 *   bound `127.0.0.1:<port>`. A DNS-rebinding page reaches this socket under
 *   its own hostname, so its Host header gives it away — and without this
 *   check it could read `index.html`, token and all.
 * - **Origin.** An API read may carry no Origin (a same-origin GET or
 *   EventSource sends none) or this server's own; a start request must carry
 *   this server's own. `Sec-Fetch-Site`, when a browser sends it, must say
 *   `same-origin` or `none`.
 * - **Session token.** A random per-process value is written into the served
 *   HTML and required, in a custom header, on the start route. A foreign page
 *   cannot read the HTML (no CORS header is ever sent, and the Host check
 *   stops a rebinding read), and the custom header plus a JSON content type
 *   forces a preflight this server never approves.
 * - **No `Access-Control-Allow-Origin`** on any response, ever.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactedJson } from '../telemetry/redaction.js';

export const LOOPBACK_HOST = '127.0.0.1';
/** The header a start request carries the session token in. */
export const TOKEN_HEADER = 'x-workforce-token';
/** The `<meta name>` the session token is written under in served HTML. */
export const TOKEN_META_NAME = 'workforce-session-token';
/** Largest request body the server reads. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

export function originOf(endpoint: Endpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

/**
 * The two names a browser on this machine uses for the loopback address.
 *
 * `localhost` is accepted beside `127.0.0.1` because both are this machine,
 * and a browser or an embedded preview pane may rewrite one to the other —
 * refusing it made `http://localhost:<port>/` show a JSON error instead of the
 * office. It does not weaken the DNS-rebinding defence: a rebinding page
 * reaches this socket under the attacker's own hostname, so its Host and Origin
 * still name that hostname and are still refused, and a start request still
 * needs the session token.
 */
export function acceptedHosts(endpoint: Endpoint): ReadonlyArray<string> {
  return [`${endpoint.host}:${endpoint.port}`, `localhost:${endpoint.port}`];
}

export function acceptedOrigins(endpoint: Endpoint): ReadonlyArray<string> {
  return acceptedHosts(endpoint).map((host) => `http://${host}`);
}

/** A refusal with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ReadonlyArray<string>;
  /** Extra top-level fields for the error body, e.g. the fresh `revision` on a workspace conflict. */
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, message: string, details: ReadonlyArray<string> = [], extra: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
  }
}

export type GateDecision = { readonly ok: true } | { readonly ok: false; readonly error: ApiError };

const ALLOW: GateDecision = { ok: true };

function refuse(status: number, code: string, message: string): GateDecision {
  return { ok: false, error: new ApiError(status, code, message) };
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Every request: the Host header must name the bound loopback address exactly. The received value is never echoed. */
export function checkHost(req: IncomingMessage, endpoint: Endpoint): GateDecision {
  const host = singleHeader(req, 'host');
  if (host === undefined || !acceptedHosts(endpoint).includes(host)) {
    return refuse(403, 'host_rejected', `this server answers only to Host ${endpoint.host}:${endpoint.port} or localhost:${endpoint.port}; open ${originOf(endpoint)}/`);
  }
  return ALLOW;
}

/** API reads: a foreign Origin or a cross-site fetch is refused; an absent Origin is a same-origin GET. */
export function checkApiRead(req: IncomingMessage, endpoint: Endpoint): GateDecision {
  const origin = singleHeader(req, 'origin');
  if (origin !== undefined && !acceptedOrigins(endpoint).includes(origin)) {
    return refuse(403, 'origin_rejected', 'requests from another origin are refused');
  }
  const site = singleHeader(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return refuse(403, 'cross_site_rejected', 'cross-site requests are refused');
  }
  return ALLOW;
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The start route: everything a read needs, plus this server's own Origin (an
 * absent one is refused here), the session token and a JSON body.
 */
export function checkApiWrite(req: IncomingMessage, endpoint: Endpoint, token: string): GateDecision {
  const read = checkApiRead(req, endpoint);
  if (!read.ok) return read;
  const origin = singleHeader(req, 'origin');
  if (origin === undefined || !acceptedOrigins(endpoint).includes(origin)) {
    return refuse(403, 'origin_required', 'a write request must come from the office page itself');
  }
  const presented = singleHeader(req, TOKEN_HEADER);
  if (presented === undefined || presented.length === 0) {
    return refuse(403, 'token_required', `a write request needs the session token from the served page in ${TOKEN_HEADER}`);
  }
  if (!tokensMatch(presented, token)) return refuse(403, 'token_rejected', 'the session token does not match this server process; reload the page');
  if (!/^application\/json\s*(;|$)/i.test(singleHeader(req, 'content-type') ?? '')) {
    return refuse(415, 'content_type_rejected', 'a write request body must be application/json');
  }
  return ALLOW;
}

/** The page may load its own scripts, styles and images, and talk only to this server. */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** An API response is data and is never rendered as a document. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

export function securityHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

export function sendBody(res: ServerResponse, status: number, contentType: string, body: string | Buffer, extra: Record<string, string> = {}, head = false): void {
  res.writeHead(status, {
    ...securityHeaders(contentType.startsWith('text/html') ? PAGE_CSP : API_CSP),
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(head ? undefined : body);
}

/** JSON through the same redaction every CLI `--json` document gets. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendBody(res, status, 'application/json; charset=utf-8', `${redactedJson(body)}\n`, extra);
}

export function sendError(res: ServerResponse, error: ApiError, extra: Record<string, string> = {}): void {
  sendJson(res, error.status, { ok: false, ...error.extra, error: { code: error.code, message: error.message, details: error.details } }, extra);
}

/** Read a request body up to `limit` bytes; a larger one is refused rather than buffered. */
export function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(singleHeader(req, 'content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      reject(new ApiError(413, 'body_too_large', `request bodies are limited to ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new ApiError(413, 'body_too_large', `request bodies are limited to ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}
