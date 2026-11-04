// A one-minute synthetic EDM song with known parts, kicks and snares, for the feel evaluation (scripts/feel-eval.js).
// The same voices as synth.js edm(). Deterministic.
import { rng } from "./synth.js";

/** [part, bars]: 32 bars at 128 BPM = 60 s. Both drops start on a 4-bar line. */
export const FEEL_PLAN = [
  ["intro", 4], ["build", 4], ["drop", 8], ["break", 4], ["build", 4], ["drop", 4], ["outro", 2], ["silence", 2],
];

/**
 * @returns {{x: Float32Array, sr: number, dur: number, truth: {bpm, beat, bar, kicks: number[], snares: number[],
 *   hats: number[], downbeats: number[], parts: {part: string, t0: number, t1: number}[]}}}
 */
export function feelSong(sr = 22050, bpm = 128, plan = FEEL_PLAN) {
  const beat = 60 / bpm, bar = 4 * beat, bars = plan.reduce((s, p) => s + p[1], 0), n = Math.floor((bars * bar + 0.5) * sr), x = new Float32Array(n), r = rng(5);
  const put = (t, fn, dur) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr); };
  let ph = 0;
  const kick = t => { ph = t === 0 ? 0 : ph + 2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7); };
  let hp = 0; const hat = t => { const w = r(), y = w - hp; hp = w; return y * 0.35 * Math.exp(-t * 70); };
  const snare = g => t => (r() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18) * g;
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [130.8, 164.8, 196], [196, 246.9, 293.7]];
  const truth = { bpm, beat, bar, kicks: [], snares: [], hats: [], downbeats: [], parts: [] };
  let b0 = 0;
  for (const [part, nb] of plan) {
    truth.parts.push({ part, t0: b0 * bar, t1: (b0 + nb) * bar });
    for (let j = 0; j < nb; j++) {
      const b = b0 + j, t0 = b * bar, ch = chords[b % 4]; truth.downbeats.push(t0);
      if (part === "silence") continue;
      const padG = part === "break" ? 0.07 : part === "outro" ? 0.04 : 0.05;
      put(t0, t => ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * padG * Math.min(1, t / 0.3), bar);
      if (part !== "break") for (let q = 0; q < 4; q++) { put(t0 + q * beat + beat / 2, hat, 0.06); truth.hats.push(t0 + q * beat + beat / 2); }
      if (part === "build") { // a snare roll that doubles every quarter of the build-up and stops a beat before the drop
        const k = j / nb, div = k < 0.25 ? 1 : k < 0.5 ? 2 : k < 0.75 ? 4 : 8, steps = j === nb - 1 ? 3 * div : 4 * div;
        for (let s = 0; s < steps; s++) { const tt = t0 + s * beat / div; put(tt, snare(0.3 + 0.7 * (j + s / (4 * div)) / nb), 0.2); truth.snares.push(tt); }
      }
      if (part === "drop" || part === "outro") for (let q = 0; q < 4; q++) {
        const tt = t0 + q * beat; put(tt, kick, 0.4); truth.kicks.push(tt);
        if (q % 2) { put(tt, snare(0.8), 0.2); truth.snares.push(tt); }
        if (part === "drop") { let lp = 0; put(tt + 0.02, t => { const saw = 2 * ((ch[0] / 4 * t) % 1) - 1; lp += (saw - lp) * 0.05; return lp * 0.5; }, beat * 0.9); }
      }
    }
    b0 += nb;
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, truth, dur: n / sr };
}
