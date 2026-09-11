import { readFileSync } from "node:fs";
import { decodeEventLog } from "viem";
import { escrowAbi, TOPIC, asTopic } from "./chain/abi.ts";
import { BlockClock } from "./chain/blockclock.ts";
import { getLogsChunked, stateClient, withRetry, type RawLog } from "./chain/chain.ts";
import { ADDR, CFG } from "./chain/config.ts";
import { getMeta, setMeta, toEth, type DB } from "./db.ts";
import { usdOf } from "./prices.ts";
import { parseRoadmap, type RoadmapStatus } from "./roadmap.ts";
import type { ContractStatus, Desk, LedgerRow, RecipientKind } from "./types.ts";

/**
 * The compensation desk (SPEC 3.6): recipient, accrued in the escrow, wallet balance, contracts,
 * ledger. Owned by the api builder. api.ts caches 60 seconds.
 *
 * Nothing here signs anything or moves anything. It reads state and logs.
 */

const num = (h: unknown): number => Number(BigInt(h as string));

export type EscrowCounts = { credited: number; claimed: number };

/**
 * Credits and claims for one recipient, from the Pons fee escrow, into fee_events. Filtered on the
 * recipient topic rather than read wholesale: the escrow serves every launch on the chain, and the
 * ledger only ever asks about one address at a time. Rows are keyed on (tx, log_index), so a
 * re-read of a range is harmless.
 */
export async function indexEscrow(db: DB, recipient: string, fromBlock: number, toBlock: number): Promise<EscrowCounts> {
  const out: EscrowCounts = { credited: 0, claimed: 0 };
  if (toBlock < fromBlock) return out;
  const logs: RawLog[] = await getLogsChunked(
    { address: ADDR.escrow, topics: [[TOPIC.credited, TOPIC.claimed], asTopic(recipient)] },
    fromBlock, toBlock,
  );
  if (!logs.length) return out;

  const clock = new BlockClock();
  const tsOf = new Map<number, number>();
  for (const b of new Set(logs.map((l) => num(l.blockNumber)))) tsOf.set(b, await clock.at(b));

  const ins = db.prepare(`
    INSERT INTO fee_events (tx, log_index, kind, recipient, depositor, amount_wei, amount_eth, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const l of logs) {
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: escrowAbi, topics: l.topics, data: l.data });
      } catch {
        continue;
      }
      const a = ev.args as Record<string, unknown>;
      const amount = a.amount as bigint;
      const block = num(l.blockNumber);
      ins.run(
        l.transactionHash, num(l.logIndex), ev.eventName === "Credited" ? "credited" : "claimed",
        String(a.recipient).toLowerCase(), a.depositor ? String(a.depositor).toLowerCase() : null,
        amount.toString(), toEth(amount), block, tsOf.get(block) ?? 0,
      );
      if (ev.eventName === "Credited") out.credited++;
      else out.claimed++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return out;
}

/** Where the escrow read for a recipient stopped, kept per recipient. */
export const escrowCursorKey = (recipient: string): string => `fees_to_block:${recipient.toLowerCase()}`;

/**
 * Reads the escrow forward from the last cursor (starting at $REKT's launch block the first time)
 * to the head, trailing it by a small reorg margin. Does nothing before $REKT is in `launches`,
 * so the logs endpoint is never asked for a range nobody has a use for.
 */
export async function indexEscrowSince(db: DB, recipient: string, margin = 50): Promise<EscrowCounts & { from: number; to: number } | null> {
  const key = escrowCursorKey(recipient);
  let from = Number(getMeta(db, key) ?? NaN);
  if (!Number.isFinite(from)) {
    if (!CFG.rektToken) return null;
    const launch = db.prepare("SELECT block FROM launches WHERE token = ?").get(CFG.rektToken) as { block: number } | undefined;
    if (!launch) return null;
    from = launch.block;
  } else {
    from += 1;
  }
  const head = Number(await withRetry(() => stateClient.getBlockNumber())) - margin;
  if (head < from) return { credited: 0, claimed: 0, from, to: head };
  const counts = await indexEscrow(db, recipient, from, head);
  setMeta(db, key, String(head));
  return { ...counts, from, to: head };
}

/** The recipient the desk describes: the splitter once configured, else the fee wallet. */
export function deskRecipient(): { recipient: string | null; kind: RecipientKind } {
  if (CFG.splitter) return { recipient: CFG.splitter, kind: "splitter" };
  if (CFG.feeWallet) return { recipient: CFG.feeWallet, kind: "wallet" };
  return { recipient: null, kind: "none" };
}

let roadmapStatusCache: { at: number; status: ContractStatus } | null = null;

/** The Status line of ROADMAP.md item 0, as a ContractStatus; "planned" when the file cannot be read. */
export function roadmapContractStatus(path = "ROADMAP.md"): ContractStatus {
  if (roadmapStatusCache && Date.now() - roadmapStatusCache.at < 60_000) return roadmapStatusCache.status;
  let status: ContractStatus = "planned";
  try {
    const items = parseRoadmap(readFileSync(path, "utf8"));
    const item = items.find((i) => i.n === "0") ?? items.find((i) => /split/i.test(i.title));
    const s: RoadmapStatus | undefined = item?.status;
    if (s === "live" || s === "in progress" || s === "planned") status = s;
  } catch {
    // No roadmap on disk: nothing is promised.
  }
  roadmapStatusCache = { at: Date.now(), status };
  return status;
}

/** Distributions so far: fee_events rows of kind 'split' for the recipient, newest first. */
export function deskLedger(db: DB, recipient: string | null, limit = 50): LedgerRow[] {
  if (!recipient) return [];
  const eth = usdOf("ETH") ?? 0;
  const rows = db.prepare(`
    SELECT tx, ts, amount_eth, depositor FROM fee_events
    WHERE kind = 'split' AND recipient = ? ORDER BY block DESC, log_index DESC LIMIT ?`).all(recipient, limit) as
    Array<{ tx: string; ts: number; amount_eth: number; depositor: string | null }>;
  return rows.map((r) => ({
    ts: r.ts,
    tx: r.tx,
    amountUsd: Math.round(r.amount_eth * eth * 100) / 100,
    // The splitter's event carries the staker count in `depositor` until the v2 ABI lands; 0 otherwise.
    recipients: Number(r.depositor) || 0,
  }));
}

let lastGood: Desk | null = null;

/**
 * Recipient is CFG.splitter when set, else CFG.feeWallet, else null (recipientKind none). Accrued
 * is escrow.balanceOf(recipient) on the state RPC; wallet is getBalance(recipient); USD at the
 * ETH price from the price book. ETH is the whole story on purpose: $REKT is launched on an ETH
 * pair (SPEC 4.1), so the escrow credits us in ether. A token quote would credit `CreditedToken`
 * and need `balanceOfToken` here and `claimToken` in the splitter; none of that is wired. Contracts status: live when both CFG.splitter and CFG.staking
 * are set, else the status of ROADMAP.md item 0. Ledger from fee_events kind 'split' (empty
 * until the splitter exists).
 */
export async function deskData(db: DB): Promise<Desk> {
  const { recipient, kind } = deskRecipient();
  const eth = usdOf("ETH") ?? 0;
  const status: ContractStatus = CFG.splitter && CFG.staking ? "live" : roadmapContractStatus();
  const base = {
    recipient,
    recipientKind: kind,
    contracts: { splitter: CFG.splitter || null, staking: CFG.staking || null, status },
    ledger: deskLedger(db, recipient),
    ca: CFG.rektToken || null,
  };
  if (!recipient) {
    return { ...base, accruedWei: "0", accruedUsd: 0, walletWei: "0", holdersHalfUsd: 0, sharing: false };
  }
  try {
    const [accrued, wallet] = await Promise.all([
      withRetry(() => stateClient.readContract({
        address: ADDR.escrow, abi: escrowAbi, functionName: "balanceOf", args: [recipient as `0x${string}`],
      })) as Promise<bigint>,
      withRetry(() => stateClient.getBalance({ address: recipient as `0x${string}` })),
    ]);
    const accruedUsd = toEth(accrued) * eth;
    const walletUsd = toEth(wallet) * eth;
    const desk: Desk = {
      ...base,
      accruedWei: accrued.toString(),
      accruedUsd: Math.round(accruedUsd * 100) / 100,
      walletWei: wallet.toString(),
      // The rule starts when the splitter becomes the recipient, and not a block earlier. While the
      // fee wallet is the recipient this is zero rather than half, because calling it holders' money
      // and then not paying it out is the one thing this page exists to make impossible.
      sharing: kind === "splitter",
      holdersHalfUsd: kind === "splitter" ? Math.round(((accruedUsd + walletUsd) / 2) * 100) / 100 : 0,
    };
    lastGood = desk;
    return desk;
  } catch (err) {
    // The chain not answering should not blank the trust surface: the last good numbers stand.
    if (lastGood && lastGood.recipient === recipient) return { ...lastGood, ...base };
    throw err;
  }
}
