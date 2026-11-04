// Micro-benchmarks for Tempolight hot paths (read-only use of the repo).
const R = "/home/claude/tempolight/packages/engine";
const E = await import(R + "/src/index.js");
const { ChromaTap, songChroma } = await import(R + "/src/tonal.js");
const M = await import(R + "/src/memory.js");
const synth = await import(R + "/test/synth.js");
const now = () => performance.now();
const sr = 22050;
const out = {};
const what = process.argv[2] || "all";

const song = synth.piece({ tonic: 2, mode: "major", bpm: 120, bars: 90, drums: true }, sr); // ~181 s
out.songSeconds = +(song.x.length / sr).toFixed(1);

if (what === "all" || what === "offline") {
  // warm
  await E.preAnalyseCore(song.x.subarray(0, sr * 20), sr);
  let t0 = now(); const pre = await E.preAnalyseCore(song.x, sr); out.preAnalyseMs = Math.round(now() - t0);
  t0 = now(); await songChroma(song.x, sr); out.songChromaMs = Math.round(now() - t0);
  out.offlineBpm = pre.bpm;
}

if (what === "all" || what === "live") {
  // live analyser over the full song as fast as possible, 512-sample chunks (as browser), breakdown by method
  const A = new E.LiveAnalyser(sr);
  const acc = {}; const wrap = (o, n, k) => { const f = o[n]; o[n] = function (...a) { const t = now(); try { return f.apply(this, a); } finally { acc[k] = (acc[k] || 0) + now() - t; } }; };
  const P = E.LiveAnalyser.prototype;
  // warm without wrappers
  const W = new E.LiveAnalyser(sr); for (let i = 0; i < sr * 30; i += 512) W.push(song.x.subarray(i, i + 512));
  let t0 = now(); { const B = new E.LiveAnalyser(sr); for (let i = 0; i < song.x.length; i += 512) B.push(song.x.subarray(i, i + 512)); }
  out.liveWholeSongMs = Math.round(now() - t0);
  const hops = Math.floor(song.x.length / 256);
  out.liveUsPerHop = +((now() - t0) * 1000 / hops).toFixed(1);
  out.liveMsPerAudioSecond = +((now() - t0) / out.songSeconds).toFixed(2);
  for (const n of ["hop", "fft", "vocalHop", "estimateTempo", "sections", "estimateStyle", "estimateMood"]) wrap(P, n, n);
  wrap(ChromaTap.prototype, "frame", "chroma.frame"); wrap(M.FingerprintTap.prototype, "push", "fpTap");
  const B = new E.LiveAnalyser(sr); t0 = now(); for (let i = 0; i < song.x.length; i += 512) B.push(song.x.subarray(i, i + 512)); const tot = now() - t0;
  out.liveBreakdownMsPerAudioSecond = Object.fromEntries([["push(total, wrapped)", tot], ...Object.entries(acc)].map(([k, v]) => [k, +(v / out.songSeconds).toFixed(3)]));
  out.liveBreakdownNote = "hop includes fft/vocal/tempo/sections/style/mood; push includes hop + chroma; wrappers add overhead";
  out.liveBpm = B.bpm;
}

if (what === "all" || what === "fft") {
  // FFT efficiency: current radix-2 complex 1024 vs variants
  const NF = 1024, A = new E.LiveAnalyser(sr); const re = A.re, im = A.im;
  for (let i = 0; i < NF; i++) { re[i] = Math.sin(i * 0.3) + Math.random() * 0.1; im[i] = 0; }
  const N = 20000; let t0 = now(); for (let k = 0; k < N; k++) { A.fft(); } out.fft1024_current_us = +((now() - t0) * 1000 / N).toFixed(2);
  // variant 1: per-stage contiguous twiddles (no strided access) + Float64Array
  const mk = (NF, T) => { const rev = new Uint16Array(NF); for (let i = 0, j = 0; i < NF; i++) { rev[i] = j; let b = NF >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
    const tw = new T(NF * 2); let o = 0; const offs = []; for (let size = 2; size <= NF; size <<= 1) { offs.push(o); const h = size >> 1; for (let q = 0; q < h; q++) { tw[o++] = Math.cos(-2 * Math.PI * q / size); tw[o++] = Math.sin(-2 * Math.PI * q / size); } } return { rev, tw, offs }; };
  function fftC(re, im, NF, { rev, tw, offs }) {
    for (let i = 0; i < NF; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    // first stage (size 2) without multiplies
    for (let s = 0; s < NF; s += 2) { const a = re[s], b = re[s + 1], c = im[s], d = im[s + 1]; re[s] = a + b; re[s + 1] = a - b; im[s] = c + d; im[s + 1] = c - d; }
    let st = 1; for (let size = 4; size <= NF; size <<= 1, st++) { const h = size >> 1, o = offs[st];
      for (let q = 0; q < h; q++) { const c = tw[o + 2 * q], sn = tw[o + 2 * q + 1];
        for (let a = q; a < NF; a += size) { const b = a + h; const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } } }
  }
  for (const [name, T] of [["f32", Float32Array], ["f64", Float64Array]]) {
    const tb = mk(NF, T), r2 = new T(NF), i2 = new T(NF); for (let i = 0; i < NF; i++) { r2[i] = re[i]; }
    t0 = now(); for (let k = 0; k < N; k++) fftC(r2, i2, NF, tb); out[`fft1024_stageTwiddle_${name}_us`] = +((now() - t0) * 1000 / N).toFixed(2);
  }
  // variant 2: real FFT via N/2 complex + split (what the analyser actually needs: real input, N/2+1 bins)
  const H = NF / 2, tbH = mk(H, Float64Array), zr = new Float64Array(H), zi = new Float64Array(H), Xr = new Float64Array(H + 1), Xi = new Float64Array(H + 1);
  const wr = new Float64Array(H), wi = new Float64Array(H); for (let k = 0; k < H; k++) { wr[k] = Math.cos(-2 * Math.PI * k / NF); wi[k] = Math.sin(-2 * Math.PI * k / NF); }
  const x = new Float64Array(NF); for (let i = 0; i < NF; i++) x[i] = re[i];
  function rfft() { for (let i = 0; i < H; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; } fftC(zr, zi, H, tbH);
    Xr[0] = zr[0] + zi[0]; Xi[0] = 0; Xr[H] = zr[0] - zi[0]; Xi[H] = 0;
    for (let k = 1; k < H; k++) { const ar = zr[k], ai = zi[k], br = zr[H - k], bi = -zi[H - k]; const er = (ar + br) / 2, ei = (ai + bi) / 2, or_ = (ai - bi) / 2, oi = -(ar - br) / 2; // O = (Z - conj)/2j
      Xr[k] = er + wr[k] * or_ - wi[k] * oi; Xi[k] = ei + wr[k] * oi + wi[k] * or_; } }
  t0 = now(); for (let k = 0; k < N; k++) rfft(); out.rfft1024_viaHalf_f64_us = +((now() - t0) * 1000 / N).toFixed(2);
  // verify rfft vs current
  for (let i = 0; i < NF; i++) { A.re[i] = x[i]; A.im[i] = 0; } A.fft(); rfft(); let err = 0; for (let k = 0; k <= H; k++) err = Math.max(err, Math.abs(Math.hypot(Xr[k], Xi[k]) - Math.hypot(A.re[k], A.im[k]))); out.rfftMaxAbsErr = +err.toExponential(2);
  // 4096 chroma FFT current-style
  const C = new ChromaTap(sr); for (let i = 0; i < 5000; i++) C.push(Math.sin(i * 0.05));
  const NC = 3000; t0 = now(); for (let k = 0; k < NC; k++) C.frame(); out.chromaFrame4096_us = +((now() - t0) * 1000 / NC).toFixed(1);
  const tb4 = mk(4096, Float64Array), r4 = new Float64Array(4096), i4 = new Float64Array(4096); t0 = now(); for (let k = 0; k < NC; k++) { for (let i = 0; i < 4096; i++) { r4[i] = Math.sin(i); i4[i] = 0; } fftC(r4, i4, 4096, tb4); } out.fft4096_stageTwiddle_f64_us = +((now() - t0) * 1000 / NC).toFixed(1);
}

if (what === "all" || what === "alloc") {
  // allocations per hop: heap growth with GC watched
  const { PerformanceObserver } = await import("node:perf_hooks"); let gcs = 0; const ob = new PerformanceObserver(l => { gcs += l.getEntries().length; }); ob.observe({ entryTypes: ["gc"] });
  const A = new E.LiveAnalyser(sr); for (let i = 0; i < sr * 40; i += 512) A.push(song.x.subarray(i, i + 512));
  const sec = 2, s0 = sr * 40, chunks = []; for (let i = s0; i < s0 + sr * sec; i += 512) chunks.push(song.x.subarray(i, i + 512));
  globalThis.gc && gc(); await new Promise(r => setTimeout(r, 50)); gcs = 0; const h0 = process.memoryUsage().heapUsed;
  for (const c of chunks) A.push(c); const h1 = process.memoryUsage().heapUsed; await new Promise(r => setTimeout(r, 50));
  const hops = sr * sec / 256; out.alloc = { bytesPerAudioSecond: Math.round((h1 - h0) / sec), bytesPerHop: Math.round((h1 - h0) / hops), gcDuring: gcs, note: "heap delta, needs --expose-gc; includes view() not called" };
  // view() + extras() allocation (called once per render frame)
  globalThis.gc && gc(); const v0 = process.memoryUsage().heapUsed; for (let k = 0; k < 600; k++) { A.view(A.t, { predict: true }); A.extras(); } out.alloc.viewBytesPerCall = Math.round((process.memoryUsage().heapUsed - v0) / 600);
}

if (what === "all" || what === "director") {
  const L = E.buildLayout([{ type: "line", count: 300, pts: [[1, 1], [15, 1]], dev: "a" }, { type: "line", count: 300, pts: [[1, 4], [15, 4]], dev: "a" }, { type: "circle", count: 100, cx: 8, cy: 6, size: 2, dev: "a" }]);
  const fx = E.createEffects(L), D = E.createDirector(L, fx), A = new E.LiveAnalyser(sr);
  let frames = 0, dms = 0, vms = 0, ams = 0; const step = Math.round(sr / 60);
  for (let i = 0; i < song.x.length; i += step) { let t = now(); A.push(song.x.subarray(i, i + step)); ams += now() - t; if (A.t < 5) continue;
    t = now(); const V = A.view(A.t, { predict: true }), X = A.extras(); vms += now() - t; t = now(); D.frame(V, A.t, X); dms += now() - t; frames++; }
  out.director700 = { frames, directorMsPerFrame: +(dms / frames).toFixed(3), viewMsPerFrame: +(vms / frames).toFixed(4), analyserMsPerFrame: +(ams / frames).toFixed(3) };
}

if (what === "all" || what === "recog") {
  // recognition cost vs number of remembered songs
  const kinds = [{ tonic: 2, mode: "major", seed: 9 }, { tonic: 7, mode: "minor", seed: 3 }, { tonic: 9, mode: "major", seed: 21 }, { tonic: 4, mode: "minor", seed: 14 }];
  const pres = []; for (const k of kinds) pres.push(await E.preAnalyseCore(synth.piece({ ...k, bpm: 120, bars: 90, drums: true }, sr).x, sr));
  const A = new E.LiveAnalyser(sr); const x = synth.piece({ ...kinds[0], bpm: 120, bars: 90, drums: true }, sr).x; for (let i = 0; i < sr * 60; i += 512) A.push(x.subarray(i, i + 512));
  const q = A.tap.q.slice(), query = A.memoryQuery(); out.recog = {};
  for (const n of [1, 12, 50, 200, 1000]) {
    const entries = []; for (let i = 0; i < n; i++) entries.push(M.memoryEntry("s" + i, pres[i % 4], "id" + i));
    let t0 = now(); E.recognise(q, entries, query); const cold = now() - t0;
    const reps = n >= 200 ? 3 : 10; t0 = now(); let r; for (let k = 0; k < reps; k++) r = E.recognise(q, entries, query); const warm = (now() - t0) / reps;
    // without bpm gate (drumless / no tempo) - worst case
    t0 = now(); E.recognise(q, entries, { chroma: query.chroma, drumless: true }); const nobpm = now() - t0;
    out.recog[n] = { coldMs: +cold.toFixed(1), warmMs: +warm.toFixed(2), perSongUs: +(warm * 1000 / n).toFixed(0), noTempoGateMs: +nobpm.toFixed(1), found: r ? `${r.id}@${r.pos}` : null };
  }
  const e = M.memoryEntry("x", pres[0], "x"); M.matchAt(q, e, 60, 0.2, query); let t0 = now(); for (let k = 0; k < 200; k++) M.matchAt(q, e, 60, 0.2, query); out.matchAtUs = +((now() - t0) * 1000 / 200).toFixed(1);
  out.entryBytes = JSON.stringify(e).length;
}
console.log(JSON.stringify(out, null, 1));
