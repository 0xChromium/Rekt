/* REKT · the token page (/t/<token>): the minimal tombstone from the TokenPage type. */

import { $, el, embeddedData, getJson, isMock, initChrome, href, short, usd, num, pct, dateTime, duration, explorerAddress, explorerToken, STATUS_WORD, ADDRESS_RE } from "./common.js";

function pathToken() {
  const m = location.pathname.match(/\/t\/(0x[0-9a-fA-F]{40})/);
  return m ? m[1].toLowerCase() : null;
}

async function load() {
  const embedded = embeddedData();
  if (embedded && !isMock()) return embedded;
  const t = pathToken() || new URLSearchParams(location.search).get("token");
  if (t && !ADDRESS_RE.test(t)) return { error: "bad address", hint: "That is not an address. Passenger addresses look like 0x followed by 40 hex characters." };
  try { return await getJson("/api/token/" + (t || "0xb7434e55fcfcb771d217463717654d082e40d3d6")); }
  catch { return embedded || { error: "internal", hint: "Something went wrong at the desk. Try again in a minute." }; }
}

function renderError(root, err) {
  document.title = "No flight · REKT";
  root.innerHTML = "";
  root.append(
    el("div", { class: "k", text: "Lost and found" }),
    el("div", { class: "empty" }, [
      el("h2", { text: err.error === "unknown token" ? "No flight by that number." : "The desk is closed for a moment." }),
      el("p", { text: err.hint || "Something went wrong at the desk. Try again in a minute." }),
      el("p", {}, el("a", { href: href("/"), text: "Back to departures" })),
    ]),
  );
}

function render(root, t) {
  document.title = t.symbol + " · Lost and found · REKT";
  const dead = t.status === "departed" || t.status === "cancelled";
  const line = t.status === "cancelled"
    ? "Cancelled by the pilot " + duration(t.lifespanMin * 60) + " after boarding."
    : t.status === "departed" ? "Departed to zero after " + duration(t.lifespanMin * 60) + "."
    : t.status === "arrived" ? "Arrived. Graduated to the pool." : "Now boarding. Destination: zero. On time.";
  root.innerHTML = "";
  root.append(
    el("div", { class: "k", text: dead ? "Lost and found" : "Flight record" }),
    el("div", { class: "tomb" }, [
      el("div", { class: "sym", text: t.symbol }),
      el("div", { class: "name" }, [t.name + " · ", el("span", { class: "pill " + t.status, text: STATUS_WORD[t.status] || t.status })]),
      el("p", { style: "font-size:17px;color:var(--rk-paper)", text: line }),
      el("dl", {}, [
        el("dt", { text: "Token" }), el("dd", {}, el("a", { href: explorerToken(t.token), target: "_blank", rel: "noopener", text: t.token })),
        el("dt", { text: "Born" }), el("dd", { text: dateTime(t.bornTs) }),
        el("dt", { text: "Died" }), el("dd", { text: t.diedTs ? dateTime(t.diedTs) : "not yet" }),
        el("dt", { text: "Lifespan" }), el("dd", { text: duration(t.lifespanMin * 60) + (dead ? "" : " so far") }),
        el("dt", { text: "Peak" }), el("dd", { text: t.peakMultiple != null ? t.peakMultiple.toFixed(1) + "× launch price" : "not indexed" }),
        el("dt", { text: "Passengers lost" }), el("dd", { text: num(t.losers) + " wallets · " + usd(t.lostUsd) + " combined" }),
        el("dt", { text: "Biggest loss" }), el("dd", { class: "red", text: "−" + usd(t.biggestLossUsd) }),
        el("dt", { text: "Airline" }), el("dd", {}, [
          el("a", { href: explorerAddress(t.deployer), target: "_blank", rel: "noopener", title: t.deployer, text: short(t.deployer) }),
          " · " + num(t.deployerRecord.launches) + " flights · " + pct(t.deployerRecord.deadShare) + " cancelled · " + num(t.deployerRecord.losers) + " passengers lost",
        ]),
      ]),
    ]),
    t.losers ? el("p", { class: "notice", style: "margin-top:18px", text: "You are not alone: " + num(t.losers) + " passengers never arrived on this flight." }) : null,
    el("div", { class: "actions" }, [
      el("a", { class: "btn ghost", href: href("/airlines"), text: "Airlines" }),
      el("a", { class: "btn dark", href: href("/"), text: "Departures" }),
    ]),
    el("p", { class: "dim", style: "font-size:13px", text: "Curve trades only for now. Dollar figures are approximate." }),
  );
}

const root = $("#token");
initChrome();
load().then((data) => {
  if (!data || data.error) renderError(root, data || { error: "internal", hint: "Something went wrong at the desk. Try again in a minute." });
  else render(root, data);
});
