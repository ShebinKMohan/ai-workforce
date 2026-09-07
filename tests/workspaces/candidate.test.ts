import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import { newSpawnToken, observeProcessIdentity, type ProcessIdentity } from '../../src/core/process.js';
import {
  CandidateWorkspaceError,
  assertGrantedPathsSafe,
  candidateBranchName,
  candidateWritePaths,
  createCandidateWorkspace,
  removeCandidateWorkspace,
  snapshotCandidate,
  type CandidateWorkspace,
} from '../../src/workspaces/candidate.js';
import { git, gitTextOrNull } from '../../src/workspaces/git.js';
import { inspectProject } from '../../src/workspaces/project.js';
import { cleanupAll, fingerprintCheckout, fixedPaginationSource, registerCleanup, tempDir, useFixture, writeInto } from './support.js';

afterEach(() => cleanupAll());

interface Prepared {
  readonly repo: string;
  readonly headRevision: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

async function prepare(fixtureName: 'ts-bug' | 'py-bug' = 'ts-bug'): Promise<Prepared> {
  const fixture = await useFixture(fixtureName);
  return {
    repo: fixture.path,
    headRevision: fixture.headRevision,
    workspaceRoot: tempDir('workforce-workspaces-'),
    runId: newId(),
    taskId: newId(),
    attemptId: newId(),
  };
}

async function makeCandidate(prepared: Prepared, overrides: Partial<Parameters<typeof createCandidateWorkspace>[0]> = {}): Promise<CandidateWorkspace> {
  return await createCandidateWorkspace({
    projectRoot: prepared.repo,
    baseRevision: prepared.headRevision,
    runId: prepared.runId,
    taskId: prepared.taskId,
    attemptId: prepared.attemptId,
    workspaceRoot: prepared.workspaceRoot,
    ...overrides,
  });
}

describe('createCandidateWorkspace (FR041)', () => {
  it('creates a linked worktree on a new branch and leaves the user checkout alone', async () => {
    const prepared = await prepare();
    const before = await fingerprintCheckout(prepared.repo);

    const workspace = await makeCandidate(prepared);

    expect(workspace.branch).toBe(candidateBranchName(prepared.runId, prepared.taskId, prepared.attemptId));
    expect(workspace.baseRevision).toBe(prepared.headRevision);
    expect(existsSync(path.join(workspace.path, 'src', 'pagination.js'))).toBe(true);
    expect(workspace.path.startsWith(prepared.workspaceRoot)).toBe(true);
    // The worktree checkout starts exactly at the base revision.
    expect(await gitTextOrNull(['rev-parse', 'HEAD'], { cwd: workspace.path })).toBe(prepared.headRevision);

    const after = await fingerprintCheckout(prepared.repo);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe(before.status);
    expect(after.tree).toBe(before.tree);
  });

  it('records the uncommitted changes the candidate excludes', async () => {
    const prepared = await prepare();
    writeFileSync(path.join(prepared.repo, 'src', 'pagination.js'), '// work in progress\n');
    const inspection = await inspectProject(prepared.repo);

    const workspace = await makeCandidate(prepared, { excludedDirty: inspection.dirty });

    expect(workspace.excludedUncommittedChanges?.unstaged.paths).toEqual(['src/pagination.js']);
    // The candidate really does start from the committed base, not from the dirty tree.
    expect(readFileSync(path.join(workspace.path, 'src', 'pagination.js'), 'utf8')).toContain('Math.floor(total / pageSize)');
    // ... and the user's own edit is still there.
    expect(readFileSync(path.join(prepared.repo, 'src', 'pagination.js'), 'utf8')).toBe('// work in progress\n');
  });

  it('refuses to reuse an existing branch rather than overwriting it', async () => {
    const prepared = await prepare();
    const branch = candidateBranchName(prepared.runId, prepared.taskId, prepared.attemptId);
    await git(['branch', branch, prepared.headRevision], { cwd: prepared.repo });

    await expect(makeCandidate(prepared)).rejects.toThrow(/already exists/);
    await expect(makeCandidate(prepared)).rejects.toMatchObject({ code: 'branch_exists' });
    // The pre-existing branch still points where it did.
    expect(await gitTextOrNull(['rev-parse', branch], { cwd: prepared.repo })).toBe(prepared.headRevision);
  });

  it('refuses an unresolvable base and a workspace root inside the repository', async () => {
    const prepared = await prepare();
    await expect(makeCandidate(prepared, { baseRevision: 'refs/heads/does-not-exist' })).rejects.toMatchObject({ code: 'unresolvable_base' });
    await expect(makeCandidate(prepared, { workspaceRoot: path.join(prepared.repo, 'inside') })).rejects.toMatchObject({ code: 'workspace_inside_repository' });
  });
});

describe('granted paths never include shared Git administration', () => {
  it('grants the worktree only and refuses grants that reach Git or coordinator state', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);
    const stateRoot = tempDir('workforce-state-');

    expect(candidateWritePaths(workspace)).toEqual([workspace.path]);
    expect(() => assertGrantedPathsSafe(workspace, candidateWritePaths(workspace), [stateRoot])).not.toThrow();

    expect(() => assertGrantedPathsSafe(workspace, [prepared.repo])).toThrow(/user's checkout/);
    expect(() => assertGrantedPathsSafe(workspace, [path.join(prepared.repo, '.git')])).toThrow(/protected state/);
    expect(workspace.gitAdminDir).not.toBeNull();
    expect(() => assertGrantedPathsSafe(workspace, [workspace.gitAdminDir!])).toThrow(/Git administration/);
    expect(() => assertGrantedPathsSafe(workspace, [stateRoot], [stateRoot])).toThrow(/protected state/);
  });
});

describe('snapshotCandidate freezes the candidate (FR041)', () => {
  it('creates a checkpoint commit on the candidate branch with a coordinator identity, and a hashed patch', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);
    const beforeUser = await fingerprintCheckout(prepared.repo);

    writeFileSync(path.join(workspace.path, 'src', 'pagination.js'), fixedPaginationSource());
    writeInto(workspace.path, 'docs/notes.md', 'why the off-by-one happened\n');

    const snapshot = await snapshotCandidate(workspace);

    expect(snapshot.checkpointCreated).toBe(true);
    expect(snapshot.candidateRevision).not.toBe(prepared.headRevision);
    expect(snapshot.baseRevision).toBe(prepared.headRevision);
    expect([...snapshot.changedFiles].sort()).toEqual(['docs/notes.md', 'src/pagination.js']);
    expect(snapshot.patchHash).toHaveLength(64);
    expect(existsSync(snapshot.patchPath)).toBe(true);

    const patch = readFileSync(snapshot.patchPath, 'utf8');
    expect(patch).toContain('a/src/pagination.js');
    expect(patch).toContain('Math.ceil(total / pageSize)');

    // The checkpoint commit belongs to managed candidate history, not the user's branch.
    const mainHead = await gitTextOrNull(['rev-parse', 'main'], { cwd: prepared.repo });
    expect(mainHead).toBe(prepared.headRevision);
    const branchHead = await gitTextOrNull(['rev-parse', workspace.branch], { cwd: prepared.repo });
    expect(branchHead).toBe(snapshot.candidateRevision);
    const contains = await git(['branch', '--contains', snapshot.candidateRevision, '--format=%(refname:short)'], { cwd: prepared.repo });
    expect(contains.stdout.trim().split('\n').filter((l) => l.length > 0)).toEqual([workspace.branch]);

    // Coordinator identity, not the user's.
    const author = await gitTextOrNull(['log', '-1', '--format=%an <%ae>', snapshot.candidateRevision], { cwd: prepared.repo });
    expect(author).toBe('workforce coordinator <coordinator@workforce.invalid>');
    const committer = await gitTextOrNull(['log', '-1', '--format=%cn <%ce>', snapshot.candidateRevision], { cwd: prepared.repo });
    expect(committer).toBe('workforce coordinator <coordinator@workforce.invalid>');

    const afterUser = await fingerprintCheckout(prepared.repo);
    expect(afterUser.head).toBe(beforeUser.head);
    expect(afterUser.branch).toBe(beforeUser.branch);
    expect(afterUser.tree).toBe(beforeUser.tree);
  });

  it('reports an unchanged candidate honestly instead of inventing a commit', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);

    const snapshot = await snapshotCandidate(workspace);

    expect(snapshot.checkpointCreated).toBe(false);
    expect(snapshot.candidateRevision).toBe(prepared.headRevision);
    expect(snapshot.changedFiles).toEqual([]);
    expect(readFileSync(snapshot.patchPath, 'utf8')).toBe('');
  });

  it('refuses to snapshot while the writing process is still alive', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);
    writeFileSync(path.join(workspace.path, 'src', 'pagination.js'), fixedPaginationSource());

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    registerCleanup(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
    });
    const writer: ProcessIdentity = observeProcessIdentity(child.pid!, newSpawnToken());

    await expect(snapshotCandidate(workspace, { writer })).rejects.toThrow(/still running/);
    await expect(snapshotCandidate(workspace, { writer })).rejects.toMatchObject({ code: 'writer_not_quiesced' });
    // Nothing was committed while the writer was alive.
    expect(await gitTextOrNull(['rev-parse', workspace.branch], { cwd: prepared.repo })).toBe(prepared.headRevision);

    process.kill(-child.pid!, 'SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    // A dead writer no longer blocks the snapshot.
    const snapshot = await snapshotCandidate(workspace, { writer });
    expect(snapshot.checkpointCreated).toBe(true);
  });

  it('does not run repository hooks when it creates the checkpoint commit', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);
    const marker = path.join(tempDir('workforce-hook-'), 'hook-ran.txt');
    const hooks = path.join(prepared.repo, '.git', 'hooks');
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg']) {
      writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    }

    writeFileSync(path.join(workspace.path, 'src', 'pagination.js'), fixedPaginationSource());
    const snapshot = await snapshotCandidate(workspace);

    expect(snapshot.checkpointCreated).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('removeCandidateWorkspace never discards unintegrated work', () => {
  it('refuses removal until the candidate is explicitly integrated or rejected', async () => {
    const prepared = await prepare();
    const workspace = await makeCandidate(prepared);
    writeFileSync(path.join(workspace.path, 'src', 'pagination.js'), fixedPaginationSource());
    const snapshot = await snapshotCandidate(workspace);

    const refused = await removeCandidateWorkspace(workspace);
    expect(refused.removed).toBe(false);
    expect(refused.reason).toContain('never discarded');
    expect(existsSync(workspace.path)).toBe(true);

    const removed = await removeCandidateWorkspace(workspace, { disposition: 'rejected', snapshot });
    expect(removed.removed).toBe(true);
    expect(removed.branchKept).toBe(true);
    expect(removed.recoverableRefs).toContain(workspace.branch);
    expect(existsSync(workspace.path)).toBe(false);

    // The commits survive: a rejected candidate stays recoverable.
    expect(await gitTextOrNull(['rev-parse', workspace.branch], { cwd: prepared.repo })).toBe(snapshot.candidateRevision);
    const show = await git(['show', `${snapshot.candidateRevision}:src/pagination.js`], { cwd: prepared.repo });
    expect(show.stdout).toContain('Math.ceil(total / pageSize)');
  });
});

describe('candidateBranchName', () => {
  it('rejects identifiers that cannot be a Git ref segment', () => {
    expect(() => candidateBranchName('run', 'task', '..')).toThrow(CandidateWorkspaceError);
    expect(() => candidateBranchName('run', 'task', 'with space')).toThrow(/cannot be used in a Git branch name/);
    expect(() => candidateBranchName('run', 'task', 'x.lock')).toThrow(/cannot be used in a Git branch name/);
    expect(candidateBranchName('r1', 't1', 'a1')).toBe('workforce/r1/t1/a1');
  });
});
