#!/usr/bin/env node
// Live reactivity evaluation: do the lights react to the music from the first second, on any music, the way LedFx
// does? Songs (the synthetic corpus plus a "messy" set the beat tracker finds hard: packages/engine/test/messy-songs.js)
// go through the real live path on the example room at 60 fps (LiveAnalyser -> view -> director -> effects -> 8-bit
// LEDs) and through a LedFx-like baseline written here (mel filterbank -> gain normalisation -> rise/decay filter ->
// LedFx's "Energy" effect: lows, mids and highs as bars from the middle of each strip). Each run is measured against the
// song's true hits:
//   corr     onset-to-light correlation: the light's brightness (minus its 0.6 s average) against the true hits (each a
//            100 ms decay, kicks 1, snares 0.8, hats 0.4), best lag 0-100 ms. corr5: the first 5 s of music only
//   kick     kick contrast: (brightest frame in the 120 ms after a true kick - darkest in the 120 ms before) / brightest,
//            median over kicks; hit: the share of kicks with a contrast of 0.15 or more
//   flat     the share of frames while music plays where the LEDs hardly change (mean change under 0.5 of 255)
// Runs: tl = Tempolight as the app ships (automatic mode, one look per song, predicted beats); low = the same with the
// beat confidence forced to 0 (no grid to lean on: the reactive floor); ledfx = the baseline.
//
//   node scripts/live-eval.js                    # the table
//   node scripts/live-eval.js --json
//   node scripts/live-eval.js --baseline check   # compare with packages/engine/test/baselines/live.json (exit 1 if worse)
//   node scripts/live-eval.js --baseline write
//   node scripts/live-eval.js --effects          # each AUTO effect alone (manual mode) with the confidence forced to 0
//   node scripts/live-eval.js --only hiphop808,tabla
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLayout, exampleRoom, createEffects, createDirector, LiveAnalyser, toRGB8, AUTO } from "../packages/engine/src/index.js";
import { realFFT } from "../packages/engine/src/fft.js";
import { rng, edm, majorPop } from "../packages/engine/test/synth.js";
import { feelSong } from "../packages/engine/test/feel-song.js";
import { makeSong, SPECS } from "../packages/engine/test/beat-songs.js";
import { MESSY } from "../packages/engine/test/messy-songs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE = path.join(root, "packages/engine/test/baselines/live.json");
const FPS = 60, SR = 22050;
const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

// ---------------------------------------------------------------- songs with their true hits
function hitsFrom(kicks = [], snares = [], hats = []) { return [...kicks.map(t => ({ t, k: "k", g: 1 })), ...snares.map(t => ({ t, k: "s", g: 0.8 })), ...hats.map(t => ({ t, k: "h", g: 0.6 }))].sort((a, b) => a.t - b.t); }
function fromSpec(name) { // a beat-songs.js groove, its snares and hats from the pattern
  const spec = SPECS.find(s => s.name.startsWith(name)), s = makeSong(spec, SR), B = s.truth.beats, P = i => B[Math.min(B.length - 1, i)], sn = [], ht = [];
  for (let b = 0; b < spec.bars; b++) { const pat = spec.pattern(b, "full"), at = q => P(b * 4 + Math.floor(q)) + (q % 1) * (P(b * 4 + Math.floor(q) + 1) - P(b * 4 + Math.floor(q)));
    for (const q of pat.s || []) sn.push(at(q)); for (const q of pat.h || []) ht.push(at(q)); }
  return { name: s.name, x: s.x, sr: SR, dur: s.dur, set: "corpus", truth: { hits: hitsFrom(s.truth.kicks, sn, ht), kicks: s.truth.kicks } };
}
export function corpus() {
  const out = [];
  { const s = feelSong(SR), T = s.truth; out.push({ name: "feel song (EDM) 128", x: s.x, sr: SR, dur: s.dur, set: "corpus", truth: { hits: hitsFrom(T.kicks, T.snares, T.hats), kicks: T.kicks } }); }
  { const s = edm(SR), P = 60 / 128, bar = 4 * P, k = [], sn = [], h = [];
    for (let b = 0; b < 18; b++) { for (let q = 0; q < 4; q++) h.push(b * bar + q * P + P / 2);
      if (b >= 4 && b < 8) { const div = [1, 2, 4, 8][b - 4], steps = b === 7 ? 3 * div : 4 * div; for (let j = 0; j < steps; j++) sn.push(b * bar + j * P / div); }
      if (b >= 8 && b < 16) for (let q = 0; q < 4; q++) { k.push(b * bar + q * P); if (q % 2) sn.push(b * bar + q * P); } }
    out.push({ name: "edm 128", x: s.x, sr: SR, dur: s.x.length / SR, set: "corpus", truth: { hits: hitsFrom(k, sn, h), kicks: k } }); }
  { const s = majorPop(SR), P = 60 / 116, k = [], sn = [], h = [];
    for (let b = 0; b < 24; b++) for (let q = 0; q < 4; q++) { const t = (b * 4 + q) * P; k.push(t); if (q % 2) sn.push(t); h.push(t + P / 2); }
    out.push({ name: "pop 116", x: s.x, sr: SR, dur: s.x.length / SR, set: "corpus", truth: { hits: hitsFrom(k, sn, h), kicks: k } }); }
  for (const n of ["hiphop88", "dembow95", "halftime140", "broken-kick110"]) out.push(fromSpec(n));
  for (const f of Object.values(MESSY)) out.push({ ...f(SR), set: "messy" });
  return out;
}

// ---------------------------------------------------------------- real songs (local only: TEMPOLIGHT_REAL_AUDIO, a folder of 22050 Hz mono 16-bit WAVs)
function readWav(file) { const b = readFileSync(file); let o = 12, sr = 22050, ch = 1; while (o < b.length - 8 && b.toString("ascii", o, o + 4) !== "data") { if (b.toString("ascii", o, o + 4) === "fmt ") { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); } o += 8 + b.readUInt32LE(o + 4); }
  const n = Math.floor(Math.min(b.readUInt32LE(o + 4), b.length - o - 8) / 2 / ch), x = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(o + 8 + 2 * (i * ch + c)); x[i] = s / ch / 32768; } return { x, sr }; }
/** The hits of a real song, found offline with the whole song in view (no causality, no beat grid): per band group
 *  (lows under 150 Hz, mids to 2 kHz, highs) the log spectral flux, peaks above a centred median + threshold. */
export function offlineHits(x, sr) {
  const NF = 1024, HOP = 256, fft = realFFT(NF), buf = new Float32Array(NF), mag = new Float32Array(NF / 2), win = Float32Array.from({ length: NF }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF));
  const nH = Math.floor((x.length - NF) / HOP), binHz = sr / NF, grp = k => k * binHz < 150 ? 0 : k * binHz < 2000 ? 1 : 2, G = Array.from({ length: NF / 2 }, (_, k) => grp(k));
  const fl = [new Float32Array(nH), new Float32Array(nH), new Float32Array(nH)], prev = new Float32Array(NF / 2), cnt = [0, 0, 0]; for (let k = 1; k < NF / 2; k++) cnt[G[k]]++;
  for (let h = 0; h < nH; h++) { for (let i = 0; i < NF; i++) buf[i] = x[h * HOP + i] * win[i]; fft.mag(buf, mag);
    for (let k = 1; k < NF / 2; k++) { const v = Math.log1p(1000 * mag[k]), d = v - prev[k]; if (d > 0 && h) fl[G[k]][h] += d; prev[k] = v; } for (let g = 0; g < 3; g++) fl[g][h] /= cnt[g]; }
  const hits = [], kind = ["k", "s", "h"], dt = HOP / sr;
  for (let g = 0; g < 3; g++) { const f = fl[g], W = 20, srt = []; let last = -9; const p95 = [...f].sort((a, b) => a - b)[Math.floor(nH * 0.95)] || 1;
    for (let h = 2; h < nH - 2; h++) { if (!(f[h] > f[h - 1] && f[h] >= f[h + 1] && f[h] >= f[h - 2] && f[h] >= f[h + 2])) continue;
      srt.length = 0; for (let j = Math.max(0, h - W); j < Math.min(nH, h + W); j++) srt.push(f[j]); srt.sort((a, b) => a - b);
      const m = srt[srt.length >> 1], t = h * dt + NF / 2 / sr - HOP / sr + 0.02; if (f[h] > m * 2 + 0.4 * p95 && t - last > 0.09) { last = t; hits.push({ t, k: kind[g], g: Math.min(1, 0.4 + 0.6 * f[h] / p95) }); } } }
  // one stroke heard in several groups is one hit: the lowest group's within 30 ms
  hits.sort((a, b) => a.t - b.t); const rank = { k: 0, s: 1, h: 2 }, out = [];
  for (const h of hits) { const p = out.at(-1); if (p && h.t - p.t < 0.03) { if (rank[h.k] < rank[p.k]) out[out.length - 1] = h; continue; } out.push(h); }
  return out;
}
export function realSongs(dir = process.env.TEMPOLIGHT_REAL_AUDIO, maxSec = 90) {
  if (!dir) return []; let files = []; try { files = readdirSync(dir).filter(f => /\.wav$/i.test(f)).sort(); } catch { return []; }
  return files.map(f => { const { x: full, sr } = readWav(path.join(dir, f)), x = full.subarray(0, Math.min(full.length, Math.round(maxSec * sr))), hits = offlineHits(x, sr);
    return { name: f.replace(/\.wav$/i, ""), x, sr, dur: x.length / sr, set: "real", truth: { hits, kicks: hits.filter(h => h.k === "k").map(h => h.t) } }; });
}

// ---------------------------------------------------------------- the LedFx-like baseline
/** LedFx's audio path (mel filterbank, gain normalisation with a slow decay, rise/decay smoothing) and its Energy
 *  effect, at 60 fps, from the last 1024 samples each frame. Returns a frame renderer on the room's LEDs. */
export function ledfxLike(L, sr = SR) {
  const NF = 1024, NB = 24, fft = realFFT(NF), mag = new Float32Array(NF / 2), buf = new Float32Array(NF), win = new Float32Array(NF);
  for (let i = 0; i < NF; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (NF - 1));
  const mel = f => 2595 * Math.log10(1 + f / 700), hz = m => 700 * (10 ** (m / 2595) - 1), m0 = mel(40), m1 = mel(10000), edges = [];
  for (let i = 0; i <= NB + 1; i++) edges.push(hz(m0 + (m1 - m0) * i / (NB + 1)) / (sr / NF));
  const fb = []; for (let b = 0; b < NB; b++) { const lo = edges[b], c = edges[b + 1], hi = edges[b + 2], w = [];
    for (let k = Math.max(1, Math.floor(lo)); k <= Math.ceil(hi) && k < NF / 2; k++) { const v = k < c ? (k - lo) / Math.max(1e-6, c - lo) : (hi - k) / Math.max(1e-6, hi - c); if (v > 0) w.push([k, v]); } fb.push(w); }
  // ExpFilter as in LedFx: value += (x - value) * (x > value ? rise : decay), per update
  const gain = { v: 1e-3 }, smooth = new Float32Array(NB), px = new Float32Array(L.N * 3), m = new Float32Array(NB);
  const C = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ranges = [[0, 6], [6, 15], [15, 24]];
  const pos = Float32Array.from({ length: L.N }, (_, i) => Math.abs(L.LS[i] - 0.5) * 2);
  return function frame(x, end, out8) {
    for (let i = 0; i < NF; i++) { const j = end - NF + i; buf[i] = (j >= 0 ? x[j] : 0) * win[i]; }
    fft.mag(buf, mag);
    let top = 0; for (let b = 0; b < NB; b++) { let s = 0; for (const [k, w] of fb[b]) s += mag[k] * mag[k] * w; m[b] = s; }
    for (let b = 0; b < NB; b++) { const g = (m[Math.max(0, b - 1)] + 2 * m[b] + m[Math.min(NB - 1, b + 1)]) / 4; if (g > top) top = g; } // (a small blur, as gaussian_filter1d)
    gain.v += (top - gain.v) * (top > gain.v ? 0.99 : 0.01); const gv = Math.max(gain.v, 1e-7);
    for (let b = 0; b < NB; b++) { const v = Math.min(1, m[b] / gv); smooth[b] += (v - smooth[b]) * (v > smooth[b] ? 0.99 : 0.2); }
    const lvl = ranges.map(([a, b]) => { let s = 0; for (let k = a; k < b; k++) s += smooth[k]; return Math.min(1, s / (b - a) * 1.5); });
    for (let i = 0; i < L.N; i++) for (let c = 0; c < 3; c++) { let v = 0; for (let r = 0; r < 3; r++) if (pos[i] < lvl[r]) v += C[r][c]; const j = i * 3 + c; px[j] += (Math.min(1, v) - px[j]) * (v > px[j] ? 0.99 : 0.3); out8[j] = Math.round(255 * px[j]); }
    return out8;
  };
}

// ---------------------------------------------------------------- runs
/** Tempolight's live path. o.lowConf: the beat confidence is forced to 0; o.effect: that effect alone (manual mode). */
export function runTempolight(song, L, o = {}) {
  const savedRandom = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42));
  try {
    const fx = createEffects(L), D = createDirector(L, fx), an = new LiveAnalyser(song.sr);
    D.settings.variety = o.variety || "one"; if (o.effect) { D.settings.mode = "manual"; D.settings.effect = o.effect; }
    const nF = Math.floor(song.dur * FPS), frames = new Array(nF), c8 = new Uint8Array(L.N * 3); let pos = 0, cpu = 0;
    for (let f = 0; f < nF; f++) {
      const now = (f + 1) / FPS, t0 = performance.now(); const end = Math.min(song.x.length, Math.round((f + 1) * song.sr / FPS)); an.push(song.x.subarray(pos, end)); cpu += performance.now() - t0; pos = end; // (on the frame clock: no drift)
      const t = an.t; let V = an.view(t, { predict: !o.lowConf }); const extra = an.extras();
      if (o.lowConf) { V.conf = 0; V.rel = 0; }
      if (V.state === "silent" && V.quietFor > 8) V = null;
      toRGB8(D.frame(V, t, extra, now), c8, 0.8); frames[f] = Uint8Array.from(c8);
    }
    return { frames, cpuMsPerS: cpu / song.dur };
  } finally { Math.random = savedRandom; }
}
export function runLedfx(song, L) {
  const F = ledfxLike(L, song.sr), chunk = song.sr / FPS, nF = Math.floor(song.dur * FPS), frames = new Array(nF), c8 = new Uint8Array(L.N * 3);
  for (let f = 0; f < nF; f++) { F(song.x, Math.min(song.x.length, Math.round((f + 1) * chunk)), c8); frames[f] = Uint8Array.from(c8); }
  return { frames };
}

// ---------------------------------------------------------------- metrics
function corr(a, b) { const n = Math.min(a.length, b.length); if (n < 10) return null; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let xy = 0, xx = 0, yy = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; xy += x * y; xx += x * x; yy += y * y; } return xx > 1e-12 && yy > 1e-12 ? xy / Math.sqrt(xx * yy) : 0; }
const W = { k: 1, s: 0.8, h: 0.4 };
export function measure(R, song) {
  const fr = R.frames, nF = fr.length, n3 = fr[0].length, lum = new Float32Array(nF), mot = new Float32Array(nF);
  for (let f = 0; f < nF; f++) { let s = 0, d = 0; const a = fr[f], p = f ? fr[f - 1] : a; for (let i = 0; i < n3; i++) { s += a[i]; d += Math.abs(a[i] - p[i]); } lum[f] = s / n3 / 255; mot[f] = d / n3; }
  const hits = song.truth.hits, t0 = hits.length ? hits[0].t : 0, t1 = hits.length ? hits.at(-1).t + 0.5 : song.dur;
  const y = new Float32Array(nF); for (const h of hits) { const f0 = Math.ceil(h.t * FPS); for (let f = f0; f < nF && f < f0 + 30; f++) y[f] += W[h.k] * h.g * Math.exp(-(f / FPS - h.t) / 0.1); }
  const hw = Math.round(0.3 * FPS), z = new Float32Array(nF), cs = new Float64Array(nF + 1); // lum minus its centred 0.6 s mean
  for (let f = 0; f < nF; f++) cs[f + 1] = cs[f] + lum[f];
  for (let f = 0; f < nF; f++) { const a = Math.max(0, f - hw), b = Math.min(nF, f + hw + 1); z[f] = lum[f] - (cs[b] - cs[a]) / (b - a); }
  const span = (a, b) => [Math.max(1, Math.round(a * FPS)), Math.min(nF - 7, Math.round(b * FPS))];
  const corrIn = (a, b) => { const [f0, f1] = span(a, b); let best = -1; for (let lag = 0; lag <= 6; lag++) { const c = corr(y.subarray(f0, f1), z.subarray(f0 + lag, f1 + lag)); if (c != null && c > best) best = c; } return best; };
  const at = t => Math.max(0, Math.min(nF - 1, Math.round(t * FPS) - 1)), mx = (a, b) => { let m = 0; for (let f = at(a); f <= at(b); f++) m = Math.max(m, lum[f]); return m; }, mn = (a, b) => { let m = 9; for (let f = at(a); f <= at(b); f++) m = Math.min(m, lum[f]); return m; };
  const kc = (from, to) => song.truth.hits.filter(h => h.k === "k" && h.g >= 0.5 && h.t >= from && h.t < to).map(h => { const pk = mx(h.t, h.t + 0.12); return (pk - mn(h.t - 0.12, h.t - 1 / FPS)) / Math.max(1e-3, pk); });
  const flatIn = (a, b) => { const [f0, f1] = span(a, b); let k = 0; for (let f = f0; f < f1; f++) if (mot[f] < 0.5) k++; return k / Math.max(1, f1 - f0); };
  const ka = kc(t0, t1), k5 = kc(t0, t0 + 5);
  return { corr: r3(corrIn(t0, t1)), corr5: r3(corrIn(t0, t0 + 5)), kick: r3(med(ka)), kick5: r3(med(k5)), hit: r3(ka.length ? ka.filter(v => v >= 0.15).length / ka.length : null), flat: r3(flatIn(t0, t1)), flat5: r3(flatIn(t0, t0 + 5)), lum: r3(mean(Array.from(lum.subarray(...span(t0, t1))))) };
}

export function runLive({ only = null } = {}) {
  const L = buildLayout(exampleRoom()), songs = [...corpus(), ...realSongs()].filter(s => !only || only.some(o => s.name.startsWith(o))), rows = [];
  let cpu = 0, dur = 0;
  for (const s of songs) {
    const tl = runTempolight(s, L), low = runTempolight(s, L, { lowConf: true }), lf = runLedfx(s, L);
    cpu += tl.cpuMsPerS * s.dur; dur += s.dur;
    rows.push({ name: s.name, set: s.set, tl: measure(tl, s), low: measure(low, s), ledfx: measure(lf, s) });
  }
  const agg = (set, run, k) => r3(mean(rows.filter(r => !set || r.set === set).map(r => r[run][k]).filter(v => v != null)));
  const summary = {}; for (const set of ["corpus", "messy", "real", null]) for (const run of ["tl", "low", "ledfx"]) for (const k of ["corr", "corr5", "kick", "kick5", "hit", "flat", "flat5"]) summary[`${set || "all"}.${run}.${k}`] = agg(set, run, k);
  return { songs: rows, summary, analyserCpuMsPerS: analyserCpu(), analyserCpuColdMsPerS: r3(cpu / dur) };
}

/** The live analyser's CPU, warmed up: the feel song pushed in 60 fps chunks with a view each, the median of 3 runs
 *  after one to warm up (ms of CPU per second of audio). */
export function analyserCpu() {
  const s = feelSong(SR), chunk = Math.round(SR / FPS), runs = [];
  for (let k = 0; k < 4; k++) { const an = new LiveAnalyser(SR), t0 = performance.now(); for (let i = 0; i < s.x.length; i += chunk) { an.push(s.x.subarray(i, i + chunk)); an.view(an.t, { predict: true }); } runs.push((performance.now() - t0) / s.dur); }
  return r3(med(runs.slice(1)));
}

/** Each AUTO effect alone with the beat confidence forced to 0, on the messy songs. */
export function runEffects({ only = null } = {}) {
  const L = buildLayout(exampleRoom()), songs = [...corpus(), ...realSongs()].filter(s => s.set === "messy" && (!only || only.some(o => s.name.startsWith(o))));
  const ids = [...new Set([...AUTO.drop, ...AUTO.build, ...AUTO.calm])], out = {};
  for (const id of ids) { const ms = songs.map(s => measure(runTempolight(s, L, { lowConf: true, effect: id }), s));
    out[id] = { corr: r3(mean(ms.map(m => m.corr))), kick: r3(mean(ms.map(m => m.kick ?? 0))), flat: r3(mean(ms.map(m => m.flat))), worstCorr: r3(Math.min(...ms.map(m => m.corr))) }; }
  return out;
}

// ---------------------------------------------------------------- baseline
const H = m => (n, b) => n < b - m, Lo = m => (n, b) => n > b + m;
export const GUARDS = [
  ...["corpus", "messy"].flatMap(set => [
    [`${set}: Tempolight onset corr`, r => r.summary[`${set}.tl.corr`], H(0.03)],
    [`${set}: Tempolight onset corr, first 5 s`, r => r.summary[`${set}.tl.corr5`], H(0.04)],
    [`${set}: Tempolight kick contrast`, r => r.summary[`${set}.tl.kick`], H(0.04)],
    [`${set}: low-conf onset corr`, r => r.summary[`${set}.low.corr`], H(0.03)],
    [`${set}: low-conf kick contrast`, r => r.summary[`${set}.low.kick`], H(0.04)],
    [`${set}: Tempolight flat frames`, r => r.summary[`${set}.tl.flat`], Lo(0.03)],
  ]),
  ["analyser CPU ms per audio second", r => r.analyserCpuMsPerS, (n, b) => n > Math.max(18, b * 1.5)],
];
export function checkBaseline(r, base) { return GUARDS.map(([name, get, worse]) => { const n = get(r), b = get(base); return { name, now: n, base: b, ok: b == null ? true : n == null ? false : !worse(n, b) }; }); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), mi = args.indexOf("--baseline"), mode = mi >= 0 ? args[mi + 1] : null, oi = args.indexOf("--only"), only = oi >= 0 ? args[oi + 1].split(",") : null;
  const t0 = performance.now();
  if (args.includes("--effects")) {
    const e = runEffects({ only }); if (args.includes("--json")) console.log(JSON.stringify(e, null, 1)); else {
      console.log("effect alone, beat confidence 0, messy songs: onset corr (mean, worst), kick contrast, flat frames");
      for (const [id, m] of Object.entries(e).sort((a, b) => a[1].corr - b[1].corr)) console.log(`  ${id.padEnd(12)} corr ${String(m.corr).padEnd(6)} worst ${String(m.worstCorr).padEnd(6)} kick ${String(m.kick).padEnd(6)} flat ${m.flat}${m.corr < 0.2 || m.flat > 0.3 ? "   <- weak" : ""}`); }
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`); process.exit(0);
  }
  const r = runLive({ only });
  if (mode === "write") { mkdirSync(path.dirname(BASELINE), { recursive: true }); writeFileSync(BASELINE, JSON.stringify({ about: "Live reactivity baseline (scripts/live-eval.js). Rewrite with: node scripts/live-eval.js --baseline write", ...r }, null, 1) + "\n"); }
  const chk = mode === "check" ? checkBaseline(r, JSON.parse(readFileSync(BASELINE, "utf8"))) : null;
  if (args.includes("--json")) console.log(JSON.stringify({ ...r, ...(chk ? { baseline: chk } : {}) }, null, 1));
  else {
    const c = v => String(v ?? "-").padEnd(6);
    console.log(`${"song".padEnd(40)} ${"run".padEnd(6)} corr   corr5  kick   kick5  hit    flat   flat5`);
    for (const s of r.songs) for (const run of ["tl", "low", "ledfx"]) { const m = s[run]; console.log(`${(run === "tl" ? s.name : "").padEnd(40)} ${run.padEnd(6)} ${c(m.corr)} ${c(m.corr5)} ${c(m.kick)} ${c(m.kick5)} ${c(m.hit)} ${c(m.flat)} ${c(m.flat5)}`); }
    console.log("\nmeans:");
    for (const set of ["corpus", "messy", "real", "all"]) for (const run of ["tl", "low", "ledfx"]) { const g = k => r.summary[`${set}.${run}.${k}`];
      console.log(`  ${set.padEnd(7)} ${run.padEnd(6)} corr ${c(g("corr"))} corr5 ${c(g("corr5"))} kick ${c(g("kick"))} kick5 ${c(g("kick5"))} hit ${c(g("hit"))} flat ${c(g("flat"))} flat5 ${c(g("flat5"))}`); }
    console.log(`\nlive analyser: ${r.analyserCpuMsPerS} ms CPU per audio second warmed up (${r.analyserCpuColdMsPerS} over the whole run, with the warm-up)`);
    if (chk) { console.log(`\nbaseline check: ${chk.every(x => x.ok) ? "OK" : "WORSE"}`); for (const x of chk) console.log(`  ${x.ok ? "ok  " : "FAIL"}  ${x.name.padEnd(40)} ${c(x.now)} baseline ${x.base}`); }
    if (mode === "write") console.log(`\nbaseline written: ${path.relative(root, BASELINE)}`);
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (chk && !chk.every(x => x.ok)) process.exit(1);
}
