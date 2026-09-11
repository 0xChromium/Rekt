/* REKT · the Rekt Report page (/r/<address>): reads the embedded Report (or the fixture with ?mock=1),
   renders the HTML boarding pass, the stats, the worst flight, badges, not alone, share and download. */

import {
  $, el, embeddedData, getJson, isMock, initChrome, paintCa, href, short, shorter, usd, usdTight, signedUsd, num, pct,
  dateShort, dateLong, dateTime, explorerAddress, ADDRESS_RE, SITE,
} from "./common.js";

const BADGE_LETTER = { sniper: "S", fastest_rekt: "F", serial_buyer: "3", diamond_coffin: "D", exit_row: "X", survivor: "V", frequent_flyer: "7" };

function pathAddress() {
  const m = location.pathname.match(/\/r\/(0x[0-9a-fA-F]{40})/);
  return m ? m[1].toLowerCase() : null;
}

async function load() {
  const embedded = embeddedData();
  if (embedded && !isMock()) return embedded;
  const addr = pathAddress() || new URLSearchParams(location.search).get("address");
  if (addr && !ADDRESS_RE.test(addr)) return { error: "bad address", hint: "That is not an address. Passenger addresses look like 0x followed by 40 hex characters." };
  try { return await getJson("/api/report/" + (addr || "0x3f9abf816809a4d8aa98ed09fe848bc31b08c1e4")); }
  catch { return embedded || { error: "internal", hint: "Something went wrong at the desk. Try again in a minute." }; }
}

function lookupForm() {
  const form = el("form", { class: "form lookup", action: "/r/", autocomplete: "off" }, [
    el("input", { type: "text", name: "address", placeholder: "0x passenger address", spellcheck: "false", "aria-label": "Passenger address" }),
    el("button", { type: "submit", text: "Print boarding pass" }),
  ]);
  return el("div", { style: "margin-top:18px" }, [form, el("div", { class: "form-err", "aria-live": "polite" })]);
}

/** The record is short while it fills backwards; the hint says so, and the heading should agree. */
const filling = (err) => /still filling backwards/.test(err.hint || "");

function heading(err) {
  if (err.error === "bad address") return "That is not an address.";
  if (err.error !== "no flights") return "The desk is closed for a moment.";
  return filling(err) ? "Older than our record." : "No flights on record.";
}

function renderError(root, err) {
  document.title = "No flights · REKT";
  root.innerHTML = "";
  root.append(
    el("div", { class: "k", text: err.error === "bad address" ? "Passenger lookup" : "Lost and found" }),
    el("div", { class: "empty" }, [
      el("h2", { text: heading(err) }),
      el("p", { text: err.hint || "Something went wrong at the desk. Try again in a minute." }),
      err.error === "no flights" && !filling(err)
        ? el("p", { text: "Good news, in a way. Nothing here counted against you. Try another passenger, or watch the board." })
        : null,
      lookupForm(),
      el("p", { style: "margin-top:16px" }, el("a", { href: href("/"), text: "Back to departures" })),
    ]),
  );
  initChrome();
}

function pass(r) {
  const lost = r.netRealizedUsd < 0;
  const worst = r.worst;
  const gate = r.rank ? num(r.rank) + " of " + num(r.ofWallets) : "standby";
  const baggage = [
    "Baggage: " + num(r.tokensTraded) + " token" + (r.tokensTraded === 1 ? "" : "s"),
    num(r.bagsHeld) + " still at claim",
    worst
      ? "worst flight " + worst.symbol + " −" + usd(worst.lossUsd) + ", " + (worst.dead ? "cancelled" : "still flying") + " by " + shorter(worst.deployer)
        + " (" + num(worst.deployerRecord.launches) + " flights, " + pct(worst.deployerRecord.deadShare) + " cancelled)"
      : "no losing flights",
  ].join(" · ");
  return el("div", { class: "pass", role: "img", "aria-label": "Boarding pass for " + short(r.address) }, [
    el("div", { class: "main" }, [
      el("div", { class: "strip" }, [el("span", { text: "REKT Air · Boarding pass" }), el("small", { text: SITE + " · $REKT · " + (r.ca ? "CA " + short(r.ca) : "no CA yet") })]),
      el("div", { class: "f" }, [
        el("div", {}, [el("span", { text: "Passenger" }), el("b", { text: short(r.address), title: r.address })]),
        el("div", {}, [el("span", { text: "From" }), el("b", { text: "PONS" })]),
        el("div", {}, [el("span", { text: "To" }), el("b", { text: r.netRealizedUsd > 0 ? "NOT ZERO" : "ZERO" })]),
        el("div", {}, [el("span", { text: lost ? "Total loss" : "Net result" }), el("b", { class: lost ? "loss" : "gain", text: signedUsd(r.netRealizedUsd) })]),
        el("div", {}, [el("span", { text: "Flight" }), el("b", { text: "RK-67" })]),
        el("div", {}, [el("span", { text: "Seat" }), el("b", { text: r.netRealizedUsd > 0 ? "1A · window" : "67F · exit row" })]),
        el("div", {}, [el("span", { text: "Gate" }), el("b", { text: gate })]),
        el("div", {}, [el("span", { text: "Class" }), el("b", { text: r.className })]),
        el("div", {}, [el("span", { text: "Boarded" }), el("b", { text: dateShort(r.firstTs) })]),
        el("div", { class: "wide" }, [el("span", { text: baggage }), el("span", { text: dateShort(Math.floor(Date.now() / 1000)) })]),
      ]),
    ]),
    el("div", { class: "stub" }, [
      el("div", {}, [el("span", { text: "Passenger" }), el("b", { text: short(r.address) })]),
      el("div", {}, [el("span", { text: "Flight · seat" }), el("b", { text: r.netRealizedUsd > 0 ? "RK-67 · 1A" : "RK-67 · 67F" })]),
      el("div", {}, [el("span", { text: lost ? "Loss" : "Result" }), el("b", { style: "color:" + (lost ? "#E0322B" : "#1c8a4c"), text: signedUsd(r.netRealizedUsd, false) })]),
      el("div", {}, [el("span", { text: "Class" }), el("b", { text: r.className })]),
      el("div", { class: "bc", "aria-hidden": "true" }),
    ]),
  ]);
}

function stat(label, value, note, cls, title) {
  return el("div", { class: "stat" }, [el("span", { text: label }), el("b", { class: cls || "", text: value, title: title || null }), note ? el("i", { text: note }) : null]);
}

function shareText(r) {
  const amount = usd(Math.abs(r.netRealizedUsd));
  if (r.netRealizedUsd < 0) return "I lost " + amount + " on Pons and got a boarding pass for it. Seat 67F, exit row. $REKT";
  if (r.netRealizedUsd > 0) return "I came out " + amount + " ahead on Pons and still got a boarding pass. Seat 1A, window. $REKT";
  return "I broke even on Pons and got a boarding pass for it. Seat 67F, exit row. $REKT";
}

function render(root, r) {
  const lost = r.netRealizedUsd < 0;
  document.title = short(r.address) + " · Boarding pass · REKT";
  const origin = location.origin.startsWith("http") ? location.origin : "https://" + SITE;
  const pageUrl = origin + "/r/" + r.address;
  const shareUrl = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText(r)) + "&url=" + encodeURIComponent(pageUrl);
  const worst = r.worst;

  root.innerHTML = "";
  root.append(
    el("div", { class: "k", text: "Passenger " + short(r.address) + " · records since " + dateLong(r.since) }),
    el("h1", { text: lost ? "Thank you for your liquidity." : "You arrived. Someone had to." }),
    el("div", { class: "pass-wrap" }, pass(r)),
    el("div", { class: "actions" }, [
      el("a", { class: "btn", href: shareUrl, target: "_blank", rel: "noopener", text: "Share on X" }),
      el("a", { class: "btn ghost", href: "/card/" + r.address + ".png?download=1", text: "Download the pass" }),
      el("a", { class: "btn dark", href: href("/desk"), text: "Compensation desk" }),
    ]),
    el("div", { class: "stats" }, [
      stat("Net realized", usdTight(r.netRealizedUsd, true), "at the price of the day", lost ? "red" : "green", signedUsd(r.netRealizedUsd)),
      stat("Realized losses", usdTight(r.realizedUsd), "losing flights only", "red", usd(r.realizedUsd, true)),
      stat("Baggage claim", "≈ " + usdTight(r.bagsUsd), num(r.bagsHeld) + " bag" + (r.bagsHeld === 1 ? "" : "s") + " still held, approximate", "", usd(r.bagsUsd)),
      stat("Volume", usdTight(r.volumeUsd), num(r.buys) + " buys · " + num(r.sells) + " sells", "", usd(r.volumeUsd)),
      stat("Flights", num(r.tokensTraded), "tokens traded"),
      stat("Gate", r.rank ? num(r.rank) : "standby", r.rank ? "of " + num(r.ofWallets) + " · " + (r.percentile != null ? r.percentile.toFixed(1) + "% flew worse" : "") : "three trades to qualify"),
      stat("Boarded", dateShort(r.firstTs), "last flight " + dateShort(r.lastTs)),
      r.unpricedPositions ? stat("Unpriced", num(r.unpricedPositions), "positions in assets we cannot price") : null,
      r.outsideRecordPositions ? stat("Carried on", num(r.outsideRecordPositions), "sold from before our records begin, not counted") : null,
    ]),
    el("div", { class: "report-grid" }, [
      el("div", {}, [
        worst
          ? el("div", { class: "flight-card" }, [
            el("div", { class: "k", text: "Worst flight" }),
            el("h3", {}, el("a", { href: href("/t/" + worst.token), text: worst.symbol })),
            el("div", { class: "big", text: "−" + usd(worst.lossUsd) }),
            el("p", { text: "Boarded " + dateTime(worst.boughtTs) + "." }),
            el("p", { text: worst.dead ? "Your flight was cancelled by the pilot." : "Still in the air. Destination unchanged." }),
            el("p", {}, [
              "Airline ",
              el("a", { href: explorerAddress(worst.deployer), target: "_blank", rel: "noopener", title: worst.deployer, text: short(worst.deployer) }),
              " · " + num(worst.deployerRecord.launches) + " flights · " + pct(worst.deployerRecord.deadShare) + " cancelled · " + num(worst.deployerRecord.losers) + " passengers lost",
            ]),
            r.notAlone
              ? el("p", { class: "amber", text: "You are not alone: " + num(r.notAlone.wallets) + " passengers never arrived on this flight. Combined loss " + usd(r.notAlone.lostUsd) + "." })
              : null,
          ])
          : el("div", { class: "flight-card" }, [el("div", { class: "k", text: "Worst flight" }), el("h3", { text: "None on record." }), el("p", { text: "Every flight you took arrived, or has not landed yet." })]),
        r.best
          ? el("div", { class: "flight-card", style: "margin-top:12px" }, [
            el("div", { class: "k", text: "Best flight" }),
            el("h3", {}, el("a", { href: href("/t/" + r.best.token), text: r.best.symbol })),
            el("div", { class: "big green", text: "+" + usd(r.best.gainUsd) }),
            el("p", { text: "Arrived. Do not get used to it." }),
          ])
          : null,
      ]),
      el("div", {}, [
        el("div", { class: "k", text: "Badges" }),
        r.badges && r.badges.length
          ? el("ul", { class: "badges" }, r.badges.slice(0, 3).map((b) => el("li", {}, [
            el("i", { text: BADGE_LETTER[b.id] || "·", "aria-hidden": "true" }),
            el("div", {}, [el("b", { text: b.label }), el("span", { text: b.detail })]),
          ])))
          : el("div", { class: "badges" }, el("div", { class: "none", text: "No badges. Unremarkable is a kind of safety." }),),
        el("div", { class: "notice", style: "margin-top:18px" }, [
          "Dollar figures are approximate, converted with the daily price book. Curve trades only for now; pool trades after graduation are ",
          el("a", { href: href("/roadmap"), text: "on the roadmap" }),
          ". Not financial advice. Nothing here is a payout or a refund.",
        ]),
      ]),
    ]),
  );
  paintCa(r.ca ?? null);
  initChrome({ ca: false });
}

const root = $("#report");
load().then((data) => {
  if (!data || data.error) renderError(root, data || { error: "internal", hint: "Something went wrong at the desk. Try again in a minute." });
  else render(root, data);
});
