import { describe, expect, it } from 'vitest';
const modulePath = '../../web/headquarters/src/headquarters/task-rail.js';
const { taskRailFacts, renderTaskRailSummary, renderTaskReply, taskBlocker } = await import(modulePath);
const statusPath='../../web/headquarters/src/headquarters/task-status.js';
const {requestTaskStatus}=await import(statusPath);
const agents = [{ id:'head', name:'Mike Slattery' }, { id:'frontend', name:'Kara Foster' }, { id:'backend', name:'Alisha Granderson' }];
const departments = [{id:'engineering',name:'Engineering',headAgentId:'head'}];
const projects = [{id:'one',name:'Website'},{id:'two',name:'Payments'}];
const request = {id:'request',runId:'run',projectId:'one',state:'running',task:'Connect search to the API',route:{state:'selected',departmentId:'engineering'}};
const run = {id:'run',projectId:'one',state:'running',taskViews:[
  {id:'ui',objective:'Connect the search input',state:'running',ownerAgentId:'frontend',receipts:{verifierExecutedPassed:0}},
  {id:'api',objective:'Build search API',state:'accepted',ownerAgentId:'backend',receipts:{verifierExecutedPassed:2}},
]};
const context = {request,run,agents,departments,projects};

describe('live task rail facts',()=>{
  it('shows the actual project, currently working owner, task objectives and independent receipts together',()=>{
    const html=renderTaskRailSummary(context);
    expect(html).toContain('Website');expect(html).toContain('Execution');expect(html).toContain('Kara Foster');expect(html).toContain('Alisha Granderson');
    expect(html).toContain('Connect the search input');expect(html).toContain('Build search API');expect(html).toContain('1/2 completed');expect(html).toContain('2 checks passed');
    expect(taskRailFacts(context).owners).toEqual(['Kara Foster']);
  });
  it('does not truncate the team to the first four workers',()=>{
    const data={...context,run:{...run,taskViews:Array.from({length:12},(_,i)=>({id:`task-${i}`,ownerAgentId:`worker-${i}`,objective:`Objective ${i}`,state:'ready'}))}};
    expect(renderTaskRailSummary(data)).toContain('Objective 11');expect(taskRailFacts(data).tasks).toHaveLength(12);
  });
  it('does not borrow task rows, activity, or verifier evidence from another project',()=>{
    const facts=taskRailFacts({...context,run:{...run,projectId:'two'},events:[{runId:'run',projectId:'two',type:'runtime.assistant_message',payload:{text:'Private other project update'}}]});
    expect(facts.tasks).toEqual([]);expect(facts.latestText).toBe('');expect(facts.checks).toBe('Execution evidence is not loaded yet');
  });
  it('settled and disconnected requests never animate lingering running worker rows',()=>{
    const ended=taskRailFacts({...context,request:{...request,state:'cancelled'}});
    expect(ended.active).toBe(false);expect(ended.tasks[0].state).toBe('Stopped');
    const disconnected=taskRailFacts({...context,connected:false});expect(disconnected.active).toBe(false);expect(disconnected.status).toContain('last received');expect(disconnected.tasks[0].state).toBe('Last known: Working');
  });
  it('can read an explicit resume request without a new runId field',()=>{
    const facts=taskRailFacts({...context,request:{...request,runId:undefined,resumeRunId:'run'}});
    expect(facts.tasks).toHaveLength(2);expect(facts.owners).toEqual(['Kara Foster']);
  });
  it('requires checks and head review to describe a delivered verified candidate',()=>{
    const ended={...request,state:'ended',exitCode:0};
    const data={...context,request:ended,run:{...run,state:'ready_for_review',outcome:{accepted:true,requiredTotal:2,requiredPassed:2},headReview:{state:'passed'}}};
    expect(taskRailFacts(data)).toMatchObject({status:'Verified',checks:'2 of 2 required checks passed'});
    expect(taskRailFacts({...data,run:{...data.run,compromisedReceiptIds:['changed']}}).status).not.toBe('Verified');
    expect(taskRailFacts({...data,run:{...data.run,headReview:null}}).status).toBe('Review not recorded');
    expect(taskRailFacts({...context,request:ended}).status).not.toBe('Verified');
  });
  it('labels an evidence-backed analysis report without pretending code was changed or accepted',()=>{
    const analyzed={...run,state:'ready_for_review',workKind:'analysis',outcome:{accepted:false},analysis:{reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[]},headReview:{state:'passed'}};
    const ended={...request,state:'ended',exitCode:0};
    expect(requestTaskStatus(ended,analyzed)).toMatchObject({bucket:'done',label:'Reviewed analysis'});
    const facts=taskRailFacts({...context,request:ended,run:analyzed});expect(facts.status).toBe('Reviewed analysis');expect(facts.checks).toBe('1 reviewed report · code unchanged');
    expect(requestTaskStatus(ended,{...analyzed,analysis:{...analyzed.analysis,reviewed:false,evidenceIssues:['Report changed']}})).toMatchObject({bucket:'waiting',label:'Analysis evidence incomplete'});
  });
  it('shows a recorded agent update but never treats the prose as acceptance',()=>{
    const facts=taskRailFacts({...context,events:[{sequence:1,type:'runtime.assistant_message',taskId:'ui',payload:{text:'I finished everything. All tests passed.'}}]});
    expect(facts.latestText).toBe('I finished everything. All tests passed.');expect(facts.status).toBe('Working');expect(facts.checks).toContain('No completed verification');
  });
  it('keeps long worker instructions expandable and avoids repeating a delivered report in the status summary',()=>{
    const title='Inspect the project and explain its features.\nScope: Read all source files and identify limitations.\n'+ 'Preserve every detailed requirement. '.repeat(20);
    const data={...context,run:{...run,taskViews:[{...run.taskViews[0],objective:title}]},events:[{type:'runtime.assistant_message',payload:{text:'**Current finding.** More detailed evidence follows.'}}]};
    const html=renderTaskRailSummary(data);
    expect(html).toContain('<details class="cc-worker-brief"');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain('Preserve every detailed requirement.');
    expect(html).toContain('Current finding.');expect(html).not.toContain('**Current finding.**');
    const completed=renderTaskRailSummary({...data,request:{...request,state:'ended',exitCode:0}});
    expect(completed).not.toContain('Latest agent update');
    expect(taskRailFacts(data).tasks[0].title).toBe(title);
  });
  it('renders genuine blockers in plain language and keeps command instructions in closed diagnostics',()=>{
    const failed={...request,state:'failed_to_start',result:{code:'no_workers',message:'no worker of department "Engineering" is placed on project "Website"',details:['place one: workforce workspace assign <worker> Website']}};
    expect(taskBlocker(failed)).toBe('This earlier attempt stopped before assigning a team. No project work ran.');
    const html=renderTaskRailSummary({...context,request:failed,run:null});expect(html).toContain('No project work ran.');expect(html).not.toContain('workforce workspace assign');
    const original=renderTaskReply('Use workforce workspace assign <worker> Website',failed,(value:string)=>value.replaceAll('<','&lt;'));
    expect(original).toContain('<details class="cc-original-response"');expect(original).not.toMatch(/<details[^>]*\bopen\b/);expect(original).toContain('workforce workspace assign');
  });
  it('keeps the historical missing project assignment out of the live waiting count',()=>{
    const failed={id:'old',projectId:'one',state:'failed_to_start',result:{code:'no_worker_on_project',message:'no worker of department Engineering is placed on project Website'},route:{state:'blocked',departmentId:'engineering'}};
    expect(requestTaskStatus(failed)).toMatchObject({bucket:'closed',label:'Did not start'});
    expect(taskRailFacts({...context,request:failed,run:null})).toMatchObject({phase:'Not started',status:'Did not start'});
  });
  it('keeps a clarification visible and does not relabel it as an approval',()=>{
    const unclear={...request,route:{state:'blocked',reason:'Which payment flow should change?'}};
    expect(taskRailFacts({...context,request:unclear}).action).toBe('Which payment flow should change?');
  });
  it('escapes user-controlled identities, objectives, and update text',()=>{
    const malicious='<img src=x onerror=alert(1)>';
    const html=renderTaskRailSummary({...context,projects:[{id:'one',name:malicious}],run:{...run,taskViews:[{...run.taskViews[0],objective:malicious}]},events:[{type:'runtime.assistant_message',payload:{text:malicious}}]});
    expect(html).not.toContain('<img');expect(html).toContain('&lt;img');expect(html).not.toContain('onerror="');
  });
});
