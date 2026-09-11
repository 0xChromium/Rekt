/* REKT · the leaderboard pages: Hall of Rekt with a 24h / all-time toggle, Airlines. */

import { $, $$, initChrome } from "./common.js";
import { paintHall, paintAirlines } from "./tables.js";

initChrome();

const hall = $("#hall");
const airlines = $("#airlines");
let window_ = "24h";

function setWindow(w) {
  window_ = w;
  for (const b of $$(".toggle button")) b.setAttribute("aria-pressed", b.dataset.window === w ? "true" : "false");
  const k = $("#hallWindow");
  if (k) k.textContent = w === "24h" ? "Top 10 today" : "Top 10 all time";
  paintHall(hall, w);
}
for (const b of $$(".toggle button")) b.addEventListener("click", () => setWindow(b.dataset.window));

const focus = document.body.dataset.board;
setWindow(focus === "airlines" ? "all" : "24h");
paintAirlines(airlines);
setInterval(() => { paintHall(hall, window_); paintAirlines(airlines); }, 60000);

if (focus === "airlines") {
  const sec = $("#airlinesSection");
  if (sec) sec.scrollIntoView({ block: "start" });
}
