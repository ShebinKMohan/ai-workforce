/**
 * Per-adapter, per-version capability table (FR005).
 *
 * Every entry starts at `supported_unverified`: the documented interface exists
 * on that version range, but this repository has not yet proved it against the
 * installed executable. Passive discovery can never raise an entry to
 * `verified` — only a real adapter test may, and it does so by writing
 * `docs/verified-capabilities.json`, which this module loads when present.
 *
 * Below an adapter's minimum version every capability is `unsupported`, so a
 * too-old runtime blocks the execution modes that require those controls
 * instead of silently dropping a required control.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CapabilityStatus } from '../adapters/types.js';
import { formatZodIssues } from '../core/contracts.js';
import { compareVersions, isAtLeast, runtimeDescriptor, type DiscoverableAdapter } from './runtimes.js';

export type { CapabilityStatus };

export const DISCOVERY_CAPABILITY_NAMES = [
  'structured_execution',
  'owned_session_identity',
  'observed_cancellation',
  'resume_session',
  'active_turn_delivery',
  'mcp_config_injection',
  'sandbox_workspace_write',
  'model_selection',
  'effort_selection',
  'token_usage_report',
  'cost_report',
] as const;
export type DiscoveryCapabilityName = (typeof DISCOVERY_CAPABILITY_NAMES)[number];

/**
 * A runtime is "controllable" only when all three of these are at least
 * `supported_unverified` (plan section 6: R0 requires structured execution,
 * owned session identity and observed cancellation).
 */
export const REQUIRED_CONTROL_CAPABILITIES: ReadonlyArray<DiscoveryCapabilityName> = ['structured_execution', 'owned_session_identity', 'observed_cancellation'];

/**
 * Capabilities a *writing* execution mode requires on top of those three.
 *
 * Plan section 6: R0 requires "a minimum tested containment boundary before
 * writes"; section 8: an adapter that cannot enforce a required profile must
 * fail that mode. A runtime missing this is still perfectly controllable for
 * read-only work, so it is reported separately from `missingControls` rather
 * than making the runtime uncontrollable — but a writing profile on it is
 * refused by the run path (FR005: "required unsupported controls block that
 * execution mode").
 */
export const REQUIRED_WRITING_CAPABILITIES: ReadonlyArray<DiscoveryCapabilityName> = ['sandbox_workspace_write'];

export interface CapabilityEntry {
  readonly status: CapabilityStatus;
  /** Where the status came from: the built-in table, the version gate, or a verified-capabilities override. */
  readonly source: 'table' | 'version_gate' | 'override';
  /** Version the status is stated for; null when no version could be read. */
  readonly version: string | null;
  readonly note: string;
}

export type CapabilityTable = Readonly<Record<DiscoveryCapabilityName, CapabilityEntry>>;

interface VersionRangeEntry {
  readonly minVersion: string;
  readonly maxVersionExclusive?: string;
  readonly statuses: Partial<Record<DiscoveryCapabilityName, CapabilityStatus>>;
  readonly notes?: Partial<Record<DiscoveryCapabilityName, string>>;
}

const COST_NOTE = 'no currency-cost field is established for this runtime; report cost as unavailable, never as zero';

/**
 * Ranges are ordered; the first one containing the version wins. Statuses left
 * out of a range default to `supported_unverified`.
 */
const TABLE: Readonly<Record<DiscoverableAdapter, ReadonlyArray<VersionRangeEntry>>> = {
  codex: [
    {
      minVersion: '0.140.0',
      statuses: { cost_report: 'unsupported' },
      notes: {
        structured_execution: 'app-server / `codex exec --json` emit structured events',
        owned_session_identity: 'sessions are addressed by id and can be resumed',
        observed_cancellation: 'interruption is requested through the app server; observed termination still needs the process group',
        mcp_config_injection: 'MCP servers are configured through `-c mcp_servers...`',
        sandbox_workspace_write: '`--sandbox workspace-write` is documented on this version',
        effort_selection: 'effort is set through the `model_reasoning_effort` configuration value, not a flag',
        cost_report: COST_NOTE,
      },
    },
  ],
  'claude-code': [
    {
      minVersion: '2.1.0',
      statuses: { cost_report: 'unsupported' },
      notes: {
        structured_execution: '`--print --output-format stream-json` emits structured events and a result record',
        owned_session_identity: 'sessions carry an id that `--resume` accepts',
        observed_cancellation: 'the process can be interrupted; observed termination still needs the process group',
        mcp_config_injection: 'MCP servers are configured through `--mcp-config`',
        sandbox_workspace_write: 'write scope is bounded by `--add-dir` and the permission mode, not by an OS sandbox',
        effort_selection: '`--effort` accepts low, medium, high, xhigh and max on this version',
        cost_report: COST_NOTE,
      },
    },
  ],
};

function entry(status: CapabilityStatus, source: CapabilityEntry['source'], version: string | null, note: string): CapabilityEntry {
  return { status, source, version, note };
}

function rangeFor(adapter: DiscoverableAdapter, version: string): VersionRangeEntry | null {
  for (const range of TABLE[adapter]) {
    if (!isAtLeast(version, range.minVersion)) continue;
    if (range.maxVersionExclusive !== undefined) {
      const cmp = compareVersions(version, range.maxVersionExclusive);
      if (cmp === null || cmp >= 0) continue;
    }
    return range;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verified-capability overrides (the hook WP03/WP05 write into)
// ---------------------------------------------------------------------------

const OverrideEntrySchema = z.strictObject({
  adapter: z.enum(['codex', 'claude-code']),
  minVersion: z.string().min(1),
  maxVersionExclusive: z.string().min(1).optional(),
  /** Exact builds can be recorded without claiming the surrounding version range. */
  exactVersions: z.array(z.string().min(1)).min(1).optional(),
  os: z.enum(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd']).optional(),
  capabilities: z.partialRecord(
    z.enum(DISCOVERY_CAPABILITY_NAMES),
    z.strictObject({
      status: z.enum(['unsupported', 'supported_unverified', 'verified']),
      /** A `verified` claim must say which test established it; discovery never invents one. */
      evidence: z.string().min(1),
    }),
  ),
});

const OverrideFileSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(OverrideEntrySchema),
});

export type CapabilityOverrideFile = z.infer<typeof OverrideFileSchema>;

export interface LoadedOverrides {
  readonly file: string;
  readonly present: boolean;
  readonly entries: CapabilityOverrideFile['entries'];
  readonly diagnostics: ReadonlyArray<string>;
}

/** Default location of the hook file: `docs/verified-capabilities.json` beside the plan. */
export function defaultVerifiedCapabilitiesFile(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'verified-capabilities.json');
}

/**
 * Load the override file when it exists. A missing file is the normal case and
 * produces no diagnostic; a malformed file is reported and ignored so that
 * `doctor` still works.
 */
export function loadVerifiedCapabilityOverrides(file: string = defaultVerifiedCapabilitiesFile()): LoadedOverrides {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { file, present: false, entries: [], diagnostics: [] };
    return { file, present: false, entries: [], diagnostics: [`could not read ${file}: ${(error as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file, present: true, entries: [], diagnostics: [`${file} is not valid JSON (${(error as Error).message}); capability statuses fall back to the built-in table`] };
  }
  const result = OverrideFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatZodIssues(result.error.issues).map((i) => `${i.path}: ${i.message}`);
    return { file, present: true, entries: [], diagnostics: [`${file} is invalid and was ignored: ${issues.join('; ')}`] };
  }
  return { file, present: true, entries: result.data.entries, diagnostics: [] };
}

export interface CapabilitiesOptions {
  readonly overrides?: LoadedOverrides;
  readonly platform?: NodeJS.Platform;
}

/**
 * Build the capability table for one adapter at one observed version.
 * `version === null` means the executable never told us its version, so no
 * capability may be claimed at all.
 */
export function capabilitiesFor(adapter: DiscoverableAdapter, version: string | null, options: CapabilitiesOptions = {}): CapabilityTable {
  const descriptor = runtimeDescriptor(adapter);
  const table = {} as Record<DiscoveryCapabilityName, CapabilityEntry>;

  if (version === null) {
    for (const name of DISCOVERY_CAPABILITY_NAMES) {
      table[name] = entry('unsupported', 'version_gate', null, 'no version could be read from the executable, so no capability is claimed');
    }
    return table;
  }

  const range = rangeFor(adapter, version);
  if (range === null) {
    const note = `version ${version} is below the ${descriptor.displayName} minimum ${descriptor.minimumSupportedVersion}`;
    for (const name of DISCOVERY_CAPABILITY_NAMES) table[name] = entry('unsupported', 'version_gate', version, note);
    return table;
  }

  for (const name of DISCOVERY_CAPABILITY_NAMES) {
    const status = range.statuses[name] ?? 'supported_unverified';
    const note = range.notes?.[name] ?? (status === 'supported_unverified' ? 'documented for this version range; not yet proved against the installed executable' : '');
    table[name] = entry(status, 'table', version, note);
  }

  for (const override of options.overrides?.entries ?? []) {
    if (override.adapter !== adapter) continue;
    if (override.os !== undefined && override.os !== (options.platform ?? process.platform)) continue;
    if (override.exactVersions !== undefined && !override.exactVersions.includes(version)) continue;
    if (!isAtLeast(version, override.minVersion)) continue;
    if (override.maxVersionExclusive !== undefined) {
      const cmp = compareVersions(version, override.maxVersionExclusive);
      if (cmp === null || cmp >= 0) continue;
    }
    for (const [name, value] of Object.entries(override.capabilities)) {
      const capability = name as DiscoveryCapabilityName;
      if (value === undefined) continue;
      table[capability] = entry(value.status, 'override', version, value.evidence);
    }
  }

  return table;
}

/** True when every required control capability is at least `supported_unverified`. */
export function isControllable(table: CapabilityTable): boolean {
  return REQUIRED_CONTROL_CAPABILITIES.every((name) => table[name].status !== 'unsupported');
}

/** Required control capabilities this version does not offer; these block execution modes that need them. */
export function missingControlCapabilities(table: CapabilityTable): ReadonlyArray<DiscoveryCapabilityName> {
  return REQUIRED_CONTROL_CAPABILITIES.filter((name) => table[name].status === 'unsupported');
}

/** Boundaries a writing profile needs and this version does not offer; these block writing modes only. */
export function missingWriteBoundaryCapabilities(table: CapabilityTable): ReadonlyArray<DiscoveryCapabilityName> {
  return REQUIRED_WRITING_CAPABILITIES.filter((name) => table[name].status === 'unsupported');
}
