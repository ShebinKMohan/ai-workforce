#!/usr/bin/env node
/**
 * workforce CLI: doctor | run | status | resume.
 *
 * WP01 wires argument parsing, configuration validation (exit 2 on invalid
 * input), state-root resolution and read-only status. Discovery, execution
 * and resume arrive with WP02-WP09 and currently report "not implemented".
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContractValidationError } from '../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../core/config.js';
import { computeAgentSnapshot } from '../core/snapshot.js';
import { openStateStore, StateNotFoundError } from '../storage/db.js';
import { listArtifacts } from '../storage/artifacts.js';
import { listEvents, lastEventSequence } from '../storage/events.js';
import { SchemaTooNewError } from '../storage/migrations.js';
import { createStatePaths, ensureStateRoot, resolveStateRoot } from '../storage/paths.js';
import { findRun, listTasks } from '../storage/records.js';
import { redactValue } from '../telemetry/redaction.js';
import { CliError, EXIT_CODES, Reporter, type CommandResult, type ExitCode, type Streams } from './output.js';

export const USAGE = `workforce — coordinate installed coding runtimes on one engineering task

Usage:
  workforce doctor [--agents <file>] [--state-dir <dir>] [--json]
  workforce run --repo <path> --agents <file> (--task <text> | --task-file <file>) [--state-dir <dir>] [--json]
  workforce status <run-id> [--state-dir <dir>] [--json]
  workforce resume <run-id> --agents <file> [--state-dir <dir>] [--json]

Options:
  --repo <path>        Git repository to work on (its checkout is never modified)
  --agents <file>      agent configuration JSON (schemaVersion 1)
  --task <text>        task request text
  --task-file <file>   read the task request from a file
  --state-dir <dir>    coordinator state root (default: $WORKFORCE_STATE_DIR or ~/.workforce)
  --json               machine-readable stdout; diagnostics go to stderr
  -h, --help           show this help

Exit codes: 0 verified candidate · 2 invalid input/config · 3 user action required · 4 execution/validation failure · 130 interrupted`;

interface ParsedArgs {
  readonly command: string | null;
  readonly positionals: ReadonlyArray<string>;
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly stateDir?: string;
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
    ...(values['state-dir'] !== undefined ? { stateDir: values['state-dir'] } : {}),
    json: values.json === true,
    help: values.help === true,
  };
}

const OPTIONS = {
  repo: { type: 'string' },
  agents: { type: 'string' },
  task: { type: 'string' },
  'task-file': { type: 'string' },
  'state-dir': { type: 'string' },
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

function requireRepo(repo: string | undefined): string {
  if (repo === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_repo', '--repo <path> is required');
  const absolute = path.resolve(repo);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_repo', `--repo ${absolute} is not a directory`);
  }
  return absolute;
}

function requireTaskText(args: ParsedArgs): { text: string; source: string } {
  if (args.task !== undefined && args.taskFile !== undefined) {
    throw new CliError(EXIT_CODES.invalidInput, 'ambiguous_task', 'pass either --task or --task-file, not both');
  }
  if (args.task !== undefined) {
    if (args.task.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'empty_task', '--task text is empty');
    return { text: args.task, source: 'argument' };
  }
  if (args.taskFile !== undefined) {
    const file = path.resolve(args.taskFile);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new CliError(EXIT_CODES.invalidInput, 'unreadable_task_file', `cannot read --task-file ${file}: ${(error as Error).message}`);
    }
    if (text.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'empty_task', `--task-file ${file} is empty`);
    return { text, source: file };
  }
  throw new CliError(EXIT_CODES.invalidInput, 'missing_task', 'one of --task <text> or --task-file <file> is required');
}

function requireRunId(args: ParsedArgs, command: string): string {
  const runId = args.positionals[0];
  if (runId === undefined || runId.length === 0) throw new CliError(EXIT_CODES.invalidInput, 'missing_run_id', `${command} requires a <run-id> argument`);
  if (args.positionals.length > 1) throw new CliError(EXIT_CODES.invalidInput, 'unexpected_arguments', `unexpected arguments after run id: ${args.positionals.slice(1).join(' ')}`);
  return runId;
}

function commandDoctor(args: ParsedArgs): CommandResult {
  const stateRoot = resolveStateRoot(args.stateDir);
  const data: Record<string, unknown> = { stateRoot };
  const lines = [`state root: ${stateRoot}`];
  if (args.agents !== undefined) {
    const loaded = loadConfigOrFail(args.agents);
    data['config'] = configSummary(loaded);
    lines.push(`agent configuration: ${loaded.path} (valid)`);
    for (const agent of loaded.config.agents) {
      const runtime = loaded.config.runtimes[agent.runtime]!;
      lines.push(`  agent ${agent.id}: runtime ${agent.runtime} (${runtime.adapter} via ${runtime.executable}), policy ${agent.policy}`);
    }
  }
  return notImplemented('doctor', data, lines, 'WP02 discovery');
}

function commandRun(args: ParsedArgs): CommandResult {
  const repo = requireRepo(args.repo);
  if (args.agents === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_agents', '--agents <file> is required');
  const loaded = loadConfigOrFail(args.agents);
  const task = requireTaskText(args);
  const paths = createStatePaths(resolveStateRoot(args.stateDir));
  ensureStateRoot(paths);
  const worker = loaded.config.defaults.workerAgent;
  const data = {
    stateRoot: paths.root,
    repo,
    config: configSummary(loaded),
    workerAgent: worker,
    task: { source: task.source, characters: task.text.length },
  };
  const lines = [`state root: ${paths.root}`, `repo: ${repo}`, `agent configuration: ${loaded.path} (valid)`, `worker agent: ${worker}`, `task: ${task.text.length} characters from ${task.source}`];
  return notImplemented('run', data, lines, 'WP03/WP04 execution');
}

function commandStatus(args: ParsedArgs): CommandResult {
  const runId = requireRunId(args, 'status');
  const paths = createStatePaths(resolveStateRoot(args.stateDir));
  let store;
  try {
    store = openStateStore(paths, { mode: 'read-only' });
  } catch (error) {
    if (error instanceof StateNotFoundError || error instanceof SchemaTooNewError) {
      throw new CliError(EXIT_CODES.invalidInput, 'state_unavailable', error.message);
    }
    throw error;
  }
  try {
    const run = findRun(store.db, runId);
    if (run === null) throw new CliError(EXIT_CODES.invalidInput, 'unknown_run', `run ${runId} not found under ${paths.root}`);
    const tasks = listTasks(store.db, runId).map((task) => ({ id: task.id, objective: task.objective, state: task.state, waitReason: task.wait_reason, generation: task.current_generation }));
    const last = lastEventSequence(store.db, runId);
    const events = listEvents(store.db, runId, { afterSequence: Math.max(0, last - 10) }).map((event) => ({ sequence: event.sequence, type: event.type, timestamp: event.timestamp, taskId: event.taskId }));
    const artifacts = listArtifacts(store.db, runId).map((artifact) => ({ id: artifact.id, type: artifact.type, path: artifact.relativePath, sha256: artifact.sha256 }));
    const request = redactValue(JSON.parse(run.request_json) as Record<string, unknown>);
    const data = { stateRoot: paths.root, run: { id: run.id, state: run.state, repoPath: run.repo_path, baseRevision: run.base_revision, policy: run.policy, createdAt: run.created_at, updatedAt: run.updated_at, request }, tasks, events, artifacts, eventCount: last };
    const lines = [
      `run ${run.id}: ${run.state}`,
      `repo: ${run.repo_path} (base ${run.base_revision ?? 'unknown'})`,
      `tasks: ${tasks.length === 0 ? '(none)' : ''}`,
      ...tasks.map((task) => `  ${task.id} [${task.state}${task.waitReason ? `: ${task.waitReason}` : ''}] gen ${task.generation} — ${task.objective}`),
      `events: ${last} recorded; last ${events.length}:`,
      ...events.map((event) => `  #${event.sequence} ${event.timestamp} ${event.type}`),
      `artifacts: ${artifacts.length === 0 ? '(none)' : ''}`,
      ...artifacts.map((artifact) => `  ${artifact.type} ${artifact.path} sha256 ${artifact.sha256.slice(0, 12)}`),
    ];
    return { command: 'status', exitCode: EXIT_CODES.verifiedCandidate, data, lines };
  } finally {
    store.close();
  }
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

export function runCli(argv: ReadonlyArray<string>, streams: Streams = process): ExitCode {
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
        return reporter.result(commandDoctor(args));
      case 'run':
        return reporter.result(commandRun(args));
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

function main(): void {
  process.on('SIGINT', () => {
    process.stderr.write('\ninterrupted\n');
    process.exit(EXIT_CODES.interrupted);
  });
  process.exitCode = runCli(process.argv.slice(2));
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

if (isInvokedDirectly()) main();
