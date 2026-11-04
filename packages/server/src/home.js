// Home & sleep: a sunrise alarm (wake-up), a sleep timer (wind-down) and an ambient plan for the day (what the room
// shows, hour by hour, when no music plays). No Node.js modules, so it runs on the server and in the online demo.
//
// Everything here follows the wall clock (`now()`, injectable for tests) and draws through two hooks in the director:
// - `ambientHook` replaces the ambient effect with the plan's look for this hour (crossfaded when the hour changes);
// - `post` runs after the show is drawn and before the live pads, so the sunrise and the wind-down sit on top of the
//   show while flash, strobe and blackout still work.
// The sunrise is drawn at an absolute brightness (it divides out the brightness slider, idle brightness and night
// mode's cap, which the runtime applies afterwards), because an alarm has to get bright even at 6 am in night mode.
import { inWindow } from "./sun.js";
import { idleSignals } from "../../engine/src/index.js";
import { merge } from "./defaults.js";

const MIN = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/, SUN = /^(sunrise|sunset)([+-]\d{1,3})?$/;
const okTime = t => HM.test(t) || SUN.test(t);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const smooth = k => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const hexRgb = h => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

/** A colour temperature (1000–10000 K) as RGB 0..1, brightest channel 1 (Tanner Helland's fit of the black-body curve). */
export function kelvinRGB(k) {
  const t = clamp(Number(k) || 2700, 1000, 10000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, b].map(v => clamp(v, 0, 255) / 255), m = Math.max(...c); return c.map(v => v / m);
}

/** The sunrise's colour at progress p (0..1): deep red, red, orange, amber, then the chosen end colour. */
export function sunriseColor(p, end = [1, 0.82, 0.62]) {
  const S = [[0, [0.5, 0.02, 0]], [0.25, [1, 0.1, 0]], [0.5, [1, 0.35, 0.04]], [0.75, [1, 0.6, 0.25]], [1, end]];
  p = clamp(p, 0, 1); for (let i = 1; i < S.length; i++) if (p <= S[i][0]) return lerp3(S[i - 1][1], S[i][1], (p - S[i - 1][0]) / (S[i][0] - S[i - 1][0]));
  return end.slice();
}
/** How bright the sunrise is at progress p, 0..1 of the end brightness: a faint glow first, most of the light at the end (eyes see it about linearly). */
export const sunriseLevel = p => { p = clamp(p, 0, 1); return 0.01 + 0.99 * p * p; };

/** Piecewise-linear keyframes [{t, p}] -> value at time t (held before the first and after the last). */
export function keyAt(keys, t) {
  if (!keys.length) return 0; if (t <= keys[0].t) return keys[0].p;
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) { const a = keys[i - 1], b = keys[i]; return b.t === a.t ? b.p : lerp(a.p, b.p, (t - a.t) / (b.t - a.t)); }
  return keys[keys.length - 1].p;
}

/** The plan row for Date `d` (the first that matches; rows may cross midnight), or -1. */
export function planIndex(rows, d, loc) { for (let i = 0; i < rows.length; i++) if (inWindow(rows[i].from, rows[i].to, d, loc)) return i; return -1; }

/**
 * When does a sunrise asked for with {inMinutes, at, duration} start and reach full light? `at` is the alarm: a time
 * like "07:00" (the next one), an ISO date, or milliseconds since 1970 (Tasker's %na_time_ms). No alarm: start now.
 * An alarm closer than the duration starts now and rises faster; one that has just passed gives a full sunrise from now.
 */
export function wakeWindow({ inMinutes, at, duration } = {}, nowMs, defMin = 30) {
  const dur = clamp(Math.round(Number(duration ?? defMin) || defMin), 1, 120) * MIN;
  let end = null;
  if (at !== undefined && at !== null && at !== "") {
    if (typeof at === "number" || /^\d{10,14}$/.test(String(at))) { const n = Number(at); end = n < 1e11 ? n * 1000 : n; } // seconds or ms
    else if (HM.test(String(at))) { const d = new Date(nowMs), [h, m] = String(at).split(":").map(Number); d.setHours(h, m, 0, 0); if (+d <= nowMs - MIN) d.setDate(d.getDate() + 1); end = +d; }
    else { end = Date.parse(String(at)); if (!Number.isFinite(end)) return null; }
    if (end > nowMs + 36 * 60 * MIN) return null;
  } else if (inMinutes !== undefined && inMinutes !== null && inMinutes !== "" && Number(inMinutes) > 0) end = nowMs + clamp(Number(inMinutes), 0, 24 * 60) * MIN;
  if (end === null || !Number.isFinite(end)) return { start: nowMs, end: nowMs + dur, dur };
  if (end < nowMs + MIN) return { start: nowMs, end: nowMs + dur, dur }; // the alarm has just gone off: the whole sunrise from now
  return { start: Math.max(nowMs, end - dur), end, dur };
}

export const DEFAULT_PLAN_ROWS = () => [
  { name: "Morning", from: "07:00", to: "09:00", look: "white", palette: "auto", kelvin: 5000, brightness: 0.8 },
  { name: "Daytime", from: "09:00", to: "17:00", look: "white", palette: "auto", kelvin: 4000, brightness: 0.6 },
  { name: "Evening", from: "17:00", to: "21:00", look: "lavablobs", palette: "sunset", kelvin: null, brightness: 0.55 },
  { name: "Late evening", from: "21:00", to: "23:00", look: "candle", palette: "auto", kelvin: 2400, brightness: 0.3 },
  { name: "Night", from: "23:00", to: "07:00", look: "night", palette: "auto", kelvin: 2200, brightness: 0.12 },
];
export const HOME_DEFAULTS = () => ({
  wake: { enabled: false, source: "times", days: ["", "07:00", "07:00", "07:00", "07:00", "07:00", ""], duration: 30, target: "all", endColor: "#ffd2a1", endBrightness: 1, holdMin: 30, snoozeMin: 9, key: "" },
  sleep: { minutes: 30 },
  plan: { enabled: false, fade: 90, rows: DEFAULT_PLAN_ROWS() },
  state: { wake: null, next: null, sleep: null, done: [] }, // the sunrise running now, the next one asked for, the sleep timer (kept over a restart), weekly alarms already handled
});
const NIGHT_LOOK = { name: "Night", look: "night", palette: "auto", kelvin: 2200, brightness: 0.12 };

/**
 * @param {{store:{data:object, save():void}, runtime:object, now?:()=>Date, randomToken?:()=>string}} o
 */
export function createHome({ store, runtime, now = () => new Date(), randomToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }) {
  const data = () => store.data, rt = runtime.rt;
  let merged = null; // settings from an older version, a backup or a reset get the missing parts filled in (once per object)
  const H = () => { const d = data(); if (d.home !== merged || !merged) { d.home = merge(HOME_DEFAULTS(), d.home && typeof d.home === "object" ? d.home : {}); if (!d.home.wake.key) d.home.wake.key = randomToken(); merged = d.home; } return d.home; };
  const ms = () => +now();
  const note = (m, l) => runtime.note(m, l);
  const loc = () => data().settings.location;

  // ---------------------------------------------------------------- wake-up
  const STOP_FADE = 4000, END_FADE = 60_000, IN_FADE = 20_000;
  /** Begin (or plan) a sunrise. src: "times" (the weekly alarm), "api" (a phone automation), "button" */
  function wake(b = {}, src = "api", key = null) {
    const h = H(), w = wakeWindow(b, ms(), h.wake.duration); if (!w) return null;
    const st = { id: Math.random().toString(36).slice(2, 8), src, key, start: w.start, end: w.end, keys: [{ t: w.start, p: 0 }, { t: w.end, p: 1 }], holdUntil: w.end + h.wake.holdMin * MIN,
      target: h.wake.target, endColor: h.wake.endColor, endBrightness: h.wake.endBrightness, active: false, wasOff: null, stopAt: null, fadeMs: STOP_FADE, snoozeUntil: null };
    // one that starts later waits as the next sunrise (a phone sends its next alarm whenever it changes, maybe while this one runs)
    if (st.start > ms() + 5000) { h.state.next = st; note(`Wake-up: the sunrise starts at ${hm(st.start)} and is full at ${hm(st.end)}`); }
    else { h.state.wake = st; note(`Wake-up: sunrise until ${hm(st.end)}`); }
    store.save(); tick(); return st;
  }
  const hm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  function snooze(minutes) {
    const h = H(), w = h.state.wake, t = ms(); if (!w || !w.active || w.stopAt) return null;
    const m = clamp(Number(minutes ?? h.wake.snoozeMin) || h.wake.snoozeMin, 1, 60) * MIN, p0 = keyAt(w.keys, t), low = Math.min(p0, 0.3);
    w.keys = [{ t, p: p0 }, { t: t + 5000, p: low }, { t: t + m, p: low }, { t: t + m + 3 * MIN, p: 1 }]; // dim to a glow, then back up after the snooze
    w.snoozeUntil = t + m; w.holdUntil = t + m + 3 * MIN + h.wake.holdMin * MIN; store.save(); note(`Wake-up: snoozed until ${hm(t + m)}`); return w;
  }
  /** Stop the sunrise that is running (it fades back to the show). A sunrise still to come is kept: see skip(). */
  function stopWake(why = "stopped") {
    const w = H().state.wake; if (!w || !w.active) return false;
    if (!w.stopAt) { w.stopAt = ms(); w.fadeMs = STOP_FADE; store.save(); note(`Wake-up: ${why}`); }
    return true;
  }
  /** Cancel the next sunrise: the one a phone asked for, or else the next weekly alarm. */
  function skip() {
    const h = H(); if (h.state.next) { h.state.next = null; store.save(); note("Wake-up: the next sunrise is cancelled"); return true; }
    const nw = nextWeekly(ms()); if (!nw) return false; h.state.done = [...h.state.done.slice(-20), nw.key]; store.save(); note(`Wake-up: skipping the alarm at ${hm(nw.end)}`); return true;
  }
  const wakeProgress = (w, t) => keyAt(w.keys, t);
  function wakeMix(w, t) { // how much the sunrise covers the show: fades in at the start, out when stopped or done
    let m = w.wasOff ? 1 : smooth((t - w.start) / IN_FADE);
    if (w.stopAt) m *= 1 - clamp((t - w.stopAt) / w.fadeMs, 0, 1);
    return m;
  }
  // the next weekly alarm from `from` (ms): {end, key} or null
  function nextWeekly(from) {
    const h = H(), wk = h.wake; if (!wk.enabled || wk.source !== "times") return null;
    for (let k = 0; k < 8; k++) { const d = new Date(from); d.setDate(d.getDate() + k); const t = wk.days[d.getDay()]; if (!t || !HM.test(t)) continue;
      const [hh, mm] = t.split(":").map(Number); d.setHours(hh, mm, 0, 0); const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${t}`;
      if (+d + MIN > from && !h.state.done.includes(key)) return { end: +d, key }; }
    return null;
  }

  // ---------------------------------------------------------------- wind-down (sleep timer)
  function sleep(minutes) {
    const h = H(), t = ms(), m = clamp(Math.round(Number(minutes ?? h.sleep.minutes) || 30), 1, 180);
    if (h.state.wake?.active && !h.state.wake.stopAt) stopWake("stopped for the sleep timer");
    if (!data().show.power) runtime.setPower(true);
    h.state.sleep = { start: t, end: t + m * MIN, bri: data().settings.brightness, power: true }; store.save();
    note(`Sleep timer: the lights fade out over ${m} minutes`); return h.state.sleep;
  }
  function cancelSleep(why = "cancelled") { const h = H(); if (!h.state.sleep) return false; h.state.sleep = null; store.save(); note(`Sleep timer ${why}`); return true; }

  // ---------------------------------------------------------------- ambient plan
  // cur: the row index now (-1: no row, "night": night mode's hours), undefined while the plan is off. The looks are
  // copies, so a fade from a row that has just been edited starts from what was really showing.
  const plan = { cur: undefined, curLook: null, prevLook: null, fading: false, since: 0, k: 1, buf: null, at: -1, night: false, seen: false, rowsRef: null };
  const lookIn = (rows, key) => key === "night" ? NIGHT_LOOK : typeof key === "number" && key >= 0 && rows?.[key] ? { ...rows[key] } : null;
  /** Which look the plan wants now (crossfading from the last one); worked out once per millisecond. */
  function planNow() {
    const t = ms(); if (plan.at === t) return plan; plan.at = t;
    const h = H(), on = !!h.plan.enabled, rows = h.plan.rows; let key = -1, night = false;
    if (on) { const d = new Date(t), i = planIndex(rows, d, loc()); night = i >= 0 && rows[i].look === "night";
      key = rt.night && !night && windowNight(d) ? "night" : i; } // night mode's own hours win: the night look then
    plan.night = night;
    const to = look => { plan.prevLook = plan.cur === undefined ? null : plan.curLook; plan.fading = true; plan.since = t; plan.curLook = look; };
    if (plan.cur === undefined) { if (!on) { plan.fading = false; plan.seen = true; return plan; }
      if (plan.seen) to(lookIn(rows, key)); else plan.curLook = lookIn(rows, key); plan.cur = key; } // just turned on: fade in from the usual ambient (not at startup)
    else if (key !== plan.cur || plan.rowsRef !== rows) { to(on ? lookIn(rows, key) : null); plan.cur = key; } // a new hour, or the rows were edited
    plan.rowsRef = rows; plan.seen = true;
    plan.k = plan.fading ? smooth((t - plan.since) / (Math.max(1, h.plan.fade) * 1000)) : 1;
    if (plan.k >= 1) plan.fading = false;
    if (!on && !plan.fading) { plan.cur = undefined; plan.curLook = null; } // turned off: faded back to the usual ambient
    return plan;
  }
  const windowNight = d => { const n = data().settings.night; return !!(n && n.enabled && inWindow(n.from, n.to, d, loc())); };
  const lookBri = L => L ? (L.look === "night" ? Math.min(L.brightness, data().settings.night?.maxBrightness ?? 1) : L.brightness) : data().settings.idleBrightness;
  /** Idle brightness while the plan runs (the runtime multiplies by it when nothing plays), or undefined. */
  function idleBrightness() { const p = planNow(); if (p.cur === undefined) return undefined; const a = lookBri(p.curLook); return p.fading ? lerp(lookBri(p.prevLook), a, p.k) : a; }
  function renderLook(L, t, out) {
    const fx = runtime.effects, D = runtime.director, has = id => fx.list.some(e => e.id === id);
    if (!L) { const id = data().settings.ambient; if (id === "off" || !has(id)) { out.fill(0); return; } const pal = data().show.palette, P = fx.palettes[pal] && pal !== "auto" ? fx.palettes[pal] : fx.palettes.auto[0];
      fx.render(id, idleSignals(t * (D.settings.speed || 1), P, pal !== "auto"), out); return; }
    const kc = L.kelvin ? kelvinRGB(L.kelvin) : null, id = L.look === "night" ? "candle" : L.look;
    if (L.look === "white" || !has(id)) { const c = kc || kelvinRGB(4000); for (let i = 0; i < out.length; i += 3) { out[i] = c[0] * 0.9; out[i + 1] = c[1] * 0.9; out[i + 2] = c[2] * 0.9; } return; }
    const P = L.palette && L.palette !== "auto" && fx.palettes[L.palette] ? fx.palettes[L.palette] : fx.palettes.auto[0];
    fx.render(id, idleSignals(t, P, !!(L.palette && L.palette !== "auto")), out);
    if (kc) for (let i = 0; i < out.length; i += 3) { const m = Math.max(out[i], out[i + 1], out[i + 2]); out[i] = kc[0] * m; out[i + 1] = kc[1] * m; out[i + 2] = kc[2] * m; } // the effect's movement in that colour temperature
  }
  function ambientHook(t, out) {
    const p = planNow(); if (p.cur === undefined || (!p.curLook && !p.fading)) return false; // off, or a gap in the plan: the usual ambient effect
    renderLook(p.curLook, t, out);
    if (p.fading) { if (!plan.buf || plan.buf.length !== out.length) plan.buf = new Float32Array(out.length);
      renderLook(p.prevLook, t, plan.buf); const k = p.k; for (let i = 0; i < out.length; i++) out[i] = plan.buf[i] * (1 - k) + out[i] * k; }
    return true;
  }

  // ---------------------------------------------------------------- drawing: after the show, before the pads
  let mask = null, maskKey = "";
  function targetMask(target) {
    const L = runtime.layout, key = target; if (mask && maskKey === key && mask.L === L) return mask.m;
    const shapes = data().room.shapes, m = new Uint8Array(L.N);
    const [kind, id] = String(target || "all").split(/:(.*)/s);
    for (let i = 0; i < L.N; i++) { const sh = shapes[L.LF[i]]; m[i] = kind === "zone" ? (sh?.zone === id ? 1 : 0) : kind === "dev" ? (sh?.dev === id ? 1 : 0) : 1; }
    if (!m.some(Boolean)) m.fill(1); // the zone or controller is gone: the whole room
    mask = { L, m }; maskKey = key; return m;
  }
  const inv = x => -Math.log(1 - Math.min(0.995, Math.max(0, x))) / 1.6; // undo toRGB8's soft roll-off: output x (0..1) of full
  function post(COL) {
    const h = H(), t = ms(), S = h.state;
    if (S.sleep) { const p = clamp((t - S.sleep.start) / (S.sleep.end - S.sleep.start), 0, 1), f = (1 - p) * (1 - p), w = smooth(p / 0.3), wc = kelvinRGB(2200);
      for (let i = 0; i < COL.length; i += 3) { const r = COL[i], g = COL[i + 1], b = COL[i + 2], m = Math.max(r, g, b);
        COL[i] = lerp(r, wc[0] * m, w) * f; COL[i + 1] = lerp(g, wc[1] * m, w) * f; COL[i + 2] = lerp(b, wc[2] * m, w) * f; } }
    const W = S.wake; if (!W || !W.active) return;
    const mix = wakeMix(W, t); if (mix <= 0) return;
    const p = wakeProgress(W, t), c = sunriseColor(p, hexRgb(W.endColor)), lv = sunriseLevel(p) * W.endBrightness, bri = Math.max(1e-3, rt.bri ?? 1);
    const L = runtime.layout, m = targetMask(W.target), PY = L.PY || L.LY, v = [0, 0, 0];
    // while the sun is low, the light is a little stronger low down, like a glow on the horizon
    for (let i = 0; i < L.N; i++) { const j = i * 3;
      if (!m[i]) { if (W.wasOff) { COL[j] *= 1 - mix; COL[j + 1] *= 1 - mix; COL[j + 2] *= 1 - mix; } continue; }
      const sky = 1 - 0.35 * (1 - p) * clamp(PY ? PY[i] : 0.5, 0, 1);
      for (let k = 0; k < 3; k++) v[k] = inv(c[k] * lv * sky) / bri;
      COL[j] = lerp(COL[j], v[0], mix); COL[j + 1] = lerp(COL[j + 1], v[1], mix); COL[j + 2] = lerp(COL[j + 2], v[2], mix); }
  }

  // ---------------------------------------------------------------- once a second: start, end, cancel
  let lastPower = null, lastNight = false;
  function tick() {
    const h = H(), t = ms(), S = h.state, show = data().show;
    // the weekly alarm
    const nw = nextWeekly(t - MIN);
    if (nw && t >= nw.end - h.wake.duration * MIN && t < nw.end + 5 * MIN && (!S.wake || S.wake.key !== nw.key)) {
      S.done = [...S.done.slice(-20), nw.key];
      if (!(S.wake && S.wake.active && !S.wake.stopAt)) wake({ at: nw.end }, "times", nw.key); else store.save(); // a sunrise is already running (the phone's): that one it is
    }
    if (S.next && t >= S.next.start) { S.wake = S.next; S.next = null; } // the planned sunrise's time has come
    if (S.next && S.next.end < t) S.next = null;
    const W = S.wake;
    if (W && !W.active && t >= W.start) { // the sunrise begins
      W.active = true; W.wasOff = !show.power; if (S.sleep) cancelSleep("stopped for the sunrise");
      if (W.wasOff) runtime.setPower(true); store.save(); note("Wake-up: the sunrise has started");
    } else if (W && W.active) {
      if (lastPower === true && !show.power) { S.wake = null; store.save(); note("Wake-up: stopped (lights switched off)"); } // no more sunrise
      else if (!W.stopAt && t >= W.holdUntil) { W.stopAt = t; W.fadeMs = END_FADE; note("Wake-up: done, back to the usual lights"); }
      if (W.stopAt && t >= W.stopAt + W.fadeMs) { S.wake = null; store.save(); }
    }
    if (S.sleep) { const sl = S.sleep;
      if (Math.abs(data().settings.brightness - sl.bri) > 1e-6) cancelSleep("cancelled: brightness changed");
      else if (!show.power) cancelSleep("cancelled: lights switched off");
      else if (t >= sl.end) { S.sleep = null; store.save(); note("Sleep timer: good night"); runtime.setPower(false); } }
    lastPower = show.power;
    // the plan's night rows turn night mode on
    const p = planNow(); if (p.night !== lastNight) { lastNight = p.night; rt.planNight = p.night; runtime.updateNight(); }
  }

  // ---------------------------------------------------------------- status and settings
  function status() {
    const h = H(), t = ms(), S = h.state, W = S.wake || S.next, nw = nextWeekly(t);
    let wakeSt = null;
    if (W) { const p = wakeProgress(W, t); wakeSt = { phase: !W.active ? "pending" : W.stopAt ? "ending" : W.snoozeUntil && t < W.snoozeUntil ? "snoozed" : p < 1 ? "rising" : "holding",
      start: new Date(W.start).toISOString(), end: new Date(W.end).toISOString(), progress: W.active ? Math.round(p * 100) / 100 : 0, snoozeUntil: W.snoozeUntil ? new Date(W.snoozeUntil).toISOString() : null }; }
    const sl = S.sleep ? { start: new Date(S.sleep.start).toISOString(), end: new Date(S.sleep.end).toISOString(), progress: Math.round(clamp((t - S.sleep.start) / (S.sleep.end - S.sleep.start), 0, 1) * 100) / 100, left: Math.max(0, Math.round((S.sleep.end - t) / 1000)) } : null;
    const pl = planNow(), L = pl.cur === undefined ? undefined : pl.curLook;
    const nx = S.next ? S.next.end : nw && !(W && W.key === nw.key) ? nw.end : null;
    return { wake: wakeSt, nextWake: nx ? new Date(nx).toISOString() : null, sleep: sl,
      plan: L === undefined ? null : { name: L ? L.name : "Usual ambient", index: typeof pl.cur === "number" ? pl.cur : -1, night: pl.cur === "night" || pl.night, fading: pl.fading } };
  }
  function pub(admin) {
    const h = H(); if (admin && !h.wake.key) { h.wake.key = randomToken(); store.save(); }
    return { wake: { ...h.wake, key: admin ? h.wake.key : undefined }, sleep: h.sleep, plan: h.plan, status: status() };
  }
  /** Change the settings; throws Error with .code 400 on bad input. ids: effect ids, palettes: palette names. */
  function update(b = {}) {
    const h = H(), bad = m => { const e = new Error(m); e.code = 400; throw e; };
    const fx = runtime.effects, ids = new Set(fx.list.map(e => e.id));
    if (b.wake) { const w = b.wake, o = { ...h.wake };
      if (w.enabled !== undefined) o.enabled = !!w.enabled;
      if (w.source !== undefined) { if (!["times", "phone"].includes(w.source)) bad("Wake-up source is times or phone"); o.source = w.source; }
      if (w.days !== undefined) { if (!Array.isArray(w.days) || w.days.length !== 7 || !w.days.every(x => x === "" || x === null || HM.test(x))) bad("Wake-up days are 7 times like 07:00 (Sunday first), or empty for no alarm"); o.days = w.days.map(x => x || ""); }
      if (w.duration !== undefined) { const n = Math.round(Number(w.duration)); if (!(n >= 10 && n <= 40)) bad("The sunrise takes 10 to 40 minutes"); o.duration = n; }
      if (w.target !== undefined) { const tg = String(w.target); if (!/^(all|zone:.{1,40}|dev:.{1,40})$/s.test(tg)) bad("Target is all, zone:<id> or dev:<id>"); o.target = tg; }
      if (w.endColor !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(w.endColor)) bad("End colour looks like #ffd2a1"); o.endColor = w.endColor.toLowerCase(); }
      if (w.endBrightness !== undefined) o.endBrightness = clamp(Number(w.endBrightness) || 0, 0.05, 1);
      if (w.holdMin !== undefined) o.holdMin = clamp(Math.round(Number(w.holdMin) || 0), 0, 120);
      if (w.snoozeMin !== undefined) o.snoozeMin = clamp(Math.round(Number(w.snoozeMin) || 9), 1, 30);
      h.wake = { ...o, key: h.wake.key }; // the key only changes through POST /api/wake/key
      if (!o.enabled) h.state.next = null;
    }
    if (b.sleep) { if (b.sleep.minutes !== undefined) h.sleep.minutes = clamp(Math.round(Number(b.sleep.minutes) || 30), 5, 180); }
    if (b.plan) { const p = b.plan, o = { ...h.plan };
      if (p.enabled !== undefined) o.enabled = !!p.enabled;
      if (p.fade !== undefined) o.fade = clamp(Math.round(Number(p.fade) || 90), 5, 900);
      if (p.reset) o.rows = DEFAULT_PLAN_ROWS();
      if (p.rows !== undefined) { if (!Array.isArray(p.rows) || p.rows.length > 12) bad("The plan is a list of at most 12 rows");
        o.rows = p.rows.map((r, i) => { const name = String(r.name || `Row ${i + 1}`).slice(0, 40);
          if (!okTime(r.from) || !okTime(r.to)) bad(`${name}: times look like 07:00, sunset or sunrise+30`);
          if (r.from === r.to) bad(`${name}: from and to are the same`);
          if ((SUN.test(r.from) || SUN.test(r.to)) && !data().settings.location) bad("Set your location in Settings first, so Tempolight knows when the sun rises and sets");
          const look = String(r.look || "white"); if (!["white", "night"].includes(look) && !ids.has(look)) bad(`${name}: unknown effect "${look}"`);
          const palette = r.palette && r.palette !== "auto" ? String(r.palette) : "auto"; if (palette !== "auto" && !fx.palettes[palette]) bad(`${name}: unknown colours "${palette}"`);
          const kelvin = r.kelvin === null || r.kelvin === undefined || r.kelvin === "" ? null : clamp(Math.round(Number(r.kelvin) || 2700), 1800, 6500);
          return { name, from: r.from, to: r.to, look, palette, kelvin: look === "white" && !kelvin ? 4000 : kelvin, brightness: clamp(Number(r.brightness ?? 0.5) || 0, 0, 1) }; }); }
      h.plan = o; }
    store.save(); tick(); return pub(true);
  }
  function newKey() { const h = H(); h.wake.key = randomToken(); store.save(); note("Wake-up: a new link key was made; update your phone automations"); return h.wake.key; }
  const keyOk = k => { const real = H().wake.key; if (!real || typeof k !== "string" || k.length !== real.length) return false; let x = 0; for (let i = 0; i < k.length; i++) x |= k.charCodeAt(i) ^ real.charCodeAt(i); return x === 0; };
  /** Home Assistant buttons and other one-word commands. */
  function command(word) { if (word === "sleep") return !!sleep(); if (word === "wake") return !!wake({}, "button"); if (word === "wake_stop") return stopWake(); if (word === "wake_snooze") return !!snooze(); if (word === "sleep_cancel") return cancelSleep(); return false; }

  // hook into the runtime and the director (the director is made again when the room changes; its settings carry over)
  H();
  Object.assign(runtime.director.settings, { ambientHook, post });
  rt.home = { idleBrightness, status };
  const timer = setInterval(() => { try { tick(); } catch (e) { note(`Home & sleep: ${e.message}`, "error"); } }, 1000);
  tick();
  const enabled = () => !!H().wake.enabled;
  return { wake, snooze, stopWake, skip, enabled, sleep, cancelSleep, update, pub, status, tick, newKey, keyOk, command, planNow, close() { clearInterval(timer); } };
}

/** The API routes. need(ctx, area) throws when not allowed; changed(what) saves and tells the browsers. */
export function homeRoutes(home, { route, authorised, HttpError, changed }) {
  const keyOf = ctx => ctx.query?.key || ctx.headers?.["x-tempolight-key"] || ctx.body?.key;
  // phone automations: open like the brightness control (guests may, when the PIN lock allows them brightness),
  // or with the link key from Settings → Home & sleep, which works for these calls only
  const phoneOk = ctx => { if (!authorised(ctx, "brightness") && !home.keyOk(keyOf(ctx))) throw new HttpError(403, "Locked: add ?key=<your wake-up link key> (Home & sleep page) or unlock with the PIN"); };
  const res = () => { changed("home"); return home.status(); };
  route("GET", "/api/home", null, ctx => home.pub(authorised(ctx, null)));
  route("PUT", "/api/home", "admin", ctx => { try { const r = home.update(ctx.body); changed("home"); return r; } catch (e) { throw new HttpError(e.code || 400, e.message); } });
  route("POST", "/api/wake/key", "admin", () => { const key = home.newKey(); changed("home"); return { key }; });
  route("POST", "/api/wake", null, ctx => { phoneOk(ctx); const b = ctx.body || {};
    if (!home.enabled()) throw new HttpError(409, "Wake-up is turned off (Home & sleep page)");
    if (b.duration !== undefined && !(Number(b.duration) >= 1 && Number(b.duration) <= 120)) throw new HttpError(400, "duration is 1 to 120 minutes");
    if (!home.wake(b, "api")) throw new HttpError(400, "at is a time like 07:00, an ISO date or milliseconds, within 36 hours"); return res(); });
  route("POST", "/api/wake/snooze", null, ctx => { phoneOk(ctx); home.snooze(ctx.body?.minutes); return res(); });
  route("POST", "/api/wake/stop", null, ctx => { phoneOk(ctx); home.stopWake(); return res(); });
  route("DELETE", "/api/wake", null, ctx => { phoneOk(ctx); home.skip(); return res(); });
  route("POST", "/api/sleep", null, ctx => { phoneOk(ctx); const m = ctx.body?.minutes; if (m !== undefined && !(Number(m) >= 1 && Number(m) <= 180)) throw new HttpError(400, "minutes is 1 to 180"); home.sleep(m); return res(); });
  route("DELETE", "/api/sleep", null, ctx => { phoneOk(ctx); home.cancelSleep(); return res(); });
}
