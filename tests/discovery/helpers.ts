import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProbeCommand, ProbeResult, ProbeSpawner } from '../../src/discovery/spawn.js';

export function tempDir(prefix = 'workforce-discovery-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a real executable shell script; discovery must find and run it exactly like an installed CLI. */
export function writeExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

export interface FakeCodexOptions {
  readonly version?: string;
  /**
   * `panic-out` is the dangerous shape: a crash on stderr whose wording happens
   * to contain one of the signed-out phrases. It is a failure, not an answer.
   */
  readonly login?: 'in' | 'out' | 'garbage' | 'panic-out';
  readonly loginExit?: number;
  /** Append every invocation's argv to this file, so a test can prove what was run. */
  readonly argvLog?: string;
}

/** Mimics `codex --version` and `codex login status`; anything else exits 64 like an unknown subcommand. */
export function fakeCodex(options: FakeCodexOptions = {}): string {
  const version = options.version ?? '0.147.0';
  const login = options.login ?? 'in';
  const loginExit = options.loginExit ?? 0;
  const loginLine = login === 'in' ? 'Logged in using ChatGPT' : login === 'out' ? 'Not logged in' : 'Something else entirely';
  const loginBody = login === 'panic-out' ? `echo "thread 'main' panicked: no credentials directory: /home/x/.codex" >&2` : `echo "${loginLine}"`;
  return `#!/bin/sh
${options.argvLog === undefined ? '' : `echo "$*" >> "${options.argvLog}"`}
if [ "$1" = "--version" ]; then
  echo "codex-cli ${version}"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  ${loginBody}
  exit ${loginExit}
fi
echo "fake codex refused unexpected argv: $*" >&2
exit 64
`;
}

export interface FakeClaudeOptions {
  readonly version?: string;
  /**
   * `crash-out` and `crash-eacces` are two identical crashes of the same
   * command, differing only in wording: one happens to contain "not logged in",
   * the other does not. Neither is an answer about a login.
   */
  readonly auth?: 'json-in' | 'json-out' | 'text-in' | 'text-out' | 'garbage' | 'crash-out' | 'crash-eacces';
  readonly authExit?: number;
  /** Personal data the real CLI prints; a report must never carry it. */
  readonly email?: string;
  /** Append every invocation's argv to this file, so a test can prove what was run. */
  readonly argvLog?: string;
}

/** Mimics `claude --version` and `claude auth status` in both the JSON and `--text` shapes. */
export function fakeClaude(options: FakeClaudeOptions = {}): string {
  const version = options.version ?? '2.1.260';
  const auth = options.auth ?? 'json-in';
  const authExit = options.authExit ?? 0;
  const email = options.email ?? 'someone@example.com';
  const body =
    auth === 'json-in'
      ? `echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "${email}", "orgName": "Example Org"}'`
      : auth === 'json-out'
        ? // The exact shape claude 2.1.260 prints on stdout when signed out.
          `echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'`
        : auth === 'text-in'
          ? `echo "Logged in as ${email}"`
          : auth === 'text-out'
            ? 'echo "Not logged in"'
            : auth === 'crash-out'
              ? 'echo "fatal: proxy rejected request: you are not logged in to corp-proxy" >&2'
              : auth === 'crash-eacces'
                ? `echo "Error: EACCES: permission denied, open '/Users/x/.claude.json'" >&2`
                : 'echo "no idea"';
  return `#!/bin/sh
${options.argvLog === undefined ? '' : `echo "$*" >> "${options.argvLog}"`}
if [ "$1" = "--version" ]; then
  echo "${version} (Claude Code)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  ${body}
  exit ${authExit}
fi
echo "fake claude refused unexpected argv: $*" >&2
exit 64
`;
}

/** A script that starts a background child, records its pid, and then hangs until killed. */
export function hangingScript(pidFile: string): string {
  return `#!/bin/sh
sleep 30 &
echo $! > "${pidFile}"
wait
`;
}

/** Prints the environment and working directory a probe was given. */
export function environmentScript(): string {
  return `#!/bin/sh
echo "CWD=$PWD"
env | sort
exit 0
`;
}

export interface RecordedSpawn {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RecordingSpawner {
  readonly spawner: ProbeSpawner;
  readonly calls: RecordedSpawn[];
}

/** An injectable spawner that records every command and answers from a canned table. */
export function recordingSpawner(reply: (command: ProbeCommand) => Partial<ProbeResult>): RecordingSpawner {
  const calls: RecordedSpawn[] = [];
  const spawner: ProbeSpawner = async (command) => {
    calls.push({ executable: command.executable, args: [...command.args], cwd: command.cwd, env: command.env });
    const base: ProbeResult = { command, stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, spawnError: null, pid: 4242, durationMs: 1 };
    return { ...base, ...reply(command) };
  };
  return { spawner, calls };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}
