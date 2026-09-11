import { BLOCKS_PER_DAY, V2_START_BLOCK } from "./chain/config.ts";
import { getMeta, type DB } from "./db.ts";
import type { Coverage, StreamCoverage } from "./types.ts";

/**
 * How much of the chain the record actually holds, and whether that is all of it.
 *
 * The site answers from the database, so the honest depth of the record is the honest limit of the
 * product: a visitor whose flights are older than it sees nothing and concludes the site is broken.
 * That happened, and we heard about it from a person rather than from the system, which is the part
 * worth fixing. This is the number a monitor can watch and the page can print.
 *
 * What counts is the contiguous range and nothing else. A backward extension folds upward from its
 * target towards the old start, so while it runs the record holds an island below a hole, and the
 * blocks in that hole answer nothing. Counting the extension's target as the start is how this
 * function used to overstate the record by a third of a day: the page promised a depth that a
 * wallet trading in the hole would not find. The island is reported separately, as work in flight.
 */

const num = (db: DB, key: string): number | null => {
  const v = Number(getMeta(db, key) ?? NaN);
  return Number.isFinite(v) ? v : null;
};

const days = (blocks: number): number => Math.round((blocks / BLOCKS_PER_DAY) * 10) / 10;

/** A stream's contiguous range, how far it still has to reach back, and what is being folded now. */
function stream(db: DB, keys: StreamKeys, head: number): StreamCoverage {
  const from = num(db, keys.from) ?? head;
  const to = num(db, keys.to) ?? from;
  // The extension has folded [backFrom, backTo] and will reach `from` eventually. Until it does,
  // (backTo, from) is a hole, so this is progress to report and not depth to claim.
  const backFrom = num(db, keys.backFrom);
  const backTo = num(db, keys.backTo);
  const extending = backFrom !== null && backTo !== null && backTo > backFrom ? backTo - backFrom : 0;
  const behind = Math.max(0, from - V2_START_BLOCK);
  return {
    fromBlock: from,
    toBlock: to,
    days: days(Math.max(0, to - from)),
    missingDays: days(behind),
    extendingDays: days(extending),
    complete: behind < BLOCKS_PER_DAY / 24, // within an hour of the start is complete enough
  };
}

type StreamKeys = { from: string; to: string; backFrom: string; backTo: string };
const CURVE: StreamKeys = { from: "fold_from_block", to: "fold_to_block", backFrom: "fold_back_from", backTo: "fold_back_to" };
const POOLS: StreamKeys = { from: "pool_from_block", to: "pool_to_block", backFrom: "pool_back_from", backTo: "pool_back_to" };

export function coverage(db: DB, head?: number): Coverage {
  const latest = head ?? num(db, "live_head_block") ?? num(db, "fold_to_block") ?? V2_START_BLOCK;
  const curve = stream(db, CURVE, latest);
  const pools = stream(db, POOLS, latest);
  const complete = curve.complete && pools.complete;
  const worst = Math.max(curve.missingDays, pools.missingDays);
  return {
    curve,
    pools,
    v2StartBlock: V2_START_BLOCK,
    complete,
    // One sentence a page can print and a person can act on, or null when there is nothing to say.
    missing: complete
      ? null
      : `The record still has ${worst.toFixed(1)} day${worst >= 1.05 || worst < 0.95 ? "s" : ""} of the chain to read before it reaches 4 August.`,
  };
}
