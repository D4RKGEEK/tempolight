// "Messy" synthetic songs for the live reactivity evaluation (scripts/live-eval.js): music the beat tracker finds hard,
// where lights must still react from the first second. Each has its true hits (time, kind, gain): kinds k (kick or
// another low drum stroke), s (snare, clap, a sharp treble stroke), h (hi-hat). Deterministic.
//   hiphop808   92 BPM, syncopated kicks, long 808 notes that slide in pitch (a slide is no new hit), claps, hat rolls
//   bhangra     dhol chaal in a 12/8 feel (triplet swing), ~100 BPM, with a sung line
//   tabla       a 16-beat tabla cycle with glides on the bass drum (ge), 84 BPM, plus a drone
//   vocal       a singer with sparse drums: one kick and one snare every two bars, a pad
//   rubato      a live band drifting between 90 and 110 BPM with loose timing, fills and a slow-down
//   mix         a DJ mix: a 122 BPM groove crossfading into a 128 BPM one over 8 bars
import { rng } from "./synth.js";

function mk(sr, dur, seed) {
  const n = Math.floor(dur * sr), x = new Float32Array(n), r = rng(seed), hits = [];
  const put = (t, fn, d, g = 1) => { const i0 = Math.floor(t * sr); if (i0 < 0) return; for (let k = 0; k < d * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr) * g; };
  const hit = (t, k, g = 1) => { if (t >= 0 && t < dur) hits.push({ t, k, g }); };
  const V = {
    kick: (t, g = 1) => { let ph = 0; put(t, s => { ph += 2 * Math.PI * (45 + 90 * Math.exp(-s * 28)) / sr; return Math.sin(ph) * Math.exp(-s * 7); }, 0.4, g); hit(t, "k", g); },
    // an 808: a click and a long sine; `to` slides the pitch there from `slideAt` on (no new attack)
    e808: (t, f, len, g = 1, to = null, slideAt = 0.3) => { let ph = 0; put(t, s => { const ff = to && s > slideAt ? f + (to - f) * Math.min(1, (s - slideAt) / 0.12) : f; ph += 2 * Math.PI * (ff + 60 * Math.exp(-s * 40)) / sr;
      return Math.tanh(1.6 * Math.sin(ph)) * Math.exp(-s * 1.3) * Math.min(1, (len - s) / 0.03) * 0.8; }, len, g); hit(t, "k", g); },
    snare: (t, g = 1) => { put(t, s => (r() * 0.6 + Math.sin(2 * Math.PI * 190 * s) * 0.4) * Math.exp(-s * 18), 0.2, g * 0.8); hit(t, "s", g); },
    clap: (t, g = 1) => { put(t, s => r() * (Math.exp(-s * 30) + 0.5 * Math.exp(-Math.abs(s - 0.012) * 300) + 0.5 * Math.exp(-Math.abs(s - 0.024) * 300)) * 0.6, 0.25, g); hit(t, "s", g); },
    hat: (t, g = 1) => { let hp = 0; put(t, s => { const w = r(), y = w - hp; hp = w; return y * 0.3 * Math.exp(-s * 70); }, 0.05, g); hit(t, "h", g * 0.6); },
    // tabla: na / ta (the right drum: a ringing tone with inharmonic partials), ge (the left: a low thud whose pitch glides up)
    na: (t, g = 1, f = 540) => { put(t, s => (Math.sin(2 * Math.PI * f * s) + 0.5 * Math.sin(2 * Math.PI * f * 2.02 * s) + 0.3 * Math.sin(2 * Math.PI * f * 3.1 * s) + r() * 0.4 * Math.exp(-s * 200)) * Math.exp(-s * 9) * 0.35, 0.4, g); hit(t, "s", g * 0.8); },
    ge: (t, g = 1, glide = 1) => { let ph = 0; put(t, s => { ph += 2 * Math.PI * (85 + 55 * glide * Math.min(1, s / 0.25)) / sr; return Math.sin(ph) * Math.exp(-s * 5) * 0.9 + r() * 0.2 * Math.exp(-s * 80); }, 0.6, g); hit(t, "k", g); },
    // dhol: dagga (bass head: a thump), tilli (treble stick: a crack)
    dagga: (t, g = 1) => { let ph = 0; put(t, s => { ph += 2 * Math.PI * (70 + 40 * Math.exp(-s * 20)) / sr; return Math.sin(ph) * Math.exp(-s * 9) + r() * 0.3 * Math.exp(-s * 60); }, 0.35, g); hit(t, "k", g); },
    tilli: (t, g = 1) => { put(t, s => (r() * 0.7 * Math.exp(-s * 70) + Math.sin(2 * Math.PI * 820 * s) * 0.3 * Math.exp(-s * 35)), 0.12, g * 0.7); hit(t, "s", g * 0.7); },
    tone: (t, f, len, g, h = [1, 0.4, 0.15], dec = 1.5) => put(t, s => h.reduce((a, w, i) => a + w * Math.sin(2 * Math.PI * f * (i + 1) * s), 0) * Math.exp(-s * dec) * Math.min(1, s / 0.01) * Math.min(1, (len - s) / 0.05), len, g),
    pad: (t, fs, len, g) => put(t, s => fs.reduce((a, f) => a + Math.sin(2 * Math.PI * f * s), 0) * Math.min(1, s / 0.4) * Math.min(1, (len - s) / 0.3), len, g),
    // a sung line: harmonics through vowel formants, vibrato, a slow melody (notes [hz, seconds])
    sing: (t, notes, g) => { const formant = f => [[700, 130, 1], [1200, 160, 0.5], [2600, 200, 0.25]].reduce((s, [c, bw, a]) => s + a / (1 + ((f - c) / bw) ** 2), 0);
      let tt = t; for (const [f, d] of notes) { if (f) { let ph = 0; put(tt, s => { const f0 = f * (1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * s) + 0.01 * Math.sin(s * 1.7)); ph += 2 * Math.PI * f0 / sr; let v = 0; for (let h = 1; h * f0 < 4000; h++) v += Math.sin(h * ph) * formant(h * f0) / h ** 0.3; return v * 0.12 * Math.min(1, s / 0.08) * Math.min(1, (d - s) / 0.08); }, d, g); } tt += d; } },
  };
  const done = name => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] = x[i] / (m || 1) * 0.9 + r() * 0.001;
    hits.sort((a, b) => a.t - b.t); return { name, x, sr, dur, truth: { hits, kicks: hits.filter(h => h.k === "k").map(h => h.t) } }; };
  return { V, r, done, put, hit };
}

export function hiphop808(sr = 22050) {
  const bpm = 92, P = 60 / bpm, bars = 14, { V, r, done } = mk(sr, bars * 4 * P + 1, 21);
  const roots = [49, 49, 41.2, 55]; // G1, G1, E1, A1
  const kpat = [[0, 0.75, 2.5], [0, 1.75, 2.25, 3.5], [0, 0.75, 2.5, 3.25], [0.5, 1.75, 2.5]];
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * P, f = roots[b % 4], intro = b < 2, pat = kpat[b % 4];
    V.pad(t0, [196, 233, 294], 4 * P, 0.05);
    if (!intro) pat.forEach((q, i) => { const len = (i + 1 < pat.length ? pat[i + 1] : 4) - q; const slide = i === pat.length - 1 && b % 2 ? roots[(b + 1) % 4] * 1.5 : null; V.e808(t0 + q * P, f, Math.max(0.2, len * P), 1, slide, len * P * 0.5); });
    if (!intro) for (const q of [1, 3]) V.clap(t0 + q * P, 0.9);
    for (let q = 0; q < 8; q++) { if (b % 4 === 3 && q >= 6) { for (let k = 0; k < 6; k++) V.hat(t0 + (3 + k / 6) * P, 0.7); break; } V.hat(t0 + q * P / 2, q % 2 ? 0.6 : 0.9); }
    if (b >= 6 && b < 12 && b % 2 === 0) V.sing(t0, [[392, P * 2], [349, P], [311, P], [294, P * 2], [0, P * 2]], 0.8);
  }
  return done("hiphop808 (syncopated, 808 slides) 92");
}

export function bhangra(sr = 22050) {
  const bpm = 100, P = 60 / bpm, bars = 14, { V, done } = mk(sr, bars * 4 * P + 1, 22);
  // the chaal on triplet eighths: 12 slots a bar (3 per beat). Dagga on 0, (5), 6, 9; tilli on the rest that are played
  const dag = [0, 5, 6, 9], til = [2, 3, 8, 11];
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * P, s = P / 3;
    V.pad(t0, [146.8, 220, 293.7], 4 * P, 0.04);
    if (b === 0) { for (const k of [0, 6]) V.dagga(t0 + k * s, 0.7); continue; } // a sparse first bar
    for (const k of dag) V.dagga(t0 + k * s, k === 0 ? 1 : 0.8);
    for (const k of til) V.tilli(t0 + k * s, k % 3 === 2 ? 0.9 : 0.6);
    if (b % 4 === 3) for (let k = 0; k < 6; k++) V.tilli(t0 + (2 + k / 3) * P + s, 0.5); // a roll
    if (b >= 4) V.sing(t0, [[440, P], [494, P / 2], [440, P / 2], [392, P], [370, P]], 0.7);
    V.tone(t0, 73.4, 4 * P, 0.2, [1, 0.3], 0.6);
  }
  return done("bhangra dhol chaal (12/8 feel) 100");
}

export function tabla(sr = 22050) {
  const bpm = 84, P = 60 / bpm, cycles = 4, { V, done, r } = mk(sr, cycles * 16 * P + 1.5, 23);
  // teentaal theka: dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha  (dha/dhin: ge + na, tin/ta: na)
  const theka = ["dha", "dhin", "dhin", "dha", "dha", "dhin", "dhin", "dha", "dha", "tin", "tin", "ta", "ta", "dhin", "dhin", "dha"];
  V.pad(0, [130.8, 196, 261.6], cycles * 16 * P + 1, 0.05); // the tanpura-like drone
  for (let c = 0; c < cycles; c++) for (let q = 0; q < 16; q++) {
    const t = (c * 16 + q) * P + r() * 0.008, bol = theka[q], open = bol === "dha" || bol === "dhin", empty = q >= 8 && q < 13; // the khali
    if (open && !empty) V.ge(t, q === 0 ? 1 : 0.75, q % 4 === 0 ? 1.2 : 0.6);
    V.na(t, bol === "dhin" || bol === "tin" ? 0.65 : 0.9, bol === "tin" || bol === "dhin" ? 620 : 540);
    if (c >= 2 && q % 2 === 1) V.na(t + P / 2, 0.45, 700); // the second half: double time fills
  }
  return done("tabla teentaal (16 beats, ge glides) 84");
}

export function vocalSparse(sr = 22050) {
  const bpm = 76, P = 60 / bpm, bars = 12, { V, done } = mk(sr, bars * 4 * P + 1, 24);
  const mel = [[330, 1.5], [294, 0.5], [262, 1], [247, 1], [262, 2], [0, 1], [294, 1]];
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * P;
    V.pad(t0, b % 2 ? [174.6, 220, 261.6] : [130.8, 164.8, 196], 4 * P, 0.07);
    V.sing(t0, mel.map(([f, d]) => [f * (b % 4 >= 2 ? 1.12 : 1), d * P]), 1.1);
    if (b % 2 === 1) { V.kick(t0, 0.8); V.snare(t0 + 2 * P, 0.6); }
  }
  return done("vocal with sparse drums 76");
}

export function rubato(sr = 22050) {
  const bars = 16, { V, done, r } = mk(sr, 42, 25), beats = []; let t = 0.3;
  for (let i = 0; i <= bars * 4; i++) { beats.push(t); const bpm = 100 + 10 * Math.sin(i / 10) - (i > 52 ? (i - 52) * 2.5 : 0); t += 60 / bpm; }
  const at = (b, q) => { const i = b * 4 + Math.floor(q), f = q - Math.floor(q); return beats[i] + f * (beats[i + 1] - beats[i]) + r() * 0.018; };
  const roots = [110, 98, 87.3, 98];
  for (let b = 0; b < bars; b++) {
    const t0 = beats[b * 4], len = beats[b * 4 + 4] - t0, f = roots[b % 4];
    V.pad(t0, [f * 2, f * 2.5, f * 3], len, 0.05);
    for (const q of [0, 1, 2, 3]) V.tone(at(b, q), f / 2, (beats[b * 4 + 1] - beats[b * 4]) * 0.9, 0.35, [1, 0.6, 0.3, 0.2], 3);
    const fill = b % 4 === 3;
    for (const q of fill ? [0, 2] : [0, 2.5]) V.kick(at(b, q), 0.75 + 0.25 * Math.abs(r()));
    for (const q of fill ? [1, 3, 3.25, 3.5, 3.75] : [1, 3]) V.snare(at(b, q), fill && q > 3 ? 0.5 + q / 8 : 0.8 + 0.2 * Math.abs(r()));
    if (!fill) for (let q = 0; q < 8; q++) V.hat(at(b, q / 2), 0.5 + 0.3 * Math.abs(r()));
  }
  return done("live band rubato 90-110");
}

export function djMix(sr = 22050) {
  const { V, done } = mk(sr, 40, 26), A = 60 / 122, B = 60 / 128, x0 = 12, x1 = x0 + 8 * 4 * A; // crossfade from 12 s for 8 bars of A
  const fade = t => Math.max(0, Math.min(1, (t - x0) / (x1 - x0)));
  for (let t = 0; t < x1; t += A) { const g = 1 - fade(t); if (g < 0.05) continue; V.kick(t, g); V.hat(t + A / 2, g * 0.8); if (Math.round(t / A) % 2) V.clap(t, g * 0.8); }
  for (let t = x0 + 0.137; t < 39; t += B) { const g = fade(t); if (g < 0.05) continue; V.kick(t, g); V.hat(t + B / 2, g * 0.8); if (Math.round((t - x0) / B) % 2) V.snare(t, g * 0.8); }
  for (let t = 0; t < 39; t += 4 * A) V.pad(t, [220, 277, 330], 4 * A, 0.04);
  return done("DJ mix 122 -> 128 crossfade");
}

/** All of them: name -> song. */
export const MESSY = { hiphop808, bhangra, tabla, vocalSparse, rubato, djMix };
