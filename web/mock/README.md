# Mock fixtures

One JSON file per API route, each a full payload of its type in `src/types.ts`, so the front end, the templates and the card can be built and reviewed before the data modules exist. The world is Terminal 67: invented tokens (PONZI2, HOODCAT, SIRLOIN, GREENCANDLE, DUCKLING, NVIDIADOG and friends), invented wallets, no real people. The passenger is `0x3f9a…c1e4`, the pilot with 412 flights and 98% cancelled is `0x7d…b2`, the same two the brand mock uses.

| File | Route | Type |
|---|---|---|
| `report.json` | `GET /api/report/:address`, `/r/:address`, the card | `Report` |
| `board-replay.json` | `GET /api/board` (the `replay` event) | `BoardReplay` |
| `index.json` | `GET /api/index` | `Turbulence` |
| `leaderboard-rekt.json` | `GET /api/leaderboard/rekt` | `HallRow[]` |
| `leaderboard-airlines.json` | `GET /api/leaderboard/airlines` | `AirlineRow[]` |
| `token.json` | `GET /api/token/:token`, `/t/:token` | `TokenPage` |
| `desk.json` | `GET /api/desk` | `Desk` |
| `health.json` | `GET /api/health` | `Health` |

The numbers agree with each other: the passenger's worst flight is PONZI2 (−$1,940, cancelled 34 seconds after boarding), the same token `token.json` describes and the same loss that sits in the tape in `board-replay.json`; the pilot's record is the first Airlines row; the turbulence score in `index.json` is the one in the counters. Timestamps are fixed around `1789005000` (2026-09-10 01:50 UTC), so "4 min after boarding" style copy has to be computed against the fixture's own `counters.ts`, not the wall clock. `ca` is an invented address in every fixture; set it to `null` by hand to see the pre-launch state (ticker line "boarding soon · no CA yet").

## MOCK=1 on the API

`MOCK=1 npm run api` makes `src/api.ts` serve these files for every route without opening the database or the chain (`docs/api.md`, section MOCK=1). The board stream sends the replay, then a `counters` event every 5 seconds and one of the fixture's losses every 6 seconds as a live `loss` event, cycling, so the tape moves. `/api/report/0x0000000000000000000000000000000000000000` answers 404 `no flights` for the empty state. Rate limiting and error shapes are the real ones.

## ?mock=1 on the front end

Any page opened with `?mock=1` (for example `/?mock=1` or `/r/0x3f9a…?mock=1`) takes its data from `/mock/*.json` instead of `/api/*`, and replaces the SSE connection with a local simulation: the replay from `board-replay.json`, then a launch, a status flip or a loss every couple of seconds drawn from the fixture, and counters every 5 seconds. The flag is kept in `sessionStorage` while navigating, so a whole click-through works offline. Server-rendered shells (`/r`, `/t`) read the embedded `{{json}}` first; with `?mock=1` the page script fetches the fixture instead, so the shell can be opened straight from a file server with the placeholders unfilled.

## Keeping them honest

`src/types.test.ts` checks every fixture's key set against the type. When a type gains a field, the fixture gains it in the same change. Regenerate by hand or with a small script; the values are not sacred, the shapes are.
