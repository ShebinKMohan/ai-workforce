import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addConnectionArgs, CONNECTION_MAX_OUTPUT_BYTES, getConnectionArgs, parseConnectionEntry,
  removeConnectionArgs, runConnectionCommand, type ClientId, type CommandOutcome,
} from '../../src/connections/cli.js';

const success = (stdout: string): CommandOutcome => ({ stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null });
const desired = {
  command: '/opt/homebrew/bin/node',
  args: ['/Users/example/CursorFiles/AI Employee/dist/cli/index.js', 'mcp', '--server-url', 'http://127.0.0.1:4421'],
};

// Shapes recorded from isolated HOME/CODEX_HOME/CLAUDE_CONFIG_DIR commands on
// 2026-09-13: codex-cli 0.154.0 and Claude Code 2.1.236. No provider turn ran.
function codexOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'ai-workforce', enabled: true, disabled_reason: null,
    transport: { type: 'stdio', ...desired, env: null, env_vars: [], cwd: null },
    enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
    ...overrides,
  });
}

function claudeOutput(options: { args?: string; scope?: 'user' | 'local' | 'project'; environment?: string } = {}): string {
  const scope = options.scope ?? 'user';
  const labels = { user: 'User config (available in all your projects)', local: 'Local config (private to you in this project)', project: 'Project config (shared via .mcp.json)' };
  return `ai-workforce:\n  Scope: ${labels[scope]}\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${desired.command}\n  Args: ${options.args ?? desired.args.join(' ')}\n  Environment:${options.environment ?? ''}\n\nTo remove this server, run: claude mcp remove ai-workforce -s ${scope}\n`;
}

describe('connection inspection parsers', () => {
  it('retains Codex argument boundaries and disabled state without exposing environment values', () => {
    const result = parseConnectionEntry('codex', success(codexOutput({
      enabled: false,
      transport: { type: 'stdio', ...desired, env: { API_KEY: 'private-provider-value' }, env_vars: ['PRIVATE_KEY_NAME'], cwd: null },
      privateFutureMetadata: 'private-future-value',
    })));
    expect(result).toEqual({ kind: 'stdio', ...desired, scope: 'user', enabled: false, hasEnvironment: true });
    expect(JSON.stringify(result)).not.toMatch(/private-provider|PRIVATE_KEY|private-future/);
  });

  it('preserves the full space-containing Claude bridge path and isolates environment metadata', () => {
    expect(parseConnectionEntry('claude', success(claudeOutput()))).toEqual({ kind: 'stdio', ...desired, scope: 'user', hasEnvironment: false });
    for (const scope of ['user', 'local', 'project'] as const) {
      const result = parseConnectionEntry('claude', success(claudeOutput({ scope, environment: '\n    PRIVATE_KEY: private-provider-value' })));
      expect(result).toEqual({ kind: 'stdio', ...desired, scope, hasEnvironment: true });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_KEY|private-provider/);
    }
    expect(parseConnectionEntry('claude', success(claudeOutput({ args: `${desired.args[0]} mcp` })))).toMatchObject({ args: [desired.args[0], 'mcp'] });
  });

  it('recognizes only observed narrow not-found diagnostics and does not leak arbitrary failures', () => {
    expect(parseConnectionEntry('claude', { ...success(''), exitCode: 1, stderr: 'No MCP server named "ai-workforce". Configured servers: plugin:chrome-devtools-mcp:chrome-devtools, plugin:supabase:supabase\n' })).toEqual({ kind: 'missing' });
    const missing = {
      codex: "Error: No MCP server named 'ai-workforce' found.\n",
      claude: 'No MCP server named "ai-workforce". Run `claude mcp add` to add one.\n',
    };
    for (const client of ['codex', 'claude'] as const) {
      expect(parseConnectionEntry(client, { ...success(''), exitCode: 1, stderr: missing[client] })).toEqual({ kind: 'missing' });
      for (const failure of [
        { exitCode: 1, stderr: 'Configuration not found: private-provider-value' },
        { exitCode: 1, stderr: `${missing[client]}private-provider-value` },
        { exitCode: 1, stderr: missing[client].replaceAll('ai-workforce', 'another-server') },
        { exitCode: 1, stderr: missing[client], timedOut: true },
        { exitCode: 1, stderr: missing[client], signal: 'SIGKILL' as const },
        { exitCode: 1, stderr: missing[client], stdout: 'unexpected server output' },
        { spawnError: 'private-provider-value', exitCode: null },
        { exitCode: null, stderr: missing[client] },
      ]) {
        const result = parseConnectionEntry(client, { ...success(''), ...failure });
        expect(result.kind).toBe('unreadable');
        expect(JSON.stringify(result)).not.toMatch(/private-provider|unexpected server/);
      }
    }
  });

  it('never claims ownership of remote transports, custom options, wrong identities or malformed data', () => {
    const remote = parseConnectionEntry('codex', success(codexOutput({ transport: { type: 'streamable_http', url: 'https://example.test/private', http_headers: { Authorization: 'private-header' } } })));
    expect(remote.kind).toBe('other');
    expect(JSON.stringify(remote)).not.toMatch(/https|private-header|Authorization/);
    for (const custom of [
      { transport: { type: 'stdio', ...desired, cwd: '/custom/location' } },
      { enabled_tools: ['workforce_list_projects'] },
      { startup_timeout_sec: 60 },
    ]) expect(parseConnectionEntry('codex', success(codexOutput(custom))).kind).toBe('other');
    for (const invalid of [codexOutput({ name: 'other-server' }), '{}', 'invalid private-provider-value', codexOutput({ transport: { type: 'stdio', command: 'node', args: ['bad\nargument'] } })]) {
      expect(parseConnectionEntry('codex', success(invalid)).kind).toBe('unreadable');
    }
    expect(parseConnectionEntry('claude', success(claudeOutput({ args: `${desired.args.join(' ')} --custom private-provider-value` }))).kind).toBe('other');
    expect(parseConnectionEntry('claude', success(claudeOutput().replace('ai-workforce:', 'other-server:'))).kind).toBe('unreadable');
    expect(parseConnectionEntry('claude', success(claudeOutput().replace('  Args:', '  Command: fake\n  Args:'))).kind).toBe('unreadable');
    expect(parseConnectionEntry('claude', success(claudeOutput().replace('  Type: stdio', '  Type: http\n  URL: https://example.test/private')))).toMatchObject({ kind: 'other' });
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string { const root = mkdtempSync(path.join(os.tmpdir(), 'workforce-connection-test-')); roots.push(root); return root; }
function isolatedEnv(root: string): NodeJS.ProcessEnv {
  for (const name of ['home', 'codex', 'claude']) mkdirSync(path.join(root, name));
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'config'), NO_COLOR: '1', TERM: 'dumb' };
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

describe('bounded connection command runner', () => {
  it('preserves arguments and stdin literally, uses the supplied environment and does not start a shell', async () => {
    const root = tempRoot();
    const marker = path.join(root, 'must-not-exist');
    const args = ['with spaces', `$(touch ${marker})`, '`unexpected command`', '--literal'];
    const result = await runConnectionCommand({
      executable: process.execPath,
      args: ['-e', 'let text=""; process.stdin.on("data", d=>text+=d); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),text,env:process.env.CONNECTION_ONLY,cwd:process.cwd()})));', '--', ...args],
      env: { CONNECTION_ONLY: 'explicit-env' }, cwd: root, stdin: '{"method":"initialize"}\n{"method":"tools/list"}\n',
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, spawnError: null, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ args, text: '{"method":"initialize"}\n{"method":"tools/list"}\n', env: 'explicit-env', cwd: realpathSync(root) });
    expect(existsSync(marker)).toBe(false);
  });

  it('bounds output and stops the producing process instead of silently accepting truncated output', async () => {
    const result = await runConnectionCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(600000)); setInterval(()=>{},1000);'], env: {}, timeoutMs: 3_000 });
    expect(result.spawnError).toContain('output limit');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(CONNECTION_MAX_OUTPUT_BYTES);
    expect(result.signal).toBe('SIGTERM');
    expect(result.timedOut).toBe(false);
  });

  it('terminates a TERM-resistant process group and observes both child and descendant exit', async () => {
    const descendant = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)';
    const result = await runConnectionCommand({
      executable: process.execPath,
      args: ['-e', `const {spawn}=require("node:child_process"); process.on("SIGTERM",()=>{}); const child=spawn(process.execPath,["-e", ${JSON.stringify(descendant)}],{stdio:"ignore"}); process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);`],
      env: {}, timeoutMs: 500,
    });
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL', spawnError: null });
    const pids = JSON.parse(result.stdout) as { parent: number; child: number };
    expect(isAlive(pids.parent)).toBe(false);
    expect(isAlive(pids.child)).toBe(false);
  });

  it('cleans a remaining descendant even when its parent exited successfully', async () => {
    const result = await runConnectionCommand({
      executable: process.execPath,
      args: ['-e', 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)); child.unref();'],
      env: {}, timeoutMs: 3_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null });
    expect(isAlive(Number(result.stdout))).toBe(false);
  });

  it('reports spawn and invalid-bound failures without exposing paths or raw errors', async () => {
    const result = await runConnectionCommand({ executable: '/missing/private-provider-value', args: [], env: {} });
    expect(result.spawnError).toBe('The connection command could not be started.');
    expect(JSON.stringify(result)).not.toContain('private-provider-value');
    const oversized = await runConnectionCommand({ executable: '/missing', args: [], env: {}, stdin: 'x'.repeat(300_000) });
    expect(oversized.spawnError).toContain('limits');
  });
});

const runInstalled = process.env['WORKFORCE_REAL_CONNECTION_CLI_TESTS'] === '1';
describe.skipIf(!runInstalled)('installed coding-agent connection commands in isolated configuration', () => {
  it.each(['codex', 'claude'] as const)('adds, reads and removes only a disposable %s entry with spaces intact', async (client: ClientId) => {
    const root = tempRoot();
    const env = isolatedEnv(root);
    const script = path.join(root, 'server with spaces.mjs');
    const marker = path.join(root, 'received.jsonl');
    writeFileSync(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs'; const input=createInterface({input:process.stdin}); input.on('line',line=>{const frame=JSON.parse(line);appendFileSync(${JSON.stringify(marker)},JSON.stringify({method:frame.method})+'\\n');if(frame.id===undefined)return;const result=frame.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local-connection-fixture',version:'1'}}:frame.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\\n');});input.on('close',()=>process.exit(0));`);
    const executable = `/opt/homebrew/bin/${client}`;
    const fixture = { command: process.execPath, args: [script, 'mcp', '--server-url', 'http://127.0.0.1:4421'] };
    const run = (args: string[]) => runConnectionCommand({ executable, args, env, cwd: root, timeoutMs: 15_000 });
    expect(parseConnectionEntry(client, await run(getConnectionArgs(client)))).toEqual({ kind: 'missing' });
    expect(await run(addConnectionArgs(client, fixture))).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null });
    const result = parseConnectionEntry(client, await run(getConnectionArgs(client)));
    expect(result).toMatchObject({ kind: 'stdio', ...fixture, scope: 'user', hasEnvironment: false });
    if (existsSync(marker)) {
      const methods = readFileSync(marker, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { method: string }).method);
      expect(methods).toContain('initialize');
      expect(methods.every((method) => ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list', 'ping'].includes(method))).toBe(true);
    }
    expect(await run(removeConnectionArgs(client))).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null });
    expect(parseConnectionEntry(client, await run(getConnectionArgs(client)))).toEqual({ kind: 'missing' });
  }, 30_000);
});
