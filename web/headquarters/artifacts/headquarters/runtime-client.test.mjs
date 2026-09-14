import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { api, workforce } from '../../src/headquarters/runtime-client.js';

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const workspace = (revision, path = '/local/workspace.json') => ({ ok: true, path, revision, workspace: { revision, projects: [], departments: [], agents: [], runtimes: {} } });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = () => { const value = new workforce.constructor(); value.initial = false; value.publishWorkspace(workspace(17)); return value; };
beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument; });

test('ordinary polling cannot overwrite a concurrent successfully saved workspace revision', async () => {
  const client = state(); const requests = deferred(); const runs = deferred();
  globalThis.fetch = path => path === '/api/requests' ? requests.promise : path.startsWith('/api/runs') ? runs.promise : Promise.reject(new Error('Unexpected workspace read.'));
  const published = []; client.addEventListener('workspace', event => published.push(event.detail.revision));
  const pending = client.refresh();
  const saved = workspace(18); saved.workspace.projects = [{ id: 'new-project' }];
  client.publishWorkspace(saved);
  requests.resolve(json({ ok: true, items: [{ id: 'request-1', state: 'running' }] }));
  runs.resolve(json({ ok: true, runs: [] }));
  await pending;
  assert.equal(client.workspace.revision, 18);
  assert.deepEqual(client.workspace.workspace.projects, [{ id: 'new-project' }]);
  assert.deepEqual(published, [18]);
  assert.equal(client.requests[0].state, 'running');
  assert.equal(client.connected, true);
});

test('explicit workspace refresh requested during a poll waits then performs a fresh workspace read', async () => {
  const client = state(); const gate = deferred(); const calls = []; let requestCalls = 0;
  globalThis.fetch = async path => {
    calls.push(path);
    if (path === '/api/workspace') return json(workspace(18));
    if (path === '/api/requests' && ++requestCalls === 1) { await gate.promise; return json({ ok: true, items: [] }); }
    return json(path === '/api/requests' ? { ok: true, items: [] } : { ok: true, runs: [] });
  };
  const poll = client.refresh();
  const explicit = client.refresh({ workspace: true });
  assert.equal(calls.filter(path => path === '/api/workspace').length, 0);
  gate.resolve();
  await Promise.all([poll, explicit]);
  assert.equal(calls.filter(path => path === '/api/workspace').length, 1);
  assert.equal(requestCalls, 2);
  assert.equal(client.workspace.revision, 18);
});

test('an older in-flight workspace response cannot replace a newer committed snapshot', async () => {
  const client = state(); const snapshot = deferred();
  globalThis.fetch = path => path === '/api/workspace' ? snapshot.promise : Promise.resolve(json(path === '/api/requests' ? { ok: true, items: [] } : { ok: true, runs: [] }));
  const pending = client.refresh({ workspace: true });
  client.publishWorkspace(workspace(19));
  snapshot.resolve(json(workspace(18)));
  await pending;
  assert.equal(client.workspace.revision, 19);
  assert.equal(client.connected, true);
});

test('workspace publication is monotonic only for the same workspace identity', () => {
  const client = state(); const published = [];
  client.addEventListener('workspace', event => published.push([event.detail.path, event.detail.revision]));
  client.publishWorkspace(workspace(16));
  assert.equal(client.workspace.revision, 17);
  client.publishWorkspace(workspace(1, '/different/workspace.json'));
  assert.equal(client.workspace.path, '/different/workspace.json');
  assert.equal(client.workspace.revision, 1);
  assert.deepEqual(published, [['/different/workspace.json', 1]]);
});

test('a partial backend disconnect retains recorded request truth and reports unavailability', async () => {
  const client = state(); client.requests = [{ id: 'existing', state: 'running' }]; client.runs = [{ id: 'run-existing', state: 'running' }]; client.connected = true;
  globalThis.fetch = async path => {
    if (path.startsWith('/api/runs')) throw new Error('Connection closed');
    return json({ ok: true, items: [{ id: 'existing', state: 'ended' }] });
  };
  await client.refresh();
  assert.equal(client.connected, false);
  assert.match(client.error, /connection was interrupted/i);
  assert.equal(client.requests[0].state, 'running');
  assert.equal(client.runs[0].state, 'running');
  assert.equal(client.workspace.revision, 17);
});

test('an ordinary poll after recovery replaces stale records with the current backend state', async () => {
  const client = state(); client.requests = [{ id: 'existing', state: 'running' }]; client.connected = false; client.error = 'Connection closed';
  globalThis.fetch = async path => json(path === '/api/requests' ? { ok: true, items: [{ id: 'existing', state: 'ended', controlReply: 'Verified backend reply.' }] } : { ok: true, runs: [] });
  await client.refresh();
  assert.equal(client.connected, true);
  assert.equal(client.error, null);
  assert.equal(client.requests[0].controlReply, 'Verified backend reply.');
});

const oldToken='a'.repeat(64), newToken='b'.repeat(64);
const rejected=(code='token_rejected',message='the session token does not match this server process; reload the page')=>new Response(JSON.stringify({ok:false,error:{code,message}}),{status:403,headers:{'Content-Type':'application/json'}});
const sessionPage=()=>new Response(`<head><meta name="workforce-session-token" content="${newToken}" /></head>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
function pageToken(){const meta={content:oldToken};globalThis.document={querySelector:selector=>{assert.equal(selector,'meta[name="workforce-session-token"]');return meta;}};return meta;}

test('a stale server token refreshes in place and retries the identical mutation once',async()=>{
  const meta=pageToken(),calls=[],body={task:'Original draft',clientRequestId:'stable-request-id'};
  globalThis.fetch=async(path,options)=>{
    calls.push([path,{...options,headers:{...options.headers}}]);
    if(path==='/'){body.task='Draft edited while refreshing';return sessionPage();}
    return calls.filter(([url])=>url==='/api/requests').length===1?rejected():json({ok:true,requestId:'accepted-once'});
  };
  assert.equal((await api('/api/requests',body)).requestId,'accepted-once');
  assert.deepEqual(calls.map(([path])=>path),['/api/requests','/','/api/requests']);
  assert.equal(calls[0][1].headers['x-workforce-token'],oldToken);
  assert.equal(calls[2][1].headers['x-workforce-token'],newToken);
  assert.equal(calls[2][1].body,calls[0][1].body);
  assert.equal(JSON.parse(calls[2][1].body).task,'Original draft');
  assert.equal(meta.content,newToken);
  assert.equal(body.task,'Draft edited while refreshing');
  assert.deepEqual({mode:calls[1][1].mode,credentials:calls[1][1].credentials,redirect:calls[1][1].redirect,cache:calls[1][1].cache},{mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store'});
});

test('simultaneous rejected writes share one token refresh and preserve their separate identities',async()=>{
  pageToken();const refresh=deferred(),seen=[];
  globalThis.fetch=async(path,options)=>{
    seen.push([path,options.body,options.headers['x-workforce-token']]);
    if(path==='/')return refresh.promise;
    return options.headers['x-workforce-token']===oldToken?rejected():json({ok:true,id:JSON.parse(options.body).idempotencyKey});
  };
  const a=api('/api/issues',{idempotencyKey:'first'}),b=api('/api/issues',{idempotencyKey:'second'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(seen.filter(([url])=>url==='/').length,1);
  refresh.resolve(sessionPage());
  assert.deepEqual((await Promise.all([a,b])).map(result=>result.id),['first','second']);
  assert.equal(seen.filter(([url])=>url==='/api/issues').length,4);
});

test('a second token rejection is returned without another refresh or mutation retry',async()=>{
  pageToken();const calls=[];globalThis.fetch=async path=>{calls.push(path);return path==='/'?sessionPage():rejected();};
  await assert.rejects(api('/api/issues',{}),error=>error.status===403&&error.code==='token_rejected');
  assert.deepEqual(calls,['/api/issues','/','/api/issues']);
});

test('other 403 responses, a missing token, and GET refusals never trigger session recovery',async()=>{
  for(const [body,code,message] of [
    [{},'origin_rejected','requests from another origin are refused'],
    [{},'token_required','a write request needs the session token'],
    [{},'token_rejected','A different policy refusal'],
    [undefined,'token_rejected','the session token does not match this server process; reload the page'],
  ]){
    pageToken();const calls=[];globalThis.fetch=async path=>{calls.push(path);return rejected(code,message);};
    await assert.rejects(api('/api/issues',body),error=>error.status===403&&error.code===code);
    assert.deepEqual(calls,['/api/issues']);
  }
});

test('an invalid session page or interrupted refresh preserves the old token without retrying a write',async()=>{
  for(const mode of ['missing','redirect']){
    const meta=pageToken(),calls=[];
    globalThis.fetch=async(path,options)=>{
      calls.push(path);if(path!=='/')return rejected();
      assert.equal(options.redirect,'error');
      if(mode==='redirect')throw new TypeError('Redirect refused');
      return new Response('<head></head>',{headers:{'Content-Type':'text/html'}});
    };
    await assert.rejects(api('/api/issues',{}),/draft is retained/);
    assert.deepEqual(calls,['/api/issues','/']);assert.equal(meta.content,oldToken);
  }
});

test('a newer queue workspace revision refreshes project choices without ordinary repeated discovery', async () => {
  const client = state(); const calls=[];
  globalThis.fetch=async path=>{calls.push(path);const fresh=workspace(18);fresh.workspace.projects=[{id:'from-mcp'}];return json(path==='/api/workspace'?fresh:path==='/api/requests'?{ok:true,workspaceRevision:18,items:[{id:'r',projectId:'from-mcp'}]}:{ok:true,runs:[]});};
  await client.refresh();await client.refresh();
  assert.equal(client.workspace.revision,18);
  assert.equal(client.workspace.workspace.projects[0].id,'from-mcp');
  assert.equal(calls.filter(path=>path==='/api/workspace').length,1);
});

test('an older server can reveal a newly registered project, while removed historical project ids do not loop discovery', async () => {
  const client=state();let reads=0;
  globalThis.fetch=async path=>{if(path==='/api/workspace'){reads++;const next=workspace(18);next.workspace.projects=[{id:'new-project'}];return json(next);}return json(path==='/api/requests'?{ok:true,items:[{id:'new',projectId:'new-project'},{id:'historic',projectId:'removed-project'}]}:{ok:true,runs:[]});};
  await client.refresh();await client.refresh();await client.refresh();
  assert.equal(client.workspace.workspace.projects[0].id,'new-project');
  assert.ok(reads<=2);
});

test('restoring a stopped client resumes polling and opens one fresh event stream', async () => {
  const client = state(); const streams = [];
  client.openEvents = () => { const stream = { closed: false, close() { this.closed = true; } }; streams.push(stream); client.stream = stream; };
  globalThis.fetch = async path => json(path === '/api/workspace' ? workspace(17) : path === '/api/requests' ? {ok:true,items:[]} : {ok:true,runs:[]});
  client.initial = true;
  try {
    await client.start();
    assert.ok(client.timer); assert.equal(streams.length, 1);
    client.stop();
    assert.equal(client.timer, null); assert.equal(streams[0].closed, true); assert.equal(client.streaming, false);
    await client.start();
    assert.ok(client.timer); assert.equal(streams.length, 2); assert.equal(streams[1].closed, false);
    await client.start();
    assert.equal(streams.length, 2, 'repeated start must not add an event stream');
  } finally { client.stop(); }
});

test('stopping during an in-flight start cannot reopen its event stream or polling timer', async () => {
  const client = state(); const gate = deferred(); let opened = 0;
  client.initial = true; client.openEvents = () => { opened++; };
  globalThis.fetch = async path => { await gate.promise; return json(path === '/api/workspace' ? workspace(17) : path === '/api/requests' ? {ok:true,items:[]} : {ok:true,runs:[]}); };
  const pending = client.start(); client.stop(); gate.resolve(); await pending;
  assert.equal(client.timer, null); assert.equal(opened, 0); assert.equal(client.paused, true);
});
