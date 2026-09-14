import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IssueRecordSchema, type IssueRecord } from '../../src/issues/contracts.js';
import { selectIssueRequest } from '../../src/issues/request-lineage.js';
import { RequestItemSchema, type RequestItem } from '../../src/server/requests.js';

const at = '2026-09-14T08:00:00.000Z';
const attachmentId = '11111111-1111-4111-8111-111111111111';

/** Full schema-checked durable queue receipts, with no process or host state. */
function fakeRequest(overrides: Partial<RequestItem> = {}): RequestItem {
  return RequestItemSchema.parse({
    id: randomUUID(), clientRequestId: `submission:${randomUUID()}`, kind: 'request',
    projectId: 'project-a', departmentId: 'engineering', task: 'Preserve this exact PRD.\n\nRequirements and acceptance checks.',
    submittedDepartmentId: null, submittedControlCenter: { runtime: 'codex-local', model: 'model-a', effort: 'high' },
    submittedWorkKind: 'implementation', mode: 'delegate', workKind: 'implementation', priorRequestId: 'prior-context',
    conversation: [{ requestId: 'prior-context', task: 'Existing scope', reply: 'Recorded context.', state: 'ended', runId: null, truncated: false }],
    submittedAttachmentIds: [attachmentId], attachments: [{ id: attachmentId, name: 'requirements.txt', mimeType: 'text/plain', size: 42 }],
    controlCenter: { runtime: 'codex-local', model: 'model-a', effort: 'high', instructions: 'Preserve project context.' },
    controlRuntime: { adapter: 'codex', executable: '/fixture/codex', model: 'model-a', effort: 'high' },
    approvedRosterHash: 'sha256:frozen-roster',
    resumeRunId: null, allowUnconfinedWrites: false, state: 'failed_to_start', reason: 'Temporary provider failure.',
    receivedAt: at, startedAt: null, endedAt: at, heldAt: null, agentIds: [], workerIds: [], exclusive: false,
    unconfinedRuntimes: [], launchId: null, pid: null, pidStartedAtMs: null, stdoutPath: null, stderrPath: null,
    runId: null, stopRequestedAt: null, exitCode: 4, signal: null,
    result: { exitCode: 4, code: 'provider_unavailable', message: 'Temporary provider failure.', details: [] },
    ...overrides,
  });
}

function retry(parent: RequestItem, overrides: Partial<RequestItem> = {}): RequestItem {
  const runId = parent.runId ?? parent.resumeRunId;
  return fakeRequest({
    ...structuredClone(parent), id: randomUUID(), clientRequestId: `retry:${parent.id}`,
    kind: runId ? 'resume' : 'request', departmentId: null,
    retryOfRequestId: parent.id, retryRootRequestId: parent.retryRootRequestId ?? parent.id,
    retryAttempt: (parent.retryAttempt ?? 0) + 1, retryReason: 'manual',
    ...(runId ? { retryFailed: true } : {}), resumeRunId: runId, runId,
    state: 'queued', reason: 'Waiting to retry.', startedAt: null, endedAt: null,
    exitCode: null, signal: null, result: null, stopRequestedAt: null, ...overrides,
  });
}

function submitted(original: RequestItem, tip: RequestItem | null = null): IssueRecord {
  return IssueRecordSchema.parse({
    schemaVersion: 1, id: randomUUID(), projectId: original.projectId, revision: 2,
    title: 'Issue retry fixture', description: '', kind: 'prd', source: 'codex', manualStatus: 'todo', priority: 'high',
    createdAt: at, updatedAt: at, completedAt: null,
    dispatch: { clientRequestId: original.clientRequestId, task: original.task, allowUnconfinedWrites: original.allowUnconfinedWrites,
      startedAt: at, state: 'submitted', request: original, retryRequest: tip, error: null },
  });
}

describe('issue request retry lineage', () => {
  it('uses the exact original receipt, without attaching unrelated submissions or requiring live queue retention', () => {
    const original = fakeRequest();
    const issue = submitted(original);
    expect(selectIssueRequest(issue, [])).toEqual({ original, current: original, live: null, conflict: null });
    const liveOriginal = fakeRequest({ ...original, state: 'ended' });
    const unrelated = fakeRequest({ task: original.task });
    const result = selectIssueRequest(issue, [unrelated, liveOriginal]);
    expect(result.original?.id).toBe(original.id);
    expect(result.current).toEqual(liveOriginal);
    expect(result.live).toEqual(liveOriginal);
    expect(result.conflict).toBeNull();
  });

  it('leaves an unsubmitted issue without request or retry metadata', () => {
    const original = fakeRequest();
    const issue = { ...submitted(original), dispatch: null };
    expect(selectIssueRequest(issue, [original, retry(original)])).toEqual({ original: null, current: null, live: null, conflict: null });
  });

  it('follows a legitimate multi-attempt chain independent of queue ordering and never rewrites the original receipt', () => {
    const original = fakeRequest();
    const first = retry(original, { state: 'ended', exitCode: 4, endedAt: at });
    const second = retry(first, { state: 'running', pid: 4321, pidStartedAtMs: 1 });
    const issue = submitted(original);
    const before = structuredClone(issue);
    const result = selectIssueRequest(issue, [second, original, first]);
    expect(result).toMatchObject({ original: { id: original.id }, current: { id: second.id, retryAttempt: 2 }, live: { id: second.id }, conflict: null });
    expect(issue).toEqual(before);
  });

  it('requires same-run failed resumes once a predecessor has a run', () => {
    const runId = randomUUID();
    const original = fakeRequest({ state: 'ended', runId });
    const valid = retry(original, { state: 'running' });
    expect(selectIssueRequest(submitted(original), [original, valid])).toMatchObject({ current: { id: valid.id }, live: { id: valid.id }, conflict: null });
    for (const changed of [
      { kind: 'request' as const }, { retryFailed: false }, { resumeRunId: randomUUID() }, { runId: randomUUID() },
    ]) {
      const invalid = fakeRequest({ ...valid, ...changed });
      expect(selectIssueRequest(submitted(original), [original, invalid]).current?.id).toBe(original.id);
    }
    const provisional = fakeRequest({ ...valid, runId: null });
    expect(selectIssueRequest(submitted(original), [original, provisional]).current?.id).toBe(provisional.id);
  });

  it('rejects unrelated project, changed task, forged root, wrong predecessor and skipped attempt links', () => {
    const original = fakeRequest(), valid = retry(original);
    for (const changed of [
      { projectId: 'project-b' }, { task: `${original.task}\nDifferent requirement.` },
      { retryRootRequestId: 'forged-root' }, { retryOfRequestId: 'unrelated-parent' }, { retryAttempt: 3 }, { retryAttempt: 0 },
    ]) {
      const candidate = fakeRequest({ ...valid, ...changed });
      expect(selectIssueRequest(submitted(original), [original, candidate]).current?.id).toBe(original.id);
    }
    const { retryRootRequestId: _root, ...missingRoot } = valid;
    const { retryAttempt: _attempt, ...missingAttempt } = valid;
    for (const candidate of [fakeRequest(missingRoot), fakeRequest(missingAttempt)]) {
      expect(selectIssueRequest(submitted(original), [original, candidate]).current?.id).toBe(original.id);
    }
  });

  it('does not replace the original receipt with a same-key record for another project or task', () => {
    const original = fakeRequest(), issue = submitted(original);
    for (const changed of [{ projectId: 'project-b' }, { task: 'Forged replacement brief' }]) {
      const impostor = fakeRequest({ ...original, ...changed });
      const result = selectIssueRequest(issue, [impostor]);
      expect(result.current?.task).toBe(original.task);
      expect(result.current?.projectId).toBe(original.projectId);
      expect(result.live).toBeNull();
    }
  });

  it('refuses successors to active, stopped, discarded, cancelled, or successful no-run predecessors', () => {
    const original = fakeRequest();
    for (const changed of [
      { state: 'queued' as const }, { state: 'held' as const }, { state: 'starting' as const }, { state: 'running' as const },
      { state: 'discarded' as const }, { stopRequestedAt: at }, { exitCode: 130 }, { signal: 'SIGINT' },
      { state: 'ended' as const, exitCode: 0 },
      { routingSession: { sessionId: 'still-owned', process: null, state: 'running' as const } },
      { routingSession: { sessionId: 'uncertain', process: null, state: 'unknown' as const } },
    ]) {
      const parent = fakeRequest({ ...original, ...changed });
      const candidate = retry(parent);
      expect(selectIssueRequest(submitted(parent), [parent, candidate]).current?.id).toBe(parent.id);
    }
  });

  it('preserves frozen no-run inputs and original uploaded context across retry edges', () => {
    const original = fakeRequest(), valid = retry(original);
    const mutations: Partial<RequestItem>[] = [
      { mode: 'discuss' }, { workKind: 'analysis' }, { submittedWorkKind: 'analysis' }, { submittedDepartmentId: 'another-department' },
      { submittedControlCenter: { runtime: 'claude-local' } },
      { controlCenter: { ...original.controlCenter!, instructions: 'Different task authority.' } },
      { controlRuntime: { ...original.controlRuntime!, executable: '/different/codex' } },
      { approvedRosterHash: 'sha256:changed-roster' }, { priorRequestId: 'different-conversation' }, { conversation: [] },
      { submittedAttachmentIds: [] }, { attachments: [] },
      { attachments: [{ ...original.attachments![0]!, name: 'different.txt' }] },
    ];
    for (const changed of mutations) {
      const candidate = fakeRequest({ ...valid, ...changed });
      expect(selectIssueRequest(submitted(original), [original, candidate]).current?.id).toBe(original.id);
    }
    const consent = fakeRequest({ ...valid, allowUnconfinedWrites: true });
    expect(selectIssueRequest(submitted(original), [original, consent]).current?.id).toBe(consent.id);
  });

  it('allows later derived metadata when it did not exist on the no-run predecessor', () => {
    const full = fakeRequest();
    const { approvedRosterHash: _roster, workKind: _kind, ...unresolved } = full;
    const original = fakeRequest(unresolved);
    // fakeRequest supplies useful defaults, so omit derived fields explicitly
    // after constructing and validate the exact old receipt again.
    delete original.approvedRosterHash;
    delete original.workKind;
    const candidate = retry(original, { approvedRosterHash: 'sha256:newly-admitted', workKind: 'implementation' });
    expect(selectIssueRequest(submitted(original), [original, candidate]).current?.id).toBe(candidate.id);
  });

  it('does not require transient intake settings on run resumes, while keeping exact attachments', () => {
    const original = fakeRequest({ state: 'ended', runId: randomUUID() });
    const full = retry(original);
    const { mode: _mode, workKind: _kind, controlCenter: _center, controlRuntime: _runtime, submittedControlCenter: _selection, ...savedRunResume } = full;
    const candidate = RequestItemSchema.parse(savedRunResume);
    expect(selectIssueRequest(submitted(original), [original, candidate]).current?.id).toBe(candidate.id);
    const changedFiles = fakeRequest({ ...candidate, attachments: [] });
    expect(selectIssueRequest(submitted(original), [original, changedFiles]).current?.id).toBe(original.id);
  });

  it('reports ambiguous direct branches instead of selecting whichever request sorts first', () => {
    const original = fakeRequest(), first = retry(original), second = retry(original, { clientRequestId: 'another-retry-key' });
    for (const requests of [[original, first, second], [second, first, original]]) {
      const result = selectIssueRequest(submitted(original), requests);
      expect(result.conflict).toEqual(expect.any(String));
      expect(result.conflict?.length).toBeGreaterThan(0);
      expect(result.current?.id).toBe(original.id);
    }
  });

  it('detects root siblings after a tip was saved, including when that tip has been pruned from the queue', () => {
    const original = fakeRequest();
    const tip = retry(original);
    const sibling = retry(original, { clientRequestId: 'competing-root-retry' });
    const issue = submitted(original, tip);
    for (const requests of [[original, tip, sibling], [sibling, tip, original], [original, sibling], [sibling]]) {
      const result = selectIssueRequest(issue, requests);
      expect(result.original?.id).toBe(original.id);
      expect(result.current?.id).toBe(tip.id);
      expect(result.conflict).toEqual(expect.any(String));
      expect(result.conflict?.length).toBeGreaterThan(0);
    }
  });

  it('detects a branch at a retained intermediate ancestor before the saved tip', () => {
    const original = fakeRequest();
    const first = retry(original, { state: 'ended', exitCode: 4, endedAt: at });
    const second = retry(first, { state: 'ended', exitCode: 4, endedAt: at });
    const tip = retry(second);
    const sibling = retry(first, { clientRequestId: 'competing-intermediate-retry' });
    const issue = submitted(original, tip);
    for (const requests of [
      [original, first, second, tip, sibling],
      [sibling, tip, second, first],
      [first, sibling],
    ]) {
      const result = selectIssueRequest(issue, requests);
      expect(result.current?.id).toBe(tip.id);
      expect(result.conflict).toEqual(expect.any(String));
      expect(result.conflict?.length).toBeGreaterThan(0);
    }
    // A saved tip remains usable when retained ancestors contain only its
    // previously validated chain, even if the tip's own receipt was pruned.
    expect(selectIssueRequest(issue, [original, first, second])).toMatchObject({
      original: { id: original.id }, current: { id: tip.id }, live: null, conflict: null,
    });
  });

  it('preserves a recorded retry conflict after every queue receipt was pruned', () => {
    const original = fakeRequest();
    const tip = retry(original, { state: 'ended', exitCode: 0, runId: randomUUID() });
    const issue = submitted(original, tip);
    issue.dispatch!.retryConflict = 'Two retained retries claimed the same issue request.';
    const before = structuredClone(issue);
    for (const requests of [[], [original, tip]]) {
      expect(selectIssueRequest(issue, requests)).toEqual({
        original, current: tip, live: null, conflict: issue.dispatch!.retryConflict,
      });
    }
    expect(issue).toEqual(before);
  });

  it('refreshes a saved tip when its exact receipt acquires an admitted run', () => {
    const original = fakeRequest();
    const tip = retry(original);
    const fresh = fakeRequest({ ...tip, runId: randomUUID(), state: 'running', pid: 4321, pidStartedAtMs: 1 });
    const issue = submitted(original, tip);
    expect(selectIssueRequest(issue, [original, fresh])).toEqual({ original, current: fresh, live: fresh, conflict: null });
    expect(issue.dispatch?.retryRequest?.runId).toBeNull();
  });

  it('uses a persisted validated tip to follow the next edge after intermediate queue receipts were pruned', () => {
    const original = fakeRequest();
    const first = retry(original, { state: 'ended', exitCode: 4 });
    const tip = retry(first, { state: 'ended', exitCode: 4 });
    const issue = submitted(original, tip);
    expect(selectIssueRequest(issue, [])).toMatchObject({ original: { id: original.id }, current: { id: tip.id }, live: null, conflict: null });
    const next = retry(tip, { state: 'running' });
    expect(selectIssueRequest(issue, [next])).toMatchObject({ original: { id: original.id }, current: { id: next.id, retryAttempt: 3 }, live: { id: next.id }, conflict: null });
    expect(issue.dispatch?.request?.id).toBe(original.id);
    expect(issue.dispatch?.retryRequest?.id).toBe(tip.id);
  });

  it('does not attach a forged persisted tip from another project, task or retry root', () => {
    const original = fakeRequest(), valid = retry(original, { state: 'ended', exitCode: 4 });
    for (const changed of [{ projectId: 'project-b' }, { task: 'Different task' }, { retryRootRequestId: 'other-root' }]) {
      const tip = fakeRequest({ ...valid, ...changed });
      const result = selectIssueRequest(submitted(original, tip), []);
      expect(result.current?.id).not.toBe(tip.id);
    }
  });

  it('defaults older issue records to an absent retry tip without losing the root receipt', () => {
    const original = fakeRequest(), full = submitted(original);
    const { retryRequest: _tip, retryConflict: _conflict, ...olderDispatch } = full.dispatch!;
    const issue = IssueRecordSchema.parse({ ...full, dispatch: olderDispatch });
    expect(issue.dispatch?.retryRequest).toBeNull();
    expect(issue.dispatch?.retryConflict).toBeNull();
    expect(selectIssueRequest(issue, []).current?.id).toBe(original.id);
  });
});
