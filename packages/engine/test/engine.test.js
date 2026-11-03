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

test("all 93 effects render finite colours on every LED", () => {
  assert.equal(fx.list.length, 93);
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
