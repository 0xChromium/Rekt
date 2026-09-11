/* REKT · shared helpers for every page: mock mode, fetching, formatting, the CA line, the lag banner.
   Plain ES module, no build step. Mock mode: ?mock=1 (kept in sessionStorage while navigating) reads
   web/mock/*.json instead of /api/*; see web/mock/README.md. */

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const SITE = "rekt.report";

const params = new URLSearchParams(location.search);

function storage(kind) {
  try { return window[kind]; } catch { return null; }
}

/** True when the page runs on fixtures. ?mock=1 turns it on, ?mock=0 turns it off, otherwise sessionStorage remembers. */
export function isMock() {
  const p = params.get("mock");
  const ss = storage("sessionStorage");
  if (p === "1") { try { ss?.setItem("rekt-mock", "1"); } catch { /* private mode */ } return true; }
  if (p === "0") { try { ss?.removeItem("rekt-mock"); } catch { /* ignore */ } return false; }
  try { return ss?.getItem("rekt-mock") === "1"; } catch { return false; }
}

/** True when this page was opened as a plain file (python3 -m http.server from web/): routes like /hall do not exist there. */
export function isFileServer() {
  return /\.html$/.test(location.pathname);
}

const MOCK_FILES = [
  [/^\/api\/report\//, "report.json"],
  [/^\/api\/index/, "index.json"],
  [/^\/api\/leaderboard\/rekt/, "leaderboard-rekt.json"],
  [/^\/api\/leaderboard\/airlines/, "leaderboard-airlines.json"],
  [/^\/api\/token\//, "token.json"],
  [/^\/api\/desk/, "desk.json"],
  [/^\/api\/health/, "health.json"],
  [/^\/api\/board/, "board-replay.json"],
];

/** The URL to fetch for an API route, in either mode. */
export function apiUrl(route) {
  if (!isMock()) return route;
  for (const [re, file] of MOCK_FILES) if (re.test(route)) return "/mock/" + file;
  return route;
}

/** GET a JSON route. Resolves with the body; non-2xx resolves with the ApiError body (it has `error`). */
export async function getJson(route) {
  const url = apiUrl(route);
  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-cache" });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    if (body && typeof body.error === "string") return body;
    return { error: res.status === 429 ? "rate limited" : "internal", hint: "Something went wrong at the desk. Try again in a minute." };
  }
  if (isMock() && /^\/api\/report\/0x0{40}/.test(route)) {
    return { error: "no flights", hint: "No flights on record for this passenger since September 3. Either you never boarded, or you boarded before our records begin." };
  }
  return body;
}

/** Site links that keep working on a plain file server in mock mode. */
export function href(path) {
  if (!(isMock() && isFileServer())) return path;
  const q = "?mock=1";
  if (path === "/") return "/index.html" + q;
  if (path.startsWith("/r/")) return "/templates/report.html" + q;
  if (path.startsWith("/t/")) return "/templates/token.html" + q;
  if (path === "/roadmap") return "/templates/roadmap.html" + q;
  if (/^\/(hall|airlines|desk|about|turbulence|leaderboards)$/.test(path)) return path + ".html" + q;
  return path;
}

// ---------------------------------------------------------------- formatting

export function short(addr) {
  if (!addr || addr.length < 12) return addr || "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}
export function shorter(addr) {
  if (!addr || addr.length < 8) return addr || "";
  return addr.slice(0, 4) + "…" + addr.slice(-2);
}

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

/** "$4,212" (whole dollars). Negative numbers get a real minus sign. */
export function usd(n, cents = false) {
  if (n == null || Number.isNaN(n)) return "—";
  const s = (cents ? usd2 : usd0).format(Math.abs(n));
  return (n < 0 ? "−" : "") + s;
}
/** Signed: "−$4,212.09" or "+$1,098.35". */
export function signedUsd(n, cents = true) {
  if (n == null || Number.isNaN(n)) return "—";
  const s = (cents ? usd2 : usd0).format(Math.abs(n));
  return (n < 0 ? "−" : n > 0 ? "+" : "") + s;
}
/** "$1.28M", "$312K", "$640". For the counters. */
export function usdCompact(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return sign + "$" + Math.round(a / 1e3) + "K";
  return sign + usd0.format(a);
}
/* The stat tiles are one line wide at 32px, so anything past seven figures runs into the ellipsis.
   Round those to millions; the exact figure stays on the tile's title. */
export function usdTight(n, signed = false) {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.round(Math.abs(n)); // rounded first, so $999,999.60 does not print as a seven-figure "$1,000,000"
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  return sign + usd0.format(a);
}
export function num(n) { return n == null ? "—" : int.format(n); }
export function pct(share, digits = 0) { return share == null ? "—" : (share * 100).toFixed(digits) + "%"; }

/* Times are printed in the reader's own zone, the way an airport prints local time: a board that
   says 09:19 to somebody whose clock says 12:19 reads as stale rather than as UTC. Only the
   server-rendered card, which has no reader to ask, stays on UTC and says so. */
export function hhmm(ts) {
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
export function hhmmss(ts) {
  return hhmm(ts) + ":" + String(new Date(ts * 1000).getSeconds()).padStart(2, "0");
}
/** The reader's zone as a short label, e.g. "GMT+3", for the one place the board names it. */
export function zoneLabel() {
  const min = -new Date().getTimezoneOffset();
  if (min === 0) return "UTC";
  const sign = min < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  return "GMT" + sign + h + (m ? ":" + String(m).padStart(2, "0") : "");
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "Sep 10 2026" */
export function dateShort(ts) {
  const d = new Date(ts * 1000);
  return MONTHS[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear();
}
/** "September 10" */
export function dateLong(ts) {
  const d = new Date(ts * 1000);
  return MONTHS_LONG[d.getMonth()] + " " + d.getDate();
}
/** "Sep 10 2026 · 01:50 GMT+3", in the reader's zone. */
export function dateTime(ts) {
  return dateShort(ts) + " · " + hhmm(ts) + " " + zoneLabel();
}
/** "34 seconds", "4 min", "6 hours", "3 days" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + " second" + (s === 1 ? "" : "s");
  const m = Math.round(s / 60);
  if (m < 60) return m + " min";
  const h = Math.round(m / 60);
  if (h < 48) return h + " hour" + (h === 1 ? "" : "s");
  const d = Math.round(h / 24);
  return d + " day" + (d === 1 ? "" : "s");
}
/** "4 min after boarding", "34 seconds after boarding" */
export function afterBoarding(minutes) {
  return duration(minutes * 60) + " after boarding";
}
export function ago(ts, nowTs = Math.floor(Date.now() / 1000)) {
  return duration(nowTs - ts) + " ago";
}
export function wei(str, digits = 4) {
  try {
    const n = BigInt(str || "0");
    const whole = n / 10n ** 18n;
    const frac = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, digits);
    return whole.toString() + "." + frac;
  } catch { return "0"; }
}

export const STATUS_WORD = { boarding: "Boarding", arrived: "Arrived", departed: "Departed", cancelled: "Cancelled" };

// ---------------------------------------------------------------- DOM helpers

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}
export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function explorerAddress(a) { return EXPLORER + "/address/" + a; }
export function explorerTx(h) { return EXPLORER + "/tx/" + h; }
export function explorerToken(a) { return EXPLORER + "/token/" + a; }

/** Reads the embedded {{json}} of a server-rendered shell. Null when the placeholder was never filled. */
export function embeddedData() {
  const node = document.getElementById("data");
  if (!node) return null;
  const text = node.textContent.trim();
  if (!text || text.startsWith("{{")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------- the CA line, on every page

export const NO_CA = "boarding soon · no CA yet · anything claiming to be $REKT is not ours";

/** Fills every [data-ca] element with the CA line. `ca` null means before launch. */
export function paintCa(ca) {
  for (const node of $$("[data-ca]")) {
    node.textContent = "";
    if (!ca) { node.textContent = NO_CA; node.classList.add("no-ca"); continue; }
    node.classList.remove("no-ca");
    const mode = node.dataset.ca;
    node.append("$REKT · CA ");
    node.append(el("a", { href: explorerToken(ca), target: "_blank", rel: "noopener", title: ca, text: short(ca) }));
    if (mode !== "short") node.append(" · compensation desk open");
  }
}

let caLoaded = false;
/** Pages without the board stream get the CA from /api/desk. */
export async function loadCa() {
  if (caLoaded) return;
  caLoaded = true;
  try {
    const desk = await getJson("/api/desk");
    paintCa(desk && !desk.error ? desk.ca : null);
  } catch { paintCa(null); }
}

// ---------------------------------------------------------------- the lag banner

let lagTimer = null;
/** Polls /api/health every 15 s and paints the banner: yellow from 30 s of lag, red from 2 min or a silent watcher. */
export function startLagBanner(intervalMs = 15000) {
  const box = document.getElementById("lag");
  if (!box) return;
  const paint = (h) => {
    let level = null, text = "";
    if (!h || h.error) {
      level = "red"; text = "The desk is not answering. The board may be stale.";
    } else {
      const lag = Number(h.lagSeconds) || 0;
      const silent = h.watcherAgeSeconds == null || h.watcherAgeSeconds >= 120;
      if (silent) { level = "red"; text = "The watcher has gone quiet. Flights shown may be behind the chain."; }
      else if (lag >= 120) { level = "red"; text = "Board running " + duration(lag) + " behind the chain."; }
      else if (lag >= 30) { level = "yellow"; text = "Board running " + duration(lag) + " behind the chain."; }
    }
    if (isMock()) {
      const forced = params.get("lag");
      if (forced === "yellow") { level = "yellow"; text = "Board running 45 seconds behind the chain."; }
      if (forced === "red") { level = "red"; text = "Board running 3 min behind the chain."; }
    }
    if (!level) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle("red", level === "red");
    box.innerHTML = "";
    box.append(el("b", { text: level === "red" ? "Delay" : "Minor delay" }), el("span", { text: text }));
  };
  const tick = async () => {
    try { paint(await getJson("/api/health")); } catch { paint(null); }
  };
  tick();
  if (lagTimer) clearInterval(lagTimer);
  lagTimer = setInterval(tick, intervalMs);
}

/** Address input: validates, then goes to /r/<address>. */
export function wireLookup(form) {
  if (!form) return;
  const input = form.querySelector("input");
  const err = form.parentElement.querySelector(".form-err");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (input.value || "").trim();
    if (!ADDRESS_RE.test(v)) {
      if (err) err.textContent = "That is not an address. Passenger addresses look like 0x followed by 40 hex characters.";
      input.focus();
      return;
    }
    if (err) err.textContent = "";
    location.href = href("/r/" + v.toLowerCase());
  });
  input.addEventListener("input", () => { if (err) err.textContent = ""; });
}

/** Everything the page chrome needs: nav links that survive the file server, the current-page mark, the CA. */
export function initChrome({ ca = true } = {}) {
  for (const a of $$("a[data-href]")) a.setAttribute("href", href(a.dataset.href));
  const here = location.pathname.replace(/\.html$/, "").replace(/^\/index$/, "/").replace(/^\/templates\/(\w+)$/, "/$1");
  for (const a of $$(".top nav a")) {
    const to = (a.dataset.href || a.getAttribute("href") || "").replace(/\?.*$/, "");
    if (to === here || (to === "/leaderboards" && /^\/(hall|airlines)$/.test(here))) a.setAttribute("aria-current", "page");
  }
  for (const f of $$("form.lookup")) wireLookup(f);
  startLagBanner();
  if (ca) loadCa();
}

/**
 * How deep the record is, printed where the site explains itself. The number is the honest limit of
 * every answer the site gives, so it belongs on the page and not only in a health check.
 */
export async function paintRecords() {
  const box = document.getElementById("records");
  const line = document.getElementById("recordsLine");
  if (!box || !line) return;
  try {
    const h = await (await fetch(apiUrl("/api/health"), { cache: "no-store" })).json();
    const r = h.records;
    if (!r) return;
    // The shallower of the two streams, not the deeper: a report combines curve trades and pool
    // swaps, so the site answers completely only as far back as the one that reaches least far.
    const days = Math.min(r.curve.days, r.pools.days).toFixed(1);
    line.textContent = r.complete
      ? `Every Pons v2 flight since 4 August is on record: ${days} days of the chain, and the board keeps up with it live.`
      : `${days} days of the chain are on record, and it is still filling backwards towards 4 August. ${r.missing ?? ""} A wallet whose flights are older than that will fill in as the reading reaches them.`;
    box.hidden = false;
  } catch {
    // The page reads fine without it.
  }
}
