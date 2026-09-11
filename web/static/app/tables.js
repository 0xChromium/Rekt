/* REKT · leaderboard tables, shared by the landing and the leaderboard pages. */

import { $, el, getJson, href, short, usd, num, pct } from "./common.js";

function emptyRow(cols, text) {
  return el("tr", { class: "empty" }, el("td", { colspan: String(cols), text }));
}

/** Hall of Rekt: HallRow[] into #hall (or the given table). */
export async function paintHall(table, window = "24h", highlight = null) {
  const body = $("tbody", table);
  let rows;
  try { rows = await getJson("/api/leaderboard/rekt?window=" + window); } catch { rows = null; }
  body.innerHTML = "";
  if (!rows || rows.error) { body.append(emptyRow(5, rows?.hint || "The desk is not answering.")); return; }
  if (!rows.length) { body.append(emptyRow(5, "No losses on record yet. Boarding continues.")); return; }
  rows.forEach((r, i) => {
    body.append(el("tr", { class: highlight && r.wallet === highlight ? "me" : "" }, [
      el("td", { class: "n", text: String(i + 1) }),
      el("td", {}, el("a", { href: href("/r/" + r.wallet), title: r.wallet, text: short(r.wallet) })),
      el("td", { class: "r loss", text: "−" + usd(r.lossUsd) }),
      el("td", { class: "r", text: num(r.tokens) }),
      el("td", { text: r.worstSymbol || "—" }),
    ]));
  });
}

/** Airlines: AirlineRow[] into the given table. */
export async function paintAirlines(table, highlight = null) {
  const body = $("tbody", table);
  let rows;
  try { rows = await getJson("/api/leaderboard/airlines"); } catch { rows = null; }
  body.innerHTML = "";
  if (!rows || rows.error) { body.append(emptyRow(6, rows?.hint || "The desk is not answering.")); return; }
  if (!rows.length) { body.append(emptyRow(6, "No airlines on record yet.")); return; }
  rows.forEach((r, i) => {
    body.append(el("tr", { class: highlight && r.deployer === highlight ? "me" : "" }, [
      el("td", { class: "n", text: String(i + 1) }),
      el("td", {}, el("a", { href: "https://robinhoodchain.blockscout.com/address/" + r.deployer, target: "_blank", rel: "noopener", title: r.deployer, text: short(r.deployer) })),
      el("td", { class: "r", text: num(r.launches) }),
      el("td", { class: "r", text: pct(r.deadShare) }),
      el("td", { class: "r", text: num(r.losers) }),
      el("td", { class: "r loss", text: "−" + usd(r.lostUsd) }),
    ]));
  });
}
