/** Session-gated folder metadata for project selection. Never reads file contents or starts a process. */
import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ApiError } from './http.js';
import { readWorkspace } from './workspace-api.js';

export const FOLDER_RESULT_LIMIT = 200;
export const FOLDER_SCAN_LIMIT = 2000;
const FolderRequest = z.strictObject({ path: z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'folder paths cannot be blank or contain control characters').optional() });

function withinProtectedRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export interface FolderListing {
  readonly ok: true;
  readonly currentPath: string;
  readonly parentPath: string | null;
  readonly isGitRepository: boolean;
  readonly places: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly folders: ReadonlyArray<{ readonly name: string; readonly path: string; readonly isGitRepository: boolean }>;
  readonly truncated: boolean;
}

async function directory(value: string): Promise<string> {
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new ApiError(400, 'folder_not_directory', 'Choose a folder, not a file.');
  return canonical;
}

async function gitMarker(folder: string): Promise<boolean> {
  try { const marker = await stat(path.join(folder, '.git')); return marker.isDirectory() || marker.isFile(); }
  catch { return false; }
}

function folderError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ApiError(404, 'folder_not_found', 'This folder is no longer available. Choose another location.');
  if (code === 'EACCES' || code === 'EPERM') return new ApiError(403, 'folder_access_denied', 'AI Workforce cannot read this folder. Choose another folder or grant access in your system settings.');
  return new ApiError(400, 'folder_unavailable', 'This folder could not be opened. Choose another location.');
}

/** Must be mounted as POST behind checkApiWrite: filenames are private even though this operation is read-only. */
export async function listProjectFolders(raw: unknown, stateRoot: string): Promise<FolderListing> {
  const parsed = FolderRequest.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid_folder_request', 'Use an absolute folder path or ~/ for your home folder.');
  const home = homedir();
  const requested = parsed.data.path ?? home;
  const expanded = requested === '~' ? home : requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested;
  if (!path.isAbsolute(expanded)) throw new ApiError(400, 'path_not_absolute', 'Use an absolute folder path or ~/ for your home folder.');
  try {
    const currentPath = await directory(expanded);
    const protectedRoot = await realpath(stateRoot).catch(() => path.resolve(stateRoot));
    if (withinProtectedRoot(protectedRoot, currentPath)) throw new ApiError(403, 'folder_protected', 'Coordinator storage is not a project folder. Choose another folder.');
    const folders: Array<{ name: string; path: string; isGitRepository: boolean }> = [];
    let scanned = 0;
    let truncated = false;
    const stream = await opendir(currentPath);
    for await (const entry of stream) {
      if (++scanned > FOLDER_SCAN_LIMIT) { truncated = true; break; }
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      let canonical: string;
      try { canonical = await directory(entryPath); } catch { continue; }
      if (withinProtectedRoot(protectedRoot, canonical)) continue;
      if (folders.length >= FOLDER_RESULT_LIMIT) { truncated = true; break; }
      folders.push({ name: entry.name, path: entryPath, isGitRepository: await gitMarker(canonical) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const configured = readWorkspace(stateRoot).loaded?.config.projects.filter(project => !project.archived) ?? [];
    const candidates = [
      { label: 'Home', path: home },
      ...['Desktop', 'Documents', 'Downloads'].map(label => ({ label, path: path.join(home, label) })),
      { label: 'External drives', path: '/Volumes' },
      ...configured.slice(0, 20).map(project => ({ label: project.name, path: project.repoPath })),
    ];
    const places: Array<{ label: string; path: string }> = [];
    for (const candidate of candidates) {
      try {
        const canonical = await directory(candidate.path);
        if (!withinProtectedRoot(protectedRoot, canonical) && !places.some(place => place.path === canonical)) places.push({ label: candidate.label, path: canonical });
      } catch { /* Missing or denied shortcuts are omitted. */ }
    }
    const parent = path.dirname(currentPath);
    return { ok: true, currentPath, parentPath: parent === currentPath ? null : parent, isGitRepository: await gitMarker(currentPath), places, folders, truncated };
  } catch (error) { throw folderError(error); }
}
