import { describe, expect, it } from 'vitest';
const path = '../../web/headquarters/src/headquarters/live-overview.js';
const { deriveOverviewWorkload, deriveFleetAgentState, deriveFleetOperations, renderOverview } = await import(path);
const agents = [{id:'head',name:'Slattery',departmentId:'eng',isHead:true},{id:'worker',name:'Kara',departmentId:'eng',instructions:'ROLE: FRONTEND & UI ENGINEER'}];
const context = {agents,departments:[{id:'eng',name:'Engineering',headAgentId:'head'}],requests:[{id:'req',projectId:'p',runId:'run',state:'running',task:'Fix search'}],runs:[{id:'run',projectId:'p',state:'running',taskViews:[{id:'task',state:'running',ownerAgentId:'worker',objective:'Repair keyboard search'}]}]};
describe('fleet overview status consistency',()=>{
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
  expect(html).toContain('0 agents');expect(html).toContain('No work running');
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
  for (const text of ['Storefront','Inventory API','Repair keyboard search','Implement inventory endpoint','Kara','Alisha','Running: npm test','Inspecting endpoint pagination']) expect(html).toContain(text);
  expect(html).not.toContain('Work in focus');
  expect(html).not.toContain('Follow a request');
  expect((html.match(/data-fleet-operation /g) || []).length).toBe(2);
 });
 it('keeps action text scoped to both project and run even with colliding IDs', () => {
  const operations = deriveFleetOperations(parallel);
  const storefront = operations.find((item: { projectId: string }) => item.projectId === 'p');
  const api = operations.find((item: { projectId: string }) => item.projectId === 'api');
  expect(storefront.tasks[0]).toMatchObject({ ownerId:'worker', activity:'Running: npm test' });
  expect(api.tasks[0]).toMatchObject({ ownerId:'backend', activity:'Agent update: Inspecting endpoint pagination' });
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
   expect(row).toContain('width:36px;height:36px');
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
  expect(html).toContain('data-lo-action="task"');
 });
 it('keeps the inspected files in the latest completed action and retains a failed command outcome', () => {
  const event = { taskId:'task',type:'runtime.command_exec',timestamp:'2026-09-13T10:04:00Z',payload:{ phase:'completed',exitCode:0,command:'/bin/zsh -lc "nl -ba onboard.mjs; nl -ba src/tasks.js"' } };
  const data = { ...context,eventPages:[{ projectId:'p',runId:'run',events:[event] }] };
  expect(deriveFleetOperations(data)[0].tasks[0].activity).toBe('Read: onboard.mjs, src/tasks.js');
  expect(renderOverview(data)).toContain('Read: onboard.mjs, src/tasks.js');
  const failed = { ...data,eventPages:[{ ...data.eventPages[0],events:[{ ...event,payload:{ ...event.payload,exitCode:1 } }] }] };
  expect(deriveFleetOperations(failed)[0].tasks[0].activity).toBe('Command failed (1): nl -ba onboard.mjs; nl -ba src/tasks.js');
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
  expect(renderOverview(blocked)).toContain('The project folder is no longer available.');
 });
 it('shows one plain sentence of an agent update and keeps its source event untouched', () => {
  const text = '## Findings\n\n**Tracing** [request routing](https://example.invalid/source) in `serve.mjs`. The remaining explanation belongs in the inspector.\n- More details';
  const event = { type:'runtime.assistant_message',taskId:'task',timestamp:'2026-09-13T10:00:00Z',payload:{ text } };
  const data = { ...context,eventPages:[{ projectId:'p',runId:'run',events:[event] }] };
  const operation = deriveFleetOperations(data)[0];
  expect(operation.activity).toBe('Agent update: Tracing request routing in serve.mjs.');
  expect(operation.tasks[0].activity).toBe(operation.activity);
  expect(renderOverview(data)).not.toContain('remaining explanation belongs');
  expect(event.payload.text).toBe(text);
  const long = { ...event,payload:{ text:'Inspecting ' + 'the request routing implementation '.repeat(20) } };
  expect(deriveFleetOperations({ ...data,eventPages:[{ ...data.eventPages[0],events:[long] }] })[0].activity.length).toBeLessThanOrEqual(140);
 });
 it('keeps recent handoffs available in a closed disclosure below the team', () => {
  const event = { projectId:'p',runId:'run',taskId:'task',cursor:1,type:'head.assigned',timestamp:'2026-09-13T10:00:00Z',payload:{ headAgentId:'head',agentId:'worker' } };
  const html = renderOverview({ ...context,events:[event] });
  expect(html).toContain('<details class="fleet-recent" data-fleet-details="handoffs">');
  expect(html).toContain('Recent handoffs');
  expect(html.indexOf('<details class="fleet-recent"')).toBeGreaterThan(html.indexOf('class="fleet-agent-grid"'));
  expect(html).toContain('Assigned work');
 });
 it('escapes project names, activity and task text without manufacturing completion', () => {
  const html = renderOverview({ ...context, projects:[{ id:'p', name:'<img onerror="bad()">' }], eventPages:[{ projectId:'p',runId:'run',events:[{ type:'runtime.assistant_message', taskId:'task', timestamp:'2026-09-13T10:01:00Z', payload:{ text:'<script>done()</script> all checks passed' } }] }] });
  expect(html).toContain('&lt;script&gt;done()&lt;/script&gt; all checks passed');
  expect(html).not.toContain('<script>');
  expect(html).toContain('0 of 1 tasks checked');
  expect(html).not.toContain('Verified');
 });
 it('requires the reviewed analysis evidence projection before completion', () => {
  const data = { ...context, requests:[{ ...context.requests[0], state:'ended' }], runs:[{ ...context.runs[0], state:'ready_for_review', workKind:'analysis', analysis:{ reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[] } }] };
  expect(deriveFleetOperations(data)[0]).toMatchObject({ status:'Reviewed analysis', bucket:'done' });
  expect(deriveFleetOperations({ ...data, runs:[{ ...data.runs[0], analysis:{ ...data.runs[0]!.analysis,evidenceIssues:['Report missing'] } }] })[0]).toMatchObject({ status:'Analysis evidence incomplete', bucket:'waiting' });
 });
 it('shows a compact idle message and a direct link to the latest completed result', () => {
  const data = { ...context, requests:[{ ...context.requests[0],state:'ended' }],runs:[{ ...context.runs[0],state:'ready_for_review',workKind:'analysis',analysis:{ reviewed:true,sourceUnchanged:true,reportCount:1,evidenceIssues:[] } }] };
  const html = renderOverview(data);
  const empty = html.slice(html.indexOf('<div class="fleet-work-empty"'), html.indexOf('<section class="fleet-people"'));
  expect(empty).toContain('No work running');
  expect(empty).not.toContain('Change the project');
  expect(empty).toContain('class="fleet-last-result" data-lo-action="request" data-lo-id="req"');
  expect(empty).toContain('Reviewed analysis');
  expect(empty).toContain('Fix search');
 });
 it('puts a previous setup failure in history with a frozen duration and available agents', () => {
  const data = { ...context, runs:[], requests:[{ id:'old',projectId:'p',state:'failed_to_start',task:'Read the codebase',reason:'no_worker: no worker is placed on this project; run workforce assign worker project',route:{state:'blocked',departmentId:'eng'},receivedAt:'2026-09-13T10:00:00Z',endedAt:'2026-09-13T10:00:02Z' }] };
  const operation = deriveFleetOperations(data)[0];
  expect(operation).toMatchObject({ status:'No work started',bucket:'closed',active:false,waiting:false,stage:null,endedAt:'2026-09-13T10:00:02Z' });
  expect(operation.reason).not.toContain('workforce assign');
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({ label:'Available' });
  const html = renderOverview(data);
  expect(html).toContain('0 running requests');
  expect(html).toContain('2s total');
  expect(html).not.toContain('No work started</span></div><p');
 });
 it('does not label a terminal failed worker as waiting for the user', () => {
  const data = { ...context, requests:[{ ...context.requests[0],state:'ended',exitCode:4 }],runs:[{ ...context.runs[0],state:'failed',taskViews:[{ ...context.runs[0]!.taskViews[0],state:'failed' }] }] };
  expect(deriveFleetAgentState(agents[1],data)).toMatchObject({ label:'Available' });
  expect(deriveFleetOperations(data)[0]).toMatchObject({ bucket:'closed',status:'Run failed' });
 });
});
