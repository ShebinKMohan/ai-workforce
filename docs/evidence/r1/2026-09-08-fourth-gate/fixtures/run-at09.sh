#!/bin/bash
set -uo pipefail
G="$(cat /tmp/r1gate4.txt)"; REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LOG="$G/logs/at09-run.txt"
{
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$REPO/dist/cli/index.js" run \
    --repo "$G/fx-at09" --agents "$G/agents.json" \
    --plan "$G/requests/at09-plan.json" --task-file "$G/requests/at09-request.txt" \
    --check "node scripts/check.mjs lint" \
    --state-dir "$G/state-at09" --workspace-root "$G/ws-at09"
  echo "EXIT=$?"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LOG" 2>&1
