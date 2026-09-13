import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyWorkspace } from '../../src/core/workspace-config.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { FOLDER_RESULT_LIMIT, listProjectFolders } from '../../src/server/project-folders.js';
import { workspaceFilePath } from '../../src/workspace/paths.js';
import { cleanupAll, gitRepo, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest } from './support.js';

const servers: OfficeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); cleanupAll(); });

describe('private local project folder browsing', () => {
  it('lists only shallow visible folders, follows directory aliases, and identifies .git markers without reading files', async () => {
    const root = tempDir('folder-tree-');
    const state = tempDir('folder-state-');
    for (const folder of ['project-a/.git', 'project-b', '.hidden-project', 'ordinary/nested']) mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, 'project-b/.git'), 'This marker is metadata only; no content needs reading.');
    writeFileSync(path.join(root, 'private-file.txt'), 'Never return this file or its contents.');
    symlinkSync(path.join(root, 'project-a'), path.join(root, 'project-alias'));
    symlinkSync(state, path.join(root, 'state-alias'));
    const result = await listProjectFolders({ path: root }, state);
    expect(result.currentPath).toBe(root);
    expect(result.folders.map(folder => folder.name)).toEqual(['ordinary', 'project-a', 'project-alias', 'project-b']);
    expect(result.folders.filter(folder => folder.isGitRepository).map(folder => folder.name)).toEqual(['project-a', 'project-alias', 'project-b']);
    expect(JSON.stringify(result)).not.toContain('private-file');
    expect(JSON.stringify(result)).not.toContain('nested');
    expect((await listProjectFolders({ path: path.join(root, 'project-alias') }, state)).currentPath).toBe(path.join(root, 'project-a'));
    await expect(listProjectFolders({ path: path.join(root, 'state-alias') }, state)).rejects.toMatchObject({ status: 403, code: 'folder_protected' });
  });

  it('rejects malformed paths, files, missing locations, and bounds large directory results', async () => {
    const root = tempDir('folder-many-');
    const state = tempDir('folder-state-');
    writeFileSync(path.join(root, 'file'), 'private');
    for (const request of [{ path: 'relative/path' }, { path: '/bad\u0000path' }, { path: 'x'.repeat(4097) }, { path: root, hidden: true }]) await expect(listProjectFolders(request, state)).rejects.toMatchObject({ status: 400 });
    await expect(listProjectFolders({ path: path.join(root, 'file') }, state)).rejects.toMatchObject({ code: 'folder_not_directory' });
    await expect(listProjectFolders({ path: path.join(root, 'missing') }, state)).rejects.toMatchObject({ status: 404 });
    for (let index = 0; index <= FOLDER_RESULT_LIMIT; index += 1) mkdirSync(path.join(root, `folder-${index}`));
    const result = await listProjectFolders({ path: root }, state);
    expect(result.folders).toHaveLength(FOLDER_RESULT_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it('protects descendants whose names begin with two dots, directly and through visible aliases', async () => {
    const root = tempDir('folder-segments-');
    const state = path.join(root, 'state');
    const privateFolder = path.join(state, '..private');
    const publicFolder = path.join(root, '..public');
    mkdirSync(privateFolder, { recursive: true });
    mkdirSync(publicFolder);
    symlinkSync(privateFolder, path.join(root, 'private-alias'));
    await expect(listProjectFolders({ path: privateFolder }, state)).rejects.toMatchObject({ status: 403, code: 'folder_protected' });
    await expect(listProjectFolders({ path: path.join(root, 'private-alias') }, state)).rejects.toMatchObject({ status: 403, code: 'folder_protected' });
    expect((await listProjectFolders({ path: root }, state)).folders.map(folder => folder.name)).not.toContain('private-alias');
    expect((await listProjectFolders({ path: publicFolder }, state)).currentPath).toBe(publicFolder);
  });

  it('preserves a trailing-space folder through browsing, inspection, and registration beside its unspaced sibling', async () => {
    const parent = tempDir('folder-exact-name-');
    const plain = path.join(parent, 'repo');
    const spaced = path.join(parent, 'repo ');
    renameSync(await gitRepo({ 'README.md': 'Unspaced sibling\n' }), plain);
    renameSync(await gitRepo({ 'README.md': 'The selected trailing-space repository\n' }), spaced);
    const stateRoot = tempDir('folder-exact-state-');
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [] });
    servers.push(server);
    const headers = { origin: originFor(server), 'content-type': 'application/json', 'x-workforce-token': server.token };
    const post = (route: string, body: unknown) => rawRequest(server, { method: 'POST', path: route, headers, body: JSON.stringify(body) });
    const listing = JSON.parse((await post('/api/projects/folders', { path: parent })).body);
    const selected = listing.folders.find((folder: { name: string }) => folder.name === 'repo ');
    expect(selected.path).toBe(spaced);
    const opened = await post('/api/projects/folders', { path: selected.path });
    expect(opened.status).toBe(200);
    expect(JSON.parse(opened.body).currentPath).toBe(spaced);
    const inspection = await post('/api/projects/inspect', { path: JSON.parse(opened.body).currentPath });
    expect(inspection.status).toBe(200);
    expect(JSON.parse(inspection.body)).toMatchObject({ path: spaced, repositoryRoot: spaced, canAdd: true });
    const registered = await post('/api/workspace/ops', { expectRevision: 0, ops: [{ op: 'project.add', id: 'exact-project', name: 'Exact project', repoPath: JSON.parse(inspection.body).repositoryRoot }] });
    expect(registered.status).toBe(200);
    expect(JSON.parse(registered.body).workspace.projects[0].repoPath).toBe(spaced);
    const plainInspection = await post('/api/projects/inspect', { path: plain });
    expect(JSON.parse(plainInspection.body)).toMatchObject({ repositoryRoot: plain, existingProjectId: null, canAdd: true });
    expect(JSON.parse(plainInspection.body).headRevision).not.toBe(JSON.parse(inspection.body).headRevision);
  });

  it('requires the exact host, same-origin session token, and POST before returning private folder metadata', async () => {
    const stateRoot = tempDir('folder-server-');
    const root = tempDir('folder-private-');
    mkdirSync(path.join(root, 'private-project'));
    const discover = vi.fn(async () => []);
    const spawner = vi.fn(() => { throw new Error('Folder browsing must not start a runtime.'); });
    const server = await startOfficeServer({ stateRoot, port: 0, discover, spawner });
    servers.push(server);
    const headers = { origin: originFor(server), 'content-type': 'application/json', 'x-workforce-token': server.token };
    for (const rejected of [
      { ...headers, host: `evil.example:${server.port}` },
      { ...headers, origin: 'https://evil.example' },
      { ...headers, origin: '' },
      { ...headers, 'x-workforce-token': '' },
      { ...headers, 'x-workforce-token': 'wrong' },
    ]) {
      const response = await rawRequest(server, { method: 'POST', path: '/api/projects/folders', headers: rejected, body: JSON.stringify({ path: root }) });
      expect(response.status).toBe(403);
      expect(response.body).not.toContain('private-project');
    }
    expect((await rawRequest(server, { path: '/api/projects/folders' })).status).toBe(405);
    const response = await rawRequest(server, { method: 'POST', path: '/api/projects/folders', headers, body: JSON.stringify({ path: root }) });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).folders[0].name).toBe('private-project');
    expect(discover).not.toHaveBeenCalled();
    expect(spawner).not.toHaveBeenCalled();
  });

  it('browses and inspects a committed repository without changing its project registration', async () => {
    const stateRoot = tempDir('folder-real-repo-');
    const config = emptyWorkspace();
    const repoPath = await gitRepo({ 'README.md': '# Picker acceptance repository\n' });
    config.projects.push({ id: 'ai-employee', name: 'AI Employee', repoPath, checks: [], archived: false });
    const file = workspaceFilePath(stateRoot);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config));
    const before = readFileSync(file, 'utf8');
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [] });
    servers.push(server);
    const headers = { origin: originFor(server), 'content-type': 'application/json', 'x-workforce-token': server.token };
    const listing = await rawRequest(server, { method: 'POST', path: '/api/projects/folders', headers, body: JSON.stringify({ path: repoPath }) });
    expect(listing.status).toBe(200);
    expect(JSON.parse(listing.body)).toMatchObject({ currentPath: repoPath, isGitRepository: true, places: expect.arrayContaining([{ label: 'AI Employee', path: repoPath }]) });
    const inspection = await rawRequest(server, { method: 'POST', path: '/api/projects/inspect', headers, body: JSON.stringify({ path: JSON.parse(listing.body).currentPath }) });
    expect(inspection.status).toBe(200);
    expect(JSON.parse(inspection.body)).toMatchObject({ repositoryRoot: repoPath, existingProjectId: 'ai-employee', canAdd: false });
    expect(JSON.parse(inspection.body).headRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
