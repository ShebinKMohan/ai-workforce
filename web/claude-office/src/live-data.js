/** Original Claude Office shapes, populated only from the live workspace API. */
import { SCENE as originalScene, departments as originalDepartments, employees as originalSeats, control as originalControl } from './data.js';
import { indexWorkspace, taskEntries, toolFact, adapterOf, entryFromStatus } from '../../workspace/src/model.js';
import { floorModel } from '../../workspace/src/office/floor-model.js';

export const SCENE = { ...originalScene };
export const control = { ...originalControl, name: 'System scheduler', role: 'Office coordinator', model: '', runtimeId: '', runtime: '', provider: '', instructions: 'Routes requests to the selected department head. The head plans, workers execute, and independent checks verify the result.' };
export const departments = [];
export const employees = [];
export const runtimes = [];
export const taskCards = [];
export const runtimeReports = [];
export const projects = [];
export const demoCommunications = [];
export let workspaceDoc = null;
export let requestsDoc = null;
export let runsDoc = null;
export let lastError = null;
export let updatedAt = null;
const listeners = new Set();
let pending = null;
const replace = (target, values) => target.splice(0, target.length, ...values);
const matches = { research: /research|knowledge|analysis/i, engineering: /engineering|development|software|coding/i, design: /design|creative|ux/i, marketing: /marketing|sales|content/i, operations: /operations|finance|admin/i, support: /support|customer/i };
const providerFor = (adapter) => adapter === 'codex' ? 'openai' : adapter === 'claude-code' ? 'anthropic' : 'custom';
const runtimeFor = (adapter) => adapter === 'codex' ? 'codex-cli' : adapter;
const firstLine = (text) => String(text ?? '').split('\n')[0];

export function onLiveData(callback) { listeners.add(callback); return () => listeners.delete(callback); }

/** Pure mapping also used for fixture verification; no browser storage or example people enter it. */
export function applyLiveDocuments(workspace, runs, requests) {
  workspaceDoc = workspace;
  runsDoc = runs;
  requestsDoc = requests;
  const ws = indexWorkspace(workspace);
  const entries = taskEntries(ws, runs, requests);
  const floor = floorModel(ws, runs, entries);
  const available = new Set(originalDepartments.map((department) => department.id));
  const assigned = new Map();
  const unmatched = [];
  for (const department of floor.departments) {
    const slot = originalDepartments.find((candidate) => available.has(candidate.id) && matches[candidate.id].test(department.label));
    if (slot) { assigned.set(slot.id, department); available.delete(slot.id); }
    else unmatched.push(department);
  }
  const extra = [];
  for (const department of unmatched) {
    const slotId = available.values().next().value;
    if (slotId) { assigned.set(slotId, department); available.delete(slotId); }
    else extra.push(department);
  }
  const nextDepartments = originalDepartments.map((slot) => {
    const actual = assigned.get(slot.id);
    const source = actual ? ws.departmentById.get(actual.id) : null;
    return { ...slot, id: actual?.id ?? `template:${slot.id}`, sceneId: slot.id, name: actual?.label ?? slot.name, configured: Boolean(actual), template: !actual, workspaceDepartmentId: actual?.id ?? null, employees: actual?.desks.map((desk) => desk.agentId) ?? [], runtimeId: source?.headAgentId ? ws.agentById.get(source.headAgentId)?.runtime ?? '' : '', description: actual ? `${actual.counts}. ${source?.note ?? ''}`.trim() : 'Illustration template · no department configured. Add a department to use this area.', summary: actual?.counts ?? 'Unassigned illustration template', href: actual ? `/workspace/${actual.href}` : '/workspace/#/departments/new' };
  });
  for (const [index, actual] of extra.entries()) {
    const base = originalDepartments[index % originalDepartments.length];
    nextDepartments.push({ ...base, id: actual.id, name: actual.label, sceneId: null, configured: true, template: false, workspaceDepartmentId: actual.id, employees: actual.desks.map((desk) => desk.agentId), runtimeId: '', isCustom: true, description: actual.counts, summary: actual.counts, href: `/workspace/${actual.href}` });
  }
  replace(departments, nextDepartments);

  replace(employees, floor.departments.flatMap((department) => {
    const visual = departments.find((item) => item.id === department.id);
    const seats = originalSeats.filter((seat) => seat.departmentId === visual.sceneId);
    return department.desks.map((desk, index) => {
      const agent = ws.agentById.get(desk.agentId);
      const adapter = adapterOf(ws, agent.runtime);
      const seat = seats[index] ?? { x: visual.x, y: visual.y + 110 + Math.max(0, index - 4) * 48, labelY: visual.y + 74 + Math.max(0, index - 4) * 48 };
      const activeTask = entries.find((entry) => entry.href === desk.href && entry.inMotion);
      const status = ['Working', 'Planning', 'Being checked', 'Waiting'].includes(desk.statusWord) ? 'working' : desk.statusWord === 'Needs you' || desk.statusWord === 'Stalled' ? 'review' : 'configured';
      return { ...agent, id: agent.id, agentId: agent.id, name: agent.name, role: agent.role === 'head' ? 'Department head' : 'Worker', workspaceRole: agent.role, departmentId: department.id, runtimeId: agent.runtime, runtime: runtimeFor(adapter), adapter, provider: providerFor(adapter), customProvider: providerFor(adapter) === 'custom' ? adapter : '', model: agent.model ?? '', instructions: agent.instructions ?? '', x: seat.x, y: seat.y, labelY: seat.labelY, seatId: seats[index]?.id ?? null, isCustom: !seats[index], configured: true, template: false, kind: 'agent', status, statusLabel: desk.statusWord, task: activeTask?.title ?? '', taskHref: activeTask ? `/workspace/${activeTask.href}` : null, href: `/workspace/${desk.href}`, description: desk.ariaLabel };
    });
  }));

  replace(runtimeReports, ws.reports);
  const runtimeRows = Object.entries(ws.config?.runtimes ?? {}).map(([id, config]) => {
    const fact = toolFact(ws, config.adapter);
    const models = [...new Set(ws.liveAgents.filter((agent) => agent.runtime === id).map((agent) => agent.model).filter(Boolean))];
    return { id, name: fact.name, adapter: config.adapter, model: models.join(', ') || 'Runtime default', kind: 'Headless CLI', runtime: runtimeFor(config.adapter), provider: providerFor(config.adapter), status: 'configured', configured: true, connectionLabel: fact.word, version: fact.version, ready: fact.ready, report: fact.report, description: `${fact.name}: ${fact.word}. Passive discovery${fact.version ? `, version ${fact.version}` : ''}; this does not imply an active model session.` };
  });
  for (const report of ws.reports) {
    if (runtimeRows.some((runtime) => runtime.adapter === report.adapter)) continue;
    const fact = toolFact(ws, report.adapter);
    runtimeRows.push({ id: `discovered:${report.adapter}`, name: fact.name, adapter: report.adapter, model: 'No agents assigned', kind: 'Headless CLI', runtime: runtimeFor(report.adapter), provider: providerFor(report.adapter), status: 'discovered', configured: false, connectionLabel: fact.word, version: fact.version, ready: fact.ready, report, description: `${fact.name}: ${fact.word}. Discovered passively; no workspace agent uses it.` });
  }
  replace(runtimes, runtimeRows);
  replace(projects, ws.liveProjects);
  replace(taskCards, entries.map((entry) => {
    const status = entry.item?.state === 'queued' || entry.status.key === 'waiting' ? 'queued' : entry.inMotion ? 'running' : ['verified', 'unverified', 'held', 'interrupted', 'stalled'].includes(entry.status.key) ? 'review' : ['failed', 'noPlan', 'notStarted'].includes(entry.status.key) ? 'failed' : 'done';
    const worker = entry.run?.taskViews?.find((task) => task.ownerAgentId)?.ownerAgentId ?? entry.item?.workerIds?.[0] ?? ws.departmentById.get(entry.departmentId)?.headAgentId ?? null;
    const employeeIds = [...new Set([...(entry.item?.agentIds ?? []), ...(entry.run?.taskViews ?? []).map((task) => task.ownerAgentId), ws.departmentById.get(entry.departmentId)?.headAgentId].filter(Boolean))];
    return { id: entry.key, title: firstLine(entry.title), status, statusLabel: entry.status.word, stateKey: entry.status.key, departmentId: entry.departmentId, employeeId: worker, employeeIds, projectId: entry.projectId, requestId: entry.item?.id ?? null, runId: entry.runId, href: `/workspace/${entry.href}`, summary: entry.status.line ?? '', inMotion: entry.inMotion, verified: entry.status.key === 'verified', needsYou: Boolean(entry.needsYou), at: entry.at, entry };
  }));
  lastError = null;
  updatedAt = new Date().toISOString();
  return snapshot();
}

export function snapshot() { return { workspaceDoc, requestsDoc, runsDoc, tasks: taskCards, projects, reports: runtimeReports, error: lastError, updatedAt }; }

async function read(path) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.error?.message || `Could not read workspace (HTTP ${response.status}).`);
  return body;
}

export async function loadLiveData() {
  if (pending) return pending;
  pending = (async () => {
    try {
      const [workspace, runs, requests] = await Promise.all([read('/api/workspace'), read('/api/runs?limit=100'), read('/api/requests')]);
      // Older queued requests retain their real run evidence even when outside the list window.
      const keys = new Set((runs.runs ?? []).map((run) => `${run.projectId}:${run.id}`));
      const missing = [...new Map((requests.items ?? []).filter((item) => item.runId && !keys.has(`${item.projectId}:${item.runId}`)).map((item) => [`${item.projectId}:${item.runId}`, item])).values()];
      const older = await Promise.allSettled(missing.map((item) => read(`/api/projects/${encodeURIComponent(item.projectId)}/runs/${encodeURIComponent(item.runId)}`)));
      for (const [index, result] of older.entries()) if (result.status === 'fulfilled') {
        const doc = result.value;
        const projectId = missing[index].projectId;
        const lock = (runs.projects ?? []).find((project) => project.projectId === projectId)?.coordinator?.lock ?? null;
        if (doc.run && !keys.has(`${projectId}:${doc.run.id}`)) runs.runs.push(entryFromStatus(indexWorkspace(workspace), projectId, doc, lock).run);
      }
      applyLiveDocuments(workspace, runs, requests);
    } catch (error) { lastError = error.message || String(error); }
    const state = snapshot();
    for (const callback of listeners) callback(state);
    return state;
  })();
  try { return await pending; } finally { pending = null; }
}
