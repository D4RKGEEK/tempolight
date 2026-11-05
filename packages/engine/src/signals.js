// Builds the signals object (S) every effect reads, from a whole-song analysis or from a simple metronome.
import { lastLE } from "./analysis.js";

const PUNCH = { party: 1, poprock: 0.85, hiphop: 1, chill: 0.35, emotional: 0.1 };

/** Beat grid at time t from an analysis result. */
export function gridAt(pre, t) {
  const P = pre.P, x = (t - pre.off) / P, idx = Math.floor(x), ph = x - idx, bib = (((idx - pre.barOff) % 4) + 4) % 4;
  return { has: true, P, phase: ph, idx, beatInBar: bib, env: Math.exp(-ph * P / 0.18), barPhase: (bib + ph) / 4, beatT: pre.off + idx * P };
}

// silent only when it has been quiet for a moment (0.6 s): the gap between two snare hits of a build-up isn't silence,
// and calling it silence switched the build-up's effect to a calm one and back, several times a bar
function quietFor(env, t, sec = 0.6) {
  const j1 = Math.round(t / 0.02); if (!((env[j1] || 0) < 0.1)) return false;
  for (let j = Math.max(0, j1 - Math.round(sec / 0.02)); j < j1; j++) if (env[j] >= 0.1) return false;
  return true;
}

// how hard a kick hit, 0.3..1, from the analysis' optional kickStrength (one number per kick, any scale): a kick as
// strong as the song's usual strong kick (90th percentile) is 1
const P90 = new WeakMap();
function kickStrength(pre, ki) {
  const a = pre.kickStrength; if (!a || ki < 0 || !(ki < a.length)) return 1;
  let p = P90.get(a); if (p == null) { const s = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y); p = s.length ? s[Math.floor(s.length * 0.9)] || 0 : 0; P90.set(a, p); }
  const v = a[ki]; return p > 0 && Number.isFinite(v) ? Math.max(0.3, Math.min(1, v / p)) : 1;
}

/** What the music is doing at time t: song part, loudness, last hits, next drop. */
export function songView(pre, t) {
  const g = gridAt(pre, t), ki = lastLE(pre.kicks, t), si = lastLE(pre.snares, t), hi = lastLE(pre.hats, t);
  const kick = ki >= 0 ? pre.kicks[ki] : -9, pulses = [], snares = [];
  for (let i = ki; i >= 0 && t - pre.kicks[i] < 1; i--) pulses.push(pre.kicks[i]);
  for (let i = si; i >= 0 && t - pre.snares[i] < 0.7; i--) snares.push(pre.snares[i]);
  const bi = lastLE(pre.bars.map(b => b.t0), t);
  // a bar lasts until the next one starts: analysis leaves small gaps between bars, and treating a gap as "no bar"
  // (calm) made the song part flicker build → calm → build for a frame or two at every bar line
  const bar = bi >= 0 && (t < pre.bars[bi].t1 || (bi + 1 < pre.bars.length && t < pre.bars[bi + 1].t0 && t - pre.bars[bi].t1 < 1)) ? pre.bars[bi] : null;
  let state = bar ? bar.state : "calm", buildP = 0;
  if (state === "build") {
    let a = bi, b = bi; while (a > 0 && pre.bars[a - 1].state === "build") a--; while (b < pre.bars.length - 1 && pre.bars[b + 1].state === "build") b++;
    buildP = Math.min(1, (t - pre.bars[a].t0) / (pre.bars[b].t1 - pre.bars[a].t0));
  }
  let la = 0, ln = 0; for (let k = -15; k <= 0; k++) { const j = Math.round(t / 0.02) + k; if (j >= 0 && j < pre.env.length) { la += pre.env[j]; ln++; } }
  const loud = Math.min(1, ln ? la / ln : 0), lvl = (bar ? bar.level : loud) * 0.7 + loud * 0.3;
  const di = lastLE(pre.drops, t + 1e-3);
  // the section (repeat label) this bar belongs to, when the analysis has sections: looks step their colour on these
  let section = null; const secs = pre.sections; if (secs && bi >= 0) for (let k = secs.length - 1; k >= 0; k--) if (secs[k].bar0 <= bi) { if (bi < secs[k].bar1) section = secs[k]; break; }
  return { section, barI: bi, g, bpm: pre.bpm, style: pre.style, loud, level: lvl < 0.35 ? "low" : lvl < 0.72 ? "mid" : "peak",
    state: quietFor(pre.env, t) ? "silent" : state, buildP,
    dropT: di >= 0 ? pre.drops[di] : -9, nextDrop: di + 1 < pre.drops.length ? pre.drops[di + 1] : null,
    dropConf: di + 1 < pre.drops.length ? 1 : 0, dropSource: di + 1 < pre.drops.length ? "memory" : null, // (known: the whole song was analysed)
    kick, snare: si >= 0 ? pre.snares[si] : -9, hat: hi >= 0 ? pre.hats[hi] : -9, pulses, snares, pulseN: ki, kickS: kickStrength(pre, ki),
    key: pre.key || null, mode: pre.mode || null, keyConf: pre.keyConfidence ?? 0, mood: pre.mood || null }; // key and mood: whole-song (tonal.js)
}

/** A steady beat with no audio, for demos and hardware tests. grid ({P, off, barOff}, as for gridAt) puts the beats
 * somewhere else than on whole multiples of the beat length, e.g. on a DJ deck's beats. */
export function metronomeView(t, bpm = 128, grid = null) {
  const g = gridAt(grid || { P: 60 / bpm, off: 0, barOff: 0 }, t), { P, idx, phase: ph, beatInBar: bib } = g;
  const kick = g.beatT, pulses = [kick, kick - P, kick - 2 * P].filter(x => x >= 0);
  const snare = bib % 2 ? kick : kick - P;
  return { g, bpm, style: "party", loud: 0.8, level: "peak", state: "drop", buildP: ((((idx - bib) / 4) % 4 + 4) % 4 + ph / 4 + bib / 4) / 4, dropT: -9, nextDrop: null,
    kick, snare, hat: kick + P / 2 <= t ? kick + P / 2 : kick - P / 2, pulses, snares: [snare], pulseN: idx };
}

/** How hard the last kick hit, 0.3..1 (1 when nobody knows). */
export function kickHit(V) {
  const v = V.kickS ?? V.kickStrength; return typeof v === "number" && Number.isFinite(v) ? Math.max(0.3, Math.min(1, v)) : 1;
}

/**
 * Turn a view into the signals object effects read.
 * @param {ReturnType<typeof songView>} V
 * @param {{pal:number[][], fixed?:boolean, bands?:Float32Array, wave?:Float32Array|null, bassL?:number}} opts
 */
export function buildSignals(V, t, opts) {
  const g = V.g, punch = PUNCH[V.style] ?? 1, kickRecent = t - V.kick < 1.6;
  const pulseT = kickRecent ? V.kick : g.beatT, pulses = kickRecent ? V.pulses : [0, 1, 2].map(k => pulseT - k * g.P);
  // decays follow the tempo, so fast songs don't smear one kick into the next (as tuned at 128 BPM, never longer);
  // a kick hits as hard as it was played when the analysis knows (kickS / live kickStrength, 0..1)
  const tk = g.has && g.P > 0 ? Math.max(0.55, Math.min(1, g.P / 0.469)) : 1, hit = kickHit(V);
  return {
    t, g, pal: opts.pal, fixed: !!opts.fixed, punch, loud: V.loud, wave: opts.wave || null,
    hat: V.hat, snare: V.snare, snares: V.snares, pulseT, pulses, pulseN: kickRecent ? V.pulseN : g.idx,
    pulse: Math.exp(-(t - pulseT) / (0.2 * tk)) * punch * (kickRecent ? hit : 1), kickE: Math.exp(-(t - V.kick) / (0.25 * tk)) * punch * hit,
    snareE: Math.exp(-(t - V.snare) / (0.15 * tk)) * punch, hatE: Math.exp(-(t - V.hat) / 0.12) * punch,
    bassL: opts.bassL ?? (V.state === "drop" ? 0.9 : 0.3), bands: opts.bands || new Float32Array(24), vocal: V.vocal ?? null, // null: no live estimate (Vocal Glow uses the mid bands)
    buildP: V.state === "build" ? V.buildP : ((((g.idx - g.beatInBar) / 4) % 4 + 4) % 4 + g.barPhase) / 4,
    // seconds until the next drop (known, or predicted live with dropConf 0.5 or more) and since the last one; 99 = none
    dropIn: V.nextDrop != null && V.nextDrop >= t && (V.dropConf ?? 1) >= 0.5 ? V.nextDrop - t : 99, sinceDrop: V.dropT > -9 ? t - V.dropT : 99,
  };
}
