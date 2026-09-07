/**
 * Failure classification and the retry policy that hangs off it (FR053).
 *
 * The rule the whole module exists to enforce: **only `provider_transient`
 * retries**. Authentication and quota failures never retry — retrying them
 * burns a credential or a budget the user has to fix themselves, so they
 * surface the specific account action instead. Anything the observed signals
 * do not actually identify stays `unknown`, which is not retryable: guessing
 * an unrecognised failure into a retryable class is how a coordinator turns
 * one broken request into ten.
 *
 * Signals are the ones the two installed runtimes really emit (Codex 0.147.0,
 * Claude Code 2.1.260), plus the node/OS level ones the coordinator sees on
 * its own sockets and child processes.
 */

export const FAILURE_CLASSES = [
  'code_failure',
  'provider_transient',
  'authentication',
  'quota',
  'permission',
  'protocol',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * What was observed, in whatever combination the caller has. Every field is
 * optional: an adapter that only has a message passes only a message, and a
 * check runner that only has an exit code passes only that.
 */
export interface ObservedFailure {
  /** Where the failure was observed. `tool` and `check` exits are the task's own code failing. */
  readonly source?: 'runtime' | 'tool' | 'check' | 'coordinator' | 'transport';
  readonly adapter?: string;
  readonly message?: string | null;
  /** Node/libuv error code (`ECONNRESET`, `ETIMEDOUT`, `EACCES`, ...). */
  readonly code?: string | null;
  readonly httpStatus?: number | null;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** Machine-readable runtime tag: Codex `codexErrorInfo`, Claude Code `error`. */
  readonly errorTag?: string | null;
  /** Claude Code `subtype` on a result record. */
  readonly subtype?: string | null;
  /** Claude Code `terminal_reason`. */
  readonly terminalReason?: string | null;
  /** Claude Code `is_error` on a result record. */
  readonly isError?: boolean | null;
}

export interface FailureClassification {
  readonly failureClass: FailureClass;
  /** True only for `provider_transient`. Every other class is terminal for this attempt. */
  readonly retryable: boolean;
  /** The single observation that decided the class, so a report can show its evidence. */
  readonly signal: string;
  readonly detail: string;
  /** The specific thing the *user* must do, for classes no retry can fix. `null` when there is none. */
  readonly userAction: string | null;
}

const NEVER_RETRY: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'authentication',
  'quota',
  'permission',
  'protocol',
  'code_failure',
  'unknown',
]);

export function isRetryable(failureClass: FailureClass): boolean {
  return !NEVER_RETRY.has(failureClass);
}

/** Node/libuv codes that mean the connection to the provider broke, not that the request was wrong. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENETRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const PERMISSION_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Codex `codexErrorInfo` tags and Claude Code `error` values, mapped to the shared classes. */
const TAGS: Readonly<Record<string, FailureClass>> = {
  // Codex
  unauthorized: 'authentication',
  usageLimitExceeded: 'quota',
  sessionBudgetExceeded: 'quota',
  serverOverloaded: 'provider_transient',
  internalServerError: 'provider_transient',
  httpConnectionFailed: 'provider_transient',
  responseStreamConnectionFailed: 'provider_transient',
  sandboxError: 'permission',
  badRequest: 'protocol',
  cyberPolicy: 'permission',
  contextWindowExceeded: 'protocol',
  // Claude Code
  authentication_failed: 'authentication',
  rate_limit_error: 'quota',
  usage_limit_reached: 'quota',
  permission_denied: 'permission',
  invalid_request: 'protocol',
  overloaded_error: 'provider_transient',
  api_error: 'provider_transient',
};

const USER_ACTIONS: Readonly<Record<FailureClass, string | null>> = {
  authentication:
    'the runtime is signed out or its stored credential expired; re-authenticate that runtime yourself (for example "codex login" or "claude /login") and run again — no retry can fix it',
  quota:
    'the account hit a usage or budget limit; wait for the window to reset or raise the limit on the account, then run again — retrying now only spends more of the same budget',
  permission:
    'the action was refused by a sandbox or by the filesystem; grant the path or relax the execution profile deliberately rather than retrying',
  protocol:
    'the runtime rejected the request itself; the request or the adapter build is wrong, so report it with the run id rather than retrying',
  code_failure: null,
  provider_transient: null,
  unknown: null,
};

function classified(failureClass: FailureClass, signal: string, detail: string): FailureClassification {
  return { failureClass, retryable: isRetryable(failureClass), signal, detail, userAction: USER_ACTIONS[failureClass] };
}

/**
 * Map one observed failure to a class. Ordered most specific first: an
 * explicit machine-readable tag beats an HTTP status, which beats an errno,
 * which beats the two message shapes actually observed on these builds.
 */
export function classifyFailure(observed: ObservedFailure): FailureClassification {
  const message = (observed.message ?? '').toLowerCase();

  // 1. Machine-readable tags the runtimes hand us.
  const tag = observed.errorTag ?? null;
  if (tag !== null && tag in TAGS) {
    const mapped = TAGS[tag] as FailureClass;
    return classified(mapped, `runtime tag "${tag}"`, `${observed.adapter ?? 'runtime'} reported "${tag}"`);
  }
  if (observed.subtype === 'error_max_budget' || observed.terminalReason === 'max_budget') {
    return classified('quota', `subtype "${observed.subtype ?? observed.terminalReason}"`, 'the runtime stopped the turn because its budget was exhausted');
  }
  if (observed.subtype === 'error_max_turns') {
    return classified('protocol', 'subtype "error_max_turns"', 'the runtime hit its configured turn limit before finishing');
  }

  // 2. HTTP statuses (Codex surfaces the raw status on transport failures).
  const status = observed.httpStatus ?? null;
  if (status !== null) {
    if (status === 401 || status === 403) {
      return classified(
        status === 401 ? 'authentication' : 'permission',
        `HTTP ${status}`,
        `the provider answered HTTP ${status} for ${observed.adapter ?? 'the runtime'}`,
      );
    }
    if (status === 429) return classified('quota', 'HTTP 429', 'the provider rate-limited or exhausted the account quota');
    if (status >= 500 && status <= 599) return classified('provider_transient', `HTTP ${status}`, `the provider answered HTTP ${status}`);
    if (status >= 400) return classified('protocol', `HTTP ${status}`, `the provider rejected the request with HTTP ${status}`);
  }

  // 3. Socket/OS level codes.
  const code = observed.code ?? null;
  if (code !== null) {
    if (TRANSIENT_CODES.has(code)) return classified('provider_transient', code, `the connection failed with ${code}`);
    if (PERMISSION_CODES.has(code)) return classified('permission', code, `the operating system refused the operation with ${code}`);
    if (code === 'ENOENT') return classified('code_failure', 'ENOENT', 'a required file or executable was missing');
  }

  // 4. Message shapes actually observed on the installed builds.
  if (message.includes('oauth session expired') || message.includes('could not be refreshed') || message.includes('failed to authenticate') || message.includes('not logged in')) {
    return classified('authentication', 'message', 'the runtime reported an expired or unusable stored credential');
  }
  if (message.includes('usage limit') || message.includes('quota') || message.includes('rate limit')) {
    return classified('quota', 'message', 'the runtime reported a usage or rate limit');
  }
  if (message.includes('permission denied') || message.includes('sandbox denied')) {
    return classified('permission', 'message', 'the runtime reported a denied permission');
  }
  if (message.includes('no conversation found with session id')) {
    return classified('protocol', 'message', 'the runtime does not know the session the coordinator asked to resume');
  }
  for (const transient of TRANSIENT_CODES) {
    if (message.includes(transient.toLowerCase())) return classified('provider_transient', transient, `the message names the transport error ${transient}`);
  }

  // 5. Process exits. A tool or check that exits non-zero is the task's code
  //    failing, which is a result, not an infrastructure problem.
  const exit = observed.exitCode ?? null;
  if (exit !== null && exit !== 0) {
    if (observed.source === 'tool' || observed.source === 'check') {
      return classified('code_failure', `exit ${exit}`, `the ${observed.source} exited ${exit}`);
    }
    return classified('unknown', `exit ${exit}`, `${observed.adapter ?? 'the process'} exited ${exit} without saying why`);
  }
  if (observed.signal != null && observed.signal !== '') {
    return classified('unknown', `signal ${observed.signal}`, `the process was terminated by ${observed.signal} without a reported cause`);
  }
  if (observed.isError === true) {
    return classified('unknown', 'is_error', 'the runtime marked the result as an error without a class the adapter recognises');
  }

  return classified('unknown', 'none', 'no signal in the observation identifies the failure; it is not treated as retryable');
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryBudget {
  /** Total transient retries allowed for this task (`limits.maxTransientRetries`). */
  readonly maxTransientRetries: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** Bounded exponential backoff. `attemptsUsed` is how many retries already happened. */
export function backoffDelayMs(attemptsUsed: number, budget: RetryBudget): number {
  const base = budget.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const max = budget.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const raw = base * 2 ** Math.max(0, attemptsUsed);
  return Math.min(max, raw);
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly attemptsUsed: number;
  readonly remaining: number;
  readonly reason: string;
  readonly classification: FailureClassification;
}

/**
 * Decide whether to retry. Non-transient classes are refused with the reason
 * naming the class, so a report never has to infer why nothing was retried.
 */
export function planRetry(observed: ObservedFailure | FailureClassification, attemptsUsed: number, budget: RetryBudget): RetryDecision {
  const classification = 'failureClass' in observed ? observed : classifyFailure(observed);
  const remaining = Math.max(0, budget.maxTransientRetries - attemptsUsed);
  if (!classification.retryable) {
    return {
      retry: false,
      delayMs: 0,
      attemptsUsed,
      remaining,
      reason: `${classification.failureClass} is never retried${classification.userAction === null ? '' : '; it needs a specific account or code action'}`,
      classification,
    };
  }
  if (remaining <= 0) {
    return {
      retry: false,
      delayMs: 0,
      attemptsUsed,
      remaining: 0,
      reason: `the transient retry budget of ${budget.maxTransientRetries} is exhausted`,
      classification,
    };
  }
  return {
    retry: true,
    delayMs: backoffDelayMs(attemptsUsed, budget),
    attemptsUsed,
    remaining,
    reason: `provider_transient with ${remaining} of ${budget.maxTransientRetries} retries left`,
    classification,
  };
}
