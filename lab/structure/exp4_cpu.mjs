import { S, E } from "./lib.mjs";
const { LiveAnalyser, preAnalyseCore, memoryEntry, recognise, matchAt } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050, long = syn.piece({ tonic: 2, mode: "major", bpm: 116, bars: 116, seed: 9, drums: true }, sr).x; // ~240 s
let t0 = performance.now(); const pre = await preAnalyseCore(long, sr); const aMs = performance.now() - t0;
const base = memoryEntry("long", pre, "L"), js = JSON.stringify(base);
console.log(`240 s song: analysis ${(aMs / 1000).toFixed(1)} s (${(240 / aMs * 1000).toFixed(0)}x realtime), entry ${(js.length / 1024).toFixed(0)} kB (fp ${base.fp.length}, ch ${base.ch.length}, env ${base.env.length}, kicks ${JSON.stringify(base.kicks).length})`);
const lib = Array.from({ length: 60 }, (_, i) => ({ ...JSON.parse(js), id: "c" + i }));
for (const [name, x] of [["drums (other song)", syn.piece({ tonic: 2, mode: "major", bpm: 116, bars: 16, seed: 31, drums: true }, sr).x], ["drumless (other song)", syn.minorBallad(sr, 77).x]]) {
  const a = new LiveAnalyser(sr); for (let i = 0; i < 20 * sr; i += 512) a.push(x.subarray(i, i + 512)); const q = a.memoryQuery(); q.bpm = undefined; // worst case: no tempo filter
  t0 = performance.now(); recognise(a.tap.q, lib, q); const cold = performance.now() - t0;
  const reps = 5; t0 = performance.now(); for (let k = 0; k < reps; k++) recognise(a.tap.q, lib, q); const warm = (performance.now() - t0) / reps;
  t0 = performance.now(); for (let k = 0; k < 100; k++) matchAt(a.tap.q, lib[0], 100, 0.2, q); const mA = (performance.now() - t0) / 100;
  console.log(`${name}: recognise over 60 x 240 s: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms (${(warm / 60).toFixed(2)} ms/song); matchAt ${mA.toFixed(3)} ms`);
}
