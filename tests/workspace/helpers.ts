/**
 * Shared helpers for the workspace tests. Every test uses its own temp state
 * root; nothing here reads or writes ~/.workforce.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/cli/index.js';
import { emptyWorkspace, type WorkspaceConfig } from '../../src/core/workspace-config.js';
import { WorkspaceError } from '../../src/workspace/errors.js';
import { applyWorkspaceOps, parseWorkspaceOps } from '../../src/workspace/operations.js';
import { gitOrThrow } from '../../src/workspaces/git.js';

const cleanups: Array<() => void> = [];

export function cleanupAll(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function tempDir(prefix = 'workforce-ws-'): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Apply raw ops (validated exactly as a request body would be) to a workspace. */
export function build(rawOps: ReadonlyArray<Record<string, unknown>>, base: WorkspaceConfig = emptyWorkspace()): WorkspaceConfig {
  return applyWorkspaceOps(base, parseWorkspaceOps(rawOps));
}

/** The refusal a function throws, for asserting its code and exit code. */
export function refusal(fn: () => unknown): WorkspaceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  }
  throw new Error('expected a WorkspaceError, but nothing was thrown');
}

/**
 * Two projects, three departments (two of them called Engineering), a bench
 * worker, an archived worker, and a department without a head.
 */
export function sampleWorkspace(repos: { checkout: string; billing: string } = { checkout: '/repos/checkout', billing: '/repos/billing' }): WorkspaceConfig {
  return build([
    { op: 'project.add', repoPath: repos.checkout, name: 'checkout' },
    { op: 'project.add', repoPath: repos.billing, name: 'billing' },
    { op: 'department.add', name: 'Engineering', note: 'Platform' },
    { op: 'department.add', name: 'Engineering', note: 'Payments' },
    { op: 'department.add', name: 'Design' },
    { op: 'agent.add', id: 'atlas', name: 'Atlas', role: 'head', departmentId: 'engineering-platform', runtime: 'codex-local' },
    { op: 'agent.add', id: 'nova', name: 'Nova', role: 'worker', projectScope: 'restricted', departmentId: 'engineering-platform', runtime: 'codex-local', projectIds: ['checkout'] },
    { op: 'agent.add', id: 'forge', name: 'Forge', role: 'worker', projectScope: 'restricted', departmentId: 'engineering-platform', runtime: 'claude-local', projectIds: ['billing'] },
    { op: 'agent.add', id: 'bench', name: 'Bench', role: 'worker', projectScope: 'restricted', departmentId: 'engineering-platform', runtime: 'codex-local' },
    { op: 'agent.add', id: 'iris', name: 'Iris', role: 'head', departmentId: 'engineering-payments', runtime: 'claude-local' },
    { op: 'agent.add', id: 'probe', name: 'Probe', role: 'worker', projectScope: 'restricted', departmentId: 'engineering-payments', runtime: 'claude-local', projectIds: ['checkout', 'billing'] },
    { op: 'agent.add', id: 'old', name: 'Old', role: 'worker', projectScope: 'restricted', departmentId: 'engineering-payments', runtime: 'claude-local', projectIds: ['checkout'] },
    { op: 'agent.archive', id: 'old' },
    { op: 'agent.add', id: 'mo', name: 'Mo', role: 'worker', projectScope: 'restricted', departmentId: 'design', runtime: 'claude-local', projectIds: ['billing'] },
  ]);
}

export interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function sink(append: (chunk: string) => void): NodeJS.WritableStream {
  return {
    write(chunk: string | Uint8Array) {
      append(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

export async function invoke(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: sink((c) => (stdout += c)), stderr: sink((c) => (stderr += c)) });
  return { stdout, stderr, code };
}

/** The single JSON document a `--json` command prints. */
export function jsonOf(captured: Captured): Record<string, unknown> {
  const lines = captured.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

/** A committed Git repository with the given files, in a temp directory. */
export async function gitRepo(files: Record<string, string>): Promise<string> {
  const dir = tempDir('workforce-ws-repo-');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const identity = { name: 'Workforce Test', email: 'test@workforce.invalid' };
  const base = { cwd: dir, identity } as const;
  await gitOrThrow(['init', '--quiet', '--initial-branch=main'], base);
  await gitOrThrow(['config', 'user.name', identity.name], base);
  await gitOrThrow(['config', 'user.email', identity.email], base);
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], base);
  await gitOrThrow(['add', '-A'], base);
  await gitOrThrow(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'initial'], base);
  return dir;
}
