import { portraitById, setAvatarProfiles } from './avatar-catalog.js';
import { api, workforce } from './runtime-client.js';

/** View model for the connected Workforce workspace. Never imports sample staff. */
export const departments = [];
export const projects = [];
export const runtimes = [];
export const providers = [];
export const departmentColors = ['blue', 'rose', 'sand', 'lavender', 'sage', 'slate'];
export const colorValues = { blue: '#49679B', rose: '#A35D64', sand: '#A16736', lavender: '#805793', sage: '#397969', slate: '#537D8C' };
export function agentJobTitle(agent) {
  if (agent?.jobTitle?.trim()) return agent.jobTitle.trim();
  const declared = agent?.instructions?.match(/^\s*ROLE\s*:\s*([^\r\n]+)/im)?.[1]?.trim();
  return declared || (agent?.isCoordinator ? 'Control Center' : agent?.role === 'head' || agent?.runtimeRole === 'head' || agent?.isHead ? 'Department head' : 'Worker');
}
export const departmentIcons = ['code', 'people', 'layers'];
export const orchestrator = { id: 'control-center', name: 'Tom Chandler', role: 'Control Center', departmentId: 'company', isCoordinator: true, isHead: false, skills: [], projectIds: [], model: '', effort: '', runtime: '', instructions: '', archived: false, status: 'Connecting' };
export const limits = {};
export let storageWarning = '';
export let revision = null;
export let connected = false;
let config = null;
let envelope = null;
let agentRecords = [];
const catalogs = new Map();
const listeners = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (fields, message = 'Check the highlighted settings.') => Object.assign(new Error(message), { fields });
export const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const setWorkProvider = () => {}; // Runtime operations enforce their own constraints.
export const activeDepartments = () => departments.filter(d => !d.archived);
export const allAgents = ({ includeArchived = false } = {}) => [orchestrator, ...agentRecords.filter(a => includeArchived || (!a.archived && !departments.find(d => d.id === a.departmentId)?.archived))];
export const getAgent = id => id === orchestrator.id ? orchestrator : agentRecords.find(a => a.id === id);
export const runtimeInfo = id => config?.runtimes?.[id] || null;
export const runtimeReport = id => id ? envelope?.runtimes?.reports?.find(r => r.runtimeId === id && (!r.configuredExecutable || r.configuredExecutable === runtimeInfo(id)?.executable)) || null : null;
export const modelCatalog = id => catalogs.get(id) || null;
export async function loadModels(id, { force = false } = {}) {
  if (!id) return { models: [], status: 'unavailable', diagnostics: ['Choose a runtime first.'] };
  if (catalogs.has(id) && !force) return catalogs.get(id);
  const result = await api(`/api/runtimes/${encodeURIComponent(id)}/models${force ? '?refresh=1' : ''}`);
  catalogs.set(id, result);
  return result;
}
export function syncWorkspace(payload = workforce.workspace) {
  const next = payload?.workspace || payload;
  if (!next || !Array.isArray(next.agents) || !Array.isArray(next.departments)) return;
  envelope = payload?.workspace ? payload : { workspace: next };
  config = clone(next); revision = next.revision; connected = true; storageWarning = '';
  const labels = { codex: 'Codex', 'claude-code': 'Claude Code' };
  runtimes.splice(0, runtimes.length, ...Object.entries(next.runtimes || {}).map(([id, r]) => [id, `${labels[r.adapter] || r.adapter} · ${id}`]));
  providers.splice(0, providers.length, ...[...new Set(Object.values(next.runtimes || {}).map(r => r.adapter))].map(a => [a, labels[a] || a]));
  projects.splice(0, projects.length, ...next.projects.map(p => ({ ...p })));
  Object.keys(limits).forEach(key => delete limits[key]); Object.assign(limits, next.limits);
  const oldAgents = new Map(agentRecords.map(a => [a.id, a]));
  agentRecords = next.agents.map(record => {
    const runtime = next.runtimes[record.runtime] || {};
    const target = oldAgents.get(record.id) || {};
    Object.assign(target, record, { avatarId: record.avatarId || null, role: agentJobTitle(record), jobTitle: agentJobTitle(record), runtimeRole: record.role, isHead: record.role === 'head', isCoordinator: false, skills: [...record.capabilities], provider: runtime.adapter || '', model: record.model || '', effort: record.effort || '', effectiveModel: record.model || runtime.model || '', effectiveEffort: record.effort || runtime.effort || '', status: record.archived ? 'Archived' : record.role === 'head' ? 'Department head' : record.projectScope !== 'restricted' ? 'Available across projects' : record.projectIds.length ? 'Available on selected projects' : 'No projects allowed' });
    return target;
  });
  const oldDepartments = new Map(departments.map(d => [d.id, d]));
  departments.splice(0, departments.length, ...next.departments.map(record => {
    const lead = agentRecords.find(a => a.id === record.headAgentId && !a.archived) || { id: '', name: 'Head needed', role: 'Vacant department head', isVacant: true, isHead: true, skills: [], projectIds: [], archived: false, runtime: '', model: '' };
    const color = colorValues[record.color] || colorValues.blue;
    return Object.assign(oldDepartments.get(record.id) || {}, record, { colorName: record.color, color, tint: `${color}12`, icon: /frontend|design/i.test(record.name) ? 'palette' : /backend|data/i.test(record.name) ? 'layers' : /security|platform/i.test(record.name) ? 'shield' : /quality|test/i.test(record.name) ? 'circleCheck' : /architecture|engineering|development/i.test(record.name) ? 'code' : /sales/i.test(record.name) ? 'people' : 'layers', purpose: record.note || '', focus: record.note || `${record.name} department`, lead, members: agentRecords.filter(a => a.departmentId === record.id && a.id !== lead.id), activeCount: 0 });
  }));
  const chosen = next.controlCenter || {};
  const selectedRuntime = chosen.runtime || Object.keys(next.runtimes).find(id => next.runtimes[id].adapter === 'codex') || Object.keys(next.runtimes)[0] || '';
  Object.assign(orchestrator, { avatarId: chosen.avatarId || null, runtime: selectedRuntime, provider: next.runtimes[selectedRuntime]?.adapter || '', model: chosen.model || '', effort: chosen.effort || '', effectiveModel: chosen.model || next.runtimes[selectedRuntime]?.model || '', effectiveEffort: chosen.effort || next.runtimes[selectedRuntime]?.effort || '', instructions: chosen.instructions || '', projectRoutes: chosen.projectRoutes || [], automatic: !next.controlCenter, status: selectedRuntime ? 'Configured' : 'Runtime needed' });
  setAvatarProfiles([orchestrator, ...agentRecords]);
}
export async function refreshOrganization() {
  const payload = await api('/api/workspace');
  syncWorkspace(payload); workforce.publishWorkspace(payload); return payload;
}
export const loadOrganization = refreshOrganization;
function required(values, key, max = 60) {
  const value = typeof values[key] === 'string' ? values[key].trim() : '';
  if (!value || value.length > max) throw fail({ [key]: `Enter 1–${max} characters.` });
  return value;
}
function runtimeFields(values, previous = null) {
  const runtime = values.runtime;
  if (!config?.runtimes[runtime]) throw fail({ runtime: 'Choose a configured runtime.' });
  const model = String(values.model || '').trim();
  const effort = String(values.effort || '').trim();
  const catalog = catalogs.get(runtime);
  const selectedModel = model || config.runtimes[runtime].model || catalog?.defaultModel;
  const found = catalog?.models?.find(m => m.id === selectedModel);
  // A catalog refresh must not make a job-title or department edit change an
  // existing account/model choice. New choices still need catalog validation.
  const modelChanged = !previous || previous.runtime !== runtime || String(previous.model || '').trim() !== model;
  const effortChanged = modelChanged || String(previous?.effort || '').trim() !== effort;
  if (modelChanged && model && catalog?.status === 'available' && !found) throw fail({ model: 'Choose a model reported by this runtime.' });
  if (effortChanged && effort && ((found && !(found.efforts || []).includes(effort)) || (!found && catalog?.status === 'available'))) throw fail({ effort: 'Choose an effort supported by this model.' });
  return { runtime, model, effort };
}
async function commit(ops, type, previous, findNext) {
  if (!config || revision === null) throw fail({ connection: 'Wait for the connected workspace to load.' });
  const prior = previous ? clone(previous) : null;
  try {
    const response = await api('/api/workspace/ops', { expectRevision: revision, ops });
    let payload = response?.workspace?.agents ? { ...envelope, ...response } : null; let refreshWarning = '';
    try { payload = await api('/api/workspace'); } catch (error) { if (!payload) throw error; refreshWarning = 'Changes were saved. Runtime readiness could not refresh yet.'; }
    syncWorkspace(payload); storageWarning = refreshWarning; workforce.publishWorkspace(payload);
    const next = findNext?.(response) || null;
    const event = { type, previous: prior, next: next ? clone(next) : null };
    for (const listener of listeners) { try { listener(event); } catch (error) { console.error('Organization subscriber failed', error); } }
    return next;
  } catch (error) {
    if (error.status === 409 || /revision|conflict|changed/i.test(error.message)) throw fail({ connection: 'The workspace changed elsewhere. Your draft is preserved. Return to the directory to reload the latest settings before saving.' }, 'Workspace changed before this save.');
    throw error;
  }
}
function capabilities(values) {
  const list = typeof values.skills === 'string' ? values.skills.split(',').map(x => x.trim()).filter(Boolean) : values.skills || [];
  if (list.length > 32 || list.some(x => typeof x !== 'string' || x.length > 64)) throw fail({ skills: 'Use up to 32 capabilities, each at most 64 characters.' });
  return [...new Set(list)];
}
export async function saveAgent(values) {
  const previous = values.id ? getAgent(values.id) : null;
  if (values.id && !previous) throw fail({ name: 'This employee no longer exists.' });
  if (previous?.archived) throw fail({ name: 'Archived records are read-only. Create a new employee to fill this role.' });
  const selected = runtimeFields(values, previous);
  const avatarId = values.avatarId === undefined ? previous?.avatarId || null : selectedAvatar(values.avatarId);
  const instructions = String(values.instructions || '').trim();
  if (instructions.length > 12000 || (!previous?.isCoordinator && !instructions)) throw fail({ instructions: 'Enter instructions using 1–12,000 characters.' });
  if (previous?.isCoordinator) {
    const projectRoutes = values.projectRoutes ?? config.controlCenter?.projectRoutes;
    if (projectRoutes && (!Array.isArray(projectRoutes) || projectRoutes.some(r => !projects.some(p => p.id === r.projectId && !p.archived) || !activeDepartments().some(d => d.id === r.departmentId)))) throw fail({ projectRoutes: 'Choose active projects and departments for routing.' });
    const op = { op: 'control-center.set', runtime: selected.runtime, ...(avatarId ? { avatarId } : {}), ...(selected.model ? { model: selected.model } : {}), ...(selected.effort ? { effort: selected.effort } : {}), ...(instructions ? { instructions } : {}), ...(projectRoutes ? { projectRoutes } : {}) };
    const patch = {};
    const ranges = { maxActiveTurns: [1,64], maxActiveWriters: [1,64], maxTasksPerRun: [1,1000], maxConcurrentProjectRuns: [1,32], maxRepairAttempts: [0,100], maxTransientRetries: [0,100], maxDelegationDepth: [0,16], runTimeoutMinutes: [1,10080] };
    for (const [key, [min,max]] of Object.entries(ranges)) if (values[key] !== undefined) { const n = Number(values[key]); if (!Number.isInteger(n) || n < min || n > max) throw fail({ [key]: `Use a whole number from ${min} to ${max}.` }); patch[key] = n; }
    return commit([op, ...(Object.keys(patch).length ? [{ op: 'limits.set', limits: patch }] : [])], 'agent-updated', previous, () => orchestrator);
  }
  const name = required(values, 'name');
  const departmentId = values.departmentId;
  if (!activeDepartments().some(d => d.id === departmentId)) throw fail({ departmentId: 'Choose an active department.' });
  const role = values.role || previous?.runtimeRole || 'worker';
  const jobTitle = typeof values.jobTitle === 'string' ? values.jobTitle.trim() : previous?.jobTitle || '';
  if (jobTitle.length > 100 || /[\u0000-\u001f\u007f]/.test(jobTitle)) throw fail({ jobTitle: 'Use a single job title of up to 100 characters.' });
  if (!['head','worker'].includes(role)) throw fail({ role: 'Choose a department head or team member.' });
  const policy = role === 'head' ? 'analysis' : values.policy || previous?.policy || 'local-development';
  if (!['analysis','local-development','verification'].includes(policy)) throw fail({ policy: 'Choose an execution policy.' });
  const projectScope = role === 'head' ? 'all' : values.projectScope || previous?.projectScope || 'all';
  if (!['all','restricted'].includes(projectScope)) throw fail({ projectScope: 'Choose all projects or selected projects.' });
  const projectIds = projectScope === 'all' ? [] : [...new Set(values.projectIds || [])];
  if (role === 'head' && projectIds.length) throw fail({ projectIds: 'Department heads reach projects through their specialists.' });
  if (projectIds.some(id => !projects.some(p => p.id === id && !p.archived))) throw fail({ projectIds: 'Choose active projects.' });
  const common = { name, ...(jobTitle ? { jobTitle } : previous ? { jobTitle: null } : {}), ...(avatarId ? { avatarId } : previous ? { avatarId: null } : {}), runtime: selected.runtime, instructions, capabilities: capabilities(values), policy, departmentId, projectScope, projectIds };
  const ops = previous ? [{ op: 'agent.edit', id: previous.id, ...common, role, model: selected.model || null, effort: selected.effort || null }] : [{ op: 'agent.add', ...common, role, ...(selected.model ? { model: selected.model } : {}), ...(selected.effort ? { effort: selected.effort } : {}) }];
  const oldIds = new Set(agentRecords.map(a => a.id));
  return commit(ops, previous ? 'agent-updated' : 'agent-created', previous, () => previous ? getAgent(previous.id) : agentRecords.find(a => !oldIds.has(a.id)));
}
function selectedAvatar(value, field = 'avatarId') {
  if (value === '' || value === null) return null;
  if (!portraitById(value)) throw fail({ [field]: 'Choose one of the bundled headshots.' });
  return value;
}
function freshId(name) {
  const taken = new Set([...config.departments.map(d => d.id), ...(config.retiredIds?.departments || [])]);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'department';
  let id = slug; let n = 2; while (taken.has(id)) id = `${slug}-${n++}`; return id;
}
export async function saveDepartment(values) {
  const previous = values.id ? departments.find(d => d.id === values.id) : null;
  if (values.id && !previous) throw fail({ name: 'This department no longer exists.' });
  if (previous?.archived) throw fail({ name: 'Archived departments are read-only.' });
  const name = required(values, 'name'); const note = String(values.purpose || '').trim();
  if (note.length > 60) throw fail({ purpose: 'Use at most 60 characters for the department focus.' });
  const color = values.color || previous?.colorName || 'blue';
  if (!departmentColors.includes(color)) throw fail({ color: 'Choose a department color.' });
  const id = previous?.id || freshId(name);
  const ops = [{ op: previous ? 'department.edit' : 'department.add', id, name, color, ...(note ? { note } : previous ? { note: null } : {}) }];
  const headName = String(values.headName || '').trim();
  if (headName) {
    if (headName.length > 60) throw fail({ headName: 'Use at most 60 characters.' });
    let selected;
    try { selected = runtimeFields({ runtime: values.headRuntime, model: values.headModel, effort: values.headEffort }); } catch (error) { if (error.fields) error.fields = Object.fromEntries(Object.entries(error.fields).map(([key,value]) => [`head${key.charAt(0).toUpperCase()}${key.slice(1)}`,value])); throw error; }
    if (previous?.lead?.id) ops.push({ op: 'agent.archive', id: previous.lead.id });
    const avatarId = values.headAvatarId ? selectedAvatar(values.headAvatarId, 'headAvatarId') : null;
    ops.push({ op: 'agent.add', name: headName, ...(avatarId ? { avatarId } : {}), role: 'head', departmentId: id, runtime: selected.runtime, ...(selected.model ? { model: selected.model } : {}), ...(selected.effort ? { effort: selected.effort } : {}), policy: 'analysis', jobTitle: `${name} Lead`, instructions: 'Read the request and project. Delegate clear tasks to specialists, review their evidence, and resolve routine blockers before escalating.', capabilities: ['planning'], projectIds: [] });
  }
  return commit(ops, previous ? 'department-updated' : 'department-created', previous, () => departments.find(d => d.id === id));
}
export async function archiveAgent(id) { const previous = getAgent(id); if (!previous || previous.isCoordinator) throw fail({ agent: 'The Control Center cannot be archived.' }); return commit([{ op: 'agent.archive', id }], 'agent-archived', previous, () => getAgent(id)); }
export async function archiveDepartment(id) { const previous = departments.find(d => d.id === id); return commit([{ op: 'department.archive', id }], 'department-archived', previous, () => departments.find(d => d.id === id)); }

/** One click applies the server's versioned, idempotent organization template. */
export async function setupTechTeam() {
  const proposal = await api('/api/workspace/templates/nathan-james');
  if (!Array.isArray(proposal.ops)) throw new Error('The team setup could not be loaded. Try again.');
  const warnings = [...(proposal.warnings || [])];
  const changed = proposal.ops.length > 0;
  const response = changed ? await api('/api/workspace/ops', { expectRevision: proposal.revision, ops: proposal.ops }) : null;
  let refreshWarning = '';
  try { await refreshOrganization(); }
  catch (error) {
    if (changed) {
      if (!response?.workspace?.agents) throw error;
      const payload = { ...envelope, ...response };
      syncWorkspace(payload); workforce.publishWorkspace(payload);
      refreshWarning = 'Your team was saved. Runtime readiness could not refresh yet.';
    } else refreshWarning = 'Your team is already configured. The latest workspace view could not refresh yet.';
    storageWarning = refreshWarning;
    warnings.push(refreshWarning);
  }
  const message = changed ? 'Your tech team is set up. Each department has a lead and clear responsibilities.' : 'Your tech team is already set up.';
  return { message: [message, ...warnings].join(' '), response, warnings };
}
