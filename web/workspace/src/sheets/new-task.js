/**
 * The New task sheet: project, department (only those that can take that
 * project), the task text, a passive "Before it starts" look, and an explicit
 * consent box, off by default, when anyone on the roster uses a coding tool
 * without a verified file boundary.
 */
import { esc } from '../render.js';
import { departmentHead, departmentLabel, joinWords, pairBlockers, pairSendable, projectChecks, projectName, runtimeBoundary } from '../model.js';
import { plural, toolName } from '../words.js';
import { errorHtml } from '../pages/common.js';

/** Who would take a task for this pair, and what a start would meet. Passive: reads documents only. */
export function beforeStartModel(ws, requestsDoc, projectId, departmentId) {
  if (!projectId || !departmentId) return null;
  const head = departmentHead(ws, departmentId);
  const workers = ws.liveAgents.filter((agent) => agent.role === 'worker' && agent.departmentId === departmentId && agent.projectIds.includes(projectId));
  const project = projectName(ws, projectId);
  const checks = projectChecks(ws, projectId);
  const configured = ws.projectById.get(projectId)?.checks ?? [];
  const lines = [];
  lines.push(`Starts from your last commit on ${project}. Changes you have not committed are not included, and your folder is not changed.`);
  if (configured.length) lines.push(`Checks the verifier will run: ${configured.join(' · ')}`);
  else if (checks.count) lines.push(`Checks the verifier will run: ${plural(checks.count, 'check')} found in the project at your last commit.`);
  if (head && workers.length === 1) lines.push(`${head.name} will read the task and give it to ${workers[0].name}, the only worker on ${project} (one planning call).`);
  else if (head && workers.length > 1) lines.push(`${head.name} will read the task and give it to ${joinWords(workers.map((worker) => worker.name)).replace(/ and ([^,]+)$/, ' or $1')}, or split it into parts (one planning call).`);

  const roster = [...(head ? [head] : []), ...workers];
  const unbounded = roster.filter((agent) => !runtimeBoundary(ws, agent.runtime).verified);
  const tools = [...new Set(unbounded.map((agent) => toolName(runtimeBoundary(ws, agent.runtime).adapter)))];
  const runsOnItsOwn = unbounded.length > 0;

  const live = Array.isArray(requestsDoc?.live) ? requestsDoc.live : [];
  const items = Array.isArray(requestsDoc?.items) ? requestsDoc.items : [];
  const limit = requestsDoc?.limits?.maxConcurrentProjectRuns ?? ws.limits?.maxConcurrentProjectRuns ?? 2;
  const ahead = items.filter((item) => item.state === 'queued' && item.projectId === projectId).length;
  const busy = live.find((run) => run.workerIds?.some((id) => workers.some((worker) => worker.id === id)));
  let queue;
  if (requestsDoc && requestsDoc.accepting === false) queue = 'This page server does not start tasks for this workspace, so it cannot send one.';
  else if (live.some((run) => run.projectId === projectId)) queue = `It waits: another task is running on ${project}. Tasks on one project run one at a time.`;
  else if (ahead > 0) queue = `It waits behind ${plural(ahead, 'earlier task')} for ${project}.`;
  else if (live.some((run) => run.runsOnItsOwn)) queue = 'It waits: a task that runs on its own is running, so nothing starts beside it.';
  else if (runsOnItsOwn && live.length > 0) queue = `It waits until the ${plural(live.length, 'running task')} ${live.length === 1 ? 'finishes' : 'finish'}, because it runs on its own.`;
  else if (live.length >= limit) queue = `It waits: ${live.length} tasks are already running (your limit is ${limit}).`;
  else if (busy) queue = `It waits: a worker on this task is busy on ${projectName(ws, busy.projectId)}.`;
  else queue = 'It starts right away.';

  return {
    head,
    workers,
    lines,
    queue,
    runsOnItsOwn,
    consent: runsOnItsOwn
      ? {
          tools,
          names: unbounded.map((agent) => agent.name),
          text: `${joinWords(unbounded.map((agent) => agent.name))} ${unbounded.length === 1 ? 'uses' : 'use'} ${joinWords(tools)}. AI Workforce cannot keep ${joinWords(tools)}'s changes inside its own copy, so ${unbounded.length === 1 ? 'it' : 'they'} could change files elsewhere on this computer, including other projects' copies and AI Workforce's own files. While this task runs, no other task starts, and it starts only when nothing else is running.`,
          label: `Let ${joinWords(tools)} change files without that boundary for this task`,
        }
      : null,
    blocked: requestsDoc?.accepting === false,
  };
}

export function sheetDefaults(ws, preset = {}) {
  const projects = ws.liveProjects;
  const projectId = preset.projectId ?? (projects.find((project) => ws.liveDepartments.some((department) => pairSendable(ws, department.id, project.id)))?.id ?? projects[0]?.id ?? null);
  const departmentId = preset.departmentId ?? (projectId ? ws.liveDepartments.find((department) => pairSendable(ws, department.id, projectId))?.id ?? null : null);
  return { name: 'new-task', projectId, departmentId, text: '', consent: false, sending: false, error: null };
}

export function renderNewTaskSheet(ctx, sheet) {
  const { ws, requestsDoc } = ctx;
  const projects = ws.liveProjects;
  let projectField;
  if (projects.length === 1) {
    projectField = `<div class="field"><span class="label">Project</span><span>${esc(projects[0].name)} <span class="muted">(your only project)</span></span></div>`;
  } else {
    projectField = `<fieldset><legend>Project</legend>${projects
      .map((project) => {
        const sendable = ws.liveDepartments.some((department) => pairSendable(ws, department.id, project.id));
        const checks = projectChecks(ws, project.id);
        const reason = sendable ? '' : checks.count === 0 ? 'No checks yet, so nothing there could be verified.' : checks.count === null ? 'Its checks could not be read.' : 'No department can take tasks on it yet.';
        return `<label class="choice${sendable ? '' : ' is-disabled'}"><input type="radio" name="sheet-project" id="sheet-project-${esc(project.id)}" value="${esc(project.id)}" data-bind="sheet:projectId" data-rerender ${sheet.projectId === project.id ? 'checked' : ''} ${sendable ? '' : 'disabled'}><span class="choice-body"><span>${esc(project.name)}</span>${reason ? `<span class="muted">${esc(reason)} ${checks.count === 0 ? `<a href="#/projects/${esc(project.id)}" data-action="close-sheet">Add a check</a>` : ''}</span>` : ''}</span></label>`;
      })
      .join('')}</fieldset>`;
  }
  const departments = ws.liveDepartments;
  const departmentField = sheet.projectId
    ? `<fieldset><legend>Department</legend>${departments.length === 0 ? '<p class="muted">No department yet. <a href="#/departments/new" data-action="close-sheet">Create a department</a></p>' : ''}${departments
        .map((department) => {
          const sendable = pairSendable(ws, department.id, sheet.projectId);
          const head = departmentHead(ws, department.id);
          const workers = ws.liveAgents.filter((agent) => agent.role === 'worker' && agent.departmentId === department.id && agent.projectIds.includes(sheet.projectId));
          const who = sendable ? `Department head ${head?.name ?? ''} · ${joinWords(workers.map((worker) => worker.name))} ${workers.length === 1 ? 'works' : 'work'} on ${projectName(ws, sheet.projectId)}` : pairBlockers(ws, department.id, sheet.projectId)[0] ?? '';
          return `<label class="choice${sendable ? '' : ' is-disabled'}"><input type="radio" name="sheet-department" id="sheet-department-${esc(department.id)}" value="${esc(department.id)}" data-bind="sheet:departmentId" data-rerender ${sheet.departmentId === department.id ? 'checked' : ''} ${sendable ? '' : 'disabled'}><span class="choice-body"><span>${esc(departmentLabel(ws, department))}</span><span class="muted">${esc(who)}</span></span></label>`;
        })
        .join('')}</fieldset>`
    : '';
  const before = beforeStartModel(ws, requestsDoc, sheet.projectId, sheet.departmentId);
  const consentNeeded = Boolean(before?.consent);
  const textOk = sheet.text.trim().length > 0;
  const canSend = Boolean(before) && pairSendable(ws, sheet.departmentId, sheet.projectId) && textOk && (!consentNeeded || sheet.consent) && !sheet.sending && !before.blocked;
  const beforeBlock = before
    ? `<section class="card card-quiet before-start" data-sheet-live aria-labelledby="before-title"><div class="section-head"><h2 id="before-title">Before it starts</h2><span class="muted small">looked at, nothing started</span></div>
      <ul>${before.lines.map((line) => `<li>${esc(line)}</li>`).join('')}<li>${esc(before.queue)}</li></ul>
      ${before.consent ? `<div class="notice notice-attention"><p>${esc(before.consent.text)}</p><label class="check-row"><input type="checkbox" id="sheet-consent" data-bind="sheet:consent" data-rerender ${sheet.consent ? 'checked' : ''}> <span>${esc(before.consent.label)}</span></label>${sheet.consent ? '' : '<p class="small muted">Without this, the task is not sent.</p>'}</div>` : ''}</section>`
    : '<p class="muted" data-sheet-live>Choose a project and a department to see who takes the task.</p>';
  const headName = before?.head?.name ?? 'the department head';
  const body = `${projectField}${departmentField}
    <div class="field"><label for="sheet-text">What should be done?</label><textarea id="sheet-text" data-bind="sheet:text" data-rerender placeholder="Describe the change the way you would tell a colleague." maxlength="64000">${esc(sheet.text)}</textarea></div>
    ${beforeBlock}
    ${sheet.error ? errorHtml(sheet.error) : ''}`;
  return `<div class="sheet-head"><h2 id="sheet-title">New task</h2><button type="button" class="button button-small" data-action="close-sheet">Close</button></div>
    <div class="sheet-body">${body}</div>
    <div class="sheet-foot"><span class="muted">${textOk ? '' : 'Describe the task to send it.'}</span><button type="button" class="button" data-action="close-sheet">Cancel</button><button type="button" class="button button-primary" data-action="send-task" ${canSend ? '' : 'disabled'}>${sheet.sending ? 'Sending…' : `Send to ${esc(headName)}`}</button></div>`;
}
