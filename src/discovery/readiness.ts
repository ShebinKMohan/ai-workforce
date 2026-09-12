/**
 * Readiness report (FR002).
 *
 * Installation, adapter support, controllability and authentication visibility
 * are separate facts and stay separate in the report. Passive discovery can
 * reach `controllable` at best; `verified_ready` exists only after an explicit
 * live check, which WP03/WP05 supply once a real session has run.
 */
import { nowIso } from '../core/ids.js';
import type { RuntimeConfig } from '../core/contracts.js';
import { toolFactForRuntime } from '../core/workspace-config.js';
import {
  capabilitiesFor,
  isControllable,
  loadVerifiedCapabilityOverrides,
  missingControlCapabilities,
  missingWriteBoundaryCapabilities,
  type CapabilityTable,
  type DiscoveryCapabilityName,
  type LoadedOverrides,
} from './capabilities.js';
import { probeRuntime, type AuthStatus, type ProbeRecord } from './probe.js';
import { resolveExecutable, type ExecutableInstallation, type ResolveOptions } from './resolve.js';
import { DISCOVERABLE_ADAPTERS, isAtLeast, runtimeDescriptor, type DiscoverableAdapter } from './runtimes.js';
import type { ProbeSpawner } from './spawn.js';

/**
 * Ordered from least to most ready, except that `auth_unknown` sits beside
 * `controllable`: the controls are there but the login state could not be read.
 */
export const READINESS_LEVELS = ['missing', 'installed', 'adapter_supported', 'controllable', 'auth_unknown', 'verified_ready'] as const;
export type Readiness = (typeof READINESS_LEVELS)[number];

export interface RuntimeReadinessReport {
  readonly adapter: DiscoverableAdapter;
  /** Present only for a saved runtime binding; adapter-wide discovery leaves these absent. */
  readonly runtimeId?: string;
  readonly configuredExecutable?: string;
  /** Selected executable path, or null when nothing was found. */
  readonly executable: string | null;
  /** The selected executable with symlinks resolved. */
  readonly realPath: string | null;
  readonly version: string | null;
  readonly installed: boolean;
  readonly adapterSupported: boolean;
  readonly controllable: boolean;
  readonly auth: AuthStatus;
  readonly readiness: Readiness;
  readonly capabilities: CapabilityTable;
  readonly checkedAt: string;

  // Supporting evidence — everything above is derived from these.
  readonly displayName: string;
  readonly minimumSupportedVersion: string;
  /** Every installation found, in search order; exactly one may be `selected`. */
  readonly installations: ReadonlyArray<ExecutableInstallation>;
  readonly searchedLocations: ReadonlyArray<string>;
  /** What each probe actually ran. Never contains login output. */
  readonly probes: ReadonlyArray<ProbeRecord>;
  /** `passive` never reaches `verified_ready`. */
  readonly probeKind: 'passive' | 'live';
  readonly authDetail: string;
  readonly missingControls: ReadonlyArray<DiscoveryCapabilityName>;
  /**
   * Boundaries a writing profile needs that this runtime does not offer. Empty
   * for a runtime with a tested write boundary. Non-empty means read-only work
   * is fine and `local-development` is blocked unless a human explicitly
   * accepts an unconfined run (plan sections 6, 8 and 9).
   */
  readonly missingWriteBoundary: ReadonlyArray<DiscoveryCapabilityName>;
  /** True when a writing profile can be dispatched to this runtime without an explicit acknowledgement. */
  readonly writingModeAvailable: boolean;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface DiscoveryOptions extends ResolveOptions {
  readonly spawner?: ProbeSpawner;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** Preloaded capability overrides; loaded from `docs/verified-capabilities.json` when omitted. */
  readonly overrides?: LoadedOverrides;
  readonly now?: string;
}

/** The readiness level implied by the four separate facts. Exported so a live check can recompute it after the runtime answers. */
export function readinessFrom(installed: boolean, adapterSupported: boolean, controllable: boolean, auth: AuthStatus): Readiness {
  if (!installed) return 'missing';
  if (!adapterSupported) return 'installed';
  if (!controllable) return 'adapter_supported';
  return auth === 'unknown' ? 'auth_unknown' : 'controllable';
}

/** Discover one runtime without starting a model turn. */
export async function discoverRuntime(adapter: DiscoverableAdapter, options: DiscoveryOptions = {}): Promise<RuntimeReadinessReport> {
  const descriptor = runtimeDescriptor(adapter);
  const overrides = options.overrides ?? loadVerifiedCapabilityOverrides();
  const checkedAt = options.now ?? nowIso();

  const resolution = resolveExecutable(adapter, {
    ...(options.executableName !== undefined ? { executableName: options.executableName } : {}),
    ...(options.override !== undefined ? { override: options.override } : {}),
    ...(options.pathValue !== undefined ? { pathValue: options.pathValue } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.knownLocations !== undefined ? { knownLocations: options.knownLocations } : {}),
  });
  const diagnostics: string[] = [...resolution.diagnostics, ...overrides.diagnostics];

  if (resolution.selected === null) {
    const capabilities = capabilitiesFor(adapter, null, { overrides });
    return {
      adapter,
      executable: null,
      realPath: null,
      version: null,
      installed: false,
      adapterSupported: false,
      controllable: false,
      auth: 'unknown',
      readiness: 'missing',
      capabilities,
      checkedAt,
      displayName: descriptor.displayName,
      minimumSupportedVersion: descriptor.minimumSupportedVersion,
      installations: resolution.installations,
      searchedLocations: resolution.searchedLocations,
      probes: [],
      probeKind: 'passive',
      authDetail: 'no executable was found, so login status was not probed',
      missingControls: missingControlCapabilities(capabilities),
      missingWriteBoundary: missingWriteBoundaryCapabilities(capabilities),
      writingModeAvailable: false,
      diagnostics,
    };
  }

  const probe = await probeRuntime(adapter, resolution.selected.path, {
    ...(options.spawner !== undefined ? { spawner: options.spawner } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  diagnostics.push(...probe.diagnostics);

  const capabilities = capabilitiesFor(adapter, probe.version, { overrides });
  const adapterSupported = probe.version !== null && isAtLeast(probe.version, descriptor.minimumSupportedVersion);
  const controllable = adapterSupported && isControllable(capabilities);
  const missingControls = missingControlCapabilities(capabilities);
  const missingWriteBoundary = missingWriteBoundaryCapabilities(capabilities);
  if (adapterSupported && !controllable) {
    diagnostics.push(`${descriptor.displayName} ${probe.version} does not offer ${missingControls.join(', ')}; execution modes needing those controls are blocked`);
  }
  if (adapterSupported && missingWriteBoundary.length > 0) {
    // The one thing a readiness report must not leave unsaid about a runtime
    // that will be handed a candidate workspace: nothing bounds where the
    // processes it starts may write.
    diagnostics.push(
      `${descriptor.displayName} ${probe.version} offers no tested write boundary (${missingWriteBoundary.join(', ')}: ${capabilities[missingWriteBoundary[0]!].note}); ` +
        'writing profiles such as "local-development" are refused for this runtime unless a run explicitly accepts an unconfined run with --allow-unconfined-writes. Read-only profiles are unaffected',
    );
  }
  if (probe.version !== null && !adapterSupported) {
    diagnostics.push(`${descriptor.displayName} ${probe.version} is below the supported minimum ${descriptor.minimumSupportedVersion}`);
  }

  return {
    adapter,
    executable: resolution.selected.path,
    realPath: resolution.selected.realPath,
    version: probe.version,
    installed: true,
    adapterSupported,
    controllable,
    auth: probe.auth,
    readiness: readinessFrom(true, adapterSupported, controllable, probe.auth),
    capabilities,
    checkedAt,
    displayName: descriptor.displayName,
    minimumSupportedVersion: descriptor.minimumSupportedVersion,
    installations: resolution.installations,
    searchedLocations: resolution.searchedLocations,
    probes: probe.probes,
    probeKind: 'passive',
    authDetail: probe.authDetail,
    missingControls,
    missingWriteBoundary,
    writingModeAvailable: controllable && missingWriteBoundary.length === 0,
    diagnostics,
  };
}

export interface DiscoverRuntimesOptions extends Omit<DiscoveryOptions, 'override'> {
  /** Explicit executable paths per adapter (`--codex-path`, `--claude-path`). */
  readonly overridePaths?: Partial<Record<DiscoverableAdapter, string | null>>;
  readonly adapters?: ReadonlyArray<DiscoverableAdapter>;
}

/** Discover every supported runtime. Passive: no model turn, no repository hooks. */
export async function discoverRuntimes(options: DiscoverRuntimesOptions = {}): Promise<ReadonlyArray<RuntimeReadinessReport>> {
  const { overridePaths, adapters = DISCOVERABLE_ADAPTERS, overrides = loadVerifiedCapabilityOverrides(), ...shared } = options;
  const reports: RuntimeReadinessReport[] = [];
  for (const adapter of adapters) {
    const override = overridePaths?.[adapter];
    reports.push(await discoverRuntime(adapter, { ...shared, overrides, ...(override !== undefined ? { override } : {}) }));
  }
  return reports;
}

/**
 * Keep installation discovery for setup, then observe every saved binding using
 * the executable that will actually be spawned. A broken override must never
 * inherit a healthy installation's status merely because its adapter matches.
 */
export async function discoverWorkspaceRuntimes(
  runtimes: Readonly<Record<string, RuntimeConfig>>,
  options: DiscoverRuntimesOptions = {},
): Promise<ReadonlyArray<RuntimeReadinessReport>> {
  const { overridePaths: _overridePaths, adapters: _adapters, ...shared } = options;
  const reports = [...await discoverRuntimes(options)];
  const boundReports = new Map<string, RuntimeReadinessReport>();
  for (const [runtimeId, runtime] of Object.entries(runtimes)) {
    if (runtime.adapter === 'fake') continue;
    const key = JSON.stringify([runtime.adapter, runtime.executable]);
    let report = boundReports.get(key);
    if (report === undefined) {
      const namesPath = runtime.executable.includes('/') || runtime.executable.includes('\\') || runtime.executable.startsWith('~') || runtime.executable.startsWith('.');
      const bindingOptions: DiscoveryOptions = namesPath
        ? { ...shared, override: runtime.executable }
        // spawn resolves a bare command on PATH. Known-location discovery is
        // useful for setup, but cannot prove that this binding will launch.
        : { ...shared, executableName: runtime.executable, knownLocations: [] };
      const selected = resolveExecutable(runtime.adapter, bindingOptions).selected;
      report = selected === null ? undefined : reports.find((entry) => entry.runtimeId === undefined && entry.adapter === runtime.adapter && entry.executable === selected.path);
      report ??= await discoverRuntime(runtime.adapter, bindingOptions);
      boundReports.set(key, report);
    }
    reports.push({ ...report, runtimeId, configuredExecutable: runtime.executable });
  }
  return reports;
}

/** Select evidence for the saved binding, with conservative support for old adapter-only callers. */
export function readinessReportForRuntime(
  reports: ReadonlyArray<RuntimeReadinessReport>,
  runtimeId: string,
  runtime: RuntimeConfig,
): RuntimeReadinessReport | undefined {
  return toolFactForRuntime(reports, runtimeId, runtime);
}

// ---------------------------------------------------------------------------
// Live check (the only way to reach `verified_ready`)
// ---------------------------------------------------------------------------

export interface LiveCheckEvidence {
  /** True only when a real session was opened, produced structured output and was stopped. */
  readonly ok: boolean;
  /** What established the result — an adapter conformance test, a real session id, a check id. */
  readonly evidence: string;
  readonly at?: string;
}

/**
 * Upgrade a passive report with the result of an explicit live check.
 *
 * A live check can only confirm what passive discovery already established: a
 * runtime that is not controllable, or whose login state is unknown, never
 * becomes `verified_ready` — the reason is recorded instead.
 */
export function applyLiveCheck(report: RuntimeReadinessReport, evidence: LiveCheckEvidence): RuntimeReadinessReport {
  const checkedAt = evidence.at ?? nowIso();
  if (!evidence.ok) {
    return { ...report, probeKind: 'live', checkedAt, diagnostics: [...report.diagnostics, `live check failed: ${evidence.evidence}`] };
  }
  if (!report.controllable) {
    return {
      ...report,
      probeKind: 'live',
      checkedAt,
      diagnostics: [...report.diagnostics, `live check reported success but the runtime is only "${report.readiness}"; verified_ready needs a controllable runtime (${evidence.evidence})`],
    };
  }
  if (report.auth !== 'logged_in') {
    return {
      ...report,
      probeKind: 'live',
      checkedAt,
      diagnostics: [...report.diagnostics, `live check reported success but authentication is "${report.auth}"; verified_ready needs an observed login (${evidence.evidence})`],
    };
  }
  return { ...report, probeKind: 'live', readiness: 'verified_ready', checkedAt, diagnostics: [...report.diagnostics, `verified ready by live check: ${evidence.evidence}`] };
}
