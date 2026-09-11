import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { ADDR, CFG, ZERO_ADDRESS } from "./config.ts";
import { getLogs, hexNum, sleep, stateClient, withRetry, type RawLog } from "./chain.ts";
import { resolveQuote } from "../quote.ts";
import type { DB } from "../db.ts";

/**
 * What a token does after it leaves the curve: v4 pool swaps.
 *
 * Every pool on the chain lives inside one singleton, so a single log stream carries every graduated
 * token at once, and each `Swap` carries `sqrtPriceX96`. Most of the chain's trading happens here:
 * measured in one 5-minute window, 2,607 curve trades against 6,147 pool swaps.
 */

export const TOPIC_POOL_INIT = toEventSelector(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
export const TOPIC_POOL_SWAP = toEventSelector(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);

export const initAbi = [{
  type: "event", name: "Initialize", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
  ],
}] as const;

export const swapAbi = [{
  type: "event", name: "Swap", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128" },
    { name: "amount1", type: "int128" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "liquidity", type: "uint128" },
    { name: "tick", type: "int24" },
    { name: "fee", type: "uint24" },
  ],
}] as const;

const Q96 = 2 ** 96;
const TOKEN_DECIMALS = 18;

export type PoolRow = {
  token: string; pool_id: string; currency0: string; currency1: string;
  token_is_c1: number; dec0: number; dec1: number; init_block: number; init_sqrt: string;
  /** The other side of the pair. Kept here because a pool outlives the launch record. */
  quote_token: string;
  /** Read from the token contract for pools whose launch we never indexed; null until then. */
  symbol: string | null;
};

export type PoolSwap = {
  poolId: string; sender: string; amount0: bigint; amount1: bigint;
  sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number; block: number; tx: string; logIndex: number;
};

/**
 * A decoded Swap log, or null for anything else.
 *
 * `amount0`/`amount1` are a BalanceDelta from the swapper's side: negative is what the swapper paid
 * in, positive what it took out. Proved on live swaps, see the header of src/poolfold.ts.
 * `sender` is whatever contract called the PoolManager, which is a router, not the trader.
 */
export function decodeSwap(l: RawLog): PoolSwap | null {
  if (l.topics[0] !== TOPIC_POOL_SWAP) return null;
  try {
    const a = decodeEventLog({ abi: swapAbi, topics: l.topics, data: l.data }).args;
    return {
      poolId: a.id, sender: a.sender.toLowerCase(), amount0: a.amount0, amount1: a.amount1,
      sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: Number(a.tick), fee: Number(a.fee),
      block: hexNum(l.blockNumber), tx: l.transactionHash, logIndex: hexNum(l.logIndex),
    };
  } catch {
    return null;
  }
}

const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/**
 * True when an address is something a token is priced in rather than a launched token: native ETH,
 * WETH, or a quote asset some launch already used (quote_assets, filled by src/quote.ts).
 */
export function isKnownQuote(db: DB, address: string): boolean {
  const a = address.toLowerCase();
  if (a === ZERO_ADDRESS || a === ADDR.weth.toLowerCase()) return true;
  return db.prepare("SELECT 1 x FROM quote_assets WHERE address = ?").get(a) !== undefined;
}

export type PoolSweepStats = {
  /** Initialize logs read, of every hook. */
  logs: number;
  /** Pons-hooked pools seen. */
  found: number;
  /** Of those: written or refreshed, resolved through a launches row, resolved without one. */
  saved: number;
  withLaunch: number;
  withoutLaunch: number;
  /** Neither side looked like a quote asset (or both did) and no launches row broke the tie. */
  ambiguous: number;
  /** The pool's quote is not what the launch record says the curve was priced in. */
  quoteMismatch: number;
  chunks: number;
  toBlock: number;
};

export type PoolSweepOptions = {
  /** Initialize logs are rare (about 17 Pons pools per 100,000 blocks), so ranges are wide. */
  chunk?: number;
  onChunk?: (upTo: number, s: PoolSweepStats) => void;
  /** Gap between reads; the official endpoint wants CFG.logsSpacingMs. */
  spacingMs?: number;
  /** Symbol and decimals of a quote asset. Defaults to quote.resolveQuote, cached in quote_assets. */
  quoteDecimals?: (address: string) => Promise<number>;
  /** Decimals of tokens with no launches row. Defaults to one Multicall3 read per chunk. */
  tokenDecimals?: (addresses: string[]) => Promise<Map<string, number>>;
  /** Injectable log read, so the sweep is testable without the chain. */
  readLogs?: (from: number, to: number) => Promise<RawLog[]>;
};

/** An eth_getLogs refusal a narrower range gets past (fold.isRangeError, without the import cycle). */
const isPoolRangeError = (err: unknown): boolean =>
  /exceeds limit|more than \d+ results|too many|timed out|timeout|invalid parameters|response size|block range/i
    .test(String((err as Error)?.message ?? err));

/** decimals() for a batch of tokens through Multicall3 on the state endpoint; 18 where the read fails. */
async function readTokenDecimals(addresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!addresses.length) return out;
  try {
    const res = await withRetry(() => stateClient.multicall({
      contracts: addresses.map((a) => ({ address: a as `0x${string}`, abi: erc20, functionName: "decimals" } as const)),
      allowFailure: true,
    }));
    res.forEach((r, i) => {
      if (r.status === "success" && Number.isFinite(Number(r.result))) out.set(addresses[i], Number(r.result));
    });
  } catch {
    // A failed batch leaves every token on the 18-decimal default rather than losing the pool.
  }
  return out;
}

/**
 * Every Pons pool opened in a block range, found in one sweep of the singleton's Initialize logs.
 *
 * Which side of the pair is the launched token is decided by what the *other* side is: the quote is
 * native ETH, WETH or a quote asset the database already knows, and the remaining currency is the
 * token. That works for a token that graduated before the launches backfill reaches back, which is
 * exactly the case the curve fold cannot see. When both sides or neither look like a quote asset the
 * launches row breaks the tie, and a pool with no tie-breaker is skipped and counted as ambiguous
 * rather than guessed at: a pool recorded the wrong way round would invert every price in it.
 */
export async function resolvePoolsSweep(
  db: DB,
  fromBlock: number,
  toBlock: number,
  opts: PoolSweepOptions = {},
): Promise<PoolSweepStats> {
  const chunk = Math.max(1, opts.chunk ?? 100_000);
  const spacing = opts.spacingMs ?? CFG.logsSpacingMs;
  const quoteDecimals = opts.quoteDecimals ?? (async (a: string) => (await resolveQuote(db, a)).decimals);
  const tokenDecimals = opts.tokenDecimals ?? readTokenDecimals;
  const readLogs = opts.readLogs
    ?? ((from: number, to: number) => getLogs({ address: ADDR.v4PoolManager, topics: [TOPIC_POOL_INIT] }, from, to));

  const launch = db.prepare("SELECT token, pair_token FROM launches WHERE token = ?");
  // Fills a column that was empty, never blanks one that is not: a sweep that runs before the
  // quote asset is known writes '', and a later one puts the real address in.
  const ins = db.prepare(`
    INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token, symbol)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(token) DO UPDATE SET
      quote_token = CASE WHEN excluded.quote_token != '' THEN excluded.quote_token ELSE pools.quote_token END,
      dec0        = CASE WHEN excluded.pool_id = pools.pool_id THEN excluded.dec0 ELSE pools.dec0 END,
      dec1        = CASE WHEN excluded.pool_id = pools.pool_id THEN excluded.dec1 ELSE pools.dec1 END`);

  const s: PoolSweepStats = {
    logs: 0, found: 0, saved: 0, withLaunch: 0, withoutLaunch: 0,
    ambiguous: 0, quoteMismatch: 0, chunks: 0, toBlock: fromBlock - 1,
  };

  let width = chunk;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + width - 1);
    let logs: RawLog[];
    try {
      logs = await readLogs(from, to);
    } catch (e) {
      // Initialize logs are rare, so a 100,000-block range is normally about 1,500 of them; a burst
      // that trips the 10,000 cap costs one wasted read rather than the whole sweep.
      if (isPoolRangeError(e) && width > 1000) {
        width = Math.floor(width / 2);
        console.log(`  ${from.toLocaleString()}: ${(e as Error).message.slice(0, 60)}; narrowing to ${width.toLocaleString()} blocks`);
        continue;
      }
      throw e;
    }
    if (width < chunk) width = Math.min(chunk, width * 2);
    s.chunks++;
    s.logs += logs.length;

    type Pending = {
      token: string; quote: string; id: string; c0: string; c1: string;
      isC1: number; block: number; sqrt: string; known: boolean;
    };
    const pending: Pending[] = [];

    for (const l of logs) {
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: initAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      if (String(a.hooks).toLowerCase() !== ADDR.hook.toLowerCase()) continue;
      s.found++;

      const c0 = String(a.currency0).toLowerCase();
      const c1 = String(a.currency1).toLowerCase();
      const row0 = launch.get(c0) as { token: string; pair_token: string } | undefined;
      const row1 = launch.get(c1) as { token: string; pair_token: string } | undefined;
      const q0 = isKnownQuote(db, c0);
      const q1 = isKnownQuote(db, c1);

      let isC1: number;
      if (q0 !== q1) isC1 = q0 ? 1 : 0;      // exactly one side is a quote asset: the other is the token
      else if (row1) isC1 = 1;               // both or neither: the launch record knows which is ours
      else if (row0) isC1 = 0;
      else { s.ambiguous++; continue; }

      const token = isC1 ? c1 : c0;
      const quote = isC1 ? c0 : c1;
      const launchRow = isC1 ? row1 : row0;
      if (launchRow) {
        s.withLaunch++;
        if (launchRow.pair_token !== quote) s.quoteMismatch++;
      } else {
        s.withoutLaunch++;
      }
      pending.push({
        token, quote, id: String(a.id), c0, c1, isC1,
        block: hexNum(l.blockNumber), sqrt: (a.sqrtPriceX96 as bigint).toString(), known: !!launchRow,
      });
    }

    if (!pending.length) {
      from = to + 1;
      s.toBlock = to;
      opts.onChunk?.(to, s);
      if (spacing > 0 && to < toBlock) await sleep(spacing);
      continue;
    }

    // Real decimals on both sides. Every Pons token mints 18, but a quote asset need not (USDG is 6),
    // and a token we never indexed is read from the chain rather than assumed.
    const quoteDec = new Map<string, number>();
    for (const q of new Set(pending.map((p) => p.quote))) quoteDec.set(q, await quoteDecimals(q));
    const unknownTokens = [...new Set(pending.filter((p) => !p.known).map((p) => p.token))];
    const tokenDec = await tokenDecimals(unknownTokens);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of pending) {
        const qd = quoteDec.get(p.quote) ?? TOKEN_DECIMALS;
        const td = p.known ? TOKEN_DECIMALS : (tokenDec.get(p.token) ?? TOKEN_DECIMALS);
        ins.run(
          p.token, p.id, p.c0, p.c1, p.isC1,
          p.isC1 ? qd : td, p.isC1 ? td : qd,
          p.block, p.sqrt, p.quote,
        );
        s.saved++;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    from = to + 1;
    s.toBlock = to;
    opts.onChunk?.(to, s);
    if (spacing > 0 && to < toBlock) await sleep(spacing);
  }
  return s;
}

/**
 * Reads `symbol()` for pools whose token never got a launches row, batched through Multicall3 on
 * the state endpoint. Without this a graduated token that predates the launches backfill prints as
 * a truncated address everywhere. A token that will not answer keeps its NULL for a later pass.
 */
export async function fillPoolSymbols(
  db: DB,
  limit = 1000,
  opts: { batch?: number; read?: (tokens: string[]) => Promise<Array<string | null>> } = {},
): Promise<{ pending: number; read: number; filled: number }> {
  const batch = Math.max(1, opts.batch ?? 50);
  const read = opts.read ?? (async (tokens: string[]): Promise<Array<string | null>> => {
    const res = await withRetry(() => stateClient.multicall({
      contracts: tokens.map((t) => ({ address: t as `0x${string}`, abi: erc20, functionName: "symbol" } as const)),
      allowFailure: true,
    }));
    return res.map((r) => (r.status === "success" ? String(r.result).slice(0, 32) || null : null));
  });

  const pending = (db.prepare(`
    SELECT count(*) c FROM pools
     WHERE symbol IS NULL AND token NOT IN (SELECT token FROM launches)`).get() as { c: number }).c;
  const rows = db.prepare(`
    SELECT token FROM pools
     WHERE symbol IS NULL AND token NOT IN (SELECT token FROM launches)
     ORDER BY init_block DESC LIMIT ?`).all(limit) as Array<{ token: string }>;

  const save = db.prepare("UPDATE pools SET symbol = ? WHERE token = ? AND symbol IS NULL");
  let filled = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch).map((r) => r.token);
    let symbols: Array<string | null>;
    try {
      symbols = await read(slice);
    } catch {
      continue; // a failed batch leaves those NULL; the next pass asks again
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      symbols.forEach((sym, j) => {
        if (sym) { save.run(sym, slice[j]); filled++; }
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return { pending, read: rows.length, filled };
}

/**
 * Whole quote units per whole token, from a pool price. `sqrtPriceX96` squares to currency1 per
 * currency0 in raw units, so the token's side decides whether the ratio is inverted.
 */
export function quotePerToken(sqrt: string | bigint, p: Pick<PoolRow, "token_is_c1" | "dec0" | "dec1">): number {
  const r = Number(sqrt) / Q96;
  const price = r * r;
  if (!(price > 0) || !Number.isFinite(price)) return 0;
  return p.token_is_c1 ? (1 / price) * 10 ** (p.dec1 - p.dec0) : price * 10 ** (p.dec0 - p.dec1);
}

/**
 * One pool's price extremes and last price, folded from a run of swaps.
 *
 * Shared so the two readers of the swap stream cannot drift apart: `indexPoolSwaps` sweeps prices
 * on their own, and `poolfold.foldPoolRange` writes the same rows as it attributes trades. Whoever
 * reads a bag's worth reads `last_sqrt` and needs it to be the last swap either of them saw.
 */
export type PeakEntry = { lo: bigint; hi: bigint; loB: number; hiB: number; last: bigint; lastB: number; n: number };

export function peaksStatement(db: DB): ReturnType<DB["prepare"]> {
  return db.prepare(`
    INSERT INTO pool_peaks (pool_id, min_sqrt, max_sqrt, min_block, max_block, last_sqrt, last_block, swaps, to_block)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool_id) DO UPDATE SET
      min_sqrt  = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_sqrt ELSE pool_peaks.min_sqrt END,
      min_block = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_block ELSE pool_peaks.min_block END,
      max_sqrt  = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_sqrt ELSE pool_peaks.max_sqrt END,
      max_block = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_block ELSE pool_peaks.max_block END,
      last_sqrt = excluded.last_sqrt,
      last_block = excluded.last_block,
      swaps     = pool_peaks.swaps + excluded.swaps,
      to_block  = excluded.to_block`);
}

/** Folds one swap into a per-pool aggregate, creating it on the first swap of the run. */
export function foldPeak(agg: Map<string, PeakEntry>, poolId: string, sqrt: bigint, block: number): void {
  const cur = agg.get(poolId);
  if (!cur) { agg.set(poolId, { lo: sqrt, hi: sqrt, loB: block, hiB: block, last: sqrt, lastB: block, n: 1 }); return; }
  if (sqrt < cur.lo) { cur.lo = sqrt; cur.loB = block; }
  if (sqrt > cur.hi) { cur.hi = sqrt; cur.hiB = block; }
  cur.last = sqrt; cur.lastB = block; cur.n++;
}

/** Writes a run's aggregates. `toBlock` is how far the caller has read, for the row's own cursor. */
export function writePeaks(stmt: ReturnType<DB["prepare"]>, agg: Map<string, PeakEntry>, toBlock: number): void {
  for (const [id, a] of agg) {
    stmt.run(id, a.lo.toString(), a.hi.toString(), a.loB, a.hiB, a.last.toString(), a.lastB, a.n, toBlock);
  }
}

/**
 * Reads pool swaps chain-wide and keeps only each known pool's extremes and last price.
 * Both ends are kept because the token is not always the same side of the pair.
 */
export async function indexPoolSwaps(
  db: DB, fromBlock: number, toBlock: number, chunk = 2000,
  onChunk?: (upTo: number, swaps: number) => void,
  spacingMs = 0,
  onSwap?: (swap: PoolSwap) => void | Promise<void>,
): Promise<{ swaps: number; matched: number; chunks: number }> {
  const known = new Set<string>(
    (db.prepare("SELECT pool_id FROM pools").all() as Array<{ pool_id: string }>).map((r) => r.pool_id),
  );
  if (!known.size) return { swaps: 0, matched: 0, chunks: 0 };

  const upsert = peaksStatement(db);

  let swaps = 0, matched = 0, chunks = 0;
  let from = fromBlock;
  let width = chunk;

  while (from <= toBlock) {
    const to = Math.min(toBlock, from + width - 1);
    let logs: RawLog[];
    try {
      logs = await withRetry(() => getLogs({ address: ADDR.v4PoolManager, topics: [TOPIC_POOL_SWAP] }, from, to));
    } catch (e) {
      // The endpoint caps a response at 10,000 logs; halving and retrying costs one wasted read.
      if (width > 125) { width = Math.floor(width / 2); continue; }
      throw e;
    }
    if (logs.length < 4000 && width < chunk) width = Math.min(chunk, width * 2);
    chunks++;
    swaps += logs.length;

    // Folded in memory first: one row per pool per chunk instead of one write per swap.
    const agg = new Map<string, { lo: bigint; hi: bigint; loB: number; hiB: number; last: bigint; lastB: number; n: number }>();
    for (const l of logs) {
      const id = l.topics[1];
      if (!id || !known.has(id)) continue;
      const s = decodeSwap(l);
      if (!s || s.sqrtPriceX96 <= 0n) continue;
      matched++;
      if (onSwap) await onSwap(s);
      const cur = agg.get(id);
      if (!cur) {
        agg.set(id, { lo: s.sqrtPriceX96, hi: s.sqrtPriceX96, loB: s.block, hiB: s.block, last: s.sqrtPriceX96, lastB: s.block, n: 1 });
        continue;
      }
      if (s.sqrtPriceX96 < cur.lo) { cur.lo = s.sqrtPriceX96; cur.loB = s.block; }
      if (s.sqrtPriceX96 > cur.hi) { cur.hi = s.sqrtPriceX96; cur.hiB = s.block; }
      cur.last = s.sqrtPriceX96; cur.lastB = s.block; cur.n++;
    }

    if (agg.size) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [id, v] of agg) {
          upsert.run(id, v.lo.toString(), v.hi.toString(), v.loB, v.hiB, v.last.toString(), v.lastB, v.n, to);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    from = to + 1;
    onChunk?.(to, swaps);
    if (spacingMs > 0) await sleep(spacingMs);
  }
  return { swaps, matched, chunks };
}

export type PoolPeaks = { poolId: string; peakPrice: number | null; lastPrice: number | null; peakBlock: number | null; swaps: number };

/** What a token reached in its pool, in whole quote per whole token, or null when unread. */
export function poolPeaks(db: DB, token: string): PoolPeaks | null {
  const p = db.prepare("SELECT * FROM pools WHERE token = ?").get(token.toLowerCase()) as PoolRow | undefined;
  if (!p) return null;
  const k = db.prepare("SELECT * FROM pool_peaks WHERE pool_id = ?").get(p.pool_id) as
    | { min_sqrt: string; max_sqrt: string; min_block: number; max_block: number; last_sqrt: string; swaps: number }
    | undefined;
  // The token's price peaks where its own side of the pair is dearest.
  const peakSqrt = k ? (p.token_is_c1 ? k.min_sqrt : k.max_sqrt) : null;
  const open = quotePerToken(p.init_sqrt, p);
  const peak = peakSqrt ? quotePerToken(peakSqrt, p) : null;
  return {
    poolId: p.pool_id,
    peakPrice: Math.max(open, peak ?? 0) || null,
    lastPrice: k ? quotePerToken(k.last_sqrt, p) : open,
    peakBlock: k ? (p.token_is_c1 ? k.min_block : k.max_block) : null,
    swaps: k?.swaps ?? 0,
  };
}
