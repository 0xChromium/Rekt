import { flightNumber } from "./board.ts";
import { short, ZERO_ADDRESS } from "./chain/config.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import type { Trade } from "./fold.ts";
import { quoteFromCache } from "./quote.ts";
import type { BoardEvent, GraduateEvent, LaunchEvent, LaunchRecord, RowContext, StatusEvent, TokenStatus } from "./types.ts";

/**
 * Per-token status for the departures board (token_state) and the board_events log.
 * Called from src/watch.ts.
 *
 * The rules (SPEC 3.1): TokenLaunched → boarding; PoolGraduated → arrived, never downgraded;
 * price at or below 10% of peak inside the first 10 minutes → cancelled; no trade for 10 minutes
 * and price at or below 10% of peak → departed. Departed and cancelled are terminal too: a token
 * that twitches after dying stays dead on the board.
 *
 * Every write bumps updated_seq from a counter kept in meta (state_seq), so a reader can ask
 * "what changed since N". Every status change appends one board event.
 */

/** The subset of a folded trade that token state needs. */
export type TradeInput = Pick<Trade, "token" | "side" | "quote" | "tokens" | "wallet" | "ts">;

/** Ten minutes: the boarding window for the cancelled rule and the silence for the departed rule. */
export const STATUS_WINDOW_S = 600;
/** A price at or below this share of the peak is dead. */
export const DEAD_SHARE = 0.1;
/** board_events older than this are pruned by sweepStatuses. */
export const EVENT_RETENTION_S = 86_400;
/**
 * A trade smaller than this in either leg is dust and says nothing about the price: a 1 wei sell
 * whose quoteOut rounds to nothing would otherwise read as a crash to zero and cancel a healthy
 * token. Dust still counts as a trade for the silence rule. Whole tokens and whole quote units.
 */
export const MIN_PRICE_TOKENS = 1;
export const MIN_PRICE_QUOTE = 1e-9;

const SEQ_KEY = "state_seq";

type StateRow = {
  token: string; launched_ts: number; deployer: string | null; pair_token: string | null; symbol: string | null;
  peak_price: number | null; last_price: number | null; last_trade_ts: number | null;
  status: TokenStatus; status_ts: number | null; graduated_ts: number | null; updated_seq: number;
};

type Stmts = Record<"get" | "insert" | "touch" | "setStatus" | "setGrad" | "trade" | "event" | "fromLaunch" | "symbolOf" | "rowCtx" | "hasLaunchEvent", ReturnType<DB["prepare"]>>;
const stmts = new WeakMap<DB, Stmts>();
const seqs = new WeakMap<DB, number>();

function prepared(db: DB): Stmts {
  let s = stmts.get(db);
  if (!s) {
    s = {
      get: db.prepare("SELECT * FROM token_state WHERE token = ?"),
      insert: db.prepare(`
        INSERT INTO token_state (token, launched_ts, deployer, pair_token, symbol, status, status_ts, graduated_ts, updated_seq)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING`),
      touch: db.prepare(`
        UPDATE token_state SET deployer = coalesce(?, deployer), pair_token = coalesce(?, pair_token),
          symbol = coalesce(?, symbol), updated_seq = ? WHERE token = ?`),
      setStatus: db.prepare("UPDATE token_state SET status = ?, status_ts = ?, updated_seq = ? WHERE token = ?"),
      setGrad: db.prepare("UPDATE token_state SET status = 'arrived', status_ts = ?, graduated_ts = ?, updated_seq = ? WHERE token = ?"),
      trade: db.prepare("UPDATE token_state SET peak_price = ?, last_price = ?, last_trade_ts = ?, updated_seq = ? WHERE token = ?"),
      event: db.prepare("INSERT INTO board_events (kind, token, ts, payload) VALUES (?,?,?,?)"),
      fromLaunch: db.prepare("SELECT token, coalesce(launch_sender, deployer) deployer, pair_token, symbol, ts, graduated_ts FROM launches WHERE token = ?"),
      // pools last: a token that graduated before the launches record begins has no launch row and
      // no state row, and its ticker is the one the pool sweep read off the contract. Without this
      // its losses print a truncated address on the tape instead of a name.
      symbolOf: db.prepare(`SELECT coalesce(
        (SELECT symbol FROM token_state WHERE token = ?),
        (SELECT symbol FROM launches WHERE token = ?),
        (SELECT symbol FROM pools WHERE token = ?)) symbol`),
      rowCtx: db.prepare(`
        SELECT l.flight, coalesce(s.pair_token, l.pair_token) pair, coalesce(s.launched_ts, l.ts) launch_ts
        FROM launches l LEFT JOIN token_state s ON s.token = l.token WHERE l.token = ?`),
      hasLaunchEvent: db.prepare("SELECT 1 x FROM board_events WHERE kind = 'launch' AND token = ? LIMIT 1"),
    };
    stmts.set(db, s);
  }
  return s;
}

/** The next value of the monotonic change counter, persisted in meta so restarts keep counting up. */
export function nextSeq(db: DB): number {
  let cur = seqs.get(db);
  if (cur === undefined) cur = Number(getMeta(db, SEQ_KEY) ?? 0) || 0;
  const next = cur + 1;
  seqs.set(db, next);
  setMeta(db, SEQ_KEY, String(next));
  return next;
}

/** Appends one board event row. Shared with losses.ts; returns the seq. */
export function appendBoardEvent(db: DB, ev: BoardEvent): number {
  const token = "token" in ev ? ev.token : null;
  const r = prepared(db).event.run(ev.kind, token, ev.ts, JSON.stringify(ev));
  return Number(r.lastInsertRowid);
}

/** The symbol a board line prints: the token's symbol, or its truncated address until names arrive. */
export function symbolOf(db: DB, token: string): string {
  const t = token.toLowerCase();
  const row = prepared(db).symbolOf.get(t, t, t) as { symbol: string | null } | undefined;
  return row?.symbol || short(token.toLowerCase());
}

/**
 * The rest of the board line for a token: flight number, quote asset, launch time.
 *
 * Carried on every status change because the board keeps four slots for tokens whose status just
 * changed, and a token dies ten minutes or more after it launched — long after its launch line
 * scrolled off the twelve the client is showing. Without this the client would have nothing to
 * print in Flight, Gate and Time.
 */
export function rowContext(db: DB, token: string): RowContext {
  const t = token.toLowerCase();
  const r = prepared(db).rowCtx.get(t) as { flight: number | null; pair: string | null; launch_ts: number | null } | undefined;
  const pair = (r?.pair ?? ZERO_ADDRESS).toLowerCase();
  return {
    flight: `RK-${r?.flight !== null && r?.flight !== undefined ? Number(r.flight) : flightNumber(db, t)}`,
    pair,
    pairSymbol: quoteFromCache(db, pair).symbol,
    launchTs: Number(r?.launch_ts ?? 0),
  };
}

const readState = (db: DB, token: string): StateRow | null =>
  (prepared(db).get.get(token) as StateRow | undefined) ?? null;

/**
 * Creates the token_state row for a launch the fold knows but the watcher never saw boarding
 * (a backfilled launch). No board event: it was not seen live. Returns the row, or null when the
 * token is not in launches either.
 *
 * Deliberately not extended to tokens known only through their pool. Their launch is outside the
 * record, so there is no honest launch time or graduation time to give a row: dating it from the
 * first swap we happened to read would put a token that graduated days ago on the departures board
 * as if it had just arrived, and into the turbulence share as if it had just launched. Their
 * prices live in pool_peaks and their tickers in pools, which is what the report and the tape use.
 */
function ensureState(db: DB, token: string): StateRow | null {
  const have = readState(db, token);
  if (have) return have;
  const l = prepared(db).fromLaunch.get(token) as
    { token: string; deployer: string; pair_token: string; symbol: string | null; ts: number; graduated_ts: number | null } | undefined;
  if (!l) return null;
  const status: TokenStatus = l.graduated_ts ? "arrived" : "boarding";
  prepared(db).insert.run(token, l.ts, l.deployer, l.pair_token, l.symbol, status, l.graduated_ts ?? l.ts, l.graduated_ts, nextSeq(db));
  return readState(db, token);
}

/**
 * Gives every launch without a token_state row one (boarding, or arrived when graduated), silently.
 * Run once at watcher start so backfilled launches take part in the sweep and the turbulence share.
 */
export function seedTokenState(db: DB): number {
  const rows = db.prepare("SELECT token FROM launches WHERE token NOT IN (SELECT token FROM token_state)").all() as Array<{ token: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) ensureState(db, r.token);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/**
 * Records a launch in token_state (status boarding, peak and last price null) and appends a
 * `launch` board event with flight = board.flightNumber(db, token). Idempotent per token: a
 * second call (after enrichment, or after `names`) updates symbol, deployer and pair and appends
 * nothing. The event is keyed on board_events, not on the row: the fold can create the row first
 * (a launch trades in its own block, enrichment takes longer), and the board still gets its line.
 */
export function applyLaunch(db: DB, launch: LaunchRecord): LaunchEvent {
  const token = launch.token.toLowerCase();
  const s = prepared(db);
  const symbol = launch.symbol || null;
  const deployer = launch.deployer.toLowerCase();
  const pair = launch.pair.toLowerCase();
  const ev: LaunchEvent = {
    kind: "launch",
    token,
    symbol: symbol ?? short(token),
    name: launch.name || symbol || short(token),
    deployer,
    pair,
    pairSymbol: launch.pairSymbol,
    ts: launch.ts,
    flight: `RK-${flightNumber(db, token)}`,
  };
  const have = readState(db, token);
  if (have) s.touch.run(deployer, pair, symbol, nextSeq(db), token);
  else s.insert.run(token, launch.ts, deployer, pair, symbol, "boarding", launch.ts, null, nextSeq(db));
  if (!s.hasLaunchEvent.get(token)) appendBoardEvent(db, ev);
  return ev;
}

/**
 * Marks a token arrived (PoolGraduated) at `ts`, sets graduated_ts, appends a `graduate` event.
 * Returns null when the token is unknown or already arrived. Arrived is final: a graduated token
 * is never marked departed or cancelled afterwards.
 */
export function applyGraduation(db: DB, token: string, ts: number): GraduateEvent | null {
  const t = token.toLowerCase();
  const row = ensureState(db, t);
  if (!row || row.status === "arrived") return null;
  prepared(db).setGrad.run(ts, ts, nextSeq(db), t);
  const ev: GraduateEvent = { kind: "graduate", token: t, symbol: symbolOf(db, t), ts, ...rowContext(db, t) };
  appendBoardEvent(db, ev);
  return ev;
}

/**
 * Updates peak_price, last_price and last_trade_ts from one trade (price = quote / tokens) and
 * applies the cancelled rule: price at or below 10% of peak inside the first 10 minutes after
 * launch. A dust trade (under MIN_PRICE_TOKENS or MIN_PRICE_QUOTE) moves last_trade_ts only.
 * Returns the `status` event it appended, or null when nothing changed.
 */
export function applyTradeState(db: DB, trade: TradeInput): StatusEvent | null {
  if (!(trade.tokens > 0) || !(trade.quote >= 0)) return null;
  const token = trade.token.toLowerCase();
  const row = ensureState(db, token);
  if (!row) return null;
  const lastTs = Math.max(row.last_trade_ts ?? 0, trade.ts);
  const dust = trade.tokens < MIN_PRICE_TOKENS || trade.quote < MIN_PRICE_QUOTE;
  if (dust) {
    prepared(db).trade.run(row.peak_price, row.last_price, lastTs, nextSeq(db), token);
    return null;
  }
  const price = trade.quote / trade.tokens;
  const peak = Math.max(row.peak_price ?? 0, price);
  prepared(db).trade.run(peak, price, lastTs, nextSeq(db), token);

  if (row.status !== "boarding") return null;
  const inWindow = trade.ts - row.launched_ts <= STATUS_WINDOW_S;
  if (!inWindow || !(peak > 0) || price > peak * DEAD_SHARE) return null;
  return setStatus(db, token, "cancelled", trade.ts);
}

function setStatus(db: DB, token: string, status: TokenStatus, ts: number): StatusEvent {
  prepared(db).setStatus.run(status, ts, nextSeq(db), token);
  const ev: StatusEvent = { kind: "status", token, symbol: symbolOf(db, token), status, ts, ...rowContext(db, token) };
  appendBoardEvent(db, ev);
  return ev;
}

/** The last_trade_ts cutoff each database was swept up to, so a sweep only visits rows that went quiet since. */
const sweptTo = new WeakMap<DB, number>();

/**
 * The time-based rule, run every few seconds by the watcher: boarding tokens with no trade for
 * 10 minutes and last price at or below 10% of peak go departed, stamped with the moment the
 * silence elapsed (last_trade_ts + 10 minutes), not the sweep time, so a sweep that runs late
 * (after a CLI fold, after downtime) records the real death time. `nowTs` should be the chain's
 * time as the fold knows it (the last folded block), not the wall clock, so a fold that is
 * catching up does not bury tokens whose trades it has not read yet.
 *
 * A row that was quiet and above 10% of peak at one sweep stays that way until a new trade moves
 * its last_trade_ts forward, so each sweep only visits rows whose last_trade_ts is inside
 * (previous cutoff, nowTs − 10 min]; the first sweep of a process, or one whose clock went
 * backwards, visits everything. Returns the `status` events appended (one per token that
 * changed). Also prunes board_events older than 24 hours.
 */
export function sweepStatuses(db: DB, nowTs: number): StatusEvent[] {
  const cutoff = nowTs - STATUS_WINDOW_S;
  const prev = sweptTo.get(db);
  // Ten minutes of overlap with the previous sweep: block times are interpolated and may move a
  // few seconds between reads, so a trade is never stamped just under the watermark.
  const after = prev !== undefined && prev <= cutoff ? prev - STATUS_WINDOW_S : -1;
  const due = db.prepare(`
    SELECT token, last_trade_ts FROM token_state
    WHERE status = 'boarding' AND last_trade_ts > ? AND last_trade_ts <= ?
      AND peak_price > 0 AND last_price <= peak_price * ?
    ORDER BY last_trade_ts`).all(after, cutoff, DEAD_SHARE) as Array<{ token: string; last_trade_ts: number }>;
  const out: StatusEvent[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of due) out.push(setStatus(db, r.token, "departed", Math.min(nowTs, r.last_trade_ts + STATUS_WINDOW_S)));
    db.prepare("DELETE FROM board_events WHERE ts < ?").run(nowTs - EVENT_RETENTION_S);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  sweptTo.set(db, cutoff);
  return out;
}

/** Forgets the sweep watermark for a database, so the next sweep visits every boarding row (tests, reorgs). */
export function resetSweep(db: DB): void {
  sweptTo.delete(db);
}
