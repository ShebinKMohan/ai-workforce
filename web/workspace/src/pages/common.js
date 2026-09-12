/** Small pieces every page renders the same way. Pure string functions. */
import { esc, keyed, record } from '../render.js';
import { agentName, departmentLabel, joinWords, projectName } from '../model.js';
import { ERRORS, TONE_ICON } from '../words.js';

export function statusHtml(status) {
  return `<span class="status tone-${esc(status.tone)}"><span class="tone-icon" aria-hidden="true">${TONE_ICON[status.tone] ?? ''}</span>${esc(status.word)}</span>`;
}

export function chipHtml(ws, projectId, force = false) {
  if (!ws.showChips && !force) return '';
  const monogram = ws.monograms.get(projectId);
  return monogram ? `<span class="chip" title="${esc(projectName(ws, projectId))}" aria-hidden="true">${esc(monogram)}</span>` : '';
}

/** "17:25" today, "12 Sep, 17:25" otherwise. Empty for a missing time. */
export function formatTime(iso, now = Date.now()) {
  const date = new Date(iso ?? '');
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** A record as a definition list, inside a `data-record` block: identifiers live only here. */
export function recordHtml(value, id = null) {
  const entries = Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined && entry !== null && !(Array.isArray(entry) && entry.length === 0) && entry !== '');
  const body = entries.length
    ? `<dl>${entries.map(([name, entry]) => `<dt>${esc(name)}</dt><dd>${esc(typeof entry === 'object' ? JSON.stringify(entry) : String(entry))}</dd>`).join('')}</dl>`
    : '<p>Nothing more is recorded for this line.</p>';
  return `<div class="record" data-record${id ? ` id="${esc(id)}"` : ''}>${body}</div>`;
}

export function toggleHtml(key, expanded, closedLabel, openLabel, controls) {
  return `<button type="button" class="link-button" data-action="toggle" data-toggle="${esc(key)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${esc(controls)}">${esc(expanded ? openLabel : closedLabel)}</button>`;
}

export const domId = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '-');

export function taskRowHtml(ws, entry, now, { showProject = true } = {}) {
  const department = entry.departmentId ? departmentLabel(ws, entry.departmentId) : null;
  const workers = [...new Set((entry.run?.taskViews ?? []).map((task) => agentName(ws, task.ownerAgentId)))];
  const meta = [showProject && ws.showChips ? projectName(ws, entry.projectId) : null, department, workers.length ? joinWords(workers) : null, formatTime(entry.at, now)].filter(Boolean).join(' · ');
  const inner = `<div>${statusHtml(entry.status)}</div>
    <div><div class="row-title"><a href="${esc(entry.href)}">${esc(entry.title)}</a></div>
    <div class="row-meta">${showProject ? chipHtml(ws, entry.projectId) : ''} ${esc(meta)}</div>
    ${entry.status.line ? `<div class="row-line">${esc(entry.status.line)}</div>` : ''}</div>
    <div class="row-actions"><a class="button button-small" href="${esc(entry.href)}" aria-label="Open ${esc(entry.title)}">Open</a></div>`;
  return keyed('li', `task:${entry.key}`, 'class="row"', inner);
}

/** A refusal from the server in the page's words, with its details. */
export function errorHtml(error, { conflictActions = '' } = {}) {
  if (!error) return '';
  const code = error.code ?? '';
  let lead = error.message ?? 'Something went wrong.';
  if (code === 'unreachable') lead = ERRORS.unreachable;
  else if (code === 'workspace_revision_conflict' || code === 'workspace_changed_on_disk') lead = ERRORS.revisionConflict;
  else if (code === 'workspace_lock_busy') lead = ERRORS.lockBusy;
  else if (code === 'queue_managed_elsewhere') lead = ERRORS.queueElsewhere;
  else if (lead.length > 0) lead = `${lead.charAt(0).toUpperCase()}${lead.slice(1)}${/[.!?]$/.test(lead) ? '' : '.'}`;
  const details = (error.details ?? []).filter(Boolean);
  return `<div class="notice notice-failed" role="alert"><p>${esc(lead)}</p>${details.length ? `<ul>${details.slice(0, 6).map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}${conflictActions}</div>`;
}

export function emptyHtml(key, text, action = '') {
  return keyed('div', key, 'class="empty"', `<p>${esc(text)}</p>${action}`);
}

export function pageHead(key, title, lede = '', extra = '') {
  return keyed('header', key, 'class="section"', `<h1 tabindex="-1">${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}${extra}`);
}

export { record };
