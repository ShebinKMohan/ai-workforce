import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsApi, type ConnectionsApiOptions } from '../../src/server/connections-api.js';
import { runConnectionCommand } from '../../src/connections/cli.js';
import { AuthenticationManager } from '../../src/connections/authentication.js';
import { startOfficeServer, type OfficeServer } from '../../src/server/index.js';
import { originFor, rawRequest } from './support.js';

const roots: string[] = [];
const apis: ConnectionsApi[] = [];
const servers: OfficeServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const api of apis.splice(0)) await api.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const waitUntil = async (predicate: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('fixture condition did not settle');
};

function fixture(timeoutMs = 3_000) {
  const root = mkdtempSync(path.join(tmpdir(), 'workforce-native-login-')); roots.push(root);
  const onChanged = vi.fn();
  const executables = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') };
  const source = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const root=path.dirname(__filename),id=path.basename(__filename),args=process.argv.slice(2).join(' '),state=path.join(root,id+'.state');
fs.appendFileSync(path.join(root,'calls'),id+':'+args+'\\n');
if(args==='--version'){console.log(id==='codex'?'codex-cli 0.154.0':'2.1.236 (Claude Code)');process.exit(0);}
if(args==='mcp get ai-workforce --json'||args==='mcp get ai-workforce'){console.error(id==='codex'?"Error: No MCP server named 'ai-workforce' found.":'No MCP server named "ai-workforce". Run \\u0060claude mcp add\\u0060 to add one.');process.exit(1);}
if(args==='login status'||args==='auth status'){const logged=fs.existsSync(state)&&fs.readFileSync(state,'utf8')==='yes';if(id==='claude')console.log(JSON.stringify({loggedIn:logged,email:'private-account@example.invalid'}));else (logged?console.log:console.error)(logged?'Logged in using ChatGPT':'Not logged in');process.exit(logged?0:1);}
if(args==='login'||args==='auth login'){
fs.writeFileSync(path.join(root,id+'.pid'),String(process.pid));const mode=fs.readFileSync(path.join(root,id+'.mode'),'utf8');
if(mode==='denied'){console.error('access_denied private-provider-token');process.exit(1);}
if(mode==='account-after-failure'||mode==='account-after-denial'){fs.writeFileSync(state,'yes');console.error(mode==='account-after-denial'?'access_denied private-provider-token':'private-provider-token');process.exit(1);}
if(mode==='false-success'){console.log('Login successful private-provider-token');process.exit(0);}
if(mode==='success'){setTimeout(()=>{fs.writeFileSync(state,'yes');process.exit(0);},180);}else{process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
}else{console.error('Unexpected command');process.exit(5);}
`;
  for (const [id, file] of Object.entries(executables)) { writeFileSync(file, source, { mode: 0o700 }); writeFileSync(path.join(root, `${id}.mode`), 'success'); }
  mkdirSync(path.join(root, 'home'));
  const resolve: NonNullable<ConnectionsApiOptions['resolve']> = adapter => {
    const id = adapter === 'codex' ? 'codex' : 'claude';
    const selected = { path: executables[id], realPath: executables[id], selected: true, source: 'override' as const, origins: [] };
    return { adapter, executableName: id, requestedOverride: executables[id], installations: [selected], selected, searchedLocations: [], diagnostics: [] };
  };
  const options = { stateRoot: path.join(root, 'state'), serverUrl: () => 'http://127.0.0.1:4421', resolve, bridgeExists: () => true,
    env: { HOME: path.join(root, 'home'), PATH: process.env.PATH, ANTHROPIC_API_KEY: 'private-key-that-must-not-pass' },
    onAuthenticationChanged: onChanged, loginTimeoutMs: timeoutMs };
  const api = new ConnectionsApi(options); apis.push(api);
  return { api, root, executables, onChanged, options, mode: (id: string, value: string) => writeFileSync(path.join(root, `${id}.mode`), value), calls: () => existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n') : [] };
}

async function httpFixture() {
  const context = fixture();
  const { options } = context;
  const server = await startOfficeServer({ stateRoot: options.stateRoot, port: 0, discover: async () => [], connections: options, env: options.env });
  servers.push(server);
  const writeHeaders = { origin: originFor(server), 'x-workforce-token': server.token, 'content-type': 'application/json' };
  return { ...context, server, writeHeaders };
}

describe('native authentication HTTP boundary', () => {
  it('reads account status without starting login or changing the MCP entry', async () => {
    const { server, calls } = await httpFixture();
    const read = await rawRequest(server, { path: '/api/connections/codex/auth' });
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toMatchObject({ ok: true, schemaVersion: 1, client: { id: 'codex', configured: false,
      authentication: { state: 'needs_auth', auth: 'logged_out' }, execution: { usable: false } } });
    expect(read.body).not.toMatch(/private-account|private-provider|private-key/);
    const before = calls().length;
    expect((await rawRequest(server, { path: '/api/connections/codex/auth' })).status).toBe(200);
    expect(calls().slice(before)).toEqual(['codex:login status']);
    expect(calls().some(line => line === 'codex:login' || line === 'claude:auth login' || /mcp (?:add|remove)/.test(line))).toBe(false);
  });

  it('rejects foreign reads and unauthenticated or malformed writes before any CLI spawn', async () => {
    const { server, calls, writeHeaders } = await httpFixture();
    for (const action of ['sign-in', 'cancel-sign-in']) {
      for (const headers of [
        {},
        { origin: 'https://untrusted.example', 'x-workforce-token': server.token },
        { origin: originFor(server) },
        { origin: originFor(server), 'x-workforce-token': 'incorrect-token' },
        { ...writeHeaders, host: 'untrusted.example' },
      ]) {
        const response = await rawRequest(server, { path: `/api/connections/codex/${action}`, method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(403);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
      const invalid = await rawRequest(server, { path: `/api/connections/codex/${action}`, method: 'POST', headers: writeHeaders, body: '{"executable":"/must-not-launch"}' });
      expect(invalid.status).toBe(400);
      expect((await rawRequest(server, { path: `/api/connections/codex/${action}` })).status).toBe(405);
    }
    for (const headers of [{ origin: 'https://untrusted.example' }, { host: 'untrusted.example' }]) {
      expect((await rawRequest(server, { path: '/api/connections/codex/auth', headers })).status).toBe(403);
    }
    expect((await rawRequest(server, { path: '/api/connections/codex/auth', method: 'POST', headers: writeHeaders, body: '{}' })).status).toBe(405);
    expect((await rawRequest(server, { path: '/api/connections/unknown/auth' })).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it.each(['codex', 'claude'] as const)('returns pending promptly and observes one completed %s login through HTTP', async id => {
    const { server, calls, writeHeaders } = await httpFixture();
    const route = `/api/connections/${id}/sign-in`;
    const responses = await Promise.all([
      rawRequest(server, { path: route, method: 'POST', headers: writeHeaders, body: '{}' }),
      rawRequest(server, { path: route, method: 'POST', headers: writeHeaders, body: '{}' }),
    ]);
    const first = JSON.parse(responses[0]!.body), duplicate = JSON.parse(responses[1]!.body);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(first).toMatchObject({ ok: true, schemaVersion: 1, client: { authentication: { state: 'pending', canSignIn: false }, execution: { usable: false } } });
    expect(first.client.authentication.login.id).toBe(duplicate.client.authentication.login.id);
    await waitUntil(async () => {
      const result = await rawRequest(server, { path: `/api/connections/${id}/auth` });
      expect(result.status).toBe(200);
      return JSON.parse(result.body).client.authentication.state === 'connected';
    });
    const connected = await rawRequest(server, { path: `/api/connections/${id}/auth` });
    expect(JSON.parse(connected.body)).toMatchObject({ client: { configured: false, authentication: { state: 'connected', auth: 'logged_in' }, execution: { usable: true } } });
    expect(connected.body).not.toMatch(/private-account|private-provider|private-key/);
    expect(calls().filter(line => line === `${id}:${id === 'claude' ? 'auth login' : 'login'}`)).toHaveLength(1);
    expect(calls().every(line => /:(?:--version|mcp get ai-workforce(?: --json)?|login(?: status)?|auth (?:status|login))$/.test(line))).toBe(true);
  });

  it('cancels through the protected HTTP route and confirms the owned login stopped', async () => {
    const { server, mode, root, writeHeaders, calls } = await httpFixture();
    mode('codex', 'wait');
    const started = await rawRequest(server, { path: '/api/connections/codex/sign-in', method: 'POST', headers: writeHeaders, body: '{}' });
    expect(started.status).toBe(200);
    await waitUntil(() => existsSync(path.join(root, 'codex.pid')));
    const pid = Number(readFileSync(path.join(root, 'codex.pid'), 'utf8'));
    const cancelled = await rawRequest(server, { path: '/api/connections/codex/cancel-sign-in', method: 'POST', headers: writeHeaders, body: '{}' });
    expect(cancelled.status).toBe(200);
    expect(JSON.parse(cancelled.body)).toMatchObject({ client: { authentication: { state: 'cancelled', canSignIn: true }, execution: { usable: false } } });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(JSON.parse((await rawRequest(server, { path: '/api/connections/codex/auth' })).body).client.authentication.state).toBe('cancelled');
    expect(calls().filter(line => line === 'codex:login')).toHaveLength(1);
  });

  it('server close waits for a pending login to stop', async () => {
    const { server, mode, root, writeHeaders } = await httpFixture();
    mode('claude', 'wait');
    expect((await rawRequest(server, { path: '/api/connections/claude/sign-in', method: 'POST', headers: writeHeaders, body: '{}' })).status).toBe(200);
    await waitUntil(() => existsSync(path.join(root, 'claude.pid')));
    const pid = Number(readFileSync(path.join(root, 'claude.pid'), 'utf8'));
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe('native one-click authentication', () => {
  it.each(['codex', 'claude'] as const)('starts one owned %s login and checks the native account status before enabling execution', async id => {
    const { api, calls, root, onChanged } = fixture();
    expect((await api.list()).clients.find(client => client.id === id)).toMatchObject({ authentication: { state: 'needs_auth', canSignIn: true }, execution: { usable: false } });
    const [a,b] = await Promise.all([api.authenticationAction(id, 'sign-in', {}), api.authenticationAction(id, 'sign-in', {})]);
    expect(a.client.authentication).toMatchObject({ state: 'pending', canSignIn: false });
    expect(a.client.authentication.login?.id).toBe(b.client.authentication.login?.id);
    expect(a.client.execution.usable).toBe(false);
    await waitUntil(async () => (await api.authenticationStatus(id)).client.authentication.state === 'connected');
    const connected = (await api.authenticationStatus(id)).client;
    expect(connected).toMatchObject({ authentication: { state: 'connected', auth: 'logged_in' }, execution: { usable: true }, configured: false });
    expect(calls().filter(line => line === `${id}:${id==='claude'?'auth login':'login'}`)).toHaveLength(1);
    const before = calls().length; await api.authenticationAction(id, 'sign-in', {});
    expect(calls().slice(before).filter(line => line === `${id}:${id==='claude'?'auth login':'login'}`)).toHaveLength(0);
    expect(onChanged).toHaveBeenCalled();
    expect(JSON.stringify(connected)).not.toMatch(/private-account|private-provider-token|private-key/);
    writeFileSync(path.join(root, `${id}.state`), 'no');
    expect((await api.authenticationStatus(id)).client).toMatchObject({ authentication: { state: 'needs_auth' }, execution: { usable: false } });
  });

  it('does not accept successful login prose or exit status without authenticated status', async () => {
    const { api, mode } = fixture(); mode('claude','false-success');
    await api.authenticationAction('claude','sign-in',{});
    await waitUntil(async()=> (await api.authenticationStatus('claude')).client.authentication.state !== 'pending');
    const client=(await api.authenticationStatus('claude')).client;
    expect(client).toMatchObject({ authentication: { state:'failed', auth:'logged_out', canSignIn:true }, execution:{ usable:false } });
    expect(JSON.stringify(client)).not.toContain('private-provider-token');
  });

  it.each([
    ['account-after-failure', 'did not finish successfully'],
    ['account-after-denial', 'was denied'],
  ])('preserves usable account evidence while reporting the %s attempt outcome', async (modeName, expectedOutcome) => {
    const { api, mode } = fixture(); mode('codex', modeName!);
    expect((await api.authenticationAction('codex', 'sign-in', {})).client.authentication.state).toBe('pending');
    await waitUntil(async () => (await api.authenticationStatus('codex')).client.authentication.state !== 'pending');
    for (let i = 0; i < 2; i++) {
      const result = (await api.authenticationStatus('codex')).client;
      expect(result).toMatchObject({ authentication: { state: 'connected', auth: 'logged_in' }, execution: { usable: true } });
      expect(result.authentication.message).toContain(`The last sign-in attempt ${expectedOutcome}.`);
      expect(JSON.stringify(result)).not.toContain('private-provider-token');
    }
  });

  it('reports provider denial and allows a deliberate retry', async () => {
    const { api, mode } = fixture(); mode('claude','denied');
    await api.authenticationAction('claude','sign-in',{});
    await waitUntil(async()=> (await api.authenticationStatus('claude')).client.authentication.state === 'denied');
    expect((await api.authenticationStatus('claude')).client.execution.usable).toBe(false);
    mode('claude','success'); await api.authenticationAction('claude','sign-in',{});
    await waitUntil(async()=> (await api.authenticationStatus('claude')).client.authentication.state === 'connected');
  });

  it('cancels a TERM-resistant owned process and reports its observed stop', async () => {
    const { api, mode, root } = fixture(); mode('codex','wait');
    await api.authenticationAction('codex','sign-in',{});
    await waitUntil(()=>existsSync(path.join(root,'codex.pid')));
    const pid=Number(readFileSync(path.join(root,'codex.pid'),'utf8'));
    const result=await api.authenticationAction('codex','cancel-sign-in',{});
    expect(result.client).toMatchObject({ authentication:{state:'cancelled',canSignIn:true},execution:{usable:false} });
    expect(()=>process.kill(pid,0)).toThrow();
  });

  it('expires a pending native flow without leaving its owned login process alive', async () => {
    const { api, mode, root } = fixture(250); mode('claude','wait');
    await api.authenticationAction('claude','sign-in',{});
    await waitUntil(()=>existsSync(path.join(root,'claude.pid')));
    const pid=Number(readFileSync(path.join(root,'claude.pid'),'utf8'));
    await waitUntil(async()=> (await api.authenticationStatus('claude')).client.authentication.state === 'failed');
    expect((await api.authenticationStatus('claude')).client.authentication.message).toContain('timed out');
    expect(()=>process.kill(pid,0)).toThrow();
  });

  it('validates actions before invoking any login and stops owned login on server close', async () => {
    const { api, mode, calls, root }=fixture();
    await expect(api.authenticationAction('other','sign-in',{})).rejects.toMatchObject({status:404});
    await expect(api.authenticationAction('codex','sign-in',{executable:'/override'})).rejects.toMatchObject({status:400});
    expect(existsSync(path.join(root,'calls'))).toBe(false);
    mode('codex','wait'); await api.authenticationAction('codex','sign-in',{});
    await waitUntil(()=>existsSync(path.join(root,'codex.pid')));
    await api.close();
    expect(()=>process.kill(Number(readFileSync(path.join(root,'codex.pid'),'utf8')),0)).toThrow();
    expect(calls().some(line=>/\bexec\b|\b-p\b|setup-token/.test(line))).toBe(false);
  });
});

it('the bounded runner handles cancellation before process creation', async()=>{
  const cancellation=new AbortController(); cancellation.abort();
  const result=await runConnectionCommand({executable:'/must-not-start',args:['login'],env:{},signal:cancellation.signal});
  expect(result).toMatchObject({exitCode:null,signal:'SIGTERM',spawnError:null});
});

it('blocks another login when the owned process stop cannot be confirmed', async () => {
  let loggedIn = false;
  const launch = vi.fn(async () => {
    loggedIn = true;
    return { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: true, spawnError: 'The connection command process group could not be stopped.' };
  });
  const manager = new AuthenticationManager({ probe: async () => ({ auth: loggedIn ? 'logged_in' : 'logged_out', detail: '' }), launch });
  await manager.start('codex', '/fixture/codex');
  await waitUntil(async () => (await manager.status('codex', '/fixture/codex')).state !== 'pending');
  expect(await manager.status('codex', '/fixture/codex')).toMatchObject({ state: 'failed', auth: 'unknown', canSignIn: false });
  await manager.start('codex', '/fixture/codex');
  expect(launch).toHaveBeenCalledTimes(1);
  await manager.close();
});

it('can cancel its pending owned login after the selected installation disappears', async () => {
  const launch = vi.fn((_id, _executable, signal: AbortSignal) => new Promise<Awaited<ReturnType<typeof runConnectionCommand>>>(resolve => {
    signal.addEventListener('abort', () => resolve({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: false, spawnError: null }), { once: true });
  }));
  const manager = new AuthenticationManager({ probe: async () => ({ auth: 'logged_out', detail: '' }), launch });
  await manager.start('codex', '/fixture/removed-codex');
  expect(await manager.status('codex', null)).toMatchObject({ state: 'pending', login: { executable: '/fixture/removed-codex' } });
  expect((await manager.cancel('codex', null)).state).not.toBe('pending');
  await manager.close();
});

it('reports a cancelled attempt alongside independently confirmed account readiness', async () => {
  let loggedIn = false;
  const launch = vi.fn((_id, _executable, signal: AbortSignal) => new Promise<Awaited<ReturnType<typeof runConnectionCommand>>>(resolve => {
    signal.addEventListener('abort', () => {
      loggedIn = true;
      resolve({ stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', timedOut: false, spawnError: null });
    }, { once: true });
  }));
  const manager = new AuthenticationManager({ probe: async () => ({ auth: loggedIn ? 'logged_in' : 'logged_out', detail: '' }), launch });
  await manager.start('codex', '/fixture/codex');
  const result = await manager.cancel('codex', '/fixture/codex');
  expect(result).toMatchObject({ state: 'connected', auth: 'logged_in' });
  expect(result.message).toContain('The last sign-in attempt was cancelled.');
  expect((await manager.status('codex', '/fixture/codex')).message).toContain('was cancelled');
  await manager.close();
});
