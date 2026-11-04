// Beat-tracking evaluation harness for Tempolight's LiveAnalyser (read-only use of the repo).
//   node eval.js [--json] [--wav file.wav --truth file.json]
import { readFileSync } from "node:fs";
const { LiveAnalyser } = await import(process.env.LIVE || "/home/claude/tempolight/packages/engine/src/live.js");
import { edm } from "/home/claude/tempolight/packages/engine/test/synth.js";
import { makeSong, SPECS } from "./songs.js";

// ---------------------------------------------------------------- metrics (MIREX-style, simplified)
export function fMeasure(est, ref, tol = 0.07) {
  const used = new Uint8Array(est.length); let hit = 0, j = 0;
  for (const r of ref) { while (j < est.length && est[j] < r - tol) j++; for (let k = j; k < est.length && est[k] <= r + tol; k++) if (!used[k]) { used[k] = 1; hit++; break; } }
  const p = est.length ? hit / est.length : 0, rc = ref.length ? hit / ref.length : 0; return p + rc ? 2 * p * rc / (p + rc) : 0;
}
// continuity-based: a ref beat is correct if an est beat is within 17.5% of the IBI, and the previous est beat matched the previous ref beat
function cml(est, ref) {
  let ok = 0, prevOk = false, best = 0, run = 0;
  for (let i = 1; i < ref.length - 1; i++) {
    const ibi = ref[i + 1] - ref[i], tol = 0.175 * ibi; let e = -1;
    for (let k = 0; k < est.length; k++) if (Math.abs(est[k] - ref[i]) <= tol) { e = k; break; }
    let good = e >= 0; if (good && e > 0) { const ie = est[e] - est[e - 1]; good = Math.abs(ie - (ref[i] - ref[i - 1])) <= tol; }
    if (good) { ok++; run++; best = Math.max(best, run); } else run = 0; prevOk = good;
  }
  const N = Math.max(1, ref.length - 2); return { t: ok / N, c: best / N };
}
function variants(ref) {
  const dbl = []; for (let i = 0; i < ref.length - 1; i++) dbl.push(ref[i], (ref[i] + ref[i + 1]) / 2);
  const off = []; for (let i = 0; i < ref.length - 1; i++) off.push((ref[i] + ref[i + 1]) / 2);
  return [ref, dbl, ref.filter((_, i) => i % 2 === 0), ref.filter((_, i) => i % 2 === 1), off];
}
export function scores(est, ref, from = 5) {
  const R = ref.filter(t => t >= from), E = est.filter(t => t >= from - 0.1);
  const c = cml(E, R), amlt = Math.max(...variants(R).map(v => cml(E, v).t));
  // signed error of matched beats
  const errs = []; for (const r of R) { let b = null; for (const e of E) if (Math.abs(e - r) < 0.07 && (b == null || Math.abs(e - r) < Math.abs(b - r))) b = e; if (b != null) errs.push((b - r) * 1000); }
  const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN, sd = errs.length ? Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / errs.length) : NaN;
  return { F: fMeasure(E, R), CMLt: c.t, AMLt: amlt, errMs: mean, sdMs: sd };
}
// first ref beat that starts a run of >= 8 consecutive ref beats each matched within 70 ms
function lockTime(est, ref, from = 0, n = 8) {
  const R = ref.filter(t => t >= from); let run = 0;
  for (let i = 0; i < R.length; i++) { const ok = est.some(e => Math.abs(e - R[i]) < 0.07); run = ok ? run + 1 : 0; if (run >= n) return R[i - n + 1] - from; }
  return Infinity;
}

// ---------------------------------------------------------------- run the live analyser like the runtime does
export function run(x, sr, opts = {}) {
  const A = new LiveAnalyser(sr), chunk = opts.chunk || 512, trace = [], kicks = [], emittedP = [], emittedIdeal = [], emittedR = [];
  let prevIdx = null, prevIdxI = null, nk = 0, lastKick = -9;
  const lag = () => A.samples / A.sr - A.t; // the analyser's own clock is the frame centre: NF/2 behind the newest sample
  const hop0 = A.hop.bind(A);
  A.hop = () => {
    hop0(); const now = A.samples / A.sr;
    const k = A.kicks.at(-1); if (k != null && k !== lastKick) { lastKick = k; kicks.push({ t: k, at: now }); emittedR.push(now); }
    const g = A.grid(A.t); // predict path: runtime shows the grid at analyser time t (frame centre), so light = beatT + lag
    if (g.has) { if (prevIdx != null && g.idx !== prevIdx) emittedP.push(Math.max(g.beatT + lag(), now)); prevIdx = g.idx; }
    const gi = A.grid(now); // ideal: grid rendered at the newest-sample clock (what a zero-lag renderer would do)
    if (gi.has) { if (prevIdxI != null && gi.idx !== prevIdxI) emittedIdeal.push(Math.max(gi.beatT, now)); prevIdxI = gi.idx; }
    if (!trace.length || now - trace.at(-1).t >= 0.25) trace.push({ t: now, bpm: A.bpm, phase: A.phase });
  };
  for (let i = 0; i < x.length; i += chunk) A.push(x.subarray(i, i + chunk));
  return { A, trace, kicks, emittedP, emittedIdeal, emittedR, lagMs: lag() * 1000 };
}

function kickStats(kicks, truthKicks) {
  const stamp = [], late = []; let tp = 0;
  for (const k of kicks) { let b = null; for (const r of truthKicks) if (Math.abs(k.t - r) < 0.06 && (b == null || Math.abs(k.t - r) < Math.abs(b - r))) b = r; if (b != null) { tp++; stamp.push((k.t - b) * 1000); late.push((k.at - b) * 1000); } }
  const avg = a => a.length ? a.reduce((p, c) => p + c, 0) / a.length : NaN;
  return { recall: truthKicks.length ? tp / truthKicks.length : NaN, precision: kicks.length ? tp / kicks.length : NaN, stampMs: avg(stamp), detectLatencyMs: avg(late) };
}

function tempoStats(trace, trueBpmAt, from = 0) {
  let first = Infinity, octave = 0, wrong = 0, ok = 0, n = 0;
  for (const s of trace) { if (s.t < from) continue; n++; const tb = trueBpmAt(s.t); if (!s.bpm) { wrong++; continue; }
    const r = s.bpm / tb; if (Math.abs(r - 1) < 0.02) { ok++; if (first === Infinity) first = s.t - from; } else if ([0.5, 2, 1.5, 2 / 3, 0.75, 4 / 3].some(m => Math.abs(r / m - 1) < 0.03)) octave++; else wrong++; }
  return { firstOk: first, okFrac: n ? ok / n : 0, octaveFrac: n ? octave / n : 0, wrongFrac: n ? wrong / n : 0 };
}

const f2 = v => Number.isFinite(v) ? v.toFixed(2) : String(v), f0 = v => Number.isFinite(v) ? Math.round(v) : String(v);
export function evaluate(song) {
  const R = run(song.x, song.sr), ref = song.truth.beats;
  const bpmAt = t => { let i = ref.findIndex(b => b > t); if (i <= 0) i = 1; if (i >= ref.length) i = ref.length - 1; return 60 / (ref[i] - ref[i - 1]); };
  const sP = scores(R.emittedP, ref), sI = scores(R.emittedIdeal, ref), sR = scores(R.emittedR, song.truth.kicks.length ? song.truth.kicks : ref);
  const tm = tempoStats(R.trace, bpmAt), ks = kickStats(R.kicks, song.truth.kicks);
  const firstKick = song.truth.kicks[0] ?? 0;
  return { name: song.name, finalBpm: R.A.bpm, predict: sP, ideal: sI, reactiveKicks: sR, tempo: tm, kicks: ks,
    lockFromStart: lockTime(R.emittedP, ref, 0), lockFromFirstKick: lockTime(R.emittedP, ref, firstKick), lagMs: R.lagMs, R };
}

// ---------------------------------------------------------------- main
if (import.meta.url === `file://${process.argv[1]}`) {
  const songs = [];
  const e = edm(22050), eb = []; for (let t = 0; t < e.x.length / e.sr - 0.5; t += 60 / 128) eb.push(t);
  songs.push({ name: "synth.js edm() 128", x: e.x, sr: 22050, truth: { beats: eb, kicks: eb.filter(t => t >= e.dropStart - 1e-6 && t < e.dropStart + 8 * e.bar - 1e-6) } });
  for (const s of SPECS) songs.push(makeSong(s));
  const wi = process.argv.indexOf("--wav");
  if (wi > 0) { songs.length = 0; }
  if (wi > 0 || process.argv.includes("--track2")) { // a WAV (16-bit PCM) + its truth json (edm_track.py format: events.kick, bpm)
    const file = wi > 0 ? process.argv[wi + 1] : new URL("./track2.wav", import.meta.url).pathname, tj = wi > 0 ? process.argv[process.argv.indexOf("--truth") + 1] : new URL("./track2.json", import.meta.url).pathname;
    const buf = readFileSync(file), ch = buf.readUInt16LE(22), sr0 = buf.readUInt32LE(24); let o = 12; while (buf.toString("ascii", o, o + 4) !== "data") o += 8 + buf.readUInt32LE(o + 4); const n = buf.readUInt32LE(o + 4) / 2 / ch;
    // to 22,050 Hz mono by plain decimation (44.1k -> 2x average), as the browser worklet roughly does
    const dec = Math.round(sr0 / 22050), m = Math.floor(n / dec), x = new Float32Array(m);
    for (let i = 0; i < m; i++) { let v = 0; for (let k = 0; k < dec; k++) for (let c = 0; c < ch; c++) v += buf.readInt16LE(o + 8 + ((i * dec + k) * ch + c) * 2); x[i] = v / 32768 / dec / ch; }
    const T = JSON.parse(readFileSync(tj, "utf8")), beats = []; for (let t = 0; t < T.dur - 1; t += T.beat) beats.push(t);
    songs.push({ name: `track2.wav (edm_track.py, ${T.bpm})`, x, sr: 22050, truth: { beats, kicks: T.events.kick } });
  }
  const rows = songs.map(evaluate);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows.map(({ R, ...r }) => r), null, 1)); process.exit(0); }
  console.log(`analyser clock lag behind newest sample: ${f2(rows[0].lagMs)} ms`);
  console.log(["song".padEnd(40), "bpm", "F", "CMLt", "AMLt", "err±sd ms", "F(ideal)", "lock s", "tempoOK", "oct", "kickR/P", "kick lat ms"].join(" | "));
  for (const r of rows) console.log([r.name.padEnd(40), f0(r.finalBpm * 10) / 10, f2(r.predict.F), f2(r.predict.CMLt), f2(r.predict.AMLt), `${f0(r.predict.errMs)}±${f0(r.predict.sdMs)}`, f2(r.ideal.F),
    f2(r.lockFromStart), f2(r.tempo.okFrac), f2(r.tempo.octaveFrac), `${f2(r.kicks.recall)}/${f2(r.kicks.precision)}`, f0(r.kicks.detectLatencyMs)].join(" | "));
}
