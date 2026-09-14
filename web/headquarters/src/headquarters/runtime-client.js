export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.name='ApiError'; this.status=status; this.data=data; this.code=data?.error?.code || data?.code; this.details=data?.error?.details || data?.details || []; }
}

const TOKEN_SELECTOR='meta[name="workforce-session-token"]';
const STALE_TOKEN_MESSAGE='the session token does not match this server process; reload the page';
let sessionRefresh=null;
const sessionToken=()=>document.querySelector(TOKEN_SELECTOR)?.content || '';
async function refreshSessionToken(rejectedToken) {
  // A simultaneous write may already have refreshed this page's token.
  if(sessionToken() && sessionToken()!==rejectedToken)return;
  if(sessionRefresh)return sessionRefresh;
  sessionRefresh=(async()=>{
    // Only read this origin's served HTML. Do not navigate, follow redirects,
    // or execute page content: the current form and its draft remain intact.
    const response=await fetch('/',{method:'GET',headers:{Accept:'text/html'},mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store'});
    if(!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type')||''))throw new Error('Session page unavailable.');
    const html=await response.text();
    const token=/<meta\s+name="workforce-session-token"\s+content="([0-9a-f]{32,128})"\s*\/?>/i.exec(html)?.[1];
    const meta=document.querySelector(TOKEN_SELECTOR);
    if(!token || !meta || token===rejectedToken)throw new Error('Session token unavailable.');
    meta.content=token;
  })().catch(()=>{throw new ApiError('The local workforce session could not be refreshed. Your draft is retained. Try again when the workspace is available.',0,null);}).finally(()=>{sessionRefresh=null;});
  return sessionRefresh;
}

/** Same-origin requests to the local coordinator. No credential stores or provider keys. */
export async function api(path, body) {
  if (!path.startsWith('/api/')) throw new Error('Only local workforce API routes are supported.');
  const headers={Accept:'application/json'};
  const encoded=body===undefined?undefined:JSON.stringify(body);
  if(body!==undefined){headers['Content-Type']='application/json';headers['x-workforce-token']=sessionToken();}
  for(let attempt=0;attempt<2;attempt++){
    let response;
    try { response=await fetch(path,{method:body===undefined?'GET':'POST',headers,mode:'same-origin',credentials:'same-origin',redirect:'error',...(body===undefined?{}:{body:encoded})}); }
    catch { throw new ApiError('The local workforce connection was interrupted. Your draft is retained.',0,null); }
    let data;try {data=await response.json();} catch {throw new ApiError('The workforce server returned an unreadable response.',response.status,null);}
    if(response.ok && data.ok!==false)return data;
    // This exact gate refusal happens before the mutation handler. Retry no
    // other failure, and keep the original body and idempotency key unchanged.
    if(attempt===0 && body!==undefined && response.status===403 && data.error?.code==='token_rejected' && data.error.message===STALE_TOKEN_MESSAGE){
      await refreshSessionToken(headers['x-workforce-token']);
      headers['x-workforce-token']=sessionToken();
      continue;
    }
    throw new ApiError(data.error?.message || data.message || `Request failed (${response.status}).`,response.status,data);
  }
}

class WorkforceState extends EventTarget {
  workspace=null; requests=[]; runs=[]; events=[]; connected=false; streaming=false; error=null; stream=null; timer=null; refreshing=null; initial=true;
  publishWorkspace(payload){if(this.workspace?.path===payload?.path&&Number(this.workspace?.revision)>Number(payload?.revision))return;this.workspace=payload;this.dispatchEvent(new CustomEvent('workspace',{detail:payload}));this.dispatchEvent(new Event('change'));}
  async refresh({workspace=false}={}) {
    if(this.refreshing){await this.refreshing;if(workspace)return this.refresh({workspace:true});return;}
    this.refreshing=this.read(workspace).finally(()=>{this.refreshing=null;});return this.refreshing;
  }
  async read(includeWorkspace){
    try {
      const [snapshot,requests,runs]=await Promise.all([includeWorkspace||!this.workspace?api('/api/workspace'):Promise.resolve(null),api('/api/requests'),api('/api/runs?limit=60')]);
      const workspace=!snapshot||(this.workspace?.path===snapshot.path&&Number(this.workspace?.revision)>Number(snapshot.revision))?this.workspace:snapshot;
      if(workspace.error)throw new Error(workspace.error.message);
      const before=JSON.stringify([this.requests,this.runs,this.connected,this.workspace?.revision]);
      this.requests=requests.items||[];this.runs=runs.runs||[];this.connected=true;this.error=null;
      if(!this.workspace||workspace.revision!==this.workspace.revision)this.publishWorkspace(workspace);else this.workspace=workspace;
      if(before!==JSON.stringify([this.requests,this.runs,this.connected,this.workspace?.revision]))this.dispatchEvent(new Event('change'));
      if(this.initial){this.initial=false;this.openEvents(runs);}
    }catch(error){this.connected=false;this.error=error.message;this.dispatchEvent(new Event('change'));}
  }
  openEvents(runs){
    if(this.stream)return;
    // Begin at the persisted snapshot cursor; historical work never animates as new activity.
    const cursor=[`~=${runs.earlierHistory?.eventCursor||0}`,...(runs.projects||[]).map(p=>`${p.projectId}=${p.eventCursor||0}`)].join(',');
    this.stream=new EventSource(`/api/events?after=${encodeURIComponent(cursor)}`);
    this.stream.onopen=()=>{this.streaming=true;this.dispatchEvent(new Event('connection'));};
    this.stream.onerror=()=>{this.streaming=false;this.dispatchEvent(new Event('connection'));};
    this.stream.onmessage=e=>{try {const value=JSON.parse(e.data);this.events.push(value);if(this.events.length>200)this.events.shift();this.dispatchEvent(new CustomEvent('activity',{detail:value}));this.refresh();}catch{/* A malformed event cannot alter recorded task state. */}};
    this.stream.addEventListener('stream-error',()=>{this.streaming=false;this.dispatchEvent(new Event('connection'));});
  }
  async start(){await this.refresh({workspace:true});this.timer=setInterval(()=>{if(document.visibilityState!=='hidden')this.refresh();},4000);}
  stop(){clearInterval(this.timer);this.stream?.close();this.stream=null;}
}
export const workforce=new WorkforceState();
