import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsApi, type ConnectionsApiOptions } from '../../src/server/connections-api.js';
import { type CommandOutcome, type DesiredConnection, type ConnectionCommand } from '../../src/connections/cli.js';
import { MCP_TOOLS } from '../../src/mcp/tools.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';
import { originFor, rawRequest } from './support.js';

const ok = (stdout = ''): CommandOutcome => ({ stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null });
const servers: OfficeServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); cleanupAll(); });

function fixture() {
  const saved = new Map<string, DesiredConnection>();
  const settings = { installed: true, verify: true, addFails: false, timedOutAdd: false, custom: false };
  const resolve: NonNullable<ConnectionsApiOptions['resolve']> = adapter => {
    const name = adapter === 'codex' ? 'codex' : 'claude';
    const selected = { path: `/fixture/${name}`, realPath: `/fixture/${name}`, source: 'path' as const, origins: [], selected: true };
    return { adapter, executableName: name, requestedOverride: null, installations: settings.installed ? [selected] : [], selected: settings.installed ? selected : null, searchedLocations: [], diagnostics: [] };
  };
  const run = vi.fn(async (command: ConnectionCommand): Promise<CommandOutcome> => {
    const client = command.executable.endsWith('claude') ? 'claude' : 'codex';
    const args = command.args;
    if (args[0] === '--version') return ok(client === 'codex' ? 'codex-cli 0.154.0' : '2.1.236 (Claude Code)');
    if (args.join(' ') === 'login status') return ok('Logged in using ChatGPT');
    if (args.join(' ') === 'auth status') return ok(JSON.stringify({ loggedIn: true }));
    if (command.stdin) {
      const frames = command.stdin.trim().split('\n').map(line => JSON.parse(line));
      expect(frames.map(frame => frame.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      expect(frames[3].params).toEqual({ name: 'workforce_list_projects', arguments: {} });
      return ok([
        { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'ai-workforce' } } },
        { jsonrpc: '2.0', id: 2, result: { tools: MCP_TOOLS } },
        { jsonrpc: '2.0', id: 3, result: { isError: !settings.verify, structuredContent: settings.verify ? { schemaVersion: 1, projects: [] } : { error: { code: 'server_unreachable' } } } },
      ].map(frame => JSON.stringify(frame)).join('\n') + '\n');
    }
    if (args[1] === 'get') {
      const entry = saved.get(client);
      if (!entry) return { ...ok(), exitCode: 1, stderr: client === 'codex' ? "Error: No MCP server named 'ai-workforce' found.\n" : 'No MCP server named "ai-workforce". Run `claude mcp add` to add one.\n' };
      if (client === 'codex') return ok(JSON.stringify({ name: 'ai-workforce', enabled: true, transport: { type: 'stdio', ...entry }, ...(settings.custom ? { enabled_tools: ['workforce_list_projects'] } : {}) }));
      return ok(`ai-workforce:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${entry.command}\n  Args: ${entry.args.join(' ')}\n  Environment:\n\nTo remove this server, run: claude mcp remove ai-workforce -s user\n`);
    }
    if (args[1] === 'remove') { saved.delete(client); return ok(); }
    if (args[1] === 'add') {
      if (settings.addFails) return { ...ok(), exitCode: 1, stderr: 'private-provider-value' };
      const index = args.indexOf('--'); saved.set(client, { command: args[index + 1]!, args: args.slice(index + 2) });
      return settings.timedOutAdd ? { ...ok(), timedOut: true } : ok();
    }
    throw new Error('Unexpected command');
  });
  const options = { stateRoot: tempDir(), serverUrl: () => 'http://127.0.0.1:4421', resolve, run, bridgeCommand: '/fixture/node', bridgeEntry: '/fixture/AI Employee/dist/cli/index.js', bridgeExists: () => true,
    env: { PATH: '/fixture', HOME: '/fixture/home', CODEX_HOME: '/fixture/codex-config', ANTHROPIC_API_KEY: 'private-provider-value' } };
  return { api: new ConnectionsApi(options), options, saved, settings, run };
}

describe('one-click coding-agent connections', () => {
  it('scans without changing configuration or running a model; sends only sanitized metadata', async () => {
    const { api, run, saved } = fixture();
    const result = await api.list();
    expect(result.clients.map(client => client.status)).toEqual(['not_connected', 'not_connected']);
    expect(saved.size).toBe(0); expect(run).toHaveBeenCalledTimes(6);
    expect(run.mock.calls.every(([command]) => !command.env['ANTHROPIC_API_KEY'] && command.env['CODEX_HOME'] === '/fixture/codex-config')).toBe(true);
    expect(result.referenceConfiguration.mcpServers['ai-workforce'].args[0]).toContain('AI Employee');
    expect(result.bridge).toEqual({ name: 'ai-workforce', transport: 'stdio', serverUrl: 'http://127.0.0.1:4421', scope: 'user', toolCount: 7, clientSessionStatus: 'not_observed' });
    await api.list(); expect(run).toHaveBeenCalledTimes(8); // Account state is refreshed even while MCP metadata is cached.
  });

  it.each(['codex', 'claude'] as const)('connects %s once, verifies actual reads, and makes repeated clicks a no-op', async client => {
    const { api, run, saved } = fixture();
    const [first, concurrent] = await Promise.all([api.action(client, 'connect', {}), api.action(client, 'connect', {})]);
    expect(first).toMatchObject({ changed: true, client: { status: 'connected', configured: true, toolsVerified: true, clientReloadRequired: true, verification: { toolCount: 7 } } });
    expect(concurrent).toEqual(first);
    const again = await api.action(client, 'connect', {}); expect(again.changed).toBe(false);
    expect(saved.size).toBe(1);
    expect(run.mock.calls.filter(([command]) => command.args[1] === 'add')).toHaveLength(1);
    expect((await api.action(client, 'verify', {})).changed).toBe(false);
  });

  it('a saved entry and tool listing cannot pass verification when the local workforce cannot be read', async () => {
    const { api, settings, saved } = fixture(); settings.verify = false;
    await expect(api.action('codex', 'connect', {})).rejects.toMatchObject({ code: 'connection_verification_failed', extra: { client: { configured: true, toolsVerified: false, verification: { state: 'failed' } } } });
    expect(saved.has('codex')).toBe(true);
    settings.verify = true; expect((await api.action('codex', 'verify', {})).client.toolsVerified).toBe(true);
  });

  it('keeps unrelated or customized entries untouched', async () => {
    const { api, saved, settings, run } = fixture();
    saved.set('codex', { command: '/custom/node', args: ['/another/server.js', 'mcp'] });
    await expect(api.action('codex', 'connect', {})).rejects.toMatchObject({ code: 'connection_name_conflict' });
    saved.set('codex', { command: '/fixture/node', args: ['/fixture/AI Employee/dist/cli/index.js', 'mcp', '--server-url', 'http://127.0.0.1:4328'] }); settings.custom = true;
    await expect(api.action('codex', 'connect', {})).rejects.toMatchObject({ code: 'connection_name_conflict' });
    expect(run.mock.calls.every(([command]) => !['add', 'remove'].includes(command.args[1] ?? ''))).toBe(true);
  });

  it('reconciles a timeout that already saved the correct connection', async () => {
    const { api, settings, run } = fixture(); settings.timedOutAdd = true;
    expect((await api.action('codex', 'connect', {})).client.toolsVerified).toBe(true);
    expect(run.mock.calls.filter(([command]) => command.args[1] === 'add')).toHaveLength(1);
  });

  it.each(['codex', 'claude'] as const)('repairs %s after the local service moves without retaining an old verified state', async client => {
    const { api, options, saved } = fixture();
    expect((await api.action(client, 'connect', {})).client.toolsVerified).toBe(true);
    options.serverUrl = () => 'http://127.0.0.1:4422';
    const stale = (await api.list(true)).clients.find(item => item.id === client)!;
    expect(stale).toMatchObject({ status: 'needs_update', toolsVerified: false, canConnect: true, action: 'reconnect' });
    const repaired = await api.action(client, 'connect', {});
    expect(repaired).toMatchObject({ changed: true, client: { status: 'connected', configured: true, toolsVerified: true } });
    expect(saved.get(client)?.args.at(-1)).toBe('http://127.0.0.1:4422');
    expect((await api.list()).bridge.clientSessionStatus).toBe('not_observed');
  });

  it('reports unavailable installations and invalid actions without trying to add anything', async () => {
    const { api, settings, run } = fixture(); settings.installed = false;
    expect((await api.list()).clients.every(client => !client.installed && !client.canConnect)).toBe(true);
    await expect(api.action('codex', 'connect', {})).rejects.toMatchObject({ code: 'client_not_installed' });
    await expect(api.action('unexpected', 'connect', {})).rejects.toMatchObject({ status: 404 });
    await expect(api.action('codex', 'connect', { executable: '/custom' })).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it('protects installation writes with the existing local Origin and session token', async () => {
    const { options, run } = fixture();
    const server = await startOfficeServer({ stateRoot: options.stateRoot, port: 0, discover: async () => [], connections: options, env: options.env }); servers.push(server);
    const read = await rawRequest(server, { path: '/api/connections' }); expect(read.status).toBe(200);
    run.mockClear();
    const route = '/api/connections/codex/connect';
    for (const headers of [ {}, { origin: 'https://untrusted.example', 'x-workforce-token': server.token }, { origin: originFor(server) } ]) {
      expect((await rawRequest(server, { path: route, method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    }
    expect(run).not.toHaveBeenCalled();
    const accepted = await rawRequest(server, { path: route, method: 'POST', headers: { origin: originFor(server), 'x-workforce-token': server.token, 'content-type': 'application/json' }, body: '{}' });
    expect(accepted.status).toBe(200); expect(JSON.parse(accepted.body).client.toolsVerified).toBe(true);
  });
});
