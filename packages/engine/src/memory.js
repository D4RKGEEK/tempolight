// Song memory: songs Tempolight has analysed before (played through the app) are remembered, and recognised when
// they play again from anywhere else (Spotify, a DJ, the radio) while it listens live. Once a song is recognised,
// the lights follow its stored beat map, so build-ups and drops are known ahead of time, as if it were played here.
//
// Recognition compares the loudness shape of the last 6-12 seconds with each remembered song (10 values a second, as
// changes in log loudness so the volume doesn't matter), then lines up the kicks heard with the stored kicks to get
// the position to within a few milliseconds. It starts after 6 s of listening, with stricter limits while the window
// is short, and looks at the whole last 12 s once they have been heard.
//
// Songs without drums (ballads, piano pieces) have a weak loudness shape and a tempo that can't be trusted (the
// stored analysis may say 140 BPM where live listening hears 70), so entries also keep a chroma fingerprint: which of
// the 12 notes sound, 5 times a second, in 6 bytes a frame (tonal.js). Matching then combines the two: a loudness
// match must also agree in chroma (or it is turned down), and when loudness can't decide, a chroma match that stands
// clearly above every other place in the song (and isn't contradicted by the loudness) counts.
//
// A DJ may play a song a few percent faster or slower, so the window heard is also tried stretched to 0.94-1.06 x
// (in steps of 2%), with its notes moved up or down to match (a song sped up without key lock sounds higher; with key
// lock it doesn't, so both are tried). The live tempo is a hint for ranking, not a filter: a song whose stored tempo
// fits what is heard (1:1, 2:1, 1:2, 3:2 or 2:3) needs a little less to be accepted than one whose tempo doesn't.
//
// To stay cheap on a Raspberry Pi, every search runs coarse first: loudness at 5 values a second with running sums for
// the norms, the chroma as 6-12 s averages from running sums (12 numbers per position); only the few best places are
// then correlated at full resolution. Old entries without chroma are matched on loudness alone, as before.
import { lastLE } from "./analysis.js";
import { unpackChroma, barChords, CHORDS } from "./tonal.js";

const RATE = 10, WIN = 120, WMIN = 60; // fingerprint: 10 values a second; a match looks at the last 12 s (6 s at least)
const RATES = [1, 0.98, 1.02, 0.96, 1.04, 0.94, 1.06]; // speeds tried: song seconds per live second

const logq = v => Math.max(0, Math.min(255, Math.round((Math.log10(v + 1e-4) + 4) / 4 * 255)));
/** Loudness envelope (any rate) to fingerprint bytes at 10 a second. */
export function fingerprint(env, step = 0.02) { const k = Math.max(1, Math.round(1 / RATE / step)), out = new Uint8Array(Math.floor(env.length / k));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += env[i * k + j]; out[i] = logq(s / k / 4); } return out; } // (/ 4: loud parts go above 1, and mustn't clip)
// high-pass: the change from the average of the last second, so only the shape counts
function shape(q, a = 0, b = q.length) { const out = new Float32Array(b - a); let m = q[a] || 0;
  for (let i = a; i < b; i++) { m += (q[i] - m) * 0.2; out[i - a] = Math.max(-25, Math.min(25, q[i] - m)); } return out; } // clipped: one big jump (a song's end) can't decide the match alone

const r3 = v => Math.round(v * 1000) / 1000, r2 = v => Math.round(v * 100) / 100;
const b64 = u8 => { if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64"); let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
const unb64 = s => typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), c => c.charCodeAt(0));
const byte = v => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * A compact copy of a song analysis to remember (about 10-30 kB). Besides the beat map it keeps, when the analysis
 * has them: `bx` (per bar: energy, danceability, chord, singing; 4 bytes a bar, base64), `ks` (each kick's strength,
 * a byte each, base64), `sec` (sections as [first bar, end bar, label, part]) and `phrase` ({len, first}).
 */
export function memoryEntry(name, pre, id) {
  const env10 = new Float32Array(Math.floor(pre.env.length / 5)); for (let i = 0; i < env10.length; i++) { let s = 0; for (let j = 0; j < 5; j++) s += pre.env[i * 5 + j]; env10[i] = s / 5; }
  const bars = pre.bars || [], kicks = pre.kicks || [];
  // the newer per-bar, per-kick and section fields, only when they belong to these bars and kicks (a map merged from
  // stretches, or bars laid out again, has none or stale ones)
  const bx = bars.length && bars.every(b => typeof b.energy === "number" && typeof b.dance === "number") ? b64(Uint8Array.from(bars.flatMap(b => [byte(b.energy), byte(b.dance), b.chord == null ? 255 : b.chord, b.vocal ? 1 : 0]))) : null;
  const ks = Array.isArray(pre.kickStrength) && pre.kickStrength.length === kicks.length && kicks.length ? b64(Uint8Array.from(pre.kickStrength, byte)) : null;
  const secOk = Array.isArray(pre.sections) && pre.sections.length && pre.sections.every(s => bars[s.bar0] && bars[s.bar1 - 1] && Math.abs(bars[s.bar0].t0 - s.t0) < 0.01 && s.bar1 > s.bar0);
  return { id, name: String(name).slice(0, 120), bpm: r3(pre.bpm), P: pre.P, off: pre.off, barOff: pre.barOff, style: pre.style, dur: r3(pre.dur), drops: pre.drops.map(r3),
    kicks: kicks.map(r3), snares: pre.snares.map(r3), hats: pre.hats.filter((_, i) => i % 2 === 0).map(r3), bars: bars.map(b => ({ t0: r3(b.t0), t1: r3(b.t1), state: b.state, level: Math.round(b.level * 100) / 100 })),
    env: b64(Uint8Array.from(env10, v => Math.min(255, Math.round(Math.sqrt(Math.min(1, v / 1.5)) * 255)))), fp: b64(fingerprint(pre.env)),
    ...(typeof pre.chroma === "string" && pre.chroma.length ? { ch: pre.chroma } : {}),
    ...(bx ? { bx } : {}), ...(ks ? { ks } : {}), ...(secOk ? { sec: pre.sections.map(s => [s.bar0, s.bar1, s.label, s.state || null]) } : {}),
    ...(secOk && pre.phrase ? { phrase: { len: pre.phrase.len, first: pre.phrase.first } } : {}),
    ...(pre.key ? { key: pre.key, mode: pre.mode, keyConfidence: pre.keyConfidence ?? 0 } : {}), ...(pre.mood ? { mood: { valence: pre.mood.valence, energy: pre.mood.energy } } : {}), at: Date.now() };
}
/**
 * Back to an analysis that songView() can use. The newer fields (bars' energy, dance, chord, vocal; kickStrength;
 * sections; phrase) come back when the entry has them; an older entry with chroma still gets its chords (from the
 * stored chroma), and one without simply has none of them.
 */
export function memoryAnalysis(e) {
  const env10 = unb64(e.env), env = new Float32Array(env10.length * 5);
  for (let i = 0; i < env.length; i++) { const v = env10[Math.floor(i / 5)] / 255; env[i] = v * v * 1.5; }
  let bars = e.bars || [];
  const bx = typeof e.bx === "string" ? unb64(e.bx) : null;
  if (bx && bx.length === bars.length * 4) bars = bars.map((b, i) => ({ ...b, energy: r2(bx[i * 4] / 255), dance: r2(bx[i * 4 + 1] / 255), chord: bx[i * 4 + 2] < CHORDS.length ? bx[i * 4 + 2] : null, vocal: !!bx[i * 4 + 3] }));
  else if (typeof e.ch === "string" && e.ch.length && bars.length) { const ch = barChords(unpackChroma(e.ch), 5, bars); bars = bars.map((b, i) => ({ ...b, chord: ch[i] })); }
  const ks = typeof e.ks === "string" ? unb64(e.ks) : null;
  const out = { bpm: e.bpm, P: e.P, off: e.off, barOff: e.barOff, style: e.style, dur: e.dur, drops: e.drops, kicks: e.kicks, snares: e.snares, hats: e.hats, bars, env,
    key: e.key || null, mode: e.mode || null, keyConfidence: e.keyConfidence ?? 0, mood: e.mood || null };
  if (ks && e.kicks && ks.length === e.kicks.length) out.kickStrength = Array.from(ks, v => r2(v / 255));
  if (Array.isArray(e.sec) && e.sec.every(s => bars[s[0]] && bars[s[1] - 1])) out.sections = e.sec.map(([bar0, bar1, label, state]) => ({ t0: bars[bar0].t0, t1: bars[bar1 - 1].t1, bar0, bar1, label, state: state || null }));
  if (out.sections && e.phrase) out.phrase = { len: e.phrase.len, first: e.phrase.first };
  return out;
}
/** A remembered song without steady drums: its stored tempo can't be trusted. */
export function drumlessEntry(e) { return e.style === "emotional" || e.style === "chill" || !(e.kicks && e.kicks.length >= (e.dur || 0) * 0.3); }

// ---- what was heard, prepared once per query (the same arrays for every song): per speed, the loudness shape over
// the window (stretched to song time), and per speed and note shift, the chroma
// (the runtime asks about one song at a time with the same arrays; a caller may also keep pushing into the same array,
// so the cache is checked against the array's length and newest values)
const queries = new WeakMap();
function query(live, chroma) {
  const key = live && typeof live === "object" ? live : null, L = live ? live.length : 0;
  let sig = L; for (let i = Math.max(0, L - 24); i < L; i++) sig = (sig * 31 + live[i]) % 1e9;
  const c = key ? queries.get(key) : null;
  if (c && c.sig === sig && c.chroma === chroma) return c.Q;
  const Q = { live, chroma, v: new Map() }; if (key) queries.set(key, { sig, chroma, Q });
  return Q;
}
// loudness heard at `rate`, as a song-time window of M values ending now (null: too short or too flat)
function liveLoud(Q, rate) {
  const k = "l" + rate; if (Q.v.has(k)) return Q.v.get(k);
  const q = Q.live, L = q ? q.length : 0, M = Math.min(WIN, Math.floor((L - 1) * rate)); let x = null;
  if (M >= WMIN) {
    const raw = new Float32Array(M); for (let i = 0; i < M; i++) { const p = (L - 1) - (M - 1 - i) / rate, a = Math.floor(p), f = p - a; raw[i] = a + 1 < L ? q[a] * (1 - f) + q[a + 1] * f : q[a]; }
    x = shape(raw); let xx = 0; for (const v of x) xx += v * v;
    if (Math.sqrt(xx) < 30 * Math.sqrt(M / WIN)) x = null;
    else { x.norm = Math.sqrt(xx); x.g = { 2: sums(x, 2), 4: sums(x, 4) }; }
  }
  Q.v.set(k, x); return x;
}
// the window as sums of g values (5 or 2.5 a second), lined up on its newest value
function sums(x, g) { const M = x.length, n = Math.floor(M / g), c = new Float32Array(n); let cc = 0; for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < g; k++) v += x[M - g * n + g * i + k]; c[i] = v; cc += v * v; } c.norm = Math.sqrt(cc); return c; }
// the chroma heard (10 a second) at `rate` with the notes moved by `shift` semitones, as 5-a-second song frames, two
// ways (a window ending on an even 100 ms step of the song, and on an odd one), each frame centred; and the centred average
function liveChroma(Q, rate, shift) {
  const k = "c" + rate + ":" + shift; if (Q.v.has(k)) return Q.v.get(k);
  const w = Q.chroma, Lf = w ? Math.floor(w.length / 12) : 0; let out = null;
  const M5 = Math.min(WIN / 2, Math.floor(((Lf - 1.5) * rate - 1.5) / 2) + 1);
  if (M5 >= WMIN / 2) {
    const i0 = Math.floor(shift), fs = shift - i0, v = new Float32Array(12), t = new Float32Array(12);
    const make = par => { const X = new Float32Array(M5 * 12); let q = 0;
      for (let i = 0; i < M5; i++) { const age = (2 * (M5 - 1 - i) + (par ? 1.5 : 0.5)) / rate - 0.5, p = Lf - 2 - age, a = Math.max(0, Math.floor(p)), f = Math.min(1, Math.max(0, p - a)), b = Math.min(Lf - 2, a + 1);
        let mx = 0; for (let c = 0; c < 12; c++) { const pa = (w[a * 12 + c] + w[(a + 1) * 12 + c]) / 2, pb = (w[b * 12 + c] + w[(b + 1) * 12 + c]) / 2; t[c] = pa * (1 - f) + pb * f; }
        for (let c = 0; c < 12; c++) { v[c] = t[(((c + i0) % 12) + 12) % 12] * (1 - fs) + t[(((c + i0 + 1) % 12) + 12) % 12] * fs; if (v[c] > mx) mx = v[c]; }
        if (!(mx > 0)) continue; let m = 0; for (let c = 0; c < 12; c++) { v[c] /= mx; m += v[c]; } m /= 12;
        for (let c = 0; c < 12; c++) { const d = v[c] - m; X[i * 12 + c] = d; q += d * d; } }
      return { X, norm: Math.sqrt(q) }; };
    const even = make(0), odd = make(1);
    if (even.norm > 0 && odd.norm > 0) { const mean = new Float64Array(12); for (let i = 0; i < M5 * 12; i++) mean[i % 12] += even.X[i]; let mq = 0; for (let c = 0; c < 12; c++) mq += mean[c] ** 2;
      if (mq > 0) out = { even, odd, mean, mnorm: Math.sqrt(mq), M5 }; }
  }
  Q.v.set(k, out); return out;
}
const shiftsFor = rate => { const s = 12 * Math.log2(rate); return Math.abs(s) < 0.2 ? [0] : [0, Math.round(s * 2) / 2]; }; // key lock, and without it

// ---- a remembered song, worked out once per entry; kept off the entry so it never ends up in the saved file
const songs = new WeakMap();
function song(e) {
  let S = songs.get(e); if (S) return S; S = { y: null, ch: null };
  const fp = typeof e.fp === "string" ? unb64(e.fp) : e.fp;
  if (fp && fp.length >= WMIN) { const y = shape(fp), n = y.length, Y2 = new Float64Array(n + 1), g = {};
    for (let i = 0; i < n; i++) Y2[i + 1] = Y2[i] + y[i] * y[i];
    for (const G of [2, 4]) { const yg = new Float32Array(n), Qg = new Float64Array(n + G); // sums of G values from each step, and running sums of their squares G apart
      for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < G && i + k < n; k++) v += y[i + k]; yg[i] = v; Qg[i + G] = Qg[i] + v * v; } g[G] = { yg, Qg }; }
    S.y = { y, n, Y2, g }; }
  if (typeof e.ch === "string" && e.ch.length) { const raw = unpackChroma(e.ch), n = raw.length / 12;
    if (n >= WMIN / 2) { const Y = new Float32Array(raw.length), PS = new Float64Array((n + 1) * 12), N2 = new Float64Array(n + 1);
      for (let j = 0; j < n; j++) { let m = 0; for (let k = 0; k < 12; k++) m += raw[j * 12 + k]; m /= 12; let q = 0;
        for (let k = 0; k < 12; k++) { const v = raw[j * 12 + k]; PS[(j + 1) * 12 + k] = PS[j * 12 + k] + v; Y[j * 12 + k] = v - m; q += (v - m) ** 2; } N2[j + 1] = N2[j] + q; }
      S.ch = { Y, PS, N2, n }; } }
  songs.set(e, S); return S;
}
// loudness correlation of window x (M values) with the song's, the window ending at song step `end` (10 a second)
function loudAt(x, Y, end) { const M = x.length, s = end - M; if (s < 0 || end > Y.n) return 0; const y = Y.y; let xy = 0; for (let i = 0; i < M; i++) xy += x[i] * y[s + i];
  const yy = Y.Y2[end] - Y.Y2[s]; return yy > 0 ? xy / (x.norm * Math.sqrt(yy)) : 0; }
// the same at 5 or 2.5 a second (G values added), for the quick passes
function loudCoarse(x, Y, end, G) { const c = x.g[G], n = c.length, s = end - G * n; if (s < 0 || end > Y.n) return 0; const { yg, Qg } = Y.g[G]; let xy = 0; for (let i = 0; i < n; i++) xy += c[i] * yg[s + G * i];
  const yy = Qg[s + G * n] - Qg[s]; return yy > 0 && c.norm > 0 ? xy / (c.norm * Math.sqrt(yy)) : 0; }
// chroma, frame by frame, the window ending at song step `end` (10 a second)
function chromaAt(L, C, end) { const s = end - 2 * L.M5, H = s % 2 ? L.odd : L.even, j = s >> 1; if (s < 0 || j + L.M5 > C.n) return 0; const X = H.X, Y = C.Y, o = j * 12, n = L.M5 * 12; let xy = 0;
  for (let i = 0; i < n; i++) xy += X[i] * Y[o + i]; const yy = C.N2[j + L.M5] - C.N2[j]; return yy > 0 ? xy / (H.norm * Math.sqrt(yy)) : 0; }
// the average chroma of the window against the song's average over the frames ending at 5-a-second frame jEnd
const W12 = new Float64Array(12);
function chromaCoarse(L, C, jEnd) { const a = (jEnd - L.M5) * 12, b = jEnd * 12, w = W12; if (a < 0 || jEnd > C.n) return -1; let m = 0;
  for (let k = 0; k < 12; k++) { w[k] = C.PS[b + k] - C.PS[a + k]; m += w[k]; } m /= 12; let xy = 0, yy = 0;
  for (let k = 0; k < 12; k++) { const v = w[k] - m; xy += v * L.mean[k]; yy += v * v; } return yy > 0 ? xy / (L.mnorm * Math.sqrt(yy)) : 0; }

/** How well the chroma heard (LiveAnalyser.ctap.window()) matches song `e` with its window ending at `pos`; null if either has none. */
export function chromaMatch(chroma, e, pos, rate = 1) { const L = liveChroma(query(null, chroma), rate, 0), C = song(e).ch; if (!L || !C) return null; return chromaAt(L, C, Math.round(pos * RATE)); }

// strictness while the window is short: 0 with 12 s heard, 1 with 6 s
const short = M => Math.max(0, Math.min(1, (WIN - M) / (WIN - WMIN)));

// the loudness search over one song at one speed: the best few places (window ends, 10 a second) at full resolution.
// Quick passes first: every 4th place at 2.5 values a second (all speeds), then around the best 16 of those at 5 a
// second, then the best 8 of those at 10 a second (only for the speed as heard and the two other speeds that fit best)
function loudScan(x, Y) {
  const M = x.length, hi = Y.n; if (hi < M) return { c4: [], top: -1 };
  const c4 = []; let prev = -9, prev2 = -9, top = -1;
  for (let end = hi; end >= M; end -= 4) { const v = loudCoarse(x, Y, end, 4); if (v > top) top = v; if (prev > v && prev >= prev2) c4.push([end + 4, prev]); prev2 = prev; prev = v; }
  if (prev >= prev2) c4.push([M + ((hi - M) % 4), prev]);
  return { c4: bestOf(c4, 16), top };
}
function loudRefine(x, Y, c4) {
  const M = x.length, hi = Y.n, c2 = new Map();
  for (const [end] of c4) for (let d = -4; d <= 4; d += 2) { const s = end + d; if (s >= M && s <= hi && !c2.has(s)) c2.set(s, loudCoarse(x, Y, s, 2)); }
  const fine = new Map(); for (const [end] of bestOf([...c2], 8)) for (let d = -2; d <= 2; d++) { const s = end + d; if (s >= M && s <= hi && !fine.has(s)) fine.set(s, loudAt(x, Y, s)); }
  return [...fine];
}
// the k best of [place, value] pairs, at least 0.4 s apart
function bestOf(cands, k) { cands.sort((p, q) => q[1] - p[1]); const out = []; for (const c of cands) { if (out.every(t => Math.abs(t[0] - c[0]) > 3)) out.push(c); if (out.length >= k) break; } return out; }
// the chroma-led search over one song at one speed and note shift: the quick pass at every 2nd frame (window ends, 5 a second)
function chromaPicks(L, C, st = 2) {
  const j0 = L.M5, nC = Math.max(0, Math.floor((C.n - j0) / st) + 1), co = new Float32Array(nC); let top = -1;
  for (let i = 0; i < nC; i++) { const v = chromaCoarse(L, C, j0 + st * i); co[i] = v; if (v > top) top = v; }
  return { co, j0, st, top };
}
const CH_MIN = 0.85; // a chroma-led match: the notes of the window must match this well (same recording: 0.9-1)

/**
 * Which remembered song is this, and where in it are we?
 * @param {ArrayLike<number>} live fingerprint bytes of what was heard, oldest first (at least 6 s; 12 s are used)
 * @param {{id:string, fp:string|Uint8Array, bpm:number, ch?:string}[]} entries
 * @param {{bpm?:number, chroma?:Float32Array|null, drumless?:boolean, min?:number}} [o] the live tempo, if known: a
 *   hint (a song whose stored tempo fits it, 1:1, 2:1, 1:2, 3:2 or 2:3, is accepted a little more easily; not when
 *   either side has no steady drums); chroma: LiveAnalyser.ctap.window() (see LiveAnalyser.memoryQuery()), to match on
 *   harmony too
 * @returns {{id:string, pos:number, score:number, margin:number, rate:number, chroma?:number}|null} pos: seconds into
 *   the song at the end of `live`; rate: song seconds per live second (1.03: played 3% fast)
 */
export function recognise(live, entries, o = {}) {
  const Q = query(live, o.chroma || null);
  const xs = RATES.map(r => [r, liveLoud(Q, r)]).filter(v => v[1]), any = xs.length || (o.chroma && liveChroma(Q, 1, 0));
  if (!any) return null; // too short, or too flat to tell (silence, a drone)
  let best = null;
  for (const e of entries) {
    const drumless = o.drumless || drumlessEntry(e);
    let tempoFits = null; // null: no opinion
    if (o.bpm && e.bpm && !drumless) { const r = o.bpm / e.bpm; tempoFits = [1, 2, 0.5, 1.5, 2 / 3].some(k => Math.abs(r / k - 1) < 0.07); }
    // speeds worth trying: with a tempo that fits, the ones near what it says (and 1); otherwise all of them
    let rates = RATES;
    if (tempoFits) { const r = o.bpm / e.bpm, k = [1, 2, 0.5, 1.5, 2 / 3].reduce((a, b) => Math.abs(r / b - 1) < Math.abs(r / a - 1) ? b : a), rho = r / k; rates = RATES.filter(q => q === 1 || Math.abs(q - rho) <= 0.025); }
    const found = matchSong(Q, e, xs.filter(v => rates.includes(v[0])), o, tempoFits, rates);
    if (found) { found.rank = found.score + (tempoFits === false ? -0.05 : 0); if (!best || found.rank > best.rank) best = found; }
  }
  if (best) delete best.rank;
  return best;
}

function matchSong(Q, e, xs, o, tempoFits, rates) {
  const S = song(e), Y = S.y, C = Q.chroma ? S.ch : null, strict = tempoFits === false ? 1 : 0;
  // the notes, per speed and shift: the quick pass (6-12 s averages); a song whose harmony fits nowhere is skipped
  const chs = []; if (C) for (const r of rates) for (const sh of shiftsFor(r)) { const L = liveChroma(Q, r, sh); if (L) chs.push({ r, sh, L, ...chromaPicks(L, C, r === 1 ? 2 : 4) }); }
  const chTop = chs.reduce((m, c) => Math.max(m, c.top), -1);
  if (chs.length && chTop < 0.65) return null;
  const chBest = r => { let b = null; for (const c of chs) if (c.r === r && (!b || c.top > b.top)) b = c; return b; };
  // loudness-led: the best place at any speed (speeds other than 1 must do a little better), against the runner-up
  // anywhere else from 0.4 s away, at any speed: a beat or a bar off counts, because in a steady, repetitive part those
  // are exactly the positions that look alike, and following the right song a beat late is still wrong
  if (Y) { let top = null; const all = [];
    const scans = xs.map(([r, x]) => ({ r, x, ...loudScan(x, Y) })), keep = new Set([1, ...scans.filter(c => c.r !== 1).sort((a, b) => b.top - a.top).slice(0, 2).map(c => c.r)]);
    for (const { r, x, c4 } of scans) if (keep.has(r)) for (const [end, v] of loudRefine(x, Y, c4)) { const adj = v - (r === 1 ? 0 : 0.03 + 0.5 * Math.abs(r - 1)); all.push([end, adj, r]); if (!top || adj > top.adj) top = { r, x, end, v, adj }; }
    if (top) { let second = 0; for (const [end, v, r] of all) if (Math.abs(end - top.end) > 3 + 60 * Math.abs(r - top.r) && v > second) second = v; // (at another speed, the same place shows a little further off)
      const f = short(top.x.length), margin = top.adj - second;
      if (top.v > (o.min ?? 0.67) + 0.1 * f + 0.05 * strict && margin > 0.08 + 0.04 * f + 0.03 * strict) {
        const cb = chBest(top.r), c = cb ? Math.max(...shiftsFor(top.r).map(sh => { const L = liveChroma(Q, top.r, sh); return L ? chromaAt(L, C, top.end) : -1; })) : null;
        // in a song that loops, the same loudness comes back a few bars on: there the notes must say this is the place
        const chAt = (r, end) => Math.max(...shiftsFor(r).map(sh => { const L = liveChroma(Q, r, sh); return L ? chromaAt(L, C, end) : -1; }));
        const rival = c != null && all.some(([end, v, r]) => Math.abs(end - top.end) > 3 + 60 * Math.abs(r - top.r) && v > top.adj - 0.15 && chAt(r, end) > c + 0.03);
        if ((c == null || c > 0.7) && !rival) return { id: e.id, pos: top.end / RATE, score: top.v, margin, rate: top.r, ...(c != null ? { chroma: c } : {}) };
      } } }
  // chroma-led: the speed and shift whose notes fit best somewhere
  if (!chs.length) return null;
  let found = null;
  const tryCh = chs.slice().sort((a, b) => (b.r === 1 && !b.sh) - (a.r === 1 && !a.sh) || b.top - a.top).slice(0, 2); // as heard, and the other best fit
  for (const c of tryCh) { const m = chromaSearch(c, C, Y, xs, strict, !drumlessEntry(e)); if (m && (!found || m.score > found.score)) found = { ...m, rate: c.r }; }
  return found ? { id: e.id, pos: found.end / RATE, score: found.score, margin: found.margin, rate: found.rate, chroma: found.chroma } : null;
}

function chromaSearch({ r, L, co, j0, st, top }, C, Y, xs, strict, drums) {
  if (co.length < 1 || top < 0.75) return null; // the notes don't fit anywhere in this song
  const f = short(2 * L.M5), J = i => j0 + st * i;
  // up to 6 places whose average fits best, at least a second apart (a chorus that comes back is another place)
  const picks = [], floor = Math.max(0.7, top - 0.2);
  for (let k = 0; k < 6; k++) { let bi = -1; for (let i = 0; i < co.length; i++) if (co[i] > floor && (bi < 0 || co[i] > co[bi]) && picks.every(p => Math.abs(J(p) - J(i)) > 5)) bi = i; if (bi < 0) break; picks.push(bi); }
  const fine = new Map(), endMax = 2 * C.n;
  for (const p of picks) { const j = J(p); for (let end = Math.max(2 * L.M5, 2 * j - 10); end <= Math.min(endMax, 2 * j + 10); end += 2) if (!fine.has(end)) fine.set(end, chromaAt(L, C, end)); } // every 200 ms...
  let eb = -1, cb = -1; for (const [end, v] of fine) if (v > cb) { cb = v; eb = end; }
  for (const end of [eb - 1, eb + 1]) if (end >= 2 * L.M5 && end <= endMax) { const v = chromaAt(L, C, end); fine.set(end, v); if (v > cb) { cb = v; eb = end; } } // ...then the 100 ms either side of the best
  let second = 0; for (const [end, v] of fine) if (Math.abs(end - eb) > 10 && v > second) second = v; // another place, more than a second away
  if (cb < CH_MIN + 0.03 * f + 0.02 * strict || cb - second < 0.05 + 0.02 * f) return null;
  const need = CH_MIN + 0.03 * f + 0.02 * strict; if (globalThis.MDBG) console.log('ch', r, 'cb', cb.toFixed(3), 'second', second.toFixed(3), 'M5', L.M5, 'at', eb / 10); if (cb < need - 0.13 || cb - second < 0.05 + 0.02 * f + 2.5 * Math.max(0, need - cb)) return null;
  // the loudness picks the exact 100 ms, and must not say no
  const x = (xs.find(v => v[0] === r) || [])[1];
  let best = null; for (let end = eb - 2; end <= eb + 2; end++) { const l = x && Y ? loudAt(x, Y, end) : 0, c = fine.get(end) ?? chromaAt(L, C, end);
    const v = 0.65 * c + 0.35 * l; if (!best || v > best.v) best = { end, v, l, c }; }
  if (x && Y && best.l < (drums ? 0.35 : 0.1)) return null; // (a song with drums has a loudness shape that must agree too)
  // a section that comes back note for note (a second chorus, a second drop) fits the notes as well: there the
  // loudness of the stretch before it must tell them apart, so the best other place with nearly as good notes must
  // fall clearly behind in notes and loudness together
  if (x && Y) for (const [end, v] of fine) if (Math.abs(end - eb) > 10 && v > cb - 0.08 && 0.65 * v + 0.35 * loudAt(x, Y, end) > best.v - 0.04) return null;
  return { end: best.end, score: best.v, chroma: best.c, margin: cb - second };
}

/**
 * Is this still the same song, near where we think it is? For following a song once recognised: only positions
 * within `range` seconds of `pos` are tried, so a repetitive song (a chorus that comes back) can't throw it off.
 * @param {{chroma?:Float32Array|null, rate?:number}} [o] the live chroma window, to weigh the notes in too; rate: song
 *   seconds per live second, when it is played faster or slower
 * @returns {{pos:number, score:number}|null} null when the live sound is too flat to tell (a quiet part, silence)
 */
export function matchAt(live, e, pos, range = 0.8, o = {}) {
  const rate = o.rate || 1, Q = query(live, o.chroma || null), x = liveLoud(Q, rate), Y = song(e).y; if (!x || !Y) return null;
  // with chroma on both sides, the notes must match too: a song with the same tempo and bars (the same loudness shape)
  // but other chords is turned down, and a quiet ballad with a weak loudness shape is held by its notes
  const C = o.chroma ? song(e).ch : null, Ls = C ? shiftsFor(rate).map(sh => liveChroma(Q, rate, sh)).filter(Boolean) : [];
  const c = Math.round(pos * RATE), rr = Math.round(range * RATE); let best = null;
  for (let end = Math.max(x.length, c - rr); end <= Math.min(Y.n, c + rr); end++) { const l = loudAt(x, Y, end), ch = Ls.length ? Math.max(...Ls.map(L => chromaAt(L, C, end))) : 0, v = Ls.length ? Math.min(ch, (l + ch) / 2) : l;
    if (!best || v > best.score) best = { pos: end / RATE, score: v }; }
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
