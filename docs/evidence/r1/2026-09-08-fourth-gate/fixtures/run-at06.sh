#!/bin/bash
set -uo pipefail
G="$(cat /tmp/r1gate4.txt)"
REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LOG="$G/logs/at06-run.txt"
{
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$REPO/dist/cli/index.js" run \
    --repo "$G/fx-at06" --agents "$G/agents-maxrepair2.json" \
    --plan "$G/requests/at06-plan.json" --task-file "$G/requests/at06-request.txt" \
    --check "node scripts/check.mjs lint" --check "node scripts/check.mjs always-fail" \
    --state-dir "$G/state-at06" --workspace-root "$G/ws-at06"
  echo "EXIT=$?"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LOG" 2>&1
