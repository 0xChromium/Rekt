import { parseAbi } from "viem";
import { stateClient, withRetry } from "./chain/chain.ts";
import { ZERO_ADDRESS } from "./chain/config.ts";
import type { DB } from "./db.ts";

const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export type QuoteAsset = { address: string; symbol: string; decimals: number };

/** Addresses whose read failed, with when; not asked again for a minute, and never written to the cache. */
const failedAt = new Map<string, number>();
export const QUOTE_RETRY_MS = 60_000;

/**
 * Symbol and decimals for a launch's quote asset, cached in quote_assets.
 *
 * Half of launches are quoted in a token rather than ETH, and not every token has 18 decimals.
 * Scaling those amounts as wei silently prints 0.0000 for real values. A read that fails (an RPC
 * hiccup) returns "?" and 18 decimals for now but writes nothing: the next call after a minute,
 * or backfillQuoteAssets, asks the chain again, so one bad read never leaves an asset unpriced
 * for the life of the database.
 */
export async function resolveQuote(db: DB, address: string): Promise<QuoteAsset> {
  const a = address.toLowerCase();
  if (a === ZERO_ADDRESS) return { address: a, symbol: "ETH", decimals: 18 };

  const hit = db.prepare("SELECT address, symbol, decimals FROM quote_assets WHERE address = ?").get(a) as
    | QuoteAsset | undefined;
  if (hit && hit.symbol && hit.symbol !== "?") return hit;

  const fallback: QuoteAsset = hit ?? { address: a, symbol: "?", decimals: 18 };
  const failed = failedAt.get(a);
  if (failed !== undefined && Date.now() - failed < QUOTE_RETRY_MS) return fallback;

  try {
    const [s, d] = await Promise.all([
      withRetry(() => stateClient.readContract({ address: a as `0x${string}`, abi: erc20, functionName: "symbol" })),
      withRetry(() => stateClient.readContract({ address: a as `0x${string}`, abi: erc20, functionName: "decimals" })),
    ]);
    const symbol = String(s).slice(0, 32) || "?";
    const decimals = Number(d);
    if (symbol === "?" || !Number.isFinite(decimals)) throw new Error(`no symbol or decimals at ${a}`);
    db.prepare("INSERT INTO quote_assets(address,symbol,decimals) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol, decimals=excluded.decimals")
      .run(a, symbol, decimals);
    failedAt.delete(a);
    return { address: a, symbol, decimals };
  } catch {
    failedAt.set(a, Date.now());
    return fallback;
  }
}

/** The cached answer only; "?" and 18 decimals for an asset nobody has resolved yet. */
export function quoteFromCache(db: DB, address: string): QuoteAsset {
  const a = address.toLowerCase();
  if (a === ZERO_ADDRESS) return { address: a, symbol: "ETH", decimals: 18 };
  const hit = db.prepare("SELECT address, symbol, decimals FROM quote_assets WHERE address = ?").get(a) as
    | QuoteAsset | undefined;
  return hit ?? { address: a, symbol: "?", decimals: 18 };
}

/** The whole cache as a map, for hot loops that must not query per event. */
export function quoteMap(db: DB): Map<string, QuoteAsset> {
  const m = new Map<string, QuoteAsset>();
  m.set(ZERO_ADDRESS, { address: ZERO_ADDRESS, symbol: "ETH", decimals: 18 });
  for (const r of db.prepare("SELECT address, symbol, decimals FROM quote_assets").all() as QuoteAsset[]) {
    m.set(r.address, r);
  }
  return m;
}

/**
 * Exact wei-to-decimal formatting; no float rounding on the number a trader is checking.
 * The place count grows for small values rather than truncating them to "0".
 */
export function formatUnits(wei: bigint, decimals: number, places = 4): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const rem = v % base;

  let p = places;
  if (whole === 0n && rem > 0n) {
    const digits = rem.toString().padStart(decimals, "0");
    const firstSig = digits.search(/[1-9]/);
    if (firstSig >= 0) p = Math.min(decimals, Math.max(places, firstSig + 2));
  }
  const frac = rem.toString().padStart(decimals, "0").slice(0, p).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Quote assets seen in launches that the cache does not know, or knows only as "?". */
export function unresolvedQuoteAssets(db: DB): string[] {
  return (db.prepare(`
    SELECT DISTINCT l.pair_token a FROM launches l LEFT JOIN quote_assets q ON q.address = l.pair_token
     WHERE l.pair_token != ? AND (q.address IS NULL OR q.symbol IS NULL OR q.symbol = '?')`).all(ZERO_ADDRESS) as Array<{ a: string }>).map((r) => r.a);
}

/**
 * Fills the cache for every quote asset seen in launches, including ones an earlier failed read
 * left at "?". Returns how many were resolved this time.
 */
export async function backfillQuoteAssets(db: DB): Promise<number> {
  let resolved = 0;
  for (const a of unresolvedQuoteAssets(db)) {
    const q = await resolveQuote(db, a);
    if (q.symbol !== "?") resolved++;
  }
  return resolved;
}
