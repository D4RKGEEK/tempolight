import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { listOpenRGB, OpenRGBSender, parseController, closeOpenRGB } from "../src/openrgb.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
// controller data in SDK protocol 0, as OpenRGB sends it
function controllerData(name, leds, zones) {
  const parts = [], i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); }, u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  const str = s => { u16(Buffer.byteLength(s) + 1); parts.push(Buffer.from(s + "\0")); };
  i32(2); str(name); str("A test device"); str("1.0"); str("SN1"); str("HID: /dev/x");
  u16(1); i32(0); str("Direct"); for (let k = 0; k < 9; k++) i32(0); u16(1); parts.push(Buffer.from([1, 2, 3, 0])); // one mode with one colour
  u16(zones.length); for (const z of zones) { str(z.name); i32(1); i32(z.leds); i32(z.leds); i32(z.leds); u16(z.matrix ? 16 : 0); if (z.matrix) { i32(2); i32(1); i32(0); i32(1); } }
  u16(leds); for (let k = 0; k < leds; k++) { str(`LED ${k}`); i32(k); } u16(leds); for (let k = 0; k < leds; k++) parts.push(Buffer.alloc(4));
  const body = Buffer.concat(parts), size = Buffer.alloc(4); size.writeUInt32LE(body.length + 4); return Buffer.concat([size, body]);
}
function fakeServer(devs) {
  const got = [];
  const srv = net.createServer(s => { let buf = Buffer.alloc(0);
    s.on("data", d => { buf = Buffer.concat([buf, d]); while (buf.length >= 16) { const dev = buf.readUInt32LE(4), id = buf.readUInt32LE(8), size = buf.readUInt32LE(12); if (buf.length < 16 + size) break;
      const body = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size); got.push({ dev, id, body: Buffer.from(body) });
      const reply = data => { const h = Buffer.alloc(16); h.write("ORGB"); h.writeUInt32LE(dev, 4); h.writeUInt32LE(id, 8); h.writeUInt32LE(data.length, 12); s.write(Buffer.concat([h, data])); };
      if (id === 0) { const b = Buffer.alloc(4); b.writeUInt32LE(devs.length); reply(b); } else if (id === 1) reply(controllerData(...devs[dev])); } }); s.on("error", () => {}); });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ port: srv.address().port, got, close: () => new Promise(c => srv.close(c)) })));
}

test("OpenRGB: lists devices and streams LED colours in direct mode", async () => {
  const srv = await fakeServer([["Corsair RAM", 10, [{ name: "Stick 1", leds: 5 }, { name: "Stick 2", leds: 5 }]], ["Keyboard", 4, [{ name: "Keys", leds: 4, matrix: true }]]]);
  try {
    const list = await listOpenRGB("127.0.0.1", srv.port);
    assert.deepEqual(list.map(d => [d.index, d.name, d.leds]), [[0, "Corsair RAM", 10], [1, "Keyboard", 4]]); assert.deepEqual(list[0].zones.map(z => z.leds), [5, 5]);
    assert.equal(srv.got[0].id, 50, "says its name first"); assert.equal(srv.got[0].body.toString(), "Tempolight\0");
    const tx = new OpenRGBSender("127.0.0.1", { port: srv.port, index: 1, fps: 100 }); const rgb = new Uint8Array(12); rgb.set([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    tx.send(rgb); await sleep(60);
    const custom = srv.got.find(p => p.id === 1100), upd = srv.got.find(p => p.id === 1050);
    assert.equal(custom.dev, 1, "direct mode on the right device"); assert.equal(upd.dev, 1);
    assert.equal(upd.body.readUInt32LE(0), upd.body.length); assert.equal(upd.body.readUInt16LE(4), 4); assert.deepEqual([...upd.body.subarray(6, 18)], [255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0]);
    assert.equal(parseController(controllerData("X", 3, [])).leds, 3);
  } finally { closeOpenRGB(); await srv.close(); }
});

test("OpenRGB: sends exactly the device's LED count (OpenRGB ignores updates with too many colours)", async () => {
  const srv = await fakeServer([["Fan", 3, []]]);
  try {
    const tx = new OpenRGBSender("127.0.0.1", { port: srv.port, leds: 3, fps: 1000 }); tx.send(new Uint8Array(15).fill(9)); await sleep(60);
    let upd = srv.got.filter(p => p.id === 1050).at(-1); assert.equal(upd.body.readUInt16LE(4), 3); assert.equal(upd.body.length, 6 + 3 * 4);
    tx.send(new Uint8Array([1, 2, 3])); await sleep(60); upd = srv.got.filter(p => p.id === 1050).at(-1);
    assert.equal(upd.body.readUInt16LE(4), 3, "fewer colours: padded with black"); assert.deepEqual([...upd.body.subarray(6)], [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    tx.close();
  } finally { closeOpenRGB(); await srv.close(); }
});

test("OpenRGB: health checks share one listing; a server that stops answering fails instead of hanging", async () => {
  const srv = await fakeServer([["A", 2, []], ["B", 2, []]]);
  try {
    const [a, b] = await Promise.all([listOpenRGB("127.0.0.1", srv.port), listOpenRGB("127.0.0.1", srv.port)]);
    assert.deepEqual(a, b); assert.equal(srv.got.filter(p => p.id === 0).length, 1, "asked once");
  } finally { closeOpenRGB(); await srv.close(); }
  const mute = net.createServer(s => { s.on("data", () => {}); s.on("error", () => {}); }); await new Promise(r => mute.listen(0, "127.0.0.1", r));
  try {
    const tx = new OpenRGBSender("127.0.0.1", { port: mute.address().port, fps: 1000 }), keep = setInterval(() => tx.send(new Uint8Array(6)), 20); // LED updates keep the socket busy
    const t = Date.now(); await assert.rejects(listOpenRGB("127.0.0.1", mute.address().port), /didn't answer/); clearInterval(keep);
    assert.ok(Date.now() - t < 7000); tx.close();
  } finally { closeOpenRGB(); await new Promise(r => mute.close(r)); }
});

test("OpenRGB: the last device on a server closes the shared connection", async () => {
  let open = 0; const srv = net.createServer(s => { open++; s.resume(); s.on("close", () => open--); s.on("error", () => {}); }); await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port, a = new OpenRGBSender("127.0.0.1", { port, index: 0 }), b = new OpenRGBSender("127.0.0.1", { port, index: 1 });
    a.send(new Uint8Array(3)); b.send(new Uint8Array(3)); await sleep(80); assert.equal(open, 1, "one connection for both");
    a.close(); await sleep(50); assert.equal(open, 1, "still used by the other device"); b.close(); await sleep(80); assert.equal(open, 0, "closed");
  } finally { closeOpenRGB(); await new Promise(r => srv.close(r)); }
});
