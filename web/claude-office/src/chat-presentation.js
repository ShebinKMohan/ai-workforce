import { renderRecordedMarkdown, renderRecordedSource } from './recorded-output.js';
import { attachmentDescriptors, formatAttachmentSize } from './attachment-model.js';

const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const chevron = '<svg class="chat-trace-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

function duration(ms) {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Only recorded Control Center replies become conversation answers. Agent prose stays in traces. */
export function renderChatResponse({ id, flow, elapsedMs, traceHTML = '', actionsHTML = '', consentHTML = '', refreshError = '', statusLine = '', overlayLine = '', stopRequested = false, reviewer = '' }) {
  const reply = flow.directReply ? flow.request.controlReply : flow.reply?.text;
  const longDirectReply = flow.directReply && (String(reply || '').length > 12_000 || String(reply || '').replace(/\r\n?/g, '\n').split('\n').length > 600);
  const label = flow.directReply ? 'Answered' : flow.label;
  const needsAttention = ['attention', 'failed'].includes(flow.tone);
  const worked = flow.reply?.final && flow.verified;
  const elapsed = duration(elapsedMs);
  const traceLabel = worked ? `Worked${elapsed ? ` for ${elapsed}` : ''}` : label;
  const source = reply ? renderRecordedSource(reply).replace('class="recorded-original"', `class="recorded-original" data-disclosure="final-output:${esc(id)}"`) : '';
  const trace = flow.directReply ? '' : `<details class="chat-trace" data-disclosure="execution:${esc(id)}" data-trace-task="${esc(id)}"><summary><span class="chat-trace-status status-${esc(flow.tone)}"><i></i><span>${esc(traceLabel)}</span></span><span class="chat-trace-hint"><span class="when-closed">View trace</span><span class="when-open">Hide trace</span></span>${chevron}</summary><div class="chat-trace-body">${traceHTML}${reviewer ? `<p class="chat-review-credit">Reviewed by ${esc(reviewer)}</p>` : ''}${source}<div class="inline-actions"><button type="button" data-open-task="${esc(id)}">Open task evidence ↗</button></div></div></details>`;
  const fallback = flow.legacyCheckResult ? 'The checks passed for this earlier task. No department-head review or Control Center final reply was recorded.' : statusLine;
  // A recorded reply already carries its explanation. Still show stale/changed evidence and live overlays independently.
  const visibleStatus = overlayLine && overlayLine !== reply ? overlayLine : fallback && (flow.legacyCheckResult || !reply || needsAttention && flow.reply?.final) ? fallback : '';
  const notice = visibleStatus ? `<p class="chat-response-status${needsAttention ? ' needs-attention' : ''}">${esc(visibleStatus)}</p>` : '';
  return `<section class="chat-progress chat-response" aria-label="Control Center response">${trace}${refreshError ? `<p class="sidebar-error" role="status">Could not refresh the task: ${esc(refreshError)}. Showing the last received records.</p>` : ''}${stopRequested ? '<p class="chat-response-status" role="status">Stop requested. Waiting for the runtime to settle.</p>' : ''}${notice}${reply ? `<article class="control-center-reply" data-reply-status="${esc(label)}"><div class="chat-answer-heading">Control Center${flow.directReply ? '<span class="sr-only"> · Answered</span>' : ''}</div><div class="recorded-markdown">${renderRecordedMarkdown(reply).replace('<p class="recorded-output-limit">Preview shortened. The original output is below.</p>', flow.directReply ? '<p class="recorded-output-limit">Preview shortened. The original output is below.</p>' : '<p class="recorded-output-limit">Preview shortened. Expand the trace for the original output.</p>')}</div>${longDirectReply ? source : ''}${worked ? '<p class="chat-answer-verdict">Reviewed and verified</p>' : ''}</article>` : ''}${actionsHTML ? `<div class="inline-actions chat-response-actions">${actionsHTML}</div>` : ''}${consentHTML}</section>`;
}

export function renderUserMessage({ id, text, project = '', at = '', attachments = [] }) {
  const fullText = String(text || '');
  const long = fullText.length > 700 || fullText.split('\n').length > 10;
  const message = long ? `<details class="chat-user-prompt" data-disclosure="prompt:${esc(id)}"><summary><span class="chat-prompt-preview">${esc(fullText.slice(0, 240).replace(/\s+\S*$/, '').trimEnd())}…</span><span class="chat-prompt-toggle"><span class="when-closed">Show more</span><span class="when-open">Show less</span>${chevron}</span></summary><p>${esc(fullText)}</p></details>` : `<p>${esc(fullText)}</p>`;
  const files = attachmentDescriptors(attachments);
  const attachmentHTML = files.length ? `<ul class="chat-sent-attachments" aria-label="Attached files">${files.map(file => `<li title="${esc(`${file.name} · ${file.mimeType} · ${formatAttachmentSize(file.size)}`)}"><span class="attachment-kind" aria-hidden="true">${file.mimeType.startsWith('image/') ? 'IMG' : 'FILE'}</span><span class="attachment-copy"><strong>${esc(file.name)}</strong><small>${esc(formatAttachmentSize(file.size))}</small></span></li>`).join('')}</ul>` : '';
  return `<div class="chat-message chat-message-user" aria-label="Your message"><span class="sr-only">You</span>${attachmentHTML}${message}<div class="chat-message-caption">${esc([project, at].filter(Boolean).join(' · '))}</div></div>`;
}
