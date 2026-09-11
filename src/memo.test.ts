import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Memo } from "./api.ts";

/**
 * The leaderboards cost minutes, so the rules this cache follows are the difference between a
 * page that is a few minutes out of date and a page that is blank while somebody waits.
 *
 * A window of zero means every entry is stale the instant it is written, which is how these get
 * to test the stale path without sleeping. Tests that wait on the clock fail on a busy machine.
 */

const STALE = 0;
const FRESH = 60;
// setImmediate runs once the microtask queue is empty, so the cache has finished storing what
// it was given. Waiting a number of milliseconds instead is what makes a test like this flaky.
const settle = (): Promise<void> => new Promise((r) => { setImmediate(r); });

describe("Memo", () => {
  it("answers with a stale value instead of making the caller wait for a new one", async () => {
    const memo = new Memo();
    let runs = 0;
    let release: ((v: number) => void) | null = null;

    assert.deepEqual(await memo.get("k", STALE, () => 1), { value: 1, hit: false });

    const slow = (): Promise<number> => { runs++; return new Promise((r) => { release = r; }); };
    assert.deepEqual(await memo.get("k", STALE, slow), { value: 1, hit: true }, "the old answer, at once");
    assert.equal(runs, 1, "and the new one started behind it");
    release?.(2);
    await settle();
    assert.deepEqual(await memo.get("k", FRESH, () => 99), { value: 2, hit: true }, "which then replaces it");
  });

  it("computes once however many callers arrive at the same moment", async () => {
    const memo = new Memo();
    let runs = 0;
    let release: ((v: number) => void) | null = null;
    const slow = (): Promise<number> => { runs++; return new Promise((r) => { release = r; }); };

    const all = Promise.all([memo.get("k", FRESH, slow), memo.get("k", FRESH, slow), memo.get("k", FRESH, slow)]);
    await settle();
    assert.equal(runs, 1);
    release?.(7);
    assert.deepEqual((await all).map((r) => r.value), [7, 7, 7]);
  });

  it("refresh computes even when a stale entry is sitting there to be replaced", async () => {
    const memo = new Memo();
    let n = 0;
    await memo.get("k", STALE, () => ++n);
    // get would hand back the stale 1; the job that exists to replace it must not accept it, or
    // the copy saved to disk would be yesterday's answer stamped with today's time.
    assert.equal(await memo.refresh("k", STALE, () => ++n), 2);
    assert.deepEqual(await memo.get("k", FRESH, () => ++n), { value: 2, hit: true });
  });

  it("keeps a pinned entry through pruning however old it is, so there is always something stale to serve", async () => {
    const memo = new Memo();
    await memo.get("slow", STALE, () => "yesterday");
    await memo.get("fast", STALE, () => "gone");
    memo.pin("slow");
    memo.prune();
    let computed = 0;
    let release: ((v: string) => void) | null = null;
    const slow = (): Promise<string> => { computed++; return new Promise((r) => { release = r; }); };
    assert.deepEqual(await memo.get("slow", STALE, slow), { value: "yesterday", hit: true }, "served at once");
    assert.equal(computed, 1, "while the new answer computes");
    const fast = memo.get("fast", FRESH, slow);
    await settle();
    assert.equal(computed, 2, "the unpinned entry was pruned and its caller waits");
    release?.("today");
    await fast;
  });

  it("a failed computation leaves the old answer alone and lets the next caller try again", async () => {
    const memo = new Memo();
    await memo.get("k", STALE, () => "good");
    await assert.rejects(() => memo.refresh("k", STALE, () => Promise.reject(new Error("chain down"))));
    assert.deepEqual(await memo.get("k", FRESH, () => "never"), { value: "good", hit: true });
  });
});
