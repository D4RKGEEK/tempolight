import { test } from "node:test";
import assert from "node:assert/strict";
import { ddpPackets, DDP_MAX_DATA, segmentsBody, audioSyncPacket } from "../src/index.js";

test("DDP: one small frame is one packet with the WLED header and PUSH set", () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0]);
  const [p, ...rest] = ddpPackets(rgb, 3);
  assert.equal(rest.length, 0);
  assert.deepEqual([...p.subarray(0, 10)], [0x41, 3, 0x0b, 1, 0, 0, 0, 0, 0, 6]);
  assert.deepEqual([...p.subarray(10)], [255, 0, 0, 0, 255, 0]);
});

test("DDP: 1,000 LEDs split into 480-pixel packets, PUSH only on the last, offsets in bytes", () => {
  const rgb = new Uint8Array(1000 * 3).map((_, i) => i & 255);
  const ps = ddpPackets(rgb, 1);
  assert.equal(ps.length, 3);
  assert.deepEqual(ps.map(p => p[0]), [0x40, 0x40, 0x41]);
  assert.deepEqual(ps.map(p => p.readUInt32BE(4)), [0, DDP_MAX_DATA, 2 * DDP_MAX_DATA]);
  assert.deepEqual(ps.map(p => p.readUInt16BE(8)), [1440, 1440, 120]);
  assert.equal(ps[1][10], rgb[1440]);
});

test("WLED segments: stop is exclusive and segments are sorted", () => {
  const b = segmentsBody([{ start: 100, end: 299, name: "Back wall" }, { start: 0, end: 99, name: "Left wall", rev: true }]);
  assert.deepEqual(b.seg, [{ id: 0, start: 0, stop: 100, n: "Left wall", rev: true }, { id: 1, start: 100, stop: 300, n: "Back wall", rev: false }]);
});

test("Audio sync packet is 44 bytes in WLED's V2 layout", () => {
  const p = audioSyncPacket({ sampleRaw: 1.5, sampleSmth: 2.5, peak: true, fft: Array.from({ length: 16 }, (_, i) => i * 10), magnitude: 100, majorPeak: 440 });
  assert.equal(p.length, 44);
  assert.equal(p.toString("ascii", 0, 5), "00002");
  assert.equal(p.readFloatLE(8), 1.5); assert.equal(p.readFloatLE(12), 2.5); assert.equal(p[16], 1);
  assert.equal(p[18 + 15], 150); assert.equal(p.readFloatLE(36), 100); assert.equal(p.readFloatLE(40), 440);
});
