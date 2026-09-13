import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../../src/adapters/codex/adapter.js';
import { CodexRpcClient } from '../../../src/adapters/codex/rpc.js';
import { AdapterError } from '../../../src/adapters/types.js';
import { isProcessAlive, isProcessGroupAlive } from '../../../src/core/process.js';

interface DiscoveryObservation {
  kind: 'started' | 'frame' | 'closed';
  pid: number;
  cwd?: string;
  entries?: string[];
  frame?: { method: string; params?: Record<string, unknown> };
}

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Local JSON-RPC responder: its only allowed requests are metadata discovery. */
function discoveryServer(pages: readonly unknown[], requestTimeoutMs = 2_000) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wf-codex-model-test-')));
  roots.push(root);
  const configPath = path.join(root, 'pages.json');
  const observationPath = path.join(root, 'observations.jsonl');
  const scriptPath = path.join(root, 'model-server.mjs');
  const setPages = (next: readonly unknown[]) => writeFileSync(configPath, JSON.stringify(next));
  setPages(pages);
  writeFileSync(scriptPath, `
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [configPath, observationPath] = process.argv.slice(2);
const pages = JSON.parse(readFileSync(configPath, 'utf8'));
const record = (value) => appendFileSync(observationPath, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
record({ kind: 'started', cwd: process.cwd(), entries: readdirSync(process.cwd()) });
let page = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  record({ kind: 'frame', frame });
  if (frame.method === 'initialized') return;
  let response;
  let delayMs = 0;
  if (frame.method === 'initialize') response = { result: { userAgent: 'local metadata test' } };
  else if (frame.method === 'model/list') {
    const value = pages[page++];
    delayMs = value?.delayMs ?? 0;
    response = value?.rpcError ? { error: value.rpcError } : { result: value?.delayedResult ?? value };
  } else response = { error: { code: -32601, message: 'No model turns permitted in settings discovery' } };
  const reply = () => process.stdout.write(JSON.stringify({ id: frame.id, ...response }) + '\\n');
  if (delayMs > 0) setTimeout(reply, delayMs);
  else reply();
});
lines.on('close', () => {
  record({ kind: 'closed' });
  process.exit(0);
});
`);
  return {
    adapter: new CodexAdapter({
      executablePath: process.execPath,
      appServerArgs: [scriptPath, configPath, observationPath],
      startupTimeoutMs: 2_000,
      requestTimeoutMs,
      stopTimeoutMs: 500,
    }),
    setPages,
    observations: (): DiscoveryObservation[] => readFileSync(observationPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as DiscoveryObservation),
  };
}

function page(data: readonly unknown[], nextCursor: string | null = null) {
  return { data, nextCursor };
}

function assertPassiveAndStopped(observations: readonly DiscoveryObservation[]) {
  const starts = observations.filter((record) => record.kind === 'started');
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) {
    expect(start.cwd).not.toBe(realpathSync(process.cwd()));
    expect(start.entries).toEqual([]);
    expect(existsSync(start.cwd!)).toBe(false);
    expect(isProcessAlive(start.pid)).toBe(false);
    expect(isProcessGroupAlive(start.pid)).toBe(false);
    expect(observations.some((record) => record.kind === 'closed' && record.pid === start.pid)).toBe(true);
  }
  const methods = observations.filter((record) => record.kind === 'frame').map((record) => record.frame!.method);
  expect(methods.every((method) => ['initialize', 'initialized', 'model/list'].includes(method))).toBe(true);
}

describe('codex model settings discovery (FR002, FR006)', () => {
  it('reads every page without a model turn and preserves model metadata and the explicit default', async () => {
    const server = discoveryServer([
      page([
        { id: 'catalog-alpha', model: 'alpha', displayName: 'Alpha', description: 'Fast edits', isDefault: false,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick pass' }] },
        { id: 'hidden', model: 'hidden', hidden: true, isDefault: true },
      ], 'page-two'),
      page([{ id: 'beta', model: 'beta', displayName: 'Beta', description: 'Deeper analysis', isDefault: true,
        defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More reasoning' }] }]),
    ]);

    const settings = await server.adapter.discoverSettings();

    expect(settings.model.exhaustive).toBe(true);
    expect(settings.model.offered.map((entry) => entry.value)).toEqual(['alpha', 'beta']);
    expect(settings.defaultModel).toBe('beta');
    expect(settings.models).toEqual([
      expect.objectContaining({ value: 'alpha', catalogId: 'catalog-alpha', resolvedModel: 'alpha', provenance: 'reported',
        displayName: 'Alpha', description: 'Fast edits', isDefault: false, defaultEffort: 'low',
        supportsEffort: true, effortStatus: 'reported',
        effort: { offered: [{ value: 'low', provenance: 'reported', note: 'Quick pass' }], exhaustive: true } }),
      expect.objectContaining({ value: 'beta', resolvedModel: 'beta', provenance: 'reported', displayName: 'Beta',
        description: 'Deeper analysis', isDefault: true, defaultEffort: 'high', supportsEffort: true, effortStatus: 'reported',
        effort: { offered: [{ value: 'high', provenance: 'reported', note: 'More reasoning' }], exhaustive: true } }),
    ]);
    expect(settings.effort).toEqual({ offered: [{ value: 'high', provenance: 'reported', note: 'More reasoning' }], exhaustive: true });
    expect(server.adapter.validateSettings({ model: 'alpha', effort: 'high' })).toMatchObject({ ok: false, effort: { status: 'unsupported' } });
    const observations = server.observations();
    expect(observations.filter((record) => record.frame?.method === 'model/list').map((record) => record.frame?.params?.['cursor'] ?? null))
      .toEqual([null, 'page-two']);
    assertPassiveAndStopped(observations);
  });

  it('distinguishes missing effort metadata from explicitly no supported effort and never forms a union', async () => {
    const server = discoveryServer([page([
      { id: 'unknown-effort', displayName: 'Unknown effort' },
      { id: 'no-effort', supportedReasoningEfforts: [] },
      { id: 'high-only', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ])]);

    const settings = await server.adapter.discoverSettings();

    expect(settings.defaultModel).toBeUndefined();
    expect(settings.effort).toEqual({ offered: [], exhaustive: false });
    expect(settings.models).toEqual([
      expect.objectContaining({ value: 'unknown-effort', effortStatus: 'unavailable', effort: { offered: [], exhaustive: false } }),
      expect.objectContaining({ value: 'no-effort', supportsEffort: false, effortStatus: 'reported', effort: { offered: [], exhaustive: true } }),
      expect.objectContaining({ value: 'high-only', supportsEffort: true, effortStatus: 'reported',
        effort: { offered: [{ value: 'high', provenance: 'reported' }], exhaustive: true } }),
    ]);
    expect(settings.models?.[0]).not.toHaveProperty('supportsEffort');
    expect(settings.models?.[0]).not.toHaveProperty('resolvedModel');
    expect(server.adapter.validateSettings({ model: 'unknown-effort', effort: 'high' })).toMatchObject({ effort: { status: 'supported_unverified' } });
    expect(server.adapter.validateSettings({ model: 'no-effort', effort: 'high' })).toMatchObject({ ok: false, effort: { status: 'unsupported' } });
    assertPassiveAndStopped(server.observations());
  });

  it('preserves reported input modalities without applying schema defaults to missing metadata', async () => {
    const server = discoveryServer([page([
      { id: 'multimodal', inputModalities: ['text', 'image', 'audio'] },
      { id: 'text-only', inputModalities: ['text'] },
      { id: 'none-reported', inputModalities: [] },
      { id: 'unknown' },
    ])]);

    const settings = await server.adapter.discoverSettings();

    expect(settings.models?.[0]).toMatchObject({ inputModalities: ['text', 'image', 'audio'] });
    expect(settings.models?.[1]).toMatchObject({ inputModalities: ['text'] });
    expect(settings.models?.[2]).toMatchObject({ inputModalities: [] });
    expect(settings.models?.[3]).not.toHaveProperty('inputModalities');
    assertPassiveAndStopped(server.observations());
  });

  it('keeps default effort unavailable when the explicit default omits its effort list', async () => {
    const server = discoveryServer([page([
      { id: 'default', isDefault: true },
      { id: 'other', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ])]);

    const settings = await server.adapter.discoverSettings();

    expect(settings.defaultModel).toBe('default');
    expect(settings.effort).toEqual({ offered: [], exhaustive: false });
    expect(server.adapter.validateSettings({ effort: 'high' })).toMatchObject({ effort: { status: 'supported_unverified' } });
    assertPassiveAndStopped(server.observations());
  });

  it('does not guess a runtime default when the catalog reports multiple defaults', async () => {
    const server = discoveryServer([page([
      { id: 'alpha', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { id: 'beta', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ])]);

    const settings = await server.adapter.discoverSettings();

    expect(settings.defaultModel).toBeUndefined();
    expect(settings.effort).toEqual({ offered: [], exhaustive: false });
    assertPassiveAndStopped(server.observations());
  });

  it('accepts a complete catalog ending at the twentieth page', async () => {
    const server = discoveryServer(Array.from({ length: 20 }, (_, index) => page([{ id: `model-${index}` }], index === 19 ? null : `page-${index + 1}`)));

    const settings = await server.adapter.discoverSettings();

    expect(settings.model.offered).toHaveLength(20);
    expect(settings.model.offered.at(-1)?.value).toBe('model-19');
    expect(server.observations().filter((record) => record.frame?.method === 'model/list')).toHaveLength(20);
    assertPassiveAndStopped(server.observations());
  });

  it.each([
    { name: 'a repeated pagination cursor', pages: [page([{ id: 'partial-a' }], 'repeat'), page([{ id: 'partial-b' }], 'repeat')], requests: 2 },
    { name: 'a malformed second page', pages: [page([{ id: 'partial' }], 'next'), { data: 'invalid' }], requests: 2 },
    { name: 'a second-page RPC failure', pages: [page([{ id: 'partial' }], 'next'), { rpcError: { code: -32603, message: 'catalog unavailable' } }], requests: 2 },
    { name: 'a catalog extending beyond twenty pages', pages: Array.from({ length: 21 }, (_, index) => page([{ id: `partial-${index}` }], `page-${index + 1}`)), requests: 20 },
  ])('rejects $name without replacing a prior complete catalog', async ({ pages, requests }) => {
    const server = discoveryServer([page([{ id: 'known', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }])]);
    const prior = await server.adapter.discoverSettings();
    server.setPages(pages);

    const failure = await server.adapter.discoverSettings().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdapterError);
    expect(failure).toMatchObject({ startupStopReceipt: { state: 'process_tree_terminated' } });
    expect(server.adapter.capabilities().settings).toEqual(prior);
    expect(server.adapter.validateSettings({ model: 'known', effort: 'low' }).ok).toBe(true);
    const observations = server.observations();
    expect(observations.filter((record) => record.frame?.method === 'model/list')).toHaveLength(requests + 1);
    assertPassiveAndStopped(observations);
  });

  it('does not publish a replacement catalog or delete its scratch path when process settlement is unknown', async () => {
    const server = discoveryServer([page([{ id: 'known' }])]);
    const prior = await server.adapter.discoverSettings();
    server.setPages([page([{ id: 'replacement' }])]);
    const stop = CodexRpcClient.prototype.stop;
    vi.spyOn(CodexRpcClient.prototype, 'stop').mockImplementationOnce(async function (this: CodexRpcClient) {
      await stop.call(this);
      // The real fake process stops; only the receipt is uncertain, so this
      // failure-path test cannot intentionally leave a process running.
      return { signalled: null, exited: true, groupAlive: true };
    });

    const failure = await server.adapter.discoverSettings().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdapterError);
    expect(failure).toMatchObject({ startupStopReceipt: { state: 'unknown' } });
    expect(server.adapter.capabilities().settings).toEqual(prior);
    const start = server.observations().filter((record) => record.kind === 'started').at(-1)!;
    expect(isProcessAlive(start.pid)).toBe(false);
    expect(start.cwd).not.toBe(realpathSync(process.cwd()));
    expect(path.dirname(start.cwd!)).toBe(realpathSync(os.tmpdir()));
    expect(existsSync(start.cwd!)).toBe(true);
    roots.push(start.cwd!);
  });

  it('shares one discovery deadline across pages instead of resetting the timeout on every response', async () => {
    const server = discoveryServer([page([{ id: 'known' }])], 250);
    const prior = await server.adapter.discoverSettings();
    server.setPages([
      { delayMs: 160, delayedResult: page([{ id: 'partial-a' }], 'next') },
      { delayMs: 160, delayedResult: page([{ id: 'partial-b' }]) },
    ]);

    const failure = await server.adapter.discoverSettings().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdapterError);
    expect(failure).toMatchObject({ startupStopReceipt: { state: 'process_tree_terminated' } });
    expect(server.adapter.capabilities().settings).toEqual(prior);
    expect(server.observations().filter((record) => record.frame?.method === 'model/list')).toHaveLength(3);
    assertPassiveAndStopped(server.observations());
  });
});
