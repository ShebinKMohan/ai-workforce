/** AT01 — bounded probes: version and login parsing, timeouts that kill the process group, and argv that can never carry a prompt (FR002). */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive } from '../../src/core/process.js';
import { parseAuthStatus, parseVersionOutput, probeRuntime } from '../../src/discovery/probe.js';
import { DiscoveryError } from '../../src/discovery/runtimes.js';
import { assertDocumentedProbeArgv, nodeProbeSpawner, sanitizedProbeEnv, type ProbeResult } from '../../src/discovery/spawn.js';
import { environmentScript, fakeClaude, fakeCodex, hangingScript, recordingSpawner, tempDir, waitUntil, writeExecutable } from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = tempDir('workforce-probe-test-');
  roots.push(dir);
  return dir;
}

function probeResult(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    command: { executable: 'x', args: [], cwd: '/tmp', env: {}, timeoutMs: 1_000 },
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    pid: 1,
    durationMs: 1,
    ...overrides,
  };
}

describe('version probes read the installed executable', () => {
  it('parses the real version formats of both runtimes', async () => {
    const root = scratch();
    const codex = writeExecutable(root, 'codex', fakeCodex({ version: '0.147.0' }));
    const claude = writeExecutable(root, 'claude', fakeClaude({ version: '2.1.260' }));

    const codexProbe = await probeRuntime('codex', codex, { timeoutMs: 5_000 });
    expect(codexProbe.version).toBe('0.147.0');
    expect(codexProbe.versionLine).toBe('codex-cli 0.147.0');

    const claudeProbe = await probeRuntime('claude-code', claude, { timeoutMs: 5_000 });
    expect(claudeProbe.version).toBe('2.1.260');
    expect(claudeProbe.versionLine).toBe('2.1.260 (Claude Code)');
  });

  it('reports an unreadable version as null with the line it could not parse', async () => {
    const root = scratch();
    const bad = writeExecutable(root, 'codex', '#!/bin/sh\necho "some other tool 1.2.3"\nexit 0\n');

    const probe = await probeRuntime('codex', bad, { timeoutMs: 5_000, skipAuth: true });

    expect(probe.version).toBeNull();
    expect(probe.diagnostics.join(' ')).toContain('some other tool 1.2.3');
    expect(probe.diagnostics.join(' ')).toContain('codex-cli 0.147.0'); // the expected shape is shown
  });

  it('reports a missing executable as a spawn error instead of throwing', async () => {
    const probe = await probeRuntime('codex', path.join(scratch(), 'not-there'), { timeoutMs: 2_000 });

    expect(probe.version).toBeNull();
    expect(probe.probes).toHaveLength(1); // the login probe is not attempted
    expect(probe.auth).toBe('unknown');
    expect(probe.diagnostics.join(' ')).toMatch(/could not be started/);
  });
});

describe('a probe is bounded and takes its whole process group with it', () => {
  it('kills a hanging probe and the child it started, and reports the timeout', async () => {
    const root = scratch();
    const pidFile = path.join(root, 'child.pid');
    const hanging = writeExecutable(root, 'codex', hangingScript(pidFile));

    // Long enough that the script reliably reaches `echo $! > pidFile` even on
    // a loaded machine — a probe killed before its child exists would test
    // nothing about process groups — and still far below the bound asserted here.
    const started = Date.now();
    const probe = await probeRuntime('codex', hanging, { timeoutMs: 3_000 });
    const elapsed = Date.now() - started;

    const record = probe.probes[0]!;
    expect(record.timedOut).toBe(true);
    expect(probe.version).toBeNull();
    expect(probe.diagnostics.join(' ')).toContain('process group was terminated');
    expect(elapsed).toBeLessThan(10_000); // the deadline is enforced, not merely recorded

    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isFinite(grandchild)).toBe(true);
    // The `sleep` the script started is a separate process: it survives only if we killed the direct child alone.
    expect(await waitUntil(() => !isProcessAlive(grandchild))).toBe(true);
  });

  it('never lets a timed-out login probe become a login', async () => {
    const observation = parseAuthStatus('codex', probeResult({ timedOut: true, exitCode: null, stdout: 'Logged in using ChatGPT' }));
    expect(observation.auth).toBe('unknown');
    expect(observation.detail).toContain('did not answer');
  });
});

describe('login visibility uses the documented commands only', () => {
  it('reads both documented codex login states', async () => {
    const root = scratch();
    const loggedIn = writeExecutable(path.join(root, 'in'), 'codex', fakeCodex({ login: 'in' }));
    const loggedOut = writeExecutable(path.join(root, 'out'), 'codex', fakeCodex({ login: 'out' }));

    expect((await probeRuntime('codex', loggedIn, { timeoutMs: 5_000 })).auth).toBe('logged_in');
    const out = await probeRuntime('codex', loggedOut, { timeoutMs: 5_000 });
    expect(out.auth).toBe('logged_out');
    expect(out.diagnostics.join(' ')).toContain('codex login');
  });

  it('reads the claude JSON shape and the --text shape', async () => {
    const root = scratch();
    const json = writeExecutable(path.join(root, 'json'), 'claude', fakeClaude({ auth: 'json-in' }));
    const jsonOut = writeExecutable(path.join(root, 'json-out'), 'claude', fakeClaude({ auth: 'json-out' }));
    const text = writeExecutable(path.join(root, 'text'), 'claude', fakeClaude({ auth: 'text-in' }));
    const textOut = writeExecutable(path.join(root, 'text-out'), 'claude', fakeClaude({ auth: 'text-out' }));

    expect((await probeRuntime('claude-code', json, { timeoutMs: 5_000 })).auth).toBe('logged_in');
    expect((await probeRuntime('claude-code', jsonOut, { timeoutMs: 5_000 })).auth).toBe('logged_out');
    expect((await probeRuntime('claude-code', text, { timeoutMs: 5_000 })).auth).toBe('logged_in');
    expect((await probeRuntime('claude-code', textOut, { timeoutMs: 5_000 })).auth).toBe('logged_out');
  });

  it('recognizes the installed Codex signed-out stderr line without trusting crash diagnostics', () => {
    expect(parseAuthStatus('codex', probeResult({ exitCode: 1, stderr: 'Not logged in\n' })).auth).toBe('logged_out');
    for (const result of [
      probeResult({ exitCode: 101, stderr: 'Not logged in\n' }),
      probeResult({ exitCode: 1, stderr: 'Proxy failed: Not logged in\n' }),
      probeResult({ exitCode: 1, stdout: 'panic', stderr: 'Not logged in\n' }),
      probeResult({ exitCode: 1, timedOut: true, stderr: 'Not logged in\n' }),
    ]) expect(parseAuthStatus('codex', result).auth).toBe('unknown');
  });

  it('maps a non-zero exit and unrecognised output to unknown, never to a ready state', async () => {
    const root = scratch();
    const failing = writeExecutable(path.join(root, 'fail'), 'codex', fakeCodex({ login: 'in', loginExit: 1 }));
    const garbage = writeExecutable(path.join(root, 'garbage'), 'codex', fakeCodex({ login: 'garbage' }));

    const failed = await probeRuntime('codex', failing, { timeoutMs: 5_000 });
    expect(failed.auth).toBe('unknown');
    expect(failed.authDetail).toContain('exited 1');

    expect((await probeRuntime('codex', garbage, { timeoutMs: 5_000 })).auth).toBe('unknown');
  });

  it('reads the answer a login command gives while exiting non-zero, instead of discarding it', async () => {
    const root = scratch();
    // Exactly what claude 2.1.260 does when signed out: exit 1, a complete
    // JSON answer on stdout, nothing on stderr.
    const signedOut = writeExecutable(path.join(root, 'signed-out'), 'claude', fakeClaude({ auth: 'json-out', authExit: 1 }));

    const probe = await probeRuntime('claude-code', signedOut, { timeoutMs: 5_000 });

    expect(probe.auth).toBe('logged_out');
    expect(probe.authDetail).toContain('loggedIn=false');
    // The whole point of reading it: the user is told what to do about it.
    expect(probe.diagnostics.join(' ')).toContain('claude auth login');
    expect(probe.diagnostics.join(' ')).not.toContain('login state is not established');
    expect(probe.diagnostics.join(' ')).not.toContain('authentication status is unknown');
  });

  it('reads a signed-out statement whatever the exit code, and a claimed login only from a clean exit', () => {
    for (const exitCode of [0, 1, 7]) {
      expect(parseAuthStatus('claude-code', probeResult({ exitCode, stdout: '{"loggedIn": false, "authMethod": "none"}' })).auth).toBe('logged_out');
      expect(parseAuthStatus('codex', probeResult({ exitCode, stdout: 'Not logged in' })).auth).toBe('logged_out');
    }

    // The dangerous direction. A command that failed may never be read as a
    // login, however cheerful its output: reporting logged_in for a runtime
    // that cannot spend a credential is the false readiness claim this
    // coordinator exists to prevent.
    for (const failing of [
      probeResult({ exitCode: 1, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' }),
      probeResult({ exitCode: null, signal: 'SIGKILL', stdout: '{"loggedIn": true}' }),
      probeResult({ exitCode: 1, spawnError: 'spawn ENOENT', stdout: '{"loggedIn": true}' }),
      probeResult({ exitCode: null, timedOut: true, stdout: '{"loggedIn": true}' }),
    ]) {
      expect(parseAuthStatus('claude-code', failing).auth).toBe('unknown');
    }
    expect(parseAuthStatus('codex', probeResult({ exitCode: 1, stdout: 'Logged in using ChatGPT' })).auth).toBe('unknown');
  });

  it('does not read a crash whose wording happens to say "not logged in" as a signed-out answer', async () => {
    const root = scratch();
    // Two identical failures of the same command, differing only in wording.
    // A substring match is the whole of the free-text reading, so if the exit
    // code is not consulted the pair gets opposite verdicts — one confident
    // "not logged in", one honest "unknown" — from the same kind of crash.
    const proxy = writeExecutable(path.join(root, 'proxy'), 'claude', fakeClaude({ auth: 'crash-out', authExit: 70 }));
    const eacces = writeExecutable(path.join(root, 'eacces'), 'claude', fakeClaude({ auth: 'crash-eacces', authExit: 70 }));

    const proxyProbe = await probeRuntime('claude-code', proxy, { timeoutMs: 5_000 });
    const eaccesProbe = await probeRuntime('claude-code', eacces, { timeoutMs: 5_000 });

    expect(proxyProbe.auth).toBe('unknown');
    expect(proxyProbe.auth).toBe(eaccesProbe.auth);
    // ... and the crash is reported rather than replaced by login advice.
    expect(proxyProbe.diagnostics.join(' ')).toContain('authentication status is unknown');
    expect(proxyProbe.diagnostics.join(' ')).not.toContain('is not logged in; run');

    // Same for codex, whose free text is its only signed-out reading: a panic
    // on stderr naming a credentials directory is a failure, not an answer.
    const panicking = writeExecutable(path.join(root, 'codex'), 'codex', fakeCodex({ login: 'panic-out', loginExit: 101 }));
    const codexProbe = await probeRuntime('codex', panicking, { timeoutMs: 5_000 });
    expect(codexProbe.auth).toBe('unknown');
    expect(codexProbe.diagnostics.join(' ')).toContain('authentication status is unknown');
    expect(codexProbe.diagnostics.join(' ')).not.toContain('is not logged in; run');

    // The signed-out answer a working runtime actually gives still lands, on
    // stdout, whatever the exit code — that is what this gate must not break.
    const signedOut = writeExecutable(path.join(root, 'out'), 'codex', fakeCodex({ login: 'out', loginExit: 1 }));
    expect((await probeRuntime('codex', signedOut, { timeoutMs: 5_000 })).auth).toBe('logged_out');
  });

  it('keeps a probe that genuinely failed to answer at unknown', async () => {
    const root = scratch();
    const silent = writeExecutable(path.join(root, 'silent'), 'claude', fakeClaude({ auth: 'garbage', authExit: 1 }));

    const probe = await probeRuntime('claude-code', silent, { timeoutMs: 5_000 });
    expect(probe.auth).toBe('unknown');
    expect(probe.authDetail).toContain('exited 1');

    // Empty output, a signal death and a spawn failure are failures too, not answers.
    expect(parseAuthStatus('claude-code', probeResult({ exitCode: 1, stdout: '', stderr: '' })).auth).toBe('unknown');
    expect(parseAuthStatus('claude-code', probeResult({ exitCode: 1, stdout: '{"loggedIn": "maybe"}' })).auth).toBe('unknown');
    expect(parseAuthStatus('claude-code', probeResult({ exitCode: null, signal: 'SIGSEGV', stdout: 'noise' })).auth).toBe('unknown');
    expect(parseAuthStatus('claude-code', probeResult({ exitCode: null, spawnError: 'spawn EACCES' })).detail).toContain('could not be started');
  });

  it('never carries the account details the login command prints into the report', async () => {
    const root = scratch();
    const claude = writeExecutable(root, 'claude', fakeClaude({ auth: 'json-in', email: 'private.person@example.com' }));

    const probe = await probeRuntime('claude-code', claude, { timeoutMs: 5_000 });

    expect(probe.auth).toBe('logged_in');
    expect(JSON.stringify(probe)).not.toContain('private.person@example.com');
    expect(JSON.stringify(probe)).not.toContain('Example Org');
  });
});

describe('a passive probe can never start a model turn', () => {
  it('runs only the documented flags for every adapter', async () => {
    const codexRecorder = recordingSpawner((command) => (command.args[0] === '--version' ? { stdout: 'codex-cli 0.147.0' } : { stdout: 'Logged in using ChatGPT' }));
    await probeRuntime('codex', '/anywhere/codex', { spawner: codexRecorder.spawner });
    expect(codexRecorder.calls.map((c) => c.args)).toEqual([['--version'], ['login', 'status']]);

    const claudeRecorder = recordingSpawner((command) => (command.args[0] === '--version' ? { stdout: '2.1.260 (Claude Code)' } : { stdout: '{"loggedIn": true}' }));
    await probeRuntime('claude-code', '/anywhere/claude', { spawner: claudeRecorder.spawner });
    expect(claudeRecorder.calls.map((c) => c.args)).toEqual([['--version'], ['auth', 'status']]);

    const everyArgument = [...codexRecorder.calls, ...claudeRecorder.calls].flatMap((c) => c.args);
    for (const forbidden of ['-p', '--print', 'exec', '--prompt', 'fix the bug', '--output-format']) {
      expect(everyArgument).not.toContain(forbidden);
    }
  });

  it('refuses to build any probe command that is not one of the documented flag sets', () => {
    expect(() => assertDocumentedProbeArgv('codex', ['--version'])).not.toThrow();
    expect(() => assertDocumentedProbeArgv('claude-code', ['auth', 'status'])).not.toThrow();

    for (const argv of [['exec', 'fix the bug'], ['-p', 'hello'], ['--version', 'extra'], ['login'], []]) {
      expect(() => assertDocumentedProbeArgv('codex', argv)).toThrow(DiscoveryError);
    }
    expect(() => assertDocumentedProbeArgv('claude-code', ['-p', 'summarise this repository'])).toThrow(/passive discovery may only run/);
  });

  it('runs in a neutral temporary directory with a sanitized environment that carries no provider credentials', async () => {
    const root = scratch();
    const script = writeExecutable(root, 'codex', environmentScript());
    const env = sanitizedProbeEnv({ ...process.env, ANTHROPIC_API_KEY: 'sk-ant-must-not-leak', OPENAI_API_KEY: 'sk-openai-must-not-leak', CODEX_ACCESS_TOKEN: 'token-must-not-leak' });

    const result = await nodeProbeSpawner({ executable: script, args: ['--version'], cwd: root, env, timeoutMs: 5_000 });

    expect(result.stdout).not.toContain('must-not-leak');
    expect(result.stdout).toContain('TERM=dumb');
    expect(result.stdout).toContain('HOME=');
  });

  it('probes from a scratch directory that is not the caller\'s working directory, and removes it afterwards', async () => {
    const root = scratch();
    const script = writeExecutable(root, 'codex', environmentScript());
    let observedCwd = '';

    const recorder = recordingSpawner((command) => {
      observedCwd = command.cwd;
      return command.args[0] === '--version' ? { stdout: 'codex-cli 0.147.0' } : { stdout: 'Logged in using ChatGPT' };
    });
    await probeRuntime('codex', script, { spawner: recorder.spawner });

    expect(observedCwd).not.toBe(process.cwd());
    expect(path.basename(observedCwd)).toMatch(/^workforce-probe-/);
    expect(existsSync(observedCwd)).toBe(false); // the neutral directory does not survive the probe
  });
});

describe('version output parsing', () => {
  it('accepts the exact shapes the installed executables print and rejects anything else', () => {
    expect(parseVersionOutput('codex', 'codex-cli 0.147.0')).toBe('0.147.0');
    expect(parseVersionOutput('codex', 'codex-cli v0.147.0-alpha.1')).toBe('0.147.0-alpha.1');
    expect(parseVersionOutput('codex', '0.147.0')).toBeNull();
    expect(parseVersionOutput('claude-code', '2.1.260 (Claude Code)')).toBe('2.1.260');
    expect(parseVersionOutput('claude-code', '2.1.260')).toBeNull();
  });
});
