// Stereo: the StereoTap's balance, the analyser's pan / lr in the view, and the director's spatial accent (a kick panned
// hard left lights the left of the room more on kicks); mono sources are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { buildLayout, exampleRoom, createEffects, createDirector, LiveAnalyser, toRGB8 } from "../src/index.js";
import { StereoTap } from "../src/stereo.js";
import { createSpatial } from "../src/spatial.js";
import { edm, rng } from "./synth.js";

const L = buildLayout(exampleRoom());
const mid = (() => { let a = 1e9, b = -1e9; for (let i = 0; i < L.N; i++) { a = Math.min(a, L.PX[i]); b = Math.max(b, L.PX[i]); } return (a + b) / 2; })();

/** Play the song through the live analyser and the director at 60 fps; per frame the left and right halves' brightness. */
function run(song, { stereo = true, mode = "subtle" } = {}) {
  const save = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42));
  try {
    const fx = createEffects(L), D = createDirector(L, fx); D.settings.stereo = mode;
    const an = new LiveAnalyser(song.sr), chunk = Math.round(song.sr / 60), n = song.x.length, il = new Float32Array(chunk * 2), c8 = new Uint8Array(L.N * 3), rows = [];
    for (let p = 0, f = 0; p < n; p += chunk, f++) {
      const m = Math.min(chunk, n - p);
      if (stereo) { for (let i = 0; i < m; i++) { il[2 * i] = song.l[p + i]; il[2 * i + 1] = song.r[p + i]; } an.push(il.subarray(0, 2 * m), 2); } else an.push(song.x.subarray(p, p + m));
      const V = an.view(an.t, { predict: true }); toRGB8(D.frame(V, an.t, an.extras(), (f + 1) / 60), c8, 0.8);
      let sl = 0, sr = 0, nl = 0, nr = 0; for (let i = 0; i < L.N; i++) { const s = c8[i * 3] + c8[i * 3 + 1] + c8[i * 3 + 2]; if (L.PX[i] < mid) { sl += s; nl++; } else { sr += s; nr++; } }
      rows.push({ t: an.now, l: sl / nl, r: sr / nr, all: (sl + sr) / (nl + nr), V });
    }
    return rows;
  } finally { Math.random = save; }
}
/** Left / right brightness in the 150 ms after each kick of the drop (after the first bar, once the beat is locked). */
function kickLR(rows, song) {
  const out = []; for (let b = 9; b < 16; b++) for (let q = 0; q < 4; q++) { const k = b * song.bar + q * 60 / song.bpm, w = rows.filter(r => r.t >= k && r.t < k + 0.15);
    if (w.length) out.push(w.reduce((s, r) => s + r.l, 0) / w.reduce((s, r) => s + r.r, 0)); }
  out.sort((a, b) => a - b); return out[out.length >> 1];
}

test("StereoTap: a hit on the left pans left, the same signal on both sides is mono", () => {
  const sr = 22050, tap = new StereoTap(sr);
  for (let i = 0; i < sr; i++) { const v = 0.2 * Math.sin(2 * Math.PI * 220 * i / sr); tap.push(v, v); }
  assert.equal(tap.stereo, false, "identical channels: mono");
  let minPan = 0; for (let i = 0; i < sr / 2; i++) { const t = i / sr, k = t > 0.1 ? Math.sin(2 * Math.PI * 60 * t) * Math.exp(-(t - 0.1) * 8) : 0, v = 0.1 * Math.sin(2 * Math.PI * 440 * t); tap.push(v + k, v); if (i % 128 === 0) minPan = Math.min(minPan, tap.pan); }
  assert.ok(tap.stereo, "different channels: stereo"); assert.ok(minPan < -0.8, `a left hit pans left (${minPan})`);
  const [l, r] = tap.lr; assert.ok(l > r, "left louder");
});

test("stereo: a kick panned hard left lights the left of the room more on kicks; mono and off are untouched", t => {
  const song = edm(22050, { kickLeft: true });
  const sub = run(song, { mode: "subtle" }), strong = run(song, { mode: "strong" }), off = run(song, { mode: "off" }), mono = run(song, { stereo: false });
  const base = kickLR(off, song), rs = kickLR(sub, song) / base, rg = kickLR(strong, song) / base;
  t.diagnostic(`left/right on kicks against stereo off: subtle ${rs.toFixed(2)}x, strong ${rg.toFixed(2)}x`);
  assert.ok(sub.some(r => r.V.lr) && !mono.some(r => r.V.lr || r.V.pan != null), "pan and lr only for a stereo source");
  assert.ok(rs > 1.15, `subtle: the left half brighter on kicks (${rs.toFixed(2)}x)`);
  assert.ok(rg > rs + 0.05, `strong leans more (${rg.toFixed(2)}x)`);
  // the stereo source mixed is the mono song: with stereo off, the lights are what the mono source gives
  const d = off.reduce((m, r, i) => Math.max(m, Math.abs(r.all - mono[i].all)), 0);
  assert.ok(d < 1e-6, `stereo off = mono (${d})`);
  // overall brightness hardly moves with the accent (the far side dims about as much as the near side brightens)
  const mean = rows => rows.reduce((s, r) => s + r.all, 0) / rows.length;
  assert.ok(Math.abs(mean(sub) / mean(off) - 1) < 0.05, `room brightness ${(mean(sub) / mean(off)).toFixed(3)}`);
});

test("spatial: nothing without stereo, without width, or with the setting off", () => {
  const col = () => new Float32Array(L.N * 3).fill(0.5), V = { pan: -1, lr: [1, 0], kick: 10 };
  const s = createSpatial(L); let c = col(); s.apply(c, V, 10.02, "subtle"); assert.ok(s.state.lean < -0.1, "leans left");
  for (const [name, sp, v, mode] of [["mono", createSpatial(L), { kick: 10 }, "subtle"], ["off", createSpatial(L), V, "off"],
    ["no width", createSpatial({ N: 3, PX: new Float32Array([0.5, 0.5, 0.52]) }), V, "strong"]]) {
    c = col(); sp.apply(c, v, 10.02, mode); assert.ok(c.every(x => x === 0.5), `${name}: untouched`); }
});
