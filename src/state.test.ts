import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getMeta, openDb, type DB } from "./db.ts";
import { applyGraduation, applyLaunch, applyTradeState, resetSweep, seedTokenState, sweepStatuses } from "./state.ts";
import type { LaunchRecord } from "./types.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const PILOT = "0x00000000000000000000000000000000000000d1";
const PASSENGER = "0x00000000000000000000000000000000000000e1";
const T0 = 1_700_000_000;

let dir: string;
let db: DB;
let n = 0;

/** A launches row plus the LaunchRecord state.applyLaunch is given for it. */
function launch(symbol: string | null, ts: number): LaunchRecord {
  n++;
  const token = `0x${n.toString(16).padStart(38, "0")}aa`;
  const curve = `0x${n.toString(16).padStart(38, "0")}cc`;
  db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(token, curve, "0xca11bde05977b3631167028862be2a173976ca11", PILOT, ZERO, symbol, 100 + n, ts, `0xtx${n}`, 0, ts);
  return { token, curve, deployer: PILOT, pair: ZERO, pairSymbol: "ETH", symbol, name: symbol ? `${symbol} Airlines` : null, ts, block: 100 + n, logIndex: 0 };
}

const trade = (token: string, price: number, ts: number, side: "buy" | "sell" = "buy") =>
  applyTradeState(db, { token, side, quote: price * 1000, tokens: 1000, wallet: PASSENGER, ts });

const state = (token: string) => db.prepare("SELECT * FROM token_state WHERE token = ?").get(token) as
  { status: string; status_ts: number; peak_price: number | null; last_price: number | null; last_trade_ts: number | null; graduated_ts: number | null; updated_seq: number; symbol: string | null };

const events = (token: string) => (db.prepare("SELECT kind, payload FROM board_events WHERE token = ? ORDER BY seq").all(token) as
  Array<{ kind: string; payload: string }>).map((r) => ({ kind: r.kind, ...JSON.parse(r.payload) }));

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-state-"));
  db = openDb(join(dir, "test.db"));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("applyLaunch", () => {
  it("boards a token once and gives it a flight number", () => {
    const l = launch("PONZI2", T0);
    const ev = applyLaunch(db, l);
    assert.equal(ev.kind, "launch");
    assert.equal(ev.symbol, "PONZI2");
    assert.equal(ev.name, "PONZI2 Airlines");
    assert.equal(ev.flight, "RK-1");
    assert.equal(ev.deployer, PILOT);
    assert.equal(state(l.token).status, "boarding");
    assert.equal(state(l.token).status_ts, T0);
    // Idempotent: a second call updates the row and appends nothing.
    applyLaunch(db, { ...l, symbol: "PONZI3" });
    assert.equal(events(l.token).length, 1);
    assert.equal(state(l.token).symbol, "PONZI3");
  });

  it("falls back to the truncated address until the symbol is known", () => {
    const l = launch(null, T0);
    const ev = applyLaunch(db, l);
    assert.match(ev.symbol, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    assert.equal(ev.flight, "RK-2");
    applyLaunch(db, { ...l, symbol: "LATE" });
    assert.equal(state(l.token).symbol, "LATE");
  });
});

describe("applyLaunch after the fold", () => {
  it("still appends the launch event when a trade created the row first", () => {
    const l = launch("EARLY", T0);
    // launchAndBuy: the first trade is in the launch block and the fold sees it before enrichment ends.
    trade(l.token, 1, T0);
    assert.equal(state(l.token).status, "boarding");
    assert.equal(events(l.token).length, 0);
    const ev = applyLaunch(db, l);
    assert.equal(ev.symbol, "EARLY");
    assert.deepEqual(events(l.token).map((e) => e.kind), ["launch"]);
    assert.equal(state(l.token).peak_price, 1);
    applyLaunch(db, l);
    assert.equal(events(l.token).length, 1);
  });
});

describe("cancelled", () => {
  it("goes boarding to cancelled when the price is at or below 10% of peak inside 10 minutes", () => {
    const l = launch("DUCK", T0);
    applyLaunch(db, l);
    assert.equal(trade(l.token, 1, T0 + 5), null);
    assert.equal(trade(l.token, 2, T0 + 60), null);
    assert.equal(state(l.token).peak_price, 2);
    // 11% of peak is still boarding.
    assert.equal(trade(l.token, 0.22, T0 + 120, "sell"), null);
    const ev = trade(l.token, 0.2, T0 + 300, "sell");
    assert.ok(ev);
    assert.equal(ev.status, "cancelled");
    assert.equal(ev.symbol, "DUCK");
    assert.equal(ev.ts, T0 + 300);
    const s = state(l.token);
    assert.equal(s.status, "cancelled");
    assert.equal(s.status_ts, T0 + 300);
    assert.equal(s.last_price, 0.2);
    assert.equal(s.last_trade_ts, T0 + 300);
    // Terminal: a later bounce does not reopen boarding, and the sweep leaves it alone.
    assert.equal(trade(l.token, 3, T0 + 400), null);
    assert.equal(state(l.token).status, "cancelled");
    assert.equal(sweepStatuses(db, T0 + 5_000).filter((e) => e.token === l.token).length, 0);
    assert.deepEqual(events(l.token).map((e) => e.kind), ["launch", "status"]);
  });

  it("ignores a dust trade for the price and keeps it for the clock", () => {
    const l = launch("DUST", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 5);
    trade(l.token, 2, T0 + 60);
    // One wei of the token sold for nothing: a real CurveSell shape, not a crash.
    assert.equal(applyTradeState(db, { token: l.token, side: "sell", quote: 0, tokens: 1e-18, wallet: PASSENGER, ts: T0 + 240 }), null);
    let s = state(l.token);
    assert.equal(s.status, "boarding");
    assert.equal(s.last_price, 2);
    assert.equal(s.peak_price, 2);
    assert.equal(s.last_trade_ts, T0 + 240);
    // A few wei of quote for a whole token: still dust.
    assert.equal(applyTradeState(db, { token: l.token, side: "sell", quote: 5e-18, tokens: 1, wallet: PASSENGER, ts: T0 + 250 }), null);
    s = state(l.token);
    assert.equal(s.last_price, 2);
    assert.equal(s.last_trade_ts, T0 + 250);
    // Outside the window the same dust does not park the price at zero for the sweep either.
    assert.equal(applyTradeState(db, { token: l.token, side: "sell", quote: 0, tokens: 1e-18, wallet: PASSENGER, ts: T0 + 700 }), null);
    assert.equal(sweepStatuses(db, T0 + 700 + 600).filter((e) => e.token === l.token).length, 0);
    assert.equal(state(l.token).status, "boarding");
  });

  it("does not cancel on a drop after the first 10 minutes", () => {
    const l = launch("SLOW", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 100);
    assert.equal(trade(l.token, 0.01, T0 + 601, "sell"), null);
    assert.equal(state(l.token).status, "boarding");
  });
});

describe("departed", () => {
  it("goes boarding to departed after 10 minutes of silence at or below 10% of peak", () => {
    const l = launch("GHOST", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 700);
    trade(l.token, 0.05, T0 + 800, "sell");
    assert.equal(state(l.token).status, "boarding");
    // Not yet silent for 10 minutes.
    assert.equal(sweepStatuses(db, T0 + 800 + 599).filter((e) => e.token === l.token).length, 0);
    const evs = sweepStatuses(db, T0 + 800 + 600).filter((e) => e.token === l.token);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].status, "departed");
    assert.equal(evs[0].symbol, "GHOST");
    assert.equal(state(l.token).status, "departed");
    assert.equal(state(l.token).status_ts, T0 + 1_400);
    // Once only.
    assert.equal(sweepStatuses(db, T0 + 9_000).filter((e) => e.token === l.token).length, 0);
  });

  it("stamps a late sweep with the moment the silence elapsed, not the sweep time", () => {
    resetSweep(db);
    const l = launch("LATE", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 700);
    trade(l.token, 0.05, T0 + 800, "sell");
    // Six days later (the watcher's first sweep after a long CLI fold).
    const evs = sweepStatuses(db, T0 + 6 * 86_400).filter((e) => e.token === l.token);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].ts, T0 + 800 + 600);
    assert.equal(state(l.token).status_ts, T0 + 800 + 600);
  });

  it("finds a token that went quiet after the previous sweep", () => {
    resetSweep(db);
    const a = launch("QUIET1", T0);
    const b = launch("QUIET2", T0);
    applyLaunch(db, a);
    applyLaunch(db, b);
    trade(a.token, 1, T0 + 700);
    trade(a.token, 0.05, T0 + 800, "sell");
    trade(b.token, 1, T0 + 700);
    trade(b.token, 0.5, T0 + 800, "sell");
    assert.equal(sweepStatuses(db, T0 + 1_400).filter((e) => [a.token, b.token].includes(e.token)).map((e) => e.token).join(), a.token);
    // b crashes later; the next sweep only looks at rows quiet since the last one and still finds it.
    trade(b.token, 0.01, T0 + 2_000, "sell");
    assert.equal(sweepStatuses(db, T0 + 2_500).filter((e) => e.token === b.token).length, 0);
    const evs = sweepStatuses(db, T0 + 2_600).filter((e) => e.token === b.token);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].ts, T0 + 2_600);
    // A sweep whose clock went backwards looks at everything again and changes nothing.
    assert.equal(sweepStatuses(db, T0 + 1_500).filter((e) => [a.token, b.token].includes(e.token)).length, 0);
  });

  it("keeps a silent token that still holds its price", () => {
    const l = launch("HOLD", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 700);
    trade(l.token, 0.5, T0 + 800, "sell");
    assert.equal(sweepStatuses(db, T0 + 90_000).filter((e) => e.token === l.token).length, 0);
    assert.equal(state(l.token).status, "boarding");
  });

  it("prunes board events older than 24 hours", () => {
    const l = launch("OLD", T0 - 200_000);
    applyLaunch(db, l);
    assert.equal(events(l.token).length, 1);
    sweepStatuses(db, T0);
    assert.equal(events(l.token).length, 0);
  });
});

describe("arrived", () => {
  it("is never downgraded", () => {
    const l = launch("MOON", T0);
    applyLaunch(db, l);
    trade(l.token, 1, T0 + 10);
    const g = applyGraduation(db, l.token, T0 + 100);
    assert.ok(g);
    assert.equal(g.kind, "graduate");
    assert.equal(g.symbol, "MOON");
    assert.equal(state(l.token).status, "arrived");
    assert.equal(state(l.token).graduated_ts, T0 + 100);
    // A crash inside the window does not cancel it...
    assert.equal(trade(l.token, 0.01, T0 + 200, "sell"), null);
    assert.equal(state(l.token).status, "arrived");
    assert.equal(state(l.token).last_price, 0.01);
    // ...and silence does not depart it.
    assert.equal(sweepStatuses(db, T0 + 5_000).filter((e) => e.token === l.token).length, 0);
    assert.equal(state(l.token).status, "arrived");
    // Graduating twice is a no-op, and an unknown token is null.
    assert.equal(applyGraduation(db, l.token, T0 + 300), null);
    assert.equal(applyGraduation(db, "0x00000000000000000000000000000000000000ff", T0), null);
    assert.deepEqual(events(l.token).map((e) => e.kind), ["launch", "graduate"]);
  });

  it("arrives a backfilled launch the watcher never saw boarding", () => {
    const l = launch("PRIOR", T0);
    const g = applyGraduation(db, l.token, T0 + 50);
    assert.ok(g);
    assert.equal(state(l.token).status, "arrived");
    assert.equal(events(l.token).map((e) => e.kind).join(), "graduate");
  });
});

describe("updated_seq", () => {
  it("increases on every write and survives in meta", () => {
    const l = launch("SEQ", T0);
    const seqs: number[] = [];
    applyLaunch(db, l); seqs.push(state(l.token).updated_seq);
    trade(l.token, 1, T0 + 1); seqs.push(state(l.token).updated_seq);
    trade(l.token, 1.5, T0 + 2); seqs.push(state(l.token).updated_seq);
    applyLaunch(db, l); seqs.push(state(l.token).updated_seq);
    trade(l.token, 0.1, T0 + 3, "sell"); seqs.push(state(l.token).updated_seq);
    applyGraduation(db, l.token, T0 + 4); seqs.push(state(l.token).updated_seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `${seqs.join(",")} not increasing`);
    assert.equal(Number(getMeta(db, "state_seq")), seqs[seqs.length - 1]);
    const max = (db.prepare("SELECT max(updated_seq) m FROM token_state").get() as { m: number }).m;
    assert.equal(max, seqs[seqs.length - 1]);
  });
});

describe("seedTokenState", () => {
  it("creates rows for launches without one, silently", () => {
    const a = launch("SEED", T0);
    const b = launch("SEEDG", T0);
    db.prepare("UPDATE launches SET graduated_ts = ? WHERE token = ?").run(T0 + 9, b.token);
    const before = (db.prepare("SELECT count(*) c FROM board_events").get() as { c: number }).c;
    assert.equal(seedTokenState(db), 2);
    assert.equal(state(a.token).status, "boarding");
    assert.equal(state(b.token).status, "arrived");
    assert.equal((db.prepare("SELECT count(*) c FROM board_events").get() as { c: number }).c, before);
    assert.equal(seedTokenState(db), 0);
  });
});
