import { decodeEventLog } from "viem";
import { curveAbi, TOPIC } from "./chain/abi.ts";
import { getLogs, hexNum, logsClient, sleep, withRetry, type RawLog } from "./chain/chain.ts";
import { BlockClock } from "./chain/blockclock.ts";
import { CFG } from "./chain/config.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import { quoteMap, type QuoteAsset } from "./quote.ts";

/**
 * Curve trades folded into per-wallet positions. The raw stream is about 1.1M events a day and
 * none of it is kept: each chunk of logs is folded and discarded.
 *
 * The trader is the recipient on a buy and the seller on a sell: a router buying on somebody's
 * behalf is not the trader. Amounts are whole units of the quote asset and whole tokens.
 */
export type Trade = {
  wallet: string;
  token: string;
  side: "buy" | "sell";
  quote: number;
  tokens: number;
  ts: number;
  block?: number;
  tx?: string;
  logIndex?: number;
};

export type Position = {
  wallet: string; token: string;
  quote_in: number; quote_out: number; tokens_in: number; tokens_out: number;
  buys: number; sells: number; first_ts: number; last_ts: number; insider: number;
};

export type Applied = {
  before: Position | null;
  after: Position;
  /** Change in realized PnL from this trade, in quote units. Negative on a losing sell. */
  realizedDelta: number;
};

/**
 * Realized PnL of a position, average-cost: what came out minus the cost of the share that was
 * sold. A bag still held is not a loss yet.
 *
 * Only the units we watched being bought count, on both sides. A wallet that sells tokens whose
 * purchase happened before our record begins — 24% of positions in a ten-hour window, measured on
 * 11 September 2026 — otherwise books the whole sale as profit, because there is no cost to
 * subtract. That put wallets selling airdrops and creator allocations at the top of the ranking
 * with hundreds of thousands of dollars of invented gains. So proceeds are scaled to the covered
 * share exactly as the cost already was, and a sale with no purchase behind it is worth nothing
 * either way rather than everything one way. Where the whole position is covered, which is the
 * ordinary case, this is the same number as before.
 */
export function realized(p: Pick<Position, "quote_in" | "quote_out" | "tokens_in" | "tokens_out">): number {
  const covered = Math.min(p.tokens_out, p.tokens_in);
  if (!(covered > 0)) return 0;
  return p.quote_out * (covered / p.tokens_out) - p.quote_in * (covered / p.tokens_in);
}

/** Sold more than we saw bought: the position's history starts before our record does. */
export const hasBasis = (p: Pick<Position, "tokens_in" | "tokens_out">): boolean =>
  p.tokens_in > 0 && p.tokens_out <= p.tokens_in * 1.01;

/** Whole tokens still held. */
export const held = (p: Pick<Position, "tokens_in" | "tokens_out">): number => Math.max(0, p.tokens_in - p.tokens_out);

type Stmts = { get: ReturnType<DB["prepare"]>; insider: ReturnType<DB["prepare"]>; waived: ReturnType<DB["prepare"]>; upsert: ReturnType<DB["prepare"]> };
const stmts = new WeakMap<DB, Stmts>();

function prepared(db: DB): Stmts {
  let s = stmts.get(db);
  if (!s) {
    s = {
      get: db.prepare("SELECT * FROM trader_positions WHERE wallet = ? AND token = ?"),
      insider: db.prepare("SELECT 1 x FROM launches WHERE token = ? AND (launch_sender = ? OR deployer = ?) LIMIT 1"),
      waived: db.prepare("SELECT 1 x FROM exemptions WHERE token = ? AND address = ? LIMIT 1"),
      upsert: db.prepare(`
        INSERT INTO trader_positions (wallet, token, quote_in, quote_out, tokens_in, tokens_out, buys, sells, first_ts, last_ts, insider)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(wallet, token) DO UPDATE SET
          quote_in = excluded.quote_in, quote_out = excluded.quote_out,
          tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
          buys = excluded.buys, sells = excluded.sells,
          first_ts = excluded.first_ts, last_ts = excluded.last_ts`),
    };
    stmts.set(db, s);
  }
  return s;
}

/**
 * Folds one trade into a wallet's position, creating it on the first. Insider is decided once,
 * when the position opens: the wallet launched the token (launch_sender or deployer) or was waived
 * the opening tax on it. Returns the position before and after, so a caller can spot a loss.
 */
export function applyTrade(db: DB, t: Trade): Applied {
  const wallet = t.wallet.toLowerCase();
  const token = t.token.toLowerCase();
  const s = prepared(db);

  const before = (s.get.get(wallet, token) as Position | undefined) ?? null;
  const insider = before ? before.insider
    : (s.insider.get(token, wallet, wallet) || s.waived.get(token, wallet)) ? 1 : 0;

  const after: Position = {
    wallet, token,
    quote_in: (before?.quote_in ?? 0) + (t.side === "buy" ? t.quote : 0),
    quote_out: (before?.quote_out ?? 0) + (t.side === "sell" ? t.quote : 0),
    tokens_in: (before?.tokens_in ?? 0) + (t.side === "buy" ? t.tokens : 0),
    tokens_out: (before?.tokens_out ?? 0) + (t.side === "sell" ? t.tokens : 0),
    buys: (before?.buys ?? 0) + (t.side === "buy" ? 1 : 0),
    sells: (before?.sells ?? 0) + (t.side === "sell" ? 1 : 0),
    first_ts: before ? Math.min(before.first_ts, t.ts) : t.ts,
    last_ts: before ? Math.max(before.last_ts, t.ts) : t.ts,
    insider,
  };
  s.upsert.run(
    wallet, token, after.quote_in, after.quote_out, after.tokens_in, after.tokens_out,
    after.buys, after.sells, after.first_ts, after.last_ts, insider,
  );
  return { before, after, realizedDelta: realized(after) - (before ? realized(before) : 0) };
}

export type CurveInfo = { token: string; pair: string };

/**
 * curve → token, from launches. Held in memory: one lookup per log would be the bottleneck.
 * `graduatedBefore` leaves out curves that graduated before that block: a graduated curve never
 * emits CurveBuy or CurveSell again, so once the fold is past its graduation it is dead weight.
 */
export function curveMap(db: DB, opts: { graduatedBefore?: number } = {}): Map<string, CurveInfo> {
  const m = new Map<string, CurveInfo>();
  const rows = opts.graduatedBefore !== undefined
    ? db.prepare("SELECT curve, token, pair_token FROM launches WHERE graduated_block IS NULL OR graduated_block >= ?").all(opts.graduatedBefore)
    : db.prepare("SELECT curve, token, pair_token FROM launches").all();
  for (const r of rows as Array<{ curve: string; token: string; pair_token: string }>) {
    m.set(r.curve.toLowerCase(), { token: r.token, pair: r.pair_token });
  }
  return m;
}

export type DecodedTrade = Trade & { block: number; tx: string; logIndex: number; pair: string; quoteWei: bigint; tokensWei: bigint; fee: bigint; tax: bigint };

/** A CurveBuy or CurveSell log as a trade, or null when the curve is unknown or the log is not one. */
export function decodeTrade(
  l: RawLog, curves: Map<string, CurveInfo>, quotes: Map<string, QuoteAsset>, ts: number,
): DecodedTrade | null {
  const t0 = l.topics[0];
  if (t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell) return null;
  const curve = curves.get(l.address.toLowerCase());
  if (!curve) return null;
  let ev: ReturnType<typeof decodeEventLog>;
  try {
    ev = decodeEventLog({ abi: curveAbi, topics: l.topics, data: l.data });
  } catch {
    return null;
  }
  const a = ev.args as Record<string, unknown>;
  const buy = ev.eventName === "CurveBuy";
  const q = quotes.get(curve.pair) ?? { address: curve.pair, symbol: "?", decimals: 18 };
  const quoteWei = (buy ? a.quoteIn : a.quoteOut) as bigint;
  const tokensWei = (buy ? a.tokensOut : a.tokensIn) as bigint;
  return {
    wallet: String(buy ? a.recipient : a.seller).toLowerCase(),
    token: curve.token,
    side: buy ? "buy" : "sell",
    quote: Number(quoteWei) / 10 ** q.decimals,
    tokens: Number(tokensWei) / 1e18,
    ts,
    block: hexNum(l.blockNumber),
    tx: l.transactionHash,
    logIndex: hexNum(l.logIndex),
    pair: curve.pair,
    quoteWei, tokensWei,
    fee: a.fee as bigint,
    tax: a.tax as bigint,
  };
}

export const FOLD_CURSOR = "fold_to_block";
export const FOLD_CHUNK = 2000;
/** Narrowest chunk the fold shrinks to when the endpoint refuses a range; below this it gives up. */
export const FOLD_MIN_CHUNK = 50;
/** Consecutive failed reads of one chunk before foldRange throws, so a caller can back off. */
export const FOLD_MAX_FAILURES = 8;

export type FoldStats = { logs: number; folded: number; unknown: number; chunks: number; toBlock: number };

export type FoldOptions = {
  chunk?: number;
  /** Called once per trade after it is folded. Loss detection and token state hook in here. */
  onTrade?: (t: DecodedTrade, r: Applied) => void | Promise<void>;
  onChunk?: (to: number, stats: FoldStats) => void;
  /** Stop after the first chunk. */
  once?: boolean;
  /** Update meta.fold_to_block after every chunk (default true). */
  checkpoint?: boolean;
  /** The meta key the checkpoint goes to (default fold_to_block); the CLI's backward fold uses its own. */
  cursorKey?: string;
  /**
   * The watcher's own curve and quote maps, refreshed after every factory batch, so a curve
   * launched seconds ago is known when its first trades are folded. Without them the maps are
   * read from the database at the start and every 25 chunks.
   */
  curves?: Map<string, CurveInfo>;
  quotes?: Map<string, QuoteAsset>;
  /** A shared block clock; when given, seeding is skipped for ranges its anchors already bracket. */
  clock?: BlockClock;
};

/**
 * An eth_getLogs refusal that a narrower range gets past: the 10,000-result cap, a timeout, a range
 * the endpoint calls invalid, or an answer too large to read.
 *
 * The last one is not the endpoint refusing at all — it answers, and the client gives up: viem caps
 * a response body at 10 MB and a busy 2,000-block chunk of pool swaps came back at 10,502,144
 * bytes. Because that error looked like nothing in this list, the backfill threw instead of halving
 * the chunk, and systemd restarted it onto the same range every thirty seconds. A reply too big to
 * read is exactly a range that wants to be narrower.
 */
/**
 * Clean chunks needed before the reader tries a wider one again.
 *
 * The endpoint caps a reply at ten thousand logs, and on a busy stretch of chain every full-width
 * chunk trips it. Doubling the width after a single success means every other read is spent finding
 * that out again; a run of twenty makes the wasted read one in twenty-one.
 */
export const WIDEN_AFTER = 20;

export const isRangeError = (err: unknown): boolean =>
  // "too many results", not "Too Many Requests": a 429 is the endpoint asking for fewer requests,
  // and narrowing the range answers it with more. Rate limits belong to the retry, not to this.
  /exceeds limit|more than \d+ results|too many (?:results|logs)|timed out|timeout|invalid parameters|response size|block range|exceeded the size limit|body exceeded|ResponseBodyTooLarge/i
    .test(String((err as Error)?.message ?? err) + " " + String((err as { name?: string })?.name ?? ""));

/**
 * Reads every CurveBuy and CurveSell on the chain between two blocks, in chunks of at most 2,000
 * blocks, and folds them into positions. Checkpointed per chunk in meta so an interrupted run
 * resumes. Curves launched during a long run are picked up by refreshing the map every 25 chunks.
 *
 * A chunk the endpoint refuses (over the 10,000-log cap during a burst, a timeout) is halved and
 * only the narrower range is retried; the width creeps back up after successes. Any other error,
 * or FOLD_MAX_FAILURES failures in a row on one chunk, is thrown so the caller can log and back
 * off instead of the fold stalling on the same range forever.
 */
export async function foldRange(db: DB, fromBlock: number, toBlock: number, opts: FoldOptions = {}): Promise<FoldStats> {
  const maxChunk = Math.max(1, Math.min(FOLD_CHUNK, opts.chunk ?? FOLD_CHUNK));
  const minChunk = Math.min(FOLD_MIN_CHUNK, maxChunk);
  const cursorKey = opts.cursorKey ?? FOLD_CURSOR;
  const clock = opts.clock ?? new BlockClock();
  if (!opts.clock || !clock.covers(fromBlock, toBlock)) await clock.seed(fromBlock, toBlock);
  let curves = opts.curves ?? curveMap(db);
  let quotes = opts.quotes ?? quoteMap(db);

  const stats: FoldStats = { logs: 0, folded: 0, unknown: 0, chunks: 0, toBlock: fromBlock - 1 };
  let cursor = fromBlock;
  let chunk = maxChunk;
  let successes = 0;
  let failures = 0;

  while (cursor <= toBlock) {
    const to = Math.min(toBlock, cursor + chunk - 1);
    let batch: RawLog[];
    try {
      batch = await getLogs({ topics: [[TOPIC.curveBuy, TOPIC.curveSell]] }, cursor, to);
    } catch (e) {
      failures++;
      opts.onChunk?.(cursor, stats);
      const msg = (e as Error).message.slice(0, 80);
      if (failures >= FOLD_MAX_FAILURES) throw new Error(`fold gave up at ${cursor.toLocaleString()} after ${failures} failed reads: ${msg}`);
      if (isRangeError(e) && chunk > minChunk) {
        chunk = Math.max(minChunk, Math.floor(chunk / 2)); successes = 0;
        console.log(`  ${cursor.toLocaleString()}: ${msg}; narrowing to ${chunk} blocks`);
        continue;
      }
      if (!isRangeError(e) && failures >= 2) throw e;
      console.log(`  ${cursor.toLocaleString()}: ${msg}`);
      await sleep(CFG.logsSpacingMs * 4);
      continue;
    }
    failures = 0;

    // Timestamps first, outside the transaction: the clock may need a block header.
    const tsOf = new Map<number, number>();
    for (const b of new Set(batch.map((l) => hexNum(l.blockNumber)))) tsOf.set(b, await clock.at(b));

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const l of batch) {
        const t = decodeTrade(l, curves, quotes, tsOf.get(hexNum(l.blockNumber)) ?? 0);
        if (!t) { stats.unknown++; continue; }
        stats.logs++;
        const r = applyTrade(db, t);
        stats.folded++;
        if (opts.onTrade) {
          // A synchronous hook keeps the whole transaction on one tick: nothing else on the event
          // loop (the factory batch, an enrichment save) can open its own transaction inside it.
          const p = opts.onTrade(t, r);
          if (p) await p;
        }
      }
      if (opts.checkpoint !== false) setMeta(db, cursorKey, String(to));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    stats.chunks++;
    stats.toBlock = to;
    cursor = to + 1;
    // Creep back toward the full width, but only after a run of clean reads. Widening after every
    // success means the next chunk trips the endpoint's ten-thousand-log cap again and is read
    // twice, which on a busy stretch of chain is half of all reads wasted.
    successes++;
    if (chunk < maxChunk && successes >= WIDEN_AFTER) { chunk = Math.min(maxChunk, chunk * 2); successes = 0; }
    if (!opts.curves && stats.chunks % 25 === 0) { curves = curveMap(db); quotes = quoteMap(db); }
    opts.onChunk?.(to, stats);
    if (opts.once) break;
    await sleep(CFG.logsSpacingMs);
  }
  return stats;
}

/** The stored cursor, or null before the first run. */
export function foldCursor(db: DB): number | null {
  const v = Number(getMeta(db, FOLD_CURSOR) ?? NaN);
  return Number.isFinite(v) ? v : null;
}

export async function chainHead(): Promise<number> {
  return Number(await withRetry(() => logsClient.getBlockNumber()));
}
