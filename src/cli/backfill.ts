import { BLOCKS_PER_DAY } from "../chain/config.ts";
import { logsClient, withRetry } from "../chain/chain.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { enrichPending, pendingEnrichment } from "../enrich.ts";
import { backfillRange } from "../ingest.ts";
import { backfillQuoteAssets } from "../quote.ts";

/**
 * rekt backfill [--hours N | --blocks N | --from BLOCK] [--to BLOCK] [--no-enrich] [--workers N]
 *
 * Launches, graduations and fee recipient changes for a window, then the launch transactions of
 * every launch that has not been enriched yet (sender, name, symbol, fee recipient, exemptions).
 * Enrichment is batched and resumable: rerun with the same window and it continues.
 */
const argv = process.argv.slice(2);
const arg = (name: string): number | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};

const latest = Number(await withRetry(() => logsClient.getBlockNumber()));
const hours = arg("hours");
const blocks = arg("blocks");
const from = arg("from") ?? latest - (blocks ?? Math.round((hours ?? 24) * (BLOCKS_PER_DAY / 24)));
const to = arg("to") ?? latest;
const workers = arg("workers") ?? 4;

console.log(`backfill  blocks ${from.toLocaleString()}..${to.toLocaleString()}  (${(to - from).toLocaleString()} blocks, ~${((to - from) / BLOCKS_PER_DAY * 24).toFixed(1)}h)`);

const db = openDb();
const started = Date.now();
let lastLog = 0;

const totals = await backfillRange(db, from, to, (done, total, c) => {
  const t = Date.now();
  if (t - lastLog < 2000) return;
  lastLog = t;
  const pct = ((done / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${pct.padStart(5)}%  launched=${c.launched} graduated=${c.graduated} recipient changes=${c.feeChanged}   `);
});

// The window covered, widened rather than replaced, so a second run for an earlier hour extends it.
const prevFrom = Number(getMeta(db, "backfill_from_block") ?? NaN);
const prevTo = Number(getMeta(db, "backfill_to_block") ?? NaN);
setMeta(db, "backfill_from_block", String(Number.isFinite(prevFrom) ? Math.min(prevFrom, from) : from));
setMeta(db, "backfill_to_block", String(Number.isFinite(prevTo) ? Math.max(prevTo, to) : to));

console.log(`\n\nlaunches read in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  launched           ${totals.launched}`);
console.log(`  graduated          ${totals.graduated}`);
console.log(`  recipient changes  ${totals.feeChanged}`);

const quotes = await backfillQuoteAssets(db);
if (quotes) console.log(`  quote assets resolved: ${quotes}`);

if (!argv.includes("--no-enrich")) {
  const pending = pendingEnrichment(db);
  console.log(`\nenriching ${pending} launches, ${workers} workers`);
  const t0 = Date.now();
  let total = 0;
  let okTotal = 0;
  let last = 0;
  // Batches of 500, newest first. Each saved row is a checkpoint; a failed row stays pending.
  for (;;) {
    const { done, ok } = await enrichPending(db, 500, workers, (n) => {
      if (Date.now() - last < 3000) return;
      last = Date.now();
      const sofar = total + n;
      const rate = sofar / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${sofar}/${pending}  ${rate.toFixed(1)}/s  eta ${((pending - sofar) / Math.max(rate, 0.1) / 60).toFixed(1)}min   `);
    });
    total += done;
    okTotal += ok;
    if (done === 0 || ok === 0) break;
  }
  console.log(`\r  enriched ${okTotal} of ${total} in ${((Date.now() - t0) / 60000).toFixed(1)} min` +
    (okTotal < total ? `; ${total - okTotal} failed, rerun to retry` : ""));
}

const named = (db.prepare("SELECT count(*) c FROM launches WHERE symbol IS NOT NULL").get() as { c: number }).c;
const all = (db.prepare("SELECT count(*) c FROM launches").get() as { c: number }).c;
console.log(`\n${all} launches in the database, ${named} with a symbol`);
db.close();
