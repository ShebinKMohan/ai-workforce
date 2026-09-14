/** One-click installation of this app's external MCP entry in local coding CLIs. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { addConnectionArgs, getConnectionArgs, parseConnectionEntry, removeConnectionArgs, runConnectionCommand, type ClientId, type CommandOutcome, type ConnectionEntry, type DesiredConnection } from '../connections/cli.js';
import { parseAuthCommandOutcome, parseVersionOutput } from '../discovery/probe.js';
import { AuthenticationManager, authStatusArgs, loginArgs, type AuthenticationView } from '../connections/authentication.js';
import { capabilitiesFor, isControllable, loadVerifiedCapabilityOverrides } from '../discovery/capabilities.js';
import { resolveExecutable, type ExecutableResolution } from '../discovery/resolve.js';
import { isAtLeast, runtimeDescriptor, type DiscoverableAdapter } from '../discovery/runtimes.js';
import { sanitizedProbeEnv, withNeutralCwd } from '../discovery/spawn.js';
import { validateServerUrl } from '../mcp/client.js';
import { MCP_TOOLS } from '../mcp/tools.js';
import { ApiError } from './http.js';
import { packageRoot } from './static.js';
import { readWorkspace } from './workspace-api.js';

const CLIENTS = [{ id: 'codex', name: 'Codex', adapter: 'codex', setupUrl: 'https://learn.chatgpt.com/docs/codex/cli' }, { id: 'claude', name: 'Claude Code', adapter: 'claude-code', setupUrl: 'https://code.claude.com/docs/en/quickstart' }] as const;
const Body = z.strictObject({});
const CLIENT_IDS = new Set<string>(CLIENTS.map((client) => client.id));
const CACHE_MS = 15_000;
export interface ConnectionVerification {
  state: 'not_checked' | 'verified' | 'failed';
  checkedAt: string | null;
  toolCount: number;
  error: string | null;
}
export interface ConnectionClientView {
  id: ClientId;
  name: string;
  installed: boolean;
  executable: string | null;
  version: string | null;
  status: 'not_installed' | 'not_connected' | 'connected' | 'needs_update' | 'conflict' | 'error';
  configured: boolean;
  canConnect: boolean;
  action: 'connect' | 'reconnect' | null;
  scope: 'user';
  toolsVerified: boolean;
  verification: ConnectionVerification;
  clientReloadRequired: boolean;
  message: string;
  error: { code: string; message: string } | null;
  setupUrl: string;
  authentication: AuthenticationView;
  execution: { usable: boolean; reason: string };
}
interface Snapshot { view: ConnectionClientView; entry: ConnectionEntry; desired: DesiredConnection }
export interface ConnectionsApiOptions {
  readonly stateRoot: string;
  readonly serverUrl: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolve?: typeof resolveExecutable;
  readonly run?: typeof runConnectionCommand;
  /** Test/runtime packaging injection. Production uses this exact built CLI. */
  readonly bridgeCommand?: string;
  readonly bridgeEntry?: string;
  readonly bridgeExists?: () => boolean;
  /** Invalidate workspace readiness/model caches after authentication changes. */
  readonly onAuthenticationChanged?: () => void;
  readonly loginTimeoutMs?: number;
}

function outcomeOk(outcome: CommandOutcome): boolean {
  return outcome.exitCode === 0 && !outcome.timedOut && outcome.spawnError === null && outcome.signal === null;
}
function sameConnection(entry: ConnectionEntry, desired: DesiredConnection): boolean {
  return entry.kind === 'stdio' && entry.enabled !== false && !entry.hasEnvironment && entry.command === desired.command && JSON.stringify(entry.args) === JSON.stringify(desired.args) && (entry.scope === undefined || entry.scope === 'user');
}
function ownedConnection(entry: ConnectionEntry, desired: DesiredConnection): boolean {
  if (entry.kind !== 'stdio' || entry.hasEnvironment || entry.enabled === false || entry.scope !== undefined && entry.scope !== 'user' || !entry.command || !entry.args) return false;
  if (!/^node(?:\.exe)?$/.test(path.basename(entry.command)) || entry.args[0] !== desired.args[0] || entry.args[1] !== 'mcp') return false;
  if (entry.args.length === 2) return true;
  if (entry.args.length !== 4 || entry.args[2] !== '--server-url') return false;
  try { validateServerUrl(entry.args[3]!); return true; } catch { return false; }
}
function emptyVerification(): ConnectionVerification { return { state: 'not_checked', checkedAt: null, toolCount: 0, error: null }; }

export class ConnectionsApi {
  readonly #env: NodeJS.ProcessEnv;
  readonly #run: typeof runConnectionCommand;
  readonly #cache = new Map<ClientId, { at: number; key: string; snapshot: Promise<Snapshot> }>();
  readonly #active = new Map<ClientId, Promise<{ ok: true; schemaVersion: 1; client: ConnectionClientView; changed: boolean; message: string }>>();
  readonly #verification = new Map<ClientId, { key: string; value: ConnectionVerification }>();
  readonly #authentication: AuthenticationManager;
  constructor(readonly options: ConnectionsApiOptions) {
    const environment = options.env ?? process.env;
    this.#env = sanitizedProbeEnv(environment);
    // These documented location overrides choose the user's agent settings,
    // never provider credentials. Keep them consistent between get and add.
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) if (environment[key]) this.#env[key] = environment[key];
    this.#run = options.run ?? runConnectionCommand;
    this.#authentication = new AuthenticationManager({
      probe: async (id, executable) => {
        const result = await this.#command(executable, authStatusArgs(id));
        return parseAuthCommandOutcome(id === 'claude' ? 'claude-code' : 'codex', { ...result, timeoutMs: 15_000 });
      },
      launch: (id, executable, signal, timeoutMs) => withNeutralCwd((cwd) => this.#run({ executable, args: loginArgs(id), env: this.#env, cwd, signal, timeoutMs })),
      onChanged: () => { this.options.onAuthenticationChanged?.(); },
      ...(options.loginTimeoutMs !== undefined ? { timeoutMs: options.loginTimeoutMs } : {}),
    });
  }

  #desired(): DesiredConnection {
    return { command: this.options.bridgeCommand ?? process.execPath, args: [this.options.bridgeEntry ?? path.join(packageRoot(), 'dist', 'cli', 'index.js'), 'mcp', '--server-url', validateServerUrl(this.options.serverUrl())] };
  }
  #bridgeExists(): boolean { return this.options.bridgeExists?.() ?? existsSync(this.#desired().args[0]!); }
  #resolve(adapter: DiscoverableAdapter): ExecutableResolution {
    const config = readWorkspace(this.options.stateRoot).loaded?.config;
    const configured = config?.controlCenter?.runtime ? config.runtimes[config.controlCenter.runtime] : undefined;
    const binding = configured?.adapter === adapter ? configured : Object.values(config?.runtimes ?? {}).find((runtime) => runtime.adapter === adapter);
    const executable = binding?.executable;
    return (this.options.resolve ?? resolveExecutable)(adapter, {
      pathValue: this.#env['PATH'] ?? '',
      ...(this.#env['HOME'] ? { homeDir: this.#env['HOME'] } : {}),
      ...(executable ? path.isAbsolute(executable) || executable.startsWith('~/') ? { override: executable } : { executableName: executable } : {}),
    });
  }
  async #command(executable: string, args: readonly string[], stdin?: string): Promise<CommandOutcome> {
    return withNeutralCwd((cwd) => this.#run({ executable, args: [...args], cwd, env: this.#env, timeoutMs: stdin === undefined ? 15_000 : 45_000, ...(stdin !== undefined ? { stdin } : {}) }));
  }
  #verificationFor(id: ClientId, desired: DesiredConnection): ConnectionVerification {
    const saved = this.#verification.get(id);
    return saved?.key === JSON.stringify(desired) ? saved.value : emptyVerification();
  }

  async #inspect(id: ClientId, refresh = false): Promise<Snapshot> {
    const definition = CLIENTS.find((client) => client.id === id)!;
    const desired = this.#desired();
    const resolution = this.#resolve(definition.adapter);
    const executable = resolution.selected?.path ?? null;
    const key = JSON.stringify([desired, executable, resolution.selected?.realPath]);
    const cached = this.#cache.get(id);
    if (!refresh && cached?.key === key && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
    const snapshot = (async (): Promise<Snapshot> => {
      const verification = this.#verificationFor(id, desired);
      const view: ConnectionClientView = { id, name: definition.name, installed: executable !== null, executable, version: null,
        status: 'not_installed', configured: false, canConnect: false, action: null, scope: 'user', toolsVerified: false,
        verification, clientReloadRequired: false, message: `Install ${definition.name}, then choose Detect again.`, error: null, setupUrl: definition.setupUrl,
        authentication: { state: 'unknown', auth: 'unknown', canSignIn: false, message: 'Sign-in has not been checked.', checkedAt: null, login: null }, execution: { usable: false, reason: 'Execution readiness has not been checked.' } };
      if (!executable) return { view, entry: { kind: 'missing' }, desired };
      const [versionResult, getResult] = await Promise.all([this.#command(executable, ['--version']), this.#command(executable, getConnectionArgs(id))]);
      view.version = outcomeOk(versionResult) ? parseVersionOutput(definition.adapter, versionResult.stdout) : null;
      const entry = parseConnectionEntry(id, getResult);
      if (view.version === null || entry.kind === 'unreadable') {
        view.status = 'error';
        view.message = view.version === null ? `${definition.name} was found, but its installed version could not be checked. Try Detect again.` : `${definition.name}'s MCP configuration could not be checked. Close any configuration prompt in that app and try again.`;
        view.error = { code: 'connection_inspection_failed', message: view.message };
      } else if (!this.#bridgeExists()) {
        view.status = 'error'; view.message = 'The built AI Workforce connection is missing. Restart AI Workforce through its normal launcher to rebuild it.';
        view.error = { code: 'bridge_missing', message: view.message };
      } else if (sameConnection(entry, desired)) {
        view.configured = true; view.status = verification.state === 'failed' ? 'error' : 'connected';
        view.toolsVerified = verification.state === 'verified'; view.clientReloadRequired = true;
        view.message = view.toolsVerified ? `Connection saved and ${verification.toolCount} tools verified. Reopen or reload your ${definition.name} task to use them.` : verification.error ?? `Connection saved. Verify the tools, then reopen or reload your ${definition.name} task.`;
        if (verification.state === 'failed') view.error = { code: 'connection_verification_failed', message: verification.error! };
      } else if (entry.kind === 'missing') {
        view.status = 'not_connected'; view.canConnect = true; view.action = 'connect'; view.message = `${definition.name} is installed. Connect it to this workspace with one click.`;
      } else if (ownedConnection(entry, desired)) {
        view.status = 'needs_update'; view.canConnect = true; view.action = 'reconnect'; view.message = 'An AI Workforce connection points to an earlier local address or Node executable. Reconnect it to this workspace.';
      } else {
        view.status = 'conflict'; view.message = `${definition.name} already has a different or customized connection named ai-workforce. Rename that entry in its MCP settings before connecting here.`;
        view.error = { code: 'connection_name_conflict', message: view.message };
      }
      return { view, entry, desired };
    })();
    this.#cache.set(id, { at: Date.now(), key, snapshot });
    try { return await snapshot; } catch {
      this.#cache.delete(id);
      throw new ApiError(503, 'connection_inspection_failed', 'The installed coding agent could not be inspected. Try Detect again.');
    }
  }

  async list(refresh = false) {
    const clients = await Promise.all(CLIENTS.map(async ({ id }) => {
      let snapshot = await this.#inspect(id, refresh);
      if (snapshot.view.configured && (refresh || snapshot.view.verification.state === 'not_checked') && !this.#active.has(id)) {
        await this.#verifyBridge(id, snapshot.desired);
        snapshot = await this.#inspect(id, true);
      }
      return this.#withAuthentication(snapshot.view);
    }));
    return { ok: true, schemaVersion: 1, serverUrl: this.options.serverUrl(), checkedAt: new Date().toISOString(), clients,
      bridge: { name: 'ai-workforce', transport: 'stdio', serverUrl: this.options.serverUrl(), scope: 'user',
        toolCount: MCP_TOOLS.length, clientSessionStatus: 'not_observed' },
      referenceConfiguration: { mcpServers: { 'ai-workforce': this.#desired() } } };
  }

  async #withAuthentication(view: ConnectionClientView, known?: AuthenticationView): Promise<ConnectionClientView> {
    const authentication = known ?? await this.#authentication.status(view.id, view.executable);
    const adapter = view.id === 'claude' ? 'claude-code' : 'codex';
    const supported = view.version !== null && isAtLeast(view.version, runtimeDescriptor(adapter).minimumSupportedVersion)
      && isControllable(capabilitiesFor(adapter, view.version, { overrides: loadVerifiedCapabilityOverrides() }));
    const usable = view.installed && supported && authentication.auth === 'logged_in' && authentication.state === 'connected';
    return { ...view, authentication, execution: { usable, reason: usable ? 'The installed runtime reports an active sign-in and supported controls. Task permissions and verification still apply.'
      : !view.installed ? 'Install this coding agent before assigning it work.' : !supported ? 'This installation does not report supported runtime controls. Update or check the installation.' : authentication.message } };
  }

  /** Cheap sign-in polling deliberately avoids MCP verification. */
  async authenticationStatus(clientId: string) {
    if (!CLIENT_IDS.has(clientId)) throw new ApiError(404, 'unknown_connection_client', 'Choose Codex or Claude Code.');
    const id = clientId as ClientId;
    const snapshot = await this.#inspect(id);
    return { ok: true, schemaVersion: 1, client: await this.#withAuthentication(snapshot.view) };
  }

  async authenticationAction(clientId: string, action: 'sign-in' | 'cancel-sign-in', raw: unknown) {
    if (!CLIENT_IDS.has(clientId)) throw new ApiError(404, 'unknown_connection_client', 'Choose Codex or Claude Code.');
    if (!Body.safeParse(raw).success) throw new ApiError(400, 'invalid_body', 'The sign-in action takes an empty JSON object.');
    const id = clientId as ClientId;
    const snapshot = await this.#inspect(id, action === 'sign-in');
    if (action === 'sign-in' && !snapshot.view.executable) throw new ApiError(409, 'client_not_installed', snapshot.view.message);
    const authentication = action === 'sign-in' ? await this.#authentication.start(id, snapshot.view.executable!) : await this.#authentication.cancel(id, snapshot.view.executable);
    return { ok: true, schemaVersion: 1, client: await this.#withAuthentication(snapshot.view, authentication) };
  }

  async close(): Promise<void> { await this.#authentication.close(); }

  async #verifyBridge(id: ClientId, desired: DesiredConnection): Promise<ConnectionVerification> {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ai-workforce-setup', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workforce_list_projects', arguments: {} } },
    ];
    const outcome = await this.#command(desired.command, desired.args, frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
    let count = 0;
    let valid = false;
    if (outcomeOk(outcome)) {
      try {
        const output = outcome.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        const initialized = z.looseObject({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.looseObject({ serverInfo: z.looseObject({ name: z.literal('ai-workforce') }) }) }).safeParse(output.find((frame) => frame['id'] === 1));
        const listed = z.looseObject({ jsonrpc: z.literal('2.0'), id: z.literal(2), result: z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }) }).safeParse(output.find((frame) => frame['id'] === 2));
        count = listed.success ? listed.data.result.tools.length : 0;
        const reached = z.looseObject({ id: z.literal(3), result: z.looseObject({ isError: z.literal(false), structuredContent: z.looseObject({ schemaVersion: z.literal(1), projects: z.array(z.unknown()) }) }) }).safeParse(output.find((frame) => frame['id'] === 3));
        valid = initialized.success && listed.success && reached.success && output.length === 3 && count === MCP_TOOLS.length && MCP_TOOLS.every((tool) => listed.data.result.tools.some((item) => item.name === tool.name));
      } catch { /* Raw process output is intentionally never sent to a page. */ }
    }
    const value: ConnectionVerification = { state: valid ? 'verified' : 'failed', checkedAt: new Date().toISOString(), toolCount: valid ? count : 0,
      error: valid ? null : 'The connection was saved, but its tools did not complete verification. Restart AI Workforce and choose Verify again.' };
    this.#verification.set(id, { key: JSON.stringify(desired), value });
    this.#cache.delete(id);
    return value;
  }

  /** Same-target clicks share one operation; subsequent clicks re-read the
   * client's persisted config and become no-ops instead of duplicate adds. */
  async action(clientId: string, action: 'connect' | 'verify', raw: unknown) {
    if (!CLIENT_IDS.has(clientId)) throw new ApiError(404, 'unknown_connection_client', 'Choose Codex or Claude Code.');
    if (!Body.safeParse(raw).success) throw new ApiError(400, 'invalid_body', 'The connection action takes an empty JSON object.');
    const id = clientId as ClientId;
    const pending = this.#active.get(id);
    if (pending) return pending;
    const work = this.#act(id, action);
    this.#active.set(id, work);
    try { return await work; } finally { this.#active.delete(id); this.#cache.delete(id); }
  }

  async #act(id: ClientId, action: 'connect' | 'verify'): Promise<{ ok: true; schemaVersion: 1; client: ConnectionClientView; changed: boolean; message: string }> {
    const before = await this.#inspect(id, true);
    if (!before.view.installed) throw new ApiError(409, 'client_not_installed', before.view.message, [], { client: before.view });
    if (!before.view.configured && (!before.view.canConnect || action === 'verify')) {
      throw new ApiError(409, before.view.error?.code ?? 'client_not_connected', before.view.message, [], { client: before.view });
    }
    let changed = false;
    if (action === 'connect' && !before.view.configured) {
      // A parsed, recognized existing entry is the only one we may reconnect.
      // Claude's documented add refuses replacement, so remove its safe owned
      // user entry first. Codex add replaces its own named entry atomically.
      const reconnect = before.entry.kind !== 'missing';
      if (id === 'claude' && reconnect) {
        const removed = await this.#command(before.view.executable!, removeConnectionArgs(id));
        if (!outcomeOk(removed)) throw new ApiError(503, 'connection_update_failed', 'The previous AI Workforce connection could not be updated. No replacement was attempted.');
      }
      const added = await this.#command(before.view.executable!, addConnectionArgs(id, before.desired));
      // A timeout may have written the entry. Reconcile before retrying or
      // restoring; no raw CLI message or credential-bearing output is exposed.
      const after = await this.#inspect(id, true);
      if (!after.view.configured) {
        if (id === 'claude' && reconnect && after.entry.kind === 'missing' && before.entry.command && before.entry.args) {
          await this.#command(before.view.executable!, addConnectionArgs(id, { command: before.entry.command, args: before.entry.args }));
        }
        throw new ApiError(503, added.timedOut ? 'connection_setup_timeout' : 'connection_setup_failed', 'The coding agent did not confirm the new connection. Detect again to check its saved state, then retry.', [], { client: (await this.#inspect(id, true)).view });
      }
      changed = true;
    }
    const verification = await this.#verifyBridge(id, before.desired);
    const after = await this.#inspect(id, true);
    if (verification.state !== 'verified') throw new ApiError(503, 'connection_verification_failed', verification.error!, [], { client: after.view });
    return { ok: true, schemaVersion: 1, client: await this.#withAuthentication(after.view), changed, message: after.view.message };
  }
}
