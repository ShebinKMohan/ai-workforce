import {escape,icon,avatar,atlasMark} from './ui.js';
import {api,workforce} from './runtime-client.js';
import * as organization from './organization.js';
import {createAtlasChat} from './chat.js';
import {createCompanyManagement} from './management.js';
import {createProjectManager} from './projects.js';
import {renderOverview,wireOverview} from './live-overview.js';
import {renderSettings,updateSettings} from './settings.js';
import {requestTaskStatus} from './task-status.js';
import {createFleetRecords} from './fleet-records.js';
import {createOfficeInspector} from './office-inspector.js';
import {createIssueBoard} from './issues.js';
import {createConnections,summarizeConnections,ConnectionSummaryStore} from './connections.js';
import {installInteractionMotion,revealPanel} from './interaction-motion.js';

const $=s=>document.querySelector(s);
const nav=[['headquarters','home','Headquarters'],['issues','board','Issues'],['assignments','tasks','Assignments'],['people','people','Agents'],['company','org','Departments'],['projects','book','Projects'],['connections','connect','Connections'],['runtimes','code','Runtimes'],['activity','play','Executions'],['settings','settings','Settings']];
const state={view:'headquarters',query:'',filter:'all',manageOptions:{},requestId:null,projectDetail:null};
const runtimeCatalogs=new Map();
const catalogGenerations=new Map();
const catalogsNeedingRefresh=new Set();
let installations=[],installationsLoaded=false,installationsError='';
let connectionSummary=summarizeConnections(null,{loading:true}),lastMotionView='';
const connectionStatus=new ConnectionSummaryStore(api,summary=>{connectionSummary=summary;updateNavigation();if(state.view==='headquarters')refreshOverview();});
let chat,manager,projectManager,issueBoard,connections,overview,officeInspector,toastTimer,lastRevision,seededRequests=false,homeRefreshTimer,motionUntil=0;
const recentEvents=[];
const fleetRecords=createFleetRecords({api,onChange:()=>{if(state.view==='headquarters')refreshOverview();}});
const requestStates=new Map();
const activeStates=new Set(['received','routing','queued','starting','running','stopping']);
const titleFor=request=>request.task?.split('\n')[0]||'Workforce request';
const activeRequests=()=>workforce.requests.filter(r=>activeStates.has(r.state));
const nameFor=id=>organization.allAgents().find(a=>a.id===id)?.name||id||'Control Center';
const deptFor=id=>organization.departments.find(d=>d.id===id);
const time=value=>value?new Date(value).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),6500);}
function statusLabel(r){return requestTaskStatus(r,workforce.runs.find(run=>run.id===r.runId)).label;}
function status(r){const value=requestTaskStatus(r,workforce.runs.find(run=>run.id===r.runId));return`<span class="status ${value.bucket==='waiting'?'blocked':value.bucket==='done'?'completed':value.bucket==='closed'?'closed':'queued'}"><span class="dot"></span>${escape(value.label)}</span>`;}

function shell(){
  $('#app').innerHTML=`<div class="shell live-shell workforce-workbench"><aside class="sidebar" aria-label="Workspace navigation"><a class="brand" href="./index.html"><span class="brand-symbol"><img src="./assets/workforce-mark.svg" alt=""></span><span>workforce</span></a><div class="workspace-switch"><span class="tenant">AT</span><span>Your workspace<small>Local workforce</small></span></div><div class="nav-label">WORKSPACE</div><nav class="nav-list">${nav.map(([id,i,label])=>`<button class="nav-button ${id===state.view?'active':''}" data-nav="${id}" aria-label="${label}" title="${label}">${icon(i)}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><button class="profile" data-nav="settings" aria-label="Open workspace settings"><div class="user-avatar">SM</div><div><strong>Shebin Mohan</strong><small>Workspace owner</small></div>${icon('shield')}</button></div></aside><section class="workspace"><header class="topbar"><button class="navigation-toggle icon-button" data-nav-toggle aria-label="Expand navigation" aria-expanded="false" title="Expand navigation">${icon('panel')}</button><nav class="breadcrumb" id="workspace-breadcrumb" aria-label="Breadcrumb"></nav><div class="top-actions"><span class="connection-note" id="connection-note" role="status"></span><button class="mcp-indicator" id="mcp-indicator" data-nav="connections" aria-label="MCP connections"></button><button class="search-trigger" data-search aria-label="Search assignments">${icon('search')}<span>Search work</span><kbd>⌘ K</kbd></button><button class="icon-button" data-refresh aria-label="Refresh workspace" title="Refresh workspace">${icon('reset')}</button><button class="chat-open-button secondary" data-chat-open aria-label="Open task status" title="Open task status">${icon('panel')}Task status</button></div></header><div class="main-columns"><main class="main-content" id="main" aria-label="Company workspace"></main><aside class="companion atlas-chat" id="atlas-chat-panel" aria-label="Control Center task status"></aside></div></section></div>`;
  chat=createAtlasChat({element:$('#atlas-chat-panel'),avatar,mark:atlasMark,departments:organization.departments,getAssignments:()=>workforce.requests,onTask:openRequest,onNavigate:options=>options.view==='activity'?navigate('activity'):openManagement(options),notify:toast});
  manager=createCompanyManagement({organization,icon,avatar,notify:toast,onNavigate:options=>{state.manageOptions=options;state.view=options.tab==='departments'||options.editDepartmentId?'company':'people';updateNavigation();}});
  projectManager=createProjectManager({api,notify:toast,onChange:payload=>workforce.publishWorkspace(payload),onNavigate:project=>{state.projectDetail=project;if(state.view==='projects')renderBreadcrumb();}});
  issueBoard=createIssueBoard({api,getProjects:()=>workforce.workspace?.workspace?.projects||[],notify:toast,onRequest:openRequest,onNavigate:navigate});
  connections=createConnections({api,notify:toast,onNavigate:navigate});
  officeInspector=createOfficeInspector({element:$('#main'),getData:overviewData,onEditAgent:id=>openManagement({editAgentId:id}),onEditDepartment:id=>openManagement({tab:'departments',editDepartmentId:id}),onShowTasks:selection=>{chat.showTasks?.(selection);chat.focus();},onRequest:openRequest,onAgent:id=>overview?.focusAgent?.(id)});
  renderMain();
}
function updateNavigation(){
  $('.nav-list').querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.nav===state.view);b.setAttribute('aria-current',b.dataset.nav===state.view?'page':'false');});
  $('#main').dataset.view=state.view;
  renderBreadcrumb();
  $('#connection-note').innerHTML=`<i class="connection-led ${workforce.connected?'online':'offline'}"></i><span>${workforce.connected?'Local runtime connected':'Connecting to runtime'}</span>`;
  $('#connection-note').title=workforce.error||`${activeRequests().length} active requests`;
  const mcp=$('#mcp-indicator');if(mcp){mcp.dataset.state=connectionSummary.state;mcp.innerHTML=`${icon('connect')}<span>${escape(connectionSummary.label)}</span>`;mcp.title=connectionSummary.description;}

}
async function refreshConnectionStatus(){
  return connectionStatus.refresh();
}
document.addEventListener('workforce:connections-changed',event=>connectionStatus.accept(event.detail));
function renderBreadcrumb(){
  const host=$('#workspace-breadcrumb');if(!host)return;
  const page=nav.find(n=>n[0]===state.view)?.[2]||'Workspace';
  document.title=`${page} · Workforce`;
  const options=state.manageOptions;
  const entity=state.view==='projects'?state.projectDetail?.name:options.editAgentId!==undefined?(options.editAgentId==='control-center'?'Control Center':organization.allAgents({includeArchived:true}).find(a=>a.id===options.editAgentId)?.name||'New agent'):options.editDepartmentId!==undefined?(deptFor(options.editDepartmentId)?.name||'New department'):options.tab==='archived'?'Archived':null;
  host.innerHTML=`<button type="button" class="breadcrumb-home" data-nav="headquarters" aria-label="Workforce headquarters">${icon('globe')}<span>Workforce</span></button><span class="slash" aria-hidden="true">/</span>${entity?`<button type="button" data-nav="${escape(state.view)}">${escape(page)}</button><span class="slash" aria-hidden="true">/</span><strong aria-current="page">${escape(entity)}</strong>`:`<strong aria-current="page">${escape(page)}</strong>`}`;
}
function refreshOverview(){
  if(overview?.update){overview.update(overviewData());officeInspector?.update();}
  else renderMain();
}
function heading(title,subtitle,action=''){return`<header class="live-page-header"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></div>${action}</header>`;}
function requestRows(list){return list.length?`<div class="live-request-list">${list.map(r=>`<button class="live-request-row" data-request="${escape(r.id)}"><span class="request-row-icon">${icon(r.attachments?.length?'file':r.runId?'tasks':'panel')}</span><span class="request-row-copy"><span class="request-card-top"><span class="request-card-kind">${r.runId?'Team assignment':r.mode==='discuss'?'Conversation':'Request'}</span>${status(r)}</span><strong>${escape(titleFor(r))}</strong><span class="request-card-footer"><span>${escape(deptFor(r.departmentId||r.route?.departmentId)?.name||'Control Center')}</span><span>${icon('book')}${escape(workforce.workspace?.workspace.projects.find(p=>p.id===r.projectId)?.name||r.projectId||'Workspace')}</span>${r.attachments?.length?`<span>${icon('file')}${r.attachments.length} file${r.attachments.length===1?'':'s'}</span>`:''}<span class="request-card-date">${escape(r.receivedAt?new Date(r.receivedAt).toLocaleDateString([],{month:'short',day:'numeric'}):'')} · ${escape(time(r.receivedAt))}</span></span></span><span class="request-open-icon">${icon('northeast')}</span></button>`).join('')}</div>`:`<div class="live-empty">${icon('panel')}<h2>${state.query||state.filter!=='all'?'No matching requests':'Your next idea starts here'}</h2><p>${state.query||state.filter!=='all'?'Try a different search or filter.':'Give Control Center a brief and follow your team’s work here.'}</p>${state.query||state.filter!=='all'?'':'<button class="primary" data-chat-open>Start a conversation '+icon('arrow')+'</button>'}</div>`;}
function overviewData(){return{departments:organization.activeDepartments(),agents:organization.allAgents().filter(a=>!a.archived),projects:organization.projects,controlCenter:{...organization.orchestrator,id:'control-center',name:organization.orchestrator.name||'Tom Chandler',role:'Control Center'},mcp:connectionSummary,requests:workforce.requests,runs:fleetRecords.runs(workforce.runs),eventPages:fleetRecords.eventPages(),events:[...workforce.events,...recentEvents],connected:workforce.connected,streaming:workforce.streaming};}
function home(){return`<div id="live-overview-host">${renderOverview(overviewData())}</div>`;}

function requestMatchesFilter(r,filter=state.filter){const value=requestTaskStatus(r,workforce.runs.find(run=>run.id===r.runId));return filter==='all'||(filter==='active'&&['backlog','progress'].includes(value.bucket))||(filter==='completed'&&value.bucket==='done')||(filter==='attention'&&value.bucket==='waiting');}
function assignments(){const q=state.query.toLowerCase();const rows=workforce.requests.filter(r=>requestMatchesFilter(r)&&[titleFor(r),statusLabel(r),deptFor(r.departmentId||r.route?.departmentId)?.name].some(v=>v?.toLowerCase().includes(q)));return`${heading('Assignments','Every brief, its owner, and the result.',`<button class="primary" data-chat-open>${icon('plus')}New request</button>`)}<div class="assignment-toolbar"><label class="live-search">${icon('search')}<input id="work-search" aria-label="Search requests" placeholder="Search your work…" value="${escape(state.query)}"></label><div class="request-filters" role="group" aria-label="Filter assignments">${[['all','All work'],['active','In progress'],['completed','Completed'],['attention','Needs attention']].map(([value,label])=>`<button data-request-filter="${value}" class="${state.filter===value?'selected':''}" aria-pressed="${state.filter===value}">${label}<span>${workforce.requests.filter(r=>requestMatchesFilter(r,value)).length}</span></button>`).join('')}</div></div>${requestRows(rows)}`;}
function activity(){const list=[...recentEvents].reverse();const current=workforce.requests.filter(r=>activeStates.has(r.state));return`${heading('Live executions','Follow the handoffs, work, and checks behind each answer.',`<span class="execution-stream-state"><i class="connection-led ${workforce.streaming?'online':'offline'}"></i>${workforce.streaming?'Live stream':'Polling for updates'}</span>`)}<div class="live-section-heading"><h2>In progress <span class="execution-count">${current.length}</span></h2><button class="text-button" data-nav="assignments">All assignments ${icon('arrow')}</button></div>${current.length?requestRows(current):`<div class="execution-idle">${icon('circleCheck')}<div><h2>All caught up</h2><p>New assignments will appear here as Control Center starts work.</p></div><button class="secondary" data-chat-open>Start a request ${icon('arrow')}</button></div>`}<div class="live-section-heading"><h2>Execution timeline</h2><span class="execution-timeline-note">Events from this session</span></div><div class="live-activity-list">${list.length?list.map(e=>`<button class="live-activity-row" ${e.requestId?`data-request="${escape(e.requestId)}"`:''}><span class="event-node">${icon(/ended|accepted|settled/.test(e.type)?'check':/started/.test(e.type)?'play':'connect')}</span><div><strong>${escape(e.label||e.type)}</strong><small>${e.requestId?'Open the conversation for full traces':'Recorded by your local runtime'}</small></div><time>${escape(time(e.at))}</time>${e.requestId?icon('chevron'):''}</button>`).join(''):`<div class="execution-empty-timeline"><span class="event-node">${icon('clock')}</span><p>Waiting for your next event. Earlier execution traces are saved with each assignment.</p></div>`}</div>`;}
function runtimeReport(id,runtime,payload=workforce.workspace){return payload?.runtimes?.reports?.find(report=>report.runtimeId===id&&(!report.configuredExecutable||report.configuredExecutable===runtime?.executable));}
function runtimeIdentity(id,payload=workforce.workspace){const binding=payload?.workspace?.runtimes?.[id];const report=runtimeReport(id,binding,payload);return JSON.stringify([id,binding?.adapter,binding?.executable,report?.executable,report?.realPath,report?.version]);}
function invalidateCatalogs(payload,force=false){if(force){for(const id of Object.keys(payload?.workspace?.runtimes||{})){catalogsNeedingRefresh.add(id);catalogGenerations.set(id,(catalogGenerations.get(id)||0)+1);}}for(const [id,entry] of runtimeCatalogs){if(force||entry.identity!==runtimeIdentity(id,payload)){runtimeCatalogs.delete(id);catalogGenerations.set(id,(catalogGenerations.get(id)||0)+1);}}}
function runtimeName(adapter){return adapter==='codex'?'Codex':adapter==='claude-code'?'Claude Code':adapter;}
function catalogMarkup(catalog){return `<div class="runtime-provenance">${icon('monitor')}<span>Reported by ${escape(catalog.version||'installed runtime')}${catalog.checkedAt?` · Checked ${escape(time(catalog.checkedAt))}`:''}</span></div>${(catalog.models||[]).map(m=>`<div class="runtime-catalog-model"><div><strong>${escape(m.label||m.id)}</strong><code class="runtime-model-identity">${escape(m.resolvedModel||m.id)}</code>${m.resolvedModel&&m.resolvedModel!==m.id?`<small>Runtime selector: ${escape(m.id)}</small>`:''}</div><span>${escape(m.efforts?.map(v=>typeof v==='string'?v:v.reasoningEffort||v.id).join(' · ')||'Default effort')}</span></div>`).join('')||`<p>${escape(catalog.diagnostics?.join(' ')||'No model catalog was returned.')}</p>`}`;}
function runtimes(){const cfg=workforce.workspace?.workspace;const reports=workforce.workspace?.runtimes?.reports||[];return`${heading('Runtimes','Your local installations. Their models. Your choice.',`<button class="secondary" data-refresh-installations>${icon('reset')}Discover installations</button>`)}<div class="live-runtime-list">${Object.entries(cfg?.runtimes||{}).map(([id,r])=>{const report=runtimeReport(id,r);const catalog=runtimeCatalogs.get(id)?.catalog;const desktop=r.executable.includes('.app/');return`<section class="live-runtime"><header><span class="runtime-symbol ${escape(r.adapter)}">${icon(r.adapter==='codex'?'code':'layers')}</span><div><span class="runtime-installation-label">${desktop?'DESKTOP INSTALLATION':'CONFIGURED RUNTIME'}</span><h2>${escape(runtimeName(r.adapter))}</h2><p>${escape(report?.version?`v${report.version}`:'Version unavailable')} · ${escape(id)}</p></div><span class="status ${report?.installed?'completed':'blocked'}"><i class="dot"></i>${report?report.installed?'Installed':'Unavailable':'Not checked'}</span></header><dl><div><dt>Account</dt><dd>${escape(report?.auth==='logged_in'?'Signed in':report?.auth==='logged_out'?'Sign-in needed':report?.auth==='not_required'?'Not required':'Not checked')}</dd></div><div><dt>Default model</dt><dd>${escape(r.model||'Runtime default')}</dd></div></dl><details class="runtime-model-details" data-runtime-catalog="${escape(id)}" ${catalog?'data-loaded="true"':''}><summary><span>Models & reasoning effort${catalog?` · ${catalog.models?.length||0}`:''}</span>${icon('down')}</summary><div class="runtime-catalog-toolbar"><span>From this installed runtime</span><button class="text-button" data-refresh-catalog="${escape(id)}">${icon('reset')}Refresh</button></div><div class="runtime-catalog-body">${catalog?catalogMarkup(catalog):'Open to fetch from this installation.'}</div></details><details class="runtime-diagnostics"><summary>Installation details ${icon('down')}</summary><code class="runtime-executable">${escape(catalog?.executable||report?.executable||r.executable)}</code>${report?.diagnostics?.map(d=>`<p>${escape(d)}</p>`).join('')||''}</details><footer class="runtime-actions"><button class="secondary" data-use-runtime="${escape(id)}">Use in Control Center ${icon('arrow')}</button></footer></section>`;}).join('')}</div><div id="discovered-installations">${renderInstallations()}</div>`;}
function renderInstallations(){return installationsError?`<p class="runtime-discovery-note">${escape(installationsError)}</p>`:!installationsLoaded?'':`<div class="live-section-heading"><h2>Other installations on this computer</h2><span class="execution-timeline-note">Discovered locally</span></div><div class="runtime-installations-list">${installations.length?installations.map((item,index)=>`<article class="runtime-installation"><span class="runtime-symbol">${icon(item.adapter==='codex'?'code':'layers')}</span><div><strong>${escape(runtimeName(item.adapter))} <span>${escape(item.version?'v'+item.version:'')}</span></strong><code>${escape(item.executable)}</code></div><button class="secondary" data-register-installation="${index}">Add runtime ${icon('plus')}</button></article>`).join(''):'<p class="runtime-discovery-note">All discovered installations are available above.</p>'}</div>`;}
function collectInstallations(payload){
  const reports=payload?.runtimes?.reports||[];const configured=Object.values(payload?.workspace?.runtimes||{}).map(r=>r.executable);
  const selected=new Set([...configured,...reports.filter(report=>report.runtimeId&&payload?.workspace?.runtimes?.[report.runtimeId]&&(!report.configuredExecutable||report.configuredExecutable===payload.workspace.runtimes[report.runtimeId].executable)).flatMap(report=>[report.executable,report.realPath,...(report.installations||[]).filter(item=>item.selected).flatMap(item=>[item.path,item.realPath])])].filter(Boolean));
  const unique=new Map();
  for(const report of reports){for(const item of report.installations||[]){if(report.adapter==='codex'&&item.path?.includes('.app/')&&Object.values(payload?.workspace?.runtimes||{}).some(r=>r.adapter==='codex'&&!r.executable.includes('.app/')))continue;const path=item.realPath||item.path;if(!path||selected.has(path)||selected.has(item.path)||unique.has(path))continue;unique.set(path,{adapter:report.adapter,executable:item.path||path,source:item.source,origins:item.origins});}}
  installations=[...unique.values()];installationsLoaded=true;
}
async function discoverInstallations(){
  const button=document.querySelector('[data-refresh-installations]');if(button)button.disabled=true;
  try{const payload=await api('/api/workspace?refresh=1');invalidateCatalogs(payload,true);workforce.publishWorkspace(payload);collectInstallations(payload);installationsError='';if(state.view==='runtimes')renderMain();toast('Installed runtimes refreshed.');}catch(error){installationsError=error.message;toast(error.message);}finally{if(button?.isConnected)button.disabled=false;}
}
async function registerInstallation(index,button){
  const item=installations[index];if(!item||button.disabled)return;button.disabled=true;
  try{
    const payload=await api('/api/workspace');const config=payload.workspace;
    if(Object.values(config.runtimes).some(runtime=>runtime.executable===item.executable)){await discoverInstallations();return;}
    const prefix=item.adapter==='codex'?'codex':'claude';const base=`${prefix}-${item.executable.includes('.app/')?'desktop':'installed'}`;let id=base;let suffix=2;while(config.runtimes[id])id=`${base}-${suffix++}`;
    await api('/api/workspace/ops',{expectRevision:payload.revision,ops:[{op:'runtime.set',id,adapter:item.adapter,executable:item.executable}]});
    const fresh=await api('/api/workspace?refresh=1');workforce.publishWorkspace(fresh);collectInstallations(fresh);if(state.view==='runtimes')renderMain();toast(`${runtimeName(item.adapter)} installation added. Its models are now available in chat.`);
  }catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
}
async function fetchCatalog(id,refresh=false){
  refresh=refresh||catalogsNeedingRefresh.has(id);
  const d=document.querySelector(`[data-runtime-catalog="${CSS.escape(id)}"]`);if(!d)return;
  const body=d.querySelector('.runtime-catalog-body');const identity=runtimeIdentity(id);const generation=(catalogGenerations.get(id)||0)+1;catalogGenerations.set(id,generation);
  body.textContent='Reading models from this runtime…';
  try{
    const catalog=await api(`/api/runtimes/${encodeURIComponent(id)}/models${refresh?'?refresh=1':''}`);
    if(catalogGenerations.get(id)!==generation||runtimeIdentity(id)!==identity)return;
    runtimeCatalogs.set(id,{identity,catalog});catalogsNeedingRefresh.delete(id);
    if(d.isConnected){body.innerHTML=catalogMarkup(catalog);d.dataset.loaded='true';}
  }catch(error){if(d.isConnected&&catalogGenerations.get(id)===generation){body.textContent=error.message;delete d.dataset.loaded;}}
}
function renderMain(){
  renderMainContent();
  const signature=JSON.stringify([state.view,state.manageOptions,state.projectDetail?.id]);
  if(lastMotionView!==signature){lastMotionView=signature;revealPanel($('#main').firstElementChild);}
}
function renderMainContent(){
  officeInspector?.close({restoreFocus:false});overview?.destroy();overview=null;issueBoard?.unmount();connections?.unmount();updateNavigation();
  if(!workforce.workspace){$('#main').innerHTML=heading(workforce.error?'The workforce is unavailable.':'Connecting your workspace…',workforce.error||'Loading your saved organization and installed runtimes.')+`<button class="secondary" data-refresh>${icon('reset')}Retry connection</button>`;return;}
  if(state.view==='people'||state.view==='company'){$('#main').innerHTML=manager.render({...state.manageOptions,...(state.view==='company'?{tab:'departments'}:{})});manager.mount($('#main'));return;}
  if(state.view==='projects'){projectManager.mount($('#main'));return;}
  if(state.view==='issues'){issueBoard.mount($('#main'));return;}
  if(state.view==='connections'){connections.mount($('#main'));return;}
  $('#main').innerHTML=state.view==='settings'?renderSettings({connected:workforce.connected,streaming:workforce.streaming}):state.view==='assignments'?assignments():state.view==='runtimes'?runtimes():state.view==='activity'?activity():home();
  if(state.view==='headquarters')overview=wireOverview($('#live-overview-host'),{onDepartment:id=>officeInspector.showDepartment(typeof id==='string'?id:id.id),onAgent:id=>officeInspector.showAgent(typeof id==='string'?id:id.id),onControlCenter:()=>{chat.showTasks?.();chat.focus();},onDepartmentWorkload:selection=>{chat.showTasks?.(selection);chat.focus();},onRequest:id=>openRequest(typeof id==='string'?id:id.id)});
}
function navigate(view){clearTimeout(homeRefreshTimer);state.view=view;state.manageOptions={};state.query='';state.filter='all';if(view==='projects'){state.projectDetail=null;projectManager.showDirectory();}renderMain();$('#main').scrollTop=0;if(innerWidth<=1080)$('.main-columns').classList.remove('chat-open');}
function openManagement(options={}){state.manageOptions={...options,editAgentId:options.editAgentId==='atlas'?'control-center':options.editAgentId};state.view=options.tab==='departments'||options.editDepartmentId?'company':'people';renderMain();$('#main').scrollTop=0;}
function openRequest(id){if(chat.openRequest){chat.openRequest(id);$('.main-columns').classList.add('chat-open');return;}const r=workforce.requests.find(r=>r.id===id);if(r){chat.setInspector(`<h2>${escape(titleFor(r))}</h2><p>${escape(r.controlReply||r.result?.message||r.reason||'Work is in progress.')}</p>`,{title:'Recorded request'});chat.focus();}}
function addActivity(event){if(!event||recentEvents.some(e=>e.id===event.id))return;motionUntil=Date.now()+600;recentEvents.push(event);if(recentEvents.length>80)recentEvents.shift();overview?.animateEvent(event);if(state.view==='activity')renderMain();}
function requestActivity(request){
  if(!request?.id)return;const old=requestStates.get(request.id);requestStates.set(request.id,request);
  if(!old){addActivity({id:`${request.id}:received`,type:'request.received',label:'Control Center received your message',from:{kind:'user',id:'you'},to:{kind:'control',id:'control-center'},requestId:request.id,at:request.receivedAt});}
  if(request.route?.departmentId&&old?.route?.departmentId!==request.route.departmentId)addActivity({id:`${request.id}:routed`,type:'request.routed',label:`Control Center handed the brief to ${deptFor(request.route.departmentId)?.name||request.route.departmentId}`,from:{kind:'control',id:'control-center'},to:{kind:'department',id:request.route.departmentId},requestId:request.id,at:request.route.decidedAt});
  if(request.state==='ended'&&old?.state!=='ended')addActivity({id:`${request.id}:ended`,type:'request.ended',label:request.controlReply?'Control Center replied':request.exitCode===0?'The team returned a result':'The request needs attention',...(request.departmentId?{from:{kind:'department',id:request.departmentId},to:{kind:'control',id:'control-center'}}:{}),requestId:request.id,at:request.endedAt});
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-nav-toggle')){const expanded=$('.live-shell').classList.toggle('navigation-expanded');b.setAttribute('aria-expanded',String(expanded));b.setAttribute('aria-label',expanded?'Collapse navigation':'Expand navigation');b.title=expanded?'Collapse navigation':'Expand navigation';return;}if(b.dataset.preference){const preference=b.dataset.preference;const value=b.dataset.value;try{updateSettings({[b.dataset.preference]:b.dataset.preference==='autoHandoff'?!b.matches('[aria-checked="true"]'):b.dataset.value});if(state.view==='settings'){renderMain();document.querySelector(`[data-preference="${preference}"]${value?`[data-value="${value}"]`:''}`)?.focus();}}catch{toast('Browser storage is unavailable. Your preference could not be saved.');}return;}if(b.dataset.requestFilter){state.filter=b.dataset.requestFilter;renderMain();return;}if(b.hasAttribute('data-refresh-installations')){await discoverInstallations();return;}if(b.hasAttribute('data-register-installation')){await registerInstallation(Number(b.dataset.registerInstallation),b);return;}if(b.dataset.refreshCatalog){await fetchCatalog(b.dataset.refreshCatalog,true);return;}if(b.dataset.useRuntime){openManagement({editAgentId:'control-center',preferredRuntimeId:b.dataset.useRuntime});return;}if(b.dataset.nav){navigate(b.dataset.nav);return;}if(b.hasAttribute('data-chat-open')){$('.main-columns').classList.remove('chat-closed');$('.main-columns').classList.add('chat-open');chat.showTasks?.();chat.focus();return;}if(b.hasAttribute('data-manage-control'))return openManagement({editAgentId:'control-center'});if(b.dataset.department)return openManagement({tab:'departments',editDepartmentId:b.dataset.department});if(b.dataset.request)return openRequest(b.dataset.request);if(b.hasAttribute('data-search')){navigate('assignments');$('#work-search')?.focus();}if(b.hasAttribute('data-refresh')){await Promise.all([workforce.refresh({workspace:true}),refreshConnectionStatus()]);if(state.view==='runtimes')renderMain();toast(workforce.connected?'Workspace refreshed.':workforce.error);}});
document.addEventListener('input',e=>{if(e.target.id==='work-search'){const start=e.target.selectionStart;state.query=e.target.value;$('#main').innerHTML=assignments();$('#work-search').focus();$('#work-search').setSelectionRange(start,start);}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();navigate('assignments');$('#work-search')?.focus();}});
document.addEventListener('toggle',event=>{const d=event.target;if(d.matches?.('[data-runtime-catalog]')&&d.open&&!d.dataset.loaded)fetchCatalog(d.dataset.runtimeCatalog);},true);
document.addEventListener('workforce:fleet-selection',()=>{if(state.view==='headquarters')refreshOverview();});
document.addEventListener('workforce:request',e=>{requestActivity(e.detail.request);workforce.refresh();});
workforce.addEventListener('workspace',e=>{invalidateCatalogs(e.detail);collectInstallations(e.detail);organization.syncWorkspace(e.detail);window.dispatchEvent(new CustomEvent('workforce:workspace-updated',{detail:e.detail}));});
workforce.addEventListener('connection',()=>{if(state.view==='headquarters')refreshOverview();});
workforce.addEventListener('change',()=>{
  fleetRecords.refresh(workforce.runs);
  const first=lastRevision===undefined;const revision=workforce.workspace?.revision;updateNavigation();
  if(first)renderMain();else if(state.view==='assignments'){const focused=document.activeElement?.id==='work-search';const selection=focused?document.activeElement.selectionStart:null;renderMain();if(focused){$('#work-search')?.focus();$('#work-search')?.setSelectionRange(selection,selection);}}else if(state.view==='headquarters'){clearTimeout(homeRefreshTimer);if(Date.now()<motionUntil)homeRefreshTimer=setTimeout(()=>{if(state.view==='headquarters')refreshOverview();},motionUntil-Date.now());else refreshOverview();}
  if(!first&&revision!==lastRevision&&state.view==='runtimes')renderMain();
  if(workforce.workspace){if(!seededRequests){for(const r of workforce.requests)requestStates.set(r.id,r);seededRequests=true;}else for(const r of workforce.requests)requestActivity(r);}
  lastRevision=revision;
});
workforce.addEventListener('activity',e=>{
  const event=e.detail;const run=workforce.runs.find(r=>r.id===event.runId);const request=workforce.requests.find(r=>r.runId===event.runId);const task=run?.taskViews?.find(t=>t.id===event.taskId);const agentId=event.payload?.agentId||event.payload?.ownerAgentId||task?.ownerAgentId;
  const normalized={id:`${event.projectId}:${event.cursor}`,type:event.type,label:event.type.replaceAll('.',' · '),requestId:request?.id,at:event.timestamp};
  if(agentId&&request?.departmentId&&/attempt.started|task.started|task.dispatched|session.started/.test(event.type)){normalized.from={kind:'department',id:request.departmentId};normalized.to={kind:'agent',id:agentId};normalized.label=`${nameFor(agentId)} started the assigned work`;}
  if(agentId&&request?.departmentId&&/task.accepted|task.settled/.test(event.type)){normalized.from={kind:'agent',id:agentId};normalized.to={kind:'department',id:request.departmentId};normalized.label=`${nameFor(agentId)} returned work for review`;}
  addActivity(normalized);
});
const stopInteractionMotion=installInteractionMotion();
shell();
void refreshConnectionStatus();
await workforce.start();
for(const r of workforce.requests)requestStates.set(r.id,r);
window.addEventListener('pagehide',()=>{stopInteractionMotion();fleetRecords.dispose();workforce.stop();});
