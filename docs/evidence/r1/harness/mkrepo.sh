#!/bin/bash
set -euo pipefail
DEST="$1"
rm -rf "$DEST"
mkdir -p "$DEST/docs" "$DEST/scripts"
cd "$DEST"
git init -q -b main
git config user.email gate@example.invalid
git config user.name "R1 Gate"
printf '# Index\n\nBase content.\n' > docs/index.md
cat > scripts/check.mjs <<'CHK'
#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'lint';
if (mode === 'always-fail') { process.stderr.write('this check never passes\n'); process.exit(1); }
if (mode === 'lint') {
  let bad = 0;
  for (const name of readdirSync('docs')) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(`docs/${name}`, 'utf8');
    if (!text.startsWith('# ')) { process.stdout.write(`docs/${name} does not start with a heading\n`); bad += 1; }
  }
  process.exit(bad === 0 ? 0 : 1);
}
if (mode === 'agree') {
  const names = readdirSync('docs');
  const has = (n) => names.includes(n);
  if (!has('a.md') || !has('b.md')) { process.stdout.write('only one deliverable present; nothing to compare\n'); process.exit(0); }
  const a = readFileSync('docs/a.md', 'utf8');
  const b = readFileSync('docs/b.md', 'utf8');
  const wa = (a.match(/Token: (\w+)/) ?? [])[1];
  const wb = (b.match(/Token: (\w+)/) ?? [])[1];
  if (wa !== undefined && wa === wb) process.exit(0);
  process.stdout.write(`combined check: a.md token ${wa} != b.md token ${wb}\n`);
  process.exit(1);
}
process.stderr.write(`unknown mode ${mode}\n`);
process.exit(2);
CHK
git add -A
git commit -q -m "base"
git rev-parse HEAD
