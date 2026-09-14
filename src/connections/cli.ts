import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

export type ClientId = 'codex' | 'claude';
export interface DesiredConnection { command: string; args: string[] }
export interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Sanitized failure category only; never a raw child-process error. */
  spawnError: string | null;
}
export interface ConnectionEntry {
  kind: 'missing' | 'stdio' | 'other' | 'unreadable';
  command?: string;
  args?: string[];
  scope?: 'user' | 'local' | 'project';
  enabled?: boolean;
  hasEnvironment?: boolean;
  error?: string;
}

export const CONNECTION_NAME = 'ai-workforce';
export const CONNECTION_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 250;
const STOP_DEADLINE_MS = 2_000;

export function getConnectionArgs(client: ClientId): string[] {
  return client === 'codex' ? ['mcp', 'get', CONNECTION_NAME, '--json'] : ['mcp', 'get', CONNECTION_NAME];
}

export function addConnectionArgs(client: ClientId, desired: DesiredConnection): string[] {
  return client === 'codex'
    ? ['mcp', 'add', CONNECTION_NAME, '--', desired.command, ...desired.args]
    : ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', CONNECTION_NAME, '--', desired.command, ...desired.args];
}

/** Call only after establishing ownership; Claude removal never guesses a scope. */
export function removeConnectionArgs(client: ClientId): string[] {
  return client === 'codex' ? ['mcp', 'remove', CONNECTION_NAME] : ['mcp', 'remove', '--scope', 'user', CONNECTION_NAME];
}

function unreadable(error = 'The coding agent connection could not be inspected.'): ConnectionEntry {
  return { kind: 'unreadable', error };
}

const safeText = z.string().max(16_384).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const codexEntrySchema = z.object({
  name: z.literal(CONNECTION_NAME),
  enabled: z.boolean(),
  transport: z.object({
    type: z.string(),
    command: safeText.optional(),
    args: z.array(safeText).max(128).optional(),
    env: z.record(z.string(), z.unknown()).nullable().optional(),
    env_vars: z.array(z.string()).nullable().optional(),
    cwd: z.unknown().optional(),
  }),
  enabled_tools: z.unknown().optional(),
  disabled_tools: z.unknown().optional(),
  startup_timeout_sec: z.unknown().optional(),
  tool_timeout_sec: z.unknown().optional(),
});

function parseCodex(stdout: string): ConnectionEntry {
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); } catch { return unreadable(); }
  const parsed = codexEntrySchema.safeParse(decoded);
  if (!parsed.success) return unreadable();
  const entry = parsed.data;
  const transport = entry.transport;
  const hasEnvironment = Object.keys(transport.env ?? {}).length > 0 || (transport.env_vars?.length ?? 0) > 0;
  const common = { scope: 'user' as const, enabled: entry.enabled, hasEnvironment };
  // These settings cannot be round-tripped by our bounded add command. Do not
  // claim ownership and later discard them during a reconnect.
  if (transport.type !== 'stdio' || transport.cwd != null || entry.enabled_tools != null
      || entry.disabled_tools != null || entry.startup_timeout_sec != null || entry.tool_timeout_sec != null) {
    return { kind: 'other', ...common };
  }
  if (!transport.command || !transport.args) return unreadable();
  return { kind: 'stdio', command: transport.command, args: transport.args, ...common };
}

/**
 * Claude 2.1.236 prints args.join(' '), without quoting. General argv cannot be
 * recovered from this display. Recognize only the Workforce bridge grammar,
 * preserving its first absolute script path (including spaces); custom command
 * shapes stay unowned. No shell parser or execution is involved.
 */
function parseClaudeBridgeArgs(value: string): string[] | undefined {
  const match = /^(\/[^\r\n]+\.(?:js|mjs|cjs|ts)) mcp(?: --server-url (http:\/\/127\.0\.0\.1:\d{1,5}\/?))?$/u.exec(value);
  if (!match?.[1]) return undefined;
  if (match[2]) {
    try {
      const url = new URL(match[2]);
      if (!url.port || Number(url.port) < 1 || Number(url.port) > 65_535) return undefined;
    } catch { return undefined; }
  }
  return match[2] ? [match[1], 'mcp', '--server-url', match[2]] : [match[1], 'mcp'];
}

function parseClaude(stdout: string): ConnectionEntry {
  // Strict headings prevent another server or a diagnostic from masquerading
  // as the requested entry. Secrets in Environment/Headers are never returned.
  const lines = stdout.replace(/\r\n/gu, '\n').trimEnd().split('\n');
  if (lines.shift() !== `${CONNECTION_NAME}:`) return unreadable();
  const values = new Map<string, string>();
  let environment = false;
  let hasEnvironment = false;
  let footer = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line === `To remove this server, run: claude mcp remove ${CONNECTION_NAME} -s user`
        || line === `To remove this server, run: claude mcp remove ${CONNECTION_NAME} -s local`
        || line === `To remove this server, run: claude mcp remove ${CONNECTION_NAME} -s project`) {
      footer = true;
      environment = false;
      continue;
    }
    if (footer) return unreadable();
    if (environment && /^ {4}\S/u.test(line)) { hasEnvironment = true; continue; }
    const field = /^ {2}([A-Za-z ]+):(?: (.*))?$/u.exec(line);
    if (!field?.[1]) return unreadable();
    const key = field[1];
    if (values.has(key)) return unreadable();
    values.set(key, field[2] ?? '');
    environment = key === 'Environment' || key === 'Env';
    if (environment && field[2]?.trim()) hasEnvironment = true;
  }
  const scopeValue = values.get('Scope');
  const scope: ConnectionEntry['scope'] = scopeValue?.startsWith('User config (') ? 'user'
    : scopeValue?.startsWith('Local config (') ? 'local'
    : scopeValue?.startsWith('Project config (') ? 'project' : undefined;
  if (!scope || !values.has('Type')) return unreadable();
  const common = { scope, hasEnvironment };
  if (values.get('Type') !== 'stdio') return { kind: 'other', ...common };
  const knownFields = new Set(['Scope', 'Status', 'Type', 'Command', 'Args', 'Environment', 'Env']);
  if ([...values.keys()].some((key) => !knownFields.has(key))) return { kind: 'other', ...common };
  const command = safeText.safeParse(values.get('Command'));
  const argsValue = safeText.safeParse(values.get('Args'));
  if (!command.success || !command.data || !argsValue.success) return unreadable();
  const args = parseClaudeBridgeArgs(argsValue.data);
  if (!args) return { kind: 'other', ...common };
  return { kind: 'stdio', command: command.data, args, ...common };
}

/** Returns only this server's bounded connection metadata, never raw CLI output. */
export function parseConnectionEntry(client: ClientId, outcome: CommandOutcome): ConnectionEntry {
  if (outcome.timedOut) return unreadable('The coding agent connection inspection timed out.');
  if (outcome.spawnError || outcome.signal) return unreadable();
  if (Buffer.byteLength(outcome.stdout) > CONNECTION_MAX_OUTPUT_BYTES || Buffer.byteLength(outcome.stderr) > CONNECTION_MAX_OUTPUT_BYTES) {
    return unreadable();
  }
  if (outcome.exitCode !== 0) {
    const diagnostic = outcome.stderr.trim();
    const missing = client === 'codex'
      ? /^Error: No MCP server named 'ai-workforce' found\.$/u.test(diagnostic)
      : /^No MCP server named "ai-workforce"\. (?:Run `claude mcp add` to add one\.|Configured servers: [A-Za-z0-9_.:/-]+(?:, [A-Za-z0-9_.:/-]+)*)$/u.test(diagnostic);
    return missing && !outcome.stdout.trim() && outcome.exitCode === 1 ? { kind: 'missing' } : unreadable();
  }
  return client === 'codex' ? parseCodex(outcome.stdout) : parseClaude(outcome.stdout);
}

export interface ConnectionCommand {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

/**
 * Runs an argument array in an owned process group. Output/input and lifetime
 * are bounded. Completion requires observed child exit and group settlement;
 * an unconfirmed stop returns a sanitized failure instead of fabricated success.
 */
export function runConnectionCommand(command: ConnectionCommand): Promise<CommandOutcome> {
  const timeoutMs = command.timeoutMs ?? 10_000;
  const empty: CommandOutcome = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, spawnError: null };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || Buffer.byteLength(command.stdin ?? '') > MAX_INPUT_BYTES) {
    return Promise.resolve({ ...empty, spawnError: 'Connection command limits are invalid.' });
  }
  return new Promise((resolve) => {
    const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let outcome = { ...empty };
    let settled = false;
    let closed = false;
    let stoppingAt: number | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let child: ChildProcessWithoutNullStreams;

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      clearTimeout(poll);
      resolve({ ...outcome, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    }
    try {
      child = spawn(command.executable, [...command.args], {
        shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...command.env }, ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      });
    } catch {
      outcome.spawnError = 'The connection command could not be started.';
      finish();
      return;
    }
    const pid = child.pid;
    function groupAlive(): boolean {
      if (pid === undefined) return false;
      try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    function killGroup(signal: NodeJS.Signals): void {
      if (pid === undefined) return;
      try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          outcome.spawnError = 'The connection command process group could not be stopped.';
        }
      }
    }
    function inspectStop(): void {
      if (settled) return;
      if (closed && !groupAlive()) { finish(); return; }
      if (stoppingAt !== undefined && Date.now() - stoppingAt >= STOP_DEADLINE_MS) {
        outcome.spawnError = 'The connection command process exit could not be confirmed.';
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish();
        return;
      }
      poll = setTimeout(inspectStop, 25);
    }
    function stop(): void {
      if (settled || stoppingAt !== undefined) return;
      stoppingAt = Date.now();
      clearTimeout(deadline);
      killGroup('SIGTERM');
      grace = setTimeout(() => { if (!settled && groupAlive()) killGroup('SIGKILL'); }, KILL_GRACE_MS);
      inspectStop();
    }
    function collect(channel: 'stdout' | 'stderr', chunk: Buffer): void {
      const remaining = CONNECTION_MAX_OUTPUT_BYTES - sizes[channel];
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        output[channel].push(kept);
        sizes[channel] += kept.length;
      }
      if (chunk.length > remaining) {
        outcome.spawnError = 'The connection command exceeded its output limit.';
        stop();
      }
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => { outcome.spawnError = 'The connection command could not be started.'; });
    child.on('exit', (exitCode, signal) => { outcome.exitCode = exitCode; outcome.signal = signal; });
    child.on('close', (exitCode, signal) => {
      closed = true;
      outcome.exitCode = exitCode; outcome.signal = signal;
      if (!groupAlive()) finish();
      else stop();
    });
    child.stdin.on('error', () => {
      // A short-lived CLI may close stdin before end(). Exit status is still
      // authoritative; protocol callers separately validate their responses.
    });
    deadline = setTimeout(() => { outcome.timedOut = true; stop(); }, timeoutMs);
    child.stdin.end(command.stdin ?? '');
  });
}
