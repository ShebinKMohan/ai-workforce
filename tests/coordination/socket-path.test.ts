import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_SOCKET_ENV, CoordinationServer, callCoordinator, coordinationSocketPath, createCoordinationBridge, type CoordinationBridge } from '../../src/coordination/index.js';
import { openStateStore, type StateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { insertRun } from '../../src/storage/records.js';
import { sampleRequest, TEST_LIMITS } from '../helpers/state.js';
import { seedAttempt, seedRun, seedTask } from './helpers.js';

const bridges: CoordinationBridge[] = [];
const stores: StateStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seededState(root: string, shortRunId?: string) {
  const paths = createStatePaths(root);
  const store = openStateStore(paths, { mode: 'mutating' });
  stores.push(store);
  const seeded = seedRun(store.db); // Also records the agent snapshot used by seedAttempt.
  const run = shortRunId === undefined ? seeded : insertRun(store.db, { request: sampleRequest(shortRunId), policy: 'local-development', limits: TEST_LIMITS });
  const task = seedTask(store.db, run.id);
  const attempt = seedAttempt(store.db, task.id);
  return { root, paths, store, runId: run.id, attemptId: attempt.id };
}

async function start(state: ReturnType<typeof seededState>): Promise<CoordinationBridge> {
  const bridge = await createCoordinationBridge({ stateRoot: state.root, runId: state.runId, db: state.store.db });
  bridges.push(bridge);
  return bridge;
}

async function withLongTmpdir(segment: string, test: (base: string, temporary: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(path.join(os.tmpdir(), 'wf-socket-tests-'));
  roots.push(base);
  const temporary = path.join(base, segment, segment, 'runtime-scratch');
  mkdirSync(temporary, { recursive: true });
  chmodSync(temporary, 0o755);
  writeFileSync(path.join(temporary, 'keep.txt'), 'preexisting temporary directory');
  expect(Buffer.byteLength(temporary, 'utf8')).toBeGreaterThan(100);
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  try {
    expect(os.tmpdir()).toBe(temporary);
    await test(base, temporary);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
}

function expectPrivateSocket(socketPath: string): void {
  expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(100);
  const socket = statSync(socketPath);
  const parent = statSync(path.dirname(socketPath));
  expect(socket.isSocket()).toBe(true);
  expect(parent.isDirectory()).toBe(true);
  expect(socket.mode & 0o777).toBe(0o600);
  expect(parent.mode & 0o777).toBe(0o700);
  if (process.getuid !== undefined) {
    expect(socket.uid).toBe(process.getuid());
    expect(parent.uid).toBe(process.getuid());
  }
}

// These tests deliberately change TMPDIR; no cases in this group may overlap.
describe('coordination sockets under long temporary paths', () => {
  it.each([
    ['ASCII', 'nested-verifier-directory-'.repeat(4)],
    ['multibyte', '検証ワークスペース'.repeat(5)],
  ])('uses a bounded private endpoint with %s TMPDIR and preserves authentication and owned cleanup', async (_label, segment) => {
    await withLongTmpdir(segment, async (base, temporary) => {
      const state = seededState(path.join(base, 'project-state-'.repeat(8), 'state'));
      const stateMarker = path.join(state.root, 'keep-state.txt');
      writeFileSync(stateMarker, 'preserve coordinator state');
      const bridge = await start(state);
      const config = bridge.mcpConfigFor(state.attemptId);
      const privateParent = path.dirname(bridge.socketPath);
      expectPrivateSocket(bridge.socketPath);
      expect(privateParent).not.toBe(temporary);
      expect(privateParent).not.toBe(state.root);
      expect(config.socketPath).toBe(bridge.socketPath);
      expect(bridge.server.socketPath).toBe(bridge.socketPath);
      expect(config.env[BRIDGE_SOCKET_ENV]).toBe(bridge.socketPath);
      const mcp = JSON.parse(config.claudeMcpConfigJson) as { mcpServers: { workforce: { env: Record<string, string> } } };
      expect(mcp.mcpServers.workforce.env[BRIDGE_SOCKET_ENV]).toBe(bridge.socketPath);

      expect(await callCoordinator(config.socketPath, config.token, 'send_message', { body: 'actual authorized call over the published endpoint' })).toMatchObject({ ok: true });
      expect(await callCoordinator(config.socketPath, 'forged-token', 'send_message', { body: 'forged' })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      config.revoke();
      expect(await callCoordinator(config.socketPath, config.token, 'send_message', { body: 'revoked' })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      expect(bridge.messages()).toHaveLength(1);
      expect(bridge.messages()[0]?.body).toEqual({ text: 'actual authorized call over the published endpoint' });

      await bridge.close();
      expect(existsSync(bridge.socketPath)).toBe(false);
      expect(existsSync(privateParent)).toBe(false);
      expect(existsSync(state.paths.databasePath)).toBe(true);
      expect(readFileSync(stateMarker, 'utf8')).toBe('preserve coordinator state');
      expect(readFileSync(path.join(temporary, 'keep.txt'), 'utf8')).toBe('preexisting temporary directory');
      expect(statSync(temporary).mode & 0o777).toBe(0o755);
    });
  });

  it('isolates two private endpoints and keeps the second bridge alive when the first closes', async () => {
    await withLongTmpdir('nested-project-verifier-'.repeat(5), async (base, temporary) => {
      const firstState = seededState(path.join(base, 'first-project-'.repeat(8)));
      const secondState = seededState(path.join(base, 'second-project-'.repeat(8)));
      const first = await start(firstState);
      const second = await start(secondState);
      const firstConfig = first.mcpConfigFor(firstState.attemptId);
      const secondConfig = second.mcpConfigFor(secondState.attemptId);
      expectPrivateSocket(first.socketPath);
      expectPrivateSocket(second.socketPath);
      expect(first.socketPath).not.toBe(second.socketPath);
      expect(path.dirname(first.socketPath)).not.toBe(path.dirname(second.socketPath));
      expect(await callCoordinator(first.socketPath, firstConfig.token, 'send_message', { body: 'first bridge' })).toMatchObject({ ok: true });
      expect(await callCoordinator(second.socketPath, secondConfig.token, 'send_message', { body: 'second bridge' })).toMatchObject({ ok: true });
      expect(await callCoordinator(second.socketPath, firstConfig.token, 'send_message', { body: 'cross-bridge attempt' })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      expect(await callCoordinator(first.socketPath, secondConfig.token, 'send_message', { body: 'other cross-bridge attempt' })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      expect(first.messages().map((message) => message.body)).toEqual([{ text: 'first bridge' }]);
      expect(second.messages().map((message) => message.body)).toEqual([{ text: 'second bridge' }]);

      await first.close();
      expect(existsSync(path.dirname(first.socketPath))).toBe(false);
      expectPrivateSocket(second.socketPath);
      expect(await callCoordinator(second.socketPath, secondConfig.token, 'send_message', { body: 'still connected after peer close' })).toMatchObject({ ok: true });
      await second.close();
      expect(existsSync(path.dirname(second.socketPath))).toBe(false);
      expect(existsSync(firstState.paths.databasePath)).toBe(true);
      expect(existsSync(secondState.paths.databasePath)).toBe(true);
      expect(readFileSync(path.join(temporary, 'keep.txt'), 'utf8')).toBe('preexisting temporary directory');
    });
  });

  it('keeps a preferred short state endpoint and its preexisting parent directory', async () => {
    await withLongTmpdir('discover-short-socket-base-'.repeat(4), async (base) => {
      const longState = seededState(path.join(base, 'bootstrap-state-'.repeat(8)));
      const bootstrap = await start(longState);
      // Derive a usable short base from the actual fallback, without assuming
      // which system temporary root this platform selected.
      const shortRoot = mkdtempSync(path.join(path.dirname(path.dirname(bootstrap.socketPath)), 'wf-'));
      roots.push(shortRoot);
      await bootstrap.close();
      const state = seededState(shortRoot, 'r');
      const preferred = path.join(shortRoot, 'runs', state.runId, 'coordination.sock');
      expect(Buffer.byteLength(preferred, 'utf8')).toBeLessThanOrEqual(100);
      const parent = path.dirname(preferred);
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o755);
      const marker = path.join(parent, 'keep-run.txt');
      writeFileSync(marker, 'this directory existed before the bridge');
      await expect(CoordinationServer.start({ socketPath: preferred, runId: state.runId, db: state.store.db, createPrivateSocketDirectory: true })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(marker, 'utf8')).toBe('this directory existed before the bridge');
      expect(existsSync(preferred)).toBe(false);
      expect(coordinationSocketPath(state.root, state.runId)).toBe(preferred);
      const bridge = await start(state);
      expect(bridge.socketPath).toBe(preferred);
      const config = bridge.mcpConfigFor(state.attemptId);
      expect(await callCoordinator(config.socketPath, config.token, 'send_message', { body: 'preferred endpoint works' })).toMatchObject({ ok: true });
      await bridge.close();
      expect(existsSync(preferred)).toBe(false);
      expect(readFileSync(marker, 'utf8')).toBe('this directory existed before the bridge');
      expect(statSync(parent).mode & 0o777).toBe(0o755);
      expect(existsSync(state.paths.databasePath)).toBe(true);
    });
  });
});
