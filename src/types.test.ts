import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BADGE_IDS, CLASS_NAMES, TOKEN_STATUSES, TURBULENCE_LABELS } from "./types.ts";

/**
 * The fixtures in web/mock are the executable form of src/types.ts: every key of a type must be
 * present in its fixture, and nothing else. When a type gains a field, this list and the fixture
 * change in the same commit.
 */
const KEYS = {
  report: ["address", "since", "netRealizedUsd", "realizedUsd", "bagsUsd", "bagsHeld", "volumeUsd", "tokensTraded", "buys", "sells",
    "firstTs", "lastTs", "rank", "ofWallets", "percentile", "className", "worst", "best", "badges", "notAlone", "unpricedPositions", "outsideRecordPositions", "ca"],
  worst: ["token", "symbol", "lossUsd", "boughtTs", "dead", "deployer", "deployerRecord"],
  best: ["token", "symbol", "gainUsd"],
  deployerRecord: ["launches", "deadShare", "losers"],
  badge: ["id", "label", "detail"],
  replay: ["rows", "losses", "counters", "ca", "seq"],
  row: ["token", "symbol", "name", "flight", "deployer", "pair", "pairSymbol", "ts", "status", "statusTs"],
  loss: ["kind", "wallet", "token", "symbol", "lossUsd", "minutesSinceBuy", "ts"],
  counters: ["kind", "lostTodayUsd", "daysSinceCancelled", "turbulence", "ts"],
  turbulence: ["score", "label", "w", "d", "window"],
  hall: ["wallet", "lossUsd", "tokens", "worstSymbol"],
  airline: ["deployer", "launches", "deadShare", "losers", "lostUsd"],
  token: ["token", "symbol", "name", "status", "bornTs", "diedTs", "peakMultiple", "lifespanMin", "losers", "lostUsd", "biggestLossUsd", "deployer", "deployerRecord"],
  desk: ["recipient", "recipientKind", "accruedWei", "accruedUsd", "walletWei", "holdersHalfUsd", "sharing", "contracts", "ledger", "ca"],
  contracts: ["splitter", "staking", "status"],
  ledger: ["ts", "tx", "amountUsd", "recipients"],
  health: ["lagBlocks", "lagSeconds", "watcherAgeSeconds", "foldCursor", "latestBlock", "ok", "records"],
  coverage: ["curve", "pools", "v2StartBlock", "complete", "missing"],
  streamCoverage: ["fromBlock", "toBlock", "days", "missingDays", "extendingDays", "complete"],
};

const load = (name: string): any => JSON.parse(readFileSync(new URL(`../web/mock/${name}.json`, import.meta.url), "utf8"));
const keysOf = (o: object, keys: readonly string[], what: string): void =>
  assert.deepEqual(Object.keys(o).sort(), [...keys].sort(), `${what} keys`);
const isAddress = (a: unknown): boolean => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a);

test("report.json matches Report", () => {
  const r = load("report");
  keysOf(r, KEYS.report, "report");
  assert.ok(isAddress(r.address));
  keysOf(r.worst, KEYS.worst, "worst");
  keysOf(r.worst.deployerRecord, KEYS.deployerRecord, "deployerRecord");
  keysOf(r.best, KEYS.best, "best");
  assert.ok(r.badges.length <= 3);
  for (const b of r.badges) { keysOf(b, KEYS.badge, "badge"); assert.ok(BADGE_IDS.includes(b.id)); }
  assert.ok(CLASS_NAMES.includes(r.className));
  assert.ok(r.realizedUsd <= 0 && r.worst.lossUsd > 0 && r.best.gainUsd > 0);
});

test("health.json carries how deep the record is", () => {
  const h = load("health");
  keysOf(h.records, KEYS.coverage, "coverage");
  keysOf(h.records.curve, KEYS.streamCoverage, "curve coverage");
  keysOf(h.records.pools, KEYS.streamCoverage, "pool coverage");
});

test("board-replay.json matches BoardReplay", () => {
  const b = load("board-replay");
  keysOf(b, KEYS.replay, "replay");
  assert.equal(b.rows.length, 12);
  assert.equal(b.losses.length, 20);
  for (const r of b.rows) {
    keysOf(r, KEYS.row, "row");
    assert.ok(TOKEN_STATUSES.includes(r.status));
    assert.match(r.flight, /^RK-\d+$/);
    assert.ok(isAddress(r.token) && isAddress(r.deployer) && isAddress(r.pair));
  }
  for (let i = 1; i < b.rows.length; i++) assert.ok(b.rows[i - 1].ts >= b.rows[i].ts, "rows newest first");
  for (const l of b.losses) { keysOf(l, KEYS.loss, "loss"); assert.equal(l.kind, "loss"); assert.ok(l.lossUsd >= 20); }
  keysOf(b.counters, KEYS.counters, "counters");
  assert.equal(b.counters.kind, "counters");
  assert.ok(TURBULENCE_LABELS.includes(b.counters.turbulence.label));
});

test("index.json matches Turbulence and its own formula", () => {
  const t = load("index");
  keysOf(t, KEYS.turbulence, "turbulence");
  assert.equal(t.score, Math.round(100 * (0.6 * t.w + 0.4 * t.d)));
  assert.ok(TURBULENCE_LABELS.includes(t.label));
});

test("leaderboards match HallRow[] and AirlineRow[]", () => {
  const hall = load("leaderboard-rekt");
  assert.ok(Array.isArray(hall) && hall.length <= 10);
  for (const r of hall) { keysOf(r, KEYS.hall, "hall"); assert.ok(isAddress(r.wallet)); }
  const air = load("leaderboard-airlines");
  assert.ok(Array.isArray(air) && air.length <= 10);
  for (const r of air) { keysOf(r, KEYS.airline, "airline"); assert.ok(r.deadShare >= 0 && r.deadShare <= 1); }
});

test("token.json matches TokenPage", () => {
  const t = load("token");
  keysOf(t, KEYS.token, "token");
  keysOf(t.deployerRecord, KEYS.deployerRecord, "deployerRecord");
  assert.ok(TOKEN_STATUSES.includes(t.status));
});

test("desk.json matches Desk", () => {
  const d = load("desk");
  keysOf(d, KEYS.desk, "desk");
  keysOf(d.contracts, KEYS.contracts, "contracts");
  assert.match(d.accruedWei, /^\d+$/);
  assert.match(d.walletWei, /^\d+$/);
  for (const l of d.ledger) keysOf(l, KEYS.ledger, "ledger");
  assert.ok(["wallet", "splitter", "none"].includes(d.recipientKind));
});

test("health.json matches Health", () => {
  const h = load("health");
  keysOf(h, KEYS.health, "health");
  assert.equal(typeof h.ok, "boolean");
});
