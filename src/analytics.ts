import { createHash, randomBytes } from "node:crypto";
import { getMeta, setMeta, type DB } from "./db.ts";

/**
 * How many people came and what they used, kept in the same database and nowhere else.
 *
 * No third party, no cookie, no address stored: a visitor is a hash of the day's random salt, the
 * IP and the user agent, so the rows say "someone" and can never say who, and yesterday's salt
 * cannot be used to recognise the same person today. What is counted is which page or route was
 * asked for, with the moving parts of the path removed, so `/r/0x3f9a…` counts as `report`.
 *
 * Written in batches on a timer rather than per request: a counter that costs a disk write per hit
 * would be the slowest thing on the site.
 */

/** One row per day per counter. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS hits (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (day, key)
) STRICT;

-- One row per visitor per day; the hash is salted per day and the salt is not kept afterwards.
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,
  who TEXT NOT NULL,
  PRIMARY KEY (day, who)
) STRICT;

-- Which wallets people looked up, for "how many different passengers were checked". Public data.
CREATE TABLE IF NOT EXISTS lookups (
  day     TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (day, address)
) STRICT;
`;

/** Anything that reads like a crawler rather than a person; counted separately, never as a visitor. */
const BOT = /bot|crawler|spider|scan|curl|wget|python|go-http|okhttp|headless|monitor|uptime|probe|libwww|httpclient|slurp|facebookexternalhit|embedly|preview/i;

export const today = (ts: number = Date.now()): string => new Date(ts).toISOString().slice(0, 10);

/**
 * The counter a path belongs to, with addresses and token ids removed so the key set stays small
 * and readable. Null for anything not worth counting: static files, fixtures, health checks.
 */
export function keyFor(path: string): string | null {
  if (path.startsWith("/static/") || path.startsWith("/mock/") || path === "/favicon.ico") return null;
  if (path === "/api/health") return null;
  if (path === "/") return "landing";
  if (/^\/r\/0x[0-9a-fA-F]{40}$/.test(path)) return "report";
  if (/^\/api\/report\//.test(path)) return "report:api";
  if (/^\/card\/0x[0-9a-fA-F]{40}\.png$/.test(path)) return "pass";
  if (/^\/t\/0x[0-9a-fA-F]{40}$/.test(path)) return "token";
  if (/^\/api\/token\//.test(path)) return "token:api";
  if (path === "/api/board") return "board";
  if (path === "/api/index" || path === "/turbulence") return "turbulence";
  if (path.startsWith("/api/leaderboard/rekt")) return "hall";
  if (path.startsWith("/api/leaderboard/airlines")) return "airlines";
  if (path === "/hall" || path === "/hall.html") return "hall";
  if (path === "/airlines" || path === "/airlines.html") return "airlines";
  if (path === "/leaderboards" || path === "/leaderboards.html") return "leaderboards";
  if (path === "/desk" || path === "/desk.html" || path === "/api/desk") return "desk";
  if (path === "/roadmap") return "roadmap";
  if (path === "/about" || path === "/about.html") return "about";
  return "other";
}

/** The address a report or pass was asked for, or null. */
export function addressIn(path: string): string | null {
  const m = /0x[0-9a-fA-F]{40}/.exec(path);
  return m && (path.startsWith("/r/") || path.startsWith("/api/report/") || path.startsWith("/card/"))
    ? m[0].toLowerCase()
    : null;
}

/**
 * The day's salt, made once and kept in meta so every process agrees within the day. Yesterday's
 * salts are dropped, which is what stops a hash from following anybody from one day to the next.
 */
function saltFor(db: DB, day: string): string {
  const key = `analytics_salt_${day}`;
  let salt = getMeta(db, key);
  if (!salt) {
    salt = randomBytes(16).toString("hex");
    setMeta(db, key, salt);
    for (const r of db.prepare("SELECT key FROM meta WHERE key LIKE 'analytics_salt_%' AND key != ?").all(key) as Array<{ key: string }>) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(r.key);
    }
  }
  return salt;
}

export type Counts = { hits: Map<string, number>; visitors: Set<string>; lookups: Set<string> };

/**
 * Counts held in memory between flushes. One instance per API process; `record` is called on every
 * finished request and must stay cheap, so it only hashes and adds to a set.
 */
export class Analytics {
  private db: DB;
  private day = today();
  private salt: string;
  private pending: Counts = { hits: new Map(), visitors: new Set(), lookups: new Set() };

  constructor(db: DB) {
    this.db = db;
    db.exec(SCHEMA);
    this.salt = saltFor(db, this.day);
  }

  /** A finished request. `status` decides whether it counts: a 404 or a rate-limited hit does not. */
  record(path: string, status: number, ip: string, userAgent: string): void {
    const day = today();
    if (day !== this.day) { this.flush(); this.day = day; this.salt = saltFor(this.db, day); }

    const bot = BOT.test(userAgent) || !userAgent;
    const key = keyFor(path);
    if (!key) return;
    if (status >= 400) { this.bump(bot ? "bot:error" : "error"); return; }
    if (bot) { this.bump("bot"); return; }

    this.bump(key);
    this.pending.visitors.add(createHash("sha256").update(`${this.salt}|${ip}|${userAgent}`).digest("hex").slice(0, 16));
    const addr = addressIn(path);
    if (addr) this.pending.lookups.add(addr);
  }

  private bump(key: string): void {
    this.pending.hits.set(key, (this.pending.hits.get(key) ?? 0) + 1);
  }

  /** Writes what has piled up. Safe to call at any time; nothing is lost if it is called often. */
  flush(): void {
    const { hits, visitors, lookups } = this.pending;
    if (!hits.size && !visitors.size && !lookups.size) return;
    this.pending = { hits: new Map(), visitors: new Set(), lookups: new Set() };
    const day = this.day;
    const hit = this.db.prepare(`INSERT INTO hits (day, key, n) VALUES (?,?,?)
      ON CONFLICT(day, key) DO UPDATE SET n = hits.n + excluded.n`);
    const vis = this.db.prepare("INSERT INTO visits (day, who) VALUES (?,?) ON CONFLICT DO NOTHING");
    const look = this.db.prepare("INSERT INTO lookups (day, address) VALUES (?,?) ON CONFLICT DO NOTHING");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, n] of hits) hit.run(day, key, n);
      for (const who of visitors) vis.run(day, who);
      for (const a of lookups) look.run(day, a);
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
    }
  }
}

export type DayRow = { day: string; visitors: number; wallets: number; hits: Record<string, number> };

/** The last `days` days, newest first: unique visitors, wallets looked up, and every counter. */
export function summary(db: DB, days = 14): DayRow[] {
  db.exec(SCHEMA);
  const out: DayRow[] = [];
  const rows = db.prepare("SELECT DISTINCT day FROM hits ORDER BY day DESC LIMIT ?").all(days) as Array<{ day: string }>;
  for (const { day } of rows) {
    const v = db.prepare("SELECT COUNT(*) n FROM visits WHERE day = ?").get(day) as { n: number };
    const w = db.prepare("SELECT COUNT(*) n FROM lookups WHERE day = ?").get(day) as { n: number };
    const hits: Record<string, number> = {};
    for (const r of db.prepare("SELECT key, n FROM hits WHERE day = ? ORDER BY n DESC").all(day) as Array<{ key: string; n: number }>) {
      hits[r.key] = r.n;
    }
    out.push({ day, visitors: Number(v.n), wallets: Number(w.n), hits });
  }
  return out;
}
