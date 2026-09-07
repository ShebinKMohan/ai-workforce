/**
 * The R0 direct path (FR019, FR020, FR029 foundation, FR041, FR049, FR058).
 *
 * One capable worker, one candidate workspace, one turn, then independently
 * executed acceptance checks. There is no planner, PM or reviewer
 * conversation: a bounded task does not need one. Every step still goes
 * through durable scheduling — dispatch intent is committed before a worker
 * starts, and a completion receipt is committed before the outcome is used.
 *
 * The single most important rule in this file: the task becomes `accepted`
 * only when `decideAcceptance` says every required criterion has a
 * verifier-executed receipt that passed. A runtime that says "done",
 * exits zero, or prints convincing test output changes nothing here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentConfigFile,
  type EffectiveAgentBinding,
  type Limits,
  type Policy,
  type TaskContract,
  RUN_REQUEST_VERSION,
  TASK_CONTRACT_VERSION,
  limitsFromDefaults,
  validateRunRequest,
  validateTaskContract,
} from './contracts.js';
import { newId, nowIso } from './ids.js';
import { computeAgentSnapshot } from './snapshot.js';
import type { ProcessIdentity } from './process.js';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  FakeAdapter,
  FAKE_SCENARIO_ENV,
  validateBindingSettings,
  type RuntimeAdapter,
  type RuntimeEvent,
  type SessionHandle,
  type StopReceipt,
  type TurnHandle,
} from '../adapters/index.js';
import { writeArtifact, type ArtifactRecord } from '../storage/artifacts.js';
import { ensureRunDir, isWithin, type StatePaths } from '../storage/paths.js';
import { markDispatched, recordIntent, recordReceipt } from '../storage/operations.js';
import {
  insertAttempt,
  insertRun,
  insertTask,
  transitionAttempt,
  transitionRun,
  transitionTask,
  upsertAgentSnapshot,
} from '../storage/records.js';
import { appendEvent } from '../storage/events.js';
import { projectEventsJsonl, recordRuntimeEvent, summarizeTurnEvidence, type TurnEvidence } from '../telemetry/events.js';
import { PhaseTimer, USAGE_UNAVAILABLE, type UsageReport } from '../telemetry/timing.js';
import {
  assertGrantedPathsSafe,
  candidateWritePaths,
  createCandidateWorkspace,
  snapshotCandidate,
  type CandidateSnapshot,
  type CandidateWorkspace,
} from '../workspaces/candidate.js';
import { git } from '../workspaces/git.js';
import { describeDirty, inspectProject, registerProject, type ProjectInspection } from '../workspaces/project.js';
import {
  decideAcceptance,
  persistCheckReceipts,
  runChecks,
  type AcceptanceDecision,
  type CheckReceipt,
  type CheckSpec,
  type FixtureMutation,
} from '../verification/checks.js';

export const RUN_MANIFEST_VERSION = 1 as const;

/**
 * How long a runtime gets to acknowledge an interruption before the
 * coordinator terminates the process group it owns (plan section 9).
 */
export const INTERRUPT_ACKNOWLEDGEMENT_MS = 5_000;

/** Resolve `promise`, or `null` when it does not settle inside `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race handles a rejection, but only while it is still listening; this
  // keeps a late rejection from becoming an unhandled one.
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

export class AdapterNotRegisteredError extends Error {
  readonly adapter: string;

  constructor(adapter: string, arrivesWith: string) {
    super(`no adapter is registered for runtime adapter "${adapter}"; it arrives with ${arrivesWith}. Bind the agent to a registered runtime, or use the "fake" adapter for a deterministic local demonstration.`);
    this.name = 'AdapterNotRegisteredError';
    this.adapter = adapter;
  }
}

export interface RuntimeBindingRef {
  readonly id: string;
  readonly adapter: string;
  readonly executable: string;
}

/**
 * Per-attempt context an adapter needs but the runtime binding cannot carry.
 * `logsDir` is a path only: the adapter creates it lazily when it actually
 * opens a session, so a refused run leaves nothing behind.
 */
export interface AdapterContext {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Where the adapter writes its raw runtime capture (`<run>/artifacts/logs`). */
  readonly logsDir: string;
}

export type AdapterFactory = (runtime: RuntimeBindingRef, context: AdapterContext) => RuntimeAdapter;

/**
 * ===================== ADAPTER REGISTRATION POINT =====================
 * 'fake' is the deterministic test runtime, 'codex' is the WP03 app-server
 * adapter and 'claude-code' is the WP05 CLI adapter. Every adapter implements
 * the same `RuntimeAdapter` contract, so nothing else in the direct path
 * changed when the second real runtime was added — which is the point of the
 * shared conformance suite in tests/adapters/conformance.
 * ======================================================================
 */
export function createAdapter(runtime: RuntimeBindingRef, context?: AdapterContext): RuntimeAdapter {
  switch (runtime.adapter) {
    case 'fake':
      return new FakeAdapter({ scriptPath: runtime.executable });
    case 'codex':
      // The raw JSONL capture is the only evidence of what the worker did,
      // so the run's own logs directory is handed to the adapter here.
      return new CodexAdapter({
        executablePath: runtime.executable,
        ...(context !== undefined ? { logsDir: context.logsDir } : {}),
      });
    case 'claude-code':
      // Same contract, different transport: the Claude Code CLI held open in
      // programmatic mode. The raw JSONL capture goes into the run's own logs
      // directory, exactly as the Codex adapter's does.
      return new ClaudeCodeAdapter({
        executablePath: runtime.executable,
        ...(context !== undefined ? { logsDir: context.logsDir } : {}),
      });
    default:
      throw new AdapterNotRegisteredError(runtime.adapter, 'a future work package');
  }
}

// ---------------------------------------------------------------------------
// Acceptance check resolution
// ---------------------------------------------------------------------------

const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `.workforce/checks.json`. Deliberately narrower than `CheckSpec`: a
 * repository cannot supply `env`, because check definitions come from the
 * project but must not be able to inject values into the verifier's
 * environment.
 */
export const RepoCheckSchema = z.strictObject({
  criterionId: z.string().regex(CRITERION_ID, { message: 'criterion ids use letters, digits, ".", "_" or "-" and must start with a letter or digit' }),
  description: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
  required: z.boolean().optional(),
});

export const RepoChecksFileSchema = z.strictObject({
  checksVersion: z.literal(1),
  checks: z.array(RepoCheckSchema).min(1).max(32),
});

export type CheckSource = 'cli_flags' | 'repository_config' | 'detected' | 'none';

export interface ResolvedChecks {
  readonly source: CheckSource;
  readonly checks: ReadonlyArray<CheckSpec>;
  readonly detail: string;
}

export class CheckConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckConfigurationError';
    this.code = code;
  }
}

/**
 * Split a `--check "<command> [args]"` value into an argv array.
 *
 * No shell is involved at any point: this only splits on whitespace with
 * quoting support. Shell metacharacters are rejected rather than quietly
 * passed to a program that would not interpret them anyway.
 */
export function tokenizeCheckCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < value.length) {
        i += 1;
        current += value[i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < value.length) {
      i += 1;
      current += value[i]!;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    if (';|&$`<>()\n'.includes(ch)) {
      throw new CheckConfigurationError(
        'shell_metacharacter',
        `--check "${value}" contains "${ch}"; checks are executed directly with an argument array and never through a shell, so pipes, redirection and substitution are not available. Put the composite command in a script and call that instead.`,
      );
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new CheckConfigurationError('unterminated_quote', `--check "${value}" has an unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) tokens.push(current);
  if (tokens.length === 0) throw new CheckConfigurationError('empty_check', 'a --check value must name a command');
  return tokens;
}

export function checksFromFlags(values: ReadonlyArray<string>): CheckSpec[] {
  return values.map((value, index) => {
    const [command, ...args] = tokenizeCheckCommand(value);
    return { criterionId: `check-${index + 1}`, description: `--check "${value}"`, command: command!, args, required: true } satisfies CheckSpec;
  });
}

/** Read a path out of the base revision, so a worker cannot change acceptance by editing the repository. */
async function showAtRevision(repoRoot: string, revision: string, relativePath: string): Promise<string | null> {
  const run = await git(['show', `${revision}:${relativePath}`], { cwd: repoRoot, maxOutputBytes: 1024 * 1024 });
  return run.ok ? run.stdout : null;
}

/**
 * Resolve acceptance checks, in precedence order:
 *   1. `--check` flags;
 *   2. `.workforce/checks.json` **at the base revision**;
 *   3. detection from the base revision's file list.
 *
 * Everything is read from the frozen base, never from the working tree, so a
 * dirty checkout or a worker edit cannot change what acceptance means.
 */
export async function resolveAcceptanceChecks(
  repoRoot: string,
  baseRevision: string,
  flagValues: ReadonlyArray<string> = [],
): Promise<ResolvedChecks> {
  if (flagValues.length > 0) {
    return { source: 'cli_flags', checks: checksFromFlags(flagValues), detail: `${flagValues.length} check(s) from --check flags` };
  }

  const raw = await showAtRevision(repoRoot, baseRevision, '.workforce/checks.json');
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CheckConfigurationError('invalid_checks_json', `.workforce/checks.json at ${baseRevision.slice(0, 12)} is not valid JSON: ${(error as Error).message}`);
    }
    const result = RepoChecksFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      throw new CheckConfigurationError('invalid_checks_config', `.workforce/checks.json at ${baseRevision.slice(0, 12)} is invalid: ${issues}`);
    }
    const checks = result.data.checks.map(
      (check): CheckSpec => ({
        criterionId: check.criterionId,
        command: check.command,
        args: check.args,
        required: check.required ?? true,
        ...(check.description !== undefined ? { description: check.description } : {}),
        ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      }),
    );
    return { source: 'repository_config', checks, detail: `${checks.length} check(s) from .workforce/checks.json at base ${baseRevision.slice(0, 12)}` };
  }

  const detected = await detectChecks(repoRoot, baseRevision);
  if (detected !== null) return detected;

  return {
    source: 'none',
    checks: [],
    detail: 'no acceptance checks are configured: add .workforce/checks.json, or pass --check "<command> [args]"',
  };
}

/** Every tracked path at a revision. Empty when the revision cannot be listed. */
export async function listFilesAtRevision(repoRoot: string, revision: string): Promise<string[]> {
  const listing = await git(['ls-tree', '-r', '--name-only', '-z', revision], { cwd: repoRoot, maxOutputBytes: 8 * 1024 * 1024 });
  return listing.ok ? listing.stdout.split('\0').filter((name) => name.length > 0) : [];
}

async function detectChecks(repoRoot: string, baseRevision: string): Promise<ResolvedChecks | null> {
  const files = await listFilesAtRevision(repoRoot, baseRevision);

  if (files.includes('package.json')) {
    const raw = await showAtRevision(repoRoot, baseRevision, 'package.json');
    if (raw !== null) {
      try {
        const manifest = JSON.parse(raw) as { scripts?: Record<string, unknown> };
        const testScript = manifest.scripts?.['test'];
        if (typeof testScript === 'string' && testScript.trim().length > 0) {
          return {
            source: 'detected',
            checks: [{ criterionId: 'package-test-script', description: `package.json test script: ${testScript}`, command: 'npm', args: ['test', '--silent'], required: true }],
            detail: `detected the package.json "test" script (${testScript}) at base ${baseRevision.slice(0, 12)}`,
          };
        }
      } catch {
        // A malformed package.json is not an acceptance configuration error; fall through to other detection.
      }
    }
  }

  const pythonTests = files.filter((name) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/.test(name));
  if (pythonTests.length > 0) {
    return {
      source: 'detected',
      checks: [
        {
          criterionId: 'python-unittest',
          description: `python unittest discovery over ${pythonTests.length} test file(s)`,
          command: 'python3',
          args: ['-m', 'unittest', 'discover', '-v'],
          required: true,
        },
      ],
      detail: `detected ${pythonTests.length} Python test file(s) at base ${baseRevision.slice(0, 12)}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Acceptance fixture surface
// ---------------------------------------------------------------------------

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

export interface AcceptanceSurface {
  /** Criterion id (or `*` for every criterion) to the base paths its evidence executes. */
  readonly byCriterion: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Base paths that define acceptance without being executed by it. */
  readonly definitionPaths: ReadonlyArray<string>;
}

function normalizeRelative(value: string): string | null {
  const cleaned = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned.startsWith('/') || cleaned.startsWith('..') || cleaned.includes('\0')) return null;
  return cleaned;
}

function existsInTree(baseFiles: ReadonlyArray<string>, candidate: string): boolean {
  return baseFiles.some((file) => file === candidate || file.startsWith(`${candidate}/`));
}

/**
 * Work out which base files each criterion's evidence actually executes.
 *
 * The check *definition* is already pinned to the base revision, but the code
 * it runs comes from the candidate. This is how the run finds out whether the
 * worker rewrote that code (plan section 9: acceptance fixtures stay outside
 * worker write access, and a task that legitimately changes repository tests
 * still has to be assessed against the original criteria).
 */
export function acceptanceSurface(checks: ReadonlyArray<CheckSpec>, baseFiles: ReadonlyArray<string>): AcceptanceSurface {
  const byCriterion = new Map<string, ReadonlyArray<string>>();

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
    if (PACKAGE_MANAGER_COMMANDS.has(check.command) && baseFiles.includes('package.json')) paths.add('package.json');
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
 * Compare the candidate diff against the acceptance surface.
 *
 * Modifying or deleting a file a criterion executes compromises that
 * criterion's evidence. *Adding* a file does not: writing a new test to
 * protect the fix is exactly what a worker should be able to do, so it is
 * recorded and left alone.
 */
export function findSurfaceChanges(surface: AcceptanceSurface, changes: ReadonlyArray<{ status: string; path: string }>): SurfaceFindings {
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
function surfacePaths(surface: AcceptanceSurface): string[] {
  const all = new Set<string>(surface.definitionPaths);
  for (const paths of surface.byCriterion.values()) for (const value of paths) all.add(value);
  return [...all].sort();
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

export interface PromptInput {
  /** The user's request, reproduced verbatim. */
  readonly requestText: string;
  readonly contextRefs: ReadonlyArray<string>;
  readonly workspace: CandidateWorkspace;
  readonly inspection: ProjectInspection;
  readonly contract: TaskContract;
}

/**
 * The turn prompt: the user's own wording first and unmodified, then the
 * repository context the worker needs. Nothing is summarized away.
 */
export function composeTaskPrompt(input: PromptInput): string {
  const { workspace, inspection, contract } = input;
  const lines: string[] = [];
  lines.push(input.requestText.trimEnd());
  lines.push('');
  lines.push('--- repository context (added by the workforce coordinator; the request above is the user\'s own wording) ---');
  lines.push(`Working directory: ${workspace.path}`);
  lines.push(`This is a candidate workspace: a linked Git worktree of ${workspace.projectRoot} on the new branch ${workspace.branch}.`);
  lines.push(`Base revision: ${workspace.baseRevision} (committed HEAD${inspection.branch !== null ? ` of ${inspection.branch}` : ', detached'}).`);
  if (workspace.excludedUncommittedChanges !== null && !workspace.excludedUncommittedChanges.clean) {
    lines.push(`Uncommitted changes in the user's checkout are NOT included in this candidate (${describeDirty(workspace.excludedUncommittedChanges)}). Work from the committed base only.`);
  }
  if (inspection.hasSubmodules) {
    lines.push(`The repository declares submodules (${inspection.submodulePaths.join(', ')}); they are not populated in this worktree.`);
  }
  if (input.contextRefs.length > 0) {
    lines.push(`Context references supplied with the request: ${input.contextRefs.join(', ')}.`);
  }
  lines.push('');
  lines.push('Changed-file rules:');
  lines.push(`- Edit files under ${workspace.path} only. A write outside it is recorded as out of scope and is not part of the candidate.`);
  lines.push('- Do not create commits, branches or tags, and do not touch .git: the coordinator creates the checkpoint commit for the candidate.');
  if (contract.scope.allowedPaths.length > 0) lines.push(`- Stay within: ${contract.scope.allowedPaths.join(', ')}.`);
  if (contract.scope.forbiddenPaths.length > 0) {
    lines.push(`- Do not modify or delete: ${contract.scope.forbiddenPaths.join(', ')}. The acceptance criteria execute those files; changing them does not make a criterion pass, it makes the run refuse acceptance. You may add new test files.`);
  }
  lines.push('');
  lines.push('Acceptance criteria. The coordinator runs these itself against a frozen copy of your result; reporting success does not mark the task accepted:');
  for (const criterion of contract.acceptanceCriteria) {
    const command = criterion.check === undefined ? '(no command)' : [criterion.check.command, ...criterion.check.args].join(' ');
    lines.push(`- ${criterion.id}: ${criterion.description} — the verifier runs \`${command}\``);
  }
  for (const constraint of contract.constraints) lines.push(`- Constraint: ${constraint}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Run inputs and outputs
// ---------------------------------------------------------------------------

export interface RunStream {
  /** One normalized record; rendered as a line for humans or a JSONL object with --json. */
  event(record: Record<string, unknown> & { readonly type: string }): void;
  /** Human progress line. */
  line(text: string): void;
}

export const SILENT_STREAM: RunStream = { event: () => {}, line: () => {} };

export interface RunDirectInput {
  readonly repoPath: string;
  readonly config: AgentConfigFile;
  readonly configRaw: string;
  readonly configPath: string;
  readonly requestText: string;
  readonly requestSource: string;
  readonly contextRefs?: ReadonlyArray<string>;
  readonly agentId?: string;
  readonly checkFlags?: ReadonlyArray<string>;
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly stream?: RunStream;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  /** Extra environment for the runtime session (used to select a fake-runtime scenario). */
  readonly sessionEnv?: Readonly<Record<string, string>>;
  readonly keepCheckCopies?: boolean;
  /**
   * The coordinator lock this run was started under. It is re-checked before
   * the worker is dispatched and before the result is written, so a state root
   * whose lock stopped excluding other coordinators fails the run instead of
   * producing a result two coordinators believe they own.
   */
  readonly ownership?: { assertOwnership(): void };
  /**
   * Override the run deadline in milliseconds. `runTimeoutMinutes` is the
   * configured value and the smallest one the schema allows is a minute, which
   * is too long to wait for in a test of the deadline itself.
   */
  readonly runDeadlineMs?: number;
}

export type RunOutcome = 'accepted' | 'failed' | 'interrupted';

export interface RunTiming {
  readonly dispatchMs: number;
  readonly startupMs: number;
  readonly runtimeMs: number;
  readonly validationMs: number;
  readonly elapsedMs: number;
}

export interface RunManifest {
  readonly manifestVersion: typeof RUN_MANIFEST_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly createdAt: string;
  readonly request: { readonly text: string; readonly source: string; readonly contextRefs: ReadonlyArray<string> };
  readonly project: Record<string, unknown>;
  readonly base: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly agent: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
  readonly requirements: AcceptanceDecision['criteria'];
  readonly checks: ReadonlyArray<Record<string, unknown>>;
  readonly acceptance: Omit<AcceptanceDecision, 'criteria'>;
  readonly evidence: Record<string, unknown>;
  readonly timing: RunTiming;
  readonly usage: UsageReport;
  readonly unresolved: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<{ readonly type: string; readonly path: string; readonly sha256: string }>;
}

export interface RunDirectResult {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly taskState: string;
  readonly attemptState: string;
  readonly runState: string;
  readonly acceptance: AcceptanceDecision;
  readonly receipts: ReadonlyArray<CheckReceipt>;
  readonly snapshot: CandidateSnapshot | null;
  readonly workspace: CandidateWorkspace | null;
  readonly manifest: RunManifest;
  readonly manifestPath: string;
  readonly summaryPath: string;
  readonly patchPath: string | null;
  readonly runDir: string;
  readonly evidence: TurnEvidence | null;
  readonly stopReceipt: StopReceipt | null;
}

export class RunSetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunSetupError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The direct path
// ---------------------------------------------------------------------------

export async function runDirect(input: RunDirectInput): Promise<RunDirectResult> {
  const stream = input.stream ?? SILENT_STREAM;
  const timer = new PhaseTimer();
  const { db, paths } = input;
  const contextRefs = [...(input.contextRefs ?? [])];

  // ---- 1. Project inspection and registration (FR019) --------------------
  const dispatchSpan = timer.begin('dispatch');
  const inspection = await inspectProject(input.repoPath);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    dispatchSpan.end();
    throw new RunSetupError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository; the direct path works on an existing Git project`);
  }
  if (inspection.headRevision === null) {
    dispatchSpan.end();
    throw new RunSetupError('no_committed_base', `${inspection.repositoryRoot} has no commits; there is no committed base revision to start a candidate from`);
  }
  const projectRoot = inspection.repositoryRoot;
  const baseRevision = inspection.headRevision;
  for (const diagnostic of inspection.diagnostics) stream.line(`note: ${diagnostic}`);

  // ---- 2. Agent binding and adapter --------------------------------------
  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  if (!input.config.agents.some((agent) => agent.id === agentId)) {
    dispatchSpan.end();
    throw new RunSetupError('unknown_agent', `agent "${agentId}" is not defined in ${input.configPath}; configured agents: ${input.config.agents.map((a) => `"${a.id}"`).join(', ')}`);
  }
  const snapshot = computeAgentSnapshot(input.config, agentId);
  const binding: EffectiveAgentBinding = snapshot.binding;
  const limits: Limits = limitsFromDefaults(input.config.defaults);
  const policy: Policy = binding.policy;

  // Identities are minted before the adapter so the adapter can be told where
  // its raw capture belongs. They are values only; no directory is created
  // until the run is past every refusal below.
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  const adapter = (input.adapterFactory ?? createAdapter)(
    { id: binding.runtime.id, adapter: binding.runtime.adapter, executable: binding.runtime.executable },
    { runId, taskId, attemptId, logsDir: path.join(paths.runArtifactsDir(runId), 'logs') },
  );
  const settings = validateBindingSettings(adapter, binding);
  if (!settings.ok) {
    dispatchSpan.end();
    const problems = [settings.model, settings.effort].filter((report) => report.status === 'unsupported').map((report) => report.message);
    throw new RunSetupError('unsupported_runtime_setting', `agent "${agentId}" requests settings the ${adapter.id} adapter does not support: ${problems.join('; ')}`);
  }

  // ---- 3. Acceptance checks, pinned to the base revision (FR049) ---------
  const resolvedChecks = await resolveAcceptanceChecks(projectRoot, baseRevision, input.checkFlags ?? []);
  if (resolvedChecks.checks.length === 0) {
    dispatchSpan.end();
    throw new RunSetupError(
      'no_acceptance_checks',
      `${resolvedChecks.detail}. A task cannot be accepted without independently executed evidence, so the run is refused before any work starts.`,
    );
  }
  stream.line(`acceptance: ${resolvedChecks.detail}`);

  // What the criteria actually execute. The definitions are pinned to the
  // base, but their fixtures live in the repository, so the run has to know
  // which files a candidate must not rewrite.
  const baseFiles = await listFilesAtRevision(projectRoot, baseRevision);
  const surface = acceptanceSurface(resolvedChecks.checks, baseFiles);
  const fixturePaths = surfacePaths(surface);
  if (fixturePaths.length > 0) {
    stream.line(`acceptance fixtures (the worker must not rewrite these; new test files are fine): ${fixturePaths.join(', ')}`);
  }

  // ---- 4. Durable records ------------------------------------------------
  const createdAt = nowIso();
  ensureRunDir(paths, runId);
  const runDir = paths.runDir(runId);

  const request = validateRunRequest({
    requestVersion: RUN_REQUEST_VERSION,
    runId,
    text: input.requestText,
    contextRefs,
    repoPath: projectRoot,
    baseMode: 'head',
    submittedAt: createdAt,
  });
  const contract = buildContract(input.requestText, resolvedChecks.checks, fixturePaths);

  const project = registerProject(db, { inspection, dataLocation: paths.root, checks: resolvedChecks.checks, now: createdAt });
  insertRun(db, { request, policy, limits, projectId: project.id, baseRevision, now: createdAt });
  insertTask(db, { id: taskId, runId, contract, ownerAgentId: agentId, contextRefs, now: createdAt });
  upsertAgentSnapshot(db, snapshot, createdAt);
  const workspacePath = paths.workspaceDir(runId, taskId, attemptId);
  insertAttempt(db, { id: attemptId, taskId, agentSnapshotHash: snapshot.hash, runtimeId: binding.runtime.id, workspacePath, now: createdAt });

  writeFileSync(paths.runRequestPath(runId), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(paths.runContractPath(runId), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    paths.runConfigSnapshotPath(runId),
    `${JSON.stringify({ configPath: input.configPath, agentId, snapshotHash: snapshot.hash, binding, raw: JSON.parse(input.configRaw) as unknown }, null, 2)}\n`,
    { mode: 0o600 },
  );

  appendEvent(db, {
    runId,
    taskId,
    type: 'run.created',
    payload: {
      repoPath: projectRoot,
      baseRevision,
      branch: inspection.branch,
      dirty: describeDirty(inspection.dirty),
      uncommittedChangesExcluded: !inspection.dirty.clean,
      agentId,
      adapter: adapter.id,
      checkSource: resolvedChecks.source,
    },
    timestamp: createdAt,
  });
  transitionRun(db, runId, 'running');
  transitionTask(db, taskId, 'ready');

  stream.line(`run ${runId}`);
  stream.line(`repo ${projectRoot} @ ${baseRevision.slice(0, 12)}${inspection.branch !== null ? ` (${inspection.branch})` : ' (detached HEAD)'}`);
  if (!inspection.dirty.clean) {
    stream.line(`note: uncommitted changes are excluded from the candidate (${describeDirty(inspection.dirty)}); the base is the committed HEAD`);
  }
  stream.line(`agent ${agentId} via ${binding.runtime.id} (${adapter.id})`);
  stream.event({ type: 'run.created', runId, taskId, attemptId, repo: projectRoot, baseRevision, agentId, adapter: adapter.id });

  // ---- 5. Dispatch intent BEFORE any effect (FR065) ----------------------
  const operation = recordIntent(db, {
    runId,
    taskId,
    attemptId,
    kind: 'dispatch_worker',
    intent: {
      agentId,
      snapshotHash: snapshot.hash,
      adapter: adapter.id,
      runtimeId: binding.runtime.id,
      workspacePath,
      baseRevision,
      criteria: contract.acceptanceCriteria.map((criterion) => criterion.id),
    },
  });

  let workspace: CandidateWorkspace | null = null;
  let session: SessionHandle | null = null;
  let turn: TurnHandle | null = null;
  let stopReceipt: StopReceipt | null = null;
  let candidateSnapshot: CandidateSnapshot | null = null;
  let evidence: TurnEvidence | null = null;
  let interrupted = false;
  let turnConclusion: 'completed' | 'interrupted' | 'runtime_exited' | 'no_turn' = 'no_turn';
  const unresolved: string[] = [];
  const runtimeEvents: RuntimeEvent[] = [];
  let receipts: CheckReceipt[] = [];

  // Stopping the worker (plan section 9): request runtime interruption, wait a
  // bounded time for the runtime to acknowledge, then terminate the process
  // group we own. Without the second step a runtime that stops reading its
  // input keeps the event loop below open forever and Ctrl+C never lands.
  const deadlineMs = input.runDeadlineMs ?? limits.runTimeoutMinutes * 60_000;
  let interruptReason: 'signal' | 'run_deadline' | null = null;
  let escalating = false;
  let escalation: Promise<void> | null = null;
  let interruptStopReceipt: StopReceipt | null = null;

  const escalateInterruption = async (): Promise<void> => {
    if (escalating) return;
    escalating = true;
    let acknowledgement: 'observed' | 'requested' | 'failed' | 'no_turn' = 'no_turn';
    let detail: string | null = null;
    if (turn !== null) {
      try {
        const receipt = await withDeadline(adapter.interrupt(turn), INTERRUPT_ACKNOWLEDGEMENT_MS);
        acknowledgement = receipt === null ? 'requested' : receipt.state === 'observed' ? 'observed' : 'requested';
        if (receipt === null) detail = `the runtime did not answer turn interruption within ${INTERRUPT_ACKNOWLEDGEMENT_MS}ms`;
      } catch (error) {
        acknowledgement = 'failed';
        detail = (error as Error).message;
      }
    }
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'run.interrupt_acknowledged',
      payload: { reason: interruptReason, acknowledgement, detail, at: nowIso() },
    });
    if (acknowledgement === 'observed') {
      stream.line('  the runtime acknowledged the interruption and ended the turn');
      return;
    }
    // No observed end of turn inside the budget: terminate what we own, which
    // also ends the event stream this run is waiting on.
    if (session !== null) {
      stream.line(`  the runtime did not end the turn within ${INTERRUPT_ACKNOWLEDGEMENT_MS}ms; terminating the owned process group`);
      try {
        interruptStopReceipt = await adapter.stopOwnedProcesses(session);
        appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stopped', payload: { ...interruptStopReceipt, cause: 'interruption_escalation' } });
        stream.line(`  worker stopped: ${interruptStopReceipt.state}${interruptStopReceipt.detail !== undefined ? ` (${interruptStopReceipt.detail})` : ''}`);
      } catch (error) {
        appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stop_failed', payload: { message: (error as Error).message } });
        stream.line(`  could not stop the owned process group: ${(error as Error).message}`);
      }
    }
  };

  const beginInterruption = (reason: 'signal' | 'run_deadline'): void => {
    if (interrupted) return;
    interrupted = true;
    interruptReason = reason;
    // Persist the interruption intent before anything is signalled.
    appendEvent(db, { runId, taskId, attemptId, type: 'run.interrupt_requested', payload: { reason, at: nowIso() } });
    stream.line(
      reason === 'signal'
        ? 'interrupt requested: stopping the worker and preserving what exists'
        : `run deadline of ${deadlineMs}ms reached: stopping the worker and preserving what exists`,
    );
    escalation = escalateInterruption();
    escalation.catch(() => undefined);
  };

  const onAbort = (): void => beginInterruption('signal');
  if (input.signal !== undefined) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }

  // FR014: `runTimeoutMinutes` is a real deadline, not a number in a manifest.
  // A runtime that never ends its turn is stopped here rather than hanging the
  // coordinator until someone notices.
  const deadlineTimer = setTimeout(() => beginInterruption('run_deadline'), deadlineMs);
  deadlineTimer.unref?.();

  try {
    // ---- 6. Candidate workspace (FR041) ----------------------------------
    workspace = await createCandidateWorkspace({
      projectRoot,
      baseRevision,
      runId,
      taskId,
      attemptId,
      workspaceRoot: paths.workspaceRoot,
      excludedDirty: inspection.dirty.clean ? null : inspection.dirty,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    const grants = candidateWritePaths(workspace);
    // Protect the coordinator's own files. The default workspace root lives
    // under the state root, so the root itself cannot be the boundary.
    assertGrantedPathsSafe(workspace, grants, [paths.databasePath, paths.lockPath, paths.manifestPath, paths.runsDir]);
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'workspace.created',
      payload: { path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision, excludedUncommittedChanges: workspace.excludedUncommittedChanges !== null },
    });
    stream.line(`candidate workspace ${workspace.path} on branch ${workspace.branch}`);
    stream.event({ type: 'workspace.created', path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision });

    // Still the one mutating coordinator for this state root? Ask before a
    // worker exists, not after.
    input.ownership?.assertOwnership();
    markDispatched(db, operation.id, { workspacePath: workspace.path, branch: workspace.branch });
    transitionTask(db, taskId, 'running');
    dispatchSpan.end();

    if (interrupted) throw new InterruptedError();

    // ---- 7. Session and turn ---------------------------------------------
    const startupSpan = timer.begin('startup');
    const sessionEnv: Record<string, string> = { ...(input.sessionEnv ?? {}) };
    const scenario = process.env[FAKE_SCENARIO_ENV];
    if (adapter.id === 'fake' && scenario !== undefined && sessionEnv[FAKE_SCENARIO_ENV] === undefined) sessionEnv[FAKE_SCENARIO_ENV] = scenario;

    session = await adapter.openSession({
      cwd: workspace.path,
      allowedWritePaths: grants,
      policy,
      systemInstructions: binding.instructions,
      ...(binding.runtime.model !== undefined ? { model: binding.runtime.model } : {}),
      ...(binding.runtime.effort !== undefined ? { effort: binding.runtime.effort } : {}),
      ...(Object.keys(sessionEnv).length > 0 ? { env: sessionEnv } : {}),
    });
    startupSpan.end();

    const workerProcess: ProcessIdentity | null = session.process ?? null;
    appendEvent(db, { runId, taskId, attemptId, type: 'session.opened', payload: { adapter: adapter.id, sessionId: session.sessionId, processId: session.processId ?? null } });
    stream.event({ type: 'session.opened', adapter: adapter.id, sessionId: session.sessionId, processId: session.processId ?? null });

    const prompt = composeTaskPrompt({ requestText: input.requestText, contextRefs, workspace, inspection, contract });
    const runtimeSpan = timer.begin('runtime');
    turn = await adapter.startTurn(session, { prompt, contextRefs });
    // One transition records session, process identity and turn together:
    // an attempt is "running" once it actually has a turn.
    transitionAttempt(db, attemptId, 'running', {
      runtime: {
        sessionId: session.sessionId,
        turnId: turn.turnId,
        ...(workerProcess !== null ? { process: workerProcess } : {}),
      },
    });
    appendEvent(db, { runId, taskId, attemptId, type: 'turn.started', payload: { sessionId: session.sessionId, turnId: turn.turnId, promptCharacters: prompt.length } });
    if (interrupted) void adapter.interrupt(turn).catch(() => undefined);

    // Human lines are a readable trace of what the worker did; the complete
    // stream still reaches --json, events.jsonl and the adapter's raw capture.
    const workspaceRootForDisplay = workspace.path;
    const shorten = (value: string): string => (isWithin(workspaceRootForDisplay, value) ? path.relative(workspaceRootForDisplay, value) || '.' : value);
    for await (const event of adapter.events(turn)) {
      runtimeEvents.push(event);
      recordRuntimeEvent(db, event, { runId, taskId, attemptId, paths });
      stream.event({ type: `runtime.${event.kind}`, sequence: event.sequence, turnId: event.turnId, rawRef: event.rawRef, payload: event.payload });
      const line = renderRuntimeEvent(event, shorten);
      if (line !== null) stream.line(line);
      if (event.kind === 'turn_completed') turnConclusion = 'completed';
      else if (event.kind === 'turn_interrupted') turnConclusion = 'interrupted';
      else if (event.kind === 'error' && event.payload['fatal'] === true) turnConclusion = 'runtime_exited';
    }
    runtimeSpan.end();
    evidence = summarizeTurnEvidence(runtimeEvents);
    if (evidence.rawEvents > 0) {
      // Say how much was not shown rather than printing every unnormalized
      // notification: they are well-formed runtime output, not errors.
      stream.line(`  (${evidence.rawEvents} further runtime event(s) kept verbatim as evidence, not shown here)`);
    }

    if (turnConclusion === 'runtime_exited') {
      unresolved.push(`the runtime process ended before the turn completed (${describeExit(runtimeEvents)}); the candidate contains only what it had written by then`);
    }
    for (const escaped of evidence.fileChangesOutsideAllowedPaths) {
      unresolved.push(`the worker wrote outside its granted paths: ${escaped}; that change is not part of the candidate`);
    }

    // ---- 8. Stop owned processes, then freeze the candidate --------------
    // An interruption may already have terminated the group; wait for that to
    // finish rather than signalling the same tree from two places.
    if (escalation !== null) await escalation;
    if (interruptStopReceipt !== null) {
      stopReceipt = interruptStopReceipt;
    } else {
      stopReceipt = await adapter.stopOwnedProcesses(session);
      appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stopped', payload: { ...stopReceipt } });
      stream.line(`worker stopped: ${stopReceipt.state}${stopReceipt.detail !== undefined ? ` (${stopReceipt.detail})` : ''}`);
    }
    if (stopReceipt.state !== 'process_tree_terminated') {
      unresolved.push(`the worker's process tree was not observed terminated (${stopReceipt.state}${stopReceipt.detail !== undefined ? `: ${stopReceipt.detail}` : ''})`);
    }

    const validationSpan = timer.begin('validation');
    candidateSnapshot = await snapshotCandidate(workspace, {
      writer: workerProcess,
      patchPath: path.join(runDir, 'snapshots', `${attemptId}.patch`),
      ...(input.signal !== undefined && !interrupted ? { signal: input.signal } : {}),
    });
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'candidate.snapshot',
      payload: {
        baseRevision: candidateSnapshot.baseRevision,
        candidateRevision: candidateSnapshot.candidateRevision,
        patchHash: candidateSnapshot.patchHash,
        changedFileCount: candidateSnapshot.changedFiles.length,
        checkpointCreated: candidateSnapshot.checkpointCreated,
      },
    });
    stream.line(
      candidateSnapshot.checkpointCreated
        ? `candidate ${candidateSnapshot.candidateRevision.slice(0, 12)} on ${candidateSnapshot.branch}: ${candidateSnapshot.changedFiles.length} changed file(s), patch ${candidateSnapshot.patchHash.slice(0, 12)}`
        : `candidate is identical to the base ${candidateSnapshot.baseRevision.slice(0, 12)}: the worker changed nothing`,
    );
    for (const change of candidateSnapshot.changes) stream.line(`  ${change.status} ${change.path}`);
    if (!candidateSnapshot.checkpointCreated) unresolved.push('the worker produced no change to the repository');

    if (interrupted) {
      validationSpan.end();
      throw new InterruptedError();
    }

    // ---- 9. Verifier-executed checks (FR049, FR050) ----------------------
    stream.line(`running ${contract.acceptanceCriteria.length} acceptance check(s) against the frozen candidate`);
    receipts = await runChecks({
      candidate: { repoRoot: projectRoot, revision: candidateSnapshot.candidateRevision, patchHash: candidateSnapshot.patchHash },
      checks: resolvedChecks.checks,
      outputRoot: path.join(runDir, 'verification'),
      ...(input.keepCheckCopies !== undefined ? { keepCopies: input.keepCheckCopies } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      onReceipt: (receipt) => {
        stream.line(`  check ${receipt.criterionId}: ${receipt.outcome}${receipt.exitCode !== null ? ` (exit ${receipt.exitCode})` : ''} in ${receipt.durationMs}ms`);
        stream.event({ type: 'check.completed', criterionId: receipt.criterionId, outcome: receipt.outcome, exitCode: receipt.exitCode, durationMs: receipt.durationMs, evidenceProvenance: receipt.evidenceProvenance });
      },
    });
    validationSpan.end();
  } catch (error) {
    if (!(error instanceof InterruptedError)) {
      // Preserve the failure honestly: the attempt failed, the run failed, the workspace is kept.
      transitionRunSafely(db, runId, 'failed');
      transitionTaskSafely(db, taskId, 'failed');
      transitionAttemptSafely(db, attemptId, 'failed', { outcome: { error: (error as Error).message } });
      recordReceiptSafely(db, operation.id, 'failed', { error: (error as Error).message });
      appendEvent(db, { runId, taskId, attemptId, type: 'run.failed', payload: { message: (error as Error).message } });
      projectEventsJsonl(db, paths, runId);
      throw error;
    }
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener('abort', onAbort);
  }

  // ---- 10. Persist evidence and decide acceptance ------------------------
  // Losing exclusive ownership here is not a check failure; it means this
  // process can no longer say what the state root contains. Record why the run
  // stops and leave the rest alone rather than writing a result over work
  // another coordinator may be doing.
  try {
    input.ownership?.assertOwnership();
  } catch (error) {
    appendEvent(db, { runId, taskId, attemptId, type: 'run.ownership_lost', payload: { message: (error as Error).message } });
    transitionAttemptSafely(db, attemptId, 'failed', { outcome: { turnConclusion, ownershipLost: true }, uncertain: true });
    transitionTaskSafely(db, taskId, 'failed');
    transitionRunSafely(db, runId, 'failed');
    recordReceiptSafely(db, operation.id, 'failed', { ownershipLost: true, candidateRevision: candidateSnapshot?.candidateRevision ?? null });
    projectEventsJsonl(db, paths, runId);
    throw error;
  }
  const persistedChecks = receipts.length > 0 ? persistCheckReceipts(db, paths, { runId, taskId, attemptId, receipts }) : [];

  // Did the candidate rewrite the code its own criteria execute? The check
  // definitions are pinned to the base revision, but their fixtures are in the
  // repository, so this is the difference between "the tests pass" and "the
  // worker replaced the tests".
  const surfaceFindings = candidateSnapshot === null ? { mutations: [], additions: [], definitionChanges: [] } : findSurfaceChanges(surface, candidateSnapshot.changes);
  for (const mutation of surfaceFindings.mutations) {
    unresolved.push(
      `the candidate changed files that criterion "${mutation.criterionId}" executes (${mutation.changedPaths.join(', ')}); the check result cannot establish the criterion the base revision defined`,
    );
  }
  if (surfaceFindings.additions.length > 0) {
    unresolved.push(`the candidate added ${surfaceFindings.additions.length} file(s) under the acceptance fixtures (${surfaceFindings.additions.join(', ')}); added tests do not block acceptance, but they were not part of the original criteria`);
  }
  for (const change of surfaceFindings.definitionChanges) {
    unresolved.push(`the candidate changed an acceptance definition (${change}); this run read the definition from the base revision, so the change did not affect it, but a later run would use the new one`);
  }

  // Facts that block acceptance whatever the receipts say. Each one means the
  // run cannot honestly claim "verified candidate" (plan section 9, AT02, AT12).
  const blockers: string[] = [];
  for (const escaped of evidence?.fileChangesOutsideAllowedPaths ?? []) {
    blockers.push(`the worker wrote outside its granted paths (${escaped}); an observed escape is not an accepted run`);
  }
  if (turnConclusion === 'runtime_exited') {
    blockers.push(`the runtime process ended before the turn completed (${describeExit(runtimeEvents)}); a candidate produced by a crashed turn is not accepted`);
  }
  if (candidateSnapshot !== null && !candidateSnapshot.checkpointCreated) {
    blockers.push('the worker produced no change, so there is no candidate to accept; passing checks on an unchanged base are not evidence that the task was done');
  }

  const acceptance = decideAcceptance(
    contract.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description })),
    receipts,
    { fixtureMutations: surfaceFindings.mutations, blockers },
  );

  const artifacts: ArtifactRecord[] = [];
  let patchArtifact: ArtifactRecord | null = null;
  if (candidateSnapshot !== null) {
    patchArtifact = writeArtifact(db, paths, {
      runId,
      taskId,
      attemptId,
      type: 'candidate_patch',
      relativePath: 'candidate.patch',
      bytes: readFileSync(candidateSnapshot.patchPath),
      baseRevision: candidateSnapshot.baseRevision,
      candidateRevision: candidateSnapshot.candidateRevision,
      provenance: { producer: 'snapshotCandidate', branch: candidateSnapshot.branch, patchHash: candidateSnapshot.patchHash, checkpointCreated: candidateSnapshot.checkpointCreated },
    });
    artifacts.push(patchArtifact);
    if (patchArtifact.sha256 !== candidateSnapshot.patchHash) {
      unresolved.push('the stored candidate patch does not hash to the recorded candidate identity');
    }
  }
  if (runtimeEvents.length > 0) {
    artifacts.push(
      writeArtifact(db, paths, {
        runId,
        taskId,
        attemptId,
        type: 'runtime_event_log',
        relativePath: 'logs/runtime-events.jsonl',
        bytes: `${runtimeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        provenance: { producer: 'runDirect', adapter: adapter.id, sessionId: session?.sessionId ?? null, note: 'normalized adapter events for this attempt' },
      }),
    );
  }
  artifacts.push(...persistedChecks.flatMap((check) => [check.logArtifact, check.stderrArtifact, check.receiptArtifact]));

  // ---- 11. Lifecycle -----------------------------------------------------
  const timing = summarizeTiming(timer);
  let outcome: RunOutcome;
  if (interrupted) {
    outcome = 'interrupted';
    unresolved.push(
      interruptReason === 'run_deadline'
        ? `the run reached its ${deadlineMs}ms deadline before acceptance and the worker was stopped; resume creates a new attempt generation for this task`
        : 'the run was interrupted before acceptance; resume creates a new attempt generation for this task',
    );
    transitionAttemptSafely(db, attemptId, 'interrupted', { outcome: { turnConclusion, interrupted: true }, uncertain: turnConclusion === 'no_turn' });
    transitionTaskSafely(db, taskId, 'cancelled');
    transitionRunSafely(db, runId, 'interrupted');
    recordReceiptSafely(db, operation.id, 'completed', { interrupted: true, turnConclusion, candidateRevision: candidateSnapshot?.candidateRevision ?? null });
  } else {
    transitionAttemptSafely(db, attemptId, turnConclusion === 'runtime_exited' ? 'failed' : 'completed', {
      outcome: { turnConclusion, claimedDone: evidence?.claimedDone ?? false, changedFiles: candidateSnapshot?.changedFiles.length ?? 0 },
    });
    recordReceiptSafely(db, operation.id, turnConclusion === 'runtime_exited' ? 'failed' : 'completed', {
      turnConclusion,
      candidateRevision: candidateSnapshot?.candidateRevision ?? null,
      patchHash: candidateSnapshot?.patchHash ?? null,
    });
    transitionTask(db, taskId, 'validating');
    if (acceptance.accepted) {
      outcome = 'accepted';
      transitionTask(db, taskId, 'accepted');
      transitionRun(db, runId, 'ready_for_review');
    } else {
      outcome = 'failed';
      transitionTask(db, taskId, 'failed');
      transitionRun(db, runId, 'failed');
    }
  }

  appendEvent(db, {
    runId,
    taskId,
    attemptId,
    type: `run.${outcome}`,
    payload: {
      outcome,
      accepted: acceptance.accepted,
      requiredPassed: acceptance.requiredPassed,
      requiredTotal: acceptance.requiredTotal,
      candidateRevision: candidateSnapshot?.candidateRevision ?? null,
      reasons: acceptance.reasons.slice(0, 10),
    },
  });

  // ---- 12. Manifest and human summary (FR059, FR060) ---------------------
  const manifest: RunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    runId,
    taskId,
    attemptId,
    outcome,
    createdAt,
    request: { text: input.requestText, source: input.requestSource, contextRefs },
    project: {
      canonicalPath: projectRoot,
      requestedPath: inspection.canonicalPath,
      repositoryIdentity: inspection.repositoryIdentity,
      branch: inspection.branch,
      detachedHead: inspection.detachedHead,
      hasSubmodules: inspection.hasSubmodules,
      projectId: project.id,
    },
    base: {
      mode: 'head',
      revision: baseRevision,
      uncommittedChangesExcluded: inspection.dirty.clean ? null : inspection.dirty,
      note: inspection.dirty.clean
        ? 'the checkout was clean; the committed HEAD is the complete base'
        : 'uncommitted changes in the user\'s checkout were excluded from this candidate and left untouched',
    },
    candidate:
      candidateSnapshot === null
        ? { created: false, note: 'no candidate was frozen' }
        : {
            created: true,
            branch: candidateSnapshot.branch,
            revision: candidateSnapshot.candidateRevision,
            patchHash: candidateSnapshot.patchHash,
            patchBytes: candidateSnapshot.patchBytes,
            checkpointCreated: candidateSnapshot.checkpointCreated,
            changedFiles: candidateSnapshot.changes,
            workspacePath: workspace?.path ?? null,
            patchArtifactId: patchArtifact?.id ?? null,
          },
    agent: { id: agentId, snapshotHash: snapshot.hash, policy, instructionsCharacters: binding.instructions.length, limits },
    runtime: {
      adapter: adapter.id,
      runtimeId: binding.runtime.id,
      executable: binding.runtime.executable,
      model: settings.model.requested,
      modelStatus: settings.model.status,
      effort: settings.effort.requested,
      effortStatus: settings.effort.status,
      sessionId: session?.sessionId ?? null,
      turnId: turn?.turnId ?? null,
      turnConclusion,
      stopReceipt,
      interruptReason,
    },
    requirements: acceptance.criteria,
    checks: receipts.map((receipt) => ({
      criterionId: receipt.criterionId,
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      durationMs: receipt.durationMs,
      command: receipt.command,
      args: receipt.args,
      cwd: receipt.cwd,
      timeoutMs: receipt.timeoutMs,
      environmentIdentity: receipt.environmentIdentity,
      integrity: receipt.integrity,
      outputSummary: receipt.outputSummary,
      copyStrategy: receipt.copyStrategy,
      evidenceProvenance: receipt.evidenceProvenance,
      logArtifactId: persistedChecks.find((check) => check.checkId === receipt.id)?.logArtifact.id ?? null,
      diagnostics: receipt.diagnostics,
    })),
    acceptance: { accepted: acceptance.accepted, requiredTotal: acceptance.requiredTotal, requiredPassed: acceptance.requiredPassed, reasons: acceptance.reasons },
    evidence: {
      checkSource: resolvedChecks.source,
      checkSourceDetail: resolvedChecks.detail,
      runtimeClaimedDone: evidence?.claimedDone ?? false,
      runtimeReportedFileChanges: evidence?.fileChanges ?? [],
      writesOutsideGrantedPaths: evidence?.fileChangesOutsideAllowedPaths ?? [],
      runtimeToolCalls: evidence?.toolCalls ?? 0,
      runtimeCommands: evidence?.commandsExecuted ?? 0,
      runtimeErrors: evidence?.errors.length ?? 0,
      acceptanceFixturePaths: fixturePaths,
      acceptanceFixtureMutations: surfaceFindings.mutations,
      acceptanceFixtureAdditions: surfaceFindings.additions,
      acceptanceDefinitionChanges: surfaceFindings.definitionChanges,
      // Well-formed runtime output the adapter did not normalize — not
      // malformed lines, and not an error count.
      unnormalizedRuntimeEvents: evidence?.rawEvents ?? 0,
      verificationCopyStrategy: receipts[0]?.copyStrategy ?? null,
      note: 'acceptance is decided from verifier-executed check receipts, the integrity of the fixtures those receipts executed, and the run-level blockers listed under acceptance.reasons; the runtime-reported fields above are context, not evidence of correctness',
      containmentNote:
        'the candidate workspace is a linked Git worktree: development isolation, not a security sandbox. Write confinement is only what the runtime adapter reports as an enforced capability, and any write seen outside the granted paths is listed above and blocks acceptance. Reads are not confined by either installed runtime sandbox: a worker can read files outside the repository, and this run did not prevent that. Each check ran in a separate disposable copy of the frozen candidate under a sanitized environment, but with this user\'s own filesystem privileges: repository test code could still read or write anything this user can, including the coordinator state root. An enforced execution boundary for tool and test subprocesses (FR042) is an R1 gate and is not claimed by this run; acceptance compensates only by refusing evidence whose fixtures the candidate changed.',
    },
    timing,
    usage: usageFor(adapter, session),
    unresolved,
    artifacts: artifacts.map((artifact) => ({ type: artifact.type, path: artifact.relativePath, sha256: artifact.sha256 })),
  };

  const manifestArtifact = writeArtifact(db, paths, {
    runId,
    taskId,
    attemptId,
    type: 'result',
    relativePath: 'result.json',
    bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    baseRevision,
    candidateRevision: candidateSnapshot?.candidateRevision ?? null,
    provenance: { producer: 'runDirect', manifestVersion: RUN_MANIFEST_VERSION },
  });
  const summaryArtifact = writeArtifact(db, paths, {
    runId,
    taskId,
    attemptId,
    type: 'summary',
    relativePath: 'summary.md',
    bytes: renderSummary(manifest),
    baseRevision,
    candidateRevision: candidateSnapshot?.candidateRevision ?? null,
    provenance: { producer: 'runDirect' },
  });
  projectEventsJsonl(db, paths, runId);

  const artifactsDir = paths.runArtifactsDir(runId);
  if (candidateSnapshot !== null && candidateSnapshot.checkpointCreated) {
    // The change itself, not only a path to it: R0's terminal has to show the
    // resulting diff. Long diffs are cut off and the full patch path is given.
    stream.line(`candidate diff (${candidateSnapshot.baseRevision.slice(0, 12)} → ${candidateSnapshot.candidateRevision.slice(0, 12)}):`);
    for (const line of previewPatch(readFileSync(candidateSnapshot.patchPath, 'utf8'))) stream.line(line);
  }
  stream.line(`artifacts: ${artifactsDir}`);
  stream.line(`  result.json · summary.md${patchArtifact !== null ? ' · candidate.patch' : ''}${persistedChecks.length > 0 ? ' · checks/' : ''}${runtimeEvents.length > 0 ? ' · logs/' : ''}`);
  stream.line(
    outcome === 'accepted'
      ? `accepted: ${acceptance.requiredPassed}/${acceptance.requiredTotal} required criteria passed with verifier-executed evidence`
      : outcome === 'interrupted'
        ? 'interrupted: work preserved on the candidate branch, nothing accepted'
        : `not accepted: ${acceptance.reasons.join('; ') || 'no acceptance evidence'}`,
  );
  stream.event({ type: `run.${outcome}`, runId, accepted: acceptance.accepted, candidateRevision: candidateSnapshot?.candidateRevision ?? null });

  return {
    runId,
    taskId,
    attemptId,
    outcome,
    taskState: outcome === 'accepted' ? 'accepted' : outcome === 'interrupted' ? 'cancelled' : 'failed',
    attemptState: interrupted ? 'interrupted' : turnConclusion === 'runtime_exited' ? 'failed' : 'completed',
    runState: outcome === 'accepted' ? 'ready_for_review' : outcome === 'interrupted' ? 'interrupted' : 'failed',
    acceptance,
    receipts,
    snapshot: candidateSnapshot,
    workspace,
    manifest,
    manifestPath: path.join(artifactsDir, manifestArtifact.relativePath),
    summaryPath: path.join(artifactsDir, summaryArtifact.relativePath),
    patchPath: patchArtifact === null ? null : path.join(artifactsDir, patchArtifact.relativePath),
    runDir,
    evidence,
    stopReceipt,
  };
}

class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContract(requestText: string, checks: ReadonlyArray<CheckSpec>, acceptanceFixturePaths: ReadonlyArray<string> = []): TaskContract {
  const firstLine = requestText.trim().split('\n')[0] ?? requestText.trim();
  return validateTaskContract({
    contractVersion: TASK_CONTRACT_VERSION,
    objective: firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine,
    // The acceptance fixtures are forbidden because rewriting them is how a
    // worker would manufacture a pass, and the run refuses acceptance when it
    // sees that happen. Adding a new test file is still allowed.
    scope: { description: 'the candidate workspace for this attempt', allowedPaths: [], forbiddenPaths: ['.git', ...acceptanceFixturePaths] },
    acceptanceCriteria: checks.map((check) => ({
      id: check.criterionId,
      description: check.description ?? `${check.command} ${(check.args ?? []).join(' ')}`.trim(),
      check: {
        command: check.command,
        args: [...(check.args ?? [])],
        ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      },
    })),
    dependencies: [],
    constraints: ['Do not modify Git administration or create commits; the coordinator owns candidate history.'],
    evidenceRequirements: ['every required criterion needs a check the verifier executed against the frozen candidate'],
  });
}

/**
 * One human line per meaningful runtime action, or `null` for an event that
 * should not produce one.
 *
 * Two rules keep the terminal readable without hiding anything:
 *
 * - an adapter reports the same action twice (`phase: "started"`, then
 *   `phase: "completed"`). The line is printed when the action starts, so
 *   progress is visible as it happens, and repeated on completion only when
 *   the completion carries something new — an exit code, a refusal;
 * - `raw` events are well-formed runtime output the adapter did not normalize
 *   (MCP server startup, reasoning items, token usage, unknown methods). They
 *   are counted and summarized after the turn instead of printed one by one.
 *
 * Nothing is dropped: every event still reaches `--json`, `events.jsonl` and
 * the adapter's raw capture.
 */
function renderRuntimeEvent(event: RuntimeEvent, shorten: (value: string) => string = (value) => value): string | null {
  const payload = event.payload;
  const phase = typeof payload['phase'] === 'string' ? (payload['phase'] as string) : null;
  switch (event.kind) {
    case 'session_started': {
      const id = payload['threadId'] ?? payload['sessionId'] ?? event.sessionId;
      return `  runtime session ${String(id)} started`;
    }
    case 'turn_started':
      return '  turn started';
    case 'assistant_message':
      return `  message: ${truncateLine(String(payload['text'] ?? ''))}`;
    case 'tool_call':
      return `  tool ${String(payload['tool'] ?? 'unknown')}${payload['path'] !== undefined ? ` ${shorten(String(payload['path']))}` : ''}`;
    case 'tool_result':
      return `  tool ${String(payload['tool'] ?? 'unknown')} -> ${payload['status'] ?? (payload['ok'] === true ? 'ok' : 'failed')}`;
    case 'file_change': {
      const where = payload['path'] === null || payload['path'] === undefined ? '(path not reported)' : shorten(String(payload['path']));
      if (payload['withinAllowedPaths'] === false) return `  changed ${where} (OUTSIDE the granted paths; not part of the candidate)`;
      if (payload['denied'] === true) return `  change denied: ${where}`;
      // The write is only real once it is applied; the started phase is noise.
      return phase === 'started' ? null : `  changed ${where}`;
    }
    case 'command_exec': {
      const command = truncateLine(String(payload['command'] ?? ''));
      if (phase === 'started' || phase === null) return `  exec ${command}`;
      if (payload['denied'] === true) return `  exec denied: ${command}`;
      const exitCode = payload['exitCode'];
      return typeof exitCode === 'number' ? `  exec -> exit ${exitCode}` : null;
    }
    case 'turn_completed':
      return '  turn completed';
    case 'turn_interrupted':
      return '  turn interrupted';
    case 'error':
      return `  runtime error: ${truncateLine(JSON.stringify(payload))}`;
    case 'raw':
      // Counted and summarized once the turn ends; see the caller.
      return null;
    default:
      return `  ${event.kind}`;
  }
}

export const MAX_PATCH_PREVIEW_LINES = 120;

/**
 * The candidate diff as terminal lines, cut off at a bounded length. A big
 * change must not flood the terminal, and the cut is stated rather than left
 * for the reader to notice; the complete patch is always on disk.
 */
export function previewPatch(patch: string, maxLines = MAX_PATCH_PREVIEW_LINES): string[] {
  const lines = patch.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.map((line) => `  ${line}`);
  const shown = lines.slice(0, maxLines).map((line) => `  ${line}`);
  shown.push(`  … ${lines.length - maxLines} more diff line(s); the complete patch is candidate.patch`);
  return shown;
}

function truncateLine(text: string, max = 160): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function describeExit(events: ReadonlyArray<RuntimeEvent>): string {
  const fatal = [...events].reverse().find((event) => event.kind === 'error' && event.payload['fatal'] === true);
  if (fatal === undefined) return 'no exit detail recorded';
  const code = fatal.payload['exitCode'];
  const signal = fatal.payload['signal'];
  return `reason ${String(fatal.payload['reason'] ?? 'unknown')}, exit ${String(code)}${signal ? `, signal ${String(signal)}` : ''}`;
}

function summarizeTiming(timer: PhaseTimer): RunTiming {
  const summary = timer.summary();
  return {
    dispatchMs: Math.round(summary.phases.dispatch.totalMs),
    startupMs: Math.round(summary.phases.startup.totalMs),
    runtimeMs: Math.round(summary.phases.runtime.totalMs),
    validationMs: Math.round(summary.phases.validation.totalMs),
    elapsedMs: Math.round(summary.elapsedMs),
  };
}

/**
 * Token counts an adapter may expose beyond the shared contract. The shape is
 * validated here rather than trusted: an adapter that reports something else
 * yields "unavailable", never a guessed number.
 */
const ReportedTokenUsageSchema = z.looseObject({
  total: z
    .looseObject({
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
    })
    .optional(),
});

interface TokenUsageReporting {
  lastTokenUsage(session: SessionHandle): unknown;
}

function reportsTokenUsage(adapter: RuntimeAdapter): adapter is RuntimeAdapter & TokenUsageReporting {
  return typeof (adapter as Partial<TokenUsageReporting>).lastTokenUsage === 'function';
}

/**
 * FR060: separate measured from unavailable usage. Currency cost is never
 * inferred — no installed runtime reports a price, so `costUsd` stays null and
 * the source says so rather than presenting zero.
 */
function usageFor(adapter: RuntimeAdapter, session: SessionHandle | null): UsageReport {
  const report = adapter.capabilities().capabilities.usage_reporting;
  if (report.status === 'unsupported') {
    return { ...USAGE_UNAVAILABLE, source: `${adapter.id}: ${report.note ?? 'usage reporting is unsupported'}` };
  }
  if (session !== null && reportsTokenUsage(adapter)) {
    const parsed = ReportedTokenUsageSchema.safeParse(adapter.lastTokenUsage(session));
    const total = parsed.success ? parsed.data.total : undefined;
    const inputTokens = total?.inputTokens ?? null;
    const outputTokens = total?.outputTokens ?? null;
    if (inputTokens !== null || outputTokens !== null) {
      return {
        status: 'measured',
        inputTokens,
        outputTokens,
        costUsd: null,
        source: `${adapter.id}: token counts reported by the runtime for this session; it reports no currency cost, so cost is unavailable rather than zero`,
      };
    }
  }
  return { ...USAGE_UNAVAILABLE, source: `${adapter.id}: no usage was reported for this turn` };
}

function transitionRunSafely(db: DatabaseSync, runId: string, to: 'failed' | 'interrupted' | 'ready_for_review'): void {
  try {
    transitionRun(db, runId, to);
  } catch {
    // Already in a terminal state; the recorded state stays as it is.
  }
}

function transitionTaskSafely(db: DatabaseSync, taskId: string, to: 'failed' | 'cancelled'): void {
  try {
    transitionTask(db, taskId, to);
  } catch {
    // Already terminal.
  }
}

function transitionAttemptSafely(db: DatabaseSync, attemptId: string, to: 'failed' | 'completed' | 'interrupted', options: { outcome?: unknown; uncertain?: boolean } = {}): void {
  try {
    transitionAttempt(db, attemptId, to, options);
  } catch {
    // Already terminal.
  }
}

function recordReceiptSafely(db: DatabaseSync, operationId: string, outcome: 'completed' | 'failed', receipt: Record<string, unknown>): void {
  try {
    recordReceipt(db, operationId, { outcome, receipt });
  } catch {
    // A duplicate or conflicting receipt is already recorded; the first one wins.
  }
}

/** Human-readable run report: requirement by requirement, with the identities behind it. */
export function renderSummary(manifest: RunManifest): string {
  const lines: string[] = [];
  const candidate = manifest.candidate as Record<string, unknown>;
  lines.push(`# Run ${manifest.runId} — ${manifest.outcome}`);
  lines.push('');
  lines.push('## Request');
  lines.push('');
  lines.push('The user\'s original wording, unmodified:');
  lines.push('');
  lines.push('```text');
  lines.push(manifest.request.text.trimEnd());
  lines.push('```');
  lines.push('');
  lines.push('## Identities');
  lines.push('');
  lines.push(`- Repository: \`${String((manifest.project as Record<string, unknown>)['canonicalPath'])}\``);
  lines.push(`- Base revision: \`${String((manifest.base as Record<string, unknown>)['revision'])}\` (committed HEAD)`);
  lines.push(`- Uncommitted changes excluded: ${(manifest.base as Record<string, unknown>)['uncommittedChangesExcluded'] === null ? 'none, the checkout was clean' : 'yes, and the user\'s checkout was left untouched'}`);
  if (candidate['created'] === true) {
    lines.push(`- Candidate revision: \`${String(candidate['revision'])}\` on branch \`${String(candidate['branch'])}\``);
    lines.push(`- Candidate patch hash: \`${String(candidate['patchHash'])}\``);
  } else {
    lines.push('- Candidate: none was frozen');
  }
  lines.push(`- Agent: \`${String((manifest.agent as Record<string, unknown>)['id'])}\` (snapshot \`${String((manifest.agent as Record<string, unknown>)['snapshotHash']).slice(0, 12)}\`) on adapter \`${String((manifest.runtime as Record<string, unknown>)['adapter'])}\``);
  lines.push('');
  lines.push('## Requirement status');
  lines.push('');
  if (manifest.requirements.length === 0) {
    lines.push('No acceptance criteria were recorded.');
  } else {
    lines.push('| Criterion | Required | Status | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const requirement of manifest.requirements) {
      lines.push(`| \`${requirement.criterionId}\` | ${requirement.required ? 'yes' : 'no'} | ${requirement.status} | ${requirement.detail} |`);
    }
  }
  lines.push('');
  lines.push(`Acceptance: ${manifest.acceptance.accepted ? 'accepted' : 'not accepted'} (${manifest.acceptance.requiredPassed}/${manifest.acceptance.requiredTotal} required criteria passed).`);
  lines.push('');
  lines.push('Every status above comes from a check this coordinator executed itself against the frozen candidate. A runtime reporting success does not appear in this table.');
  lines.push('');
  lines.push('## Changed files');
  lines.push('');
  const changed = (candidate['changedFiles'] as Array<{ status: string; path: string }> | undefined) ?? [];
  if (changed.length === 0) lines.push('None: the candidate is identical to its base.');
  else for (const change of changed) lines.push(`- \`${change.status}\` ${change.path}`);
  lines.push('');
  lines.push('## Timing');
  lines.push('');
  lines.push(`- dispatch: ${manifest.timing.dispatchMs} ms`);
  lines.push(`- runtime startup: ${manifest.timing.startupMs} ms`);
  lines.push(`- model/runtime turn: ${manifest.timing.runtimeMs} ms`);
  lines.push(`- validation: ${manifest.timing.validationMs} ms`);
  lines.push(`- elapsed: ${manifest.timing.elapsedMs} ms`);
  lines.push('');
  lines.push(`Usage: ${manifest.usage.status} (${manifest.usage.source}).`);
  lines.push('');
  lines.push('## Unresolved');
  lines.push('');
  if (manifest.unresolved.length === 0) lines.push('Nothing unresolved was recorded.');
  else for (const item of manifest.unresolved) lines.push(`- ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
