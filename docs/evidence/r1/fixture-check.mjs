#!/usr/bin/env node
// Deterministic acceptance checks for the R1 gate fixture.
//   lint        : every *.md under docs/ must begin with "# " (passes with no files)
//   always-fail : exits 1 unconditionally; used to drive the bounded repair loop
import { readdirSync, readFileSync, existsSync } from 'node:fs';
const mode = process.argv[2] ?? 'lint';
if (mode === 'always-fail') {
  console.error('always-fail: this check is designed to fail; nothing a worker writes can make it pass');
  process.exit(1);
}
if (mode === 'lint') {
  if (!existsSync('docs')) { console.log('lint: no docs/ directory'); process.exit(0); }
  const bad = [];
  for (const name of readdirSync('docs')) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(`docs/${name}`, 'utf8');
    if (!text.startsWith('# ')) bad.push(name);
  }
  if (bad.length > 0) { console.error(`lint: not a markdown title: ${bad.join(', ')}`); process.exit(1); }
  console.log(`lint: ok (${readdirSync('docs').filter(n=>n.endsWith('.md')).length} file(s))`);
  process.exit(0);
}
if (mode === 'strict') {
  if (!existsSync('docs')) { console.error('strict: docs/ does not exist'); process.exit(1); }
  const files = readdirSync('docs').filter((n) => n.endsWith('.md'));
  if (files.length === 0) { console.error('strict: docs/ contains no markdown file'); process.exit(1); }
  const bad = [];
  for (const name of files) {
    const text = readFileSync(`docs/${name}`, 'utf8');
    if (!text.startsWith('# ')) bad.push(`docs/${name}: first line is not a markdown title`);
    if (!text.split('\n').some((line) => line.trim() === 'Status: reviewed')) {
      bad.push(`docs/${name}: missing the required line "Status: reviewed"`);
    }
  }
  if (bad.length > 0) { console.error(`strict: ${bad.length} problem(s)`); for (const b of bad) console.error(`  - ${b}`); process.exit(1); }
  console.log(`strict: ok (${files.length} file(s))`);
  process.exit(0);
}
if (mode === 'sealed') {
  // The token lives outside the repository, so it is not present in the frozen
  // candidate copy the verifier runs. A worker cannot satisfy this check; it
  // exists to drive the bounded repair loop to its budget honestly.
  const want = 'SEAL-7f3a91';
  const file = 'docs/SEAL.txt';
  if (!existsSync(file)) { console.error(`sealed: ${file} does not exist`); process.exit(1); }
  const got = readFileSync(file, 'utf8').trim();
  if (got !== want) { console.error(`sealed: ${file} does not carry the expected release token`); process.exit(1); }
  console.log('sealed: ok');
  process.exit(0);
}
console.error(`unknown mode ${mode}`); process.exit(2);
