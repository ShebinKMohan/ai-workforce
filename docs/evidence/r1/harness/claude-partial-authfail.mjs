#!/usr/bin/env node
/** R1-gate harness: partial work, then the recorded claude auth failure. */
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\n'); process.exit(0); }
process.env['WORKFORCE_FAKE_CLAUDE_SCENARIO'] = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/scen/claude-partial-authfail.json';
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/fake-claude.mjs');
