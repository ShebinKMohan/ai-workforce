import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import { isProcessAlive } from '../../src/core/process.js';
import {
  buildCheckEnv,
  decideAcceptance,
  listChecks,
  persistCheckReceipts,
  runChecks,
  scanTrackedFiles,
  summarizeCheckOutput,
  type CandidateRef,
  type CheckReceipt,
} from '../../src/verification/checks.js';
import { insertRun } from '../../src/storage/records.js';
import { getArtifact, verifyArtifact } from '../../src/storage/artifacts.js';
import { createCandidateWorkspace, snapshotCandidate } from '../../src/workspaces/candidate.js';
import { openTempState, sampleRequest, TEST_LIMITS } from '../helpers/state.js';
import { cleanupAll, fingerprintCheckout, fixedPaginationSource, registerCleanup, tempDir, useFixture } from '../workspaces/support.js';

afterEach(() => cleanupAll());

interface Candidate {
  readonly repo: string;
  readonly ref: CandidateRef;
  readonly outputRoot: string;
}

/** Build a frozen candidate with the ts-bug fixture either fixed or left broken. */
async function frozenCandidate(options: { fix: boolean; readonly extraFiles?: Readonly<Record<string, string>> }): Promise<Candidate> {
  const fixture = await useFixture('ts-bug');
  const workspaceRoot = tempDir('workforce-workspaces-');
  const workspace = await createCandidateWorkspace({
    projectRoot: fixture.path,
    baseRevision: fixture.headRevision,
    runId: newId(),
    taskId: newId(),
    attemptId: newId(),
    workspaceRoot,
  });
  if (options.fix) writeFileSync(path.join(workspace.path, 'src', 'pagination.js'), fixedPaginationSource());
  for (const [relative, content] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(path.dirname(path.join(workspace.path, relative)), { recursive: true });
    writeFileSync(path.join(workspace.path, relative), content);
  }
  const snapshot = await snapshotCandidate(workspace);
  return {
    repo: fixture.path,
    ref: { repoRoot: fixture.path, revision: snapshot.candidateRevision, patchHash: snapshot.patchHash },
    outputRoot: tempDir('workforce-verify-'),
  };
}

describe('runChecks executes checks itself against a frozen candidate (FR049)', () => {
  it('passes a fixed candidate and fails the same check on an unfixed one', async () => {
    const fixed = await frozenCandidate({ fix: true });
    const passing = await runChecks({
      candidate: fixed.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: fixed.outputRoot,
    });

    expect(passing).toHaveLength(1);
    const pass = passing[0]!;
    expect(pass.outcome).toBe('passed');
    expect(pass.exitCode).toBe(0);
    expect(pass.evidenceProvenance).toBe('verifier_executed');
    expect(pass.candidate.revision).toBe(fixed.ref.revision);
    expect(pass.candidate.patchHash).toBe(fixed.ref.patchHash);
    expect(pass.integrity.mutated).toBe(false);
    expect(pass.integrity.fileCount).toBeGreaterThan(0);
    expect(pass.environmentIdentity.node).toBe(process.version);
    expect(pass.environmentIdentity.os).toBe(process.platform);
    expect(existsSync(pass.stdoutPath)).toBe(true);
    expect(`${readFileSync(pass.stdoutPath, 'utf8')}${pass.stdoutTail}`).toContain('pass 5');
    // The disposable copy is gone; only the evidence remains.
    expect(existsSync(path.join(fixed.outputRoot, '01-node-tests', 'candidate'))).toBe(false);

    const broken = await frozenCandidate({ fix: false });
    const failing = await runChecks({
      candidate: broken.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: broken.outputRoot,
    });
    expect(failing[0]!.outcome).toBe('failed');
    expect(failing[0]!.exitCode).not.toBe(0);
    expect(failing[0]!.integrity.mutated).toBe(false);
  });

  it('kills the whole process group when a check exceeds its deadline', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const pidFile = path.join(tempDir('workforce-pid-'), 'grandchild.pid');

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [
        {
          criterionId: 'hangs',
          command: 'node',
          args: [
            '-e',
            [
              "const { spawn } = require('node:child_process');",
              "const fs = require('node:fs');",
              "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
              'fs.writeFileSync(process.env.PIDFILE, String(child.pid));',
              'setInterval(() => {}, 1000);',
            ].join('\n'),
          ],
          env: { PIDFILE: pidFile },
          timeoutMs: 1_500,
        },
      ],
      outputRoot: candidate.outputRoot,
    });

    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe('timeout');
    expect(receipt.timedOut).toBe(true);
    expect(receipt.diagnostics.join(' ')).toContain('deadline');
    expect(receipt.durationMs).toBeGreaterThanOrEqual(1_400);
    expect(receipt.durationMs).toBeLessThan(20_000);

    // The grandchild was in the killed process group, so it is gone too.
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    for (let attempt = 0; attempt < 50 && isProcessAlive(grandchild); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isProcessAlive(grandchild)).toBe(false);
  });

  it('runs against every tracked file even when the candidate marks the acceptance suite export-ignore', async () => {
    // The attack: leave src/pagination.js broken, add a .gitattributes that
    // hides the suite from `git archive`, and add one trivially passing test.
    // Nothing a criterion pins is modified, so the candidate diff is two
    // additions — and `git archive` alone would extract a tree with no
    // pagination test in it, where `node --test test/` exits 0.
    const candidate = await frozenCandidate({
      fix: false,
      extraFiles: {
        '.gitattributes': 'test/pagination.test.js export-ignore\n',
        'test/zz-smoke.test.js': "import test from 'node:test';\ntest('smoke', () => {});\n",
      },
    });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });

    const receipt = receipts[0]!;
    // The suite the candidate tried to hide ran, and it still fails.
    expect(receipt.outcome).toBe('failed');
    expect(receipt.exitCode).not.toBe(0);
    expect(receipt.outputSummary.testsRun).toBe(6);
    // And the copy says how it was completed, rather than silently differing
    // from the candidate it claims to be.
    expect(receipt.copyStrategy).toBe('git_archive_repaired');
    expect(receipt.diagnostics.join(' ')).toContain('export-ignore');
    expect(receipt.diagnostics.join(' ')).toContain('test/pagination.test.js');
  });

  it('treats a check that mutates tracked source as an integrity failure even when it exits zero', async () => {
    const candidate = await frozenCandidate({ fix: true });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [
        {
          criterionId: 'mutating-check',
          command: 'node',
          args: ['-e', "require('node:fs').appendFileSync('src/pagination.js', '// written by the check\\n'); process.exit(0);"],
          timeoutMs: 30_000,
        },
      ],
      outputRoot: candidate.outputRoot,
    });

    const receipt = receipts[0]!;
    expect(receipt.exitCode).toBe(0);
    expect(receipt.outcome).toBe('integrity_failed');
    expect(receipt.integrity.mutated).toBe(true);
    expect(receipt.integrity.mutatedFiles).toContain('src/pagination.js (modified)');
    expect(receipt.integrity.before).not.toBe(receipt.integrity.after);

    // Acceptance refuses it despite the zero exit code.
    const decision = decideAcceptance([{ id: 'mutating-check', description: 'must not mutate the candidate' }], receipts);
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(' ')).toContain('changed files of the frozen candidate');
  });

  it('fails a check that deletes candidate source, but tolerates build output it creates', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [
        {
          criterionId: 'deletes-a-file',
          command: 'node',
          args: ['-e', "require('node:fs').rmSync('README.md'); require('node:fs').writeFileSync('generated.txt', 'x');"],
          timeoutMs: 30_000,
        },
        {
          criterionId: 'writes-build-output',
          command: 'node',
          args: ['-e', "require('node:fs').mkdirSync('build'); require('node:fs').writeFileSync('build/out.js', 'compiled');"],
          timeoutMs: 30_000,
        },
      ],
      outputRoot: candidate.outputRoot,
    });

    expect(receipts[0]!.outcome).toBe('integrity_failed');
    expect(receipts[0]!.integrity.mutatedFiles).toEqual(['README.md (deleted)']);
    expect(receipts[0]!.integrity.addedFiles).toContain('generated.txt');

    // Output written into the disposable copy is recorded, not treated as tampering.
    expect(receipts[1]!.outcome).toBe('passed');
    expect(receipts[1]!.integrity.mutated).toBe(false);
    expect(receipts[1]!.integrity.addedFiles).toContain(`build${path.sep}out.js`);
    expect(receipts[1]!.diagnostics.join(' ')).toContain('discarded with the copy');
  });

  it('gives a check a sanitized environment with no coordinator secrets and a fresh HOME', async () => {
    const candidate = await frozenCandidate({ fix: true });
    process.env['WORKFORCE_TEST_API_TOKEN'] = 'super-secret-value-not-for-tests';
    process.env['WORKFORCE_TEST_ORDINARY'] = 'ordinary-value';
    registerCleanup(() => {
      delete process.env['WORKFORCE_TEST_API_TOKEN'];
      delete process.env['WORKFORCE_TEST_ORDINARY'];
    });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [
        {
          criterionId: 'prints-env',
          command: 'node',
          args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
          // A secret supplied in the check definition is dropped as well.
          env: { HARMLESS: 'yes', SOME_API_KEY: 'should-never-arrive' },
          timeoutMs: 30_000,
        },
      ],
      outputRoot: candidate.outputRoot,
    });

    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe('passed');
    const seen = JSON.parse(readFileSync(receipt.stdoutPath, 'utf8')) as Record<string, string>;

    expect(seen['WORKFORCE_TEST_API_TOKEN']).toBeUndefined();
    expect(seen['WORKFORCE_TEST_ORDINARY']).toBeUndefined(); // not on the whitelist either
    expect(seen['SOME_API_KEY']).toBeUndefined();
    expect(seen['HARMLESS']).toBe('yes');
    expect(seen['PATH']).toBe(process.env['PATH']);
    expect(seen['HOME']).toBeDefined();
    expect(seen['HOME']).not.toBe(os.homedir());
    expect(seen['TMPDIR']).not.toBe(process.env['TMPDIR']);
    expect(Object.keys(seen).sort()).toEqual(expect.arrayContaining(['HOME', 'PATH', 'TMPDIR']));
    expect(receipt.diagnostics.join(' ')).toContain('SOME_API_KEY');
    // The recorded identity lists only names, never values.
    expect(JSON.stringify(receipt.environmentIdentity)).not.toContain('should-never-arrive');
  });

  it('records a command that cannot be started as an error, never as a pass', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'missing-tool', command: 'workforce-no-such-executable', args: [], timeoutMs: 10_000 }],
      outputRoot: candidate.outputRoot,
    });
    expect(receipts[0]!.outcome).toBe('error');
    expect(decideAcceptance([{ id: 'missing-tool' }], receipts).accepted).toBe(false);
  });

  it('refuses a duplicate criterion id', async () => {
    const candidate = await frozenCandidate({ fix: true });
    await expect(
      runChecks({
        candidate: candidate.ref,
        checks: [
          { criterionId: 'same', command: 'node', args: ['-e', ''] },
          { criterionId: 'same', command: 'node', args: ['-e', ''] },
        ],
        outputRoot: candidate.outputRoot,
      }),
    ).rejects.toThrow(/appears more than once/);
  });

  it('leaves the user checkout untouched while it verifies', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const before = await fingerprintCheckout(candidate.repo);
    await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });
    const after = await fingerprintCheckout(candidate.repo);
    expect(after.head).toBe(before.head);
    expect(after.tree).toBe(before.tree);
    expect(after.status).toBe(before.status);
  });
});

describe('a check that executed nothing is not a pass', () => {
  it('records node --test finding no runnable file as no_tests_executed, not passed', async () => {
    const candidate = await frozenCandidate({ fix: true });
    // "docs/" holds no test file, so the runner starts, finds nothing and exits 0.
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'src/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });
    expect(receipts[0]!.exitCode).toBe(0);
    expect(receipts[0]!.outputSummary.testsRun).toBe(0);
    expect(receipts[0]!.outcome).toBe('no_tests_executed');
    expect(decideAcceptance([{ id: 'node-tests' }], receipts).accepted).toBe(false);
  });

  it('leaves a real suite alone', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });
    expect(receipts[0]!.outcome).toBe('passed');
    expect(receipts[0]!.outputSummary.runner).toBe('node_test');
    expect(receipts[0]!.outputSummary.testsRun).toBeGreaterThan(0);
  });
});

describe('summarizeCheckOutput reads a runner\'s own count and guesses nothing', () => {
  it('recognizes the node and python summaries', () => {
    expect(summarizeCheckOutput('ℹ tests 12\nℹ pass 12\n', '')).toMatchObject({ runner: 'node_test', testsRun: 12 });
    expect(summarizeCheckOutput('# tests 3\n# fail 0\n', '')).toMatchObject({ runner: 'node_test', testsRun: 3 });
    expect(summarizeCheckOutput('', 'Ran 4 tests in 0.002s\n\nOK\n')).toMatchObject({ runner: 'python_unittest', testsRun: 4 });
    expect(summarizeCheckOutput('', 'Ran 0 tests in 0.000s\n\nNO TESTS RAN\n')).toMatchObject({ runner: 'python_unittest', testsRun: 0 });
  });

  it('reports null rather than a guess for anything else', () => {
    const summary = summarizeCheckOutput('Build succeeded. 12 warnings.\n', '');
    expect(summary.runner).toBeNull();
    expect(summary.testsRun).toBeNull();
  });
});

describe('buildCheckEnv', () => {
  it('keeps only the whitelist plus explicit non-sensitive values', () => {
    const { env, dropped } = buildCheckEnv('/tmp/home', '/tmp/tmp', { NORMAL: '1', GITHUB_TOKEN: 'x', DATABASE_PASSWORD: 'y' });
    expect(env['HOME']).toBe('/tmp/home');
    expect(env['TMPDIR']).toBe('/tmp/tmp');
    expect(env['NORMAL']).toBe('1');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['DATABASE_PASSWORD']).toBeUndefined();
    expect(dropped.sort()).toEqual(['DATABASE_PASSWORD', 'GITHUB_TOKEN']);
  });
});

describe('scanTrackedFiles', () => {
  it('ignores Git administration and changes when a file changes', async () => {
    const dir = tempDir('workforce-scan-');
    writeFileSync(path.join(dir, 'a.txt'), 'one');
    const first = scanTrackedFiles(dir);
    expect(first.files.has('a.txt')).toBe(true);
    writeFileSync(path.join(dir, 'a.txt'), 'two');
    expect(scanTrackedFiles(dir).digest).not.toBe(first.digest);
  });
});

describe('decideAcceptance is the only route to a passed criterion (FR050)', () => {
  const receipt = (criterionId: string, outcome: CheckReceipt['outcome']): CheckReceipt =>
    ({
      id: `receipt-${criterionId}`,
      criterionId,
      description: null,
      required: true,
      command: 'node',
      args: [],
      cwd: '.',
      timeoutMs: 1000,
      outcome,
      exitCode: outcome === 'passed' ? 0 : 1,
      signal: null,
      timedOut: false,
      startedAt: '2026-09-07T00:00:00.000Z',
      endedAt: '2026-09-07T00:00:01.000Z',
      durationMs: 1000,
      environmentIdentity: { node: 'v26', os: 'darwin', osRelease: '25', arch: 'arm64', pathHash: 'x', envKeys: [] },
      candidate: { repoRoot: '/repo', revision: 'abc', patchHash: null },
      copyStrategy: 'git_archive',
      integrity: { before: 'a', after: 'a', mutated: false, mutatedFiles: [], addedFiles: [], fileCount: 1, scope: 'complete' },
      outputSummary: { runner: 'node_test', testsRun: 3, note: 'node --test reported 3 test(s)' },
      stdoutPath: '/dev/null',
      stderrPath: '/dev/null',
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      stdoutTail: '',
      stderrTail: '',
      evidenceProvenance: 'verifier_executed',
      diagnostics: [],
    }) satisfies CheckReceipt;

  it('refuses a passing receipt whose fixtures the candidate rewrote (plan section 9)', () => {
    const decision = decideAcceptance([{ id: 'tests' }], [receipt('tests', 'passed')], {
      fixtureMutations: [{ criterionId: 'tests', changedPaths: ['M test/pagination.test.js'] }],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.requiredPassed).toBe(0);
    expect(decision.criteria[0]!.status).toBe('compromised');
    expect(decision.criteria[0]!.detail).toContain('M test/pagination.test.js');
    expect(decision.reasons.join(' ')).toContain('does not establish the criterion the base revision defined');
  });

  it('applies a "*" fixture mutation to every criterion', () => {
    const decision = decideAcceptance([{ id: 'tests' }, { id: 'lint' }], [receipt('tests', 'passed'), receipt('lint', 'passed')], {
      fixtureMutations: [{ criterionId: '*', changedPaths: ['D test/a.test.js'] }],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.criteria.map((c) => c.status)).toEqual(['compromised', 'compromised']);
  });

  it('lets a run-level blocker refuse acceptance even when every criterion passed', () => {
    const decision = decideAcceptance([{ id: 'tests' }], [receipt('tests', 'passed')], {
      blockers: ['the worker wrote outside its granted paths (/elsewhere/note.txt)'],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.requiredPassed).toBe(1); // the criterion really did pass...
    expect(decision.criteria[0]!.status).toBe('passed');
    expect(decision.reasons).toEqual(['the worker wrote outside its granted paths (/elsewhere/note.txt)']); // ... and the run is still not accepted
  });

  it('refuses to accept a criterion that has no receipt at all', () => {
    const decision = decideAcceptance([{ id: 'tests' }, { id: 'lint' }], [receipt('tests', 'passed')]);
    expect(decision.accepted).toBe(false);
    expect(decision.criteria.find((c) => c.criterionId === 'lint')?.status).toBe('no_evidence');
    expect(decision.reasons.join(' ')).toContain('no verifier-executed evidence');
    expect(decision.requiredPassed).toBe(1);
    expect(decision.requiredTotal).toBe(2);
  });

  it('accepts only when every required criterion has a passing receipt', () => {
    const decision = decideAcceptance([{ id: 'tests' }, { id: 'lint' }], [receipt('tests', 'passed'), receipt('lint', 'passed')]);
    expect(decision.accepted).toBe(true);
  });

  it('never accepts when there are no criteria at all', () => {
    expect(decideAcceptance([], []).accepted).toBe(false);
  });

  it('keeps an unrequested receipt as evidence without letting it grant acceptance', () => {
    const decision = decideAcceptance([{ id: 'tests' }], [receipt('tests', 'failed'), receipt('extra', 'passed')]);
    expect(decision.accepted).toBe(false);
    expect(decision.criteria.find((c) => c.criterionId === 'extra')?.detail).toContain('not part of the task contract');
  });
});

describe('persistCheckReceipts stores evidence durably', () => {
  it('writes logs and receipts to the artifact store and records the check row', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const state = openTempState();
    registerCleanup(() => state.cleanup());
    const run = insertRun(state.store.db, { request: sampleRequest(), policy: 'verification', limits: TEST_LIMITS });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });
    const persisted = persistCheckReceipts(state.store.db, state.paths, { runId: run.id, receipts });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.logArtifact.relativePath).toBe('checks/node-tests/stdout.log');
    expect(verifyArtifact(state.store.db, state.paths, persisted[0]!.logArtifact.id).ok).toBe(true);
    expect(getArtifact(state.store.db, persisted[0]!.receiptArtifact.id).type).toBe('check_receipt');

    const rows = listChecks(state.store.db, run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('passed');
    expect(rows[0]!.evidence_provenance).toBe('verifier_executed');
    expect(rows[0]!.candidate_revision).toBe(candidate.ref.revision);
    expect(rows[0]!.candidate_hash).toBe(candidate.ref.patchHash);
    expect(JSON.parse(rows[0]!.criterion_ids_json)).toEqual(['node-tests']);
  });
});
