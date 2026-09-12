/** Tasks: the full history, filtered by a radio group, grouped by project. */
import { esc, keyed } from '../render.js';
import { EMPTY } from '../words.js';
import { chipHtml, emptyHtml, pageHead, taskRowHtml } from './common.js';

export const TASK_FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'motion', label: 'In motion', test: (entry) => entry.inMotion },
  { id: 'needs', label: 'Needs you', test: (entry) => Boolean(entry.needsYou) },
  { id: 'finished', label: 'Finished', test: (entry) => entry.finished },
];

export function renderTasks(ctx) {
  const { ws, entries, ui, now, setup } = ctx;
  const newButton = setup.allDone && ws.ok ? '<button type="button" class="button button-primary" data-action="open-sheet" data-sheet="new-task">New task</button>' : '';
  if (entries.length === 0) return [pageHead('tasks-head', 'Tasks'), emptyHtml('tasks-empty', EMPTY.tasks, newButton)].join('');
  const filter = TASK_FILTERS.find((entry) => entry.id === ui.taskFilter) ?? TASK_FILTERS[0];
  const filters = `<div class="filters" role="radiogroup" aria-label="Show tasks">${TASK_FILTERS.map((option) => `<label><input type="radio" name="task-filter" value="${option.id}" data-bind="filter" data-rerender ${option.id === filter.id ? 'checked' : ''}> ${esc(option.label)} <span class="muted">${entries.filter(option.test).length}</span></label>`).join('')}</div>`;
  const shown = entries.filter(filter.test);
  let body;
  if (shown.length === 0) body = `<p class="quiet-line">No tasks match this filter.</p>`;
  else if (!ws.showChips) body = `<ul class="rows" role="list">${shown.map((entry) => taskRowHtml(ws, entry, now)).join('')}</ul>`;
  else {
    const order = [...new Set(shown.map((entry) => entry.projectId))];
    body = order
      .map((projectId) => {
        const name = ws.projectById.get(projectId)?.name ?? projectId;
        return `<div class="group-head">${chipHtml(ws, projectId)} ${esc(name)}</div><ul class="rows" role="list">${shown.filter((entry) => entry.projectId === projectId).map((entry) => taskRowHtml(ws, entry, now, { showProject: false })).join('')}</ul>`;
      })
      .join('');
  }
  return [pageHead('tasks-head', 'Tasks', 'Every task you sent, and every task started from a terminal, with what was recorded.', newButton ? `<div class="button-row">${newButton}</div>` : ''), keyed('section', 'tasks-filter', 'class="section"', filters), keyed('section', `tasks-list:${filter.id}`, 'class="section"', body)].join('');
}
