/** Agent configuration uses the same revisioned workspace operations as the CLI. */
import { getJson, postJson } from '../../workspace/src/api.js';
import { runtimeReport } from '../../workspace/src/runtime-settings.js';

export const providers = [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }];
const failure = (fields, message = 'Check the highlighted agent settings.') => Object.assign(new Error(message), { fields });
const runtimeType = (adapter) => adapter === 'codex' ? 'codex-cli' : adapter;
const providerFor = (adapter) => adapter === 'codex' ? 'openai' : adapter === 'claude-code' ? 'anthropic' : 'custom';
const runtimeNames = { codex: 'Codex CLI', 'claude-code': 'Claude Code' };
const standardBindings = { 'codex-local': { adapter: 'codex', executable: 'codex' }, 'claude-local': { adapter: 'claude-code', executable: 'claude' } };

export function createAgentStore({ employees = [], departments = [], runtimes = [], control = {}, workspace = null, getWorkspace, onWorkspace = () => {}, load = getJson, commit = postJson } = {}) {
  let document = workspace;
  let warning = '';
  const coordinator = { ...control, id: 'control', name: 'Coordinator', role: 'System scheduler', departmentId: 'control', isCoordinator: true, model: '', runtime: '', instructions: 'The system scheduler routes tasks to configured department heads. It is not a model agent.', status: 'system' };
  const current = () => {
    const external = getWorkspace?.();
    return external && (external.revision ?? external.workspace?.revision ?? 0) > (document?.revision ?? document?.workspace?.revision ?? -1) ? external : document || external;
  };
  const config = () => current()?.workspace || current();
  function bindings() {
    return Object.entries({ ...standardBindings, ...config()?.runtimes }).filter(([, runtime]) => runtimeNames[runtime.adapter]).map(([id, runtime]) => {
      const reports = current()?.runtimes?.reports || runtimes.map((item) => item.report).filter(Boolean);
      const report = runtimeReport(reports, id, runtime);
      const status = !report ? 'Not checked' : !report.installed ? 'Not found' : report.auth === 'logged_out' ? 'Sign-in required' : !report.adapterSupported ? 'Unsupported version' : report.controllable === false ? 'Runtime controls unavailable' : report.auth === 'logged_in' ? 'Signed in' : 'Sign-in not confirmed';
      return { ...runtime, id, name: `${runtimeNames[runtime.adapter]}${id in standardBindings ? '' : ` · ${id}`}`, configured: Boolean(config()?.runtimes?.[id]), status, ready: status === 'Signed in' };
    });
  }
  function decorate(agent) {
    const runtime = config()?.runtimes?.[agent.runtime] || {};
    const prior = employees.find((item) => item.id === agent.id) || {};
    return { ...prior, ...agent, workspaceRole: agent.role, workspaceRuntimeId: agent.runtime, runtimeId: agent.runtime, runtime: runtimeType(runtime.adapter), provider: providerFor(runtime.adapter), model: agent.model ?? runtime.model ?? '', modelOverride: agent.model ?? '', runtimeModel: runtime.model ?? '', isCoordinator: false, isCustom: prior.isCustom ?? !Number.isFinite(prior.x), status: agent.archived ? 'archived' : prior.status || 'configured', task: prior.task || '' };
  }
  function setWorkspace(next) {
    document = next;
    const value = next?.workspace || next;
    if (!value?.agents) return;
    const agents = value.agents.filter((agent) => !agent.archived).map(decorate);
    employees.splice(0, employees.length, ...agents);
    for (const department of departments) if (Array.isArray(department.employees)) department.employees.splice(0, department.employees.length, ...agents.filter((agent) => agent.departmentId === department.id).map((agent) => agent.id));
  }
  async function publish(result) {
    const next = { ...(current()?.workspace ? current() : {}), workspace: result.workspace, revision: result.revision };
    setWorkspace(next);
    warning = '';
    try { await onWorkspace(next); } catch { warning = 'Saved. Refresh the page to reload the workspace view.'; }
    return next;
  }
  async function refresh() { const next = await load('/api/workspace'); setWorkspace(next); await onWorkspace(next); return next; }
  const list = ({ archived = false, includeArchived = false } = {}) => (config()?.agents || []).filter((agent) => includeArchived || Boolean(agent.archived) === archived).map(decorate);
  const get = (id, { includeArchived = false } = {}) => id === 'control' ? coordinator : list({ includeArchived }).find((agent) => agent.id === id);
  async function archive(id, expectRevision = current()?.revision ?? config()?.revision) {
    if (id === 'control') throw failure({}, 'The coordinator is the system scheduler and cannot be archived.');
    const agent = get(id);
    if (!agent) throw failure({}, 'This agent is no longer active. Reload the directory.');
    const result = await commit('/api/workspace/ops', { expectRevision, ops: [{ op: 'agent.archive', id }] });
    await publish(result);
    return get(id, { includeArchived: true });
  }
  async function save(values) {
    if (!config()?.agents) await refresh();
    const base = config();
    const existing = values.id ? base.agents.find((agent) => agent.id === values.id && !agent.archived) : null;
    const replacing = values.replaceId ? base.agents.find((agent) => agent.id === values.replaceId && !agent.archived && agent.role === 'head') : null;
    if (values.id === 'control') throw failure({}, 'The coordinator is a system scheduler. Edit a department head to change its model.');
    if (values.id && !existing) throw failure({}, 'This agent no longer exists. Reload the directory.');
    if (values.replaceId && (!replacing || values.id)) throw failure({}, 'The head to replace has changed. Reload the directory.');
    const name = String(values.name || '').trim();
    const instructions = String(values.instructions || '').trim();
    const model = String(values.model || '').trim();
    const role = existing?.role || replacing?.role || String(values.role || 'worker').toLowerCase();
    const departmentId = replacing?.departmentId || values.departmentId;
    const fields = {};
    if (!name || name.length > 60) fields.name = 'Enter a name from 1 to 60 characters.';
    if (!instructions || instructions.length > 12000) fields.instructions = 'Enter instructions from 1 to 12,000 characters.';
    if (model.length > 128) fields.model = 'Use an exact model ID of at most 128 characters.';
    if (!['head', 'worker'].includes(role) || (existing && values.role !== existing.role)) fields.role = 'An agent keeps its head or worker role.';
    const department = base.departments.find((item) => item.id === departmentId && !item.archived);
    if (!department) fields.departmentId = 'Choose an active department.';
    if (existing?.role === 'head' && departmentId !== existing.departmentId) fields.departmentId = 'A head stays in its department.';
    if (!existing && role === 'head' && base.agents.some((agent) => !agent.archived && agent.role === 'head' && agent.departmentId === departmentId && agent.id !== replacing?.id)) fields.departmentId = 'This department already has a head. Use Replace head to change its identity.';
    const projectIds = role === 'head' ? [] : Array.isArray(values.projectIds) ? [...new Set(values.projectIds)] : existing?.projectIds || [];
    if (projectIds.some((id) => !base.projects.some((project) => project.id === id && !project.archived))) fields.projectIds = 'Choose projects that are still registered.';
    // Accept the older adapter-shaped input while the editor uses the exact binding ID.
    const legacyAdapter = values.runtime === 'codex-cli' ? 'codex' : values.runtime === 'claude-code' ? 'claude-code' : null;
    const runtimeId = values.workspaceRuntimeId || (legacyAdapter ? (existing && base.runtimes[existing.runtime]?.adapter === legacyAdapter ? existing.runtime : legacyAdapter === 'codex' ? 'codex-local' : 'claude-local') : values.runtime);
    const binding = bindings().find((item) => item.id === runtimeId);
    if (!binding) fields.runtime = 'Choose a configured Codex CLI or Claude Code binding.';
    if (Object.keys(fields).length) throw failure(fields);
    const ops = [];
    if (existing) {
      ops.push({ op: 'agent.edit', id: existing.id, name, instructions, runtime: runtimeId, departmentId, model: model || null });
      if (existing.role === 'worker') {
        for (const id of existing.projectIds) if (!projectIds.includes(id)) ops.push({ op: 'agent.unassign', agentId: existing.id, projectId: id });
        for (const id of projectIds) if (!existing.projectIds.includes(id)) ops.push({ op: 'agent.assign', agentId: existing.id, projectId: id });
      }
    } else {
      if (replacing) ops.push({ op: 'agent.archive', id: replacing.id });
      let id;
      if (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === 'control') {
        const used = new Set([...base.agents.map((agent) => agent.id), ...(base.retiredIds?.agents || [])]);
        id = 'control-worker'; let suffix = 2; while (used.has(id)) id = `control-worker-${suffix++}`;
      }
      ops.push({ op: 'agent.add', ...(id ? { id } : {}), name, role, departmentId, runtime: runtimeId, instructions, projectIds, ...(role === 'head' ? { policy: 'analysis' } : {}), ...(model ? { model } : {}) });
    }
    const result = await commit('/api/workspace/ops', { expectRevision: values.expectRevision ?? current()?.revision ?? base.revision, ops });
    await publish(result);
    const id = existing?.id || result.created?.agents?.[0] || result.workspace.agents.find((agent) => !base.agents.some((old) => old.id === agent.id))?.id;
    return get(id);
  }
  if (workspace) setWorkspace(workspace);
  return { list, get, save, archive, setWorkspace, refresh, get runtimeBindings() { return bindings(); }, get departments() { return (config()?.departments || []).filter((department) => !department.archived).map((department) => ({ ...departments.find((item) => item.id === department.id), ...department })); }, providers, get projects() { return (config()?.projects || []).filter((project) => !project.archived); }, get revision() { return current()?.revision ?? config()?.revision ?? 0; }, get storageWarning() { return warning; } };
}
