import { openDb } from "../db.ts";
import { readTokenIdentity } from "../enrich.ts";

/**
 * rekt names [--limit N] [--workers N]
 *
 * Fills in name and symbol for launches that never declared one. About half of launches do not go
 * through the Pons router, so the calldata has no name; the token contract knows its own regardless.
 * Newest first, because a blank at the top of the board matters more than one in history.
 */
const argv = process.argv.slice(2);
const arg = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};

const limit = arg("limit", 100_000);
const workers = arg("workers", 8);

const db = openDb();

const pending = db.prepare(`
  SELECT token FROM launches WHERE symbol IS NULL ORDER BY ts DESC LIMIT ?`).all(limit) as Array<{ token: string }>;
const total = (db.prepare("SELECT count(*) c FROM launches WHERE symbol IS NULL").get() as { c: number }).c;

console.log(`${total} launches have no symbol; resolving ${pending.length}, newest first, ${workers} workers\n`);

const save = db.prepare("UPDATE launches SET name = coalesce(?, name), symbol = ? WHERE token = ?");

const queue = [...pending];
let done = 0;
let named = 0;
let last = 0;
const started = Date.now();

await Promise.all(Array.from({ length: workers }, async () => {
  for (;;) {
    const row = queue.shift();
    if (!row) return;
    try {
      const id = await readTokenIdentity(row.token);
      if (id.symbol !== undefined) {
        save.run(id.name ?? null, id.symbol, row.token);
        named++;
      }
    } catch { /* a token that will not answer keeps its blank; a later pass retries it */ }
    done++;
    if (Date.now() - last > 3000) {
      last = Date.now();
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${done}/${pending.length}  ${rate.toFixed(1)}/s  named ${named}  eta ${((pending.length - done) / Math.max(rate, 0.1) / 60).toFixed(1)}min   `);
    }
  }
}));

console.log(`\n\nresolved ${named} of ${done} in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
db.close();
