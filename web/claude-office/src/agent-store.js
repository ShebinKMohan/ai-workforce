/** The original agent directory backed by Workforce's revisioned workspace. */
export const providers = [{id:'openai',name:'OpenAI'},{id:'anthropic',name:'Anthropic'},{id:'google',name:'Google (not supported)'},{id:'ollama',name:'Ollama (not supported)'},{id:'custom',name:'Custom provider (not supported)'}];
const failure=(fields,message='Please check the highlighted agent settings.')=>Object.assign(new Error(message),{fields});
const runtimeType=adapter=>adapter==='codex'?'codex-cli':adapter==='claude-code'?'claude-code':adapter;
const providerFor=adapter=>adapter==='codex'?'openai':adapter==='claude-code'?'anthropic':'custom';

export function createAgentStore({employees=[],departments=[],runtimes=[],control={},workspace=null,getWorkspace,onWorkspace=()=>{}}={}) {
  let document=workspace;
  let warning='';
  const coordinator={...control,id:'control',name:'Coordinator',role:'System scheduler',departmentId:'control',isCoordinator:true,isCustom:false,model:'',provider:'',runtime:'',instructions:'The system scheduler routes tasks to configured department heads. It is not a model agent.',status:'system',task:''};
  const current=()=>getWorkspace?.()||document;
  const config=()=>current()?.workspace||current();
  function decorate(agent) {
    const runtime=config()?.runtimes?.[agent.runtime]||{};
    const prior=employees.find(item=>item.id===agent.id)||{};
    return {...prior,...agent,workspaceRole:agent.role,role:agent.role,workspaceRuntimeId:agent.runtime,runtimeId:prior.runtimeId||agent.runtime,runtime:runtimeType(runtime.adapter),provider:providerFor(runtime.adapter),customProvider:'',model:agent.model??runtime.model??'',instructions:agent.instructions,endpoint:'',credentialEnv:'',temperature:null,isCoordinator:false,isCustom:prior.isCustom??!Number.isFinite(prior.x),status:prior.status||'configured',task:prior.task||''};
  }
  function setWorkspace(next) {
    document=next;
    const value=next?.workspace||next;
    if(!value?.agents) return;
    const agents=value.agents.filter(agent=>!agent.archived).map(decorate);
    employees.splice(0,employees.length,...agents);
    for(const department of departments) if(Array.isArray(department.employees)) department.employees.splice(0,department.employees.length,...agents.filter(agent=>agent.departmentId===department.id).map(agent=>agent.id));
  }
  async function request(url,body) {
    const headers={accept:'application/json'};
    if(body!==undefined) {
      const token=globalThis.document?.querySelector('meta[name="workforce-session-token"]')?.getAttribute('content');
      if(!token) throw failure({storage:'Open this page from workforce serve; its session token is missing.'});
      headers['content-type']='application/json'; headers['x-workforce-token']=token;
    }
    const response=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok||result.ok===false) throw failure({storage:result.error?.message||'Workspace save failed.'},result.error?.message||`Request failed (${response.status})`);
    return result;
  }
  async function refresh() { const next=await request('/api/workspace');setWorkspace(next);await onWorkspace(next);return next; }
  const list=()=>((config()?.agents)||[]).filter(agent=>!agent.archived).map(decorate);
  const get=id=>id==='control'?coordinator:list().find(agent=>agent.id===id);
  async function save(values) {
    if(!config()?.agents) await refresh();
    const base=config();
    const existing=values.id?base.agents.find(agent=>agent.id===values.id&&!agent.archived):null;
    if(values.id==='control') throw failure({name:'The coordinator is a system scheduler. Edit a department head to change its model.'});
    if(values.id&&!existing) throw failure({name:'This agent no longer exists. Reopen the directory.'});
    const fields={};
    const name=String(values.name||'').trim();
    const instructions=String(values.instructions||'').trim();
    const model=String(values.model||'').trim();
    if(!name||name.length>60) fields.name='Enter a name from 1 to 60 characters.';
    if(!instructions) fields.instructions='Add instructions for this agent.';
    if(model.length>120) fields.model='Use an exact model ID of at most 120 characters.';
    if(!['codex-cli','claude-code'].includes(values.runtime)) fields.runtime='Only installed Codex CLI and Claude Code can run tasks. Ollama and direct API adapters are not implemented.';
    const expectedProvider=values.runtime==='claude-code'?'anthropic':'openai';
    if(values.provider!==expectedProvider) fields.provider=`Choose ${expectedProvider==='openai'?'OpenAI for Codex CLI':'Anthropic for Claude Code'}. Other provider connections are not supported.`;
    if(values.endpoint) fields.endpoint='Custom endpoints are not supported by the installed CLI adapters.';
    if(values.credentialEnv) fields.credentialEnv='Use the coding tool’s own sign-in. Credential overrides are not supported here.';
    if(values.temperature!==null&&values.temperature!==undefined&&values.temperature!=='') fields.temperature='Leave temperature blank; these CLI adapters do not support this control.';
    if(!base.departments.some(dept=>dept.id===values.departmentId&&!dept.archived)) fields.departmentId='Choose an existing department.';
    const role=String(values.role||'worker').toLowerCase();
    if(existing&&role!==existing.role) fields.role='An existing agent keeps its head or worker role.';
    if(!existing&&role!=='worker') fields.role='New agents here are workers. Describe their specialty in Instructions.';
    const projectIds=existing?.role==='head'?[]:Array.isArray(values.projectIds)?[...new Set(values.projectIds)]:existing?.projectIds||[];
    if(projectIds.some(id=>!base.projects.some(project=>project.id===id&&!project.archived))) fields.projectIds='Choose projects that are still registered.';
    if(Object.keys(fields).length) throw failure(fields);
    const adapter=values.runtime==='claude-code'?'claude-code':'codex';
    const sameRuntime=existing&&base.runtimes[existing.runtime]?.adapter===adapter;
    const runtime=sameRuntime?existing.runtime:adapter==='codex'?'codex-local':'claude-local';
    const ops=[];
    if(existing) {
      const op={op:'agent.edit',id:existing.id,name,instructions,runtime,departmentId:values.departmentId};
      const currentModel=existing.model??base.runtimes[existing.runtime]?.model??'';
      if(model!==currentModel) op.model=model||null;
      ops.push(op);
      if(existing.role==='worker') {
        for(const id of existing.projectIds) if(!projectIds.includes(id)) ops.push({op:'agent.unassign',agentId:existing.id,projectId:id});
        for(const id of projectIds) if(!existing.projectIds.includes(id)) ops.push({op:'agent.assign',agentId:existing.id,projectId:id});
      }
    } else ops.push({op:'agent.add',name,role:'worker',departmentId:values.departmentId,runtime,instructions,projectIds,...(model?{model}:{})});
    const result=await request('/api/workspace/ops',{expectRevision:values.expectRevision??current()?.revision??base.revision,ops});
    const next={...(current()?.workspace?current():{}),workspace:result.workspace,revision:result.revision};
    setWorkspace(next);
    warning='';
    try { await onWorkspace(next); } catch { warning='Settings were saved. Refresh the page to reload the office view.'; }
    const id=existing?.id||result.created?.agents?.[0];
    return get(id);
  }
  if(workspace) setWorkspace(workspace);
  return {list,get,save,setWorkspace,refresh,get departments(){return (config()?.departments||[]).filter(department=>!department.archived).map(department=>({...departments.find(item=>item.id===department.id),...department}));},providers,get projects(){return (config()?.projects||[]).filter(project=>!project.archived);},get revision(){return current()?.revision??config()?.revision??0;},get storageWarning(){return warning;}};
}
