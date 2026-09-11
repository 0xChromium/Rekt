import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openDb } from "./db.ts";

/**
 * Two processes write this database at once — the watcher, and whichever backfill is extending the
 * record — so the rule that keeps them off each other's toes is worth a test of its own.
 */

let dir: string;

before(() => { dir = mkdtempSync(join(tmpdir(), "rekt-db-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/** Every source file, so the check below cannot miss one that is added later. */
function sources(root = "src"): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("transactions", () => {
  it("asks for the write lock at the start, everywhere", () => {
    const deferred: string[] = [];
    for (const f of sources()) {
      const src = readFileSync(f, "utf8");
      for (const [, line] of src.matchAll(/exec\((["'`])(BEGIN(?! IMMEDIATE)[^"'`]*)\1\)/g)) {
        deferred.push(`${f}: ${line}`);
      }
    }
    assert.deepEqual(deferred, [], "a plain BEGIN cannot wait for the lock; see openDb");
  });

  it("fails the deferred upgrade the timeout cannot save, and not the immediate one", () => {
    const path = join(dir, "race.db");
    const a = openDb(path);
    const b = openDb(path);
    // A tenth of a second, so the loser gives up while the test is still running.
    b.exec("PRAGMA busy_timeout = 100");
    const put = (db: ReturnType<typeof openDb>, k: string) =>
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)").run(k, "1");

    // Deferred: A reads, B writes underneath it, and A's first write is refused on the spot —
    // no waiting, no timeout, because waiting there could deadlock.
    a.exec("BEGIN");
    a.prepare("SELECT value FROM meta WHERE key = ?").get("nothing");
    b.exec("BEGIN IMMEDIATE"); put(b, "from-b"); b.exec("COMMIT");
    assert.throws(() => put(a, "from-a"), /database is locked/);
    a.exec("ROLLBACK");

    // Immediate: A holds the lock from the first statement, so its own writes always land, and B
    // is the one that waits — which is safe, and what the timeout is for.
    a.exec("BEGIN IMMEDIATE");
    a.prepare("SELECT value FROM meta WHERE key = ?").get("nothing");
    assert.throws(() => b.exec("BEGIN IMMEDIATE"), /database is locked/, "B waits its turn");
    put(a, "from-a");
    a.exec("COMMIT");

    assert.equal((a.prepare("SELECT value FROM meta WHERE key = 'from-a'").get() as { value: string }).value, "1");
    a.close();
    b.close();
  });
});
