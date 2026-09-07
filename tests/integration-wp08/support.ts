/**
 * Helpers for the WP08 integration tests: throwaway Git repositories, real
 * artifacts with real patches, and synthetic check receipts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, nowIso } from '../../src/core/ids.js';
import { sha256Hex } from '../../src/core/snapshot.js';
import { COORDINATOR_IDENTITY, gitOrThrow, gitText } from '../../src/workspaces/git.js';
import type { CheckReceipt } from '../../src/verification/checks.js';
import type { ApprovedArtifact } from '../../src/integration/combine.js';

const cleanups: Array<() => void> = [];

export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function cleanupAll(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

export function tempDir(prefix = 'wf-wp08-'): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface TestRepo {
  readonly root: string;
  readonly head: string;
}

/** A repository with one commit holding `files`. */
export async function makeRepo(files: Readonly<Record<string, string>>): Promise<TestRepo> {
  const root = tempDir('wf-wp08-repo-');
  const options = { cwd: root, identity: COORDINATOR_IDENTITY, noHooksDir: root } as const;
  await gitOrThrow(['init', '--quiet', '-b', 'main'], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  await gitOrThrow(['add', '-A'], options);
  await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', 'base'], options);
  return { root, head: await gitText(['rev-parse', 'HEAD'], { cwd: root }) };
}

export interface ArtifactSpec {
  readonly artifactId: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly contractVersion?: number;
  readonly edits: Readonly<Record<string, string>>;
  readonly deletes?: ReadonlyArray<string>;
}

/**
 * Produce a real approved artifact: a worktree off the base, the edits applied
 * and committed, and the resulting patch written to disk with its hash.
 */
export async function makeArtifact(repo: TestRepo, spec: ArtifactSpec): Promise<ApprovedArtifact> {
  const workRoot = tempDir('wf-wp08-art-');
  const worktree = path.join(workRoot, spec.artifactId);
  const branch = `artifact/${spec.artifactId}`;
  await gitOrThrow(['worktree', 'add', '-b', branch, worktree, repo.head], { cwd: repo.root, noHooksDir: workRoot });
  registerCleanup(() => {
    rmSync(worktree, { recursive: true, force: true });
  });
  const options = { cwd: worktree, identity: COORDINATOR_IDENTITY, noHooksDir: workRoot } as const;
  for (const [relative, content] of Object.entries(spec.edits)) {
    const full = path.join(worktree, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const relative of spec.deletes ?? []) rmSync(path.join(worktree, relative), { force: true });
  await gitOrThrow(['add', '-A'], options);
  await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', `artifact ${spec.artifactId}`], options);
  const head = await gitText(['rev-parse', 'HEAD'], { cwd: worktree });
  const diff = await gitOrThrow(['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', repo.head, head], {
    cwd: worktree,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const patchPath = path.join(workRoot, `${spec.artifactId}.patch`);
  writeFileSync(patchPath, diff.stdout, 'utf8');
  return {
    artifactId: spec.artifactId,
    taskId: spec.taskId,
    attemptId: spec.attemptId ?? `${spec.artifactId}-a1`,
    contractVersion: spec.contractVersion ?? 1,
    baseRevision: repo.head,
    patchPath,
    patchHash: sha256Hex(Buffer.from(diff.stdout, 'utf8')),
  };
}

/** A check receipt with the shape the verifier produces, for pure decision tests. */
export function makeReceipt(overrides: Partial<CheckReceipt> & Pick<CheckReceipt, 'criterionId'>): CheckReceipt {
  const revision = overrides.candidate?.revision ?? 'rev-unknown';
  return {
    id: overrides.id ?? newId(),
    criterionId: overrides.criterionId,
    description: overrides.description ?? null,
    required: overrides.required ?? true,
    command: overrides.command ?? 'npm',
    args: overrides.args ?? ['test'],
    cwd: overrides.cwd ?? '.',
    timeoutMs: overrides.timeoutMs ?? 60_000,
    outcome: overrides.outcome ?? 'passed',
    exitCode: overrides.exitCode ?? 0,
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    startedAt: overrides.startedAt ?? nowIso(),
    endedAt: overrides.endedAt ?? nowIso(),
    durationMs: overrides.durationMs ?? 12,
    environmentIdentity: overrides.environmentIdentity ?? { node: process.version, os: process.platform, osRelease: 'test', arch: process.arch, pathHash: 'hash', envKeys: ['PATH'] },
    candidate: overrides.candidate ?? { repoRoot: '/repo', revision, patchHash: null },
    copyStrategy: overrides.copyStrategy ?? 'git_archive',
    integrity: overrides.integrity ?? { before: 'a', after: 'a', mutated: false, mutatedFiles: [], addedFiles: [], fileCount: 1, scope: 'complete' },
    outputSummary: overrides.outputSummary ?? { runner: null, testsRun: null, note: 'test double' },
    stdoutPath: overrides.stdoutPath ?? '/logs/stdout.log',
    stderrPath: overrides.stderrPath ?? '/logs/stderr.log',
    stdoutBytes: overrides.stdoutBytes ?? 0,
    stderrBytes: overrides.stderrBytes ?? 0,
    outputTruncated: overrides.outputTruncated ?? false,
    stdoutTail: overrides.stdoutTail ?? '',
    stderrTail: overrides.stderrTail ?? '',
    evidenceProvenance: 'verifier_executed',
    diagnostics: overrides.diagnostics ?? [],
  };
}
