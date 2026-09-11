import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addressIn, Analytics, keyFor, summary, today } from "./analytics.ts";
import { openDb, type DB } from "./db.ts";

const ADDR = "0x3f9abf816809a4d8aa98ed09fe848bc31b08c1e4";
const UA = "Mozilla/5.0 (Macintosh) Safari/605.1.15";
const BOT = "Mozilla/5.0 (l9scan/2.0; +https://leakix.net)";

let dir: string;
let db: DB;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "rekt-stats-"));
  db = openDb(join(dir, "test.db"));
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("keyFor", () => {
  it("strips the moving part of a path", () => {
    assert.equal(keyFor(`/r/${ADDR}`), "report");
    assert.equal(keyFor(`/card/${ADDR}.png`), "pass");
    assert.equal(keyFor(`/t/${ADDR}`), "token");
    assert.equal(keyFor("/"), "landing");
    assert.equal(keyFor("/api/board"), "board");
    assert.equal(keyFor("/desk.html"), "desk");
  });

  it("counts nothing for static files, fixtures and the health check", () => {
    assert.equal(keyFor("/static/app/board.js"), null);
    assert.equal(keyFor("/mock/report.json"), null);
    assert.equal(keyFor("/api/health"), null);
  });

  it("finds the wallet a report or a pass was asked for, and only there", () => {
    assert.equal(addressIn(`/r/${ADDR}`), ADDR);
    assert.equal(addressIn(`/card/${ADDR}.png`), ADDR);
    assert.equal(addressIn(`/t/${ADDR}`), null, "a token is not a wallet lookup");
  });
});

describe("Analytics", () => {
  it("counts people once a day however many pages they open, and never stores who", () => {
    const a = new Analytics(db);
    for (const p of ["/", `/r/${ADDR}`, `/card/${ADDR}.png`, "/api/board"]) a.record(p, 200, "1.2.3.4", UA);
    a.record("/", 200, "5.6.7.8", UA);
    a.flush();

    const [day] = summary(db);
    assert.equal(day.visitors, 2, "two people, five requests");
    assert.equal(day.hits.landing, 2);
    assert.equal(day.hits.report, 1);
    assert.equal(day.hits.pass, 1);
    assert.equal(day.wallets, 1, "one wallet looked up, by two routes");

    const rows = db.prepare("SELECT who FROM visits WHERE day = ?").all(today()) as Array<{ who: string }>;
    for (const r of rows) {
      assert.match(r.who, /^[0-9a-f]{16}$/);
      assert.ok(!r.who.includes("1.2.3.4"), "the address is hashed, not stored");
    }
  });

  it("keeps crawlers and errors out of the counts", () => {
    const a = new Analytics(db);
    const before = summary(db)[0];
    a.record("/", 200, "9.9.9.9", BOT);
    a.record(`/r/${ADDR}`, 404, "8.8.8.8", UA);
    a.flush();

    const after = summary(db)[0];
    assert.equal(after.visitors, before.visitors, "neither counts as a person");
    assert.equal(after.hits.landing, before.hits.landing, "the crawler did not move the page count");
    assert.equal(after.hits.bot, 1);
    assert.equal(after.hits.error, 1);
  });

  it("changes the salt with the day, so a hash cannot follow anybody", () => {
    const salts = db.prepare("SELECT key FROM meta WHERE key LIKE 'analytics_salt_%'").all() as Array<{ key: string }>;
    assert.equal(salts.length, 1, "only the current day's salt is kept");
    assert.equal(salts[0].key, `analytics_salt_${today()}`);
  });
});
