#!/usr/bin/env node
// Beat-tracking evaluation of the live analyser (packages/engine/src/live.js), whatever that file is right now.
// Zero dependencies and deterministic: the same code gives the same numbers (except CPU time).
//
// It feeds each song to a LiveAnalyser in 512-sample chunks, as the runtime does, and records the beats the lights
// would show (the beat grid of view(t, {predict: true}) at the analyser clock), the kicks it hears and its tempo.
// Then it scores them against the song's known beats.
//
// Corpus: the synthetic drum songs (packages/engine/test/beat-songs.js), synth.js edm() and majorPop(), and any
// WAV files in test-audio/ (git-ignored) with a JSON next to them: {"beats": [s], "downbeats": [s], "kicks": [s]}
// (downbeats and kicks are optional).
//
//   node scripts/beat-eval.js                     # table of every song and the mean
//   node scripts/beat-eval.js --json              # the same as JSON
//   node scripts/beat-eval.js --song house        # only songs whose name contains "house"
//   node scripts/beat-eval.js --baseline check    # compare with packages/engine/test/baselines/beat.json (exit 1 if worse)
//   node scripts/beat-eval.js --baseline write    # measure and save the baseline (after an intentional improvement)
//   LIVE=path/to/other-live.js node scripts/beat-eval.js   # evaluate a prototype analyser instead
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { edm, majorPop, rng } from "../packages/engine/test/synth.js";
import { makeSong, SPECS } from "../packages/engine/test/beat-songs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE = path.join(root, "packages/engine/test/baselines/beat.json");
export const AUDIO_DIR = path.join(root, "test-audio");
const LIVE_PATH = process.env.LIVE ? path.resolve(process.env.LIVE) : path.join(root, "packages/engine/src/live.js");
const { LiveAnalyser } = await import(pathToFileURL(LIVE_PATH).href);

const TOL = 0.07;   // a shown beat within 70 ms of a true beat is a hit
const FROM = 5;     // F, CMLt, AMLt, tempo and downbeats are scored from 5 s (the analyser needs a few seconds to start)
const CHUNK = 512;  // samples per push at 22,050 Hz (scaled for other rates)

// ---------------------------------------------------------------- metrics (MIREX-style, simplified)
/** F-measure: each true beat matches at most one estimated beat within tol. */
export function fMeasure(est, ref, tol = TOL) {
  const used = new Uint8Array(est.length); let hit = 0, j = 0;
  for (const r of ref) {
    while (j < est.length && est[j] < r - tol) j++;
    for (let k = j; k < est.length && est[k] <= r + tol; k++) if (!used[k]) { used[k] = 1; hit++; break; }
  }
  const p = est.length ? hit / est.length : 0, rc = ref.length ? hit / ref.length : 0;
  return p + rc ? 2 * p * rc / (p + rc) : 0;
}
// continuity: a true beat is correct if an estimated beat is within 17.5% of the beat period and the interval to the
// previous estimated beat matches too. t = all correct beats, c = the longest correct run.
function cml(est, ref) {
  let ok = 0, best = 0, run = 0;
  for (let i = 1; i < ref.length - 1; i++) {
    const tol = 0.175 * (ref[i + 1] - ref[i]); let e = -1;
    for (let k = 0; k < est.length; k++) if (Math.abs(est[k] - ref[i]) <= tol) { e = k; break; }
    let good = e >= 0;
    if (good && e > 0) good = Math.abs((est[e] - est[e - 1]) - (ref[i] - ref[i - 1])) <= tol;
    if (good) { ok++; run++; best = Math.max(best, run); } else run = 0;
  }
  const N = Math.max(1, ref.length - 2); return { t: ok / N, c: best / N };
}
// AMLt also accepts double tempo, half tempo (either phase) and the off-beat
function variants(ref) {
  const dbl = [], off = [];
  for (let i = 0; i < ref.length - 1; i++) { dbl.push(ref[i], (ref[i] + ref[i + 1]) / 2); off.push((ref[i] + ref[i + 1]) / 2); }
  return [ref, dbl, ref.filter((_, i) => i % 2 === 0), ref.filter((_, i) => i % 2 === 1), off];
}
/** First true beat (seconds after `from`) that starts a run of n true beats each with a shown beat within 70 ms. */
export function lockTime(est, ref, from = 0, n = 8) {
  const R = ref.filter(t => t >= from - 1e-9); let run = 0, j = 0;
  for (let i = 0; i < R.length; i++) {
    while (j < est.length && est[j] < R[i] - TOL) j++;
    const ok = j < est.length && Math.abs(est[j] - R[i]) < TOL;
    run = ok ? run + 1 : 0; if (run >= n) return R[i - n + 1] - from;
  }
  return null; // never locked
}
const nearestIdx = (arr, t) => { let b = -1; for (let i = 0; i < arr.length; i++) if (b < 0 || Math.abs(arr[i] - t) < Math.abs(arr[b] - t)) b = i; return b; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sd = a => { const m = mean(a); return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : null; };

// ---------------------------------------------------------------- run the live analyser like the runtime does
/** Feed x to a LiveAnalyser and record what the lights would show. */
export function runLive(x, sr) {
  const savedRandom = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42)); // deterministic even if the analyser uses Math.random
  try { return runLive1(x, sr); } finally { Math.random = savedRandom; }
}
function runLive1(x, sr) {
  const A = new LiveAnalyser(sr), chunk = Math.max(64, Math.round(CHUNK * sr / 22050));
  const shown = [], kicks = [], trace = []; let prevIdx = null, prevNow = 0, lastKick = -Infinity, cpu = 0;
  for (let i = 0; i < x.length; i += chunk) {
    const t0 = performance.now(); A.push(x.subarray(i, Math.min(x.length, i + chunk))); cpu += performance.now() - t0;
    const now = Math.min(x.length, i + chunk) / sr, lag = now - A.t; // the analyser's clock runs a little behind the newest sample
    for (const k of A.kicks) if (k > lastKick) { lastKick = k; kicks.push({ t: k, at: now }); }
    // the runtime shows the grid at the analyser clock: a beat at grid time beatT lights up at beatT + lag
    const g = A.view(A.t, { predict: true }).g;
    if (g && g.has) {
      if (prevIdx != null && g.idx !== prevIdx) shown.push({ t: Math.min(now, Math.max(prevNow, g.beatT + lag)), beatInBar: g.beatInBar });
      prevIdx = g.idx;
    } else prevIdx = null;
    if (!trace.length || now - trace.at(-1).t >= 0.25) trace.push({ t: now, bpm: A.bpm });
    prevNow = now;
  }
  return { shown, kicks, trace, cpuMs: cpu, finalBpm: A.bpm, audioSec: x.length / sr };
}

function tempoStats(trace, ref) {
  const bpmAt = t => { let i = ref.findIndex(b => b > t); if (i <= 0) i = 1; if (i < 0 || i >= ref.length) i = ref.length - 1; return 60 / (ref[i] - ref[i - 1]); };
  let ok = 0, octave = 0, other = 0;
  for (const s of trace) {
    if (s.t < FROM || s.t > ref.at(-1)) continue;
    const r = s.bpm ? s.bpm / bpmAt(s.t) : 0;
    if (Math.abs(r - 1) < 0.02) ok++;
    else if (r && [0.5, 2, 1.5, 2 / 3, 0.75, 4 / 3].some(m => Math.abs(r / m - 1) < 0.03)) octave++;
    else other++;
  }
  const n = ok + octave + other || 1; return { ok: ok / n, octave: octave / n, other: other / n };
}

/** Score one song: {name, x, sr, truth: {beats, downbeats?, kicks?, relock?}}. */
export function evaluate(song) {
  const R = runLive(song.x, song.sr), ref = song.truth.beats, est = R.shown.map(b => b.t);
  const Rf = ref.filter(t => t >= FROM), Ef = est.filter(t => t >= FROM - 0.1);
  const c = cml(Ef, Rf), amlt = Math.max(...variants(Rf).map(v => cml(Ef, v).t));
  const lock = lockTime(est, ref, 0), relock = song.truth.relock != null ? lockTime(est, ref, song.truth.relock) : null;
  // timing error of shown beats once locked (positive = the light is late)
  const errs = []; if (lock != null) for (const r of ref) { if (r < lock) continue; const k = nearestIdx(est, r); if (k >= 0 && Math.abs(est[k] - r) < TOL) errs.push((est[k] - r) * 1000); }
  // downbeats: of the true downbeats that got a shown beat, how many were shown as beat 1 of the bar
  let dbHit = 0, dbN = 0;
  for (const d of song.truth.downbeats || []) { if (d < FROM) continue; const k = nearestIdx(est, d); if (k < 0 || Math.abs(est[k] - d) >= TOL) continue; dbN++; if (R.shown[k].beatInBar === 0) dbHit++; }
  // kicks: the analyser's kick time stamps against the true kicks (60 ms)
  const tk = song.truth.kicks || [], kt = R.kicks.map(k => k.t); let kHit = 0;
  for (const k of kt) { const j = nearestIdx(tk, k); if (j >= 0 && Math.abs(tk[j] - k) < 0.06) kHit++; }
  const kRec = (() => { let h = 0; for (const r of tk) { const j = nearestIdx(kt, r); if (j >= 0 && Math.abs(kt[j] - r) < 0.06) h++; } return h; })();
  const tm = tempoStats(R.trace, ref);
  return {
    name: song.name, source: song.source || "synthetic", finalBpm: r1(R.finalBpm),
    F: r3(fMeasure(Ef, Rf)), CMLt: r3(c.t), AMLt: r3(amlt),
    errMs: r1(mean(errs)), sdMs: r1(sd(errs)), lockS: r2(lock), relockS: r2(relock),
    tempoOk: r3(tm.ok), tempoOctave: r3(tm.octave), tempoOther: r3(tm.other),
    kickRecall: tk.length ? r3(kRec / tk.length) : null, kickPrecision: tk.length && kt.length ? r3(kHit / kt.length) : null,
    downbeat: dbN ? r3(dbHit / dbN) : null, cpuMsPerSec: r2(R.cpuMs / R.audioSec),
  };
}
const rnd = d => v => v == null || !Number.isFinite(v) ? null : Math.round(v * d) / d;
const r1 = rnd(10), r2 = rnd(100), r3 = rnd(1000);

/** The mean over songs (nulls left out); lockNever counts songs that never locked. */
export function summarise(rows) {
  const m = k => r3(mean(rows.map(r => r[k]).filter(v => v != null)));
  const out = {}; for (const k of ["F", "CMLt", "AMLt", "errMs", "sdMs", "lockS", "relockS", "tempoOk", "tempoOctave", "tempoOther", "kickRecall", "kickPrecision", "downbeat", "cpuMsPerSec"]) out[k] = m(k);
  out.lockNever = rows.filter(r => r.lockS == null).length; out.songs = rows.length;
  return out;
}

// ---------------------------------------------------------------- corpus
function readWav(file) {
  const b = readFileSync(file); if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: not a WAV file`);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), len = b.readUInt32LE(o + 4); if (id === "fmt ") fmt = o + 8; if (id === "data") { data = { o: o + 8, len: Math.min(len, b.length - o - 8) }; break; } o += 8 + len + (len & 1); }
  if (fmt == null || !data) throw new Error(`${file}: no fmt or data chunk`);
  let format = b.readUInt16LE(fmt); const ch = b.readUInt16LE(fmt + 2), sr = b.readUInt32LE(fmt + 4), bits = b.readUInt16LE(fmt + 14);
  if (format === 0xfffe) format = b.readUInt16LE(fmt + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
  const bps = bits / 8, n = Math.floor(data.len / bps / ch), x = new Float32Array(n);
  const rd = format === 3 ? (p => bits === 64 ? b.readDoubleLE(p) : b.readFloatLE(p))
    : bits === 16 ? (p => b.readInt16LE(p) / 32768) : bits === 24 ? (p => b.readIntLE(p, 3) / 8388608) : bits === 32 ? (p => b.readInt32LE(p) / 2147483648) : bits === 8 ? (p => (b[p] - 128) / 128) : null;
  if (!rd || (format !== 1 && format !== 3)) throw new Error(`${file}: unsupported WAV (format ${format}, ${bits} bits)`);
  for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < ch; c++) v += rd(data.o + (i * ch + c) * bps); x[i] = v / ch; }
  return { x, sr };
}

/** The corpus as [name, make()] pairs: the synthetic songs (always), then the WAVs in test-audio/ (if any). */
export function corpus({ wavs = true } = {}) {
  const songs = [];
  songs.push(["synth edm() 128", name => {
    const e = edm(22050), eb = []; for (let i = 0; i < 18 * 4; i++) eb.push(i * 60 / 128);
    return { name, x: e.x, sr: e.sr, truth: { beats: eb, downbeats: eb.filter((_, i) => i % 4 === 0), kicks: eb.filter(t => t >= e.dropStart - 1e-6 && t < e.dropStart + 8 * e.bar - 1e-6) } };
  }]);
  songs.push(["synth majorPop() 116", name => {
    const p = majorPop(22050), pb = []; for (let i = 0; i < 24 * 4; i++) pb.push(i * 60 / 116);
    return { name, x: p.x, sr: p.sr, truth: { beats: pb, downbeats: pb.filter((_, i) => i % 4 === 0), kicks: pb } };
  }]);
  for (const s of SPECS) songs.push([s.name, () => makeSong(s)]);
  if (wavs && existsSync(AUDIO_DIR)) for (const f of readdirSync(AUDIO_DIR).filter(f => /\.wav$/i.test(f)).sort()) {
    const tj = path.join(AUDIO_DIR, f.replace(/\.wav$/i, ".json"));
    if (!existsSync(tj)) { console.error(`test-audio/${f}: no ${path.basename(tj)} with the true beats, skipped`); continue; }
    songs.push([`wav ${f}`, name => {
      const T = JSON.parse(readFileSync(tj, "utf8")), w = readWav(path.join(AUDIO_DIR, f));
      if (!Array.isArray(T.beats) || T.beats.length < 8) throw new Error(`test-audio/${path.basename(tj)}: needs "beats": [seconds, ...]`);
      return { name, source: "wav", x: w.x, sr: w.sr, truth: { beats: T.beats, downbeats: T.downbeats, kicks: T.kicks, relock: T.relock ?? null } };
    }]);
  }
  return songs;
}

/** Evaluate every song (optionally filtered by a name substring). */
export function runAll({ song = null, wavs = true } = {}) {
  let songs = corpus({ wavs });
  if (song) songs = songs.filter(([name]) => name.toLowerCase().includes(song.toLowerCase()));
  const rows = songs.map(([name, make]) => evaluate(make(name)));
  return { live: path.relative(root, LIVE_PATH).split(path.sep).join("/"), songs: rows, mean: summarise(rows) };
}

// ---------------------------------------------------------------- baseline
/** Compare a result with a baseline: mean F may drop at most 0.02 and no song's F more than 0.1. */
export function checkBaseline(result, base, { meanDrop = 0.02, songDrop = 0.1 } = {}) {
  const problems = [], notes = [], both = [];
  for (const r of result.songs) {
    const b = base.songs[r.name];
    if (!b) { notes.push(`${r.name}: not in the baseline (F ${r.F})`); continue; }
    both.push([r.F, b.F]);
    if (r.F < b.F - songDrop) problems.push(`${r.name}: F ${r.F} < baseline ${b.F} - ${songDrop}`);
    else if (r.F > b.F + 0.02) notes.push(`${r.name}: F ${b.F} -> ${r.F} (better)`);
  }
  const mNow = mean(both.map(p => p[0])), mBase = mean(both.map(p => p[1]));
  if (both.length && mNow < mBase - meanDrop) problems.push(`mean F ${r3(mNow)} < baseline ${r3(mBase)} - ${meanDrop}`);
  return { ok: !problems.length, problems, notes, meanF: r3(mNow), baseMeanF: r3(mBase) };
}
export function readBaseline(file = BASELINE) { return JSON.parse(readFileSync(file, "utf8")); }
export function baselineOf(result) {
  const songs = {}; for (const r of result.songs) if (r.source !== "wav") { const { name, source, cpuMsPerSec, ...rest } = r; songs[name] = rest; }
  const synth = result.songs.filter(r => r.source !== "wav"), m = summarise(synth); delete m.cpuMsPerSec;
  return { about: "Beat-tracking baseline (scripts/beat-eval.js). Rewrite with: npm run eval:beat -- --baseline write", mean: m, songs };
}

// ---------------------------------------------------------------- real music (no true beats): tempo stability
// TEMPOLIGHT_REAL_AUDIO=/folder/of/wavs: every WAV there is fed to the analyser and its tempo and conf are sampled every
// 0.25 s from 5 s on. Skipped when the variable is unset. The audio stays local: nothing is written.
const foldBpm = b => { if (!(b > 0)) return 0; while (b >= 140) b /= 2; while (b < 70) b *= 2; return b; };
const nearR = (a, b, tol = 0.03) => a > 0 && b > 0 && Math.abs(a / b - 1) <= tol;
/** Tempo stability of a trace [{t, bpm, conf}] sampled every `step` s. */
export function tempoReport(trace, { from = FROM, step = 0.25 } = {}) {
  const T = trace.filter(s => s.t >= from), F = T.map(s => foldBpm(s.bpm));
  // dominant: the octave-folded tempo (70-140) with the most samples within ±3%, then their mean
  let dom = 0, domN = -1; for (const c of F) { if (!c) continue; let n = 0; for (const v of F) if (nearR(v, c)) n++; if (n > domN) { domN = n; dom = c; } }
  { let s = 0, n = 0; for (const v of F) if (nearR(v, dom)) { s += v; n++; } if (n) dom = s / n; }
  const ok = F.map(v => nearR(v, dom)), within = ok.filter(Boolean).length / Math.max(1, F.length);
  // switches: the shown tempo (not folded: x2 counts) leaves the held one by more than 4% for at least 1 s
  let held = 0, away = 0, cand = 0, switches = 0;
  for (const s of T) {
    if (!(s.bpm > 0)) continue; if (!held) { held = s.bpm; continue; }
    if (nearR(s.bpm, held, 0.04)) { away = 0; held += (s.bpm - held) * 0.1; continue; }
    if (!away || !nearR(s.bpm, cand, 0.04)) { cand = s.bpm; away = 0; } away += step;
    if (away >= 1) { switches++; held = s.bpm; away = 0; }
  }
  // stable: folded within ±3% of the dominant for the last 8 s; lock: the start of the first such 8 s
  const win = Math.round(8 / step), stable = ok.map((_, i) => { if (i < win - 1) return false; for (let k = i - win + 1; k <= i; k++) if (!ok[k]) return false; return true; });
  const first = stable.findIndex(Boolean), lockS = first < 0 ? null : Math.max(0, T[first].t - 8);
  // calibration (a reliability diagram without true beats): per conf bin, the share of time and how much of it was stable
  const bins = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.01]].map(([a, b]) => {
    let n = 0, st = 0; T.forEach((s, i) => { const c = s.conf || 0; if (c >= a && c < b) { n++; if (stable[i]) st++; } });
    return { bin: `${a}-${Math.min(1, b)}`, share: r3(n / Math.max(1, T.length)), stable: n ? r3(st / n) : null };
  });
  return { dominant: r1(dom), within: r3(within), switches, lockS: r2(lockS), confHiShare: bins[3].share, confHiStable: bins[3].stable, bins };
}
function realReport(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.wav$/i.test(f)).sort() : [];
  if (!files.length) { console.log(`\nTEMPOLIGHT_REAL_AUDIO=${dir}: no WAV files`); return []; }
  const rows = files.map(f => {
    const w = readWav(path.join(dir, f)), A = new LiveAnalyser(w.sr), chunk = Math.max(64, Math.round(CHUNK * w.sr / 22050)), trace = [];
    for (let i = 0; i < w.x.length; i += chunk) {
      A.push(w.x.subarray(i, Math.min(w.x.length, i + chunk))); const t = Math.min(w.x.length, i + chunk) / w.sr;
      if (!trace.length || t - trace.at(-1).t >= 0.25) trace.push({ t, bpm: A.bpm, conf: A.conf });
    }
    return { name: f, ...tempoReport(trace) };
  });
  console.log("\nreal music (TEMPOLIGHT_REAL_AUDIO): octave-folded tempo stability; stable = within ±3% of the dominant for the last 8 s");
  console.log(["song".padEnd(28), "dominant", "within", "switches", "lock s", "conf>=0.7: time / stable", "  conf bins (time/stable)"].join(" "));
  for (const r of rows) console.log([r.name.slice(0, 28).padEnd(28), String(r.dominant).padEnd(8), `${Math.round(100 * r.within)}%`.padEnd(6), String(r.switches).padEnd(8), (r.lockS == null ? "never" : fx(r.lockS, 1)).padEnd(6),
    `${Math.round(100 * r.confHiShare)}% / ${r.confHiStable == null ? "-" : Math.round(100 * r.confHiStable) + "%"}`.padEnd(24), r.bins.map(b => `${b.bin} ${Math.round(100 * b.share)}/${b.stable == null ? "-" : Math.round(100 * b.stable)}`).join("  ")].join(" "));
  // pooled reliability: over all songs, how often each conf bin was stable
  const pool = [0, 1, 2, 3].map(k => { let n = 0, s = 0; for (const r of rows) { const b = r.bins[k]; n += b.share; s += b.share * (b.stable ?? 0); } return `${rows[0].bins[k].bin}: ${n ? Math.round(100 * s / n) : "-"}% stable`; });
  console.log(`pooled: ${pool.join(", ")}`);
  return rows;
}

// ---------------------------------------------------------------- main
const fmt = v => v == null ? "-" : typeof v === "number" ? String(v) : v;
const fx = (v, d = 2) => v == null ? "-" : v.toFixed(d);
function table(res) {
  const cols = [["song", 38], ["bpm", 6], ["F", 5], ["CMLt", 5], ["AMLt", 5], ["err±sd ms", 10], ["lock s", 6], ["relock", 6], ["tempo ok/oct/oth", 16], ["kick R/P", 9], ["downbt", 6], ["cpu ms/s", 8]];
  const line = v => v.map((s, i) => String(s).padEnd(cols[i][1])).join(" ");
  const row = r => line([r.name.slice(0, 38), fmt(r.finalBpm), fx(r.F), fx(r.CMLt), fx(r.AMLt), r.errMs == null ? "-" : `${Math.round(r.errMs)}±${Math.round(r.sdMs)}`,
    r.lockS == null ? (r.lockNever != null ? `${r.lockNever} never` : "never") : fx(r.lockS, 1), fx(r.relockS, 1), `${fx(r.tempoOk)}/${fx(r.tempoOctave)}/${fx(r.tempoOther)}`,
    `${fx(r.kickRecall)}/${fx(r.kickPrecision)}`, fx(r.downbeat), fx(r.cpuMsPerSec, 1)]);
  console.log(`live analyser: ${res.live}`);
  console.log(line(cols.map(c => c[0]))); console.log("-".repeat(130));
  for (const r of res.songs) console.log(row(r));
  console.log("-".repeat(130)); console.log(row({ name: `MEAN (${res.mean.songs} songs; lock = mean of locked)`, finalBpm: null, ...res.mean }));
  if (res.mean.lockNever) console.log(`${res.mean.lockNever} song(s) never locked.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const mode = opt("--baseline");
  if (mode && !["write", "check"].includes(mode)) { console.error("--baseline write|check"); process.exit(2); }
  if (mode === "write" && opt("--song")) { console.error("--baseline write measures every song: leave out --song"); process.exit(2); }
  const t0 = performance.now(), res = runAll({ song: opt("--song") });
  if (!res.songs.length) { console.error("no song matches"); process.exit(2); }
  let chk = null;
  if (mode === "write") { mkdirSync(path.dirname(BASELINE), { recursive: true }); writeFileSync(BASELINE, JSON.stringify(baselineOf(res), null, 1) + "\n"); }
  if (mode === "check") chk = checkBaseline(res, readBaseline());
  if (args.includes("--json")) console.log(JSON.stringify(chk ? { ...res, baseline: chk } : res, null, 1));
  else {
    table(res);
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    if (mode === "write") console.log(`baseline written: ${path.relative(root, BASELINE)}`);
    if (chk) {
      console.log(chk.meanF == null ? "\nbaseline check: none of these songs is in the baseline" : `\nbaseline check: mean F ${chk.meanF} (baseline ${chk.baseMeanF}) ${chk.ok ? "OK" : "WORSE"}`);
      for (const p of chk.problems) console.log(`  FAIL ${p}`); for (const n of chk.notes) console.log(`  note ${n}`);
    }
    if (process.env.TEMPOLIGHT_REAL_AUDIO) realReport(path.resolve(process.env.TEMPOLIGHT_REAL_AUDIO));
  }
  if (chk && !chk.ok) process.exit(1);
}
