import { describe, expect, it } from 'vitest';
import { ContractValidationError } from '../../src/core/contracts.js';
import {
  applyHandoffPacket,
  buildHandoffPacket,
  executedCheckFromReceipt,
  parseHandoffPacket,
  serializeHandoffPacket,
  type HandoffPacketInput,
} from '../../src/routing/handoff.js';

const input: HandoffPacketInput = {
  packetVersion: 1,
  createdAt: '2026-09-07T10:00:00.000Z',
  runId: 'run-1',
  taskId: 'task-1',
  originalRequest: { text: 'Add retry with backoff to the HTTP client.', contextRefs: ['docs/net.md'] },
  contract: {
    contractVersion: 1,
    objective: 'Add retry with backoff to src/net/client.ts',
    scope: { allowedPaths: ['src/net'], forbiddenPaths: ['src/secrets'] },
    acceptanceCriteria: [{ id: 'unit', description: 'the unit tests pass' }],
    dependencies: [],
    constraints: ['no new dependencies'],
    evidenceRequirements: ['npm test output'],
  },
  contractVersion: 1,
  revisions: { repoPath: '/repo', base: 'aaaaaaa', candidate: 'bbbbbbb' },
  patch: { format: 'git-diff', hash: 'sha256:deadbeef', ref: 'artifact:patch-1', bytes: 2048 },
  findings: [
    {
      id: 'f1',
      severity: 'major',
      summary: 'the backoff never caps, so a long outage retries forever',
      sources: [{ kind: 'file', ref: 'src/net/client.ts', line: 88, revision: 'bbbbbbb' }],
    },
  ],
  checks: [
    {
      criterionId: 'unit',
      command: 'npm',
      args: ['test'],
      outcome: 'failed',
      required: true,
      exitCode: 1,
      startedAt: '2026-09-07T09:58:00.000Z',
      endedAt: '2026-09-07T09:59:00.000Z',
      durationMs: 60_000,
      testsRun: 42,
      evidenceProvenance: 'verifier_executed',
      failureTail: 'AssertionError: expected 3 retries, got 7',
    },
  ],
  remainingWork: [{ id: 'r1', description: 'cap the backoff at 30s', blockedBy: [], acceptanceCriterionId: 'unit' }],
  scopeLimits: { policy: 'local-development', allowedPaths: ['src/net'], forbiddenPaths: ['src/secrets'], notes: ['leave the public signature alone'] },
  artifacts: [{ id: 'patch-1', kind: 'patch', path: '/state/artifacts/patch-1.diff', bytes: 2048 }],
  producedBy: { agentId: 'dev', adapterId: 'codex', adapterVersion: '0.147.0', attemptNumber: 1 },
};

describe('handoff packet', () => {
  it('round-trips through JSON unchanged', () => {
    const packet = buildHandoffPacket(input);
    const parsed = parseHandoffPacket(JSON.parse(serializeHandoffPacket(packet)));
    expect(parsed).toEqual(packet);
  });

  it('is runtime-neutral: provider session state cannot be carried', () => {
    expect(() => buildHandoffPacket({ ...input, sessionId: 'codex-session-abc' } as unknown as HandoffPacketInput)).toThrow(ContractValidationError);
  });

  it('rejects a patch reference without a content hash', () => {
    expect(() => buildHandoffPacket({ ...input, patch: { format: 'git-diff', hash: null, ref: 'artifact:patch-1' } })).toThrow(/immutable reference/);
  });

  it('rejects a contract version that disagrees with the contract', () => {
    expect(() => buildHandoffPacket({ ...input, contractVersion: 2 })).toThrow(/does not match/);
  });

  it('rejects remaining work pointing at a criterion the contract does not define', () => {
    expect(() =>
      buildHandoffPacket({ ...input, remainingWork: [{ id: 'r1', description: 'x', blockedBy: [], acceptanceCriterionId: 'ghost' }] }),
    ).toThrow(/does not define/);
  });

  it('accepts a packet with no patch at all', () => {
    const packet = buildHandoffPacket({ ...input, patch: { format: 'none', hash: null, ref: null } });
    expect(packet.patch.format).toBe('none');
  });
});

describe('applyHandoffPacket', () => {
  it('produces a continuation brief a different runtime can start from', () => {
    const brief = applyHandoffPacket(buildHandoffPacket(input));
    expect(brief.prompt).toContain('Add retry with backoff to the HTTP client.');
    expect(brief.prompt).toContain('sha256:deadbeef');
    expect(brief.prompt).toContain('AssertionError: expected 3 retries, got 7');
    expect(brief.prompt).toContain('cap the backoff at 30s');
    expect(brief.prompt).toContain('src/net');
    expect(brief.failedCheckCommands).toEqual(['npm test']);
    expect(brief.allowedPaths).toEqual(['src/net']);
    expect(brief.baseRevision).toBe('aaaaaaa');
  });

  it('carries no session identity or provider handle into the brief', () => {
    const brief = applyHandoffPacket(buildHandoffPacket(input));
    expect(brief.prompt.toLowerCase()).not.toContain('session');
    expect(brief.prompt.toLowerCase()).not.toContain('resume');
    expect(JSON.stringify(brief).toLowerCase()).not.toContain('sessionid');
  });

  it('says plainly when nothing has been demonstrated', () => {
    const brief = applyHandoffPacket(buildHandoffPacket({ ...input, checks: [], remainingWork: [] }));
    expect(brief.prompt).toContain('nothing about this candidate has been demonstrated');
  });

  it('reminds the worker that saying done does not accept the work', () => {
    const brief = applyHandoffPacket(buildHandoffPacket(input));
    expect(brief.prompt).toContain('Declaring the work done does not accept it');
  });

  it('adapts the containment wording to the receiving runtime', () => {
    const packet = buildHandoffPacket(input);
    expect(applyHandoffPacket(packet, { runtimeEnforcesWrites: true }).prompt).toContain('refused by the runtime');
    expect(applyHandoffPacket(packet, { runtimeEnforcesWrites: false }).prompt).toContain('your responsibility');
  });
});

describe('executedCheckFromReceipt', () => {
  it('maps a verifier receipt and keeps its provenance', () => {
    const check = executedCheckFromReceipt({
      criterionId: 'unit',
      required: true,
      command: 'npm',
      args: ['test'],
      outcome: 'passed',
      exitCode: 0,
      startedAt: '2026-09-07T09:58:00.000Z',
      endedAt: '2026-09-07T09:59:00.000Z',
      durationMs: 60_000,
      evidenceProvenance: 'verifier_executed',
      stdoutPath: '/state/logs/unit.out',
      stdoutTail: 'ok',
      stderrTail: '',
      outputSummary: { testsRun: 381 },
    });
    expect(check.testsRun).toBe(381);
    expect(check.evidenceProvenance).toBe('verifier_executed');
    expect(check.stdoutPath).toBe('/state/logs/unit.out');
  });
});
