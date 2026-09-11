import { CFG, ZERO_ADDRESS } from "./chain/config.ts";
import { now, type DB } from "./db.ts";
import { quoteMap } from "./quote.ts";
import type { BoardEvent, BoardReplay, BoardRow, CountersEvent, FlightCode, LossEvent, TokenStatus, TurbulenceLabel } from "./types.ts";

/**
 * The departures board's read side: board_events after a cursor, and the replay a client gets on
 * connect. Owned by the api builder; src/api.ts turns these into SSE. See docs/api.md.
 */

/**
 * Flight number of a token: the `flight` column of its launches row, assigned once when the row
 * is written (ingest) or, for a row that has none yet, the next number after the highest on
 * record. Final once assigned; state.applyLaunch and recentBoard both read it so the launch
 * event and the replay agree. 0 for a token that is not in launches.
 */
export function flightNumber(db: DB, token: string): number {
  const t = token.toLowerCase();
  const row = db.prepare("SELECT flight FROM launches WHERE token = ?").get(t) as { flight: number | null } | undefined;
  if (!row) return 0;
  if (row.flight !== null) return Number(row.flight);
  db.prepare("UPDATE launches SET flight = (SELECT COALESCE(MAX(flight), 0) + 1 FROM launches) WHERE token = ? AND flight IS NULL").run(t);
  const again = db.prepare("SELECT flight FROM launches WHERE token = ?").get(t) as { flight: number | null } | undefined;
  return Number(again?.flight ?? 0);
}

export const MAX_EVENTS = 500;
export const BOARD_ROWS = 12;
/**
 * Slots held for tokens whose status changed, out of BOARD_ROWS.
 *
 * The chain launches a token every three or four seconds and a launch is boarding by definition,
 * so a board filled with the newest launches shows nothing but BOARDING and never flips a status:
 * a token needs ten minutes of silence, or a 90% fall, to change, and by then it is thousands of
 * lines down. Reserving the bottom four for the most recent changes keeps a cancelled, departed
 * or arrived line on screen for about ten minutes at the rate the chain actually kills tokens.
 */
export const BOARD_CHANGED = 4;
export const TAPE_ROWS = 20;

/**
 * Board events with seq greater than `sinceSeq`, oldest first, at most 500. `seq` is the last
 * seq returned, or `sinceSeq` when there was nothing. Counters events are not stored; api.ts
 * computes them every 5 seconds from counters(db).
 */
export function readEvents(db: DB, sinceSeq: number): { events: BoardEvent[]; seq: number } {
  const rows = readEventRows(db, sinceSeq);
  return { events: rows.map((r) => r.event), seq: rows.length ? rows[rows.length - 1].seq : sinceSeq };
}

/** The same rows with their seq, for the SSE `id:` line. */
export function readEventRows(db: DB, sinceSeq: number): Array<{ seq: number; event: BoardEvent }> {
  const rows = db.prepare(
    "SELECT seq, kind, payload FROM board_events WHERE seq > ? ORDER BY seq LIMIT ?",
  ).all(sinceSeq, MAX_EVENTS) as Array<{ seq: number; kind: string; payload: string }>;
  const out: Array<{ seq: number; event: BoardEvent }> = [];
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.payload) as BoardEvent;
      if (ev && typeof ev === "object") out.push({ seq: r.seq, event: { ...ev, kind: (ev.kind || r.kind) as never } });
    } catch {
      // A row the writer could not finish is skipped; the cursor still moves past it.
    }
  }
  return out;
}

/** The current end of the log, 0 when empty. */
export function currentSeq(db: DB): number {
  const r = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM board_events").get() as { s: number };
  return Number(r.s) || 0;
}

/** Where the API keeps the last gauge the worker computed, so a fresh process starts with one. */
export const GAUGE_KEY = "index";
export const NO_GAUGE: TurbulenceGauge = { score: 0, label: "Clear skies" };

/**
 * The last turbulence gauge on record, never a fresh one.
 *
 * The gauge is a scan over a day of positions: the better part of a minute on the query worker.
 * This used to compute it here when none had been handed in yet, which is the case for the
 * first few minutes of every process, and the board is built on the serving thread, so every
 * boot began with the whole site stopped for as long as the scan took. It was the last of the
 * boot stalls and the hardest to see: the profiler called the thread idle, and the detector
 * blamed whatever ran last. A gauge that is minutes old is right for a needle; a blank site
 * is not. Nothing on this thread computes it any more.
 */
export function storedGauge(db: DB): TurbulenceGauge {
  try {
    const row = db.prepare("SELECT json FROM slow_answers WHERE key = ?").get(GAUGE_KEY) as { json: string } | undefined;
    if (row) {
      const g = JSON.parse(row.json) as { score?: unknown; label?: unknown };
      if (typeof g.score === "number" && typeof g.label === "string") return { score: g.score, label: g.label as TurbulenceLabel };
    }
  } catch { /* a missing or unreadable row is the same as none */ }
  return NO_GAUGE;
}

/** Keeps a gauge for the next process. A refused write costs nothing; the next one will land. */
export function storeGauge(db: DB, gauge: TurbulenceGauge): void {
  try {
    db.prepare("INSERT INTO slow_answers (key, at, json) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, json = excluded.json")
      .run(GAUGE_KEY, Date.now(), JSON.stringify({ score: gauge.score, label: gauge.label }));
  } catch { /* the serving connection waits a second and a half for a lock, then gives up */ }
}

export type TurbulenceGauge = { score: number; label: TurbulenceLabel };

/**
 * The three panels: lost today (losses over the rolling 24 h), whole days since the last token
 * went cancelled (days since the record began when none has), and the turbulence index. `turb`
 * is the gauge when the caller has one (api.ts computes it off the event loop); without it the
 * index is computed here, cached 60 seconds.
 */
export function counters(db: DB, nowTs: number = now(), turb?: TurbulenceGauge): CountersEvent {
  const lost = db.prepare("SELECT COALESCE(SUM(loss_usd), 0) AS s FROM losses WHERE ts >= ?").get(nowTs - 86_400) as { s: number };
  const last = db.prepare("SELECT MAX(status_ts) AS t FROM token_state WHERE status = 'cancelled'").get() as { t: number | null };
  let since = last.t;
  if (since === null) {
    const first = db.prepare("SELECT MIN(launched_ts) AS t FROM token_state").get() as { t: number | null };
    since = first.t;
  }
  const days = since === null ? 0 : Math.max(0, Math.floor((nowTs - since) / 86_400));
  return {
    kind: "counters",
    lostTodayUsd: Math.round((Number(lost.s) || 0) * 100) / 100,
    daysSinceCancelled: days,
    turbulence: turb ?? storedGauge(db),
    ts: nowTs,
  };
}

type StateRow = {
  token: string; symbol: string | null; name: string | null; deployer: string | null;
  launch_sender: string | null; event_deployer: string; pair_token: string; launched_ts: number;
  status: string; status_ts: number | null; block: number; log_index: number; flight: number | null;
};

const ROW_COLUMNS = `
  SELECT s.token, COALESCE(s.symbol, l.symbol) AS symbol, l.name, s.deployer, l.launch_sender,
         l.deployer AS event_deployer, COALESCE(s.pair_token, l.pair_token) AS pair_token,
         s.launched_ts, s.status, s.status_ts, l.block, l.log_index, l.flight
  FROM token_state s JOIN launches l ON l.token = s.token`;

/**
 * The board: the newest launches, then the tokens whose status changed most recently.
 *
 * Two queries rather than one order-by, because the two lanes answer different questions and the
 * chain answers the first one forty times as often as the second. The top is what is taking off
 * now (ix_state_launched), the bottom is what just died or made it (ix_state_status). When
 * nothing has changed status yet the launches fill the whole board.
 */
export function boardRows(db: DB, limit = BOARD_ROWS): BoardRow[] {
  // `IN` rather than `<> 'boarding'`: an inequality on the leading column cannot use
  // ix_state_status(status, status_ts DESC), and this table is every token the chain ever launched.
  const changed = db.prepare(`${ROW_COLUMNS}
    WHERE s.status IN ('cancelled', 'departed', 'arrived')
    ORDER BY s.status_ts DESC, s.updated_seq DESC LIMIT ?`).all(limit) as StateRow[];
  const fresh = db.prepare(`${ROW_COLUMNS}
    WHERE s.status = 'boarding'
    ORDER BY s.launched_ts DESC, l.block DESC, l.log_index DESC LIMIT ?`).all(limit) as StateRow[];
  // Four slots for the changes, more only when there are not enough launches to fill the board.
  const take = changed.slice(0, Math.max(Math.min(BOARD_CHANGED, limit), limit - fresh.length));
  const rows = [...fresh.slice(0, limit - take.length), ...take];
  const quotes = quoteMap(db);
  return rows.map((r) => {
    const pair = (r.pair_token ?? ZERO_ADDRESS).toLowerCase();
    return {
      token: r.token,
      symbol: r.symbol ?? "?",
      name: r.name ?? r.symbol ?? "?",
      flight: `RK-${r.flight !== null ? Number(r.flight) : flightNumber(db, r.token)}` as FlightCode,
      deployer: (r.deployer ?? r.launch_sender ?? r.event_deployer).toLowerCase(),
      pair,
      pairSymbol: quotes.get(pair)?.symbol ?? "?",
      ts: r.launched_ts,
      status: (r.status as TokenStatus) ?? "boarding",
      statusTs: r.status_ts ?? r.launched_ts,
    };
  });
}

/** The last 20 losses, newest first, as tape lines. */
export function recentLosses(db: DB, limit = TAPE_ROWS): LossEvent[] {
  const rows = db.prepare(`
    SELECT x.wallet, x.token, COALESCE(l.symbol, '?') AS symbol, x.loss_usd, x.minutes_since_buy, x.ts
    FROM losses x LEFT JOIN launches l ON l.token = x.token
    ORDER BY x.id DESC LIMIT ?`).all(limit) as
    Array<{ wallet: string; token: string; symbol: string; loss_usd: number; minutes_since_buy: number | null; ts: number }>;
  return rows.map((r) => ({
    kind: "loss",
    wallet: r.wallet,
    token: r.token,
    symbol: r.symbol,
    lossUsd: Math.round(r.loss_usd * 100) / 100,
    minutesSinceBuy: Math.round((r.minutes_since_buy ?? 0) * 10) / 10,
    ts: r.ts,
  }));
}

/**
 * The replay sent on connect: the 12 board rows (8 newest launches, then the 4 most recent status
 * changes), the last 20 losses, the counters (lost today from losses, days since the last
 * cancelled status_ts, turbulence from turbulence.ts cached 60 s), the CA, and the current seq.
 */
export function recentBoard(db: DB, turb?: TurbulenceGauge): BoardReplay {
  const nowTs = now();
  return {
    rows: boardRows(db),
    losses: recentLosses(db),
    counters: counters(db, nowTs, turb),
    ca: CFG.rektToken || null,
    seq: currentSeq(db),
  };
}
