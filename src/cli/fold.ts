import { BLOCKS_PER_SECOND } from "../chain/config.ts";
import { sleep } from "../chain/chain.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { chainHead, curveMap, FOLD_CHUNK, foldCursor, foldRange, type Applied, type DecodedTrade, type FoldStats } from "../fold.ts";
import { detectLoss } from "../losses.ts";
import { usdOf } from "../prices.ts";
import { backfillQuoteAssets, quoteMap } from "../quote.ts";
import { applyTradeState } from "../state.ts";

/**
 * rekt fold [--hours N | --from N] [--to N] [--chunk N] [--once]
 *
 * Every curve trade on the chain, folded into trader_positions. Read by topic chain-wide in chunks
 * of at most 2,000 blocks, checkpointed in meta.fold_to_block after each chunk. With no flags it
 * resumes from the cursor; --hours and --from say where to start instead. --once folds the window
 * and exits; without it the fold keeps following the head from its cursor, which is what the
 * watcher does once it exists.
 *
 * Positions cannot be unfolded, so blocks already inside [fold_from_block, fold_to_block] are never
 * folded twice: a window that overlaps the folded range is trimmed to the parts outside it, and a
 * window apart from it is refused (the blocks between would never be folded). Losses
 * (losses.detectLoss) and token state (state.applyTradeState) are applied per trade, the same hook
 * the watcher uses, so a backfilled window fills the Hall of Rekt and the board's statuses too.
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const ONCE = argv.includes("--once");
const CHUNK = Math.min(FOLD_CHUNK, arg("chunk", FOLD_CHUNK));
const HOURS = arg("hours", 0);

const db = openDb();
await backfillQuoteAssets(db);
const quotes = quoteMap(db);

const head = await chainHead();
const to = arg("to", 0) || head;
const stored = foldCursor(db);
const from = arg("from", 0)
  || (HOURS ? head - Math.round(HOURS * 3600 * BLOCKS_PER_SECOND) : 0)
  || (stored ? stored + 1 : head - 20_000);

if (from > to) {
  console.log(`nothing to fold: cursor ${stored} is at the head ${head}`);
  db.close();
  process.exit(0);
}

// The parts of the window not folded yet: before the folded range, and after it.
//
// A backward extension (a window starting below fold_from_block) is folded upward from `from`
// with its own checkpoint, fold_back_to, and fold_from_block only moves down once the extension
// reaches the old start: an interrupted run leaves [fold_back_from .. fold_back_to] folded and
// the next run finishes the rest first, instead of a gap that reads as "folded already".
const prevFrom = Number(getMeta(db, "fold_from_block") ?? NaN);
const prevTo = Number(getMeta(db, "fold_to_block") ?? NaN);
const folded = Number.isFinite(prevFrom) && Number.isFinite(prevTo) && prevFrom <= prevTo;
const backFrom = Number(getMeta(db, "fold_back_from") ?? NaN);
const backTo = Number(getMeta(db, "fold_back_to") ?? NaN);
const interrupted = folded && Number.isFinite(backFrom) && Number.isFinite(backTo) && backFrom < prevFrom && backTo >= backFrom && backTo < prevFrom - 1;
const foldedFrom = interrupted ? backFrom : prevFrom;

type Segment = { from: number; to: number; kind: "forward" | "backward"; start: number };
const segments: Segment[] = [];
if (interrupted) {
  console.log(`  finishing an interrupted extension first: blocks ${(backTo + 1).toLocaleString()}..${(prevFrom - 1).toLocaleString()}`);
  segments.push({ from: backTo + 1, to: prevFrom - 1, kind: "backward", start: backFrom });
}
if (folded && from <= prevTo + 1 && to >= foldedFrom - 1) {
  // Overlapping or adjacent: only the parts outside the folded range are read.
  if (from < foldedFrom) segments.push({ from, to: foldedFrom - 1, kind: "backward", start: from });
  if (to > prevTo) segments.push({ from: prevTo + 1, to, kind: "forward", start: prevTo + 1 });
  if (Math.max(from, foldedFrom) <= Math.min(to, prevTo)) console.log(`  blocks ${Math.max(from, foldedFrom).toLocaleString()}..${Math.min(to, prevTo).toLocaleString()} are folded already and are skipped`);
} else if (folded) {
  // A window apart from the folded range would leave blocks between them unfolded for good.
  const hint = to < foldedFrom
    ? `--to ${(foldedFrom - 1).toLocaleString()} so the window reaches the folded range`
    : `--from ${(prevTo + 1).toLocaleString()}, or no flags to resume from the cursor`;
  console.log(`refusing: blocks ${(to < foldedFrom ? to + 1 : prevTo + 1).toLocaleString()}..${(to < foldedFrom ? foldedFrom - 1 : from - 1).toLocaleString()} would never be folded; use ${hint}`);
  db.close();
  process.exit(2);
} else {
  segments.push({ from, to, kind: "forward", start: from });
}

console.log("fold  curve trades into positions");
console.log(`  ${from.toLocaleString()} .. ${to.toLocaleString()}  (${(to - from).toLocaleString()} blocks, chunks of ${CHUNK})`);
console.log(`  ${curveMap(db).size.toLocaleString()} curves known\n`);

if (!folded) setMeta(db, "fold_from_block", String(from));

const started = Date.now();
const counts = { losses: 0, statuses: 0 };
/** Synchronous on purpose: it runs inside foldRange's chunk transaction. */
const onTrade = (t: DecodedTrade, r: Applied): void => {
  if (detectLoss(db, r.before, r.after, t, usdOf(quotes.get(t.pair)?.symbol))) counts.losses++;
  if (applyTradeState(db, t)) counts.statuses++;
};
const report = (upTo: number, s: { folded: number; unknown: number }): void =>
  console.log(`  ${upTo.toLocaleString()}  ${s.folded.toLocaleString()} trades folded, ${s.unknown.toLocaleString()} on curves not in the database, ${counts.losses} losses`);

let stats: FoldStats = { logs: 0, folded: 0, unknown: 0, chunks: 0, toBlock: stored ?? from - 1 };
for (const seg of segments) {
  const backward = seg.kind === "backward";
  if (backward) setMeta(db, "fold_back_from", String(seg.start));
  const s = await foldRange(db, seg.from, seg.to, {
    chunk: CHUNK,
    quotes,
    onTrade,
    cursorKey: backward ? "fold_back_to" : undefined,
    onChunk: (upTo, st) => { if (st.chunks % 10 === 0) report(upTo, st); },
  });
  if (backward) {
    // The extension reached the old start: the folded range now begins at its start.
    setMeta(db, "fold_from_block", String(seg.start));
    db.prepare("DELETE FROM meta WHERE key IN ('fold_back_from', 'fold_back_to')").run();
  }
  stats = { logs: stats.logs + s.logs, folded: stats.folded + s.folded, unknown: stats.unknown + s.unknown, chunks: stats.chunks + s.chunks, toBlock: backward ? stats.toBlock : s.toBlock };
}

const positions = (db.prepare("SELECT count(*) c, count(DISTINCT wallet) w FROM trader_positions").get() as { c: number; w: number });
console.log(`\nfolded ${stats.folded.toLocaleString()} trades from ${(stats.logs + stats.unknown).toLocaleString()} logs in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  cursor at ${(foldCursor(db) ?? stats.toBlock).toLocaleString()}; ${positions.c.toLocaleString()} positions, ${positions.w.toLocaleString()} wallets, ${counts.losses} losses, ${counts.statuses} status changes`);

if (!ONCE) {
  // Follow the head from the cursor, a few seconds at a time, until stopped.
  console.log("\nfollowing the head (ctrl-c to stop)");
  let cursor = foldCursor(db) ?? stats.toBlock;
  for (;;) {
    await sleep(3000);
    let head: number;
    try {
      head = await chainHead();
    } catch (e) {
      console.log(`  head read failed: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    if (head <= cursor) continue;
    const s = await foldRange(db, cursor + 1, head, { chunk: CHUNK, quotes, onTrade });
    cursor = s.toBlock;
    if (s.folded) report(cursor, s);
  }
}
db.close();
