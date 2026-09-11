import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { stateClient, withRetry } from "./chain/chain.ts";
import { BLOCKS_PER_SECOND, CFG, short } from "./chain/config.ts";
import { BUSY_MS, getMeta, now, openDb, type DB } from "./db.ts";
import { Analytics } from "./analytics.ts";
import { counters as boardCounters, currentSeq, readEventRows, recentBoard, storedGauge, storeGauge, type TurbulenceGauge } from "./board.ts";
import { coverage } from "./coverage.ts";
import type { CardJob, CardReply } from "./cardworker.ts";
import { deskData, deskRecipient, indexEscrowSince } from "./desk.ts";
import { airlines, hallOfRekt } from "./leaderboards.ts";
import type { QueryJob, QueryReply } from "./queryworker.ts";
import { buildReport, NO_DEPLOYER, sinceTs } from "./report.ts";
import { parseRoadmap, renderRoadmap } from "./roadmap.ts";
import { tokenPage } from "./tokenpage.ts";
import { turbulence, type Turbulence } from "./turbulence.ts";
import type { ApiError, BoardReplay, CountersEvent, HallWindow, Health, LossEvent, Report, TokenPage } from "./types.ts";

/**
 * rekt-api: one node:http process serving JSON under /api/, the boarding pass PNG, the SSE board,
 * server-rendered shells and the static site. The contract is docs/api.md; every body is a type
 * from src/types.ts. MOCK=1 serves web/mock fixtures and never opens the database or the chain.
 */

export type ApiOptions = {
  port?: number;
  host?: string;
  mock?: boolean;
  /** Directory with index.html, static/, templates/, mock/. Default web/. */
  webDir?: string;
  /** Where the PNG cache lives. Default data/cards. */
  cardsDir?: string;
  dbPath?: string;
  roadmapPath?: string;
  /** Requests per minute per IP. Default 240. */
  rateLimit?: number;
  /** Open SSE connections at most. Default 200. */
  sseMax?: number;
  /** Open SSE connections per IP at most. Default 5. */
  ssePerIp?: number;
  /** Passes waiting for the printer at most; beyond it the card answers 503 `busy`. Default 16. */
  cardQueue?: number;
  /** Console logging of one line per request. Default true. */
  log?: boolean;
  /** Seconds a browser may cache /static/*. Default 86400, or 60 when DEV=1. */
  staticTtl?: number;
  /**
   * How many transactions an address has sent, for telling "never flew" from "before our record".
   * The chain by default; the tests pass their own so the suite never touches the network.
   */
  nonceOf?: (address: string) => Promise<number>;
};

export type Api = { server: Server; port: number; close: () => Promise<void> };

// ---------------------------------------------------------------- copy, verbatim from docs/api.md

const HINTS = {
  "bad address": "That is not an address. Passenger addresses look like 0x followed by 40 hex characters.",
  "bad window": "Window is 24h or all.",
  // Three different answers, because "nothing here" has three different causes and a visitor who
  // traded yesterday must not read the same line as one who has never touched the chain.
  "no flights": (since: string) => `No flights on record for this passenger since ${since}. Either you never boarded, or you boarded before our records begin.`,
  "never flew": "This wallet has never sent a transaction on Robinhood Chain. Nothing to print.",
  "before our record": (since: string) => `This wallet has been busy, but not since ${since}, which is as far back as our record reaches today. The record is still filling backwards towards 4 August; try again later and the flights will be here.`,
  "unknown token": "No flight by that number. The token was not launched on Pons v2, or not within our records.",
  "not found": "This gate does not exist.",
  "internal": "Something went wrong at the desk. Try again in a minute.",
  "not ready": "The board is warming up. First flights appear once the fold has a cursor.",
  "rate limited": (s: number) => `240 requests a minute per passenger. Please take a seat; boarding resumes in ${s} s.`,
  "board full": "Every seat at the gate is taken. Try again in a minute.",
  "busy": "The printer is busy. Take a seat; your pass is next.",
  "method not allowed": "This desk only answers GET.",
} as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** The origin the static pages are written with; rewritten to PUBLIC_URL when they are served. */
const CANONICAL_ORIGIN = "https://rekt.report";
const RATE_WINDOW_MS = 60_000;
const TTL = { report: 300, token: 300, index: 60, leaderboard: 60, desk: 60, page: 60, static: 86_400, card: 3600 } as const;

/**
 * How often each leaderboard is recomputed, in seconds, set against what the query costs rather
 * than against a tidy number. Measured over 5.9M positions: the 24h hall takes about 20 seconds,
 * airlines about 13, and the all-time hall nearly four minutes. Recomputing the last one every
 * minute is not a cache, it is a treadmill: it never finishes before it is due again, and it holds
 * the one query worker the whole time. All-time losses do not move meaningfully in half an hour.
 * Stale answers are served while the new one is computed, so these windows cost nobody any wait.
 */
const LEADERBOARD_TTL = { hall24h: 120, hallAll: 1800, airlines: 600 } as const;

/**
 * How often the turbulence index is recomputed, as opposed to how long a browser may hold it.
 * The scan takes the better part of a minute on the one query worker, so recomputing it every
 * minute left no room there for anything else; the gauge moves slowly enough that a quarter of an
 * hour is honest. The cache header stays at a minute, because a reader reloading should see the
 * current gauge rather than the one their browser kept.
 */
const INDEX_REFRESH_S = 900;
/**
 * How long a browser may keep a static file. A day in production; a minute while `DEV=1`, because
 * a stylesheet or a board script cached for a day is a change nobody can see: every reload short
 * of a hard one keeps serving yesterday's file. Set DEV=1 in .env while building.
 */
const staticTtlDefault = (): number => (process.env.DEV === "1" ? 60 : TTL.static);
/** Bytes an SSE client may leave unread before it is cut off; it reconnects with Last-Event-ID and gets the replay. */
const SSE_BACKLOG_BYTES = 256 * 1024;
const CARD_PRUNE_MS = 600_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Pages served as plain files from web/ (docs/api.md, HTML routes). */
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/hall": "hall.html",
  "/airlines": "airlines.html",
  "/leaderboards": "leaderboards.html",
  "/desk": "desk.html",
  "/turbulence": "turbulence.html",
  "/about": "about.html",
};

// ---------------------------------------------------------------- small helpers

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** JSON for a <script type="application/json"> block: no `<` survives, so the tag cannot be closed early. */
export const jsonForScript = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** −$4,212 · $1,098. Whole dollars, a real minus sign, tabular grouping. */
export const fmtUsd = (v: number): string => {
  const n = Math.round(Math.abs(v));
  return `${v < 0 && n > 0 ? "−" : ""}$${n.toLocaleString("en-US")}`;
};
const fmtInt = (v: number): string => Math.round(v).toLocaleString("en-US");
const fmtSpan = (minutes: number): string => {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))} s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "September 3", the way the pages print a date in copy. */
const isoDate = (ts: number): string => { const d = new Date(ts * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

/** {{title}}-style placeholders; unknown ones stay. */
export function fillTemplate(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** One line for the report shell's description and the OG card text. */
export function describeReport(r: Report): string {
  const gate = r.rank !== null ? `gate ${fmtInt(r.rank)} of ${fmtInt(r.ofWallets)}` : "unranked";
  const worst = r.worst
    ? `Worst flight ${r.worst.symbol}, ${r.worst.deployer === NO_DEPLOYER ? "already in the air when our records begin" : r.worst.dead ? "cancelled by the pilot" : "still boarding"}.`
    : "No losing flights on record.";
  return `Net ${fmtUsd(r.netRealizedUsd)} on Pons. ${r.className}, ${gate}. ${worst}`;
}

export function describeToken(t: TokenPage): string {
  const span = fmtSpan(t.lifespanMin);
  const opening = t.status === "cancelled" ? `Cancelled ${span} after boarding.`
    : t.status === "departed" ? `Departed after ${span}.`
    : t.status === "arrived" ? `Arrived at Uniswap after ${span}.`
    : `Still boarding, ${span} in.`;
  // A token we know only through its pool has no launch on record, so it has no pilot either.
  // Saying so is the honest line; printing the zero address as a wallet is not.
  const pilot = t.deployer === NO_DEPLOYER
    ? "This flight was already in the air when our records begin, so the pilot is unknown."
    : `Pilot ${short(t.deployer)}, ${fmtInt(t.deployerRecord.launches)} flights, ${Math.round(t.deployerRecord.deadShare * 100)}% cancelled.`;
  return `${opening} ${fmtInt(t.losers)} passengers lost ${fmtUsd(t.lostUsd)} here. ${pilot}`;
}

/** Built-in shells, used only while web/templates/*.html do not exist yet. */
const FALLBACK_TEMPLATE = (kind: "report" | "token" | "roadmap"): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<meta name="description" content="{{description}}">
<meta property="og:type" content="website"><meta property="og:title" content="{{title}}">
<meta property="og:description" content="{{description}}"><meta property="og:image" content="{{ogImage}}">
<meta property="og:url" content="{{url}}"><link rel="canonical" href="{{url}}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{{title}}">
<meta name="twitter:description" content="{{description}}"><meta name="twitter:image" content="{{ogImage}}">
<link rel="stylesheet" href="/static/site.css"></head>
<body data-page="${kind}"><main id="app">${kind === "roadmap" ? "{{content}}" : "<p class=\"loading\">Loading the pass.</p>"}</main>
<script id="data" type="application/json">{{json}}</script>
<script type="module" src="/static/${kind}.js"></script></body></html>
`;

// ---------------------------------------------------------------- memo cache

type Entry<T> = { at: number; ttl: number; value: T };

/** Small JSON results only; the card's bytes live on disk (see card()). */
export class Memo {
  #entries = new Map<string, Entry<unknown>>();
  #inflight = new Map<string, Promise<unknown>>();
  #pinned = new Set<string>();

  /**
   * The value and whether it came from the cache. One computation at a time per key, and an entry
   * that has merely gone stale still answers while the new one is computed.
   *
   * That last part is not an optimisation, it is the difference between a site and a spinner. The
   * all-time hall takes minutes over millions of positions, far longer than any sensible cache
   * window, so a plain expiry meant every request after the window recomputed from scratch and the
   * visitor sat through it. A number that is a few minutes old is a fine answer to "who lost the
   * most"; a blank table is not.
   */
  async get<T>(key: string, ttlSec: number, compute: () => Promise<T> | T): Promise<{ value: T; hit: boolean }> {
    const e = this.#entries.get(key) as Entry<T> | undefined;
    const fresh = e !== undefined && Date.now() - e.at < e.ttl * 1000;
    if (fresh) return { value: e.value, hit: true };
    const p = this.#begin(key, ttlSec, compute);
    if (e !== undefined) return { value: e.value, hit: true }; // stale, and already being replaced
    return { value: await p, hit: false };
  }

  /** Starts the computation for a key, or joins the one already running. */
  #begin<T>(key: string, ttlSec: number, compute: () => Promise<T> | T): Promise<T> {
    let p = this.#inflight.get(key) as Promise<T> | undefined;
    if (p) return p;
    p = Promise.resolve().then(compute);
    this.#inflight.set(key, p);
    p.then(
      (value) => { this.#entries.set(key, { at: Date.now(), ttl: ttlSec, value }); this.#inflight.delete(key); },
      () => this.#inflight.delete(key),
    );
    if (this.#entries.size > 5000) this.prune();
    return p;
  }

  /**
   * Always computes, and resolves with the new value. `get` deliberately answers with a stale
   * entry, which is wrong for the job whose whole purpose is to replace that entry: it would
   * return the old answer at once and save it back with a fresh timestamp, so the saved copy
   * would claim to be current forever.
   */
  refresh<T>(key: string, ttlSec: number, compute: () => Promise<T> | T): Promise<T> {
    return this.#begin(key, ttlSec, compute);
  }

  /**
   * Marks a key whose entry must survive pruning however old it gets. Serving stale while the
   * new answer computes only works while there is something stale to serve; the prune that ran
   * every ten minutes was deleting exactly those entries, and the next visitor then waited out
   * the whole recompute, queued behind whatever the scanning worker was already doing. Three
   * requests for the day's hall took fourteen, seven and twenty-six seconds that way.
   */
  pin(key: string): void { this.#pinned.add(key); }

  /** Puts a value in without computing it: what a restart reads back from disk. */
  seed<T>(key: string, ttlSec: number, value: T, at: number): void {
    this.#entries.set(key, { at, ttl: ttlSec, value });
  }

  /** Drops expired entries; only when that leaves too many does everything go. */
  prune(): void {
    const t = Date.now();
    for (const [k, e] of this.#entries) if (t - e.at >= e.ttl * 1000 && !this.#pinned.has(k)) this.#entries.delete(k);
    if (this.#entries.size > 5000) for (const k of this.#entries.keys()) if (!this.#pinned.has(k)) this.#entries.delete(k);
  }
}

// ---------------------------------------------------------------- worker threads

class Busy extends Error {}

/** One worker, one job at a time, answers matched by id; respawned after a crash. */
class WorkerLane<Job extends { id: number }, Reply extends { id: number; error?: string }> {
  #worker: Worker | null = null;
  #pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  #next = 1;
  readonly #script: URL;
  readonly #data: unknown;
  readonly #name: string;
  #closed = false;

  constructor(name: string, script: URL, data?: unknown) {
    this.#name = name;
    this.#script = script;
    this.#data = data;
  }

  #spawn(): Worker {
    // Room for the rank table, which is one entry per wallet and grows with the chain. A worker
    // that runs out of heap dies without a message, and before the retry below that was answered
    // by doing its work on the event loop instead, which took the site down for the length of it.
    // No stderr pipe of our own: the worker's stderr already reaches the process's, and a piped
    // one is a handle that keeps this process alive after close(), which hung the test suite.
    const w = new Worker(this.#script, { workerData: this.#data, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    w.unref();
    w.on("message", (r: Reply) => {
      const p = this.#pending.get(r.id);
      if (!p) return;
      this.#pending.delete(r.id);
      if (r.error !== undefined) p.reject(new Error(r.error));
      else p.resolve(r);
    });
    const dead = (why: string): void => {
      if (this.#worker === w) this.#worker = null;
      for (const [id, p] of this.#pending) { this.#pending.delete(id); p.reject(new Error(why)); }
    };
    w.on("error", (e) => { console.error(`[${this.#name}] worker threw: ${e.stack ?? e.message}`); dead(`${this.#name} worker failed: ${e.message}`); });
    w.on("exit", (code) => { if (code !== 0) console.error(`[${this.#name}] worker exited with ${code}, ${this.#pending.size} job(s) in flight`); dead(`${this.#name} worker exited (${code})`); });
    return w;
  }

  get pending(): number { return this.#pending.size; }

  /** Starts the worker now rather than on the first job, so the cost lands where it is chosen. */
  spawnNow(): void { this.#worker ??= this.#spawn(); }

  run(job: Omit<Job, "id">): Promise<Reply> {
    // A lane that was closed stays closed: a retry arriving after shutdown must not start a new
    // worker that nothing will ever terminate.
    if (this.#closed) return Promise.reject(new Error(`${this.#name} lane is closed`));
    this.#worker ??= this.#spawn();
    const id = this.#next++;
    return new Promise<Reply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker!.postMessage({ ...job, id });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const w = this.#worker;
    this.#worker = null;
    if (w) await w.terminate();
  }
}

// ---------------------------------------------------------------- rate limit

class RateLimiter {
  #hits = new Map<string, { n: number; until: number }>();
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }

  /** Counts one request; returns remaining (negative when over) and seconds until the window resets. */
  take(who: string): { remaining: number; retryAfter: number } {
    const t = Date.now();
    let seen = this.#hits.get(who);
    if (!seen || t > seen.until) {
      if (this.#hits.size > 20_000) this.#hits.clear();
      seen = { n: 0, until: t + RATE_WINDOW_MS };
      this.#hits.set(who, seen);
    }
    seen.n++;
    return { remaining: this.limit - seen.n, retryAfter: Math.max(1, Math.ceil((seen.until - t) / 1000)) };
  }
}

// ---------------------------------------------------------------- the app

class NotReady extends Error {}
class NotFound extends Error {
  readonly code: "no flights" | "unknown token" | "not found";
  readonly hint: string;
  constructor(code: "no flights" | "unknown token" | "not found", hint: string) {
    super(code);
    this.code = code;
    this.hint = hint;
  }
}

const isStub = (err: unknown): boolean => /not implemented/i.test(String((err as Error)?.message ?? err));

export function createApi(opts: ApiOptions = {}): Promise<Api> {
  const mock = opts.mock ?? process.env.MOCK === "1";
  const webDir = resolve(opts.webDir ?? process.env.WEB_DIR ?? "web");
  const cardsDir = resolve(opts.cardsDir ?? process.env.CARDS_DIR ?? "data/cards");
  const roadmapPath = opts.roadmapPath ?? "ROADMAP.md";
  const limiter = new RateLimiter(opts.rateLimit ?? (Number(process.env.RATE_LIMIT) || 240));
  const sseMax = opts.sseMax ?? (Number(process.env.SSE_MAX) || 200);
  const ssePerIp = opts.ssePerIp ?? (Number(process.env.SSE_PER_IP) || 5);
  const cardQueue = opts.cardQueue ?? (Number(process.env.CARD_QUEUE) || 16);
  const staticTtl = opts.staticTtl ?? staticTtlDefault();
  const nonceOf = opts.nonceOf ?? (async (address: string): Promise<number> =>
    Number(await withRetry(() => stateClient.getTransactionCount({ address: address as `0x${string}` }))));
  const log = opts.log ?? true;
  const memo = new Memo();
  const timers: NodeJS.Timeout[] = [];
  // What this thread is working on, for the stall detector. Set on the way in, cleared on the way
  // out; a synchronous block means the handler never reached the clear, which is exactly the case
  // worth naming.
  let inFlight = "";
  // The last thing that started, never cleared. A timer's label is restored the moment it
  // returns, and the heartbeat that notices a block only runs after that, so it must ask what
  // started last rather than what is running now; for a request the two are the same thing.
  let lastStarted = "";
  const started = (label: string): void => { inFlight = label; lastStarted = label; };
  const later = (ms: number, name: string, fn: () => void): void => {
    timers.push(setTimeout(() => {
      const was = inFlight;
      started(`delayed ${name}`);
      try { fn(); } catch (err) { console.error(`api: ${name} failed (${(err as Error).message}`); }
      inFlight = was;
    }, ms));
  };
  const every = (ms: number, name: string, fn: () => void): void => {
    timers.push(setInterval(() => {
      const was = inFlight;
      started(`timer ${name}`);
      try { fn(); } catch (err) { console.error(`api: ${name} failed (${(err as Error).message})`); }
      inFlight = was;
    }, ms));
  };
  /** Who came and what they used; written to the same database every 15 seconds. */
  let stats: Analytics | null = null;

  const dbPath = opts.dbPath ?? CFG.dbPath;
  // Boot is logged step by step, because a slow start looks like a hung site and the steps are
  // the only place a stall this early can hide: the heartbeat that reports blocks starts later.
  const bootT0 = Date.now();
  const boot = (step: string): void => { if (!mock) console.log(`api: boot ${((Date.now() - bootT0) / 1000).toFixed(1)}s ${step}`); };
  // Short, on purpose: see BUSY_MS. This process must never stop serving to wait for a lock.
  const db: DB | null = mock ? null : openDb(dbPath, { busyMs: BUSY_MS.serving });
  boot("database open");
  // The heavy reads run on their own thread and read-only connection; a memory database has no
  // second connection, so those fall back to the main thread (tests).
  const queries = db && dbPath !== ":memory:" ? new WorkerLane<QueryJob, QueryReply>("scans", new URL("./queryworker.ts", import.meta.url), { dbPath }) : null;
  // Reports get a lane of their own, so a person's page never waits behind a minutes-long scan.
  const reports = db && dbPath !== ":memory:" ? new WorkerLane<QueryJob, QueryReply>("reports", new URL("./queryworker.ts", import.meta.url), { dbPath }) : null;
  const press = new WorkerLane<CardJob, CardReply>("press", new URL("./cardworker.ts", import.meta.url));
  // Started here, one after the other, rather than by whichever job arrives first after listen:
  // two workers coming up at once was the last unexplained pause after boot, and a pause here
  // costs only boot time while a pause after listen costs every visitor.
  // All three workers start here, in this order, before the server listens. The printer started
  // on its first job instead, a tenth of a second after listen, stalled this thread for forty
  // seconds while it was otherwise idle, on every boot, and the site answered nothing for the
  // whole of it. Started here, after the two scanners, the same first job costs nothing. Why a
  // late start stalls the parent was not established; that it does was, and the order of these
  // three lines is what this comment is here to protect.
  reports?.spawnNow();
  boot("reports worker started");
  queries?.spawnNow();
  boot("scans worker started");
  press.spawnNow();
  boot("printer started");
  if (db) {
    // Rendered once at boot: the first render costs about six seconds of satori warm-up, and an
    // unfurler gives up long before that. After this the cache always has something to answer with.
    // Under a name and timed: this is the one thing that runs between listen and the first
    // request, and a pause there is invisible to the detector unless it is labelled.
    later(100, "link preview warm-up", () => {
      const t0 = Date.now();
      void ogCard(null).then(
        () => console.log(`api: link preview warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`),
        (err) => console.error(`api: link preview warm-up failed (${(err as Error).message})`),
      );
    });
    stats = new Analytics(db);
    timers.push(setInterval(() => stats?.flush(), 15_000).unref?.() ?? setInterval(() => stats?.flush(), 15_000));
  }

  // The roadmap is rendered once at start (SPEC 3.7): a status changes on the site only with a deploy.
  let roadmapHtml = "<ol class=\"roadmap\"></ol>";
  let roadmapItems: unknown[] = [];
  try {
    const md = readFileSync(roadmapPath, "utf8");
    roadmapHtml = renderRoadmap(md);
    boot("roadmap rendered");
    roadmapItems = parseRoadmap(md);
  } catch (err) {
    console.error(`api: roadmap not rendered (${(err as Error).message})`);
  }

  function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(join(webDir, "mock", `${name}.json`), "utf8")) as T;
  }

  // ---- data access, real or mock

  const ready = (): boolean => mock || (db !== null && getMeta(db, "fold_to_block") !== null);
  const needDb = (): DB => {
    if (!db || !ready()) throw new NotReady("not ready");
    return db;
  };

  // report.sinceTs: from meta.fold_from_block and the nearest launch, cached a minute; never a
  // scan of trader_positions per unknown address.
  const sinceDate = (): string => {
    if (mock) return isoDate(fixture<Report>("report").since);
    if (!db) return isoDate(now());
    return isoDate(sinceTs(db) || now());
  };

  /**
   * A heavy read, on the query worker. Never here.
   *
   * These scans take tens of seconds over millions of positions, and node:sqlite is synchronous,
   * so running one on this thread is the whole site stopped for its duration. That used to be the
   * fallback when the worker died, and it turned an invisible worker crash into a minute of a
   * frozen site with only one line in the log to say why. A dead worker is respawned and the job
   * is sent once more; if that fails too the caller answers with whatever it had, which for a
   * leaderboard is a slightly old table and for a fresh process is an empty one.
   *
   * `here` is still the path when there is no worker at all, which is the tests and mock mode,
   * where the database is small enough that none of this matters.
   */
  async function query<T>(job: Omit<QueryJob, "id">, here: () => T): Promise<T> {
    needDb();
    if (!queries) return here();
    try {
      return (await queries.run(job)).value as T;
    } catch (err) {
      console.error(`api: query worker ${job.kind} failed (${(err as Error).message}); retrying on a new worker`);
      return (await queries.run(job)).value as T;
    }
  }

  const ZERO = "0x0000000000000000000000000000000000000000";

  /**
   * A wallet's report, built on the report worker.
   *
   * For a person this is milliseconds of work. For a router or a bot with a hundred thousand
   * positions it is seconds, and the first line of the Hall of Rekt is exactly such an address,
   * so it used to be that one click on the most-clicked link froze the site for everybody for
   * six seconds. Off the event loop it costs that visitor six seconds and nobody else anything.
   * A worker that died is respawned and asked once more; without a worker at all (tests, a
   * memory database) the report is built here as before.
   */
  async function report(address: string): Promise<{ value: Report | null; hit: boolean }> {
    if (mock) return { value: address === ZERO ? null : fixture<Report>("report"), hit: false };
    return memo.get(`report:${address}`, TTL.report, async () => {
      await rankReady;
      if (!reports) return buildReport(needDb(), address);
      const go = async () => (await reports.run({ kind: "report", address })).value as Report | null;
      try {
        return await go();
      } catch (err) {
        console.error(`api: report worker failed for ${address} (${(err as Error).message}); retrying on a new worker`);
        return go();
      }
    });
  }
  /**
   * Which empty answer a wallet with no positions deserves.
   *
   * A visitor who traded this week and reads "either you never boarded, or you boarded before our
   * records begin" concludes the site is broken, and they are half right: the record is short while
   * it fills backwards. One state read settles it. A wallet that has never sent a transaction gets
   * a plain answer; one that has gets told its flights are older than the record and are coming.
   * Cached, because the same address is usually pasted twice, and never allowed to fail the page:
   * if the chain read errors, the original wording stands.
   */
  async function emptyHint(address: string): Promise<string> {
    const since = sinceDate();
    if (mock || !db) return HINTS["no flights"](since);
    try {
      const { value } = await memo.get(`nonce:${address}`, 600, () => nonceOf(address));
      return value > 0 ? HINTS["before our record"](since) : HINTS["never flew"];
    } catch {
      return HINTS["no flights"](since);
    }
  }

  async function token(addr: string): Promise<{ value: TokenPage | null; hit: boolean }> {
    if (mock) return { value: fixture<TokenPage>("token"), hit: false };
    return memo.get(`token:${addr}`, TTL.token, () => tokenPage(needDb(), addr));
  }
  memo.pin("index");
  const index = () => mock ? Promise.resolve({ value: fixture<Turbulence>("index"), hit: false })
    : memo.get("index", INDEX_REFRESH_S, () => query<Turbulence>({ kind: "turbulence", nowTs: now() }, () => turbulence(needDb(), now())));
  // Today's hall reads the small indexed losses table and stays here; all-time scans positions.
  // Both windows go to the worker. The 24h one used to run here, on the main thread, and a miss
  // stopped every other request on the server for as long as the scan took.
  const computeHall = (w: HallWindow) => query({ kind: "hall", window: w, limit: 10 }, () => hallOfRekt(needDb(), w, 10));
  const computeAirlines = () => query({ kind: "airlines", limit: 10 }, () => airlines(needDb(), 10));
  const hallTtl = (w: HallWindow) => LEADERBOARD_TTL[w === "24h" ? "hall24h" : "hallAll"];
  const hall = (w: HallWindow) => mock ? Promise.resolve({ value: fixture("leaderboard-rekt"), hit: false })
    : memo.get(`hall:${w}`, hallTtl(w), () => computeHall(w));
  const airlinesRows = () => mock ? Promise.resolve({ value: fixture("leaderboard-airlines"), hit: false })
    : memo.get("airlines", LEADERBOARD_TTL.airlines, computeAirlines);

  /** The gauge the board's counters carry, refreshed through the index memo (the worker) rather than on the tick. */
  // The gauge starts as the last one any process computed, and is kept for the next process
  // whenever the worker answers. Between boot and the first answer the board shows a gauge that
  // is minutes old rather than computing one here: see storedGauge.
  let turb: TurbulenceGauge | undefined = db ? storedGauge(db) : undefined;
  function refreshTurb(): void {
    if (mock || !ready()) return;
    index().then(({ value }) => {
      turb = { score: value.score, label: value.label };
      if (db) storeGauge(db, turb);
    }, () => { /* the counters keep the last gauge */ });
  }
  const desk = () => mock ? Promise.resolve({ value: fixture("desk"), hit: false })
    : memo.get("desk", TTL.desk, () => deskData(db as DB));

  function health(): Health {
    if (mock) return fixture<Health>("health");
    const d = db as DB;
    const num = (k: string): number | null => {
      const v = Number(getMeta(d, k) ?? NaN);
      return Number.isFinite(v) ? v : null;
    };
    const foldCursor = num("fold_to_block");
    const latestBlock = num("live_head_block");
    const seenAt = num("live_seen_at");
    const watcherAgeSeconds = seenAt === null ? null : Math.max(0, now() - seenAt);
    const lagBlocks = latestBlock !== null && foldCursor !== null ? Math.max(0, latestBlock - foldCursor) : 0;
    const lagSeconds = Math.round((lagBlocks / BLOCKS_PER_SECOND) * 10) / 10;
    const ok = latestBlock !== null && watcherAgeSeconds !== null && lagSeconds < 120 && watcherAgeSeconds < 120;
    return { lagBlocks, lagSeconds, watcherAgeSeconds, foldCursor, latestBlock, ok, records: coverage(d, latestBlock ?? undefined) };
  }

  // ---- responses

  function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string>): void {
    res.statusMessage = "";
    res.writeHead(status, { "content-length": String(Buffer.byteLength(body as never)), ...headers });
    res.end(body);
  }
  function json(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
    send(res, status, JSON.stringify(body), {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...headers,
    });
  }
  function fail(res: ServerResponse, status: number, error: string, hint: string, headers: Record<string, string> = {}): void {
    json(res, { error, hint } satisfies ApiError, status, { "cache-control": "no-store", ...headers });
  }
  function cacheHeaders(ttl: number, hit: boolean): Record<string, string> {
    return { "cache-control": `public, max-age=${ttl}`, "x-cache": hit ? "hit" : "miss" };
  }

  function template(name: "report" | "token" | "roadmap"): string {
    const file = join(webDir, "templates", `${name}.html`);
    try {
      return readFileSync(file, "utf8");
    } catch {
      return FALLBACK_TEMPLATE(name);
    }
  }
  function html(res: ServerResponse, status: number, body: string, ttl: number): void {
    send(res, status, body, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${ttl}` : "no-store",
    });
  }
  function shell(
    res: ServerResponse, name: "report" | "token" | "roadmap", status: number,
    values: { title: string; description: string; ogImage: string; url: string; json: unknown; content?: string }, ttl: number,
  ): void {
    const body = fillTemplate(template(name), {
      title: escapeHtml(values.title),
      description: escapeHtml(values.description),
      ogImage: escapeHtml(values.ogImage),
      url: escapeHtml(values.url),
      json: jsonForScript(values.json),
      ...(values.content !== undefined ? { content: values.content } : {}),
    });
    html(res, status, body, ttl);
  }

  const publicUrl = (path: string): string => `${CFG.publicUrl}${path}`;
  /**
   * The picture a link unfurls into. Live rather than a file on disk: it is the board with today's
   * numbers (src/ogcard.ts), so a link posted this afternoon carries what the chain did today.
   */
  const defaultOg = (): string => publicUrl("/og.png");
  const wantsJson = (req: IncomingMessage): boolean => /\bapplication\/json\b/.test(String(req.headers.accept ?? ""));

  // ---- static files

  function serveFile(req: IncomingMessage, res: ServerResponse, root: string, rel: string, ttl: number): boolean {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return false;
    }
    if (decoded.includes("\0") || decoded.split(/[\\/]/).some((seg) => seg === "..")) return false;
    const rootAbs = resolve(root);
    const file = resolve(rootAbs, decoded.replace(/^[\\/]+/, ""));
    if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": `public, max-age=${ttl}`,
      "last-modified": st.mtime.toUTCString(),
      etag,
    };
    const isHtml = headers["content-type"].startsWith("text/html");
    if (!isHtml && req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let body = readFileSync(file);
    if (headers["content-type"].startsWith("text/html")) {
      // The pages are written with the domain we mean to end up on, because a file opened straight
      // off disk has to have somewhere to point. On any other host — the machine before the domain
      // moves, a preview deployment — an unfurler would fetch the preview image from a name that is
      // not us and show nothing, which is exactly what happened the first time this went out.
      body = Buffer.from(String(body).replaceAll(CANONICAL_ORIGIN, CFG.publicUrl));
      headers.etag = `W/"${body.length.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}h"`;
      if (req.headers["if-none-match"] === headers.etag) { res.writeHead(304, headers); res.end(); return true; }
    }
    send(res, 200, body, headers);
    return true;
  }

  // ---- the board (SSE)

  type Client = { res: ServerResponse; ip: string };
  const clients = new Set<Client>();
  const clientsByIp = new Map<string, number>();
  let lastSeq = mock ? fixture<BoardReplay>("board-replay").seq : (db ? currentSeq(db) : 0);
  let mockLossAt = 0;

  const sseMessage = (id: number, event: string, data: unknown): string =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  function dropClient(c: Client): void {
    if (!clients.delete(c)) return;
    const n = (clientsByIp.get(c.ip) ?? 1) - 1;
    if (n > 0) clientsByIp.set(c.ip, n); else clientsByIp.delete(c.ip);
  }
  /** Writes to every open stream; one that has stopped reading (a stalled proxy, a sleeping tab) is cut off rather than buffered without end. */
  const broadcast = (msg: string): void => {
    for (const c of clients) {
      if (c.res.writableEnded || c.res.destroyed) { dropClient(c); continue; }
      if (c.res.writableLength > SSE_BACKLOG_BYTES) { dropClient(c); c.res.destroy(); continue; }
      c.res.write(msg);
    }
  };

  /** New rows since the global cursor, fanned out to every connection. */
  function pump(): void {
    if (!db || !clients.size) return;
    try {
      const rows = readEventRows(db, lastSeq);
      for (const r of rows) {
        lastSeq = r.seq;
        broadcast(sseMessage(r.seq, r.event.kind, r.event));
      }
    } catch (err) {
      console.error(`board: pump failed (${(err as Error).message})`);
    }
  }
  function countersEvent(): CountersEvent {
    if (mock) return { ...fixture<BoardReplay>("board-replay").counters, ts: now() };
    return boardCounters(db as DB, now(), turb);
  }
  function tickCounters(): void {
    if (!clients.size) return;
    refreshTurb();
    try {
      broadcast(sseMessage(lastSeq, "counters", countersEvent()));
    } catch (err) {
      console.error(`board: counters failed (${(err as Error).message})`);
    }
  }
  function tickMockLoss(): void {
    if (!mock || !clients.size) return;
    const losses = fixture<BoardReplay>("board-replay").losses;
    if (!losses.length) return;
    const loss: LossEvent = { ...losses[mockLossAt++ % losses.length], ts: now() };
    lastSeq++;
    broadcast(sseMessage(lastSeq, "loss", loss));
  }

  /**
   * The board every viewer gets, built once rather than once per viewer.
   *
   * Every visitor to the landing page opens this stream, and building the board is a second and a
   * half of synchronous work: the twelve flights, the tape, and the counters over a day of losses.
   * Done per connection that is a second and a half of the whole site stopped for each arrival,
   * which is worst exactly when the most people arrive. The board is the same for everybody, so it
   * is built on a short window and the difference is made up from the event log, which is indexed.
   */
  const REPLAY_MS = 2_000;
  let replayCache: { at: number; value: BoardReplay } | null = null;
  function buildReplay(): BoardReplay {
    pump();
    refreshTurb();
    const value = recentBoard(needDb(), turb);
    if (value.seq > lastSeq) lastSeq = value.seq;
    replayCache = { at: Date.now(), value };
    return value;
  }
  function currentReplay(): BoardReplay {
    if (replayCache) return replayCache.value; // kept fresh by the timer below, never built here
    return buildReplay();
  }

  function board(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): void {
    const sseHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    };
    // A HEAD is answered with the headers and takes no seat.
    if (req.method === "HEAD") { res.writeHead(200, sseHeaders); res.end(); return; }
    if (clients.size >= sseMax || (clientsByIp.get(ip) ?? 0) >= ssePerIp) {
      fail(res, 503, "board full", HINTS["board full"], { "retry-after": "60" });
      return;
    }
    const sinceRaw = url.searchParams.get("since") ?? String(req.headers["last-event-id"] ?? "");
    const since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;

    const replay = mock ? { ...fixture<BoardReplay>("board-replay"), seq: lastSeq } : currentReplay();

    res.writeHead(200, sseHeaders);
    res.write(`: rekt board\n${sseMessage(replay.seq, "replay", replay)}`);
    // Everything the new client has not seen: what happened since this replay was built, and
    // further back when it is resuming. Reading events by sequence is an indexed lookup, so the
    // catch-up costs nothing next to building the board itself.
    const from = since !== null && since < replay.seq ? since : replay.seq;
    if (db && from < lastSeq) {
      for (const r of readEventRows(db, from)) {
        if (r.seq <= lastSeq) res.write(sseMessage(r.seq, r.event.kind, r.event));
      }
    }
    const client: Client = { res, ip };
    clients.add(client);
    clientsByIp.set(ip, (clientsByIp.get(ip) ?? 0) + 1);
    const drop = (): void => dropClient(client);
    res.on("close", drop);
    res.on("error", drop);
  }

  // ---- the social card

  /**
   * The link preview, rendered from the board and cached for five minutes in memory. One image
   * serves every link to the site, and an unfurler fetches it once per link, so this must never
   * cost a render per request; five minutes is fresh enough that the numbers still read as live.
   */
  let og: { at: number; png: Uint8Array } | null = null;
  const OG_TTL_MS = 300_000;

  /** `res` null warms the cache without answering anybody. */
  async function ogCard(res: ServerResponse | null): Promise<void> {
    if (!og || Date.now() - og.at > OG_TTL_MS) {
      const replay = mock
        ? fixture<BoardReplay>("board-replay")
        : recentBoard(needDb(), turb);
      const host = CFG.publicUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const input = { rows: replay.rows, counters: replay.counters, ca: replay.ca, host };
      // On the printer, never here: rendering is seconds of synchronous CPU, and at boot beside
      // the scanning workers it was forty. A printer that died is respawned and asked once more.
      const print = async () => (await press.run({ kind: "og", input })).png as Uint8Array;
      let png: Uint8Array;
      try { png = await print(); } catch (err) {
        console.error(`api: link preview failed on the printer (${(err as Error).message}); retrying`);
        png = await print();
      }
      og = { at: Date.now(), png };
    }
    if (!res) return;
    send(res, 200, Buffer.from(og.png), {
      "content-type": "image/png",
      "cache-control": `public, max-age=${Math.floor(OG_TTL_MS / 1000)}`,
    });
  }

  // ---- the card

  /**
   * The disk is the only cache: one file per address, fresh for TTL.card by its mtime, pruned by
   * timer. A miss renders on the printer thread, one pass at a time, the same address once, and
   * a queue past `cardQueue` answers 503 busy rather than piling seconds of work on the process.
   */
  const printing = new Map<string, Promise<Uint8Array>>();

  function cachedCard(file: string): Uint8Array | null {
    try {
      const st = statSync(file);
      if (Date.now() - st.mtimeMs < TTL.card * 1000) return readFileSync(file);
    } catch {
      // no file yet
    }
    return null;
  }

  function print(address: string, r: Report): Promise<Uint8Array> {
    let p = printing.get(address);
    if (p) return p;
    if (printing.size >= cardQueue) throw new Busy();
    p = press.run({ report: r }).then((reply) => reply.png as Uint8Array).finally(() => printing.delete(address));
    printing.set(address, p);
    return p;
  }

  function pruneCards(): void {
    let names: string[];
    try {
      names = readdirSync(cardsDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TTL.card * 1000;
    for (const name of names) {
      if (!name.endsWith(".png")) continue;
      const file = join(cardsDir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      } catch {
        // gone already, or not ours to remove
      }
    }
  }

  async function card(req: IncomingMessage, res: ServerResponse, address: string, url: URL): Promise<void> {
    const file = join(cardsDir, `${address}.png`);
    const headers: Record<string, string> = { "content-type": "image/png", "cache-control": `public, max-age=${TTL.card}` };
    if (url.searchParams.get("download") === "1") {
      // Header values are ASCII: the plain filename spells the ellipsis out, filename* carries the real one.
      const name = `rekt-boarding-pass-${short(address)}.png`;
      headers["content-disposition"] = `attachment; filename="${name.replace("\u2026", "...")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    let png = cachedCard(file);
    const hit = png !== null;
    if (!png) {
      const { value: r } = await report(address);
      if (!r) throw new NotFound("no flights", await emptyHint(address));
      png = await print(address, r);
      try {
        mkdirSync(cardsDir, { recursive: true });
        writeFileSync(file, png);
      } catch (err) {
        console.error(`card: not cached (${(err as Error).message})`);
      }
    }
    send(res, 200, png, { ...headers, "x-cache": hit ? "hit" : "miss" });
  }

  // ---- routing

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (path === "/api/health") {
      json(res, health(), 200, { "cache-control": "no-store" });
      return;
    }
    if ((m = /^\/static\/(.+)$/.exec(path))) {
      if (!serveFile(req, res, join(webDir, "static"), m[1], staticTtl)) throw new NotFound("not found", HINTS["not found"]);
      return;
    }
    if ((m = /^\/mock\/(.+)$/.exec(path))) {
      if (!serveFile(req, res, join(webDir, "mock"), m[1], TTL.page)) throw new NotFound("not found", HINTS["not found"]);
      return;
    }
    if (path in PAGES) {
      if (!serveFile(req, res, webDir, PAGES[path], TTL.page)) throw new NotFound("not found", HINTS["not found"]);
      return;
    }
    // The same pages by file name (/desk.html, /leaderboards.html): what the front end links to on
    // a plain file server, kept working here so a pasted link never 404s. Templates stay unrouted.
    if ((m = /^\/([a-z][a-z0-9-]*)\.html$/.exec(path)) && m[1] !== "index" && Object.values(PAGES).includes(`${m[1]}.html`)) {
      if (!serveFile(req, res, webDir, `${m[1]}.html`, TTL.page)) throw new NotFound("not found", HINTS["not found"]);
      return;
    }

    if (path === "/og.png") {
      await ogCard(res);
      return;
    }
    if (path === "/api/board") {
      board(req, res, url, ip);
      return;
    }
    if ((m = /^\/api\/report\/([^/]+)$/.exec(path))) {
      const address = parseAddress(m[1]);
      const { value, hit } = await report(address);
      if (!value) throw new NotFound("no flights", await emptyHint(address));
      json(res, value, 200, cacheHeaders(TTL.report, hit));
      return;
    }
    if ((m = /^\/card\/([^/]+)\.png$/.exec(path))) {
      await card(req, res, parseAddress(m[1]), url);
      return;
    }
    if (path === "/api/index") {
      const { value, hit } = await index();
      json(res, value, 200, cacheHeaders(TTL.index, hit));
      return;
    }
    if (path === "/api/leaderboard/rekt") {
      const w = url.searchParams.get("window") ?? "24h";
      if (w !== "24h" && w !== "all") { fail(res, 400, "bad window", HINTS["bad window"]); return; }
      const { value, hit } = await hall(w);
      json(res, value, 200, cacheHeaders(TTL.leaderboard, hit));
      return;
    }
    if (path === "/api/leaderboard/airlines") {
      const { value, hit } = await airlinesRows();
      json(res, value, 200, cacheHeaders(TTL.leaderboard, hit));
      return;
    }
    if ((m = /^\/api\/token\/([^/]+)$/.exec(path))) {
      const addr = parseAddress(m[1]);
      const { value, hit } = await token(addr);
      if (!value) throw new NotFound("unknown token", HINTS["unknown token"]);
      json(res, value, 200, cacheHeaders(TTL.token, hit));
      return;
    }
    if (path === "/api/desk") {
      const { value, hit } = await desk();
      json(res, value, 200, cacheHeaders(TTL.desk, hit));
      return;
    }

    if ((m = /^\/r\/([^/]+)$/.exec(path))) {
      const address = parseAddress(m[1]);
      const { value: r } = await report(address);
      if (!r) {
        const hint = await emptyHint(address);
        if (wantsJson(req)) throw new NotFound("no flights", hint);
        const err: ApiError = { error: "no flights", hint };
        shell(res, "report", 404, {
          title: `${short(address)} · No flights · REKT`, description: err.hint,
          ogImage: defaultOg(), url: publicUrl(`/r/${address}`), json: err,
        }, TTL.report);
        return;
      }
      shell(res, "report", 200, {
        title: `${short(r.address)} · Boarding pass · REKT`,
        description: describeReport(r),
        ogImage: publicUrl(`/card/${r.address}.png`),
        url: publicUrl(`/r/${r.address}`),
        json: r,
      }, TTL.report);
      return;
    }
    if ((m = /^\/t\/([^/]+)$/.exec(path))) {
      const addr = parseAddress(m[1]);
      const { value: t } = await token(addr);
      if (!t) {
        if (wantsJson(req)) throw new NotFound("unknown token", HINTS["unknown token"]);
        const err: ApiError = { error: "unknown token", hint: HINTS["unknown token"] };
        shell(res, "token", 404, {
          title: `${short(addr)} · No such flight · REKT`, description: err.hint,
          ogImage: defaultOg(), url: publicUrl(`/t/${addr}`), json: err,
        }, TTL.token);
        return;
      }
      shell(res, "token", 200, {
        title: `${t.symbol} · Lost and found · REKT`,
        description: describeToken(t),
        ogImage: defaultOg(),
        url: publicUrl(`/t/${t.token}`),
        json: t,
      }, TTL.token);
      return;
    }
    if (path === "/roadmap") {
      shell(res, "roadmap", 200, {
        title: "Roadmap · REKT",
        description: "What comes after day one, in the order it gets built. A status changes here only when the file changes.",
        ogImage: defaultOg(),
        url: publicUrl("/roadmap"),
        json: { items: roadmapItems },
        content: roadmapHtml,
      }, TTL.page);
      return;
    }
    throw new NotFound("not found", HINTS["not found"]);
  }

  class BadAddress extends Error {}
  function parseAddress(raw: string): string {
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      throw new BadAddress();
    }
    if (!ADDRESS_RE.test(s)) throw new BadAddress();
    return s.toLowerCase();
  }

  function clientIp(req: IncomingMessage): string {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff ?? "").split(",")[0].trim();
    return first || req.socket.remoteAddress || "unknown";
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://rekt.local");
    const ip = clientIp(req);
    const done = (): void => {
      if (log) console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms ${ip}`);
      stats?.record(url.pathname, res.statusCode, ip, String(req.headers["user-agent"] ?? ""));
    };
    let counted = false;
    const once = (): void => { if (!counted) { counted = true; done(); } };
    res.once("finish", once);
    res.once("close", once);

    const exempt = url.pathname === "/api/health" || url.pathname.startsWith("/static/");
    if (!exempt) {
      const { remaining, retryAfter } = limiter.take(ip);
      res.setHeader("x-ratelimit-limit", String(limiter.limit));
      res.setHeader("x-ratelimit-remaining", String(Math.max(0, remaining)));
      if (remaining < 0) {
        fail(res, 429, "rate limited", HINTS["rate limited"](retryAfter), { "retry-after": String(retryAfter) });
        return;
      }
    } else {
      res.setHeader("x-ratelimit-limit", String(limiter.limit));
      res.setHeader("x-ratelimit-remaining", String(limiter.limit));
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      fail(res, 405, "method not allowed", HINTS["method not allowed"], { allow: "GET, HEAD" });
      return;
    }

    try {
      await route(req, res, url, ip);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof BadAddress) fail(res, 400, "bad address", HINTS["bad address"]);
      else if (err instanceof NotFound) fail(res, 404, err.code, err.hint);
      else if (err instanceof Busy) fail(res, 503, "busy", HINTS["busy"], { "retry-after": "5" });
      else if (err instanceof NotReady || isStub(err)) fail(res, 503, "not ready", HINTS["not ready"], { "retry-after": "30" });
      else {
        console.error(`api: ${req.method} ${url.pathname} failed:`, err);
        fail(res, 500, "internal", HINTS["internal"]);
      }
    }
  }

  boot("routes ready");
  const server = createServer((req, res) => {
    const label = `${req.method} ${(req.url ?? "").slice(0, 80)}`;
    started(label);
    res.on("close", () => { if (inFlight === label) inFlight = ""; });
    void handle(req, res).catch((err) => {
      console.error(`api: unhandled while serving ${req.method} ${req.url}:`, err);
      if (!res.headersSent) fail(res, 500, "internal", HINTS["internal"]);
      else res.end();
    });
  });
  server.keepAliveTimeout = 65_000;

  // ---- background work

  /**
   * Say when this thread stopped serving, because nothing else will.
   *
   * Every heavy read is supposed to be on a worker, and a page that hangs looks identical to a
   * network problem, a proxy problem or a slow visitor. A timer that notices it was late is the
   * cheapest possible witness: if this prints, something synchronous ran here that should not
   * have, and the length tells you what to look for.
   */
  boot("timers next");
  const BEAT_MS = 250;
  let beat = Date.now();
  timers.push(setInterval(() => {
    const late = Date.now() - beat - BEAT_MS;
    beat = Date.now();
    // Naming what was in flight is the whole point: "blocked for forty seconds" sends you
    // bisecting, "blocked for forty seconds during GET /r/0x…" sends you to the line.
    if (late > 1_000) console.error(`api: the event loop was blocked for ${(late / 1000).toFixed(1)}s; last started: ${lastStarted || "nothing yet"}`);
  }, BEAT_MS));

  /**
   * Runs a background job under a name, so a block it causes is reported with that name rather
   * than as "no request". Everything on this thread is either a request or one of these.
   */

  // The board costs well over a second to assemble and is the same for everybody, so it is built
  // here and never while somebody is waiting for it.
  if (!mock) every(REPLAY_MS, "board rebuild", buildReplay);

  every(500, "pump", pump);
  every(5_000, "counters", tickCounters);
  every(15_000, "ping", () => broadcast(": ping\n\n"));
  every(CARD_PRUNE_MS, "prune cards", pruneCards);
  every(600_000, "prune cache", () => memo.prune());
  if (mock) timers.push(setInterval(tickMockLoss, 6_000));

  // The rank snapshot is computed on the query worker and installed here; a report waits for the
  // first one (rankReady) rather than building its own on the request path.
  let rankReady: Promise<void> = Promise.resolve();
  if (db) {
    /**
     * The rank table is computed on the scanning worker, kept in the database, and loaded by the
     * report worker, which is the only thing that reads it. Nothing of it crosses to this thread.
     *
     * Loading is seconds; computing is most of two minutes. A fresh process loads what the last
     * one wrote and answers reports at once, then recomputes in the background and reloads. It
     * used to compute first and answer reports after, so for the first minutes of every process
     * the one thing the site is for did not work, and the launch begins with a restart.
     */
    const loadRanks = async (): Promise<void> => {
      if (!reports) return;
      try {
        const t0 = Date.now();
        const r = (await reports.run({ kind: "ranks" })).value as { wallets: number; source: string };
        console.log(`api: rank snapshot ${r.wallets} wallets, ${r.source} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        if (!isStub(err)) console.error(`api: rank snapshot failed (${(err as Error).message})`);
      }
    };
    const rewriteRanks = async (): Promise<void> => {
      if (!queries) return;
      try {
        const t0 = Date.now();
        const r = (await queries.run({ kind: "ranks-write" })).value as { wallets: number };
        console.log(`api: rank table rewritten, ${r.wallets} wallets, ${((Date.now() - t0) / 1000).toFixed(1)}s on the scanning worker`);
        await loadRanks();
      } catch (err) {
        if (!isStub(err)) console.error(`api: rank table rewrite failed (${(err as Error).message})`);
      }
    };
    if (ready()) rankReady = loadRanks();
    // Refresh soon after boot, because the table may be as old as the last process, then hourly.
    later(120_000, "rank rewrite", () => { void rewriteRanks(); });
    timers.push(setInterval(() => { void rewriteRanks(); }, 3_600_000));

    const escrow = (): void => {
      const { recipient } = deskRecipient();
      if (!recipient || !CFG.rektToken) return;
      indexEscrowSince(db, recipient)
        .then((r) => { if (r) console.log(`desk: escrow ${r.from}..${r.to}, ${r.credited} credits, ${r.claimed} claims`); })
        .catch((err) => console.error(`desk: escrow read failed (${(err as Error).message})`));
    };
    later(10_000, "escrow", escrow);
    timers.push(setInterval(escrow, 3_600_000));

    /**
     * Fill the leaderboards before anybody asks for them.
     *
     * Stale answers cover every case except the first one after a restart, when there is nothing
     * stale to serve and the visitor waits out the whole scan. A deploy is exactly when people are
     * most likely to be looking, so the scans run on their own a few seconds after boot, one after
     * another because they share a single query worker anyway. Failures are logged and dropped: a
     * cold leaderboard is a slow page, not a broken server.
     */
    const SLOW = [
      { key: "hall:24h", ttl: LEADERBOARD_TTL.hall24h, what: "hall 24h", go: () => computeHall("24h") },
      { key: "airlines", ttl: LEADERBOARD_TTL.airlines, what: "airlines", go: computeAirlines },
      { key: "hall:all", ttl: LEADERBOARD_TTL.hallAll, what: "hall all-time", go: () => computeHall("all") },
    ];

    /**
     * Read back what the last process computed, then recompute in the background.
     *
     * Without this every restart starts from nothing, and for the minutes the scans take there is
     * no stale answer to serve and the tables are blank. A deploy is when people are most likely to
     * be looking, and the launch is one restart on purpose, so the last good answer survives on
     * disk and the pages are full from the first request. It is only a cache: if the row is missing
     * or unreadable the only cost is one slow warm-up.
     */
    for (const { key, ttl } of SLOW) {
      memo.pin(key);
      try {
        const row = db.prepare("SELECT at, json FROM slow_answers WHERE key = ?").get(key) as { at: number; json: string } | undefined;
        if (row) memo.seed(key, ttl, JSON.parse(row.json), row.at);
      } catch (err) {
        console.error(`api: could not read back ${key} (${(err as Error).message})`);
      }
    }

    const warm = async (): Promise<void> => {
      const put = db.prepare("INSERT INTO slow_answers (key, at, json) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, json = excluded.json");
      for (const { key, ttl, what, go } of SLOW) {
        const t = Date.now();
        try {
          const value = await memo.refresh(key, ttl, go);
          put.run(key, Date.now(), JSON.stringify(value));
          console.log(`api: ${what} ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        } catch (err) {
          if (!isStub(err)) console.error(`api: ${what} could not be warmed (${(err as Error).message})`);
        }
      }
    };
    if (ready()) {
      later(3_000, "warm-up", () => { void warm(); });
      // Keep the saved copy roughly as fresh as the memory one, so a restart is never far behind.
      timers.push(setInterval(() => { void warm(); }, LEADERBOARD_TTL.hallAll * 1000));
    }
  }
  for (const t of timers) t.unref?.();

  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const port = opts.port ?? CFG.port;
  return new Promise<Api>((resolveApi, reject) => {
    server.once("error", reject);
    boot("listening next");
    server.listen(port, host, () => {
      boot("listening");
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      resolveApi({
        server,
        port: bound,
        close: () => new Promise<void>((done) => {
          for (const t of timers) clearInterval(t);
          stats?.flush();
          for (const c of clients) c.res.end();
          clients.clear();
          clientsByIp.clear();
          server.closeAllConnections?.();
          server.close(() => {
            Promise.all([press.close(), queries?.close(), reports?.close()]).finally(() => { db?.close(); done(); });
          });
        }),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const mock = process.env.MOCK === "1";
  createApi({ mock }).then((api) => {
    console.log(`rekt-api listening on ${process.env.HOST ?? "127.0.0.1"}:${api.port}${mock ? " (MOCK=1, fixtures from web/mock)" : ""}, public ${CFG.publicUrl}`);
    /**
     * Shutting down is on a deadline, because a restart is a hole in the site.
     *
     * The tidy close ends the streams, drops the connections and shuts the query workers down, and
     * usually takes milliseconds. But `worker.terminate()` cannot interrupt a worker that is inside
     * a synchronous SQLite call, so one heavy leaderboard query in flight holds the whole shutdown
     * until it finishes. systemd then waits out TimeoutStopSec and sends SIGKILL, and for those
     * seconds the site is a proxy pointing at a process that is going away. Exiting on our own
     * after a short grace is strictly better: same outcome, a fraction of the downtime, and the
     * next process is already listening while the old one would still have been dying.
     */
    const GRACE_MS = 3_000;
    let stopping = false;
    const stop = (): void => {
      if (stopping) process.exit(0); // a second signal means now, not soon
      stopping = true;
      const hard = setTimeout(() => process.exit(0), GRACE_MS);
      hard.unref();
      api.close().then(() => process.exit(0)).catch(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch((err) => {
    console.error(`rekt-api failed to start: ${(err as Error).message}`);
    process.exit(1);
  });
}
