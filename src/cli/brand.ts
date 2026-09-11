import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { col, el, rasterise, row, type Node } from "../card.ts";

/**
 * rekt brand — the raster marks, rendered rather than drawn by hand.
 *
 *   npm run brand
 *
 * The launchpad page, the exchanges that list a coin and every social profile want a square PNG and
 * a wide banner, and none of them take the SVG in brand/. They come out of the same satori and the
 * same three fonts as the boarding pass and the link preview, so the mark on a token list and the
 * mark on a shared card are the same mark. Re-run it and the files are identical; nothing here
 * reads the chain or the clock.
 *
 * The avatar is amber on black rather than the board's black on amber. It is seen at 32 pixels in a
 * token list beside a dozen others, where a dark tile disappears and a solid amber one does not.
 */

const AMBER = "#F5B400";
const BLACK = "#0F1113";
const TILE = "#1B1F24";
const WHITE = "#F4F4F2";
const DIM = "#9A9A96";
const RED = "#E0322B";
const GREEN = "#3DDC84";
const BOARD = "Barlow Condensed";
const SIGN = "Barlow Semi Condensed";
const MONO = "IBM Plex Mono";

/** The seam a split-flap tile shows across its middle, at the given size. */
const seam = (thickness: number, colour = "rgba(0,0,0,0.55)"): Node =>
  el({ position: "absolute", left: "0", right: "0", top: "50%", height: `${thickness}px`, background: colour }, "");

/**
 * The avatar: one flap tile carrying the R. Amber ground for the list, dark ground for a light
 * page. `size` is the whole square; everything inside is a fraction of it, so 512 and 1024 are the
 * same picture.
 */
function avatar(size: number, dark: boolean): Node {
  const ground = dark ? TILE : AMBER;
  const ink = dark ? AMBER : "#111111";
  return el({
    width: `${size}px`, height: `${size}px`, background: dark ? BLACK : "#111111",
    alignItems: "center", justifyContent: "center",
  },
    el({
      width: `${size * 0.86}px`, height: `${size * 0.86}px`, background: ground, borderRadius: `${size * 0.09}px`,
      alignItems: "center", justifyContent: "center", position: "relative",
    }, [
      el({
        fontFamily: BOARD, fontWeight: 800, fontSize: `${size * 0.72}px`, color: ink,
        lineHeight: "1", marginTop: `${-size * 0.03}px`,
      }, "R"),
      seam(Math.max(2, Math.round(size * 0.012)), dark ? "rgba(0,0,0,0.75)" : "rgba(0,0,0,0.55)"),
    ]),
  );
}

/** A board line for the banner: the tiles, at banner scale. */
function line(time: string, flight: string, token: string, dest: string, status: string, colour: string): Node {
  const cell = (text: string, width: number, c: string): Node =>
    el({
      width: `${width}px`, height: "40px", background: TILE, color: c, borderRadius: "3px",
      alignItems: "center", padding: "0 10px", fontFamily: BOARD, fontSize: "24px", fontWeight: 700,
      letterSpacing: "0.04em", overflow: "hidden",
      // No seam on these: at this size the line crosses the letters and reads as a strikethrough.
      // The flap seam belongs on the avatar, where the tile is large enough for it to be a seam.
    }, text);
  return row({ gap: "6px", marginBottom: "6px" }, [
    cell(time, 78, AMBER), cell(flight, 118, AMBER), cell(token, 190, AMBER),
    cell(dest, 130, AMBER), cell(status, 160, colour),
  ]);
}

/**
 * The wide banner, 1500 by 500 — the size X wants for a header, and wide enough for anywhere else.
 * The lower left stays empty on purpose: that is where a profile picture is laid over the header.
 */
function banner(): Node {
  return col({ width: "1500px", height: "500px", background: BLACK }, [
    row({ background: AMBER, color: "#111111", padding: "12px 44px", alignItems: "center", gap: "16px" }, [
      el({ fontFamily: SIGN, fontSize: "30px", fontWeight: 700, letterSpacing: "0.02em" }, "TERMINAL 67"),
      el({ width: "3px", height: "24px", background: "#111111", opacity: 0.35 }, ""),
      el({ fontFamily: SIGN, fontSize: "23px", fontWeight: 600 }, "DEPARTURES"),
      el({ marginLeft: "auto", fontFamily: MONO, fontSize: "15px" }, "REKT · ROBINHOOD CHAIN · ALL FLIGHTS TO ZERO"),
    ]),
    // Centred in what is left under the strip, so the banner does not sit top-heavy over a void.
    row({ flex: "1", padding: "0 44px", alignItems: "center" }, [
      col({ flex: "1", paddingRight: "28px" }, [
        el({ fontFamily: SIGN, fontSize: "50px", fontWeight: 700, color: WHITE, lineHeight: "1.04" },
          "67% of Robinhood Chain"),
        el({ fontFamily: SIGN, fontSize: "50px", fontWeight: 700, color: WHITE, lineHeight: "1.04" },
          "traders lost money."),
        el({ fontFamily: SIGN, fontSize: "22px", color: DIM, marginTop: "14px" },
          "Paste a wallet. Print your boarding pass."),
      ]),
      col({ paddingTop: "4px" }, [
        line("04:12", "RK-2041", "PONZI2", "ZERO", "CANCELLED", RED),
        line("04:13", "RK-2043", "NVIDIADOG", "UNISWAP", "ARRIVED", GREEN),
        line("04:14", "RK-2046", "DUCKLING", "ZERO", "DEPARTED", AMBER),
        line("04:15", "RK-2048", "SIRLOIN", "UNISWAP", "BOARDING", AMBER),
      ]),
    ]),
    row({ padding: "0 44px 20px", alignItems: "center" }, [
      // Left of this line is where a profile picture sits, so nothing but the address goes here.
      el({ marginLeft: "auto", fontFamily: MONO, fontSize: "17px", color: AMBER }, "rekt.report"),
    ]),
  ]);
}

const OUT = join(import.meta.dirname, "..", "..", "brand");
mkdirSync(OUT, { recursive: true });

const files: Array<[string, Node, number, number]> = [
  ["logo-512.png", avatar(512, false), 512, 512],
  ["logo-1024.png", avatar(1024, false), 1024, 1024],
  ["logo-dark-512.png", avatar(512, true), 512, 512],
  ["banner-1500x500.png", banner(), 1500, 500],
];

for (const [name, node, w, h] of files) {
  const png = await rasterise(node, w, h);
  writeFileSync(join(OUT, name), png);
  console.log(`  ${name.padEnd(22)} ${w}×${h}  ${(png.length / 1024).toFixed(0)} KB`);
}
console.log(`\nwritten to ${OUT}`);
