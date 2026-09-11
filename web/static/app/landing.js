/* REKT · the landing page: chrome, the board stream, the two top-10 tables. */

import { $, initChrome } from "./common.js";
import { initBoard } from "./board.js";
import { paintHall, paintAirlines } from "./tables.js";

initChrome();
initBoard();
// Autofocus without the scroll jump the attribute causes: the board must stay in the first frame.
const input = $("form.lookup input");
if (input && !window.matchMedia("(max-width: 900px)").matches) { try { input.focus({ preventScroll: true }); } catch { /* old browser */ } }
paintHall($("#hall"), "24h");
paintAirlines($("#airlines"));
setInterval(() => { paintHall($("#hall"), "24h"); paintAirlines($("#airlines")); }, 60000);
