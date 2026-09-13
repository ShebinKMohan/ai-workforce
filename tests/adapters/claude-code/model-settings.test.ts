import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/adapters/claude-code/adapter.js';
import { isProcessAlive } from '../../../src/core/process.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(response: unknown, silent = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-catalog-test-'));
  roots.push(root);
  const script = path.join(root, 'cli.mjs');
  const log = path.join(root, 'frames.jsonl');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = ${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({cwd:process.cwd(), pid:process.pid, argv:process.argv.slice(2)})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const frame = JSON.parse(line); appendFileSync(log, JSON.stringify(frame)+'\\n');
 if (${silent}) return;
 if(frame.type !== 'control_request' || frame.request.subtype !== 'initialize') process.exitCode = 90;
 else process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:${JSON.stringify(response)}}})+'\\n');
});`);
  return {
    adapter: new ClaudeCodeAdapter({ executablePath: process.execPath, extraArgs: [script], startupTimeoutMs: silent ? 100 : 3_000, stopTimeoutMs: 250 }),
    records: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

describe('Claude reported model settings', () => {
  it('discovers aliases and per-model efforts in an isolated, stopped handshake with no user turn', async () => {
    const probe = fixture({ models: [
      { value: 'capable', displayName: 'Capable', resolvedModel: 'provider-capable', description: 'Reported model', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'basic', displayName: 'Basic', supportsEffort: false },
      { value: 'unknown', displayName: 'Unknown' },
    ] });
    const result = await probe.adapter.discoverSettings();
    expect(result.settings.models?.[0]).toMatchObject({ value: 'capable', displayName: 'Capable', resolvedModel: 'provider-capable', effortStatus: 'reported', effort: { offered: [{ value: 'low', provenance: 'reported' }, { value: 'high', provenance: 'reported' }], exhaustive: true } });
    expect(result.settings.models?.[1]).toMatchObject({ value: 'basic', effortStatus: 'reported', effort: { offered: [], exhaustive: true } });
    expect(result.settings.models?.[2]).toMatchObject({ value: 'unknown', effortStatus: 'unavailable', effort: { offered: [], exhaustive: false } });
    expect(result.settings.defaultModel).toBeUndefined();
    expect(result.settings.models?.every((model) => model.defaultEffort === undefined && model.isDefault === undefined)).toBe(true);
    expect(probe.adapter.validateSettings({ model: 'basic', effort: 'high' }).ok).toBe(false);
    expect(probe.adapter.validateSettings({ model: 'unknown', effort: 'high' }).effort.status).toBe('supported_unverified');
    const [start, ...frames] = probe.records();
    expect(start.cwd).not.toBe(process.cwd());
    expect(start.argv).toContain('--no-session-persistence');
    expect(start.argv.slice(start.argv.indexOf('--setting-sources'), start.argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(isProcessAlive(start.pid)).toBe(false);
    expect(existsSync(start.cwd)).toBe(false);
  });

  it('stops a silent initialization and retains no catalog', async () => {
    const probe = fixture({}, true);
    await expect(probe.adapter.discoverSettings()).rejects.toThrow(/did not answer/);
    const [start, ...frames] = probe.records();
    expect(frames).toHaveLength(1);
    expect(isProcessAlive(start.pid)).toBe(false);
    expect(existsSync(start.cwd)).toBe(false);
    expect(probe.adapter.capabilities().settings.models).toBeUndefined();
  });
});
