#!/bin/bash
# AT10 driver: SIGKILL the coordinator after dispatch and before any receipt.
# $1 = det root, $2 = case name (alive|gone)
set -uo pipefail
D="$1"; CASE="$2"
REPO="/Users/shebin_mohan_k/CODES/CursorFiles/AI Employee"
cd "$REPO"
LOG="$D/logs/at10-$CASE-run.txt"
bash "$D/mkrepo.sh" "$D/repos/at10-$CASE" > "$D/logs/at10-$CASE-base.txt" 2>&1
WORKFORCE_FAKE_SCENARIO="$D/scen/hang.json" node dist/cli/index.js run \
  --repo "$D/repos/at10-$CASE" --agents "$D/cfg/fake.json" --agent engineer-fake \
  --path direct --task-file "$D/req/at12.txt" --check "node scripts/check.mjs lint" \
  --allow-unconfined-writes \
  --state-dir "$D/state/at10-$CASE" --workspace-root "$D/ws/at10-$CASE" > "$LOG" 2>&1 &
COORD=$!
echo "coordinator pid $COORD" | tee "$D/logs/at10-$CASE-driver.txt"
# Wait until the worker is dispatched and hanging.
for i in $(seq 1 300); do
  if grep -q "command hang" "$LOG" 2>/dev/null; then break; fi
  if grep -q "turn started" "$LOG" 2>/dev/null && [ "$i" -gt 20 ]; then break; fi
  sleep 0.2
done
WORKERS=$(pgrep -P "$COORD" | tr '\n' ' ')
echo "coordinator children before SIGKILL: $WORKERS" >> "$D/logs/at10-$CASE-driver.txt"
echo "log tail before SIGKILL:" >> "$D/logs/at10-$CASE-driver.txt"
tail -5 "$LOG" >> "$D/logs/at10-$CASE-driver.txt"
if [ "$CASE" = "gone" ]; then
  for w in $WORKERS; do kill -9 -"$w" 2>/dev/null; kill -9 "$w" 2>/dev/null; done
  echo "killed worker group(s): $WORKERS" >> "$D/logs/at10-$CASE-driver.txt"
fi
kill -9 "$COORD" 2>/dev/null
echo "SIGKILLed coordinator $COORD at $(date -u +%FT%TZ)" >> "$D/logs/at10-$CASE-driver.txt"
wait "$COORD" 2>/dev/null
sleep 1
echo "surviving worker pids:" >> "$D/logs/at10-$CASE-driver.txt"
for w in $WORKERS; do ps -p "$w" -o pid,ppid,command >> "$D/logs/at10-$CASE-driver.txt" 2>/dev/null || true; done
cat "$D/logs/at10-$CASE-driver.txt"
