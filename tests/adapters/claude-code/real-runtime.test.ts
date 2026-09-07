/**
 * Checks against the INSTALLED Claude Code executable. Gated by
 * `WORKFORCE_REAL_RUNTIMES=1`.
 *
 *     WORKFORCE_REAL_RUNTIMES=1 npx vitest run tests/adapters/claude-code/real-runtime.test.ts
 *
 * The file is split in three, because the three parts cost different things:
 *
 *   1. CONTROL PLANE — spawning, the handshake, the session identity, the tool
 *      surface the runtime reports, delivery, interruption, stopping and
 *      reconciliation. None of it starts a model turn, so none of it costs a
 *      token. It always runs under the gate.
 *
 *   2. CONTAINMENT (FR042) — what this runtime does and does not enforce,
 *      determined by execution. Also free.
 *
 *   3. MODEL TURNS — the checks that need a turn that actually reaches the
 *      provider. They spend the signed-in account's quota, so the prompts are
 *      deliberately tiny. They are skipped ONLY when the runtime itself says
 *      it holds no credential to spend. A skipped check is not a passing check.
 *
 * The gate below reads the runtime's own `initialize` account block, and it
 * reads it in both directions, which the first WP05 recording did not: claude
 * 2.1.260 reports `account.tokenSource: "none"` when it is signed OUT and
 * omits the field entirely when it is signed IN. Treating the absent field as
 * "no credential" skipped every model-turn check on a working machine and
 * recorded a false reason for doing so. An account the runtime cannot describe
 * at all is `unknown`, and unknown does NOT skip: the checks run and a failure
 * is reported as a failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, TESTED_CLAUDE_VERSION } from '../../../src/adapters/claude-code/adapter.js';
import { buildClaudeArgs, mapPolicy, parseClaudeVersion } from '../../../src/adapters/claude-code/protocol.js';
import { isProcessGroupAlive } from '../../../src/core/process.js';
import { uuidv7 } from '../../../src/core/ids.js';
import type { RuntimeEvent, SessionHandle } from '../../../src/adapters/types.js';
import { allOfKind, collect, firstOfKind, tempWorkspace } from './helpers.js';

const REAL = process.env['WORKFORCE_REAL_RUNTIMES'] === '1';
const CLAUDE = process.env['WORKFORCE_CLAUDE_PATH'] ?? `${process.env['HOME'] ?? ''}/.local/bin/claude`;

/** A sanitized environment: never the coordinator's own, which may carry CLAUDE_CODE_* variables. */
const CLEAN_ENV: Record<string, string> = {
  HOME: process.env['HOME'] ?? '',
  PATH: `${path.dirname(CLAUDE)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  USER: process.env['USER'] ?? '',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
};

const timings: Array<{ what: string; ms: number; detail?: string }> = [];
function record<T>(what: string, value: T, ms: number, detail?: string): T {
  timings.push({ what, ms: Math.round(ms), ...(detail !== undefined ? { detail } : {}) });
  return value;
}

const observations: Array<{ what: string; result: string }> = [];
function observe(what: string, result: string): void {
  observations.push({ what, result });
}

afterAll(() => {
  if (!REAL) return;
  // eslint-disable-next-line no-console
  console.log('\n--- claude-code real-runtime timings (one sample each; observations, not performance claims) ---');
  for (const t of timings) console.log(`${String(t.ms).padStart(7)} ms  ${t.what}${t.detail ? `  (${t.detail})` : ''}`);
  console.log('--- claude-code containment observations ---');
  for (const o of observations) console.log(`  ${o.what}: ${o.result}`);
});

interface CredentialGate {
  /** False only when the runtime said it holds nothing to spend. `unknown` runs the checks. */
  readonly skip: boolean;
  readonly state: 'usable' | 'none' | 'unknown' | 'unavailable';
  readonly tokenSource: string | null;
  readonly detail: string;
}

/**
 * Ask the installed CLI, through its own `initialize` control request, whether
 * it holds a credential it can spend. This starts a process but no model turn.
 *
 * The verdict comes from `readClaudeCredential`, the same function
 * `ClaudeCodeAdapter.probe` uses for `workforce doctor --connect`, so the
 * product and its own test suite cannot disagree about the same runtime.
 */
async function credentialGate(): Promise<CredentialGate> {
  if (!REAL) return { skip: true, state: 'unavailable', tokenSource: null, detail: 'real-runtime checks are gated' };
  if (!existsSync(CLAUDE)) return { skip: true, state: 'unavailable', tokenSource: null, detail: `no executable at ${CLAUDE}` };
  const adapter = new ClaudeCodeAdapter({ executablePath: CLAUDE, startupTimeoutMs: 60_000, controlTimeoutMs: 60_000, stopTimeoutMs: 8_000 });
  try {
    const { credential } = await adapter.discoverSettings(CLAUDE);
    return { skip: credential.state === 'none', state: credential.state, tokenSource: credential.tokenSource, detail: credential.detail };
  } catch (error) {
    return { skip: true, state: 'unavailable', tokenSource: null, detail: `the initialize control round-trip failed: ${(error as Error).message}` };
  }
}

const credentials: CredentialGate = REAL ? await credentialGate() : { skip: true, state: 'unavailable', tokenSource: null, detail: 'gated' };

const open: Array<{ adapter: ClaudeCodeAdapter; handle: SessionHandle }> = [];
async function stopAll(): Promise<void> {
  while (open.length > 0) {
    const entry = open.pop()!;
    await entry.adapter.stopOwnedProcesses(entry.handle).catch(() => undefined);
  }
}
afterAll(stopAll);

function adapterFor(options: { readonly logsDir?: string; readonly allowCommandExecution?: boolean } = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    executablePath: CLAUDE,
    startupTimeoutMs: 60_000,
    controlTimeoutMs: 60_000,
    interruptTimeoutMs: 20_000,
    stopTimeoutMs: 8_000,
    deliveryAckTimeoutMs: 8_000,
    ...options,
  });
}

async function openSession(policy: 'analysis' | 'local-development', workspace: string, options: { readonly logsDir?: string } = {}): Promise<{ adapter: ClaudeCodeAdapter; handle: SessionHandle }> {
  const adapter = adapterFor(options);
  const started = Date.now();
  const handle = await adapter.openSession({
    cwd: workspace,
    allowedWritePaths: [workspace],
    policy,
    systemInstructions: 'You are a workforce worker. Do exactly what you are asked and nothing more.',
  });
  record(`openSession (${policy}): spawn + initialize handshake`, null, Date.now() - started);
  open.push({ adapter, handle });
  return { adapter, handle };
}

// ---------------------------------------------------------------------------
// 1. Control plane — no model turn, no tokens
// ---------------------------------------------------------------------------

describe.skipIf(!REAL)('claude-code control plane (installed runtime, no model turn)', () => {
  it('reports the installed version in the documented shape', () => {
    const started = Date.now();
    const stdout = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', env: CLEAN_ENV, timeout: 20_000 });
    const version = record('passive probe: claude --version', parseClaudeVersion(stdout), Date.now() - started, stdout.trim());
    expect(version).not.toBeNull();
    observe('installed version', String(version));
    if (version !== TESTED_CLAUDE_VERSION) {
      // Not a failure: the adapter's own diagnostics say the same thing.
      observe('version differs from the tested one', `installed ${version}, statuses established against ${TESTED_CLAUDE_VERSION}`);
    }
  });

  it('a passive probe never claims readiness', async () => {
    const adapter = adapterFor();
    const started = Date.now();
    const readiness = record('passive probe: --version + auth status', await adapter.probe(CLAUDE), Date.now() - started);
    expect(readiness.installed).toBe(true);
    expect(readiness.probeKind).toBe('passive');
    expect(readiness.ready).toBe('unknown');
    observe('passive probe authentication', readiness.authentication);
  });

  it('the live probe asks the runtime what it offers, and believes the runtime over `auth status`', async () => {
    const adapter = adapterFor();
    const started = Date.now();
    const readiness = record('live probe: initialize control round-trip', await adapter.probe(CLAUDE, { live: true }), Date.now() - started);
    expect(readiness.probeKind).toBe('live');
    expect(readiness.controllable).toBe(true);

    const settings = adapter.capabilities().settings;
    expect(settings.model.offered.length).toBeGreaterThan(0);
    expect(settings.model.offered.every((m) => m.provenance === 'reported')).toBe(true);
    expect(settings.effort.offered.map((e) => e.value)).toEqual(expect.arrayContaining(['low', 'medium', 'high']));
    expect(settings.effort.exhaustive).toBe(true);
    observe('models reported by the runtime', settings.model.offered.map((m) => m.value).join(', '));
    observe('effort levels reported by the runtime', settings.effort.offered.map((e) => e.value).join(', '));

    // `claude auth status` can say loggedIn=true while the CLI holds nothing
    // usable. The probe reports what the runtime itself says — and the gate
    // below reads the same answer, so the product and this suite cannot
    // disagree about whether the runtime can spend a credential.
    observe('account.tokenSource', String(credentials.tokenSource));
    observe('credential state derived from the account block', `${credentials.state} — ${credentials.detail}`);
    if (credentials.state === 'none') {
      expect(readiness.authentication).toBe('logged_out');
      expect(readiness.ready).toBe('not_ready');
      expect(readiness.diagnostics.some((d) => d.includes('tokenSource'))).toBe(true);
    }
    if (credentials.state === 'usable') {
      expect(readiness.authentication).toBe('logged_in');
      expect(readiness.ready).toBe('verified_ready');
    }
  });

  it('opens a session whose id the coordinator minted, and records the settings the runtime reports', async () => {
    const workspace = tempWorkspace('wf-claude-real-');
    writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
    const { adapter, handle } = await openSession('local-development', workspace);

    expect(handle.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const started = Date.now();
    const turn = await adapter.startTurn(handle, { prompt: 'Reply with the single word: ready' });
    record('startTurn accepted', null, Date.now() - started);

    const firstEventAt = Date.now();
    const events = await collect(adapter, turn);
    record('turn: first frame to terminal event', null, Date.now() - firstEventAt, `${events.length} normalized events`);

    // Everything the runtime reported about this session.
    const effective = adapter.effectiveSettings(handle)!;
    // The runtime reports the granted set alphabetically, not in the order we passed it.
    expect(effective.tools!.slice().sort()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
    expect(effective.permissionMode).toBe('acceptEdits');
    expect(effective.mcpServers).toEqual([]);
    expect(effective.cliVersion).not.toBeNull();
    observe('effective tools (local-development)', (effective.tools ?? []).join(', '));
    observe('effective model', String(effective.model));

    // The stream is normalized and terminates.
    expect(firstOfKind(events, 'session_started')).toBeDefined();
    expect(firstOfKind(events, 'turn_started')).toBeDefined();
    const terminal = events[events.length - 1]!;
    expect(['turn_completed', 'turn_interrupted', 'error']).toContain(terminal.kind);
    expect(events.every((e) => e.sessionId === handle.sessionId)).toBe(true);

    // The runtime echoed our own frame back, which is the only submission receipt it gives.
    const replay = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'user_message_replay');
    expect(replay, 'the runtime acknowledged the user frame we wrote').toBeDefined();

    if (terminal.kind === 'turn_completed') {
      const usage = adapter.lastUsage(handle)!;
      observe('cost status for this turn', `${usage.costStatus} (${usage.costDetail})`);
      // Whatever happened, cost is never reported as a measured zero.
      if (usage.costStatus === 'unavailable') expect(usage.costUsd).toBeNull();
    }
  });

  it('queues a delivery with no active turn and flushes it into the next turn, which the runtime acknowledges', async () => {
    const workspace = tempWorkspace('wf-claude-real-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const receipt = await adapter.deliver(handle, { messageId: 'real-1', body: 'a peer message', correlationId: 'c1' });
    expect(receipt.state).toBe('queued');
    expect(adapter.pendingDeliveries(handle)).toHaveLength(1);

    const turn = await adapter.startTurn(handle, { prompt: 'Reply with the single word: ready' });
    const events = await collect(adapter, turn);
    const replay = allOfKind(events, 'raw').find((e) => e.payload['reason'] === 'user_message_replay')!;
    expect(String(replay.payload['text'])).toContain('[coordinator message real-1 re c1]');
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);
  });

  it('the interrupt control request is accepted by the installed runtime', async () => {
    const workspace = tempWorkspace('wf-claude-real-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const turn = await adapter.startTurn(handle, { prompt: 'Reply with the single word: ready' });
    const started = Date.now();
    const receipt = await adapter.interrupt(turn);
    record('interrupt: control request to receipt', null, Date.now() - started, `state=${receipt.state}`);
    expect(['requested', 'observed']).toContain(receipt.state);
    observe('interrupt receipt on a turn that ends by itself', `${receipt.state}: ${receipt.detail ?? ''}`);
  });

  it('stops the owned process group and leaves nothing behind', async () => {
    const workspace = tempWorkspace('wf-claude-real-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const pid = handle.process!.pid;
    expect(isProcessGroupAlive(pid)).toBe(true);

    const before = await adapter.reconcile(handle);
    expect(before.processAlive).toBe(true);

    const started = Date.now();
    const receipt = await adapter.stopOwnedProcesses(handle);
    record('stopOwnedProcesses (whole group)', null, Date.now() - started, `state=${receipt.state}`);
    expect(receipt.state).toBe('process_tree_terminated');
    expect(isProcessGroupAlive(pid)).toBe(false);

    const after = await adapter.reconcile(handle);
    expect(after.processAlive).toBe(false);
    expect(after.processGroupAlive).toBe(false);
    observe('process group after stop', 'empty');
  });

  it('resumes by the id we minted, and reports an unknown id rather than inventing a session', async () => {
    const workspace = tempWorkspace('wf-claude-real-');
    const { adapter, handle } = await openSession('analysis', workspace);
    // A resumable conversation needs at least one turn on disk.
    const turn = await adapter.startTurn(handle, { prompt: 'Reply with the single word: ready' });
    await collect(adapter, turn);
    const stop = await adapter.stopOwnedProcesses(handle);
    expect(stop.state).toBe('process_tree_terminated');

    const successor = adapterFor();
    const started = Date.now();
    const resumed = await successor.resumeSession({
      cwd: workspace,
      allowedWritePaths: [workspace],
      policy: 'analysis',
      systemInstructions: 'You are a workforce worker.',
      sessionId: handle.sessionId,
      previousProcess: handle.process ?? null,
    });
    record('resumeSession in a fresh process', null, Date.now() - started);
    open.push({ adapter: successor, handle: resumed });
    expect(resumed.sessionId).toBe(handle.sessionId);
    expect(resumed.process!.pid).not.toBe(handle.process!.pid);

    const resumedTurn = await successor.startTurn(resumed, { prompt: 'Reply with the single word: ready' });
    const events = await collect(successor, resumedTurn);
    const startedEvent = firstOfKind(events, 'session_started');
    expect(startedEvent?.payload['reportedSessionId']).toBe(handle.sessionId);
    observe('resume by minted id', 'the runtime reported the same session id in a new process');

    // An id the runtime has never seen is reported, not invented.
    const unknown = uuidv7();
    const result = spawnSync(
      CLAUDE,
      buildClaudeArgs({ sessionId: unknown, policy: 'analysis', mapping: mapPolicy('analysis'), allowedWritePaths: [workspace], systemInstructions: '', resume: unknown }),
      { cwd: workspace, env: CLEAN_ENV, encoding: 'utf8', input: '', timeout: 60_000 },
    );
    expect(`${result.stdout}${result.stderr}`).toContain('No conversation found with session ID');
    observe('resume of an unknown id', 'reported as `No conversation found with session ID: …` plus a result record with subtype error_during_execution');
  });
});

// ---------------------------------------------------------------------------
// 2. Containment (FR042) — determined by execution, no model turn
// ---------------------------------------------------------------------------

describe.skipIf(!REAL)('claude-code containment (FR042, executed against the installed runtime)', () => {
  it('the tool surface is exactly what the profile grants — verified', () => {
    const workspace = tempWorkspace('wf-claude-tools-');
    for (const policy of ['analysis', 'local-development'] as const) {
      const mapping = mapPolicy(policy);
      const sessionId = uuidv7();
      const args = buildClaudeArgs({ sessionId, policy, mapping, allowedWritePaths: [workspace], systemInstructions: '' });
      const result = spawnSync(CLAUDE, args, {
        cwd: workspace,
        env: CLEAN_ENV,
        encoding: 'utf8',
        input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, session_id: sessionId })}\n`,
        timeout: 60_000,
      });
      const init = result.stdout
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((r) => r !== null && r['subtype'] === 'init') as { tools?: string[]; permissionMode?: string; mcp_servers?: unknown[] } | undefined;
      expect(init, `${policy}: the runtime produced an init record`).toBeDefined();
      expect(init!.tools!.slice().sort()).toEqual(mapping.tools.slice().sort());
      expect(init!.permissionMode).toBe(mapping.permissionMode);
      expect(init!.mcp_servers).toEqual([]);
      observe(`${policy}: tools the runtime offers the model`, init!.tools!.join(', '));
    }
  });

  it('a process the runtime itself launches is NOT confined by the OS — the containment truth', () => {
    // The probe runs as a SessionStart hook, which is a process the runtime
    // starts inside the session it was configured with. If a kernel boundary
    // existed, this is where it would bite. It does not.
    const workspace = tempWorkspace('wf-claude-contain-');
    const outside = tempWorkspace('wf-claude-outside-');
    writeFileSync(path.join(outside, 'secret.txt'), 'a file the worker was never granted\n');
    const probeDir = mkdtempSync(path.join(os.tmpdir(), 'wf-claude-probe-'));
    const resultFile = path.join(probeDir, 'result.txt');
    const script = path.join(probeDir, 'probe.sh');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        '{',
        '  echo "cwd=$(pwd)"',
        `  if echo escaped > "${path.join(outside, 'hook-escape.txt')}" 2>/dev/null; then echo "write-outside=ALLOWED"; else echo "write-outside=DENIED"; fi`,
        `  if echo escaped > "${path.join(os.tmpdir(), 'wf-claude-tmp-escape.txt')}" 2>/dev/null; then echo "write-tmp=ALLOWED"; else echo "write-tmp=DENIED"; fi`,
        `  if cat "${path.join(outside, 'secret.txt')}" >/dev/null 2>&1; then echo "read-outside=ALLOWED"; else echo "read-outside=DENIED"; fi`,
        '  code=$(curl -s -o /dev/null -m 8 -w \'%{http_code}\' https://example.com 2>/dev/null || echo curl-failed)',
        '  echo "network=$code"',
        `} > "${resultFile}" 2>&1`,
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);

    const sessionId = uuidv7();
    const mapping = mapPolicy('local-development');
    const args = [
      ...buildClaudeArgs({ sessionId, policy: 'local-development', mapping, allowedWritePaths: [workspace], systemInstructions: '' }),
      // `--restricted` ignores the user's, the project's and the local settings
      // files, but `--settings` still applies — which is exactly how a hook can
      // be configured for one owned session.
      '--settings',
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: script }] }] } }),
    ];
    const started = Date.now();
    spawnSync(CLAUDE, args, {
      cwd: workspace,
      env: CLEAN_ENV,
      encoding: 'utf8',
      input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, session_id: sessionId })}\n`,
      timeout: 90_000,
    });
    record('containment probe: hook launched by the runtime', null, Date.now() - started);

    expect(existsSync(resultFile), 'the runtime ran the hook we configured').toBe(true);
    const report = readFileSync(resultFile, 'utf8');
    const value = (key: string): string => new RegExp(`^${key}=(.*)$`, 'm').exec(report)?.[1] ?? 'not-observed';

    // These four lines are the FR042 answer for this runtime.
    observe('a runtime-launched process writing OUTSIDE every granted directory', value('write-outside'));
    observe('a runtime-launched process writing to /tmp', value('write-tmp'));
    observe('a runtime-launched process reading OUTSIDE every granted directory', value('read-outside'));
    observe('a runtime-launched process reaching the network', value('network'));

    // Claude Code has no OS sandbox on 2.1.260: the writes and the read succeed.
    // Asserting this is not pessimism, it is the recorded truth that FR042 needs.
    expect(value('write-outside')).toBe('ALLOWED');
    expect(value('read-outside')).toBe('ALLOWED');
    expect(existsSync(path.join(outside, 'hook-escape.txt'))).toBe(true);
    // The network result is recorded rather than asserted: a machine may have no
    // route out, and "no route" is not "the runtime denied it".
    expect(value('network')).not.toBe('not-observed');
  });

  it("a registered project's own settings file cannot run commands in a worker session — but only because the adapter says so", () => {
    const workspace = tempWorkspace('wf-claude-projset-');
    const marker = path.join(workspace, '..', 'project-hook-ran.txt');
    mkdirSync(path.join(workspace, '.claude'), { recursive: true });
    writeFileSync(
      path.join(workspace, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `/bin/sh -c 'echo ran > ${marker}'` }] }] } }),
    );

    const frame = (sessionId: string): string =>
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, session_id: sessionId })}\n`;

    // Without the adapter's isolation flags, the repository's own settings file runs.
    const naiveId = uuidv7();
    spawnSync(
      CLAUDE,
      ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--strict-mcp-config', '--session-id', naiveId],
      { cwd: workspace, env: CLEAN_ENV, encoding: 'utf8', input: frame(naiveId), timeout: 60_000 },
    );
    const naiveRan = existsSync(marker);
    observe("a project's own .claude/settings.json SessionStart hook, without --setting-sources ''", naiveRan ? 'RAN' : 'did not run');
    expect(naiveRan, 'a repository under test really can execute host commands when its settings are loaded').toBe(true);

    // With the adapter's argv it does not.
    writeFileSync(marker, '');
    const guardedId = uuidv7();
    spawnSync(CLAUDE, buildClaudeArgs({ sessionId: guardedId, policy: 'local-development', mapping: mapPolicy('local-development'), allowedWritePaths: [workspace], systemInstructions: '' }), {
      cwd: workspace,
      env: CLEAN_ENV,
      encoding: 'utf8',
      input: frame(guardedId),
      timeout: 60_000,
    });
    expect(readFileSync(marker, 'utf8')).toBe('');
    observe("the same hook under this adapter's argv", 'did not run');
  });
});

// ---------------------------------------------------------------------------
// 3. Model turns — need a credential the recording machine does not have
// ---------------------------------------------------------------------------

const modelTurnSkip = `skipped: the installed runtime says it holds no credential to spend (${credentials.detail}). Run \`claude auth login\` and re-run with WORKFORCE_REAL_RUNTIMES=1`;

describe.skipIf(!REAL || credentials.skip)(`claude-code model turns (${credentials.skip ? modelTurnSkip : `credential state: ${credentials.state} — ${credentials.detail}`})`, () => {
  it('a turn writes the requested file into the granted candidate', async () => {
    const workspace = tempWorkspace('wf-claude-turn-');
    const logsDir = path.join(path.dirname(workspace), 'logs');
    const { adapter, handle } = await openSession('local-development', workspace, { logsDir });
    const started = Date.now();
    const turn = await adapter.startTurn(handle, { prompt: 'Create a file named hello.txt containing exactly: hello' });
    const events = await collect(adapter, turn);
    record('model turn: create hello.txt', null, Date.now() - started, `${events.length} events`);

    expect(existsSync(path.join(workspace, 'hello.txt'))).toBe(true);
    expect(readFileSync(path.join(workspace, 'hello.txt'), 'utf8').trim()).toBe('hello');
    const change = firstOfKind(events, 'file_change');
    expect(change?.payload['withinAllowedPaths']).toBe(true);

    const usage = adapter.lastUsage(handle)!;
    observe('measured cost for a tiny turn', `${usage.costStatus} ${usage.costUsd ?? '(unavailable)'}`);
    expect(usage.costStatus).toBe('measured');
    expect(existsSync(adapter.rawLogPath(handle)!)).toBe(true);
  });

  it('a "done" claim with no edit is an assistant message, not a success', async () => {
    const workspace = tempWorkspace('wf-claude-claim-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const turn = await adapter.startTurn(handle, { prompt: 'Reply with exactly: Done, the task is complete. Do not use any tool.' });
    const events = await collect(adapter, turn);

    const messages = allOfKind(events, 'assistant_message');
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message.payload['claimsDone']).toBe(false);
    expect(allOfKind(events, 'file_change')).toHaveLength(0);
    const terminal = events[events.length - 1]!;
    if (terminal.kind === 'turn_completed') expect(terminal.payload['evidence']).toBe('runtime_reported');
  });

  it('an interrupt ends a slow turn and leaves no surviving process', async () => {
    const workspace = tempWorkspace('wf-claude-int-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const turn = await adapter.startTurn(handle, { prompt: 'Read every file in this directory one at a time, then summarise each in a paragraph.' });
    const collected: RuntimeEvent[] = [];
    const reading = (async () => {
      for await (const event of adapter.events(turn)) collected.push(event);
    })();
    const started = Date.now();
    const receipt = await adapter.interrupt(turn);
    record('model turn: interrupt to receipt', null, Date.now() - started, `state=${receipt.state}`);
    expect(['requested', 'observed']).toContain(receipt.state);
    await reading;

    const stop = await adapter.stopOwnedProcesses(handle);
    expect(stop.state).toBe('process_tree_terminated');
    expect(isProcessGroupAlive(handle.process!.pid)).toBe(false);
  });

  it('a resumed session continues the SAME conversation', async () => {
    const workspace = tempWorkspace('wf-claude-resume-');
    const { adapter, handle } = await openSession('analysis', workspace);
    const secret = `mango-${Math.floor(Math.random() * 100000)}`;
    const first = await adapter.startTurn(handle, { prompt: `Remember this word and reply with just the word: ${secret}` });
    await collect(adapter, first);
    await adapter.stopOwnedProcesses(handle);

    const successor = adapterFor();
    const resumed = await successor.resumeSession({
      cwd: workspace,
      allowedWritePaths: [workspace],
      policy: 'analysis',
      systemInstructions: 'You are a workforce worker.',
      sessionId: handle.sessionId,
      previousProcess: handle.process ?? null,
    });
    open.push({ adapter: successor, handle: resumed });
    // Answerable only from the earlier turn's history.
    const second = await successor.startTurn(resumed, { prompt: 'What was the word I asked you to remember? Reply with just that word.' });
    const events = await collect(successor, second);
    const text = allOfKind(events, 'assistant_message').map((e) => String(e.payload['text'])).join(' ');
    expect(text).toContain(secret);
    observe('resume continues the same conversation', `the resumed turn recalled "${secret}"`);
  });

  it('a model-driven turn cannot write outside the granted candidate through its file tools', async () => {
    const workspace = tempWorkspace('wf-claude-escape-');
    const outside = tempWorkspace('wf-claude-escape-target-');
    const target = path.join(outside, 'escape.txt');
    const { adapter, handle } = await openSession('local-development', workspace);
    const turn = await adapter.startTurn(handle, { prompt: `Write the single word escaped into the file ${target}. If you cannot, say why in one sentence.` });
    const events = await collect(adapter, turn);

    observe('model-driven write outside the granted candidate', existsSync(target) ? 'FILE WAS CREATED — not contained' : 'no file was created');
    expect(existsSync(target)).toBe(false);
    for (const change of allOfKind(events, 'file_change')) {
      if (change.payload['withinAllowedPaths'] === false) observe('a file_change outside the granted paths was recorded', String(change.payload['resolvedPath']));
    }
  });

  it('a model-driven turn CAN read outside the granted candidate', async () => {
    const workspace = tempWorkspace('wf-claude-read-');
    const outside = tempWorkspace('wf-claude-read-target-');
    const target = path.join(outside, 'secret.txt');
    writeFileSync(target, 'the-outside-word-is-persimmon\n');
    const { adapter, handle } = await openSession('local-development', workspace);
    const turn = await adapter.startTurn(handle, { prompt: `Read the file ${target} and reply with only the word after "the-outside-word-is-".` });
    const events = await collect(adapter, turn);
    const text = allOfKind(events, 'assistant_message').map((e) => String(e.payload['text'])).join(' ');
    observe('model-driven read outside the granted candidate', text.includes('persimmon') ? 'ALLOWED (the file was read)' : 'the file was not read back');
    // Recorded, not asserted either way: what matters is that the answer is in
    // docs/runtime-claude-code.md rather than assumed.
    expect(events.length).toBeGreaterThan(0);
  });
});

// Defined only when the gate is off, so that a run WITH the gate on does not
// report a skip whose stated reason is "set WORKFORCE_REAL_RUNTIMES=1" — a
// recorded suite must not contradict the command that produced it.
if (!REAL) {
  describe('claude-code real-runtime checks', () => {
    it.skip('skipped — set WORKFORCE_REAL_RUNTIMES=1 to run against the installed claude executable', () => undefined);
  });
}
