import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckReceipt } from '../../src/verification/checks.js';
import {
  IntegrationGate,
  combineArtifacts,
  evaluateCombinedAcceptance,
  integrationOrder,
  parseUnifiedDiff,
  planCombination,
  type CombineResult,
} from '../../src/integration/combine.js';
import { cleanupAll, makeArtifact, makeReceipt, makeRepo, tempDir } from './support.js';

afterAll(() => cleanupAll());

const BASE_A = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', ''].join('\n');

function edit(source: string, line: number, value: string): string {
  const lines = source.split('\n');
  lines[line - 1] = value;
  return lines.join('\n');
}

describe('serialized integration (FR045)', () => {
  it('combines two non-overlapping artifacts and re-checks the combined revision', async () => {
    const repo = await makeRepo({ 'a.txt': 'A1\n', 'b.txt': 'B1\n' });
    const first = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'a.txt': 'A2\n' } });
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'b.txt': 'B2\n' } });

    const result = await combineArtifacts({
      runId: 'run1',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [second, first],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [
        {
          criterionId: 'both-changes-present',
          command: process.execPath,
          args: ['-e', 'const fs=require("fs");if(fs.readFileSync("a.txt","utf8").trim()!=="A2"||fs.readFileSync("b.txt","utf8").trim()!=="B2")process.exit(1);'],
        },
      ],
    });

    expect(result.status).toBe('combined');
    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    // Deterministic order: task-a before task-b, whatever order they arrived in.
    expect(combined.order).toEqual(['art-a', 'art-b']);
    expect(combined.receipts).toHaveLength(1);
    const receipt = combined.receipts[0]!;
    expect(receipt.outcome).toBe('passed');
    // The check ran against the exact combined revision, not either branch.
    expect(receipt.candidate.revision).toBe(combined.combinedRevision);
    expect(combined.combinedRevision).not.toBe(repo.head);
    expect(combined.acceptance.accepted).toBe(true);
  });

  it('refuses artifacts whose changes overlap semantically, naming the conflict', async () => {
    const repo = await makeRepo({ 'shared.txt': BASE_A });
    const first = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'shared.txt': edit(BASE_A, 10, 'TEN-from-a') } });
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'shared.txt': edit(BASE_A, 11, 'ELEVEN-from-b') } });

    const result = await combineArtifacts({
      runId: 'run1',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [first, second],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [],
    });

    expect(result.status).toBe('refused');
    const refused = result as Extract<CombineResult, { status: 'refused' }>;
    expect(refused.conflicts).toHaveLength(1);
    expect(refused.conflicts[0]!.kind).toBe('overlapping_hunks');
    expect(refused.conflicts[0]!.name).toBe('overlapping_hunks:shared.txt');
    expect(refused.conflicts[0]!.artifacts).toEqual(['art-a', 'art-b']);
    expect(refused.conflicts[0]!.detail).toContain('needs a decision about intent');
  });

  it('combines two distant edits to the same file without guessing', async () => {
    const repo = await makeRepo({ 'shared.txt': BASE_A });
    const first = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'shared.txt': edit(BASE_A, 2, 'TWO-from-a') } });
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'shared.txt': edit(BASE_A, 19, 'NINETEEN-from-b') } });

    const plan = planCombination([first, second], { baseRevision: repo.head });
    expect(plan.conflicts).toEqual([]);
    expect(plan.sharedFiles).toEqual(['shared.txt']);

    const result = await combineArtifacts({
      runId: 'run1',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [first, second],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [
        {
          criterionId: 'both-lines-present',
          command: process.execPath,
          args: ['-e', 'const t=require("fs").readFileSync("shared.txt","utf8");if(!t.includes("TWO-from-a")||!t.includes("NINETEEN-from-b"))process.exit(1);'],
        },
      ],
    });

    expect(result.status).toBe('combined');
    expect((result as Extract<CombineResult, { status: 'combined' }>).acceptance.accepted).toBe(true);
  });

  it('refuses to combine artifacts produced against different contract versions', async () => {
    const repo = await makeRepo({ 'a.txt': 'A1\n', 'b.txt': 'B1\n' });
    const first = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', contractVersion: 1, edits: { 'a.txt': 'A2\n' } });
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', contractVersion: 2, edits: { 'b.txt': 'B2\n' } });

    const result = await combineArtifacts({
      runId: 'run1',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [first, second],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [],
    });

    expect(result.status).toBe('refused');
    const refused = result as Extract<CombineResult, { status: 'refused' }>;
    expect(refused.conflicts.map((conflict) => conflict.kind)).toContain('contract_version_mismatch');
  });

  it('refuses when one artifact deletes a file the other modifies', async () => {
    const repo = await makeRepo({ 'shared.txt': BASE_A });
    const first = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'shared.txt': edit(BASE_A, 2, 'TWO-from-a') } });
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'other.txt': 'kept\n' }, deletes: ['shared.txt'] });

    const plan = planCombination([first, second], { baseRevision: repo.head });
    const conflict = plan.conflicts.find((candidate) => candidate.kind === 'file_mode_conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.name).toBe('file_mode_conflict:shared.txt');
  });

  it('serializes combinations so one owner builds at a time', async () => {
    const gate = new IntegrationGate();
    const observed: string[] = [];
    const slow = gate.run('repo', async () => {
      observed.push('start-1');
      await new Promise((resolve) => setTimeout(resolve, 25));
      observed.push('end-1');
      return 1;
    });
    const fast = gate.run('repo', async () => {
      observed.push('start-2');
      observed.push('end-2');
      return 2;
    });
    await Promise.all([slow, fast]);
    expect(observed).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(gate.active).toBeNull();
  });
});

describe('an individual branch pass never establishes the combination (AT13)', () => {
  it('reports the combined candidate as unestablished when only branch receipts exist', () => {
    const branchPass = makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: 'branch-rev', patchHash: null } });
    const acceptance = evaluateCombinedAcceptance({
      combinedRevision: 'combined-rev',
      requiredCriteria: [{ id: 'tests', required: true }],
      receipts: [branchPass],
    });

    expect(acceptance.accepted).toBe(false);
    expect(acceptance.unverifiedCriteria).toEqual(['tests']);
    expect(acceptance.ignoredReceiptIds).toEqual([branchPass.id]);
    expect(acceptance.verdicts[0]!.reason).toContain('does not establish the combination');
  });

  it('accepts only receipts bound to the combined revision', () => {
    const combinedRevision = 'combined-rev';
    const receipts: CheckReceipt[] = [
      makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: 'branch-rev', patchHash: null } }),
      makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: combinedRevision, patchHash: null } }),
    ];
    const acceptance = evaluateCombinedAcceptance({ combinedRevision, requiredCriteria: [{ id: 'tests' }], receipts });
    expect(acceptance.accepted).toBe(true);
    expect(acceptance.verdicts[0]!.receiptId).toBe(receipts[1]!.id);
  });

  it('does not accept a combination whose combined-revision check failed, even with branch passes', () => {
    const combinedRevision = 'combined-rev';
    const acceptance = evaluateCombinedAcceptance({
      combinedRevision,
      requiredCriteria: [{ id: 'tests' }],
      receipts: [
        makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: '/repo', revision: 'branch-rev', patchHash: null } }),
        makeReceipt({ criterionId: 'tests', outcome: 'failed', exitCode: 1, candidate: { repoRoot: '/repo', revision: combinedRevision, patchHash: null } }),
      ],
    });
    expect(acceptance.accepted).toBe(false);
    expect(acceptance.reason).toContain('reported "failed"');
  });

  it('carries branch receipts through a real combination without letting them establish it', async () => {
    const repo = await makeRepo({ 'a.txt': 'A1\n', 'b.txt': 'B1\n' });
    const branchPass = makeReceipt({ criterionId: 'tests', outcome: 'passed', candidate: { repoRoot: repo.root, revision: 'branch-rev', patchHash: null } });
    const first = { ...(await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'a.txt': 'A2\n' } })), branchReceipts: [branchPass] };
    const second = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'b.txt': 'B2\n' } });

    const result = await combineArtifacts({
      runId: 'run1',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [first, second],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [{ criterionId: 'tests', command: 'node', args: ['-e', ''] }],
      // The combination was not actually re-checked.
      runChecks: async () => [],
    });

    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    expect(combined.branchReceiptIds).toEqual([branchPass.id]);
    expect(combined.acceptance.accepted).toBe(false);
    expect(combined.acceptance.unverifiedCriteria).toEqual(['tests']);
    expect(combined.acceptance.ignoredReceiptIds).toEqual([branchPass.id]);
  });
});

describe('patch parsing', () => {
  it('reads hunk ranges, additions, deletions and binary markers', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/src/one.ts b/src/one.ts',
        'index 111..222 100644',
        '--- a/src/one.ts',
        '+++ b/src/one.ts',
        '@@ -10,6 +10,7 @@ context',
        '+added',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        'diff --git a/logo.png b/logo.png',
        'index 333..444 100644',
        'GIT binary patch',
        'literal 4',
        '',
      ].join('\n'),
    );
    expect(files.map((file) => [file.path, file.change, file.binary])).toEqual([
      ['src/one.ts', 'modified', false],
      ['gone.txt', 'deleted', false],
      ['logo.png', 'modified', true],
    ]);
    expect(files[0]!.hunks).toEqual([{ oldStart: 10, oldLines: 6, newStart: 10, newLines: 7 }]);
  });

  it('orders artifacts deterministically regardless of arrival order', () => {
    const stub = (artifactId: string, taskId: string) => ({ artifactId, taskId, attemptId: 'a', contractVersion: 1, baseRevision: 'r', patchPath: path.join('/tmp', artifactId), patchHash: '' });
    expect(integrationOrder([stub('z', 'task-b'), stub('a', 'task-a')]).map((artifact) => artifact.artifactId)).toEqual(['a', 'z']);
  });
});
