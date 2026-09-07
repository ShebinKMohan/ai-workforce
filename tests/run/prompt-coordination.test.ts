/**
 * A worker cannot address a peer it was never told about.
 *
 * `send_message` needs a peer's TASK ID and the coordinator refuses an unknown
 * recipient, so a prompt that names neither this task nor its peers makes the
 * peer channel unusable however well the tools are advertised (AT05).
 */
import { describe, expect, it } from 'vitest';
import { composeTaskPrompt } from '../../src/core/run-direct.js';
import { sampleContract } from '../helpers/state.js';

const WORKSPACE = {
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  projectRoot: '/repo',
  path: '/workspaces/run-1/task-1',
  branch: 'workforce/candidate-1',
  baseRevision: 'a'.repeat(40),
  gitAdminDir: null,
  excludedUncommittedChanges: null,
  createdAt: new Date().toISOString(),
};

const INSPECTION = {
  branch: 'main',
  hasSubmodules: false,
  submodulePaths: [] as string[],
} as unknown as Parameters<typeof composeTaskPrompt>[0]['inspection'];

function prompt(coordination: Parameters<typeof composeTaskPrompt>[0]['coordination']): string {
  return composeTaskPrompt({
    requestText: 'Do the thing.',
    contextRefs: [],
    workspace: WORKSPACE as unknown as Parameters<typeof composeTaskPrompt>[0]['workspace'],
    inspection: INSPECTION,
    contract: sampleContract(),
    ...(coordination !== undefined ? { coordination } : {}),
  });
}

describe('the coordination section of a worker prompt', () => {
  it('names this task and every peer it can address', () => {
    const text = prompt({
      taskId: 'task-1',
      key: 't1',
      peers: [{ key: 't2', taskId: 'task-2', objective: 'Write the docs.' }],
      toolsAvailable: true,
    });
    expect(text).toContain('Your task id is task-1');
    expect(text).toContain('task-2');
    expect(text).toContain('Write the docs.');
    expect(text).toContain('send_message');
  });

  it('says plainly when the tools are not available rather than implying a channel', () => {
    const text = prompt({ taskId: 'task-1', peers: [{ key: 't2', taskId: 'task-2', objective: 'Other work.' }], toolsAvailable: false });
    expect(text).toContain('coordination tools are not available');
  });

  it('adds nothing for a single-task direct run', () => {
    expect(prompt(undefined)).not.toContain('--- coordination ---');
  });
});
