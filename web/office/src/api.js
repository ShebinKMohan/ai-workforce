/**
 * The page's only way to the workforce server. Same origin only: every URL is
 * a relative `/api/...` path, and the session token is read from the meta tag
 * the server wrote into this page. The token is sent only on the POST routes
 * that need it, in the `x-workforce-token` header, and is never stored.
 */
const TOKEN_META = 'meta[name="workforce-session-token"]';

export class ApiFailure extends Error {
  constructor(status, error) {
    super(error?.message || `request failed with HTTP ${status}`);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = error?.code || `http_${status}`;
    this.details = Array.isArray(error?.details) ? error.details.map(String) : [];
  }
}

function sessionToken() {
  return document.querySelector(TOKEN_META)?.getAttribute('content') || '';
}

async function parse(response) {
  let document;
  try {
    document = await response.json();
  } catch {
    throw new ApiFailure(response.status, { code: 'invalid_response', message: `the server answered HTTP ${response.status} without JSON` });
  }
  if (!response.ok || document?.ok === false) throw new ApiFailure(response.status, document?.error);
  return document;
}

export async function getJson(path, { signal } = {}) {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal });
  return parse(response);
}

async function postJson(path, body) {
  const token = sessionToken();
  if (!token) throw new ApiFailure(0, { code: 'token_missing', message: 'this page has no session token; open it from `workforce serve`' });
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-workforce-token': token },
    body: JSON.stringify(body),
  });
  return parse(response);
}

export const api = {
  office: (refresh = false) => getJson(refresh ? '/api/office?refresh=1' : '/api/office'),
  runs: (limit = 50) => getJson(`/api/runs?limit=${encodeURIComponent(limit)}`),
  run: (runId) => getJson(`/api/runs/${encodeURIComponent(runId)}`),
  artifact: (runId, artifactId) => getJson(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`),
  /** Starts nothing: what a start would meet. */
  preview: (body) => postJson('/api/runs/preview', body),
  /** Spends a model turn: runs `workforce run --json` through the coordinator. */
  start: (body) => postJson('/api/runs', body),
};

/**
 * Tail every run's events from `after`. EventSource reconnects on its own and
 * resends the last id it saw, so a dropped connection resumes with nothing
 * missed and nothing repeated.
 */
export function subscribeEvents(after, { onEvent, onStatus }) {
  let source = null;
  let closed = false;
  const open = () => {
    source = new EventSource(`/api/events?after=${encodeURIComponent(after)}`);
    source.onopen = () => onStatus?.('live');
    source.onerror = () => onStatus?.(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    source.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      onEvent?.(event);
    };
    source.addEventListener('stream-error', (message) => {
      let detail = null;
      try {
        detail = JSON.parse(message.data);
      } catch {
        detail = null;
      }
      onStatus?.('failed', detail);
      source.close();
    });
  };
  open();
  return {
    close() {
      closed = true;
      source?.close();
    },
    get closed() {
      return closed;
    },
  };
}
