/**
 * Executable resolution (FR001).
 *
 * Search order: an explicit override path, then each PATH entry, then the
 * known install locations. Only the exact executable name is stat'ed inside
 * each directory — discovery never walks a tree and never scans the disk.
 * Every matching installation is reported; exactly one is marked selected.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_LOCATIONS, runtimeDescriptor, type DiscoverableAdapter } from './runtimes.js';

export type InstallationSource = 'override' | 'path' | 'known_location';

export interface ExecutableInstallation {
  /** Absolute path as found (may itself be a symlink). */
  readonly path: string;
  /** Symlinks resolved; equals `path` when it is not a link or cannot be resolved. */
  readonly realPath: string;
  readonly source: InstallationSource;
  /** Where it was found: the override flag, the PATH entry or the known directory. */
  readonly origins: ReadonlyArray<string>;
  readonly selected: boolean;
}

export interface ExecutableResolution {
  readonly adapter: DiscoverableAdapter;
  readonly executableName: string;
  /** The override exactly as the user supplied it, or null. */
  readonly requestedOverride: string | null;
  /** Every matching installation, in search order. */
  readonly installations: ReadonlyArray<ExecutableInstallation>;
  readonly selected: ExecutableInstallation | null;
  /** Directories inspected, in order. Bounded by PATH plus the known locations. */
  readonly searchedLocations: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface ResolveOptions {
  /** Explicit path from `--codex-path` / `--claude-path`. A path, not a bare command name. */
  readonly override?: string | null;
  /** PATH value to split; defaults to the process PATH. */
  readonly pathValue?: string | undefined;
  /** Home directory used to expand `~` in the known locations. */
  readonly homeDir?: string;
  /** Known locations to check after PATH; defaults to `KNOWN_LOCATIONS`. */
  readonly knownLocations?: ReadonlyArray<string>;
}

function expandHome(dir: string, homeDir: string): string {
  if (dir === '~') return homeDir;
  if (dir.startsWith('~/')) return path.join(homeDir, dir.slice(2));
  return dir;
}

/** True for a regular file (or a link to one) with an execute bit for this process. */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveReal(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

interface Found {
  readonly path: string;
  readonly source: InstallationSource;
  readonly origin: string;
}

export function resolveExecutable(adapter: DiscoverableAdapter, options: ResolveOptions = {}): ExecutableResolution {
  const descriptor = runtimeDescriptor(adapter);
  const homeDir = options.homeDir ?? os.homedir();
  const pathValue = options.pathValue ?? process.env['PATH'] ?? '';
  const knownLocations = options.knownLocations ?? KNOWN_LOCATIONS;
  const override = options.override === undefined || options.override === null || options.override.trim() === '' ? null : options.override;

  const searched: string[] = [];
  const diagnostics: string[] = [];
  const found: Found[] = [];
  let overrideFailed = false;

  if (override !== null) {
    const absolute = path.resolve(expandHome(override, homeDir));
    searched.push(absolute);
    if (isExecutableFile(absolute)) {
      found.push({ path: absolute, source: 'override', origin: `override ${override}` });
    } else {
      overrideFailed = true;
      diagnostics.push(`explicit path "${override}" (${absolute}) is not an executable file; no runtime is selected for ${adapter} until the path is corrected`);
    }
  }

  const seenDirs = new Set<string>();
  const inspect = (dir: string, source: InstallationSource, origin: string): void => {
    if (dir.length === 0) return;
    const absoluteDir = path.resolve(expandHome(dir, homeDir));
    if (seenDirs.has(absoluteDir)) return;
    seenDirs.add(absoluteDir);
    searched.push(absoluteDir);
    const candidate = path.join(absoluteDir, descriptor.executableName);
    if (isExecutableFile(candidate)) found.push({ path: candidate, source, origin });
  };

  for (const entry of pathValue.split(path.delimiter)) inspect(entry, 'path', `PATH entry ${entry}`);
  for (const entry of knownLocations) inspect(entry, 'known_location', `known location ${entry}`);

  // Merge duplicates by absolute path while preserving every origin that found it.
  const byPath = new Map<string, { source: InstallationSource; origins: string[] }>();
  const order: string[] = [];
  for (const item of found) {
    const existing = byPath.get(item.path);
    if (existing === undefined) {
      byPath.set(item.path, { source: item.source, origins: [item.origin] });
      order.push(item.path);
    } else {
      existing.origins.push(item.origin);
    }
  }

  const selectedPath = overrideFailed ? null : (order[0] ?? null);
  const installations: ExecutableInstallation[] = order.map((p) => {
    const meta = byPath.get(p)!;
    return { path: p, realPath: resolveReal(p), source: meta.source, origins: meta.origins, selected: p === selectedPath };
  });

  const selected = installations.find((i) => i.selected) ?? null;

  if (installations.length > 1) {
    diagnostics.push(
      `${installations.length} ${descriptor.executableName} installations found; using ${selectedPath ?? '(none)'} — others: ${installations
        .filter((i) => !i.selected)
        .map((i) => i.path)
        .join(', ')}`,
    );
  }
  if (installations.length === 0 && override === null) {
    diagnostics.push(`no ${descriptor.executableName} executable on PATH or in the known locations (${knownLocations.join(', ')})`);
  }

  const distinctReal = new Set(installations.map((i) => i.realPath));
  if (installations.length > 1 && distinctReal.size < installations.length) {
    diagnostics.push('some of those paths are links to the same file, so they are one installation reached by several names');
  }

  return { adapter, executableName: descriptor.executableName, requestedOverride: override, installations, selected, searchedLocations: searched, diagnostics };
}
