import { BLOCKS_PER_DAY, BLOCKS_PER_SECOND, CFG } from "../chain/config.ts";
import { logsClient, sleep, stateClient, withRetry } from "../chain/chain.ts";
import { fillPoolSymbols, resolvePoolsSweep } from "../chain/pool.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { chainHead, type Applied, type DecodedTrade } from "../fold.ts";
import { detectLoss } from "../losses.ts";
import {
  foldPoolRange, poolFoldCursor, poolMap, POOL_CURSOR, POOL_INIT_CURSOR, POOL_WINDOW_START,
  type PoolFoldStats,
} from "../poolfold.ts";
import { usdOf } from "../prices.ts";
import { backfillQuoteAssets, quoteMap, resolveQuote } from "../quote.ts";
import { applyTradeState } from "../state.ts";

/**
 * rekt pools --init [--from N | --since-v2] [--chunk N]
 * rekt pools --hours N | --from N [--to N] [--chunk N] [--once]
 *
 * Two jobs, one file. `--init` sweeps the PoolManager's Initialize logs and fills the `pools`
 * table, then reads a symbol for every pool whose token has no launches row. The fold reads v4
 * Swap logs and folds them into trader_positions through poolfold.foldPoolRange, with the same
 * onTrade hook the curve fold uses (losses.detectLoss, then state.applyTradeState), so a
 * backfilled window fills the Hall of Rekt and the board's statuses too.
 *
 * Seventy per cent of the chain's trading happens after graduation, so this is most of the tape.
 * Positions cannot be unfolded: blocks already inside [pool_from_block, pool_to_block] are trimmed
 * off the window rather than folded twice. Run `--init` before the fold, and keep the fold and the
 * watcher off the same cursor at the same time.
 */
const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(`--${n}`);
const arg = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};

const INIT = has("init");
const ONCE = has("once");
const SINCE_V2 = has("since-v2");
const HOURS = arg("hours", 0);
/** --tx-rpc state | logs | <url>: where the batched sender lookup goes. See poolfold.resolveSenders. */
const txFlag = argv.indexOf("--tx-rpc") >= 0 ? String(argv[argv.indexOf("--tx-rpc") + 1] ?? "") : "";
const txRpcUrl = txFlag === "logs" ? CFG.logsUrl : txFlag === "state" ? CFG.stateUrl : (txFlag || CFG.stateUrl);

/** Pons v2 opened on 4 August 2026; the block for that instant is found by bisecting block times. */
const PONS_V2_START_ISO = "2026-08-04T00:00:00Z";

const db = openDb();

/**
 * A block's timestamp. publicnode answers only for recent blocks ("archive requests require a
 * personal token"), and the bisection walks back a month, so the official RPC is the fallback.
 */
const tsOfBlock = async (n: number): Promise<number | null> => {
  const read = async (client: typeof stateClient): Promise<{ timestamp: `0x${string}` } | null> =>
    (await withRetry(() => client.request({
      method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false],
    } as never))) as { timestamp: `0x${string}` } | null;
  let b: { timestamp: `0x${string}` } | null = null;
  try {
    b = await read(stateClient);
  } catch {
    b = null;
  }
  if (!b) b = await read(logsClient);
  return b ? Number(BigInt(b.timestamp)) : null;
};

/** The first block at or after an instant, by bisection on block timestamps (about 26 reads). */
async function blockAt(ts: number, head: number): Promise<number> {
  let lo = 1;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = await tsOfBlock(mid);
    if (t === null || t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- init

if (INIT) {
  const head = await chainHead();
  const chunk = arg("chunk", 100_000);
  const stored = Number(getMeta(db, POOL_INIT_CURSOR) ?? NaN);
  const earliestLaunch = (db.prepare("SELECT min(block) b FROM launches").get() as { b: number | null }).b;

  let from = arg("from", 0);
  let why = "--from";
  if (!from && SINCE_V2) {
    const target = Math.floor(Date.parse(PONS_V2_START_ISO) / 1000);
    const byTime = await blockAt(target, head);
    from = earliestLaunch !== null ? Math.min(byTime, earliestLaunch) : byTime;
    why = earliestLaunch !== null && earliestLaunch < byTime
      ? `--since-v2, the earliest launch on record (${earliestLaunch.toLocaleString()}) is older than ${PONS_V2_START_ISO} (block ${byTime.toLocaleString()})`
      : `--since-v2, the block at ${PONS_V2_START_ISO} by bisection on block times`;
  }
  if (!from && Number.isFinite(stored)) { from = stored + 1; why = `resuming from ${POOL_INIT_CURSOR}`; }
  if (!from) { from = head - BLOCKS_PER_DAY; why = "no range given, the last day"; }

  console.log("pools --init  v4 Initialize logs into the pools table");
  console.log(`  ${from.toLocaleString()} .. ${head.toLocaleString()}  (${(head - from).toLocaleString()} blocks, chunks of ${chunk.toLocaleString()})`);
  console.log(`  range: ${why}\n`);

  const started = Date.now();
  const s = await resolvePoolsSweep(db, from, head, {
    chunk,
    onChunk: (upTo, st) => {
      if (st.chunks % 25 !== 0 && upTo < head) return;
      const done = (upTo - from) / Math.max(1, head - from);
      console.log(`  ${upTo.toLocaleString()}  ${(done * 100).toFixed(0)}%  ${st.found} pools (${st.withLaunch} with a launch, ${st.withoutLaunch} without, ${st.ambiguous} ambiguous)`);
    },
  });
  setMeta(db, POOL_INIT_CURSOR, String(head));

  const total = (db.prepare("SELECT count(*) c FROM pools").get() as { c: number }).c;
  console.log(`\nswept ${s.logs.toLocaleString()} Initialize logs in ${s.chunks} reads, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${s.found.toLocaleString()} Pons pools: ${s.withLaunch.toLocaleString()} with a launches row, ${s.withoutLaunch.toLocaleString()} without, ${s.ambiguous.toLocaleString()} ambiguous (skipped)`);
  if (s.quoteMismatch) console.log(`  ${s.quoteMismatch.toLocaleString()} pools quote in something other than what their launch record says`);
  console.log(`  pools table now holds ${total.toLocaleString()} rows`);

  const sym = await fillPoolSymbols(db, arg("symbols", 20_000));
  console.log(`  symbols: ${sym.filled.toLocaleString()} of ${sym.read.toLocaleString()} read (${sym.pending.toLocaleString()} pools had none)`);
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------- fold

const pools = poolMap(db);
if (!pools.size) {
  console.log("no pools known: run `npm run pools -- --init --since-v2` first");
  db.close();
  process.exit(2);
}

// Every quote asset a pool trades against must be priced, or detectLoss records nothing.
await backfillQuoteAssets(db);
for (const q of new Set([...pools.values()].map((p) => p.quote))) await resolveQuote(db, q);
const quotes = quoteMap(db);

const head = await chainHead();
const to = arg("to", 0) || head;
const stored = poolFoldCursor(db);
const from = arg("from", 0)
  || (HOURS ? head - Math.round(HOURS * 3600 * BLOCKS_PER_SECOND) : 0)
  || (stored !== null ? stored + 1 : head - 20_000);

if (from > to) {
  console.log(`nothing to fold: ${from.toLocaleString()} is past ${to.toLocaleString()}`);
  db.close();
  process.exit(0);
}

/**
 * The parts of the window not folded yet, the way cli/fold.ts splits them.
 *
 * Positions cannot be unfolded, so blocks inside [pool_from_block, pool_to_block] are never read
 * twice. A window that reaches below the folded range is a backward extension: it is folded upward
 * with its own checkpoint (pool_back_to) and pool_from_block only moves down once it reaches the old
 * start, so an interrupted extension is finished by the next run instead of leaving a hole that
 * reads as folded. A window that neither overlaps nor touches the folded range is refused: the
 * blocks between would never be folded at all.
 */
const prevFrom = Number(getMeta(db, POOL_WINDOW_START) ?? NaN);
const prevTo = Number(getMeta(db, POOL_CURSOR) ?? NaN);
const folded = Number.isFinite(prevFrom) && Number.isFinite(prevTo) && prevFrom <= prevTo;
const backFrom = Number(getMeta(db, "pool_back_from") ?? NaN);
const backTo = Number(getMeta(db, "pool_back_to") ?? NaN);
const interrupted = folded && Number.isFinite(backFrom) && Number.isFinite(backTo)
  && backFrom < prevFrom && backTo >= backFrom && backTo < prevFrom - 1;
const foldedFrom = interrupted ? backFrom : prevFrom;

type Segment = { from: number; to: number; kind: "forward" | "backward"; start: number };
const segments: Segment[] = [];
if (interrupted) {
  console.log(`  finishing an interrupted extension first: blocks ${(backTo + 1).toLocaleString()}..${(prevFrom - 1).toLocaleString()}`);
  segments.push({ from: backTo + 1, to: prevFrom - 1, kind: "backward", start: backFrom });
}
if (folded && from <= prevTo + 1 && to >= foldedFrom - 1) {
  if (from < foldedFrom) segments.push({ from, to: foldedFrom - 1, kind: "backward", start: from });
  if (to > prevTo) segments.push({ from: prevTo + 1, to, kind: "forward", start: prevTo + 1 });
  if (Math.max(from, foldedFrom) <= Math.min(to, prevTo)) {
    console.log(`  blocks ${Math.max(from, foldedFrom).toLocaleString()}..${Math.min(to, prevTo).toLocaleString()} are folded already and are skipped`);
  }
} else if (folded) {
  const hint = to < foldedFrom
    ? `--to ${(foldedFrom - 1).toLocaleString()} so the window reaches the folded range`
    : `--from ${(prevTo + 1).toLocaleString()}, or no flags to resume from the cursor`;
  console.log(`refusing: blocks ${(to < foldedFrom ? to + 1 : prevTo + 1).toLocaleString()}..${(to < foldedFrom ? foldedFrom - 1 : from - 1).toLocaleString()} would never be folded; use ${hint}`);
  db.close();
  process.exit(2);
} else {
  segments.push({ from, to, kind: "forward", start: from });
}

if (!segments.length) {
  console.log(`nothing to fold: blocks ${from.toLocaleString()}..${to.toLocaleString()} are inside the folded range already`);
  db.close();
  process.exit(0);
}

console.log("pools  v4 pool swaps into positions");
console.log(`  ${from.toLocaleString()} .. ${to.toLocaleString()}  (${(to - from).toLocaleString()} blocks, ${((to - from) / BLOCKS_PER_SECOND / 3600).toFixed(1)} h of chain)`);
console.log(`  ${pools.size.toLocaleString()} pools known; senders from ${txRpcUrl}\n`);

if (!folded) setMeta(db, POOL_WINDOW_START, String(from));

const started = Date.now();
const counts = { losses: 0, statuses: 0 };
const wallets = new Set<string>();
/** Synchronous on purpose: it runs inside foldPoolRange's chunk transaction. */
const onTrade = (t: DecodedTrade, r: Applied): void => {
  wallets.add(t.wallet);
  if (detectLoss(db, r.before, r.after, t, usdOf(quotes.get(t.pair)?.symbol))) counts.losses++;
  if (applyTradeState(db, t)) counts.statuses++;
};

const report = (upTo: number, s: PoolFoldStats): void => {
  const pct = ((upTo - from) / Math.max(1, to - from)) * 100;
  console.log(`  ${upTo.toLocaleString()}  ${pct.toFixed(0)}%  ${s.folded.toLocaleString()} trades from ${s.matched.toLocaleString()} swaps on our pools, ${s.unresolved.toLocaleString()} senders unresolved, ${counts.losses} losses`);
};

let stats: PoolFoldStats = { logs: 0, matched: 0, unknown: 0, folded: 0, unresolved: 0, odd: 0, txs: 0, chunks: 0, toBlock: stored ?? from - 1 };
for (const seg of segments) {
  const backward = seg.kind === "backward";
  if (backward) setMeta(db, "pool_back_from", String(seg.start));
  const s = await foldPoolRange(db, seg.from, seg.to, {
    chunk: arg("chunk", 0) || undefined,
    pools,
    txRpcUrl,
    onTrade,
    cursorKey: backward ? "pool_back_to" : undefined,
    onChunk: (upTo, st) => { if (st.chunks % 5 === 0 || upTo >= seg.to) report(upTo, st); },
  });
  if (backward) {
    // The extension reached the old start: the folded range now begins where it began.
    setMeta(db, POOL_WINDOW_START, String(seg.start));
    db.prepare("DELETE FROM meta WHERE key IN ('pool_back_from', 'pool_back_to')").run();
  }
  stats = {
    logs: stats.logs + s.logs, matched: stats.matched + s.matched, unknown: stats.unknown + s.unknown,
    folded: stats.folded + s.folded, unresolved: stats.unresolved + s.unresolved, odd: stats.odd + s.odd,
    txs: stats.txs + s.txs, chunks: stats.chunks + s.chunks,
    toBlock: backward ? stats.toBlock : s.toBlock,
  };
}

const positions = db.prepare("SELECT count(*) c, count(DISTINCT wallet) w FROM trader_positions").get() as { c: number; w: number };
console.log(`\nfolded ${stats.folded.toLocaleString()} pool trades from ${stats.logs.toLocaleString()} swap logs (${stats.matched.toLocaleString()} on our pools) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  ${stats.txs.toLocaleString()} transactions resolved, ${stats.unresolved.toLocaleString()} swaps skipped for an unreadable sender, ${stats.odd.toLocaleString()} with amounts that made no sense`);
console.log(`  ${wallets.size.toLocaleString()} distinct wallets touched, ${counts.losses} losses, ${counts.statuses} status changes`);
console.log(`  cursor at ${(poolFoldCursor(db) ?? stats.toBlock).toLocaleString()}; ${positions.c.toLocaleString()} positions over ${positions.w.toLocaleString()} wallets in total`);

if (!ONCE) {
  // Follow the head from the cursor, a few seconds at a time, until stopped.
  console.log("\nfollowing the head (ctrl-c to stop)");
  let cursor = poolFoldCursor(db) ?? stats.toBlock;
  for (;;) {
    await sleep(3000);
    let h: number;
    try {
      h = await chainHead();
    } catch (e) {
      console.log(`  head read failed: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    if (h <= cursor) continue;
    const s = await foldPoolRange(db, cursor + 1, h, { pools, txRpcUrl, onTrade });
    cursor = s.toBlock;
    if (s.folded) report(cursor, s);
  }
}
db.close();
