/**
 * `workforce` with no arguments — the interactive front door (FR001, FR002,
 * FR011, FR019, FR020).
 *
 * The flag form is complete and stays complete: `--repo`, `--agents`, `--task`,
 * `--agent`, `--check`, `--allow-unconfined-writes`, `--state-dir` and
 * `--workspace-root` all still mean exactly what they meant. What they are not
 * is memorable, and a coordinator nobody can start is a coordinator that does
 * nothing. So this command asks — in plain language, and only for what it
 * cannot work out for itself:
 *
 * | question | asked when |
 * | --- | --- |
 * | repository | the working directory is not a Git repository with a commit |
 * | agent | more than one configured agent could take the work |
 * | agent configuration | none was found in any of the usual places |
 * | acceptance checks | the resolved checks were rejected, or there were none |
 * | unconfined writes | the chosen binding actually needs the acknowledgement |
 * | task | neither `--task` nor `--task-file` was given |
 *
 * Everything it works out, it says out loud, because a launcher that silently
 * decides is a launcher whose decisions cannot be argued with.
 *
 * Three rules this file does not bend:
 *
 * 1. **Discovery stays passive.** It calls exactly what `doctor` calls without
 *    `--connect`: `--version` and the documented login-status command. No
 *    model turn is started to fill in a menu.
 * 2. **The user's checkout is never written to.** A generated agent
 *    configuration goes into the coordinator's own state root, never into the
 *    repository being worked on.
 * 3. **Nothing here decides acceptance.** The checks are resolved by the same
 *    `resolveAcceptanceChecks` the run uses, from the frozen base revision;
 *    this command only shows them before the run rather than after.
 *
 * When every answer is in, it hands the assembled arguments to `commandRun` —
 * the same entry point the flag form uses, so there is exactly one run path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAgentConfig, type AgentConfigFile, type AgentDefinition } from '../../core/contracts.js';
import { ContractValidationError } from '../../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../../core/config.js';
import {
  assessContainment,
  createAdapter,
  CheckConfigurationError,
  describeUnconfinedWrites,
  describeUntestedBoundary,
  resolveAcceptanceChecks,
  tokenizeCheckCommand,
  type AdapterFactory,
  type ResolvedChecks,
} from '../../core/run-direct.js';
import { discoverRuntimes, type RuntimeReadinessReport } from '../../discovery/readiness.js';
import { runtimeDescriptor, type DiscoverableAdapter } from '../../discovery/runtimes.js';
import { resolveStateRoot } from '../../storage/paths.js';
import { describeDirty, inspectProject, ProjectInspectionError, type ProjectInspection } from '../../workspaces/project.js';
import { CliError, EXIT_CODES, type CommandResult, type Reporter, type Streams } from '../output.js';
import { createReadlinePrompter, type Choice, type Prompter } from '../prompt.js';
import { commandRun, requireTaskText, type RunCommandArgs, type RunCommandDeps } from './run.js';

export interface LaunchArgs {
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly agent?: string;
  readonly checks?: ReadonlyArray<string>;
  readonly allowUnconfinedWrites?: boolean;
  readonly stateDir?: string;
  readonly workspaceRoot?: string;
  readonly view?: string;
  readonly watch?: boolean;
  readonly json: boolean;
}

export interface LaunchDeps {
  readonly reporter: Reporter;
  readonly streams: Streams;
  readonly stdin?: NodeJS.ReadStream;
  readonly signal?: AbortSignal;
  /** Supplied by tests; production builds one over stdin and stderr. */
  readonly prompter?: Prompter;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  /** Passive discovery. Defaults to the one `doctor` uses without `--connect`. */
  readonly discover?: () => Promise<ReadonlyArray<RuntimeReadinessReport>>;
  readonly inspect?: (projectPath: string) => Promise<ProjectInspection>;
  readonly resolveChecks?: (repoRoot: string, base: string, flags: ReadonlyArray<string>) => Promise<ResolvedChecks>;
  /** The run itself. Defaults to `commandRun`, so the flag form and this share one path. */
  readonly run?: (args: RunCommandArgs, deps: RunCommandDeps) => Promise<CommandResult>;
  /** Opens the task text in `$VISUAL`/`$EDITOR`. Returns null when there is no editor to open. */
  readonly openEditor?: (prompter: Prompter, env: Readonly<Record<string, string | undefined>>) => Promise<string | null>;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

/** How many times a rejected answer (a bad path, an unusable check) is re-asked before giving up. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Rendering helpers (pure, so they are tested without a terminal)
// ---------------------------------------------------------------------------

/** Shell-ish quoting for the printed flag form. For reading, not for execution. */
export function quoteForDisplay(value: string): string {
  return /^[A-Za-z0-9._/@:=-]+$/.test(value) ? value : JSON.stringify(value);
}

/** The one-line `workforce run ...` that would have started this exact run. */
export function equivalentCommand(parts: {
  readonly repo: string;
  readonly agents: string;
  readonly agent: string;
  readonly task: string;
  readonly checks: ReadonlyArray<string>;
  readonly allowUnconfinedWrites: boolean;
  readonly stateDir?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}): string {
  const argv = ['workforce', 'run', '--repo', quoteForDisplay(parts.repo), '--agents', quoteForDisplay(parts.agents), '--agent', quoteForDisplay(parts.agent)];
  for (const check of parts.checks) argv.push('--check', quoteForDisplay(check));
  if (parts.allowUnconfinedWrites) argv.push('--allow-unconfined-writes');
  if (parts.stateDir !== undefined) argv.push('--state-dir', quoteForDisplay(parts.stateDir));
  if (parts.workspaceRoot !== undefined) argv.push('--workspace-root', quoteForDisplay(parts.workspaceRoot));
  argv.push('--task', quoteForDisplay(parts.task));
  return argv.join(' ');
}

/** One line per runtime: what is installed, whether it can be driven, and the exact command that fixes it. */
export function describeRuntime(report: RuntimeReadinessReport): string {
  const descriptor = runtimeDescriptor(report.adapter);
  if (!report.installed) return `${report.adapter} — not installed (searched PATH and the usual install locations)`;
  const version = report.version ?? 'an unreadable version';
  if (!report.adapterSupported) return `${report.adapter} ${version} — below the supported minimum ${descriptor.minimumSupportedVersion}`;
  if (report.auth === 'logged_out') return `${report.adapter} ${version} — signed out; sign in with: ${descriptor.loginHint}`;
  if (report.auth === 'unknown') return `${report.adapter} ${version} — installed; the login state could not be read, so a turn may still fail`;
  return `${report.adapter} ${version} — installed and signed in`;
}

/**
 * Why this agent cannot be dispatched, or undefined when it can.
 *
 * Only what passive discovery actually established. `auth: unknown` is not a
 * refusal: the status command failing to answer is not the runtime saying no,
 * and the run warns about it rather than refusing.
 */
export function agentUnavailable(report: RuntimeReadinessReport | undefined): string | undefined {
  if (report === undefined) return undefined;
  const descriptor = runtimeDescriptor(report.adapter);
  if (!report.installed) return `${report.adapter} is not installed`;
  if (!report.adapterSupported) return `${report.adapter} ${report.version ?? '(unknown version)'} is below the supported minimum ${descriptor.minimumSupportedVersion}`;
  if (report.auth === 'logged_out') return `${report.adapter} is signed out — run: ${descriptor.loginHint}`;
  return undefined;
}

/** The agent menu: every configured agent, annotated with what discovery found about its runtime. */
export function agentChoices(config: AgentConfigFile, reports: ReadonlyArray<RuntimeReadinessReport>): Choice[] {
  const byAdapter = new Map<string, RuntimeReadinessReport>(reports.map((report) => [report.adapter, report]));
  return config.agents.map((agent) => {
    const runtime = config.runtimes[agent.runtime]!;
    const report = byAdapter.get(runtime.adapter);
    const unavailable = agentUnavailable(report);
    return {
      value: agent.id,
      label: agent.id,
      detail: `${runtime.adapter} via ${runtime.executable}, policy ${agent.policy}`,
      ...(unavailable !== undefined ? { unavailable } : {}),
    } satisfies Choice;
  });
}

/** What the run will execute to decide acceptance, in the form a person can check. */
export function checkPreviewLines(resolved: ResolvedChecks): string[] {
  if (resolved.checks.length === 0) return [];
  return resolved.checks.map((check) => `  ${check.criterionId}: ${[check.command, ...(check.args ?? [])].join(' ')}${check.required === false ? ' (not required)' : ''}`);
}

// ---------------------------------------------------------------------------
// Agent configuration: find one, or write a sensible one
// ---------------------------------------------------------------------------

export interface ConfigCandidate {
  readonly path: string;
  /** Where this candidate came from, for the line that tells the user what was used. */
  readonly source: string;
}

/**
 * The places an agent configuration is looked for, in order.
 *
 * The repository is on the list because a project may ship its own, but it is
 * only ever *read* from there: nothing in this command writes into a
 * registered checkout.
 */
export function configSearchPath(input: {
  readonly explicit?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly stateRoot: string;
  readonly homeDir: string;
}): ConfigCandidate[] {
  const candidates: ConfigCandidate[] = [];
  if (input.explicit !== undefined) candidates.push({ path: path.resolve(input.explicit), source: '--agents' });
  const fromEnv = input.env['WORKFORCE_AGENTS'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) candidates.push({ path: path.resolve(fromEnv), source: 'WORKFORCE_AGENTS' });
  candidates.push({ path: path.join(input.stateRoot, 'agents.json'), source: 'the coordinator state root' });
  candidates.push({ path: path.join(input.repoRoot, '.workforce', 'agents.json'), source: 'the repository' });
  candidates.push({ path: path.join(input.homeDir, '.workforce', 'agents.json'), source: 'the home directory' });
  const seen = new Set<string>();
  return candidates.filter((candidate) => (seen.has(candidate.path) ? false : (seen.add(candidate.path), true)));
}

const WORKER_INSTRUCTIONS = 'Inspect the relevant code, fix the underlying issue, and submit evidence against the task criteria.';
const PLANNER_INSTRUCTIONS = 'Clarify missing intent, define interfaces, and propose only useful bounded subtasks.';

/**
 * A configuration for the runtimes that are actually installed and usable.
 *
 * Deliberately small: one writing worker, and — when a second usable runtime
 * exists — a planner on the other one, because that is what turns an
 * enumerated request into a planned run with a board. Nothing is invented for
 * a runtime that is not there.
 */
export function defaultAgentConfig(reports: ReadonlyArray<RuntimeReadinessReport>): AgentConfigFile | null {
  const usable = reports.filter((report) => report.installed && report.adapterSupported && report.auth !== 'logged_out');
  if (usable.length === 0) return null;
  const runtimeId = (adapter: DiscoverableAdapter): string => (adapter === 'codex' ? 'codex-local' : 'claude-local');
  const runtimes: Record<string, { adapter: DiscoverableAdapter; executable: string }> = {};
  for (const report of usable) runtimes[runtimeId(report.adapter)] = { adapter: report.adapter, executable: report.executable! };
  const worker = usable[0]!;
  const planner = usable[1] ?? worker;
  const agents: AgentDefinition[] = [
    { id: 'engineer', runtime: runtimeId(worker.adapter), instructions: WORKER_INSTRUCTIONS, capabilities: ['coding', 'testing'], policy: 'local-development' },
    { id: 'architect', runtime: runtimeId(planner.adapter), instructions: PLANNER_INSTRUCTIONS, capabilities: ['planning', 'architecture'], policy: 'analysis' },
  ];
  const draft = {
    schemaVersion: 1,
    runtimes,
    defaults: {
      workerAgent: 'engineer',
      plannerAgent: 'architect',
      maxActiveTurns: 2,
      maxActiveWriters: 2,
      maxTasksPerRun: 8,
      maxDelegationDepth: 2,
      maxRepairAttempts: 2,
      maxTransientRetries: 2,
      runTimeoutMinutes: 30,
    },
    agents,
  };
  // Never write a file this coordinator would then refuse to load.
  return validateAgentConfig(draft);
}

function writeAgentConfig(file: string, config: AgentConfigFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export async function commandLaunch(args: LaunchArgs, deps: LaunchDeps): Promise<CommandResult> {
  if (args.json) {
    throw new CliError(EXIT_CODES.invalidInput, 'interactive_json', 'the interactive launcher has no --json form: it asks questions, and --json is a contract about machine-readable stdout', [
      'start the run with flags instead: workforce run --repo <path> --agents <file> --task <text> --json',
    ]);
  }
  const prompter = deps.prompter ?? interactivePrompter(deps);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = deps.homeDir ?? os.homedir();
  const inspect = deps.inspect ?? inspectProject;
  const stateRoot = resolveStateRoot(args.stateDir);

  try {
    prompter.heading('workforce');
    prompter.note('every question below has a flag; the flag form of this run is printed before it starts.');

    // ---- 1. the repository ------------------------------------------------
    const project = await resolveRepository(prompter, args, cwd, inspect);
    const repoRoot = project.repositoryRoot!;
    const base = project.headRevision!;

    // ---- 2. what is installed --------------------------------------------
    prompter.heading('runtimes');
    prompter.note('  passive discovery only: --version and the documented login-status command. No model turn is started.');
    const reports = await (deps.discover ?? (() => discoverRuntimes()))();
    for (const report of reports) prompter.say(`  ${describeRuntime(report)}`);

    // ---- 3. the agent configuration --------------------------------------
    const loaded = await resolveAgentConfig(prompter, { explicit: args.agents, env, repoRoot, stateRoot, homeDir }, reports);

    // ---- 4. the agent -----------------------------------------------------
    const agentId = await resolveAgent(prompter, args.agent, loaded, reports);
    const agent = loaded.config.agents.find((candidate) => candidate.id === agentId)!;

    // ---- 5. acceptance ----------------------------------------------------
    const acceptance = await resolveChecks(prompter, args, repoRoot, base, deps.resolveChecks ?? resolveAcceptanceChecks);
    const checkFlags = acceptance.flags;

    // ---- 6. the write boundary -------------------------------------------
    const allowUnconfinedWrites = await resolveWriteBoundary(prompter, args, loaded.config, agent, reports);

    // ---- 7. the task ------------------------------------------------------
    const task = await resolveTask(prompter, args, env, deps.openEditor ?? openEditorTask);

    // ---- 8. confirm, then run --------------------------------------------
    const flagForm = equivalentCommand({
      repo: repoRoot,
      agents: loaded.path,
      agent: agentId,
      task,
      checks: checkFlags,
      allowUnconfinedWrites,
      ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
      ...(args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {}),
    });
    prompter.heading('ready');
    prompter.say(`  repository  ${repoRoot}`);
    prompter.say(`  agent       ${agentId} (${loaded.config.runtimes[agent.runtime]!.adapter}, policy ${agent.policy})`);
    prompter.say(`  acceptance  ${acceptance.summary}`);
    prompter.say(`  state root  ${stateRoot}`);
    prompter.say(`  task        ${task.split('\n')[0]!.slice(0, 100)}${task.length > 100 || task.includes('\n') ? '…' : ''}`);
    prompter.say('');
    prompter.note('the same run, with flags:');
    prompter.say(`  ${flagForm}`);
    prompter.say('');
    if (!(await prompter.confirm('start this run?', true))) {
      throw new CliError(EXIT_CODES.interrupted, 'cancelled', 'cancelled before anything was started; no state was created');
    }
    prompter.say('');

    const runArgs: RunCommandArgs = {
      repo: repoRoot,
      agents: loaded.path,
      task,
      agent: agentId,
      json: false,
      ...(checkFlags.length > 0 ? { checks: checkFlags } : {}),
      ...(allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}),
      ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
      ...(args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {}),
      ...(args.view !== undefined ? { view: args.view } : {}),
      ...(args.watch === true ? { watch: true } : {}),
    };
    const runDeps: RunCommandDeps = {
      reporter: deps.reporter,
      streams: deps.streams,
      ...(deps.stdin !== undefined ? { stdin: deps.stdin } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
    };
    // The prompter is released before the run starts: from here the run owns
    // the terminal, and a live board cannot share it with a readline
    // interface still holding stdin in raw mode.
    prompter.close();
    return await (deps.run ?? commandRun)(runArgs, runDeps);
  } finally {
    prompter.close();
  }
}

/** The production prompter: questions on stderr, answers from a real terminal, or a refusal. */
function interactivePrompter(deps: LaunchDeps): Prompter {
  const stdin = deps.stdin;
  if (stdin === undefined || stdin.isTTY !== true) {
    throw new CliError(
      EXIT_CODES.invalidInput,
      'no_interactive_terminal',
      '"workforce" with no arguments starts an interactive session, and this input is not a terminal',
      [
        'in a pipe, a script or CI, name the run with flags:',
        '  workforce run --repo <path> --agents <file> --task "<what to do>"',
        'run "workforce --help" for every flag, or "workforce doctor" to see which runtimes are usable',
      ],
    );
  }
  return createReadlinePrompter({
    input: stdin,
    // Questions go to stderr so stdout carries only the run's own result.
    output: deps.streams.stderr,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
}

/**
 * The repository, defaulted rather than demanded.
 *
 * The working directory is the answer nearly every time, so it is stated as a
 * fact and not asked about — and the dirty summary comes with it, because the
 * run works from the committed base and never touches the checkout, which is
 * exactly what a person with uncommitted work needs to be told.
 */
async function resolveRepository(
  prompter: Prompter,
  args: LaunchArgs,
  cwd: string,
  inspect: (projectPath: string) => Promise<ProjectInspection>,
): Promise<ProjectInspection> {
  prompter.heading('repository');
  let candidate = args.repo ?? cwd;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let inspection: ProjectInspection | null = null;
    let failure: string | null = null;
    try {
      inspection = await inspect(candidate);
    } catch (error) {
      failure = error instanceof ProjectInspectionError ? error.message : (error as Error).message;
    }
    if (inspection !== null && inspection.isGitRepo && inspection.headRevision !== null) {
      const where = attempt === 0 && args.repo === undefined ? 'the working directory' : 'the path given';
      prompter.say(`  ${inspection.repositoryRoot} (${where})`);
      prompter.say(`  base ${inspection.headRevision.slice(0, 12)} on ${inspection.branch ?? 'a detached HEAD'} — working tree ${describeDirty(inspection.dirty)}`);
      prompter.note('  the run works from the committed base; your checkout is never modified.');
      return inspection;
    }
    const reason =
      failure ??
      (inspection !== null && !inspection.isGitRepo ? `${candidate} is not inside a Git repository` : `${candidate} has no commits yet, so there is no base to work from`);
    prompter.say(`  ${reason}`);
    if (attempt === MAX_RETRIES) break;
    candidate = await prompter.ask('which repository should the agents work on?', { hint: 'a path to a Git repository with at least one commit (--repo)' });
  }
  throw new CliError(EXIT_CODES.invalidInput, 'invalid_repo', 'no usable repository was given', [
    'the coordinator works from a committed base revision, so the repository needs at least one commit',
  ]);
}

/**
 * Find the agent configuration, or offer to write one.
 *
 * "Demanding a path" is the failure mode being fixed here: a first run should
 * not require the user to author a JSON document about runtimes the tool just
 * finished discovering for itself.
 */
async function resolveAgentConfig(
  prompter: Prompter,
  where: { explicit?: string | undefined; env: Readonly<Record<string, string | undefined>>; repoRoot: string; stateRoot: string; homeDir: string },
  reports: ReadonlyArray<RuntimeReadinessReport>,
): Promise<LoadedAgentConfig> {
  prompter.heading('agents');
  const candidates = configSearchPath(where);
  const found = candidates.find((candidate) => existsSync(candidate.path));
  if (found !== undefined) {
    const loaded = loadOrFail(found.path);
    prompter.say(`  ${loaded.path} (${found.source})`);
    prompter.say(`  defines ${loaded.config.agents.map((agent) => agent.id).join(', ')}`);
    return loaded;
  }

  prompter.say('  no agent configuration was found in:');
  for (const candidate of candidates) prompter.note(`    ${candidate.path}`);
  const generated = defaultAgentConfig(reports);
  if (generated === null) {
    throw new CliError(EXIT_CODES.userActionRequired, 'no_usable_runtime', 'no installed runtime is usable, so there is nothing to write an agent configuration for', [
      ...reports.map((report) => `  ${describeRuntime(report)}`),
      'install or sign in to a supported runtime, then run "workforce doctor" to confirm it is ready',
    ]);
  }
  const target = path.join(where.stateRoot, 'agents.json');
  prompter.say(`  one can be written for the runtimes that are installed: ${Object.values(generated.runtimes).map((runtime) => runtime.adapter).join(', ')}`);
  prompter.note(`  it defines ${generated.agents.map((agent) => `${agent.id} (${agent.policy})`).join(' and ')}, and goes in the coordinator's state root — never in your repository`);
  if (!(await prompter.confirm(`write ${target}?`, true))) {
    const given = await prompter.ask('path to an existing agent configuration', { hint: 'the same file --agents takes', allowEmpty: true });
    if (given.length === 0) {
      throw new CliError(EXIT_CODES.invalidInput, 'missing_agents', 'a run needs an agent configuration', [
        'write one and pass it with --agents <file>; fixtures/agents/example.json in this repository is a working example',
      ]);
    }
    const loaded = loadOrFail(given);
    prompter.say(`  ${loaded.path}`);
    return loaded;
  }
  writeAgentConfig(target, generated);
  prompter.say(`  wrote ${target}`);
  prompter.note('  edit that file to change instructions, models or policies; pass a different one with --agents');
  return loadOrFail(target);
}

function loadOrFail(file: string): LoadedAgentConfig {
  try {
    return loadAgentConfigFile(file);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new CliError(
        EXIT_CODES.invalidInput,
        'invalid_config',
        `agent configuration ${path.resolve(file)} is invalid (${error.issues.length} issue${error.issues.length === 1 ? '' : 's'})`,
        error.issues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }
    throw error;
  }
}

/**
 * The agent: `--agent` when it was given, the only usable one when there is
 * one, and otherwise a menu of what is configured — with the runtimes that
 * cannot take work listed, marked, and carrying the command that fixes them.
 */
async function resolveAgent(
  prompter: Prompter,
  explicit: string | undefined,
  loaded: LoadedAgentConfig,
  reports: ReadonlyArray<RuntimeReadinessReport>,
): Promise<string> {
  if (explicit !== undefined) {
    if (!loaded.config.agents.some((agent) => agent.id === explicit)) {
      throw new CliError(EXIT_CODES.invalidInput, 'unknown_agent', `--agent "${explicit}" is not defined in ${loaded.path}`, [
        `configured agents: ${loaded.config.agents.map((agent) => `"${agent.id}"`).join(', ')}`,
      ]);
    }
    return explicit;
  }
  const choices = agentChoices(loaded.config, reports);
  const available = choices.filter((choice) => choice.unavailable === undefined);
  if (available.length === 0) {
    throw new CliError(EXIT_CODES.userActionRequired, 'no_usable_agent', 'no configured agent can be dispatched right now', [
      ...choices.map((choice) => `  ${choice.label}: ${choice.unavailable ?? 'unavailable'}`),
      'sign in to the runtime above, or edit the agent configuration to bind an agent to a runtime that is ready',
    ]);
  }
  if (available.length === 1) {
    prompter.say(`  using ${available[0]!.label} — ${available[0]!.detail ?? ''}`.trimEnd());
    return available[0]!.value;
  }
  return prompter.choose('which agent should do the work?', choices, { defaultValue: loaded.config.defaults.workerAgent, hint: 'the same choice --agent makes' });
}

/**
 * Show what acceptance will mean, before the run, and let it be overridden.
 *
 * Resolved by the run's own resolver against the frozen base revision, so what
 * is shown here is what will actually be executed — not a second, drifting
 * idea of what the checks are.
 */
async function resolveChecks(
  prompter: Prompter,
  args: LaunchArgs,
  repoRoot: string,
  base: string,
  resolve: (repoRoot: string, base: string, flags: ReadonlyArray<string>) => Promise<ResolvedChecks>,
): Promise<{ flags: string[]; summary: string }> {
  prompter.heading('acceptance');
  if (args.checks !== undefined && args.checks.length > 0) {
    prompter.say(`  ${args.checks.length} check(s) from --check`);
    for (const check of args.checks) prompter.say(`    ${check}`);
    return { flags: [...args.checks], summary: args.checks.join(' · ') };
  }
  let resolved: ResolvedChecks;
  try {
    resolved = await resolve(repoRoot, base, []);
  } catch (error) {
    if (error instanceof CheckConfigurationError) throw new CliError(EXIT_CODES.invalidInput, `invalid_checks:${error.code}`, error.message);
    throw error;
  }
  if (resolved.source !== 'none') {
    prompter.say(`  ${resolved.detail}`);
    for (const line of checkPreviewLines(resolved)) prompter.say(line);
    prompter.note('  only a check the verifier runs itself can accept a candidate; a runtime saying "done" cannot.');
    if (await prompter.confirm('use these checks?', true)) {
      return { flags: [], summary: resolved.checks.map((check) => [check.command, ...(check.args ?? [])].join(' ')).join(' · ') };
    }
    const replacement = await askForCheck(prompter, 'which command should decide acceptance?');
    return { flags: [replacement], summary: replacement };
  }
  prompter.say('  no acceptance checks were found in this repository.');
  prompter.say('  acceptance cannot mean anything without one: with no check to run, "done" would be the runtime\'s own word for it,');
  prompter.say('  and this coordinator never accepts that.');
  const given = await askForCheck(prompter, 'which command should decide acceptance?');
  return { flags: [given], summary: given };
}

/** Ask for a check command and validate it exactly as `--check` is validated. */
async function askForCheck(prompter: Prompter, question: string): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const answer = await prompter.ask(question, { hint: 'a command and its arguments, run directly and never through a shell — for example: npm test', allowEmpty: true });
    if (answer.length === 0) {
      throw new CliError(EXIT_CODES.invalidInput, 'no_acceptance_checks', 'no acceptance check was given, so nothing could decide whether the work is done', [
        'add .workforce/checks.json to the repository, or start the run with --check "<command> [args]"',
      ]);
    }
    try {
      tokenizeCheckCommand(answer);
      return answer;
    } catch (error) {
      if (!(error instanceof CheckConfigurationError)) throw error;
      prompter.say(`  ${error.message}`);
    }
  }
  throw new CliError(EXIT_CODES.invalidInput, 'no_acceptance_checks', 'no usable acceptance check was given');
}

/**
 * The `--allow-unconfined-writes` decision, explained once and answered
 * explicitly.
 *
 * The assessment comes from `assessContainment` — the same function the run
 * gate calls — so this question is asked exactly when the run would otherwise
 * refuse, and never asked when it would not.
 */
async function resolveWriteBoundary(
  prompter: Prompter,
  args: LaunchArgs,
  config: AgentConfigFile,
  agent: AgentDefinition,
  reports: ReadonlyArray<RuntimeReadinessReport>,
): Promise<boolean> {
  const runtime = config.runtimes[agent.runtime]!;
  const adapter = createAdapter({ id: agent.runtime, adapter: runtime.adapter, executable: runtime.executable });
  const installedVersion = reports.find((report) => report.adapter === runtime.adapter)?.version ?? null;
  const containment = assessContainment(adapter, agent.policy, args.allowUnconfinedWrites === true, installedVersion);
  if (!containment.unconfinedWrites && !containment.untestedVersion) return args.allowUnconfinedWrites === true;

  prompter.heading('write boundary');
  // One sentence, then the adapter's own words. The sentence has to be sayable
  // out loud, because it is the whole basis of the decision being asked for.
  const sentence = containment.unconfinedWrites
    ? `${agent.id} runs the "${agent.policy}" profile, which changes files, and the ${adapter.id} adapter reports write_containment "unsupported": nothing bounds where the processes it starts may write.`
    : `${agent.id} runs the "${agent.policy}" profile, which changes files, and the ${adapter.id} adapter's write boundary was established against ${containment.testedVersion ?? 'no stated version'} while ${containment.installedVersion ?? 'an unreadable version'} is installed, so nothing establishes that this build bounds writes at all.`;
  prompter.say(`  ${sentence}`);
  prompter.note(`  ${containment.unconfinedWrites ? describeUnconfinedWrites(adapter.id, containment) : describeUntestedBoundary(adapter.id, containment)}`);
  prompter.note('  accepting is recorded in the run manifest, so this run\'s evidence can never be mistaken for a contained one.');
  if (args.allowUnconfinedWrites === true) {
    prompter.say('  --allow-unconfined-writes was given, so the run proceeds and records that its writes were not contained.');
    return true;
  }
  if (await prompter.confirm('run anyway, recording in the manifest that these writes were not contained?', false)) return true;
  throw new CliError(EXIT_CODES.invalidInput, 'write_boundary_unsupported', 'the run needs an acknowledged write boundary and it was declined', [
    'bind this agent to a runtime with a verified write boundary, give it the read-only "analysis" policy,',
    'or start the run with --allow-unconfined-writes to accept an unconfined run explicitly',
  ]);
}

/** The task text: from the flags, from one line, or from an editor when one line is not enough. */
async function resolveTask(
  prompter: Prompter,
  args: LaunchArgs,
  env: Readonly<Record<string, string | undefined>>,
  openEditor: (prompter: Prompter, env: Readonly<Record<string, string | undefined>>) => Promise<string | null>,
): Promise<string> {
  // A task already named on the command line is read by the flag form's own
  // reader, so `--task ""`, `--task-file` and passing both mean here exactly
  // what they mean there.
  if (args.task !== undefined || args.taskFile !== undefined) {
    return requireTaskText({
      json: false,
      ...(args.task !== undefined ? { task: args.task } : {}),
      ...(args.taskFile !== undefined ? { taskFile: args.taskFile } : {}),
    }).text;
  }

  prompter.heading('task');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const answer = await prompter.ask('what should the agent do?', {
      hint: 'one line is enough; press Enter on an empty line to write a longer brief in $EDITOR',
      allowEmpty: true,
    });
    if (answer.length > 0) return answer;
    const edited = await openEditor(prompter, env);
    if (edited !== null && edited.trim().length > 0) {
      prompter.say(`  ${edited.trim().split('\n').length} line(s) from the editor`);
      return edited;
    }
    if (edited === null) prompter.say('  set $EDITOR (or $VISUAL) to write a longer brief, or answer on one line.');
    else prompter.say('  the editor was closed with nothing in it.');
  }
  throw new CliError(EXIT_CODES.invalidInput, 'empty_task', 'no task was given', ['start the run with --task "<what to do>" or --task-file <file>']);
}

/**
 * Open `$VISUAL`/`$EDITOR` on an empty file and return what was written.
 *
 * The editor command is split with the check tokenizer — the one that refuses
 * shell metacharacters — and spawned with an argument array, so an `$EDITOR`
 * carrying a pipe or a substitution is refused rather than interpreted.
 */
async function openEditorTask(prompter: Prompter, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const command = env['VISUAL'] ?? env['EDITOR'];
  if (command === undefined || command.trim().length === 0) return null;
  let tokens: string[];
  try {
    tokens = tokenizeCheckCommand(command);
  } catch (error) {
    prompter.say(`  $EDITOR "${command}" cannot be run directly: ${(error as Error).message}`);
    return null;
  }
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'workforce-task-')), 'TASK.md');
  writeFileSync(file, '');
  const status = await prompter.suspend(() => spawnSync(tokens[0]!, [...tokens.slice(1), file], { stdio: 'inherit', shell: false }));
  if (status.error !== undefined && status.error !== null) {
    prompter.say(`  ${tokens[0]} could not be started: ${status.error.message}`);
    return null;
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
