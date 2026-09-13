import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS, resolveAttachments, storeAttachments } from '../../src/server/attachments.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: vi.fn(original.rename) };
});

afterEach(async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rename).mockReset().mockImplementation(original.rename);
  cleanupAll();
});

const upload = (name = 'brief.txt', data = Buffer.from('Original task context'), mimeType = 'text/plain') => ({ name, mimeType, data: data.toString('base64') });
const filesAt = (root: string) => path.join(root, 'serve', 'attachments');

describe('durable uploaded context', () => {
  it('preserves multiple binary/text files and resolves exactly their recorded bytes across calls', async () => {
    const root = tempDir('workforce-upload-');
    const binary = Buffer.from([0, 1, 255, 128, 10]);
    const response = await storeAttachments(root, { files: [upload(), upload('image.bin', binary, 'application/octet-stream'), upload('empty.txt', Buffer.alloc(0))] });
    expect(response.ok).toBe(true);
    expect(response.attachments).toHaveLength(3);
    for (const descriptor of response.attachments) {
      expect(Object.keys(descriptor).sort()).toEqual(['id', 'mimeType', 'name', 'size']);
      expect(descriptor).not.toHaveProperty('path');
    }
    const resolved = await resolveAttachments(root, response.attachments.map(file => file.id));
    expect(resolved.map(file => file.data)).toEqual([Buffer.from('Original task context'), binary, Buffer.alloc(0)]);
    expect(resolved[1]!.sha256).toBe(createHash('sha256').update(binary).digest('hex'));
    const receipt = JSON.parse(await readFile(path.join(filesAt(root), response.attachments[1]!.id, 'receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ schemaVersion: 1, size: binary.length, sha256: resolved[1]!.sha256 });
    expect(await readdir(filesAt(root))).toHaveLength(3);
  });

  it('uses opaque storage names and normalized display basenames for Unix/Windows paths and control characters', async () => {
    const root = tempDir('workforce-upload-path-');
    const response = await storeAttachments(root, { files: [upload('../../somewhere/brief.txt'), upload('C:\\private\\image.png'), upload('../\u202Erun\u0000.sh'), upload('..')] });
    expect(response.attachments.map(file => file.name)).toEqual(['brief.txt', 'image.png', '_run_.sh', 'attachment']);
    const resolved = await resolveAttachments(root, response.attachments.map(file => file.id));
    expect(resolved.every(file => file.path === path.join(filesAt(root), file.id, 'content.bin'))).toBe(true);
    expect(await readdir(root)).toEqual(['serve']);
  });

  it('normalizes MIME claims and supports a file with no browser-reported MIME', async () => {
    const root = tempDir('workforce-upload-mime-');
    const response = await storeAttachments(root, { files: [upload('x.PNG', Buffer.from('x'), ' IMAGE/PNG '), { name: 'unknown', data: '' }] });
    expect(response.attachments.map(file => file.mimeType)).toEqual(['image/png', 'application/octet-stream']);
    // The storage layer preserves bytes; native runtime capability checks decide whether they are a valid image.
    expect((await resolveAttachments(root, [response.attachments[0]!.id]))[0]!.data.toString()).toBe('x');
  });

  it('bounds long Unicode labels without splitting their characters', async () => {
    const root = tempDir('workforce-upload-label-');
    const response = await storeAttachments(root, { files: [upload('\u{1F4C4}'.repeat(200))] });
    expect(response.attachments[0]!.name).toBe('\u{1F4C4}'.repeat(90));
    expect((await resolveAttachments(root, [response.attachments[0]!.id]))[0]!.name).toBe(response.attachments[0]!.name);
  });

  it('publishes concurrent uploads independently even when their display names and bytes match', async () => {
    const root = tempDir('workforce-upload-concurrent-');
    const responses = await Promise.all(Array.from({ length: 3 }, () => storeAttachments(root, { files: [upload()] })));
    const ids = responses.map(response => response.attachments[0]!.id);
    expect(new Set(ids).size).toBe(3);
    expect((await readdir(filesAt(root))).sort()).toEqual([...ids].sort());
    expect((await resolveAttachments(root, ids)).every(file => file.data.equals(Buffer.from('Original task context')))).toBe(true);
  });

  it.each(['Zg', 'Zg=', 'Zg===', 'Z g==', 'Zg==\n', 'data:text/plain;base64,Zg==', 'Zh==', 'Zm9=', '____', '!!!!', '=AAA'])('refuses noncanonical base64 %j before writing anything', async data => {
    const root = tempDir('workforce-upload-invalid-');
    await expect(storeAttachments(root, { files: [upload(), { name: 'bad', data }] })).rejects.toMatchObject({ status: 400, code: 'invalid_attachment' });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    { files: [] },
    { files: Array.from({ length: 9 }, () => upload()) },
    { files: [{ ...upload(), path: '/tmp/escape' }] },
    { files: [upload('bad', Buffer.from('x'), 'text/plain; charset=utf-8')] },
    { files: [upload('bad', Buffer.from('x'), 'text/html\r\nX-Header: bad')] },
  ])('refuses malformed upload shape or MIME before publication', async body => {
    const root = tempDir('workforce-upload-shape-');
    await expect(storeAttachments(root, body)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(root)).toEqual([]);
  });

  it('bounds file and batch sizes by decoded bytes before publication', async () => {
    const root = tempDir('workforce-upload-limit-');
    const large = upload('large', Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1));
    await expect(storeAttachments(root, { files: [large] })).rejects.toMatchObject({ status: 413, code: 'attachment_too_large' });
    const ten = upload('ten', Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes));
    await expect(storeAttachments(root, { files: [ten, ten, ten] })).rejects.toMatchObject({ status: 413, code: 'attachments_too_large' });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a request assembled from individually valid uploads above the total size limit', async () => {
    const root = tempDir('workforce-upload-resolve-limit-');
    const ten = upload('ten', Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes));
    const first = await storeAttachments(root, { files: [ten, ten] });
    const second = await storeAttachments(root, { files: [ten] });
    await expect(resolveAttachments(root, [...first.attachments, ...second.attachments].map(file => file.id))).rejects.toMatchObject({ status: 413, code: 'attachments_too_large' });
  });

  it('cleans a partially published failed batch and preserves older uploads', async () => {
    const root = tempDir('workforce-upload-failure-');
    const previous = await storeAttachments(root, { files: [upload('earlier.txt')] });
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementationOnce(original.rename).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(storeAttachments(root, { files: [upload('first.txt'), upload('second.txt')] })).rejects.toMatchObject({ status: 503, code: 'attachment_storage_unavailable' });
    expect(await readdir(filesAt(root))).toEqual([previous.attachments[0]!.id]);
    expect((await resolveAttachments(root, [previous.attachments[0]!.id]))[0]!.name).toBe('earlier.txt');
  });

  it('refuses duplicate, traversal and missing references without scanning the filesystem', async () => {
    const root = tempDir('workforce-upload-ids-');
    const saved = await storeAttachments(root, { files: [upload()] });
    const id = saved.attachments[0]!.id;
    await expect(resolveAttachments(root, [id, id])).rejects.toMatchObject({ status: 400 });
    await expect(resolveAttachments(root, ['../../etc/passwd'])).rejects.toMatchObject({ status: 400 });
    await expect(resolveAttachments(root, [randomUUID()])).rejects.toMatchObject({ status: 404, code: 'attachment_not_found' });
    expect(await resolveAttachments('/does/not/exist', [])).toEqual([]);
  });

  it('rejects same-size content corruption and a tampered or mismatched receipt', async () => {
    const root = tempDir('workforce-upload-corrupt-');
    const saved = await storeAttachments(root, { files: [upload('first'), upload('second'), upload('third')] });
    const [first, second, third] = saved.attachments;
    const firstFile = path.join(filesAt(root), first!.id, 'content.bin');
    await chmod(firstFile, 0o600);
    await writeFile(firstFile, Buffer.alloc(first!.size));
    await expect(resolveAttachments(root, [first!.id])).rejects.toMatchObject({ status: 409, code: 'attachment_integrity_failed' });
    const secondReceipt = path.join(filesAt(root), second!.id, 'receipt.json');
    await chmod(secondReceipt, 0o600);
    await writeFile(secondReceipt, '{broken');
    await expect(resolveAttachments(root, [second!.id])).rejects.toMatchObject({ status: 409 });
    const thirdReceipt = path.join(filesAt(root), third!.id, 'receipt.json');
    const receipt = JSON.parse(await readFile(thirdReceipt, 'utf8'));
    await chmod(thirdReceipt, 0o600);
    await writeFile(thirdReceipt, JSON.stringify({ ...receipt, id: randomUUID() }));
    await expect(resolveAttachments(root, [third!.id])).rejects.toMatchObject({ status: 409 });
  });

  it.each(['serve', 'attachments'])('refuses a symlink at the %s storage boundary', async boundary => {
    const root = tempDir('workforce-upload-symlink-');
    const outside = tempDir('workforce-upload-outside-');
    const target = boundary === 'serve' ? path.join(root, 'serve') : filesAt(root);
    if (boundary === 'attachments') await mkdir(path.join(root, 'serve'));
    await symlink(outside, target);
    await expect(storeAttachments(root, { files: [upload()] })).rejects.toMatchObject({ status: 409, code: 'attachment_storage_invalid' });
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(['directory', 'content', 'receipt', 'hardlink'])('refuses substituted %s when resolving context', async kind => {
    const root = tempDir('workforce-upload-read-link-');
    const outside = tempDir('workforce-upload-read-outside-');
    const saved = await storeAttachments(root, { files: [upload()] });
    const id = saved.attachments[0]!.id;
    const dir = path.join(filesAt(root), id);
    if (kind === 'directory') {
      await rm(dir, { recursive: true });
      await symlink(outside, dir);
    } else {
      const target = path.join(dir, kind === 'receipt' ? 'receipt.json' : 'content.bin');
      const external = path.join(outside, 'external');
      await writeFile(external, await readFile(target));
      await rm(target);
      if (kind === 'hardlink') await link(external, target);
      else await symlink(external, target);
    }
    await expect(resolveAttachments(root, [id])).rejects.toMatchObject({ status: 409 });
  });
});
