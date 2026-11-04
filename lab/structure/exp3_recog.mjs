import { readWav, S, E } from "./lib.mjs";
const { LiveAnalyser, preAnalyseCore, memoryEntry, recognise } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050;
const t2 = readWav(S + "/songs/track2.wav");
const songs = { edm2: t2.x, edm: syn.edm(sr).x, pop: syn.majorPop(sr).x, minor: syn.minorBallad(sr).x, ballad: syn.ballad(sr).x };
const LIB = []; for (const [id, x] of Object.entries(songs)) LIB.push(memoryEntry(id, await preAnalyseCore(x, sr), id));
// transforms
const biq = (x, type, f0, Q = 0.707) => { const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q); let b0, b1, b2; if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al, y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
const room = x => { const y = Float32Array.from(x); const r = syn.rng(99); for (const [d, g] of [[0.023, 0.5], [0.041, 0.4], [0.067, 0.3], [0.11, 0.25], [0.17, 0.18], [0.26, 0.12]]) { const k = Math.round(d * sr); for (let i = k; i < y.length; i++) y[i] += x[i - k] * g; }
  let p = 0; for (const v of x) p += v * v; const nrms = Math.sqrt(p / x.length) / Math.sqrt(10); for (let i = 0; i < y.length; i++) y[i] = y[i] * 0.3 + r() * nrms * 1.7 * 0.3; return y; }; // ~10 dB SNR + early reflections
const speed = (x, r) => { const y = new Float32Array(Math.floor(x.length / r)); for (let i = 0; i < y.length; i++) { const p = i * r, k = Math.floor(p), f = p - k; y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; } return y; };
const T = { clean: x => x, quiet: x => x.map(v => v * 0.03), lowpass2k: x => biq(x, "lp", 2000), highpass300: x => biq(x, "hp", 300), room10dB: room, faster3pct: x => speed(x, 1.03) };
function locks(x, truth, start, rate = 1) { const a = new LiveAnalyser(sr); let prev = null, first = null, wrong = 0, right = 0;
  for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); if ((i / 512) % 43 !== 0 || a.t < 12) continue;
    const r = recognise(a.tap.q, LIB, a.memoryQuery());
    if (r && prev && r.id === prev.id && Math.abs(r.pos - (prev.pos + (a.t - prev.t) * rate)) < 0.3) { const ok = r.id === truth && Math.abs(r.pos - (start + a.t * rate)) < 0.5; ok ? right++ : wrong++; if (ok && first == null) first = a.t; }
    prev = r ? { ...r, t: a.t } : null; }
  return { first, right, wrong }; }
const rows = [];
for (const [tn, f] of Object.entries(T)) { const line = [tn.padEnd(12)];
  for (const [id, x0] of Object.entries(songs)) { const X = f(x0), rate = tn === "faster3pct" ? 1.03 : 1, dur = X.length / sr, res = [];
    for (const st of [0, Math.floor(dur * 0.4)]) { const r = locks(X.subarray(Math.floor(st * sr)), id, st * rate, rate); res.push(`${r.first == null ? "--" : r.first.toFixed(0)}${r.wrong ? "!" + r.wrong : ""}`); }
    line.push(`${id}:${res.join("/")}`); }
  console.log(line.join("  ")); }
