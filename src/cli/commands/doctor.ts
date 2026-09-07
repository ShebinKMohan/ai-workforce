/**
 * `workforce doctor` — read-only runtime discovery and readiness (FR001, FR002,
 * FR005, FR006, FR013).
 *
 * Doctor is informational: it exits 0 even when no runtime is installed, so a
 * script can read the report and decide. Only invalid arguments exit 2. By
 * default it runs `--version` and the documented login-status command and
 * nothing else, so it can never start a paid model turn.
 *
 * `--connect` adds the explicit connection check plan section 6 rule 6 allows:
 * the adapter opens the runtime's own control channel and asks it what it is
 * (Codex's `model/list` handshake, Claude Code's `initialize` control request).
 * Both start a process and neither starts a model turn, so the check is free —
 * and it is the only way to reach `verified_ready`. It matters most for
 * authentication: on the recording machine `claude auth status` reported
 * `loggedIn: true` while the runtime itself reported `account.tokenSource:
 * "none"` and every turn failed. The status command describes a stored profile;
 * only the runtime can say whether it holds a usable credential.
 */
import path from 'node:path';
import { computeAgentSnapshot } from '../../core/snapshot.js';
import type { LoadedAgentConfig } from '../../core/config.js';
import { ClaudeCodeAdapter, CodexAdapter, type RuntimeReadiness } from '../../adapters/index.js';
import { applyLiveCheck, readinessFrom } from '../../discovery/readiness.js';
import { loadVerifiedCapabilityOverrides, DISCOVERY_CAPABILITY_NAMES, type LoadedOverrides } from '../../discovery/capabilities.js';
import { discoverRuntime, discoverRuntimes, type RuntimeReadinessReport } from '../../discovery/readiness.js';
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
  /**
   * `--connect`: run each installed runtime's own control handshake. Starts a
   * process, starts no model turn, and is the only path to `verified_ready`.
   */
  readonly connect?: boolean | undefined;
}

/** Test seams: discovery is driven through these so a test can supply fake executables. */
export interface DoctorDeps {
  readonly spawner?: ProbeSpawner;
  /** Test seam for `--connect`; production builds the real adapter and asks the runtime itself. */
  readonly liveProbe?: (adapter: DiscoverableAdapter, executable: string) => Promise<RuntimeReadiness>;
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
    missingWriteBoundary: report.missingWriteBoundary,
    writingModeAvailable: report.writingModeAvailable,
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
  lines.push(
    `  readiness:     ${report.readiness}${
      report.readiness === 'verified_ready' ? '' : report.probeKind === 'live' ? ' (after an explicit connection check)' : ' (passive discovery; verified_ready needs a live check)'
    }`,
  );
  lines.push(`  executable:    ${report.executable ?? '(not found)'}`);
  if (report.realPath !== null && report.realPath !== report.executable) lines.push(`  real path:     ${report.realPath}`);
  lines.push(`  version:       ${report.version ?? '(unknown)'} (adapter minimum ${report.minimumSupportedVersion})`);
  lines.push(`  authentication:${report.auth === 'logged_in' ? ' logged_in' : ` ${report.auth}`} — ${report.authDetail}`);
  lines.push(
    `  write boundary: ${
      report.missingWriteBoundary.length === 0
        ? 'a tested containment boundary is reported for writing profiles'
        : `NONE — ${report.missingWriteBoundary.join(', ')} is unsupported, so writing profiles (local-development) are refused for this runtime unless a run passes --allow-unconfined-writes`
    }`,
  );
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

/**
 * A configuration that pins `executable` to a path names the binary `run`
 * will spawn. That is not necessarily the one PATH discovery selected, so it
 * is probed on its own rather than inheriting the discovered runtime's
 * version, capabilities and readiness (plan section 6 rule 4: an unknown
 * status must not become ready by assumption).
 *
 * A bare command name is left to the discovered report, because that is the
 * same PATH lookup `spawn` performs.
 */
function namesAPath(executable: string): boolean {
  return executable.includes(path.sep) || executable.startsWith('~') || executable.startsWith('.');
}

interface ConfiguredRuntimeProbe {
  readonly report: RuntimeReadinessReport | undefined;
  /** Set when this report came from probing the configured path rather than from PATH discovery. */
  readonly probedPath: string | null;
}

async function probeConfiguredRuntimes(
  config: LoadedAgentConfig,
  byAdapter: Map<DiscoverableAdapter, RuntimeReadinessReport>,
  deps: DoctorDeps,
  overrides: LoadedOverrides,
): Promise<Map<string, ConfiguredRuntimeProbe>> {
  const probes = new Map<string, ConfiguredRuntimeProbe>();
  const byPath = new Map<string, RuntimeReadinessReport>();

  for (const [id, runtime] of Object.entries(config.config.runtimes)) {
    if (runtime.adapter === 'fake') continue;
    const discovered = byAdapter.get(runtime.adapter);
    if (!namesAPath(runtime.executable)) {
      probes.set(id, { report: discovered, probedPath: null });
      continue;
    }
    const resolved = path.resolve(runtime.executable.startsWith('~') ? runtime.executable.replace(/^~/, deps.homeDir ?? process.env['HOME'] ?? '~') : runtime.executable);
    if (discovered?.executable === resolved || discovered?.realPath === resolved) {
      probes.set(id, { report: discovered, probedPath: null });
      continue;
    }
    const cacheKey = `${runtime.adapter}\0${resolved}`;
    const cached = byPath.get(cacheKey);
    if (cached !== undefined) {
      probes.set(id, { report: cached, probedPath: resolved });
      continue;
    }
    // Passive: `--version` and the documented login-status command only.
    const report = await discoverRuntime(runtime.adapter, {
      override: runtime.executable,
      overrides,
      ...(deps.spawner !== undefined ? { spawner: deps.spawner } : {}),
      ...(deps.pathValue !== undefined ? { pathValue: deps.pathValue } : {}),
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.knownLocations !== undefined ? { knownLocations: deps.knownLocations } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    byPath.set(cacheKey, report);
    probes.set(id, { report, probedPath: resolved });
  }
  return probes;
}

function configLines(
  config: LoadedAgentConfig,
  byAdapter: Map<DiscoverableAdapter, RuntimeReadinessReport>,
  configured: Map<string, ConfiguredRuntimeProbe>,
): { lines: string[]; data: Record<string, unknown> } {
  const lines: string[] = ['', `agent configuration: ${config.path} (valid)`];
  const runtimes: Record<string, unknown>[] = [];
  const reportFor = (runtimeId: string, adapter: DiscoverableAdapter): RuntimeReadinessReport | undefined =>
    configured.get(runtimeId)?.report ?? byAdapter.get(adapter);

  for (const [id, runtime] of Object.entries(config.config.runtimes)) {
    if (runtime.adapter === 'fake') {
      lines.push(`  runtime ${id}: fake test adapter (not discovered on disk)`);
      runtimes.push({ id, adapter: runtime.adapter, discovered: false });
      continue;
    }
    const probe = configured.get(id);
    const report = probe?.report;
    const validation = validateRuntimeSettings(runtime.adapter, report?.version ?? null, {
      ...(runtime.model !== undefined ? { model: runtime.model } : {}),
      ...(runtime.effort !== undefined ? { effort: runtime.effort } : {}),
    });
    lines.push(`  runtime ${id}: ${runtime.adapter} via ${runtime.executable} — ${report?.readiness ?? 'unknown'}`);
    if (probe?.probedPath != null) {
      lines.push(`    probed the configured executable ${probe.probedPath} directly: version ${report?.version ?? '(unknown)'}, auth ${report?.auth ?? 'unknown'}`);
      for (const diagnostic of report?.diagnostics ?? []) lines.push(`    note: ${diagnostic}`);
    } else if (report !== undefined) {
      lines.push(`    readiness above is the discovered ${report.executable ?? '(not found)'}; "${runtime.executable}" is resolved through PATH at spawn time`);
    }
    for (const rejected of validation.rejected) lines.push(`    rejected ${rejected.setting}: ${rejected.reason}`);
    for (const unsupportedSetting of validation.unsupported) lines.push(`    unsupported ${unsupportedSetting.setting}: ${unsupportedSetting.reason}`);
    for (const accepted of validation.accepted) lines.push(`    ${accepted.setting} = ${accepted.value} (${accepted.status})`);
    runtimes.push({
      id,
      adapter: runtime.adapter,
      executable: runtime.executable,
      probedExecutable: probe?.probedPath ?? report?.executable ?? null,
      probedConfiguredPath: probe?.probedPath !== null && probe?.probedPath !== undefined,
      version: report?.version ?? null,
      readiness: report?.readiness ?? null,
      auth: report?.auth ?? null,
      capabilities:
        report === undefined
          ? null
          : Object.fromEntries(DISCOVERY_CAPABILITY_NAMES.map((name) => [name, { status: report.capabilities[name].status, source: report.capabilities[name].source }])),
      settings: validation,
    });
  }

  const agents = config.config.agents.map((agent) => {
    const runtime = config.config.runtimes[agent.runtime]!;
    const report = runtime.adapter === 'fake' ? undefined : reportFor(agent.runtime, runtime.adapter);
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
    // The agent-shaped version of the same fact: this is the binding a run
    // would dispatch, and the write boundary is a property of the pair.
    if (agent.policy === 'local-development' && report !== undefined && report.missingWriteBoundary.length > 0) {
      lines.push(
        `    BLOCKED: policy "local-development" lets this agent change files, but ${runtime.adapter} reports no tested write boundary (${report.missingWriteBoundary.join(', ')}). ` +
          '`workforce run` refuses this binding unless it is given --allow-unconfined-writes',
      );
    }
    if (validation !== null) {
      const profile = validation.accepted.find((a) => a.setting === 'permissions.profile');
      if (profile !== undefined) lines.push(`    policy controls: ${profile.controls.map((c) => c.argv.join(' ')).join(' ')}`);
      for (const rejected of validation.rejected) lines.push(`    rejected ${rejected.setting}: ${rejected.reason}`);
      for (const item of validation.unsupported) lines.push(`    unsupported ${item.setting}: ${item.reason}`);
    }
    return {
      id: agent.id,
      runtime: agent.runtime,
      adapter: runtime.adapter,
      policy: agent.policy,
      snapshotHash: computeAgentSnapshot(config.config, agent.id).hash,
      settings: validation,
      writeBoundaryBlocked: agent.policy === 'local-development' && report !== undefined && report.missingWriteBoundary.length > 0,
    };
  });

  return { lines, data: { path: config.path, schemaVersion: config.config.schemaVersion, runtimes, agents, defaults: config.config.defaults } };
}

/**
 * Ask the runtime itself. Neither adapter's live probe starts a model turn:
 * Codex speaks the app-server handshake, Claude Code sends one `initialize`
 * control request.
 */
async function defaultLiveProbe(adapter: DiscoverableAdapter, executable: string): Promise<RuntimeReadiness> {
  const instance = adapter === 'codex' ? new CodexAdapter({ executablePath: executable }) : new ClaudeCodeAdapter({ executablePath: executable });
  return instance.probe(executable, { live: true });
}

/**
 * Merge an explicit connection check into a passive report.
 *
 * The runtime's own answer wins over the status command's: `claude auth status`
 * describes a stored profile, and the runtime describes the credential it can
 * actually use. Where they disagree the report follows the runtime and says why.
 */
async function withLiveCheck(report: RuntimeReadinessReport, deps: DoctorDeps): Promise<RuntimeReadinessReport> {
  if (report.executable === null) return report;
  const probe = deps.liveProbe ?? defaultLiveProbe;
  let live: RuntimeReadiness;
  try {
    live = await probe(report.adapter, report.executable);
  } catch (error) {
    return { ...report, probeKind: 'live', diagnostics: [...report.diagnostics, `the connection check could not be run: ${(error as Error).message}`] };
  }
  const runtimeAuth = live.authentication === 'not_required' ? report.auth : live.authentication;
  const disagrees = runtimeAuth !== report.auth;
  const controllable = report.controllable && live.controllable;
  const merged: RuntimeReadinessReport = {
    ...report,
    controllable,
    // The level has to follow the facts the check established, or the table
    // would still show the login state the status command guessed.
    readiness: readinessFrom(report.installed, report.adapterSupported, controllable, runtimeAuth),
    auth: runtimeAuth,
    authDetail: disagrees
      ? `${report.authDetail}, but the connection check asked the runtime and it reports ${runtimeAuth}; the runtime's own answer is the one recorded`
      : `${report.authDetail}, confirmed by the connection check`,
    diagnostics: [...report.diagnostics, ...live.diagnostics.map((diagnostic) => `connection check: ${diagnostic}`)],
  };
  return applyLiveCheck(merged, {
    ok: live.controllable,
    evidence: `${report.adapter} connection check against ${report.executable}${live.version === null ? '' : ` (${live.version})`}: the runtime answered its own control handshake`,
  });
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

  const connect = args.connect === true;
  const checked = connect ? await Promise.all(reports.map((report) => withLiveCheck(report, deps))) : reports;

  const byAdapter = new Map<DiscoverableAdapter, RuntimeReadinessReport>();
  for (const report of checked) byAdapter.set(report.adapter, report);

  const lines: string[] = [
    connect
      ? 'workforce doctor — discovery plus an explicit connection check (a process is started; no model turn is)'
      : 'workforce doctor — passive runtime discovery (no model turn is started; --connect asks each runtime itself)',
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
  for (const report of checked) lines.push(...reportLines(report));

  const data: Record<string, unknown> = {
    stateRoot,
    passive: !connect,
    connectionChecked: connect,
    verifiedCapabilitiesFile: { path: overrides.file, present: overrides.present },
    runtimes: checked.map(reportJson),
  };

  if (args.config !== undefined) {
    const configured = await probeConfiguredRuntimes(args.config, byAdapter, deps, overrides);
    const rendered = configLines(args.config, byAdapter, configured);
    lines.push(...rendered.lines);
    data['config'] = rendered.data;
  }

  // Doctor is informational: a missing runtime is a reported fact, not a failure.
  return { command: 'doctor', exitCode: EXIT_CODES.verifiedCandidate, data, lines };
}
