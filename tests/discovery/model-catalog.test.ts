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
      { id: 'fast', label: 'Fast', efforts: ['low'], effortStatus: 'reported' },
      { id: 'deep', label: 'Deep', description: 'Reported description', efforts: ['high'], defaultEffort: 'high', isDefault: true, effortStatus: 'reported', inputModalities: ['text', 'image'] },
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
    expect(catalog.models).toEqual([{ id: 'future', label: 'Future', efforts: [], effortStatus: 'unavailable' }]);
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
