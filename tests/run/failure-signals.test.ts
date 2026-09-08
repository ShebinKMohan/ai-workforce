/**
 * The seam between what an adapter observed and how the failure is classified
 * (FR053, and the reason AT04 was unreachable).
 *
 * `runDirect` used to hand the classifier three things: a source, an adapter id
 * and one sentence. Every machine-readable rule in `classifyFailure` — the tag
 * table, the HTTP-status rules, the errno rules, the Claude Code subtype rule —
 * was therefore dead on the run path, and a real Codex transport failure came
 * out `unknown`, which is neither retryable nor a handoff class, so no fallback
 * runtime was ever selected.
 *
 * The payloads below are the shapes the two installed adapters really write;
 * the Codex and Claude Code ones are copied from recorded evidence under
 * docs/evidence/at03 and fixtures/claude-code/session-auth-failure.real.json.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeEvent } from '../../src/adapters/types.js';
import { observeRuntimeFailure, structuredFailureSignals } from '../../src/core/run-direct.js';
import { classifyFailure } from '../../src/recovery/classify.js';
import { HANDOFF_FAILURE_CLASSES } from '../../src/recovery/continue.js';

let sequence = 0;

function event(kind: RuntimeEvent['kind'], adapter: RuntimeEvent['adapter'], payload: Record<string, unknown>): RuntimeEvent {
  sequence += 1;
  return {
    kind,
    adapter,
    sessionId: 'session-1',
    turnId: 'turn-1',
    spawnToken: 'token-1',
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    payload,
    rawRef: `${adapter}:session-1:${sequence}`,
  };
}

/** The Codex 401 recorded in docs/evidence/at03/2026-09-07-codex-signed-out/events-codex.jsonl. */
const CODEX_401_MESSAGE =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a377294a3e16184f-MAA, request id: req_7d43876fc44f4802b23b8f03f59dd6a0';

describe('the adapter-known failure signals reach the classifier', () => {
  it('carries the Codex error tag through, so a tagged failure is classified by the tag', () => {
    const events = [
      event('error', 'codex', { fatal: false, message: 'stream error', errorClass: 'usage_limit', willRetry: false }),
      event('turn_completed', 'codex', { status: 'failed', durationMs: 1200, error: 'stream error', errorClass: 'usage_limit', evidence: 'runtime_reported' }),
    ];

    const observed = observeRuntimeFailure({ adapter: 'codex', events, turnFailure: 'status "failed", error class "usage_limit"', runtimeExited: false });
    expect(observed.errorTag).toBe('usage_limit');

    const failure = classifyFailure(observed);
    expect(failure.failureClass).toBe('quota');
    expect(failure.signal).toBe('runtime tag "usage_limit"');
    expect(failure.retryable).toBe(false);
    expect(failure.userAction).not.toBeNull();
  });

  it('reads the HTTP status Codex states in its own transport error instead of leaving it unclassified', () => {
    // This is the exact failure that was classified `unknown` in the R1 record:
    // codexErrorInfo was absent, so the adapter's class is `unknown` and the
    // status is in the runtime's own error text and nowhere else.
    const events = [
      event('error', 'codex', { fatal: false, message: CODEX_401_MESSAGE, errorClass: 'unknown', willRetry: false }),
      event('turn_completed', 'codex', { status: 'failed', durationMs: 26193, error: CODEX_401_MESSAGE, errorClass: 'unknown', evidence: 'runtime_reported' }),
    ];

    const observed = observeRuntimeFailure({
      adapter: 'codex',
      events,
      turnFailure: `status "failed", error class "unknown", error "${CODEX_401_MESSAGE}"`,
      runtimeExited: false,
    });
    // `unknown` is not carried as a tag: the adapter did not classify it, so
    // nothing here classifies it on the adapter's behalf.
    expect(observed.errorTag).toBeUndefined();
    expect(observed.httpStatus).toBe(401);

    const failure = classifyFailure(observed);
    expect(failure.failureClass).toBe('authentication');
    expect(failure.signal).toBe('HTTP 401');
    // ...which is what makes a configured fallback runtime reachable at all.
    expect(HANDOFF_FAILURE_CLASSES.has(failure.failureClass)).toBe(true);
  });

  it('maps a Codex 5xx to provider_transient and a Codex 400 to a rejected request', () => {
    const transient = classifyFailure(
      observeRuntimeFailure({
        adapter: 'codex',
        events: [event('turn_completed', 'codex', { status: 'failed', error: 'unexpected status 503 Service Unavailable', errorClass: 'unknown' })],
        turnFailure: 'status "failed"',
        runtimeExited: false,
      }),
    );
    expect(transient.failureClass).toBe('provider_transient');
    expect(transient.retryable).toBe(true);

    const rejected = classifyFailure(
      observeRuntimeFailure({
        adapter: 'codex',
        events: [event('turn_completed', 'codex', { status: 'failed', error: 'unexpected status 400 Bad Request: unsupported model', errorClass: 'request_rejected' })],
        turnFailure: 'status "failed"',
        runtimeExited: false,
      }),
    );
    expect(rejected.failureClass).toBe('protocol');
    expect(rejected.retryable).toBe(false);
    // A second runtime would send the same rejected request.
    expect(HANDOFF_FAILURE_CLASSES.has(rejected.failureClass)).toBe(false);
  });

  it('carries the Claude Code error value, subtype and terminal reason through', () => {
    // The shapes the Claude Code adapter writes: the raw `error` value on the
    // api-error record, and subtype/terminal_reason on the result record.
    const events = [
      event('error', 'claude-code', {
        fatal: false,
        message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        errorClass: 'authentication',
        runtimeError: 'authentication_failed',
        willRetry: false,
      }),
      event('turn_completed', 'claude-code', { subtype: 'success', isError: true, terminalReason: 'api_error', errorClass: 'authentication' }),
    ];

    const observed = observeRuntimeFailure({ adapter: 'claude-code', events, turnFailure: 'is_error true', runtimeExited: false });
    expect(observed.errorTag).toBe('authentication_failed');
    expect(observed.terminalReason).toBe('api_error');
    expect(observed.isError).toBe(true);
    expect(classifyFailure(observed).failureClass).toBe('authentication');
  });

  it('classifies an exhausted Claude Code budget from its subtype, not from its wording', () => {
    const events = [event('turn_completed', 'claude-code', { subtype: 'error_max_budget', isError: true, terminalReason: 'max_budget', errorClass: 'budget_exhausted' })];

    const observed = observeRuntimeFailure({ adapter: 'claude-code', events, turnFailure: 'subtype "error_max_budget"', runtimeExited: false });
    expect(observed.subtype).toBe('error_max_budget');

    const failure = classifyFailure(observed);
    expect(failure.failureClass).toBe('quota');
    expect(failure.retryable).toBe(false);
  });

  it('carries an errno and an exit code, and refuses a free-form code that only looks like one', () => {
    const transport = observeRuntimeFailure({
      adapter: 'fake',
      events: [event('error', 'fake', { fatal: true, reason: 'transport', code: 'ECONNRESET', exitCode: null, signal: null })],
      turnFailure: null,
      runtimeExited: true,
    });
    expect(transport.code).toBe('ECONNRESET');
    expect(classifyFailure(transport).failureClass).toBe('provider_transient');

    // The fake runtime writes `code: "delete_failed"` on ordinary tool errors;
    // reading that as a libuv code would invent a class for it.
    const notAnErrno = observeRuntimeFailure({
      adapter: 'fake',
      events: [
        event('error', 'fake', { fatal: false, code: 'delete_failed', path: '/tmp/x', detail: 'ENOENT' }),
        event('error', 'fake', { fatal: true, reason: 'process_exited', exitCode: 3, signal: null }),
      ],
      turnFailure: null,
      runtimeExited: true,
    });
    expect(notAnErrno.code).toBeUndefined();
    expect(notAnErrno.exitCode).toBe(3);
    expect(classifyFailure(notAnErrno).failureClass).toBe('unknown');
    expect(classifyFailure(notAnErrno).signal).toBe('exit 3');
  });

  it('leaves a failure no signal identifies unknown rather than guessing', () => {
    const observed = observeRuntimeFailure({
      adapter: 'codex',
      events: [event('turn_completed', 'codex', { status: 'failed', error: 'something the build has never seen', errorClass: 'unknown' })],
      turnFailure: 'status "failed", error "something the build has never seen"',
      runtimeExited: false,
    });
    const failure = classifyFailure(observed);
    expect(failure.failureClass).toBe('unknown');
    expect(failure.retryable).toBe(false);
  });
});

describe('a runtime that exited does not erase what it said about the turn', () => {
  it('keeps both the runtime-reported turn failure and the process-exit fact', () => {
    // The defect: two object spreads both wrote `message`, so the exit sentence
    // replaced the runtime's own report of why the turn failed, and everything
    // downstream classified and reported the weaker of the two facts.
    const events = [
      event('turn_completed', 'claude-code', { subtype: 'error_max_budget', isError: true, terminalReason: 'max_budget', errorClass: 'budget_exhausted' }),
      event('error', 'claude-code', { fatal: true, reason: 'process_exited', exitCode: 143, signal: 'SIGTERM' }),
    ];

    const observed = observeRuntimeFailure({
      adapter: 'claude-code',
      events,
      turnFailure: 'subtype "error_max_budget", terminal reason "max_budget"',
      runtimeExited: true,
    });

    expect(observed.message).toContain('error_max_budget');
    expect(observed.message).toContain('the runtime process ended before the turn completed');
    // Both structured facts survive beside the prose.
    expect(observed.subtype).toBe('error_max_budget');
    expect(observed.exitCode).toBe(143);
    expect(observed.signal).toBe('SIGTERM');
    // The specific reason still decides the class; the exit does not bury it.
    expect(classifyFailure(observed).failureClass).toBe('quota');
  });

  it('reports the exit on its own when the runtime said nothing about the turn', () => {
    const observed = observeRuntimeFailure({
      adapter: 'fake',
      events: [event('error', 'fake', { fatal: true, reason: 'process_exited', exitCode: 3, signal: null })],
      turnFailure: null,
      runtimeExited: true,
    });
    expect(observed.message).toBe('the runtime process ended before the turn completed (reason process_exited, exit 3)');
  });
});

describe('structuredFailureSignals reads only what an adapter wrote', () => {
  it('finds nothing in a clean turn', () => {
    expect(structuredFailureSignals([event('turn_completed', 'fake', { status: 'completed', stepsExecuted: 3 })])).toEqual({
      errorTag: null,
      httpStatus: null,
      subtype: null,
      terminalReason: null,
      code: null,
      exitCode: null,
      signal: null,
      isError: null,
    });
  });

  it('prefers the raw runtime tag over the coarse class the adapter derived from it', () => {
    const signals = structuredFailureSignals([
      event('turn_completed', 'claude-code', { errorClass: 'usage_limit', runtimeError: 'rate_limit_error', isError: true }),
    ]);
    expect(signals.errorTag).toBe('rate_limit_error');
  });
});
