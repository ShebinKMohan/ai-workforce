#!/usr/bin/env node
// Thin wrapper: pins one deterministic scenario onto the shipped fake runtime.
// The shipped script is imported unchanged; only argv is prepared for it.
process.argv.splice(2, 0, '--scenario', '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/scen/slow.json');
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/fake-runtime/fake-runtime.mjs');
