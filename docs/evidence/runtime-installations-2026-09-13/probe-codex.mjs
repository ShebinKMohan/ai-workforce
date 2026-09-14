// From the repo root: node --import tsx docs/evidence/runtime-installations-2026-09-13/probe-codex.mjs /absolute/path/to/codex [...]
// Metadata only: initialize and model/list; never starts a thread or turn.
import { CodexRpcClient } from '../../../src/adapters/codex/rpc.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executables = process.argv.slice(2);
if (executables.length === 0 || executables.some(executable => !path.isAbsolute(executable))) throw new Error('Supply one or more absolute Codex executable paths.');
const results = [];
for (const executablePath of executables) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'workforce-catalog-audit-'));
  const rpc = new CodexRpcClient({ executablePath, cwd, requestTimeoutMs: 10000, stopTimeoutMs: 750 });
  const result = { executablePath };
  try {
    rpc.start();
    await rpc.initialize('workforce', '0.1.0', 10000);
    for (const includeHidden of [false, true]) {
      let cursor;
      const models = [];
      const cursors = [];
      for (let page = 0; page < 20; page++) {
        const response = await rpc.request('model/list', { includeHidden, limit: 100, ...(cursor ? { cursor } : {}) }, 10000);
        models.push(...response.data.map(model => ({
          id: model.id, model: model.model, displayName: model.displayName,
          hidden: model.hidden, isDefault: model.isDefault,
          efforts: model.supportedReasoningEfforts?.map(effort => effort.reasoningEffort), inputModalities: model.inputModalities,
        })));
        cursors.push(response.nextCursor ?? null);
        if (!response.nextCursor) break;
        if (cursors.slice(0, -1).includes(response.nextCursor)) throw new Error('Repeated model cursor');
        cursor = response.nextCursor;
      }
      if (cursors.at(-1) !== null) throw new Error('Model catalog exceeded the page limit');
      result[includeHidden ? 'includingHidden' : 'visible'] = { models, cursors };
    }
  } catch {
    result.error = 'Metadata handshake failed; raw provider output omitted.';
  } finally {
    result.stop = await rpc.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
  results.push(result);
}
console.log(JSON.stringify(results, null, 2));
