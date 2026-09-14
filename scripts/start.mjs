import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let local = {};
try { local = JSON.parse(readFileSync(path.join(root, '.workforce-local.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.WORKFORCE_PORT ?? local.port ?? 4421);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('WORKFORCE_PORT must be between 1 and 65535.');
const stateDir = path.resolve(process.env.WORKFORCE_STATE_DIR ?? local.stateDir ?? path.join(homedir(), '.workforce'));
const url = `http://127.0.0.1:${port}/`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}

let existing;
try {
  const response = await fetch(`${url}api/office`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  existing = await response.json();
} catch { /* Starting the server below provides the concrete bind error if occupied. */ }
if (existing?.coordinator?.name === 'workforce') {
  if (existing.coordinator.stateRoot !== stateDir) {
    throw new Error(`Port ${port} belongs to another Workforce workspace (${existing.coordinator.stateRoot}). Use WORKFORCE_PORT to choose a free port.`);
  }
  if (existing.coordinator.server?.packageRoot !== root) {
    throw new Error(`Port ${port} is running an older server or another source checkout. Stop that server, then run npm start from ${root} to load the consolidated app.`);
  }
  console.log(`AI Workforce is already running: ${url}\nWorkspace: ${stateDir}\nStop its server before restarting to load backend source changes.`);
  if (process.env.WORKFORCE_NO_OPEN !== '1') {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    await run(opener, [url]);
  }
} else {
  const built = await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')]);
  if (built !== 0) process.exitCode = built;
  else process.exitCode = await run(process.execPath, [path.join(root, 'dist/cli/index.js'), 'serve', '--port', String(port), '--state-dir', stateDir, ...(process.env.WORKFORCE_NO_OPEN === '1' ? [] : ['--open'])]);
}
