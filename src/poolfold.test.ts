import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { BlockClock } from "./chain/blockclock.ts";
import { TOPIC_POOL_SWAP } from "./chain/pool.ts";
import { getMeta, openDb, setMeta, type DB } from "./db.ts";
import type { RawLog } from "./chain/chain.ts";
import { foldPoolRange, poolMap, poolTrade, POOL_CURSOR, type PoolInfo } from "./poolfold.ts";

/**
 * The pool fold with no network: log reads and the transaction-sender lookup are injected.
 *
 * The sign convention under test is the one proved on live swaps (see the header of poolfold.ts):
 * a negative amount is what the trader paid in, a positive one what the trader took out.
 */

const TOKEN = "0x00000000000000000000000000000000000000aa";
const TOKEN_LO = "0x00000000000000000000000000000000000000bb";
const ETH = "0x0000000000000000000000000000000000000000";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL_C1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
const POOL_C0 = "0x2222222222222222222222222222222222222222222222222222222222222222";
const TRADER = "0x00000000000000000000000000000000000000e1";
const ROUTER = "0x00000000000000000000000000000000000000f5";

let dir: string;
let db: DB;

/** A pool whose token is currency1, quoted in native ETH: 18 and 18 decimals. */
const ethPool: PoolInfo = { poolId: POOL_C1, token: TOKEN, quote: ETH, tokenIsC1: true, decToken: 18, decQuote: 18 };
/** A pool whose token is currency0, quoted in USDG: 18 and 6 decimals. */
const usdgPool: PoolInfo = { poolId: POOL_C0, token: TOKEN_LO, quote: USDG, tokenIsC1: false, decToken: 18, decQuote: 6 };

const swap = (poolId: string, amount0: bigint, amount1: bigint, block: number, tx: string, logIndex = 0): RawLog => ({
  address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  topics: [TOPIC_POOL_SWAP, poolId as `0x${string}`, `0x${ROUTER.slice(2).padStart(64, "0")}`] as RawLog["topics"],
  data: encodeAbiParameters(
    parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
    [amount0, amount1, 79228162514264337593543950336n, 1000n, 0, 3000],
  ),
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: tx as `0x${string}`,
  logIndex: `0x${logIndex.toString(16)}`,
});

/** A clock that never touches the chain: one anchor per block asked for. */
const fixedClock = (): BlockClock => {
  const c = new BlockClock();
  c.anchor(1, 1_000_000);
  c.anchor(1_000_000, 1_000_000 + 100_000);
  return c;
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-poolfold-"));
  db = openDb(join(dir, "test.db"));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM trader_positions");
  db.exec("DELETE FROM pools");
  db.exec("DELETE FROM meta");
});

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const seedPools = (): void => {
  db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN, POOL_C1, ETH, TOKEN, 1, 18, 18, 10, "1", ETH);
  db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN_LO, POOL_C0, TOKEN_LO, USDG, 0, 18, 6, 10, "1", USDG);
};

describe("poolTrade: the sign convention", () => {
  const base = { poolId: POOL_C1, sender: ROUTER, sqrtPriceX96: 1n, liquidity: 1n, tick: 0, fee: 3000, block: 100, tx: "0xaa", logIndex: 0 };

  it("reads a buy when the token leg is positive: the trader took tokens out", () => {
    // Token is currency1: amount1 positive (tokens out), amount0 negative (ETH paid in).
    const t = poolTrade({ ...base, amount0: -2_000_000_000_000_000_000n, amount1: 500n * 10n ** 18n }, ethPool, TRADER, 5);
    assert.ok(t);
    assert.equal(t.side, "buy");
    assert.equal(t.wallet, TRADER);
    assert.equal(t.token, TOKEN);
    close(t.quote, 2);
    close(t.tokens, 500);
    assert.equal(t.pair, ETH);
    assert.equal(t.ts, 5);
  });

  it("reads a sell when the token leg is negative: the trader paid tokens in", () => {
    const t = poolTrade({ ...base, amount0: 1_500_000_000_000_000_000n, amount1: -500n * 10n ** 18n }, ethPool, TRADER, 6);
    assert.ok(t);
    assert.equal(t.side, "sell");
    close(t.quote, 1.5);
    close(t.tokens, 500);
  });

  it("reads both directions the same way when the token is currency0", () => {
    // Token is currency0, quote is USDG with 6 decimals on currency1.
    const buy = poolTrade({ ...base, poolId: POOL_C0, amount0: 250n * 10n ** 18n, amount1: -40_000_000n }, usdgPool, TRADER, 7);
    assert.ok(buy);
    assert.equal(buy.side, "buy");
    assert.equal(buy.token, TOKEN_LO);
    close(buy.tokens, 250);
    close(buy.quote, 40);

    const sell = poolTrade({ ...base, poolId: POOL_C0, amount0: -250n * 10n ** 18n, amount1: 30_000_000n }, usdgPool, TRADER, 8);
    assert.ok(sell);
    assert.equal(sell.side, "sell");
    close(sell.tokens, 250);
    close(sell.quote, 30);
  });

  it("scales each side by its own decimals", () => {
    // 6-decimal quote against an 18-decimal token: reading both as wei would print 0.0000.
    const t = poolTrade({ ...base, poolId: POOL_C0, amount0: 1n * 10n ** 18n, amount1: -1_234_567n }, usdgPool, TRADER, 9);
    assert.ok(t);
    close(t.quote, 1.234567);
    close(t.tokens, 1);
    assert.equal(t.quoteWei, 1_234_567n);
    assert.equal(t.tokensWei, 10n ** 18n);
  });

  it("keeps the raw amounts unsigned and carries the quote asset as the pair", () => {
    const t = poolTrade({ ...base, amount0: -2n * 10n ** 18n, amount1: 7n * 10n ** 18n }, ethPool, TRADER.toUpperCase().replace("0X", "0x"), 5);
    assert.ok(t);
    assert.equal(t.quoteWei, 2n * 10n ** 18n);
    assert.equal(t.tokensWei, 7n * 10n ** 18n);
    assert.equal(t.wallet, TRADER);
    assert.equal(t.fee, 0n);
  });

  it("refuses a swap with a zero leg or two legs of the same sign", () => {
    assert.equal(poolTrade({ ...base, amount0: 0n, amount1: 5n }, ethPool, TRADER, 1), null);
    assert.equal(poolTrade({ ...base, amount0: 5n, amount1: 0n }, ethPool, TRADER, 1), null);
    assert.equal(poolTrade({ ...base, amount0: 5n, amount1: 5n }, ethPool, TRADER, 1), null);
    assert.equal(poolTrade({ ...base, amount0: -5n, amount1: -5n }, ethPool, TRADER, 1), null);
  });
});

describe("poolMap", () => {
  it("puts the decimals on the right side of the pair", () => {
    seedPools();
    const m = poolMap(db);
    assert.equal(m.size, 2);
    const c1 = m.get(POOL_C1) as PoolInfo;
    assert.equal(c1.token, TOKEN);
    assert.equal(c1.tokenIsC1, true);
    assert.equal(c1.decToken, 18);
    assert.equal(c1.decQuote, 18);
    assert.equal(c1.quote, ETH);
    const c0 = m.get(POOL_C0) as PoolInfo;
    assert.equal(c0.tokenIsC1, false);
    assert.equal(c0.decToken, 18);
    assert.equal(c0.decQuote, 6);
    assert.equal(c0.quote, USDG);
  });

  it("falls back to the other currency when quote_token was never filled in", () => {
    db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN, POOL_C1, ETH, TOKEN, 1, 18, 18, 10, "1", "");
    assert.equal((poolMap(db).get(POOL_C1) as PoolInfo).quote, ETH);
  });
});

describe("foldPoolRange", () => {
  it("folds a buy and a sell into one position and moves the cursor", async () => {
    seedPools();
    const logs = [
      swap(POOL_C1, -2n * 10n ** 18n, 1000n * 10n ** 18n, 100, "0xt1", 0),
      swap(POOL_C1, 1n * 10n ** 18n, -1000n * 10n ** 18n, 101, "0xt2", 1),
    ];
    const s = await foldPoolRange(db, 100, 101, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => logs,
      senders: async (hs) => new Map(hs.map((h) => [h, TRADER])),
    });
    assert.equal(s.matched, 2);
    assert.equal(s.folded, 2);
    assert.equal(s.unresolved, 0);
    assert.equal(s.toBlock, 101);

    const p = db.prepare("SELECT * FROM trader_positions WHERE wallet = ? AND token = ?").get(TRADER, TOKEN) as
      { quote_in: number; quote_out: number; tokens_in: number; tokens_out: number; buys: number; sells: number };
    assert.equal(p.buys, 1);
    assert.equal(p.sells, 1);
    close(p.quote_in, 2);
    close(p.quote_out, 1);
    close(p.tokens_in, 1000);
    close(p.tokens_out, 1000);
    assert.equal(getMeta(db, POOL_CURSOR), "101");
  });

  it("attributes to the transaction sender, never to the swap's sender", async () => {
    seedPools();
    const s = await foldPoolRange(db, 100, 100, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xt1")],
      senders: async () => new Map([["0xt1", TRADER]]),
    });
    assert.equal(s.folded, 1);
    assert.equal((db.prepare("SELECT count(*) c FROM trader_positions WHERE wallet = ?").get(ROUTER) as { c: number }).c, 0);
    assert.equal((db.prepare("SELECT count(*) c FROM trader_positions WHERE wallet = ?").get(TRADER) as { c: number }).c, 1);
  });

  it("skips a swap whose transaction sender cannot be resolved and counts it", async () => {
    seedPools();
    const s = await foldPoolRange(db, 100, 101, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [
        swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xgood"),
        swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 101, "0xbad"),
      ],
      // The batch answered for one hash and not the other.
      senders: async () => new Map([["0xgood", TRADER]]),
    });
    assert.equal(s.matched, 2);
    assert.equal(s.folded, 1);
    assert.equal(s.unresolved, 1);
    assert.equal((db.prepare("SELECT count(*) c FROM trader_positions").get() as { c: number }).c, 1);
    // The cursor still moves: the range was read, the swap is not coming back.
    assert.equal(getMeta(db, POOL_CURSOR), "101");
  });

  it("ignores swaps on pools it has no row for", async () => {
    seedPools();
    const other = "0x9999999999999999999999999999999999999999999999999999999999999999";
    const s = await foldPoolRange(db, 100, 100, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [
        swap(other, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xt1"),
        swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xt2"),
      ],
      senders: async (hs) => new Map(hs.map((h) => [h, TRADER])),
    });
    assert.equal(s.logs, 2);
    assert.equal(s.unknown, 1);
    assert.equal(s.matched, 1);
    assert.equal(s.folded, 1);
  });

  it("asks for every distinct transaction hash once per chunk", async () => {
    seedPools();
    const asked: string[][] = [];
    await foldPoolRange(db, 100, 100, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [
        swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xsame", 0),
        swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xsame", 1),
        swap(POOL_C1, 1n * 10n ** 18n, -5n * 10n ** 18n, 100, "0xother", 2),
      ],
      senders: async (hs) => { asked.push(hs); return new Map(hs.map((h) => [h, TRADER])); },
    });
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], ["0xsame", "0xother"]);
  });

  it("halves the chunk on a range refusal and stays narrow until a run of clean reads", async () => {
    seedPools();
    const ranges: Array<[number, number]> = [];
    let refused = 0;
    const s = await foldPoolRange(db, 1, 4000, {
      chunk: 2000,
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async (from, to) => {
        ranges.push([from, to]);
        // The first two attempts are refused the way the endpoint refuses a burst.
        if (to - from + 1 > 500 && refused < 2) { refused++; throw new Error("query returned more than 10000 results"); }
        return [];
      },
      senders: async () => new Map(),
    });
    assert.deepEqual(ranges.slice(0, 3), [[1, 2000], [1, 1000], [1, 500]]);
    // It does not widen after the first success: on a busy stretch the wider read trips the same
    // cap and is spent finding that out, so the width holds until WIDEN_AFTER clean reads.
    assert.deepEqual(ranges[3], [501, 1000], "still 500 wide");
    assert.deepEqual(ranges[4], [1001, 1500], "and still 500 wide");
    assert.ok(ranges.slice(3).every(([f, t]) => t - f + 1 <= 500), "never widens inside this run");
    assert.equal(s.toBlock, 4000);
    assert.equal(getMeta(db, POOL_CURSOR), "4000");
  });

  it("gives up rather than spinning on a range it cannot read", async () => {
    seedPools();
    await assert.rejects(
      () => foldPoolRange(db, 1, 100, {
        clock: fixedClock(),
        spacingMs: 0,
        readLogs: async () => { throw new Error("query returned more than 10000 results"); },
        senders: async () => new Map(),
      }),
      /gave up at/,
    );
  });

  it("checkpoints after every chunk, so an interrupted run resumes", async () => {
    seedPools();
    const seen: number[] = [];
    await foldPoolRange(db, 1, 300, {
      chunk: 100,
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [],
      senders: async () => new Map(),
      onChunk: () => seen.push(Number(getMeta(db, POOL_CURSOR))),
    });
    assert.deepEqual(seen, [100, 200, 300]);
  });

  it("writes to its own cursor key and leaves the curve fold's alone", async () => {
    seedPools();
    setMeta(db, "fold_to_block", "12345");
    await foldPoolRange(db, 100, 100, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xt1")],
      senders: async () => new Map([["0xt1", TRADER]]),
    });
    assert.equal(getMeta(db, "fold_to_block"), "12345");
    assert.equal(getMeta(db, POOL_CURSOR), "100");
  });

  it("stops after one chunk with once, and skips the checkpoint when asked", async () => {
    seedPools();
    const s = await foldPoolRange(db, 1, 1000, {
      chunk: 100,
      once: true,
      checkpoint: false,
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [],
      senders: async () => new Map(),
    });
    assert.equal(s.chunks, 1);
    assert.equal(s.toBlock, 100);
    assert.equal(getMeta(db, POOL_CURSOR), null);
  });

  it("runs the onTrade hook once per folded trade, inside the chunk", async () => {
    seedPools();
    const sides: string[] = [];
    await foldPoolRange(db, 100, 101, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [
        swap(POOL_C1, -2n * 10n ** 18n, 1000n * 10n ** 18n, 100, "0xt1", 0),
        swap(POOL_C1, 1n * 10n ** 18n, -1000n * 10n ** 18n, 101, "0xt2", 1),
      ],
      senders: async (hs) => new Map(hs.map((h) => [h, TRADER])),
      onTrade: (t, r) => { sides.push(t.side); assert.ok(r.after); },
    });
    assert.deepEqual(sides, ["buy", "sell"]);
  });

  it("rolls a chunk back when the hook throws, leaving the cursor where it was", async () => {
    seedPools();
    setMeta(db, POOL_CURSOR, "99");
    await assert.rejects(() => foldPoolRange(db, 100, 100, {
      clock: fixedClock(),
      spacingMs: 0,
      readLogs: async () => [swap(POOL_C1, -1n * 10n ** 18n, 5n * 10n ** 18n, 100, "0xt1")],
      senders: async () => new Map([["0xt1", TRADER]]),
      onTrade: () => { throw new Error("boom"); },
    }), /boom/);
    assert.equal(getMeta(db, POOL_CURSOR), "99");
    assert.equal((db.prepare("SELECT count(*) c FROM trader_positions").get() as { c: number }).c, 0);
  });
});
