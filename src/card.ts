import { readFile } from "node:fs/promises";
import { join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { FONT_DIR, FONT_FILES } from "./cli/fonts.ts";
import { NO_DEPLOYER, type Report } from "./types.ts";

/**
 * The boarding pass, 1200 by 630 PNG (SPEC 3.3), satori then resvg, fonts from assets/fonts.
 * Owned by the card builder. api.ts serves it at GET /card/:address.png and caches the PNG on
 * disk under data/cards/<address>-<hour>.png.
 *
 * The layout is the Terminal 67 mock scaled up: a paper pass on the dark
 * ground, an amber strip, a three by three fields grid, the wide line, and a stub on the right with
 * a dashed tear edge and a barcode. The element tree is plain objects ({type, props}); satori reads
 * it the way it reads JSX output, so no React is involved. Every div with more than one child says
 * display flex, which satori requires.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Palette from brand/tokens.css. Survivor green is the brand green darkened for paper: #3DDC84
// on #F4F4F2 is a 1.6:1 contrast, unreadable at text size; the hue is kept.
export const C = {
  ground: "#1B1F24",
  paper: "#F4F4F2",
  paperDim: "#EDEDEA",
  amber: "#F5B400",
  ink: "#111111",
  inkDim: "#6B6B68",
  dash: "#B9B9B4",
  red: "#E0322B",
  green: "#1E9E5A",
} as const;

const MONO = "IBM Plex Mono";
const SIGN = "Barlow Semi Condensed";
const BOARD = "Barlow Condensed";

// ---------------------------------------------------------------- fonts, read once

type FontEntry = { name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 700 | 800; style: "normal" };
let fontsPromise: Promise<FontEntry[]> | null = null;

export function loadFonts(): Promise<FontEntry[]> {
  fontsPromise ??= Promise.all(
    FONT_FILES.map(async (f) => {
      const buf = await readFile(join(FONT_DIR, f.file));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      return { name: f.family, data, weight: f.weight as FontEntry["weight"], style: "normal" as const };
    }),
  ).catch((e) => {
    fontsPromise = null;
    throw new Error(`boarding pass fonts missing in ${FONT_DIR}; run: npm run fonts (${(e as Error).message})`);
  });
  return fontsPromise;
}

// ---------------------------------------------------------------- element tree

export type Style = Record<string, string | number>;
export type Node = { type: string; props: { style?: Style; children?: Node | Node[] | string } };

export const el = (style: Style, ...children: Array<Node | string | null | false>): Node => {
  const kids = children.filter((c): c is Node | string => c !== null && c !== false);
  return { type: "div", props: { style: { display: "flex", ...style }, children: kids.length === 1 ? kids[0] : kids } };
};
export const row = (style: Style, ...children: Array<Node | string | null | false>): Node =>
  el({ display: "flex", flexDirection: "row", ...style }, ...children);
export const col = (style: Style, ...children: Array<Node | string | null | false>): Node =>
  el({ display: "flex", flexDirection: "column", ...style }, ...children);

// ---------------------------------------------------------------- formatting

/** 0x3f9a…c1e4, the truncation every REKT surface uses. */
export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const int = (n: number): string => Math.round(n).toLocaleString("en-US");

/** −$4,212.09 or +$1,098.35, U+2212 for the minus so it sits on the digit line in Plex Mono. */
function signedUsd(n: number, cents = true): string {
  const abs = Math.abs(n);
  const body = abs.toLocaleString("en-US", cents
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
  return `${n < 0 ? "−" : n > 0 ? "+" : ""}$${body}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Aug 4 2026", UTC. */
export function shortDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/** IBM Plex Mono advances 0.6 em per glyph, so the size that fits a width is arithmetic. */
const fitMono = (text: string, width: number, base: number, min = 16): number =>
  Math.max(min, Math.min(base, Math.floor(width / (0.6 * Math.max(1, text.length)))));
/** Barlow Semi Condensed averages about half an em for mixed case; a guard, not a measurement. */
const fitSign = (text: string, width: number, base: number, min = 16): number =>
  Math.max(min, Math.min(base, Math.floor(width / (0.5 * Math.max(1, text.length)))));

const clipSymbol = (s: string): string => (s.length > 14 ? `${s.slice(0, 13)}…` : s);

// ---------------------------------------------------------------- geometry

const PASS_W = 1144, PASS_H = 520;
const PASS_X = (CARD_WIDTH - PASS_W) / 2, PASS_Y = (CARD_HEIGHT - PASS_H) / 2;
const STUB_W = 280;
const MAIN_PAD = 30;
const COL = [300, 232, 232] as const;
const COL_GAP = 20;

// ---------------------------------------------------------------- pieces

function label(text: string): Node {
  return el({
    fontFamily: SIGN, fontWeight: 600, fontSize: 16, letterSpacing: 2, textTransform: "uppercase",
    color: C.inkDim, lineHeight: 1.2,
  }, text);
}

type Field = { label: string; value: string; color?: string; size?: number; font?: "mono" | "sign" };

function field(f: Field, width: number): Node {
  const base = f.size ?? 28;
  const font = f.font ?? "mono";
  const size = font === "mono" ? fitMono(f.value, width, base) : fitSign(f.value, width, base);
  return col({ width, gap: 6 },
    label(f.label),
    el({
      fontFamily: font === "mono" ? MONO : SIGN, fontWeight: 600, fontSize: size, lineHeight: 1.15,
      color: f.color ?? C.ink, whiteSpace: "nowrap",
    }, f.value),
  );
}

function fieldsRow(fields: [Field, Field, Field]): Node {
  return row({ gap: COL_GAP, alignItems: "flex-start" }, ...fields.map((f, i) => field(f, COL[i])));
}

/** Bars from the address: each hex nibble picks a bar width and a gap, so two passes never match. */
function barcode(address: string, height: number): Node {
  const hex = address.replace(/^0x/, "").padEnd(40, "0");
  const bars: Node[] = [];
  for (let i = 0; i < hex.length; i++) {
    const n = parseInt(hex[i], 16);
    // 40 bars, 1..4 px wide with 1..4 px gaps: at most 240 px, inside the stub's 232 px of text width
    // on the worst address and under it on any real one.
    const w = 1 + (n & 3);
    const gap = 1 + ((n >> 2) & 3);
    bars.push(el({ width: w, height, backgroundColor: C.ink, marginRight: gap }));
  }
  return row({ alignItems: "stretch", height, overflow: "hidden", maxWidth: STUB_W - 48 - 3 }, ...bars);
}

function stubField(l: string, v: string, color = C.ink): Node {
  return col({ gap: 4 },
    el({ fontFamily: SIGN, fontWeight: 600, fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: C.inkDim }, l),
    el({ fontFamily: MONO, fontWeight: 600, fontSize: fitMono(v, STUB_W - 48 - 3, 20), color, whiteSpace: "nowrap" }, v),
  );
}

// ---------------------------------------------------------------- the pass

function tree(r: Report, nowTs: number): Node {
  const survivor = r.netRealizedUsd > 0;
  const money = survivor ? C.green : C.red;
  const passenger = shortAddress(r.address);
  const gate = r.rank === null ? `STANDBY · ${int(r.ofWallets)} at the gate` : `${int(r.rank)} of ${int(r.ofWallets)}`;
  const ca = r.ca ? `CA ${shortAddress(r.ca)}` : "no CA yet";

  const worst = r.worst;
  // A pool-only token has no launch on record and so no pilot: the pass names the flight and the
  // loss, and says the rest is not on record rather than printing the zero address as a wallet.
  const noPilot = worst && worst.deployer === NO_DEPLOYER;
  const worstLine = worst
    ? noPilot
      ? `Worst flight ${clipSymbol(worst.symbol)} ${signedUsd(-worst.lossUsd, false)}, already in the air when our records begin`
      : `Worst flight ${clipSymbol(worst.symbol)} ${signedUsd(-worst.lossUsd, false)}, ${worst.dead ? "cancelled by" : "pilot"} ${shortAddress(worst.deployer)} (${int(worst.deployerRecord.launches)} flights, ${Math.round(worst.deployerRecord.deadShare * 100)}% cancelled)`
    : survivor && r.best
      ? `Best flight ${clipSymbol(r.best.symbol)} ${signedUsd(r.best.gainUsd, false)}. Nothing cancelled on record.`
      : "No cancelled flights on record.";
  const thirdLine = r.notAlone && r.notAlone.wallets > 0
    ? `You are not alone: ${int(r.notAlone.wallets)} passengers never arrived on this flight.`
    : r.unpricedPositions > 0
      ? `${int(r.unpricedPositions)} ${r.unpricedPositions === 1 ? "position" : "positions"} in an unpriced asset, not counted.`
      : "Thank you for your liquidity.";

  const strip = row({
    height: 64, backgroundColor: C.amber, paddingLeft: MAIN_PAD, paddingRight: MAIN_PAD,
    alignItems: "center", justifyContent: "space-between", flexShrink: 0,
  },
    el({ fontFamily: SIGN, fontWeight: 700, fontSize: 27, letterSpacing: 2.5, textTransform: "uppercase", color: C.ink }, "REKT Air · Boarding pass"),
    el({ fontFamily: MONO, fontWeight: 500, fontSize: 17, color: C.ink }, `rekt.report · $REKT · ${ca}`),
  );

  const fields = col({ paddingLeft: MAIN_PAD, paddingRight: MAIN_PAD, paddingTop: 26, gap: 24 },
    fieldsRow([
      { label: "Passenger", value: passenger },
      { label: "From", value: "PONS" },
      { label: "To", value: survivor ? "NOT ZERO" : "ZERO", color: survivor ? C.green : C.ink },
    ]),
    fieldsRow([
      { label: survivor ? "Total gain" : "Total loss", value: signedUsd(r.netRealizedUsd), color: money, size: 50 },
      { label: "Flight", value: "RK-67" },
      { label: "Seat", value: survivor ? "1A · window" : "67F · exit row" },
    ]),
    fieldsRow([
      { label: "Gate", value: gate },
      { label: "Class", value: r.className, font: "sign" },
      { label: "Boarded", value: shortDate(r.firstTs) },
    ]),
  );

  // Each line shrinks to fit rather than wrapping: a wrapped "cancelled)" on its own line reads as a
  // layout accident, a 15 px line does not.
  const WIDE_W = PASS_W - STUB_W - 2 * MAIN_PAD;
  const line = (text: string, reserve = 0): Node => el({
    fontFamily: MONO, fontWeight: 400, fontSize: fitMono(text, WIDE_W - reserve, 17, 13), lineHeight: 1.5,
    color: C.inkDim, whiteSpace: "nowrap",
  }, text);
  const wide = col({
    marginLeft: MAIN_PAD, marginRight: MAIN_PAD, marginTop: 24, paddingTop: 14,
    borderTop: `2px dashed ${C.dash}`, gap: 2,
  },
    row({ justifyContent: "space-between", alignItems: "baseline" },
      line(`Baggage: ${int(r.tokensTraded)} ${r.tokensTraded === 1 ? "token" : "tokens"} · ${int(r.bagsHeld)} still at claim`, 140),
      el({ fontFamily: MONO, fontWeight: 500, fontSize: 17, lineHeight: 1.5, color: C.ink }, shortDate(nowTs)),
    ),
    line(worstLine),
    line(thirdLine),
  );

  const main = col({ width: PASS_W - STUB_W, height: PASS_H, backgroundColor: C.paper, overflow: "hidden" }, strip, fields, wide);

  const stub = col({
    width: STUB_W, height: PASS_H, backgroundColor: C.paperDim, borderLeft: `3px dashed ${C.dash}`,
    padding: "26px 24px 24px", gap: 18, overflow: "hidden",
  },
    stubField("Passenger", passenger),
    stubField("Flight · seat", survivor ? "RK-67 · 1A" : "RK-67 · 67F"),
    stubField(survivor ? "Gain" : "Loss", signedUsd(r.netRealizedUsd, false), money),
    stubField("Class", r.className),
    col({ marginTop: "auto", gap: 8 },
      barcode(r.address, 56),
      el({ fontFamily: MONO, fontWeight: 400, fontSize: 13, letterSpacing: 1, color: C.inkDim }, "rekt.report"),
    ),
  );

  const pass = row({
    position: "absolute", left: PASS_X, top: PASS_Y, width: PASS_W, height: PASS_H,
    boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
  }, main, stub);

  return el({
    display: "flex", width: CARD_WIDTH, height: CARD_HEIGHT, backgroundColor: C.ground, position: "relative",
  },
    // The tile texture of the board: a faint rule top and bottom, like the frame around a flap.
    el({ position: "absolute", left: 0, top: PASS_Y - 18, width: CARD_WIDTH, height: 2, backgroundColor: "#242930" }),
    el({ position: "absolute", left: 0, top: PASS_Y + PASS_H + 16, width: CARD_WIDTH, height: 2, backgroundColor: "#242930" }),
    el({
      position: "absolute", left: PASS_X, top: CARD_HEIGHT - 34, fontFamily: BOARD, fontWeight: 700, fontSize: 15,
      letterSpacing: 3, textTransform: "uppercase", color: "#9A9A96",
    }, "Terminal 67 · Now boarding: everyone · Destination: zero · On time"),
    pass,
  );
}

// ---------------------------------------------------------------- render

/** Renders the pass for a report. Pure: no database, no network; fonts are read once and kept. */
/** Any tree to a PNG at the given size, with the fonts this project ships. */
export async function rasterise(node: Node, width = CARD_WIDTH, height = CARD_HEIGHT): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const svg = await satori(node as unknown as Parameters<typeof satori>[0], { width, height, fonts });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  }).render().asPng();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

export async function renderCard(report: Report, nowTs: number = Math.floor(Date.now() / 1000)): Promise<Uint8Array> {
  return rasterise(tree(report, nowTs));
}
