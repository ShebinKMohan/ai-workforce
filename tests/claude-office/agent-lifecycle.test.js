import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentStore } from '../../web/claude-office/src/agent-store.js';
import { emptyWorkspace } from '../../src/core/workspace-config.js';
import { applyWorkspaceOps, createdIds, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { startOfficeServer } from '../../src/server/index.js';
import { originFor, rawRequest, tokenFrom } from '../server/support.js';

function memoryWorkspace() {
  let workspace = applyWorkspaceOps(emptyWorkspace(), parseWorkspaceOps([
    { op: 'department.add', id: 'engineering', name: 'Engineering' },
    { op: 'project.add', id: 'app', name: 'App', repoPath: '/repos/app' },
    { op: 'project.add', id: 'docs', name: 'Docs', repoPath: '/repos/docs' },
    { op: 'agent.add', id: 'head', name: 'Engineering head', role: 'head', departmentId: 'engineering', runtime: 'codex-local' },
    { op: 'agent.add', id: 'worker', name: 'Engineer', role: 'worker', departmentId: 'engineering', runtime: 'codex-local', model: 'agent-override', projectIds: ['app'] },
  ]));
  workspace.runtimes['codex-special'] = { adapter: 'codex', executable: '/tools/codex', model: 'runtime-default' };
  let revision = 4;
  const snapshot = () => ({ workspace: structuredClone(workspace), revision });
  const commit = vi.fn(async (_path, input) => {
    if (input.expectRevision !== revision) throw Object.assign(new Error('Workspace changed'), { code: 'workspace_revision_conflict' });
    const next = applyWorkspaceOps(workspace, parseWorkspaceOps(input.ops));
    const created = createdIds(workspace, next);
    workspace = next; revision++;
    return { workspace: structuredClone(workspace), revision, created };
  });
  return { commit, snapshot, store: createAgentStore({ workspace: snapshot(), commit, load: async () => snapshot() }) };
}

const formValues = (agent, overrides = {}) => ({ id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, departmentId: agent.departmentId, workspaceRuntimeId: agent.workspaceRuntimeId, model: agent.modelOverride, projectIds: agent.projectIds, ...overrides });

describe('agent directory lifecycle', () => {
  it('archives through the live revisioned endpoint without deleting configuration or launching a runtime', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'workforce-agent-directory-'));
    const spawner = vi.fn(() => { throw new Error('Configuration must not start a runtime'); });
    const server = await startOfficeServer({ port: 0, stateRoot: root, discover: async () => [], spawner });
    try {
      const token = await tokenFrom(server);
      const load = async (url) => JSON.parse((await rawRequest(server, { path: url })).body);
      const commit = async (url, body) => {
        const response = await rawRequest(server, { method: 'POST', path: url, headers: { origin: originFor(server), 'x-workforce-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const value = JSON.parse(response.body);
        if (response.status !== 200) throw Object.assign(new Error(value.error.message), { code: value.error.code });
        return value;
      };
      await commit('/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'department.add', id: 'engineering', name: 'Engineering' }] });
      const employees = [];
      const store = createAgentStore({ workspace: await load('/api/workspace'), load, commit, employees });
      const created = await store.save({ name: 'Fixture engineer', role: 'worker', departmentId: 'engineering', workspaceRuntimeId: 'codex-local', instructions: 'Inspect the disposable fixture.', model: '', projectIds: [] });
      const stale = store.revision;
      expect(employees.map((agent) => agent.id)).toEqual([created.id]);
      const archived = await store.archive(created.id, store.revision);
      expect(archived.archived).toBe(true);
      expect(employees).toEqual([]);
      expect(store.list()).toEqual([]);
      expect(store.list({ archived: true }).map((agent) => agent.id)).toEqual([created.id]);
      const after = await load('/api/workspace');
      expect(after.workspace.agents).toEqual([expect.objectContaining({ id: created.id, archived: true, instructions: 'Inspect the disposable fixture.' })]);
      await expect(commit('/api/workspace/ops', { expectRevision: stale, ops: [{ op: 'agent.archive', id: created.id }] })).rejects.toMatchObject({ code: 'workspace_revision_conflict' });
      expect((await load('/api/workspace')).revision).toBe(after.revision);
      expect(spawner).not.toHaveBeenCalled();
    } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('atomically replaces the head while retaining the old identity and worker assignments', async () => {
    const { store, commit, snapshot } = memoryWorkspace();
    const head = store.get('head');
    const replacement = await store.save(formValues(head, { id: undefined, replaceId: head.id, name: 'New head', model: '' }));
    expect(commit.mock.calls[0][1].ops.map((op) => op.op)).toEqual(['agent.archive', 'agent.add']);
    expect(snapshot().workspace.departments[0].headAgentId).toBe(replacement.id);
    expect(store.get('head')).toBeUndefined();
    expect(store.get('head', { includeArchived: true }).archived).toBe(true);
    expect(store.get('worker').projectIds).toEqual(['app']);
    expect(replacement).toMatchObject({ role: 'head', projectIds: [], policy: 'analysis' });
    await expect(store.save(formValues(replacement, { id: undefined, name: 'Second head' }))).rejects.toMatchObject({ fields: { departmentId: expect.stringMatching(/already has a head/) } });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('edits the exact custom runtime binding, clears a model override, and updates project access in one transaction', async () => {
    const { store, snapshot } = memoryWorkspace();
    const saved = await store.save(formValues(store.get('worker'), { workspaceRuntimeId: 'codex-special', model: '', projectIds: ['docs'] }));
    expect(saved).toMatchObject({ workspaceRuntimeId: 'codex-special', runtimeId: 'codex-special', model: 'runtime-default', modelOverride: '', projectIds: ['docs'] });
    const actual = snapshot().workspace.agents.find((agent) => agent.id === 'worker');
    expect(actual.runtime).toBe('codex-special');
    expect(actual).not.toHaveProperty('model');
    expect(actual.projectIds).toEqual(['docs']);
    await expect(store.save(formValues(saved, { workspaceRuntimeId: 'ollama' }))).rejects.toMatchObject({ fields: { runtime: expect.any(String) } });
  });

  it('rejects stale archive confirmations and a fake replacement target without changing the roster', async () => {
    const { store, snapshot } = memoryWorkspace();
    await expect(store.archive('worker', 0)).rejects.toMatchObject({ code: 'workspace_revision_conflict' });
    expect(store.get('worker').archived).toBe(false);
    await expect(store.save(formValues(store.get('head'), { id: undefined, replaceId: 'worker' }))).rejects.toThrow(/head to replace/);
    await expect(store.archive('control')).rejects.toThrow(/system scheduler/);
    expect(snapshot().revision).toBe(4);
  });

  it('keeps a missing custom executable separate from a signed-in installation', () => {
    const { snapshot } = memoryWorkspace();
    const doc = snapshot();
    doc.runtimes = { reports: [
      { adapter: 'codex', executable: '/usr/local/bin/codex', installed: true, adapterSupported: true, auth: 'logged_in' },
      { runtimeId: 'codex-special', adapter: 'codex', configuredExecutable: '/tools/codex', installed: false, adapterSupported: true, auth: 'unknown' },
    ] };
    const store = createAgentStore({ workspace: doc });
    expect(store.runtimeBindings.find((binding) => binding.id === 'codex-local')).toMatchObject({ status: 'Signed in', ready: true });
    expect(store.runtimeBindings.find((binding) => binding.id === 'codex-special')).toMatchObject({ status: 'Not found', ready: false });
    doc.workspace.runtimes['codex-special'].executable = '/another/codex';
    store.setWorkspace(doc);
    expect(store.runtimeBindings.find((binding) => binding.id === 'codex-special')).toMatchObject({ status: 'Not checked', ready: false });
  });

  it('recreates an archived configuration with a new identity and does not mutate its saved record', async () => {
    const { store } = memoryWorkspace();
    const old = await store.archive('worker');
    const newAgent = await store.save(formValues(old, { id: undefined }));
    expect(newAgent.id).not.toBe(old.id);
    expect(newAgent).toMatchObject({ archived: false, role: 'worker', projectIds: ['app'] });
    expect(store.get(old.id, { includeArchived: true })).toMatchObject({ archived: true, modelOverride: 'agent-override' });
  });
});
