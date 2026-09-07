/**
 * `workforce run` — the R0 direct path.
 *
 * This command owns the coordinator lock for the duration of the run. It
 * validates configuration and inputs before taking the lock or creating any
 * state, so an invalid invocation exits 2 without side effects.
 *
 * Output:
 * - human mode: a progress line per meaningful step on stdout;
 * - `--json`: JSONL — one JSON object per line, the normalized events first
 *   and the final result object last, so a consumer can stream it.
 *
 * Exit codes: 0 for a verified candidate, 2 for invalid input or
 * configuration, 4 for an execution or validation failure, 130 when
 * interrupted after the interruption was persisted and owned processes were
 * stopped.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ContractValidationError } from '../../core/contracts.js';
import { loadAgentConfigFile, type LoadedAgentConfig } from '../../core/config.js';
import {
  AdapterNotRegisteredError,
  CheckConfigurationError,
  RunSetupError,
  runDirect,
  type AdapterFactory,
  type RunDirectResult,
  type RunStream,
} from '../../core/run-direct.js';
import { LockHeldError, LockLostError } from '../../storage/lock.js';
import { openStateStore } from '../../storage/db.js';
import { createStatePaths, PathsManifestSchema, resolveStateRoot } from '../../storage/paths.js';
import { ProjectInspectionError } from '../../workspaces/project.js';
import { CandidateWorkspaceError } from '../../workspaces/candidate.js';
import { redactedJson } from '../../telemetry/redaction.js';
import { CliError, EXIT_CODES, statusLabel, type CommandResult, type ExitCode, type Reporter, type Streams } from '../output.js';

export interface RunCommandArgs {
  readonly repo?: string;
  readonly agents?: string;
  readonly task?: string;
  readonly taskFile?: string;
  readonly stateDir?: string;
  /** Candidate workspace root; defaults to `<state-root>/workspaces`. */
  readonly workspaceRoot?: string;
  readonly agent?: string;
  readonly checks?: ReadonlyArray<string>;
  /**
   * `--allow-unconfined-writes`: proceed with a writing profile on a runtime
   * that enforces no write boundary. A per-run human decision, never a
   * configuration default (plan section 8).
   */
  readonly allowUnconfinedWrites?: boolean;
  readonly json: boolean;
}

export interface RunCommandDeps {
  readonly reporter: Reporter;
  /** Needed for the JSONL event stream, which bypasses the single-document result writer. */
  readonly streams: Streams;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

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

export function requireRepo(repo: string | undefined): string {
  if (repo === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_repo', '--repo <path> is required');
  const absolute = path.resolve(repo);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_repo', `--repo ${absolute} is not a directory`);
  }
  return absolute;
}

export function requireTaskText(args: RunCommandArgs): { text: string; source: string } {
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

/**
 * Progress rendering. In human mode every line goes to stdout. With --json
 * stdout carries one JSON object per line (JSONL) and the human lines become
 * stderr diagnostics, so stdout stays machine-readable end to end.
 */
export function createRunStream(reporter: Reporter, streams: Streams): RunStream {
  return {
    line: (text: string) => reporter.info(text),
    event: (record) => {
      if (reporter.json) streams.stdout.write(`${redactedJson(record)}\n`);
    },
  };
}

export async function commandRun(args: RunCommandArgs, deps: RunCommandDeps): Promise<CommandResult> {
  // Validate every input before touching state: an invalid invocation must
  // exit 2 without creating a state root or taking the coordinator lock.
  const repo = requireRepo(args.repo);
  if (args.agents === undefined) throw new CliError(EXIT_CODES.invalidInput, 'missing_agents', '--agents <file> is required');
  const loaded = loadConfigOrFail(args.agents);
  const task = requireTaskText(args);
  if (args.agent !== undefined && !loaded.config.agents.some((agent) => agent.id === args.agent)) {
    throw new CliError(
      EXIT_CODES.invalidInput,
      'unknown_agent',
      `--agent "${args.agent}" is not defined in ${loaded.path}`,
      [`configured agents: ${loaded.config.agents.map((agent) => `"${agent.id}"`).join(', ')}`],
    );
  }

  const paths = createStatePaths(resolveStateRoot(args.stateDir), args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {});
  // The paths manifest is written once, on the state root's first use. An
  // existing state root that records a different workspace root would make the
  // manifest a lie, so say so instead of silently writing somewhere else.
  if (args.workspaceRoot !== undefined && existsSync(paths.manifestPath)) {
    const recorded = PathsManifestSchema.safeParse(JSON.parse(readFileSync(paths.manifestPath, 'utf8')));
    if (recorded.success && path.resolve(recorded.data.workspaceRoot) !== paths.workspaceRoot) {
      throw new CliError(
        EXIT_CODES.invalidInput,
        'workspace_root_mismatch',
        `state root ${paths.root} already records workspace root ${recorded.data.workspaceRoot}; --workspace-root ${paths.workspaceRoot} disagrees with it`,
        ['use a different --state-dir for a different workspace root, or drop --workspace-root'],
      );
    }
  }
  let store;
  try {
    store = openStateStore(paths, { mode: 'mutating' });
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError(EXIT_CODES.executionFailure, 'coordinator_lock_held', error.message, [
        'only one mutating coordinator may own a state root; "workforce status <run-id>" works read-only while a run is in progress',
      ]);
    }
    throw error;
  }

  let result: RunDirectResult;
  try {
    result = await runDirect({
      repoPath: repo,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: task.text,
      requestSource: task.source,
      paths,
      db: store.db,
      stream: createRunStream(deps.reporter, deps.streams),
      ...(store.lock !== null ? { ownership: store.lock } : {}),
      ...(args.agent !== undefined ? { agentId: args.agent } : {}),
      ...(args.checks !== undefined ? { checkFlags: args.checks } : {}),
      ...(args.allowUnconfinedWrites === true ? { allowUnconfinedWrites: true } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      ...(deps.adapterFactory !== undefined ? { adapterFactory: deps.adapterFactory } : {}),
      ...(deps.sessionEnv !== undefined ? { sessionEnv: deps.sessionEnv } : {}),
    });
  } catch (error) {
    throw toCliError(error);
  } finally {
    store.close();
  }

  const exitCode: ExitCode =
    result.outcome === 'accepted' ? EXIT_CODES.verifiedCandidate : result.outcome === 'interrupted' ? EXIT_CODES.interrupted : EXIT_CODES.executionFailure;

  const data: Record<string, unknown> = {
    runId: result.runId,
    taskId: result.taskId,
    attemptId: result.attemptId,
    outcome: result.outcome,
    taskState: result.taskState,
    runState: result.runState,
    accepted: result.acceptance.accepted,
    stateRoot: paths.root,
    runDir: result.runDir,
    manifest: result.manifestPath,
    summary: result.summaryPath,
    patch: result.patchPath,
    base: result.manifest.base,
    candidate: result.manifest.candidate,
    requirements: result.manifest.requirements,
    timing: result.manifest.timing,
    usage: result.manifest.usage,
    unresolved: result.manifest.unresolved,
  };

  const lines: string[] = [
    `run ${result.runId}: ${result.outcome}`,
    `task ${result.taskId}: ${result.taskState}`,
    ...result.manifest.requirements.map((requirement) => `  ${statusLabel(requirement.status)} ${requirement.criterionId}: ${requirement.detail}`),
    `evidence and manifest: ${result.runDir}`,
  ];
  if (result.manifest.unresolved.length > 0) {
    lines.push('unresolved:');
    for (const item of result.manifest.unresolved) lines.push(`  - ${item}`);
  }

  return { command: 'run', exitCode, data, lines };
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof LockLostError) {
    return new CliError(EXIT_CODES.executionFailure, 'coordinator_ownership_lost', error.message, [
      'the coordinator lock stopped excluding other coordinators mid-run; whatever was written is preserved, but this run cannot claim it owned the state root',
    ]);
  }
  if (error instanceof AdapterNotRegisteredError) {
    return new CliError(EXIT_CODES.executionFailure, 'adapter_not_registered', error.message);
  }
  if (error instanceof CheckConfigurationError) {
    return new CliError(EXIT_CODES.invalidInput, `invalid_checks:${error.code}`, error.message);
  }
  if (error instanceof RunSetupError) {
    const invalid =
      error.code === 'not_a_git_repository' ||
      error.code === 'no_committed_base' ||
      error.code === 'unknown_agent' ||
      error.code === 'unsupported_runtime_setting' ||
      error.code === 'write_boundary_unsupported' ||
      error.code === 'no_acceptance_checks';
    return new CliError(invalid ? EXIT_CODES.invalidInput : EXIT_CODES.executionFailure, error.code, error.message);
  }
  if (error instanceof ProjectInspectionError) {
    return new CliError(EXIT_CODES.invalidInput, error.code, error.message);
  }
  if (error instanceof CandidateWorkspaceError) {
    return new CliError(EXIT_CODES.executionFailure, error.code, error.message);
  }
  return new CliError(EXIT_CODES.executionFailure, 'run_failed', (error as Error).message ?? String(error));
}
