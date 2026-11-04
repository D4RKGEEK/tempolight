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

test("your own effects: bad saved values can't break rendering, replace a built-in or blow the frame budget", () => {
  const big = buildLayout([{ type: "line", count: 600, pts: [[0.5, 1], [15.5, 1]], dev: "a" }, { type: "circle", count: 400, cx: 8, cy: 5, size: 2.5, dev: "a" }]);
  const custom = [
    { id: "u-nan", pattern: "chase", axis: "x", drive: "beat", speed: "fast", width: NaN, bg: -5, cycles: 1e9, colors: ["#ff0066"] },
    { id: "u-big", pattern: "wave", speed: 1e12, width: Infinity, bg: 99, cycles: -3, colors: "palette" },
    { id: "shock", name: "Not the real one", pattern: "fill", colors: "palette" }, // same id as a built-in
    { id: "u-big", name: "Twice", pattern: "pulse" }, { id: "u-x", pattern: "<img src=x>" }, null, "junk", { pattern: "wave" },
    ...["wave", "chase", "pulse", "sparkle", "fill", "breathe", "gradient"].map(p => ({ id: `u-p-${p}`, pattern: p, axis: "around", drive: "kick", speed: 2, width: 0.3, cycles: 3 })),
  ];
  const f = createEffects(big, { custom }), col = new Float32Array(big.N * 3);
  assert.equal(f.list.find(e => e.id === "shock").name, "Kick Shockwave", "a built-in can't be replaced");
  assert.equal(f.list.filter(e => e.id === "u-big").length, 1, "each id once"); assert.ok(!f.list.some(e => e.id === "u-x"), "unknown patterns are skipped");
  assert.equal(f.list.length, 95 + 2 + 7); assert.equal(f.pools.drop.filter(id => id === "shock").length, 1);
  assert.equal(createEffects(big, { custom: { not: "a list" } }).list.length, 95);
  for (const e of f.list.filter(e => e.custom)) {
    let total = 0;
    for (let k = 0; k < 40; k++) { const t = k / 60 + 0.3, S = buildSignals(metronomeView(t, 128), t, { pal: f.palettes.neon, fixed: true });
      const s0 = performance.now(); f.render(e.id, S, col); if (k >= 10) total += performance.now() - s0;
      for (let i = 0; i < col.length; i++) assert.ok(Number.isFinite(col[i]) && col[i] >= 0, `${e.id} gave ${col[i]}`); }
    assert.ok(total / 30 < 4 * (process.env.CI ? 3 : 1), `${e.id} took ${(total / 30).toFixed(2)} ms per frame`);
  }
});

test("metronome on a moved grid (a DJ deck's beats): the clock runs on, beats land where the grid says", () => {
  const P = 60 / 125, grid = { P, off: 0.123 - 40 * P, barOff: (40 - 2) % 4 }; // beat 40 at 0.123 s is the deck's 3rd beat of the bar
  const V = metronomeView(0.123 + P * 0.25, 125, grid);
  assert.equal(V.g.idx, 40); assert.equal(V.g.beatInBar, 2); assert.ok(Math.abs(V.kick - 0.123) < 1e-9); assert.ok(Math.abs(V.g.phase - 0.25) < 1e-9);
  let last = -1; for (let t = 1; t < 9; t += 0.05) { const g = metronomeView(t, 125, grid).g; assert.ok(g.idx >= last, "the beat count never goes back"); last = g.idx; }
  const plain = metronomeView(3.3, 128), P2 = 60 / 128; assert.equal(plain.g.idx, Math.floor(3.3 / P2)); assert.equal(plain.g.beatInBar, Math.floor(3.3 / P2) % 4); // unchanged without a grid
});
