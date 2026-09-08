#!/usr/bin/env node
/** R1-gate harness: replays the RECORDED claude 2.1.260 auth-failure session. */
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\n'); process.exit(0); }
process.env['WORKFORCE_FAKE_CLAUDE_SCENARIO'] = '/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/session-auth-failure.real.json';
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/claude-code/fake-claude.mjs');
