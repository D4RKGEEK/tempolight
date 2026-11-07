// Hard negatives for the live drop countdown (drops.js): synthetic hip hop, trap and desi hip hop songs full of the
// things that look like an EDM build-up but are not one: hi-hat rolls (1/32 triplets, getting louder), 808 slides,
// beat switches, vocal ad-libs (a rising "yeah", a "skrrt" sweep), dhol and tabla runs, filter sweeps and noise
// risers with no drop after them. None of them has an EDM drop: a countdown on any of them is a false one. And one
// hip hop song with a real beat drop after a break (the beat stops for 4 bars, then comes back hard), the drop a
// hip hop song does have. Deterministic, made from the same kind of voices as synth.js; used by drops.test.js and
// scripts/feel-eval.js.
import { rng } from "./synth.js";

// ---------------------------------------------------------------- voices
// Each voice is a function of the time since its onset (seconds), called sample by sample in order, as synth.js's.
function kit(sr, seed) {
  const r = rng(seed);
  const bp = (fc, q) => { // a resonant band-pass (biquad, RBJ); fc may be a function of time
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x, t) => { const f = typeof fc === "function" ? fc(t) : fc, w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
      const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0, y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  };
  return {
    r,
    // an 808: a long sine bass with a click, from f0 (Hz), sliding to f1 over the last `slide` seconds of `len`
    k808: (f0, len, g = 0.9, f1 = null, slide = 0.12) => { let ph = 0; return t => {
      const glide = f1 && t > len - slide ? f0 * Math.pow(f1 / f0, (t - (len - slide)) / slide) : f0;
      ph += 2 * Math.PI * (glide + 70 * Math.exp(-t * 40)) / sr; return Math.sin(ph) * Math.exp(-t * 1.1) * Math.min(1, (len - t) / 0.03) * g; }; },
    kick: (g = 0.9) => { let ph = 0; return t => { ph += 2 * Math.PI * (48 + 95 * Math.exp(-t * 30)) / sr; return Math.sin(ph) * Math.exp(-t * 8) * g; }; },
    snare: (g = 0.6) => t => (r() * 0.6 + Math.sin(2 * Math.PI * 185 * t) * 0.4) * Math.exp(-t * 16) * g,
    clap: (g = 0.6) => { const f = bp(1500, 0.8); return t => { const e = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.4 : 1) : Math.exp(-(t - 0.03) * 22); return f(r(), t) * e * 2.2 * g; }; },
    hat: (g = 0.3, dec = 70) => { let hp = 0; return t => { const w = r(), y = w - hp; hp = w; return y * g * Math.exp(-t * dec); }; },
    // the dhol: the bass side (dagga), a booming membrane whose pitch falls a little; the treble side (tilli), a cane crack
    dagga: (g = 0.8) => { let ph = 0; return t => { ph += 2 * Math.PI * (95 - 20 * Math.min(1, t * 6)) / sr; return (Math.sin(ph) * Math.exp(-t * 7) + r() * 0.15 * Math.exp(-t * 60)) * g; }; },
    tilli: (g = 0.5) => { const f = bp(2600, 1.2); return t => (f(r(), t) * 1.8 * Math.exp(-t * 45) + Math.sin(2 * Math.PI * 620 * t) * 0.3 * Math.exp(-t * 30)) * g; },
    // the tabla: na/tin (the small drum: a ringing harmonic tone) and ge (the big drum: a bass whose pitch bends up)
    tablaNa: (g = 0.4, f = 760) => t => [1, 2, 3, 4.1].reduce((s, h, i) => s + Math.sin(2 * Math.PI * f * h * t) / (i + 1), 0) * Math.exp(-t * 9) * g,
    tablaGe: (g = 0.6) => { let ph = 0; return t => { ph += 2 * Math.PI * (105 + 50 * Math.min(1, t / 0.25)) / sr; return Math.sin(ph) * Math.exp(-t * 4) * g; }; },
    // a voice: a sung or rapped syllable on a pitch contour (Hz as a function of time), formants of an "ah"
    voice: (pitch, len, g = 0.12) => { let ph = 0; const fm = f => [[750, 140, 1], [1250, 170, 0.5], [2700, 220, 0.3]].reduce((s, [c, bw, a]) => s + a / (1 + ((f - c) / bw) ** 2), 0);
      return t => { const f0 = pitch(t); ph += 2 * Math.PI * f0 / sr; let v = 0; for (let h = 1; h * f0 < 4500; h++) v += Math.sin(h * ph) * fm(h * f0) / h ** 0.3;
        return (v + r() * 0.05) * g * Math.min(1, t / 0.02, (len - t) / 0.04); }; },
    // "skrrt": noise through a band-pass sweeping up fast, with a rattle
    skrrt: (len, g = 0.35) => { const f = bp(t => 800 * Math.pow(8, t / len), 4); return t => f(r(), t) * (0.6 + 0.4 * Math.sign(Math.sin(2 * Math.PI * 38 * t))) * Math.min(1, t / 0.02, (len - t) / 0.05) * g * 3; },
    // a noise riser: white noise through a band-pass sweeping from lo to hi Hz, getting louder over len seconds
    sweep: (len, lo = 400, hi = 9000, g = 0.25) => { const f = bp(t => lo * Math.pow(hi / lo, t / len), 2.5); return t => f(r(), t) * g * 2.5 * Math.pow(t / len, 1.5) * Math.min(1, (len - t) / 0.01); },
    // a reverse cymbal: noise swelling into the next downbeat
    revCrash: (len, g = 0.25) => { let hp = 0; return t => { const w = r(), y = w - hp; hp = w; return y * g * Math.pow(t / len, 2.5); }; },
    pad: (ch, len, g = 0.05) => t => ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * g * Math.min(1, t / 0.3, (len - t) / 0.2),
    pluck: (f, g = 0.12) => t => [1, 2, 3, 5].reduce((s, h, i) => s + Math.sin(2 * Math.PI * f * h * t) / (i + 1) * Math.exp(-t * (3 + 4 * i)), 0) * g,
  };
}

// a song made bar by bar: plan(b, add, k) adds the voices of bar b; returns {x, sr, dur, bpm, truth}
function make({ bpm, bars, seed = 3, sr = 22050, plan, after }) {
  const beat = 60 / bpm, bar = 4 * beat, n = Math.floor((bars * bar + 0.5) * sr), x = new Float32Array(n), k = kit(sr, seed);
  const add = (t, fn, dur, into = x) => { const i0 = Math.floor(t * sr); for (let i = 0; i < dur * sr && i0 + i < n; i++) into[i0 + i] += fn(i / sr); };
  const truth = { bpm, beat, bar, drops: [], parts: [] };
  for (let b = 0; b < bars; b++) plan(b, b * bar, add, k, truth);
  if (after) after(x, sr, bar, k);
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, dur: n / sr, bpm, truth };
}
const AM = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 207.7, 246.9]];
// a rapped line: a syllable on every 8th (some rests), the pitch speaking around 180 Hz
function rap(t0, beat, add, k, steps = 8) { for (let s = 0; s < steps; s++) { if (k.r() < -0.5) continue; const p0 = 170 + 30 * k.r(); add(t0 + s * beat / 2, k.voice(t => p0 * (1 - 0.15 * t), beat * 0.4, 0.06), beat * 0.4); } }

/** Trap at 140 BPM (half-time feel): an 808 line with slides, a clap on beat 3, 1/8 hats and hi-hat rolls (1/16 and
 *  1/32 triplets, getting louder) at the end of every second bar, a long accelerating roll every 8 bars, ad-libs. */
export function trapRolls(sr = 22050) {
  return make({ bpm: 140, bars: 36, seed: 21, sr, plan(b, t0, add, k) {
    const beat = 60 / 140, ch = AM[b % 4];
    add(t0, k.pad(ch, 4 * beat, 0.03), 4 * beat);
    if (b < 2) return; // a 2-bar intro of chords
    const notes = [[0, 49, 1.4, b % 2 ? 65.4 : null], [1.5, 49, 0.9], [2.75, 43.6, 1.25, b % 4 === 3 ? 58.3 : null]];
    for (const [q, f, len, f1] of notes) add(t0 + q * beat, k.k808(f, len * beat, 0.85, f1, 0.15), len * beat);
    add(t0 + 2 * beat, k.clap(0.55), 0.25);
    const roll = b % 2 === 1, long = b % 8 === 7;
    for (let s = 0; s < 8; s++) { const tt = t0 + s * beat / 2; if ((roll && s >= 6) || (long && s >= 4)) continue; add(tt, k.hat(0.28), 0.05); }
    if (roll && !long) for (let i = 0; i < 12; i++) add(t0 + 3 * beat + i * beat / 12, k.hat(0.12 + 0.2 * i / 12, 90), 0.04); // a 1/32-triplet roll on beat 4, getting louder
    if (long) { let tt = t0 + 2 * beat; for (const [div, nn] of [[4, 4], [6, 6], [8, 8], [12, 12]]) for (let i = 0; i < nn / 2; i++, tt += beat / div) add(tt, k.hat(0.1 + 0.3 * (tt - t0 - 2 * beat) / (2 * beat), 90), 0.04); }
    if (b % 4 === 2) add(t0 + 3.5 * beat, k.voice(t => 220 + 260 * t, 0.35, 0.1), 0.35); // "yeah!" rising
    if (b % 8 === 5) add(t0 + 3 * beat, k.skrrt(0.45), 0.45);
  } });
}

/** Hip hop at 92 BPM with a beat switch: 8 bars of beat A, a bar with only the chords and a noise sweep, then 8 bars
 *  of a busier beat B (more hats, a snare roll into it), and back again. No drop. */
export function beatSwitch(sr = 22050) {
  return make({ bpm: 92, bars: 34, seed: 22, sr, plan(b, t0, add, k) {
    const beat = 60 / 92, ch = AM[b % 4], sec = b % 17; // 0-7 beat A, 8 switch bar, 9-16 beat B
    add(t0, k.pad(ch, 4 * beat, 0.04), 4 * beat);
    rap(t0, beat, add, k);
    if (sec === 8) { add(t0, k.sweep(4 * beat, 500, 8000, 0.2), 4 * beat); for (let s = 0; s < 8; s++) add(t0 + 2 * beat + s * beat / 4, k.snare(0.2 + 0.4 * s / 8), 0.15); return; }
    if (sec < 8) { for (const q of [0, 1.75, 2.5]) add(t0 + q * beat, k.kick(), 0.4); for (const q of [1, 3]) add(t0 + q * beat, k.snare(0.6), 0.25); for (let s = 0; s < 8; s++) add(t0 + s * beat / 2, k.hat(0.22), 0.05);
      add(t0, k.k808(55, 2 * beat, 0.5), 2 * beat); add(t0 + 2.5 * beat, k.k808(49, 1.5 * beat, 0.5), 1.5 * beat); }
    else { for (const q of [0, 0.75, 2, 2.25]) add(t0 + q * beat, k.kick(), 0.4); for (const q of [1, 3]) add(t0 + q * beat, k.clap(0.6), 0.25); for (let s = 0; s < 16; s++) add(t0 + s * beat / 4, k.hat(s % 2 ? 0.12 : 0.25), 0.04);
      add(t0, k.k808(41.2, 4 * beat, 0.6, 55, 0.2), 4 * beat); }
  } });
}

/** Boom bap at 88 BPM, full of ad-libs: a rising "yeah", a "skrrt", a reverse cymbal into some bars, a sung hook with a
 *  climbing melody. The beat never stops. */
export function adLibs(sr = 22050) {
  return make({ bpm: 88, bars: 28, seed: 23, sr, plan(b, t0, add, k) {
    const beat = 60 / 88, ch = AM[b % 4];
    add(t0, k.pad(ch, 4 * beat, 0.035), 4 * beat);
    for (const q of [0, 1.5, 2.5]) add(t0 + q * beat, k.kick(), 0.4); for (const q of [1, 3]) add(t0 + q * beat, k.snare(0.6), 0.25); for (let s = 0; s < 8; s++) add(t0 + s * beat / 2, k.hat(0.2), 0.05);
    if (b % 8 < 6) rap(t0, beat, add, k);
    else for (let s = 0; s < 4; s++) { const f0 = 260 * Math.pow(2, ((b % 8 - 6) * 4 + s) / 12); add(t0 + s * beat, k.voice(t => f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t)), beat * 0.95, 0.1), beat); } // the hook climbs
    if (b % 4 === 1) add(t0 + 3 * beat, k.voice(t => 200 + 400 * t, 0.5, 0.12), 0.5);
    if (b % 4 === 3) { add(t0 + 2 * beat, k.revCrash(2 * beat, 0.3), 2 * beat); add(t0 + 3.4 * beat, k.skrrt(0.5), 0.5); }
  } });
}

/** Desi hip hop / bhangra at 100 BPM: the dhol's chaal (dagga and tilli), tabla runs (tirakita, 1/16 and 1/32), a
 *  tumbi-like pluck riff, an 808, and a dhol roll that speeds up over the last 2 bars of every 8, into... the same beat. */
export function desiDhol(sr = 22050) {
  return make({ bpm: 100, bars: 32, seed: 24, sr, plan(b, t0, add, k) {
    const beat = 60 / 100, ch = AM[b % 4], sec = b % 8;
    add(t0, k.pad(ch, 4 * beat, 0.03), 4 * beat);
    for (let s = 0; s < 8; s++) add(t0 + s * beat / 2 + (s % 2 ? 0.03 : 0), k.pluck([440, 523, 587, 659][(s + b) % 4] * (s % 3 ? 1 : 0.5)), beat);
    if (sec >= 6) { // a dhol roll, faster and louder: 8ths, then 16ths, then 32nds (the treble side), the bass on the beats
      for (let q = 0; q < 4; q++) add(t0 + q * beat, k.dagga(0.7), 0.4);
      const div = sec === 6 ? (2) : 4, g0 = sec === 6 ? 0.25 : 0.45;
      for (let s = 0; s < 4 * div * (sec === 7 ? 2 : 1); s++) { const step = beat / (div * (sec === 7 ? 2 : 1)); add(t0 + s * step, k.tilli(g0 + 0.3 * s * step / (4 * beat)), 0.1); }
      if (sec === 7) for (let i = 0; i < 8; i++) add(t0 + 3 * beat + i * beat / 8, k.tablaNa(0.25 + 0.03 * i, 820), 0.15);
      add(t0, k.k808(49, 4 * beat, 0.4), 4 * beat);
      return;
    }
    // the chaal: dagga on 1 and the "and" of 2 and on 3, tilli on the off-beats, swung
    for (const q of [0, 1.5, 2, 3.5]) add(t0 + q * beat, k.dagga(), 0.4);
    for (const q of [0.5, 1, 2.5, 3, 3.75]) add(t0 + q * beat + 0.02, k.tilli(), 0.12);
    add(t0 + beat, k.snare(0.4), 0.2); add(t0 + 3 * beat, k.clap(0.5), 0.25);
    add(t0, k.k808(49, 2 * beat, 0.6), 2 * beat); add(t0 + 2 * beat, k.k808(55, 2 * beat, 0.6, 49, 0.2), 2 * beat);
    if (sec % 2 === 1) { const ti = [0, 1, 2, 3, 4, 5, 6, 7]; for (const i of ti) add(t0 + 3 * beat + i * beat / 8, i % 4 === 0 ? k.tablaGe(0.5) : k.tablaNa(0.3, i % 2 ? 760 : 900), 0.2); } // tirakita
    rap(t0, beat, add, k, 6);
  } });
}

/** Hip hop at 95 BPM with filter sweeps and noise risers and no drop after them: a 4-bar noise sweep getting louder
 *  over the beat, the drums low-passed and opening up, a snare build that runs into the same beat. */
export function filterSweeps(sr = 22050) {
  const beat = 60 / 95, bar = 4 * beat, sweeps = [[6, 10], [20, 24]]; // bars [from, to)
  return make({ bpm: 95, bars: 30, seed: 25, sr, plan(b, t0, add, k) {
    const ch = AM[b % 4];
    add(t0, k.pad(ch, bar, 0.04), bar);
    for (const q of [0, 2.5]) add(t0 + q * beat, k.kick(), 0.4); for (const q of [1, 3]) add(t0 + q * beat, k.snare(0.55), 0.25); for (let s = 0; s < 8; s++) add(t0 + s * beat / 2, k.hat(0.2), 0.05);
    add(t0, k.k808(46, 2.4 * beat, 0.5), 2.4 * beat);
    rap(t0, beat, add, k);
    for (const [a, z] of sweeps) if (b === a) add(t0, k.sweep((z - a) * bar, 300, 9000, 0.3), (z - a) * bar);
    if (b === 23) for (let s = 0; s < 16; s++) add(t0 + s * beat / 4, k.snare(0.2 + 0.5 * s / 16), 0.15);
  }, after(x, sr, bar2) { // the drums low-passed over the first sweep and opening up (a one-pole low-pass from 300 Hz to all of it)
    const [a, z] = sweeps[0], i0 = Math.floor(a * bar2 * sr), i1 = Math.floor(z * bar2 * sr); let y = 0;
    for (let i = i0; i < i1 && i < x.length; i++) { const p = (i - i0) / (i1 - i0), fc = 300 * Math.pow(30, p), al = 1 - Math.exp(-2 * Math.PI * fc / sr); y += (x[i] - y) * al; x[i] = y * (0.6 + 0.4 * p); }
  } });
}

/** Hip hop at 90 BPM with a real beat drop: 8 bars of the beat, a 4-bar break (only the chords and the voice, a noise
 *  riser in its last bar), the beat back hard (truth.drops: the bar line it comes back on), 8 bars, another 4-bar break,
 *  8 bars. */
export function hiphopBreakDrop(sr = 22050) {
  return make({ bpm: 90, bars: 32, seed: 26, sr, plan(b, t0, add, k, truth) {
    const beat = 60 / 90, bar = 4 * beat, ch = AM[b % 4], brk = (b >= 8 && b < 12) || (b >= 20 && b < 24);
    add(t0, k.pad(ch, bar, brk ? 0.06 : 0.035), bar);
    if (b === 12 || b === 24) truth.drops.push(t0);
    truth.parts.push({ part: brk ? "break" : b < 8 ? "verse" : "drop", t0, t1: t0 + bar });
    if (brk) { for (let s = 0; s < 4; s++) add(t0 + s * beat, k.voice(t => 230 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t)), beat * 0.9, 0.08), beat);
      if (b === 11 || b === 23) add(t0, k.sweep(bar, 400, 7000, 0.22), bar); return; }
    for (const q of [0, 1.75, 2.5]) add(t0 + q * beat, k.kick(b >= 12 ? 1 : 0.85), 0.4); for (const q of [1, 3]) add(t0 + q * beat, k.snare(0.65), 0.25);
    for (let s = 0; s < 8; s++) add(t0 + s * beat / 2, k.hat(0.2), 0.05);
    add(t0, k.k808(49, 2 * beat, 0.6), 2 * beat); add(t0 + 2.5 * beat, k.k808(55, 1.5 * beat, 0.6), 1.5 * beat);
    rap(t0, beat, add, k);
  } });
}

/** All the hard negatives (no EDM drop in any) and the hip hop song with a real beat drop. */
export const HARD_NEGATIVES = { trapRolls, beatSwitch, adLibs, desiDhol, filterSweeps };
