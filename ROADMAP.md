# REKT roadmap

Everything that comes after day one, in the order it should be built. Each item says what it needs and when it counts as done.

This file is also the source of the public page at rekt.report/roadmap: every section except Operations is rendered there with its `Status` line, so a status changes on the site only when it changes here. Statuses: planned, in progress, live (with the date), dropped (with the reason). Update the boxes and the status line as things ship.

## 0. On-chain split
Status: in progress
Only if the contracts did not ship on day one.
- [ ] `FeeSplitter` v2 with permissionless `harvest()` (calls `claim()` and `claimToken(asset)` on the escrow), shares holders 5,000 / team 5,000 / buyback 0
- [ ] `RektStaking`: StakingRewards, WETH rewards, permissionless `notify()`, no owner
- [ ] Foundry fork tests: credit → transfer recipient → harvest → split → stake → claim; a stranger cannot move anything
- [ ] Deploy, verify on Blockscout, addresses on the desk page, `transferCreatorFeeRecipient(REKT, splitter)` from the fee wallet
- [ ] First `harvest()` after the switch, announced with the tx. What accrued before the switch is the team's and pays for the build; the desk page says so and shows $0 owed to holders until then
Needs: the fee wallet key holder for one transaction. Effort: about five hours. Done when: the desk page shows a live reward stream and the ledger has its first row. The work is in the [repository](https://github.com/0xChromium/Rekt).
Fallback past day 7: airdrop script from the fee wallet (`cli/airdrop.ts`), ledger published, hot key retired the day the contracts land.

## 1. History to August 4
Status: planned
- [ ] Extend `fold` from the seven-day window back to the Pons v2 launch block (August 4, 2026)
- [ ] Hourly rank snapshot over the full window; the report's "since" line widens on its own
Needs: about eight hours of background reads on publicnode, nothing else. Done when: the fold cursor reaches the factory's first v2 block and the health endpoint says so.

## 2. Lost and found
Status: planned
- [ ] `deaths` table: token, died_ts, cause (never traded, no fifth buyer, cancelled, departed, graduated then down 85%)
- [ ] Token page `/t/<token>` with the tombstone: born, died, lifespan, peak, cause, wallets that lost here, biggest single loss, the airline's record
- [ ] "A token dies every N seconds" counter on the landing; obituaries list (latest deaths)
- [ ] Tombstone card variant for sharing
Needs: item 1 for full history (works on the seven-day window before that). Done when: any token address opens a page and the counter ticks.

## 3. Exit-liquidity replay
Status: planned
- [ ] For the worst flight: fetch that curve's trades on demand (the `chain/curve.ts` `indexCurve` path), draw the price path, mark the visitor's buys and sells and the deployer's sells
- [ ] Caption in words: "You boarded 04:12:07. The pilot left 04:12:41."
- [ ] Card variant
Needs: nothing beyond day one. Done when: the report shows the replay for any wallet with a losing position.

## 4. Versus
Status: planned
- [ ] `/vs/<a>/<b>`: two passes side by side, who is more rekt, one shared card
- [ ] Prefilled text tagging the other person
Done when: a versus link unfurls on X with the shared card.

## 5. Lounge
Status: planned
- [ ] X-handle linking by signed message; handle shown on the leaderboards and the pass
- [ ] Epitaph on your worst flight's tombstone, for stakers (balance check in `RektStaking`)
- [ ] Lounge badge on the pass for stakers
Needs: item 0 for the staker checks. Done when: a linked handle appears on the Hall of Rekt.

## 6. Post-graduation flights
Status: in progress
Moved to the front on 11 September: measured on the live chain, a five-minute window held 2,607 curve trades against 6,147 Uniswap v4 pool swaps, so 70% of the chain's trading happens after graduation. A wallet that trades only graduated tokens got an empty report, which is the product's one job.
- [ ] Index Pons pools from the PoolManager's `Initialize` logs (the pool's hook identifies them), including tokens whose launch predates our record
- [ ] Fold v4 `Swap` logs into the same per-wallet positions; the trader is the transaction's `from`, resolved in batches, never the router in `sender`
- [ ] Price positions whose token has no launch row from the pool's own pair, on the report, both leaderboards and the index
- [ ] Value bags still held from the pool price once the curve is gone
Needs: nothing beyond day one. Done when: a wallet that only traded a graduated token gets a pass with the right numbers.

## 7. Paid in Nvidia
Status: planned
The pair is ETH, settled before launch, so this is a swap at distribution and not a launch decision. Dropping it is a fine outcome: ETH is what stakers would get.
- [ ] Decide whether the holders' half is swapped into NVDA before it goes out
- [ ] If it is: the swap happens inside `harvest()` or in the airdrop script, never by hand, and `releaseToken(NVDA)` plus NVDA as the staking reward token follow
- [ ] Geo notice on the desk page goes live with the first NVDA distribution
Needs: item 0. Done when: the first distribution has landed, either in ETH with this item dropped and the reason written here, or in NVDA stock tokens with the notice on the page.

## 8. Daily turbulence card
Status: planned
- [ ] Card at 00:00 UTC with the index, lost yesterday, biggest loss, most cancelled airline
- [ ] Auto-post through the X API free tier (1,500 posts a month) once week one is over
Done when: the card posts itself for seven days without a hand touching it.

## 9. Turbulence index v2
Status: planned
- [ ] Add loss intensity (realized losses over volume) and one minus the graduation rate, normalized over the trailing 30 days with fixed bounds
- [ ] 30-day history chart on the index page
Needs: 30 days of data. Done when: the method page shows the v2 formula and the history.

## 10. Certificate of Rekt
Status: planned
- [ ] Soulbound ERC-721 with a server-signed loss figure, gas about zero, SVG on chain
- [ ] Mint from the pass page; the pass shows the certificate number
Needs: one more contract and a signing key on the API. Done when: a certificate shows in a wallet.

## 11. Public API and embeds
Status: planned
- [ ] Documented `GET /api/report/:address` and `GET /card/:address.png` for terminals and bots
- [ ] Rate limits by key for anyone who asks; embeds stay free
Done when: one terminal or bot shows REKT data.

## 12. Operations (not shown on the site)
- [ ] Second RPC for `eth_getLogs` (Alchemy free key) behind the public one, automatic failover
- [ ] DB retention: fold positions, never store raw trades chain-wide; nightly `VACUUM INTO` snapshot
- [ ] Alerting on lag and watcher silence (a watchdog on the heartbeat in `meta`)
Done when: a public RPC outage does not stop the board.
