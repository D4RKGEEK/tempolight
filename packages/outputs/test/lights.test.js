import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nanoleafInfo, nanoleafFrame } from "../src/nanoleaf.js";
import { HueSender } from "../src/hue.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function server(handler) { const s = http.createServer((q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => handler(q, r, b)); });
  return new Promise(res => s.listen(0, "127.0.0.1", () => res({ host: `127.0.0.1:${s.address().port}`, close: () => new Promise(c => { s.closeAllConnections?.(); s.close(c); }) }))); }
const json = (r, o) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };

test("Nanoleaf: lit shapes are panels (Elements corners too); the Rhythm module and connectors aren't", async () => {
  const s = await server((q, r) => json(r, { name: "Elements", model: "NL52", panelLayout: { layout: { positionData: [
    { panelId: 5, x: 0, y: 0, shapeType: 1 }, { panelId: 6, x: 0, y: 0, shapeType: 12 }, { panelId: 7, x: 10, y: 0, shapeType: 14 }, { panelId: 8, x: 20, y: 0, shapeType: 15 },
    { panelId: 9, x: 30, y: 0, shapeType: 19 }, { panelId: 10, x: 40, y: 0, shapeType: 20 }] } } }));
  try { assert.deepEqual((await nanoleafInfo(s.host, "T")).panels.map(p => p.id), [7, 8]); } finally { await s.close(); }
  const f = nanoleafFrame([300, 4], [1, 2, 3]); // v2: big-endian count and ids, W = 0, transition 0
  assert.deepEqual([...f], [0, 2, 1, 44, 1, 2, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0]);
});

test("Hue: devices on one bridge share its ~10 commands a second and take turns; power off is spread out", async () => {
  const puts = []; const s = await server((q, r, b) => { const m = /lights\/(\w+)\/state/.exec(q.url); if (m) puts.push({ id: m[1], t: Date.now(), ...JSON.parse(b) }); json(r, [{ success: {} }]); });
  try {
    const a = new HueSender(s.host, { user: "U", lights: ["1", "2"] }), b = new HueSender(s.host, { user: "U", lights: ["3"], color: [false] });
    const t0 = Date.now(); let k = 0;
    while (Date.now() - t0 < 1000) { k++; const c = new Uint8Array([k * 37 % 256, 50, 200, 200, k * 53 % 256, 9]); a.send(c); b.send(c.subarray(0, 3)); await sleep(10); }
    await sleep(100);
    assert.ok(puts.length <= 12, `about 10 a second for the whole bridge (${puts.length})`); assert.ok(puts.some(p => p.id === "3"), "the second device gets turns too");
    assert.ok(puts.filter(p => p.id === "3").every(p => !p.xy && p.bri > 0), "a white-only light gets brightness, no colour");
    const short = new HueSender(s.host, { user: "U", lights: ["4", "5"] }); await sleep(150); puts.length = 0; short.send(new Uint8Array([255, 0, 0])); await sleep(150);
    assert.deepEqual(puts.map(p => p.id), ["4"], "a light with no LEDs in the room is left alone"); assert.ok(puts[0].xy.every(Number.isFinite));
    puts.length = 0; await sleep(150); a.power(false); b.power(false); await sleep(450);
    assert.deepEqual(puts.map(p => p.id).sort(), ["1", "2", "3"]); assert.ok(puts.every(p => p.on === false));
    assert.ok(puts.at(-1).t - puts[0].t >= 150, "one command per gap, not all at once");
    a.close(); b.close(); short.close();
  } finally { await s.close(); }
});
