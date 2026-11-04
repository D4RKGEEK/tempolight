import test from "node:test";
import assert from "node:assert/strict";
import { detectSpot, sampleIndices, fillPositions, toStage } from "./mapping.js";

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
