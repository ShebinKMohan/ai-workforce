/**
 * The R0 direct path (FR019, FR020, FR029 foundation, FR041, FR049, FR058).
 *
 * One capable worker, one candidate workspace, one turn, then independently
 * executed acceptance checks. There is no planner, PM or reviewer
 * conversation: a bounded task does not need one. Every step still goes
 * through durable scheduling — dispatch intent is committed before a worker
 * starts, and a completion receipt is committed before the outcome is used.
 *
 * The single most important rule in this file: the task becomes `accepted`
 * only when `decideAcceptance` says every required criterion has a
 * verifier-executed receipt that passed. A runtime that says "done",
 * exits zero, or prints convincing test output changes nothing here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AgentConfigFile,
  type EffectiveAgentBinding,
  type Limits,
  type Policy,
  type TaskContract,
  RUN_REQUEST_VERSION,
  TASK_CONTRACT_VERSION,
  limitsFromDefaults,
  validateRunRequest,
  validateTaskContract,
} from './contracts.js';
import { newId, nowIso } from './ids.js';
import { computeAgentSnapshot } from './snapshot.js';
import type { ProcessIdentity } from './process.js';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  FakeAdapter,
  FAKE_SCENARIO_ENV,
  validateBindingSettings,
  type CapabilityStatus,
  type RuntimeAdapter,
  type RuntimeEvent,
  type SessionHandle,
  type StopReceipt,
  type TurnHandle,
} from '../adapters/index.js';
import { writeArtifact, type ArtifactRecord } from '../storage/artifacts.js';
import {
  findSurfaceChanges as computeSurfaceChanges,
  resolveAcceptanceSurface as computeAcceptanceSurface,
  surfaceBlockers as listSurfaceBlockers,
  surfaceDependencyPaths as listSurfaceDependencyPaths,
  surfacePaths as listSurfacePaths,
  type SurfaceSources,
} from '../verification/surface.js';
import { ensureRunDir, isWithin, type StatePaths } from '../storage/paths.js';
import { markDispatched, recordIntent, recordReceipt } from '../storage/operations.js';
import {
  insertAttempt,
  insertRun,
  insertTask,
  transitionAttempt,
  transitionRun,
  transitionTask,
  upsertAgentSnapshot,
} from '../storage/records.js';
import { appendEvent } from '../storage/events.js';
import { createCoordinationBridge, type AttemptBridgeConfig, type CoordinationBridge } from '../coordination/index.js';
import { projectEventsJsonl, recordRuntimeEvent, summarizeTurnEvidence, type TurnEvidence } from '../telemetry/events.js';
import { PhaseTimer, USAGE_UNAVAILABLE, type UsageReport } from '../telemetry/timing.js';
import {
  assertGrantedPathsSafe,
  candidateWritePaths,
  createCandidateWorkspace,
  snapshotCandidate,
  type CandidateSnapshot,
  type CandidateWorkspace,
} from '../workspaces/candidate.js';
import { git } from '../workspaces/git.js';
import { describeDirty, inspectProject, registerProject, type ProjectInspection } from '../workspaces/project.js';
import { classifyFailure, type FailureClassification, type ObservedFailure } from '../recovery/classify.js';
import {
  decideAcceptance,
  persistCheckReceipts,
  runChecks,
  type AcceptanceDecision,
  type CheckReceipt,
  type CheckSpec,
  type FixtureMutation,
} from '../verification/checks.js';

export const RUN_MANIFEST_VERSION = 1 as const;

/**
 * How long a runtime gets to acknowledge an interruption before the
 * coordinator terminates the process group it owns (plan section 9).
 */
export const INTERRUPT_ACKNOWLEDGEMENT_MS = 5_000;

/** Resolve `promise`, or `null` when it does not settle inside `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race handles a rejection, but only while it is still listening; this
  // keeps a late rejection from becoming an unhandled one.
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

export class AdapterNotRegisteredError extends Error {
  readonly adapter: string;

  constructor(adapter: string, arrivesWith: string) {
    super(`no adapter is registered for runtime adapter "${adapter}"; it arrives with ${arrivesWith}. Bind the agent to a registered runtime, or use the "fake" adapter for a deterministic local demonstration.`);
    this.name = 'AdapterNotRegisteredError';
    this.adapter = adapter;
  }
}

export interface RuntimeBindingRef {
  readonly id: string;
  readonly adapter: string;
  readonly executable: string;
}

/**
 * Per-attempt context an adapter needs but the runtime binding cannot carry.
 * `logsDir` is a path only: the adapter creates it lazily when it actually
 * opens a session, so a refused run leaves nothing behind.
 */
export interface AdapterContext {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** Where the adapter writes its raw runtime capture (`<run>/artifacts/logs`). */
  readonly logsDir: string;
}

export type AdapterFactory = (runtime: RuntimeBindingRef, context: AdapterContext) => RuntimeAdapter;

/**
 * ===================== ADAPTER REGISTRATION POINT =====================
 * 'fake' is the deterministic test runtime, 'codex' is the WP03 app-server
 * adapter and 'claude-code' is the WP05 CLI adapter. Every adapter implements
 * the same `RuntimeAdapter` contract, so nothing else in the direct path
 * changed when the second real runtime was added — which is the point of the
 * shared conformance suite in tests/adapters/conformance.
 * ======================================================================
 */
export function createAdapter(runtime: RuntimeBindingRef, context?: AdapterContext): RuntimeAdapter {
  switch (runtime.adapter) {
    case 'fake':
      return new FakeAdapter({ scriptPath: runtime.executable });
    case 'codex':
      // The raw JSONL capture is the only evidence of what the worker did,
      // so the run's own logs directory is handed to the adapter here.
      return new CodexAdapter({
        executablePath: runtime.executable,
        ...(context !== undefined ? { logsDir: context.logsDir } : {}),
      });
    case 'claude-code':
      // Same contract, different transport: the Claude Code CLI held open in
      // programmatic mode. The raw JSONL capture goes into the run's own logs
      // directory, exactly as the Codex adapter's does.
      return new ClaudeCodeAdapter({
        executablePath: runtime.executable,
        ...(context !== undefined ? { logsDir: context.logsDir } : {}),
      });
    default:
      throw new AdapterNotRegisteredError(runtime.adapter, 'a future work package');
  }
}

// ---------------------------------------------------------------------------
// Write containment (plan sections 6, 8 and 9; FR005, FR042)
// ---------------------------------------------------------------------------

/**
 * Profiles that let a worker change files. Plan section 6: R0 requires "a
 * minimum tested containment boundary before writes"; section 9: "fail setup
 * for an unsupported required boundary".
 */
const WRITING_POLICIES: ReadonlySet<Policy> = new Set<Policy>(['local-development']);

export interface ContainmentAssessment {
  readonly policy: Policy;
  /** True when the profile lets the worker write. */
  readonly writes: boolean;
  readonly status: CapabilityStatus;
  readonly note: string;
  /** The version and OS the status was established against; null when the adapter states none. */
  readonly testedVersion: string | null;
  readonly os: string | null;
  /** True when a writing profile is being run on a runtime that enforces no write boundary. */
  readonly unconfinedWrites: boolean;
  /** Set when the operator explicitly accepted an unconfined writing run. */
  readonly acknowledged: boolean;
}

/**
 * What the adapter says it can enforce for this profile, as a value the run
 * records rather than a sentence the manifest asserts.
 *
 * The plan is imperative here (section 8): "If an adapter cannot enforce a
 * required profile, fail that mode or use a supported isolated environment. Do
 * not silently broaden a profile because a check fails." Claude Code 2.1.260
 * reports `write_containment: unsupported` — it has no OS sandbox at all — so a
 * `local-development` run on it is refused unless the operator explicitly
 * accepts an unconfined run, and even then the fact is recorded in the
 * manifest and printed, instead of the run producing evidence indistinguishable
 * from a kernel-confined one.
 */
export function assessContainment(adapter: RuntimeAdapter, policy: Policy, acknowledged: boolean): ContainmentAssessment {
  const report = adapter.capabilities().capabilities.write_containment;
  const writes = WRITING_POLICIES.has(policy);
  return {
    policy,
    writes,
    status: report.status,
    note: report.note ?? '',
    testedVersion: report.testedVersion,
    os: report.os,
    unconfinedWrites: writes && report.status === 'unsupported',
    acknowledged,
  };
}

/** The line a human sees when a writing run has no enforced boundary, and the line a manifest records. */
export function describeUnconfinedWrites(adapter: string, containment: ContainmentAssessment): string {
  return `the ${adapter} adapter reports write_containment "unsupported"${containment.testedVersion !== null ? ` for ${containment.testedVersion} on ${containment.os ?? 'this platform'}` : ''}: nothing outside the runtime's own tool permissions bounds where a process it starts may write. ${containment.note}`;
}

/**
 * What the adapter told the run it cannot enforce for this profile.
 *
 * Read off the `session_started` event rather than from an adapter-specific
 * accessor, so every adapter that publishes the list gets it into the manifest.
 * Without this the list existed only in events.jsonl and no reader of the
 * manifest could tell which parts of the profile were prompts rather than
 * boundaries.
 */
const UnenforceableSchema = z.array(z.looseObject({ aspect: z.string(), reason: z.string() }));

export function readUnenforceable(events: ReadonlyArray<RuntimeEvent>): ReadonlyArray<{ readonly aspect: string; readonly reason: string }> {
  for (const event of events) {
    if (event.kind !== 'session_started') continue;
    const parsed = UnenforceableSchema.safeParse(event.payload['unenforceable']);
    if (parsed.success) return parsed.data.map((entry) => ({ aspect: entry.aspect, reason: entry.reason }));
  }
  return [];
}

/** The adapter's own identity for a reported change, when it supplies one. */
function changeIdentity(event: RuntimeEvent): string | null {
  for (const field of ['toolUseId', 'itemId'] as const) {
    const value = event.payload[field];
    if (typeof value === 'string' && value.length > 0) return `${field}:${value}`;
  }
  return null;
}

export interface UnplaceableChange {
  /** The path the runtime reported, or a stand-in when it reported none. */
  readonly descriptor: string;
  readonly reason: string;
}

const UNPLACEABLE_LIMIT = 20;

/**
 * Changes the runtime reported that this run cannot place inside the granted
 * paths.
 *
 * `withinAllowedPaths` is the adapter's answer to "did this write land inside
 * the boundary?", and its absence is not a yes: the runtime said a change
 * happened and the adapter could not say where. The Codex adapter reports
 * exactly this shape for a `fileChange` item that names no path at all.
 *
 * A change the runtime *refused* is excluded: nothing was written, so there is
 * nothing to place. Reports are grouped by the adapter's own item id so that
 * the "started" and "completed" halves of one change count once, with the
 * later record deciding.
 */
export function readUnplaceableChanges(events: ReadonlyArray<RuntimeEvent>): ReadonlyArray<UnplaceableChange> {
  const latest = new Map<string, RuntimeEvent>();
  let unkeyed = 0;
  for (const event of events) {
    if (event.kind !== 'file_change') continue;
    unkeyed += 1;
    latest.set(changeIdentity(event) ?? `#unkeyed-${unkeyed}`, event);
  }
  const out: UnplaceableChange[] = [];
  for (const event of latest.values()) {
    const payload = event.payload;
    if (typeof payload['withinAllowedPaths'] === 'boolean') continue;
    if (payload['denied'] === true || (payload['phase'] === 'completed' && payload['applied'] === false)) continue;
    const reported = typeof payload['path'] === 'string' && payload['path'].length > 0 ? (payload['path'] as string) : null;
    out.push(
      reported === null
        ? { descriptor: '(a change the runtime named no path for)', reason: 'the runtime reported a change without naming a path, so nothing about it can be placed inside the granted paths' }
        : { descriptor: reported, reason: 'the adapter could not resolve that path, so it could not say whether the write landed inside the granted paths' },
    );
    if (out.length >= UNPLACEABLE_LIMIT) break;
  }
  return out;
}

export interface WriteBoundaryObservation {
  /** What the capability table led this run to expect. Null when the profile writes nothing. */
  readonly expected: boolean | null;
  /**
   * What this run's own evidence establishes. Null when the profile writes
   * nothing, or when there is no evidence at all to stand behind an expected
   * boundary — an unproven claim is recorded as unproven, never as true.
   */
  readonly held: boolean | null;
  readonly escapes: ReadonlyArray<string>;
  readonly unconfirmedEscapes: ReadonlyArray<string>;
  readonly unplaceable: ReadonlyArray<UnplaceableChange>;
  /** One sentence per reason this run cannot record that the boundary held. */
  readonly findings: ReadonlyArray<string>;
}

/**
 * What THIS RUN observed about its write boundary, as opposed to what the
 * adapter's capability table expects of the runtime in general.
 *
 * The table is a claim about a version on a platform, established somewhere
 * else, at some other time. It is a fine statement of what should happen and a
 * useless statement of what did: a run whose own evidence lists a successful
 * write outside the granted paths has watched the boundary fail, whatever the
 * table says. So evidence decides, in one direction only — evidence can refute
 * an expected boundary, and it can never manufacture one the runtime does not
 * enforce.
 */
export function observeWriteBoundary(input: {
  readonly containment: ContainmentAssessment;
  readonly evidence: TurnEvidence | null;
  readonly events: ReadonlyArray<RuntimeEvent>;
}): WriteBoundaryObservation {
  const { containment, evidence, events } = input;
  const expected = containment.writes ? containment.status !== 'unsupported' : null;
  if (!containment.writes) {
    return { expected, held: null, escapes: [], unconfirmedEscapes: [], unplaceable: [], findings: [] };
  }

  const escapes = evidence?.fileChangesOutsideAllowedPaths ?? [];
  const unconfirmedEscapes = evidence?.unconfirmedFileChangesOutsideAllowedPaths ?? [];
  const unplaceable = readUnplaceableChanges(events);
  const findings: string[] = [];
  if (expected === false) {
    findings.push(`the runtime enforces no write boundary (write_containment "${containment.status}"), so there was never one to hold`);
  }
  for (const escape of escapes) {
    findings.push(
      unconfirmedEscapes.includes(escape)
        ? `the worker asked to write outside the granted paths (${escape}) and the runtime never reported whether the write happened`
        : `the worker wrote outside the granted paths (${escape})`,
    );
  }
  for (const change of unplaceable) {
    findings.push(`a reported change cannot be placed inside the granted paths (${change.descriptor}): ${change.reason}`);
  }

  if (findings.length > 0) {
    return { expected, held: false, escapes, unconfirmedEscapes, unplaceable, findings };
  }
  if (evidence === null) {
    return {
      expected,
      held: null,
      escapes,
      unconfirmedEscapes,
      unplaceable,
      findings: ['no turn evidence was collected for this run, so nothing observed stands behind the boundary the capability table expects'],
    };
  }
  return { expected, held: true, escapes, unconfirmedEscapes, unplaceable, findings: [] };
}

/** The one line a person needs when a run's evidence contradicts the boundary its runtime was expected to enforce. */
export function describeBoundaryBreach(adapter: string, observation: WriteBoundaryObservation): string {
  return (
    `THE WRITE BOUNDARY DID NOT HOLD IN THIS RUN — the ${adapter} adapter's capability table expects one, and this run's own evidence contradicts it: ` +
    `${observation.findings.join('; ')}`
  );
}

export interface WriteObservation {
  /** Where the entries come from. There is no filesystem-level observation of a worker's writes. */
  readonly basis: 'runtime_reported_tool_events';
  /** Whether an enforced boundary stood behind the report, as this run's evidence had it; null when nothing was established. */
  readonly enforcedWriteBoundary: boolean | null;
  /** What the capability table expected, kept beside what happened so the two can never be confused. */
  readonly expectedWriteBoundary: boolean | null;
  /** True only when a boundary could have refused an unreported write. Never true for a runtime with no sandbox. */
  readonly complete: boolean;
  /** Why the boundary is not recorded as having held. Empty when it did. */
  readonly boundaryFindings: ReadonlyArray<string>;
  readonly note: string;
}

/**
 * How much the run's list of writes outside the granted paths is worth.
 *
 * The list is assembled from `file_change` events, which exist because the
 * runtime reported a tool call. That is a report, not an observation: a worker
 * process that writes without reporting it produces an empty list, and on a
 * runtime with `write_containment: unsupported` nothing else would have
 * stopped it. Saying so in the manifest is the difference between "no escape
 * was observed" and "no escape happened".
 */
export function writeObservation(adapter: string, containment: ContainmentAssessment, observation: WriteBoundaryObservation): WriteObservation {
  const shared =
    `every entry is a write the ${adapter} runtime itself reported through a tool event; the coordinator does not watch the filesystem, so this list can only be as complete as the runtime's reporting.`;
  if (!containment.writes) {
    return {
      basis: 'runtime_reported_tool_events',
      enforcedWriteBoundary: null,
      expectedWriteBoundary: observation.expected,
      complete: false,
      boundaryFindings: [],
      note: `The profile grants no writes, so no write was expected at all; ${shared}`,
    };
  }
  if (observation.held === true) {
    return {
      basis: 'runtime_reported_tool_events',
      enforcedWriteBoundary: true,
      expectedWriteBoundary: observation.expected,
      complete: true,
      boundaryFindings: [],
      note:
        `The runtime enforces a write boundary (write_containment "${containment.status}") and nothing this run observed contradicts it: no reported write landed outside the granted paths, and every reported change could be placed inside them. A write outside the granted paths would have been refused whether or not it was reported; ${shared} An empty list therefore means no such write succeeded.`,
    };
  }
  if (observation.held === null) {
    return {
      basis: 'runtime_reported_tool_events',
      enforcedWriteBoundary: null,
      expectedWriteBoundary: observation.expected,
      complete: false,
      boundaryFindings: observation.findings,
      note:
        `Whether a write boundary held in this run was never established: ${observation.findings.join('; ')}. The capability table expects one, and an expectation is not an observation; ${shared}`,
    };
  }
  const because = observation.expected === true
    ? `The ${adapter} adapter's capability table expects a write boundary, and this run's own evidence says it did not hold: ${observation.findings.join('; ')}. `
    : '';
  return {
    basis: 'runtime_reported_tool_events',
    enforcedWriteBoundary: false,
    expectedWriteBoundary: observation.expected,
    complete: false,
    boundaryFindings: observation.findings,
    note:
      `${because}This run had no write boundary that held, so an unreported write outside the granted paths would leave no trace here: ${shared} An empty list means nothing was reported, NOT that nothing was written.`,
  };
}

/** The containment paragraph for this run, written from what the adapter reported rather than from a fixed template. */
export function renderContainmentNote(adapter: string, containment: ContainmentAssessment, observation: WriteBoundaryObservation): string {
  const shared =
    'The candidate workspace is a linked Git worktree: development isolation, not a security sandbox. Neither installed runtime confines reads at all — a worker can read files outside the repository, and this run did not prevent that. ' +
    'Each check ran in a separate disposable copy of the frozen candidate under a sanitized environment, with that copy, its HOME and its TMPDIR placed outside the coordinator state root, so no relative path from a check reaches coordinator state; the state root is fingerprinted on both sides of each check window, so a write that reached it by absolute path is recorded as an integrity failure instead of passing silently. Each receipt\'s `containment` and `stateRootGuard` report what was actually placed and actually measured. ' +
    'That is placement and detection, not confinement: repository test code still runs with this user\'s own filesystem privileges and can name any absolute path, so it can still read or write anything this user can — the home directory and the registered project checkout included — and an in-place overwrite that does not change a file\'s identity is recorded as an observation rather than a violation. ' +
    'An enforced execution boundary for tool and test subprocesses (FR042) is an R1 gate and is not claimed here; acceptance compensates only by refusing evidence whose fixtures the candidate changed.';
  if (!containment.writes) {
    return `This run used the read-only "${containment.policy}" profile, so no write boundary was required of the ${adapter} adapter (it reports write_containment "${containment.status}"). ${shared}`;
  }
  if (containment.status === 'unsupported') {
    const observed = observation.escapes.length > 0 || observation.unplaceable.length > 0
      ? `This run's own evidence records what happened without one: ${observation.findings.slice(1).join('; ')}. `
      : '';
    return (
      `THIS RUN HAD NO ENFORCED WRITE BOUNDARY. ${describeUnconfinedWrites(adapter, containment)} ` +
      'It ran under an explicit --allow-unconfined-writes, so writes outside the granted candidate were possible and were not prevented; the file changes listed above are what the runtime reported, not what a boundary permitted. ' +
      `${observed}${shared}`
    );
  }
  // The capability table expects a boundary here. What this run saw decides
  // whether it records one: a table cannot vouch for a run whose own evidence
  // contradicts it.
  if (observation.held === false) {
    return (
      `${describeBoundaryBreach(adapter, observation)}. The adapter reports write_containment "${containment.status}"${containment.testedVersion !== null ? ` (established against ${containment.testedVersion} on ${containment.os ?? 'this platform'})` : ''}, ` +
      'and that status describes the runtime in general, not this run: the evidence above is what this run observed, and it is what the run records. ' +
      `${shared}`
    );
  }
  if (observation.held === null) {
    return (
      `WHETHER A WRITE BOUNDARY HELD IN THIS RUN WAS NOT ESTABLISHED: ${observation.findings.join('; ')}. ` +
      `The ${adapter} adapter reports write_containment "${containment.status}", which is what is expected of the runtime and not what this run observed. ${shared}`
    );
  }
  return (
    `Write confinement for this run is what the ${adapter} adapter reports as write_containment "${containment.status}"${containment.testedVersion !== null ? ` (established against ${containment.testedVersion} on ${containment.os ?? 'this platform'})` : ''}: ${containment.note} ` +
    'Nothing this run observed contradicts it: no reported write landed outside the granted paths, and every reported change could be placed inside them. ' +
    `Any write seen outside the granted paths is listed above and blocks acceptance. ${shared}`
  );
}

// ---------------------------------------------------------------------------
// Acceptance check resolution
// ---------------------------------------------------------------------------

const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `.workforce/checks.json`. Deliberately narrower than `CheckSpec`: a
 * repository cannot supply `env`, because check definitions come from the
 * project but must not be able to inject values into the verifier's
 * environment.
 */
export const RepoCheckSchema = z.strictObject({
  criterionId: z.string().regex(CRITERION_ID, { message: 'criterion ids use letters, digits, ".", "_" or "-" and must start with a letter or digit' }),
  description: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(24 * 60 * 60 * 1000).optional(),
  required: z.boolean().optional(),
});

export const RepoChecksFileSchema = z.strictObject({
  checksVersion: z.literal(1),
  checks: z.array(RepoCheckSchema).min(1).max(32),
});

export type CheckSource = 'cli_flags' | 'repository_config' | 'detected' | 'none';

export interface ResolvedChecks {
  readonly source: CheckSource;
  readonly checks: ReadonlyArray<CheckSpec>;
  readonly detail: string;
}

export class CheckConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckConfigurationError';
    this.code = code;
  }
}

/**
 * Split a `--check "<command> [args]"` value into an argv array.
 *
 * No shell is involved at any point: this only splits on whitespace with
 * quoting support. Shell metacharacters are rejected rather than quietly
 * passed to a program that would not interpret them anyway.
 */
export function tokenizeCheckCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < value.length) {
        i += 1;
        current += value[i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < value.length) {
      i += 1;
      current += value[i]!;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    if (';|&$`<>()\n'.includes(ch)) {
      throw new CheckConfigurationError(
        'shell_metacharacter',
        `--check "${value}" contains "${ch}"; checks are executed directly with an argument array and never through a shell, so pipes, redirection and substitution are not available. Put the composite command in a script and call that instead.`,
      );
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new CheckConfigurationError('unterminated_quote', `--check "${value}" has an unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) tokens.push(current);
  if (tokens.length === 0) throw new CheckConfigurationError('empty_check', 'a --check value must name a command');
  return tokens;
}

export function checksFromFlags(values: ReadonlyArray<string>): CheckSpec[] {
  return values.map((value, index) => {
    const [command, ...args] = tokenizeCheckCommand(value);
    return { criterionId: `check-${index + 1}`, description: `--check "${value}"`, command: command!, args, required: true } satisfies CheckSpec;
  });
}

/** Read a path out of the base revision, so a worker cannot change acceptance by editing the repository. */
async function showAtRevision(repoRoot: string, revision: string, relativePath: string): Promise<string | null> {
  const run = await git(['show', `${revision}:${relativePath}`], { cwd: repoRoot, maxOutputBytes: 1024 * 1024 });
  return run.ok ? run.stdout : null;
}

/**
 * Resolve acceptance checks, in precedence order:
 *   1. `--check` flags;
 *   2. `.workforce/checks.json` **at the base revision**;
 *   3. detection from the base revision's file list.
 *
 * Everything is read from the frozen base, never from the working tree, so a
 * dirty checkout or a worker edit cannot change what acceptance means.
 */
export async function resolveAcceptanceChecks(
  repoRoot: string,
  baseRevision: string,
  flagValues: ReadonlyArray<string> = [],
): Promise<ResolvedChecks> {
  if (flagValues.length > 0) {
    return { source: 'cli_flags', checks: checksFromFlags(flagValues), detail: `${flagValues.length} check(s) from --check flags` };
  }

  const raw = await showAtRevision(repoRoot, baseRevision, '.workforce/checks.json');
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CheckConfigurationError('invalid_checks_json', `.workforce/checks.json at ${baseRevision.slice(0, 12)} is not valid JSON: ${(error as Error).message}`);
    }
    const result = RepoChecksFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      throw new CheckConfigurationError('invalid_checks_config', `.workforce/checks.json at ${baseRevision.slice(0, 12)} is invalid: ${issues}`);
    }
    const checks = result.data.checks.map(
      (check): CheckSpec => ({
        criterionId: check.criterionId,
        command: check.command,
        args: check.args,
        required: check.required ?? true,
        ...(check.description !== undefined ? { description: check.description } : {}),
        ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      }),
    );
    return { source: 'repository_config', checks, detail: `${checks.length} check(s) from .workforce/checks.json at base ${baseRevision.slice(0, 12)}` };
  }

  const detected = await detectChecks(repoRoot, baseRevision);
  if (detected !== null) return detected;

  return {
    source: 'none',
    checks: [],
    detail: 'no acceptance checks are configured: add .workforce/checks.json, or pass --check "<command> [args]"',
  };
}

/** Every tracked path at a revision. Empty when the revision cannot be listed. */
export async function listFilesAtRevision(repoRoot: string, revision: string): Promise<string[]> {
  const listing = await git(['ls-tree', '-r', '--name-only', '-z', revision], { cwd: repoRoot, maxOutputBytes: 8 * 1024 * 1024 });
  return listing.ok ? listing.stdout.split('\0').filter((name) => name.length > 0) : [];
}

async function detectChecks(repoRoot: string, baseRevision: string): Promise<ResolvedChecks | null> {
  const files = await listFilesAtRevision(repoRoot, baseRevision);

  if (files.includes('package.json')) {
    const raw = await showAtRevision(repoRoot, baseRevision, 'package.json');
    if (raw !== null) {
      try {
        const manifest = JSON.parse(raw) as { scripts?: Record<string, unknown> };
        const testScript = manifest.scripts?.['test'];
        if (typeof testScript === 'string' && testScript.trim().length > 0) {
          return {
            source: 'detected',
            checks: [{ criterionId: 'package-test-script', description: `package.json test script: ${testScript}`, command: 'npm', args: ['test', '--silent'], required: true }],
            detail: `detected the package.json "test" script (${testScript}) at base ${baseRevision.slice(0, 12)}`,
          };
        }
      } catch {
        // A malformed package.json is not an acceptance configuration error; fall through to other detection.
      }
    }
  }

  const pythonTests = files.filter((name) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/.test(name));
  if (pythonTests.length > 0) {
    return {
      source: 'detected',
      checks: [
        {
          criterionId: 'python-unittest',
          description: `python unittest discovery over ${pythonTests.length} test file(s)`,
          command: 'python3',
          args: ['-m', 'unittest', 'discover', '-v'],
          required: true,
        },
      ],
      detail: `detected ${pythonTests.length} Python test file(s) at base ${baseRevision.slice(0, 12)}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Acceptance fixture surface
// ---------------------------------------------------------------------------

// The surface itself lives in `verification/surface.ts` so that the combined
// acceptance decision in `integration/combine.ts` applies exactly the same
// rule. Re-exported here because callers and tests know it by this path.
export {
  acceptanceSurface,
  findSurfaceChanges,
  resolveAcceptanceSurface,
  surfaceDependencyPaths,
  surfacePaths,
  type AcceptanceSurface,
  type SurfaceFindings,
  type SurfaceResolution,
} from '../verification/surface.js';

/**
 * What the surface needs from the base revision: `package.json` for the script
 * chain, and a reader so the module graph can be followed.
 *
 * The reader goes through `git show` rather than the working tree, so a dirty
 * checkout cannot change which files a criterion is judged to execute.
 */
export async function baseSurfaceContext(repoRoot: string, baseRevision: string, baseFiles: ReadonlyArray<string>): Promise<SurfaceSources> {
  const readBaseFile = (relativePath: string): Promise<string | null> => showAtRevision(repoRoot, baseRevision, relativePath);
  if (!baseFiles.includes('package.json')) return { readBaseFile };
  return { packageManifest: await showAtRevision(repoRoot, baseRevision, 'package.json'), readBaseFile };
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

export interface PromptInput {
  /** The user's request, reproduced verbatim. */
  readonly requestText: string;
  readonly contextRefs: ReadonlyArray<string>;
  readonly workspace: CandidateWorkspace;
  readonly inspection: ProjectInspection;
  readonly contract: TaskContract;
  /** What completed dependencies produced, when this task has any. */
  readonly briefing?: string;
  /** Messages waiting for this task, delivered at the safe boundary before the turn. */
  readonly inbox?: ReadonlyArray<string>;
  /** Who this worker is and who it can talk to, when it is one task of a run. */
  readonly coordination?: {
    readonly taskId: string;
    readonly key?: string;
    readonly peers: ReadonlyArray<{ readonly key: string; readonly taskId: string; readonly objective: string }>;
    /** False when no bridge started; the worker is told plainly rather than left to guess. */
    readonly toolsAvailable: boolean;
  };
}

/**
 * The turn prompt: the user's own wording first and unmodified, then the
 * repository context the worker needs. Nothing is summarized away.
 */
export function composeTaskPrompt(input: PromptInput): string {
  const { workspace, inspection, contract } = input;
  const lines: string[] = [];
  lines.push(input.requestText.trimEnd());
  lines.push('');
  lines.push('--- repository context (added by the workforce coordinator; the request above is the user\'s own wording) ---');
  lines.push(`Working directory: ${workspace.path}`);
  lines.push(`This is a candidate workspace: a linked Git worktree of ${workspace.projectRoot} on the new branch ${workspace.branch}.`);
  lines.push(`Base revision: ${workspace.baseRevision} (committed HEAD${inspection.branch !== null ? ` of ${inspection.branch}` : ', detached'}).`);
  if (workspace.excludedUncommittedChanges !== null && !workspace.excludedUncommittedChanges.clean) {
    lines.push(`Uncommitted changes in the user's checkout are NOT included in this candidate (${describeDirty(workspace.excludedUncommittedChanges)}). Work from the committed base only.`);
  }
  if (inspection.hasSubmodules) {
    lines.push(`The repository declares submodules (${inspection.submodulePaths.join(', ')}); they are not populated in this worktree.`);
  }
  if (input.contextRefs.length > 0) {
    lines.push(`Context references supplied with the request: ${input.contextRefs.join(', ')}.`);
  }
  if (input.coordination !== undefined) {
    const coordination = input.coordination;
    lines.push('');
    lines.push('--- coordination ---');
    lines.push(`Your task id is ${coordination.taskId}${coordination.key !== undefined ? ` (plan key "${coordination.key}")` : ''}. The coordinator stamps this identity itself; you cannot send as anyone else.`);
    if (coordination.peers.length > 0) {
      lines.push('Other tasks in this run, and the ids you must use to address them:');
      for (const peer of coordination.peers) lines.push(`- ${peer.taskId} — "${peer.key}": ${peer.objective}`);
      lines.push(
        coordination.toolsAvailable
          ? 'To ask a peer something, call send_message with `to` set to that task id, then read_inbox for the answer. Peers work at the same time as you, so ask early and keep working while you wait.'
          : 'The coordination tools are not available in this run, so these peers cannot be contacted; do what you can within your own task.',
      );
    } else if (coordination.toolsAvailable) {
      lines.push('You are the only task in this run; send_message without `to` reaches the coordinator.');
    }
  }
  if (input.briefing !== undefined && input.briefing.trim().length > 0) {
    lines.push('');
    lines.push('--- what the tasks you depend on produced ---');
    lines.push(input.briefing.trimEnd());
  }
  if (input.inbox !== undefined && input.inbox.length > 0) {
    lines.push('');
    lines.push('--- messages waiting for this task ---');
    for (const message of input.inbox) lines.push(`- ${message}`);
  }
  lines.push('');
  lines.push('Changed-file rules:');
  lines.push(`- Edit files under ${workspace.path} only. A write outside it is recorded as out of scope and is not part of the candidate.`);
  lines.push('- Do not create commits, branches or tags, and do not touch .git: the coordinator creates the checkpoint commit for the candidate.');
  if (contract.scope.allowedPaths.length > 0) lines.push(`- Stay within: ${contract.scope.allowedPaths.join(', ')}.`);
  if (contract.scope.forbiddenPaths.length > 0) {
    lines.push(`- Do not modify or delete: ${contract.scope.forbiddenPaths.join(', ')}. The acceptance criteria execute those files; changing them does not make a criterion pass, it makes the run refuse acceptance. You may add new test files.`);
  }
  lines.push('');
  lines.push('Acceptance criteria. The coordinator runs these itself against a frozen copy of your result; reporting success does not mark the task accepted:');
  for (const criterion of contract.acceptanceCriteria) {
    const command = criterion.check === undefined ? '(no command)' : [criterion.check.command, ...criterion.check.args].join(' ');
    lines.push(`- ${criterion.id}: ${criterion.description} — the verifier runs \`${command}\``);
  }
  for (const constraint of contract.constraints) lines.push(`- Constraint: ${constraint}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Run inputs and outputs
// ---------------------------------------------------------------------------

export interface RunStream {
  /** One normalized record; rendered as a line for humans or a JSONL object with --json. */
  event(record: Record<string, unknown> & { readonly type: string }): void;
  /** Human progress line. */
  line(text: string): void;
}

export const SILENT_STREAM: RunStream = { event: () => {}, line: () => {} };

export interface RunDirectInput {
  readonly repoPath: string;
  readonly config: AgentConfigFile;
  readonly configRaw: string;
  readonly configPath: string;
  readonly requestText: string;
  readonly requestSource: string;
  readonly contextRefs?: ReadonlyArray<string>;
  readonly agentId?: string;
  readonly checkFlags?: ReadonlyArray<string>;
  readonly paths: StatePaths;
  readonly db: DatabaseSync;
  readonly stream?: RunStream;
  readonly signal?: AbortSignal;
  readonly adapterFactory?: AdapterFactory;
  /** Extra environment for the runtime session (used to select a fake-runtime scenario). */
  readonly sessionEnv?: Readonly<Record<string, string>>;
  readonly keepCheckCopies?: boolean;
  /**
   * The coordinator lock this run was started under. It is re-checked before
   * the worker is dispatched and before the result is written, so a state root
   * whose lock stopped excluding other coordinators fails the run instead of
   * producing a result two coordinators believe they own.
   */
  readonly ownership?: { assertOwnership(): void };
  /**
   * Override the run deadline in milliseconds. `runTimeoutMinutes` is the
   * configured value and the smallest one the schema allows is a minute, which
   * is too long to wait for in a test of the deadline itself.
   */
  readonly runDeadlineMs?: number;
  /**
   * Run a writing profile on a runtime that enforces no write boundary
   * (`--allow-unconfined-writes`).
   *
   * Off by default, and deliberately not a configuration field: plan section 8
   * says an adapter that cannot enforce a required profile must fail that mode,
   * so proceeding is a per-run decision a human makes, not a default a
   * configuration file can carry. When it is set the run proceeds, prints the
   * missing boundary, records it in the manifest and lists it as an unresolved
   * issue — it never becomes silent.
   */
  readonly allowUnconfinedWrites?: boolean;
  /**
   * Coordination bridge for this run. A multi-task run owns one bridge and
   * passes it to every task; a single-task run leaves this undefined and
   * `runDirect` starts and closes its own.
   */
  readonly coordination?: CoordinationBridge | null;
  /**
   * Start no coordination bridge at all. The worker then has no channel to ask
   * the coordinator anything, which is the honest state for a run whose state
   * root cannot host a socket.
   */
  readonly coordinationEnabled?: boolean;
  /**
   * Run this attempt as one task of an already-created run (the planned path).
   *
   * When set, the run row, the run-level request/contract files and the run
   * lifecycle transitions belong to the caller: this function creates only the
   * task and attempt, and reports the task's own outcome without deciding the
   * run's.
   */
  readonly slot?: RunTaskSlot;
}

/** One task's identity inside a run the caller already created. */
export interface RunTaskSlot {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  /** What this task is for; replaces the raw request text in the contract and prompt. */
  readonly objective: string;
  /** Context from completed dependencies, appended to the prompt. */
  readonly briefing?: string;
  /** Stable plan key of this task, for the prompt's coordination section. */
  readonly key?: string;
  /**
   * The other tasks of this run, so a worker can actually address one.
   * `send_message` needs a peer's TASK ID; without this the worker has no way
   * to learn one and the peer channel cannot be used at all.
   */
  readonly peers?: ReadonlyArray<{ readonly key: string; readonly taskId: string; readonly objective: string }>;
}

export type RunOutcome = 'accepted' | 'failed' | 'interrupted';

export interface RunTiming {
  readonly dispatchMs: number;
  readonly startupMs: number;
  readonly runtimeMs: number;
  readonly validationMs: number;
  readonly elapsedMs: number;
}

export interface RunManifest {
  readonly manifestVersion: typeof RUN_MANIFEST_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly createdAt: string;
  readonly request: { readonly text: string; readonly source: string; readonly contextRefs: ReadonlyArray<string> };
  readonly project: Record<string, unknown>;
  readonly base: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly agent: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
  readonly requirements: AcceptanceDecision['criteria'];
  readonly checks: ReadonlyArray<Record<string, unknown>>;
  readonly acceptance: Omit<AcceptanceDecision, 'criteria'>;
  readonly evidence: Record<string, unknown>;
  readonly timing: RunTiming;
  readonly usage: UsageReport;
  readonly unresolved: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<{ readonly type: string; readonly path: string; readonly sha256: string }>;
}

export interface RunDirectResult {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly taskState: string;
  readonly attemptState: string;
  readonly runState: string;
  readonly acceptance: AcceptanceDecision;
  readonly receipts: ReadonlyArray<CheckReceipt>;
  readonly snapshot: CandidateSnapshot | null;
  readonly workspace: CandidateWorkspace | null;
  readonly manifest: RunManifest;
  readonly manifestPath: string;
  readonly summaryPath: string;
  readonly patchPath: string | null;
  readonly runDir: string;
  readonly evidence: TurnEvidence | null;
  readonly stopReceipt: StopReceipt | null;
  /** Was this worker session attached to the coordination bridge, and what it exchanged. */
  readonly coordination: CoordinationAttachment;
  /** The task contract this attempt worked to, so a handoff can carry it verbatim. */
  readonly contract: TaskContract;
  /** How the failure classifies, when the attempt did not reach acceptance. Null when it did. */
  readonly failure: FailureClassification | null;
  /** The runtime and adapter that ran this attempt, for a fallback's exclusion list. */
  readonly runtime: { readonly runtimeId: string; readonly adapter: string };
}

export interface CoordinationAttachment {
  readonly attached: boolean;
  readonly socketPath: string | null;
  /** Why no bridge was attached; null when one was. */
  readonly reason: string | null;
  readonly messagesDelivered: number;
  readonly messagesRecorded: number;
}

export class RunSetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunSetupError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The direct path
// ---------------------------------------------------------------------------

export async function runDirect(input: RunDirectInput): Promise<RunDirectResult> {
  const stream = input.stream ?? SILENT_STREAM;
  const timer = new PhaseTimer();
  const { db, paths } = input;
  const contextRefs = [...(input.contextRefs ?? [])];

  // ---- 1. Project inspection and registration (FR019) --------------------
  const dispatchSpan = timer.begin('dispatch');
  const inspection = await inspectProject(input.repoPath);
  if (!inspection.isGitRepo || inspection.repositoryRoot === null) {
    dispatchSpan.end();
    throw new RunSetupError('not_a_git_repository', `${inspection.canonicalPath} is not a Git repository; the direct path works on an existing Git project`);
  }
  if (inspection.headRevision === null) {
    dispatchSpan.end();
    throw new RunSetupError('no_committed_base', `${inspection.repositoryRoot} has no commits; there is no committed base revision to start a candidate from`);
  }
  const projectRoot = inspection.repositoryRoot;
  const baseRevision = inspection.headRevision;
  for (const diagnostic of inspection.diagnostics) stream.line(`note: ${diagnostic}`);

  // ---- 2. Agent binding and adapter --------------------------------------
  const agentId = input.agentId ?? input.config.defaults.workerAgent;
  if (!input.config.agents.some((agent) => agent.id === agentId)) {
    dispatchSpan.end();
    throw new RunSetupError('unknown_agent', `agent "${agentId}" is not defined in ${input.configPath}; configured agents: ${input.config.agents.map((a) => `"${a.id}"`).join(', ')}`);
  }
  const snapshot = computeAgentSnapshot(input.config, agentId);
  const binding: EffectiveAgentBinding = snapshot.binding;
  const limits: Limits = limitsFromDefaults(input.config.defaults);
  const policy: Policy = binding.policy;

  // Identities are minted before the adapter so the adapter can be told where
  // its raw capture belongs. They are values only; no directory is created
  // until the run is past every refusal below.
  const slot = input.slot;
  const runId = slot?.runId ?? newId();
  const taskId = slot?.taskId ?? newId();
  const attemptId = slot?.attemptId ?? newId();
  // A planned task carries its own objective; the raw request stays the run's.
  const taskText = slot?.objective ?? input.requestText;
  const adapter = (input.adapterFactory ?? createAdapter)(
    { id: binding.runtime.id, adapter: binding.runtime.adapter, executable: binding.runtime.executable },
    { runId, taskId, attemptId, logsDir: path.join(paths.runArtifactsDir(runId), 'logs') },
  );
  const settings = validateBindingSettings(adapter, binding);
  if (!settings.ok) {
    dispatchSpan.end();
    const problems = [settings.model, settings.effort].filter((report) => report.status === 'unsupported').map((report) => report.message);
    throw new RunSetupError('unsupported_runtime_setting', `agent "${agentId}" requests settings the ${adapter.id} adapter does not support: ${problems.join('; ')}`);
  }

  // Unresolved issues are collected from here on: the first of them can be
  // raised before a workspace exists.
  const unresolved: string[] = [];

  // The write boundary, before anything is created (plan section 9: "fail setup
  // for an unsupported required boundary"). A profile that writes needs a
  // runtime that can bound writes; if the adapter reports it cannot, this run
  // is refused unless the operator explicitly accepted an unconfined run.
  const containment = assessContainment(adapter, policy, input.allowUnconfinedWrites === true);
  if (containment.unconfinedWrites && !containment.acknowledged) {
    dispatchSpan.end();
    throw new RunSetupError(
      'write_boundary_unsupported',
      `agent "${agentId}" runs the "${policy}" profile, which lets the worker change files, but ${describeUnconfinedWrites(adapter.id, containment)} ` +
        'Plan section 8 requires an adapter that cannot enforce a required profile to fail that mode rather than silently broaden it. Bind this agent to a runtime with a verified write boundary, give it the read-only "analysis" profile, ' +
        'or pass --allow-unconfined-writes to accept an unconfined run — which is recorded in the run manifest and cannot be mistaken for a contained one.',
    );
  }
  if (containment.unconfinedWrites) {
    stream.line(`WARNING: no enforced write boundary — ${describeUnconfinedWrites(adapter.id, containment)}`);
    stream.line('  continuing because --allow-unconfined-writes was given; this run\'s evidence records that its writes were not contained');
    unresolved.push(
      `this run had no enforced write boundary: ${describeUnconfinedWrites(adapter.id, containment)} It was allowed by an explicit --allow-unconfined-writes, so acceptance here means the configured criteria passed, not that the worker's effects were confined`,
    );
  }

  // ---- 3. Acceptance checks, pinned to the base revision (FR049) ---------
  const resolvedChecks = await resolveAcceptanceChecks(projectRoot, baseRevision, input.checkFlags ?? []);
  if (resolvedChecks.checks.length === 0) {
    dispatchSpan.end();
    throw new RunSetupError(
      'no_acceptance_checks',
      `${resolvedChecks.detail}. A task cannot be accepted without independently executed evidence, so the run is refused before any work starts.`,
    );
  }
  stream.line(`acceptance: ${resolvedChecks.detail}`);

  // What the criteria actually execute. The definitions are pinned to the
  // base, but their fixtures live in the repository, so the run has to know
  // which files a candidate must not rewrite.
  const baseFiles = await listFilesAtRevision(projectRoot, baseRevision);
  const surface = await computeAcceptanceSurface(resolvedChecks.checks, baseFiles, await baseSurfaceContext(projectRoot, baseRevision, baseFiles));
  const fixturePaths = listSurfacePaths(surface);
  if (fixturePaths.length > 0) {
    stream.line(`acceptance fixtures (the worker must not rewrite these; new test files are fine): ${fixturePaths.join(', ')}`);
  }
  // What the criteria execute beyond the files above: the code under test and
  // anything else the import graph reached without positive evidence that it
  // judges the candidate. Saying it out loud is the point — an unlisted file
  // must not read as an unexamined one.
  const executedDependencies = listSurfaceDependencyPaths(surface);
  if (executedDependencies.length > 0) {
    // Counted rather than listed: this set is the code under test and can be
    // the whole repository. The manifest carries every path under
    // `acceptanceExecutedDependencies`.
    stream.line(
      `acceptance also executes ${executedDependencies.length} file(s) the worker is free to change (the code under test); each change to one is recorded in the run manifest`,
    );
  }
  // A surface that could not be fully resolved is reported as such. The
  // difference between "this file is protected" and "we did not look" is
  // exactly what a false-completion hole lives in.
  for (const gap of surface.resolution.unresolved) {
    stream.line(`acceptance surface: ${gap}`);
    unresolved.push(`the acceptance surface could not be fully resolved from the base revision: ${gap}`);
  }
  if (surface.resolution.truncated) {
    unresolved.push(
      `the acceptance surface is PARTIAL: the walk from ${surface.resolution.entryPoints.length} entry point(s) read ${surface.resolution.filesVisited} file(s) and stopped at a cap, so files a criterion executes may be missing from the list above`,
    );
  }

  // ---- 4. Durable records ------------------------------------------------
  const createdAt = nowIso();
  ensureRunDir(paths, runId);
  const runDir = paths.runDir(runId);

  const request = validateRunRequest({
    requestVersion: RUN_REQUEST_VERSION,
    runId,
    text: input.requestText,
    contextRefs,
    repoPath: projectRoot,
    baseMode: 'head',
    submittedAt: createdAt,
  });
  const contract = buildContract(taskText, resolvedChecks.checks, fixturePaths);

  const project = registerProject(db, { inspection, dataLocation: paths.root, checks: resolvedChecks.checks, now: createdAt });
  // A planned task joins a run its caller already created; creating the run row
  // again would be a second run claiming the same id.
  if (slot === undefined) insertRun(db, { request, policy, limits, projectId: project.id, baseRevision, now: createdAt });
  // A repair is a new attempt of an existing task, so the task row may already
  // be there. Inserting it again would be a second task claiming the same id.
  if (slot === undefined || !taskExists(db, taskId)) {
    insertTask(db, { id: taskId, runId, contract, ownerAgentId: agentId, contextRefs, now: createdAt });
  }
  upsertAgentSnapshot(db, snapshot, createdAt);
  const workspacePath = paths.workspaceDir(runId, taskId, attemptId);
  insertAttempt(db, { id: attemptId, taskId, agentSnapshotHash: snapshot.hash, runtimeId: binding.runtime.id, workspacePath, now: createdAt });

  if (slot === undefined) {
    // Run-level documents. A planned task must not overwrite the run's request
    // and contract with its own slice of them.
    writeFileSync(paths.runRequestPath(runId), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(paths.runContractPath(runId), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      paths.runConfigSnapshotPath(runId),
      `${JSON.stringify({ configPath: input.configPath, agentId, snapshotHash: snapshot.hash, binding, raw: JSON.parse(input.configRaw) as unknown }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  appendEvent(db, {
    runId,
    taskId,
    type: slot === undefined ? 'run.created' : 'task.created',
    payload: {
      repoPath: projectRoot,
      baseRevision,
      branch: inspection.branch,
      dirty: describeDirty(inspection.dirty),
      uncommittedChangesExcluded: !inspection.dirty.clean,
      agentId,
      adapter: adapter.id,
      checkSource: resolvedChecks.source,
    },
    timestamp: createdAt,
  });
  if (slot === undefined) transitionRun(db, runId, 'running');
  // `failed -> ready` is the repair path: a task that failed its checks is made
  // ready again for a new attempt with a new candidate.
  transitionTask(db, taskId, 'ready');

  stream.line(`run ${runId}`);
  stream.line(`repo ${projectRoot} @ ${baseRevision.slice(0, 12)}${inspection.branch !== null ? ` (${inspection.branch})` : ' (detached HEAD)'}`);
  if (!inspection.dirty.clean) {
    stream.line(`note: uncommitted changes are excluded from the candidate (${describeDirty(inspection.dirty)}); the base is the committed HEAD`);
  }
  stream.line(`agent ${agentId} via ${binding.runtime.id} (${adapter.id})`);
  stream.line(
    containment.writes
      ? `write boundary: ${adapter.id} reports write_containment "${containment.status}"${containment.status === 'unsupported' ? ' — writes in this run are NOT contained by the runtime' : ''}`
      : `write boundary: not required by the read-only "${policy}" profile`,
  );
  stream.event({ type: 'run.created', runId, taskId, attemptId, repo: projectRoot, baseRevision, agentId, adapter: adapter.id });

  // ---- 5. Dispatch intent BEFORE any effect (FR065) ----------------------
  const operation = recordIntent(db, {
    runId,
    taskId,
    attemptId,
    kind: 'dispatch_worker',
    intent: {
      agentId,
      snapshotHash: snapshot.hash,
      adapter: adapter.id,
      runtimeId: binding.runtime.id,
      workspacePath,
      baseRevision,
      criteria: contract.acceptanceCriteria.map((criterion) => criterion.id),
    },
  });

  let workspace: CandidateWorkspace | null = null;
  let session: SessionHandle | null = null;
  let turn: TurnHandle | null = null;
  let stopReceipt: StopReceipt | null = null;
  let candidateSnapshot: CandidateSnapshot | null = null;
  let evidence: TurnEvidence | null = null;
  let interrupted = false;
  /**
   * How the turn ended, as the runtime reported it. `turn_failed` is a terminal
   * record that says the turn itself failed: Claude Code's `result` with
   * `is_error: true`, Codex's `turn/completed` with `status: "failed"`. It is
   * separate from `completed` because a turn the runtime says went wrong must
   * not be recorded as one that went right, and separate from `runtime_exited`
   * because the process was still there to say so.
   */
  let turnConclusion: 'completed' | 'turn_failed' | 'interrupted' | 'runtime_exited' | 'no_turn' = 'no_turn';
  const runtimeEvents: RuntimeEvent[] = [];
  let receipts: CheckReceipt[] = [];

  // ---- 5b. Coordination bridge (FR031, FR034) ----------------------------
  // The worker's only channel back to the coordinator. A run that cannot start
  // one is not failed for it: the worker simply has no channel, which the
  // result reports rather than hides.
  let bridge: CoordinationBridge | null = input.coordination ?? null;
  let ownsBridge = false;
  let bridgeConfig: AttemptBridgeConfig | null = null;
  let bridgeReason: string | null = null;
  let messagesDelivered = 0;
  if (input.coordinationEnabled === false) {
    bridgeReason = 'coordination was disabled for this run';
  } else if (bridge === null) {
    try {
      bridge = await createCoordinationBridge({ stateRoot: paths.root, runId, db });
      ownsBridge = true;
    } catch (error) {
      bridgeReason = `the coordination bridge could not start: ${(error as Error).message}`;
      stream.line(`note: ${bridgeReason}; the worker runs without a coordination channel`);
    }
  }

  // Stopping the worker (plan section 9): request runtime interruption, wait a
  // bounded time for the runtime to acknowledge, then terminate the process
  // group we own. Without the second step a runtime that stops reading its
  // input keeps the event loop below open forever and Ctrl+C never lands.
  const deadlineMs = input.runDeadlineMs ?? limits.runTimeoutMinutes * 60_000;
  let interruptReason: 'signal' | 'run_deadline' | null = null;
  let escalating = false;
  let escalation: Promise<void> | null = null;
  let interruptStopReceipt: StopReceipt | null = null;

  const escalateInterruption = async (): Promise<void> => {
    if (escalating) return;
    escalating = true;
    let acknowledgement: 'observed' | 'requested' | 'failed' | 'no_turn' = 'no_turn';
    let detail: string | null = null;
    if (turn !== null) {
      try {
        const receipt = await withDeadline(adapter.interrupt(turn), INTERRUPT_ACKNOWLEDGEMENT_MS);
        acknowledgement = receipt === null ? 'requested' : receipt.state === 'observed' ? 'observed' : 'requested';
        if (receipt === null) detail = `the runtime did not answer turn interruption within ${INTERRUPT_ACKNOWLEDGEMENT_MS}ms`;
      } catch (error) {
        acknowledgement = 'failed';
        detail = (error as Error).message;
      }
    }
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'run.interrupt_acknowledged',
      payload: { reason: interruptReason, acknowledgement, detail, at: nowIso() },
    });
    if (acknowledgement === 'observed') {
      stream.line('  the runtime acknowledged the interruption and ended the turn');
      return;
    }
    // No observed end of turn inside the budget: terminate what we own, which
    // also ends the event stream this run is waiting on.
    if (session !== null) {
      stream.line(`  the runtime did not end the turn within ${INTERRUPT_ACKNOWLEDGEMENT_MS}ms; terminating the owned process group`);
      try {
        interruptStopReceipt = await adapter.stopOwnedProcesses(session);
        appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stopped', payload: { ...interruptStopReceipt, cause: 'interruption_escalation' } });
        stream.line(`  worker stopped: ${interruptStopReceipt.state}${interruptStopReceipt.detail !== undefined ? ` (${interruptStopReceipt.detail})` : ''}`);
      } catch (error) {
        appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stop_failed', payload: { message: (error as Error).message } });
        stream.line(`  could not stop the owned process group: ${(error as Error).message}`);
      }
    }
  };

  const beginInterruption = (reason: 'signal' | 'run_deadline'): void => {
    if (interrupted) return;
    interrupted = true;
    interruptReason = reason;
    // Persist the interruption intent before anything is signalled.
    appendEvent(db, { runId, taskId, attemptId, type: 'run.interrupt_requested', payload: { reason, at: nowIso() } });
    stream.line(
      reason === 'signal'
        ? 'interrupt requested: stopping the worker and preserving what exists'
        : `run deadline of ${deadlineMs}ms reached: stopping the worker and preserving what exists`,
    );
    escalation = escalateInterruption();
    escalation.catch(() => undefined);
  };

  const onAbort = (): void => beginInterruption('signal');
  if (input.signal !== undefined) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }

  // FR014: `runTimeoutMinutes` is a real deadline, not a number in a manifest.
  // A runtime that never ends its turn is stopped here rather than hanging the
  // coordinator until someone notices.
  const deadlineTimer = setTimeout(() => beginInterruption('run_deadline'), deadlineMs);
  deadlineTimer.unref?.();

  try {
    // ---- 6. Candidate workspace (FR041) ----------------------------------
    workspace = await createCandidateWorkspace({
      projectRoot,
      baseRevision,
      runId,
      taskId,
      attemptId,
      workspaceRoot: paths.workspaceRoot,
      excludedDirty: inspection.dirty.clean ? null : inspection.dirty,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    const grants = candidateWritePaths(workspace);
    // Protect the coordinator's own files. The default workspace root lives
    // under the state root, so the root itself cannot be the boundary.
    assertGrantedPathsSafe(workspace, grants, [paths.databasePath, paths.lockPath, paths.manifestPath, paths.runsDir]);
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'workspace.created',
      payload: { path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision, excludedUncommittedChanges: workspace.excludedUncommittedChanges !== null },
    });
    stream.line(`candidate workspace ${workspace.path} on branch ${workspace.branch}`);
    stream.event({ type: 'workspace.created', path: workspace.path, branch: workspace.branch, baseRevision: workspace.baseRevision });

    // Still the one mutating coordinator for this state root? Ask before a
    // worker exists, not after.
    input.ownership?.assertOwnership();
    markDispatched(db, operation.id, { workspacePath: workspace.path, branch: workspace.branch });
    transitionTask(db, taskId, 'running');
    dispatchSpan.end();

    if (interrupted) throw new InterruptedError();

    // ---- 7. Session and turn ---------------------------------------------
    const startupSpan = timer.begin('startup');
    const sessionEnv: Record<string, string> = { ...(input.sessionEnv ?? {}) };
    const scenario = process.env[FAKE_SCENARIO_ENV];
    if (adapter.id === 'fake' && scenario !== undefined && sessionEnv[FAKE_SCENARIO_ENV] === undefined) sessionEnv[FAKE_SCENARIO_ENV] = scenario;

    // Attach this attempt to the bridge. The token is minted per attempt and
    // names the attempt, so a worker can only speak as the task it is running.
    let bridgeArgs: ReadonlyArray<string> = [];
    if (bridge !== null) {
      try {
        bridgeConfig = bridge.mcpConfigFor(attemptId);
        bridgeArgs = coordinationArgsFor(adapter.id, bridgeConfig);
        if (bridgeArgs.length === 0 && adapter.id !== 'fake') {
          bridgeReason = `the ${adapter.id} adapter has no known way to take an MCP server on its command line`;
        }
        appendEvent(db, {
          runId,
          taskId,
          attemptId,
          type: 'coordination.attached',
          payload: { socketPath: bridgeConfig.socketPath, serverName: bridgeConfig.serverName, adapter: adapter.id, argumentCount: bridgeArgs.length },
        });
        stream.line(`coordination: worker tools on ${bridgeConfig.socketPath}`);
      } catch (error) {
        bridgeReason = `this attempt could not be attached to the coordination bridge: ${(error as Error).message}`;
        stream.line(`note: ${bridgeReason}`);
      }
    }

    session = await adapter.openSession({
      cwd: workspace.path,
      allowedWritePaths: grants,
      policy,
      systemInstructions: binding.instructions,
      ...(binding.runtime.model !== undefined ? { model: binding.runtime.model } : {}),
      ...(binding.runtime.effort !== undefined ? { effort: binding.runtime.effort } : {}),
      ...(Object.keys(sessionEnv).length > 0 ? { env: sessionEnv } : {}),
      ...(bridgeArgs.length > 0 ? { extraArgs: bridgeArgs } : {}),
    });
    startupSpan.end();

    const workerProcess: ProcessIdentity | null = session.process ?? null;
    appendEvent(db, { runId, taskId, attemptId, type: 'session.opened', payload: { adapter: adapter.id, sessionId: session.sessionId, processId: session.processId ?? null } });
    stream.event({ type: 'session.opened', adapter: adapter.id, sessionId: session.sessionId, processId: session.processId ?? null });

    // A safe boundary before the turn: anything a dependency left for this task
    // is in the prompt, not racing the turn that is about to start.
    const inbox = bridge === null ? [] : deliverableMessages(bridge, taskId);
    const prompt = composeTaskPrompt({
      requestText: taskText,
      contextRefs,
      workspace,
      inspection,
      contract,
      ...(slot?.briefing !== undefined ? { briefing: slot.briefing } : {}),
      ...(inbox.length > 0 ? { inbox: inbox.map((message) => message.text) } : {}),
      ...(slot === undefined
        ? {}
        : {
            coordination: {
              taskId,
              ...(slot.key !== undefined ? { key: slot.key } : {}),
              peers: slot.peers ?? [],
              toolsAvailable: bridge !== null,
            },
          }),
    });
    for (const message of inbox) {
      try {
        bridge?.acknowledge(message.id);
        messagesDelivered += 1;
      } catch {
        // An un-acknowledgeable message stays deliverable; it is not a run failure.
      }
    }
    const runtimeSpan = timer.begin('runtime');
    turn = await adapter.startTurn(session, { prompt, contextRefs });
    // One transition records session, process identity and turn together:
    // an attempt is "running" once it actually has a turn.
    transitionAttempt(db, attemptId, 'running', {
      runtime: {
        sessionId: session.sessionId,
        turnId: turn.turnId,
        ...(workerProcess !== null ? { process: workerProcess } : {}),
      },
    });
    appendEvent(db, { runId, taskId, attemptId, type: 'turn.started', payload: { sessionId: session.sessionId, turnId: turn.turnId, promptCharacters: prompt.length } });
    if (interrupted) void adapter.interrupt(turn).catch(() => undefined);

    // Human lines are a readable trace of what the worker did; the complete
    // stream still reaches --json, events.jsonl and the adapter's raw capture.
    const workspaceRootForDisplay = workspace.path;
    const shorten = (value: string): string => (isWithin(workspaceRootForDisplay, value) ? path.relative(workspaceRootForDisplay, value) || '.' : value);
    // Deliver a peer's message while the recipient's turn is still live. Doing
    // this only before the prompt or after the stream ended means the adapter's
    // verified active-turn path is never used and a clarification arrives too
    // late to change the work it was asked about.
    const drainInbox = async (): Promise<void> => {
      if (bridge === null || session === null) return;
      for (const message of deliverableMessages(bridge, taskId)) {
        try {
          const receipt = await adapter.deliver(session, { messageId: message.id, body: message.text });
          bridge.acknowledge(message.id);
          messagesDelivered += 1;
          appendEvent(db, { runId, taskId, attemptId, type: 'coordination.delivered', payload: { messageId: message.id, state: receipt.state } });
          stream.line(`  coordination: delivered a message to this worker (${receipt.state})`);
        } catch (error) {
          appendEvent(db, { runId, taskId, attemptId, type: 'coordination.delivery_failed', payload: { messageId: message.id, message: (error as Error).message } });
        }
      }
    };

    for await (const event of adapter.events(turn)) {
      runtimeEvents.push(event);
      recordRuntimeEvent(db, event, { runId, taskId, attemptId, paths });
      stream.event({ type: `runtime.${event.kind}`, sequence: event.sequence, turnId: event.turnId, rawRef: event.rawRef, payload: event.payload });
      const line = renderRuntimeEvent(event, shorten);
      if (line !== null) stream.line(line);
      if (event.kind === 'turn_completed') turnConclusion = 'completed';
      else if (event.kind === 'turn_interrupted') turnConclusion = 'interrupted';
      else if (event.kind === 'error' && event.payload['fatal'] === true) turnConclusion = 'runtime_exited';
      // A tool result or an assistant message is a safe boundary inside a turn:
      // the worker is between actions rather than mid-write.
      if (event.kind === 'tool_result' || event.kind === 'assistant_message') await drainInbox();
    }
    runtimeSpan.end();

    // A safe boundary after the turn: deliver anything that arrived while it
    // ran. The adapter either submits it to a live turn or queues it and says
    // who is holding it; either way the coordinator stops guessing.
    await drainInbox();
    // FR006: the runtime's own word on what ran. Printed only when it differs
    // from what was configured — the case a person needs to see, because the
    // run path passes an unlisted model through unvalidated.
    {
      const reportedSettings = effectiveSettingsFor(adapter, session);
      if (reportedSettings.effectiveModel !== null && binding.runtime.model !== undefined && reportedSettings.effectiveModel !== binding.runtime.model) {
        stream.line(`  note: requested model "${binding.runtime.model}" but the runtime reports "${reportedSettings.effectiveModel}" ran`);
      }
    }
    evidence = summarizeTurnEvidence(runtimeEvents);
    // A terminal record that reports its own failure is not a completed turn.
    // The evidence summary reads that in the shared vocabulary (Claude Code's
    // `isError`, Codex's `status: "failed"` plus `error`), so the conclusion
    // does not have to be re-derived per runtime here.
    if (turnConclusion === 'completed' && evidence.turnFailure !== null) turnConclusion = 'turn_failed';
    if (evidence.rawEvents > 0) {
      // Say how much was not shown rather than printing every unnormalized
      // notification: they are well-formed runtime output, not errors.
      stream.line(`  (${evidence.rawEvents} further runtime event(s) kept verbatim as evidence, not shown here)`);
    }

    if (turnConclusion === 'runtime_exited') {
      unresolved.push(`the runtime process ended before the turn completed (${describeExit(runtimeEvents)}); the candidate contains only what it had written by then`);
    }
    if (evidence.turnFailure !== null) {
      unresolved.push(`the runtime ended the turn reporting that it failed (${evidence.turnFailure}); the candidate contains only what the worker had written by then`);
    }
    for (const mismatch of evidence.sessionIdentityMismatches) {
      unresolved.push(`a runtime record named a session this coordinator did not open (${mismatch}); records from another conversation are kept as evidence but are not this turn's work`);
    }
    for (const escaped of evidence.fileChangesOutsideAllowedPaths) {
      unresolved.push(
        evidence.unconfirmedFileChangesOutsideAllowedPaths.includes(escaped)
          ? `the worker asked to write outside its granted paths: ${escaped}; the runtime never reported the outcome, so whether it happened is unknown and it is not part of the candidate`
          : `the worker wrote outside its granted paths: ${escaped}; that change is not part of the candidate`,
      );
    }

    // ---- 8. Stop owned processes, then freeze the candidate --------------
    // An interruption may already have terminated the group; wait for that to
    // finish rather than signalling the same tree from two places.
    if (escalation !== null) await escalation;
    if (interruptStopReceipt !== null) {
      stopReceipt = interruptStopReceipt;
    } else {
      stopReceipt = await adapter.stopOwnedProcesses(session);
      appendEvent(db, { runId, taskId, attemptId, type: 'runtime.stopped', payload: { ...stopReceipt } });
      stream.line(`worker stopped: ${stopReceipt.state}${stopReceipt.detail !== undefined ? ` (${stopReceipt.detail})` : ''}`);
    }
    if (stopReceipt.state !== 'process_tree_terminated') {
      unresolved.push(`the worker's process tree was not observed terminated (${stopReceipt.state}${stopReceipt.detail !== undefined ? `: ${stopReceipt.detail}` : ''})`);
    }

    const validationSpan = timer.begin('validation');
    candidateSnapshot = await snapshotCandidate(workspace, {
      writer: workerProcess,
      patchPath: path.join(runDir, 'snapshots', `${attemptId}.patch`),
      ...(input.signal !== undefined && !interrupted ? { signal: input.signal } : {}),
    });
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'candidate.snapshot',
      payload: {
        baseRevision: candidateSnapshot.baseRevision,
        candidateRevision: candidateSnapshot.candidateRevision,
        patchHash: candidateSnapshot.patchHash,
        changedFileCount: candidateSnapshot.changedFiles.length,
        checkpointCreated: candidateSnapshot.checkpointCreated,
      },
    });
    stream.line(
      candidateSnapshot.checkpointCreated
        ? `candidate ${candidateSnapshot.candidateRevision.slice(0, 12)} on ${candidateSnapshot.branch}: ${candidateSnapshot.changedFiles.length} changed file(s), patch ${candidateSnapshot.patchHash.slice(0, 12)}`
        : `candidate is identical to the base ${candidateSnapshot.baseRevision.slice(0, 12)}: the worker changed nothing`,
    );
    for (const change of candidateSnapshot.changes) stream.line(`  ${change.status} ${change.path}`);
    if (!candidateSnapshot.checkpointCreated) unresolved.push('the worker produced no change to the repository');

    if (interrupted) {
      validationSpan.end();
      throw new InterruptedError();
    }

    // ---- 9. Verifier-executed checks (FR049, FR050) ----------------------
    stream.line(`running ${contract.acceptanceCriteria.length} acceptance check(s) against the frozen candidate`);
    receipts = await runChecks({
      candidate: { repoRoot: projectRoot, revision: candidateSnapshot.candidateRevision, patchHash: candidateSnapshot.patchHash },
      checks: resolvedChecks.checks,
      outputRoot: slot === undefined ? path.join(runDir, 'verification') : path.join(runDir, 'verification', attemptId),
      // The coordinator knows its own state root, so it says so. Leaving the
      // check runner to infer one from directory shape turned the guard off
      // whenever --workspace-root pointed outside the state root, and said
      // nothing when it did (FR049, FR050).
      stateRoot: paths.root,
      ...(input.keepCheckCopies !== undefined ? { keepCopies: input.keepCheckCopies } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      onReceipt: (receipt) => {
        stream.line(`  check ${receipt.criterionId}: ${receipt.outcome}${receipt.exitCode !== null ? ` (exit ${receipt.exitCode})` : ''} in ${receipt.durationMs}ms`);
        stream.event({ type: 'check.completed', criterionId: receipt.criterionId, outcome: receipt.outcome, exitCode: receipt.exitCode, durationMs: receipt.durationMs, evidenceProvenance: receipt.evidenceProvenance });
      },
    });
    validationSpan.end();
  } catch (error) {
    if (!(error instanceof InterruptedError)) {
      // Preserve the failure honestly: the attempt failed, the run failed, the workspace is kept.
      if (slot === undefined) transitionRunSafely(db, runId, 'failed');
      transitionTaskSafely(db, taskId, 'failed');
      transitionAttemptSafely(db, attemptId, 'failed', { outcome: { error: (error as Error).message } });
      recordReceiptSafely(db, operation.id, 'failed', { error: (error as Error).message });
      appendEvent(db, { runId, taskId, attemptId, type: 'run.failed', payload: { message: (error as Error).message } });
      projectEventsJsonl(db, paths, runId);
      throw error;
    }
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener('abort', onAbort);
    // Revoke this attempt's token whoever owns the bridge; close only a bridge
    // this call started, because a planned run's bridge outlives one task.
    try {
      bridgeConfig?.revoke();
    } catch {
      // Already revoked or already closed; nothing to keep open.
    }
    if (ownsBridge && bridge !== null) {
      try {
        await bridge.close();
      } catch {
        // The socket is gone either way; a close failure is not a run outcome.
      }
    }
  }

  // ---- 10. Persist evidence and decide acceptance ------------------------
  // Losing exclusive ownership here is not a check failure; it means this
  // process can no longer say what the state root contains. Record why the run
  // stops and leave the rest alone rather than writing a result over work
  // another coordinator may be doing.
  try {
    input.ownership?.assertOwnership();
  } catch (error) {
    appendEvent(db, { runId, taskId, attemptId, type: 'run.ownership_lost', payload: { message: (error as Error).message } });
    transitionAttemptSafely(db, attemptId, 'failed', { outcome: { turnConclusion, ownershipLost: true }, uncertain: true });
    transitionTaskSafely(db, taskId, 'failed');
    if (slot === undefined) transitionRunSafely(db, runId, 'failed');
    recordReceiptSafely(db, operation.id, 'failed', { ownershipLost: true, candidateRevision: candidateSnapshot?.candidateRevision ?? null });
    projectEventsJsonl(db, paths, runId);
    throw error;
  }
  // A run with more than one task (or one task with repairs) writes several
  // sets of check artifacts, and artifacts are immutable per run: scope them by
  // attempt so the second set does not collide with the first. The direct path
  // keeps the flat `checks/` layout it has always had.
  // Artifacts are immutable and keyed by run. The direct path is the only task
  // in its run, so it keeps the flat layout it has always had; a planned task
  // scopes its own artifacts under its attempt so tasks never collide.
  const artifactPrefix = slot === undefined ? '' : `tasks/${attemptId}/`;
  const persistedChecks =
    receipts.length > 0
      ? persistCheckReceipts(db, paths, { runId, taskId, attemptId, receipts, ...(slot === undefined ? {} : { pathPrefix: `checks/${attemptId}` }) })
      : [];

  // Did the candidate rewrite the code its own criteria execute? The check
  // definitions are pinned to the base revision, but their fixtures are in the
  // repository, so this is the difference between "the tests pass" and "the
  // worker replaced the tests".
  const surfaceFindings =
    candidateSnapshot === null ? { mutations: [], dependencyChanges: [], additions: [], definitionChanges: [] } : computeSurfaceChanges(surface, candidateSnapshot.changes);
  for (const mutation of surfaceFindings.mutations) {
    unresolved.push(
      `the candidate changed files that criterion "${mutation.criterionId}" executes (${mutation.changedPaths.join(', ')}); the check result cannot establish the criterion the base revision defined`,
    );
  }
  if (surfaceFindings.additions.length > 0) {
    unresolved.push(`the candidate added ${surfaceFindings.additions.length} file(s) under the acceptance fixtures (${surfaceFindings.additions.join(', ')}); added tests do not block acceptance, but they were not part of the original criteria`);
  }
  for (const change of surfaceFindings.definitionChanges) {
    unresolved.push(`the candidate changed an acceptance definition (${change}); this run read the definition from the base revision, so the change did not affect it, but a later run would use the new one`);
  }
  // Changes to code a criterion executes without the surface protecting it —
  // normally the fix itself. Recorded, never held against the candidate: a
  // criterion whose suite imports the module under test would otherwise make
  // fixing that module impossible. Named in the terminal and the manifest so a
  // reader can see which executed files moved under the passing check.
  for (const change of surfaceFindings.dependencyChanges) {
    const named = change.changedPaths.slice(0, 10).join(', ');
    const rest = change.changedPaths.length > 10 ? ` and ${change.changedPaths.length - 10} more` : '';
    stream.line(`note: the candidate changed code that criterion "${change.criterionId}" also executes (${named}${rest}) — expected for a fix, and recorded as evidence`);
  }
  // `.gitattributes` is not repository source: it changes how the candidate is
  // *materialized*. `export-ignore` in one removes files from a `git archive`
  // of the candidate, which is how the verifier makes its disposable copy, so
  // adding one is worth naming even though the check runner now completes the
  // copy from the object database rather than trusting the archive.
  const attributeChanges = (candidateSnapshot?.changes ?? []).filter((change) => path.basename(change.path) === '.gitattributes');
  for (const change of attributeChanges) {
    unresolved.push(
      `the candidate changed ${change.path} (${change.status}); Git attributes decide what a \`git archive\` of the candidate contains, so this file affects how the verifier materializes the candidate rather than what it computes. The check runner compared its copy against the candidate's own tree listing and completed it, and the check receipts record the strategy actually used`,
    );
  }

  // A guard that compared nothing is not a guard that found nothing. The
  // coordinator names its own state root, so a receipt whose guard was never
  // measured is an unresolved fact rather than a quiet pass (FR049, FR050).
  for (const receipt of receipts) {
    const guard = receipt.stateRootGuard;
    if (guard === undefined || guard.checked) continue;
    unresolved.push(
      `the coordinator state root was not compared across check "${receipt.criterionId}" (${guard.note}), so this receipt establishes nothing about whether that check reached coordinator state`,
    );
  }

  // What THIS RUN observed about its write boundary. The capability table says
  // what is expected of the runtime; this says what happened, and it is what
  // the run records (plan section 8; AT12).
  const boundary = observeWriteBoundary({ containment, evidence, events: runtimeEvents });
  if (containment.writes && boundary.held !== true) {
    if (boundary.held === false && boundary.expected === true) {
      // The case the capability table would have hidden: a runtime that is
      // supposed to bound writes, and a run whose evidence says it did not.
      stream.line(`WARNING: ${describeBoundaryBreach(adapter.id, boundary)}`);
      unresolved.push(`this run does not record that its write boundary held: ${boundary.findings.join('; ')}`);
    } else if (boundary.held === null) {
      stream.line(`WARNING: whether this run's write boundary held was never established — ${boundary.findings.join('; ')}`);
      unresolved.push(`whether this run's write boundary held was never established: ${boundary.findings.join('; ')}`);
    }
    for (const change of boundary.unplaceable) {
      unresolved.push(`the runtime reported a change this run cannot place inside its granted paths (${change.descriptor}): ${change.reason}`);
    }
  }
  if (containment.writes && boundary.held === true) {
    stream.line('write boundary: held in this run — no reported write landed outside the granted paths, and every reported change could be placed inside them');
  }

  // Facts that block acceptance whatever the receipts say. Each one means the
  // run cannot honestly claim "verified candidate" (plan section 9, AT02, AT12).
  const blockers: string[] = [];
  // A surface the walk could not finish is one of them. The run already knew
  // this — it printed the gap above — and used to accept anyway, which made
  // "we did not look" indistinguishable from "we looked and it was clean". A
  // criterion whose executed files were only partly found is not established
  // by its check, exactly as a criterion whose fixtures were rewritten is not.
  for (const blocker of listSurfaceBlockers(surface)) blockers.push(blocker);
  const unconfirmedEscapes = new Set(evidence?.unconfirmedFileChangesOutsideAllowedPaths ?? []);
  for (const escaped of evidence?.fileChangesOutsideAllowedPaths ?? []) {
    blockers.push(
      unconfirmedEscapes.has(escaped)
        ? `the worker asked to write outside its granted paths (${escaped}) and the runtime never reported whether the write happened; an escape that cannot be ruled out is not an accepted run`
        : `the worker wrote outside its granted paths (${escaped}); an observed escape is not an accepted run`,
    );
  }
  for (const denied of evidence?.deniedFileChangesOutsideAllowedPaths ?? []) {
    // The boundary working, not an escape: recorded, and not a blocker.
    unresolved.push(`the worker asked to write outside its granted paths (${denied}) and the runtime reported the write refused; nothing was written there`);
  }
  if (turnConclusion === 'runtime_exited') {
    blockers.push(`the runtime process ended before the turn completed (${describeExit(runtimeEvents)}); a candidate produced by a crashed turn is not accepted`);
  }
  if (evidence?.turnFailure != null) {
    blockers.push(`the runtime's own terminal record says the turn failed (${evidence.turnFailure}); a candidate produced by a failed turn is not accepted, whatever the checks report`);
  }
  for (const mismatch of evidence?.sessionIdentityMismatches ?? []) {
    blockers.push(
      `a runtime record carried a session id this coordinator did not mint (${mismatch}); evidence from a session this run does not own cannot be this turn's evidence (FR003, FR004)`,
    );
  }
  if (candidateSnapshot !== null && !candidateSnapshot.checkpointCreated) {
    blockers.push('the worker produced no change, so there is no candidate to accept; passing checks on an unchanged base are not evidence that the task was done');
  }

  const acceptance = decideAcceptance(
    contract.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description })),
    receipts,
    { fixtureMutations: surfaceFindings.mutations, blockers },
  );

  const artifacts: ArtifactRecord[] = [];
  let patchArtifact: ArtifactRecord | null = null;
  if (candidateSnapshot !== null) {
    patchArtifact = writeArtifact(db, paths, {
      runId,
      taskId,
      attemptId,
      type: 'candidate_patch',
      relativePath: `${artifactPrefix}candidate.patch`,
      bytes: readFileSync(candidateSnapshot.patchPath),
      baseRevision: candidateSnapshot.baseRevision,
      candidateRevision: candidateSnapshot.candidateRevision,
      provenance: { producer: 'snapshotCandidate', branch: candidateSnapshot.branch, patchHash: candidateSnapshot.patchHash, checkpointCreated: candidateSnapshot.checkpointCreated },
    });
    artifacts.push(patchArtifact);
    if (patchArtifact.sha256 !== candidateSnapshot.patchHash) {
      unresolved.push('the stored candidate patch does not hash to the recorded candidate identity');
    }
  }
  if (runtimeEvents.length > 0) {
    artifacts.push(
      writeArtifact(db, paths, {
        runId,
        taskId,
        attemptId,
        type: 'runtime_event_log',
        relativePath: `${artifactPrefix}logs/runtime-events.jsonl`,
        bytes: `${runtimeEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        provenance: { producer: 'runDirect', adapter: adapter.id, sessionId: session?.sessionId ?? null, note: 'normalized adapter events for this attempt' },
      }),
    );
  }
  artifacts.push(...persistedChecks.flatMap((check) => [check.logArtifact, check.stderrArtifact, check.receiptArtifact]));

  // ---- 11. Lifecycle -----------------------------------------------------
  const timing = summarizeTiming(timer);
  let outcome: RunOutcome;
  if (interrupted) {
    outcome = 'interrupted';
    unresolved.push(
      interruptReason === 'run_deadline'
        ? `the run reached its ${deadlineMs}ms deadline before acceptance and the worker was stopped; resume creates a new attempt generation for this task`
        : 'the run was interrupted before acceptance; resume creates a new attempt generation for this task',
    );
    transitionAttemptSafely(db, attemptId, 'interrupted', { outcome: { turnConclusion, interrupted: true }, uncertain: turnConclusion === 'no_turn' });
    transitionTaskSafely(db, taskId, 'cancelled');
    if (slot === undefined) transitionRunSafely(db, runId, 'interrupted');
    recordReceiptSafely(db, operation.id, 'completed', { interrupted: true, turnConclusion, candidateRevision: candidateSnapshot?.candidateRevision ?? null });
  } else {
    transitionAttemptSafely(db, attemptId, turnConclusion === 'runtime_exited' || turnConclusion === 'turn_failed' ? 'failed' : 'completed', {
      outcome: { turnConclusion, claimedDone: evidence?.claimedDone ?? false, changedFiles: candidateSnapshot?.changedFiles.length ?? 0 },
    });
    recordReceiptSafely(db, operation.id, turnConclusion === 'runtime_exited' || turnConclusion === 'turn_failed' ? 'failed' : 'completed', {
      turnConclusion,
      candidateRevision: candidateSnapshot?.candidateRevision ?? null,
      patchHash: candidateSnapshot?.patchHash ?? null,
    });
    transitionTask(db, taskId, 'validating');
    if (acceptance.accepted) {
      outcome = 'accepted';
      transitionTask(db, taskId, 'accepted');
      // A planned run is not ready for review because one of its tasks is: the
      // caller decides that after the combined candidate is checked.
      if (slot === undefined) transitionRun(db, runId, 'ready_for_review');
    } else {
      outcome = 'failed';
      transitionTask(db, taskId, 'failed');
      if (slot === undefined) transitionRun(db, runId, 'failed');
    }
  }

  appendEvent(db, {
    runId,
    taskId,
    attemptId,
    type: `run.${outcome}`,
    payload: {
      outcome,
      accepted: acceptance.accepted,
      requiredPassed: acceptance.requiredPassed,
      requiredTotal: acceptance.requiredTotal,
      candidateRevision: candidateSnapshot?.candidateRevision ?? null,
      reasons: acceptance.reasons.slice(0, 10),
    },
  });

  // ---- 12. Manifest and human summary (FR059, FR060) ---------------------
  const sessionUnenforceable = readUnenforceable(runtimeEvents);
  const manifest: RunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    runId,
    taskId,
    attemptId,
    outcome,
    createdAt,
    request: { text: input.requestText, source: input.requestSource, contextRefs },
    project: {
      canonicalPath: projectRoot,
      requestedPath: inspection.canonicalPath,
      repositoryIdentity: inspection.repositoryIdentity,
      branch: inspection.branch,
      detachedHead: inspection.detachedHead,
      hasSubmodules: inspection.hasSubmodules,
      projectId: project.id,
    },
    base: {
      mode: 'head',
      revision: baseRevision,
      uncommittedChangesExcluded: inspection.dirty.clean ? null : inspection.dirty,
      note: inspection.dirty.clean
        ? 'the checkout was clean; the committed HEAD is the complete base'
        : 'uncommitted changes in the user\'s checkout were excluded from this candidate and left untouched',
    },
    candidate:
      candidateSnapshot === null
        ? { created: false, note: 'no candidate was frozen' }
        : {
            created: true,
            branch: candidateSnapshot.branch,
            revision: candidateSnapshot.candidateRevision,
            patchHash: candidateSnapshot.patchHash,
            patchBytes: candidateSnapshot.patchBytes,
            checkpointCreated: candidateSnapshot.checkpointCreated,
            changedFiles: candidateSnapshot.changes,
            workspacePath: workspace?.path ?? null,
            patchArtifactId: patchArtifact?.id ?? null,
          },
    agent: { id: agentId, snapshotHash: snapshot.hash, policy, instructionsCharacters: binding.instructions.length, limits },
    runtime: {
      adapter: adapter.id,
      runtimeId: binding.runtime.id,
      executable: binding.runtime.executable,
      model: settings.model.requested,
      modelStatus: settings.model.status,
      effort: settings.effort.requested,
      effortStatus: settings.effort.status,
      // What the runtime itself said took effect, beside what was requested.
      // They differ whenever a value was passed through unvalidated
      // (`supported_unverified`) or the provider substituted one.
      ...effectiveSettingsFor(adapter, session),
      sessionId: session?.sessionId ?? null,
      turnId: turn?.turnId ?? null,
      turnConclusion,
      stopReceipt,
      interruptReason,
    },
    requirements: acceptance.criteria,
    checks: receipts.map((receipt) => ({
      criterionId: receipt.criterionId,
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      durationMs: receipt.durationMs,
      command: receipt.command,
      args: receipt.args,
      cwd: receipt.cwd,
      timeoutMs: receipt.timeoutMs,
      environmentIdentity: receipt.environmentIdentity,
      integrity: receipt.integrity,
      outputSummary: receipt.outputSummary,
      copyStrategy: receipt.copyStrategy,
      evidenceProvenance: receipt.evidenceProvenance,
      logArtifactId: persistedChecks.find((check) => check.checkId === receipt.id)?.logArtifact.id ?? null,
      diagnostics: receipt.diagnostics,
    })),
    acceptance: { accepted: acceptance.accepted, requiredTotal: acceptance.requiredTotal, requiredPassed: acceptance.requiredPassed, reasons: acceptance.reasons },
    evidence: {
      checkSource: resolvedChecks.source,
      checkSourceDetail: resolvedChecks.detail,
      runtimeClaimedDone: evidence?.claimedDone ?? false,
      // What the runtime said about its own turn, kept apart from what the
      // verifier established: a terminal record that reports failure is not a
      // completed turn, and a record naming a session this run did not open is
      // not this run's evidence.
      runtimeReportedTurnFailure: evidence?.turnFailure ?? null,
      sessionIdentityMismatches: evidence?.sessionIdentityMismatches ?? [],
      runtimeReportedFileChanges: evidence?.fileChanges ?? [],
      // Writes the runtime refused: recorded because a worker asked, and kept
      // out of the list above because nothing was written there.
      runtimeDeniedFileChanges: evidence?.deniedFileChanges ?? [],
      writesOutsideGrantedPaths: evidence?.fileChangesOutsideAllowedPaths ?? [],
      // What that list is derived from, so an empty one cannot be read as a
      // checked negative. Every entry comes from a tool event the runtime
      // chose to report; nothing here watches the filesystem. Where the
      // runtime enforces no write boundary, a write it never reported —  by
      // the binary itself, by a hook it launched, by a shell command — leaves
      // no trace in this field at all (FR042).
      writeObservation: writeObservation(adapter.id, containment, boundary),
      // A write the runtime refused is the tool boundary working; a write whose
      // outcome it never reported is neither proof nor refutation. Both are
      // recorded separately so the manifest cannot say "wrote" about either.
      deniedWritesOutsideGrantedPaths: evidence?.deniedFileChangesOutsideAllowedPaths ?? [],
      unconfirmedWritesOutsideGrantedPaths: evidence?.unconfirmedFileChangesOutsideAllowedPaths ?? [],
      runtimeToolCalls: evidence?.toolCalls ?? 0,
      runtimeCommands: evidence?.commandsExecuted ?? 0,
      runtimeErrors: evidence?.errors.length ?? 0,
      acceptanceFixturePaths: fixturePaths,
      acceptanceFixtureMutations: surfaceFindings.mutations,
      acceptanceFixtureAdditions: surfaceFindings.additions,
      acceptanceDefinitionChanges: surfaceFindings.definitionChanges,
      // The rest of what the criteria execute, and how completely the run
      // worked it out. An empty `acceptanceSurfaceUnresolved` with
      // `moduleGraphResolved: true` is the only combination that means "the
      // whole executed surface was followed".
      acceptanceExecutedDependencies: executedDependencies,
      acceptanceDependencyChanges: surfaceFindings.dependencyChanges,
      acceptanceSurfaceResolution: {
        moduleGraphResolved: surface.resolution.moduleGraphResolved,
        entryPoints: surface.resolution.entryPoints,
        filesVisited: surface.resolution.filesVisited,
        partial: surface.resolution.truncated,
      },
      acceptanceSurfaceUnresolved: surface.resolution.unresolved,
      // Well-formed runtime output the adapter did not normalize — not
      // malformed lines, and not an error count.
      unnormalizedRuntimeEvents: evidence?.rawEvents ?? 0,
      verificationCopyStrategy: receipts[0]?.copyStrategy ?? null,
      note: 'acceptance is decided from verifier-executed check receipts, the integrity of the fixtures those receipts executed, and the run-level blockers listed under acceptance.reasons; the runtime-reported fields above are context, not evidence of correctness',
      // What this run's write boundary actually was, as recorded values rather
      // than one fixed paragraph: a manifest from a runtime with no sandbox
      // must not read like one from a kernel-confined run.
      containment: {
        policy: containment.policy,
        profileWrites: containment.writes,
        adapter: adapter.id,
        writeContainment: containment.status,
        writeContainmentNote: containment.note,
        statusTestedVersion: containment.testedVersion,
        statusOs: containment.os,
        // What the run OBSERVED, not what the table expects. A capability
        // table may say what should happen; only evidence may say what did.
        enforcedWriteBoundary: boundary.held,
        expectedWriteBoundary: boundary.expected,
        boundaryFindings: boundary.findings,
        unplaceableChanges: boundary.unplaceable,
        unconfinedWritesAcknowledged: containment.unconfinedWrites ? containment.acknowledged : false,
        // Everything the adapter said it cannot enforce for this profile.
        unenforceable: sessionUnenforceable,
      },
      containmentNote: renderContainmentNote(adapter.id, containment, boundary),
    },
    timing,
    usage: usageFor(adapter, session),
    unresolved,
    artifacts: artifacts.map((artifact) => ({ type: artifact.type, path: artifact.relativePath, sha256: artifact.sha256 })),
  };

  const manifestArtifact = writeArtifact(db, paths, {
    runId,
    taskId,
    attemptId,
    type: 'result',
    relativePath: `${artifactPrefix}result.json`,
    bytes: `${JSON.stringify(manifest, null, 2)}\n`,
    baseRevision,
    candidateRevision: candidateSnapshot?.candidateRevision ?? null,
    provenance: { producer: 'runDirect', manifestVersion: RUN_MANIFEST_VERSION },
  });
  const summaryArtifact = writeArtifact(db, paths, {
    runId,
    taskId,
    attemptId,
    type: 'summary',
    relativePath: `${artifactPrefix}summary.md`,
    bytes: renderSummary(manifest),
    baseRevision,
    candidateRevision: candidateSnapshot?.candidateRevision ?? null,
    provenance: { producer: 'runDirect' },
  });
  projectEventsJsonl(db, paths, runId);

  const artifactsDir = paths.runArtifactsDir(runId);
  if (candidateSnapshot !== null && candidateSnapshot.checkpointCreated) {
    // The change itself, not only a path to it: R0's terminal has to show the
    // resulting diff. Long diffs are cut off and the full patch path is given.
    stream.line(`candidate diff (${candidateSnapshot.baseRevision.slice(0, 12)} → ${candidateSnapshot.candidateRevision.slice(0, 12)}):`);
    for (const line of previewPatch(readFileSync(candidateSnapshot.patchPath, 'utf8'))) stream.line(line);
  }
  stream.line(`artifacts: ${artifactsDir}`);
  stream.line(`  result.json · summary.md${patchArtifact !== null ? ' · candidate.patch' : ''}${persistedChecks.length > 0 ? ' · checks/' : ''}${runtimeEvents.length > 0 ? ' · logs/' : ''}`);
  stream.line(
    outcome === 'accepted'
      ? `accepted: ${acceptance.requiredPassed}/${acceptance.requiredTotal} required criteria passed with verifier-executed evidence`
      : outcome === 'interrupted'
        ? 'interrupted: work preserved on the candidate branch, nothing accepted'
        : `not accepted: ${acceptance.reasons.join('; ') || 'no acceptance evidence'}`,
  );
  stream.event({ type: `run.${outcome}`, runId, accepted: acceptance.accepted, candidateRevision: candidateSnapshot?.candidateRevision ?? null });

  // Classify the failure in the run path, not only in a report. A run that
  // stopped on an expired credential or an exhausted quota is a different
  // thing from one whose code failed, and only the classification lets a
  // coordinator decide whether handing the work to another runtime is honest.
  // The signals are the adapter's own machine-readable ones, so the tag table,
  // the HTTP-status rules, the errno rules and the Claude Code subtype rule
  // are live here rather than the class being re-derived from prose.
  const failure: FailureClassification | null = acceptance.accepted
    ? null
    : classifyFailure(
        observeRuntimeFailure({
          adapter: adapter.id,
          events: runtimeEvents,
          turnFailure: evidence?.turnFailure ?? null,
          runtimeExited: turnConclusion === 'runtime_exited',
        }),
      );
  if (failure !== null) {
    appendEvent(db, {
      runId,
      taskId,
      attemptId,
      type: 'runtime.failure_classified',
      payload: { failureClass: failure.failureClass, retryable: failure.retryable, signal: failure.signal, userAction: failure.userAction },
    });
    stream.event({ type: 'runtime.failure_classified', runId, taskId, failureClass: failure.failureClass, retryable: failure.retryable });
  }

  return {
    runId,
    taskId,
    attemptId,
    outcome,
    contract,
    failure,
    runtime: { runtimeId: binding.runtime.id, adapter: adapter.id },
    taskState: outcome === 'accepted' ? 'accepted' : outcome === 'interrupted' ? 'cancelled' : 'failed',
    attemptState: interrupted ? 'interrupted' : turnConclusion === 'runtime_exited' || turnConclusion === 'turn_failed' ? 'failed' : 'completed',
    runState: outcome === 'accepted' ? 'ready_for_review' : outcome === 'interrupted' ? 'interrupted' : 'failed',
    acceptance,
    receipts,
    snapshot: candidateSnapshot,
    workspace,
    manifest,
    manifestPath: path.join(artifactsDir, manifestArtifact.relativePath),
    summaryPath: path.join(artifactsDir, summaryArtifact.relativePath),
    patchPath: patchArtifact === null ? null : path.join(artifactsDir, patchArtifact.relativePath),
    runDir,
    evidence,
    stopReceipt,
    coordination: {
      attached: bridgeConfig !== null,
      socketPath: bridgeConfig?.socketPath ?? null,
      reason: bridgeConfig !== null ? null : (bridgeReason ?? 'no coordination bridge was started for this run'),
      messagesDelivered,
      messagesRecorded: bridge === null ? 0 : safeMessageCount(bridge),
    },
  };
}

/**
 * The runtime's own way of taking an MCP server on its command line. An
 * adapter with no such flag gets nothing spliced rather than a guess.
 */
export function coordinationArgsFor(adapterId: string, config: AttemptBridgeConfig): ReadonlyArray<string> {
  if (adapterId === 'claude-code') return config.claudeArgs;
  if (adapterId === 'codex') return config.codexArgs;
  return [];
}

/** The task's bounded inbox, flattened to id and text. A read failure is an empty inbox, never a run failure. */
/**
 * A message body is a parsed object, so interpolating it yields
 * "[object Object]" and the recipient receives nothing it can act on. Render
 * the shape the bridge actually stores: `send_message` normalizes a string
 * body to `{ text }` and carries an optional `subject` beside it.
 */
export function renderMessageBody(body: Record<string, unknown>): string {
  const subject = typeof body['subject'] === 'string' ? body['subject'] : null;
  const rest: Record<string, unknown> = { ...body };
  delete rest['subject'];
  const keys = Object.keys(rest);
  const text = keys.length === 1 && keys[0] === 'text' && typeof rest['text'] === 'string' ? rest['text'] : JSON.stringify(rest);
  return subject === null ? text : `${subject}: ${text}`;
}

function deliverableMessages(bridge: CoordinationBridge, taskId: string): ReadonlyArray<{ id: string; text: string }> {
  try {
    return bridge.deliverableFor(taskId).map((message) => ({
      id: message.id,
      text: `[${message.type} from ${message.senderTaskId ?? 'coordinator'}] ${renderMessageBody(message.body)}`,
    }));
  } catch {
    return [];
  }
}

function safeMessageCount(bridge: CoordinationBridge): number {
  try {
    return bridge.messages().length;
  } catch {
    return 0;
  }
}

class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContract(requestText: string, checks: ReadonlyArray<CheckSpec>, acceptanceFixturePaths: ReadonlyArray<string> = []): TaskContract {
  const firstLine = requestText.trim().split('\n')[0] ?? requestText.trim();
  return validateTaskContract({
    contractVersion: TASK_CONTRACT_VERSION,
    objective: firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine,
    // The acceptance fixtures are forbidden because rewriting them is how a
    // worker would manufacture a pass, and the run refuses acceptance when it
    // sees that happen. Adding a new test file is still allowed.
    scope: { description: 'the candidate workspace for this attempt', allowedPaths: [], forbiddenPaths: ['.git', ...acceptanceFixturePaths] },
    acceptanceCriteria: checks.map((check) => ({
      id: check.criterionId,
      description: check.description ?? `${check.command} ${(check.args ?? []).join(' ')}`.trim(),
      check: {
        command: check.command,
        args: [...(check.args ?? [])],
        ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      },
    })),
    dependencies: [],
    constraints: ['Do not modify Git administration or create commits; the coordinator owns candidate history.'],
    evidenceRequirements: ['every required criterion needs a check the verifier executed against the frozen candidate'],
  });
}

/**
 * One human line per meaningful runtime action, or `null` for an event that
 * should not produce one.
 *
 * Two rules keep the terminal readable without hiding anything:
 *
 * - an adapter reports the same action twice (`phase: "started"`, then
 *   `phase: "completed"`). The line is printed when the action starts, so
 *   progress is visible as it happens, and repeated on completion only when
 *   the completion carries something new — an exit code, a refusal;
 * - `raw` events are well-formed runtime output the adapter did not normalize
 *   (MCP server startup, reasoning items, token usage, unknown methods). They
 *   are counted and summarized after the turn instead of printed one by one.
 *
 * Nothing is dropped: every event still reaches `--json`, `events.jsonl` and
 * the adapter's raw capture.
 */
function renderRuntimeEvent(event: RuntimeEvent, shorten: (value: string) => string = (value) => value): string | null {
  const payload = event.payload;
  const phase = typeof payload['phase'] === 'string' ? (payload['phase'] as string) : null;
  switch (event.kind) {
    case 'session_started': {
      const id = payload['threadId'] ?? payload['sessionId'] ?? event.sessionId;
      return `  runtime session ${String(id)} started`;
    }
    case 'turn_started':
      return '  turn started';
    case 'assistant_message':
      return `  message: ${truncateLine(String(payload['text'] ?? ''))}`;
    case 'tool_call':
      return `  tool ${String(payload['tool'] ?? 'unknown')}${payload['path'] !== undefined ? ` ${shorten(String(payload['path']))}` : ''}`;
    case 'tool_result': {
      const outcome = payload['status'] ?? (payload['ok'] === true ? 'ok' : payload['ok'] === false ? 'failed' : payload['isError'] === false ? 'ok' : payload['isError'] === true ? 'failed' : 'outcome not reported');
      return `  tool ${String(payload['tool'] ?? 'unknown')} -> ${String(outcome)}`;
    }
    case 'file_change': {
      const where = payload['path'] === null || payload['path'] === undefined ? '(path not reported)' : shorten(String(payload['path']));
      if (payload['denied'] === true) return `  change denied: ${where}`;
      const outside = payload['withinAllowedPaths'] === false;
      // A request is not a change. The line says which it is, because a write
      // the model merely asked for and a write that landed are different facts
      // — and for a runtime with no sandbox that is the whole distinction.
      if (phase === 'requested') return outside ? `  requested a write to ${where} (OUTSIDE the granted paths)` : null;
      if (phase === 'started') return null;
      if (payload['applied'] === false || payload['applied'] === null) {
        return outside ? `  write to ${where} not confirmed by the runtime (OUTSIDE the granted paths)` : `  write to ${where} not confirmed by the runtime`;
      }
      return outside ? `  changed ${where} (OUTSIDE the granted paths; not part of the candidate)` : `  changed ${where}`;
    }
    case 'command_exec': {
      const command = truncateLine(String(payload['command'] ?? ''));
      if (phase === 'started' || phase === null) return `  exec ${command}`;
      if (payload['denied'] === true) return `  exec denied: ${command}`;
      const exitCode = payload['exitCode'];
      return typeof exitCode === 'number' ? `  exec -> exit ${exitCode}` : null;
    }
    case 'turn_completed':
      return '  turn completed';
    case 'turn_interrupted':
      return '  turn interrupted';
    case 'error':
      return `  runtime error: ${truncateLine(JSON.stringify(payload))}`;
    case 'raw':
      // Counted and summarized once the turn ends; see the caller.
      return null;
    default:
      return `  ${event.kind}`;
  }
}

export const MAX_PATCH_PREVIEW_LINES = 120;

/**
 * The candidate diff as terminal lines, cut off at a bounded length. A big
 * change must not flood the terminal, and the cut is stated rather than left
 * for the reader to notice; the complete patch is always on disk.
 */
export function previewPatch(patch: string, maxLines = MAX_PATCH_PREVIEW_LINES): string[] {
  const lines = patch.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.map((line) => `  ${line}`);
  const shown = lines.slice(0, maxLines).map((line) => `  ${line}`);
  shown.push(`  … ${lines.length - maxLines} more diff line(s); the complete patch is candidate.patch`);
  return shown;
}

function truncateLine(text: string, max = 160): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// The runtime's machine-readable failure signals (FR053)
// ---------------------------------------------------------------------------

/**
 * What an adapter already recorded about *why* a turn failed, in the shape
 * `classifyFailure` reads.
 *
 * Every field below is lifted from a payload key an adapter really writes; not
 * one of them is inferred from the worker's prose. Without this the only thing
 * that reached the classifier was a rendered sentence, so the tag table, the
 * HTTP-status rules, the errno rules and the Claude Code subtype rule were all
 * dead on the run path and a real failure was classified `unknown`.
 */
export interface StructuredFailureSignals {
  /** Runtime error tag, or the coarse class the adapter derived from it (`errorClass`). */
  readonly errorTag: string | null;
  readonly httpStatus: number | null;
  readonly subtype: string | null;
  readonly terminalReason: string | null;
  /** Node/libuv style code, when the runtime reported one. */
  readonly code: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly isError: boolean | null;
}

/** Payload keys carrying a raw runtime tag: Codex `errorTag`, Claude Code `runtimeError` (the CLI's own `error` value). */
const RUNTIME_TAG_KEYS = ['errorTag', 'runtimeError'] as const;

/** errno shape, so a runtime's free-form `code` ("delete_failed") is never read as a libuv code. */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * An HTTP status the runtime stated in its own transport error. Codex 0.147.0
 * reports transport failures as `unexpected status 401 Unauthorized: …` and
 * carries the number nowhere else (see
 * docs/evidence/at03/2026-09-07-codex-signed-out/events-codex.jsonl), so this
 * is the status as the runtime reported it, not a guess about the message.
 */
const HTTP_STATUS_IN_RUNTIME_ERROR = /\b(?:unexpected status|status code|http(?:\s+status)?)\s+(\d{3})\b/i;

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A tag worth classifying. `unknown` is not one: it means the adapter could not classify it either. */
function usableTag(value: string | null): string | null {
  return value === null || value === 'unknown' ? null : value;
}

function statusFromRuntimeError(text: string | null): number | null {
  if (text === null) return null;
  const match = HTTP_STATUS_IN_RUNTIME_ERROR.exec(text);
  if (match?.[1] === undefined) return null;
  const status = Number.parseInt(match[1], 10);
  return status >= 100 && status <= 599 ? status : null;
}

export function structuredFailureSignals(events: ReadonlyArray<RuntimeEvent>): StructuredFailureSignals {
  let tag: string | null = null;
  let coarseClass: string | null = null;
  let httpStatus: number | null = null;
  let subtype: string | null = null;
  let terminalReason: string | null = null;
  let code: string | null = null;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let isError: boolean | null = null;

  const readShared = (payload: Record<string, unknown>): void => {
    for (const key of RUNTIME_TAG_KEYS) tag ??= usableTag(payloadString(payload, key));
    coarseClass ??= usableTag(payloadString(payload, 'errorClass'));
    httpStatus ??= payloadNumber(payload, 'httpStatus');
    const errno = payloadString(payload, 'code') ?? payloadString(payload, 'errno');
    if (errno !== null && ERRNO_SHAPE.test(errno)) code ??= errno;
  };

  for (const event of events) {
    const payload = event.payload;
    if (event.kind === 'turn_completed' || event.kind === 'turn_interrupted') {
      readShared(payload);
      subtype ??= payloadString(payload, 'subtype');
      terminalReason ??= payloadString(payload, 'terminalReason');
      if (typeof payload['isError'] === 'boolean') isError ??= payload['isError'];
      httpStatus ??= statusFromRuntimeError(payloadString(payload, 'error') ?? payloadString(payload, 'resultText'));
      continue;
    }
    if (event.kind !== 'error') continue;
    readShared(payload);
    if (payload['fatal'] === true) {
      exitCode ??= payloadNumber(payload, 'exitCode');
      signal ??= payloadString(payload, 'signal');
    }
    httpStatus ??= statusFromRuntimeError(payloadString(payload, 'message'));
  }

  // The raw runtime tag first, the adapter's own coarse class second: both are
  // machine-readable, and the more specific one decides when it exists.
  return { errorTag: tag ?? coarseClass, httpStatus, subtype, terminalReason, code, exitCode, signal, isError };
}

/**
 * Everything observed about a failed turn, in the shape the classifier reads.
 *
 * The two message facts are joined rather than assigned to the same key: the
 * runtime's own statement that the turn failed and the separate fact that its
 * process ended first are different observations, and while both were written
 * to `message` the second silently replaced the first.
 */
export function observeRuntimeFailure(input: {
  readonly adapter: string;
  readonly events: ReadonlyArray<RuntimeEvent>;
  /** The runtime's own words about the turn it ended, from `TurnEvidence.turnFailure`. */
  readonly turnFailure: string | null;
  /** True when the runtime process ended before the turn completed. */
  readonly runtimeExited: boolean;
}): ObservedFailure {
  const signals = structuredFailureSignals(input.events);
  const message = [
    input.turnFailure,
    input.runtimeExited ? `the runtime process ended before the turn completed (${describeExit(input.events)})` : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join('; ');
  return {
    source: 'runtime',
    adapter: input.adapter,
    ...(message.length > 0 ? { message } : {}),
    ...(signals.errorTag !== null ? { errorTag: signals.errorTag } : {}),
    ...(signals.httpStatus !== null ? { httpStatus: signals.httpStatus } : {}),
    ...(signals.subtype !== null ? { subtype: signals.subtype } : {}),
    ...(signals.terminalReason !== null ? { terminalReason: signals.terminalReason } : {}),
    ...(signals.code !== null ? { code: signals.code } : {}),
    ...(signals.exitCode !== null ? { exitCode: signals.exitCode } : {}),
    ...(signals.signal !== null ? { signal: signals.signal } : {}),
    ...(signals.isError !== null ? { isError: signals.isError } : {}),
  };
}

function describeExit(events: ReadonlyArray<RuntimeEvent>): string {
  const fatal = [...events].reverse().find((event) => event.kind === 'error' && event.payload['fatal'] === true);
  if (fatal === undefined) return 'no exit detail recorded';
  const code = fatal.payload['exitCode'];
  const signal = fatal.payload['signal'];
  return `reason ${String(fatal.payload['reason'] ?? 'unknown')}, exit ${String(code)}${signal ? `, signal ${String(signal)}` : ''}`;
}

function summarizeTiming(timer: PhaseTimer): RunTiming {
  const summary = timer.summary();
  return {
    dispatchMs: Math.round(summary.phases.dispatch.totalMs),
    startupMs: Math.round(summary.phases.startup.totalMs),
    runtimeMs: Math.round(summary.phases.runtime.totalMs),
    validationMs: Math.round(summary.phases.validation.totalMs),
    elapsedMs: Math.round(summary.elapsedMs),
  };
}

/**
 * What an adapter reported for the turn, validated rather than trusted: an
 * adapter that answers with something else yields "unavailable", never a
 * guessed number.
 */
const TurnUsageReportSchema = z.strictObject({
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  costUsd: z.number().nullable(),
  costStatus: z.enum(['measured', 'unavailable']),
  detail: z.string(),
});

/**
 * FR060: separate measured from unavailable usage, for tokens and for cost
 * separately.
 *
 * The numbers come from `RuntimeAdapter.lastTurnUsage`, the shared contract
 * method — never from an adapter-shaped accessor discovered by name. Reading
 * one adapter's private method is how a manifest ends up saying "no usage was
 * reported for this turn" about a turn whose usage the adapter measured and
 * whose event stream carries it.
 *
 * Cost is not assumed absent either. Codex's app server reports no price, but
 * Claude Code's result record does report `total_cost_usd`, and the adapter
 * says whether that number was measured (a turn that reached the provider) or
 * is unavailable — which is the difference AT14 turns on, so it is recorded as
 * the adapter states it rather than hard-coded to null.
 */
function usageFor(adapter: RuntimeAdapter, session: SessionHandle | null): UsageReport {
  const report = adapter.capabilities().capabilities.usage_reporting;
  if (report.status === 'unsupported') {
    return { ...USAGE_UNAVAILABLE, source: `${adapter.id}: ${report.note ?? 'usage reporting is unsupported'}` };
  }
  if (session !== null && typeof adapter.lastTurnUsage === 'function') {
    const parsed = TurnUsageReportSchema.safeParse(adapter.lastTurnUsage(session));
    if (parsed.success) {
      const usage = parsed.data;
      const measuredCost = usage.costStatus === 'measured' && usage.costUsd !== null;
      if (usage.inputTokens !== null || usage.outputTokens !== null || measuredCost) {
        return {
          status: 'measured',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          // Never a zero standing in for "unknown": an unavailable cost stays null.
          costUsd: measuredCost ? usage.costUsd : null,
          source: `${adapter.id}: ${usage.detail}${measuredCost ? '' : ' (cost unavailable, reported as null rather than zero)'}`,
        };
      }
    }
  }
  return { ...USAGE_UNAVAILABLE, source: `${adapter.id}: no usage was reported for this turn` };
}

const EffectiveRuntimeSettingsSchema = z.object({
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
});

/**
 * FR006: record the model and effort the *runtime* reported for this session
 * beside the ones the configuration asked for.
 *
 * `runtime.model` alone cannot answer "what actually ran": the run path does
 * not call the runtime's model listing before dispatching, so a configured
 * value reaches `openSession` as `supported_unverified` and is passed through
 * unchanged. Both installed runtimes echo back what took effect, and the
 * shared `effectiveSettings` contract method is how that reaches the manifest.
 * An adapter that does not implement it, or a session that never opened,
 * yields `not_reported` — never the requested value repeated as if confirmed.
 */
function effectiveSettingsFor(
  adapter: RuntimeAdapter,
  session: SessionHandle | null,
): { effectiveModel: string | null; effectiveEffort: string | null; effectiveSettingsSource: 'runtime_reported' | 'not_reported' } {
  const unreported = { effectiveModel: null, effectiveEffort: null, effectiveSettingsSource: 'not_reported' as const };
  if (session === null || typeof adapter.effectiveSettings !== 'function') return unreported;
  const parsed = EffectiveRuntimeSettingsSchema.safeParse(adapter.effectiveSettings(session));
  if (!parsed.success) return unreported;
  const model = parsed.data.model ?? null;
  const effort = parsed.data.effort ?? null;
  if (model === null && effort === null) return unreported;
  return { effectiveModel: model, effectiveEffort: effort, effectiveSettingsSource: 'runtime_reported' };
}

/** Is this task already in the store? A repair reuses its task row. */
function taskExists(db: DatabaseSync, taskId: string): boolean {
  return db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) !== undefined;
}

function transitionRunSafely(db: DatabaseSync, runId: string, to: 'failed' | 'interrupted' | 'ready_for_review'): void {
  try {
    transitionRun(db, runId, to);
  } catch {
    // Already in a terminal state; the recorded state stays as it is.
  }
}

function transitionTaskSafely(db: DatabaseSync, taskId: string, to: 'failed' | 'cancelled'): void {
  try {
    transitionTask(db, taskId, to);
  } catch {
    // Already terminal.
  }
}

function transitionAttemptSafely(db: DatabaseSync, attemptId: string, to: 'failed' | 'completed' | 'interrupted', options: { outcome?: unknown; uncertain?: boolean } = {}): void {
  try {
    transitionAttempt(db, attemptId, to, options);
  } catch {
    // Already terminal.
  }
}

function recordReceiptSafely(db: DatabaseSync, operationId: string, outcome: 'completed' | 'failed', receipt: Record<string, unknown>): void {
  try {
    recordReceipt(db, operationId, { outcome, receipt });
  } catch {
    // A duplicate or conflicting receipt is already recorded; the first one wins.
  }
}

/** Human-readable run report: requirement by requirement, with the identities behind it. */
export function renderSummary(manifest: RunManifest): string {
  const lines: string[] = [];
  const candidate = manifest.candidate as Record<string, unknown>;
  lines.push(`# Run ${manifest.runId} — ${manifest.outcome}`);
  lines.push('');
  lines.push('## Request');
  lines.push('');
  lines.push('The user\'s original wording, unmodified:');
  lines.push('');
  lines.push('```text');
  lines.push(manifest.request.text.trimEnd());
  lines.push('```');
  lines.push('');
  lines.push('## Identities');
  lines.push('');
  lines.push(`- Repository: \`${String((manifest.project as Record<string, unknown>)['canonicalPath'])}\``);
  lines.push(`- Base revision: \`${String((manifest.base as Record<string, unknown>)['revision'])}\` (committed HEAD)`);
  lines.push(`- Uncommitted changes excluded: ${(manifest.base as Record<string, unknown>)['uncommittedChangesExcluded'] === null ? 'none, the checkout was clean' : 'yes, and the user\'s checkout was left untouched'}`);
  if (candidate['created'] === true) {
    lines.push(`- Candidate revision: \`${String(candidate['revision'])}\` on branch \`${String(candidate['branch'])}\``);
    lines.push(`- Candidate patch hash: \`${String(candidate['patchHash'])}\``);
  } else {
    lines.push('- Candidate: none was frozen');
  }
  lines.push(`- Agent: \`${String((manifest.agent as Record<string, unknown>)['id'])}\` (snapshot \`${String((manifest.agent as Record<string, unknown>)['snapshotHash']).slice(0, 12)}\`) on adapter \`${String((manifest.runtime as Record<string, unknown>)['adapter'])}\``);
  const runtime = manifest.runtime as Record<string, unknown>;
  lines.push(
    runtime['effectiveSettingsSource'] === 'runtime_reported'
      ? `- Model: requested \`${String(runtime['model'] ?? 'runtime default')}\`, and the runtime reported \`${String(runtime['effectiveModel'] ?? 'nothing')}\` in effect${runtime['effectiveEffort'] === null || runtime['effectiveEffort'] === undefined ? '' : ` at effort \`${String(runtime['effectiveEffort'])}\``}`
      : `- Model: requested \`${String(runtime['model'] ?? 'runtime default')}\`; the runtime reported no effective value, so what ran is not confirmed`,
  );
  const containment = (manifest.evidence['containment'] ?? null) as Record<string, unknown> | null;
  if (containment !== null) {
    lines.push(
      containment['profileWrites'] === true
        ? `- Write boundary: policy \`${String(containment['policy'])}\` writes files; the adapter reports write_containment \`${String(containment['writeContainment'])}\`${containment['writeContainment'] === 'unsupported' ? ' — **this run had no enforced write boundary**' : ''}`
        : `- Write boundary: not required; policy \`${String(containment['policy'])}\` does not write`,
    );
    if (containment['profileWrites'] === true) {
      // What the run observed, said next to what the table expected, so a
      // reader can never mistake one for the other.
      const held = containment['enforcedWriteBoundary'];
      const findings = (containment['boundaryFindings'] as ReadonlyArray<string> | undefined) ?? [];
      lines.push(
        held === true
          ? '  - observed in this run: **the boundary held** — no reported write landed outside the granted paths, and every reported change could be placed inside them'
          : held === false
            ? `  - observed in this run: **the boundary did NOT hold** — ${findings.join('; ')}`
            : `  - observed in this run: **not established** — ${findings.join('; ') || 'this run observed nothing about its boundary'}`,
      );
    }
    const unenforceable = (containment['unenforceable'] as Array<{ aspect: string; reason: string }> | undefined) ?? [];
    for (const entry of unenforceable) lines.push(`  - not enforced by the runtime — \`${entry.aspect}\`: ${entry.reason}`);
    const observation = (manifest.evidence['writeObservation'] ?? null) as { note?: unknown } | null;
    if (observation !== null && typeof observation.note === 'string') lines.push(`  - writes outside the granted paths: ${observation.note}`);
  }
  lines.push('');
  lines.push('## Requirement status');
  lines.push('');
  if (manifest.requirements.length === 0) {
    lines.push('No acceptance criteria were recorded.');
  } else {
    lines.push('| Criterion | Required | Status | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const requirement of manifest.requirements) {
      lines.push(`| \`${requirement.criterionId}\` | ${requirement.required ? 'yes' : 'no'} | ${requirement.status} | ${requirement.detail} |`);
    }
  }
  lines.push('');
  lines.push(`Acceptance: ${manifest.acceptance.accepted ? 'accepted' : 'not accepted'} (${manifest.acceptance.requiredPassed}/${manifest.acceptance.requiredTotal} required criteria passed).`);
  lines.push('');
  lines.push('Every status above comes from a check this coordinator executed itself against the frozen candidate. A runtime reporting success does not appear in this table.');
  lines.push('');
  lines.push('## Changed files');
  lines.push('');
  const changed = (candidate['changedFiles'] as Array<{ status: string; path: string }> | undefined) ?? [];
  if (changed.length === 0) lines.push('None: the candidate is identical to its base.');
  else for (const change of changed) lines.push(`- \`${change.status}\` ${change.path}`);
  lines.push('');
  lines.push('## Timing');
  lines.push('');
  lines.push(`- dispatch: ${manifest.timing.dispatchMs} ms`);
  lines.push(`- runtime startup: ${manifest.timing.startupMs} ms`);
  lines.push(`- model/runtime turn: ${manifest.timing.runtimeMs} ms`);
  lines.push(`- validation: ${manifest.timing.validationMs} ms`);
  lines.push(`- elapsed: ${manifest.timing.elapsedMs} ms`);
  lines.push('');
  lines.push(`Usage: ${manifest.usage.status} (${manifest.usage.source}).`);
  lines.push('');
  lines.push('## Unresolved');
  lines.push('');
  if (manifest.unresolved.length === 0) lines.push('Nothing unresolved was recorded.');
  else for (const item of manifest.unresolved) lines.push(`- ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
