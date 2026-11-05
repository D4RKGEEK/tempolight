// Chord colours: the palette steps with the chords, on bar lines (at most one step a bar), each chord in a stable
// place; repeated sections get the same colours; live listening estimates the chord with hysteresis.
import test from "node:test";
import assert from "node:assert/strict";
import { preAnalyseCore, buildLayout, exampleRoom, createEffects, createDirector, songView, LiveAnalyser } from "../src/index.js";
import { chordPalette, fifthsFrom, createChordColours } from "../src/colour.js";
import { CHORDS } from "../src/tonal.js";
import { edm, rng } from "./synth.js";
import { feelSong } from "./feel-song.js";

const L = buildLayout(exampleRoom());
const seeded = fn => { const save = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42)); try { return fn(); } finally { Math.random = save; } };
/** Play a whole-song analysis through the director at 60 fps: each colour step (time, chord) and the palette each frame. */
function playSong(pre, dur, setup = () => {}) {
  return seeded(() => {
    const fx = createEffects(L), D = createDirector(L, fx); setup(D); const steps = [], frames = []; let n = 0;
    for (let f = 0; f < dur * 60; f++) { const t = (f + 1) / 60, V = songView(pre, t); D.frame(V, t, {}, t);
      const c = D.state.chords; if (c && c.steps !== n) { n = c.steps; steps.push({ t, chord: c.chord, bar: V.barI }); }
      frames.push({ t, V, pal: D.state.chordPal ? D.state.chordPal.map(x => x.slice()) : null }); }
    return { steps, frames, D };
  });
}

test("chordPalette: each chord a stable place from the key, minor chords darker and cooler", () => {
  const base = [[1, 0.3, 0.1], [0.2, 0.4, 1]], A = 9;
  assert.equal(fifthsFrom(A, A), 0); assert.equal(fifthsFrom(4, A), 1); assert.equal(fifthsFrom(2, A), -1); assert.equal(fifthsFrom(0, A), -3);
  const am = chordPalette(base, CHORDS.indexOf("Am"), A), a = chordPalette(base, CHORDS.indexOf("A"), A);
  assert.deepEqual(chordPalette(base, CHORDS.indexOf("Am"), A), am, "the same chord, the same colours");
  const lum = p => p.flat().reduce((s, v) => s + v, 0), blueShare = p => p.reduce((s, c) => s + c[2] / (c[0] + c[1] + c[2]), 0);
  assert.ok(lum(am) < lum(a), "minor darker"); assert.ok(blueShare(am) > blueShare(a), "minor cooler");
  const prog = ["Am", "F", "C", "G"].map(c => JSON.stringify(chordPalette(base, CHORDS.indexOf(c), A)));
  assert.equal(new Set(prog).size, 4, "Am F C G: four different colourings");
});

test("chord colours: on a song with known chords (edm: Am F C G a bar), steps land on bar lines, one a bar at most", t => {
  const song = edm(22050);
  return preAnalyseCore(song.x, song.sr).then(pre => {
    const dur = song.x.length / song.sr, { steps } = playSong(pre, dur);
    const lines = []; for (let b = 1; b < 18; b++) lines.push(b * song.bar); // the chord changes every bar line
    const near = (x, ts, w) => ts.some(y => Math.abs(x - y) <= w);
    const hit = lines.filter(x => near(x, steps.map(s => s.t), 0.08)).length / lines.length;
    const onLine = steps.filter(s => near(s.t, [0, ...lines], 0.08)).length / steps.length;
    const perBar = new Map(); for (const s of steps) { const b = Math.floor((s.t + 0.05) / song.bar); perBar.set(b, (perBar.get(b) || 0) + 1); }
    t.diagnostic(`chord changes with a colour step on the bar line: ${(hit * 100).toFixed(0)}% (${lines.length}); steps on bar lines ${(onLine * 100).toFixed(0)}%; most steps in a bar ${Math.max(...perBar.values())}`);
    assert.ok(hit >= 0.9, `${(hit * 100).toFixed(0)}% of chord changes step on the bar line`);
    assert.ok(onLine >= 0.95, "steps are on bar lines"); assert.ok(Math.max(...perBar.values()) <= 1, "at most one step a bar");
    // the steps follow the true chords (Am F C G) where the analysis heard them
    const want = ["Am", "F", "C", "G"].map(c => CHORDS.indexOf(c)), right = steps.filter(s => want[Math.floor((s.t + 0.05) / song.bar) % 4] === s.chord).length / steps.length;
    assert.ok(right >= 0.85, `steps to the right chord: ${(right * 100).toFixed(0)}%`);
  });
});

test("chord colours: repeated sections get the same colours; off, or a fixed palette: no chord colours", t => {
  const song = feelSong(22050);
  return preAnalyseCore(song.x, song.sr).then(pre => {
    const secs = pre.sections || [], { frames } = playSong(pre, song.dur), { bar } = song.truth;
    // for each pair of sections with the same label, the same bar in each: the colours a beat and a half in
    const pairs = []; for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) if (secs[i].label === secs[j].label) pairs.push([secs[i], secs[j]]);
    assert.ok(pairs.length >= 1, "the song has a repeated section"); let n = 0, same = 0, worst = 0;
    for (const [a, b] of pairs) for (let k = 0; k < Math.min(a.bar1 - a.bar0, b.bar1 - b.bar0); k++) {
      const fa = frames[Math.round((pre.bars[a.bar0 + k].t0 + 0.6 * bar) * 60)], fb = frames[Math.round((pre.bars[b.bar0 + k].t0 + 0.6 * bar) * 60)];
      if (!fa || !fb || !fa.pal || !fb.pal || fa.V.chord !== fb.V.chord) continue;
      const d = Math.max(...fa.pal.flat().map((v, q) => Math.abs(v - fb.pal.flat()[q]))); worst = Math.max(worst, d); n++; if (d < 0.03) same++; }
    t.diagnostic(`repeated sections: ${same}/${n} bars with the same colours (largest difference ${worst.toFixed(3)})`);
    assert.ok(n >= 4 && same / n >= 0.9, `repeats match: ${same}/${n}`);
    const off = playSong(pre, 20, D => { D.settings.chordColours = false; }), fixed = playSong(pre, 20, D => { D.settings.palette = "neon"; });
    assert.ok(off.frames.every(f => !f.pal) && off.steps.length === 0, "chord colours off");
    assert.ok(fixed.frames.every(f => !f.pal), "a fixed palette keeps its colours");
  });
});

test("chord colours live: the chord from the live chroma, with hysteresis; none when there are no notes", () => {
  const song = edm(22050), an = new LiveAnalyser(song.sr), want = ["Am", "F", "C", "G"].map(c => CHORDS.indexOf(c)), seen = [];
  for (let p = 0; p < song.x.length; p += 368) { an.push(song.x.subarray(p, p + 368)); const V = an.view(), g = an.grid(an.now); seen.push({ t: an.now, chord: V.chord, bar: g.has ? g.idx - g.beatInBar : -1 }); }
  // in the drop (bars 9-15: the beat is locked), from the middle of each bar on: the true chord
  let ok = 0, n = 0; for (let b = 9; b < 16; b++) { const w = seen.filter(s => s.t > (b + 0.6) * song.bar && s.t < (b + 1) * song.bar); n++; if (w.length && w.every(s => s.chord === want[b % 4])) ok++; }
  assert.ok(ok / n >= 0.85, `live chords right in ${ok}/${n} drop bars`);
  // (bars as the analyser counts them: its bar lines may sit a beat or two off the song's while it settles)
  let changes = 0, perBar = new Map(); for (let i = 1; i < seen.length; i++) if (seen[i].chord !== seen[i - 1].chord && seen[i].chord != null) { changes++; const b = seen[i].bar; perBar.set(b, (perBar.get(b) || 0) + 1); }
  assert.ok(changes >= 10 && Math.max(...perBar.values()) <= 1, `one chord change a bar at most (${changes} changes)`);
  // drums only: no chord, so the director keeps today's colours
  const drums = new LiveAnalyser(22050), x = new Float32Array(22050 * 8), r = rng(3);
  for (let k = 0; k < 16; k++) { const i0 = Math.round(k * 0.5 * 22050); let ph = 0; for (let i = 0; i < 8000 && i0 + i < x.length; i++) { const tt = i / 22050; ph += 2 * Math.PI * (45 + 90 * Math.exp(-tt * 28)) / 22050; x[i0 + i] += Math.sin(ph) * Math.exp(-tt * 7) + 0.05 * r() * Math.exp(-tt * 40); } }
  for (let p = 0; p < x.length; p += 368) drums.push(x.subarray(p, p + 368));
  assert.equal(drums.view().chord, null, "no chord from drums");
});

test("chord colours (director): no chord known keeps today's colours; a chord eases in over about a beat", () => {
  const cc = createChordColours(), base = [[1, 0, 0], [0, 0, 1]], g = { has: true, P: 0.5, idx: 0, beatInBar: 0 };
  assert.equal(cc.update({ g, chord: null, barI: 0 }, 0, 0, base, true), null, "no chord: today's palette");
  for (let f = 1; f <= 120; f++) cc.update({ g, chord: null, barI: 0 }, f / 60, f / 60, base, true); // frames at 60 fps
  let p = cc.update({ g, chord: CHORDS.indexOf("G"), barI: 1, key: "C" }, 2, 2, base, true); const first = p.map(c => c.slice());
  for (let f = 1; f <= 30; f++) p = cc.update({ g, chord: CHORDS.indexOf("G"), barI: 1, key: "C" }, 2 + f / 60, 2 + f / 60, base, true);
  const target = chordPalette(base, CHORDS.indexOf("G"), 0), d = (a, b) => Math.max(...a.flat().map((v, i) => Math.abs(v - b.flat()[i])));
  assert.ok(d(first, target) > 0.1 && d(p, target) < 0.05, "eases to the chord's colours within a beat");
  p = cc.update({ g, chord: CHORDS.indexOf("C"), barI: 1, key: "C" }, 2.6, 2.6, base, true);
  assert.equal(cc.state.chord, CHORDS.indexOf("G"), "a second change in the same bar waits for the next bar line");
  cc.update({ g, chord: CHORDS.indexOf("C"), barI: 2, key: "C" }, 4, 4, base, true); assert.equal(cc.state.chord, CHORDS.indexOf("C"));
  assert.equal(cc.update({ g, chord: CHORDS.indexOf("C"), barI: 2 }, 4.1, 4.1, base, false) != null, true, "turned off: eases back");
});
