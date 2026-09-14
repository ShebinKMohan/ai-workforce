/**
 * The roster of one request: a department's head plus that department's
 * workers eligible for the project. ALL work for the request goes through that
 * head, and only these agents may be assigned tasks.
 *
 * `rosterAgentConfig` turns the roster into a v1 `AgentConfigFile` holding
 * ONLY those agents. The run is started with it — its `config-snapshot.json`
 * records exactly that document — so resume, repair and fallback can only ever
 * bind an agent that was on the roster: there is nobody else in the file.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES, type CapabilityStatus } from '../adapters/index.js';
import { AGENT_CONFIG_SCHEMA_VERSION, validateAgentConfig, type AgentConfigFile } from '../core/contracts.js';
import { randomToken } from '../core/ids.js';
import { sha256Hex } from '../core/snapshot.js';
import {
  activeHead,
  eligibleWorkers,
  type WorkspaceAgent,
  type WorkspaceConfig,
  type WorkspaceDepartment,
  type WorkspaceProject,
} from '../core/workspace-config.js';
import type { StatePaths } from '../storage/paths.js';
import { invalidWorkspaceInput as invalid } from './errors.js';

export interface Roster {
  readonly project: WorkspaceProject;
  readonly department: WorkspaceDepartment;
  readonly head: WorkspaceAgent;
  /** Never empty. In admission order when selected, otherwise workspace file order. */
  readonly workers: ReadonlyArray<WorkspaceAgent>;
  /** The workspace revision the roster was built from. */
  readonly workspaceRevision: number;
}

export interface RosterSelector {
  readonly projectId: string;
  readonly departmentId: string;
  /** Exact reserved worker pool from admission. Never silently expanded. */
  readonly workerIds?: ReadonlyArray<string>;
}

function known(items: ReadonlyArray<{ id: string }>): string {
  return items.length === 0 ? '(none)' : items.map((item) => `"${item.id}"`).join(', ');
}

/**
 * Build the roster for (project, department), or refuse with exit 2 and a
 * plain reason: an unknown or archived project or department, a department
 * with no head, or no active worker permitted for the project.
 */
export function buildRoster(config: WorkspaceConfig, selector: RosterSelector): Roster {
  const project = config.projects.find((p) => p.id === selector.projectId);
  if (project === undefined) throw invalid('unknown_project', `unknown project "${selector.projectId}"; known projects: ${known(config.projects)}`);
  if (project.archived) throw invalid('project_archived', `project "${project.id}" is archived; archived projects receive no new work`);
  const department = config.departments.find((d) => d.id === selector.departmentId);
  if (department === undefined) throw invalid('unknown_department', `unknown department "${selector.departmentId}"; known departments: ${known(config.departments)}`);
  if (department.archived) throw invalid('department_archived', `department "${department.id}" is archived; archived departments accept no requests`);

  const head = activeHead(config, department.id);
  if (head === null) {
    throw invalid('department_has_no_head', `department "${department.id}" has no head, so it cannot accept requests`, [
      `add one: workforce workspace agent add --department ${department.id} --role head --runtime codex --name <name>`,
    ]);
  }
  const eligible = eligibleWorkers(config, department.id, project.id);
  if (eligible.length === 0) {
    const members = config.agents.filter((agent) => agent.departmentId === department.id && agent.role === 'worker' && !agent.archived);
    throw invalid(
      'no_worker_on_project',
      `department "${department.id}" has no active worker permitted for project "${project.id}"`,
      members.length === 0
        ? ['Add an active worker to this department. Workers can work across all projects by default.']
        : [
            ...members.map((worker) => `worker "${worker.id}" is explicitly restricted to: ${worker.projectIds.length === 0 ? 'no projects' : worker.projectIds.join(', ')}`),
            'Update an explicit project restriction in Agents to make a worker available for this project.',
          ],
    );
  }
  let workers: ReadonlyArray<WorkspaceAgent> = eligible;
  if (selector.workerIds !== undefined) {
    const selected = selector.workerIds;
    if (selected.length === 0 || new Set(selected).size !== selected.length) {
      throw invalid('invalid_worker_selection', 'the admitted worker pool must contain at least one distinct worker; an empty or duplicate selection cannot expand to the whole department');
    }
    const byId = new Map(eligible.map((worker) => [worker.id, worker]));
    const unavailable = selected.filter((id) => !byId.has(id));
    if (unavailable.length > 0) {
      throw invalid('worker_not_eligible', `the admitted workers are no longer eligible for department "${department.id}" on project "${project.id}": ${unavailable.map((id) => `"${id}"`).join(', ')}`, [
        'The request must be admitted again with an available eligible worker pool; no replacement worker was selected.',
      ]);
    }
    workers = selected.map((id) => byId.get(id)!);
  }
  return { project, department, head, workers, workspaceRevision: config.revision };
}

export function rosterAgentIds(roster: Roster): string[] {
  return [roster.head.id, ...roster.workers.map((worker) => worker.id)];
}

/** A v1 agent configuration holding only the roster: its runtimes, its head as the planner, its first worker as the default worker. */
export function rosterAgentConfig(config: WorkspaceConfig, roster: Roster): AgentConfigFile {
  const agents = [roster.head, ...roster.workers];
  const runtimes: AgentConfigFile['runtimes'] = {};
  for (const agent of agents) {
    const runtime = config.runtimes[agent.runtime];
    if (runtime !== undefined) runtimes[agent.runtime] = runtime;
  }
  const limits = config.limits;
  return validateAgentConfig({
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    runtimes,
    defaults: {
      workerAgent: roster.workers[0]!.id,
      plannerAgent: roster.head.id,
      maxActiveTurns: limits.maxActiveTurns,
      maxActiveWriters: limits.maxActiveWriters,
      maxTasksPerRun: limits.maxTasksPerRun,
      maxDelegationDepth: limits.maxDelegationDepth,
      maxRepairAttempts: limits.maxRepairAttempts,
      maxTransientRetries: limits.maxTransientRetries,
      runTimeoutMinutes: limits.runTimeoutMinutes,
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      runtime: agent.runtime,
      instructions: agent.instructions,
      capabilities: [...agent.capabilities],
      policy: agent.policy,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    })),
  });
}

export const ROSTERS_DIR_NAME = 'rosters';

export interface RosterSnapshot {
  readonly config: AgentConfigFile;
  /** The exact bytes written; pass as `configRaw` so the run records the same document. */
  readonly raw: string;
  /** `<project-state-root>/rosters/<department-id>.r<revision>.<sha256-12>.json` */
  readonly path: string;
  readonly sha256: string;
}

/**
 * Write the roster's v1 configuration into the project's state root. The file
 * is content-addressed and written once (temp file + rename), so it never
 * changes after a run was started from it.
 */
export function writeRosterSnapshot(paths: StatePaths, roster: Roster, rosterConfig: AgentConfigFile): RosterSnapshot {
  const raw = `${JSON.stringify(rosterConfig, null, 2)}\n`;
  const sha256 = sha256Hex(raw);
  const dir = path.join(paths.root, ROSTERS_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${roster.department.id}.r${roster.workspaceRevision}.${sha256.slice(0, 12)}.json`);
  if (!existsSync(file)) {
    const temp = `${file}.${randomToken(8)}.tmp`;
    writeFileSync(temp, raw, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  }
  return { config: rosterConfig, raw, path: file, sha256 };
}

// ---------------------------------------------------------------------------
// Strict isolation (decision Q2)
// ---------------------------------------------------------------------------

/**
 * What an adapter reports for `write_containment`. Only Codex is verified
 * today. Claude Code has no OS sandbox for any policy, analysis included, and
 * the fake test runtime enforces nothing, as does any adapter this build does
 * not know.
 */
export function adapterWriteContainment(adapter: string): CapabilityStatus {
  if (adapter === 'codex') return CODEX_CAPABILITIES.write_containment.status;
  if (adapter === 'claude-code') return CLAUDE_CODE_CAPABILITIES.write_containment.status;
  return 'unsupported';
}

export interface RosterContainment {
  /** True when the run must be the only live project run: some roster agent's runtime is not verified to contain writes. */
  readonly exclusive: boolean;
  /** Roster agents whose runtime's write containment is not `verified`, head included. */
  readonly unconfinedAgentIds: ReadonlyArray<string>;
}

export function rosterContainment(config: WorkspaceConfig, roster: Roster, containmentOf: (adapter: string) => CapabilityStatus = adapterWriteContainment): RosterContainment {
  const unconfined = [roster.head, ...roster.workers]
    .filter((agent) => {
      const runtime = config.runtimes[agent.runtime];
      return runtime === undefined || containmentOf(runtime.adapter) !== 'verified';
    })
    .map((agent) => agent.id);
  return { exclusive: unconfined.length > 0, unconfinedAgentIds: unconfined };
}
