import test from "node:test";
import assert from "node:assert/strict";
import { cleanTimeline, rangeAt, brightAt, cuesAt, createCueFirer, createDirector, createEffects, buildLayout, exampleRoom, metronomeView } from "../src/index.js";

const L = buildLayout(exampleRoom()), fx = createEffects(L), effects = new Set(fx.list.map(e => e.id));
const opts = { dur: 60, effects, palettes: fx.palettes };
const avg = col => { const s = [0, 0, 0]; for (let i = 0; i < col.length; i += 3) for (let k = 0; k < 3; k++) s[k] += col[i + k]; return s.map(v => v / (col.length / 3)); };

test("timeline data: validated and tidied, old shows (blocks only) still pass", () => {
  const old = cleanTimeline({ show: [{ t0: 0, t1: 10, effect: "shock", part: "drop" }] }, opts);
  assert.deepEqual(Object.keys(old), ["show"], "fields left out are left alone");
  const c = cleanTimeline({ show: [{ t0: 0, t1: 10.12345, effect: "shock" }], colors: [{ t0: 2, t1: 4, colors: ["#FF0000"] }, { t0: 0, t1: 2, palette: "sunset" }],
    cues: [{ t: "5.5", type: "strobe", beats: 2 }, { t: 1.23456, type: "flash", color: "#00FF00" }], bright: [{ t: 3, v: 0.5 }, { t: 1, v: 1 }] }, opts);
  assert.equal(c.show[0].t1, 10.123, "times kept to the millisecond");
  assert.deepEqual(c.colors.map(x => x.t0), [0, 2], "sorted"); assert.deepEqual(c.colors[1].colors, ["#ff0000", "#ff0000"], "one colour is both");
  assert.deepEqual(c.cues[0], { t: 1.235, type: "flash", color: "#00ff00" }); assert.equal(c.cues[1].beats, 2);
  assert.deepEqual(c.bright.map(k => k.t), [1, 3]);
  const no = b => assert.throws(() => cleanTimeline(b, opts), e => e.code === 400, JSON.stringify(b));
  no({ show: [] }); no({ show: [{ t0: 0, t1: 5, effect: "nope" }] }); no({ show: [{ t0: 0, t1: 5, effect: "shock" }, { t0: 4, t1: 8, effect: "shock" }] });
  no({ colors: [{ t0: 0, t1: 2, palette: "nope" }] }); no({ colors: [{ t0: 0, t1: 2, palette: "auto" }] }); no({ colors: [{ t0: 0, t1: 2, colors: ["red"] }] });
  no({ colors: [{ t0: 0, t1: 2, palette: "fire" }, { t0: 1, t1: 3, palette: "fire" }] }); no({ colors: [{ t0: 70, t1: 72, palette: "fire" }] });
  no({ cues: [{ t: 1, type: "confetti" }] }); no({ cues: [{ t: -1, type: "flash" }] }); no({ cues: [{ t: 1, type: "strobe", color: "#ffffff" }] }); no({ cues: [{ t: 1, type: "strobe", beats: 0 }] });
  no({ bright: [{ t: 1, v: 2 }] }); no({ bright: [{ t: "x", v: 1 }] }); no({ cues: "flash" }); no({ cues: Array.from({ length: 501 }, () => ({ t: 1, type: "flash" })) });
  const long = cleanTimeline({ colors: [{ t0: 50, t1: 900, palette: "fire" }] }, opts); assert.equal(long.colors[0].t1, 61, "clipped to the song");
});

test("timeline lookups: colour block, brightness curve, lasting cues", () => {
  const cols = [{ t0: 0, t1: 2, palette: "fire" }, { t0: 5, t1: 6, palette: "ocean" }];
  assert.equal(rangeAt(cols, 1).palette, "fire"); assert.equal(rangeAt(cols, 3), null); assert.equal(rangeAt(cols, 5).palette, "ocean"); assert.equal(rangeAt([], 1), null);
  const k = [{ t: 2, v: 0 }, { t: 4, v: 1 }];
  assert.equal(brightAt(k, 0), 0); assert.equal(brightAt(k, 3), 0.5); assert.equal(brightAt(k, 9), 1); assert.equal(brightAt([], 3), null);
  const cues = [{ t: 1, type: "strobe", beats: 2 }, { t: 4, type: "build", beats: 8 }, { t: 8, type: "drop" }, { t: 9, type: "blackout", beats: 1 }];
  assert.ok(cuesAt(cues, 1.5, 0.5).strobe); assert.ok(!cuesAt(cues, 2.01, 0.5).strobe, "2 beats at 0.5 s");
  assert.deepEqual(cuesAt(cues, 6, 0.5).build, { t0: 4, t1: 8 }); assert.equal(cuesAt(cues, 8.5, 0.5).drop, 8); assert.ok(cuesAt(cues, 9.2, 0.5).blackout);
});

test("cue firer: each flash fires once, across clock wobbles and seeks", () => {
  const cues = [{ t: 1, type: "flash" }, { t: 3, type: "flash" }, { t: 3.5, type: "strobe" }], F = createCueFirer(), got = [];
  const run = (a, b) => { for (let t = a; t <= b + 1e-9; t += 1 / 60) F.step(cues, t, c => got.push(c.t)); };
  run(0, 2); assert.deepEqual(got, [1], "fires at its time");
  run(0.9, 1.2); assert.deepEqual(got, [1], "the clock jumping back a little doesn't fire it again");
  run(0, 0.5); run(0.5, 1.5); assert.deepEqual(got, [1, 1], "a seek back before it re-arms it");
  F.step(cues, 1.5, () => {}); F.step(cues, 5, c => got.push(c.t)); assert.deepEqual(got, [1, 1], "a seek past a cue skips it");
  F.step(cues, 2.9, () => {}); F.step(cues, 3.1, c => got.push(c.t)); assert.deepEqual(got, [1, 1, 3], "a frame that steps over it still fires it (late by a bit)");
  F.step(cues.slice(), 3.15, c => got.push(c.t)); assert.deepEqual(got, [1, 1, 3], "a new list with the same cues remembers what fired");
});

test("director plays a timeline: flash cues once, blackout, colour blocks, brightness", () => {
  const mk = () => { const D = createDirector(L, fx); Object.assign(D.settings, { mode: "manual", effect: "shock", dropFlash: false }); return D; };
  const D = mk(); D.settings.timeline = { colors: [], cues: [{ t: 1, type: "flash", color: "#0000ff" }, { t: 2, type: "blackout", beats: 1 }], bright: [] };
  for (let t = 0; t < 1.9; t += 1 / 60) D.frame(metronomeView(t, 120), t, {}, 100 + t);
  assert.equal(D.state.cuesFired, 1); assert.deepEqual(D.state.lastCue.type, "flash"); assert.deepEqual(D.state.overlay.flashColor, [0, 0, 1]);
  for (let t = 0.5; t < 1.5; t += 1 / 60) D.frame(metronomeView(t, 120), t, {}, 200 + t); assert.equal(D.state.cuesFired, 2, "seek back: it plays again");
  const dark = D.frame(metronomeView(2.2, 120), 2.2, {}, 300); assert.ok(dark.every(v => v === 0), "blackout for one beat");
  assert.ok(avg(D.frame(metronomeView(2.6, 120), 2.6, {}, 301)).some(v => v > 0.01), "and back after it");
  // colour block: pure red instead of the palette
  const A = mk(), B = mk(); B.settings.timeline = { colors: [{ t0: 0, t1: 10, colors: ["#ff0000", "#ff0000"] }], cues: [], bright: [] };
  let a, b; for (let t = 0; t < 1; t += 1 / 30) { a = avg(A.frame(metronomeView(t, 120), t, {}, t)); b = avg(B.frame(metronomeView(t, 120), t, {}, t)); }
  assert.ok(a[1] + a[2] > 0.02, "the normal palette has green or blue"); assert.ok(b[0] > 0.02 && b[1] + b[2] < b[0] * 0.05, `red only: ${b}`);
  // brightness at 25%
  const C = mk(), E = mk(); E.settings.timeline = { colors: [], cues: [], bright: [{ t: 0, v: 0.25 }] };
  for (let t = 0; t < 1; t += 1 / 30) { a = avg(C.frame(metronomeView(t, 120), t, {}, t)); b = avg(E.frame(metronomeView(t, 120), t, {}, t)); }
  assert.ok(Math.abs(b[0] / a[0] - 0.25) < 0.01, `brightness ${b[0] / a[0]}`);
});

test("director: build-up and drop cues change the song part", () => {
  const D = createDirector(L, fx); D.settings.style = "party"; D.settings.timeline = { colors: [], cues: [{ t: 2, type: "build", beats: 4 }, { t: 4, type: "drop" }], bright: [] };
  const calm = t => ({ ...metronomeView(t, 120), state: "calm", level: "low" });
  D.frame(calm(3), 3, {}, 3); assert.equal(D.state.lastState, "build");
  D.frame(calm(4.1), 4.1, {}, 4.1); assert.equal(D.state.lastState, "drop");
  D.frame(calm(20), 20, {}, 20); assert.equal(D.state.lastState, "calm", "the drop lasts 16 beats");
});
