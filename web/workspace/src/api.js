/**
 * The page's only way to the workforce server. Same origin only: every URL is
 * a relative `/api/...` path. The session token comes from the meta tag the
 * server wrote into this page, is sent only on POST routes in the
 * `x-workforce-token` header, and is never stored.
 */
const TOKEN_META = 'meta[name="workforce-session-token"]';

export class ApiFailure extends Error {
  constructor(status, body) {
    const error = body?.error ?? null;
    super(error?.message || (status === 0 ? 'the page server is not answering' : `request failed with HTTP ${status}`));
    this.name = 'ApiFailure';
    this.status = status;
    this.code = error?.code || (status === 0 ? 'unreachable' : `http_${status}`);
    this.details = Array.isArray(error?.details) ? error.details.map(String) : [];
    this.body = body ?? null;
  }
}

const token = () => document.querySelector(TOKEN_META)?.getAttribute('content') || '';
const enc = encodeURIComponent;

async function parse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiFailure(response.status, { error: { code: 'invalid_response', message: `the server answered HTTP ${response.status} without JSON` } });
  }
  if (!response.ok || body?.ok === false) throw new ApiFailure(response.status, body);
  return body;
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new ApiFailure(0, null);
  }
  return parse(response);
}

export const getJson = (path) => request(path, { method: 'GET', headers: { accept: 'application/json' } });

export function postJson(path, body = {}) {
  const value = token();
  if (!value) return Promise.reject(new ApiFailure(403, { error: { code: 'token_missing', message: 'this page has no session token; open it from workforce serve' } }));
  return request(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-workforce-token': value }, body: JSON.stringify(body) });
}

const runBase = (projectId, runId) => (projectId ? `/api/projects/${enc(projectId)}/runs/${enc(runId)}` : `/api/runs/${enc(runId)}`);

export const api = {
  workspace: (refresh = false) => getJson(refresh ? '/api/workspace?refresh=1' : '/api/workspace'),
  runs: (limit = 100) => getJson(`/api/runs?limit=${limit}`),
  requests: () => getJson('/api/requests'),
  status: (projectId, runId) => getJson(runBase(projectId, runId)),
  eventsPage: (projectId, runId, after = 0) => getJson(`${runBase(projectId, runId)}/events?after=${after}&limit=5000`),
  artifact: (projectId, runId, artifactId) => getJson(`${runBase(projectId, runId)}/artifacts/${enc(artifactId)}`),
  inspect: (path) => postJson('/api/projects/inspect', { path }),
  ops: (expectRevision, ops) => postJson('/api/workspace/ops', { expectRevision, ops }),
  send: (body) => postJson('/api/requests', body),
  startHeld: (id) => postJson(`/api/requests/${enc(id)}/start`, {}),
  discard: (id) => postJson(`/api/requests/${enc(id)}/discard`, {}),
  stopRequest: (id) => postJson(`/api/requests/${enc(id)}/stop`, {}),
  stopRun: (projectId, runId) => postJson(`/api/projects/${enc(projectId)}/runs/${enc(runId)}/stop`, {}),
  resume: (projectId, runId, allowUnconfinedWrites) => postJson(`/api/projects/${enc(projectId)}/runs/${enc(runId)}/resume`, allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}),
};

/** Every event of one run, a page at a time, up to `cap` events. */
export async function allEvents(projectId, runId, cap = 50_000) {
  const events = [];
  let after = 0;
  for (;;) {
    const page = await api.eventsPage(projectId, runId, after);
    events.push(...page.events);
    if (!page.hasMore || page.events.length === 0 || events.length >= cap) return events;
    after = page.events[page.events.length - 1].sequence;
  }
}

/**
 * Tail every project's events from `after`. EventSource reconnects on its own
 * and resends the last id it saw, so a dropped connection resumes with nothing
 * missed and nothing repeated.
 */
export function subscribeEvents(after, { onEvent, onStatus }) {
  const source = new EventSource(`/api/events?after=${enc(after ?? '')}`);
  source.onopen = () => onStatus?.('live');
  source.onerror = () => onStatus?.(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  source.onmessage = (message) => {
    try {
      onEvent?.(JSON.parse(message.data));
    } catch {
      // a frame that is not JSON is ignored
    }
  };
  source.addEventListener('stream-error', () => {
    onStatus?.('closed');
    source.close();
  });
  return { close: () => source.close() };
}
