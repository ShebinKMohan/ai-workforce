import { describe, expect, it, vi } from 'vitest';
vi.mock('../../web/headquarters/src/headquarters/settings.js',()=>({getSettings:()=>({sendShortcut:'enter'})}));
vi.mock('../../web/headquarters/src/headquarters/interaction-motion.js',()=>({revealPanel:()=>{},revealTask:()=>{},acknowledgeStatus:()=>{}}));
const path='../../web/headquarters/src/headquarters/chat.js';
const {taskLastChanged,departmentRoutingHint,mergeTaskRun,visibleDetailCandidates,requestDetailKey,requestStatus,createRequestRetry}=await import(path);
const start='2026-09-14T10:00:00Z',later='2026-09-14T10:03:00Z';
const request={id:'one',projectId:'project',runId:'run',state:'running',receivedAt:start,task:'Inspect frontend rendering'};
const run={id:'run',projectId:'project',state:'running',eventCount:2,updatedAt:start};

describe('current task feed projection and bounded detail reads',()=>{
 it('does not count unloaded completed runs as Needs you before the first run snapshot arrives',async()=>{
  const statusPath='../../web/headquarters/src/headquarters/task-status.js';
  const {requestTaskStatus}=await import(statusPath);
  const ended=Array.from({length:8},(_,index)=>({...request,id:`request-${index}`,runId:`run-${index}`,state:'ended',exitCode:0}));
  const loading=ended.map(item=>requestTaskStatus(item,null,[],{runsLoaded:false}));
  expect(loading.every(item=>item.bucket==='loading'&&item.tone==='idle')).toBe(true);
  expect(loading.filter(item=>item.bucket==='waiting')).toHaveLength(0);
  expect(requestStatus(ended[0],null,[],{runsLoaded:false})).toBe('Loading result');
  const ready={...run,id:'run-0',state:'ready_for_review',delivery:{verified:true,evidenceIssues:[],checks:{total:1,passed:1}},headReview:{state:'passed'}};
  expect(requestTaskStatus(ended[0],ready,[],{runsLoaded:false})).toMatchObject({bucket:'done',label:'Verified'});
  expect(requestTaskStatus(ended[1],null,[],{runsLoaded:true})).toMatchObject({bucket:'waiting',label:'Evidence not loaded'});
  expect(requestTaskStatus(ended[0],{...ready,delivery:{...ready.delivery,verified:false}},[],{runsLoaded:true})).toMatchObject({bucket:'waiting',label:'Evidence incomplete'});
  expect(requestTaskStatus({...ended[0],runId:undefined,controlReply:'A direct reply'},null,[],{runsLoaded:false})).toMatchObject({bucket:'done',label:'Answered'});
  expect(requestTaskStatus({...ended[0],state:'failed_to_start'},null,[],{runsLoaded:false}).bucket).toBe('waiting');
 });
 it('shows one current same-run receipt through queued, active, and completed resume states',async()=>{
  const statusPath='../../web/headquarters/src/headquarters/task-status.js';
  const {latestRunRequests,requestTaskStatus}=await import(statusPath);
  const old={...request,state:'ended',exitCode:130,updatedAt:'2026-09-14T11:00:00Z'};
  const resume={...request,id:'resume',kind:'resume',runId:null,resumeRunId:'run',task:null,receivedAt:later};
  const unrelated={...old,id:'other-project',projectId:'other'};
  const unlinked=[{id:'a',projectId:'project'},{id:'b',projectId:'project'}];
  for(const state of ['queued','running','ended']){
   const records=[old,{...resume,state},unrelated,...unlinked];
   expect(latestRunRequests(records).map((item:{id:string})=>item.id)).toEqual(['resume','other-project','a','b']);
   expect(requestTaskStatus(old,run,records)).toMatchObject({bucket:'closed',label:'Continued in newer attempt'});
  }
  expect(latestRunRequests([{...old,id:'z'},old])[0].id).toBe('z');
 });
 it('hydrates a resume from the matched original prompt without retaining or inventing an empty user message',async()=>{
  const {hydrateResumeConversation,compactRequestCard}=await import(path);
  const receipt={...request,id:'resume',kind:'resume',runId:null,resumeRunId:'run',task:null};
  const saved={...run,request:{text:'Research CLI and desktop runtimes\nKeep the full original requirement.'},headReview:{state:'running',headAgentId:'head'},taskViews:[{ownerAgentId:'worker'}]};
  const thread={title:'Recorded conversation',messages:[{id:'empty',role:'user',text:''},{id:'assistant',role:'assistant',requestId:'resume'}]};
  const createId=vi.fn(()=> 'context');
  expect(hydrateResumeConversation(thread,receipt,saved,createId)).toBe(true);
  expect(thread.title).toBe('Research CLI and desktop runtimes');
  expect(thread.messages.map(message=>message.role)).toEqual(['context','assistant']);
  expect(thread.messages[0]?.text).toBe(saved.request.text);
  expect(hydrateResumeConversation(thread,receipt,saved,createId)).toBe(false);expect(createId).toHaveBeenCalledTimes(1);
  const agents=[{id:'head',name:'Andrea'},{id:'worker',name:'Cameron'}];
  const card=compactRequestCard(receipt,{run:saved,facts:{phase:'Report review',active:true,owners:['Andrea'],tasks:[{ownerId:'worker',owner:'Cameron'}]}},agents);
  expect(card.title).toBe('Research CLI and desktop runtimes');expect(card.assignees).toEqual([{id:'head',name:'Andrea'}]);
  const completed=compactRequestCard(receipt,{run:{...saved,headReview:{state:'passed',headAgentId:'head'}},facts:{}},agents);
  expect(completed.assignees).toEqual([{id:'head',name:'Andrea'},{id:'worker',name:'Cameron'}]);
  const foreign:{title:string;messages:Array<{text?:string}>}={title:'Recorded conversation',messages:[]};hydrateResumeConversation(foreign,receipt,{...saved,projectId:'foreign'},()=> 'context');
  expect(foreign.title).toBe('Resumed task');expect(foreign.messages[0]?.text).not.toContain('Research CLI');
 });
 it('orders work by an actual change instead of only its original arrival',()=>{
  const older={...request,receivedAt:'2026-09-14T09:00:00Z',updatedAt:later};
  expect(taskLastChanged(older)).toBeGreaterThan(taskLastChanged(request));
  expect(taskLastChanged(request,run,[{type:'runtime.assistant_message',timestamp:later}])).toBe(Date.parse(later));
  expect(taskLastChanged(request,run,[{type:'runtime.reasoning_delta',timestamp:later}])).toBe(Date.parse(start));
  expect(taskLastChanged({...request,checkedAt:later},run)).toBe(Date.parse(start));
 });
 it('never replaces current summary state with stale or other-project run details',()=>{
  const detail={run:{...run,state:'failed'},eventCount:1,taskViews:[{id:'stale'}]};
  expect(mergeTaskRun(request,run,detail)).toEqual(run);
  expect(mergeTaskRun(request,null,{...detail,run:{...detail.run,projectId:'other'}})).toBeNull();
  const fresh={run,eventCount:2,taskViews:[{id:'actual',attempt:{startedAt:start}}]};
  expect(mergeTaskRun(request,run,fresh).taskViews).toEqual(fresh.taskViews);
  expect(mergeTaskRun({...request,runId:undefined,resumeRunId:'run'},run,fresh).taskViews).toEqual(fresh.taskViews);
 });
 it('keeps fresh delivery evidence authoritative over cached detail with the same event cursor',()=>{
  const snapshot={...run,state:'ready_for_review',delivery:{verified:false,reason:'Artifact changed',evidenceIssues:['Artifact changed']}};
  const oldDetail={run:{...run,state:'ready_for_review'},eventCount:2,delivery:{verified:true,evidenceIssues:[]},taskViews:[{id:'task',state:'accepted'}]};
  expect(mergeTaskRun(request,snapshot,oldDetail)).toEqual(snapshot);
  expect(mergeTaskRun(request,snapshot,oldDetail).delivery.verified).toBe(false);
 });
 it('fetches only a bounded set of visible active cards and excludes historical feed records',()=>{
  const rows=Array.from({length:12},(_,i)=>({...request,id:`r${i}`}));
  rows.push({...request,id:'historical',state:'ended'});
  const result=visibleDetailCandidates({requests:rows,visibleIds:['historical','r7','r8','r9','r10'],limit:3});
  expect(result.map((item:{id:string})=>item.id)).toEqual(['r7','r8','r9']);
  expect(visibleDetailCandidates({requests:rows,visibleIds:['r7'],hidden:true})).toEqual([]);
 });
 it('hydrates explicitly opened history once and rereads only when a durable version changes',()=>{
  const ended={...request,state:'ended'};
  const cache=new Map();
  expect(visibleDetailCandidates({requests:[ended],visibleIds:['one'],paneMode:'conversation',cache,runFor:()=>run})).toHaveLength(1);
  cache.set('one',{version:requestDetailKey(ended,run)});
  expect(visibleDetailCandidates({requests:[ended],visibleIds:['one'],paneMode:'conversation',cache,runFor:()=>run})).toEqual([]);
  expect(visibleDetailCandidates({requests:[{...ended,recovery:{canRetry:true}}],visibleIds:['one'],paneMode:'conversation',cache,runFor:()=>run})).toHaveLength(1);
  expect(visibleDetailCandidates({requests:[ended],visibleIds:[],paneMode:'conversation',cache})).toEqual([]);
 });
 it('keeps pending event pagination visible without expanding the request read budget',()=>{
  const cache=new Map([['one',{version:requestDetailKey(request,run),hasMore:true}]]);
  expect(visibleDetailCandidates({requests:[request],visibleIds:['one','one'],cache,runFor:()=>run})).toHaveLength(1);
 });
 it('defaults to automatic routing and presents a semantic guess only as a hint',()=>{
  const departments=[{id:'ui',name:'Frontend',capabilities:['frontend','design','accessibility']},{id:'api',name:'Backend',capabilities:['backend','database','api']}];
  expect(departmentRoutingHint('Improve frontend accessibility',departments)).toMatchObject({departmentId:'ui',text:expect.stringContaining('Likely Frontend')});
  expect(departmentRoutingHint('Improve frontend accessibility',departments).text).toContain('confirms when you send');
  expect(departmentRoutingHint('Please inspect this project',departments).departmentId).toBeNull();
  expect(departmentRoutingHint('Improve frontend and backend',departments).departmentId).toBeNull();
  expect(departmentRoutingHint('Improve frontend',departments,'api')).toEqual({departmentId:'api',text:'Backend will handle this request.'});
  expect(departmentRoutingHint('Improve frontend',[{...departments[0],archived:true}]).departmentId).toBeNull();
 });
 it('never announces completed project work from exit zero alone',()=>{
  const ended={...request,state:'ended',exitCode:0};
  expect(requestStatus(ended)).toBe('Evidence not loaded');
  expect(requestStatus(ended,run)).toBe('Evidence incomplete');
  expect(requestStatus({...ended,runId:undefined,resumeRunId:'run'},run)).toBe('Evidence incomplete');
  expect(requestStatus({...ended,runId:undefined,controlReply:'Here is an answer'})).toBe('Answered');
 });
});

describe('explicit request retry',()=>{
 it('posts only the saved request id and a stable idempotency identity after an uncertain response',async()=>{
  const api=vi.fn().mockRejectedValueOnce(Error('connection interrupted')).mockResolvedValueOnce({request:{id:'successor'}});
  const createId=vi.fn(()=> 'retry-identity');
  const retry=createRequestRetry({api,createId});
  const failed={...request,state:'failed_to_start',recovery:{canRetry:true}};
  await expect(retry(failed)).rejects.toThrow('connection interrupted');
  await expect(retry(failed)).resolves.toEqual({request:{id:'successor'}});
  expect(createId).toHaveBeenCalledTimes(1);
  expect(api.mock.calls).toEqual([['/api/requests/one/retry',{clientRequestId:'retry-identity'}],['/api/requests/one/retry',{clientRequestId:'retry-identity'}]]);
 });
 it('coalesces concurrent clicks and refuses an unavailable recovery action',async()=>{
  let resolve:(value:unknown)=>void=()=>{};
  const api=vi.fn(()=>new Promise(done=>{resolve=done;}));
  const retry=createRequestRetry({api,createId:()=> 'id'}),failed={...request,recovery:{canRetry:true}};
  const first=retry(failed),second=retry(failed);expect(first).toBe(second);expect(api).toHaveBeenCalledTimes(1);
  resolve({request:{id:'next'}});await first;
  await expect(retry({...failed,recovery:{canRetry:false}})).rejects.toThrow('not ready to retry');expect(api).toHaveBeenCalledTimes(1);
 });
});

describe('specific recovery controls and result files',()=>{
 it('renders the owned runtime stop as a distinct non-submit button while preserving its exact action',async()=>{
  const {renderRequestActionButton,requestControlEndpoint}=await import(path);
  const railPath='../../web/headquarters/src/headquarters/task-rail.js';
  const {taskAttention}=await import(railPath);
  const running={...request,pid:42};
  const action=taskAttention(running,run).actions[0];
  expect(action).toEqual({kind:'cancel',label:'Stop work'});
  const markup=renderRequestActionButton(running,action);
  expect(markup).toContain('type="button"');expect(markup).not.toContain('type="submit"');
  expect(markup).toContain('cc-stop-work');expect(markup).toContain('<svg class="icon" aria-hidden="true"');
  expect(markup).toContain('data-request-action="cancel" data-action-request="one"');expect(markup).toContain('<span>Stop work</span>');
  expect(requestControlEndpoint(running,action.kind)).toBe('/api/requests/one/stop');
  const stopping=renderRequestActionButton(running,action,true);
  expect(stopping).toContain(' disabled aria-busy="true"');expect(stopping).toContain('Stopping…');
  expect(taskAttention({...running,stopRequestedAt:later},run).actions).toEqual([]);
  expect(taskAttention({...running,pid:null},run).actions).toEqual([]);
 });
 it('keeps queued cancellation and saved resume controls distinct from runtime Stop work',async()=>{
  const {renderRequestActionButton,requestControlEndpoint}=await import(path);
  const queued={...request,state:'queued'};
  const cancellation=renderRequestActionButton(queued,{kind:'cancel',label:'Cancel request'});
  expect(cancellation).not.toContain('cc-stop-work');expect(cancellation).toContain('Cancel request');
  expect(requestControlEndpoint(queued,'cancel')).toBe('/api/requests/one/discard');
  const resume=renderRequestActionButton({...request,state:'ended'},{kind:'resume',label:'Resume'});
  expect(resume).toContain('data-request-action="resume"');expect(resume).not.toContain('cc-stop-work');
 });
 it('opens the saved run Resume endpoint only for an evidenced final-review failure',async()=>{
  const {requestControlEndpoint}=await import(path);
  const ended={...request,state:'ended',exitCode:130,result:{code:'interrupted'},stopRequestedAt:null,signal:null,recovery:{canRetry:false}};
  const interrupted={...run,state:'interrupted',headReview:{state:'blocked',sessionStopped:true,interrupted:false,summary:'The head did not submit a structured review decision.'}};
  expect(requestStatus(ended,interrupted)).toBe('Review needs retry');
  expect(requestControlEndpoint(ended,'resume',interrupted)).toBe('/api/projects/project/runs/run/resume');
  expect(requestControlEndpoint({...ended,runId:undefined,resumeRunId:'run'},'resume',interrupted)).toBe('/api/projects/project/runs/run/resume');
  for(const item of [{...ended,stopRequestedAt:later},{...ended,signal:'SIGINT'},{...ended,state:'running'},{...ended,recovery:{nextRequestId:'successor'}}])expect(requestControlEndpoint(item,'resume',interrupted)).toBeNull();
  expect(requestControlEndpoint(ended,'resume',{...interrupted,projectId:'foreign'})).toBeNull();
  expect(requestControlEndpoint(ended,'resume')).toBeNull();
  expect(requestStatus({...ended,stopRequestedAt:later},interrupted)).toBe('Stopped');
 });
 it('cancels queued and held work through discard, stops only an owned running process, and starts only held work',async()=>{
  const {requestControlEndpoint}=await import(path);
  expect(requestControlEndpoint({...request,state:'queued'},'cancel')).toBe('/api/requests/one/discard');
  expect(requestControlEndpoint({...request,state:'held'},'cancel')).toBe('/api/requests/one/discard');
  expect(requestControlEndpoint({...request,pid:42},'cancel')).toBe('/api/requests/one/stop');
  expect(requestControlEndpoint({...request,pid:null},'cancel')).toBeNull();
  expect(requestControlEndpoint({...request,pid:42,stopRequestedAt:later},'cancel')).toBeNull();
  expect(requestControlEndpoint({...request,state:'held'},'start')).toBe('/api/requests/one/start');
  expect(requestControlEndpoint({...request,state:'ended'},'start')).toBeNull();
 });
 it('keeps internal JSON and check/review receipts out of deliverables without losing diagnostics',async()=>{
  const {taskArtifactGroups}=await import(path);
  const artifacts=[{id:'report',type:'analysis_report',path:'report.md'},{id:'patch',type:'candidate_patch',path:'candidate.patch'},{id:'summary',type:'summary',path:'summary.md'},{id:'jsonsummary',type:'summary',path:'summary.json'},{id:'review',type:'head_review_result',path:'review.json'},{id:'check',type:'check_receipt',path:'check.json'},{id:'result',type:'result',path:'result.json'}];
  const groups=taskArtifactGroups(artifacts);
  expect(groups.deliverables.map((a:{id:string})=>a.id)).toEqual(['report','patch','summary']);
  expect(groups.technical.map((a:{id:string})=>a.id)).toEqual(['jsonsummary','review','check','result']);
 });
 it('launches only a freshly allowed provider sign-in, never a duplicate pending sign-in or model request',async()=>{
  const {startRequestSignIn}=await import(path);
  const runtimes={installed:{adapter:'codex'}},item={...request,controlCenter:{runtime:'installed'}};
  const api=vi.fn().mockResolvedValueOnce({client:{authentication:{state:'needs_auth',canSignIn:true}}}).mockResolvedValueOnce({client:{authentication:{state:'pending'}}});
  expect(await startRequestSignIn({request:item,runtimes,api})).toMatchObject({started:true});
  expect(api.mock.calls).toEqual([['/api/connections/codex/auth'],['/api/connections/codex/sign-in',{}]]);
  const pending=vi.fn().mockResolvedValue({client:{authentication:{state:'pending',canSignIn:false}}});
  expect(await startRequestSignIn({request:item,runtimes,api:pending})).toMatchObject({started:false});expect(pending).toHaveBeenCalledTimes(1);
  const signedIn=vi.fn().mockResolvedValue({client:{authentication:{state:'connected',canSignIn:false}}});
  expect((await startRequestSignIn({request:item,runtimes,api:signedIn})).message).toContain('signed in');expect(signedIn).toHaveBeenCalledTimes(1);
 });
});

describe('compact Task Status cards',()=>{
 it('shows only the task reference and opens the full saved conversation with one button',async()=>{
  const {compactRequestCard,renderCompactRequestCard}=await import(path);
  const item={...request,task:'Fix checkout accessibility\nPreserve this full detailed brief.',controlReply:'Long technical review output.',recovery:{canRetry:true},attachments:[{name:'internal.json'}]};
  const presentation={fact:{bucket:'waiting',label:'Needs you'},facts:{project:'Storefront',department:'Frontend and Design',phase:'Verification',action:'A long blocker reason that belongs in the conversation.',owners:['Department Head'],tasks:[{ownerId:'worker',owner:'Kara Foster'}],requestDuration:{start,end:later,active:false,label:'Request time'},phaseDuration:{start,end:later,active:false,label:'Review time'}}};
  const card=compactRequestCard(item,presentation),html=renderCompactRequestCard(card);
  expect(card).toMatchObject({title:'Fix checkout accessibility',project:'Storefront',assignees:[{id:'worker',name:'Kara Foster'}]});
  expect(html).toContain('data-feed-request="one"');expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain('Storefront');expect(html).toContain('Kara Foster');expect(html).toContain('3m 00s');
  for(const omitted of ['cc-task-preview','cc-task-reason','cc-task-owner','cc-request-recovery','data-request-retry','<time','Frontend and Design','Long technical review output.','A long blocker reason','internal.json','Review time','Preserve this full detailed brief.'])expect(html).not.toContain(omitted);
  expect(html).toContain('title="Needs you"');expect(item.task).toContain('Preserve this full detailed brief.');
 });
 it('keeps clocks and recorded assignees honest without rerendering for hidden activity or diagnostic changes',async()=>{
  const {compactRequestCard,renderCompactRequestCard}=await import(path);
  const data={fact:{bucket:'progress',label:'Working'},facts:{project:'Storefront',owners:['Mike Slattery'],tasks:[{ownerId:'ui',owner:'Kara Foster'},{ownerId:'ui',owner:'Kara Foster'},{ownerId:'api',owner:'Alisha Granderson'}],requestDuration:{start,active:true},action:'First tool call'}};
  const card=compactRequestCard(request,data);
  expect(card.assignees.map((owner:{name:string})=>owner.name)).toEqual(['Kara Foster','Alisha Granderson']);
  expect(compactRequestCard({...request,controlReply:'New diagnostic',updatedAt:later},{...data,changedAt:Date.parse(later),facts:{...data.facts,action:'Second tool call'}})).toEqual(card);
  expect(renderCompactRequestCard(card)).toContain('data-duration-active="true"');
  const ended=compactRequestCard({...request,state:'ended'},{...data,facts:{...data.facts,requestDuration:{start,end:later,active:false}}});
  expect(renderCompactRequestCard(ended)).toContain('data-duration-active="false"');expect(renderCompactRequestCard(ended)).toContain('3m 00s');
  const unknown=compactRequestCard(request,{facts:{project:'Storefront',owners:[],tasks:[],requestDuration:{start:null,active:false}}});
  expect(renderCompactRequestCard(unknown)).toContain('Not assigned yet');expect(renderCompactRequestCard(unknown)).toContain('>—</span>');
 });
});

describe('compact card owner identity',()=>{
 it('credits the configured Control Center for a direct reply without inventing a worker assignment',async()=>{
  const {compactRequestCard}=await import(path);
  const direct={...request,runId:undefined,state:'ended',exitCode:0,route:{outcome:'direct_reply'},controlReply:'Here is your answer.'};
  const presentation={facts:{owners:[],tasks:[]},fact:{bucket:'done',label:'Answered'}};
  expect(compactRequestCard(direct,presentation,[],{name:'Tom Chandler'}).assignees).toEqual([{id:'control-center',name:'Tom Chandler'}]);
  expect(compactRequestCard(direct,presentation,[],{name:'Custom Coordinator'}).assignees).toEqual([{id:'control-center',name:'Custom Coordinator'}]);
  expect(compactRequestCard({...request,runId:undefined},{facts:{owners:['Control Center']},fact:{bucket:'progress',label:'Routing'}},[],{name:'Tom Chandler'}).assignees).toEqual([{id:'control-center',name:'Tom Chandler'}]);
 });
 it('uses completed workers from a matching run summary without requesting detail or borrowing another project',async()=>{
  const {compactRequestCard}=await import(path);
  const agents=[{id:'worker',name:'Will Mason'},{id:'old',name:'Old worker'}];
  const summary={...run,state:'ready_for_review',taskViews:[{id:'current',state:'accepted',ownerAgentId:'worker'},{id:'prior',state:'superseded',ownerAgentId:'old'}]};
  const presentation={run:summary,facts:{tasks:[],owners:[]},fact:{bucket:'done',label:'Verified'}};
  expect(compactRequestCard({...request,state:'ended'},presentation,agents).assignees).toEqual([{id:'worker',name:'Will Mason'}]);
  expect(compactRequestCard({...request,state:'ended'},{...presentation,run:{...summary,projectId:'other'}},agents).assignees).toEqual([]);
  expect(compactRequestCard({...request,runId:undefined,resumeRunId:'run',state:'ended'},presentation,agents).assignees).toEqual([{id:'worker',name:'Will Mason'}]);
 });
});
