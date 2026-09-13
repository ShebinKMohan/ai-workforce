/** Runtime-reported choices only. Saved overrides remain visible when discovery cannot confirm them. */
const modelsOf = (catalog) => catalog?.status === 'available' && Array.isArray(catalog.models) ? catalog.models : [];
const defaultModel = (catalog) => catalog?.status === 'available' ? catalog.defaultModel || modelsOf(catalog).find((model) => model.isDefault)?.id || '' : '';
const inheritedLabel = (label, value) => value ? `${label} · ${value}` : label;
const catalogPending = (catalog) => !catalog || catalog.status === 'loading';

export function catalogForRuntime(catalogs, runtimeId, binding) {
  const catalog = catalogs?.get?.(runtimeId) ?? catalogs?.[runtimeId];
  return binding && catalog?.runtimeId === runtimeId && catalog.adapter === binding.adapter && catalog.configuredExecutable === binding.executable ? catalog : null;
}

function catalogHint(catalog) {
  if (catalogPending(catalog)) return 'Reading runtime models…';
  if (catalog?.status !== 'available') return catalog?.diagnostics?.[0] || 'Model choices are unavailable. Use the runtime default or refresh after checking the runtime.';
  return 'Choices reported by this installed runtime.';
}

function preserveUnavailable(options, selected, pending = false) {
  if (selected && !options.some((option) => option.value === selected)) options.push({ value: selected, label: `${selected} · ${pending ? 'loading' : 'unavailable'}`, unavailable: !pending });
  return options;
}

export function modelChoices(catalog, selected = '', { inheritLabel = 'Runtime default', inheritedModel = '' } = {}) {
  const pending = catalogPending(catalog);
  const models = modelsOf(catalog);
  const inheritedUnavailable = !!inheritedModel && catalog?.status === 'available' && !models.some((model) => model.id === inheritedModel);
  const options = preserveUnavailable([
    { value: '', label: `${inheritedLabel(inheritLabel, inheritedModel || defaultModel(catalog))}${inheritedUnavailable ? ' · unavailable' : ''}`, unavailable: inheritedUnavailable },
    ...models.map((model) => ({ value: model.id, label: model.label || model.id, unavailable: false })),
  ], selected, pending);
  return { options, disabled: pending || models.length === 0 && !selected, inheritedUnavailable, hint: inheritedUnavailable && !selected ? `The inherited model (${inheritedModel}) is not reported by this runtime. Choose a reported model or update the binding in Settings.` : catalogHint(catalog) };
}

export function effortChoices(catalog, model = '', selected = '', { inheritLabel = 'Runtime default', inheritedModel = '', inheritedEffort = '' } = {}) {
  const pending = catalogPending(catalog);
  const effectiveModel = model || inheritedModel || defaultModel(catalog);
  const reported = modelsOf(catalog).find((entry) => entry.id === effectiveModel);
  const efforts = reported?.effortStatus === 'reported' && Array.isArray(reported.efforts) ? [...new Set(reported.efforts)] : [];
  const inheritedUnavailable = !!inheritedEffort && reported?.effortStatus === 'reported' && !efforts.includes(inheritedEffort);
  const options = preserveUnavailable([
    { value: '', label: `${inheritedLabel(inheritLabel, inheritedEffort || reported?.defaultEffort || '')}${inheritedUnavailable ? ' · unavailable' : ''}`, unavailable: inheritedUnavailable },
    ...efforts.map((effort) => ({ value: effort, label: effort, unavailable: false })),
  ], selected, pending);
  return {
    options,
    disabled: pending || efforts.length === 0 && !selected,
    effectiveModel,
    inheritedUnavailable,
    hint: inheritedUnavailable && !selected ? `The inherited effort (${inheritedEffort}) is unavailable for this model. ${efforts.length ? 'Choose a reported effort.' : 'Clear the runtime binding’s effort override in Settings.'}` : efforts.length ? 'Reasoning levels reported for the selected model.' : pending ? 'Reading reasoning options…' : 'This runtime does not report reasoning options for this model. Use the inherited default.',
  };
}

/** Only call after an intentional runtime/model change; refreshes never rewrite saved selections. */
export function reconcileModelSelection({ catalog, model = '', effort = '', inheritedModel = '', changed }) {
  const models = modelsOf(catalog);
  if (changed === 'runtime' && model && !models.some((entry) => entry.id === model)) model = '';
  const effectiveModel = model || inheritedModel || defaultModel(catalog);
  const selected = models.find((entry) => entry.id === effectiveModel);
  if (effort && (selected?.effortStatus !== 'reported' || !selected.efforts?.includes(effort))) effort = '';
  return { model, effort };
}
