#!/bin/sh
# Walks the record backwards in slices, newest first, until it reaches the Pons v2 start.
#
# Newest first on purpose: the value of history decays with age, and each slice that lands makes the
# site answer for one more stretch of the chain immediately. The CLIs refuse a window that is not
# contiguous with what is already folded, so every slice ends exactly where the record now begins.
#
#   sh deploy/backfill-back.sh pools 12    # 12-hour slices of pool swaps
#   TX_LANES=8 sh deploy/backfill-back.sh pools 12
#   sh deploy/backfill-back.sh curve 12    # the same for curve trades (launches, then the fold)
#
# It shares the chain with the live watcher, which must keep up, so it reads at the same spacing and
# never runs two of itself. Every chunk is checkpointed: killing it loses at most one chunk.
set -eu
cd "$(dirname "$0")/.."
WHAT="${1:-pools}"
HOURS="${2:-12}"
V2_START=27176459                 # 2026-08-04, the first block of Pons v2
# How far back this run is asked to reach. Default the v2 start; BACKFILL_DAYS caps it, for when a
# launch is closer than the whole history is deep and the recent fortnight is what has to be there.
if [ -n "${BACKFILL_DAYS:-}" ]; then
  HEAD_BLOCK=$(node --no-warnings -e '
import("./src/db.ts").then((m) => { const db = m.openDb(); console.log(m.getMeta(db, "live_head_block") ?? m.getMeta(db, "fold_to_block") ?? 0); db.close(); });
')
  FLOOR=$((HEAD_BLOCK - BACKFILL_DAYS * 856582))
  [ "$FLOOR" -gt "$V2_START" ] && V2_START=$FLOOR
fi
BLOCKS_PER_HOUR=35691             # 856,582 a day at about 100 ms a block

case "$WHAT" in
  pools) FROM_KEY=pool_from_block ;;
  curve) FROM_KEY=fold_from_block ;;
  *) echo "usage: $0 pools|curve [hours]" >&2; exit 2 ;;
esac

meta() {
  node --no-warnings -e '
import("./src/db.ts").then((m) => { const db = m.openDb(); console.log(m.getMeta(db, process.argv[1]) ?? ""); db.close(); });
' "$1"
}

while true; do
  START="$(meta "$FROM_KEY")"
  [ -n "$START" ] || { echo "no cursor for $FROM_KEY yet; run the forward pass first" >&2; exit 1; }
  if [ "$START" -le "$V2_START" ]; then echo "$WHAT: the record reaches $V2_START already"; exit 0; fi

  TO=$((START - 1))
  FROM=$((TO - HOURS * BLOCKS_PER_HOUR + 1))
  [ "$FROM" -lt "$V2_START" ] && FROM=$V2_START

  echo "=== $WHAT slice $FROM..$TO ($(( (TO - FROM) / BLOCKS_PER_HOUR )) h) ==="
  if [ "$WHAT" = "curve" ]; then
    # --no-enrich on purpose: enrichment reads one transaction per launch at about ten a second,
    # which is a day of its own for a month of launches, and the fold needs none of it. The symbols
    # come afterwards from the token contracts through Multicall3 (npm run names), which is an order
    # of magnitude quicker, and until they do a launch prints as its truncated address.
    node --no-warnings src/cli/backfill.ts --from "$FROM" --to "$TO" --no-enrich
    node --no-warnings src/cli/fold.ts --from "$FROM" --to "$TO" --once
  else
    node --no-warnings src/cli/pools.ts --from "$FROM" --to "$TO" --once
  fi
done
