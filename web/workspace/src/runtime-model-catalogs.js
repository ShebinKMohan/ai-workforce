import { catalogForRuntime } from './runtime-model-options.js';

/** A demand-loaded cache scoped to a binding's executable, with stale response protection. */
export function createModelCatalogStore({ load, onChange = () => {} }) {
  const catalogs = new Map();
  const pending = new Map();
  async function ensure(runtimeId, binding, { refresh = false } = {}) {
    if (!runtimeId || !binding || !['codex', 'claude-code'].includes(binding.adapter)) return null;
    const cached = catalogForRuntime(catalogs, runtimeId, binding);
    if (cached && !refresh) return pending.get(runtimeId)?.promise || cached;
    const identity = { runtimeId, adapter: binding.adapter, configuredExecutable: binding.executable };
    const request = {};
    catalogs.set(runtimeId, { ...identity, status: 'loading', models: [], diagnostics: [] });
    pending.set(runtimeId, request);
    onChange();
    request.promise = (async () => {
      let catalog;
      try {
        catalog = await load(runtimeId, refresh);
        if (catalog?.runtimeId !== runtimeId || catalog.adapter !== identity.adapter || catalog.configuredExecutable !== identity.configuredExecutable) throw new Error('The runtime binding changed while models were being read. Refresh its model list.');
      } catch (error) {
        catalog = { ...identity, status: 'unavailable', models: [], diagnostics: [error.message || 'Could not read models from this runtime.'] };
      }
      if (pending.get(runtimeId) !== request) return null;
      pending.delete(runtimeId);
      catalogs.set(runtimeId, catalog);
      onChange();
      return catalog;
    })();
    return request.promise;
  }
  return { catalogs, ensure, invalidate(runtimeId) { pending.delete(runtimeId); catalogs.delete(runtimeId); } };
}
