import { createPublicClient, defineChain, http, webSocket, type PublicClient } from "viem";
import { ADDR, CFG, CHAIN_ID } from "./config.ts";

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CFG.logsUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: ADDR.multicall3 } },
});

/**
 * Every RPC call goes through this gate: bounded concurrency, a minimum gap between calls, and a
 * backoff that waits out a 429 instead of hammering through it.
 */
class Gate {
  #active = 0;
  #queue: Array<() => void> = [];
  #lastStart = 0;
  #limit: number;
  #spacingMs: number;

  constructor(limit: number, spacingMs: number) {
    this.#limit = limit;
    this.#spacingMs = spacingMs;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((r) => this.#queue.push(r));
    this.#active++;
    const gap = this.#spacingMs - (Date.now() - this.#lastStart);
    if (gap > 0) await sleep(gap);
    this.#lastStart = Date.now();
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const gate = new Gate(CFG.inFlight, CFG.spacingMs);
const headers = { "user-agent": "rekt/0.1 (+https://rekt.report)" };

/**
 * Retries throttling and transient network errors with exponential backoff; surfaces everything else.
 * A 403 is the official RPC cooling off after a long sweep, so it gets a slower backoff than a 429.
 */
/**
 * Retries a call the endpoint refused or dropped.
 *
 * A refusal for rate (429, or the 403 the endpoint uses for the same thing) is not a fault to
 * retry quickly: it is the endpoint asking for less, and answering it with six tries in twenty-five
 * seconds is asking for more. Those wait long and are given many tries, up to about ten minutes
 * of patience in total, because the alternative was the backfill dying on the sixth try, systemd
 * starting it again thirty seconds later, and the watcher, which shares the endpoint, starved by
 * the pair of them for as long as the provider kept throttling.
 */
export const THROTTLE_TRIES = 12;
export const isThrottle = (msg: string): boolean => /Status:\s*403|\bForbidden\b|\b429\b|Too Many Requests/i.test(msg);

export async function withRetry<T>(fn: () => Promise<T>, tries = 6, base = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; ; i++) {
    try {
      return await gate.run(fn);
    } catch (err) {
      last = err;
      const msg = String((err as Error)?.message ?? err);
      const throttled = isThrottle(msg);
      const retryable = throttled || /timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|socket/i.test(msg);
      const limit = throttled ? Math.max(tries, THROTTLE_TRIES) : tries;
      if (!retryable || i >= limit - 1) throw err;
      await sleep(throttled ? Math.min(60_000, 5_000 * 2 ** i) : base * 2 ** i);
    }
  }
}

/** Contract reads, transactions, receipts. Concurrent reads are batched into one multicall. */
export const stateClient: PublicClient = createPublicClient({
  chain: robinhood,
  transport: http(CFG.stateUrl, { fetchOptions: { headers }, timeout: 20_000, retryCount: 0 }),
  batch: { multicall: { wait: 16 } },
});

/** eth_getLogs. The official endpoint is the only public one that serves it. */
export const logsClient: PublicClient = createPublicClient({
  chain: robinhood,
  transport: http(CFG.logsUrl, { fetchOptions: { headers }, timeout: 60_000, retryCount: 0 }),
});

/** Push detection. Null when RPC_WS_URL=off, in which case callers poll instead. */
export const wsClient: PublicClient | null =
  CFG.wsUrl && CFG.wsUrl.toLowerCase() !== "off"
    ? createPublicClient({ chain: robinhood, transport: webSocket(CFG.wsUrl, { reconnect: true, retryCount: 10 }) })
    : null;

export type RawLog = {
  address: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  removed?: boolean;
};

export const hexNum = (h: unknown): number => Number(BigInt(h as string));
export const hex = (n: number): `0x${string}` => `0x${n.toString(16)}`;

/**
 * One eth_getLogs call against the logs endpoint, with retries.
 *
 * Sent with plain fetch rather than through the client, because the client caps a response body at
 * ten megabytes and a busy two-thousand-block chunk of Uniswap swaps came back at 10,502,144 bytes.
 * That cap is the client giving up on an answer the endpoint was willing to give, and the fold's
 * only recourse is to halve the range and read the same span twice. Nothing else here needs the
 * client's machinery: the request is one object and the reply is an array of logs.
 */
export async function getLogs(
  params: { address?: `0x${string}` | `0x${string}`[]; topics?: (`0x${string}` | `0x${string}`[] | null)[] },
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getLogs",
    params: [{ ...params, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }],
  });
  return withRetry(async () => {
    const res = await fetch(CFG.logsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "rekt/0.1 (+https://rekt.report)" },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`eth_getLogs ${fromBlock}..${toBlock}: HTTP ${res.status} ${res.statusText}`);
    const json = await res.json() as { result?: RawLog[]; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "eth_getLogs failed");
    if (!Array.isArray(json.result)) throw new Error(`eth_getLogs ${fromBlock}..${toBlock}: reply has no result`);
    return json.result;
  });
}

/**
 * eth_getLogs is capped at 10,000 results per response and wide ranges time out. Walks the range in
 * chunks and halves a chunk that trips either limit rather than losing the span.
 */
export async function getLogsChunked(
  params: { address?: `0x${string}` | `0x${string}`[]; topics?: (`0x${string}` | `0x${string}`[] | null)[] },
  fromBlock: number,
  toBlock: number,
  onChunk?: (logs: RawLog[], from: number, to: number) => void | Promise<void>,
  chunkSize = CFG.logsChunk,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let lo = fromBlock;
  let size = chunkSize;
  while (lo <= toBlock) {
    const hi = Math.min(lo + size - 1, toBlock);
    try {
      const logs = await getLogs(params, lo, hi);
      if (onChunk) await onChunk(logs, lo, hi);
      else out.push(...logs);
      lo = hi + 1;
      // Creep back toward the configured chunk size after a successful narrow read.
      if (size < chunkSize) size = Math.min(chunkSize, size * 2);
      await sleep(CFG.logsSpacingMs);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/exceeds limit|timed out|too many|invalid parameters/i.test(msg) && size > 500) {
        size = Math.floor(size / 2);
        continue;
      }
      throw err;
    }
  }
  return out;
}
