import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb, type DB } from "./db.ts";
import { applyTrade, held, isRangeError, realized } from "./fold.ts";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const CURVE = "0x00000000000000000000000000000000000000cc";
const PILOT = "0x00000000000000000000000000000000000000d1";
const PASSENGER = "0x00000000000000000000000000000000000000e1";
const WAIVED = "0x00000000000000000000000000000000000000f1";

let dir: string;
let db: DB;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-fold-"));
  db = openDb(join(dir, "test.db"));
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN, CURVE, "0xca11bde05977b3631167028862be2a173976ca11", PILOT,
    "0x0000000000000000000000000000000000000000", 100, 1_000, "0xabc", 0, 1_000);
  db.prepare("INSERT INTO exemptions (token, address) VALUES (?,?)").run(TOKEN, WAIVED);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe("applyTrade", () => {
  it("opens a position on the first buy with nothing realized", () => {
    const r = applyTrade(db, { wallet: PASSENGER, token: TOKEN, side: "buy", quote: 1, tokens: 1000, ts: 1_010 });
    assert.equal(r.before, null);
    assert.equal(r.after.buys, 1);
    assert.equal(r.after.quote_in, 1);
    assert.equal(r.after.tokens_in, 1000);
    assert.equal(r.after.first_ts, 1_010);
    assert.equal(r.after.insider, 0);
    close(realized(r.after), 0);
    close(r.realizedDelta, 0);
    close(held(r.after), 1000);
  });

  it("averages the cost across buys", () => {
    // 1 ETH for 1000 and 3 ETH for 1000: average cost 0.002 per token.
    const r = applyTrade(db, { wallet: PASSENGER, token: TOKEN, side: "buy", quote: 3, tokens: 1000, ts: 1_020 });
    assert.equal(r.after.quote_in, 4);
    assert.equal(r.after.tokens_in, 2000);
    close(realized(r.after), 0);
  });

  it("realizes a loss on a partial sell against the average cost", () => {
    // Sells half the bag for 1.5 ETH; that half cost 2 ETH.
    const r = applyTrade(db, { wallet: PASSENGER, token: TOKEN, side: "sell", quote: 1.5, tokens: 1000, ts: 1_030 });
    assert.equal(r.after.sells, 1);
    assert.equal(r.after.quote_out, 1.5);
    assert.equal(r.after.tokens_out, 1000);
    assert.equal(r.after.last_ts, 1_030);
    assert.equal(r.after.first_ts, 1_010);
    close(realized(r.after), -0.5);
    close(r.realizedDelta, -0.5);
    close(held(r.after), 1000);
  });

  it("caps the sold share at the whole bag and keeps realized consistent", () => {
    // The rest goes for 0.1 ETH: total out 1.6 against 4 in.
    const r = applyTrade(db, { wallet: PASSENGER, token: TOKEN, side: "sell", quote: 0.1, tokens: 1000, ts: 1_040 });
    close(realized(r.after), -2.4);
    close(r.realizedDelta, -1.9);
    close(held(r.after), 0);
    // Dust sold past the bag creates no phantom cost, and earns no phantom profit either: the five
    // tokens beyond the bag were never bought here, so their share of the proceeds is left out.
    // Written as the rule rather than as a number: proceeds for the covered share, less the cost.
    const d = applyTrade(db, { wallet: PASSENGER, token: TOKEN, side: "sell", quote: 0.01, tokens: 5, ts: 1_041 });
    const covered = 1.61 * (2000 / 2005) - 4;
    close(realized(d.after), covered);
    close(d.realizedDelta, covered - -2.4);
    close(held(d.after), 0);
  });

  it("persists the position", () => {
    const row = db.prepare("SELECT * FROM trader_positions WHERE wallet = ? AND token = ?").get(PASSENGER, TOKEN) as
      { quote_in: number; quote_out: number; buys: number; sells: number };
    assert.equal(row.buys, 2);
    assert.equal(row.sells, 3);
    close(row.quote_in, 4);
    close(row.quote_out, 1.61);
  });

  it("flags the launch sender as an insider", () => {
    const r = applyTrade(db, { wallet: PILOT, token: TOKEN, side: "buy", quote: 0.5, tokens: 5000, ts: 1_001 });
    assert.equal(r.after.insider, 1);
    // Decided once, at open: a later trade keeps it.
    const s = applyTrade(db, { wallet: PILOT, token: TOKEN, side: "sell", quote: 2, tokens: 5000, ts: 1_050 });
    assert.equal(s.after.insider, 1);
    close(s.realizedDelta, 1.5);
  });

  it("flags a wallet the creator waived the opening tax for", () => {
    const r = applyTrade(db, { wallet: WAIVED, token: TOKEN, side: "buy", quote: 0.2, tokens: 100, ts: 1_002 });
    assert.equal(r.after.insider, 1);
  });

  it("does not flag a stranger on a different token", () => {
    const r = applyTrade(db, { wallet: PILOT, token: "0x00000000000000000000000000000000000000bb", side: "buy", quote: 1, tokens: 1, ts: 1_060 });
    assert.equal(r.after.insider, 0);
  });

  it("normalises addresses to lowercase", () => {
    const r = applyTrade(db, { wallet: PASSENGER.toUpperCase().replace("0X", "0x"), token: TOKEN, side: "buy", quote: 1, tokens: 10, ts: 1_070 });
    assert.equal(r.after.wallet, PASSENGER);
    assert.equal(r.after.buys, 3);
  });
});

describe("isRangeError", () => {
  it("recognises the refusals a narrower range gets past", () => {
    for (const m of ["query returned more than 10000 results", "block range exceeds limit", "request timed out", "invalid parameters"]) {
      assert.ok(isRangeError(new Error(m)), m);
    }
    for (const m of ["HTTP request failed. Status: 403 Forbidden", "ECONNRESET", "database is locked"]) {
      assert.ok(!isRangeError(new Error(m)), m);
    }
  });
});

describe("isRangeError", () => {
  it("counts a reply too large to read as a range that wants to be narrower", () => {
    // viem throws this when the endpoint answers with more than 10 MB; seen on a 2,000-block chunk
    // of pool swaps, where it crash-looped the backfill because it looked like an unknown error.
    const tooBig = new Error("HTTP response body exceeded the size limit.\nMax: 10485760 bytes\nReceived: 10502144 bytes");
    tooBig.name = "ResponseBodyTooLargeError";
    assert.equal(isRangeError(tooBig), true);
  });

  it("still counts the refusals the endpoint words itself", () => {
    assert.equal(isRangeError(new Error("query returned more than 10000 results")), true);
    assert.equal(isRangeError(new Error("Missing or invalid parameters.")), true);
    assert.equal(isRangeError(new Error("request timed out")), true);
  });

  it("does not swallow an error a narrower range cannot fix", () => {
    assert.equal(isRangeError(new Error("database is locked")), false);
    assert.equal(isRangeError(new Error("insufficient funds")), false);
  });
});

describe("isRangeError and rate limits", () => {
  it("does not treat a rate limit as a range that wants to be narrower", () => {
    // Narrowing answers "slow down" with more requests, which is the wrong way round.
    assert.equal(isRangeError(new Error("eth_getLogs 1..500: HTTP 429 Too Many Requests")), false);
    assert.equal(isRangeError(new Error("Too Many Requests")), false);
  });

  it("still catches the result cap, which is worded almost the same", () => {
    assert.equal(isRangeError(new Error("logs matched by query exceeds limit of 10000")), true);
    assert.equal(isRangeError(new Error("too many results, narrow the range")), true);
  });
});
