/* REKT · the compensation desk: /api/desk into the page, and the only wallet code on the site,
   shown only when the contracts are live. No library: the injected provider's JSON-RPC and four
   fixed function selectors are enough for harvest, approve, stake, withdraw and getReward. */

import { $, el, getJson, initChrome, paintCa, short, usd, wei, num, dateShort, explorerAddress, explorerTx } from "./common.js";

const CHAIN_ID_HEX = "0x1237"; // 4663
const SEL = {
  harvest: "0x4641257d",   // harvest()
  stake: "0xa694fc3a",     // stake(uint256)
  withdraw: "0x2e1a7d4d",  // withdraw(uint256)
  approve: "0x095ea7b3",   // approve(address,uint256)
  getReward: "0x3d18b912", // getReward()
};

function pad32(hex) { return hex.replace(/^0x/, "").padStart(64, "0"); }
function toWeiHex(amount) {
  const [w, f = ""] = String(amount).trim().split(".");
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f)) throw new Error("amount");
  const n = BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
  return "0x" + n.toString(16);
}

function paintDesk(d) {
  const kind = { wallet: "the fee wallet", splitter: "the splitter contract", none: "none yet" }[d.recipientKind] || d.recipientKind;
  const rec = $("#dRecipient");
  rec.textContent = "";
  if (d.recipient) rec.append(el("a", { href: explorerAddress(d.recipient), target: "_blank", rel: "noopener", title: d.recipient, text: short(d.recipient) }));
  else rec.textContent = "none yet";
  $("#dRecipientKind").textContent = kind;
  $("#dAccrued").textContent = wei(d.accruedWei) + " ETH";
  $("#dAccruedUsd").textContent = "≈ " + usd(d.accruedUsd) + " · earned, not yet claimed";
  $("#dWallet").textContent = wei(d.walletWei) + " ETH";
  // Before the splitter this is a zero with a reason, not a number with an asterisk.
  $("#dHalf").textContent = d.sharing ? "≈ " + usd(d.holdersHalfUsd) : "$0";
  const note = $("#dHalfNote");
  if (note) note.textContent = d.sharing ? "owed by the rule, live" : "the rule starts when the splitter is the recipient";
  const line = $("#dRecipientLine");
  line.textContent = "";
  if (d.recipient) {
    line.append("Creator fee recipient of $REKT on the Pons factory: ", el("a", { href: explorerAddress(d.recipient), target: "_blank", rel: "noopener", text: d.recipient }), " (" + kind + "). Anyone can verify the balance on Blockscout.");
  } else {
    line.textContent = "The recipient is read from the Pons factory for $REKT. Before launch there is nothing to read.";
  }

  const status = d.contracts.status;
  const pill = $("#dStatus");
  pill.textContent = status;
  pill.className = "pill " + status.replace(" ", "-");
  const c = $("#dContracts");
  c.innerHTML = "";
  if (status === "live") {
    c.append(
      "Splitter ", el("a", { href: explorerAddress(d.contracts.splitter), target: "_blank", rel: "noopener", text: short(d.contracts.splitter) }),
      " · Staking ", el("a", { href: explorerAddress(d.contracts.staking), target: "_blank", rel: "noopener", text: short(d.contracts.staking) }),
      ". Harvest moves what the escrow holds into the split; half streams to stakers over seven days.",
    );
  } else if (status === "in progress") {
    c.append("The splitter and staking contracts are being built and tested on a fork. Until the splitter is the recipient the fee wallet is, nothing is paid out to anyone, and what the token earns in the meantime is the team's and pays for the build. ",
      el("a", { href: "https://github.com/0xChromium/Rekt", target: "_blank", rel: "noopener", text: "Repository" }), " · ", el("a", { href: "/roadmap", "data-href": "/roadmap", text: "Roadmap item 0" }), ".");
  } else {
    c.append("The contracts are planned. Until the splitter is the recipient, fees go to the fee wallet and are the team's. ", el("a", { href: "/roadmap", "data-href": "/roadmap", text: "Roadmap item 0" }), ".");
  }

  const body = $("#ledger tbody");
  body.innerHTML = "";
  if (!d.ledger || !d.ledger.length) {
    body.append(el("tr", {}, el("td", { class: "empty-row", colspan: "4", text: "first distribution: with the contract" })));
  } else {
    for (const row of d.ledger) {
      body.append(el("tr", {}, [
        el("td", { text: dateShort(row.ts) }),
        el("td", {}, el("a", { href: explorerTx(row.tx), target: "_blank", rel: "noopener", text: short(row.tx) })),
        el("td", { class: "r", text: usd(row.amountUsd, true) }),
        el("td", { class: "r", text: num(row.recipients) }),
      ]));
    }
  }

  const panel = $("#walletPanel");
  panel.hidden = status !== "live";
  if (status === "live") wireWallet(d);
  paintCa(d.ca ?? null);
}

function wireWallet(d) {
  const msg = $("#wMsg");
  const acct = $("#wAccount");
  let account = null;
  const eth = window.ethereum;
  const say = (t) => { msg.textContent = t; };
  if (!eth) { say("No wallet found in this browser. The contracts are public; any wallet can call them directly."); return; }

  async function connect() {
    try {
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      account = accounts[0];
      acct.textContent = short(account);
      const chain = await eth.request({ method: "eth_chainId" });
      if (chain !== CHAIN_ID_HEX) {
        try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] }); }
        catch { say("Please switch your wallet to Robinhood Chain (4663)."); }
      }
    } catch (e) { say("Wallet declined: " + (e?.message || e)); }
  }
  async function send(to, data) {
    if (!account) await connect();
    if (!account) return;
    try {
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: account, to, data }] });
      msg.textContent = "";
      msg.append("Sent: ", el("a", { href: explorerTx(hash), target: "_blank", rel: "noopener", text: short(hash) }));
    } catch (e) { say("Not sent: " + (e?.message || e)); }
  }
  const amount = () => { try { return toWeiHex($("#wAmount").value || "0"); } catch { say("Enter a plain number of REKT."); return null; } };

  $("#wConnect").onclick = connect;
  $("#wHarvest").onclick = () => send(d.contracts.splitter, SEL.harvest);
  $("#wApprove").onclick = () => { const a = amount(); if (a && d.ca) send(d.ca, SEL.approve + pad32(d.contracts.staking) + pad32(a)); };
  $("#wStake").onclick = () => { const a = amount(); if (a) send(d.contracts.staking, SEL.stake + pad32(a)); };
  $("#wUnstake").onclick = () => { const a = amount(); if (a) send(d.contracts.staking, SEL.withdraw + pad32(a)); };
  $("#wClaim").onclick = () => send(d.contracts.staking, SEL.getReward);
}

initChrome({ ca: false });
getJson("/api/desk").then((d) => {
  if (!d || d.error) {
    $("#dRecipientKind").textContent = d?.hint || "the desk is not answering";
    paintCa(null);
    return;
  }
  paintDesk(d);
}).catch(() => { $("#dRecipientKind").textContent = "the desk is not answering"; paintCa(null); });
setInterval(() => getJson("/api/desk").then((d) => { if (d && !d.error) paintDesk(d); }).catch(() => {}), 60000);
