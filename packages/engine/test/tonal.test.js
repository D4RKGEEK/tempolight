import test from "node:test";
import assert from "node:assert/strict";
import { preAnalyseCore, LiveAnalyser, keyOf, moodName, moodPalette, hearsLabel, packChroma, unpackChroma, memoryEntry, memoryAnalysis, songView,
  createDirector, createEffects, buildLayout, exampleRoom, metronomeView } from "../src/index.js";
import { edm, ballad, piece, minorBallad, majorPop } from "./synth.js";

const sr = 22050;
// test pieces in known keys: drumless ballads and pieces with drums, major and minor, slow and fast
const PIECES = [
  ["F# minor ballad", minorBallad(sr)], ["D major pop", majorPop(sr)], ["A major ballad", { ...ballad(sr), key: "A", mode: "major" }],
  ["C major, no drums", piece({ tonic: 0, mode: "major", bpm: 90, bars: 12, seed: 2 })], ["E minor, drums", piece({ tonic: 4, mode: "minor", bpm: 100, bars: 12, seed: 3, drums: true })],
  ["Bb major, no drums", piece({ tonic: 10, mode: "major", bpm: 72, bars: 12, seed: 4 })], ["G minor, drums", piece({ tonic: 7, mode: "minor", bpm: 128, bars: 12, seed: 6, drums: true })],
  ["Eb major, drums", piece({ tonic: 3, mode: "major", bpm: 104, bars: 12, seed: 12, drums: true })], ["B minor, no drums", piece({ tonic: 11, mode: "minor", bpm: 80, bars: 12, seed: 13 })],
];
const pres = new Map(); for (const [name, s] of PIECES) pres.set(name, await preAnalyseCore(s.x, sr));

test("key: whole-song analysis finds the key and mode of every test piece", () => {
  const got = PIECES.map(([name, s]) => { const p = pres.get(name); return { name, want: `${s.key} ${s.mode}`, got: `${p.key} ${p.mode}`, conf: p.keyConfidence }; });
  const right = got.filter(g => g.want === g.got);
  assert.equal(right.length, got.length, `keys: ${got.map(g => `${g.name} → ${g.got} (${g.conf})`).join("; ")}`);
  assert.ok(got.every(g => g.conf >= 0.3), `confident: ${got.map(g => g.conf).join(", ")}`);
});

test("key: the EDM test track (Am F C G) comes out as A minor or its relative, C major", async () => {
  const p = await preAnalyseCore(edm(sr).x, sr); assert.ok(["A minor", "C major"].includes(`${p.key} ${p.mode}`), `${p.key} ${p.mode}`);
  assert.ok(p.mood.energy > 0.7, `the drop makes it energetic (${p.mood.energy})`);
});

test("mood: sad and calm, happy and energetic, tense, and calm major land in their corners", () => {
  const m = name => pres.get(name).mood;
  const sad = m("F# minor ballad"), happy = m("D major pop"), tense = m("G minor, drums"), calm = m("Bb major, no drums");
  assert.ok(sad.valence < 0.45 && sad.energy < 0.4, `minor ballad ${JSON.stringify(sad)}`); assert.equal(moodName(sad), "melancholic");
  assert.ok(happy.valence > 0.6 && happy.energy > 0.6, `major pop ${JSON.stringify(happy)}`); assert.ok(["happy", "euphoric"].includes(moodName(happy)));
  assert.ok(tense.valence < 0.45 && tense.energy > 0.6, `minor with drums ${JSON.stringify(tense)}`); assert.ok(["tense", "intense"].includes(moodName(tense)));
  assert.ok(calm.valence > 0.55 && calm.energy < 0.4, `major, no drums ${JSON.stringify(calm)}`); assert.equal(moodName(calm), "peaceful");
  assert.equal(hearsLabel("A", "minor", { valence: 0.2, energy: 0.2 }), "A minor · melancholic"); assert.equal(hearsLabel(null, null, null), null);
});

test("key and mood live: a slowly updating estimate that agrees with whole-song analysis", () => {
  let right = 0; const lines = [];
  for (const [name, s] of PIECES) {
    const a = new LiveAnalyser(sr); for (let i = 0; i < s.x.length; i += 512) a.push(s.x.subarray(i, i + 512));
    const k = a.keyEst, V = a.view(), whole = pres.get(name).mood; lines.push(`${name} → ${k?.key} ${k?.mode} ${JSON.stringify(a.mood)}`);
    if (k && `${k.key} ${k.mode}` === `${s.key} ${s.mode}`) right++;
    assert.equal(V.key, k?.key ?? null); assert.ok(a.mood, `${name}: a mood`);
    const near = q => (a.mood[q] >= 0.5) === (whole[q] >= 0.5) || Math.abs(a.mood[q] - whole[q]) < 0.12; // (on the fence either way is fine)
    assert.ok(near("valence"), `${name}: same side of happy/sad live and whole-song (${lines.at(-1)} vs ${JSON.stringify(whole)})`);
    assert.ok(near("energy"), `${name}: same side of calm/energetic (${lines.at(-1)} vs ${JSON.stringify(whole)})`);
  }
  assert.ok(right >= PIECES.length - 1, `live keys right: ${right}/${PIECES.length}: ${lines.join("; ")}`);
  const a = new LiveAnalyser(sr); assert.equal(a.view().mood, null, "nothing heard yet: no mood");
});

test("key profiles and chroma storage", () => {
  const triad = new Float64Array(12); for (const pc of [9, 0, 4]) triad[pc] = 1; triad[11] = 0.4; triad[2] = 0.4; triad[7] = 0.3; triad[5] = 0.3; // A C E with the A minor scale
  const k = keyOf(triad); assert.equal(`${k.key} ${k.mode}`, "A minor"); assert.equal(keyOf(new Float64Array(12)), null);
  const f = new Float32Array(24 * 10).map((_, i) => (i * 37 % 13) / 12), back = unpackChroma(packChroma(f));
  assert.equal(back.length, 10 * 12);
  for (let j = 0; j < 10; j++) { const row = back.subarray(j * 12, j * 12 + 12); assert.ok(Math.abs(Math.max(...row) - 1) < 1e-6, "each frame scaled to a top of 1"); }
  const p = pres.get("F# minor ballad"), e = memoryEntry("Ballad", p, "b");
  assert.equal(e.key, "F#"); assert.equal(e.mode, "minor"); assert.ok(typeof e.ch === "string" && e.ch.length < p.dur * 45, `chroma is compact (${e.ch.length} chars for ${p.dur.toFixed(0)} s)`);
  const back2 = memoryAnalysis(JSON.parse(JSON.stringify(e))); assert.deepEqual(back2.mood, p.mood); assert.equal(songView(back2, 20).key, "F#");
});

test("mood colours: each corner gets its colours, and they stay bright", () => {
  const warm = moodPalette(0.95, 0.95), sad = moodPalette(0.05, 0.05), tense = moodPalette(0.05, 0.95), calm = moodPalette(0.95, 0.05);
  for (const c of warm) assert.ok(c[0] > 0.9 && c[2] < 0.65, `warm ${c}`);
  for (const c of sad) assert.ok(c[2] > 0.8 && c[0] < 0.5 && c[1] < 0.5, `blue/violet ${c}`);
  for (const c of tense) assert.ok(c[0] > 0.6 && c[1] < 0.3, `red/magenta ${c}`);
  for (const c of calm) assert.ok(c[1] > 0.75 && c[0] < 0.7, `teal/green ${c}`);
  for (const c of moodPalette(0.5, 0.5)) assert.ok(Math.max(...c) > 0.85, `a blend isn't dull ${c}`);
});

test("director: the automatic palette follows the mood and crossfades; fixed palettes and moodColours off are untouched", () => {
  const L = buildLayout(exampleRoom()), fx = createEffects(L), D = createDirector(L, fx);
  const view = (t, mood) => ({ ...metronomeView(t, 120), state: "calm", mood });
  const sad = { valence: 0.05, energy: 0.05 }, happy = { valence: 0.95, energy: 0.95 };
  D.settings.mode = "manual"; D.settings.effect = "breath"; // an effect drawn in the palette's colours only
  D.frame(view(0, sad), 0); const start = D.state.moodPal.map(c => c.slice());
  D.frame(view(1, sad), 1); const mid = D.state.moodPal[0].slice();
  for (let t = 1; t < 15; t += 1 / 30) D.frame(view(t, sad), t);
  const target = moodPalette(0.05, 0.05, D.state.palIdx);
  assert.ok(D.state.moodPal.every((c, i) => c.every((v, k) => Math.abs(v - target[i][k]) < 0.02)), "eases to the mood's colours");
  assert.ok(Math.abs(mid[2] - start[0][2]) > 0.01 && Math.abs(mid[2] - target[0][2]) > 0.05, "...gradually, not at once");
  const col = D.frame(view(15, sad), 15); let r = 0, b = 0; for (let i = 0; i < col.length; i += 3) { r += col[i]; b += col[i + 2]; } const sadRatio = b / r; assert.ok(sadRatio > 1.5, `sad: blue light (r ${r.toFixed(1)}, b ${b.toFixed(1)})`);
  for (let t = 15; t < 30; t += 1 / 30) D.frame(view(t, happy), t); const warm = D.frame(view(30, happy), 30); r = 0; b = 0;
  for (let i = 0; i < warm.length; i += 3) { r += warm[i]; b += warm[i + 2]; } assert.ok(r > b * 1.5 && sadRatio > 2 * b / r, `happy: warm light (r ${r.toFixed(1)}, b ${b.toFixed(1)})`);
  D.settings.palette = "ocean"; D.frame(view(31, happy), 31); assert.equal(D.state.moodPal, null, "a fixed palette is used as it is");
  D.settings.palette = "auto"; D.settings.moodColours = false; D.frame(view(32, happy), 32); assert.equal(D.state.moodPal, null, "mood colours off");
  D.settings.moodColours = true; D.frame(view(33, null), 33); assert.ok(D.state.moodPal, "a moment without a mood keeps the colours");
  D.frame(null, 40); assert.equal(D.state.moodPal, null, "nothing playing for a while: back to the usual colours");
  D.settings.palette = "mood"; D.frame(null, 41); assert.ok(D.state.moodPal, "the mood palette chosen outright works with nothing playing too");
  assert.ok(fx.palettes.mood, "the mood palette can be picked");
});
