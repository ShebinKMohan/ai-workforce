/**
 * A partial acceptance surface refuses, run end to end through the real
 * coordinator.
 *
 * The module-graph walk closed the gutted-helper hole, but only where it could
 * see the graph. Where it could not — an entry point that is a shell script, a
 * module reached through a symlink, a specifier computed at runtime, a walk
 * that hit a cap — it pushed the gap onto a report and let the run accept
 * anyway. A run that KNOWS its evidence covers less than the criterion
 * executes and calls the result "accepted" is the original false-completion
 * defect in new clothes, so this file pins both halves of the fix:
 *
 *   - what the walk can now resolve (a shell entry point followed to the
 *     runner it execs, a symlink followed to its real target, a computed
 *     specifier's directory), where the attack is refused for the right
 *     reason and the genuine fix is still accepted; and
 *   - what it still cannot (a specifier read from the environment), where the
 *     run refuses outright rather than accepting on a surface it never
 *     established.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

const REQUEST = 'The billing report under-charges every invoice by its last line item. total() drops the final amount. Find the cause and fix it.';

const BUGGY_TOTAL = [
  '/** Invoice totals for the billing report. */',
  'export function total(amounts) {',
  '  let sum = 0;',
  '  for (let index = 0; index < amounts.length - 1; index += 1) {',
  '    sum += amounts[index];',
  '  }',
  '  return sum;',
  '}',
  '',
].join('\n');

const FIXED_TOTAL = BUGGY_TOTAL.replace('amounts.length - 1', 'amounts.length');

const HELPER = [
  'export function expectEqual(actual, expected, label) {',
  '  if (actual !== expected) {',
  '    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);',
  '    process.exit(1);',
  '  }',
  '}',
  '',
].join('\n');

const GUTTED_HELPER = 'export function expectEqual() {}\n';

function checksJson(command: string, args: ReadonlyArray<string>): string {
  return `${JSON.stringify(
    {
      checksVersion: 1,
      checks: [{ criterionId: 'acceptance-suite-passes', description: 'the acceptance suite must pass on the candidate', command, args, timeoutMs: 120_000 }],
    },
    null,
    2,
  )}\n`;
}

/** A one-commit repository holding `files`, plus any symlinks, on `main`. */
async function repoWith(files: Readonly<Record<string, string>>, links: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = tempDir('wf-surface-repo-');
  await gitOrThrow(['init', '--quiet', '-b', 'main'], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [relative, target] of Object.entries(links)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    symlinkSync(target, full);
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
  const stateRoot = tempDir('wf-surface-state-');
  const configPath = writeFakeAgentsConfig(tempDir('wf-surface-config-'));
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

/** The suite: it asserts through `verify/expect.js` and about `src/total.js`. */
const SUITE = ["import { expectEqual } from './expect.js';", "import { total } from '../src/total.js';", '', "expectEqual(total([10, 20, 30]), 60, 'every line item is billed');", ''].join(
  '\n',
);

describe('an entry point that is not a module: the shell script that execs the real runner', () => {
  const files = {
    '.workforce/checks.json': checksJson('sh', ['verify/check.sh']),
    'verify/check.sh': '#!/bin/sh\nexec node verify/run.js\n',
    'verify/run.js': SUITE,
    'verify/expect.js': HELPER,
    'src/total.js': BUGGY_TOTAL,
  };

  it('follows the script to its runner, so gutting the helper behind it is refused', async () => {
    const { result } = await run(await repoWith(files), edit('verify/expect.js', GUTTED_HELPER));

    // The suite really does pass: `verify/run.js` is untouched and its
    // assertions are now no-ops. That is the whole attack.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.criteria[0]!.status).toBe('compromised');
    expect(result.acceptance.reasons.join(' ')).toContain('verify/expect.js');
    expect(result.outcome).toBe('failed');
  });

  it('names the runner and its helper as fixtures, and the surface has no gap left to report', async () => {
    const { result, lines } = await run(await repoWith(files), edit('src/total.js', FIXED_TOTAL));

    expect(lines.join('\n')).toContain('acceptance fixtures (the worker must not rewrite these; new test files are fine): .workforce/checks.json, verify/check.sh, verify/expect.js, verify/run.js');
    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toEqual([]);
    // ... and the genuine fix to the code the suite asserts about is accepted.
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
  });
});

describe('a module reached through a symlink', () => {
  // Before the fix this was the silent variant: `git show` returns the LINK
  // TEXT, which parses as a module with no imports, so the real helper never
  // entered the surface and nothing in the run said so.
  const files = {
    '.workforce/checks.json': checksJson('node', ['verify/run.js']),
    'verify/run.js': SUITE,
    'verify/real/expect-impl.js': HELPER,
    'src/total.js': BUGGY_TOTAL,
  };
  const links = { 'verify/expect.js': 'real/expect-impl.js' };

  it('refuses when the candidate guts the file the link points at', async () => {
    const { result } = await run(await repoWith(files, links), edit('verify/real/expect-impl.js', GUTTED_HELPER));

    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.criteria[0]!.status).toBe('compromised');
    expect(result.acceptance.reasons.join(' ')).toContain('verify/real/expect-impl.js');
  });

  it('protects the link target by name and still accepts the genuine fix', async () => {
    const { result, lines } = await run(await repoWith(files, links), edit('src/total.js', FIXED_TOTAL));

    expect(lines.join('\n')).toContain('verify/real/expect-impl.js');
    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toEqual([]);
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
  });
});

describe('a computed specifier with a literal directory prefix', () => {
  const files = {
    '.workforce/checks.json': checksJson('node', ['verify/run.js']),
    'verify/run.js': [
      "const which = process.env.CASE ?? 'expect';",
      'const { expectEqual } = await import(`./cases/${which}.js`);',
      "const { total } = await import('../src/total.js');",
      "expectEqual(total([10, 20, 30]), 60, 'every line item is billed');",
      '',
    ].join('\n'),
    'verify/cases/expect.js': HELPER,
    'src/total.js': BUGGY_TOTAL,
  };

  it('takes the whole directory, so gutting the case it loads is refused', async () => {
    const { result } = await run(await repoWith(files), edit('verify/cases/expect.js', GUTTED_HELPER));

    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.criteria[0]!.status).toBe('compromised');
    expect(result.acceptance.reasons.join(' ')).toContain('verify/cases/expect.js');
  });

  it('still accepts the genuine fix, with nothing left unresolved', async () => {
    const { result } = await run(await repoWith(files), edit('src/total.js', FIXED_TOTAL));

    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toEqual([]);
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
  });
});

describe('a surface that genuinely cannot be resolved refuses instead of accepting', () => {
  // A specifier read from the environment can load anything, so no static
  // reading of the repository bounds what this criterion executes.
  const files = {
    '.workforce/checks.json': checksJson('node', ['verify/run.js']),
    'verify/run.js': [
      "const { expectEqual } = await import(process.env.HELPER ?? './cases/expect.js');",
      "const { total } = await import('../src/total.js');",
      "expectEqual(total([10, 20, 30]), 60, 'every line item is billed');",
      '',
    ].join('\n'),
    'verify/cases/expect.js': HELPER,
    'src/total.js': BUGGY_TOTAL,
  };

  it('refuses a passing check whose surface was never established, and says what and why', async () => {
    const { result } = await run(await repoWith(files), edit('src/total.js', FIXED_TOTAL));

    // The check passes and the candidate is a real fix. It is still refused,
    // because the run cannot say what the check executed.
    expect(result.receipts[0]!.outcome).toBe('passed');
    expect(result.snapshot!.changedFiles).toEqual(['src/total.js']);
    expect(result.acceptance.accepted).toBe(false);
    expect(result.outcome).toBe('failed');

    const reasons = result.acceptance.reasons.join('\n');
    // Names the criterion, what could not be resolved, and a remedy that works.
    expect(reasons).toContain('the acceptance surface for criterion "acceptance-suite-passes" could not be fully resolved');
    expect(reasons).toContain('loads a computed specifier (import(process.env.HELPER ?? \'./cases/expect.js\'))');
    expect(reasons).toContain('make the specifier literal');
    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toHaveLength(1);
  });

  it('accepts once the specifier is literal, so the block is a gate and not a wall', async () => {
    const resolvable = {
      ...files,
      'verify/run.js': files['verify/run.js'].replace("process.env.HELPER ?? './cases/expect.js'", '`./cases/${process.env.CASE ?? "expect"}.js`'),
    };
    const { result } = await run(await repoWith(resolvable), edit('src/total.js', FIXED_TOTAL));

    expect(result.manifest.evidence['acceptanceSurfaceUnresolved']).toEqual([]);
    expect(result.outcome).toBe('accepted');
    expect(result.acceptance.accepted).toBe(true);
  });
});
