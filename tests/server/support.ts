/**
 * Raw HTTP and SSE helpers for the office server tests.
 *
 * `fetch` normalizes paths and refuses to set `Host`, which are exactly the
 * two things these tests need to control, so requests go through `node:http`
 * with the request target and every header written verbatim.
 */
import http from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface Target {
  readonly port: number;
}

export function originFor(target: Target): string {
  return `http://127.0.0.1:${target.port}`;
}

export function rawRequest(
  target: Target,
  input: { readonly method?: string; readonly path: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${target.port}`, ...(input.headers ?? {}) };
    if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));
    const request = http.request({ host: '127.0.0.1', port: target.port, method: input.method ?? 'GET', path: input.path, headers, setHost: false, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end(input.body);
  });
}

export function sessionToken(html: string): string {
  const match = /<meta name="workforce-session-token" content="([0-9a-f]+)" \/>/.exec(html);
  if (match === null) throw new Error('the served page carries no session token');
  return match[1]!;
}

export async function tokenFrom(target: Target): Promise<string> {
  return sessionToken((await rawRequest(target, { path: '/' })).body);
}

export function startRequest(target: Target, token: string, body: unknown): Promise<RawResponse> {
  return rawRequest(target, {
    method: 'POST',
    path: '/api/runs',
    headers: { origin: originFor(target), 'x-workforce-token': token, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export interface SseEvent {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export interface SseConnection {
  readonly events: SseEvent[];
  readonly status: Promise<number>;
  waitFor(count: number, timeoutMs?: number): Promise<SseEvent[]>;
  close(): void;
}

export function openEventStream(target: Target, path = '/api/events', headers: Record<string, string> = {}): SseConnection {
  const events: SseEvent[] = [];
  let buffer = '';
  let resolveStatus!: (status: number) => void;
  const status = new Promise<number>((resolve) => (resolveStatus = resolve));
  const request = http.get({ host: '127.0.0.1', port: target.port, path, headers: { host: `127.0.0.1:${target.port}`, ...headers }, setHost: false, agent: false }, (response) => {
    resolveStatus(response.statusCode ?? 0);
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id: string | null = null;
        let data: string | null = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (id !== null && data !== null) events.push({ id, data: JSON.parse(data) as Record<string, unknown> });
        boundary = buffer.indexOf('\n\n');
      }
    });
  });
  request.on('error', () => {});
  return {
    events,
    status,
    async waitFor(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (events.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} events, received ${events.length}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return events.slice(0, count);
    },
    close: () => request.destroy(),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
