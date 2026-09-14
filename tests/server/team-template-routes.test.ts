import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import type { WorkspaceConfig } from '../../src/core/workspace-config.js';
import { workspaceFilePath } from '../../src/workspace/paths.js';
import { build, cleanupAll, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest } from './support.js';

const ROUTE = '/api/workspace/templates/nathan-james';
const servers: OfficeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); cleanupAll(); });

function configured(runtimeId = 'codex'): WorkspaceConfig {
  return { ...build([
    { op: 'runtime.set', id: runtimeId, adapter: runtimeId === 'codex' ? 'codex' : 'claude-code', executable: `/configured/accounts/team/${runtimeId}`, model: 'chosen-runtime-model', effort: 'high' },
    { op: 'department.add', id: 'nathan-james-engineering', name: 'Nathan James Engineering' },
    { op: 'agent.add', id: 'mike-slattery', name: 'Mike Slattery', role: 'head', departmentId: 'nathan-james-engineering', runtime: runtimeId, model: 'chosen-agent-model', effort: 'medium' },
  ]), revision: 7 };
}

async function office(config: WorkspaceConfig, installed = true) {
  const root = tempDir('workforce-template-route-');
  const file = workspaceFilePath(root);
  writeFileSync(file, JSON.stringify(config));
  const reports = Object.entries(config.runtimes).map(([runtimeId, runtime]) => ({
    adapter: runtime.adapter, runtimeId, configuredExecutable: runtime.executable, executable: runtime.executable,
    installed, adapterSupported: installed, controllable: installed, auth: installed ? 'logged_in' : 'unknown',
    checkedAt: '2026-09-14T00:00:00.000Z',
  } as RuntimeReadinessReport));
  const spawner = vi.fn(() => { throw new Error('No runtime process may be started by organization setup.'); });
  const discover = vi.fn(async () => reports);
  const server = await startOfficeServer({ stateRoot: root, port: 0, discover, spawner });
  servers.push(server);
  return { server, file, spawner, discover };
}

function post(server: OfficeServer, route: string, body: unknown) {
  return rawRequest(server, { method: 'POST', path: route,
    headers: { origin: originFor(server), 'x-workforce-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('team template preview and public workspace application', () => {
  it.each(['codex', 'claude', 'claude-code'])('preserves a configured runtime named %s from template GET through public POST', async runtimeId => {
    const before = configured(runtimeId);
    const target = await office(before);
    const bytes = readFileSync(target.file);
    const preview = await rawRequest(target.server, { path: ROUTE });
    expect(preview.status, preview.body).toBe(200);
    const proposal = JSON.parse(preview.body);
    expect(proposal).toMatchObject({ ok: true, expectRevision: 7, revision: 7 });
    expect(readFileSync(target.file)).toEqual(bytes);
    expect(proposal.ops.filter((op: { op: string }) => op.op === 'agent.add').every((op: { runtime: string }) => op.runtime === runtimeId)).toBe(true);

    const applied = await post(target.server, '/api/workspace/ops', { expectRevision: proposal.expectRevision, ops: proposal.ops });
    expect(applied.status, applied.body).toBe(200);
    const saved = JSON.parse(applied.body);
    expect(saved).toMatchObject({ previousRevision: 7, revision: 8, written: true });
    expect(saved.workspace.runtimes).toEqual(before.runtimes);
    expect(saved.workspace.agents).toHaveLength(15);
    for (const agent of saved.workspace.agents) expect(agent).toMatchObject({ runtime: runtimeId, model: 'chosen-agent-model', effort: 'medium' });
    expect(saved.workspace.runtimes['codex-local']).toBeUndefined();
    expect(saved.workspace.runtimes['claude-local']).toBeUndefined();
    expect(JSON.parse(readFileSync(target.file, 'utf8'))).toEqual(saved.workspace);

    const after = readFileSync(target.file);
    const stale = await post(target.server, '/api/workspace/ops', { expectRevision: proposal.expectRevision, ops: proposal.ops });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ revision: 8, error: { code: 'workspace_revision_conflict' } });
    expect(readFileSync(target.file)).toEqual(after);
    const repeated = await rawRequest(target.server, { path: ROUTE });
    expect(repeated.status).toBe(200);
    expect(JSON.parse(repeated.body).ops).toEqual([]);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('resolves agent runtime edits against earlier runtime definitions in the same public operation batch', async () => {
    const target = await office(configured());
    const applied = await post(target.server, '/api/workspace/ops', { expectRevision: 7, ops: [
      { op: 'runtime.set', id: 'claude', adapter: 'claude-code', executable: '/configured/accounts/second/claude' },
      { op: 'agent.edit', id: 'mike-slattery', runtime: 'claude' },
    ] });
    expect(applied.status, applied.body).toBe(200);
    const saved = JSON.parse(applied.body).workspace;
    expect(saved.agents[0].runtime).toBe('claude');
    expect(saved.runtimes.claude.executable).toBe('/configured/accounts/second/claude');
    expect(saved.runtimes['claude-local']).toBeUndefined();
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('keeps template setup idempotent after a profile save trims the complete marker and changes the job title', async () => {
    const target = await office(configured());
    const preview = await rawRequest(target.server, { path: ROUTE });
    expect(preview.status, preview.body).toBe(200);
    const proposal = JSON.parse(preview.body);
    const applied = await post(target.server, '/api/workspace/ops', { expectRevision: proposal.expectRevision, ops: proposal.ops });
    expect(applied.status, applied.body).toBe(200);
    const setup = JSON.parse(applied.body);
    const will = setup.workspace.agents.find((agent: { id: string }) => agent.id === 'will-mason');
    const edited = await post(target.server, '/api/workspace/ops', { expectRevision: setup.revision, ops: [{
      op: 'agent.edit', id: will.id, jobTitle: 'Frontend Developer', instructions: will.instructions.trim(),
      runtime: will.runtime, model: will.model, effort: will.effort, avatarId: will.avatarId,
    }] });
    expect(edited.status, edited.body).toBe(200);
    const saved = JSON.parse(edited.body);
    const profile = saved.workspace.agents.find((agent: { id: string }) => agent.id === will.id);
    expect(profile).toEqual({ ...will, jobTitle: 'Frontend Developer', instructions: will.instructions.trim() });
    expect(profile.instructions.endsWith('[END WORKFORCE TEAM TEMPLATE]')).toBe(true);
    const bytes = readFileSync(target.file);
    const repeated = await rawRequest(target.server, { path: ROUTE });
    expect(repeated.status, repeated.body).toBe(200);
    expect(JSON.parse(repeated.body)).toMatchObject({ expectRevision: saved.revision, ops: [] });
    expect(readFileSync(target.file)).toEqual(bytes);

    // A user-authored suffix after the complete marker remains ordinary
    // instruction content, including another delimiter used as a doc example.
    const customInstructions = `${profile.instructions}\n\nKeep this exact delimiter in documentation examples:\n[END WORKFORCE TEAM TEMPLATE]\nPreserve the customer accessibility checklist.`;
    const custom = await post(target.server, '/api/workspace/ops', { expectRevision: saved.revision, ops: [{ op: 'agent.edit', id: will.id, instructions: customInstructions }] });
    expect(custom.status, custom.body).toBe(200);
    const customBytes = readFileSync(target.file);
    const customPreview = await rawRequest(target.server, { path: ROUTE });
    expect(customPreview.status, customPreview.body).toBe(200);
    expect(JSON.parse(customPreview.body).ops).toEqual([]);
    expect(readFileSync(target.file)).toEqual(customBytes);
    expect(JSON.parse(readFileSync(target.file, 'utf8')).agents.find((agent: { id: string }) => agent.id === will.id)).toEqual({ ...profile, instructions: customInstructions });
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('still resolves a tool shorthand when no exact configured runtime uses that ID', async () => {
    const target = await office(configured());
    const applied = await post(target.server, '/api/workspace/ops', { expectRevision: 7, ops: [{ op: 'agent.edit', id: 'mike-slattery', runtime: 'claude' }] });
    expect(applied.status, applied.body).toBe(200);
    const saved = JSON.parse(applied.body).workspace;
    expect(saved.agents[0].runtime).toBe('claude-local');
    expect(saved.runtimes['claude-local']).toMatchObject({ adapter: 'claude-code', executable: 'claude' });
  });

  it('maps missing-runtime readiness to warnings without changing configuration or launching work', async () => {
    const target = await office(configured(), false);
    const bytes = readFileSync(target.file);
    const response = await rawRequest(target.server, { path: ROUTE });
    expect(response.status, response.body).toBe(200);
    const proposal = JSON.parse(response.body);
    expect(proposal.warnings).toContain("Mike Slattery's configured runtime (codex) is currently unavailable. Its saved binding was preserved.");
    expect(proposal.warnings).toContain("Architecture & Delivery has no worker with a usable configured runtime. Connect an existing worker's account before dispatching this department's work.");
    expect(readFileSync(target.file)).toEqual(bytes);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('returns a normal workspace refusal for an archived template identity and writes nothing', async () => {
    const before = build([{ op: 'agent.add', id: 'kara-foster', role: 'worker', departmentId: 'nathan-james-engineering', runtime: 'codex' }, { op: 'agent.archive', id: 'kara-foster' }], configured());
    const target = await office(before);
    const bytes = readFileSync(target.file);
    const response = await rawRequest(target.server, { path: ROUTE });
    expect(response.status, response.body).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'template_agent_archived' } });
    expect(readFileSync(target.file)).toEqual(bytes);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('checks read authorization and the exact GET route before discovery or writes', async () => {
    const target = await office(configured());
    const bytes = readFileSync(target.file);
    const forbidden = await rawRequest(target.server, { path: ROUTE, headers: { origin: 'http://unrelated.example' } });
    expect(forbidden.status).toBe(403);
    expect(target.discover).not.toHaveBeenCalled();
    const wrongMethod = await post(target.server, ROUTE, {});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers['allow']).toBe('GET');
    const extraSegment = await rawRequest(target.server, { path: `${ROUTE}/apply` });
    expect(extraSegment.status).toBe(404);
    expect(target.discover).not.toHaveBeenCalled();
    expect(readFileSync(target.file)).toEqual(bytes);
    expect(target.spawner).not.toHaveBeenCalled();
  });
});
