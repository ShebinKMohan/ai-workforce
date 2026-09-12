/**
 * The office floor, as a pure model: one tile per department, one desk per
 * configured agent, and a status word for each that comes from records only.
 *
 * - No desk without a configured, non-archived agent. An empty workspace has no tiles.
 * - Heads first, then workers in the order the workspace file lists them.
 * - A desk reads Working, Being checked or Waiting only for a part of a live run
 *   whose project lock is held. Rows that say running under a free lock read Stalled.
 * - Settled work reads Available, so the floor is never green.
 * - Available carries the coding tool's state when that tool is not ready.
 */
import { deskState, isStalledRun, LIVE_RUN_STATES } from '../truth.js';
import { agentTool, departmentHex, departmentLabel, departmentWorkers, departmentHead, projectName } from '../model.js';
import { plural } from '../words.js';

const LIVE_RANK = { working: 5, verifying: 4, starting: 3, waiting: 2, queued: 1 };
const LIVE_WORDS = { working: 'Working', verifying: 'Being checked', starting: 'Working', waiting: 'Waiting', queued: 'Waiting' };

/** The most advanced live phase an agent has across every project's runs, or its stall, or nothing. */
function agentActivity(agentId, runs) {
  let live = null;
  let stalled = null;
  let stopped = null;
  for (const run of runs) {
    const lock = run.projectLock ?? null;
    if (isStalledRun(run, lock)) {
      if (!stalled && (run.taskViews ?? []).some((task) => task.ownerAgentId === agentId && !['accepted', 'failed', 'cancelled', 'superseded'].includes(task.state))) stalled = { run };
      continue;
    }
    if (LIVE_RUN_STATES.has(run.state)) {
      const desk = deskState(agentId, [run], lock);
      if (LIVE_RANK[desk.state] && (live === null || LIVE_RANK[desk.state] > LIVE_RANK[live.state])) live = { state: desk.state, run, taskId: desk.taskId };
    } else if (run.state === 'interrupted' && !stopped) {
      if ((run.taskViews ?? []).some((task) => task.ownerAgentId === agentId && (task.state === 'cancelled' || task.state === 'superseded'))) stopped = { run };
    }
  }
  return { live, stalled, stopped };
}

/**
 * @param ws        indexWorkspace(GET /api/workspace)
 * @param runsDoc   GET /api/runs
 * @param entries   taskEntries(...), to link a desk to its task and to see a head planning
 * @param filterProjectId  optional: heads of departments with a worker on it, and those workers
 */
export function floorModel(ws, runsDoc, entries = [], filterProjectId = null) {
  const runs = (Array.isArray(runsDoc?.runs) ? runsDoc.runs : []).filter((run) => run.projectId);
  const hrefFor = (run) => {
    const entry = entries.find((candidate) => candidate.projectId === run.projectId && candidate.runId === run.id);
    return entry?.href ?? `#/tasks/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.id)}`;
  };
  const departments = [];
  for (const department of ws.liveDepartments) {
    const label = departmentLabel(ws, department);
    const head = departmentHead(ws, department.id);
    let workers = departmentWorkers(ws, department.id);
    if (filterProjectId) {
      workers = workers.filter((worker) => worker.projectIds.includes(filterProjectId));
      if (workers.length === 0) continue;
    }
    const desks = [];
    const agents = [...(head ? [head] : []), ...workers];
    for (const agent of agents) {
      const tool = agentTool(ws, agent);
      const activity = agentActivity(agent.id, runs);
      let statusWord = 'Available';
      let tone = 'neutral';
      let href = `#/departments/${encodeURIComponent(department.id)}`;
      let doing = null;
      let activeProjectId = null;
      if (agent.role === 'head') {
        const planning = entries.find((entry) => entry.status.key === 'planning' && entry.departmentId === department.id);
        if (planning) {
          statusWord = 'Planning';
          href = planning.href;
          doing = `planning "${planning.title}" on ${projectName(ws, planning.projectId)}`;
        }
      }
      if (activity.live) {
        statusWord = LIVE_WORDS[activity.live.state];
        href = hrefFor(activity.live.run);
        activeProjectId = activity.live.run.projectId;
        const task = (activity.live.run.taskViews ?? []).find((view) => view.id === activity.live.taskId);
        doing = `${statusWord.toLowerCase()} on "${String(task?.objective ?? '').split('\n', 1)[0]}" in ${projectName(ws, activeProjectId)}`;
      } else if (activity.stalled) {
        statusWord = 'Stalled';
        tone = 'failed';
        href = hrefFor(activity.stalled.run);
        doing = `its task on ${projectName(ws, activity.stalled.run.projectId)} is stalled: nothing is running it`;
      } else if (activity.stopped && agent.role === 'worker') {
        const resumed = entries.some((entry) => entry.runId === activity.stopped.run.id && !entry.needsYou);
        if (!resumed) {
          statusWord = 'Needs you';
          tone = 'attention';
          href = hrefFor(activity.stopped.run);
          doing = `its task on ${projectName(ws, activity.stopped.run.projectId)} was stopped and waits for you`;
        }
      }
      if (statusWord === 'Available' && tool.ready === false) {
        statusWord = `Available · ${tool.name} ${tool.word}`;
        tone = 'attention';
      }
      const liveProjects = agent.role === 'worker' ? agent.projectIds.filter((id) => ws.projectById.get(id) && !ws.projectById.get(id).archived) : [];
      const chips = ws.showChips ? liveProjects.map((id) => ({ projectId: id, monogram: ws.monograms.get(id) ?? '??', name: projectName(ws, id), active: id === activeProjectId })) : [];
      const roleLine = agent.role === 'head' ? 'department head' : liveProjects.length === 0 ? 'On the bench · no project' : ws.showChips ? null : `works on ${projectName(ws, liveProjects[0])}`;
      const roleWord = agent.role === 'head' ? 'department head' : 'worker';
      desks.push({
        agentId: agent.id,
        role: agent.role,
        name: agent.name,
        statusWord,
        tone,
        chips,
        roleLine,
        href,
        ariaLabel: `${agent.name}, ${roleWord} in ${label}. ${doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)}.` : `${statusWord}.`}`,
      });
    }
    const workerCount = workers.length;
    departments.push({
      id: department.id,
      label,
      colorHex: departmentHex(department),
      counts: `${head ? '1 department head' : 'no department head'} · ${plural(workerCount, 'worker')}`,
      desks,
      href: `#/departments/${encodeURIComponent(department.id)}`,
    });
  }
  const projectWithCheck = ws.liveProjects.some((project) => {
    const fact = ws.checks.get(project.id);
    return project.checks.length > 0 || (fact?.count ?? 0) > 0;
  });
  return {
    empty: departments.length === 0 && ws.liveDepartments.length === 0,
    departments,
    createTile: { enabled: projectWithCheck, href: '#/departments/new', note: projectWithCheck ? null : 'Opens after you add a project with a check.' },
  };
}
