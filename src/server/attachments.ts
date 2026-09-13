/** Durable user-provided context (FR020). These bytes are data, never instructions or executable paths. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ApiError } from './http.js';

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 10 * 1024 * 1024,
  maxBatchBytes: 25 * 1024 * 1024,
  maxBodyBytes: 36 * 1024 * 1024,
});

const AttachmentIdSchema = z.uuid();
const NameSchema = z.string().min(1).max(180).refine(value => !/[\\/\p{Cc}\p{Cf}]/u.test(value) && value !== '.' && value !== '..');
const MimeSchema = z.string().max(255).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
export const AttachmentDescriptorSchema = z.strictObject({
  id: AttachmentIdSchema,
  name: NameSchema,
  mimeType: MimeSchema,
  size: z.number().int().min(0).max(ATTACHMENT_LIMITS.maxFileBytes),
});
export type AttachmentDescriptor = z.infer<typeof AttachmentDescriptorSchema>;
export const AttachmentIdsSchema = z.array(AttachmentIdSchema).max(ATTACHMENT_LIMITS.maxFiles)
  .refine(ids => new Set(ids).size === ids.length, 'Attachment IDs must be unique.');

const ReceiptSchema = AttachmentDescriptorSchema.extend({
  schemaVersion: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
const UploadSchema = z.strictObject({ files: z.array(z.strictObject({
  name: z.string().min(1).max(4096),
  mimeType: z.string().max(255).optional(),
  data: z.string(),
})).min(1).max(ATTACHMENT_LIMITS.maxFiles) });

export interface ResolvedAttachment extends AttachmentDescriptor {
  readonly sha256: string;
  /** Coordinator-only path. Never put it in a public upload receipt or grant the containing state directory to a worker. */
  readonly path: string;
  /** Exact bytes whose digest was checked; use these for subsequent staging to avoid a verify/use race. */
  readonly data: Buffer;
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'invalid_attachment', message);
}

function displayName(value: string): string {
  // A browser or OS may supply a path. It is used only to derive a display label;
  // every stored filename below is chosen by the coordinator.
  const base = path.posix.basename(value.replaceAll('\\', '/')).normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '_').trim();
  let name = '';
  for (const character of base) {
    if (name.length + character.length > 180) break;
    name += character;
  }
  return name === '' || name === '.' || name === '..' ? 'attachment' : name;
}

function decodeBase64(value: string): Buffer {
  const maxEncoded = 4 * Math.ceil(ATTACHMENT_LIMITS.maxFileBytes / 3);
  if (value.length > maxEncoded) throw new ApiError(413, 'attachment_too_large', 'Each attachment must be 10 MiB or smaller.');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) {
    throw invalid('Attachment data must be canonical base64 without a data URL prefix or whitespace.');
  }
  const size = value.length / 4 * 3 - padding;
  if (size > ATTACHMENT_LIMITS.maxFileBytes) throw new ApiError(413, 'attachment_too_large', 'Each attachment must be 10 MiB or smaller.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== value) throw invalid('Attachment data is not canonical base64.');
  return bytes;
}

async function directory(parent: string, name: string, create: boolean): Promise<string> {
  const target = path.join(parent, name);
  if (create) {
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) {
    throw new ApiError(409, 'attachment_storage_invalid', 'Attachment storage contains an unexpected directory or symbolic link.');
  }
  return target;
}

async function storageRoot(stateRoot: string, create: boolean): Promise<string> {
  if (create) await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const canonical = await realpath(stateRoot);
  return directory(await directory(canonical, 'serve', create), 'attachments', create);
}

async function syncDirectory(target: string): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurably(target: string, bytes: Buffer): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Used behind the authenticated loopback write gate; validates the entire batch before creating files. */
export async function storeAttachments(stateRoot: string, body: unknown): Promise<{ ok: true; attachments: AttachmentDescriptor[] }> {
  const parsed = UploadSchema.safeParse(body);
  if (!parsed.success) throw invalid(`Upload between 1 and ${ATTACHMENT_LIMITS.maxFiles} files with name, MIME type and base64 data.`);
  let total = 0;
  const uploads = parsed.data.files.map(file => {
    const data = decodeBase64(file.data);
    total += data.length;
    if (total > ATTACHMENT_LIMITS.maxBatchBytes) throw new ApiError(413, 'attachments_too_large', 'Attachments in one upload must total 25 MiB or less.');
    const mime = MimeSchema.safeParse(file.mimeType?.trim().toLowerCase() || 'application/octet-stream');
    if (!mime.success) throw invalid('Attachment MIME type must be a valid type/subtype without parameters.');
    const descriptor = AttachmentDescriptorSchema.parse({ id: randomUUID(), name: displayName(file.name), mimeType: mime.data, size: data.length });
    return { descriptor, data };
  });
  const owned = new Set<string>();
  try {
    const root = await storageRoot(stateRoot, true);
    for (const upload of uploads) {
      const temporary = path.join(root, `.${upload.descriptor.id}.uploading`);
      await mkdir(temporary, { mode: 0o700 });
      owned.add(temporary);
      await writeDurably(path.join(temporary, 'content.bin'), upload.data);
      const receipt = ReceiptSchema.parse({ ...upload.descriptor, schemaVersion: 1,
        sha256: createHash('sha256').update(upload.data).digest('hex'), createdAt: new Date().toISOString() });
      await writeDurably(path.join(temporary, 'receipt.json'), Buffer.from(`${JSON.stringify(receipt)}\n`));
      await syncDirectory(temporary);
      const published = path.join(root, upload.descriptor.id);
      await rename(temporary, published);
      owned.delete(temporary);
      owned.add(published);
    }
    await syncDirectory(root);
    await syncDirectory(path.dirname(root));
    await syncDirectory(path.dirname(path.dirname(root)));
    return { ok: true, attachments: uploads.map(upload => upload.descriptor) };
  } catch (error) {
    // Remove only this unacknowledged batch, never older user attachments.
    await Promise.allSettled([...owned].map(target => rm(target, { recursive: true, force: true })));
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'attachment_storage_unavailable', 'The upload could not be saved durably. Check available local storage and try again.');
  }
}

async function readBounded(target: string, maximum: number): Promise<Buffer> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error('Invalid attachment file.');
    // Bound allocation and reads even if a hostile process grows the inode after stat.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Attachment changed while being read.');
    }
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Resolve only opaque IDs; verify the recorded byte count and digest before any runtime receives context. */
export async function resolveAttachments(stateRoot: string, ids: readonly string[]): Promise<ResolvedAttachment[]> {
  const parsed = AttachmentIdsSchema.safeParse(ids);
  if (!parsed.success) throw invalid('Attachment references must be unique upload IDs (at most 8).');
  if (parsed.data.length === 0) return [];
  try {
    const root = await storageRoot(stateRoot, false);
    const result: ResolvedAttachment[] = [];
    let total = 0;
    for (const id of parsed.data) {
      const dir = await directory(root, id, false);
      const receipt = ReceiptSchema.parse(JSON.parse((await readBounded(path.join(dir, 'receipt.json'), 4096)).toString('utf8')));
      if (receipt.id !== id) throw new Error('Attachment identity mismatch.');
      const file = path.join(dir, 'content.bin');
      const data = await readBounded(file, ATTACHMENT_LIMITS.maxFileBytes);
      if (data.length !== receipt.size || createHash('sha256').update(data).digest('hex') !== receipt.sha256) throw new Error('Attachment integrity mismatch.');
      total += data.length;
      if (total > ATTACHMENT_LIMITS.maxBatchBytes) throw new ApiError(413, 'attachments_too_large', 'Attachments in one request must total 25 MiB or less.');
      result.push({ ...AttachmentDescriptorSchema.parse({ id, name: receipt.name, mimeType: receipt.mimeType, size: receipt.size }), sha256: receipt.sha256, path: file, data });
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'attachment_not_found', 'An uploaded attachment is missing. Attach the file again before sending.');
    throw new ApiError(409, 'attachment_integrity_failed', 'An uploaded attachment has changed or cannot be verified. Attach the original file again before sending.');
  }
}
