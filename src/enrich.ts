import { decodeFunctionData, parseAbi } from "viem";
import { factoryAbi, routerAbi } from "./chain/abi.ts";
import { ADDR } from "./chain/config.ts";
import { stateClient, withRetry } from "./chain/chain.ts";
import { now, type DB } from "./db.ts";

/**
 * Facts that only the launch transaction holds.
 *
 * The TokenLaunched `deployer` is whoever called the factory, which is frequently a router or
 * Multicall3. The person behind a launch is the transaction sender, so this reads tx.from. Launches
 * through the Pons router also carry the declared name, symbol, fee recipient, tax and the opening
 * tax exemptions in the calldata; the rest are asked from the token and the factory.
 */
export type LaunchDetail = {
  token: string;
  sender: string;
  routedThroughRouter: boolean;
  name?: string;
  symbol?: string;
  creatorFeeRecipient?: string;
  creatorTaxBps?: number;
  exemptions: string[];
};

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

/** Name and ticker straight from the token contract. Concurrent reads batch into one multicall. */
export async function readTokenIdentity(token: string): Promise<{ name?: string; symbol?: string }> {
  const address = token as `0x${string}`;
  const [n, s] = await Promise.allSettled([
    withRetry(() => stateClient.readContract({ address, abi: erc20, functionName: "name" })),
    withRetry(() => stateClient.readContract({ address, abi: erc20, functionName: "symbol" })),
  ]);
  return {
    name: n.status === "fulfilled" ? String(n.value).slice(0, 128) : undefined,
    symbol: s.status === "fulfilled" ? String(s.value).slice(0, 32) : undefined,
  };
}

/** Fee recipient and tax from the factory's own record of the launch. */
export async function readLaunchRecord(token: string): Promise<{ creatorFeeRecipient: string; creatorTaxBps: number } | null> {
  try {
    const r = await withRetry(() => stateClient.readContract({
      address: ADDR.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token as `0x${string}`],
    }));
    if (!r.exists) return null;
    return { creatorFeeRecipient: r.creatorFeeRecipient.toLowerCase(), creatorTaxBps: Number(r.creatorTaxBps) };
  } catch {
    return null;
  }
}

export async function fetchLaunchDetail(token: string, txHash: string): Promise<LaunchDetail> {
  // Transactions come from the state endpoint: an enrichment pass is thousands of calls and the
  // logs endpoint's budget belongs to eth_getLogs.
  const tx = await withRetry(() => stateClient.getTransaction({ hash: txHash as `0x${string}` }));
  const detail: LaunchDetail = {
    token: token.toLowerCase(),
    sender: tx.from.toLowerCase(),
    routedThroughRouter: (tx.to ?? "").toLowerCase() === ADDR.router.toLowerCase(),
    exemptions: [],
  };

  try {
    const d = decodeFunctionData({ abi: routerAbi, data: tx.input });
    if (d.functionName === "launchAndBuy") {
      const [params, , , , , , exemptions] = d.args as [
        { name: string; symbol: string; creatorFeeRecipient: string; creatorTaxBps: number },
        bigint, string, bigint, bigint, string, readonly string[],
      ];
      detail.name = params.name;
      detail.symbol = params.symbol;
      detail.creatorFeeRecipient = params.creatorFeeRecipient.toLowerCase();
      detail.creatorTaxBps = Number(params.creatorTaxBps);
      detail.exemptions = [...new Set(exemptions.map((a) => a.toLowerCase()))];
    }
  } catch {
    // Not a router call we can decode; the sender still stands and the contracts answer the rest.
  }

  if (detail.symbol === undefined) {
    const id = await readTokenIdentity(token);
    detail.name = id.name;
    detail.symbol = id.symbol;
  }
  if (detail.creatorFeeRecipient === undefined) {
    const rec = await readLaunchRecord(token);
    if (rec) {
      detail.creatorFeeRecipient = rec.creatorFeeRecipient;
      detail.creatorTaxBps = rec.creatorTaxBps;
    }
  }
  return detail;
}

export function saveLaunchDetail(db: DB, d: LaunchDetail): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE launches SET
        launch_sender = ?, creator_fee_recipient = ?, creator_tax_bps = ?,
        name = coalesce(?, name), symbol = coalesce(?, symbol), enriched_at = ?
      WHERE token = ?`).run(
      d.sender, d.creatorFeeRecipient ?? null, d.creatorTaxBps ?? null,
      d.name ?? null, d.symbol ?? null, now(), d.token,
    );
    const insEx = db.prepare("INSERT INTO exemptions(token,address) VALUES(?,?) ON CONFLICT DO NOTHING");
    for (const a of d.exemptions) insEx.run(d.token, a);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Enriches one launch and saves it; the row keeps enriched_at null on failure for a later pass. */
export async function enrichOne(db: DB, token: string, tx: string): Promise<boolean> {
  try {
    saveLaunchDetail(db, await fetchLaunchDetail(token, tx));
    return true;
  } catch {
    return false;
  }
}

export function pendingEnrichment(db: DB): number {
  return (db.prepare("SELECT count(*) c FROM launches WHERE enriched_at IS NULL").get() as { c: number }).c;
}

/**
 * Enriches launches that have no detail yet, newest first, with a few workers in flight.
 * Resumable: every saved row is its own checkpoint, and a rerun picks up whatever is still null.
 */
export async function enrichPending(
  db: DB, limit: number, workers = 4, onEach?: (done: number, total: number, ok: number) => void,
): Promise<{ done: number; ok: number }> {
  const rows = db.prepare(
    "SELECT token, tx FROM launches WHERE enriched_at IS NULL ORDER BY block DESC LIMIT ?",
  ).all(limit) as Array<{ token: string; tx: string }>;

  let done = 0;
  let ok = 0;
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        if (await enrichOne(db, row.token, row.tx)) ok++;
        onEach?.(++done, rows.length, ok);
      }
    }),
  );
  return { done, ok };
}
