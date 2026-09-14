/**
 * Runtime descriptors: what each supported adapter's executable is called,
 * where it is normally installed, which documented flags a passive probe may
 * use, and how its version string is written (FR001, FR002).
 *
 * Everything here is data observed from the installed executables and their
 * own `--help` output. Nothing in this file starts a model turn.
 */
import type { AdapterId } from '../core/contracts.js';

/** Adapters that discovery knows how to look for. `fake` is a test runtime and is never searched for on disk. */
export type DiscoverableAdapter = Extract<AdapterId, 'codex' | 'claude-code'>;

export const DISCOVERABLE_ADAPTERS: ReadonlyArray<DiscoverableAdapter> = ['codex', 'claude-code'];

/**
 * Directories checked after PATH. Only these exact directories are stat'ed for
 * the executable name; discovery never walks a directory tree and never scans
 * the whole disk (plan section 6, rule 1).
 */
export const KNOWN_LOCATIONS: ReadonlyArray<string> = [
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.codex/bin',
  '~/.npm-global/bin',
];

/** Desktop Codex ships its own CLI, which can differ from the CLI on PATH.
 * These are exact bundle resource directories, not a recursive app scan. */
export const CODEX_DESKTOP_LOCATIONS: ReadonlyArray<string> = [
  '/Applications/Codex.app/Contents/Resources',
  '/Applications/ChatGPT.app/Contents/Resources',
  '~/Applications/Codex.app/Contents/Resources',
  '~/Applications/ChatGPT.app/Contents/Resources',
];

export function knownRuntimeLocations(adapter: DiscoverableAdapter): ReadonlyArray<string> {
  return adapter === 'codex' ? [...KNOWN_LOCATIONS, ...CODEX_DESKTOP_LOCATIONS] : KNOWN_LOCATIONS;
}

export interface RuntimeDescriptor {
  readonly adapter: DiscoverableAdapter;
  /** Executable file name searched for on PATH and in the known locations. */
  readonly executableName: string;
  readonly displayName: string;
  /** Lowest version this adapter claims to support. Below it every capability is `unsupported`. */
  readonly minimumSupportedVersion: string;
  /** Documented flags for the version probe. */
  readonly versionArgs: ReadonlyArray<string>;
  /** Documented login/status command (plan section 6, rule 5: documented mechanisms only). */
  readonly authArgs: ReadonlyArray<string>;
  /** Matches the executable's own version line; group 1 is the version. */
  readonly versionPattern: RegExp;
  /** How the version line looks, for diagnostics. */
  readonly versionExample: string;
  /** Command a user runs to sign in, quoted in diagnostics only. */
  readonly loginHint: string;
}

const CODEX: RuntimeDescriptor = {
  adapter: 'codex',
  executableName: 'codex',
  displayName: 'Codex CLI',
  minimumSupportedVersion: '0.140.0',
  versionArgs: ['--version'],
  authArgs: ['login', 'status'],
  versionPattern: /codex-cli\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)/i,
  versionExample: 'codex-cli 0.147.0',
  loginHint: 'codex login',
};

const CLAUDE_CODE: RuntimeDescriptor = {
  adapter: 'claude-code',
  executableName: 'claude',
  displayName: 'Claude Code',
  minimumSupportedVersion: '2.1.0',
  versionArgs: ['--version'],
  authArgs: ['auth', 'status'],
  versionPattern: /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)\s*\(Claude Code\)/i,
  versionExample: '2.1.260 (Claude Code)',
  loginHint: 'claude auth login',
};

export const RUNTIME_DESCRIPTORS: Readonly<Record<DiscoverableAdapter, RuntimeDescriptor>> = {
  codex: CODEX,
  'claude-code': CLAUDE_CODE,
};

export function runtimeDescriptor(adapter: DiscoverableAdapter): RuntimeDescriptor {
  return RUNTIME_DESCRIPTORS[adapter];
}

/** Raised for a discovery misuse that must never reach a spawn (for example undocumented probe argv). */
export class DiscoveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Version comparison (numeric dotted parts; a prerelease sorts below its release)
// ---------------------------------------------------------------------------

interface ParsedVersion {
  readonly parts: ReadonlyArray<number>;
  readonly prerelease: string | null;
}

export function parseVersion(version: string): ParsedVersion | null {
  const trimmed = version.trim();
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/.exec(trimmed);
  if (match === null) return null;
  const parts = match[1]!.split('.').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return { parts, prerelease: match[2] ?? null };
}

/** -1, 0 or 1. Returns null when either side is not a version this code understands. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** True when `version` is at least `minimum`. Unparseable input is never "at least". */
export function isAtLeast(version: string, minimum: string): boolean {
  const cmp = compareVersions(version, minimum);
  return cmp !== null && cmp >= 0;
}
