import { openDb } from "../db.ts";
import { summary } from "../analytics.ts";

/**
 * rekt stats — who came and what they used, from the site's own counters.
 *
 *   npm run stats            the last 14 days
 *   npm run stats -- --days 30
 *   npm run stats -- --json  the same as JSON
 *
 * A visitor is a salted daily hash of the IP and the user agent: the rows can say how many people
 * came and never who they were. Crawlers are counted apart and left out of the totals.
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) || dflt : dflt;
};

const db = openDb();
const rows = summary(db, arg("days", 14));

if (argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
  db.close();
  process.exit(0);
}

if (!rows.length) {
  console.log("Nothing counted yet. The site writes its counters every 15 seconds while it is up.");
  db.close();
  process.exit(0);
}

const FEATURES = ["landing", "report", "pass", "board", "token", "hall", "airlines", "leaderboards", "turbulence", "desk", "roadmap", "about"] as const;
const pad = (s: string, n: number): string => s.padEnd(n);
const rt = (n: number | string, w: number): string => String(n).padStart(w);

console.log("\nrekt stats — people and features, from the site's own counters\n");
console.log(`${pad("day", 12)}${rt("people", 7)}${rt("wallets", 8)}  ${FEATURES.map((f) => rt(f.slice(0, 6), 7)).join("")}`);
console.log("-".repeat(12 + 7 + 8 + 2 + FEATURES.length * 7));
for (const r of rows) {
  console.log(
    pad(r.day, 12) + rt(r.visitors, 7) + rt(r.wallets, 8) + "  "
    + FEATURES.map((f) => rt(r.hits[f] ?? 0, 7)).join(""),
  );
}

const totals: Record<string, number> = {};
let people = 0, wallets = 0, bots = 0, errors = 0;
for (const r of rows) {
  people += r.visitors;
  wallets += r.wallets;
  bots += (r.hits["bot"] ?? 0) + (r.hits["bot:error"] ?? 0);
  errors += r.hits["error"] ?? 0;
  for (const [k, n] of Object.entries(r.hits)) totals[k] = (totals[k] ?? 0) + n;
}
const uniquePeople = db.prepare("SELECT COUNT(DISTINCT who) n FROM visits").get() as { n: number };
const uniqueWallets = db.prepare("SELECT COUNT(DISTINCT address) n FROM lookups").get() as { n: number };

console.log(`\nOver these ${rows.length} day(s): ${people} visits by people, ${wallets} wallets looked up.`);
console.log(`All time: ${uniquePeople.n} distinct visitors (a visitor counts once a day), ${uniqueWallets.n} distinct wallets looked up.`);
console.log(`Crawlers: ${bots} requests, not counted above. Errors served: ${errors}.`);

const used = Object.entries(totals)
  .filter(([k]) => (FEATURES as readonly string[]).includes(k))
  .sort((a, b) => b[1] - a[1]);
if (used.length) {
  console.log("\nMost used:");
  for (const [k, n] of used.slice(0, 8)) console.log(`  ${pad(k, 14)} ${rt(n, 8)}`);
}
console.log();
db.close();
