/** AT01 — runtime settings and policy translation: nothing is silently mapped, nothing unenforceable is claimed (FR006, FR013). */
import { describe, expect, it } from 'vitest';
import { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS, translatePolicy, validateRuntimeSettings } from '../../src/discovery/settings.js';

const CODEX_VERSION = '0.147.0';
const CLAUDE_VERSION = '2.1.260';

function argvOf(validation: ReturnType<typeof validateRuntimeSettings>, setting: string): string[] {
  const accepted = validation.accepted.find((a) => a.setting === setting);
  return accepted === undefined ? [] : accepted.controls.flatMap((c) => c.argv);
}

describe('effort is validated against each runtime\'s own levels', () => {
  it('accepts each documented level and turns it into that runtime\'s control', () => {
    for (const level of CLAUDE_EFFORT_LEVELS) {
      const validation = validateRuntimeSettings('claude-code', CLAUDE_VERSION, { effort: level });
      expect(validation.ok).toBe(true);
      expect(argvOf(validation, 'effort')).toEqual(['--effort', level]);
    }
    for (const level of CODEX_EFFORT_LEVELS) {
      const validation = validateRuntimeSettings('codex', CODEX_VERSION, { effort: level });
      expect(validation.ok).toBe(true);
      expect(argvOf(validation, 'effort')).toEqual(['-c', `model_reasoning_effort="${level}"`]);
    }
  });

  it('rejects a level the runtime does not have instead of mapping it to a neighbour', () => {
    // "max" is a Claude Code level; Codex has "minimal" instead. Neither is translated into the other.
    const codexMax = validateRuntimeSettings('codex', CODEX_VERSION, { effort: 'max' });
    expect(codexMax.ok).toBe(false);
    expect(codexMax.accepted).toEqual([]);
    expect(codexMax.rejected[0]?.reason).toContain('"minimal", "low", "medium", "high", "xhigh"');

    const claudeMinimal = validateRuntimeSettings('claude-code', CLAUDE_VERSION, { effort: 'minimal' });
    expect(claudeMinimal.ok).toBe(false);
    expect(claudeMinimal.rejected[0]?.reason).toContain('not mapped onto a neighbouring level');

    expect(validateRuntimeSettings('claude-code', CLAUDE_VERSION, { effort: 'HIGH' }).ok).toBe(false);
  });
});

describe('models are passed through honestly', () => {
  it('accepts an unknown model as unverified and says the effective value comes from the runtime', () => {
    const validation = validateRuntimeSettings('codex', CODEX_VERSION, { model: 'gpt-5.7-codex' });
    const model = validation.accepted.find((a) => a.setting === 'model');
    expect(validation.ok).toBe(true);
    expect(model?.status).toBe('accepted_unverified');
    expect(model?.note).toContain('recorded from what the runtime reports');
    expect(model?.controls[0]?.argv).toEqual(['--model', 'gpt-5.7-codex']);
  });

  it('marks a model the runtime itself listed as accepted rather than unverified', () => {
    const validation = validateRuntimeSettings('codex', CODEX_VERSION, { model: 'gpt-5.7-codex', knownModels: ['gpt-5.7-codex'] });
    expect(validation.accepted.find((a) => a.setting === 'model')?.status).toBe('accepted');
  });

  it('rejects an empty model', () => {
    expect(validateRuntimeSettings('claude-code', CLAUDE_VERSION, { model: '   ' }).ok).toBe(false);
  });
});

describe('settings a runtime has no control for are reported as unsupported, not enforced', () => {
  it('reports a tool allowlist as a Claude Code control and as unsupported on Codex', () => {
    const claude = validateRuntimeSettings('claude-code', CLAUDE_VERSION, { tools: { allowed: ['Read', 'Grep'], disallowed: ['Write'] } });
    expect(argvOf(claude, 'tools.allowed')).toEqual(['--allowedTools', 'Read', 'Grep']);
    expect(argvOf(claude, 'tools.disallowed')).toEqual(['--disallowedTools', 'Write']);
    expect(claude.unsupported).toEqual([]);

    const codex = validateRuntimeSettings('codex', CODEX_VERSION, { tools: { allowed: ['Read'] } });
    expect(codex.ok).toBe(true); // an unsupported setting is visible, not a hard rejection
    expect(codex.accepted).toEqual([]);
    expect(codex.unsupported.map((u) => u.setting)).toEqual(['tools.allowed']);
    expect(codex.unsupported[0]?.reason).toContain('no documented per-tool allowlist');
  });

  it('reports a control belonging to the other adapter as unsupported', () => {
    expect(validateRuntimeSettings('codex', CODEX_VERSION, { permissions: { permissionMode: 'plan' } }).unsupported.map((u) => u.setting)).toEqual(['permissions.permissionMode']);
    expect(validateRuntimeSettings('claude-code', CLAUDE_VERSION, { permissions: { sandbox: 'read-only' } }).unsupported.map((u) => u.setting)).toEqual(['permissions.sandbox']);
  });

  it('never claims to enforce a worker-tool network policy', () => {
    for (const [adapter, version] of [['codex', CODEX_VERSION], ['claude-code', CLAUDE_VERSION]] as const) {
      const validation = validateRuntimeSettings(adapter, version, { permissions: { network: 'denied' } });
      const network = validation.unsupported.find((u) => u.setting === 'permissions.network');
      expect(network?.reason).toContain('enforced by the execution environment');
      expect(validation.accepted.some((a) => a.setting === 'permissions.network')).toBe(false);
    }
  });

  it('rejects the values that remove the containment boundary', () => {
    expect(validateRuntimeSettings('claude-code', CLAUDE_VERSION, { permissions: { permissionMode: 'bypassPermissions' } }).ok).toBe(false);
    expect(validateRuntimeSettings('codex', CODEX_VERSION, { permissions: { sandbox: 'danger-full-access' } }).rejected[0]?.reason).toContain('containment boundary');
    expect(validateRuntimeSettings('codex', CODEX_VERSION, { permissions: { approvalPolicy: 'sometimes' } }).ok).toBe(false);
  });
});

describe('an unsupported runtime version offers no settings at all', () => {
  it('reports every requested setting as unsupported below the adapter minimum and when no version is known', () => {
    const old = validateRuntimeSettings('codex', '0.120.0', { model: 'x', effort: 'high' });
    expect(old.adapterSupported).toBe(false);
    expect(old.accepted).toEqual([]);
    expect(old.unsupported.map((u) => u.setting).sort()).toEqual(['effort', 'model']);
    expect(old.unsupported[0]?.reason).toContain('below the supported minimum 0.140.0');

    const unknown = validateRuntimeSettings('claude-code', null, { effort: 'high' });
    expect(unknown.adapterSupported).toBe(false);
    expect(unknown.unsupported[0]?.reason).toContain('no version could be read');
  });
});

describe('policy profiles become real adapter controls (FR013)', () => {
  it('maps codex profiles to a sandbox mode and an unattended approval policy', () => {
    expect(translatePolicy('codex', 'analysis').controls.flatMap((c) => c.argv)).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'never']);
    expect(translatePolicy('codex', 'local-development', ['/w/candidate']).controls.flatMap((c) => c.argv)).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '--add-dir',
      '/w/candidate',
    ]);
    expect(translatePolicy('codex', 'verification').controls.some((c) => c.description.includes('disposable copy'))).toBe(true);
  });

  it('maps claude-code profiles to a permission mode, tool denials and the writable directory set', () => {
    const analysis = translatePolicy('claude-code', 'analysis');
    expect(analysis.controls.flatMap((c) => c.argv)).toEqual(['--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit']);

    const development = translatePolicy('claude-code', 'local-development', ['/w/candidate']);
    expect(development.controls.flatMap((c) => c.argv)).toEqual(['--permission-mode', 'acceptEdits', '--add-dir', '/w/candidate']);
  });

  it('names the parts of a profile no adapter flag can enforce', () => {
    for (const adapter of ['codex', 'claude-code'] as const) {
      const settings = translatePolicy(adapter, 'analysis').unsupported.map((u) => u.setting);
      expect(settings).toContain('permissions.network');
      expect(settings).toContain('permissions.externalDelivery');
      expect(settings).toContain('permissions.executeRepositoryHooks');
    }
  });

  it('reports a profile through validateRuntimeSettings with its controls and its gaps, once each', () => {
    const validation = validateRuntimeSettings('claude-code', CLAUDE_VERSION, { permissions: { profile: 'local-development', network: 'project_allowlist' }, workspaceDirs: ['/w/c'] });
    expect(argvOf(validation, 'permissions.profile')).toEqual(['--permission-mode', 'acceptEdits', '--add-dir', '/w/c']);
    expect(validation.unsupported.filter((u) => u.setting === 'permissions.network')).toHaveLength(1);
  });
});
