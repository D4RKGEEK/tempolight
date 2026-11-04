import test from "node:test";
import assert from "node:assert/strict";
import { DMX_PROFILES, fixtureProfile, channelCount, writeFixture, overlaps, kindOf } from "../src/dmx.js";
import { artnetPackets, e131Packets } from "../src/e131.js";

const U = () => new Uint8Array(512);
const at = (u, address, n) => Array.from(u.subarray(address - 1, address - 1 + n));
const coarse8 = p => Math.round(Math.round(p * 65535) / 257);

test("DMX profiles: each built-in profile writes the right values at its address", () => {
  let u = U(); writeFixture(u, { profile: "rgb", address: 10 }, { r: 200, g: 100, b: 50 }); assert.deepEqual(at(u, 10, 3), [200, 100, 50]); assert.equal(u[8], 0); assert.equal(u[12], 0);
  u = U(); writeFixture(u, { profile: "rgbw", address: 1 }, { r: 200, g: 150, b: 100 }); assert.deepEqual(at(u, 1, 4), [100, 50, 0, 100], "the shared part of R, G, B goes to white");
  u = U(); writeFixture(u, { profile: "rgba", address: 5 }, { r: 255, g: 64, b: 0 }); assert.deepEqual(at(u, 5, 4), [127, 0, 0, 128], "orange goes to amber");
  u = U(); writeFixture(u, { profile: "dimmer", address: 512 }, { dimmer: 0.5 }); assert.equal(u[511], 128);
  u = U(); writeFixture(u, { profile: "strobe", address: 20 }, { dimmer: 1, strobe: 0.5 }); assert.deepEqual(at(u, 20, 2), [255, 133]);
  u = U(); writeFixture(u, { profile: "strobe", address: 20 }, { dimmer: 0, strobe: 0 }); assert.deepEqual(at(u, 20, 2), [0, 0]);
  // moving head 8-bit: pan, tilt, speed, dimmer, shutter, R, G, B, gobo
  u = U(); writeFixture(u, { profile: "moving-head", address: 100 }, { pan: 0.5, tilt: 0.25, dimmer: 1, shutter: "open", r: 0, g: 100, b: 50, gobo: 2 });
  assert.deepEqual(at(u, 100, 9), [coarse8(0.5), coarse8(0.25), 0, 255, 255, 0, 255, 128, 32], "colour at full strength with the dimmer separate");
  u = U(); writeFixture(u, { profile: "moving-head", address: 100 }, { pan: 0, tilt: 1, dimmer: 0, shutter: "closed" }); assert.deepEqual(at(u, 100, 5), [0, 255, 0, 0, 0]);
  // 16-bit: pan, pan fine, tilt, tilt fine, ...
  u = U(); writeFixture(u, { profile: "moving-head-16", address: 200 }, { pan: 0.3, tilt: 0.75, dimmer: 0.5, shutter: "strobe", strobe: 1, r: 255, g: 0, b: 0 });
  const p16 = Math.round(0.3 * 65535), t16 = Math.round(0.75 * 65535);
  assert.deepEqual(at(u, 200, 11), [p16 >> 8, p16 & 255, t16 >> 8, t16 & 255, 0, 128, 95, 255, 0, 0, 0]);
  // colour wheel: blue picks the blue slot
  u = U(); writeFixture(u, { profile: "moving-head-wheel", address: 300 }, { pan: 0.5, tilt: 0.5, dimmer: 1, shutter: "open", r: 10, g: 20, b: 240 }); assert.equal(u[300 - 1 + 5], 84);
  u = U(); writeFixture(u, { profile: "moving-head-wheel-16", address: 300 }, { r: 250, g: 0, b: 0, dimmer: 1 }); assert.equal(channelCount({ profile: "moving-head-wheel-16" }), 9); assert.equal(u[300 - 1 + 7], 14, "red slot");
  u = U(); writeFixture(u, { profile: "laser", address: 30 }, { laser: true, pattern: 3 }); assert.deepEqual(at(u, 30, 2), [255, 96]);
  u = U(); writeFixture(u, { profile: "laser", address: 30 }, { laser: false, pattern: 3 }); assert.equal(u[29], 0);
  u = U(); writeFixture(u, { profile: "fog", address: 40 }, { fog: 1 }); assert.equal(u[39], 255);
  for (const id of Object.keys(DMX_PROFILES)) if (id !== "custom") assert.equal(fixtureProfile({ profile: id }).kind, DMX_PROFILES[id].kind);
});

test("DMX custom profiles: a channel list with fixed values; nothing is written past channel 512", () => {
  const f = { profile: "custom", address: 507, channels: ["fixed:7", "dimmer", "red", "green", "blue", "none", "white"] };
  assert.equal(fixtureProfile(f).kind, "par"); assert.equal(channelCount(f), 7);
  const u = U(); writeFixture(u, f, { r: 255, g: 0, b: 0, dimmer: 0.5 }); assert.deepEqual(at(u, 507, 6), [7, 128, 255, 0, 0, 0]);
  assert.equal(kindOf(["pan", "tilt", "dimmer"]), "head"); assert.equal(kindOf([{ type: "fog" }]), "fog"); assert.equal(kindOf(["laser"]), "laser");
  assert.deepEqual(overlaps([{ name: "A", profile: "rgb", address: 1 }, { name: "B", profile: "rgb", address: 3 }, { name: "C", profile: "rgb", address: 7 }]), [["A", "B"]]);
});

test("DMX packets: one 512-channel universe per Art-Net / E1.31 packet, fixture values at their addresses", () => {
  const u = U(); writeFixture(u, { profile: "rgb", address: 1 }, { r: 1, g: 2, b: 3 }); writeFixture(u, { profile: "fog", address: 512 }, { fog: 1 });
  const a = artnetPackets(u, 3, 9, 512); assert.equal(a.length, 1); const p = a[0];
  assert.equal(p.toString("latin1", 0, 7), "Art-Net"); assert.equal(p.readUInt16LE(8), 0x5000); assert.equal(p[14], 3); assert.equal(p.readUInt16BE(16), 512); assert.equal(p.length, 18 + 512);
  assert.deepEqual([p[18], p[19], p[20]], [1, 2, 3]); assert.equal(p[18 + 511], 255);
  const e = e131Packets(u, 7, 1, "Tempolight", 100, 512); assert.equal(e.length, 1); const q = e[0];
  assert.equal(q.readUInt16BE(113), 7); assert.equal(q.readUInt16BE(123), 513, "property count: start code + 512"); assert.equal(q[125], 0, "DMX start code");
  assert.deepEqual([q[126], q[127], q[128]], [1, 2, 3]); assert.equal(q[126 + 511], 255); assert.equal(q.length, 126 + 512);
  assert.equal(artnetPackets(new Uint8Array(1020), 0, 0).length, 2, "pixel output still splits at 510 channels");
});
