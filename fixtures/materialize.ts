/**
 * Materialize a fixture repository into a temporary directory.
 *
 * Tests and demonstrations must never run against `fixtures/<name>` itself:
 * a run creates branches, worktrees and commits, and a check runner executes
 * repository code. `materializeFixture` copies the fixture into a fresh
 * directory and gives it its own Git history, so the fixture source in this
 * repository stays byte-identical no matter what a run does to the copy.
 *
 * The copy's Git identity is set with `git -c`/local config only — the user's
 * global Git configuration is never read for authorship and never written.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOrThrow, gitText, ensureNoHooksDir } from '../src/workspaces/git.js';

export const FIXTURE_NAMES = ['ts-bug', 'py-bug'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const FIXTURE_IDENTITY = { name: 'fixture author', email: 'fixture@workforce.invalid' } as const;

export interface MaterializeOptions {
  /** Where to create the copy. A fresh temp directory is used when omitted. */
  readonly targetDir?: string;
  readonly branch?: string;
  readonly commitMessage?: string;
}

export interface MaterializedFixture {
  readonly name: string;
  /** Realpath of the repository root of the copy. */
  readonly path: string;
  readonly branch: string;
  readonly headRevision: string;
  cleanup(): void;
}

export function fixturesRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

export function fixturePath(name: string): string {
  return path.join(fixturesRoot(), name);
}

/**
 * Copy `fixtures/<name>` to a temporary directory, `git init` it and create
 * one initial commit. The returned `path` is safe to register, branch and
 * mutate; `cleanup()` removes it.
 */
export async function materializeFixture(name: string, options: MaterializeOptions = {}): Promise<MaterializedFixture> {
  const source = fixturePath(name);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`fixture "${name}" not found at ${source}; available fixtures: ${FIXTURE_NAMES.join(', ')}`);
  }

  const target = options.targetDir === undefined ? mkdtempSync(path.join(os.tmpdir(), `workforce-fixture-${name}-`)) : path.resolve(options.targetDir);
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true, filter: (from) => path.basename(from) !== '.git' });

  const branch = options.branch ?? 'main';
  const noHooksDir = ensureNoHooksDir(target);
  const base = { cwd: target, noHooksDir, identity: FIXTURE_IDENTITY } as const;

  await gitOrThrow(['init', '--quiet', `--initial-branch=${branch}`], base);
  // Local config only: the user's global identity is neither read nor written.
  await gitOrThrow(['config', 'user.name', FIXTURE_IDENTITY.name], base);
  await gitOrThrow(['config', 'user.email', FIXTURE_IDENTITY.email], base);
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], base);
  await gitOrThrow(['add', '-A'], base);
  await gitOrThrow(['commit', '--no-verify', '--no-gpg-sign', '-m', options.commitMessage ?? `import ${name} fixture`], base);

  const headRevision = await gitText(['rev-parse', 'HEAD'], { cwd: target });
  const realPath = realpathSync(target);

  return {
    name,
    path: realPath,
    branch,
    headRevision,
    cleanup: () => {
      rmSync(target, { recursive: true, force: true });
      if (realPath !== target) rmSync(realPath, { recursive: true, force: true });
    },
  };
}
