import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDesktopServer, inspectDesktopEndpoint } from '../desktop-launch.mjs';
import { readLauncherSettings } from './settings.mjs';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };
const stop = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'workforce-launcher-')));
  const repo = path.join(root, 'Source with spaces');
  mkdirSync(path.join(repo, 'src/cli'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'workforce' }));
  writeFileSync(path.join(repo, 'src/cli/index.ts'), '// fixture source');
  const stateDir = path.join(root, 'state');
  return { root, repo, stateDir, options: { repoRoot: repo, homeDir: root, env: {}, identityTimeoutMs: 250, launcherRoot: path.join(root, 'launcher'), logRoot: path.join(root, 'logs') } };
}
const identity = (repo, stateDir, pid = process.pid) => ({ ok: true, officeVersion: 1, coordinator: { name: 'workforce', stateRoot: stateDir, server: { packageRoot: repo, pid, startedAt: 'fixture' } } });

test('local preferences work from any working directory and reject invalid ports', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repo, '.workforce-local.json'), JSON.stringify({ port: 4428, stateDir: 'local-state' }));
    const settings = readLauncherSettings({ repoRoot: f.repo, env: {}, homeDir: f.root });
    assert.equal(settings.port, 4428); assert.equal(settings.stateDir, path.join(f.repo, 'local-state'));
    assert.throws(() => readLauncherSettings({ repoRoot: f.repo, env: { WORKFORCE_PORT: 'invalid' } }), error => error.code === 'invalid_port');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('reuses only the exact running source and data folder; refuses an unrelated listener', async () => {
  const f = fixture(); let document = identity(f.repo, f.stateDir);
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(document)); });
  const port = await listen(server);
  writeFileSync(path.join(f.repo, '.workforce-local.json'), JSON.stringify({ port, stateDir: f.stateDir }));
  try {
    const result = await ensureDesktopServer(f.options);
    assert.equal(result.action, 'reused'); assert.equal(result.serverPid, process.pid);
    document = identity('/different/source', f.stateDir);
    await assert.rejects(ensureDesktopServer(f.options), error => error.code === 'port_in_use');
    document = identity(f.repo, '/different/state');
    await assert.rejects(ensureDesktopServer(f.options), error => error.code === 'port_in_use');
    assert.equal(server.listening, true);
  } finally { await stop(server); rmSync(f.root, { recursive: true, force: true }); }
});

test('two cold launches build the backend and UI vendor once before spawning the same verified server', async () => {
  const f = fixture(); const probe = createServer(); const port = await listen(probe); await stop(probe);
  writeFileSync(path.join(f.repo, '.workforce-local.json'), JSON.stringify({ port, stateDir: f.stateDir }));
  mkdirSync(path.join(f.repo, 'node_modules/typescript/bin'), { recursive: true }); mkdirSync(path.join(f.repo, 'dist/cli'), { recursive: true });
  const marker = path.join(f.root, 'builds.txt');
  writeFileSync(path.join(f.repo, 'node_modules/typescript/bin/tsc'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'build\\n');`);
  mkdirSync(path.join(f.repo, 'scripts'), { recursive: true });
  writeFileSync(path.join(f.repo, 'scripts/build-ui-vendor.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'ui\\n');`);
  const serverSource = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'serve\\n');const http=require('node:http'); const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(${JSON.stringify(identity(f.repo, f.stateDir))}.coordinator ? {ok:true,officeVersion:1,coordinator:{name:'workforce',stateRoot:${JSON.stringify(f.stateDir)},server:{packageRoot:${JSON.stringify(f.repo)},pid:process.pid,startedAt:'fixture'}}}:{}));});server.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  writeFileSync(path.join(f.repo, 'dist/cli/index.js'), serverSource);
  let pid;
  try {
    const [first, second] = await Promise.all([ensureDesktopServer(f.options), ensureDesktopServer(f.options)]);
    pid = first.serverPid;
    assert.equal(second.serverPid, pid); assert.equal(first.action, 'started'); assert.equal(second.action, 'reused');
    assert.equal(readFileSync(marker, 'utf8'), 'build\nui\nserve\n');
    const settings = readLauncherSettings({ repoRoot: f.repo, env: {}, homeDir: f.root });
    assert.equal((await inspectDesktopEndpoint(settings)).state, 'matching');
  } finally {
    if (pid) { process.kill(pid, 'SIGTERM'); for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { break; } } }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a partial dependency tree without a lock file is rejected before building or spawning', async () => {
  const f = fixture(); const probe = createServer(); const port = await listen(probe); await stop(probe);
  writeFileSync(path.join(f.repo, '.workforce-local.json'), JSON.stringify({ port, stateDir: f.stateDir }));
  writeFileSync(path.join(f.repo, 'package.json'), JSON.stringify({ name: 'workforce', dependencies: { motion: '13.2.0' } }));
  mkdirSync(path.join(f.repo, 'node_modules/typescript/bin'), { recursive: true });
  mkdirSync(path.join(f.repo, 'dist/cli'), { recursive: true });
  const marker = path.join(f.root, 'unexpected-execution.txt');
  const recordExecution = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed\\n');`;
  writeFileSync(path.join(f.repo, 'node_modules/typescript/bin/tsc'), recordExecution);
  writeFileSync(path.join(f.repo, 'dist/cli/index.js'), recordExecution);
  try {
    await assert.rejects(ensureDesktopServer(f.options), error => error.code === 'dependencies_missing');
    assert.equal(existsSync(marker), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
