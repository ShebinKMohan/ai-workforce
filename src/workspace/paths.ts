/**
 * Where workspace state lives.
 *
 * <state-root>/
 *   workspace.json                 the workspace (schema 2)
 *   workspace.json.lock(.sqlite)   the short-lived lock every writer holds while saving
 *   projects/<project-id>/         ONE project's own state root: state.sqlite,
 *                                  coordinator.lock, runs/, workspaces/, rosters/
 *
 * A project's state root is an ordinary state root (`createStatePaths`), so
 * the engine runs unchanged inside it. Two projects never share a database, a
 * coordinator lock, a run directory or a candidate workspace path: they are
 * separate directories by construction, and therefore run concurrently under
 * separate locks. Two requests to the SAME project share its lock, so they
 * queue.
 */
import path from 'node:path';
import { SLUG_PATTERN } from '../core/workspace-config.js';
import { classifyHolder, readLockInfo } from '../storage/lock.js';
import { createStatePaths, type StatePaths } from '../storage/paths.js';
import { invalidWorkspaceInput } from './errors.js';

export const WORKSPACE_FILE_NAME = 'workspace.json';
export const PROJECTS_DIR_NAME = 'projects';

export function workspaceFilePath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), WORKSPACE_FILE_NAME);
}

export function workspaceLockPath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), `${WORKSPACE_FILE_NAME}.lock`);
}

/** `<state-root>/projects/<project-id>`. The id must be a workspace slug, so it is always one safe path segment. */
export function projectStateRoot(stateRoot: string, projectId: string): string {
  if (!SLUG_PATTERN.test(projectId)) throw invalidWorkspaceInput('invalid_project_id', `"${projectId}" is not a valid project id`);
  return path.join(path.resolve(stateRoot), PROJECTS_DIR_NAME, projectId);
}

/** The engine's state paths for one project: its database, lock, runs and candidate workspaces. */
export function projectStatePaths(stateRoot: string, projectId: string): StatePaths {
  return createStatePaths(projectStateRoot(stateRoot, projectId));
}

/**
 * True when a coordinator holds the project's lock: a run (or resume) of that
 * project is in progress. Reads the lock's holder record only; creates nothing.
 * A holder whose liveness cannot be verified counts as live, as it does for
 * the lock itself.
 */
export function projectHasLiveRun(stateRoot: string, projectId: string): boolean {
  const info = readLockInfo(projectStatePaths(stateRoot, projectId).lockPath);
  if (info === null) return false;
  const status = classifyHolder(info);
  return status === 'alive' || status === 'unverifiable';
}
