#!/usr/bin/env node
/**
 * workforce CLI: (interactive) | doctor | run | status | watch | resume | serve.
 *
 * `serve` (FR084) is the loopback office view: it reads the state root
 * read-only and starts work only by executing `workforce run --json`.
 *
 * WP01 wired argument parsing, configuration validation (exit 2 on invalid
 * input) and state-root resolution. WP02 implements `doctor` (passive runtime
 * discovery), WP04 implements `run` and `status`, and WP09 implements
 * `resume`, which reconciles an interrupted run and then continues it.
 *
 * `run` now chooses its own route: the direct path for one bounded task (the
 * proven R0 path, unchanged), the planned path when the request enumerates
 * several deliverables and a planner is configured. `--path` overrides the
 * choice in either direction.
 *
 * `workforce` with no arguments, on a terminal, starts the interactive
 * launcher in `commands/launch.ts`: it defaults the repository to the working
 * directory, discovers the runtimes itself, finds or writes an agent
 * configuration, shows the acceptance checks before running them, and asks
 * only for what it could not work out. Every flag still means exactly what it
 * meant — the launcher assembles the same `commandRun` call and prints the
 * flag form it assembled — and without a terminal the bare invocation exits 2
 * with that flag form, as it always did.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContractValidationError } from '../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../core/config.js';
import { commandDoctor as runDoctor } from './commands/doctor.js';
import { commandRun, createRunStream } from './commands/run.js';
import { commandLaunch, type LaunchArgs } from './commands/launch.js';
import { commandWatch } from './commands/watch.js';
import { leaveActiveViews } from './live/restore.js';
import { commandStatus } from './commands/status.js';
import { commandResume as runResume } from './commands/resume.js';
import { commandServe } from './commands/serve.js';
import { commandWorkspace, WORKSPACE_USAGE } from './commands/workspace.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult, type ExitCode, type Streams } from './output.js';

export const USAGE = `workforce — coordinate installed coding runtimes on one engineering task

Start here:
  workforce             ask what this run needs and then run it. Defaults the
                        repository to the working directory, discovers the
                        installed runtimes, finds or writes an agent
                        configuration, shows the acceptance checks before
                        running them, and prints the equivalent flag form.
                        Needs a terminal; in a pipe or CI use "workforce run".

Every flag form below still works exactly as it did.

Usage:
  workforce doctor [--connect] [--codex-path <file>] [--claude-path <file>] [--agents <file>] [--state-dir <dir>] [--json]
  workforce run --repo <path> --agents <file> (--task <text> | --task-file <file>) [--agent <id>] [--path direct|planned] [--plan <file>] [--check "<cmd> [args]"]... [--allow-unconfined-writes] [--view live|plain] [--watch] [--state-dir <dir>] [--workspace-root <dir>] [--json]
  workforce run --project <id> --department <id> (--task <text> | --task-file <file>) [--allow-unconfined-writes] [--view live|plain] [--watch] [--state-dir <dir>] [--json]
  workforce workspace [show|init|import|project|department|agent|assign|unassign|runtime] ... [--expect-revision <n>] [--state-dir <dir>] [--json]
  workforce status <run-id> [--state-dir <dir>] [--json]
  workforce watch <run-id> [--task <key>] [--state-dir <dir>] [--json]
  workforce resume <run-id> [--agents <file>] [--allow-unconfined-writes] [--state-dir <dir>] [--json]
  workforce serve [--port <n>] [--state-dir <dir>] [--open] [--json]

Options:
  --project <id>       run: the workspace project to work on. With --department it
                       replaces --repo and --agents: the repository, the agents
                       (the department head and its workers placed on the
                       project) and the checks all come from the workspace, and
                       the run's state lives under <state-root>/projects/<id>.
                       The head plans every request before any worker starts.
  --department <id>    run: the department whose head receives the request
  --expect-revision <n>
                       workspace: change the workspace only if it is still at
                       revision n; otherwise exit 3 and write nothing
  --repo <path>        Git repository to work on (its checkout is never modified)
  --agents <file>      agent configuration JSON (schemaVersion 1)
  --task <text>        task request text
  --task-file <file>   read the task request from a file
  --attachment <id>   include a saved upload in a project request (repeatable)
  --agent <id>         worker agent to dispatch (default: defaults.workerAgent)
  --plan <file>        JSON plan: {"tasks":[{"key","objective","dependencies":[]}]}.
                       The only way to express a task graph; forces the planned path.
  --path direct|planned
                       override the route. The default is decided from the
                       request: one bounded task takes the direct path, an
                       enumerated set of deliverables takes the planned path,
                       whose approved artifacts are combined and re-checked
                       against the combined candidate before anything is
                       accepted.
  --check "<cmd> ..."  acceptance check, repeatable. Executed with an argument
                       array, never through a shell. Without it the checks come
                       from .workforce/checks.json at the base revision, or are
                       detected from the project's own test setup.
  --allow-unconfined-writes
                       run a writing profile on a runtime that enforces no
                       write boundary. Without it such a run is refused; with
                       it the missing boundary is printed and recorded in the
                       run manifest.
  --view live|plain    how a run reports itself. "live" draws one board row
                       per dispatched task plus a focus pane on the alternate
                       screen, and replays the complete transcript into the
                       scrollback when it exits. The default draws it only for
                       a planned run of two or more tasks on a real terminal;
                       --json, a pipe, a redirect, TERM=dumb and a terminal
                       smaller than 60x12 always take the plain renderer, whose
                       output is unchanged. NO_COLOR still draws the board, in
                       monochrome: it is a colour convention, not a cursor one.
  --watch              print a ready-to-paste "workforce watch" line for every
                       planned task before the run starts.
  --connect            ask each installed runtime its own control handshake
                       (doctor). Starts a process, starts no model turn, and is
                       the only way to reach verified_ready: a login-status
                       command describes a stored profile, not a usable
                       credential.
  --codex-path <file>  explicit path to the codex executable (doctor)
  --claude-path <file> explicit path to the claude executable (doctor)
  --state-dir <dir>    coordinator state root (default: $WORKFORCE_STATE_DIR or ~/.workforce)
  --workspace-root <dir>
                       candidate workspace root (default: <state-root>/workspaces)
  --port <n>           serve: port on 127.0.0.1 (default 4317; 0 picks a free one).
                       The office view reads the state root read-only and
                       starts work only by running "workforce run".
  --open               serve: open the office page in the default browser
  --json               machine-readable stdout; diagnostics go to stderr.
                       "run --json", and "resume --json" once it continues a
                       run, emit JSONL: one event object per line, then the
                       final result object.
  -h, --help           show this help

Building a workspace (departments, heads, workers and projects in <state-root>/workspace.json):
${WORKSPACE_USAGE}

Exit codes: 0 verified candidate · 2 invalid input/config · 3 user action required · 4 execution/validation failure · 130 interrupted`;

interface ParsedArgs {
  readonly command: string | null;
  readonly positionals: ReadonlyArray<string>;
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly attachmentIds?: ReadonlyArray<string>;
  readonly codexPath?: string;
  readonly claudePath?: string;
  readonly connect: boolean;
  readonly stateDir?: string;
  readonly workspaceRoot?: string;
  readonly agent?: string;
  readonly path?: string;
  readonly plan?: string;
  readonly view?: string;
  readonly watch: boolean;
  readonly checks?: ReadonlyArray<string>;
  readonly allowUnconfinedWrites: boolean;
  readonly port?: string;
  readonly open: boolean;
  readonly project?: string;
  readonly department?: string;
  readonly workerIds?: ReadonlyArray<string>;
  readonly workspaceRevision?: number;
  readonly expectRevision?: string;
  readonly name?: string;
  readonly note?: string;
  readonly color?: string;
  readonly id?: string;
  readonly role?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly policy?: string;
  readonly instructions?: string;
  readonly instructionsFile?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly adapter?: string;
  readonly executable?: string;
  readonly json: boolean;
  readonly help: boolean;
}

/** Flags that belong to `workforce workspace` alone. */
const WORKSPACE_ONLY_FLAGS = [
  'expect-revision',
  'name',
  'note',
  'color',
  'id',
  'role',
  'runtime',
  'model',
  'effort',
  'policy',
  'instructions',
  'instructions-file',
  'capability',
  'adapter',
  'executable',
] as const;

export function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_arguments', (error as Error).message, ['run "workforce --help" for usage']);
  }
  const [command, ...rest] = parsed.positionals;
  const values = parsed.values;
  const reservationFlag = values.worker !== undefined ? '--worker' : values['workspace-revision'] !== undefined ? '--workspace-revision' : null;
  if (reservationFlag !== null && (command !== 'run' || values.project === undefined || values.department === undefined)) {
    throw new CliError(EXIT_CODES.invalidInput, 'project_selection_required', `${reservationFlag} applies only to "workforce run --project <id> --department <id>"`);
  }
  let workspaceRevision: number | undefined;
  if (values['workspace-revision'] !== undefined) {
    const value = values['workspace-revision'];
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new CliError(EXIT_CODES.invalidInput, 'invalid_workspace_revision', '--workspace-revision must be a non-negative safe integer');
    }
    workspaceRevision = Number(value);
  }
  // `--port` and `--open` belong to `serve` alone. They sit in the one shared
  // option table because parseArgs takes a single table, but accepting them
  // silently on every other command would turn a mistyped flag into a no-op
  // where it used to be an error.
  if (command !== 'serve' && (values.port !== undefined || values.open === true)) {
    throw new CliError(
      EXIT_CODES.invalidInput,
      'invalid_arguments',
      `${values.port !== undefined ? '--port' : '--open'} applies only to "workforce serve"`,
      ['run "workforce --help" for usage'],
    );
  }
  // The workspace flags get the same guard, for the same reason: a mistyped
  // flag on another command must stay an error, not become a silent no-op.
  if (command !== 'workspace') {
    const stray = WORKSPACE_ONLY_FLAGS.find((flag) => values[flag] !== undefined);
    if (stray !== undefined) {
      throw new CliError(EXIT_CODES.invalidInput, 'invalid_arguments', `--${stray} applies only to "workforce workspace"`, ['run "workforce --help" for usage']);
    }
    if (command !== 'run') {
      const strayTarget = (['project', 'department'] as const).find((flag) => values[flag] !== undefined);
      if (strayTarget !== undefined) {
        throw new CliError(EXIT_CODES.invalidInput, 'invalid_arguments', `--${strayTarget} applies only to "workforce run" and "workforce workspace"`, ['run "workforce --help" for usage']);
      }
    }
  }
  return {
    command: command ?? null,
    positionals: rest,
    ...(values.project !== undefined ? { project: values.project } : {}),
    ...(values.department !== undefined ? { department: values.department } : {}),
    ...(values.worker !== undefined ? { workerIds: values.worker } : {}),
    ...(workspaceRevision !== undefined ? { workspaceRevision } : {}),
    ...(values['expect-revision'] !== undefined ? { expectRevision: values['expect-revision'] } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.note !== undefined ? { note: values.note } : {}),
    ...(values.color !== undefined ? { color: values.color } : {}),
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(values.role !== undefined ? { role: values.role } : {}),
    ...(values.runtime !== undefined ? { runtime: values.runtime } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values.effort !== undefined ? { effort: values.effort } : {}),
    ...(values.policy !== undefined ? { policy: values.policy } : {}),
    ...(values.instructions !== undefined ? { instructions: values.instructions } : {}),
    ...(values['instructions-file'] !== undefined ? { instructionsFile: values['instructions-file'] } : {}),
    ...(values.capability !== undefined ? { capabilities: values.capability } : {}),
    ...(values.adapter !== undefined ? { adapter: values.adapter } : {}),
    ...(values.executable !== undefined ? { executable: values.executable } : {}),
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(values.agents !== undefined ? { agents: values.agents } : {}),
    ...(values.task !== undefined ? { task: values.task } : {}),
    ...(values['task-file'] !== undefined ? { taskFile: values['task-file'] } : {}),
    ...(values.attachment !== undefined ? { attachmentIds: values.attachment } : {}),
    ...(values['codex-path'] !== undefined ? { codexPath: values['codex-path'] } : {}),
    ...(values['claude-path'] !== undefined ? { claudePath: values['claude-path'] } : {}),
    connect: values.connect === true,
    ...(values['state-dir'] !== undefined ? { stateDir: values['state-dir'] } : {}),
    ...(values['workspace-root'] !== undefined ? { workspaceRoot: values['workspace-root'] } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.path !== undefined ? { path: values.path } : {}),
    ...(values.plan !== undefined ? { plan: values.plan } : {}),
    ...(values.view !== undefined ? { view: values.view } : {}),
    watch: values.watch === true,
    ...(values.check !== undefined ? { checks: values.check } : {}),
    allowUnconfinedWrites: values['allow-unconfined-writes'] === true,
    ...(values.port !== undefined ? { port: values.port } : {}),
    open: values.open === true,
    json: values.json === true,
    help: values.help === true,
  };
}

const OPTIONS = {
  repo: { type: 'string' },
  agents: { type: 'string' },
  task: { type: 'string' },
  'task-file': { type: 'string' },
  attachment: { type: 'string', multiple: true },
  'codex-path': { type: 'string' },
  'claude-path': { type: 'string' },
  connect: { type: 'boolean', default: false },
  'state-dir': { type: 'string' },
  'workspace-root': { type: 'string' },
  agent: { type: 'string' },
  path: { type: 'string' },
  plan: { type: 'string' },
  view: { type: 'string' },
  watch: { type: 'boolean', default: false },
  check: { type: 'string', multiple: true },
  'allow-unconfined-writes': { type: 'boolean', default: false },
  port: { type: 'string' },
  open: { type: 'boolean', default: false },
  project: { type: 'string' },
  department: { type: 'string' },
  worker: { type: 'string', multiple: true },
  'workspace-revision': { type: 'string' },
  'expect-revision': { type: 'string' },
  name: { type: 'string' },
  note: { type: 'string' },
  color: { type: 'string' },
  id: { type: 'string' },
  role: { type: 'string' },
  runtime: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  policy: { type: 'string' },
  instructions: { type: 'string' },
  'instructions-file': { type: 'string' },
  capability: { type: 'string', multiple: true },
  adapter: { type: 'string' },
  executable: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function loadConfigOrFail(file: string): LoadedAgentConfig {
  try {
    return loadAgentConfigFile(file);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new CliError(
        EXIT_CODES.invalidInput,
        'invalid_config',
        `agent configuration ${file} is invalid (${error.issues.length} issue${error.issues.length === 1 ? '' : 's'})`,
        error.issues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }
    throw error;
  }
}

function requireRunId(args: ParsedArgs, command: string): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', `${command} requires a <run-id> argument`);
  if (args.positionals.length > 1) throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  return runId;
}

/** WP02 discovery: bounded passive probes, readiness and setting validation. */
function commandDoctor(args: ParsedArgs): Promise<CommandResult> {
  return runDoctor({
    stateDir: args.stateDir,
    codexPath: args.codexPath,
    claudePath: args.claudePath,
    connect: args.connect,
    config: args.agents === undefined ? undefined : loadConfigOrFail(args.agents),
  });
}

/**
 * WP09 recovery: reconcile what the run actually left behind, plan what may be
 * reconnected, replaced, preserved or isolated, hold the coordinator lock
 * while doing it — and then continue the run.
 *
 * The plan is executed, not just reported: an unblocked plan creates the
 * attempt generation it decided on, dispatches the work that remains and
 * drives the run to a terminal state, leaving every already-accepted task
 * untouched. A blocked plan continues nothing and says what a person has to
 * decide. Validating the configuration first keeps an invalid `--agents` an
 * exit-2 invocation; the run's own recorded configuration is what a continued
 * attempt is bound to, and `--agents` is the fallback when the run has none.
 */
function commandResume(args: ParsedArgs, deps: { reporter: Reporter; streams: Streams; signal?: AbortSignal }): Promise<CommandResult> {
  requireRunId(args, 'resume');
  if (args.agents !== undefined) loadConfigOrFail(args.agents);
  return runResume(
    {
      positionals: args.positionals,
      json: args.json,
      ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
      ...(args.agents !== undefined ? { agents: args.agents } : {}),
      ...(args.allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}),
    },
    {
      // A continued attempt is a run in progress; it reports itself the same
      // way `run` does rather than going quiet until it is over.
      continuation: { stream: createRunStream(deps.reporter, deps.streams) },
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
  );
}

/** The subset of the parsed flags the launcher pre-fills its questions from. */
function launchArgs(args: ParsedArgs): LaunchArgs {
  return {
    json: args.json,
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    ...(args.agents !== undefined ? { agents: args.agents } : {}),
    ...(args.task !== undefined ? { task: args.task } : {}),
    ...(args.taskFile !== undefined ? { taskFile: args.taskFile } : {}),
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
    ...(args.checks !== undefined ? { checks: args.checks } : {}),
    ...(args.allowUnconfinedWrites ? { allowUnconfinedWrites: true } : {}),
    ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
    ...(args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {}),
    ...(args.view !== undefined ? { view: args.view } : {}),
    ...(args.watch ? { watch: true } : {}),
  };
}

export async function runCli(argv: ReadonlyArray<string>, streams: Streams = process, signal?: AbortSignal): Promise<ExitCode> {
  let json = argv.includes('--json');
  let reporter = new Reporter(json, streams);
  let command = 'workforce';
  try {
    const args = parseCliArgs(argv);
    json = args.json;
    reporter = new Reporter(json, streams);
    if (args.help) {
      reporter.info(USAGE);
      return EXIT_CODES.verifiedCandidate;
    }
    if (args.command === null) {
      // A bare `workforce` on a terminal is the easy path; anywhere else it is
      // the same exit-2 usage error it has always been, now naming the flag
      // form that replaces the questions.
      if (process.stdin.isTTY === true) {
        // `--json` reaches the launcher and is refused there, by name: it is a
        // contract about a machine-readable stdout, and a session of questions
        // has no such form.
        return reporter.result(await commandLaunch(launchArgs(args), { reporter, streams, stdin: process.stdin, ...(signal !== undefined ? { signal } : {}) }));
      }
      throw new CliError(
        EXIT_CODES.invalidInput,
        'missing_command',
        'a command is required — "workforce" with no arguments starts the interactive launcher, which needs a terminal',
        [USAGE],
      );
    }
    command = args.command;
    switch (args.command) {
      case 'doctor':
        return reporter.result(await commandDoctor(args));
      case 'run':
        return reporter.result(
          await commandRun(args, {
            reporter,
            streams,
            ...(process.stdin.isTTY === true ? { stdin: process.stdin } : {}),
            ...(signal !== undefined ? { signal } : {}),
          }),
        );
      case 'status':
        return reporter.result(commandStatus(args));
      case 'watch':
        return reporter.result(
          await commandWatch(
            {
              positionals: args.positionals,
              json: args.json,
              ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
              ...(args.task !== undefined ? { task: args.task } : {}),
            },
            {
              reporter,
              streams,
              ...(process.stdin.isTTY === true ? { stdin: process.stdin } : {}),
              ...(signal !== undefined ? { signal } : {}),
            },
          ),
        );
      case 'resume':
        return reporter.result(await commandResume(args, { reporter, streams, ...(signal !== undefined ? { signal } : {}) }));
      case 'serve':
        return reporter.result(
          await commandServe(
            {
              open: args.open,
              json: args.json,
              ...(args.port !== undefined ? { port: args.port } : {}),
              ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
            },
            { reporter, ...(signal !== undefined ? { signal } : {}) },
          ),
        );
      case 'workspace':
        return reporter.result(
          await commandWorkspace({
            positionals: args.positionals,
            json: args.json,
            ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
            ...(args.expectRevision !== undefined ? { expectRevision: args.expectRevision } : {}),
            ...(args.agents !== undefined ? { agents: args.agents } : {}),
            ...(args.repo !== undefined ? { repo: args.repo } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.note !== undefined ? { note: args.note } : {}),
            ...(args.color !== undefined ? { color: args.color } : {}),
            ...(args.id !== undefined ? { id: args.id } : {}),
            ...(args.department !== undefined ? { department: args.department } : {}),
            ...(args.project !== undefined ? { project: args.project } : {}),
            ...(args.role !== undefined ? { role: args.role } : {}),
            ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.effort !== undefined ? { effort: args.effort } : {}),
            ...(args.policy !== undefined ? { policy: args.policy } : {}),
            ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
            ...(args.instructionsFile !== undefined ? { instructionsFile: args.instructionsFile } : {}),
            ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
            ...(args.checks !== undefined ? { checks: args.checks } : {}),
            ...(args.adapter !== undefined ? { adapter: args.adapter } : {}),
            ...(args.executable !== undefined ? { executable: args.executable } : {}),
          }),
        );
      default:
        throw new CliError(EXIT_CODES.invalidInput, 'unknown_command', `unknown command "${args.command}"`, ['commands: doctor, run, status, watch, resume, serve, workspace']);
    }
  } catch (error) {
    if (error instanceof CliError) return reporter.failure(command, error);
    const unexpected = new CliError(EXIT_CODES.executionFailure, 'unexpected_error', (error as Error).message ?? String(error));
    return reporter.failure(command, unexpected);
  }
}

async function main(): Promise<void> {
  // Ctrl+C aborts the active command, which persists its interruption intent
  // and stops the processes it owns. A second Ctrl+C forces termination and
  // leaves an honestly uncertain state behind.
  const interruption = new AbortController();
  let signals = 0;
  // `serve` starts runs that deliberately outlive it, so the generic "stopping
  // owned processes" line would tell the user the opposite of what happens.
  let invoked: string | null = null;
  try {
    invoked = parseCliArgs(process.argv.slice(2)).command;
  } catch {
    // An invalid invocation reports itself through runCli.
  }
  process.on('SIGINT', () => {
    // FIRST, before anything is written. Raw mode delivers Ctrl+C as a
    // keystroke that `keys.ts` re-raises as this signal, so by the time we get
    // here the board may own the screen. Writing the interruption line into an
    // alternate buffer that is about to be discarded would make a five-minute
    // run appear to vanish with no explanation; leaving first puts the line,
    // the preserved-work note and the artifact paths on a screen that still
    // holds the full attributed history of the run.
    leaveActiveViews();
    signals += 1;
    if (signals >= 2) {
      process.stderr.write('\nforced termination requested; owned processes and state may be left in an uncertain state\n');
      process.exit(EXIT_CODES.interrupted);
    }
    process.stderr.write(
      invoked === 'serve'
        ? '\nstopping the office server; a run it started keeps going (stop that run with kill -INT <pid>)\n'
        : '\ninterrupting: stopping owned processes and persisting what exists\n',
    );
    interruption.abort();
  });
  process.exitCode = await runCli(process.argv.slice(2), process, interruption.signal);
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url) || path.basename(entry) === 'workforce';
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) void main();
