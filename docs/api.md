# REKT API and page contract

Every route the site serves. Types are in `src/types.ts`; every JSON body below is one of them, and `web/mock/` holds a fixture for each.

One process, `rekt-api` (`npm run api`, `PORT` from `.env`, default 8787), serves everything: JSON under `/api/`, the card, the SSE board, server-rendered shells and static files. Behind Caddy in production, `PUBLIC_URL` is the origin used in OG tags.

## Conventions

- Addresses in paths are case-insensitive and must match `^0x[0-9a-fA-F]{40}$`; the API lowercases them and every address in a response is lowercase. Anything else is a 400.
- All JSON responses: `Content-Type: application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`. Numbers are numbers, wei are decimal strings, timestamps are unix seconds.
- Money in USD is already converted with the price book (`src/prices.ts`). Positions in a quote asset the book cannot price are left out of every USD figure and counted in `unpricedPositions`.
- Cached responses carry `Cache-Control: public, max-age=<seconds>` matching the server-side TTL below, and `X-Cache: hit | miss`. The cache is in memory, per process, keyed on the full path and query.
- Every non-2xx response is JSON `{ "error": string, "hint": string }` (type `ApiError`), including on HTML routes when asked with `Accept: application/json`. `error` is a short machine-ish slug in lowercase, `hint` one deadpan sentence that the page may print verbatim.

## Rate limit

240 requests per minute per IP (the first `X-Forwarded-For` value when set by Caddy, else the socket address), fixed window of 60 seconds. A request over the limit gets:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
Content-Type: application/json

{ "error": "rate limited", "hint": "240 requests a minute per passenger. Please take a seat; boarding resumes in 23 s." }
```

An SSE connection counts as one request when it opens, and one IP may hold at most `SSE_PER_IP` (5) of the `SSE_MAX` (200) seats; past either the board answers 503 `board full`. A `HEAD /api/board` gets the headers and takes no seat. A client that stops reading (256 KB unread) is disconnected and reconnects with `Last-Event-ID`. `/api/health` and `/static/*` are exempt. Every response carries `X-RateLimit-Limit: 240` and `X-RateLimit-Remaining`.

## Error shapes

| Status | `error` | When |
|---|---|---|
| 400 | `bad address` | path address does not match the pattern |
| 400 | `bad window` | `/api/leaderboard/rekt?window=` is not `24h` or `all` |
| 404 | `no flights` | the wallet has no position in the folded window |
| 404 | `unknown token` | the token is not in `launches` |
| 404 | `not found` | any other path |
| 429 | `rate limited` | see above |
| 500 | `internal` | anything thrown; the hint is fixed, the stack goes to the log |
| 503 | `not ready` | the database has no fold cursor yet, or a module is still the stub (`not implemented`) |
| 503 | `busy` | `/card/:address.png` only: too many passes are waiting for the printer; `Retry-After: 5` |

Hints, verbatim, so every surface says the same thing:

- `bad address`: "That is not an address. Passenger addresses look like 0x followed by 40 hex characters."
- `no flights`: "No flights on record for this passenger since <date>. Either you never boarded, or you boarded before our records begin." (`<date>` is "September 3" style, month name and day, UTC)
- `unknown token`: "No flight by that number. The token was not launched on Pons v2, or not within our records."
- `not found`: "This gate does not exist."
- `internal`: "Something went wrong at the desk. Try again in a minute."
- `not ready`: "The board is warming up. First flights appear once the fold has a cursor."

## JSON routes

| Route | Type | Cache | Module |
|---|---|---|---|
| `GET /api/report/:address` | `Report` | 300 s per address | `report.buildReport` |
| `GET /api/board` | SSE, see below | none | `board.readEvents`, `board.recentBoard` |
| `GET /api/index` | `Turbulence` | 60 s | `turbulence.turbulence` |
| `GET /api/leaderboard/rekt?window=24h\|all` | `HallRow[]` | 60 s | `leaderboards.hallOfRekt(db, window, 10)` |
| `GET /api/leaderboard/airlines` | `AirlineRow[]` | 60 s | `leaderboards.airlines(db, 10)` |
| `GET /api/token/:token` | `TokenPage` | 300 s per token | `tokenpage.tokenPage` |
| `GET /api/desk` | `Desk` | 60 s | `desk.deskData` |
| `GET /api/health` | `Health` | none, `Cache-Control: no-store` | api.ts from `meta` |

`window` defaults to `24h`. Leaderboards return at most 10 rows; fewer when there are fewer. An empty leaderboard is `[]`, never an error.

`GET /api/health` is computed in api.ts without touching the chain: `foldCursor` = `meta.fold_to_block`, `latestBlock` = `meta.live_head_block`, `watcherAgeSeconds` = now − `meta.live_seen_at`, `lagBlocks` = latestBlock − foldCursor, `lagSeconds` = lagBlocks / `BLOCKS_PER_SECOND`, `ok` = lagSeconds < 120 and watcherAgeSeconds < 120. Before the watcher has ever run, `latestBlock` and `watcherAgeSeconds` are null, `lagBlocks` and `lagSeconds` are 0 and `ok` is false. Always 200, even when `ok` is false; the process being up is the point.

## The card

`GET /card/:address.png`: the boarding pass, `image/png`, 1200 by 630, from `card.renderCard(report)` on a worker thread (one pass at a time; the same address is rendered once however many ask). Cached on disk at `data/cards/<address>.png`, fresh for an hour by the file's mtime and pruned by the API on a timer, `Cache-Control: public, max-age=3600`. 404 `no flights` when the report is null; 503 `busy` with `Retry-After: 5` when more than `CARD_QUEUE` (16) passes are already waiting. `?download=1` adds `Content-Disposition: attachment; filename="rekt-boarding-pass-0x3f9a…c1e4.png"` (the truncated address).


A note on the money, because two counts on the page answer for it. `unpricedPositions` is positions whose quote asset has no dollar price; they are left out of every dollar figure rather than counted as zero. `outsideRecordPositions` is positions sold beyond what the record saw bought, which is 24% of them in a ten-hour window: the purchase is older than the fold, so `realized` claims neither profit nor loss on those units. Before that rule, a wallet selling an airdrop booked the whole sale as profit and led the ranking with hundreds of thousands of dollars that never existed.

`GET /og.png`: the link preview, `image/png`, 1200 by 630, rendered from the current board and its counters (`src/ogcard.ts`) and cached five minutes in memory. Every page that is not a report unfurls into it, so it carries what the chain did today rather than a fixed picture. The static pages are written with `https://rekt.report` in their `og:` tags because a file opened from disk needs somewhere to point; the API rewrites that origin to `PUBLIC_URL` as it serves them, so a preview fetched from any host asks that host for the image.

## The board, `GET /api/board`

Server-Sent Events. Headers `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Every message is:

```
id: <seq>
event: <name>
data: <one line of JSON>

```

`event` is the `kind` of the `BoardEvent` (`launch`, `status`, `graduate`, `loss`, `counters`), or `replay` once on connect. `data` is the event object itself, including its `kind`. `id` is the `board_events.seq` of the row, so the browser's automatic reconnect sends `Last-Event-ID`; `?since=<seq>` does the same by hand. Counters and the replay carry the current seq as `id`.

Sequence on connect:

1. `event: replay`, `data: BoardReplay` (12 board rows: the 8 newest launches, then the 4 tokens whose status changed most recently; last 20 losses newest first, current counters, the CA, the cursor). When `since` or `Last-Event-ID` is present the replay still comes (it is cheap and the client rerenders from it), then the events after that seq.
2. Live events as `board.readEvents(db, seq)` returns them; api.ts polls every 500 ms and fans out to every connection.
3. `event: counters` every 5 seconds, with `data: CountersEvent`, whether anything changed or not. This is also the keepalive; no comment lines are needed.

The board is two lanes, because the chain launches a token every three or four seconds and every launch is boarding: a board of the newest twelve says BOARDING twelve times and never flips a status, since a token needs ten minutes of silence or a 90% fall to change and by then it is thousands of lines down. So the top 8 slots are the newest launches and the bottom 4 (`BOARD_CHANGED`) are the tokens whose status changed most recently, separated by a hairline. The changes lane takes more than 4 only when there are too few launches to fill the board.

The client treats the stream as: a `launch` inserts a row at the top of the launches lane and drops the last one; `status` and `graduate` move that token into the changes lane, whether or not it was on the board (`graduate` means status `arrived`); `loss` prepends a line to the passenger tape and keeps 20; `counters` repaints the three panels. Because a token usually dies long after its launch line scrolled off, `StatusEvent` and `GraduateEvent` carry the rest of the row as well: `flight`, `pair`, `pairSymbol` and `launchTs` (the launch time, for the Time cell).

Board rows in copy: time is the launch `ts` as HH:MM UTC, flight is `flight`, token is `symbol`, destination is where the flight was scheduled to land, `UNISWAP`, and becomes `ZERO` once the status is `cancelled` or `departed`, gate is `pairSymbol`, status is the status word capitalised.

## HTML routes

Server-rendered shells so X unfurls the card. api.ts reads the template file, fills the placeholders, and sends `text/html; charset=utf-8`.

| Route | Template | Data | Cache |
|---|---|---|---|
| `GET /r/:address` | `web/templates/report.html` | `Report` | 300 s |
| `GET /t/:token` | `web/templates/token.html` | `TokenPage` | 300 s |
| `GET /roadmap` | `web/templates/roadmap.html` | rendered `ROADMAP.md` | rendered once at process start |

When the report or token page is null the shell is still rendered, with status 404 and `{{json}}` set to the `ApiError` object; the page script checks for `error` first. The OG image of an error shell is `/og.png`.

Static pages, served as files from `web/` with `Cache-Control: public, max-age=60`:

| Route | File |
|---|---|
| `GET /` | `web/index.html` (landing: board, counters, input, ticker, Hall of Rekt, Airlines, how it works, the promise) |
| `GET /hall` | `web/hall.html` (Hall of Rekt, 24h and all-time) |
| `GET /airlines` | `web/airlines.html` |
| `GET /desk` | `web/desk.html` (the only page with wallet code) |
| `GET /turbulence` | `web/turbulence.html` (the index and its method) |
| `GET /about` | `web/about.html` (how it works, disclaimers, the 67% line) |
| `GET /leaderboards` | `web/leaderboards.html` (Hall of Rekt and Airlines on one page) |
| `GET /<page>.html` | the same files by name (`/desk.html`, `/leaderboards.html`, ...), except `/index.html`; the links the front end uses on a plain file server keep working |
| `GET /static/*` | `web/static/*` (css, js, fonts, images), `max-age=86400` |
| `GET /mock/*` | `web/mock/*` (fixtures, always served, see below) |

Anything else under `web/` (including `web/templates/`) is not routed. `.html` files under `web/` are plain static files; they get the CA and the counters from the board stream (`BoardReplay.ca`) or `/api/desk`, never from server-side substitution.

## Template contract

`web/templates/report.html`, `web/templates/token.html` and `web/templates/roadmap.html` are complete HTML documents owned by the web builder. api.ts replaces these placeholders and nothing else; a placeholder may appear more than once; unknown `{{...}}` strings are left as they are.

| Placeholder | Filled with | HTML-escaped |
|---|---|---|
| `{{title}}` | page title, e.g. `0x3f9a…c1e4 · Boarding pass · REKT` or `PONZI2 · Lost and found · REKT` | yes |
| `{{description}}` | one line, e.g. `Net −$4,212 on Pons. Rug Magnet, gate 290,141 of 314,736. Worst flight PONZI2, cancelled by the pilot.` | yes |
| `{{ogImage}}` | absolute URL of the PNG, `<PUBLIC_URL>/card/<address>.png` (report), `<PUBLIC_URL>/og.png` (token, roadmap, errors) | yes |
| `{{url}}` | canonical absolute URL of the page | yes |
| `{{json}}` | the payload as JSON, placed by the template inside `<script id="data" type="application/json">{{json}}</script>`; every `<` is written as `\u003c` so the script cannot be closed early | see left |
| `{{content}}` | roadmap only: the HTML fragment from `roadmap.renderRoadmap` | no, it is HTML |

The page script reads its data with `JSON.parse(document.getElementById("data").textContent)`.

`renderRoadmap` output, for the stylesheet: `<ol class="roadmap">` of `<li class="item status-<planned|in-progress|live|dropped>" id="item-<n>">` each with `<h2><span class="n">0</span> On-chain split <span class="pill">in progress</span></h2>`, optional `<p class="note">` lines, a `<ul class="tasks">` with `<li class="done|todo">`, and `<p class="done-when">`. Live items add `<time>` inside the pill with the date from the status line; dropped items put the reason in the pill's `title`. The paragraph about what the coin buys (SPEC 3.7) is part of the template, not of the fragment.

## MOCK=1

`MOCK=1 npm run api` serves the fixtures in `web/mock/` for every route and touches neither the database nor the chain. Builders of the front end, the templates and the card use it before the data modules exist.

| Route | Fixture |
|---|---|
| `/api/report/:address`, `/r/:address` | `report.json` (the address in the path is ignored; the fixture's own address is returned) |
| `/card/:address.png` | rendered from `report.json` with the real `renderCard`; 503 while card.ts is the stub |
| `/api/board` | `replay` from `board-replay.json`, then every 5 s a `counters` event copied from the fixture with `ts` = now, and every 6 s one of the fixture's `losses` re-emitted as a live `loss` event with `ts` = now, cycling, so the tape moves |
| `/api/index` | `index.json` |
| `/api/leaderboard/rekt` | `leaderboard-rekt.json` (both windows) |
| `/api/leaderboard/airlines` | `leaderboard-airlines.json` |
| `/api/token/:token`, `/t/:token` | `token.json` |
| `/api/desk` | `desk.json` |
| `/api/health` | `health.json` |
| `/roadmap` | the real `ROADMAP.md` through `renderRoadmap` |

Every fixture is a full payload of its type, so the same files drive the front end's `?mock=1` mode (`web/mock/README.md`). Rate limiting and error routes behave the same in mock mode; `/api/report/0x` followed by 40 zeros returns 404 `no flights` so the empty state can be built.
