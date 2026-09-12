/**
 * The setup checklist, from GET /api/workspace readiness: four steps, only the
 * first incomplete step has a primary action, and nothing counts as done until
 * the saved file says so.
 */
import { describe, expect, it } from 'vitest';
import { renderHome } from '../../web/workspace/src/pages/home.js';
import { departmentReadiness, indexWorkspace, pairBlockers, setupModel } from '../../web/workspace/src/model.js';
import { clone, contextFor, fixture, visibleText } from './support.js';

const primaryActions = (setup) => setup.rows.filter((row) => row.action !== null);

describe('a fresh install', () => {
  const ws = indexWorkspace(fixture('workspace-empty.json'));
  const setup = setupModel(ws, fixture('requests-empty.json'), fixture('runs-empty.json'));

  it('shows the checklist at step 2 with exactly one primary action: Add a project', () => {
    expect(setup.showChecklist).toBe(true);
    expect(setup.stepNumber).toBe(2);
    expect(setup.rows.map((row) => [row.id, row.state])).toEqual([
      ['tools', 'done'],
      ['project', 'current'],
      ['department', 'locked'],
      ['send', 'locked'],
    ]);
    expect(primaryActions(setup).map((row) => [row.id, row.action.label])).toEqual([['project', 'Add a project']]);
    expect(setup.rows[0].quiet).toMatchObject({ label: 'Check again' });
    expect(setup.rows[0].tools.map((tool) => tool.line)).toEqual(['Codex 0.147.0 · signed in (as the tool reports)', 'Claude Code 2.1.260 · signed out. To use it, run: claude auth login']);
  });

  it('renders Welcome, the checklist, How a task moves and an empty office, and no top-bar primary button', () => {
    const html = renderHome(contextFor(fixture('workspace-empty.json'), fixture('runs-empty.json'), fixture('requests-empty.json')));
    const text = visibleText(html);
    expect(text).toContain('Welcome to Workforce');
    expect(text).toContain('You send it to a department.');
    expect(text).toContain('Only checks the verifier runs can mark work verified.');
    expect(html.match(/button-primary/g)).toHaveLength(1);
  });

  it('with no coding tool ready, step 1 is current and adding a project stays possible as a secondary action', () => {
    const doc = clone(fixture('workspace-empty.json'));
    for (const report of doc.runtimes.reports) Object.assign(report, { auth: 'logged_out', usable: false });
    doc.readiness.steps = [
      { id: 'tools', state: 'current', reason: 'x' },
      { id: 'project', state: 'locked', reason: 'x' },
      { id: 'department', state: 'locked', reason: 'x' },
      { id: 'send', state: 'locked', reason: 'x' },
    ];
    const noTools = setupModel(indexWorkspace(doc), null, null);
    expect(primaryActions(noTools).map((row) => row.id)).toEqual(['tools']);
    expect(noTools.rows.find((row) => row.id === 'project').secondary).toMatchObject({ sheet: 'add-project' });
  });
});

describe('after a project with a check is added', () => {
  it('step 3 is next and links to the department editor', () => {
    const setup = setupModel(indexWorkspace(fixture('workspace-starter.json')), fixture('requests-empty.json'), fixture('runs-empty.json'));
    expect(setup.stepNumber).toBe(3);
    expect(primaryActions(setup).map((row) => [row.id, row.action.href])).toEqual([['department', '#/departments/new']]);
  });

  it('a project with no check keeps step 2 open, and says why', () => {
    const doc = clone(fixture('workspace-starter.json'));
    doc.checks = doc.checks.map((fact) => ({ ...fact, count: 0, source: 'none' }));
    doc.readiness.steps[1] = { id: 'project', state: 'current', reason: 'no project has an acceptance check' };
    doc.readiness.steps[2] = { id: 'department', state: 'locked', reason: 'x' };
    const setup = setupModel(indexWorkspace(doc), null, null);
    expect(setup.stepNumber).toBe(2);
    expect(setup.rows.find((row) => row.id === 'project').lines[0].text).toBe('Storefront is added, but has no checks yet, so nothing in it could be verified.');
  });
});

describe('a workspace that can take tasks', () => {
  const ws = indexWorkspace(fixture('workspace.json'));

  it('hides the checklist, and before the first task shows the ready card with each department\'s reach', () => {
    const setup = setupModel(ws, fixture('requests-empty.json'), fixture('runs-empty.json'));
    expect(setup.showChecklist).toBe(false);
    expect(setup.readyCard.lines.map((line) => line.text)).toEqual(['Engineering can take tasks on Storefront and docs-site.', 'Design cannot take tasks yet. Vera, the department head, uses Claude Code, which is signed out.']);
  });

  it('drops the ready card once a task exists', () => {
    expect(setupModel(ws, fixture('requests.json'), fixture('runs.json')).readyCard).toBeNull();
  });

  it('explains a blocked pair in plain words', () => {
    expect(pairBlockers(ws, 'eng', 'notes')).toEqual(['Nobody in Engineering works on notes.', 'notes has no checks yet, so nothing there could be verified.']);
    expect(pairBlockers(ws, 'eng', 'app')).toEqual([]);
    expect(departmentReadiness(ws)[0].ok).toBe(true);
  });
});
