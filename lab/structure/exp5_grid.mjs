import { S, E, readWav } from "./lib.mjs";
const { preAnalyseCore } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050;
function lsq(pre) { let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0; for (const t of pre.kicks) { const k = Math.round((t - pre.off) / pre.P); if (Math.abs(t - (pre.off + k * pre.P)) > 0.05) continue; sx += k; sy += t; sxx += k * k; sxy += k * t; n++; }
  const d = n * sxx - sx * sx; if (n < 8 || !(d > 0)) return null; const P = (n * sxy - sx * sy) / d; return { P, off: (sy - P * sx) / n }; }
const errAt = (g, bpm, dur) => { let mx = 0; for (let tb = 0; tb < dur - 1; tb += 60 / bpm) { const i = Math.round((tb - g.off) / g.P); mx = Math.max(mx, Math.abs(g.off + i * g.P - tb)); } return mx * 1000; };
const cases = [];
for (const bpm of [92, 104, 116, 124, 128, 140, 174]) cases.push([`piece ${bpm} BPM 64 bars`, syn.piece({ tonic: 4, mode: "minor", bpm, bars: 64, seed: 3, drums: true }, sr).x, bpm]);
cases.push(["piece 116 BPM 116 bars (240 s)", syn.piece({ tonic: 2, mode: "major", bpm: 116, bars: 116, seed: 9, drums: true }, sr).x, 116]);
cases.push(["edm()", syn.edm(sr).x, 128]);
const t2 = readWav(S + "/songs/track2.wav"); cases.push(["python EDM", t2.x, 128]);
for (const [n, x, bpm] of cases) { const pre = await preAnalyseCore(x, sr), dur = x.length / sr, f = lsq(pre);
  const want = bpm > 150 ? bpm / 2 : bpm;
  console.log(`${n.padEnd(32)} bpm ${pre.bpm.toFixed(2)} (true ${want}) max grid err ${errAt(pre, want, dur).toFixed(0)} ms` + (f ? ` | after kick LSQ refit: bpm ${(60 / f.P).toFixed(3)} err ${errAt(f, want, dur).toFixed(0)} ms` : "")); }
