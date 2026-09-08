#!/usr/bin/env node
// Cross-deliverable acceptance check for the R1 gate (AT05).
// It can only be satisfied when the two deliverables agree on a word that
// neither the request nor this repository names. A candidate that holds only
// one of the two files cannot be judged, so it passes: the check bites on the
// COMBINED candidate, which is where agreement is a real requirement.
import { existsSync, readFileSync } from 'node:fs';
const g = 'docs/glossary.md', u = 'docs/usage.md';
if (!existsSync(g) || !existsSync(u)) { console.log('agree: only one side present; nothing to compare'); process.exit(0); }
const term = (file, prefix) => {
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(prefix));
  if (line === undefined) { console.error(`agree: ${file} has no line beginning "${prefix}"`); process.exit(1); }
  return line.slice(prefix.length).trim();
};
const a = term(g, 'Term:'), b = term(u, 'Uses term:');
if (a === '' || b === '') { console.error('agree: a term is empty'); process.exit(1); }
if (a !== b) { console.error(`agree: docs/usage.md says "${b}" but docs/glossary.md says "${a}"`); process.exit(1); }
console.log(`agree: ok (both deliverables say "${a}")`);
process.exit(0);
