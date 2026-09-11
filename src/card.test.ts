import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_HEIGHT, CARD_WIDTH, renderCard, shortAddress, shortDate } from "./card.ts";
import { printable } from "./ogcard.ts";
import type { BoardRow, Report } from "./types.ts";

const ROOT = join(import.meta.dirname, "..");
const fixture = (): Report => JSON.parse(readFileSync(join(ROOT, "web", "mock", "report.json"), "utf8")) as Report;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (b: Uint8Array, off: number): number => ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;

test("renders the fixture to a 1200 by 630 PNG", async () => {
  const t0 = performance.now();
  const png = await renderCard(fixture(), 1789000000);
  const ms = performance.now() - t0;
  assert.ok(png instanceof Uint8Array);
  assert.deepEqual(Array.from(png.subarray(0, 8)), PNG_SIGNATURE);
  // IHDR is the first chunk: length(4) type(4) then width and height.
  assert.equal(Buffer.from(png.subarray(12, 16)).toString("ascii"), "IHDR");
  assert.equal(u32(png, 16), CARD_WIDTH);
  assert.equal(u32(png, 20), CARD_HEIGHT);
  assert.equal(CARD_WIDTH, 1200);
  assert.equal(CARD_HEIGHT, 630);
  assert.ok(png.length > 10_000, `png is ${png.length} bytes`);
  assert.ok(ms < 5000, `render took ${ms.toFixed(0)} ms`);
});

test("renders a survivor and an unranked wallet without a CA", async () => {
  const r = fixture();
  const survivor: Report = {
    ...r, netRealizedUsd: 1098.35, realizedUsd: 0, className: "Survivor", worst: null, notAlone: null,
    rank: null, percentile: null, ca: null, unpricedPositions: 0, badges: [],
  };
  const t0 = performance.now();
  const png = await renderCard(survivor, 1789000000);
  assert.equal(u32(png, 16), CARD_WIDTH);
  assert.equal(u32(png, 20), CARD_HEIGHT);
  // Fonts are cached after the first render, so the second one is quick.
  assert.ok(performance.now() - t0 < 3000);
});

test("formats addresses and dates the way the site does", () => {
  assert.equal(shortAddress("0x3f9abf816809a4d8aa98ed09fe848bc31b08c1e4"), "0x3f9a…c1e4");
  assert.equal(shortDate(1788513127), "Sep 4 2026");
});

describe("the link preview", () => {
  const rowFor = (symbol: string): BoardRow => ({
    token: `0x${"1".repeat(40)}`, symbol, name: symbol, flight: "RK-1",
    deployer: `0x${"2".repeat(40)}`, pair: `0x${"0".repeat(40)}`, pairSymbol: "ETH",
    ts: 1_700_000_000, status: "boarding", statusTs: 1_700_000_000,
  });

  it("passes over a ticker that would carry a slur into somebody's feed", () => {
    assert.equal(printable(rowFor("DUCKLING")), true);
    assert.equal(printable(rowFor("PONZI2")), true);
    assert.equal(printable(rowFor("FUCKSONY")), false, "seen on the live board");
    assert.equal(printable(rowFor("Retard Coin")), false);
    assert.equal(printable(rowFor("HODL")), true, "an ordinary ticker is not caught");
  });

  it("catches it in the name as well as the ticker", () => {
    const r = { ...rowFor("CALM"), name: "shitcoin supreme" };
    assert.equal(printable(r), false);
  });
});
