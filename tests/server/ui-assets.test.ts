import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startOfficeServer } from '../../src/server/index.js';
import { rawRequest } from './support.js';

it('both UI entry modules resolve their shared formatter through actual served HTTP URLs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workforce-ui-assets-'));
  const server = await startOfficeServer({ stateRoot: root, port: 0, discover: async () => [] });
  try {
    const implementations = [];
    for (const entry of ['/workspace/src/pages/task.js', '/src/sidebar.js']) {
      let url = new URL(entry, server.url);
      const module = await rawRequest(server, { path: url.pathname });
      expect(module.status).toBe(200);
      const formatterImport = [...module.body.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].find(match => match[1]?.endsWith('/recorded-output.js'))?.[1];
      expect(formatterImport, `${entry} must reference its recorded-output module`).toBeTruthy();
      url = new URL(formatterImport!, url);
      let source = '';
      for (let depth = 0; depth < 3; depth++) {
        const response = await rawRequest(server, { path: url.pathname });
        expect({ url: url.pathname, status: response.status }).toEqual({ url: url.pathname, status: 200 });
        expect(response.headers['content-type']).toContain('javascript');
        source = response.body;
        const reexport = source.match(/export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/);
        if (!reexport) break;
        url = new URL(reexport[1]!, url);
      }
      expect(source).toContain('export function renderRecordedOutput');
      implementations.push({ url: url.pathname, source });
    }
    expect(implementations[0]).toEqual(implementations[1]);
    expect(implementations[0]?.url).toBe('/workspace/src/recorded-output.js');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
