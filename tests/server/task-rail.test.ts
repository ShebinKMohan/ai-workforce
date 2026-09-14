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
  it('shows worker elapsed time from its attempt and keeps a completed attempt fixed during report review',()=>{
    const start='2026-09-14T10:00:00Z',end='2026-09-14T10:02:03Z';
    const working={...context,request:{...request,receivedAt:'2026-09-14T09:00:00Z'},run:{...run,taskViews:[{...run.taskViews[0],attempt:{state:'running',startedAt:start}}]}};
    expect(taskRailFacts(working).tasks[0].duration).toMatchObject({start,active:true});
    const reviewing={...working,run:{...working.run,workKind:'analysis',taskViews:[{...working.run.taskViews[0],state:'validating',attempt:{state:'completed',startedAt:start,endedAt:end}}]}};
    const facts=taskRailFacts(reviewing);
    expect(facts.tasks[0]).toMatchObject({state:'Report ready',tone:'queued',duration:{start,end,active:false,label:'Worker time'}});
    expect(facts.phase).toBe('Report review');expect(renderTaskRailSummary(reviewing)).toContain('2m 03s');
    expect(renderTaskRailSummary(reviewing)).not.toContain('Running an independent check');
  });
  it('uses the exact current head review interval without borrowing a different review or project finish',()=>{
    const start='2026-09-14T10:00:00Z',end='2026-09-14T10:02:03Z';
    const data={...context,run:{...run,workKind:'analysis',headReview:{state:'running',headAgentId:'head',reviewId:'current',at:start}},events:[{sequence:1,type:'head.review_started',timestamp:start,payload:{headAgentId:'head',reviewId:'current'}},{sequence:2,type:'head.review_finished',timestamp:end,payload:{headAgentId:'head',reviewId:'older'}},{sequence:3,type:'head.review_finished',projectId:'two',timestamp:end,payload:{headAgentId:'head',reviewId:'current'}}]};
    expect(taskRailFacts(data).phaseDuration).toMatchObject({start,active:true,label:'Review time'});
    expect(taskRailFacts(data).phaseDuration.end).toBeNull();
    const completed={...data,events:[...data.events,{sequence:4,type:'head.review_finished',timestamp:end,payload:{headAgentId:'head',reviewId:'current'}}]};
    expect(taskRailFacts(completed).phaseDuration).toMatchObject({start,end,active:false});
    expect(renderTaskRailSummary(completed)).toContain('2m 03s');
  });
  it('keeps missing phase boundaries unknown instead of treating request arrival as worker or review start',()=>{
    const facts=taskRailFacts({...context,request:{...request,receivedAt:'2026-09-14T09:00:00Z'},run:{...run,headReview:{state:'running',headAgentId:'head'}}});
    expect(facts.requestDuration.start).toBe('2026-09-14T09:00:00Z');
    expect(facts.phaseDuration.start).toBeNull();expect(facts.tasks[0].duration.start).toBeNull();
  });
  it('requires complete independent receipts and head review before exit zero becomes Verified',()=>{
    const ended={...request,state:'ended',exitCode:0};
    const checked={...run,state:'ready_for_review',outcome:{accepted:true,requiredTotal:2,requiredPassed:2},headReview:{state:'passed'}};
    expect(requestTaskStatus(ended,checked)).toMatchObject({bucket:'done',label:'Verified'});
    for(const invalid of [{...checked,headReview:null},{...checked,compromisedReceiptIds:['changed']},{...checked,outcome:{...checked.outcome,requiredPassed:1}},{...checked,outcome:{...checked.outcome,requiredTotal:0,requiredPassed:0}},{...checked,projectId:'two'}])expect(requestTaskStatus(ended,invalid).bucket).not.toBe('done');
    expect(requestTaskStatus({...ended,runId:undefined,resumeRunId:'run'},checked).label).toBe('Verified');
  });

  it('keeps total request duration anchored to intake receipt after execution starts',()=>{
    const receivedAt='2026-09-14T09:00:00Z',startedAt='2026-09-14T09:01:00Z';
    const queued=taskRailFacts({...context,run:null,request:{...request,runId:null,state:'queued',receivedAt,route:{state:'pending'}}});
    const running=taskRailFacts({...context,request:{...request,receivedAt,startedAt}});
    expect(queued.requestDuration.start).toBe(receivedAt);expect(running.requestDuration.start).toBe(receivedAt);
    expect(queued.status).toBe('Routing');expect(queued.phase).toBe('Understanding request');
    expect(queued.action).toContain('Understanding the request');
    const capacity=taskRailFacts({...context,run:null,request:{...request,runId:null,state:'queued',receivedAt,route:{state:'selected'}}});
    expect(capacity.status).toBe('Queued');expect(capacity.action).toContain('Waiting for capacity');
  });

  it('uses the server’s verified planned-delivery projection when outcome is legitimately null',()=>{
    const ended={...request,state:'ended',exitCode:0};
    const delivered={...run,state:'ready_for_review',workKind:'implementation',outcome:null,tasks:{total:1,byState:{accepted:1}},taskViews:[{id:'ui',objective:'Fix renderer',ownerAgentId:'frontend',state:'accepted',generation:1,attempt:{id:'attempt',state:'completed',generation:1,startedAt:'2026-09-14T10:00:00Z',endedAt:'2026-09-14T10:01:00Z'},receipts:{verifierExecutedPassed:1,verifierExecutedFailed:0,verifierExecutedCompromised:0,verifierExecutedOther:0,otherProvenance:0}}],headReview:{state:'passed',verdict:'passed',interrupted:false,sessionStopped:true,artifactId:'review-artifact',candidateRevision:'revision'},evidenceIssues:[],compromisedReceiptIds:[],unverifiedReceiptIds:[],delivery:{state:'verified',verified:true,analysisReviewed:false,checks:{passed:1,total:1},evidenceIssues:[],reason:'Verified candidate and head review.'}};
    expect(requestTaskStatus(ended,delivered)).toMatchObject({bucket:'done',label:'Verified'});
    const facts=taskRailFacts({...context,request:ended,run:delivered});
    expect(facts).toMatchObject({status:'Verified',phase:'Delivered',active:false,checks:'1 of 1 independent checks passed'});
    for(const invalid of [{...delivered,delivery:undefined},{...delivered,delivery:{...delivered.delivery,verified:false,reason:'The head review artifact is unavailable.'}},{...delivered,delivery:{...delivered.delivery,evidenceIssues:['Review artifact changed']}},{...delivered,compromisedReceiptIds:['receipt']},{...delivered,headReview:{...delivered.headReview,sessionStopped:false}}]){
      expect(requestTaskStatus(ended,invalid).bucket).not.toBe('done');expect(taskRailFacts({...context,request:ended,run:invalid}).status).not.toBe('Verified');
    }
    const rejected={...delivered,outcome:{accepted:true,requiredTotal:1,requiredPassed:1},delivery:{...delivered.delivery,verified:false,reason:'Combined candidate differs from the reviewed revision.'}};
    expect(requestTaskStatus(ended,rejected).bucket).toBe('waiting');
    expect(taskRailFacts({...context,request:ended,run:rejected}).action).toContain('Combined candidate differs');
  });

});

describe('actionable attention and concise default answers',()=>{
 it('keeps an unloaded completed result neutral without offering recovery until evidence loads',async()=>{
  const {taskAttention}=await import(modulePath);
  const ended={...request,state:'ended',exitCode:0,recovery:{canRetry:false}};
  const pending=taskRailFacts({...context,request:ended,run:null,runsLoaded:false});
  expect(pending).toMatchObject({status:'Loading result',tone:'idle',active:false});
  expect(pending.action).not.toContain('Result not loaded');
  expect(taskAttention(ended,null,[],{runsLoaded:false})).toBeNull();
  expect(taskAttention(ended,null,[],{runsLoaded:true}).actions).toEqual([{kind:'refresh',label:'Load saved result'}]);
  const cancelled={...ended,stopRequestedAt:'2026-09-14T10:00:00Z',signal:'SIGINT'};
  expect(requestTaskStatus(cancelled,null,[],{runsLoaded:false})).toMatchObject({bucket:'closed',label:'Stopped'});
 });
 it('links an older failed review to its explicit resume without leaving another Resume action',async()=>{
  const {taskAttention}=await import(modulePath);
  const ended={...request,state:'ended',exitCode:130,receivedAt:'2026-09-14T10:00:00Z'};
  const resume={...request,id:'resume',runId:null,resumeRunId:'run',receivedAt:'2026-09-14T10:01:00Z'};
  const saved={...run,state:'interrupted',headReview:{state:'blocked',sessionStopped:true,summary:'The head did not submit a structured review decision.'}};
  expect(taskAttention(ended,saved,[ended,resume]).actions).toEqual([{kind:'successor',label:'Open current attempt',id:'resume'}]);
  expect(taskRailFacts({...context,request:ended,run:saved,requests:[ended,resume]})).toMatchObject({status:'Continued in newer attempt',active:false});
  expect(taskAttention(ended,saved,[ended,{...resume,projectId:'two'}]).actions).toEqual([{kind:'resume',label:'Resume'}]);
 });
 it('keeps an invalid final review in Needs you and offers explicit Resume without claiming cancellation or delivery',async()=>{
  const {taskAttention,taskResultSummary}=await import(modulePath);
  const ended={...request,state:'ended',exitCode:130,stopRequestedAt:null,signal:null,result:{code:null},recovery:{canRetry:false,action:null}};
  const review={state:'blocked',verdict:'blocked',sessionStopped:true,interrupted:false,summary:'The head did not submit a structured review decision.'};
  const interrupted={...run,state:'interrupted',workKind:'analysis',headReview:review,taskViews:[{...run.taskViews[0],state:'validating',attempt:{state:'completed',endedAt:'2026-09-14T10:00:00Z'}}],analysis:{reviewed:false,sourceUnchanged:false,reportCount:1,evidenceIssues:[]}};
  for(const headReview of [review,{...review,summary:'Resume the saved review.',failureCode:'head_review_invalid'}]){
   const saved={...interrupted,headReview};
   expect(requestTaskStatus(ended,saved)).toMatchObject({bucket:'waiting',label:'Review needs retry'});
   const facts=taskRailFacts({...context,request:ended,run:saved});
   expect(facts).toMatchObject({status:'Review needs retry',phase:'Report review',active:false});
   expect(facts.action).toContain('Final review needs attention');expect(facts.tasks[0].state).toBe('Report ready');
   expect(taskAttention(ended,saved).actions).toEqual([{kind:'resume',label:'Resume'}]);
   expect(taskResultSummary('Routed to the team.',ended,saved)).toContain('Resume the saved run');
  }
  for(const patch of [{stopRequestedAt:'2026-09-14T10:00:00Z'},{signal:'SIGTERM'},{state:'cancelled'}]){
   const cancelled={...ended,...patch};
   expect(requestTaskStatus(cancelled,interrupted).label).toBe('Stopped');
   expect(taskAttention(cancelled,interrupted)?.actions.some((action:{kind:string})=>action.kind==='resume')).not.toBe(true);
  }
  for(const saved of [{...interrupted,projectId:'two'},{...interrupted,id:'other'},{...interrupted,state:'running'},{...interrupted,headReview:{...review,sessionStopped:false}},{...interrupted,headReview:{...review,summary:'The candidate requires changes.'}}]){
   expect(requestTaskStatus(ended,saved).label).not.toBe('Review needs retry');
   expect(taskAttention(ended,saved)?.actions.some((action:{kind:string})=>action.kind==='resume')).not.toBe(true);
  }
 });
 it('gives paused, clarification, permission and account failures specific supported next steps',async()=>{
  const {taskAttention}=await import(modulePath);
  expect(taskAttention({...request,state:'held'}).actions.map((a:{kind:string})=>a.kind)).toEqual(['start','cancel']);
  expect(taskAttention({...request,state:'ended',route:{state:'blocked',outcome:'clarification',reason:'Which checkout should change?'}})).toMatchObject({message:'Which checkout should change?',actions:[{kind:'answer'}]});
  const failed={...request,state:'failed_to_start',recovery:{canRetry:true,action:'retry'}};
  const permission=taskAttention({...failed,result:{code:'unconfined_consent_required'}});
  expect(permission.actions.map((a:{kind:string})=>a.kind)).toEqual(['permission','runtime']);
  expect(permission.nextStep).toContain('choose whether to allow');
  expect(taskAttention({...failed,recovery:{...failed.recovery,failureClass:'authentication'}}).actions.map((a:{kind:string})=>a.kind)).toEqual(['signin','retry']);
  const quota=taskAttention({...failed,recovery:{...failed.recovery,failureClass:'quota'}});
  expect(quota.nextStep).toContain('allowance to reset');expect(quota.nextStep).toContain('new request');
 });
 it('offers one saved retry or resume, never retries verified results or hides missing evidence behind success',async()=>{
  const {taskAttention}=await import(modulePath);
  const ended={...request,state:'ended',exitCode:0,recovery:{canRetry:true,action:'resume'}};
  const delivered={...run,state:'ready_for_review',delivery:{verified:true,evidenceIssues:[],checks:{total:1,passed:1}},headReview:{state:'passed'}};
  expect(taskAttention(ended,delivered)).toBeNull();
  expect(taskAttention({...ended,recovery:{canRetry:true,action:'resume'}},run).actions).toEqual([{kind:'retry',label:'Resume and repair'}]);
  const incomplete=taskAttention({...ended,recovery:{canRetry:false}},run);
  expect(incomplete.actions.map((a:{kind:string})=>a.kind)).toEqual(['diagnostics','followup']);
  const missing=taskAttention({...ended,recovery:{canRetry:false}});
  expect(missing.actions).toEqual([{kind:'refresh',label:'Load saved result'}]);
  expect(taskAttention({...ended,recovery:{canRetry:false,nextRequestId:'new'}},run).actions).toEqual([{kind:'successor',label:'Open retry',id:'new'}]);
 });
 it('shortens feed headlines without dropping the full saved brief and closes technical or long reviews',async()=>{
  const {requestHeadline,taskResultSummary}=await import(modulePath);
  const brief='Fix checkout accessibility\n'+ 'A detailed requirement. '.repeat(50);
  expect(requestHeadline(brief)).toBe('Fix checkout accessibility');expect(requestHeadline('A'.repeat(1000))).toHaveLength(130);
  const ended={...request,task:brief,state:'ended',exitCode:0};
  const delivered={...run,state:'ready_for_review',delivery:{verified:true,evidenceIssues:[],checks:{total:1,passed:1}},headReview:{state:'passed'}};
  const review='Head review passed. '+ 'Internal candidate review detail. '.repeat(60);
  const html=renderTaskReply(review,ended,(value:string)=>value,delivered);
  expect(html.split('<details')[0]).toContain('Completed: Fix checkout accessibility.');expect(html.split('<details')[0]).toContain('isolated workspace');
  expect(html.split('<details')[0]).not.toContain('Internal candidate');
  expect(html).toContain(review);expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  const json=renderTaskReply('{"artifactId":"abc","check_receipts":[1]}',ended,(value:string)=>value,run);
  expect(json.split('<details')[0]).not.toContain('artifactId');expect(json).toContain('Technical response');
  expect(taskResultSummary('All tests pass',ended,run)).not.toContain('verified candidate');
  const resumed={...ended,task:'',resumeRunId:'run'};
  expect(taskResultSummary(review,resumed,{...delivered,request:{text:'Research runtime interfaces'}})).toContain('Completed: Research runtime interfaces.');
  expect(taskResultSummary(review,resumed,{...delivered,projectId:'two',request:{text:'Another project brief'}})).not.toContain('Another project brief');
 });
});
