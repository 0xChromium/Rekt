import { C, col, el, rasterise, row, type Node } from "./card.ts";
import type { BoardRow, CountersEvent, TokenStatus } from "./types.ts";

/**
 * The picture a link to the site unfurls into: the departures board itself, with today's numbers.
 *
 * A static image would say the same thing every day. This one is rendered from the same rows the
 * board is showing and the same counters under it, so a link posted at noon carries what the chain
 * did by noon: what was lost today, how many flights were cancelled, where the index sits. Cached
 * for a few minutes by the API, because an unfurler fetches it once per link and a hundred people
 * opening the same link must not each cost a render.
 */

const MONO = "IBM Plex Mono";
const SIGN = "Barlow Semi Condensed";
const BOARD = "Barlow Condensed";

/** Board black, the site's own ground; the pass is paper, this is the terminal at night. */
const G = {
  ground: "#0F1113",
  tile: "#1B1F24",
  amber: C.amber,
  white: "#F4F4F2",
  dim: "#9A9A96",
  red: "#E0322B",
  green: "#3DDC84",
  rule: "#2A2F36",
} as const;

const STATUS_WORD: Record<TokenStatus, string> = {
  boarding: "BOARDING", arrived: "ARRIVED", departed: "DEPARTED", cancelled: "CANCELLED",
};
const STATUS_COLOUR: Record<TokenStatus, string> = {
  boarding: G.amber, arrived: G.green, departed: G.amber, cancelled: G.red,
};

const usdCompact = (n: number): string => {
  const v = Math.abs(Math.round(n));
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
};

const hhmm = (ts: number): string => {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Tickers come off the chain exactly as the deployer typed them, and this image is the one thing
 * that goes into other people's feeds rather than staying on a page they chose to open. So a line
 * whose ticker carries a slur or the strongest profanity is passed over here and the next flight
 * takes the slot. The board itself is not censored: it shows the chain as it is.
 */
const UNPRINTABLE = /(fuck|shit|cunt|nigg|f[a4]g|retard|rape|k[iy]ke|spic|tranny|whore|nazi|hitler)/i;
export const printable = (r: BoardRow): boolean => !UNPRINTABLE.test(r.symbol ?? "") && !UNPRINTABLE.test(r.name ?? "");

/** One line of the board: time, flight, token, destination, status. */
function line(r: BoardRow): Node {
  const dead = r.status === "cancelled" || r.status === "departed";
  const cell = (text: string, width: number, colour: string, weight = 700): Node =>
    el({
      width: `${width}px`, height: "44px", background: G.tile, color: colour, borderRadius: "3px",
      alignItems: "center", padding: "0 12px", fontFamily: BOARD, fontSize: "27px", fontWeight: weight,
      letterSpacing: "0.04em", overflow: "hidden",
    }, text);
  return row({ gap: "8px", marginBottom: "8px" }, [
    cell(hhmm(r.ts), 96, G.amber),
    cell(clip(r.flight, 10), 150, G.amber),
    cell(clip((r.symbol || "?").toUpperCase(), 16), 330, G.amber),
    cell(dead ? "ZERO" : "UNISWAP", 172, G.amber),
    cell(STATUS_WORD[r.status] ?? "", 200, STATUS_COLOUR[r.status] ?? G.amber),
  ]);
}

function stat(label: string, value: string, note: string, colour = G.amber): Node {
  return col({
    flex: "1", border: `1px solid ${G.rule}`, borderRadius: "3px", padding: "12px 16px", gap: "2px",
  }, [
    el({ fontFamily: MONO, fontSize: "13px", color: G.dim, letterSpacing: "0.12em" }, label.toUpperCase()),
    el({ fontFamily: BOARD, fontSize: "44px", fontWeight: 700, color: colour }, value),
    el({ fontFamily: SIGN, fontSize: "15px", color: G.white }, note),
  ]);
}

export type OgInput = {
  rows: BoardRow[];
  counters: CountersEvent;
  /** The contract address once the coin exists; the strip says so when it does not. */
  ca: string | null;
  host: string;
};

function tree(input: OgInput): Node {
  const { counters: c } = input;
  // Three taking off and two that already ended: a preview of nothing but BOARDING says nothing,
  // and the red cancellation is the line that makes somebody click.
  const fresh = input.rows.filter((r) => r.status === "boarding" && printable(r));
  const changed = input.rows.filter((r) => r.status !== "boarding" && printable(r));
  const rows = [...fresh.slice(0, 5 - Math.min(2, changed.length)), ...changed.slice(0, 2)];
  return col({
    width: "1200px", height: "630px", background: G.ground, color: G.white,
  }, [
    // The amber signage strip, the same one that runs across the top of the site.
    row({
      background: G.amber, color: "#111111", padding: "14px 40px", alignItems: "center", gap: "18px",
    }, [
      el({ fontFamily: SIGN, fontSize: "34px", fontWeight: 700, letterSpacing: "0.02em" }, "TERMINAL 67"),
      // No arrows or other ornaments: the shipped fonts have no glyph for them and satori draws a
      // tofu box rather than falling back, which is the one thing a link preview must not show.
      el({ width: "3px", height: "26px", background: "#111111", opacity: 0.35 }, ""),
      el({ fontFamily: SIGN, fontSize: "26px", fontWeight: 600 }, "DEPARTURES"),
      el({
        marginLeft: "auto", fontFamily: MONO, fontSize: "16px", background: "#111111", color: G.amber,
        padding: "8px 12px", borderRadius: "2px",
      }, input.ca ? `$REKT · ${input.ca.slice(0, 6)}…${input.ca.slice(-4)}` : "boarding soon · no CA yet"),
    ]),

    col({ padding: "26px 40px 0", flex: "1" }, [
      el({
        fontFamily: SIGN, fontSize: "46px", fontWeight: 700, lineHeight: "1.05", marginBottom: "18px",
      }, "67% of Robinhood Chain traders lost money."),

      col({ marginBottom: "20px" }, rows.map(line)),

      row({ gap: "12px", marginBottom: "22px" }, [
        stat("Lost today", usdCompact(c.lostTodayUsd), "and climbing", G.red),
        stat("Days since last cancellation", String(c.daysSinceCancelled), "rug"),
        stat("Turbulence index", String(c.turbulence.score), c.turbulence.label),
      ]),
    ]),

    row({
      borderTop: `1px solid ${G.rule}`, padding: "14px 40px", alignItems: "center",
      fontFamily: MONO, fontSize: "17px", color: G.dim,
    }, [
      el({ color: G.amber }, input.host),
      el({ marginLeft: "auto" }, "Paste a wallet. Print your boarding pass."),
    ]),
  ]);
}

/** The 1200 by 630 social card as a PNG. */
export function renderOgCard(input: OgInput): Promise<Uint8Array> {
  return rasterise(tree(input));
}
