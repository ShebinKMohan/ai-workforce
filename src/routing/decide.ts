/**
 * Route selection (FR021, FR029).
 *
 * Direct is the default and the product's whole point: a bounded, clearly
 * scoped request goes straight to one capable worker with no planner and no
 * reviewer. The planned route is chosen only when the request itself carries
 * evidence that it decomposes — two or more independently targeted
 * deliverables, or an explicit interface between named parts.
 *
 * Every decision reports the signals it was made from, so an operator can see
 * exactly why planning was or was not used. Pure: no I/O, no runtime calls.
 */
import { POLICY_PROFILES, type Limits, type Policy } from '../core/contracts.js';

export type RoutePath = 'direct' | 'planned';

export interface RoutingAgent {
  readonly id: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly policy: Policy;
}

export interface RoutingProject {
  readonly repoPath: string;
  /** Top-level entries of the repository, when known; used to recognise named targets. */
  readonly topLevelPaths?: ReadonlyArray<string>;
}

export interface RoutingRequest {
  /** The user's original wording, never rewritten. */
  readonly text: string;
  readonly contextRefs?: ReadonlyArray<string>;
  /** Explicit operator override. Honoured when it is achievable; the reason always says so. */
  readonly forcePath?: RoutePath;
}

export interface RoutingDefaults {
  readonly workerAgent?: string;
  readonly plannerAgent?: string;
}

export interface DecideRouteInput {
  readonly request: RoutingRequest;
  readonly project: RoutingProject;
  readonly agents: ReadonlyArray<RoutingAgent>;
  readonly limits: Pick<Limits, 'maxTasksPerRun'>;
  readonly defaults?: RoutingDefaults;
}

export type RouteSignalId =
  | 'enumerated_deliverables'
  | 'distinct_targets'
  | 'explicit_interface'
  | 'single_scope_marker'
  | 'read_only_request'
  | 'planner_unavailable'
  | 'task_budget_one'
  | 'operator_override';

export interface RouteSignal {
  readonly id: RouteSignalId;
  readonly detail: string;
  /** Evidence lifted from the request, so the reason is checkable. */
  readonly evidence: ReadonlyArray<string>;
}

export interface RouteWorker {
  readonly agentId: string;
  readonly matchedCapabilities: ReadonlyArray<string>;
  readonly missingCapabilities: ReadonlyArray<string>;
  readonly writesCandidate: boolean;
}

export interface RouteDecision {
  readonly path: RoutePath;
  /** One sentence an operator can act on. Always names the deciding signal. */
  readonly reason: string;
  /** Null only when no configured agent can carry the request. */
  readonly worker: RouteWorker | null;
  /** Set only on the planned path. */
  readonly planner: string | null;
  readonly signals: ReadonlyArray<RouteSignal>;
  readonly requiredCapabilities: ReadonlyArray<string>;
  /** Present when no worker could be selected. */
  readonly blocker?: string;
}

// ---------------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------------

const ACTION_VERB =
  /\b(add|create|build|implement|write|fix|update|change|refactor|remove|delete|rename|migrate|document|test|expose|wire|extract|introduce|support|handle|generate|port|upgrade|replace|split|move)\b/i;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

const SEGMENT_SPLIT = /\b(?:and also|also,|then also|separately|in addition|as well as)\b/i;

const INTERFACE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:interface|contract|protocol|api|schema|boundary)\s+between\b/i,
  /\bshared\s+(?:interface|contract|schema|types?|protocol)\b/i,
  /\bso\s+that\s+(?:the\s+)?[\w-]+\s+can\s+(?:consume|call|use|read)\b/i,
  /\bhands?\s+(?:it\s+|the\s+[\w-]+\s+)?(?:off\s+)?to\s+the\b/i,
];

const SINGLE_SCOPE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bjust\b/i,
  /\bonly\b/i,
  /\bone[- ]liner\b/i,
  /\bsingle\s+(?:file|function|line|test|change)\b/i,
  /\btypo\b/i,
];

const READ_ONLY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:review|audit|analy[sz]e|explain|summari[sz]e|investigate|explore|inspect)\b/i,
  /\breport\s+on\b/i,
];

const PATH_LIKE = /(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z]{1,6}\b/g;

const CAPABILITY_KEYWORDS: ReadonlyArray<{ readonly capability: string; readonly pattern: RegExp }> = [
  { capability: 'testing', pattern: /\b(?:tests?|testing|vitest|jest|pytest|spec)\b/i },
  { capability: 'typescript', pattern: /\b(?:typescript|tsx?)\b|\.ts\b/i },
  { capability: 'python', pattern: /\b(?:python|pytest)\b|\.py\b/i },
  { capability: 'documentation', pattern: /\b(?:docs?|documentation|readme|changelog)\b/i },
  { capability: 'refactor', pattern: /\brefactor(?:ing)?\b/i },
  { capability: 'review', pattern: /\b(?:review|audit|analy[sz]e)\b/i },
];

/** Enumerated or explicitly separated action items in the request. */
export function extractDeliverables(text: string): string[] {
  const listed: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LIST_ITEM.exec(line);
    if (match !== null && match[1] !== undefined && ACTION_VERB.test(match[1])) listed.push(match[1].trim());
  }
  if (listed.length >= 2) return listed;

  const segments = text
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && ACTION_VERB.test(s));
  return segments.length >= 2 ? segments : listed.length > 0 ? listed : segments;
}

/** Path-like or repository-named targets a deliverable names. */
export function extractTargets(item: string, project: RoutingProject): string[] {
  const out = new Set<string>();
  for (const match of item.matchAll(PATH_LIKE)) out.add(match[0].toLowerCase());
  for (const top of project.topLevelPaths ?? []) {
    const name = top.replace(/^\.\//, '').replace(/\/+$/, '');
    if (name.length === 0) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    if (pattern.test(item)) out.add(name.toLowerCase());
  }
  return [...out];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchAny(text: string, patterns: ReadonlyArray<RegExp>): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) hits.push(match[0]);
  }
  return hits;
}

export function inferRequiredCapabilities(text: string): string[] {
  const out: string[] = [];
  for (const entry of CAPABILITY_KEYWORDS) {
    if (entry.pattern.test(text) && !out.includes(entry.capability)) out.push(entry.capability);
  }
  return out;
}

export function isReadOnlyRequest(text: string): boolean {
  return matchAny(text, READ_ONLY_PATTERNS).length > 0 && !ACTION_VERB.test(text);
}

// ---------------------------------------------------------------------------
// Worker selection
// ---------------------------------------------------------------------------

function selectWorker(
  agents: ReadonlyArray<RoutingAgent>,
  required: ReadonlyArray<string>,
  needsWrite: boolean,
  preferredId: string | undefined,
): RouteWorker | null {
  let best: { agent: RoutingAgent; index: number; score: number } | null = null;
  agents.forEach((agent, index) => {
    const writes = POLICY_PROFILES[agent.policy].writeCandidate;
    if (needsWrite && !writes) return;
    const matched = required.filter((cap) => agent.capabilities.includes(cap));
    const score = matched.length * 10 + (agent.id === preferredId ? 1 : 0);
    if (best === null || score > best.score) best = { agent, index, score };
  });
  if (best === null) return null;
  const chosen: { agent: RoutingAgent; index: number; score: number } = best;
  const matched = required.filter((cap) => chosen.agent.capabilities.includes(cap));
  return {
    agentId: chosen.agent.id,
    matchedCapabilities: matched,
    missingCapabilities: required.filter((cap) => !chosen.agent.capabilities.includes(cap)),
    writesCandidate: POLICY_PROFILES[chosen.agent.policy].writeCandidate,
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Decide how a request is executed. Direct unless the request carries explicit
 * decomposition evidence and the run is actually able to plan.
 */
export function decideRoute(input: DecideRouteInput): RouteDecision {
  const { request, project, agents, limits } = input;
  const text = request.text;
  const signals: RouteSignal[] = [];

  const deliverables = extractDeliverables(text);
  const targets = deliverables.map((item) => extractTargets(item, project));
  const distinctTargets = new Set(targets.flat());
  const interfaceHits = matchAny(text, INTERFACE_PATTERNS);
  const singleScopeHits = matchAny(text, SINGLE_SCOPE_PATTERNS);
  const readOnly = isReadOnlyRequest(text);

  if (deliverables.length >= 2) {
    signals.push({
      id: 'enumerated_deliverables',
      detail: `${deliverables.length} separately stated action items`,
      evidence: deliverables.slice(0, 6),
    });
  }
  if (distinctTargets.size >= 2) {
    signals.push({
      id: 'distinct_targets',
      detail: `${distinctTargets.size} distinct named targets across the items`,
      evidence: [...distinctTargets].slice(0, 6),
    });
  }
  if (interfaceHits.length > 0) {
    signals.push({ id: 'explicit_interface', detail: 'the request names an interface between parts', evidence: interfaceHits });
  }
  if (singleScopeHits.length > 0) {
    signals.push({ id: 'single_scope_marker', detail: 'the request bounds itself to one change', evidence: singleScopeHits });
  }
  if (readOnly) {
    signals.push({ id: 'read_only_request', detail: 'the request asks for analysis, not edits', evidence: matchAny(text, READ_ONLY_PATTERNS) });
  }

  const required = inferRequiredCapabilities(text);
  const worker = selectWorker(agents, required, !readOnly, input.defaults?.workerAgent);
  const plannerAgent = input.defaults?.plannerAgent;
  const plannerConfigured = plannerAgent !== undefined && agents.some((a) => a.id === plannerAgent);
  const budgetAllowsPlanning = limits.maxTasksPerRun >= 2;

  if (!plannerConfigured) {
    signals.push({ id: 'planner_unavailable', detail: 'no planner agent is configured', evidence: [] });
  }
  if (!budgetAllowsPlanning) {
    signals.push({ id: 'task_budget_one', detail: `maxTasksPerRun is ${limits.maxTasksPerRun}`, evidence: [] });
  }

  const base = {
    signals,
    requiredCapabilities: required,
    worker,
  } as const;

  const noWorker = (path: RoutePath, reason: string): RouteDecision => ({
    ...base,
    path,
    reason,
    planner: null,
    blocker:
      needsWriteBlocker(agents, !readOnly) ??
      'no agent is configured; add at least one agent to the agent configuration file',
  });

  if (worker === null) return noWorker('direct', 'no configured agent can carry this request');

  // Explicit operator override, honoured when achievable.
  if (request.forcePath !== undefined) {
    signals.push({ id: 'operator_override', detail: `operator requested the ${request.forcePath} route`, evidence: [] });
    if (request.forcePath === 'direct') {
      return { ...base, path: 'direct', reason: 'the operator asked for the direct route', planner: null, worker };
    }
    if (plannerConfigured && budgetAllowsPlanning) {
      return { ...base, path: 'planned', reason: 'the operator asked for the planned route', planner: plannerAgent ?? null, worker };
    }
    return {
      ...base,
      path: 'direct',
      reason: plannerConfigured
        ? `the planned route was requested but maxTasksPerRun is ${limits.maxTasksPerRun}, so only one task can run`
        : 'the planned route was requested but no planner agent is configured',
      planner: null,
      worker,
    };
  }

  const decomposes = deliverables.length >= 2 && (distinctTargets.size >= 2 || interfaceHits.length > 0);
  const boundedBySingleScope = singleScopeHits.length > 0 && deliverables.length < 3;

  if (decomposes && !boundedBySingleScope && plannerConfigured && budgetAllowsPlanning) {
    const why =
      distinctTargets.size >= 2
        ? `${deliverables.length} deliverables target ${distinctTargets.size} distinct parts`
        : `${deliverables.length} deliverables meet at an interface the request names explicitly`;
    return { ...base, path: 'planned', reason: `planned: ${why}, so they need an ordered contract between them`, planner: plannerAgent ?? null, worker };
  }

  let reason: string;
  if (decomposes && !plannerConfigured) {
    reason = 'direct: the request looks decomposable but no planner agent is configured, so it goes to one worker whole';
  } else if (decomposes && !budgetAllowsPlanning) {
    reason = `direct: maxTasksPerRun is ${limits.maxTasksPerRun}, so the request goes to one worker whole`;
  } else if (boundedBySingleScope) {
    reason = 'direct: the request bounds itself to a single change';
  } else if (deliverables.length >= 2) {
    reason = 'direct: the items name no distinct parts and no interface between them, so decomposition would add overhead without adding order';
  } else {
    reason = 'direct: one bounded deliverable, so it goes straight to a capable worker';
  }
  return { ...base, path: 'direct', reason, planner: null, worker };
}

function needsWriteBlocker(agents: ReadonlyArray<RoutingAgent>, needsWrite: boolean): string | undefined {
  if (agents.length === 0) return undefined;
  if (!needsWrite) return undefined;
  return 'every configured agent uses a policy that cannot write to the candidate workspace; this request needs edits';
}
