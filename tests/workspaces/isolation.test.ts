import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateWorkspace, assertGrantedPathsSafe, removeCandidateWorkspace, snapshotCandidate } from '../../src/workspaces/candidate.js';
import { git, gitOrThrow, gitText, gitTextOrNull } from '../../src/workspaces/git.js';
import { observeProcessIdentity } from '../../src/core/process.js';
import { cleanupAll, fingerprintCheckout, tempDir, useFixture, writeInto } from './support.js';

afterEach(cleanupAll);

function objectFileIdentities(root: string): Set<string> {
  const identities = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { const stat = statSync(file); identities.add(`${stat.dev}:${stat.ino}`); }
    }
  };
  walk(root);
  return identities;
}

describe('attempt and project Git isolation', () => {
  it('keeps independent refs, configuration, objects and worktree identity for simultaneous attempts', async () => {
    const project = await useFixture('ts-bug');
    const root = tempDir('workforce-private-git-');
    await gitOrThrow(['config', 'workforce.localContext', 'original-only'], { cwd: project.path });
    const before = await fingerprintCheckout(project.path);
    const candidates = await Promise.all(['left', 'right'].map(attemptId => createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: root, runId: 'run', taskId: 'task', attemptId })));
    const left = candidates[0]!;
    const right = candidates[1]!;
    const sourceObjects = objectFileIdentities(path.join(project.path, '.git/objects'));
    for (const candidate of [left, right]) {
      expect(candidate.gitIsolation).toBe('independent');
      expect(candidate.gitAdminDir).not.toBe(path.join(project.path, '.git'));
      expect(await gitText(['rev-parse', '--git-common-dir'], { cwd: candidate.path })).toBe(candidate.gitAdminDir);
      expect(await gitText(['worktree', 'list', '--porcelain'], { cwd: candidate.path })).toContain(`worktree ${candidate.path}`);
      expect(existsSync(path.join(candidate.gitAdminDir!, 'objects/info/alternates'))).toBe(false);
      const candidateObjects = objectFileIdentities(path.join(candidate.gitAdminDir!, 'objects'));
      expect(candidateObjects.size).toBeGreaterThan(0);
      expect([...candidateObjects].some(identity => sourceObjects.has(identity))).toBe(false);
      expect(await gitTextOrNull(['config', '--local', '--get', 'workforce.localContext'], { cwd: candidate.path })).toBeNull();
      expect(await gitTextOrNull(['remote'], { cwd: candidate.path })).toBeNull();
      expect(() => assertGrantedPathsSafe(candidate, [candidate.path])).not.toThrow();
      expect(() => assertGrantedPathsSafe(candidate, [candidate.gitAdminDir!])).toThrow(/protected state/);
    }
    await gitOrThrow(['update-ref', 'refs/heads/attempt-private', left.baseRevision], { cwd: left.path });
    expect(await gitTextOrNull(['rev-parse', '--verify', 'refs/heads/attempt-private'], { cwd: right.path })).toBeNull();
    expect(await gitTextOrNull(['rev-parse', '--verify', 'refs/heads/attempt-private'], { cwd: project.path })).toBeNull();
    expect(await fingerprintCheckout(project.path)).toEqual(before);
  });

  it('preserves dirty projects while concurrent writes and recovery checkpoints stay with the correct project', async () => {
    const projects = await Promise.all([useFixture('ts-bug'), useFixture('ts-bug')]);
    const roots = [tempDir('workforce-project-a-'), tempDir('workforce-project-b-')];
    for (const [index, project] of projects.entries()) {
      writeInto(project.path, 'local-draft.txt', `untracked project ${index}`);
      writeInto(project.path, 'node_modules/local-cache.txt', `private dependency ${index}`);
      writeInto(project.path, 'src/pagination.js', `// dirty source ${index}\n`);
    }
    const before = await Promise.all(projects.map(project => fingerprintCheckout(project.path)));
    const candidates = await Promise.all(projects.map((project, index) => createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: roots[index]!, runId: 'same-run', taskId: 'same-task', attemptId: 'first' })));
    for (const [index, candidate] of candidates.entries()) {
      expect(existsSync(path.join(candidate.path, 'local-draft.txt'))).toBe(false);
      expect(existsSync(path.join(candidate.path, 'node_modules'))).toBe(false);
      writeInto(candidate.path, 'result.txt', `project ${index} result\n`);
    }
    const snapshots = await Promise.all(candidates.map(candidate => snapshotCandidate(candidate)));
    for (const [index, project] of projects.entries()) {
      const own = snapshots[index]!;
      const other = snapshots[1 - index]!;
      expect(await gitText(['show', `${own.candidateRevision}:result.txt`], { cwd: project.path })).toBe(`project ${index} result`);
      expect((await git(['cat-file', '-e', `${other.candidateRevision}^{commit}`], { cwd: project.path })).ok).toBe(false);
      const resumed = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: roots[index]!, runId: 'same-run', taskId: 'same-task', attemptId: 'replacement', baseRevision: own.candidateRevision });
      expect(readFileSync(path.join(resumed.path, 'result.txt'), 'utf8')).toBe(`project ${index} result\n`);
      await expect(createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: roots[index]!, runId: 'same-run', taskId: 'same-task', attemptId: 'foreign-replacement', baseRevision: other.candidateRevision })).rejects.toMatchObject({ code: 'unresolvable_base' });
      expect(await fingerprintCheckout(project.path)).toEqual(before[index]);
    }
  });

  it('rejects a replaced .git pointer before snapshotting or changing another project', async () => {
    const [project, other] = await Promise.all([useFixture('ts-bug'), useFixture('py-bug')]);
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'task', attemptId: 'attempt' });
    const before = await fingerprintCheckout(other.path);
    writeFileSync(path.join(candidate.path, '.git'), `gitdir: ${path.join(other.path, '.git')}\n`);
    writeInto(candidate.path, 'contamination.txt', 'must never be staged in another project');
    await expect(snapshotCandidate(candidate)).rejects.toMatchObject({ code: 'candidate_git_identity_changed' });
    expect(await fingerprintCheckout(other.path)).toEqual(before);
    expect(await gitTextOrNull(['rev-parse', '--verify', candidate.branch], { cwd: project.path })).toBeNull();
  });

  it('rejects redirected Git worktree configuration and conflicting checkpoint publication', async () => {
    const [project, other] = await Promise.all([useFixture('ts-bug'), useFixture('py-bug')]);
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'task', attemptId: 'attempt' });
    const before = await fingerprintCheckout(other.path);
    await gitOrThrow(['config', 'core.worktree', other.path], { cwd: candidate.path });
    await expect(snapshotCandidate(candidate)).rejects.toMatchObject({ code: 'candidate_git_identity_changed' });
    expect(await fingerprintCheckout(other.path)).toEqual(before);

    const first = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'same-run', taskId: 'same-task', attemptId: 'same-attempt' });
    const second = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'same-run', taskId: 'same-task', attemptId: 'same-attempt' });
    writeInto(first.path, 'result.txt', 'first owner');
    writeInto(second.path, 'result.txt', 'conflicting owner');
    const published = await snapshotCandidate(first);
    await expect(snapshotCandidate(second)).rejects.toMatchObject({ code: 'candidate_ref_changed' });
    expect(await gitText(['rev-parse', first.branch], { cwd: project.path })).toBe(published.candidateRevision);
    expect(await gitText(['show', `${first.branch}:result.txt`], { cwd: project.path })).toBe('first owner');
    expect(readFileSync(path.join(second.path, 'result.txt'), 'utf8')).toBe('conflicting owner');
  });

  it('rejects a workspace-root symlink into source and aliased write grants to source or administration', async () => {
    const project = await useFixture('ts-bug');
    const outside = tempDir();
    symlinkSync(project.path, path.join(outside, 'alias'));
    await expect(createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: path.join(outside, 'alias', 'nested'), runId: 'run', taskId: 'task', attemptId: 'attempt' })).rejects.toMatchObject({ code: 'workspace_inside_repository' });
    expect(existsSync(path.join(project.path, 'nested'))).toBe(false);
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: path.join(outside, 'safe'), runId: 'run', taskId: 'task', attemptId: 'attempt' });
    symlinkSync(candidate.gitAdminDir!, path.join(outside, 'admin-alias'));
    expect(() => assertGrantedPathsSafe(candidate, [path.join(outside, 'admin-alias')])).toThrow(/protected state/);
    expect(() => assertGrantedPathsSafe(candidate, [path.join(outside, 'alias', 'src')])).toThrow(/user's checkout/);
    mkdirSync(path.join(outside, 'nested-root'), { recursive: true });
    symlinkSync(project.path, path.join(outside, 'nested-root', 'run'));
    await expect(createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: path.join(outside, 'nested-root'), runId: 'run', taskId: 'task', attemptId: 'attempt' })).rejects.toMatchObject({ code: 'workspace_inside_repository' });
  });

  it('keeps work written after a snapshot when cleanup is requested', async () => {
    const project = await useFixture('ts-bug');
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'task', attemptId: 'attempt' });
    const snapshot = await snapshotCandidate(candidate);
    writeInto(candidate.path, 'later-work.txt', 'preserve this later edit');
    const result = await removeCandidateWorkspace(candidate, { disposition: 'rejected', snapshot });
    expect(result.removed).toBe(false);
    expect(readFileSync(path.join(candidate.path, 'later-work.txt'), 'utf8')).toBe('preserve this later edit');
  });

  it('removes an unchanged stopped read-only copy without publishing a checkpoint', async () => {
    const project = await useFixture('ts-bug');
    const before = await fingerprintCheckout(project.path);
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'head', attemptId: 'attempt' });
    // An explicit disposition alone is not evidence that a read-only runtime stopped.
    expect((await removeCandidateWorkspace(candidate, { disposition: 'rejected' })).removed).toBe(false);
    await expect(removeCandidateWorkspace(candidate, { disposition: 'rejected', readOnly: { quiesced: true, writer: observeProcessIdentity(process.pid) } })).rejects.toMatchObject({ code: 'writer_not_quiesced' });
    expect(existsSync(candidate.path)).toBe(true);
    const result = await removeCandidateWorkspace(candidate, { disposition: 'rejected', readOnly: { quiesced: true, writer: null } });
    expect(result).toMatchObject({ removed: true, branchKept: false, recoverableRefs: [candidate.baseRevision] });
    expect(existsSync(candidate.path)).toBe(false);
    expect(existsSync(candidate.gitAdminDir!)).toBe(true);
    expect(await gitTextOrNull(['rev-parse', '--verify', candidate.branch], { cwd: project.path })).toBeNull();
    expect(await fingerprintCheckout(project.path)).toEqual(before);
  });

  it.each(['tracked', 'untracked', 'ignored', 'committed'] as const)('retains unexpected %s work in a stopped read-only copy', async (kind) => {
    const project = await useFixture('ts-bug');
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'head', attemptId: 'attempt' });
    const file = kind === 'tracked' ? 'src/pagination.js' : kind === 'ignored' ? 'node_modules/private-output.txt' : 'unexpected.txt';
    writeInto(candidate.path, file, 'keep unexpected output');
    if (kind === 'committed') {
      await gitOrThrow(['add', file], { cwd: candidate.path });
      await gitOrThrow(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unexpected head commit'], { cwd: candidate.path });
    }
    const result = await removeCandidateWorkspace(candidate, { disposition: 'rejected', readOnly: { quiesced: true, writer: null } });
    expect(result.removed).toBe(false);
    expect(readFileSync(path.join(candidate.path, file), 'utf8')).toBe('keep unexpected output');
  });

  it('retains a stopped read-only copy with redirected Git administration', async () => {
    const [project, other] = await Promise.all([useFixture('ts-bug'), useFixture('py-bug')]);
    const candidate = await createCandidateWorkspace({ projectRoot: project.path, workspaceRoot: tempDir(), runId: 'run', taskId: 'head', attemptId: 'attempt' });
    const before = await fingerprintCheckout(other.path);
    writeFileSync(path.join(candidate.path, '.git'), `gitdir: ${path.join(other.path, '.git')}\n`);
    await expect(removeCandidateWorkspace(candidate, { disposition: 'rejected', readOnly: { quiesced: true, writer: null } })).rejects.toMatchObject({ code: 'candidate_git_identity_changed' });
    expect(existsSync(candidate.path)).toBe(true);
    expect(await fingerprintCheckout(other.path)).toEqual(before);
  });
});
