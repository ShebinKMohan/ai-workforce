/**
 * Departments: a card per department, and the editor. Nothing is saved until
 * Create or Save, and a save is one compare-and-swap write of workspace
 * operations; the page ticks nothing until it has read the file back.
 */
import { esc, keyed } from '../render.js';
import { floorModel } from '../office/floor-model.js';
import { agentTool, departmentHead, departmentLabel, departmentReadiness, departmentWorkers, draftIssues, draftNotes, draftOps, draftPreview, runtimeBoundary } from '../model.js';
import { COLOR_HEX, COLOR_ORDER, EMPTY, plural } from '../words.js';
import { catalogForRuntime, effortChoices, modelChoices } from '../runtime-model-options.js';
import { chipHtml, emptyHtml, errorHtml, pageHead, toggleHtml } from './common.js';

export function renderDepartments(ctx) {
  const { ws, runsDoc, entries } = ctx;
  const create = ws.liveProjects.length ? '<a class="button button-primary" href="#/departments/new">Create a department</a>' : '<span class="muted small">Add a project before creating a department.</span>';
  if (!ws.ok) return pageHead('departments-head', 'Departments', 'The workspace file could not be read.');
  if (ws.liveDepartments.length === 0) return [pageHead('departments-head', 'Departments'), emptyHtml('departments-empty', EMPTY.departments, create)].join('');
  const floor = floorModel(ws, runsDoc, entries);
  const readiness = new Map(departmentReadiness(ws).map((line) => [line.departmentId, line]));
  const cards = ws.liveDepartments.map((department) => {
    const tile = floor.departments.find((entry) => entry.id === department.id);
    const statusOf = (agentId) => tile?.desks.find((desk) => desk.agentId === agentId);
    const head = departmentHead(ws, department.id);
    const workers = departmentWorkers(ws, department.id);
    const person = (agent, role) => {
      const desk = statusOf(agent.id);
      const tool = agentTool(ws, agent);
      const chips = agent.projectIds.map((projectId) => chipHtml(ws, projectId, true)).join('');
      return `<li><span><strong>${esc(agent.name)}</strong> <span class="muted">${role} · ${esc(tool.name)}</span></span><span>${chips} <span class="tone-${esc(desk?.tone ?? 'neutral')}">${esc(desk?.statusWord ?? 'Available')}</span></span></li>`;
    };
    const line = readiness.get(department.id);
    const inner = `<div class="section-head"><h3><span class="dot" aria-hidden="true"></span> ${esc(departmentLabel(ws, department))}</h3><a class="button button-small" href="#/departments/${esc(department.id)}">Edit</a></div>
      <p class="muted small">${esc(line?.text ?? '')}</p>
      <ul class="people">${head ? person(head, 'department head') : '<li class="muted">No department head yet.</li>'}${workers.map((worker) => person(worker, worker.projectIds.length ? 'worker' : 'worker, on the bench')).join('')}</ul>`;
    return keyed('li', `department:${department.id}`, `class="card dept-card" style="--tile-dot:${COLOR_HEX[department.color] ?? '#819b92'}"`, inner);
  });
  return [pageHead('departments-head', 'Departments', 'A department head decides who does each task. Workers change their own copy of a project.', `<div class="button-row">${create}</div>`), keyed('section', 'departments-list', 'class="section"', `<ul class="dept-cards" role="list">${cards.join('')}</ul>`)].join('');
}

function toolOptions(ws, selected) {
  const runtimeIds = Object.keys(ws.config?.runtimes ?? {});
  if (selected && !runtimeIds.includes(selected)) runtimeIds.push(selected);
  return runtimeIds
    .map((runtimeId) => {
      const tool = agentTool(ws, { runtime: runtimeId });
      const binding = ws.config?.runtimes?.[runtimeId];
      return `<option value="${esc(runtimeId)}" ${runtimeId === selected ? 'selected' : ''}>${esc(tool.name)} · ${esc(runtimeId)} · ${esc(binding ? tool.word : 'not configured')}</option>`;
    })
    .join('');
}

function boundaryLine(ws, runtimeId) {
  const boundary = runtimeBoundary(ws, runtimeId);
  const tool = agentTool(ws, { runtime: runtimeId });
  return boundary.verified
    ? `Reads and plans only. ${tool.name} cannot change files here (checked for this tool).`
    : `Reads and plans. ${tool.name} is given only reading tools, but it has no enforced file boundary, so this is not guaranteed, and this department's tasks run on their own.`;
}

function runtimeOverrides(ctx, agent, path, prefix) {
  const binding = ctx.ws.config?.runtimes?.[agent.tool];
  const catalog = catalogForRuntime(ctx.ui.modelCatalogs, agent.tool, binding);
  const model = modelChoices(catalog, agent.model ?? '', { inheritLabel: 'Inherit binding default', inheritedModel: binding?.model ?? '' });
  const effort = effortChoices(catalog, agent.model ?? '', agent.effort ?? '', { inheritLabel: 'Inherit binding default', inheritedModel: binding?.model ?? '', inheritedEffort: binding?.effort ?? '' });
  const field = (name, label, choices, selected) => `<div class="field"><label for="${prefix}-${name}">${label}</label><select id="${prefix}-${name}" data-bind="draft:${path}.${name}" data-rerender aria-describedby="${prefix}-${name}-hint" ${choices.disabled ? 'disabled' : ''}>${choices.options.map((option) => `<option value="${esc(option.value)}" ${option.value === selected ? 'selected' : ''} ${option.unavailable ? 'disabled' : ''}>${esc(option.label)}</option>`).join('')}</select><span id="${prefix}-${name}-hint" class="hint" aria-live="polite">${esc(choices.hint)}</span></div>`;
  const refresh = binding ? `<div class="button-row"><button type="button" class="link-button" data-action="refresh-models" data-runtime="${esc(agent.tool)}" ${catalog?.status === 'loading' ? 'disabled' : ''}>${catalog?.status === 'loading' ? 'Reading models…' : 'Refresh model choices'}</button></div>` : '';
  return `<div class="editor-grid">${field('model', 'Model', model, agent.model ?? '')}${field('effort', 'Reasoning effort', effort, agent.effort ?? '')}</div>${refresh}`;
}

export function renderDepartmentEditor(ctx) {
  const { ws, ui } = ctx;
  const draftKey = ctx.route.departmentId ?? 'new';
  const draft = ui.drafts.get(draftKey);
  if (!ws.ok) return pageHead('editor-head', 'Department', 'The workspace file could not be read, so nothing can be changed from this page.');
  if (!draft) return [pageHead('editor-head', 'Department not found', 'This department is not in the workspace.'), '<p><a href="#/departments">All departments</a></p>'].join('');
  const isNew = draft.id === null;
  const department = isNew ? null : ws.departmentById.get(draft.id);
  const issues = draftIssues(ws, draft);
  const notes = draftNotes(ws, draft);
  const preview = draftPreview(ws, draft);
  const ops = draftOps(ws, draft);
  const title = isNew ? 'Create a department' : `Edit ${departmentLabel(ws, department)}`;
  const error = ui.editorError?.key === draftKey ? ui.editorError.error : null;
  const conflict = error && (error.code === 'workspace_revision_conflict' || error.code === 'workspace_changed_on_disk');
  const conflictActions = conflict ? '<div class="button-row" style="margin-top:8px"><button type="button" class="button" data-action="save-department" data-again="true">Apply my edits to the new version</button><button type="button" class="link-button" data-action="discard-draft">Discard my edits</button></div>' : '';
  const suggestion = isNew && draft.suggested ? `<div class="notice"><p>Suggested from the coding tools found on this computer. Change anything; nothing is saved until you click Create.</p>${draft.suggestionNote ? `<p class="muted small">${esc(draft.suggestionNote)}</p>` : ''}</div>` : '';

  const colours = `<fieldset><legend>Colour</legend><div class="swatches">${COLOR_ORDER.map((color) => `<label class="swatch"><input type="radio" name="dept-color" value="${color}" data-bind="draft:color" data-rerender ${draft.color === color ? 'checked' : ''}><span class="dot" style="background:${COLOR_HEX[color]}" aria-hidden="true"></span>${color}</label>`).join('')}</div></fieldset>`;
  const identity = `<div class="editor-grid"><div class="field"><label for="dept-name">Name</label><input type="text" id="dept-name" data-bind="draft:name" data-rerender value="${esc(draft.name)}" maxlength="60"></div>
    <div class="field"><label for="dept-note">Note</label><span class="hint">Only needed if two departments share a name.</span><input type="text" id="dept-note" data-bind="draft:note" data-rerender value="${esc(draft.note)}" maxlength="60"></div></div>${colours}`;

  const more = ui.expanded.has(`more:${draftKey}`);
  const headBlock = `<div class="editor-section"><h2>Department head</h2><p class="muted small">${esc(boundaryLine(ws, draft.head.tool))}</p>
    <div class="editor-grid"><div class="field"><label for="head-name">Name</label><input type="text" id="head-name" data-bind="draft:head.name" data-rerender value="${esc(draft.head.name)}" maxlength="60"></div>
    <div class="field"><label for="head-tool">Runtime</label><select id="head-tool" data-bind="draft:head.tool" data-rerender>${toolOptions(ws, draft.head.tool)}</select></div></div>
    ${more ? `${runtimeOverrides(ctx, draft.head, 'head', 'head')}
    <div class="field"><label for="head-instructions">Instructions</label><span class="hint">Leave empty for the standard instructions.</span><textarea id="head-instructions" data-bind="draft:head.instructions">${esc(draft.head.instructions)}</textarea></div>` : ''}</div>`;

  const projects = ws.liveProjects;
  const workers = draft.workers
    .map((worker, index) => {
      const checks = projects.length
        ? `<fieldset><legend>${esc(worker.name.trim() || `Worker ${index + 1}`)} works on</legend><div class="project-checks">${projects.map((project) => `<label class="check-row"><input type="checkbox" id="worker-${index}-project-${esc(project.id)}" data-bind="draft:workers.${index}.projects" data-project="${esc(project.id)}" data-rerender ${worker.projectIds.includes(project.id) ? 'checked' : ''} aria-label="${esc(worker.name.trim() || `Worker ${index + 1}`)} works on ${esc(project.name)}"> <span>${esc(project.name)}</span></label>`).join('')}</div></fieldset>`
        : '<p class="muted small">Add a project first, then tick it here.</p>';
      const extra = more
        ? `${runtimeOverrides(ctx, worker, `workers.${index}`, `worker-${index}`)}<div class="editor-grid"><div class="field"><label for="worker-${index}-policy">Files</label><select id="worker-${index}-policy" data-bind="draft:workers.${index}.policy" data-rerender><option value="local-development" ${worker.policy === 'local-development' ? 'selected' : ''}>Can change files in its copy</option><option value="analysis" ${worker.policy === 'analysis' ? 'selected' : ''}>Reads only</option></select></div></div>
          <div class="field"><label for="worker-${index}-instructions">Instructions</label><span class="hint">Leave empty for the standard instructions.</span><textarea id="worker-${index}-instructions" data-bind="draft:workers.${index}.instructions">${esc(worker.instructions)}</textarea></div>`
        : '';
      return `<div class="worker-card"><div class="worker-card-head"><strong>${esc(worker.name.trim() || `Worker ${index + 1}`)}</strong><button type="button" class="link-button" data-action="remove-worker" data-index="${index}">${worker.id ? 'Archive' : 'Remove'}</button></div>
        <div class="editor-grid"><div class="field"><label for="worker-${index}-name">Name</label><input type="text" id="worker-${index}-name" data-bind="draft:workers.${index}.name" data-rerender value="${esc(worker.name)}" maxlength="60"></div>
        <div class="field"><label for="worker-${index}-tool">Runtime</label><select id="worker-${index}-tool" data-bind="draft:workers.${index}.tool" data-rerender>${toolOptions(ws, worker.tool)}</select></div></div>${checks}${extra}</div>`;
    })
    .join('');
  const archived = draft.archivedWorkers.length ? `<p class="muted small">Archived when you save: ${esc(draft.archivedWorkers.map((id) => ws.agentById.get(id)?.name ?? id).join(', '))}. Their history stays. <button type="button" class="link-button" data-action="restore-workers">Undo</button></p>` : '';
  const workersBlock = `<div class="editor-section"><h2>Workers</h2><p class="muted small">Workers change files, each in its own copy, and only on the projects you tick.</p>${workers}${archived}<button type="button" class="button" data-action="add-worker">+ Add worker</button></div>`;
  const moreToggle = `<div class="more">${toggleHtml(`more:${draftKey}`, more, 'More options: model, effort, instructions, file access', 'Fewer options', 'editor-form')}</div>`;

  const previewBlock = keyed(
    'section',
    'editor-preview',
    'class="section card card-quiet" aria-labelledby="preview-title"',
    `<div class="section-head"><h2 id="preview-title">What ${esc(draft.name.trim() || 'this department')} will be able to take</h2><span class="muted small">preview, not saved</span></div>
    ${preview.length ? `<ul class="preview-list">${preview.map((line) => `<li class="${line.ok ? '' : 'muted'}">${esc(line.text)}</li>`).join('')}</ul>` : '<p class="muted">No project yet.</p>'}
    ${notes.length ? `<ul class="preview-list">${notes.map((note) => `<li class="tone-attention">${esc(note)}</li>`).join('')}</ul>` : ''}`,
  );
  const archiveBlock =
    !isNew && department
      ? ui.confirm === `archive-department:${draft.id}`
        ? `<div class="button-row"><span>Archive ${esc(department.name)}? It takes no new tasks; its people and history stay readable.</span><button type="button" class="button" data-action="archive-department" data-id="${esc(draft.id)}">Archive</button><button type="button" class="link-button" data-action="confirm-cancel">Cancel</button></div>`
        : `<button type="button" class="link-button" data-action="confirm" data-confirm="archive-department:${esc(draft.id)}">Archive this department</button>`
      : '';
  const saveBar = keyed(
    'div',
    'editor-save',
    'class="save-bar"',
    `<div>${issues.length ? `<ul class="small tone-attention" style="margin:0;padding-left:18px">${issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul>` : `<span class="muted">${ops.length ? 'Not saved yet.' : 'No changes.'}</span>`}</div>
    <div class="button-row"><a class="button" href="${isNew ? '#/home' : '#/departments'}" data-action="discard-draft">Cancel</a><button type="button" class="button button-primary" data-action="save-department" ${issues.length || ops.length === 0 || ui.saving ? 'disabled' : ''}>${ui.saving ? 'Saving…' : isNew ? 'Create department' : 'Save changes'}</button></div>`,
  );
  return [
    keyed('header', 'editor-head', 'class="section"', `<p class="crumbs"><a href="#/departments">Departments</a></p><h1 tabindex="-1">${esc(title)}</h1><p class="lede">A department is a department head and the workers it hands tasks to.</p>${suggestion}`),
    keyed('section', `editor-form:${draftKey}`, 'class="section card" id="editor-form"', `${identity}${headBlock}${workersBlock}${moreToggle}`),
    previewBlock,
    keyed('section', 'editor-errors', 'class="section"', `${error ? errorHtml(error, { conflictActions }) : ''}${archiveBlock}`),
    saveBar,
  ].join('');
}

export { plural };
