#!/bin/bash
set -uo pipefail
G="$(cat /tmp/r1gate4.txt)"
REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LOG="$G/logs/at02-run.txt"
{
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "-- materialize ts-bug --"
  npx tsx "$G/materialize.mts" ts-bug "$G/fx-at02"
  echo "-- the bug reproduces at base --"
  ( cd "$G/fx-at02" && node --test test/ 2>&1 | tail -12; echo "BASE_TEST_EXIT=${PIPESTATUS[0]}" )
  echo "-- run --"
  node "$REPO/dist/cli/index.js" run \
    --repo "$G/fx-at02" --agents "$G/agents-at02.json" \
    --task "$(sed -n '/^> The paginated/,/reproduces it\./p' "$REPO/fixtures/ts-bug/README.md" | sed 's/^> //')" \
    --state-dir "$G/state-at02" --workspace-root "$G/ws-at02"
  echo "EXIT=$?"
  echo "-- the original checkout is unchanged --"
  ( cd "$G/fx-at02" && git status --short && git rev-parse HEAD && git diff --stat )
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LOG" 2>&1
