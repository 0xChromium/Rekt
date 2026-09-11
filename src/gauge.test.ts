import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { counters, GAUGE_KEY, NO_GAUGE, storedGauge, storeGauge } from "./board.ts";
import { openDb } from "./db.ts";

/**
 * The board's counters are built on the thread that serves the site, so the one rule here is
 * that they never compute the turbulence gauge: it is a scan that takes most of a minute, and
 * computing it in place was a whole site stopped for that long at the start of every process.
 */
describe("the gauge on the board", () => {
  it("is the stored one when there is one, and a still needle when there is none", () => {
    const db = openDb(":memory:");
    assert.deepEqual(storedGauge(db), NO_GAUGE, "nothing stored yet");
    assert.deepEqual(counters(db, 1_800_000_000).turbulence, NO_GAUGE, "and the counters say so rather than computing one");

    storeGauge(db, { score: 63, label: "Severe" });
    assert.deepEqual(storedGauge(db), { score: 63, label: "Severe" });
    assert.deepEqual(counters(db, 1_800_000_000).turbulence, { score: 63, label: "Severe" });
    db.close();
  });

  it("ignores a stored row it cannot read rather than failing the board", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO slow_answers (key, at, json) VALUES (?,?,?)").run(GAUGE_KEY, 0, "{not json");
    assert.deepEqual(storedGauge(db), NO_GAUGE);
    db.prepare("INSERT OR REPLACE INTO slow_answers (key, at, json) VALUES (?,?,?)").run(GAUGE_KEY, 0, JSON.stringify({ score: "high" }));
    assert.deepEqual(storedGauge(db), NO_GAUGE, "a row of the wrong shape is no gauge either");
    db.close();
  });

  it("still answers when the gauge is handed in", () => {
    const db = openDb(":memory:");
    assert.deepEqual(counters(db, 1_800_000_000, { score: 12, label: "Light chop" }).turbulence, { score: 12, label: "Light chop" });
    db.close();
  });
});
