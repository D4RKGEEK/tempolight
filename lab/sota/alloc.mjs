import inspector from "node:inspector/promises";
const E = await import("/home/claude/tempolight/packages/engine/src/index.js"); const synth = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050, song = synth.piece({ tonic: 2, mode: "major", bpm: 120, bars: 30, drums: true }, sr);
const A = new E.LiveAnalyser(sr); for (let i = 0; i < sr * 20; i += 512) A.push(song.x.subarray(i, i + 512));
const chunks = []; for (let i = sr * 20; i < sr * 50; i += 512) chunks.push(song.x.subarray(i, i + 512));
const s = new inspector.Session(); s.connect();
await s.post("HeapProfiler.startSampling", { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (const c of chunks) { A.push(c); A.view(A.t, { predict: true }); }
const { profile } = await s.post("HeapProfiler.stopSampling");
const m = new Map(); let tot = 0; (function walk(n) { const self = n.selfSize; tot += self; const k = `${n.callFrame.functionName || "(anon)"}:${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`; m.set(k, (m.get(k) || 0) + self); n.children.forEach(walk); })(profile.head);
console.log("sampled bytes per audio second", Math.round(tot / 30)); [...m].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(Math.round(v / 30) + " B/s", k));
