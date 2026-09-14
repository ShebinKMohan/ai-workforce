/** AT01 — capability tables are version-gated and nothing is "verified" without recorded evidence (FR005). */
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  DISCOVERY_CAPABILITY_NAMES,
  isControllable,
  loadVerifiedCapabilityOverrides,
  missingControlCapabilities,
} from '../../src/discovery/capabilities.js';
import { compareVersions, isAtLeast } from '../../src/discovery/runtimes.js';
import { tempDir } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function overrideFile(contents: string): string {
  const root = tempDir('workforce-caps-');
  roots.push(root);
  const file = path.join(root, 'verified-capabilities.json');
  writeFileSync(file, contents);
  return file;
}

describe('capability tables are gated on the observed version', () => {
  it('offers documented controls at or above the adapter minimum and nothing below it', () => {
    const supported = capabilitiesFor('codex', '0.147.0');
    expect(supported['structured_execution'].status).toBe('supported_unverified');
    expect(isControllable(supported)).toBe(true);
    expect(missingControlCapabilities(supported)).toEqual([]);

    const tooOld = capabilitiesFor('codex', '0.139.9');
    for (const name of DISCOVERY_CAPABILITY_NAMES) expect(tooOld[name].status).toBe('unsupported');
    expect(isControllable(tooOld)).toBe(false);
    expect(missingControlCapabilities(tooOld)).toEqual(['structured_execution', 'owned_session_identity', 'observed_cancellation']);
    expect(tooOld['structured_execution'].note).toContain('below the Codex CLI minimum 0.140.0');

    expect(capabilitiesFor('claude-code', '2.0.99')['structured_execution'].status).toBe('unsupported');
    expect(capabilitiesFor('claude-code', '2.1.0')['structured_execution'].status).toBe('supported_unverified');
  });

  it('claims nothing at all when no version could be read', () => {
    const unknown = capabilitiesFor('claude-code', null);
    for (const name of DISCOVERY_CAPABILITY_NAMES) {
      expect(unknown[name].status).toBe('unsupported');
      expect(unknown[name].source).toBe('version_gate');
    }
  });

  it('never marks a capability verified from the built-in table alone', () => {
    for (const version of ['0.147.0', '9.9.9']) {
      const table = capabilitiesFor('codex', version);
      for (const name of DISCOVERY_CAPABILITY_NAMES) expect(table[name].status).not.toBe('verified');
    }
    // Currency cost is reported as unavailable rather than as a zero.
    expect(capabilitiesFor('claude-code', '2.1.260')['cost_report'].status).toBe('unsupported');
  });
});

describe('the verified-capabilities hook', () => {
  it('loads separate exact stable CLI evidence without crediting adjacent or other-platform builds', () => {
    const overrides = loadVerifiedCapabilityOverrides(path.resolve('docs/verified-capabilities.json'));
    expect(overrides.diagnostics).toEqual([]);
    const stable = capabilitiesFor('codex', '0.154.0', { overrides, platform: 'darwin' });
    for (const capability of ['sandbox_workspace_write', 'mcp_config_injection', 'observed_cancellation', 'model_selection'] as const) {
      expect(stable[capability].status).toBe('verified');
      expect(stable[capability].note).toContain('codex-local-upgrade-2026-09-13');
    }
    expect(capabilitiesFor('codex', '0.154.1', { overrides, platform: 'darwin' }).sandbox_workspace_write.status).toBe('supported_unverified');
    expect(capabilitiesFor('codex', '0.154.0', { overrides, platform: 'linux' }).sandbox_workspace_write.status).toBe('supported_unverified');
  });

  it('is optional: a missing file produces no diagnostic and leaves the table alone', () => {
    const loaded = loadVerifiedCapabilityOverrides(path.join(tempDir('workforce-caps-'), 'absent.json'));
    expect(loaded.present).toBe(false);
    expect(loaded.diagnostics).toEqual([]);
  });

  it('raises an entry to verified only for the adapter and version range it names', () => {
    const file = overrideFile(
      JSON.stringify({
        version: 1,
        entries: [
          {
            adapter: 'codex',
            minVersion: '0.147.0',
            maxVersionExclusive: '0.148.0',
            capabilities: { observed_cancellation: { status: 'verified', evidence: 'WP03 adapter test t-1 observed process-tree termination' } },
          },
        ],
      }),
    );
    const overrides = loadVerifiedCapabilityOverrides(file);
    expect(overrides.diagnostics).toEqual([]);

    const inRange = capabilitiesFor('codex', '0.147.0', { overrides });
    expect(inRange['observed_cancellation'].status).toBe('verified');
    expect(inRange['observed_cancellation'].source).toBe('override');
    expect(inRange['observed_cancellation'].note).toContain('WP03 adapter test t-1');
    expect(inRange['structured_execution'].status).toBe('supported_unverified');

    expect(capabilitiesFor('codex', '0.148.0', { overrides })['observed_cancellation'].status).toBe('supported_unverified');
    expect(capabilitiesFor('claude-code', '2.1.260', { overrides })['observed_cancellation'].status).toBe('supported_unverified');
  });

  it('ignores a malformed or unevidenced override and says so instead of failing discovery', () => {
    const broken = loadVerifiedCapabilityOverrides(overrideFile('{ not json'));
    expect(broken.entries).toEqual([]);
    expect(broken.diagnostics.join(' ')).toContain('not valid JSON');
    expect(capabilitiesFor('codex', '0.147.0', { overrides: broken })['observed_cancellation'].status).toBe('supported_unverified');

    const unevidenced = loadVerifiedCapabilityOverrides(
      overrideFile(JSON.stringify({ version: 1, entries: [{ adapter: 'codex', minVersion: '0.147.0', capabilities: { observed_cancellation: { status: 'verified' } } }] })),
    );
    expect(unevidenced.entries).toEqual([]);
    expect(unevidenced.diagnostics.join(' ')).toContain('evidence');
  });

  it('accepts an exact recorded prerelease on its tested OS without upgrading adjacent builds', () => {
    const overrides = loadVerifiedCapabilityOverrides(overrideFile(JSON.stringify({ version: 1, entries: [{
      adapter: 'codex', minVersion: '0.154.0-alpha.6.2', exactVersions: ['0.154.0-alpha.6.2'], os: 'darwin',
      capabilities: { sandbox_workspace_write: { status: 'verified', evidence: 'Owned exact-build fixture boundary proof.' } },
    }] })));
    expect(overrides.diagnostics).toEqual([]);
    expect(capabilitiesFor('codex', '0.154.0-alpha.6.2', { overrides, platform: 'darwin' }).sandbox_workspace_write.status).toBe('verified');
    for (const version of ['0.154.0-alpha.6.1', '0.154.0-alpha.6.3', '0.154.0', '0.155.0']) {
      expect(capabilitiesFor('codex', version, { overrides, platform: 'darwin' }).sandbox_workspace_write.status).toBe('supported_unverified');
    }
    expect(capabilitiesFor('codex', '0.154.0-alpha.6.2', { overrides, platform: 'linux' }).sandbox_workspace_write.status).toBe('supported_unverified');
  });
});

describe('version comparison', () => {
  it('orders releases numerically and sorts a prerelease below its release', () => {
    expect(compareVersions('0.147.0', '0.140.0')).toBe(1);
    expect(compareVersions('0.99.0', '0.140.0')).toBe(-1); // not string ordering
    expect(compareVersions('2.1.260', '2.1.260')).toBe(0);
    expect(compareVersions('2.1.0-beta.1', '2.1.0')).toBe(-1);
    expect(compareVersions('not-a-version', '1.0.0')).toBeNull();
    expect(isAtLeast('not-a-version', '1.0.0')).toBe(false);
  });
});
