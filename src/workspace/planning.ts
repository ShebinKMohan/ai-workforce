/**
 * The head-planning hook `workforce run --project --department` calls.
 *
 * On every request the department head makes a real planning decision: it
 * proposes tasks, each assigned to one roster worker, and code validates the
 * proposal before any worker starts. This module defines the seam only. The
 * head planner itself is a separate component; until it exists the default
 * hook REFUSES — it never guesses a plan, and a run with no plan starts no
 * worker.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AgentConfigFile } from '../core/contracts.js';
import type { AdapterFactory, RunStream } from '../core/run-direct.js';
import type { PlannedRun, PlannedTaskInput } from '../core/run-planned.js';
import type { WorkspaceConfig } from '../core/workspace-config.js';
import type { StatePaths } from '../storage/paths.js';
import type { Roster, RosterSnapshot } from './roster.js';

export interface HeadPlanningInput {
  readonly requestText: string;
  /** "argument", or the absolute path of the --task-file. */
  readonly requestSource: string;
  /** The project's repository root. */
  readonly repoPath: string;
  /** Committed HEAD the run will start from. */
  readonly baseRevision: string;
  readonly workspace: WorkspaceConfig;
  readonly roster: Roster;
  /** The v1 configuration holding only the roster, as written to `snapshot.path`. */
  readonly snapshot: RosterSnapshot;
  /** The project's own state paths. The caller holds that state root's coordinator lock. */
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly ownership?: { assertOwnership(): void };
  /** Acceptance-check flags the run will use (the project's configured checks; empty means resolved at the base revision). */
  readonly checkFlags: ReadonlyArray<string>;
  readonly maxTasksPerRun: number;
  readonly allowUnconfinedWrites: boolean;
  readonly stream: RunStream;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

/** A planned task with its assignee. The assignee must be a roster worker. */
export interface HeadAssignedTask extends PlannedTaskInput {
  readonly agentId: string;
}

export type HeadPlanningOutcome =
  | {
      readonly ok: true;
      readonly tasks: ReadonlyArray<HeadAssignedTask>;
      readonly summary: string | null;
      /**
       * The run the head planned inside. When present the tasks are executed
       * in it, so the planning events and the work are one run; the caller
       * must either run the tasks in it or abandon it.
       */
      readonly run?: PlannedRun;
      /** How many planning attempts the head used (the first proposal counts as 1). */
      readonly attempts?: number;
    }
  | {
      readonly ok: false;
      readonly code: string;
      /** Shown to the user as is. */
      readonly reason: string;
      readonly details?: ReadonlyArray<string>;
      /** 2 for an invalid binding, 3 when a person must act (for example a signed-out head runtime), 130 when interrupted; 4 otherwise. */
      readonly exitCode?: 2 | 3 | 4 | 130;
      /** The run that recorded the refusal, when one was created. It has already reached its final state. */
      readonly runId?: string;
    };

export type HeadPlanner = (input: HeadPlanningInput) => Promise<HeadPlanningOutcome>;

export const HEAD_PLANNING_UNAVAILABLE = 'head_planning_unavailable';

/** The default hook: refuses, plainly, and starts nothing. */
export const headPlanningUnavailable: HeadPlanner = async (input) => ({
  ok: false,
  code: HEAD_PLANNING_UNAVAILABLE,
  reason: `head planning not available: department "${input.roster.department.id}" routes every request through its head "${input.roster.head.id}", and this build cannot run a head's planning turn yet. No plan was guessed and no worker was started.`,
  details: ['to run work on this repository without a department today, use: workforce run --repo <path> --agents <file> --task <text>'],
  exitCode: 4,
});

/**
 * Refusals for a head's task list that the run command enforces whatever
 * planner produced it: at least one task, unique keys, every assignee a
 * worker on the roster (never the head, never anyone else), and no more tasks
 * than the limit. Empty means acceptable.
 */
export function headTaskIssues(roster: Roster, tasks: ReadonlyArray<HeadAssignedTask>, maxTasksPerRun: number): string[] {
  const issues: string[] = [];
  if (tasks.length === 0) issues.push('the plan has no tasks');
  if (tasks.length > maxTasksPerRun) issues.push(`the plan has ${tasks.length} tasks but maxTasksPerRun is ${maxTasksPerRun}`);
  const workers = new Set(roster.workers.map((worker) => worker.id));
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) issues.push(`task key "${task.key}" appears twice`);
    keys.add(task.key);
    if (task.agentId === roster.head.id) {
      issues.push(`task "${task.key}" is assigned to the head "${task.agentId}"; a head plans, its workers do the work`);
    } else if (!workers.has(task.agentId)) {
      issues.push(`task "${task.key}" is assigned to "${task.agentId}", who is not a worker on this roster; roster workers: ${[...workers].map((id) => `"${id}"`).join(', ')}`);
    }
  }
  return issues;
}
