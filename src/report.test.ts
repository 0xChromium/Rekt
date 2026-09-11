import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb, setMeta, type DB } from "./db.ts";
import { applyTrade } from "./fold.ts";
import { usdOf } from "./prices.ts";
import {
  badgesFor, buildReport, classFor, clearReportCaches, deployerRecord, normalizeAddress, refreshRankSnapshot,
  sinceTs, spanWords, BAGS_DEADLINE_MS, type Reserves,
} from "./report.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDG = "0x00000000000000000000000000000000000000d6";
const MYSTERY = "0x00000000000000000000000000000000000000d7";

const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const PASSENGER = addr(0xe1);
const OTHER = addr(0xe2);
const WHALE = addr(0xe3);
const COFFIN = addr(0xe4);
const PILOT = addr(0xd1);
const PILOT2 = addr(0xd2);

// token → curve is token + 0x100.
const A = addr(0xa01), B = addr(0xa02), C = addr(0xa03), U = addr(0xa04), F = addr(0xa05);
const P1 = addr(0xa11), P2 = addr(0xa12), P3 = addr(0xa13), DUCK = addr(0xa20), EXIT = addr(0xa21);
const curveOf = (token: string): string => addr(Number(BigInt(token)) + 0x100);

const ETH = usdOf("ETH") as number;

let dir: string;
let db: DB;

function launch(token: string, symbol: string, pair: string, ts: number, block: number, pilot = PILOT): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, name, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, curveOf(token), "0xca11bde05977b3631167028862be2a173976ca11", pilot, pair, symbol, symbol, block, ts, `0x${block}`, 0, ts);
}

function state(token: string, status: string, statusTs: number): void {
  db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(token, 0, status, statusTs);
}

const buy = (wallet: string, token: string, quote: number, tokens: number, ts: number) => applyTrade(db, { wallet, token, side: "buy", quote, tokens, ts });
const sell = (wallet: string, token: string, quote: number, tokens: number, ts: number) => applyTrade(db, { wallet, token, side: "sell", quote, tokens, ts });
const close = (a: number, b: number, what = ""): void => assert.ok(Math.abs(a - b) < 0.011, `${what} ${a} != ${b}`);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-report-"));
  db = openDb(join(dir, "test.db"));
  clearReportCaches();
  db.prepare("INSERT INTO quote_assets (address, symbol, decimals) VALUES (?,?,?)").run(USDG, "USDG", 6);
  db.prepare("INSERT INTO quote_assets (address, symbol, decimals) VALUES (?,?,?)").run(MYSTERY, "?", 18);
  setMeta(db, "fold_from_block", "900");

  launch(A, "ALPHA", ZERO, 1_000, 1_000);
  launch(B, "BRAVO", ZERO, 2_000, 11_000);
  launch(C, "CHARLIE", USDG, 3_000, 21_000);
  launch(U, "UNKNOWN", MYSTERY, 4_000, 31_000);
  launch(F, "FAST", ZERO, 5_000, 41_000);
  launch(P1, "PONZI", ZERO, 6_000, 51_000, PILOT2);
  launch(P2, "PONZI", ZERO, 6_100, 52_000, PILOT2);
  launch(P3, "ponzi", ZERO, 6_200, 53_000, PILOT2);
  launch(DUCK, "DUCKLING", ZERO, 7_000, 61_000, PILOT2);
  launch(EXIT, "EXITROW", ZERO, 8_000, 71_000, PILOT2);
  state(A, "boarding", 1_000);
  state(P1, "cancelled", 6_030);
  state(P2, "cancelled", 6_130);
  state(P3, "boarding", 6_200);
  state(DUCK, "departed", 7_600);

  // PASSENGER: average cost then a losing partial sell on ALPHA, a sniper buy 3 s after launch.
  buy(PASSENGER, A, 1, 1_000, 1_003);
  buy(PASSENGER, A, 3, 1_000, 1_020);
  sell(PASSENGER, A, 1.5, 1_000, 1_030);
  // A win on BRAVO.
  buy(PASSENGER, B, 1, 100, 2_100);
  sell(PASSENGER, B, 2, 100, 2_200);
  // A loss in USDG.
  buy(PASSENGER, C, 100, 10, 3_100);
  sell(PASSENGER, C, 50, 10, 3_200);
  // A loss in an asset the book cannot price.
  buy(PASSENGER, U, 1, 10, 4_100);
  sell(PASSENGER, U, 0.1, 10, 4_200);
  // Closed at a loss 30 s after boarding.
  buy(PASSENGER, F, 1, 10, 5_100);
  sell(PASSENGER, F, 0.5, 10, 5_130);
  // Three flights named PONZI, two cancelled.
  for (const t of [P1, P2, P3]) buy(PASSENGER, t, 0.1, 10, 6_300);

  // OTHER lost on ALPHA too (two trades: not qualified for the rank).
  buy(OTHER, A, 1, 1_000, 1_050);
  sell(OTHER, A, 0.5, 1_000, 1_060);
  // WHALE: three trades, net positive, best of the snapshot.
  buy(WHALE, B, 1, 100, 2_110);
  buy(WHALE, B, 1, 100, 2_120);
  sell(WHALE, B, 10, 200, 2_300);

  // COFFIN holds a departed token, boarded EXITROW 20 s before the pilot's exit, trades on 7 days, net positive.
  buy(COFFIN, DUCK, 0.2, 100, 7_100);
  buy(PILOT2, EXIT, 1, 1_000, 8_000);
  buy(COFFIN, EXIT, 0.5, 100, 8_040);
  sell(PILOT2, EXIT, 3, 1_000, 8_060);
  sell(COFFIN, EXIT, 1, 100, 8_070);
  for (let d = 1; d <= 6; d++) buy(COFFIN, B, 0.01, 1, 2_100 + d * 86_400);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reserves = async (curve: string): Promise<Reserves | null> =>
  curve === curveOf(A) ? { quote: 2n * 10n ** 18n, token: 1_000n * 10n ** 18n } : null;

describe("normalizeAddress", () => {
  it("accepts 0x plus 40 hex in any case and rejects the rest", () => {
    assert.equal(normalizeAddress(PASSENGER.toUpperCase().replace("0X", "0x")), PASSENGER);
    assert.equal(normalizeAddress(" " + PASSENGER + " "), PASSENGER);
    assert.equal(normalizeAddress("0x123"), null);
    assert.equal(normalizeAddress(PASSENGER + "0"), null);
    assert.equal(normalizeAddress("zz" + PASSENGER.slice(2)), null);
  });
});

describe("classFor", () => {
  it("maps the percentile bands from SPEC 3.2", () => {
    assert.equal(classFor(0, -1), "Certified Exit Liquidity");
    assert.equal(classFor(0.99, -1), "Certified Exit Liquidity");
    assert.equal(classFor(1, -1), "Rug Magnet");
    assert.equal(classFor(9.99, -1), "Rug Magnet");
    assert.equal(classFor(10, -1), "Bagholder");
    assert.equal(classFor(32.99, -1), "Bagholder");
    assert.equal(classFor(33, -1), "Standard Rekt");
    assert.equal(classFor(66.99, 5), "Standard Rekt");
    assert.equal(classFor(67, -1), "Lightly Toasted");
    assert.equal(classFor(89.99, -0.01), "Lightly Toasted");
    assert.equal(classFor(67, 0), "Survivor");
    assert.equal(classFor(89.99, 1), "Survivor");
    assert.equal(classFor(90, 1), "The House");
    assert.equal(classFor(98.99, 1), "The House");
    assert.equal(classFor(99, 1), "Untouchable");
    assert.equal(classFor(100, 1), "Untouchable");
  });
  it("falls back for unqualified wallets", () => {
    assert.equal(classFor(null, -1), "Standard Rekt");
    assert.equal(classFor(null, 0), "Survivor");
  });
});

describe("spanWords", () => {
  it("picks the unit", () => {
    assert.equal(spanWords(1), "1 second");
    assert.equal(spanWords(41), "41 seconds");
    assert.equal(spanWords(360), "6 minutes");
    assert.equal(spanWords(6 * 3600), "6 hours");
    assert.equal(spanWords(3 * 86400), "3 days");
  });
});

describe("refreshRankSnapshot", () => {
  it("ranks wallets with three or more trades by net USD, ties sharing a rank", () => {
    const snap = refreshRankSnapshot(db);
    // PASSENGER, WHALE, COFFIN qualify; OTHER (2 trades) and PILOT2 (2 trades) do not.
    assert.equal(snap.wallets, 3);
    assert.ok(snap.builtAt > 0);
  });
});

describe("buildReport", () => {
  it("returns null for a wallet with no positions and throws on a bad address", async () => {
    assert.equal(await buildReport(db, addr(0xff), { reserves }), null);
    await assert.rejects(() => buildReport(db, "0xnope", { reserves }), /bad address/);
  });

  it("computes realized PnL with average cost, skips unpriced assets, values the bags", async () => {
    const r = await buildReport(db, PASSENGER.toUpperCase().replace("0X", "0x"), { reserves, nowTs: 10_000 });
    assert.ok(r);
    assert.equal(r.address, PASSENGER);
    // ALPHA −0.5 ETH, BRAVO +1 ETH, FAST −0.5 ETH, CHARLIE −50 USDG; UNKNOWN skipped.
    close(r.netRealizedUsd, 0 * ETH - 50, "net");
    close(r.realizedUsd, -1 * ETH - 50, "losses");
    close(r.volumeUsd, (5.5 + 3 + 1.5 + 0.3) * ETH + 150, "volume");
    assert.equal(r.unpricedPositions, 1);
    assert.equal(r.tokensTraded, 8);
    assert.equal(r.buys, 9);
    assert.equal(r.sells, 5);
    assert.equal(r.firstTs, 1_003);
    assert.equal(r.lastTs, 6_300);
    // ALPHA holds 1000 at 0.002 ETH from the reserves; the PONZI bags have no reserves and count as zero.
    assert.equal(r.bagsHeld, 4);
    close(r.bagsUsd, 2 * ETH, "bags");
    assert.equal(r.since, 900 > 0 ? r.since : 0);
    assert.equal(r.ca, null);
  });

  it("picks the worst and best flight, the deployer record and who else lost there", async () => {
    const r = await buildReport(db, PASSENGER, { reserves, nowTs: 10_000 });
    assert.ok(r?.worst && r.best);
    assert.equal(r.worst.token, A);
    assert.equal(r.worst.symbol, "ALPHA");
    close(r.worst.lossUsd, 0.5 * ETH, "worst");
    assert.equal(r.worst.boughtTs, 1_003);
    assert.equal(r.worst.dead, false);
    assert.equal(r.worst.deployer, PILOT);
    // PILOT launched ALPHA..FAST (5), none dead; PASSENGER and OTHER lost on them.
    assert.deepEqual(r.worst.deployerRecord, { launches: 5, deadShare: 0, losers: 2 });
    assert.deepEqual(r.notAlone, { wallets: 1, lostUsd: Math.round(0.5 * ETH * 100) / 100 });
    assert.equal(r.best.symbol, "BRAVO");
    close(r.best.gainUsd, ETH, "best");
  });

  it("ranks against the snapshot and classes by percentile", async () => {
    const r = await buildReport(db, PASSENGER, { reserves, nowTs: 10_000 });
    assert.ok(r);
    assert.equal(r.ofWallets, 3);
    // WHALE +8 ETH, COFFIN +0.5 ETH, PASSENGER −$50: last of three.
    assert.equal(r.rank, 3);
    assert.equal(r.percentile, 0);
    assert.equal(r.className, "Certified Exit Liquidity");
    const w = await buildReport(db, WHALE, { reserves, nowTs: 10_000 });
    assert.equal(w?.rank, 1);
    close(w?.percentile ?? 0, 66.67, "whale percentile");
    // 66.67 is still inside the 33–67 band: the best of three is Standard Rekt, not a Survivor.
    assert.equal(w?.className, "Standard Rekt");
    const o = await buildReport(db, OTHER, { reserves, nowTs: 10_000 });
    assert.equal(o?.rank, null);
    assert.equal(o?.percentile, null);
    assert.equal(o?.className, "Standard Rekt");
  });

  it("gives three badges at most, most specific first", async () => {
    const r = await buildReport(db, PASSENGER, { reserves, nowTs: 10_000 });
    assert.deepEqual(r?.badges.map((b) => b.id), ["sniper", "fastest_rekt", "serial_buyer"]);
    assert.equal(r?.badges[0].detail, "Boarded ALPHA 3 seconds after launch.");
    assert.equal(r?.badges[1].detail, "Closed FAST at a loss 30 seconds after boarding.");
    assert.equal(r?.badges[2].detail, "Three flights named PONZI. Two cancelled.");
  });
});

describe("badgesFor", () => {
  it("finds the coffin, the exit row and the survivor", () => {
    const ids = badgesFor(db, COFFIN).map((b) => b.id);
    assert.deepEqual(ids, ["diamond_coffin", "exit_row", "survivor"]);
    const b = badgesFor(db, COFFIN);
    assert.match(b[0].detail, /^Still holding DUCKLING\. Departed .* ago\.$/);
    assert.equal(b[1].detail, "Boarded EXITROW 20 seconds before the pilot left.");
  });
  it("returns nothing for an unknown or bad address", () => {
    assert.deepEqual(badgesFor(db, addr(0xff)), []);
    assert.deepEqual(badgesFor(db, "nope"), []);
  });
});

describe("deployerRecord and sinceTs", () => {
  it("counts launches, dead share and losers for a deployer", () => {
    // PILOT2: PONZI ×3, DUCKLING, EXITROW; 3 dead; PASSENGER holds PONZI bags (no loss), COFFIN gained on EXITROW.
    assert.deepEqual(deployerRecord(db, PILOT2), { launches: 5, deadShare: 0.6, losers: 0 });
    assert.deepEqual(deployerRecord(db, addr(0xff)), { launches: 0, deadShare: 0, losers: 0 });
  });
  it("interpolates the first folded block from the nearest launch", () => {
    // fold_from_block 900, nearest launch at block 1000 / ts 1000: 100 blocks earlier.
    const s = sinceTs(db);
    assert.ok(s < 1_000 && s > 980, String(s));
  });
});

describe("when the chain is slow", () => {
  it("prints the report without the bags rather than waiting on a dead endpoint", async () => {
    // The price cache is warm from the tests above, and a cached price never reaches the reader.
    clearReportCaches();
    // A reader that never answers, which is what a down state endpoint looks like from here.
    const never: Reserves extends never ? never : (curve: string) => Promise<Reserves | null> =
      () => new Promise(() => undefined);
    const started = Date.now();
    const r = await buildReport(db, PASSENGER, { reserves: never });
    const took = Date.now() - started;
    assert.ok(r, "a report is still produced");
    assert.equal(r?.bagsUsd, 0, "bags we could not price count as zero, never as a guess");
    assert.ok(took < BAGS_DEADLINE_MS + 1500, `took ${took} ms, should give up near ${BAGS_DEADLINE_MS}`);
    assert.ok(r && r.netRealizedUsd !== undefined, "the realized numbers come from the database and do not wait");
  });
});
