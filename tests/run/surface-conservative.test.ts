/**
 * A repository the module walk cannot read, run end to end through the real
 * coordinator.
 *
 * Making an unresolved surface refuse closed a real false-completion hole, and
 * it must stay closed. But the walk reads JavaScript, TypeScript and Python and
 * nothing else, so on a repository written in Go, Rust, C, Ruby, Swift — or, as
 * here, in shell — every criterion was unresolved and NO run could ever be
 * accepted. A refusal that no correct candidate can ever satisfy is not a
 * safety property, it is an outage.
 *
 * So this file pins the middle ground, in both directions:
 *
 *   - a correct fix in such a repository is ACCEPTED, and the run says on the
 *     terminal and in the manifest that the closure was not proven;
 *   - what can be identified without parsing is still protected, so rewriting
 *     the acceptance suite is still refused; and
 *   - naming the criterion's fixtures in `.workforce/checks.json` upgrades the
 *     run to a fully established surface with no limitation left to report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfigFile } from '../../src/core/config.js';
import { FAKE_SCENARIO_ENV } from '../../src/adapters/index.js';
import { runDirect, type RunDirectResult, type RunStream } from '../../src/core/run-direct.js';
import { openStateStore } from '../../src/storage/db.js';
import { createStatePaths } from '../../src/storage/paths.js';
import { COORDINATOR_IDENTITY, gitOrThrow } from '../../src/workspaces/git.js';
import { cleanupAll, tempDir, writeFakeAgentsConfig, writeScenario, type FakeScenario } from '../workspaces/support.js';

afterEach(() => cleanupAll());

const REQUEST = 'total.sh under-counts every invoice by its last line item. Find the cause and fix it.';

/** The product, in a language this walk has no reader for. The loop drops the final amount. */
const BUGGY_TOTAL = ['#!/bin/sh', '# total.sh: sum the amounts given as arguments.', 'sum=0', 'while [ "$#" -gt 1 ]; do', '  sum=$((sum + $1))', '  shift', 'done', 'echo "$sum"', ''].join('\n');

const FIXED_TOTAL = BUGGY_TOTAL.replace('[ "$#" -gt 1 ]', '[ "$#" -gt 0 ]');

/**
 * The acceptance suite, also in shell. It runs the product from inside `src`,
 * so no literal word in it names a file of this repository: the walk can
 * follow nothing at all from here, which is exactly the case under test.
 */
const SUITE = ['#!/bin/sh', '# The acceptance suite: every line item must be billed.', 'cd src || exit 1', 'sh ./total.sh 10 20 30 | grep -qxf ../verify/expected.txt', ''].join('\n');

const EXPECTED = '60\n';

function checksJson(fixtures?: ReadonlyArray<string>): string {
  return `${JSON.stringify(
    {
      checksVersion: 1,
      checks: [
        {
          criterionId: 'acceptance-suite-passes',
          description: 'the acceptance suite must pass on the candidate',
          command: 'sh',
          args: ['verify/check.sh'],
          timeoutMs: 120_000,
          ...(fixtures === undefined ? {} : { fixtures }),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function shellRepoFiles(fixtures?: ReadonlyArray<string>): Record<string, string> {
  return {
    '.workforce/checks.json': checksJson(fixtures),
    'verify/check.sh': SUITE,
    'verify/expected.txt': EXPECTED,
    'src/total.sh': BUGGY_TOTAL,
  };
}

async function repoWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = tempDir('wf-conservative-repo-');
  await gitOrThrow(['init', '--quiet', '-b', 'main'], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const options = { cwd: root, identity: COORDINATOR_IDENTITY, noHooksDir: root } as const;
  await gitOrThrow(['add', '-A'], options);
  await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', 'base'], options);
  return root;
}

interface Outcome {
  readonly result: RunDirectResult;
  readonly lines: ReadonlyArray<string>;
}

async function run(repo: string, scenario: FakeScenario): Promise<Outcome> {
  const stateRoot = tempDir('wf-conservative-state-');
  const configPath = writeFakeAgentsConfig(tempDir('wf-conservative-config-'));
  const lines: string[] = [];
  const stream: RunStream = { line: (text) => lines.push(text), event: () => {} };
  const paths = createStatePaths(stateRoot);
  const store = openStateStore(paths, { mode: 'mutating' });
  try {
    const loaded = loadAgentConfigFile(configPath);
    const result = await runDirect({
      // The fake runtime enforces no write boundary, so a writing profile on it is an explicitly accepted unconfined run.
      allowUnconfinedWrites: true,
      repoPath: repo,
      config: loaded.config,
      configRaw: loaded.raw,
      configPath: loaded.path,
      requestText: REQUEST,
      requestSource: 'argument',
      paths,
      db: store.db,
      stream,
      sessionEnv: { [FAKE_SCENARIO_ENV]: writeScenario(scenario) },
    });
    return { result, lines };
  } finally {
    store.close();
  }
}

function edit(file: string, content: string): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: `Editing ${file}.` },
      { action: 'edit_file', path: file, content },
      { action: 'claim_done', message: 'Done.' },
    ],
  };
}

interface Resolution {
  readonly moduleGraphResolved: boolean;
  readonly entryPoints: ReadonlyArray<string>;
  readonly filesVisited: number;
  readonly partial: boolean;
  readonly conservative: boolean;
}

describe('a repository whose language the acceptance surface cannot analyse', () => {
  it('accepts the correct fix, and says on the terminal and in the manifest that the closure was not proven', async () => {
    const { result, lines } = await run(await repoWith(shellRepoFiles()), edit('src/total.sh', FIXED_TOTAL));

    // The check really did run and really did pass on the candidate.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.snapshot!.changedFiles).toEqual(['src/total.sh']);
    // And the run happened at all, which before this it could not.
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
    expect(result.acceptance.reasons.join(' ')).not.toContain('could not be fully resolved');

    // The operator is told, in the criterion's own name, what was not proven.
    const printed = lines.join('\n');
    expect(printed).toContain('acceptance surface (CONSERVATIVE, dependency analysis unavailable) for criterion "acceptance-suite-passes"');
    expect(printed).toContain('verify/expected.txt is executed by a criterion but is not a JavaScript, TypeScript or Python module');
    expect(printed).toContain('closure was NOT proven');

    const resolution = result.manifest.evidence['acceptanceSurfaceResolution'] as Resolution;
    expect(resolution.conservative).toBe(true);
    const limitations = result.manifest.evidence['acceptanceSurfaceLimitations'] as ReadonlyArray<{ criterionId: string; kind: string; detail: string }>;
    expect(limitations).toHaveLength(1);
    expect(limitations[0]!.criterionId).toBe('acceptance-suite-passes');
    expect(limitations[0]!.kind).toBe('language_unsupported');
    // The residual risk is a recorded unresolved fact, not a footnote nobody reads.
    expect(result.manifest.unresolved.join('\n')).toContain('was resolved in a CONSERVATIVE mode rather than established');
  });

  it('still refuses a candidate that rewrites the acceptance suite it could identify without parsing', async () => {
    const { result } = await run(await repoWith(shellRepoFiles()), edit('verify/expected.txt', '30\n'));

    // The suite "passes": the expected value now matches the buggy total.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.criteria[0]!.status).toBe('compromised');
    expect(result.acceptance.reasons.join(' ')).toContain('verify/expected.txt');
    expect(result.outcome).toBe('failed');
  });

  it('is upgraded to an established surface when the check names its fixtures', async () => {
    const files = shellRepoFiles(['verify/check.sh', 'verify/expected.txt']);
    const { result, lines } = await run(await repoWith(files), edit('src/total.sh', FIXED_TOTAL));

    expect(result.outcome).toBe('accepted');
    const resolution = result.manifest.evidence['acceptanceSurfaceResolution'] as Resolution;
    expect(resolution.conservative).toBe(false);
    expect(result.manifest.evidence['acceptanceSurfaceLimitations']).toEqual([]);
    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toEqual([]);
    expect(lines.join('\n')).not.toContain('CONSERVATIVE');
    expect(result.manifest.unresolved.join('\n')).not.toContain('CONSERVATIVE');
    // The declared fixtures are protected, so the upgrade is not a weakening.
    expect(lines.join('\n')).toContain('acceptance fixtures (the worker must not rewrite these; new test files are fine): .workforce/checks.json, verify/check.sh, verify/expected.txt');
  });

  it('refuses when the check declares a fixture the base revision does not contain', async () => {
    const files = shellRepoFiles(['verify/check.sh', 'verify/expectations.txt']);
    const { result } = await run(await repoWith(files), edit('src/total.sh', FIXED_TOTAL));

    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons.join(' ')).toContain('declares the fixture path(s) verify/expectations.txt');
    expect(result.acceptance.reasons.join(' ')).toContain('correct the "fixtures" paths');
  });
});
