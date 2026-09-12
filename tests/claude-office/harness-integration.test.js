import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatRoute, conversationEntries, readChatState, submissionPayload } from '../../web/claude-office/src/chat-model.js';
import { applyLiveDocuments } from '../../web/claude-office/src/live-data.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../workspace-ui/fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('harness chat routing and recovery', () => {
  it('keeps an explicitly selected unavailable team instead of silently using an eligible team', () => {
    const document = fixture('workspace');
    const route = chatRoute(document, { departmentId: 'eng', projectId: 'app' }, 'design');
    expect(route.departmentId).toBe('design');
    expect(route.head.id).toBe('vera');
    expect(route.sendable).toBe(false);
    expect(route.blockers.join(' ')).toMatch(/signed out/);
    expect(() => submissionPayload({ text: 'Fix this issue', projectId: 'app', departmentId: 'design', allowUnconfinedWrites: true }, document)).toThrow(/signed out/);
  });

  it('requires both an eligible project roster and explicit consent for an unconfined route', () => {
    const document = fixture('workspace');
    expect(() => submissionPayload({ text: 'Fix this issue', projectId: 'notes', departmentId: 'eng', allowUnconfinedWrites: true }, document)).toThrow(/no checks|Nobody/);
    expect(() => submissionPayload({ text: 'Fix this issue', projectId: 'app', departmentId: 'eng' }, document)).toThrow(/file boundary/);
    const payload = submissionPayload({ text: 'Fix this issue', projectId: 'app', departmentId: 'eng', allowUnconfinedWrites: true, clientRequestId: 'durable-retry-1' }, document);
    expect(payload).toEqual({ task: 'Fix this issue', projectId: 'app', departmentId: 'eng', allowUnconfinedWrites: true, clientRequestId: 'durable-retry-1' });
  });

  it('respects a server-required consent even when the adapter has a verified boundary on another version', () => {
    const document = fixture('workspace');
    document.runtimeRules['fake-local'] = { writeContainment: 'verified', requiresWriteConsent: true, installedVersion: 'new', testedVersion: 'previous' };
    expect(chatRoute(document, { projectId: 'app', departmentId: 'eng' }).unconfined).toBe(true);
    expect(() => submissionPayload({ text: 'Fix this issue', projectId: 'app', departmentId: 'eng' }, document)).toThrow(/file boundary/);
  });

  it('carries multiline code and markup literally to task intake, retaining the retry identity', () => {
    const document = fixture('workspace');
    const text = 'Investigate the output:\n<script>globalThis.compromised = true</script>\n$(touch /tmp/should-not-run) `echo literal`';
    const context = { text, projectId: 'app', departmentId: 'eng', allowUnconfinedWrites: true, clientRequestId: 'literal-request' };
    expect(submissionPayload(context, document).task).toBe(text);
    expect(submissionPayload(context, document)).toEqual(submissionPayload(context, document));
    expect(globalThis.compromised).toBeUndefined();
  });

  it('restores the complete server-recorded request after browser chat storage is gone', () => {
    const fullText = 'Fix the editor.\nKeep keyboard shortcuts.\nPreserve existing task drafts.';
    const tasks = [{ id: 'q:server-1', requestId: 'server-1', projectId: 'app', departmentId: 'eng', title: 'Fix the editor.', at: '2026-09-12T10:00:00Z', entry: { title: 'Fix the editor.', item: { id: 'server-1', task: fullText } } }];
    expect(conversationEntries([], tasks)[0].text).toBe(fullText);
    const external = { ...tasks[0], id: 'r:app:run-1', requestId: null, entry: { title: 'Fix the editor.', run: { request: { text: fullText } } } };
    expect(conversationEntries([], [external])[0].text).toBe(fullText);
  });

  it('merges a browser receipt with its server task without creating duplicate turns or fake progress', () => {
    const messages = [{ id: 'client-1', requestId: 'server-1', text: 'Full prompt\nSecond line', projectId: 'app', departmentId: 'eng', at: '2026-09-12T10:00:00Z' }];
    const pending = conversationEntries(messages, []);
    expect(pending).toHaveLength(1);
    expect(pending[0].task).toBeUndefined();
    const task = { id: 'q:server-1', requestId: 'server-1', title: 'Full prompt', departmentId: 'eng', at: messages[0].at, stateKey: 'planning' };
    const entries = conversationEntries(messages, [task]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(messages[0].text);
    expect(entries[0].task).toBe(task);
    expect(conversationEntries(messages, [task], 'design')).toEqual([]);
  });

  it('restores independent drafts and their uncertain submission identities without accepting corrupt storage', () => {
    const stored = { version: 1, contexts: { control: { draft: 'Main request', projectId: 'app', submission: { id: 'pending-1', fingerprint: 'unchanged' } }, 'department:eng': { draft: 'Engineering draft' }, 'department:design': { draft: 'Design draft' } }, messages: [{ text: 'A request', requestId: 'receipt-1' }, null, { text: 'Without receipt' }] };
    const storage = { getItem: () => JSON.stringify(stored) };
    const restored = readChatState(storage, 'workspace');
    expect(restored.contexts).toEqual(stored.contexts);
    expect(restored.messages).toEqual([stored.messages[0]]);
    expect(readChatState({ getItem() { throw new Error('Storage disabled'); } }, 'workspace')).toEqual({ version: 1, contexts: {}, messages: [] });
    expect(readChatState({ getItem: () => '{broken' }, 'workspace')).toEqual({ version: 1, contexts: {}, messages: [] });
  });

  it('does not turn a runtime completion claim into a verified task in the office conversation', () => {
    const runs = fixture('runs');
    const requests = fixture('requests');
    const claimed = runs.runs.find(run => run.state === 'ready_for_review');
    for (const task of claimed.taskViews) task.receipts = { verifierExecutedPassed: 0, verifierExecutedCompromised: 0, verifierExecutedFailed: 0, verifierExecutedOther: 0, otherProvenance: 1 };
    claimed.outcome = { accepted: true, reasons: ['The runtime said all checks passed'] };
    const snapshot = applyLiveDocuments(fixture('workspace'), runs, requests);
    const task = snapshot.tasks.find(task => task.runId === claimed.id);
    expect(task.verified).toBe(false);
    expect(task.stateKey).toBe('unverified');
    expect(conversationEntries([], [task])[0].task.verified).toBe(false);
  });
});
