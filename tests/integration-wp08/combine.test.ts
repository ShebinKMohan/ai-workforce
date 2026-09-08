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

/**
 * The combined path has to apply the same acceptance surface as the direct
 * one. A criterion's entry point names one file; the modules it imports are
 * part of what the criterion executes, and are reached only by following the
 * import graph from the base revision. Resolving the surface from path names
 * alone here would accept a combination that the single-task path refuses.
 */
describe('the combined acceptance surface follows the module graph', () => {
  const SUITE = [
    "import { expectEqual } from './expect.js';",
    "import { total } from '../src/total.js';",
    '',
    "expectEqual(total([1200, 340, 75]), 1615, 'every line item is billed');",
    '',
    "console.log('acceptance suite passed');",
    '',
  ].join('\n');
  const HELPER = [
    'export function expectEqual(actual, expected, what) {',
    '  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);',
    '}',
    '',
  ].join('\n');
  const BUGGY_TOTAL = [
    'export function total(amounts) {',
    '  let sum = 0;',
    '  for (let index = 0; index < amounts.length - 1; index += 1) sum += amounts[index];',
    '  return sum;',
    '}',
    '',
  ].join('\n');
  const FIXED_TOTAL = BUGGY_TOTAL.replace('amounts.length - 1', 'amounts.length');

  /** `package.json` names the suite; nothing about `verify/` matches a test-path convention. */
  const MANIFEST = `${JSON.stringify({ name: 'helper-combined', private: true, type: 'module', scripts: { test: 'node verify/run.js' } }, null, 2)}\n`;

  const helperRepo = async () =>
    makeRepo({ 'package.json': MANIFEST, 'verify/run.js': SUITE, 'verify/expect.js': HELPER, 'src/total.js': BUGGY_TOTAL });
  const CHECKS = [{ criterionId: 'acceptance-suite-passes', command: process.execPath, args: ['verify/run.js'] }];

  it('refuses a combination that guts a helper the acceptance suite imports', async () => {
    const repo = await helperRepo();
    // The attack: the suite and the bug are untouched; the assertion helper it
    // reports failures through is emptied, so the suite exits 0 asserting nothing.
    const attack = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'verify/expect.js': 'export function expectEqual() {}\n' } });
    const other = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'README.md': 'notes\n' } });

    const result = await combineArtifacts({
      runId: 'run-surface',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [attack, other],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: CHECKS,
    });

    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    // The check really does pass against the combined revision: that is the attack.
    expect(combined.receipts[0]!.outcome).toBe('passed');
    expect(combined.receipts[0]!.candidate.revision).toBe(combined.combinedRevision);
    // And the combination is still refused, because the emptied file is code
    // the criterion executes to judge the candidate.
    expect(combined.acceptance.accepted).toBe(false);
    expect(combined.acceptance.reason).toContain('verify/expect.js');
    expect(combined.acceptance.verdicts[0]!.satisfied).toBe(false);
    // The surface was resolved completely, so the refusal rests on knowledge rather than on a gap.
    expect(combined.surfaceGaps).toEqual([]);
  });

  it('refuses a combination whose acceptance surface it could not establish, however green the checks are', async () => {
    // A specifier read from the environment can load anything, so nothing
    // static bounds what this criterion executes. The single-task path refuses
    // on that; the combined one has to draw the line in the same place, or the
    // multi-task route is the cheaper way past the gate.
    const repo = await makeRepo({
      'package.json': MANIFEST,
      'verify/run.js': ["const { expectEqual } = await import(process.env.HELPER ?? './expect.js');", "const { total } = await import('../src/total.js');", '', "expectEqual(total([1200, 340, 75]), 1615, 'every line item is billed');", ''].join('\n'),
      'verify/expect.js': HELPER,
      'src/total.js': BUGGY_TOTAL,
    });
    const fix = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'src/total.js': FIXED_TOTAL } });
    const other = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'README.md': 'notes\n' } });

    const result = await combineArtifacts({
      runId: 'run-surface-gap',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [fix, other],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: CHECKS,
    });

    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    expect(combined.receipts[0]!.outcome).toBe('passed');
    expect(combined.acceptance.accepted).toBe(false);
    expect(combined.acceptance.reason).toContain('the acceptance surface for criterion "acceptance-suite-passes" could not be fully resolved');
    expect(combined.surfaceGaps.join(' ')).toContain('loads a computed specifier');
  });

  it('refuses a combination that guts a helper behind a shell entry point', async () => {
    // `sh verify/check.sh` contributed nothing to the module graph, so the
    // helper the suite asserts through was outside the comparison entirely.
    const repo = await makeRepo({
      'package.json': MANIFEST,
      'verify/check.sh': '#!/bin/sh\nexec node verify/run.js\n',
      'verify/run.js': SUITE,
      'verify/expect.js': HELPER,
      'src/total.js': BUGGY_TOTAL,
    });
    const attack = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'verify/expect.js': 'export function expectEqual() {}\n' } });
    const other = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'README.md': 'notes\n' } });

    const result = await combineArtifacts({
      runId: 'run-surface-shell',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [attack, other],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: [{ criterionId: 'acceptance-suite-passes', command: 'sh', args: ['verify/check.sh'] }],
    });

    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    expect(combined.receipts[0]!.outcome).toBe('passed');
    expect(combined.acceptance.accepted).toBe(false);
    expect(combined.acceptance.reason).toContain('verify/expect.js');
    // Resolved, not merely blocked: the script was followed to its runner.
    expect(combined.surfaceGaps).toEqual([]);
  });

  it('still accepts a combination that fixes the code the same suite imports', async () => {
    const repo = await helperRepo();
    const fix = await makeArtifact(repo, { artifactId: 'art-a', taskId: 'task-a', edits: { 'src/total.js': FIXED_TOTAL } });
    const other = await makeArtifact(repo, { artifactId: 'art-b', taskId: 'task-b', edits: { 'README.md': 'notes\n' } });

    const result = await combineArtifacts({
      runId: 'run-surface-ok',
      projectRoot: repo.root,
      baseRevision: repo.head,
      artifacts: [fix, other],
      integrationRoot: tempDir('wf-wp08-int-'),
      checkOutputRoot: tempDir('wf-wp08-checks-'),
      checks: CHECKS,
    });

    const combined = result as Extract<CombineResult, { status: 'combined' }>;
    // `src/total.js` is executed by the criterion too. Following the graph must
    // not make the fix itself unacceptable.
    expect(combined.receipts[0]!.outcome).toBe('passed');
    expect(combined.acceptance.accepted).toBe(true);
    expect(combined.surfaceGaps).toEqual([]);
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
