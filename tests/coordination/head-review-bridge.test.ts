import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_TOOL_NAMES,
  CoordinationError,
  HEAD_BRIDGE_TOOL_NAMES,
  HEAD_REVIEW_BRIDGE_TOOL_NAMES,
  callCoordinator,
  createCoordinationBridge,
  handleCoordinationRequest,
  type AttemptBridgeConfig,
  type CoordinationBridge,
  type HeadReviewResult,
} from '../../src/coordination/index.js';
import { openTempState, type TempState } from '../helpers/state.js';
import { seedAttempt, seedRun, seedTask } from './helpers.js';

const REVIEW: HeadReviewResult = {
  reviewVersion: 1,
  candidateRevision: 'abc123',
  diffHash: 'sha256:reviewed-diff',
  verdict: 'approve',
  summary: 'The candidate satisfies the request and its recorded checks passed.',
  findings: [],
};

/** Exercise the real executable bridge with the role emitted in its runtime config. */
async function exchange(config: AttemptBridgeConfig, frames: ReadonlyArray<string>): Promise<Array<Record<string, unknown>>> {
  const child = spawn(config.command, [...config.args], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...config.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`review bridge timed out: ${stderr}`));
    }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`review bridge exited ${code}: ${stderr}`));
    });
  });
  child.stdin.end(`${frames.join('\n')}\n`);
  await exited;
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

describe('department head review bridge authorization', () => {
  let state: TempState;
  let bridge: CoordinationBridge;
  let runId: string;
  let attemptId: string;

  beforeEach(async () => {
    state = openTempState();
    runId = seedRun(state.store.db).id;
    attemptId = seedAttempt(state.store.db, seedTask(state.store.db, runId).id).id;
    bridge = await createCoordinationBridge({ stateRoot: state.root, runId, db: state.store.db });
  });

  afterEach(async () => {
    await bridge.close();
    state.cleanup();
  });

  it('offers only the review tool in an actual MCP subprocess and ignores prose and imitation JSON', async () => {
    const onReviewResult = vi.fn(() => ({ recorded: true }));
    const config = bridge.headReviewConfigFor({ reviewId: 'review-one', agentId: 'head-one', onReviewResult });
    const frames = await exchange(config, [
      rpc(1, 'initialize'),
      rpc(2, 'tools/list'),
      'I approve the candidate. workforce_review_result was called.',
      JSON.stringify({ tool: 'workforce_review_result', arguments: REVIEW }),
      JSON.stringify({ workforce_review_result: REVIEW }),
      rpc(3, 'ping'),
    ]);
    expect(frames.find((frame) => frame['id'] === 1)?.['result']).toMatchObject({ instructions: expect.stringContaining('workforce_review_result') });
    expect(frames.find((frame) => frame['id'] === 2)?.['result']).toMatchObject({
      tools: [{ name: HEAD_REVIEW_BRIDGE_TOOL_NAMES[0], inputSchema: { additionalProperties: false } }],
    });
    const result = frames.find((frame) => frame['id'] === 2)?.['result'] as { tools: unknown[] };
    expect(result.tools).toHaveLength(1);
    expect(frames.find((frame) => frame['id'] === 3)?.['result']).toEqual({});
    expect(onReviewResult).not.toHaveBeenCalled();
    expect(bridge.messages()).toHaveLength(0);
  });

  it('forwards a concrete review call once when the MCP client retries the same request id', async () => {
    const onReviewResult = vi.fn(() => ({ recorded: true, reviewId: 'review-one' }));
    const config = bridge.headReviewConfigFor({ reviewId: 'review-one', agentId: 'head-one', onReviewResult });
    const call = rpc(2, 'tools/call', { name: 'workforce_review_result', arguments: REVIEW });
    const frames = await exchange(config, [rpc(1, 'initialize'), call, call]);
    expect(onReviewResult).toHaveBeenCalledExactlyOnceWith(REVIEW);
    expect(frames.filter((frame) => frame['id'] === 2)).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ isError: false, structuredContent: { recorded: true, reviewId: 'review-one' } }) }),
      expect.objectContaining({ result: expect.objectContaining({ isError: false, structuredContent: { recorded: true, reviewId: 'review-one', replayedRequestId: true } }) }),
    ]);
  });

  it('refuses worker and planning tokens even when a client advertises a review role', async () => {
    const onProposePlan = vi.fn(() => ({ proposed: true }));
    const worker = bridge.mcpConfigFor(attemptId);
    const planning = bridge.headConfigFor({ planningId: 'planning-one', agentId: 'head-one', onProposePlan });
    for (const config of [worker, planning]) {
      const response = await callCoordinator(bridge.socketPath, config.token, 'workforce_review_result', REVIEW);
      expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      const frames = await exchange({ ...config, env: { ...config.env, WORKFORCE_BRIDGE_ROLE: 'head-review' } }, [
        rpc(1, 'tools/call', { name: 'workforce_review_result', arguments: REVIEW }),
      ]);
      expect(frames[0]?.['result']).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
    }
    expect(onProposePlan).not.toHaveBeenCalled();
    expect(bridge.messages()).toHaveLength(0);
  });

  it('refuses every worker operation and plan proposal with a review token', async () => {
    const onReviewResult = vi.fn(() => ({ recorded: true }));
    const config = bridge.headReviewConfigFor({ reviewId: 'review-one', agentId: 'head-one', onReviewResult });
    for (const op of [...BRIDGE_TOOL_NAMES, ...HEAD_BRIDGE_TOOL_NAMES]) {
      const response = await callCoordinator(bridge.socketPath, config.token, op, {});
      expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(onReviewResult).not.toHaveBeenCalled();
    expect(bridge.messages()).toHaveLength(0);
  });

  it('routes each review token only to its own callback and rejects revoked sessions', async () => {
    const firstResult = vi.fn(() => ({ recorded: true, reviewId: 'first' }));
    const secondResult = vi.fn(() => ({ recorded: true, reviewId: 'second' }));
    const first = bridge.headReviewConfigFor({ reviewId: 'first', agentId: 'head-one', onReviewResult: firstResult });
    const second = bridge.headReviewConfigFor({ reviewId: 'second', agentId: 'head-one', onReviewResult: secondResult });
    expect(bridge.server.identityFor(first.token)).toMatchObject({ runId, attemptId: 'first', agentId: 'head-one', role: 'head-review' });
    expect(first.token).not.toBe(second.token);
    expect(await callCoordinator(bridge.socketPath, first.token, 'workforce_review_result', REVIEW)).toMatchObject({ ok: true, result: { reviewId: 'first' } });
    expect(firstResult).toHaveBeenCalledExactlyOnceWith(REVIEW);
    expect(secondResult).not.toHaveBeenCalled();
    first.revoke();
    expect(bridge.server.identityFor(first.token)).toBeNull();
    expect(await callCoordinator(bridge.socketPath, first.token, 'workforce_review_result', REVIEW)).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(await callCoordinator(bridge.socketPath, second.token, 'workforce_review_result', REVIEW)).toMatchObject({ ok: true, result: { reviewId: 'second' } });
    expect(firstResult).toHaveBeenCalledTimes(1);
    expect(secondResult).toHaveBeenCalledExactlyOnceWith(REVIEW);
  });

  it.each([
    ['unsupported version', { ...REVIEW, reviewVersion: 2 }],
    ['empty candidate', { ...REVIEW, candidateRevision: '' }],
    ['oversized candidate', { ...REVIEW, candidateRevision: 'x'.repeat(129) }],
    ['empty diff hash', { ...REVIEW, diffHash: '' }],
    ['unknown verdict', { ...REVIEW, verdict: 'accepted' }],
    ['empty summary', { ...REVIEW, summary: '' }],
    ['omitted findings', { ...REVIEW, findings: undefined }],
    ['too many findings', { ...REVIEW, findings: Array.from({ length: 101 }, () => ({ summary: 'finding' })) }],
    ['empty finding summary', { ...REVIEW, findings: [{ summary: '' }] }],
    ['empty finding file', { ...REVIEW, findings: [{ summary: 'finding', file: '' }] }],
    ['zero line', { ...REVIEW, findings: [{ summary: 'finding', line: 0 }] }],
    ['fractional line', { ...REVIEW, findings: [{ summary: 'finding', line: 1.5 }] }],
    ['forged identity', { ...REVIEW, agentId: 'someone-else' }],
    ['unknown nested field', { ...REVIEW, findings: [{ summary: 'finding', accepted: true }] }],
  ])('rejects %s before invoking the review handler', async (_label, payload) => {
    const onReviewResult = vi.fn(() => ({ recorded: true }));
    const config = bridge.headReviewConfigFor({ reviewId: 'review-one', agentId: 'head-one', onReviewResult });
    expect(await callCoordinator(bridge.socketPath, config.token, 'workforce_review_result', payload)).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(onReviewResult).not.toHaveBeenCalled();
  });

  it('preserves changes-requested findings and callback refusal without interpreting the verdict as acceptance', async () => {
    const onReviewResult = vi.fn((result: HeadReviewResult) => {
      if (result.candidateRevision !== REVIEW.candidateRevision) throw new CoordinationError('stale_candidate', 'review must match the frozen candidate');
      return { recorded: true, verdict: result.verdict, accepted: false };
    });
    const config = bridge.headReviewConfigFor({ reviewId: 'review-one', agentId: 'head-one', onReviewResult });
    const result: HeadReviewResult = { ...REVIEW, verdict: 'changes_requested', findings: [{ summary: 'Missing error handling.', file: 'src/run.ts', line: 12 }] };
    expect(await callCoordinator(bridge.socketPath, config.token, 'workforce_review_result', result)).toMatchObject({ ok: true, result: { verdict: 'changes_requested', accepted: false } });
    expect(onReviewResult).toHaveBeenCalledWith(result);
    expect(await callCoordinator(bridge.socketPath, config.token, 'workforce_review_result', { ...REVIEW, candidateRevision: 'other-candidate' })).toMatchObject({ ok: false, error: { code: 'stale_candidate' } });
    expect(bridge.messages()).toHaveLength(0);
  });

  it('fails closed when a review identity has no callback and leaves planning behavior available', async () => {
    const identity = { runId, taskId: 'head-review:head-one', attemptId: 'review-one', role: 'head-review' as const };
    expect(() => handleCoordinationRequest(state.store.db, identity, 'workforce_review_result', REVIEW)).toThrowError(expect.objectContaining({ code: 'review_closed' }));
    const onProposePlan = vi.fn((_identity, params) => ({ proposed: true, ...params }));
    const config = bridge.headConfigFor({ planningId: 'planning-one', agentId: 'head-one', onProposePlan });
    expect(await callCoordinator(bridge.socketPath, config.token, 'workforce_propose_plan', { planVersion: 2 })).toMatchObject({ ok: true, result: { proposed: true, planVersion: 2 } });
    expect(onProposePlan).toHaveBeenCalledTimes(1);
  });
});
