import { describe, expect, it } from 'vitest';
import { usageSummary } from '../../web/claude-office/src/usage-model.js';

const receivedAt = '2026-09-12T10:00:00Z';
const startedAt = '2026-09-12T10:00:05Z';
const endedAt = '2026-09-12T10:01:00Z';
const request = { receivedAt, startedAt, endedAt, state: 'ended' };
function log() {
  const events = [];
  const add = (type, payload, taskId = null) => events.push({ sequence: events.length + 1, timestamp: startedAt, type, payload, taskId });
  return { events, add, summary: extra => usageSummary({ events, status: { eventCount: events.length }, request, ...extra }) };
}
const codex = (sessionId = 'head', turnId = 'turn-1', spawnToken = 'process-1') => ({ adapter: 'codex', sessionId, turnId, spawnToken });
const claude = (turnId = 'turn-1', sessionId = 'worker') => ({ adapter: 'claude-code', sessionId, turnId, spawnToken: 'claude-process' });
const totals = (inputTokens, outputTokens) => ({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens, outputTokens } } } });
const usage = (inputTokens, outputTokens, costUsd = null, costStatus = 'unavailable') => ({ usage: { inputTokens, outputTokens, costUsd, costStatus } });

describe('truthful runtime usage footer', () => {
  it('keeps missing measurements null, even on a finished request', () => {
    expect(usageSummary({ request })).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null, tokenStatus: 'unavailable', costStatus: 'unavailable', tokenScope: 'unavailable', elapsedMs: 60000, elapsedStatus: 'finished' });
    expect(usageSummary()).toMatchObject({ elapsedMs: null, elapsedStatus: 'unavailable' });
  });

  it('uses the latest Codex session total across turns and resumes without double counting head activity', () => {
    const { add, summary, events } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), ...totals(100, 10) });
    add('runtime.raw', { ...codex(), ...totals(180, 20) });
    add('runtime.turn_completed', codex());
    add('runtime.turn_started', codex('head', 'turn-2', 'process-2'));
    add('runtime.raw', { ...codex('head', 'turn-2', 'process-2'), ...totals(250, 30) });
    add('runtime.turn_completed', codex('head', 'turn-2', 'process-2'));
    const result = summary({ events: [...events].reverse().concat(events[5]) });
    expect(result).toMatchObject({ inputTokens: 250, outputTokens: 30, tokenStatus: 'measured', tokenScope: 'complete', costUsd: null, costStatus: 'unavailable', reportedSessions: 1 });
  });

  it('sums distinct runtime sessions and marks mixed-provider currency as a partial subtotal', () => {
    const { add, summary } = log();
    add('runtime.turn_started', codex('classifier'));
    add('runtime.raw', { ...codex('classifier'), ...totals(200, 20) });
    add('runtime.turn_completed', codex('classifier'));
    add('runtime.turn_started', claude(), 'worker-task');
    add('runtime.turn_completed', { ...claude(), ...usage(30, 5, 0.04, 'measured') }, 'worker-task');
    expect(summary()).toMatchObject({ inputTokens: 230, outputTokens: 25, tokenScope: 'complete', costUsd: 0.04, costStatus: 'measured', costScope: 'partial', reportedSessions: 2 });
  });

  it('counts each Claude terminal result once and retains measured zero currency', () => {
    const { add, summary } = log();
    add('runtime.turn_started', claude());
    add('runtime.turn_completed', { ...claude(), ...usage(3, 5, 0, 'measured') });
    add('runtime.turn_completed', { ...claude(), ...usage(3, 5, 0, 'measured') });
    add('runtime.turn_started', claude('turn-2'));
    add('runtime.turn_interrupted', { ...claude('turn-2'), ...usage(7, 8, 0.03, 'measured') });
    expect(summary()).toMatchObject({ inputTokens: 10, outputTokens: 13, costUsd: 0.03, costScope: 'complete' });
  });

  it('never turns an unavailable reported zero or an estimated price into measured cost', () => {
    const { add, summary } = log();
    add('runtime.turn_started', claude());
    add('runtime.turn_completed', { ...claude(), ...usage(0, 0, 0, 'unavailable') });
    add('runtime.turn_started', claude('turn-2'));
    add('runtime.turn_completed', { ...claude('turn-2'), ...usage(4, 8, 0.2, 'estimated') });
    expect(summary()).toMatchObject({ costUsd: null, costStatus: 'unavailable', tokenScope: 'complete' });
  });

  it('preserves reported partial counters without replacing unavailable values with zero', () => {
    const { add, summary } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), ...totals(125, undefined) });
    add('runtime.turn_completed', codex());
    expect(summary()).toMatchObject({ inputTokens: 125, outputTokens: null, tokenScope: 'partial' });
  });

  it('marks missing event pages, active turns, and a session without measurements as partial', () => {
    const { add, summary, events } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), ...totals(100, 10) });
    expect(summary({ request: { receivedAt, state: 'running' }, now: Date.parse(endedAt) })).toMatchObject({ tokenScope: 'partial', elapsedMs: 60000, elapsedStatus: 'running' });
    add('runtime.turn_completed', codex());
    expect(summary({ status: { eventCount: 10 } }).tokenScope).toBe('partial');
    expect(summary({ events: events.slice(1) }).tokenScope).toBe('partial');
    add('runtime.turn_started', claude());
    add('runtime.turn_completed', claude());
    expect(summary()).toMatchObject({ inputTokens: 100, outputTokens: 10, tokenScope: 'partial' });
  });

  it('rejects foreign and malformed measurements and ignores prose, arbitrary usage events, and manifests', () => {
    const { add, summary } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), method: 'thread/tokenUsage/updated', params: { threadId: 'foreign', tokenUsage: { total: { inputTokens: 900, outputTokens: 99 } } } });
    add('runtime.usage', { ...codex(), inputTokens: 1000, outputTokens: 100 });
    add('runtime.assistant_message', { ...codex(), text: 'Cost: $0.01, tokens: 200' });
    add('runtime.raw', { ...codex(), ...totals(-1, '8') });
    add('runtime.turn_completed', codex());
    add('runtime.turn_completed', { ...claude(), reportedSessionId: 'foreign', ...usage(80, 10, 2, 'measured') });
    expect(summary({ status: { usage: { inputTokens: 999, costUsd: 0 } } })).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('does not claim complete totals when the runtime observed unassigned extra turns', () => {
    const { add, summary } = log();
    add('runtime.turn_started', claude());
    add('runtime.raw', { ...claude(), turnId: null, reason: 'unattributed_result_record', record: { total_cost_usd: 30, usage: { input_tokens: 99999 } } });
    add('runtime.turn_completed', { ...claude(), runtimeTurnsObserved: 2, ...usage(10, 20, 0.1, 'measured') });
    expect(summary()).toMatchObject({ inputTokens: 10, outputTokens: 20, tokenScope: 'partial', costUsd: 0.1, costScope: 'partial' });
  });

  it('accounts for coordinator-started turns even when their runtime records never arrived', () => {
    const { add, summary } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), ...totals(20, 3) });
    add('runtime.turn_completed', codex());
    add('head.turn_started', { sessionId: 'missing-head', turnId: 'head-turn' });
    expect(summary()).toMatchObject({ inputTokens: 20, outputTokens: 3, tokenScope: 'partial' });
  });

  it('refuses unsafe integer totals instead of rounding token counts', () => {
    const { add, summary } = log();
    for (const id of ['first', 'second']) {
      add('runtime.turn_started', codex(id));
      add('runtime.raw', { ...codex(id), ...totals(Number.MAX_SAFE_INTEGER, 1) });
      add('runtime.turn_completed', codex(id));
    }
    expect(summary()).toMatchObject({ inputTokens: null, outputTokens: 2, tokenScope: 'partial' });
  });

  it('requires a final Codex report for the last turn and accepts downward corrections literally', () => {
    const { add, summary } = log();
    add('runtime.turn_started', codex());
    add('runtime.raw', { ...codex(), ...totals(200, 20) });
    add('runtime.raw', { ...codex(), ...totals(180, 18) });
    add('runtime.turn_completed', codex());
    expect(summary()).toMatchObject({ inputTokens: 180, outputTokens: 18, tokenScope: 'complete' });
    add('runtime.turn_started', codex('head', 'turn-2'));
    add('runtime.turn_completed', codex('head', 'turn-2'));
    expect(summary().tokenScope).toBe('partial');
  });

  it('uses persisted wall-clock boundaries and never invents a finish from updatedAt', () => {
    expect(usageSummary({ request: { startedAt, endedAt, state: 'ended' } })).toMatchObject({ elapsedMs: 55000, elapsedFrom: 'started' });
    expect(usageSummary({ status: { run: { createdAt: receivedAt, endedAt, state: 'ready_for_review' } } })).toMatchObject({ elapsedMs: 60000, elapsedFrom: 'created', elapsedStatus: 'finished' });
    expect(usageSummary({ request: { receivedAt, state: 'ended' }, status: { run: { updatedAt: endedAt } } })).toMatchObject({ elapsedMs: null, elapsedStatus: 'unavailable' });
    expect(usageSummary({ request: { receivedAt: endedAt, endedAt: receivedAt, state: 'ended' } }).elapsedMs).toBeNull();
    expect(usageSummary({ request: { receivedAt: 'invalid', startedAt, state: 'running' }, now: endedAt }).elapsedMs).toBe(55000);
  });

  it('keeps a live resumed request ticking past the stale prior end timestamp', () => {
    expect(usageSummary({ request: { receivedAt: endedAt, state: 'running' }, status: { run: { createdAt: receivedAt, endedAt, state: 'interrupted' } }, now: Date.parse(endedAt) + 15000 })).toMatchObject({ elapsedMs: 15000, elapsedStatus: 'running', elapsedFrom: 'received' });
  });
});
