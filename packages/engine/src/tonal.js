// Harmony and mood: what key a song is in, how it feels, and a compact "chroma" fingerprint for song memory.
// Pure JavaScript, no I/O. The same ChromaTap runs over a whole song (analysis.js) and on a live stream (live.js), so
// a remembered song's chroma and what is heard live line up frame for frame.
//
// Chroma: every 100 ms, a 4096-point FFT (about 186 ms at 22 kHz, fine enough to tell semitones apart down to ~80 Hz).
// Spectral peaks from 65 Hz to 4.2 kHz are placed on the 12 pitch classes (C, C#, ... B) at their interpolated
// frequency; each frame is scaled so its strongest pitch class is 1. Key: the song's average chroma against the
// Krumhansl-Schmuckler profiles of the 24 major and minor keys. Mood: valence (major/minor, brightness) and energy
// (drums, tempo, onsets, brightness), both 0..1.

import { realFFT } from "./fft.js";

export const CH_RATE = 10;           // chroma frames a second (stored at half that: 5 a second)
const NF = 4096, HALF = NF / 2;
export const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const tables = new Map(); // the Hann window, shared by every tap
function fftTables() {
  let t = tables.get(NF); if (t) return t;
  const win = new Float32Array(NF); for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
  t = { win, fft: realFFT(NF) }; tables.set(NF, t); return t;
}

/** Streams samples in, one chroma frame (12 values, strongest = 1; all 0 when quiet or noisy) every 100 ms. */
export class ChromaTap {
  /**
   * @param {number} sr sample rate of what you push @param {number} [seconds] how many frames to keep
   * @param {{bass?:boolean}} [o] bass: also keep a bass chroma per frame (30-250 Hz, in `bassFrames`), for chords and the key
   */
  constructor(sr = 22050, seconds = 20, o = {}) {
    this.sr = sr; this.hop = Math.round(sr / CH_RATE); this.max = Math.round(seconds * CH_RATE); this.bassOn = !!o.bass;
    this.T = fftTables(); this.ring = new Float32Array(NF); this.buf = new Float32Array(NF); this.mag = new Float32Array(HALF);
    const binHz = sr / NF; this.binHz = binHz; this.kLo = Math.max(2, Math.floor(65 / binHz)); this.kHi = Math.min(HALF - 2, Math.ceil(4200 / binHz)); this.kTop = Math.min(HALF - 1, Math.ceil(10000 / binHz));
    this.bLo = Math.max(2, Math.floor(30 / binHz)); this.bHi = Math.ceil(250 / binHz);
    this.reset();
  }
  reset() { this.lite = !!this.lite; this.pos = 0; this.n = 0; this.since = 0; this.frames = []; this.bassFrames = []; this.count = 0; this.eRef = 0; this.bright = 0.5; this.lastBright = null; }
  /** one sample (-1..1) */
  push(v) { this.ring[this.pos] = v; this.pos = (this.pos + 1) & (NF - 1); this.n++; if (++this.since >= this.hop) { this.since = 0; this.frame(); } }
  frame() {
    const { buf, ring, mag, T } = this, { win, fft } = T; let e = 0;
    for (let i = 0; i < NF; i++) { const v = ring[(this.pos + i) & (NF - 1)]; buf[i] = v * win[i]; e += v * v; }
    e /= NF; this.eRef = Math.max(this.eRef * 0.9967, e); // the loudest of the last ~30 s
    // low-power mode: every 2nd frame repeats the one before (the 186 ms FFT window spans both 100 ms steps anyway)
    if (this.lite && (this.count & 1) && this.frames.length) { this.count++; this.keep(this.frames[this.frames.length - 1], this.bassOn ? this.bassFrames[this.bassFrames.length - 1] : null); return; }
    const c = new Float32Array(12), bc = this.bassOn ? new Float32Array(12) : null; this.count++;
    if (this.n < NF || e < 1e-10 || e < this.eRef * 1e-3) { this.lastBright = null; this.keep(c, bc); return; }
    fft.mag(buf, mag, this.kTop + 1);
    let top = 0, cs = 0, cw = 0;
    for (let k = 1; k <= this.kTop; k++) { const m = mag[k]; if (k >= this.kLo && k <= this.kHi && m > top) top = m; cs += m * k; cw += m; }
    this.lastBright = cw > 0 ? clamp((Math.log2(cs / cw * this.binHz) - Math.log2(350)) / 3) : null; // centroid 350 Hz → 0, 2.8 kHz → 1
    const thr = top * 0.02;
    this.peaks(c, this.kLo, this.kHi, thr, true);
    let mx = 0; for (let i = 0; i < 12; i++) mx = Math.max(mx, c[i]);
    if (mx > 0) for (let i = 0; i < 12; i++) c[i] /= mx;
    if (bc) { this.peaks(bc, this.bLo, this.bHi, thr, false); let bm = 0; for (let i = 0; i < 12; i++) bm = Math.max(bm, bc[i]); if (bm > 0) for (let i = 0; i < 12; i++) bc[i] = bc[i] / bm * Math.min(1, bm / (top || 1)); } // (scaled down when the bass is weak)
    this.keep(c, bc);
  }
  // spectral peaks from bin a to b onto the 12 pitch classes, at their interpolated frequency
  peaks(c, a, b, thr, tilt) {
    const mag = this.mag, binHz = this.binHz;
    for (let k = a; k <= b; k++) {
      const m = mag[k]; if (m <= thr || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const y0 = Math.log(mag[k - 1] + 1e-12), y1 = Math.log(m + 1e-12), y2 = Math.log(mag[k + 1] + 1e-12);
      const d = clamp(0.5 * (y0 - y2) / ((y0 - 2 * y1 + y2) || -1e-9), -0.5, 0.5), f = (k + d) * binHz;
      const pc = ((69 + 12 * Math.log2(f / 440)) % 12 + 12) % 12, i0 = Math.floor(pc), fr = pc - i0, w = m * (tilt && f >= 1000 ? 1000 / f : 1);
      c[i0 % 12] += w * (1 - fr); c[(i0 + 1) % 12] += w * fr;
    }
  }
  keep(c, bc) { this.frames.push(c); if (this.frames.length > this.max) this.frames.shift(); if (bc) { this.bassFrames.push(bc); if (this.bassFrames.length > this.max) this.bassFrames.shift(); } }
  /**
   * What song memory matches against: the last 2n + 1 frames (10 a second, flat, newest last; 12 s for n = 60), or
   * fewer, down to 2 min + 1 (6 s for min = 30), while less has been heard; null until then or when too few of them
   * have clear notes (drums only, noise, silence).
   */
  window(n = 60, min = 30) {
    const f = this.frames, L = f.length, m = Math.min(2 * n + 1, L - ((L - 1) & 1 ? 1 : 0)); if (L < 2 * Math.min(n, min) + 1) return null;
    const out = new Float32Array(m * 12); let tonal = 0;
    for (let i = 0; i < m; i++) { const c = f[L - m + i]; out.set(c, i * 12); let sm = 0; for (let k = 0; k < 12; k++) sm += c[k]; if (sm > 0 && sm < 7) tonal++; }
    return tonal >= m * 0.3 ? out : null;
  }
}

/**
 * Run a ChromaTap over a whole song: {frames: Float32Array(n * 12) at 10 a second, bass: the same for the bass
 * (30-250 Hz, scaled down when the bass is weak), bright: 0..1 average}. Frame i covers the 186 ms before (i + 1) / 10 s.
 */
export async function songChroma(x, sr, onProgress) {
  const tap = new ChromaTap(sr, 1e9, { bass: true }), bs = []; let lastCount = 0;
  const step = sr * 20;
  for (let i0 = 0; i0 < x.length; i0 += step) {
    const i1 = Math.min(x.length, i0 + step); for (let i = i0; i < i1; i++) { tap.push(x[i]); if (tap.count !== lastCount) { lastCount = tap.count; const fr = tap.frames[tap.frames.length - 1]; if (tap.lastBright != null && fr.some(v => v > 0)) bs.push(tap.lastBright); } }
    onProgress && onProgress(i1 / x.length); await new Promise(r => setTimeout(r, 0));
  }
  const n = tap.frames.length, frames = new Float32Array(n * 12), bass = new Float32Array(n * 12);
  tap.frames.forEach((c, i) => frames.set(c, i * 12)); tap.bassFrames.forEach((c, i) => bass.set(c, i * 12));
  bs.sort((a, b) => a - b);
  return { frames, bass, n, bright: bs.length ? bs[bs.length >> 1] : 0.5 };
}

// ---- chords: 24 triads (major and minor on every root), the root weighted a little more
/** Chord names by index: 0 C, 1 Cm, 2 C#, 3 C#m, ... 23 Bm. */
export const CHORDS = NAMES.flatMap(n => [n, n + "m"]);
const TEMPL = CHORDS.map((_, i) => { const r = i >> 1, minor = i & 1, v = new Float64Array(12); v[r] = 1.2; v[(r + (minor ? 3 : 4)) % 12] = 1; v[(r + 7) % 12] = 1; return v; });
const TEMPL_C = TEMPL.map(v => { const m = v.reduce((a, b) => a + b) / 12, c = v.map(x => x - m); return { c, n: Math.sqrt(c.reduce((a, b) => a + b * b, 0)) }; });
/**
 * The chord that best fits a chroma (12 values, any scale), with the bass chroma (if given) helping pick the root.
 * @returns {{chord:string, index:number, root:number, minor:boolean, r:number}|null} null when there are no notes
 */
export function chordOf(chroma, bass) {
  let m = 0, sum = 0; for (let k = 0; k < 12; k++) { m += chroma[k]; sum += chroma[k]; } if (!(sum > 0)) return null; m /= 12;
  let xx = 0; for (let k = 0; k < 12; k++) xx += (chroma[k] - m) ** 2; if (!(xx > 0)) return null;
  let bs = 0; if (bass) for (let k = 0; k < 12; k++) bs += bass[k];
  let best = -1, br = -9;
  for (let i = 0; i < 24; i++) { const T = TEMPL_C[i]; let xy = 0; for (let k = 0; k < 12; k++) xy += (chroma[k] - m) * T.c[k];
    const r = xy / Math.sqrt(xx) / T.n + (bs > 0 ? 0.15 * bass[i >> 1] / bs : 0); if (r > br) { br = r; best = i; } }
  return { chord: CHORDS[best], index: best, root: best >> 1, minor: !!(best & 1), r: Math.round(br * 100) / 100 };
}
/**
 * Chords per bar from chroma frames at `rate` a second (the stored 5-a-second chroma, or the 10-a-second one), and
 * optionally the bass chroma: the frames inside each bar (a frame in from either end, where the chord before or after
 * may still ring) are added up and matched against the 24 triads. Bars with no notes get null.
 * @param {Float32Array} frames flat, 12 a frame @param {number} rate frames a second @param {{t0:number,t1:number}[]} bars
 * @param {Float32Array} [bass] flat bass chroma at the same rate
 * @returns {(number|null)[]} chord indices (see CHORDS)
 */
export function barChords(frames, rate, bars, bass) {
  const n = Math.floor(frames.length / 12), c = new Float64Array(12), b = new Float64Array(12);
  return bars.map(bar => { const a = Math.max(0, Math.floor(bar.t0 * rate) + 1), z = Math.min(n, Math.ceil(bar.t1 * rate) - 1); if (z - a < 1) return null;
    c.fill(0); b.fill(0); for (let j = a; j < z; j++) for (let k = 0; k < 12; k++) { c[k] += frames[j * 12 + k]; if (bass) b[k] += bass[j * 12 + k]; }
    const ch = chordOf(c, bass ? b : null); return ch && ch.r > 0.35 ? ch.index : null; });
}

// ---- compact storage: pairs of frames (5 a second), 12 values of 4 bits (sqrt-coded) = 6 bytes a frame
const b64 = u8 => { if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64"); let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
const unb64 = s => typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), c => c.charCodeAt(0));
/** 10-a-second frames (flat) → a base64 string of 5-a-second frames. */
export function packChroma(frames10) {
  const n = Math.floor(frames10.length / 24), u = new Uint8Array(n * 6), v = new Float32Array(12);
  for (let j = 0; j < n; j++) { let mx = 0;
    for (let k = 0; k < 12; k++) { v[k] = (frames10[(2 * j) * 12 + k] + frames10[(2 * j + 1) * 12 + k]) / 2; if (v[k] > mx) mx = v[k]; }
    for (let k = 0; k < 12; k += 2) { const q = x => mx > 0 ? Math.round(Math.sqrt(x / mx) * 15) : 0; u[j * 6 + k / 2] = q(v[k]) << 4 | q(v[k + 1]); } }
  return b64(u);
}
/** Back to 5-a-second frames, flat Float32Array(n * 12). */
export function unpackChroma(s) {
  const u = typeof s === "string" ? unb64(s) : s, n = Math.floor(u.length / 6), out = new Float32Array(n * 12);
  for (let j = 0; j < n; j++) for (let k = 0; k < 12; k += 2) { const b = u[j * 6 + k / 2]; out[j * 12 + k] = ((b >> 4) / 15) ** 2; out[j * 12 + k + 1] = ((b & 15) / 15) ** 2; }
  return out;
}

// ---- key
function pearson(a, b, rot) { let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[(i + rot) % 12]; mb += b[i]; } ma /= 12; mb /= 12;
  let xy = 0, xx = 0, yy = 0; for (let i = 0; i < 12; i++) { const x = a[(i + rot) % 12] - ma, y = b[i] - mb; xy += x * y; xx += x * x; yy += y * y; }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0; }
/**
 * Key from an average chroma (12 values, C first). A key and its relative (C major, A minor) use the same notes, so
 * the profiles alone often can't tell them apart; `hint` adds what can: how much each note is the tonic, from the bass
 * and the chords that start phrases (see tonicHint()). Each key's profile fit gets 0.4 x its hint added.
 * @param {ArrayLike<number>} chroma
 * @param {{major:ArrayLike<number>, minor:ArrayLike<number>}|null} [hint] per tonic (C first), 0..1
 * @returns {{key:string, tonic:number, mode:"major"|"minor", confidence:number, majorness:number}|null}
 */
export function keyOf(chroma, hint = null) {
  let sum = 0; for (let i = 0; i < 12; i++) sum += chroma[i]; if (!(sum > 0)) return null;
  const h = (mode, t) => hint ? 0.4 * (hint[mode][t] || 0) : 0;
  const sc = []; for (let t = 0; t < 12; t++) { sc.push({ tonic: t, mode: "major", r: pearson(chroma, MAJ, t) + h("major", t) }); sc.push({ tonic: t, mode: "minor", r: pearson(chroma, MIN, t) + h("minor", t) }); }
  sc.sort((a, b) => b.r - a.r); const best = sc[0], r2 = sc[1].r;
  const bestMaj = sc.find(s => s.mode === "major").r, bestMin = sc.find(s => s.mode === "minor").r;
  return { key: NAMES[best.tonic], tonic: best.tonic, mode: best.mode, confidence: Math.round(clamp((best.r - r2) * 4 + Math.max(0, best.r - 0.45)) * 100) / 100,
    majorness: clamp((bestMaj - bestMin) / 0.2, -1, 1), r: best.r };
}

/**
 * Which note is home: 30% from the bass (its share of the song's bass notes), 70% from the chords that start
 * phrases and sections (and the song's first and last chord): a tonic chord of the right kind counts 1, of the other
 * kind (a major chord on the tonic of a minor key) 0.5.
 * @param {{bass?:ArrayLike<number>|null, starts?:(number|null)[]}} o bass: average bass chroma; starts: chord indices (CHORDS)
 * @returns {{major:Float64Array, minor:Float64Array}|null}
 */
export function tonicHint({ bass = null, starts = [] } = {}) {
  const major = new Float64Array(12), minor = new Float64Array(12); let bs = 0, any = false;
  if (bass) for (let k = 0; k < 12; k++) bs += bass[k];
  const st = starts.filter(c => c != null), wB = bs > 0 ? (st.length ? 0.3 : 1) : 0, wS = st.length ? 1 - wB : 0;
  for (let t = 0; t < 12; t++) { const b = bs > 0 ? bass[t] / bs : 0; major[t] = minor[t] = wB * b; }
  for (const c of st) { const r = c >> 1, isMin = c & 1; major[r] += wS * (isMin ? 0.5 : 1) / st.length; minor[r] += wS * (isMin ? 1 : 0.5) / st.length; any = true; }
  return wB || any ? { major, minor } : null;
}

// ---- mood
/**
 * Valence (sad 0 .. happy 1) and energy (calm 0 .. energetic 1). Drums count most for energy (steady hi-hats or kicks
 * on most beats); a drumless song's tempo and onsets are unreliable (piano attacks pass for snares, the tempo for
 * twice what it feels like), so they only count as much as there are drums.
 * @param {{majorness?:number, confidence?:number, bright?:number, onsetRate?:number, bpm?:number, hatRate?:number, kickFrac?:number}} f
 */
export function moodOf(f) {
  const perc = Math.max(clamp(((f.hatRate || 0) - 1.8) / 1.2), clamp(((f.kickFrac || 0) - 0.45) / 0.35));
  const tempoN = 0.2 + (clamp(((f.bpm || 90) - 60) / 80) - 0.2) * perc, bright = f.bright ?? 0.5;
  const onsetN = clamp((f.onsetRate || 0) / 5) * (0.5 + 0.5 * perc), m = (f.majorness || 0) * (0.4 + 0.6 * (f.confidence ?? 0.5));
  const energy = clamp(0.4 * perc + 0.25 * tempoN + 0.2 * bright + 0.15 * onsetN);
  const valence = clamp(0.5 + 0.32 * m + 0.15 * (bright - 0.5) + 0.1 * (tempoN - 0.4));
  return { valence: Math.round(valence * 100) / 100, energy: Math.round(energy * 100) / 100 };
}
/** A word for a mood. */
export function moodName(m) {
  if (!m) return null; const { valence: v, energy: e } = m;
  if (v >= 0.5) return e >= 0.5 ? (e > 0.78 && v > 0.62 ? "euphoric" : "happy") : "peaceful";
  return e >= 0.5 ? (e > 0.78 ? "intense" : "tense") : (v < 0.4 ? "melancholic" : "wistful");
}
/** "A minor · melancholic", from any of key/mode/mood (missing parts are left out). */
export function hearsLabel(key, mode, mood) { return [key ? `${key} ${mode || ""}`.trim() : null, moodName(mood)].filter(Boolean).join(" · ") || null; }

// mood colours, two variants per corner: [valence][energy]
const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const CORNERS = {
  happy: [["#ff8a1f", "#ff2f92"], ["#ffc21f", "#ff5e3a"]],  // energetic and major: warm oranges, pinks, yellows
  calmUp: [["#19d3b0", "#6fe08a"], ["#2ec4d6", "#a8f07a"]], // calm and major: soft teal and green
  sad: [["#2438ff", "#7b2fff"], ["#1f6bff", "#4b1fd1"]],    // calm and minor: deep blues and violets
  tense: [["#ff1f2f", "#e81fff"], ["#ff2a6a", "#a51fff"]],  // energetic and minor: reds and magentas
};
const sm = x => { x = clamp((x - 0.3) / 0.4); return x * x * (3 - 2 * x); };
/** Two colours (0..1 RGB) for a mood; `variant` picks between two sets so effect changes still bring new colours. */
export function moodPalette(valence, energy, variant = 0) {
  const v = sm(valence), e = sm(energy), k = ((variant % 2) + 2) % 2;
  const w = [[CORNERS.happy, v * e], [CORNERS.calmUp, v * (1 - e)], [CORNERS.sad, (1 - v) * (1 - e)], [CORNERS.tense, (1 - v) * e]];
  return [0, 1].map(ci => { const out = [0, 0, 0]; let peak = 0;
    for (const [c, wt] of w) { const rgb = hex(c[k][ci]); for (let i = 0; i < 3; i++) out[i] += rgb[i] * wt; peak += Math.max(...rgb) * wt; }
    const m = Math.max(...out) || 1; return out.map(x => x * peak / m); }); // keep it as bright as its corners (blends in RGB go dull)
}
