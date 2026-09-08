#!/usr/bin/env node
/**
 * R1-gate harness standing in for the Claude Code CLI (AT11).
 * It leaves behind a detached child that calls the coordinator back AFTER this
 * attempt has finished, using this attempt's own token.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\n'); process.exit(0); }
const OUT = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/logs/at11-stale-calls.jsonl';
try {
  const i = argv.indexOf('--mcp-config');
  if (i >= 0) {
    const server = Object.values(JSON.parse(argv[i + 1]).mcpServers)[0];
    const child = spawn(process.execPath, ['/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/runtimes/stale-caller.mjs', server.env['WORKFORCE_BRIDGE_SOCKET'], server.env['WORKFORCE_BRIDGE_TOKEN'], OUT, '12000'], { detached: true, stdio: 'ignore' });
    child.unref();
    appendFileSync(OUT, JSON.stringify({ spawnedStaleCaller: child.pid, socket: server.env['WORKFORCE_BRIDGE_SOCKET'] }) + '\n');
  } else {
    appendFileSync(OUT, JSON.stringify({ error: 'no --mcp-config', argv }) + '\n');
  }
} catch (error) { appendFileSync(OUT, JSON.stringify({ error: String(error) }) + '\n'); }
process.env['WORKFORCE_FAKE_CLAUDE_SCENARIO'] = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/scen/claude-at08.json';
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/fake-claude.mjs');
