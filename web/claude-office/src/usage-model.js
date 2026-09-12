// FR060: project only persisted adapter measurements. Session totals and turn
// totals have different scopes; neither may be summed with its own updates.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const identity = value => typeof value === 'string' && value.length ? value : null;
const timestamp = value => {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const parsed = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};
const terminalRequests = new Set(['ended', 'failed_to_start', 'discarded']);
const terminalRuns = new Set(['ready_for_review', 'accepted', 'failed', 'interrupted', 'cancelled', 'superseded']);

function elapsed(status, request, now) {
  const run = record(status.run);
  const candidates = [['received', request.receivedAt], ['started', request.startedAt], ['created', run.createdAt]];
  const beginning = candidates.map(([source, value]) => [source, timestamp(value)]).find(([, value]) => value !== null);
  // A resumed request can be live while an earlier run snapshot still has its
  // old endedAt. The active request owns the current interval in that case.
  const activeRequest = identity(request.state) !== null && !terminalRequests.has(request.state);
  const end = timestamp(request.endedAt) ?? (activeRequest ? null : timestamp(run.endedAt));
  const finished = end !== null || terminalRequests.has(request.state) || (!activeRequest && terminalRuns.has(run.state));
  const stop = end ?? (finished ? null : timestamp(now));
  if (!beginning || stop === null || stop < beginning[1]) return { elapsedMs: null, elapsedStatus: 'unavailable', elapsedFrom: beginning?.[0] ?? null };
  return { elapsedMs: stop - beginning[1], elapsedStatus: finished ? 'finished' : 'running', elapsedFrom: beginning[0] };
}

function sum(values, integers = false) {
  const reported = values.filter(value => value !== null);
  if (!reported.length) return null;
  const total = reported.reduce((result, value) => result + value, 0);
  return Number.isFinite(total) && (!integers || Number.isSafeInteger(total)) ? total : null;
}

/**
 * Derive a footer from the full run event cache and its status document.
 * `request` is the persisted queue item, not the user's prompt string.
 *
 * Codex: runtime.raw / thread/tokenUsage/updated -> latest total per session,
 * including across turns and process resumes. Claude Code: normalized terminal
 * payload.usage -> one result per adapter turn. Never read prose, raw Claude
 * results of unattributed turns, cached manifest snapshots, or price estimates.
 *
 * Complete means a finished run, contiguous event coverage through eventCount,
 * and measurements for every observed turn. Otherwise any measured subtotal is
 * explicitly partial. The UI must render each metric's scope with its value.
 */
export function usageSummary({ events = [], status = {}, request = {}, now = Date.now() } = {}) {
  status = record(status);
  request = record(request);
  const input = Array.isArray(events) ? events.filter(event => event && typeof event === 'object') : [];
  const ordered = [...input].sort((a, b) => (token(a.sequence) ?? Infinity) - (token(b.sequence) ?? Infinity));
  const sequences = new Set(ordered.map(event => token(event.sequence)).filter(value => value !== null && value > 0));
  const eventCount = token(status.eventCount);
  const coverageComplete = eventCount !== null && eventCount > 0 && sequences.size === eventCount
    && [...sequences].every(sequence => sequence <= eventCount);
  const sessions = new Map();
  const seenEvents = new Set();
  const expectedTurns = new Set();
  const observedTurns = new Set();
  let omitted = false;

  for (const event of ordered) {
    if (typeof event.type !== 'string') continue;
    const payload = record(event.payload);
    if (identity(event.runId) && identity(status.run?.id) && event.runId !== status.run.id) { omitted = true; continue; }
    // Coordinator dispatch receipts can establish a turn whose runtime stream
    // never arrived. Such a turn must not vanish from completeness accounting.
    if (!event.type.startsWith('runtime.')) {
      if ((event.type === 'turn.started' || event.type.endsWith('.turn_started')) && identity(payload.sessionId) && identity(payload.turnId)) {
        expectedTurns.add(JSON.stringify([payload.sessionId, payload.turnId]));
      }
      continue;
    }
    const adapter = identity(payload.adapter);
    const sessionId = identity(payload.sessionId);
    const turnId = identity(payload.turnId);
    const eventKey = token(event.sequence) ?? identity(event.id);
    if (eventKey !== null && seenEvents.has(eventKey)) continue;
    if (eventKey !== null) seenEvents.add(eventKey);
    if (!adapter || !sessionId || (identity(payload.reportedSessionId) && payload.reportedSessionId !== sessionId)) { omitted = true; continue; }
    const sessionKey = JSON.stringify([adapter, sessionId]);
    const session = sessions.get(sessionKey) || { adapter, turns: new Map(), total: null, usageTurn: null };
    sessions.set(sessionKey, session);
    if (payload.payloadTruncated || payload.reason === 'unattributed_result_record' || payload.reason === 'extra_runtime_turn_started' || payload.runtimeTurnsObserved > 1) omitted = true;
    const turnKey = turnId ? JSON.stringify([payload.spawnToken ?? null, turnId]) : null;
    let turn = null;
    if (turnKey) {
      observedTurns.add(JSON.stringify([sessionId, turnId]));
      turn = session.turns.get(turnKey) || { started: false, ended: false, usage: null };
      session.turns.set(turnKey, turn);
      if (event.type === 'runtime.turn_started') turn.started = true;
      if (event.type === 'runtime.turn_completed' || event.type === 'runtime.turn_interrupted') turn.ended = true;
    }

    if (adapter === 'codex' && event.type === 'runtime.raw' && payload.method === 'thread/tokenUsage/updated') {
      const params = record(payload.params);
      if ((identity(params.threadId) && params.threadId !== sessionId) || (identity(params.turnId) && turnId && params.turnId !== turnId)) { omitted = true; continue; }
      const total = record(record(params.tokenUsage).total);
      const inputTokens = token(total.inputTokens);
      const outputTokens = token(total.outputTokens);
      // Replace rather than add, even if the latest report corrects a counter.
      session.total = { inputTokens, outputTokens, costUsd: null };
      session.usageTurn = turnKey;
      if (!turnKey || inputTokens === null || outputTokens === null) omitted = true;
    }
    if (adapter === 'claude-code' && turn && (event.type === 'runtime.turn_completed' || event.type === 'runtime.turn_interrupted')) {
      const usage = record(payload.usage);
      turn.usage = {
        inputTokens: token(usage.inputTokens),
        outputTokens: token(usage.outputTokens),
        costUsd: usage.costStatus === 'measured' ? amount(usage.costUsd) : null,
      };
    }
  }

  const reports = [];
  let turnsComplete = sessions.size > 0;
  let reportedSessions = 0;
  for (const session of sessions.values()) {
    const turns = [...session.turns.values()];
    if (!turns.length || turns.some(turn => !turn.started || !turn.ended)) turnsComplete = false;
    if (session.adapter === 'codex') {
      reports.push(session.total || { inputTokens: null, outputTokens: null, costUsd: null });
      // The final cumulative report must belong to the last observed turn.
      if (!session.total || session.usageTurn !== [...session.turns.keys()].at(-1)) turnsComplete = false;
      if (session.total && (session.total.inputTokens !== null || session.total.outputTokens !== null)) reportedSessions += 1;
    } else if (session.adapter === 'claude-code') {
      for (const turn of turns) reports.push(turn.usage || { inputTokens: null, outputTokens: null, costUsd: null });
      if (turns.some(turn => turn.usage && (turn.usage.inputTokens !== null || turn.usage.outputTokens !== null || turn.usage.costUsd !== null))) reportedSessions += 1;
    } else {
      reports.push({ inputTokens: null, outputTokens: null, costUsd: null });
      turnsComplete = false;
    }
  }
  const timing = elapsed(status, request, now);
  const inputTokens = sum(reports.map(report => report.inputTokens), true);
  const outputTokens = sum(reports.map(report => report.outputTokens), true);
  const costUsd = sum(reports.map(report => report.costUsd));
  const complete = coverageComplete && turnsComplete && !omitted && [...expectedTurns].every(turn => observedTurns.has(turn)) && timing.elapsedStatus === 'finished';
  const tokenStatus = inputTokens !== null || outputTokens !== null ? 'measured' : 'unavailable';
  const costStatus = costUsd !== null ? 'measured' : 'unavailable';
  const tokenScope = tokenStatus === 'unavailable' ? 'unavailable' : complete && inputTokens !== null && outputTokens !== null && reports.every(report => report.inputTokens !== null && report.outputTokens !== null) ? 'complete' : 'partial';
  const costScope = costStatus === 'unavailable' ? 'unavailable' : complete && reports.every(report => report.costUsd !== null) ? 'complete' : 'partial';
  const detail = [
    'Runtime-reported input/output counters; separate cache counters are not added.',
    tokenScope === 'partial' || costScope === 'partial' ? 'Partial totals: this run is still active, event coverage is incomplete, or some runtime measurements are missing.' : '',
    costStatus === 'unavailable' ? 'Currency cost was not reported as a measurement.' : '',
    !coverageComplete ? 'Complete event coverage has not been established.' : '',
    omitted ? 'Unattributed, truncated, or unsupported records were excluded.' : '',
  ].filter(Boolean).join(' ');
  return { inputTokens, outputTokens, tokenStatus, tokenScope, costUsd, costStatus, costScope, ...timing, detail, reportedSessions };
}
