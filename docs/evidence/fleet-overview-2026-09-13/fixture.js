import {renderOverview,wireOverview} from '/src/headquarters/live-overview.js';
import {createOfficeInspector} from '/src/headquarters/office-inspector.js';
const names=['Mike Slattery','Kara Foster','Alisha Granderson','Rachel Scott','Russ Jeter','Danny Green','Andrea Garnett','Sasha Cooper','Eric Miller'];
const agents=Array.from({length:72},(_,i)=>({id:`agent-${i}`,name:i<9?names[i]:`Specialist ${i+1}`,departmentId:`dept-${Math.floor(i/24)}`,isHead:i%24===0,role:i%24===0?'head':'worker',instructions:`ROLE: ${i%24===0?'Engineering Department Head':'Software & Integration Engineer'}\nWork on assigned requests and report verified results.`,provider:'codex',model:'test-model'}));
const departments=['Nathan James Engineering','Quality & Verification','Platform & Operations'].map((name,i)=>({id:`dept-${i}`,name,headAgentId:`agent-${i*24}`}));
let data={agents,departments,controlCenter:{id:'control-center',name:'Control Center',instructions:'ROLE: Company Orchestrator'},connected:true,streaming:true,requests:[{id:'req',projectId:'p',runId:'run',task:'Improve workspace search and keyboard navigation',state:'running'}],runs:[{id:'run',projectId:'p',state:'running',taskViews:[{id:'task',state:'running',ownerAgentId:'agent-20',objective:'Implement accessible search across departments'},{id:'qa',state:'validating',ownerAgentId:'agent-3',objective:'Verify the keyboard flow and responsive layout'}]}],events:[{id:'assigned',projectId:'p',runId:'run',timestamp:'2026-09-13T12:00:00Z',type:'head.assigned',payload:{headAgentId:'agent-0',agentId:'agent-20',taskId:'task',objective:'Implement accessible search'}},{id:'review',projectId:'p',runId:'run',timestamp:'2026-09-13T12:01:00Z',type:'head.review_started',payload:{headAgentId:'agent-0'}}]};
const host=document.querySelector('#live-overview-host');host.innerHTML=renderOverview(data);
const output=text=>document.querySelector('#result').textContent=text;
const inspector=createOfficeInspector({element:document.querySelector('#main'),getData:()=>data,onRequest:id=>output(`Opened request ${id}`),onAgent:id=>overview.focusAgent(id)});
const overview=wireOverview(host,{onAgent:id=>inspector.showAgent(id),onDepartment:id=>inspector.showDepartment(id),onRequest:id=>output(`Opened request ${id}`)});
function refresh(){overview.update(data);inspector.update();}
document.addEventListener('workforce:fleet-selection',refresh);
document.querySelector('#test-controls').addEventListener('click',event=>{
 const mode=event.target.dataset.test;if(!mode)return;
 if(mode==='offline')data.connected=false;
 if(mode==='work'||mode==='checks'){data.connected=true;data.requests[0].state='running';data.runs[0].taskViews[0].state=mode==='work'?'running':'validating';}
 if(mode==='stop')data.requests[0].state='cancelled';
 refresh();output(`Fixture: ${mode}`);
});
