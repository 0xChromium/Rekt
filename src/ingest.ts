import { decodeEventLog } from "viem";
import { factoryAbi, TOPIC } from "./chain/abi.ts";
import { ADDR } from "./chain/config.ts";
import { getLogsChunked, hexNum, type RawLog } from "./chain/chain.ts";
import { BlockClock } from "./chain/blockclock.ts";
import { now, type DB } from "./db.ts";

export const FACTORY_TOPICS: `0x${string}`[] = [TOPIC.tokenLaunched, TOPIC.poolGraduated, TOPIC.creatorFeeRecipientUpdated];

export type IngestCounts = { launched: number; graduated: number; feeChanged: number };

/**
 * Writes one batch of factory logs. Every statement is an upsert keyed on the on-chain identifier,
 * so replaying a range after a reorg or a crash corrects rows instead of duplicating them.
 * Shared by the backfill and the watcher.
 */
export function writeFactoryLogs(db: DB, logs: RawLog[], tsOf: Map<number, number>): IngestCounts {
  const counts: IngestCounts = { launched: 0, graduated: 0, feeChanged: 0 };

  // The flight number is taken once, on insert; a replay of the same launch keeps it.
  const insLaunch = db.prepare(`
    INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
      block, tx, log_index, ts, first_seen_at, flight)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(flight), 0) + 1 FROM launches))
    ON CONFLICT(token) DO UPDATE SET
      curve=excluded.curve, deployer=excluded.deployer, pair_token=excluded.pair_token,
      block=excluded.block, tx=excluded.tx, log_index=excluded.log_index, ts=excluded.ts`);

  const setGrad = db.prepare("UPDATE launches SET graduated_ts = ?, graduated_block = ? WHERE token = ?");

  const insFeeChg = db.prepare(`
    INSERT INTO fee_recipient_changes (token, tx, log_index, prev, next, block, ts)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const log of logs) {
      const block = hexNum(log.blockNumber);
      const ts = tsOf.get(block) ?? 0;
      const tx = log.transactionHash;
      const li = hexNum(log.logIndex);
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: factoryAbi, topics: log.topics, data: log.data });
      } catch {
        continue; // an event we do not model
      }
      const a = ev.args as Record<string, unknown>;

      switch (ev.eventName) {
        case "TokenLaunched": {
          insLaunch.run(
            String(a.token).toLowerCase(), String(a.curve).toLowerCase(), String(a.deployer).toLowerCase(),
            String(a.pairToken).toLowerCase(), Number(a.launchConfigId as bigint),
            (a.graduationThreshold as bigint).toString(), block, tx, li, ts, now(),
          );
          counts.launched++;
          break;
        }
        case "PoolGraduated": {
          setGrad.run(ts, block, String(a.token).toLowerCase());
          counts.graduated++;
          break;
        }
        case "CreatorFeeRecipientUpdated": {
          insFeeChg.run(
            String(a.token).toLowerCase(), tx, li,
            String(a.previousRecipient).toLowerCase(), String(a.newRecipient).toLowerCase(), block, ts,
          );
          counts.feeChanged++;
          break;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return counts;
}

/** Streams a block range from the factory into the database, chunk by chunk. */
export async function backfillRange(
  db: DB,
  fromBlock: number,
  toBlock: number,
  onProgress?: (done: number, total: number, c: IngestCounts) => void,
  clock = new BlockClock(),
): Promise<IngestCounts> {
  await clock.seed(fromBlock, toBlock);
  const total: IngestCounts = { launched: 0, graduated: 0, feeChanged: 0 };

  await getLogsChunked(
    { address: ADDR.factory, topics: [FACTORY_TOPICS] },
    fromBlock,
    toBlock,
    async (logs, _from, to) => {
      const tsOf = new Map<number, number>();
      for (const b of new Set(logs.map((l) => hexNum(l.blockNumber)))) tsOf.set(b, await clock.at(b));
      const c = writeFactoryLogs(db, logs, tsOf);
      total.launched += c.launched;
      total.graduated += c.graduated;
      total.feeChanged += c.feeChanged;
      onProgress?.(to - fromBlock, toBlock - fromBlock, total);
    },
  );
  return total;
}
