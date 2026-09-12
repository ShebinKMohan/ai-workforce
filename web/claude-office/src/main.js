import { departments, employees, runtimes, loadLiveData } from './live-data.js';
import { createOfficeScene } from './scene-3d.js';
import { createSidebar } from './sidebar.js';
import { createAgentStore } from './agent-store.js';
import { createAgentManager } from './agent-manager.js';
import { createDepartmentManager } from './department-manager.js';
import { reviewTask } from './task-bridge.js';

const $=id=>document.getElementById(id);
const esc=(value='')=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let live=await loadLiveData(),selection={type:'office'},view='office',noticeTimer,scene,manager,departmentManager,sidebar;
const stateKey=value=>JSON.stringify([value.workspaceDoc?.workspace,value.tasks,value.reports,value.error?.message||value.error]);
let lastKey=stateKey(live);
const store=createAgentStore({employees,departments,runtimes});
store.setWorkspace(live.workspaceDoc);
function notice(text){clearTimeout(noticeTimer);$('canvas-notice').textContent=text;$('canvas-notice').classList.add('visible');noticeTimer=setTimeout(()=>$('canvas-notice').classList.remove('visible'),5000);}
function openMobilePanel(){if(matchMedia('(max-width:760px)').matches){document.body.classList.add('panel-open');$('mobile-panel').setAttribute('aria-expanded','true');}}
function closeManagers(){manager?.hide();departmentManager?.hide();document.body.classList.remove('manager-open');}
function focusSelection(next,{sync=true}={}){selection=next;scene?.select(next);$('selection-name').textContent=next.type==='employee'?employees.find(a=>a.id===next.id)?.name||'Employee':next.type==='department'?departments.find(d=>d.id===next.id)?.name||'Department':next.type==='control'?'Control center':'Whole office';if(sync)sidebar?.select(next);if(next.type!=='office')openMobilePanel();}
function showDepartment(){manager?.hide();departmentManager.showCreate();openMobilePanel();}
function showAgentManager(mode,id){departmentManager?.hide();if(mode==='create'&&!departments.length){showDepartment();return;}document.body.classList.add('manager-open');openMobilePanel();if(mode==='create')manager.showCreate(id||(selection.type==='department'?selection.id:employees.find(a=>a.id===selection.id)?.departmentId));else if(mode==='edit')manager.showEdit(id);else manager.showDirectory();}
function setView(next){closeManagers();view=next;scene.setConnections(next==='connections');for(const name of ['office','connections']){$(name+'-view').classList.toggle('active',name===next);$(name+'-view').setAttribute('aria-pressed',String(name===next));}sidebar.showTab(next==='connections'?'connections':'chat');}
function updateHeader(){
  document.querySelector('.office-count strong').textContent=String(employees.length);
  document.querySelector('.office-count .muted').textContent='· '+departments.length+' '+(departments.length===1?'department':'departments');
  $('agent-count').textContent=String(employees.length);
  $('review-button').querySelector('span').textContent=(live.tasks||[]).filter(t=>t.needsYou||t.status==='review').length+' to review';
  $('communication-label').textContent=(live.tasks||[]).some(t=>t.inMotion)?'Work is in progress':'Follow recorded work';
  $('runtime-buttons').innerHTML=runtimes.map(runtime=>'<button class="runtime-button" data-runtime="'+esc(runtime.id)+'" aria-label="Inspect '+esc(runtime.name)+'"><span class="runtime-status"></span><span><strong>'+esc(runtime.name)+'</strong><small>'+esc(runtime.connectionLabel||'Not checked')+'</small></span></button>').join('');
}
async function refreshLive(force=false){
  const next=await loadLiveData();live=next;const key=stateKey(next);
  if(!force&&key===lastKey)return;lastKey=key;store.setWorkspace(live.workspaceDoc);
  if(selection.type==='employee'&&!employees.some(a=>a.id===selection.id)||selection.type==='department'&&!departments.some(d=>d.id===selection.id))selection={type:'office'};
  updateHeader();scene.setData({departments,agents:employees});sidebar.updateData(live);focusSelection(selection);
  if(live.error)notice(live.error.message||String(live.error));
}
sidebar=createSidebar({element:$('sidebar'),departments,employees,runtimes,coordinator:store.get('control'),
  onEditAgent:id=>showAgentManager('edit',id),onManageAgents:()=>showAgentManager('directory'),onAddAgent:id=>showAgentManager('create',id),onAddDepartment:showDepartment,
  onFocus:next=>focusSelection(next,{sync:false}),
  onAssignTask:async context=>{const result=await reviewTask(context,live.workspaceDoc);if(!result.cancelled)await refreshLive(true);return result;},
  onOpenTask:task=>{location.href=task.href;}
});
sidebar.updateData(live);
manager=createAgentManager({element:$('agent-manager'),store,onFocus:next=>{closeManagers();focusSelection(next);},onSaved:async saved=>{await refreshLive(true);focusSelection({type:'employee',id:saved.id});notice(saved.name+' saved to your workspace.');},onClose:closeManagers});
departmentManager=createDepartmentManager({element:$('department-manager'),getWorkspace:()=>live.workspaceDoc,onSaved:async saved=>{closeManagers();await refreshLive(true);focusSelection({type:'department',id:saved.department.id});notice(saved.department.name+' created. Add workers to grow this team.');},onClose:closeManagers});
try{
  scene=createOfficeScene({element:$('canvas'),onSelect:next=>focusSelection(next),onCamera:state=>{$('zoom-value').textContent=Math.round(state.zoom*100)+'%';},onCreateDepartment:showDepartment});
  scene.setData({departments,agents:employees});window.officeScene=scene;
}catch(error){$('canvas').innerHTML='<div class="scene-empty"><h2>The 3D office could not start.</h2><p>'+esc(error.message)+'</p><button class="add-agent-button" id="fallback-team">Open your team</button></div>';$('fallback-team').onclick=()=>showAgentManager('directory');console.error(error);}
updateHeader();
$('manage-agents').onclick=()=>showAgentManager('directory');$('add-agent').onclick=()=>showAgentManager('create');$('add-department').onclick=showDepartment;
$('office-home').onclick=()=>{closeManagers();focusSelection({type:'office'});};$('office-view').onclick=()=>setView('office');$('connections-view').onclick=()=>setView('connections');
$('zoom-out').onclick=()=>scene?.zoomBy(1/1.2);$('zoom-in').onclick=()=>scene?.zoomBy(1.2);$('zoom-fit').onclick=()=>focusSelection({type:'office'});
$('review-button').onclick=()=>{closeManagers();sidebar.select({type:'office'});sidebar.showTab('tasks');openMobilePanel();};
$('runtime-details').onclick=()=>{setView('connections');openMobilePanel();};
$('runtime-buttons').onclick=event=>{const button=event.target.closest('[data-runtime]');if(button){setView('connections');sidebar.showRuntime(button.dataset.runtime);openMobilePanel();}};
$('play-communication').setAttribute('aria-label','Show recorded tasks');$('play-communication').onclick=()=>$('review-button').click();document.querySelector('.sample-label').textContent='WORKSPACE';
$('mobile-panel').onclick=()=>{closeManagers();const open=document.body.classList.toggle('panel-open');$('mobile-panel').setAttribute('aria-expanded',String(open));};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)){closeManagers();document.body.classList.remove('panel-open');focusSelection({type:'office'});}});
window.officePreview={getState:()=>({selection,view,employees:employees.length,specialists:employees.length,demo:false,camera:scene?.getSnapshot()}),focus:focusSelection};
const timer=setInterval(()=>{if(!manager.isOpen()&&!departmentManager.isOpen()&&!document.querySelector('dialog[open]')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))refreshLive().catch(error=>notice(error.message));},4000);
window.addEventListener('pagehide',()=>{clearInterval(timer);scene?.destroy();},{once:true});
if(live.error)notice(live.error.message||String(live.error));
