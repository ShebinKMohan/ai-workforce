import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SCENARIO_ENV, FakeAdapter, type SessionHandle, type SessionInput, type StopReceipt } from '../../src/adapters/index.js';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { isProcessAlive, isProcessGroupAlive } from '../../src/core/process.js';
import { runPlanned } from '../../src/core/run-planned.js';
import { listEvents } from '../../src/storage/events.js';
import { openTempState } from '../helpers/state.js';
import { cleanupAll, tempDir, useFixture, writeFakeAgentsConfig, writeScenario } from '../workspaces/support.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The analysis lifecycle fixture did not reach its barrier.')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

afterEach(cleanupAll);

describe('concurrent analysis ownership', () => {
  it('waits for both owned processes to stop when a worker observer fails while its peer is live', async () => {
    const fixture = await useFixture('ts-bug');
    const state = openTempState();
    const configPath = writeFakeAgentsConfig(tempDir('analysis-lifecycle-config-'), { planner: true });
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    raw.agents.push({ ...raw.agents[0], id: 'peer' });
    writeFileSync(configPath, JSON.stringify(raw));
    const loaded = loadAgentConfigFile(configPath);
    const bothOpened = deferred();
    const peerStopRequested = deferred();
    const releasePeerStop = deferred();
    const sessions = new Map<string, SessionHandle>();
    const adapters = new Map<string, OwnedFake>();
    const receipts = new Map<string, StopReceipt>();
    const scenario = writeScenario({ scenarioVersion: 1, steps: [{ action: 'sleep', ms: 60_000 }] });

    // These are real owned fake-runtime child processes. The barriers control
    // lifecycle ordering only; no simulated source report is accepted here.
    class OwnedFake extends FakeAdapter {
      private stopping: Promise<StopReceipt> | undefined;
      constructor(readonly taskId: string) { super(); }
      override async openSession(input: SessionInput): Promise<SessionHandle> {
        const handle = await super.openSession({ ...input, env: { ...input.env, [FAKE_SCENARIO_ENV]: scenario } });
        sessions.set(this.taskId, handle);
        if (sessions.size === 2) bothOpened.resolve();
        await bothOpened.promise;
        return handle;
      }
      override stopOwnedProcesses(handle: SessionHandle): Promise<StopReceipt> {
        return this.stopping ??= (async () => {
          if (this.taskId === 'peer-task') {
            peerStopRequested.resolve();
            await releasePeerStop.promise;
          }
          const receipt = await super.stopOwnedProcesses(handle);
          receipts.set(this.taskId, receipt);
          return receipt;
        })();
      }
    }

    let observerBroken = false;
    let peerWasLiveAtFailure = false;
    let settled = false;
    const running = runPlanned({
      workKind: 'analysis', repoPath: fixture.path, config: loaded.config, configPath,
      configRaw: readFileSync(configPath, 'utf8'), requestText: 'Inspect both areas of the source without changing files.', requestSource: 'test',
      tasks: [
        { key: 'first', taskId: 'first-task', agentId: 'engineer', objective: 'Inspect pagination.', writer: false },
        { key: 'peer', taskId: 'peer-task', agentId: 'peer', objective: 'Inspect search.', writer: false },
      ],
      db: state.store.db, paths: state.paths, coordinationEnabled: false,
      headReview: { headAgentId: 'planner', required: true }, allowUnconfinedWrites: true, runDeadlineMs: 60_000,
      adapterFactory: (_runtime, context) => {
        const adapter = new OwnedFake(context.taskId);
        adapters.set(context.taskId, adapter);
        return adapter;
      },
      stream: { line: () => undefined, event: event => {
        if (event['taskId'] !== 'first-task') return;
        if (event['type'] === 'analysis.session_opened') {
          peerWasLiveAtFailure = isProcessAlive(sessions.get('peer-task')!.processId!);
          observerBroken = true;
        }
        // Keep this subscriber broken through the stop notification to exercise
        // orchestration's rejected-promise drain, not just a failed task result.
        if (observerBroken) throw new Error('Injected worker observer failure.');
      } },
    });
    void running.then(() => { settled = true; }, () => { settled = true; });

    try {
      await bounded(peerStopRequested.promise);
      await setImmediate();
      expect(sessions.size).toBe(2);
      expect(peerWasLiveAtFailure).toBe(true);
      expect(receipts.get('first-task')?.state).toBe('process_tree_terminated');
      expect(isProcessAlive(sessions.get('first-task')!.processId!)).toBe(false);
      expect(isProcessAlive(sessions.get('peer-task')!.processId!)).toBe(true);
      expect(settled).toBe(false);

      releasePeerStop.resolve();
      const result = await bounded(running);
      expect(result).toMatchObject({ outcome: 'failed', accepted: false, analysisReviewed: false });
      expect(result.reason).toContain('Injected worker observer failure');
      expect(receipts.size).toBe(2);
      for (const [taskId, session] of sessions) {
        expect(receipts.get(taskId)?.state).toBe('process_tree_terminated');
        expect(isProcessAlive(session.processId!)).toBe(false);
        expect(isProcessGroupAlive(session.processId!)).toBe(false);
      }
      const events = listEvents(state.store.db, result.runId);
      const peerStopped = events.find(event => event.taskId === 'peer-task' && event.type === 'analysis.session_stopped');
      const failed = events.find(event => event.type === 'run.failed');
      expect(peerStopped).toBeDefined();
      expect(failed).toBeDefined();
      expect(peerStopped!.sequence).toBeLessThan(failed!.sequence);
    } finally {
      bothOpened.resolve();
      releasePeerStop.resolve();
      await bounded(running).catch(() => undefined);
      await Promise.allSettled([...sessions].map(([taskId, handle]) => adapters.get(taskId)!.stopOwnedProcesses(handle)));
      state.cleanup();
    }
  }, 30_000);
});
