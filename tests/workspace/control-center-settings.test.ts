import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyWorkspace, validateWorkspace, workspaceReadiness } from '../../src/core/workspace-config.js';
import { applyWorkspaceOps, archiveAgent, parseWorkspaceOps, removeDepartment, removeProject, setControlCenter } from '../../src/workspace/operations.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, refusal, sampleWorkspace, tempDir } from './helpers.js';

afterEach(cleanupAll);

describe('Control Center configuration', () => {
  it('keeps earlier schema-v2 files valid without inventing a routing role or team rule', () => {
    const empty = emptyWorkspace();
    expect(validateWorkspace(empty).ok).toBe(true);
    expect(empty).not.toHaveProperty('controlCenter');
    const existing = sampleWorkspace();
    const after = setControlCenter(existing, { runtime: 'codex-local', model: 'configured-model', effort: 'low' });
    expect(after.agents).toEqual(existing.agents);
    expect(after.controlCenter?.projectRoutes).toBeUndefined();
    expect(workspaceReadiness(after)).toEqual(workspaceReadiness(existing));
    expect(existing.controlCenter).toBeUndefined();
  });

  it('validates runtime and specialization references, including ambiguous duplicate project rules', () => {
    const config = sampleWorkspace();
    expect(refusal(() => setControlCenter(config, { runtime: 'missing' })).code).toBe('unknown_runtime');
    expect(refusal(() => setControlCenter(config, { runtime: 'codex-local', projectRoutes: [{ projectId: 'missing', departmentId: 'design' }] })).code).toBe('unknown_project');
    expect(refusal(() => setControlCenter(config, { runtime: 'codex-local', projectRoutes: [{ projectId: 'checkout', departmentId: 'missing' }] })).code).toBe('unknown_department');
    expect(refusal(() => setControlCenter(config, { runtime: 'codex-local', projectRoutes: [{ projectId: 'checkout', departmentId: 'design' }, { projectId: 'checkout', departmentId: 'engineering-platform' }] })).code).toBe('duplicate_project_route');
    const invalidFile = validateWorkspace({ ...config, controlCenter: { runtime: 'missing', projectRoutes: [{ projectId: 'unknown', departmentId: 'absent' }] } });
    expect(invalidFile.ok).toBe(false);
    if (!invalidFile.ok) expect(invalidFile.issues.map((issue) => issue.code)).toEqual(['unknown_runtime', 'unknown_project', 'unknown_department']);
  });

  it('saves explicit rules, prunes removed references, and resets to automatic without changing runtime defaults', () => {
    const configured = setControlCenter(sampleWorkspace(), { runtime: 'codex-local', instructions: 'Route by the project and request.', projectRoutes: [{ projectId: 'checkout', departmentId: 'engineering-platform' }, { projectId: 'billing', departmentId: 'design' }] });
    const removed = removeDepartment(archiveAgent(removeProject(configured, 'checkout'), 'mo'), 'design');
    expect(removed.controlCenter?.projectRoutes).toEqual([]);
    expect(validateWorkspace(removed).ok).toBe(true);
    const reset = setControlCenter(removed, { runtime: null });
    expect(reset).not.toHaveProperty('controlCenter');
    expect(reset.runtimes).toEqual(configured.runtimes);
    expect(refusal(() => setControlCenter(removed, { runtime: null, model: 'ignored' })).code).toBe('invalid_control_center');
  });

  it('uses the existing atomic revision check, refusing a stale editor without losing the saved role', () => {
    const root = tempDir();
    const initial = updateWorkspace(root, () => sampleWorkspace(), { createIfMissing: true });
    const ops = parseWorkspaceOps([{ op: 'control-center.set', runtime: 'codex-local', model: 'configured-model', effort: 'low', projectRoutes: [{ projectId: 'checkout', departmentId: 'engineering-platform' }] }]);
    const saved = updateWorkspace(root, (config) => applyWorkspaceOps(config, ops), { expectRevision: initial.revision });
    const bytes = readFileSync(saved.path, 'utf8');
    const stale = refusal(() => updateWorkspace(root, (config) => setControlCenter(config, { runtime: null }), { expectRevision: initial.revision }));
    expect(stale.code).toBe('workspace_revision_conflict');
    expect(readFileSync(saved.path, 'utf8')).toBe(bytes);
    expect(loadWorkspace(root).config.controlCenter).toEqual({ runtime: 'codex-local', model: 'configured-model', effort: 'low', projectRoutes: [{ projectId: 'checkout', departmentId: 'engineering-platform' }] });
  });
});
