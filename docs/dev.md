# Running REKT locally

Node 22.13 or later (node:sqlite and type stripping; the files run as `node --no-warnings src/x.ts`, no build step). One `npm install` for viem, satori and resvg. Every command runs from the repository root.

## The short version

```sh
npm install
cp .env.example .env            # defaults are fine for local work
npm run doctor                  # both RPCs, chain id, factory getters, the database
npm run backfill -- --hours 24  # launches of the last day, enriched (name, symbol, launch_sender)
npm run fold -- --hours 24 --once   # trades of the last day folded into positions, losses and token statuses applied; a few minutes
npm run pools -- --init --since-v2  # the Uniswap pools tokens graduate into, from the Pons v2 start; minutes
npm run pools -- --hours 24 --once  # pool swaps of the last day folded into the same positions
npm run watch                   # the live process: factory, curve fold, pool fold, token state, losses
npm run api                     # http://localhost:8787
```

Two streams feed the same positions: the Pons curve (`fold`) and the Uniswap pools tokens graduate into (`pools`). Measured on 11 September 2026, a five-minute window held 2,607 curve trades against 6,147 pool swaps, so a database with curve trades alone holds under a third of the chain's trading and shows an empty report to anybody who trades the tokens that made it. Run `pools --init` once before the first pool fold, and note that the trader of a pool swap is the transaction's sender, or, when the transaction went to an ERC-4337 EntryPoint, the account behind the operation; the `sender` in the event itself is a router.

`backfill` and `fold` first, `watch` next, `api` last; the API answers 503 `not ready` for data routes until the fold has a cursor (`meta.fold_to_block`), and `/api/health` says `ok: false` until the watcher has written a heartbeat. Keep `fold --once` and `watch` from running at the same time: both move the cursor. A `fold` window that overlaps what is already folded (`meta.fold_from_block`..`fold_to_block`) is trimmed to the parts outside it, so a rerun never counts a trade twice; the CLI prints the range it skipped. A window apart from the folded range is refused (the blocks between would never be folded). A backward extension keeps its own cursor (`fold_back_from`, `fold_back_to`) and only moves `fold_from_block` once it reaches the old start, so an interrupted one is finished by the next run.

Windows: one to three hours are plenty to see the product work, a day is a realistic demo, seven days (`--hours 168`) is production and takes one to two hours on the official RPC. `LOGS_SPACING_MS=400` in `.env` is the gap between `eth_getLogs` calls; the official endpoint answers 403 for a while when it is lowered.

## The demo without data

```sh
MOCK=1 npm run api
```

Every route serves the fixtures in `web/mock/` (`docs/api.md`, section MOCK=1): the report, the token page, the leaderboards, the desk, health, the board replay followed by a `counters` event every 5 seconds and a fixture loss every 6 seconds so the tape moves. The database and the chain are never touched. `/api/report/0x0000000000000000000000000000000000000000` is the empty state (404 `no flights`), `/card/<address>.png` renders the fixture through the real card renderer. The front end has its own `?mock=1` that needs no server at all (`web/mock/README.md`).

## Where things live

| Path | What |
|---|---|
| `data/rekt.db` (+ `-wal`, `-shm`) | the database, `DB_PATH` in `.env`; WAL, so the API reads while the watcher writes |
| `data/cards/<address>.png` | the boarding pass cache, one file per address, fresh for an hour by mtime, pruned by the API; safe to delete |
| `data/prices.json` | the price book override, rewritten by `refreshPrices()`; the shipped snapshot in `src/prices.ts` is the floor |
| `data/snapshots/` | nightly `VACUUM INTO` copies in production (`deploy/snapshot.sh`) |
| `meta` table | cursors and the watcher heartbeat: `backfill_from_block`, `backfill_to_block`, `fold_from_block`, `fold_to_block`, `fold_back_from`, `fold_back_to` (a backward `fold --from` in progress), `pool_init_to_block` (how far the pool sweep has read `Initialize`), `pool_from_block`, `pool_to_block`, `pool_back_from`, `pool_back_to`, `live_cursor_block`, `live_head_block`, `live_seen_at` |
| `board_events` table | the channel between the watcher and the API's SSE stream; pruned to 24 h by the watcher |

In-memory caches in the API process: report and token page 5 minutes per address, index, leaderboards and desk 60 seconds, the rank snapshot rebuilt hourly, the roadmap rendered once at start (`ROADMAP.md` changes need a restart). Every JSON response says `X-Cache: hit | miss`.

## Environment

`.env` is read by `src/chain/config.ts` on start; values already in the environment win, so `PORT=9000 npm run api` works.

| Key | Local default | Notes |
|---|---|---|
| `RPC_LOGS_URL` | official RPC | the only public `eth_getLogs`; rate limited |
| `RPC_STATE_URL`, `RPC_WS_URL` | publicnode | state reads and `newHeads`; refuses `eth_getLogs` |
| `PORT` | 8787 | the API |
| `HOST` | 127.0.0.1 | bind address of the API; `0.0.0.0` to reach it from another machine |
| `PUBLIC_URL` | http://localhost:8787 | origin used in OG tags and canonical URLs |
| `REKT_TOKEN` | empty | the CA; empty means "boarding soon" everywhere |
| `FEE_WALLET`, `SPLITTER`, `STAKING` | empty | the desk's recipient and contracts |
| `MOCK` | unset | `1` serves fixtures |
| `WEB_DIR`, `CARDS_DIR` | `web`, `data/cards` | override for tests and odd layouts |
| `RATE_LIMIT`, `SSE_MAX` | 240, 200 | requests per minute per IP; open board streams |
| `SSE_PER_IP`, `CARD_QUEUE` | 5, 16 | open board streams one IP may hold; passes waiting for the printer before the card answers 503 `busy` |

## Tests

```sh
npm test                                   # everything under src/**/*.test.ts
node --no-warnings --test src/api.test.ts  # one file
```

`src/api.test.ts` starts the server in mock mode on a random port with a throwaway `web/` directory, so it passes whatever state the real pages are in. The fold tests use a temporary database. Nothing in the test suite touches the chain.

## Useful checks

```sh
curl -s localhost:8787/api/health
curl -s -N localhost:8787/api/board | head -c 2000        # the replay, then live events
curl -s localhost:8787/api/report/<address> | head -c 600
open http://localhost:8787/r/<address>                     # the shell with OG tags; the card at /card/<address>.png
```

Endpoint checks and the factory constants: `npm run doctor`. Fallback name lookups for launches the enrichment could not decode: `npm run names`. A single card to a file: `npm run card` (the fixture, to `out/card-sample.png`) or `npm run card -- <address> --out pass.png` (a real wallet through `buildReport`).
## Who came and what they used

```bash
npm run stats                # the last 14 days
npm run stats -- --days 30
npm run stats -- --json
```

The API counts every finished request into three tables in the same database (`hits`, `visits`,
`lookups`), flushed every 15 seconds. A visitor is a SHA-256 of the day's random salt, the IP and
the user agent, truncated to 16 characters; the salt is regenerated daily and the previous one
deleted, so a hash cannot follow anybody from one day to the next and no address is ever stored.
Paths lose their moving parts before counting, so `/r/0x3f9a…` is `report` and `/card/0x3f9a….png`
is `pass`. Crawlers, judged by user agent, and any response of 400 or worse are counted apart and
left out of the totals. Wallet lookups are kept in full, since an address is public data and "how
many different wallets were checked" is the number worth having.

Two caveats worth saying out loud: a scanner that sends a browser's user agent counts as a person,
and a person on two devices counts twice.

