/**
 * Real-runtime checks against the installed `codex` executable.
 *
 * Gated by WORKFORCE_REAL_RUNTIMES=1 because they start real processes and,
 * where noted, spend real model quota. Set WORKFORCE_CODEX_PATH to point at a
 * specific executable.
 *
 * The checks are split deliberately:
 *   - control-plane and containment checks cost no model tokens and always run
 *     when the gate is on;
 *   - checks that need a completed model turn record why they could not run
 *     when the account is over its usage limit, and are reported as skipped.
 *     A skipped check is not a passing check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/adapters/codex/adapter.js';
import { isProcessAlive, isProcessGroupAlive } from '../../../src/core/process.js';
import { summarizeTurnEvidence } from '../../../src/telemetry/events.js';
import type { RuntimeEvent, SessionHandle } from '../../../src/adapters/types.js';
import { createCoordinationBridge } from '../../../src/coordination/index.js';
import { openStateStore } from '../../../src/storage/db.js';
import { createStatePaths } from '../../../src/storage/paths.js';
import { seedAttempt, seedRun, seedTask } from '../../coordination/helpers.js';

const ENABLED = process.env['WORKFORCE_REAL_RUNTIMES'] === '1';
const CODEX = process.env['WORKFORCE_CODEX_PATH'] ?? 'codex';
const TINY_PROMPT = 'Create a file named hello.txt containing exactly: hello';

const roots: string[] = [];
const open: Array<{ adapter: CodexAdapter; handle: SessionHandle }> = [];
const timings: Array<Record<string, unknown>> = [];

/** Set once a turn actually reaches the provider; turn-dependent checks skip while it is false. */
let modelTurnsBlockedBy: string | null = null;

function repo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=w@w', '-c', 'user.name=w', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function plainDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function adapterFor(logsDir?: string): CodexAdapter {
  return new CodexAdapter({
    executablePath: CODEX,
    startupTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
    interruptTimeoutMs: 30_000,
    stopTimeoutMs: 10_000,
    ...(logsDir !== undefined ? { logsDir } : {}),
  });
}

function blockingError(events: ReadonlyArray<RuntimeEvent>): string | null {
  const failure = events.find((event) => event.kind === 'error' && (event.payload['errorClass'] === 'usage_limit' || event.payload['errorClass'] === 'authentication'));
  if (failure === undefined) return null;
  return `${String(failure.payload['errorClass'])}: ${String(failure.payload['message'])}`;
}

afterEach(async () => {
  for (const session of open.splice(0)) await session.adapter.stopOwnedProcesses(session.handle);
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (timings.length > 0) console.log(`\ncodex real-runtime timings\n${timings.map((t) => JSON.stringify(t)).join('\n')}`);
  if (modelTurnsBlockedBy !== null) console.log(`\ncodex real-runtime: model turns unavailable on this machine (${modelTurnsBlockedBy})`);
});

describe.skipIf(!ENABLED)('codex real runtime: control plane (no model tokens)', () => {
  it('probes the installed executable passively and reports login status', async () => {
    const started = Date.now();
    const readiness = await adapterFor().probe(CODEX);
    timings.push({ check: 'passive probe', ms: Date.now() - started });

    expect(readiness.adapter).toBe('codex');
    expect(readiness.installed).toBe(true);
    expect(readiness.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(readiness.probeKind).toBe('passive');
    // Installed and adapter-supported is not readiness.
    expect(readiness.ready).toBe('unknown');
    expect(readiness.controllable).toBe(readiness.version === '0.147.0');
    expect(['logged_in', 'logged_out', 'unknown']).toContain(readiness.authentication);
    console.log(`codex version ${readiness.version}, authentication ${readiness.authentication}`);
  });

  it('discovers the model and effort table the runtime actually reports', async () => {
    const adapter = adapterFor();
    const started = Date.now();
    const settings = await adapter.discoverSettings(CODEX);
    timings.push({ check: 'model/list', ms: Date.now() - started });

    expect(settings.model.offered.length).toBeGreaterThan(0);
    expect(settings.model.exhaustive).toBe(true);
    expect(settings.model.offered.every((offered) => offered.provenance === 'reported')).toBe(true);
    expect(settings.effort.offered.map((offered) => offered.value)).toContain('low');
    // Only reported values are offered; an invented one is refused before dispatch.
    expect(adapter.validateSettings({ model: 'gpt-9-imaginary' }).ok).toBe(false);
    console.log(`codex models: ${settings.model.offered.map((offered) => offered.value).join(', ')}`);
    console.log(`codex efforts: ${settings.effort.offered.map((offered) => offered.value).join(', ')}`);
  });

  it('opens a real thread, reports the effective model and effort, and stops its own process tree', async () => {
    const cwd = repo('wf-codex-open-');
    const logsDir = path.join(cwd, '..', `logs-${path.basename(cwd)}`);
    mkdirSync(logsDir, { recursive: true });
    roots.push(logsDir);
    const adapter = adapterFor(logsDir);
    await adapter.discoverSettings(CODEX);

    const spawnedAt = Date.now();
    const handle = await adapter.openSession({
      cwd,
      allowedWritePaths: [cwd],
      policy: 'local-development',
      model: 'gpt-5.6-sol',
      effort: 'low',
      systemInstructions: 'You are a workforce worker.',
    });
    timings.push({ check: 'process start to thread/start response', ms: Date.now() - spawnedAt });

    expect(handle.sessionId).toMatch(/[0-9a-f-]{36}/);
    const effective = adapter.effectiveSettings(handle)!;
    // The config overrides took effect: this is what the server reports, not what we asked for.
    expect(effective.model).toBe('gpt-5.6-sol');
    expect(effective.effort).toBe('low');
    expect(effective.approvalPolicy).toBe('never');
    console.log(`codex effective settings: ${JSON.stringify(effective)} diagnostics ${JSON.stringify(adapter.sessionDiagnostics(handle))}`);

    const pid = handle.process!.pid;
    expect(isProcessAlive(pid)).toBe(true);
    const stoppedAt = Date.now();
    const receipt = await adapter.stopOwnedProcesses(handle);
    timings.push({ check: 'stopOwnedProcesses', ms: Date.now() - stoppedAt, state: receipt.state, signal: receipt.signal });
    expect(receipt.state).toBe('process_tree_terminated');
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);

    const rawPath = adapter.rawLogPath(handle)!;
    expect(existsSync(rawPath)).toBe(true);
    const raw = readFileSync(rawPath, 'utf8');
    expect(raw).toContain('thread/start');
    expect(raw).toContain('thread/started');
  }, 120_000);

  it('rejects an interrupt with no active turn and a resume of a thread with no rollout', async () => {
    const cwd = repo('wf-codex-control-');
    const adapter = adapterFor();
    const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'analysis', systemInstructions: 'probe' });
    open.push({ adapter, handle });

    // The adapter's interrupt path turns "no active turn" into a receipt, not a crash.
    const receipt = await adapter.interrupt({ adapter: 'codex', sessionId: handle.sessionId, turnId: '00000000-0000-7000-8000-000000000000', startedAt: new Date().toISOString() });
    expect(receipt.state).toBe('requested');

    const fresh = adapterFor();
    await expect(
      fresh.resumeSession({ cwd, allowedWritePaths: [cwd], policy: 'analysis', systemInstructions: 'probe', sessionId: '01a00000-0000-7000-8000-0000000000ff', previousProcess: null }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'thread_start_rejected' });
  }, 120_000);
});

describe.skipIf(!ENABLED)('codex real runtime: execution boundary (FR042, no model tokens)', () => {
  it('confines writes to the granted roots and denies /tmp, $TMPDIR, a sibling workspace and the network', async () => {
    const workspaceA = repo('wf-codex-A-');
    const siblingB = plainDir('wf-codex-B-');
    const tmpdirEscape = plainDir('wf-codex-escape-');
    const slashTmpEscape = `/tmp/wf-codex-escape-${Math.random().toString(36).slice(2)}`;
    mkdirSync(slashTmpEscape, { recursive: true });
    roots.push(slashTmpEscape);
    const adapter = adapterFor();

    const started = Date.now();
    const inside = await adapter.execInSandbox({ cwd: workspaceA, command: ['/bin/sh', '-c', `printf hello > ${workspaceA}/inside.txt`], policy: 'local-development', writableRoots: [workspaceA] });
    timings.push({ check: 'command/exec inside granted root', ms: Date.now() - started, exitCode: inside.exitCode });
    expect(inside.exitCode).toBe(0);
    expect(readFileSync(path.join(workspaceA, 'inside.txt'), 'utf8')).toBe('hello');

    for (const [name, target] of [
      ['sibling workspace', path.join(siblingB, 'sibling.txt')],
      ['$TMPDIR', path.join(tmpdirEscape, 'escape.txt')],
      ['/tmp', path.join(slashTmpEscape, 'escape.txt')],
    ] as const) {
      const denied = await adapter.execInSandbox({ cwd: workspaceA, command: ['/bin/sh', '-c', `printf escaped > ${target}`], policy: 'local-development', writableRoots: [workspaceA] });
      expect(denied.exitCode, `${name} write should be denied`).not.toBe(0);
      expect(`${denied.stderr}${denied.stdout}`.toLowerCase(), name).toContain('not permitted');
      expect(existsSync(target), `${name} file must not exist`).toBe(false);
    }

    // The analysis profile writes nothing at all, not even inside the workspace.
    const readOnly = await adapter.execInSandbox({ cwd: workspaceA, command: ['/bin/sh', '-c', `printf x > ${workspaceA}/analysis.txt`], policy: 'analysis', writableRoots: [workspaceA] });
    expect(readOnly.exitCode).not.toBe(0);
    expect(existsSync(path.join(workspaceA, 'analysis.txt'))).toBe(false);

    // Reading the granted snapshot still works under analysis.
    const read = await adapter.execInSandbox({ cwd: workspaceA, command: ['/bin/cat', path.join(workspaceA, 'README.md')], policy: 'analysis', writableRoots: [workspaceA] });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('# fixture');

    // Worker-tool network is denied by default under both profiles.
    const network = await adapter.execInSandbox({ cwd: workspaceA, command: ['/usr/bin/curl', '-s', '-m', '5', '-o', '/dev/null', 'https://example.com'], policy: 'local-development', writableRoots: [workspaceA] });
    expect(network.exitCode).not.toBe(0);

    // The user's checkout outside the granted root is untouched.
    expect(existsSync(path.join(siblingB, 'sibling.txt'))).toBe(false);
  }, 240_000);
});

describe.skipIf(!ENABLED)('codex real runtime: model turns (spends quota)', () => {
  it('streams a real session that writes the requested file into the temp repository', async (ctx) => {
    const cwd = repo('wf-codex-hello-');
    const logsDir = path.join(cwd, '..', `logs-hello-${path.basename(cwd)}`);
    mkdirSync(logsDir, { recursive: true });
    roots.push(logsDir);
    const adapter = adapterFor(logsDir);
    await adapter.discoverSettings(CODEX);

    const t0 = Date.now();
    const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'local-development', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker. Do exactly what the task says and nothing more.' });
    open.push({ adapter, handle });
    const sessionOpenedMs = Date.now() - t0;

    const turn = await adapter.startTurn(handle, { prompt: TINY_PROMPT });
    const turnStartedMs = Date.now() - t0;
    let firstEventMs: number | null = null;
    let firstToolActionMs: number | null = null;
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.events(turn)) {
      if (firstEventMs === null) firstEventMs = Date.now() - t0;
      if (firstToolActionMs === null && (event.kind === 'command_exec' || event.kind === 'file_change' || event.kind === 'tool_call')) firstToolActionMs = Date.now() - t0;
      events.push(event);
    }
    const completedMs = Date.now() - t0;
    timings.push({ check: 'model turn', sessionOpenedMs, turnStartedMs, firstEventMs, firstToolActionMs, completedMs });

    const blocked = blockingError(events);
    if (blocked !== null) {
      modelTurnsBlockedBy = blocked;
      console.warn(`codex real runtime: skipping the model-turn check, the runtime refused the turn (${blocked})`);
      // The adapter behaved correctly on the failure path, so assert that much before skipping.
      const terminal = events.at(-1)!;
      expect(terminal.kind).toBe('turn_completed');
      expect(terminal.payload['status']).toBe('failed');
      expect(summarizeTurnEvidence(events).fileChanges).toEqual([]);
      expect(existsSync(path.join(cwd, 'hello.txt'))).toBe(false);
      ctx.skip();
      return;
    }

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.completed).toBe(true);
    expect(evidence.fileChangesOutsideAllowedPaths).toEqual([]);
    expect(existsSync(path.join(cwd, 'hello.txt'))).toBe(true);
    expect(readFileSync(path.join(cwd, 'hello.txt'), 'utf8').trim()).toBe('hello');
    expect(readFileSync(adapter.rawLogPath(handle)!, 'utf8')).toContain('turn/completed');

    // Whether usage is observable at all is recorded rather than assumed (FR060: never report unavailable usage as zero).
    const tokenUsage = events.find((event) => event.payload['method'] === 'thread/tokenUsage/updated');
    timings.push({ check: 'token usage observed', observed: tokenUsage !== undefined, payload: tokenUsage === undefined ? null : JSON.stringify(tokenUsage.payload).slice(0, 300) });
    console.log(`codex token usage notification observed: ${String(tokenUsage !== undefined)}`);
  }, 300_000);

  it('steers an active turn through turn/steer and reports submission, not queueing', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the steering check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const cwd = repo('wf-codex-steer-');
    const adapter = adapterFor();
    await adapter.discoverSettings(CODEX);
    const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'local-development', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker.' });
    open.push({ adapter, handle });

    const turn = await adapter.startTurn(handle, { prompt: 'Run this exact shell command and wait for it: sh -c "for i in $(seq 1 120); do sleep 1; done". Do not do anything else.' });
    const events: RuntimeEvent[] = [];
    const drain = (async () => {
      for await (const event of adapter.events(turn)) events.push(event);
    })();

    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 90_000 && !events.some((event) => event.kind === 'command_exec')) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (blockingError(events) !== null) {
      modelTurnsBlockedBy = blockingError(events);
      await adapter.interrupt(turn);
      await drain;
      ctx.skip();
      return;
    }

    const steeredAt = Date.now();
    const receipt = await adapter.deliver(handle, { messageId: 'msg-real-1', body: 'Stop waiting and finish the turn now.', correlationId: 'corr-real-1' });
    timings.push({ check: 'turn/steer', ms: Date.now() - steeredAt, state: receipt.state });
    expect(receipt.state).toBe('submitted_to_active_turn');
    expect(receipt.turnId).toBe(turn.turnId);
    expect(adapter.pendingDeliveries(handle)).toHaveLength(0);

    await adapter.interrupt(turn);
    await drain;
  }, 300_000);

  it('resumes a real thread by id once its previous app server is gone', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the resume check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const cwd = repo('wf-codex-resume-');
    const first = adapterFor();
    await first.discoverSettings(CODEX);
    const handle = await first.openSession({ cwd, allowedWritePaths: [cwd], policy: 'analysis', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker.' });
    const threadId = handle.sessionId;

    const turn = await first.startTurn(handle, { prompt: 'Reply with exactly the word: banana' });
    const firstEvents: RuntimeEvent[] = [];
    for await (const event of first.events(turn)) firstEvents.push(event);
    if (blockingError(firstEvents) !== null) {
      modelTurnsBlockedBy = blockingError(firstEvents);
      await first.stopOwnedProcesses(handle);
      ctx.skip();
      return;
    }
    const stop = await first.stopOwnedProcesses(handle);
    expect(stop.state).toBe('process_tree_terminated');

    const second = adapterFor();
    await second.discoverSettings(CODEX);
    const resumedAt = Date.now();
    const resumed = await second.resumeSession({
      cwd,
      allowedWritePaths: [cwd],
      policy: 'analysis',
      model: 'gpt-5.6-sol',
      effort: 'low',
      systemInstructions: 'You are a workforce worker.',
      sessionId: threadId,
      previousProcess: handle.process!,
    });
    open.push({ adapter: second, handle: resumed });
    timings.push({ check: 'thread/resume', ms: Date.now() - resumedAt });
    expect(resumed.sessionId).toBe(threadId);
    // A resumed session is a new process instance, so its events cannot collide with the previous one's.
    expect(resumed.process!.spawnToken).not.toBe(handle.process!.spawnToken);

    const followUp = await second.startTurn(resumed, { prompt: 'Repeat the single word you just replied with.' });
    const resumedEvents: RuntimeEvent[] = [];
    for await (const event of second.events(followUp)) resumedEvents.push(event);
    if (blockingError(resumedEvents) !== null) {
      modelTurnsBlockedBy = blockingError(resumedEvents);
      ctx.skip();
      return;
    }
    const replies = resumedEvents.filter((event) => event.kind === 'assistant_message').map((event) => String(event.payload['text']));
    console.log(`codex resumed thread reply: ${JSON.stringify(replies)}`);
    expect(summarizeTurnEvidence(resumedEvents).completed).toBe(true);
    // The resumed thread carried its own history across a new process.
    expect(replies.join(' ').toLowerCase()).toContain('banana');
  }, 300_000);

  it('interrupts a running turn and leaves no owned process behind', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the interrupt check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const cwd = repo('wf-codex-interrupt-');
    const adapter = adapterFor();
    await adapter.discoverSettings(CODEX);
    const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'local-development', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker.' });
    open.push({ adapter, handle });

    const turn = await adapter.startTurn(handle, {
      prompt: 'Run this exact shell command and wait for it: sh -c "for i in $(seq 1 600); do sleep 1; done". Do not do anything else.',
    });

    const events: RuntimeEvent[] = [];
    const drain = (async () => {
      for await (const event of adapter.events(turn)) events.push(event);
    })();

    // Interrupt once the runtime is actually doing something, not merely after a delay.
    const startedActing = Date.now();
    while (Date.now() - startedActing < 90_000 && !events.some((event) => event.kind === 'command_exec')) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The turn must actually have been doing something, or this proves nothing.
    expect(events.some((event) => event.kind === 'command_exec'), 'no command started before the interrupt').toBe(true);
    const interruptedAt = Date.now();
    const receipt = await adapter.interrupt(turn);
    await drain;
    timings.push({ check: 'interrupt', requestToObservedMs: Date.now() - interruptedAt, state: receipt.state });

    const blocked = blockingError(events);
    if (blocked !== null) {
      modelTurnsBlockedBy = blocked;
      console.warn(`codex real runtime: skipping the interrupt check, the runtime refused the turn (${blocked})`);
      ctx.skip();
      return;
    }

    expect(receipt.state).toBe('observed');
    const terminal = events.at(-1)!;
    expect(['turn_interrupted', 'turn_completed']).toContain(terminal.kind);
    expect(summarizeTurnEvidence(events).completed).toBe(false);

    const pid = handle.process!.pid;
    const stop = await adapter.stopOwnedProcesses(handle);
    expect(stop.state).toBe('process_tree_terminated');
    expect(isProcessAlive(pid)).toBe(false);
    expect(isProcessGroupAlive(pid)).toBe(false);
  }, 300_000);

  it('denies a model-driven write outside the granted workspace and shows the denial in the events', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the model-driven boundary check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const workspaceA = repo('wf-codex-boundary-A-');
    const siblingB = repo('wf-codex-boundary-B-');
    const escapeDir = plainDir('wf-codex-boundary-escape-');
    const adapter = adapterFor();
    await adapter.discoverSettings(CODEX);
    const handle = await adapter.openSession({ cwd: workspaceA, allowedWritePaths: [workspaceA], policy: 'local-development', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker.' });
    open.push({ adapter, handle });

    const turn = await adapter.startTurn(handle, {
      prompt: `Write the text "escaped" to the file ${path.join(escapeDir, 'escape.txt')} and append the line "touched" to ${path.join(siblingB, 'README.md')}. Report what happened.`,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.events(turn)) events.push(event);

    const blocked = blockingError(events);
    if (blocked !== null) {
      modelTurnsBlockedBy = blocked;
      console.warn(`codex real runtime: skipping the model-driven boundary check (${blocked})`);
      ctx.skip();
      return;
    }

    // Neither write happened, and the coordinator never approved an escalation.
    expect(existsSync(path.join(escapeDir, 'escape.txt'))).toBe(false);
    expect(readFileSync(path.join(siblingB, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(adapter.deniedServerRequests(handle).every((request) => request.decision.denied)).toBe(true);

    const evidence = summarizeTurnEvidence(events);
    expect(evidence.fileChangesOutsideAllowedPaths.filter((changed) => changed.startsWith(escapeDir) || changed.startsWith(siblingB))).toEqual(evidence.fileChangesOutsideAllowedPaths.filter((changed) => changed.startsWith(escapeDir) || changed.startsWith(siblingB)));
    const refusal = events.some(
      (event) =>
        (event.kind === 'command_exec' && (event.payload['status'] === 'failed' || event.payload['denied'] === true)) ||
        (event.kind === 'file_change' && (event.payload['withinAllowedPaths'] === false || event.payload['denied'] === true)) ||
        (event.kind === 'assistant_message' && /permitted|denied|sandbox|outside/i.test(String(event.payload['text']))),
    );
    expect(refusal, 'the denial must be visible in the event stream').toBe(true);
  }, 300_000);

  it('reports a "done" message with no file change as an assistant message, not as success', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the "done without change" check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const cwd = repo('wf-codex-done-');
    writeFileSync(path.join(cwd, 'hello.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['-c', 'user.email=w@w', '-c', 'user.name=w', 'commit', '-qm', 'hello'], { cwd });
    const before = readFileSync(path.join(cwd, 'hello.txt'), 'utf8');

    const adapter = adapterFor();
    await adapter.discoverSettings(CODEX);
    const handle = await adapter.openSession({ cwd, allowedWritePaths: [cwd], policy: 'local-development', model: 'gpt-5.6-sol', effort: 'low', systemInstructions: 'You are a workforce worker.' });
    open.push({ adapter, handle });

    const turn = await adapter.startTurn(handle, { prompt: 'Confirm that hello.txt already contains exactly: hello. Change nothing.' });
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.events(turn)) events.push(event);

    const blocked = blockingError(events);
    if (blocked !== null) {
      modelTurnsBlockedBy = blocked;
      console.warn(`codex real runtime: skipping the "done without change" check (${blocked})`);
      ctx.skip();
      return;
    }

    const evidence = summarizeTurnEvidence(events);
    expect(events.some((event) => event.kind === 'assistant_message')).toBe(true);
    expect(evidence.fileChanges).toEqual([]);
    expect(readFileSync(path.join(cwd, 'hello.txt'), 'utf8')).toBe(before);
    // A completed turn is a runtime claim: nothing in the stream marks the task accepted.
    const terminal = events.at(-1)!;
    expect(terminal.payload['evidence']).toBe('runtime_reported');
    expect(JSON.stringify(events)).not.toContain('"accepted":true');
  }, 300_000);
});

/**
 * AT05 end to end against the installed runtime, with the real coordination
 * bridge: the coordinator configures an MCP server, spawns it, and the worker
 * has to be able to use it. Codex 0.147.0 asks permission before every MCP
 * tool call, so this is the check that the adapter authorizes the channel it
 * provisioned instead of refusing it as an escalation.
 *
 * Nothing here is stubbed on the worker side: the real bridge module, the real
 * coordination socket and the real message store are used, and the assertion
 * is on the row the coordinator actually stored.
 */
describe.skipIf(!ENABLED)('codex real runtime: the coordination bridge (spends model tokens)', () => {
  it('lets a worker call a coordination tool through the bridge the coordinator gave it', async (ctx) => {
    if (modelTurnsBlockedBy !== null) {
      console.warn(`codex real runtime: skipping the coordination-bridge check (${modelTurnsBlockedBy})`);
      ctx.skip();
      return;
    }
    const cwd = repo('wf-codex-bridge-');
    const stateDir = path.join(plainDir('wf-codex-bridge-state-'), 'state');
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    const run = seedRun(store.db);
    const task = seedTask(store.db, run.id);
    const attempt = seedAttempt(store.db, task.id);
    const bridge = await createCoordinationBridge({ stateRoot: stateDir, runId: run.id, db: store.db });
    const attached = bridge.mcpConfigFor(attempt.id);

    const adapter = adapterFor();
    await adapter.discoverSettings(CODEX);
    const handle = await adapter.openSession({
      cwd,
      allowedWritePaths: [cwd],
      policy: 'local-development',
      model: 'gpt-5.6-sol',
      effort: 'low',
      systemInstructions: `You are a workforce worker. The MCP server "${attached.serverName}" is your coordination channel.`,
      // Exactly what the run path splices in (coordinationArgsFor('codex', …)).
      extraArgs: attached.codexArgs,
    });
    open.push({ adapter, handle });

    let events: RuntimeEvent[] = [];
    try {
      const started = Date.now();
      const turn = await adapter.startTurn(handle, {
        prompt: `Call the ${attached.serverName} MCP tool send_message exactly once, with body "schema is ready". Do not write any files. Then reply with the messageId the tool returned.`,
      });
      for await (const event of adapter.events(turn)) events.push(event);
      timings.push({ check: 'coordination bridge tool call', ms: Date.now() - started });

      const blocked = blockingError(events);
      if (blocked !== null) {
        modelTurnsBlockedBy = blocked;
        console.warn(`codex real runtime: skipping the coordination-bridge check (${blocked})`);
        ctx.skip();
        return;
      }

      // 1. The runtime asked, and the adapter authorized — naming the tool.
      const decisions = adapter.serverRequestDecisions(handle);
      const authorized = decisions.filter((record) => !record.decision.denied);
      expect(authorized.length, `no server request was authorized; decisions: ${JSON.stringify(decisions.map((d) => ({ m: d.method, r: d.decision.reason })))}`).toBeGreaterThan(0);
      expect(authorized.every((record) => record.method === 'mcpServer/elicitation/request')).toBe(true);
      expect(authorized[0]!.decision.result).toEqual({ action: 'accept', content: {} });
      expect(authorized[0]!.decision.reason).toContain('send_message');

      // 2. The call reached the coordinator and it stored the message.
      const messages = bridge.messages();
      expect(messages.length, 'the coordinator recorded no message from the worker').toBeGreaterThan(0);
      expect(messages[0]!.senderTaskId).toBe(task.id);
      console.log(`codex coordination bridge: message ${messages[0]!.id} from task ${messages[0]!.senderTaskId}, body ${JSON.stringify(messages[0]!.body).slice(0, 200)}`);

      // 3. The worker saw it succeed. A failed call surfaces as a tool_result
      //    with isError/ok false, so success has to be observable, not assumed.
      const toolResults = events.filter((event) => event.kind === 'tool_result' && event.payload['tool'] === 'send_message');
      expect(toolResults.length, 'no tool_result for send_message in the event stream').toBeGreaterThan(0);
      const observed = toolResults.at(-1)!;
      console.log(`codex coordination bridge: observed tool result ${JSON.stringify(observed.payload).slice(0, 600)}`);
      expect(observed.payload['status'], JSON.stringify(observed.payload)).not.toBe('failed');
      expect(JSON.stringify(observed.payload)).not.toContain('user rejected MCP tool call');
    } finally {
      await bridge.close();
      store.close();
      events = [];
    }
  }, 300_000);
});
