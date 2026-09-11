import { short } from "./chain/config.ts";
import { now, type DB } from "./db.ts";
import {
  DEAD_SQL, DEPLOYER_MATCH_SQL, POSITION_JOIN_SQL, QUOTE_SQL, REALIZED_SQL, round2, round4, SYMBOL_SQL, usdCaseSql,
} from "./report.ts";
import type { AirlineRow, HallRow, HallWindow } from "./types.ts";

/**
 * Hall of Rekt and Airlines (SPEC 3.5). Owned by the report builder. api.ts caches both 60 s;
 * this module caches too so the board's counters and the pages share one computation.
 *
 * A wallet's losses count wherever they happened: every query over positions left-joins `launches`
 * and `pools` and prices the position from whichever knows its quote asset (see report.ts). The
 * Airlines board is the exception by nature — it lists deployers, and a token with no launch row
 * has none, so those positions belong to no airline.
 */

export const LEADERBOARD_TTL_MS = 60_000;

type Cached<T> = { at: number; value: T };
const cache = new WeakMap<DB, Map<string, Cached<unknown>>>();

function cached<T>(db: DB, key: string, compute: () => T): T {
  let m = cache.get(db);
  if (!m) { m = new Map(); cache.set(db, m); }
  const hit = m.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit.value;
  const value = compute();
  m.set(key, { at: Date.now(), value });
  return value;
}

/** Drops the cache (tests). */
export function clearLeaderboardCache(db: DB): void {
  cache.delete(db);
}

/**
 * Wallets by realized losses: "24h" sums the losses table over the last 24 hours, "all" sums
 * negative realized PnL over trader_positions (priced positions only). Largest first.
 */
export function hallOfRekt(db: DB, window: HallWindow, limit: number): HallRow[] {
  if (window !== "24h" && window !== "all") throw new Error("bad window");
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  return cached(db, `hall:${window}:${n}`, () => (window === "24h" ? hallToday(db, n) : hallAllTime(db, n)));
}

function hallToday(db: DB, limit: number): HallRow[] {
  const since = now() - 86_400;
  // ix_losses_ts for the window, ix_losses_wallet for the worst token per wallet.
  const rows = db.prepare(`
    SELECT wallet, SUM(loss_usd) AS loss, COUNT(DISTINCT token) AS tokens
      FROM losses WHERE ts >= ? GROUP BY wallet ORDER BY loss DESC LIMIT ?`).all(since, limit) as
    Array<{ wallet: string; loss: number; tokens: number }>;
  const worst = db.prepare(`
    SELECT x.token, ${SYMBOL_SQL} AS symbol FROM (
      SELECT token, SUM(loss_usd) AS loss FROM losses WHERE wallet = ? AND ts >= ? GROUP BY token ORDER BY loss DESC LIMIT 1
    ) x LEFT JOIN launches l ON l.token = x.token LEFT JOIN pools pl ON pl.token = x.token`);
  return rows.map((r) => {
    const w = worst.get(r.wallet, since) as { token: string; symbol: string | null } | undefined;
    return { wallet: r.wallet, lossUsd: round2(r.loss), tokens: r.tokens, worstSymbol: w ? w.symbol || short(w.token) : "?" };
  });
}

function hallAllTime(db: DB, limit: number): HallRow[] {
  const usd = usdCaseSql(db, QUOTE_SQL);
  const rows = db.prepare(`
    SELECT p.wallet, SUM(-${REALIZED_SQL} * ${usd}) AS loss, COUNT(*) AS tokens
      FROM trader_positions p ${POSITION_JOIN_SQL}
     WHERE ${usd} IS NOT NULL AND ${REALIZED_SQL} < 0
     GROUP BY p.wallet ORDER BY loss DESC LIMIT ?`).all(limit) as Array<{ wallet: string; loss: number; tokens: number }>;
  // The wallet's positions through the primary key; the largest loss in dollars.
  const worst = db.prepare(`
    SELECT p.token, ${SYMBOL_SQL} AS symbol FROM trader_positions p ${POSITION_JOIN_SQL}
     WHERE p.wallet = ? AND ${usd} IS NOT NULL AND ${REALIZED_SQL} < 0
     ORDER BY ${REALIZED_SQL} * ${usd} ASC LIMIT 1`);
  return rows.map((r) => {
    const w = worst.get(r.wallet) as { token: string; symbol: string | null } | undefined;
    return { wallet: r.wallet, lossUsd: round2(r.loss), tokens: r.tokens, worstSymbol: w ? w.symbol || short(w.token) : "?" };
  });
}

/**
 * Deployers (launches.launch_sender, falling back to deployer) by distinct wallets that lost
 * money on their tokens, then by total lost. Largest first. The deployer's own positions do not
 * count as losers; a loss in an unpriced quote asset counts the wallet but adds no dollars.
 *
 * The join on `launches` is inner on purpose: only a launch record names the person who opened the
 * flight, so a loss in a token we know only through its pool belongs to no airline and is counted
 * on no row here. It still counts in the Hall of Rekt and in the report.
 */
export function airlines(db: DB, limit: number): AirlineRow[] {
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  return cached(db, `airlines:${n}`, () => {
    const rows = db.prepare(`
      SELECT d, COUNT(DISTINCT wallet) AS losers, COALESCE(SUM(lost), 0) AS lost FROM (
        SELECT COALESCE(l.launch_sender, l.deployer) AS d, p.wallet,
               COALESCE(-${REALIZED_SQL} * ${usdCaseSql(db, QUOTE_SQL)}, 0) AS lost
          FROM trader_positions p
          JOIN launches l ON l.token = p.token
          LEFT JOIN pools pl ON pl.token = p.token
         WHERE ${REALIZED_SQL} < 0 AND p.wallet != COALESCE(l.launch_sender, l.deployer)
      ) GROUP BY d ORDER BY losers DESC, lost DESC LIMIT ?`).all(n) as Array<{ d: string; losers: number; lost: number }>;
    const record = db.prepare(`
      SELECT COUNT(*) AS launches, SUM(CASE WHEN ${DEAD_SQL} THEN 1 ELSE 0 END) AS dead
        FROM launches l LEFT JOIN token_state s ON s.token = l.token WHERE ${DEPLOYER_MATCH_SQL}`);
    return rows.map((r) => {
      const rec = record.get(r.d, r.d) as { launches: number; dead: number | null };
      return {
        deployer: r.d,
        launches: rec.launches,
        deadShare: rec.launches ? round4((rec.dead ?? 0) / rec.launches) : 0,
        losers: r.losers,
        lostUsd: round2(r.lost),
      };
    });
  });
}
