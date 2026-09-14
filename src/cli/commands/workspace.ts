/**
 * `workforce workspace` — build and inspect the workspace from a terminal.
 *
 * Every mutating verb becomes one or more workspace operations applied by
 * `updateWorkspace`, the same code path the server's config routes use, so a
 * refusal reads the same everywhere. `--expect-revision <n>` makes a change
 * conditional on the file still being at revision n.
 *
 * Exit codes: 0 done (including "nothing changed"), 2 invalid input or a
 * refused change, 3 a revision conflict or an item in use, 4 another writer
 * held the file lock for too long.
 *
 * `show` reads only: passive discovery (no model turn) and each project's
 * checks at its last commit. It never creates the workspace file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { AdapterIdSchema, PolicySchema } from '../../core/contracts.js';
import type { ToolFact, WorkspaceConfig } from '../../core/workspace-config.js';
import { discoverWorkspaceRuntimes } from '../../discovery/readiness.js';
import { resolveStateRoot } from '../../storage/paths.js';
import { WorkspaceError } from '../../workspace/errors.js';
import { applyWorkspaceOps, createdIds, parseWorkspaceOps, standardRuntimeId } from '../../workspace/operations.js';
import { projectHasLiveRun } from '../../workspace/paths.js';
import { computeWorkspaceReadiness, toolFacts } from '../../workspace/readiness.js';
import { loadWorkspace, updateWorkspace } from '../../workspace/store.js';
import { expandHomePath, inspectProject } from '../../workspaces/project.js';
import { CliError, EXIT_CODES, type CommandResult } from '../output.js';

export interface WorkspaceCommandArgs {
  readonly positionals: ReadonlyArray<string>;
  readonly json: boolean;
  readonly stateDir?: string;
  readonly expectRevision?: string;
  readonly agents?: string;
  readonly repo?: string;
  readonly name?: string;
  readonly note?: string;
  readonly color?: string;
  readonly id?: string;
  readonly department?: string;
  readonly project?: string;
  readonly role?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly policy?: string;
  readonly instructions?: string;
  readonly instructionsFile?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly checks?: ReadonlyArray<string>;
  readonly adapter?: string;
  readonly executable?: string;
}

export interface WorkspaceCommandDeps {
  /** Passive discovery for `show`. Defaults to the one `doctor` runs without --connect. */
  readonly discover?: () => Promise<ReadonlyArray<ToolFact>>;
}

export const WORKSPACE_USAGE = `workspace commands (add --json for a machine-readable result, --expect-revision <n> to change only revision n):
  workforce workspace show
  workforce workspace init
  workforce workspace import --agents <agents.json> [--name <department>] [--note <note>]
  workforce workspace project add <folder> [--name <name>] [--id <id>] [--check "<cmd> [args]"]...
  workforce workspace project edit <id> [--name <name>] [--check "<cmd> [args]"]...
  workforce workspace project archive <id> | project remove <id>
  workforce workspace department add --name <name> [--note <note>] [--color blue|rose|sand|lavender|sage|slate] [--id <id>]
  workforce workspace department edit <id> [--name <name>] [--note <note>] [--color <color>]
  workforce workspace department archive <id> | department remove <id>
  workforce workspace agent add --department <id> --role head|worker --runtime codex|claude-code|<runtime-id> [--name <name>] [--id <id>]
                                [--instructions <text> | --instructions-file <file>] [--capability <c>]... [--policy <p>] [--model <m>] [--effort <e>] [--project <id>]
  workforce workspace agent edit <id> [--name] [--runtime] [--instructions | --instructions-file] [--capability]... [--policy] [--model] [--effort] [--department]
  workforce workspace agent archive <id>
  workforce workspace assign <agent> <project> | unassign <agent> <project>
  workforce workspace runtime set <id> --adapter codex|claude-code|fake [--executable <path>]
  workforce workspace runtime remove <id>`;

function usageError(message: string): CliError {
  return new CliError(EXIT_CODES.invalidInput, 'invalid_workspace_command', message, [WORKSPACE_USAGE]);
}

function positionals(rest: ReadonlyArray<string>, names: ReadonlyArray<string>, verb: string): string[] {
  if (rest.length < names.length) throw usageError(`workspace ${verb} needs ${names.map((n) => `<${n}>`).join(' ')}`);
  if (rest.length > names.length) throw usageError(`unexpected arguments after workspace ${verb}: ${rest.slice(names.length).join(' ')}`);
  return [...rest];
}

function requireFlag(value: string | undefined, flag: string, verb: string): string {
  if (value === undefined || value.trim().length === 0) throw usageError(`workspace ${verb} needs --${flag}`);
  return value;
}

function parseExpectRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError(EXIT_CODES.invalidInput, 'invalid_expect_revision', `--expect-revision must be a whole number, not "${value}"`);
  return Number(value);
}

function readInstructions(args: WorkspaceCommandArgs): string | undefined {
  if (args.instructions !== undefined && args.instructionsFile !== undefined) {
    throw new CliError(EXIT_CODES.invalidInput, 'ambiguous_instructions', 'pass either --instructions or --instructions-file, not both');
  }
  if (args.instructionsFile === undefined) return args.instructions;
  const file = path.resolve(args.instructionsFile);
  try {
    const text = readFileSync(file, 'utf8');
    if (text.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'empty_instructions', `--instructions-file ${file} is empty`);
    return text;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT_CODES.invalidInput, 'unreadable_instructions_file', `cannot read --instructions-file ${file}: ${(error as Error).message}`);
  }
}

function checkRole(role: string): 'head' | 'worker' {
  if (role !== 'head' && role !== 'worker') throw new CliError(EXIT_CODES.invalidInput, 'invalid_role', `--role must be "head" or "worker", not "${role}"`);
  return role;
}

function checkPolicy(policy: string | undefined): string | undefined {
  if (policy !== undefined && !PolicySchema.safeParse(policy).success) {
    throw new CliError(EXIT_CODES.invalidInput, 'invalid_policy', `--policy must be one of ${PolicySchema.options.join(', ')}, not "${policy}"`);
  }
  return policy;
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Apply ops under compare-and-swap and describe the outcome. */
function mutate(
  stateRoot: string,
  args: WorkspaceCommandArgs,
  action: string,
  rawOps: ReadonlyArray<Record<string, unknown>>,
  describe: (created: ReturnType<typeof createdIds>, config: WorkspaceConfig) => string,
  options: { readonly createIfMissing?: boolean } = {},
): CommandResult {
  const ops = rawOps.length === 0 ? [] : parseWorkspaceOps(rawOps);
  const expectRevision = parseExpectRevision(args.expectRevision);
  let before: WorkspaceConfig | null = null;
  const result = updateWorkspace(
    stateRoot,
    (current) => {
      before = structuredClone(current);
      return applyWorkspaceOps(current, ops, { stateRoot, projectHasLiveRun: (projectId) => projectHasLiveRun(stateRoot, projectId) });
    },
    {
      ...(expectRevision !== undefined ? { expectRevision } : {}),
      ...(options.createIfMissing === true ? { createIfMissing: true } : {}),
    },
  );
  const created = before === null ? { projects: [], departments: [], agents: [] } : createdIds(before, result.config);
  return {
    command: 'workspace',
    exitCode: EXIT_CODES.verifiedCandidate,
    data: { action, path: result.path, previousRevision: result.previousRevision, revision: result.revision, written: result.written, created },
    lines: result.written
      ? [describe(created, result.config), `workspace ${result.path}: revision ${result.revision}`]
      : [`nothing changed; workspace ${result.path} stays at revision ${result.revision}`],
  };
}

const STEP_LABEL: Record<string, string> = {
  tools: 'a coding tool, installed and signed in',
  project: 'a project with an acceptance check',
  department: 'a department with a head and a worker on a project',
  send: 'send a request',
};

async function show(stateRoot: string, deps: WorkspaceCommandDeps): Promise<CommandResult> {
  const loaded = loadWorkspace(stateRoot);
  const tools = deps.discover !== undefined ? await deps.discover() : toolFacts(await discoverWorkspaceRuntimes(loaded.config.runtimes));
  const { readiness, checks } = await computeWorkspaceReadiness(loaded.config, { tools });
  const config = loaded.config;
  const lines: string[] = [
    loaded.exists ? `workspace ${loaded.path} (revision ${config.revision})` : `no workspace yet at ${loaded.path}: the workspace is empty (revision 0)`,
    'setup:',
    ...readiness.steps.map((step) => `  ${step.state === 'done' ? '[done]' : step.state === 'current' ? '[next]' : '[    ]'} ${STEP_LABEL[step.id]}${step.reason !== null ? ` — ${step.reason}` : ''}`),
  ];
  lines.push(config.projects.length === 0 ? 'projects: none' : 'projects:');
  for (const project of config.projects) {
    const fact = checks.find((c) => c.projectId === project.id);
    lines.push(`  ${project.id}  ${project.repoPath}  checks: ${fact?.count ?? 'unknown'}${fact !== undefined && fact.count === null ? ` (${fact.detail})` : ''}${project.archived ? '  [archived]' : ''}`);
  }
  lines.push(config.departments.length === 0 ? 'departments: none' : 'departments:');
  for (const department of config.departments) {
    lines.push(`  ${department.id}  ${department.name}${department.note !== undefined ? ` (${department.note})` : ''}  head: ${department.headAgentId ?? 'none'}${department.archived ? '  [archived]' : ''}`);
    for (const agent of config.agents.filter((a) => a.departmentId === department.id && a.role === 'worker')) {
      lines.push(`    worker ${agent.id} (${agent.runtime}) projects: ${agent.projectScope !== 'restricted' ? 'all registered projects (automatic)' : agent.projectIds.length === 0 ? 'none (explicit restriction)' : agent.projectIds.join(', ')}${agent.archived ? '  [archived]' : ''}`);
    }
  }
  const sendable = readiness.eligibility.filter((pair) => pair.sendable);
  lines.push(sendable.length === 0 ? 'ready to send: nothing yet' : 'ready to send:');
  for (const pair of sendable) lines.push(`  workforce run --project ${pair.projectId} --department ${pair.departmentId} --task "<request>"`);
  return {
    command: 'workspace',
    exitCode: EXIT_CODES.verifiedCandidate,
    data: { action: 'show', path: loaded.path, exists: loaded.exists, revision: config.revision, workspace: config, readiness, checks, tools },
    lines,
  };
}

export async function commandWorkspace(args: WorkspaceCommandArgs, deps: WorkspaceCommandDeps = {}): Promise<CommandResult> {
  const stateRoot = resolveStateRoot(args.stateDir);
  const [verb, sub, ...rest] = args.positionals;
  try {
    switch (verb) {
      case undefined:
      case 'show':
        if (sub !== undefined) throw usageError(`unexpected arguments after workspace show: ${[sub, ...rest].join(' ')}`);
        return await show(stateRoot, deps);

      case 'init':
        if (sub !== undefined) throw usageError(`unexpected arguments after workspace init: ${[sub, ...rest].join(' ')}`);
        return mutate(stateRoot, args, 'init', [], () => 'created an empty workspace', { createIfMissing: true });

      case 'import': {
        if (sub !== undefined) throw usageError(`unexpected arguments after workspace import: ${[sub, ...rest].join(' ')}`);
        const file = path.resolve(requireFlag(args.agents, 'agents <agents.json>', 'import'));
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
          throw new CliError(EXIT_CODES.invalidInput, 'invalid_agents_file', `cannot read ${file} as JSON: ${(error as Error).message}`);
        }
        return mutate(stateRoot, args, 'import', [defined({ op: 'import.v1', config: parsed, departmentName: args.name, departmentNote: args.note })], (created) =>
          `imported ${created.agents.length} agent${created.agents.length === 1 ? '' : 's'} into department ${created.departments.join(', ')}; nobody is placed on a project yet (workforce workspace assign <agent> <project>)`,
        );
      }

      case 'project': {
        switch (sub) {
          case 'add': {
            const [folder] = positionals(rest, ['folder'], 'project add');
            const target = path.resolve(expandHomePath(folder!));
            if (!existsSync(target) || !statSync(target).isDirectory()) throw new CliError(EXIT_CODES.invalidInput, 'invalid_project_path', `${target} is not a directory`);
            const inspection = await inspectProject(target);
            if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
              throw new CliError(EXIT_CODES.invalidInput, 'not_a_git_repository', `${target} is not inside a Git repository; a project is a Git repository`);
            }
            return mutate(
              stateRoot,
              args,
              'project.add',
              [defined({ op: 'project.add', repoPath: inspection.repositoryRoot, name: args.name, id: args.id, checks: args.checks })],
              (created) => [`added project ${created.projects.join(', ')} (${inspection.repositoryRoot})`, ...inspection.diagnostics.map((d) => `  note: ${d}`)].join('\n'),
            );
          }
          case 'edit': {
            const [id] = positionals(rest, ['id'], 'project edit');
            return mutate(stateRoot, args, 'project.edit', [defined({ op: 'project.edit', id, name: args.name, checks: args.checks, repoPath: args.repo })], () => `updated project ${id}`);
          }
          case 'archive': {
            const [id] = positionals(rest, ['id'], 'project archive');
            return mutate(stateRoot, args, 'project.archive', [{ op: 'project.archive', id }], () => `archived project ${id}; it receives no new work`);
          }
          case 'remove': {
            const [id] = positionals(rest, ['id'], 'project remove');
            return mutate(stateRoot, args, 'project.remove', [{ op: 'project.remove', id }], () => `removed project ${id} from the workspace; its folder was not touched and its run history stays on disk`);
          }
          default:
            throw usageError(`unknown workspace project command "${sub ?? ''}"`);
        }
      }

      case 'department': {
        switch (sub) {
          case 'add':
            positionals(rest, [], 'department add');
            return mutate(
              stateRoot,
              args,
              'department.add',
              [defined({ op: 'department.add', name: requireFlag(args.name, 'name', 'department add'), note: args.note, color: args.color, id: args.id })],
              (created) => `added department ${created.departments.join(', ')}; it needs a head and a worker placed on a project before it can accept requests`,
            );
          case 'edit': {
            const [id] = positionals(rest, ['id'], 'department edit');
            return mutate(stateRoot, args, 'department.edit', [defined({ op: 'department.edit', id, name: args.name, note: args.note, color: args.color })], () => `updated department ${id}`);
          }
          case 'archive': {
            const [id] = positionals(rest, ['id'], 'department archive');
            return mutate(stateRoot, args, 'department.archive', [{ op: 'department.archive', id }], () => `archived department ${id}; it accepts no new requests`);
          }
          case 'remove': {
            const [id] = positionals(rest, ['id'], 'department remove');
            return mutate(stateRoot, args, 'department.remove', [{ op: 'department.remove', id }], () => `removed department ${id}`);
          }
          default:
            throw usageError(`unknown workspace department command "${sub ?? ''}"`);
        }
      }

      case 'agent': {
        switch (sub) {
          case 'add': {
            positionals(rest, [], 'agent add');
            const role = checkRole(requireFlag(args.role, 'role head|worker', 'agent add'));
            const op = defined({
              op: 'agent.add',
              departmentId: requireFlag(args.department, 'department <id>', 'agent add'),
              role,
              runtime: standardRuntimeId(requireFlag(args.runtime, 'runtime codex|claude-code|<runtime-id>', 'agent add')),
              name: args.name,
              id: args.id,
              instructions: readInstructions(args),
              capabilities: args.capabilities,
              policy: checkPolicy(args.policy),
              model: args.model,
              effort: args.effort,
              projectIds: args.project !== undefined ? [args.project] : undefined,
              projectScope: args.project !== undefined ? 'restricted' : undefined,
            });
            return mutate(stateRoot, args, 'agent.add', [op], (created, config) => {
              const agent = config.agents.find((a) => a.id === created.agents[0]);
              return agent === undefined
                ? 'added agent'
                : `added ${agent.role} ${agent.id} to department ${agent.departmentId} on ${agent.runtime} (${agent.policy})${agent.role === 'worker' ? agent.projectScope === 'restricted' ? `; project restriction: ${agent.projectIds.join(', ') || 'none'}` : '; available across all registered projects automatically' : ''}`;
            });
          }
          case 'edit': {
            const [id] = positionals(rest, ['id'], 'agent edit');
            const op = defined({
              op: 'agent.edit',
              id,
              name: args.name,
              runtime: args.runtime !== undefined ? standardRuntimeId(args.runtime) : undefined,
              instructions: readInstructions(args),
              capabilities: args.capabilities,
              policy: checkPolicy(args.policy),
              model: args.model,
              effort: args.effort,
              departmentId: args.department,
            });
            return mutate(stateRoot, args, 'agent.edit', [op], () => `updated agent ${id}`);
          }
          case 'archive': {
            const [id] = positionals(rest, ['id'], 'agent archive');
            return mutate(stateRoot, args, 'agent.archive', [{ op: 'agent.archive', id }], () => `archived agent ${id}; it receives no new work and its history stays readable`);
          }
          default:
            throw usageError(`unknown workspace agent command "${sub ?? ''}"`);
        }
      }

      case 'assign':
      case 'unassign': {
        const [agentId, projectId] = positionals(sub === undefined ? rest : [sub, ...rest], ['agent', 'project'], verb);
        return mutate(stateRoot, args, `agent.${verb}`, [{ op: `agent.${verb}`, agentId, projectId }], () =>
          verb === 'assign' ? `placed ${agentId} on project ${projectId}` : `took ${agentId} off project ${projectId}`,
        );
      }

      case 'runtime': {
        if (sub === 'remove') {
          const [id] = positionals(rest, ['id'], 'runtime remove');
          return mutate(stateRoot, args, 'runtime.remove', [{ op: 'runtime.remove', id }], () => `removed runtime binding ${id}; installed software and run history are unchanged`);
        }
        if (sub !== 'set') throw usageError(`unknown workspace runtime command "${sub ?? ''}"`);
        const [id] = positionals(rest, ['id'], 'runtime set');
        const adapter = requireFlag(args.adapter, 'adapter codex|claude-code|fake', 'runtime set');
        if (!AdapterIdSchema.safeParse(adapter).success) {
          throw new CliError(EXIT_CODES.invalidInput, 'invalid_adapter', `--adapter must be one of ${AdapterIdSchema.options.join(', ')}, not "${adapter}"`);
        }
        const executable = args.executable ?? (adapter === 'codex' ? 'codex' : adapter === 'claude-code' ? 'claude' : undefined);
        return mutate(
          stateRoot,
          args,
          'runtime.set',
          [defined({ op: 'runtime.set', id, adapter, executable: requireFlag(executable, 'executable <path>', 'runtime set'), model: args.model, effort: args.effort })],
          () => `runtime ${id} uses ${adapter} (${executable})`,
        );
      }

      default:
        throw usageError(`unknown workspace command "${verb}"`);
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw new CliError(error.exitCode, error.code, error.message, error.details);
    throw error;
  }
}
