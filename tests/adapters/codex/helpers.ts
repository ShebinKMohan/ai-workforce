import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter, type CodexAdapterOptions } from '../../../src/adapters/codex/adapter.js';
import type { RuntimeEvent, SessionHandle, TurnHandle } from '../../../src/adapters/types.js';

export const FAKE_APP_SERVER = fileURLToPath(new URL('../../../fixtures/codex/fake-app-server.mjs', import.meta.url));

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/codex/${name}`, import.meta.url));
}

/** Realpath-resolved temp root: macOS maps /var to /private/var and the containment checks compare exact paths. */
export function tempWorkspace(prefix = 'wf-codex-'): string {
  // realpath: macOS maps /var to /private/var and the adapter canonicalises the granted roots.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  return workspace;
}

export function writeTranscript(dir: string, name: string, records: ReadonlyArray<unknown>): string {
  const file = path.join(dir, name);
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

/** An adapter whose "codex" executable is the deterministic replay script. */
export function replayAdapter(transcript: string, options: CodexAdapterOptions = {}, extraArgs: ReadonlyArray<string> = []): CodexAdapter {
  return new CodexAdapter({
    executablePath: process.execPath,
    appServerArgs: [FAKE_APP_SERVER, '--transcript', transcript, ...extraArgs],
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    interruptTimeoutMs: 5_000,
    stopTimeoutMs: 3_000,
    ...options,
  });
}

export async function collect(adapter: CodexAdapter, turn: TurnHandle): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.events(turn)) events.push(event);
  return events;
}

export async function openReplaySession(adapter: CodexAdapter, workspace: string, overrides: Partial<Parameters<CodexAdapter['openSession']>[0]> = {}): Promise<SessionHandle> {
  return adapter.openSession({
    cwd: workspace,
    allowedWritePaths: [workspace],
    policy: 'local-development',
    systemInstructions: 'test worker',
    ...overrides,
  });
}

export function payload(event: RuntimeEvent, key: string): unknown {
  return event.payload[key];
}
