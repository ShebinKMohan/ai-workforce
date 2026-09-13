/**
 * Home. While setup is incomplete: welcome, the four-step checklist, how a
 * task moves, and the (empty) office. Once set up: Needs you, the office
 * floor, and what is in motion, grouped by project.
 */
import { esc, keyed } from '../render.js';
import { floorModel } from '../office/floor-model.js';
import { floorHtml } from '../office/floor.js';
import { inMotionGroups } from '../model.js';
import { EMPTY, HOW_IT_MOVES_NOTE, PHASES, plural, SETUP, TONE_ICON } from '../words.js';
import { chipHtml, formatTime, pageHead, taskRowHtml } from './common.js';

const STATE_WORD = { done: 'Done', current: 'Next', locked: 'Later' };

function actionHtml(action, primary) {
  if (!action) return '';
  const cls = primary ? 'button button-primary' : 'button';
  if (action.kind === 'link') return `<a class="${cls}" href="${esc(action.href)}">${esc(action.label)}</a>`;
  if (action.kind === 'sheet') return `<button type="button" class="${cls}" data-action="open-sheet" data-sheet="${esc(action.sheet)}">${esc(action.label)}</button>`;
  if (action.kind === 'refresh') return `<button type="button" class="${cls}" data-action="refresh-tools" data-live-action>${esc(action.label)}</button>`;
  return '';
}

function stepHtml(row) {
  const text = SETUP.steps[row.id];
  const tools = row.tools ? `<ul class="tool-rows">${row.tools.map((tool) => `<li class="tone-${esc(tool.tone)}">${esc(tool.line)}${(tool.notes ?? []).map((note) => `<br><span class="muted">${esc(note)}</span>`).join('')}</li>`).join('')}</ul>` : '';
  const lines = row.lines.length ? `<ul class="step-lines">${row.lines.map((line) => `<li>${esc(line.text)} ${line.link ? `<a href="${esc(line.link.href)}">${esc(line.link.label)}</a>` : ''}</li>`).join('')}</ul>` : '';
  const note = row.note ? `<p class="muted small">${esc(row.note)}</p>` : '';
  const quiet = row.quiet ? `<button type="button" class="link-button" data-action="refresh-tools" data-live-action>${esc(row.quiet.label)}</button>` : '';
  const secondary = row.secondary ? `${actionHtml(row.secondary, false)}<span class="muted small">${esc(row.secondary.note ?? '')}</span>` : '';
  const inner = `<span class="step-mark" aria-hidden="true">${row.state === 'done' ? '✓' : row.number}</span>
    <div class="step-body"><h3>${row.number}. ${esc(text.title)}<span class="step-state">${STATE_WORD[row.state]}</span></h3><p class="muted">${esc(text.text)}</p>${tools}${lines}${note}</div>
    <div class="step-action">${row.state === 'current' ? actionHtml(row.action, true) : ''}${quiet}${secondary}</div>`;
  return keyed('li', `step:${row.id}`, `class="step step-${row.state}" aria-current="${row.state === 'current' ? 'step' : 'false'}"`, inner);
}

export function howItMovesHtml(key = 'moves') {
  const steps = PHASES.map((phase) => `<li><strong>${phase.number} ${esc(phase.heading)}</strong><span>${esc(phase.line)}</span></li>`).join('');
  return keyed('section', key, 'class="section" aria-labelledby="moves-title"', `<h2 id="moves-title">How a task moves</h2><ol class="moves">${steps}</ol><p class="moves-note">${esc(HOW_IT_MOVES_NOTE)}</p>`);
}

function officeHtml(ctx, heading = 'Your office') {
  const model = floorModel(ctx.ws, ctx.runsDoc, ctx.entries);
  const live = Array.isArray(ctx.requestsDoc?.live) ? ctx.requestsDoc.live : [];
  const limit = ctx.requestsDoc?.limits?.maxConcurrentProjectRuns ?? ctx.ws.limits?.maxConcurrentProjectRuns ?? 2;
  let line = '';
  if (!model.empty) {
    line = live.length === 0 ? 'Nothing is running right now.' : `${plural(live.length, 'task')} running. Your limit is ${limit} at a time.`;
    if (live.some((run) => run.runsOnItsOwn)) line += ' A task that runs on its own is running, so nothing else starts beside it.';
  }
  return keyed('section', 'office', 'class="section" aria-labelledby="office-title"', `<div class="section-head"><h2 id="office-title">${esc(heading)}</h2>${line ? `<p class="muted small">${esc(line)}</p>` : ''}</div>${floorHtml(model)}`);
}

function needsHtml(ctx) {
  const { needs, ws, now } = ctx;
  if (needs.items.length === 0 && needs.hiddenCount === 0) return '';
  const rows = needs.items.map((item) => {
    const buttons = [];
    for (const action of item.actions) {
      if (action === 'start') buttons.push(`<button type="button" class="button button-small button-primary" data-action="start-held" data-live-action data-id="${esc(item.requestId)}">Start</button>`);
      if (action === 'discard') buttons.push(`<button type="button" class="button button-small" data-action="discard" data-live-action data-id="${esc(item.requestId)}">Discard</button>`);
      if (action === 'resume') buttons.push(`<a class="button button-small button-primary" href="${esc(item.href)}">Open to resume</a>`);
      if (action === 'open') buttons.push(`<a class="button button-small" href="${esc(item.href)}">${item.kind === 'review' ? 'Review' : 'Open'}</a>`);
      if (action === 'refresh') buttons.push('<button type="button" class="button button-small" data-action="refresh-tools" data-live-action>Check again</button>');
    }
    if (item.hideable) buttons.push(`<button type="button" class="link-button" data-action="hide-needs" data-live-action data-id="${esc(item.id)}">Hide</button>`);
    const inner = `<div><span class="status tone-${esc(item.tone)}"><span class="tone-icon" aria-hidden="true">${TONE_ICON[item.tone] ?? ''}</span>${esc(item.word)}</span></div>
      <div><div class="row-line">${item.projectId ? chipHtml(ws, item.projectId) : ''} ${esc(item.line)}</div></div>
      <div class="row-actions">${buttons.join('')}</div>`;
    return keyed('li', `needs:${item.id}`, 'class="row"', inner);
  });
  const hiddenLine = needs.hiddenCount > 0 ? `<p class="quiet-line">${plural(needs.hiddenCount, 'item')} hidden on this browser. Nothing was recorded. <button type="button" class="link-button" data-action="show-hidden" data-live-action>Show</button></p>` : '';
  const hideAll = needs.items.filter((item) => item.hideable).length > 1 ? '<button type="button" class="link-button" data-action="hide-finished" data-live-action>Hide finished items</button>' : '';
  return keyed('section', 'needs', 'class="section" aria-labelledby="needs-title"', `<div class="section-head"><h2 id="needs-title">Needs you</h2>${hideAll}</div>${rows.length ? `<ul class="rows" role="list">${rows.join('')}</ul>` : ''}${hiddenLine}`);
}

function motionHtml(ctx) {
  const { ws, entries, now } = ctx;
  const groups = inMotionGroups(ws, entries.filter((entry) => !entry.needsYou));
  const moving = groups.filter((group) => group.entries.length > 0);
  let body;
  if (moving.length === 0) body = `<p class="quiet-line">${esc(EMPTY.inMotion)}</p>`;
  else {
    body = groups
      .map((group) => {
        if (group.entries.length === 0) {
          return ws.showChips ? `<p class="quiet-line">${chipHtml(ws, group.projectId)} ${esc(group.name)} · nothing in motion${group.finished ? ` · ${group.finished} finished` : ''}</p>` : '';
        }
        const head = ws.showChips ? `<div class="group-head">${chipHtml(ws, group.projectId)} ${esc(group.name)}</div>` : '';
        return `${head}<ul class="rows" role="list">${group.entries.map((entry) => taskRowHtml(ws, entry, now, { showProject: false })).join('')}</ul>`;
      })
      .join('');
  }
  return keyed('section', 'motion', 'class="section" aria-labelledby="motion-title"', `<div class="section-head"><h2 id="motion-title">In motion</h2>${entries.length ? '<a class="small" href="#/tasks">All tasks</a>' : ''}</div>${body}`);
}

export function workspaceProblemHtml(ctx) {
  const error = ctx.ws.error;
  const details = (error?.details ?? []).slice(0, 5);
  return [
    pageHead('problem-head', 'Your workspace file could not be read', 'Nothing can be sent or changed from this page until it is fixed. AI Workforce never overwrites a file it cannot read.'),
    keyed('section', 'problem', 'class="section card"', `<p><strong>File:</strong> <code>${esc(ctx.ws.path ?? '')}</code></p><p>${esc(error?.message ?? '')}</p>${details.length ? `<ul>${details.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}<p class="muted">Tasks already recorded are still readable in Tasks.</p><button type="button" class="button" data-action="reload-all" data-live-action>Check again</button>`),
  ].join('');
}

export function renderHome(ctx) {
  const { ws, setup, needs, entries, ui } = ctx;
  if (!ws.ok) return workspaceProblemHtml(ctx);
  if (setup.showChecklist) {
    const lede = ws.readiness?.empty === false ? `Setup: step ${setup.stepNumber} of 4. Everything you add is saved in your workspace file.` : SETUP.lines[0];
    const welcome = pageHead('welcome', SETUP.heading, lede, `<p class="muted">${esc(SETUP.lines[1])}</p>`);
    const checklist = keyed('section', 'checklist', 'class="section card" aria-labelledby="checklist-title"', `<h2 id="checklist-title">Set up in four steps</h2><ol class="checklist">${setup.rows.map(stepHtml).join('')}</ol>`);
    return [welcome, checklist, howItMovesHtml(), officeHtml(ctx)].join('');
  }
  const moving = entries.filter((entry) => entry.inMotion && !entry.needsYou).length;
  const head = pageHead('home-head', 'Home', `${moving} in motion · ${needs.items.length} ${needs.items.length === 1 ? 'needs' : 'need'} you`);
  const blocks = [head];
  if (setup.readyCard && !ui.readyHidden) {
    const lines = setup.readyCard.lines.map((line) => `<li class="${line.ok ? '' : 'muted'}">${esc(line.text)}</li>`).join('');
    blocks.push(keyed('section', 'ready', 'class="section card"', `<h2>Your workspace is ready</h2><p>Nothing has run yet.</p><ul>${lines}</ul><div class="button-row"><button type="button" class="button button-primary" data-action="open-sheet" data-sheet="new-task">Send your first task</button><button type="button" class="link-button" data-action="hide-ready" data-live-action>Hide</button></div>`));
  }
  blocks.push(needsHtml(ctx));
  blocks.push(officeHtml(ctx, 'Office'));
  blocks.push(motionHtml(ctx));
  if (!entries.length) blocks.push(howItMovesHtml());
  return blocks.filter(Boolean).join('');
}
