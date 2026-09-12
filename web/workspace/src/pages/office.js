/** The selected office shell, backed by the same records and task intake as the workspace. */
import { esc, keyed } from '../render.js';
import { floorModel } from '../office/floor-model.js';
import { rasterOfficeHtml } from '../office/raster.js';
import { departmentHead, departmentLabel, projectName, toolFact } from '../model.js';
import { formatTime, statusHtml } from './common.js';
import { workspaceProblemHtml } from './home.js';

const CENTER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></svg>';
export const OFFICE_TABS = ['assign', 'tasks', 'connections'];

export function officeTaskGroups(ctx) {
  const departmentId = ctx.ui.officeDepartmentId || null;
  const entries = departmentId ? ctx.entries.filter((entry) => entry.departmentId === departmentId) : ctx.entries;
  const isQueued = (entry) => entry.item?.state === 'queued' || (entry.resumes ?? []).some((resume) => resume.state === 'queued');
  const review = ctx.needs.items.filter((item) => !departmentId || item.kind === 'tool' || entries.some((entry) => entry.href === item.href));
  const attentionHrefs = new Set(review.map((item) => item.href));
  return {
    review,
    running: entries.filter((entry) => entry.inMotion && !isQueued(entry)),
    queued: entries.filter(isQueued),
    finished: entries.filter((entry) => entry.finished && !attentionHrefs.has(entry.href)),
  };
}

function taskCard(ctx, entry) {
  const meta = [projectName(ctx.ws, entry.projectId), entry.departmentId ? departmentLabel(ctx.ws, entry.departmentId) : null].filter(Boolean).join(' · ');
  return `<li class="ao-task"><a href="${esc(entry.href)}"><div class="ao-task-status">${statusHtml(entry.status)}<time>${esc(formatTime(entry.at, ctx.now))}</time></div><strong>${esc(entry.title)}</strong><span class="ao-task-meta">${esc(meta)}</span>${entry.status.line ? `<p>${esc(entry.status.line)}</p>` : ''}<span class="ao-task-open">${entry.status.key === 'verified' ? 'Review checks and changes' : 'Open task'} <span aria-hidden="true">↗</span></span></a></li>`;
}

function attentionCard(ctx, item) {
  const entry = ctx.entries.find((entry) => entry.href === item.href);
  return entry ? taskCard(ctx, entry) : `<li class="ao-task"><a href="${esc(item.href || '#/settings')}">${statusHtml({ tone: item.tone, word: item.word })}<p>${esc(item.line)}</p><span class="ao-task-open">Open settings ↗</span></a></li>`;
}

function tasksPanel(ctx) {
  const groups = officeTaskGroups(ctx);
  const sections = [['review', 'Needs you', 'Nothing needs your attention.'], ['running', 'In motion', 'No task is running.'], ['queued', 'Queued', 'No task is waiting to start.'], ['finished', 'Recently finished', 'Finished tasks will appear here.']];
  return `<div class="ao-panel-heading"><span>Recorded work</span><a href="#/tasks">All tasks ↗</a></div>${sections.map(([key, title, empty]) => `<section class="ao-task-group"><header><h2>${title}</h2><span>${groups[key].length}</span></header>${groups[key].length ? `<ul>${groups[key].slice(0, key === 'finished' ? 4 : 8).map((entry) => key === 'review' ? attentionCard(ctx, entry) : taskCard(ctx, entry)).join('')}</ul>` : `<p class="ao-quiet">${empty}</p>`}</section>`).join('')}`;
}

function runtimeDock(ctx) {
  return `<div class="ao-runtime-dock"><div><span>INSTALLED CODING TOOLS</span><button type="button" data-action="office-tab" data-tab="connections" data-live-action>View connections ↗</button></div><div class="ao-runtime-buttons">${ctx.ws.reports.map((report) => { const fact = toolFact(ctx.ws, report.adapter); return `<button type="button" data-action="office-tab" data-tab="connections" data-live-action><span class="ao-tool-mark" aria-hidden="true">${report.adapter === 'codex' ? '◎' : '✳'}</span><span><strong>${esc(fact.name)}</strong> <small>${esc(fact.word)}</small></span></button>`; }).join('') || '<span class="ao-quiet">Check coding tools in Settings.</span>'}</div></div>`;
}

function connectionsPanel(ctx) {
  const tools = ctx.ws.reports.map((report) => {
    const fact = toolFact(ctx.ws, report.adapter);
    const agents = ctx.ws.liveAgents.filter((agent) => ctx.ws.config.runtimes[agent.runtime]?.adapter === report.adapter);
    return `<article class="ao-connection"><header><span class="ao-tool-mark" aria-hidden="true">${report.adapter === 'codex' ? '◎' : '✳'}</span><div><h2>${esc(fact.name)}</h2><span>${esc(fact.version || 'Version unavailable')}</span></div></header><p class="${fact.ready === false ? 'tone-attention' : ''}">${esc(fact.word)} <span class="ao-quiet">(as the tool reports)</span></p><p>${agents.length ? `${agents.length} configured ${agents.length === 1 ? 'agent uses' : 'agents use'} this tool.` : 'No agent is assigned to this tool.'}</p>${agents.length ? `<ul>${agents.map((agent) => `<li><a href="#/departments/${encodeURIComponent(agent.departmentId)}?agent=${encodeURIComponent(agent.id)}">${esc(agent.name)}</a><span>${esc(agent.model || ctx.ws.config.runtimes[agent.runtime]?.model || 'Tool default model')}</span></li>`).join('')}</ul>` : ''}${fact.loginHint && fact.ready === false ? `<p class="ao-quiet">To sign in: <code>${esc(fact.loginHint)}</code></p>` : ''}</article>`;
  }).join('');
  return `<div class="ao-panel-heading"><span>Local connections</span><button type="button" class="link-button" data-action="refresh-tools" data-live-action>Check again</button></div><p class="ao-quiet">Installation and sign-in checks do not start a model. A task records the tool and model it actually uses.</p>${ctx.ws.toolsCheckedAt ? `<p class="ao-quiet">Last checked ${esc(formatTime(ctx.ws.toolsCheckedAt, ctx.now))}.</p>` : ''}${ctx.ws.toolsError ? `<p class="notice notice-attention">Could not refresh coding tools: ${esc(ctx.ws.toolsError)}</p>` : ''}${tools || '<p class="ao-quiet">No coding tool has been reported yet.</p>'}<a class="ao-text-link" href="#/settings">Open tools and settings ↗</a>`;
}

function assignPanel(ctx) {
  const department = ctx.ui.officeDepartmentId ? ctx.ws.departmentById.get(ctx.ui.officeDepartmentId) : null;
  const head = department ? departmentHead(ctx.ws, department.id) : null;
  const groups = officeTaskGroups(ctx);
  return `<div class="ao-coordinator-intro"><span class="ao-center-avatar">${CENTER_ICON}</span><div><strong>${head ? esc(head.name) : 'Your department heads'}</strong><p>Good work starts with a clear task.</p><p class="ao-quiet">Describe what you want to change. Your department head plans the work, assigns the right worker, and the verifier checks the result.</p></div></div><div class="ao-suggestions"><span>A PLACE TO START</span><button type="button" data-action="office-tab" data-tab="tasks" data-live-action><span>See work in progress</span>↗</button><button type="button" data-action="office-tab" data-tab="tasks" data-live-action><span>${groups.review.length ? `${groups.review.length} ${groups.review.length === 1 ? 'item needs' : 'items need'} your attention` : 'Review task history'}</span>↗</button><button type="button" data-action="office-tab" data-tab="connections" data-live-action><span>How is the team connected?</span>↗</button></div><div class="ao-office-note"><div>${ctx.ws.liveAgents.slice(0, 4).map((agent) => `<span title="${esc(agent.name)}">${esc(agent.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join(''))}</span>`).join('')}</div><p>${ctx.ws.liveAgents.length} configured ${ctx.ws.liveAgents.length === 1 ? 'agent' : 'agents'}. ${ctx.ws.liveDepartments.length} ${ctx.ws.liveDepartments.length === 1 ? 'department' : 'departments'}.<br><span>One place to give work and follow the result.</span></p></div>`;
}

function composer(ctx) {
  if (!ctx.setup.allDone) return `<div class="ao-composer-wrap"><p class="ao-quiet">Add a project with checks and a department before assigning work.</p><a class="button button-primary" href="#/home">Finish workspace setup</a></div>`;
  const text = ctx.ui.officeDraft || '';
  const department = ctx.ui.officeDepartmentId ? departmentLabel(ctx.ws, ctx.ui.officeDepartmentId) : 'Choose project and team next';
  return `<div class="ao-composer-wrap"><div class="ao-composer"><label class="visually-hidden" for="office-task-text">Describe a task for your department head</label><textarea id="office-task-text" data-bind="office:task" maxlength="64000" placeholder="What should your team work on?">${esc(text)}</textarea><div><span>${esc(department)}</span><button type="button" class="ao-composer-send" data-action="office-compose" data-live-action aria-label="Review task before sending"${ctx.requestsDoc?.accepting === false ? ' disabled' : ''}>↗</button></div></div><p class="ao-composer-help">Review project, team and checks before sending.</p></div>`;
}

export function renderControlCenter(ctx) {
  const tab = OFFICE_TABS.includes(ctx.ui.officeTab) ? ctx.ui.officeTab : 'assign';
  const content = tab === 'tasks' ? tasksPanel(ctx) : tab === 'connections' ? connectionsPanel(ctx) : assignPanel(ctx);
  return `<aside class="ao-control-center" aria-label="Control center"><header class="ao-center-heading"><div><span class="ao-coordinator-kicker"><i></i> OFFICE COORDINATOR</span><span class="ao-local-label">LOCAL WORKSPACE</span></div><div class="ao-center-title"><h1 tabindex="-1">Control center<span>.</span></h1><span>${CENTER_ICON}</span></div><p>Plan, assign, and follow your team's work.</p></header><div class="ao-context-row"><span aria-hidden="true">⌖</span><label class="visually-hidden" for="office-department">Control center department</label><select id="office-department" data-bind="office:department" data-rerender><option value="">Whole office</option>${ctx.ws.liveDepartments.map((department) => `<option value="${esc(department.id)}"${ctx.ui.officeDepartmentId === department.id ? ' selected' : ''}>${esc(departmentLabel(ctx.ws, department))}</option>`).join('')}</select><a href="${ctx.ui.officeDepartmentId ? `#/departments/${encodeURIComponent(ctx.ui.officeDepartmentId)}` : '#/departments'}" aria-label="Open selected team">↗</a></div><div class="ao-center-tabs" role="tablist" aria-label="Control center views">${OFFICE_TABS.map((key) => `<button type="button" role="tab" id="office-tab-${key}" aria-controls="office-panel-${key}" aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}" data-action="office-tab" data-tab="${key}" data-live-action>${{ assign: 'Assign', tasks: 'Tasks', connections: 'Connections' }[key]} ${key === 'tasks' && ctx.needs.items.length ? `<span>${ctx.needs.items.length}</span>` : ''}</button>`).join('')}</div>${keyed('section', 'office-panel', `class="ao-center-scroll" id="office-panel-${tab}" role="tabpanel" aria-labelledby="office-tab-${tab}"`, content)}${tab === 'assign' ? composer(ctx) : ''}<footer class="ao-center-foot">${ctx.requestsDoc?.accepting === false ? 'This server is not accepting new tasks.' : 'Live coordinator records · independent checks'}</footer></aside>`;
}

export function renderOffice(ctx) {
  if (!ctx.ws.ok) return workspaceProblemHtml(ctx);
  const model = floorModel(ctx.ws, ctx.runsDoc, ctx.entries);
  const groups = officeTaskGroups({ ...ctx, ui: { ...ctx.ui, officeDepartmentId: null } });
  const scene = rasterOfficeHtml(model, { active: groups.running.length, queued: groups.queued.length }, { runtimeHtml: runtimeDock(ctx) });
  return keyed('div', 'spatial-office', 'class="ao-workspace spatial-office" data-spatial-office', `${keyed('div', 'office-canvas', 'class="ao-canvas-region"', scene)}${keyed('div', 'office-control', 'class="ao-control-region"', renderControlCenter(ctx))}`);
}
