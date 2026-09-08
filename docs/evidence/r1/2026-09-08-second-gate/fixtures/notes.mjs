#!/usr/bin/env node
// Acceptance check for the R1 gate (AT07): the eight notes must all exist,
// each exactly three lines, with its own title and the reviewed marker.
// Satisfiable: a worker that finishes the deliverable makes it pass.
import { existsSync, readFileSync } from 'node:fs';
const problems = [];
for (let n = 1; n <= 8; n += 1) {
  const nn = String(n).padStart(2, '0');
  const file = `docs/n${nn}.md`;
  if (!existsSync(file)) { problems.push(`${file}: missing`); continue; }
  const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
  if (lines.length !== 3) problems.push(`${file}: ${lines.length} line(s), expected 3`);
  if (lines[0] !== `# Note ${nn}`) problems.push(`${file}: line 1 is ${JSON.stringify(lines[0])}, expected "# Note ${nn}"`);
  if (lines[1] !== 'Status: reviewed') problems.push(`${file}: line 2 is ${JSON.stringify(lines[1])}, expected "Status: reviewed"`);
  if ((lines[2] ?? '').trim() === '') problems.push(`${file}: line 3 is empty`);
}
if (problems.length > 0) { console.error(`notes: ${problems.length} problem(s)`); for (const p of problems) console.error(`  - ${p}`); process.exit(1); }
console.log('notes: ok (8 files)');
process.exit(0);
