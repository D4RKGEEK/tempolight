import { readWav, S, E } from "./lib.mjs";
const { preAnalyseCore, LiveAnalyser, songView } = await import(E);
import fs from "node:fs";
const { x, sr } = readWav(S + "/songs/track2.wav"), meta = JSON.parse(fs.readFileSync(S + "/songs/track2.json"));
const BAR = meta.bar; const truthOf = t => { const b = Math.floor(t / BAR); for (const [n, a, c] of meta.sections) if (b >= a && b < c) return n; return "end"; };
let t0 = performance.now(); const pre = await preAnalyseCore(x, sr); const ms = performance.now() - t0;
console.log(`analysis ${(x.length / sr).toFixed(1)} s audio in ${ms.toFixed(0)} ms (${(x.length / sr / ms * 1000).toFixed(0)}x realtime); bpm ${pre.bpm.toFixed(2)} off ${pre.off.toFixed(3)} barOff ${pre.barOff} style ${pre.style} key ${pre.key} ${pre.mode} mood ${JSON.stringify(pre.mood)}`);
console.log("drops", pre.drops.map(v => v.toFixed(2)), "truth 15.00, 45.00");
console.log("bars:", pre.bars.map(b => `${b.t0.toFixed(1)}:${b.state[0]}`).join(" "));
console.log("truth:", Array.from({ length: 34 }, (_, i) => `${(i * BAR).toFixed(1)}:${truthOf(i * BAR + 0.1)[0]}`).join(" "));
// kicks accuracy
const tk = meta.events.kick; let hit = 0, err = []; for (const k of tk) { const n = pre.kicks.reduce((a, v) => Math.abs(v - k) < Math.abs(a - k) ? v : a, -9); if (Math.abs(n - k) < 0.05) { hit++; err.push(n - k); } }
const fp = pre.kicks.filter(v => !tk.some(k => Math.abs(k - v) < 0.05)).length;
err.sort((a, b) => a - b); console.log(`kicks: ${hit}/${tk.length} found, ${fp} false, median err ${(err[err.length >> 1] * 1000).toFixed(1)} ms`);
// grid vs truth beats
const gerr = []; for (let k = 0; k < 130; k++) { const tb = k * meta.beat, i = Math.round((tb - pre.off) / pre.P); gerr.push(Math.abs(pre.off + i * pre.P - tb)); } console.log(`grid max err ${(Math.max(...gerr) * 1000).toFixed(1)} ms; beat 1 right: ${(((Math.round((0 - pre.off) / pre.P) - pre.barOff) % 4 + 4) % 4) === 0}`);
// live
const a = new LiveAnalyser(sr); let last = null; const tl = [];
for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); const s = a.state; if (s !== last) { tl.push(`${a.t.toFixed(2)}:${s}`); last = s; } }
console.log("live states:", tl.join(" "));
console.log("truth: build 7.5, drop 15.0, break 30.0, build 37.5, drop 45.0, outro 60.0");
