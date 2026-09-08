import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ensureRunDir, isWithin } from '../../src/storage/paths.js';
import { getArtifact, verifyArtifact } from '../../src/storage/artifacts.js';
import { createCandidateWorkspace, snapshotCandidate } from '../../src/workspaces/candidate.js';
import { openTempState, sampleRequest, TEST_LIMITS, type TempState } from '../helpers/state.js';
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

// ---------------------------------------------------------------------------
// Where a check is allowed to run (plan section 9)
// ---------------------------------------------------------------------------

interface HostedCandidate extends Candidate {
  readonly state: TempState;
  readonly runId: string;
  readonly runDir: string;
  /** Parent of the disposable copies; a registered temp dir so traversal writes are cleaned up. */
  readonly verificationRoot: string;
}

/**
 * A candidate whose check output lands where a real run puts it:
 * `<state-root>/runs/<run-id>/verification`, inside the coordinator's own
 * state directory.
 */
async function candidateInsideStateRoot(options: { fix: boolean }): Promise<HostedCandidate> {
  const candidate = await frozenCandidate(options);
  const state = openTempState();
  registerCleanup(() => state.cleanup());
  const run = insertRun(state.store.db, { request: sampleRequest(), policy: 'verification', limits: TEST_LIMITS });
  ensureRunDir(state.paths, run.id);
  const runDir = state.paths.runDir(run.id);
  return {
    ...candidate,
    outputRoot: path.join(runDir, 'verification'),
    state,
    runId: run.id,
    runDir,
    verificationRoot: tempDir('workforce-vroot-'),
  };
}

/** Every path under `root` whose basename is `name`. */
function findByName(root: string, name: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) found.push(full);
    }
  }
  return found;
}

const TRAVERSAL_SCRIPT = [
  "const fs = require('node:fs');",
  "const notes = [];",
  "for (const relative of ['../PWNED.txt', '../../PWNED.txt', '../../../PWNED.txt', '../../../../PWNED.txt']) {",
  "  try { fs.writeFileSync(relative, 'owned by the check'); notes.push('wrote ' + relative); }",
  "  catch (error) { notes.push('failed ' + relative + ': ' + error.code); }",
  "}",
  "process.stdout.write(notes.join('\\n'));",
].join('\n');

describe('a check never runs inside the coordinator state root (plan section 9)', () => {
  it('cannot reach coordinator state by walking up from its working directory', async () => {
    const candidate = await candidateInsideStateRoot({ fix: true });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'traverses-upwards', command: 'node', args: ['-e', TRAVERSAL_SCRIPT], timeoutMs: 30_000 }],
      outputRoot: candidate.outputRoot,
      verificationRoot: candidate.verificationRoot,
    });

    const receipt = receipts[0]!;
    const containment = receipt.containment!;

    // The check ran outside the state root, so the run directory was never an ancestor of its cwd.
    expect(containment.outsideStateRoot).toBe(true);
    expect(containment.stateRoot).toBe(candidate.state.root);
    expect(isWithin(candidate.state.root, containment.cwd)).toBe(false);
    expect(isWithin(candidate.state.root, containment.copyRoot)).toBe(false);
    expect(isWithin(candidate.state.root, containment.home)).toBe(false);
    expect(isWithin(candidate.state.root, containment.tmp)).toBe(false);
    expect(isWithin(candidate.verificationRoot, containment.copyRoot)).toBe(true);

    // The escape attempt was real: some of those writes did land somewhere.
    const targets = ['..', '../..', '../../..', '../../../..'].map((up) => path.resolve(containment.copyRoot, up, 'PWNED.txt'));
    for (const target of targets) registerCleanup(() => rmSync(target, { force: true }));
    expect(targets.some((target) => existsSync(target))).toBe(true);
    for (const target of targets) expect(isWithin(candidate.state.root, target)).toBe(false);

    // And none of it reached the coordinator's state.
    expect(findByName(candidate.state.root, 'PWNED.txt')).toEqual([]);
    expect(existsSync(path.join(candidate.runDir, 'PWNED.txt'))).toBe(false);
    expect(existsSync(path.join(candidate.outputRoot, 'PWNED.txt'))).toBe(false);
    expect(receipt.stateRootGuard!.checked).toBe(true);
    expect(receipt.stateRootGuard!.violations).toEqual([]);
    expect(receipt.stateRootGuard!.before).toBe(receipt.stateRootGuard!.after);

    // What it did do is on the record, in the log kept under the run directory.
    expect(readFileSync(receipt.stdoutPath, 'utf8')).toContain('PWNED.txt');
    expect(isWithin(candidate.runDir, receipt.stdoutPath)).toBe(true);
  });

  it('records a write that reached the state root by absolute path as an integrity failure', async () => {
    const candidate = await candidateInsideStateRoot({ fix: true });
    const target = path.join(candidate.state.root, 'PWNED.txt');

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [
        {
          criterionId: 'node-tests',
          command: 'node',
          args: ['-e', "require('node:fs').writeFileSync(process.env.PWN_TARGET, 'owned'); process.exit(0);"],
          env: { PWN_TARGET: target },
          timeoutMs: 30_000,
        },
      ],
      outputRoot: candidate.outputRoot,
      verificationRoot: candidate.verificationRoot,
    });

    const receipt = receipts[0]!;
    // Nothing about the working directory can stop an absolute path, so this
    // is detection: the check exited 0 and is still not a pass.
    expect(receipt.exitCode).toBe(0);
    expect(receipt.outcome).toBe('integrity_failed');
    expect(receipt.integrity.mutated).toBe(false); // the candidate copy itself is intact
    expect(receipt.stateRootGuard!.checked).toBe(true);
    expect(receipt.stateRootGuard!.violations).toContain('PWNED.txt (created)');
    expect(receipt.stateRootGuard!.before).not.toBe(receipt.stateRootGuard!.after);
    expect(receipt.diagnostics.join(' ')).toContain('coordinator state root');

    const decision = decideAcceptance([{ id: 'node-tests', description: 'the suite passes' }], receipts);
    expect(decision.accepted).toBe(false);
    expect(decision.criteria[0]!.status).toBe('failed');
    expect(decision.reasons.join(' ')).toContain("changed the coordinator's own state root");
  });

  it('keeps the receipts, logs and hashes under the run directory and the execution outside it', async () => {
    const candidate = await candidateInsideStateRoot({ fix: true });

    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
      verificationRoot: candidate.verificationRoot,
    });

    const receipt = receipts[0]!;
    // Unchanged behaviour: a fixed candidate still passes, with the same evidence.
    expect(receipt.outcome).toBe('passed');
    expect(receipt.exitCode).toBe(0);
    expect(receipt.evidenceProvenance).toBe('verifier_executed');
    expect(receipt.integrity.mutated).toBe(false);
    expect(receipt.integrity.before).toBe(receipt.integrity.after);
    expect(receipt.integrity.fileCount).toBeGreaterThan(0);
    expect(receipt.outputSummary.testsRun).toBeGreaterThan(0);

    // Evidence under the run directory...
    expect(isWithin(candidate.runDir, receipt.stdoutPath)).toBe(true);
    expect(isWithin(candidate.runDir, receipt.stderrPath)).toBe(true);
    expect(existsSync(receipt.stdoutPath)).toBe(true);
    expect(existsSync(receipt.stderrPath)).toBe(true);
    expect(receipt.containment!.evidenceRoot.startsWith(candidate.outputRoot)).toBe(true);

    // ...and no candidate copy under it, then or now.
    expect(findByName(candidate.outputRoot, 'candidate')).toEqual([]);
    expect(isWithin(candidate.state.root, receipt.containment!.copyRoot)).toBe(false);
    // The disposable copy and the verification root that held it are gone.
    expect(existsSync(receipt.containment!.copyRoot)).toBe(false);
    expect(existsSync(receipt.containment!.home)).toBe(false);
    expect(existsSync(path.dirname(path.dirname(receipt.containment!.copyRoot)))).toBe(false);

    // The receipt persists with everything else it always carried.
    const persisted = persistCheckReceipts(candidate.state.store.db, candidate.state.paths, { runId: candidate.runId, receipts });
    expect(persisted[0]!.logArtifact.relativePath).toBe('checks/node-tests/stdout.log');
    expect(verifyArtifact(candidate.state.store.db, candidate.state.paths, persisted[0]!.receiptArtifact.id).ok).toBe(true);
    expect(listChecks(candidate.state.store.db, candidate.runId)[0]!.outcome).toBe('passed');
  });

  it('still fails an unfixed candidate for its own reason, with the state root untouched', async () => {
    const candidate = await candidateInsideStateRoot({ fix: false });
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
      verificationRoot: candidate.verificationRoot,
    });

    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe('failed');
    expect(receipt.exitCode).not.toBe(0);
    expect(receipt.integrity.mutated).toBe(false);
    expect(receipt.stateRootGuard!.violations).toEqual([]);
    expect(decideAcceptance([{ id: 'node-tests' }], receipts).accepted).toBe(false);
  });

  it('says plainly when there was no state root to guard', async () => {
    const candidate = await frozenCandidate({ fix: true });
    const receipts = await runChecks({
      candidate: candidate.ref,
      checks: [{ criterionId: 'node-tests', command: 'node', args: ['--test', 'test/'], timeoutMs: 60_000 }],
      outputRoot: candidate.outputRoot,
    });
    const receipt = receipts[0]!;
    expect(receipt.outcome).toBe('passed');
    expect(receipt.containment!.stateRoot).toBeNull();
    expect(receipt.containment!.outsideStateRoot).toBe(true);
    expect(receipt.stateRootGuard!.checked).toBe(false);
    expect(receipt.stateRootGuard!.note).toContain('nothing was compared');
  });
});
