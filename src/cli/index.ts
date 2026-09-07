#!/usr/bin/env node
/**
 * workforce CLI: doctor | run | status | resume.
 *
 * WP01 wired argument parsing, configuration validation (exit 2 on invalid
 * input) and state-root resolution. WP02 implements `doctor` (passive runtime
 * discovery), WP04 implements `run` (the R0 direct path) and `status`.
 * `resume` arrives with WP09 and currently reports "not implemented".
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContractValidationError } from '../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../core/config.js';
import { computeAgentSnapshot } from '../core/snapshot.js';
import { resolveStateRoot } from '../storage/paths.js';
import { commandDoctor as runDoctor } from './commands/doctor.js';
import { commandRun } from './commands/run.js';
import { commandStatus } from './commands/status.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult, type ExitCode, type Streams } from './output.js';

export const USAGE = `workforce — coordinate installed coding runtimes on one engineering task

Usage:
  workforce doctor [--codex-path <file>] [--claude-path <file>] [--agents <file>] [--state-dir <dir>] [--json]
  workforce run --repo <path> --agents <file> (--task <text> | --task-file <file>) [--agent <id>] [--check "<cmd> [args]"]... [--state-dir <dir>] [--workspace-root <dir>] [--json]
  workforce status <run-id> [--state-dir <dir>] [--json]
  workforce resume <run-id> --agents <file> [--state-dir <dir>] [--json]

Options:
  --repo <path>        Git repository to work on (its checkout is never modified)
  --agents <file>      agent configuration JSON (schemaVersion 1)
  --task <text>        task request text
  --task-file <file>   read the task request from a file
  --agent <id>         worker agent to dispatch (default: defaults.workerAgent)
  --check "<cmd> ..."  acceptance check, repeatable. Executed with an argument
                       array, never through a shell. Without it the checks come
                       from .workforce/checks.json at the base revision, or are
                       detected from the project's own test setup.
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
  readonly stateDir?: string;
  readonly workspaceRoot?: string;
  readonly agent?: string;
  readonly checks?: ReadonlyArray<string>;
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
    ...(values['state-dir'] !== undefined ? { stateDir: values['state-dir'] } : {}),
    ...(values['workspace-root'] !== undefined ? { workspaceRoot: values['workspace-root'] } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.check !== undefined ? { checks: values.check } : {}),
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
  'state-dir': { type: 'string' },
  'workspace-root': { type: 'string' },
  agent: { type: 'string' },
  check: { type: 'string', multiple: true },
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

function configSummary(loaded: LoadedAgentConfig): Record<string, unknown> {
  const { config } = loaded;
  return {
    path: loaded.path,
    schemaVersion: config.schemaVersion,
    runtimes: Object.entries(config.runtimes).map(([id, runtime]) => ({ id, adapter: runtime.adapter, executable: runtime.executable, model: runtime.model ?? null, effort: runtime.effort ?? null })),
    agents: config.agents.map((agent) => ({ id: agent.id, runtime: agent.runtime, policy: agent.policy, capabilities: agent.capabilities, snapshotHash: computeAgentSnapshot(config, agent.id).hash })),
    defaults: config.defaults,
  };
}

function notImplemented(command: string, data: Record<string, unknown>, lines: string[], nextPackage: string): CommandResult {
  const message = `${command} is not implemented in WP01 (arrives with ${nextPackage})`;
  return { command, exitCode: EXIT_CODES.executionFailure, data: { ...data, status: 'not_implemented', message }, lines: [...lines, message] };
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
    config: args.agents === undefined ? undefined : loadConfigOrFail(args.agents),
  });
}

function commandResume(args: ParsedArgs): CommandResult {
  const runId = requireRunId(args, 'resume');
  const stateRoot = resolveStateRoot(args.stateDir);
  const data: Record<string, unknown> = { stateRoot, runId };
  const lines = [`state root: ${stateRoot}`, `run: ${runId}`];
  if (args.agents !== undefined) {
    const loaded = loadConfigOrFail(args.agents);
    data['config'] = configSummary(loaded);
    lines.push(`agent configuration: ${loaded.path} (valid)`);
  }
  return notImplemented('resume', data, lines, 'WP09 recovery');
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
        return reporter.result(commandResume(args));
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
