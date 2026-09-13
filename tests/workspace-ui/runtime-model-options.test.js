import { describe, expect, it } from 'vitest';
import { catalogForRuntime, effortChoices, modelChoices, reconcileModelSelection } from '../../web/workspace/src/runtime-model-options.js';
import { createModelCatalogStore } from '../../web/workspace/src/runtime-model-catalogs.js';
import { renderRuntimePanel } from '../../web/workspace/src/pages/runtime-panel.js';
import { contextFor, fixture, uiState } from './support.js';

const binding = { adapter: 'codex', executable: '/tools/codex', model: 'model-a', effort: 'balanced' };
const catalog = {
  runtimeId: 'custom-codex', adapter: 'codex', configuredExecutable: '/tools/codex', status: 'available', defaultModel: 'model-a', diagnostics: [],
  models: [
    { id: 'model-a', label: 'Model A', efforts: ['quick', 'balanced'], defaultEffort: 'balanced', effortStatus: 'reported' },
    { id: 'model-b', label: 'Model B', efforts: ['deep'], defaultEffort: 'deep', effortStatus: 'reported' },
    { id: 'model-c', label: 'Model C', efforts: [], effortStatus: 'unavailable' },
  ],
};

describe('runtime-reported model and effort choices', () => {
  it('uses reported defaults and model-specific efforts without inventing choices', () => {
    expect(modelChoices(catalog).options.map((entry) => entry.value)).toEqual(['', 'model-a', 'model-b', 'model-c']);
    expect(modelChoices(catalog).options[0].label).toBe('Runtime default · model-a');
    expect(effortChoices(catalog, 'model-b').options.map((entry) => entry.value)).toEqual(['', 'deep']);
    expect(effortChoices(catalog, '', '', { inheritedModel: 'model-b' }).effectiveModel).toBe('model-b');
    expect(effortChoices(catalog, 'model-c')).toMatchObject({ disabled: true, options: [{ value: '' }] });
  });

  it('retains saved unknown values and allows clearing them while discovery is unavailable', () => {
    const unavailable = { ...catalog, status: 'unavailable', models: [], diagnostics: ['Sign in to this installation.'] };
    expect(modelChoices(unavailable, 'retired-model')).toMatchObject({ disabled: false, hint: 'Sign in to this installation.', options: [{ value: '' }, { value: 'retired-model', unavailable: true }] });
    expect(effortChoices(unavailable, 'retired-model', 'retired-effort')).toMatchObject({ disabled: false, options: [{ value: '' }, { value: 'retired-effort', unavailable: true }] });
    expect(modelChoices({ ...catalog, status: 'loading' }).disabled).toBe(true);
    expect(modelChoices(catalog, 'retired-model').options.at(-1)).toMatchObject({ value: 'retired-model', unavailable: true });
  });

  it.each([null, { ...catalog, status: 'loading' }])('keeps saved choices visibly pending until initial discovery settles: %j', pending => {
    const models = modelChoices(pending, 'model-a');
    const efforts = effortChoices(pending, 'model-a', 'balanced');
    expect(models).toMatchObject({ disabled: true, hint: 'Reading runtime models…' });
    expect(models.options.at(-1)).toMatchObject({ value: 'model-a', label: 'model-a · loading', unavailable: false });
    expect(efforts.disabled).toBe(true);
    expect(efforts.options.at(-1)).toMatchObject({ value: 'balanced', label: 'balanced · loading', unavailable: false });
    expect(JSON.stringify([models, efforts])).not.toContain('· unavailable');
    expect(modelChoices(catalog, 'retired-model').options.at(-1)).toMatchObject({ value: 'retired-model', label: 'retired-model · unavailable', unavailable: true });
  });

  it('reconciles intentional changes and exposes incompatible inherited effort', () => {
    expect(reconcileModelSelection({ catalog, model: 'model-b', effort: 'balanced', changed: 'model' })).toEqual({ model: 'model-b', effort: '' });
    expect(reconcileModelSelection({ catalog, model: 'model-b', effort: 'deep', changed: 'runtime' })).toEqual({ model: 'model-b', effort: 'deep' });
    expect(reconcileModelSelection({ catalog, model: 'other-runtime-model', effort: 'deep', changed: 'runtime' })).toEqual({ model: '', effort: '' });
    expect(effortChoices(catalog, 'model-b', '', { inheritedEffort: 'balanced' })).toMatchObject({ inheritedUnavailable: true, options: [{ value: '', unavailable: true }, { value: 'deep' }] });
    expect(modelChoices(catalog, '', { inheritedModel: 'retired-model' })).toMatchObject({ inheritedUnavailable: true, options: [{ value: '', unavailable: true }, { value: 'model-a' }, { value: 'model-b' }, { value: 'model-c' }] });
    const noEffort = { ...catalog, models: [{ id: 'model-b', effortStatus: 'reported', efforts: [] }] };
    expect(effortChoices(noEffort, 'model-b', '', { inheritedEffort: 'balanced' }).hint).toContain('Clear the runtime binding’s effort override in Settings.');
  });

  it('rejects catalogs for another configured executable or adapter', () => {
    const catalogs = new Map([['custom-codex', catalog]]);
    expect(catalogForRuntime(catalogs, 'custom-codex', binding)).toBe(catalog);
    expect(catalogForRuntime(catalogs, 'custom-codex', { ...binding, executable: '/another/codex' })).toBeNull();
    expect(catalogForRuntime(catalogs, 'custom-codex', { ...binding, adapter: 'claude-code' })).toBeNull();
    expect(catalogForRuntime(catalogs, 'other-codex', binding)).toBeNull();
  });

  it('renders saved unavailable values as selects and blocks old choices for an edited path', () => {
    const doc = fixture('workspace.json');
    doc.workspace.runtimes = { 'custom-codex': { ...binding, model: 'retired-model', effort: 'old-effort' } };
    const ctx = contextFor(doc, fixture('runs-empty.json'), fixture('requests-empty.json'), { ui: uiState({ modelCatalogs: new Map([['custom-codex', catalog]]), runtimeDrafts: new Map() }) });
    let html = renderRuntimePanel(ctx);
    expect(html).toMatch(/<select id="runtime-model-custom-codex"/);
    expect(html).toContain('value="retired-model" selected disabled');
    expect(html).toContain('value="old-effort" selected disabled');
    expect(html).not.toMatch(/<input[^>]*data-field="(?:model|effort)"/);
    ctx.ui.runtimeDrafts.set('custom-codex', { executable: '/changed/codex', model: '', effort: '' });
    html = renderRuntimePanel(ctx);
    expect(html).toMatch(/id="runtime-model-custom-codex"[^>]*disabled/);
    expect(html).not.toContain('value="model-b"');
    expect(html).toContain('Save the executable binding to read its available models.');
  });
});

describe('on-demand model catalog lifecycle', () => {
  it('does not request anything until demanded, reuses the exact binding, and explicitly refreshes', async () => {
    const calls = [];
    const store = createModelCatalogStore({ load: async (...args) => { calls.push(args); return catalog; } });
    expect(calls).toEqual([]);
    await store.ensure('custom-codex', binding);
    await store.ensure('custom-codex', binding);
    expect(calls).toEqual([['custom-codex', false]]);
    await store.ensure('custom-codex', binding, { refresh: true });
    expect(calls.at(-1)).toEqual(['custom-codex', true]);
  });

  it('discards a slow response after a binding edit and keeps the new installation choices', async () => {
    const responses = [];
    const store = createModelCatalogStore({ load: () => new Promise((resolve) => responses.push(resolve)) });
    const first = store.ensure('custom-codex', binding);
    const changed = { ...binding, executable: '/changed/codex' };
    const second = store.ensure('custom-codex', changed);
    responses[1]({ ...catalog, configuredExecutable: changed.executable, models: [catalog.models[1]] });
    await second;
    responses[0](catalog);
    await first;
    expect(store.catalogs.get('custom-codex')).toMatchObject({ configuredExecutable: '/changed/codex', models: [{ id: 'model-b' }] });
  });

  it('records an unavailable catalog for API errors and mismatched identities without retry loops', async () => {
    let calls = 0;
    const store = createModelCatalogStore({ load: async () => { calls += 1; return { ...catalog, adapter: 'claude-code' }; } });
    await store.ensure('custom-codex', binding);
    await store.ensure('custom-codex', binding);
    expect(calls).toBe(1);
    expect(store.catalogs.get('custom-codex')).toMatchObject({ status: 'unavailable', models: [] });
    const failed = createModelCatalogStore({ load: async () => { throw new Error('Runtime sign-in required'); } });
    await failed.ensure('custom-codex', binding);
    expect(failed.catalogs.get('custom-codex').diagnostics).toEqual(['Runtime sign-in required']);
  });
});
