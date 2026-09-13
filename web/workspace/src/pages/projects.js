/** Projects: each folder, its checks, who works on it, and its history. */
import { esc, keyed } from '../render.js';
import { departmentLabel, projectChecks, pairSendable, pairBlockers } from '../model.js';
import { EMPTY, plural } from '../words.js';
import { chipHtml, emptyHtml, errorHtml, pageHead, recordHtml, taskRowHtml, toggleHtml } from './common.js';

const SOURCE_WORDS = {
  cli_flags: 'Set in AI Workforce',
  repository_config: 'Found in .workforce/checks.json at your last commit',
  detected: 'Detected at your last commit',
  none: 'None found',
};

export function checksSummary(ws, projectId) {
  const checks = projectChecks(ws, projectId);
  if (checks.count === null) return { tone: 'attention', text: `Checks could not be read: ${checks.fact?.detail ?? 'the folder could not be read'}.` };
  if (checks.count === 0) return { tone: 'attention', text: 'No checks yet, so nothing here could be verified.' };
  return { tone: 'neutral', text: `${plural(checks.count, 'check')} · ${SOURCE_WORDS[checks.fact?.source] ?? 'Set in AI Workforce'}` };
}

function workersOn(ws, projectId) {
  return ws.liveAgents.filter((agent) => agent.role === 'worker' && agent.projectIds.includes(projectId));
}

function readinessLine(ws, project) {
  if (project.archived) return { word: 'Archived', tone: 'muted' };
  const ready = ws.liveDepartments.filter((department) => pairSendable(ws, department.id, project.id));
  if (ready.length) return { word: `Ready · ${ready.map((department) => departmentLabel(ws, department.id)).join(', ')}`, tone: 'neutral' };
  if (!workersOn(ws, project.id).length) return { word: 'Assign a worker to enable tasks', tone: 'attention' };
  if (!projectChecks(ws, project.id).count) return { word: 'Configure verification checks', tone: 'attention' };
  return { word: 'Team or runtime setup required', tone: 'attention' };
}

export function renderProjects(ctx) {
  const { ws, entries } = ctx;
  const add = '<button type="button" class="button button-primary" data-action="open-sheet" data-sheet="add-project">Add a project</button>';
  if (!ws.ok) return pageHead('projects-head', 'Projects', 'The workspace file could not be read.');
  if (ws.projects.length === 0) return [pageHead('projects-head', 'Projects', 'Connect the local repositories your workforce will work on.'), emptyHtml('projects-empty', 'Add a repository, review its verification checks, then assign workers to enable task routing.', add)].join('');
  const rows = ws.projects.map((project) => {
    const summary = checksSummary(ws, project.id);
    const workers = workersOn(ws, project.id);
    const tasks = entries.filter((entry) => entry.projectId === project.id).length;
    const readiness = readinessLine(ws, project);
    const inner = `<div>${chipHtml(ws, project.id, true)} ${project.archived ? '<span class="muted small">Archived</span>' : ''}</div>
      <div><div class="row-title"><a href="#/projects/${esc(project.id)}">${esc(project.name)}</a></div><div class="row-meta">${esc(project.repoPath)}</div>
      <div class="project-setup-status tone-${readiness.tone}">${esc(readiness.word)}</div><div class="row-line"><span class="tone-${summary.tone}">${esc(summary.text)}</span> · ${plural(workers.length, 'worker')} · ${plural(tasks, 'task')}</div></div>
      <div class="row-actions"><a class="button button-small" href="#/projects/${esc(project.id)}">Open</a></div>`;
    return keyed('li', `project:${project.id}`, 'class="row"', inner);
  });
  return [pageHead('projects-head', 'Projects', 'Tasks start from committed HEAD. Each run records its candidate changes, checks, and review evidence.', `<div class="button-row">${add}</div>`), keyed('section', 'projects-list', 'class="section"', `<ul class="rows" role="list">${rows.join('')}</ul>`)].join('');
}

export function renderProject(ctx) {
  const { ws, entries, ui, now } = ctx;
  const project = ws.projectById.get(ctx.route.projectId);
  if (!project) return [pageHead('project-head', 'Project not found', 'This project is not in the workspace.'), '<p><a href="#/projects">All projects</a></p>'].join('');
  const form = ui.projectForms.get(project.id) ?? { newCheck: '', error: null, saving: false };
  const checks = projectChecks(ws, project.id);
  const summary = checksSummary(ws, project.id);
  const configured = project.checks
    .map((command, index) => `<li class="stage"><span class="stage-mark"></span><span class="stage-line"><code>${esc(command)}</code></span><span><button type="button" class="link-button" data-action="remove-check" data-project="${esc(project.id)}" data-index="${index}" aria-label="Remove the check ${esc(command)}">Remove</button></span></li>`)
    .join('');
  const checkBlock = keyed(
    'section',
    'project-checks',
    'class="section card" aria-labelledby="checks-title"',
    `<h2 id="checks-title">Checks the verifier runs</h2>
    <p class="tone-${summary.tone}">${esc(summary.text)}</p>
    ${configured ? `<ol class="stages">${configured}</ol>` : checks.count ? '<p class="muted small">These come from the repository at your last commit. Add a check here to use your own list instead.</p>' : ''}
    <div class="field" style="margin-top:12px"><label for="new-check-${esc(project.id)}">Add a check</label><span class="hint">A command the verifier runs in a frozen copy, such as npm test. It passes when the command exits successfully.</span>
    <div class="inline-field"><input type="text" id="new-check-${esc(project.id)}" data-bind="project-check" data-project="${esc(project.id)}" value="${esc(form.newCheck)}" placeholder="npm test" ${project.archived ? 'disabled' : ''}><button type="button" class="button" data-action="add-check" data-project="${esc(project.id)}" ${project.archived ? 'disabled' : ''}>Save check</button></div></div>
    ${form.error ? errorHtml(form.error) : ''}
    ${toggleHtml(`project-record:${project.id}`, ui.expanded.has(`project-record:${project.id}`), 'Show record', 'Hide record', `project-record-${project.id}`)}
    <div id="project-record-${esc(project.id)}">${ui.expanded.has(`project-record:${project.id}`) ? recordHtml({ id: project.id, folder: project.repoPath, checkSource: checks.fact?.source, detail: checks.fact?.detail }) : ''}</div>`,
  );
  const byDepartment = new Map();
  for (const worker of workersOn(ws, project.id)) {
    if (!byDepartment.has(worker.departmentId)) byDepartment.set(worker.departmentId, []);
    byDepartment.get(worker.departmentId).push(worker);
  }
  const availableWorkers = ws.liveAgents.filter((agent) => agent.role === 'worker' && ws.liveDepartments.some((department) => department.id === agent.departmentId));
  const selectedWorkers = ui.projectWorkerDrafts?.get(project.id) || new Set(workersOn(ws, project.id).map((worker) => worker.id));
  const people = availableWorkers.length
    ? `<p class="muted small">Select workers who may receive this project's tasks. Their department head plans the work and assigns from this roster.</p><div class="project-workers">${availableWorkers.map((worker) => `<label class="project-worker"><input type="checkbox" data-bind="project-worker" data-project="${esc(project.id)}" data-agent="${esc(worker.id)}"${selectedWorkers.has(worker.id) ? ' checked' : ''}${project.archived ? ' disabled' : ''}><span><strong>${esc(worker.name)}</strong><small>${esc(departmentLabel(ws, worker.departmentId))}</small></span></label>`).join('')}</div>${ui.actionError?.key === `workers:${project.id}` ? errorHtml(ui.actionError.error) : ''}${ui.notice?.key === `workers:${project.id}` ? `<p role="status" class="small">${esc(ui.notice.text)}</p>` : ''}<div class="button-row"><button class="button" type="button" data-action="save-project-workers" data-project="${esc(project.id)}"${project.archived ? ' disabled' : ''}>Save worker access</button><a class="link-button" href="#/departments">Manage teams</a></div>`
    : '<p class="muted">Create a department and add a worker to give this project an execution team.</p><a class="button" href="#/departments/new">Create a department</a>';
  const readyDepartments = ws.liveDepartments.filter((department) => pairSendable(ws, department.id, project.id));
  const rosterDepartments = [...byDepartment.keys()];
  const setupStatus = readyDepartments.length
    ? `<p class="project-setup-status">Ready for tasks through ${esc(readyDepartments.map((department) => departmentLabel(ws, department.id)).join(', '))}.</p><button type="button" class="button button-primary" data-action="open-sheet" data-sheet="new-task" data-project="${esc(project.id)}">New task</button>`
    : `<p class="project-setup-status tone-attention">${esc(readinessLine(ws, project).word)}</p>${rosterDepartments.length ? `<ul class="small muted">${[...new Set(rosterDepartments.flatMap((id) => pairBlockers(ws, id, project.id)))].map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}`;
  const mine = entries.filter((entry) => entry.projectId === project.id);
  const confirm = ui.confirm;
  const archiveConfirm = confirm === `archive-project:${project.id}`;
  const removeConfirm = confirm === `remove-project:${project.id}`;
  const actions = project.archived
    ? '<p class="muted">Archived: it takes no new tasks. Its folder and history stay.</p>'
    : `<div class="button-row">${archiveConfirm ? `<span>Archive ${esc(project.name)}? It takes no new tasks. Its folder and history stay.</span><button type="button" class="button" data-action="archive-project" data-project="${esc(project.id)}">Archive</button><button type="button" class="link-button" data-action="confirm-cancel">Cancel</button>` : `<button type="button" class="button" data-action="confirm" data-confirm="archive-project:${esc(project.id)}">Archive</button>`}
      ${removeConfirm ? `<span>Remove ${esc(project.name)} from the workspace? Its folder is never deleted.</span><button type="button" class="button" data-action="remove-project" data-project="${esc(project.id)}">Remove</button><button type="button" class="link-button" data-action="confirm-cancel">Cancel</button>` : `<button type="button" class="button" data-action="confirm" data-confirm="remove-project:${esc(project.id)}">Remove from workspace</button>`}</div>
      <p class="muted small">Removing or archiving a project never deletes its folder.</p>`;
  return [
    keyed('header', 'project-head', 'class="section"', `<p class="crumbs"><a href="#/projects">Projects</a></p><h1 tabindex="-1">${chipHtml(ws, project.id, true)} ${esc(project.name)}</h1><p class="lede"><code>${esc(project.repoPath)}</code></p>`),
    keyed('section', 'project-readiness', 'class="section card" aria-label="Task readiness"', setupStatus),
    checkBlock,
    keyed('section', 'project-people', 'class="section card" aria-labelledby="people-title"', `<h2 id="people-title">Worker access</h2>${people}`),
    keyed('section', 'project-history', 'class="section" aria-labelledby="history-title"', `<h2 id="history-title">History</h2>${mine.length ? `<ul class="rows" role="list">${mine.map((entry) => taskRowHtml(ws, entry, now, { showProject: false })).join('')}</ul>` : `<p class="quiet-line">${esc(EMPTY.history)}</p>`}`),
    keyed('section', 'project-actions', 'class="section"', `${ui.actionError?.key === `project:${project.id}` ? errorHtml(ui.actionError.error) : ''}${actions}`),
  ].join('');
}
