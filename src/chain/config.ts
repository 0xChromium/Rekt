import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";

/** Minimal .env loader; values already in the environment win. */
function loadEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const str = (k: string, d: string): string => process.env[k]?.trim() || d;
const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};
const addr = (k: string): string => str(k, "").toLowerCase();

export const CFG = {
  /** The only public endpoint that serves eth_getLogs. Rate limited. */
  logsUrl: str("RPC_LOGS_URL", "https://rpc.mainnet.chain.robinhood.com"),
  /** State reads. Faster and more generous, refuses eth_getLogs. */
  stateUrl: str("RPC_STATE_URL", "https://robinhood-rpc.publicnode.com"),
  /** Push detection. "off" falls back to polling every POLL_MS. */
  wsUrl: str("RPC_WS_URL", "wss://robinhood-rpc.publicnode.com"),
  pollMs: num("POLL_MS", 300),
  inFlight: num("RPC_IN_FLIGHT", 3),
  spacingMs: num("RPC_SPACING_MS", 60),
  logsChunk: num("LOGS_CHUNK_BLOCKS", 60_000),
  logsSpacingMs: num("LOGS_SPACING_MS", 400),
  dbPath: str("DB_PATH", "data/rekt.db"),
  port: num("PORT", 8787),
  publicUrl: str("PUBLIC_URL", "http://localhost:8787").replace(/\/+$/, ""),
  /** $REKT's contract address. Empty means no CA yet. */
  rektToken: addr("REKT_TOKEN"),
  /** Creator fee recipient until the splitter is live. */
  feeWallet: addr("FEE_WALLET"),
  teamWallet: addr("TEAM_WALLET"),
  /** Empty until the contracts are deployed. */
  splitter: addr("SPLITTER"),
  staking: addr("STAKING"),
} as const;

/** Pons v2 on Robinhood Chain. Checked against the factory's own getters (npm run doctor). */
export const ADDR = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  deployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  cbBTC: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  /** Canonical Multicall3. Also the busiest "deployer" in TokenLaunched. */
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

export const CHAIN_ID = 4663;
/** ~0.1009 s per block, measured over 1M blocks. */
export const BLOCKS_PER_DAY = 856_582;

/**
 * The first block of Pons v2, 4 August 2026, found by bisecting block times. The record cannot
 * usefully reach further back: v1 launched into Uniswap v3 pools and is a different indexer.
 */
export const V2_START_BLOCK = 27_176_459;
export const BLOCKS_PER_SECOND = 9.91;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const EXPLORER = {
  tx: (h: string): string => `https://robinhoodchain.blockscout.com/tx/${h}`,
  address: (a: string): string => `https://robinhoodchain.blockscout.com/address/${a}`,
  token: (a: string): string => `https://robinhoodchain.blockscout.com/token/${a}`,
  pons: (a: string): string => `https://www.ponsfamily.com/token/${a}`,
  axiom: (a: string): string => `https://axiom.trade/token/${a}?chain=robinhood`,
} as const;

/** 0x3f9a…c1e4, the way every surface prints an address. */
export const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
