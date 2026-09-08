import { describe, expect, it } from 'vitest';
import { backoffDelayMs, classifyFailure, planRetry, type FailureClass, type ObservedFailure } from '../../src/recovery/classify.js';
import { HANDOFF_FAILURE_CLASSES } from '../../src/recovery/continue.js';

interface Case {
  readonly name: string;
  readonly observed: ObservedFailure;
  readonly expected: FailureClass;
}

const CASES: ReadonlyArray<Case> = [
  { name: 'Codex HTTP 401', observed: { adapter: 'codex', source: 'runtime', httpStatus: 401, message: 'request failed' }, expected: 'authentication' },
  { name: 'Codex unauthorized tag', observed: { adapter: 'codex', errorTag: 'unauthorized' }, expected: 'authentication' },
  { name: 'Codex usageLimitExceeded', observed: { adapter: 'codex', errorTag: 'usageLimitExceeded' }, expected: 'quota' },
  { name: 'Codex sessionBudgetExceeded', observed: { adapter: 'codex', errorTag: 'sessionBudgetExceeded' }, expected: 'quota' },
  { name: 'Codex serverOverloaded', observed: { adapter: 'codex', errorTag: 'serverOverloaded' }, expected: 'provider_transient' },
  { name: 'Codex sandboxError', observed: { adapter: 'codex', errorTag: 'sandboxError' }, expected: 'permission' },
  { name: 'Codex badRequest', observed: { adapter: 'codex', errorTag: 'badRequest' }, expected: 'protocol' },
  {
    name: 'Claude Code OAuth session expired',
    observed: { adapter: 'claude-code', source: 'runtime', isError: true, message: 'OAuth session expired and could not be refreshed' },
    expected: 'authentication',
  },
  { name: 'Claude Code authentication_failed', observed: { adapter: 'claude-code', errorTag: 'authentication_failed' }, expected: 'authentication' },
  { name: 'Claude Code rate_limit_error', observed: { adapter: 'claude-code', errorTag: 'rate_limit_error' }, expected: 'quota' },
  { name: 'Claude Code error_max_budget', observed: { adapter: 'claude-code', subtype: 'error_max_budget', isError: true }, expected: 'quota' },
  { name: 'Claude Code unexplained is_error', observed: { adapter: 'claude-code', isError: true, message: 'something went wrong' }, expected: 'unknown' },
  { name: 'ECONNRESET', observed: { source: 'transport', code: 'ECONNRESET' }, expected: 'provider_transient' },
  { name: 'ETIMEDOUT', observed: { source: 'transport', code: 'ETIMEDOUT' }, expected: 'provider_transient' },
  { name: 'ECONNRESET named in a message', observed: { source: 'runtime', message: 'stream closed: read ECONNRESET' }, expected: 'provider_transient' },
  { name: 'HTTP 503', observed: { httpStatus: 503 }, expected: 'provider_transient' },
  { name: 'HTTP 429', observed: { httpStatus: 429 }, expected: 'quota' },
  { name: 'HTTP 403', observed: { httpStatus: 403 }, expected: 'permission' },
  { name: 'EACCES', observed: { source: 'tool', code: 'EACCES' }, expected: 'permission' },
  { name: 'non-zero tool exit', observed: { source: 'tool', exitCode: 1 }, expected: 'code_failure' },
  { name: 'non-zero check exit', observed: { source: 'check', exitCode: 2 }, expected: 'code_failure' },
  { name: 'non-zero runtime exit with no explanation', observed: { source: 'runtime', adapter: 'codex', exitCode: 9 }, expected: 'unknown' },
  { name: 'nothing observed at all', observed: {}, expected: 'unknown' },
];

describe('FR053: error classification', () => {
  for (const testCase of CASES) {
    it(`maps ${testCase.name} to ${testCase.expected}`, () => {
      const result = classifyFailure(testCase.observed);
      expect(result.failureClass).toBe(testCase.expected);
      expect(result.signal.length).toBeGreaterThan(0);
    });
  }

  it('marks only provider_transient as retryable', () => {
    for (const testCase of CASES) {
      const result = classifyFailure(testCase.observed);
      expect(result.retryable).toBe(result.failureClass === 'provider_transient');
    }
  });

  it('surfaces a specific account action for authentication and quota, and never retries them', () => {
    const auth = classifyFailure({ adapter: 'claude-code', message: 'OAuth session expired and could not be refreshed' });
    expect(auth.userAction).toMatch(/re-authenticate/);
    expect(planRetry(auth, 0, { maxTransientRetries: 5 }).retry).toBe(false);

    const quota = classifyFailure({ adapter: 'codex', errorTag: 'usageLimitExceeded' });
    expect(quota.userAction).toMatch(/limit/);
    const decision = planRetry(quota, 0, { maxTransientRetries: 5 });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/quota is never retried/);
  });

  it('leaves an unrecognised failure unknown rather than guessing it into a retryable class', () => {
    const result = classifyFailure({ adapter: 'codex', errorTag: 'somethingBrandNew', message: 'the runtime said a new thing' });
    expect(result.failureClass).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(planRetry(result, 0, { maxTransientRetries: 3 }).retry).toBe(false);
  });
});

describe('FR053: bounded backoff and a retry budget', () => {
  it('retries transient failures until the budget is spent', () => {
    const transient = classifyFailure({ code: 'ECONNRESET' });
    const budget = { maxTransientRetries: 2 };
    expect(planRetry(transient, 0, budget)).toMatchObject({ retry: true, remaining: 2 });
    expect(planRetry(transient, 1, budget)).toMatchObject({ retry: true, remaining: 1 });
    const spent = planRetry(transient, 2, budget);
    expect(spent.retry).toBe(false);
    expect(spent.reason).toMatch(/budget of 2 is exhausted/);
  });

  it('backs off exponentially but never past the ceiling', () => {
    const budget = { maxTransientRetries: 10, baseDelayMs: 100, maxDelayMs: 500 };
    expect(backoffDelayMs(0, budget)).toBe(100);
    expect(backoffDelayMs(1, budget)).toBe(200);
    expect(backoffDelayMs(2, budget)).toBe(400);
    expect(backoffDelayMs(3, budget)).toBe(500);
    expect(backoffDelayMs(20, budget)).toBe(500);
  });

  it('a zero budget disables retrying entirely', () => {
    expect(planRetry({ code: 'ETIMEDOUT' }, 0, { maxTransientRetries: 0 }).retry).toBe(false);
  });
});

/**
 * The signals the two installed runtimes really emit, mapped by the rules and
 * not by the prose around them.
 *
 * Each row names a signal that reaches the classifier from a real adapter
 * payload: Codex writes `errorClass` (its `CodexErrorClass`) and reports
 * transport failures with the HTTP status in the message; Claude Code writes
 * `runtimeError` (the CLI's own `error` value), `subtype` and `terminalReason`.
 * `signal` is asserted too, because a row that reached the right class through
 * a message rule has not proved the machine-readable rule is live.
 */
describe('FR053: the machine-readable signals of the installed runtimes', () => {
  interface SignalCase {
    readonly name: string;
    readonly observed: ObservedFailure;
    readonly expected: FailureClass;
    readonly signal: string;
  }

  const SIGNALS: ReadonlyArray<SignalCase> = [
    // --- Codex 0.147.0 -----------------------------------------------------
    { name: 'codex HTTP 401', observed: { source: 'runtime', adapter: 'codex', httpStatus: 401 }, expected: 'authentication', signal: 'HTTP 401' },
    { name: 'codex unauthorized tag', observed: { source: 'runtime', adapter: 'codex', errorTag: 'unauthorized' }, expected: 'authentication', signal: 'runtime tag "unauthorized"' },
    { name: 'codex usageLimitExceeded', observed: { source: 'runtime', adapter: 'codex', errorTag: 'usageLimitExceeded' }, expected: 'quota', signal: 'runtime tag "usageLimitExceeded"' },
    {
      name: 'codex usage_limit (the class its own adapter records)',
      observed: { source: 'runtime', adapter: 'codex', errorTag: 'usage_limit' },
      expected: 'quota',
      signal: 'runtime tag "usage_limit"',
    },
    {
      name: 'codex badRequest / invalid_request',
      observed: { source: 'runtime', adapter: 'codex', errorTag: 'badRequest' },
      expected: 'protocol',
      signal: 'runtime tag "badRequest"',
    },
    {
      name: 'codex request_rejected (the class its own adapter records for a rejected request)',
      observed: { source: 'runtime', adapter: 'codex', errorTag: 'request_rejected' },
      expected: 'protocol',
      signal: 'runtime tag "request_rejected"',
    },
    { name: 'codex HTTP 400', observed: { source: 'runtime', adapter: 'codex', httpStatus: 400 }, expected: 'protocol', signal: 'HTTP 400' },
    { name: 'codex HTTP 500', observed: { source: 'runtime', adapter: 'codex', httpStatus: 500 }, expected: 'provider_transient', signal: 'HTTP 500' },
    { name: 'codex HTTP 503', observed: { source: 'runtime', adapter: 'codex', httpStatus: 503 }, expected: 'provider_transient', signal: 'HTTP 503' },
    {
      name: 'codex internalServerError',
      observed: { source: 'runtime', adapter: 'codex', errorTag: 'internalServerError' },
      expected: 'provider_transient',
      signal: 'runtime tag "internalServerError"',
    },
    { name: 'codex sandboxError', observed: { source: 'runtime', adapter: 'codex', errorTag: 'sandboxError' }, expected: 'permission', signal: 'runtime tag "sandboxError"' },
    // --- Claude Code 2.1.260 ----------------------------------------------
    {
      name: 'claude-code authentication_failed',
      observed: { source: 'runtime', adapter: 'claude-code', errorTag: 'authentication_failed', isError: true },
      expected: 'authentication',
      signal: 'runtime tag "authentication_failed"',
    },
    {
      name: 'claude-code error_max_budget',
      observed: { source: 'runtime', adapter: 'claude-code', subtype: 'error_max_budget', terminalReason: 'max_budget', isError: true },
      expected: 'quota',
      signal: 'subtype "error_max_budget"',
    },
    {
      name: 'claude-code budget_exhausted (the class its own adapter records)',
      observed: { source: 'runtime', adapter: 'claude-code', errorTag: 'budget_exhausted', isError: true },
      expected: 'quota',
      signal: 'runtime tag "budget_exhausted"',
    },
    {
      name: 'claude-code permission_denied',
      observed: { source: 'runtime', adapter: 'claude-code', errorTag: 'permission_denied' },
      expected: 'permission',
      signal: 'runtime tag "permission_denied"',
    },
    // --- Node/OS level -----------------------------------------------------
    { name: 'ECONNRESET on the socket', observed: { source: 'transport', adapter: 'codex', code: 'ECONNRESET' }, expected: 'provider_transient', signal: 'ECONNRESET' },
    { name: 'ETIMEDOUT on the socket', observed: { source: 'transport', adapter: 'codex', code: 'ETIMEDOUT' }, expected: 'provider_transient', signal: 'ETIMEDOUT' },
  ];

  for (const testCase of SIGNALS) {
    it(`maps ${testCase.name} to ${testCase.expected} on the signal it names`, () => {
      const result = classifyFailure(testCase.observed);
      expect(result.failureClass).toBe(testCase.expected);
      expect(result.signal).toBe(testCase.signal);
    });
  }

  it('leaves a signal neither adapter recognised unknown, even alongside an is_error and a message', () => {
    // `unknown` is what an adapter writes when IT could not classify the
    // failure. Mapping it to anything here would be guessing on its behalf.
    for (const errorTag of ['unknown', 'somethingBrandNew']) {
      const result = classifyFailure({ source: 'runtime', adapter: 'codex', errorTag, isError: true, message: 'the runtime said a new thing' });
      expect(result.failureClass, errorTag).toBe('unknown');
      expect(result.retryable, errorTag).toBe(false);
    }
  });

  it('treats a rejected request as terminal for the task and as no reason to change runtime', () => {
    // A second runtime would send the same rejected request, so this class is
    // neither retried nor handed off.
    for (const observed of [
      { source: 'runtime' as const, adapter: 'codex', errorTag: 'request_rejected' },
      { source: 'runtime' as const, adapter: 'codex', httpStatus: 400 },
      { source: 'runtime' as const, adapter: 'claude-code', errorTag: 'invalid_request' },
    ]) {
      const result = classifyFailure(observed);
      expect(result.retryable).toBe(false);
      expect(planRetry(result, 0, { maxTransientRetries: 5 }).retry).toBe(false);
      expect(HANDOFF_FAILURE_CLASSES.has(result.failureClass)).toBe(false);
    }
  });

  it('makes the classes a second runtime could get past handoff classes', () => {
    // The point of classifying at all: authentication and quota failures are
    // exactly the ones a configured fallback runtime can get past (AT04).
    for (const observed of [
      { source: 'runtime' as const, adapter: 'codex', httpStatus: 401 },
      { source: 'runtime' as const, adapter: 'codex', errorTag: 'usageLimitExceeded' },
      { source: 'runtime' as const, adapter: 'claude-code', errorTag: 'authentication_failed' },
      { source: 'runtime' as const, adapter: 'claude-code', subtype: 'error_max_budget' },
      { source: 'runtime' as const, adapter: 'codex', httpStatus: 503 },
    ]) {
      expect(HANDOFF_FAILURE_CLASSES.has(classifyFailure(observed).failureClass)).toBe(true);
    }
  });
});
