import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "./db.ts";
import { loadRanks, writeRanks, type RankTable } from "./report.ts";

/**
 * The rank table crosses processes through the database, so a fresh process answers reports
 * at once instead of after the two minutes it takes to compute one.
 */
describe("the rank table on disk", () => {
  it("is nothing until a writer has left one", () => {
    const db = openDb(":memory:");
    assert.equal(loadRanks(db), null);
    db.close();
  });

  it("comes back exactly as written, in rank order, with when it was built", () => {
    const db = openDb(":memory:");
    const table: RankTable = { wallets: 3, entries: [["0xaaa", 1, 66.67], ["0xbbb", 2, 33.33], ["0xccc", 2, 33.33]] };
    writeRanks(db, table, 1_700_000_000);
    const back = loadRanks(db);
    assert.ok(back);
    assert.equal(back.builtAt, 1_700_000_000);
    assert.deepEqual(back.table, table);

    // A rewrite replaces, never accumulates: a wallet that dropped out is gone.
    writeRanks(db, { wallets: 1, entries: [["0xbbb", 1, 0]] }, 1_700_000_500);
    assert.deepEqual(loadRanks(db)?.table, { wallets: 1, entries: [["0xbbb", 1, 0]] });
    db.close();
  });
});
