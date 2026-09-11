import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb, type DB } from "./db.ts";
import { applyTrade, type DecodedTrade, type Position } from "./fold.ts";
import { detectLoss, MIN_LOSS_USD, realizedDelta } from "./losses.ts";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";
const PASSENGER = "0x00000000000000000000000000000000000000e1";
const ETH = 2472;
const T0 = 1_700_000_000;

let dir: string;
let db: DB;
let li = 0;

const pos = (p: Partial<Position>): Position => ({
  wallet: PASSENGER, token: TOKEN, quote_in: 0, quote_out: 0, tokens_in: 0, tokens_out: 0,
  buys: 0, sells: 0, first_ts: T0, last_ts: T0, insider: 0, ...p,
});

const sell = (quote: number, tokens: number, ts: number, extra: Partial<DecodedTrade> = {}): DecodedTrade => ({
  wallet: PASSENGER, token: TOKEN, side: "sell", quote, tokens, ts, block: 200, tx: "0xsell", logIndex: ++li, pair: ZERO,
  quoteWei: BigInt(Math.round(quote * 1e18)), tokensWei: BigInt(Math.round(tokens * 1e18)), fee: 0n, tax: 0n, ...extra,
});

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-losses-"));
  db = openDb(join(dir, "test.db"));
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, symbol, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN, "0x00000000000000000000000000000000000000cc", ZERO, ZERO, "PONZI2", 100, T0, "0xabc", 0, T0);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("realizedDelta", () => {
  it("counts only the units the record saw bought, on both sides", () => {
    // 4 ETH for 2000 tokens; half sold for 1.5 ETH cost 2 ETH.
    const before = pos({ quote_in: 4, tokens_in: 2000 });
    const after = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.5, tokens_out: 1000 });
    close(realizedDelta(before, after), -0.5);
    close(realizedDelta(null, after), -0.5);
    // The rest for 0.1: total 1.6 out against 4 in, this sell alone lost 1.9.
    const rest = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.6, tokens_out: 2000 });
    close(realizedDelta(after, rest), -1.9);
    // Selling past the bag adds no phantom cost and no phantom profit: the five tokens beyond what
    // was bought here carry no basis, so their share of the proceeds does not count.
    const dust = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.61, tokens_out: 2005 });
    close(realizedDelta(rest, dust), (1.61 * (2000 / 2005) - 4) - (1.6 - 4));
    // And a position sold with nothing bought behind it is worth nothing rather than everything.
    const airdrop = pos({ quote_in: 0, tokens_in: 0, quote_out: 3, tokens_out: 1000 });
    close(realizedDelta(null, airdrop), 0);
  });
});

describe("detectLoss", () => {
  it("records a losing sell at or above $20 with minutes since the first buy", () => {
    const before = pos({ quote_in: 4, tokens_in: 2000, buys: 2, first_ts: T0 + 60 });
    const after = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.5, tokens_out: 1000, buys: 2, sells: 1, first_ts: T0 + 60 });
    const t = sell(1.5, 1000, T0 + 60 + 4 * 60 + 30, { tx: "0xloss1" });
    const row = detectLoss(db, before, after, t, ETH);
    assert.ok(row);
    close(row.lossQuote, 0.5);
    close(row.lossUsd, 0.5 * ETH);
    close(row.minutesSinceBuy, 4.5);
    assert.equal(row.wallet, PASSENGER);
    assert.equal(row.token, TOKEN);
    assert.equal(row.tx, "0xloss1");
    assert.equal(row.logIndex, t.logIndex);
    assert.equal(row.ts, t.ts);
    assert.equal(row.block, 200);

    const stored = db.prepare("SELECT * FROM losses WHERE id = ?").get(row.id) as { loss_usd: number; minutes_since_buy: number; log_index: number };
    close(stored.loss_usd, 0.5 * ETH);
    close(stored.minutes_since_buy, 4.5);
    assert.equal(stored.log_index, t.logIndex);

    const ev = db.prepare("SELECT kind, token, payload FROM board_events ORDER BY seq DESC LIMIT 1").get() as { kind: string; token: string; payload: string };
    assert.equal(ev.kind, "loss");
    assert.equal(ev.token, TOKEN);
    const p = JSON.parse(ev.payload);
    assert.equal(p.kind, "loss");
    assert.equal(p.symbol, "PONZI2");
    assert.equal(p.wallet, PASSENGER);
    close(p.lossUsd, 0.5 * ETH);
    close(p.minutesSinceBuy, 4.5);
  });

  it("does not record the same (tx, log_index) twice", () => {
    const before = pos({ quote_in: 4, tokens_in: 2000 });
    const after = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.5, tokens_out: 1000 });
    const t = sell(1.5, 1000, T0 + 100, { tx: "0xdup" });
    assert.ok(detectLoss(db, before, after, t, ETH));
    assert.equal(detectLoss(db, before, after, t, ETH), null);
    assert.equal((db.prepare("SELECT count(*) c FROM losses WHERE tx = '0xdup'").get() as { c: number }).c, 1);
  });

  it("ignores losses under $20", () => {
    // 0.005 ETH lost is $12.36.
    const before = pos({ quote_in: 0.01, tokens_in: 1000 });
    const after = pos({ quote_in: 0.01, tokens_in: 1000, quote_out: 0.005, tokens_out: 1000 });
    assert.equal(detectLoss(db, before, after, sell(0.005, 1000, T0 + 100), ETH), null);
    // Exactly $20 counts.
    const q = MIN_LOSS_USD / ETH;
    const b2 = pos({ quote_in: 2 * q, tokens_in: 1000 });
    const a2 = pos({ quote_in: 2 * q, tokens_in: 1000, quote_out: q, tokens_out: 1000 });
    const row = detectLoss(db, b2, a2, sell(q, 1000, T0 + 100, { tx: "0xedge" }), ETH);
    assert.ok(row);
    close(row.lossUsd, MIN_LOSS_USD);
  });

  it("ignores buys, gains and unpriced quote assets", () => {
    const before = pos({ quote_in: 4, tokens_in: 2000 });
    const after = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.5, tokens_out: 1000 });
    assert.equal(detectLoss(db, before, after, { ...sell(1.5, 1000, T0 + 100), side: "buy" }, ETH), null);
    assert.equal(detectLoss(db, before, after, sell(1.5, 1000, T0 + 100), null), null);
    const gain = pos({ quote_in: 4, tokens_in: 2000, quote_out: 3, tokens_out: 1000 });
    assert.equal(detectLoss(db, before, gain, sell(3, 1000, T0 + 100), ETH), null);
    // A bag still held is not a loss yet: a sell that recovers part of a later drop is a gain on its own.
    const half = pos({ quote_in: 4, tokens_in: 2000, quote_out: 1.5, tokens_out: 1000 });
    const better = pos({ quote_in: 4, tokens_in: 2000, quote_out: 4, tokens_out: 2000 });
    assert.equal(detectLoss(db, half, better, sell(2.5, 1000, T0 + 100), ETH), null);
  });

  it("works from applyTrade's before and after on a first-sell position", () => {
    const wallet = "0x00000000000000000000000000000000000000e2";
    applyTrade(db, { wallet, token: TOKEN, side: "buy", quote: 1, tokens: 1000, ts: T0 + 10 });
    const r = applyTrade(db, { wallet, token: TOKEN, side: "sell", quote: 0.2, tokens: 1000, ts: T0 + 70 });
    const row = detectLoss(db, r.before, r.after, sell(0.2, 1000, T0 + 70, { wallet, tx: "0xfold" }), ETH);
    assert.ok(row);
    close(row.lossQuote, 0.8);
    close(row.lossUsd, 0.8 * ETH);
    close(row.minutesSinceBuy, 1);
    close(row.lossQuote, -r.realizedDelta);
  });
});
