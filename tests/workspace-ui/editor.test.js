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
import { beforeStartModel, renderNewTaskSheet, sheetDefaults } from '../../web/workspace/src/sheets/new-task.js';
import { clone, contextFor, fixture, visibleText } from './support.js';

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
    expect(draft).toMatchObject({ id: null, name: 'Engineering', color: 'blue', suggested: true, head: { tool: 'codex' } });
    expect(draft.workers).toHaveLength(1);
    expect(draft.workers[0]).toMatchObject({ tool: 'codex', projectIds: ['storefront'] });
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
