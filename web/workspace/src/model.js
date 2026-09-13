/**
 * The page's view models: pure functions from the documents the server
 * returned to plain values the pages render. No DOM, no fetch, and no clock of
 * their own (a `now` is passed in), so every rule here is tested in Node
 * against real payloads.
 *
 * Inputs:
 * - GET /api/workspace (the workspace, readiness, checks, coding tools)
 * - GET /api/runs (runs across every project, each with its project's lock)
 * - GET /api/requests (the page server's queue)
 * - GET /api/projects/:id/runs/:runId (the status document)
 * - GET /api/projects/:id/runs/:runId/events (every event of one run)
 *
 * The honesty contract (see truth.js) holds here too: green only for a part the
 * verifier's own passing check backs; live rows under a free lock are Stalled;
 * a runtime saying "done" marks nothing; no percentages; empty is empty.
 */
import { clip, isStalledRun, isVerifiedTask, LIVE_RUN_STATES, taskPhase, checkView } from './truth.js';
import { COLOR_HEX, PHASES, plainReason, plural, TASK_STATUS, toolName } from './words.js';
import { runtimeReport } from './runtime-settings.js';

const list = (value) => (Array.isArray(value) ? value : []);
const firstLine = (text) => String(text ?? '').trim().split('\n', 1)[0] ?? '';

// ---------------------------------------------------------------------------
// The workspace, indexed
// ---------------------------------------------------------------------------

/**
 * Two-letter project chips (§6.7): computed over every project, archived ones
 * included, in the order they were added, so a chip never changes.
 */
export function projectMonograms(projects) {
  const taken = new Set();
  const chips = new Map();
  for (const project of list(projects)) {
    const name = String(project?.name || project?.id || 'project');
    const words = name.split(/[\s\-_.]+/).filter(Boolean);
    const letters = name.replace(/[^A-Za-z0-9]/g, '');
    const first = (letters[0] ?? 'P').toUpperCase();
    const candidates = [];
    if (words.length >= 2) candidates.push(`${words[0][0]}${words[1][0]}`);
    else if (letters.length >= 2) candidates.push(letters.slice(0, 2));
    for (const character of letters.slice(1)) candidates.push(`${first}${character}`);
    for (let digit = 2; digit <= 9; digit += 1) candidates.push(`${first}${digit}`);
    const chosen = candidates.map((candidate) => candidate.toUpperCase()).find((candidate) => !taken.has(candidate)) ?? `${first}?`;
    taken.add(chosen);
    chips.set(project.id, chosen);
  }
  return chips;
}

export function indexWorkspace(doc) {
  const config = doc?.workspace ?? null;
  const projects = list(config?.projects);
  const departments = list(config?.departments);
  const agents = list(config?.agents);
  const reports = list(doc?.runtimes?.reports);
  return {
    doc,
    config,
    ok: config !== null,
    error: doc?.error ?? null,
    exists: doc?.exists === true,
    path: doc?.path ?? null,
    revision: typeof doc?.revision === 'number' ? doc.revision : null,
    projects,
    liveProjects: projects.filter((project) => !project.archived),
    departments,
    liveDepartments: departments.filter((department) => !department.archived),
    agents,
    liveAgents: agents.filter((agent) => !agent.archived),
    projectById: new Map(projects.map((project) => [project.id, project])),
    departmentById: new Map(departments.map((department) => [department.id, department])),
    agentById: new Map(agents.map((agent) => [agent.id, agent])),
    checks: new Map(list(doc?.checks).map((fact) => [fact.projectId, fact])),
    reports,
    // Installation discovery and a configured binding are different facts.
    // A later custom-path report must never replace generic tool discovery.
    reportByAdapter: new Map(reports.filter((report) => !report.runtimeId).map((report) => [report.adapter, report])),
    toolsCheckedAt: doc?.runtimes?.checkedAt ?? null,
    toolsError: doc?.runtimes?.error ?? null,
    readiness: doc?.readiness ?? null,
    eligibility: new Map(list(doc?.readiness?.eligibility).map((pair) => [`${pair.departmentId}|${pair.projectId}`, pair])),
    monograms: projectMonograms(projects),
    showChips: projects.filter((project) => !project.archived).length >= 2,
    runtimeRules: doc?.runtimeRules ?? {},
    limits: config?.limits ?? null,
    suggestedStarter: doc?.suggestedStarter ?? null,
    legacyAgents: doc?.legacyAgents ?? null,
  };
}

export const projectName = (ws, id) => ws.projectById.get(id)?.name ?? id ?? 'unknown project';
export const agentName = (ws, id) => ws.agentById.get(id)?.name ?? id ?? 'someone';

/** "Engineering · Payments" when a note exists; "Engineering (Atlas)" when the name repeats with no note. */
export function departmentLabel(ws, departmentOrId) {
  const department = typeof departmentOrId === 'string' ? ws.departmentById.get(departmentOrId) : departmentOrId;
  if (!department) return typeof departmentOrId === 'string' ? departmentOrId : 'unknown department';
  if (department.note) return `${department.name} · ${department.note}`;
  const repeated = ws.departments.some((other) => other.id !== department.id && !other.archived && other.name.trim().toLowerCase() === department.name.trim().toLowerCase());
  if (!repeated) return department.name;
  const head = department.headAgentId ? ws.agentById.get(department.headAgentId) : null;
  return head ? `${department.name} (${head.name})` : `${department.name} (${department.id})`;
}

export const departmentHex = (department) => COLOR_HEX[department?.color] ?? '#819b92';

export function adapterOf(ws, runtimeId) {
  const configured = ws.config?.runtimes?.[runtimeId]?.adapter;
  if (configured) return configured;
  if (runtimeId === 'codex-local' || runtimeId === 'codex') return 'codex';
  if (runtimeId === 'claude-local' || runtimeId === 'claude-code') return 'claude-code';
  return runtimeId;
}

/**
 * What passive discovery said about a coding tool, in words. `ready` is null
 * when discovery does not cover the tool (the test tool): not judged, never
 * claimed ready.
 */
export function toolFact(ws, adapter, runtimeId = null) {
  const binding = runtimeId ? ws.config?.runtimes?.[runtimeId] : null;
  const report = runtimeId ? (binding ? runtimeReport(ws.reports, runtimeId, binding) : null) : ws.reportByAdapter.get(adapter);
  const name = toolName(adapter);
  if (!report) return { adapter, name, ready: null, word: 'not checked', version: null, loginHint: null, report: null };
  const base = { adapter, name, version: report.version ?? null, loginHint: report.loginHint ?? null, report };
  if (!report.installed) return { ...base, ready: false, word: 'not found' };
  if (report.auth === 'logged_out') return { ...base, ready: false, word: 'signed out' };
  if (!report.adapterSupported) return { ...base, ready: false, word: 'this version is not supported' };
  if (report.controllable === false) return { ...base, ready: false, word: 'runtime controls unavailable' };
  if (report.auth === 'logged_in') return { ...base, ready: true, word: 'signed in' };
  return { ...base, ready: true, word: 'sign-in not confirmed' };
}

export const agentTool = (ws, agent) => toolFact(ws, adapterOf(ws, agent?.runtime), agent?.runtime);

/** Whether a runtime's file boundary is verified, and so whether a task using it runs on its own (decision Q2). */
export function runtimeBoundary(ws, runtimeId) {
  const binding = ws.config?.runtimes?.[runtimeId];
  const savedRule = ws.runtimeRules?.[runtimeId];
  const rule = savedRule && (!binding || !savedRule.executable || savedRule.executable === binding.executable) ? savedRule : null;
  const adapter = adapterOf(ws, runtimeId);
  const report = binding ? runtimeReport(ws.reports, runtimeId, binding) : null;
  const containment = rule?.writeContainment ?? report?.writeContainment ?? 'unknown';
  const requiresWriteConsent = rule?.requiresWriteConsent ?? containment !== 'verified';
  return { adapter, containment, verified: containment === 'verified' && !requiresWriteConsent, requiresWriteConsent,
    installedVersion: rule?.installedVersion ?? report?.version ?? null, testedVersion: rule?.testedVersion ?? null,
    runsOnItsOwn: rule?.runsOnItsOwn ?? containment !== 'verified' };
}

export function departmentWorkers(ws, departmentId) {
  return ws.liveAgents.filter((agent) => agent.role === 'worker' && agent.departmentId === departmentId);
}

export function departmentHead(ws, departmentId) {
  const department = ws.departmentById.get(departmentId);
  const head = department?.headAgentId ? ws.agentById.get(department.headAgentId) : null;
  return head && !head.archived && head.role === 'head' ? head : null;
}

export function projectChecks(ws, projectId) {
  const project = ws.projectById.get(projectId);
  const fact = ws.checks.get(projectId) ?? null;
  const count = project && project.checks.length > 0 ? project.checks.length : (fact?.count ?? null);
  return { count, fact, configured: project?.checks ?? [], unknown: count === null };
}

/**
 * Why a (department, project) pair cannot take tasks, in plain words.
 * Empty when it can.
 */
export function pairBlockers(ws, departmentId, projectId) {
  const pair = ws.eligibility.get(`${departmentId}|${projectId}`);
  if (!pair) return ['This department and project were not found in the workspace.'];
  const department = departmentLabel(ws, departmentId);
  const project = projectName(ws, projectId);
  const lines = [];
  for (const code of pair.codes) {
    if (code === 'project_archived') lines.push(`${project} is archived.`);
    else if (code === 'department_archived') lines.push(`${department} is archived.`);
    else if (code === 'department_has_no_head') lines.push(`${department} has no department head.`);
    else if (code === 'no_worker_on_project') lines.push(`Nobody in ${department} works on ${project}.`);
    else if (code === 'project_has_no_checks') lines.push(`${project} has no checks yet, so nothing there could be verified.`);
    else if (code === 'project_checks_unknown') lines.push(`${project}'s checks could not be read: ${ws.checks.get(projectId)?.detail ?? 'the folder could not be read'}.`);
    else if (code === 'runtime_not_ready') {
      const head = departmentHead(ws, departmentId);
      const headTool = head ? agentTool(ws, head) : null;
      if (headTool && headTool.ready === false) lines.push(`${head.name}, the department head, uses ${headTool.name}, which is ${headTool.word}.`);
      else lines.push(`No worker of ${department} on ${project} has a coding tool that is ready.`);
    } else lines.push(code);
  }
  return lines;
}

export const pairSendable = (ws, departmentId, projectId) => ws.eligibility.get(`${departmentId}|${projectId}`)?.sendable === true;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const STEP_ORDER = ['tools', 'project', 'department', 'send'];

/** Rows for "Check your coding tools". */
export function toolRows(ws) {
  if (ws.toolsError) return [{ tone: 'failed', line: `Could not check for coding tools: ${ws.toolsError}. Nothing was started.` }];
  if (ws.reports.length === 0) return [{ tone: 'attention', line: 'No coding tool was reported. AI Workforce works with Codex and Claude Code.' }];
  return [...ws.reportByAdapter.values()].map((report) => {
    const fact = toolFact(ws, report.adapter);
    const title = `${fact.name}${fact.version ? ` ${fact.version}` : ''}`;
    let line = `${title} · ${fact.word}${fact.ready ? ' (as the tool reports)' : ''}`;
    if (fact.word === 'signed out' && fact.loginHint) line += `. To use it, run: ${fact.loginHint}`;
    const notes = [];
    if (fact.ready && report.writeContainment && report.writeContainment !== 'verified') {
      notes.push(`AI Workforce cannot keep ${fact.name}'s changes inside its own copy, so a task that uses it runs on its own and asks you first.`);
    }
    return { tone: fact.ready ? 'neutral' : 'attention', line, notes, adapter: report.adapter };
  });
}

export function setupModel(ws, requestsDoc, runsDoc) {
  const steps = new Map(list(ws.readiness?.steps).map((step) => [step.id, step]));
  const done = (id) => steps.get(id)?.state === 'done';
  const hasTask = list(requestsDoc?.items).some((item) => item.kind === 'request') || list(runsDoc?.runs).some((run) => run.projectId);
  const allDone = STEP_ORDER.every(done);
  const firstIncomplete = STEP_ORDER.find((id) => !done(id)) ?? null;
  const projectsWithoutChecks = ws.liveProjects.filter((project) => projectChecks(ws, project.id).count === 0);

  const rows = STEP_ORDER.map((id, index) => {
    const state = done(id) ? 'done' : id === firstIncomplete ? 'current' : 'locked';
    const row = { id, number: index + 1, state, lines: [], action: null, secondary: null, quiet: null, note: null };
    if (id === 'tools') {
      row.tools = toolRows(ws);
      if (state === 'done') row.quiet = { kind: 'refresh', label: 'Check again' };
      else row.action = { kind: 'refresh', label: 'Check again' };
    } else if (id === 'project') {
      for (const project of projectsWithoutChecks) row.lines.push({ text: `${project.name} is added, but has no checks yet, so nothing in it could be verified.`, link: { href: `#/projects/${project.id}`, label: `Add a check to ${project.name}` } });
      for (const project of ws.liveProjects.filter((entry) => projectChecks(ws, entry.id).unknown)) {
        row.lines.push({ text: `${project.name}'s checks could not be read: ${ws.checks.get(project.id)?.detail ?? 'unknown'}.`, link: { href: `#/projects/${project.id}`, label: `Open ${project.name}` } });
      }
      if (state === 'current') row.action = { kind: 'sheet', sheet: 'add-project', label: 'Add a project' };
      else if (state === 'locked' && firstIncomplete === 'tools') row.secondary = { kind: 'sheet', sheet: 'add-project', label: 'Add a project', note: 'Adding a project does not need a coding tool.' };
    } else if (id === 'department') {
      if (state === 'current') row.action = { kind: 'link', href: '#/departments/new', label: 'Create a department' };
      else if (state === 'locked') row.note = 'Opens after you add a project with a check.';
      if (state !== 'done' && ws.legacyAgents?.agentCount) {
        row.lines.push({ text: `An earlier setup was found with ${plural(ws.legacyAgents.agentCount, 'agent')}. Import instructions are in Settings.`, link: { href: '#/settings', label: 'Open Settings' } });
      }
    } else if (id === 'send') {
      if (state === 'current') row.action = { kind: 'sheet', sheet: 'new-task', label: 'Send your first task' };
      else if (state === 'locked') row.note = nearestBlocker(ws) ?? 'Opens once a department has a worker on a project with a check.';
    }
    return row;
  });

  const readyCard = allDone && !hasTask ? { lines: departmentReadiness(ws) } : null;
  return { showChecklist: ws.ok && !allDone, allDone, hasTask, firstIncomplete, stepNumber: firstIncomplete ? STEP_ORDER.indexOf(firstIncomplete) + 1 : null, rows, readyCard };
}

function nearestBlocker(ws) {
  for (const department of ws.liveDepartments) {
    for (const project of ws.liveProjects) {
      const blockers = pairBlockers(ws, department.id, project.id);
      if (blockers.length > 0) return blockers[0];
    }
  }
  return null;
}

/** "Engineering can take tasks on Storefront and docs-site." / "Design cannot take tasks yet: ..." */
export function departmentReadiness(ws) {
  return ws.liveDepartments.map((department) => {
    const label = departmentLabel(ws, department);
    const sendable = ws.liveProjects.filter((project) => pairSendable(ws, department.id, project.id));
    if (sendable.length > 0) return { departmentId: department.id, ok: true, text: `${label} can take tasks on ${joinWords(sendable.map((project) => project.name))}.` };
    const first = ws.liveProjects.map((project) => pairBlockers(ws, department.id, project.id)).find((lines) => lines.length > 0);
    return { departmentId: department.id, ok: false, text: `${label} cannot take tasks yet. ${first?.[0] ?? 'There is no project yet.'}` };
  });
}

export function joinWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Tasks: requests from this page and runs from anywhere, as one list
// ---------------------------------------------------------------------------

const ACTIVE_ITEM_STATES = new Set(['queued', 'held', 'starting', 'running']);

function ownerDepartment(ws, run) {
  const departments = new Set(list(run?.taskViews).map((task) => ws.agentById.get(task.ownerAgentId)?.departmentId).filter(Boolean));
  return departments.size === 1 ? [...departments][0] : null;
}

const RESULT_WORDS = {
  plan_rejected: 'The department head did not produce a usable plan, so no worker was started.',
  project_run_in_progress: 'Another task was already running on this project.',
  runtime_not_ready: 'A coding tool this department needs was not ready.',
  head_runtime_not_logged_in: "The department head's coding tool is signed out.",
  head_runtime_unavailable: "The department head's coding tool could not be started.",
  no_acceptance_checks: 'The project has no checks, so nothing could be verified.',
  project_has_no_checks: 'The project has no checks, so nothing could be verified.',
  interrupted: 'Stopped before anything started.',
};

/** The plain reason a request process gave for ending without a verified result. */
export function resultLine(result) {
  if (!result) return null;
  if (result.code && RESULT_WORDS[result.code]) return RESULT_WORDS[result.code];
  if (result.message) return clip(result.message.charAt(0).toUpperCase() + result.message.slice(1), 180);
  return null;
}

function status(key, line = null) {
  return { key, word: TASK_STATUS[key].word, tone: TASK_STATUS[key].tone, line };
}

function workerList(ws, tasks, predicate) {
  const names = [...new Set(tasks.filter(predicate).map((task) => agentName(ws, task.ownerAgentId)))];
  return joinWords(names);
}

/** A successful conversational reply creates no development run or review obligation. */
export function isDirectControlReply(item) {
  return Boolean(item && !item.runId && item.state === 'ended' && item.route?.method === 'direct_reply'
    && item.result?.code === 'control_reply' && (item.exitCode ?? item.result?.exitCode) === 0
    && typeof item.controlReply === 'string' && item.controlReply.trim());
}

/** A task's status word and line, from its request item, its run summary and that project's lock. */
export function taskStatus(ws, { item, run, resumes }) {
  const lock = run?.projectLock ?? null;
  const resume = list(resumes).find((entry) => ACTIVE_ITEM_STATES.has(entry.state)) ?? null;
  if (item && !run) {
    if (isDirectControlReply(item)) return status('answered', 'Control Center replied without starting a development task.');
    if (item.state === 'queued') return status('waiting', plainReason(item.reason) ?? 'Waiting to start.');
    if (item.state === 'held') return status('held', 'It was still waiting when the page server stopped, so it was not started. Start it or discard it.');
    if (item.state === 'discarded') return status('discarded', 'Discarded before it started. Nothing ran.');
    if (item.state === 'failed_to_start') return status('notStarted', resultLine(item.result) ?? 'AI Workforce could not start it.');
    if (item.state === 'starting' || item.state === 'running') return item.stopRequestedAt ? status('stopping', plainReason(item.reason) ?? 'A stop was requested.') : status('starting', 'Starting. The department head plans first.');
    if (item.state === 'ended') {
      if (item.result?.code === 'plan_rejected') return status('noPlan', resultLine(item.result));
      if (item.runId) return status('ended', 'Ended. Open it to see what was recorded.');
      return status('notStarted', resultLine(item.result) ?? 'It ended before anything was recorded.');
    }
  }
  if (!run) return status('ended', null);
  if (isStalledRun(run, lock)) {
    if (resume) return status('waiting', resume.state === 'queued' ? plainReason(resume.reason) ?? 'Resume is waiting to start.' : 'Resuming.');
    return status('stalled', 'Nothing is running this task. Resume it to continue.');
  }
  const tasks = list(run.taskViews);
  const headReview = run.headReview;
  const reviewHead = headReview?.headAgentId ? agentName(ws, headReview.headAgentId) : 'The department head';
  if (LIVE_RUN_STATES.has(run.state) && item?.stopRequestedAt) return status('stopping', 'A stop was requested. Waiting for it to take effect.');
  if (LIVE_RUN_STATES.has(run.state) && headReview?.state === 'running') return status('headReviewing', `${reviewHead} is reviewing the result and the recorded checks.`);
  if (run.state === 'failed' && (headReview?.verdict === 'changes_requested' || headReview?.state === 'changes_requested')) return status('headReviewChanges', `${reviewHead} requested changes.${headReview.summary ? ` ${clip(headReview.summary, 220)}` : ''}`);
  if (LIVE_RUN_STATES.has(run.state)) {
    if (item?.stopRequestedAt) return status('stopping', 'A stop was requested. Waiting for it to take effect.');
    if (tasks.length === 0) {
      const head = departmentHead(ws, item?.departmentId ?? ownerDepartment(ws, run));
      return status('planning', `${head ? head.name : 'The department head'} is planning.`);
    }
    const phases = tasks.map(taskPhase);
    if (phases.includes('working')) return status('working', `${workerList(ws, tasks, (task) => taskPhase(task) === 'working')} ${tasks.filter((task) => taskPhase(task) === 'working').length === 1 ? 'is' : 'are'} working.`);
    if (phases.includes('verifying')) return status('checking', `The verifier is checking ${workerList(ws, tasks, (task) => taskPhase(task) === 'verifying')}'s part.`);
    if (phases.includes('starting')) return status('working', 'A worker is getting its own copy of the project.');
    const settled = tasks.filter((task) => !phases[tasks.indexOf(task)]);
    if (settled.length === tasks.length) return status('checking', 'Every part has settled. Putting the parts together.');
    const waiting = tasks.find((task) => task.waitReason);
    return status('waiting', waiting ? `Waiting: ${String(waiting.waitReason).replace(/_/g, ' ')}.` : 'Waiting to start.');
  }
  if (run.state === 'ready_for_review') {
    const verified = tasks.filter(isVerifiedTask).length;
    if (list(run.evidenceIssues).length > 0) return status('unverified', 'Some saved evidence is missing or has changed. Open the task to inspect it.');
    if (tasks.length > 0 && verified === tasks.length) return status('verified', `${plural(tasks.length, 'part')} verified by checks the verifier ran. Ready for your review.`);
    return status('unverified', `${verified} of ${plural(tasks.length, 'part')} rest on a passing check the verifier ran.`);
  }
  if (run.state === 'interrupted') {
    if (resume) return status('waiting', resume.state === 'queued' ? plainReason(resume.reason) ?? 'Resume is waiting to start.' : 'Resuming.');
    return status('interrupted', 'Stopped before it finished. Resume it to finish the remaining parts.');
  }
  if (run.state === 'failed') {
    if (item?.result?.code === 'plan_rejected') return status('noPlan', resultLine(item.result));
    if (tasks.length === 0) return status('failed', resultLine(item?.result) ?? 'It ended before any part was started.');
    const verified = tasks.filter(isVerifiedTask).length;
    return status('failed', `${verified} of ${plural(tasks.length, 'part')} verified.`);
  }
  if (run.state === 'cancelled') return status('ended', 'Cancelled.');
  return status('ended', null);
}

const IN_MOTION = new Set(['waiting', 'starting', 'planning', 'working', 'checking', 'stopping', 'headReviewing']);
const FINISHED = new Set(['verified', 'unverified', 'failed', 'noPlan', 'notStarted', 'discarded', 'ended', 'answered', 'headReviewChanges']);

export function taskHref(entry) {
  return entry.item ? `#/tasks/q/${encodeURIComponent(entry.item.id)}` : `#/tasks/${encodeURIComponent(entry.projectId)}/${encodeURIComponent(entry.runId)}`;
}

function makeEntry(ws, { item, run, projectId, runId, resumes }) {
  const at = item?.receivedAt ?? run?.createdAt ?? null;
  const entry = {
    key: item ? `q:${item.id}` : `r:${projectId}:${runId}`,
    item,
    run,
    projectId,
    runId: runId ?? null,
    resumes: list(resumes),
    departmentId: item?.departmentId ?? ownerDepartment(ws, run),
    title: firstLine(item?.task ?? run?.request?.text) || 'Untitled task',
    at,
    fromThisPage: Boolean(item),
  };
  entry.href = taskHref(entry);
  entry.status = taskStatus(ws, entry);
  entry.inMotion = IN_MOTION.has(entry.status.key);
  entry.finished = FINISHED.has(entry.status.key);
  entry.needsYou = needsYouFor(ws, entry);
  return entry;
}

/** Every task, newest first: each request this page sent (with its run once it has one), then runs started elsewhere. */
export function taskEntries(ws, runsDoc, requestsDoc) {
  const items = list(requestsDoc?.items);
  const runs = list(runsDoc?.runs).filter((run) => run.projectId);
  const runByKey = new Map(runs.map((run) => [`${run.projectId}:${run.id}`, run]));
  const claimed = new Set();
  const resumesFor = (projectId, runId) => items.filter((entry) => entry.kind === 'resume' && entry.projectId === projectId && entry.resumeRunId === runId);
  const entries = [];
  for (const item of items) {
    if (item.kind !== 'request') continue;
    const key = item.runId ? `${item.projectId}:${item.runId}` : null;
    if (key) claimed.add(key);
    entries.push(makeEntry(ws, { item, run: key ? runByKey.get(key) ?? null : null, projectId: item.projectId, runId: item.runId, resumes: item.runId ? resumesFor(item.projectId, item.runId) : [] }));
  }
  for (const run of runs) {
    if (claimed.has(`${run.projectId}:${run.id}`)) continue;
    entries.push(makeEntry(ws, { item: null, run, projectId: run.projectId, runId: run.id, resumes: resumesFor(run.projectId, run.id) }));
  }
  return entries.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

/** Find the entry a task route names: `q/<requestId>` or `<projectId>/<runId>`. A request that has a run is found by either. */
export function findEntry(entries, route) {
  if (route.requestId) return entries.find((entry) => entry.item?.id === route.requestId) ?? null;
  return entries.find((entry) => entry.projectId === route.projectId && entry.runId === route.runId) ?? null;
}

// ---------------------------------------------------------------------------
// Needs you and In motion
// ---------------------------------------------------------------------------

/**
 * The Needs you item for one task, or null. `hideable` is false for items a
 * record clears (held, stopped, stalled): hiding those would hide a decision.
 */
export function needsYouFor(ws, entry) {
  const project = projectName(ws, entry.projectId);
  const title = `"${clip(entry.title, 80)}" on ${project}`;
  const base = { id: entry.key, projectId: entry.projectId, requestId: entry.item?.id ?? null, runId: entry.runId, href: entry.href, word: entry.status.word, tone: entry.status.tone };
  switch (entry.status.key) {
    case 'held':
      return { ...base, kind: 'held', hideable: false, line: `${title} was still waiting when the page server stopped, so it was not started.`, actions: ['start', 'discard'] };
    case 'interrupted':
      return { ...base, kind: 'interrupted', hideable: false, line: `${title} stopped before it finished. Nothing is working on it.`, actions: ['resume'] };
    case 'stalled':
      return { ...base, kind: 'stalled', hideable: false, line: `${title}: nothing is running it, although its record says it was in progress.`, actions: ['resume'] };
    case 'verified':
      return { ...base, kind: 'review', hideable: true, line: `${title} is ready for your review. ${entry.status.line}`, actions: ['open'] };
    case 'unverified':
      return { ...base, kind: 'review', hideable: true, line: `${title} finished, but not every part rests on a passing check the verifier ran.`, actions: ['open'] };
    case 'headReviewChanges':
      return { ...base, kind: 'review', hideable: true, line: `${title}. ${entry.status.line}`, actions: ['open'] };
    case 'failed':
    case 'noPlan':
    case 'notStarted':
      return { ...base, kind: 'failed', hideable: true, line: `${title}. ${entry.status.line ?? 'It ended without a verified result.'}`, actions: ['open'] };
    default:
      return null;
  }
}

/** A coding tool a head or worker depends on is signed out or missing. It clears when discovery says otherwise. */
export function toolNeeds(ws) {
  const items = [];
  const byAdapter = new Map();
  for (const agent of ws.liveAgents) {
    const fact = agentTool(ws, agent);
    if (fact.ready !== false) continue;
    if (!byAdapter.has(fact.adapter)) byAdapter.set(fact.adapter, { fact, agents: [] });
    byAdapter.get(fact.adapter).agents.push(agent);
  }
  for (const { fact, agents } of byAdapter.values()) {
    const who = joinWords(agents.slice(0, 4).map((agent) => agent.name)) + (agents.length > 4 ? ` and ${agents.length - 4} more` : '');
    const hint = fact.word === 'signed out' && fact.loginHint ? ` To sign in, run ${fact.loginHint} in a terminal, then check again.` : '';
    items.push({ id: `tool:${fact.adapter}`, kind: 'tool', projectId: null, href: '#/settings', word: `${fact.name} ${fact.word}`, tone: 'attention', hideable: false, line: `${fact.name} is ${fact.word}. ${who} ${agents.length === 1 ? 'uses' : 'use'} it, so their departments may not take tasks.${hint}`, actions: ['refresh'] });
  }
  return items;
}

export function needsYouList(ws, entries, hidden = new Set()) {
  const all = [...toolNeeds(ws), ...entries.map((entry) => entry.needsYou).filter(Boolean)];
  const shown = all.filter((item) => !(item.hideable && hidden.has(item.id)));
  return { items: shown, hiddenCount: all.length - shown.length, total: all.length };
}

/** In motion, grouped by project: projects with work first, in the order they were added. */
export function inMotionGroups(ws, entries) {
  const moving = entries.filter((entry) => entry.inMotion);
  const groups = [];
  for (const project of ws.projects) {
    const mine = moving.filter((entry) => entry.projectId === project.id);
    const finished = entries.filter((entry) => entry.projectId === project.id && entry.finished).length;
    if (mine.length === 0 && project.archived) continue;
    groups.push({ projectId: project.id, name: project.name, chip: ws.monograms.get(project.id) ?? null, path: project.repoPath, entries: mine, finished });
  }
  for (const entry of moving) {
    if (!ws.projectById.has(entry.projectId) && !groups.some((group) => group.projectId === entry.projectId)) {
      groups.push({ projectId: entry.projectId, name: entry.projectId, chip: null, path: null, entries: moving.filter((other) => other.projectId === entry.projectId), finished: 0 });
    }
  }
  return groups.sort((a, b) => (b.entries.length > 0) - (a.entries.length > 0));
}

// ---------------------------------------------------------------------------
// One task: who is doing what, and how it moved, under the five phases
// ---------------------------------------------------------------------------

const timeOf = (iso) => {
  const date = new Date(iso ?? '');
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function describeAction(event) {
  const payload = event?.payload ?? {};
  const base = (value) => String(value ?? '').split('/').filter(Boolean).pop() ?? '';
  switch (event?.type) {
    case 'runtime.file_change':
      return payload.phase === 'completed' ? `changed ${base(payload.path)}` : `started changing ${base(payload.path)}`;
    case 'runtime.command_exec':
      return payload.phase === 'completed' ? 'finished running a command (its own run, not a check)' : `ran ${clip(payload.command, 60)} (its own run, not a check)`;
    case 'runtime.assistant_message':
      return payload.text ? `said "${clip(payload.text, 90)}" (its own words, not a verdict)` : 'wrote a message';
    case 'runtime.tool_call':
      return `used ${clip(payload.tool, 40)}`;
    case 'runtime.tool_result':
      return `got a result from ${clip(payload.tool, 40)}`;
    case 'runtime.turn_completed':
      return 'finished its reply (its own account, not a verdict)';
    case 'runtime.turn_interrupted':
      return 'was interrupted';
    default:
      return null;
  }
}

const ACTION_TYPES = new Set(['runtime.file_change', 'runtime.command_exec', 'runtime.assistant_message', 'runtime.tool_call', 'runtime.tool_result', 'runtime.turn_completed', 'runtime.turn_interrupted']);

/** A plan problem in plain words. Unknown codes keep the engine's own message. */
export function issueWords(issue, { project = 'this project', department = 'this department', head = 'The department head' } = {}) {
  const message = String(issue?.message ?? '');
  const quoted = [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  switch (issue?.code) {
    case 'unknown_assignee':
      return `part "${quoted[0] ?? '?'}" was given to ${quoted[1] ?? 'someone'}, who is not a worker of ${department} on ${project}`;
    case 'assignee_is_head':
      return `${head} gave part "${quoted[0] ?? '?'}" to itself; the department head plans and does not do the work`;
    case 'dependency_cycle':
      return 'some parts wait on each other in a circle, so none could start';
    case 'missing_acceptance_criteria':
      return `part "${quoted[0] ?? '?'}" has no clear way to tell when it is finished`;
    case 'no_plan_proposed':
      return `${head} wrote a plan as text instead of proposing one, and a plan written as text creates nothing`;
    default:
      return message.replace(/\brequest\b/g, 'task') || String(issue?.code ?? 'the plan was not usable').replace(/_/g, ' ');
  }
}

function stage(id, line, at, record, sourceIds = []) {
  return { id, line, at: timeOf(at), record: record ?? {}, sourceIds, mark: 'done', tone: 'neutral' };
}

/**
 * Everything the task page shows, from the documents alone.
 *
 * `entry` is the task (from taskEntries, or synthesised from the status
 * document); `status` the status document or null; `events` every event of the
 * run, in sequence order; `now` the page's clock in ms.
 */
export function taskDetailModel({ ws, entry, status: statusDoc = null, events = [], now = Date.now() }) {
  if (statusDoc?.run && entry.runId && statusDoc.run.id !== entry.runId) {
    statusDoc = null;
    events = [];
  }
  entry = entryWithStatus(ws, entry, statusDoc);
  const item = entry.item;
  const run = entry.run;
  const lock = run?.projectLock ?? null;
  const runState = statusDoc?.run?.state ?? run?.state ?? null;
  const live = runState !== null && LIVE_RUN_STATES.has(runState);
  const stalled = run ? isStalledRun(run, lock) : false;
  const activeResume = entry.resumes.find((resume) => ACTIVE_ITEM_STATES.has(resume.state)) ?? null;
  const itemWaiting = item && !entry.runId && ['queued', 'held', 'starting', 'running'].includes(item.state);
  const terminal = runState ? !live : Boolean(item && ['ended', 'discarded', 'failed_to_start'].includes(item.state));
  const project = projectName(ws, entry.projectId);
  const ofType = (type) => events.filter((event) => event.type === type);
  const planningStarted = ofType('head.planning_started').at(-1) ?? null;
  const planningEvents = planningStarted ? events.filter((event) => event.sequence >= planningStarted.sequence) : [];
  const planningFinished = planningEvents.filter((event) => event.type === 'head.planning_finished').at(-1) ?? null;
  const latestReviewEvent = events.filter(event => event.type === 'head.review_started' || event.type === 'head.review_finished').at(-1) || null;
  const recordedReview = latestReviewEvent ? { ...latestReviewEvent.payload, state: latestReviewEvent.type === 'head.review_started' ? 'running' : latestReviewEvent.payload?.verdict, at: latestReviewEvent.timestamp } : null;
  const savedReview = run?.headReview || null;
  const headReview = savedReview && (!latestReviewEvent || Date.parse(savedReview.at || '') >= Date.parse(latestReviewEvent.timestamp || '')) ? savedReview : recordedReview || savedReview;
  const headReviewRunning = headReview?.state === 'running';
  const headReviewState = headReview?.verdict || headReview?.state || null;
  const finalReplyEvent = ofType('control.final_reply').at(-1);
  const finalReply = typeof run?.finalReply === 'string' ? run.finalReply : typeof finalReplyEvent?.payload?.text === 'string' ? finalReplyEvent.payload.text : null;
  const departmentId = entry.departmentId ?? planningStarted?.payload?.departmentId ?? null;
  const headId = headReview?.headAgentId ?? planningStarted?.payload?.headAgentId ?? departmentHead(ws, departmentId)?.id ?? null;
  const head = headId ? agentName(ws, headId) : 'The department head';
  const eventIds = (list) => list.map((event) => `event #${event.sequence}`);

  // ---- parts ------------------------------------------------------------------
  const parts = new Map();
  const views = new Map(list(run?.taskViews).map((view) => [view.id, view]));
  const statusTasks = new Map(list(statusDoc?.tasks).map((task) => [task.id, task]));
  for (const event of ofType('head.assigned')) {
    const taskId = event.taskId ?? event.payload?.taskId;
    if (!taskId) continue;
    parts.set(taskId, { taskId, key: event.payload?.key ?? null, agentId: event.payload?.agentId ?? null, objective: event.payload?.objective ?? '', dependencies: list(event.payload?.dependencies), assignedBy: 'head', assignedEvent: event });
  }
  for (const event of ofType('task.registered')) {
    if (!event.taskId || parts.has(event.taskId)) continue;
    parts.set(event.taskId, { taskId: event.taskId, key: event.payload?.key ?? null, agentId: event.payload?.agentId ?? null, objective: firstLine(event.payload?.objective), dependencies: [], assignedBy: null, assignedEvent: null });
  }
  for (const task of [...statusTasks.values(), ...views.values()]) {
    if (!parts.has(task.id)) parts.set(task.id, { taskId: task.id, key: null, agentId: task.ownerAgentId, objective: firstLine(task.objective), dependencies: [], assignedBy: null, assignedEvent: null });
  }
  for (const part of parts.values()) {
    part.view = views.get(part.taskId) ?? null;
    part.row = statusTasks.get(part.taskId) ?? null;
    part.state = part.view?.state ?? part.row?.state ?? null;
    part.verified = part.view ? isVerifiedTask(part.view) : false;
    part.worker = agentName(ws, part.agentId);
    part.tool = part.agentId && ws.agentById.has(part.agentId) ? agentTool(ws, ws.agentById.get(part.agentId)).name : null;
    part.title = clip(part.objective || part.key || 'Part', 110);
  }
  const partByKey = new Map([...parts.values()].filter((part) => part.key).map((part) => [part.key, part]));

  // ---- phase 1: sent ------------------------------------------------------------
  const send = [];
  const created = ofType('run.created')[0] ?? null;
  if (item) {
    send.push(stage('sent', `Sent to ${departmentLabel(ws, item.departmentId)} on ${project}.`, item.receivedAt, { request: item.id, allowUnconfinedWrites: item.allowUnconfinedWrites }, [`request ${item.id}`]));
    if (item.state === 'queued') send.push(stage('waiting', plainReason(item.reason) ?? 'Waiting to start.', item.receivedAt, { reason: item.reason }));
    if (item.state === 'held') send.push(stage('held', 'Held: it was still waiting when the page server stopped, so it was not started. Start it or discard it.', item.heldAt, { reason: item.reason }));
    if (item.state === 'discarded') send.push(stage('discarded', 'Discarded. Nothing ran.', item.endedAt, {}));
    if (item.startedAt) send.push(stage('started', 'AI Workforce started it.', item.startedAt, { launch: item.launchId, pid: item.pid, stdout: item.stdoutPath, stderr: item.stderrPath }));
    if (!entry.runId && ['ended', 'failed_to_start'].includes(item.state)) {
      send.push(Object.assign(stage('not-started', resultLine(item.result) ?? 'It ended before anything was recorded.', item.endedAt, { result: item.result, exitCode: item.exitCode }), { tone: 'failed' }));
    }
  } else if (created) {
    send.push(stage('started-elsewhere', 'Started outside this page, from a terminal.', created.timestamp, { run: entry.runId }, eventIds([created])));
  }
  if (created) send.push(stage('recorded', `AI Workforce recorded it and took your last commit on ${project} as the starting point.`, created.timestamp, { run: entry.runId, baseRevision: created.payload?.baseRevision, repoPath: created.payload?.repoPath, checkSource: created.payload?.checkSource }, eventIds([created])));

  // ---- phase 2: the department head decides -----------------------------------------
  const decide = [];
  if (planningStarted) {
    for (const earlier of ofType('head.planning_finished').filter((event) => event.sequence < planningStarted.sequence && event.payload?.outcome === 'interrupted')) {
      decide.push(stage(`earlier-planning-${earlier.sequence}`, 'Earlier planning stopped. This task was resumed.', earlier.timestamp, earlier.payload, eventIds([earlier])));
    }
    decide.push(stage('planning-started', `${head} started reading the task and the project.`, planningStarted.timestamp, planningStarted.payload, eventIds([planningStarted])));
    const attempts = [...new Set(planningEvents.filter((event) => event.type.startsWith('head.') || event.type.startsWith('plan.')).map((event) => event.payload?.attempt).filter((value) => typeof value === 'number'))].sort();
    const maxAttempts = planningStarted.payload?.maxAttempts ?? 2;
    for (const attempt of attempts) {
      const mine = planningEvents.filter((event) => event.payload?.attempt === attempt && (event.type.startsWith('head.') || event.type.startsWith('plan.')));
      const proposed = mine.filter((event) => event.type === 'plan.proposed');
      const validated = mine.find((event) => event.type === 'plan.validated');
      const rejected = mine.find((event) => event.type === 'plan.rejected');
      const opened = mine.find((event) => event.type === 'head.session_opened');
      let line = `Try ${attempt} of ${maxAttempts}: ${head} is reading the project.`;
      let tone = 'neutral';
      if (proposed.length > 0 && !validated && !rejected) line = `Try ${attempt} of ${maxAttempts}: ${head} proposed a plan with ${plural(proposed[proposed.length - 1].payload?.taskCount ?? 0, 'part')}.`;
      if (validated) line = `Try ${attempt} of ${maxAttempts}: ${head} split it into ${plural(validated.payload?.taskCount ?? 0, 'part')}. AI Workforce checked that every part has a worker on ${project} and a clear finish.`;
      if (rejected) {
        const issue = list(rejected.payload?.issues)[0];
        line = `Try ${attempt} of ${maxAttempts}: AI Workforce returned the plan${issue ? `: ${clip(issueWords(issue, { project, department: departmentId ? departmentLabel(ws, departmentId) : 'this department', head }), 180)}` : ''}.${rejected.payload?.willRetry ? ' Asking again.' : ''}`;
        tone = 'attention';
        if (proposed.length === 0 && list(rejected.payload?.issues).some((entryIssue) => entryIssue.code === 'no_plan_proposed')) line = `Try ${attempt} of ${maxAttempts}: ${head} wrote a plan as text instead of proposing one, and a plan written as text creates nothing.${rejected.payload?.willRetry ? ' Asking again.' : ''}`;
      }
      const wrote = mine.find((event) => event.type === 'head.wrote_files');
      if (wrote) line += ` ${head} changed ${plural(wrote.payload?.count ?? 0, 'file')} in its read-only copy; they were not used.`;
      decide.push(Object.assign(stage(`try-${attempt}`, line, (validated ?? rejected ?? proposed[0] ?? opened ?? mine[0])?.timestamp, { attempt, session: opened?.payload?.sessionId, process: opened?.payload?.processId, proposals: proposed.map((event) => event.payload?.artifactId), issues: rejected?.payload?.issues ?? [] }, eventIds(mine)), { tone }));
    }
    for (const part of [...parts.values()].filter((entryPart) => entryPart.assignedEvent)) {
      const after = part.dependencies.map((dependency) => partByKey.get(dependency?.taskId ?? dependency)?.title ?? dependency?.taskId ?? dependency).filter(Boolean);
      decide.push(stage(`assigned-${part.taskId}`, `"${part.title}" → ${part.worker}${after.length ? `, after "${joinWords(after)}"` : ''}. Decided by ${head}.`, part.assignedEvent.timestamp, { part: part.key, task: part.taskId, worker: part.agentId, decidedBy: part.assignedEvent.payload?.decidedBy }, eventIds([part.assignedEvent])));
    }
    if (planningFinished) {
      const outcome = planningFinished.payload?.outcome;
      if (outcome === 'planned') decide.push(stage('planning-finished', `${head} finished planning.`, planningFinished.timestamp, planningFinished.payload, eventIds([planningFinished])));
      else if (outcome === 'interrupted') decide.push(Object.assign(stage('planning-finished', `${head} stopped while planning. Resume to finish the plan; no worker was started.`, planningFinished.timestamp, planningFinished.payload, eventIds([planningFinished])), { tone: 'attention' }));
      else decide.push(Object.assign(stage('planning-finished', outcome === 'plan_rejected' ? `${head} did not produce a usable plan in ${plural(planningFinished.payload?.attempts ?? 0, 'try', 'tries')}, so no worker was started.` : `Planning ended without a plan (${String(outcome).replace(/_/g, ' ')}), so no worker was started.`, planningFinished.timestamp, planningFinished.payload, eventIds([planningFinished])), { tone: 'failed' }));
    }
    const headActions = events.filter((event) => event.taskId === null && ACTION_TYPES.has(event.type));
    if (headActions.length > 0 && decide.length > 0) decide[0].record = { ...decide[0].record, recordedActions: headActions.length };
  }

  // ---- phases 3 and 4: work and checks, per part ---------------------------------------
  const change = [];
  const check = [];
  const checksByRevision = new Map();
  for (const row of list(statusDoc?.checks)) {
    if (!checksByRevision.has(row.candidateRevision)) checksByRevision.set(row.candidateRevision, []);
    checksByRevision.get(row.candidateRevision).push(row);
  }
  for (const part of parts.values()) {
    const mine = events.filter((event) => event.taskId === part.taskId);
    const work = [];
    const checking = [];
    const registered = mine.find((event) => event.type === 'task.registered');
    if (registered) work.push(stage('registered', 'Waiting to start.', registered.timestamp, { part: part.key, task: part.taskId }, eventIds([registered])));
    for (const blocked of ofType('schedule.blocked')) {
      const entryBlocked = list(blocked.payload?.blocked).find((candidate) => candidate.key === part.key);
      if (!entryBlocked) continue;
      const waitingOn = list(entryBlocked.waitingOn).map((key) => `"${partByKey.get(key)?.title ?? key}"`);
      const line = entryBlocked.reason === 'dependency' ? `Waiting for ${joinWords(waitingOn)} to be verified first.` : 'Waiting: other parts of this task are already working (its limit).';
      work.push(stage(`blocked-${blocked.sequence}`, line, blocked.timestamp, entryBlocked, eventIds([blocked])));
    }
    const copies = mine.filter((event) => event.type === 'workspace.created');
    copies.forEach((copy, index) => work.push(stage(`copy-${index}`, `Has its own copy of ${project}${copies.length > 1 ? ` (copy ${index + 1})` : ''}. Your folder is untouched.`, copy.timestamp, { path: copy.payload?.path, branch: copy.payload?.branch, baseRevision: copy.payload?.baseRevision }, eventIds([copy]))));
    const opened = mine.filter((event) => event.type === 'session.opened');
    const actions = mine.filter((event) => ACTION_TYPES.has(event.type));
    if (opened.length > 0 || actions.length > 0) {
      const last = actions[actions.length - 1] ?? null;
      const lastWords = last ? describeAction(last) : null;
      let line = `${part.worker} started working.`;
      if (actions.length > 0) line = `${part.worker}: ${plural(actions.length, 'recorded action')}. Last, ${lastWords}.`;
      work.push(stage('working', line, (last ?? opened[0]).timestamp, { sessions: opened.map((event) => event.payload?.sessionId), processes: opened.map((event) => event.payload?.processId), actions: actions.length }, eventIds([...opened, ...(last ? [last] : [])])));
      if (live && !stalled && last && Number.isFinite(now) && now - Date.parse(last.timestamp) > 5 * 60 * 1000 && !mine.some((event) => event.type === 'candidate.snapshot' && event.sequence > last.sequence)) {
        work.push(stage('silence', `No new action recorded for ${Math.round((now - Date.parse(last.timestamp)) / 60000)} min.`, last.timestamp, { lastSequence: last.sequence }));
      }
    }
    for (const repair of mine.filter((event) => event.type === 'task.repair_started')) {
      work.push(Object.assign(stage(`repair-${repair.sequence}`, `Checks did not pass; ${part.worker} is fixing its copy${repair.payload?.attempt ? ` (attempt ${repair.payload.attempt})` : ''}.`, repair.timestamp, repair.payload, eventIds([repair])), { tone: 'attention' }));
    }
    const stopAsked = mine.find((event) => event.type === 'run.interrupt_requested');
    if (stopAsked) work.push(stage('stop-requested', 'A stop was requested.', stopAsked.timestamp, stopAsked.payload, eventIds([stopAsked])));
    const settledEvent = mine.find((event) => event.type === 'task.settled');
    if (settledEvent?.payload?.interrupted) work.push(Object.assign(stage('interrupted', 'Stopped before its copy was checked.', settledEvent.timestamp, settledEvent.payload, eventIds([settledEvent])), { tone: 'attention' }));

    for (const snapshot of mine.filter((event) => event.type === 'candidate.snapshot')) {
      const changed = snapshot.payload?.changedFileCount;
      const line = snapshot.payload?.checkpointCreated === false ? 'Copy frozen for checking. Nothing in it changed.' : `Copy frozen for checking${typeof changed === 'number' ? ` with ${plural(changed, 'changed file')}` : ''}.`;
      checking.push(stage(`frozen-${snapshot.sequence}`, line, snapshot.timestamp, { candidateRevision: snapshot.payload?.candidateRevision, patchHash: snapshot.payload?.patchHash }, eventIds([snapshot])));
      for (const row of checksByRevision.get(snapshot.payload?.candidateRevision) ?? []) {
        const view = checkView(row, statusDoc, run);
        const outcome = view.compromised ? 'Does not count: this check\'s own files were changed' : view.evidenceUnavailable ? 'Does not count: its saved evidence is missing or changed' : row.outcome === 'passed' ? 'Passed' : row.outcome === 'failed' ? 'Failed' : `Recorded as ${String(row.outcome).replace(/_/g, ' ')}`;
        const by = view.verifier ? 'run by the verifier' : 'not run by the verifier, so it does not count';
        checking.push(Object.assign(stage(`check-${row.id}`, `${outcome} · ${row.command} · ${by}.`, null, { check: row.id, criteria: row.criterionIds, exitCode: row.exitCode, provenance: row.evidenceProvenance, candidateRevision: row.candidateRevision }), { tone: view.tone === 'verified' ? 'verified' : view.tone === 'failed' || view.tone === 'compromised' ? 'failed' : 'neutral' }));
      }
    }
    if (settledEvent && !settledEvent.payload?.interrupted) {
      let line;
      let tone;
      if (settledEvent.payload?.accepted === true && part.verified) {
        line = 'Verified: its checks passed, run by the verifier.';
        tone = 'verified';
      } else if (settledEvent.payload?.accepted === true) {
        line = 'Marked as passing, but no passing check the verifier ran is recorded for it, so it is not verified.';
        tone = 'attention';
      } else {
        const verdict = mine.filter((event) => event.type === 'run.failed' || event.type === 'run.accepted').pop();
        const reasons = list(verdict?.payload?.reasons);
        line = `Not verified${reasons.length ? `: ${clip(reasons[0], 160)}` : '.'}`;
        tone = 'failed';
      }
      checking.push(Object.assign(stage('part-result', line, settledEvent.timestamp, { ...settledEvent.payload, receipts: part.view?.receipts ?? null }, eventIds([settledEvent])), { tone }));
    }
    part.workStages = work;
    part.checkStages = checking;
    if (work.length > 0) change.push({ key: part.taskId, title: part.title, subtitle: [part.worker, part.tool].filter(Boolean).join(' · '), stages: work, part });
    if (checking.length > 0) check.push({ key: part.taskId, title: part.title, subtitle: part.worker, stages: checking, part });
  }
  const together = [];
  for (const combined of ofType('integration.combined')) {
    const ok = combined.payload?.accepted === true;
    const line = ok ? `Put ${plural(parts.size, 'part')} together and ran the checks on the result: they passed.` : 'Put the parts together, but the checks on the result did not all pass.';
    together.push(Object.assign(stage(`combined-${combined.sequence}`, line, combined.timestamp, combined.payload, eventIds([combined])), { tone: ok ? 'neutral' : 'failed' }));
    for (const row of checksByRevision.get(combined.payload?.combinedRevision) ?? []) {
      const view = checkView(row, statusDoc, run);
      together.push(Object.assign(stage(`check-${row.id}`, `${row.outcome === 'passed' ? 'Passed' : row.outcome === 'failed' ? 'Failed' : 'Recorded'} · ${row.command} · ${view.verifier ? 'run by the verifier' : 'not run by the verifier'}.`, null, { check: row.id, exitCode: row.exitCode, provenance: row.evidenceProvenance, candidateRevision: row.candidateRevision }), { tone: view.tone === 'failed' ? 'failed' : 'neutral' }));
    }
  }
  for (const refused of ofType('integration.refused')) {
    together.push(Object.assign(stage(`refused-${refused.sequence}`, `Could not put the parts together${refused.payload?.reason ? `: ${clip(refused.payload.reason, 160)}` : '.'}`, refused.timestamp, refused.payload, eventIds([refused])), { tone: 'failed' }));
  }
  if (together.length > 0) check.push({ key: 'together', title: 'All parts together', subtitle: null, stages: together, part: null });

  // ---- phase 5: review ----------------------------------------------------------------
  const review = [];
  if (headReview) {
    const line = headReviewRunning ? `${head} is reviewing the finished result against your instructions and the independent checks.`
      : headReviewState === 'passed' ? `${head} completed the department-head review: passed.`
        : headReviewState === 'changes_requested' ? `${head} requested changes during department-head review${headReview.summary ? `: ${clip(headReview.summary, 240)}` : '.'}`
          : `${head}'s department-head review could not finish${headReview.summary ? `: ${clip(headReview.summary, 240)}` : '.'}`;
    review.push(Object.assign(stage('head-review', line, headReview.at, headReview, latestReviewEvent ? eventIds([latestReviewEvent]) : ['run headReview']), { tone: ['changes_requested', 'blocked'].includes(headReviewState) ? 'attention' : 'neutral' }));
  }
  for (const notes of ofType('review.completed')) review.push(stage(`review-${notes.sequence}`, 'A reviewer left notes. Notes are advice; checks decide.', notes.timestamp, notes.payload, eventIds([notes])));
  const failedEvent = ofType('run.failed').filter((event) => event.taskId === null).pop() ?? null;
  const interruptedEvent = ofType('run.interrupted').filter((event) => event.taskId === null).pop() ?? null;
  const allParts = [...parts.values()];
  const runVerified = runState === 'ready_for_review' && allParts.length > 0 && allParts.every((part) => part.verified) && list(run?.evidenceIssues).length === 0;
  if (runState === 'ready_for_review') {
    const unverifiedReason = list(run?.evidenceIssues).length > 0 ? 'The recorded result needs review: some saved evidence is missing or has changed, so the complete result is not verified.' : 'Ready for your review, but not every part rests on a passing check the verifier ran, so it is not verified.';
    review.push(Object.assign(stage('result', runVerified ? `Ready for your review. Verified: ${plural(allParts.length, 'part')}, each backed by checks the verifier ran.` : unverifiedReason, statusDoc?.run?.endedAt ?? run?.endedAt, { run: entry.runId, state: runState }), { tone: runVerified ? 'verified' : 'attention' }));
  } else if (runState === 'failed' && planningFinished && planningFinished.payload?.outcome !== 'planned') {
    review.push(Object.assign(stage('result', `Did not finish: ${head} did not produce a usable plan, so no worker was started and nothing changed.`, statusDoc?.run?.endedAt ?? failedEvent?.timestamp, { run: entry.runId, state: runState, ...(failedEvent?.payload ?? {}) }, failedEvent ? eventIds([failedEvent]) : []), { tone: 'failed' }));
  } else if (runState === 'failed') {
    review.push(Object.assign(stage('result', `Did not finish${failedEvent?.payload?.reason ? `: ${clip(failedEvent.payload.reason, 200)}` : '.'}`, statusDoc?.run?.endedAt ?? failedEvent?.timestamp, { run: entry.runId, state: runState, ...(failedEvent?.payload ?? {}) }, failedEvent ? eventIds([failedEvent]) : []), { tone: 'failed' }));
  } else if (runState === 'interrupted') {
    const remaining = list(interruptedEvent?.payload?.interruptedTasks).map((key) => `"${partByKey.get(key)?.title ?? key}"`);
    const stoppedLine = headReview ? 'Stopped during department-head review. The recorded work and checks are preserved. Resume to finish the review.' : `Stopped before it finished${remaining.length ? `; ${joinWords(remaining)} did not finish` : ''}. Nothing was put together. Resume it to finish the rest.`;
    review.push(Object.assign(stage('result', stoppedLine, statusDoc?.run?.endedAt ?? interruptedEvent?.timestamp, { run: entry.runId, state: runState, ...(interruptedEvent?.payload ?? {}) }, interruptedEvent ? eventIds([interruptedEvent]) : []), { tone: 'attention' }));
  } else if (runState === 'cancelled') {
    review.push(stage('result', 'Cancelled.', statusDoc?.run?.endedAt, { run: entry.runId, state: runState }));
  }

  // ---- phase states --------------------------------------------------------------------------
  const decideOpen = Boolean(planningStarted) && !planningFinished;
  const partOpen = (part) => !['accepted', 'failed', 'cancelled', 'superseded'].includes(part.state ?? '') && !part.checkStages.some((entryStage) => entryStage.id === 'part-result');
  const changeOpen = allParts.some((part) => partOpen(part) && !part.checkStages.length);
  const checkOpen = !headReview && (allParts.some((part) => partOpen(part) && part.checkStages.length > 0) || (live && allParts.length > 0 && allParts.every((part) => !partOpen(part)) && runState !== 'ready_for_review'));
  const sendOpen = Boolean(itemWaiting) || (item?.state === 'starting' && !created);
  const moving = (live || itemWaiting) && !terminal;
  const flags = { send: sendOpen, decide: decideOpen && live, change: changeOpen && live, check: checkOpen && live, review: headReviewRunning && live };
  const content = { send, decide, change, check, review };

  const phases = PHASES.map((phase) => {
    const groups = phase.key === 'change' || phase.key === 'check' ? content[phase.key] : content[phase.key].length > 0 ? [{ key: phase.key, title: null, subtitle: null, stages: content[phase.key], part: null }] : [];
    const stages = groups.flatMap((group) => group.stages);
    let state;
    if (phase.key === 'review' && ['changes_requested', 'blocked'].includes(headReviewState)) state = 'stopped';
    else if (phase.key === 'decide' && runState === 'interrupted' && planningStarted && planningFinished?.payload?.outcome !== 'planned') state = 'stopped';
    else if (flags[phase.key] && (stalled || (item?.state === 'held' && phase.key === 'send'))) state = stalled ? 'stopped' : 'now';
    else if (flags[phase.key] && moving) state = 'now';
    else if (stages.length > 0) state = 'done';
    else if (terminal || stalled) state = 'skipped';
    else state = 'not_yet';
    if (state === 'now' || state === 'stopped') {
      for (const group of groups) {
        const last = group.stages[group.stages.length - 1];
        const groupOpen = group.part ? partOpen(group.part) : true;
        if (last && groupOpen && (phase.key !== 'change' || !group.part?.checkStages.length)) last.mark = state === 'stopped' ? 'stopped' : 'now';
      }
    }
    return { ...phase, ...(phase.key === 'review' && headReview ? { heading: 'Department-head review' } : {}), state, groups, summary: phaseSummary(phase.key, { state, stages, groups, head, allParts, runVerified, terminal, item, runState }) };
  });

  // ---- what each part is doing now -----------------------------------------------------------------
  const actors = [];
  const needs = entry.needsYou;
  actors.push({ role: 'you', name: 'You', line: needs ? youLine(needs.kind) : 'Nothing needed from you.' });
  let headLine;
  if (headReviewRunning) headLine = stalled || !live ? 'Stopped during department-head review.' : 'Reviewing the result and independent checks.';
  else if (headReviewState === 'passed') headLine = 'Department-head review passed. Control Center can deliver the result.';
  else if (headReviewState === 'changes_requested') headLine = 'Requested changes during department-head review.';
  else if (headReviewState === 'blocked') headLine = 'Department-head review could not finish. Resume to try the review again.';
  else if (!planningStarted) headLine = itemWaiting ? 'Has not seen the task yet.' : terminal ? 'Did not plan this task.' : 'About to read the task.';
  else if (!planningFinished) headLine = stalled ? 'Stopped while planning.' : live ? 'Planning.' : 'Stopped while planning.';
  else headLine = planningFinished.payload?.outcome === 'planned' ? `Finished planning: ${plural(allParts.length, 'part')}.` : planningFinished.payload?.outcome === 'interrupted' ? 'Stopped while planning.' : 'Did not produce a usable plan.';
  actors.push({ role: 'head', name: `${head}${headId ? ' (department head)' : ''}`, line: headLine });
  for (const part of allParts) {
    actors.push({ role: 'worker', name: part.worker, agentId: part.agentId, line: workerLine(part, { live, stalled }) });
  }
  const verifying = allParts.filter((part) => part.state === 'validating');
  let verifierLine = 'Nothing to check yet.';
  if (verifying.length > 0 && live && !stalled) verifierLine = `Checking ${joinWords(verifying.map((part) => `"${part.title}"`))}.`;
  else if (allParts.some((part) => part.checkStages.length > 0)) verifierLine = terminal || allParts.every((part) => !partOpen(part)) ? 'Finished checking.' : 'Waiting for the next frozen copy.';
  actors.push({ role: 'verifier', name: 'Verifier', line: verifierLine });

  const overlay = stalled && !activeResume ? { kind: 'stalled', line: 'Stalled: its record says it is in progress, but nothing is running it. Resume it to continue.' } : null;
  const canStop = Boolean(item && ['starting', 'running'].includes(item.state) && !item.stopRequestedAt && !stalled && !terminal);
  const canResume = Boolean(entry.runId && (runState === 'interrupted' || stalled) && !activeResume);
  let taskStatusNow = entry.status;
  if (headReviewRunning && live && !stalled && !item?.stopRequestedAt) taskStatusNow = status('headReviewing', `${head} is reviewing the result and the recorded checks.`);
  if (headReviewState === 'changes_requested' && runState === 'failed') taskStatusNow = status('headReviewChanges', `${head} requested changes.${headReview.summary ? ` ${clip(headReview.summary, 220)}` : ''}`);
  if (entry.status.key === 'starting' && planningStarted && !planningFinished && !stalled) {
    // The queue has not looked at the process again yet, but the record already says the head is planning.
    taskStatusNow = { key: 'planning', word: TASK_STATUS.planning.word, tone: TASK_STATUS.planning.tone, line: `${head} is planning.` };
  }
  if (runState === 'failed' && planningFinished && planningFinished.payload?.outcome !== 'planned') {
    taskStatusNow = { key: 'noPlan', word: TASK_STATUS.noPlan.word, tone: TASK_STATUS.noPlan.tone, line: `${head} did not produce a usable plan, so no worker was started.` };
  }
  const verdict = runVerified ? 'verified' : taskStatusNow.key;
  return {
    title: entry.title,
    projectId: entry.projectId,
    project,
    departmentId,
    department: departmentId ? departmentLabel(ws, departmentId) : null,
    sentAt: item?.receivedAt ?? created?.timestamp ?? null,
    status: taskStatusNow,
    verdict,
    phases,
    actors,
    overlay,
    parts: allParts.map((part) => ({ taskId: part.taskId, key: part.key, agentId: part.agentId, title: part.title, worker: part.worker, verified: part.verified, state: part.state })),
    canStop,
    canResume,
    stopNote: !item && live && !stalled ? 'Started from a terminal: stop it there with Ctrl+C.' : null,
    activeResume,
    headReview,
    finalReply,
    candidateReviewReady: runState === 'ready_for_review',
    phaseSignature: phases.map((phase) => `${phase.key}:${phase.state}`).join(','),
    record: { run: entry.runId, request: item?.id ?? null, state: runState, baseRevision: statusDoc?.run?.baseRevision ?? run?.baseRevision ?? null, repoPath: statusDoc?.run?.repoPath ?? null },
  };
}

function youLine(kind) {
  switch (kind) {
    case 'held':
      return 'Start it or discard it.';
    case 'interrupted':
    case 'stalled':
      return 'Resume it, or leave it as it is.';
    case 'review':
      return 'Review the result.';
    case 'failed':
      return 'Nothing to decide. It ended without a verified result.';
    default:
      return 'Nothing needed from you.';
  }
}

function workerLine(part, { live, stalled }) {
  const title = `"${part.title}"`;
  if (part.verified) return `Finished ${title}; checks the verifier ran passed.`;
  switch (part.state) {
    case 'running':
      return stalled ? `Stopped while working on ${title}.` : part.view?.attempt?.state === 'running' ? `Working on ${title}.` : `Getting its copy ready for ${title}.`;
    case 'validating':
      return stalled ? `Stopped while ${title} was being checked.` : `Finished ${title} by its own account (not a verdict). It is being checked.`;
    case 'waiting':
    case 'pending':
    case 'ready':
      return stalled || !live ? `Did not start ${title}.` : `Waiting to start ${title}.`;
    case 'accepted':
      return `Finished ${title}, but no passing check the verifier ran is recorded for it.`;
    case 'failed':
      return `${title} did not pass its checks.`;
    case 'cancelled':
    case 'superseded':
      return `Stopped before finishing ${title}.`;
    default:
      return live ? `Assigned ${title}.` : `Was assigned ${title}.`;
  }
}

function phaseSummary(key, { state, stages, head, allParts, runVerified, terminal, item, runState }) {
  if (state === 'not_yet') return 'Not yet.';
  if (state === 'skipped') return key === 'decide' && runState === null ? 'Not reached: nothing started.' : 'Not reached.';
  const last = stages[stages.length - 1];
  switch (key) {
    case 'send':
      return item ? (last?.line ?? 'Sent.') : 'Started outside this page.';
    case 'decide':
      return stages.find((entryStage) => entryStage.id === 'planning-finished')?.line ?? (state === 'stopped' || terminal ? `${head} stopped while planning.` : `${head} is planning.`);
    case 'change':
      return `${plural(allParts.length, 'part')}, each worked on in its own copy.`;
    case 'check': {
      const verified = allParts.filter((part) => part.verified).length;
      return terminal || state === 'done' ? `${verified} of ${plural(allParts.length, 'part')} verified.` : 'Checking.';
    }
    case 'review':
      return last?.line ?? (runVerified ? 'Ready for your review.' : 'Not yet.');
    default:
      return last?.line ?? '';
  }
}

/** Detail evidence is authoritative even when the recent-runs list is absent or stale. */
export function entryWithStatus(ws, entry, statusDoc) {
  if (!statusDoc?.run || (entry.runId && entry.runId !== statusDoc.run.id)) return entry;
  const previous = entry.run;
  const run = {
    ...previous,
    ...statusDoc.run,
    taskViews: Array.isArray(statusDoc.taskViews) ? statusDoc.taskViews : list(previous?.taskViews),
    compromisedReceiptIds: Array.isArray(statusDoc.compromisedReceiptIds) ? statusDoc.compromisedReceiptIds : list(previous?.compromisedReceiptIds),
    unverifiedReceiptIds: Array.isArray(statusDoc.unverifiedReceiptIds) ? statusDoc.unverifiedReceiptIds : list(previous?.unverifiedReceiptIds),
    evidenceIssues: Array.isArray(statusDoc.evidenceIssues) ? statusDoc.evidenceIssues : list(previous?.evidenceIssues),
    outcome: Object.hasOwn(statusDoc, 'outcome') ? statusDoc.outcome : previous?.outcome ?? null,
    projectId: entry.projectId,
    projectLock: previous?.projectLock ?? null,
  };
  return makeEntry(ws, { item: entry.item, run, projectId: entry.projectId, runId: run.id, resumes: entry.resumes });
}

/** A task entry from its own evidence, for a task older than the lists the page loaded. */
export function entryFromStatus(ws, projectId, statusDoc, lock = null) {
  const entry = makeEntry(ws, { item: null, run: statusDoc?.run ? { ...statusDoc.run, projectId, projectLock: lock } : null, projectId, runId: statusDoc?.run?.id ?? null, resumes: [] });
  return entryWithStatus(ws, entry, statusDoc);
}

// ---------------------------------------------------------------------------
// The department editor
// ---------------------------------------------------------------------------

export function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** An id that is not live and was never retired, as the server issues ids. */
export function freshId(ws, collection, preferred, fallback, reserved = new Set()) {
  const retired = new Set(ws.config?.retiredIds?.[collection] ?? []);
  const live = new Set((ws.config?.[collection] ?? []).map((item) => item.id));
  const taken = (id) => live.has(id) || retired.has(id) || reserved.has(id);
  const base = slugify(preferred) || fallback;
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** The first colour no live department uses, as the server picks one. */
export function nextColor(ws) {
  const order = ['blue', 'slate', 'rose', 'sand', 'lavender', 'sage'];
  return order.find((color) => !ws.liveDepartments.some((department) => department.color === color)) ?? order[ws.departments.length % order.length];
}

/** The editor's draft for a new department: the server's starter when it offers one, else an empty head and worker. */
export function newDepartmentDraft(ws) {
  const codexReady = toolFact(ws, 'codex').ready === true;
  const claudeReady = toolFact(ws, 'claude-code').ready === true;
  const tool = codexReady || !claudeReady ? 'codex' : 'claude-code';
  const starter = ws.suggestedStarter;
  const lastProject = ws.liveProjects[ws.liveProjects.length - 1] ?? null;
  const taken = new Set(ws.departments.map((department) => department.name.toLowerCase()));
  const name = taken.has('engineering') ? '' : 'Engineering';
  return {
    id: null,
    name: starter?.department?.name ?? name,
    note: '',
    color: starter?.department?.color ?? nextColor(ws),
    suggested: Boolean(starter) || name.length > 0,
    suggestionNote: starter?.runtimeChoice?.reason ?? null,
    head: { id: null, name: starter?.head?.name ?? `${name || 'Department'} head`, tool: draftRuntime(ws, starter?.head?.runtime ?? starter?.head?.adapter ?? tool), model: '', effort: '', instructions: '' },
    workers: [{ id: null, key: 'w1', name: starter?.workers?.[0]?.name ?? `${name || 'Department'} worker`, tool: draftRuntime(ws, starter?.workers?.[0]?.runtime ?? starter?.workers?.[0]?.adapter ?? tool), model: '', effort: '', instructions: '', policy: 'local-development', projectIds: starter?.workers?.[0]?.projectIds ?? (lastProject ? [lastProject.id] : []) }],
    archivedWorkers: [],
  };
}

/** The editor's draft for an existing department. */
export function editDepartmentDraft(ws, departmentId) {
  const department = ws.departmentById.get(departmentId);
  if (!department) return null;
  const head = departmentHead(ws, departmentId);
  return {
    id: department.id,
    name: department.name,
    note: department.note ?? '',
    color: department.color,
    suggested: false,
    suggestionNote: null,
    head: head ? { id: head.id, name: head.name, tool: head.runtime, model: head.model ?? '', effort: head.effort ?? '', instructions: head.instructions } : { id: null, name: `${department.name} head`, tool: draftRuntime(ws, 'codex'), model: '', effort: '', instructions: '' },
    workers: departmentWorkers(ws, departmentId).map((worker) => ({ id: worker.id, key: worker.id, name: worker.name, tool: worker.runtime, model: worker.model ?? '', effort: worker.effort ?? '', instructions: worker.instructions, policy: worker.policy, projectIds: [...worker.projectIds] })),
    archivedWorkers: [],
  };
}

/** Problems that stop Create or Save, in the editor's words. Empty when the draft can be saved. */
export function draftIssues(ws, draft) {
  const issues = [];
  if (!draft.name.trim()) issues.push('A department needs a name.');
  const clash = ws.departments.find((department) => department.id !== draft.id && department.name.trim().toLowerCase() === draft.name.trim().toLowerCase() && (department.note ?? '').trim().toLowerCase() === draft.note.trim().toLowerCase());
  if (draft.name.trim() && clash) issues.push(`You already have a department called ${draft.name.trim()}${draft.note.trim() ? ` · ${draft.note.trim()}` : ''}. Add a note to tell them apart.`);
  if (!draft.head.name.trim()) issues.push('Name the department head. It decides who does each task.');
  if (draft.workers.length === 0) issues.push('Add at least one worker, or this department cannot take tasks.');
  draft.workers.forEach((worker, index) => {
    if (!worker.name.trim()) issues.push(`Worker ${index + 1} needs a name.`);
  });
  return issues;
}

/** Notes that do not stop saving but say what the department will not be able to do. */
export function draftNotes(ws, draft) {
  const notes = [];
  for (const worker of draft.workers) {
    if (worker.name.trim() && worker.projectIds.length === 0) notes.push(`${worker.name.trim()} is not on any project, so it gets no tasks until you tick one.`);
  }
  const headTool = agentTool(ws, { runtime: draft.head.tool });
  if (headTool.ready === false) notes.push(`${draft.head.name.trim() || 'The department head'} uses ${headTool.name}, which is ${headTool.word}${headTool.loginHint && headTool.word === 'signed out' ? `. Run ${headTool.loginHint} in a terminal, or choose another tool` : ''}.`);
  if (!runtimeBoundary(ws, draft.head.tool).verified) notes.push(`The department head on ${headTool.name} has no verified file boundary, so this department's tasks run on their own.`);
  return notes;
}

/** What the department will be able to take, per project: a preview, not saved. */
export function draftPreview(ws, draft) {
  const headName = draft.head.name.trim() || 'the department head';
  return ws.liveProjects.map((project) => {
    const on = draft.workers.filter((worker) => worker.projectIds.includes(project.id) && worker.name.trim());
    const checks = projectChecks(ws, project.id);
    if (on.length === 0) return { projectId: project.id, ok: false, text: `Nobody here works on ${project.name} yet, so this department cannot take its tasks.` };
    if (checks.count === 0) return { projectId: project.id, ok: false, text: `${project.name} has no checks yet, so nothing there could be verified.` };
    const names = joinWords(on.map((worker) => worker.name.trim()));
    return {
      projectId: project.id,
      ok: true,
      text: on.length === 1 ? `${headName} reads every task and gives it to ${names}, the only worker on ${project.name} (one planning call per task).` : `${headName} reads every task and gives it to ${names.replace(/ and /, ' or ')}, or splits it into parts (one planning call per task).`,
    };
  });
}

const std = (tool) => (tool === 'codex' ? 'codex-local' : tool === 'claude-code' ? 'claude-local' : tool);

/** Keep configured installations distinct; the first-run standard binding is created by the save operation. */
function draftRuntime(ws, preferred) {
  const runtimes = Object.entries(ws.config?.runtimes ?? {});
  if (runtimes.some(([id]) => id === preferred)) return preferred;
  const adapter = adapterOf(ws, preferred);
  const matching = runtimes.filter(([, binding]) => binding.adapter === adapter);
  return matching.find(([id]) => agentTool(ws, { runtime: id }).ready === true)?.[0] ?? matching[0]?.[0] ?? std(preferred);
}

function draftAgentOverrides(agent) {
  const model = (agent.model ?? '').trim();
  const effort = (agent.effort ?? '').trim();
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(agent.instructions.trim() ? { instructions: agent.instructions } : {}) };
}

/** The workspace operations that turn the draft into what is saved. */
export function draftOps(ws, draft) {
  const ops = [];
  const reserved = new Set();
  if (draft.id === null) {
    const departmentId = freshId(ws, 'departments', draft.note.trim() ? `${draft.name} ${draft.note}` : draft.name, 'department');
    ops.push({ op: 'department.add', id: departmentId, name: draft.name.trim(), ...(draft.note.trim() ? { note: draft.note.trim() } : {}), color: draft.color });
    const headId = freshId(ws, 'agents', draft.head.name, 'head', reserved);
    reserved.add(headId);
    ops.push({ op: 'agent.add', id: headId, name: draft.head.name.trim(), role: 'head', departmentId, runtime: std(draft.head.tool), ...draftAgentOverrides(draft.head) });
    for (const worker of draft.workers) {
      const workerId = freshId(ws, 'agents', worker.name, 'worker', reserved);
      reserved.add(workerId);
      ops.push({ op: 'agent.add', id: workerId, name: worker.name.trim(), role: 'worker', departmentId, runtime: std(worker.tool), policy: worker.policy, projectIds: worker.projectIds, ...draftAgentOverrides(worker) });
    }
    return ops;
  }
  const department = ws.departmentById.get(draft.id);
  const edit = {};
  if (department.name !== draft.name.trim()) edit.name = draft.name.trim();
  if ((department.note ?? '') !== draft.note.trim()) edit.note = draft.note.trim() ? draft.note.trim() : null;
  if (department.color !== draft.color) edit.color = draft.color;
  if (Object.keys(edit).length > 0) ops.push({ op: 'department.edit', id: draft.id, ...edit });
  const agentEdit = (current, next, extra = {}) => {
    const change = { ...extra };
    if (current.name !== next.name.trim()) change.name = next.name.trim();
    if (current.runtime !== std(next.tool)) change.runtime = std(next.tool);
    if ((current.model ?? '') !== next.model.trim()) change.model = next.model.trim() ? next.model.trim() : null;
    if ((current.effort ?? '') !== (next.effort ?? '').trim()) change.effort = (next.effort ?? '').trim() || null;
    if (next.instructions.trim() && current.instructions !== next.instructions) change.instructions = next.instructions;
    return change;
  };
  const currentHead = draft.head.id ? ws.agentById.get(draft.head.id) : null;
  if (currentHead) {
    const change = agentEdit(currentHead, draft.head);
    if (Object.keys(change).length > 0) ops.push({ op: 'agent.edit', id: currentHead.id, ...change });
  } else if (draft.head.name.trim()) {
    const headId = freshId(ws, 'agents', draft.head.name, 'head', reserved);
    reserved.add(headId);
    ops.push({ op: 'agent.add', id: headId, name: draft.head.name.trim(), role: 'head', departmentId: draft.id, runtime: std(draft.head.tool), ...draftAgentOverrides(draft.head) });
  }
  for (const worker of draft.workers) {
    if (worker.id === null) {
      const workerId = freshId(ws, 'agents', worker.name, 'worker', reserved);
      reserved.add(workerId);
      ops.push({ op: 'agent.add', id: workerId, name: worker.name.trim(), role: 'worker', departmentId: draft.id, runtime: std(worker.tool), policy: worker.policy, projectIds: worker.projectIds, ...draftAgentOverrides(worker) });
      continue;
    }
    const current = ws.agentById.get(worker.id);
    if (!current) continue;
    const change = agentEdit(current, worker, current.policy !== worker.policy ? { policy: worker.policy } : {});
    if (Object.keys(change).length > 0) ops.push({ op: 'agent.edit', id: worker.id, ...change });
    for (const projectId of worker.projectIds) if (!current.projectIds.includes(projectId)) ops.push({ op: 'agent.assign', agentId: worker.id, projectId });
    for (const projectId of current.projectIds) if (!worker.projectIds.includes(projectId)) ops.push({ op: 'agent.unassign', agentId: worker.id, projectId });
  }
  for (const workerId of draft.archivedWorkers) ops.push({ op: 'agent.archive', id: workerId });
  return ops;
}
