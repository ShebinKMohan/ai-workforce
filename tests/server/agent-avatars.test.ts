import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_AVATAR_IDS, validateWorkspace } from '../../src/core/workspace-config.js';
import { startOfficeServer } from '../../src/server/index.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { build, cleanupAll, sampleWorkspace, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest, tokenFrom } from './support.js';

const catalogPath = '../../web/headquarters/src/headquarters/avatar-catalog.js';
const uiPath = '../../web/headquarters/src/headquarters/ui.js';
const organizationPath = '../../web/headquarters/src/headquarters/organization.js';
const managementPath = '../../web/headquarters/src/headquarters/management.js';
const { avatarCatalog, setAvatarProfiles } = await import(catalogPath);
const { avatar, icon } = await import(uiPath);
const organization = await import(organizationPath);
const { createCompanyManagement } = await import(managementPath);

afterEach(() => { vi.unstubAllGlobals(); setAvatarProfiles([]); cleanupAll(); });

describe('bundled agent headshots', () => {
  it('preserves legacy faces and rejects URLs, traversal, markup and unknown IDs at the persistence boundary', () => {
    const legacy = sampleWorkspace();
    expect(validateWorkspace(legacy).ok).toBe(true);
    expect(legacy.agents.every(agent => agent.avatarId === undefined)).toBe(true);
    const before = avatar('Legacy teammate', 36);
    setAvatarProfiles([{ id: 'legacy', name: 'Legacy teammate' }]);
    expect(avatar('Legacy teammate', 36, { id: 'legacy' })).toBe(before);
    for (const avatarId of ['https://example.com/photo.svg', '../avatar.svg', '<svg onload=alert(1)>', 'portrait-99']) {
      expect(() => build([{ op: 'agent.edit', id: 'nova', avatarId }], legacy)).toThrow();
      expect(() => build([{ op: 'control-center.set', runtime: 'codex-local', avatarId }], legacy)).toThrow();
      expect(validateWorkspace({ ...legacy, agents: legacy.agents.map(agent => ({ ...agent, avatarId })) }).ok).toBe(false);
      expect(avatar('Legacy teammate', 36, { avatarId })).toBe(before);
    }
  });

  it('binds selected portraits to identity across rename and handles duplicate names without cross-assignment', () => {
    setAvatarProfiles([{ id: 'first', name: 'Alex', avatarId: 'portrait-02' }, { id: 'second', name: 'Alex', avatarId: 'portrait-13' }]);
    expect(avatar('Alex', 36, { id: 'first' })).toContain('data-avatar-id="portrait-02"');
    expect(avatar('Alex', 36, { id: 'second' })).toContain('data-avatar-id="portrait-13"');
    expect(avatar('Alex', 36)).not.toContain('data-avatar-id');
    setAvatarProfiles([{ id: 'first', name: 'Renamed', avatarId: 'portrait-02' }, { id: 'control-center', name: 'Tom Chandler', avatarId: 'portrait-11', isCoordinator: true }]);
    expect(avatar('Renamed', 36, { id: 'first' })).toContain('portrait-02.svg');
    expect(avatar('Control Center', 28)).toContain('portrait-11.svg');
    setAvatarProfiles([{ id: 'first', name: 'Renamed' }]);
    expect(avatar('Renamed', 36, { id: 'first' })).not.toContain('data-avatar-id');
  });

  it('ships every allowed portrait as distinct self-contained SVG artwork', () => {
    expect(avatarCatalog.map((portrait: { id: string }) => portrait.id)).toEqual([...AGENT_AVATAR_IDS]);
    const contents = avatarCatalog.map((portrait: { id: string }) => readFileSync(path.resolve(`web/headquarters/src/headquarters/assets/avatars/${portrait.id}.svg`), 'utf8'));
    expect(new Set(contents).size).toBe(16);
    for (const svg of contents) {
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).not.toMatch(/<script|<foreignObject|\bonload=|\bhref=|url\(/i);
    }
  });

  it('creates, edits, reloads and resets worker, head and Control Center headshots through the real workspace API', async () => {
    const stateRoot = tempDir('workforce-avatars-');
    updateWorkspace(stateRoot, () => sampleWorkspace(), { createIfMissing: true });
    const spawner = vi.fn(() => { throw new Error('Changing a headshot must not start a runtime'); });
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [], spawner });
    try {
      const token = await tokenFrom(server);
      const nativeFetch = globalThis.fetch;
      vi.stubGlobal('document', { querySelector: () => ({ content: token }) });
      vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => nativeFetch(new URL(url, server.url), { ...init, headers: { ...init.headers, origin: originFor(server) } }));
      await organization.refreshOrganization();
      const values = { name: 'Avatar proof', role: 'worker', runtime: 'codex-local', departmentId: 'engineering-platform', instructions: 'Read assigned source and explain it.', policy: 'analysis', avatarId: 'portrait-06' };
      const created = await organization.saveAgent(values);
      expect(loadWorkspace(stateRoot).config.agents.find(agent => agent.id === created.id)?.avatarId).toBe('portrait-06');
      const edited = await organization.saveAgent({ ...values, id: created.id, name: 'Renamed portrait', avatarId: 'portrait-09' });
      await organization.refreshOrganization();
      expect(avatar(edited.name, 36, { id: edited.id })).toContain('portrait-09.svg');
      await organization.saveAgent({ id: 'atlas', name: 'Atlas', runtime: 'codex-local', departmentId: 'engineering-platform', instructions: 'Plan work.', avatarId: 'portrait-05' });
      await organization.saveAgent({ id: 'control-center', runtime: 'codex-local', avatarId: 'portrait-12' });
      const saved = loadWorkspace(stateRoot).config;
      expect(saved.agents.find(agent => agent.id === 'atlas')?.avatarId).toBe('portrait-05');
      expect(saved.controlCenter?.avatarId).toBe('portrait-12');
      await organization.refreshOrganization();
      expect(avatar('Control Center', 28)).toContain('portrait-12.svg');

      const manager = createCompanyManagement({ organization, avatar, icon });
      for (const editAgentId of ['', 'atlas', 'control-center', created.id]) {
        const html = manager.render({ editAgentId });
        expect(html).toContain('<legend>Choose a headshot</legend>');
        expect(html.match(/type="radio" name="avatarId"/g)).toHaveLength(17);
        expect(html).toContain('aria-label="Maya headshot"');
        expect(html).toContain('data-avatar-preview-label');
      }
      const reloadedForm = manager.render({ editAgentId: created.id });
      expect(reloadedForm).toContain('value="portrait-09" aria-label="Elias headshot" checked');
      expect(manager.render({ editDepartmentId: '' }).match(/type="radio" name="headAvatarId"/g)).toHaveLength(17);
      const newDepartment = await organization.saveDepartment({ name: 'Portrait design', headName: 'Portrait head', headRuntime: 'codex-local', headAvatarId: 'portrait-14' });
      expect(loadWorkspace(stateRoot).config.agents.find(agent => agent.id === newDepartment.lead.id)?.avatarId).toBe('portrait-14');
      await organization.saveAgent({ ...values, id: created.id, avatarId: '' });
      await organization.saveAgent({ id: 'control-center', runtime: 'codex-local', avatarId: '' });
      await organization.refreshOrganization();
      expect(loadWorkspace(stateRoot).config.agents.find(agent => agent.id === created.id)?.avatarId).toBeUndefined();
      expect(loadWorkspace(stateRoot).config.controlCenter?.avatarId).toBeUndefined();
      expect(avatar('Control Center', 28)).not.toContain('data-avatar-id');
      expect(spawner).not.toHaveBeenCalled();

      const snapshot = readFileSync(loadWorkspace(stateRoot).path, 'utf8');
      await expect(organization.saveAgent({ ...values, id: created.id, avatarId: '../remote.svg' })).rejects.toThrow();
      const invalid = await rawRequest(server, { method: 'POST', path: '/api/workspace/ops', headers: { origin: originFor(server), 'x-workforce-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ expectRevision: organization.revision, ops: [{ op: 'agent.edit', id: created.id, avatarId: 'https://example.com/avatar.svg' }] }) });
      expect(invalid.status).toBe(400);
      expect(readFileSync(loadWorkspace(stateRoot).path, 'utf8')).toBe(snapshot);
      for (const portrait of avatarCatalog) {
        const asset = await rawRequest(server, { path: `/src/headquarters/assets/avatars/${portrait.id}.svg` });
        expect(asset.status).toBe(200);
        expect(asset.headers['content-type']).toContain('image/svg+xml');
      }
    } finally { await server.close(); }
  });
});
