import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceRuntimes, readinessReportForRuntime } from '../../src/discovery/readiness.js';
import { workspaceReadiness } from '../../src/core/workspace-config.js';
import { toolFacts } from '../../src/workspace/readiness.js';
import { sampleWorkspace } from '../workspace/helpers.js';
import { fakeCodex, tempDir, writeExecutable } from './helpers.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string { const root = tempDir('workforce-bindings-'); roots.push(root); return root; }
const options = { adapters: ['codex'] as const, knownLocations: [] as string[], timeoutMs: 5_000 };

describe('configured runtime discovery', () => {
  it('does not lend a healthy PATH installation to a missing override or a signed-out custom command', async () => {
    const bin = scratch();
    const log = path.join(bin, 'probes.log');
    const standard = writeExecutable(bin, 'codex', fakeCodex({ argvLog: log }));
    const custom = writeExecutable(bin, 'codex-work', fakeCodex({ version: '0.148.0', login: 'out' }));
    const runtimes = {
      'codex-local': { adapter: 'codex' as const, executable: 'codex' },
      missing: { adapter: 'codex' as const, executable: path.join(bin, 'gone') },
      work: { adapter: 'codex' as const, executable: 'codex-work' },
      duplicate: { adapter: 'codex' as const, executable: 'codex' },
    };
    const reports = await discoverWorkspaceRuntimes(runtimes, { ...options, pathValue: bin });
    expect(readinessReportForRuntime(reports, 'codex-local', runtimes['codex-local'])).toMatchObject({ executable: standard, auth: 'logged_in' });
    expect(readinessReportForRuntime(reports, 'missing', runtimes.missing)).toMatchObject({ installed: false, executable: null, probes: [] });
    expect(readinessReportForRuntime(reports, 'work', runtimes.work)).toMatchObject({ executable: custom, version: '0.148.0', auth: 'logged_out' });
    // Multiple aliases to the same binding do not repeat passive probes, and no inference is run.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--version', 'login status']);
    expect(reports.every((report) => report.probeKind === 'passive')).toBe(true);

    const config = sampleWorkspace();
    config.runtimes['codex-local'] = runtimes.missing;
    const missingBindingReports = await discoverWorkspaceRuntimes(config.runtimes, { ...options, pathValue: bin });
    const readiness = workspaceReadiness(config, { tools: toolFacts(missingBindingReports), projectCheckCounts: { checkout: 1, billing: 1 } });
    expect(readiness.eligibility.find((pair) => pair.departmentId === 'engineering-platform' && pair.projectId === 'checkout')).toMatchObject({ sendable: false, codes: ['runtime_not_ready'] });
  });

  it('rejects stale binding evidence after an executable edit and supports adapter-only defaults', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex());
    const runtime = { adapter: 'codex' as const, executable: 'codex' };
    const reports = await discoverWorkspaceRuntimes({ local: runtime }, { ...options, pathValue: bin });
    expect(readinessReportForRuntime(reports, 'local', { ...runtime, executable: '/missing/codex' })).toBeUndefined();
    const global = reports.filter((report) => report.runtimeId === undefined);
    expect(readinessReportForRuntime(global, 'legacy', runtime)?.auth).toBe('logged_in');
    expect(readinessReportForRuntime(global, 'legacy', { ...runtime, executable: 'codex-other' })).toBeUndefined();
  });

  it('reports known-location installations separately from a bare command that cannot spawn on PATH', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex());
    const runtime = { adapter: 'codex' as const, executable: 'codex' };
    const reports = await discoverWorkspaceRuntimes({ local: runtime }, { ...options, pathValue: scratch(), knownLocations: [bin] });
    expect(reports.find((report) => report.runtimeId === undefined)?.installed).toBe(true);
    expect(readinessReportForRuntime(reports, 'local', runtime)?.installed).toBe(false);
  });
});
