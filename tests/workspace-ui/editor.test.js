/**
 * The department editor and the New task sheet, against the real workspace
 * operations: whatever the editor would send must be accepted by the same
 * `applyWorkspaceOps` the server and the CLI use, and must build exactly the
 * department shown.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkspace } from '../../src/core/workspace-config.ts';
import { applyWorkspaceOps, parseWorkspaceOps, standardRuntimeId } from '../../src/workspace/operations.ts';
import { draftIssues, draftOps, draftPreview, editDepartmentDraft, indexWorkspace, newDepartmentDraft } from '../../web/workspace/src/model.js';
import { renderDepartmentEditor } from '../../web/workspace/src/pages/departments.js';
import { beforeStartModel, renderNewTaskSheet, sheetDefaults } from '../../web/workspace/src/sheets/new-task.js';
import { clone, contextFor, fixture, uiState, visibleText } from './support.js';

/** What the server does with the page's ops: standard tool names become runtime ids, then the operations run. */
function applyAsServer(config, ops) {
  const normalized = ops.map((op) => (op.op === 'agent.add' || (op.op === 'agent.edit' && op.runtime) ? { ...op, runtime: standardRuntimeId(op.runtime) } : op));
  const next = applyWorkspaceOps(config, parseWorkspaceOps(normalized));
  const validation = validateWorkspace({ ...next, revision: config.revision + 1 });
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return next;
}

describe('creating the first department', () => {
  const ws = indexWorkspace(fixture('workspace-starter.json'));

  it('starts from the server\'s suggestion: Engineering, the department head on Codex, the worker ticked on the project', () => {
    const draft = newDepartmentDraft(ws);
    expect(draft).toMatchObject({ id: null, name: 'Engineering', color: 'blue', suggested: true, head: { tool: 'codex-local', effort: '' } });
    expect(draft.workers).toHaveLength(1);
    expect(draft.workers[0]).toMatchObject({ tool: 'codex-local', effort: '', projectIds: ['storefront'] });
    expect(draftIssues(ws, draft)).toEqual([]);
    expect(draftPreview(ws, draft)[0].text).toBe('Engineering head reads every task and gives it to Engineering worker, the only worker on Storefront (one planning call per task).');
  });

  it('sends operations the workspace accepts, building exactly what was shown', () => {
    const draft = newDepartmentDraft(ws);
    draft.workers.push({ id: null, key: 'w2', name: 'Reviewer bot', tool: 'claude-code', model: '', instructions: '', policy: 'analysis', projectIds: [] });
    const next = applyAsServer(ws.config, draftOps(ws, draft));
    const department = next.departments.find((entry) => entry.name === 'Engineering');
    expect(department.headAgentId).toBe('engineering-head');
    expect(next.agents.filter((agent) => agent.departmentId === department.id).map((agent) => [agent.name, agent.role, agent.runtime, agent.policy, agent.projectIds])).toEqual([
      ['Engineering head', 'head', 'codex-local', 'analysis', []],
      ['Engineering worker', 'worker', 'codex-local', 'local-development', ['storefront']],
      ['Reviewer bot', 'worker', 'claude-local', 'analysis', []],
    ]);
  });

  it('refuses a second department with the same name and no note, before anything is sent', () => {
    const built = indexWorkspace({ ...fixture('workspace.json') });
    const draft = newDepartmentDraft(built);
    draft.name = 'Engineering';
    expect(draftIssues(built, draft)).toContain('You already have a department called Engineering. Add a note to tell them apart.');
    draft.note = 'Payments';
    expect(draftIssues(built, draft)).toEqual([]);
    const next = applyAsServer(built.config, draftOps(built, draft));
    expect(next.departments.filter((entry) => entry.name === 'Engineering').map((entry) => entry.note ?? null)).toEqual([null, 'Payments']);
  });
});

describe('editing a department', () => {
  const ws = indexWorkspace(fixture('workspace.json'));

  it('moves workers between projects, adds and archives workers, through assign, unassign, add and archive', () => {
    const draft = editDepartmentDraft(ws, 'eng');
    expect(draft.workers.map((worker) => worker.id)).toEqual(['nova', 'mira', 'bench']);
    draft.workers[0].projectIds = ['app', 'docs-site'];
    draft.workers[1].projectIds = ['docs-site'];
    const [bench] = draft.workers.splice(2, 1);
    draft.archivedWorkers.push(bench.id);
    draft.workers.push({ id: null, key: 'new', name: 'Forge', tool: 'codex', model: '', instructions: '', policy: 'local-development', projectIds: ['app'] });
    const ops = draftOps(ws, draft);
    expect(ops.map((op) => op.op)).toEqual(['agent.assign', 'agent.unassign', 'agent.add', 'agent.archive']);
    const next = applyAsServer(ws.config, ops);
    const byId = new Map(next.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('nova').projectIds).toEqual(['app', 'docs-site']);
    expect(byId.get('mira').projectIds).toEqual(['docs-site']);
    expect(byId.get('bench').archived).toBe(true);
    expect(byId.get('forge')).toMatchObject({ departmentId: 'eng', projectIds: ['app'], runtime: 'codex-local' });
  });

  it('sends nothing when nothing changed', () => {
    expect(draftOps(ws, editDepartmentDraft(ws, 'eng'))).toEqual([]);
  });
});

describe('department runtime settings', () => {
  function configuredDocument() {
    const doc = clone(fixture('workspace.json'));
    doc.workspace.runtimes['codex-primary'] = { adapter: 'codex', executable: '/opt/primary/codex', model: 'reported-main', effort: 'balanced' };
    doc.workspace.runtimes['codex-preview'] = { adapter: 'codex', executable: '/opt/preview/codex' };
    for (const agent of doc.workspace.agents) if (agent.departmentId === 'eng') agent.runtime = 'codex-primary';
    return doc;
  }

  function catalogFor(doc, runtimeId, models) {
    return { runtimeId, ...doc.workspace.runtimes[runtimeId], configuredExecutable: doc.workspace.runtimes[runtimeId].executable, status: 'available', models };
  }

  function editorContext(doc, catalogs = new Map()) {
    const ws = indexWorkspace(doc);
    const draft = editDepartmentDraft(ws, 'eng');
    const ui = uiState({ drafts: new Map([['eng', draft]]), expanded: new Set(['more:eng']), modelCatalogs: catalogs });
    return { ws, ui, route: { name: 'department', departmentId: 'eng' } };
  }

  const select = (html, id) => html.match(new RegExp(`<select id="${id}"[^>]*>[\\s\\S]*?</select>`))?.[0] ?? '';

  it('preserves exact installations and saved unknown settings, then saves an intentional binding change and clear', () => {
    const doc = configuredDocument();
    const head = doc.workspace.agents.find((agent) => agent.id === 'atlas');
    Object.assign(head, { model: 'saved-private-model', effort: 'saved-level' });
    const ws = indexWorkspace(doc);
    const draft = editDepartmentDraft(ws, 'eng');
    expect(draft.head).toMatchObject({ tool: 'codex-primary', model: 'saved-private-model', effort: 'saved-level' });
    expect(draftOps(ws, draft)).toEqual([]);
    draft.head.tool = 'codex-preview';
    draft.head.model = '';
    draft.head.effort = '';
    expect(draftOps(ws, draft)).toEqual([{ op: 'agent.edit', id: 'atlas', runtime: 'codex-preview', model: null, effort: null }]);
    const next = applyAsServer(ws.config, draftOps(ws, draft));
    expect(next.agents.find((agent) => agent.id === 'atlas')).toMatchObject({ runtime: 'codex-preview' });
    expect(next.agents.find((agent) => agent.id === 'atlas')).not.toHaveProperty('effort');
    expect(next.agents.find((agent) => agent.id === 'nova').runtime).toBe('codex-primary');
  });

  it('persists head and worker model and effort when creating a department or adding a worker', () => {
    const ws = indexWorkspace(fixture('workspace-starter.json'));
    const draft = newDepartmentDraft(ws);
    Object.assign(draft.head, { model: 'head-reported', effort: 'careful' });
    Object.assign(draft.workers[0], { model: 'worker-reported', effort: 'fast' });
    const next = applyAsServer(ws.config, draftOps(ws, draft));
    expect(next.agents.find((agent) => agent.role === 'head')).toMatchObject({ model: 'head-reported', effort: 'careful' });
    expect(next.agents.find((agent) => agent.role === 'worker')).toMatchObject({ model: 'worker-reported', effort: 'fast' });
    const updated = indexWorkspace({ ...fixture('workspace-starter.json'), workspace: next });
    const edit = editDepartmentDraft(updated, next.departments[0].id);
    edit.workers.push({ id: null, key: 'new', name: 'Additional worker', tool: 'codex-local', model: 'other-reported', effort: 'balanced', instructions: '', policy: 'analysis', projectIds: [] });
    expect(applyAsServer(next, draftOps(updated, edit)).agents.find((agent) => agent.name === 'Additional worker')).toMatchObject({ model: 'other-reported', effort: 'balanced' });
  });

  it('shows only models and reasoning choices reported for the exact selected binding and effective model', () => {
    const doc = configuredDocument();
    const models = [{ id: 'reported-main', label: 'Main reported model', efforts: ['balanced', 'careful'], effortStatus: 'reported', isDefault: true }, { id: 'reported-fast', label: 'Fast reported model', efforts: ['fast'], effortStatus: 'reported' }];
    const catalogs = new Map([['codex-primary', catalogFor(doc, 'codex-primary', models)], ['codex-preview', catalogFor(doc, 'codex-preview', [{ id: 'other-installation', label: 'Other installation model', efforts: [], effortStatus: 'unavailable' }])]]);
    const ctx = editorContext(doc, catalogs);
    const html = renderDepartmentEditor(ctx);
    expect(select(html, 'head-tool')).toContain('value="codex-primary" selected');
    expect(select(html, 'head-tool')).toContain('value="codex-preview"');
    expect(select(html, 'head-model')).toContain('value="reported-main"');
    expect(select(html, 'worker-0-model')).toContain('value="reported-fast"');
    expect(select(html, 'head-model')).not.toContain('other-installation');
    expect(select(html, 'head-effort')).toContain('value="balanced"');
    expect(select(html, 'worker-0-effort')).toContain('value="careful"');
    expect(select(html, 'head-effort')).not.toContain('value="fast"');
    expect(select(html, 'head-effort')).toContain('data-bind="draft:head.effort"');
    expect(select(html, 'worker-0-model')).toContain('data-bind="draft:workers.0.model"');
  });

  it('waits for the exact executable catalog, then keeps genuinely unavailable saved values visible and clearable', () => {
    const doc = configuredDocument();
    Object.assign(doc.workspace.agents.find((agent) => agent.id === 'atlas'), { model: 'saved-private-model', effort: 'saved-level' });
    const stale = { ...catalogFor(doc, 'codex-primary', [{ id: 'stale-model', label: 'Old installation model', efforts: ['stale-effort'], effortStatus: 'reported' }]), configuredExecutable: '/old/codex' };
    const ctx = editorContext(doc, new Map([['codex-primary', stale]]));
    let html = renderDepartmentEditor(ctx);
    expect(select(html, 'head-model')).toMatch(/value="saved-private-model" selected >saved-private-model · loading/);
    expect(select(html, 'head-effort')).toMatch(/value="saved-level" selected >saved-level · loading/);
    expect(select(html, 'head-model').split('>')[0]).toContain('disabled');
    expect(select(html, 'head-model')).toContain('value=""');
    expect(select(html, 'head-model')).not.toContain('stale-model');
    expect(select(html, 'head-effort')).not.toContain('stale-effort');
    expect(draftOps(ctx.ws, ctx.ui.drafts.get('eng'))).toEqual([]);
    ctx.ui.modelCatalogs.set('codex-primary', { ...catalogFor(doc, 'codex-primary', []), status: 'unavailable' });
    html = renderDepartmentEditor(ctx);
    expect(select(html, 'head-model')).toMatch(/value="saved-private-model" selected disabled>saved-private-model · unavailable/);
    expect(select(html, 'head-effort')).toMatch(/value="saved-level" selected disabled>saved-level · unavailable/);
    expect(select(html, 'head-model').split('>')[0]).not.toContain('disabled');
    expect(draftOps(ctx.ws, ctx.ui.drafts.get('eng'))).toEqual([]);
  });
});

describe('the New task sheet', () => {
  it('names who will take it, where it waits, and asks for consent, off by default, when a tool has no verified file boundary', () => {
    const ctx = contextFor(fixture('workspace.json'), fixture('runs-live.json'), fixture('requests-live.json'));
    const before = beforeStartModel(ctx.ws, ctx.requestsDoc, 'app', 'eng');
    expect(before.lines).toContain('Atlas will read the task and give it to Nova or Mira, or split it into parts (one planning call).');
    expect(before.queue).toBe('It waits: another task is running on Storefront. Tasks on one project run one at a time.');
    expect(before.consent.label).toBe('Let Test tool change files without that boundary for this task');

    const sheet = { ...sheetDefaults(ctx.ws), text: 'Add docs' };
    expect(sheet).toMatchObject({ projectId: 'app', departmentId: 'eng', consent: false });
    const closed = renderNewTaskSheet(ctx, sheet);
    expect(closed).toMatch(/data-action="send-task" disabled/);
    expect(visibleText(closed)).toContain('Without this, the task is not sent.');
    expect(renderNewTaskSheet(ctx, { ...sheet, consent: true })).not.toMatch(/data-action="send-task" disabled/);
  });

  it('offers only departments that can take the project, the rest disabled with their reason', () => {
    const ctx = contextFor(fixture('workspace.json'), fixture('runs.json'), fixture('requests.json'));
    const html = renderNewTaskSheet(ctx, { ...sheetDefaults(ctx.ws), text: 'x' });
    expect(html).toMatch(/id="sheet-department-design"[^>]*disabled/);
    expect(visibleText(html)).toContain('Vera, the department head, uses Claude Code, which is signed out.');
    expect(html).toMatch(/id="sheet-project-notes"[^>]*disabled/);
  });

  it('with a Codex-only roster there is no consent box and it starts right away', () => {
    const doc = clone(fixture('workspace.json'));
    for (const agent of doc.workspace.agents) if (agent.departmentId === 'eng') agent.runtime = 'codex-local';
    doc.workspace.runtimes['codex-local'] = { adapter: 'codex', executable: 'codex' };
    doc.runtimeRules['codex-local'] = { adapter: 'codex', executable: 'codex', writeContainment: 'verified', runsOnItsOwn: false };
    const ctx = contextFor(doc, fixture('runs.json'), fixture('requests-empty.json'));
    const before = beforeStartModel(ctx.ws, ctx.requestsDoc, 'app', 'eng');
    expect(before.consent).toBeNull();
    expect(before.queue).toBe('It starts right away.');
  });
});
