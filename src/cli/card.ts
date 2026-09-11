import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCard, shortAddress } from "../card.ts";
import type { Report } from "../types.ts";

/**
 * Renders one boarding pass to disk, for looking at the layout.
 *   npm run card                 web/mock/report.json  → out/card-sample.png
 *   npm run card -- 0xabc…       report.buildReport on data/rekt.db → out/card-<short>.png
 *   npm run card -- --out p.png  a different output path (either mode)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outArg = outIdx >= 0 ? args[outIdx + 1] : null;
const address = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase() ?? null;

let report: Report | null;
let out: string;
if (address) {
  const { openDb } = await import("../db.ts");
  const { buildReport } = await import("../report.ts");
  const db = openDb();
  try {
    report = await buildReport(db, address);
  } finally {
    db.close();
  }
  if (!report) {
    console.error(`${shortAddress(address)}: no flights on record`);
    process.exit(1);
  }
  out = outArg ?? join(ROOT, "out", `card-${shortAddress(address)}.png`);
} else {
  report = JSON.parse(readFileSync(join(ROOT, "web", "mock", "report.json"), "utf8")) as Report;
  out = outArg ?? join(ROOT, "out", "card-sample.png");
}

const t0 = performance.now();
const png = await renderCard(report);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`${out}: ${(png.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)} ms`);
