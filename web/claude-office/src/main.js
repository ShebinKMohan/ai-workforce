import { departments, employees, runtimes, loadLiveData } from './live-data.js';
import { createOfficeScene } from './scene-3d.js';
import { createSidebar } from './sidebar.js';
import { createAgentStore } from './agent-store.js';
import { createAgentManager } from './agent-manager.js';
import { createDepartmentManager } from './department-manager.js';
import { createProjectManager } from './project-manager.js';
import { createPanelResizer } from './panel-resizer.js';
import { reviewTask } from './task-bridge.js';
import { createTaskNotifications } from './task-notifications.js';
import { subscribeEvents } from '/workspace/src/api.js';

const $ = id => document.getElementById(id);
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let live = await loadLiveData();
let selection = { type: 'office' }, view = 'office';
let scene, manager, departmentManager, projectManager, sidebar, noticeTimer;
let pendingRefresh = null, refreshTimer;
const stateKey = value => JSON.stringify([value.workspaceDoc, value.tasks, value.reports, value.error]);
const sceneKey = () => JSON.stringify([departments.map(({id,name,headAgentId,color})=>({id,name,headAgentId,color})),employees.map(({id,name,role,departmentId,status,statusLabel})=>({id,name,role,departmentId,status,statusLabel}))]);
let lastKey = stateKey(live), lastSceneKey = sceneKey();
const store = createAgentStore({ employees, departments, runtimes });
store.setWorkspace(live.workspaceDoc);
const notifications = createTaskNotifications({
  storageKey:'workforce:task-notifications:v1:'+(live.workspaceDoc?.path||location.origin),
  onOpenTask:task=>{closeManagers();if(sidebar?.showTask(task.id)){openMobilePanel();}else if(task.href){location.href=task.href;}}
});
const notificationButton = document.createElement('button');
notificationButton.type='button';notificationButton.id='task-notifications';notificationButton.className='icon-button task-notification-toggle';
notificationButton.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8a5 5 0 0 1 10 0v4l1.5 2H3.5L5 12V8Zm3 9h4M10 2v1"/></svg>';
$('review-button').before(notificationButton);
function updateNotificationButton() {
  const status=notifications.getStatus();
  const label=!status.supported?'Task notifications unavailable in this browser':status.permission==='denied'?'Task notifications blocked in browser settings':status.requesting?'Waiting for notification permission':status.enabled?'Turn off task notifications':'Enable task notifications while this workspace is open';
  notificationButton.setAttribute('aria-label',label);notificationButton.title=status.error||label;notificationButton.setAttribute('aria-pressed',String(status.enabled));notificationButton.disabled=!status.supported||status.permission==='denied'||status.requesting;
}
notificationButton.onclick=async event=>{
  if(notifications.getStatus().enabled){notifications.disable();updateNotificationButton();return;}
  const request=notifications.enableFromUserGesture(event);updateNotificationButton();await request;updateNotificationButton();
  const status=notifications.getStatus();if(status.error)notice(status.error);
};
if(!live.error)notifications.observe(live.tasks);
updateNotificationButton();

function notice(text) {
  clearTimeout(noticeTimer);
  $('canvas-notice').textContent = text;
  $('canvas-notice').classList.add('visible');
  noticeTimer = setTimeout(() => $('canvas-notice').classList.remove('visible'), 6500);
}
function openMobilePanel() {
  if (matchMedia('(max-width:760px)').matches) {
    document.body.classList.add('panel-open');
    $('mobile-panel').setAttribute('aria-expanded','true');
    sidebar?.reveal();
  }
  syncMobilePanel();
}
function syncMobilePanel() {
  document.querySelector('.office-panel').inert = matchMedia('(max-width:760px)').matches && document.body.classList.contains('panel-open');
}
function closeManagers() {
  manager?.hide(); departmentManager?.hide(); projectManager?.hide();
  document.body.classList.remove('manager-open');
}
function updateSelectionName() {
  $('selection-name').textContent = selection.type === 'employee' ? employees.find(a=>a.id===selection.id)?.name || 'Agent' : selection.type === 'department' ? departments.find(d=>d.id===selection.id)?.name || 'Department' : selection.type === 'control' ? 'Control center' : 'Overview';
}
function focusSelection(next, { sync = true } = {}) {
  selection = next;
  scene?.select(next);
  updateSelectionName();
  if (sync) sidebar?.select(next);
  if (next.type !== 'office') openMobilePanel();
}
function showDepartment() { closeManagers(); departmentManager.showCreate(); openMobilePanel(); }
function showProject() { closeManagers(); projectManager.showCreate(); openMobilePanel(); }
function showAgentManager(mode, id) {
  closeManagers();
  if (mode === 'create' && !departments.length) { showDepartment(); return; }
  document.body.classList.add('manager-open');
  openMobilePanel();
  if (mode === 'create') manager.showCreate(id || (selection.type === 'department' ? selection.id : employees.find(a=>a.id===selection.id)?.departmentId));
  else if (mode === 'edit') manager.showEdit(id);
  else manager.showDirectory();
}
function setView(next) {
  closeManagers(); view = next; scene?.setConnections(next === 'connections');
  for (const name of ['office','connections']) {
    $(name+'-view').classList.toggle('active', name === next);
    $(name+'-view').setAttribute('aria-pressed', String(name === next));
  }
  sidebar.showTab(next === 'connections' ? 'connections' : 'chat');
}
const marks = {
  codex: '<path d="m6 5-4 4 4 4m6-8 4 4-4 4m-2-9L8 14"/>',
  'claude-code':'<path d="M9 2v14M2 9h14M4 4l10 10m0-10L4 14M6 2.5l6 13M2.5 6l13 6"/>',
};
function updateHeader() {
  document.querySelector('.office-count strong').textContent = String(employees.length);
  document.querySelector('.office-count .muted').textContent = '· ' + departments.length + ' ' + (departments.length===1?'department':'departments');
  $('agent-count').textContent = String(employees.length);
  const reviewCount = (live.tasks || []).filter(t=>t.needsYou).length;
  $('review-button').querySelector('span').textContent = reviewCount + ' to review';
  $('review-button').classList.toggle('has-review',reviewCount>0);
  const active = (live.tasks||[]).filter(t=>t.inMotion).length;
  $('communication-label').textContent = live.error ? 'Connection interrupted. Retrying…' : active ? `${active} active ${active===1?'task':'tasks'} · View progress` : 'No active tasks';
  $('runtime-buttons').innerHTML = runtimes.map(runtime => {
    const busy = employees.filter(a=>a.runtimeId===runtime.id && ['Working','Planning','Reviewing','Being checked'].includes(a.statusLabel)).length;
    const state = busy ? 'busy' : runtime.ready && !runtime.requiresWriteConsent ? 'ready' : 'blocked';
    const label = busy ? `${busy} ${busy===1?'agent':'agents'} running` : runtime.ready && runtime.requiresWriteConsent ? 'Consent required' : runtime.connectionLabel || 'Not checked';
    return `<button class="runtime-button" data-runtime="${esc(runtime.id)}" data-state="${state}" aria-label="Inspect ${esc(runtime.name)}, ${esc(label)}"><span class="runtime-mark"><svg viewBox="0 0 18 18">${marks[runtime.adapter]||'<rect x="3" y="3" width="12" height="12" rx="2"/><path d="M6 7h6M6 11h6"/>'}</svg></span><span class="runtime-copy"><strong>${esc(runtime.name)}</strong><small>${esc(label)}</small></span><span class="runtime-status" aria-hidden="true"></span></button>`;
  }).join('');
}
async function refreshLive(force = false) {
  if (pendingRefresh) { await pendingRefresh; if (force) return refreshLive(true); return; }
  pendingRefresh = (async () => {
    const next = await loadLiveData();
    live = next;
    if(!live.error)notifications.observe(live.tasks);
    updateNotificationButton();
    const key = stateKey(next);
    if (!force && key === lastKey) return;
    lastKey = key;
    store.setWorkspace(live.workspaceDoc);
    const invalid = selection.type === 'employee' && !employees.some(a=>a.id===selection.id) || selection.type === 'department' && !departments.some(d=>d.id===selection.id);
    if (invalid) selection = { type:'office' };
    updateHeader();
    const nextSceneKey = sceneKey();
    if (nextSceneKey !== lastSceneKey) { lastSceneKey = nextSceneKey; scene?.setData({departments,agents:employees}); }
    scene?.setActivity({tasks:live.tasks,connected:!live.error});
    sidebar.updateData(live);
    if (invalid) focusSelection(selection); else updateSelectionName();
  })();
  try { await pendingRefresh; } finally { pendingRefresh = null; }
}
sidebar = createSidebar({
  element:$('sidebar'), departments, employees, runtimes, coordinator:store.get('control'),
  onEditAgent:id=>showAgentManager('edit',id), onRemoveAgent:id=>showAgentManager('edit',id),
  onManageAgents:()=>showAgentManager('directory'), onAddAgent:id=>showAgentManager('create',id),
  onAddDepartment:showDepartment, onAddProject:showProject,
  onManageRuntimes:()=>{location.href='/workspace/#/settings';},
  onFocus:next=>focusSelection(next,{sync:false}),
  onAssignTask:async context=>{const result=await reviewTask(context,live.workspaceDoc); if(!result.cancelled) await refreshLive(true); return result;},
  onOpenTask:task=>{location.href=task.href;}
});
sidebar.updateData(live);
manager = createAgentManager({
  element:$('agent-manager'), store,
  onFocus:next=>{closeManagers();focusSelection(next);},
  onSaved:async saved=>{await refreshLive(true);focusSelection({type:'employee',id:saved.id});notice(saved.name+' saved to your workspace.');},
  onArchived:async saved=>{await refreshLive(true);focusSelection({type:'control'});notice(saved.name+' removed from the active workforce. History is preserved.');},
  onClose:closeManagers
});
departmentManager = createDepartmentManager({element:$('department-manager'),getWorkspace:()=>live.workspaceDoc,onSaved:async saved=>{closeManagers();await refreshLive(true);focusSelection({type:'department',id:saved.department.id});notice(saved.department.name+' created. Add workers to grow this team.');},onClose:closeManagers});
projectManager = createProjectManager({element:$('project-manager'),getWorkspace:()=>live.workspaceDoc,onSaved:async saved=>{closeManagers();await refreshLive(true);focusSelection({type:'office'});sidebar.showTab('chat');notice(saved.project.name+' connected. Describe a task in chat.');},onClose:closeManagers});
const resizer = createPanelResizer($('panel-resizer'));
try {
  scene = createOfficeScene({element:$('canvas'),layoutKey:live.workspaceDoc?.path||location.origin,onSelect:next=>focusSelection(next),onCamera:state=>{$('zoom-value').textContent=Math.round(state.zoom*100)+'%';},onCreateDepartment:showDepartment,onOpenTask:id=>{closeManagers();if(sidebar.showTask(id))openMobilePanel();}});
  scene.setData({departments,agents:employees});scene.setActivity({tasks:live.tasks,connected:!live.error}); window.officeScene=scene;
} catch(error) {
  $('canvas').innerHTML='<div class="scene-empty"><h2>The office could not start.</h2><p>'+esc(error.message)+'</p><button class="add-agent-button" id="fallback-team">Open your team</button></div>';
  $('fallback-team').onclick=()=>showAgentManager('directory'); console.error(error);
}
updateHeader();
$('manage-projects').onclick=()=>{const projects=live.workspaceDoc?.workspace?.projects?.filter(p=>!p.archived)||[];if(projects.length)location.href='/workspace/#/projects';else showProject();};
$('manage-agents').onclick=()=>showAgentManager('directory'); $('add-agent').onclick=()=>showAgentManager('create'); $('add-department').onclick=showDepartment;
$('office-home').onclick=()=>{closeManagers();focusSelection({type:'office'});}; $('office-view').onclick=()=>setView('office'); $('connections-view').onclick=()=>setView('connections');
$('zoom-out').onclick=()=>scene?.zoomBy(1/1.2); $('zoom-in').onclick=()=>scene?.zoomBy(1.2); $('zoom-fit').onclick=()=>focusSelection({type:'office'});
$('review-button').onclick=()=>{closeManagers();sidebar.select({type:'office'});sidebar.showTab('tasks');openMobilePanel();};
$('runtime-details').onclick=()=>{setView('connections');openMobilePanel();};
$('runtime-buttons').onclick=event=>{const button=event.target.closest('[data-runtime]');if(button){setView('connections');sidebar.showRuntime(button.dataset.runtime);openMobilePanel();}};
$('play-communication').onclick=()=>$('review-button').click();
$('mobile-panel').onclick=()=>{closeManagers();const open=document.body.classList.toggle('panel-open');$('mobile-panel').setAttribute('aria-expanded',String(open));syncMobilePanel();if(open)sidebar.reveal();};
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)){
    closeManagers();document.body.classList.remove('panel-open');$('mobile-panel').setAttribute('aria-expanded','false');
    syncMobilePanel();
  }
});
window.officePreview={getState:()=>({selection,view,employees:employees.length,specialists:employees.length,demo:false,camera:scene?.getSnapshot()}),focus:focusSelection};
const refreshAfterAction=()=>refreshLive(true).catch(error=>notice(error.message));
addEventListener('workforce-task-changed',refreshAfterAction);
const timer=setInterval(()=>refreshLive().catch(error=>notice(error.message)),4000);
const stream=subscribeEvents('',{onEvent:()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>refreshLive().catch(error=>notice(error.message)),180);}});
addEventListener('resize',syncMobilePanel);
addEventListener('pagehide',()=>{removeEventListener('resize',syncMobilePanel);removeEventListener('workforce-task-changed',refreshAfterAction);clearInterval(timer);clearTimeout(refreshTimer);clearTimeout(noticeTimer);stream.close();resizer.destroy();sidebar.destroy?.();scene?.destroy();notifications.destroy();},{once:true});
if(live.error)notice(live.error.message||String(live.error));
