import test from "node:test";
import assert from "node:assert/strict";
import { mdnsQuery, parseDns, devicesFromRecords, scanHosts, getInfo, getSegments, setSegments, DDPSender, ipOf } from "../src/index.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";

// a reply in the shape WLED's mDNS responder sends: PTR + SRV + A, with name compression
function wledReply() {
  const name = s => Buffer.concat([...s.split(".").map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
  const rr = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(0x8001, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([n, h, data]); };
  const head = Buffer.alloc(12); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(1, 6); head.writeUInt16BE(2, 10);
  const svc = name("_wled._tcp.local"), inst = name("wled-desk._wled._tcp.local"), host = name("wled-desk.local");
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 80]), host]);
  return Buffer.concat([head, rr(svc, 12, inst), rr(inst, 33, srv), rr(host, 1, Buffer.from([192, 168, 1, 77]))]);
}

test("mDNS: query asks for _wled._tcp PTR records and replies are parsed into devices", () => {
  const q = mdnsQuery(); assert.equal(q.readUInt16BE(4), 1); assert.ok(q.includes(Buffer.from("_wled")));
  const recs = parseDns(wledReply());
  assert.deepEqual(devicesFromRecords(recs), [{ name: "wled-desk", ip: "192.168.1.77", port: 80, hostname: "wled-desk.local" }]);
});

test("WLED client and network scan work against a WLED-compatible device", async () => {
  const dev = await startFakeWled({ name: "Desk", leds: 144 });
  try {
    const info = await getInfo(dev.host); assert.equal(info.name, "Desk"); assert.equal(info.leds, 144);
    await setSegments(dev.host, [{ start: 72, end: 143, name: "Right" }, { start: 0, end: 71, name: "Left" }]);
    const segs = await getSegments(dev.host); assert.deepEqual(segs.map(s => [s.start, s.stop, s.name]), [[0, 72, "Left"], [72, 144, "Right"]]);
    const found = await scanHosts([dev.host, "127.0.0.1:1"], { timeoutMs: 400 });
    assert.equal(found.length, 1); assert.equal(found[0].name, "Desk");
    const s = new DDPSender(ipOf(dev.host), dev.ddpPort); s.send(new Uint8Array(144 * 3).fill(200)); s.send(new Uint8Array(144 * 3).fill(10));
    await new Promise(r => setTimeout(r, 100)); s.close();
    assert.equal(dev.frames, 2); assert.equal(dev.badPackets, 0); assert.equal(dev.lastFrame[0], 10);
  } finally { dev.close(); }
});

test("a DDP sender to an unreachable address never crashes the app", async () => {
  const s = new DDPSender("203.0.113.1", 4048); for (let i = 0; i < 3; i++) s.send(new Uint8Array(30)); await new Promise(r => setTimeout(r, 50)); s.close();
});
