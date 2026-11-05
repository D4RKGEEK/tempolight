#!/usr/bin/env node
// Effect ratings: how good each built-in effect is as a drop, a build-up and a calm part, measured, not guessed.
// Every effect runs ALONE (no switching) through the real director and effects on the example room at 60 fps over a
// set of synthetic songs with known beats, kicks, snares and song parts:
//   edm128   packages/engine/test/feel-song.js at 128 BPM (the feel harness: intro, build, drop, break, build, drop)
//   edm150   the same song at 150 BPM
//   pop116   synth.js majorPop() (drums; quiet verse, louder chorus)        pop116dry  the same notes without drums
//   ballad64 synth.js minorBallad() (no drums)
//   hiphop88, halftime140, dnb174   grooves from beat-songs.js
//   four90, four174                 four-on-the-floor grooves (beat-songs.js makeSong) for the tempo series
// The analysis' beat grid, hits and song parts are replaced with the songs' truth (loudness, key and mood stay from the
// analysis), so an effect is judged on what it does with the right signals, not on analysis mistakes; the live analyser
// runs alongside for the spectrum, waveform and bass level, as in the app. Each effect is run twice:
//   raw   manual mode with the kick pump, drop flash and ambient fill off: the effect on its own
//   feel  automatic mode playing a one-effect show with the feel defaults (punch, dynamics, variations): what users see
// and measured per song part (see measure()). The measurements become a score 0..100 per role and traits for matching
// effects to songs (score()), written to packages/engine/src/ratings.js and docs/internals/effect-ratings.md.
// Zero dependencies; deterministic (Math.random is seeded for every run, so the split over workers doesn't matter).
//
//   node scripts/effect-score.js                      # score every effect, print the report (a few minutes)
//   node scripts/effect-score.js --write              # ... and write ratings.js and the report page
//   node scripts/effect-score.js --check              # cheap: is ratings.js up to date with effects.js? (exit 1 if not)
//   node scripts/effect-score.js --only shock,fire    # just these effects (report only)
//   node scripts/effect-score.js --save m.json        # also save the measurements; --from m.json scores those (with --write too)
//   node scripts/effect-score.js --workers 2          # worker threads (default: the number of CPUs, at most 4)
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
// from the modules, not index.js: index.js exports ratings.js, which this script makes (and may not exist yet)
import { preAnalyseCore } from "../packages/engine/src/analysis.js";
import { buildLayout, exampleRoom } from "../packages/engine/src/layout.js";
import { createEffects } from "../packages/engine/src/effects.js";
import { createDirector } from "../packages/engine/src/director.js";
import { songView } from "../packages/engine/src/signals.js";
import { LiveAnalyser } from "../packages/engine/src/live.js";
import { rng, majorPop, minorBallad, piece } from "../packages/engine/test/synth.js";
import { feelSong } from "../packages/engine/test/feel-song.js";
import { makeSong, SPECS } from "../packages/engine/test/beat-songs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EFFECTS_FILE = path.join(root, "packages/engine/src/effects.js");
export const RATINGS_FILE = path.join(root, "packages/engine/src/ratings.js");
export const REPORT_FILE = path.join(root, "docs/internals/effect-ratings.md");
// toRGB8 as in index.js (copied for the same reason), at brightness 0.8 like feel-eval
function toRGB8(col, out) { for (let i = 0; i < col.length; i++) { const v = col[i] * 0.8; out[i] = v > 0 ? Math.min(255, Math.round(255 * (1 - Math.exp(-1.6 * v)))) : 0; } return out; }
const FPS = 60, LAG = 30, ROLES = ["drop", "build", "calm"];

// ---------------------------------------------------------------- staleness: effect ids and a hash of their sources
/** Each built-in effect's source text in effects.js (the object literal from `{ id: "x", name:` to its closing brace). */
export function effectSources(text) {
  const out = new Map(), re = /\{\s*id:\s*"([A-Za-z0-9_-]+)",\s*name:/g; let m;
  while ((m = re.exec(text))) {
    let i = m.index, depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") { const q = c; for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++; continue; }
      if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "{") depth++; else if (c === "}" && --depth === 0) break;
    }
    if (!out.has(m[1])) out.set(m[1], text.slice(m.index, i + 1));
  }
  return out;
}
const fnv = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, "0"); };
/** One hash over the given effects' sources, in id order (whitespace-insensitive: reformatting isn't a change). */
export function sourceHash(text, ids) {
  const src = effectSources(text); return fnv(ids.slice().sort().map(id => `${id}:${(src.get(id) || "").replace(/\s+/g, " ")}`).join("\n"));
}
/** The built-in effects (no custom ones), in library order. */
export function builtinEffects() { return createEffects(buildLayout(exampleRoom())).list.filter(e => !e.custom); }
/**
 * Is ratings.js up to date? Compares the effect ids and the hash of their sources (in ratings.js' header) with
 * effects.js, and checks AUTO only lists existing effects with the role's tag. Cheap: nothing is scored.
 */
export async function checkRatings(file = RATINGS_FILE) {
  const problems = [], text = readFileSync(file, "utf8"), mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const list = builtinEffects(), ids = list.map(e => e.id), rated = Object.keys(mod.RATINGS || {});
  const added = ids.filter(id => !rated.includes(id)), removed = rated.filter(id => !ids.includes(id));
  if (added.length) problems.push(`not rated (new effects): ${added.join(", ")}`);
  if (removed.length) problems.push(`rated but no longer in effects.js: ${removed.join(", ")}`);
  const want = sourceHash(readFileSync(EFFECTS_FILE, "utf8"), ids), have = (text.match(/^\/\/ effects-hash: ([0-9a-f]+)/m) || [])[1];
  if (have !== want) problems.push(`effect sources changed since the ratings were made (hash ${have || "missing"}, now ${want})`);
  const tag = Object.fromEntries(list.map(e => [e.id, e.tag]));
  for (const r of ROLES) for (const id of (mod.AUTO || {})[r] || []) {
    if (!tag[id]) problems.push(`AUTO.${r}: unknown effect ${id}`);
    else if (tag[id] !== (r === "calm" ? "calm" : r)) problems.push(`AUTO.${r}: ${id} is tagged ${tag[id]}`);
  }
  return { ok: !problems.length, problems };
}

// ---------------------------------------------------------------- songs with their truth
const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : null; };
const clamp01 = v => Math.max(0, Math.min(1, v));
function corr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return null; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let xy = 0, xx = 0, yy = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; xy += x * y; xx += x * x; yy += y * y; }
  return xx > 1e-12 && yy > 1e-12 ? xy / Math.sqrt(xx * yy) : 0;
}

/** bars: [{state, role}] per bar (role: which kind of song part this bar counts for, or null). */
function song(name, audio, { bpm, style, bars, kicks = [], snares = [], hats = [], drops = [], weight = 1, feel = true, scored = true, tempoFit = true }) {
  const P = 60 / bpm, bar = 4 * P;
  return { name, x: audio.x, sr: audio.sr, dur: audio.x.length / audio.sr, bpm, P, bar, style, weight, feel, scored, tempoFit,
    kicks: kicks.slice().sort((a, b) => a - b), snares: snares.slice().sort((a, b) => a - b), hats: hats.slice().sort((a, b) => a - b), drops,
    bars: bars.map((b, i) => ({ t0: i * bar, t1: (i + 1) * bar, state: b.state, role: b.role })) };
}
function grid(bars, bpm, pat) { // hits of a constant-tempo song from a per-bar pattern {k, s, h} in beats
  const P = 60 / bpm, o = { kicks: [], snares: [], hats: [] };
  for (let b = 0; b < bars; b++) { const p = pat(b); if (!p) continue; for (const [k, key] of [["k", "kicks"], ["s", "snares"], ["h", "hats"]]) for (const q of p[k] || []) o[key].push((b * 4 + q) * P); }
  return o;
}
export function makeSongs() {
  const out = [];
  for (const bpm of [128, 150]) { // the feel harness' song: its parts are its truth
    const s = feelSong(22050, bpm), T = s.truth, bars = [];
    const ST = { intro: "calm", build: "build", drop: "drop", break: "calm", outro: "calm", silence: "calm" }, RO = { intro: "calm", build: "build", drop: "drop", break: "calm" };
    for (const p of T.parts) for (let t = p.t0; t < p.t1 - 1e-6; t += T.bar) bars.push({ state: ST[p.part], role: RO[p.part] || null });
    out.push(song(`edm${bpm}`, s, { bpm, style: "party", bars, kicks: T.kicks, snares: T.snares, hats: T.hats, drops: T.parts.filter(p => p.part === "drop").map(p => p.t0), weight: bpm === 128 ? 2 : 1 }));
  }
  // majorPop: 24 bars, a quiet verse (bars 0-7, 16-23) and a louder chorus (8-15), drums all along (synth.js piece())
  const popBars = Array.from({ length: 24 }, (_, b) => Math.floor(b / 8) % 2 ? { state: "drop", role: "drop" } : { state: "calm", role: "calm" });
  const popHits = grid(24, 116, () => ({ k: [0, 1, 2, 3], s: [1, 3], h: [0.5, 1.5, 2.5, 3.5] }));
  out.push(song("pop116", majorPop(), { bpm: 116, style: "poprock", bars: popBars, ...popHits }));
  // the same song without drums: only for "needs a beat" (does the effect fall apart without drums?), not scored
  out.push(song("pop116dry", piece({ tonic: 2, mode: "major", bpm: 116, bars: 24, seed: 9, drums: false }), { bpm: 116, style: "poprock", bars: popBars, feel: false, scored: false }));
  out.push(song("ballad64", minorBallad(), { bpm: 64, style: "emotional", bars: Array.from({ length: 20 }, () => ({ state: "calm", role: "calm" })), feel: false }));
  for (const [name, i, style] of [["hiphop88", 3, "hiphop"], ["halftime140", 4, "party"], ["dnb174", 5, "party"]]) {
    const spec = SPECS[i], s = makeSong(spec), h = grid(spec.bars, spec.tempo, b => spec.pattern(b, "full"));
    out.push(song(name, s, { bpm: spec.tempo, style, bars: Array.from({ length: spec.bars }, () => ({ state: "drop", role: "drop" })), kicks: s.truth.kicks, snares: h.snares, hats: h.hats, tempoFit: false }));
  }
  // four-on-the-floor grooves at a slow and a fast tempo: with edm128, edm150 and pop116 they make a series where only
  // the tempo changes, for the tempo fit (the grooves above change the kick pattern too, so they don't count for it)
  for (const bpm of [90, 174]) {
    const spec = { name: `four${bpm}`, tempo: bpm, bars: 16, seed: 3, pattern: () => ({ k: [0, 1, 2, 3], s: [1, 3], h: [0.5, 1.5, 2.5, 3.5], bass: true }) };
    const s = makeSong(spec), h = grid(spec.bars, bpm, spec.pattern);
    out.push(song(`four${bpm}`, s, { bpm, style: "party", bars: Array.from({ length: spec.bars }, () => ({ state: "drop", role: "drop" })), kicks: s.truth.kicks, snares: h.snares, hats: h.hats }));
  }
  return out;
}

/** Analyse a song, put its truth in place of the analysis' grid, hits and parts, and record the live extras per frame. */
async function prepare(S) {
  const pre = await preAnalyseCore(S.x, S.sr), lvl = t => { const b = pre.bars.find(b => t >= b.t0 && t < b.t1); return b ? b.level : 0.5; };
  Object.assign(pre, { bpm: S.bpm, P: S.P, off: 0, barOff: 0, kicks: S.kicks, snares: S.snares, hats: S.hats, drops: S.drops, style: S.style, kickStrength: undefined,
    bars: S.bars.map(b => ({ t0: b.t0, t1: b.t1, state: b.state, level: lvl((b.t0 + b.t1) / 2) })) });
  const nF = Math.floor(S.dur * FPS), an = new LiveAnalyser(S.sr), chunk = Math.round(S.sr / FPS), extras = new Array(nF);
  for (let f = 0, pos = 0; f < nF; f++, pos += chunk) { an.push(S.x.subarray(pos, Math.min(S.x.length, pos + chunk))); const e = an.extras(); extras[f] = { bands: Float32Array.from(e.bands), wave: Float32Array.from(e.wave), bassL: e.bassL }; }
  // loudness per bar (for "follows the music" in calm parts), from the analysis' envelope (20 ms steps)
  const barLoud = S.bars.map(b => { let s = 0, n = 0; for (let j = Math.round(b.t0 / 0.02); j < Math.round(b.t1 / 0.02) && j < pre.env.length; j++) { s += pre.env[j]; n++; } return n ? s / n : 0; });
  // onsets a light change may follow: hits and the eighth-note grid
  const on = [...S.kicks, ...S.snares, ...S.hats]; for (let t = 0; t < S.dur; t += S.P / 2) on.push(t);
  return { ...S, pre, nF, extras, barLoud, onsets: Float64Array.from(on.sort((a, b) => a - b)) };
}

// ---------------------------------------------------------------- run one effect through the director, record every frame
function run(L, S, id, feel) {
  const saved = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42));
  try {
    const N = L.N, fx = createEffects(L), D = createDirector(L, fx), ds = D.settings;
    D.state.cur = id; D.state.switchBar = 0;
    if (feel) { ds.mode = "auto"; ds.plan = S.bars.map(b => ({ t0: b.t0, t1: b.t1, effect: id, part: b.state })); } // the feel defaults (punch, dynamics, variations, drop flash, ambient fill)
    else { ds.mode = "manual"; ds.effect = id; ds.punch = 0; ds.dropFlash = false; ds.ambient = "off"; }
    const nF = S.nF, lum = new Float32Array(nF), chg = new Float32Array(nF), slow = new Float32Array(nF), led = new Uint8Array(nF * N), c8 = new Uint8Array(N * 3), p8 = new Uint8Array(N * 3);
    const ring = Array.from({ length: LAG }, () => new Uint8Array(N * 3)); // the last LAG frames, for the change over LAG frames
    for (let f = 0; f < nF; f++) {
      const now = (f + 1) / FPS, col = D.frame(songView(S.pre, now), now, S.extras[f], now); toRGB8(col, c8);
      const old = ring[f % LAG]; let s = 0, d = 0, d2 = 0; for (let i = 0; i < c8.length; i++) { s += c8[i]; d += Math.abs(c8[i] - p8[i]); d2 += Math.abs(c8[i] - old[i]); }
      for (let i = 0, j = f * N; i < N; i++, j++) led[j] = Math.round((c8[i * 3] + c8[i * 3 + 1] + c8[i * 3 + 2]) / 3);
      lum[f] = s / c8.length / 255; chg[f] = f ? d / c8.length / 255 : 0; slow[f] = f >= LAG ? d2 / c8.length / 255 : 0; p8.set(c8); old.set(c8);
    }
    return { lum, chg, slow, led, N };
  } finally { Math.random = saved; }
}

// ---------------------------------------------------------------- measurements of one run, per kind of song part
/**
 * Per role (the bars whose truth counts for it; the first 0.25 s of each stretch skipped):
 *   lum        mean brightness (after the LED roll-off, brightness 0.8, as feel-eval)
 *   barCV      how much the brightness changes from bar to bar (std / mean); barLow: the dimmest bars (p10) / the median
 *   kc, kcP10  kick contrast: (peak in the 120 ms after a kick - trough in the 120 ms before) / peak; median and 10th pct
 *   sc         the same at snares (build-ups: does it hit the snare roll)
 *   syncL/M    beat sync: correlation of brightness / of frame-to-frame change with an impulse on each kick (snare in
 *              build-ups; the beat grid without drums), decaying in 120 ms
 *   act, alive mean frame-to-frame change of every LED channel (0..1), over everything / between kicks (40-95% of a beat)
 *   drift      mean change of every LED channel over half a second (slow movement that a frame-to-frame change misses)
 *   dl         mean frame-to-frame change of the overall brightness
 *   flick      big jumps of the overall brightness (> 0.035 in a frame) per second that aren't on a hit or an eighth note
 *   spatial    how much of the room lights up within each beat: LEDs reaching 30% of the brightest LED of that beat
 *   riseL/M    build-ups: correlation of each beat's brightness / change with how far into the build-up it is
 *   riseX      build-ups: brightness in the last quarter / the first quarter
 *   follow     calm parts: correlation of each bar's brightness with the music's loudness
 */
function measure(R, S) {
  const { lum, chg, slow, led, N } = R, out = {}, at = t => Math.max(1, Math.min(S.nF - 1, Math.round(t * FPS) - 1));
  for (const role of ROLES) {
    const segs = []; for (const b of S.bars) { if (b.role !== role) continue; const l = segs.at(-1); if (l && Math.abs(l.t1 - b.t0) < 1e-6) l.t1 = b.t1; else segs.push({ t0: b.t0, t1: Math.min(b.t1, S.dur - 0.1) }); }
    if (!segs.length) continue;
    const frames = []; for (const s of segs) for (let f = at(s.t0 + 0.25); f <= at(s.t1); f++) frames.push(f);
    if (frames.length < FPS) continue;
    const inSeg = (t, pad) => segs.some(s => t - pad >= s.t0 && t + pad <= s.t1), m = {};
    const L = frames.map(f => lum[f]), C = frames.map(f => chg[f]);
    m.lum = mean(L); m.act = mean(C); m.drift = mean(frames.map(f => slow[f]));
    const bl = S.bars.map((b, i) => [b, i]).filter(([b]) => b.role === role).map(([b, i]) => { const v = []; for (let f = at(b.t0 + 0.05); f <= at(b.t1 - 0.02); f++) v.push(lum[f]); return { l: mean(v), loud: S.barLoud[i] }; }).filter(x => x.l != null);
    const blm = mean(bl.map(x => x.l)); m.barCV = blm > 1e-4 ? Math.sqrt(mean(bl.map(x => (x.l - blm) ** 2))) / blm : 0; m.barLow = blm > 1e-4 ? pctl(bl.map(x => x.l), 0.1) / med(bl.map(x => x.l)) : 0;
    const win = (t0, t1) => { let mx = -1, mn = 9; for (let f = at(t0); f <= at(t1); f++) { mx = Math.max(mx, lum[f]); mn = Math.min(mn, lum[f]); } return [mx, mn]; };
    const contrast = hits => hits.filter(k => inSeg(k, 0.13)).map(k => { const [pk] = win(k, k + 0.12), [, tr] = win(k - 0.12, k - 1 / FPS); return (pk - tr) / Math.max(1e-3, pk); });
    const kc = contrast(S.kicks); m.kc = kc.length ? med(kc) : null; m.kcP10 = kc.length ? pctl(kc, 0.1) : null;
    if (role === "build") { const sc = contrast(S.snares.filter(s => !S.kicks.some(k => Math.abs(k - s) < 0.01))); m.sc = sc.length ? med(sc) : null; }
    // beat sync: an impulse on each kick (snare in a build-up, the beat grid when there are no drums)
    const hits = role === "build" && S.snares.length ? S.snares : S.kicks.length ? S.kicks : null;
    let hi = 0; const K = frames.map(f => { const t = (f + 1) / FPS; let last;
      if (hits) { while (hi + 1 < hits.length && hits[hi + 1] <= t) hi++; last = hits[hi] <= t ? hits[hi] : -9; } else last = Math.floor(t / S.P) * S.P;
      return Math.exp(-(t - last) / 0.12); });
    hi = 0; m.syncL = corr(L, K); m.syncM = corr(C, K);
    const alive = frames.filter(f => { const ph = (((f + 1) / FPS) / S.P) % 1; return ph >= 0.4 && ph <= 0.95; }).map(f => chg[f]); m.alive = mean(alive);
    let dl = 0, jumps = 0, oi = 0; const O = S.onsets;
    for (const f of frames) { const d = Math.abs(lum[f] - lum[f - 1]), t = (f + 1) / FPS; dl += d;
      if (d > 0.035) { while (oi + 1 < O.length && O[oi + 1] <= t + 0.02) oi++; const near = O.length && t - O[oi] >= -0.02 && t - O[oi] <= 0.06; if (!near) jumps++; } }
    m.dl = dl / frames.length; m.flick = jumps / (frames.length / FPS);
    // spatial: within each beat, how many LEDs reach 30% of that beat's brightest LED
    const cov = [], mx = new Uint8Array(N);
    for (const s of segs) for (let t = Math.ceil((s.t0 + 0.25) / S.P) * S.P; t + S.P <= s.t1; t += S.P) {
      mx.fill(0); for (let f = at(t); f < at(t + S.P); f++) for (let i = 0, j = f * N; i < N; i++, j++) if (led[j] > mx[i]) mx[i] = led[j];
      let top = 0; for (let i = 0; i < N; i++) if (mx[i] > top) top = mx[i];
      if (top < 4) { cov.push(0); continue; } let n = 0; const thr = top * 0.3; for (let i = 0; i < N; i++) if (mx[i] >= thr) n++; cov.push(n / N);
    }
    m.spatial = mean(cov) ?? 0;
    if (role === "build") { // per beat: brightness and change against the position in the build-up
      const pos = [], bL = [], bC = [], rx = [];
      for (const s of segs) { const nb = Math.round((s.t1 - s.t0) / S.P), q = [];
        for (let k = 0; k < nb; k++) { const v = [], c = []; for (let f = at(s.t0 + k * S.P); f < at(s.t0 + (k + 1) * S.P); f++) { v.push(lum[f]); c.push(chg[f]); } pos.push(k / nb); bL.push(mean(v)); bC.push(mean(c)); q.push(mean(v)); }
        const n4 = Math.max(1, Math.floor(nb / 4)); rx.push(mean(q.slice(-n4)) / Math.max(1e-3, mean(q.slice(0, n4)))); }
      m.riseL = corr(pos, bL); m.riseM = corr(pos, bC); m.riseX = mean(rx);
    }
    if (role === "calm") m.follow = corr(bl.map(x => x.l), bl.map(x => x.loud));
    for (const k in m) m[k] = r3(m[k]);
    out[role] = m;
  }
  return out;
}

// ---------------------------------------------------------------- measure every effect on every song (worker threads)
async function measureEffects(ids, log = () => {}) {
  const L = buildLayout(exampleRoom()), songs = [];
  for (const s of makeSongs()) songs.push(await prepare(s));
  const out = {};
  for (const id of ids) {
    const t0 = performance.now(), r = { raw: {}, feel: {} };
    for (const S of songs) { r.raw[S.name] = measure(run(L, S, id, false), S); if (S.feel) r.feel[S.name] = measure(run(L, S, id, true), S); }
    out[id] = r; log(id, performance.now() - t0);
  }
  return out;
}
if (!isMainThread && workerData && workerData.effectScore) {
  const res = await measureEffects(workerData.ids, (id, ms) => parentPort.postMessage({ progress: id, ms }));
  parentPort.postMessage({ done: res });
}
async function measureAll(ids, workers) {
  const W = Math.max(1, Math.min(workers, ids.length)); let n = 0;
  const tick = (id, ms) => { n++; process.stderr.write(`\r  measured ${n}/${ids.length} (${id}, ${(ms / 1000).toFixed(1)} s)      `); };
  if (W === 1) { const r = await measureEffects(ids, tick); process.stderr.write("\n"); return r; }
  const parts = Array.from({ length: W }, (_, k) => ids.filter((_, i) => i % W === k));
  const res = await Promise.all(parts.map(p => new Promise((ok, bad) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { effectScore: true, ids: p } });
    w.on("message", m => { if (m.progress) tick(m.progress, m.ms); if (m.done) ok(m.done); }); w.on("error", bad);
    w.on("exit", c => { if (c) bad(new Error(`worker exited with ${c}`)); });
  })));
  process.stderr.write("\n"); return Object.assign({}, ...res);
}

// ---------------------------------------------------------------- scores and traits
// Every component is 0..1. The scale constants are where an effect stops gaining, set from the spread over all effects
// in a first run so that only the strongest effects reach 1 on each (a first run with gentler constants put two thirds
// of the drop effects above 85 and told them apart badly); the weights say what matters for the role.
const N_ = (v, full) => v == null ? 0 : clamp01(v / full);
// brightness: the director's evening-out can raise an effect at most 3x (gainOf), so an effect darker than a third of
// the part's target (drop 0.34, build ~0.25, calm 0.08) can't reach it and looks dim; full marks from half the target
// (headroom). Very bright effects are fine (they get turned down) unless they blow the room out (lum > 0.5: near white)
const bright = (lum, target) => lum == null ? 0 : clamp01(lum / (target / 2)) * (lum > 0.5 ? clamp01(1 - (lum - 0.5) / 0.3) : 1);
const sync = m => Math.max(0, m.syncL ?? 0, m.syncM ?? 0);
const DROP_W = { kick: 0.22, kickP10: 0.1, kickFeel: 0.04, sync: 0.14, bright: 0.14, steady: 0.04, clean: 0.08, alive: 0.12, spatial: 0.12 };
const BUILD_W = { rise: 0.24, riseX: 0.14, snare: 0.14, bright: 0.12, clean: 0.1, alive: 0.12, spatial: 0.14 };
const CALM_W = { bright: 0.16, smooth: 0.2, clean: 0.1, alive: 0.2, spatial: 0.16, steady: 0.08, follow: 0.1 };
const parts = {
  // the feel layer's pump gives every effect 0.5-0.85 kick contrast, so it counts little and only near the top
  drop: (m, f) => ({ kick: N_(m.kc, 0.7), kickP10: N_(m.kcP10, 0.6), kickFeel: N_((f ? f.kc : m.kc) - 0.45, 0.4), sync: N_(sync(m), 0.85), bright: bright(m.lum, 0.34),
    steady: 1 - clamp01(m.barCV / 0.3), clean: 1 - clamp01(m.flick / 3), alive: N_(m.alive, 0.045), spatial: N_(m.spatial, 0.9) }),
  build: m => ({ rise: N_(Math.max(m.riseL ?? 0, m.riseM ?? 0), 0.85), riseX: N_((m.riseX ?? 1) - 1, 2), snare: N_(m.sc, 0.5), bright: bright(m.lum, 0.25),
    clean: 1 - clamp01(m.flick / 3), alive: N_(m.alive, 0.08), spatial: N_(m.spatial, 0.95) }),
  // calm: gently alive (slow change, not a flicker), smooth (the overall brightness doesn't jump), using the room,
  // following the music's loudness
  calm: m => ({ bright: bright(m.lum, 0.08), smooth: 1 - clamp01((m.dl - 0.001) / 0.01), clean: 1 - clamp01(m.flick / 1), alive: N_(m.drift, 0.06) * (1 - clamp01((m.act - 0.03) / 0.04)),
    spatial: N_(m.spatial, 0.95), steady: 1 - clamp01(m.barCV / 0.3), follow: N_(m.follow, 0.8) }),
};
const W = { drop: DROP_W, build: BUILD_W, calm: CALM_W };
const roleScore = (role, m, f) => { const p = parts[role](m, f); let s = 0; for (const k in W[role]) s += W[role][k] * p[k]; return { score: Math.round(100 * s), parts: p }; };

/** One effect's measurements averaged over the scored songs per role (weighted; kick metrics only where there are kicks). */
function aggregate(meas, songs, role, mode = "raw") {
  const acc = {}, wt = {};
  for (const S of songs) { if (!S.scored) continue; const m = meas[mode][S.name] && meas[mode][S.name][role]; if (!m) continue;
    for (const k in m) if (m[k] != null) { acc[k] = (acc[k] || 0) + m[k] * S.weight; wt[k] = (wt[k] || 0) + S.weight; } }
  const o = {}; for (const k in acc) o[k] = acc[k] / wt[k]; return Object.keys(o).length ? o : null;
}
const ROLE_OF_TAG = { calm: "calm", build: "build", drop: "drop" };

/** Scores and traits for every measured effect. */
export function score(measured, list = builtinEffects()) {
  const songs = makeSongs().map(({ x, ...s }) => s), tag = Object.fromEntries(list.map(e => [e.id, e.tag])), out = {};
  for (const id of Object.keys(measured)) {
    const M = measured[id], r = { tag: tag[id], scores: {}, detail: {} };
    for (const role of ROLES) { const m = aggregate(M, songs, role), f = aggregate(M, songs, role, "feel"); if (!m) { r.scores[role] = 0; continue; }
      const s = roleScore(role, m, f); r.scores[role] = s.score; r.detail[role] = { ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r3(v)])), feelKc: f ? r3(f.kc) : null, parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, r3(v)])) }; }
    // tempo fit: the main role's score on each song alone (build-up effects: the drop score, since only the EDM songs
    // have build-ups), at that song's tempo; the range runs from the best tempo while the score stays within 92% of it
    const main = ROLE_OF_TAG[r.tag] || "drop", fitRole = main === "build" ? "drop" : main, fit = [];
    for (const S of songs) { if (!S.scored || !S.tempoFit) continue; const m = M.raw[S.name] && M.raw[S.name][fitRole]; if (!m) continue; const f = M.feel[S.name] && M.feel[S.name][fitRole];
      fit.push({ bpm: S.bpm, s: roleScore(fitRole, m, f).score }); }
    const byT = []; for (const x of fit) { const e = byT.find(y => y.bpm === x.bpm); if (e) { e.s = Math.max(e.s, x.s); } else byT.push({ ...x }); }
    byT.sort((a, b) => a.bpm - b.bpm);
    let bi = 0; byT.forEach((x, i) => { if (x.s > byT[bi].s) bi = i; }); let lo = bi, hi = bi; const ok = x => x.s >= 0.92 * byT[bi].s;
    while (lo > 0 && ok(byT[lo - 1])) lo--; while (hi < byT.length - 1 && ok(byT[hi + 1])) hi++;
    const tMin = lo === 0 ? 60 : Math.round((byT[lo].bpm + byT[lo - 1].bpm) / 2), tMax = hi === byT.length - 1 ? 180 : Math.round((byT[hi].bpm + byT[hi + 1].bpm) / 2);
    r.tempo = [tMin, tMax]; r.fit = Object.fromEntries(byT.map(x => [x.bpm, x.s]));
    // traits from the drop-like parts with drums (raw): what the effect does when the music is going
    const d = r.detail.drop || {}, c = r.detail.calm || {};
    r.kickDriven = (d.kc ?? 0) >= 0.3 && (d.syncL ?? 0) >= 0.3; // its own brightness jumps on the kick and follows it
    // needs a beat: the same pop song without drums leaves it much darker or much stiller than with them
    const wet = M.raw.pop116, dry = M.raw.pop116dry, lumOf = x => mean(ROLES.map(k => x && x[k] && x[k].lum).filter(v => v != null)), actOf = x => mean(ROLES.map(k => x && x[k] && x[k].act).filter(v => v != null));
    const lr = lumOf(dry) / Math.max(1e-3, lumOf(wet)), ar = actOf(dry) / Math.max(1e-4, actOf(wet));
    // (stiller only counts when it isn't brighter too: loudness-following calm effects like Sunrise or Tide Swell jitter
    // on every drum hit and glide without drums, which is them working; an effect that barely moves either way isn't stiller)
    r.needsBeat = lr < 0.55 || (actOf(wet) > 0.002 && ar < 0.35 && lr < 1);
    r.dry = { lum: r3(lr), act: r3(ar) };
    // busy: how much changes per frame (drop parts, raw); 0.1 of every LED channel per frame (about the busiest 5%) = 1
    r.busy = r3(clamp01((d.act ?? c.act ?? 0) / 0.1));
    // energy: brightness and movement where the music is loud
    const ev = 0.45 * clamp01((d.lum ?? 0) / 0.3) + 0.35 * r.busy + 0.2 * clamp01((d.kc ?? 0) / 0.6);
    r.energyV = r3(ev); r.energy = ev >= 0.5 ? "high" : ev >= 0.28 ? "mid" : "low";
    out[id] = r;
  }
  return out;
}

// the curated automatic picks: the role's own effects (by tag), best first, that score clearly well
const AUTO_N = { drop: [12, 15], build: [6, 8], calm: [6, 8] }, AUTO_MIN = { drop: 60, build: 55, calm: 60 };
// effects left out of the automatic picks whatever they score (none yet; say why when adding one)
const AUTO_EXCLUDE = {};
export function autoPicks(S, list = builtinEffects()) {
  const out = {};
  for (const role of ROLES) { const [lo, hi] = AUTO_N[role];
    const c = list.filter(e => e.tag === role && S[e.id] && !AUTO_EXCLUDE[e.id]).map(e => e.id).sort((a, b) => S[b].scores[role] - S[a].scores[role] || (a < b ? -1 : 1));
    const good = c.filter(id => S[id].scores[role] >= AUTO_MIN[role]); out[role] = (good.length >= lo ? good : c.slice(0, lo)).slice(0, hi); }
  return out;
}

// ---------------------------------------------------------------- output
function ratingsModule(S, auto, list, hash, date) {
  const L = [];
  L.push("// GENERATED by scripts/effect-score.js --write: do not edit by hand. Re-run it after changing effects.js");
  L.push("// (npm test fails while this file is stale: packages/engine/test/ratings.test.js). How the numbers are made:");
  L.push("// docs/internals/effect-ratings.md.");
  L.push(`// effects-hash: ${hash}`);
  L.push(`// generated: ${date}`);
  L.push("//");
  L.push("// RATINGS[id]: drop, build, calm = how good the effect is in that kind of song part, 0..100 (measured on synthetic songs,");
  L.push("// with the right beat grid, through the director); tempo = [min, max] BPM where it looks best; energy = low|mid|high;");
  L.push("// kickDriven = its own brightness jumps on the kick; needsBeat = it goes dark or still without drums; busy = 0..1, how");
  L.push("// much changes per frame. AUTO = the curated automatic picks per role, best first (only effects with that tag).");
  L.push("");
  L.push("export const RATINGS = {");
  for (const e of list) { const r = S[e.id]; if (!r) continue;
    L.push(`  ${JSON.stringify(e.id)}: { drop: ${r.scores.drop}, build: ${r.scores.build}, calm: ${r.scores.calm}, tempo: [${r.tempo[0]}, ${r.tempo[1]}], energy: ${JSON.stringify(r.energy)}, kickDriven: ${r.kickDriven}, needsBeat: ${r.needsBeat}, busy: ${r.busy} },`); }
  L.push("};");
  L.push("");
  L.push("export const AUTO = {");
  for (const role of ROLES) L.push(`  ${role}: [${auto[role].map(x => JSON.stringify(x)).join(", ")}],`);
  L.push("};");
  L.push("");
  L.push("/** The rating of a built-in effect, or null (custom or unknown effects). */");
  L.push("export function rating(id) { return Object.prototype.hasOwnProperty.call(RATINGS, id) ? RATINGS[id] : null; }");
  return L.join("\n") + "\n";
}

const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
function markdown(S, auto, list, info) {
  const L = [], rows = list.filter(e => S[e.id]);
  const line = e => { const r = S[e.id]; return `| ${e.id} | ${e.tag} | ${r.scores.drop} | ${r.scores.build} | ${r.scores.calm} | ${r.tempo[0]}-${r.tempo[1]} | ${r.energy} | ${r.kickDriven ? "yes" : ""} | ${r.needsBeat ? "yes" : ""} | ${r.busy.toFixed(2)} |`; };
  const head = "| Effect | Tag | Drop | Build | Calm | Tempo | Energy | Kick-driven | Needs a beat | Busy |\n|---|---|--:|--:|--:|---|---|---|---|--:|";
  L.push("# Effect ratings", "");
  L.push(`<!-- Generated by scripts/effect-score.js --write on ${info.date}. Edit the script, not this page. -->`, "");
  L.push(`Generated on ${info.date} by \`node scripts/effect-score.js --write\` (${info.n} effects; measuring took ${info.seconds ?? "?"} s). The same numbers are in`);
  L.push("[`packages/engine/src/ratings.js`](../../packages/engine/src/ratings.js) (`RATINGS`, `AUTO`, `rating(id)`, exported from");
  L.push("`@tempolight/engine`). See [director and effects](director-and-effects.md) for how effects are chosen.", "");
  L.push("## How effects are measured", "");
  L.push("Every built-in effect runs on its own (no switching) through the real director and effects on the example room at 60 fps,");
  L.push("over synthetic songs whose beats, kicks, snares and song parts are known: the feel harness' EDM song at 128 and 150 BPM");
  L.push("(intro, build-up, drop, breakdown, build-up, drop), a pop song at 116 BPM (quiet verse, louder chorus, drums), the same");
  L.push("song without drums, a minor ballad at 64 BPM (no drums), hip-hop (88), half-time (140) and drum and bass (174) grooves,");
  L.push("and four-on-the-floor grooves at 90 and 174 BPM (with the EDM and pop songs: a series where only the tempo changes).");
  L.push("The beat grid and the song parts come from the songs' truth, so an effect is judged on what it does with the right");
  L.push("signals; the live analyser supplies the spectrum, waveform and bass level, as in the app. Each effect runs twice: raw");
  L.push("(manual mode, no kick pump, no drop flash, no ambient fill) and with the feel layer at its defaults (a one-effect show in");
  L.push("automatic mode: kick pump, dynamics, variations). Measured per kind of song part:", "");
  L.push("- **kick contrast**: (peak in the 120 ms after a kick - trough in the 120 ms before) / peak, median and 10th percentile, raw and with the feel layer");
  L.push("- **beat sync**: correlation of the brightness, or of how much changes, with an impulse on each kick (snare in build-ups)");
  L.push("- **brightness**: mean (an effect darker than a third of the part's target can't be evened out: the director's gain stops at 3x) and its bar-to-bar change");
  L.push("- **flicker**: big brightness jumps per second that aren't on a hit or an eighth note (strobing that ignores the beat)");
  L.push("- **alive**: how much changes between kicks; **spatial**: how much of the room lights up within each beat");
  L.push("- **build response**: does the brightness or movement rise through the build-up, and does it hit the snare roll");
  L.push("- **calm**: smooth (no jumps), gently moving, uses the room, follows the music's loudness", "");
  L.push("Weights per role (each part 0..1, the score is the weighted sum x 100):", "");
  for (const role of ROLES) L.push(`- ${role}: ${Object.entries(W[role]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push("");
  L.push("Traits: **tempo** is the range of song tempos (the four-on-the-floor series 90, 116, 128, 150, 174; calm effects: 64, 116, 128,");
  L.push("150) where the effect's score (for its own role; build-up effects: the drop score) stays within 92% of its best;");
  L.push("an open end at the slowest or fastest song is 60 or 180; **kick-driven**: raw kick contrast >= 0.3 and beat sync >= 0.3; **needs a beat**: without drums");
  L.push("(the pop song's notes alone) it is less than 55% as bright, or less than 35% as lively and not brighter; **busy**: change per frame, 0.1 = 1; **energy**:");
  L.push("brightness, busyness and kick contrast in drops.", "");
  L.push("## Automatic picks", "");
  L.push("The curated effects automatic mode picks from (only effects with the role's tag that score clearly well, best first):", "");
  for (const role of ROLES) L.push(`- **${role}** (${auto[role].length}): ${auto[role].join(", ")}`);
  L.push("");
  if (info.broken.length) { L.push("## Weak or broken", ""); for (const b of info.broken) L.push(`- **${b.id}** (${b.tag}): ${b.why}`); L.push(""); }
  for (const [title, tagset] of [["Drop effects", ["drop"]], ["Build-up effects", ["build"]], ["Calm effects", ["calm"]], ["Other effects", null]]) {
    const role = tagset ? ROLE_OF_TAG[tagset[0]] : "drop", sel = rows.filter(e => tagset ? tagset.includes(e.tag) : !ROLE_OF_TAG[e.tag]).sort((a, b) => S[b.id].scores[role] - S[a.id].scores[role]);
    if (!sel.length) continue; L.push(`## ${title}`, "", head, ...sel.map(line), "");
  }
  return L.join("\n");
}

/** Effects that are clearly broken or weak for their own role, with why. */
function weak(S, list) {
  const out = [];
  for (const e of list) { const r = S[e.id]; if (!r) continue; const role = ROLE_OF_TAG[e.tag]; if (!role) continue; const d = r.detail[role] || {}, why = [];
    const target = role === "drop" ? 0.34 : role === "build" ? 0.25 : 0.08;
    // dark: even the director's largest lift (3x) leaves it under 60% of the part's target
    if ((d.lum ?? 0) < target / 5) why.push(`dark (mean brightness ${d.lum} in its parts; even lifted 3x it stays under 60% of the ${target} target)`);
    if (role === "drop" && (d.kc ?? 0) < 0.12) why.push(`barely reacts to the kick (raw kick contrast ${d.kc}, ${d.feelKc} with the feel layer)`);
    if (role === "drop" && (d.spatial ?? 0) < 0.15) why.push(`uses little of the room (${Math.round(100 * (d.spatial ?? 0))}% of LEDs per beat)`);
    if (role === "build" && Math.max(d.riseL ?? 0, d.riseM ?? 0) < 0.2 && (d.sc ?? 0) < 0.1) why.push(`doesn't rise with the build-up or hit the snare roll`);
    if (role === "calm" && (d.flick ?? 0) > 1) why.push(`flickers (${d.flick} off-beat jumps per second)`);
    if (why.length) out.push({ id: e.id, tag: e.tag, score: r.scores[role], why: why.join("; ") });
  }
  return out;
}

function report(S, auto, list, broken) {
  const L = [], h = `${pad("effect", 12)} ${pad("tag", 10)} ${lpad("drop", 4)} ${lpad("build", 5)} ${lpad("calm", 4)}  ${pad("tempo", 8)} ${pad("energy", 6)} kick beat ${lpad("busy", 5)}`;
  for (const [title, tg] of [["drop", "drop"], ["build", "build"], ["calm", "calm"], ["other", null]]) {
    const role = tg || "drop", sel = list.filter(e => S[e.id] && (tg ? e.tag === tg : !ROLE_OF_TAG[e.tag])).sort((a, b) => S[b.id].scores[role] - S[a.id].scores[role]);
    if (!sel.length) continue; L.push(`\n${title} effects (by ${role} score):`, h);
    for (const e of sel) { const r = S[e.id]; L.push(`${pad(e.id, 12)} ${pad(e.tag, 10)} ${lpad(r.scores.drop, 4)} ${lpad(r.scores.build, 5)} ${lpad(r.scores.calm, 4)}  ${pad(r.tempo.join("-"), 8)} ${pad(r.energy, 6)} ${pad(r.kickDriven ? "yes" : "", 4)} ${pad(r.needsBeat ? "yes" : "", 4)} ${lpad(r.busy.toFixed(2), 5)}`); }
  }
  L.push("\nAUTO:"); for (const role of ROLES) L.push(`  ${role} (${auto[role].length}): ${auto[role].join(", ")}`);
  if (broken.length) { L.push("\nweak or broken:"); for (const b of broken) L.push(`  ${b.id} (${b.tag}, ${b.score}): ${b.why}`); }
  return L.join("\n");
}

// ---------------------------------------------------------------- main
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (args.includes("--check")) {
    const r = await checkRatings();
    if (r.ok) console.log("ratings.js is up to date with effects.js");
    else { console.error(`ratings.js is stale:\n  ${r.problems.join("\n  ")}\nrun: node scripts/effect-score.js --write`); process.exit(1); }
  } else {
    const t0 = performance.now(), list = builtinEffects(), only = opt("--only"), ids = only ? only.split(",") : list.map(e => e.id);
    if (only && args.includes("--write")) { console.error("--write scores every effect: leave out --only"); process.exit(2); }
    // --save keeps {seconds, effects}: the measurements and how long they took; --from scores them again (with --write too)
    const saved = opt("--from") ? JSON.parse(readFileSync(opt("--from"), "utf8")) : null;
    const measured = saved ? saved.effects || saved : await measureAll(ids, Number(opt("--workers")) || Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length));
    const seconds = saved ? saved.seconds ?? null : Math.round((performance.now() - t0) / 1000);
    if (opt("--save")) writeFileSync(opt("--save"), JSON.stringify({ seconds, effects: measured }));
    const missing = list.filter(e => !measured[e.id]).map(e => e.id);
    if (args.includes("--write") && missing.length) { console.error(`--write needs every effect measured; missing: ${missing.join(", ")}`); process.exit(2); }
    const S = score(measured, list), sel = list.filter(e => S[e.id]), auto = autoPicks(S, sel), broken = weak(S, sel);
    if (args.includes("--json")) { console.log(JSON.stringify({ scores: S, auto, broken }, null, 1)); process.exit(0); }
    console.log(report(S, auto, sel, broken));
    if (args.includes("--write")) {
      const date = new Date().toISOString().slice(0, 10), hash = sourceHash(readFileSync(EFFECTS_FILE, "utf8"), list.map(e => e.id));
      writeFileSync(RATINGS_FILE, ratingsModule(S, auto, list, hash, date));
      writeFileSync(REPORT_FILE, markdown(S, auto, list, { date, n: sel.length, seconds, broken }));
      console.log(`\nwritten: ${path.relative(root, RATINGS_FILE)}, ${path.relative(root, REPORT_FILE)}`);
    }
    console.log(`(measuring took ${seconds ?? "?"} s; scoring ${Math.round((performance.now() - t0) / 1000)} s)`);
  }
}
