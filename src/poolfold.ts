import { BlockClock } from "./chain/blockclock.ts";
import { toEventSelector } from "viem";
import { getLogs, hexNum, sleep, withRetry, type RawLog } from "./chain/chain.ts";
import { ADDR, CFG } from "./chain/config.ts";
import { decodeSwap, foldPeak, peaksStatement, TOPIC_POOL_SWAP, writePeaks, type PeakEntry, type PoolSwap } from "./chain/pool.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import { applyTrade, isRangeError, FOLD_MAX_FAILURES, FOLD_MIN_CHUNK, WIDEN_AFTER, type Applied, type DecodedTrade } from "./fold.ts";

/**
 * Uniswap v4 pool swaps folded into the same per-wallet positions the curve trades use.
 *
 * Seventy per cent of the chain's trading happens after a token graduates (measured over five
 * minutes: 2,607 curve trades against 6,147 pool swaps), so a trader who only touches graduated
 * tokens is invisible to fold.ts. Every pool lives inside one PoolManager singleton, so one log
 * stream carries all of them; a swap on a pool we have no row for is skipped, not guessed at.
 *
 * ## Two things the event does not say, and how they are settled
 *
 * **Who traded.** `Swap.sender` is the contract that called the PoolManager, which is a router:
 * 0x8876789976decbfcbbbe364623c63652db8c0904 is one, with 1,840 swaps in 2,000 blocks, code on
 * chain and nonce 1, called by dozens of different EOAs. The trader is the transaction's `from`,
 * resolved with batched eth_getTransactionByHash. A transaction whose `from` cannot be read is
 * skipped and counted; attributing it to the router would credit one address with everyone's
 * trades.
 *
 * **Which way the value moved.** `amount0`/`amount1` are a v4 BalanceDelta and the sign is the
 * whole product: get it backwards and every trader's profit and loss inverts. The rule, verified
 * rather than assumed:
 *
 *     negative = the trader paid that currency in;  positive = the trader took that currency out.
 *
 * Checked two ways on live swaps of Pons pools, at head on 10 September 2026.
 *
 * 1. Against the trader's own ERC-20 transfers in the same transaction.
 *    tx 0x9a93b2d93fb1706960142822476c3f0932a6f7fc4d66a8fe93096e44fb876eba, pool
 *    0x672b02…a8aa (currency0 NVDA 0xd0601ce1…, currency1 the token 0xecc77a43…):
 *    amount0 = +633043482516878987, amount1 = −594787523735785004623119. The receipt shows the
 *    token moving 0x9b1fcc…7bbb (the transaction's from) → PoolManager, 594787523735785004623119,
 *    exactly |amount1|: the negative side is what the trader paid. The positive side comes back out
 *    of the PoolManager as 18991304475506368 to the hook plus 614052178041372619 to the router,
 *    summing to exactly amount0. So a negative token amount is a sell, and it was.
 *    The mirror case, tx 0x8fb09a53720b2e4123bbef46a7f4c944edac70a7eea91e9394469b150b9ef541
 *    (currency0 native ETH, currency1 the token 0xac79255f…): amount0 = −19870200000000000,
 *    amount1 = +167875792202838100403198, and the token leaves the PoolManager (4196894805070952510078
 *    to the hook, 163678897397767147893120 onward to the trader, together exactly amount1) while the
 *    trader's ETH goes in. A positive token amount is a buy, and it was.
 *
 * 2. Against sqrtPriceX96 across consecutive swaps on one pool. sqrtPriceX96 rises when currency1
 *    gets cheaper in currency0. On pool 0x672b02…a8aa four swaps in a row with amount1 negative
 *    (the token paid in, i.e. sells) moved it 76525270722318171883857896570380 →
 *    76541615401431897931964741590250 → 77053053184188198887492889624631 →
 *    77564490966944499843021037659012, up every time. Selling the token made the token cheaper, so
 *    "amount1 negative means the trader sold currency1" is the reading that agrees with the price.
 *
 * One nuance the amounts carry and we keep: the Pons hook takes its cut out of the *output* leg
 * inside the swap (2.5% of it in the ETH pool above, 3.0% in the NVDA one, matching the 1% curve fee
 * plus the creator tax), so the positive amount is gross and the trader nets slightly less. The
 * curve fold has the same shape (CurveBuy's `quoteIn` is what the buyer paid, fee included), so
 * positions stay consistent across the two sources; the hook's cut is a fee, not a price.
 */

/** A pool as the fold needs it: which side is the token and how each side scales. */
export type PoolInfo = {
  poolId: string;
  token: string;
  /** The other side of the pair. Zero address for native ETH. */
  quote: string;
  tokenIsC1: boolean;
  decToken: number;
  decQuote: number;
};

/**
 * pool id → pool, from the pools table. Held in memory: one lookup per swap log would be the
 * bottleneck, and the swap stream is thousands of logs per 2,000 blocks.
 */
export function poolMap(db: DB): Map<string, PoolInfo> {
  const m = new Map<string, PoolInfo>();
  const rows = db.prepare(
    "SELECT token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, quote_token FROM pools",
  ).all() as Array<{
    token: string; pool_id: string; currency0: string; currency1: string;
    token_is_c1: number; dec0: number; dec1: number; quote_token: string;
  }>;
  for (const r of rows) {
    const tokenIsC1 = r.token_is_c1 === 1;
    m.set(r.pool_id, {
      poolId: r.pool_id,
      token: r.token.toLowerCase(),
      // quote_token is the pool's own copy; an old row that predates the column falls back to
      // whichever currency is not the token.
      quote: (r.quote_token || (tokenIsC1 ? r.currency0 : r.currency1)).toLowerCase(),
      tokenIsC1,
      decToken: tokenIsC1 ? r.dec1 : r.dec0,
      decQuote: tokenIsC1 ? r.dec0 : r.dec1,
    });
  }
  return m;
}

/** Whole units from a signed raw amount. */
const whole = (raw: bigint, decimals: number): number => Math.abs(Number(raw)) / 10 ** decimals;

/**
 * One swap as a trade, or null when it says nothing (a zero leg, or both legs pointing the same
 * way, which a real swap never does). `wallet` is the transaction's sender, never `swap.sender`.
 */
export function poolTrade(s: PoolSwap, p: PoolInfo, wallet: string, ts: number): DecodedTrade | null {
  const rawToken = p.tokenIsC1 ? s.amount1 : s.amount0;
  const rawQuote = p.tokenIsC1 ? s.amount0 : s.amount1;
  if (rawToken === 0n || rawQuote === 0n) return null;
  // Negative is paid in, positive is taken out: the two legs always disagree in sign.
  if (rawToken > 0n === rawQuote > 0n) return null;

  const tokens = whole(rawToken, p.decToken);
  const quote = whole(rawQuote, p.decQuote);
  if (!Number.isFinite(tokens) || !Number.isFinite(quote)) return null;

  return {
    wallet: wallet.toLowerCase(),
    token: p.token,
    // The trader took tokens out: a buy. Tokens went in: a sell.
    side: rawToken > 0n ? "buy" : "sell",
    quote,
    tokens,
    ts,
    block: s.block,
    tx: s.tx,
    logIndex: s.logIndex,
    pair: p.quote,
    quoteWei: rawQuote < 0n ? -rawQuote : rawQuote,
    tokensWei: rawToken < 0n ? -rawToken : rawToken,
    // The hook's cut is inside the amounts, not beside them; the curve's fee and tax fields have
    // no counterpart here.
    fee: 0n,
    tax: 0n,
  };
}

/** The cursor and window of the pool fold, kept apart from the curve fold's own. */
export const POOL_CURSOR = "pool_to_block";
export const POOL_WINDOW_START = "pool_from_block";
/** The Initialize sweep's cursor, so a rerun of `pools --init` picks up where it stopped. */
export const POOL_INIT_CURSOR = "pool_init_to_block";

/** 4,656 swaps per 2,000 blocks measured; the endpoint caps a response at 10,000 logs. */
export const POOL_CHUNK = 2000;
/** The endpoint accepts a JSON-RPC batch of 100 (200 answers 429). */
export const TX_BATCH = 100;

/**
 * Sender batches in flight at once, on an endpoint that wants no spacing.
 *
 * The log stream is one read per chunk; the senders behind it are about 3,700 distinct
 * transactions per 2,000 blocks, so 37 batches of 100. Sequentially that is 37 round trips for
 * every one spent on the logs, and the backfill runs at the speed of the round trip rather than
 * the speed of the chain. Four lanes cut it without asking the endpoint for more per second than
 * a single lane of the official RPC already refuses.
 */
export const TX_LANES = Math.max(1, Number(process.env.TX_LANES) || 4);

/**
 * ERC-4337 EntryPoints on this chain (docs.robinhood.com/chain/account-abstraction, v0.6/0.7/0.8).
 *
 * A transaction sent to one of these is a bundle: `from` is the bundler, which is no more the
 * trader than the router in `Swap.sender` is. Measured at head on 11 September 2026, 8 of 120
 * sampled swap transactions went to an EntryPoint, so leaving it alone would hand a bundler a few
 * per cent of the chain's trades and put it at the top of the Hall of Rekt. The real account is the
 * `sender` of the UserOperationEvent that closes each operation in the bundle.
 */
export const ENTRYPOINTS: ReadonlySet<string> = new Set([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
  "0x0000000071727de22e5e9d8baf0edac6f37da032",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
]);

/** UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, ...) */
export const TOPIC_USER_OP = toEventSelector(
  "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
);

/** One operation in a bundle: the account that signed it, and where its logs stop. */
export type UserOp = { logIndex: number; sender: string };

export type PoolFoldStats = {
  /** Swap logs read. */
  logs: number;
  /** Of those, on a pool we have a row for. */
  matched: number;
  /** On a pool we do not know. */
  unknown: number;
  /** Folded into a position. */
  folded: number;
  /** Skipped because the transaction's sender could not be read: never attributed to the router. */
  unresolved: number;
  /** Attributed to a smart account rather than to the bundler that carried its operation. */
  smartAccount: number;
  /** Skipped because the amounts made no sense (a zero leg, both legs the same sign). */
  odd: number;
  /** Distinct transactions resolved. */
  txs: number;
  chunks: number;
  toBlock: number;
};

export type PoolFoldOptions = {
  chunk?: number;
  /** Called once per trade after it is folded, inside the chunk's transaction. */
  onTrade?: (t: DecodedTrade, r: Applied) => void | Promise<void>;
  onChunk?: (to: number, stats: PoolFoldStats) => void;
  /** Stop after the first chunk. */
  once?: boolean;
  /** Update the cursor in meta after every chunk (default true). */
  checkpoint?: boolean;
  /** The meta key the checkpoint goes to (default pool_to_block). */
  cursorKey?: string;
  /** A pool map the caller keeps fresh; without one it is read at the start and every 25 chunks. */
  pools?: Map<string, PoolInfo>;
  /** A shared block clock; when given, seeding is skipped for ranges its anchors already bracket. */
  clock?: BlockClock;
  /** Injectable log read, so tests never touch the chain. */
  readLogs?: (from: number, to: number) => Promise<RawLog[]>;
  /** Injectable sender resolver: transaction hash → from. A hash it leaves out counts as unresolved. */
  senders?: (hashes: string[]) => Promise<Map<string, string>>;
  /** Injectable bundle resolver: transaction hash → the operations it carried, in log order. */
  userOps?: (hashes: string[]) => Promise<Map<string, UserOp[]>>;
  /** Where the batched eth_getTransactionByHash goes; the state endpoint by default (resolveSenders). */
  txRpcUrl?: string;
  /** Gap between reads (default CFG.logsSpacingMs). */
  spacingMs?: number;
};

type BatchReply = Array<{ id: number; result?: { from?: string; to?: string | null } | null; error?: { message?: string } }>;
type ReceiptReply = Array<{ id: number; result?: { logs?: Array<{ address: string; topics: string[]; logIndex: string }> } | null }>;

/** The gap a batch endpoint wants: the official RPC counts every call against its budget. */
export const senderSpacingFor = (url: string): number => (url === CFG.logsUrl ? CFG.logsSpacingMs : 0);

/** One JSON-RPC batch of eth_getTransactionByHash. Throws, so withRetry and the fallback can act. */
async function senderBatch(url: string, hashes: string[]): Promise<BatchReply> {
  const body = hashes.map((h, j) => ({ jsonrpc: "2.0", id: j, method: "eth_getTransactionByHash", params: [h] }));
  return withRetry(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "rekt/0.1 (+https://rekt.report)" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`batch of ${hashes.length}: HTTP ${res.status} ${res.statusText}`);
    const json = await res.json() as unknown;
    if (!Array.isArray(json)) throw new Error(`batch of ${hashes.length}: reply is not an array`);
    return json as BatchReply;
  });
}

/**
 * `from` for a list of transaction hashes, in JSON-RPC batches of at most 100 (a batch of 200 is
 * refused with 429 on both endpoints).
 *
 * Which endpoint: measured on 10 September 2026 with the same batch of 100 hashes, the official RPC
 * answered in 143 ms when nothing else was running and 429 while the same process was reading logs,
 * so a fold that resolves senders there spends its run backing off and loses whole batches of
 * traders. publicnode answered in 108 ms with 100 of 100 resolved, and does so for transactions a
 * month old too: a hash lookup is an index read, not the archive state it refuses. So the sender
 * lookup goes to the state endpoint and the logs endpoint's budget stays with eth_getLogs, the same
 * split enrich.ts uses for launch transactions. `url` moves it back if that ever stops holding.
 *
 * A batch the primary endpoint refuses is retried once on the other one. A hash still without an
 * answer is left out of the map, and the caller drops that swap rather than crediting the router.
 */
export async function resolveSenders(
  hashes: string[],
  opts: { url?: string; fallbackUrl?: string; batch?: number; spacingMs?: number; lanes?: number; collectTo?: Map<string, string> } = {},
): Promise<Map<string, string>> {
  const url = opts.url ?? CFG.stateUrl;
  const fallback = opts.fallbackUrl ?? (url === CFG.logsUrl ? CFG.stateUrl : CFG.logsUrl);
  const size = Math.max(1, Math.min(TX_BATCH, opts.batch ?? TX_BATCH));
  const spacing = opts.spacingMs ?? senderSpacingFor(url);
  const lanes = Math.max(1, opts.lanes ?? (spacing > 0 ? 1 : TX_LANES));
  const out = new Map<string, string>();

  const slices: string[][] = [];
  for (let i = 0; i < hashes.length; i += size) slices.push(hashes.slice(i, i + size));

  const runSlice = async (slice: string[]): Promise<void> => {
    let reply: BatchReply | null = null;
    try {
      reply = await senderBatch(url, slice);
    } catch {
      try {
        await sleep(senderSpacingFor(fallback));
        reply = await senderBatch(fallback, slice);
      } catch {
        // Every hash in this batch stays unresolved; foldPoolRange counts and skips those swaps
        // rather than crediting the router with them.
        reply = null;
      }
    }
    for (const r of reply ?? []) {
      const h = slice[r.id];
      const from = r.result?.from;
      if (h && typeof from === "string") out.set(h, from.toLowerCase());
      const to = r.result?.to;
      if (h && opts.collectTo && typeof to === "string") opts.collectTo.set(h, to.toLowerCase());
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= slices.length) return;
      await runSlice(slices[i]);
      if (spacing > 0) await sleep(spacing);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, slices.length) }, worker));
  return out;
}

/**
 * The accounts behind the operations in a bundle, per transaction, in log order.
 *
 * Only called for transactions sent to an EntryPoint. A bundle carries several operations, each
 * emitting its own logs and then a UserOperationEvent naming the account that signed it, so a swap
 * belongs to the first UserOperationEvent that follows it. Receipts are read in the same batches
 * and on the same endpoint as the sender lookup.
 */
export async function resolveUserOps(
  hashes: string[],
  opts: { url?: string; fallbackUrl?: string; batch?: number; spacingMs?: number; lanes?: number } = {},
): Promise<Map<string, UserOp[]>> {
  const url = opts.url ?? CFG.stateUrl;
  const fallback = opts.fallbackUrl ?? (url === CFG.logsUrl ? CFG.stateUrl : CFG.logsUrl);
  const size = Math.max(1, Math.min(TX_BATCH, opts.batch ?? TX_BATCH));
  const spacing = opts.spacingMs ?? senderSpacingFor(url);
  const lanes = Math.max(1, opts.lanes ?? (spacing > 0 ? 1 : TX_LANES));
  const out = new Map<string, UserOp[]>();

  const receipts = async (endpoint: string, slice: string[]): Promise<ReceiptReply> => {
    const body = slice.map((h, j) => ({ jsonrpc: "2.0", id: j, method: "eth_getTransactionReceipt", params: [h] }));
    return withRetry(async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "rekt/0.1 (+https://rekt.report)" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`receipts batch of ${slice.length}: HTTP ${res.status} ${res.statusText}`);
      const json = await res.json() as unknown;
      if (!Array.isArray(json)) throw new Error(`receipts batch of ${slice.length}: reply is not an array`);
      return json as ReceiptReply;
    });
  };

  const slices: string[][] = [];
  for (let i = 0; i < hashes.length; i += size) slices.push(hashes.slice(i, i + size));

  const runSlice = async (slice: string[]): Promise<void> => {
    let reply: ReceiptReply | null = null;
    try {
      reply = await receipts(url, slice);
    } catch {
      try {
        await sleep(senderSpacingFor(fallback));
        reply = await receipts(fallback, slice);
      } catch {
        reply = null;
      }
    }
    for (const r of reply ?? []) {
      const h = slice[r.id];
      if (!h) continue;
      const ops: UserOp[] = [];
      for (const l of r.result?.logs ?? []) {
        if (l.topics?.[0] !== TOPIC_USER_OP || !ENTRYPOINTS.has(String(l.address).toLowerCase())) continue;
        const sender = l.topics[2];
        if (!sender) continue;
        ops.push({ logIndex: hexNum(l.logIndex), sender: ("0x" + sender.slice(-40)).toLowerCase() });
      }
      if (ops.length) out.set(h, ops.sort((a, b) => a.logIndex - b.logIndex));
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= slices.length) return;
      await runSlice(slices[i]);
      if (spacing > 0) await sleep(spacing);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, slices.length) }, worker));
  return out;
}

/** The account whose operation a log at `logIndex` belongs to: the first one that closes after it. */
export function opSenderFor(ops: UserOp[], logIndex: number): string | null {
  for (const o of ops) if (o.logIndex > logIndex) return o.sender;
  return null;
}

/**
 * Reads every v4 Swap on the chain between two blocks, keeps the ones on pools we know, resolves
 * each transaction's sender, and folds them into trader_positions through fold.applyTrade — the
 * same positions, the same `onTrade` hook and the same guarantees as fold.foldRange: adaptive
 * chunking that halves on a range refusal and creeps back up, one transaction per chunk, a cursor
 * checkpoint in meta after each chunk, spacing between reads, and a consecutive-failure limit so a
 * stuck range throws instead of spinning.
 *
 * The cursor lives under its own key (pool_to_block), so this never disturbs the curve fold.
 */
export async function foldPoolRange(
  db: DB,
  fromBlock: number,
  toBlock: number,
  opts: PoolFoldOptions = {},
): Promise<PoolFoldStats> {
  const maxChunk = Math.max(1, Math.min(POOL_CHUNK, opts.chunk ?? POOL_CHUNK));
  const minChunk = Math.min(FOLD_MIN_CHUNK, maxChunk);
  const cursorKey = opts.cursorKey ?? POOL_CURSOR;
  const spacing = opts.spacingMs ?? CFG.logsSpacingMs;
  const clock = opts.clock ?? new BlockClock();
  if (!opts.clock || !clock.covers(fromBlock, toBlock)) await clock.seed(fromBlock, toBlock);
  const readLogs = opts.readLogs
    ?? ((from: number, to: number) => getLogs({ address: ADDR.v4PoolManager, topics: [TOPIC_POOL_SWAP] }, from, to));
  // `to` per transaction comes back with the sender lookup and costs nothing extra; it is only
  // read to spot a bundle, so an injected resolver (the tests) simply leaves it empty.
  const targets = new Map<string, string>();
  const senders = opts.senders ?? ((hashes: string[]) => resolveSenders(hashes, { url: opts.txRpcUrl, collectTo: targets }));
  const userOps = opts.userOps ?? ((hashes: string[]) => resolveUserOps(hashes, { url: opts.txRpcUrl }));
  let pools = opts.pools ?? poolMap(db);
  const peaksStmt = peaksStatement(db);

  const stats: PoolFoldStats = {
    logs: 0, matched: 0, unknown: 0, folded: 0, unresolved: 0, smartAccount: 0, odd: 0, txs: 0, chunks: 0, toBlock: fromBlock - 1,
  };
  let cursor = fromBlock;
  let chunk = maxChunk;
  let successes = 0;
  let failures = 0;

  while (cursor <= toBlock) {
    const to = Math.min(toBlock, cursor + chunk - 1);
    let batch: RawLog[];
    try {
      batch = await readLogs(cursor, to);
    } catch (e) {
      failures++;
      opts.onChunk?.(cursor, stats);
      const msg = (e as Error).message.slice(0, 80);
      if (failures >= FOLD_MAX_FAILURES) throw new Error(`pool fold gave up at ${cursor.toLocaleString()} after ${failures} failed reads: ${msg}`);
      if (isRangeError(e) && chunk > minChunk) {
        chunk = Math.max(minChunk, Math.floor(chunk / 2)); successes = 0;
        console.log(`  ${cursor.toLocaleString()}: ${msg}; narrowing to ${chunk} blocks`);
        continue;
      }
      if (!isRangeError(e) && failures >= 2) throw e;
      console.log(`  ${cursor.toLocaleString()}: ${msg}`);
      await sleep(spacing * 4);
      continue;
    }
    failures = 0;
    stats.logs += batch.length;

    // Only the swaps on pools we know reach the network calls below: the chain's other pools are
    // most of the stream and none of our business.
    const mine: PoolSwap[] = [];
    for (const l of batch) {
      const id = l.topics[1];
      if (!id || !pools.has(id)) { stats.unknown++; continue; }
      const s = decodeSwap(l);
      if (!s) { stats.unknown++; continue; }
      mine.push(s);
      stats.matched++;
    }

    // Everything that needs the network happens before the transaction opens: block times and,
    // per chunk, one sender lookup for each distinct transaction hash.
    const tsOf = new Map<number, number>();
    for (const b of new Set(mine.map((s) => s.block))) tsOf.set(b, await clock.at(b));
    const hashes = [...new Set(mine.map((s) => s.tx))];
    targets.clear();
    const from = hashes.length ? await senders(hashes) : new Map<string, string>();
    stats.txs += from.size;
    // A transaction sent to an EntryPoint is a bundle: its `from` is the bundler, so the accounts
    // are read out of the operations instead. Only those transactions cost a receipt.
    const bundles = hashes.filter((h) => ENTRYPOINTS.has(targets.get(h) ?? ""));
    const ops = bundles.length ? await userOps(bundles) : new Map<string, UserOp[]>();

    if (mine.length) {
      // The pool's own price, kept as the swaps go by: a bag still held is marked at last_sqrt,
      // and without this it would be marked at the price the token graduated at, days stale.
      const peaks = new Map<string, PeakEntry>();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of mine) {
          if (s.sqrtPriceX96 > 0n) foldPeak(peaks, s.poolId, s.sqrtPriceX96, s.block);
          const bundle = ops.get(s.tx);
          // In a bundle the account that signed the operation this swap belongs to; everywhere else
          // the transaction's own sender. A bundled swap we cannot place is skipped rather than
          // credited to the bundler, the same rule the router gets.
          const wallet = bundle ? opSenderFor(bundle, s.logIndex) : from.get(s.tx);
          if (!wallet) { stats.unresolved++; continue; }
          if (bundle) stats.smartAccount++;
          const t = poolTrade(s, pools.get(s.poolId) as PoolInfo, wallet, tsOf.get(s.block) ?? 0);
          if (!t) { stats.odd++; continue; }
          const r = applyTrade(db, t);
          stats.folded++;
          if (opts.onTrade) {
            // Synchronous hooks keep the whole transaction on one tick, as foldRange does.
            const p = opts.onTrade(t, r);
            if (p) await p;
          }
        }
        writePeaks(peaksStmt, peaks, to);
        if (opts.checkpoint !== false) setMeta(db, cursorKey, String(to));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } else if (opts.checkpoint !== false) {
      setMeta(db, cursorKey, String(to));
    }

    stats.chunks++;
    stats.toBlock = to;
    cursor = to + 1;
    // Creep back toward the full width, but only after a run of clean reads. Widening after every
    // success means the next chunk trips the endpoint's ten-thousand-log cap again and is read
    // twice, which on a busy stretch of chain is half of all reads wasted.
    successes++;
    if (chunk < maxChunk && successes >= WIDEN_AFTER) { chunk = Math.min(maxChunk, chunk * 2); successes = 0; }
    if (!opts.pools && stats.chunks % 25 === 0) pools = poolMap(db);
    opts.onChunk?.(to, stats);
    if (opts.once) break;
    if (spacing > 0) await sleep(spacing);
  }
  return stats;
}

/** The stored pool cursor, or null before the first run. */
export function poolFoldCursor(db: DB): number | null {
  const v = Number(getMeta(db, POOL_CURSOR) ?? NaN);
  return Number.isFinite(v) ? v : null;
}
