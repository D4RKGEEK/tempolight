const R = "/home/claude/tempolight/packages/engine";
const E = await import(R + "/src/index.js"); const M = await import(R + "/src/memory.js"); const synth = await import(R + "/test/synth.js");
const sr = 22050, what = process.argv[2];
const song = synth.piece({ tonic: 2, mode: "major", bpm: 120, bars: 90, drums: true }, sr);
if (what === "live") { const L = E.buildLayout([{ type: "line", count: 300, pts: [[1, 1], [15, 1]], dev: "a" }, { type: "line", count: 300, pts: [[1, 4], [15, 4]], dev: "a" }, { type: "circle", count: 100, cx: 8, cy: 6, size: 2, dev: "a" }]);
  const fx = E.createEffects(L), D = E.createDirector(L, fx); for (let rep = 0; rep < 2; rep++) { const A = new E.LiveAnalyser(sr); const step = 368;
  for (let i = 0; i < song.x.length; i += step) { A.push(song.x.subarray(i, i + step)); if (A.t > 5) D.frame(A.view(A.t, { predict: true }), A.t, A.extras()); } } }
if (what === "offline") { for (let k = 0; k < 2; k++) await E.preAnalyseCore(song.x, sr); }
if (what === "recog") { const pre = await E.preAnalyseCore(song.x, sr); const A = new E.LiveAnalyser(sr); for (let i = 0; i < sr * 60; i += 512) A.push(song.x.subarray(i, i + 512));
  const es = []; for (let i = 0; i < 200; i++) es.push(M.memoryEntry("s" + i, pre, "id" + i)); const q = A.tap.q.slice(), qq = A.memoryQuery(); for (let k = 0; k < 15; k++) E.recognise(q, es, qq); }
