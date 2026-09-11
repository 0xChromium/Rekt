# REKT brand

Primary direction: **E, Terminal 67**, chosen September 10, 2026. Fallback: A, Department of Rekt. Five directions were drawn before this one was picked, each with a landing mock, a share card, palette, type, mark and voice.

## Terminal 67 on one screen

The world: an airport where every flight goes to zero. Departures board = the live feed. Boarding pass = the report and the share card. Baggage claim = bags still held. Lost and found = dead tokens. Turbulence index = the daily index. Compensation desk = the fee share. Airlines = deployers. Lounge = stakers. "Terminal 67" reads as trading terminal and as the 67% who lost money.

Palette, in `tokens.css`:

| Token | Hex | Use |
|---|---|---|
| Board black | `#0F1113` | the board, the dark ground |
| Tile | `#1B1F24` | split-flap tiles, dark panels |
| Flap amber | `#F5B400` | the one accent: board text, signage strip, buttons |
| Paper white | `#F4F4F2` | boarding pass, light surfaces |
| Gate blue | `#1E4DD8` | links, arrivals |
| Cancelled red | `#E0322B` | cancelled, losses |
| Arrived green | `#3DDC84` | arrived and survivors only |
| Grey | `#9A9A96` | labels on dark |

Type, Google Fonts: Barlow Condensed 700 for the board; Barlow Semi Condensed 500 to 700 for signage and headlines; IBM Plex Mono for boarding-pass data and anything tabular. Tabular figures everywhere.

Mark: four split-flap tiles spelling REKT (`logo.svg`). Favicon: one tile with the R (`favicon.svg`). The loading state flips through the alphabet. The SVGs use live text; outline the letters before using them anywhere the font is not loaded.

Voice: deadpan airport announcements. The joke is on the trenches, never on the person. "Now boarding: everyone." "Destination: zero. On time." "Your flight was cancelled by the pilot 34 seconds after boarding." "Compensation desk open. Half of every fee, on-chain."

Rules that hold in every direction: the 67% line verbatim with the wallet count; $REKT, the short CA and rekt.report on every surface; addresses truncated as `0x3f9a…c1e4`; one accent; green only for arrivals and survivors; sound only after a click; something moves in the first frame from a visible resting state; reduced motion respected.

If the fallback is ever taken, every name below swaps and none of the mechanics do.

## Raster marks

`npm run brand` renders them from the same fonts and renderer as the boarding pass, so the mark on a
token list and the mark on a shared card are the same mark. Re-running it produces identical files.

| File | Size | For |
|---|---|---|
| `logo-512.png` | 512×512 | the launchpad page, exchanges, socials |
| `logo-1024.png` | 1024×1024 | anywhere that wants a larger avatar |
| `logo-dark-512.png` | 512×512 | the same mark on the board's dark tile, for a light background |
| `banner-1500x500.png` | 1500×500 | an X header, and wide enough for anything else |

The avatar is amber ground with a black R, the inverse of the board, because it is seen at
thirty-two pixels in a list beside a dozen other coins where a dark tile disappears. The banner
leaves its lower left empty: that is where a profile picture is laid over a header.

The link preview is not here. It is rendered live from the board at `/og.png` (`src/ogcard.ts`), so
a shared link carries what the chain did today rather than a picture from launch day.
