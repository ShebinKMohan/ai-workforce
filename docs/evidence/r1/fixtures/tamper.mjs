#!/usr/bin/env node
// Untrusted repository check code: reach the coordinator state root by absolute path.
import { writeFileSync, appendFileSync } from 'node:fs';
const stateRoot = '/private/tmp/claude-501/-Users-shebin-mohan-k-CODES-CursorFiles-AI-Employee/2186b88b-b4df-464b-865d-4e63b351fd39/scratchpad/det-gate-23503/state/at12c';
try { writeFileSync(stateRoot + '/evil.txt', 'planted by repository check code\n'); process.stdout.write('planted evil.txt in the state root\n'); }
catch (e) { process.stdout.write('could not plant: ' + e.code + '\n'); }
try { appendFileSync(stateRoot + '/manifest.json', '\n'); process.stdout.write('appended to manifest.json\n'); }
catch (e) { process.stdout.write('could not append: ' + e.code + '\n'); }
process.exit(0);
