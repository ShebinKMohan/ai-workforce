import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class LauncherError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'LauncherError'; this.code = code; Object.assign(this, details); }
}

export function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Same local preferences and environment overrides as npm start. No global configuration writes. */
export function readLauncherSettings({ repoRoot, env = process.env, homeDir = homedir() }) {
  const root = canonicalPath(repoRoot);
  let local = {};
  try {
    local = JSON.parse(readFileSync(path.join(root, '.workforce-local.json'), 'utf8'));
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('object required');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new LauncherError('invalid_preferences', 'Your local workspace settings could not be read. Restore a valid .workforce-local.json file in the AI Workforce folder, then try again.');
  }
  const port = Number(env.WORKFORCE_PORT ?? local.port ?? 4421);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new LauncherError('invalid_port', 'The workspace port must be a number from 1 to 65535. Correct the port in your local workspace settings, then try again.');
  const selectedState = env.WORKFORCE_STATE_DIR ?? local.stateDir ?? path.join(homeDir, '.workforce');
  if (typeof selectedState !== 'string' || !selectedState.trim()) throw new LauncherError('invalid_state', 'The workspace data folder is missing from your local settings. Choose a valid folder, then try again.');
  const stateDir = canonicalPath(path.resolve(root, selectedState));
  const runtimePath = [...new Set([path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(homeDir, '.local/bin'), path.join(homeDir, '.cargo/bin'), ...(env.PATH ?? '').split(path.delimiter), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(path.delimiter);
  return { repoRoot: root, port, stateDir, url: `http://127.0.0.1:${port}/`, env: { ...env, PATH: runtimePath } };
}
