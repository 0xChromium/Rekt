import { formatEther } from "viem";
import { factoryAbi } from "../chain/abi.ts";
import { ADDR, CFG, CHAIN_ID } from "../chain/config.ts";
import { logsClient, stateClient, wsClient, withRetry } from "../chain/chain.ts";
import { getMeta, openDb } from "../db.ts";

const ok = (s: string): string => `  ok    ${s}`;
const bad = (s: string): string => `  FAIL  ${s}`;
let failures = 0;
const check = (pass: boolean, msg: string): void => {
  if (!pass) failures++;
  console.log(pass ? ok(msg) : bad(msg));
};

console.log("rekt doctor\n");

console.log("endpoints");
let logsBlock = 0;
try {
  logsBlock = Number(await withRetry(() => logsClient.getBlockNumber()));
  check(logsBlock > 0, `logs endpoint ${CFG.logsUrl} at block ${logsBlock}`);
} catch (e) {
  check(false, `logs endpoint ${CFG.logsUrl} unreachable: ${(e as Error).message.slice(0, 60)}`);
}
try {
  const sb = Number(await withRetry(() => stateClient.getBlockNumber()));
  check(Math.abs(sb - logsBlock) < 5000, `state endpoint ${CFG.stateUrl} at block ${sb}`);
} catch {
  check(false, `state endpoint ${CFG.stateUrl} unreachable`);
}
check(wsClient !== null, wsClient ? `websocket ${CFG.wsUrl}` : "websocket disabled, the watcher will poll");

console.log("\nchain");
try {
  const id = await withRetry(() => stateClient.getChainId());
  check(id === CHAIN_ID, `chain id ${id} (expected ${CHAIN_ID})`);
} catch {
  check(false, "chain id unreadable");
}

console.log("\npons v2 factory");
try {
  const code = await withRetry(() => stateClient.getCode({ address: ADDR.factory }));
  check(!!code && code.length > 2, `factory ${ADDR.factory} has ${code ? (code.length - 2) / 2 : 0} bytes of code`);

  const read = async (fn: string): Promise<unknown> =>
    withRetry(() => stateClient.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: fn as never }));
  const [escrow, hook, deployer, enabled, maxTax, fee] = await Promise.all(
    ["feeEscrow", "memeHook", "launchDeployer", "launchEnabled", "maxCreatorTaxBps", "launchFee"].map(read),
  );
  // The factory is the authority on its own wiring; a mismatch means our constants drifted.
  check(String(escrow).toLowerCase() === ADDR.escrow.toLowerCase(), `feeEscrow() matches config (${escrow})`);
  check(String(hook).toLowerCase() === ADDR.hook.toLowerCase(), `memeHook() matches config (${hook})`);
  check(String(deployer).toLowerCase() === ADDR.deployer.toLowerCase(), `launchDeployer() matches config (${deployer})`);
  check(enabled === true, `launchEnabled() is ${enabled}`);
  console.log(ok(`maxCreatorTaxBps() ${maxTax}, launchFee() ${formatEther(fee as bigint)} ETH`));

  const mc = await withRetry(() => stateClient.getCode({ address: ADDR.multicall3 }));
  check(!!mc && mc.length > 2, `Multicall3 ${ADDR.multicall3} has code`);
} catch (e) {
  check(false, `factory reads failed: ${(e as Error).message.slice(0, 80)}`);
}

console.log("\ntoken");
if (CFG.rektToken) {
  try {
    const r = await withRetry(() => stateClient.readContract({
      address: ADDR.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [CFG.rektToken as `0x${string}`],
    }));
    check(r.exists, `REKT_TOKEN ${CFG.rektToken} is a Pons launch, tax ${Number(r.creatorTaxBps) / 100}%`);

    // The one check on this list that cannot be undone. Somebody else runs the launch and types the
    // recipient, and every fee the token ever earns follows that field. Two hex strings compared by
    // eye at the busiest minute of the day is how it goes wrong, so it is compared here instead.
    const paid = String(r.creatorFeeRecipient).toLowerCase();
    if (CFG.feeWallet) {
      check(paid === CFG.feeWallet.toLowerCase(),
        paid === CFG.feeWallet.toLowerCase()
          ? `creator fees are paid to our wallet ${paid}`
          : `creator fees are paid to ${paid}, NOT our FEE_WALLET ${CFG.feeWallet.toLowerCase()} — do not announce`);
    } else {
      check(false, `creator fees are paid to ${paid}, and FEE_WALLET is empty so nothing can be compared to it`);
    }
  } catch {
    check(false, `REKT_TOKEN ${CFG.rektToken} could not be read from the factory`);
  }
} else {
  console.log(ok("REKT_TOKEN empty: no CA yet"));
  if (CFG.feeWallet) console.log(ok(`FEE_WALLET ${CFG.feeWallet.toLowerCase()} is set and will be checked against the launch`));
  else check(false, "FEE_WALLET empty: set it before the launch so the recipient can be verified");
}

console.log("\nstorage");
try {
  const db = openDb();
  const count = (t: string): number => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const launches = count("launches");
  const named = (db.prepare("SELECT count(*) c FROM launches WHERE symbol IS NOT NULL").get() as { c: number }).c;
  check(true, `${CFG.dbPath} opens`);
  console.log(ok(`launches ${launches} (${named} with symbol), positions ${count("trader_positions")}, token_state ${count("token_state")}, losses ${count("losses")}`));
  const range = db.prepare("SELECT min(block) lo, max(block) hi FROM launches").get() as { lo: number | null; hi: number | null };
  console.log(ok(`launch blocks ${range.lo ?? "-"}..${range.hi ?? "-"}; backfill ${getMeta(db, "backfill_from_block") ?? "-"}..${getMeta(db, "backfill_to_block") ?? "-"}; fold cursor ${getMeta(db, "fold_to_block") ?? "-"}`));
  db.close();
} catch (e) {
  check(false, `database: ${(e as Error).message.slice(0, 80)}`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
