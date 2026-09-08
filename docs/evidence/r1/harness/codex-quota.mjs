#!/usr/bin/env node
/**
 * R1-gate harness standing in for the codex CLI: replays the RECORDED
 * codex-cli 0.147.0 usage-limit transcript through the shipped replay fixture.
 */
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.147.0\n'); process.exit(0); }
if (argv[0] === 'login') { process.stdout.write('Logged in using ChatGPT\n'); process.exit(0); }
process.argv = [process.argv[0], process.argv[1], '--transcript', '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/codex/session-usage-limit.real.jsonl'];
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/codex/fake-app-server.mjs');
