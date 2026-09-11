import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApi, describeReport, fillTemplate, fmtUsd, jsonForScript, type Api } from "./api.ts";
import { CFG } from "./chain/config.ts";
import type { ApiError, BoardReplay, Report } from "./types.ts";

/**
 * The server in MOCK=1 on a random port, against a throwaway web/ directory that carries the real
 * fixtures plus minimal pages, templates and one static file, so every route is exercised without
 * a database, the chain, or whatever the web builder has in web/ at the moment.
 */

const here = new URL(".", import.meta.url);
const realMock = new URL("../web/mock", here).pathname;
const roadmapPath = new URL("../ROADMAP.md", here).pathname;

const PASSENGER = "0x3f9abf816809a4d8aa98ed09fe848bc31b08c1e4";
const TOKEN = "0xb7434e55fcfcb771d217463717654d082e40d3d6";
const ZERO = "0x0000000000000000000000000000000000000000";

const TEMPLATE = (kind: string): string => `<!doctype html><html><head><title>{{title}}</title>
<meta name="description" content="{{description}}">
<meta property="og:title" content="{{title}}"><meta property="og:image" content="{{ogImage}}"><meta property="og:url" content="{{url}}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="{{ogImage}}">
</head><body data-kind="${kind}"><div id="c">{{content}}</div><script id="data" type="application/json">{{json}}</script>{{unknown}}</body></html>`;

let api: Api;
let base: string;
let webDir: string;

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> => fetch(base + path, { headers });
const getJson = async (path: string, headers: Record<string, string> = {}): Promise<{ res: Response; body: any }> => {
  const res = await get(path, headers);
  return { res, body: await res.json() };
};
const keys = (o: object): string[] => Object.keys(o).sort();
const embedded = (html: string): unknown => {
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "data script present");
  return JSON.parse(m[1]);
};

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), "rekt-web-"));
  cpSync(realMock, join(webDir, "mock"), { recursive: true });
  mkdirSync(join(webDir, "static"), { recursive: true });
  mkdirSync(join(webDir, "templates"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>REKT</title><h1>Now boarding: everyone.</h1>");
  writeFileSync(join(webDir, "hall.html"), "<!doctype html><title>Hall of Rekt</title>");
  writeFileSync(join(webDir, "static", "app.js"), "console.log('rekt');");
  writeFileSync(join(webDir, "static", "styles.css"), "body{}");
  for (const k of ["report", "token", "roadmap"]) writeFileSync(join(webDir, "templates", `${k}.html`), TEMPLATE(k));
  // staticTtl is pinned so the assertion below does not depend on whether DEV=1 is in the .env.
  api = await createApi({ mock: true, port: 0, webDir, cardsDir: join(webDir, "cards"), roadmapPath, log: false, sseMax: 2, staticTtl: 86_400 });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  rmSync(webDir, { recursive: true, force: true });
});

describe("helpers", () => {
  it("fmtUsd prints a real minus sign and grouping", () => {
    assert.equal(fmtUsd(-4212.09), "−$4,212");
    assert.equal(fmtUsd(1098.35), "$1,098");
    assert.equal(fmtUsd(-0.2), "$0");
  });
  it("describeReport matches the documented example", () => {
    const r = JSON.parse(readFileSync(join(realMock, "report.json"), "utf8")) as Report;
    assert.equal(describeReport(r), "Net −$4,212 on Pons. Rug Magnet, gate 290,141 of 314,736. Worst flight PONZI2, cancelled by the pilot.");
  });
  it("jsonForScript cannot close the script tag", () => {
    const s = jsonForScript({ a: "</script><b>" });
    assert.ok(!s.includes("<"));
    assert.deepEqual(JSON.parse(s), { a: "</script><b>" });
  });
  it("fillTemplate leaves unknown placeholders", () => {
    assert.equal(fillTemplate("{{a}}-{{b}}", { a: "1" }), "1-{{b}}");
  });
});

describe("JSON routes", () => {
  it("/api/health is never cached", async () => {
    const { res, body } = await getJson("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(keys(body), ["foldCursor", "lagBlocks", "lagSeconds", "latestBlock", "ok", "records", "watcherAgeSeconds"]);
    // How deep the record is: the honest limit of every answer the site gives, so a monitor can
    // watch it rather than waiting for somebody to notice an empty page.
    const rec = (body as { records: { complete: boolean; missing: string | null; pools: { missingDays: number } } }).records;
    assert.equal(typeof rec.complete, "boolean");
    assert.ok(rec.missing === null || typeof rec.missing === "string");
    assert.ok(rec.pools.missingDays >= 0);
  });

  it("/api/index carries the TTL, X-Cache and CORS headers", async () => {
    const first = await getJson("/api/index");
    assert.equal(first.res.status, 200);
    assert.equal(first.res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(first.res.headers.get("access-control-allow-origin"), "*");
    assert.equal(first.res.headers.get("cache-control"), "public, max-age=60");
    assert.ok(["hit", "miss"].includes(first.res.headers.get("x-cache") ?? ""));
    assert.deepEqual(keys(first.body), ["d", "label", "score", "w", "window"]);
  });

  it("/api/leaderboard/rekt validates the window", async () => {
    for (const q of ["", "?window=24h", "?window=all"]) {
      const { res, body } = await getJson(`/api/leaderboard/rekt${q}`);
      assert.equal(res.status, 200, q);
      assert.ok(Array.isArray(body) && body.length <= 10);
      assert.deepEqual(keys(body[0]), ["lossUsd", "tokens", "wallet", "worstSymbol"]);
    }
    const bad = await getJson("/api/leaderboard/rekt?window=1h");
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, "bad window");
    assert.equal(typeof bad.body.hint, "string");
  });

  it("/api/leaderboard/airlines returns AirlineRow[]", async () => {
    const { res, body } = await getJson("/api/leaderboard/airlines");
    assert.equal(res.status, 200);
    assert.deepEqual(keys(body[0]), ["deadShare", "deployer", "launches", "losers", "lostUsd"]);
  });

  it("/api/token/:token returns a TokenPage and rejects a bad address", async () => {
    const { res, body } = await getJson(`/api/token/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(keys(body), ["biggestLossUsd", "bornTs", "deployer", "deployerRecord", "diedTs", "lifespanMin", "losers", "lostUsd", "name", "peakMultiple", "status", "symbol", "token"]);
    const bad = await getJson("/api/token/0x1234");
    assert.equal(bad.res.status, 400);
    assert.deepEqual(bad.body, {
      error: "bad address",
      hint: "That is not an address. Passenger addresses look like 0x followed by 40 hex characters.",
    } satisfies ApiError);
  });

  it("/api/desk returns a Desk", async () => {
    const { res, body } = await getJson("/api/desk");
    assert.equal(res.status, 200);
    assert.deepEqual(keys(body), ["accruedUsd", "accruedWei", "ca", "contracts", "holdersHalfUsd", "ledger", "recipient", "recipientKind", "sharing", "walletWei"]);
    assert.equal(typeof body.accruedWei, "string");
    // The rule starts at the splitter, so the desk owes holders nothing while the wallet is the
    // recipient. A non-zero here with sharing false would be the page promising money it has not
    // promised, which is the one number on this route worth a test.
    assert.equal(body.sharing, false, "the fixture is pre-splitter");
    assert.equal(body.holdersHalfUsd, 0);
  });

  it("/api/report/:address returns the Report, case-insensitive on the path", async () => {
    const { res, body } = await getJson(`/api/report/${PASSENGER.toUpperCase().replace("0X", "0x")}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.equal(body.address, PASSENGER);
    assert.ok(keys(body).includes("bagsHeld"));
    assert.ok(body.badges.length <= 3);
  });

  it("/api/report of the zero address is the empty state", async () => {
    const { res, body } = await getJson(`/api/report/${ZERO}`);
    assert.equal(res.status, 404);
    assert.equal(body.error, "no flights");
    assert.match(body.hint, /^No flights on record for this passenger since [A-Z][a-z]+ \d{1,2}\. Either you never boarded, or you boarded before our records begin\.$/);
  });

  it("unknown paths and methods are JSON errors", async () => {
    const nf = await getJson("/api/nothing");
    assert.equal(nf.res.status, 404);
    assert.deepEqual(nf.body, { error: "not found", hint: "This gate does not exist." });
    const post = await fetch(`${base}/api/index`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
});

describe("the card", () => {
  it("/card/:address.png is a PNG (or 503 while the renderer is the stub)", async () => {
    const res = await get(`/card/${PASSENGER}.png?download=1`);
    if (res.status === 503) {
      const body = (await res.json()) as ApiError;
      assert.equal(body.error, "not ready");
      return;
    }
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="rekt-boarding-pass-0x3f9a\.\.\.c1e4\.png"; filename\*=UTF-8''rekt-boarding-pass-0x3f9a%E2%80%A6c1e4\.png$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const again = await get(`/card/${PASSENGER}.png`);
    assert.equal(again.headers.get("x-cache"), "hit");
  });

  it("the zero address has no card", async () => {
    const { res, body } = await getJson(`/card/${ZERO}.png`);
    assert.equal(res.status, 404);
    assert.equal(body.error, "no flights");
  });
});

describe("HTML shells", () => {
  it("/r/:address fills the template with OG tags and the report", async () => {
    const res = await get(`/r/${PASSENGER}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.ok(html.includes("<title>0x3f9a…c1e4 · Boarding pass · REKT</title>"));
    assert.ok(html.includes(`<meta property="og:image" content="${CFG.publicUrl}/card/${PASSENGER}.png">`));
    assert.ok(html.includes(`<meta property="og:url" content="${CFG.publicUrl}/r/${PASSENGER}">`));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(html.includes('content="Net −$4,212 on Pons. Rug Magnet, gate 290,141 of 314,736. Worst flight PONZI2, cancelled by the pilot."'));
    assert.ok(html.includes("{{unknown}}"), "unknown placeholders stay");
    const data = embedded(html) as Report;
    assert.equal(data.address, PASSENGER);
    assert.equal(data.className, "Rug Magnet");
  });

  it("/r of the zero address is a 404 shell with the ApiError embedded", async () => {
    const res = await get(`/r/${ZERO}`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.ok(html.includes(`<meta property="og:image" content="${CFG.publicUrl}/og.png">`));
    const err = embedded(html) as ApiError;
    assert.equal(err.error, "no flights");
    const asJson = await getJson(`/r/${ZERO}`, { accept: "application/json" });
    assert.equal(asJson.res.status, 404);
    assert.equal(asJson.body.error, "no flights");
    const bad = await getJson("/r/0xzz", { accept: "application/json" });
    assert.equal(bad.res.status, 400);
  });

  it("/t/:token fills the token template", async () => {
    const res = await get(`/t/${TOKEN}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<title>PONZI2 · Lost and found · REKT</title>"));
    assert.ok(html.includes(`<meta property="og:image" content="${CFG.publicUrl}/og.png">`));
    assert.ok(html.includes("Cancelled 34 s after boarding. 212 passengers lost $48,121 here. Pilot 0x7d07…86b2, 412 flights, 98% cancelled."));
    assert.equal((embedded(html) as { token: string }).token, TOKEN);
  });

  it("/roadmap embeds the rendered ROADMAP.md", async () => {
    const res = await get("/roadmap");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<title>Roadmap · REKT</title>"));
    assert.ok(html.includes('<ol class="roadmap">'));
    assert.ok(html.includes('id="item-0"'));
    assert.ok(!html.includes("Operations"));
  });
});

describe("static files", () => {
  it("serves the pages and static files with the right types and cache", async () => {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(home.headers.get("cache-control"), "public, max-age=60");
    assert.ok((await home.text()).includes("Now boarding"));
    const hall = await get("/hall");
    assert.equal(hall.status, 200);
    const js = await get("/static/app.js");
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(js.headers.get("cache-control"), "public, max-age=86400");
    const etag = js.headers.get("etag");
    assert.ok(etag);
    const cached = await get("/static/app.js", { "if-none-match": etag as string });
    assert.equal(cached.status, 304);
    const css = await get("/static/styles.css");
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    const fixture = await get("/mock/report.json");
    assert.equal(fixture.status, 200);
    assert.equal(fixture.headers.get("content-type"), "application/json; charset=utf-8");
  });

  it("serves the page files by their file name too", async () => {
    const res = await get("/hall.html");
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /text\/html/);
  });

  it("refuses path traversal and unrouted files", async () => {
    for (const p of ["/static/../../.env", "/static/..%2F..%2F.env", "/static/%2e%2e/%2e%2e/package.json", "/mock/../index.html", "/static/", "/index.html", "/templates/report.html", "/static/nothing.css"]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.equal(((await res.json()) as ApiError).error, "not found", p);
    }
  });
});

describe("the board", () => {
  it("sends a replay first, with an id, and counts connections", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/board?since=1`, { signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const msg = text.split("\n\n").find((m) => m.includes("event: replay")) as string;
    assert.ok(msg, "replay message");
    const lines = Object.fromEntries(msg.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
    assert.match(lines.id, /^\d+$/);
    const replay = JSON.parse(lines.data) as BoardReplay;
    assert.deepEqual(keys(replay), ["ca", "counters", "losses", "rows", "seq"]);
    assert.equal(replay.rows.length, 12);
    assert.equal(replay.losses.length, 20);
    assert.equal(String(replay.seq), lines.id);

    // The cap: two open streams are allowed by this test's config, the third is refused.
    const ctl2 = new AbortController();
    const second = await fetch(`${base}/api/board`, { signal: ctl2.signal });
    assert.equal(second.status, 200);
    const third = await getJson("/api/board");
    assert.equal(third.res.status, 503);
    assert.equal(third.body.error, "board full");
    ctl.abort();
    ctl2.abort();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After after 240 requests from one address", async () => {
    const ip = "203.0.113.7";
    let last: Response | null = null;
    for (let i = 0; i < 240; i++) {
      last = await get("/api/index", { "x-forwarded-for": `${ip}, 10.0.0.1` });
      assert.equal(last.status, 200, `request ${i + 1}`);
    }
    assert.equal(last?.headers.get("x-ratelimit-limit"), "240");
    assert.equal(last?.headers.get("x-ratelimit-remaining"), "0");
    const over = await get("/api/index", { "x-forwarded-for": ip });
    assert.equal(over.status, 429);
    assert.match(over.headers.get("retry-after") ?? "", /^\d+$/);
    const body = (await over.json()) as ApiError;
    assert.equal(body.error, "rate limited");
    assert.match(body.hint, /^240 requests a minute per passenger\. Please take a seat; boarding resumes in \d+ s\.$/);
    // Health and static files are exempt.
    assert.equal((await get("/api/health", { "x-forwarded-for": ip })).status, 200);
    assert.equal((await get("/static/app.js", { "x-forwarded-for": ip })).status, 200);
  });
});

/**
 * The same server on a real database: a launch, two positions and a cursor, so the routes that
 * scan trader_positions go through the query worker, the rank snapshot is installed from it, and
 * the board's per-IP seat cap and the printer's queue cap answer as documented.
 */
describe("with a database", () => {
  const WALLET = "0x00000000000000000000000000000000000000e1";
  const PILOT = "0x00000000000000000000000000000000000000d1";
  const TOK = "0x00000000000000000000000000000000000000a1";
  let dbApi: Api;
  let dbBase: string;
  let dbDir: string;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "rekt-api-db-"));
    const { openDb, setMeta } = await import("./db.ts");
    const { applyTrade } = await import("./fold.ts");
    const db = openDb(join(dbDir, "rekt.db"));
    db.prepare(`INSERT INTO launches (token, curve, deployer, launch_sender, pair_token, symbol, name, block, ts, tx, log_index, first_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(TOK, "0x00000000000000000000000000000000000001a1", PILOT, PILOT, ZERO, "ALPHA", "Alpha", 1_000, 1_000, "0xabc", 0, 1_000);
    db.prepare("INSERT INTO token_state (token, launched_ts, status, status_ts) VALUES (?,?,?,?)").run(TOK, 1_000, "boarding", 1_000);
    applyTrade(db, { wallet: WALLET, token: TOK, side: "buy", quote: 1, tokens: 1000, ts: 1_010 });
    applyTrade(db, { wallet: WALLET, token: TOK, side: "buy", quote: 1, tokens: 1000, ts: 1_020 });
    applyTrade(db, { wallet: WALLET, token: TOK, side: "sell", quote: 0.5, tokens: 2000, ts: 1_030 });
    applyTrade(db, { wallet: PILOT, token: TOK, side: "buy", quote: 1, tokens: 1000, ts: 1_005 });
    setMeta(db, "fold_from_block", "900");
    setMeta(db, "fold_to_block", "2000");
    db.close();
    // The nonce reader is stubbed so the suite never touches the chain: 0x11… has flown before our
  // record begins, everything else has never sent a transaction.
  dbApi = await createApi({ mock: false, dbPath: join(dbDir, "rekt.db"), port: 0, webDir, cardsDir: join(dbDir, "cards"), roadmapPath, log: false, sseMax: 10, ssePerIp: 1, cardQueue: 0,
      nonceOf: async (a: string) => (a === `0x${"11".repeat(20)}` ? 42 : 0) });
    dbBase = `http://127.0.0.1:${dbApi.port}`;
  });

  after(async () => {
    await dbApi.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  const dget = (path: string, init: RequestInit = {}): Promise<Response> => fetch(dbBase + path, init);

  it("serves the scans from the worker and ranks from its snapshot", async () => {
    const hall = await dget("/api/leaderboard/rekt?window=all");
    assert.equal(hall.status, 200);
    const rows = (await hall.json()) as Array<{ wallet: string; lossUsd: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wallet, WALLET);
    const air = await dget("/api/leaderboard/airlines");
    assert.equal(air.status, 200);
    assert.equal(((await air.json()) as Array<{ deployer: string }>)[0].deployer, PILOT);
    const idx = await dget("/api/index");
    assert.equal(idx.status, 200);
    assert.equal(typeof ((await idx.json()) as { score: number }).score, "number");
    const rep = await dget(`/api/report/${WALLET}`);
    assert.equal(rep.status, 200);
    const r = (await rep.json()) as Report;
    assert.equal(r.rank, 1);
    assert.equal(r.ofWallets, 1);
    // Two different empty answers, decided by whether the wallet has ever sent a transaction.
    const nobody = await dget(`/api/report/${ZERO}`);
    assert.equal(nobody.status, 404);
    assert.match(((await nobody.json()) as ApiError).hint, /never sent a transaction/);
    const busy = await dget(`/api/report/0x${"11".repeat(20)}`);
    assert.equal(busy.status, 404);
    const busyHint = ((await busy.json()) as ApiError).hint;
    assert.match(busyHint, /has been busy/);
    assert.match(busyHint, /still filling backwards/);
  });

  it("caps board seats per IP and gives HEAD none", async () => {
    const head = await dget("/api/board", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const ctl = new AbortController();
    const first = await dget("/api/board", { signal: ctl.signal });
    assert.equal(first.status, 200);
    const second = await dget("/api/board");
    assert.equal(second.status, 503);
    assert.equal(((await second.json()) as ApiError).error, "board full");
    const other = await dget("/api/board", { method: "HEAD", headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(other.status, 200);
    ctl.abort();
    await new Promise((r) => setTimeout(r, 50));
    const again = await dget("/api/board", { method: "HEAD" });
    assert.equal(again.status, 200);
  });

  it("answers busy when the printer's queue is full", async () => {
    const res = await dget(`/card/${WALLET}.png`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.deepEqual(await res.json(), { error: "busy", hint: "The printer is busy. Take a seat; your pass is next." } satisfies ApiError);
  });
});
