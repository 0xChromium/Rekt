import { logsClient, stateClient, withRetry } from "./chain.ts";

/**
 * Wall-clock time for a block, without one eth_getBlockByNumber per log.
 *
 * Blocks are sequencer-produced every ~0.1009 s, so timestamps are close to linear in block number.
 * This samples real anchors and interpolates between them, refining an interval when a lookup lands
 * in a gap wider than `maxGap`. Displayed times are approximate to within a few seconds; anything
 * that must be exact uses block numbers.
 */
export class BlockClock {
  #anchors = new Map<number, number>();
  #sorted: number[] = [];
  #maxGap: number;

  constructor(maxGap = 20_000) {
    this.#maxGap = maxGap;
  }

  /**
   * Headers come from the state endpoint first. publicnode runs a few blocks ahead of the official
   * RPC, so a head reported by publicnode may not exist on the other one yet; the official RPC stays
   * the fallback.
   */
  async #fetch(block: number): Promise<number> {
    const read = async (client: typeof stateClient): Promise<{ timestamp: `0x${string}` } | null> =>
      (await client.request({
        method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false],
      } as never)) as { timestamp: `0x${string}` } | null;

    let b: { timestamp: `0x${string}` } | null = null;
    try {
      b = await withRetry(() => read(stateClient));
    } catch {
      b = null;
    }
    if (!b) b = await withRetry(() => read(logsClient));
    if (!b) throw new Error(`block ${block} not found on either endpoint`);
    const ts = Number(BigInt(b.timestamp));
    this.#anchors.set(block, ts);
    this.#sorted = [...this.#anchors.keys()].sort((x, y) => x - y);
    return ts;
  }

  /**
   * Records a block time the caller already knows (a head poll returns number and timestamp
   * together), so a live fold interpolates instead of fetching. Keeps the newest `keep` anchors
   * so a process that runs for days does not grow a table it never reads.
   */
  anchor(block: number, ts: number, keep = 2_000): void {
    this.#anchors.set(block, ts);
    if (this.#anchors.size > keep * 1.5) {
      for (const b of [...this.#anchors.keys()].sort((x, y) => x - y).slice(0, this.#anchors.size - keep)) this.#anchors.delete(b);
    }
    this.#sorted = [...this.#anchors.keys()].sort((x, y) => x - y);
  }

  /** True when every block in the range can be interpolated from anchors no further apart than maxGap. */
  covers(from: number, to: number): boolean {
    if (this.#sorted.length < 2) return false;
    const lo = this.#sorted.find((b) => b >= from - this.#maxGap && b <= from);
    if (lo === undefined) return false;
    let prev = lo;
    for (const b of this.#sorted) {
      if (b <= lo) continue;
      if (b - prev > this.#maxGap) return false;
      prev = b;
      if (b >= to) return true;
    }
    return false;
  }

  /** Pre-seeds anchors every `maxGap` blocks so a backfill interpolates instead of fetching mid-loop. */
  async seed(from: number, to: number): Promise<void> {
    const step = this.#maxGap;
    const points = new Set<number>([from, to]);
    for (let b = from; b < to; b += step) points.add(b);
    for (const b of [...points].sort((x, y) => x - y)) {
      if (!this.#anchors.has(b)) await this.#fetch(b);
    }
  }

  async at(block: number): Promise<number> {
    const exact = this.#anchors.get(block);
    if (exact !== undefined) return exact;
    if (this.#sorted.length < 2) await this.#fetch(block);

    let lo = -1;
    let hi = -1;
    for (const b of this.#sorted) {
      if (b <= block) lo = b;
      else { hi = b; break; }
    }
    if (lo === -1 || hi === -1 || hi - lo > this.#maxGap) return this.#fetch(block);

    const tLo = this.#anchors.get(lo) as number;
    const tHi = this.#anchors.get(hi) as number;
    return Math.round(tLo + ((tHi - tLo) * (block - lo)) / (hi - lo));
  }

  /** A block number for a wall-clock instant, using the same rate in reverse. */
  approxBlockAt(ts: number, latestBlock: number, latestTs: number): number {
    return Math.max(0, Math.round(latestBlock - (latestTs - ts) / 0.1009));
  }
}
