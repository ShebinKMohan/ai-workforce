#!/usr/bin/env node
/**
 * workforce CLI: doctor | run | status | resume.
 *
 * WP01 wired argument parsing, configuration validation (exit 2 on invalid
 * input) and state-root resolution. WP02 implements `doctor` (passive runtime
 * discovery), WP04 implements `run` and `status`, and WP09 implements
 * `resume`.
 *
 * `run` now chooses its own route: the direct path for one bounded task (the
 * proven R0 path, unchanged), the planned path when the request enumerates
 * several deliverables and a planner is configured. `--path` overrides the
 * choice in either direction.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContractValidationError } from '../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../core/config.js';
import { commandDoctor as runDoctor } from './commands/doctor.js';
import { commandRun } from './commands/run.js';
import { commandStatus } from './commands/status.js';
import { commandResume as runResume } from './commands/resume.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult, type ExitCode, type Streams } from './output.js';

export const USAGE = `workforce — coordinate installed coding runtimes on one engineering task

Usage:
  workforce doctor [--connect] [--codex-path <file>] [--claude-path <file>] [--agents <file>] [--state-dir <dir>] [--json]
  workforce run --repo <path> --agents <file> (--task <text> | --task-file <file>) [--agent <id>] [--path direct|planned] [--check "<cmd> [args]"]... [--allow-unconfined-writes] [--state-dir <dir>] [--workspace-root <dir>] [--json]
  workforce status <run-id> [--state-dir <dir>] [--json]
  workforce resume <run-id> [--agents <file>] [--state-dir <dir>] [--json]

Options:
  --repo <path>        Git repository to work on (its checkout is never modified)
  --agents <file>      agent configuration JSON (schemaVersion 1)
  --task <text>        task request text
  --task-file <file>   read the task request from a file
  --agent <id>         worker agent to dispatch (default: defaults.workerAgent)
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
  --json               machine-readable stdout; diagnostics go to stderr.
                       "run --json" emits JSONL: one event object per line, then
                       the final result object.
  -h, --help           show this help

Exit codes: 0 verified candidate · 2 invalid input/config · 3 user action required · 4 execution/validation failure · 130 interrupted`;

interface ParsedArgs {
  readonly command: string | null;
  readonly positionals: ReadonlyArray<string>;
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly codexPath?: string;
  readonly claudePath?: string;
  readonly connect: boolean;
  readonly stateDir?: string;
  readonly workspaceRoot?: string;
  readonly agent?: string;
  readonly path?: string;
  readonly checks?: ReadonlyArray<string>;
  readonly allowUnconfinedWrites: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_arguments', (error as Error).message, ['run "workforce --help" for usage']);
  }
  const [command, ...rest] = parsed.positionals;
  const values = parsed.values;
  return {
    command: command ?? null,
    positionals: rest,
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(values.agents !== undefined ? { agents: values.agents } : {}),
    ...(values.task !== undefined ? { task: values.task } : {}),
    ...(values['task-file'] !== undefined ? { taskFile: values['task-file'] } : {}),
    ...(values['codex-path'] !== undefined ? { codexPath: values['codex-path'] } : {}),
    ...(values['claude-path'] !== undefined ? { claudePath: values['claude-path'] } : {}),
    connect: values.connect === true,
    ...(values['state-dir'] !== undefined ? { stateDir: values['state-dir'] } : {}),
    ...(values['workspace-root'] !== undefined ? { workspaceRoot: values['workspace-root'] } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.path !== undefined ? { path: values.path } : {}),
    ...(values.check !== undefined ? { checks: values.check } : {}),
    allowUnconfinedWrites: values['allow-unconfined-writes'] === true,
    json: values.json === true,
    help: values.help === true,
  };
}

const OPTIONS = {
  repo: { type: 'string' },
  agents: { type: 'string' },
  task: { type: 'string' },
  'task-file': { type: 'string' },
  'codex-path': { type: 'string' },
  'claude-path': { type: 'string' },
  connect: { type: 'boolean', default: false },
  'state-dir': { type: 'string' },
  'workspace-root': { type: 'string' },
  agent: { type: 'string' },
  path: { type: 'string' },
  check: { type: 'string', multiple: true },
  'allow-unconfined-writes': { type: 'boolean', default: false },
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
 * reconnected, replaced, preserved or isolated, and hold the coordinator lock
 * while doing it.
 *
 * The plan is reported, not executed: no continuation is injected here, so
 * `resume` never claims to have re-dispatched work it did not. Validating the
 * configuration first keeps an invalid `--agents` an exit-2 invocation.
 */
function commandResume(args: ParsedArgs, signal?: AbortSignal): Promise<CommandResult> {
  requireRunId(args, 'resume');
  if (args.agents !== undefined) loadConfigOrFail(args.agents);
  return runResume(
    {
      positionals: args.positionals,
      json: args.json,
      ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
      ...(args.agents !== undefined ? { agents: args.agents } : {}),
    },
    signal !== undefined ? { signal } : {},
  );
}

export async function runCli(argv: ReadonlyArray<string>, streams: Streams = process, signal?: AbortSignal): Promise<ExitCode> {
  let json = argv.includes('--json');
  let reporter = new Reporter(json, streams);
  let command = 'workforce';
  try {
    const args = parseCliArgs(argv);
    json = args.json;
    reporter = new Reporter(json, streams);
    if (args.help || args.command === null) {
      if (args.command === null && !args.help) throw new CliError(EXIT_CODES.invalidInput, 'missing_command', 'a command is required', [USAGE]);
      reporter.info(USAGE);
      return EXIT_CODES.verifiedCandidate;
    }
    command = args.command;
    switch (args.command) {
      case 'doctor':
        return reporter.result(await commandDoctor(args));
      case 'run':
        return reporter.result(await commandRun(args, { reporter, streams, ...(signal !== undefined ? { signal } : {}) }));
      case 'status':
        return reporter.result(commandStatus(args));
      case 'resume':
        return reporter.result(await commandResume(args, signal));
      default:
        throw new CliError(EXIT_CODES.invalidInput, 'unknown_command', `unknown command "${args.command}"`, ['commands: doctor, run, status, resume']);
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
  process.on('SIGINT', () => {
    signals += 1;
    if (signals >= 2) {
      process.stderr.write('\nforced termination requested; owned processes and state may be left in an uncertain state\n');
      process.exit(EXIT_CODES.interrupted);
    }
    process.stderr.write('\ninterrupting: stopping owned processes and persisting what exists\n');
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
