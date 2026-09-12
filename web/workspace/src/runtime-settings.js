/** A configured executable has its own discovery result; adapter identity is insufficient. */
export const SUPPORTED_RUNTIME_ADAPTERS = ['codex', 'claude-code'];
export function runtimeReport(reports, id, binding) {
  const exact = reports.find((report) => report.runtimeId === id && report.adapter === binding.adapter && report.configuredExecutable === binding.executable);
  if (exact) return exact;
  if (reports.some((report) => report.runtimeId === id)) return null;
  const standard = binding.adapter === 'codex' ? 'codex' : binding.adapter === 'claude-code' ? 'claude' : null;
  return reports.find((report) => !report.runtimeId && report.adapter === binding.adapter && (binding.executable === standard || binding.executable === report.executable || binding.executable === report.realPath)) || null;
}

export function runtimeSettingsRows(config, reports = []) {
  const rows = Object.entries(config?.runtimes || {}).map(([id, binding]) => ({ id, binding, configured: true, report: runtimeReport(reports, id, binding) }));
  for (const [id, adapter, executable] of [['codex-local', 'codex', 'codex'], ['claude-local', 'claude-code', 'claude']]) {
    if (!rows.some((row) => row.id === id)) {
      const binding = { adapter, executable };
      rows.push({ id, binding, configured: false, report: runtimeReport(reports, id, binding) });
    }
  }
  return rows;
}

export function buildRuntimeSettingsOp(config, { id, adapter, executable, model, effort }) {
  id = String(id || '').trim();
  executable = String(executable || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error('Use a runtime ID with letters, numbers, periods, hyphens, or underscores.');
  if (!SUPPORTED_RUNTIME_ADAPTERS.includes(adapter)) throw new Error('This build supports Codex and Claude Code adapters. Other CLIs require a tested adapter.');
  if (!executable || /[\r\n\0]/.test(executable) || (!executable.startsWith('/') && /[\s/\\]/.test(executable))) throw new Error('Enter an absolute executable path or a command name such as codex. The executable field does not accept command arguments.');
  const existing = config?.runtimes?.[id];
  if (existing && existing.adapter !== adapter) throw new Error('Create a new binding to use a different adapter. Existing agents keep their runtime identity.');
  const nextModel = model === undefined ? existing?.model : String(model).trim();
  const nextEffort = effort === undefined ? existing?.effort : String(effort).trim();
  if (nextModel && (nextModel.length > 128 || /[\r\n\0]/.test(nextModel))) throw new Error('Use an exact model ID within 128 characters, or leave it blank for the runtime default.');
  if (nextEffort && (nextEffort.length > 32 || /[\r\n\0]/.test(nextEffort))) throw new Error('Use a reasoning effort reported by this runtime, within 32 characters, or leave it blank.');
  return { op: 'runtime.set', id, adapter, executable, ...(nextModel ? { model: nextModel } : {}), ...(nextEffort ? { effort: nextEffort } : {}) };
}
