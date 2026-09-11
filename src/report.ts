import { curveAbi } from "./chain/abi.ts";
import { stateClient, withRetry } from "./chain/chain.ts";
import { BLOCKS_PER_SECOND, CFG, short } from "./chain/config.ts";
import { quotePerToken } from "./chain/pool.ts";
import { getMeta, now, setMeta, type DB } from "./db.ts";
import { hasBasis, held, realized } from "./fold.ts";
import { usdOf } from "./prices.ts";
import { quoteMap } from "./quote.ts";
import { NO_DEPLOYER } from "./types.ts";
import type { Badge, BestFlight, ClassName, DeployerRecord, RankSnapshot, Report, WorstFlight } from "./types.ts";

/**
 * The Rekt Report (SPEC 3.2): PnL, rank, class, badges, worst and best flight, not alone.
 * See docs/api.md for the route this backs.
 *
 * Money: positions hold whole units of their quote asset; the price book turns those into dollars
 * per quote asset. A position whose quote asset has no price is never zeroed: it is left out of
 * every dollar figure and counted in `unpricedPositions`.
 *
 * Two sources, one position: most trading happens in the v4 pools rather than on the curve, and a
 * token that graduated before the launches backfill reaches back has a `pools` row and no
 * `launches` row. Every query over positions therefore LEFT JOINs both and takes the quote asset
 * and the symbol from whichever knows them (QUOTE_SQL, SYMBOL_SQL); none may INNER JOIN launches,
 * which would silently drop those positions. Facts that only a launch record carries — the
 * deployer, the launch time, the tax exemptions — stay absent rather than being guessed.
 */

// ---------------------------------------------------------------- shared SQL

/** Realized PnL of a trader_positions row aliased `p`, in quote units (fold.realized in SQL). */
export const REALIZED_SQL = `(CASE WHEN p.tokens_in > 0 AND p.tokens_out > 0
  THEN p.quote_out * (MIN(p.tokens_out, p.tokens_in) / p.tokens_out) - p.quote_in * (MIN(p.tokens_out, p.tokens_in) / p.tokens_in)
  ELSE 0 END)`;

/** Positions whose purchase is outside our record: sold more than we saw bought (fold.hasBasis). */
export const NO_BASIS_SQL = "(p.tokens_in <= 0 OR p.tokens_out > p.tokens_in * 1.01)";

/** The two joins every position query needs, for a `trader_positions` aliased `p`. */
export const POSITION_JOIN_SQL = "LEFT JOIN launches l ON l.token = p.token LEFT JOIN pools pl ON pl.token = p.token";

/**
 * The asset a position is denominated in: the launch's pair when the launch is on record, else the
 * pool's other side. `pools.quote_token` is NOT NULL DEFAULT '', so an empty string means unknown.
 */
export const QUOTE_SQL = "COALESCE(NULLIF(l.pair_token, ''), NULLIF(pl.quote_token, ''))";

/** The token's ticker from whichever source has one; NULL when neither does. */
export const SYMBOL_SQL = "COALESCE(l.symbol, pl.symbol)";

/**
 * Dollars per whole quote unit, as a CASE over the quote asset of the row; NULL for an unpriced
 * asset so SUM skips it and COUNT(usd) counts priced rows. `quoteExpr` says where the asset comes
 * from: the default is the launches column it has always been, and every query over positions
 * passes QUOTE_SQL so a token known only through its pool is priced too. Numbers and lowercase hex
 * only, so inlining is safe. Rebuilt per call: the book can change under us.
 */
export function usdCaseSql(db: DB, quoteExpr: string = "l.pair_token"): string {
  const parts: string[] = [];
  for (const [address, q] of quoteMap(db)) {
    const usd = usdOf(q.symbol);
    if (usd === null || !/^0x[0-9a-f]{40}$/.test(address)) continue;
    parts.push(`WHEN '${address}' THEN ${usd}`);
  }
  return parts.length ? `(CASE ${quoteExpr} ${parts.join(" ")} ELSE NULL END)` : "NULL";
}

/** Launches by the person behind them: launch_sender when known, else the event's deployer. */
export const DEPLOYER_MATCH_SQL = "(l.launch_sender = ? OR (l.launch_sender IS NULL AND l.deployer = ?))";

export const DEAD_SQL = "s.status IN ('departed','cancelled')";

/**
 * What the report and the token page put where a deployer would go when the token has no launch on
 * record: nobody, and a record of nothing. Only the launch transaction names the person who opened
 * a flight, so a token we know only through its pool has no pilot and the page says as much rather
 * than naming a wallet that never launched anything. `deployer === NO_DEPLOYER` with
 * `deployerRecord.launches === 0` is the signal for "no launch record", for every surface that
 * prints the pilot line.
 */
// Defined in types.ts so the card worker can read it without importing this module; re-exported
// here because every caller of the report already imports from here.
export { NO_DEPLOYER };
export const NO_DEPLOYER_RECORD: DeployerRecord = Object.freeze({ launches: 0, deadShare: 0, losers: 0 });

/** Address validation: 0x plus 40 hex, any case; returns the lowercase form or null. */
export function normalizeAddress(address: string): string | null {
  const a = String(address ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

// ---------------------------------------------------------------- caches

type Timed<T> = { at: number; value: T };
const fresh = <T>(c: Timed<T> | undefined, ttlMs: number): c is Timed<T> => !!c && Date.now() - c.at < ttlMs;

const deployerCache = new WeakMap<DB, Map<string, Timed<DeployerRecord>>>();
const sinceCache = new WeakMap<DB, Timed<number>>();
const priceCache = new Map<string, Timed<number>>();

/** Drops every in-memory cache (tests). */
export function clearReportCaches(): void {
  priceCache.clear();
  snapshots = new WeakMap();
}

/**
 * A deployer's record in one query: launches, share departed or cancelled, distinct wallets with
 * a negative position on any of their tokens (the deployer's own wallet excluded). Cached 60 s.
 *
 * The rows here describe launches, not positions, so the INNER JOIN on `launches` is the right one:
 * a position in a token with no launch row belongs to no deployer and is counted nowhere.
 */
export function deployerRecord(db: DB, deployer: string): DeployerRecord {
  let m = deployerCache.get(db);
  if (!m) { m = new Map(); deployerCache.set(db, m); }
  const hit = m.get(deployer);
  if (fresh(hit, 60_000)) return hit.value;

  const row = db.prepare(`
    SELECT COUNT(*) AS launches,
           SUM(CASE WHEN ${DEAD_SQL} THEN 1 ELSE 0 END) AS dead,
           (SELECT COUNT(DISTINCT p.wallet)
              FROM launches l JOIN trader_positions p ON p.token = l.token
             WHERE ${DEPLOYER_MATCH_SQL} AND p.wallet != ? AND ${REALIZED_SQL} < 0) AS losers
      FROM launches l LEFT JOIN token_state s ON s.token = l.token
     WHERE ${DEPLOYER_MATCH_SQL}`).get(deployer, deployer, deployer, deployer, deployer) as
    { launches: number; dead: number | null; losers: number };
  const value: DeployerRecord = {
    launches: row.launches,
    deadShare: row.launches ? round4((row.dead ?? 0) / row.launches) : 0,
    losers: row.losers,
  };
  if (m.size > 5_000) m.clear();
  m.set(deployer, { at: Date.now(), value });
  return value;
}

/**
 * Wall-clock seconds of a block, interpolated from the launch nearest to it (launches carry both a
 * block and a timestamp) at the chain's block rate, so no chain call is needed. Null when there is
 * no launch to interpolate from. Approximate by design; nothing exact is derived from it.
 */
export function tsForBlock(db: DB, block: number): number | null {
  if (!Number.isFinite(block)) return null;
  const near = db.prepare("SELECT block, ts FROM launches ORDER BY ABS(block - ?) LIMIT 1").get(block) as
    { block: number; ts: number } | undefined;
  return near ? Math.round(near.ts - (near.block - block) / BLOCKS_PER_SECOND) : null;
}

/**
 * When the records begin: the timestamp of meta.fold_from_block, interpolated from the nearest
 * launch. Falls back to the earliest folded trade. Cached 60 s.
 */
export function sinceTs(db: DB): number {
  const hit = sinceCache.get(db);
  if (fresh(hit, 60_000)) return hit.value;
  let value = 0;
  const from = Number(getMeta(db, "fold_from_block") ?? NaN);
  if (Number.isFinite(from)) value = tsForBlock(db, from) ?? 0;
  if (!value) {
    const first = db.prepare("SELECT MIN(first_ts) AS t FROM trader_positions").get() as { t: number | null };
    value = first.t ?? 0;
  }
  sinceCache.set(db, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- rank snapshot

type Snapshot = { builtAt: number; wallets: number; ranks: Map<string, { rank: number; percentile: number }> };
let snapshots = new WeakMap<DB, Snapshot>();
export const SNAPSHOT_TTL = 3_600;

/** The rank query's result, shaped for a worker to hand over: wallet, rank, percentile per qualified wallet, best first. */
export type RankTable = { wallets: number; entries: Array<[wallet: string, rank: number, percentile: number]> };

/**
 * The heavy half of the snapshot, pure of any cache: every wallet with 3 or more trades and at
 * least one priced position, sorted by net realized USD. Rank 1 is the best net; percentile is
 * the share of qualified wallets with a strictly worse net, so ties share a rank and a
 * percentile. Scans trader_positions, so api.ts runs it in a worker thread on a read-only
 * connection and installs the result with installRankSnapshot.
 *
 * Positions in pool-only tokens are ranked like any other: the join is left, the price comes from
 * whichever of the two records knows the quote asset, and COUNT over the price keeps a wallet with
 * nothing priceable out of the table as before.
 */
export function computeRanks(db: DB): RankTable {
  const usd = usdCaseSql(db, QUOTE_SQL);
  const rows = db.prepare(`
    SELECT p.wallet, SUM(${REALIZED_SQL} * ${usd}) AS net
      FROM trader_positions p ${POSITION_JOIN_SQL}
     GROUP BY p.wallet
    HAVING SUM(p.buys + p.sells) >= 3 AND COUNT(${usd}) > 0`).all() as Array<{ wallet: string; net: number }>;
  rows.sort((a, b) => b.net - a.net);

  const n = rows.length;
  const entries: RankTable["entries"] = new Array(n);
  for (let a = 0; a < n;) {
    let b = a + 1;
    while (b < n && rows[b].net === rows[a].net) b++;
    const percentile = round2((100 * (n - b)) / n);
    for (let i = a; i < b; i++) entries[i] = [rows[i].wallet, a + 1, percentile];
    a = b;
  }
  return { wallets: n, entries };
}

/**
 * Keeps a computed rank table on disk for the next process. One transaction, so a reader never
 * sees half a table; the meta row is written last and is what says the table is whole.
 */
export function writeRanks(db: DB, table: RankTable, builtAt: number = now()): void {
  const put = db.prepare("INSERT INTO rank_table (wallet, rank, percentile) VALUES (?,?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM rank_table");
    for (const [wallet, rank, percentile] of table.entries) put.run(wallet, rank, percentile);
    setMeta(db, "rank_table_wallets", String(table.wallets));
    setMeta(db, "rank_table_at", String(builtAt));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The rank table the last writer left on disk, or null when there is none yet. */
export function loadRanks(db: DB): { table: RankTable; builtAt: number } | null {
  const at = Number(getMeta(db, "rank_table_at") ?? NaN);
  const wallets = Number(getMeta(db, "rank_table_wallets") ?? NaN);
  if (!Number.isFinite(at) || !Number.isFinite(wallets)) return null;
  const rows = db.prepare("SELECT wallet, rank, percentile FROM rank_table ORDER BY rank").all() as
    Array<{ wallet: string; rank: number; percentile: number }>;
  if (!rows.length) return null;
  return { table: { wallets, entries: rows.map((x) => [x.wallet, Number(x.rank), Number(x.percentile)]) }, builtAt: at };
}

/** Makes a computed rank table the snapshot buildReport reads for this database. */
export function installRankSnapshot(db: DB, table: RankTable, builtAt: number = now()): RankSnapshot {
  const ranks = new Map<string, { rank: number; percentile: number }>();
  let shared: { rank: number; percentile: number } | null = null;
  for (const [wallet, rank, percentile] of table.entries) {
    if (!shared || shared.rank !== rank) shared = { rank, percentile };
    ranks.set(wallet, shared);
  }
  const snap: Snapshot = { builtAt, wallets: table.wallets, ranks };
  snapshots.set(db, snap);
  try { setMeta(db, "rank_snapshot_at", String(snap.builtAt)); } catch { /* a read-only database is fine */ }
  return { builtAt: snap.builtAt, wallets: table.wallets };
}

/**
 * Rebuilds the in-memory rank snapshot on this thread: computeRanks then installRankSnapshot.
 * api.ts does the computing in a worker and calls it hourly; buildReport only builds one itself
 * when there is none at all, and otherwise serves the one it has however old, so a request
 * never pays for the rebuild.
 */
export function refreshRankSnapshot(db: DB): RankSnapshot {
  return installRankSnapshot(db, computeRanks(db));
}

/** Seconds since the snapshot was built, or null without one. */
export function rankSnapshotAge(db: DB): number | null {
  const s = snapshots.get(db);
  return s ? now() - s.builtAt : null;
}

function snapshot(db: DB): Snapshot {
  const s = snapshots.get(db);
  if (s) return s;
  refreshRankSnapshot(db);
  return snapshots.get(db)!;
}

/**
 * Class by percentile (0..100, share of qualified wallets with a worse net PnL), null when not
 * qualified: bottom 1% Certified Exit Liquidity · 1–10% Rug Magnet · 10–33% Bagholder · 33–67%
 * Standard Rekt · above that with netUsd < 0: Lightly Toasted · netUsd ≥ 0: Survivor · top 10%:
 * The House · top 1%: Untouchable. Unqualified wallets: Survivor when netUsd ≥ 0, else Standard Rekt.
 */
export function classFor(percentile: number | null, netUsd: number): ClassName {
  if (percentile === null) return netUsd >= 0 ? "Survivor" : "Standard Rekt";
  if (percentile < 1) return "Certified Exit Liquidity";
  if (percentile < 10) return "Rug Magnet";
  if (percentile < 33) return "Bagholder";
  if (percentile < 67) return "Standard Rekt";
  if (netUsd < 0) return "Lightly Toasted";
  if (percentile >= 99) return "Untouchable";
  if (percentile >= 90) return "The House";
  return "Survivor";
}

// ---------------------------------------------------------------- positions

type PositionRow = {
  wallet: string; token: string;
  quote_in: number; quote_out: number; tokens_in: number; tokens_out: number;
  buys: number; sells: number; first_ts: number; last_ts: number; insider: number;
  curve: string | null; symbol: string | null; pair_token: string | null;
  launch_ts: number | null; pilot: string | null; status: string | null; status_ts: number | null;
  /** The token's v4 pool, null for one that never graduated (or graduated before we indexed pools). */
  pool_id: string | null; token_is_c1: number | null; dec0: number | null; dec1: number | null; init_sqrt: string | null;
};

type Priced = PositionRow & {
  /** Dollars per quote unit, null when unpriced. */
  usd: number | null;
  /** Realized PnL in quote units. */
  realizedQuote: number;
  /** Realized PnL in dollars, null when unpriced. */
  realizedUsd: number | null;
  /** Whole tokens still held. */
  held: number;
  /** Symbol for copy: the token's, or the truncated address. */
  sym: string;
};

function loadPositions(db: DB, wallet: string): Priced[] {
  const quotes = quoteMap(db);
  const rows = db.prepare(`
    SELECT p.*, l.curve, ${SYMBOL_SQL} AS symbol, ${QUOTE_SQL} AS pair_token, l.ts AS launch_ts,
           COALESCE(l.launch_sender, l.deployer) AS pilot, s.status, s.status_ts,
           pl.pool_id, pl.token_is_c1, pl.dec0, pl.dec1, pl.init_sqrt
      FROM trader_positions p ${POSITION_JOIN_SQL}
      LEFT JOIN token_state s ON s.token = p.token
     WHERE p.wallet = ?`).all(wallet) as PositionRow[];
  return rows.map((p) => {
    const usd = p.pair_token ? usdOf(quotes.get(p.pair_token)?.symbol) : null;
    const realizedQuote = realized(p);
    return {
      ...p, usd, realizedQuote,
      realizedUsd: usd === null ? null : realizedQuote * usd,
      held: held(p),
      sym: p.symbol || short(p.token),
    };
  });
}

const isDead = (status: string | null): boolean => status === "departed" || status === "cancelled";

// ---------------------------------------------------------------- bags

export type Reserves = { quote: bigint; token: bigint };
export type ReservesReader = (curve: string) => Promise<Reserves | null>;

/** One getReserves on the state RPC. Null on any failure: a bag we cannot price counts as zero. */
export const readReserves: ReservesReader = async (curve) => {
  try {
    const [quote, token] = (await withRetry(() =>
      stateClient.readContract({ address: curve as `0x${string}`, abi: curveAbi, functionName: "getReserves" }))) as
      readonly [bigint, bigint];
    return { quote, token };
  } catch {
    return null;
  }
};

export const BAGS_PRICED = 20;
export const PRICE_TTL_MS = 300_000;
/**
 * The longest the page will wait for prices before printing without them.
 *
 * A bag is marked at today's price, which for a token still on its curve means reading the chain.
 * When the state endpoint is slow or down, the retries behind those reads can take a minute, and a
 * report that arrives in a minute has not worked as far as anybody reading it is concerned. The
 * figure is already labelled approximate, so past this deadline the bags are worth what we can
 * price inside it and the rest count as zero. Everything else on the page comes from the database
 * and does not wait on anything.
 */
export const BAGS_DEADLINE_MS = 2_500;

/** `work`, or `fallback` if it has not finished in `ms`. The work is left to finish on its own. */
async function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whole quote per whole token from the curve's reserves, cached 5 minutes per curve. */
async function curvePrice(curve: string, quoteDecimals: number, read: ReservesReader): Promise<number> {
  const hit = priceCache.get(curve);
  if (fresh(hit, PRICE_TTL_MS)) return hit.value;
  const r = await read(curve);
  const price = r && r.token > 0n ? (Number(r.quote) / 10 ** quoteDecimals) / (Number(r.token) / 1e18) : 0;
  if (priceCache.size > 10_000) priceCache.clear();
  priceCache.set(curve, { at: Date.now(), value: Number.isFinite(price) ? price : 0 });
  return priceCache.get(curve)!.value;
}

/**
 * Whole quote per whole token of a graduated token, from the database and never from the chain:
 * `pool_peaks.last_sqrt` is the price of the last swap the pool indexer folded, so it is at most as
 * old as the fold cursor, and a page request must not wait on an RPC when a fresh enough number is
 * already on disk. A pool with no swap indexed yet falls back to `pools.init_sqrt`, the price the
 * token graduated at. Cached 5 minutes per pool like the curve prices, so a wallet holding twenty
 * graduated bags reads each pool once.
 */
function poolPrice(db: DB, p: Priced): number {
  const key = `pool:${p.pool_id}`;
  const hit = priceCache.get(key);
  if (fresh(hit, PRICE_TTL_MS)) return hit.value;
  const k = db.prepare("SELECT last_sqrt FROM pool_peaks WHERE pool_id = ?").get(p.pool_id as string) as
    { last_sqrt: string } | undefined;
  const sqrt = k?.last_sqrt ?? p.init_sqrt;
  const price = sqrt
    ? quotePerToken(sqrt, { token_is_c1: p.token_is_c1 ?? 0, dec0: p.dec0 ?? 18, dec1: p.dec1 ?? 18 })
    : 0;
  if (priceCache.size > 10_000) priceCache.clear();
  priceCache.set(key, { at: Date.now(), value: Number.isFinite(price) && price > 0 ? price : 0 });
  return priceCache.get(key)!.value;
}

/**
 * Dollar value of the bags still held: the twenty largest open priced positions by remaining cost
 * are marked at today's price, the rest count as zero. Approximate by design. A token that
 * graduated has no curve left to read, so its price comes from its pool; the rest are marked at
 * the curve's reserves.
 */
function valueBags(db: DB, positions: Priced[], read: ReservesReader): Promise<number> {
  return within(BAGS_DEADLINE_MS, priceBags(db, positions, read), 0);
}

async function priceBags(db: DB, positions: Priced[], read: ReservesReader): Promise<number> {
  const quotes = quoteMap(db);
  const open = positions
    .filter((p) => p.held > 0 && p.usd !== null && (p.pool_id || p.curve) && p.tokens_in > 0)
    .map((p) => ({ p, cost: p.quote_in * (p.held / p.tokens_in) * (p.usd as number) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, BAGS_PRICED);
  const values = await Promise.all(open.map(async ({ p }) => {
    const decimals = quotes.get(p.pair_token as string)?.decimals ?? 18;
    const price = p.pool_id
      ? poolPrice(db, p)
      : await curvePrice((p.curve as string).toLowerCase(), decimals, read);
    return p.held * price * (p.usd as number);
  }));
  return values.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------- badges

const BADGE_LABEL: Record<Badge["id"], string> = {
  sniper: "Sniper", fastest_rekt: "Fastest Rekt", serial_buyer: "Serial Buyer", diamond_coffin: "Diamond Coffin",
  exit_row: "Exit Row", survivor: "Survivor", frequent_flyer: "Frequent Flyer",
};

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "41 seconds", "6 minutes", "6 hours", "3 days". */
export function spanWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return plural(s, "second");
  const m = Math.round(s / 60);
  if (m < 90) return plural(m, "minute");
  const h = Math.round(s / 3600);
  if (h < 36) return plural(h, "hour");
  return plural(Math.round(s / 86400), "day");
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number): string => (n <= 10 ? WORDS[n][0].toUpperCase() + WORDS[n].slice(1) : String(n));

export const EXIT_ROW_WINDOW = 60;
export const SNIPER_WINDOW = 5;
export const FASTEST_REKT_WINDOW = 60;
export const FREQUENT_FLYER_DAYS = 7;
export const SERIAL_BUYER_MIN = 3;

function badgesFrom(db: DB, wallet: string, positions: Priced[], netUsd: number, nowTs: number): Badge[] {
  const out: Badge[] = [];
  const badge = (id: Badge["id"], detail: string): void => { out.push({ id, label: BADGE_LABEL[id], detail }); };

  // Sniper: first buy within 5 seconds of launch.
  const snipes = positions
    .filter((p) => p.buys > 0 && p.launch_ts !== null && p.first_ts - p.launch_ts <= SNIPER_WINDOW && p.first_ts >= p.launch_ts)
    .sort((a, b) => (a.first_ts - (a.launch_ts as number)) - (b.first_ts - (b.launch_ts as number)));
  if (snipes[0]) badge("sniper", `Boarded ${snipes[0].sym} ${spanWords(snipes[0].first_ts - (snipes[0].launch_ts as number))} after launch.`);

  // Fastest Rekt: a position closed at a loss within 60 seconds of opening.
  const fastest = positions
    .filter((p) => p.sells > 0 && p.held === 0 && p.realizedQuote < 0 && p.last_ts - p.first_ts <= FASTEST_REKT_WINDOW)
    .sort((a, b) => (a.last_ts - a.first_ts) - (b.last_ts - b.first_ts));
  if (fastest[0]) badge("fastest_rekt", `Closed ${fastest[0].sym} at a loss ${spanWords(fastest[0].last_ts - fastest[0].first_ts)} after boarding.`);

  // Serial Buyer: three or more positions in tokens with the same ticker.
  const byTicker = new Map<string, Priced[]>();
  for (const p of positions) {
    if (!p.symbol) continue;
    const k = p.symbol.toUpperCase();
    byTicker.set(k, [...(byTicker.get(k) ?? []), p]);
  }
  const serial = [...byTicker.entries()].filter(([, ps]) => ps.length >= SERIAL_BUYER_MIN).sort((a, b) => b[1].length - a[1].length)[0];
  if (serial) {
    const dead = serial[1].filter((p) => isDead(p.status)).length;
    const tail = dead === serial[1].length ? " All cancelled." : dead > 0 ? ` ${countWord(dead)} cancelled.` : "";
    badge("serial_buyer", `${countWord(serial[1].length)} flights named ${serial[1][0].symbol}.${tail}`);
  }

  // Diamond Coffin: still holding a token that departed or was cancelled.
  const coffin = positions
    .filter((p) => p.held > 0 && isDead(p.status))
    .sort((a, b) => (b.quote_in * (b.held / b.tokens_in) * (b.usd ?? 0)) - (a.quote_in * (a.held / a.tokens_in) * (a.usd ?? 0)))[0];
  if (coffin) {
    const word = coffin.status === "cancelled" ? "Cancelled" : "Departed";
    const when = coffin.status_ts !== null ? ` ${word} ${spanWords(nowTs - coffin.status_ts)} ago.` : ` ${word}.`;
    badge("diamond_coffin", `Still holding ${coffin.sym}.${when}`);
  }

  // Exit Row: bought within 60 seconds before the deployer's first sell. Positions carry no
  // per-trade log, so the deployer's exit is approximated by the last trade of a fully sold
  // position of theirs on the token.
  const withPilot = positions.filter((p) => p.pilot && p.pilot !== wallet);
  if (withPilot.length) {
    const pilotSell = db.prepare(`
      SELECT last_ts FROM trader_positions
       WHERE wallet = ? AND token = ? AND sells > 0 AND tokens_out >= tokens_in`);
    const rows: Array<{ p: Priced; gap: number }> = [];
    for (const p of withPilot) {
      const r = pilotSell.get(p.pilot as string, p.token) as { last_ts: number } | undefined;
      if (!r) continue;
      const gap = r.last_ts - p.first_ts;
      if (gap >= 0 && gap <= EXIT_ROW_WINDOW) rows.push({ p, gap });
    }
    rows.sort((a, b) => a.gap - b.gap);
    if (rows[0]) badge("exit_row", `Boarded ${rows[0].p.sym} ${spanWords(rows[0].gap)} before the pilot left.`);
  }

  // Survivor: net positive.
  if (netUsd > 0) badge("survivor", `Net positive on Pons. Statistically unusual.`);

  // Frequent Flyer: traded on seven distinct days (first and last trade of every position).
  const days = new Set<number>();
  for (const p of positions) { days.add(Math.floor(p.first_ts / 86400)); days.add(Math.floor(p.last_ts / 86400)); }
  if (days.size >= FREQUENT_FLYER_DAYS) badge("frequent_flyer", `Trades on ${days.size} distinct days.`);

  return out.slice(0, 3);
}

/** Badges from SPEC appendix A, three at most, in the order listed there. */
export function badgesFor(db: DB, address: string): Badge[] {
  const wallet = normalizeAddress(address);
  if (!wallet) return [];
  const positions = loadPositions(db, wallet);
  if (!positions.length) return [];
  const net = positions.reduce((a, p) => a + (p.realizedUsd ?? 0), 0);
  return badgesFrom(db, wallet, positions, net, now());
}

// ---------------------------------------------------------------- the report

export type ReportOptions = {
  /** Replaces the chain read (tests). */
  reserves?: ReservesReader;
  nowTs?: number;
};

/**
 * Builds the report for a wallet from trader_positions joined with launches, valuing bags with
 * getReserves on the twenty largest positions by cost (cached 5 minutes). Returns null when the
 * wallet has no positions; throws on an address that is not 0x plus 40 hex. api.ts caches the
 * result 5 minutes per address.
 */
export async function buildReport(db: DB, address: string, opts: ReportOptions = {}): Promise<Report | null> {
  const wallet = normalizeAddress(address);
  if (!wallet) throw new Error("bad address");
  const positions = loadPositions(db, wallet);
  if (!positions.length) return null;
  const nowTs = opts.nowTs ?? now();

  let netRealizedUsd = 0;
  let realizedUsd = 0;
  let volumeUsd = 0;
  let unpricedPositions = 0;
  let outsideRecordPositions = 0;
  let buys = 0;
  let sells = 0;
  let bagsHeld = 0;
  let firstTs = Infinity;
  let lastTs = 0;
  for (const p of positions) {
    buys += p.buys;
    sells += p.sells;
    if (p.held > 0) bagsHeld++;
    // Sold more than we ever saw bought: the purchase happened before the record begins, so the
    // sale carries no profit or loss we can honestly claim (fold.realized).
    if (!hasBasis({ tokens_in: p.tokens_in, tokens_out: p.tokens_out })) outsideRecordPositions++;
    firstTs = Math.min(firstTs, p.first_ts);
    lastTs = Math.max(lastTs, p.last_ts);
    if (p.realizedUsd === null) { unpricedPositions++; continue; }
    netRealizedUsd += p.realizedUsd;
    if (p.realizedUsd < 0) realizedUsd += p.realizedUsd;
    volumeUsd += (p.quote_in + p.quote_out) * (p.usd as number);
  }

  const priced = positions.filter((p) => p.realizedUsd !== null);
  const worstPos = priced.filter((p) => (p.realizedUsd as number) < 0).sort((a, b) => (a.realizedUsd as number) - (b.realizedUsd as number))[0];
  const bestPos = priced.filter((p) => (p.realizedUsd as number) > 0).sort((a, b) => (b.realizedUsd as number) - (a.realizedUsd as number))[0];

  let worst: WorstFlight | null = null;
  let notAlone: Report["notAlone"] = null;
  if (worstPos) {
    // No launch row, no pilot: the flight was not cancelled by anybody we can name, so the deployer
    // is nobody and their record is empty rather than a wallet picked to fill the field.
    const pilot = worstPos.pilot;
    worst = {
      token: worstPos.token,
      symbol: worstPos.sym,
      lossUsd: round2(-(worstPos.realizedUsd as number)),
      boughtTs: worstPos.first_ts,
      dead: isDead(worstPos.status),
      deployer: pilot ?? NO_DEPLOYER,
      deployerRecord: pilot ? deployerRecord(db, pilot) : NO_DEPLOYER_RECORD,
    };
    const others = db.prepare(`
      SELECT COUNT(*) AS wallets, COALESCE(SUM(${REALIZED_SQL}), 0) AS lost
        FROM trader_positions p WHERE p.token = ? AND p.wallet != ? AND ${REALIZED_SQL} < 0`)
      .get(worstPos.token, wallet) as { wallets: number; lost: number };
    notAlone = { wallets: others.wallets, lostUsd: round2(-others.lost * (worstPos.usd as number)) };
  }
  const best: BestFlight | null = bestPos
    ? { token: bestPos.token, symbol: bestPos.sym, gainUsd: round2(bestPos.realizedUsd as number) }
    : null;

  const snap = snapshot(db);
  const r = snap.ranks.get(wallet);
  const percentile = r ? r.percentile : null;

  const bagsUsd = await valueBags(db, positions, opts.reserves ?? readReserves);

  return {
    address: wallet,
    since: sinceTs(db),
    netRealizedUsd: round2(netRealizedUsd),
    realizedUsd: round2(realizedUsd),
    bagsUsd: round2(bagsUsd),
    bagsHeld,
    volumeUsd: round2(volumeUsd),
    tokensTraded: positions.length,
    buys,
    sells,
    firstTs,
    lastTs,
    rank: r ? r.rank : null,
    ofWallets: snap.wallets,
    percentile,
    className: classFor(percentile, netRealizedUsd),
    worst,
    best,
    badges: badgesFrom(db, wallet, positions, netRealizedUsd, nowTs),
    notAlone,
    unpricedPositions,
    outsideRecordPositions,
    ca: CFG.rektToken || null,
  };
}

export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
