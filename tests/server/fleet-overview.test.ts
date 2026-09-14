import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const path = '../../web/headquarters/src/headquarters/live-overview.js';
const { deriveOverviewWorkload, deriveFleetAgentState, deriveFleetAgentView, deriveFleetTeams, deriveFleetOperations, deriveFleetMetrics, deriveAgentPhaseTiming, overviewStructureSignature, wireOverview, renderOverview } = await import(path);
const agents = [{id:'head',name:'Slattery',departmentId:'eng',isHead:true},{id:'worker',name:'Kara',departmentId:'eng',instructions:'ROLE: FRONTEND & UI ENGINEER'}];
const context = {agents,departments:[{id:'eng',name:'Engineering',headAgentId:'head'}],requests:[{id:'req',projectId:'p',runId:'run',state:'running',task:'Fix search'}],runs:[{id:'run',projectId:'p',state:'running',taskViews:[{id:'task',state:'running',ownerAgentId:'worker',objective:'Repair keyboard search'}]}]};
describe('fleet overview status consistency',()=>{
 it('derives working, available, authentication and distinct active-project counts from current agents',()=>{
  const data={...context,agents:[...agents,{id:'signed-out',departmentId:'eng',runtime:'signed-out-runtime'},{id:'missing',departmentId:'eng',runtime:'missing-runtime'},{id:'archived',departmentId:'eng',archived:true}],runtimeReadiness:{reports:[{runtimeId:'signed-out-runtime',auth:'logged_out',usable:false},{runtimeId:'missing-runtime',installed:false,usable:false}]},requests:[...context.requests,{...context.requests[0],id:'second',runId:'second-run'}],runs:[...context.runs,{...context.runs[0],id:'second-run',taskViews:[],headPlanning:{state:'running',headAgentId:'head'}}]};
  expect(deriveFleetMetrics(data)).toEqual({working:2,available:0,reserved:0,needsAuth:1,activeProjects:1});
  expect(deriveFleetMetrics({agents,departments:context.departments})).toEqual({working:0,available:2,reserved:0,needsAuth:0,activeProjects:0});
  expect(deriveFleetMetrics()).toEqual({working:0,available:0,reserved:0,needsAuth:0,activeProjects:0});
 });
 it('shows unknown live counts after disconnect instead of reporting everyone idle or no active projects',()=>{
  const data={...context,connected:false};
  expect(deriveFleetMetrics(data)).toEqual({working:null,available:null,reserved:null,needsAuth:null,activeProjects:null});
  const metrics=renderOverview(data).match(/<dl class="fleet-metrics"[\s\S]*?<\/dl>/)?.[0];
  expect(metrics).toContain('connection lost');
  expect(metrics?.match(/<dd>—<\/dd>/g)).toHaveLength(4);
 });
 it('accounts for reserved agents separately until their actual work starts',()=>{
  const data={...context,runs:[],requests:[{...context.requests[0],state:'starting',admissionReady:true,workerIds:['worker']}]};
  expect(deriveFleetMetrics(data)).toMatchObject({working:0,available:1,reserved:1});
  expect(renderOverview(data)).toContain('<dt>Reserved</dt><dd>1</dd>');
  expect(deriveFleetMetrics(context)).toMatchObject({working:1,available:1,reserved:0});
  expect(renderOverview(context)).not.toContain('data-fleet-metric="reserved"');
 });
 it('shows only the actual worker as busy, with a useful task summary',()=>{
  expect(deriveFleetAgentState(agents[1],context)).toMatchObject({bucket:'progress',title:'Repair keyboard search'});
  expect(deriveFleetAgentState(agents[0],context)).toMatchObject({bucket:'idle'});
 });
 it('clears stale running tasks and stale head reviews when the request stops',()=>{
  const data={...context,requests:[{...context.requests[0],state:'cancelled'}],runs:[{...context.runs[0],headReview:{state:'running',headAgentId:'head'}}]};
  expect(deriveOverviewWorkload(data).counts.progress).toBe(0);
  for(const agent of agents)expect(deriveFleetAgentState(agent,data).bucket).toBe('idle');
 });
 it('keeps a different active request visible after an older request stops',()=>{
  const data={...context,requests:[{...context.requests[0],id:'old',runId:'old-run',state:'cancelled'},...context.requests],runs:[{...context.runs[0],id:'old-run'},...context.runs]};
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({bucket:'progress',runId:'run'});
 });
 it('uses the latest request when a failed request is resumed on the same run',()=>{
  const original={...context.requests[0],state:'ended',exitCode:1,updatedAt:'2026-09-13T10:00:00Z'};
  const resumed={id:'resume',projectId:'p',resumeRunId:'run',state:'running',task:'Resume search repair',updatedAt:'2026-09-13T10:01:00Z'};
  expect(deriveFleetAgentState(agents[1],{...context,requests:[original,resumed]})).toMatchObject({bucket:'progress',label:'Working'});
 });
 it('shows paused work as waiting and disconnects as unknown',()=>{
  expect(deriveFleetAgentState(agents[1],{...context,requests:[{...context.requests[0],state:'held'}]})).toMatchObject({bucket:'waiting',label:'Paused'});
  expect(deriveFleetAgentState(agents[1],{...context,connected:false})).toMatchObject({bucket:'unknown',label:'Connection lost'});
 });
 it('does not invent agents, activities or passed stages for an empty workspace',()=>{
  const html=renderOverview();
  expect(html).toContain('0 agents');expect(html).toContain('Add a team to start handling project requests.');
  expect(html).not.toContain('Ready for your next request');
  expect(html).not.toContain('aria-current="step"');
 });
 it('escapes user names and task text and includes the whole configured fleet',()=>{
  const data={...context,agents:Array.from({length:72},(_,i)=>({id:`agent-${i}`,departmentId:'eng',name:`Agent <${i}>`})),requests:[{...context.requests[0],task:'<script>bad()</script>'}]};
  const html=renderOverview(data);
  expect((html.match(/class="fleet-agent"/g)||[]).length).toBe(72);
  expect(html).toContain('Agent &lt;71&gt;');expect(html).not.toContain('<script>');
 });
});

describe('multi-project headquarters', () => {
 const parallel = {
  ...context,
  projects: [{ id:'p', name:'Storefront' }, { id:'api', name:'Inventory API' }],
  agents: [...agents, { id:'backend', name:'Alisha', departmentId:'eng', instructions:'ROLE: BACKEND & API ENGINEER' }],
  requests: [...context.requests, { id:'api-request', projectId:'api', runId:'run', state:'running', task:'Add inventory search', startedAt:'2026-09-13T10:00:00Z' }],
  runs: [...context.runs, { id:'run', projectId:'api', state:'running', taskViews:[{ id:'task', ownerAgentId:'backend', state:'running', objective:'Implement inventory endpoint', attempt:{ startedAt:'2026-09-13T10:00:01Z' } }] }],
  eventPages: [{ projectId:'p', runId:'run', events:[{ sequence:10, taskId:'task', type:'runtime.command_exec', timestamp:'2026-09-13T10:01:00Z', payload:{ command:'npm test', phase:'started' } }] }, { projectId:'api', runId:'run', events:[{ sequence:11, taskId:'task', type:'runtime.assistant_message', timestamp:'2026-09-13T10:02:00Z', payload:{ text:'Inspecting endpoint pagination' } }] }],
 };
 it('shows simultaneous projects and exact task owners in the first view', () => {
  const html = renderOverview(parallel);
  expect(html).toContain('2 running requests across 2 projects');
  for (const text of ['Storefront','Inventory API','Repair keyboard search','Implement inventory endpoint','Kara','Alisha','Running a command','Agent update received']) expect(html).toContain(text);
  expect(html).not.toContain('Work in focus');
  expect(html).not.toContain('Follow a request');
  expect((html.match(/data-fleet-operation /g) || []).length).toBe(2);
 });
 it('keeps action text scoped to both project and run even with colliding IDs', () => {
  const operations = deriveFleetOperations(parallel);
  const storefront = operations.find((item: { projectId: string }) => item.projectId === 'p');
  const api = operations.find((item: { projectId: string }) => item.projectId === 'api');
  expect(storefront.tasks[0]).toMatchObject({ ownerId:'worker', activity:'Running a command' });
  expect(api.tasks[0]).toMatchObject({ ownerId:'backend', activity:'Agent update received' });
 });
 it('shows only the newest request for a resumed run, retaining the actual task', () => {
  const data = { ...context, requests:[{ ...context.requests[0], state:'ended', updatedAt:'2026-09-13T10:00:00Z' }, { id:'resume', projectId:'p', resumeRunId:'run', state:'running', task:'Continue repairing search', updatedAt:'2026-09-13T10:01:00Z' }] };
  const operations = deriveFleetOperations(data);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ requestId:'resume', active:true, title:'Continue repairing search' });
  expect(operations[0].tasks[0].title).toBe('Repair keyboard search');
 });
 it('renders the configured coordinator as a neutral avatar row', () => {
  const html = renderOverview({ ...context, controlCenter:{ id:'control-center', name:'Tom Chandler' } });
  expect(html).toContain('Tom Chandler');
  expect(html).toContain('Control Center · Intake &amp; coordination');
  expect(html).toContain('data-lo-node="agent:control-center"');
  expect(html).not.toContain('fleet-command');
  expect((html.match(/class="fleet-agent"/g) || []).length).toBe(3);
 });
 it('keeps available agents to identity, specialty and availability in a single inspect control', () => {
  const html = renderOverview({ agents, departments:context.departments });
  const rows = html.match(/<button type="button" class="fleet-agent"[\s\S]*?<\/button>/g) || [];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
   expect(row).toContain('data-lo-action="agent"');
   expect(row).toContain('data-fleet-department-id="eng"');
   // The app's delegated click handler treats data-department as a settings action.
   expect(row).not.toContain('data-department=');
   expect(row).toContain('data-has-work="false"');
   expect(row).toContain('Available');
   expect(row).toContain('width:44px;height:44px');
   expect(row).toContain('<span class="fleet-agent-work"></span>');
   expect(row).not.toMatch(/No active assignment|Selected by capability|Available for the next|fleet-agent-footer/);
  }
  expect(rows[1]).toContain('Kara');
  expect(rows[1]).toContain('Frontend &amp; UI Engineer');
 });
 it('shows a short work objective while preserving the complete task for inspection', () => {
  const objective = 'Inspect the harness and explain how requests become results. Distinguish implementation from claims.\nScope: serve.mjs and every file.\nReport requirements: an extensive source map.';
  const data = { ...context, runs:[{ ...context.runs[0],taskViews:[{ ...context.runs[0]!.taskViews[0],objective }] }] };
  const html = renderOverview(data);
  const visibleText = html.replace(/<[^>]*>/g, '');
  expect(visibleText).toContain('Inspect the harness and explain how requests become results.');
  expect(visibleText).not.toMatch(/Distinguish implementation|Scope:|Report requirements:/);
  expect(deriveFleetOperations(data)[0].tasks[0].title).toBe(objective);
  expect(html).toContain('data-lo-action="request"');
  expect(html).toContain('data-lo-action="agent"');
 });
 it('keeps command text in diagnostics and summarizes the latest action in plain language', () => {
  const event = { taskId:'task',type:'runtime.command_exec',timestamp:'2026-09-13T10:04:00Z',payload:{ phase:'completed',exitCode:0,command:'/bin/zsh -lc "nl -ba onboard.mjs; nl -ba src/tasks.js"' } };
  const data = { ...context,eventPages:[{ projectId:'p',runId:'run',events:[event] }] };
  expect(deriveFleetOperations(data)[0].tasks[0].activity).toBe('Finished a command');
  expect(renderOverview(data)).toContain('Finished a command');
  expect(renderOverview(data)).not.toContain('onboard.mjs');
  const failed = { ...data,eventPages:[{ ...data.eventPages[0],events:[{ ...event,payload:{ ...event.payload,exitCode:1 } }] }] };
  expect(deriveFleetOperations(failed)[0].tasks[0].activity).toBe('Finished a command');
 });
 it('separates a reserved worker from working or available', () => {
  const data = { ...context, runs:[], requests:[{ ...context.requests[0], state:'starting', admissionReady:true, workerIds:['worker'] }] };
  expect(deriveFleetAgentState(agents[1], data)).toMatchObject({ bucket:'backlog', label:'Reserved', projectId:'p' });
  expect(deriveFleetAgentState(agents[0], data)).toMatchObject({ bucket:'idle', label:'Available' });
  expect(deriveFleetAgentState(agents[1], { ...data, requests:[{ ...data.requests[0], state:'ended' }] })).toMatchObject({ bucket:'idle' });
 });
 it('displays all current assignments when one agent has recorded work across projects', () => {
  const data = { ...parallel, runs:parallel.runs.map(run => run.projectId === 'api' ? { ...run, taskViews:run.taskViews.map(task => ({ ...task, ownerAgentId:'worker' })) } : run) };
  const html = renderOverview(data);
  const kara = html.slice(html.indexOf('data-lo-node="agent:worker"'), html.indexOf('data-lo-node="agent:backend"'));
  expect(kara).toContain('Storefront');
  expect(kara).toContain('Inventory API');
  expect(kara).toContain('2 assignments');
 });
 it('does not print raw or reasoning output as activity', () => {
  const operations = deriveFleetOperations({ ...parallel, eventPages:[{ projectId:'p',runId:'run',events:[{ taskId:'task', type:'runtime.raw', timestamp:'2026-09-13T10:02:00Z', payload:{ text:'private raw payload' } }, { taskId:'task', type:'runtime.reasoning', timestamp:'2026-09-13T10:03:00Z', payload:{ text:'private reasoning' } }] }] });
  const current = operations.find((item: { projectId:string }) => item.projectId === 'p');
  expect(current.activity).toBe('');
  expect(current.tasks[0].activity).toBe('');
 });
 it('ignores normalized raw and reasoning labels from the live stream and last-event fallback', () => {
  const hiddenEvents = ['runtime.raw','runtime.reasoning','runtime.reasoning_delta','head.runtime.raw'].map((type, index) => ({ type,projectId:'p',runId:'run',taskId:'task',at:`2026-09-13T10:0${index}:00Z`,label:`private ${type}` }));
  const data = { ...context,events:hiddenEvents,runs:[{ ...context.runs[0],taskViews:[{ ...context.runs[0]!.taskViews[0],lastEvent:hiddenEvents[0] }] }] };
  expect(deriveFleetOperations(data)[0].activity).toBe('');
  expect(deriveFleetOperations(data)[0].tasks[0].activity).toBe('');
  expect(renderOverview(data)).not.toContain('private runtime');
  expect(renderOverview(data)).not.toContain('private head.runtime');
 });
 it('keeps classifier explanations out of normal work while retaining a real blocker', () => {
  const selected = { ...context,requests:[{ ...context.requests[0],route:{ state:'selected',departmentId:'eng',reason:'This requires engineering because the task concerns the source code.' } }] };
  expect(deriveFleetOperations(selected)[0].reason).toBe('');
  expect(renderOverview(selected)).not.toContain('fleet-operation-reason');
  const blocked = { ...selected,requests:[{ ...selected.requests[0],state:'failed_to_start',route:{ state:'blocked',departmentId:'eng',reason:'The project folder is no longer available.' } }] };
  expect(deriveFleetOperations(blocked)[0].reason).toBe('The project folder is no longer available.');
  expect(renderOverview(blocked)).not.toContain('Last request');
  const held = { ...blocked,requests:[{ ...blocked.requests[0],state:'held' }] };
  expect(renderOverview(held)).toContain('The project folder is no longer available.');
 });
 it('shows a plain agent-update label and keeps its full source event untouched for diagnostics', () => {
  const text = '## Findings\n\n**Tracing** [request routing](https://example.invalid/source) in `serve.mjs`. The remaining explanation belongs in the inspector.\n- More details';
  const event = { type:'runtime.assistant_message',taskId:'task',timestamp:'2026-09-13T10:00:00Z',payload:{ text } };
  const data = { ...context,eventPages:[{ projectId:'p',runId:'run',events:[event] }] };
  const operation = deriveFleetOperations(data)[0];
  expect(operation.activity).toBe('Agent update received');
  expect(operation.tasks[0].activity).toBe(operation.activity);
  expect(renderOverview(data)).not.toContain('remaining explanation belongs');
  expect(event.payload.text).toBe(text);
  const long = { ...event,payload:{ text:'Inspecting ' + 'the request routing implementation '.repeat(20) } };
  expect(deriveFleetOperations({ ...data,eventPages:[{ ...data.eventPages[0],events:[long] }] })[0].activity.length).toBeLessThanOrEqual(140);
 });
 it('never renders a history section or handoff feed even when records contain both', () => {
  const event = { projectId:'p',runId:'run',taskId:'task',cursor:1,type:'head.assigned',timestamp:'2026-09-13T10:00:00Z',payload:{ headAgentId:'head',agentId:'worker' } };
  const html = renderOverview({ ...context,events:[event] });
  expect(html).not.toMatch(/fleet-recent|fleet-handoff|Recent work|recorded handoff|Requests &amp; results/);
  for (const text of ['Fix search','Repair keyboard search','Engineering','Slattery','Kara']) expect(html).toContain(text);
 });
 it('escapes project names, activity and task text without manufacturing completion', () => {
  const html = renderOverview({ ...context, projects:[{ id:'p', name:'<img onerror="bad()">' }], eventPages:[{ projectId:'p',runId:'run',events:[{ type:'runtime.assistant_message', taskId:'task', timestamp:'2026-09-13T10:01:00Z', payload:{ text:'<script>done()</script> all checks passed' } }] }] });
  expect(html).toContain('&lt;img onerror=&quot;bad()&quot;&gt;');
  expect(html).toContain('Agent update received');
  expect(html).not.toContain('all checks passed');
  expect(html).not.toContain('<script>');
  expect(html).toContain('0 of 1 tasks checked');
  expect(html).not.toContain('Verified');
 });
 it('requires the reviewed analysis evidence projection before completion', () => {
  const data = { ...context, requests:[{ ...context.requests[0], state:'ended' }], runs:[{ ...context.runs[0], state:'ready_for_review', workKind:'analysis', analysis:{ reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[] } }] };
  expect(deriveFleetOperations(data)[0]).toMatchObject({ status:'Reviewed analysis', bucket:'done' });
  expect(deriveFleetOperations({ ...data, runs:[{ ...data.runs[0], analysis:{ ...data.runs[0]!.analysis,evidenceIssues:['Report missing'] } }] })[0]).toMatchObject({ status:'Analysis evidence incomplete', bucket:'waiting' });
 });
 it('uses compact numerical metrics without the prose banner or result history', () => {
  const data = { ...context, requests:[{ ...context.requests[0],state:'ended' }],runs:[{ ...context.runs[0],state:'ready_for_review',workKind:'analysis',analysis:{ reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[] } }] };
  const html = renderOverview(data);
  const metrics = html.match(/<dl class="fleet-metrics"[\s\S]*?<\/dl>/)?.[0];
  expect(metrics).toContain('<dt>Available</dt><dd>2</dd>');
  expect(metrics).toContain('<dt>Working</dt><dd>0</dd>');
  expect(metrics).toContain('<dt>Needs sign-in</dt><dd>0</dd>');
  expect(metrics).toContain('<dt>Active projects</dt><dd>0</dd>');
  expect(html).not.toMatch(/Ready for your next request|Team selected automatically|fleet-status-strip/);
  expect(metrics).not.toMatch(/fleet-last-result|Latest result|Last request|Fix search/);
  expect(html).not.toMatch(/fleet-work-empty|Include history|deck-status-grid|fleet-global-filters|fleet-recent/);
 });
 it('omits a previous setup failure from Headquarters while preserving its recorded boundaries', () => {
  const data = { ...context, runs:[], requests:[{ id:'old',projectId:'p',state:'failed_to_start',task:'Read the codebase',reason:'no_worker: no worker is placed on this project; run workforce assign worker project',route:{state:'blocked',departmentId:'eng'},receivedAt:'2026-09-13T10:00:00Z',endedAt:'2026-09-13T10:00:02Z' }] };
  const operation = deriveFleetOperations(data)[0];
  expect(operation).toMatchObject({ status:'No work started',bucket:'closed',active:false,waiting:false,stage:null,endedAt:'2026-09-13T10:00:02Z' });
  expect(operation.reason).not.toContain('workforce assign');
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({ label:'Available' });
  const html = renderOverview(data);
  expect(html).toContain('0 running requests');
  expect(html).not.toContain('Last request');
  expect(html).not.toContain('data-lo-id="old"');
  expect(html).not.toContain('data-fleet-operation ');
  expect(html).not.toContain('No work started</span></div><p');
 });
 it('does not label a terminal failed worker as waiting for the user', () => {
  const data = { ...context, requests:[{ ...context.requests[0],state:'ended',exitCode:4 }],runs:[{ ...context.runs[0],state:'failed',taskViews:[{ ...context.runs[0]!.taskViews[0],state:'failed' }] }] };
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({ label:'Available' });
  expect(deriveFleetOperations(data)[0]).toMatchObject({ bucket:'closed',status:'Run failed' });
 });
 it('groups five configured departments and explicit job titles without inventing an active fleet', () => {
  const departments=Array.from({length:5},(_,index)=>({id:`dept-${index}`,name:`Department ${index}`,headAgentId:`head-${index}`}));
  const people=departments.flatMap((department,index)=>[{id:department.headAgentId,name:`Lead ${index}`,jobTitle:'Delivery Lead',departmentId:department.id,isHead:true},{id:`specialist-${index}`,name:`Specialist ${index}`,jobTitle:'Database Engineer',departmentId:department.id,instructions:'ROLE: OLD TITLE'}]);
  const data={agents:people,departments,controlCenter:{id:'control-center',name:'Tom Chandler'}};
  const groups=deriveFleetTeams(data);
  expect(groups).toHaveLength(5);
  for(const group of groups){expect(group.working).toBe(0);expect(group.taskCount).toBe(0);expect(group.members[1].reportsTo.id).toBe(group.head.agent.id);expect(group.members[1].jobTitle).toBe('Database Engineer');}
  const html=renderOverview(data);
  expect((html.match(/class="fleet-department"/g)||[]).length).toBe(5);
  expect((html.match(/data-fleet-project /g)||[]).length).toBe(1);
  expect(html).toContain('11 agents');expect(html).toContain('Led by Lead 4');expect(html).toContain('Database Engineer');expect(html).not.toContain('OLD TITLE');
 });
 it('projects an agent’s exact assignment stage and action while preserving their department head',()=>{
  const person=deriveFleetAgentView(agents[1],parallel);
  expect(person).toMatchObject({jobTitle:'Frontend & UI Engineer',reportsTo:{id:'head',name:'Slattery'},assignments:[{title:'Repair keyboard search',projectName:'Storefront',phase:'Working',activity:'Running a command'}]});
 });
 it('shows analysis validation as a prepared report without marking its stopped worker as running checks',()=>{
  const data={...context,runs:[{...context.runs[0],workKind:'analysis',taskViews:[{...context.runs[0]!.taskViews[0],state:'validating'}]}]};
  const person=deriveFleetAgentView(agents[1],data);
  expect(person.state).toMatchObject({bucket:'backlog',label:'Report ready'});
  expect(person.assignments[0].phase).toBe('Report review');
  expect(deriveFleetTeams(data)[0].working).toBe(0);
  expect(renderOverview(data)).not.toContain('Running checks');
 });
 it('excludes a signed-out runtime from available counts without confusing another installation',()=>{
  const people=[{...agents[0],runtime:'codex-installed'},{...agents[1],runtime:'claude-installed'}];
  const data={agents:people,departments:context.departments,runtimeReadiness:{reports:[{runtimeId:'codex-installed',usable:true,auth:'logged_in'},{runtimeId:'claude-installed',usable:false,auth:'logged_out'},{runtimeId:'claude-other',usable:true,auth:'logged_in'}]}};
  expect(deriveFleetAgentState(people[1],data)).toMatchObject({bucket:'unavailable',label:'Sign-in needed'});
  expect(deriveFleetAgentState(people[0],data)).toMatchObject({bucket:'idle',label:'Available'});
  expect(deriveFleetTeams(data)[0]).toMatchObject({ready:1,working:0});
  const html=renderOverview(data);expect(html).toContain('Sign-in needed');expect(html).toContain('<dt>Available</dt><dd>1</dd>');expect(html).toContain('2 agents · 1 ready');
 });
 it('does not attribute a worker’s newest action to the department head',()=>{
  const data={...context,runs:[{...context.runs[0],headReview:{state:'running',headAgentId:'head'},taskViews:[{...context.runs[0]!.taskViews[0],state:'accepted'}]}],eventPages:[{projectId:'p',runId:'run',events:[{sequence:1,type:'head.review_started',timestamp:'2026-09-13T10:00:00Z',payload:{headAgentId:'head'}},{sequence:2,type:'runtime.command_exec',taskId:'task',timestamp:'2026-09-13T10:01:00Z',payload:{command:'worker-only-command'}}]}]};
  const head=deriveFleetAgentView(agents[0],data);expect(head.assignments[0].activity).toBe('Department head is reviewing the result');expect(head.assignments[0].activity).not.toContain('worker-only-command');
 });
 it('shows pending Control Center intake without claiming queued requests are already running',()=>{
  const control={id:'control-center',name:'Tom Chandler',isCoordinator:true};
  const requests=[{id:'one',projectId:'p',state:'queued',task:'Frontend work',route:{state:'pending'}},{id:'two',projectId:'api',state:'queued',task:'Backend work',route:{state:'pending'}}];
  const data={agents:[],controlCenter:control,requests};
  expect(deriveFleetAgentState(control,data)).toMatchObject({bucket:'backlog',label:'Requests in intake',intakeCount:2,note:'2 requests awaiting routing'});
  expect(deriveFleetOperations(data).every((operation:{active:boolean})=>!operation.active)).toBe(true);
  const html=renderOverview(data);expect(html).toContain('Requests in intake');expect(html).toContain('2 requests awaiting routing');expect(html).toContain('<dt>Available</dt><dd>0</dd>');
  expect(deriveFleetAgentState(control,{...data,requests:requests.map(request=>({...request,state:'ended'}))})).toMatchObject({bucket:'idle',label:'Available'});
 });
 it('keeps active work to its summary and shows per-person task details only in department cards',()=>{
  const html=renderOverview(parallel);
  const work=html.slice(html.indexOf('<section class="fleet-work"'),html.indexOf('<section class="fleet-people"'));
  const departments=html.slice(html.indexOf('<section class="fleet-people"'));
  for(const text of ['Fix search','Add inventory search','Kara','Alisha','Open request'])expect(work).toContain(text);
  expect(work).not.toContain('fleet-task-list');expect(work).not.toContain('fleet-task-row');
  expect(work.replace(/<[^>]*>/g,'')).not.toContain('Repair keyboard search');
  for(const text of ['Repair keyboard search','Implement inventory endpoint','Running a command','Agent update received'])expect(departments).toContain(text);
 });
});


describe('recorded agent timing and stable Headquarters updates', () => {
 const start='2026-09-13T10:00:00Z',end='2026-09-13T10:02:03Z';
 const withAttempt=(attempt:Record<string,unknown>,state='running')=>({...context,runs:[{...context.runs[0],taskViews:[{...context.runs[0]!.taskViews[0],state,attempt}]}]});
 it('keeps the planning head working after lifecycle events leave the bounded cache',()=>{
  const data={...context,runs:[{...context.runs[0],taskViews:[],headPlanning:{state:'running',headAgentId:'head',planningId:'current',at:start,startedAt:start}}],eventPages:[]};
  const person=deriveFleetAgentView(agents[0],data);
  expect(person.state).toMatchObject({bucket:'progress',label:'Planning'});
  expect(person.assignments[0]).toMatchObject({startedAt:start,timingActive:true,phase:'Planning'});
  expect(deriveFleetTeams(data)[0]).toMatchObject({working:1});
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({bucket:'idle',label:'Available'});
  const finished={...data,runs:[{...data.runs[0],headPlanning:{...data.runs[0]!.headPlanning,state:'planned'}}]};
  expect(deriveFleetAgentState(agents[0],finished).bucket).toBe('idle');
  expect(overviewStructureSignature(finished)).not.toBe(overviewStructureSignature(data));
 });
 it('shows the reviewing head working while a stopped worker is available with frozen completed context',()=>{
  const data={...withAttempt({id:'attempt',state:'completed',startedAt:start,endedAt:end},'validating'),runs:[{...withAttempt({id:'attempt',state:'completed',startedAt:start,endedAt:end},'validating').runs[0],headReview:{state:'running',headAgentId:'head',reviewId:'review',at:end}}],events:[{projectId:'p',runId:'run',taskId:'task',type:'runtime.command_exec',timestamp:end,payload:{phase:'started',command:'npm test'}}]};
  const worker=deriveFleetAgentView(agents[1],data),head=deriveFleetAgentView(agents[0],data);
  expect(worker.state).toMatchObject({bucket:'idle',label:'Available'});
  expect(worker.assignments[0]).toMatchObject({completed:true,completionLabel:'Worker finished',activity:'',timingActive:false,endedAt:end});
  expect(head.state).toMatchObject({bucket:'progress',label:'Reviewing'});
  expect(head.assignments[0]).toMatchObject({timingActive:true,startedAt:end});
  expect(deriveFleetTeams(data)[0]).toMatchObject({working:1,ready:1});
  const row=renderOverview(data).match(/<button type="button" class="fleet-agent"[^>]*data-lo-id="worker"[\s\S]*?<\/button>/)?.[0];
  expect(row).toContain('data-has-work="false"');expect(row).toContain('Worker finished');expect(row).not.toContain('Running: npm test');
 });
 it('does not let a completed attempt hide the same worker’s active work on another project',()=>{
  const completed=withAttempt({state:'completed',startedAt:start,endedAt:end},'validating');
  const data={...completed,requests:[...completed.requests,{...context.requests[0],id:'other-request',projectId:'other'}],runs:[...completed.runs,{...context.runs[0],projectId:'other',taskViews:[{...context.runs[0]!.taskViews[0],attempt:{state:'running',startedAt:end}}]}]};
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({bucket:'progress',label:'Working',projectId:'other'});
 });
 it('uses the worker attempt start for elapsed time rather than an earlier queued request',()=>{
  const data={...withAttempt({id:'attempt',state:'running',startedAt:start}),requests:[{...context.requests[0],receivedAt:'2026-09-13T09:00:00Z'}]};
  const assignment=deriveFleetAgentView(agents[1],data).assignments[0];
  expect(assignment).toMatchObject({startedAt:start,endedAt:null,timingActive:true,timingSource:'attempt'});
  const row=renderOverview(data).match(/<button type="button" class="fleet-agent"[^>]*data-lo-id="worker"[\s\S]*?<\/button>/)?.[0];
  expect(row).toContain(`data-duration-start="${start}"`);expect(row).toContain('data-duration-active="true"');expect(row).not.toContain('09:00:00');
 });
 it('freezes a stopped worker attempt while its report is being reviewed',()=>{
  const data={...withAttempt({id:'attempt',state:'completed',startedAt:start,endedAt:end},'validating'),runs:[{...withAttempt({id:'attempt',state:'completed',startedAt:start,endedAt:end},'validating').runs[0],workKind:'analysis'}]};
  const assignment=deriveFleetAgentView(agents[1],data).assignments[0];
  expect(assignment).toMatchObject({phase:'Report review',startedAt:start,endedAt:end,timingActive:false,timingLabel:'Worker time'});
  expect(renderOverview(data)).toContain('<span data-duration-value>2m 03s</span>');
 });
 it('keeps one completed owned result and duration on an available agent, excluding older tasks',()=>{
  const data={...withAttempt({state:'completed',startedAt:start,endedAt:end},'accepted'),requests:[{...context.requests[0],state:'ended'}],runs:[{...withAttempt({state:'completed',startedAt:start,endedAt:end},'accepted').runs[0],state:'ready_for_review',workKind:'analysis',analysis:{reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[]}}]};
  const person=deriveFleetAgentView(agents[1],data);
  expect(person.state.label).toBe('Available');expect(person.assignments).toHaveLength(1);
  expect(person.assignments[0]).toMatchObject({title:'Repair keyboard search',completed:true,timingActive:false,endedAt:end});
  const html=renderOverview(data);expect(html).toContain('Completed · ');expect(html).toContain('2m 03s');expect(html).not.toContain('fleet-recent');
 });
 it('does not manufacture running time from task update or request receipt time',()=>{
  const data={...context,requests:[{...context.requests[0],receivedAt:start}],runs:[{...context.runs[0],taskViews:[{...context.runs[0]!.taskViews[0],updatedAt:start}]}]};
  expect(deriveFleetAgentView(agents[1],data).assignments[0]).toMatchObject({startedAt:null,endedAt:null,timingActive:false});
  expect(deriveFleetAgentView(agents[1],withAttempt({state:'completed',startedAt:start})).assignments[0]).toMatchObject({timingActive:false,endedAt:null});
  expect(deriveFleetAgentView(agents[1],withAttempt({state:'completed',startedAt:end,endedAt:start})).assignments[0]).toMatchObject({timingActive:false,endedAt:null});
  expect(deriveFleetAgentView(agents[1],{...withAttempt({state:'running',startedAt:start}),connected:false}).assignments[0].timingActive).toBe(false);
 });
 it('pairs the current head review by actor, project, run and review identity',()=>{
  const op={projectId:'p',runId:'run',active:true,stage:'review',workKind:'analysis'};
  const reviewEvent=(sequence:number,type:string,timestamp:string,reviewId:string,headAgentId='head')=>({sequence,type,timestamp,payload:{reviewId,headAgentId}});
  const data={...context,runs:[{...context.runs[0],headReview:{state:'running',headAgentId:'head',reviewId:'current'}}],eventPages:[{projectId:'p',runId:'run',events:[reviewEvent(1,'head.review_started',start,'old'),reviewEvent(2,'head.review_finished',end,'old'),reviewEvent(3,'head.review_started',end,'current'),reviewEvent(4,'head.review_finished','2026-09-13T10:03:00Z','old'),reviewEvent(5,'head.review_finished','2026-09-13T10:04:00Z','current','other-head')]},{projectId:'other',runId:'run',events:[reviewEvent(1,'head.review_finished','2026-09-13T10:05:00Z','current')]}]};
  expect(deriveAgentPhaseTiming('head',op,data,'review')).toMatchObject({startedAt:end,endedAt:null,timingActive:true,phase:'Report review'});
  data.eventPages[0]!.events.push(reviewEvent(6,'head.review_finished','2026-09-13T10:06:00Z','current'));
  expect(deriveAgentPhaseTiming('head',op,data,'review')).toMatchObject({startedAt:end,endedAt:'2026-09-13T10:06:00Z',timingActive:false});
 });
 it('pairs planning completion without borrowing the previous generation’s finish',()=>{
  const data={eventPages:[{projectId:'p',runId:'run',events:[{sequence:1,type:'head.planning_started',timestamp:start,payload:{headAgentId:'head',planningId:'old'}},{sequence:2,type:'head.planning_finished',timestamp:end,payload:{headAgentId:'head'}},{sequence:3,type:'head.planning_started',timestamp:end,payload:{headAgentId:'head',planningId:'current'}}]}]};
  expect(deriveAgentPhaseTiming('head',{projectId:'p',runId:'run',active:true,stage:'planning'},data,'planning')).toMatchObject({startedAt:end,endedAt:null,timingActive:true});
 });
 it('ignores wall time, readiness polling metadata and hidden runtime noise in the structural signature',()=>{
  vi.useFakeTimers();
  try{
   const data={...withAttempt({state:'running',startedAt:start}),runtimeReadiness:{checkedAt:start,reports:[{runtimeId:'codex',usable:true,auth:'logged_in'}]}};
   const before=overviewStructureSignature(data);vi.advanceTimersByTime(10000);
   const polling={...data,runtimeReadiness:{...data.runtimeReadiness,checkedAt:end},runs:data.runs.map(run=>({...run,eventCount:999,updatedAt:end,lastEvent:{type:'runtime.reasoning',timestamp:end}})),events:[{type:'runtime.reasoning',projectId:'p',runId:'run',timestamp:end,payload:{text:'hidden'}}]};
   expect(overviewStructureSignature(polling)).toBe(before);
   expect(overviewStructureSignature({...data,agents:[agents[0],{...agents[1],name:'New name'}]})).not.toBe(before);
   expect(overviewStructureSignature({...data,events:[{type:'runtime.command_exec',projectId:'p',runId:'run',taskId:'task',timestamp:end,payload:{command:'npm test'}}]})).not.toBe(before);
   expect(overviewStructureSignature(withAttempt({state:'completed',startedAt:start,endedAt:end},'validating'))).not.toBe(before);
  }finally{vi.useRealTimers();}
 });
 it('skips DOM creation and timer installation on unchanged snapshots',()=>{
  const node={nodeType:1,nodeName:'SECTION',isEqualNode:()=>true,matches:()=>true,isConnected:true,querySelector:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}};
  const createElement=vi.fn(()=>({content:{firstElementChild:node},innerHTML:''}));
  const setIntervalSpy=vi.spyOn(globalThis,'setInterval');
  const controller=wireOverview(node);
  try{
   vi.stubGlobal('document',{createElement});
   expect(controller.update(context)).toBe(true);
   expect(createElement).toHaveBeenCalledTimes(1);
   expect(controller.update(structuredClone(context))).toBe(false);
   expect(controller.update({...context,streaming:true,checkedAt:end})).toBe(false);
   expect(createElement).toHaveBeenCalledTimes(1);
   expect(controller.update({...context,connected:false})).toBe(true);
   expect(createElement).toHaveBeenCalledTimes(2);
   expect(setIntervalSpy).not.toHaveBeenCalled();
  }finally{controller.destroy();vi.unstubAllGlobals();setIntervalSpy.mockRestore();}
 });
 it('defines equal three/two/one-column department tracks without orphan spanning rules',()=>{
  const css=readFileSync(new URL('../../web/headquarters/src/headquarters/live-overview.css',import.meta.url),'utf8');
  expect(css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
  expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
  expect(css).toContain('.fleet-department-grid { grid-template-columns:minmax(0,1fr);');
  expect(css).not.toMatch(/\.fleet-department:(?:nth|last-child)|grid-column:span [236]/);
 });
});

describe('recorded Headquarters status lights',()=>{
 it('uses green only for available agents and reserves the working signal for active recorded work',async()=>{
  const {fleetAgentSignal}=await import(path);
  expect(fleetAgentSignal(deriveFleetAgentState(agents[1],context))).toBe('working');
  expect(fleetAgentSignal(deriveFleetAgentState(agents[0],{agents}))).toBe('available');
  expect(fleetAgentSignal({bucket:'idle',label:'Readiness unknown',tone:'idle'})).toBe('unknown');
  const reserved={...context,runs:[],requests:[{...context.requests[0],state:'starting',admissionReady:true,workerIds:['worker']}]};
  expect(fleetAgentSignal(deriveFleetAgentState(agents[1],reserved))).toBe('waiting');
  expect(fleetAgentSignal(deriveFleetAgentState(agents[1],{...context,connected:false}))).toBe('unknown');
  expect(fleetAgentSignal(deriveFleetAgentState(agents[1],{...context,requests:[{...context.requests[0],state:'held'}]}))).toBe('attention');
 });
 it('keeps sign-in, unavailable and unobserved runtime states distinct from availability',async()=>{
  const {fleetAgentSignal}=await import(path);
  const person={...agents[1],runtime:'runtime'};
  const state=(report:unknown)=>deriveFleetAgentState(person,{agents:[person],runtimeReadiness:{reports:report?[report]:[]}});
  expect(fleetAgentSignal(state({runtimeId:'runtime',usable:true,auth:'logged_in'}))).toBe('available');
  expect(fleetAgentSignal(state({runtimeId:'runtime',usable:false,auth:'logged_out'}))).toBe('sign-in');
  expect(fleetAgentSignal(state({runtimeId:'runtime',usable:false,installed:false}))).toBe('unavailable');
  expect(fleetAgentSignal(state(null))).toBe('unknown');
 });
 it('applies the same signal to the full Control Center row and preserves accessible state labels',()=>{
  const control={id:'control-center',name:'Tom Chandler',isCoordinator:true};
  const available=renderOverview({agents:[],controlCenter:control});
  expect(available).toContain('class="fleet-control-row" data-fleet-signal="available"');
  expect(available).toContain('data-bucket="idle" data-fleet-signal="available"');
  expect(available).toContain('Available</span>');
  const queued=renderOverview({agents:[],controlCenter:control,requests:[{id:'pending',projectId:'p',state:'queued',task:'Inspect this project',route:{state:'pending'}}]});
  expect(queued).toContain('class="fleet-control-row" data-fleet-signal="waiting"');
  expect(queued).not.toContain('data-fleet-signal="working"');
  expect(queued).toContain('Requests in intake</span>');
  const running=renderOverview(context);
  expect(running).toContain('data-bucket="progress" data-fleet-signal="working"');
  expect(running).toContain('Working</span>');
 });
 it('limits the gentle lamp pulse to working agents and honors reduced motion',()=>{
  const css=readFileSync(new URL('../../web/headquarters/src/headquarters/live-overview.css',import.meta.url),'utf8');
  expect(css).toContain("[data-fleet-signal='available'] { --fleet-signal:var(--green)");
  expect(css).toContain("[data-fleet-signal='working'] { --fleet-signal:var(--warning)");
  expect(css).toContain("[data-fleet-signal='attention'] { --fleet-signal:var(--warning)");
  expect(css).toContain("[data-fleet-signal='sign-in'] { --fleet-signal:var(--muted)");
  expect(css).toMatch(/@media \(prefers-reduced-motion:no-preference\)\s*\{\s*\.fleet-dashboard \.fleet-agent\[data-fleet-signal='working'\] \.fleet-status i \{ animation:fleet-working-lamp/);
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(css).toContain('animation:none!important;');
 });
});
