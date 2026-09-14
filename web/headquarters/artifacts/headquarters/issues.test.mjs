import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IssueBoardStore, issueEvidenceLabel, shortIssueId, createIssueBoard, issueHandoffs, captureIssueDraft, issueResultSummary, issueArtifactGroups } from '../../src/headquarters/issues.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const issue = (overrides = {}) => ({ id: 'issue-one', revision: 1, projectId: 'project-a', title: 'Full requirement', description: 'Preserve every detail\nAcceptance: literal <script> is text.', kind: 'prd', status: 'backlog', execution: { state: 'idle', verified: false }, ...overrides });

test('changing projects while a read is pending never shows the earlier project as current', async () => {
  const old = deferred(), current = deferred(), calls = [];
  const store = new IssueBoardStore(path => { calls.push(path); return path.includes('project-a') ? old.promise : current.promise; });
  store.select('project-a'); const a = store.load();
  store.select('project-b'); const b = store.load();
  current.resolve({ issues: [issue({ projectId: 'project-b', id: 'issue-b' })] }); await b;
  old.resolve({ issues: [issue()] }); await a;
  assert.deepEqual(calls, ['/api/issues?projectId=project-a', '/api/issues?projectId=project-b']);
  assert.deepEqual(store.issues.map(item => item.id), ['issue-b']);
});

test('an old in-flight board snapshot cannot replace a successfully saved revision', async () => {
  const snapshot = deferred();
  const store = new IssueBoardStore((path, body) => body ? Promise.resolve({ issue: issue({ revision: 2, title: body.title }) }) : snapshot.promise);
  store.select('project-a'); const pending = store.load();
  await store.update(issue(), { title: 'Changed title' });
  snapshot.resolve({ issues: [issue()] }); await pending;
  assert.equal(store.issues[0].title, 'Changed title'); assert.equal(store.issues[0].revision, 2);
});

test('create and manual move preserve full descriptions and do not dispatch work', async () => {
  const calls = [];
  const store = new IssueBoardStore(async (path, body) => { calls.push([path, body]); return { issue: issue(body?.status ? { status: body.status } : {}) }; });
  const input = { projectId: 'project-a', title: 'Full requirement', description: issue().description, kind: 'prd', status: 'backlog', idempotencyKey: 'stable-create-key', start: false };
  await store.create(input); await store.update(store.issues[0], { status: 'done' });
  assert.equal(calls.length, 2); assert.equal(calls[0][1].description, issue().description); assert.equal(calls[0][1].start, false);
  assert.equal(calls[1][0], '/api/issues/issue-one/update'); assert.equal(calls[1][1].expectRevision, 1);
  assert.equal(issueEvidenceLabel(store.issues[0]), 'Manually completed');
  assert.ok(calls.every(([path]) => !path.endsWith('/start')));
});

test('explicit dispatch uses the reviewed issue revision and only forwards intentional access consent', async () => {
  const calls = [];
  const store = new IssueBoardStore(async (path, body) => { calls.push([path, body]); return { issue: issue({ requestId: 'request-one', status: 'in_progress', execution: { state: 'running', verified: false } }) }; });
  await store.start(issue()); await store.start(issue(), true);
  assert.deepEqual(calls[0], ['/api/issues/issue-one/start', { expectRevision: 1 }]);
  assert.equal(calls[1][1].allowUnconfinedWrites, true);
  assert.equal(issueEvidenceLabel(store.issues[0]), 'Working');
});

test('a rejected save preserves saved board data and propagates conflict to the draft owner', async () => {
  const conflict = Object.assign(new Error('Revision changed'), { status: 409 });
  const store = new IssueBoardStore(async () => { throw conflict; }); store.issues = [issue()];
  await assert.rejects(store.update(issue(), { title: 'Draft must stay' }), conflict);
  assert.equal(store.issues[0].title, 'Full requirement'); assert.equal(store.issues[0].revision, 1);
});

test('connection failure retains the last saved snapshot without claiming it is current', async () => {
  const store = new IssueBoardStore(async () => { throw new Error('Coordinator stopped'); });
  store.loaded = true; store.issues = [issue()]; await store.load();
  assert.equal(store.issues.length, 1); assert.equal(store.error, 'Coordinator stopped');
});

test('an idle board read starts no request or model turn', async () => {
  const calls = []; const store = new IssueBoardStore(async (...args) => { calls.push(args); return { issues: [] }; });
  await store.load();
  assert.deepEqual(calls, [['/api/issues']]);
});

test('only verification evidence renders the verified completion label', () => {
  assert.equal(issueEvidenceLabel(issue({ status: 'done' })), 'Manually completed');
  assert.equal(issueEvidenceLabel(issue({ status: 'done', requestId: 'request-one', execution: { state: 'completed', verified: false } })), 'Completion not verified');
  assert.equal(issueEvidenceLabel(issue({ status: 'done', requestId: 'request-one', execution: { state: 'completed', verified: true } })), 'Verified candidate');
});

test('reviewed analysis completes as a report and never as a verified candidate', () => {
  const execution = { state: 'completed', workKind: 'analysis', analysisReviewed: true, verified: false };
  assert.equal(issueEvidenceLabel(issue({ status: 'done', requestId: 'request-one', execution })), 'Reviewed analysis');
  assert.equal(issueEvidenceLabel(issue({ status: 'in_review', requestId: 'request-one', execution: { ...execution, state: 'review', analysisReviewed: false } })), 'Report review');
  assert.equal(issueEvidenceLabel(issue({ status: 'in_review', requestId: 'request-one', execution: { ...execution, state: 'blocked', analysisReviewed: false } })), 'Needs attention');
  assert.equal(issueEvidenceLabel(issue({ status: 'done', requestId: 'request-one', execution: { ...execution, analysisReviewed: false } })), 'Completion not verified');
});

test('a saved dispatch intent without a receipt is never described as not sent', () => {
  assert.equal(issueEvidenceLabel(issue({ execution: { state: 'dispatching', verified: false } })), 'Sending to Control Center');
  assert.equal(issueEvidenceLabel(issue({ execution: { state: 'unknown', verified: false } })), 'Execution unknown');
});

test('answered and canceled work have honest terminal labels without claiming verified implementation', () => {
  assert.equal(issueEvidenceLabel(issue({ status: 'done', requestId: 'answer', execution: { state: 'answered', verified: false } })), 'Answer delivered');
  assert.equal(issueEvidenceLabel(issue({ status: 'cancelled', requestId: 'discarded', execution: { state: 'cancelled', verified: false } })), 'Canceled');
  assert.equal(issueEvidenceLabel(issue({ status: 'cancelled' })), 'Canceled');
});

const { IssueDraftStore, IssueDetailStore, filterIssueRows } = await import('../../src/headquarters/issues.js');
const draftStorage = () => {
  const records = new Map(); let count = 0;
  return { records, drafts: new IssueDraftStore({ read: name => records.has(name) ? structuredClone(records.get(name)) : null, write: (name, value) => value === null ? records.delete(name) : records.set(name, structuredClone(value)), makeKey: () => `draft-${++count}` }) };
};

test('edited requirements survive closing the editor and retain their original reviewed revision', () => {
  const { drafts } = draftStorage(); const original = issue({ revision: 3 });
  let draft = drafts.open(original); draft = drafts.change(original, draft, 'description', 'All original acceptance criteria\nNew local requirement');
  const reopened = drafts.open(issue({ revision: 4, description: 'Changed in another client' }));
  assert.equal(reopened.description, 'All original acceptance criteria\nNew local requirement');
  assert.equal(reopened.expectRevision, 3);
  assert.equal(reopened.idempotencyKey, draft.idempotencyKey);
});

test('an uncertain create retry uses one submission key until its content actually changes', () => {
  const { drafts } = draftStorage();
  let first = drafts.open(null, { projectId: 'project-a' }); first = drafts.change(null, first, 'title', 'New plan');
  const retry = drafts.open(null, { projectId: 'project-b' });
  assert.equal(retry.idempotencyKey, first.idempotencyKey); assert.equal(retry.projectId, 'project-a');
  const identicalEvent = drafts.change(null, retry, 'title', 'New plan');
  assert.equal(identicalEvent.idempotencyKey, first.idempotencyKey);
  const edited = drafts.change(null, retry, 'title', 'Revised plan');
  assert.notEqual(edited.idempotencyKey, first.idempotencyKey);
});

test('submission captures the selected form project even when no draft input event fired', () => {
  const { drafts } = draftStorage();
  const cached = drafts.open(null, { projectId: 'agents-office' });
  const values = { projectId: 'dogfood-frontend', kind: 'issue', title: 'Accessible badge fix', description: 'Change only the fixture source.', status: 'backlog', priority: 'high' };
  const form = { elements: { namedItem: field => ({ value: values[field] }) } };
  const submitted = captureIssueDraft(drafts, null, cached, form);
  assert.equal(submitted.projectId, 'dogfood-frontend'); assert.equal(submitted.title, values.title);
  assert.equal(submitted.description, values.description); assert.notEqual(submitted.idempotencyKey, cached.idempotencyKey);
  assert.equal(drafts.open(null).projectId, 'dogfood-frontend');
  assert.equal(captureIssueDraft(drafts, null, submitted, form).idempotencyKey, submitted.idempotencyKey, 'Retrying unchanged visible content retains its key');
});

test('capturing an edit preserves its immutable project and reviewed revision', () => {
  const { drafts } = draftStorage(), original = issue({ revision: 9 });
  const submitted = captureIssueDraft(drafts, original, drafts.open(original), { elements: { namedItem: field => ({ value: { projectId: 'wrong-project', kind: 'issue', title: 'Edited title', description: 'Retained criteria', status: 'backlog', priority: 'low' }[field] }) } });
  assert.equal(submitted.projectId, original.projectId); assert.equal(submitted.kind, original.kind);
  assert.equal(submitted.expectRevision, 9); assert.equal(submitted.title, 'Edited title');
});

test('a save completing after navigation does not clear a newer draft', () => {
  const { drafts } = draftStorage(); const original = issue();
  const sent = drafts.open(original); const newer = drafts.change(original, sent, 'title', 'Continue editing after navigation');
  drafts.clearSaved(original, sent.idempotencyKey);
  assert.equal(drafts.open(original).title, newer.title);
  drafts.clearSaved(original, newer.idempotencyKey);
  assert.equal(drafts.open(original).title, original.title);
});

test('issue drafts remain independent across projects and records', () => {
  const { drafts } = draftStorage(); const first = issue(); const second = issue({ id: 'issue-two', projectId: 'project-b' });
  drafts.change(first, drafts.open(first), 'description', 'Project A only');
  drafts.change(second, drafts.open(second), 'description', 'Project B only');
  assert.equal(drafts.open(first).description, 'Project A only');
  assert.equal(drafts.open(second).description, 'Project B only');
});

test('assignee and priority filters use recorded ownership and leave saved ordering untouched', () => {
  const rows = [issue({ id: 'low', priority: 'low', execution: { owners: [{ id: 'sam', name: 'Sam' }], department: { name: 'Engineering' } }, updatedAt: '2026-09-14T10:00:00Z' }), issue({ id: 'urgent', priority: 'urgent', execution: { owners: [{ id: 'sam', name: 'Sam' }] }, updatedAt: '2026-09-13T10:00:00Z' }), issue({ id: 'free', priority: 'high', execution: { owners: [] } })];
  assert.deepEqual(filterIssueRows(rows, { owner: 'sam', sort: 'priority' }).map(item => item.id), ['urgent', 'low']);
  assert.deepEqual(filterIssueRows(rows, { owner: 'unassigned' }).map(item => item.id), ['free']);
  assert.deepEqual(filterIssueRows(rows, { priority: 'low', query: 'engineering' }).map(item => item.id), ['low']);
  assert.deepEqual(rows.map(item => item.id), ['low', 'urgent', 'free']);
});

test('switching issue detail while a request read is pending cannot show the previous project evidence', async () => {
  const old = deferred(); const store = new IssueDetailStore(async path => path.endsWith('request-a') ? old.promise : { request: { id: 'request-b', projectId: 'project-b' } });
  const a = store.load(issue({ requestId: 'request-a' }));
  const b = store.load(issue({ id: 'issue-b', projectId: 'project-b', requestId: 'request-b' })); await b;
  old.resolve({ request: { id: 'request-a', projectId: 'project-a' } }); await a;
  assert.equal(store.request.id, 'request-b'); assert.equal(store.id, 'issue-b');
});

test('detail reads do not accept a request from another project as handoff evidence', async () => {
  const calls = []; const store = new IssueDetailStore(async path => { calls.push(path); return { request: { id: 'request-a', projectId: 'project-b', runId: 'foreign-run' } }; });
  await store.load(issue({ requestId: 'request-a' }));
  assert.equal(store.request, null); assert.match(store.error, /does not match/);
  assert.deepEqual(calls, ['/api/requests/request-a']);
});

test('a refused start updates the recorded revision so a consent retry uses the current issue', async () => {
  const error = Object.assign(new Error('Consent required'), { data: { issue: issue({ revision: 2, execution: { state: 'blocked', reason: 'Consent required' } }) } });
  const store = new IssueBoardStore(async () => { throw error; }); store.issues = [issue()];
  await assert.rejects(store.start(store.issues[0]), /Consent required/);
  assert.equal(store.issues[0].revision, 2); assert.equal(store.issues[0].execution.state, 'blocked');
});

test('nearby UUIDv7 issues have distinguishable visible IDs and remain searchable by either ID', () => {
  const a = issue({ id: '01a09e8c-61b4-7188-ae98-e1e3c013901a' });
  const b = issue({ id: '01a09e8c-61dd-779f-9c57-c906724481a8' });
  assert.equal(shortIssueId(a), '#c013901a'); assert.equal(shortIssueId(b), '#724481a8');
  assert.notEqual(shortIssueId(a), shortIssueId(b));
  assert.deepEqual(filterIssueRows([a, b], { query: shortIssueId(b) }), [b]);
  assert.deepEqual(filterIssueRows([a, b], { query: a.id }), [a]);
});

test('long run activity advances global sequence cursors in bounded batches and never rereads history', async () => {
  const calls = [], record = issue({ runId: 'run-a' }); let last = 3010;
  const store = new IssueDetailStore(async path => {
    calls.push(path);
    if (!path.includes('/events?')) return { run: { id: 'run-a' }, eventCount: last };
    const after = Number(new URL(path, 'http://local').searchParams.get('after'));
    // Other runs own the missing sequence numbers. The cursor is not a row count.
    const sequence = after === 0 ? 500 : after + 500;
    return { runId: 'run-a', hasMore: sequence < last, lastSequence: last, events: [{ sequence: Math.min(sequence, last), type: 'head.assigned', timestamp: '2026-09-14T06:00:00Z', payload: {} }] };
  });
  await store.load(record);
  assert.equal(store.eventCursor, 2000); assert.equal(store.hasMore, true); assert.equal(store.events.length, 4);
  assert.equal(calls.filter(path => path.includes('/events?')).length, 4);
  assert.equal(store.needsRefresh(record), true);
  await store.load(record); assert.equal(store.eventCursor, 3010); assert.equal(store.hasMore, false);
  assert.deepEqual(calls.filter(path => path.includes('/events?')).map(path => new URL(path, 'http://local').searchParams.get('after')), ['0', '500', '1000', '1500', '2000', '2500', '3000']);
  const readCount = calls.filter(path => path.includes('/events?')).length;
  await store.load(record); assert.equal(calls.filter(path => path.includes('/events?')).length, readCount);
  assert.equal(store.needsRefresh(record), false);
  assert.equal(store.needsRefresh({ ...record, execution: { state: 'completed', updatedAt: '2026-09-14T07:00:00Z' } }), true, 'Terminal state changes must fetch final review and reply');
});

test('a failed later event page preserves its cursor and resumes without duplicate handoffs', async () => {
  let fail = true; const afters = [];
  const store = new IssueDetailStore(async path => {
    if (!path.includes('/events?')) return { run: { id: 'run-a' }, eventCount: 201 };
    const after = Number(new URL(path, 'http://local').searchParams.get('after')); afters.push(after);
    if (after === 100 && fail) throw new Error('Temporary page failure');
    return { runId: 'run-a', hasMore: after === 0, events: [{ sequence: after === 0 ? 100 : 201, type: after === 0 ? 'head.assigned' : 'control.final_reply', payload: {} }] };
  });
  await store.load(issue({ runId: 'run-a' })); assert.equal(store.eventCursor, 100); assert.match(store.error, /Temporary page failure/);
  fail = false; await store.load(issue({ runId: 'run-a' }));
  assert.deepEqual(afters, [0, 100, 100]); assert.deepEqual(store.events.map(event => event.sequence), [100, 201]); assert.equal(store.error, '');
});

test('a retry on the same issue discards the previous run cursor and ignores its pending page', async () => {
  const old = deferred(), calls = [];
  const store = new IssueDetailStore(async path => {
    calls.push(path);
    if (!path.includes('/events?')) return { run: { id: path.endsWith('run-a') ? 'run-a' : 'run-b' }, eventCount: 1 };
    return path.includes('/run-a/') ? old.promise : { runId: 'run-b', hasMore: false, events: [{ sequence: 1, type: 'head.planning_started', payload: {} }] };
  });
  const first = store.load(issue({ runId: 'run-a' })); await new Promise(resolve => setImmediate(resolve));
  await store.load(issue({ runId: 'run-b' }));
  old.resolve({ runId: 'run-a', hasMore: false, events: [{ sequence: 100, type: 'control.final_reply', payload: {} }] }); await first;
  assert.equal(store.status.run.id, 'run-b'); assert.equal(store.eventsRunId, 'run-b'); assert.equal(store.eventCursor, 1);
  assert.deepEqual(store.events.map(event => event.type), ['head.planning_started']);
  assert.ok(calls.includes('/api/projects/project-a/runs/run-b/events?after=0&limit=500'));
});

test('handoffs show named planning, worker, verifier, review and delivery with recorded phase boundaries', () => {
  const record = issue({ execution: { state: 'completed', department: { name: 'Backend & Data' }, owners: [{ id: 'head', name: 'Alisha Granderson' }, { id: 'worker', name: 'Danny Green' }] } });
  const event = (sequence, type, timestamp, payload = {}, taskId = null, attemptId = null) => ({ sequence, type, timestamp, payload, taskId, attemptId });
  const events = [event(2, 'head.planning_started', '2026-09-14T06:14:01Z', { headAgentId: 'head' }), event(58, 'head.assigned', '2026-09-14T06:14:51Z', { headAgentId: 'head', agentId: 'worker', objective: 'Fix order totals' }), event(59, 'head.planning_finished', '2026-09-14T06:14:51Z', { headAgentId: 'head', taskCount: 1, outcome: 'planned' }), event(139, 'run.accepted', '2026-09-14T06:16:04Z', { accepted: true }, 'task', 'attempt'), event(142, 'head.review_started', '2026-09-14T06:16:04Z', { headAgentId: 'head', reviewId: 'review' }), event(200, 'head.review_finished', '2026-09-14T06:16:47Z', { headAgentId: 'head', reviewId: 'review', verdict: 'passed' }), event(201, 'control.final_reply', '2026-09-14T06:16:47Z', { verificationStatus: 'verified' })];
  const status = { taskViews: [{ id: 'task', ownerAgentId: 'worker', state: 'accepted', objective: 'Fix order totals', attempt: { id: 'attempt', startedAt: '2026-09-14T06:14:53Z', endedAt: '2026-09-14T06:16:03Z' }, receipts: { verifierExecutedPassed: 1 } }] };
  const rows = issueHandoffs(record, { route: { departmentId: 'backend', headAgentId: 'head', decidedAt: '2026-09-14T06:14:00Z' } }, status, events);
  assert.ok(rows.some(row => row.label === 'Alisha Granderson → Danny Green'));
  assert.ok(rows.some(row => row.label === 'Independent checks passed'));
  assert.equal(rows.at(-1).label, 'Control Center returned the result');
  assert.deepEqual(rows.filter(row => row.start).map(({ label, start, end }) => ({ label, start, end })), [
    { label: 'Alisha Granderson · Planning', start: '2026-09-14T06:14:01Z', end: '2026-09-14T06:14:51Z' },
    { label: 'Danny Green · Implementation', start: '2026-09-14T06:14:53Z', end: '2026-09-14T06:16:03Z' },
    { label: 'Alisha Granderson · Candidate review', start: '2026-09-14T06:16:04Z', end: '2026-09-14T06:16:47Z' },
  ]);
  const incomplete = issueHandoffs(record, null, null, [events[4]])[0];
  assert.equal(incomplete.end, null); assert.equal(incomplete.active, false, 'A missing finish on a terminal run must not keep ticking');
});

test('result summaries use recorded receipt states instead of free-form claims', () => {
  assert.equal(issueResultSummary(issue({ status: 'done', execution: { state: 'completed', verified: true, checks: { passed: 2, total: 2 } } })), '2 of 2 independent checks passed. Department review completed. Proposed changes are ready to inspect.');
  assert.equal(issueResultSummary(issue({ status: 'done', execution: { state: 'completed', analysisReviewed: true, verified: false } })), 'The analysis report is ready. Department review completed.');
  assert.match(issueResultSummary(issue({ status: 'done', requestId: 'reply', execution: { state: 'answered', verified: false } })), /answer.*No implementation run/);
  assert.equal(issueResultSummary(issue({ status: 'cancelled' })), 'This issue was canceled.');
  assert.match(issueResultSummary(issue({ status: 'done' })), /manually.*No execution/);
  assert.match(issueResultSummary(issue({ requestId: 'request', status: 'done', execution: { state: 'completed', verified: false } })), /without verified completion/);
  assert.equal(issueResultSummary(issue({ requestId: 'request', execution: { state: 'running', verified: false, reason: 'Everything passed' } })), '');
});

test('deliverable grouping keeps internal JSON and all remaining technical records accessible separately', () => {
  const artifacts = [
    { id: 'report', type: 'analysis_report', path: 'analysis/report.json' },
    { id: 'patch', type: 'candidate_patch', path: 'candidate.patch' },
    { id: 'summary', type: 'summary', path: 'summary.md' },
    { id: 'json', type: 'summary', path: 'summary.json' },
    { id: 'review', type: 'head_review_result', path: 'review.json' },
    { id: 'result', type: 'result', path: 'result.json' },
    { id: 'log', type: 'worker_stdout', path: 'worker.log' },
  ];
  const groups = issueArtifactGroups(artifacts);
  assert.deepEqual(groups.deliverables.map(item => item.id), ['report', 'patch', 'summary']);
  assert.deepEqual(groups.technical.map(item => item.id), ['json', 'review', 'result', 'log']);
  assert.equal(groups.deliverables.length + groups.technical.length, artifacts.length);
});

test('workspace updates refresh project choices without remounting filters, inspector, or open draft', async () => {
  // Minimal event/element surface: assert controller behavior without a browser dependency.
  class Element extends EventTarget {
    constructor() { super(); this.children = new Map(); this.writes = 0; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {} }; }
    set innerHTML(value) { this.html = value; this.writes++; this.children.clear(); }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    querySelectorAll() { return []; }
    contains() { return false; }
    setAttribute() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.removed = true; }
  }
  const dispatch = (element, type, target, key) => { const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); if (key) Object.defineProperty(event, 'key', { value: key }); element.dispatchEvent(event); };
  const click = (host, action, id) => dispatch(host, 'click', { dataset: { issueAction: action, id }, closest() { return this; } });
  const originalDocument = globalThis.document, originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), originalObserver = globalThis.ResizeObserver, originalComputedStyle = globalThis.getComputedStyle;
  const observers = [];
  globalThis.getComputedStyle = () => ({ columnGap: '10px' });
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  const preferences = { projectId: 'project-a', query: 'Full requirement', owner: '', priority: 'high', sort: 'priority', hideEmpty: true };
  const saved = new Map([['workforce-issue-board-v1', JSON.stringify(preferences)]]), created = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
  globalThis.document = { activeElement: null, visibilityState: 'visible', createElement: () => new Element(), body: { append: element => created.push(element) } };
  const events = new EventTarget(), host = new Element(), reads = [], writes = [], notifications = [];
  let projects = [{ id: 'project-a', name: 'Original project' }], linkedReport = null, linkedRequest = null;
  const record = issue({ priority: 'high', revision: 7, execution: { state: 'idle', owners: [{ id: 'will-mason', name: 'Will Mason', role: 'worker' }, { id: 'kara-foster', name: 'Kara Foster', role: 'head' }] } });
  const board = createIssueBoard({ api: async (path, body) => { if (body) { writes.push([path, body]); return { issue: issue({ ...body, id: `created-${writes.length}` }), ...(body.start ? { startError: { code: 'runtime_unavailable', message: 'No runtime is available.' } } : {}) }; } if (path === '/api/requests/request-proof') return { request: linkedRequest }; if (path === '/api/projects/project-a/runs/run-proof') return linkedReport; reads.push(path); return { issues: [record] }; }, notify: text => notifications.push(text), getProjects: () => projects, workspaceEvents: events });
  try {
    board.mount(host); await new Promise(resolve => setImmediate(resolve));
    const selector = host.querySelector('[data-issue-project]'), inspector = host.querySelector('[data-issue-inspector]');
    assert.doesNotMatch(host.innerHTML, /issue-page-header/, 'There is no duplicate page title inside the board');
    assert.match(host.innerHTML, /<h1 class="issue-sr-only">Issues<\/h1>/);
    assert.match(selector.innerHTML, /Original project/);
    const boardMarkup = host.querySelector('[data-issue-board]').innerHTML;
    assert.match(boardMarkup, />Will Mason, Kara Foster<\/span>/);
    assert.doesNotMatch(boardMarkup, /2 assignees/);
    const card = boardMarkup.match(/<button type="button" class="issue-card issue-card--minimal[\s\S]*?<\/button>/)?.[0];
    assert.ok(card, 'A native button makes the whole card clickable and keyboard-operable');
    assert.match(card, /data-issue-action="open"/); assert.match(card, /Full requirement/); assert.match(card, /Original project/); assert.match(card, /data-duration-value/);
    assert.doesNotMatch(card, /issue-card-(?:top|kind|department|checks|evidence|blocker|dates|footer)|issue-priority|data-issue-move|<select|<footer/);
    assert.equal((card.match(/<button/g) || []).length, 1, 'No nested interactive controls compete with card activation');
    const scroller = host.querySelector('.issue-board-scroll'), controls = host.querySelector('[data-issue-scroll-controls]');
    Object.assign(scroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 0, scrollTo({ left }) { this.scrollLeft = Math.min(left, this.scrollWidth - this.clientWidth); this.dispatchEvent(new Event('scroll')); } });
    scroller.querySelector('.issue-column').getBoundingClientRect = () => ({ width: 250 });
    observers[0].callback();
    assert.equal(controls.hidden, false); assert.equal(controls.querySelector('[data-issue-action="scroll-left"]').disabled, true);
    click(host, 'scroll-right'); assert.equal(scroller.scrollLeft, 260, 'Column navigation follows the actual column width and computed gap');
    assert.equal(controls.querySelector('[data-issue-action="scroll-left"]').disabled, false);
    Object.assign(scroller, { matches: selector => selector === '.issue-board-scroll' });
    dispatch(host, 'keydown', scroller, 'End'); assert.equal(scroller.scrollLeft, 600);
    dispatch(host, 'keydown', scroller, 'Home'); assert.equal(scroller.scrollLeft, 0);
    dispatch(host, 'keydown', scroller, 'ArrowRight'); assert.ok(scroller.scrollLeft > 0);
    scroller.scrollLeft = 600; scroller.dispatchEvent(new Event('scroll'));
    assert.equal(controls.querySelector('[data-issue-action="scroll-right"]').disabled, true);
    scroller.scrollWidth = 600; observers[0].callback(); assert.equal(controls.hidden, true, 'Navigation hides when all visible columns fit');
    click(host, 'open', record.id);
    assert.match(inspector.innerHTML, />Will Mason<\/span><span class="issue-owner-role">worker/);
    assert.match(inspector.innerHTML, />Kara Foster<\/span><span class="issue-owner-role">head/);
    assert.equal(inspector.innerHTML.match(/Execution time/g)?.length, 1, 'The inspector labels execution time once');
    assert.match(inspector.innerHTML, /data-issue-move="issue-one"/, 'Planning status remains available in issue details');
    click(host, 'edit', record.id);
    const editor = created.at(-1), draftText = 'Unsaved acceptance criteria stay intact';
    dispatch(editor, 'input', { name: 'description', value: draftText });
    const draftEntry = [...saved].find(([key]) => key !== 'workforce-issue-board-v1');
    const draftBefore = draftEntry[1], editorWrites = editor.writes, shellWrites = host.writes;
    projects = [{ id: 'project-a', name: 'Renamed project' }, { id: 'project-b', name: 'Newly registered project' }];
    events.dispatchEvent(new Event('workforce:workspace-updated'));
    assert.match(selector.innerHTML, /Newly registered project/);
    assert.match(selector.innerHTML, /value="project-a" selected/);
    assert.equal(host.writes, shellWrites, 'Search and filter controls must not be remounted');
    assert.equal(inspector.hidden, false); assert.match(inspector.innerHTML, /Renamed project/);
    assert.equal(editor.open, true); assert.equal(editor.writes, editorWrites, 'Do not replace editor fields');
    assert.match(editor.querySelector('select[name="projectId"]').innerHTML, /Newly registered project/);
    assert.equal(saved.get(draftEntry[0]), draftBefore); assert.equal(JSON.parse(draftBefore).expectRevision, 7);
    assert.equal(JSON.parse(draftBefore).description, draftText);
    assert.deepEqual(JSON.parse(saved.get('workforce-issue-board-v1')), preferences);
    assert.deepEqual(reads, ['/api/issues?projectId=project-a'], 'Workspace metadata alone must not switch projects or start work');
    projects = [{ id: 'project-b', name: 'Only remaining project' }];
    events.dispatchEvent(new Event('workforce:workspace-updated'));
    assert.match(selector.innerHTML, /value="project-a" selected disabled/);
    assert.equal(inspector.hidden, false); assert.equal(saved.get(draftEntry[0]), draftBefore);
    click(editor, 'close');
    for (const action of ['save', 'start']) {
      board.openCreate(); const dialog = created.at(-1);
      assert.match(dialog.innerHTML, />Create &amp; start<|>Create & start</);
      const values = { projectId: 'project-b', kind: 'prd', title: `Explicit ${action}`, description: 'The complete reviewed brief', status: 'backlog', priority: 'high' };
      const form = { matches: selector => selector === '[data-issue-form]', reportValidity: () => true, elements: { namedItem: field => ({ value: values[field] }) } };
      const submit = new Event('submit', { cancelable: true });
      Object.defineProperty(submit, 'target', { value: form }); Object.defineProperty(submit, 'submitter', { value: { value: action } });
      dialog.dispatchEvent(submit); await new Promise(resolve => setImmediate(resolve));
      const [route, body] = writes.at(-1);
      assert.equal(route, '/api/issues'); assert.equal(body.projectId, 'project-b');
      assert.equal(body.description, values.description); assert.equal(body.start, action === 'start');
      assert.equal(dialog.open, false);
      if (action === 'start') { assert.match(inspector.innerHTML, /No runtime is available/); assert.ok(notifications.some(text => text.startsWith('Issue saved. No runtime'))); }
    }
    assert.equal(writes.length, 2, 'Each action makes exactly one create call, with no separate start request');
    linkedRequest = { id: 'request-proof', projectId: 'project-a', runId: 'run-proof', controlReply: 'FULL TECHNICAL REVIEW: candidate tree, verifier sandbox and internal receipt references.' };
    linkedReport = { run: { id: 'run-proof' }, eventCount: 0, artifacts: [{ id: 'patch-proof', type: 'candidate_patch' }, { id: 'result-proof', type: 'result', path: 'result.json' }, { id: 'review-proof', type: 'head_review_result' }] };
    Object.assign(record, { requestId: 'request-proof', runId: 'run-proof', status: 'done', execution: { state: 'completed', verified: true, checks: { passed: 1, total: 1 } } });
    await board.refresh(); click(host, 'open', record.id); await new Promise(resolve => setImmediate(resolve));
    assert.match(inspector.innerHTML, /1 of 1 independent checks passed/);
    const resultSection = inspector.innerHTML.match(/<section class="issue-result">([\s\S]*?)<\/section>/)?.[1];
    assert.doesNotMatch(resultSection, /FULL TECHNICAL REVIEW/);
    assert.match(inspector.innerHTML, /<details class="issue-evidence-section" data-issue-section="technical-review"><summary>[\s\S]*?FULL TECHNICAL REVIEW/);
    const deliverables = inspector.innerHTML.match(/<section class="issue-evidence-section issue-deliverables">([\s\S]*?)<\/section>/)?.[1];
    assert.match(deliverables, /patch-proof/); assert.doesNotMatch(deliverables, /result-proof|review-proof/);
    assert.match(inspector.innerHTML, /data-issue-section="technical-files"><summary>[\s\S]*?result-proof[\s\S]*?review-proof/);
    record.runId = null; linkedRequest.runId = null;
    for (const [state, status, label] of [['answered', 'done', 'Reply'], ['cancelled', 'cancelled', 'Elapsed']]) {
      Object.assign(record, { status, execution: { state, verified: false, startedAt: '2026-09-14T08:00:00Z', endedAt: '2026-09-14T08:00:19Z' } });
      await board.refresh();
      const timedCard = host.querySelector('[data-issue-board]').innerHTML.match(/<button type="button" class="issue-card issue-card--minimal[\s\S]*?<\/button>/)?.[0];
      assert.match(timedCard, new RegExp(`>${label}<`)); assert.match(timedCard, /19s/);
      assert.doesNotMatch(timedCard, />Execution</, 'Replies and canceled requests never imply completed coding execution');
      assert.match(inspector.innerHTML, new RegExp(`<dt>${label} time</dt>`));
    }
    click(host, 'clear-filters');
    const nextScroller = host.querySelector('.issue-board-scroll'), nextControls = host.querySelector('[data-issue-scroll-controls]');
    assert.notEqual(nextScroller, scroller, 'A full render replaces the scrolling element');
    assert.equal(observers[0].disconnected, true, 'The observer for the replaced board must disconnect');
    Object.assign(nextScroller, { scrollWidth: 1200, clientWidth: 600, scrollLeft: 0 });
    observers.at(-1).callback(); assert.equal(nextControls.hidden, false);
    const nextLeft = nextControls.querySelector('[data-issue-action="scroll-left"]');
    assert.equal(nextLeft.disabled, true);
    nextScroller.scrollLeft = 600; scroller.dispatchEvent(new Event('scroll'));
    assert.equal(nextLeft.disabled, true, 'The old scroller no longer updates controls');
    nextScroller.dispatchEvent(new Event('scroll')); assert.equal(nextLeft.disabled, false, 'The replacement scroll listener updates controls');
    nextScroller.scrollWidth = 600; observers.at(-1).callback(); assert.equal(nextControls.hidden, true, 'The replacement resize observer handles overflow');
    board.unmount(); const optionWrites = selector.writes;
    assert.equal(observers.at(-1).disconnected, true);
    events.dispatchEvent(new Event('workforce:workspace-updated')); assert.equal(selector.writes, optionWrites);
    assert.equal(observers[0].disconnected, true);
  } finally {
    board.unmount();
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStorage === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', originalStorage);
    if (originalObserver === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = originalObserver;
    if (originalComputedStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalComputedStyle;
  }
});
