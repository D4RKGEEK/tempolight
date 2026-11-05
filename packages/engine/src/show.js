// Auto-generated shows: a song's analysis becomes a timeline of effects, picked from the style's pools (build-ups get
// build effects, drops the big ones). The same song always gets the same show, and each block can be changed by hand;
// the director then plays the timeline instead of choosing on the fly.
//
// chooseStep() is the automatic director's choice. The live director and planShow() both call it, so a show is
// exactly what the live director would have played.

import { songView } from "./signals.js";
import { autoPool, lookEffect, hashStr } from "./looks.js";

/** Bump when the planner changes how it chooses, so stored shows that weren't edited by hand are made again. */
export const SHOW_VERSION = 4;

// per effects object: every effect id, and the ones show mode keeps besides the rated ones (your own effects)
const IDS = new WeakMap();
function idsOf(fx) { let v = IDS.get(fx); if (!v) { v = { all: new Set(fx.list.map(e => e.id)), custom: new Set(fx.list.filter(e => e.custom).map(e => e.id)) }; IDS.set(fx, v); } return v; }

/** Liked effects come round twice as often, banned ones never; if everything is banned, the list as it is. */
export function withPrefs(list, prefs = {}) {
  const out = []; for (const id of list || []) { const p = prefs[id]; if (p === -1) continue; out.push(id); if (p === 1) out.push(id); }
  return out.length ? out : list || [];
}

/**
 * How many bars an effect lasts before the next one, counted on the phrase grid (1, 2, 4, 8, 16 bars).
 * "Change every N beats" sets the pace; drops (and loud parts) change look twice as often as the rest. In a drop the
 * effect itself lasts twice as long, and the look in between changes with a variation (mirror and colour flip).
 */
export function swapBars(everyBeats, ST, hot) {
  const n = Math.max(1, (everyBeats || 8) * ((ST && ST.every) || 1) * (hot ? 1 : 2) / 4);
  const b = 2 ** Math.max(0, Math.round(Math.log2(n)));
  return hot && b < 4 ? 2 * b : b;
}
/** Bars between variations in a drop (0: none): every 2 bars, or every bar when effects change every 2 bars. */
export function varyBars(sb, hot) { return hot ? (sb >= 4 ? 2 : Math.max(1, sb / 2)) : 0; }

/**
 * One step of the automatic choice. Changes `s` (the chooser's state) and returns {effect, hard} when the effect
 * should change now (hard: a cut with no crossfade, at a drop), or null.
 * - The song part picks the pool. In "levels" styles a loudness level counts only once it held most of a bar.
 * - A drop switches at once, to a high-impact effect, as a hard cut.
 * - Everything else waits for the next downbeat, and an effect always lasts at least a bar.
 * - Effects change on phrase lines (every swapBars() bars, counted from where the song part started).
 * - Variety "show" (the default) picks only from the effects automatic mode is meant to use (looks.js autoPool());
 *   "one" and "parts" play a look (o.look, looks.js) instead: see lookStep().
 * @param {object} s state: {cur, poolIdx, lastSwitchBeat, ...}; other fields are added as needed
 * @param {{impact?:string[], list:{id:string}[]}} fx from createEffects()
 * @param {object} ST the style (fx.styles[...])
 * @param {{prefs?:object, everyBeats?:number, seed?:number, variety?:"one"|"parts"|"show", look?:object|null}} o
 * @param {number} t
 * @param {object} V songView / LiveAnalyser.view
 */
export function chooseStep(s, fx, ST, o, t, V) {
  const g = V.g || {}, has = !!g.has, P = has && g.P > 0 ? g.P : 0.5;
  // no beat grid yet: count bars of 2 s, so the rules below still have bar lines to wait for
  const beat = has ? g.idx : Math.floor(t / 0.5), bar = has ? g.idx - g.beatInBar : beat - (((beat % 4) + 4) % 4);
  if (!s.poolIdx) s.poolIdx = {};
  if (s.lastSwitchBeat == null) s.lastSwitchBeat = -99;
  // the clock jumped back (a seek, the next song, a recognised song replacing the live clock): count from here
  if (beat < s.lastSwitchBeat || (s.lastBar != null && bar < s.lastBar)) { s.lastSwitchBeat = Math.min(s.lastSwitchBeat, beat); s.secBar = bar; s.switchBar = bar; s.tally = null; }
  const newBar = bar !== s.lastBar && (!has || g.beatInBar === 0); s.lastBar = bar;
  const dt = Math.max(0, Math.min(0.1, t - (s.lastT ?? t))); s.lastT = t;
  const justDropped = V.state === "drop" && V.dropT > -9 && t - V.dropT >= -0.05 && t - V.dropT < 2 * P;
  let sec;
  if (ST.mode === "sections") sec = V.state === "silent" ? "calm" : V.state;
  else { // levels: the level that held most of the last bar (a drop is the peak at once)
    const raw = ST.pools[V.level] ? V.level : "low";
    if (!s.tally) s.tally = {};
    s.tally[raw] = (s.tally[raw] || 0) + dt;
    if (!s.lvl || !ST.pools[s.lvl]) s.lvl = raw;
    const part = V.state === "silent" ? s.part : V.state;
    if (justDropped && ST.pools.peak) s.lvl = "peak";
    else if (newBar && part !== s.part && !(part === "calm" && raw === "peak")) { s.lvl = raw; s.tally = {}; } // a new song part starts on this downbeat: its level counts at once
    else if (newBar) { let best = null, bv = 0; for (const k in s.tally) if (s.tally[k] > bv) { bv = s.tally[k]; best = k; } if (best) s.lvl = best; s.tally = {}; }
    if (newBar) s.part = part;
    sec = s.lvl;
  }
  const hot = sec === "drop" || sec === "peak";
  s.hot = hot;
  if (o.look && (o.variety === "one" || o.variety === "parts")) {
    const r = lookStep(s, fx, o, t, V, { beat, bar, newBar, justDropped });
    if (r !== undefined) return r; // (undefined: the look can't play, everything in it banned: choose as a show does)
  }
  const keep = new Set(idsOf(fx).custom); for (const id in o.prefs || {}) if (o.prefs[id] === 1) keep.add(id);
  const pool = withPrefs(autoPool(ST.pools[sec] || ST.pools.calm || ST.pools.low, keep), o.prefs);
  if (!pool.length) return null;
  if (sec !== s.sec) { s.sec = sec; s.secBar = bar; }
  const wrongPool = !s.chose || !pool.includes(s.cur), seed = o.seed || 0;
  const pick = (key, list) => { if (s.poolIdx[key] == null) s.poolIdx[key] = seed % list.length; const id = list[s.poolIdx[key] % list.length]; s.poolIdx[key]++; return id; };
  let next = null, hard = false;
  const newDrop = hot && justDropped && V.dropT !== s.dropT; if (newDrop) s.dropT = V.dropT;
  if (newDrop && (wrongPool || beat - s.lastSwitchBeat >= 4)) {
    // the drop: a hard cut to a high-impact effect from the pool (one that hits on every kick)
    const imp = new Set(fx.impact || []), list = pool.filter(id => imp.has(id)), from = list.length ? list : pool;
    const recent = s.recent || []; // not one that played a moment ago
    for (let k = 0; k < from.length; k++) { next = pick(sec + "!", from); if (next !== s.cur && !recent.includes(next)) break; }
    hard = true; s.secBar = bar;
  } else if (V.state === "silent" && !wrongPool) return null;
  else if (wrongPool) { // a new song part: on the next downbeat, and never less than a bar after the last change
    const banned = !!(o.prefs && s.cur && o.prefs[s.cur] === -1); // an effect banned just now goes at once
    if (!banned && (!newBar || beat - s.lastSwitchBeat < 4)) return null;
    next = pick(sec, pool); s.secBar = bar;
  } else if (newBar) { // a phrase line: every swapBars() bars from where this part started
    const n = Math.round((bar - (s.secBar ?? bar)) / 4), sb = swapBars(o.everyBeats, ST, hot);
    if (n <= 0 || n % sb !== 0 || beat - s.lastSwitchBeat < 4) return null;
    next = pick(sec, pool);
  } else return null;
  s.lastSwitchBeat = beat; s.chose = true;
  // the same effect again (it just opened the drop, say): the next one, unless it is a liked effect, listed twice, that plays on
  if (next === s.cur && !hard && pool.length > 1 && pool.indexOf(next) === pool.lastIndexOf(next)) next = pick(sec, pool);
  if (next === s.cur) return null;
  s.cur = next; s.switchBar = bar; s.recent = [next, ...(s.recent || [])].slice(0, 6);
  return { effect: next, hard };
}

/**
 * One step of playing a look: the effect for the song part (lookEffect()), changed at once at a drop (a hard cut) and
 * otherwise on the next downbeat, at least a bar after the last change. A new drop also restarts the drop's 2-bar
 * variations (s.switchBar). Returns {effect, hard}, null (no change) or undefined (no effect of the look can play).
 */
export function lookStep(s, fx, o, t, V, { beat, bar, newBar, justDropped }) {
  const ids = idsOf(fx).all, ok = id => !!id && ids.has(id) && !(o.prefs && o.prefs[id] === -1);
  const part = V.state === "silent" ? (s.lookPart || "calm") : V.state; s.lookPart = part;
  let want = lookEffect(o.look, o.variety, part); if (!ok(want)) want = ok(o.look.main) ? o.look.main : ok(o.look.calm) ? o.look.calm : null;
  if (!want) return undefined;
  const newDrop = V.state === "drop" && justDropped && V.dropT !== s.dropT; if (newDrop) { s.dropT = V.dropT; s.switchBar = bar; }
  if (s.chose && want === s.cur) return null;
  let hard = false;
  if (s.chose && s.cur != null) {
    if (newDrop) hard = true;
    else if (ok(s.cur) && (!newBar || beat - s.lastSwitchBeat < 4)) return null; // (an effect banned just now goes at once)
  }
  s.lastSwitchBeat = beat; s.chose = true; s.cur = want; s.switchBar = bar; s.recent = [want, ...(s.recent || [])].slice(0, 6);
  return { effect: want, hard };
}

/**
 * The show is what the automatic director would play for this song, written down (chooseStep() with the same
 * pools, preferences and "change every N beats"). So a song with a show looks exactly as lively as one without,
 * and each block can then be changed by hand.
 * @param {{bpm:number, P:number, off:number, barOff:number, bars:{t0:number,t1:number,state:string,level:number}[], env:ArrayLike<number>, style:string, dur:number, kicks:number[], snares:number[], hats:number[], drops:number[]}} pre a song analysis
 * @param {{pools:object, styles:object, impact?:string[]}} fx from createEffects()
 * @param {{seed?:string, prefs?:Record<string,number>, everyBeats?:number, variety?:"one"|"parts"|"show", look?:object|null}} [o] seed "": the director's own order; another seed starts the pools elsewhere (a new show);
 *   variety and look: as the director's settings (a look's show is a block or a few)
 * @returns {{t0:number, t1:number, part:string, effect:string}[]}
 */
export function planShow(pre, fx, o = {}) {
  if (!pre || !pre.dur || !(pre.bars && pre.bars.length)) return [];
  const ST = fx.styles[pre.style] || fx.styles.party, cfg = { prefs: o.prefs || {}, everyBeats: o.everyBeats || 8, seed: o.seed ? hashStr(o.seed) : 0, variety: o.variety || "show", look: o.look || null };
  pre = { kicks: [], snares: [], hats: [], drops: [], env: new Float32Array(0), off: 0, barOff: 0, ...pre }; // tolerate partial analyses
  if (!(pre.P > 0)) pre.P = pre.bpm > 0 ? 60 / pre.bpm : 0.5; // no beat grid: count at 120 BPM
  const out = [], s = { cur: null, poolIdx: {} }; let cur = null, curPart = "calm", t0 = 0;
  const push = (t1, part) => { if (cur && t1 > t0) { const prevB = out.at(-1); if (prevB && prevB.effect === cur) prevB.t1 = r3(t1); else out.push({ t0: r3(t0), t1: r3(t1), part, effect: cur }); } };
  const step = pre.P / 4; // four looks per beat: enough to land on every bar start and song-part change
  for (let t = 0; t < pre.dur; t += step) {
    const V = songView(pre, t), d = chooseStep(s, fx, ST, cfg, t, V);
    if (!d) continue;
    push(t, curPart); cur = d.effect; t0 = out.length === 0 && t < step ? 0 : t;
    curPart = V.state === "silent" ? "calm" : V.state;
  }
  if (!cur) { // everything banned or no pool: the look's effect, or the first effect of the calm pool
    const pool = withPrefs(ST.pools.calm || ST.pools.low, cfg.prefs); cur = (cfg.look && cfg.variety !== "show" && cfg.look.main) || pool[0] || fx.pools.calm[0]; t0 = 0;
  }
  push(pre.dur, curPart);
  // a block shorter than a bar is a flicker, not a look: give its time to the block before (or after) it
  const minLen = Math.max(1, pre.P * 2);
  for (let i = 0; i < out.length; i++) if (out.length > 1 && out[i].t1 - out[i].t0 < minLen) {
    if (i > 0) out[i - 1].t1 = out[i].t1; else out[1].t0 = out[0].t0; out.splice(i, 1); i = Math.max(-1, i - 2); }
  for (let i = 1; i < out.length; i++) if (out[i].effect === out[i - 1].effect) { out[i - 1].t1 = out[i].t1; out.splice(i, 1); i--; }
  if (out.length) { out[0].t0 = 0; out.at(-1).t1 = Math.max(out.at(-1).t1, r3(pre.dur)); }
  return out;
}
const r3 = v => Math.round(v * 1000) / 1000;

/** The block of a show at time t (binary search), or null. */
export function showAt(plan, t) { let lo = 0, hi = plan.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (plan[m].t1 <= t) lo = m + 1; else if (plan[m].t0 > t) hi = m - 1; else return plan[m]; } return null; }
