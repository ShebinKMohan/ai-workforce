import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateWorkspace, type WorkspaceConfig } from '../../src/core/workspace-config.js';
import { build } from '../workspace/helpers.js';

const client = vi.hoisted(() => ({ api: vi.fn(), publishWorkspace: vi.fn() }));
vi.mock('../../web/headquarters/src/headquarters/runtime-client.js', () => ({
  api: client.api, workforce: { publishWorkspace: client.publishWorkspace },
}));
const organizationPath = '../../web/headquarters/src/headquarters/organization.js';
const connectionsPath = '../../web/headquarters/src/headquarters/connections.js';

function team(): WorkspaceConfig {
  return {
    ...build([
      { op: 'project.add', id: 'app', repoPath: '/repos/app' },
      { op: 'department.add', id: 'engineering', name: 'Engineering' },
      { op: 'department.add', id: 'frontend', name: 'Frontend & Design' },
      { op: 'department.add', id: 'quality', name: 'Quality Engineering' },
      { op: 'agent.add', id: 'mike', name: 'Mike', role: 'head', departmentId: 'engineering', runtime: 'codex-local', instructions: 'ROLE: Engineering Lead\nCoordinate the team.' },
      { op: 'agent.add', id: 'kara', name: 'Kara', role: 'worker', departmentId: 'engineering', runtime: 'claude-local', model: 'opus[1m]', effort: 'max', capabilities: ['frontend', 'accessibility'], instructions: 'ROLE: Frontend Engineer\nRespect project guidance.', projectScope: 'restricted', projectIds: ['app'] },
      { op: 'control-center.set', runtime: 'claude-local', model: 'opus[1m]', effort: 'max', instructions: 'Route requests by capability.' },
    ]),
    revision: 8,
  };
}

function editValues(agent: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return { ...agent, role: agent.runtimeRole, ...changes };
}

beforeEach(() => {
  vi.resetModules();
  client.api.mockReset();
  client.publishWorkspace.mockReset();
});

/** The UI submits its real public operation objects through the same validated
 * reducer as HTTP; the transport itself is mocked, with no live workspace IO. */
async function connectedTeam(catalog: Record<string, unknown> = { status: 'available', models: [{ id: 'opus[1m]', efforts: ['max', 'high'] }] }) {
  const org = await import(organizationPath);
  let workspace = team();
  org.syncWorkspace({ workspace });
  client.api.mockImplementation(async (route: string, body?: { expectRevision: number; ops: Record<string, unknown>[] }) => {
    if (route.includes('/models')) return catalog;
    if (route === '/api/workspace/ops' && body) {
      expect(body.expectRevision).toBe(workspace.revision);
      workspace = { ...build(body.ops, workspace), revision: workspace.revision + 1 };
      expect(validateWorkspace(workspace).ok).toBe(true);
      return { ok: true, workspace, revision: workspace.revision };
    }
    if (route === '/api/workspace') return { workspace };
    throw new Error(`Unexpected request: ${route}`);
  });
  return { org, saved: () => workspace };
}

describe('team directory saves', () => {
  it('persists a job title, promotion, and subsequent head move with the same identity and binding', async () => {
    const { org, saved } = await connectedTeam();
    await org.loadModels('claude-local');
    await org.saveAgent(editValues(org.getAgent('kara'), { role: 'head', departmentId: 'frontend', jobTitle: 'Head of Frontend & Design' }));
    expect(saved().agents.find(agent => agent.id === 'kara')).toMatchObject({
      role: 'head', jobTitle: 'Head of Frontend & Design', runtime: 'claude-local', model: 'opus[1m]', effort: 'max',
      policy: 'analysis', projectIds: [], projectScope: 'all', capabilities: ['frontend', 'accessibility'],
    });
    expect(saved().departments.find(department => department.id === 'frontend')?.headAgentId).toBe('kara');
    expect(org.getAgent('kara')).toMatchObject({ role: 'Head of Frontend & Design', runtimeRole: 'head', isHead: true });
    await org.saveAgent(editValues(org.getAgent('kara'), { departmentId: 'quality', jobTitle: 'Quality Engineering Lead' }));
    expect(saved().departments.find(department => department.id === 'frontend')?.headAgentId).toBeNull();
    expect(saved().departments.find(department => department.id === 'quality')?.headAgentId).toBe('kara');
    await org.saveAgent(editValues(org.getAgent('kara'), { role: 'worker' }));
    expect(saved().departments.find(department => department.id === 'quality')?.headAgentId).toBeNull();
    expect(saved().agents.find(agent => agent.id === 'kara')?.policy).toBe('analysis');
  });

  it('preserves a saved model missing from the current catalog when editing job title and department', async () => {
    const { org, saved } = await connectedTeam({ status: 'available', models: [{ id: 'new-model', efforts: ['high'] }] });
    await org.loadModels('claude-local');
    await org.saveAgent(editValues(org.getAgent('kara'), { jobTitle: 'Product Designer', departmentId: 'frontend' }));
    expect(saved().agents.find(agent => agent.id === 'kara')).toMatchObject({
      jobTitle: 'Product Designer', departmentId: 'frontend', runtime: 'claude-local', model: 'opus[1m]', effort: 'max',
    });
  });

  it('preserves a saved effort no longer in the catalog for an unrelated edit, including Control Center', async () => {
    const { org, saved } = await connectedTeam({ status: 'available', models: [{ id: 'opus[1m]', efforts: ['high'] }] });
    await org.loadModels('claude-local');
    await org.saveAgent(editValues(org.getAgent('kara'), { jobTitle: 'Design Systems Engineer' }));
    await org.saveAgent(editValues(org.orchestrator, { instructions: 'Route by capability and availability.' }));
    expect(saved().agents.find(agent => agent.id === 'kara')?.effort).toBe('max');
    expect(saved().controlCenter).toMatchObject({ runtime: 'claude-local', model: 'opus[1m]', effort: 'max', instructions: 'Route by capability and availability.' });
  });

  it('still rejects new model or effort choices and an incompatible runtime switch before any write', async () => {
    const { org } = await connectedTeam({ status: 'available', models: [{ id: 'opus[1m]', efforts: ['high'] }] });
    await org.loadModels('claude-local');
    await org.loadModels('codex-local');
    await expect(org.saveAgent(editValues(org.getAgent('kara'), { model: 'invented-model' }))).rejects.toMatchObject({ fields: { model: expect.any(String) } });
    await expect(org.saveAgent(editValues(org.getAgent('kara'), { effort: 'invented-effort' }))).rejects.toMatchObject({ fields: { effort: expect.any(String) } });
    await expect(org.saveAgent(editValues(org.getAgent('kara'), { runtime: 'codex-local' }))).rejects.toMatchObject({ fields: { effort: expect.any(String) } });
    expect(client.api.mock.calls.some(([route]) => route === '/api/workspace/ops')).toBe(false);
  });

  it('reports an occupied department head without overwriting either employee', async () => {
    const { org, saved } = await connectedTeam();
    await expect(org.saveAgent(editValues(org.getAgent('kara'), { role: 'head' }))).rejects.toMatchObject({ code: 'department_has_head' });
    expect(saved().departments[0]?.headAgentId).toBe('mike');
    expect(saved().agents.find(agent => agent.id === 'kara')?.role).toBe('worker');
  });
});

describe('one-click team setup reconciliation', () => {
  it('refreshes a no-op proposal so a team set up in another window becomes visible', async () => {
    const org = await import(organizationPath);
    org.syncWorkspace({ workspace: team() });
    const latest = { ...build([{ op: 'agent.edit', id: 'kara', jobTitle: 'Frontend Lead' }], team()), revision: 12 };
    client.api.mockResolvedValueOnce({ revision: 12, ops: [], warnings: [] }).mockResolvedValueOnce({ workspace: latest });
    const result = await org.setupTechTeam();
    expect(result.message).toBe('Your tech team is already set up.');
    expect(org.revision).toBe(12);
    expect(org.getAgent('kara').jobTitle).toBe('Frontend Lead');
    expect(client.api.mock.calls.map(([route]) => route)).toEqual(['/api/workspace/templates/nathan-james', '/api/workspace']);
    expect(client.publishWorkspace).toHaveBeenCalledWith({ workspace: latest });
  });

  it('uses the proposal revision and reconciles a committed write when readiness refresh fails', async () => {
    const org = await import(organizationPath);
    org.syncWorkspace({ workspace: team() });
    const ops = [{ op: 'agent.edit', id: 'kara', jobTitle: 'Frontend Lead' }];
    const saved = { ...build(ops, team()), revision: 13 };
    const warning = "Russ's configured account is signed out; its saved binding was preserved.";
    client.api.mockResolvedValueOnce({ revision: 12, ops, warnings: [warning] })
      .mockResolvedValueOnce({ ok: true, workspace: saved, revision: 13 })
      .mockRejectedValueOnce(new Error('Readiness temporarily unavailable'));
    const result = await org.setupTechTeam();
    expect(client.api).toHaveBeenNthCalledWith(2, '/api/workspace/ops', { expectRevision: 12, ops });
    expect(org.revision).toBe(13);
    expect(org.getAgent('kara').jobTitle).toBe('Frontend Lead');
    expect(org.storageWarning).toContain('Your team was saved.');
    expect(result.message).toContain(warning);
    expect(result.message).toContain('Runtime readiness could not refresh yet.');
    expect(client.publishWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspace: saved }));
  });

  it('leaves a newer workspace untouched on revision conflict and does not retry with stale operations', async () => {
    const org = await import(organizationPath);
    org.syncWorkspace({ workspace: team() });
    client.api.mockResolvedValueOnce({ revision: 12, ops: [{ op: 'agent.edit', id: 'kara', jobTitle: 'Frontend Lead' }] })
      .mockRejectedValueOnce(Object.assign(new Error('Workspace changed before this save.'), { status: 409 }));
    await expect(org.setupTechTeam()).rejects.toMatchObject({ status: 409 });
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(client.publishWorkspace).not.toHaveBeenCalled();
    expect(org.revision).toBe(8);
  });
});

describe('Connections runtime and MCP presentation', () => {
  it('shows every configured installation and keeps task readiness separate from a verified MCP bridge', async () => {
    const { renderConnectionsPage, runtimesForClient, summarizeConnections } = await import(connectionsPath);
    const codex = { id: 'codex', name: 'Codex', installed: true, configured: true, toolsVerified: true, verification: { state: 'verified', toolCount: 9 } };
    const workspace = {
      workspace: { runtimes: {
        'codex-old': { adapter: 'codex', executable: '/old/codex' },
        'codex-active': { adapter: 'codex', executable: '/current/codex' },
      } },
      runtimes: { reports: [
        { runtimeId: 'codex-old', configuredExecutable: '/old/codex', installed: true, auth: 'logged_out', usable: false },
        { runtimeId: 'codex-active', configuredExecutable: '/current/codex', installed: true, auth: 'authenticated', usable: true },
      ] },
    };
    const store = { clients: [codex], actions: new Map(), errors: new Map(), scanning: false };
    const renderRuntime = vi.fn((id: string) => `<span data-saved-runtime="${id}"></span>`);
    const html = renderConnectionsPage(store, { workspace, renderRuntime });
    expect(renderRuntime.mock.calls.map(([id]) => id)).toEqual(['codex-old', 'codex-active']);
    expect(html).toContain('1 of 2 runtimes ready');
    expect(html).toContain('Sign-in needed');
    expect(html).toContain('Connection ready');
    expect(runtimesForClient(codex, workspace).map((runtime: { ready: boolean }) => runtime.ready)).toEqual([false, true]);
    expect(summarizeConnections(store)).toMatchObject({ state: 'ready', readyCount: 1 });
  });
});
