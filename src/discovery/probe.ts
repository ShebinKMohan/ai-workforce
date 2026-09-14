/**
 * Version and login-status probes (FR002).
 *
 * Both probes use only the documented flags in `runtimes.ts`. Neither passes a
 * prompt, so neither can start a paid model turn. A probe that could not run
 * maps authentication to `unknown` — never to a ready state.
 *
 * Login output is never stored verbatim: `claude auth status` prints the
 * account email and organisation, and none of that belongs in a report.
 */
import type { AuthenticationStatus } from '../adapters/types.js';
import { runtimeDescriptor, type DiscoverableAdapter } from './runtimes.js';
import { nodeProbeSpawner, probeCommand, PROBE_TIMEOUT_MS, sanitizedProbeEnv, withNeutralCwd, type ProbeResult, type ProbeSpawner } from './spawn.js';

/** Discovery reports only these three; `not_required` is an adapter-level concept. */
export type AuthStatus = Extract<AuthenticationStatus, 'logged_in' | 'logged_out' | 'unknown'>;

export type ProbePurpose = 'version' | 'auth';

/** What a probe actually ran and what came back. Safe to print: no login output. */
export interface ProbeRecord {
  readonly purpose: ProbePurpose;
  readonly adapter: DiscoverableAdapter;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly durationMs: number;
  readonly timeoutMs: number;
}

export interface RuntimeProbe {
  readonly adapter: DiscoverableAdapter;
  readonly executable: string;
  readonly version: string | null;
  /** First line of the version output, trimmed and capped. Empty when nothing was produced. */
  readonly versionLine: string;
  readonly auth: AuthStatus;
  /** Human explanation of how `auth` was decided. Never contains login output. */
  readonly authDetail: string;
  readonly probes: ReadonlyArray<ProbeRecord>;
  readonly diagnostics: ReadonlyArray<string>;
}

const MAX_VERSION_LINE = 200;

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, MAX_VERSION_LINE);
}

function record(purpose: ProbePurpose, adapter: DiscoverableAdapter, result: ProbeResult): ProbeRecord {
  return {
    purpose,
    adapter,
    executable: result.command.executable,
    argv: result.command.args,
    cwd: result.command.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    timeoutMs: result.command.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/** Parse an adapter's own version line ("codex-cli 0.147.0", "2.1.260 (Claude Code)"). */
export function parseVersionOutput(adapter: DiscoverableAdapter, text: string): string | null {
  const match = runtimeDescriptor(adapter).versionPattern.exec(text);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Login status parsing (documented commands only)
// ---------------------------------------------------------------------------

export interface AuthObservation {
  readonly auth: AuthStatus;
  readonly detail: string;
  /** A fact about what this observation does *not* establish; surfaced as a diagnostic. */
  readonly caveat?: string;
}

const LOGGED_OUT_PATTERN = /\bnot\s+logged\s+in\b|\blogged\s+out\b|\bnot\s+signed\s+in\b|\bno\s+credentials\b/i;
const LOGGED_IN_PATTERN = /\blogged\s+in\b|\bsigned\s+in\b/i;

/**
 * Everything the login-status readings below need, and nothing about how the
 * command was run.
 *
 * There is exactly one place in this repository that decides what a login
 * status command's output means. The Claude Code adapter runs the same
 * documented command through `execFile` rather than through the discovery
 * spawner, and it used to carry a second, looser copy of this logic — one that
 * ignored the exit code entirely and answered `logged_in` for `{"loggedIn":
 * true}` printed by a command that then exited 1 or died on a signal. That
 * copy is the answer `doctor --connect` records, so the looser reading won.
 * Narrowing the input to this shape is what lets both callers share the one
 * set of rules; see `parseAuthCommandOutcome`.
 */
export interface AuthCommandOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT, EACCES, ...). */
  readonly spawnError: string | null;
  readonly timeoutMs: number;
}

export function authOutcomeOfProbe(result: ProbeResult): AuthCommandOutcome {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    timeoutMs: result.command.timeoutMs,
  };
}

/**
 * A login-status command fails in two ways that must not be confused:
 *
 *  - it never ran — the executable could not be started, or it was killed on
 *    the probe deadline. Nothing was answered, so nothing is established.
 *  - it ran, printed its own answer, and *then* exited non-zero.
 *
 * `claude auth status` on 2.1.260 does the second thing when signed out: it
 * exits 1, prints a complete `{"loggedIn": false, "authMethod": "none", …}` on
 * stdout and prints nothing on stderr. Discarding that output on the exit code
 * alone turned a cleanly reported signed-out state into `auth_unknown` and
 * swallowed the one diagnostic that tells a user what to do about it.
 *
 * The asymmetry below is deliberate and load-bearing. A runtime's own answer
 * may make this report say **logged_out** whatever the exit code, but only a
 * command that exited 0 may contribute to saying **logged_in**. Over-reporting
 * logged_out costs a user one needless `login`; over-reporting logged_in is a
 * false readiness claim, which is the failure this coordinator exists to
 * prevent (plan section 6 rule 4).
 */
function unusableProbeObservation(result: AuthCommandOutcome, command: string): AuthObservation | null {
  if (result.spawnError !== null) return { auth: 'unknown', detail: `\`${command}\` could not be started (${result.spawnError})` };
  if (result.timedOut) return { auth: 'unknown', detail: `\`${command}\` did not answer within ${result.timeoutMs} ms and its process group was terminated` };
  return null;
}

function exitPhrase(result: AuthCommandOutcome): string {
  return result.exitCode === null ? 'exited on a signal' : `exited ${result.exitCode}`;
}

/**
 * The gate that stands between a failed command and a claimed login. Reached
 * only after every signed-out reading has been tried, so a non-zero exit can
 * still be reported as "not logged in" — it just can never be reported as
 * "logged in", nor as anything else a caller might mistake for readiness.
 */
function unestablishedByExit(result: AuthCommandOutcome, command: string): AuthObservation | null {
  if (result.exitCode === 0) return null;
  return { auth: 'unknown', detail: `\`${command}\` ${exitPhrase(result)} without reporting a signed-out state; login state is not established` };
}

function loggedOutDetail(command: string, reading: string, result: AuthCommandOutcome): string {
  return result.exitCode === 0
    ? `\`${command}\` ${reading}`
    : `\`${command}\` ${exitPhrase(result)} and ${reading}; the command answered, so its own answer is read rather than discarded on the exit code`;
}

/**
 * The channel a signed-out reading may be taken from.
 *
 * `LOGGED_OUT_PATTERN` is a loose substring match, and on a non-zero exit the
 * text it is matched against is as likely to be a crash as an answer: a proxy
 * refusing the request ("you are not logged in to corp-proxy"), a keychain
 * error ("no credentials store available"), a panic naming a credentials
 * directory. Those all go to stderr, which is where failures go; a status
 * command states its answer on stdout. So after a failure only stdout counts
 * as the command's own answer, and a crash that merely happens to contain the
 * words falls through to `unestablishedByExit` and is reported as unknown.
 *
 * On a clean exit both channels are read, unchanged: a command that exited 0
 * was answering, wherever it chose to print.
 */
function statedAnswerText(result: AuthCommandOutcome): string {
  return result.exitCode === 0 ? `${result.stdout}\n${result.stderr}` : result.stdout;
}

/** `codex login status` prints "Logged in using ChatGPT" or a not-logged-in line. */
export function parseCodexLoginStatus(result: AuthCommandOutcome): AuthObservation {
  const unusable = unusableProbeObservation(result, 'codex login status');
  if (unusable !== null) return unusable;
  const text = `${result.stdout}\n${result.stderr}`;
  // Codex 0.154.0 was checked in an empty isolated configuration: its
  // documented status command exits 1 and writes exactly this line to stderr.
  // Recognize the entire answer, while keeping proxy/crash substrings unknown.
  if (result.exitCode === 1 && result.stdout.trim() === '' && result.stderr.trim() === 'Not logged in') {
    return { auth: 'logged_out', detail: '`codex login status` reports no active login' };
  }
  // codex prints free text and docs/runtime-codex.md records only the
  // signed-in line, so its signed-out exit code is not a verified fact here.
  // A stated absence of a login is therefore believed whatever the exit code —
  // the direction that cannot manufacture readiness — while a stated login
  // still needs a clean exit. Free text is all codex gives, so this is its only
  // signed-out reading; `statedAnswerText` is what keeps a crash on stderr from
  // being mistaken for one.
  if (LOGGED_OUT_PATTERN.test(statedAnswerText(result))) return { auth: 'logged_out', detail: loggedOutDetail('codex login status', 'reports no active login', result) };
  const failed = unestablishedByExit(result, 'codex login status');
  if (failed !== null) return failed;
  if (LOGGED_IN_PATTERN.test(text)) return { auth: 'logged_in', detail: '`codex login status` reports an active login' };
  return { auth: 'unknown', detail: '`codex login status` succeeded but its output was not recognised' };
}

/** `claude auth status` prints JSON with `loggedIn` by default and text with `--text`. */
export function parseClaudeAuthStatus(result: AuthCommandOutcome): AuthObservation {
  const unusable = unusableProbeObservation(result, 'claude auth status');
  if (unusable !== null) return unusable;
  const text = `${result.stdout}\n${result.stderr}`;
  const json = extractJsonObject(result.stdout);

  // Read the signed-out answer first, and read it whatever the exit code:
  // exit 1 with `{"loggedIn": false}` on stdout is how 2.1.260 reports a
  // signed-out runtime, and it is an answer, not a failure.
  //
  // Only the *structured* answer earns that. `loggedIn: false` is a top-level
  // boolean field in a machine-readable document: nothing but a deliberate
  // statement produces it. The free-text reading below has no such
  // discriminator — it is a substring match — so it stays behind the exit gate,
  // where a crash that happens to say "not logged in" cannot be promoted into
  // an authoritative signed-out verdict. On this build that costs nothing:
  // 2.1.260 prints JSON on stdout in both states, so a text-only signed-out
  // reply already implies the command is not the one we think it is.
  if (json !== null && json['loggedIn'] === false) {
    return { auth: 'logged_out', detail: loggedOutDetail('claude auth status', 'reported loggedIn=false', result) };
  }

  const failed = unestablishedByExit(result, 'claude auth status');
  if (failed !== null) return failed;

  if (json === null && LOGGED_OUT_PATTERN.test(text)) {
    return { auth: 'logged_out', detail: loggedOutDetail('claude auth status', 'reports no active login', result) };
  }

  if (json !== null) {
    // A stored profile is not the same thing as what the runtime can spend,
    // and the two have disagreed in BOTH directions on 2.1.260: once with
    // `auth status` reporting loggedIn=true while the runtime reported
    // account.tokenSource "none" and every turn failed authentication, and
    // once with `auth status` reporting loggedIn=false while turns worked.
    // Only the live handshake settles it (docs/runtime-claude-code.md §9).
    if (json['loggedIn'] === true) {
      return {
        auth: 'logged_in',
        detail: '`claude auth status` reported loggedIn=true, which describes a stored profile rather than what the runtime can spend',
        caveat:
          '`claude auth status` reporting loggedIn=true describes a stored profile, not what the runtime can spend; the two have disagreed in both directions on this build. Run `workforce doctor --connect` to ask the runtime itself, which is the only check that can reach verified_ready',
      };
    }
    return { auth: 'unknown', detail: '`claude auth status` returned JSON without a boolean loggedIn field' };
  }
  if (LOGGED_IN_PATTERN.test(text)) return { auth: 'logged_in', detail: '`claude auth status` reports an active login' };
  return { auth: 'unknown', detail: '`claude auth status` succeeded but its output was neither JSON nor a recognised status line' };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The single place a login-status command's output is turned into a verdict. */
export function parseAuthCommandOutcome(adapter: DiscoverableAdapter, outcome: AuthCommandOutcome): AuthObservation {
  return adapter === 'codex' ? parseCodexLoginStatus(outcome) : parseClaudeAuthStatus(outcome);
}

export function parseAuthStatus(adapter: DiscoverableAdapter, result: ProbeResult): AuthObservation {
  return parseAuthCommandOutcome(adapter, authOutcomeOfProbe(result));
}

// ---------------------------------------------------------------------------
// Running the probes
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  readonly spawner?: ProbeSpawner;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Skip the login probe (used when the version probe already failed). */
  readonly skipAuth?: boolean;
}

/**
 * Run the version probe and, when the executable answered, the documented login
 * status probe. Both run in one neutral temporary directory that is removed
 * afterwards, so no repository configuration or hook can influence them.
 */
export async function probeRuntime(adapter: DiscoverableAdapter, executable: string, options: ProbeOptions = {}): Promise<RuntimeProbe> {
  const descriptor = runtimeDescriptor(adapter);
  const spawner = options.spawner ?? nodeProbeSpawner;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const env = options.env ?? sanitizedProbeEnv();

  return withNeutralCwd(async (cwd) => {
    const probes: ProbeRecord[] = [];
    const diagnostics: string[] = [];

    const versionResult = await spawner(probeCommand(adapter, executable, descriptor.versionArgs, cwd, { env, timeoutMs }));
    probes.push(record('version', adapter, versionResult));

    const versionLine = firstLine(versionResult.stdout.length > 0 ? versionResult.stdout : versionResult.stderr);
    let version: string | null = null;

    if (versionResult.spawnError !== null) {
      diagnostics.push(`${executable} could not be started: ${versionResult.spawnError}`);
    } else if (versionResult.timedOut) {
      diagnostics.push(`${executable} ${descriptor.versionArgs.join(' ')} did not answer within ${timeoutMs} ms; its process group was terminated`);
    } else if (versionResult.exitCode !== 0) {
      diagnostics.push(`${executable} ${descriptor.versionArgs.join(' ')} exited ${versionResult.exitCode ?? 'on a signal'}`);
    } else {
      version = parseVersionOutput(adapter, `${versionResult.stdout}\n${versionResult.stderr}`);
      if (version === null) {
        diagnostics.push(`could not read a version from ${JSON.stringify(versionLine)}; expected a line like "${descriptor.versionExample}"`);
      }
    }

    if (options.skipAuth === true || versionResult.spawnError !== null) {
      return {
        adapter,
        executable,
        version,
        versionLine,
        auth: 'unknown' as AuthStatus,
        authDetail: options.skipAuth === true ? 'login status was not probed' : 'the executable could not be started, so login status was not probed',
        probes,
        diagnostics,
      };
    }

    const authResult = await spawner(probeCommand(adapter, executable, descriptor.authArgs, cwd, { env, timeoutMs }));
    probes.push(record('auth', adapter, authResult));
    const observation = parseAuthStatus(adapter, authResult);
    if (observation.auth === 'unknown') diagnostics.push(`authentication status is unknown: ${observation.detail}`);
    if (observation.auth === 'logged_out') diagnostics.push(`${descriptor.displayName} is not logged in; run \`${descriptor.loginHint}\``);
    if (observation.caveat !== undefined) diagnostics.push(observation.caveat);

    return { adapter, executable, version, versionLine, auth: observation.auth, authDetail: observation.detail, probes, diagnostics };
  });
}
