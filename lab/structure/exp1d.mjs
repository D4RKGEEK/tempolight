import { readWav, S, E } from "./lib.mjs";
import fs from "node:fs";
const { LiveAnalyser, preAnalyseCore } = await import(E);
const { x, sr } = readWav(S + "/songs/track2.wav"), meta = JSON.parse(fs.readFileSync(S + "/songs/track2.json")), tk = meta.events.kick;
const a = new LiveAnalyser(sr), all = []; for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); for (const k of a.kicks) if (!all.includes(k)) all.push(k); }
const res = all.map(v => { const n = tk.reduce((p, k) => Math.abs(k - v) < Math.abs(p - v) ? k : p, -99); return v - n; });
console.log("live kick count", all.length, "in drops", all.filter(v => (v > 15 && v < 30) || (v > 45 && v < 60)).length, "residuals (ms):", res.filter(r => Math.abs(r) < 0.3).map(r => Math.round(r * 1000)).sort((p, q) => p - q).join(","));
const pre = await preAnalyseCore(x, sr); const r2 = pre.kicks.map(v => { const n = tk.reduce((p, k) => Math.abs(k - v) < Math.abs(p - v) ? k : p, -99); return v - n; });
console.log("offline kicks", pre.kicks.length, "outside drops", pre.kicks.filter(v => !((v > 14.9 && v < 30.1) || (v > 44.9 && v < 60.1))).length, "residuals", r2.filter(r => Math.abs(r) > 0.05 && Math.abs(r) < 0.3).map(r => Math.round(r * 1000)).join(","));
