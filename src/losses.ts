import type { DB } from "./db.ts";
import { realized, type DecodedTrade, type Position } from "./fold.ts";
import { appendBoardEvent, symbolOf } from "./state.ts";
import type { LossEvent } from "./types.ts";

/**
 * Loss detection on sells (SPEC 5.3). Owned by the state builder; called from src/watch.ts inside
 * fold.foldRange's onTrade hook, after fold.applyTrade.
 *
 * realized = quote_out − quote_in × min(1, tokens_out / tokens_in). The delta of realized for one
 * sell, priced with the quote asset's dollar price, is the loss this sell crystallised. Buys never
 * lose; bags still held are not a loss yet.
 */

/** A row of the losses table, camel-cased. */
export type LossRow = {
  id: number;
  tx: string;
  logIndex: number;
  wallet: string;
  token: string;
  /** Positive, in quote units. */
  lossQuote: number;
  /** Positive dollars. */
  lossUsd: number;
  minutesSinceBuy: number;
  ts: number;
  block: number;
};

/** Losses below this are not a loss, they are a fee. */
export const MIN_LOSS_USD = 20;

const EMPTY: Pick<Position, "quote_in" | "quote_out" | "tokens_in" | "tokens_out"> = { quote_in: 0, quote_out: 0, tokens_in: 0, tokens_out: 0 };

/** The change in realized PnL between two positions, in quote units. Negative on a losing sell. */
export function realizedDelta(before: Position | null, after: Position): number {
  return realized(after) - realized(before ?? EMPTY);
}

const stmts = new WeakMap<DB, ReturnType<DB["prepare"]>>();
const insertStmt = (db: DB): ReturnType<DB["prepare"]> => {
  let s = stmts.get(db);
  if (!s) {
    s = db.prepare(`
      INSERT INTO losses (tx, log_index, wallet, token, loss_quote, loss_usd, minutes_since_buy, ts, block)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);
    stmts.set(db, s);
  }
  return s;
};

/**
 * If `trade` is a sell whose realized delta (realized(after) − realized(before)) is negative and
 * worth $20 or more at `quoteUsd` dollars per quote unit, inserts a losses row and appends a
 * `loss` board event, and returns the row. Returns null otherwise, on buys, when quoteUsd is null
 * (unpriced quote asset), or when (tx, log_index) is already recorded.
 */
export function detectLoss(
  db: DB, before: Position | null, after: Position, trade: DecodedTrade, quoteUsd: number | null,
): LossRow | null {
  if (trade.side !== "sell" || quoteUsd === null || !(quoteUsd > 0)) return null;
  const delta = realizedDelta(before, after);
  if (!(delta < 0)) return null;
  const lossQuote = -delta;
  const lossUsd = lossQuote * quoteUsd;
  if (lossUsd < MIN_LOSS_USD) return null;

  const firstTs = before?.first_ts ?? after.first_ts;
  const minutesSinceBuy = Math.max(0, (trade.ts - firstTs) / 60);
  const wallet = trade.wallet.toLowerCase();
  const token = trade.token.toLowerCase();
  const r = insertStmt(db).run(trade.tx, trade.logIndex, wallet, token, lossQuote, lossUsd, minutesSinceBuy, trade.ts, trade.block);
  if (r.changes === 0) return null;

  const ev: LossEvent = { kind: "loss", wallet, token, symbol: symbolOf(db, token), lossUsd, minutesSinceBuy, ts: trade.ts };
  appendBoardEvent(db, ev);
  return {
    id: Number(r.lastInsertRowid), tx: trade.tx, logIndex: trade.logIndex, wallet, token,
    lossQuote, lossUsd, minutesSinceBuy, ts: trade.ts, block: trade.block,
  };
}
