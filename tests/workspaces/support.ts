/**
 * Shared helpers for the WP04 workspace, verification and run tests.
 *
 * Every test works on a *materialized* copy of a fixture, never on
 * `fixtures/<name>` itself, and records what to clean up.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultFakeRuntimeScript } from '../../src/adapters/index.js';
import { git } from '../../src/workspaces/git.js';
import { materializeFixture, type MaterializedFixture } from '../../fixtures/materialize.js';

const cleanups: Array<() => void> = [];

export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function cleanupAll(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

/** A temp directory, resolved through realpath so path comparisons in tests are stable on macOS. */
export function tempDir(prefix = 'workforce-wp04-'): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function useFixture(name: 'ts-bug' | 'py-bug'): Promise<MaterializedFixture> {
  const fixture = await materializeFixture(name);
  registerCleanup(() => fixture.cleanup());
  return fixture;
}

/** The corrected `src/pagination.js` for the ts-bug fixture: both off-by-one errors fixed. */
export function fixedPaginationSource(): string {
  return `/**
 * Pagination helpers for the search endpoint.
 */

/** Number of pages needed to display \`total\` items at \`pageSize\` per page. */
export function pageCount(total, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be greater than zero');
  if (total <= 0) return 0;
  return Math.ceil(total / pageSize);
}

/** The items on a 1-based \`page\`, including the remainder on the final page. */
export function paginate(items, page, pageSize) {
  if (pageSize <= 0) throw new RangeError('pageSize must be greater than zero');
  if (page < 1) throw new RangeError('page is 1-based');
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
`;
}

export interface FakeScenario {
  readonly scenarioVersion: 1;
  readonly steps?: ReadonlyArray<Record<string, unknown>>;
  readonly turns?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}

/** Write a fake-runtime scenario file and return its path. */
export function writeScenario(scenario: FakeScenario, dir = tempDir('workforce-scenario-')): string {
  const file = path.join(dir, 'scenario.json');
  writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`);
  return file;
}

/** A scenario that actually fixes the ts-bug fixture and then claims success. */
export function fixTheBugScenario(): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: 'Reading src/pagination.js and test/pagination.test.js.' },
      { action: 'edit_file', path: 'src/pagination.js', content: fixedPaginationSource() },
      { action: 'claim_done', message: 'Fixed both off-by-one errors; the tests should pass now.' },
    ],
  };
}


/** The corrected `src/ranges.py` for the py-bug fixture: both off-by-one errors fixed. */
export function fixedRangesSource(): string {
  return [
    '"""Range helpers used by the report generator."""',
    '',
    '',
    'def inclusive_range(start, end):',
    '    """Every integer from ``start`` to ``end``, with ``end`` included."""',
    '    if end < start:',
    '        return []',
    '    return list(range(start, end + 1))',
    '',
    '',
    'def chunk(values, size):',
    '    """Split ``values`` into consecutive chunks of ``size``, keeping the remainder."""',
    '    if size <= 0:',
    '        raise ValueError("size must be greater than zero")',
    '    chunks = []',
    '    for start in range(0, len(values), size):',
    '        chunks.append(values[start:start + size])',
    '    return chunks',
    '',
  ].join('\n');
}

/** A scenario that fixes the py-bug fixture. */
export function fixThePythonBugScenario(): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: 'Reading src/ranges.py and tests/test_ranges.py.' },
      { action: 'edit_file', path: 'src/ranges.py', content: fixedRangesSource() },
      { action: 'claim_done', message: 'Both helpers now include the final value.' },
    ],
  };
}

/** A scenario that claims success without touching a single file. */
export function claimDoneWithoutEditingScenario(): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: 'I reviewed the code.' },
      { action: 'claim_done', message: 'All done. The bug is fixed and every test passes.' },
    ],
  };
}

/** A scenario where the runtime writes a partial change and then dies mid-turn. */
export function runtimeExitsScenario(): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'edit_file', path: 'src/pagination.js', content: '// half-written change, the runtime died here\n' },
      { action: 'exit', code: 3 },
    ],
  };
}

/** A scenario that sleeps long enough for a test to interrupt it. */
export function longRunningScenario(ms = 10_000): FakeScenario {
  return {
    scenarioVersion: 1,
    steps: [
      { action: 'message', text: 'Starting a long investigation.' },
      { action: 'edit_file', path: 'src/pagination.js', content: fixedPaginationSource() },
      { action: 'sleep', ms },
      { action: 'claim_done', message: 'never reached' },
    ],
  };
}

/** Write an agent configuration bound to the deterministic fake runtime. */
export function writeFakeAgentsConfig(dir: string, options: { model?: string; effort?: string } = {}): string {
  const file = path.join(dir, 'agents.json');
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtimes: {
          'fake-local': {
            adapter: 'fake',
            executable: defaultFakeRuntimeScript(),
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.effort !== undefined ? { effort: options.effort } : {}),
          },
        },
        defaults: {
          workerAgent: 'engineer',
          maxActiveTurns: 2,
          maxActiveWriters: 2,
          maxTasksPerRun: 8,
          maxDelegationDepth: 2,
          maxRepairAttempts: 2,
          maxTransientRetries: 2,
          runTimeoutMinutes: 30,
        },
        agents: [
          {
            id: 'engineer',
            runtime: 'fake-local',
            instructions: 'Inspect the relevant code, fix the underlying issue, and submit evidence against the task criteria.',
            capabilities: ['coding', 'testing'],
            policy: 'local-development',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

// ---------------------------------------------------------------------------
// "The user's checkout is unchanged" assertions
// ---------------------------------------------------------------------------

export interface CheckoutFingerprint {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
  readonly tree: string;
  readonly indexMtimeMs: number | null;
}

function hashTree(root: string): string {
  const digest = createHash('sha256');
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (relative === '.git' || relative.startsWith(`.git${path.sep}`)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${relative}\0${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  for (const entry of entries.sort()) digest.update(`${entry}\n`);
  return digest.digest('hex');
}

/** Everything a test needs to prove the user's checkout was left alone. */
export async function fingerprintCheckout(repo: string): Promise<CheckoutFingerprint> {
  const head = (await git(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim();
  const status = (await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo })).stdout;
  let indexMtimeMs: number | null = null;
  try {
    indexMtimeMs = statSync(path.join(repo, '.git', 'index')).mtimeMs;
  } catch {
    indexMtimeMs = null;
  }
  return { head, branch, status, tree: hashTree(repo), indexMtimeMs };
}

/** Create a nested file inside a workspace (used to simulate worker edits). */
export function writeInto(root: string, relative: string, content: string): string {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}
