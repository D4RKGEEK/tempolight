// Parametric drum songs with ground truth (beats, downbeats, kicks) for the live beat-tracker evaluation
// (scripts/beat-eval.js). Deterministic: the same spec always gives the same samples.
// A spec's `relock` is the bar where the music comes back after a disruption (a break, a tempo jump, a half-time
// section); the harness measures how long the tracker takes to lock again from there.
import { rng } from "./synth.js";

// tempo: number, or a function of the beat index; returns beat times
function beatTimes(spec, bars) {
  const n = bars * 4 + 1, out = []; let t = spec.start || 0;
  for (let i = 0; i < n; i++) { out.push(t); const bpm = typeof spec.tempo === "number" ? spec.tempo : spec.tempo(i); t += 60 / bpm; }
  return out;
}

export function makeSong(spec, sr = 22050) {
  const bars = spec.bars, B = beatTimes(spec, bars), dur = B[B.length - 1] + 1.5, n = Math.floor(dur * sr), x = new Float32Array(n), r = rng(spec.seed || 1);
  const put = (t, fn, d, g = 1) => { const i0 = Math.floor(t * sr); for (let k = 0; k < d * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr) * g; };
  const posT = (bar, pos) => { const bi = bar * 4 + Math.floor(pos), f = pos - Math.floor(pos); const sw = spec.swing && Math.abs(f - 0.5) < 1e-6 ? spec.swing : f; return B[bi] + sw * (B[bi + 1] - B[bi]); };
  const kickF = () => { let ph = 0; return t => { ph = t === 0 ? 0 : ph + 2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7); }; };
  const hatF = () => { let hp = 0; return t => { const w = r(), y = w - hp; hp = w; return y * 0.3 * Math.exp(-t * 70); }; };
  const snareF = () => t => (r() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18);
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [130.8, 164.8, 196], [196, 246.9, 293.7]];
  const truth = { beats: [], downbeats: [], kicks: [] };
  for (let b = 0; b < bars; b++) {
    const ch = chords[b % 4], sec = spec.section ? spec.section(b) : "full", g = spec.gain ? spec.gain(b) : 1, barLen = B[b * 4 + 4] - B[b * 4];
    for (let q = 0; q < 4; q++) truth.beats.push(B[b * 4 + q]); truth.downbeats.push(B[b * 4]);
    if (spec.pad !== false) put(B[b * 4], t => ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * 0.04 * Math.min(1, t / 0.3) * Math.min(1, (barLen - t) / 0.05), barLen, g);
    if (sec === "silent") continue;
    const pat = spec.pattern(b, sec);
    for (const p of pat.k || []) { const t = posT(b, p); put(t, kickF(), 0.4, g); truth.kicks.push(t); }
    for (const p of pat.s || []) put(posT(b, p), snareF(), 0.2, g * 0.8);
    for (const p of pat.h || []) put(posT(b, p), hatF(), 0.06, g);
    if (pat.bass) for (let q = 0; q < 4; q++) { const t0 = B[b * 4 + q] + 0.02, d = (B[b * 4 + q + 1] - B[b * 4 + q]) * 0.9; let lp = 0; put(t0, t => { const saw = 2 * ((ch[0] / 4 * t) % 1) - 1; lp += (saw - lp) * 0.05; return lp * 0.5; }, d, g); }
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] = x[i] / m + r() * 0.002;
  truth.relock = spec.relock != null ? B[spec.relock * 4] : null;
  return { x, sr, truth, dur, name: spec.name, bpm: typeof spec.tempo === "number" ? spec.tempo : null };
}

const four = { k: [0, 1, 2, 3], s: [1, 3], h: [0.5, 1.5, 2.5, 3.5], bass: true };
const eighths = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
export const SPECS = [
  { name: "house128", tempo: 128, bars: 24, pattern: () => four },
  { name: "house124 sustained-bass+no-hats", tempo: 124, bars: 24, pattern: () => ({ k: [0, 1, 2, 3], s: [1, 3], bass: true }) },
  { name: "boombap70", tempo: 70, bars: 14, pattern: () => ({ k: [0, 0.75, 2.5], s: [1, 3], h: eighths }) },
  { name: "hiphop88", tempo: 88, bars: 16, pattern: () => ({ k: [0, 0.75, 2.5], s: [1, 3], h: eighths }) },
  { name: "halftime140 (dubstep)", tempo: 140, bars: 24, pattern: () => ({ k: [0, 2.5], s: [2], h: eighths }) },
  { name: "dnb174 two-step", tempo: 174, bars: 32, pattern: () => ({ k: [0, 2.5], s: [1, 3], h: eighths }) },
  { name: "swing100 (2:1 hats)", tempo: 100, bars: 20, swing: 2 / 3, pattern: () => ({ k: [0, 2], s: [1, 3], h: eighths }) },
  { name: "dembow95 syncopated", tempo: 95, bars: 20, pattern: () => ({ k: [0, 1, 2, 3], s: [0.75, 1.5, 2.75, 3.5], h: [] }) },
  { name: "broken-kick110", tempo: 110, bars: 20, pattern: () => ({ k: [0, 0.75, 2.25, 3.5], s: [1, 3], h: eighths }) },
  { name: "quiet-intro128 (-30dB 8 bars)", tempo: 128, bars: 24, gain: b => b < 8 ? 0.03 : 1, pattern: () => four },
  { name: "hats-only intro 8 bars then 4otf 128", tempo: 128, bars: 24, relock: 8, section: b => b < 8 ? "intro" : "full", pattern: (b, s) => s === "intro" ? { h: [0.5, 1.5, 2.5, 3.5] } : four },
  { name: "break 8 bars (pad only) 126", tempo: 126, bars: 32, relock: 20, section: b => b >= 12 && b < 20 ? "silent" : "full", pattern: () => four },
  { name: "tempo jump 120->128 @bar16", tempo: i => i < 64 ? 120 : 128, bars: 32, relock: 16, pattern: () => four },
  { name: "tempo ramp 120->132 over 16 bars", tempo: i => i < 32 ? 120 : i < 96 ? 120 + 12 * (i - 32) / 64 : 132, bars: 32, relock: 24, pattern: () => four },
  { name: "halftime drop 128 (kick 1, snare 3)", tempo: 128, bars: 32, relock: 20, section: b => b >= 12 && b < 20 ? "half" : "full", pattern: (b, s) => s === "half" ? { k: [0], s: [2], h: eighths } : four },
];
