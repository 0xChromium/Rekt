import { decodeEventLog } from "viem";
import { curveAbi, TOPIC } from "./abi.ts";
import { getLogs, hexNum, type RawLog } from "./chain.ts";
import { now, toEth, type DB } from "../db.ts";

/**
 * One token's trading history off its curve, read on demand.
 *
 * Curve events live on each curve's own address. The chain-wide fold never keeps trades, so a page
 * that wants a price path (the exit-liquidity replay) asks for this token's logs when it is opened:
 * one eth_getLogs, cheap. Rows are keyed on (tx, log_index) so re-reading a range is harmless.
 */
export async function indexCurve(
  db: DB, token: string, curve: string, fromBlock: number, toBlock: number,
  tsOf: (block: number) => Promise<number> = async () => 0,
): Promise<{ buys: number; sells: number }> {
  const logs = await getLogs({ address: curve as `0x${string}` }, fromBlock, toBlock);

  const ins = db.prepare(`
    INSERT INTO curve_trades (token, tx, log_index, side, actor, recipient,
      quote_wei, quote_eth, token_amt, fee_wei, tax_wei, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  const out = { buys: 0, sells: 0 };
  const rows: Array<[RawLog, ReturnType<typeof decodeEventLog>, number]> = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell) continue;
    try {
      rows.push([l, decodeEventLog({ abi: curveAbi, topics: l.topics, data: l.data }), await tsOf(hexNum(l.blockNumber))]);
    } catch {
      continue;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [l, ev, ts] of rows) {
      const a = ev.args as Record<string, unknown>;
      const isBuy = ev.eventName === "CurveBuy";
      // A buy spends quote for tokens; a sell does the reverse. Both store the quote leg in quote_wei.
      const quote = (isBuy ? a.quoteIn : a.quoteOut) as bigint;
      const tokens = (isBuy ? a.tokensOut : a.tokensIn) as bigint;
      const actor = String(isBuy ? a.buyer : a.seller).toLowerCase();
      ins.run(
        token.toLowerCase(), l.transactionHash, hexNum(l.logIndex), isBuy ? "buy" : "sell", actor,
        String(a.recipient).toLowerCase(), quote.toString(), toEth(quote), tokens.toString(),
        (a.fee as bigint).toString(), (a.tax as bigint).toString(), hexNum(l.blockNumber), ts,
      );
      if (isBuy) out.buys++;
      else out.sells++;
    }
    db.prepare(`INSERT INTO curve_indexed (token, to_block, trades, indexed_at) VALUES (?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET to_block=excluded.to_block, trades=curve_indexed.trades+excluded.trades, indexed_at=excluded.indexed_at`)
      .run(token.toLowerCase(), toBlock, out.buys + out.sells, now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return out;
}

/**
 * Every price the curve traded at, in raw quote units per raw token unit, in order. Both sides
 * count: a sell carries a price exactly as a buy does. Raw units cancel in any ratio.
 */
export function tradePrices(db: DB, token: string): number[] {
  const rows = db.prepare(
    "SELECT quote_wei, token_amt FROM curve_trades WHERE token = ? ORDER BY block, log_index",
  ).all(token.toLowerCase()) as Array<{ quote_wei: string; token_amt: string }>;

  const prices: number[] = [];
  for (const r of rows) {
    const tokens = Number(r.token_amt);
    if (!(tokens > 0)) continue;
    const p = Number(r.quote_wei) / tokens;
    if (p > 0 && Number.isFinite(p)) prices.push(p);
  }
  return prices;
}

export type CurvePrices = { first: number; peak: number; last: number; trades: number };

/** First, peak and last price of an indexed curve, raw units. Null when no trades were read. */
export function curvePrices(db: DB, token: string): CurvePrices | null {
  const prices = tradePrices(db, token);
  if (!prices.length) return null;
  return { first: prices[0], peak: Math.max(...prices), last: prices[prices.length - 1], trades: prices.length };
}

/** The highest price as a multiple of the first trade. What happened, not a forecast. */
export function peakMultiple(db: DB, token: string): number | null {
  const p = curvePrices(db, token);
  return p === null ? null : p.peak / p.first;
}

/** Price of a trade in whole quote per whole token, from raw event amounts. */
export function tradePrice(quoteWei: bigint, tokensWei: bigint, quoteDecimals: number): number {
  if (tokensWei <= 0n) return 0;
  return (Number(quoteWei) / 10 ** quoteDecimals) / (Number(tokensWei) / 1e18);
}
