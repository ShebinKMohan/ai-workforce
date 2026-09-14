import { api, workforce } from './runtime-client.js';
import { getSettings } from './settings.js';
import { headReviewNeedsRetry, latestRunRequests, newerRunRequest, savedRequestText, requestTaskStatus } from './task-status.js';
import { avatar } from './ui.js';
import { revealPanel,revealTask,acknowledgeStatus } from './interaction-motion.js';
import { renderTaskRailSummary, renderTaskReply, taskBlocker, taskRailFacts, taskEventLabel, visibleTaskEvent, taskAttention, requestHeadline } from './task-rail.js';
import { renderDuration } from './time-display.js';
import { createConversationStorage } from './conversation-storage.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const uid = () => crypto.randomUUID();
const KEY = 'workforce-control-center-conversations-v3';
const LEGACY_KEY = 'workforce-atlas-conversations-v2';
const ACTIVE = new Set(['received', 'queued', 'routing', 'starting', 'running', 'stopping', 'pending']);
const icons = { back:'m14 6-6 6 6 6', tasks:'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1', arrow:'M12 19V5m-6 6 6-6 6 6', close:'m6 6 12 12M6 18 18 6', add:'M12 5v14M5 12h14', history:'M3 3v6h6M3 9a9 9 0 1 1 .7 8M12 7v5l3 2', expand:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', shrink:'M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5', clip:'m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8', down:'m7 10 5 5 5-5', folder:'M3 6h7l2 2h9v12H3Z', copy:'M9 9h12v12H9ZM5 15H3V3h12v2', check:'m5 12 4 4L19 6', stop:'M7 7h10v10H7Z', refresh:'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17' };
const icon = name => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name] || icons.add}"/></svg>`;
const newThread = () => ({ id:uid(), title:'New conversation', createdAt:Date.now(), draft:'', attachments:[], messages:[], context:null, selection:{}, autoHandoff:true });
const sizeLabel = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const dateLabel = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '—';

// Only this bounded Markdown subset becomes markup. Runtime HTML, images, and executable URLs stay inert.
function inline(source) {
  const pattern = /(`+)(.*?)\1|\[([^\]\n]{1,300})\]\((<[^>\n]{1,4096}>|[^)\n]{1,4096})\)|\*\*([^*\n]{1,1000})\*\*/g;
  let output = '', previous = 0;
  for (const match of source.matchAll(pattern)) {
    output += escape(source.slice(previous, match.index));
    if (match[1]) output += `<code>${escape(match[2])}</code>`;
    else if (match[3]) {
      const target = match[4].replace(/^<|>$/g, '');
      let href = '';
      try { const url = new URL(target); if (['http:', 'https:'].includes(url.protocol) && !/[\u0000-\u0020]/.test(target)) href = url.href; } catch {}
      output += href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(match[3])}</a>` : `<span title="${escape(target)}">${escape(match[3])}</span>`;
    } else output += `<strong>${escape(match[5])}</strong>`;
    previous = match.index + match[0].length;
  }
  return output + escape(source.slice(previous));
}
export function renderChatMarkdown(value) {
  const text = String(value ?? '').slice(0, 32000);
  let paragraph = [], list = [], code = [], fence = null;
  const blocks = [];
  const flushParagraph = () => { if (paragraph.length) { blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph=[]; } };
  const flushList = () => { if (list.length) { blocks.push(`<ul>${list.map(line=>`<li>${inline(line)}</li>`).join('')}</ul>`); list=[]; } };
  const flushCode = () => { blocks.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code=[]; fence=null; };
  for (const line of text.replace(/\r\n?/g,'\n').split('\n').slice(0,1000)) {
    if (fence) { if (line.trim().length >= fence.length && [...line.trim()].every(c=>c===fence[0])) flushCode(); else code.push(line); continue; }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) { flushParagraph(); flushList(); fence=opening[1]; continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading=line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); blocks.push(`<h4>${inline(heading[1])}</h4>`); continue; }
    const bullet=line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList(); if (fence) flushCode();
  if (String(value??'').length>32000) blocks.push('<p class="cc-caption">Response preview shortened. Copy the response for the full text.</p>');
  return blocks.join('');
}
export function attachmentError(files, existing=[]) {
  if (files.length+existing.length>8) return 'Attach up to 8 files per message.';
  for (const f of files) {
    if (f.size>10*1024*1024) return `${f.name} exceeds the 10 MB file limit.`;
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.size>5*1024*1024) return `${f.name} exceeds the 5 MB image limit.`;
  }
  if ([...files,...existing].reduce((sum,f)=>sum+f.size,0)>25*1024*1024) return 'Files in one message can total up to 25 MB.';
  return '';
}
export function requestStatus(request={},run,requests=[],options={}) {
  const projected=requestTaskStatus(request,run,requests,options);
  if(projected.bucket==='loading')return projected.label;
  if (newerRunRequest(request,requests)) return 'Continued in newer attempt';
  if (headReviewNeedsRetry(request,run)) return 'Review needs retry';
  if (request.stopRequestedAt && ACTIVE.has(request.state)) return 'Stopping the runtime…';
  if (ACTIVE.has(request.state) && (request.route?.state==='pending' || request.state==='routing')) return 'Control Center is reading your message';
  if (request.state==='held') return 'Request paused';
  if (request.route?.state==='blocked') return request.route?.outcome==='clarification'?'Clarification needed':'Could not start';
  if (request.state==='failed_to_start' || request.state==='failed') return 'Could not continue';
  if (request.state==='discarded' || request.state==='cancelled' || request.signal || request.result?.code==='interrupted') return 'Stopped';
  if (request.state==='ended') return requestTaskStatus(request,run).label;
  return ({received:'Message received',queued:'Waiting for the team',starting:'Starting the team',running:'Team is working'})[request.state] || request.state || 'Connecting';
}
const instant = value => Date.parse(value || '') || 0;
export const runDetailSignature = run => JSON.stringify(run && [run.id,run.projectId,run.state,run.updatedAt,run.eventCount,run.headReview,run.delivery]);
export function mergeTaskRun(request, snapshot, detail) {
  const runId=request.runId||request.resumeRunId;
  const matches=run=>run?.id===runId&&(!run.projectId||run.projectId===request.projectId);
  if(!matches(snapshot))snapshot=null;
  const enriched=matches(detail?.run)?{...detail,...detail.run,projectId:request.projectId,headReview:detail.headReview,taskViews:detail.taskViews}:null;
  if(!snapshot)return enriched;
  return enriched&&runDetailSignature({...snapshot,projectId:request.projectId})===runDetailSignature(enriched)?{...snapshot,...enriched}:snapshot;
}
export function taskLastChanged(request={},run,events=[]) {
  return Math.max(...[request.updatedAt,request.endedAt,request.heldAt,request.startedAt,request.route?.decidedAt,request.receivedAt,run?.updatedAt,...events.filter(visibleTaskEvent).map(event=>event.timestamp||event.at)].map(instant));
}
export function departmentRoutingHint(task,departments=[],selectedId='') {
  const available=departments.filter(department=>!department.archived);
  const chosen=available.find(department=>department.id===selectedId);
  if(chosen)return {departmentId:chosen.id,text:`${chosen.name} will handle this request.`};
  const tokens=new Set(String(task||'').toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g)||[]);
  const ignored=new Set(['the','and','for','with','from','this','that','project','work','team','department','engineering','please','code','system']);
  const scored=available.map(department=>{const words=new Set([department.name,department.purpose,department.description,...(department.capabilities||[])].filter(Boolean).join(' ').toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g)||[]);return {department,score:[...words].filter(word=>!ignored.has(word)&&tokens.has(word)).length};}).sort((a,b)=>b.score-a.score);
  const likely=scored[0]?.score>0&&scored[0].score>(scored[1]?.score||0)?scored[0].department:null;
  return likely?{departmentId:likely.id,text:`Likely ${likely.name} · Control Center confirms when you send.`}:{departmentId:null,text:'Control Center will select the department and available specialists.'};
}
export function requestDetailKey(request,run) { return JSON.stringify([request.id,request.state,request.updatedAt,request.endedAt,request.route,request.recovery,runDetailSignature(run)]); }
/** Poll only visible current work; explicit conversation opens may hydrate historical evidence once. */
export function visibleDetailCandidates({requests=[],visibleIds=[],paneMode='feed',hidden=false,cache=new Map(),runFor=()=>null,limit=3}={}) {
  if(hidden)return [];
  const byId=new Map(requests.map(request=>[request.id,request]));
  return [...new Set(visibleIds)].map(id=>byId.get(id)).filter(Boolean).filter(request=>{
    if(paneMode==='feed'&&!ACTIVE.has(request.state))return false;
    const saved=cache.get(request.id);
    return !saved||saved.hasMore||saved.version!==requestDetailKey(request,runFor(request));
  }).slice(0,limit);
}
/** One user retry keeps one idempotency identity, including an uncertain network response. */
export function createRequestRetry({api,createId=uid}={}) {
  const identities=new Map(),pending=new Map();
  return function retry(request){
    if(request?.recovery?.canRetry!==true)return Promise.reject(new Error('This request is not ready to retry.'));
    if(pending.has(request.id))return pending.get(request.id);
    const clientRequestId=identities.get(request.id)||createId();identities.set(request.id,clientRequestId);
    const promise=api(`/api/requests/${encodeURIComponent(request.id)}/retry`,{clientRequestId}).then(result=>{
      if(!(result.request||result.task)?.id)throw new Error('No retry receipt was returned. Your retry identity is retained.');
      return result;
    }).finally(()=>pending.delete(request.id));
    pending.set(request.id,promise);return promise;
  };
}
export function requestControlEndpoint(request, action, run) {
  if(action === 'resume' && headReviewNeedsRetry(request,run) && !request.recovery?.nextRequestId) return `/api/projects/${encodeURIComponent(request.projectId)}/runs/${encodeURIComponent(request.runId||request.resumeRunId)}/resume`;
  if(action === 'start' && request?.state === 'held') return `/api/requests/${encodeURIComponent(request.id)}/start`;
  if(action === 'cancel' && ['queued','held'].includes(request?.state)) return `/api/requests/${encodeURIComponent(request.id)}/discard`;
  if(action === 'cancel' && ['starting','running'].includes(request?.state) && request.pid && !request.stopRequestedAt) return `/api/requests/${encodeURIComponent(request.id)}/stop`;
  return null;
}
export function taskArtifactGroups(artifacts = []) {
  const deliverableTypes=new Set(['analysis_report','candidate_patch','summary']);
  const technicalTypes=new Set(['head_review_diff','result','head_review_result','check_receipt']);
  return {deliverables:artifacts.filter(artifact=>deliverableTypes.has(artifact.type) && !(artifact.type==='summary' && /\.json$/i.test(artifact.path||''))),technical:artifacts.filter(artifact=>technicalTypes.has(artifact.type) || artifact.type==='summary' && /\.json$/i.test(artifact.path||''))};
}

/** Resume receipts refer to the original prompt; they are not another user submission. */
export function hydrateResumeConversation(thread, request, run, createId=uid) {
  if (!(request?.kind==='resume'||request?.resumeRunId)) return false;
  const prompt=savedRequestText(request,run),title=prompt?requestHeadline(prompt,48):'Resumed task';
  let changed=false;
  const messages=thread.messages.filter(message=>!(message.role==='user'&&!String(message.text||'').trim()&&!message.attachments?.length));
  if(messages.length!==thread.messages.length){thread.messages=messages;changed=true;}
  let context=thread.messages.find(message=>message.resumeContextId===request.id);
  if(!context){context={id:createId(),role:'context',resumeContextId:request.id,text:'',createdAt:Date.parse(request.receivedAt)};thread.messages.unshift(context);changed=true;}
  const text=prompt||'Resuming the saved task. Its original request is loading.';
  if(context.text!==text){context.text=text;changed=true;}
  if(thread.title!==title){thread.title=title;changed=true;}
  return changed;
}
export async function startRequestSignIn({request,runtimes={},api}) {
  const runtimeId=request.controlCenter?.runtime||request.submittedControlCenter?.runtime;
  const adapter=runtimes[runtimeId]?.adapter;
  const client=adapter==='codex'?'codex':adapter==='claude-code'?'claude':null;
  if(!client) return {started:false,message:'Open Connections and sign in to the coding agent used by this request.'};
  const checked=await api(`/api/connections/${client}/auth`);
  const auth=checked.client?.authentication;
  if(auth?.state==='pending')return {started:false,message:'Sign-in is already open. Finish it in your browser, then retry this request.'};
  if(!auth?.canSignIn)return {started:false,message:auth?.state==='connected'?'This coding agent is signed in. Retry the saved request.':'Open Connections to check this coding agent’s sign-in.'};
  await api(`/api/connections/${client}/sign-in`,{});
  return {started:true,message:'Sign-in opened. Complete it in your browser, then retry this saved request.'};
}

/** Keep saved action routing intact while making runtime stop visually explicit. */
export function renderRequestActionButton(request,action,busy=false) {
  const attributes=action.kind==='retry'?`data-request-retry="${escape(request.id)}"`:action.kind==='successor'?`data-retry-successor="${escape(action.id)}"`:action.kind==='connections'?'data-nav="connections"':`data-request-action="${escape(action.kind)}" data-action-request="${escape(request.id)}"`;
  const isStop=action.kind==='cancel'&&['starting','running'].includes(request.state);
  const label=busy?(isStop?'Stopping…':'Working…'):action.label;
  return `<button type="button" class="cc-request-retry cc-request-action${isStop?' cc-stop-work':''}" ${attributes}${busy?' disabled aria-busy="true"':''}>${isStop?icon('stop'):''}<span>${escape(label)}</span></button>`;
}

/** Compact feed references contain only identity, elapsed time and the recorded assignees. */
export function compactRequestCard(request = {}, {facts = {}, fact = {}, run} = {}, agents = [], controlCenter = {}) {
  const control={id:'control-center',name:controlCenter.name||agents.find(agent=>agent.id==='control-center')?.name||'Tom Chandler'};
  const runId=request.runId||request.resumeRunId;
  const summary=run&&runId&&run.id===runId&&(!run.projectId||run.projectId===request.projectId)?run:null;
  const taskOwners=(facts.tasks||[]).filter(task=>task.ownerId).map(task=>({id:task.ownerId,name:task.owner||agents.find(agent=>agent.id===task.ownerId)?.name||task.ownerId}));
  const summaryOwners=(summary?.taskViews||[]).filter(task=>task.state!=='superseded'&&(task.ownerAgentId||task.agentId)).map(task=>{const id=task.ownerAgentId||task.agentId;return {id,name:agents.find(agent=>agent.id===id)?.name||id};});
  const headIsActive=facts.active&&['Head review','Report review','Planning'].includes(facts.phase);
  const activeOwners=headIsActive?(facts.owners||[]).filter(Boolean).map(name=>({id:agents.find(agent=>agent.name===name)?.id||name,name})):[];
  const reviewedHead=summary?.headReview?.state==='passed'&&summary.headReview.headAgentId;
  const completedOwners=reviewedHead?[{id:reviewedHead,name:agents.find(agent=>agent.id===reviewedHead)?.name||reviewedHead},...(taskOwners.length?taskOwners:summaryOwners)]:[];
  const assigned=activeOwners.length?activeOwners:completedOwners.length?completedOwners:taskOwners.length?taskOwners:summaryOwners;
  const directReply=!runId&&(request.route?.outcome==='direct_reply'||fact.label==='Answered'||facts.status==='Answered'||request.state==='ended'&&request.controlReply&&(request.exitCode==null||request.exitCode===0));
  const owners=assigned.length?assigned:directReply?[control]:(facts.owners||[]).filter(Boolean).map(name=>name==='Control Center'||name==='control-center'?control:({id:agents.find(agent=>agent.name===name)?.id||name,name}));
  return {id:request.id,title:requestHeadline(savedRequestText(request,summary)||request.controlReply),project:facts.project||request.projectId||'Workspace',status:fact.label||facts.status||'Awaiting status',bucket:fact.bucket||'backlog',duration:{...facts.requestDuration,label:''},assignees:[...new Map(owners.map(owner=>[owner.id,owner])).values()]};
}

export function renderCompactRequestCard(card) {
  const names=card.assignees.map(owner=>owner.name),allNames=names.join(', ');
  const visibleNames=names.length>2?`${names[0]} +${names.length-1}`:allNames||'Not assigned yet';
  const portraits=card.assignees.slice(0,3).map(owner=>avatar(owner.name,22,{id:owner.id})).join('');
  return `<button type="button" class="cc-task-card-main" data-feed-request="${escape(card.id)}" aria-label="${escape(card.title)} · ${escape(card.status)} · ${escape(card.project)}${allNames?` · Assigned to ${escape(allNames)}`:''}"><span class="cc-task-card-heading"><span class="cc-task-card-status" data-state="${escape(card.bucket)}" title="${escape(card.status)}" aria-label="${escape(card.status)}"><i aria-hidden="true"></i></span><strong class="cc-task-title">${escape(card.title)}</strong></span><span class="cc-task-card-meta"><span class="cc-task-card-project" title="${escape(card.project)}">${icon('folder')}<span>${escape(card.project)}</span></span><span class="cc-task-card-elapsed" aria-label="Total request time">${renderDuration(card.duration)}</span></span><span class="cc-task-card-assignees" title="${escape(allNames||'Not assigned yet')}">${portraits?`<span class="cc-task-card-portraits" aria-hidden="true">${portraits}</span>`:''}<span class="cc-task-card-names">${escape(visibleNames)}</span></span></button>`;
}

function chatNodeKey(node) { return node.nodeType===1&&(node.dataset.messageId||node.dataset.disclosure||node.dataset.taskId||node.dataset.durationStart&&`duration:${node.dataset.durationStart}:${node.querySelector('.phase-duration-label')?.textContent}`); }
function patchChatNode(current,next) {
  if(current.nodeType!==next.nodeType||current.nodeName!==next.nodeName){current.replaceWith(next.cloneNode(true));return;}
  if(current.nodeType===3){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
  if(current.nodeType!==1||current.isEqualNode(next))return;
  for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name)&&!(current.tagName==='DETAILS'&&attr.name==='open'))current.removeAttribute(attr.name);
  for(const attr of [...next.attributes])if(!(current.tagName==='DETAILS'&&attr.name==='open')&&current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
  const previous=[...current.childNodes],keyed=new Map(previous.map(node=>[chatNodeKey(node),node]).filter(([key])=>key)),used=new Set();let cursor=current.firstChild;
  for(const child of [...next.childNodes]){const key=chatNodeKey(child);let match=key?keyed.get(key):cursor&&!chatNodeKey(cursor)&&cursor.nodeType===child.nodeType&&cursor.nodeName===child.nodeName?cursor:null;if(match&&used.has(match))match=null;if(!match){match=child.cloneNode(true);current.insertBefore(match,cursor);}else{if(match!==cursor)current.insertBefore(match,cursor);patchChatNode(match,child);}used.add(match);cursor=match.nextSibling;}
  for(const child of previous)if(!used.has(child)&&child.parentNode===current)child.remove();
}
export function createAtlasChat({ element, mark, onNavigate, onTask, notify=()=>{} }) {
  const columns=element.closest('.main-columns');
  const connectedAt=Date.now(),renderSignatures=new WeakMap();
  let threads=[], activeId, paneMode='feed', feedDraft=newThread(), taskFilter='all', departmentFilter=null, taskScope=null, feedReady=false, feedSnapshotShown=false, feedError='', feedSeen=new Map(), chatWidth=420, autoHandoff=true;
  let initialStorage={},storageError='';
  try {
    const saved=JSON.parse(localStorage.getItem(KEY)||'null');
    initialStorage=saved||{};
    if(saved?.feedDraft&&typeof saved.feedDraft==='object')feedDraft={...newThread(),...saved.feedDraft,messages:[]};
    if (Array.isArray(saved?.threads)) { threads=saved.threads; activeId=saved.activeId; chatWidth=saved.layoutVersion===5?(saved.chatWidth||chatWidth):420; autoHandoff=true; }
    else {
      const old=JSON.parse(localStorage.getItem(LEGACY_KEY)||'null');
      if (Array.isArray(old?.threads)) threads=old.threads.filter(t=>t.draft||t.messages?.length).map(t=>({...t,id:`preview-${t.id}`,legacy:true,title:`Design preview · ${t.title}`,selection:{},attachments:[],messages:(t.messages||[]).map(m=>({...m,legacy:true}))}));
    }
  } catch {storageError='Saved conversations could not be read in this browser. Keep this page open and copy any unsent draft before reloading.';}
  threads=threads.filter(t=>typeof t.id==='string'&&Array.isArray(t.messages)).slice(0,100).map(t=>({...t,draft:typeof t.draft==='string'?t.draft:'',selection:t.selection||{},autoHandoff:typeof t.autoHandoff==='boolean'?t.autoHandoff:autoHandoff,attachments:(t.attachments||[]).map(a=>a.status==='ready'&&a.id?a:{...a,status:'error',error:'Upload interrupted. Remove this file and select it again.'})}));
  feedDraft.draft=typeof feedDraft.draft==='string'?feedDraft.draft:'';feedDraft.selection=feedDraft.selection||{};feedDraft.attachments=(feedDraft.attachments||[]).map(a=>a.status==='ready'&&a.id?a:{...a,status:'error',error:'Upload interrupted. Remove this file and select it again.'});
  if (!threads.some(t=>!t.legacy)) { const t=newThread(); threads.unshift(t); activeId=t.id; }
  if (!threads.some(t=>t.id===activeId)) activeId=threads[0].id;
  let workspace=null, connectionError='', configurationError='', inspector={html:'',title:''}, sending=new Set(), stopped=new Set(), retrying=new Set(), retrySavedRequest=createRequestRetry({api}), catalogs=new Map(), catalogReads=new Map(), catalogCheckedAt=new Map(), requests=new Map(), runDetails=new Map(), artifactPreviews=new Map(), refreshingRequests=new Set(), permissionChecks=new Set(), polling=false, destroyed=false, composerError='', activeUploadCount=0;
  const current=()=>paneMode==='feed'?feedDraft:threads.find(t=>t.id===activeId)||feedDraft;
  const config=()=>workspace?.workspace||{};
  const reportFor=id=>id?(workspace?.runtimes?.reports||[]).find(r=>r.runtimeId===id&&(!r.configuredExecutable||r.configuredExecutable===config().runtimes?.[id]?.executable)):undefined;
  const runtimeName=id=>reportFor(id)?.displayName||config().runtimes?.[id]?.adapter||id;
  const runtimePickerName=id=>{const binding=config().runtimes?.[id]||{};if(binding.adapter==='codex'){const paths=[binding.executable,catalogs.get(id)?.executable,catalogs.get(id)?.resolvedExecutable,reportFor(id)?.executable].filter(Boolean);return paths.some(path=>/\.app(?:\/|$)/i.test(path))?'Codex Desktop':'Codex CLI';}return binding.adapter==='claude-code'?'Claude Code':runtimeName(id);};
  const projects=()=>config().projects?.filter(p=>!p.archived)||[];
  const selected=()=>{
    const s=current().selection;
    const configured=config().runtimes||{};const runtime=(configured[s.runtime]?s.runtime:null)||(configured[config().controlCenter?.runtime]?config().controlCenter.runtime:null)||Object.keys(configured)[0]||'';
    const selectionStillBound=!s.runtime||s.runtime===runtime;
    const binding=config().runtimes?.[runtime]||{};
    const inherited=runtime===config().controlCenter?.runtime?config().controlCenter:binding;
    const catalog=catalogs.get(runtime);
    const model=(selectionStillBound?s.model:undefined) ?? inherited?.model ?? binding.model ?? '';
    const runtimeDefaultModel=binding.model||catalog?.defaultModel||'';
    const effectiveModel=model||runtimeDefaultModel;
    const entry=catalog?.models?.find(m=>m.id===effectiveModel);
    const effort=(selectionStillBound?s.effort:undefined) ?? inherited?.effort ?? binding.effort ?? '';
    const effectiveEffort=effort||binding.effort||entry?.defaultEffort||'';
    return {runtime,model,effectiveModel,runtimeDefaultModel,effectiveEffort,effort,catalog,entry,projectId:s.projectId||projects()[0]?.id||'',departmentId:(config().departments||[]).some(department=>department.id===s.departmentId&&!department.archived)?s.departmentId:''};
  };
  const conversationStorage=createConversationStorage({initial:initialStorage,read:()=>JSON.parse(localStorage.getItem(KEY)||'null'),write:value=>localStorage.setItem(KEY,JSON.stringify(value))});
  function renderStorageWarning(){let warning=element.querySelector('[data-storage-warning]');if(!storageError){warning?.remove();return;}if(!warning){warning=document.createElement('p');warning.className='cc-error cc-storage-warning';warning.dataset.storageWarning='';warning.setAttribute('role','alert');element.querySelector('.chat-threadbar')?.after(warning);}warning.textContent=storageError;}
  function persist(){try{const saved=conversationStorage.save({version:3,layoutVersion:5,threads:threads.slice(0,100),activeId,chatWidth,autoHandoff,feedDraft});threads=saved.threads;feedDraft=saved.feedDraft;storageError='';}catch(error){storageError=error?.name==='QuotaExceededError'?'Drafts could not be saved because browser storage is full. Keep this page open and copy your draft before reloading.':'Drafts could not be saved in this browser. Keep this page open and copy your draft before reloading.';}renderStorageWarning();}
  function dispatch(name,detail){element.dispatchEvent(new CustomEvent(`workforce:${name}`,{detail,bubbles:true}));}
  const show=()=>{columns.classList.remove('chat-closed');columns.classList.add('chat-open');renderMessages();void poll();};
  const mainReply=m=>requests.get(m.requestId)?.controlReply||runDetails.get(m.requestId)?.status?.run?.finalReply||m.text||'';
  function traceMarkup(m,request) {
    const detail=runDetails.get(m.requestId), events=detail?.events||[];
    const meaningful=events.filter(visibleTaskEvent).slice(-120);
    const status=requestStatus(request,feedRun(request),[...requests.values()],evidenceOptions(request));
    const run=feedRun(request),evidence=[...new Set([...(run?.delivery?.evidenceIssues||[]),...(run?.evidenceIssues||[]),...(run?.delivery?.verified===false&&run.delivery.reason?[run.delivery.reason]:[])])];
    return `<details class="cc-trace" data-disclosure="trace:${escape(m.id)}" data-trace-request="${escape(m.requestId)}"><summary><span class="cc-state-dot ${ACTIVE.has(request.state)?'is-working':''}"></span><span>Activity & diagnostics</span><small>${meaningful.length?`${meaningful.length} events`:''}</small>${icon('down')}</summary><div class="cc-trace-body">${evidence.length?`<strong>Delivery evidence to resolve</strong><ul>${evidence.map(item=>`<li>${escape(typeof item==='string'?item:JSON.stringify(item))}</li>`).join('')}</ul>`:''}${request.route?.reason?`<p>${escape(request.route.reason)}</p>`:''}${request.route?.departmentId?`<div class="cc-routing"><span>Control Center</span><b>→</b><span>${escape(config().departments?.find(d=>d.id===request.route.departmentId)?.name||request.route.departmentId)}</span>${assignedOwnerIds(request).length?`<b>→</b><span>${escape(assignedOwnerIds(request).map(id=>config().agents?.find(a=>a.id===id)?.name||id).join(', '))}</span>`:''}</div>`:''}${meaningful.map(e=>`<details class="cc-event" data-disclosure="event:${escape(m.id)}:${e.sequence}"><summary><time>${dateLabel(e.timestamp)}</time><span>${escape(taskEventLabel(e))}</span>${icon('down')}</summary><pre>${escape(JSON.stringify(e.payload,null,2).slice(0,14000))}</pre></details>`).join('')}${!meaningful.length?'<p class="cc-caption">Waiting for recorded runtime events.</p>':''}${request.result?.details?.length?`<pre>${escape(request.result.details.join('\n'))}</pre>`:''}<div class="cc-trace-meta">${escape([request.controlCenter?.runtime,request.controlCenter?.model,request.controlCenter?.effort,request.controlRuntime?.executable,request.controlRuntime?.version].filter(Boolean).join(' · '))}</div></div></details>`;
  }
  function permissionMarkup(m,request){if(request.state!=='failed_to_start'||!/consent|unconfined|containment/i.test(request.result?.code||''))return '';if(m.permissionRetriedRequestId)return '<p class="cc-caption">Retried with your permission for this request.</p>';const runtime=request.controlCenter?.runtime||request.submittedControlCenter?.runtime;const report=reportFor(runtime);return `<details class="cc-permission" data-disclosure="permission:${escape(m.id)}"><summary>Runtime permission needed ${icon('down')}</summary><div><p>${escape(request.result?.message||'This runtime has no verified operating-system file boundary.')}</p>${request.result?.details?.length?`<ul>${request.result.details.map(line=>`<li>${escape(line)}</li>`).join('')}</ul>`:''}<p class="cc-caption">${escape([runtimeName(runtime),report?.version?`Installed ${report.version}`:'',request.controlRuntime?.executable||''].filter(Boolean).join(' · '))}</p><p>This choice allows this request to use a runtime without a verified OS file boundary. Its access may extend beyond the selected project. Routine team reviews remain automatic.</p><label><input type="checkbox" data-consent-check="${escape(m.id)}" ${permissionChecks.has(m.id)?'checked':''}>Allow runtime writes without the verified boundary for this request</label><button type="button" class="cc-permission-retry" data-consent-retry="${escape(m.id)}" ${permissionChecks.has(m.id)&&!sending.has(current().id)?'':'disabled'}>Allow and retry</button></div></details>`;}
  async function retryWithPermission(messageId){const t=current(),m=t.messages.find(m=>m.id===messageId);if(!m||!permissionChecks.has(messageId)||sending.has(t.id)||m.permissionRetriedRequestId)return;const request=requests.get(m.requestId)||m.request;if(!request||request.state!=='failed_to_start'||!/consent|unconfined|containment/i.test(request.result?.code||''))return;const controlCenter=request.submittedControlCenter||request.controlCenter;const attachmentIds=request.submittedAttachmentIds||(request.attachments||[]).map(f=>f.id);const mode=request.mode||'delegate';if(!m.permissionRetry)m.permissionRetry={clientRequestId:uid(),text:request.task||'',attachments:request.attachments||[],payload:{projectId:request.projectId,task:request.task,mode,allowUnconfinedWrites:true,...(controlCenter?{controlCenter}:{}),...(request.priorRequestId?{priorRequestId:request.priorRequestId}:{}),...(attachmentIds.length?{attachmentIds}:{}),...(mode!=='discuss'&&request.route?.state==='selected'&&request.route.departmentId?{departmentId:request.route.departmentId}:{})}};sending.add(t.id);composerError='';persist();renderMessages();updateStatus();try{const submission=m.permissionRetry;const result=await api(`/api/requests/${encodeURIComponent(request.id)}/retry`,{clientRequestId:submission.clientRequestId,allowUnconfinedWrites:true});const next=result.task||result.request;if(!next?.id)throw new Error('No receipt was returned. Retrying uses the same request identity.');acceptReceipt(t,submission,next,false);m.permissionRetriedRequestId=next.id;requests.set(request.id,{...request,recovery:{...request.recovery,canRetry:false,nextRequestId:next.id}});permissionChecks.delete(m.id);persist();renderMessages(true);void poll();}catch(error){composerError=`${error.message} Your original request and retry identity are retained.`;persist();}finally{sending.delete(t.id);renderMessages();updateStatus();}}
  function outputsMarkup(m,request){
    const groups=taskArtifactGroups(runDetails.get(m.requestId)?.status?.artifacts||[]);
    const rows=artifacts=>artifacts.map(a=>{const label=({analysis_report:'Analysis report',candidate_patch:'Proposed code changes',summary:'Summary'})[a.type]||a.type.replaceAll('_',' ');return `<div class="cc-output-row"><span><strong>${escape(label)}</strong><small title="${escape(a.id)}">${escape(a.path)}</small></span><button type="button" data-artifact="${escape(a.id)}" data-artifact-request="${escape(request.id)}" aria-label="View ${escape(label)}">View</button><button type="button" data-artifact="${escape(a.id)}" data-artifact-request="${escape(request.id)}" data-download="true" aria-label="Download ${escape(label)}">↓</button></div>${artifactPreviews.has(`${request.id}:${a.id}`)?`<pre class="cc-artifact-preview">${escape(artifactPreviews.get(`${request.id}:${a.id}`))}</pre>`:''}`;}).join('');
    return `${groups.deliverables.length?`<details class="cc-outputs" data-disclosure="outputs:${escape(m.id)}"><summary>${icon('folder')}<strong>Deliverables</strong><span>${groups.deliverables.length} files</span>${icon('down')}</summary><div class="cc-output-list">${rows(groups.deliverables)}</div></details>`:''}${groups.technical.length?`<details class="cc-trace" data-disclosure="technical-files:${escape(m.id)}"><summary>Technical records · ${groups.technical.length} ${icon('down')}</summary><div class="cc-output-list">${rows(groups.technical)}</div></details>`:''}`;
  }

  async function readArtifact(button){const request=requests.get(button.dataset.artifactRequest);if(!(request?.runId||request?.resumeRunId))return;button.disabled=true;try{const result=await api(`/api/projects/${encodeURIComponent(request.projectId)}/runs/${encodeURIComponent(request.runId||request.resumeRunId)}/artifacts/${encodeURIComponent(button.dataset.artifact)}`);if(typeof result.text!=='string')throw new Error('This artifact did not contain readable text.');if(button.dataset.download){const url=URL.createObjectURL(new Blob([result.text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(result.artifact?.path||result.artifact?.relativePath||'workforce-artifact.txt').split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}else{artifactPreviews.set(`${request.id}:${button.dataset.artifact}`,result.text.slice(0,64000)+(result.text.length>64000?'\n\nPreview shortened. Download the file for its full text.':''));renderMessages();}}catch(e){composerError=`Could not open this output: ${e.message}`;updateStatus();}finally{button.disabled=false;}}
  function messageMarkup(m) {
    if (m.role==='context') return `<article class="cc-message cc-user" data-message-id="${escape(m.id)}"><div class="cc-caption">Resumed task · original request</div><div class="cc-user-text">${escape(m.text)}</div></article>`;
    if (m.role==='user') return `<article class="cc-message cc-user" data-message-id="${escape(m.id)}"><div class="cc-user-text">${escape(m.text)}</div>${m.attachments?.length?`<div class="cc-sent-files">${m.attachments.map(f=>`<span>${icon('clip')}${escape(f.name)}<small>${sizeLabel(f.size||0)}</small></span>`).join('')}</div>`:''}<div class="cc-caption">You · ${dateLabel(m.createdAt)}</div></article>`;
    const request=requests.get(m.requestId)||m.request||{};
    const reply=mainReply(m);
    const active=ACTIVE.has(request.state);
    const status=requestStatus(request,feedRun(request),[...requests.values()],evidenceOptions(request));
    return `<article class="cc-message cc-assistant" data-message-id="${escape(m.id)}"><div class="cc-answer-title">${controlAvatar()}<strong>${escape(config().controlCenter?.name||'Tom Chandler')}<small>Control Center</small></strong>${m.legacy?'<span class="cc-caption">Prior design preview</span>':''}</div>${m.requestId?renderTaskRailSummary(railInput(request)):''}${reply?renderTaskReply(reply,request,renderChatMarkdown,feedRun(request)):m.error?`<p class="cc-response-status" role="status">${escape(m.error)}</p>`:''}${m.requestId?recoveryMarkup(request)+traceMarkup(m,request):''}${m.requestId?permissionMarkup(m,request)+outputsMarkup(m,request):''}${m.refreshError?`<p class="cc-error">${escape(m.refreshError)} Showing the last received response.</p>`:''}${m.requestId&&!active&&!reply&&request.state==='ended'?'<p class="cc-caption">The run ended without a recorded final response. Expand activity to inspect its evidence.</p>':''}<div class="cc-answer-actions">${reply?`<button type="button" class="icon-button" data-copy="${escape(m.id)}" aria-label="Copy response">${icon('copy')}</button>`:''}${m.requestId?`<span class="cc-caption">${escape(status)}</span>`:''}</div></article>`;
  }
  function inspectorMarkup(){return inspector.html?`<details class="chat-inspector"><summary class="chat-inspector-header">${icon('folder')}<span>${escape(inspector.title)}</span>${icon('down')}</summary><div class="chat-inspector-body">${inspector.html}</div></details>`:'';}
  function historyMarkup(){return threads.map(t=>`<button type="button" data-thread="${escape(t.id)}" class="${t===current()?'selected':''}"><span>${escape(t.title)}</span>${t===current()?icon('check'):''}</button>`).join('');}
  function mount(){element.classList.add('atlas-chat','live-control-chat','cc-task-rail');element.innerHTML=`<div class="chat-resizer" tabindex="0" role="separator" aria-orientation="vertical" aria-label="Resize conversation panel" aria-valuemin="340" aria-valuemax="700" aria-valuenow="${chatWidth}"></div><header class="chat-threadbar"><button class="icon-button cc-back-to-tasks" data-chat="tasks" aria-label="Back to tasks" title="Back to tasks">${icon('back')}</button><span data-control-avatar>${controlAvatar()}</span><div class="thread-title"><strong data-pane-title>Task status</strong><small data-thread-title></small></div><div class="chat-thread-actions"><details class="chat-thread-menu"><summary class="icon-button" aria-label="Conversation history" title="Conversation history">${icon('history')}</summary><div class="thread-menu-popover"><span class="eyebrow">CONVERSATIONS</span><div data-history></div></div></details><button class="icon-button" data-chat="new" aria-label="New conversation" title="New conversation">${icon('add')}</button><button class="icon-button" data-chat="expand" aria-label="Focus conversation" title="Focus conversation">${icon('expand')}</button><button class="icon-button chat-close-mobile" data-chat="close" aria-label="Close conversation">${icon('close')}</button></div></header><div class="cc-task-filter-wrap" data-task-filter-wrap></div><div id="chat-inspector-slot"></div><div class="chat-messages cc-messages" role="log" aria-label="Task status feed" aria-live="polite" aria-relevant="additions text"></div><div class="chat-composer-wrap cc-composer-wrap"><div class="cc-composer-heading"><div class="cc-composer-label">${icon('tasks')}Ask Control Center</div><span class="cc-attachment-count" data-file-count hidden></span></div><div data-context></div><div class="cc-composer-bottom"><label class="cc-project-select"><span>Project</span><select data-setting="projectId" aria-label="Project"></select></label><label class="cc-department-select"><span>Team</span><select data-setting="departmentId" aria-label="Department"></select></label></div><form id="atlas-message-form" class="chat-composer cc-composer"><div class="composer-attachments" data-files role="region" aria-label="Attached files. Scroll horizontally to see all files." tabindex="0" hidden></div><label for="atlas-message" class="sr-only">Message Control Center</label><textarea id="atlas-message" rows="2" maxlength="20000" placeholder="Ask anything, or give your team a task…"></textarea><div class="cc-composer-row"><button class="icon-button cc-attach-button" type="button" data-chat="attach" aria-label="Attach files" title="Attach up to 8 files">${icon('clip')}</button><details class="cc-agent-settings"><summary>Agent settings ${icon('down')}</summary><div class="cc-settings-popover"><strong>Agent settings</strong><div class="cc-model-pickers"><label class="cc-select"><span>Runtime</span><select data-setting="runtime" aria-label="Runtime"></select></label><label class="cc-select cc-model-select"><span>Model</span><select data-setting="model" aria-label="Model"></select></label><label class="cc-select"><span>Reasoning effort</span><select data-setting="effort" aria-label="Reasoning effort"></select></label></div><details class="cc-runtime-details"><summary title="Exact model and installed runtime details">Model details ${icon('down')}</summary><div class="cc-runtime-popover" data-model-details></div></details><button type="button" data-chat="refresh" class="cc-refresh-settings" aria-label="Refresh runtimes and models">${icon('refresh')}Refresh runtimes</button></div></details><button class="send-button" type="submit" aria-label="Send message" disabled>${icon('arrow')}</button></div></form><p class="cc-routing-hint" data-routing-hint hidden></p><div class="cc-status-line"><span data-connection role="status"></span></div><p class="cc-error" data-error role="alert" hidden></p><input type="file" id="atlas-file-input" multiple hidden></div>`;columns.style.setProperty('--chat-width',`${chatWidth}px`);bindResizer();renderThread();}
  const taskFilters=[['all','All'],['backlog','Backlog'],['progress','In progress'],['waiting','Needs you'],['done','Done']];
  let runSnapshotLoaded=workforce.connected;
  const feedRun=request=>mergeTaskRun(request,workforce.runs.find(run=>run.id===(request.runId||request.resumeRunId)&&(!run.projectId||run.projectId===request.projectId)),runDetails.get(request.id)?.status);
  const evidenceOptions=request=>({runsLoaded:runSnapshotLoaded||Boolean(runDetails.get(request.id)?.status)});
  const feedStatus=request=>requestTaskStatus(request,feedRun(request),[...requests.values()],evidenceOptions(request));
  const requestEvents=request=>{
    const runId=request.runId||request.resumeRunId;
    const events=[...(runDetails.get(request.id)?.events||[]),...workforce.events.filter(event=>event.runId===runId&&(!event.projectId||event.projectId===request.projectId))].filter(visibleTaskEvent);
    return [...new Map(events.map(event=>[`${event.runId||runId}:${event.sequence||event.cursor||event.timestamp}:${event.type}`,event])).values()];
  };
  const railInput=request=>({request,run:feedRun(request),requests:[...requests.values()],...evidenceOptions(request),events:requestEvents(request),agents:config().agents||[],departments:config().departments||[],projects:config().projects||[],connected:!connectionError&&!feedError});
  const controlAvatar=()=>avatar(config().controlCenter?.name||'Tom Chandler',28);
  function assignedOwnerIds(request){const tasks=feedRun(request)?.taskViews||runDetails.get(request.id)?.status?.taskViews||[];return [...new Set(tasks.filter(task=>task.state!=='superseded').map(task=>task.ownerAgentId||task.agentId).filter(Boolean))];}
  function feedRequests(){return latestRunRequests([...requests.values()]).filter(request=>taskScope?taskScope.requestIds.some(id=>id===request.id||newerRunRequest(requests.get(id),[...requests.values()])?.id===request.id):!departmentFilter||(request.departmentId||request.route?.departmentId)===departmentFilter).sort((a,b)=>taskLastChanged(b,feedRun(b),requestEvents(b))-taskLastChanged(a,feedRun(a),requestEvents(a))||a.id.localeCompare(b.id));}
  function recoveryMarkup(request) {
    const attention=taskAttention(request,feedRun(request),[...requests.values()],evidenceOptions(request));if(!attention)return '';
    const busy=retrying.has(request.id)||stopped.has(request.id);
    const buttons=attention.actions.map(action=>renderRequestActionButton(request,action,busy)).join('');
    return `<div class="cc-request-recovery" role="group" aria-label="Request next steps">${attention.message?`<p>${escape(attention.message)}</p>`:''}${attention.nextStep?`<p class="cc-caption">${escape(attention.nextStep)}</p>`:''}${buttons?`<div class="cc-request-actions">${buttons}</div>`:''}</div>`;
  }

  function requestPresentation(request) {
    const run=feedRun(request),facts=taskRailFacts(railInput(request));
    return {run,facts,fact:{...feedStatus(request),label:facts.status},changedAt:taskLastChanged(request,run,requestEvents(request))};
  }
  function cardSignature(request,presentation) {return JSON.stringify(compactRequestCard(request,presentation,config().agents,config().controlCenter));}
  function cardMarkup(request,presentation){return renderCompactRequestCard(compactRequestCard(request,presentation,config().agents,config().controlCenter));}

  function renderTaskFilters(rows){const counts=Object.fromEntries(taskFilters.map(([id])=>[id,id==='all'?rows.length:rows.filter(r=>feedStatus(r).bucket===id).length]));const department=config().departments?.find(d=>d.id===departmentFilter);const html=`${departmentFilter?`<button type="button" class="cc-feed-department" data-chat="all-departments">${escape(department?.name||departmentFilter)} ${icon('close')}</button>`:''}${taskScope?`<p class="cc-feed-scope">Requests containing ${taskScope.taskIds.length||'selected'} ${escape(taskScope.label)} task${taskScope.taskIds.length===1?'':'s'}.</p>`:''}<nav class="cc-task-filters" aria-label="Filter task status">${taskFilters.map(([id,label])=>`<button type="button" data-task-filter="${id}" aria-pressed="${taskFilter===id}" class="${taskFilter===id?'is-active':''}"><span>${label}</span><b>${counts[id]}</b></button>`).join('')}</nav>`;const host=element.querySelector('[data-task-filter-wrap]');if(host.dataset.markup!==html){host.innerHTML=html;host.dataset.markup=html;}}
  function renderFeed(){
    const host=element.querySelector('.chat-messages'),rows=feedRequests();renderTaskFilters(rows);
    if(!host.querySelector('.cc-task-feed')){host.innerHTML='<div class="cc-task-feed" aria-label="Task status feed"></div>';delete host.dataset.markup;}
    const list=host.querySelector('.cc-task-feed');
    const filtered=rows.filter(request=>taskFilter==='all'||feedStatus(request).bucket===taskFilter);
    const wanted=new Set(filtered.map(request=>request.id));
    for(const node of [...list.children])if(node.dataset.feedCard?!wanted.has(node.dataset.feedCard):filtered.length>0)node.remove();
    const existing=new Map([...list.children].map(node=>[node.dataset.feedCard,node]));
    const mayAnimate=!matchMedia('(prefers-reduced-motion: reduce)').matches;
    for(const [index,request] of filtered.entries()){
      const presentation=requestPresentation(request),fact=presentation.fact;
      const statusSignature=JSON.stringify([fact.bucket,fact.label,request.state,request.route?.state]);
      const previous=feedSeen.get(request.id);let node=existing.get(request.id);const fresh=!node;
      if(!node){node=document.createElement('article');node.className='cc-task-card';node.dataset.feedCard=request.id;}
      const signature=cardSignature(request,presentation);
      if(renderSignatures.get(node)!==signature){
        node.dataset.state=fact.bucket;const next=node.cloneNode(false);next.innerHTML=cardMarkup(request,presentation);patchChatNode(node,next);renderSignatures.set(node,signature);
      }
      if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);
      if(mayAnimate&&feedSnapshotShown&&fresh&&!previous&&instant(request.receivedAt)>=connectedAt)revealTask(node);
      else if(mayAnimate&&previous&&previous!==statusSignature)acknowledgeStatus(node.querySelector('.cc-task-card-status'));
      feedSeen.set(request.id,statusSignature);
    }
    if(!filtered.length){
      const copy=!feedReady?['Loading task status','Reading your local coordinator.']:taskFilter==='all'?['Your next task starts here.','Describe an outcome below. Every new task runs independently.']:taskFilter==='waiting'?['Nothing needs you.','Requests that need your attention appear here with their actual reason.']:taskFilter==='done'?['Completed work will appear here.','Reviewed results stay available with their conversation and evidence.']:[`No ${taskFilter==='progress'?'tasks in progress':'tasks in the backlog'}.`,'New work appears here as your team receives it.'];
      const html=`<div class="cc-task-feed-empty">${icon('tasks')}<h3>${copy[0]}</h3><p>${copy[1]}</p></div>`;
      if(list.innerHTML!==html)list.innerHTML=html;
    }
    if(feedReady)feedSnapshotShown=true;
    const title=feedError?'Showing last received status':'Latest changes across your workforce';
    if(element.querySelector('[data-thread-title]').textContent!==title)element.querySelector('[data-thread-title]').textContent=title;
  }

  function renderThread(){const t=current();element.querySelector('.chat-messages').setAttribute('aria-label',paneMode==='feed'?'Task status feed':'Conversation messages');autoHandoff=true;t.autoHandoff=true;element.classList.toggle('is-task-feed',paneMode==='feed');element.classList.toggle('is-task-conversation',paneMode==='conversation');element.querySelector('[data-pane-title]').textContent=paneMode==='feed'?'Task status':'Control Center';element.querySelector('#atlas-message').value=t.draft;element.querySelector('#atlas-message').placeholder=paneMode==='feed'||!t.messages.length?'Give your team a new task…':'Follow up on this task…';element.querySelector('[data-thread-title]').textContent=paneMode==='feed'?'Live requests from your workforce':t.title;element.querySelector('[data-history]').innerHTML=historyMarkup();element.querySelector('#chat-inspector-slot').innerHTML=inspectorMarkup();renderMessages(true);renderContext();renderFiles();updateSelectors();updateStatus();}
  function messageSignature(message){
    const request=requests.get(message.requestId)||message.request;
    const detail=runDetails.get(message.requestId);
    return JSON.stringify([message.id,message.role,message.text,message.attachments,message.createdAt,message.error,message.legacy,message.refreshError,mainReply(message),request&&requestPresentation(request).facts,request?.route,request?.result,request?.recovery,request?.controlCenter,detail?.events?.filter(visibleTaskEvent).slice(-120),detail?.status?.artifacts,[...artifactPreviews].filter(([key])=>key.startsWith(`${message.requestId}:`)),stopped.has(message.requestId),retrying.has(message.requestId),permissionChecks.has(message.id),message.permissionRetriedRequestId,sending.has(current().id),config().controlCenter?.name]);
  }
  function renderMessages(forceScroll=false){
    if(document.visibilityState==='hidden'||columns.classList.contains('chat-closed'))return;
    if(paneMode==='feed'){renderFeed();return;}
    const thread=current();
    const resumed=thread.messages.find(message=>{const request=requests.get(message.requestId)||message.request;return request?.kind==='resume'||request?.resumeRunId;});
    if(resumed){const request=requests.get(resumed.requestId)||resumed.request;if(hydrateResumeConversation(thread,request,feedRun(request))){element.querySelector('[data-thread-title]').textContent=thread.title;element.querySelector('[data-history]').innerHTML=historyMarkup();persist();}}
    const container=element.querySelector('.chat-messages');
    const nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<100,oldScroll=container.scrollTop;
    const messages=current().messages,wanted=new Set(messages.map(message=>message.id));
    for(const node of [...container.children])if(node.dataset.messageId?!wanted.has(node.dataset.messageId):messages.length>0)node.remove();
    const existing=new Map([...container.children].map(node=>[node.dataset.messageId,node]));
    for(const [index,message] of messages.entries()){
      const signature=messageSignature(message);let node=existing.get(message.id);
      if(!node||renderSignatures.get(node)!==signature){
        const template=document.createElement('template');template.innerHTML=messageMarkup(message);const next=template.content.firstElementChild;
        if(node)patchChatNode(node,next);else node=next;
        renderSignatures.set(node,signature);
      }
      if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);
    }
    if(!messages.length){const html=`<div class="cc-empty">${mark()}<h2>What should we work on?</h2><p>Ask Control Center, or describe the outcome you need.</p></div>`;if(container.innerHTML!==html)container.innerHTML=html;}
    if(forceScroll||nearBottom)container.scrollTop=container.scrollHeight;else container.scrollTop=oldScroll;
  }

  function renderContext(){const c=current().context;element.querySelector('[data-context]').innerHTML=c?`<div class="composer-context">${icon('folder')}<span>${escape(c.label||c.id)}</span><button type="button" data-chat="clear-context" aria-label="Remove context">${icon('close')}</button></div>`:'';}
  function renderFiles(){
    const files=current().attachments,host=element.querySelector('[data-files]'),scroll=host.scrollLeft;
    host.hidden=!files.length;
    host.innerHTML=files.map(f=>`<span class="attachment-chip cc-file-${f.status}" title="${escape(f.name)} · ${escape(f.error||`${f.mimeType} · ${sizeLabel(f.size)}`)}">${icon('clip')}<span><strong>${escape(f.name)}</strong><small>${f.status==='uploading'?'Uploading…':f.status==='error'?'Upload failed':sizeLabel(f.size)}</small></span><button type="button" data-remove-file="${escape(f.key)}" aria-label="Remove ${escape(f.name)}">${icon('close')}</button></span>`).join('');
    host.scrollLeft=scroll;
    const count=element.querySelector('[data-file-count]');count.hidden=!files.length;count.textContent=`${files.length} / 8 files`;
  }
  function optionModelLabel(model){const label=model.label||model.runtimeLabel||model.id;return label.toLowerCase().replace(/[^a-z0-9]/g,'')===model.id.toLowerCase().replace(/[^a-z0-9]/g,'')?label:`${label} · ${model.id}`;}
  function options(select,rows,value){const markup=rows.map(r=>`<option value="${escape(r.id)}" ${r.disabled?'disabled':''}${r.title?` title="${escape(r.title)}"`:''}>${escape(r.label)}</option>`).join('');if(select.innerHTML!==markup)select.innerHTML=markup;select.value=value;}
  function updateModelDetails(s){const catalog=s.catalog,model=s.entry;const source=catalog?.source||'';const rows=[['Runtime',runtimePickerName(s.runtime)],['Runtime binding',s.runtime],['CLI version',catalog?.version||reportFor(s.runtime)?.version],['Model',model?.label||s.effectiveModel],['Selector ID',model?.id||s.effectiveModel],...(model?.resolvedModel&&model.resolvedModel!==model.id?[['Resolved model',model.resolvedModel]]:[]),...(model?.catalogId&&model.catalogId!==model.id?[['Catalog ID',model.catalogId]]:[]),...(model?.runtimeLabel&&model.runtimeLabel!==model.label?[['Runtime label',model.runtimeLabel]]:[]),['Reasoning effort',s.effectiveEffort||'Runtime default'],['Reported efforts',model?.efforts?.join(', ')],['Input types',model?.inputModalities?.join(', ')],['Source',source],['Executable',catalog?.resolvedExecutable||catalog?.executable||config().runtimes?.[s.runtime]?.executable],['Checked',catalog?.checkedAt?new Date(catalog.checkedAt).toLocaleString():null]].filter(([,value])=>value);element.querySelector('[data-model-details]').innerHTML=`<strong>Selected runtime & model</strong><dl>${rows.map(([key,value])=>`<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${model?.provenance==='runtime-reported'?'<p>The identifiers and capabilities above were reported by the installed runtime.</p>':''}${catalog?.status==='loading'?'<p role="status">Reading the installed runtime…</p>':''}${catalog?.diagnostics?.length?`<p>${catalog.diagnostics.map(escape).join('<br>')}</p>`:''}`;}
  function updateSelectors(){const avatarHost=element.querySelector('[data-control-avatar]');if(avatarHost)avatarHost.innerHTML=controlAvatar();const s=selected();const runtimes=Object.keys(config().runtimes||{});options(element.querySelector('[data-setting="runtime"]'),runtimes.length?runtimes.map(id=>({id,label:runtimes.filter(other=>runtimePickerName(other)===runtimePickerName(id)).length>1?`${runtimePickerName(id)} · ${id}`:runtimePickerName(id),title:`${runtimeName(id)} · ${id} · ${config().runtimes[id].executable||'Configured runtime'}`})):[{id:'',label:workspace?'No runtimes':'Connecting…'}],s.runtime);const models=s.catalog?.models||[];const defaultModel=models.find(m=>m.id===s.runtimeDefaultModel);options(element.querySelector('[data-setting="model"]'),[{id:'',label:s.catalog?.status==='loading'?'Reading models…':`Runtime default${defaultModel?` · ${defaultModel.label||defaultModel.id}`:''}`,title:s.runtimeDefaultModel},...models.map(m=>({id:m.id,label:optionModelLabel(m),title:[m.id,m.resolvedModel&&m.resolvedModel!==m.id?`Resolves to ${m.resolvedModel}`:'',m.description||''].filter(Boolean).join(' · ')})),...(s.model&&!models.some(m=>m.id===s.model)?[{id:s.model,label:!s.catalog||s.catalog.status==='loading'?'Reading models…':`${s.model} · unavailable`,disabled:true}]:[])],s.model);const effortLabels={xhigh:'Extra high',max:'Max',ultra:'Ultra',minimal:'Minimal',none:'None',low:'Low',medium:'Medium',high:'High'};options(element.querySelector('[data-setting="effort"]'),[{id:'',label:'Default effort',title:s.effectiveEffort?`Resolved effort: ${s.effectiveEffort}`:'Runtime default'},...(s.entry?.efforts||[]).map(e=>({id:e,label:effortLabels[e]||e,title:e})),...(s.effort&&!s.entry?.efforts?.includes(s.effort)?[{id:s.effort,label:!s.catalog||s.catalog.status==='loading'?'Reading efforts…':`${s.effort} · unavailable`,disabled:true}]:[])],s.effort);options(element.querySelector('[data-setting="projectId"]'),projects().length?projects().map(p=>({id:p.id,label:p.name})):[{id:'',label:'Select a project'}],s.projectId);element.querySelector('[data-setting="projectId"]').title=s.projectId?'Project tasks start from the latest commit. Uncommitted edits stay in your working folder.':'';options(element.querySelector('[data-setting="departmentId"]'),[{id:'',label:'Automatic'},...(config().departments||[]).filter(department=>!department.archived).map(department=>({id:department.id,label:department.name}))],s.departmentId);updateRoutingHint();element.querySelector('[data-setting="runtime"]').title=`${runtimeName(s.runtime)} · ${s.runtime}`;element.querySelector('[data-setting="model"]').title=[s.entry?.label||s.effectiveModel,s.entry?.id,s.entry?.resolvedModel].filter(Boolean).join(' · ');element.querySelector('[data-setting="effort"]').title=s.effectiveEffort?`Reasoning effort: ${s.effectiveEffort}`:'Runtime default effort';element.querySelector('[data-setting="model"]').disabled=!s.catalog||s.catalog.status==='loading';element.querySelector('[data-setting="effort"]').disabled=!s.entry?.efforts?.length;updateModelDetails(s);}
  function updateRoutingHint(){const hint=element.querySelector('[data-routing-hint]');if(!hint)return;const text=departmentRoutingHint(current().draft,config().departments||[],selected().departmentId).text;if(hint.textContent!==text)hint.textContent=text;hint.hidden=!current().draft.trim()&&!selected().departmentId;}
  function priorMessage(projectId=selected().projectId,t=current()){if(t===feedDraft)return null;return t.messages.filter(m=>m.requestId&&(requests.get(m.requestId)||m.request)?.projectId===projectId).at(-1);}
  function inheritedAttachments(projectId=selected().projectId){const m=priorMessage(projectId);return (m&&(requests.get(m.requestId)||m.request)?.attachments)||[];}
  function combinedAttachments(projectId=selected().projectId){return [...new Map([...inheritedAttachments(projectId),...current().attachments].map(f=>[f.id||f.key,f])).values()];}
  function sendBlocker(){const s=selected();if(!workspace)return connectionError||'Connecting to your local coordinator…';if(!s.runtime)return 'Configure a runtime for Control Center.';if(!s.projectId||!projects().some(p=>p.id===s.projectId))return 'Select a project before sending.';const report=reportFor(s.runtime);if(report&&(report.installed===false||report.auth==='logged_out'||report.controllable===false))return `${runtimeName(s.runtime)} needs attention: ${report.loginHint||report.readiness||'check the runtime settings'}.`;if(!s.catalog||s.catalog.status==='loading')return 'Reading models from the selected runtime…';if(s.model&&!s.catalog.models?.some(m=>m.id===s.model))return 'Choose a model reported by this runtime, or select Runtime default.';if(s.effectiveModel&&s.catalog.status==='available'&&!s.entry)return 'The configured runtime default is not reported by this runtime. Choose an available model.';if(s.effort&&!s.entry?.efforts?.includes(s.effort))return 'Choose an effort supported by this model, or select Default effort.';if(!s.effort&&s.effectiveEffort&&s.entry?.efforts?.length&&!s.entry.efforts.includes(s.effectiveEffort))return 'The configured default effort is not supported by this model. Choose one of its reported effort levels.';if(current().attachments.some(f=>f.status!=='ready'))return current().attachments.some(f=>f.status==='uploading')?'Uploading your files…':'Remove failed uploads and choose the files again.';const inherited=inheritedAttachments(s.projectId);const files=combinedAttachments(s.projectId);const fileIssue=attachmentError(files);if(fileIssue)return `${fileIssue}${inherited.length?' This includes earlier conversation files. Start a new conversation to omit them.':''}`;if(files.some(f=>f.mimeType?.startsWith('image/'))&&s.entry?.inputModalities&&!s.entry.inputModalities.includes('image'))return inherited.some(f=>f.mimeType?.startsWith('image/'))?'This conversation includes earlier images. Choose an image-capable model, or start a new conversation to omit those files.':'This model does not report image support. Choose an image-capable model or remove the image.';return '';}
  function updateStatus(){updateRoutingHint();const blocker=sendBlocker();const busy=sending.has(current().id);const button=element.querySelector('button[type="submit"]');button.disabled=busy||!current().draft.trim()||Boolean(blocker);button.setAttribute('aria-label',busy?'Sending message':'Send message');button.title=getSettings().sendShortcut==='mod-enter'?'Send message (⌘ / Ctrl + Enter)':'Send message (Enter)';element.querySelector('#atlas-message').setAttribute('aria-description',getSettings().sendShortcut==='mod-enter'?'Command or Control plus Enter sends. Enter adds a new line.':'Enter sends. Shift plus Enter adds a new line.');button.innerHTML=busy?'<span class="cc-send-spinner" aria-hidden="true"></span>':icon('arrow');const error=element.querySelector('[data-error]');error.textContent=composerError||configurationError||'';error.hidden=!error.textContent;const status=element.querySelector('[data-connection]');status.textContent=blocker||connectionError||'Ready';status.classList.toggle('cc-offline',Boolean(connectionError));element.querySelector('[data-chat="attach"]').disabled=busy;}
  async function loadCatalog(id,refresh=false){if(!id)return;const bindingIdentity=()=>JSON.stringify([config().runtimes?.[id]?.adapter,config().runtimes?.[id]?.executable]);const identity=bindingIdentity();const pending=catalogReads.get(id);if(!refresh&&pending?.identity===identity)return pending.promise;const existing=catalogs.get(id);const fresh=Date.now()-(catalogCheckedAt.get(id)||0)<60_000;if(!refresh&&existing&&existing.status!=='error'&&fresh)return;const shouldRefresh=refresh||Boolean(existing);const token=Symbol(id);catalogs.set(id,{...existing,status:'loading',models:existing?.models||[]});updateSelectors();updateStatus();const promise=(async()=>{try{const catalog=await api(`/api/runtimes/${encodeURIComponent(id)}/models${shouldRefresh?'?refresh=1':''}`);if(catalogReads.get(id)?.token!==token||bindingIdentity()!==identity)return;if(catalog.runtimeId&&catalog.runtimeId!==id)throw new Error('This model catalog belongs to a different runtime binding. Refresh the selected runtime.');catalogs.set(id,catalog);catalogCheckedAt.set(id,Date.now());}catch(error){if(catalogReads.get(id)?.token===token&&bindingIdentity()===identity)catalogs.set(id,{status:'error',models:[],diagnostics:[error.message]});}finally{if(catalogReads.get(id)?.token===token)catalogReads.delete(id);updateSelectors();updateStatus();}})();catalogReads.set(id,{token,identity,promise});return promise;}
  async function connect(refresh=false){const before=workspace;try{const incoming=await api(`/api/workspace${refresh?'?refresh=1':''}`);if(workspace!==before&&workspace?.path!==incoming.path)return;ingestWorkspace(incoming);await loadCatalog(selected().runtime,refresh);updateSelectors();updateStatus();dispatch('workspace',{workspace});await recover();}catch(e){connectionError=e.message||'Local coordinator is unavailable.';updateStatus();}}
  async function recover(){try{const result=await api('/api/requests');const items=result.items||[];for(const item of items)requests.set(item.id,item);feedReady=true;feedError='';const byClient=new Map(items.map(r=>[r.clientRequestId,r]));for(const t of [...threads,feedDraft]){if(t.submission){const found=byClient.get(t.submission.clientRequestId);if(found)acceptReceipt(t,t.submission,found);}for(const m of t.messages){if(m.requestId){const found=items.find(r=>r.id===m.requestId);if(found)updateRequest(m,found);}}}const known=new Set(threads.flatMap(t=>t.messages.map(m=>m.requestId).filter(Boolean)));for(const request of items.slice(0,20).reverse()){if(known.has(request.id))continue;const t=newThread();t.title=request.task?.slice(0,48)||'Recorded conversation';t.createdAt=Date.parse(request.receivedAt)||Date.now();t.autoHandoff=request.mode?request.mode==='delegate':true;t.selection={runtime:request.controlCenter?.runtime,model:request.controlCenter?.model,effort:request.controlCenter?.effort,projectId:request.projectId};t.messages=[{id:uid(),role:'user',text:request.task||'',attachments:request.attachments||[],createdAt:t.createdAt},{id:uid(),role:'assistant',requestId:request.id,request,text:request.controlReply||'',createdAt:Date.parse(request.endedAt||request.receivedAt)}];requests.set(request.id,request);threads.push(t);}persist();element.querySelector('[data-history]').innerHTML=historyMarkup();renderMessages();updateStatus();}catch(e){connectionError=e.message;updateStatus();}}
  function acceptReceipt(t,submission,request,consumeDraft=true){if(t.messages.some(m=>m.requestId===request.id))return;const user={id:uid(),role:'user',text:submission.text,attachments:submission.attachments,createdAt:Date.now()};const assistant={id:uid(),role:'assistant',requestId:request.id,request,text:request.controlReply||'',createdAt:Date.now()};t.messages.push(user,assistant);requests.set(request.id,request);if(t.title==='New conversation')t.title=submission.text.slice(0,48);if(consumeDraft){const submittedIds=new Set((submission.attachments||[]).map(f=>f.id));t.attachments=t.attachments.filter(f=>!f.id||!submittedIds.has(f.id));if(t.draft.trim()===submission.text){t.draft='';if(t===current())element.querySelector('#atlas-message').value='';}if(t===current())renderFiles();t.submission=null;}if(t===feedDraft){const next=newThread();next.selection={...t.selection};next.autoHandoff=t.autoHandoff;next.draft=t.draft;next.attachments=t.attachments;feedDraft=next;t.draft='';t.attachments=[];if(!threads.includes(t))threads.unshift(t);if(paneMode==='feed')renderThread();}if(Date.parse(request.receivedAt||'')>=connectedAt)dispatch('request',{requestId:request.id,request,phase:'received'});}
  function updateRequest(m,request){const old=requests.get(request.id);requests.set(request.id,request);m.request=request;m.text=request.controlReply||runDetails.get(request.id)?.status?.run?.finalReply||'';m.refreshError='';if((old||Date.parse(request.receivedAt||'')>=connectedAt)&&(!old||JSON.stringify([old.state,old.route,old.workerIds,old.controlReply])!==JSON.stringify([request.state,request.route,request.workerIds,request.controlReply])))dispatch('request',{requestId:request.id,request,phase:request.state});}
  async function refreshRequest(message,{force=false}={}){
    if(refreshingRequests.has(message.requestId))return;refreshingRequests.add(message.requestId);
    const cached=runDetails.get(message.requestId)||{events:[],after:0};
    try{
      let request=requests.get(message.requestId)||message.request;
      if(!request||force){const result=await api(`/api/requests/${encodeURIComponent(message.requestId)}`);request=result.request||result.task;}
      if(!request)throw new Error('The coordinator returned no request record.');
      updateRequest(message,request);
      const runId=request.runId||request.resumeRunId;
      if(runId){
        const snapshot=workforce.runs.find(run=>run.id===runId&&(!run.projectId||run.projectId===request.projectId));
        const base=`/api/projects/${encodeURIComponent(request.projectId)}/runs/${encodeURIComponent(runId)}`;
        const after=cached.after||Math.max(0,Number(snapshot?.eventCount||0)-200);
        const results=await Promise.allSettled([api(base),api(`${base}/events?after=${after}&limit=200`)]);
        if(results[0].status==='fulfilled')cached.status=results[0].value;
        if(results[1].status==='fulfilled'){
          const rows=results[1].value.events||[],known=new Set(cached.events.map(event=>event.sequence));
          for(const event of rows){if(known.has(event.sequence)||!visibleTaskEvent(event))continue;cached.events.push(event);if(instant(event.timestamp)>=connectedAt)dispatch('activity',{requestId:request.id,request,event});}
          if(rows.length)cached.after=rows.at(-1).sequence;
          cached.hasMore=results[1].value.hasMore;cached.events=cached.events.slice(-400);
        }
        const failure=results.find(result=>result.status==='rejected');
        if(failure)throw failure.reason;
      }
      cached.version=requestDetailKey(request,mergeTaskRun(request,workforce.runs.find(run=>run.id===runId&&(!run.projectId||run.projectId===request.projectId)),cached.status));cached.retryAt=0;
      runDetails.set(request.id,cached);message.text=request.controlReply||cached.status?.run?.finalReply||'';
      while(runDetails.size>60)runDetails.delete(runDetails.keys().next().value);
    }catch(error){message.refreshError=error.message;cached.retryAt=Date.now()+10000;runDetails.set(message.requestId,cached);}
    finally{refreshingRequests.delete(message.requestId);}
  }
  function visibleRequestIds(){
    const host=element.querySelector('.chat-messages'),viewport=host.getBoundingClientRect();
    const nodes=paneMode==='feed'?[...host.querySelectorAll('[data-feed-card]')]:[...host.querySelectorAll('[data-message-id]')];
    return nodes.filter(node=>{const rect=node.getBoundingClientRect();return rect.bottom>viewport.top&&rect.top<viewport.bottom;}).map(node=>paneMode==='feed'?node.dataset.feedCard:current().messages.find(message=>message.id===node.dataset.messageId)?.requestId).filter(Boolean);
  }
  async function poll(){
    if(polling||destroyed||document.visibilityState==='hidden'||columns.classList.contains('chat-closed'))return;
    polling=true;
    try{
      const candidates=visibleDetailCandidates({requests:[...requests.values()],visibleIds:visibleRequestIds(),paneMode,cache:runDetails,runFor:feedRun});
      await Promise.allSettled(candidates.filter(request=>!(runDetails.get(request.id)?.retryAt>Date.now())).map(request=>refreshRequest(current().messages.find(message=>message.requestId===request.id)||{requestId:request.id,request})));
      if(candidates.length){renderMessages();persist();}
    }finally{polling=false;}
  }
  async function retryRequest(id){
    const original=requests.get(id);
    if(original?.recovery?.nextRequestId){await openRequest(original.recovery.nextRequestId);return;}
    if(!original?.recovery?.canRetry||retrying.has(id))return;
    retrying.add(id);composerError='';renderMessages();
    try{
      const result=await retrySavedRequest(original);
      const next=result.request||result.task;if(!next?.id)throw new Error('No retry receipt was returned. Your retry identity is retained.');
      requests.set(id,{...original,recovery:{...original.recovery,canRetry:false,nextRequestId:next.id}});
      let thread=threads.find(item=>item.messages.some(message=>message.requestId===id));
      if(!thread){thread=newThread();thread.selection={projectId:next.projectId};threads.unshift(thread);}
      acceptReceipt(thread,{text:next.task||original.task,attachments:next.attachments||original.attachments||[]},next,false);
      persist();await openRequest(next.id);
    }catch(error){composerError=`${error.message} Retrying again will use the same retry identity.`;updateStatus();}
    finally{retrying.delete(id);renderMessages();}
  }

  async function send(){const t=current();t.draft=element.querySelector('#atlas-message').value;const text=t.draft.trim();if(!text||sending.has(t.id))return;const blocker=sendBlocker();if(blocker){composerError=blocker;updateStatus();return;}const s=selected();const attachments=t.attachments.map(f=>({id:f.id,name:f.name,size:f.size,mimeType:f.mimeType}));const controlCenter={runtime:s.runtime,...(s.model?{model:s.model}:{}),...(s.effort?{effort:s.effort}:{})};const previous=priorMessage(s.projectId,t);const payload={projectId:s.projectId,task:text,mode:'delegate',controlCenter,...(s.departmentId?{departmentId:s.departmentId}:{}),...(previous?{priorRequestId:previous.requestId}:{}),...(attachments.length?{attachmentIds:attachments.map(f=>f.id)}:{})};const fingerprint=JSON.stringify(payload);if(t.submission?.fingerprint!==fingerprint)t.submission={clientRequestId:uid(),fingerprint,text,attachments,payload};const submission=t.submission;sending.add(t.id);composerError='';persist();updateStatus();dispatch('sending',{threadId:t.id,phase:'sending'});try{const result=await api('/api/requests',{...submission.payload,clientRequestId:submission.clientRequestId});const request=result.task||result.request;if(!request?.id)throw new Error('The coordinator did not return a receipt. Retry will use the same request identity.');acceptReceipt(t,submission,request);persist();if(t===current()){element.querySelector('#atlas-message').value=t.draft;renderThread();element.querySelector('#atlas-message').focus({preventScroll:true});}void poll();}catch(e){composerError=`${e.message} Your draft is saved. Retry uses the same request identity.`;persist();}finally{sending.delete(t.id);updateStatus();}}
  async function upload(files){const t=current();const invalid=attachmentError(files,t.attachments);if(invalid){composerError=invalid;updateStatus();return;}const rows=files.map(f=>({key:uid(),name:f.name,size:f.size,mimeType:f.type||'application/octet-stream',status:'uploading'}));t.attachments.push(...rows);activeUploadCount++;composerError='';persist();renderFiles();updateStatus();try{const encoded=[];for(const file of files){const bytes=new Uint8Array(await file.arrayBuffer());const chunks=[];for(let i=0;i<bytes.length;i+=8192)chunks.push(String.fromCharCode(...bytes.subarray(i,i+8192)));encoded.push({name:file.name,mimeType:file.type||'application/octet-stream',data:btoa(chunks.join(''))});}const result=await api('/api/attachments',{files:encoded});const uploaded=result.attachments||result.files||[];if(uploaded.length!==rows.length)throw new Error('The coordinator did not confirm all uploaded files.');rows.forEach((row,i)=>Object.assign(row,uploaded[i],{status:'ready'}));}catch(e){rows.forEach(row=>Object.assign(row,{status:'error',error:e.message}));composerError=`Upload failed: ${e.message}`;}finally{activeUploadCount--;persist();if(t===current()||rows.some(row=>current().attachments.some(file=>file.key===row.key))){renderFiles();updateStatus();}}}
  async function requestAction(id,action){
    const request=requests.get(id);if(!request||stopped.has(id))return;if(action==='resume'){const successor=newerRunRequest(request,[...requests.values()]);if(successor){await openRequest(successor.id);return;}}
    if(['answer','followup','permission','diagnostics','runtime'].includes(action)){
      await openRequest(id);
      if(action==='runtime'){current().draft=request.task||'';element.querySelector('#atlas-message').value=current().draft;const settings=element.querySelector('.cc-agent-settings');if(settings)settings.open=true;persist();updateStatus();element.querySelector('[data-setting="runtime"]')?.focus();notify('Choose an available runtime, then send the prepared request. The original attempt is preserved.');return;}
      if(action==='answer'||action==='followup'){
        if(action==='followup'&&!current().draft){current().draft='Investigate the missing verification or review evidence for this request and explain what needs to be repaired.';element.querySelector('#atlas-message').value=current().draft;persist();updateStatus();}
        focus();return;
      }
      const message=current().messages.find(message=>message.requestId===id);
      const selector=action==='permission'?'.cc-permission':'.cc-trace';
      const article=[...element.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===message?.id);
      const disclosure=article?.querySelector(selector);if(disclosure){disclosure.open=true;disclosure.scrollIntoView({block:'nearest',behavior:'auto'});}return;
    }
    stopped.add(id);composerError='';renderMessages();
    try{
      if(action==='signin'){const result=await startRequestSignIn({request,runtimes:config().runtimes,api});notify(result.message);document.querySelector('.nav-list [data-nav="connections"]')?.click();}
      else if(action==='refresh'){runDetails.delete(id);await workforce.refresh();await refreshRequest(current().messages.find(message=>message.requestId===id)||{requestId:id,request});}
      else {const endpoint=requestControlEndpoint(request,action,feedRun(request));if(!endpoint)throw new Error('This request changed state. Refresh its status before trying that action again.');const result=await api(endpoint,{});const saved=result.request||result.task;if(saved?.id)requests.set(saved.id,saved);await workforce.refresh();if(action==='resume'&&saved?.id)await openRequest(saved.id);await poll();}
    }catch(error){composerError=`Could not ${action==='cancel'?'cancel this request':action==='start'?'continue this request':action==='resume'?'resume this review':action==='signin'?'open sign-in':'refresh this result'}: ${error.message}`;updateStatus();}
    finally{stopped.delete(id);renderMessages();}
  }

  function showTasks(options={}){paneMode='feed';const aliases={next:'backlog',doing:'progress',blocked:'waiting',complete:'done'};taskFilter=aliases[options.filter]||options.filter||'all';if(!taskFilters.some(([id])=>id===taskFilter))taskFilter='all';departmentFilter=options.departmentId||null;taskScope=Array.isArray(options.requestIds)?{requestIds:[...new Set(options.requestIds)],taskIds:options.taskIds||[],label:({done:'completed',progress:'active',backlog:'queued',waiting:'waiting'})[taskFilter]||'selected',filter:taskFilter}:null;if(taskScope)taskFilter='all';inspector={html:'',title:''};composerError='';renderThread();show();element.querySelector('.chat-messages').scrollTop=0;persist();void loadCatalog(selected().runtime);}
  async function openRequest(requestId){let found=threads.find(t=>t.messages.some(m=>m.requestId===requestId));if(!found){try{const cached=requests.get(requestId);const result=cached?{request:cached}:await api(`/api/requests/${encodeURIComponent(requestId)}`);const request=result.request||result.task;if(!request?.id)throw new Error('The request record was not returned.');found=newThread();found.title=request.task?.slice(0,48)||'Recorded conversation';found.autoHandoff=request.mode?request.mode==='delegate':true;found.selection={projectId:request.projectId,...request.controlCenter};found.messages=[{id:uid(),role:'user',text:request.task||'',attachments:request.attachments||[],createdAt:Date.parse(request.receivedAt)},{id:uid(),role:'assistant',requestId:request.id,request,text:request.controlReply||'',createdAt:Date.parse(request.receivedAt)}];requests.set(request.id,request);threads.unshift(found);}catch(error){notify(error.message);return;}}activeId=found.id;paneMode='conversation';inspector={html:'',title:''};composerError='';persist();renderThread();show();const messages=element.querySelector('.chat-messages');const messageId=found.messages.find(message=>message.requestId===requestId)?.id;const target=[...messages.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===messageId);if(target)messages.scrollTop+=target.getBoundingClientRect().top-messages.getBoundingClientRect().top-12;void loadCatalog(selected().runtime);void poll();}
  function focus(context){show();if(context){current().context=context;persist();renderContext();}element.querySelector('#atlas-message').focus();}
  function bindResizer(){const r=element.querySelector('.chat-resizer');const resize=value=>{chatWidth=Math.max(340,Math.min(700,value));columns.style.setProperty('--chat-width',`${chatWidth}px`);r.setAttribute('aria-valuenow',String(Math.round(chatWidth)));};r.addEventListener('pointerdown',e=>{if(e.button===0){r.setPointerCapture(e.pointerId);r.classList.add('resizing');}});r.addEventListener('pointermove',e=>{if(r.hasPointerCapture(e.pointerId))resize(innerWidth-e.clientX);});for(const event of ['pointerup','pointercancel','lostpointercapture'])r.addEventListener(event,()=>{r.classList.remove('resizing');persist();});r.addEventListener('dblclick',()=>{resize(420);persist();});r.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?420:chatWidth+(e.key==='ArrowLeft'?20:-20));persist();}});}
  element.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.requestAction){void requestAction(b.dataset.actionRequest,b.dataset.requestAction);return;}if(b.dataset.requestRetry){void retryRequest(b.dataset.requestRetry);return;}if(b.dataset.retrySuccessor){void openRequest(b.dataset.retrySuccessor);return;}if(b.dataset.feedRequest){void openRequest(b.dataset.feedRequest);return;}if(b.dataset.taskFilter){taskFilter=b.dataset.taskFilter;if(taskFilter==='all')taskScope=null;renderFeed();return;}if(b.dataset.thread){b.closest('details').open=false;activeId=b.dataset.thread;paneMode='conversation';inspector={html:'',title:''};composerError='';persist();renderThread();void loadCatalog(selected().runtime);void poll();return;}if(b.dataset.prompt){current().draft=b.dataset.prompt;element.querySelector('#atlas-message').value=b.dataset.prompt;persist();updateStatus();focus();return;}if(b.dataset.removeFile){const index=current().attachments.findIndex(f=>f.key===b.dataset.removeFile);current().attachments=current().attachments.filter(f=>f.key!==b.dataset.removeFile);composerError='';persist();renderFiles();updateStatus();const buttons=element.querySelectorAll('[data-remove-file]');(buttons[Math.min(index,buttons.length-1)]||element.querySelector('[data-chat=attach]')).focus();return;}if(b.dataset.consentRetry){void retryWithPermission(b.dataset.consentRetry);return;}if(b.dataset.start){void requestAction(b.dataset.start,'start');return;}if(b.dataset.artifact){void readArtifact(b);return;}if(b.dataset.stop){void requestAction(b.dataset.stop,'cancel');return;}if(b.dataset.copy){const m=current().messages.find(m=>m.id===b.dataset.copy);try{await navigator.clipboard.writeText(mainReply(m));b.innerHTML=icon('check');}catch{notify('Clipboard access is unavailable. Select the response to copy it.');}return;}switch(b.dataset.chat){case'tasks':showTasks({departmentId:departmentFilter,filter:taskScope?.filter||taskFilter,...(taskScope?{requestIds:taskScope.requestIds,taskIds:taskScope.taskIds}:{})});break;case'all-departments':showTasks({filter:taskFilter});break;case'new':{const t=newThread();t.selection={...current().selection};threads.unshift(t);activeId=t.id;paneMode='conversation';inspector={html:'',title:''};composerError='';persist();renderThread();void loadCatalog(selected().runtime);focus();break;}case'expand':{const focused=columns.classList.toggle('chat-focused');b.innerHTML=icon(focused?'shrink':'expand');b.setAttribute('aria-label',focused?'Restore workspace':'Focus conversation');break;}case'close':columns.classList.remove('chat-open','chat-focused');columns.classList.add('chat-closed');{const expand=element.querySelector('[data-chat="expand"]');expand.innerHTML=icon('expand');expand.setAttribute('aria-label','Focus conversation');}break;case'attach':element.querySelector('#atlas-file-input').click();break;case'clear-context':current().context=null;inspector={html:'',title:''};element.querySelector('#chat-inspector-slot').innerHTML='';persist();renderContext();break;case'refresh':void connect(true);break;}});
  element.addEventListener('submit',e=>{if(e.target.id==='atlas-message-form'){e.preventDefault();void send();}});
  element.addEventListener('input',e=>{if(e.target.id==='atlas-message'){current().draft=e.target.value;composerError='';persist();updateStatus();}});
  element.addEventListener('change',e=>{if(e.target.dataset.consentCheck){if(e.target.checked)permissionChecks.add(e.target.dataset.consentCheck);else permissionChecks.delete(e.target.dataset.consentCheck);const button=e.target.closest('.cc-permission').querySelector('[data-consent-retry]');button.disabled=!e.target.checked||sending.has(current().id);return;}if(e.target.id==='atlas-file-input'){const files=[...e.target.files];e.target.value='';if(files.length)void upload(files);return;}const key=e.target.dataset.setting;if(!key)return;current().selection[key]=e.target.value;if(key==='runtime'){current().selection.model='';current().selection.effort='';void loadCatalog(e.target.value);}if(key==='model')current().selection.effort='';composerError='';persist();updateSelectors();updateStatus();});
  element.addEventListener('keydown',e=>{if(e.target.matches('[data-files]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const strip=e.target;strip.scrollLeft=e.key==='Home'?0:e.key==='End'?strip.scrollWidth:strip.scrollLeft+(e.key==='ArrowLeft'?-196:196);return;}if(e.target.id==='atlas-message'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(getSettings().sendShortcut!=='mod-enter'||e.metaKey||e.ctrlKey)){e.preventDefault();void send();}if(e.key==='Escape'){element.querySelectorAll('.chat-thread-menu,.cc-runtime-details,.cc-agent-settings').forEach(d=>d.open=false);}});
  element.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();element.classList.add('cc-drop-target');}});
  element.addEventListener('dragleave',e=>{if(!element.contains(e.relatedTarget))element.classList.remove('cc-drop-target');});
  element.addEventListener('drop',e=>{element.classList.remove('cc-drop-target');if(e.dataTransfer?.files.length){e.preventDefault();void upload([...e.dataTransfer.files]);}});
  element.addEventListener('paste',e=>{if(e.target.id==='atlas-message'&&e.clipboardData?.files.length){e.preventDefault();void upload([...e.clipboardData.files]);}});
  element.addEventListener('toggle',e=>{if(e.target.matches?.('.cc-trace[open][data-trace-request]')&&!runDetails.has(e.target.dataset.traceRequest)){const m=current().messages.find(m=>m.requestId===e.target.dataset.traceRequest);if(m)void refreshRequest(m).then(()=>renderMessages());}},true);
  function ingestWorkspace(incoming){if(!incoming?.workspace)return false;if(workspace?.path===incoming.path&&Number(workspace?.revision||0)>Number(incoming.revision||0))return false;const previous=workspace;workspace=incoming;connectionError='';configurationError='';for(const id of Object.keys(incoming.workspace.runtimes||{})){const old=previous?.workspace?.runtimes?.[id],next=incoming.workspace.runtimes[id];if(old&&(old.adapter!==next.adapter||old.executable!==next.executable)){catalogs.delete(id);catalogCheckedAt.delete(id);}}return true;}
  const receiveWorkspace=e=>{const incoming=e.detail?.workspace?e.detail:e.detail?.detail?.workspace?e.detail.detail:null;if(incoming){ingestWorkspace(incoming);updateSelectors();updateStatus();void loadCatalog(selected().runtime);}else void connect();};workforce.addEventListener('workspace',receiveWorkspace);window.addEventListener('workforce:workspace-updated',receiveWorkspace);
  const refreshVisibleCatalog=()=>{if(document.visibilityState!=='hidden'&&!columns.classList.contains('chat-closed')&&Date.now()-(catalogCheckedAt.get(selected().runtime)||0)>=60_000)void loadCatalog(selected().runtime,true);};window.addEventListener('focus',refreshVisibleCatalog);document.addEventListener('visibilitychange',refreshVisibleCatalog);
  const receiveTaskSnapshot=()=>{if(workforce.connected)runSnapshotLoaded=true;for(const request of workforce.requests){const previous=requests.get(request.id);if(previous?.endedAt&&!request.endedAt)continue;requests.set(request.id,request);}if(workforce.connected)feedReady=true;feedError=workforce.error||'';renderMessages();void poll();};workforce.addEventListener('change',receiveTaskSnapshot);
  const receivePreferences=()=>updateStatus();window.addEventListener('workforce:preferences',receivePreferences);
  mount();renderStorageWarning();void connect();const interval=setInterval(()=>void poll(),2000);
  return {focus,setInspector(content,title,context){inspector={html:content,title};if(context)current().context=context;element.querySelector('#chat-inspector-slot').innerHTML=inspectorMarkup();renderContext();persist();show();},clearInspector(){inspector={html:'',title:''};element.querySelector('#chat-inspector-slot').innerHTML='';},refresh(){renderMessages();void poll();},reset(){if(feedDraft.draft.trim()||feedDraft.attachments.length){feedDraft.title='Unsent task';threads.unshift(feedDraft);}feedDraft=newThread();showTasks();persist();},getContext(){return current().context;},setContext(context){current().context=context;persist();renderContext();},addMessage(text,extra={}){current().messages.push({id:uid(),role:'assistant',text,createdAt:Date.now(),...extra});persist();renderMessages(true);},refreshIdentity(){updateSelectors();},showTasks,openRequest,refreshWorkspace(){void connect();},destroy(){destroyed=true;clearInterval(interval);workforce.removeEventListener('change',receiveTaskSnapshot);window.removeEventListener('workforce:preferences',receivePreferences);window.removeEventListener('focus',refreshVisibleCatalog);document.removeEventListener('visibilitychange',refreshVisibleCatalog);workforce.removeEventListener('workspace',receiveWorkspace);window.removeEventListener('workforce:workspace-updated',receiveWorkspace);}};
}
