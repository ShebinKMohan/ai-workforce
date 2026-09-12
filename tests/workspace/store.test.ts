import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addAgent, addDepartment, setRuntime } from '../../src/workspace/operations.js';
import { loadWorkspace, updateWorkspace } from '../../src/workspace/store.js';
import { cleanupAll, invoke, jsonOf, refusal, tempDir } from './helpers.js';

afterEach(() => cleanupAll());

const CRASH_WRITER = fileURLToPath(new URL('./crash-writer.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function tempsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => /^workspace\.json\.[0-9a-f]{16}\.tmp$/.test(name));
}

describe('workspace store', () => {
  it('loads a missing file as the empty workspace at revision 0 and creates nothing', () => {
    const stateRoot = tempDir();
    const loaded = loadWorkspace(stateRoot);
    expect(loaded).toMatchObject({ exists: false, sha256: null });
    expect(loaded.config.revision).toBe(0);
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  it('writes revision 1 on init, 0600, and does not bump the revision for a change that changes nothing', () => {
    const stateRoot = tempDir();
    const created = updateWorkspace(stateRoot, (c) => c, { createIfMissing: true });
    expect(created).toMatchObject({ written: true, previousRevision: 0, revision: 1 });
    expect((statSync(created.path).mode & 0o777).toString(8)).toBe('600');
    const again = updateWorkspace(stateRoot, (c) => c, { createIfMissing: true });
    expect(again).toMatchObject({ written: false, revision: 1 });
  });

  it('lets exactly one of two writers at the same revision win; the other is refused with exit 3 and changes nothing', () => {
    const stateRoot = tempDir();
    updateWorkspace(stateRoot, (c) => c, { createIfMissing: true });
    const seenByBoth = loadWorkspace(stateRoot).config.revision;

    const first = updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Engineering' }), { expectRevision: seenByBoth });
    const afterFirst = readFileSync(first.path, 'utf8');
    const second = refusal(() => updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Design' }), { expectRevision: seenByBoth }));

    expect(first.revision).toBe(seenByBoth + 1);
    expect([second.exitCode, second.code]).toEqual([3, 'workspace_revision_conflict']);
    expect(readFileSync(first.path, 'utf8')).toBe(afterFirst);
    expect(loadWorkspace(stateRoot).config.departments.map((d) => d.name)).toEqual(['Engineering']);
  });

  it('does the same through the CLI: two saves expecting one revision, one exits 0 and the other exits 3', async () => {
    const stateRoot = tempDir();
    expect((await invoke(['workspace', 'init', '--state-dir', stateRoot])).code).toBe(0);
    const results = await Promise.all(
      ['Engineering', 'Design'].map((name) => invoke(['workspace', 'department', 'add', '--name', name, '--expect-revision', '1', '--state-dir', stateRoot, '--json'])),
    );
    expect(results.map((r) => r.code).sort()).toEqual([0, 3]);
    const loser = results.find((r) => r.code === 3)!;
    expect((jsonOf(loser)['error'] as { code: string }).code).toBe('workspace_revision_conflict');
    expect(loadWorkspace(stateRoot).config).toMatchObject({ revision: 2 });
    expect(loadWorkspace(stateRoot).config.departments).toHaveLength(1);
  });

  it('refuses to replace a file someone edited by hand while the save was in progress', () => {
    const stateRoot = tempDir();
    updateWorkspace(stateRoot, (c) => c, { createIfMissing: true });
    const file = loadWorkspace(stateRoot).path;
    const handEdit = `${JSON.stringify({ schemaVersion: 2, revision: 1, projects: [] })}\n`;

    const error = refusal(() =>
      updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Engineering' }), {
        hooks: { beforeRename: () => writeFileSync(file, handEdit) },
      }),
    );
    expect([error.exitCode, error.code]).toEqual([3, 'workspace_changed_on_disk']);
    expect(readFileSync(file, 'utf8')).toBe(handEdit);
    expect(tempsIn(stateRoot)).toEqual([]);
  });

  it('leaves the previous file intact when the writer is killed between the temp write and the rename', () => {
    const stateRoot = tempDir();
    updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Engineering' }), { createIfMissing: true });
    const file = loadWorkspace(stateRoot).path;
    const before = readFileSync(file, 'utf8');

    const child = spawnSync(process.execPath, ['--import', 'tsx', CRASH_WRITER, stateRoot], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(child.signal).toBe('SIGKILL');

    // The crash happened after the new content was durable: its temp file is the proof.
    const orphans = tempsIn(stateRoot);
    expect(orphans).toHaveLength(1);
    expect(readFileSync(path.join(stateRoot, orphans[0]!), 'utf8')).toContain('Never saved');
    // What a reader sees is exactly the previous file.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(loadWorkspace(stateRoot).config.departments.map((d) => d.name)).toEqual(['Engineering']);

    // The dead writer's lock does not block the next one, which also clears the orphan.
    const next = updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Design' }), { lockWaitMs: 500 });
    expect(next).toMatchObject({ written: true, revision: 2 });
    expect(tempsIn(stateRoot)).toEqual([]);
  });

  it('leaves the previous file intact and no temp file when the save fails before the rename in-process', () => {
    const stateRoot = tempDir();
    updateWorkspace(stateRoot, (c) => c, { createIfMissing: true });
    const file = loadWorkspace(stateRoot).path;
    const before = readFileSync(file, 'utf8');
    expect(() =>
      updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Engineering' }), {
        hooks: {
          beforeRename: () => {
            throw new Error('disk vanished');
          },
        },
      }),
    ).toThrow('disk vanished');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(tempsIn(stateRoot)).toEqual([]);
  });

  it('never overwrites a file it cannot parse, and refuses an invalid change without writing', () => {
    const stateRoot = tempDir();
    const file = path.join(stateRoot, 'workspace.json');
    writeFileSync(file, '{ "schemaVersion": 2, "revision": 3, trailing, }');
    const unparsable = refusal(() => updateWorkspace(stateRoot, (c) => addDepartment(c, { name: 'Engineering' })));
    expect([unparsable.exitCode, unparsable.code]).toEqual([2, 'invalid_workspace']);
    expect(readFileSync(file, 'utf8')).toBe('{ "schemaVersion": 2, "revision": 3, trailing, }');

    const valid = tempDir();
    updateWorkspace(valid, (c) => addDepartment(setRuntime(c, { id: 'codex-local', adapter: 'codex', executable: 'codex' }), { name: 'Engineering' }), { createIfMissing: true });
    const good = readFileSync(path.join(valid, 'workspace.json'), 'utf8');
    const broken = refusal(() =>
      updateWorkspace(valid, (c) => {
        const next = addAgent(c, { id: 'atlas', role: 'head', departmentId: 'engineering', runtime: 'codex-local' });
        next.agents[0]!.policy = 'local-development'; // bypass the op's own check: the store must still refuse it
        return next;
      }),
    );
    expect([broken.exitCode, broken.code]).toEqual([2, 'invalid_workspace_change']);
    expect(broken.details.join('\n')).toMatch(/head_not_read_only/);
    expect(readFileSync(path.join(valid, 'workspace.json'), 'utf8')).toBe(good);
    expect(existsSync(path.join(valid, 'workspace.json'))).toBe(true);
  });
});
