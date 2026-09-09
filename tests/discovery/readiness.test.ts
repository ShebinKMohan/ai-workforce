/** AT01 — readiness distinguishes missing, installed, adapter-supported, controllable and authentication-unknown, and never reaches verified_ready passively (FR002). */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedOverrides } from '../../src/discovery/capabilities.js';
import { applyLiveCheck, discoverRuntime, discoverRuntimes, READINESS_LEVELS } from '../../src/discovery/readiness.js';
import { fakeClaude, fakeCodex, hangingScript, recordingSpawner, tempDir, writeExecutable } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir('workforce-readiness-');
  roots.push(dir);
  return dir;
}

const NO_KNOWN_LOCATIONS = { knownLocations: [] as string[], timeoutMs: 5_000 };

/**
 * These tests probe fake executables that report a real version string. The
 * repository ships `docs/verified-capabilities.json` with WP03's codex
 * evidence for 0.147.0, which discovery loads by default — so a test about
 * what the *probe* alone establishes must say it wants no overrides.
 */
const NO_OVERRIDES: { overrides: LoadedOverrides } = { overrides: { file: '(none)', present: false, entries: [], diagnostics: [] } };

describe('passive readiness (FR002)', () => {
  it('reports a supported, logged-in installation as controllable — never as verified_ready', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex({ version: '0.147.0', login: 'in' }));

    const report = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS, ...NO_OVERRIDES });

    expect(report.installed).toBe(true);
    expect(report.version).toBe('0.147.0');
    expect(report.adapterSupported).toBe(true);
    expect(report.controllable).toBe(true);
    expect(report.auth).toBe('logged_in');
    expect(report.readiness).toBe('controllable');
    expect(report.probeKind).toBe('passive');
    expect(report.executable).toBe(path.join(bin, 'codex'));
    expect(report.realPath).not.toBeNull();
    // The probe by itself never establishes a capability.
    expect(report.capabilities['structured_execution'].status).toBe('supported_unverified');

    // With the repository's own evidence file loaded, capability statuses do
    // rise — but readiness still stops at controllable, because a recorded
    // adapter test is not a live check of this installation.
    const withEvidence = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS });
    expect(withEvidence.capabilities['structured_execution'].status).toBe('verified');
    expect(withEvidence.capabilities['structured_execution'].source).toBe('override');
    expect(withEvidence.readiness).toBe('controllable');
    expect(withEvidence.probeKind).toBe('passive');
  });

  it('reports a missing runtime as missing, with no probes and no claimed capability', async () => {
    const report = await discoverRuntime('claude-code', { pathValue: scratch(), ...NO_KNOWN_LOCATIONS });

    expect(report.readiness).toBe('missing');
    expect(report.installed).toBe(false);
    expect(report.executable).toBeNull();
    expect(report.probes).toEqual([]);
    expect(report.capabilities['structured_execution'].status).toBe('unsupported');
    expect(report.auth).toBe('unknown');
  });

  it('separates "installed" from "adapter supported" for a version below the minimum', async () => {
    const bin = scratch();
    writeExecutable(bin, 'claude', fakeClaude({ version: '2.0.9' }));

    const report = await discoverRuntime('claude-code', { pathValue: bin, ...NO_KNOWN_LOCATIONS });

    expect(report.installed).toBe(true);
    expect(report.version).toBe('2.0.9');
    expect(report.adapterSupported).toBe(false);
    expect(report.controllable).toBe(false);
    expect(report.readiness).toBe('installed');
    expect(report.diagnostics.join(' ')).toContain('below the supported minimum 2.1.0');
  });

  it('separates authentication-unknown from controllable when the login probe cannot answer', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex({ login: 'in', loginExit: 7 }));

    const report = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS });

    expect(report.controllable).toBe(true);
    expect(report.auth).toBe('unknown');
    expect(report.readiness).toBe('auth_unknown');
  });

  it('reports a logged-out but controllable runtime as controllable with the login it needs', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex({ login: 'out' }));

    const report = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS });

    expect(report.auth).toBe('logged_out');
    expect(report.readiness).toBe('controllable');
    expect(report.diagnostics.join(' ')).toContain('codex login');
  });

  it('tells a user their runtime is signed out when the status command says so while exiting non-zero', async () => {
    const bin = scratch();
    // claude 2.1.260 signed out: `auth status` exits 1 and prints its answer on stdout.
    writeExecutable(bin, 'claude', fakeClaude({ version: '2.1.260', auth: 'json-out', authExit: 1 }));

    const report = await discoverRuntime('claude-code', { pathValue: bin, ...NO_KNOWN_LOCATIONS, ...NO_OVERRIDES });

    expect(report.auth).toBe('logged_out');
    expect(report.readiness).toBe('controllable');
    expect(report.readiness).not.toBe('auth_unknown');
    expect(report.diagnostics.join(' ')).toContain('Claude Code is not logged in; run `claude auth login`');
  });

  it('honours an explicit executable path over the one on PATH', async () => {
    const onPath = scratch();
    const manual = scratch();
    writeExecutable(onPath, 'codex', fakeCodex({ version: '0.147.0' }));
    const override = writeExecutable(manual, 'codex', fakeCodex({ version: '0.141.0' }));

    const report = await discoverRuntime('codex', { override, pathValue: onPath, ...NO_KNOWN_LOCATIONS });

    expect(report.executable).toBe(override);
    expect(report.version).toBe('0.141.0');
    expect(report.installations.filter((i) => i.selected)).toHaveLength(1);
  });

  it('survives a runtime that hangs: the probe is bounded and the runtime is reported, not awaited forever', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', hangingScript(path.join(bin, 'child.pid')));

    const report = await discoverRuntime('codex', { pathValue: bin, knownLocations: [], timeoutMs: 600 });

    expect(report.installed).toBe(true);
    expect(report.version).toBeNull();
    expect(report.adapterSupported).toBe(false);
    expect(report.readiness).toBe('installed');
    expect(report.probes[0]?.timedOut).toBe(true);
  });

  it('never produces verified_ready from passive discovery, whatever the runtimes look like', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex());
    writeExecutable(bin, 'claude', fakeClaude());

    const reports = await discoverRuntimes({ pathValue: bin, ...NO_KNOWN_LOCATIONS });

    expect(reports.map((r) => r.adapter)).toEqual(['codex', 'claude-code']);
    for (const report of reports) {
      expect(report.readiness).not.toBe('verified_ready');
      expect(report.probeKind).toBe('passive');
      expect(READINESS_LEVELS).toContain(report.readiness);
    }
  });

  it('runs only the documented probe commands across a whole discovery pass', async () => {
    const recorder = recordingSpawner((command) => {
      if (command.args[0] === '--version') return { stdout: command.executable.endsWith('claude') ? '2.1.260 (Claude Code)' : 'codex-cli 0.147.0' };
      return { stdout: command.args[0] === 'auth' ? '{"loggedIn": true}' : 'Logged in using ChatGPT' };
    });
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex());
    writeExecutable(bin, 'claude', fakeClaude());

    await discoverRuntimes({ pathValue: bin, knownLocations: [], spawner: recorder.spawner });

    expect(recorder.calls.map((c) => c.args)).toEqual([['--version'], ['login', 'status'], ['--version'], ['auth', 'status']]);
    for (const call of recorder.calls) {
      expect(call.args.join(' ')).not.toMatch(/-p\b|--print|exec|--output-format/);
    }
  });
});

describe('verified_ready comes only from an explicit live check', () => {
  it('upgrades a controllable, logged-in runtime and records the evidence', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex());
    const passive = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS });

    const live = applyLiveCheck(passive, { ok: true, evidence: 'session s-1 streamed events and was interrupted' });

    expect(live.readiness).toBe('verified_ready');
    expect(live.probeKind).toBe('live');
    expect(live.diagnostics.join(' ')).toContain('session s-1');
  });

  it('refuses to upgrade a runtime whose login state is unknown, or one whose live check failed', async () => {
    const bin = scratch();
    writeExecutable(bin, 'codex', fakeCodex({ login: 'in', loginExit: 3 }));
    const unknownAuth = await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS });

    const attempted = applyLiveCheck(unknownAuth, { ok: true, evidence: 'session s-2 looked fine' });
    expect(attempted.readiness).toBe('auth_unknown');
    expect(attempted.diagnostics.join(' ')).toContain('verified_ready needs an observed login');

    const other = scratch();
    writeExecutable(other, 'codex', fakeCodex({ version: '0.100.0' }));
    const tooOld = await discoverRuntime('codex', { pathValue: other, ...NO_KNOWN_LOCATIONS });
    expect(applyLiveCheck(tooOld, { ok: true, evidence: 'ignored' }).readiness).toBe('installed');

    const failed = applyLiveCheck(await discoverRuntime('codex', { pathValue: bin, ...NO_KNOWN_LOCATIONS }), { ok: false, evidence: 'the session never emitted a result' });
    expect(failed.readiness).not.toBe('verified_ready');
    expect(failed.diagnostics.join(' ')).toContain('live check failed');
  });
});
