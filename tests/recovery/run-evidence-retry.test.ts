import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEvidenceView } from '../../src/storage/run-evidence.js';
import { writeArtifact } from '../../src/storage/artifacts.js';
import { beginNewGeneration, insertAttempt } from '../../src/storage/records.js';
import { openTempState, seedRunAndTask } from '../helpers/state.js';
import { snapshotHash } from './support.js';

describe('direct retry evidence projection', () => {
  it('selects only the immutable current-generation result, preserves old failure, and fails closed if successor evidence is missing or altered', () => {
    const state = openTempState(); const { run, task } = seedRunAndTask(state);
    try {
      const hash = snapshotHash(state);
      const original = insertAttempt(state.store.db, { taskId: task.id, agentSnapshotHash: hash });
      const manifest = (attemptId: string, accepted: boolean) => ({ runId: run.id, taskId: task.id, attemptId, requirements: [], acceptance: { accepted, requiredTotal: 1, requiredPassed: accepted ? 1 : 0, reasons: [] } });
      const publish = (attemptId: string, relativePath: string, accepted: boolean) => writeArtifact(state.store.db, state.paths, { runId: run.id, taskId: task.id, attemptId, type: 'result', relativePath, bytes: JSON.stringify(manifest(attemptId, accepted)), provenance: { producer: 'test' } });
      publish(original.id, 'result.json', false);
      const oldPath = path.join(state.paths.runArtifactsDir(run.id), 'result.json'); const oldBytes = readFileSync(oldPath, 'utf8');
      beginNewGeneration(state.store.db, task.id);
      const successor = insertAttempt(state.store.db, { taskId: task.id, agentSnapshotHash: hash });
      expect(runEvidenceView(state.store, run.id).outcome).toBeNull();
      const target = `tasks/${successor.id}/result.json`; publish(successor.id, target, true);
      expect(runEvidenceView(state.store, run.id)).toMatchObject({ manifest: { attemptId: successor.id }, outcome: { accepted: true } });
      expect(readFileSync(oldPath, 'utf8')).toBe(oldBytes);
      writeFileSync(path.join(state.paths.runArtifactsDir(run.id), target), JSON.stringify(manifest(successor.id, false)));
      expect(runEvidenceView(state.store, run.id).outcome).toBeNull();
      expect(runEvidenceView(state.store, run.id).evidenceIssues.length).toBeGreaterThan(0);
    } finally { state.cleanup(); }
  });
});
