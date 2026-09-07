/**
 * Version and login-status probes (FR002).
 *
 * Both probes use only the documented flags in `runtimes.ts`. Neither passes a
 * prompt, so neither can start a paid model turn. A timeout or a non-zero exit
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

/** Shared pre-checks: a probe that failed can never establish a login. */
function failedProbeObservation(result: ProbeResult, command: string): AuthObservation | null {
  if (result.spawnError !== null) return { auth: 'unknown', detail: `\`${command}\` could not be started (${result.spawnError})` };
  if (result.timedOut) return { auth: 'unknown', detail: `\`${command}\` did not answer within ${result.command.timeoutMs} ms and its process group was terminated` };
  if (result.exitCode !== 0) return { auth: 'unknown', detail: `\`${command}\` exited ${result.exitCode ?? 'on a signal'}; login state is not established` };
  return null;
}

/** `codex login status` prints "Logged in using ChatGPT" or a not-logged-in line. */
export function parseCodexLoginStatus(result: ProbeResult): AuthObservation {
  const failed = failedProbeObservation(result, 'codex login status');
  if (failed !== null) return failed;
  const text = `${result.stdout}\n${result.stderr}`;
  if (LOGGED_OUT_PATTERN.test(text)) return { auth: 'logged_out', detail: '`codex login status` reports no active login' };
  if (LOGGED_IN_PATTERN.test(text)) return { auth: 'logged_in', detail: '`codex login status` reports an active login' };
  return { auth: 'unknown', detail: '`codex login status` succeeded but its output was not recognised' };
}

/** `claude auth status` prints JSON with `loggedIn` by default and text with `--text`. */
export function parseClaudeAuthStatus(result: ProbeResult): AuthObservation {
  const failed = failedProbeObservation(result, 'claude auth status');
  if (failed !== null) return failed;
  const text = `${result.stdout}\n${result.stderr}`;
  const json = extractJsonObject(result.stdout);
  if (json !== null) {
    const loggedIn = json['loggedIn'];
    // A stored profile is not the same thing as what the runtime can spend,
    // and the two have disagreed in BOTH directions on 2.1.260: once with
    // `auth status` reporting loggedIn=true while the runtime reported
    // account.tokenSource "none" and every turn failed authentication, and
    // once with `auth status` reporting loggedIn=false while turns worked.
    // Only the live handshake settles it (docs/runtime-claude-code.md §9).
    if (loggedIn === true) {
      return {
        auth: 'logged_in',
        detail: '`claude auth status` reported loggedIn=true, which describes a stored profile rather than what the runtime can spend',
        caveat:
          '`claude auth status` reporting loggedIn=true describes a stored profile, not what the runtime can spend; the two have disagreed in both directions on this build. Run `workforce doctor --connect` to ask the runtime itself, which is the only check that can reach verified_ready',
      };
    }
    if (loggedIn === false) return { auth: 'logged_out', detail: '`claude auth status` reported loggedIn=false' };
    return { auth: 'unknown', detail: '`claude auth status` returned JSON without a boolean loggedIn field' };
  }
  if (LOGGED_OUT_PATTERN.test(text)) return { auth: 'logged_out', detail: '`claude auth status` reports no active login' };
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

export function parseAuthStatus(adapter: DiscoverableAdapter, result: ProbeResult): AuthObservation {
  return adapter === 'codex' ? parseCodexLoginStatus(result) : parseClaudeAuthStatus(result);
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
