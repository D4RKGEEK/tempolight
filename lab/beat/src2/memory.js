// Song memory: songs Tempolight has analysed before (played through the app) are remembered, and recognised when
// they play again from anywhere else (Spotify, a DJ, the radio) while it listens live. Once a song is recognised,
// the lights follow its stored beat map, so build-ups and drops are known ahead of time, as if it were played here.
//
// Recognition compares the loudness shape of the last 12 seconds with each remembered song (10 values a second, as
// changes in log loudness so the volume doesn't matter), then lines up the kicks heard with the stored kicks to get
// the position to within a few milliseconds.
//
// Songs without drums (ballads, piano pieces) have a weak loudness shape and a tempo that can't be trusted (the
// stored analysis may say 140 BPM where live listening hears 70), so entries also keep a chroma fingerprint: which of
// the 12 notes sound, 5 times a second, in 6 bytes a frame (tonal.js). Matching then combines the two: a loudness
// match must also agree in chroma (or it is turned down), and when loudness can't decide, a chroma match that stands
// clearly above every other place in the song (and isn't contradicted by the loudness) counts. To stay cheap on a
// Raspberry Pi, the chroma search first compares the average chroma of the last 12 s with every 12 s stretch of the
// song (from running sums, 12 numbers per position) and only correlates frame by frame near the few best stretches.
// Old entries without chroma are matched on loudness alone, as before.
import { lastLE } from "./analysis.js";
import { unpackChroma } from "./tonal.js";

const RATE = 10, WIN = 120; // fingerprint: 10 values a second; a match looks at the last 12 seconds

const logq = v => Math.max(0, Math.min(255, Math.round((Math.log10(v + 1e-4) + 4) / 4 * 255)));
/** Loudness envelope (any rate) to fingerprint bytes at 10 a second. */
export function fingerprint(env, step = 0.02) { const k = Math.max(1, Math.round(1 / RATE / step)), out = new Uint8Array(Math.floor(env.length / k));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += env[i * k + j]; out[i] = logq(s / k / 4); } return out; } // (/ 4: loud parts go above 1, and mustn't clip)
// high-pass: the change from the average of the last second, so only the shape counts
function shape(q, a = 0, b = q.length) { const out = new Float32Array(b - a); let m = q[a] || 0;
  for (let i = a; i < b; i++) { m += (q[i] - m) * 0.2; out[i - a] = Math.max(-25, Math.min(25, q[i] - m)); } return out; } // clipped: one big jump (a song's end) can't decide the match alone

// the last 12 s heard, shaped; null when there is too little to go on
function liveShape(live) { if (live.length < WIN) return null; const x = shape(live, live.length - WIN); let xx = 0; for (const v of x) xx += v * v;
  if (Math.sqrt(xx) < 30) return null; x.norm = Math.sqrt(xx); return x; }
// a remembered song's shaped fingerprint, worked out once per entry; kept off the entry so it never ends up in the saved file
const shapes = new WeakMap();
function songShape(e) { let y = shapes.get(e); if (y === undefined) { const fp = typeof e.fp === "string" ? unb64(e.fp) : e.fp; y = fp && fp.length ? shape(fp) : null; shapes.set(e, y); } return y; }
function corr(x, y, s) { let xy = 0, yy = 0; for (let i = 0; i < WIN; i++) { const v = y[s + i]; xy += x[i] * v; yy += v * v; } return yy > 0 ? xy / (x.norm * Math.sqrt(yy)) : 0; }

const r3 = v => Math.round(v * 1000) / 1000;
const b64 = u8 => typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8));
const unb64 = s => typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** A compact copy of a song analysis to remember (about 10-20 kB). */
export function memoryEntry(name, pre, id) {
  const env10 = new Float32Array(Math.floor(pre.env.length / 5)); for (let i = 0; i < env10.length; i++) { let s = 0; for (let j = 0; j < 5; j++) s += pre.env[i * 5 + j]; env10[i] = s / 5; }
  return { id, name: String(name).slice(0, 120), bpm: r3(pre.bpm), P: pre.P, off: pre.off, barOff: pre.barOff, style: pre.style, dur: r3(pre.dur), drops: pre.drops.map(r3),
    kicks: pre.kicks.map(r3), snares: pre.snares.map(r3), hats: pre.hats.filter((_, i) => i % 2 === 0).map(r3), bars: pre.bars.map(b => ({ t0: r3(b.t0), t1: r3(b.t1), state: b.state, level: Math.round(b.level * 100) / 100 })),
    env: b64(Uint8Array.from(env10, v => Math.min(255, Math.round(Math.sqrt(Math.min(1, v / 1.5)) * 255)))), fp: b64(fingerprint(pre.env)),
    ...(typeof pre.chroma === "string" && pre.chroma.length ? { ch: pre.chroma } : {}),
    ...(pre.key ? { key: pre.key, mode: pre.mode, keyConfidence: pre.keyConfidence ?? 0 } : {}), ...(pre.mood ? { mood: { valence: pre.mood.valence, energy: pre.mood.energy } } : {}), at: Date.now() };
}
/** Back to an analysis that songView() can use. */
export function memoryAnalysis(e) {
  const env10 = unb64(e.env), env = new Float32Array(env10.length * 5);
  for (let i = 0; i < env.length; i++) { const v = env10[Math.floor(i / 5)] / 255; env[i] = v * v * 1.5; }
  return { bpm: e.bpm, P: e.P, off: e.off, barOff: e.barOff, style: e.style, dur: e.dur, drops: e.drops, kicks: e.kicks, snares: e.snares, hats: e.hats, bars: e.bars, env,
    key: e.key || null, mode: e.mode || null, keyConfidence: e.keyConfidence ?? 0, mood: e.mood || null };
}
/** A remembered song without steady drums: its stored tempo can't be trusted. */
export function drumlessEntry(e) { return e.style === "emotional" || e.style === "chill" || !(e.kicks && e.kicks.length >= (e.dur || 0) * 0.3); }

// ---- chroma matching
const CW = WIN / 2; // chroma frames (5 a second) in a match: the same 12 s
// a remembered song's chroma: per-frame centred values, and running sums for the quick averages and the norms
const chromas = new WeakMap();
function songCh(e) {
  let c = chromas.get(e); if (c !== undefined) return c; c = null;
  if (typeof e.ch === "string" && e.ch.length) { const raw = unpackChroma(e.ch), n = raw.length / 12;
    if (n >= CW) { const Y = new Float32Array(raw.length), PS = new Float64Array((n + 1) * 12), N2 = new Float64Array(n + 1);
      for (let j = 0; j < n; j++) { let m = 0; for (let k = 0; k < 12; k++) m += raw[j * 12 + k]; m /= 12; let q = 0;
        for (let k = 0; k < 12; k++) { const v = raw[j * 12 + k]; PS[(j + 1) * 12 + k] = PS[j * 12 + k] + v; Y[j * 12 + k] = v - m; q += (v - m) ** 2; } N2[j + 1] = N2[j] + q; }
      c = { Y, PS, N2, n }; } }
  chromas.set(e, c); return c;
}
// what was heard (2 CW + 1 frames at 10 a second), paired into 5-a-second frames two ways: ending on the newest frame
// (lines up with a song window starting on an even 100 ms step) and one earlier (odd), each per-frame centred, and the
// centred average for the quick pass
function pairUp(w, first) { const X = new Float32Array(CW * 12), v = new Float32Array(12); let q = 0;
  for (let p = 0; p < CW; p++) { const a = (first + 2 * p) * 12; let mx = 0; for (let k = 0; k < 12; k++) { v[k] = (w[a + k] + w[a + 12 + k]) / 2; if (v[k] > mx) mx = v[k]; }
    if (!(mx > 0)) continue; let m = 0; for (let k = 0; k < 12; k++) { v[k] /= mx; m += v[k]; } m /= 12;
    for (let k = 0; k < 12; k++) { const d = v[k] - m; X[p * 12 + k] = d; q += d * d; } }
  return { X, norm: Math.sqrt(q) }; }
function liveCh(w) {
  if (!w || w.length < (2 * CW + 1) * 12) return null; const o = w.length / 12 - (2 * CW + 1);
  const even = pairUp(w, o + 1), odd = pairUp(w, o); if (!(even.norm > 0) || !(odd.norm > 0)) return null;
  const mean = new Float64Array(12); for (let i = 0; i < CW * 12; i++) mean[i % 12] += even.X[i]; let mq = 0; for (let k = 0; k < 12; k++) mq += mean[k] ** 2;
  return mq > 0 ? { even, odd, mean, mnorm: Math.sqrt(mq) } : null;
}
// the 12 s average of the song from frame j against the live average (cosine of the centred averages)
const W12 = new Float64Array(12);
function coarseAt(L, S, j) { const a = j * 12, b = (j + CW) * 12, w = W12; let m = 0;
  for (let k = 0; k < 12; k++) { w[k] = S.PS[b + k] - S.PS[a + k]; m += w[k]; } m /= 12; let xy = 0, yy = 0;
  for (let k = 0; k < 12; k++) { const v = w[k] - m; xy += v * L.mean[k]; yy += v * v; } return yy > 0 ? xy / (L.mnorm * Math.sqrt(yy)) : 0; }
// frame by frame, for the song window starting at s (10 a second, as for the loudness)
function fineAt(L, S, s) { const H = s % 2 ? L.odd : L.even, j = s >> 1; if (j < 0 || j + CW > S.n) return 0; const X = H.X, Y = S.Y, o = j * 12; let xy = 0;
  for (let i = 0; i < CW * 12; i++) xy += X[i] * Y[o + i]; const yy = S.N2[j + CW] - S.N2[j]; return yy > 0 ? xy / (H.norm * Math.sqrt(yy)) : 0; }
/** How well the chroma heard (LiveAnalyser.ctap.window()) matches song `e` with its 12 s window ending at `pos`; null if either has none. */
export function chromaMatch(chroma, e, pos) { const L = liveCh(chroma), S = songCh(e); if (!L || !S) return null; return fineAt(L, S, Math.round(pos * RATE) - WIN); }

// chroma-led search over one song: the best place, if it stands out, as a loudness-window start (10 a second)
// every other frame is enough here (12 s averages change slowly); the frame-by-frame pass looks around the best ones
function coarse(L, S) { const nJ = Math.max(0, S.n - CW + 1), co = new Float32Array(nJ).fill(-1); let top = -1; for (let j = 0; j < nJ; j += 2) { co[j] = coarseAt(L, S, j); if (co[j] > top) top = co[j]; } return { co, top }; }
function chromaSearch(L, S, x, y, { co, top }) {
  const nJ = co.length; if (nJ < 1 || top < 0.75) return null; // the notes don't fit anywhere in this song
  // up to 6 places whose average fits best, at least a second apart (a chorus that comes back is another place)
  const picks = [], floor = Math.max(0.7, top - 0.2);
  for (let k = 0; k < 6; k++) { let bj = -1; for (let j = 0; j < nJ; j += 2) if (co[j] > floor && (bj < 0 || co[j] > co[bj]) && picks.every(p => Math.abs(p - j) > 5)) bj = j; if (bj < 0) break; picks.push(bj); }
  const fine = new Map(), sMax = 2 * (S.n - CW) + 1;
  for (const p of picks) for (let s = Math.max(0, 2 * p - 10); s <= Math.min(sMax, 2 * p + 10); s += 2) if (!fine.has(s)) fine.set(s, fineAt(L, S, s)); // every 200 ms...
  let sb = -1, cb = -1; for (const [s, v] of fine) if (v > cb) { cb = v; sb = s; }
  for (const s of [sb - 1, sb + 1]) if (s >= 0 && s <= sMax) { const v = fineAt(L, S, s); fine.set(s, v); if (v > cb) { cb = v; sb = s; } } // ...then the 100 ms either side of the best
  let second = 0; for (const [s, v] of fine) if (Math.abs(s - sb) > 10 && v > second) second = v; // another place, more than a second away
  if (cb < CH_MIN || cb - second < 0.05) return null;
  // the loudness picks the exact 100 ms, and must not say no
  let best = null; for (let s = Math.max(0, sb - 2); s <= Math.min(sMax, sb + 2); s++) { const l = x && y && s + WIN <= y.length ? corr(x, y, s) : 0, c = fine.get(s) ?? fineAt(L, S, s);
    const v = 0.65 * c + 0.35 * l; if (!best || v > best.v) best = { s, v, l, c }; }
  if (x && best.l < 0.1) return null;
  return { s: best.s, score: best.v, chroma: best.c, margin: cb - second };
}
const CH_MIN = 0.85; // a chroma-led match: the notes of the last 12 s must match this well (same recording: 0.9-1)

/**
 * Which remembered song is this, and where in it are we?
 * @param {ArrayLike<number>} live fingerprint bytes of what was heard, oldest first (at least 12 s)
 * @param {{id:string, fp:string|Uint8Array, bpm:number, ch?:string}[]} entries
 * @param {{bpm?:number, chroma?:Float32Array|null, drumless?:boolean, min?:number}} [o] the live tempo, if known, to skip
 *   songs that can't be it (not when either side has no steady drums); chroma: LiveAnalyser.ctap.window() (see
 *   LiveAnalyser.memoryQuery()), to match on harmony too
 * @returns {{id:string, pos:number, score:number, margin:number, chroma?:number}|null} pos: seconds into the song at the end of `live`
 */
export function recognise(live, entries, o = {}) {
  const x = liveShape(live), L = liveCh(o.chroma); if (!x && !L) return null; // too short, or too flat to tell (silence, a drone)
  let best = null;
  for (const e of entries) {
    const drumless = o.drumless || drumlessEntry(e);
    if (o.bpm && e.bpm && !drumless) { const r = o.bpm / e.bpm; if (![0.5, 1, 2].some(k => Math.abs(r / k - 1) < 0.06)) continue; }
    const y = songShape(e), S = L ? songCh(e) : null; let found = null;
    // the quick pass on the notes first: a song whose harmony fits nowhere is skipped (different key, other chords)
    const C = S ? coarse(L, S) : null; if (C && C.top < 0.65) continue;
    if (x && y && y.length >= WIN) {
      const n = y.length - WIN + 1, sc = new Float32Array(n);
      for (let s = 0; s < n; s++) sc[s] = corr(x, y, s);
      let bi = 0; for (let s = 1; s < n; s++) if (sc[s] > sc[bi]) bi = s;
      // the runner-up anywhere else, from 0.4 s away: a beat or a bar off counts, because in a steady, repetitive part
      // those are exactly the positions that look alike, and following the right song a beat late is still wrong
      let second = 0; for (let s = 0; s < n; s++) if (Math.abs(s - bi) > 3 && sc[s] > second) second = sc[s];
      const score = sc[bi], margin = score - second;
      if (score > (o.min ?? 0.6) && margin > 0.08) {
        const c = S ? fineAt(L, S, bi) : null; // the notes must agree too (when both sides have them)
        if (c == null || c > 0.6) found = { id: e.id, pos: (bi + WIN) / RATE, score, margin, ...(c != null ? { chroma: c } : {}) };
      }
    }
    if (!found && S) { const c = chromaSearch(L, S, x, y, C); if (c) found = { id: e.id, pos: (c.s + WIN) / RATE, score: c.score, margin: c.margin, chroma: c.chroma }; }
    if (found && (!best || found.score > best.score)) best = found;
  }
  return best;
}

/**
 * Is this still the same song, near where we think it is? For following a song once recognised: only positions
 * within `range` seconds of `pos` are tried, so a repetitive song (a chorus that comes back) can't throw it off.
 * @param {{chroma?:Float32Array|null}} [o] the live chroma window, to weigh the notes in too
 * @returns {{pos:number, score:number}|null} null when the live sound is too flat to tell (a quiet part, silence)
 */
export function matchAt(live, e, pos, range = 0.8, o = {}) {
  const x = liveShape(live), y = songShape(e); if (!x || !y) return null;
  // with chroma on both sides, the notes must match too: a song with the same tempo and bars (the same loudness shape)
  // but other chords is turned down, and a quiet ballad with a weak loudness shape is held by its notes
  const L = liveCh(o.chroma), S = L ? songCh(e) : null;
  const c = Math.round(pos * RATE) - WIN, r = Math.round(range * RATE); let best = null;
  for (let s = Math.max(0, c - r); s <= Math.min(y.length - WIN, c + r); s++) { const l = corr(x, y, s), ch = S ? fineAt(L, S, s) : 0, v = S ? Math.min(ch, (l + ch) / 2) : l; if (!best || v > best.score) best = { pos: (s + WIN) / RATE, score: v }; }
  return best || { pos, score: 0 }; // past the end of the song (or before its start): nothing matches
}

/**
 * Fine-tune a position with the kicks: shift until the kicks heard (live times) land on the song's stored kicks.
 * @param {number[]} liveKicks recent kick times on the live clock @param {number} liveT the live clock now
 * @param {number} pos the song position now (rough) @param {number[]} songKicks
 * @param {number} [range] how far to search, seconds @param {number} [rate] song seconds per live second (a song played faster)
 * @returns {{pos:number, hits:number}}
 */
export function refineByKicks(liveKicks, liveT, pos, songKicks, range = 0.2, rate = 1) {
  const recent = liveKicks.filter(k => liveT - k < 10 && liveT - k > 0.05); if (recent.length < 4 || !songKicks.length) return { pos, hits: 0 };
  let best = { pos, hits: -1, err: 9 };
  for (let d = -range; d <= range + 1e-9; d += 0.005) {
    let hits = 0, err = 0;
    for (const k of recent) { const st = pos + d - (liveT - k) * rate, i = lastLE(songKicks, st); const near = Math.min(i >= 0 ? st - songKicks[i] : 9, i + 1 < songKicks.length ? songKicks[i + 1] - st : 9);
      if (near < 0.03) { hits++; err += near; } }
    if (hits > best.hits || (hits === best.hits && err < best.err)) best = { pos: pos + d, hits, err };
  }
  return best.hits >= Math.max(3, recent.length * 0.5) ? { pos: best.pos, hits: best.hits } : { pos, hits: 0 };
}

/** Collects the live fingerprint from an analyser's loudness, 10 values a second. */
export class FingerprintTap {
  constructor(seconds = 20) { this.max = seconds * RATE; this.q = []; this.acc = 0; this.n = 0; this.nextT = null; }
  /** call once per analyser hop with its time and RMS (0..1, as is: RMS is at most 1, so loud input never clips at 255 and
   * loses its shape; it needn't match the whole-song analysis's scale, only the shape counts) */
  push(t, rms) { if (this.nextT == null) this.nextT = t + 1 / RATE; this.acc += rms; this.n++;
    if (t >= this.nextT) { this.q.push(logq(this.acc / this.n)); if (this.q.length > this.max) this.q.shift(); this.acc = 0; this.n = 0; this.nextT += 1 / RATE; if (t - this.nextT > 1) this.nextT = t + 1 / RATE; } }
  reset() { this.q = []; this.acc = 0; this.n = 0; this.nextT = null; }
}
