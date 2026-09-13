/** Attachment metadata is durable; native File objects and file bytes stay out of browser storage. */
export const ATTACHMENT_LIMITS = Object.freeze({ count: 8, fileBytes: 10 * 1024 * 1024, imageBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024 });

export function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentDescriptor(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name || !Number.isSafeInteger(value.size) || value.size < 0) return null;
  return { id: value.id, name: value.name, mimeType: typeof value.mimeType === 'string' && value.mimeType ? value.mimeType : 'application/octet-stream', size: value.size };
}

export function attachmentDescriptors(values) {
  return Array.isArray(values) ? values.map(attachmentDescriptor).filter(Boolean) : [];
}

export function attachmentSelectionError(files, existing = []) {
  const selected = Array.from(files || []);
  if (selected.length + existing.length > ATTACHMENT_LIMITS.count) return 'Attach up to 8 files per message. Remove a file before adding more.';
  const nativeImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const oversizedImage = selected.find(file => (nativeImages.has(String(file.type || file.mimeType || '').toLowerCase().split(';')[0]) || /\.(png|jpe?g|gif|webp)$/i.test(file.name || '')) && file.size > ATTACHMENT_LIMITS.imageBytes);
  if (oversizedImage) return `${oversizedImage.name || 'This image'} exceeds the 5 MB image limit.`;
  const oversized = selected.find(file => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > ATTACHMENT_LIMITS.fileBytes);
  if (oversized) return `${oversized.name || 'This file'} exceeds the 10 MB file limit.`;
  if ([...existing, ...selected].reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0) > ATTACHMENT_LIMITS.totalBytes) return 'The files in one message can total up to 25 MB. Remove a file or choose smaller files.';
  return '';
}

export function persistDraftAttachments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object' && !Array.isArray(row)).map(row => ({ key: row.key, name: row.name, mimeType: row.mimeType || 'application/octet-stream', size: row.size, status: row.status, ...(row.id ? { id: row.id } : {}), ...(row.error ? { error: row.error } : {}) }));
}

export function restoreDraftAttachments(rows) {
  return persistDraftAttachments(rows).filter(row => typeof row.key === 'string' && typeof row.name === 'string' && Number.isSafeInteger(row.size) && row.size >= 0).slice(0, ATTACHMENT_LIMITS.count).map(row => {
    const ready = row.status === 'ready' && attachmentDescriptor(row);
    return ready ? { ...ready, key: row.key, status: 'ready' } : { ...row, id: undefined, status: 'error', error: 'Upload not completed. Remove this file and choose it again.' };
  });
}

/** Freeze the original attachments just like the original runtime for a consent retry. */
export function consentRetryAttachmentIds(request = {}, savedMessage = null, previousSubmission = null) {
  if (Array.isArray(previousSubmission?.attachmentIds)) return [...previousSubmission.attachmentIds];
  if (Array.isArray(request.attachments)) return attachmentDescriptors(request.attachments).map(file => file.id);
  if (Array.isArray(request.attachmentIds)) return [...request.attachmentIds];
  return attachmentDescriptors(savedMessage?.attachments).map(file => file.id);
}
