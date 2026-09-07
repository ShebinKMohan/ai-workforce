import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from '../../../src/adapters/claude-code/adapter.js';
import type { RuntimeEvent, SessionHandle, TurnHandle } from '../../../src/adapters/types.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('../../../fixtures/claude-code/fake-claude.mjs', import.meta.url));

export function scenarioPath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/claude-code/${name}`, import.meta.url));
}

/** Realpath-resolved temp root: macOS maps /var to /private/var and the containment checks compare exact paths. */
export function tempWorkspace(prefix = 'wf-claude-'): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  return workspace;
}

/**
 * An adapter whose "claude" executable is the deterministic replay script.
 * `process.execPath` runs it, exactly as the Codex adapter's replay tests do.
 */
export function replayAdapter(options: ClaudeCodeAdapterOptions = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    executablePath: process.execPath,
    extraArgs: [FAKE_CLAUDE],
    startupTimeoutMs: 10_000,
    controlTimeoutMs: 10_000,
    interruptTimeoutMs: 5_000,
    stopTimeoutMs: 3_000,
    deliveryAckTimeoutMs: 3_000,
    ...options,
  });
}

export interface ScenarioEnvOptions {
  /** Values for the scenario's `{{placeholder}}` slots, beyond sessionId/cwd/pid. */
  readonly vars?: Readonly<Record<string, string>>;
  /** File the fake appends its argv to, one JSON object per spawn. */
  readonly argvOut?: string;
}

/**
 * The environment that points the replay script at one scenario. It is passed
 * through `SessionInput.env`, which is the same channel a real run would use,
 * so the replay tests exercise the production path rather than a test-only hook.
 */
export function scenarioEnv(scenario: string, options: ScenarioEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = { WORKFORCE_FAKE_CLAUDE_SCENARIO: scenario };
  if (options.vars !== undefined) env['WORKFORCE_FAKE_CLAUDE_VARS'] = JSON.stringify(options.vars);
  if (options.argvOut !== undefined) env['WORKFORCE_FAKE_CLAUDE_ARGV_OUT'] = options.argvOut;
  return env;
}

/** Collect a turn's events until the stream ends. */
export async function collect(adapter: ClaudeCodeAdapter, turn: TurnHandle): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.events(turn)) events.push(event);
  return events;
}

export function kinds(events: ReadonlyArray<RuntimeEvent>): string[] {
  return events.map((e) => e.kind);
}

export function firstOfKind(events: ReadonlyArray<RuntimeEvent>, kind: RuntimeEvent['kind']): RuntimeEvent | undefined {
  return events.find((e) => e.kind === kind);
}

export function allOfKind(events: ReadonlyArray<RuntimeEvent>, kind: RuntimeEvent['kind']): RuntimeEvent[] {
  return events.filter((e) => e.kind === kind);
}

export function readArgvLog(file: string): Array<{ argv: string[]; cwd: string; pid: number }> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; pid: number });
}

/** The value that follows `flag` in an argv, or null. */
export function argAfter(argv: ReadonlyArray<string>, flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

/** Every value that follows `flag` until the next `--option`. */
export function variadicAfter(argv: ReadonlyArray<string>, flag: string): string[] {
  const index = argv.indexOf(flag);
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values;
}

export type { SessionHandle, TurnHandle, RuntimeEvent };
