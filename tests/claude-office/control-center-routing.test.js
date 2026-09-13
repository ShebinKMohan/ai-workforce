import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlCenterRoute, controlCenterSubmission, controlFlowModel, conversationEntries } from '../../web/claude-office/src/chat-model.js';
import { indexWorkspace, taskEntries, needsYouList, isDirectControlReply } from '../../web/workspace/src/model.js';
const fixture = name => JSON.parse(readFileSync(new URL(`../workspace-ui/fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('one Control Center conversation', () => {
  it('keeps a successful no-run Control Center answer in chat without making it a review obligation or an execution task', () => {
    const item = { id:'greeting',kind:'request',projectId:'app',departmentId:null,task:'Hello',state:'ended',exitCode:0,runId:null,receivedAt:'2026-09-12T10:00:00Z',endedAt:'2026-09-12T10:00:02Z',route:{method:'direct_reply',state:'selected'},result:{code:'control_reply',exitCode:0,message:'Hello. What can I help with?'},controlReply:'Hello. What can I help with?' };
    const ws = indexWorkspace(fixture('workspace'));
    const entries = taskEntries(ws,{runs:[]},{items:[item]});
    expect(entries[0].status.key).toBe('answered');
    expect(entries[0].status.word).toBe('Answered');
    expect(entries[0].inMotion).toBe(false);
    expect(entries[0].needsYou).toBeNull();
    const task = {id:'q:greeting',requestId:'greeting',projectId:'app',at:item.receivedAt,entry:entries[0]};
    expect(conversationEntries([], [task])).toHaveLength(1);
    const view = controlFlowModel(task);
    expect(view.directReply).toBe(true);
    expect(view.label).toBe('Answered');
    expect(view.phases).toEqual([]);
    expect(view.parts).toEqual([]);
    expect([task].filter(row => !isDirectControlReply(row.entry.item))).toEqual([]);
    expect(needsYouList(ws,entries).items.some(row => row.requestId === item.id)).toBe(false);
    expect(isDirectControlReply({...item,exitCode:4})).toBe(false);
    expect(isDirectControlReply({...item,runId:'real-run'})).toBe(false);
  });

  it('counts actual agent identities and reads head review from the status document while event pages catch up', () => {
    const task = {entry:{item:{state:'running',workerIds:['agent-1','agent-2']}}};
    const detail = {verdict:'working',parts:[{taskId:'one',worker:'Alex',state:'running'},{taskId:'two',worker:'Alex',state:'running'}]};
    const status = {run:{headReview:{state:'running',headAgentId:'head'}},tasks:[{id:'one',ownerAgentId:'agent-1'},{id:'two',ownerAgentId:'agent-2'}]};
    const view = controlFlowModel(task,detail,[],status);
    expect(view.runningWorkerCount).toBe(2);
    expect(view.reviewing).toBe(true);
    expect(view.label).toBe('Department head reviewing');
    const waiting = controlFlowModel(task,{parts:[{taskId:'three',key:'third',state:'ready'}]},[{type:'schedule.blocked',payload:{blocked:[{key:'third',reason:'worker_busy',waitingOn:['first']}]}}]);
    expect(waiting.parts[0].waitReason).toBe('worker_busy');
  });

  it('submits project context without any canvas-selected department or agent override', () => {
    const document = fixture('workspace');
    const payload = controlCenterSubmission({ text: 'Fix the search bug', projectId: 'app', departmentId: 'design', selection: { type:'employee',id:'vera' }, clientRequestId:'route-once' }, document);
    expect(payload).toEqual({ task:'Fix the search bug', projectId:'app', clientRequestId:'route-once' });
    expect(controlCenterRoute(document, 'app')).not.toHaveProperty('departmentId');
    expect(controlCenterRoute(document, 'app')).not.toHaveProperty('head');
  });
  it('allows explicit consent to reuse the server-selected route without a manual department picker', () => {
    const document = fixture('workspace');
    const context = { text:'Fix bug', projectId:'app', consentDepartmentId:'eng', clientRequestId:'consent-retry' };
    expect(controlCenterSubmission(context, document)).not.toHaveProperty('departmentId');
    expect(controlCenterSubmission({ ...context, allowUnconfinedWrites:true }, document)).toEqual({ task:'Fix bug', projectId:'app', departmentId:'eng', allowUnconfinedWrites:true, clientRequestId:'consent-retry' });
  });
  it('requires a registered project but lets Control Center answer before workers or checks are configured', () => {
    expect(controlCenterRoute(fixture('workspace-empty')).sendable).toBe(false);
    expect(() => controlCenterSubmission({ text:'Fix bug' },fixture('workspace'))).toThrow(/Choose the project/);
    expect(controlCenterSubmission({ text:'Hello',projectId:'notes' },fixture('workspace'))).toEqual({ task:'Hello',projectId:'notes' });
  });
  it('acknowledges pending routing without pretending an eligible roster is assigned or replied', () => {
    const task = { inMotion:true,entry:{ item:{state:'queued',workerIds:['eligible-worker'],route:{state:'pending',projectId:'app',departmentId:null,headAgentId:null,reason:'Selecting a team'}}}};
    const view = controlFlowModel(task);
    expect(view.label).toBe('Routing your request');
    expect(view.parts).toEqual([]);
    expect(view.reply).toBeNull();
    expect(view.phases[0].state).toBe('now');
  });
  it('counts accepted worker tasks without converting worker prose into a Control Center answer', () => {
    const task = {inMotion:true,entry:{item:{route:{state:'selected',departmentId:'eng',headAgentId:'head'}}}};
    const detail = {verdict:'working',parts:[{state:'accepted'},{state:'running'}],phases:[]};
    const events = [{sequence:1,type:'runtime.assistant_message',payload:{text:'Everything is done'}}];
    const view = controlFlowModel(task,detail,events);
    expect(view.completedTasks).toBe(1); expect(view.totalTasks).toBe(2);
    expect(view.reply).toBeNull(); expect(view.verified).toBe(false);
  });
  it('shows the head-backed final event while retaining independent verification as a separate fact', () => {
    const task = {verified:true,entry:{item:{route:{state:'selected',departmentId:'eng'}}}};
    const events = [{sequence:1,type:'head.review_started',payload:{headAgentId:'head'}},{sequence:2,type:'head.review_finished',payload:{headAgentId:'head',verdict:'passed',summary:'Reviewed result'}},{sequence:3,type:'control.final_reply',timestamp:'2026-09-12T10:00:00Z',payload:{text:'The fix is ready.',headAgentId:'head',source:'department_head_review'}}];
    const view = controlFlowModel(task,{verdict:'verified',parts:[],phases:[]},events);
    expect(view.reply.text).toBe('The fix is ready.'); expect(view.label).toBe('Reviewed and verified');
    const changedEvidence = controlFlowModel(task,{verdict:'unverified',parts:[],phases:[]},events);
    expect(changedEvidence.verified).toBe(false); expect(changedEvidence.tone).toBe('attention'); expect(changedEvidence.reply.text).toBe('The fix is ready.');
  });
  it('labels older verified history as lacking head review, and shows blocked routing replies honestly', () => {
    const older = controlFlowModel({verified:true,entry:{item:{departmentId:'eng'}}},{verdict:'verified',parts:[],phases:[]});
    expect(older.legacyCheckResult).toBe(true); expect(older.reply).toBeNull();
    const blocked = controlFlowModel({entry:{item:{state:'failed_to_start',route:{state:'blocked'},result:{code:'consent_required'},controlReply:'Claude Code needs your explicit permission.'}}});
    expect(blocked.label).toBe('Runtime permission needed'); expect(blocked.reply.text).toContain('explicit permission'); expect(blocked.reply.final).toBe(false);
  });
});
