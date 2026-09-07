import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { observeProcessIdentity } from '../../src/core/process.js';
import { OwnershipError, WorkspaceOwnership, taskWorkspaceKey } from '../../src/integration/ownership.js';
import { cleanupAll, tempDir } from './support.js';

const children: ChildProcess[] = [];

function spawnLiveWriter(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterAll(() => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // best effort
    }
  }
  cleanupAll();
});

describe('exclusive writer ownership (FR043)', () => {
  it('refuses a second writer while the first process is still live, and says how to proceed', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-') });
    const key = taskWorkspaceKey('run1', 'task1');

    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    const child = spawnLiveWriter();
    ownership.attachWriter(first.ownerToken, observeProcessIdentity(child.pid!));
    expect(ownership.probeCurrent(key)).toBe('alive');

    const refusal = await ownership
      .claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' })
      .then(() => null)
      .catch((error: unknown) => error as OwnershipError);

    expect(refusal).toBeInstanceOf(OwnershipError);
    expect(refusal!.code).toBe('writer_live');
    expect(refusal!.incumbent?.attemptId).toBe('attempt-1');
    expect(refusal!.remedies.join(' ')).toContain('isolated successor');
    // The workspace is still the first writer's.
    expect(ownership.current(key)?.ownerToken).toBe(first.ownerToken);
    expect(ownership.isCurrentWriter(first.ownerToken)).toBe(true);
  });

  it('grants the workspace once the writer is observed stopped', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-') });
    const key = taskWorkspaceKey('run1', 'task1');
    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    const child = spawnLiveWriter();
    ownership.attachWriter(first.ownerToken, observeProcessIdentity(child.pid!));

    await expect(ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' })).rejects.toThrow(/still writing/);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const ended = ownership.recordStop(first.ownerToken, { kind: 'observed_exit', exitCode: null, signal: 'SIGKILL' });
    expect(ended.state).toBe('stopped');

    const second = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' });
    expect(ownership.current(key)?.ownerToken).toBe(second.ownerToken);
    expect(ownership.isCurrentWriter(first.ownerToken)).toBe(false);
  });

  it('treats a claim with no recorded process as unstoppable rather than free', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-') });
    await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    const error = await ownership
      .claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' })
      .then(() => null)
      .catch((caught: unknown) => caught as OwnershipError);
    expect(error!.code).toBe('writer_unattached');
  });

  it('treats unverifiable liveness as contention, not as a stop', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-'), probe: () => 'unverifiable' });
    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    ownership.attachWriter(first.ownerToken, { pid: 424242, startedAtMs: null, spawnToken: 'spawn-token' });
    const error = await ownership
      .claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' })
      .then(() => null)
      .catch((caught: unknown) => caught as OwnershipError);
    expect(error!.code).toBe('writer_unverifiable');
  });

  it('takes over only when the recorded process is provably gone, and records that observation', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-'), probe: () => 'dead' });
    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    ownership.attachWriter(first.ownerToken, { pid: 424242, startedAtMs: 1, spawnToken: 'spawn-token' });
    const second = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' });
    expect(second.attemptId).toBe('attempt-2');
    const retired = ownership.get(first.ownerToken)!;
    expect(retired.state).toBe('stopped');
    expect(retired.endEvidence).toEqual({ kind: 'observed_process_gone', probe: 'dead', detail: 'probed on takeover by attempt "attempt-2"' });
  });

  it('offers an isolated successor workspace instead of taking a contended one', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-') });
    const key = taskWorkspaceKey('run1', 'task1');
    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    const child = spawnLiveWriter();
    ownership.attachWriter(first.ownerToken, observeProcessIdentity(child.pid!));

    const successor = await ownership.claimIsolatedSuccessor({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' });
    expect(successor.claim.workspaceKey).not.toBe(key);
    expect(successor.contendedWorkspaceKey).toBe(key);
    expect(successor.claim.isolatedFrom).toBe(first.ownerToken);
    expect(successor.reason).toContain('alive');
    // The contended workspace still belongs to the live writer.
    expect(ownership.current(key)?.ownerToken).toBe(first.ownerToken);
    expect(ownership.isCurrentWriter(first.ownerToken)).toBe(true);
  });

  it('rejects writes from a claim that is no longer the current writer', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-own-'), probe: () => 'dead' });
    const first = await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-1' });
    ownership.attachWriter(first.ownerToken, { pid: 424242, startedAtMs: 1, spawnToken: 'spawn-token' });
    await ownership.claim({ runId: 'run1', taskId: 'task1', attemptId: 'attempt-2' });
    expect(() => ownership.assertCurrentWriter(first.ownerToken)).toThrow(/no longer the writer/);
  });
});

describe('per-attempt resource allocation (FR044)', () => {
  it('gives every attempt its own temp directory and never reissues a live port', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-res-'), probe: () => 'dead' });
    const a = await ownership.claim({ runId: 'run1', taskId: 'task-a', attemptId: 'attempt-1', ports: 2 });
    const b = await ownership.claim({ runId: 'run1', taskId: 'task-b', attemptId: 'attempt-1', ports: 2 });

    expect(a.resources.tempDir).not.toBe(b.resources.tempDir);
    expect(existsSync(a.resources.tempDir)).toBe(true);
    expect(existsSync(b.resources.tempDir)).toBe(true);
    expect(a.resources.ports).toHaveLength(2);
    expect(new Set([...a.resources.ports, ...b.resources.ports]).size).toBe(4);

    ownership.releaseResources(a.ownerToken);
    expect(existsSync(a.resources.tempDir)).toBe(false);
  });

  it('refuses to allocate when every probed port is already reserved by a live attempt', async () => {
    const ownership = new WorkspaceOwnership({ resourceRoot: tempDir('wf-wp08-res-'), allocatePort: async () => 45_000 });
    const first = await ownership.claim({ runId: 'run1', taskId: 'task-a', attemptId: 'attempt-1', ports: 1 });
    expect(first.resources.ports).toEqual([45_000]);
    await expect(ownership.claim({ runId: 'run1', taskId: 'task-b', attemptId: 'attempt-1', ports: 1 })).rejects.toThrow(/could not allocate/);
  });
});
