#!/usr/bin/env node
/**
 * R1-gate harness: one runtime record delivered as TWO stdout writes, so the
 * adapter sees a genuinely partial stream line, then the shipped fake runtime
 * takes over unchanged.
 */
if (!process.argv.includes('--version')) {
  process.stdout.write('{"event":"assistant_message","turnId":null,"text":"ONE record split across ');
  await new Promise((r) => setTimeout(r, 150));
  process.stdout.write('TWO stdout writes","claimsDone":false}\n');
}
process.argv.splice(2, 0, '--scenario', '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/scen/edit-ok.json');
await import('file:///Users/shebin_mohan_k/CODES/CursorFiles/AI Employee/fixtures/fake-runtime/fake-runtime.mjs');
