import { describe, expect, it } from 'vitest';
import { backoffDelayMs, classifyFailure, planRetry, type FailureClass, type ObservedFailure } from '../../src/recovery/classify.js';

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
