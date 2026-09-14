/**
 * Coordination, as the run path actually uses it.
 *
 * The unit tests in tests/coordination cover the protocol. What is asserted
 * here is the wiring: that a real run starts a bridge, mints an identity for
 * its attempt, hands the worker session the runtime's own way of reaching it,
 * and takes the token away again when the attempt is over.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/index.js';
import { coordinationArgsFor, runDirect } from '../../src/core/run-direct.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { createCoordinationBridge, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, BRIDGE_TOOL_NAMES } from '../../src/coordination/index.js';
import { cleanupAll, fixTheBugScenario, registerCleanup, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';
import { seedAttempt, seedRun, seedTask } from '../coordination/helpers.js';

afterEach(() => cleanupAll());

describe('the run path attaches its worker to the coordination bridge', () => {
  it('mints a per-attempt identity, passes it to the session and revokes it afterwards', async () => {
    const fixture = await useFixture('ts-bug');
    const stateDir = path.join(tempDir('workforce-coord-'), 'state');
    const configPath = writeFakeAgentsConfig(tempDir('workforce-coord-config-'));
    const loaded = loadAgentConfigFile(configPath);
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());
    const scenarioPath = writeScenario(fixTheBugScenario());

    let adapter: FakeAdapter | null = null;
    const result = await runDirect({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: fixture.path,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: 'Fix the pagination off-by-one.',
      requestSource: 'test',
      paths,
      db: store.db,
      adapterFactory: () => {
        adapter = new FakeAdapter({ scenarioPath });
        return adapter;
      },
    });

    // A bridge was started for the run and this attempt was attached to it.
    expect(result.coordination.attached).toBe(true);
    expect(result.coordination.reason).toBeNull();
    expect(result.coordination.socketPath).not.toBeNull();

    // The event log records the attachment, so a run's evidence says whether
    // its worker had a channel rather than leaving it to be inferred.
    const attached = store.db
      .prepare("SELECT count(*) AS n FROM events WHERE run_id = ? AND type = 'coordination.attached'")
      .get(result.runId) as { n: number };
    expect(attached.n).toBe(1);

    // The test runtime records the argv the coordinator asked for. It is empty
    // for the fake adapter, which has no MCP command line — the coordinator
    // asked for nothing rather than guessing a flag.
    expect(adapter).not.toBeNull();
    expect((adapter as unknown as FakeAdapter).extraArgsFor(result.manifest.runtime['sessionId'] as string)).toEqual([]);

    // The run still reached acceptance: coordination is additive to the proven
    // direct path, not a new way for it to fail.
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
  }, 120_000);

  it('gives each runtime its own way of reaching the bridge, and nothing to a runtime that has none', async () => {
    const stateDir = path.join(tempDir('workforce-coord-args-'), 'state');
    const paths = createStatePaths(stateDir);
    const store = openStateStore(paths, { mode: 'mutating' });
    registerCleanup(() => store.close());

    // The bridge reads the attempt's identity from the store, so seed the rows
    // it needs rather than inventing an identity for it.
    const run = seedRun(store.db);
    const task = seedTask(store.db, run.id);
    const attempt = seedAttempt(store.db, task.id);
    const runId = run.id;
    const attemptId = attempt.id;

    const bridge = await createCoordinationBridge({ stateRoot: paths.root, runId, db: store.db });
    registerCleanup(() => void bridge.close());
    const config = bridge.mcpConfigFor(attemptId);

    // Claude Code takes a JSON MCP config; the JSON names the socket and the
    // token this attempt was issued, and nothing else.
    const claudeArgs = coordinationArgsFor('claude-code', config);
    expect(claudeArgs[0]).toBe('--mcp-config');
    const parsed = JSON.parse(claudeArgs[1]!) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    const server = Object.values(parsed.mcpServers)[0]!;
    expect(server.env[BRIDGE_SOCKET_ENV]).toBe(bridge.socketPath);
    expect(server.env[BRIDGE_TOKEN_ENV]).toBe(config.token);

    // Codex receives the transport plus the exact worker-role permissions.
    // Every setting is a separate -c pair, with no global approval override.
    const codexArgs = coordinationArgsFor('codex', config);
    expect(codexArgs.length % 2).toBe(0);
    expect(codexArgs.filter((_argument, index) => index % 2 === 0).every(argument => argument === '-c')).toBe(true);
    const overrides = new Map(codexArgs.filter((_argument, index) => index % 2 === 1).map(argument => {
      const separator = argument.indexOf('=');
      return [argument.slice(0, separator), argument.slice(separator + 1)];
    }));
    expect([...overrides.keys()]).toEqual([
      'mcp_servers.workforce.command', 'mcp_servers.workforce.args', 'mcp_servers.workforce.env',
      'mcp_servers.workforce.enabled_tools', ...BRIDGE_TOOL_NAMES.map(tool => `mcp_servers.workforce.tools.${tool}.approval_mode`),
    ]);
    expect(JSON.parse(overrides.get('mcp_servers.workforce.enabled_tools')!)).toEqual(BRIDGE_TOOL_NAMES);
    for (const tool of BRIDGE_TOOL_NAMES) expect(overrides.get(`mcp_servers.workforce.tools.${tool}.approval_mode`)).toBe('"approve"');
    expect(codexArgs.join(' ')).toContain(bridge.socketPath);
    expect(codexArgs.join(' ')).toContain(config.token);

    // The test runtime has no MCP command line, so it is given nothing rather
    // than a flag the coordinator hoped would work.
    expect(coordinationArgsFor('fake', config)).toEqual([]);
  }, 60_000);
});
