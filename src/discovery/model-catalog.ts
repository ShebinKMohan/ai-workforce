/** Model metadata from the selected installed CLI. No conversation or model turn is started. */
import { CodexAdapter } from '../adapters/codex/adapter.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { AdapterError, type RuntimeSettingsSupport } from '../adapters/types.js';
import type { AdapterId, RuntimeConfig } from '../core/contracts.js';
import { nowIso } from '../core/ids.js';
import { readinessReportForRuntime, type RuntimeReadinessReport } from './readiness.js';
import type { DiscoverableAdapter } from './runtimes.js';

export interface RuntimeCatalogModel {
  /** Exact identifier accepted by the runtime's model setting. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly efforts: ReadonlyArray<string>;
  readonly defaultEffort?: string;
  readonly isDefault?: boolean;
  readonly effortStatus: 'reported' | 'unavailable';
  readonly inputModalities?: ReadonlyArray<string>;
}

export interface RuntimeModelCatalog {
  readonly runtimeId: string;
  readonly adapter: AdapterId;
  readonly configuredExecutable: string;
  readonly executable: string | null;
  readonly resolvedExecutable: string | null;
  readonly version: string | null;
  readonly checkedAt: string;
  /** Available means the CLI listed metadata, not that an inference turn succeeded. */
  readonly status: 'available' | 'unavailable';
  readonly models: ReadonlyArray<RuntimeCatalogModel>;
  /** Catalog default only; configured and effective session settings remain separate. */
  readonly defaultModel?: string;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface RuntimeModelCatalogInput {
  readonly runtimeId: string;
  readonly runtime: RuntimeConfig;
  readonly reports: ReadonlyArray<RuntimeReadinessReport>;
}

export interface RuntimeModelCatalogOptions {
  readonly now?: string;
  /** Per-handshake bound; stop is separately bounded and observed before returning. */
  readonly timeoutMs?: number;
  /** Deterministic tests may replace only the metadata handshake. */
  readonly discover?: (adapter: DiscoverableAdapter, executable: string) => Promise<RuntimeSettingsSupport>;
}

/** Returns only model metadata, never the raw handshake's account or credential fields. */
export async function discoverRuntimeModels(input: RuntimeModelCatalogInput, options: RuntimeModelCatalogOptions = {}): Promise<RuntimeModelCatalog> {
  const { runtimeId, runtime, reports } = input;
  const report = readinessReportForRuntime(reports, runtimeId, runtime);
  const base = {
    runtimeId,
    adapter: runtime.adapter,
    configuredExecutable: runtime.executable,
    executable: report?.executable ?? null,
    resolvedExecutable: report?.realPath ?? null,
    version: report?.version ?? null,
    checkedAt: options.now ?? nowIso(),
  };
  const unavailable = (diagnostic: string): RuntimeModelCatalog => ({ ...base, status: 'unavailable', models: [], diagnostics: [diagnostic] });
  if (runtime.adapter !== 'codex' && runtime.adapter !== 'claude-code') {
    return unavailable('This runtime does not have a supported model discovery protocol.');
  }
  if (report === undefined) return unavailable('Refresh runtime checks before loading models for this executable binding.');
  if (!report.installed || report.executable === null) return unavailable('The configured runtime executable is not installed or could not be resolved.');
  if (!report.adapterSupported || !report.controllable) return unavailable('This installed runtime version does not support the required discovery controls.');

  const timeoutMs = options.timeoutMs ?? 8_000;
  try {
    const discover = options.discover ?? (async (adapter: DiscoverableAdapter, executable: string): Promise<RuntimeSettingsSupport> => {
      if (adapter === 'codex') {
        return new CodexAdapter({ executablePath: executable, startupTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs, stopTimeoutMs: 750 }).discoverSettings();
      }
      const result = await new ClaudeCodeAdapter({ executablePath: executable, startupTimeoutMs: timeoutMs, controlTimeoutMs: timeoutMs, stopTimeoutMs: 750 }).discoverSettings();
      return result.settings;
    });
    // Invoke the selected path from the matching report, never an adapter-wide
    // PATH lookup that might pick a different installation.
    const settings = await discover(runtime.adapter, report.executable);
    const models = (settings.models ?? []).filter((model) => model.provenance === 'reported').map((model): RuntimeCatalogModel => ({
      id: model.value,
      label: model.displayName,
      ...(model.description !== undefined ? { description: model.description } : {}),
      efforts: model.effortStatus === 'reported' ? model.effort.offered.filter((effort) => effort.provenance === 'reported').map((effort) => effort.value) : [],
      ...(model.defaultEffort !== undefined && model.effort.offered.some((effort) => effort.value === model.defaultEffort && effort.provenance === 'reported') ? { defaultEffort: model.defaultEffort } : {}),
      ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
      effortStatus: model.effortStatus,
      ...(model.inputModalities !== undefined ? { inputModalities: [...model.inputModalities] } : {}),
    }));
    if (models.length === 0) return unavailable('The CLI did not report any selectable models. No model names were inferred.');
    return {
      ...base,
      status: 'available',
      models,
      ...(settings.defaultModel !== undefined && models.some((model) => model.id === settings.defaultModel) ? { defaultModel: settings.defaultModel } : {}),
      diagnostics: models.some((model) => model.effortStatus === 'unavailable') ? ['The CLI did not report reasoning choices for every model. Unavailable choices are left empty.'] : [],
    };
  } catch (error) {
    // Provider/control errors can embed raw response data. Publish a bounded
    // classification rather than exposing an initialize account block.
    if (error instanceof AdapterError && (error.code === 'discovery_stop_unconfirmed' || error.code === 'settings_stop_unconfirmed')) {
      return unavailable('Model discovery could not confirm that its CLI process stopped. No model choices were accepted.');
    }
    return unavailable('The CLI model discovery handshake failed or timed out. Refresh runtime checks and try loading models again.');
  }
}
