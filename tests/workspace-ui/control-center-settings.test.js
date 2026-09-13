import { describe, expect, it } from 'vitest';
import { buildControlCenterOp, controlCenterDefaults } from '../../web/workspace/src/control-center-settings.js';
import { renderControlCenterPanel } from '../../web/workspace/src/pages/control-center-panel.js';
import { contextFor, fixture } from './support.js';

describe('Control Center settings editor', () => {
  const doc = fixture('workspace.json');
  doc.workspace.runtimes = { ...doc.workspace.runtimes, 'codex-local': { adapter: 'codex', executable: 'codex' } };
  it('leaves unconfigured routing automatic and creates no inferred specialization', () => {
    const values = controlCenterDefaults(doc.workspace);
    expect(values.runtime).toBe('');
    expect(values.routes).toEqual({});
    expect(buildControlCenterOp(doc.workspace, values)).toEqual({ op: 'control-center.set', runtime: null });
    expect(buildControlCenterOp(doc.workspace, { ...values, runtime: 'codex-local' })).toEqual({ op: 'control-center.set', runtime: 'codex-local' });
  });

  it('builds only explicit role overrides and selected project rules', () => {
    const project = doc.workspace.projects[0];
    const department = doc.workspace.departments[0];
    const values = { runtime: 'codex-local', model: ' chosen-model ', effort: 'low', instructions: ' Route requests by team responsibility. ', routes: { [project.id]: department.id } };
    expect(buildControlCenterOp(doc.workspace, values)).toEqual({ op: 'control-center.set', runtime: 'codex-local', model: 'chosen-model', effort: 'low', instructions: 'Route requests by team responsibility.', projectRoutes: [{ projectId: project.id, departmentId: department.id }] });
    expect(buildControlCenterOp(doc.workspace, { ...values, runtime: '' })).toEqual({ op: 'control-center.set', runtime: null });
    expect(() => buildControlCenterOp(doc.workspace, { ...values, runtime: 'unknown' })).toThrow(/configured/);
  });

  it('renders explicit automatic behavior and disables overrides until a binding is chosen', () => {
    const ctx = contextFor(doc, fixture('runs-empty.json'), fixture('requests-empty.json'));
    const html = renderControlCenterPanel(ctx);
    expect(html).toContain('Automatic · available configured runtime');
    expect(html).toContain('Let Control Center decide');
    expect(html).toContain('Projects without a rule use model classification');
    expect(html).toMatch(/id="control-center-model"[^>]*disabled/);
    ctx.ui.controlCenterDraft = { ...controlCenterDefaults(doc.workspace), runtime: 'codex-local' };
    expect(renderControlCenterPanel(ctx)).toMatch(/id="control-center-model"[^>]*disabled/);
    ctx.ui.modelCatalogs = new Map([['codex-local', { runtimeId: 'codex-local', adapter: 'codex', configuredExecutable: 'codex', status: 'available', models: [{ id: 'reported-model', label: 'Reported model', efforts: ['reported-effort'], effortStatus: 'reported' }] }]]);
    expect(renderControlCenterPanel(ctx)).not.toMatch(/id="control-center-model"[^>]*disabled/);
    expect(renderControlCenterPanel(ctx)).toContain('Your AI orchestrator.');
    expect(renderControlCenterPanel(ctx)).not.toContain('Routing runtime');
  });
});
