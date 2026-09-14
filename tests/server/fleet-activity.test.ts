import { describe, expect, it } from 'vitest';
import { commandStatus } from '../../src/cli/commands/status.js';
import { acknowledge, findMessage, recordMessage, submitMessage } from '../../src/coordination/messages.js';
import { startOfficeServer } from '../../src/server/index.js';
import { openTempState } from '../helpers/state.js';
import { seedAttempt, seedRun, seedTask } from '../coordination/helpers.js';
import { rawRequest } from './support.js';

// The production module is browser-native JavaScript, loaded without a DOM.
const modulePath = '../../web/headquarters/src/headquarters/fleet-activity.js';
const { deriveFleetJourneys, deriveFleetHandoffs } = await import(modulePath) as {
  deriveFleetJourneys(input?: Record<string, unknown>): Array<Record<string, unknown>>;
  deriveFleetHandoffs(input?: Record<string, unknown>): Array<Record<string, unknown>>;
};
const agents = [{ id: 'head', name: 'Slattery' }, { id: 'frontend', name: 'Kara' }, { id: 'qa', name: 'Scott' }];
const departments = [{ id: 'eng', name: 'Engineering', headAgentId: 'head' }];
const request = { id: 'request', projectId: 'project', runId: 'run', task: 'Repair search\nKeep existing behavior', state: 'running', route: { state: 'selected', departmentId: 'eng', headAgentId: 'head' } };
const task = { id: 'task', ownerAgentId: 'frontend', objective: 'Repair the search input', state: 'running' };
const run = { id: 'run', projectId: 'project', state: 'running', taskViews: [task] };
const evidence = { accepted: true, requiredTotal: 2, requiredPassed: 2, failed: [], compromised: [], noEvidence: [] };
const context = { agents, departments, requests: [request], runs: [run] };

describe('fleet request journeys', () => {
  it('is empty for an empty workspace and never invents tasks', () => {
    expect(deriveFleetJourneys()).toEqual([]);
    expect(deriveFleetJourneys({ agents, departments })).toEqual([]);
  });
  it('uses task ownership and preserves concurrent work over later checking phases', () => {
    expect(deriveFleetJourneys({ ...context, runs: [{ ...run, taskViews: [task, { id: 'check', ownerAgentId: 'qa', state: 'validating' }] }] })[0]).toMatchObject({ title: 'Repair search', stage: 'work', status: 'Working', active: true, ownerNames: ['Kara'], ownerIds: ['frontend'] });
    expect(deriveFleetJourneys({ ...context, runs: [{ ...run, taskViews: [{ ...task, state: 'validating' }] }] })[0]).toMatchObject({ stage: 'checks', status: 'Running checks' });
  });
  it('does not show reserved workers or queued and held requests as working', () => {
    for (const [state, status] of [['queued', 'Queued'], ['held', 'Paused']]) {
      expect(deriveFleetJourneys({ ...context, requests: [{ ...request, state, workerIds: ['frontend'] }] })[0]).toMatchObject({ active: false, waiting: true, status, ownerIds: [] });
    }
  });
  it('requires recorded planning and actual actor identity before marking a head active', () => {
    const input = { ...context, runs: [{ ...run, taskViews: [] }] };
    expect(deriveFleetJourneys(input)[0]).toMatchObject({ stage: 'planning', active: false, ownerIds: [] });
    const started = { id: 'planning', projectId: 'project', runId: 'run', timestamp: '2026-09-13T10:00:00Z', type: 'head.planning_started', payload: { headAgentId: 'head' } };
    expect(deriveFleetJourneys({ ...input, events: [started] })[0]).toMatchObject({ stage: 'planning', active: true, ownerNames: ['Slattery'] });
    expect(deriveFleetJourneys({ ...input, events: [started, { ...started, id: 'finished', timestamp: '2026-09-13T10:01:00Z', type: 'head.planning_finished' }] })[0]).toMatchObject({ active: false, ownerIds: [] });
  });
  it('recovers planning from a read-only event page using route identity and sequence order', () => {
    const input = { ...context, runs: [{ ...run, taskViews: [] }], eventPages: [{ projectId: 'project', runId: 'run', events: [
      { sequence: 1, type: 'head.planning_started', timestamp: '2026-09-13T10:00:00Z', payload: { headAgentId: 'head' } },
    ] }] };
    expect(deriveFleetJourneys(input)[0]).toMatchObject({ stage: 'planning', active: true, ownerNames: ['Slattery'] });
    input.eventPages[0]!.events.push({ sequence: 2, type: 'head.planning_finished', timestamp: '2026-09-13T09:59:00Z', payload: { headAgentId: 'head' } });
    expect(deriveFleetJourneys(input)[0]).toMatchObject({ active: false });
    expect(deriveFleetJourneys({ ...input, eventPages: [{ ...input.eventPages[0], projectId: 'another-project' }] })[0]).toMatchObject({ active: false });
  });
  it('stopped requests and runs override lingering running tasks and review', () => {
    for (const state of ['interrupted', 'cancelled']) {
      expect(deriveFleetJourneys({ ...context, runs: [{ ...run, state, headReview: { state: 'running', headAgentId: 'head' } }] })[0]).toMatchObject({ status: 'Stopped', active: false, ownerIds: [] });
    }
    expect(deriveFleetJourneys({ ...context, requests: [{ ...request, state: 'ended', signal: 'SIGTERM' }] })[0]).toMatchObject({ status: 'Stopped', active: false });
  });
  it('direct answers do not imply completed engineering work or review', () => {
    expect(deriveFleetJourneys({ agents, requests: [{ id: 'reply', mode: 'discuss', state: 'ended', controlReply: 'Hello', exitCode: 0 }] })[0]).toMatchObject({ stage: null, status: 'Answered', active: false, ownerIds: [] });
    expect(deriveFleetJourneys({ agents, requests: [{ ...request, state: 'ended', exitCode: 0 }], runs: [] })[0]).toMatchObject({ stage: null, status: 'Result not loaded', waiting: true });
  });
  it('requires checks and passed review for completion, keeping missing or compromised proof explicit', () => {
    const ready = { ...run, state: 'ready_for_review', taskViews: [{ ...task, state: 'accepted' }], outcome: evidence };
    const input = { ...context, requests: [{ ...request, state: 'ended', exitCode: 0 }] };
    expect(deriveFleetJourneys({ ...input, runs: [ready] })[0]).toMatchObject({ stage: 'review', status: 'Review not recorded', waiting: true });
    expect(deriveFleetJourneys({ ...input, runs: [{ ...ready, headReview: { state: 'passed' } }] })[0]).toMatchObject({ stage: 'done', status: 'Verified', waiting: false });
    for (const patch of [{ compromisedReceiptIds: ['bad'] }, { unverifiedReceiptIds: ['missing'] }, { evidenceIssues: ['Manifest missing'] }, { outcome: { ...evidence, requiredPassed: 1 } }]) {
      expect(deriveFleetJourneys({ ...input, runs: [{ ...ready, headReview: { state: 'passed' }, ...patch }] })[0]).toMatchObject({ stage: 'checks', status: 'Evidence incomplete', waiting: true });
    }
  });
  it('a repair in progress supersedes a prior review rejection', () => {
    expect(deriveFleetJourneys({ ...context, runs: [{ ...run, headReview: { state: 'changes_requested', headAgentId: 'head' } }] })[0]).toMatchObject({ stage: 'work', active: true, status: 'Working', ownerNames: ['Kara'] });
  });
  it('keeps project identities separate and uses latest duplicate run snapshots', () => {
    const input = { ...context, runs: [{ ...run, projectId: 'other', taskViews: [{ ...task, ownerAgentId: 'qa' }] }, { ...run, updatedAt: '2026-09-13T10:00:00Z' }, { ...run, updatedAt: '2026-09-13T10:01:00Z', taskViews: [{ ...task, state: 'validating' }] }] };
    const rows = deriveFleetJourneys(input);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.requestId === 'request')).toMatchObject({ projectId: 'project', stage: 'checks', ownerNames: ['Kara'] });
    expect(rows.find(row => row.projectId === 'other')).toMatchObject({ requestId: null, ownerNames: ['Scott'] });
  });
});

describe('recorded fleet handoffs', () => {
  const assigned = { projectId: 'project', runId: 'run', taskId: 'task', cursor: 17, timestamp: '2026-09-13T10:00:00Z', type: 'head.assigned', payload: { headAgentId: 'head', agentId: 'frontend', objective: task.objective } };
  it('resolves actual assignment actors, title and request, preferring raw over normalized duplicate', () => {
    const normalized = { id: 'project:17', type: 'head.assigned', label: 'head · assigned', at: assigned.timestamp };
    expect(deriveFleetHandoffs({ ...context, events: [normalized, assigned] })).toEqual([{ id: 'project:17', from: 'Slattery', to: 'Kara', fromAgentId: 'head', toAgentId: 'frontend', label: 'Assigned work', taskTitle: task.objective, at: assigned.timestamp, requestId: 'request', projectId: 'project', runId: 'run' }]);
  });
  it('does not turn task registration, output prose, unknown actors, or missing senders into communication', () => {
    expect(deriveFleetHandoffs({ ...context, events: [
      { ...assigned, type: 'task.registered' },
      { ...assigned, cursor: 18, type: 'runtime.output', from: { kind: 'agent', id: 'head' }, to: { kind: 'agent', id: 'frontend' }, label: 'I sent a message' },
      { ...assigned, cursor: 19, payload: { headAgentId: 'unknown', agentId: 'frontend' } },
      { ...assigned, cursor: 20, type: 'coordination.delivery_failed', payload: { messageId: 'm', recipientTaskId: 'task' } },
    ] })).toEqual([]);
  });
  it('distinguishes a failed delivery from a message actually reaching a peer', () => {
    const events = [{ ...assigned, type: 'coordination.delivery_failed', payload: { senderTaskId: 'task', recipientTaskId: 'qa-task' } }];
    expect(deriveFleetHandoffs({ ...context, runs: [{ ...run, taskViews: [task, { id: 'qa-task', ownerAgentId: 'qa' }] }], events })[0]).toMatchObject({ from: 'Kara', to: 'Scott', fromAgentId: 'frontend', toAgentId: 'qa', label: 'Message not delivered' });
  });
  it('reports coordinator review handoffs without pretending the worker talked to the reviewer', () => {
    expect(deriveFleetHandoffs({ ...context, events: [{ ...assigned, type: 'head.review_started', payload: { headAgentId: 'head' } }] })[0]).toMatchObject({ from: 'Coordinator', to: 'Slattery', toAgentId: 'head', label: 'Requested candidate review' });
  });
  it('deduplicates a paged historical event with the same SSE sequence and keeps the cursor identity', () => {
    const event = { ...assigned, sequence: 4 };
    const { cursor: _cursor, projectId: _projectId, runId: _runId, ...pageRow } = event;
    const input = { ...context, eventPages: [{ projectId: 'project', runId: 'run', events: [pageRow] }], events: [event, { id: 'project:17', type: 'head.assigned' }] };
    expect(deriveFleetHandoffs(input)).toHaveLength(1);
    expect(deriveFleetHandoffs(input)[0]).toMatchObject({ id: 'project:17', from: 'Slattery', to: 'Kara' });
  });
  it('shows planning lifecycle without calling interrupted planning a returned plan', () => {
    expect(deriveFleetHandoffs({ ...context, eventPages: [{ projectId: 'project', runId: 'run', events: [
      { sequence: 1, type: 'head.planning_started', payload: { headAgentId: 'head' } },
      { sequence: 2, type: 'head.planning_finished', payload: { headAgentId: 'head', outcome: 'interrupted' } },
    ] }] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'Coordinator', to: 'Slattery', label: 'Started planning the request' }),
      expect.objectContaining({ from: 'Slattery', to: 'Coordinator', label: 'Planning stopped' }),
    ]));
  });
  it('uses durable peer message states, never treating pending delivery as acknowledged', () => {
    const base = { id: 'message', runId: 'run', type: 'peer_message', senderTaskId: 'task', recipientTaskId: 'qa-task', subject: 'Search contract', createdAt: '2026-09-13T10:00:00Z' };
    for (const [deliveryState, label] of [['recorded', 'Message recorded'], ['submitted', 'Message awaiting delivery'], ['acknowledged', 'Message acknowledged'], ['expired', 'Message not delivered'], ['rejected', 'Message rejected']]) {
      const runs = [{ ...run, taskViews: [task, { id: 'qa-task', ownerAgentId: 'qa' }], messages: [{ ...base, deliveryState }] }];
      expect(deriveFleetHandoffs({ ...context, runs })[0]).toMatchObject({ from: 'Kara', to: 'Scott', fromAgentId: 'frontend', toAgentId: 'qa', label, taskTitle: 'Search contract' });
    }
    const badMessages = [{ ...base, deliveryState: 'acknowledged', senderTaskId: 'unknown' }, { ...base, deliveryState: 'acknowledged', runId: 'another-run' }, { ...base, deliveryState: 'made-up' }];
    expect(deriveFleetHandoffs({ ...context, runs: [{ ...run, messages: badMessages }] })).toEqual([]);
  });
  it('keeps a message receipt authoritative over a duplicate delivery event', () => {
    const runs = [{ ...run, messages: [{ id: 'm', runId: 'run', type: 'peer_message', senderTaskId: 'task', recipientTaskId: null, deliveryState: 'submitted', createdAt: assigned.timestamp }] }];
    const events = [{ ...assigned, type: 'coordination.delivery_failed', payload: { messageId: 'm', senderTaskId: 'task', recipientTaskId: null } }];
    expect(deriveFleetHandoffs({ ...context, runs, events })).toEqual([expect.objectContaining({ from: 'Kara', to: 'Coordinator', label: 'Message awaiting delivery' })]);
  });
  it('keeps handoffs newest first, deduplicated and bounded', () => {
    const events = Array.from({ length: 40 }, (_, index) => ({ ...assigned, cursor: index, timestamp: new Date(Date.UTC(2026, 8, 13, 10, index)).toISOString() }));
    const rows = deriveFleetHandoffs({ ...context, events: [...events, ...events] });
    expect(rows).toHaveLength(24);
    expect(rows[0]?.id).toBe('project:39');
    expect(rows.at(-1)?.id).toBe('project:16');
  });
});


describe('read-only message preview through the run detail endpoint', () => {
  it('exposes durable delivery identities and redacted subjects without exporting bodies or changing messages', async () => {
    const state = openTempState();
    const db = state.store.db;
    const run = seedRun(db), sender = seedTask(db, run.id), recipient = seedTask(db, run.id), attempt = seedAttempt(db, sender.id);
    const { message } = recordMessage(db, { sender: { runId: run.id, taskId: sender.id, attemptId: attempt.id }, recipientTaskId: recipient.id, type: 'peer_message', body: { subject: 'Search API_TOKEN=private-preview-value', text: 'Body stays private', extra: { secret: 'another-private-value' } } });
    submitMessage(db, message.id);
    const before = findMessage(db, message.id);
    const server = await startOfficeServer({ stateRoot: state.root, port: 0, discover: async () => [] });
    try {
      const response = await rawRequest(server, { path: `/api/runs/${run.id}` });
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body) as { messages: Array<Record<string, unknown>>; messageCount: number; messagesTruncated: boolean };
      expect(payload).toMatchObject({ messageCount: 1, messagesTruncated: false });
      expect(payload.messages).toEqual([{ id: message.id, runId: run.id, senderTaskId: sender.id, recipientTaskId: recipient.id, type: 'peer_message', deliveryState: 'submitted', createdAt: message.createdAt, submittedAt: before?.submittedAt, acknowledgedAt: null, subject: 'Search API_TOKEN=[REDACTED]' }]);
      for (const omitted of ['private-preview-value', 'Body stays private', 'another-private-value', 'body_json']) expect(response.body).not.toContain(omitted);
      expect(findMessage(db, message.id)).toEqual(before);
    } finally { await server.close(); state.cleanup(); }
  });
  it('returns the latest hundred messages, reports truncation and excludes other runs', () => {
    const state = openTempState(), db = state.store.db;
    try {
      const run = seedRun(db), otherRun = seedRun(db);
      const messages = Array.from({ length: 105 }, (_, index) => recordMessage(db, { sender: { runId: run.id, taskId: null, attemptId: null }, type: 'peer_message', idempotencyKey: `message-${index}`, body: { subject: index === 0 ? 'old but newly acknowledged' : 'x'.repeat(200) }, now: new Date(Date.UTC(2026, 8, 13, 10, 0, index)).toISOString() }).message);
      submitMessage(db, messages[0]!.id, '2026-09-13T11:00:00Z');
      acknowledge(db, messages[0]!.id, '2026-09-13T11:01:00Z');
      recordMessage(db, { sender: { runId: otherRun.id, taskId: null, attemptId: null }, type: 'peer_message', body: { subject: 'Another run' } });
      const result = commandStatus({ positionals: [run.id], stateDir: state.root, json: true });
      const data = result.data as { messages: Array<Record<string, unknown>>; messageCount: number; messagesTruncated: boolean };
      expect(data.messages).toHaveLength(100);
      expect(data).toMatchObject({ messageCount: 105, messagesTruncated: true });
      expect(data.messages[0]).toMatchObject({ id: messages[0]!.id, deliveryState: 'acknowledged' });
      expect(data.messages[1]?.id).toBe(messages.at(-1)?.id);
      expect(data.messages.every(message => message.runId === run.id)).toBe(true);
      expect(data.messages.slice(1).every(message => String(message.subject).length === 160)).toBe(true);
    } finally { state.cleanup(); }
  });
});
