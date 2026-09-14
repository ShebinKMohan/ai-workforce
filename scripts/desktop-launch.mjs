/** Shared on-demand startup. Returns a verified URL for the native app or script launcher. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { canonicalPath, LauncherError, readLauncherSettings } from './launcher/settings.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIN_NODE = [22, 13];

function requireSource(repoRoot) {
  let pkg;
  try { pkg = JSON.parse(requireRead(path.join(repoRoot, 'package.json'))); } catch { /* actionable refusal below */ }
  if (pkg?.name !== 'workforce' || !existsSync(path.join(repoRoot, 'src/cli/index.ts'))) {
    throw new LauncherError('source_missing', 'The AI Workforce source folder has moved or is unavailable. Choose its current folder to reconnect this app.', { repoRoot });
  }
}

import { readFileSync as requireRead } from 'node:fs';

async function portHasListener(port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}

/** A refused/unknown HTTP endpoint is never treated as permission to replace a listener. */
export async function inspectDesktopEndpoint(settings, { timeoutMs = 8000 } = {}) {
  try {
    const response = await fetch(new URL('/api/office', settings.url), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { state: 'occupied', reason: 'The selected port returned an unexpected response.' };
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) { await response.body?.cancel().catch(() => {}); return { state: 'occupied', reason: 'The selected port did not provide a valid workspace identity.' }; }
      chunks.push(chunk);
    }
    const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const coordinator = document?.coordinator;
    if (document?.ok !== true || document?.officeVersion !== 1 || coordinator?.name !== 'workforce') return { state: 'occupied', reason: 'Another application is using this workspace port.' };
    if (typeof coordinator.stateRoot !== 'string' || canonicalPath(coordinator.stateRoot) !== settings.stateDir) return { state: 'occupied', reason: 'This port is already serving a different workspace data folder.' };
    if (typeof coordinator.server?.packageRoot !== 'string' || canonicalPath(coordinator.server.packageRoot) !== settings.repoRoot) return { state: 'occupied', reason: 'This port is already serving a different or older AI Workforce source folder.' };
    return { state: 'matching', serverPid: Number.isInteger(coordinator.server.pid) ? coordinator.server.pid : null, startedAt: coordinator.server.startedAt ?? null };
  } catch {
    return await portHasListener(settings.port) ? { state: 'occupied', reason: 'An application is using this port but has not confirmed its workspace identity.' } : { state: 'offline' };
  }
}

function refuseOccupied(settings, endpoint) {
  throw new LauncherError('port_in_use', `${endpoint.reason} AI Workforce has left it running. Close that other workspace when its work is finished, or choose a different port in this project's local settings, then try again.`, { port: settings.port });
}

async function runLogged(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', options.logFd, options.logFd], shell: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs);
    const killTimer = setTimeout(() => { if (timedOut) child.kill('SIGKILL'); }, options.timeoutMs + 1500);
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(killTimer); resolve({ code, timedOut }); });
  });
}

function dependenciesReady(repoRoot) {
  if (!existsSync(path.join(repoRoot, 'node_modules/typescript/bin/tsc'))) return false;
  try {
    const pkg = JSON.parse(requireRead(path.join(repoRoot, 'package.json')));
    const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const lock = existsSync(path.join(repoRoot, 'package-lock.json')) ? JSON.parse(requireRead(path.join(repoRoot, 'package-lock.json'))) : null;
    return direct.every(name => {
      const installed = JSON.parse(requireRead(path.join(repoRoot, 'node_modules', name, 'package.json')));
      const expected = lock?.packages?.[`node_modules/${name}`]?.version;
      return Boolean(installed.version) && (!expected || expected === installed.version);
    });
  } catch { return false; }
}

/** Kernel-released SQLite lock: a crashed or double-clicked launcher cannot strand a PID lock. */
async function withStartupLock(lockPath, timeoutMs, action) {
  const db = new DatabaseSync(lockPath);
  db.exec('PRAGMA busy_timeout = 0');
  let acquired = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (!acquired) {
      try { db.exec('BEGIN IMMEDIATE'); acquired = true; }
      catch (error) {
        if (!/locked|busy/i.test(error.message)) throw error;
        if (Date.now() >= deadline) throw new LauncherError('startup_busy', 'AI Workforce is already being prepared by another app launch. Give it a moment, then try again.');
        await pause(150);
      }
    }
    return await action();
  } finally { if (acquired) db.exec('ROLLBACK'); db.close(); }
}

export async function ensureDesktopServer(options = {}) {
  const majorMinor = process.versions.node.split('.').slice(0, 2).map(Number);
  if (majorMinor[0] < MIN_NODE[0] || (majorMinor[0] === MIN_NODE[0] && majorMinor[1] < MIN_NODE[1])) throw new LauncherError('node_outdated', 'AI Workforce needs a newer Node.js installation. Update Node.js, then open this app again.');
  const homeDir = options.homeDir ?? homedir();
  const settings = readLauncherSettings({ repoRoot: options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: options.env ?? process.env, homeDir });
  requireSource(settings.repoRoot);
  const launcherRoot = options.launcherRoot ?? path.join(homeDir, 'Library/Application Support/AI Workforce/Launcher');
  const logRoot = options.logRoot ?? path.join(homeDir, 'Library/Logs/AI Workforce');
  mkdirSync(launcherRoot, { recursive: true, mode: 0o700 });
  mkdirSync(logRoot, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(settings.repoRoot).digest('hex').slice(0, 16);
  const logPath = path.join(logRoot, `workspace-${settings.port}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const inspect = () => inspectDesktopEndpoint(settings, { timeoutMs: options.identityTimeoutMs ?? 8000 });
  const ready = (endpoint, action) => ({ ok: true, action, url: settings.url, repoRoot: settings.repoRoot, stateRoot: settings.stateDir, serverPid: endpoint.serverPid, serverStartedAt: endpoint.startedAt, logPath });
  const existing = await inspect();
  if (existing.state === 'matching') return ready(existing, 'reused');
  if (existing.state === 'occupied') refuseOccupied(settings, existing);
  return withStartupLock(path.join(launcherRoot, `startup-${key}.sqlite`), options.lockTimeoutMs ?? 240_000, async () => {
    const current = await inspect();
    if (current.state === 'matching') return ready(current, 'reused');
    if (current.state === 'occupied') refuseOccupied(settings, current);
    const logFd = openSync(logPath, 'a', 0o600);
    try {
      const tscPath = path.join(settings.repoRoot, 'node_modules/typescript/bin/tsc');
      if (!dependenciesReady(settings.repoRoot)) {
        if (!existsSync(path.join(settings.repoRoot, 'package-lock.json'))) throw new LauncherError('dependencies_missing', 'This copy of AI Workforce is missing its dependency lock file. Choose a complete source folder or restore the missing file, then try again.');
        const installed = await runLogged('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: settings.repoRoot, env: settings.env, logFd, timeoutMs: options.installTimeoutMs ?? 180_000 });
        if (installed.code !== 0) throw new LauncherError('dependency_install_failed', 'AI Workforce could not finish preparing its local dependencies. Check your internet connection and try again. The details are saved in the startup log.');
      }
      const built = await runLogged(process.execPath, [tscPath], { cwd: settings.repoRoot, env: settings.env, logFd, timeoutMs: options.buildTimeoutMs ?? 90_000 });
      if (built.code !== 0) throw new LauncherError('build_failed', built.timedOut ? 'Preparing AI Workforce took longer than expected. Try again, or open the startup log for details.' : 'AI Workforce could not prepare this source version. Open the startup log for the specific build error, fix the source issue, then try again.');
      const uiBuilder = path.join(settings.repoRoot, 'scripts/build-ui-vendor.mjs');
      if (existsSync(uiBuilder)) {
        const uiBuilt = await runLogged(process.execPath, [uiBuilder], { cwd: settings.repoRoot, env: settings.env, logFd, timeoutMs: options.buildTimeoutMs ?? 90_000 });
        if (uiBuilt.code !== 0) throw new LauncherError('build_failed', 'AI Workforce could not prepare the interface. Open the startup log for details, then try again.');
      }
      const beforeSpawn = await inspect();
      if (beforeSpawn.state === 'matching') return ready(beforeSpawn, 'reused');
      if (beforeSpawn.state === 'occupied') refuseOccupied(settings, beforeSpawn);
      const child = spawn(process.execPath, [path.join(settings.repoRoot, 'dist/cli/index.js'), 'serve', '--port', String(settings.port), '--state-dir', settings.stateDir], { cwd: settings.repoRoot, env: settings.env, detached: true, stdio: ['ignore', logFd, logFd], shell: false });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      child.unref();
      const deadline = Date.now() + (options.startupTimeoutMs ?? 60_000);
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null) throw new LauncherError('server_start_failed', 'The workspace could not start. The startup log contains the specific problem; existing work has not been stopped.');
        const endpoint = await inspect();
        if (endpoint.state === 'matching') {
          const result = ready(endpoint, 'started');
          await fs.writeFile(path.join(launcherRoot, `last-start-${key}.json`), `${JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
          return result;
        }
        await pause(250);
      }
      // The server may still be warming up. Do not kill it: it might already own work.
      throw new LauncherError('server_not_ready', 'The workspace is still starting and has not confirmed that it is ready. Wait a moment and try opening AI Workforce again. You can inspect the startup log if it keeps happening.');
    } catch (error) {
      if (error instanceof LauncherError) { error.logPath = logPath; throw error; }
      throw new LauncherError('startup_failed', 'AI Workforce could not start. Open the startup log for details, then try again.', { logPath });
    } finally { closeSync(logFd); }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--repo')) throw new LauncherError('invalid_arguments', 'The app launcher has an invalid setup. Reinstall AI Workforce.app from the current source folder.');
  try { process.stdout.write(`${JSON.stringify(await ensureDesktopServer(args[1] ? { repoRoot: args[1] } : {}))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'startup_failed', message: error instanceof LauncherError ? error.message : 'AI Workforce could not start. Please try again.', ...(error.logPath ? { logPath: error.logPath } : {}), ...(error.repoRoot ? { repoRoot: error.repoRoot } : {}) })}\n`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
