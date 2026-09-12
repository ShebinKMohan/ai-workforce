/**
 * Project inspection and registration (FR019).
 *
 * `inspectProject` answers, without touching the checkout: where the
 * repository really is, which repository it is, what the committed base is,
 * which branch the user is on, what is uncommitted and whether submodules
 * are involved. Every command it runs is read-only plumbing invoked with
 * `--no-optional-locks`, so not even the index is refreshed; no hook runs;
 * nothing is reset, cleaned or stashed.
 *
 * `registerProject` persists the result in the `projects` table. Registering
 * is a coordinator-side record: it never writes into the repository.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { withTransaction } from '../storage/tx.js';
import { git, gitTextOrNull, repositoryRoot } from './git.js';

/** How many changed paths a dirty summary lists before it starts counting only. */
export const MAX_DIRTY_PATHS = 50;

export interface DirtyGroup {
  readonly count: number;
  /** Up to `MAX_DIRTY_PATHS` repository-relative paths. */
  readonly paths: ReadonlyArray<string>;
  /** True when `count` exceeds the listed paths. */
  readonly truncated: boolean;
}

export interface DirtySummary {
  readonly clean: boolean;
  readonly staged: DirtyGroup;
  readonly unstaged: DirtyGroup;
  readonly untracked: DirtyGroup;
  /** Paths with an unresolved merge conflict; they also appear in staged/unstaged counts. */
  readonly conflicted: DirtyGroup;
}

export interface RepositoryIdentity {
  /** First root commit (a repository with grafted histories can have several). */
  readonly rootCommit: string | null;
  readonly rootCommits: ReadonlyArray<string>;
  readonly originUrl: string | null;
  /** Stable identity derived from the root commit and origin; usable as a lookup key. */
  readonly identityHash: string;
}

export interface ProjectInspection {
  /** Realpath of the path the user named. */
  readonly canonicalPath: string;
  readonly isGitRepo: boolean;
  /** Realpath of the Git worktree root; null when `isGitRepo` is false. */
  readonly repositoryRoot: string | null;
  readonly repositoryIdentity: RepositoryIdentity;
  /** Committed HEAD; null for an unborn branch (a repository with no commits). */
  readonly headRevision: string | null;
  /** Branch name, or null when HEAD is detached or unborn. */
  readonly branch: string | null;
  readonly detachedHead: boolean;
  readonly dirty: DirtySummary;
  readonly hasSubmodules: boolean;
  readonly submodulePaths: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
  readonly inspectedAt: string;
}

export class ProjectInspectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectInspectionError';
    this.code = code;
  }
}

const EMPTY_GROUP: DirtyGroup = { count: 0, paths: [], truncated: false };

function group(paths: ReadonlyArray<string>): DirtyGroup {
  return { count: paths.length, paths: paths.slice(0, MAX_DIRTY_PATHS), truncated: paths.length > MAX_DIRTY_PATHS };
}

/**
 * Parse `git status --porcelain=v1 -z`. NUL-separated, and a rename/copy
 * entry is followed by an extra NUL-separated origin path, which must be
 * consumed so the next record is not misread as a status line.
 */
export function parsePorcelainStatus(output: string): DirtySummary {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  const records = output.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.length < 4) continue; // "XY " + at least one character of path
    const x = record[0]!;
    const y = record[1]!;
    const file = record.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
      continue;
    }
    if (x === '!' && y === '!') continue; // ignored, only present with --ignored
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicted.push(file);
    }
    if (x !== ' ' && x !== '?') staged.push(file);
    if (y !== ' ' && y !== '?') unstaged.push(file);
    if (x === 'R' || x === 'C') i += 1; // consume the origin path of a rename/copy
  }

  return {
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged: group(staged),
    unstaged: group(unstaged),
    untracked: group(untracked),
    conflicted: group(conflicted),
  };
}

/** Human summary of a dirty state, used in run output and manifests. */
export function describeDirty(dirty: DirtySummary): string {
  if (dirty.clean) return 'clean';
  const parts: string[] = [];
  if (dirty.staged.count > 0) parts.push(`${dirty.staged.count} staged`);
  if (dirty.unstaged.count > 0) parts.push(`${dirty.unstaged.count} unstaged`);
  if (dirty.untracked.count > 0) parts.push(`${dirty.untracked.count} untracked`);
  if (dirty.conflicted.count > 0) parts.push(`${dirty.conflicted.count} conflicted`);
  return parts.join(', ');
}

function identityOf(rootCommits: ReadonlyArray<string>, originUrl: string | null, fallback: string): RepositoryIdentity {
  const root = rootCommits[0] ?? null;
  const material = root !== null ? `root:${root}` : `path:${fallback}`;
  return {
    rootCommit: root,
    rootCommits: [...rootCommits],
    originUrl,
    identityHash: sha256Hex(`${material} origin:${originUrl ?? ''}`),
  };
}

/** Expand the current user's ~ shorthand only; never interpret shell syntax. */
export function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

/**
 * Read-only inspection of a repository. Runs no hooks and writes nothing,
 * including the index.
 */
export async function inspectProject(projectPath: string): Promise<ProjectInspection> {
  const inspectedAt = nowIso();
  const diagnostics: string[] = [];

  const requested = path.resolve(expandHomePath(projectPath));
  if (!existsSync(requested)) throw new ProjectInspectionError('missing_path', `${requested} does not exist`);
  if (!statSync(requested).isDirectory()) throw new ProjectInspectionError('not_a_directory', `${requested} is not a directory`);
  const canonicalPath = realpathSync(requested);

  const root = await repositoryRoot(canonicalPath);
  if (root === null) {
    return {
      canonicalPath,
      isGitRepo: false,
      repositoryRoot: null,
      repositoryIdentity: identityOf([], null, canonicalPath),
      headRevision: null,
      branch: null,
      detachedHead: false,
      dirty: { clean: true, staged: EMPTY_GROUP, unstaged: EMPTY_GROUP, untracked: EMPTY_GROUP, conflicted: EMPTY_GROUP },
      hasSubmodules: false,
      submodulePaths: [],
      diagnostics: [`${canonicalPath} is not inside a Git worktree`],
      inspectedAt,
    };
  }
  if (root !== canonicalPath) diagnostics.push(`${canonicalPath} is inside the repository rooted at ${root}; the repository root is used`);

  const options = { cwd: root } as const;
  const headRevision = await gitTextOrNull(['--no-optional-locks', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options);
  if (headRevision === null) diagnostics.push('the repository has no commits yet (unborn HEAD); there is no committed base to work from');

  const branch = await gitTextOrNull(['--no-optional-locks', 'symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  const detachedHead = branch === null && headRevision !== null;
  if (detachedHead) diagnostics.push('HEAD is detached; the candidate branch is still created from the committed HEAD');

  const rootCommitsText = headRevision === null ? null : await gitTextOrNull(['--no-optional-locks', 'rev-list', '--max-parents=0', 'HEAD'], options);
  const rootCommits = rootCommitsText === null ? [] : rootCommitsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort();
  const originUrl = await gitTextOrNull(['--no-optional-locks', 'config', '--get', 'remote.origin.url'], options);

  const statusRun = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (!statusRun.ok || statusRun.truncated) {
    throw new ProjectInspectionError(
      'working_tree_unreadable',
      `could not read the complete working tree state: ${statusRun.truncated ? 'Git output exceeded the inspection limit' : statusRun.stderr.trim() || statusRun.spawnError || `git exited ${String(statusRun.exitCode)}`}`,
    );
  }
  const dirty = parsePorcelainStatus(statusRun.stdout);

  const submodulePaths = await readSubmodulePaths(root);
  if (submodulePaths.length > 0) {
    diagnostics.push(`repository declares ${submodulePaths.length} submodule(s); a linked candidate worktree does not populate them`);
  }

  return {
    canonicalPath,
    isGitRepo: true,
    repositoryRoot: root,
    repositoryIdentity: identityOf(rootCommits, originUrl, root),
    headRevision,
    branch,
    detachedHead,
    dirty,
    hasSubmodules: submodulePaths.length > 0,
    submodulePaths,
    diagnostics,
    inspectedAt,
  };
}

/** Submodule paths declared in `.gitmodules` (read with git's own config parser, no hooks, no network). */
async function readSubmodulePaths(root: string): Promise<string[]> {
  const modules = path.join(root, '.gitmodules');
  if (!existsSync(modules)) return [];
  const listed = await gitTextOrNull(['--no-optional-locks', 'config', '--file', modules, '--get-regexp', '^submodule\\..*\\.path$'], { cwd: root });
  if (listed === null) return [];
  return listed
    .split('\n')
    .map((line) => line.slice(line.indexOf(' ') + 1).trim())
    .filter((value) => value.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  readonly id: string;
  readonly canonicalPath: string;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly baseMode: 'head';
  readonly checks: ReadonlyArray<unknown>;
  readonly dataLocation: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectRow {
  id: string;
  canonical_path: string;
  repo_identity: string;
  base_mode: string;
  instructions_json: string;
  checks_json: string;
  data_location: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    canonicalPath: row.canonical_path,
    repositoryIdentity: JSON.parse(row.repo_identity) as RepositoryIdentity,
    baseMode: 'head',
    checks: JSON.parse(row.checks_json) as unknown[],
    dataLocation: row.data_location,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RegisterProjectInput {
  readonly inspection: ProjectInspection;
  /** Where this project's coordinator data lives (state root). Never inside the checkout. */
  readonly dataLocation: string;
  readonly checks?: ReadonlyArray<unknown>;
  readonly now?: string;
}

/**
 * Persist (or refresh) the project record. Keyed by the canonical repository
 * path, so registering the same repository twice reuses one record and its
 * history. This writes only to the coordinator database.
 */
export function registerProject(db: DatabaseSync, input: RegisterProjectInput): ProjectRecord {
  const { inspection } = input;
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new ProjectInspectionError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository; register an existing Git project`);
  }
  const now = input.now ?? nowIso();
  const canonical = inspection.repositoryRoot;
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM projects WHERE canonical_path = ?').get(canonical) as ProjectRow | undefined;
    if (existing !== undefined) {
      db.prepare('UPDATE projects SET repo_identity = ?, checks_json = ?, data_location = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(inspection.repositoryIdentity),
        JSON.stringify(input.checks ?? (JSON.parse(existing.checks_json) as unknown[])),
        input.dataLocation,
        now,
        existing.id,
      );
      return toRecord(db.prepare('SELECT * FROM projects WHERE id = ?').get(existing.id) as unknown as ProjectRow);
    }
    const id = newId();
    db.prepare(
      `INSERT INTO projects(id, canonical_path, repo_identity, base_mode, instructions_json, checks_json, data_location, created_at, updated_at)
       VALUES (?, ?, ?, 'head', '{}', ?, ?, ?, ?)`,
    ).run(id, canonical, JSON.stringify(inspection.repositoryIdentity), JSON.stringify(input.checks ?? []), input.dataLocation, now, now);
    return toRecord(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow);
  });
}

export function findProjectByPath(db: DatabaseSync, canonicalPath: string): ProjectRecord | null {
  const row = db.prepare('SELECT * FROM projects WHERE canonical_path = ?').get(path.resolve(canonicalPath)) as ProjectRow | undefined;
  return row === undefined ? null : toRecord(row);
}

export function getProject(db: DatabaseSync, id: string): ProjectRecord | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row === undefined ? null : toRecord(row);
}
