#!/bin/bash
# mkfixture.sh <dest> — a throwaway git repo with the gate's check scripts.
set -euo pipefail
DEST="$1"; SRC="$2"
rm -rf "$DEST"; mkdir -p "$DEST/scripts" "$DEST/docs"
cp "$SRC/check.mjs" "$SRC/agree.mjs" "$SRC/notes.mjs" "$DEST/scripts/"
printf '# Index\nBase document.\n' > "$DEST/docs/index.md"
printf '{"name":"r1-gate-fixture","version":"0.0.0","private":true}\n' > "$DEST/package.json"
cd "$DEST"
git init -q -b main
git -c user.email=gate@example.invalid -c user.name="R1 Gate" add -A
git -c user.email=gate@example.invalid -c user.name="R1 Gate" commit -qm "base"
git rev-parse HEAD
