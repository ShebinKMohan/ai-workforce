/** Native CLI authentication lifecycle. Provider owns the browser and credentials. */
import { randomUUID } from 'node:crypto';
import type { AuthObservation } from '../discovery/probe.js';
import type { ClientId, CommandOutcome } from './cli.js';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
export function loginArgs(client: ClientId): string[] { return client === 'codex' ? ['login'] : ['auth', 'login']; }
export function authStatusArgs(client: ClientId): string[] { return client === 'codex' ? ['login', 'status'] : ['auth', 'status']; }
export interface AuthenticationView {
  state: 'connected' | 'needs_auth' | 'pending' | 'failed' | 'denied' | 'cancelled' | 'unknown';
  auth: 'logged_in' | 'logged_out' | 'unknown';
  canSignIn: boolean;
  message: string;
  checkedAt: string | null;
  login: { id: string; startedAt: string; expiresAt: string; executable: string } | null;
}
export interface AuthenticationOptions {
  probe: (id: ClientId, executable: string) => Promise<AuthObservation>;
  launch: (id: ClientId, executable: string, signal: AbortSignal, timeoutMs: number) => Promise<CommandOutcome>;
  onChanged?: () => void;
  timeoutMs?: number;
}
interface Session {
  identity: NonNullable<AuthenticationView['login']>;
  controller: AbortController;
  completion: Promise<void>;
  pending: boolean;
  result: AuthenticationView['state'];
  message: string;
  stopUnconfirmed?: boolean;
}
const NAMES = { codex: 'Codex', claude: 'Claude Code' };

export class AuthenticationManager {
  readonly #sessions = new Map<ClientId, Session>();
  readonly #observations = new Map<ClientId, { executable: string; auth: AuthenticationView['auth']; at: string }>();
  readonly #starts = new Map<ClientId, Promise<AuthenticationView>>();
  #closed = false;
  constructor(readonly options: AuthenticationOptions) {}

  #changed(): void { this.options.onChanged?.(); }
  async #observe(id: ClientId, executable: string): Promise<{ auth: AuthenticationView['auth']; at: string }> {
    let auth: AuthenticationView['auth'] = 'unknown';
    try { auth = (await this.options.probe(id, executable)).auth; } catch { /* No raw diagnostic/credentials leave the probe. */ }
    const prior = this.#observations.get(id);
    const observed = { executable, auth, at: new Date().toISOString() };
    this.#observations.set(id, observed);
    if (!prior || prior.auth !== auth || prior.executable !== executable) this.#changed();
    return observed;
  }
  async status(id: ClientId, executable: string | null): Promise<AuthenticationView> {
    const session = this.#sessions.get(id);
    if (session?.stopUnconfirmed) return { state: 'failed', auth: 'unknown', canSignIn: false, message: session.message, checkedAt: null, login: session.identity };
    if (session?.pending) {
      return { state: 'pending', auth: 'unknown', canSignIn: false, checkedAt: this.#observations.get(id)?.at ?? null,
        message: session.identity.executable === executable ? `Complete sign-in in the browser opened by ${NAMES[id]}. The app will check your account when that login finishes.` : 'The selected installation changed while sign-in was open. Cancel this sign-in before using the new installation.', login: session.identity };
    }
    if (!executable) return { state: 'unknown', auth: 'unknown', canSignIn: false, message: `Install ${NAMES[id]} before signing in.`, checkedAt: null, login: null };
    const observed = await this.#observe(id, executable);
    const terminal = session?.identity.executable === executable && ['failed', 'denied', 'cancelled'].includes(session.result) ? session : undefined;
    if (observed.auth === 'logged_in') {
      // The native account may be valid even when this owned attempt failed
      // or was cancelled. Keep account readiness and attempt success distinct.
      const lastAttempt = terminal ? ` The last sign-in attempt ${terminal.result === 'cancelled' ? 'was cancelled' : terminal.result === 'denied' ? 'was denied' : 'did not finish successfully'}.` : '';
      return { state: 'connected', auth: 'logged_in', canSignIn: false,
        message: `${NAMES[id]} reports an active sign-in.${lastAttempt} Task execution still uses its runtime and permission checks.`, checkedAt: observed.at, login: null };
    }
    return { state: terminal?.result ?? (observed.auth === 'logged_out' ? 'needs_auth' : 'unknown'), auth: observed.auth, canSignIn: !this.#closed,
      message: terminal?.message ?? (observed.auth === 'logged_out' ? `Sign in to ${NAMES[id]} to run your team's tasks.` : `${NAMES[id]}'s sign-in could not be confirmed. Check again or start its sign-in flow.`), checkedAt: observed.at, login: null };
  }
  async start(id: ClientId, executable: string): Promise<AuthenticationView> {
    const existing = this.#starts.get(id);
    if (existing) return existing;
    const work = this.#start(id, executable);
    this.#starts.set(id, work);
    try { return await work; } finally { this.#starts.delete(id); }
  }
  async #start(id: ClientId, executable: string): Promise<AuthenticationView> {
    if (this.#closed) throw new Error('The workspace server is stopping. Start it again before signing in.');
    const before = await this.status(id, executable);
    if (!before.canSignIn || before.state === 'connected' || before.state === 'pending') return before;
    const timeoutMs = this.options.timeoutMs ?? LOGIN_TIMEOUT_MS;
    const controller = new AbortController();
    const now = Date.now();
    const session: Session = { identity: { id: randomUUID(), executable, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString() },
      controller, pending: true, result: 'pending', message: '', completion: Promise.resolve() };
    this.#sessions.set(id, session);
    this.#changed();
    // Start the documented login only after the user's POST. The response is
    // immediate; no request is held open for provider consent.
    session.completion = this.#complete(id, session, timeoutMs);
    return this.status(id, executable);
  }
  async #complete(id: ClientId, session: Session, timeoutMs: number): Promise<void> {
    let outcome: CommandOutcome;
    try { outcome = await this.options.launch(id, session.identity.executable, session.controller.signal, timeoutMs); }
    catch { outcome = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, spawnError: 'Login could not start.' }; }
    const observed = await this.#observe(id, session.identity.executable);
    if (outcome.spawnError) {
      session.stopUnconfirmed = /process (?:exit could not be confirmed|group could not be stopped)/i.test(outcome.spawnError);
      session.result = 'failed'; session.message = 'The sign-in process could not complete or confirm a clean stop. Check your coding agent, then try again.';
    } else if (observed.auth === 'logged_in' && !outcome.timedOut && !session.controller.signal.aborted && outcome.exitCode === 0 && outcome.signal === null) {
      session.result = 'connected'; session.message = `${NAMES[id]} sign-in is confirmed.`;
    } else if (session.controller.signal.aborted) {
      session.result = 'cancelled'; session.message = 'Sign-in was cancelled and the owned login process stopped. Any open provider tab can be closed.';
    } else if (outcome.timedOut) {
      session.result = 'failed'; session.message = 'Sign-in timed out and its login process stopped. Try again and complete the provider steps within five minutes.';
    } else if (/\baccess_denied\b|\bauthori[sz]ation (?:was )?denied\b|\bpermission denied\b|\buser denied\b|\baccess denied\b/i.test(`${outcome.stdout}\n${outcome.stderr}`)) {
      session.result = 'denied'; session.message = 'The provider denied sign-in. Check your account access or organization policy, then try again.';
    } else {
      session.result = 'failed'; session.message = 'Sign-in did not establish a usable account. Retry the native browser flow. If the provider requires an interactive terminal or a pasted code, complete sign-in in the coding agent and choose Check sign-in here.';
    }
    session.pending = false;
    this.#changed();
  }
  async cancel(id: ClientId, executable: string | null): Promise<AuthenticationView> {
    const pendingStart = this.#starts.get(id);
    if (pendingStart) await pendingStart;
    const session = this.#sessions.get(id);
    if (session?.pending) { session.controller.abort(); await session.completion; }
    return this.status(id, executable);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starts.values());
    for (const session of this.#sessions.values()) if (session.pending) session.controller.abort();
    await Promise.allSettled([...this.#sessions.values()].map((session) => session.completion));
  }
}
