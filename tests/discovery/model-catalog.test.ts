import { describe, expect, it, vi } from 'vitest';
import { AdapterError, validateSettingsAgainst, type RuntimeSettingsSupport } from '../../src/adapters/types.js';
import { discoverRuntimeModels } from '../../src/discovery/model-catalog.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';

const runtime = { adapter: 'codex' as const, executable: '/selected/codex' };
const report = {
  runtimeId: 'selected', adapter: 'codex', configuredExecutable: '/selected/codex',
  executable: '/selected/codex', realPath: '/versions/codex-1', version: '0.147.0',
  installed: true, adapterSupported: true, controllable: true,
} as RuntimeReadinessReport;
const settings: RuntimeSettingsSupport = {
  model: { offered: [{ value: 'fast', provenance: 'reported' }, { value: 'deep', provenance: 'reported' }], exhaustive: true },
  effort: { offered: [{ value: 'high', provenance: 'reported' }, { value: 'low', provenance: 'reported' }], exhaustive: true },
  defaultModel: 'deep',
  models: [
    { value: 'fast', provenance: 'reported', displayName: 'Fast', effortStatus: 'reported', effort: { offered: [{ value: 'low', provenance: 'reported' }], exhaustive: true } },
    { value: 'deep', provenance: 'reported', displayName: 'Deep', description: 'Reported description', isDefault: true, defaultEffort: 'high', effortStatus: 'reported', inputModalities: ['text', 'image'], effort: { offered: [{ value: 'high', provenance: 'reported' }], exhaustive: true } },
  ],
};

describe('runtime model catalog', () => {
  it('uses the saved executable binding and retains only normalized model metadata', async () => {
    const discover = vi.fn(async () => ({ ...settings, raw: { account: { email: 'private@example.test', secret: 'never-return' } } }));
    const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime, reports: [report] }, { discover, now: 'fixed-time' });
    expect(discover).toHaveBeenCalledExactlyOnceWith('codex', '/selected/codex');
    expect(catalog).toMatchObject({ status: 'available', runtimeId: 'selected', configuredExecutable: '/selected/codex', resolvedExecutable: '/versions/codex-1', version: '0.147.0', checkedAt: 'fixed-time', defaultModel: 'deep' });
    expect(catalog.models).toEqual([
      { id: 'fast', label: 'Fast', runtimeLabel: 'Fast', provenance: 'runtime-reported', efforts: ['low'], effortStatus: 'reported' },
      { id: 'deep', label: 'Deep', runtimeLabel: 'Deep', provenance: 'runtime-reported', description: 'Reported description', efforts: ['high'], defaultEffort: 'high', isDefault: true, effortStatus: 'reported', inputModalities: ['text', 'image'] },
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/private@example|never-return|account/);
  });

  it('refuses stale or missing binding evidence before starting a metadata process', async () => {
    const discover = vi.fn(async () => settings);
    const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime: { ...runtime, executable: '/changed/codex' }, reports: [report] }, { discover });
    expect(catalog.status).toBe('unavailable');
    expect(catalog.models).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it('does not fabricate lists for unsupported or missing runtimes', async () => {
    const discover = vi.fn(async () => settings);
    for (const invalid of [{ ...report, installed: false }, { ...report, adapterSupported: false }, { ...report, controllable: false }]) {
      expect((await discoverRuntimeModels({ runtimeId: 'selected', runtime, reports: [invalid] }, { discover })).status).toBe('unavailable');
    }
    expect((await discoverRuntimeModels({ runtimeId: 'fake', runtime: { adapter: 'fake', executable: 'fake' }, reports: [] }, { discover })).status).toBe('unavailable');
    expect(discover).not.toHaveBeenCalled();
  });

  it('preserves unavailable per-model efforts and an unknown runtime default', async () => {
    const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime, reports: [report] }, { discover: async () => ({
      ...settings, defaultModel: undefined,
      models: [{ value: 'future', displayName: 'Future', provenance: 'reported', effortStatus: 'unavailable', effort: { offered: [{ value: 'configured-only', provenance: 'configured' }], exhaustive: false } }],
    } as unknown as RuntimeSettingsSupport) });
    expect(catalog.models).toEqual([{ id: 'future', label: 'Future', runtimeLabel: 'Future', provenance: 'runtime-reported', efforts: [], effortStatus: 'unavailable' }]);
    expect(catalog.defaultModel).toBeUndefined();
    expect(catalog.diagnostics.join(' ')).toContain('did not report');
  });

  it('keeps timeout and uncertain cleanup unavailable without returning raw protocol errors', async () => {
    for (const error of [new Error('private@example.test secret'), new AdapterError('codex', 'settings_stop_unconfirmed', 'private@example.test secret')]) {
      const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime, reports: [report] }, { discover: async () => { throw error; } });
      expect(catalog.status).toBe('unavailable');
      expect(catalog.models).toEqual([]);
      expect(JSON.stringify(catalog)).not.toMatch(/private@example|secret/);
    }
  });

  it('retains exact Claude alias resolutions and versioned runtime names without changing accepted IDs', async () => {
    const metadata = [
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
      { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-1', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
      { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', description: 'Sonnet 5 · Efficient for routine tasks' },
      { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', description: 'Haiku 4.5 · Fastest for quick answers' },
    ];
    const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime: { ...runtime, adapter: 'claude-code' }, reports: [{ ...report, adapter: 'claude-code' }] }, { discover: async () => ({
      ...settings, models: metadata.map(model => ({ ...model, provenance: 'reported', effortStatus: 'unavailable', effort: { offered: [], exhaustive: false } })),
    }) });
    expect(catalog.source).toBe('claude-code:initialize');
    expect(catalog.models.map(model => model.id)).toEqual(metadata.map(model => model.value));
    expect(catalog.models.map(model => model.resolvedModel)).toEqual(metadata.map(model => model.resolvedModel));
    expect(catalog.models.map(model => model.runtimeLabel)).toEqual(metadata.map(model => model.displayName));
    expect(catalog.models.map(model => model.label)).toEqual(['Default (recommended) · Opus 5 with 1M context', 'Opus 5 with 1M context', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5']);
    expect(catalog.models.at(-1)?.efforts).toEqual([]);
    expect(catalog.defaultModel).toBeUndefined();
  });

  it('does not invent a version when an alias has no reported resolution', async () => {
    const catalog = await discoverRuntimeModels({ runtimeId: 'selected', runtime: { ...runtime, adapter: 'claude-code' }, reports: [{ ...report, adapter: 'claude-code' }] }, { discover: async () => ({
      ...settings, models: [{ ...settings.models![0]!, displayName: 'Future alias', description: 'A model for 2027 tasks' }],
    }) });
    expect(catalog.models[0]).toMatchObject({ label: 'Future alias', runtimeLabel: 'Future alias' });
    expect(catalog.models[0]?.resolvedModel).toBeUndefined();
  });

  it('keeps catalogs tied to their own installation when a newer desktop CLI reports additional models', async () => {
    const installations = [
      { path: '/selected/codex', realPath: '/versions/codex-1', source: 'path' as const, origins: ['PATH'], selected: true },
      { path: '/desktop/codex', realPath: '/desktop/codex', source: 'known_location' as const, origins: ['desktop bundle'], selected: false },
    ];
    const reports = [{ ...report, installations }, { ...report, runtimeId: 'desktop', configuredExecutable: '/desktop/codex', executable: '/desktop/codex', realPath: '/desktop/codex', version: '0.154.0-alpha.6.2', installations }];
    const discover = vi.fn(async (_adapter: unknown, executable: string) => executable === '/desktop/codex' ? {
      ...settings, defaultModel: 'gpt-6-astra', models: [{ ...settings.models![1]!, value: 'gpt-6-astra', catalogId: 'astra-catalog', resolvedModel: 'gpt-6-astra', displayName: 'GPT-6 Astra' }],
    } : settings);
    const old = await discoverRuntimeModels({ runtimeId: 'selected', runtime, reports }, { discover });
    const desktop = await discoverRuntimeModels({ runtimeId: 'desktop', runtime: { ...runtime, executable: '/desktop/codex' }, reports }, { discover });
    expect(old.models.some(model => model.id === 'gpt-6-astra')).toBe(false);
    expect(desktop.models[0]).toMatchObject({ id: 'gpt-6-astra', catalogId: 'astra-catalog', resolvedModel: 'gpt-6-astra', provenance: 'runtime-reported' });
    expect(desktop.source).toBe('codex:model/list');
    expect(desktop.version).toBe('0.154.0-alpha.6.2');
    expect(old.installations?.filter(installation => installation.selected).map(installation => installation.path)).toEqual(['/selected/codex']);
    expect(desktop.installations?.filter(installation => installation.selected).map(installation => installation.path)).toEqual(['/desktop/codex']);
    expect(desktop.diagnostics.join(' ')).toContain('Other installed executables');
    expect(discover.mock.calls.map(call => call[1])).toEqual(['/selected/codex', '/desktop/codex']);
  });
});

describe('per-model reasoning validation', () => {
  it('rejects an effort listed only for another model', () => {
    expect(validateSettingsAgainst('codex', settings, { model: 'fast', effort: 'low' }).ok).toBe(true);
    const crossed = validateSettingsAgainst('codex', settings, { model: 'fast', effort: 'high' });
    expect(crossed.ok).toBe(false);
    expect(crossed.effort.offered).toEqual(['low']);
  });
  it('does not substitute the catalog default for an unknown effective runtime model', () => {
    expect(validateSettingsAgainst('codex', settings, { effort: 'high' }).effort.status).toBe('supported_unverified');
    expect(validateSettingsAgainst('codex', settings, { effort: 'high' }).effort.offered).toEqual([]);
  });
  it('keeps legacy static callers working when no per-model catalog exists', () => {
    expect(validateSettingsAgainst('codex', { model: settings.model, effort: settings.effort }, { effort: 'high' }).effort.status).toBe('supported');
  });
});
