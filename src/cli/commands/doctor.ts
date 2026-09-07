/**
 * `workforce doctor` — read-only runtime discovery and readiness (FR001, FR002,
 * FR005, FR006, FR013).
 *
 * Doctor is informational: it exits 0 even when no runtime is installed, so a
 * script can read the report and decide. Only invalid arguments exit 2. It runs
 * `--version` and the documented login-status command and nothing else, so it
 * can never start a paid model turn.
 */
import { computeAgentSnapshot } from '../../core/snapshot.js';
import type { LoadedAgentConfig } from '../../core/config.js';
import { loadVerifiedCapabilityOverrides, DISCOVERY_CAPABILITY_NAMES } from '../../discovery/capabilities.js';
import { discoverRuntimes, type RuntimeReadinessReport } from '../../discovery/readiness.js';
import { DISCOVERABLE_ADAPTERS, type DiscoverableAdapter } from '../../discovery/runtimes.js';
import { validateRuntimeSettings } from '../../discovery/settings.js';
import type { ProbeSpawner } from '../../discovery/spawn.js';
import { resolveStateRoot } from '../../storage/paths.js';
import { CliError, EXIT_CODES, type CommandResult } from '../output.js';

export interface DoctorArgs {
  readonly stateDir?: string | undefined;
  readonly codexPath?: string | undefined;
  readonly claudePath?: string | undefined;
  /** Already-validated agent configuration, when `--agents` was passed. */
  readonly config?: LoadedAgentConfig | undefined;
}

/** Test seams: discovery is driven through these so a test can supply fake executables. */
export interface DoctorDeps {
  readonly spawner?: ProbeSpawner;
  readonly pathValue?: string;
  readonly homeDir?: string;
  readonly knownLocations?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly overridesFile?: string;
  readonly now?: string;
}

function requirePath(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new CliError(EXIT_CODES.invalidInput, 'invalid_runtime_path', `${flag} needs a path to the executable`);
  return value;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function table(rows: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, widths[index] ?? 0))).join('  ').trimEnd());
}

function reportJson(report: RuntimeReadinessReport): Record<string, unknown> {
  return {
    adapter: report.adapter,
    executable: report.executable,
    realPath: report.realPath,
    version: report.version,
    installed: report.installed,
    adapterSupported: report.adapterSupported,
    controllable: report.controllable,
    auth: report.auth,
    readiness: report.readiness,
    capabilities: Object.fromEntries(DISCOVERY_CAPABILITY_NAMES.map((name) => [name, { status: report.capabilities[name].status, source: report.capabilities[name].source, note: report.capabilities[name].note }])),
    checkedAt: report.checkedAt,
    minimumSupportedVersion: report.minimumSupportedVersion,
    probeKind: report.probeKind,
    authDetail: report.authDetail,
    missingControls: report.missingControls,
    installations: report.installations.map((i) => ({ path: i.path, realPath: i.realPath, source: i.source, origins: i.origins, selected: i.selected })),
    searchedLocations: report.searchedLocations,
    probes: report.probes.map((p) => ({ purpose: p.purpose, argv: [p.executable, ...p.argv], exitCode: p.exitCode, timedOut: p.timedOut, durationMs: p.durationMs, timeoutMs: p.timeoutMs, spawnError: p.spawnError })),
    diagnostics: report.diagnostics,
  };
}

function reportLines(report: RuntimeReadinessReport): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${report.adapter} — ${report.displayName}`);
  lines.push(`  readiness:     ${report.readiness}${report.readiness === 'verified_ready' ? '' : ' (passive discovery; verified_ready needs a live check)'}`);
  lines.push(`  executable:    ${report.executable ?? '(not found)'}`);
  if (report.realPath !== null && report.realPath !== report.executable) lines.push(`  real path:     ${report.realPath}`);
  lines.push(`  version:       ${report.version ?? '(unknown)'} (adapter minimum ${report.minimumSupportedVersion})`);
  lines.push(`  authentication:${report.auth === 'logged_in' ? ' logged_in' : ` ${report.auth}`} — ${report.authDetail}`);
  if (report.installations.length > 1) {
    lines.push(`  installations: ${report.installations.length} found`);
    for (const installation of report.installations) {
      lines.push(`    ${installation.selected ? '*' : ' '} ${installation.path}${installation.realPath === installation.path ? '' : ` -> ${installation.realPath}`} (${installation.source})`);
    }
  }
  lines.push(`  capabilities:`);
  for (const name of DISCOVERY_CAPABILITY_NAMES) {
    const entry = report.capabilities[name];
    lines.push(`    ${pad(name, 24)} ${entry.status}${entry.note.length > 0 ? ` — ${entry.note}` : ''}`);
  }
  if (report.probes.length > 0) {
    lines.push('  probes:');
    for (const probe of report.probes) {
      const outcome = probe.spawnError !== null ? `spawn error: ${probe.spawnError}` : probe.timedOut ? `timed out after ${probe.timeoutMs} ms (process group terminated)` : `exit ${probe.exitCode ?? 'signal'}`;
      lines.push(`    ${probe.executable} ${probe.argv.join(' ')} — ${outcome}, ${probe.durationMs} ms`);
    }
  }
  for (const diagnostic of report.diagnostics) lines.push(`  note: ${diagnostic}`);
  return lines;
}

function configLines(config: LoadedAgentConfig, byAdapter: Map<DiscoverableAdapter, RuntimeReadinessReport>): { lines: string[]; data: Record<string, unknown> } {
  const lines: string[] = ['', `agent configuration: ${config.path} (valid)`];
  const runtimes: Record<string, unknown>[] = [];

  for (const [id, runtime] of Object.entries(config.config.runtimes)) {
    if (runtime.adapter === 'fake') {
      lines.push(`  runtime ${id}: fake test adapter (not discovered on disk)`);
      runtimes.push({ id, adapter: runtime.adapter, discovered: false });
      continue;
    }
    const report = byAdapter.get(runtime.adapter);
    const validation = validateRuntimeSettings(runtime.adapter, report?.version ?? null, {
      ...(runtime.model !== undefined ? { model: runtime.model } : {}),
      ...(runtime.effort !== undefined ? { effort: runtime.effort } : {}),
    });
    lines.push(`  runtime ${id}: ${runtime.adapter} via ${runtime.executable} — ${report?.readiness ?? 'unknown'}`);
    for (const rejected of validation.rejected) lines.push(`    rejected ${rejected.setting}: ${rejected.reason}`);
    for (const unsupportedSetting of validation.unsupported) lines.push(`    unsupported ${unsupportedSetting.setting}: ${unsupportedSetting.reason}`);
    for (const accepted of validation.accepted) lines.push(`    ${accepted.setting} = ${accepted.value} (${accepted.status})`);
    runtimes.push({ id, adapter: runtime.adapter, executable: runtime.executable, readiness: report?.readiness ?? null, settings: validation });
  }

  const agents = config.config.agents.map((agent) => {
    const runtime = config.config.runtimes[agent.runtime]!;
    const report = runtime.adapter === 'fake' ? undefined : byAdapter.get(runtime.adapter);
    const model = agent.model ?? runtime.model;
    const effort = agent.effort ?? runtime.effort;
    const validation =
      runtime.adapter === 'fake'
        ? null
        : validateRuntimeSettings(runtime.adapter, report?.version ?? null, {
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            permissions: { profile: agent.policy },
          });
    lines.push(`  agent ${agent.id}: runtime ${agent.runtime} (${runtime.adapter} via ${runtime.executable}), policy ${agent.policy}`);
    if (validation !== null) {
      const profile = validation.accepted.find((a) => a.setting === 'permissions.profile');
      if (profile !== undefined) lines.push(`    policy controls: ${profile.controls.map((c) => c.argv.join(' ')).join(' ')}`);
      for (const rejected of validation.rejected) lines.push(`    rejected ${rejected.setting}: ${rejected.reason}`);
      for (const item of validation.unsupported) lines.push(`    unsupported ${item.setting}: ${item.reason}`);
    }
    return { id: agent.id, runtime: agent.runtime, adapter: runtime.adapter, policy: agent.policy, snapshotHash: computeAgentSnapshot(config.config, agent.id).hash, settings: validation };
  });

  return { lines, data: { path: config.path, schemaVersion: config.config.schemaVersion, runtimes, agents, defaults: config.config.defaults } };
}

export async function commandDoctor(args: DoctorArgs, deps: DoctorDeps = {}): Promise<CommandResult> {
  const codexPath = requirePath(args.codexPath, '--codex-path');
  const claudePath = requirePath(args.claudePath, '--claude-path');
  const stateRoot = resolveStateRoot(args.stateDir);
  const overrides = loadVerifiedCapabilityOverrides(deps.overridesFile);

  const overridePaths: Partial<Record<DiscoverableAdapter, string>> = {};
  if (codexPath !== undefined) overridePaths.codex = codexPath;
  if (claudePath !== undefined) overridePaths['claude-code'] = claudePath;

  const reports = await discoverRuntimes({
    overridePaths,
    overrides,
    ...(deps.spawner !== undefined ? { spawner: deps.spawner } : {}),
    ...(deps.pathValue !== undefined ? { pathValue: deps.pathValue } : {}),
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.knownLocations !== undefined ? { knownLocations: deps.knownLocations } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const byAdapter = new Map<DiscoverableAdapter, RuntimeReadinessReport>();
  for (const report of reports) byAdapter.set(report.adapter, report);

  const lines: string[] = [
    'workforce doctor — passive runtime discovery (no model turn is started)',
    `state root: ${stateRoot}`,
    '',
    ...table([
      ['RUNTIME', 'VERSION', 'READINESS', 'AUTH', 'EXECUTABLE'],
      ...DISCOVERABLE_ADAPTERS.map((adapter) => {
        const report = byAdapter.get(adapter)!;
        return [adapter, report.version ?? '-', report.readiness, report.auth, report.executable ?? '(not found)'];
      }),
    ]),
  ];
  for (const report of reports) lines.push(...reportLines(report));

  const data: Record<string, unknown> = {
    stateRoot,
    passive: true,
    verifiedCapabilitiesFile: { path: overrides.file, present: overrides.present },
    runtimes: reports.map(reportJson),
  };

  if (args.config !== undefined) {
    const rendered = configLines(args.config, byAdapter);
    lines.push(...rendered.lines);
    data['config'] = rendered.data;
  }

  // Doctor is informational: a missing runtime is a reported fact, not a failure.
  return { command: 'doctor', exitCode: EXIT_CODES.verifiedCandidate, data, lines };
}
