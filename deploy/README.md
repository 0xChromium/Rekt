# Deploying rekt.report

One Hetzner CX22 (2 vCPU, 4 GB, 40 GB, Ubuntu 24.04), Caddy for TLS, two long-running systemd units (`rekt-api`, `rekt-watch`), one oneshot (`rekt-fold`) and a nightly snapshot timer. Everything below runs as the `rekt` user from `/home/rekt/rekt`; the fee wallet key never touches this machine (the VPS reads, never signs).

Order matters: the fold takes one to two hours, so start it in the first hour of the day and do the rest while it runs.

## 1. Machine

Hetzner Cloud, CX22, Ubuntu 24.04, Falkenstein or Nuremberg (near the sequencer's peers is not a concern; the RPCs are what we wait on). Add your SSH key at creation, no password login. Point DNS at it before step 6: `A rekt.report -> <ip>` and `A www.rekt.report -> <ip>`. Check with `dig +short rekt.report`.

Without a domain yet, `rekt.<ip>.nip.io` resolves to the address on its own and Caddy takes a real
certificate for it, so the site is live over HTTPS the same day; swapping in the domain later is one
line in the Caddyfile and one in `.env`.

Disk: the database was 262 MB after 25 hours of curve trades and 13 hours of pool swaps, and
positions are most of it. At that rate 40 GB is four to five months, which is when roadmap item 12
(retention) stops being optional.

```sh
ssh root@<ip>
apt update && apt upgrade -y
apt install -y ufw git curl ca-certificates
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
adduser --disabled-password --gecos "" rekt
install -d -m 700 -o rekt -g rekt /home/rekt/.ssh
cp /root/.ssh/authorized_keys /home/rekt/.ssh/ && chown rekt:rekt /home/rekt/.ssh/authorized_keys && chmod 600 /home/rekt/.ssh/authorized_keys
usermod -aG sudo rekt
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

From here on, `ssh rekt@<ip>`.

## 2. Node 22 and Caddy

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.13 or later: node:sqlite and type stripping are needed

sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 3. The repository and .env

The repository is private, so the server has no way to clone it. Push the working tree from the
dev box instead, and carry the database with it: a copy takes a couple of minutes, while rebuilding
it on the server takes over an hour of RPC reads.

```sh
# [locally] the code, without node_modules, the local .env or the working database
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '.env' --exclude 'data/*.db*' \
  --exclude 'data/cards' --exclude 'data/logs' --exclude out \
  ~/projects/rh_product2/ rekt@<ip>:~/rekt/

# [locally] a consistent copy of the database, taken while the watcher keeps writing
sqlite3 ~/projects/rh_product2/data/rekt.db "VACUUM INTO '/tmp/rekt-deploy.db'"
scp /tmp/rekt-deploy.db rekt@<ip>:~/rekt/data/rekt.db
```

```sh
# [server]
cd ~/rekt && npm ci --omit=dev && cp .env.example .env
```

Edit `.env`:

| Key | Production value |
|---|---|
| `PORT` | `8787` (Caddy proxies to it; the unit sets `HOST=127.0.0.1` so nothing listens publicly) |
| `PUBLIC_URL` | `https://rekt.report` (OG image URLs are built from it) |
| `DB_PATH` | `data/rekt.db` |
| `LOGS_SPACING_MS` | `400` (the official RPC's tolerance; lower it and you get 403s) |
| `REKT_TOKEN` | empty until the launcher gives us the CA (launch sequence step 3) |
| `FEE_WALLET` | the fresh EOA the launch names as creator fee recipient |
| `SPLITTER`, `STAKING` | empty until roadmap item 0 ships |
| `DEV` | `0` in production: static files are cached for a day rather than a minute |

Then `npm run doctor`: every check must say ok (both RPCs, chain id 4663, the factory getters, the database opening).

## 4. Data: backfill and the seven-day fold

Install the units first so the fold runs under systemd and survives your SSH session:

```sh
sudo cp deploy/rekt-api.service deploy/rekt-watch.service deploy/rekt-fold.service deploy/rekt-snapshot.service deploy/rekt-snapshot.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start rekt-fold          # launches (minutes), then fold --hours 168 --once (one to two hours)
journalctl -u rekt-fold -f              # watch the chunks go by; Ctrl-C leaves it running
```

`rekt-fold` conflicts with `rekt-watch` on purpose: both move `meta.fold_to_block`. Do not start the watcher until `systemctl status rekt-fold` says `inactive (dead)` with `status=0`.

If you carried the database over from the dev box, none of this is needed: it already holds the
launches, the pools and the folded window, and the watcher picks up from its cursors. Run the pool
sweep once so pools that graduated since the copy are known, and let the watcher do the rest:

```sh
npm run pools -- --init            # Initialize logs since the last sweep; minutes
```

Both streams matter. Curve trades are under a third of the chain's trading: measured on 11
September 2026, a five-minute window held 2,607 curve trades against 6,147 pool swaps. A server
running only the curve fold shows an empty report to anybody who trades the tokens that graduated.

## Filling the history backwards

The record is only as deep as what has been folded, and a visitor whose flights are older than it
reads an empty page as a broken one. `deploy/backfill-back.sh` walks backwards in slices, newest
first, so every slice that lands answers for one more stretch of the chain:

```sh
sudo cp deploy/rekt-backfill.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now rekt-backfill      # pools, then curve, then it stops for good
journalctl -u rekt-backfill -f                  # or tail data/logs/backfill.log
```

It survives a reboot, resumes from its cursors after a crash, and goes inactive when both streams
reach 4 August. `curl -s https://rekt.report/api/health` reports the depth in `records`. Run it
alone: two folds and the watcher writing to one SQLite file contend for the write lock, and before
the busy timeout was raised the loser died with `database is locked`.

Measured on the CX23 with the watcher running: a twelve-hour slice of pool swaps takes about
nineteen minutes, so the full stretch back to 4 August is roughly a day; curve trades are about
twice as quick per hour of chain because the trader is in the event and needs no transaction
lookup. Run one at a time: both read the logs endpoint, which is the thing being waited on.

## 5. Services

```sh
sudo systemctl enable --now rekt-watch
sudo systemctl enable --now rekt-api
sudo systemctl enable --now rekt-snapshot.timer
curl -s localhost:8787/api/health       # ok true once the watcher has caught up (lag under 120 s)
```

Logs: `journalctl -u rekt-api -f` (one line per request) and `journalctl -u rekt-watch -f`.

## 6. Caddy

```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -sI https://rekt.report/api/health | head -1
```

Caddy fetches the certificate on the first request. `/api/board` is proxied without buffering so the SSE stream flows; Caddy sets `X-Forwarded-For`, which the API's rate limit reads.

## 7. Launch day

When the CA arrives: set `REKT_TOKEN=<CA>` in `.env`, `sudo systemctl restart rekt-api`. The ticker line, the desk and every `ca` field flip on the next request. Nothing else restarts; the watcher already sees the launch. When the splitter and staking contracts ship: `SPLITTER=`, `STAKING=`, restart `rekt-api`, and change the `Status:` line of item 0 in `ROADMAP.md` (the roadmap page is rendered at process start).

## 8. Updating

```sh
# [locally] same rsync as step 3, without the database
rsync -az --delete --exclude node_modules --exclude .git --exclude '.env' \
  --exclude 'data/*.db*' --exclude 'data/cards' --exclude 'data/logs' --exclude out \
  ~/projects/rh_product2/ rekt@<ip>:~/rekt/

# [server]
cd ~/rekt && npm ci --omit=dev
sudo systemctl restart rekt-api         # a few seconds; SSE clients reconnect on their own
sudo systemctl restart rekt-watch       # only when watch.ts or its imports changed; it resumes from the cursor
```

## 9. Restoring from a snapshot

`data/snapshots/rekt-YYYYMMDD.db`, seven kept, written at 03:30 UTC by `rekt-snapshot.timer` with `VACUUM INTO` (consistent while the watcher writes). To restore: stop both services, copy the snapshot over `data/rekt.db`, delete `data/rekt.db-wal` and `data/rekt.db-shm`, start the watcher (it folds forward from the snapshot's cursor), then the API.

## What to watch

- `/api/health`: `ok` false means lag over 120 s or the watcher silent for 120 s; the site shows the banner (yellow from 30 s, red from 120 s).
- `journalctl -u rekt-watch` for `403` from the official RPC: it is cooling off after a long sweep; the retry backs off on its own. Sustained 403s mean `LOGS_SPACING_MS` is too low.
- Disk: `data/cards` holds one PNG per address that asked for a pass in the last hour; the API deletes older files itself every ten minutes.
