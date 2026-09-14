import { describe, expect, it } from 'vitest';
import { capabilityWasTestedOn, type CapabilityReport, type RuntimeAdapter } from '../../src/adapters/types.js';
import { assessContainment } from '../../src/core/run-direct.js';
import { CodexAdapter } from '../../src/adapters/codex/adapter.js';

const report: CapabilityReport = { status: 'verified', testedVersion: '1.0.0', testedVersions: ['1.2.0-alpha.2'], os: process.platform, note: 'Exact fixture evidence for two builds.' };
const adapter = { capabilities: () => ({ capabilities: { write_containment: report } }) } as unknown as RuntimeAdapter;

describe('capability evidence matches exact builds and operating systems', () => {
  it('confines the separately tested stable Codex CLI without extending the claim to other builds or queued delivery', () => {
    const codex = new CodexAdapter();
    const capabilities = codex.capabilities().capabilities;
    expect(capabilityWasTestedOn(capabilities.write_containment, '0.154.0', 'darwin')).toBe(true);
    expect(capabilityWasTestedOn(capabilities.coordination_bridge, '0.154.0', 'darwin')).toBe(true);
    expect(capabilityWasTestedOn(capabilities.write_containment, '0.154.1', 'darwin')).toBe(false);
    expect(capabilityWasTestedOn(capabilities.write_containment, '0.154.0', 'linux')).toBe(false);
    expect(capabilityWasTestedOn(capabilities.queued_delivery, '0.154.0', 'darwin')).toBe(false);
    expect(capabilityWasTestedOn(capabilities.write_containment, '0.147.0', 'darwin')).toBe(true);
    expect(capabilityWasTestedOn(capabilities.write_containment, '0.154.0-alpha.6.2', 'darwin')).toBe(true);
  });

  it('retains the legacy tested build and accepts a separately recorded build', () => {
    expect(capabilityWasTestedOn(report, '1.0.0')).toBe(true);
    expect(capabilityWasTestedOn(report, '1.2.0-alpha.2')).toBe(true);
    expect(capabilityWasTestedOn({ ...report, testedVersions: [] }, '1.0.0')).toBe(true);
  });

  it('refuses missing, adjacent, release and other-platform versions', () => {
    for (const version of [null, undefined, '1.2.0-alpha.1', '1.2.0-alpha.3', '1.2.0', '1.0.0+changed']) expect(capabilityWasTestedOn(report, version)).toBe(false);
    expect(capabilityWasTestedOn({ ...report, os: 'darwin' }, '1.2.0-alpha.2', 'linux')).toBe(false);
    expect(capabilityWasTestedOn({ ...report, os: null }, '1.0.0')).toBe(false);
  });

  it('records the matching build for an execution while preserving the adapter baseline', () => {
    for (const version of ['1.0.0', '1.2.0-alpha.2']) {
      expect(assessContainment(adapter, 'local-development', false, version)).toMatchObject({ testedVersion: version, installedVersion: version, untestedVersion: false, unconfinedWrites: false, acknowledged: false });
    }
    expect(report.testedVersion).toBe('1.0.0');
    expect(assessContainment(adapter, 'local-development', false, '1.2.0-alpha.3')).toMatchObject({ testedVersion: '1.0.0', untestedVersion: true, acknowledged: false });
  });

  it('does not turn unsupported containment into confinement merely because its version is recorded', () => {
    const unsupported = { capabilities: () => ({ capabilities: { write_containment: { ...report, status: 'unsupported' } } }) } as unknown as RuntimeAdapter;
    expect(assessContainment(unsupported, 'local-development', false, '1.2.0-alpha.2')).toMatchObject({ status: 'unsupported', unconfinedWrites: true, acknowledged: false });
  });
});
