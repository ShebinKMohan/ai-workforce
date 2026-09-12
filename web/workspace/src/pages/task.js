/**
 * One task: who is doing what now, then how it moved under the same five
 * phases Home teaches. The current phase is open; a finished phase is one line
 * whose "Show record" reveals its lines with their ids, hashes and exit codes.
 * Changes, Checks and All events sit behind disclosures.
 */
import { esc, keyed } from '../render.js';
import { checkView, describeEvent, diffLines } from '../truth.js';
import { TONE_ICON } from '../words.js';
import { chipHtml, domId, errorHtml, formatTime, recordHtml, statusHtml, toggleHtml } from './common.js';

/** A disclosure whose toggle and body are separate keyed blocks: a focused toggle never holds back an update to its body. */
function disclosure(key, toggle, bodyId, body) {
  return keyed('section', key, 'class="disclosure"', `${keyed('div', `${key}:toggle`, '', toggle)}${keyed('div', `${key}:body`, `id="${bodyId}"`, body)}`);
}

const PHASE_MARK = { now: 'Now', stopped: 'Stopped', done: 'Done', not_yet: 'Not yet', skipped: 'Skipped' };
const STAGE_MARK = { now: 'Now', stopped: 'Stopped', done: 'Done' };

function stageHtml(phase, group, stage, ui, now, showRecords) {
  const key = `stage:${phase.key}:${group.key}:${stage.id}`;
  const expanded = showRecords || ui.expanded.has(key);
  const recordId = `record-${domId(key)}`;
  const tone = stage.tone && stage.tone !== 'neutral' ? ` tone-${stage.tone}` : '';
  const icon = stage.tone === 'verified' || stage.tone === 'failed' || stage.tone === 'attention' ? `<span class="tone-icon" aria-hidden="true">${TONE_ICON[stage.tone]}</span>` : '';
  const toggle = showRecords ? '' : toggleHtml(key, expanded, 'Record', 'Hide record', recordId);
  const inner = `<span class="stage-mark">${esc(STAGE_MARK[stage.mark] ?? '')}</span>
    <span class="stage-line${tone}">${icon}${esc(stage.line)} ${toggle}</span>
    <span class="stage-time">${esc(formatTime(stage.at, now))}</span>
    ${expanded ? recordHtml({ ...stage.record, recorded: stage.sourceIds.join(', ') }, recordId) : ''}`;
  return keyed('li', key, `class="stage stage-${esc(stage.mark)}"`, inner);
}

function phaseHtml(phase, ui, now) {
  const key = `phase:${phase.key}`;
  const expanded = ui.expanded.has(key);
  const live = phase.state === 'now' || phase.state === 'stopped';
  const open = live || (phase.state === 'done' && expanded);
  const bodyId = `phase-body-${phase.key}`;
  const toggle = phase.state === 'done' ? toggleHtml(key, expanded, 'Show record', 'Hide record', bodyId) : '';
  const groups = open
    ? phase.groups
        .map((group) => {
          const title = group.title ? `<div class="part-title">${esc(group.title)}${group.subtitle ? ` <span class="muted">· ${esc(group.subtitle)}</span>` : ''}</div>` : '';
          return `<div class="part">${title}<ol class="stages">${group.stages.map((stage) => stageHtml(phase, group, stage, ui, now, phase.state === 'done')).join('')}</ol></div>`;
        })
        .join('')
    : '';
  const inner = `<div class="phase-head"><span class="phase-mark">${PHASE_MARK[phase.state]}</span><span class="phase-name">${phase.number} ${esc(phase.heading)}</span><span class="phase-summary">${esc(phase.summary)}</span>${toggle}</div>
    ${open && groups ? `<div class="phase-body" id="${bodyId}">${groups}</div>` : ''}`;
  return keyed('li', key, `class="phase phase-${phase.state}"`, inner);
}

function changesHtml(ctx, taskView) {
  const { ui } = ctx;
  const expanded = ui.expanded.has('changes');
  const status = taskView.status;
  const snapshots = new Map((taskView.events ?? []).filter((event) => event.type === 'candidate.snapshot').map((event) => [event.payload?.candidateRevision, event.taskId]));
  const partTitle = new Map(taskView.detail.parts.map((part) => [part.taskId, `${part.title} · ${part.worker}`]));
  const patches = (status?.artifacts ?? []).filter((artifact) => artifact.type === 'candidate_patch');
  let body = '';
  if (expanded) {
    if (patches.length === 0) body = '<p class="muted">No changes are recorded yet. A change appears once a worker\'s copy is frozen for checking.</p>';
    else {
      body = patches
        .map((artifact) => {
          const state = ui.task?.diffs?.get(artifact.id);
          const title = partTitle.get(snapshots.get(artifact.candidateRevision)) ?? 'A part';
          let diff = '<p class="muted">Reading the change…</p>';
          if (state?.error) diff = errorHtml(state.error);
          else if (typeof state?.text === 'string') diff = state.text.trim() ? `<div class="diff" data-record>${diffLines(state.text).map((line) => `<div class="${line.kind}">${esc(line.text) || ' '}</div>`).join('')}</div>` : '<p class="muted">The frozen copy has no changes.</p>';
          return `<div class="part"><div class="part-title">${esc(title)}</div>${diff}</div>`;
        })
        .join('');
    }
  }
  return disclosure('changes', toggleHtml('changes', expanded, `Changes${patches.length ? ` (${patches.length})` : ''}`, 'Hide changes', 'changes-body'), 'changes-body', body);
}

function checksHtml(ctx, taskView) {
  const expanded = ctx.ui.expanded.has('checks');
  const status = taskView.status;
  const rows = status?.checks ?? [];
  let body = '';
  if (expanded) {
    body = rows.length
      ? `<ul class="stages">${rows
          .map((row) => {
            const view = checkView(row, status, taskView.entry.run);
            const word = view.compromised ? 'Does not count' : view.evidenceUnavailable ? 'Evidence missing or changed' : row.outcome === 'passed' ? 'Passed' : row.outcome === 'failed' ? 'Failed' : 'Recorded';
            const tone = view.tone === 'verified' ? 'verified' : view.tone === 'failed' || view.tone === 'compromised' ? 'failed' : 'neutral';
            return `<li class="stage"><span class="stage-mark"></span><span class="stage-line tone-${tone}"><span class="tone-icon" aria-hidden="true">${TONE_ICON[tone]}</span>${esc(word)} · ${esc(row.command)} · ${view.verifier ? 'run by the verifier' : 'not run by the verifier'}</span><span></span>${recordHtml({ check: row.id, criteria: row.criterionIds, exitCode: row.exitCode, provenance: row.evidenceProvenance, frozenCopy: row.candidateRevision })}</li>`;
          })
          .join('')}</ul>`
      : '<p class="muted">No check has run yet. Checks run on a frozen copy after a worker finishes.</p>';
  }
  return disclosure('checks', toggleHtml('checks', expanded, `Checks${rows.length ? ` (${rows.length})` : ''}`, 'Hide checks', 'checks-body'), 'checks-body', body);
}

function eventsHtml(ctx, taskView) {
  const expanded = ctx.ui.expanded.has('events');
  const events = taskView.events ?? [];
  const body = expanded
    ? `<div data-record><p class="muted small">Every recorded event, in order. Record words are used as they are stored.</p><ol class="events">${events.map((event) => `<li><span class="muted">#${event.sequence}</span><span>${esc(describeEvent(event))} <span class="muted">· ${esc(event.type)} · ${esc(formatTime(event.timestamp, ctx.now))}</span></span></li>`).join('')}</ol></div>`
    : '';
  return disclosure('events', toggleHtml('events', expanded, `All events${events.length ? ` (${events.length})` : ''}`, 'Hide events', 'events-body'), 'events-body', body);
}

function consentHtml(ctx, taskView) {
  const consent = ctx.ui.resumeConsent;
  if (!consent || consent.key !== taskView.entry.key) return '';
  const lines = (consent.agents ?? []).map((agent) => `<li>${esc(agent.line)}</li>`).join('');
  return `<div class="notice notice-attention"><p>Resuming lets these workers change files on a coding tool without a verified file boundary, so they could change files elsewhere on this computer:</p><ul>${lines}</ul>
    <label class="check-row"><input type="checkbox" id="resume-consent" data-bind="resume-consent" data-rerender ${consent.checked ? 'checked' : ''}> <span>Let them change files without that boundary to finish this task</span></label>
    <div class="button-row" style="margin-top:8px"><button type="button" class="button button-primary" data-action="resume-confirm" data-live-action ${consent.checked ? '' : 'disabled'}>Resume</button><button type="button" class="link-button" data-action="resume-cancel" data-live-action>Cancel</button></div></div>`;
}

export function renderTask(ctx) {
  const { ws, ui, now } = ctx;
  const taskView = ctx.taskView;
  const crumbs = '<p class="crumbs"><a href="#/tasks">Tasks</a></p>';
  if (!taskView || (!taskView.detail && taskView.loading)) return keyed('section', 'task-loading', 'class="section"', `${crumbs}<h1 tabindex="-1" class="page-title">Task</h1><p class="muted">Reading this task…</p>`);
  if (!taskView.detail) {
    return keyed('section', 'task-missing', 'class="section"', `${crumbs}<h1 tabindex="-1" class="page-title">Task not found</h1><p class="muted">This task is not in the recorded history this page can read.</p>${taskView.error ? errorHtml(taskView.error) : ''}`);
  }
  const detail = taskView.detail;
  const entry = taskView.entry;
  const buttons = [];
  if (detail.canStop) buttons.push(`<button type="button" class="button" data-action="stop-request" data-live-action data-id="${esc(entry.item.id)}">Stop this task</button>`);
  if (detail.canResume && !(ui.resumeConsent && ui.resumeConsent.key === entry.key)) buttons.push(`<button type="button" class="button button-primary" data-action="resume" data-live-action data-project="${esc(entry.projectId)}" data-run="${esc(entry.runId)}" data-key="resume-button">Resume</button>`);
  if (entry.item?.state === 'held') buttons.push(`<button type="button" class="button button-primary" data-action="start-held" data-live-action data-id="${esc(entry.item.id)}">Start</button><button type="button" class="button" data-action="discard" data-live-action data-id="${esc(entry.item.id)}">Discard</button>`);
  if (entry.item?.state === 'queued') buttons.push(`<button type="button" class="button" data-action="discard" data-live-action data-id="${esc(entry.item.id)}">Discard</button>`);
  const meta = [
    `${chipHtml(ws, detail.projectId, true)} ${esc(detail.project)}`,
    detail.department ? esc(detail.department) : null,
    detail.sentAt ? `${entry.item ? 'Sent' : 'Started'} ${esc(formatTime(detail.sentAt, now))}` : null,
    statusHtml(detail.status),
  ].filter(Boolean);
  const header = keyed(
    'header',
    'task-head',
    'class="section"',
    `${crumbs}<div class="task-head"><div><h1 tabindex="-1" class="page-title">${esc(detail.title)}</h1><div class="task-meta">${meta.join('<span aria-hidden="true">·</span>')}</div>${detail.status.line ? `<p class="lede" style="margin-top:8px">${esc(detail.status.line)}</p>` : ''}</div><div class="button-row">${buttons.join('')}</div></div>
    ${detail.stopNote ? `<p class="muted small">${esc(detail.stopNote)}</p>` : ''}
    ${detail.activeResume ? `<p class="notice">Resume ${detail.activeResume.state === 'queued' ? `is waiting: ${esc((detail.activeResume.reason ?? '').replace(/^waiting:\s*/, ''))}` : detail.activeResume.state === 'held' ? 'was held when the page server stopped' : 'is in progress'}.</p>` : ''}
    ${detail.overlay ? `<div class="notice notice-failed" role="status"><p>${esc(detail.overlay.line)}</p></div>` : ''}
    ${taskView.error ? `<div class="notice notice-attention" role="status"><p>Could not refresh this task. Showing the last records this page received.</p>${errorHtml(taskView.error)}</div>` : ''}
    ${taskView.status?.evidenceIssues?.length ? `<div class="notice notice-attention" role="status"><p>Some saved evidence is missing or has changed. The affected checks no longer count as verified.</p>${recordHtml({ evidenceIssues: taskView.status.evidenceIssues })}</div>` : ''}
    ${ui.actionError && ui.actionError.key === entry.key ? errorHtml(ui.actionError.error) : ''}
    ${consentHtml(ctx, taskView)}`,
  );
  const actors = keyed('section', 'actors', 'class="section card" aria-labelledby="actors-title"', `<h2 id="actors-title">What each part is doing now</h2><dl class="actors">${detail.actors.map((actor) => `<dt>${esc(actor.name)}</dt><dd>${esc(actor.line)}</dd>`).join('')}</dl>`);
  const phases = keyed('section', 'phases', 'class="section" aria-labelledby="phases-title"', `<div class="section-head"><h2 id="phases-title">How it is moving</h2><p class="muted small">Each line appears only when Workforce records it.</p></div><ol class="phases">${detail.phases.map((phase) => phaseHtml(phase, ui, now)).join('')}</ol>`);
  const more = keyed('section', 'more', 'class="section"', [changesHtml(ctx, taskView), checksHtml(ctx, taskView), eventsHtml(ctx, taskView)].join(''));
  const record = keyed('div', 'task-record-wrap', 'class="section"', disclosure('task-record', toggleHtml('task-record', ui.expanded.has('task-record'), 'Show record', 'Hide record', 'task-record-body'), 'task-record-body', ui.expanded.has('task-record') ? recordHtml(detail.record) : ''));
  return [header, actors, phases, more, record].join('');
}
