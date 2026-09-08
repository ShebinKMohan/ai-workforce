/**
 * The acceptance surface: which base files a criterion's evidence executes.
 *
 * The check *definition* is pinned to the base revision, but the code it runs
 * comes from the candidate. A worker that rewrites the acceptance suite and
 * then reports a pass has not satisfied the criteria the base defined — it has
 * replaced them. Finding that surface is how the run tells the two apart.
 *
 * Path names alone cannot answer the question. A criterion executes an entry
 * point *and everything that entry point imports*, so a candidate that leaves
 * the suite file untouched and guts a helper module it imports makes the suite
 * pass vacuously — the third variant of the same false-completion hole. So the
 * surface is resolved by following the module graph from the entry points, at
 * the BASE revision, and the closure is what the criterion actually executes.
 *
 * The closure has two tiers, and the distinction is the honest one:
 *
 *   - `suite`: files that JUDGE the candidate — the entry points, files under
 *     conventional fixture paths, files inside the suite's own directory, and
 *     files whose name says test support. Rewriting one of these replaces the
 *     criterion, so they are forbidden to the worker and a change to one
 *     compromises the criterion.
 *   - `dependency`: everything else the closure reaches — including the code
 *     under test. Changing this code is the *task*, so it can never be
 *     forbidden: a criterion whose suite imports `src/pagination.js` must
 *     still let a worker fix `src/pagination.js`.
 *
 * Static analysis cannot tell "the helper the suite asserts *with*" from "the
 * module the suite asserts *about*" — both are simply modules the suite
 * imports. Where the evidence is positive (the file lives in the suite's own
 * directory, or is named like test support), the file is protected. Where it
 * is not, the file stays writable and every change to it is *recorded* in the
 * surface findings, so a reader sees what the criterion executed and what the
 * candidate touched instead of a silent gap. Whatever the walk could not
 * follow — a computed specifier, a shell script that execs something else, a
 * traversal that hit its cap — is reported for the same reason: a partial
 * surface must say it is partial, because that is the difference between
 * "protected" and "we did not look".
 *
 * This lives beside the check runner rather than inside the orchestrator so
 * that BOTH acceptance decisions use it: the per-task one in `runDirect` and
 * the combined one in `combineArtifacts`.
 */
import path from 'node:path';
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

/**
 * Reached modules whose own name says "test support" rather than "product
 * code". Narrow on purpose: a false positive here forbids a file the worker
 * may legitimately need to change, so this list holds only names that would be
 * surprising on an application module.
 */
const TEST_SUPPORT_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)(harness|testing|test-support|test_support|test-utils|test_utils|testutils|testlib|__mocks__)(\/|$)/,
  /(^|\/)(assert|expect|conftest|test-helpers?|test_helpers?|test-support|test_support)[^/]*\.[^/]+$/,
];

/**
 * Directory names that hold the code under test in the overwhelming majority
 * of repositories. A check that executes a file inside one of these does not
 * make its siblings part of the acceptance suite — protecting them would
 * forbid exactly the files a bug fix has to touch.
 */
const SOURCE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'src',
  'lib',
  'libs',
  'app',
  'apps',
  'source',
  'sources',
  'pkg',
  'packages',
  'internal',
  'cmd',
  'server',
  'client',
  'main',
]);

/** Package managers that read `package.json` to decide what the check actually runs. */
const PACKAGE_MANAGER_COMMANDS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

/** Shell operators that separate one command from the next inside a script body. */
const SCRIPT_SEPARATORS = /(?:&&|\|\||[;|&\n])/;

/** How deep `npm run a` -> `npm run b` -> ... is followed before giving up. */
const MAX_SCRIPT_DEPTH = 4;

/** Caps on the module walk. Hitting one makes the surface partial, and it says so. */
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_DEPTH = 24;
/** A file larger than this is not scanned for imports; the walk records that it skipped it. */
const MAX_FILE_BYTES = 512 * 1024;
/** How many distinct "could not resolve" facts are reported before the list is summarized. */
const MAX_REPORTED_UNRESOLVED = 20;
/** How many files one directory entry point contributes before the walk calls itself partial. */
const MAX_DIRECTORY_ENTRIES = 200;

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const JS_RESOLUTION_EXTENSIONS = [...JS_EXTENSIONS, '.json'] as const;

type ModuleLanguage = 'javascript' | 'python';

export type SurfaceTier = 'suite' | 'dependency';

/** What the walk managed to resolve, and what it did not. */
export interface SurfaceResolution {
  /** True when the import graph was followed. False means path patterns and literal command paths only. */
  readonly moduleGraphResolved: boolean;
  /** The files and directories the walk started from. */
  readonly entryPoints: ReadonlyArray<string>;
  /** How many files the walk read. */
  readonly filesVisited: number;
  /** True when a cap was hit: the surface below is PARTIAL, not a complete answer. */
  readonly truncated: boolean;
  /** Everything the walk could not settle statically, in the words a reader needs. */
  readonly unresolved: ReadonlyArray<string>;
}

export interface AcceptanceSurface {
  /**
   * Criterion id (or `*` for every criterion) to the base paths its evidence
   * executes *and* that the candidate must not rewrite — the suite tier.
   */
  readonly byCriterion: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * Criterion id to the base paths its evidence executes that are NOT
   * protected: the code under test and anything else the closure reached
   * without positive evidence that it judges rather than is judged. Recorded
   * so a change to one is visible, never forbidden.
   */
  readonly dependenciesByCriterion: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Base paths that define acceptance without being executed by it. */
  readonly definitionPaths: ReadonlyArray<string>;
  /** How the surface above was arrived at, including what could not be resolved. */
  readonly resolution: SurfaceResolution;
}

/** Repository facts the surface needs beyond the file list. */
export interface SurfaceContext {
  /** `package.json` as it reads at the BASE revision, when the repository has one. */
  readonly packageManifest?: string | null;
}

/** `SurfaceContext` plus the reader that makes following the module graph possible. */
export interface SurfaceSources extends SurfaceContext {
  /**
   * Read one repository-relative path as it reads at the BASE revision; null
   * when it does not exist or cannot be read. Without it the module graph is
   * not followed and the surface says so.
   */
  readonly readBaseFile?: (relativePath: string) => Promise<string | null>;
  /** Walk caps, for callers (and tests) that need something other than the defaults. */
  readonly limits?: { readonly maxFiles?: number; readonly maxDepth?: number };
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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface CriterionEntries {
  readonly criterionId: string;
  /** Paths the command names outright: the acceptance runner itself. */
  readonly explicit: ReadonlyArray<string>;
  /** Paths that belong to the surface without being a module entry (`package.json`, the check's cwd). */
  readonly implicit: ReadonlyArray<string>;
}

function entriesForCheck(check: CheckSpec, baseFiles: ReadonlyArray<string>, scripts: ReadonlyMap<string, string>): CriterionEntries {
  const explicit = new Set<string>();
  const implicit = new Set<string>();

  for (const token of check.args ?? []) {
    if (token.startsWith('-')) continue;
    const relative = normalizeRelative(token);
    if (relative === null) continue;
    if (existsInTree(baseFiles, relative)) explicit.add(relative);
  }
  if (check.cwd !== undefined) {
    // Where the command runs, not what it runs: part of the surface as it has
    // always been, but never expanded into module entry points — a `cwd` of
    // `packages/app` would drag the whole package in as acceptance code.
    const relative = normalizeRelative(check.cwd);
    if (relative !== null && existsInTree(baseFiles, relative)) implicit.add(relative);
  }
  if (PACKAGE_MANAGER_COMMANDS.has(check.command) && baseFiles.includes('package.json')) {
    implicit.add('package.json');
    const scriptName = scriptNameOf(check.command, check.args ?? []);
    if (scriptName !== null) {
      for (const value of pathsFromScript(scriptName, scripts, baseFiles, new Set(), 0)) explicit.add(value);
    }
  }

  return { criterionId: check.criterionId, explicit: [...explicit], implicit: [...implicit] };
}

/** Files that match a conventional fixture path — the shared `*` entry points. */
function sharedFixtureFiles(baseFiles: ReadonlyArray<string>): string[] {
  return [...new Set(baseFiles.filter((file) => FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(file))))].sort();
}

// ---------------------------------------------------------------------------
// The module graph
// ---------------------------------------------------------------------------

function languageOf(file: string): ModuleLanguage | null {
  const extension = path.posix.extname(file).toLowerCase();
  if ((JS_EXTENSIONS as ReadonlyArray<string>).includes(extension)) return 'javascript';
  if (extension === '.py') return 'python';
  return null;
}

/**
 * Drop comments before scanning for imports, so a commented-out import does
 * not enlarge the surface. Deliberately crude: block comments non-greedily,
 * and only whole lines that begin with `//`, which cannot swallow a URL
 * inside a string literal.
 */
function stripComments(source: string, language: ModuleLanguage): string {
  if (language === 'python') {
    return source
      .split('\n')
      .map((line) => (line.trimStart().startsWith('#') ? '' : line))
      .join('\n');
  }
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

interface Specifier {
  /** The literal specifier, or the source text of the expression that replaced it. */
  readonly text: string;
  readonly literal: boolean;
}

/** Static and literal-dynamic module specifiers in a JavaScript or TypeScript source. */
function javascriptSpecifiers(source: string): Specifier[] {
  const found: Specifier[] = [];
  const add = (text: string, literal: boolean): void => {
    found.push({ text, literal });
  };

  // `import ... from 'x'`, `export ... from 'x'`. The middle is a negated
  // class, so it crosses newlines (multi-line binding lists) but stops at the
  // first `;` or quote and cannot run away over the rest of the file.
  for (const match of source.matchAll(/(?:^|[^.\w$])(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"\n]*)['"]/g)) add(match[1] ?? '', true);
  // Side-effect import: `import 'x'`.
  for (const match of source.matchAll(/(?:^|[^.\w$])import\s*['"]([^'"\n]*)['"]/g)) add(match[1] ?? '', true);
  // Dynamic import and require with a literal argument.
  for (const match of source.matchAll(/(?:^|[^.\w$])(?:import|require)\s*\(\s*['"]([^'"\n]*)['"]\s*\)/g)) add(match[1] ?? '', true);
  // ... and the same two with anything else inside: what they load is not static.
  for (const match of source.matchAll(/(?:^|[^.\w$])(import|require)\s*\(\s*(?!['"])([^)\n]{1,120})\)/g)) {
    add(`${match[1] ?? 'import'}(${(match[2] ?? '').trim()})`, false);
  }
  return found;
}

interface PythonImport {
  /** Leading dots for a relative import; 0 for an absolute one. */
  readonly level: number;
  /** Dotted module path, possibly empty for `from . import x`. */
  readonly module: string;
  /** Names the statement imported, which may themselves be submodules. */
  readonly names: ReadonlyArray<string>;
}

function pythonImports(source: string): PythonImport[] {
  const found: PythonImport[] = [];
  for (const match of source.matchAll(/^[ \t]*from[ \t]+(\.*)([A-Za-z0-9_.]*)[ \t]+import[ \t]+(.+)$/gm)) {
    const names = (match[3] ?? '')
      .replace(/[()\\]/g, ' ')
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((name) => name.length > 0 && name !== '*');
    found.push({ level: (match[1] ?? '').length, module: match[2] ?? '', names });
  }
  for (const match of source.matchAll(/^[ \t]*import[ \t]+([A-Za-z0-9_.]+(?:[ \t]*,[ \t]*[A-Za-z0-9_.]+)*)/gm)) {
    for (const module of (match[1] ?? '').split(',')) {
      const trimmed = module.trim();
      if (trimmed.length > 0) found.push({ level: 0, module: trimmed, names: [] });
    }
  }
  return found;
}

function firstExisting(candidates: ReadonlyArray<string>, baseFileSet: ReadonlySet<string>): string | null {
  for (const candidate of candidates) {
    if (candidate.length > 0 && !candidate.startsWith('..') && baseFileSet.has(candidate)) return candidate;
  }
  return null;
}

/** Node/TypeScript resolution, restricted to files that exist at the base revision. */
function resolveJavascript(specifier: string, fromFile: string, baseFileSet: ReadonlySet<string>): string | null {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates: string[] = [joined];
  // TypeScript ESM writes `./x.js` for a file that is `./x.ts` on disk.
  const extension = path.posix.extname(joined);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const stem = joined.slice(0, joined.length - extension.length);
    for (const replacement of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(`${stem}${replacement}`);
  }
  for (const suffix of JS_RESOLUTION_EXTENSIONS) candidates.push(`${joined}${suffix}`);
  for (const suffix of JS_RESOLUTION_EXTENSIONS) candidates.push(`${joined}/index${suffix}`);
  return firstExisting(candidates, baseFileSet);
}

/** Python resolution against the repository tree; anything outside it is a third-party or stdlib import. */
function resolvePython(entry: PythonImport, fromFile: string, baseFileSet: ReadonlySet<string>): string[] {
  let base: string;
  if (entry.level > 0) {
    base = path.posix.dirname(fromFile);
    for (let step = 1; step < entry.level; step += 1) base = path.posix.dirname(base);
    if (base === '.') base = '';
  } else {
    base = '';
  }
  const segments = entry.module.length > 0 ? entry.module.split('.').filter((part) => part.length > 0) : [];
  const modulePath = [base, ...segments].filter((part) => part.length > 0).join('/');
  const resolved: string[] = [];

  const module = firstExisting(modulePath.length > 0 ? [`${modulePath}.py`, `${modulePath}/__init__.py`] : [], baseFileSet);
  if (module !== null) {
    resolved.push(module);
    // Importing `a.b` executes `a/__init__.py` before `a/b.py`, so the package
    // initializers on the way down are executed by the criterion too.
    const parts = modulePath.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const initializer = firstExisting([`${parts.slice(0, depth).join('/')}/__init__.py`], baseFileSet);
      if (initializer !== null) resolved.push(initializer);
    }
  }
  // `from pkg import mod` and `from . import mod`: the imported names may be
  // modules of the package rather than objects inside it.
  for (const name of entry.names) {
    const nested = firstExisting(
      [`${[modulePath, name].filter((part) => part.length > 0).join('/')}.py`, `${[modulePath, name].filter((part) => part.length > 0).join('/')}/__init__.py`],
      baseFileSet,
    );
    if (nested !== null) resolved.push(nested);
  }
  if (entry.level > 0 && modulePath.length === 0) {
    const packageInit = firstExisting([`${path.posix.dirname(fromFile)}/__init__.py`], baseFileSet);
    if (packageInit !== null) resolved.push(packageInit);
  }
  return resolved;
}

interface WalkState {
  filesVisited: number;
  truncated: boolean;
  readonly unresolved: Set<string>;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly baseFileSet: ReadonlySet<string>;
  readonly cache: Map<string, string | null>;
  readonly read: (relativePath: string) => Promise<string | null>;
}

function note(state: WalkState, text: string): void {
  if (state.unresolved.size >= MAX_REPORTED_UNRESOLVED) {
    state.unresolved.add(`(further unresolved references were not listed; the first ${MAX_REPORTED_UNRESOLVED} are above)`);
    return;
  }
  state.unresolved.add(text);
}

async function readOnce(state: WalkState, file: string): Promise<string | null> {
  if (state.cache.has(file)) return state.cache.get(file) ?? null;
  let source: string | null = null;
  try {
    source = await state.read(file);
  } catch {
    source = null;
  }
  state.cache.set(file, source);
  return source;
}

/**
 * Every first-party file reachable from `entries` by static import, at the
 * base revision. Bare specifiers are ignored: `node_modules` is not candidate
 * writable, so a package cannot be the thing a candidate guts.
 */
async function reachableFrom(entries: ReadonlyArray<string>, state: WalkState, declared: ReadonlySet<string>): Promise<Set<string>> {
  const reached = new Set<string>();
  const seen = new Set<string>(entries);
  let frontier: Array<{ file: string; depth: number }> = entries.map((file) => ({ file, depth: 0 }));

  while (frontier.length > 0) {
    const next: Array<{ file: string; depth: number }> = [];
    for (const { file, depth } of frontier) {
      reached.add(file);
      const language = languageOf(file);
      if (language === null) {
        // Only worth reporting for a file a check *names*: `bash
        // scripts/check.sh` executes something this walk cannot see. A data
        // file that happens to sit under `tests/` is not a gap in the surface.
        if (declared.has(file)) {
          note(state, `${file} is executed by a criterion but is not a JavaScript, TypeScript or Python module, so what it runs was not followed`);
        }
        continue;
      }
      if (depth >= state.maxDepth) {
        state.truncated = true;
        note(state, `the import walk stopped at ${file}: depth cap ${state.maxDepth} reached, so its own imports are NOT part of this surface`);
        continue;
      }
      if (state.filesVisited >= state.maxFiles) {
        state.truncated = true;
        note(state, `the import walk stopped after ${state.maxFiles} files; files beyond that cap are NOT part of this surface`);
        return reached;
      }
      state.filesVisited += 1;
      const raw = await readOnce(state, file);
      if (raw === null) {
        note(state, `${file} could not be read at the base revision, so its imports were not followed`);
        continue;
      }
      if (raw.length > MAX_FILE_BYTES) {
        state.truncated = true;
        note(state, `${file} is larger than ${MAX_FILE_BYTES} bytes and was not scanned for imports`);
        continue;
      }
      const source = stripComments(raw, language);

      const targets: string[] = [];
      if (language === 'javascript') {
        for (const specifier of javascriptSpecifiers(source)) {
          if (!specifier.literal) {
            note(state, `${file} loads a computed specifier (${specifier.text}); what it executes was not resolved`);
            continue;
          }
          const text = specifier.text;
          if (text.length === 0) continue;
          if (/^(?:node|data|bun|file|https?):/.test(text)) continue;
          if (text.startsWith('/')) {
            note(state, `${file} imports the absolute path "${text}", which is outside the repository tree and was not resolved`);
            continue;
          }
          if (!text.startsWith('.')) continue; // a package: not candidate-writable
          const resolved = resolveJavascript(text, file, state.baseFileSet);
          if (resolved === null) {
            note(state, `${file} imports "${text}", which does not resolve to a file in the base revision`);
            continue;
          }
          targets.push(resolved);
        }
      } else {
        for (const entry of pythonImports(source)) {
          const resolved = resolvePython(entry, file, state.baseFileSet);
          if (resolved.length === 0 && entry.level > 0) {
            note(state, `${file} imports "${'.'.repeat(entry.level)}${entry.module}", which does not resolve to a module in the base revision`);
            continue;
          }
          targets.push(...resolved);
        }
      }

      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        next.push({ file: target, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return reached;
}

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

/**
 * Directories that hold an acceptance suite rather than the code under test.
 *
 * Derived only from paths a check *names* — the acceptance runner itself —
 * never from files that merely match a fixture pattern: a repository with
 * `src/foo.test.js` beside `src/foo.js` would otherwise have its whole source
 * directory declared off limits.
 */
function suiteDirectoriesOf(explicitEntries: ReadonlyArray<string>, baseFileSet: ReadonlySet<string>): string[] {
  const directories = new Set<string>();
  for (const entry of explicitEntries) {
    const directory = baseFileSet.has(entry) ? path.posix.dirname(entry) : entry;
    if (directory === '.' || directory === '' || directory === '/') continue;
    if (SOURCE_DIRECTORY_NAMES.has(path.posix.basename(directory))) continue;
    directories.add(directory);
  }
  return [...directories];
}

function isUnder(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`);
}

function tierOf(file: string, entrySet: ReadonlySet<string>, suiteDirectories: ReadonlyArray<string>): SurfaceTier {
  if (entrySet.has(file)) return 'suite';
  if (FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(file))) return 'suite';
  if (TEST_SUPPORT_PATTERNS.some((pattern) => pattern.test(file))) return 'suite';
  if (suiteDirectories.some((directory) => isUnder(file, directory))) return 'suite';
  return 'dependency';
}

/** The module files a set of entry paths stands for; a directory contributes the files under it. */
function entryFilesOf(entries: ReadonlyArray<string>, baseFiles: ReadonlyArray<string>, state: WalkState): string[] {
  const files = new Set<string>();
  for (const entry of entries) {
    if (state.baseFileSet.has(entry)) {
      files.add(entry);
      continue;
    }
    const contained = baseFiles.filter((file) => file.startsWith(`${entry}/`) && languageOf(file) !== null);
    if (contained.length > MAX_DIRECTORY_ENTRIES) {
      state.truncated = true;
      note(state, `${entry} holds ${contained.length} module files; only the first ${MAX_DIRECTORY_ENTRIES} were walked`);
    }
    for (const file of contained.slice(0, MAX_DIRECTORY_ENTRIES)) files.add(file);
  }
  return [...files];
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

function assemble(
  entries: ReadonlyArray<CriterionEntries>,
  shared: ReadonlyArray<string>,
  reachedByCriterion: ReadonlyMap<string, { suite: ReadonlyArray<string>; dependencies: ReadonlyArray<string> }>,
  definitionPaths: ReadonlyArray<string>,
  resolution: SurfaceResolution,
): AcceptanceSurface {
  const byCriterion = new Map<string, ReadonlyArray<string>>();
  const dependenciesByCriterion = new Map<string, ReadonlyArray<string>>();

  const put = (id: string, direct: ReadonlyArray<string>): void => {
    const reached = reachedByCriterion.get(id);
    const suite = new Set<string>([...direct, ...(reached?.suite ?? [])]);
    if (suite.size > 0) byCriterion.set(id, [...suite].sort());
    const dependencies = (reached?.dependencies ?? []).filter((file) => !suite.has(file));
    if (dependencies.length > 0) dependenciesByCriterion.set(id, [...new Set(dependencies)].sort());
  };

  if (shared.length > 0 || (reachedByCriterion.get('*')?.dependencies.length ?? 0) > 0) put('*', shared);
  for (const entry of entries) {
    const direct = [...entry.explicit, ...entry.implicit];
    if (direct.length === 0 && (reachedByCriterion.get(entry.criterionId)?.dependencies.length ?? 0) === 0) continue;
    put(entry.criterionId, direct);
  }

  return { byCriterion, dependenciesByCriterion, definitionPaths, resolution };
}

function definitionPathsOf(baseFiles: ReadonlyArray<string>): string[] {
  return baseFiles.includes('.workforce/checks.json') ? ['.workforce/checks.json'] : [];
}

/**
 * Work out which base files each criterion's evidence actually executes, by
 * following the module graph from the entry points.
 *
 * Entry points, all of them conservative (a path is only an entry when it
 * exists at the base):
 *   1. paths that look like fixtures anywhere in the tree (`*`);
 *   2. literal path arguments of the check command;
 *   3. for a package-manager command, the paths named by the `package.json`
 *      script it runs, followed through `npm run` chains.
 *
 * From there every first-party file reachable by a static import joins the
 * closure, split into the tier that judges the candidate (protected) and the
 * tier the candidate is expected to change (recorded). Whatever could not be
 * followed is reported in `resolution.unresolved`.
 */
export async function resolveAcceptanceSurface(
  checks: ReadonlyArray<CheckSpec>,
  baseFiles: ReadonlyArray<string>,
  context: SurfaceSources = {},
): Promise<AcceptanceSurface> {
  const scripts = parseScripts(context.packageManifest);
  const shared = sharedFixtureFiles(baseFiles);
  const entries = checks.map((check) => entriesForCheck(check, baseFiles, scripts));

  if (context.readBaseFile === undefined) {
    return assemble(entries, shared, new Map(), definitionPathsOf(baseFiles), {
      moduleGraphResolved: false,
      entryPoints: [...new Set([...shared, ...entries.flatMap((entry) => entry.explicit)])].sort(),
      filesVisited: 0,
      truncated: true,
      unresolved: [
        'the acceptance surface was resolved from path patterns and command arguments only: no reader for the base revision was supplied, so the modules those files import are NOT covered',
      ],
    });
  }

  const state: WalkState = {
    filesVisited: 0,
    truncated: false,
    unresolved: new Set<string>(),
    maxFiles: context.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: context.limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
    baseFileSet: new Set(baseFiles),
    cache: new Map<string, string | null>(),
    read: context.readBaseFile,
  };

  const reachedByCriterion = new Map<string, { suite: ReadonlyArray<string>; dependencies: ReadonlyArray<string> }>();
  const allEntryPoints = new Set<string>();

  const walk = async (id: string, entryPaths: ReadonlyArray<string>, suiteDirectories: ReadonlyArray<string>, namedByCheck: boolean): Promise<void> => {
    for (const entry of entryPaths) allEntryPoints.add(entry);
    const entryFiles = entryFilesOf(entryPaths, baseFiles, state);
    if (entryFiles.length === 0) return;
    const entrySet = new Set(entryFiles);
    // Paths the check itself names, as opposed to files found by expanding a
    // directory or matching a fixture pattern.
    const declared = namedByCheck ? new Set(entryPaths.filter((entry) => state.baseFileSet.has(entry))) : new Set<string>();
    const reached = await reachableFrom(entryFiles, state, declared);
    const suite: string[] = [];
    const dependencies: string[] = [];
    for (const file of reached) {
      if (tierOf(file, entrySet, suiteDirectories) === 'suite') suite.push(file);
      else dependencies.push(file);
    }
    reachedByCriterion.set(id, { suite: suite.sort(), dependencies: dependencies.sort() });
  };

  // The conventional fixtures are entry points for every criterion, so their
  // closure is shared too.
  await walk('*', shared, [], false);
  for (const entry of entries) {
    await walk(entry.criterionId, entry.explicit, suiteDirectoriesOf(entry.explicit, state.baseFileSet), true);
  }

  return assemble(entries, shared, reachedByCriterion, definitionPathsOf(baseFiles), {
    moduleGraphResolved: true,
    entryPoints: [...allEntryPoints].sort(),
    filesVisited: state.filesVisited,
    truncated: state.truncated,
    unresolved: [...state.unresolved].sort(),
  });
}

/**
 * The path-pattern-only surface, for callers that cannot read the base
 * revision. It resolves the same entry points but follows nothing, and its
 * `resolution` says so — an unfollowed graph is a partial answer, not a clean
 * one.
 */
export function acceptanceSurface(checks: ReadonlyArray<CheckSpec>, baseFiles: ReadonlyArray<string>, context: SurfaceContext = {}): AcceptanceSurface {
  const scripts = parseScripts(context.packageManifest);
  const shared = sharedFixtureFiles(baseFiles);
  const entries = checks.map((check) => entriesForCheck(check, baseFiles, scripts));
  return assemble(entries, shared, new Map(), definitionPathsOf(baseFiles), {
    moduleGraphResolved: false,
    entryPoints: [...new Set([...shared, ...entries.flatMap((entry) => entry.explicit)])].sort(),
    filesVisited: 0,
    truncated: true,
    unresolved: [
      'the acceptance surface was resolved from path patterns and command arguments only: this caller did not follow the module graph, so the modules those files import are NOT covered',
    ],
  });
}

function matchesSurfacePath(changedPath: string, surfacePath: string): boolean {
  return changedPath === surfacePath || changedPath.startsWith(`${surfacePath}/`);
}

export interface SurfaceFindings {
  /** Criteria whose executed fixtures the candidate modified or deleted. */
  readonly mutations: ReadonlyArray<FixtureMutation>;
  /**
   * Criteria whose executed *dependencies* the candidate modified or deleted.
   * The code under test lives here, so this is a fact to record rather than a
   * reason to refuse: a bug fix is exactly a change to code the criterion runs.
   */
  readonly dependencyChanges: ReadonlyArray<FixtureMutation>;
  /** Files the candidate added inside an acceptance surface: recorded, not blocking. */
  readonly additions: ReadonlyArray<string>;
  /** Acceptance definitions the candidate changed. They cannot affect this run, which read them from the base. */
  readonly definitionChanges: ReadonlyArray<string>;
}

function changesAgainst(
  paths: ReadonlyMap<string, ReadonlyArray<string>>,
  changes: ReadonlyArray<{ status: string; path: string }>,
  excluded: ReadonlyArray<string>,
): FixtureMutation[] {
  const mutations: FixtureMutation[] = [];
  for (const [criterionId, surfaceForCriterion] of paths) {
    const changed = changes
      .filter(
        (change) =>
          !change.status.startsWith('A') &&
          surfaceForCriterion.some((surfacePath) => matchesSurfacePath(change.path, surfacePath)) &&
          !excluded.some((surfacePath) => matchesSurfacePath(change.path, surfacePath)),
      )
      .map((change) => `${change.status} ${change.path}`);
    if (changed.length > 0) mutations.push({ criterionId, changedPaths: [...new Set(changed)].sort() });
  }
  return mutations;
}

/**
 * Compare a candidate diff against the acceptance surface.
 *
 * Modifying or deleting a file a criterion executes *and* that judges the
 * candidate compromises that criterion's evidence. *Adding* a file does not:
 * writing a new test to protect the fix is exactly what a worker should be
 * able to do, so it is recorded and left alone. A change to a dependency the
 * criterion executes is recorded separately — it is usually the fix itself.
 */
export function findSurfaceChanges(surface: AcceptanceSurface, changes: ReadonlyArray<{ status: string; path: string }>): SurfaceFindings {
  const mutations = changesAgainst(surface.byCriterion, changes, []);
  // A path that is protected for one criterion is not "just a dependency"
  // because another criterion reaches it without protection.
  const protectedPaths = surfacePaths(surface);
  const dependencyChanges = changesAgainst(surface.dependenciesByCriterion, changes, protectedPaths);

  const additions: string[] = [];
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

  return {
    mutations,
    dependencyChanges,
    additions: [...new Set(additions)].sort(),
    definitionChanges: [...new Set(definitionChanges)].sort(),
  };
}

/** Every surface path, for the contract's forbidden list and the worker prompt. */
export function surfacePaths(surface: AcceptanceSurface): string[] {
  const all = new Set<string>(surface.definitionPaths);
  for (const paths of surface.byCriterion.values()) for (const value of paths) all.add(value);
  return [...all].sort();
}

/** Every base file a criterion executes without the surface protecting it. */
export function surfaceDependencyPaths(surface: AcceptanceSurface): string[] {
  const all = new Set<string>();
  for (const paths of surface.dependenciesByCriterion.values()) for (const value of paths) all.add(value);
  return [...all].sort();
}
