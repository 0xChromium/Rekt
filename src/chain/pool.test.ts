import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { openDb, type DB } from "../db.ts";
import { ADDR, ZERO_ADDRESS } from "./config.ts";
import type { RawLog } from "./chain.ts";
import { fillPoolSymbols, isKnownQuote, quotePerToken, resolvePoolsSweep, TOPIC_POOL_INIT } from "./pool.ts";

/**
 * The Initialize sweep with no network: the log read and both decimal lookups are injected.
 *
 * What matters here is which side of the pair the sweep decides is the launched token. A pool
 * recorded the wrong way round inverts every price and every trade in it, so an undecidable pool is
 * skipped rather than guessed at.
 */

const TOKEN = "0xaa00000000000000000000000000000000000001";
/** Below USDG's address, so it lands on currency0. */
const TOKEN_LOW = "0x1100000000000000000000000000000000000001";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const STRANGER = "0xcc00000000000000000000000000000000000009";
const POOL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_POOL = "0x2222222222222222222222222222222222222222222222222222222222222222";

let dir: string;
let db: DB;

const initLog = (
  id: string, c0: string, c1: string, block: number, hooks: string = ADDR.hook, sqrt = 1n,
): RawLog => ({
  address: ADDR.v4PoolManager,
  topics: [
    TOPIC_POOL_INIT,
    id as `0x${string}`,
    `0x${c0.slice(2).padStart(64, "0")}`,
    `0x${c1.slice(2).padStart(64, "0")}`,
  ] as RawLog["topics"],
  data: encodeAbiParameters(
    parseAbiParameters("uint24, int24, address, uint160, int24"),
    [3000, 60, hooks as `0x${string}`, sqrt, 0],
  ),
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: "0xabc",
  logIndex: "0x0",
});

const sweep = (logs: RawLog[], to = 100): Promise<ReturnType<typeof resolvePoolsSweep>> =>
  resolvePoolsSweep(db, 1, to, {
    chunk: 1000,
    spacingMs: 0,
    readLogs: async () => logs,
    quoteDecimals: async (a) => (a === USDG ? 6 : 18),
    tokenDecimals: async (as) => new Map(as.map((a) => [a, 18])),
  });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-pool-"));
  db = openDb(join(dir, "test.db"));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM pools");
  db.exec("DELETE FROM launches");
  db.exec("DELETE FROM quote_assets");
  db.prepare("INSERT INTO quote_assets(address,symbol,decimals) VALUES(?,?,?)").run(USDG, "USDG", 6);
  db.prepare("INSERT INTO quote_assets(address,symbol,decimals) VALUES(?,?,?)").run(NVDA, "NVDA", 18);
});

const row = (token: string): {
  pool_id: string; currency0: string; currency1: string; token_is_c1: number;
  dec0: number; dec1: number; quote_token: string; symbol: string | null; init_block: number;
} => db.prepare("SELECT * FROM pools WHERE token = ?").get(token) as never;

const addLaunch = (token: string, pair: string): void => {
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, block, ts, tx, log_index, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(token, "0xcc", "0xdd", pair, 1, 1, "0xaa", 0, 1);
};

describe("isKnownQuote", () => {
  it("knows native ETH, WETH and anything a launch already quoted in", () => {
    assert.equal(isKnownQuote(db, ZERO_ADDRESS), true);
    assert.equal(isKnownQuote(db, ADDR.weth), true);
    assert.equal(isKnownQuote(db, ADDR.weth.toUpperCase().replace("0X", "0x")), true);
    assert.equal(isKnownQuote(db, USDG), true);
    assert.equal(isKnownQuote(db, TOKEN), false);
  });
});

describe("resolvePoolsSweep", () => {
  it("takes the side that is not a quote asset as the token, with no launches row", async () => {
    const s = await sweep([initLog(POOL, ZERO_ADDRESS, TOKEN, 42)]);
    assert.equal(s.found, 1);
    assert.equal(s.withoutLaunch, 1);
    assert.equal(s.withLaunch, 0);
    assert.equal(s.ambiguous, 0);
    const r = row(TOKEN);
    assert.equal(r.token_is_c1, 1);
    assert.equal(r.quote_token, ZERO_ADDRESS);
    assert.equal(r.init_block, 42);
    assert.equal(r.symbol, null);
  });

  it("finds the token on currency0 too, and scales each side by its own decimals", async () => {
    await sweep([initLog(POOL, TOKEN_LOW, USDG, 7)]);
    const r = row(TOKEN_LOW);
    assert.equal(r.token_is_c1, 0);
    assert.equal(r.quote_token, USDG);
    assert.equal(r.dec0, 18);
    assert.equal(r.dec1, 6);
  });

  it("still uses the launches row when there is one", async () => {
    addLaunch(TOKEN, NVDA);
    const s = await sweep([initLog(POOL, NVDA, TOKEN, 9)]);
    assert.equal(s.withLaunch, 1);
    assert.equal(s.withoutLaunch, 0);
    assert.equal(s.quoteMismatch, 0);
    assert.equal(row(TOKEN).quote_token, NVDA);
  });

  it("lets the launches row break the tie when both sides look like quote assets", async () => {
    // A launch quoted in NVDA whose token later became a quote asset itself.
    db.prepare("INSERT INTO quote_assets(address,symbol,decimals) VALUES(?,?,?)").run(TOKEN, "TOKEN", 18);
    addLaunch(TOKEN, NVDA);
    const s = await sweep([initLog(POOL, NVDA, TOKEN, 9)]);
    assert.equal(s.ambiguous, 0);
    assert.equal(s.withLaunch, 1);
    assert.equal(row(TOKEN).token_is_c1, 1);
  });

  it("skips a pool where neither side is a known quote and no launch says which is ours", async () => {
    const s = await sweep([initLog(POOL, STRANGER, TOKEN, 9)]);
    assert.equal(s.found, 1);
    assert.equal(s.ambiguous, 1);
    assert.equal(s.saved, 0);
    assert.equal(db.prepare("SELECT count(*) c FROM pools").get().c, 0);
  });

  it("counts a pool whose quote is not what the launch record says", async () => {
    addLaunch(TOKEN, ZERO_ADDRESS);
    const s = await sweep([initLog(POOL, USDG, TOKEN, 9)]);
    assert.equal(s.quoteMismatch, 1);
    // The pool's own currency wins: that is what its swaps are denominated in.
    assert.equal(row(TOKEN).quote_token, USDG);
  });

  it("ignores Initialize logs from another hook", async () => {
    const s = await sweep([initLog(POOL, ZERO_ADDRESS, TOKEN, 9, "0x00000000000000000000000000000000000000ff")]);
    assert.equal(s.logs, 1);
    assert.equal(s.found, 0);
    assert.equal(db.prepare("SELECT count(*) c FROM pools").get().c, 0);
  });

  it("fills an empty quote_token on a later sweep and never blanks a full one", async () => {
    // A row written before the quote asset was known.
    db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token, symbol)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(TOKEN, POOL, ZERO_ADDRESS, TOKEN, 1, 18, 18, 42, "1", "", "TKN");
    await sweep([initLog(POOL, ZERO_ADDRESS, TOKEN, 42)]);
    let r = row(TOKEN);
    assert.equal(r.quote_token, ZERO_ADDRESS);
    assert.equal(r.symbol, "TKN", "a symbol already read is kept");

    // A second pool for the same token does not overwrite the first one's identity.
    await sweep([initLog(OTHER_POOL, ZERO_ADDRESS, TOKEN, 900)]);
    r = row(TOKEN);
    assert.equal(r.pool_id, POOL);
    assert.equal(r.init_block, 42);
    assert.equal(r.symbol, "TKN");
  });

  it("refreshes the decimals of the pool it already has", async () => {
    db.prepare(`INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt, quote_token)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(TOKEN_LOW, POOL, TOKEN_LOW, USDG, 0, 18, 18, 7, "1", "");
    await sweep([initLog(POOL, TOKEN_LOW, USDG, 7)]);
    const r = row(TOKEN_LOW);
    assert.equal(r.dec1, 6, "USDG's six decimals replace the assumed eighteen");
    assert.equal(r.quote_token, USDG);
  });

  it("walks the range in chunks and reports how far it got", async () => {
    const ranges: Array<[number, number]> = [];
    const s = await resolvePoolsSweep(db, 1, 250, {
      chunk: 100,
      spacingMs: 0,
      readLogs: async (from, to) => { ranges.push([from, to]); return []; },
      quoteDecimals: async () => 18,
      tokenDecimals: async () => new Map(),
    });
    assert.deepEqual(ranges, [[1, 100], [101, 200], [201, 250]]);
    assert.equal(s.chunks, 3);
    assert.equal(s.toBlock, 250);
  });
});

describe("fillPoolSymbols", () => {
  beforeEach(async () => {
    await sweep([initLog(POOL, ZERO_ADDRESS, TOKEN, 42), initLog(OTHER_POOL, ZERO_ADDRESS, TOKEN_LOW, 43)]);
  });

  it("reads a symbol only for pools whose token has no launches row", async () => {
    addLaunch(TOKEN_LOW, ZERO_ADDRESS);
    const asked: string[][] = [];
    const r = await fillPoolSymbols(db, 100, {
      read: async (ts) => { asked.push(ts); return ts.map(() => "REKT"); },
    });
    assert.deepEqual(asked, [[TOKEN]]);
    assert.equal(r.pending, 1);
    assert.equal(r.filled, 1);
    assert.equal(row(TOKEN).symbol, "REKT");
    assert.equal(row(TOKEN_LOW).symbol, null);
  });

  it("leaves a token that will not answer for a later pass", async () => {
    const r = await fillPoolSymbols(db, 100, { read: async (ts) => ts.map(() => null) });
    assert.equal(r.read, 2);
    assert.equal(r.filled, 0);
    assert.equal(row(TOKEN).symbol, null);
  });

  it("survives a batch that throws", async () => {
    const r = await fillPoolSymbols(db, 100, {
      batch: 1,
      read: async (ts) => { if (ts[0] === TOKEN) throw new Error("rpc down"); return ["OK"]; },
    });
    assert.equal(r.filled, 1);
    assert.equal(row(TOKEN).symbol, null);
    assert.equal(row(TOKEN_LOW).symbol, "OK");
  });
});

describe("quotePerToken", () => {
  it("inverts the ratio when the token is currency1", () => {
    // sqrtPriceX96 = 2^96 is a raw price of 1: one whole token per whole quote either way at 18/18.
    const one = 2n ** 96n;
    assert.equal(quotePerToken(one, { token_is_c1: 1, dec0: 18, dec1: 18 }), 1);
    assert.equal(quotePerToken(one, { token_is_c1: 0, dec0: 18, dec1: 18 }), 1);
    // A six-decimal quote on currency0 with the token on currency1.
    assert.equal(quotePerToken(one, { token_is_c1: 1, dec0: 6, dec1: 18 }), 10 ** 12);
    assert.equal(quotePerToken(0, { token_is_c1: 1, dec0: 18, dec1: 18 }), 0);
  });
});

describe("resolvePoolsSweep, a range the endpoint refuses", () => {
  it("halves the range and carries on rather than losing the sweep", async () => {
    const ranges: Array<[number, number]> = [];
    let refused = 0;
    const s = await resolvePoolsSweep(db, 1, 8000, {
      chunk: 4000,
      spacingMs: 0,
      readLogs: async (from, to) => {
        ranges.push([from, to]);
        if (to - from + 1 > 1000 && refused < 1) { refused++; throw new Error("query returned more than 10000 results"); }
        return [];
      },
      quoteDecimals: async () => 18,
      tokenDecimals: async () => new Map(),
    });
    assert.deepEqual(ranges.slice(0, 2), [[1, 4000], [1, 2000]]);
    assert.equal(s.toBlock, 8000);
    assert.ok(ranges.every(([f, t]) => t >= f));
    // Every block between 1 and 8000 was covered exactly once by a successful read.
    const covered = ranges.slice(1).reduce((n, [f, t]) => n + (t - f + 1), 0);
    assert.equal(covered, 8000);
  });

  it("surfaces an error a narrower range would not fix", async () => {
    await assert.rejects(() => resolvePoolsSweep(db, 1, 100, {
      chunk: 100,
      spacingMs: 0,
      readLogs: async () => { throw new Error("ECONNRESET"); },
      quoteDecimals: async () => 18,
      tokenDecimals: async () => new Map(),
    }), /ECONNRESET/);
  });
});
