/**
 * Runtime setting and policy validation (FR006, FR013).
 *
 * Three outcomes, and they mean different things:
 *
 * - `accepted`   the adapter has a documented control for this setting. A value
 *                the adapter cannot enumerate is `accepted_unverified`: it is
 *                passed through unchanged and the effective value is recorded
 *                from what the runtime reports.
 * - `rejected`   the setting exists but the value is not one this runtime takes.
 *                Nothing is silently mapped onto a neighbouring value.
 * - `unsupported` the runtime has no control for this at all. It is reported as
 *                missing rather than pretended to be enforced.
 */
import { POLICY_PROFILES, type Policy } from '../core/contracts.js';
import { isAtLeast, runtimeDescriptor, type DiscoverableAdapter } from './runtimes.js';

export type SettingAcceptance = 'accepted' | 'accepted_unverified';

/** A concrete adapter control: the argv fragment that carries a setting. */
export interface AdapterControl {
  readonly argv: ReadonlyArray<string>;
  readonly description: string;
}

export interface AcceptedSetting {
  readonly setting: string;
  readonly value: string;
  readonly status: SettingAcceptance;
  readonly controls: ReadonlyArray<AdapterControl>;
  readonly note: string;
}

export interface RejectedSetting {
  readonly setting: string;
  readonly reason: string;
}

export interface UnsupportedSetting {
  readonly setting: string;
  readonly reason: string;
}

export interface ToolSettings {
  readonly allowed?: ReadonlyArray<string>;
  readonly disallowed?: ReadonlyArray<string>;
  /** Extra directories the worker may touch. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Local MCP server configuration file/name to inject into the owned session. */
  readonly mcpConfig?: string;
}

export interface PermissionSettings {
  /** Execution profile the coordinator wants enforced. */
  readonly profile?: Policy;
  /** Claude Code `--permission-mode`. */
  readonly permissionMode?: string;
  /** Codex `--sandbox`. */
  readonly sandbox?: string;
  /** Codex `--ask-for-approval`. */
  readonly approvalPolicy?: string;
  /** Worker-tool network policy (provider inference traffic is a separate concern). */
  readonly network?: 'denied' | 'project_allowlist' | 'criterion_endpoint_only';
}

export interface RuntimeSettingsRequest {
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: ToolSettings;
  readonly permissions?: PermissionSettings;
  /** Directories a policy profile should grant, used when translating a profile to controls. */
  readonly workspaceDirs?: ReadonlyArray<string>;
  /** Models the runtime itself reported, when a live listing is available. Empty means nothing can be confirmed. */
  readonly knownModels?: ReadonlyArray<string>;
}

export interface RuntimeSettingsValidation {
  readonly adapter: DiscoverableAdapter;
  readonly version: string | null;
  /** False when the version is below the adapter minimum; every setting is then unusable. */
  readonly adapterSupported: boolean;
  readonly accepted: ReadonlyArray<AcceptedSetting>;
  readonly rejected: ReadonlyArray<RejectedSetting>;
  readonly unsupported: ReadonlyArray<UnsupportedSetting>;
  /** True when nothing was rejected. Unsupported settings are visible but do not block. */
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// Documented value sets (observed on the versions named in docs/runtime-compatibility.md)
// ---------------------------------------------------------------------------

/** `claude --effort <level>`: low, medium, high, xhigh, max. */
export const CLAUDE_EFFORT_LEVELS: ReadonlyArray<string> = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Codex `model_reasoning_effort` values. */
export const CODEX_EFFORT_LEVELS: ReadonlyArray<string> = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** `claude --permission-mode <mode>`. */
export const CLAUDE_PERMISSION_MODES: ReadonlyArray<string> = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
/** `codex --sandbox <mode>`. */
export const CODEX_SANDBOX_MODES: ReadonlyArray<string> = ['read-only', 'workspace-write', 'danger-full-access'];
/** `codex --ask-for-approval <policy>`. */
export const CODEX_APPROVAL_POLICIES: ReadonlyArray<string> = ['untrusted', 'on-request', 'never'];

/** Values the coordinator refuses to emit even though the runtime accepts them. */
const REFUSED_VALUES: Readonly<Record<string, string>> = {
  bypassPermissions: 'bypassPermissions disables every permission check; the coordinator never runs a worker without a containment boundary',
  'danger-full-access': 'danger-full-access removes the sandbox; the coordinator never runs a worker without a containment boundary',
};

/** Write tools denied under the read-only profiles. */
const CLAUDE_WRITE_TOOLS: ReadonlyArray<string> = ['Edit', 'Write', 'NotebookEdit'];

function list(values: ReadonlyArray<string>): string {
  return values.map((v) => `"${v}"`).join(', ');
}

// ---------------------------------------------------------------------------
// Policy profile translation (FR013)
// ---------------------------------------------------------------------------

export interface PolicyTranslation {
  readonly adapter: DiscoverableAdapter;
  readonly policy: Policy;
  readonly controls: ReadonlyArray<AdapterControl>;
  /** Parts of the profile this adapter has no control for; the coordinator must enforce them outside the runtime. */
  readonly unsupported: ReadonlyArray<UnsupportedSetting>;
}

/**
 * Translate an execution profile into the adapter's own controls.
 *
 * Codex gets a sandbox mode and `--ask-for-approval never` (an unattended run
 * must never sit on an approval prompt). Claude Code gets a permission mode,
 * tool allow/deny lists and the writable directory set.
 */
export function translatePolicy(adapter: DiscoverableAdapter, policy: Policy, workspaceDirs: ReadonlyArray<string> = []): PolicyTranslation {
  const profile = POLICY_PROFILES[policy];
  const controls: AdapterControl[] = [];
  const unsupported: UnsupportedSetting[] = [];

  if (adapter === 'codex') {
    const sandbox = profile.writeCandidate ? 'workspace-write' : 'read-only';
    controls.push({ argv: ['--sandbox', sandbox], description: `${policy}: ${profile.writeCandidate ? 'the granted candidate workspace is writable' : 'no repository writes'}` });
    controls.push({ argv: ['--ask-for-approval', 'never'], description: 'unattended execution: failures return to the model instead of waiting on an approval prompt' });
    for (const dir of workspaceDirs) controls.push({ argv: ['--add-dir', dir], description: 'additional writable directory granted for this attempt' });
    if (policy === 'verification') {
      controls.push({ argv: [], description: 'verification runs against a disposable copy of the frozen candidate; the preserved candidate stays read-only outside the runtime' });
    }
  } else {
    const mode = profile.writeCandidate ? 'acceptEdits' : 'plan';
    controls.push({ argv: ['--permission-mode', mode], description: `${policy}: ${profile.writeCandidate ? 'edits inside the granted directories are applied without a prompt' : 'planning mode, no edits are applied'}` });
    if (!profile.writeCandidate) {
      controls.push({ argv: ['--disallowedTools', ...CLAUDE_WRITE_TOOLS], description: `${policy}: write tools are denied` });
    }
    for (const dir of workspaceDirs) controls.push({ argv: ['--add-dir', dir], description: 'additional directory the file tools may reach' });
    unsupported.push({
      setting: 'permissions.sandbox',
      reason: 'Claude Code bounds file access with the permission mode and --add-dir; it does not provide an OS-level sandbox, so process containment must be established outside the adapter',
    });
  }

  unsupported.push({
    setting: 'permissions.network',
    reason: `no documented ${adapter} flag enforces the "${profile.workerNetwork}" worker-tool network policy; it must be enforced by the execution environment rather than claimed by the adapter`,
  });

  unsupported.push({
    setting: 'permissions.externalDelivery',
    reason: 'no adapter control prevents a worker from attempting a push or deployment; the coordinator denies external delivery by withholding credentials and remotes',
  });

  if (!profile.executeRepositoryHooks) {
    unsupported.push({
      setting: 'permissions.executeRepositoryHooks',
      reason: `the ${policy} profile forbids running repository hooks with host privileges; no adapter flag expresses that, so the check runner must enforce it`,
    });
  }

  return { adapter, policy, controls, unsupported };
}

// ---------------------------------------------------------------------------
// Setting validation
// ---------------------------------------------------------------------------

function validateEffort(adapter: DiscoverableAdapter, value: string, accepted: AcceptedSetting[], rejected: RejectedSetting[]): void {
  const levels = adapter === 'codex' ? CODEX_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
  if (!levels.includes(value)) {
    rejected.push({
      setting: 'effort',
      reason: `${adapter} accepts ${list(levels)}; "${value}" is not one of them and is not mapped onto a neighbouring level`,
    });
    return;
  }
  const controls: AdapterControl[] =
    adapter === 'codex'
      ? [{ argv: ['-c', `model_reasoning_effort="${value}"`], description: 'Codex sets reasoning effort through a configuration value, not a flag' }]
      : [{ argv: ['--effort', value], description: 'Claude Code effort level for the session' }];
  accepted.push({ setting: 'effort', value, status: 'accepted', controls, note: `documented effort level for ${adapter}` });
}

function validateModel(adapter: DiscoverableAdapter, value: string, known: ReadonlyArray<string>, accepted: AcceptedSetting[], rejected: RejectedSetting[]): void {
  if (value.trim().length === 0) {
    rejected.push({ setting: 'model', reason: 'model must be a non-empty string' });
    return;
  }
  const controls: AdapterControl[] = [{ argv: ['--model', value], description: `${adapter} model selection` }];
  if (known.includes(value)) {
    accepted.push({ setting: 'model', value, status: 'accepted', controls, note: 'the runtime itself listed this model' });
    return;
  }
  accepted.push({
    setting: 'model',
    value,
    status: 'accepted_unverified',
    controls,
    note: 'discovery cannot enumerate this runtime\'s models, so the value is passed through unchanged and the effective model is recorded from what the runtime reports',
  });
}

/**
 * Validate a model/effort/tools/permissions request against one adapter at one
 * observed version. `version === null` or a version below the adapter minimum
 * makes every setting unusable, which is reported rather than assumed away.
 */
export function validateRuntimeSettings(adapter: DiscoverableAdapter, version: string | null, request: RuntimeSettingsRequest = {}): RuntimeSettingsValidation {
  const descriptor = runtimeDescriptor(adapter);
  const accepted: AcceptedSetting[] = [];
  const rejected: RejectedSetting[] = [];
  const unsupported: UnsupportedSetting[] = [];
  const adapterSupported = version !== null && isAtLeast(version, descriptor.minimumSupportedVersion);

  if (!adapterSupported) {
    const reason =
      version === null
        ? `no version could be read from the ${descriptor.executableName} executable, so no setting can be validated against it`
        : `${descriptor.displayName} ${version} is below the supported minimum ${descriptor.minimumSupportedVersion}; its controls are not offered`;
    const requested: string[] = [];
    if (request.model !== undefined) requested.push('model');
    if (request.effort !== undefined) requested.push('effort');
    if (request.tools !== undefined) requested.push('tools');
    if (request.permissions !== undefined) requested.push('permissions');
    for (const setting of requested.length === 0 ? ['runtime'] : requested) unsupported.push({ setting, reason });
    return { adapter, version, adapterSupported, accepted, rejected, unsupported, ok: rejected.length === 0 };
  }

  if (request.model !== undefined) validateModel(adapter, request.model, request.knownModels ?? [], accepted, rejected);
  if (request.effort !== undefined) validateEffort(adapter, request.effort, accepted, rejected);

  const tools = request.tools;
  if (tools !== undefined) {
    if (tools.allowed !== undefined && tools.allowed.length > 0) {
      if (adapter === 'claude-code') {
        accepted.push({
          setting: 'tools.allowed',
          value: tools.allowed.join(' '),
          status: 'accepted',
          controls: [{ argv: ['--allowedTools', ...tools.allowed], description: 'tool allowlist for the session' }],
          note: 'Claude Code takes a tool allowlist directly',
        });
      } else {
        unsupported.push({ setting: 'tools.allowed', reason: 'Codex has no documented per-tool allowlist; its enforcement surface is the sandbox mode and the approval policy' });
      }
    }
    if (tools.disallowed !== undefined && tools.disallowed.length > 0) {
      if (adapter === 'claude-code') {
        accepted.push({
          setting: 'tools.disallowed',
          value: tools.disallowed.join(' '),
          status: 'accepted',
          controls: [{ argv: ['--disallowedTools', ...tools.disallowed], description: 'tool denylist for the session' }],
          note: 'Claude Code takes a tool denylist directly',
        });
      } else {
        unsupported.push({ setting: 'tools.disallowed', reason: 'Codex has no documented per-tool denylist; its enforcement surface is the sandbox mode and the approval policy' });
      }
    }
    if (tools.additionalDirectories !== undefined && tools.additionalDirectories.length > 0) {
      const controls = tools.additionalDirectories.map((dir) => ({ argv: ['--add-dir', dir], description: 'additional directory granted for this attempt' }));
      accepted.push({ setting: 'tools.additionalDirectories', value: tools.additionalDirectories.join(' '), status: 'accepted', controls, note: `${descriptor.displayName} documents --add-dir on this version` });
    }
    if (tools.mcpConfig !== undefined) {
      const controls: AdapterControl[] =
        adapter === 'claude-code'
          ? [{ argv: ['--mcp-config', tools.mcpConfig], description: 'per-session MCP configuration' }]
          : [{ argv: ['-c', `mcp_servers=${tools.mcpConfig}`], description: 'per-session MCP configuration through a Codex configuration override' }];
      accepted.push({
        setting: 'tools.mcpConfig',
        value: tools.mcpConfig,
        status: 'accepted_unverified',
        controls,
        note: 'per-session MCP injection is documented but has not been proved against the installed executable; WP06 verifies it before it is relied on',
      });
    }
  }

  const permissions = request.permissions;
  if (permissions !== undefined) {
    if (permissions.permissionMode !== undefined) {
      if (adapter !== 'claude-code') {
        unsupported.push({ setting: 'permissions.permissionMode', reason: 'permission modes are a Claude Code control; Codex uses --sandbox and --ask-for-approval' });
      } else if (!CLAUDE_PERMISSION_MODES.includes(permissions.permissionMode)) {
        rejected.push({ setting: 'permissions.permissionMode', reason: `Claude Code accepts ${list(CLAUDE_PERMISSION_MODES)}; "${permissions.permissionMode}" is not one of them` });
      } else if (REFUSED_VALUES[permissions.permissionMode] !== undefined) {
        rejected.push({ setting: 'permissions.permissionMode', reason: REFUSED_VALUES[permissions.permissionMode]! });
      } else {
        accepted.push({
          setting: 'permissions.permissionMode',
          value: permissions.permissionMode,
          status: 'accepted',
          controls: [{ argv: ['--permission-mode', permissions.permissionMode], description: 'session permission mode' }],
          note: 'documented permission mode',
        });
      }
    }

    if (permissions.sandbox !== undefined) {
      if (adapter !== 'codex') {
        unsupported.push({ setting: 'permissions.sandbox', reason: 'Claude Code has no sandbox-mode flag; file access is bounded by the permission mode and --add-dir' });
      } else if (!CODEX_SANDBOX_MODES.includes(permissions.sandbox)) {
        rejected.push({ setting: 'permissions.sandbox', reason: `Codex accepts ${list(CODEX_SANDBOX_MODES)}; "${permissions.sandbox}" is not one of them` });
      } else if (REFUSED_VALUES[permissions.sandbox] !== undefined) {
        rejected.push({ setting: 'permissions.sandbox', reason: REFUSED_VALUES[permissions.sandbox]! });
      } else {
        accepted.push({
          setting: 'permissions.sandbox',
          value: permissions.sandbox,
          status: 'accepted',
          controls: [{ argv: ['--sandbox', permissions.sandbox], description: 'Codex sandbox policy for model-generated commands' }],
          note: 'documented sandbox mode',
        });
      }
    }

    if (permissions.approvalPolicy !== undefined) {
      if (adapter !== 'codex') {
        unsupported.push({ setting: 'permissions.approvalPolicy', reason: 'approval policies are a Codex control; Claude Code uses --permission-mode' });
      } else if (!CODEX_APPROVAL_POLICIES.includes(permissions.approvalPolicy)) {
        rejected.push({ setting: 'permissions.approvalPolicy', reason: `Codex accepts ${list(CODEX_APPROVAL_POLICIES)}; "${permissions.approvalPolicy}" is not one of them` });
      } else {
        accepted.push({
          setting: 'permissions.approvalPolicy',
          value: permissions.approvalPolicy,
          status: 'accepted',
          controls: [{ argv: ['--ask-for-approval', permissions.approvalPolicy], description: 'when Codex asks a human before running a command' }],
          note: 'documented approval policy',
        });
      }
    }

    if (permissions.network !== undefined) {
      unsupported.push({
        setting: 'permissions.network',
        reason: `no documented ${descriptor.displayName} flag enforces the "${permissions.network}" worker-tool network policy; it must be enforced by the execution environment rather than claimed here`,
      });
    }

    if (permissions.profile !== undefined) {
      const translation = translatePolicy(adapter, permissions.profile, request.workspaceDirs ?? []);
      accepted.push({
        setting: 'permissions.profile',
        value: permissions.profile,
        status: 'accepted',
        controls: translation.controls.filter((c) => c.argv.length > 0),
        note: `the ${permissions.profile} profile maps to ${translation.controls
          .filter((c) => c.argv.length > 0)
          .map((c) => c.argv.join(' '))
          .join(' ')}`,
      });
      unsupported.push(...translation.unsupported);
    }
  }

  return { adapter, version, adapterSupported, accepted, rejected, unsupported: dedupe(unsupported), ok: rejected.length === 0 };
}

/** One entry per setting: a profile and an explicit network request must not report the same gap twice. */
function dedupe(entries: ReadonlyArray<UnsupportedSetting>): ReadonlyArray<UnsupportedSetting> {
  const seen = new Set<string>();
  const out: UnsupportedSetting[] = [];
  for (const entry of entries) {
    if (seen.has(entry.setting)) continue;
    seen.add(entry.setting);
    out.push(entry);
  }
  return out;
}
