import type { DB } from "./db.ts";
import { DEAD_SQL, POSITION_JOIN_SQL, QUOTE_SQL, REALIZED_SQL, round4, usdCaseSql } from "./report.ts";
import type { Turbulence, TurbulenceLabel } from "./types.ts";

/**
 * Turbulence index v1 (SPEC 3.4). Owned by the report builder. Served at GET /api/index, cached
 * 60 seconds by api.ts, and folded into the board's counters event.
 */

export const TURBULENCE_WINDOW = 86_400;
export const TURBULENCE_TTL_MS = 60_000;

/** 0–20 Clear skies · 20–40 Light chop · 40–60 Moderate · 60–80 Severe · 80–100 Extreme (lower bound inclusive). */
export function turbulenceLabel(score: number): TurbulenceLabel {
  if (score < 20) return "Clear skies";
  if (score < 40) return "Light chop";
  if (score < 60) return "Moderate";
  if (score < 80) return "Severe";
  return "Extreme";
}

type Cached = { at: number; nowTs: number; value: Turbulence };
const cache = new WeakMap<DB, Cached>();

/** Drops the cache for one database (tests). */
export function clearTurbulenceCache(db: DB): void {
  cache.delete(db);
}

/**
 * Over [nowTs − 86400, nowTs]: W = share of wallets with a trade in the window (last_ts) whose
 * realized PnL over all their positions is negative; D = share of tokens launched in the window
 * that are departed or cancelled. score = round(100 × (0.6 W + 0.4 D)).
 *
 * W counts only wallets with at least one priced position (an unpriced wallet cannot be judged);
 * with no such wallet W is 0, with no launch in the window D is 0. Cached 60 s per database.
 *
 * W is over positions, so it counts a wallet's pool-only tokens like any other. D is over tokens
 * launched in the window, and a token we know only through its pool has no launch time on record:
 * it is in neither half of that share rather than being dated by guesswork.
 */
export function turbulence(db: DB, nowTs: number): Turbulence {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TURBULENCE_TTL_MS && Math.abs(nowTs - hit.nowTs) < 60) return hit.value;

  const since = nowTs - TURBULENCE_WINDOW;
  const usd = usdCaseSql(db, QUOTE_SQL);
  const w = db.prepare(`
    SELECT COUNT(*) AS judged, SUM(CASE WHEN net < 0 THEN 1 ELSE 0 END) AS losers
      FROM (SELECT p.wallet, SUM(${REALIZED_SQL} * ${usd}) AS net
              FROM trader_positions p ${POSITION_JOIN_SQL}
             WHERE p.wallet IN (SELECT DISTINCT wallet FROM trader_positions WHERE last_ts >= ? AND last_ts <= ?)
             GROUP BY p.wallet
            HAVING COUNT(${usd}) > 0)`).get(since, nowTs) as { judged: number; losers: number | null };
  const d = db.prepare(`
    SELECT COUNT(*) AS launched, SUM(CASE WHEN ${DEAD_SQL} THEN 1 ELSE 0 END) AS dead
      FROM launches l LEFT JOIN token_state s ON s.token = l.token
     WHERE l.ts >= ? AND l.ts <= ?`).get(since, nowTs) as { launched: number; dead: number | null };

  const W = w.judged ? (w.losers ?? 0) / w.judged : 0;
  const D = d.launched ? (d.dead ?? 0) / d.launched : 0;
  const score = Math.round(100 * (0.6 * W + 0.4 * D));
  const value: Turbulence = { score, label: turbulenceLabel(score), w: round4(W), d: round4(D), window: TURBULENCE_WINDOW };
  cache.set(db, { at: Date.now(), nowTs, value });
  return value;
}
