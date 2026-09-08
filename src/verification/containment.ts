/**
 * Where a verifier-executed check is allowed to run, and how a breach of that
 * boundary is detected (FR049, FR050; plan section 9).
 *
 * Repository test code is untrusted by design. R0 has no OS-level containment
 * for it, so the one boundary that *is* enforceable is where the check's
 * working directory, HOME and TMPDIR live: never inside the coordinator's own
 * state root. The state root holds `state.sqlite`, the coordinator lock and
 * every run artifact; a check whose cwd sits under it only needs a relative
 * path with enough `..` segments to reach them.
 *
 * This module provides the two halves of that boundary:
 *
 *   1. `createVerificationRoot` hands out a disposable directory that is
 *      *disjoint* from every protected root — neither contains the other —
 *      and refuses rather than falling back to an unsafe location. Disposable
 *      copies, HOME and TMPDIR all live there. Receipts, logs and hashes stay
 *      under the run directory where they belong.
 *   2. `fingerprintStateRoot` / `compareStateRootFingerprints` record what the
 *      state root looked like immediately before and after the check command
 *      ran, so a write that reached it anyway — by absolute path, which no
 *      choice of cwd can prevent without an OS sandbox — is recorded as an
 *      integrity failure instead of passing silently.
 *
 * The fingerprint deliberately separates three kinds of path, because a guard
 * that cries wolf gets switched off:
 *
 *   - *Guarded* paths are everything in the state root except the per-run
 *     trees, the database and the lock files — `manifest.json` and
 *     `coordinator.lock` among them. Nothing the coordinator does during a
 *     check window touches these, so any creation, deletion or modification
 *     there is a violation.
 *   - *Critical* paths are `runs/`, `workspaces/`, `state.sqlite` and the lock
 *     arbiter database. The coordinator legitimately writes *into* them while
 *     a check runs — a planned run verifies one task while another is still
 *     emitting events — so their bytes are only observed. Their identity is
 *     guarded: deleting or replacing one is something the coordinator never
 *     does mid-run, and is reported as a violation.
 *   - *Transient* paths are SQLite's journal companions, which appear and
 *     disappear on their own schedule. Nothing about them is a violation.
 *
 * The honest limit: a check that overwrites `state.sqlite` in place, without
 * changing its inode, is recorded as an observation rather than a violation,
 * because that is exactly what the coordinator's own writes look like from
 * outside the process.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../core/snapshot.js';
import { isWithin, PathsManifestSchema } from '../storage/paths.js';

/** Optional override for where disposable check copies are materialized. */
export const VERIFICATION_ROOT_ENV = 'WORKFORCE_VERIFICATION_DIR';

export class ContainmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContainmentError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Locating the state root that must be protected
// ---------------------------------------------------------------------------

const MANIFEST_MAX_BYTES = 64 * 1024;

/** True when `dir` has the shape `ensureStateRoot` creates: a paths manifest beside `runs/` and `workspaces/`. */
export function looksLikeStateRoot(dir: string): boolean {
  try {
    const manifest = path.join(dir, 'manifest.json');
    const stats = statSync(manifest);
    if (!stats.isFile() || stats.size > MANIFEST_MAX_BYTES) return false;
    if (!statSync(path.join(dir, 'runs')).isDirectory()) return false;
    if (!statSync(path.join(dir, 'workspaces')).isDirectory()) return false;
    PathsManifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
    return true;
  } catch {
    return false;
  }
}

/**
 * The coordinator state root that encloses `start`, or null when there is
 * none.
 *
 * Check output lands under `<state-root>/runs/<run-id>/…`, so the root can be
 * found from the output location itself. That matters: it works for a state
 * root chosen with `--state-dir`, which the environment variable would not
 * report, and it never guards an unrelated directory that merely happens to be
 * this user's default.
 */
export function findEnclosingStateRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    if (looksLikeStateRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The disposable verification root
// ---------------------------------------------------------------------------

export interface VerificationRoot {
  /** Absolute path of the disposable root. Disjoint from every protected root. */
  readonly path: string;
  /** Where it came from, recorded on receipts so the location is never a guess. */
  readonly origin: 'requested' | 'environment' | 'os_temp';
  readonly protectedRoots: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
  dispose(): void;
}

/** Resolve symlinks when the path exists, so `/var/folders/...` and `/private/var/folders/...` compare equal. */
export function canonicalize(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when neither path is the other, and neither contains the other. */
export function isDisjoint(a: string, b: string): boolean {
  const left = canonicalize(a);
  const right = canonicalize(b);
  return !isWithin(left, right) && !isWithin(right, left);
}

export interface CreateVerificationRootInput {
  /** Explicit parent directory for the disposable root. Tried first. */
  readonly requested?: string | null;
  /** Roots the disposable root must not sit inside (or contain). */
  readonly protect: ReadonlyArray<string>;
  readonly prefix?: string;
}

/**
 * Create a disposable directory for check copies, HOME and TMPDIR that is
 * disjoint from every protected root.
 *
 * Candidate parents are tried in order — an explicit request, the environment
 * override, then the OS temp directory — and the first one that is not itself
 * inside a protected root wins; the directory actually created there is then
 * re-checked, after symlink resolution, for full disjointness. If no candidate
 * qualifies this throws: running untrusted repository code with the
 * coordinator's state root as an ancestor of its working directory is the
 * defect this exists to prevent, so there is no fallback to it.
 */
export function createVerificationRoot(input: CreateVerificationRootInput): VerificationRoot {
  const protectedRoots = input.protect.map(canonicalize);
  const prefix = input.prefix ?? 'workforce-verification-';
  const diagnostics: string[] = [];
  const candidates: ReadonlyArray<{ base: string; origin: VerificationRoot['origin'] }> = [
    ...(input.requested !== undefined && input.requested !== null && input.requested.length > 0 ? [{ base: input.requested, origin: 'requested' as const }] : []),
    ...(process.env[VERIFICATION_ROOT_ENV] !== undefined && process.env[VERIFICATION_ROOT_ENV]!.length > 0
      ? [{ base: process.env[VERIFICATION_ROOT_ENV]!, origin: 'environment' as const }]
      : []),
    { base: os.tmpdir(), origin: 'os_temp' as const },
  ];

  const rejected: string[] = [];
  for (const candidate of candidates) {
    const base = path.resolve(candidate.base);
    // The base may legitimately *contain* a protected root — a state root
    // under the OS temp directory is exactly that — because the disposable
    // directory created inside it is a fresh sibling. What it must never be is
    // the protected root itself, or anything inside it.
    const unsafe = protectedRoots.find((root) => isWithin(root, canonicalize(base)));
    if (unsafe !== undefined) {
      rejected.push(`${base} (inside the protected root ${unsafe})`);
      continue;
    }
    let created: string;
    try {
      mkdirSync(base, { recursive: true, mode: 0o700 });
      created = mkdtempSync(path.join(base, prefix));
    } catch (error) {
      rejected.push(`${base} (${(error as Error).message})`);
      continue;
    }
    // mkdtemp can land on a symlinked base (macOS /var), so re-check the real path.
    const real = canonicalize(created);
    const stillUnsafe = protectedRoots.find((root) => !isDisjoint(real, root));
    if (stillUnsafe !== undefined) {
      rmSync(created, { recursive: true, force: true });
      rejected.push(`${real} (resolved inside the protected root ${stillUnsafe})`);
      continue;
    }
    if (rejected.length > 0) diagnostics.push(`rejected ${rejected.length} verification root candidate(s): ${rejected.join('; ')}`);
    return {
      path: real,
      origin: candidate.origin,
      protectedRoots,
      diagnostics,
      dispose: () => rmSync(real, { recursive: true, force: true }),
    };
  }

  throw new ContainmentError(
    'no_safe_verification_root',
    `no disposable verification root could be created outside the coordinator's protected directories (${protectedRoots.join(', ') || 'none'}); ` +
      `tried ${rejected.join('; ')}. Checks execute untrusted repository code, so no check runs rather than running it inside the state root; ` +
      `set ${VERIFICATION_ROOT_ENV} to a directory outside the state root`,
  );
}

// ---------------------------------------------------------------------------
// Detecting a write that reached the state root anyway
// ---------------------------------------------------------------------------

/**
 * Top-level directories the guard records but does not descend into: the
 * coordinator writes run artifacts and worker workspaces there while a check
 * runs, so their contents churn legitimately. Their *identity* is still
 * guarded — the coordinator never deletes or replaces them mid-run.
 */
export const GUARD_PRUNED_DIRS = ['runs', 'workspaces'] as const;

/**
 * The workspace root the state root's own manifest declares, when it lives
 * inside the state root but not at the default `workspaces/`. `--workspace-root`
 * can put it anywhere; a worker writing there while a sibling task verifies is
 * ordinary, and hashing a whole repository copy twice per check would not be
 * cheap either.
 */
function declaredWorkspaceRelative(root: string): string | null {
  try {
    const manifest = PathsManifestSchema.parse(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    const relative = path.relative(root, path.resolve(manifest.workspaceRoot));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative;
  } catch {
    return null;
  }
}

/**
 * Files whose bytes change legitimately during a check window: a planned run
 * verifies one task while another is still writing events. Their identity is
 * guarded, their contents are only observed.
 */
export const GUARD_CRITICAL_FILES = ['state.sqlite', 'coordinator.lock.sqlite'] as const;

/**
 * SQLite's journal companions. They appear, grow and disappear on their own
 * schedule (a checkpoint on the last connection close removes the `-wal`), so
 * nothing about them is treated as a violation.
 */
export const GUARD_TRANSIENT_FILES = [
  'state.sqlite-wal',
  'state.sqlite-shm',
  'state.sqlite-journal',
  'coordinator.lock.sqlite-wal',
  'coordinator.lock.sqlite-shm',
  'coordinator.lock.sqlite-journal',
] as const;

export const GUARD_MAX_ENTRIES = 4_000;
export const GUARD_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface StateRootFingerprint {
  readonly root: string | null;
  /** Path -> content descriptor for everything that must not change at all. */
  readonly guarded: ReadonlyMap<string, string>;
  /** Path -> `dev:…:ino:…` (or `absent`) for the run trees, the database and the lock arbiter. */
  readonly critical: ReadonlyMap<string, string>;
  /** Path -> `size:…:mtime:…` for those same paths, plus the journal companions. Churn is expected. */
  readonly volatile: ReadonlyMap<string, string>;
  /** Digest over the guarded set and the critical identities — never over volatile bytes. */
  readonly digest: string;
  readonly scope: 'complete' | 'bounded' | 'unavailable';
}

const UNAVAILABLE: StateRootFingerprint = {
  root: null,
  guarded: new Map(),
  critical: new Map(),
  volatile: new Map(),
  digest: '',
  scope: 'unavailable',
};

function observe(target: string): { identity: string; volatile: string } {
  try {
    const stats = statSync(target, { bigint: true });
    return { identity: `dev:${stats.dev}:ino:${stats.ino}`, volatile: `size:${stats.size}:mtime:${stats.mtimeNs}` };
  } catch {
    return { identity: 'absent', volatile: 'absent' };
  }
}

function safeReadLink(target: string): string {
  try {
    return readlinkSync(target);
  } catch {
    return '';
  }
}

/**
 * A cheap snapshot of the coordinator's state root.
 *
 * Everything outside the pruned trees and the database and lock files is
 * hashed; those are recorded by identity and size. On a normal state root this
 * walks a handful of entries.
 */
export function fingerprintStateRoot(root: string | null): StateRootFingerprint {
  if (root === null) return UNAVAILABLE;
  const absolute = path.resolve(root);
  const guarded = new Map<string, string>();
  const critical = new Map<string, string>();
  const volatileEntries = new Map<string, string>();
  let scope: 'complete' | 'bounded' = 'complete';

  const criticalNames = new Set<string>([...GUARD_PRUNED_DIRS, ...GUARD_CRITICAL_FILES]);
  const transientNames = new Set<string>(GUARD_TRANSIENT_FILES);
  const declared = declaredWorkspaceRelative(absolute);
  const prunedRelatives = new Set<string>([...GUARD_PRUNED_DIRS, ...(declared !== null ? [declared] : [])]);

  const stack: string[] = [absolute];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory of the state root that cannot be read is itself worth recording.
      guarded.set(path.relative(absolute, dir) || '.', 'unreadable');
      scope = 'bounded';
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(absolute, full);
      seen += 1;
      if (seen > GUARD_MAX_ENTRIES) {
        scope = 'bounded';
        continue;
      }
      const topLevel = !relative.includes(path.sep);
      if ((topLevel && criticalNames.has(entry.name)) || prunedRelatives.has(relative)) {
        const observed = observe(full);
        critical.set(relative, observed.identity);
        volatileEntries.set(relative, observed.volatile);
        continue;
      }
      if (topLevel && transientNames.has(entry.name)) {
        volatileEntries.set(relative, observe(full).volatile);
        continue;
      }
      if (entry.isSymbolicLink()) {
        guarded.set(relative, `symlink:${sha256Hex(safeReadLink(full))}`);
        continue;
      }
      if (entry.isDirectory()) {
        guarded.set(relative, 'dir');
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        guarded.set(relative, 'other');
        continue;
      }
      try {
        const stats = statSync(full);
        if (stats.size > GUARD_MAX_FILE_BYTES) {
          guarded.set(relative, `size:${stats.size}`);
          scope = 'bounded';
          continue;
        }
        guarded.set(relative, sha256Hex(readFileSync(full)));
      } catch {
        guarded.set(relative, 'unreadable');
        scope = 'bounded';
      }
    }
  }

  const digest = createHash('sha256');
  for (const key of [...guarded.keys()].sort()) digest.update(`g\0${key}\0${guarded.get(key)!}\0`);
  for (const key of [...critical.keys()].sort()) digest.update(`c\0${key}\0${critical.get(key)!}\0`);
  return { root: absolute, guarded, critical, volatile: volatileEntries, digest: digest.digest('hex'), scope };
}

export interface StateRootGuardReport {
  readonly stateRoot: string | null;
  /** False when no state root was found to guard; the report then proves nothing. */
  readonly checked: boolean;
  /** Changes the coordinator never makes during a check window. Any entry here fails the check. */
  readonly violations: ReadonlyArray<string>;
  /** Byte-level churn in the run trees, the database and the lock files: expected, recorded, never a failure on its own. */
  readonly observations: ReadonlyArray<string>;
  readonly before: string;
  readonly after: string;
  readonly scope: 'complete' | 'bounded' | 'unavailable';
  readonly note: string;
}

const MAX_REPORTED = 50;

/** Compare two fingerprints of the same state root. */
export function compareStateRootFingerprints(before: StateRootFingerprint, after: StateRootFingerprint): StateRootGuardReport {
  if (before.root === null || after.root === null) {
    return {
      stateRoot: before.root ?? after.root,
      checked: false,
      violations: [],
      observations: [],
      before: before.digest,
      after: after.digest,
      scope: 'unavailable',
      note: "no coordinator state root encloses this check's output location, so nothing was compared; the check still ran outside every protected root",
    };
  }

  const violations: string[] = [];
  const observations: string[] = [];

  for (const [file, hash] of before.guarded) {
    const now = after.guarded.get(file);
    if (now === undefined) violations.push(`${file} (deleted)`);
    else if (now !== hash) violations.push(`${file} (modified)`);
  }
  for (const file of after.guarded.keys()) {
    if (!before.guarded.has(file)) violations.push(`${file} (created)`);
  }
  for (const [file, identity] of before.critical) {
    const now = after.critical.get(file) ?? 'absent';
    if (now === identity) continue;
    violations.push(now === 'absent' ? `${file} (deleted)` : `${file} (replaced: was ${identity}, now ${now})`);
  }
  for (const [file, identity] of after.critical) {
    if (!before.critical.has(file) && identity !== 'absent') violations.push(`${file} (created)`);
  }
  for (const [file, descriptor] of before.volatile) {
    const now = after.volatile.get(file) ?? 'absent';
    if (now !== descriptor) observations.push(`${file} (${descriptor} -> ${now})`);
  }
  for (const [file, descriptor] of after.volatile) {
    if (!before.volatile.has(file)) observations.push(`${file} (absent -> ${descriptor})`);
  }

  violations.sort();
  observations.sort();
  const scope: StateRootGuardReport['scope'] = before.scope === 'complete' && after.scope === 'complete' ? 'complete' : 'bounded';
  const pruned = GUARD_PRUNED_DIRS.map((name) => `${name}/`).join(' and ');
  return {
    stateRoot: before.root,
    checked: true,
    violations: violations.slice(0, MAX_REPORTED),
    observations: observations.slice(0, MAX_REPORTED),
    before: before.digest,
    after: after.digest,
    scope,
    note:
      violations.length > 0
        ? `the coordinator state root changed while the check ran: ${violations.length} guarded path(s) created, modified, deleted or replaced`
        : `the coordinator state root was unchanged, apart from bytes inside ${pruned} and the database and lock files that the coordinator itself writes during a run` +
          (observations.length > 0 ? ` (${observations.length} such change(s) recorded)` : ''),
  };
}
