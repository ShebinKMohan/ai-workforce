#!/usr/bin/env node
/**
 * R1-gate test harness standing in for the Claude Code CLI.
 *
 * It does two things the shipped replay fixture cannot: it reads the
 * --mcp-config the coordinator spliced into its argv, and it submits the SAME
 * coordination message TWICE with one idempotency key, using the product's own
 * bridge client. Then it hands over to the shipped replay fixture, unmodified,
 * to speak the rest of the Claude Code stream protocol.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const OUT = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/logs/at08-bridge-calls.jsonl';

if (argv.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\n'); process.exit(0); }

try {
  const i = argv.indexOf('--mcp-config');
  if (i >= 0) {
    const cfg = JSON.parse(argv[i + 1]);
    const server = Object.values(cfg.mcpServers)[0];
    const socket = server.env['WORKFORCE_BRIDGE_SOCKET'];
    const token = server.env['WORKFORCE_BRIDGE_TOKEN'];
    const { callCoordinator } = await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/dist/coordination/bridge.js');
    const params = { subject: 'status', body: 'the one logical message', idempotencyKey: 'at08-duplicate-key' };
    const first = await callCoordinator(socket, token, 'send_message', params);
    const second = await callCoordinator(socket, token, 'send_message', params);
    const forged = await callCoordinator(socket, 'not-a-real-token', 'send_message', { body: 'forged with a bogus token' });
    appendFileSync(OUT, JSON.stringify({ socket, first, second, forged }) + '\n');
  } else {
    appendFileSync(OUT, JSON.stringify({ error: 'no --mcp-config in argv', argv }) + '\n');
  }
} catch (error) {
  appendFileSync(OUT, JSON.stringify({ error: String(error && error.stack ? error.stack : error) }) + '\n');
}

process.env['WORKFORCE_FAKE_CLAUDE_SCENARIO'] = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/scen/claude-at08.json';
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/fake-claude.mjs');
