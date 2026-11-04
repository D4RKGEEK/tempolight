import { S, E } from "./lib.mjs";
const { LiveAnalyser, preAnalyseCore, memoryEntry, recognise, chromaMatch } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050, x0 = syn.majorPop(sr).x, pre = await preAnalyseCore(x0, sr), e = memoryEntry("pop", pre, "pop");
const biq = (x, type, f0, Q = 0.707) => { const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Q); let b0, b1, b2; if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al, y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
console.log("stored bpm", pre.bpm.toFixed(1));
for (const [n, x] of [["clean", x0], ["lp2k", biq(x0, "lp", 2000)]]) { const a = new LiveAnalyser(sr); for (let i = 0; i < 30 * sr; i += 512) a.push(x.subarray(i, i + 512));
  const q = a.memoryQuery(); const r1 = recognise(a.tap.q, [e], q), r2 = recognise(a.tap.q, [e], { ...q, bpm: undefined });
  console.log(n, "live bpm", a.bpm?.toFixed(1), "with bpm:", JSON.stringify(r1), "no bpm:", JSON.stringify(r2), "chroma@truth", chromaMatch(q.chroma, e, a.t)?.toFixed(2)); }
