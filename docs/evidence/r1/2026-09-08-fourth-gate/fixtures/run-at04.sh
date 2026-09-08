#!/bin/bash
set -uo pipefail
G="$(cat /tmp/r1gate4.txt)"; REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LOG="$G/logs/at04-run.txt"
{
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$REPO/dist/cli/index.js" run \
    --repo "$G/fx-at04" --agents "$G/agents.json" --agent engineer-claude --path direct \
    --task-file "$G/requests/at04-request.txt" --check "node scripts/check.mjs lint" \
    --allow-unconfined-writes --state-dir "$G/state-at04" --workspace-root "$G/ws-at04"
  echo "EXIT=$?"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LOG" 2>&1
