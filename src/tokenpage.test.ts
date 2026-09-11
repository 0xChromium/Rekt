import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb, type DB } from "./db.ts";
import { applyTrade } from "./fold.ts";
import { usdOf } from "./prices.ts";
import { tokenPage } from "./tokenpage.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const ETH = usdOf("ETH") as number;
const PILOT = addr(0xd1);
const DEAD = addr(1), ALIVE = addr(2), NAMELESS = addr(3);

let dir: string;
let db: DB;

function launch(token: string, symbol: string | null, ts: number): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, name, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, addr(0x100 + Number(BigInt(token))), addr(0xca11), PILOT, ZERO, symbol, symbol && symbol + " coin", ts, ts, "0x" + ts, 0, ts);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-token-"));
  db = openDb(join(dir, "test.db"));
  launch(DEAD, "PONZI2", 1_000);
  launch(ALIVE, "LIVE", 2_000);
  launch(NAMELESS, null, 3_000);
  db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(DEAD, 1_000, "cancelled", 1_034);
  db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(ALIVE, 2_000, "boarding", 2_000);
  // Two losers and one winner on PONZI2.
  applyTrade(db, { wallet: addr(0xe1), token: DEAD, side: "buy", quote: 2, tokens: 100, ts: 1_005 });
  applyTrade(db, { wallet: addr(0xe1), token: DEAD, side: "sell", quote: 0.5, tokens: 100, ts: 1_030 });
  applyTrade(db, { wallet: addr(0xe2), token: DEAD, side: "buy", quote: 1, tokens: 100, ts: 1_006 });
  applyTrade(db, { wallet: addr(0xe2), token: DEAD, side: "sell", quote: 0.9, tokens: 100, ts: 1_031 });
  applyTrade(db, { wallet: addr(0xe3), token: DEAD, side: "buy", quote: 0.1, tokens: 100, ts: 1_001 });
  applyTrade(db, { wallet: addr(0xe3), token: DEAD, side: "sell", quote: 1, tokens: 100, ts: 1_020 });
  // An indexed curve: prices 1, 3.4, 0.5 (quote per token, raw units cancel).
  const ins = db.prepare(`INSERT INTO curve_trades (token, tx, log_index, side, actor, recipient, quote_wei, quote_eth, token_amt, fee_wei, tax_wei, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(DEAD, "0xa", 0, "buy", addr(0xe3), addr(0xe3), "100", 0, "100", "0", "0", 1_001, 1_001);
  ins.run(DEAD, "0xb", 0, "buy", addr(0xe1), addr(0xe1), "340", 0, "100", "0", "0", 1_005, 1_005);
  ins.run(DEAD, "0xc", 0, "sell", addr(0xe1), addr(0xe1), "50", 0, "100", "0", "0", 1_030, 1_030);
  db.prepare("INSERT INTO curve_indexed (token, to_block, trades, indexed_at) VALUES (?,?,?,?)").run(DEAD, 1_100, 3, 1_100);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const c2 = (v: number): number => Math.round(v * 100) / 100;

describe("tokenPage", () => {
  it("returns null for an unknown token or a bad address", async () => {
    assert.equal(await tokenPage(db, addr(0xff), { index: false }), null);
    assert.equal(await tokenPage(db, "0xnope", { index: false }), null);
  });

  it("builds the tombstone for a cancelled token", async () => {
    const t = await tokenPage(db, DEAD.toUpperCase().replace("0X", "0x"), { index: false, nowTs: 10_000 });
    assert.ok(t);
    assert.equal(t.token, DEAD);
    assert.equal(t.symbol, "PONZI2");
    assert.equal(t.name, "PONZI2 coin");
    assert.equal(t.status, "cancelled");
    assert.equal(t.bornTs, 1_000);
    assert.equal(t.diedTs, 1_034);
    assert.equal(t.lifespanMin, 0.57);
    assert.equal(t.peakMultiple, 3.4);
    assert.equal(t.losers, 2);
    assert.equal(t.lostUsd, c2(1.6 * ETH));
    assert.equal(t.biggestLossUsd, c2(1.5 * ETH));
    assert.equal(t.deployer, PILOT);
    assert.deepEqual(t.deployerRecord, { launches: 3, deadShare: 0.3333, losers: 2 });
  });

  it("measures a live token to now and leaves the peak null when the curve is not indexed", async () => {
    const t = await tokenPage(db, ALIVE, { index: false, nowTs: 2_600 });
    assert.ok(t);
    assert.equal(t.status, "boarding");
    assert.equal(t.diedTs, null);
    assert.equal(t.lifespanMin, 10);
    assert.equal(t.peakMultiple, null);
    assert.equal(t.losers, 0);
    assert.equal(t.lostUsd, 0);
  });

  it("falls back to the truncated address without a symbol and to boarding without token_state", async () => {
    const t = await tokenPage(db, NAMELESS, { index: false, nowTs: 3_060 });
    assert.ok(t);
    assert.equal(t.symbol, "0x0000…0003");
    assert.equal(t.name, "0x0000…0003");
    assert.equal(t.status, "boarding");
    assert.equal(t.lifespanMin, 1);
  });
});
