import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BOARD_CHANGED, BOARD_ROWS, boardRows } from "./board.ts";
import { openDb, type DB } from "./db.ts";
import { applyGraduation, applyLaunch, applyTradeState } from "./state.ts";
import type { LaunchRecord } from "./types.ts";

/**
 * The board's composition. The chain launches a token every three or four seconds, so a board of
 * the newest launches says BOARDING twelve times and never flips a status: what died did so ten
 * minutes ago and is thousands of lines down. These tests pin the reserved slots that fix it.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const PILOT = "0x00000000000000000000000000000000000000d1";
const T0 = 1_700_000_000;

let dir: string;
let db: DB;
let n = 0;

function launch(symbol: string, ts: number): LaunchRecord {
  n++;
  const token = `0x${n.toString(16).padStart(38, "0")}aa`;
  const curve = `0x${n.toString(16).padStart(38, "0")}cc`;
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(token, curve, PILOT, PILOT, ZERO, symbol, 100 + n, ts, `0xtx${n}`, 0, ts);
  const rec: LaunchRecord = { token, curve, deployer: PILOT, pair: ZERO, pairSymbol: "ETH", symbol, name: symbol, ts, block: 100 + n, logIndex: 0 };
  applyLaunch(db, rec);
  return rec;
}

/** Buys at 1.0, then dumps to 1% of it inside the ten-minute window: cancelled. */
function kill(token: string, ts: number): void {
  applyTradeState(db, { token, side: "buy", quote: 1000, tokens: 1000, wallet: PILOT, ts });
  applyTradeState(db, { token, side: "sell", quote: 10, tokens: 1000, wallet: PILOT, ts: ts + 60 });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-board-"));
  db = openDb(join(dir, "test.db"));
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("boardRows", () => {
  it("fills the whole board with launches while nothing has changed status", () => {
    for (let i = 0; i < BOARD_ROWS + 4; i++) launch(`FRESH${i}`, T0 + i);
    const rows = boardRows(db);
    assert.equal(rows.length, BOARD_ROWS);
    assert.ok(rows.every((r) => r.status === "boarding"));
    assert.equal(rows[0].symbol, `FRESH${BOARD_ROWS + 3}`, "newest launch on top");
  });

  it("keeps four slots for tokens whose status changed, under the launches", () => {
    for (let i = 0; i < 6; i++) {
      const l = launch(`DEAD${i}`, T0 + 100 + i);
      kill(l.token, T0 + 200 + i * 10);
    }
    const rows = boardRows(db);
    assert.equal(rows.length, BOARD_ROWS);
    const changed = rows.filter((r) => r.status !== "boarding");
    assert.equal(changed.length, BOARD_CHANGED, "exactly four, however many have died");
    assert.deepEqual(rows.slice(-BOARD_CHANGED), changed, "and they sit at the bottom");
    assert.equal(changed[0].symbol, "DEAD5", "most recent change first");
    assert.ok(rows.slice(0, BOARD_ROWS - BOARD_CHANGED).every((r) => r.status === "boarding"));
  });

  it("shows an arrival among the changes", () => {
    const l = launch("MADEIT", T0 + 300);
    applyGraduation(db, l.token, T0 + 400);
    const rows = boardRows(db);
    const arrived = rows.find((r) => r.status === "arrived");
    assert.ok(arrived, "a graduated token reaches the board");
    assert.equal(arrived?.symbol, "MADEIT");
  });

  it("lets the changes lane take the leftover slots when launches are scarce", () => {
    // A fresh database standing in for the first minutes of the record: two tokens still boarding,
    // six already dead. Holding the lane at four would leave six of the twelve lines blank.
    const small = openDb(join(dir, "small.db"));
    const saved = db;
    db = small;
    try {
      for (let i = 0; i < 6; i++) {
        const l = launch(`GONE${i}`, T0 + i);
        kill(l.token, T0 + 50 + i * 10);
      }
      launch("ALIVE0", T0 + 200);
      launch("ALIVE1", T0 + 201);
      const rows = boardRows(small);
      assert.equal(rows.length, 8, "every line the database can fill");
      assert.equal(rows.filter((r) => r.status === "boarding").length, 2);
      assert.equal(rows.filter((r) => r.status !== "boarding").length, 6, "the lane grew past four");
      assert.equal(rows[0].symbol, "ALIVE1", "launches still on top");
    } finally {
      db = saved;
      small.close();
    }
  });
});
