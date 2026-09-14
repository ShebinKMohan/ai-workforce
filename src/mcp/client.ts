/** Local HTTP client for the external MCP bridge. The page server remains the
 * sole admission authority; this module never starts a server or a runtime. */
import { z } from 'zod';

export const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:4421';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const IdentitySchema = z.looseObject({
  ok: z.literal(true),
  officeVersion: z.literal(1),
  coordinator: z.looseObject({ name: z.literal('workforce') }),
});

export class McpConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/** Literal IPv4 loopback only: no DNS lookup, credentials, paths or redirects. */
export function validateServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new McpConnectionError('invalid_server_url', 'The server URL must be http://127.0.0.1:<port>.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new McpConnectionError('invalid_server_url', 'The server URL must be http://127.0.0.1:<port> with no credentials, path, query or fragment.');
  }
  return url.origin;
}

export interface OfficeClientOptions {
  readonly serverUrl?: string;
  readonly timeoutMs?: number;
}

export class OfficeClient {
  readonly serverUrl: string;
  readonly #timeoutMs: number;

  constructor(options: OfficeClientOptions = {}) {
    this.serverUrl = validateServerUrl(options.serverUrl ?? DEFAULT_MCP_SERVER_URL);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async #fetchText(route: string, init: RequestInit = {}): Promise<{ response: Response; text: string }> {
    try {
      const response = await fetch(`${this.serverUrl}${route}`, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { Origin: this.serverUrl, ...init.headers },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new McpConnectionError('redirect_refused', 'The local server returned a redirect; the MCP connection will not follow it.');
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new McpConnectionError('response_too_large', 'The local server response exceeded 2 MiB.');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new McpConnectionError('response_too_large', 'The local server response exceeded 2 MiB.');
          chunks.push(chunk);
        }
      }
      return { response, text: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      if (error instanceof McpConnectionError) throw error;
      throw new McpConnectionError('connection_unavailable', `Cannot reach AI Workforce at ${this.serverUrl}. Start the workspace server, then retry with the same idempotencyKey if this was a mutation. A timed-out write may already have been recorded.`);
    }
  }

  async #json(route: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const { response, text } = await this.#fetchText(route, init);
    let data: unknown;
    try { data = JSON.parse(text); } catch {
      throw new McpConnectionError('invalid_server_response', 'The local endpoint did not return a JSON API document. Check the server URL and running application.');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new McpConnectionError('invalid_server_response', 'The local endpoint returned an invalid API document.');
    }
    const document = data as Record<string, unknown>;
    if (!response.ok || document['ok'] === false) {
      const error = z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() }).safeParse(document['error']);
      throw new McpConnectionError(error.success ? error.data.code : 'server_refused', error.success ? error.data.message : `The local server refused this request (HTTP ${response.status}).`, error.success ? error.data.details : undefined);
    }
    return document;
  }

  async #verifyIdentity(): Promise<void> {
    const identity = await this.#json('/api/office');
    if (!IdentitySchema.safeParse(identity).success) {
      throw new McpConnectionError('server_identity_mismatch', 'The configured endpoint is not an AI Workforce office server.');
    }
  }

  async read(route: string): Promise<Record<string, unknown>> {
    await this.#verifyIdentity();
    return this.#json(route);
  }

  async write(route: string, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
      throw new McpConnectionError('body_too_large', 'The issue request exceeds the server limit of 256 KiB. Shorten it; no content has been truncated or submitted.');
    }
    await this.#verifyIdentity();
    // This is our app's public per-process browser-session token, not a
    // provider credential. Refresh on each mutation to survive server restarts.
    const { response, text } = await this.#fetchText('/');
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) {
      throw new McpConnectionError('session_token_unavailable', 'The AI Workforce page could not provide its local session token.');
    }
    const token = /<meta\s+name="workforce-session-token"\s+content="([0-9a-f]{32,128})"\s*\/?>/i.exec(text)?.[1];
    if (token === undefined) throw new McpConnectionError('session_token_unavailable', 'The AI Workforce page is missing its local session token.');
    return this.#json(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workforce-token': token },
      body: encoded,
    });
  }
}
