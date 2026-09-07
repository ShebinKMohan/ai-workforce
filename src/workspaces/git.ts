/**
 * Coordinator-owned Git operations.
 *
 * Rules enforced here rather than at every call site:
 *
 * - Hooks never run. Inspection uses read-only plumbing that has no hooks,
 *   and the commands that would run one (`worktree add` -> post-checkout,
 *   `commit` -> pre-commit/commit-msg/post-commit) are invoked with
 *   `-c core.hooksPath=<empty directory the coordinator owns>`. Repository
 *   hooks are untrusted code; passive inspection and workspace setup must
 *   never execute them.
 * - Inspection never writes. `--no-optional-locks` stops `git status` from
 *   refreshing (and therefore rewriting) the user's index, so registering a
 *   project cannot modify the checkout in any way.
 * - The environment is a whitelist plus terminal-prompt suppression, so a
 *   credential helper cannot open a prompt in the middle of a run.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { runCommand, type CommandRun } from './exec.js';

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Environment variables git may see. Anything else (including credentials) is dropped. */
const GIT_ENV_WHITELIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSH_AUTH_SOCK'] as const;

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** The identity coordinator-created checkpoint commits carry; never the user's. */
export const COORDINATOR_IDENTITY: GitIdentity = {
  name: 'workforce coordinator',
  email: 'coordinator@workforce.invalid',
};

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Directory the coordinator owns, used as an empty `core.hooksPath`. Required for hook-running commands. */
  readonly noHooksDir?: string;
  /** Identity for commands that write history. */
  readonly identity?: GitIdentity;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Written to the command's stdin (`git checkout-index --stdin`, `git hash-object --stdin`). */
  readonly input?: string;
}

export class GitError extends Error {
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly run: CommandRun;

  constructor(args: ReadonlyArray<string>, run: CommandRun) {
    const reason = run.spawnError ?? (run.timedOut ? `timed out after ${run.durationMs}ms` : `exit ${String(run.exitCode)}`);
    super(`git ${args.join(' ')} failed in ${run.cwd} (${reason})${run.stderr.trim() ? `: ${run.stderr.trim().split('\n').slice(0, 5).join(' | ')}` : ''}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = run.exitCode;
    this.stderr = run.stderr;
    this.run = run;
  }
}

function gitEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GIT_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Never let a credential helper block a run on an interactive prompt.
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = '';
  env['GIT_PAGER'] = 'cat';
  env['GIT_ADVICE'] = '0';
  return { ...env, ...extra };
}

/**
 * An empty directory used as `core.hooksPath`. Callers pass a directory they
 * own (under the state root, the workspace root or a check's output root) so
 * nothing world-writable can smuggle a hook in.
 */
export function ensureNoHooksDir(dir: string): string {
  const resolved = path.resolve(dir, '.workforce-no-hooks');
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function identityEnv(identity: GitIdentity, at?: string): Record<string, string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
  if (at !== undefined) {
    env['GIT_AUTHOR_DATE'] = at;
    env['GIT_COMMITTER_DATE'] = at;
  }
  return env;
}

/** Run git. Returns the outcome for both success and failure; never throws for a non-zero exit. */
export async function git(args: ReadonlyArray<string>, options: GitOptions): Promise<CommandRun> {
  const prefix: string[] = [];
  if (options.noHooksDir !== undefined) prefix.push('-c', `core.hooksPath=${ensureNoHooksDir(options.noHooksDir)}`);
  const full = [...prefix, ...args];
  return await runCommand({
    command: 'git',
    args: full,
    cwd: options.cwd,
    env: gitEnv({ ...(options.identity !== undefined ? identityEnv(options.identity) : {}), ...options.extraEnv }),
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

/** Run git and throw `GitError` unless it exited 0. */
export async function gitOrThrow(args: ReadonlyArray<string>, options: GitOptions): Promise<CommandRun> {
  const run = await git(args, options);
  if (!run.ok) throw new GitError(args, run);
  return run;
}

/** Trimmed stdout of a successful git command. */
export async function gitText(args: ReadonlyArray<string>, options: GitOptions): Promise<string> {
  return (await gitOrThrow(args, options)).stdout.trim();
}

/** Trimmed stdout, or null when the command failed (an absent config key, an unborn HEAD, ...). */
export async function gitTextOrNull(args: ReadonlyArray<string>, options: GitOptions): Promise<string | null> {
  const run = await git(args, options);
  if (!run.ok) return null;
  const text = run.stdout.trim();
  return text.length === 0 ? null : text;
}

/** Resolve `dir` to the absolute realpath of the Git worktree root that contains it, or null. */
export async function repositoryRoot(dir: string): Promise<string | null> {
  const top = await gitTextOrNull(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top === null) return null;
  try {
    return realpathSync(top);
  } catch {
    return path.resolve(top);
  }
}

/** A valid Git ref path segment: no whitespace, no `..`, none of git's reserved characters. */
export function isSafeRefSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 128) return false;
  if (segment === '.' || segment === '..') return false;
  if (segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

/** True when `refs/heads/<branch>` already exists. */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const run = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
  return run.exitCode === 0;
}

/** Resolve a commit-ish to a full object id, or null when it does not resolve. */
export async function resolveRevision(repoRoot: string, revision: string): Promise<string | null> {
  return await gitTextOrNull(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd: repoRoot });
}

// ---------------------------------------------------------------------------
// Repository-scoped serialization
// ---------------------------------------------------------------------------

/**
 * One repository's mutating workspace operations, serialized.
 *
 * `git worktree add|remove|prune` all take the repository's administrative
 * locks, and two of them racing against the same repository fail with
 * "cannot lock ref" or leave a half-registered worktree behind. Serializing
 * only these short operations is what lets the planned path run several
 * workers at the same time: the workers themselves, and the checks they are
 * verified by, hold no repository lock and stay concurrent.
 */
const repositoryQueues = new Map<string, Promise<unknown>>();

export function withRepositoryLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  // The queue never holds a rejected promise: a failed operation must not
  // reject every later one waiting behind it.
  repositoryQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
