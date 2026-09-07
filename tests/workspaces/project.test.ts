import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIRTY_PATHS,
  findProjectByPath,
  inspectProject,
  parsePorcelainStatus,
  registerProject,
} from '../../src/workspaces/project.js';
import { git } from '../../src/workspaces/git.js';
import { openTempState } from '../helpers/state.js';
import { cleanupAll, fingerprintCheckout, registerCleanup, tempDir, useFixture } from './support.js';

afterEach(() => cleanupAll());

describe('inspectProject reads a repository without touching it (FR019)', () => {
  it('reports identity, base revision, branch and a clean working tree', async () => {
    const fixture = await useFixture('ts-bug');
    const before = await fingerprintCheckout(fixture.path);

    const inspection = await inspectProject(fixture.path);

    expect(inspection.isGitRepo).toBe(true);
    expect(inspection.canonicalPath).toBe(fixture.path);
    expect(inspection.repositoryRoot).toBe(fixture.path);
    expect(inspection.headRevision).toBe(fixture.headRevision);
    expect(inspection.branch).toBe('main');
    expect(inspection.detachedHead).toBe(false);
    expect(inspection.dirty.clean).toBe(true);
    expect(inspection.hasSubmodules).toBe(false);
    // A single-commit repository: the root commit is HEAD, and the identity is stable.
    expect(inspection.repositoryIdentity.rootCommit).toBe(fixture.headRevision);
    expect(inspection.repositoryIdentity.identityHash).toHaveLength(64);
    expect(inspection.repositoryIdentity.originUrl).toBeNull();

    const again = await inspectProject(fixture.path);
    expect(again.repositoryIdentity.identityHash).toBe(inspection.repositoryIdentity.identityHash);

    const after = await fingerprintCheckout(fixture.path);
    expect(after).toEqual(before);
  });

  it('summarizes staged, unstaged and untracked work and still changes nothing', async () => {
    const fixture = await useFixture('ts-bug');

    writeFileSync(path.join(fixture.path, 'src', 'pagination.js'), '// local edit in progress\n');
    writeFileSync(path.join(fixture.path, 'staged.md'), 'staged work\n');
    await git(['add', 'staged.md'], { cwd: fixture.path });
    writeFileSync(path.join(fixture.path, 'scratch.txt'), 'untracked scratch\n');
    mkdirSync(path.join(fixture.path, 'notes'), { recursive: true });
    writeFileSync(path.join(fixture.path, 'notes', 'todo.md'), 'untracked in a subdirectory\n');

    const before = await fingerprintCheckout(fixture.path);
    const inspection = await inspectProject(fixture.path);

    expect(inspection.dirty.clean).toBe(false);
    expect(inspection.dirty.staged.paths).toEqual(['staged.md']);
    expect(inspection.dirty.unstaged.paths).toEqual(['src/pagination.js']);
    expect([...inspection.dirty.untracked.paths].sort()).toEqual(['notes/todo.md', 'scratch.txt']);
    expect(inspection.dirty.conflicted.count).toBe(0);
    // HEAD is still the committed base: the dirty work is reported, not adopted.
    expect(inspection.headRevision).toBe(fixture.headRevision);

    const after = await fingerprintCheckout(fixture.path);
    expect(after).toEqual(before);
    expect(readFileSync(path.join(fixture.path, 'src', 'pagination.js'), 'utf8')).toBe('// local edit in progress\n');
  });

  it('reports a directory that is not a Git repository instead of throwing', async () => {
    const dir = tempDir('workforce-plain-');
    writeFileSync(path.join(dir, 'file.txt'), 'no git here\n');

    const inspection = await inspectProject(dir);
    expect(inspection.isGitRepo).toBe(false);
    expect(inspection.repositoryRoot).toBeNull();
    expect(inspection.headRevision).toBeNull();
    expect(inspection.diagnostics.join(' ')).toContain('not inside a Git worktree');
  });

  it('resolves a subdirectory to the repository root and says so', async () => {
    const fixture = await useFixture('ts-bug');
    const inspection = await inspectProject(path.join(fixture.path, 'src'));
    expect(inspection.repositoryRoot).toBe(fixture.path);
    expect(inspection.canonicalPath).toBe(path.join(fixture.path, 'src'));
    expect(inspection.diagnostics.join(' ')).toContain('is inside the repository rooted at');
  });
});

describe('parsePorcelainStatus', () => {
  it('caps the listed paths at 50 while keeping the true count', () => {
    const records = Array.from({ length: 60 }, (_, index) => `?? file-${index}.txt`).join('\0');
    const dirty = parsePorcelainStatus(`${records}\0`);
    expect(dirty.untracked.count).toBe(60);
    expect(dirty.untracked.paths).toHaveLength(MAX_DIRTY_PATHS);
    expect(dirty.untracked.truncated).toBe(true);
  });

  it('consumes the origin path of a rename so the next record is not misread', () => {
    const dirty = parsePorcelainStatus('R  new/name.ts\0old/name.ts\0 M src/other.ts\0');
    expect(dirty.staged.paths).toEqual(['new/name.ts']);
    expect(dirty.unstaged.paths).toEqual(['src/other.ts']);
  });

  it('marks conflicted paths', () => {
    const dirty = parsePorcelainStatus('UU src/conflict.ts\0');
    expect(dirty.conflicted.paths).toEqual(['src/conflict.ts']);
    expect(dirty.clean).toBe(false);
  });
});

describe('registerProject persists a project without altering the checkout (FR019)', () => {
  it('stores the identity, reuses one record per repository and leaves the source untouched', async () => {
    const fixture = await useFixture('ts-bug');
    const state = openTempState();
    registerCleanup(() => state.cleanup());

    const before = await fingerprintCheckout(fixture.path);
    const inspection = await inspectProject(fixture.path);
    const record = registerProject(state.store.db, { inspection, dataLocation: state.root, checks: [] });

    expect(record.canonicalPath).toBe(fixture.path);
    expect(record.repositoryIdentity.rootCommit).toBe(fixture.headRevision);
    expect(record.dataLocation).toBe(state.root);
    expect(findProjectByPath(state.store.db, fixture.path)?.id).toBe(record.id);

    // Registering again is an update of the same record, not a second project.
    const second = registerProject(state.store.db, { inspection: await inspectProject(fixture.path), dataLocation: state.root, checks: [{ criterionId: 'x' }] });
    expect(second.id).toBe(record.id);
    const rows = state.store.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    expect(rows.n).toBe(1);

    const after = await fingerprintCheckout(fixture.path);
    expect(after).toEqual(before);
    // Coordinator state lives outside the repository.
    expect(state.root.startsWith(fixture.path)).toBe(false);
  });

  it('refuses to register a directory that is not a Git repository', async () => {
    const dir = tempDir('workforce-plain-');
    const state = openTempState();
    registerCleanup(() => state.cleanup());
    const inspection = await inspectProject(dir);
    expect(() => registerProject(state.store.db, { inspection, dataLocation: state.root })).toThrow(/not a Git repository/);
  });
});

describe('inspection never runs repository hooks', () => {
  it('leaves a hook that would create a marker file unexecuted', async () => {
    const fixture = await useFixture('ts-bug');
    const marker = path.join(tempDir('workforce-hook-'), 'hook-ran.txt');
    const hooks = path.join(fixture.path, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const name of ['pre-commit', 'post-checkout', 'post-index-change', 'post-commit']) {
      const hook = path.join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\necho "${name}" >> "${marker}"\n`, { mode: 0o755 });
    }

    await inspectProject(fixture.path);
    expect(existsSync(marker)).toBe(false);
    // The hooks are still there and still executable; they were simply never run.
    expect(existsSync(path.join(hooks, 'pre-commit'))).toBe(true);
    rmSync(marker, { force: true });
  });
});
