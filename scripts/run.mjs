import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDesktopServer } from './desktop-launch.mjs';

export function openWorkspace(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('The browser could not be opened.')));
  });
}

export async function runWorkspace({ ensure = ensureDesktopServer, open = openWorkspace, write = console.log, noOpen = false } = {}) {
  write('Opening AI Workforce…');
  write('Checking your workspace and preparing anything it needs.');
  const result = await ensure();
  write(`\nAI Workforce is ready: ${result.url}`);
  write(result.action === 'reused' ? 'Using your existing running workspace.' : 'Frontend and backend started together.');
  write('You can close this launcher window; your workforce keeps running.');
  if (!noOpen) {
    try { await open(result.url); }
    catch { write(`The app is running. Open ${result.url} in your browser.`); }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('AI Workforce launcher\n\nOpen run.sh to start the frontend and backend together.\nDouble-click Run Workforce.command on a Mac.\n\n--no-open   Start without opening a browser.');
    return;
  }
  if (args.some(arg => arg !== '--no-open')) {
    console.error('This launcher needs no arguments. Use --help for the optional settings.');
    process.exitCode = 2;
    return;
  }
  try { await runWorkspace({ noOpen: args.includes('--no-open') || process.env.WORKFORCE_NO_OPEN === '1' }); }
  catch (error) {
    console.error(`\nAI Workforce could not start: ${error.message}`);
    if (error.logPath) console.error(`Startup details: ${error.logPath}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
