import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLOCKS_PER_DAY, V2_START_BLOCK } from "./chain/config.ts";
import { coverage } from "./coverage.ts";
import { openDb, setMeta, type DB } from "./db.ts";

/**
 * The depth printed on the page is a promise: a wallet whose flights fall inside it must find them.
 * These check that the promise is never larger than the record.
 */

const HEAD = V2_START_BLOCK + Math.round(BLOCKS_PER_DAY * 37);

function dbWith(meta: Record<string, number>): DB {
  const db = openDb(":memory:");
  for (const [k, v] of Object.entries(meta)) setMeta(db, k, String(v));
  return db;
}

describe("coverage", () => {
  it("counts the contiguous range and not the hole an extension has yet to close", () => {
    const from = HEAD - Math.round(BLOCKS_PER_DAY * 7); // seven days are folded and joined up
    const db = dbWith({
      live_head_block: HEAD,
      fold_from_block: from, fold_to_block: HEAD,
      // An extension aiming a further day back that has folded a tenth of a day of it so far.
      fold_back_from: from - Math.round(BLOCKS_PER_DAY),
      fold_back_to: from - Math.round(BLOCKS_PER_DAY * 0.9),
      pool_from_block: from, pool_to_block: HEAD,
    });

    const c = coverage(db, HEAD);
    assert.equal(c.curve.days, 7, "the island below the hole is not depth");
    assert.equal(c.curve.extendingDays, 0.1, "but it is reported as work in flight");
    assert.equal(c.curve.fromBlock, from, "the record begins where it is unbroken");
    assert.equal(c.curve.missingDays, 30, "and everything below that is still missing");
    db.close();
  });

  it("says the record is whole only when both streams reach the start", () => {
    const whole = { live_head_block: HEAD, fold_from_block: V2_START_BLOCK, fold_to_block: HEAD };
    const half = dbWith({ ...whole, pool_from_block: HEAD - BLOCKS_PER_DAY, pool_to_block: HEAD });
    assert.equal(coverage(half, HEAD).complete, false, "one deep stream is not the record");
    assert.match(String(coverage(half, HEAD).missing), /36\.0 days/);
    half.close();

    const all = dbWith({ ...whole, pool_from_block: V2_START_BLOCK, pool_to_block: HEAD });
    const c = coverage(all, HEAD);
    assert.equal(c.complete, true);
    assert.equal(c.missing, null, "nothing to say when there is nothing missing");
    all.close();
  });

  it("never claims depth from an empty database", () => {
    const db = dbWith({ live_head_block: HEAD });
    const c = coverage(db, HEAD);
    assert.equal(c.curve.days, 0);
    assert.equal(c.pools.days, 0);
    assert.equal(c.complete, false);
    db.close();
  });
});
