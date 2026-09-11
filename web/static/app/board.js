/* REKT · the departures board. EventSource on /api/board (replay on connect, then launch / status /
   graduate / loss / counters), split-flap flips on change, an optional synthesised clack, reduced
   motion respected. With ?mock=1 the stream is simulated from web/mock/board-replay.json. */

import { $, $$, el, hhmm, short, usd, usdCompact, num, afterBoarding, isMock, apiUrl, href, paintCa, STATUS_WORD } from "./common.js";

const ROWS = 12;
// The bottom four slots hold the tokens whose status changed most recently. Without them the board
// is twelve launches, every one of them BOARDING, and nothing ever flips: see src/board.ts.
const CHANGED = 4;
const TAPE = 20;
const DEAD = { cancelled: 1, departed: 1 };
const COLS = ["time", "flight", "token", "destination", "gate", "status"];
const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- sound

const clack = (() => {
  let ctx = null;
  let on = false;
  try { on = localStorage.getItem("rekt-sound") === "1"; } catch { on = false; }
  function play() {
    if (!on) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      // a short noise burst through a lowpass: the flap hitting the stop
      const len = Math.floor(ctx.sampleRate * 0.045);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2200; lp.Q.value = 0.7;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(lp).connect(g).connect(ctx.destination);
      src.start(t);
      // a tiny wooden tick under it
      const osc = ctx.createOscillator(); osc.type = "square"; osc.frequency.setValueAtTime(900, t); osc.frequency.exponentialRampToValueAtTime(300, t + 0.02);
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.08, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
      osc.connect(g2).connect(ctx.destination); osc.start(t); osc.stop(t + 0.03);
    } catch { /* no audio, no problem */ }
  }
  function set(v) {
    on = !!v;
    try { localStorage.setItem("rekt-sound", on ? "1" : "0"); } catch { /* private mode */ }
    if (on) play();
  }
  return { play, set, get on() { return on; } };
})();

// ---------------------------------------------------------------- rendering

function rowView(r) {
  return {
    time: hhmm(r.ts),
    flight: r.flight,
    token: r.symbol || "?",
    // Where the flight was going, not where it is. Every Pons launch is scheduled for a Uniswap
    // pool; the ones that die are re-routed to ZERO, and that cell flips as they go.
    destination: DEAD[r.status] ? "ZERO" : "UNISWAP",
    gate: r.pairSymbol || "?",
    status: STATUS_WORD[r.status] || r.status,
  };
}

function flipCell(cell, text, href_) {
  const paint = () => {
    cell.textContent = "";
    if (href_) cell.append(el("a", { href: href_, text }));
    else cell.textContent = text;
  };
  if (reduce) { paint(); return; }
  cell.classList.remove("flip");
  void cell.offsetWidth; // restart the animation
  cell.classList.add("flip");
  setTimeout(paint, 180);
  setTimeout(() => cell.classList.remove("flip"), 400);
}

export class Board {
  constructor(root) {
    this.topToken = null;    // whose line is at the top, so the blink restarts only when it changes
    this.fresh = [];         // BoardRow[] still boarding, newest launch first
    this.changed = [];       // BoardRow[] that died or arrived, most recent change first
    this.root = root;
    this.losses = [];        // LossEvent[], newest first
    this.tape = $("#tape ol");
    this.els = $$(".row[data-slot]", root);
    this.counters = { lost: $("#cLost"), days: $("#cDays"), turb: $("#cTurb"), turbLabel: $("#cTurbLabel") };
  }

  /** The twelve lines as painted: launches on top, the recent status changes underneath. */
  get rows() {
    return this.fresh.concat(this.changed);
  }

  /**
   * Trims both lanes to their slots. The changes lane keeps four, and more than four only when
   * there are not enough launches to fill the board; launches take everything left over.
   */
  rebalance() {
    this.changed = this.changed.slice(0, Math.max(CHANGED, ROWS - this.fresh.length));
    this.fresh = this.fresh.slice(0, ROWS - this.changed.length);
  }

  /** Paints every row from this.rows; `animate` flips every cell whose text changed. */
  paint(animate = true) {
    let flips = 0;
    const rows = this.rows;
    const split = this.fresh.length;
    this.els.forEach((rowEl, i) => {
      const r = rows[i];
      const cells = $$(".c", rowEl);
      if (!r) {
        rowEl.className = "row empty";
        rowEl.removeAttribute("data-token");
        cells.forEach((c, k) => { c.textContent = k === 5 ? "· · ·" : "· · ·"; });
        return;
      }
      const v = rowView(r);
      // A hairline above the first line of the changes lane, so the split reads as deliberate.
      // `newest` blinks the top line for a few beats; re-applied only when the token there changes,
      // because a CSS animation with a finite count restarts on nothing else.
      const newest = i === 0 && r.token !== this.topToken;
      rowEl.className = "row " + r.status + (i === split && i > 0 ? " lane" : "") + (i === 0 && !newest ? " newest" : "");
      if (newest) { void rowEl.offsetWidth; rowEl.classList.add("newest"); this.topToken = r.token; }
      rowEl.dataset.token = r.token;
      COLS.forEach((k, ci) => {
        const cell = cells[ci];
        const link = k === "token" ? href("/t/" + r.token) : null;
        if (cell.textContent !== v[k] || (link && !cell.querySelector("a"))) {
          if (animate) { flipCell(cell, v[k], link); flips++; }
          else { cell.textContent = ""; link ? cell.append(el("a", { href: link, text: v[k] })) : cell.textContent = v[k]; }
        }
      });
    });
    if (animate && flips) clack.play();
  }

  applyReplay(replay) {
    const rows = (replay.rows || []).slice(0, ROWS);
    this.changed = rows.filter((r) => r.status !== "boarding");
    this.fresh = rows.filter((r) => r.status === "boarding");
    this.rebalance();
    this.losses = (replay.losses || []).slice(0, TAPE);
    this.paint(true);
    this.paintTape();
    if (replay.counters) this.paintCounters(replay.counters);
    paintCa(replay.ca ?? null);
  }

  onLaunch(e) {
    if (this.rows.some((r) => r.token === e.token)) return;
    this.fresh.unshift({ token: e.token, symbol: e.symbol, name: e.name, flight: e.flight, deployer: e.deployer, pair: e.pair, pairSymbol: e.pairSymbol, ts: e.ts, status: "boarding", statusTs: e.ts });
    this.rebalance();
    this.paint(true);
  }

  /**
   * A token died or arrived. It moves to the changes lane whether or not it was on the board:
   * most deaths happen ten minutes or more after launch, long after the line scrolled off, and
   * the status event carries the rest of the row for exactly that case.
   */
  onStatus(token, status, ts, ev = {}) {
    if (status === "boarding") return;
    const known = this.fresh.find((x) => x.token === token) || this.changed.find((x) => x.token === token);
    const row = known || {
      token,
      symbol: ev.symbol || "?",
      name: ev.symbol || "?",
      flight: ev.flight || "RK-?",
      deployer: ev.deployer || "",
      pair: ev.pair || "",
      pairSymbol: ev.pairSymbol || "?",
      ts: ev.launchTs || ts,
      statusTs: ts,
    };
    row.status = status;
    row.statusTs = ts;
    this.fresh = this.fresh.filter((x) => x.token !== token);
    this.changed = [row].concat(this.changed.filter((x) => x.token !== token));
    this.rebalance();
    this.paint(true);
  }

  onLoss(e) {
    this.losses.unshift(e);
    this.losses = this.losses.slice(0, TAPE);
    this.paintTape(true);
  }

  paintTape(fresh = false) {
    if (!this.tape) return;
    this.tape.innerHTML = "";
    if (!this.losses.length) {
      this.tape.append(el("li", { class: "none", text: "No passengers reported yet. Boarding continues." }));
      return;
    }
    this.losses.forEach((l, i) => {
      const li = el("li", { class: fresh && i === 0 ? "fresh" : "" }, [
        el("a", { href: href("/r/" + l.wallet), title: l.wallet, text: short(l.wallet) }),
        " · ",
        el("span", { class: "loss", text: "−" + usd(l.lossUsd) }),
        " · ",
        el("a", { href: href("/t/" + l.token), text: l.symbol }),
        " · " + afterBoarding(l.minutesSinceBuy),
      ]);
      this.tape.append(li);
    });
  }

  paintCounters(c) {
    const { lost, days, turb, turbLabel } = this.counters;
    if (lost) lost.textContent = usdCompact(c.lostTodayUsd);
    if (days) days.textContent = num(c.daysSinceCancelled);
    if (turb && c.turbulence) turb.textContent = String(c.turbulence.score);
    if (turbLabel && c.turbulence) turbLabel.textContent = c.turbulence.label;
  }

  handle(kind, data) {
    switch (kind) {
      case "replay": return this.applyReplay(data);
      case "launch": return this.onLaunch(data);
      case "status": return this.onStatus(data.token, data.status, data.ts, data);
      case "graduate": return this.onStatus(data.token, "arrived", data.ts, data);
      case "loss": return this.onLoss(data);
      case "counters": return this.paintCounters(data);
      default: return undefined;
    }
  }
}

// ---------------------------------------------------------------- the stream

function setLive(on, label) {
  const l = $("#live");
  if (!l) return;
  l.classList.toggle("on", on);
  const t = $("span", l);
  if (t) t.textContent = label;
}

function connect(board) {
  let es;
  let lastId = null;
  const open = () => {
    const url = "/api/board" + (lastId ? "?since=" + encodeURIComponent(lastId) : "");
    es = new EventSource(url);
    for (const kind of ["replay", "launch", "status", "graduate", "loss", "counters"]) {
      es.addEventListener(kind, (ev) => {
        if (ev.lastEventId) lastId = ev.lastEventId;
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        board.handle(kind, data);
        setLive(true, "live");
      });
    }
    es.onopen = () => setLive(true, "live");
    es.onerror = () => setLive(false, "reconnecting");
  };
  open();
}

// ---------------------------------------------------------------- the mock stream

const MOCK_SYMBOLS = [
  ["COPEBAG", "Cope Bag"], ["HOODWINK", "Hoodwink"], ["EXITLIQ", "Exit Liquidity"], ["GATE67", "Gate 67"], ["LAYOVER", "Layover"],
  ["TARMAC", "Tarmac"], ["STANDBY", "Standby"], ["REDEYE", "Red Eye"], ["CABINCREW", "Cabin Crew"], ["LOSTBAG", "Lost Bag"],
];

async function simulate(board) {
  const res = await fetch(apiUrl("/api/board"), { cache: "no-cache" });
  const replay = await res.json();
  const nowTs = () => Math.floor(Date.now() / 1000);
  const shift = nowTs() - (replay.counters?.ts || nowTs());
  // re-time the fixture to now so the board reads as live
  replay.rows.forEach((r) => { r.ts += shift; r.statusTs += shift; });
  replay.losses.forEach((l) => { l.ts += shift; });
  replay.counters.ts = nowTs();
  board.handle("replay", replay);
  setLive(true, "mock");

  let flight = Math.max(...replay.rows.map((r) => Number(String(r.flight).replace("RK-", "")) || 0));
  let lostToday = replay.counters.lostTodayUsd;
  let lossIdx = 0;
  let step = 0;
  const rnd = (n) => Math.floor(Math.random() * n);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[rnd(16)]).join("");

  const tick = () => {
    step++;
    const kind = step % 3;
    if (kind === 1) {
      const [symbol, name] = MOCK_SYMBOLS[rnd(MOCK_SYMBOLS.length)];
      const pair = rnd(4) === 0 ? ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "NVDA"] : ["0x0000000000000000000000000000000000000000", "ETH"];
      board.handle("launch", { kind: "launch", token: "0x" + hex(40), symbol, name, deployer: "0x" + hex(40), pair: pair[0], pairSymbol: pair[1], ts: nowTs(), flight: "RK-" + (++flight) });
    } else if (kind === 2) {
      const candidates = board.rows.filter((r) => r.status === "boarding");
      if (candidates.length) {
        const r = candidates[rnd(candidates.length)];
        const age = nowTs() - r.ts;
        const roll = rnd(10);
        if (roll < 2) board.handle("graduate", { kind: "graduate", token: r.token, symbol: r.symbol, ts: nowTs() });
        else board.handle("status", { kind: "status", token: r.token, symbol: r.symbol, status: age < 600 && roll < 8 ? "cancelled" : "departed", ts: nowTs() });
      }
    } else {
      const l = { ...replay.losses[lossIdx++ % replay.losses.length], ts: nowTs() };
      lostToday += l.lossUsd;
      board.handle("loss", l);
    }
  };
  setInterval(tick, 2200);
  setInterval(() => {
    board.handle("counters", { ...replay.counters, lostTodayUsd: lostToday, ts: nowTs() });
  }, 5000);
}

// ---------------------------------------------------------------- boot

export function initBoard() {
  const root = $("#board");
  if (!root) return null;
  const board = new Board(root);

  const btn = $("#soundToggle");
  if (btn) {
    const paint = () => { btn.setAttribute("aria-pressed", clack.on ? "true" : "false"); btn.textContent = "Sound: " + (clack.on ? "on" : "off"); };
    btn.addEventListener("click", () => { clack.set(!clack.on); paint(); });
    paint();
  }

  if (isMock()) simulate(board).catch(() => setLive(false, "mock failed"));
  else if ("EventSource" in window) connect(board);
  else setLive(false, "no live stream");
  return board;
}

