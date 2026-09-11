import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CFG } from "./chain/config.ts";

/**
 * The REKT schema. Other modules build against it; add tables or nullable columns, never rename.
 *
 * Money: `*_wei` columns are exact integers as decimal strings (wei overflows a 64-bit integer);
 * REAL columns are whole units of the quote asset, for sorting and sums. Addresses are lowercase.
 * Timestamps are unix seconds, interpolated from block numbers (see chain/blockclock.ts).
 *
 * meta keys in use:
 *   backfill_from_block, backfill_to_block   what `backfill` covered
 *   fold_from_block, fold_to_block           the trade fold's window and cursor
 *   live_cursor_block, live_head_block, live_seen_at   the watcher's cursor and heartbeat
 */
const SCHEMA = `
-- One row per TokenLaunched. Enrichment fills in the launch transaction's facts later.
CREATE TABLE IF NOT EXISTS launches (
  token                    TEXT PRIMARY KEY,
  curve                    TEXT NOT NULL,
  -- The event's deployer: often a router or Multicall3. The person is launch_sender (tx.from).
  deployer                 TEXT NOT NULL,
  launch_sender            TEXT,
  creator_fee_recipient    TEXT,
  creator_tax_bps          INTEGER,
  -- Zero address for ETH, otherwise the ERC-20 the curve is quoted in (see quote_assets).
  pair_token               TEXT NOT NULL,
  name                     TEXT,
  symbol                   TEXT,
  block                    INTEGER NOT NULL,
  ts                       INTEGER NOT NULL,
  graduated_ts             INTEGER,
  graduated_block          INTEGER,
  tx                       TEXT NOT NULL,
  log_index                INTEGER NOT NULL,
  launch_config_id         INTEGER NOT NULL DEFAULT 0,
  graduation_threshold_wei TEXT,
  -- Null until enrich.ts has read the launch transaction; a failed read leaves it null for a retry.
  enriched_at              INTEGER,
  first_seen_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_launches_curve  ON launches(curve);
CREATE INDEX IF NOT EXISTS ix_launches_sender ON launches(launch_sender);
CREATE INDEX IF NOT EXISTS ix_launches_block  ON launches(block);
CREATE INDEX IF NOT EXISTS ix_launches_ts     ON launches(ts DESC);
CREATE INDEX IF NOT EXISTS ix_launches_deployer ON launches(deployer);

-- Wallets the creator waived the opening tax for, from the launch transaction input.
CREATE TABLE IF NOT EXISTS exemptions (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (token, address)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_exempt_address ON exemptions(address);

-- Curve trades folded per wallet and token. The raw stream (about 1.1M events a day) is never kept.
-- quote_in/quote_out are whole units of the launch's quote asset; tokens_in/tokens_out whole tokens.
CREATE TABLE IF NOT EXISTS trader_positions (
  wallet     TEXT NOT NULL,
  token      TEXT NOT NULL,
  quote_in   REAL NOT NULL DEFAULT 0,
  quote_out  REAL NOT NULL DEFAULT 0,
  tokens_in  REAL NOT NULL DEFAULT 0,
  tokens_out REAL NOT NULL DEFAULT 0,
  buys       INTEGER NOT NULL DEFAULT 0,
  sells      INTEGER NOT NULL DEFAULT 0,
  first_ts   INTEGER NOT NULL,
  last_ts    INTEGER NOT NULL,
  -- 1 when the wallet launched the token or was waived the opening tax on it.
  insider    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, token)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_positions_token ON trader_positions(token, last_ts DESC);
-- The turbulence index asks "wallets with a trade in the last 24 h" once a minute.
CREATE INDEX IF NOT EXISTS ix_positions_last ON trader_positions(last_ts);

-- Per-token status for the departures board. Written by the watcher (state.ts).
-- status: boarding | arrived | departed | cancelled. Prices are quote per whole token.
CREATE TABLE IF NOT EXISTS token_state (
  token         TEXT PRIMARY KEY,
  launched_ts   INTEGER NOT NULL,
  deployer      TEXT,
  pair_token    TEXT,
  symbol        TEXT,
  peak_price    REAL,
  last_price    REAL,
  last_trade_ts INTEGER,
  status        TEXT NOT NULL DEFAULT 'boarding',
  status_ts     INTEGER,
  graduated_ts  INTEGER,
  -- Monotonic change counter so the board can ask "what changed since N".
  updated_seq   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_state_seq    ON token_state(updated_seq);
CREATE INDEX IF NOT EXISTS ix_state_status ON token_state(status, status_ts DESC);
-- The board's replay (newest launches first) and the departed sweep (boarding rows by last trade).
CREATE INDEX IF NOT EXISTS ix_state_launched ON token_state(launched_ts DESC);
CREATE INDEX IF NOT EXISTS ix_state_quiet    ON token_state(status, last_trade_ts);
-- The top of the board: the newest boarding flights. Without the launch time in the index SQLite
-- can only seek on the status, and "boarding" is nearly every token the chain has ever launched,
-- so it read two hundred thousand rows and sorted all of them to return twelve. That was most of
-- a second, on the thread that serves the site, every time the board was rebuilt.
CREATE INDEX IF NOT EXISTS ix_state_boarding ON token_state(status, launched_ts DESC);

-- Realized losses of $20 or more, one per sell that crystallised them (losses.ts).
CREATE TABLE IF NOT EXISTS losses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tx                 TEXT NOT NULL,
  log_index          INTEGER NOT NULL,
  wallet             TEXT NOT NULL,
  token              TEXT NOT NULL,
  loss_quote         REAL NOT NULL,
  loss_usd           REAL NOT NULL,
  minutes_since_buy  REAL,
  ts                 INTEGER NOT NULL,
  block              INTEGER,
  UNIQUE (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_losses_ts     ON losses(ts DESC);
CREATE INDEX IF NOT EXISTS ix_losses_wallet ON losses(wallet);
CREATE INDEX IF NOT EXISTS ix_losses_token  ON losses(token);
-- The day's Hall of Rekt: sum the losses of the last 24 hours by wallet. Grouping by wallet made
-- SQLite scan the whole table through the wallet index and test the timestamp on every row, so the
-- query got slower with every day the record grew. With the time first and the three columns it
-- reads carried along, it touches only the day it was asked about: ninety-five seconds to five.
CREATE INDEX IF NOT EXISTS ix_losses_recent ON losses(ts DESC, wallet, token, loss_usd);

-- Credits and claims for a fee recipient, from the Pons fee escrow (desk.ts).
CREATE TABLE IF NOT EXISTS fee_events (
  tx         TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  depositor  TEXT,
  amount_wei TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_fee_recipient ON fee_events(recipient);

CREATE TABLE IF NOT EXISTS fee_recipient_changes (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  prev      TEXT NOT NULL,
  next      TEXT NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_feechg_token ON fee_recipient_changes(token);

-- Symbol and decimals of every quote asset seen, so amounts scale correctly (quote.ts).
CREATE TABLE IF NOT EXISTS quote_assets (
  address  TEXT PRIMARY KEY,
  symbol   TEXT,
  decimals INTEGER NOT NULL
) STRICT;

-- One curve's trades, read on demand for a replay (chain/curve.ts). Not chain-wide.
CREATE TABLE IF NOT EXISTS curve_trades (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  side      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  recipient TEXT NOT NULL,
  quote_wei TEXT NOT NULL,
  quote_eth REAL NOT NULL,
  token_amt TEXT NOT NULL,
  fee_wei   TEXT NOT NULL,
  tax_wei   TEXT NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_trades_token ON curve_trades(token, block);

CREATE TABLE IF NOT EXISTS curve_indexed (
  token      TEXT PRIMARY KEY,
  to_block   INTEGER NOT NULL,
  trades     INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
) STRICT;

-- v4 pools of graduated tokens and their price extremes (chain/pool.ts, not wired on day one).
-- The Uniswap v4 pool a token graduated into. Most of the chain's trading happens here rather than
-- on the curve, and a pool outlives the launch record: a token that graduated before the launches
-- backfill reaches back has a pool row and no launches row, so quote_token and symbol are kept
-- here too and everything that prices a position falls back to them.
CREATE TABLE IF NOT EXISTS pools (
  token       TEXT PRIMARY KEY,
  pool_id     TEXT NOT NULL,
  currency0   TEXT NOT NULL,
  currency1   TEXT NOT NULL,
  token_is_c1 INTEGER NOT NULL,
  dec0        INTEGER NOT NULL,
  dec1        INTEGER NOT NULL,
  init_block  INTEGER NOT NULL,
  init_sqrt   TEXT NOT NULL,
  -- The other side of the pair: what a trade in this pool is denominated in.
  quote_token TEXT NOT NULL DEFAULT '',
  -- Read from the token contract for pools whose launch we never indexed; NULL until then.
  symbol      TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pools_pool ON pools(pool_id);

CREATE TABLE IF NOT EXISTS pool_peaks (
  pool_id    TEXT PRIMARY KEY,
  min_sqrt   TEXT NOT NULL,
  max_sqrt   TEXT NOT NULL,
  min_block  INTEGER NOT NULL,
  max_block  INTEGER NOT NULL,
  last_sqrt  TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  swaps      INTEGER NOT NULL,
  to_block   INTEGER NOT NULL
) STRICT;

-- The board's event log: launch, status, graduate and loss events as JSON (src/types.ts BoardEvent),
-- appended by state.ts and losses.ts in the watcher, read by board.ts in the API process.
-- seq is the SSE cursor. Writers prune rows older than 24 hours; readers never depend on old rows.
CREATE TABLE IF NOT EXISTS board_events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  token   TEXT,
  ts      INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_board_events_ts ON board_events(ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Answers that cost minutes to compute, kept so a restart does not start from nothing. The API
-- holds them in memory; this is only what it reads back after it is restarted. Losing the table
-- costs one slow warm-up and nothing else, so nothing here is authoritative.
-- The rank table, one row per qualified wallet, written by the scanning worker once an hour and
-- read by the report worker at boot. Computing it takes most of two minutes; loading it takes
-- two seconds, and a fresh process used to answer no reports until it had computed its own.
CREATE TABLE IF NOT EXISTS rank_table (
  wallet     TEXT PRIMARY KEY,
  rank       INTEGER NOT NULL,
  percentile REAL NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS slow_answers (
  key  TEXT PRIMARY KEY,
  at   INTEGER NOT NULL,
  json TEXT NOT NULL
) STRICT;
`;

/**
 * Columns added after the first deploy, applied to databases that predate them. Nullable, so an
 * old row is valid until the code fills it in.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  // The flight number, assigned once when the launch row is written (board.flightNumber).
  { table: "launches", column: "flight", ddl: "ALTER TABLE launches ADD COLUMN flight INTEGER" },
  // The pool's own copy of the pair, for tokens that graduated before the launches record begins.
  { table: "pools", column: "quote_token", ddl: "ALTER TABLE pools ADD COLUMN quote_token TEXT NOT NULL DEFAULT ''" },
  { table: "pools", column: "symbol", ddl: "ALTER TABLE pools ADD COLUMN symbol TEXT" },
];
const AFTER_MIGRATIONS = `
CREATE INDEX IF NOT EXISTS ix_launches_flight ON launches(flight);
`;

export type DB = DatabaseSync;

/**
 * How long a writer waits for the lock before giving up. Thirty seconds is right for a job whose
 * only alternative is to die and redo the work; it is exactly wrong for the process serving the
 * site, where a blocked write is a frozen page. The API asks for a short one and treats a refused
 * write as a write not worth making.
 */
export const BUSY_MS = { patient: 30_000, serving: 1_500 } as const;

export function openDb(path: string = CFG.dbPath, opts: { busyMs?: number } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Five seconds was not enough the first time two folds and the watcher wrote at once: a chunk
  // transaction can hold the write lock for longer than that, and the loser died with "database is
  // locked" rather than waiting its turn. Waiting is the right answer for a background job.
  //
  // It is the wrong answer for the process serving the site. node:sqlite is synchronous, so a wait
  // is the whole event loop stopped: one analytics write behind a minute-long scan took the site
  // down for half a minute at a time, and nothing in the logs said so, because waiting is not an
  // error. Whoever opens this decides which of the two they are.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyMs ?? BUSY_MS.patient))}`);
  // The timeout only helps a transaction that asked for the write lock at the start. A plain BEGIN
  // is deferred: it takes a read lock on the first statement and tries to upgrade on the first
  // write, and if another writer committed in between SQLite fails that upgrade instantly with
  // "database is locked" — waiting there could deadlock, so it does not wait, whatever the timeout
  // says. That is what killed the backfill every few minutes while the watcher wrote beside it.
  // Every transaction in this project writes, so every one of them says BEGIN IMMEDIATE.
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
  db.exec(AFTER_MIGRATIONS);
  assignFlights(db);
  return db;
}

/**
 * Gives every launch without a flight number one, in (block, log_index) order after the highest
 * number already assigned. A no-op once every row has one; the ingest assigns numbers as it
 * writes rows, so this only runs for real on a database from before the column existed.
 */
export function assignFlights(db: DB): number {
  const missing = db.prepare("SELECT COUNT(*) AS c FROM launches WHERE flight IS NULL").get() as { c: number };
  if (!missing.c) return 0;
  db.exec(`
    UPDATE launches SET flight = x.n
      FROM (SELECT token, (SELECT COALESCE(MAX(flight), 0) FROM launches) + ROW_NUMBER() OVER (ORDER BY block, log_index) AS n
              FROM launches WHERE flight IS NULL) AS x
     WHERE x.token = launches.token AND launches.flight IS NULL`);
  return missing.c;
}

export const getMeta = (db: DB, key: string): string | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setMeta = (db: DB, key: string, value: string): void => {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};

/** 1e18 wei to ETH as a float. For sorting and display, never for exactness. */
export const toEth = (wei: bigint): number => Number(wei) / 1e18;

/** Unix seconds now. */
export const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Arbitrum Nitro can reorganise recent blocks before L1 finality. Writes are upserts keyed on the
 * chain identifier, so a replay corrects rows; this removes what an orphaned block left behind.
 * Folded positions cannot be unwound, so the fold cursor should trail the head by a safe margin.
 */
export function rollbackFrom(db: DB, block: number): void {
  for (const t of ["launches", "curve_trades", "fee_events", "fee_recipient_changes", "losses"]) {
    db.prepare(`DELETE FROM ${t} WHERE block >= ?`).run(block);
  }
  db.prepare("UPDATE launches SET graduated_ts = NULL, graduated_block = NULL WHERE graduated_block >= ?").run(block);
  db.prepare("DELETE FROM exemptions WHERE token NOT IN (SELECT token FROM launches)").run();
  db.prepare("DELETE FROM token_state WHERE token NOT IN (SELECT token FROM launches)").run();
}
