// Whole-song analysis: tempo and grid, key, the per-bar fields, sections, the real FFT; and song memory with the newer
// fields, shorter windows and songs played faster or slower.
import test from "node:test";
import assert from "node:assert/strict";
import { preAnalyseCore, LiveAnalyser, memoryEntry, memoryAnalysis, recognise, matchAt, songView } from "../src/index.js";
import { realFFT } from "../src/fft.js";
import { CHORDS, chordOf, barChords, unpackChroma } from "../src/tonal.js";
import { edm, piece, majorPop, voice, pad, pluck, minorBallad } from "./synth.js";
import { longEdm } from "./long-edm.js";

const sr = 22050;
const L128 = longEdm(sr), pre128 = await preAnalyseCore(L128.x, sr);
const onDownbeat = (pre, downs) => pre.bars.filter(b => downs.some(d => Math.abs(d - b.t0) < 0.05)).length / pre.bars.length;
const gridErr = (pre, bpm, dur) => { let mx = 0; for (let t = 0; t < dur - 1; t += 60 / bpm) { const i = Math.round((t - pre.off) / pre.P); mx = Math.max(mx, Math.abs(pre.off + i * pre.P - t)); } return mx * 1000; };

test("tempo: a 2-minute EDM song with long drumless stretches reads at full tempo, as a party song, bars on the downbeats", async () => {
  assert.ok(Math.abs(pre128.bpm - 128) < 0.05, `128 BPM, not half (${pre128.bpm.toFixed(2)})`);
  assert.equal(pre128.style, "party"); assert.equal(pre128.drops.length, 2, `two drops (${pre128.drops})`);
  for (const [i, d] of pre128.drops.entries()) assert.ok(Math.abs(d - L128.truth.parts.filter(p => p.part === "drop")[i].t0) < 0.05, `drop ${i} on time (${d})`);
  assert.ok(onDownbeat(pre128, L128.truth.downbeats) > 0.95, `bars on downbeats: ${onDownbeat(pre128, L128.truth.downbeats)}`);
  assert.equal(pre128.bars[0].state, "calm", "a soft intro is music, not silence");
  for (const bpm of [124, 140]) { const s = longEdm(sr, bpm), p = await preAnalyseCore(s.x, sr);
    assert.ok(Math.abs(p.bpm - bpm) < 0.05 && p.style === "party", `${bpm} BPM: read ${p.bpm.toFixed(2)}, ${p.style}`);
    assert.ok(onDownbeat(p, s.truth.downbeats) > 0.95, `${bpm} BPM: bars on downbeats ${onDownbeat(p, s.truth.downbeats)}`); }
});

test("tempo: a slow groove keeps its tempo (the double-time rule doesn't push real half-time songs)", async () => {
  const p = await preAnalyseCore(piece({ tonic: 4, mode: "minor", bpm: 84, bars: 24, seed: 3, drums: true }, sr).x, sr);
  assert.ok(Math.abs(p.bpm - 84) < 0.2, `84 BPM (${p.bpm.toFixed(2)})`);
});

test("grid: the beat grid drifts by at most 2 ms over a 4-minute song, at tempos that aren't round numbers", async () => {
  for (const bpm of [97.13, 123.37, 128.62]) { const s = piece({ tonic: 4, mode: "minor", bpm, bars: 96, seed: 3, drums: true }, sr), p = await preAnalyseCore(s.x, sr);
    const e = gridErr(p, bpm, s.x.length / sr); assert.ok(e <= 2, `${bpm} BPM: read ${p.bpm.toFixed(3)}, grid off by up to ${e.toFixed(1)} ms`); }
  const e = gridErr(pre128, 128, L128.dur); assert.ok(e <= 2, `the long EDM song: ${e.toFixed(1)} ms`);
});

test("key: the EDM tracks (Am F C G) are A minor, and sound less happy than a major song", async () => {
  const p = await preAnalyseCore(edm(sr).x, sr);
  assert.equal(`${p.key} ${p.mode}`, "A minor"); assert.equal(`${pre128.key} ${pre128.mode}`, "A minor");
  assert.ok(p.mood.valence < 0.6, `valence ${p.mood.valence}`);
});

test("chords: per bar from the chroma, right on nearly every bar", async () => {
  const am = b => ["Am", "F", "C", "G"][b % 4], first = Math.round(pre128.bars[0].t0 / L128.truth.bar);
  const got = pre128.bars.map((b, i) => [b.chord == null ? null : CHORDS[b.chord], am(first + i)]).filter(([c]) => c != null);
  const right = got.filter(([c, w]) => c === w).length; assert.ok(right / got.length >= 0.9, `${right}/${got.length}: ${got.slice(0, 12).map(g => g[0]).join(" ")}`);
  const pop = majorPop(sr), pp = await preAnalyseCore(pop.x, sr), deg = [0, 4, 5, 3, 0, 3, 4, 4], maj = [0, 2, 4, 5, 7, 9, 11];
  const want = b => { const d = deg[b % 8]; return CHORDS[((2 + maj[d]) % 12) * 2 + ([0, 3, 4].includes(d) ? 0 : 1)]; };
  const pr = pp.bars.filter((b, i) => b.chord != null && CHORDS[b.chord] === want(Math.round(b.t0 / (pp.P * 4)))).length;
  assert.ok(pr / pp.bars.length >= 0.9, `pop: ${pr}/${pp.bars.length}`);
  assert.equal(chordOf(Float64Array.from([0, 0, 0.1, 0, 1, 0, 0, 0.9, 0, 0, 0, 1])).chord, "Em"); assert.equal(chordOf(new Float64Array(12)), null);
  // from the stored chroma (5 a second) too, as for songs remembered before chords were kept
  const stored = barChords(unpackChroma(pre128.chroma), 5, pre128.bars), same = stored.filter((c, i) => c === pre128.bars[i].chord).length;
  assert.ok(same / stored.length > 0.85, `stored chroma gives the same chords (${same}/${stored.length})`);
});

test("sections: self-similarity finds the parts, repeated parts get the same label, on the phrase grid", () => {
  const S = pre128.sections, first = Math.round(pre128.bars[0].t0 / L128.truth.bar);
  const cuts = S.slice(1).map(s => s.bar0 + first), truth = L128.truth.parts.slice(1).map(p => p.bar0);
  const found = truth.filter(b => cuts.some(c => Math.abs(c - b) <= 1));
  assert.ok(found.length >= truth.length - 1, `boundaries ${cuts} vs ${truth}`);
  assert.ok(cuts.length <= truth.length + 4, `not too many (${cuts.length})`);
  const drops = S.filter(s => s.state === "drop"); assert.ok(drops.length >= 2 && drops.every(s => s.label === drops[0].label), `the two drops share a label: ${S.map(s => s.label + ":" + s.state).join(" ")}`);
  assert.equal(S[0].bar0, 0); assert.equal(S.at(-1).bar1, pre128.bars.length);
  for (let i = 1; i < S.length; i++) { assert.equal(S[i].bar0, S[i - 1].bar1, "no gaps"); assert.equal(S[i].t0, pre128.bars[S[i].bar0].t0); }
  assert.ok([8, 16].includes(pre128.phrase.len) && pre128.phrase.first >= 0 && pre128.phrase.first < 8, JSON.stringify(pre128.phrase));
});

test("per bar: energy follows the parts, danceability is high in the drops and low in the break, kicks have a strength", () => {
  const part = b => L128.truth.parts.find(p => b.t0 + 0.1 >= p.t0 && b.t0 + 0.1 < p.t1).part, avg = (k, name) => { const v = pre128.bars.filter(b => part(b) === name).map(b => b[k]); return v.reduce((s, x) => s + x, 0) / v.length; };
  assert.ok(avg("energy", "drop") > 2 * avg("energy", "break") && avg("energy", "drop") <= 1, `energy drop ${avg("energy", "drop")}, break ${avg("energy", "break")}`);
  assert.ok(avg("dance", "drop") > 0.8 && avg("dance", "break") < 0.2, `dance drop ${avg("dance", "drop")}, break ${avg("dance", "break")}`);
  assert.equal(pre128.kickStrength.length, pre128.kicks.length); assert.ok(pre128.kickStrength.every(v => v >= 0 && v <= 1));
  assert.ok(pre128.features.dance > 0.4 && pre128.features.dance < 1, `song danceability ${pre128.features.dance}`);
});

test("per bar: a singing voice is flagged, a pad, a plucked guitar and a pop song without a voice aren't", async () => {
  const v = voice(sr, 20).x, p = pad(sr, 20).x, mix = v.map((s, i) => s * 0.8 + p[i] * 0.3);
  const share = async x => { const a = await preAnalyseCore(x, sr); return a.bars.filter(b => b.vocal).length / a.bars.length; };
  assert.ok(await share(mix) > 0.7, "voice over a pad");
  for (const [n, x] of [["pad", p], ["pluck", pluck(sr, 20).x], ["pop", majorPop(sr).x]]) assert.ok(await share(x) < 0.15, n);
});

test("real FFT: the same magnitudes as a plain DFT", () => {
  for (const n of [16, 1024]) { const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9)), out = new Float32Array(n / 2); realFFT(n).mag(x, out);
    let err = 0; for (let k = 0; k < n / 2; k++) { let re = 0, im = 0; for (let i = 0; i < n; i++) { re += x[i] * Math.cos(2 * Math.PI * k * i / n); im -= x[i] * Math.sin(2 * Math.PI * k * i / n); } err = Math.max(err, Math.abs(Math.hypot(re, im) - out[k])); }
    assert.ok(err < 1e-3, `n ${n}: ${err}`); }
});

test("song memory: the newer fields survive saving, older entries without them still work, and an entry stays small", async () => {
  const e = JSON.parse(JSON.stringify(memoryEntry("Long EDM", pre128, "l"))), back = memoryAnalysis(e);
  assert.equal(back.bars.length, pre128.bars.length);
  for (const [i, b] of back.bars.entries()) { const o = pre128.bars[i]; assert.equal(b.chord, o.chord); assert.equal(b.vocal, o.vocal); assert.ok(Math.abs(b.energy - o.energy) < 0.01 && Math.abs(b.dance - o.dance) < 0.01); }
  assert.deepEqual(back.sections.map(s => [s.bar0, s.bar1, s.label, s.state]), pre128.sections.map(s => [s.bar0, s.bar1, s.label, s.state]));
  assert.deepEqual(back.phrase, pre128.phrase); assert.ok(back.kickStrength.every((v, i) => Math.abs(v - pre128.kickStrength[i]) < 0.01));
  const old = { ...e }; for (const k of ["bx", "ks", "sec", "phrase"]) delete old[k];
  const ob = memoryAnalysis(old); assert.equal(ob.kickStrength, undefined); assert.equal(ob.sections, undefined); assert.equal(songView(ob, 40).state, songView(back, 40).state);
  assert.ok(ob.bars.filter(b => b.chord != null).length > ob.bars.length * 0.8, "an old entry with chroma still gets chords");
  const bare = { ...old }; delete bare.ch; assert.ok(memoryAnalysis(bare).bars.every(b => b.chord === undefined));
  // a stretch whose bars were laid out again (no per-bar fields) or sections that don't fit the bars: left out
  const relaid = memoryEntry("x", { ...pre128, bars: pre128.bars.map(b => ({ t0: b.t0 + 0.2, t1: b.t1 + 0.2, state: b.state, level: b.level })) }, "x");
  assert.ok(!relaid.bx && !relaid.sec, "nothing stale is kept");
  const long = await preAnalyseCore(piece({ tonic: 2, mode: "major", bpm: 116, bars: 116, seed: 9, drums: true }, sr).x, sr), size = JSON.stringify(memoryEntry("4 min", long, "m")).length;
  assert.ok(size < 34000, `a 4-minute song is ${size} characters`);
});

// ---- recognition
const speed = (x, r) => { const y = new Float32Array(Math.floor(x.length / r)); for (let i = 0; i < y.length; i++) { const p = i * r, k = Math.floor(p), f = p - k; y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; } return y; };
const lowpass = (x, f0) => { const w = 2 * Math.PI * f0 / sr, c = Math.cos(w), al = Math.sin(w) / 1.414, b0 = (1 - c) / 2, b1 = 1 - c, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al, y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
/** listen once a second from 3 s on; a lock is two matches a second apart that agree (as the runtime does) */
function locks(x, lib, truthId, start, rate = 1, q = a => a.memoryQuery()) { const a = new LiveAnalyser(sr); let prev = null, first = null; const right = [], wrong = [];
  for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); if ((i / 512) % 43 !== 0 || a.t < 3) continue;
    const r = recognise(a.tap.q, lib, q(a));
    if (r && prev && r.id === prev.id && Math.abs(r.pos - (prev.pos + (a.t - prev.t) * rate)) < 0.3) { const ok = r.id === truthId && Math.abs(r.pos - (start + a.t * rate)) < 0.5;
      (ok ? right : wrong).push(`${r.id}@${r.pos.toFixed(1)} (playing ${(start + a.t * rate).toFixed(1)}, rate ${r.rate})`); if (ok && first == null) first = a.t; }
    prev = r ? { ...r, t: a.t } : null; }
  return { right, wrong, first }; }
const sEdm = edm(sr), sPop = majorPop(sr), sMinor = minorBallad(sr);
const LIB = [memoryEntry("EDM", await preAnalyseCore(sEdm.x, sr), "edm"), memoryEntry("Pop", await preAnalyseCore(sPop.x, sr), "pop"), memoryEntry("Minor ballad", await preAnalyseCore(sMinor.x, sr), "minor")];

test("song memory: recognised after 8-9 s of listening (from 6 s windows), not 14", () => {
  for (const [x, id, start] of [[sEdm.x, "edm", 0], [sPop.x, "pop", 10], [sMinor.x, "minor", 20]]) { const r = locks(x.subarray(start * sr), LIB, id, start);
    assert.equal(r.wrong.length, 0, `${id}: ${r.wrong}`); assert.ok(r.first != null && r.first <= 9.5, `${id} from ${start} s: first lock after ${r.first} s`); }
});

test("song memory: a pop song through a 2 kHz low-pass is recognised, even when the live tempo is wrong", () => {
  const x = lowpass(sPop.x, 2000).subarray(10 * sr);
  const r = locks(x, LIB, "pop", 10, 1, a => ({ ...a.memoryQuery(), bpm: 77.5 })); // the tempo heard through a bad speaker: no longer a filter
  assert.ok(r.first != null && !r.wrong.length, `with a wrong tempo: first ${r.first}, wrong ${r.wrong}`);
  for (const bpm of [58, 174, 77.33]) { const a = new LiveAnalyser(sr); for (let i = 0; i < 14 * sr; i += 512) a.push(x.subarray(i, i + 512)); // 1:2, 3:2, 2:3 of 116 fit as well
    const m = recognise(a.tap.q, LIB, { ...a.memoryQuery(), bpm }); assert.ok(m && m.id === "pop" && Math.abs(m.pos - (10 + a.t)) < 0.5, `live tempo ${bpm}: ${JSON.stringify(m)}`); }
});

test("song memory: a song played 3% faster or 4% slower is recognised, with its speed", async () => {
  for (const rate of [1.03, 0.96]) { const r = locks(speed(sEdm.x, rate), LIB, "edm", 0, rate); // sped up like a record: higher too
    assert.ok(r.first != null && r.first <= 15 && !r.wrong.length, `EDM at ${rate}: first ${r.first}, wrong ${r.wrong}, right ${r.right.slice(0, 2)}`);
    assert.ok(r.right.every(s => /rate (0\.9[4-8]|1\.0[2-6])/.test(s)), `the speed comes back: ${r.right.slice(0, 3)}`); }
  // with key lock (a DJ deck): the same song at 3% more tempo, at the same pitch
  const fast = piece({ tonic: 2, mode: "major", bpm: 116 * 1.03, bars: 24, seed: 9, drums: true }, sr), r = locks(fast.x.subarray(10 * sr), LIB, "pop", 10 * 1.03, 1.03);
  assert.ok(r.first != null && !r.wrong.length, `pop with key lock at 1.03: first ${r.first}, wrong ${r.wrong}`);
  const a = new LiveAnalyser(sr), x = speed(sEdm.x, 1.04); for (let i = 0; i < 20 * sr; i += 512) a.push(x.subarray(i, i + 512));
  const pos = a.t * 1.04, at = matchAt(a.tap.q, LIB[0], pos, 0.2, { ...a.memoryQuery(), rate: 1.04 }), at1 = matchAt(a.tap.q, LIB[0], pos, 0.2, a.memoryQuery());
  assert.ok(at.score > at1.score + 0.05 && Math.abs(at.pos - pos) < 0.25, `matchAt follows at the song's speed (${at.score.toFixed(2)} vs ${at1.score.toFixed(2)} at 1)`);
});
