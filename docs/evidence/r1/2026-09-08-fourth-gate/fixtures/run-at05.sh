#!/bin/bash
# run-at05.sh <label> <plan> <request> <agents> [extra args...]
set -uo pipefail
G="$(cat /tmp/r1gate4.txt)"
REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LABEL="$1"; PLAN="$2"; REQ="$3"; AGENTS="$4"; shift 4
LOG="$G/logs/$LABEL-run.txt"
{
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$REPO/dist/cli/index.js" run \
    --repo "$G/fx-$LABEL" --agents "$G/$AGENTS" \
    --plan "$G/requests/$PLAN" --task-file "$G/requests/$REQ" \
    --state-dir "$G/state-$LABEL" --workspace-root "$G/ws-$LABEL" "$@"
  echo "EXIT=$?"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LOG" 2>&1
