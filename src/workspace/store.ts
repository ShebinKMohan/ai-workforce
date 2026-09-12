/**
 * Loading and saving `<state-root>/workspace.json`.
 *
 * Load: a missing file is the empty workspace at revision 0. A file that does
 * not parse, or breaks a cross-reference rule, is refused with every issue
 * named — and never overwritten.
 *
 * Save (`updateWorkspace`) is compare-and-swap:
 *   1. take the workspace file lock (the kernel-arbitrated primitive in
 *      `storage/lock.ts`, on its own arbiter), waiting at most `lockWaitMs`;
 *   2. read the file and hash it;
 *   3. refuse with exit 3 when `expectRevision` is not the current revision;
 *   4. apply the change to a copy, set revision + 1 and validate: any issue
 *      refuses with exit 2 and nothing is written;
 *   5. write `workspace.json.<random>.tmp` (0600) and fsync it;
 *   6. hash the file again: a hand edit that landed meanwhile (which takes no
 *      lock) refuses with exit 3 instead of being silently replaced;
 *   7. rename over `workspace.json` and fsync the directory.
 *
 * A crash anywhere before step 7 leaves the previous file intact: the rename
 * is the only step that changes what a reader sees. A temp file a crashed
 * writer left behind is removed by the next writer, under the lock.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomToken } from '../core/ids.js';
import { canonicalJson, sha256Hex } from '../core/snapshot.js';
import { emptyWorkspace, validateWorkspace, type WorkspaceConfig } from '../core/workspace-config.js';
import { acquireCoordinatorLock, LockHeldError, type CoordinatorLock } from '../storage/lock.js';
import { WorkspaceError } from './errors.js';
import { WORKSPACE_FILE_NAME, workspaceFilePath, workspaceLockPath } from './paths.js';

export interface LoadedWorkspace {
  readonly path: string;
  readonly config: WorkspaceConfig;
  /** False when there is no file yet: the empty workspace at revision 0. */
  readonly exists: boolean;
  /** sha256 of the file's bytes; null when there is no file. */
  readonly sha256: string | null;
}

function readRaw(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new WorkspaceError(2, 'unreadable_workspace', `cannot read ${file}: ${code === 'EISDIR' ? 'the path is a directory' : (error as Error).message}`);
  }
}

/** Parse and validate workspace text. Throws `WorkspaceError` (exit 2) naming every issue. */
export function parseWorkspaceText(file: string, raw: string): WorkspaceConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WorkspaceError(2, 'invalid_workspace', `${file} is not valid JSON (${(error as Error).message}); it is left exactly as it is`);
  }
  const validation = validateWorkspace(value);
  if (!validation.ok) {
    throw new WorkspaceError(
      2,
      'invalid_workspace',
      `${file} is invalid (${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}); it is left exactly as it is`,
      validation.issues.map((issue) => `${issue.path}: [${issue.code}] ${issue.message}`),
    );
  }
  return validation.config;
}

/** Load the workspace of a state root. A missing file is the empty workspace at revision 0. */
export function loadWorkspace(stateRoot: string): LoadedWorkspace {
  const file = workspaceFilePath(stateRoot);
  const raw = readRaw(file);
  if (raw === null) return { path: file, config: emptyWorkspace(), exists: false, sha256: null };
  return { path: file, config: parseWorkspaceText(file, raw), exists: true, sha256: sha256Hex(raw) };
}

export interface UpdateHooks {
  /** After the current file was read under the lock. Tests use it to inject a concurrent hand edit. */
  readonly afterRead?: (loaded: LoadedWorkspace) => void;
  /** After the temp file is durable and before the rename. Tests use it to inject a crash. */
  readonly beforeRename?: (tempPath: string) => void;
}

export interface UpdateOptions {
  /** Refuse (exit 3) unless the file is still at this revision. */
  readonly expectRevision?: number;
  /** Write the file even when the change is a no-op, if it does not exist yet (`workspace init`). */
  readonly createIfMissing?: boolean;
  /** How long to wait for another writer's lock. Default 2000 ms. */
  readonly lockWaitMs?: number;
  readonly hooks?: UpdateHooks;
}

export interface UpdateResult {
  readonly path: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly sha256: string | null;
  /** False when the change altered nothing, so nothing was written and the revision did not move. */
  readonly written: boolean;
  readonly config: WorkspaceConfig;
}

const TEMP_NAME = new RegExp(`^${WORKSPACE_FILE_NAME.replace('.', '\\.')}\\.[0-9a-f]{16}\\.tmp$`);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireWorkspaceLock(stateRoot: string, waitMs: number): CoordinatorLock {
  const lockPath = workspaceLockPath(stateRoot);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquireCoordinatorLock(lockPath);
    } catch (error) {
      if (!(error instanceof LockHeldError)) throw error;
      if (Date.now() >= deadline) {
        throw new WorkspaceError(4, 'workspace_lock_busy', `another writer has been saving ${workspaceFilePath(stateRoot)} for more than ${waitMs} ms; try again`, [error.message]);
      }
      sleepSync(25);
    }
  }
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems refuse fsync on a directory; the rename itself already happened.
  }
}

/** Temp files only a crashed writer can have left: every live writer holds the lock while its temp file exists. */
function removeOrphanTemps(stateRoot: string): void {
  for (const name of readdirSync(stateRoot)) {
    if (!TEMP_NAME.test(name)) continue;
    try {
      unlinkSync(path.join(stateRoot, name));
    } catch {
      // best effort: an orphan never affects what a reader sees
    }
  }
}

function withoutRevision(config: WorkspaceConfig): string {
  return canonicalJson({ ...config, revision: 0 });
}

/**
 * Apply `change` to the current workspace and save it atomically under
 * compare-and-swap. `change` receives a private copy and returns the proposed
 * document; the revision it returns is ignored.
 */
export function updateWorkspace(stateRoot: string, change: (current: WorkspaceConfig) => WorkspaceConfig, options: UpdateOptions = {}): UpdateResult {
  const root = path.resolve(stateRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = workspaceFilePath(root);
  const lock = acquireWorkspaceLock(root, options.lockWaitMs ?? 2000);
  let tempPath: string | null = null;
  try {
    removeOrphanTemps(root);
    const loaded = loadWorkspace(root);
    options.hooks?.afterRead?.(loaded);
    const current = loaded.config;
    if (options.expectRevision !== undefined && options.expectRevision !== current.revision) {
      throw new WorkspaceError(
        3,
        'workspace_revision_conflict',
        `the workspace changed since revision ${options.expectRevision}: it is now at revision ${current.revision}. Nothing was written; reload and try again`,
      );
    }

    const proposed = change(structuredClone(current));
    if (withoutRevision(proposed) === withoutRevision(current) && (loaded.exists || options.createIfMissing !== true)) {
      return { path: file, previousRevision: current.revision, revision: current.revision, sha256: loaded.sha256, written: false, config: current };
    }

    const validation = validateWorkspace({ ...proposed, revision: current.revision + 1 });
    if (!validation.ok) {
      throw new WorkspaceError(
        2,
        'invalid_workspace_change',
        `the change was refused (${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}); workspace.json is unchanged`,
        validation.issues.map((issue) => `${issue.path}: [${issue.code}] ${issue.message}`),
      );
    }
    const text = `${JSON.stringify(validation.config, null, 2)}\n`;

    tempPath = path.join(root, `${WORKSPACE_FILE_NAME}.${randomToken(8)}.tmp`);
    const fd = openSync(tempPath, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    options.hooks?.beforeRename?.(tempPath);

    const onDisk = readRaw(file);
    if ((onDisk === null ? null : sha256Hex(onDisk)) !== loaded.sha256) {
      throw new WorkspaceError(3, 'workspace_changed_on_disk', `${file} was changed outside Workforce while this change was being saved; nothing was written. Reload and try again`);
    }
    renameSync(tempPath, file);
    tempPath = null;
    fsyncDirectory(root);
    return { path: file, previousRevision: current.revision, revision: validation.config.revision, sha256: sha256Hex(text), written: true, config: validation.config };
  } finally {
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath);
      } catch {
        // already gone
      }
    }
    lock.release();
  }
}
