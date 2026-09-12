import { postJson } from '/workspace/src/api.js';
const esc = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function reviewTask(context, document) {
  const workspace = document.workspace;
  const eligible = document.readiness?.eligibility?.filter(e=>e.sendable) || [];
  if (!eligible.length) throw new Error('Add a project and an eligible department in Projects before sending work.');
  const requested = context.departmentId || (context.selection?.type==='department' ? context.selection.id : workspace.agents.find(a=>a.id===context.selection?.id)?.departmentId);
  const first = eligible.find(e=>e.departmentId===requested) || eligible[0];
  const dialog = window.document.createElement('dialog');
  dialog.style.cssText='width:min(620px,calc(100vw - 32px));max-height:90vh;padding:0;border:1px solid #d9dfd3;border-radius:16px;background:#fbfcf7;color:#23382d;box-shadow:0 24px 90px #23382d33;';
  dialog.innerHTML = '<form class="am-form" style="height:auto;padding:26px"><h2 style="font:32px Georgia;margin:0 0 20px">Review task</h2><p>Your department head will plan this request, assign eligible workers and run the project checks.</p><label>Project and department<select name="pair" style="width:100%;padding:12px;margin:8px 0 18px">'+eligible.map((e,i)=>'<option value="'+i+'" '+(e===first?'selected':'')+'>'+esc(workspace.projects.find(p=>p.id===e.projectId)?.name)+' · '+esc(workspace.departments.find(d=>d.id===e.departmentId)?.name)+'</option>').join('')+'</select></label><label>Request<textarea name="task" rows="5" required style="width:100%;box-sizing:border-box;padding:12px;margin:8px 0 18px">'+esc(context.text)+'</textarea></label><div data-details></div><label data-consent hidden style="margin:18px 0"><input name="consent" type="checkbox"> Allow this runtime to write without a verified OS file boundary. It will run alone.</label><p data-error role="alert" style="color:#9a382c"></p><footer style="display:flex;justify-content:flex-end;gap:12px;margin-top:20px"><button type="button" class="am-button am-secondary" data-cancel>Cancel</button><button type="submit" class="am-button am-primary">Send to department head</button></footer></form>';
  const form=dialog.querySelector('form');
  const details=()=>{
    const e=eligible[Number(form.elements.pair.value)];
    const head=workspace.agents.find(a=>a.id===e.headAgentId);
    const roster=[head,...e.workerIds.map(id=>workspace.agents.find(a=>a.id===id))].filter(Boolean);
    const unconfined=roster.some(a=>document.runtimeRules?.[a.runtime]?.writeContainment!=='verified');
    dialog.querySelector('[data-consent]').hidden=!unconfined;
    dialog.querySelector('[data-details]').innerHTML='<p><strong>Head:</strong> '+esc(head?.name)+'</p><p><strong>Eligible workers:</strong> '+esc(roster.slice(1).map(a=>a.name).join(', '))+'</p><p><strong>Checks:</strong> '+esc(document.checks?.find(c=>c.projectId===e.projectId)?.detail || 'Configured project checks')+'</p><p>Work starts from the committed project revision in an isolated copy. Your current checkout is preserved.</p>';
    return {e,unconfined};
  };
  form.elements.pair.addEventListener('change',details);details();
  window.document.body.append(dialog);dialog.showModal();
  return new Promise(resolve=>{
    const cancel=()=>{dialog.close();dialog.remove();resolve({cancelled:true});};
    dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
    dialog.querySelector('[data-cancel]').addEventListener('click',cancel);
    form.addEventListener('submit',async event=>{
      event.preventDefault();const {e,unconfined}=details();
      const error=dialog.querySelector('[data-error]');
      if(unconfined&&!form.elements.consent.checked){error.textContent='Confirm the displayed runtime write boundary before sending.';return;}
      const button=form.querySelector('[type=submit]');button.disabled=true;
      try{
        const result=await postJson('/api/requests',{projectId:e.projectId,departmentId:e.departmentId,task:form.elements.task.value.trim(),...(unconfined?{allowUnconfinedWrites:true}:{})});
        dialog.close();dialog.remove();resolve({message:'Your request is recorded. The department head will plan the work; follow it in Tasks.',task:result.request});
      }catch(cause){error.textContent=cause.message;button.disabled=false;}
    });
  });
}

