/**
 * `POST /api/runs` — start a run from the office page (FR084).
 *
 * The page never runs anything itself and never owns task truth. A start
 * request becomes exactly one `workforce run --json` process — the same
 * command a terminal would type, so the same coordinator lock, preflight,
 * containment gate and verifier apply — spawned with an argument array and
 * `shell: false`. Task text is one argv element (`--task=<text>`), so no
 * character in it is ever interpreted by anything but `parseArgs`.
 *
 * The process is detached from the HTTP request: its stdout and stderr go to
 * files under `<state-root>/serve/launches/`, not to pipes this server holds,
 * so the run neither dies with the request nor with this server. The response
 * waits only until the coordinator has recorded the run (`run.created` on its
 * JSONL stdout) and returns that run id. If the process refuses before that,
 * its own error document is relayed with its own code.
 *
 * Refused before any process starts — fast answers to what the coordinator
 * would refuse anyway, which re-checks every one of them: an invalid body, a
 * repository path that is not absolute or not a directory, a directory that
 * is not a Git repository or has no commit, no or an invalid agent
 * configuration, an unknown agent, and a writing agent on a runtime with no
 * write boundary without an explicit `allowUnconfinedWrites`.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configSearchPath } from '../cli/commands/launch.js';
import { AgentIdSchema, ContractValidationError, formatZodIssues, type AgentDefinition } from '../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../core/config.js';
import { newId } from '../core/ids.js';
import {
  assessContainment,
  CheckConfigurationError,
  createAdapter,
  describeUnconfinedWrites,
  describeUntestedBoundary,
  resolveAcceptanceChecks,
  type ResolvedChecks,
} from '../core/run-direct.js';
import { readinessReportForRuntime, type RuntimeReadinessReport } from '../discovery/readiness.js';
import { runtimeDescriptor } from '../discovery/runtimes.js';
import type { StatePaths } from '../storage/paths.js';
import { describeDirty, inspectProject, type ProjectInspection } from '../workspaces/project.js';
import { ApiError } from './http.js';

/** Bound on task text: far below ARG_MAX, far above any real brief typed into a page. */
export const MAX_TASK_CHARS = 64_000;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const LAUNCH_POLL_MS = 100;

const noNul = (value: string): boolean => !value.includes('\0');

export const StartRunBodySchema = z.strictObject({
  repo: z.string().min(1).max(4096).refine(noNul, 'must not contain a NUL character'),
  task: z
    .string()
    .max(MAX_TASK_CHARS)
    .refine((value) => value.trim().length > 0, 'task text is empty')
    .refine(noNul, 'must not contain a NUL character'),
  agent: AgentIdSchema.optional(),
  allowUnconfinedWrites: z.boolean().optional(),
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;

/** `spawn`'s shape, so a test can observe exactly what would be executed. */
export type Spawner = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess;

/** How to execute this package's own CLI. */
export interface CliInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/** The CLI next to this module: `dist/cli/index.js` when built, `src/cli/index.ts` (through tsx) in development. */
export function defaultCliInvocation(): CliInvocation {
  const here = fileURLToPath(import.meta.url);
  const extension = path.extname(here);
  const entry = path.resolve(path.dirname(here), '..', 'cli', `index${extension}`);
  const cwd = path.resolve(path.dirname(here), '..', '..');
  return { command: process.execPath, args: extension === '.ts' ? ['--import', 'tsx', entry] : [entry], cwd };
}

export interface LauncherOptions {
  readonly paths: StatePaths;
  readonly spawner?: Spawner;
  readonly invocation?: CliInvocation;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface LaunchResult {
  readonly runId: string;
  readonly launchId: string;
  readonly pid: number | null;
}

export interface Launcher {
  start(body: unknown): Promise<LaunchResult>;
  readonly pending: boolean;
}

function parseBody(body: unknown): StartRunBody {
  const parsed = StartRunBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_body',
      'the start request is not valid',
      formatZodIssues(parsed.error.issues).map((issue) => `${issue.path}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function loadConfig(file: string): LoadedAgentConfig {
  try {
    return loadAgentConfigFile(file);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new ApiError(400, 'invalid_config', `agent configuration ${file} is invalid`, error.issues.map((issue) => `${issue.path}: ${issue.message}`));
    }
    throw error;
  }
}

/** The argv of the one process a start request becomes. Every value is its own `--flag=value` element. */
export function runArguments(input: { readonly repo: string; readonly task: string; readonly agentsPath: string; readonly stateRoot: string; readonly agent?: string; readonly allowUnconfinedWrites?: boolean }): string[] {
  return [
    'run',
    '--json',
    `--repo=${input.repo}`,
    `--agents=${input.agentsPath}`,
    `--state-dir=${input.stateRoot}`,
    `--task=${input.task}`,
    ...(input.agent !== undefined ? [`--agent=${input.agent}`] : []),
    ...(input.allowUnconfinedWrites === true ? ['--allow-unconfined-writes'] : []),
  ];
}

interface Preflighted {
  readonly body: StartRunBody;
  readonly agentsPath: string;
}

interface ResolvedRepository {
  readonly repo: string;
  readonly inspection: ProjectInspection;
  readonly root: string;
  readonly head: string;
}

/** An absolute path to a Git repository with a committed base, or the refusal the coordinator would give. */
async function resolveRepository(input: string): Promise<ResolvedRepository> {
  if (!path.isAbsolute(input)) throw new ApiError(400, 'repo_not_absolute', 'repo must be an absolute path to a Git repository');
  const repo = path.resolve(input);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new ApiError(400, 'invalid_repo', `${repo} is not a directory`);

  // The coordinator's own read-only inspection (every git call it makes passes --no-optional-locks).
  const inspection = await inspectProject(repo);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    throw new ApiError(400, 'not_a_git_repository', `${inspection.canonicalPath} is not a Git repository; a run works on an existing Git project`);
  }
  if (inspection.headRevision === null) {
    throw new ApiError(400, 'no_committed_base', `${inspection.repositoryRoot} has no commits; there is no committed base revision to start a candidate from`);
  }
  return { repo, inspection, root: inspection.repositoryRoot, head: inspection.headRevision };
}

type RuntimeBinding = LoadedAgentConfig['config']['runtimes'][string];

interface ResolvedAgent {
  readonly loaded: LoadedAgentConfig;
  readonly agentId: string;
  readonly agent: AgentDefinition;
  readonly runtime: RuntimeBinding;
}

/** The agent a run for this repository would use, from the configuration `workforce run` would find. */
function resolveAgent(repo: string, requested: string | undefined, paths: StatePaths, env: NodeJS.ProcessEnv): ResolvedAgent {
  // Found exactly as `workforce run` finds it for this repository.
  const agentsPath = configSearchPath({ env, repoRoot: repo, stateRoot: paths.root, homeDir: paths.root }).find((candidate) => existsSync(candidate.path))?.path;
  if (agentsPath === undefined) {
    throw new ApiError(400, 'missing_agents', 'no agent configuration was found', [`looked in: ${paths.root}/agents.json and ${repo}/.workforce/agents.json`]);
  }
  const loaded = loadConfig(agentsPath);
  const agentId = requested ?? loaded.config.defaults.workerAgent;
  const agent = loaded.config.agents.find((entry) => entry.id === agentId);
  if (agent === undefined) {
    throw new ApiError(400, 'unknown_agent', `agent "${agentId}" is not defined in ${loaded.path}`, [`configured agents: ${loaded.config.agents.map((entry) => `"${entry.id}"`).join(', ')}`]);
  }
  return { loaded, agentId, agent, runtime: loaded.config.runtimes[agent.runtime]! };
}

async function preflight(body: StartRunBody, paths: StatePaths, env: NodeJS.ProcessEnv): Promise<Preflighted> {
  const { repo } = await resolveRepository(body.repo);
  const { loaded, agentId, agent, runtime } = resolveAgent(repo, body.agent, paths, env);
  const containment = assessContainment(
    createAdapter({ id: agent.runtime, adapter: runtime.adapter, executable: runtime.executable }),
    agent.policy,
    body.allowUnconfinedWrites === true,
    null,
  );
  // Only the unconditional refusal is decided here. Whether a boundary was
  // established for the *installed* build needs the runtime's version, which
  // the coordinator reads itself and refuses on; that refusal is relayed.
  if (containment.unconfinedWrites && !containment.acknowledged) {
    throw new ApiError(
      400,
      'write_boundary_unsupported',
      `agent "${agentId}" runs the "${agent.policy}" profile, which lets the worker change files, but ${describeUnconfinedWrites(runtime.adapter, containment)}`,
      ['bind the agent to a runtime with a verified write boundary, give it the read-only "analysis" profile, or send allowUnconfinedWrites: true to accept an unconfined run (it is recorded in the run manifest)'],
    );
  }
  return { body, agentsPath: loaded.path };
}

// ---------------------------------------------------------------------------
// POST /api/runs/preview — what a start request would do, without doing it
// ---------------------------------------------------------------------------

export const PreviewBodySchema = z.strictObject({
  repo: z.string().min(1).max(4096).refine(noNul, 'must not contain a NUL character'),
  agent: AgentIdSchema.optional(),
});

export interface PreviewInputs {
  readonly paths: StatePaths;
  readonly env: NodeJS.ProcessEnv;
  /** Passive discovery reports, for the installed version the write-boundary gate reads. */
  readonly reports: ReadonlyArray<RuntimeReadinessReport>;
  readonly resolveChecks?: (repoRoot: string, baseRevision: string) => Promise<ResolvedChecks>;
}

interface Finding {
  readonly code: string;
  readonly message: string;
}

/**
 * The repository, agent, acceptance checks and write-boundary question a
 * start request for this repository and agent would meet — so the page can
 * show them, and ask the unconfined-writes question, *before* a model turn is
 * spent.
 *
 * Every answer comes from the function the run itself calls: the same project
 * inspection, the same configuration search, `resolveAcceptanceChecks` against
 * the same frozen base revision, and `assessContainment` with the passively
 * observed version. Nothing is spawned and nothing is written. It is not a
 * promise: the coordinator re-checks all of it when the run starts.
 *
 * A repository or agent the start route would refuse is refused here with the
 * same code. What only the run can refuse — no acceptance check — comes back
 * as a blocker, and what passive discovery suggests — a signed-out runtime —
 * as a warning.
 */
export async function previewStart(raw: unknown, inputs: PreviewInputs): Promise<Record<string, unknown>> {
  const parsed = PreviewBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_body', 'the preview request is not valid', formatZodIssues(parsed.error.issues).map((issue) => `${issue.path}: ${issue.message}`));
  }
  const { repo, inspection, root, head } = await resolveRepository(parsed.data.repo);
  const { loaded, agentId, agent, runtime } = resolveAgent(repo, parsed.data.agent, inputs.paths, inputs.env);
  const report = readinessReportForRuntime(inputs.reports, agent.runtime, runtime);
  const adapter = createAdapter({ id: agent.runtime, adapter: runtime.adapter, executable: runtime.executable });
  const containment = assessContainment(adapter, agent.policy, false, report?.version ?? null);

  const blockers: Finding[] = [];
  const warnings: Finding[] = [];

  let resolved: ResolvedChecks | null = null;
  let checkError: Finding | null = null;
  try {
    resolved = await (inputs.resolveChecks ?? resolveAcceptanceChecks)(root, head);
  } catch (error) {
    if (!(error instanceof CheckConfigurationError)) throw error;
    checkError = { code: `invalid_checks:${error.code}`, message: error.message };
    blockers.push(checkError);
  }
  if (resolved !== null && resolved.checks.length === 0) {
    blockers.push({
      code: 'no_acceptance_checks',
      message: `${resolved.detail}. A task cannot be accepted without independently executed evidence, so the coordinator refuses this run before any work starts.`,
    });
  }

  if (runtime.adapter !== 'fake') {
    const loginHint = runtimeDescriptor(runtime.adapter).loginHint;
    if (report === undefined) {
      warnings.push({ code: 'runtime_not_discovered', message: `passive discovery has no report for ${runtime.adapter}; the coordinator will check the runtime itself when the run starts` });
    } else if (!report.installed) {
      warnings.push({ code: 'runtime_not_installed', message: `${report.displayName} was not found by passive discovery (${report.authDetail})` });
    } else if (report.auth === 'logged_out') {
      warnings.push({ code: 'runtime_signed_out', message: `${report.displayName} reports no active login. Sign in with \`${loginHint}\` in a terminal, then preview again.` });
    }
  }

  const requiresConsent = containment.unconfinedWrites || containment.untestedVersion;
  return {
    ok: true,
    repository: {
      path: repo,
      root,
      headRevision: head,
      branch: inspection.branch,
      detachedHead: inspection.detachedHead,
      workingTree: describeDirty(inspection.dirty),
      note: 'the run starts from this committed base revision in its own workspace; your checkout is never modified',
    },
    configuration: { path: loaded.path },
    agent: {
      id: agentId,
      runtime: agent.runtime,
      adapter: runtime.adapter,
      model: agent.model ?? runtime.model ?? null,
      effort: agent.effort ?? runtime.effort ?? null,
      policy: agent.policy,
      capabilities: agent.capabilities,
      isDefaultWorker: loaded.config.defaults.workerAgent === agentId,
    },
    runtime:
      report === undefined
        ? null
        : {
            displayName: report.displayName,
            installed: report.installed,
            adapterSupported: report.adapterSupported,
            controllable: report.controllable,
            diagnostics: report.diagnostics,
            version: report.version,
            auth: report.auth,
            authDetail: report.authDetail,
            readiness: report.readiness,
            loginHint: runtimeDescriptor(report.adapter).loginHint,
            checkedAt: report.checkedAt,
          },
    writeBoundary: {
      writes: containment.writes,
      status: containment.status,
      unconfinedWrites: containment.unconfinedWrites,
      untestedVersion: containment.untestedVersion,
      installedVersion: containment.installedVersion,
      testedVersion: containment.testedVersion,
      requiresAllowUnconfinedWrites: requiresConsent,
      explanation: containment.unconfinedWrites
        ? describeUnconfinedWrites(runtime.adapter, containment)
        : containment.untestedVersion
          ? describeUntestedBoundary(runtime.adapter, containment)
          : null,
    },
    checks: {
      source: resolved?.source ?? null,
      detail: resolved?.detail ?? checkError?.message ?? null,
      error: checkError,
      criteria: (resolved?.checks ?? []).map((check) => ({
        criterionId: check.criterionId,
        description: check.description ?? null,
        command: check.command,
        args: check.args ?? [],
        required: check.required !== false,
      })),
    },
    blockers,
    warnings,
  };
}

type Observation =
  | { readonly kind: 'created'; readonly runId: string }
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: string | null; readonly result: Record<string, unknown> | null }
  | { readonly kind: 'spawn_error'; readonly message: string }
  | { readonly kind: 'timeout' };

function scanStdout(file: string): { runId: string | null; last: Record<string, unknown> | null } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { runId: null, last: null };
  }
  let runId: string | null = null;
  let last: Record<string, unknown> | null = null;
  // Only complete lines: a line still being written is read on the next poll.
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== 'object') continue;
    const object = record as Record<string, unknown>;
    if (runId === null && object['type'] === 'run.created' && typeof object['runId'] === 'string') runId = object['runId'];
    if ('ok' in object) last = object;
  }
  return { runId, last };
}

function observe(child: ChildProcess, stdoutPath: string, timeoutMs: number): Promise<Observation> {
  return new Promise((resolve) => {
    let settled = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | null = null;
    const deadline = Date.now() + timeoutMs;
    child.once('exit', (code, signal) => (exit = { code, signal }));
    child.once('error', (error) => (spawnError = error.message));
    const poll = (): void => {
      if (settled) return;
      const scan = scanStdout(stdoutPath);
      const done = (observation: Observation): void => {
        settled = true;
        resolve(observation);
      };
      if (scan.runId !== null) return done({ kind: 'created', runId: scan.runId });
      if (spawnError !== null) return done({ kind: 'spawn_error', message: spawnError });
      // The exit has been seen, so every byte the process wrote is in the file: this scan is final.
      if (exit !== null) return done({ kind: 'exited', code: exit.code, signal: exit.signal, result: scan.last });
      if (Date.now() >= deadline) return done({ kind: 'timeout' });
      setTimeout(poll, LAUNCH_POLL_MS);
    };
    poll();
  });
}

function refusalStatus(code: number | null, errorCode: string | null): number {
  if (code === 2) return 400;
  if (code === 3) return 409;
  if (code === 4 && errorCode === 'coordinator_lock_held') return 409;
  if (code === 130) return 409;
  return 500;
}

export function createLauncher(options: LauncherOptions): Launcher {
  const spawner: Spawner = options.spawner ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const invocation = options.invocation ?? defaultCliInvocation();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  let pending = false;

  return {
    get pending() {
      return pending;
    },
    async start(raw) {
      const body = parseBody(raw);
      // One start at a time from this server. The coordinator lock already
      // refuses a second concurrent run; this answers sooner and says why.
      if (pending) throw new ApiError(409, 'launch_in_progress', 'another start request from this office is still waiting for its run to be recorded');
      pending = true;
      try {
        const { agentsPath } = await preflight(body, options.paths, env);
        const launchId = newId();
        const dir = path.join(options.paths.root, 'serve', 'launches');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stdoutPath = path.join(dir, `${launchId}.stdout.jsonl`);
        const stderrPath = path.join(dir, `${launchId}.stderr.log`);
        const args = [
          ...invocation.args,
          ...runArguments({
            repo: path.resolve(body.repo),
            task: body.task,
            agentsPath,
            stateRoot: options.paths.root,
            ...(body.agent !== undefined ? { agent: body.agent } : {}),
            ...(body.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
          }),
        ];

        const stdoutFd = openSync(stdoutPath, 'a', 0o600);
        const stderrFd = openSync(stderrPath, 'a', 0o600);
        let child: ChildProcess;
        try {
          child = spawner(invocation.command, args, {
            cwd: invocation.cwd,
            env,
            stdio: ['ignore', stdoutFd, stderrFd],
            detached: true,
            shell: false,
            windowsHide: true,
          });
        } catch (error) {
          throw new ApiError(500, 'spawn_failed', `could not start workforce run: ${(error as Error).message}`);
        } finally {
          closeSync(stdoutFd);
          closeSync(stderrFd);
        }
        child.unref();

        const observation = await observe(child, stdoutPath, timeoutMs);
        switch (observation.kind) {
          case 'created':
            return { runId: observation.runId, launchId, pid: child.pid ?? null };
          case 'spawn_error':
            throw new ApiError(500, 'spawn_failed', `could not start workforce run: ${observation.message}`, [`log: ${stderrPath}`]);
          case 'timeout':
            throw new ApiError(
              504,
              'run_not_recorded_yet',
              `workforce run (pid ${child.pid ?? 'unknown'}) has not recorded a run after ${Math.round(timeoutMs / 1000)} s. It was not stopped and may still record one, which will then appear in /api/runs.`,
              [`stdout: ${stdoutPath}`, `stderr: ${stderrPath}`],
            );
          case 'exited': {
            const error = observation.result?.['error'] as { code?: unknown; message?: unknown; details?: unknown } | undefined;
            const errorCode = typeof error?.code === 'string' ? error.code : null;
            const message =
              typeof error?.message === 'string'
                ? error.message
                : `workforce run exited ${observation.code ?? observation.signal ?? 'abnormally'} before recording a run`;
            const details = Array.isArray(error?.details) ? error.details.filter((item): item is string => typeof item === 'string') : [];
            throw new ApiError(refusalStatus(observation.code, errorCode), errorCode ?? 'run_process_failed', message, [...details, `stderr: ${stderrPath}`]);
          }
        }
      } finally {
        pending = false;
      }
    },
  };
}
