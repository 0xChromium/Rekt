import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ADDR } from "./chain/config.ts";

/**
 * Dollar prices for the assets launches are quoted against.
 *
 * The shipped snapshot is the floor; `data/prices.json` overrides it and `refreshPrices()` rewrites
 * that file from DexScreener (ETH, cbBTC) and Robinhood's rhj price feed (stock tokens). Anything
 * without a price stays unpriced, and the report counts those positions separately rather than at
 * zero. Quote assets are keyed by their ERC-20 symbol.
 */
export type PriceBook = { asOf: string; note: string; usd: Record<string, number> };

export const PRICES_PATH = "data/prices.json";

const SHIPPED: PriceBook = {
  asOf: "2026-09-10",
  note: "shipped snapshot; refreshPrices() rewrites data/prices.json",
  usd: {
    ETH: 2472, USDG: 1.0, cbBTC: 78200,
    NVDA: 223.1, SPY: 770.19, QQQ: 718.96, TSLA: 347, AAPL: 319.97, MSFT: 499.7, GOOGL: 338.46,
    AMZN: 258.51, META: 616.77, AMD: 477.57, PLTR: 174.33, COIN: 184.64, MSTR: 142.8, GME: 19.16,
    AMC: 2.64, RDDT: 155.99, HIMS: 27.81, DJT: 9.03, SPCX: 147.95, GLD: 406.77, SLV: 59.87,
    COST: 915.74, CRCL: 102.05, LULU: 100.61, TTWO: 214.69, RBLX: 43.31, SGOV: 100.5, SNAP: 5.8,
    SNDK: 1740, LLY: 1149, BABA: 113.27, BB: 7.71, MU: 1017, UPS: 102.29, BULL: 9.85, MRVL: 223.55,
    IBM: 234.89, NFLX: 78.25, F: 14.62, TSM: 415.15, JNJ: 275.23, INDA: 49.8, SKHY: 164.24,
    SHOP: 144.8, MRNA: 145.55, BE: 252.87, WYFI: 18.8, PFE: 28.45, DELL: 524.14,
  },
};

/** Symbols that are not stocks, and where their price comes from. */
const DEX_TOKENS: Record<string, string> = { ETH: ADDR.weth, cbBTC: ADDR.cbBTC };
const FIXED: Record<string, number> = { USDG: 1.0 };

let cache: { at: number; book: PriceBook } | null = null;

export function priceBook(path = PRICES_PATH): PriceBook {
  if (cache && Date.now() - cache.at < 30_000) return cache.book;
  let book = SHIPPED;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PriceBook>;
      if (raw && typeof raw.usd === "object" && raw.usd) {
        book = { asOf: raw.asOf ?? "unknown", note: raw.note ?? "from data/prices.json", usd: { ...SHIPPED.usd, ...raw.usd } };
      }
    } catch {
      // A malformed file falls back to the shipped snapshot rather than pricing nothing.
    }
  }
  cache = { at: Date.now(), book };
  return book;
}

/** Dollars per whole unit of a quote asset, or null when we have no price for it. */
export function usdOf(symbol: string | null | undefined): number | null {
  if (!symbol) return null;
  const { usd } = priceBook();
  return usd[symbol] ?? null;
}

/** Every launch mints the same fixed supply, so a market cap is price times this. */
export const SUPPLY = 1e9;

/** Market cap in dollars from a price in quote units per whole token; null when unpriced. */
export function marketCapUsd(pricePerToken: number, quoteSymbol: string | null): number | null {
  const usd = usdOf(quoteSymbol);
  if (usd === null || !Number.isFinite(pricePerToken)) return null;
  return pricePerToken * SUPPLY * usd;
}

export function formatUsd(v: number | null): string {
  if (v === null) return "—";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e5) return `${sign}$${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
  return `${sign}$${Math.round(a)}`;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "rekt/0.1 (+https://rekt.report)" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** The deepest DexScreener pair's USD price for a token on Robinhood Chain. */
async function dexScreenerUsd(address: string): Promise<number | null> {
  const pairs = (await getJson(`https://api.dexscreener.com/tokens/v1/robinhood/${address}`)) as
    Array<{ priceUsd?: string; liquidity?: { usd?: number }; baseToken?: { address?: string } }>;
  if (!Array.isArray(pairs)) return null;
  const own = pairs
    .filter((p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase() && Number(p.priceUsd) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const px = Number(own[0]?.priceUsd);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/** Mid of bid and ask from Robinhood's stock token feed, or null when the symbol is unknown there. */
async function rhjUsd(symbol: string): Promise<number | null> {
  const d = (await getJson(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`)) as
    { quotes?: Array<{ tokenSymbol?: string; bid?: string; ask?: string }> };
  const q = d.quotes?.find((x) => x.tokenSymbol === symbol) ?? d.quotes?.[0];
  if (!q) return null;
  const bid = Number(q.bid);
  const ask = Number(q.ask);
  const px = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
  return Number.isFinite(px) && px > 0 ? px : null;
}

export type RefreshResult = { book: PriceBook; updated: string[]; failed: string[] };

/**
 * Pulls fresh prices and rewrites data/prices.json. Symbols are the book's own plus any passed in
 * (the quote assets seen in launches, typically). A feed that fails leaves the old number alone.
 */
export async function refreshPrices(extraSymbols: string[] = [], path = PRICES_PATH): Promise<RefreshResult> {
  const current = priceBook(path);
  const usd: Record<string, number> = { ...current.usd, ...FIXED };
  const symbols = new Set<string>([...Object.keys(current.usd), ...extraSymbols].filter((s) => s && s !== "?"));
  const updated: string[] = [];
  const failed: string[] = [];

  for (const sym of symbols) {
    if (sym in FIXED) continue;
    try {
      const px = sym in DEX_TOKENS ? await dexScreenerUsd(DEX_TOKENS[sym]) : await rhjUsd(sym);
      if (px === null) { failed.push(sym); continue; }
      usd[sym] = px;
      updated.push(sym);
    } catch {
      failed.push(sym);
    }
  }

  const book: PriceBook = {
    asOf: new Date().toISOString(),
    note: `refreshed ${updated.length} of ${symbols.size} symbols; ETH and cbBTC from DexScreener, stocks from rhj`,
    usd,
  };
  if (updated.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(book, null, 2) + "\n");
    cache = { at: Date.now(), book };
  }
  return { book, updated, failed };
}

/** Whether a symbol looks like a stock token the rhj feed would know. */
export const isStockSymbol = (s: string): boolean => /^[A-Z]{1,6}$/.test(s) && !(s in DEX_TOKENS) && !(s in FIXED);
