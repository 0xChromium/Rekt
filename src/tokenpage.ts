import { chainHead } from "./fold.ts";
import { indexCurve, peakMultiple } from "./chain/curve.ts";
import { short } from "./chain/config.ts";
import { poolPeaks, quotePerToken } from "./chain/pool.ts";
import { getMeta, now, type DB } from "./db.ts";
import {
  deployerRecord, NO_DEPLOYER, NO_DEPLOYER_RECORD, normalizeAddress, POSITION_JOIN_SQL, QUOTE_SQL, REALIZED_SQL,
  round2, SYMBOL_SQL, tsForBlock, usdCaseSql,
} from "./report.ts";
import type { TokenPage, TokenStatus } from "./types.ts";

/**
 * The token page /t/:token (SPEC 2, item 9). Owned by the report builder. api.ts caches 5 minutes.
 *
 * A token has a page if either record knows it: the launch, or the pool it graduated into. For a
 * pool-only token the launch facts are simply absent — no pilot, no launch transaction, no
 * exemptions — and the page says so (deployer NO_DEPLOYER, an empty record) instead of naming
 * someone. Its `bornTs` is when its pool opened, which is where our record of it begins.
 */

export const CURVE_INDEX_TTL = 300;

export type TokenPageOptions = {
  /** Read the curve's trades from the chain when they are not indexed yet (default true). */
  index?: boolean;
  nowTs?: number;
};

type Row = {
  token: string | null; curve: string | null; symbol: string | null; name: string | null;
  ts: number | null; block: number | null; graduated_ts: number | null; pilot: string | null;
  status: TokenStatus | null; status_ts: number | null; state_graduated_ts: number | null;
  pool_token: string | null; init_block: number | null; init_sqrt: string | null;
  token_is_c1: number | null; dec0: number | null; dec1: number | null;
};

/**
 * Status, born and died times from token_state, launches and pools, losers and losses from
 * trader_positions, peak multiple from the curve (chain/curve.ts, indexCurve on demand, hence
 * async) or from the pool for a token that has no curve on record. Returns null for a token in
 * neither launches nor pools.
 */
export async function tokenPage(db: DB, token: string, opts: TokenPageOptions = {}): Promise<TokenPage | null> {
  const t = normalizeAddress(token);
  if (!t) return null;
  // One row whether the token is in launches, in pools or in both; NULLs say which.
  const row = db.prepare(`
    SELECT l.token, l.curve, ${SYMBOL_SQL} AS symbol, l.name, l.ts, l.block, l.graduated_ts,
           COALESCE(l.launch_sender, l.deployer) AS pilot,
           s.status, s.status_ts, s.graduated_ts AS state_graduated_ts,
           pl.token AS pool_token, pl.init_block, pl.init_sqrt, pl.token_is_c1, pl.dec0, pl.dec1
      FROM (SELECT ? AS token) x
      LEFT JOIN launches l ON l.token = x.token
      LEFT JOIN pools pl ON pl.token = x.token
      LEFT JOIN token_state s ON s.token = x.token`).get(t) as Row | undefined;
  if (!row || (row.token === null && row.pool_token === null)) return null;
  const nowTs = opts.nowTs ?? now();

  // Before the watcher has written token_state, a graduated launch is arrived and the rest boarding;
  // a token we know only through its pool has graduated by definition.
  const status: TokenStatus = row.status ??
    (row.graduated_ts !== null || row.token === null ? "arrived" : "boarding");
  const dead = status === "departed" || status === "cancelled";
  const diedTs = dead ? (row.status_ts ?? nowTs) : null;
  const bornTs = row.ts ?? bornFromPool(db, row, t);

  const usd = usdCaseSql(db, QUOTE_SQL);
  const losses = db.prepare(`
    SELECT COUNT(*) AS losers, COALESCE(SUM(-${REALIZED_SQL} * ${usd}), 0) AS lost,
           COALESCE(MAX(-${REALIZED_SQL} * ${usd}), 0) AS biggest
      FROM trader_positions p ${POSITION_JOIN_SQL}
     WHERE p.token = ? AND ${REALIZED_SQL} < 0`).get(t) as { losers: number; lost: number; biggest: number };

  return {
    token: t,
    symbol: row.symbol || short(t),
    name: row.name || row.symbol || short(t),
    status,
    bornTs,
    diedTs,
    peakMultiple: await peak(db, row, opts.index !== false, nowTs),
    lifespanMin: round2(Math.max(0, (diedTs ?? nowTs) - bornTs) / 60),
    losers: losses.losers,
    lostUsd: round2(losses.lost),
    biggestLossUsd: round2(losses.biggest),
    deployer: row.pilot ?? NO_DEPLOYER,
    deployerRecord: row.pilot ? deployerRecord(db, row.pilot) : NO_DEPLOYER_RECORD,
  };
}

/**
 * When our record of a pool-only token begins. Not its launch time, which no launch row means we
 * do not have: the block its pool was initialised, dated by interpolation like every other block
 * time in the schema. Falls back to the first trade we folded, then to zero.
 */
function bornFromPool(db: DB, row: Row, token: string): number {
  const fromPool = row.init_block !== null ? tsForBlock(db, row.init_block) : null;
  if (fromPool) return fromPool;
  const first = db.prepare("SELECT MIN(first_ts) AS t FROM trader_positions WHERE token = ?").get(token) as
    { t: number | null };
  return first.t ?? 0;
}

/**
 * Peak over first trade price from the indexed curve. Indexes the curve on demand (one
 * eth_getLogs on the curve's address from its launch block to the fold cursor), and again when
 * the index is older than five minutes and the token is still alive. Null when nothing is known.
 *
 * A token with no launch row has no curve to index; its peak comes from the swaps already folded
 * into pool_peaks, over the price its pool opened at. No chain read either way in that case.
 */
async function peak(db: DB, row: Row, allowIndex: boolean, nowTs: number): Promise<number | null> {
  if (row.token === null || row.curve === null || row.block === null) return poolPeak(db, row);
  const indexed = db.prepare("SELECT to_block, indexed_at FROM curve_indexed WHERE token = ?").get(row.token) as
    { to_block: number; indexed_at: number } | undefined;
  const alive = row.status === null || row.status === "boarding";
  const stale = !indexed || (alive && nowTs - indexed.indexed_at > CURVE_INDEX_TTL);
  if (allowIndex && stale) {
    try {
      const cursor = Number(getMeta(db, "fold_to_block") ?? NaN);
      const head = Number.isFinite(cursor) ? cursor : await chainHead();
      const from = indexed ? indexed.to_block + 1 : row.block;
      if (head >= from) await indexCurve(db, row.token, row.curve, from, head);
    } catch {
      // The page works without the peak; the next request tries again.
    }
  }
  const m = peakMultiple(db, row.token);
  return m === null || !Number.isFinite(m) ? null : round2(m);
}

/** Peak over the pool's opening price, from folded swaps only; null before any swap is folded. */
function poolPeak(db: DB, row: Row): number | null {
  if (row.pool_token === null || !row.init_sqrt) return null;
  const p = poolPeaks(db, row.pool_token);
  if (!p || p.swaps === 0 || p.peakPrice === null) return null;
  const open = quotePerToken(row.init_sqrt, {
    token_is_c1: row.token_is_c1 ?? 0, dec0: row.dec0 ?? 18, dec1: row.dec1 ?? 18,
  });
  const m = open > 0 ? p.peakPrice / open : NaN;
  return Number.isFinite(m) ? round2(m) : null;
}
