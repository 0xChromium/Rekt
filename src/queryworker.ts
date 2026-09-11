import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { now } from "./db.ts";
import { airlines, hallOfRekt } from "./leaderboards.ts";
import { buildReport, computeRanks, installRankSnapshot, loadRanks, writeRanks } from "./report.ts";
import { turbulence } from "./turbulence.ts";
import type { HallWindow } from "./types.ts";

/**
 * The API's heavy work, off its event loop.
 *
 * node:sqlite is synchronous, so anything that scans millions of positions on the serving thread
 * is the whole site stopped for the length of it. This thread runs those jobs on its own
 * read-only connection and posts the result back; api.ts memoises the answers as before.
 *
 * api.ts runs two of these. One takes the scans that feed the leaderboards and the turbulence
 * gauge, which can hold it for minutes at a time. The other builds wallet reports, which are
 * milliseconds for a person and seconds for a router with a hundred thousand positions, and
 * must not queue behind a scan. The report worker also owns the rank table: a report is the
 * only thing that reads it, so it is computed here and never crosses a thread boundary.
 * `ranks` asks for it to be built ahead of time; a report that arrives before that builds it
 * itself, which is slow once rather than wrong.
 */

export type QueryJob =
  | { id: number; kind: "ranks" }
  | { id: number; kind: "ranks-write" }
  | { id: number; kind: "report"; address: string }
  | { id: number; kind: "hall"; window: HallWindow; limit: number }
  | { id: number; kind: "airlines"; limit: number }
  | { id: number; kind: "turbulence"; nowTs?: number };
export type QueryReply = { id: number; value?: unknown; error?: string };

const port = parentPort;
if (!port) throw new Error("queryworker runs as a worker thread");

const dbPath = String((workerData as { dbPath: string }).dbPath);
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");

/** A writable connection, opened only by the lane that writes the rank table, and only once. */
let writer: DatabaseSync | null = null;
function writable(): DatabaseSync {
  if (!writer) {
    writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA busy_timeout = 30000"); // a background job waits its turn; see db.ts
  }
  return writer;
}

/**
 * The rank table for this worker's reports: the one on disk when there is one, which takes a
 * couple of seconds, else computed here, which takes most of two minutes and happens only on a
 * database no writer has visited yet.
 */
function ranksReady(): { wallets: number; source: "table" | "computed" } {
  const stored = loadRanks(db);
  if (stored) {
    installRankSnapshot(db, stored.table, stored.builtAt);
    return { wallets: stored.table.wallets, source: "table" };
  }
  return { wallets: installRankSnapshot(db, computeRanks(db)).wallets, source: "computed" };
}

function run(job: QueryJob): unknown {
  switch (job.kind) {
    case "ranks": return ranksReady();
    case "ranks-write": { const t = computeRanks(db); writeRanks(writable(), t); return { wallets: t.wallets }; }
    case "report": return buildReport(db, job.address);
    case "hall": return hallOfRekt(db, job.window, job.limit);
    case "airlines": return airlines(db, job.limit);
    case "turbulence": return turbulence(db, job.nowTs ?? now());
  }
}

// A report awaits the chain for the bags it values, so replies can come back out of order;
// they are matched by id on the other side. The synchronous parts still run one at a time.
port.on("message", (job: QueryJob) => {
  Promise.resolve().then(() => run(job)).then(
    (value) => port.postMessage({ id: job.id, value } satisfies QueryReply),
    (err) => port.postMessage({ id: job.id, error: String((err as Error)?.message ?? err) } satisfies QueryReply),
  );
});
