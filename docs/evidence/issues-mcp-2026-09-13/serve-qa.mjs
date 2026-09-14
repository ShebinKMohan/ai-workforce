/** Reopen the finished disposable fixture for browser verification. Starts no work. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOfficeServer } from './runtime/dist/server/index.js';
const out = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(out, '../../..');
const proof = JSON.parse(await fs.readFile(path.join(out, 'proof-result.json'), 'utf8'));
if (!proof.runId) throw new Error('A recorded fixture run is required.');
const server = await startOfficeServer({ stateRoot: proof.stateRoot, port: 0, webRoot: path.join(root, 'web/headquarters'), cliInvocation: { command: process.execPath, args: [path.join(out, 'runtime/dist/cli/index.js')], cwd: root } });
const receipt = { schemaVersion: 1, openedAt: new Date().toISOString(), url: server.url, projectId: 'mcp-math', issueId: proof.issueId, requestId: proof.requestId, runId: proof.runId, stateRoot: proof.stateRoot, pid: process.pid };
await fs.writeFile(path.join(out, 'qa-server.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
