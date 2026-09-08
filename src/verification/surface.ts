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
 * And saying it is not enough. A criterion whose surface is partial is a
 * criterion this run cannot vouch for: the check may exit 0 over exactly the
 * files the walk never reached, which is the original false-completion defect
 * wearing the walk's own clothes. So every gap is attributed to the criterion
 * whose walk produced it and handed to the acceptance decision as a blocker by
 * `surfaceBlockers` — an unresolved surface REFUSES, in the same class as a
 * compromised one, rather than passing. `resolution.gaps` is that list, and it
 * is the reason the walk works as hard as it does to leave the list empty:
 * a shell entry point is followed to the runner it execs, a symlink is
 * followed to its real target, and a computed specifier with a literal
 * directory prefix pulls that whole directory in rather than giving up.
 *
 * Two things are deliberately NOT gaps, because a refusal there is an outage
 * rather than a safety property, and a product that refuses correct runs on
 * ordinary repositories is not usable:
 *
 *   - A language this walk has no reader for. It reads JavaScript, TypeScript
 *     and Python; a repository in Go, Rust, C, Ruby or Swift has no import
 *     graph here to follow, and that is a fact about the walk, not evidence
 *     that the criterion is unsound. Such a criterion gets a CONSERVATIVE
 *     surface — its entry points, the paths its check names, conventional
 *     fixture paths — and a `resolution.limitations` entry that says the
 *     closure was not proven, on the terminal and in the manifest. Listing the
 *     criterion's `fixtures` in `.workforce/checks.json` declares the closure
 *     and upgrades the run to an established surface.
 *   - A cap. A truncated analysis that announces itself is more useful than a
 *     run that cannot happen, so a cap is a limitation too.
 *
 * And a gap only ever belongs to a criterion that actually executes the file
 * that produced it. A broken relative import in a fixture no check runs is
 * recorded and nothing more; it used to refuse every criterion in the
 * repository.
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
  /(^|\/)(tests?|Tests?|spec|specs|__tests__|testdata)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/,
  // The same convention in the languages the module walk cannot read. Where
  // no import graph can be followed, a file whose NAME says "test" is the only
  // evidence there is, and it is strong evidence: `_test.go` and `_spec.rb`
  // are as load-bearing in their ecosystems as `.test.js` is here.
  /(^|\/)[^/]*_test\.(go|rb|exs?|cc|cpp|cxx|c|swift|rs|java|kt)$/,
  /(^|\/)[^/]*_spec\.(rb|exs?)$/,
  /(^|\/)[^/]*Tests?\.(swift|java|kt|cs)$/,
  /(^|\/)[^/]*Test\.php$/,
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

/** Words that stand in front of the command that actually runs, inside a script. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set(['exec', 'command', 'time', 'env', 'nice', 'nohup', 'builtin', 'source', '.']);

/** Extensions that say "shell script"; the empty one covers `verify/check` with a shebang. */
const SHELL_EXTENSIONS: ReadonlySet<string> = new Set(['', '.sh', '.bash', '.zsh', '.ksh', '.command']);

/** A script body larger than this is not scanned for the runner it execs. */
const MAX_SCRIPT_BYTES = 256 * 1024;

/** How deep `npm run a` -> `npm run b` -> ... is followed before giving up. */
const MAX_SCRIPT_DEPTH = 4;

/**
 * Caps on the module walk. Hitting one makes the surface partial, and it says
 * so — as a LIMITATION rather than a gap, because a truncated analysis that
 * announces itself is more useful than a run that cannot happen at all.
 *
 * The numbers are set where a real repository will not reach them. The old
 * ones (400 files in a closure, 200 module files under a named directory) are
 * ordinary sizes for an application's test tree, so they refused correct runs
 * on nothing worse than the repository being of normal size. A cap exists here
 * to stop a pathological walk, not to express an opinion about project layout.
 */
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 128;
/** A file larger than this is not scanned for imports; the walk records that it skipped it. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** How many distinct "could not resolve" facts are reported before the list is summarized. */
const MAX_REPORTED_UNRESOLVED = 20;
/** How many files one directory entry point contributes before the walk calls itself partial. */
const MAX_DIRECTORY_ENTRIES = 5_000;

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const JS_RESOLUTION_EXTENSIONS = [...JS_EXTENSIONS, '.json'] as const;

type ModuleLanguage = 'javascript' | 'python';

export type SurfaceTier = 'suite' | 'dependency';

/**
 * What kind of thing the walk could not settle. The kind decides which remedy
 * is offered, because a remedy that does not actually close the gap is worse
 * than none: it would send an operator to change something and leave the run
 * refusing for the same reason.
 */
export type SurfaceGapKind =
  /** The criterion runs a file this walk cannot read as a module and could not follow. */
  | 'entry_not_module'
  /** A module reference computed at runtime: what it loads is not knowable statically. */
  | 'computed_specifier'
  /** A literal import that names nothing in the base revision. */
  | 'unresolved_import'
  /** A file the base-revision reader did not return. */
  | 'unreadable'
  /** A cap: depth, file count, file size, or directory size. */
  | 'truncated'
  /** A path named in the check's own `fixtures` list that the base revision does not contain. */
  | 'declared_fixture_missing'
  /** The caller followed no module graph at all. */
  | 'no_reader';

/**
 * Why a surface is CONSERVATIVE rather than established.
 *
 * A limitation is not a gap. A gap says "this criterion's evidence could have
 * exited 0 over exactly the part we never resolved", and refuses. A limitation
 * says "there is no dependency analysis to run here at all" — the walk reads
 * JavaScript, TypeScript and Python and nothing else — and a repository
 * written in Go, Rust, C, Ruby or Swift is not thereby unverifiable. Refusing
 * those runs is not a safety property, it is an outage, so they proceed with a
 * surface built from what can be identified without parsing (the entry points,
 * the paths the check names, conventional fixture paths) and with the residual
 * risk stated plainly: the closure was NOT proven, so a candidate could gut a
 * helper this walk cannot see. Naming the criterion's fixtures explicitly in
 * `.workforce/checks.json` closes it and upgrades the run.
 */
export type SurfaceLimitationKind =
  /** The criterion's entry points are in a language this walk has no reader for. */
  | 'language_unsupported'
  /** The criterion runs an external toolchain (`go test`, `cargo test`, `make`) rather than a module of this repository. */
  | 'external_toolchain'
  /** A cap was reached, so the closure below is a prefix of the real one. */
  | 'analysis_truncated'
  /** Something the shared fixture walk could not settle in a file no criterion's evidence executes. */
  | 'unexecuted_fixture';

/**
 * One reason a criterion's surface rests on declared paths rather than on a
 * followed graph, and the criterion it applies to. `*` means it applies to the
 * shared fixture closure.
 */
export interface SurfaceLimitation {
  readonly criterionId: string;
  readonly kind: SurfaceLimitationKind;
  /** What could not be analysed, and what is protected instead, in the words a reader needs. */
  readonly detail: string;
}

/**
 * One thing the walk could not settle, and the criterion it belongs to.
 *
 * The criterion matters because the gap is not a property of the repository —
 * it is a property of what a *particular* criterion executes, and it is that
 * criterion the run must refuse to call established. `*` means the gap is in
 * the shared fixture closure and therefore affects every criterion.
 */
export interface SurfaceGap {
  readonly criterionId: string;
  readonly kind: SurfaceGapKind;
  /** What could not be resolved, in the words a reader needs. */
  readonly detail: string;
}

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
  /** Everything the walk could not settle statically — gaps and limitations both — in the words a reader needs. */
  readonly unresolved: ReadonlyArray<string>;
  /**
   * The facts that make a criterion's evidence unusable, each bound to the
   * criterion whose surface they leave incomplete. `surfaceBlockers` turns
   * these into the reasons acceptance is refused; an empty list is the only
   * state in which a pass over a fully analysed closure can be trusted.
   */
  readonly gaps: ReadonlyArray<SurfaceGap>;
  /**
   * The facts that make a criterion's surface conservative rather than
   * unusable: analysis this walk cannot perform, stated rather than refused.
   * These do NOT block acceptance; they are printed and recorded so the
   * operator knows the closure was not proven.
   */
  readonly limitations: ReadonlyArray<SurfaceLimitation>;
  /** True when any limitation applies: at least one criterion's closure was not proven. */
  readonly conservative: boolean;
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
  /**
   * The subset of `explicit` the candidate must not rewrite.
   *
   * A named path is an entry point of the walk and, usually, a protected path
   * too. A named DIRECTORY is where the two roles come apart: `node --test
   * test/` names a directory that is entirely acceptance material, while
   * `go test ./internal/billing` names one holding the suite AND the code
   * under test in the same folder. Protecting the second wholesale forbids
   * exactly the file the task exists to change, which turns a conservative
   * surface back into a wall. So a directory that does not itself read as a
   * fixture path is protected through the test-named files inside it, and only
   * falls back to the whole directory when it holds none.
   */
  readonly protectedPaths: ReadonlyArray<string>;
  /**
   * True when the check's own `fixtures` list named at least one path that
   * exists at the base revision. The operator has then declared what this
   * criterion executes, which is what upgrades a conservative surface to an
   * established one: there is nothing left for the walk to fail to analyse.
   */
  readonly fixturesDeclared: boolean;
  /** Declared fixture paths the base revision does not contain. A typo here must not read as a declaration. */
  readonly missingFixtures: ReadonlyArray<string>;
}

function entriesForCheck(check: CheckSpec, baseFiles: ReadonlyArray<string>, scripts: ReadonlyMap<string, string>): CriterionEntries {
  const explicit = new Set<string>();
  const implicit = new Set<string>();
  const missingFixtures: string[] = [];
  const declaredFixturePaths = new Set<string>();
  let fixturesDeclared = false;

  // Paths the operator declared in `.workforce/checks.json`. They are entry
  // points in every sense the command's own arguments are: walked from, and
  // protected. The command never sees them.
  for (const declared of check.fixtures ?? []) {
    const relative = normalizeRelative(declared);
    if (relative === null || !existsInTree(baseFiles, relative)) {
      missingFixtures.push(declared);
      continue;
    }
    explicit.add(relative);
    declaredFixturePaths.add(relative);
    fixturesDeclared = true;
  }

  // `./verify/check.sh` as the command itself, not as an argument of one. The
  // guard is the same as for arguments: it counts only when a file of that
  // name exists at the base revision, so `node` and `npm` name nothing.
  const asCommand = normalizeRelative(check.command);
  if (asCommand !== null && existsInTree(baseFiles, asCommand)) explicit.add(asCommand);

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

  return {
    criterionId: check.criterionId,
    explicit: [...explicit],
    implicit: [...implicit],
    protectedPaths: protectedPathsOf([...explicit], baseFiles, declaredFixturePaths),
    fixturesDeclared,
    missingFixtures,
  };
}

/**
 * Which of a criterion's named paths the candidate must not rewrite.
 *
 * A named file is always protected. A named directory is protected wholesale
 * when its own path reads as a fixture path (`test/`, `spec/`, `testdata/`),
 * and otherwise only through the files inside it whose names say "test" —
 * because a Go, Ruby or Swift package directory holds the suite and the code
 * under test side by side, and forbidding both leaves no correct candidate.
 * A directory that holds no test-named file at all falls back to the whole
 * directory: there is nothing finer to go on, and saying nothing would protect
 * nothing.
 *
 * A path the operator declared under `fixtures` is exempt: they said what this
 * criterion executes, and the surface does not second-guess them.
 */
function protectedPathsOf(explicit: ReadonlyArray<string>, baseFiles: ReadonlyArray<string>, declaredFixturePaths: ReadonlySet<string>): string[] {
  const baseFileSet = new Set(baseFiles);
  const paths = new Set<string>();
  for (const entry of explicit) {
    if (baseFileSet.has(entry) || declaredFixturePaths.has(entry)) {
      paths.add(entry);
      continue;
    }
    if (FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(`${entry}/`))) {
      paths.add(entry);
      continue;
    }
    const named = baseFiles.filter(
      (file) => file.startsWith(`${entry}/`) && (FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(file)) || TEST_SUPPORT_PATTERNS.some((pattern) => pattern.test(file))),
    );
    if (named.length === 0) paths.add(entry);
    else for (const file of named) paths.add(file);
  }
  return [...paths];
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
 * Characters after which a `/` opens a regular-expression literal rather than
 * dividing. Everything else (an identifier, a digit, a closing bracket) means
 * division, and `a / *b` is not valid JavaScript — so after those a `/*` really
 * is a comment.
 */
const REGEX_LITERAL_PRECEDERS: ReadonlySet<string> = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);

/** Index just past a quoted string that starts at `start`, or the line end when it never closes. */
function skipQuoted(source: string, start: number, quote: string): number {
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    // An unterminated literal is a parse this cannot trust; stopping at the
    // newline resumes at code level rather than swallowing the rest of the file.
    if (ch === '\n') return i;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return source.length;
}

/** Index just past a template literal, following `${...}` through nested quotes and braces. */
function skipTemplate(source: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (depth === 0) {
      if (ch === '`') return i + 1;
      if (ch === '$' && source[i + 1] === '{') {
        depth = 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '"' || ch === "'") i = skipQuoted(source, i, ch) - 1;
    else if (ch === '`') i = skipTemplate(source, i) - 1;
  }
  return source.length;
}

/**
 * Index just past a regular-expression literal, or null when it does not close
 * on its own line — in which case the `/` was something else and the caller
 * falls back to reading it as a comment.
 */
function skipRegexLiteral(source: string, start: number): number | null {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\n') return null;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '/') return i + 1;
  }
  return null;
}

/** Index just past a Python triple-quoted string, or null when it never closes. */
function skipPythonTriple(source: string, start: number, quote: string): number | null {
  const closer = quote.repeat(3);
  for (let i = start + 3; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source.startsWith(closer, i)) return i + 3;
  }
  return null;
}

/**
 * Drop comments before scanning for imports, so a commented-out import does
 * not enlarge the surface — and, far more importantly, so an ordinary string
 * literal is never read as the start of one.
 *
 * A regex over raw source cannot tell the glob in `readdir('cases/*')` from the
 * opening of a block comment. Read as a comment it swallows everything up to
 * the next `*` + `/`, real imports included, and the walk then reports a clean
 * surface for files it never saw. That is a FALSE ACCEPT, not merely a false
 * refusal, so the scan below tracks which state it is in: string, template,
 * regular expression, comment or code.
 *
 * Comment bytes are replaced by spaces of the same length and newlines are
 * kept, so every offset in the result still names the same position in the
 * original — `atCodeLevel` and the line-anchored Python patterns both depend
 * on that. Where the scanner cannot be sure (an unterminated block comment, an
 * unclosed triple quote) it strips NOTHING: over-including a commented import
 * enlarges the surface, which is the safe direction, while over-stripping
 * hides one.
 */
function stripComments(source: string, language: ModuleLanguage): string {
  return language === 'python' ? stripPythonComments(source) : stripJavascriptComments(source);
}

function stripJavascriptComments(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let significant = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      significant = ch;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      significant = ch;
      continue;
    }
    if (ch === '/') {
      const next = source[i + 1];
      if (next === '/') {
        const newline = source.indexOf('\n', i);
        const stop = newline < 0 ? source.length : newline;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (next === '*') {
        const closer = source.indexOf('*/', i + 2);
        if (closer < 0) {
          // Not a comment this scanner can bound. Leave the text alone.
          i += 2;
          continue;
        }
        blank(i, closer + 2);
        i = closer + 2;
        continue;
      }
      if (REGEX_LITERAL_PRECEDERS.has(significant)) {
        const end = skipRegexLiteral(source, i);
        if (end !== null) {
          i = end;
          significant = '/';
          continue;
        }
      }
    }
    if (!/\s/.test(ch)) significant = ch;
    i += 1;
  }
  return out.join('');
}

function stripPythonComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      const newline = source.indexOf('\n', i);
      const stop = newline < 0 ? source.length : newline;
      for (let k = i; k < stop; k += 1) out[k] = ' ';
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (source.startsWith(ch.repeat(3), i)) {
        const end = skipPythonTriple(source, i, ch);
        if (end === null) {
          i += 3;
          continue;
        }
        // A docstring is the one place a multi-line quotation can put
        // `from x import y` at the start of a line, where the line-anchored
        // import patterns would read it as an import the module never makes.
        for (let k = i; k < end; k += 1) if (out[k] !== '\n') out[k] = ' ';
        i = end;
        continue;
      }
      i = skipQuoted(source, i, ch);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

interface Specifier {
  /** The literal specifier, or the source text of the expression that replaced it. */
  readonly text: string;
  readonly literal: boolean;
  /**
   * For a computed specifier, the literal path its expression starts with —
   * the `./cases/` of `` import(`./cases/${name}.js`) ``. What the expression
   * loads is not knowable, but the *directory* it loads it from is, and that
   * directory is what the criterion executes.
   */
  readonly prefix?: string;
}

/**
 * The literal head of a computed specifier expression: a leading quoted string
 * (`'./cases/' + name`) or the fixed part of a template literal
 * (`` `./cases/${name}.js` ``). Null when the expression begins with something
 * this cannot read, which is the honest answer.
 */
function literalPrefixOf(expression: string): string | null {
  const quoted = /^['"]([^'"\n]*)['"]/.exec(expression);
  if (quoted !== null) return quoted[1] ?? null;
  const template = /^`([^`$\n]*)\$\{/.exec(expression);
  if (template !== null) return template[1] ?? null;
  return null;
}

/**
 * Whether an offset sits in code rather than inside a string literal.
 *
 * A repository's own tests quote source as data — `"import { x } from './y.js'"`
 * is a fixture, not an import — and reading those as module references invents
 * files the criterion does not execute *and*, now that a gap refuses, would
 * refuse repositories on the strength of a quotation. The scan is per line and
 * tracks the open quote, so a different quote character nested inside one does
 * not confuse it. Its failure mode is to miss an import written after an odd
 * quote on the same line, which under-detects in the base revision's own
 * formatting rather than over-refusing.
 */
function atCodeLevel(source: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = source.lastIndexOf('\n', index - 1) + 1; i < index; i += 1) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (quote === null) {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    } else if (ch === quote) {
      quote = null;
    }
  }
  return quote === null;
}

/**
 * Where the keyword sits, not where the match starts: each pattern below may
 * consume one character in front of `import`, and that character is often the
 * very quote that opens the string the match is buried in.
 */
function keywordAt(match: RegExpExecArray): number {
  return (match.index ?? 0) + (/\b(?:import|export|require)\b/.exec(match[0])?.index ?? 0);
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
  for (const match of source.matchAll(/(?:^|[^.\w$])(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"\n]*)['"]/g)) {
    if (atCodeLevel(source, keywordAt(match))) add(match[1] ?? '', true);
  }
  // Side-effect import: `import 'x'`.
  for (const match of source.matchAll(/(?:^|[^.\w$])import\s*['"]([^'"\n]*)['"]/g)) {
    if (atCodeLevel(source, keywordAt(match))) add(match[1] ?? '', true);
  }
  // Dynamic import and require with a literal argument.
  for (const match of source.matchAll(/(?:^|[^.\w$])(?:import|require)\s*\(\s*['"]([^'"\n]*)['"]\s*\)/g)) {
    if (atCodeLevel(source, keywordAt(match))) add(match[1] ?? '', true);
  }
  // ... and the same two with anything else inside: what they load is not static.
  for (const match of source.matchAll(/(?:^|[^.\w$])(import|require)\s*\(\s*(?!['"])([^)\n]{1,120})\)/g)) {
    if (!atCodeLevel(source, keywordAt(match))) continue;
    const expression = (match[2] ?? '').trim();
    // A template literal with nothing interpolated into it is a literal.
    const constant = /^`([^`$\n]*)`$/.exec(expression);
    if (constant !== null) {
      add(constant[1] ?? '', true);
      continue;
    }
    const prefix = literalPrefixOf(expression);
    found.push({ text: `${match[1] ?? 'import'}(${expression})`, literal: false, ...(prefix === null ? {} : { prefix }) });
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

/**
 * A gap plus the file whose walk produced it.
 *
 * The origin is not part of the public `SurfaceGap` — it exists so a gap found
 * while walking the SHARED fixture closure can be attributed to the criteria
 * that actually execute that file, and dropped when no criterion executes it
 * at all. A broken import in a fixture no check ever runs is a fact about the
 * repository, not a reason to refuse every criterion in it.
 */
interface GapRecord {
  readonly criterionId: string;
  readonly kind: SurfaceGapKind;
  readonly detail: string;
  readonly origin: string | null;
}

/**
 * The separator that keeps two criteria's identical messages apart in the
 * dedup maps. It is spelled as an escape on purpose: a literal control byte in
 * the source makes the whole module binary to `git`, `grep` and `file`, and a
 * module nobody can search is a module nobody can review.
 */
const KEY_SEPARATOR = '\u001F';

/** The remedy that closes a limitation, repeated wherever one is raised. */
const CONSERVATIVE_REMEDY =
  'the surface for this criterion therefore protects only what can be identified without parsing (its entry points, the paths the check names, and conventional fixture paths), and its closure was NOT proven \u2014 a candidate could change a file the criterion executes that this walk never saw. To establish it, list the files the criterion executes under "fixtures" in that check\'s entry in .workforce/checks.json';

interface WalkState {
  filesVisited: number;
  truncated: boolean;
  /** The criterion whose walk is running, so every gap knows what it makes unprovable. */
  criterionId: string;
  /**
   * True while walking a criterion whose `fixtures` the operator declared. The
   * declaration IS the closure, so the walk stops reporting that it could not
   * work one out for itself.
   */
  fixturesDeclared: boolean;
  /** Gaps, keyed by criterion and text so the same fact is reported once. */
  readonly gaps: Map<string, GapRecord>;
  /** Limitations, keyed the same way. These are reported and never refused. */
  readonly limitations: Map<string, SurfaceLimitation>;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly baseFileSet: ReadonlySet<string>;
  readonly baseFiles: ReadonlyArray<string>;
  readonly scripts: ReadonlyMap<string, string>;
  readonly cache: Map<string, string | null>;
  readonly read: (relativePath: string) => Promise<string | null>;
}

function note(state: WalkState, kind: SurfaceGapKind, text: string, origin: string | null = null): void {
  const key = `${state.criterionId}${KEY_SEPARATOR}${text}`;
  if (state.gaps.has(key)) return;
  if (state.gaps.size >= MAX_REPORTED_UNRESOLVED) {
    const overflow = `(further unresolved references were not listed; the first ${MAX_REPORTED_UNRESOLVED} are above)`;
    state.gaps.set(`${state.criterionId}${KEY_SEPARATOR}${overflow}`, { criterionId: state.criterionId, kind: 'truncated', detail: overflow, origin: null });
    return;
  }
  state.gaps.set(key, { criterionId: state.criterionId, kind, detail: text, origin });
}

/**
 * Record a fact that makes the surface CONSERVATIVE rather than unusable.
 *
 * The difference from `note` is the whole of defect 1: a limitation is
 * reported, printed and recorded, and the run proceeds. Nothing here ever
 * reaches `surfaceBlockers`.
 */
function limit(state: WalkState, kind: SurfaceLimitationKind, text: string): void {
  const key = `${state.criterionId}${KEY_SEPARATOR}${text}`;
  if (state.limitations.has(key) || state.limitations.size >= MAX_REPORTED_UNRESOLVED) return;
  state.limitations.set(key, { criterionId: state.criterionId, kind, detail: text });
}

/**
 * The repository path a symlink blob points at, or null when the blob is an
 * ordinary file.
 *
 * `git show <revision>:<path>` on a symlink hands back the LINK TEXT, not the
 * file it names. Read as source, that text has no imports — so a suite reached
 * through a symlink looks like a leaf, and the module it actually executes
 * never enters the surface at all. That is a silent hole, the worst kind.
 *
 * A blob is taken for a link when its entire content is a single line that
 * resolves, against the linking file's own directory, to another path of the
 * same tree. Source that reads that way does not exist: `export * from './x'`
 * does not name a file. The failure mode is over-inclusion — a data file whose
 * one line happens to be a sibling's name pulls that sibling in — which adds
 * to the surface rather than quietly subtracting from it.
 */
function symlinkTarget(file: string, raw: string, baseFileSet: ReadonlySet<string>): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 1024) return null;
  if (/[\n\r\0]/.test(text)) return null;
  // An absolute link leaves the repository; nothing in the tree can answer it.
  if (text.startsWith('/')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), text));
  if (target.startsWith('..') || target === file) return null;
  return baseFileSet.has(target) ? target : null;
}

function looksLikeShellScript(file: string, raw: string): boolean {
  if (/^#!.*\b(?:sh|bash|zsh|ksh|dash)\b/.test(raw)) return true;
  return SHELL_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

/**
 * The repository paths a shell script execs, as far as literal command words
 * can say.
 *
 * `sh verify/check.sh` contributes nothing to a module graph on its own, and
 * before this the criterion's whole surface was that one unreadable file. A
 * script whose body is `exec node verify/run.js` names its runner outright, so
 * the walk follows it and the criterion is protected exactly as if the check
 * had named `verify/run.js` itself. A word carrying `$` is not literal and is
 * skipped, which leaves the gap reported rather than guessed at.
 *
 * `computed` separates the two ways this can come back empty, and they are not
 * the same fact. A script whose runner is `"$RUNNER"` can execute anything, so
 * nothing bounds the criterion and the run refuses. A script whose commands
 * are all literal and simply name no file of this repository — `go test ./...`,
 * `cargo test`, `make check` — runs an external toolchain: the walk has no
 * analysis to offer, which is a limitation to state, not a reason to refuse.
 */
function pathsFromShellScript(file: string, raw: string, state: WalkState): { paths: string[]; computed: boolean } {
  const found = new Set<string>();
  let computed = false;
  const directory = path.posix.dirname(file);
  for (const line of raw.split('\n')) {
    for (const segment of line.replace(/#.*$/, '').split(SCRIPT_SEPARATORS)) {
      const words = segment
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^["']|["']$/g, ''))
        .filter((word) => word.length > 0);
      let index = 0;
      while (index < words.length && (SHELL_WRAPPERS.has(words[index]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index += 1;
      const head = words[index];
      if (head === undefined) continue;
      // `npm run acceptance` inside the script: the package.json chain answers it.
      const nested = scriptNameOf(head, words.slice(index + 1));
      if (nested !== null) {
        for (const value of pathsFromScript(nested, state.scripts, state.baseFiles, new Set(), 0)) found.add(value);
        continue;
      }
      for (const word of words.slice(index)) {
        if (word.startsWith('-')) continue;
        if (word.includes('$')) {
          computed = true;
          continue;
        }
        for (const candidate of [normalizeRelative(word), normalizeRelative(path.posix.join(directory, word))]) {
          if (candidate !== null && state.baseFileSet.has(candidate)) found.add(candidate);
        }
      }
    }
  }
  found.delete(file);
  return { paths: [...found], computed };
}

/**
 * The directory a computed specifier loads from, when its expression starts
 * with a literal path.
 *
 * `` import(`./cases/${name}.js`) `` does not say which case it loads, but it
 * does say every one of them lives in `./cases`. Treating that directory as
 * part of the surface is strictly better than giving up: the criterion really
 * does execute one of those files, and which one is not something the
 * candidate should get to decide.
 */
function computedDirectoryOf(prefix: string | undefined, fromFile: string): string | null {
  if (prefix === undefined || !prefix.startsWith('.')) return null;
  const slash = prefix.lastIndexOf('/');
  if (slash < 0) return null;
  const directory = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), prefix.slice(0, slash)));
  if (directory.startsWith('..') || directory === '.' || directory.length === 0) return null;
  return directory;
}

/** The module files directly or transitively under a directory, capped like every other walk. */
function modulesUnder(directory: string, state: WalkState): string[] {
  const contained = state.baseFiles.filter((file) => file.startsWith(`${directory}/`) && languageOf(file) !== null);
  if (contained.length > MAX_DIRECTORY_ENTRIES) {
    state.truncated = true;
    limit(
      state,
      'analysis_truncated',
      `${directory} holds ${contained.length} module files; only the first ${MAX_DIRECTORY_ENTRIES} were walked, so the closure below is a prefix of what this criterion may execute`,
    );
    return contained.slice(0, MAX_DIRECTORY_ENTRIES);
  }
  return contained;
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
async function reachableFrom(entries: ReadonlyArray<string>, state: WalkState, declared: Set<string>, discovered: Set<string>): Promise<Set<string>> {
  const reached = new Set<string>();
  const seen = new Set<string>(entries);
  let frontier: Array<{ file: string; depth: number }> = entries.map((file) => ({ file, depth: 0 }));

  while (frontier.length > 0) {
    const next: Array<{ file: string; depth: number }> = [];
    for (const { file, depth } of frontier) {
      reached.add(file);
      const language = languageOf(file);
      // A non-module file is only followed when a check *names* it: `sh
      // verify/check.sh` executes something, and that something belongs to the
      // criterion. A data file that happens to sit under `tests/` does not.
      if (language === null && !declared.has(file)) continue;
      if (depth >= state.maxDepth) {
        state.truncated = true;
        limit(state, 'analysis_truncated', `the import walk stopped at ${file}: depth cap ${state.maxDepth} reached, so its own imports are NOT part of this surface`);
        continue;
      }
      if (state.filesVisited >= state.maxFiles) {
        state.truncated = true;
        limit(state, 'analysis_truncated', `the import walk stopped after ${state.maxFiles} files; files beyond that cap are NOT part of this surface`);
        return reached;
      }
      state.filesVisited += 1;
      const raw = await readOnce(state, file);
      if (raw === null) {
        note(state, 'unreadable', `${file} could not be read at the base revision, so what it executes was not followed`, file);
        continue;
      }

      // A symlink's blob is its link text. Follow it to the real file rather
      // than reading the target's name as if it were the module's source.
      const link = symlinkTarget(file, raw, state.baseFileSet);
      if (link !== null) {
        // A link named by a check stands in for what it points at, so the
        // target inherits the right to be followed as an executed entry.
        if (declared.has(file)) {
          declared.add(link);
          discovered.add(link);
        }
        if (!seen.has(link)) {
          seen.add(link);
          next.push({ file: link, depth: depth + 1 });
        }
        continue;
      }

      if (language === null) {
        if (looksLikeShellScript(file, raw) && raw.length <= MAX_SCRIPT_BYTES) {
          const execed = pathsFromShellScript(file, raw, state);
          if (execed.paths.length > 0) {
            for (const target of execed.paths) {
              // The runner a criterion's script execs is what that criterion
              // executes, so it is an entry point of the criterion in every
              // sense: followed like one, and protected like one. Anything
              // less would leave `sh run.sh` weaker than `node run.js`.
              declared.add(target);
              discovered.add(target);
              if (seen.has(target)) continue;
              seen.add(target);
              next.push({ file: target, depth: depth + 1 });
            }
            continue;
          }
          if (execed.computed || state.fixturesDeclared) {
            // A runner chosen at run time is not bounded by anything in the
            // tree, so the criterion really is unprovable. (When the operator
            // declared the closure, `fixturesDeclared` suppresses the refusal
            // below instead — see `walk`.)
            if (!state.fixturesDeclared) {
              note(
                state,
                'entry_not_module',
                `${file} is executed by a criterion and is a shell script, but no literal command in it names a file of this repository, so what it runs was not followed`,
                file,
              );
            }
            continue;
          }
          limit(
            state,
            'external_toolchain',
            `${file} is executed by a criterion and is a shell script whose commands are all literal but name no file of this repository, so it runs an external toolchain this walk cannot analyse; ${CONSERVATIVE_REMEDY}`,
          );
          continue;
        }
        if (!state.fixturesDeclared) {
          limit(
            state,
            'language_unsupported',
            `${file} is executed by a criterion but is not a JavaScript, TypeScript or Python module, so its dependencies were not analysed; ${CONSERVATIVE_REMEDY}`,
          );
        }
        continue;
      }

      if (raw.length > MAX_FILE_BYTES) {
        state.truncated = true;
        limit(state, 'analysis_truncated', `${file} is larger than ${MAX_FILE_BYTES} bytes and was not scanned for imports`);
        continue;
      }
      const source = stripComments(raw, language);

      const targets: string[] = [];
      if (language === 'javascript') {
        for (const specifier of javascriptSpecifiers(source)) {
          if (!specifier.literal) {
            // Not knowable *which* module it loads, but often knowable which
            // directory it loads from — and the whole directory is a better
            // answer than none.
            const directory = computedDirectoryOf(specifier.prefix, file);
            const contained = directory === null ? [] : modulesUnder(directory, state);
            if (contained.length > 0) {
              targets.push(...contained);
              continue;
            }
            note(state, 'computed_specifier', `${file} loads a computed specifier (${specifier.text}); what it executes was not resolved`, file);
            continue;
          }
          const text = specifier.text;
          if (text.length === 0) continue;
          if (/^(?:node|data|bun|file|https?):/.test(text)) continue;
          if (text.startsWith('/')) {
            note(state, 'unresolved_import', `${file} imports the absolute path "${text}", which is outside the repository tree and was not resolved`, file);
            continue;
          }
          if (!text.startsWith('.')) continue; // a package: not candidate-writable
          const resolved = resolveJavascript(text, file, state.baseFileSet);
          if (resolved === null) {
            note(state, 'unresolved_import', `${file} imports "${text}", which does not resolve to a file in the base revision`, file);
            continue;
          }
          targets.push(resolved);
        }
      } else {
        for (const entry of pythonImports(source)) {
          const resolved = resolvePython(entry, file, state.baseFileSet);
          if (resolved.length === 0 && entry.level > 0) {
            note(state, 'unresolved_import', `${file} imports "${'.'.repeat(entry.level)}${entry.module}", which does not resolve to a module in the base revision`, file);
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
      limit(
        state,
        'analysis_truncated',
        `${entry} holds ${contained.length} module files; only the first ${MAX_DIRECTORY_ENTRIES} were walked, so the closure below is a prefix of what this criterion may execute`,
      );
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
    const direct = [...entry.protectedPaths, ...entry.implicit];
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
    const detail =
      'the acceptance surface was resolved from path patterns and command arguments only: no reader for the base revision was supplied, so the modules those files import are NOT covered';
    return assemble(entries, shared, new Map(), definitionPathsOf(baseFiles), {
      moduleGraphResolved: false,
      entryPoints: [...new Set([...shared, ...entries.flatMap((entry) => entry.explicit)])].sort(),
      filesVisited: 0,
      truncated: true,
      unresolved: [detail],
      gaps: [{ criterionId: '*', kind: 'no_reader', detail }],
      limitations: [],
      conservative: false,
    });
  }

  const state: WalkState = {
    filesVisited: 0,
    truncated: false,
    criterionId: '*',
    fixturesDeclared: false,
    gaps: new Map<string, GapRecord>(),
    limitations: new Map<string, SurfaceLimitation>(),
    maxFiles: context.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: context.limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
    baseFileSet: new Set(baseFiles),
    baseFiles,
    scripts,
    cache: new Map<string, string | null>(),
    read: context.readBaseFile,
  };

  const reachedByCriterion = new Map<string, { suite: ReadonlyArray<string>; dependencies: ReadonlyArray<string> }>();
  const allEntryPoints = new Set<string>();

  const walk = async (
    id: string,
    entryPaths: ReadonlyArray<string>,
    suiteDirectories: ReadonlyArray<string>,
    namedByCheck: boolean,
    fixturesDeclared = false,
  ): Promise<void> => {
    state.criterionId = id;
    state.fixturesDeclared = fixturesDeclared;
    for (const entry of entryPaths) allEntryPoints.add(entry);
    const entryFiles = entryFilesOf(entryPaths, baseFiles, state);
    if (entryFiles.length === 0) {
      // Entry points that stand for nothing THIS WALK can read: a Go, Rust,
      // Ruby or Swift directory, a link that leaves the tree. Silence would
      // read as "nothing to protect" rather than "we found nothing", but a
      // refusal would read as "this repository cannot be verified", and that
      // is false: the walk has no parser for those languages, which is a fact
      // about the walk. So it is stated and the run proceeds.
      if (namedByCheck && entryPaths.length > 0 && !fixturesDeclared) {
        limit(
          state,
          'language_unsupported',
          `the entry point(s) ${entryPaths.join(', ')} named by this criterion contain no JavaScript, TypeScript or Python module, so no dependency analysis was possible for it; ${CONSERVATIVE_REMEDY}`,
        );
      }
      return;
    }
    // Paths the check itself names, as opposed to files found by expanding a
    // directory or matching a fixture pattern.
    const declared = namedByCheck ? new Set(entryPaths.filter((entry) => state.baseFileSet.has(entry))) : new Set<string>();
    // Entry points the walk *finds*: the runner a named script execs, the real
    // file a named link points at. The check named them as surely as if it had
    // spelled them out, so they are entry points for tiering too — otherwise
    // `sh verify/check.sh` would protect less than `node verify/run.js`.
    const discovered = new Set<string>();
    const reached = await reachableFrom(entryFiles, state, declared, discovered);
    const entrySet = new Set([...entryFiles, ...discovered]);
    const directories = discovered.size === 0 ? suiteDirectories : [...new Set([...suiteDirectories, ...suiteDirectoriesOf([...discovered], state.baseFileSet)])];
    for (const entry of discovered) allEntryPoints.add(entry);
    const suite: string[] = [];
    const dependencies: string[] = [];
    for (const file of reached) {
      if (tierOf(file, entrySet, directories) === 'suite') suite.push(file);
      else dependencies.push(file);
    }
    reachedByCriterion.set(id, { suite: suite.sort(), dependencies: dependencies.sort() });
  };

  // The conventional fixtures are entry points for every criterion, so their
  // closure is shared too.
  await walk('*', shared, [], false);
  for (const entry of entries) {
    await walk(entry.criterionId, entry.explicit, suiteDirectoriesOf(entry.explicit, state.baseFileSet), true, entry.fixturesDeclared);
  }
  // A criterion whose command names no path this tree contains, in a repository
  // with no conventionally named fixture either: `go test ./...`, `cargo test`,
  // `make check`. Nothing at all was identified for it, and saying nothing
  // would let an empty surface read as a clean one.
  if (shared.length === 0) {
    for (const entry of entries) {
      if (entry.explicit.length > 0 || entry.fixturesDeclared) continue;
      state.criterionId = entry.criterionId;
      limit(
        state,
        'external_toolchain',
        `this criterion's command names no path this repository contains and the tree holds no conventionally named fixture, so nothing about what it executes was identified; ${CONSERVATIVE_REMEDY}`,
      );
    }
  }
  // A declared fixture path that names nothing at the base revision is not a
  // declaration, it is a typo. Silently ignoring it would let the operator
  // believe a closure was established that never was.
  for (const entry of entries) {
    if (entry.missingFixtures.length === 0) continue;
    state.criterionId = entry.criterionId;
    state.fixturesDeclared = false;
    note(
      state,
      'declared_fixture_missing',
      `this criterion declares the fixture path(s) ${entry.missingFixtures.join(', ')} in .workforce/checks.json, and the base revision contains no such path, so the closure they were meant to declare is not established`,
    );
  }

  const records = attributeSharedGaps([...state.gaps.values()], entries, reachedByCriterion, shared, state);
  const gaps: SurfaceGap[] = records
    .map((record) => ({ criterionId: record.criterionId, kind: record.kind, detail: record.detail }))
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId) || left.detail.localeCompare(right.detail));
  const limitations = [...state.limitations.values()].sort(
    (left, right) => left.criterionId.localeCompare(right.criterionId) || left.detail.localeCompare(right.detail),
  );
  return assemble(entries, shared, reachedByCriterion, definitionPathsOf(baseFiles), {
    moduleGraphResolved: true,
    entryPoints: [...allEntryPoints].sort(),
    filesVisited: state.filesVisited,
    truncated: state.truncated,
    unresolved: [...new Set([...gaps.map((gap) => gap.detail), ...limitations.map((limitation) => limitation.detail)])].sort(),
    gaps,
    limitations,
    conservative: limitations.length > 0,
  });
}

/**
 * Re-home the gaps found while walking the SHARED fixture closure.
 *
 * `*` means "every criterion", and a `*` blocker refuses the whole repository.
 * That is right for a file every criterion executes and wrong for everything
 * else: one unresolvable relative import in a legacy fixture that no check
 * runs used to block every criterion in the tree, which is a false refusal
 * dressed as a safety property. So a shared-closure gap is attributed to the
 * criteria whose own closure contains the file that produced it, and when no
 * criterion executes that file it is demoted to a limitation — recorded,
 * visible, and not a reason to refuse a run.
 *
 * A criterion that names no entry paths of its own is the exception: it
 * discovers its tests conventionally (`pytest`, `npm test` with no argument
 * that resolves), so the shared closure IS what it executes and it owns every
 * gap in it.
 */
function attributeSharedGaps(
  records: ReadonlyArray<GapRecord>,
  entries: ReadonlyArray<CriterionEntries>,
  reachedByCriterion: ReadonlyMap<string, { suite: ReadonlyArray<string>; dependencies: ReadonlyArray<string> }>,
  shared: ReadonlyArray<string>,
  state: WalkState,
): GapRecord[] {
  const sharedReached = reachedByCriterion.get('*');
  const sharedFiles = new Set<string>([...shared, ...(sharedReached?.suite ?? []), ...(sharedReached?.dependencies ?? [])]);
  const executedBy = new Map<string, Set<string>>();
  for (const entry of entries) {
    const reached = reachedByCriterion.get(entry.criterionId);
    const files = new Set<string>([...entry.explicit, ...(reached?.suite ?? []), ...(reached?.dependencies ?? [])]);
    // No entry paths of its own: whatever the conventions found is what it runs.
    if (entry.explicit.length === 0) for (const file of sharedFiles) files.add(file);
    executedBy.set(entry.criterionId, files);
  }

  const kept: GapRecord[] = [];
  const seen = new Set<string>();
  const keep = (record: GapRecord): void => {
    const key = `${record.criterionId}${KEY_SEPARATOR}${record.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(record);
  };

  for (const record of records) {
    if (record.criterionId !== '*') {
      keep(record);
      continue;
    }
    const origin = record.origin;
    const owners = origin === null ? [...executedBy.keys()] : [...executedBy].filter(([, files]) => files.has(origin)).map(([id]) => id);
    if (owners.length === 0) {
      state.criterionId = '*';
      limit(
        state,
        'unexecuted_fixture',
        `${record.detail} \u2014 this is a file under a conventional fixture path that no criterion's evidence executes, so it is recorded rather than treated as a reason to refuse any criterion`,
      );
      continue;
    }
    for (const owner of owners) keep({ ...record, criterionId: owner });
  }
  return kept;
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
  const detail =
    'the acceptance surface was resolved from path patterns and command arguments only: this caller did not follow the module graph, so the modules those files import are NOT covered';
  return assemble(entries, shared, new Map(), definitionPathsOf(baseFiles), {
    moduleGraphResolved: false,
    entryPoints: [...new Set([...shared, ...entries.flatMap((entry) => entry.explicit)])].sort(),
    filesVisited: 0,
    truncated: true,
    unresolved: [detail],
    gaps: [{ criterionId: '*', kind: 'no_reader', detail }],
    limitations: [],
    conservative: false,
  });
}

/**
 * The reasons an acceptance decision must REFUSE because the surface it would
 * be decided over is partial.
 *
 * This is the point of the whole module. A criterion whose executed files were
 * only partly found is a criterion whose check could have exited 0 over
 * precisely the part that was missed — the same false-completion hole as a
 * rewritten suite, reached by a different road. Reporting the gap and
 * accepting anyway is the one outcome that cannot be defended, so the gaps
 * come back here as blockers and the run says "not established" instead.
 *
 * Each message names the criterion, exactly what could not be resolved, and
 * what the operator can do about it. The remedies are real ones: a path named
 * in a check's `args` in `.workforce/checks.json` becomes an entry point this
 * walk follows (that is how fixtures are named explicitly), and a check
 * pointed at a JavaScript, TypeScript or Python file has a module graph to
 * follow in the first place.
 */
export function surfaceBlockers(surface: AcceptanceSurface): string[] {
  const byCriterion = new Map<string, { details: string[]; kinds: Set<SurfaceGapKind> }>();
  for (const gap of surface.resolution.gaps) {
    let entry = byCriterion.get(gap.criterionId);
    if (entry === undefined) {
      entry = { details: [], kinds: new Set<SurfaceGapKind>() };
      byCriterion.set(gap.criterionId, entry);
    }
    if (!entry.details.includes(gap.detail)) entry.details.push(gap.detail);
    entry.kinds.add(gap.kind);
  }
  const order = [...byCriterion.keys()].sort((left, right) => (left === '*' ? -1 : right === '*' ? 1 : left.localeCompare(right)));
  return order.map((criterionId) => {
    const who = criterionId === '*' ? 'every criterion' : `criterion "${criterionId}"`;
    const subject = criterionId === '*' ? 'no criterion is' : `"${criterionId}" is not`;
    const entry = byCriterion.get(criterionId) ?? { details: [], kinds: new Set<SurfaceGapKind>() };
    return (
      `the acceptance surface for ${who} could not be fully resolved, so ${subject} established by its check: ${entry.details.join('; ')}. ` +
      `A check that exits 0 over files this run never resolved is not evidence that the criterion the base revision defined still holds. ` +
      `${remediesFor(entry.kinds).join(' ')}`
    );
  });
}

/** What actually closes each kind of gap. Nothing here is offered unless it works. */
function remediesFor(kinds: ReadonlySet<SurfaceGapKind>): string[] {
  const remedies: string[] = [];
  if (kinds.has('entry_not_module')) {
    remedies.push(
      'To resolve it: name the JavaScript, TypeScript or Python file the criterion ultimately runs as the check\'s command or in its "args" in .workforce/checks.json, so the walk starts from a module rather than from a file it cannot read; or list the files the criterion executes under "fixtures" in that check\'s entry, which declares the closure outright. A shell entry point is followed only as far as a literal command in it names a file of this repository, and a runner chosen at run time names none.',
    );
  }
  if (kinds.has('declared_fixture_missing')) {
    remedies.push('To resolve it: correct the "fixtures" paths in .workforce/checks.json so each one names a path the base revision contains, or remove the ones that no longer exist.');
  }
  if (kinds.has('computed_specifier')) {
    remedies.push(
      'To resolve it: make the specifier literal. A template literal with a fixed directory prefix is enough — `./cases/${name}.js` puts the whole `./cases` directory into the surface — but a specifier read from a variable or the environment can load anything, and no static declaration can bound it.',
    );
  }
  if (kinds.has('unresolved_import')) {
    remedies.push('To resolve it: correct the import, or commit the file it names, so the path it points at exists at the base revision.');
  }
  if (kinds.has('unreadable')) {
    remedies.push('To resolve it: make the file readable at the base revision — a criterion cannot be judged against a file this run cannot fetch.');
  }
  if (kinds.has('truncated')) {
    remedies.push('To resolve it: narrow what the criterion executes, or split it into criteria whose closures each fit the walk, so no cap is reached.');
  }
  if (kinds.has('no_reader')) {
    remedies.push('To resolve it: give the surface a reader for the base revision; without one no module graph is followed at all.');
  }
  return remedies;
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
