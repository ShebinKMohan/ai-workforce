import { avatar, escape, icon } from './ui.js';
import { deriveFleetJourneys } from './fleet-activity.js';
import { headReviewNeedsRetry, newerRunRequest, savedRequestText, taskWorkStatus, runVerificationFacts, requestTaskStatus } from './task-status.js';
import { renderDuration } from './time-display.js';

const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : '';
const settled = new Set(['ended', 'cancelled', 'discarded', 'failed', 'failed_to_start', 'held']);
const technical = /(?:workforce\s+(?:workspace|run|resume)|\/opt\/homebrew\/|\/Users\/|node:internal|\bat\s+\S+\s+\([^)]*:\d+:\d+\))/i;
const assignmentFailure = value => /no worker.*(?:placed|project)|(?:not configured|not assigned).*project|on the bench|workforce workspace assign/i.test(value);

/** Turn operational failure categories into a useful explanation; retain full diagnostics elsewhere. */
export function taskBlocker(request = {}) {
  const original = string(request.result?.message || request.route?.reason || request.reason);
  if (assignmentFailure(original + '\n' + list(request.result?.details).join('\n'))) return 'This earlier attempt stopped before assigning a team. No project work ran.';
  if (/consent|unconfined|containment/i.test(request.result?.code || '')) return 'The selected runtime could not start within the required file-access boundary.';
  if (request.state === 'held') return 'This request is paused. Resume it when you want to continue.';
  if (request.recovery?.failureClass === 'authentication') return 'The coding agent could not sign in to its provider.';
  if (request.recovery?.failureClass === 'quota') return 'The provider stopped this attempt because its usage limit was reached.';
  if (request.recovery?.failureClass === 'permission') return 'The coding agent was denied access to a file or required service.';
  if (request.recovery?.failureClass === 'protocol') return 'The coding runtime rejected the request.';
  if (request.recovery?.failureClass === 'provider_transient') return 'The connection to the coding provider was interrupted.';
  if (!original) return '';
  if (technical.test(original) || original.length > 500 || original.includes('\n')) return 'The runtime could not continue. Its recorded diagnostic is available below.';
  return original;
}

/** Only offer actions supported by this saved request; a verified result needs no recovery. */
export function taskAttention(request = {}, run, requests = [], options = {}) {
  const successor = newerRunRequest(request, requests);
  if (successor) return {message:'This work continued in a newer attempt.',nextStep:'Open that attempt for its current progress and result.',actions:[{kind:'successor',label:'Open current attempt',id:successor.id}]};
  const status = requestTaskStatus(request, run, requests, options);
  const recovery = request.recovery || {};
  if (status.bucket === 'done' || status.bucket === 'loading') return null;
  if (recovery.nextRequestId) return {message:'A newer attempt already exists for this request.',nextStep:'Open that attempt to follow its progress.',actions:[{kind:'successor',label:'Open retry',id:recovery.nextRequestId}]};
  if (headReviewNeedsRetry(request, run)) return {message:'Final review needs attention: the head did not record a review decision.',nextStep:'Resume the saved run to retry the final review using its preserved work.',actions:[{kind:'resume',label:'Resume'}]};
  if (request.state === 'held') return {message:'This request is paused; no new work will start while it is held.',nextStep:'Continue the saved request, or cancel it.',actions:[{kind:'start',label:'Continue request'},{kind:'cancel',label:'Cancel request'}]};
  if (request.state === 'queued') return {message:'',nextStep:'',actions:[{kind:'cancel',label:'Cancel request'}]};
  if (request.stopRequestedAt || request.state === 'stopping') return {message:'The runtime is stopping.',nextStep:'Waiting for the running process to finish stopping.',actions:[]};
  if (['starting','running'].includes(request.state)) return {message:'',nextStep:'',actions:request.pid?[{kind:'cancel',label:'Stop work'}]:[]};
  if (['discarded','cancelled'].includes(request.state) || request.signal || request.exitCode === 130) return null;
  const failed = ['failed_to_start','failed','ended'].includes(request.state) || request.route?.state === 'blocked';
  if (!failed) return null;
  const diagnostic = [request.result?.code,request.result?.message,request.route?.code,request.route?.reason].filter(Boolean).join(' ');
  const retry = recovery.canRetry === true ? [{kind:'retry',label:recovery.action === 'resume'?'Resume and repair':'Retry request'}] : [];
  if (request.route?.outcome === 'clarification') return {message:taskBlocker(request)||'Control Center needs one detail to route this request.',nextStep:'Answer the question in the message box below.',actions:[{kind:'answer',label:'Answer question'}]};
  if (request.state === 'failed_to_start' && /consent|unconfined|containment/i.test(request.result?.code || '')) return {message:'The runtime could not start with its current file-access boundary.',nextStep:'Review the access choice for this request, then choose whether to allow and retry.',actions:[{kind:'permission',label:'Review access choice'},{kind:'runtime',label:'Use another runtime'}]};
  if (recovery.canRetry === false && /process.*(?:still active|uncertain|not been confirmed stopped)|coordinator still owns/i.test(recovery.reason||'')) return {message:'The earlier execution has not been confirmed stopped. Starting a duplicate could overlap its work.',nextStep:'Refresh the saved status to check whether that execution has released the request.',actions:[{kind:'refresh',label:'Refresh execution status'}]};
  const failureClass = recovery.failureClass;
  if (failureClass === 'authentication' || /unauthorized|not logged in|authentication.failed|expired.*(?:token|oauth)|sign.in required/i.test(diagnostic)) return {message:'The coding agent could not authenticate with its provider.',nextStep:'Sign in to the coding agent, then retry this saved request.',actions:[{kind:'signin',label:'Sign in to coding agent'},...retry]};
  if (failureClass === 'quota' || /usage.limit|quota|rate.limit|budget.exceeded/i.test(diagnostic)) return {message:'The provider stopped this attempt because its usage limit was reached.',nextStep:'Wait for your allowance to reset before retrying, or prepare a new request with another available runtime.',actions:[{kind:'runtime',label:'Use another runtime'},...retry]};
  if (failureClass === 'protocol') return {message:'The coding runtime rejected this request before it could finish.',nextStep:'Open the rejection details, or prepare the request with another runtime. The original request stays saved.',actions:[{kind:'diagnostics',label:'View rejection'},{kind:'runtime',label:'Use another runtime'},...retry]};
  if (failureClass === 'permission') return {message:'The coding agent was denied access to a file or required service.',nextStep:'Open the recorded access error to identify what was denied; check the runtime connection before retrying.',actions:[{kind:'diagnostics',label:'View access error'},{kind:'connections',label:'Open Connections'},...retry]};
  if (retry.length) return {message:assignmentFailure(diagnostic)?'This earlier attempt stopped before assigning a team. No project work ran.':failureClass === 'code_failure'?'The work did not pass its checks.':taskBlocker(request)||'This attempt ended before the team delivered a verified result.',nextStep:recovery.action === 'resume'?'Resume the existing run so the team can repair the remaining work. Accepted work is preserved.':'Retry sends your saved request through automatic team selection again.',actions:retry};
  if ((request.runId || request.resumeRunId) && !run) return {message:'The run is linked, but its saved evidence has not loaded.',nextStep:'Refresh the saved result. This does not start another agent run.',actions:[{kind:'refresh',label:'Load saved result'}]};
  if (run && status.bucket === 'waiting') return {message:'The saved result does not have complete, verified delivery evidence.',nextStep:'Inspect the missing checks or review, then ask the team to investigate this result.',actions:[{kind:'diagnostics',label:'View evidence details'},{kind:'followup',label:'Ask team to investigate'}]};
  return {message:taskBlocker(request)||'The request ended without a delivered result.',nextStep:'Open the recorded error, then send a follow-up with the change you want the team to make.',actions:[{kind:'diagnostics',label:'View recorded error'},{kind:'answer',label:'Write follow-up'}]};
}

export function requestHeadline(value, limit = 130) {
  const line = string(value).split(/\r?\n/).find(line=>line.trim())?.trim().replace(/^#{1,6}\s*/, '') || 'Recorded request';
  const sentence = line.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || line;
  return sentence.length > limit ? sentence.slice(0,limit-1).trimEnd()+'…' : sentence;
}

export function taskResultSummary(reply, request = {}, run) {
  const status=requestTaskStatus(request,run);
  if (status.label === 'Verified') return `Completed: ${requestHeadline(savedRequestText(request,run)).replace(/[.!?]$/, '')}. Independent checks passed and the department head approved the result. Changes are saved in an isolated workspace; open Deliverables to review them.`;
  if (status.label === 'Reviewed analysis') return `Reviewed: ${requestHeadline(savedRequestText(request,run)).replace(/[.!?]$/, '')}. Your analysis report is ready in Deliverables. The department head reviewed the findings; project code is unchanged.`;
  if (headReviewNeedsRetry(request, run)) return 'Final review needs attention. Resume the saved run to retry the review using its preserved work.';
  if (run && request.state === 'ended' && status.bucket !== 'done') return 'The team returned a result, but its saved checks and review do not yet establish a verified delivery. Open the evidence details to see what is missing.';
  const plain=string(reply).trim();
  if (/^(?:```(?:json)?\s*)?[{[]/.test(plain) || technical.test(plain)) return status.bucket==='done'?'The response is ready. Open the full response for details.':'The agent recorded a response. Its technical details are available below.';
  return conciseText(plain,240);
}

export function taskEventLabel(event = {}) {
  const phase = event.payload?.phase;
  const labels = {
    'head.planning_started':'Department head is planning the work', 'head.planning_finished':'The team plan is ready',
    'head.review_started':'Department head is reviewing the result', 'head.review_finished':'Head review recorded',
    'runtime.command_exec':phase === 'completed' ? 'Finished a command' : 'Running a command',
    'runtime.tool_call':phase === 'completed' ? 'Finished a tool action' : 'Using a tool',
    'runtime.tool_result':'Tool result received', 'runtime.file_change':'File change reported',
    'runtime.assistant_message':'Agent update received', 'runtime.message':'Agent update received', 'runtime.text':'Agent update received',
    'runtime.output':'Agent update received', 'runtime.turn_started':'Agent started working',
    'runtime.turn_completed':'Agent turn finished', 'runtime.error':'Runtime reported a problem',
    'task.started':'Task started', 'task.accepted':'Task checks passed', 'task.failed':'Task needs attention',
    'check.started':'Running an independent check', 'check.finished':'Check result recorded',
    'message.recorded':'Message sent to a teammate', 'message.acknowledged':'Teammate acknowledged the message',
  };
  return labels[event.type] || string(event.type).replace(/^runtime\./, '').replaceAll(/[._]/g, ' ') || 'Waiting for the next recorded action';
}

const at = value => Date.parse(value || '') || 0;
export const visibleTaskEvent = event => !/(?:^|\.)(?:raw|reasoning(?:[._].*)?|usage|token_usage|output_delta)$/.test(string(event?.type));
const eventTime = event => event?.timestamp || event?.at;
function orderedEvents(events) { return [...events].sort((a,b) => Number.isInteger(a.sequence) && Number.isInteger(b.sequence) ? a.sequence-b.sequence : at(eventTime(a))-at(eventTime(b))); }
function phaseTiming(stage, request, run, events, active, departmentHeadId) {
  if (['planning','review'].includes(stage)) {
    const identity = stage === 'review' ? 'reviewId' : 'planningId';
    const headId = stage === 'review' ? run?.headReview?.headAgentId : request.route?.headAgentId || departmentHeadId;
    const expectedId = stage === 'review' ? run?.headReview?.reviewId : null;
    const relevant = events.filter(event => !headId || (event.payload?.headAgentId || event.headAgentId) === headId);
    const start = relevant.filter(event => event.type === `head.${stage}_started` && (!expectedId || event.payload?.[identity] === expectedId)).at(-1);
    const finish = start && relevant.slice(relevant.indexOf(start)+1).find(event => event.type === `head.${stage}_finished` && (!event.payload?.[identity] || event.payload[identity] === start.payload?.[identity]));
    const startedAt = eventTime(start) || (stage === 'review' && run?.headReview?.state === 'running' ? run.headReview.at : null) || null;
    const endedAt = eventTime(finish) || null;
    return {start:startedAt,end:endedAt,active:active&&!endedAt,label:stage==='review'?'Review time':'Planning time'};
  }
  if (stage === 'work') {
    const tasks=list(run?.taskViews).filter(task=>task.state!=='superseded');
    const working=tasks.filter(task=>task.state==='running');
    const attempts=(working.length?working:tasks).filter(task=>at(task.attempt?.startedAt)).map(task=>task.attempt);
    const start = attempts.map(attempt=>attempt.startedAt).sort((a,b)=>at(a)-at(b))[0] || null;
    const end = attempts.length && attempts.every(attempt=>at(attempt.endedAt)) ? attempts.map(attempt=>attempt.endedAt).sort((a,b)=>at(b)-at(a))[0] : null;
    return {start,end,active:active&&!end&&attempts.some(attempt=>!attempt.state||attempt.state==='running'),label:run?.workKind==='analysis'?'Analysis time':'Execution time'};
  }
  if (stage === 'intake' && at(request.route?.startedAt)) return {start:request.route.startedAt,end:request.route.decidedAt,active:active&&!request.route.decidedAt,label:'Routing time'};
  return null;
}

/** Derive this request only: a different project's row never supplies its owner or evidence. */
export function taskRailFacts({ request = {}, run: suppliedRun, events = [], agents = [], departments = [], projects = [], requests = [], runsLoaded = true, connected = true } = {}) {
  const requestRunId = request.runId || request.resumeRunId;
  const run = suppliedRun && suppliedRun.id === requestRunId && (!suppliedRun.projectId || suppliedRun.projectId === request.projectId) ? { ...suppliedRun, projectId: request.projectId } : null;
  const scopedEvents = orderedEvents(list(events).filter(event => (!event.runId || event.runId === requestRunId) && (!event.projectId || event.projectId === request.projectId) && visibleTaskEvent(event)));
  let journey = deriveFleetJourneys({ requests:[request], runs:run?[run]:[], agents, departments, eventPages:run?[{ runId:run.id, projectId:request.projectId, events:scopedEvents }]:[] })[0] || {};
  if(request.route?.state==='pending'&&['queued','received','routing','starting','running'].includes(request.state))journey={...journey,status:'Routing',tone:'running',active:true,waiting:false,stage:'intake',ownerIds:['control-center']};
  const successor = newerRunRequest(request, requests);
  if(successor)journey={...journey,status:'Continued in newer attempt',tone:'stopped',active:false,waiting:false,stage:null,ownerIds:[]};
  const loading = requestTaskStatus(request,run,requests,{runsLoaded}).bucket==='loading';
  if(loading)journey={...journey,status:'Loading result',tone:'idle',active:false,waiting:false,stage:null,ownerIds:[]};
  const department = list(departments).find(item => item.id === (request.route?.departmentId || request.departmentId));
  const agentName = id => list(agents).find(agent => agent.id === id)?.name || (id === 'control-center' ? 'Control Center' : id) || 'Not assigned yet';
  const tasks = list(run?.taskViews).filter(task => task.state !== 'superseded');
  const live = connected && !settled.has(request.state) && !['failed','cancelled','interrupted','ready_for_review','waiting'].includes(run?.state);
  const taskRows = tasks.map(task => {
    const event = [...scopedEvents].reverse().find(event => event.taskId === task.id && visibleTaskEvent(event)) || task.lastEvent;
    const fact = taskWorkStatus(task, run);
    const running = task.state === 'running' || task.state === 'validating' && run?.workKind !== 'analysis';
    const stateLabel = running && !live ? (connected ? 'Stopped' : 'Last known: ' + fact.label) : fact.label;
    return { id:task.id, ownerId:task.ownerAgentId || task.agentId, title:task.objective || task.title || 'Assigned task', owner:agentName(task.ownerAgentId || task.agentId), state:stateLabel, tone:running && !live?'stopped':fact.tone, action:event ? taskEventLabel(event) : task.waitReason === 'dependency' ? 'Waiting for another task to finish' : running ? 'Working on the assigned task' : '', updatedAt:event?.timestamp || task.attempt?.startedAt || '', duration:{start:task.attempt?.startedAt||null,end:task.attempt?.endedAt||null,active:live&&task.state==='running'&&!task.attempt?.endedAt&&(!task.attempt?.state||task.attempt.state==='running'),label:task.attempt?.endedAt?'Worker time':'Elapsed'}, passed:Number(task.receipts?.verifierExecutedPassed || 0), failed:Number(task.receipts?.verifierExecutedFailed || 0) };
  });
  const historicalSetupFailure = request.state === 'failed_to_start' && !request.runId && (request.result?.code === 'no_worker_on_project' || request.route?.code === 'no_worker_on_project');
  const phase = historicalSetupFailure ? 'Not started' : run?.workKind==='analysis'&&journey.stage==='work'?'Codebase analysis':run?.workKind==='analysis'&&['checks','review'].includes(journey.stage)?'Report review': ({ intake:'Understanding request', planning:'Planning', work:'Execution', checks:'Verification', review:'Head review', done:'Delivered' })[journey.stage] || (journey.status === 'Answered' ? 'Answer' : 'Status');
  const ownerIds = journey.ownerIds?.length ? journey.ownerIds : journey.stage === 'planning' || journey.stage === 'review' ? [department?.headAgentId].filter(Boolean) : [];
  const latest = [...scopedEvents].reverse().find(event => visibleTaskEvent(event));
  const blocker = successor ? 'Open the current attempt to follow this saved work.' : headReviewNeedsRetry(request, run) ? 'Final review needs attention. Resume the saved run to retry the review using its preserved work.' : journey.waiting && journey.tone === 'blocked' ? taskBlocker(request) : '';
  const action = blocker || (journey.waiting && verificationReason(run)) || (journey.active ? latest ? run?.workKind==='analysis'&&latest.type==='head.review_started'?'Reviewing the read-only report':taskEventLabel(latest) : journey.stage === 'planning' ? 'Matching the work to available specialists' : journey.stage === 'intake' ? 'Understanding the request and selecting the team' : 'Waiting for the next recorded action' : journey.status === 'Queued' ? taskBlocker(request) || 'Waiting for capacity. The coordinator will start this request automatically.' : journey.status === 'Reviewed analysis' ? 'The department head reviewed the findings. Project code is unchanged.' : journey.status === 'Verified' ? 'Checks passed and the department head reviewed the result.' : journey.status === 'Answered' ? 'Control Center has replied.' : journey.status === 'Stopped' ? 'Execution has stopped.' : journey.status || 'Waiting for recorded status');
  const verification = runVerificationFacts(run);
  const total = verification.total || 0, passed = verification.passed || 0;
  const analysisReady = run?.workKind === 'analysis' && run.analysis?.reviewed === true && run.analysis?.sourceUnchanged === true && run.analysis?.reportCount > 0 && Array.isArray(run.analysis?.evidenceIssues) && run.analysis.evidenceIssues.length === 0;
  const checks = run?.workKind === 'analysis' ? analysisReady ? `${run.analysis.reportCount} reviewed report${run.analysis.reportCount===1?'':'s'} · code unchanged` : 'Read-only analysis · report evidence pending' : total ? `${passed} of ${total} ${verification.source === 'delivery' ? 'independent' : 'required'} checks passed` : run ? 'No completed verification recorded yet' : requestRunId ? 'Execution evidence is not loaded yet' : 'Execution has not started';
  const latestText = [...scopedEvents].reverse().find(event => ['runtime.assistant_message','runtime.message','runtime.text','runtime.output'].includes(event.type) && typeof event.payload?.text === 'string' && !technical.test(event.payload.text));
  const requestDuration={start:request.receivedAt||request.startedAt||null,end:request.endedAt||request.heldAt||null,active:connected&&!settled.has(request.state),label:'Request time'};
  const phaseDuration=phaseTiming(journey.stage,request,run,scopedEvents,live&&!!journey.active,department?.headAgentId);
  return { requestDuration, phaseDuration, title:savedRequestText(request,run) || 'Recorded request', project:list(projects).find(project => project.id === request.projectId)?.name || request.projectId || 'Workspace', phase, status:connected ? (historicalSetupFailure ? 'Did not start' : blocker.startsWith('This earlier attempt') ? 'Could not start' : journey.status || 'Awaiting status') : 'Connection lost · last received status', tone:connected ? journey.tone || 'idle' : 'stopped', active:live && !!journey.active, owners:ownerIds.map(agentName), department:department?.name || '', action, tasks:taskRows, done:tasks.filter(task => task.state === 'accepted').length, total:tasks.length, checks, latestText:latestText?.payload?.text || '', connected };
}

function verificationReason(run) { return typeof run?.delivery?.reason === 'string' && run.delivery.verified !== true ? run.delivery.reason : ''; }

function conciseText(value, limit = 180) {
  const plain = string(value).replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = plain.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || plain;
  return sentence.length > limit ? sentence.slice(0, limit - 1).trimEnd() + '…' : sentence;
}

export function renderTaskRailSummary(input = {}) {
  const facts = taskRailFacts(input);
  const timeLabel = value => { const date=new Date(value); return Number.isFinite(date.getTime())?date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):''; };
  const taskMarkup = facts.tasks.map(task => {
    const brief = conciseText(task.title);
    const objective = task.title !== brief
      ? `<details class="cc-worker-brief" data-disclosure="brief:${escape(task.id)}"><summary>${escape(brief)}${icon('down')}</summary><p>${escape(task.title)}</p></details>`
      : `<p>${escape(brief)}</p>`;
    return `<article class="cc-worker-task" data-tone="${escape(task.tone)}">${avatar(task.owner,30,{id:task.ownerId})}<div><div class="cc-worker-title"><strong>${escape(task.owner)}</strong><span>${escape(task.state)}</span></div>${objective}${task.action?`<small>${escape(task.action)}${task.updatedAt?` · ${escape(timeLabel(task.updatedAt))}`:''}</small>`:''}${task.duration.start?`<small>${renderDuration(task.duration)}</small>`:''}${task.passed||task.failed?`<small>${task.passed} checks passed${task.failed?` · ${task.failed} failed`:''}</small>`:''}</div></article>`;
  }).join('');
  return `<section class="cc-work-summary" aria-label="Current task details">
    <div class="cc-work-summary-top"><span>${icon('folder')}${escape(facts.project)}</span><strong data-tone="${escape(facts.tone)}">${escape(facts.status)}</strong></div>
    <dl class="cc-work-facts"><div><dt>Phase</dt><dd>${escape(facts.phase)}</dd></div><div><dt>Handling this</dt><dd>${escape(facts.owners.join(', ') || facts.department || 'Control Center')}</dd></div></dl>
    <div class="cc-request-times">${facts.requestDuration.start?renderDuration(facts.requestDuration):''}${facts.phaseDuration?.start?renderDuration(facts.phaseDuration):''}</div>
    <p class="cc-current-action"><span>${facts.active?'Now':'Status'}</span>${escape(facts.action)}</p>
    ${facts.tasks.length?`<div class="cc-worker-heading"><strong>Team tasks</strong><span>${facts.done}/${facts.total} completed</span></div><div class="cc-worker-list">${taskMarkup}</div>`:''}
    <p class="cc-check-summary">${icon('shield')}${escape(facts.checks)}</p>
    ${facts.active && facts.latestText?`<div class="cc-latest-update"><strong>Latest agent update</strong><p>${escape(conciseText(facts.latestText, 240))}</p></div>`:''}
  </section>`;
}

/** Technical failure output remains available, without placing a terminal workflow in the answer. */
export function renderTaskReply(reply, request = {}, renderMarkdown, run) {
  if (!reply) return '';
  const isFailure = request.route?.state === 'blocked' || ['failed_to_start','failed','held'].includes(request.state) || (request.state === 'ended' && Number(request.exitCode) > 0);
  const structured = /^(?:```(?:json)?\s*)?[{[]/.test(string(reply).trim());
  if (isFailure && (technical.test(reply) || assignmentFailure(reply))) return `<details class="cc-original-response" data-disclosure="original:${escape(request.id)}"><summary>Original diagnostic ${icon('down')}</summary><div class="cc-answer">${renderMarkdown(reply)}</div></details>`;
  const completed = request.state === 'ended';
  const longReview = completed && (run || reply.length > 600 || /head.review|candidate.revision|check.receipt|verifierExecuted|artifactId|sha256/i.test(reply));
  if (structured || longReview) return `<div class="cc-answer"><p>${escape(taskResultSummary(reply,request,run))}</p></div><details class="cc-original-response" data-disclosure="response:${escape(request.id)}"><summary>${structured?'Technical response':run?.workKind==='analysis'?'Read full report':'Read full response and review'} ${icon('down')}</summary><div class="cc-answer">${renderMarkdown(reply)}</div></details>`;
  return `<div class="cc-answer">${renderMarkdown(reply)}</div>`;
}
