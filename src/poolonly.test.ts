import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { now, openDb, setMeta, type DB } from "./db.ts";
import { applyTrade } from "./fold.ts";
import { airlines, clearLeaderboardCache, hallOfRekt } from "./leaderboards.ts";
import { usdOf } from "./prices.ts";
import {
  buildReport, clearReportCaches, NO_DEPLOYER, NO_DEPLOYER_RECORD, refreshRankSnapshot, usdCaseSql, type Reserves,
} from "./report.ts";
import { tokenPage } from "./tokenpage.ts";
import { clearTurbulenceCache, turbulence } from "./turbulence.ts";

/**
 * Positions in tokens we know only through their v4 pool.
 *
 * Seventy per cent of the chain's trading happens in the pools, and a token that graduated before
 * the launches backfill reaches back has a `pools` row and no `launches` row. Every number on the
 * report, the leaderboards, the index and the token page has to count those positions, price them
 * from `pools.quote_token`, and leave the facts only a launch record carries — the pilot above all
 * — plainly absent. Two seeded databases, no chain: one with both kinds of token, one with nothing
 * but pools, so none of this depends on the pool indexer having run.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const STRANGER = "0x00000000000000000000000000000000000000d7"; // an asset the price book never heard of
const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;

const PILOT = addr(0xd1);
const TRADER = addr(0xe1), OTHER = addr(0xe2), WINNER = addr(0xe3), POOLLOSER = addr(0xe4), BLIND = addr(0xe5);
// Tokens with a launch record.
const CURVE = addr(0xc01), CURVE2 = addr(0xc02);
// Tokens known only through their pool: priced, unpriceable, no quote at all, no swaps yet.
const POOL1 = addr(0xb01), POOL2 = addr(0xb02), POOL3 = addr(0xb03), POOL4 = addr(0xb04);

const ETH = usdOf("ETH") as number;
const NOW = 2_000_000;

const Q96 = 2 ** 96;
/** A sqrtPriceX96 that squares to `price`; with the token as currency0 and both sides at 18 decimals that is whole quote per whole token. */
const sqrtAt = (price: number): string => BigInt(Math.round(Math.sqrt(price) * Q96)).toString();

const close = (a: number, b: number, what = ""): void => assert.ok(Math.abs(a - b) < 0.02, `${what}: ${a} != ${b}`);
const buy = (db: DB, wallet: string, token: string, quote: number, tokens: number, ts: number) =>
  applyTrade(db, { wallet, token, side: "buy", quote, tokens, ts });
const sell = (db: DB, wallet: string, token: string, quote: number, tokens: number, ts: number) =>
  applyTrade(db, { wallet, token, side: "sell", quote, tokens, ts });

function launch(db: DB, token: string, symbol: string, ts: number, block: number): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, name, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(token, addr(Number(BigInt(token)) + 0x100), addr(0xca11), PILOT, ZERO, symbol, symbol, block, ts, `0x${block}`, 0, ts);
}

/** A graduated token as the pool indexer records it: no launch row, the pair and ticker kept here. */
function pool(db: DB, token: string, quoteToken: string, symbol: string | null, initPrice: number, initBlock: number): void {
  db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token, symbol)
    VALUES (?,?,?,?,0,18,18,?,?,?,?)`)
    .run(token, `0xpool${token.slice(-3)}`, token, quoteToken || addr(0xfff), initBlock, sqrtAt(initPrice), quoteToken, symbol);
}

function peaks(db: DB, token: string, low: number, high: number, last: number, swaps: number): void {
  db.prepare(`INSERT INTO pool_peaks (pool_id, min_sqrt, max_sqrt, min_block, max_block, last_sqrt, last_block, swaps, to_block)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`0xpool${token.slice(-3)}`, sqrtAt(low), sqrtAt(high), 1_000, 1_100, sqrtAt(last), 1_200, swaps, 1_200);
}

// ---------------------------------------------------------------- both kinds of token

let dir: string;
let db: DB;
let curveReads: string[];
const reserves: Reserves = { quote: 10n ** 18n, token: 1_000n * 10n ** 18n }; // 0.001 quote per token

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-pool-"));
  db = openDb(join(dir, "mixed.db"));
  clearReportCaches();
  curveReads = [];
  setMeta(db, "fold_from_block", "800");

  launch(db, CURVE, "CURVEY", NOW - 5_000, 1_000);
  launch(db, CURVE2, "CURVEY2", NOW - 4_000, 1_100);
  // GRADUATE opened at 0.001 ETH, peaked at 0.004, last traded at 0.002.
  pool(db, POOL1, ZERO, "GRADUATE", 0.001, 900);
  peaks(db, POOL1, 0.0005, 0.004, 0.002, 10);
  pool(db, POOL2, STRANGER, "NOPRICE", 0.001, 910);
  pool(db, POOL3, "", "BLANK", 0.001, 920);
  // No ticker read from the contract yet, and no swap folded yet: priced at what it graduated at.
  pool(db, POOL4, ZERO, null, 0.01, 930);

  // TRADER: a loss and a bag in a pool-only token, a win on the curve, two unpriceable positions.
  buy(db, TRADER, POOL1, 1, 1_000, NOW - 3_000);
  sell(db, TRADER, POOL1, 0.4, 500, NOW - 2_900);
  buy(db, TRADER, POOL2, 1, 100, NOW - 2_800);
  sell(db, TRADER, POOL2, 0.1, 100, NOW - 2_700);
  buy(db, TRADER, POOL3, 1, 100, NOW - 2_600);
  sell(db, TRADER, POOL3, 0.1, 100, NOW - 2_500);
  buy(db, TRADER, CURVE, 1, 100, NOW - 2_400);
  sell(db, TRADER, CURVE, 2, 100, NOW - 2_300);
  buy(db, TRADER, POOL4, 0.05, 5, NOW - 2_200);
  buy(db, TRADER, CURVE2, 0.2, 100, NOW - 2_100);

  // OTHER: 1 ETH down on the same pool token, 0.5 ETH down on the pilot's curve token.
  buy(db, OTHER, POOL1, 1, 500, NOW - 3_000);
  buy(db, OTHER, POOL1, 1, 500, NOW - 2_990);
  sell(db, OTHER, POOL1, 1, 1_000, NOW - 2_800);
  buy(db, OTHER, CURVE, 1, 100, NOW - 2_700);
  sell(db, OTHER, CURVE, 0.5, 100, NOW - 2_600);

  // WINNER trades the curve only; POOLLOSER has never touched anything but a pool.
  buy(db, WINNER, CURVE, 1, 100, NOW - 2_000);
  buy(db, WINNER, CURVE, 1, 100, NOW - 1_900);
  sell(db, WINNER, CURVE, 4, 200, NOW - 1_800);
  buy(db, POOLLOSER, POOL1, 0.5, 500, NOW - 1_700);
  buy(db, POOLLOSER, POOL1, 0.5, 500, NOW - 1_650);
  sell(db, POOLLOSER, POOL1, 0.5, 1_000, NOW - 1_600);
  // BLIND holds nothing we can price: never judged, never ranked.
  buy(db, BLIND, POOL2, 1, 100, NOW - 1_500);
  sell(db, BLIND, POOL2, 0.1, 100, NOW - 1_400);

  db.prepare("INSERT INTO losses (tx, log_index, wallet, token, loss_quote, loss_usd, minutes_since_buy, ts) VALUES (?,?,?,?,?,?,?,?)")
    .run("0xa", 0, POOLLOSER, POOL1, 0.5, 0.5 * ETH, 2, now() - 100);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const readReserves = async (curve: string): Promise<Reserves | null> => { curveReads.push(curve); return reserves; };
const report = (wallet: string) => buildReport(db, wallet, { reserves: readReserves, nowTs: NOW });

describe("usdCaseSql", () => {
  it("keeps its old default and takes any quote expression", () => {
    assert.match(usdCaseSql(db), /^\(CASE l\.pair_token /);
    assert.match(usdCaseSql(db, "COALESCE(l.pair_token, pl.quote_token)"), /^\(CASE COALESCE\(l\.pair_token, pl\.quote_token\) /);
    assert.match(usdCaseSql(db), new RegExp(`WHEN '${ZERO}' THEN ${ETH}`));
  });
});

describe("the report of a wallet with pool-only positions", () => {
  it("counts and prices a token that exists only in pools", async () => {
    const r = await report(TRADER);
    assert.ok(r);
    // POOL1 −0.1 ETH (sold half of a 1 ETH cost for 0.4), CURVE +1 ETH; POOL2 and POOL3 unpriceable.
    close(r.netRealizedUsd, 0.9 * ETH, "net");
    close(r.realizedUsd, -0.1 * ETH, "losses");
    close(r.volumeUsd, (1 + 0.4 + 1 + 2 + 0.05 + 0.2) * ETH, "volume");
    assert.equal(r.tokensTraded, 6);
    assert.equal(r.buys, 6);
    assert.equal(r.sells, 4);
  });

  it("leaves a position in an asset with no dollar price unpriced rather than zero", async () => {
    const r = await report(TRADER);
    // POOL2's quote asset is not in the book, POOL3's pool has no quote at all: two, not zeros.
    assert.equal(r?.unpricedPositions, 2);
    const blind = await report(BLIND);
    assert.equal(blind?.unpricedPositions, 1);
    assert.equal(blind?.netRealizedUsd, 0);
    assert.equal(blind?.volumeUsd, 0);
    assert.equal(blind?.worst, null);
    assert.equal(blind?.rank, null);
  });

  it("values a graduated bag from the pool's last price and the rest from the curve", async () => {
    curveReads = [];
    clearReportCaches();
    const r = await report(TRADER);
    assert.ok(r);
    // 500 GRADUATE at the last swap's 0.002, 5 POOL4 at the 0.01 it graduated at, 100 CURVEY2 at
    // the curve's 0.001. The unpriceable bags count as zero, as they always have.
    assert.equal(r.bagsHeld, 3);
    close(r.bagsUsd, (500 * 0.002 + 5 * 0.01 + 100 * 0.001) * ETH, "bags");
    // Only the curve position cost a chain read: a pool price comes from the database.
    assert.deepEqual(curveReads, [addr(Number(BigInt(CURVE2)) + 0x100)]);
  });

  it("names no pilot for a flight with no launch record", async () => {
    const r = await report(OTHER);
    assert.ok(r?.worst);
    assert.equal(r.worst.token, POOL1);
    assert.equal(r.worst.symbol, "GRADUATE");
    close(r.worst.lossUsd, 1 * ETH, "worst loss");
    assert.equal(r.worst.deployer, NO_DEPLOYER);
    assert.deepEqual(r.worst.deployerRecord, NO_DEPLOYER_RECORD);
    assert.equal(r.worst.dead, false);
    // You are not alone: TRADER −0.1 and POOLLOSER −0.5 on the same flight.
    assert.equal(r.notAlone?.wallets, 2);
    close(r.notAlone?.lostUsd ?? 0, 0.6 * ETH, "not alone");
  });

  it("still names the pilot when the launch is on record", async () => {
    const r = await report(OTHER);
    assert.equal(r?.best?.symbol, undefined); // OTHER lost on both flights
    const t = await report(TRADER);
    assert.equal(t?.best?.token, CURVE);
    assert.equal(t?.best?.symbol, "CURVEY");
    const loser = await report(POOLLOSER);
    assert.equal(loser?.worst?.deployer, NO_DEPLOYER);
  });

  it("ranks a wallet whose losses are all in pool-only tokens", async () => {
    clearReportCaches();
    const snap = refreshRankSnapshot(db);
    // TRADER +0.9, WINNER +2, OTHER −1.5, POOLLOSER −0.5 all have three trades or more; BLIND has
    // nothing priced. Before pools were joined, POOLLOSER had no priced position either.
    assert.equal(snap.wallets, 4);
    const r = await report(POOLLOSER);
    assert.equal(r?.ofWallets, 4);
    assert.equal(r?.rank, 3);
    assert.equal(r?.percentile, 25);
    assert.equal(r?.className, "Bagholder");
  });
});

describe("the leaderboards with pool-only positions", () => {
  it("puts a pool-only loss in the Hall of Rekt with the pool's ticker", () => {
    clearLeaderboardCache(db);
    const rows = hallOfRekt(db, "all", 10);
    const wallets = rows.map((r) => r.wallet);
    assert.ok(wallets.includes(POOLLOSER), `POOLLOSER missing from ${JSON.stringify(wallets)}`);
    const loser = rows.find((r) => r.wallet === POOLLOSER);
    close(loser?.lossUsd ?? 0, 0.5 * ETH, "pool-only loss");
    assert.equal(loser?.worstSymbol, "GRADUATE");
    // OTHER lost on both kinds of token and both count.
    const other = rows.find((r) => r.wallet === OTHER);
    close(other?.lossUsd ?? 0, 1.5 * ETH, "mixed loss");
    assert.equal(other?.worstSymbol, "GRADUATE");
    // BLIND's only loss is in an asset we cannot price: still not in the hall.
    assert.ok(!wallets.includes(BLIND));
  });

  it("reads the ticker of a today loss from the pool as well", () => {
    clearLeaderboardCache(db);
    const rows = hallOfRekt(db, "24h", 10);
    assert.deepEqual(rows.map((r) => [r.wallet, r.worstSymbol]), [[POOLLOSER, "GRADUATE"]]);
  });

  it("keeps pool-only losses off the Airlines board, where they belong to nobody", () => {
    clearLeaderboardCache(db);
    const rows = airlines(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deployer, PILOT);
    assert.equal(rows[0].launches, 2);
    assert.equal(rows[0].losers, 1);
    // OTHER's 0.5 ETH on CURVEY only: the 1 ETH they lost in the pool has no airline to charge.
    close(rows[0].lostUsd, 0.5 * ETH, "airline losses");
  });
});

describe("the turbulence index with pool-only positions", () => {
  it("judges a wallet that only ever traded a pool token", () => {
    clearTurbulenceCache(db);
    const t = turbulence(db, NOW);
    // Judged: TRADER, OTHER, WINNER, POOLLOSER (BLIND has nothing priced). Losers: OTHER, POOLLOSER.
    assert.equal(t.w, 0.5);
    // Both launches are in the window and neither is dead.
    assert.equal(t.d, 0);
    assert.equal(t.score, 30);
    assert.equal(t.label, "Light chop");
  });
});

describe("the token page of a pool-only token", () => {
  it("renders without a launch: arrived, no pilot, the pool's peak", async () => {
    const t = await tokenPage(db, POOL1, { index: false, nowTs: NOW });
    assert.ok(t);
    assert.equal(t.token, POOL1);
    assert.equal(t.symbol, "GRADUATE");
    assert.equal(t.name, "GRADUATE");
    assert.equal(t.status, "arrived");
    assert.equal(t.diedTs, null);
    assert.equal(t.deployer, NO_DEPLOYER);
    assert.deepEqual(t.deployerRecord, NO_DEPLOYER_RECORD);
    // 0.004 at the peak over the 0.001 it opened at.
    assert.equal(t.peakMultiple, 4);
    assert.equal(t.losers, 3);
    close(t.lostUsd, 1.6 * ETH, "lost here");
    close(t.biggestLossUsd, 1 * ETH, "biggest loss here");
    // Born where our record of it begins: the block its pool opened, dated from the nearest launch.
    const expected = NOW - 5_000 - 100 / 9.91;
    assert.ok(Math.abs(t.bornTs - expected) < 5, `born ${t.bornTs} vs ${expected}`);
    assert.ok(t.lifespanMin > 0);
  });

  it("leaves the peak null until a swap is folded and falls back to the address for a ticker", async () => {
    const t = await tokenPage(db, POOL4, { index: false, nowTs: NOW });
    assert.ok(t);
    assert.equal(t.symbol, "0x0000…0b04");
    assert.equal(t.name, "0x0000…0b04");
    assert.equal(t.peakMultiple, null);
    assert.equal(t.status, "arrived");
  });

  it("still returns null for a token in neither table, and the launch page is unchanged", async () => {
    assert.equal(await tokenPage(db, addr(0xffff), { index: false, nowTs: NOW }), null);
    const t = await tokenPage(db, CURVE, { index: false, nowTs: NOW });
    assert.ok(t);
    assert.equal(t.symbol, "CURVEY");
    assert.equal(t.status, "boarding");
    assert.equal(t.bornTs, NOW - 5_000);
    assert.equal(t.deployer, PILOT);
    assert.equal(t.deployerRecord.launches, 2);
    // OTHER −0.5 on the curve token.
    assert.equal(t.losers, 1);
    close(t.lostUsd, 0.5 * ETH, "curve token losses");
  });
});

// ---------------------------------------------------------------- nothing but pools

describe("a database with no launches at all", () => {
  let dir2: string;
  let db2: DB;

  before(() => {
    dir2 = mkdtempSync(join(tmpdir(), "rekt-poolonly-"));
    db2 = openDb(join(dir2, "pools.db"));
    clearReportCaches();
    pool(db2, POOL1, ZERO, "GRADUATE", 0.001, 900);
    peaks(db2, POOL1, 0.0005, 0.004, 0.002, 10);
    buy(db2, TRADER, POOL1, 2, 1_000, NOW - 3_000);
    sell(db2, TRADER, POOL1, 0.5, 500, NOW - 2_000);
    buy(db2, TRADER, POOL1, 1, 500, NOW - 1_000);
    buy(db2, OTHER, POOL1, 1, 100, NOW - 900);
    buy(db2, OTHER, POOL1, 0.5, 50, NOW - 880);
    sell(db2, OTHER, POOL1, 0.2, 150, NOW - 800);
  });

  after(() => {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("still builds a whole report", async () => {
    const r = await buildReport(db2, TRADER, { reserves: async () => null, nowTs: NOW });
    assert.ok(r);
    // Bought 1500 for 3 ETH, sold a third of them for 0.5: −0.5 ETH realized, 1000 still held.
    close(r.netRealizedUsd, -0.5 * ETH, "net");
    assert.equal(r.tokensTraded, 1);
    assert.equal(r.bagsHeld, 1);
    close(r.bagsUsd, 1_000 * 0.002 * ETH, "bags");
    assert.equal(r.unpricedPositions, 0);
    assert.equal(r.worst?.symbol, "GRADUATE");
    assert.equal(r.worst?.deployer, NO_DEPLOYER);
    assert.deepEqual(r.worst?.deployerRecord, NO_DEPLOYER_RECORD);
    assert.equal(r.badges.length, 0);
    assert.equal(r.rank, 1);
    assert.equal(r.ofWallets, 2);
  });

  it("fills the leaderboards, the index and the token page", async () => {
    clearLeaderboardCache(db2);
    clearTurbulenceCache(db2);
    const hall = hallOfRekt(db2, "all", 10);
    assert.deepEqual(hall.map((r) => r.wallet), [OTHER, TRADER]);
    assert.equal(hall[0].worstSymbol, "GRADUATE");
    // Nobody launched anything, so no airline and no launches in the window: D is 0, W is everyone.
    assert.deepEqual(airlines(db2, 10), []);
    const t = turbulence(db2, NOW);
    assert.equal(t.w, 1);
    assert.equal(t.d, 0);
    assert.equal(t.score, 60);
    const page = await tokenPage(db2, POOL1, { index: false, nowTs: NOW });
    // No launch anywhere to date the pool's opening block from: the first trade we folded.
    assert.equal(page?.bornTs, NOW - 3_000);
    assert.equal(page?.peakMultiple, 4);
    assert.equal(page?.losers, 2);
  });
});
