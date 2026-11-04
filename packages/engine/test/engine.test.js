import { test } from "node:test";
import assert from "node:assert/strict";
import { edm } from "./synth.js";
import { buildLayout, exampleRoom, createEffects, metronomeView, buildSignals, segmentRanges, toRGB8, preAnalyseCore } from "../src/index.js";

const layout = buildLayout(exampleRoom());
const fx = createEffects(layout);

test("example room builds 710 LEDs with sane coordinates", () => {
  assert.equal(layout.N, 710);
  for (let i = 0; i < layout.N; i++) {
    assert.ok(layout.PY[i] >= 0 && layout.PY[i] <= 1, "PY in 0..1");
    assert.ok(layout.LD[i] >= 0 && layout.LD[i] <= 1.0001, "LD in 0..1");
  }
});

test("all 95 effects render finite colours on every LED", () => {
  assert.equal(fx.list.length, 95);
  const col = new Float32Array(layout.N * 3);
  for (const e of fx.list) {
    for (const t of [0.05, 3.3, 7.77, 15.01]) {
      const S = buildSignals(metronomeView(t, 128), t, { pal: fx.palettes.neon, fixed: true });
      fx.render(e.id, S, col);
      for (let i = 0; i < col.length; i++) assert.ok(Number.isFinite(col[i]) && col[i] >= 0, `${e.id} produced ${col[i]} at t=${t}`);
    }
  }
});

test("performance budget: every effect renders 1,000 LEDs in under 4 ms", () => {
  const big = buildLayout([{ type: "line", count: 600, pts: [[0.5, 1], [15.5, 1]], dev: "a" }, { type: "circle", count: 400, cx: 8, cy: 5, size: 2.5, dev: "a" }]);
  const f = createEffects(big), col = new Float32Array(big.N * 3);
  for (const e of f.list) {
    let total = 0;
    for (let k = 0; k < 40; k++) { const t = k / 60, S = buildSignals(metronomeView(t, 128), t, { pal: f.palettes.neon, fixed: true });
      const s0 = performance.now(); f.render(e.id, S, col); if (k >= 10) total += performance.now() - s0; }  // first 10 frames warm up the JIT
    const avg = total / 30;
    assert.ok(avg < 4 * (process.env.CI ? 3 : 1), `${e.id} took ${avg.toFixed(2)} ms per frame`);
  }
});

test("segments continue on each controller unless a start is given", () => {
  const r = segmentRanges([{ dev: "A", count: 100 }, { dev: "A", count: 50 }, { dev: "B", count: 10 }, { dev: "A", count: 20, from: 400 }]);
  assert.deepEqual(r.map(x => [x.start, x.end]), [[0, 99], [100, 149], [0, 9], [400, 419]]);
});

test("toRGB8 clamps and rolls off", () => {
  const out = toRGB8(new Float32Array([0, 0.5, 5, -1]));
  assert.equal(out[0], 0); assert.ok(out[1] > 100 && out[1] < 200); assert.equal(out[2], 255); assert.equal(out[3], 0);
});

test("analysis finds tempo, the drop and the style in a synthetic EDM track", async () => {
  const song = edm();
  const r = await preAnalyseCore(song.x, song.sr);
  assert.ok(Math.abs(r.bpm - song.bpm) < 1.5, `bpm ${r.bpm}`);
  assert.ok(r.drops.some(d => Math.abs(d - song.dropStart) < song.bar / 2), `drops at ${r.drops.map(d => d.toFixed(2))}, expected near ${song.dropStart.toFixed(2)}`);
  assert.equal(r.style, "party");
});

test("v0.3 effects react the way they should", async () => {
  const { metronomeView, buildSignals } = await import("../src/index.js");
  const L = buildLayout(exampleRoom()), F = createEffects(L), out = new Float32Array(L.N * 3);
  const sig = (t, extra = {}) => ({ ...buildSignals(metronomeView(t, 120), t, { pal: F.palettes.neon, fixed: true }), ...extra });
  const mean = (id, S) => { F.render(id, S, out); return out.reduce((a, b) => a + b, 0) / out.length; };
  const frame = (id, S) => { F.render(id, S, out); return Float32Array.from(out); };
  // Lighthouse: the beam is somewhere else half a bar later
  const a = frame("lighthouse", sig(10)), b = frame("lighthouse", sig(11));
  let diff = 0; for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]); assert.ok(diff / a.length > 0.02, "lighthouse beam moves");
  // Drop Rewind: the moment after a drop is much brighter than the pull-in before it
  assert.ok(mean("rewind", sig(5, { sinceDrop: 0.05, dropIn: 99 })) > mean("rewind", sig(5, { sinceDrop: 99, dropIn: 1 })), "drop explodes");
  // Box Breathing: full after breathing in (6 s), nearly empty after breathing out (14 s)
  assert.ok(mean("boxbreath", sig(6)) > 2 * mean("boxbreath", sig(14)), "box breathing fills and empties");
  // Spectrum Rings follow the spectrum
  const loud = new Float32Array(24).fill(0.9), quiet = new Float32Array(24).fill(0.05);
  assert.ok(mean("specrings", sig(3, { bands: loud })) > 3 * mean("specrings", sig(3, { bands: quiet })), "spectrum rings react");
});

test("Text Scroller writes readable letters on a matrix", async () => {
  const { metronomeView, buildSignals } = await import("../src/index.js");
  const L = buildLayout([{ type: "matrix", name: "Panel", cols: 32, rows: 8, cx: 8, cy: 4.5, w: 6.4, h: 1.6, dev: "d" }]), F = createEffects(L), out = new Float32Array(L.N * 3);
  const S = { ...buildSignals(metronomeView(0, 120), 0, { pal: F.palettes.neon, fixed: true }), text: "I", t: 32 / 8 }; // scrolled so the I sits at column 0
  F.render("text", S, out);
  const lit = []; for (let i = 0; i < L.N; i++) if (out[i * 3] + out[i * 3 + 1] + out[i * 3 + 2] > 1) lit.push(i);
  assert.ok(lit.length >= 7 && lit.length <= 12, `an "I" is 9 pixels in this font (lit ${lit.length})`);
});

test("your own effects: every pattern, axis and drive renders, and they join the automatic pools", () => {
  const P = ["wave", "chase", "pulse", "sparkle", "fill", "breathe", "gradient"], A = ["along", "x", "y", "around", "centre"], D = ["beat", "kick", "bass", "loud", "time"];
  const custom = P.flatMap((pattern, i) => A.map((axis, j) => ({ id: `u-${i}-${j}`, name: `${pattern} ${axis}`, tag: ["calm", "build", "drop"][(i + j) % 3], pattern, axis, drive: D[(i + j) % 5], colors: j % 2 ? ["#ff0066", "#00ccff"] : "palette", speed: 1.5, width: 0.2, bg: 0.05 })));
  const f = createEffects(layout, { custom }), col = new Float32Array(layout.N * 3);
  assert.equal(f.list.length, 95 + custom.length); assert.ok(f.list.find(e => e.id === "u-0-0").custom);
  assert.ok(f.pools.drop.includes(custom.find(c => c.tag === "drop").id), "drop pool"); assert.ok(f.styles.poprock.pools.peak.includes(custom.find(c => c.tag === "drop").id), "pop/rock peak pool");
  for (const c of custom) { let lit = 0;
    for (const t of [0.1, 1.3, 4.7]) { const S = buildSignals(metronomeView(t, 128), t, { pal: f.palettes.neon, fixed: true }); f.render(c.id, S, col);
      for (let i = 0; i < col.length; i++) { assert.ok(Number.isFinite(col[i]) && col[i] >= 0, `${c.id} gave ${col[i]}`); lit += col[i]; } }
    assert.ok(lit > 0, `${c.id} is dark`); }
  assert.equal(createEffects(layout).list.length, 95, "custom effects don't leak into other rooms");
});

test("Screen Sync: black bars of a film are cut off, a dark scene isn't, and the room takes the picture's colours", async () => {
  const { createLetterbox } = await import("../src/index.js");
  const W = 16, H = 9, pic = (fill, at) => { const px = new Uint8Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(fill(x, y), (y * W + x) * 3); return { w: W, h: H, px, at }; };
  const film = (x, y) => y < 2 || y > 6 ? [0, 0, 0] : y < 5 ? [220, 20, 20] : [20, 20, 220]; // letterboxed: 2 black rows above and below
  const lb = createLetterbox();
  assert.deepEqual(lb(pic(film, 0)), { x0: 0, x1: 15, y0: 2, y1: 6 }, "the bars are found straight away");
  let c; for (let t = 1000; t <= 15000; t += 1000) c = lb(pic((x, y) => y === 4 && x === 8 ? [60, 60, 60] : [0, 0, 0], t)); // 15 s of a dark scene with one candle
  assert.deepEqual(c, { x0: 0, x1: 15, y0: 2, y1: 6 }, "a dark scene keeps the picture's size");
  for (let t = 16000; t <= 18000; t += 1000) c = lb(pic(() => [0, 0, 0], t)); assert.deepEqual(c, { x0: 0, x1: 15, y0: 2, y1: 6 }, "a fade to black too");
  for (let t = 19000; t <= 40000; t += 1000) c = lb(pic((x, y) => y === 4 && x === 8 ? [60, 60, 60] : [0, 0, 0], t));
  assert.ok(c.y0 > 2 && c.x0 > 0, "only after 20 s of black does an edge count as a bar");
  assert.deepEqual(lb(pic(() => [90, 90, 90], 41000)), { x0: 0, x1: 15, y0: 0, y1: 8 }, "a full-screen picture uses everything again at once");
  assert.deepEqual(createLetterbox()(pic(() => [0, 0, 0], 0)), { x0: 0, x1: 15, y0: 0, y1: 8 }, "an all-black picture isn't cut");
  assert.deepEqual(createLetterbox()(pic((x, y) => x < 2 || x > 13 ? [0, 0, 0] : [99, 99, 99], 0)), { x0: 2, x1: 13, y0: 0, y1: 8 }, "pillarbox bars at the sides");
  // the effect: strips along the top and the bottom of the room show the film's top (red) and bottom (blue), not the black bars
  const L = buildLayout([{ type: "line", count: 30, pts: [[1, 0.5], [15, 0.5]], dev: "d" }, { type: "line", count: 30, pts: [[1, 8.5], [15, 8.5]], dev: "d" }]), F = createEffects(L), out = new Float32Array(L.N * 3);
  const S0 = buildSignals(metronomeView(0, 120), 0, { pal: F.palettes.neon, fixed: true });
  for (let k = 0; k < 20; k++) F.render("screen", { ...S0, screen: pic(film, k * 50) }, out);
  const avg = (a, b) => { const c = [0, 0, 0]; for (let i = a; i < b; i++) for (let j = 0; j < 3; j++) c[j] += out[i * 3 + j] / (b - a); return c; }, top = avg(0, 30), bottom = avg(30, 60);
  assert.ok(top[0] > 0.5 && top[0] > 4 * top[2], `top of the room is red, not black (${top.map(v => v.toFixed(2))})`);
  assert.ok(bottom[2] > 0.5 && bottom[2] > 4 * bottom[0], `bottom of the room is blue, not black (${bottom.map(v => v.toFixed(2))})`);
  F.render("screen", { ...S0, screen: null }, out); assert.ok(out.some(v => v > 0.01), "with nothing shared it still glows softly");
});
