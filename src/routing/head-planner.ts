/**
 * Department head planning: the first real `PlannerClient` (FR030, plan v2).
 *
 * Every request to a department is planned by its head. The head runs ONE
 * analysis session per planning attempt, in a read-only candidate copy of the
 * request's project, attached to the run's coordination bridge. The bridge
 * offers that session a single tool, `workforce_propose_plan`; a plan reaches
 * the coordinator through that call and no other way. A plan printed as text
 * creates nothing.
 *
 * The proposal is untrusted. Code decides: `validateHeadPlan` checks the
 * schema, the dependency graph, path ownership, the task budget and that every
 * assignee is a worker on this request's roster. An invalid plan gets exactly
 * one retry with its issues fed back; after that the run fails with the
 * recorded reason and no worker is ever started.
 *
 * What is recorded, in order, so a person can see each stage:
 *   head.planning_started, head.session_opened, the head's runtime events,
 *   plan.proposed (one per tool call, each with the raw proposal as an
 *   artifact), plan.validated or plan.rejected (one per attempt),
 *   head.assigned (one per task), head.planning_finished.
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { FAKE_SCENARIO_ENV } from '../adapters/index.js';
import type { RuntimeAdapter, RuntimeAttachment, RuntimeEvent, RuntimeReadiness, SessionHandle, StopReceipt, TurnHandle } from '../adapters/types.js';
import { attachmentReferenceText, validateAttachments } from '../adapters/attachments.js';
import { HEAD_BRIDGE_TOOL_NAMES } from '../coordination/bridge.js';
import type { CoordinationBridge } from '../coordination/index.js';
import { agentJobTitle } from '../core/workspace-config.js';
import type { EffectiveAgentBinding } from '../core/contracts.js';
import { newId } from '../core/ids.js';
import type { ProcessIdentity } from '../core/process.js';
import { RunSetupError, coordinationArgsFor, createAdapter, forTask, renderRuntimeEvent, validateRunAttachments, type RunStream } from '../core/run-direct.js';
import { createPlannedRun, type PlannedRun } from '../core/run-planned.js';
import { writeLineFrom } from '../core/run-stream.js';
import { computeAgentSnapshot } from '../core/snapshot.js';
import { writeArtifact } from '../storage/artifacts.js';
import { appendEvent } from '../storage/events.js';
import type { StatePaths } from '../storage/paths.js';
import { recordRuntimeEvent } from '../telemetry/events.js';
import { redactText } from '../telemetry/redaction.js';
import type { HeadAssignedTask, HeadPlanner, HeadPlanningInput, HeadPlanningOutcome } from '../workspace/planning.js';
import { assertCandidateGitIdentity, createCandidateWorkspace, removeCandidateWorkspace, type CandidateWorkspace } from '../workspaces/candidate.js';
import { git } from '../workspaces/git.js';
import { headPlanningResumeBlocker, recordHeadPlanning } from './head-planning-record.js';
import {
  validateHeadPlan,
  type HeadPlanRoster,
  type HeadPlannedTask,
  type PlanIssue,
  type PlannerClient,
  type PlannerRequest,
  type ValidatedHeadPlan,
} from './plan.js';

export const HEAD_PLAN_TOOL = HEAD_BRIDGE_TOOL_NAMES[0];
/** The first proposal plus one retry. */
export const MAX_PLAN_ATTEMPTS = 2;
/**
 * The fake test runtime has no MCP client configuration of its own, so it is
 * handed the same server description a real runtime receives on its command
 * line, in this variable. Set for the `fake` adapter only.
 */
export const FAKE_MCP_CONFIG_ENV = 'WORKFORCE_FAKE_MCP_CONFIG';
/** The heading of the retry section of a head's prompt. */
export const HEAD_RETRY_HEADING = 'your previous proposal was rejected';

const INTERRUPT_BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface HeadPromptInput {
  readonly workKind?: 'analysis' | 'implementation';
  readonly request: PlannerRequest;
  readonly headId: string;
  /** The head's read-only copy of the project. */
  readonly workspacePath: string;
  readonly baseRevision: string;
}

/**
 * The head's turn prompt: the user's request verbatim, then the one project it
 * is for, the workers it may assign, the plan format and the rules the
 * coordinator will check. It names no other project.
 */
export function composeHeadPrompt(input: HeadPromptInput): string {
  const { request } = input;
  const project = request.project ?? { id: '(unnamed)', name: '(unnamed)' };
  const roster = request.roster ?? [];
  const maxTasks = request.limits.maxTasksPerRun;
  const lines: string[] = [];
  lines.push(request.requestText.trimEnd());
  lines.push('');
  lines.push("--- planning (added by the workforce coordinator; the request above is the user's own wording) ---");
  lines.push(
    `You are ${input.headId}, the head of the ${request.department?.name ?? ''} department. You plan this request for one project only: "${project.name}" (id ${project.id}).`.replace('the  department', 'the department'),
  );
  lines.push(
    `Your working directory ${input.workspacePath} is a read-only copy of that project at commit ${input.baseRevision}. Read whatever helps you plan, and change nothing: you plan, and your workers do the work, each in a copy of their own.`,
  );
  lines.push('');
  lines.push('Workers you can assign. Every task goes to exactly one of these ids, never to you and never to anyone else:');
  if (input.workKind === 'analysis') lines.push('This request is read-only analysis. Assign inspection and explanation tasks only. The coordinator enforces the analysis policy on every worker. Workers must inspect source, cite concrete file paths, explain findings and limitations, and change no files. Repository test setup is not required to answer a codebase question. Prefer one appropriately skilled worker for a single codebase walkthrough.');
  for (const worker of roster) {
    lines.push(`- ${worker.id} — ${worker.name}${worker.jobTitle ? ` (${worker.jobTitle})` : ''}; runtime ${worker.runtime}; capabilities: ${worker.capabilities.length > 0 ? worker.capabilities.join(', ') : '(none listed)'}`);
  }
  lines.push('');
  lines.push(
    `Deliver the plan by calling the tool ${HEAD_PLAN_TOOL} (MCP server "workforce"). That call is the only way a plan reaches the coordinator: a plan written as text in your reply creates nothing. The tool answers with any issues it finds; fix them and call it again. The last plan you propose is the one decided on. Then end your turn.`,
  );
  lines.push('');
  lines.push('Plan format (planVersion 2):');
  lines.push(
    JSON.stringify(
      {
        planVersion: 2,
        summary: 'How you split the request, and why.',
        tasks: [
          {
            id: 't1',
            objective: 'What this worker must achieve.',
            assignee: roster[0]?.id ?? '<worker id>',
            acceptanceCriteria: [{ id: 'c1', description: 'How the worker knows it is done.' }],
            scope: { allowedPaths: ['src/feature/'] },
          },
          {
            id: 't2',
            objective: 'A second, different piece of work.',
            assignee: roster[1]?.id ?? roster[0]?.id ?? '<worker id>',
            acceptanceCriteria: [{ id: 'c1', description: 'How the worker knows it is done.' }],
            dependencies: [{ taskId: 't1' }],
          },
        ],
      },
      null,
      2,
    ),
  );
  lines.push('');
  lines.push('Rules the coordinator checks in code before any worker starts:');
  lines.push(`- 1 to ${maxTasks} task(s), with unique ids and no two tasks repeating the same objective;`);
  lines.push('- every task has an assignee from the list above and at least one acceptance criterion;');
  lines.push('- dependencies name tasks of this plan and form no cycle; a task starts only after the tasks it depends on are accepted;');
  lines.push('- no two tasks claim overlapping scope.allowedPaths.');
  lines.push('Tasks without dependencies run at the same time, each in its own copy of the project, so split the work along files that do not overlap.');
  lines.push(input.workKind === 'analysis' ? 'Analysis completes after the coordinator captures source-grounded reports, confirms the worker processes stopped and source stayed unchanged, and you review those reports against the request. Do not require code changes or repository test setup for this read-only request.' : "Acceptance is decided by the coordinator running the project's own checks against the combined result — never by a worker, or by you, saying the work is done.");
  if (request.previousIssues !== undefined && request.previousIssues.length > 0) {
    const attempt = request.attempt ?? 2;
    lines.push('');
    lines.push(`--- ${HEAD_RETRY_HEADING} (attempt ${attempt - 1} of ${request.maxAttempts ?? MAX_PLAN_ATTEMPTS}) ---`);
    lines.push(`Fix every issue below and call ${HEAD_PLAN_TOOL} again. ${attempt >= (request.maxAttempts ?? MAX_PLAN_ATTEMPTS) ? 'This is your last attempt: if this plan is rejected too, the request fails and no worker starts.' : ''}`.trimEnd());
    for (const issue of request.previousIssues) lines.push(`- [${issue.code}] ${issue.path}: ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The client: one planning session per proposal round
// ---------------------------------------------------------------------------

export type HeadRoundConclusion = 'completed' | 'turn_failed' | 'interrupted' | 'deadline' | 'runtime_exited';

export interface HeadRoundReport {
  readonly attempt: number;
  /** How many times the head called the planning tool in this round. */
  readonly proposals: number;
  readonly conclusion: HeadRoundConclusion;
  readonly detail: string | null;
  /** A rejected request cannot be repaired by asking the same head to plan again. */
  readonly runtimeActionRequired: boolean;
  readonly sessionStopped: boolean;
  readonly process: ProcessIdentity | null;
}

export interface HeadPlannerClientOptions {
  readonly workKind?: 'analysis' | 'implementation';
  readonly db: DatabaseSync;
  readonly paths: StatePaths;
  readonly runId: string;
  readonly planningId: string;
  readonly headAgentId: string;
  readonly adapter: RuntimeAdapter;
  readonly binding: EffectiveAgentBinding;
  readonly bridge: CoordinationBridge;
  readonly workspace: CandidateWorkspace;
  readonly roster: HeadPlanRoster;
  readonly stream: RunStream;
  readonly attachments?: ReadonlyArray<RuntimeAttachment>;
  readonly sessionEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly turnDeadlineMs: number;
  readonly ownership?: { assertOwnership(): void };
}

/**
 * `PlannerClient` for a department head.
 *
 * `propose` runs one planning round: a new analysis session in the head's
 * read-only copy, one turn, then the session is stopped. It returns the LAST
 * plan the head proposed through the tool in that round, or `undefined` when
 * the head proposed none. What it returns is untrusted; the caller validates.
 */
export class HeadPlannerClient implements PlannerClient {
  readonly #options: HeadPlannerClientOptions;
  #proposalCount = 0;
  #lastRound: HeadRoundReport | null = null;

  constructor(options: HeadPlannerClientOptions) {
    this.#options = options;
  }

  /** How the most recent round ended; null before the first. */
  get lastRound(): HeadRoundReport | null {
    return this.#lastRound;
  }

  /** Every tool call the head made across all rounds. */
  get proposalCount(): number {
    return this.#proposalCount;
  }

  async propose(request: PlannerRequest): Promise<unknown> {
    const o = this.#options;
    // This runs for every planning attempt, including retries after a file changed.
    const attachments = validateRunAttachments(o.adapter.id, o.attachments);
    const attempt = request.attempt ?? 1;
    const maxTasksPerRun = request.limits.maxTasksPerRun;
    const proposals: Array<Record<string, unknown>> = [];
    this.#lastRound = null;

    const bridgeConfig = o.bridge.headConfigFor({
      planningId: o.planningId,
      agentId: o.headAgentId,
      onProposePlan: (_identity, params) => this.#receive(params, attempt, proposals, maxTasksPerRun),
    });

    const runtimeEvents: RuntimeEvent[] = [];
    // A holder rather than loose `let`s: the stop path assigns these from an
    // abort listener, and the flow below must read what it assigned.
    const flow: {
      session: SessionHandle | null;
      turn: TurnHandle | null;
      stopReceipt: StopReceipt | null;
      stopping: Promise<void> | null;
      stopReason: 'interrupted' | 'deadline' | null;
      conclusion: HeadRoundConclusion;
      detail: string | null;
      runtimeActionRequired: boolean;
    } = { session: null, turn: null, stopReceipt: null, stopping: null, stopReason: null, conclusion: 'runtime_exited', detail: null, runtimeActionRequired: false };
    const stopped = (): boolean => flow.stopReason !== null;

    const stopSession = async (): Promise<void> => {
      const { session, turn } = flow;
      if (turn !== null) {
        try {
          await withDeadline(o.adapter.interrupt(turn), INTERRUPT_BUDGET_MS);
        } catch {
          // The owned process group is stopped below either way.
        }
      }
      if (session !== null && flow.stopReceipt === null) {
        try {
          flow.stopReceipt = await o.adapter.stopOwnedProcesses(session);
        } catch (error) {
          flow.detail = `the head's session could not be stopped: ${messageOf(error)}`;
        }
      }
    };
    const requestStop = (reason: 'interrupted' | 'deadline'): void => {
      if (flow.stopReason !== null) return;
      flow.stopReason = reason;
      appendEvent(o.db, { runId: o.runId, type: 'head.interrupt_requested', payload: { headAgentId: o.headAgentId, attempt, reason } });
      o.stream.line(reason === 'interrupted' ? "interrupt requested: stopping the head's planning session" : `the head's planning turn reached its ${o.turnDeadlineMs}ms deadline; stopping it`);
      flow.stopping = stopSession();
    };
    const onAbort = (): void => requestStop('interrupted');
    if (o.signal !== undefined) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    const deadline = setTimeout(() => requestStop('deadline'), o.turnDeadlineMs);
    deadline.unref?.();

    try {
      if (!stopped()) {
        const env: Record<string, string> = { ...(o.sessionEnv ?? {}) };
        if (o.adapter.id === 'fake') {
          const scenario = process.env[FAKE_SCENARIO_ENV];
          if (scenario !== undefined && env[FAKE_SCENARIO_ENV] === undefined) env[FAKE_SCENARIO_ENV] = scenario;
          env[FAKE_MCP_CONFIG_ENV] = bridgeConfig.claudeMcpConfigJson;
        }
        const extraArgs = coordinationArgsFor(o.adapter.id, bridgeConfig);
        const runtime = o.binding.runtime;
        const preparedAttachments = validateAttachments(o.adapter.id, attachments);
        // Still the one coordinator of this project? Ask before a session exists.
        o.ownership?.assertOwnership();
        appendEvent(o.db, {
          runId: o.runId,
          type: 'head.session_requested',
          payload: { headAgentId: o.headAgentId, attempt, planningId: o.planningId, adapter: o.adapter.id, runtimeId: runtime.id, workspacePath: o.workspace.path, policy: 'analysis' },
        });
        flow.session = await o.adapter.openSession({
          cwd: o.workspace.path,
          allowedWritePaths: [],
          policy: 'analysis',
          systemInstructions: o.binding.instructions,
          ...(runtime.model !== undefined ? { model: runtime.model } : {}),
          ...(runtime.effort !== undefined ? { effort: runtime.effort } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(extraArgs.length > 0 ? { extraArgs } : {}),
        });
        const session = flow.session;
        appendEvent(o.db, { runId: o.runId, type: 'head.session_opened', payload: { headAgentId: o.headAgentId, planningId: o.planningId, attempt, sessionId: session.sessionId, processId: session.processId ?? null, process: session.process ?? null } });
        o.stream.event({ type: 'head.session_opened', attempt, sessionId: session.sessionId, processId: session.processId ?? null });

        if (stopped()) {
          flow.stopping = stopSession();
        } else {
          const headPrompt = composeHeadPrompt({ request, headId: o.headAgentId, workspacePath: o.workspace.path, baseRevision: o.workspace.baseRevision, ...(o.workKind ? { workKind: o.workKind } : {}) });
          const references = o.adapter.id === 'fake' ? attachmentReferenceText(preparedAttachments) : '';
          const prompt = references.length > 0 ? `${headPrompt}\n\n${references}` : headPrompt;
          const turn = await o.adapter.startTurn(session, { prompt, ...(attachments.length > 0 ? { attachments } : {}) });
          flow.turn = turn;
          appendEvent(o.db, { runId: o.runId, type: 'head.turn_started', payload: { headAgentId: o.headAgentId, attempt, sessionId: session.sessionId, turnId: turn.turnId, promptCharacters: prompt.length } });
          if (stopped()) void o.adapter.interrupt(turn).catch(() => undefined);
          for await (const event of o.adapter.events(turn)) {
            runtimeEvents.push(event);
            try {
              recordRuntimeEvent(o.db, event, { runId: o.runId, taskId: null, attemptId: null, paths: o.paths });
            } catch {
              // The event log artifact below still carries it.
            }
            o.stream.event({ type: `runtime.${event.kind}`, sequence: event.sequence, turnId: event.turnId, rawRef: event.rawRef, payload: event.payload });
            const line = renderRuntimeEvent(event);
            // The words are the runtime's; a renderer must never colour them.
            if (line !== null) writeLineFrom(o.stream, line, 'runtime');
            if (event.kind === 'turn_completed') {
              flow.conclusion = event.payload['status'] === 'failed' || event.payload['isError'] === true ? 'turn_failed' : 'completed';
              if (flow.conclusion === 'turn_failed') {
                const failure = headRuntimeFailure(event.payload);
                flow.detail = failure?.message ?? flow.detail;
                flow.runtimeActionRequired ||= failure?.actionRequired === true;
              }
            } else if (event.kind === 'turn_interrupted') {
              flow.conclusion = 'interrupted';
            } else if (event.kind === 'error') {
              const failure = headRuntimeFailure(event.payload);
              flow.detail = failure?.message ?? flow.detail;
              flow.runtimeActionRequired ||= failure?.actionRequired === true;
              if (event.payload['fatal'] === true) flow.conclusion = 'runtime_exited';
            }
          }
        }
      }
    } finally {
      clearTimeout(deadline);
      o.signal?.removeEventListener('abort', onAbort);
      if (flow.stopping !== null) await flow.stopping;
      const session = flow.session;
      if (session !== null && flow.stopReceipt === null) {
        try {
          flow.stopReceipt = await o.adapter.stopOwnedProcesses(session);
        } catch (error) {
          flow.detail ??= `the head's session could not be stopped: ${messageOf(error)}`;
        }
      }
      if (session !== null) {
        const receipt = flow.stopReceipt;
        appendEvent(o.db, {
          runId: o.runId,
          type: 'head.session_stopped',
          payload: { headAgentId: o.headAgentId, planningId: o.planningId, attempt, sessionId: session.sessionId, state: receipt?.state ?? 'unknown', detail: receipt?.detail ?? null },
        });
      }
      bridgeConfig.revoke();
      if (runtimeEvents.length > 0) {
        try {
          writeArtifact(o.db, o.paths, {
            runId: o.runId,
            type: 'runtime_event_log',
            relativePath: `head/${o.planningId}/runtime-events-${attempt}.jsonl`,
            bytes: `${runtimeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
            provenance: { producer: 'headPlanner', adapter: o.adapter.id, headAgentId: o.headAgentId, attempt, note: "normalized adapter events of the head's planning turn" },
          });
        } catch {
          // Evidence that cannot be written does not change what the head proposed.
        }
      }
    }

    if (flow.stopReason !== null) flow.conclusion = flow.stopReason;
    this.#lastRound = { attempt, proposals: proposals.length, conclusion: flow.conclusion, detail: flow.detail, runtimeActionRequired: flow.runtimeActionRequired, sessionStopped: flow.session === null || flow.stopReceipt?.state === 'process_tree_terminated', process: flow.session?.process ?? null };
    return proposals.length === 0 ? undefined : proposals[proposals.length - 1];
  }

  /** A `workforce_propose_plan` call: record it, and tell the head at once what the coordinator will say. */
  #receive(params: Record<string, unknown>, attempt: number, proposals: Array<Record<string, unknown>>, maxTasksPerRun: number): Record<string, unknown> {
    const o = this.#options;
    this.#proposalCount += 1;
    const number = this.#proposalCount;
    proposals.push(params);
    const relativePath = `head/${o.planningId}/proposal-${number}.json`;
    let artifactId: string | null = null;
    try {
      artifactId = writeArtifact(o.db, o.paths, {
        runId: o.runId,
        type: 'head_plan_proposal',
        relativePath,
        bytes: `${JSON.stringify(params, null, 2)}\n`,
        provenance: { producer: 'headPlanner', headAgentId: o.headAgentId, attempt, proposal: number, note: 'the raw arguments of a workforce_propose_plan call; untrusted until validated' },
      }).id;
    } catch {
      // The event below still records that a proposal arrived.
    }
    const rawTasks = params['tasks'];
    const taskCount = Array.isArray(rawTasks) ? rawTasks.length : null;
    appendEvent(o.db, {
      runId: o.runId,
      type: 'plan.proposed',
      payload: { headAgentId: o.headAgentId, attempt, proposal: number, artifactId, relativePath: artifactId === null ? null : relativePath, taskCount },
    });
    o.stream.line(`plan proposed by head ${o.headAgentId} (attempt ${attempt}): ${taskCount === null ? 'no task list' : `${taskCount} task(s)`}`);
    o.stream.event({ type: 'plan.proposed', attempt, proposal: number, artifactId, taskCount });

    const preview = validateHeadPlan(params, o.roster, { maxTasksPerRun });
    return preview.ok
      ? {
          received: true,
          valid: true,
          taskCount: preview.plan.tasks.length,
          note: 'The plan passes validation and is recorded. It is decided on when your turn ends, and then your workers start. End your turn now and change no file.',
        }
      : {
          received: true,
          valid: false,
          issues: preview.issues,
          note: `This plan would be rejected. Fix every issue and call ${HEAD_PLAN_TOOL} again in this turn; the last plan you propose is the one decided on.`,
        };
  }
}

// ---------------------------------------------------------------------------
// The planner the run command calls
// ---------------------------------------------------------------------------

export interface HeadPlannerOptions {
  /** Only recovery supplies this, after acquiring and reconciling exclusive ownership. */
  readonly existingRunId?: string;
  /** Planning attempts before the run fails; defaults to 2 (the first proposal and one retry). */
  readonly maxAttempts?: number;
  /** Deadline for one planning turn; defaults to the run's `runTimeoutMinutes`. */
  readonly turnDeadlineMs?: number;
}

/** The department-head planner `workforce run --project --department` uses. */
export function createHeadPlanner(options: HeadPlannerOptions = {}): HeadPlanner {
  return (input) => planWithHead(input, options);
}

/**
 * Plan a request with its department head, inside a new planned run.
 *
 * On success the run is returned with the validated, assigned tasks and is
 * still `running`: the caller executes the tasks in it. On any refusal the run
 * has already been ended with the recorded reason, and no worker was started.
 */
export async function planWithHead(input: HeadPlanningInput, options: HeadPlannerOptions = {}): Promise<HeadPlanningOutcome> {
  const head = input.roster.head;
  let binding: EffectiveAgentBinding;
  try {
    binding = computeAgentSnapshot(input.snapshot.config, head.id).binding;
  } catch (error) {
    return { ok: false, code: 'head_binding_invalid', reason: `head "${head.id}" has no usable runtime binding in the roster configuration: ${messageOf(error)}`, exitCode: 2 };
  }

  let run: PlannedRun;
  try {
    const attachments = validateRunAttachments(binding.runtime.adapter, input.attachments);
    input.ownership?.assertOwnership();
    if (options.existingRunId !== undefined) {
      const blocker = headPlanningResumeBlocker(input.db, options.existingRunId);
      if (blocker !== null) return { ok: false, code: 'head_stop_unconfirmed', reason: blocker, exitCode: 3, runId: options.existingRunId };
    }
    run = await createPlannedRun({
      repoPath: input.repoPath,
      config: input.snapshot.config,
      configRaw: input.snapshot.raw,
      configPath: input.snapshot.path,
      requestText: input.requestText,
      requestSource: input.requestSource,
      ...(attachments.length > 0 ? { attachments } : {}),
      paths: input.paths,
      db: input.db,
      stream: input.stream,
      taskCount: null,
      ...(input.workKind ? { workKind: input.workKind } : {}),
      ...(options.existingRunId !== undefined ? { existingRunId: options.existingRunId } : {}),
      ...(input.checkFlags.length > 0 ? { checkFlags: input.checkFlags } : {}),
    });
  } catch (error) {
    if (error instanceof RunSetupError) return { ok: false, code: error.code, reason: error.message, exitCode: error.code.includes('attachment') ? 2 : 4 };
    throw error;
  }

  try {
    if (options.existingRunId === undefined) recordHeadPlanning(input, run.runId);
    return await planInRun(input, run, binding, options);
  } catch (error) {
    // A defect here must not leave a run saying "running" with nothing working on it.
    await run
      .abandon(input.signal?.aborted === true ? 'interrupted' : 'failed', `head planning stopped unexpectedly: ${messageOf(error)}`, { planning: { headAgentId: head.id, code: 'head_planning_error' } })
      .catch(() => undefined);
    throw error;
  }
}

type PlanningFailure = { readonly code: string; readonly reason: string; readonly details: ReadonlyArray<string>; readonly exitCode: 2 | 3 | 4 };

async function planInRun(input: HeadPlanningInput, run: PlannedRun, binding: EffectiveAgentBinding, options: HeadPlannerOptions): Promise<HeadPlanningOutcome> {
  const { roster, db, paths } = input;
  const head = roster.head;
  const runId = run.runId;
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_PLAN_ATTEMPTS);
  const planningId = newId();
  const aborted = (): boolean => input.signal?.aborted === true;
  const stream = forTask(input.stream, { runId, agentId: head.id, runtimeId: binding.runtime.id, adapter: binding.runtime.adapter, key: 'head' });
  const workerIds = roster.workers.map((worker) => worker.id);
  const planRoster: HeadPlanRoster = { headId: head.id, workerIds };
  const issuesByAttempt: PlanIssue[][] = [];
  let attemptsUsed = 0;

  const end = async (failure: PlanningFailure | 'interrupted'): Promise<HeadPlanningOutcome> => {
    const code = failure === 'interrupted' ? 'interrupted' : failure.code;
    const reason = failure === 'interrupted' ? `interrupted while head "${head.id}" was planning; no plan was accepted and no worker was started` : failure.reason;
    appendEvent(db, { runId, type: 'head.planning_finished', payload: { headAgentId: head.id, outcome: code, attempts: attemptsUsed } });
    await run.abandon(failure === 'interrupted' || code === 'head_stop_unconfirmed' ? 'interrupted' : 'failed', reason, { planning: { headAgentId: head.id, code, attempts: attemptsUsed, issues: issuesByAttempt } });
    const details = failure === 'interrupted' ? ['Resume restarts the head on the recorded request and roster after confirming its previous session has stopped.'] : [...failure.details];
    return { ok: false, code, reason, details: [...details, `run ${runId} records it: ${run.runDir}`], exitCode: failure === 'interrupted' ? 130 : failure.exitCode, runId };
  };

  appendEvent(db, {
    runId,
    type: 'head.planning_started',
    payload: {
      headAgentId: head.id,
      departmentId: roster.department.id,
      projectId: roster.project.id,
      planningId,
      runtimeId: binding.runtime.id,
      adapter: binding.runtime.adapter,
      maxAttempts,
      workers: workerIds,
    },
  });
  stream.line(`head ${head.id} of ${roster.department.name} is planning this request for project ${roster.project.name}; workers on the roster: ${workerIds.join(', ')}`);
  stream.event({ type: 'head.planning_started', headAgentId: head.id, planningId, maxAttempts, workers: workerIds });
  if (aborted()) return end('interrupted');

  // ---- The head's runtime --------------------------------------------------
  let adapter: RuntimeAdapter;
  try {
    adapter = (input.adapterFactory ?? createAdapter)(
      { id: binding.runtime.id, adapter: binding.runtime.adapter, executable: binding.runtime.executable },
      { runId, taskId: 'head', attemptId: planningId, logsDir: path.join(paths.runArtifactsDir(runId), 'logs', 'head') },
    );
  } catch (error) {
    return end({ code: 'head_runtime_unavailable', reason: `head "${head.id}" runs on ${binding.runtime.adapter}, which this build cannot drive (${messageOf(error)}); no plan was made and no worker was started`, details: [], exitCode: 3 });
  }
  const settings = adapter.validateSettings({
    ...(binding.runtime.model !== undefined ? { model: binding.runtime.model } : {}),
    ...(binding.runtime.effort !== undefined ? { effort: binding.runtime.effort } : {}),
  });
  if (!settings.ok) {
    const problems = [settings.model, settings.effort].filter((report) => report.status === 'unsupported').map((report) => report.message);
    return end({ code: 'unsupported_runtime_setting', reason: `head "${head.id}" requests settings the ${adapter.id} adapter does not support: ${problems.join('; ')}`, details: [], exitCode: 2 });
  }

  // Readiness through the runtime's own control handshake: no model turn.
  let readiness: RuntimeReadiness | null = null;
  try {
    readiness = await adapter.probe(binding.runtime.executable, { live: true });
  } catch (error) {
    const note = `the ${adapter.id} readiness check for head "${head.id}" could not be run (${messageOf(error)}), so planning started without knowing whether the runtime was usable`;
    run.unresolved.push(note);
    stream.line(`WARNING: ${note}`);
  }
  if (readiness !== null && !readiness.installed) {
    return end({ code: 'head_runtime_unavailable', reason: `head "${head.id}" runs on ${adapter.id}, but ${binding.runtime.executable} is not installed; no plan was made and no worker was started`, details: [...readiness.diagnostics], exitCode: 3 });
  }
  if (readiness?.authentication === 'logged_out') {
    return end({
      code: 'head_runtime_not_logged_in',
      reason: `head "${head.id}" runs on ${adapter.id} (${binding.runtime.executable}), and the runtime reports it is not logged in; no plan was made and no worker was started`,
      details: [...readiness.diagnostics, 'log in to that runtime interactively, then send the request again'],
      exitCode: 3,
    });
  }
  if (readiness?.authentication === 'unknown') {
    run.unresolved.push(`the ${adapter.id} readiness check could not establish whether head "${head.id}"'s runtime is logged in; planning went ahead`);
  }
  const bridge = run.bridge;
  if (bridge === null) {
    return end({ code: 'head_planning_unavailable', reason: `head "${head.id}" has no way to deliver a plan: the run's coordination bridge did not start, and a plan written as text creates nothing`, details: [...run.unresolved], exitCode: 4 });
  }

  // ---- The head's read-only copy of this project -----------------------------
  if (aborted()) return end('interrupted');
  let workspace: CandidateWorkspace;
  try {
    workspace = await createCandidateWorkspace({
      projectRoot: run.projectRoot,
      baseRevision: run.baseRevision,
      runId,
      taskId: 'head',
      attemptId: planningId,
      workspaceRoot: paths.workspaceRoot,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (aborted()) return end('interrupted');
    return end({ code: 'head_workspace_failed', reason: `the read-only copy of project "${roster.project.id}" for head "${head.id}" could not be created: ${messageOf(error)}`, details: [], exitCode: 4 });
  }
  appendEvent(db, { runId, type: 'head.workspace_created', payload: { headAgentId: head.id, planningId, path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision, readOnly: true } });

  const client = new HeadPlannerClient({
    ...(input.workKind ? { workKind: input.workKind } : {}),
    db,
    paths,
    runId,
    planningId,
    headAgentId: head.id,
    adapter,
    binding,
    bridge,
    workspace,
    roster: planRoster,
    stream,
    ...(run.attachments.length > 0 ? { attachments: run.attachments } : {}),
    turnDeadlineMs: options.turnDeadlineMs ?? run.limits.runTimeoutMinutes * 60_000,
    ...(input.sessionEnv !== undefined ? { sessionEnv: input.sessionEnv } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.ownership !== undefined ? { ownership: input.ownership } : {}),
  });
  const rosterEntries = roster.workers.map((worker) => {
    const runtime = input.workspace.runtimes[worker.runtime];
    return { id: worker.id, name: worker.name, jobTitle: agentJobTitle(worker), capabilities: [...worker.capabilities], runtime: runtime === undefined ? worker.runtime : `${worker.runtime} (${runtime.adapter})` };
  });

  // ---- Propose, validate, and at most one retry -------------------------------
  let validated: ValidatedHeadPlan | null = null;
  let failure: PlanningFailure | 'interrupted' | null = null;
  let previousIssues: PlanIssue[] | undefined;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      stream.line(`head ${head.id}: planning attempt ${attempt} of ${maxAttempts}`);
      let proposal: unknown;
      try {
        proposal = await client.propose({
          requestText: input.requestText,
          repoPath: run.projectRoot,
          contextRefs: [],
          limits: { maxTasksPerRun: input.maxTasksPerRun },
          project: { id: roster.project.id, name: roster.project.name },
          department: { id: roster.department.id, name: roster.department.name },
          roster: rosterEntries,
          attempt,
          maxAttempts,
          ...(previousIssues !== undefined ? { previousIssues } : {}),
        });
      } catch (error) {
        failure = aborted()
          ? 'interrupted'
          : { code: 'head_runtime_failed', reason: `head "${head.id}" could not run its planning turn on ${adapter.id}: ${messageOf(error)}; no plan was made and no worker was started`, details: [], exitCode: 4 };
        break;
      }
      const round = client.lastRound;
      if (round?.sessionStopped === false) {
        failure = { code: 'head_stop_unconfirmed', reason: `head "${head.id}" has no confirmed stopped process tree; no worker or replacement head was started`, details: ['Resume will recheck the recorded process identity before restarting planning.'], exitCode: 3 };
        break;
      }
      if (aborted() || round?.conclusion === 'interrupted') {
        failure = 'interrupted';
        break;
      }
      if (round?.runtimeActionRequired === true && round.conclusion !== 'completed') {
        failure = {
          code: 'head_runtime_rejected',
          reason: `head "${head.id}" could not run on ${adapter.id}: ${round.detail ?? 'the runtime rejected the request'}; no worker was started`,
          details: ['Update the configured runtime or choose a supported model and effort, then send the request again. Repeating the same planning prompt cannot correct a rejected runtime request.'],
          exitCode: 3,
        };
        break;
      }

      let issues: PlanIssue[];
      if (proposal === undefined) {
        issues = [{ code: 'no_plan_proposed', path: '(head)', message: `the head ended its turn without calling ${HEAD_PLAN_TOOL}${describeRound(round)}; a plan written as text creates nothing` }];
      } else {
        const validation = validateHeadPlan(proposal, planRoster, { maxTasksPerRun: input.maxTasksPerRun });
        if (validation.ok) {
          validated = validation.plan;
          appendEvent(db, { runId, type: 'plan.validated', payload: { headAgentId: head.id, attempt, taskCount: validation.plan.tasks.length, summary: validation.plan.summary, order: validation.plan.order } });
          stream.line(`plan accepted (attempt ${attempt}): ${validation.plan.tasks.length} task(s) — ${validation.plan.summary}`);
          stream.event({ type: 'plan.validated', attempt, taskCount: validation.plan.tasks.length });
          break;
        }
        issues = [...validation.issues];
      }
      issuesByAttempt.push(issues);
      const willRetry = attempt < maxAttempts;
      appendEvent(db, { runId, type: 'plan.rejected', payload: { headAgentId: head.id, attempt, willRetry, delivered: proposal !== undefined, issues } });
      stream.line(`plan ${proposal === undefined ? 'not delivered' : 'rejected'} (attempt ${attempt} of ${maxAttempts})${willRetry ? '; the head gets one retry with these issues' : ''}:`);
      for (const issue of issues) stream.line(`  - [${issue.code}] ${issue.path}: ${issue.message}`);
      stream.event({ type: 'plan.rejected', attempt, willRetry, issues });
      previousIssues = issues;
    }
  } finally {
    // A live/uncertain head retains its isolated copy; cleanup cannot revoke
    // an unconfined process's write access and must not race it.
    if (client.lastRound?.sessionStopped === true) await retireHeadWorkspace(db, run, head.id, planningId, workspace, client.lastRound.process);
  }

  if (failure !== null) return end(failure);
  if (aborted()) return end('interrupted');
  if (validated === null) {
    const last = issuesByAttempt[issuesByAttempt.length - 1] ?? [];
    return end({
      code: 'plan_rejected',
      reason: `department head "${head.id}" did not produce a valid plan in ${attemptsUsed} attempt(s), so no worker was started`,
      details: last.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`),
      exitCode: 4,
    });
  }

  // ---- Assignment ----------------------------------------------------------
  const tasks: HeadAssignedTask[] = validated.tasks.map((task) => {
    const taskId = newId();
    const dependencies = task.contract.dependencies.map((dependency) => dependency.taskId);
    appendEvent(db, {
      runId,
      taskId,
      type: 'head.assigned',
      payload: { key: task.id, taskId, agentId: task.assignee, headAgentId: head.id, objective: task.contract.objective, dependencies, attempt: attemptsUsed, decidedBy: 'head' },
    });
    stream.line(`  ${task.id} -> ${task.assignee}: ${firstLine(task.contract.objective)}${dependencies.length > 0 ? ` (after ${dependencies.join(', ')})` : ''}`);
    stream.event({ type: 'head.assigned', key: task.id, taskId, agentId: task.assignee });
    return { key: task.id, taskId, objective: workerObjective(task, input.workKind), agentId: task.assignee, ...(input.workKind === 'analysis' ? { writer: false } : {}), ...(dependencies.length > 0 ? { dependencies } : {}) };
  });
  appendEvent(db, { runId, type: 'head.planning_finished', payload: { headAgentId: head.id, outcome: 'planned', attempts: attemptsUsed, taskCount: tasks.length } });
  return { ok: true, tasks, summary: validated.summary, run, attempts: attemptsUsed };
}

/**
 * What the assigned worker is told: the head's objective first (its first line
 * becomes the task's contract objective), then the head's scope and criteria
 * as guidance. The project's own checks still decide acceptance.
 */
export function workerObjective(task: HeadPlannedTask, workKind?: 'analysis' | 'implementation'): string {
  const contract = task.contract;
  const lines = [contract.objective.trim()];
  if (contract.scope.description !== undefined && contract.scope.description.trim().length > 0) lines.push(`Scope: ${contract.scope.description.trim()}`);
  if (contract.scope.allowedPaths.length > 0) lines.push(`Stay within: ${contract.scope.allowedPaths.join(', ')}`);
  if (contract.scope.forbiddenPaths.length > 0) lines.push(`Do not change: ${contract.scope.forbiddenPaths.join(', ')}`);
  if (contract.acceptanceCriteria.length > 0) {
    lines.push(workKind === 'analysis' ? "Report requirements (the department head reviews your captured findings against the source):" : "Done when (your department head's criteria; the coordinator runs the project's own checks to accept the work):");
    for (const criterion of contract.acceptanceCriteria) lines.push(`- ${criterion.description}`);
  }
  for (const constraint of contract.constraints) lines.push(`Constraint: ${constraint}`);
  return lines.join('\n');
}

/**
 * Remove only an unchanged head copy after confirmed process termination.
 * Unexpected writes or uncertain identity remain preserved for inspection.
 */
async function retireHeadWorkspace(db: DatabaseSync, run: PlannedRun, headId: string, planningId: string, workspace: CandidateWorkspace, writer: ProcessIdentity | null): Promise<void> {
  try {
    await assertCandidateGitIdentity(workspace);
    const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: workspace.path });
    const changed = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (changed.length > 0) {
      run.unresolved.push(`head "${headId}" changed ${changed.length} path(s) in its read-only copy of the project while planning; those changes are preserved for inspection and are part of no delivered candidate`);
      appendEvent(db, { runId: run.runId, type: 'head.wrote_files', payload: { headAgentId: headId, planningId, count: changed.length, paths: changed.slice(0, 20) } });
    }
    const cleanup = await removeCandidateWorkspace(workspace, { disposition: 'rejected', readOnly: { quiesced: true, writer } });
    if (!cleanup.removed) appendEvent(db, { runId: run.runId, type: 'head.workspace_retained', payload: { headAgentId: headId, planningId, path: workspace.path, reason: cleanup.reason } });
  } catch (error) {
    appendEvent(db, { runId: run.runId, type: 'head.workspace_retained', payload: { headAgentId: headId, planningId, path: workspace.path, reason: messageOf(error) } });
  }
}

function describeRound(round: HeadRoundReport | null): string {
  if (round === null || round.conclusion === 'completed') return '';
  const what: Record<Exclude<HeadRoundConclusion, 'completed'>, string> = {
    deadline: 'the planning turn reached its deadline',
    runtime_exited: 'the runtime ended before the turn completed',
    turn_failed: 'the runtime reported that the turn failed',
    interrupted: 'the turn was interrupted',
  };
  return ` (${what[round.conclusion]}${round.detail !== null ? `: ${round.detail}` : ''})`;
}

/** Preserve actionable provider errors, including Codex's JSON-encoded HTTP 400 detail. */
function headRuntimeFailure(payload: Record<string, unknown>): { message: string; actionRequired: boolean } | null {
  const raw = [payload['error'], payload['detail'], payload['message']].find((value): value is string => typeof value === 'string' && value.length > 0);
  if (raw === undefined) return null;
  let message = raw;
  let actionRequired = payload['errorClass'] === 'request_rejected';
  try {
    const detail = JSON.parse(raw) as { status?: unknown; error?: { type?: unknown; message?: unknown } };
    if (detail !== null && typeof detail === 'object') {
      if (typeof detail.error?.message === 'string') message = detail.error.message;
      actionRequired ||= detail.status === 400 && detail.error?.type === 'invalid_request_error';
    }
  } catch {
    // Plain-text runtime errors remain plain text.
  }
  return { message: redactText(message).slice(0, 4_000), actionRequired };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? text.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
