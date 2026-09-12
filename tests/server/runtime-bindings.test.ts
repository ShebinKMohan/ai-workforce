import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyWorkspace } from '../../src/core/workspace-config.js';
import { startOfficeServer } from '../../src/server/index.js';
import { workspaceFilePath } from '../../src/workspace/paths.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';
import { rawRequest } from './support.js';

afterEach(cleanupAll);

it('invalidates passive readiness when a saved runtime changes outside this server', async () => {
  const stateRoot = tempDir('workforce-binding-cache-');
  const config = emptyWorkspace();
  const file = workspaceFilePath(stateRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  const discover = vi.fn(async () => []);
  const server = await startOfficeServer({ stateRoot, port: 0, discover });
  try {
    expect((await rawRequest(server, { path: '/api/workspace' })).status).toBe(200);
    expect((await rawRequest(server, { path: '/api/workspace' })).status).toBe(200);
    expect(discover).toHaveBeenCalledTimes(1);
    config.runtimes['codex-local'] = { adapter: 'codex', executable: '/missing/codex' };
    config.revision += 1;
    writeFileSync(file, JSON.stringify(config));
    expect((await rawRequest(server, { path: '/api/workspace' })).status).toBe(200);
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {
    await server.close();
  }
});
