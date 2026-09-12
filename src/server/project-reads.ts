/**
 * Reads across every project's own state root (day-one workspace design).
 *
 * Each project keeps its runs in `<state-root>/projects/<project-id>/`, an
 * ordinary state root, so these reads are the single-root reads of
 * `read-api.ts` applied to each project in turn, with the project id stamped on
 * every item. Nothing here merges two projects' rows into one record: a run is
 * only ever found under the project whose database holds it. Every database is
 * opened read-only.
 *
 * The root's own database holds runs made before workspaces. Once a workspace
 * exists those are listed apart, as earlier history. Before one exists the
 * office view is still the single-root view it always was, and `GET /api/runs`
 * answers exactly as it did (plus `mode: "legacy"`).
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SLUG_PATTERN, type WorkspaceConfig } from '../core/workspace-config.js';
import { createStatePaths, type StatePaths } from '../storage/paths.js';
import { PROJECTS_DIR_NAME, projectStateRoot, projectStatePaths, workspaceFilePath } from '../workspace/paths.js';
import { ApiError } from './http.js';
import { runsDocument } from './read-api.js';

/** The event-cursor key of the root database (runs made before workspaces). Never a valid project id. */
export const ROOT_SOURCE = '~';

/** `~` first, then project ids in order, so the same positions always print the same cursor. */
export function formatCompositeCursor(map: Readonly<Record<string, number>>): string {
  const keys = Object.keys(map).sort((a, b) => (a === ROOT_SOURCE ? -1 : b === ROOT_SOURCE ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => `${key}=${map[key]}`).join(',');
}

/** Project ids that have a state root on disk, sorted. Only names that are valid project ids count. */
export function projectRootIds(stateRoot: string): string[] {
  let names: string[];
  const directory = path.join(path.resolve(stateRoot), PROJECTS_DIR_NAME);
  try {
    if (!lstatSync(directory).isDirectory()) return [];
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (!SLUG_PATTERN.test(name)) return false;
      try {
        return lstatSync(path.join(directory, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** True once a workspace file or any project state root exists. */
export function isWorkspaceMode(stateRoot: string): boolean {
  return existsSync(workspaceFilePath(stateRoot)) || projectRootIds(stateRoot).length > 0;
}

/**
 * The state paths of one project, for a read. A project is readable when the
 * workspace names it or its state root exists on disk (a removed project's
 * history stays readable). Anything else, and any id that is not a valid
 * project id, is 404.
 */
export function readableProjectPaths(stateRoot: string, projectId: string, workspace: WorkspaceConfig | null): StatePaths {
  const unknown = new ApiError(404, 'unknown_project', `no project "${projectId}" in this workspace`);
  if (!SLUG_PATTERN.test(projectId)) throw unknown;
  const inWorkspace = workspace?.projects.some((project) => project.id === projectId) === true;
  // A slug protects the lexical path; refusing symlinked directories also
  // prevents one project's id from becoming an alias for another's state.
  const projectRoot = projectStateRoot(stateRoot, projectId);
  for (const directory of [path.dirname(projectRoot), projectRoot]) {
    try {
      if (!lstatSync(directory).isDirectory()) throw unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!inWorkspace) throw unknown;
    }
  }
  return projectStatePaths(stateRoot, projectId);
}

type Row = Record<string, unknown>;

/** One project's runs, each stamped with its project id and that project's lock as it stood around the read. */
export function projectRunsDocument(stateRoot: string, projectId: string, workspace: WorkspaceConfig | null, limit: number): Row {
  const paths = readableProjectPaths(stateRoot, projectId, workspace);
  const document = runsDocument(paths, limit);
  const lock = (document['coordinator'] as { lock: unknown }).lock;
  const project = workspace?.projects.find((entry) => entry.id === projectId) ?? null;
  return {
    ...document,
    projectId,
    project: project === null ? null : { id: project.id, name: project.name, archived: project.archived },
    stateRoot: paths.root,
    runs: (document['runs'] as Row[]).map((run) => ({ ...run, projectId, projectLock: lock })),
  };
}

/**
 * `GET /api/runs`.
 *
 * Before any workspace: the single-root document, each run with `projectId: null`.
 *
 * With a workspace: `runs` holds every project's runs newest first (bounded by
 * `limit`), each with its `projectId`; `projects` lists each project's state
 * (found or not, its lock, its own event cursor); `earlierHistory` is the root
 * database's runs, each with `projectId: null`; `eventCursor` is the composite
 * cursor a live stream should resume from.
 */
export function allRunsDocument(stateRoot: string, workspace: WorkspaceConfig | null, limit: number): Row {
  const rootPaths = createStatePaths(stateRoot);
  if (!isWorkspaceMode(stateRoot)) {
    const document = runsDocument(rootPaths, limit);
    return { ...document, mode: 'legacy', projects: [], earlierHistory: null, runs: (document['runs'] as Row[]).map((run) => ({ ...run, projectId: null })) };
  }

  const ids = [...new Set([...(workspace?.projects.map((project) => project.id) ?? []), ...projectRootIds(stateRoot)])].sort();
  const perProject = ids.map((id) => projectRunsDocument(stateRoot, id, workspace, limit));
  const runs = perProject
    .flatMap((document) => document['runs'] as Row[])
    .sort((a, b) => {
      const byTime = String(b['createdAt']).localeCompare(String(a['createdAt']));
      return byTime !== 0 ? byTime : String(b['id']).localeCompare(String(a['id']));
    })
    .slice(0, limit);

  const earlier = runsDocument(rootPaths, limit);
  const cursor: Record<string, number> = { [ROOT_SOURCE]: earlier['eventCursor'] as number };
  for (const document of perProject) cursor[document['projectId'] as string] = document['eventCursor'] as number;

  return {
    ok: true,
    mode: 'workspace',
    limit,
    stateFound: perProject.some((document) => document['stateFound'] === true),
    eventCursor: formatCompositeCursor(cursor),
    runs,
    projects: perProject.map((document) => ({
      projectId: document['projectId'],
      project: document['project'],
      inWorkspace: document['project'] !== null,
      stateRoot: document['stateRoot'],
      stateFound: document['stateFound'],
      eventCursor: document['eventCursor'],
      coordinator: document['coordinator'],
      runCount: (document['runs'] as Row[]).length,
    })),
    earlierHistory: {
      note: 'runs made before this workspace existed; read-only',
      stateRoot: rootPaths.root,
      stateFound: earlier['stateFound'],
      eventCursor: earlier['eventCursor'],
      coordinator: earlier['coordinator'],
      runs: (earlier['runs'] as Row[]).map((run) => ({ ...run, projectId: null })),
    },
  };
}
