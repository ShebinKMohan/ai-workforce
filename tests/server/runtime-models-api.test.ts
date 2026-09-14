import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyWorkspace, type WorkspaceConfig } from '../../src/core/workspace-config.js';
import { capabilitiesFor } from '../../src/discovery/capabilities.js';
import type { RuntimeModelCatalog } from '../../src/discovery/model-catalog.js';
import type { RuntimeReadinessReport } from '../../src/discovery/readiness.js';
import { startOfficeServer, type OfficeServer, type OfficeServerOptions } from '../../src/server/index.js';
import { workspaceFilePath } from '../../src/workspace/paths.js';
import { cleanupAll, tempDir } from '../workspace/helpers.js';
import { rawRequest } from './support.js';

const servers: OfficeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
  cleanupAll();
});

const RUNTIME_ID = 'custom-codex';
const MODEL_PATH = `/api/runtimes/${RUNTIME_ID}/models`;
type ModelDiscovery = NonNullable<OfficeServerOptions['modelCatalog']>;

function readiness(config: WorkspaceConfig): RuntimeReadinessReport {
  const binding = config.runtimes[RUNTIME_ID]!;
  return {
    runtimeId: RUNTIME_ID, adapter: 'codex', configuredExecutable: binding.executable,
    executable: binding.executable, realPath: `${binding.executable}-resolved`, version: '0.147.0',
    installed: true, adapterSupported: true, controllable: true, auth: 'logged_in', readiness: 'controllable',
    capabilities: capabilitiesFor('codex', '0.147.0'), checkedAt: new Date().toISOString(),
    displayName: 'Fixture Codex', minimumSupportedVersion: '0.1.0', installations: [
      { path: binding.executable, realPath: `${binding.executable}-resolved`, source: 'override', origins: ['configured binding'], selected: true },
      { path: '/fixture/Desktop.app/Contents/Resources/codex', realPath: '/fixture/Desktop.app/Contents/Resources/codex', source: 'known_location', origins: ['desktop bundle'], selected: false },
    ], searchedLocations: [],
    probes: [], probeKind: 'passive', authDetail: 'Injected passive readiness; no installed CLI was probed.',
    missingControls: [], missingWriteBoundary: [], writingModeAvailable: true, diagnostics: [],
  };
}

function catalog(input: Parameters<ModelDiscovery>[0], model = 'fixture-model'): RuntimeModelCatalog {
  return {
    runtimeId: input.runtimeId, adapter: input.runtime.adapter,
    configuredExecutable: input.runtime.executable, executable: input.runtime.executable,
    resolvedExecutable: `${input.runtime.executable}-resolved`, version: '0.147.0', checkedAt: new Date().toISOString(),
    status: 'available', defaultModel: model,
    models: [{ id: model, label: 'Fixture model', efforts: ['low', 'medium'], defaultEffort: 'medium', isDefault: true, effortStatus: 'reported' }],
    diagnostics: ['Injected control-handshake metadata; no model turn was started.'],
  };
}

async function office(implementation: ModelDiscovery = async input => catalog(input)) {
  const stateRoot = tempDir('workforce-model-api-');
  const config = emptyWorkspace();
  config.runtimes[RUNTIME_ID] = { adapter: 'codex', executable: '/fixture/bin/custom-codex', model: 'saved-model', effort: 'low' };
  const file = workspaceFilePath(stateRoot);
  const save = () => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(config)); };
  save();
  const discover = vi.fn(async () => [readiness(config)]);
  const modelCatalog = vi.fn(implementation);
  const spawner = vi.fn(() => { throw new Error('Model-catalog reads must never dispatch a run.'); });
  const server = await startOfficeServer({ stateRoot, port: 0, discover, modelCatalog, spawner });
  servers.push(server);
  return { server, config, save, discover, modelCatalog, spawner };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('installed model catalogs through the loopback API', () => {
  it('exposes discovered installation paths and refreshes them without registering or launching a runtime', async () => {
    const target = await office();
    const initial = JSON.parse((await rawRequest(target.server, { path: '/api/workspace' })).body);
    expect(initial.runtimes.reports[0].installations).toEqual(readiness(target.config).installations);
    expect((await rawRequest(target.server, { path: '/api/workspace' })).status).toBe(200);
    expect(target.discover).toHaveBeenCalledTimes(1);
    const refreshed = JSON.parse((await rawRequest(target.server, { path: '/api/workspace?refresh=1' })).body);
    expect(refreshed.runtimes.reports[0].installations[1].selected).toBe(false);
    expect(Object.keys(refreshed.workspace.runtimes)).toEqual([RUNTIME_ID]);
    expect(target.discover).toHaveBeenCalledTimes(2);
    expect(target.modelCatalog).not.toHaveBeenCalled();
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('uses only the saved binding and returns its discovered model/effort metadata', async () => {
    const target = await office();
    const response = await rawRequest(target.server, { path: `${MODEL_PATH}?executable=/attacker/bin/cli&adapter=claude-code` });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      runtimeId: RUNTIME_ID, adapter: 'codex', configuredExecutable: '/fixture/bin/custom-codex',
      status: 'available', models: [{ id: 'fixture-model', efforts: ['low', 'medium'], defaultEffort: 'medium', effortStatus: 'reported' }],
    });
    expect(target.modelCatalog).toHaveBeenCalledTimes(1);
    const input = target.modelCatalog.mock.calls[0]![0];
    expect(input.runtimeId).toBe(RUNTIME_ID);
    expect(input.runtime).toEqual(target.config.runtimes[RUNTIME_ID]);
    expect(input.reports).toEqual([expect.objectContaining({ runtimeId: RUNTIME_ID, configuredExecutable: '/fixture/bin/custom-codex', probeKind: 'passive' })]);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('refuses unknown bindings and hostile reads before any discovery', async () => {
    const target = await office();
    expect((await rawRequest(target.server, { path: '/api/runtimes/not-configured/models' })).status).toBe(404);
    expect((await rawRequest(target.server, { path: MODEL_PATH, headers: { host: `attacker.example:${target.server.port}` } })).status).toBe(403);
    expect((await rawRequest(target.server, { path: MODEL_PATH, headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect(target.discover).not.toHaveBeenCalled();
    expect(target.modelCatalog).not.toHaveBeenCalled();
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('coalesces concurrent catalog reads and reuses passive readiness and model results', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const target = await office(async input => { entered.resolve(); await release.promise; return catalog(input); });
    const first = rawRequest(target.server, { path: MODEL_PATH });
    await entered.promise;
    const second = rawRequest(target.server, { path: MODEL_PATH });
    const workspace = await rawRequest(target.server, { path: '/api/workspace' });
    expect(workspace.status).toBe(200);
    release.resolve();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(JSON.parse(responses[0]!.body)).toEqual(JSON.parse(responses[1]!.body));
    expect((await rawRequest(target.server, { path: MODEL_PATH })).status).toBe(200);
    expect(target.discover).toHaveBeenCalledTimes(1);
    expect(target.modelCatalog).toHaveBeenCalledTimes(1);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('expires the cache after five minutes without needing a page-server restart', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const target = await office();
    expect((await rawRequest(target.server, { path: MODEL_PATH })).status).toBe(200);
    clock += 5 * 60 * 1000 - 1;
    expect((await rawRequest(target.server, { path: MODEL_PATH })).status).toBe(200);
    expect(target.discover).toHaveBeenCalledTimes(1);
    expect(target.modelCatalog).toHaveBeenCalledTimes(1);
    clock += 2;
    expect((await rawRequest(target.server, { path: MODEL_PATH })).status).toBe(200);
    expect(target.discover).toHaveBeenCalledTimes(2);
    expect(target.modelCatalog).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit catalog refresh while ordinary reads use the refreshed result', async () => {
    let count = 0;
    const target = await office(async input => catalog(input, `fixture-model-${++count}`));
    const initial = JSON.parse((await rawRequest(target.server, { path: MODEL_PATH })).body);
    const refreshed = JSON.parse((await rawRequest(target.server, { path: `${MODEL_PATH}?refresh=1` })).body);
    const reused = JSON.parse((await rawRequest(target.server, { path: MODEL_PATH })).body);
    expect(initial.models[0].id).toBe('fixture-model-1');
    expect(refreshed.models[0].id).toBe('fixture-model-2');
    expect(reused).toEqual(refreshed);
    expect(target.modelCatalog).toHaveBeenCalledTimes(2);
    expect(target.spawner).not.toHaveBeenCalled();
  });

  it('invalidates the catalog when its saved executable changes outside the server', async () => {
    const target = await office();
    expect((await rawRequest(target.server, { path: MODEL_PATH })).status).toBe(200);
    target.config.runtimes[RUNTIME_ID] = { adapter: 'codex', executable: '/fixture/bin/replacement-codex' };
    target.config.revision += 1;
    target.save();
    const response = await rawRequest(target.server, { path: MODEL_PATH });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ configuredExecutable: '/fixture/bin/replacement-codex' });
    expect(target.discover).toHaveBeenCalledTimes(2);
    expect(target.modelCatalog).toHaveBeenCalledTimes(2);
    expect(target.modelCatalog.mock.calls[1]![0]).toMatchObject({
      runtime: { adapter: 'codex', executable: '/fixture/bin/replacement-codex' },
      reports: [expect.objectContaining({ configuredExecutable: '/fixture/bin/replacement-codex' })],
    });
  });

  it('does not let a late response for a replaced binding become the new binding catalog', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const target = await office(async input => {
      if (input.runtime.executable === '/fixture/bin/custom-codex') { entered.resolve(); await release.promise; }
      return catalog(input);
    });
    const initial = rawRequest(target.server, { path: MODEL_PATH });
    await entered.promise;
    target.config.runtimes[RUNTIME_ID] = { adapter: 'codex', executable: '/fixture/bin/new-codex' };
    target.config.revision += 1;
    target.save();
    const changed = await rawRequest(target.server, { path: MODEL_PATH });
    expect(changed.status).toBe(200);
    expect(JSON.parse(changed.body)).toMatchObject({ configuredExecutable: '/fixture/bin/new-codex' });
    release.resolve();
    await initial;
    const later = await rawRequest(target.server, { path: MODEL_PATH });
    expect(JSON.parse(later.body)).toMatchObject({ configuredExecutable: '/fixture/bin/new-codex' });
    expect(target.modelCatalog).toHaveBeenCalledTimes(2);
  });
});
