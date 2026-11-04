import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { GoveeSender, discoverGovee, goveeRazerPacket } from "../src/govee.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function listen() { return new Promise(r => { const s = dgram.createSocket("udp4"), got = []; s.on("message", b => got.push(JSON.parse(b.toString()).msg)); s.bind(0, "127.0.0.1", () => r({ s, got, port: s.address().port })); }); }

test("Govee razer packets have the header, colours and XOR checksum", () => {
  const b = Buffer.from(goveeRazerPacket([255, 0, 0, 0, 0, 255]), "base64");
  assert.deepEqual([...b.subarray(0, 6)], [0xbb, 0x00, 8, 0xb0, 0x01, 2]); assert.deepEqual([...b.subarray(6, 12)], [255, 0, 0, 0, 0, 255]);
  let x = 0; for (const v of b.subarray(0, -1)) x ^= v; assert.equal(b.at(-1), x);
});

test("Govee: one colour per light, rate-limited; segments mode streams", async () => {
  const L = await listen();
  try {
    const one = new GoveeSender("127.0.0.1", { port: L.port, fps: 50 }), rgb = new Uint8Array(30); for (let i = 0; i < 30; i += 3) { rgb[i] = 200; rgb[i + 2] = 100; }
    one.send(rgb); one.send(rgb); await sleep(60); one.send(rgb); await sleep(80);
    assert.equal(L.got.length, 1, "no repeats when nothing changed"); assert.equal(L.got[0].cmd, "colorwc"); assert.deepEqual(L.got[0].data.color, { r: 200, g: 0, b: 100 });
    one.power(false); await sleep(40); assert.deepEqual(L.got.at(-1), { cmd: "turn", data: { value: 0 } }); one.close();
    L.got.length = 0; const seg = new GoveeSender("127.0.0.1", { port: L.port, mode: "segments", segments: 2, fps: 100 }), two = new Uint8Array(12); two.set([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
    seg.send(two); await sleep(60);
    assert.equal(L.got[0].cmd, "razer"); assert.equal(L.got.length, 2, "razer mode on, then a frame");
    const f = Buffer.from(L.got[1].data.pt, "base64"); assert.deepEqual([...f.subarray(5, 12)], [2, 255, 0, 0, 0, 0, 255]); seg.close(); await sleep(80);
    assert.equal(Buffer.from(L.got.at(-1).data.pt, "base64")[4], 0, "razer mode off on close");
  } finally { L.s.close(); }
});

test("Govee discovery reads scan answers", async () => {
  const fake = dgram.createSocket("udp4"); await new Promise(r => fake.bind(0, "127.0.0.1", r));
  const listenPort = 40000 + Math.floor(Math.random() * 9000);
  fake.on("message", (b, r) => { const m = JSON.parse(b.toString()).msg; if (m.cmd === "scan") fake.send(JSON.stringify({ msg: { cmd: "scan", data: { ip: "127.0.0.1", device: "AA:BB", sku: "H6199" } } }), listenPort, "127.0.0.1"); });
  try { const found = await discoverGovee({ timeoutMs: 800, port: listenPort, scanPort: fake.address().port, group: "127.0.0.1" });
    assert.deepEqual(found, [{ host: "127.0.0.1", sku: "H6199", device: "AA:BB", name: "Govee H6199" }]); } finally { fake.close(); }
});

test("Govee razer: never more segments than the one-byte length allows", () => {
  const b = Buffer.from(goveeRazerPacket(new Array(300 * 3).fill(7)), "base64");
  assert.equal(b[5], 60, "capped to 60 segments"); assert.equal(b[2], 60 * 3 + 2); assert.equal(b.length, 6 + 60 * 3 + 1);
  let x = 0; for (const v of b.subarray(0, -1)) x ^= v; assert.equal(b.at(-1), x);
  assert.equal(new GoveeSender("127.0.0.1", { mode: "segments", segments: 300 }).segments, 60);
});

test("Govee razer mode is switched on again: periodically and after power on", async () => {
  const L = await listen();
  try {
    const seg = new GoveeSender("127.0.0.1", { port: L.port, mode: "segments", segments: 2, fps: 1000 }), a = new Uint8Array(6).fill(100), b = new Uint8Array(6).fill(200);
    const ons = () => L.got.filter(m => m.cmd === "razer" && Buffer.from(m.data.pt, "base64")[3] === 0xb1).length;
    seg.send(a); await sleep(30); assert.equal(ons(), 1);
    seg.send(b); await sleep(30); assert.equal(ons(), 1, "not with every frame");
    seg.razer -= 11000; seg.send(a); await sleep(30); assert.equal(ons(), 2, "again after a while, in case the light dropped out of razer mode");
    seg.power(false); seg.power(true); seg.send(a); await sleep(30); assert.equal(ons(), 3, "again after power on, even with the same colours");
    seg.close(); await sleep(80);
  } finally { L.s.close(); }
});
