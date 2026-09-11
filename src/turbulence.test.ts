import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb, type DB } from "./db.ts";
import { applyTrade } from "./fold.ts";
import { clearTurbulenceCache, turbulence, turbulenceLabel, TURBULENCE_WINDOW } from "./turbulence.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const addr = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = 1_000_000;

let dir: string;
let db: DB;

function launch(token: string, ts: number, status: string | null): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, symbol, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(token, addr(0x100 + Number(BigInt(token))), addr(0xd1), ZERO, "T", ts, ts, "0x" + ts, 0, ts);
  if (status) db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(token, ts, status, ts + 60);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-turb-"));
  db = openDb(join(dir, "test.db"));
  // Launched in the window: four, three dead. One older launch is dead but outside the window.
  launch(addr(1), NOW - 1_000, "cancelled");
  launch(addr(2), NOW - 2_000, "departed");
  launch(addr(3), NOW - 3_000, "departed");
  launch(addr(4), NOW - 4_000, "boarding");
  launch(addr(5), NOW - TURBULENCE_WINDOW - 10, "cancelled");
  // Active wallets: two losers, one winner. A fourth wallet lost but last traded before the window.
  applyTrade(db, { wallet: addr(0xe1), token: addr(1), side: "buy", quote: 1, tokens: 10, ts: NOW - 900 });
  applyTrade(db, { wallet: addr(0xe1), token: addr(1), side: "sell", quote: 0.2, tokens: 10, ts: NOW - 800 });
  applyTrade(db, { wallet: addr(0xe2), token: addr(2), side: "buy", quote: 1, tokens: 10, ts: NOW - 900 });
  applyTrade(db, { wallet: addr(0xe2), token: addr(2), side: "sell", quote: 0.5, tokens: 10, ts: NOW - 100 });
  applyTrade(db, { wallet: addr(0xe3), token: addr(4), side: "buy", quote: 1, tokens: 10, ts: NOW - 900 });
  applyTrade(db, { wallet: addr(0xe3), token: addr(4), side: "sell", quote: 3, tokens: 10, ts: NOW - 50 });
  applyTrade(db, { wallet: addr(0xe4), token: addr(5), side: "buy", quote: 1, tokens: 10, ts: NOW - TURBULENCE_WINDOW - 5 });
  applyTrade(db, { wallet: addr(0xe4), token: addr(5), side: "sell", quote: 0.1, tokens: 10, ts: NOW - TURBULENCE_WINDOW - 1 });
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("turbulenceLabel", () => {
  it("uses inclusive lower bounds", () => {
    assert.equal(turbulenceLabel(0), "Clear skies");
    assert.equal(turbulenceLabel(19), "Clear skies");
    assert.equal(turbulenceLabel(20), "Light chop");
    assert.equal(turbulenceLabel(40), "Moderate");
    assert.equal(turbulenceLabel(60), "Severe");
    assert.equal(turbulenceLabel(80), "Extreme");
    assert.equal(turbulenceLabel(100), "Extreme");
  });
});

describe("turbulence", () => {
  it("scores W and D over the window", () => {
    const t = turbulence(db, NOW);
    assert.equal(t.window, TURBULENCE_WINDOW);
    assert.equal(t.w, 0.6667);
    assert.equal(t.d, 0.75);
    // round(100 × (0.6 × 2/3 + 0.4 × 0.75)) = round(40 + 30) = 70
    assert.equal(t.score, 70);
    assert.equal(t.label, "Severe");
  });

  it("is zero with nothing in the window and serves the cache within a minute", () => {
    const empty = turbulence(db, NOW + 10 * TURBULENCE_WINDOW);
    assert.deepEqual(empty, { score: 0, label: "Clear skies", w: 0, d: 0, window: TURBULENCE_WINDOW });
    // Same minute: the cached answer, whatever the data.
    applyTrade(db, { wallet: addr(0xe5), token: addr(4), side: "buy", quote: 1, tokens: 10, ts: NOW + 10 * TURBULENCE_WINDOW });
    assert.equal(turbulence(db, NOW + 10 * TURBULENCE_WINDOW + 1).w, 0);
    clearTurbulenceCache(db);
    // A wallet that only bought has realized 0: judged, not a loser.
    assert.equal(turbulence(db, NOW + 10 * TURBULENCE_WINDOW + 1).w, 0);
    clearTurbulenceCache(db);
    assert.equal(turbulence(db, NOW).score, 70);
  });
});
