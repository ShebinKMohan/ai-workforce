/**
 * Candidate workspaces (FR041).
 *
 * Each attempt has an independent Git repository, with its worktree at
 * `<workspaceRoot>/<runId>/<taskId>/<attemptId>` and Git administration in
 * a sibling directory outside the worker's write grant. Objects, refs,
 * hooks and local configuration are never shared with the user's repository.
 * Frozen checkpoints are imported by the coordinator into a candidate ref
 * for verification/recovery; the user's index, branch and files stay untouched.
 *
 * Base selection: R0/R1 use the committed HEAD. Uncommitted work in the
 * user's checkout is excluded, and the exclusion is recorded on the run with
 * the dirty summary, so a report can state exactly what was left out rather
 * than implying HEAD and the working tree were equivalent.
 *
 * SECURITY BOUNDARY — read this before granting paths to a worker.
 * Independent Git administration prevents accidental shared-ref mutation.
 * It is not an OS security sandbox. Therefore:
 *   - `candidateWritePaths()` grants the worktree directory only;
 *   - `assertGrantedPathsSafe()` refuses any grant that covers a Git
 *     administrative directory (`.git`, `.git/worktrees/...`) or the
 *     coordinator's own state;
 *   - the enforced execution boundary for tool and test subprocesses is
 *     FR042 work (WP03 minimum boundary, WP10 full suite), not something a
 *     worktree provides.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { isProcessGroupAlive, matchProcessIdentity, type ProcessIdentity } from '../core/process.js';
import { isWithin } from '../storage/paths.js';
import { COORDINATOR_IDENTITY, branchExists, git, gitOrThrow, gitText, gitTextOrNull, isSafeRefSegment, resolveRevision, withRepositoryLock } from './git.js';
import type { DirtySummary } from './project.js';

export const CANDIDATE_BRANCH_PREFIX = 'workforce';

export interface CreateCandidateInput {
  /** Realpath of the user's repository root. Never modified. */
  readonly projectRoot: string;
  /** Commit-ish the candidate starts from; defaults to the committed HEAD. */
  readonly baseRevision?: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Coordinator-owned workspace root, outside the repository. */
  readonly workspaceRoot: string;
  /** Uncommitted state that this candidate excludes, recorded on the workspace. */
  readonly excludedDirty?: DirtySummary | null;
  readonly branchPrefix?: string;
  readonly signal?: AbortSignal;
}

export interface CandidateWorkspace {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly projectRoot: string;
  /** The worktree directory. This is the only path a worker is granted. */
  readonly path: string;
  readonly branch: string;
  readonly baseRevision: string;
  /**
   * The worktree's administrative directory, outside its write grant.
   * Recorded so it can be *excluded* from grants; never hand it to a worker.
   */
  readonly gitAdminDir: string | null;
  /** Missing on older persisted linked-worktree records. */
  readonly gitIsolation?: 'independent' | 'linked';
  /** Uncommitted changes in the user's checkout that this candidate does not include. */
  readonly excludedUncommittedChanges: DirtySummary | null;
  readonly createdAt: string;
}

export class CandidateWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CandidateWorkspaceError';
    this.code = code;
  }
}

export function candidateBranchName(runId: string, taskId: string, attemptId: string, prefix: string = CANDIDATE_BRANCH_PREFIX): string {
  for (const [name, segment] of [['branch prefix', prefix], ['run id', runId], ['task id', taskId], ['attempt id', attemptId]] as const) {
    if (!isSafeRefSegment(segment)) {
      throw new CandidateWorkspaceError('unsafe_ref_segment', `${name} "${segment}" cannot be used in a Git branch name`);
    }
  }
  return `${prefix}/${runId}/${taskId}/${attemptId}`;
}

/**
 * Create the candidate worktree on a brand new branch. Refuses to reuse an
 * existing branch or a non-empty directory.
 */
export async function createCandidateWorkspace(input: CreateCandidateInput): Promise<CandidateWorkspace> {
  // Serialize coordinator setup for the same source; worker execution is not
  // serialized and does not share this repository's Git administration.
  return await withRepositoryLock(realpathSync(input.projectRoot), () => createCandidateWorkspaceUnlocked(input));
}

async function createCandidateWorkspaceUnlocked(input: CreateCandidateInput): Promise<CandidateWorkspace> {
  const projectRoot = realpathSync(input.projectRoot);
  const branch = candidateBranchName(input.runId, input.taskId, input.attemptId, input.branchPrefix ?? CANDIDATE_BRANCH_PREFIX);

  const requestedBase = input.baseRevision ?? 'HEAD';
  const baseRevision = await resolveRevision(projectRoot, requestedBase);
  if (baseRevision === null) {
    throw new CandidateWorkspaceError(
      'unresolvable_base',
      `base revision "${requestedBase}" does not resolve to a commit in ${projectRoot}; a repository with no commits has no committed base to work from`,
    );
  }

  if (await branchExists(projectRoot, branch)) {
    throw new CandidateWorkspaceError(
      'branch_exists',
      `candidate branch "${branch}" already exists in ${projectRoot}; refusing to reuse or overwrite it (an existing branch may hold unintegrated work)`,
    );
  }

  const workspaceRoot = canonicalCandidatePath(input.workspaceRoot);
  const target = path.join(workspaceRoot, input.runId, input.taskId, input.attemptId);
  const gitAdminDir = `${target}.git`;
  if (existsSync(target) || existsSync(gitAdminDir)) {
    throw new CandidateWorkspaceError('workspace_exists', `candidate workspace ${target} already exists; refusing to reuse a workspace that may still have a writer`);
  }
  if (isWithin(projectRoot, workspaceRoot)) {
    throw new CandidateWorkspaceError('workspace_inside_repository', `workspace root ${workspaceRoot} is inside the repository ${projectRoot}; candidate workspaces must live outside the user's checkout`);
  }
  // An existing run/task parent may itself be a symlink into the checkout.
  if (isWithin(projectRoot, canonicalCandidatePath(path.dirname(target)))) {
    throw new CandidateWorkspaceError('workspace_inside_repository', `candidate parent resolves inside the user's checkout ${projectRoot}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  // Reserve the directory atomically. A second process cannot initialize or
  // overwrite a partially prepared attempt even though queues are in-process.
  try { mkdirSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CandidateWorkspaceError('workspace_exists', `candidate workspace ${target} already exists; refusing to reuse it`);
    throw error;
  }
  const options = {
    cwd: target,
    noHooksDir: workspaceRoot,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const objectFormat = await gitText(['rev-parse', '--show-object-format'], { cwd: projectRoot });
  await gitOrThrow(['init', '--template=', `--object-format=${objectFormat}`, `--separate-git-dir=${gitAdminDir}`, target], options);
  await gitOrThrow(['config', 'core.worktree', target], options);
  // Fetch copies objects through the local transport. Unlike a local clone,
  // it creates neither hardlinks nor alternates and copies no source config.
  await gitOrThrow(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', projectRoot, baseRevision], options);
  await gitOrThrow(['checkout', '-b', branch, baseRevision], options);

  return {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    projectRoot,
    path: realpathSync(target),
    branch,
    baseRevision,
    gitAdminDir: readGitAdminDir(target),
    gitIsolation: 'independent',
    excludedUncommittedChanges: input.excludedDirty ?? null,
    createdAt: nowIso(),
  };
}

/** Resolve existing ancestors too, so a missing leaf cannot hide a symlink. */
function canonicalCandidatePath(value: string): string {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalCandidatePath(parent), path.basename(absolute));
}

/** Read either a separate Git directory marker or a legacy ordinary .git directory. */
function readGitAdminDir(worktreePath: string): string | null {
  const marker = path.join(worktreePath, '.git');
  try {
    if (statSync(marker).isDirectory()) return marker;
    const content = readFileSync(marker, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (match === null) return null;
    return path.resolve(worktreePath, match[1]!.trim());
  } catch {
    return null;
  }
}

/** The only paths a worker may be granted for this candidate. */
export function candidateWritePaths(workspace: CandidateWorkspace): string[] {
  return [workspace.path];
}

/**
 * Refuse a grant that would hand a worker shared Git administration or
 * coordinator state. Called before a session is opened, so a mistake fails
 * setup instead of silently widening the boundary.
 *
 * `protectedPaths` are the coordinator's own files and directories (the state
 * database, the lock, the paths manifest, the runs directory) — not the whole
 * state root. The default workspace root lives *inside* the state root, so
 * protecting the root wholesale would forbid the candidate itself. Keeping the
 * boundary at the coordinator's own files is what this function can honestly
 * enforce; stopping a worker from walking out of its workspace with `../..` is
 * the enforced execution boundary of FR042 and is not claimed here.
 */
export function assertGrantedPathsSafe(workspace: CandidateWorkspace, granted: ReadonlyArray<string>, protectedPaths: ReadonlyArray<string> = []): void {
  const projectRoot = canonicalCandidatePath(workspace.projectRoot);
  const forbidden: string[] = [canonicalCandidatePath(path.join(projectRoot, '.git')), ...protectedPaths.map(canonicalCandidatePath)];
  if (workspace.gitAdminDir !== null) forbidden.push(workspace.gitAdminDir);

  for (const grant of granted) {
    const resolved = canonicalCandidatePath(grant);
    if (isWithin(resolved, projectRoot)) {
      throw new CandidateWorkspaceError('grant_covers_user_checkout', `granting "${resolved}" would give the worker write access to the user's checkout ${projectRoot}`);
    }
    for (const bad of forbidden) {
      const protectedPath = canonicalCandidatePath(bad);
      if (isWithin(resolved, protectedPath) || isWithin(protectedPath, resolved)) {
        throw new CandidateWorkspaceError(
          'grant_covers_git_administration',
          `granting "${resolved}" would expose protected state at "${bad}"; shared Git administration and coordinator state are never writable by a worker`,
        );
      }
    }
    if (isWithin(resolved, projectRoot) || isWithin(projectRoot, resolved)) {
      throw new CandidateWorkspaceError('grant_covers_user_checkout', `granting "${resolved}" would give the worker write access to the user's checkout ${projectRoot}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SnapshotCandidateInput {
  /**
   * Identity of the process that was writing this workspace. Snapshotting is
   * refused while it is alive or cannot be verified: `report_result` does not
   * revoke a worker's write access, so the writer must be observed stopped
   * before the candidate is frozen.
   */
  readonly writer?: ProcessIdentity | null;
  /** Where `candidate.patch` is written. Defaults to a file beside the workspace. */
  readonly patchPath?: string;
  readonly message?: string;
  readonly signal?: AbortSignal;
  readonly now?: string;
}

export interface CandidateFileChange {
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface CandidateSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly branch: string;
  readonly baseRevision: string;
  /** HEAD of the candidate branch after the checkpoint; equals the base when nothing changed. */
  readonly candidateRevision: string;
  readonly checkpointCreated: boolean;
  readonly patchPath: string;
  /** sha256 of the patch bytes; the candidate's content identity. */
  readonly patchHash: string;
  readonly patchBytes: number;
  readonly changedFiles: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<CandidateFileChange>;
  readonly snapshotAt: string;
}

export class QuiesceError extends CandidateWorkspaceError {
  constructor(message: string) {
    super('writer_not_quiesced', message);
    this.name = 'QuiesceError';
  }
}

/**
 * Freeze the candidate: verify no writer is running, commit whatever the
 * worker left with a coordinator identity (never the user's), then produce a
 * binary-safe patch and its content hash.
 */
export async function snapshotCandidate(workspace: CandidateWorkspace, input: SnapshotCandidateInput = {}): Promise<CandidateSnapshot> {
  const now = input.now ?? nowIso();
  assertQuiesced(workspace, input.writer ?? null);
  await assertCandidateGitIdentity(workspace);

  const noHooksDir = path.dirname(workspace.path);
  const options = {
    cwd: workspace.path,
    noHooksDir,
    identity: COORDINATOR_IDENTITY,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  } as const;

  // Stage everything the worker left behind (.gitignore still applies, so
  // build output and dependency caches stay out of the candidate).
  await gitOrThrow(['add', '-A'], options);

  const staged = await git(['diff', '--cached', '--quiet'], options);
  const hasChanges = staged.exitCode === 1;
  if (!staged.ok && !hasChanges) throw new CandidateWorkspaceError('diff_failed', `could not determine staged changes in ${workspace.path}: ${staged.stderr.trim()}`);

  let checkpointCreated = false;
  if (hasChanges) {
    const message = input.message ?? `workforce candidate checkpoint\n\nrun: ${workspace.runId}\ntask: ${workspace.taskId}\nattempt: ${workspace.attemptId}\nbase: ${workspace.baseRevision}\n`;
    await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', message], options);
    checkpointCreated = true;
  }

  const candidateRevision = await gitText(['rev-parse', 'HEAD'], { cwd: workspace.path });
  const range = `${workspace.baseRevision}..${candidateRevision}`;

  const patchRun = await gitOrThrow(['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', workspace.baseRevision, candidateRevision], {
    cwd: workspace.path,
    maxOutputBytes: 64 * 1024 * 1024,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const patchBuffer = Buffer.from(patchRun.stdout, 'utf8');
  if (patchRun.truncated) {
    throw new CandidateWorkspaceError('patch_too_large', `the diff for ${range} exceeded the capture limit; the candidate cannot be represented by a complete patch`);
  }

  const patchPath = path.resolve(input.patchPath ?? path.join(path.dirname(workspace.path), `${workspace.attemptId}.candidate.patch`));
  mkdirSync(path.dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, patchBuffer, { mode: 0o600 });

  const changes = await readChangedFiles(workspace.path, workspace.baseRevision, candidateRevision);

  if (workspace.gitIsolation === 'independent') {
    await withRepositoryLock(workspace.projectRoot, async () => {
      // Import objects only, then atomically publish this attempt's ref. The
      // original checkout never becomes the candidate's working directory.
      await gitOrThrow(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', workspace.path, candidateRevision], {
        cwd: workspace.projectRoot,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const ref = `refs/heads/${workspace.branch}`;
      const prior = await resolveRevision(workspace.projectRoot, ref);
      if (prior !== null && !(await git(['merge-base', '--is-ancestor', prior, candidateRevision], { cwd: workspace.projectRoot })).ok) {
        throw new CandidateWorkspaceError('candidate_ref_changed', `candidate reference ${workspace.branch} no longer belongs to this checkpoint; refusing to overwrite it`);
      }
      await gitOrThrow(['update-ref', ref, candidateRevision, prior ?? '0'.repeat(candidateRevision.length)], { cwd: workspace.projectRoot });
    });
  }

  return {
    runId: workspace.runId,
    taskId: workspace.taskId,
    attemptId: workspace.attemptId,
    branch: workspace.branch,
    baseRevision: workspace.baseRevision,
    candidateRevision,
    checkpointCreated,
    patchPath,
    patchHash: sha256Hex(patchBuffer),
    patchBytes: patchBuffer.length,
    changedFiles: changes.map((change) => change.path),
    changes,
    snapshotAt: now,
  };
}

/** A worker can edit its .git marker; never follow a replacement into another project. */
export async function assertCandidateGitIdentity(workspace: CandidateWorkspace): Promise<void> {
  const observed = readGitAdminDir(workspace.path);
  if (observed === null || workspace.gitAdminDir === null || canonicalCandidatePath(observed) !== canonicalCandidatePath(workspace.gitAdminDir)) {
    throw new CandidateWorkspaceError('candidate_git_identity_changed', `Git administration for ${workspace.path} no longer matches the recorded attempt; refusing to operate on another repository`);
  }
  const root = await gitTextOrNull(['rev-parse', '--show-toplevel'], { cwd: workspace.path });
  if (root === null || canonicalCandidatePath(root) !== canonicalCandidatePath(workspace.path)) {
    throw new CandidateWorkspaceError('candidate_git_identity_changed', `Git worktree for ${workspace.path} no longer matches the recorded attempt`);
  }
  if (workspace.gitIsolation === 'independent') {
    const common = await gitText(['rev-parse', '--git-common-dir'], { cwd: workspace.path });
    if (canonicalCandidatePath(path.resolve(workspace.path, common)) !== canonicalCandidatePath(workspace.gitAdminDir) || existsSync(path.join(workspace.gitAdminDir, 'objects/info/alternates'))) {
      throw new CandidateWorkspaceError('candidate_git_identity_changed', 'candidate Git administration unexpectedly shares objects or refs with another repository');
    }
  }
}

/**
 * Confirm the writer is stopped (or was never recorded) and that no Git
 * operation is mid-flight in the workspace.
 */
export function assertQuiesced(workspace: CandidateWorkspace, writer: ProcessIdentity | null): void {
  if (writer !== null) {
    const status = matchProcessIdentity(writer);
    if (status === 'alive' || isProcessGroupAlive(writer.pid)) {
      throw new QuiesceError(
        `the writing process or its owned process group ${writer.pid} (spawn ${writer.spawnToken}) for ${workspace.path} is still running; stop or deny it before snapshotting — a result report does not revoke write access`,
      );
    }
    if (status === 'unverifiable') {
      throw new QuiesceError(
        `pid ${writer.pid} exists but cannot be verified as the writer of ${workspace.path}; isolate a successor snapshot instead of freezing a workspace with uncertain ownership`,
      );
    }
  }
  if (workspace.gitAdminDir !== null && existsSync(path.join(workspace.gitAdminDir, 'index.lock'))) {
    throw new QuiesceError(`a Git operation is in progress in ${workspace.path} (index.lock present); the candidate is not quiescent`);
  }
}

async function readChangedFiles(cwd: string, base: string, candidate: string): Promise<CandidateFileChange[]> {
  const run = await gitOrThrow(['diff', '--name-status', '-z', '--no-renames', base, candidate], { cwd });
  const records = run.stdout.split('\0').filter((value) => value.length > 0);
  const changes: CandidateFileChange[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    changes.push({ status: records[i]!, path: records[i + 1]! });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

export type CandidateDisposition = 'integrated' | 'rejected';

export interface RemoveCandidateInput {
  /**
   * Removal is refused unless the candidate was explicitly integrated or
   * rejected. Automatic cleanup never discards unintegrated work.
   */
  readonly disposition?: CandidateDisposition;
  /** References that must still exist afterwards (the candidate branch, the patch file). */
  readonly recoverableRefs?: ReadonlyArray<string>;
  readonly snapshot?: Pick<CandidateSnapshot, 'candidateRevision' | 'patchPath'> | null;
  /** Coordinator observed the read-only session's whole process tree stopped (or no session opened). */
  readonly readOnly?: { readonly quiesced: true; readonly writer: ProcessIdentity | null };
  readonly signal?: AbortSignal;
}

export interface RemoveCandidateResult {
  readonly removed: boolean;
  readonly reason: string;
  readonly branch: string;
  readonly branchKept: boolean;
  readonly recoverableRefs: ReadonlyArray<string>;
}

/**
 * Remove the worktree directory while keeping the candidate branch and its
 * commits. The branch is never deleted here: a rejected candidate must stay
 * recoverable, and an integrated one is still the provenance of what was
 * applied.
 */
export async function removeCandidateWorkspace(workspace: CandidateWorkspace, input: RemoveCandidateInput = {}): Promise<RemoveCandidateResult> {
  return await withRepositoryLock(workspace.projectRoot, () => removeCandidateWorkspaceUnlocked(workspace, input));
}

async function removeCandidateWorkspaceUnlocked(workspace: CandidateWorkspace, input: RemoveCandidateInput = {}): Promise<RemoveCandidateResult> {
  const branchStillThere = await branchExists(workspace.projectRoot, workspace.branch);

  if (input.disposition === undefined) {
    return {
      removed: false,
      reason: 'candidate is neither integrated nor rejected; unintegrated work is never discarded by cleanup',
      branch: workspace.branch,
      branchKept: branchStillThere,
      recoverableRefs: branchStillThere ? [workspace.branch] : [],
    };
  }

  const recoverable: string[] = [];
  if (branchStillThere) recoverable.push(workspace.branch);
  for (const ref of input.recoverableRefs ?? []) {
    if (existsSync(ref)) recoverable.push(ref);
  }
  if (input.snapshot?.patchPath !== undefined && existsSync(input.snapshot.patchPath) && !recoverable.includes(input.snapshot.patchPath)) {
    recoverable.push(input.snapshot.patchPath);
  }
  if (input.snapshot != null) {
    const reachable = await gitTextOrNull(['rev-parse', '--verify', '--quiet', `${input.snapshot.candidateRevision}^{commit}`], { cwd: workspace.projectRoot });
    if (reachable !== null) recoverable.push(input.snapshot.candidateRevision);
  }

  // Planning/review copies need no new checkpoint when they still contain
  // exactly their recorded base. Caller attestation is required in addition
  // to checking the owned process/group and Git administration ourselves.
  const unchangedReadOnly = input.disposition === 'rejected' && input.readOnly?.quiesced === true && input.snapshot == null;
  if (unchangedReadOnly) {
    assertQuiesced(workspace, input.readOnly!.writer);
    if (await resolveRevision(workspace.projectRoot, workspace.baseRevision) === workspace.baseRevision) recoverable.push(workspace.baseRevision);
  }

  if (recoverable.length === 0) {
    return {
      removed: false,
      reason: `no recoverable reference to the candidate survives (branch "${workspace.branch}" is gone and no patch was recorded); refusing to remove the only copy of the work`,
      branch: workspace.branch,
      branchKept: false,
      recoverableRefs: [],
    };
  }

  await assertCandidateGitIdentity(workspace);
  const status = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...(unchangedReadOnly ? ['--ignored=matching'] : [])], { cwd: workspace.path });
  const current = await resolveRevision(workspace.path, 'HEAD');
  const expected = unchangedReadOnly ? workspace.baseRevision : input.snapshot?.candidateRevision;
  if (!status.ok || status.truncated || status.stdout.length > 0 || expected === undefined || expected !== current) {
    return { removed: false, reason: 'candidate contains work not covered by the recorded frozen snapshot; refusing to discard it', branch: workspace.branch, branchKept: branchStillThere, recoverableRefs: recoverable };
  }

  if (workspace.gitIsolation === 'independent') {
    rmSync(workspace.path, { recursive: true });
    // Keep the private repository too: it is cheap recovery provenance and
    // avoids treating arbitrary caller-supplied paths as cleanup authority.
    return { removed: true, reason: unchangedReadOnly ? 'unchanged read-only candidate removed after confirmed process termination; recorded base and private Git administration kept' : `candidate ${input.disposition}; working files removed, private Git administration and published checkpoint kept`, branch: workspace.branch, branchKept: branchStillThere, recoverableRefs: recoverable };
  }

  const removal = await git(['worktree', 'remove', '--force', workspace.path], {
    cwd: workspace.projectRoot,
    noHooksDir: path.dirname(workspace.path),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  if (!removal.ok && existsSync(workspace.path)) {
    // Fall back to removing the directory and pruning the administrative record.
    rmSync(workspace.path, { recursive: true, force: true });
  }
  await git(['worktree', 'prune'], { cwd: workspace.projectRoot });

  return {
    removed: !existsSync(workspace.path),
    reason: `candidate ${input.disposition}; worktree removed, branch "${workspace.branch}" and its commits kept`,
    branch: workspace.branch,
    branchKept: await branchExists(workspace.projectRoot, workspace.branch),
    recoverableRefs: recoverable,
  };
}
