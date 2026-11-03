// Builds the signals object (S) every effect reads, from a whole-song analysis or from a simple metronome.
import { lastLE } from "./analysis.js";

const PUNCH = { party: 1, poprock: 0.85, hiphop: 1, chill: 0.35, emotional: 0.1 };

/** Beat grid at time t from an analysis result. */
export function gridAt(pre, t) {
  const P = pre.P, x = (t - pre.off) / P, idx = Math.floor(x), ph = x - idx, bib = (((idx - pre.barOff) % 4) + 4) % 4;
  return { has: true, P, phase: ph, idx, beatInBar: bib, env: Math.exp(-ph * P / 0.18), barPhase: (bib + ph) / 4, beatT: pre.off + idx * P };
}

/** What the music is doing at time t: song part, loudness, last hits, next drop. */
export function songView(pre, t) {
  const g = gridAt(pre, t), ki = lastLE(pre.kicks, t), si = lastLE(pre.snares, t), hi = lastLE(pre.hats, t);
  const kick = ki >= 0 ? pre.kicks[ki] : -9, pulses = [], snares = [];
  for (let i = ki; i >= 0 && t - pre.kicks[i] < 1; i--) pulses.push(pre.kicks[i]);
  for (let i = si; i >= 0 && t - pre.snares[i] < 0.7; i--) snares.push(pre.snares[i]);
  const bi = lastLE(pre.bars.map(b => b.t0), t);
  const bar = bi >= 0 && t < pre.bars[bi].t1 ? pre.bars[bi] : null;
  let state = bar ? bar.state : "calm", buildP = 0;
  if (state === "build") {
    let a = bi, b = bi; while (a > 0 && pre.bars[a - 1].state === "build") a--; while (b < pre.bars.length - 1 && pre.bars[b + 1].state === "build") b++;
    buildP = Math.min(1, (t - pre.bars[a].t0) / (pre.bars[b].t1 - pre.bars[a].t0));
  }
  let la = 0, ln = 0; for (let k = -15; k <= 0; k++) { const j = Math.round(t / 0.02) + k; if (j >= 0 && j < pre.env.length) { la += pre.env[j]; ln++; } }
  const loud = Math.min(1, ln ? la / ln : 0), lvl = (bar ? bar.level : loud) * 0.7 + loud * 0.3;
  const di = lastLE(pre.drops, t + 1e-3);
  return { g, bpm: pre.bpm, style: pre.style, loud, level: lvl < 0.35 ? "low" : lvl < 0.72 ? "mid" : "peak",
    state: (pre.env[Math.round(t / 0.02)] || 0) < 0.1 ? "silent" : state, buildP,
    dropT: di >= 0 ? pre.drops[di] : -9, nextDrop: di + 1 < pre.drops.length ? pre.drops[di + 1] : null,
    kick, snare: si >= 0 ? pre.snares[si] : -9, hat: hi >= 0 ? pre.hats[hi] : -9, pulses, snares, pulseN: ki };
}

/** A steady beat with no audio, for demos and hardware tests. */
export function metronomeView(t, bpm = 128) {
  const P = 60 / bpm, idx = Math.floor(t / P), ph = t / P - idx, bib = idx % 4;
  const kick = idx * P, pulses = [kick, kick - P, kick - 2 * P].filter(x => x >= 0);
  const snare = bib % 2 ? kick : kick - P;
  return { g: { has: true, P, phase: ph, idx, beatInBar: bib, env: Math.exp(-ph * P / 0.18), barPhase: (bib + ph) / 4, beatT: kick },
    bpm, style: "party", loud: 0.8, level: "peak", state: "drop", buildP: ((idx >> 2) % 4 + ph / 4 + bib / 4) / 4, dropT: -9, nextDrop: null,
    kick, snare, hat: kick + P / 2 <= t ? kick + P / 2 : kick - P / 2, pulses, snares: [snare], pulseN: idx };
}

/**
 * Turn a view into the signals object effects read.
 * @param {ReturnType<typeof songView>} V
 * @param {{pal:number[][], fixed?:boolean, bands?:Float32Array, wave?:Float32Array|null, bassL?:number}} opts
 */
export function buildSignals(V, t, opts) {
  const g = V.g, punch = PUNCH[V.style] ?? 1, kickRecent = t - V.kick < 1.6;
  const pulseT = kickRecent ? V.kick : g.beatT, pulses = kickRecent ? V.pulses : [0, 1, 2].map(k => pulseT - k * g.P);
  return {
    t, g, pal: opts.pal, fixed: !!opts.fixed, punch, loud: V.loud, wave: opts.wave || null,
    hat: V.hat, snare: V.snare, snares: V.snares, pulseT, pulses, pulseN: kickRecent ? V.pulseN : g.idx,
    pulse: Math.exp(-(t - pulseT) / 0.2) * punch, kickE: Math.exp(-(t - V.kick) / 0.25) * punch,
    snareE: Math.exp(-(t - V.snare) / 0.15) * punch, hatE: Math.exp(-(t - V.hat) / 0.12) * punch,
    bassL: opts.bassL ?? (V.state === "drop" ? 0.9 : 0.3), bands: opts.bands || new Float32Array(24), vocal: V.vocal ?? null, // null: no live estimate (Vocal Glow uses the mid bands)
    buildP: V.state === "build" ? V.buildP : ((((g.idx - g.beatInBar) / 4) % 4 + 4) % 4 + g.barPhase) / 4,
    // seconds until the next known drop (whole-song analysis or a forced build-up) and since the last one; 99 = none
    dropIn: V.nextDrop != null && V.nextDrop >= t ? V.nextDrop - t : 99, sinceDrop: V.dropT > -9 ? t - V.dropT : 99,
  };
}
