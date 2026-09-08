#!/bin/zsh
# AT07 driver: start a real run, watch the candidate worktree, and SIGINT the
# coordinator the moment the deliverable is genuinely half-written.
set -u
R1="$1"
REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
LOG="$R1/logs/at07-run.txt"
TL="$R1/logs/at07-interrupt-timeline.txt"
: > "$TL"; : > "$LOG"
cd "$REPO"
node dist/cli/index.js run --repo "$R1/fx-at07" --agents "$R1/agents-r1gate.json" \
  --path direct --task-file "$R1/requests/at07-request.txt" \
  --check "node scripts/notes.mjs" \
  --state-dir "$R1/state-at07" --workspace-root "$R1/ws-at07" > "$LOG" 2>&1 &
PID=$!
echo "coordinator pid $PID started $(date -u +%FT%T.%3NZ)" >> "$TL"
WS=""
for i in $(seq 1 3000); do
  if [ -z "$WS" ]; then
    WS=$(grep -m1 -o "candidate workspace [^ ]*" "$LOG" 2>/dev/null | sed 's/candidate workspace //')
    [ -n "$WS" ] && echo "candidate workspace observed at $(date -u +%FT%T.%3NZ): $WS" >> "$TL"
  fi
  if [ -n "$WS" ] && [ -d "$WS/docs" ]; then
    N=$(ls "$WS/docs" 2>/dev/null | grep -c '^n0.\.md$')
    if [ "$N" -ge 1 ] && [ "$N" -le 7 ]; then
      echo "observed $N of 8 note file(s) in the candidate at $(date -u +%FT%T.%3NZ)" >> "$TL"
      ls -1 "$WS/docs" | tr '\n' ' ' >> "$TL"; echo >> "$TL"
      WORKERS=$(pgrep -P $PID 2>/dev/null | tr '\n' ' ')
      echo "coordinator child pids before SIGINT: $WORKERS" >> "$TL"
      echo "$WORKERS" > "$R1/logs/at07-worker-pids.txt"
      echo "$PID" > "$R1/logs/at07-coordinator-pid.txt"
      echo "sending SIGINT to $PID at $(date -u +%FT%T.%3NZ)" >> "$TL"
      kill -INT $PID
      break
    fi
  fi
  kill -0 $PID 2>/dev/null || { echo "coordinator exited before the interrupt at $(date -u +%FT%T.%3NZ)" >> "$TL"; break; }
  perl -e 'select undef,undef,undef,0.2'
done
wait $PID
RC=$?
echo "EXIT=$RC" >> "$TL"
echo "EXIT=$RC" >> "$LOG"
exit $RC
