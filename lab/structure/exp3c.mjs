import { readWav, S, E } from "./lib.mjs";
const { LiveAnalyser, preAnalyseCore, memoryEntry, recognise } = await import(E);
const sr = 22050, t2 = readWav(S + "/songs/track2.wav"), e = memoryEntry("edm2", await preAnalyseCore(t2.x, sr), "edm2");
const biq = (x, f0) => { const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / 1.414, b0 = (1 + c) / 2, b1 = -(1 + c), b2 = b0, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al, y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
for (const st of [0, 26]) { const X = biq(t2.x, 300).subarray(st * sr), a = new LiveAnalyser(sr); let prev = null;
  for (let i = 0; i < X.length; i += 512) { a.push(X.subarray(i, i + 512)); if ((i / 512) % 43 || a.t < 12) continue; const r = recognise(a.tap.q, [e], a.memoryQuery());
    if (r && prev && Math.abs(r.pos - (prev.pos + a.t - prev.t)) < 0.3 && Math.abs(r.pos - (st + a.t)) >= 0.5) console.log(`start ${st}: WRONG lock at pos ${r.pos.toFixed(1)} while playing ${(st + a.t).toFixed(1)} (off ${(r.pos - st - a.t).toFixed(2)} s, score ${r.score.toFixed(2)}, chroma ${r.chroma?.toFixed(2)})`);
    prev = r ? { ...r, t: a.t } : null; } }
