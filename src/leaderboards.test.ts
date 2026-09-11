import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { now, openDb, type DB } from "./db.ts";
import { applyTrade } from "./fold.ts";
import { usdOf } from "./prices.ts";
import { airlines, clearLeaderboardCache, hallOfRekt } from "./leaderboards.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const MYSTERY = "0x00000000000000000000000000000000000000d7";
const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const ETH = usdOf("ETH") as number;

const PILOT_A = addr(0xd1), PILOT_B = addr(0xd2);
const W1 = addr(0xe1), W2 = addr(0xe2), W3 = addr(0xe3);

let dir: string;
let db: DB;

function launch(token: string, symbol: string, pilot: string, pair = ZERO, status: string | null = null): void {
  const ts = 1_000 + Number(BigInt(token));
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(token, addr(0x100 + Number(BigInt(token))), addr(0xca11), pilot, pair, symbol, ts, ts, "0x" + ts, 0, ts);
  if (status) db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(token, ts, status, ts + 60);
}

const trade = (wallet: string, token: string, side: "buy" | "sell", quote: number, tokens: number, ts = 5_000) =>
  applyTrade(db, { wallet, token, side, quote, tokens, ts });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-lb-"));
  db = openDb(join(dir, "test.db"));
  db.prepare("INSERT INTO quote_assets (address, symbol, decimals) VALUES (?,?,?)").run(MYSTERY, "?", 18);
  // PILOT_A: three launches, two dead. PILOT_B: one launch, alive, quoted in an unpriced asset.
  launch(addr(1), "ONE", PILOT_A, ZERO, "cancelled");
  launch(addr(2), "TWO", PILOT_A, ZERO, "departed");
  launch(addr(3), "THREE", PILOT_A, ZERO, "boarding");
  launch(addr(4), "FOUR", PILOT_B, MYSTERY, "boarding");

  // W1 loses 1 ETH on ONE and 0.2 ETH on TWO; W2 loses 2 ETH on TWO; W3 wins on THREE and loses on FOUR (unpriced).
  trade(W1, addr(1), "buy", 2, 100); trade(W1, addr(1), "sell", 1, 100);
  trade(W1, addr(2), "buy", 1, 100); trade(W1, addr(2), "sell", 0.8, 100);
  trade(W2, addr(2), "buy", 3, 100); trade(W2, addr(2), "sell", 1, 100);
  trade(W3, addr(3), "buy", 1, 100); trade(W3, addr(3), "sell", 5, 100);
  trade(W3, addr(4), "buy", 1, 100); trade(W3, addr(4), "sell", 0.1, 100);
  // The pilot losing on their own token does not count as a passenger.
  trade(PILOT_A, addr(3), "buy", 1, 100); trade(PILOT_A, addr(3), "sell", 0.5, 100);

  // The losses table drives the 24 h hall: W2 has one old loss and one fresh; W1 two fresh ones.
  const t = now();
  const ins = db.prepare("INSERT INTO losses (tx, log_index, wallet, token, loss_quote, loss_usd, minutes_since_buy, ts) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("0x1", 0, W2, addr(2), 2, 5_000, 1, t - 2 * 86_400);
  ins.run("0x2", 0, W2, addr(2), 0.1, 250, 1, t - 100);
  ins.run("0x3", 0, W1, addr(1), 0.1, 200, 1, t - 200);
  ins.run("0x4", 0, W1, addr(2), 0.2, 400, 1, t - 300);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const c2 = (v: number): number => Math.round(v * 100) / 100;

describe("hallOfRekt", () => {
  it("all-time: sums priced losing positions per wallet, largest first, with the worst token", () => {
    const rows = hallOfRekt(db, "all", 10);
    assert.deepEqual(rows.map((r) => r.wallet), [W2, W1, PILOT_A]);
    assert.equal(rows[0].lossUsd, c2(2 * ETH));
    assert.equal(rows[0].tokens, 1);
    assert.equal(rows[0].worstSymbol, "TWO");
    assert.equal(rows[1].lossUsd, c2(1.2 * ETH));
    assert.equal(rows[1].tokens, 2);
    assert.equal(rows[1].worstSymbol, "ONE");
    // W3's only loss is unpriced: not in the hall.
    assert.ok(!rows.some((r) => r.wallet === W3));
  });

  it("24h: sums the losses table over the last day", () => {
    const rows = hallOfRekt(db, "24h", 10);
    assert.deepEqual(rows.map((r) => [r.wallet, r.lossUsd, r.tokens, r.worstSymbol]), [[W1, 600, 2, "TWO"], [W2, 250, 1, "TWO"]]);
  });

  it("respects the limit, rejects a bad window and caches for a minute", () => {
    assert.equal(hallOfRekt(db, "all", 1).length, 1);
    assert.throws(() => hallOfRekt(db, "week" as never, 10), /bad window/);
    trade(addr(0xee), addr(1), "buy", 5, 100); trade(addr(0xee), addr(1), "sell", 0, 100);
    assert.equal(hallOfRekt(db, "all", 10)[0].wallet, W2);
    clearLeaderboardCache(db);
    assert.equal(hallOfRekt(db, "all", 10)[0].wallet, addr(0xee));
  });
});

describe("airlines", () => {
  it("orders deployers by losers then dollars, excluding the pilot's own positions", () => {
    clearLeaderboardCache(db);
    const rows = airlines(db, 10);
    assert.equal(rows.length, 2);
    // PILOT_A: W1, W2 and 0xee lost (PILOT_A's own loss on THREE excluded); 3 launches, 2 dead.
    assert.equal(rows[0].deployer, PILOT_A);
    assert.equal(rows[0].losers, 3);
    assert.equal(rows[0].launches, 3);
    assert.equal(rows[0].deadShare, 0.6667);
    assert.equal(rows[0].lostUsd, c2((1.2 + 2 + 5) * ETH));
    // PILOT_B: W3 lost in an asset we cannot price: a loser with no dollars.
    assert.deepEqual(rows[1], { deployer: PILOT_B, launches: 1, deadShare: 0, losers: 1, lostUsd: 0 });
    assert.equal(airlines(db, 1).length, 1);
  });
});
