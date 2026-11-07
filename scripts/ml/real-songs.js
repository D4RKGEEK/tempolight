#!/usr/bin/env node
// Tempo stability of the DSP live analyser and the BeatNet prototype on real songs that have no beat annotations.
//   node scripts/ml/real-songs.js /path/to/dir-of-22050Hz-mono-wavs
// Per song: the tempo every 0.25 s from 10 s on, folded into 80-160 BPM; "stable" = share within 3% of the most common
// folded tempo; "agree" = share of moments where the two analysers' folded tempos are within 3% of each other.
// Never commit the songs.
import { readdirSync } from "node:fs";
import path from "node:path";
import { readWav } from "./wav.js";
import { LiveAnalyser as DSP } from "../../packages/engine/src/live.js";
import { LiveAnalyser as ML } from "../../packages/engine/src/ml/live-ml.js";

const fold = b => { if (!(b > 0)) return 0; while (b < 80) b *= 2; while (b >= 160) b /= 2; return b; };
function run(A, x, sr) {
  const tr = [], chunk = 512; let cpu = 0;
  for (let i = 0; i < x.length; i += chunk) { const t0 = performance.now(); A.push(x.subarray(i, i + chunk)); cpu += performance.now() - t0;
    const now = (i + chunk) / sr; if (now >= 10 && (!tr.length || now - tr.at(-1).t >= 0.25)) tr.push({ t: now, bpm: fold(A.bpm) }); }
  return { tr, cpu: cpu / (x.length / sr) };
}
function stability(tr) {
  const h = new Map(); for (const s of tr) if (s.bpm) { const k = Math.round(s.bpm); h.set(k, (h.get(k) || 0) + 1); }
  let dom = 0, best = -1; for (const [k] of h) { let c = 0; for (const [k2, v] of h) if (Math.abs(k2 / k - 1) <= 0.03) c += v; if (c > best) { best = c; dom = k; } }
  return { dom, stable: tr.filter(s => s.bpm && Math.abs(s.bpm / dom - 1) <= 0.03).length / tr.length };
}
const dir = process.argv[2]; const rows = [];
for (const f of readdirSync(dir).filter(f => f.endsWith(".wav")).sort()) {
  const { x, sr } = readWav(path.join(dir, f)), d = run(new DSP(sr), x, sr), mA = new ML(sr), m = run(mA, x, sr);
  const sd = stability(d.tr), sm = stability(m.tr);
  const agree = d.tr.filter((s, i) => m.tr[i] && s.bpm && m.tr[i].bpm && Math.abs(s.bpm / m.tr[i].bpm - 1) <= 0.03).length / d.tr.length;
  const row = { song: f.replace(/\.wav$/, ""), sec: Math.round(x.length / sr), dspBpm: sd.dom, dspStable: +sd.stable.toFixed(2), mlBpm: sm.dom, mlStable: +sm.stable.toFixed(2), agree: +agree.toFixed(2), dspCpu: +d.cpu.toFixed(1), mlCpu: +m.cpu.toFixed(1), mlOnlyCpu: +(mA.mlCpu / (x.length / sr)).toFixed(1) };
  rows.push(row); console.log(JSON.stringify(row));
}
const mean = k => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2);
console.log(JSON.stringify({ mean: { dspStable: mean("dspStable"), mlStable: mean("mlStable"), agree: mean("agree"), mlOnlyCpu: mean("mlOnlyCpu") } }));
