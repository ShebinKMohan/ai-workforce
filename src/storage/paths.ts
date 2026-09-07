/**
 * State root and run directory layout (plan section 8).
 *
 * <state-root>/
 *   manifest.json            paths manifest (state root, workspace root, database)
 *   state.sqlite             authoritative logical state
 *   coordinator.lock         mutating coordinator ownership
 *   runs/<run-id>/request.json | contract.json | config-snapshot.json | events.jsonl | artifacts/...
 * <workspace-root>/<run-id>/<task-id>/<attempt-id>/
 *
 * Coordinator state lives outside worker write access; workers only ever see
 * their own workspace and explicitly granted paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { nowIso } from '../core/ids.js';

export const STATE_ROOT_ENV = 'WORKFORCE_STATE_DIR';
export const DEFAULT_STATE_DIR_NAME = '.workforce';

export interface StatePaths {
  readonly root: string;
  readonly manifestPath: string;
  readonly databasePath: string;
  readonly lockPath: string;
  readonly runsDir: string;
  readonly workspaceRoot: string;
  runDir(runId: string): string;
  runRequestPath(runId: string): string;
  runContractPath(runId: string): string;
  runConfigSnapshotPath(runId: string): string;
  runEventsJsonlPath(runId: string): string;
  runArtifactsDir(runId: string): string;
  workspaceDir(runId: string, taskId: string, attemptId: string): string;
}

export const PathsManifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  stateRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  databasePath: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type PathsManifest = z.infer<typeof PathsManifestSchema>;

/** Resolve the state root: explicit override, then env, then ~/.workforce. Always absolute. */
export function resolveStateRoot(override?: string | null): string {
  const chosen = override && override.length > 0 ? override : process.env[STATE_ROOT_ENV] || path.join(os.homedir(), DEFAULT_STATE_DIR_NAME);
  return path.resolve(chosen);
}

const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeSegment(name: string, value: string): string {
  if (!ID_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} "${value}" is not a safe path segment`);
  }
  return value;
}

export function createStatePaths(root: string, options: { workspaceRoot?: string } = {}): StatePaths {
  const absoluteRoot = path.resolve(root);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(absoluteRoot, 'workspaces'));
  const runsDir = path.join(absoluteRoot, 'runs');
  const runDir = (runId: string): string => path.join(runsDir, assertSafeSegment('run id', runId));
  return {
    root: absoluteRoot,
    manifestPath: path.join(absoluteRoot, 'manifest.json'),
    databasePath: path.join(absoluteRoot, 'state.sqlite'),
    lockPath: path.join(absoluteRoot, 'coordinator.lock'),
    runsDir,
    workspaceRoot,
    runDir,
    runRequestPath: (runId) => path.join(runDir(runId), 'request.json'),
    runContractPath: (runId) => path.join(runDir(runId), 'contract.json'),
    runConfigSnapshotPath: (runId) => path.join(runDir(runId), 'config-snapshot.json'),
    runEventsJsonlPath: (runId) => path.join(runDir(runId), 'events.jsonl'),
    runArtifactsDir: (runId) => path.join(runDir(runId), 'artifacts'),
    workspaceDir: (runId, taskId, attemptId) =>
      path.join(
        workspaceRoot,
        assertSafeSegment('run id', runId),
        assertSafeSegment('task id', taskId),
        assertSafeSegment('attempt id', attemptId),
      ),
  };
}

/** Create the state root, runs and workspace directories and the paths manifest (idempotent). */
export function ensureStateRoot(paths: StatePaths): PathsManifest {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runsDir, { recursive: true });
  mkdirSync(paths.workspaceRoot, { recursive: true });
  if (existsSync(paths.manifestPath)) {
    return PathsManifestSchema.parse(JSON.parse(readFileSync(paths.manifestPath, 'utf8')));
  }
  const manifest: PathsManifest = {
    manifestVersion: 1,
    stateRoot: paths.root,
    workspaceRoot: paths.workspaceRoot,
    databasePath: paths.databasePath,
    createdAt: nowIso(),
  };
  writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Create the run directory and its artifacts subdirectories (idempotent). */
export function ensureRunDir(paths: StatePaths, runId: string): string {
  const dir = paths.runDir(runId);
  mkdirSync(path.join(paths.runArtifactsDir(runId), 'checks'), { recursive: true });
  mkdirSync(path.join(paths.runArtifactsDir(runId), 'logs'), { recursive: true });
  return dir;
}

/** True when `candidate` is `root` or lies beneath it (after resolution, no symlink following). */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
