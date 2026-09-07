/**
 * The acceptance surface: which base files a criterion's evidence executes.
 *
 * The check *definition* is pinned to the base revision, but the code it runs
 * comes from the candidate. A worker that rewrites the acceptance suite and
 * then reports a pass has not satisfied the criteria the base defined — it has
 * replaced them. Finding that surface is how the run tells the two apart.
 *
 * This lives beside the check runner rather than inside the orchestrator so
 * that BOTH acceptance decisions use it: the per-task one in `runDirect` and
 * the combined one in `combineArtifacts`.
 */
import type { CheckSpec, FixtureMutation } from './checks.js';

/**
 * Paths that look like an acceptance fixture whatever the check command is.
 * A criterion executes them, so the candidate rewriting them changes what the
 * criterion means.
 */
const FIXTURE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)(tests?|spec|specs|__tests__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/,
];

/** Package managers that read `package.json` to decide what the check actually runs. */
const PACKAGE_MANAGER_COMMANDS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

/** Shell operators that separate one command from the next inside a script body. */
const SCRIPT_SEPARATORS = /(?:&&|\|\||[;|&\n])/;

/** How deep `npm run a` -> `npm run b` -> ... is followed before giving up. */
const MAX_SCRIPT_DEPTH = 4;

export interface AcceptanceSurface {
  /** Criterion id (or `*` for every criterion) to the base paths its evidence executes. */
  readonly byCriterion: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Base paths that define acceptance without being executed by it. */
  readonly definitionPaths: ReadonlyArray<string>;
}

/** Repository facts the surface needs beyond the file list. */
export interface SurfaceContext {
  /** `package.json` as it reads at the BASE revision, when the repository has one. */
  readonly packageManifest?: string | null;
}

export function normalizeRelative(value: string): string | null {
  const cleaned = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned.startsWith('/') || cleaned.startsWith('..') || cleaned.includes('\0')) return null;
  return cleaned;
}

function existsInTree(baseFiles: ReadonlyArray<string>, candidate: string): boolean {
  return baseFiles.some((file) => file === candidate || file.startsWith(`${candidate}/`));
}

function parseScripts(packageManifest: string | null | undefined): ReadonlyMap<string, string> {
  if (packageManifest === null || packageManifest === undefined) return new Map();
  try {
    const parsed = JSON.parse(packageManifest) as { scripts?: Record<string, unknown> };
    const scripts = new Map<string, string>();
    for (const [name, body] of Object.entries(parsed.scripts ?? {})) {
      if (typeof body === 'string') scripts.set(name, body);
    }
    return scripts;
  } catch {
    return new Map();
  }
}

/** The script a package-manager invocation runs, e.g. `npm test` -> "test", `pnpm run lint` -> "lint". */
function scriptNameOf(command: string, args: ReadonlyArray<string>): string | null {
  if (!PACKAGE_MANAGER_COMMANDS.has(command)) return null;
  const words = args.filter((arg) => !arg.startsWith('-'));
  const first = words[0];
  if (first === undefined) return null;
  if (first === 'run' || first === 'run-script' || first === 'exec') return words[1] ?? null;
  // `npm test` / `yarn test` / `npm start`: lifecycle shorthands.
  if (first === 'test' || first === 'start' || first === 'stop' || first === 'restart') return first;
  // `yarn lint` and `pnpm lint` run the script directly.
  if (command === 'yarn' || command === 'pnpm') return first;
  return null;
}

/**
 * Every path-like token a script body (and the scripts it chains to) mentions.
 *
 * This is what closes the "rewrite the acceptance suite" escape for a
 * repository whose suite does not live under a conventionally named
 * directory: `"test": "node verify/acceptance.js"` executes
 * `verify/acceptance.js`, so that file is part of the criterion's surface even
 * though nothing about its path says "test".
 */
function pathsFromScript(
  scriptName: string,
  scripts: ReadonlyMap<string, string>,
  baseFiles: ReadonlyArray<string>,
  seen: Set<string>,
  depth: number,
): ReadonlyArray<string> {
  if (depth > MAX_SCRIPT_DEPTH || seen.has(scriptName)) return [];
  seen.add(scriptName);
  const found = new Set<string>();
  // npm runs pre<name> and post<name> around the script itself.
  for (const name of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
    const body = scripts.get(name);
    if (body === undefined) continue;
    for (const segment of body.split(SCRIPT_SEPARATORS)) {
      const words = segment
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^["']|["']$/g, ''))
        .filter((word) => word.length > 0);
      if (words.length === 0) continue;
      const nested = scriptNameOf(words[0]!, words.slice(1));
      if (nested !== null) {
        for (const value of pathsFromScript(nested, scripts, baseFiles, seen, depth + 1)) found.add(value);
        continue;
      }
      for (const word of words.slice(1)) {
        if (word.startsWith('-')) continue;
        const relative = normalizeRelative(word);
        if (relative === null) continue;
        if (existsInTree(baseFiles, relative)) found.add(relative);
      }
    }
  }
  return [...found];
}

/**
 * Work out which base files each criterion's evidence actually executes.
 *
 * Three sources, all of them conservative (a path is only in the surface when
 * it exists at the base):
 *   1. paths that look like fixtures anywhere in the tree (`*`);
 *   2. literal path arguments of the check command;
 *   3. for a package-manager command, the paths named by the `package.json`
 *      script it runs, followed through `npm run` chains.
 */
export function acceptanceSurface(
  checks: ReadonlyArray<CheckSpec>,
  baseFiles: ReadonlyArray<string>,
  context: SurfaceContext = {},
): AcceptanceSurface {
  const byCriterion = new Map<string, ReadonlyArray<string>>();
  const scripts = parseScripts(context.packageManifest);

  const shared = baseFiles.filter((file) => FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(file)));
  if (shared.length > 0) byCriterion.set('*', [...new Set(shared)].sort());

  for (const check of checks) {
    const paths = new Set<string>();
    for (const token of [...(check.args ?? []), ...(check.cwd !== undefined ? [check.cwd] : [])]) {
      if (token.startsWith('-')) continue;
      const relative = normalizeRelative(token);
      if (relative === null) continue;
      if (existsInTree(baseFiles, relative)) paths.add(relative);
    }
    if (PACKAGE_MANAGER_COMMANDS.has(check.command) && baseFiles.includes('package.json')) {
      paths.add('package.json');
      const scriptName = scriptNameOf(check.command, check.args ?? []);
      if (scriptName !== null) {
        for (const value of pathsFromScript(scriptName, scripts, baseFiles, new Set(), 0)) paths.add(value);
      }
    }
    if (paths.size > 0) byCriterion.set(check.criterionId, [...paths].sort());
  }

  const definitionPaths = baseFiles.includes('.workforce/checks.json') ? ['.workforce/checks.json'] : [];
  return { byCriterion, definitionPaths };
}

function matchesSurfacePath(changedPath: string, surfacePath: string): boolean {
  return changedPath === surfacePath || changedPath.startsWith(`${surfacePath}/`);
}

export interface SurfaceFindings {
  /** Criteria whose executed fixtures the candidate modified or deleted. */
  readonly mutations: ReadonlyArray<FixtureMutation>;
  /** Files the candidate added inside an acceptance surface: recorded, not blocking. */
  readonly additions: ReadonlyArray<string>;
  /** Acceptance definitions the candidate changed. They cannot affect this run, which read them from the base. */
  readonly definitionChanges: ReadonlyArray<string>;
}

/**
 * Compare a candidate diff against the acceptance surface.
 *
 * Modifying or deleting a file a criterion executes compromises that
 * criterion's evidence. *Adding* a file does not: writing a new test to
 * protect the fix is exactly what a worker should be able to do, so it is
 * recorded and left alone.
 */
export function findSurfaceChanges(
  surface: AcceptanceSurface,
  changes: ReadonlyArray<{ status: string; path: string }>,
): SurfaceFindings {
  const mutations: FixtureMutation[] = [];
  const additions: string[] = [];

  for (const [criterionId, paths] of surface.byCriterion) {
    const changed = changes
      .filter((change) => !change.status.startsWith('A') && paths.some((surfacePath) => matchesSurfacePath(change.path, surfacePath)))
      .map((change) => `${change.status} ${change.path}`);
    if (changed.length > 0) mutations.push({ criterionId, changedPaths: [...new Set(changed)].sort() });
  }

  for (const change of changes) {
    if (!change.status.startsWith('A')) continue;
    for (const paths of surface.byCriterion.values()) {
      if (paths.some((surfacePath) => matchesSurfacePath(change.path, surfacePath))) {
        additions.push(change.path);
        break;
      }
    }
  }

  const definitionChanges = changes
    .filter((change) => surface.definitionPaths.some((definitionPath) => matchesSurfacePath(change.path, definitionPath)))
    .map((change) => `${change.status} ${change.path}`);

  return { mutations, additions: [...new Set(additions)].sort(), definitionChanges: [...new Set(definitionChanges)].sort() };
}

/** Every surface path, for the contract's forbidden list and the worker prompt. */
export function surfacePaths(surface: AcceptanceSurface): string[] {
  const all = new Set<string>(surface.definitionPaths);
  for (const paths of surface.byCriterion.values()) for (const value of paths) all.add(value);
  return [...all].sort();
}
