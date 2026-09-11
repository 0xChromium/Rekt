#!/bin/sh
# Fills the record backwards to a series of depths, keeping the two streams level.
#
# Level matters more than deep. A wallet whose pool swaps are on record but whose curve buys are
# not reads as somebody who sold what they never bought: the report says "carried on from before our
# records" and the profit and loss is wrong rather than merely thin. So each depth is reached by
# both streams before either goes further, and every depth in the list is a usable state.
#
# Curve trades go first at each step because they are quicker per block and usually the shallower of
# the two. One at a time throughout: two folds and the watcher contend for one SQLite write lock.
#
#   BACKFILL_STEPS="7 10 14 21 37" sh deploy/backfill-all.sh
set -eu
cd "$(dirname "$0")/.."
STEPS="${BACKFILL_STEPS:-7 10 14 21 37}"
HOURS="${BACKFILL_HOURS:-12}"
TX_LANES="${TX_LANES:-16}"
export TX_LANES

# The live watcher comes first. It and this share one rate-limited endpoint, and a watcher that has
# fallen behind shows a red banner and a stale board, which matters more than any amount of history.
# So this waits until the watcher is within a few minutes of the head, and waits again between
# depths in case it slipped while the last one ran.
wait_for_watcher() {
  while true; do
    LAG=$(curl -s --max-time 10 "http://127.0.0.1:${PORT:-8787}/api/health" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Math.round(JSON.parse(s).lagSeconds))}catch{console.log(99999)}})' 2>/dev/null || echo 99999)
    case "$LAG" in ''|*[!0-9]*) LAG=99999 ;; esac
    [ "$LAG" -le "${WAIT_LAG_S:-90}" ] && return 0
    echo "waiting for the watcher: ${LAG}s behind the chain"
    sleep 60
  done
}

for DAYS in $STEPS; do
  wait_for_watcher
  echo "=== depth: $DAYS days ==="
  BACKFILL_DAYS="$DAYS" sh deploy/backfill-back.sh curve "$HOURS"
  BACKFILL_DAYS="$DAYS" sh deploy/backfill-back.sh pools "$HOURS"
  echo "=== both streams now reach $DAYS days ==="
done
echo "every depth reached; the record is as deep as it was asked to be"
