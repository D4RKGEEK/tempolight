import test from "node:test";
import assert from "node:assert/strict";
import { detectSpot, sampleIndices, fillPositions, toStage, scan } from "./mapping.js";

const W = 80, H = 60;
function frame(spots, noise = 0) { const f = new Float32Array(W * H).fill(20); let s = 1;
  for (let i = 0; i < f.length; i++) { s = (s * 16807) % 2147483647; f[i] += (s / 2147483647 - 0.5) * noise; }
  for (const [cx, cy, b] of spots) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] += b * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 4); return f; }

test("camera mapping: finds the lit LED, skips unclear frames, fills in the LEDs between samples", () => {
  const dark = frame([], 6), p = detectSpot(frame([[30, 20, 180]], 6), dark, W, H);
  assert.ok(Math.abs(p.x * W - 30.5) < 0.6 && Math.abs(p.y * H - 20.5) < 0.6, `found at ${p.x * W}, ${p.y * H}`);
  assert.equal(detectSpot(frame([], 6), dark, W, H), null, "nothing lit: nothing found");
  assert.equal(detectSpot(frame([[10, 10, 180], [70, 50, 180]]), frame([]), W, H), null, "two equal spots (a mirror): skipped");
  assert.deepEqual(sampleIndices(5), [0, 1, 2, 3, 4]); const si = sampleIndices(300, 30); assert.equal(si[0], 0); assert.equal(si.at(-1), 299); assert.equal(si.length, 30);
  const pts = fillPositions([{ i: 0, p: [0, 0] }, { i: 10, p: null }, { i: 20, p: [1, 0] }, { i: 30, p: [1, 1] }], 31);
  assert.equal(pts.length, 31); assert.deepEqual(pts[10], [0.5, 0]); assert.deepEqual(pts[25], [1, 0.5]);
  assert.equal(fillPositions([{ i: 0, p: [0, 0] }], 5), null);
  const st = toStage([[0, 0], [1, 1]], 1); assert.ok(st.every(([x, y]) => x >= 0 && x <= 16 && y >= 0 && y <= 9)); assert.ok(st[1][1] > st[0][1], "y down stays y down");
});

test("camera mapping: the camera's exposure drifting brighter or darker doesn't hide the LED or invent one", () => {
  const dark = frame([], 6), shifted = frame([], 6).map(v => v + 60); // auto-exposure made everything 60 brighter
  assert.equal(detectSpot(shifted, dark, W, H), null, "a brighter picture alone is not an LED");
  for (const shift of [60, -30]) { // brighter, and darker (a dim LED would fall under the threshold)
    const p = detectSpot(frame([[50, 30, 60]], 6).map(v => v + shift), dark, W, H); assert.ok(p && Math.abs(p.x * W - 50.5) < 0.8 && Math.abs(p.y * H - 30.5) < 0.8, `the LED is still found where it is (${shift})`); }
});

test("camera mapping: a slow camera (600 ms behind) and a drifting exposure still give the right positions", async () => {
  // a pretend camera: 60 LEDs around a ring, wired the other way round, 5 hidden behind something; the picture shows
  // what was lit 600 ms ago, and gets slowly brighter (auto-exposure) while it runs
  const n = 60, truth = i => [40 - 22 * Math.cos(i / n * 2 * Math.PI), 30 + 22 * Math.sin(i / n * 2 * Math.PI)], hidden = new Set([20, 21, 22, 23, 24]);
  let T = 0; const lit = [[0, -1]], lag = 600;
  const grab = () => { let led = -1; for (const [t, l] of lit) if (t <= T - lag) led = l; const f = frame(led >= 0 && !hidden.has(led) ? [[...truth(led), 160]] : [], 6); const up = T / 1000; return f.map(v => v + up); };
  const { samples, wait } = await scan({ idx: sampleIndices(n, 30), w: W, h: H, grab, light: l => lit.push([T, l]), sleep: async ms => { T += ms; }, now: () => T });
  assert.ok(wait >= lag, `waits long enough for the camera (${wait} ms)`);
  const found = samples.filter(s => s.p); assert.ok(found.length >= 24, `found ${found.length} of ${samples.length}`);
  for (const s of found) { const [x, y] = truth(s.i); assert.ok(Math.hypot(s.p[0] * W - 0.5 - x, s.p[1] * H - 0.5 - y) < 1.5, `LED ${s.i} found at the right place`); }
  assert.ok(samples.filter(s => hidden.has(s.i)).every(s => !s.p), "hidden LEDs are left to be filled in");
  assert.ok(T > 0 && T < 120000, `the scan takes ${Math.round(T / 1000)} s`);
  const pts = fillPositions(samples, n); assert.equal(pts.length, n);
  assert.equal(lit.at(-1)[1], -1, "all dark at the end");
});

test("camera mapping: thousands of LEDs fill in fast", () => {
  const n = 8000, idx = sampleIndices(n, 200), t0 = performance.now();
  const pts = fillPositions(idx.map((i, k) => ({ i, p: k % 7 === 3 ? null : [i / n, (i % 50) / 50] })), n), st = toStage(pts, 16 / 9);
  assert.equal(st.length, n); assert.ok(st.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(performance.now() - t0 < 500, "under half a second");
});
