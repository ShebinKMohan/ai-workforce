/**
 * The honesty functions, ported from web/office/src/office-model.js (lines
 * 148-546 and 567-576) with their meaning unchanged. No DOM, no fetch, no clock
 * of their own: every input is a document the workforce API returned.
 *
 * The rules this file exists to hold:
 * - A task is `working` only while the database holds a `running` attempt for
 *   it, in a run that is still live.
 * - A run is live only while a coordinator holds its state root. Rows left
 *   `running` by a coordinator that died are `stalled`, not work in progress.
 * - A failed run carries its reason wherever it is shown. A verifier pass the
 *   candidate compromised is drawn as compromised, never as verified.
 * - `verified` (the only green) needs task.state === 'accepted' AND a check
 *   receipt the verifier executed that passed. A runtime event, an assistant
 *   message saying "done", a completed turn, is never an input to it.
 * - There are no percentages. Progress is the observed phase.
 *
 * describeEvent's words ("coordinator", "candidate", "runtime") are record
 * words: the pages show them only inside "Show record" and All events.
 */

export const LIVE_RUN_STATES = new Set(['pending', 'running', 'waiting']);
const ACTIVE_TASK_STATES = new Set(['pending', 'ready', 'running', 'validating', 'waiting']);
const SETTLED_TASK_STATES = new Set(['accepted', 'failed', 'cancelled', 'superseded']);

/**
 * Whether the lock report GET /api/runs read alongside the rows proves that no
 * coordinator holds the state root. Rows say `pending`, `running` or `waiting`
 * for as long as a coordinator is alive to move them on; once its lock is free
 * (its holder dead, or no holder at all) nothing is working on those runs,
 * whatever the rows still say, until `workforce resume` takes them up. A
 * missing or unreadable report (`held` is not false) proves nothing.
 */
export function coordinatorStopped(lock) {
  return lock !== null && typeof lock === 'object' && lock.held === false;
}

/** A run whose rows say it is live while no coordinator holds the state root. */
export function isStalledRun(run, lock) {
  return LIVE_RUN_STATES.has(run?.state) && coordinatorStopped(lock);
}

function stallDetail(run, lock) {
  const holder = lock?.holder === 'dead' && lock.pid ? `its coordinator (pid ${lock.pid}) is gone` : lock?.holder === 'pid_reused' ? `the coordinator's pid ${lock.pid} now belongs to another process` : 'no coordinator holds the state root';
  return `run ${String(run?.id ?? '').slice(0, 8)} is recorded as ${run?.state}, but ${holder}, so nothing is working on it · \`workforce resume ${run?.id}\` continues it`;
}

function firstReason(run) {
  const reasons = run?.outcome?.reasons;
  return Array.isArray(reasons) ? reasons.find((reason) => typeof reason === 'string' && reason.trim().length > 0) ?? null : null;
}

/**
 * Why a run failed, in the words its verdict uses, from the outcome GET
 * /api/runs read out of the run's manifest. Null when no manifest says.
 */
export function failureReason(run) {
  const outcome = run?.outcome;
  if (outcome === null || typeof outcome !== 'object') return null;
  if (Array.isArray(outcome.compromised) && outcome.compromised.length > 0) return 'a criterion is compromised';
  const total = typeof outcome.requiredTotal === 'number' ? outcome.requiredTotal : 0;
  const passed = typeof outcome.requiredPassed === 'number' ? outcome.requiredPassed : 0;
  if (outcome.accepted === false && total > 0 && passed < total) return `${passed} of ${total} required checks passed`;
  const reason = firstReason(run);
  return reason === null ? null : clip(reason, 80);
}

/** The one definition of green. Receipts come from check rows; runtime events are not an input. */
export function isVerifiedTask(task) {
  return task?.state === 'accepted' && Number(task?.receipts?.verifierExecutedPassed ?? 0) > 0;
}

/** The observed phase of a live task, from its row and its attempt row. */
export function taskPhase(task) {
  switch (task?.state) {
    case 'running':
      return task.attempt?.state === 'running' ? 'working' : 'starting';
    case 'validating':
      return 'verifying';
    case 'waiting':
      return 'waiting';
    case 'pending':
    case 'ready':
      return 'queued';
    default:
      return null;
  }
}

const PHASE_RANK = { working: 5, verifying: 4, starting: 3, waiting: 2, queued: 1 };

export const DESK_LABELS = {
  open: 'Open desk · not configured',
  idle: 'Idle · no task',
  queued: 'Queued',
  waiting: 'Waiting',
  starting: 'Starting · preparing workspace',
  working: 'Working · attempt running',
  verifying: 'Verifying · checks running',
  verified: 'Verified · run still going',
  review: 'Needs review · verified',
  unverified: 'Accepted without a verifier receipt',
  failed: 'Failed',
  interrupted: 'Interrupted',
  stalled: 'Stalled · coordinator not running',
};

/**
 * One desk's state, derived from the run summaries (newest run first) and the
 * coordinator lock GET /api/runs read alongside them.
 *
 * Live work wins: the most advanced phase among the agent's non-terminal
 * tasks in live runs. With no coordinator holding the state root there is no
 * live work, and a run whose rows still say otherwise is `stalled`. Otherwise
 * the agent's most recent stalled or settled task says what happened last.
 * With neither, the agent is idle. An open desk (no agentId) is `open`
 * whatever the runs say.
 */
export function deskState(agentId, runs, lock = null) {
  if (typeof agentId !== 'string' || agentId.length === 0) return { state: 'open', label: DESK_LABELS.open, runId: null, taskId: null, lastEvent: null, detail: null };
  const list = Array.isArray(runs) ? runs : [];

  let live = null;
  for (const run of coordinatorStopped(lock) ? [] : list) {
    if (!LIVE_RUN_STATES.has(run?.state)) continue;
    for (const task of run.taskViews ?? []) {
      if (task?.ownerAgentId !== agentId || !ACTIVE_TASK_STATES.has(task.state)) continue;
      const phase = taskPhase(task);
      if (phase !== null && (live === null || PHASE_RANK[phase] > PHASE_RANK[live.phase])) live = { phase, run, task };
    }
  }
  if (live !== null) {
    const detail = live.phase === 'waiting' && live.task.waitReason ? `waiting on ${live.task.waitReason}` : null;
    return { state: live.phase, label: detail ? `Waiting · ${live.task.waitReason}` : DESK_LABELS[live.phase], runId: live.run.id, taskId: live.task.id, lastEvent: live.task.lastEvent ?? null, detail };
  }

  for (const run of list) {
    const mine = (run?.taskViews ?? []).filter((task) => task?.ownerAgentId === agentId);
    if (isStalledRun(run, lock)) {
      const task = mine.find((entry) => ACTIVE_TASK_STATES.has(entry.state)) ?? mine[0];
      if (task === undefined) continue;
      return { state: 'stalled', label: DESK_LABELS.stalled, runId: run.id, taskId: task.id, lastEvent: task.lastEvent ?? null, detail: stallDetail(run, lock) };
    }
    const owned = mine.filter((task) => SETTLED_TASK_STATES.has(task.state));
    if (owned.length === 0) continue;
    const task = owned.find((entry) => entry.state === 'failed') ?? owned[0];
    const base = { runId: run.id, taskId: task.id, lastEvent: task.lastEvent ?? null };
    if (task.state === 'accepted' && !isVerifiedTask(task)) return { ...base, state: 'unverified', label: DESK_LABELS.unverified, detail: 'the task is marked accepted but no verifier-executed passing receipt is recorded for it' };
    if (task.state === 'failed' || run.state === 'failed') {
      return { ...base, state: 'failed', label: `${DESK_LABELS.failed} · ${failureReason(run) ?? 'no reason recorded'}`, detail: firstReason(run) ?? (task.state === 'failed' ? 'task failed' : 'run failed') };
    }
    if (task.state === 'cancelled' || task.state === 'superseded' || run.state === 'interrupted' || run.state === 'cancelled') return { ...base, state: 'interrupted', label: DESK_LABELS.interrupted, detail: `task ${task.state}, run ${run.state}` };
    if (run.state === 'ready_for_review') return { ...base, state: 'review', label: DESK_LABELS.review, detail: null };
    return { ...base, state: 'verified', label: DESK_LABELS.verified, detail: `run ${run.state}` };
  }
  return { state: 'idle', label: DESK_LABELS.idle, runId: null, taskId: null, lastEvent: null, detail: null };
}

/** How a state is drawn. `verified` is the only tone that may be green. */
export function deskTone(state) {
  switch (state) {
    case 'review':
    case 'verified':
      return 'verified';
    case 'working':
      return 'active';
    case 'starting':
    case 'verifying':
    case 'queued':
    case 'waiting':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'unverified':
    case 'interrupted':
    case 'stalled':
      return 'warning';
    case 'open':
      return 'open';
    default:
      return 'idle';
  }
}

/**
 * Task-centre group. There is no run state for a human delivery decision yet, so nothing is ever grouped `accepted`.
 * A run whose rows say it is live while no coordinator holds the state root is `stalled`, not `running`.
 */
export function runGroup(run, lock = null) {
  if (run?.state === 'ready_for_review') return 'review';
  if (LIVE_RUN_STATES.has(run?.state)) return coordinatorStopped(lock) ? 'stalled' : 'running';
  return 'failed';
}

/** How a run row is drawn. Green only when it awaits review and every task rests on a verifier receipt. */
export function runTone(run, lock = null) {
  const tasks = run?.taskViews ?? [];
  switch (runGroup(run, lock)) {
    case 'review':
      return tasks.length > 0 && tasks.every(isVerifiedTask) ? 'verified' : 'warning';
    case 'running':
      return tasks.some((task) => taskPhase(task) === 'working') ? 'active' : 'pending';
    case 'stalled':
      return 'warning';
    default:
      return run?.state === 'failed' ? 'failed' : 'warning';
  }
}

export function runTitle(run) {
  const text = typeof run?.request?.text === 'string' ? run.request.text.trim() : '';
  return text.length > 0 ? text.split('\n', 1)[0] : `Run ${String(run?.id ?? '').slice(0, 8)}`;
}

/** A run's one-line status, from its rows, its manifest's outcome and the coordinator lock. */
export function runStatusLine(run, lock = null) {
  const tasks = run?.taskViews ?? [];
  const verified = tasks.filter(isVerifiedTask).length;
  switch (runGroup(run, lock)) {
    case 'review':
      return `Needs review · ${verified} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} verified`;
    case 'running': {
      const phases = tasks.map(taskPhase).filter(Boolean).sort((a, b) => PHASE_RANK[b] - PHASE_RANK[a]);
      return phases.length ? `${run.state === 'waiting' ? 'Waiting' : 'Running'} · ${DESK_LABELS[phases[0]].split(' · ')[0].toLowerCase()}` : `Run ${run.state}`;
    }
    case 'stalled':
      return `Stalled · recorded ${run.state}, but no coordinator is running it`;
    default:
      return run?.state === 'failed' ? `Failed · ${failureReason(run) ?? 'no reason recorded'}` : run?.state === 'interrupted' ? 'Interrupted' : run?.state === 'cancelled' ? 'Cancelled' : `Run ${run?.state ?? 'unknown'}`;
  }
}

/**
 * The four observed phases of a run's primary task, each `done`, `current`,
 * `stalled`, `failed` or `pending`. A phase is marked reached only on a
 * recorded fact: an attempt row (workspace), an attempt that started
 * (running), a receipt or a validating/settled task (verifying), a terminal
 * task (settled). With no coordinator running the run, the phase it stopped in
 * is `stalled`, never `current`.
 */
export function phaseSteps(run, lock = null) {
  const tasks = run?.taskViews ?? [];
  const task = tasks.find((entry) => ACTIVE_TASK_STATES.has(entry.state)) ?? tasks[0];
  const names = ['workspace', 'running', 'verifying', 'settled'];
  if (task === undefined) return names.map((name) => ({ name, status: 'pending' }));
  const receipts = task.receipts ?? {};
  const receiptCount = Number(receipts.verifierExecutedPassed ?? 0) + Number(receipts.verifierExecutedFailed ?? 0) + Number(receipts.verifierExecutedOther ?? 0) + Number(receipts.otherProvenance ?? 0);
  const settled = SETTLED_TASK_STATES.has(task.state);
  const reached = [
    task.attempt !== null && task.attempt !== undefined,
    Boolean(task.attempt?.startedAt),
    receiptCount > 0 || task.state === 'validating' || (task.state === 'accepted'),
    settled,
  ];
  const phase = taskPhase(task);
  const current = settled ? 3 : phase === 'verifying' ? 2 : phase === 'working' ? 1 : phase === 'starting' ? 0 : -1;
  return names.map((name, index) => {
    if (index === 3 && settled) return { name, status: isVerifiedTask(task) ? 'done' : 'failed' };
    if (index === current && !settled) return { name, status: isStalledRun(run, lock) ? 'stalled' : 'current' };
    return { name, status: reached[index] ? 'done' : 'pending' };
  });
}

// ---------------------------------------------------------------------------
// The status document (GET /api/runs/:id == `workforce status <id> --json`)
// ---------------------------------------------------------------------------

function receiptFor(status, id) {
  return (status?.checks ?? []).find((check) => check.id === id) ?? null;
}

/**
 * A check receipt row, toned: green only when the verifier executed it, it
 * passed, and nothing recorded says the candidate compromised it.
 *
 * `status` is the run's status document: a requirement marked `compromised`
 * names the receipt it rests on. Its `compromisedReceiptIds` also covers a
 * planned run's per-task manifests. `run` supplies the same evidence from
 * GET /api/runs for older servers. Without either, use the receipt row alone.
 */
export function checkView(check, status = null, run = null) {
  const verifier = check?.evidenceProvenance === 'verifier_executed';
  const compromisedFor = (status?.requirements ?? [])
    .filter((requirement) => requirement?.status === 'compromised' && requirement.receiptId === check?.id)
    .map((requirement) => requirement.criterionId);
  const compromised = compromisedFor.length > 0 || [status?.compromisedReceiptIds, run?.compromisedReceiptIds].some((ids) => Array.isArray(ids) && ids.includes(check?.id));
  const evidenceUnavailable = [status?.unverifiedReceiptIds, run?.unverifiedReceiptIds].some((ids) => Array.isArray(ids) && ids.includes(check?.id));
  const tone = compromised ? 'compromised' : evidenceUnavailable ? 'warning' : verifier && check.outcome === 'passed' ? 'verified' : check?.outcome === 'failed' ? 'failed' : 'warning';
  return { ...check, verifier, compromised, compromisedFor, tone, ...(evidenceUnavailable ? { evidenceUnavailable: true } : {}) };
}

/** Each requirement with the receipt it rests on. `passed` without a verifier-executed passing receipt is not green. */
export function requirementViews(status) {
  return (status?.requirements ?? []).map((requirement) => {
    const receipt = requirement.receiptId ? receiptFor(status, requirement.receiptId) : null;
    let tone;
    if (requirement.status === 'passed') tone = receipt && checkView(receipt, status).tone === 'verified' ? 'verified' : 'warning';
    else if (requirement.status === 'failed') tone = 'failed';
    else if (requirement.status === 'compromised') tone = 'compromised';
    else tone = 'warning';
    const label = { passed: 'Passed', failed: 'Failed', compromised: 'Compromised', no_evidence: 'No evidence' }[requirement.status] ?? String(requirement.status ?? 'unknown');
    return { ...requirement, receipt, tone, label: tone === 'warning' && requirement.status === 'passed' ? 'Passed without a verifier receipt' : label };
  });
}

/**
 * The run's verdict line. Green only for a run awaiting review whose acceptance and every required requirement rest on verifier receipts.
 * `lock` is the coordinator lock from GET /api/runs: an unsettled run with no coordinator running it is not waiting on the verifier.
 */
export function acceptanceView(status, lock = null) {
  const acceptance = status?.acceptance ?? null;
  const runState = status?.run?.state;
  const requirements = requirementViews(status);
  if (acceptance === null) {
    if (LIVE_RUN_STATES.has(runState) && coordinatorStopped(lock)) {
      return { tone: 'warning', text: 'Not settled · no coordinator is running this run, so the verifier will not decide until it is resumed' };
    }
    return LIVE_RUN_STATES.has(runState)
      ? { tone: 'pending', text: 'Not settled yet · the verifier has not decided' }
      : { tone: runState === 'failed' ? 'failed' : 'warning', text: `No acceptance recorded · run ${runState ?? 'unknown'}` };
  }
  const required = requirements.filter((requirement) => requirement.required !== false);
  const grounded = required.length > 0 && required.every((requirement) => requirement.tone === 'verified');
  if (acceptance.accepted === true && grounded && runState === 'ready_for_review') {
    return { tone: 'verified', text: `Verifier accepted · ${acceptance.requiredPassed} of ${acceptance.requiredTotal} required checks passed` };
  }
  if (acceptance.accepted === true) return { tone: 'warning', text: 'Marked accepted, but not every required check rests on a verifier receipt' };
  const compromised = requirements.some((requirement) => requirement.tone === 'compromised');
  return { tone: compromised ? 'compromised' : 'failed', text: compromised ? 'Not accepted · a criterion is compromised' : `Not accepted · ${acceptance.requiredPassed ?? 0} of ${acceptance.requiredTotal ?? 0} required checks passed` };
}

/** Diff lines with a kind for colouring. The text itself is rendered escaped. */
export function diffLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => ({
      text: line,
      kind: line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context',
    }));
}

// ---------------------------------------------------------------------------
// Runtimes (passive discovery)
// ---------------------------------------------------------------------------

/** What passive discovery says about one runtime, in words. Never "connected": discovery does not open a session. */
export function runtimeStatus(report) {
  if (!report) return { tone: 'warning', label: 'Not reported', detail: 'passive discovery returned no report for this runtime' };
  if (!report.installed) return { tone: 'failed', label: 'Not installed', detail: report.authDetail ?? 'no executable was found' };
  if (report.auth === 'logged_out') return { tone: 'failed', label: 'Signed out', detail: report.loginHint ? `sign in with: ${report.loginHint}` : report.authDetail };
  if (!report.adapterSupported) return { tone: 'warning', label: 'Unsupported version', detail: report.diagnostics?.[0] ?? `version ${report.version ?? 'unknown'} is not supported by the adapter` };
  if (!report.controllable) return { tone: 'warning', label: 'Not controllable', detail: report.diagnostics?.[0] ?? 'the adapter cannot drive this build' };
  if (report.auth === 'logged_in') return { tone: 'ready', label: 'Signed in', detail: report.authDetail };
  return { tone: 'warning', label: 'Sign-in unknown', detail: report.authDetail };
}

export const ADAPTER_NAMES = { codex: 'Codex CLI', 'claude-code': 'Claude Code', fake: 'Fake test runtime' };

// ---------------------------------------------------------------------------
// Events (GET /api/events)
// ---------------------------------------------------------------------------

export const clip = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * A short line for an event. Runtime text is quoted as the runtime's own
 * words and never turned into a verdict; only verifier and coordinator records
 * say "accepted".
 */
export function describeEvent(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  switch (event?.type) {
    case 'run.created':
      return 'Coordinator recorded the run';
    case 'workspace.created':
      return 'Candidate workspace created';
    case 'session.opened':
    case 'runtime.session_started':
      return 'Runtime session opened';
    case 'runtime.turn_started':
    case 'turn.started':
      return 'Runtime turn started';
    case 'runtime.turn_completed':
      return 'Runtime turn ended (the runtime’s account, not a verdict)';
    case 'runtime.assistant_message':
      return payload.text ? `Runtime says: “${clip(payload.text)}”` : 'Runtime message';
    case 'runtime.command_exec':
      return payload.phase === 'completed' ? `Command finished${typeof payload.exitCode === 'number' ? ` (exit ${payload.exitCode})` : ''}` : `Runtime ran: ${clip(payload.command, 80)}`;
    case 'runtime.file_change':
      return `File ${payload.phase === 'completed' ? 'changed' : 'change started'}: ${clip(payload.path, 80)}${payload.withinAllowedPaths === false ? ' (outside granted paths)' : ''}`;
    case 'runtime.stopped':
      return 'Runtime process stopped';
    case 'candidate.snapshot':
      return 'Candidate frozen for verification';
    case 'checks.planned':
      return 'Verifier planned the acceptance checks';
    case 'check.completed':
      return `Verifier check ${clip(payload.criterionId, 60)}: ${clip(payload.outcome, 20)}`;
    case 'task.settled':
      return payload.accepted === true ? 'Verifier accepted the task' : 'Task settled without acceptance';
    case 'run.accepted':
      return 'Verifier accepted the candidate';
    case 'run.failed':
      return 'Run failed';
    case 'run.interrupted':
      return 'Run interrupted';
    case 'coordination.attached':
      return 'Worker attached to the coordinator bridge';
    case 'coordination.delivered':
      return 'Coordinator delivered a message to the worker';
    case 'coordination.delivery_deferred':
      return 'Coordinator message delivery deferred';
    case 'coordination.delivery_failed':
      return 'Coordinator message delivery failed';
    default:
      return clip(event?.type ?? 'event', 60);
  }
}

/** "12s ago", from two ISO timestamps; null when either is missing. */
export function ago(timestamp, now) {
  const then = Date.parse(timestamp ?? '');
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
