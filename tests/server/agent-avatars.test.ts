import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const { avatarCatalog, setAvatarProfiles, defaultPortrait, resolveAvatarId } = await import(catalogPath);
const { avatar, icon } = await import(uiPath);
const organization = await import(organizationPath);
const { createCompanyManagement } = await import(managementPath);

afterEach(() => { vi.unstubAllGlobals(); setAvatarProfiles([]); cleanupAll(); });

describe('bundled agent headshots', () => {
  it('keeps legacy records valid, upgrades automatic faces, and rejects untrusted portrait identifiers at persistence', () => {
    const legacy = sampleWorkspace();
    expect(validateWorkspace(legacy).ok).toBe(true);
    expect(legacy.agents.every(agent => agent.avatarId === undefined)).toBe(true);
    const before = avatar('Legacy teammate', 36, { id: 'legacy' });
    setAvatarProfiles([{ id: 'legacy', name: 'Legacy teammate' }]);
    expect(avatar('Legacy teammate', 36, { id: 'legacy' })).toBe(before);
    for (const avatarId of ['https://example.com/photo.svg', '../avatar.svg', '<svg onload=alert(1)>', 'portrait-99']) {
      expect(() => build([{ op: 'agent.edit', id: 'nova', avatarId }], legacy)).toThrow();
      expect(() => build([{ op: 'control-center.set', runtime: 'codex-local', avatarId }], legacy)).toThrow();
      expect(validateWorkspace({ ...legacy, agents: legacy.agents.map(agent => ({ ...agent, avatarId })) }).ok).toBe(false);
      expect(resolveAvatarId('Legacy teammate', { id: 'legacy', avatarId })).toBe(defaultPortrait('Legacy teammate', { id: 'legacy' }).id);
      expect(avatar('Legacy teammate', 36, { id: 'legacy', avatarId })).not.toContain(avatarId);
    }
  });

  it('binds selected portraits to identity across rename and handles duplicate names without cross-assignment', () => {
    setAvatarProfiles([{ id: 'first', name: 'Alex', avatarId: 'portrait-02' }, { id: 'second', name: 'Alex', avatarId: 'portrait-13' }]);
    expect(avatar('Alex', 36, { id: 'first' })).toContain('data-avatar-id="portrait-02"');
    expect(avatar('Alex', 36, { id: 'second' })).toContain('data-avatar-id="portrait-13"');
    expect(resolveAvatarId('Alex')).toBe(defaultPortrait('Alex').id);
    setAvatarProfiles([{ id: 'first', name: 'Renamed', avatarId: 'portrait-02' }, { id: 'control-center', name: 'Tom Chandler', avatarId: 'portrait-11', isCoordinator: true }]);
    expect(avatar('Renamed', 36, { id: 'first' })).toContain('portrait-02.webp');
    expect(avatar('Control Center', 28)).toContain('portrait-11.webp');
    setAvatarProfiles([{ id: 'first', name: 'Renamed' }]);
    expect(resolveAvatarId('Renamed', { id: 'first' })).toBe(defaultPortrait('Renamed', { id: 'first' }).id);
    expect(defaultPortrait('Renamed', { id: 'first' }).id).toBe(defaultPortrait('Original name', { id: 'first' }).id);
    expect(avatar('Renamed', 36, { id: 'first' })).toContain('avatar-human');
    expect(avatar('Renamed', 36, { id: 'first' })).not.toContain('<svg');
  });

  it('ships every allowed portrait as distinct self-contained rendered expression frames', () => {
    expect(avatarCatalog.map((portrait: { id: string }) => portrait.id)).toEqual([...AGENT_AVATAR_IDS]);
    const manifest = JSON.parse(readFileSync(path.resolve('web/headquarters/src/headquarters/assets/avatars-3d/assets.json'), 'utf8'));
    const contents = avatarCatalog.map((portrait: { id: string, frameCount: number, spriteSrc: string }) => {
      expect(portrait.frameCount).toBe(4);
      expect(portrait.spriteSrc).toBe(`/src/headquarters/assets/avatars-3d/${portrait.id}.webp`);
      const webp = readFileSync(path.resolve(`web/headquarters/src/headquarters/assets/avatars-3d/${portrait.id}.webp`));
      const recorded = manifest.assets.find((asset: { id: string }) => asset.id === portrait.id);
      expect(webp.toString('ascii', 0, 4)).toBe('RIFF');
      expect(webp.toString('ascii', 8, 12)).toBe('WEBP');
      expect(webp.readUInt32LE(4) + 8).toBe(webp.length);
      // Read actual VP8 key-frame dimensions, past optional alpha/VP8X chunks,
      // so the manifest cannot mask scaling or a truncated expression strip.
      let pixelFrame: Buffer | undefined;
      for (let offset = 12; offset + 8 <= webp.length;) {
        const length = webp.readUInt32LE(offset + 4);
        if (webp.toString('ascii', offset, offset + 4) === 'VP8 ') pixelFrame = webp.subarray(offset + 8, offset + 8 + length);
        offset += 8 + length + (length % 2);
      }
      expect(pixelFrame).toBeDefined();
      expect([...pixelFrame!.subarray(3, 6)]).toEqual([157, 1, 42]);
      expect(pixelFrame!.readUInt16LE(6) & 0x3fff).toBe(recorded.width);
      expect(pixelFrame!.readUInt16LE(8) & 0x3fff).toBe(recorded.height);
      expect(recorded.width).toBeGreaterThan(2000);
      expect(recorded.height).toBeGreaterThan(700);
      expect(webp.length).toBe(recorded.bytes);
      expect(createHash('sha256').update(webp).digest('hex')).toBe(recorded.sha256);
      return webp;
    });
    expect(new Set(contents.map((buffer: Buffer) => buffer.toString('base64'))).size).toBe(16);
    expect(contents.reduce((bytes: number, buffer: Buffer) => bytes + buffer.length, 0)).toBeLessThan(8_000_000);
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
      expect(avatar(edited.name, 36, { id: edited.id })).toContain('portrait-09.webp');
      await organization.saveAgent({ id: 'atlas', name: 'Atlas', runtime: 'codex-local', departmentId: 'engineering-platform', instructions: 'Plan work.', avatarId: 'portrait-05' });
      await organization.saveAgent({ id: 'control-center', runtime: 'codex-local', avatarId: 'portrait-12' });
      const saved = loadWorkspace(stateRoot).config;
      expect(saved.agents.find(agent => agent.id === 'atlas')?.avatarId).toBe('portrait-05');
      expect(saved.controlCenter?.avatarId).toBe('portrait-12');
      await organization.refreshOrganization();
      expect(avatar('Control Center', 28)).toContain('portrait-12.webp');

      const manager = createCompanyManagement({ organization, avatar, icon });
      for (const editAgentId of ['', 'atlas', 'control-center', created.id]) {
        const html = manager.render({ editAgentId });
        expect(html).toContain('<legend>Choose an animated avatar</legend>');
        expect(html.match(/type="radio" name="avatarId"/g)).toHaveLength(17);
        expect(html).toContain('aria-label="Maya avatar"');
        expect(html).toContain('data-avatar-preview-label');
      }
      const reloadedForm = manager.render({ editAgentId: created.id });
      expect(reloadedForm).toContain('value="portrait-09" aria-label="Elias avatar" checked');
      expect(manager.render({ editDepartmentId: '' }).match(/type="radio" name="headAvatarId"/g)).toHaveLength(17);
      const newDepartment = await organization.saveDepartment({ name: 'Portrait design', headName: 'Portrait head', headRuntime: 'codex-local', headAvatarId: 'portrait-14' });
      expect(loadWorkspace(stateRoot).config.agents.find(agent => agent.id === newDepartment.lead.id)?.avatarId).toBe('portrait-14');
      await organization.saveAgent({ ...values, id: created.id, avatarId: '' });
      await organization.saveAgent({ id: 'control-center', runtime: 'codex-local', avatarId: '' });
      await organization.refreshOrganization();
      expect(loadWorkspace(stateRoot).config.agents.find(agent => agent.id === created.id)?.avatarId).toBeUndefined();
      expect(loadWorkspace(stateRoot).config.controlCenter?.avatarId).toBeUndefined();
      expect(avatar('Control Center', 28)).toContain('avatar-human');
      expect(resolveAvatarId('Control Center')).toBe(defaultPortrait('Control Center', { id: 'control-center' }).id);
      expect(spawner).not.toHaveBeenCalled();

      const snapshot = readFileSync(loadWorkspace(stateRoot).path, 'utf8');
      await expect(organization.saveAgent({ ...values, id: created.id, avatarId: '../remote.svg' })).rejects.toThrow();
      const invalid = await rawRequest(server, { method: 'POST', path: '/api/workspace/ops', headers: { origin: originFor(server), 'x-workforce-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ expectRevision: organization.revision, ops: [{ op: 'agent.edit', id: created.id, avatarId: 'https://example.com/avatar.svg' }] }) });
      expect(invalid.status).toBe(400);
      expect(readFileSync(loadWorkspace(stateRoot).path, 'utf8')).toBe(snapshot);
      for (const portrait of avatarCatalog) {
        const asset = await rawRequest(server, { path: `/src/headquarters/assets/avatars-3d/${portrait.id}.webp` });
        expect(asset.status).toBe(200);
        expect(asset.headers['content-type']).toContain('image/webp');
      }
    } finally { await server.close(); }
  });
});
