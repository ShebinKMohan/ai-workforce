import { avatar, escape, icon } from './ui.js';
import { deriveFleetJourneys } from './fleet-activity.js';
import { taskWorkStatus } from './task-status.js';

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
  if (!original) return '';
  if (technical.test(original) || original.length > 500 || original.includes('\n')) return 'The runtime could not continue. Its recorded diagnostic is available below.';
  return original;
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

/** Derive this request only: a different project's row never supplies its owner or evidence. */
export function taskRailFacts({ request = {}, run: suppliedRun, events = [], agents = [], departments = [], projects = [], connected = true } = {}) {
  const requestRunId = request.runId || request.resumeRunId;
  const run = suppliedRun && suppliedRun.id === requestRunId && (!suppliedRun.projectId || suppliedRun.projectId === request.projectId) ? { ...suppliedRun, projectId: request.projectId } : null;
  const scopedEvents = list(events).filter(event => (!event.runId || event.runId === requestRunId) && (!event.projectId || event.projectId === request.projectId));
  const journey = deriveFleetJourneys({ requests:[request], runs:run?[run]:[], agents, departments, eventPages:run?[{ runId:run.id, projectId:request.projectId, events:scopedEvents }]:[] })[0] || {};
  const department = list(departments).find(item => item.id === (request.route?.departmentId || request.departmentId));
  const agentName = id => list(agents).find(agent => agent.id === id)?.name || (id === 'control-center' ? 'Control Center' : id) || 'Not assigned yet';
  const tasks = list(run?.taskViews).filter(task => task.state !== 'superseded');
  const live = connected && !settled.has(request.state) && !['failed','cancelled','interrupted','ready_for_review','waiting'].includes(run?.state);
  const taskRows = tasks.map(task => {
    const event = [...scopedEvents].reverse().find(event => event.taskId === task.id && !['runtime.raw','runtime.reasoning','runtime.reasoning_delta','runtime.usage','runtime.output_delta'].includes(event.type)) || task.lastEvent;
    const fact = taskWorkStatus(task);
    const running = ['running', 'validating'].includes(task.state);
    const stateLabel = running && !live ? (connected ? 'Stopped' : 'Last known: ' + fact.label) : fact.label;
    return { id:task.id, ownerId:task.ownerAgentId || task.agentId, title:task.objective || task.title || 'Assigned task', owner:agentName(task.ownerAgentId || task.agentId), state:stateLabel, tone:running && !live?'stopped':fact.tone, action:event ? taskEventLabel(event) : task.waitReason === 'dependency' ? 'Waiting for another task to finish' : running ? 'Working on the assigned task' : '', updatedAt:event?.timestamp || task.attempt?.startedAt || '', passed:Number(task.receipts?.verifierExecutedPassed || 0), failed:Number(task.receipts?.verifierExecutedFailed || 0) };
  });
  const historicalSetupFailure = request.state === 'failed_to_start' && !request.runId && (request.result?.code === 'no_worker_on_project' || request.route?.code === 'no_worker_on_project');
  const phase = historicalSetupFailure ? 'Not started' : ({ intake:'Understanding request', planning:'Planning', work:'Execution', checks:'Verification', review:'Head review', done:'Delivered' })[journey.stage] || (journey.status === 'Answered' ? 'Answer' : 'Status');
  const ownerIds = journey.ownerIds?.length ? journey.ownerIds : journey.stage === 'planning' || journey.stage === 'review' ? [department?.headAgentId].filter(Boolean) : [];
  const latest = [...scopedEvents].reverse().find(event => !['runtime.raw','runtime.reasoning','runtime.reasoning_delta','runtime.usage','runtime.output_delta'].includes(event.type));
  const blocker = journey.waiting && journey.tone === 'blocked' ? taskBlocker(request) : '';
  const action = blocker || (journey.active ? latest ? taskEventLabel(latest) : journey.stage === 'planning' ? 'Matching the work to available specialists' : journey.stage === 'intake' ? 'Understanding the request and selecting the team' : 'Waiting for the next recorded action' : journey.status === 'Queued' ? taskBlocker(request) || 'Waiting for capacity. The coordinator will start this request automatically.' : journey.status === 'Reviewed analysis' ? 'The department head reviewed the findings. Project code is unchanged.' : journey.status === 'Verified' ? 'Checks passed and the department head reviewed the result.' : journey.status === 'Answered' ? 'Control Center has replied.' : journey.status === 'Stopped' ? 'Execution has stopped.' : journey.status || 'Waiting for recorded status');
  const evidence = run?.outcome;
  const total = Number(evidence?.requiredTotal || 0), passed = Number(evidence?.requiredPassed || 0);
  const analysisReady = run?.workKind === 'analysis' && run.analysis?.reviewed === true && run.analysis?.sourceUnchanged === true && run.analysis?.reportCount > 0 && Array.isArray(run.analysis?.evidenceIssues) && run.analysis.evidenceIssues.length === 0;
  const checks = run?.workKind === 'analysis' ? analysisReady ? `${run.analysis.reportCount} reviewed report${run.analysis.reportCount===1?'':'s'} · code unchanged` : 'Read-only analysis · report evidence pending' : total ? `${passed} of ${total} required checks passed` : run ? 'No completed verification recorded yet' : requestRunId ? 'Execution evidence is not loaded yet' : 'Execution has not started';
  const latestText = [...scopedEvents].reverse().find(event => ['runtime.assistant_message','runtime.message','runtime.text','runtime.output'].includes(event.type) && typeof event.payload?.text === 'string' && !technical.test(event.payload.text));
  return { title:request.task || 'Recorded request', project:list(projects).find(project => project.id === request.projectId)?.name || request.projectId || 'Workspace', phase, status:connected ? (historicalSetupFailure ? 'Did not start' : blocker.startsWith('This earlier attempt') ? 'Could not start' : journey.status || 'Awaiting status') : 'Connection lost · last received status', tone:connected ? journey.tone || 'idle' : 'stopped', active:live && !!journey.active, owners:ownerIds.map(agentName), department:department?.name || '', action, tasks:taskRows, done:tasks.filter(task => task.state === 'accepted').length, total:tasks.length, checks, latestText:latestText?.payload?.text || '', connected };
}

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
    return `<article class="cc-worker-task" data-tone="${escape(task.tone)}">${avatar(task.owner,30,{id:task.ownerId})}<div><div class="cc-worker-title"><strong>${escape(task.owner)}</strong><span>${escape(task.state)}</span></div>${objective}${task.action?`<small>${escape(task.action)}${task.updatedAt?` · ${escape(timeLabel(task.updatedAt))}`:''}</small>`:''}${task.passed||task.failed?`<small>${task.passed} checks passed${task.failed?` · ${task.failed} failed`:''}</small>`:''}</div></article>`;
  }).join('');
  return `<section class="cc-work-summary" aria-label="Current task details">
    <div class="cc-work-summary-top"><span>${icon('folder')}${escape(facts.project)}</span><strong data-tone="${escape(facts.tone)}">${escape(facts.status)}</strong></div>
    <dl class="cc-work-facts"><div><dt>Phase</dt><dd>${escape(facts.phase)}</dd></div><div><dt>Handling this</dt><dd>${escape(facts.owners.join(', ') || facts.department || 'Control Center')}</dd></div></dl>
    <p class="cc-current-action"><span>${facts.active?'Now':'Status'}</span>${escape(facts.action)}</p>
    ${facts.tasks.length?`<div class="cc-worker-heading"><strong>Team tasks</strong><span>${facts.done}/${facts.total} completed</span></div><div class="cc-worker-list">${taskMarkup}</div>`:''}
    <p class="cc-check-summary">${icon('shield')}${escape(facts.checks)}</p>
    ${facts.active && facts.latestText?`<div class="cc-latest-update"><strong>Latest agent update</strong><p>${escape(conciseText(facts.latestText, 240))}</p></div>`:''}
  </section>`;
}

/** Technical failure output remains available, without placing a terminal workflow in the answer. */
export function renderTaskReply(reply, request, renderMarkdown) {
  if (!reply) return '';
  const isFailure = request.route?.state === 'blocked' || ['failed_to_start','failed','held'].includes(request.state) || (request.state === 'ended' && Number(request.exitCode) > 0);
  if (isFailure && (technical.test(reply) || assignmentFailure(reply))) return `<details class="cc-original-response" data-disclosure="original:${escape(request.id)}"><summary>Original diagnostic ${icon('down')}</summary><div class="cc-answer">${renderMarkdown(reply)}</div></details>`;
  return `<div class="cc-answer">${renderMarkdown(reply)}</div>`;
}
