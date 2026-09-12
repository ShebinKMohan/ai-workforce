/**
 * The office's own functions on documents the real server returned for real
 * coordinator runs on the deterministic fake runtime (FR084). No payload here
 * is written by hand: each one is what a browser would have fetched.
 *
 * Three ways the page could show more than the database proves:
 * - a verifier pass the candidate manufactured (it rewrote the tests) drawn
 *   green on the receipt row;
 * - a coordinator killed mid-attempt whose rows still say `running`, drawn as
 *   live work;
 * - a failed run whose reason is visible only after opening it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.ts';
import { runCli } from '../../src/cli/index.ts';
import { startOfficeServer } from '../../src/server/index.ts';
import * as model from '../../web/office/src/office-model.js';
import { rawRequest, sleep } from '../server/support.ts';
import {
  claimDoneWithoutEditingScenario,
  cleanupAll,
  longRunningScenario,
  registerCleanup,
  rewriteTheTestsScenario,
  tempDir,
  useFixture,
  writeFakeAgentsConfig,
  writeScenario,
} from '../workspaces/support.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const AGENT = 'engineer';

async function invoke(argv) {
  let stdout = '';
  const sink = (append) => ({ write: (chunk) => { append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; } });
  const code = await runCli(argv, { stdout: sink((chunk) => (stdout += chunk)), stderr: sink(() => {}) });
  return { code, runId: JSON.parse(stdout.trim().split('\n').pop()).runId };
}

const get = async (server, target) => JSON.parse((await rawRequest(server, { path: target })).body);

/** Every tone the page could draw for one run, from the same functions the page calls. */
function tonesFor(runsDocument, summary, status) {
  const lock = runsDocument.coordinator?.lock;
  return [
    model.deskTone(model.deskState(AGENT, [summary], lock).state),
    model.runTone(summary, lock),
    model.acceptanceView(status, lock).tone,
    ...model.requirementViews(status).map((requirement) => requirement.tone),
    ...status.checks.map((check) => model.checkView(check, status, summary).tone),
  ];
}

afterAll(() => cleanupAll());

describe('failed runs, as the page receives them', () => {
  let server;
  const runIds = {};

  beforeAll(async () => {
    const stateDir = path.join(tempDir('workforce-office-payloads-'), 'state');
    const config = writeFakeAgentsConfig(tempDir('workforce-office-payloads-config-'));
    const previous = process.env[FAKE_SCENARIO_ENV];
    try {
      for (const [name, scenario] of [['rewrite', rewriteTheTestsScenario()], ['claimDone', claimDoneWithoutEditingScenario()]]) {
        const fixture = await useFixture('ts-bug');
        process.env[FAKE_SCENARIO_ENV] = writeScenario(scenario);
        const result = await invoke(['run', '--allow-unconfined-writes', '--repo', fixture.path, '--agents', config, '--task', 'Fix it.', '--state-dir', stateDir, '--json']);
        expect(result.code).toBe(4);
        runIds[name] = result.runId;
      }
    } finally {
      if (previous === undefined) delete process.env[FAKE_SCENARIO_ENV];
      else process.env[FAKE_SCENARIO_ENV] = previous;
    }
    server = await startOfficeServer({ stateRoot: stateDir, port: 0, discover: async () => [] });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it('draws the receipt of a criterion the candidate compromised in the compromised tone, never the verified one', async () => {
    const runs = await get(server, '/api/runs');
    const summary = runs.runs.find((entry) => entry.id === runIds.rewrite);
    const status = await get(server, `/api/runs/${runIds.rewrite}`);

    // The recorded facts: the verifier did execute the check and it did exit 0.
    expect(status.checks[0]).toMatchObject({ outcome: 'passed', evidenceProvenance: 'verifier_executed' });
    expect(status.requirements[0]).toMatchObject({ status: 'compromised', receiptId: status.checks[0].id });

    // The receipt row and the run summary both say what that pass is worth.
    expect(model.checkView(status.checks[0], status, summary)).toMatchObject({ tone: 'compromised', compromised: true });
    expect(summary.taskViews[0].receipts).toEqual({ verifierExecutedPassed: 0, verifierExecutedCompromised: 1, verifierExecutedFailed: 0, verifierExecutedOther: 0, otherProvenance: 0 });
    expect(summary.compromisedReceiptIds).toEqual([status.checks[0].id]);
    expect(tonesFor(runs, summary, status)).not.toContain('verified');
  });

  it('puts the reason for a failure on the desk and the collapsed run row', async () => {
    const runs = await get(server, '/api/runs');
    const rewrite = runs.runs.find((entry) => entry.id === runIds.rewrite);
    const claimDone = runs.runs.find((entry) => entry.id === runIds.claimDone);

    expect(rewrite.outcome).toMatchObject({ accepted: false, requiredPassed: 0, requiredTotal: 1, compromised: ['node-tests-pass'] });
    expect(model.runStatusLine(rewrite)).toBe('Failed · a criterion is compromised');
    expect(model.deskState(AGENT, [rewrite])).toMatchObject({ state: 'failed', label: 'Failed · a criterion is compromised' });

    expect(claimDone.outcome).toMatchObject({ accepted: false, requiredPassed: 0, requiredTotal: 1, compromised: [], failed: ['node-tests-pass'] });
    expect(model.runStatusLine(claimDone)).toBe('Failed · 0 of 1 required checks passed');
    expect(model.deskState(AGENT, [claimDone]).label).toBe('Failed · 0 of 1 required checks passed');
    // The newest run is what the desk reports; nothing about either run is green.
    expect(model.deskState(AGENT, runs.runs, runs.coordinator?.lock).runId).toBe(runIds.claimDone);
    const status = await get(server, `/api/runs/${runIds.claimDone}`);
    expect(tonesFor(runs, claimDone, status)).not.toContain('verified');
  });
});

describe('a coordinator that dies mid-attempt', () => {
  it('stops being shown as working once no coordinator holds the state root, although its rows still say running', async () => {
    const stateRoot = path.join(tempDir('workforce-office-killed-'), 'state');
    const config = writeFakeAgentsConfig(tempDir('workforce-office-killed-config-'));
    const fixture = await useFixture('ts-bug');
    const scenario = writeScenario(longRunningScenario(90_000));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, 'run', '--allow-unconfined-writes', '--repo', fixture.path, '--agents', config, '--task', 'Fix it.', '--state-dir', stateRoot, '--json'],
      { cwd: REPO_ROOT, detached: true, stdio: 'ignore', shell: false, env: { ...process.env, [FAKE_SCENARIO_ENV]: scenario, NODE_NO_WARNINGS: '1' } },
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    registerCleanup(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    const server = await startOfficeServer({ stateRoot, port: 0, discover: async () => [] });
    try {
      let runs = null;
      const working = Date.now() + 90_000;
      for (;;) {
        runs = await get(server, '/api/runs').catch(() => null);
        if (runs?.runs?.length && model.deskState(AGENT, runs.runs, runs.coordinator?.lock).state === 'working') break;
        if (Date.now() > working) throw new Error(`the run never showed as working: ${JSON.stringify(runs?.runs?.[0]?.taskViews ?? null)}`);
        await sleep(100);
      }

      process.kill(-child.pid, 'SIGKILL');
      await exited;
      const settle = Date.now() + 10_000;
      do {
        await sleep(100);
        runs = await get(server, '/api/runs');
      } while (runs.coordinator?.lock?.held !== false && Date.now() < settle);

      const summary = runs.runs[0];
      const lock = runs.coordinator?.lock;
      // The database still says the attempt is running: nothing reconciled it.
      expect(summary.state).toBe('running');
      expect(summary.taskViews[0].attempt.state).toBe('running');

      const desk = model.deskState(AGENT, runs.runs, lock);
      expect(desk.state).not.toBe('working');
      expect(desk).toMatchObject({ state: 'stalled', runId: summary.id });
      expect(model.deskTone(desk.state)).toBe('warning');
      expect(model.runTone(summary, lock)).not.toBe('active');
      expect(model.runStatusLine(summary, lock)).toMatch(/^Stalled · /);
      expect(model.phaseSteps(summary, lock).map((step) => step.status)).not.toContain('current');
      const status = await get(server, `/api/runs/${summary.id}`);
      expect(model.acceptanceView(status, lock).text).not.toMatch(/Not settled yet/);
      expect(lock).toMatchObject({ held: false, holder: 'dead' });
    } finally {
      await server.close();
    }
  }, 150_000);
});
