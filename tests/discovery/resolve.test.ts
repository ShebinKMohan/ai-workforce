/** AT01 — executable resolution: known paths, manual override, several installations, no disk scan (FR001). */
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutable } from '../../src/discovery/resolve.js';
import { fakeCodex, tempDir, writeExecutable } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir();
  roots.push(dir);
  return dir;
}

describe('executable resolution (FR001)', () => {
  it('finds the executable on PATH, resolves its real path through a symlink and reports where it looked', () => {
    const root = scratch();
    const real = path.join(root, 'lib');
    const link = path.join(root, 'bin');
    writeExecutable(real, 'codex', fakeCodex());
    mkdirSync(link, { recursive: true });
    symlinkSync(path.join(real, 'codex'), path.join(link, 'codex'));

    const resolution = resolveExecutable('codex', { pathValue: link, homeDir: root, knownLocations: [] });

    expect(resolution.selected?.path).toBe(path.join(link, 'codex'));
    // On macOS the temp root is itself a symlink, so compare against the fully resolved target.
    expect(resolution.selected?.realPath).toBe(realpathSync(path.join(real, 'codex')));
    expect(resolution.selected?.source).toBe('path');
    expect(resolution.searchedLocations).toEqual([link]);
  });

  it('reports every installation in search order and marks exactly one selected', () => {
    const root = scratch();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const known = path.join(root, 'known');
    writeExecutable(first, 'codex', fakeCodex());
    writeExecutable(second, 'codex', fakeCodex({ version: '0.130.0' }));
    writeExecutable(known, 'codex', fakeCodex());

    const resolution = resolveExecutable('codex', { pathValue: [first, second].join(path.delimiter), homeDir: root, knownLocations: [known] });

    expect(resolution.installations.map((i) => i.path)).toEqual([path.join(first, 'codex'), path.join(second, 'codex'), path.join(known, 'codex')]);
    expect(resolution.installations.filter((i) => i.selected)).toHaveLength(1);
    expect(resolution.selected?.path).toBe(path.join(first, 'codex'));
    expect(resolution.installations[2]?.source).toBe('known_location');
    expect(resolution.diagnostics.join(' ')).toContain('3 codex installations found');
  });

  it('expands ~ in the known locations and records each origin when one path is reached twice', () => {
    const home = scratch();
    const bin = path.join(home, '.local', 'bin');
    writeExecutable(bin, 'codex', fakeCodex());

    const resolution = resolveExecutable('codex', { pathValue: bin, homeDir: home, knownLocations: ['~/.local/bin'] });

    expect(resolution.installations).toHaveLength(1);
    expect(resolution.installations[0]?.origins).toHaveLength(1); // the directory is inspected once, not twice
    expect(resolution.searchedLocations).toEqual([bin]);
  });

  it('prefers an explicit override over anything on PATH', () => {
    const root = scratch();
    const onPath = path.join(root, 'path-bin');
    const manual = path.join(root, 'manual');
    writeExecutable(onPath, 'codex', fakeCodex());
    const override = writeExecutable(manual, 'codex', fakeCodex({ version: '0.141.0' }));

    const resolution = resolveExecutable('codex', { override, pathValue: onPath, homeDir: root, knownLocations: [] });

    expect(resolution.selected?.path).toBe(override);
    expect(resolution.selected?.source).toBe('override');
    expect(resolution.requestedOverride).toBe(override);
    // The PATH installation is still reported so the user can see there is another one.
    expect(resolution.installations.map((i) => i.path)).toContain(path.join(onPath, 'codex'));
  });

  it('selects nothing when the override does not exist rather than silently using a different installation', () => {
    const root = scratch();
    const onPath = path.join(root, 'path-bin');
    writeExecutable(onPath, 'codex', fakeCodex());

    const resolution = resolveExecutable('codex', { override: path.join(root, 'nope', 'codex'), pathValue: onPath, homeDir: root, knownLocations: [] });

    expect(resolution.selected).toBeNull();
    expect(resolution.installations.some((i) => i.selected)).toBe(false);
    expect(resolution.diagnostics.join(' ')).toContain('is not an executable file');
  });

  it('ignores a non-executable file with the right name and reports the runtime as absent', () => {
    const root = scratch();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'codex'), 'not executable', { mode: 0o644 });

    const resolution = resolveExecutable('codex', { pathValue: bin, homeDir: root, knownLocations: [] });

    expect(resolution.installations).toEqual([]);
    expect(resolution.diagnostics.join(' ')).toContain('no codex executable');
  });

  it('checks only the listed directories: an executable in a subdirectory is never discovered', () => {
    const root = scratch();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeExecutable(path.join(bin, 'nested', 'deeper'), 'codex', fakeCodex());

    const resolution = resolveExecutable('codex', { pathValue: bin, homeDir: root, knownLocations: [path.join(root, 'also-known')] });

    expect(resolution.selected).toBeNull();
    // Exactly two directories were inspected: the PATH entry and the known location.
    expect(resolution.searchedLocations).toEqual([bin, path.join(root, 'also-known')]);
  });

  it('discovers a desktop-bundled Codex outside PATH while preserving the PATH selection', () => {
    const home = scratch();
    const bin = path.join(home, 'path-bin');
    const bundle = path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources');
    writeExecutable(bin, 'codex', fakeCodex());
    const bundledCodex = writeExecutable(bundle, 'codex', fakeCodex({ version: '0.154.0-alpha.6.2' }));
    const resolution = resolveExecutable('codex', { pathValue: bin, homeDir: home });
    expect(resolution.selected?.path).toBe(path.join(bin, 'codex'));
    expect(resolution.installations).toContainEqual(expect.objectContaining({ path: bundledCodex, source: 'known_location', selected: false }));
    expect(resolveExecutable('codex', { pathValue: bin, homeDir: home, knownLocations: [] }).installations.map(installation => installation.path)).toEqual([path.join(bin, 'codex')]);
  });
});
