import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { defaultFakeRuntimeScript, FakeAdapter } from '../../src/adapters/index.js';
import type { SessionHandle, SessionInput, StopReceipt } from '../../src/adapters/types.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { runDirect } from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { cleanupAll, fingerprintCheckout, fixTheBugScenario, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

const stores: ReturnType<typeof openStateStore>[] = [];
const runtimes: RecordingRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) for (const session of runtime.sessions) await runtime.stopOwnedProcesses(session);
  for (const store of stores.splice(0)) store.close();
  cleanupAll();
});

class RecordingRuntime extends FakeAdapter {
  input: SessionInput | undefined;
  stoppedAt = 0;
  readonly sessions: SessionHandle[] = [];

  override async openSession(input: SessionInput): Promise<SessionHandle> {
    this.input = input;
    const session = await super.openSession(input);
    this.sessions.push(session);
    return session;
  }

  override async stopOwnedProcesses(handle: SessionHandle): Promise<StopReceipt> {
    const receipt = await super.stopOwnedProcesses(handle);
    this.stoppedAt = Date.now();
    return receipt;
  }
}

async function harness(label: string) {
  const project = await useFixture('ts-bug');
  const loaded = loadAgentConfigFile(writeFakeAgentsConfig(tempDir()));
  const paths = createStatePaths(tempDir(`wf-resource-${label}-`));
  const store = openStateStore(paths, { mode: 'mutating' });
  stores.push(store);
  const wrapper = path.join(tempDir('wf-resource-runtime-'), 'runtime.mjs');
  writeFileSync(wrapper, `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
writeFileSync(path.join(process.env.TMPDIR, 'spawn-receipt.json'), JSON.stringify({
  cwd: process.cwd(), tmpdir: process.env.TMPDIR, tmp: process.env.TMP, temp: process.env.TEMP,
  context: process.env.WORKFORCE_TEST_CONTEXT, pid: process.pid, startedAt: Date.now()
}));
await import(${JSON.stringify(pathToFileURL(defaultFakeRuntimeScript()).href)});
`);
  const scenario = writeScenario({ scenarioVersion: 1, steps: [{ action: 'sleep', ms: 500 }, ...fixTheBugScenario().steps!] });
  const execute = async () => {
    const runtime = new RecordingRuntime({ scriptPath: wrapper, scenarioPath: scenario });
    runtimes.push(runtime);
    const result = await runDirect({
      repoPath: project.path, config: loaded.config, configRaw: loaded.raw, configPath: loaded.path,
      requestText: `Fix the pagination bug for project ${label}.`, requestSource: 'test',
      db: store.db, paths, allowUnconfinedWrites: true, coordinationEnabled: false,
      // A caller's shared temp setting must not bypass per-attempt isolation.
      sessionEnv: { TMPDIR: '/tmp/shared-workforce-temp', TMP: '/tmp/shared-workforce-temp', TEMP: '/tmp/shared-workforce-temp', WORKFORCE_TEST_CONTEXT: label },
      adapterFactory: () => runtime,
    });
    return { runtime, result };
  };
  return { project, execute };
}

it('concurrent projects and a later attempt get distinct writable temp roots in the actual runtime child', async () => {
  const [left, right] = await Promise.all([harness('left'), harness('right')]);
  const before = await Promise.all([fingerprintCheckout(left.project.path), fingerprintCheckout(right.project.path)]);
  const executions = await Promise.all([left.execute(), right.execute()]);
  const receipts = executions.map(({ runtime, result }, index) => {
    expect(result.outcome).toBe('accepted');
    expect(result.snapshot?.changedFiles).toEqual(['src/pagination.js']);
    const input = runtime.input!;
    const scratch = input.env!['TMPDIR']!;
    expect(input.allowedWritePaths).toContain(scratch);
    expect(input.allowedWritePaths).not.toContain(`${input.cwd}.git`);
    expect(scratch).not.toBe(input.cwd);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    const receipt = JSON.parse(readFileSync(path.join(scratch, 'spawn-receipt.json'), 'utf8')) as Record<string, string | number>;
    expect(receipt['cwd']).toBe(input.cwd);
    expect(receipt['tmpdir']).toBe(scratch);
    expect(receipt['tmp']).toBe(scratch);
    expect(receipt['temp']).toBe(scratch);
    expect(receipt['context']).toBe(index === 0 ? 'left' : 'right');
    return receipt;
  });
  expect(receipts[0]!['tmpdir']).not.toBe(receipts[1]!['tmpdir']);
  expect(executions[0]!.runtime.sessions[0]!.sessionId).not.toBe(executions[1]!.runtime.sessions[0]!.sessionId);
  expect(Math.max(...receipts.map(receipt => Number(receipt['startedAt'])))).toBeLessThan(Math.min(...executions.map(execution => execution.runtime.stoppedAt)));
  const later = await left.execute();
  expect(later.result.outcome).toBe('accepted');
  expect(later.runtime.input!.env!['TMPDIR']).not.toBe(receipts[0]!['tmpdir']);
  expect(await fingerprintCheckout(left.project.path)).toEqual(before[0]);
  expect(await fingerprintCheckout(right.project.path)).toEqual(before[1]);
});
