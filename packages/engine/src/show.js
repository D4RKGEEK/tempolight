// Auto-generated shows: a song's analysis becomes a timeline of effects, one per section (a few bars), picked from
// the style's pools (build-ups get build effects, drops the big ones). The same song always gets the same show,
// and each block can be changed by hand; the director then plays the timeline instead of choosing on the fly.

import { songView } from "./signals.js";

function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

/**
 * The show is what the automatic director would play for this song, written down: the same pools, the same
 * "change every N beats" (twice as often in drops), the same immediate switch when the song part changes. So a
 * song with a show looks exactly as lively as one without, and each block can then be changed by hand.
 * (An earlier version picked one effect per 8 bars; drops then got a third of the changes and felt flat.)
 * @param {{bpm:number, P:number, off:number, barOff:number, bars:{t0:number,t1:number,state:string,level:number}[], env:ArrayLike<number>, style:string, dur:number, kicks:number[], snares:number[], hats:number[], drops:number[]}} pre a song analysis
 * @param {{pools:object, styles:object}} fx from createEffects()
 * @param {{seed?:string, prefs?:Record<string,number>, everyBeats?:number}} [o] seed "": the director's own order; another seed starts the pools elsewhere (a new show)
 * @returns {{t0:number, t1:number, part:string, effect:string}[]}
 */
export function planShow(pre, fx, o = {}) {
  const ST = fx.styles[pre.style] || fx.styles.party, prefs = o.prefs || {}, every = o.everyBeats || 8, seed = o.seed ? hashStr(o.seed) : 0;
  const withPrefs = list => { const out = []; for (const id of list || []) { const p = prefs[id]; if (p === -1) continue; out.push(id); if (p === 1) out.push(id); } return out.length ? out : list || []; };
  if (!pre || !pre.dur || !(pre.bars && pre.bars.length)) return [];
  pre = { kicks: [], snares: [], hats: [], drops: [], env: new Float32Array(0), off: 0, barOff: 0, ...pre }; // tolerate partial analyses
  if (!(pre.P > 0)) pre.P = pre.bpm > 0 ? 60 / pre.bpm : 0.5; // no beat grid: count at 120 BPM
  const out = [], poolIdx = {}; let cur = null, curPart = "calm", lastSwitch = -1e9, t0 = 0;
  const push = (t1, part) => { if (cur && t1 > t0) { const prevB = out.at(-1); if (prevB && prevB.effect === cur) prevB.t1 = r3(t1); else out.push({ t0: r3(t0), t1: r3(t1), part, effect: cur }); } };
  const step = pre.P / 4; // four looks per beat: enough to land on every bar start and song-part change
  for (let t = 0; t < pre.dur; t += step) {
    const V = songView(pre, t), g = V.g, sec = ST.mode === "sections" ? (V.state === "silent" ? "calm" : V.state) : V.level, pool = withPrefs(ST.pools[sec] || ST.pools.calm || ST.pools.low);
    if (!pool.length) continue;
    const wrongPool = !pool.includes(cur), hot = sec === "drop" || sec === "peak";
    const barReady = g.has && g.beatInBar === 0 && g.idx - lastSwitch >= every * ST.every * (hot ? 1 : 2);
    if (V.state === "silent" && !wrongPool) continue;
    if (wrongPool || barReady) {
      if (poolIdx[sec] == null) poolIdx[sec] = seed % pool.length;
      if (sec === "build" && wrongPool) poolIdx.build = seed % pool.length;
      const next = pool[poolIdx[sec] % pool.length]; poolIdx[sec]++;
      if (next !== cur) { push(t, curPart); cur = next; t0 = t; }
      curPart = V.state === "silent" ? "calm" : V.state; lastSwitch = g.has ? g.idx : lastSwitch;
      if (out.length === 0 && t0 === t && t < step) t0 = 0;
    }
  }
  push(pre.dur, curPart);
  if (out.length) { out[0].t0 = 0; out.at(-1).t1 = Math.max(out.at(-1).t1, r3(pre.dur)); }
  return out;
}
const r3 = v => Math.round(v * 1000) / 1000;

/** The block of a show at time t (binary search), or null. */
export function showAt(plan, t) { let lo = 0, hi = plan.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (plan[m].t1 <= t) lo = m + 1; else if (plan[m].t0 > t) hi = m - 1; else return plan[m]; } return null; }
