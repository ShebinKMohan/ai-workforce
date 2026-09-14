import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionSummaryStore, ConnectionsStore, connectionPresentation, renderConnectionsPage, summarizeConnections } from '../../src/headquarters/connections.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const client = (overrides = {}) => ({ id: 'codex', name: 'Codex', installed: true, executable: '/local/bin/codex', version: '1.0', status: 'not_connected', configured: false, canConnect: true, action: 'connect', scope: 'user', toolsVerified: false, verification: { state: 'not_checked', checkedAt: null, toolCount: 0, error: null }, clientReloadRequired: false, message: '', error: null, setupUrl: 'https://developers.openai.com/codex/', ...overrides });
const ready = (overrides = {}) => client({ status: 'connected', configured: true, action: null, toolsVerified: true, verification: { state: 'verified', checkedAt: '2026-09-13T12:00:00.000Z', toolCount: 7, error: null }, clientReloadRequired: true, ...overrides });
const snapshot = clients => ({ ok: true, schemaVersion: 1, serverUrl: 'http://127.0.0.1:4421', checkedAt: '2026-09-13T12:00:00.000Z', clients });

test('automatic scan only reads installations and never configures or starts an agent', async () => {
  const calls = [];
  const store = new ConnectionsStore(async (...args) => { calls.push(args); return snapshot([client()]); });
  await store.scan();
  assert.deepEqual(calls, [['/api/connections']]);
  assert.equal(store.clients[0].configured, false);
  assert.equal(connectionPresentation(store.clients[0]).label, 'Ready to connect');
  await store.scan(true);
  assert.equal(calls[1][0], '/api/connections?refresh=1');
});

test('one Connect action invokes the server once while duplicate clicks share the result', async () => {
  const pending = deferred(), calls = [];
  const store = new ConnectionsStore(async (...args) => { calls.push(args); return pending.promise; });
  store.clients = [client()];
  const first = store.perform('codex', 'connect'); const second = store.perform('codex', 'connect');
  assert.equal(store.actions.get('codex'), 'connect');
  assert.equal(connectionPresentation(client(), { action: store.actions.get('codex') }).label, 'Connecting…');
  assert.deepEqual(calls, [['/api/connections/codex/connect', {}]]);
  pending.resolve({ ok: true, client: ready(), changed: true }); await Promise.all([first, second]);
  assert.equal(connectionPresentation(store.clients[0]).label, 'Connection ready');
  assert.equal(store.pending.size, 0); assert.equal(store.actions.size, 0);
});

test('an older scan cannot undo a connection installed and verified during that scan', async () => {
  const earlier = deferred();
  const store = new ConnectionsStore(async (path, body) => body ? { ok: true, client: ready() } : earlier.promise);
  store.clients = [client()]; const scan = store.scan(); await store.perform('codex', 'connect');
  earlier.resolve(snapshot([client()])); await scan;
  assert.equal(store.clients[0].configured, true);
  assert.equal(store.clients[0].toolsVerified, true);
});

test('configured and connected labels alone cannot claim readiness without tool verification', () => {
  const saved = client({ configured: true, status: 'connected', action: null });
  assert.equal(connectionPresentation(saved).ready, false);
  assert.equal(connectionPresentation(saved).label, 'Connection saved');
  assert.equal(connectionPresentation({ ...saved, toolsVerified: true }).ready, false);
  assert.equal(connectionPresentation(ready()).ready, true);
});

test('a failed verification retains known setup and displays the current error instead of ready', async () => {
  const failure = Object.assign(new Error('Local workforce is unavailable.'), { data: { client: ready({ toolsVerified: false, verification: { state: 'failed', checkedAt: null, toolCount: 0, error: 'Local workforce is unavailable.' } }) } });
  const store = new ConnectionsStore(async () => { throw failure; });
  store.clients = [ready(), ready({ id: 'claude', name: 'Claude Code' })];
  await assert.rejects(store.perform('codex', 'verify'), /unavailable/);
  assert.equal(store.clients[0].configured, true);
  const observed = connectionPresentation(store.clients[0], { error: store.errors.get('codex') });
  assert.equal(observed.ready, false); assert.equal(observed.tone, 'error');
  assert.equal(connectionPresentation(store.clients[1]).ready, true);
  assert.equal(store.actions.size, 0);
});

test('the check button performs explicit verification without rewriting setup', async () => {
  const calls = [];
  const store = new ConnectionsStore(async (...args) => { calls.push(args); return { ok: true, client: ready(), changed: false }; });
  store.clients = [ready()]; await store.perform('codex', 'verify');
  assert.deepEqual(calls, [['/api/connections/codex/verify', {}]]);
});

test('an unrelated existing configuration exposes its blocker without an overwrite action', async () => {
  const calls = [];
  const conflict = client({ status: 'conflict', canConnect: false, action: null, message: 'Another connection already uses this name.' });
  const store = new ConnectionsStore(async (...args) => { calls.push(args); }); store.clients = [conflict];
  await assert.rejects(store.perform('codex', 'connect'), /Another connection/);
  assert.equal(calls.length, 0);
  const html = renderConnectionsPage(store);
  assert.match(html, /Another connection already uses this name/);
  assert.doesNotMatch(html, /data-connection-action="connect"/);
});

test('primary page offers app buttons and natural handoff guidance without terminal commands', () => {
  const store = new ConnectionsStore(async () => {}); store.clients = [client(), ready({ id: 'claude', name: 'Claude Code' })];
  const html = renderConnectionsPage(store, { advancedConfig: '{"mcpServers":{}}' });
  const primary = html.split('<details class="connection-advanced"')[0];
  assert.match(primary, /data-connection-action="connect"/);
  assert.match(primary, /Connection ready/);
  assert.match(primary, /tools verified/);
  assert.match(primary, /Reopen Claude Code to load the connection/);
  assert.match(primary, /Send a plan from your coding agent/);
  assert.match(primary, /Connect installed agents/);
  assert.doesNotMatch(primary, /mcp add|workforce_submit_plan|idempotencyKey|<pre|<code|terminal|clipboard/i);
  assert.match(html, /<details class="connection-advanced" data-connection-advanced>/);
});

test('missing agent gets an official setup link and no broken Connect button', () => {
  const store = new ConnectionsStore(async () => {});
  store.clients = [client({ installed: false, configured: false, status: 'not_installed', canConnect: false, action: null })];
  const html = renderConnectionsPage(store);
  assert.match(html, /Not found on this computer/);
  assert.match(html, /Get Codex/);
  assert.match(html, /href="https:\/\/developers.openai.com\/codex\/"/);
  assert.doesNotMatch(html, /data-connection-action="connect"/);
});

test('provider errors render as text and an interrupted scan retains the recorded setup', async () => {
  const store = new ConnectionsStore(async () => { throw new Error('<script>not executable</script>'); });
  store.clients = [ready()]; await store.scan();
  assert.equal(store.clients[0].configured, true);
  const html = renderConnectionsPage(store);
  assert.match(html, /last detected setup/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('one setup click connects available clients once and preserves partial success', async () => {
  const pending = deferred(), calls = [];
  const failed = client({ id: 'claude', name: 'Claude Code', configured: true, canConnect: false, status: 'error',
    toolsVerified: false, verification: { state: 'failed', checkedAt: null, toolCount: 0, error: 'Bridge unavailable' } });
  const store = new ConnectionsStore(async (path, body) => {
    calls.push([path, body]);
    if (path.includes('/codex/')) return pending.promise;
    throw Object.assign(new Error('Bridge unavailable'), { data: { client: failed } });
  });
  const custom = client({ id: 'external', name: 'Other agent', status: 'conflict', canConnect: false });
  store.clients = [client(), client({ id: 'claude', name: 'Claude Code' }), custom];
  const first = store.connectInstalled(), duplicate = store.connectInstalled();
  assert.equal(store.connectingAll, true);
  assert.deepEqual(calls, [['/api/connections/codex/connect', {}]]);
  pending.resolve({ ok: true, client: ready(), changed: true });
  const [result, again] = await Promise.all([first, duplicate]);
  assert.deepEqual(result, again);
  assert.deepEqual(result.map(item => [item.id, item.ok]), [['codex', true], ['claude', false]]);
  assert.equal(connectionPresentation(store.clients[0]).ready, true);
  assert.equal(store.clients[1].configured, true);
  assert.equal(store.clients[2], custom);
  assert.equal(store.errors.get('claude'), 'Bridge unavailable');
  assert.equal(store.connectingAll, false);
  assert.deepEqual(calls, [['/api/connections/codex/connect', {}], ['/api/connections/claude/connect', {}]]);
  await store.connectInstalled();
  assert.deepEqual(calls[2], ['/api/connections/claude/verify', {}]);
  assert.equal(calls.length, 3);
});

test('shell summary distinguishes saved entries, checked tools, and unavailable fresh status', () => {
  const configured = client({ configured: true, status: 'connected' });
  assert.equal(summarizeConnections(snapshot([configured])).readyCount, 0);
  assert.equal(summarizeConnections(snapshot([configured])).label, 'Set up MCP');
  const checked = snapshot([ready(), ready({ id: 'claude', name: 'Claude Code' })]);
  assert.deepEqual(summarizeConnections(checked), {
    state: 'ready', label: 'MCP · 2 ready', description: 'Codex and Claude Code have saved setup and a verified tool connection.',
    readyCount: 2, installedCount: 2, configuredCount: 2, toolCount: 7, checkedAt: checked.checkedAt,
  });
  const unavailable = summarizeConnections(checked, { error: 'Workspace unavailable' });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.readyCount, 0);
  assert.equal(unavailable.toolCount, 0);
  assert.equal(unavailable.label, 'MCP · unavailable');
  assert.equal(summarizeConnections(null, { loading: true }).state, 'checking');
});

test('execution and MCP statuses are distinct and protocol details stay in Advanced', () => {
  const store = new ConnectionsStore(async () => {});
  store.clients = [client(), ready({ id: 'claude', name: 'Claude Code' })];
  store.serverUrl = 'http://127.0.0.1:4421';
  const html = renderConnectionsPage(store);
  const primary = html.split('<details class="connection-advanced"')[0];
  assert.match(primary, /1 MCP connection ready/);
  assert.match(html, /Bridge identity/);
  assert.match(html, /ai-workforce/);
  assert.match(html, /Local stdio MCP/);
  assert.match(primary, /Connect installed agents/);
  assert.match(primary, /Ready to connect/);
  assert.match(primary, /Runtime not configured/);
  assert.match(primary, /7 tools verified/);
  assert.doesNotMatch(primary, /127\.0\.0\.1/);
  assert.match(html, /local coordinator address, not an HTTP MCP endpoint/);
  assert.match(html, /Open agent session/);
  assert.match(html, /Not observed/);
});

test('the shell receives the latest failed check even when the server supplied no replacement client',async()=>{
  const checking=deferred();const store=new ConnectionsStore(async()=>checking.promise);
  store.clients=[ready()];const operation=store.perform('codex','verify');
  const during=store.snapshot();
  assert.equal(summarizeConnections(during).state,'checking');
  checking.reject(new Error('The local connection was interrupted.'));
  await assert.rejects(operation,/interrupted/);
  const after=store.snapshot();
  assert.equal(summarizeConnections(after).state,'attention');
  assert.equal(summarizeConnections(after).readyCount,0);
  assert.equal(summarizeConnections(after).description,'Codex: The local connection was interrupted.');
  assert.equal(after.errors.get('codex'),'The local connection was interrupted.');
  assert.equal(during.actions.get('codex'),'verify');
  store.errors.clear();assert.equal(after.errors.size,1);
});

test('a partly ready workforce names the failed client in the shell label and explanation',()=>{
  const summary=summarizeConnections(snapshot([ready(),client({id:'claude',name:'Claude Code',status:'error',message:'The latest tool check failed.'})]));
  assert.equal(summary.readyCount,1);assert.equal(summary.state,'attention');
  assert.equal(summary.label,'MCP · needs attention');
  assert.equal(summary.description,'1 agent is ready. Claude Code: The latest tool check failed.');
});

test('a late initial shell scan or its failure cannot replace a newer connection action',async()=>{
  for(const fail of [false,true]){
    const earlier=deferred(),updates=[],summary=new ConnectionSummaryStore(async()=>earlier.promise,value=>updates.push(value));
    const pending=summary.refresh();summary.accept(snapshot([ready()]));
    if(fail)earlier.reject(new Error('Old scan failed'));else earlier.resolve(snapshot([client()]));
    await pending;
    assert.equal(updates.length,1);assert.equal(updates[0].readyCount,1);
    assert.equal(summary.snapshot.clients[0].toolsVerified,true);
  }
});

test('shell refresh reads coalesce but a later explicit refresh can recover unavailable status',async()=>{
  const gate=deferred(),updates=[];let reads=0;
  const summary=new ConnectionSummaryStore(async()=>{reads++;if(reads===1)return gate.promise;return snapshot([ready()]);},value=>updates.push(value));
  const first=summary.refresh(),duplicate=summary.refresh();
  gate.reject(new Error('Server restarting'));await Promise.all([first,duplicate]);
  assert.equal(reads,1);assert.equal(updates.at(-1).state,'unavailable');
  await summary.refresh();assert.equal(reads,2);assert.equal(updates.at(-1).readyCount,1);
});


test('a verified MCP bridge never conceals a signed-out execution runtime', () => {
  const store = new ConnectionsStore(async () => {}); store.clients = [ready({ id: 'claude', name: 'Claude Code' })];
  const workspace = {workspace:{runtimes:{claude:{adapter:'claude-code', executable:'/bin/claude'}}},runtimes:{reports:[{runtimeId:'claude',configuredExecutable:'/bin/claude',installed:true,usable:false,auth:'logged_out'}]}};
  const html = renderConnectionsPage(store, {workspace});
  assert.match(html, /Sign-in needed/);
  assert.match(html, /Connection ready/);
  assert.doesNotMatch(html, /Ready to run tasks/);
  workspace.runtimes.reports[0].auth = 'logged_in'; workspace.runtimes.reports[0].usable = true;
  assert.match(renderConnectionsPage(store, {workspace}), /Ready to run tasks/);
});
