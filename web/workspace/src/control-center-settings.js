/** Editable intake-role settings. Omitted configuration means automatic runtime selection. */
export function controlCenterDefaults(config) {
  const current = config?.controlCenter;
  return { runtime: current?.runtime || '', model: current?.model || '', effort: current?.effort || '', instructions: current?.instructions || '', routes: Object.fromEntries((current?.projectRoutes || []).map((route) => [route.projectId, route.departmentId])) };
}

export function buildControlCenterOp(config, values) {
  const runtime = String(values.runtime || '').trim();
  if (!runtime) return { op: 'control-center.set', runtime: null };
  const binding = config?.runtimes?.[runtime];
  if (!binding || !['codex', 'claude-code'].includes(binding.adapter)) throw new Error('Select a configured Codex or Claude Code runtime for Control Center.');
  const model = String(values.model || '').trim();
  const effort = String(values.effort || '').trim();
  const instructions = String(values.instructions || '').trim();
  if (model.length > 128 || /[\r\n\0]/.test(model)) throw new Error('Enter an exact model ID within 128 characters.');
  if (effort.length > 32 || /[\r\n\0]/.test(effort)) throw new Error('Enter a supported effort value within 32 characters.');
  if (instructions.length > 12000) throw new Error('Keep Control Center instructions within 12,000 characters.');
  const projectRoutes = Object.entries(values.routes || {}).filter(([, departmentId]) => Boolean(departmentId)).map(([projectId, departmentId]) => ({ projectId, departmentId }));
  for (const route of projectRoutes) {
    if (!config.projects?.some((project) => project.id === route.projectId) || !config.departments?.some((department) => department.id === route.departmentId)) throw new Error('A saved project route is no longer available. Refresh the settings before saving.');
  }
  return { op: 'control-center.set', runtime, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(instructions ? { instructions } : {}), ...(projectRoutes.length ? { projectRoutes } : {}) };
}
