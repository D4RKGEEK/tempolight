// Learning a Spotify track's beat map the first time it plays, from what Tempolight hears while it plays, lined up
// with Spotify's position so the map's time 0 is the start of the track (even when listening started in the middle).
//
// The live sound (the same 22 kHz mono samples the live analyser gets, from a browser or this computer's sound card)
// is kept as it comes, in "stretches" of continuous listening. For each chunk, the track position its last sample was
// heard at (from the Spotify clock, at the time the sound was captured) gives an offset: where in the track this
// stretch's first sample is. That offset is the same for every chunk while the track plays on, so the median over all of
// them is far steadier than any single reading of the Web API; a chunk whose offset is suddenly elsewhere means a seek,
// a pause or a gap, and starts a new stretch. When the track ends (or changes, or pauses for a while), each stretch of
// 15 s or more is analysed exactly like a song file (preAnalyseCore), its times are shifted by its offset, and it is
// merged into what was learned before: a partial map covers only what was heard (`cov`, a list of [from, to] seconds),
// and later plays fill in the rest. No I/O and no Node modules.
import { preAnalyseCore, unpackChroma, packChroma, memoryAnalysis } from "../../engine/src/index.js";

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const STEP = 0.02; // the loudness envelope's step (s)

/** The same beat grid, with its first beat at or after time 0 (and the bar count shifted to match). */
export function normGrid(P, off, barOff) { const k = Math.floor(off / P); return { P, off: off - k * P, barOff: (((barOff + k) % 4) + 4) % 4 }; }

/** [from, to] ranges joined where they overlap or nearly touch, sorted. */
export function unionRanges(list, gap = 0.5) {
  const s = list.filter(r => r && r[1] > r[0]).map(r => [r[0], r[1]]).sort((a, b) => a[0] - b[0]), out = [];
  for (const r of s) { const l = out.at(-1); if (l && r[0] <= l[1] + gap) l[1] = Math.max(l[1], r[1]); else out.push(r); }
  return out;
}
/** Seconds covered by the ranges. */
export const coveredSec = cov => (cov || []).reduce((n, r) => n + r[1] - r[0], 0);
/** Is time t inside the ranges (a little way in from their edges)? Entries without `cov` cover the whole song. */
export function covers(cov, t, margin = 0.25) { if (!cov) return true; return cov.some(r => t >= r[0] + margin && t <= r[1] - margin); }

/**
 * Collects what is heard for one track at a time.
 * @param {{rate?:number, maxSec?:number, minSec?:number, jumpSec?:number}} [o]
 */
export function createLearner(o = {}) {
  const rate = o.rate || 22050, maxSec = o.maxSec ?? 900, minSec = o.minSec ?? 15, jumpSec = o.jumpSec ?? 0.35;
  let id = null, segs = [], total = 0;
  const offOf = s => median(s.offs.length > 400 ? s.offs.slice(-400) : s.offs);
  return {
    get id() { return id; },
    /** Seconds heard so far for this track, and the ranges they cover (approximate until finish()). */
    heard() { return { sec: total / rate, cov: unionRanges(segs.map(s => { const t0 = offOf(s); return [t0, t0 + s.n / rate]; })) }; },
    /**
     * One chunk of what was heard. `pos`: where in the track the chunk's LAST sample was playing when it was
     * captured (seconds). Samples: Int16 (or Float32 -1..1) mono at `rate`.
     */
    push(trackId, samples, pos, r = rate) {
      if (r !== rate) return false;
      if (trackId !== id) { id = trackId; segs = []; total = 0; }
      if (total / rate >= maxSec) return false;
      let s = segs.at(-1);
      if (s) { const o2 = pos - (s.n + samples.length) / rate; if (Math.abs(o2 - offOf(s)) > jumpSec) s = null; }
      if (!s) { s = { chunks: [], n: 0, offs: [] }; segs.push(s); }
      const c = samples instanceof Int16Array ? samples.slice() : Int16Array.from(samples, v => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
      s.chunks.push(c); s.n += c.length; total += c.length; s.offs.push(pos - s.n / rate);
      return true;
    },
    /** Forget what was heard (another track, or learning was turned off). */
    reset() { id = null; segs = []; total = 0; },
    /**
     * Analyse every stretch long enough: [{t0, t1, pre}] with the analysis's times already in track time.
     * Clears what was heard. @param {(p:number)=>void} [onProgress]
     */
    async finish(onProgress) {
      const list = segs.filter(s => s.n / rate >= minSec), out = []; segs = []; total = 0;
      let done = 0; const all = list.reduce((n, s) => n + s.n, 0) || 1;
      for (const s of list) {
        const t0 = offOf(s), x = new Float32Array(s.n); let i = 0; for (const c of s.chunks) { for (let k = 0; k < c.length; k++) x[i + k] = c[k] / 32768; i += c.length; }
        const pre = await preAnalyseCore(x, rate, p => onProgress && onProgress((done + p * s.n) / all)); done += s.n;
        out.push(shiftPre(regrid(pre), t0));
      }
      return out;
    },
  };
}

// A short stretch (a build-up and a drop, say) can leave the tempo at half or double, or the beat between the kicks.
// With enough kicks, the grid whose beats the kicks agree on best (half, same or double tempo; phase from the kicks, as
// analysis.js locks it) wins, and the bars are laid out again on it (each new bar takes the part of the old bar under it).
export function regrid(pre) {
  const kicks = pre.kicks || []; if (kicks.length < 8) return pre;
  const fit = P => { let sx = 0, sy = 0; for (const t of kicks) { const a = 2 * Math.PI * t / P; sx += Math.cos(a); sy += Math.sin(a); } return { P, R: Math.hypot(sx, sy) / kicks.length, off: ((Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1) * P }; };
  const best = P0 => { let g = fit(P0); for (let bpm = 60 / P0 - 2; bpm <= 60 / P0 + 2.001; bpm += 0.05) { const c = fit(60 / bpm); if (c.R > g.R) g = c; } return g; }; // (the tempo of a short stretch is often a little off too)
  const cands = [pre.P, pre.P / 2, pre.P * 2].filter(P => 60 / P >= 55 && 60 / P <= 185).map(best);
  cands.sort((a, b) => Math.abs(b.R - a.R) > 0.08 ? b.R - a.R : Math.abs(60 / a.P - 120) - Math.abs(60 / b.P - 120));
  const g = cands[0]; if (!g || g.R < 0.5) return pre;
  { let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0; // then least squares through the kicks on it
    for (const t of kicks) { const k = Math.round((t - g.off) / g.P); if (Math.abs(t - (g.off + k * g.P)) > 0.04) continue; sx += k; sy += t; sxx += k * k; sxy += k * t; n++; }
    const den = n * sxx - sx * sx; if (n >= 8 && den > 0) { const P = (n * sxy - sx * sy) / den; if (Math.abs(P / g.P - 1) < 0.01) { g.off = (sy - P * sx) / n; g.P = P; g.off -= Math.floor(g.off / P) * P; } } }
  if (Math.abs(g.P - pre.P) < 1e-9 && Math.abs(((g.off - pre.off) / g.P) - Math.round((g.off - pre.off) / g.P)) * g.P < 0.03) return pre; // the same grid
  // beat 1: new sections start on it, so the beat with the biggest loudness jumps (as analysis.js finds it)
  const env = pre.env || [], eAt = (t0, t1) => { let s = 0, n = 0; for (let i = Math.max(0, Math.floor(t0 / STEP)); i < Math.min(env.length, Math.ceil(t1 / STEP)); i++) { s += env[i]; n++; } return n ? s / n : 0; };
  const score = [0, 0, 0, 0]; let prev = null;
  for (let k = 0; g.off + (k + 1) * g.P <= pre.dur; k++) { const e = eAt(g.off + k * g.P, g.off + (k + 1) * g.P); if (prev != null) score[k % 4] += Math.max(0, e - prev) ** 2; prev = e; }
  const grid = { P: g.P, off: g.off, barOff: score.indexOf(Math.max(...score)) };
  return { ...pre, ...grid, bpm: 60 / g.P, bars: relayBars(pre.bars || [], grid, pre.dur) };
}
/** Bars laid out again on a grid (4 beats each, from beat 1): each takes the part and level of the bar under its middle. */
export function relayBars(old, g, dur, from = 0) {
  const sorted = old.slice().sort((a, b) => a.t0 - b.t0), at = t => { let lo = 0, hi = sorted.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m].t1 <= t) lo = m + 1; else if (sorted[m].t0 > t) hi = m - 1; else return sorted[m]; } return null; };
  const out = []; let k = g.barOff + 4 * Math.ceil((from - g.off) / (4 * g.P) - g.barOff / 4 - 1);
  for (; g.off + (k + 4) * g.P <= dur + 1e-6; k += 4) { const t0 = g.off + k * g.P, t1 = t0 + 4 * g.P; if (t0 < -1e-6) continue; const o = at((t0 + t1) / 2); if (o) out.push({ t0, t1, state: o.state, level: o.level }); }
  return out;
}

/** An analysis of a stretch that started at track time t0, moved onto the track's clock: {t0, t1, pre}. */
export function shiftPre(pre, t0) {
  const sh = a => Array.from(a || [], t => t + t0), g = normGrid(pre.P, pre.off + t0, pre.barOff);
  return { t0, t1: t0 + pre.dur, pre: { ...pre, ...g, kicks: sh(pre.kicks), snares: sh(pre.snares), hats: sh(pre.hats), drops: sh(pre.drops),
    bars: (pre.bars || []).map(b => ({ ...b, t0: b.t0 + t0, t1: b.t1 + t0 })), env: Float32Array.from(pre.env || []), chroma: pre.chroma || "" } };
}

// ---------------------------------------------------------------- maps: what was learned so far, merged
/** A remembered song (memory.js entry) as a map to merge into (cov: what it covers; without it the whole song). */
export function entryToMap(e) {
  const pre = memoryAnalysis(e), dur = e.dur;
  const ch5 = typeof e.ch === "string" && e.ch ? unpackChroma(e.ch) : new Float32Array(0);
  return { ...pre, dur, cov: e.cov ? e.cov.map(r => [r[0], r[1]]) : [[0, dur]], gridSec: e.gridSec ?? coveredSec(e.cov || [[0, dur]]), ch5, src: e.src || null };
}

/** A map with nothing in it yet, for a track of `dur` seconds. */
export function emptyMap(dur) { return { dur, cov: [], gridSec: 0, P: 0.5, off: 0, barOff: 0, bpm: 120, kicks: [], snares: [], hats: [], bars: [], drops: [], env: new Float32Array(Math.ceil(dur / STEP)), ch5: new Float32Array(Math.floor(dur * 5) * 12), style: "poprock", key: null, mode: null, keyConfidence: 0, mood: null }; }

/**
 * Merge a newly heard stretch ({t0, t1, pre} from finish()) into a map: inside the stretch the new analysis wins,
 * outside it what was there stays. The beat grid comes from whichever has heard more, then is fitted through all the
 * kicks and snares so stretches heard on different days line up on one grid.
 */
export function mergeMap(map, part) {
  const dur = map.dur, a = Math.max(0, part.t0), b = Math.min(dur, part.t1), p = part.pre, inside = t => t >= a && t < b;
  const ev = k => [...(map[k] || []).filter(t => !inside(t)), ...(p[k] || []).filter(t => inside(t) && t <= dur)].sort((x, y) => x - y);
  const out = { ...map, cov: unionRanges([...map.cov, [a, b]]), kicks: ev("kicks"), snares: ev("snares"), hats: ev("hats") };
  // bars: the old ones mostly outside the stretch, the new ones inside it
  const add = (p.bars || []).filter(x => x.t0 >= a - 0.05 && x.t1 <= b + 0.05 && x.t1 <= dur + 0.05);
  const keep = (map.bars || []).filter(x => !add.some(y => Math.min(x.t1, y.t1) - Math.max(x.t0, y.t0) > (x.t1 - x.t0) / 2)); // an old bar goes only where a new one takes its place
  const bars = [...keep.map(x => ({ ...x, old: true })), ...add].sort((x, y) => x.t0 - y.t0), clean = [];
  for (const x of bars) { const l = clean.at(-1); if (l && x.t0 < l.t1 - 0.05) { if (l.old && !x.old) clean[clean.length - 1] = x; continue; } clean.push(x); }
  out.bars = clean.map(({ old, ...x }) => x);
  // loudness and chroma: copied in over the stretch
  out.env = Float32Array.from(map.env.length === Math.ceil(dur / STEP) ? map.env : resize(map.env, Math.ceil(dur / STEP)));
  for (let i = 0; i < p.env.length; i++) { const j = Math.round((part.t0 + i * STEP) / STEP); if (j >= 0 && j < out.env.length && j * STEP >= a && j * STEP < b) out.env[j] = p.env[i]; }
  out.ch5 = Float32Array.from(map.ch5.length === Math.floor(dur * 5) * 12 ? map.ch5 : resize(map.ch5, Math.floor(dur * 5) * 12));
  if (p.chroma) { const c = unpackChroma(p.chroma); for (let f = 0; f < c.length / 12; f++) { const g = Math.round((part.t0 + f / 5) * 5); if (g >= 0 && g < out.ch5.length / 12 && g / 5 >= a && g / 5 < b) for (let k = 0; k < 12; k++) out.ch5[g * 12 + k] = c[f * 12 + k]; } }
  // the grid, key, mood and style from whichever has heard more
  const sec = b - a, takeNew = sec > (map.gridSec || 0);
  if (takeNew) Object.assign(out, { P: p.P, off: p.off, barOff: p.barOff, bpm: p.bpm, style: p.style, key: p.key, mode: p.mode, keyConfidence: p.keyConfidence, mood: p.mood, gridSec: sec });
  if (map.gridSec > 0) refit(out);
  Object.assign(out, normGrid(out.P, out.off, out.barOff)); out.bpm = 60 / out.P;
  out.bars = relayBars(out.bars, out, dur); // one set of bars on the one grid (stretches analysed apart put theirs on their own)
  // drops: a drop bar right after a bar that isn't one (with no gap between them: a stretch that starts in the middle
  // of a drop doesn't know where it began), or the first bar of the song
  out.drops = []; out.bars.forEach((x, i) => { const prev = out.bars[i - 1]; if (x.state === "drop" && (prev ? prev.state !== "drop" && x.t0 - prev.t1 < 0.1 : x.t0 < 1)) out.drops.push(x.t0); });
  return out;
}
function resize(a, n) { const o = new Float32Array(n); o.set(a.subarray ? a.subarray(0, n) : a.slice(0, n)); return o; }
// least squares through the drum hits that sit on the grid: one grid for stretches heard at different times
function refit(m) {
  const pts = [...m.kicks, ...m.snares]; let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const t of pts) { const k = Math.round((t - m.off) / m.P), r = t - (m.off + k * m.P); if (Math.abs(r) > 0.04) continue; sx += k; sy += t; sxx += k * k; sxy += k * t; n++; }
  const den = n * sxx - sx * sx; if (n < 16 || !(den > 0)) return;
  const P = (n * sxy - sx * sy) / den, off = (sy - P * sx) / n; if (Math.abs(P / m.P - 1) > 0.01) return;
  m.P = P; m.off = off;
}

/** A map as an analysis for memoryEntry() (song memory), with its coverage alongside. */
export function mapToPre(m) {
  const frames10 = new Float32Array(m.ch5.length * 2); for (let f = 0; f < m.ch5.length / 12; f++) for (let k = 0; k < 12; k++) { frames10[(2 * f) * 12 + k] = m.ch5[f * 12 + k]; frames10[(2 * f + 1) * 12 + k] = m.ch5[f * 12 + k]; }
  return { bpm: m.bpm, P: m.P, off: m.off, barOff: m.barOff, style: m.style, dur: m.dur, drops: m.drops, kicks: m.kicks, snares: m.snares, hats: m.hats, bars: m.bars, env: m.env,
    chroma: m.ch5.some(v => v > 0) ? packChroma(frames10) : "", key: m.key, mode: m.mode, keyConfidence: m.keyConfidence, mood: m.mood };
}
