import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS, attachmentDescriptors, attachmentSelectionError, formatAttachmentSize, persistDraftAttachments, restoreDraftAttachments, consentRetryAttachmentIds } from '../../web/claude-office/src/attachment-model.js';
import { controlCenterSubmission, controlSubmissionFingerprint, conversationEntries } from '../../web/claude-office/src/chat-model.js';
import { renderUserMessage } from '../../web/claude-office/src/chat-presentation.js';
import { uploadAttachments } from '../../web/workspace/src/api.js';

const workspace = JSON.parse(readFileSync(new URL('../workspace-ui/fixtures/workspace.json', import.meta.url), 'utf8'));
const file = (id = 'image-id', changes = {}) => ({ id, name: 'screen.png', mimeType: 'image/png', size: 2048, ...changes });
const draft = (changes = {}) => ({ key: 'local-key', ...file(), status: 'ready', ...changes });
afterEach(() => { vi.unstubAllGlobals(); });

describe('attachment limits and durable drafts', () => {
  it('enforces the per-message count across separate upload batches', () => {
    expect(attachmentSelectionError([file()], Array.from({ length: 7 }, () => file()))).toBe('');
    expect(attachmentSelectionError([file()], Array.from({ length: 8 }, () => file()))).toContain('up to 8');
  });

  it('checks each selected file and the decoded aggregate including previously uploaded files', () => {
    expect(attachmentSelectionError([file('a', { name: 'brief.pdf', mimeType: 'application/pdf', size: ATTACHMENT_LIMITS.fileBytes })])).toBe('');
    expect(attachmentSelectionError([file('a', { name: 'large.pdf', mimeType: 'application/pdf', size: ATTACHMENT_LIMITS.fileBytes + 1 })])).toContain('large.pdf exceeds the 10 MB');
    const previous = [file('a', { name: 'a.pdf', mimeType: 'application/pdf', size: 10 * 1024 * 1024 }), file('b', { name: 'b.pdf', mimeType: 'application/pdf', size: 10 * 1024 * 1024 })];
    expect(attachmentSelectionError([file('c', { size: 5 * 1024 * 1024 })], previous)).toBe('');
    expect(attachmentSelectionError([file('c', { name: 'c.pdf', mimeType: 'application/pdf', size: 5 * 1024 * 1024 + 1 })], previous)).toContain('total up to 25 MB');
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('allows exactly 5 MiB for native %s input and rejects one more byte', type => {
    const image = { name: 'selected-image', type, size: ATTACHMENT_LIMITS.imageBytes };
    expect(attachmentSelectionError([image])).toBe('');
    expect(attachmentSelectionError([{ ...image, size: ATTACHMENT_LIMITS.imageBytes + 1 }])).toContain('5 MB image limit');
  });

  it('applies the native-image limit when the file picker omits MIME metadata', () => {
    expect(attachmentSelectionError([{ name: 'screenshot.PNG', type: '', size: ATTACHMENT_LIMITS.imageBytes + 1 }])).toContain('5 MB image limit');
    expect(attachmentSelectionError([{ name: 'notes.txt', type: 'text/plain', size: ATTACHMENT_LIMITS.fileBytes }])).toBe('');
  });

  it('stores only bounded metadata and restores completed uploads without retaining File bytes or client paths', () => {
    const rows = [draft({ file: { bytes: 'sensitive file contents' }, data: 'base64', path: '/private/client/path' })];
    const saved = persistDraftAttachments(rows);
    expect(JSON.stringify(saved)).not.toMatch(/sensitive|base64|private|bytes/);
    expect(restoreDraftAttachments(saved)).toEqual([draft()]);
    expect(attachmentDescriptors([{ ...file(), mimeType: '', path: '/ignore', data: 'ignore' }, null, { id: 'missing-name' }])).toEqual([file('image-id', { mimeType: 'application/octet-stream' })]);
  });

  it('marks unfinished reloads as failed instead of showing an uploaded file that the server never acknowledged', () => {
    for (const status of ['uploading', 'error']) {
      const [restored] = restoreDraftAttachments([draft({ status, id: undefined })]);
      expect(restored.status).toBe('error');
      expect(restored.id).toBeUndefined();
      expect(restored.error).toContain('choose it again');
    }
    expect(restoreDraftAttachments('corrupted local storage')).toEqual([]);
    expect(restoreDraftAttachments([null, 5, [], {}, draft()])).toEqual([draft()]);
  });

  it('formats small and large actual byte counts without fake upload percentages', () => {
    expect(formatAttachmentSize(0)).toBe('0 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatAttachmentSize(Number.NaN)).toBe('');
  });
});

describe('attachments remain part of the original request', () => {
  it('passes opaque uploaded IDs along with the selected orchestrator without forwarding local files', () => {
    const payload = controlCenterSubmission({ text: 'Compare these designs', projectId: 'app', clientRequestId: 'one-send', attachmentIds: ['first', 'second'], attachments: [{ path: '/do-not-forward' }], controlCenter: { runtime: 'fake-local' } }, workspace);
    expect(payload.attachmentIds).toEqual(['first', 'second']);
    expect(payload.task).toBe('Compare these designs');
    expect(payload.clientRequestId).toBe('one-send');
    expect(payload.controlCenter).toEqual({ runtime: 'fake-local' });
    expect(payload).not.toHaveProperty('attachments');
  });

  it('requires a typed message and valid distinct IDs before sending files', () => {
    expect(() => controlCenterSubmission({ text: '', projectId: 'app', attachmentIds: ['file'] }, workspace)).toThrow(/Describe the task/);
    for (const attachmentIds of [null, 'file', [''], ['same', 'same'], [2], Array.from({ length: 9 }, (_, index) => `id-${index}`)]) {
      expect(() => controlCenterSubmission({ text: 'Inspect', projectId: 'app', attachmentIds }, workspace)).toThrow(/uploaded files/);
    }
    expect(controlCenterSubmission({ text: 'No files', projectId: 'app', attachmentIds: [] }, workspace)).not.toHaveProperty('attachmentIds');
  });

  it('keeps retries stable while changing identity when a file is added, removed, replaced, or reordered', () => {
    const base = { text: 'Inspect', projectId: 'app', attachmentIds: ['one', 'two'] };
    const original = controlSubmissionFingerprint(base);
    expect(controlSubmissionFingerprint({ ...base, attachmentIds: ['one', 'two'] })).toBe(original);
    for (const attachmentIds of [[], ['one'], ['one', 'three'], ['two', 'one'], ['one', 'two', 'three']]) expect(controlSubmissionFingerprint({ ...base, attachmentIds })).not.toBe(original);
    expect(controlSubmissionFingerprint({ text: 'Inspect', projectId: 'app' })).toBe(controlSubmissionFingerprint({ text: 'Inspect', projectId: 'app', attachmentIds: [] }));
  });

  it('freezes consent retries to receipt attachments and then the exact prior HTTP retry', () => {
    const request = { attachments: [file('original')] };
    const saved = { attachments: [file('different-draft')] };
    expect(consentRetryAttachmentIds(request, saved)).toEqual(['original']);
    expect(consentRetryAttachmentIds({ attachmentIds: ['legacy'] }, saved)).toEqual(['legacy']);
    expect(consentRetryAttachmentIds({}, saved)).toEqual(['different-draft']);
    expect(consentRetryAttachmentIds(request, saved, { id: 'same-attempt', attachmentIds: ['already-sent'] })).toEqual(['already-sent']);
    expect(consentRetryAttachmentIds(request, saved, { id: 'same-attempt', attachmentIds: [] })).toEqual([]);
  });

  it('restores sent file names from durable history and prefers the server over local metadata', () => {
    const task = { id: 'q:one', requestId: 'one', entry: { item: { task: 'Inspect', attachments: [file('receipt', { name: 'normalized.png' })] } } };
    expect(conversationEntries([], [task])[0].attachments).toEqual([file('receipt', { name: 'normalized.png' })]);
    const messages = [{ requestId: 'one', text: 'Inspect', attachments: [file('local', { name: 'local.png' })] }];
    expect(conversationEntries(messages, [task])[0].attachments[0].id).toBe('receipt');
    expect(conversationEntries(messages, [{ ...task, entry: { item: { task: 'Inspect' } } }])[0].attachments[0].id).toBe('local');
    expect(conversationEntries(messages, [{ ...task, entry: { item: { task: 'Inspect', attachments: [] } } }])[0].attachments).toEqual([]);
  });

  it('shows every attached name outside long-prompt disclosures and escapes untrusted filenames/MIME', () => {
    const html = renderUserMessage({ id: 'one', text: 'A long request. '.repeat(80), attachments: [file('a', { name: '<img src=x onerror=alert(1)>.png', mimeType: 'image/" onmouseover="bad' }), file('b', { name: 'notes.txt', mimeType: 'text/plain' })] });
    expect(html.indexOf('chat-sent-attachments')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
    expect(html).toContain('image/&quot; onmouseover=&quot;bad');
    expect(html).toContain('notes.txt');
    expect(html).toContain('2.0 KB');
    expect(html).not.toMatch(/<(?:img|script|a)\b/);
  });
});

describe('native file upload encoding', () => {
  it('posts multiple files atomically with token protection and preserves large binary/image bytes', async () => {
    const bytes = new Uint8Array(256 * 1024).map((_, index) => index % 256);
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'page-token' }) });
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, attachments: [file('one'), file('two')] }) }));
    vi.stubGlobal('fetch', fetch);
    const uploaded = await uploadAttachments([{ name: 'binary.png', type: 'image/png', arrayBuffer: async () => bytes.buffer }, { name: 'plain.txt', type: '', arrayBuffer: async () => new TextEncoder().encode('Hello café').buffer }]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/attachments');
    expect(options.headers['x-workforce-token']).toBe('page-token');
    const body = JSON.parse(options.body);
    expect(body.files).toHaveLength(2);
    expect(Buffer.from(body.files[0].data, 'base64')).toEqual(Buffer.from(bytes));
    expect(body.files[0]).toMatchObject({ name: 'binary.png', mimeType: 'image/png' });
    expect(body.files[1].mimeType).toBe('application/octet-stream');
    expect(Buffer.from(body.files[1].data, 'base64').toString()).toBe('Hello café');
    expect(uploaded.attachments).toHaveLength(2);
  });

  it('does not POST a partial batch when a selected file cannot be read', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(uploadAttachments([{ name: 'ok', arrayBuffer: async () => new Uint8Array([1]).buffer }, { name: 'denied', arrayBuffer: async () => { throw new Error('The selected file is no longer readable.'); } }])).rejects.toThrow(/no longer readable/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
