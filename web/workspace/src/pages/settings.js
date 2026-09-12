/** Settings: coding tools, limits, the workspace file, importing an earlier setup, and earlier history. */
import { esc, keyed } from '../render.js';
import { renderRuntimePanel } from './runtime-panel.js';
import { renderControlCenterPanel } from './control-center-panel.js';
import { runStatusLine } from '../truth.js';
import { plural } from '../words.js';
import { errorHtml, formatTime, pageHead } from './common.js';

export const LIMIT_FIELDS = [
  { key: 'maxConcurrentProjectRuns', label: 'Tasks running at once, across projects', min: 1, max: 32 },
  { key: 'maxActiveWriters', label: 'Workers changing files at once, per task', min: 1, max: 64 },
  { key: 'maxActiveTurns', label: 'Coding-tool sessions at once, per task', min: 1, max: 64 },
  { key: 'maxTasksPerRun', label: 'Parts a department head may split a task into', min: 1, max: 1000 },
  { key: 'maxRepairAttempts', label: 'Fixes a worker may try after a failed check', min: 0, max: 100 },
  { key: 'runTimeoutMinutes', label: 'Minutes before a task times out', min: 1, max: 10080 },
];

export function renderSettings(ctx) {
  const { ws, ui, runsDoc, requestsDoc, now } = ctx;
  const controlCenterBlock = keyed('section', 'settings-control-center', 'class="section card" aria-labelledby="control-center-title"', renderControlCenterPanel(ctx));
  const toolsBlock = keyed('section', 'settings-tools', 'class="section" aria-labelledby="tools-title"', renderRuntimePanel(ctx));

  const limits = ws.limits ?? {};
  const draft = ui.limitsDraft ?? {};
  const limitsBlock = keyed(
    'section',
    'settings-limits',
    'class="section card" aria-labelledby="limits-title"',
    `<h2 id="limits-title">Execution limits</h2><div class="editor-grid">${LIMIT_FIELDS.map((field) => `<div class="field"><label for="limit-${field.key}">${esc(field.label)}</label><input type="number" id="limit-${field.key}" min="${field.min}" max="${field.max}" step="1" data-bind="limit" data-field="${field.key}" value="${esc(draft[field.key] ?? limits[field.key] ?? '')}" ${ws.ok ? '' : 'disabled'}></div>`).join('')}</div>
    ${ui.actionError?.key === 'limits' ? errorHtml(ui.actionError.error) : ''}${ui.notice?.key === 'limits' ? `<p class="muted">${esc(ui.notice.text)}</p>` : ''}
    <button type="button" class="button" data-action="save-limits" ${ws.ok ? '' : 'disabled'}>Save limits</button>`,
  );

  const legacy = ws.legacyAgents;
  const importBlock = keyed(
    'section',
    'settings-import',
    'class="section card" aria-labelledby="import-title"',
    `<h2 id="import-title">Import an earlier setup</h2>${
      legacy
        ? `<p>An agent configuration from before workspaces was found${legacy.agentCount ? ` with ${plural(legacy.agentCount, 'agent')}` : ''}: <code>${esc(legacy.path)}</code></p><p class="muted small">Importing makes it one new department and places nobody on a project. Run this in a terminal, then check this page again:</p><p><code>${esc(legacy.command)}</code></p>`
        : '<p class="muted">No earlier agents.json was found in the Workforce folder.</p>'
    }`,
  );

  const fileBlock = keyed('section', 'settings-file', 'class="section card" aria-labelledby="file-title"', `<h2 id="file-title">Workspace file</h2><p><code>${esc(ws.path ?? '')}</code></p><p class="muted small">${ws.exists ? `Revision ${esc(ws.revision)}. Every change from this page or the workforce workspace command adds one.` : 'Not created yet. It is written the first time you add something.'}</p>${ws.error ? errorHtml({ message: ws.error.message, details: ws.error.details }) : ''}`);

  const queue = requestsDoc;
  const serverBlock = keyed(
    'section',
    'settings-server',
    'class="section card" aria-labelledby="server-title"',
    `<h2 id="server-title">This page server</h2>
    <p>${queue?.accepting ? 'This page server starts the tasks you send from this page.' : esc(queue?.managedElsewhere ?? 'It does not manage tasks for this workspace.')}</p>
    ${queue?.notice ? `<p class="tone-attention">${esc(queue.notice)}</p>` : ''}
    <p class="muted small">A task keeps running if the page server stops. A task still waiting when it stops is held until you start it again.</p>
    ${(queue?.live ?? []).length ? `<ul class="people">${queue.live.map((run) => `<li><span>${esc(ws.projectById.get(run.projectId)?.name ?? run.projectId)}${run.startedOutsideThisPage ? ' · started outside this page' : ''}</span><span class="muted small">process ${esc(run.pid ?? 'unknown')}${run.runsOnItsOwnBecause ? ` · runs on its own: ${esc(run.runsOnItsOwnBecause)}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing is running.</p>'}`,
  );

  const earlier = runsDoc?.earlierHistory?.runs ?? [];
  const earlierBlock = earlier.length
    ? keyed('section', 'settings-earlier', 'class="section card" aria-labelledby="earlier-title"', `<h2 id="earlier-title">Earlier history</h2><p class="muted small">Runs made before this workspace existed. Read-only.</p><ul class="people">${earlier.map((run) => `<li><span>${esc(String(run.request?.text ?? '').split('\n', 1)[0] || run.id)}</span><span class="muted small">${esc(runStatusLine(run, runsDoc.earlierHistory.coordinator?.lock ?? null))} · ${esc(formatTime(run.createdAt, now))}</span></li>`).join('')}</ul>`)
    : '';

  return [pageHead('settings-head', 'Settings', 'Configure the installed runtimes and execution limits used by your local workforce.'), controlCenterBlock, toolsBlock, limitsBlock, fileBlock, importBlock, serverBlock, earlierBlock].filter(Boolean).join('');
}
