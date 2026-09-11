import { TOPIC } from "./chain/abi.ts";
import { BlockClock } from "./chain/blockclock.ts";
import { hexNum, logsClient, sleep, stateClient, withRetry, wsClient, type RawLog } from "./chain/chain.ts";
import { ADDR, CFG } from "./chain/config.ts";
import { getMeta, now, openDb, rollbackFrom, setMeta } from "./db.ts";
import { enrichOne } from "./enrich.ts";
import { curveMap, foldCursor, foldRange, FOLD_CHUNK, FOLD_MIN_CHUNK, isRangeError, type Applied, type CurveInfo, type DecodedTrade } from "./fold.ts";
import { backfillRange, FACTORY_TOPICS, writeFactoryLogs } from "./ingest.ts";
import { resolvePoolsSweep } from "./chain/pool.ts";
import { foldPoolRange, poolFoldCursor, POOL_CHUNK, POOL_INIT_CURSOR, poolMap, type PoolInfo } from "./poolfold.ts";
import { detectLoss } from "./losses.ts";
import { refreshPrices, usdOf } from "./prices.ts";
import { backfillQuoteAssets, quoteMap, resolveQuote, type QuoteAsset } from "./quote.ts";
import { applyGraduation, applyLaunch, applyTradeState, seedTokenState, sweepStatuses } from "./state.ts";
import type { LaunchRecord } from "./types.ts";

/**
 * rekt-watch: the one long-running writer (npm run watch).
 *
 *  (a) The factory watcher: TokenLaunched, PoolGraduated and CreatorFeeRecipientUpdated, pushed by
 *      the publicnode websocket with a polling floor, read from the official RPC with an overlap
 *      (the official RPC trails publicnode by a few blocks and answers a range past its own head
 *      with what it has, silently, so every read is also capped at the logs endpoint's own head,
 *      polled separately). New launches are enriched (name, symbol, tx.from) by a worker that
 *      never blocks the loop, then handed to state.applyLaunch; graduations to applyGraduation.
 *      A gap wider than one read (the watcher was down for hours) is backfilled chunk by chunk
 *      before the fold may walk it, so no curve launched in the gap folds as unknown.
 *  (b) The trade fold: every CurveBuy and CurveSell chain-wide, polled every POLL_MS from the fold
 *      cursor in chunks of at most 2,000 blocks, trailing the head by TRAIL_BLOCKS and never past
 *      the logs endpoint's head, folded through fold.applyTrade with losses.detectLoss and
 *      state.applyTradeState inside the chunk's transaction.
 *  (c) state.sweepStatuses every SWEEP_MS, on chain time as the fold knows it.
 *  (d) A heartbeat in meta (live_seen_at, live_head_block, live_cursor_block) for /api/health.
 *  (e) A reorg guard: the hash of the last folded block is checked again a few seconds later; a
 *      change rolls the factory tables back with db.rollbackFrom and re-reads them.
 *
 * Every database transaction here is synchronous (no await inside BEGIN..COMMIT), which is what
 * lets three async loops share one connection without ever nesting transactions.
 */

/** Blocks the fold stays behind the head: the official RPC's lag plus a reorg margin. */
const TRAIL_BLOCKS = 30;
/** Blocks kept behind the logs endpoint's own head: nodes behind the one hostname disagree by a few. */
const LOGS_MARGIN = 10;
const LOGS_HEAD_MS = 2_000;
/** Graduated curves stay in the map this many blocks past the fold cursor, then are dropped. */
const GRADUATED_KEEP_BLOCKS = 1_000;
/** Blocks re-read on every factory pass, for the same lag (see the reference watcher's note). */
const OVERLAP_BLOCKS = 100;
/** Widest factory catch-up in one read; the endpoint refuses far wider ranges. */
const FACTORY_MAX_RANGE = CFG.logsChunk;
const FACTORY_MIN_GAP_MS = 2_500;
const SWEEP_MS = 30_000;
const REORG_CHECK_MS = 10_000;
const HEARTBEAT_MS = 2_000;
const PRICES_MS = 3_600_000;
const ENRICH_WORKERS = 6;

const db = openDb();
const log = (m: string): void => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const oneLine = (err: unknown): string => String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 160);

await backfillQuoteAssets(db);
const seeded = seedTokenState(db);
let foldTo = foldCursor(db) ?? 0;
let poolTo = poolFoldCursor(db) ?? 0;
/**
 * curve → token, rebuilt from the table only at start and after a reorg; a launch is added as
 * its batch is written and a graduated curve is dropped once the fold is well past graduation
 * (see pruneGraduated). A full rebuild scans every launch on record, which is minutes of
 * synchronous work after a month, so it is never done per batch.
 */
let curves: Map<string, CurveInfo> = curveMap(db, { graduatedBefore: Math.max(0, foldTo - GRADUATED_KEEP_BLOCKS) });
const quotes: Map<string, QuoteAsset> = quoteMap(db);
const clock = new BlockClock();

const refreshMaps = (): void => {
  curves = curveMap(db, { graduatedBefore: Math.max(0, foldTo - GRADUATED_KEEP_BLOCKS) });
  for (const [k, v] of quoteMap(db)) quotes.set(k, v);
};

/** Curves that graduated, with the block, waiting for the fold to pass them. */
const graduatedCurves: Array<{ curve: string; block: number }> = [];
const curveRow = db.prepare("SELECT curve, pair_token, graduated_block FROM launches WHERE token = ?");

function addCurve(token: string): void {
  const l = curveRow.get(token) as { curve: string; pair_token: string; graduated_block: number | null } | undefined;
  if (!l) return;
  curves.set(l.curve.toLowerCase(), { token, pair: l.pair_token });
}

function pruneGraduated(): void {
  const before = foldTo - GRADUATED_KEEP_BLOCKS;
  while (graduatedCurves.length && graduatedCurves[0].block < before) curves.delete(graduatedCurves.shift()!.curve);
}

// ------------------------------------------------------------------ head and heartbeat

type Head = { number: number; ts: number; hash: string };
let head: Head | null = null;
let lastBeat = 0;
/** The logs endpoint's own head. Both readers are capped by it: past it the endpoint answers with what it has, silently. */
let logsHead = 0;

async function readLogsHead(): Promise<void> {
  try {
    const n = Number(await withRetry(() => logsClient.getBlockNumber(), 2));
    if (n > logsHead) logsHead = n;
  } catch (err) {
    log(`logs head: ${oneLine(err)}`);
  }
}

/** The highest block a read from the logs endpoint may safely end at right now; 0 before its head is known. */
const logsLimit = (): number => (logsHead ? logsHead - LOGS_MARGIN : 0);

/** Number, time and hash of the latest block, from the state endpoint (the logs endpoint as fallback). */
async function readHead(): Promise<Head> {
  const read = async (client: typeof stateClient): Promise<Head> => {
    const b = (await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] } as never)) as
      { number: `0x${string}`; timestamp: `0x${string}`; hash: string } | null;
    if (!b) throw new Error("no latest block");
    return { number: hexNum(b.number), ts: hexNum(b.timestamp), hash: b.hash };
  };
  try {
    return await withRetry(() => read(stateClient), 3);
  } catch {
    return await withRetry(() => read(logsClient), 3);
  }
}

/** Heads seen with their hash, newest last: the reorg guard compares against these. */
const recentHeads: Head[] = [];

function seeHead(h: Head): void {
  if (head && h.number < head.number) return;
  head = h;
  if (h.hash) {
    clock.anchor(h.number, h.ts);
    recentHeads.push(h);
    if (recentHeads.length > 120) recentHeads.shift();
  }
  beat();
}

function beat(force = false): void {
  if (!force && Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
  if (head) setMeta(db, "live_head_block", String(head.number));
  setMeta(db, "live_cursor_block", String(factoryCursor));
  setMeta(db, "live_seen_at", String(now()));
}

// ------------------------------------------------------------------ (a) the factory

let factoryCursor = Number(getMeta(db, "live_cursor_block") ?? 0) || Number(getMeta(db, "backfill_to_block") ?? 0);
let factoryBusy = false;
let lastFactoryRead = 0;
let factoryHead = 0;

const topicAddr = (t: string): string => `0x${t.slice(26)}`.toLowerCase();

/** The launches and graduations in a batch that the database does not know yet, decided before the write. */
function unannounced(logs: RawLog[]): RawLog[] {
  const hasLaunch = db.prepare("SELECT 1 x FROM launches WHERE token = ?");
  const hasGrad = db.prepare("SELECT 1 x FROM launches WHERE token = ? AND graduated_ts IS NOT NULL");
  return logs.filter((l) => {
    const token = topicAddr(l.topics[1]);
    if (l.topics[0] === TOPIC.tokenLaunched) return !hasLaunch.get(token);
    if (l.topics[0] === TOPIC.poolGraduated) return !hasGrad.get(token);
    return false;
  });
}

async function factoryCatchUp(): Promise<void> {
  if (!head || factoryBusy) return;
  const to = Math.min(head.number, logsLimit());
  if (to <= factoryCursor) return;
  if (Date.now() - lastFactoryRead < FACTORY_MIN_GAP_MS) return;
  factoryBusy = true;
  lastFactoryRead = Date.now();
  try {
    const floor = to - FACTORY_MAX_RANGE;
    if (floor > factoryCursor + 1) {
      if (factoryCursor > 0) {
        // Down for longer than one read covers: read the gap chunk by chunk before anything else.
        // factoryHead stays where it was meanwhile, so the fold cannot walk the gap first.
        const gapFrom = Math.max(0, factoryCursor + 1 - OVERLAP_BLOCKS);
        log(`factory: ${(floor - factoryCursor - 1).toLocaleString()} blocks behind, reading ${gapFrom.toLocaleString()}..${(floor - 1).toLocaleString()} first`);
        const c = await backfillRange(db, gapFrom, floor - 1, undefined, clock);
        const rows = seedTokenState(db);
        for (const t of db.prepare("SELECT token FROM launches WHERE block >= ? AND block < ?").all(gapFrom, floor) as Array<{ token: string }>) addCurve(t.token);
        log(`factory: gap read, ${c.launched} launched, ${c.graduated} arrived, ${rows} boarded silently`);
      } else {
        log(`factory: skipping ${floor - factoryCursor - 1} blocks, wider than one read; run backfill for them`);
      }
    }
    const from = Math.max(factoryCursor + 1 - OVERLAP_BLOCKS, floor, 0);
    const logs = (await withRetry(() => logsClient.request({
      method: "eth_getLogs",
      params: [{ address: ADDR.factory, topics: [FACTORY_TOPICS], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    } as never))) as RawLog[];

    if (logs.length) {
      const fresh = unannounced(logs);
      // A wide first read after downtime has hundreds of distinct blocks: anchors every 20k
      // blocks first, or every block is a header fetch and the read takes minutes.
      if (!clock.covers(from, to)) await clock.seed(from, to);
      const tsOf = new Map<number, number>();
      for (const b of new Set(logs.map((l) => hexNum(l.blockNumber)))) tsOf.set(b, await clock.at(b));
      writeFactoryLogs(db, logs, tsOf);
      // The map learns every launch in the batch as it is written, and forgets a graduated curve
      // once the fold is past its graduation; no rebuild from the table.
      for (const l of logs) {
        if (l.topics[0] === TOPIC.tokenLaunched) addCurve(topicAddr(l.topics[1]));
      }
      let launched = 0;
      let graduated = 0;
      for (const l of fresh) {
        const token = topicAddr(l.topics[1]);
        const ts = tsOf.get(hexNum(l.blockNumber)) ?? now();
        if (l.topics[0] === TOPIC.tokenLaunched) {
          enrichQueue.push({ token, tx: l.transactionHash });
          launched++;
        } else if (l.topics[0] === TOPIC.poolGraduated) {
          if (applyGraduation(db, token, ts)) graduated++;
          const row = curveRow.get(token) as { curve: string } | undefined;
          if (row) graduatedCurves.push({ curve: row.curve.toLowerCase(), block: hexNum(l.blockNumber) });
        }
      }
      if (launched || graduated) {
        void drainEnrichment();
        log(`factory: ${launched} launched, ${graduated} arrived, at ${to.toLocaleString()}`);
      }
    }
    factoryCursor = to;
    factoryHead = to;
    beat(true);
  } catch (err) {
    log(`factory: read failed, will retry: ${oneLine(err)}`);
  } finally {
    factoryBusy = false;
  }
}

// ------------------------------------------------------------------ enrichment, off the loop

const enrichQueue: Array<{ token: string; tx: string }> = [];
let draining = false;

/** Reads the launch row as state.applyLaunch wants it. */
async function launchRecord(token: string): Promise<LaunchRecord | null> {
  const l = db.prepare(`
    SELECT token, curve, deployer, launch_sender, pair_token, name, symbol, ts, block, log_index FROM launches WHERE token = ?`).get(token) as
    { token: string; curve: string; deployer: string; launch_sender: string | null; pair_token: string; name: string | null; symbol: string | null; ts: number; block: number; log_index: number } | undefined;
  if (!l) return null;
  const q = await resolveQuote(db, l.pair_token);
  // A failed read comes back as "?" and is not kept: the prices loop asks again later.
  if (q.symbol !== "?") quotes.set(q.address, q);
  return {
    token: l.token, curve: l.curve, deployer: l.launch_sender ?? l.deployer, pair: l.pair_token, pairSymbol: q.symbol,
    symbol: l.symbol, name: l.name, ts: l.ts, block: l.block, logIndex: l.log_index,
  };
}

/**
 * Enriches queued launches a few at a time and boards each one once its name is known. A failed
 * enrichment still boards the token (symbol from the address) so the board never waits on the RPC;
 * `names` fills the symbol in later and applyLaunch updates the row.
 */
async function drainEnrichment(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (enrichQueue.length) {
      const batch = enrichQueue.splice(0, ENRICH_WORKERS);
      await Promise.all(batch.map(async ({ token, tx }) => {
        try {
          await enrichOne(db, token, tx);
        } catch {
          // boarded without a name; the names CLI retries.
        }
        const rec = await launchRecord(token);
        if (rec) applyLaunch(db, rec);
      }));
    }
  } catch (err) {
    log(`enrich: ${oneLine(err)}`);
  } finally {
    draining = false;
  }
}

// ------------------------------------------------------------------ (b) the trade fold

let lastFoldTs = 0;
let lastFoldLog = 0;
let pending = { folded: 0, unknown: 0, losses: 0, statuses: 0, passes: 0 };
/** The fold's read width; halved when the endpoint refuses a range, back to full after clean reads. */
let foldChunk = FOLD_CHUNK;

/** Synchronous on purpose: it runs inside foldRange's chunk transaction. */
function onTrade(t: DecodedTrade, r: Applied): void {
  if (detectLoss(db, r.before, r.after, t, usdOf(quotes.get(t.pair)?.symbol))) pending.losses++;
  if (applyTradeState(db, t)) pending.statuses++;
}

let poolPending = { folded: 0, matched: 0, unresolved: 0, smart: 0, passes: 0 };
let poolChunk = POOL_CHUNK;
let lastPoolLog = 0;

/**
 * The other half of the tape: trades in the Uniswap pools tokens graduate into.
 *
 * Measured on 11 September 2026, a five-minute window held 2,607 curve trades against 6,147 pool
 * swaps, so leaving this loop out means indexing under a third of the chain's trading and showing
 * an empty report to anybody who trades the tokens that made it. Its own cursor, its own chunk
 * width, and the same head limits the curve fold respects.
 */
async function poolLoop(): Promise<void> {
  if (!poolTo) {
    poolTo = (head?.number ?? 0) - TRAIL_BLOCKS - 1;
    setMeta(db, "pool_from_block", String(poolTo + 1));
    log(`pools: no cursor, starting at ${(poolTo + 1).toLocaleString()}`);
  }
  let pools = poolMap(db);
  for (;;) {
    const limit = Math.min((head?.number ?? 0) - TRAIL_BLOCKS, logsLimit());
    if (limit <= poolTo) { await sleep(CFG.pollMs); continue; }
    const from = poolTo + 1;
    const to = Math.min(limit, from + poolChunk - 1);
    try {
      const s = await foldPoolRange(db, from, to, { chunk: poolChunk, pools, clock, onTrade, once: true });
      poolTo = s.toBlock;
      poolPending.folded += s.folded;
      poolPending.matched += s.matched;
      poolPending.unresolved += s.unresolved;
      poolPending.smart += s.smartAccount;
      poolPending.passes++;
      if (poolChunk < POOL_CHUNK) poolChunk = Math.min(POOL_CHUNK, poolChunk * 2);
    } catch (err) {
      if (isRangeError(err) && poolChunk > FOLD_MIN_CHUNK) poolChunk = Math.max(FOLD_MIN_CHUNK, Math.floor(poolChunk / 2));
      log(`pools: ${oneLine(err)}${poolChunk < POOL_CHUNK ? ` (reading ${poolChunk} blocks at a time)` : ""}`);
      await sleep(CFG.logsSpacingMs * 4);
    }
    if (Date.now() - lastPoolLog >= 10_000 && poolPending.folded) {
      log(`pools: ${poolPending.folded} trades of ${poolPending.matched} swaps in ${poolPending.passes} reads, `
        + `${poolPending.smart} through a smart account, ${poolPending.unresolved} unattributed, `
        + `cursor ${poolTo.toLocaleString()} (${((head?.number ?? poolTo) - poolTo)} behind)`);
      poolPending = { folded: 0, matched: 0, unresolved: 0, smart: 0, passes: 0 };
      lastPoolLog = Date.now();
      pools = await adoptNewPools(pools);
    }
    await sleep(to >= limit ? Math.max(CFG.pollMs, CFG.logsSpacingMs) : CFG.logsSpacingMs);
  }
}

/**
 * Pools the chain opened since the last sweep, adopted into the map, with the swaps they made
 * before anybody knew them folded late.
 *
 * A pool missing from the map is a swap dropped, silently. The map was reloaded from the pools
 * table every few seconds, but nothing added to that table between manual runs of `pools --init`:
 * on launch day the sweep found 407 pools the watcher had never heard of, one of them ours, and
 * fifty thousand swaps that no report and no leaderboard had counted. Initialize logs are rare,
 * so one read per pass finds them; the swaps a new pool made between its opening and this pass
 * are folded for that pool alone, cursors untouched, since positions are sums and those blocks
 * were folded without it.
 */
async function adoptNewPools(current: Map<string, PoolInfo>): Promise<Map<string, PoolInfo>> {
  const swept = Number(getMeta(db, POOL_INIT_CURSOR) ?? NaN);
  const from = Number.isFinite(swept) ? swept + 1 : Math.max(0, poolTo - 3_000);
  if (poolTo < from) return current;
  try {
    const st = await resolvePoolsSweep(db, from, poolTo, { chunk: 100_000 });
    setMeta(db, POOL_INIT_CURSOR, String(poolTo));
    if (!st.found) return current;
    const next = poolMap(db);
    const fresh = new Map([...next].filter(([id]) => !current.has(id)));
    if (fresh.size) {
      const r = await foldPoolRange(db, from, poolTo, { pools: fresh, clock, onTrade, checkpoint: false, cursorKey: "pool_late_scratch" });
      log(`pools: ${fresh.size} new pool(s) opened since ${from.toLocaleString()}; ${r.folded} of their swaps folded late`);
    }
    return next;
  } catch (err) {
    log(`pools: sweep for new pools failed (${oneLine(err)}); the map stands`);
    return current;
  }
}

async function foldLoop(): Promise<void> {
  if (!foldTo) {
    foldTo = (head?.number ?? 0) - TRAIL_BLOCKS - 1;
    setMeta(db, "fold_from_block", String(foldTo + 1));
    log(`fold: no cursor, starting at ${(foldTo + 1).toLocaleString()}`);
  }
  for (;;) {
    // Never past the factory read (less its own lag margin): a curve launched in a block the
    // factory has not covered yet would have its first trades folded as unknown and lost. And
    // never past the logs endpoint's own head: a range past it comes back short, silently, and
    // a chunk checkpointed short can never be refolded.
    const limit = Math.min((head?.number ?? 0) - TRAIL_BLOCKS, factoryHead ? factoryHead - 20 : 0, logsLimit());
    if (limit <= foldTo) { await sleep(CFG.pollMs); continue; }
    const from = foldTo + 1;
    const to = Math.min(limit, from + foldChunk - 1);
    try {
      const s = await foldRange(db, from, to, { chunk: foldChunk, curves, quotes, clock, onTrade, once: true });
      foldTo = s.toBlock;
      lastFoldTs = await clock.at(foldTo);
      pending.folded += s.folded;
      pending.unknown += s.unknown;
      pending.passes++;
      if (foldChunk < FOLD_CHUNK) foldChunk = Math.min(FOLD_CHUNK, foldChunk * 2);
      pruneGraduated();
    } catch (err) {
      if (isRangeError(err) && foldChunk > FOLD_MIN_CHUNK) foldChunk = Math.max(FOLD_MIN_CHUNK, Math.floor(foldChunk / 2));
      log(`fold: ${oneLine(err)}${foldChunk < FOLD_CHUNK ? ` (reading ${foldChunk} blocks at a time)` : ""}`);
      await sleep(CFG.logsSpacingMs * 4);
    }
    beat();
    if (Date.now() - lastFoldLog >= 10_000 && pending.folded) {
      log(`fold: ${pending.folded} trades in ${pending.passes} reads, ${pending.unknown} unknown, ${pending.losses} losses, ${pending.statuses} status changes, cursor ${foldTo.toLocaleString()} (${((head?.number ?? foldTo) - foldTo)} behind)`);
      pending = { folded: 0, unknown: 0, losses: 0, statuses: 0, passes: 0 };
      lastFoldLog = Date.now();
    }
    // LOGS_SPACING_MS between reads while catching up; at the head, the poll interval (never below the spacing).
    await sleep(to >= limit ? Math.max(CFG.pollMs, CFG.logsSpacingMs) : CFG.logsSpacingMs);
  }
}

// ------------------------------------------------------------------ (c) sweep, (e) reorg guard, prices

async function sweepLoop(): Promise<void> {
  for (;;) {
    await sleep(SWEEP_MS);
    // On chain time only: the wall clock would bury tokens whose trades the fold has not read yet.
    if (!lastFoldTs) continue;
    try {
      const evs = sweepStatuses(db, lastFoldTs);
      if (evs.length) log(`sweep: ${evs.length} departed`);
    } catch (err) {
      log(`sweep: ${oneLine(err)}`);
    }
  }
}

/**
 * Re-reads a block the fold has passed and compares its hash with the one seen at head time. A
 * different hash means the chain reorganised under us: the factory tables and losses from that
 * block on are dropped and re-read; positions cannot be unfolded, which is what the trail is for.
 * publicnode serves only recent blocks without a key, so the block checked is the newest folded
 * one it still answers for.
 */
async function reorgLoop(): Promise<void> {
  for (;;) {
    await sleep(REORG_CHECK_MS);
    try {
      const seen = [...recentHeads].reverse().find((h) => h.number <= foldTo && (head?.number ?? 0) - h.number < 100);
      if (!seen) continue;
      const b = (await withRetry(() => stateClient.request({
        method: "eth_getBlockByNumber", params: [`0x${seen.number.toString(16)}`, false],
      } as never), 3)) as { hash: string } | null;
      if (b && b.hash !== seen.hash) {
        log(`reorg at ${seen.number.toLocaleString()}: rolling back from there`);
        rollbackFrom(db, seen.number);
        factoryCursor = Math.min(factoryCursor, seen.number - 1);
        recentHeads.length = 0;
        refreshMaps();
      }
    } catch (err) {
      log(`reorg guard: ${oneLine(err)}`);
    }
  }
}

async function pricesLoop(): Promise<void> {
  for (;;) {
    try {
      // A quote asset whose symbol read failed earlier is asked for again here, and the map updated.
      const resolved = await backfillQuoteAssets(db);
      if (resolved) {
        for (const [k, v] of quoteMap(db)) quotes.set(k, v);
        log(`quotes: ${resolved} resolved late`);
      }
      const r = await refreshPrices([...new Set([...quotes.values()].map((q) => q.symbol))]);
      log(`prices: ${r.updated.length} updated, ${r.failed.length} failed`);
    } catch (err) {
      log(`prices: ${oneLine(err)}`);
    }
    await sleep(PRICES_MS);
  }
}

async function logsHeadLoop(): Promise<void> {
  for (;;) {
    await sleep(LOGS_HEAD_MS);
    await readLogsHead();
  }
}

// ------------------------------------------------------------------ head loop: websocket push, polling floor

async function headLoop(): Promise<void> {
  if (wsClient) {
    wsClient.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (bn) => {
        const n = Number(bn);
        if (head && n > head.number) seeHead({ number: n, ts: head.ts + Math.round((n - head.number) / 9.91), hash: "" });
        void factoryCatchUp();
      },
      onError: (e) => log(`websocket: ${oneLine(e)}`),
    });
  }
  // The polling floor also carries the real block time and hash for the clock and the reorg guard.
  const every = wsClient ? 1_000 : CFG.pollMs;
  for (;;) {
    try {
      seeHead(await readHead());
      void factoryCatchUp();
    } catch (err) {
      log(`head: ${oneLine(err)}`);
      await sleep(2_000);
    }
    await sleep(every);
  }
}

// ------------------------------------------------------------------ run

seeHead(await readHead());
await readLogsHead();
log(`watch  head ${head!.number.toLocaleString()} (logs endpoint ${logsHead.toLocaleString()}), factory cursor ${factoryCursor.toLocaleString()}, fold cursor ${foldTo.toLocaleString()}, ${curves.size} curves, ${seeded} states seeded`);
log(`       logs from ${CFG.logsUrl}, state from ${CFG.stateUrl}, push ${wsClient ? CFG.wsUrl : "off (polling)"}`);

const stop = (): void => {
  log("stopping");
  beat(true);
  db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await factoryCatchUp();
await Promise.all([headLoop(), logsHeadLoop(), foldLoop(), poolLoop(), sweepLoop(), reorgLoop(), pricesLoop()]);
