/**
 * Shared types: the contract between the state, report, card, api and web builders.
 *
 * Rules of the file: types only, no runtime code (a few `const` label lists are the exception, so
 * nobody retypes the strings). Every payload the API returns is one of these. Changes are made by
 * agreement between owners, never quietly; docs/api.md and web/mock/*.json follow every change.
 *
 * Conventions: addresses are lowercase 0x strings (40 hex); timestamps are unix seconds; money in
 * USD is a float (already converted with the price book); wei amounts are decimal strings, never
 * numbers; "Usd" fields are signed: losses are negative unless the field name says loss.
 */

/** Lowercase 0x-prefixed address. */
export type Address = string;
/** Unix seconds. */
export type Ts = number;

// ---------------------------------------------------------------- tokens and the board

/**
 * A token's status on the departures board, from live events (SPEC 3.1):
 *   boarding   TokenLaunched seen, still trading
 *   arrived    PoolGraduated seen
 *   departed   no trade for 10 minutes and last price at or below 10% of peak
 *   cancelled  price at or below 10% of peak inside the first 10 minutes after launch
 */
export type TokenStatus = "boarding" | "arrived" | "departed" | "cancelled";
export const TOKEN_STATUSES: readonly TokenStatus[] = ["boarding", "arrived", "departed", "cancelled"];

/**
 * The deployer of a token we know only through its Uniswap pool: it graduated before our launch
 * record begins, so there is no pilot to name. Pages and the pass branch on this rather than
 * printing the zero address as if it were a wallet. Lives here, not in report.ts, so the card
 * worker can read it without pulling the whole report module into its thread.
 */
export const NO_DEPLOYER = "0x0000000000000000000000000000000000000000";

/**
 * What state.applyLaunch is given: the launches row as the watcher knows it after enrichment.
 * `deployer` here is the person: launch_sender (tx.from) when known, else the event's deployer.
 */
export type LaunchRecord = {
  token: Address;
  curve: Address;
  deployer: Address;
  /** Zero address for ETH, otherwise the quote ERC-20. */
  pair: Address;
  /** Symbol of the quote asset (ETH, USDG, cbBTC, NVDA...), "?" when unresolved. */
  pairSymbol: string;
  symbol: string | null;
  name: string | null;
  ts: Ts;
  block: number;
  logIndex: number;
};

/**
 * Flight code "RK-<n>": n is the `flight` column of the token's launches row, assigned once as
 * the row is written (the next number after the highest on record, so launches number in the
 * order they were seen). Read by board.flightNumber; state.applyLaunch uses the same function so
 * the launch event and the replay agree. The boarding pass always says RK-67.
 */
export type FlightCode = `RK-${number}`;

export type LaunchEvent = {
  kind: "launch";
  token: Address;
  symbol: string;
  name: string;
  deployer: Address;
  pair: Address;
  pairSymbol: string;
  ts: Ts;
  flight: FlightCode;
};

/**
 * The rest of the board line, carried on every status change so a client that is not already
 * showing the token can print the whole row. The board reserves slots for tokens whose status
 * changed, and most of those launched long before the twelve lines it is showing.
 */
export type RowContext = {
  flight: FlightCode;
  pair: Address;
  pairSymbol: string;
  /** Launch time, so the Time cell reads the same as it does in the replay. */
  launchTs: Ts;
};

export type StatusEvent = {
  kind: "status";
  token: Address;
  symbol: string;
  status: TokenStatus;
  ts: Ts;
} & RowContext;

export type GraduateEvent = {
  kind: "graduate";
  token: Address;
  symbol: string;
  ts: Ts;
} & RowContext;

/** One line of the passenger tape: a realized loss of $20 or more, as it lands. */
export type LossEvent = {
  kind: "loss";
  wallet: Address;
  token: Address;
  symbol: string;
  /** Positive number of dollars lost. */
  lossUsd: number;
  /** Minutes between the wallet's first buy of this token and the sell that crystallised the loss. */
  minutesSinceBuy: number;
  ts: Ts;
};

export type CountersEvent = {
  kind: "counters";
  /** Sum of realized losses in the rolling 24 hours, positive dollars. */
  lostTodayUsd: number;
  /** Whole days since the last token went cancelled. 0 on any normal day. */
  daysSinceCancelled: number;
  turbulence: { score: number; label: TurbulenceLabel };
  ts: Ts;
};

export type BoardEvent = LaunchEvent | StatusEvent | GraduateEvent | LossEvent | CountersEvent;
export type BoardEventKind = BoardEvent["kind"];

/** One row of the departures board: a launch with its current status. */
export type BoardRow = {
  token: Address;
  symbol: string;
  name: string;
  flight: FlightCode;
  deployer: Address;
  pair: Address;
  pairSymbol: string;
  /** Launch time. */
  ts: Ts;
  status: TokenStatus;
  /** When the status was last set; equals ts while boarding. */
  statusTs: Ts;
};

/**
 * What a board client gets on connect (the SSE `replay` event) and what board.recentBoard returns.
 * `seq` is the board_events cursor: reconnect with `?since=<seq>` (or Last-Event-ID) to get only
 * what happened after it.
 */
export type BoardReplay = {
  /** Last 12 launches, newest first. */
  rows: BoardRow[];
  /** Last 20 losses, newest first. */
  losses: LossEvent[];
  counters: CountersEvent;
  /** $REKT's address, null before launch. Drives the ticker line. */
  ca: Address | null;
  seq: number;
};

// ---------------------------------------------------------------- turbulence

export type TurbulenceLabel = "Clear skies" | "Light chop" | "Moderate" | "Severe" | "Extreme";
export const TURBULENCE_LABELS: readonly TurbulenceLabel[] = ["Clear skies", "Light chop", "Moderate", "Severe", "Extreme"];

/** SPEC 3.4: score = round(100 × (0.6 W + 0.4 D)) over a rolling window. */
export type Turbulence = {
  score: number;
  label: TurbulenceLabel;
  /** Share (0..1) of wallets that traded in the window and ended it with negative realized PnL. */
  w: number;
  /** Share (0..1) of tokens launched in the window that are departed or cancelled. */
  d: number;
  /** Window length in seconds. 86400 for v1. */
  window: number;
};

// ---------------------------------------------------------------- the report

export type ClassName =
  | "Certified Exit Liquidity"
  | "Rug Magnet"
  | "Bagholder"
  | "Standard Rekt"
  | "Lightly Toasted"
  | "Survivor"
  | "The House"
  | "Untouchable";
export const CLASS_NAMES: readonly ClassName[] = [
  "Certified Exit Liquidity", "Rug Magnet", "Bagholder", "Standard Rekt", "Lightly Toasted", "Survivor", "The House", "Untouchable",
];

export type BadgeId = "sniper" | "fastest_rekt" | "serial_buyer" | "diamond_coffin" | "exit_row" | "survivor" | "frequent_flyer";
export const BADGE_IDS: readonly BadgeId[] = ["sniper", "fastest_rekt", "serial_buyer", "diamond_coffin", "exit_row", "survivor", "frequent_flyer"];

export type Badge = {
  id: BadgeId;
  /** Display name, e.g. "Diamond Coffin". */
  label: string;
  /** One deadpan line, e.g. "Still holding DUCKLING. Departed 6 h ago." */
  detail: string;
};

/** A deployer's record, from launches joined with token_state and trader_positions. */
export type DeployerRecord = {
  launches: number;
  /** Share (0..1) of their launches that are departed or cancelled. */
  deadShare: number;
  /** Distinct wallets with negative realized PnL on any of their tokens. */
  losers: number;
};

export type WorstFlight = {
  token: Address;
  symbol: string;
  /** Positive dollars lost on this position. */
  lossUsd: number;
  /** First buy. */
  boughtTs: Ts;
  /** True when the token is departed or cancelled. */
  dead: boolean;
  deployer: Address;
  deployerRecord: DeployerRecord;
};

export type BestFlight = {
  token: Address;
  symbol: string;
  /** Positive dollars gained. */
  gainUsd: number;
};

/** GET /api/report/:address. SPEC 3.2. All from trader_positions joined with launches. */
export type Report = {
  address: Address;
  /** Timestamp of the first folded block (meta.fold_from_block); the page says "since <date>". */
  since: Ts;
  /**
   * Net realized PnL: Σ over priced positions of quote_out − quote_in × min(1, tokens_out/tokens_in),
   * in USD. Negative for most people. The pass prints it as "Total loss".
   */
  netRealizedUsd: number;
  /** Realized losses only: the same sum over positions whose realized PnL is negative. Always ≤ 0. */
  realizedUsd: number;
  /** Cost-basis-free value of bags still held, twenty largest by cost priced by getReserves, rest zero. Approximate. */
  bagsUsd: number;
  /** Positions with tokens still held (tokens_in − tokens_out > 0). "12 still at claim". */
  bagsHeld: number;
  /** Σ quote_in + quote_out in USD over priced positions. */
  volumeUsd: number;
  /** Distinct tokens with a position. */
  tokensTraded: number;
  buys: number;
  sells: number;
  firstTs: Ts;
  lastTs: Ts;
  /** 1-based rank by net realized PnL among qualified wallets (3 or more trades); null when not qualified. */
  rank: number | null;
  /** Qualified wallets in the snapshot. */
  ofWallets: number;
  /** 0..100, share of qualified wallets with a worse net PnL; null when not qualified. */
  percentile: number | null;
  className: ClassName;
  worst: WorstFlight | null;
  best: BestFlight | null;
  /** At most three. */
  badges: Badge[];
  /** Other wallets with a negative position on the worst token and their combined loss (positive dollars). */
  notAlone: { wallets: number; lostUsd: number } | null;
  /** Positions in a quote asset the price book cannot price; excluded from every USD figure above. */
  unpricedPositions: number;
  /**
   * Positions sold beyond what the record saw bought: the purchase is older than the window, so
   * their profit or loss is not claimed either way. 24% of positions in a ten-hour window.
   */
  outsideRecordPositions: number;
  /** $REKT's address, null before launch. */
  ca: Address | null;
};

/** The hourly in-memory snapshot the rank comes from (report.refreshRankSnapshot). */
export type RankSnapshot = {
  builtAt: Ts;
  /** Qualified wallets, sorted by net realized USD descending. */
  wallets: number;
};

// ---------------------------------------------------------------- leaderboards and token page

export type HallWindow = "24h" | "all";

/** Hall of Rekt row: a wallet by realized losses. */
export type HallRow = {
  wallet: Address;
  /** Positive dollars lost in the window. */
  lossUsd: number;
  /** Distinct tokens the losses came from. */
  tokens: number;
  /** Symbol of the token that cost the most. */
  worstSymbol: string;
};

/** Airlines row: a deployer (launch_sender, falling back to deployer). */
export type AirlineRow = {
  deployer: Address;
  launches: number;
  /** Share (0..1) departed or cancelled. "98% cancelled". */
  deadShare: number;
  /** Distinct wallets that lost money on their tokens. */
  losers: number;
  /** Positive dollars those wallets lost, combined. */
  lostUsd: number;
};

/** GET /api/token/:token and the /t/:token page. */
export type TokenPage = {
  token: Address;
  symbol: string;
  name: string;
  status: TokenStatus;
  bornTs: Ts;
  /** When it went departed or cancelled; null while boarding or arrived. */
  diedTs: Ts | null;
  /** Peak price over launch price; null when the curve has not been indexed. */
  peakMultiple: number | null;
  /** Minutes from born to died, or to now while alive. */
  lifespanMin: number;
  /** Wallets with a negative realized position here. */
  losers: number;
  /** Their combined loss, positive dollars. */
  lostUsd: number;
  /** The single largest realized loss here, positive dollars. */
  biggestLossUsd: number;
  deployer: Address;
  deployerRecord: DeployerRecord;
};

// ---------------------------------------------------------------- compensation desk

export type RecipientKind = "wallet" | "splitter" | "none";
export type ContractStatus = "planned" | "in progress" | "live";

export type LedgerRow = {
  ts: Ts;
  tx: string;
  /** Dollars distributed in that transaction. */
  amountUsd: number;
  /** Number of recipients (stakers) paid. */
  recipients: number;
};

/** GET /api/desk. Wei fields are decimal strings. */
export type Desk = {
  /** The current creator fee recipient of $REKT: the fee wallet, the splitter, or null before launch. */
  recipient: Address | null;
  recipientKind: RecipientKind;
  /** escrow.balanceOf(recipient): earned, not yet claimed. */
  accruedWei: string;
  accruedUsd: number;
  /** ETH balance of the recipient, claimed and unspent. */
  walletWei: string;
  /**
    * What holders are owed by the rule, in dollars. Zero until the splitter is the fee recipient:
    * the rule starts at that transaction, and what the token earned before it is not holders' money.
    */
  holdersHalfUsd: number;
  /** Whether the split is running, i.e. whether the splitter is the recipient on the factory. */
  sharing: boolean;
  contracts: {
    splitter: Address | null;
    staking: Address | null;
    status: ContractStatus;
  };
  /** Distributions so far, newest first. Empty at launch. */
  ledger: LedgerRow[];
  ca: Address | null;
};

// ---------------------------------------------------------------- health

/** GET /api/health. Never cached. */
/** One indexed stream's depth: what it covers and what it still has to read. */
export type StreamCoverage = {
  fromBlock: number;
  toBlock: number;
  /** Days of chain the stream covers. */
  days: number;
  /** Days it still has to read before it reaches the Pons v2 start. */
  missingDays: number;
  /**
   * Days already folded by a backward extension that has not yet joined the covered range. They
   * are real trades, but the blocks between them and `fromBlock` are still a hole, so they do not
   * count towards `days` until the extension closes.
   */
  extendingDays: number;
  complete: boolean;
};

/**
 * How deep the record is. The site answers from the database, so this is the honest limit of every
 * answer it gives; a monitor watches `complete` and a page prints `missing`.
 */
export type Coverage = {
  curve: StreamCoverage;
  pools: StreamCoverage;
  v2StartBlock: number;
  complete: boolean;
  missing: string | null;
};

export type Health = {
  /** latestBlock − foldCursor. */
  lagBlocks: number;
  /** lagBlocks converted at BLOCKS_PER_SECOND. Banner: yellow from 30, red from 120. */
  lagSeconds: number;
  /** Seconds since the watcher's last heartbeat (meta.live_seen_at); null when it has never run. */
  watcherAgeSeconds: number | null;
  /** meta.fold_to_block; null before the first fold. */
  foldCursor: number | null;
  /** Head block as last seen by the watcher (meta.live_head_block). */
  latestBlock: number | null;
  /** lagSeconds < 120 and watcherAgeSeconds < 120. */
  ok: boolean;
  /** How deep the record is; `complete` false means the backfill is still reading. */
  records: Coverage;
};

// ---------------------------------------------------------------- errors

/** Every non-2xx JSON body. `hint` is one deadpan sentence the page may print. */
export type ApiError = { error: string; hint: string };
