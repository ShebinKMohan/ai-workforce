/**
 * Contained acceptance checks (FR049, FR050).
 *
 * A check receipt is the only thing that can mark a criterion passed. A
 * runtime saying "done", exiting zero, or printing text that looks like a
 * passing test run proves nothing here: every receipt in this module records
 * a command the *verifier* executed against a frozen candidate, and carries
 * `evidenceProvenance: 'verifier_executed'`.
 *
 * For each check:
 *   1. A disposable copy of the frozen candidate revision is materialized
 *      under `outputRoot`. `git archive` extraction is preferred because the
 *      result has no Git administration at all, so a test cannot reach the
 *      shared object database or the preserved candidate; `git worktree
 *      --detach` is the fallback when archive/tar is unavailable, and the
 *      strategy actually used is recorded on the receipt. The copy is then
 *      compared against the revision's own tree listing and completed from the
 *      object database: `git archive` obeys the archived revision's
 *      `.gitattributes`, so a candidate that adds an `export-ignore` rule would
 *      otherwise delete the acceptance suite from the tree the criterion runs
 *      against while modifying no pinned file at all.
 *   2. Tracked files are hashed before the command runs.
 *   3. The command runs with `spawn(..., { shell: false })` in its own
 *      process group, under a sanitized environment (PATH, a *fresh* HOME and
 *      TMPDIR, LANG, TERM — nothing else, and any variable matching the
 *      telemetry redaction rule is dropped even when explicitly supplied),
 *      with a Node-enforced timeout that kills the whole group.
 *   4. Tracked files are hashed again. Any change to a tracked file is an
 *      integrity failure: build output belongs in the disposable copy's
 *      scratch paths, never in the candidate's tracked source.
 *   5. The command's own output is summarized for recognized runners, so a
 *      suite that exits 0 having executed zero tests is recorded as
 *      `no_tests_executed` rather than read as a pass.
 *
 * The disposable copy is deleted afterwards; the logs are kept as evidence.
 *
 * What this module does NOT do, stated plainly because the `verification`
 * profile in plan section 8 asks for more than R0 delivers: repository test
 * code runs with the coordinator's own user privileges. Only the environment
 * is sanitized — no coordinator credentials are inherited and no variable
 * whose name matches the redaction rule is passed — and the candidate itself
 * is a throwaway copy. There is no OS-level containment, so a repository test
 * can still read and write anything this user can, including the coordinator
 * state root. That boundary is FR042 (an R1 gate) and no R0 run claims it;
 * `decideAcceptance` therefore treats a candidate that rewrote the files a
 * criterion executes as compromised evidence rather than as a pass.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import { writeArtifact, type ArtifactRecord } from '../storage/artifacts.js';
import { isWithin, type StatePaths } from '../storage/paths.js';
import { isSensitiveKey } from '../telemetry/redaction.js';
import { git, gitOrThrow } from '../workspaces/git.js';
import { runCommand } from '../workspaces/exec.js';

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const EVIDENCE_PROVENANCE = 'verifier_executed' as const;

/** Environment variables a check may inherit from the coordinator. Everything else is dropped. */
export const CHECK_ENV_WHITELIST = ['PATH', 'LANG', 'TERM'] as const;

/** Cap on the integrity walk, so a huge repository cannot stall verification. */
export const MAX_INTEGRITY_FILES = 20_000;
export const MAX_INTEGRITY_FILE_BYTES = 32 * 1024 * 1024;

export interface CheckSpec {
  readonly criterionId: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Relative to the candidate copy root. Defaults to the root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Additional environment. Sensitive-looking names are dropped, not passed through. */
  readonly env?: Readonly<Record<string, string>>;
  /** A non-required check is evidence but does not block acceptance. Defaults to true. */
  readonly required?: boolean;
  readonly description?: string;
}

export interface CandidateRef {
  /** Repository that contains the candidate revision (the user's repository, read-only here). */
  readonly repoRoot: string;
  readonly revision: string;
  /** Content hash of the candidate patch; recorded so evidence is bound to an exact candidate. */
  readonly patchHash?: string | null;
}

export type CheckOutcome = 'passed' | 'failed' | 'timeout' | 'error' | 'integrity_failed' | 'no_tests_executed' | 'skipped';

/**
 * What the check's own output says it did.
 *
 * `node --test <dir>` and `python -m unittest discover` both exit 0 when they
 * find nothing to run, so an exit status alone cannot distinguish "every
 * assertion passed" from "there were no assertions". For the runners we can
 * recognize, the reported test count is part of the receipt and a zero count
 * is not a pass.
 */
export interface CheckOutputSummary {
  readonly runner: 'node_test' | 'python_unittest' | null;
  readonly testsRun: number | null;
  readonly note: string;
}

const UNRECOGNIZED_OUTPUT: CheckOutputSummary = {
  runner: null,
  testsRun: null,
  note: 'the command is not a runner this verifier recognizes, so its exit status is the only evidence of what it executed',
};

/**
 * Recognize a test count in a runner's own summary. Deliberately narrow: an
 * unrecognized shape reports `null`, never a guessed number.
 */
export function summarizeCheckOutput(stdout: string, stderr: string): CheckOutputSummary {
  const combined = `${stdout}\n${stderr}`;
  // node --test: "ℹ tests 12" (spec reporter) or "# tests 12" (TAP reporter).
  const node = /(?:^|\n)[^\S\n]*(?:ℹ|#)[^\S\n]*tests[^\S\n]+(\d+)[^\S\n]*(?:\n|$)/.exec(combined);
  if (node !== null) {
    const testsRun = Number(node[1]);
    return {
      runner: 'node_test',
      testsRun,
      note: testsRun === 0 ? 'node --test reported that it executed 0 tests' : `node --test reported ${testsRun} test(s)`,
    };
  }
  // python -m unittest: "Ran 12 tests in 0.001s", plus an explicit "NO TESTS RAN".
  const python = /(?:^|\n)Ran[^\S\n]+(\d+)[^\S\n]+tests?[^\S\n]+in[^\S\n]/.exec(combined);
  if (python !== null) {
    const testsRun = Number(python[1]);
    return {
      runner: 'python_unittest',
      testsRun,
      note: testsRun === 0 ? 'python unittest reported that it ran 0 tests' : `python unittest reported ${testsRun} test(s)`,
    };
  }
  if (/(?:^|\n)NO TESTS RAN(?:\n|$)/.test(combined)) {
    return { runner: 'python_unittest', testsRun: 0, note: 'python unittest reported NO TESTS RAN' };
  }
  return UNRECOGNIZED_OUTPUT;
}

export interface EnvironmentIdentity {
  readonly node: string;
  readonly os: NodeJS.Platform;
  readonly osRelease: string;
  readonly arch: string;
  /** Hash of the PATH the check saw, so a differing toolchain is visible without leaking the path. */
  readonly pathHash: string;
  readonly envKeys: ReadonlyArray<string>;
}

export interface IntegrityReport {
  /** Digest over every file of the candidate revision, before the command ran. */
  readonly before: string;
  readonly after: string;
  /** True when the check modified or deleted a file that belongs to the candidate revision. */
  readonly mutated: boolean;
  readonly mutatedFiles: ReadonlyArray<string>;
  /**
   * Files the check created. Build, cache and coverage output is expected here:
   * it lives in the disposable copy, cannot touch the preserved candidate, and
   * is therefore recorded rather than treated as a failure.
   */
  readonly addedFiles: ReadonlyArray<string>;
  readonly fileCount: number;
  /** `complete` when every file was hashed; `bounded` when the walk hit a limit. */
  readonly scope: 'complete' | 'bounded';
}

export interface CheckReceipt {
  readonly id: string;
  readonly criterionId: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Relative to the candidate copy root. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly environmentIdentity: EnvironmentIdentity;
  readonly candidate: { readonly repoRoot: string; readonly revision: string; readonly patchHash: string | null };
  readonly copyStrategy: CopyStrategy;
  readonly integrity: IntegrityReport;
  /** What the command's own output says it executed; `runner: null` when unrecognized. */
  readonly outputSummary: CheckOutputSummary;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputTruncated: boolean;
  /** Tail of the command's own output, kept inline so a summary can explain a failure. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly evidenceProvenance: typeof EVIDENCE_PROVENANCE;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface RunChecksInput {
  readonly candidate: CandidateRef;
  readonly checks: ReadonlyArray<CheckSpec>;
  /** Coordinator-owned directory for disposable copies and logs. */
  readonly outputRoot: string;
  readonly defaultTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onReceipt?: (receipt: CheckReceipt) => void;
  /** Keep the disposable copies (debugging). They are deleted by default. */
  readonly keepCopies?: boolean;
}

export class CheckRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckRunnerError';
    this.code = code;
  }
}

const TAIL_CHARS = 4_000;

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : `… [${text.length - TAIL_CHARS} earlier characters in the log file]\n${text.slice(-TAIL_CHARS)}`;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned.length === 0 ? 'check' : cleaned.slice(0, 64);
}

/**
 * The environment a check sees: a whitelist, a fresh HOME and TMPDIR that
 * belong to this check alone, plus explicitly supplied values — with anything
 * whose name matches the telemetry redaction rule dropped, so a token in the
 * coordinator's environment or in a check definition never reaches test code.
 */
export function buildCheckEnv(home: string, tmp: string, extra?: Readonly<Record<string, string>>): { env: Record<string, string>; dropped: string[] } {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const key of CHECK_ENV_WHITELIST) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (isSensitiveKey(key)) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
  }
  env['HOME'] = home;
  env['TMPDIR'] = tmp;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (isSensitiveKey(key)) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, dropped };
}

function environmentIdentity(env: Readonly<Record<string, string>>): EnvironmentIdentity {
  return {
    node: process.version,
    os: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    pathHash: sha256Hex(env['PATH'] ?? ''),
    envKeys: Object.keys(env).sort(),
  };
}

export interface IntegrityScan {
  readonly digest: string;
  readonly files: ReadonlyMap<string, string>;
  readonly scope: 'complete' | 'bounded';
}

/**
 * Hash every file in the disposable copy except Git administration. The copy
 * starts out as exactly the candidate revision's tracked files, so a file that
 * changes or disappears between the two scans was changed by the check itself.
 */
export function scanTrackedFiles(root: string): IntegrityScan {
  const files = new Map<string, string>();
  let scope: 'complete' | 'bounded' = 'complete';
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      scope = 'bounded';
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (files.size >= MAX_INTEGRITY_FILES) {
        scope = 'bounded';
        continue;
      }
      if (entry.isSymbolicLink()) {
        files.set(relative, `symlink:${sha256Hex(safeReadLink(full))}`);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(full);
        if (stats.size > MAX_INTEGRITY_FILE_BYTES) {
          files.set(relative, `size:${stats.size}:mtime-not-hashed`);
          scope = 'bounded';
          continue;
        }
        files.set(relative, sha256Hex(readFileSync(full)));
      } catch {
        files.set(relative, 'unreadable');
        scope = 'bounded';
      }
    }
  }
  const digest = createHash('sha256');
  for (const key of [...files.keys()].sort()) digest.update(`${key}\0${files.get(key)!}\0`);
  return { digest: digest.digest('hex'), files, scope };
}

function safeReadLink(target: string): string {
  try {
    return readlinkSync(target);
  } catch {
    return '';
  }
}

/**
 * Integrity is about the *candidate's own files*. The disposable copy starts
 * as exactly the candidate revision, so `before.files` is that set: modifying
 * or deleting any of them is an integrity failure. Files the check creates are
 * recorded separately — a build writing its output into the throwaway copy is
 * normal and cannot reach the preserved candidate.
 */
function compareScans(before: IntegrityScan, after: IntegrityScan): IntegrityReport {
  const mutated: string[] = [];
  const added: string[] = [];
  for (const [file, hash] of before.files) {
    const now = after.files.get(file);
    if (now === undefined) mutated.push(`${file} (deleted)`);
    else if (now !== hash) mutated.push(`${file} (modified)`);
  }
  for (const file of after.files.keys()) {
    if (!before.files.has(file)) added.push(file);
  }
  mutated.sort();
  added.sort();
  return {
    before: before.digest,
    after: after.digest,
    mutated: mutated.length > 0,
    mutatedFiles: mutated.slice(0, 200),
    addedFiles: added.slice(0, 200),
    fileCount: before.files.size,
    scope: before.scope === 'complete' && after.scope === 'complete' ? 'complete' : 'bounded',
  };
}

export type CopyStrategy = 'git_archive' | 'git_archive_repaired' | 'git_worktree_detached';

interface DisposableCopy {
  readonly root: string;
  readonly strategy: CopyStrategy;
  readonly diagnostics: ReadonlyArray<string>;
  /**
   * Tracked paths of the frozen candidate that are still absent from the copy
   * after materialization and repair. A check never runs against an incomplete
   * copy: an absent acceptance suite is exactly how a passing exit code is
   * manufactured, so this turns the receipt into an error instead.
   */
  readonly missingPaths: ReadonlyArray<string>;
  dispose(): Promise<void>;
}

const TREE_LISTING_MAX_BYTES = 32 * 1024 * 1024;

interface FrozenTreeEntry {
  /** Git file mode: 100644, 100755, 120000 (symlink) or 160000 (submodule). */
  readonly mode: string;
  /** Blob size Git recorded, or null when it reported none. */
  readonly size: number | null;
}

export interface FrozenTree {
  readonly entries: ReadonlyMap<string, FrozenTreeEntry>;
  /** False when the listing could not be read in full; the completeness check is then bounded. */
  readonly complete: boolean;
}

/**
 * Every path the frozen candidate revision tracks, with the size Git recorded
 * for it.
 *
 * This is the ground truth a disposable copy is checked against, and it exists
 * because `git archive` is not a faithful export of a tree: it applies the
 * archived revision's own `.gitattributes`, so a candidate that merely *adds*
 * `test/ export-ignore` removes the acceptance suite from the copy the
 * criterion executes — without modifying a single pinned file. The candidate
 * diff shows one added file; the check runs against a tree with no tests in it
 * and exits 0.
 */
export async function listFrozenTree(candidate: CandidateRef, signal?: AbortSignal): Promise<FrozenTree> {
  const run = await git(['ls-tree', '-r', '-l', '-z', candidate.revision], {
    cwd: candidate.repoRoot,
    maxOutputBytes: TREE_LISTING_MAX_BYTES,
    ...(signal !== undefined ? { signal } : {}),
  });
  const entries = new Map<string, FrozenTreeEntry>();
  if (!run.ok) return { entries, complete: false };
  for (const record of run.stdout.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    // "<mode> SP <type> SP <object> SP <size> TAB <path>", size right-aligned or "-".
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const relative = record.slice(tab + 1);
    if (relative.length === 0) continue;
    const rawSize = meta[3] ?? '-';
    entries.set(relative, { mode: meta[0] ?? '', size: /^\d+$/.test(rawSize) ? Number(rawSize) : null });
  }
  return { entries, complete: !run.truncated };
}

interface CopyDifference {
  readonly missing: ReadonlyArray<string>;
  readonly sizeMismatch: ReadonlyArray<string>;
}

/** Which tracked paths the copy does not hold, and which hold a different number of bytes than Git recorded. */
function compareCopyToTree(root: string, tree: FrozenTree): CopyDifference {
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  for (const [relative, entry] of tree.entries) {
    // A submodule is a gitlink: no materialization strategy populates one.
    if (entry.mode === '160000') continue;
    let stats;
    try {
      stats = lstatSync(path.join(root, relative));
    } catch {
      missing.push(relative);
      continue;
    }
    if (entry.size !== null && !stats.isDirectory() && stats.size !== entry.size) sizeMismatch.push(relative);
  }
  return { missing: missing.sort(), sizeMismatch: sizeMismatch.sort() };
}

/**
 * Write the named tracked paths into the copy straight from the object
 * database, through an index this function owns.
 *
 * `GIT_INDEX_FILE` points at a throwaway file, so the registered project's own
 * index is never read or written; `--prefix` writes only inside the disposable
 * copy. No attribute can suppress a path here: `export-ignore` is an archive
 * rule and this is a checkout.
 */
async function restoreFromObjectDatabase(candidate: CandidateRef, destination: string, paths: ReadonlyArray<string>, signal?: AbortSignal): Promise<void> {
  const indexFile = `${destination}.restore-index`;
  rmSync(indexFile, { force: true });
  const extraEnv = { GIT_INDEX_FILE: indexFile };
  try {
    await gitOrThrow(['read-tree', candidate.revision], {
      cwd: candidate.repoRoot,
      extraEnv,
      ...(signal !== undefined ? { signal } : {}),
    });
    await gitOrThrow(['checkout-index', '-f', '-z', '--stdin', `--prefix=${destination.endsWith(path.sep) ? destination : `${destination}${path.sep}`}`], {
      cwd: candidate.repoRoot,
      extraEnv,
      input: `${paths.join('\0')}\0`,
      ...(signal !== undefined ? { signal } : {}),
    });
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * Make the copy hold every path the frozen tree does, and say so when it did
 * not already.
 */
async function completeCopy(
  candidate: CandidateRef,
  destination: string,
  tree: FrozenTree,
  diagnostics: string[],
  signal?: AbortSignal,
): Promise<{ readonly repaired: boolean; readonly missing: ReadonlyArray<string> }> {
  if (tree.entries.size === 0) return { repaired: false, missing: [] };
  const before = compareCopyToTree(destination, tree);
  const needed = [...new Set([...before.missing, ...before.sizeMismatch])].sort();
  if (needed.length === 0) return { repaired: false, missing: [] };

  diagnostics.push(
    `the materialized copy did not match the frozen candidate: ${before.missing.length} tracked path(s) absent` +
      `${before.sizeMismatch.length > 0 ? ` and ${before.sizeMismatch.length} of a different size` : ''} (${describePaths(needed)}). ` +
      'git archive applies the archived revision\'s own .gitattributes, so an export-ignore rule the candidate itself adds removes the files a criterion executes; ' +
      'they were restored from the object database so the check runs against the complete candidate',
  );
  try {
    await restoreFromObjectDatabase(candidate, destination, needed, signal);
  } catch (error) {
    diagnostics.push(`restoring them from the object database failed: ${(error as Error).message}`);
  }
  const after = compareCopyToTree(destination, tree);
  if (after.sizeMismatch.length > 0) {
    diagnostics.push(
      `${after.sizeMismatch.length} restored path(s) still hold a different number of bytes than the recorded blob (a content filter or an eol attribute explains this): ${describePaths(after.sizeMismatch)}`,
    );
  }
  return { repaired: true, missing: after.missing };
}

function describePaths(paths: ReadonlyArray<string>): string {
  return paths.length <= 10 ? paths.join(', ') : `${paths.slice(0, 10).join(', ')}, … and ${paths.length - 10} more`;
}

/**
 * Materialize the frozen candidate into a throwaway directory. `git archive`
 * is preferred: the extracted tree has no `.git` at all, so untrusted test
 * code cannot reach the shared repository through it. Whatever the strategy,
 * the result is compared against the revision's own tree listing and completed
 * from the object database before any check runs against it.
 */
export async function materializeFrozenCandidate(candidate: CandidateRef, destination: string, signal?: AbortSignal): Promise<DisposableCopy> {
  const diagnostics: string[] = [];
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const tarPath = `${destination}.tar`;
  const tree = await listFrozenTree(candidate, signal);
  if (!tree.complete) {
    diagnostics.push('the frozen candidate\'s tree listing could not be read in full, so the copy was checked against a bounded list of its tracked paths');
  }

  const archive = await git(['archive', '--format=tar', `--output=${tarPath}`, candidate.revision], {
    cwd: candidate.repoRoot,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (archive.ok && existsSync(tarPath)) {
    const extract = await runCommand({
      command: 'tar',
      args: ['-x', '-f', tarPath, '-C', destination],
      cwd: destination,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: destination },
      timeoutMs: 120_000,
      ...(signal !== undefined ? { signal } : {}),
    });
    rmSync(tarPath, { force: true });
    if (extract.ok) {
      const completed = await completeCopy(candidate, destination, tree, diagnostics, signal);
      return {
        root: destination,
        strategy: completed.repaired ? 'git_archive_repaired' : 'git_archive',
        diagnostics,
        missingPaths: completed.missing,
        dispose: async () => {
          rmSync(destination, { recursive: true, force: true });
        },
      };
    }
    diagnostics.push(`tar extraction failed (${extract.spawnError ?? `exit ${String(extract.exitCode)}`}); falling back to a detached worktree`);
  } else {
    rmSync(tarPath, { force: true });
    diagnostics.push(`git archive failed (${archive.spawnError ?? `exit ${String(archive.exitCode)}`}); falling back to a detached worktree`);
  }

  // Fallback: a detached linked worktree. It shares Git administration with
  // the repository, which is weaker isolation; recorded on the receipt.
  rmSync(destination, { recursive: true, force: true });
  await gitOrThrow(['worktree', 'add', '--detach', destination, candidate.revision], {
    cwd: candidate.repoRoot,
    noHooksDir: path.dirname(destination),
    ...(signal !== undefined ? { signal } : {}),
  });
  diagnostics.push('the disposable copy is a linked worktree and shares Git administration with the repository; this is weaker isolation than an archive extract');
  const completed = await completeCopy(candidate, destination, tree, diagnostics, signal);
  return {
    root: destination,
    strategy: 'git_worktree_detached',
    diagnostics,
    missingPaths: completed.missing,
    dispose: async () => {
      await git(['worktree', 'remove', '--force', destination], { cwd: candidate.repoRoot, noHooksDir: path.dirname(destination) });
      rmSync(destination, { recursive: true, force: true });
      await git(['worktree', 'prune'], { cwd: candidate.repoRoot });
    },
  };
}

/**
 * Run every check against its own disposable copy of the frozen candidate.
 * Never throws for a failing check: a failure is evidence.
 */
export async function runChecks(input: RunChecksInput): Promise<CheckReceipt[]> {
  const outputRoot = path.resolve(input.outputRoot);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

  const seen = new Set<string>();
  for (const check of input.checks) {
    if (seen.has(check.criterionId)) throw new CheckRunnerError('duplicate_criterion', `criterion "${check.criterionId}" appears more than once in the check list`);
    seen.add(check.criterionId);
  }

  const receipts: CheckReceipt[] = [];
  let index = 0;
  for (const check of input.checks) {
    index += 1;
    const receipt = await runOneCheck(check, input, outputRoot, index);
    receipts.push(receipt);
    input.onReceipt?.(receipt);
  }
  return receipts;
}

async function runOneCheck(check: CheckSpec, input: RunChecksInput, outputRoot: string, index: number): Promise<CheckReceipt> {
  const id = newId();
  const required = check.required ?? true;
  const args = [...(check.args ?? [])];
  const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const slug = `${String(index).padStart(2, '0')}-${safeSegment(check.criterionId)}`;
  const workDir = path.join(outputRoot, slug, 'candidate');
  const logDir = path.join(outputRoot, slug, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const stdoutPath = path.join(logDir, 'stdout.log');
  const stderrPath = path.join(logDir, 'stderr.log');

  const diagnostics: string[] = [];
  const home = mkdtempSync(path.join(outputRoot, `${slug}-home-`));
  const tmp = mkdtempSync(path.join(outputRoot, `${slug}-tmp-`));
  const { env, dropped } = buildCheckEnv(home, tmp, check.env);
  if (dropped.length > 0) diagnostics.push(`dropped ${dropped.length} environment variable(s) whose names match the redaction rule: ${dropped.sort().join(', ')}`);
  const identity = environmentIdentity(env);
  const candidate = { repoRoot: input.candidate.repoRoot, revision: input.candidate.revision, patchHash: input.candidate.patchHash ?? null };

  const failReceipt = (outcome: CheckOutcome, startedAt: string, message: string, strategy: CopyStrategy): CheckReceipt => ({
    id,
    criterionId: check.criterionId,
    description: check.description ?? null,
    required,
    command: check.command,
    args,
    cwd: check.cwd ?? '.',
    timeoutMs,
    outcome,
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt,
    endedAt: nowIso(),
    durationMs: 0,
    environmentIdentity: identity,
    candidate,
    copyStrategy: strategy,
    integrity: { before: '', after: '', mutated: false, mutatedFiles: [], addedFiles: [], fileCount: 0, scope: 'bounded' },
    outputSummary: { runner: null, testsRun: null, note: 'the command never ran, so it reported nothing' },
    stdoutPath,
    stderrPath,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    stdoutTail: '',
    stderrTail: message,
    evidenceProvenance: EVIDENCE_PROVENANCE,
    diagnostics: [...diagnostics, message],
  });

  const startedAt = nowIso();
  let copy: DisposableCopy;
  try {
    copy = await materializeFrozenCandidate(input.candidate, workDir, input.signal);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    return failReceipt('error', startedAt, `could not materialize the frozen candidate ${input.candidate.revision}: ${(error as Error).message}`, 'git_archive');
  }
  diagnostics.push(...copy.diagnostics);

  try {
    if (copy.missingPaths.length > 0) {
      return failReceipt(
        'error',
        startedAt,
        `the disposable copy is missing ${copy.missingPaths.length} tracked path(s) of the frozen candidate (${describePaths(copy.missingPaths)}), so the command would not have run against the candidate this criterion is about`,
        copy.strategy,
      );
    }
    const cwd = path.resolve(copy.root, check.cwd ?? '.');
    if (!isWithin(copy.root, cwd)) {
      return failReceipt('error', startedAt, `check cwd "${check.cwd}" escapes the candidate copy`, copy.strategy);
    }
    if (!existsSync(cwd)) {
      return failReceipt('error', startedAt, `check cwd "${check.cwd ?? '.'}" does not exist in candidate ${input.candidate.revision}`, copy.strategy);
    }

    const before = scanTrackedFiles(copy.root);
    const run = await runCommand({
      command: check.command,
      args,
      cwd,
      env,
      timeoutMs,
      stdoutFile: stdoutPath,
      stderrFile: stderrPath,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    const after = scanTrackedFiles(copy.root);
    const integrity = compareScans(before, after);
    if (integrity.addedFiles.length > 0) {
      diagnostics.push(`the check created ${integrity.addedFiles.length} file(s) in the disposable copy (for example ${integrity.addedFiles.slice(0, 3).join(', ')}); they were discarded with the copy`);
    }

    const outputSummary = summarizeCheckOutput(run.stdout, run.stderr);

    let outcome: CheckOutcome;
    if (run.spawnError !== null) {
      outcome = 'error';
      diagnostics.push(`the check command could not be started: ${run.spawnError}`);
    } else if (run.timedOut) {
      outcome = 'timeout';
      diagnostics.push(`the check exceeded its ${timeoutMs}ms deadline; the process group was terminated with ${run.signalsSent.join(' then ') || 'no signal'}`);
    } else if (integrity.mutated) {
      outcome = 'integrity_failed';
      diagnostics.push(
        `the check changed ${integrity.mutatedFiles.length} file(s) that belong to the frozen candidate (${integrity.mutatedFiles.slice(0, 5).join(', ')}); a check must not rewrite the source it is validating, so this result cannot be trusted as evidence`,
      );
    } else if (run.exitCode === 0 && outputSummary.testsRun === 0) {
      // Exit 0 with nothing executed is the shape a worker gets by emptying or
      // rewriting the suite. It is recorded as what it is, not as a pass.
      outcome = 'no_tests_executed';
      diagnostics.push(`${outputSummary.note}; a run that executed no tests is not evidence that the criterion holds, so it does not count as a pass`);
    } else if (run.exitCode === 0) {
      outcome = 'passed';
    } else {
      outcome = 'failed';
    }

    return {
      id,
      criterionId: check.criterionId,
      description: check.description ?? null,
      required,
      command: check.command,
      args,
      cwd: path.relative(copy.root, cwd) || '.',
      timeoutMs,
      outcome,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      environmentIdentity: identity,
      candidate,
      copyStrategy: copy.strategy,
      integrity,
      outputSummary,
      stdoutPath,
      stderrPath,
      stdoutBytes: run.stdoutBytes,
      stderrBytes: run.stderrBytes,
      outputTruncated: run.truncated,
      stdoutTail: tail(run.stdout),
      stderrTail: tail(run.stderr),
      evidenceProvenance: EVIDENCE_PROVENANCE,
      diagnostics,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    if (input.keepCopies !== true) {
      try {
        await copy.dispose();
      } catch {
        // The copy is disposable; a failure to delete it is not evidence.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

export interface CriterionStatus {
  readonly criterionId: string;
  readonly description: string | null;
  readonly required: boolean;
  /**
   * `passed` only ever comes from a receipt. `compromised` means a receipt
   * passed but the candidate rewrote the files that receipt executed, so it
   * does not establish the original criterion.
   */
  readonly status: 'passed' | 'failed' | 'compromised' | 'no_evidence';
  readonly outcome: CheckOutcome | null;
  readonly receiptId: string | null;
  readonly detail: string;
}

export interface AcceptanceDecision {
  readonly accepted: boolean;
  readonly criteria: ReadonlyArray<CriterionStatus>;
  readonly requiredTotal: number;
  readonly requiredPassed: number;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * A criterion whose own fixtures the candidate changed.
 *
 * The check *definition* is read from the base revision, but the code that
 * definition executes lives in the candidate, so a worker that rewrites the
 * repository's tests can make any command exit 0. `criterionId` is the
 * criterion whose evidence is affected, or `*` when the changed files affect
 * every criterion.
 */
export interface FixtureMutation {
  readonly criterionId: string;
  /** Changed paths, as `M path` / `D path` entries taken from the candidate diff. */
  readonly changedPaths: ReadonlyArray<string>;
}

export interface DecideAcceptanceOptions {
  /** Acceptance fixtures the candidate modified or deleted. */
  readonly fixtureMutations?: ReadonlyArray<FixtureMutation>;
  /**
   * Run-level facts that block acceptance whatever the receipts say — an
   * observed write outside the granted paths, a runtime that died mid-turn.
   */
  readonly blockers?: ReadonlyArray<string>;
}

/**
 * Decide acceptance from receipts, the integrity of the fixtures those
 * receipts executed, and run-level blockers.
 *
 * A criterion with no receipt is `no_evidence` and blocks acceptance when
 * required: absence of a check is never treated as a pass. A criterion whose
 * fixtures the candidate rewrote is `compromised` and blocks acceptance too:
 * the command may exit 0, but it is no longer running the criterion the base
 * revision defined (plan section 9, "a worker cannot manufacture a passing
 * result").
 */
export function decideAcceptance(
  criteria: ReadonlyArray<{ id: string; description?: string | null; required?: boolean }>,
  receipts: ReadonlyArray<CheckReceipt>,
  options: DecideAcceptanceOptions = {},
): AcceptanceDecision {
  const byCriterion = new Map(receipts.map((receipt) => [receipt.criterionId, receipt] as const));
  const mutations = options.fixtureMutations ?? [];
  const statuses: CriterionStatus[] = [];
  const reasons: string[] = [];
  let requiredTotal = 0;
  let requiredPassed = 0;

  const mutatedFor = (criterionId: string): ReadonlyArray<string> => {
    const paths = mutations.filter((entry) => entry.criterionId === criterionId || entry.criterionId === '*').flatMap((entry) => entry.changedPaths);
    return [...new Set(paths)].sort();
  };

  for (const criterion of criteria) {
    const receipt = byCriterion.get(criterion.id) ?? null;
    const required = criterion.required ?? receipt?.required ?? true;
    if (required) requiredTotal += 1;
    if (receipt === null) {
      statuses.push({
        criterionId: criterion.id,
        description: criterion.description ?? null,
        required,
        status: 'no_evidence',
        outcome: null,
        receiptId: null,
        detail: 'no verifier-executed check produced evidence for this criterion',
      });
      if (required) reasons.push(`criterion "${criterion.id}" has no verifier-executed evidence`);
      continue;
    }
    const mutated = mutatedFor(criterion.id);
    const passed = receipt.outcome === 'passed' && mutated.length === 0;
    if (passed && required) requiredPassed += 1;
    const compromised = receipt.outcome === 'passed' && mutated.length > 0;
    const detail = compromised
      ? `${describeOutcome(receipt)}, but the candidate changed the files this criterion executes (${mutated.join(', ')}), so the result does not establish the criterion the base revision defined`
      : describeOutcome(receipt);
    statuses.push({
      criterionId: criterion.id,
      description: criterion.description ?? receipt.description ?? null,
      required,
      status: passed ? 'passed' : compromised ? 'compromised' : 'failed',
      outcome: receipt.outcome,
      receiptId: receipt.id,
      detail,
    });
    if (!passed && required) reasons.push(`criterion "${criterion.id}" ${detail}`);
  }

  for (const blocker of options.blockers ?? []) reasons.push(blocker);

  // Receipts for criteria that are not in the contract are still evidence, but they cannot grant acceptance.
  for (const receipt of receipts) {
    if (!criteria.some((criterion) => criterion.id === receipt.criterionId)) {
      statuses.push({
        criterionId: receipt.criterionId,
        description: null,
        required: false,
        status: receipt.outcome === 'passed' ? 'passed' : 'failed',
        outcome: receipt.outcome,
        receiptId: receipt.id,
        detail: `${describeOutcome(receipt)} (not part of the task contract)`,
      });
    }
  }

  return { accepted: reasons.length === 0 && requiredTotal > 0, criteria: statuses, requiredTotal, requiredPassed, reasons };
}

function describeOutcome(receipt: CheckReceipt): string {
  switch (receipt.outcome) {
    case 'passed':
      return `passed (exit 0, ${receipt.durationMs}ms)`;
    case 'failed':
      return `failed with exit ${String(receipt.exitCode)}`;
    case 'timeout':
      return `exceeded its ${receipt.timeoutMs}ms deadline and was terminated`;
    case 'integrity_failed':
      return `changed files of the frozen candidate it was validating (${receipt.integrity.mutatedFiles.slice(0, 5).join(', ')})`;
    case 'no_tests_executed':
      return `exited 0 without executing any test (${receipt.outputSummary.note})`;
    case 'error':
      return `could not be executed (${receipt.diagnostics[receipt.diagnostics.length - 1] ?? 'unknown error'})`;
    case 'skipped':
      return 'was skipped';
    default:
      return 'produced an unknown outcome';
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistChecksInput {
  readonly runId: string;
  readonly taskId?: string | null;
  readonly attemptId?: string | null;
  readonly receipts: ReadonlyArray<CheckReceipt>;
  readonly now?: string;
  /**
   * Artifact path prefix, default `checks`. Artifacts are immutable and keyed
   * by run, so a run with more than one task must scope its check artifacts per
   * attempt or the second task collides with the first.
   */
  readonly pathPrefix?: string;
}

export interface PersistedCheck {
  readonly checkId: string;
  readonly criterionId: string;
  readonly outcome: CheckOutcome;
  readonly logArtifact: ArtifactRecord;
  readonly stderrArtifact: ArtifactRecord;
  readonly receiptArtifact: ArtifactRecord;
}

/**
 * Copy each receipt's logs into the run's artifact store and record the
 * check row. Artifacts are published (bytes first, receipt second) by the
 * artifact store; the check row references the stdout artifact.
 */
export function persistCheckReceipts(db: DatabaseSync, paths: StatePaths, input: PersistChecksInput): PersistedCheck[] {
  const now = input.now ?? nowIso();
  const persisted: PersistedCheck[] = [];

  for (const receipt of input.receipts) {
    const slug = safeSegment(receipt.criterionId);
    const base = `${input.pathPrefix ?? 'checks'}/${slug}`;
    const stdout = existsSync(receipt.stdoutPath) ? readFileSync(receipt.stdoutPath) : Buffer.alloc(0);
    const stderr = existsSync(receipt.stderrPath) ? readFileSync(receipt.stderrPath) : Buffer.from(receipt.stderrTail, 'utf8');
    const provenance = {
      evidenceProvenance: receipt.evidenceProvenance,
      criterionId: receipt.criterionId,
      command: receipt.command,
      args: receipt.args,
      environmentIdentity: receipt.environmentIdentity,
      copyStrategy: receipt.copyStrategy,
    };

    const logArtifact = writeArtifact(db, paths, {
      runId: input.runId,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      type: 'check_stdout',
      relativePath: `${base}/stdout.log`,
      bytes: stdout,
      candidateRevision: receipt.candidate.revision,
      provenance,
      now,
    });
    const stderrArtifact = writeArtifact(db, paths, {
      runId: input.runId,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      type: 'check_stderr',
      relativePath: `${base}/stderr.log`,
      bytes: stderr,
      candidateRevision: receipt.candidate.revision,
      provenance,
      now,
    });
    const receiptArtifact = writeArtifact(db, paths, {
      runId: input.runId,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      type: 'check_receipt',
      relativePath: `${base}/receipt.json`,
      bytes: `${JSON.stringify(receipt, null, 2)}\n`,
      candidateRevision: receipt.candidate.revision,
      provenance,
      now,
    });

    db.prepare(
      `INSERT INTO checks(id, run_id, task_id, attempt_id, criterion_ids_json, command, args_json, cwd, env_identity, candidate_hash, candidate_revision, outcome, exit_code, log_artifact_id, evidence_provenance, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.id,
      input.runId,
      input.taskId ?? null,
      input.attemptId ?? null,
      JSON.stringify([receipt.criterionId]),
      receipt.command,
      JSON.stringify(receipt.args),
      receipt.cwd,
      JSON.stringify(receipt.environmentIdentity),
      receipt.candidate.patchHash,
      receipt.candidate.revision,
      receipt.outcome,
      receipt.exitCode,
      logArtifact.id,
      receipt.evidenceProvenance,
      receipt.startedAt,
      receipt.endedAt,
      now,
    );

    persisted.push({ checkId: receipt.id, criterionId: receipt.criterionId, outcome: receipt.outcome, logArtifact, stderrArtifact, receiptArtifact });
  }

  return persisted;
}

export interface CheckRow {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  criterion_ids_json: string;
  command: string;
  args_json: string;
  cwd: string;
  env_identity: string;
  candidate_hash: string | null;
  candidate_revision: string | null;
  outcome: CheckOutcome;
  exit_code: number | null;
  log_artifact_id: string | null;
  evidence_provenance: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export function listChecks(db: DatabaseSync, runId: string): CheckRow[] {
  return db.prepare('SELECT * FROM checks WHERE run_id = ? ORDER BY created_at, id').all(runId) as unknown as CheckRow[];
}
