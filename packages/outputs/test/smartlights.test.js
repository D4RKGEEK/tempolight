import test from "node:test";
import assert from "node:assert/strict";
import { fakeLifx, fakeWiz, fakeKasa, fakeYeelight, fakeTwinkly } from "./fake-lights.js";
import { LifxSender, lifxInfo, discoverLifx, rgbToHsbk, lifxPacket, lifxParse } from "../src/lifx.js";
import { WizSender, wizInfo, discoverWiz, wizPilot } from "../src/wiz.js";
import { KasaSender, kasaInfo, discoverKasa, kasaEncrypt, kasaDecrypt, kasaCommand } from "../src/kasa.js";
import { YeelightSender, yeelightInfo, discoverYeelight, parseYeelightAd, yeelightColour } from "../src/yeelight.js";
import { TwinklySender, twinklyInfo, twinklyLogin, twinklyLayout, discoverTwinkly, twinklyPackets } from "../src/twinkly.js";
import { hostPort, zoneColours } from "../src/lightutil.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20); } return false; }
/** call send() every few ms for `ms` with a changing colour */
async function stream(s, ms, n = 1) { const t = Date.now(); let k = 0; while (Date.now() - t < ms) { k++; s.send(new Uint8Array(n * 3).map((_, i) => (k * 17 + i * 40) % 256)); await sleep(4); } }

test("helpers: host:port, zones", () => {
  assert.deepEqual(hostPort("192.168.1.5", 80), ["192.168.1.5", 80]); assert.deepEqual(hostPort("192.168.1.5:81", 80), ["192.168.1.5", 81]); assert.deepEqual(hostPort("[::1]:9", 1), ["::1", 9]);
  assert.deepEqual([...zoneColours(new Uint8Array([10, 0, 0, 30, 0, 0, 0, 0, 90]), 2)], [10, 0, 0, 15, 0, 45]);
});

test("LIFX: header, HSBK, discovery, a bulb gets SetColor at most 20 times a second, power", async () => {
  const p = lifxPacket(102, Buffer.alloc(13), { target: "d073d5112233", source: 7, seq: 3 });
  assert.equal(p.length, 49); assert.equal(p.readUInt16LE(2), 0x1400, "protocol 1024, addressable, not tagged with a target"); assert.equal(lifxPacket(2).readUInt16LE(2), 0x3400, "tagged without one");
  assert.deepEqual(lifxParse(p), { type: 102, source: 7, target: "d073d5112233", seq: 3, payload: p.subarray(36) });
  assert.deepEqual(rgbToHsbk(255, 0, 0), [0, 65535, 65535, 3500]); assert.deepEqual(rgbToHsbk(0, 0, 255).slice(0, 3), [43690, 65535, 65535]);
  const L = await fakeLifx();
  try {
    const i = await lifxInfo(L.host); assert.deepEqual({ ...i }, { mac: "d073d5112233", name: "Desk", vendor: 1, product: 27, zones: 1, extended: false });
    assert.deepEqual(await discoverLifx({ targets: [["127.0.0.1", L.port]], timeoutMs: 300 }), [{ host: L.host, mac: "d073d5112233", name: "Desk" }]);
    const s = new LifxSender(L.host, { mac: i.mac }); await stream(s, 1000); await sleep(50);
    assert.ok(L.colors.length >= 15 && L.colors.length <= 21, `about 20 a second (${L.colors.length})`); assert.ok(L.colors.every(c => c[3] === 3500));
    assert.ok(L.got.filter(g => g.type === 102).every(g => g.target === "d073d5112233"), "addressed to the light");
    const n = L.colors.length; s.send(new Uint8Array([1, 2, 3])); await sleep(60); s.send(new Uint8Array([1, 2, 3])); await sleep(30); assert.equal(L.colors.length, n + 1, "the same colour isn't sent again at once");
    s.power(false); s.power(true); await sleep(30); assert.deepEqual(L.power, [0, 65535]); s.close();
  } finally { L.close(); }
});

test("LIFX: a strip gets one colour per zone with SetExtendedColorZones (two messages for more than 82 zones)", async () => {
  const L = await fakeLifx({ zones: 100 });
  try {
    const i = await lifxInfo(L.host); assert.equal(i.zones, 100); assert.ok(i.extended);
    const s = new LifxSender(L.host, { mac: i.mac, zones: 100, extended: true }), rgb = new Uint8Array(300); rgb.set([255, 0, 0], 0); rgb.set([0, 0, 255], 297);
    s.send(rgb); await until(() => L.zonesSet.length >= 2, 500);
    assert.deepEqual(L.zonesSet.map(z => [z.apply, z.index, z.count]), [[0, 0, 82], [1, 82, 18]], "the last message applies");
    assert.deepEqual(L.zonesSet[0].first, [0, 65535, 65535, 3500]); assert.equal(s.minGap, 100, "two messages a frame: 10 frames a second"); s.close();
  } finally { L.close(); }
});

test("WiZ: discovery, system config, setPilot (full-scale colour + dimming, off when black), at most 10 a second", async () => {
  assert.deepEqual(wizPilot(128, 0, 64), { state: true, r: 255, g: 0, b: 128, dimming: 50 }); assert.deepEqual(wizPilot(2, 3, 1), { state: false }); assert.equal(wizPilot(20, 0, 0).dimming, 10);
  const W = await fakeWiz();
  try {
    assert.deepEqual(await discoverWiz({ targets: [["127.0.0.1", W.port]], timeoutMs: 300 }), [{ host: W.host, mac: "a8bb50aabbcc", name: "WiZ light" }]);
    assert.equal((await wizInfo(W.host)).module, "ESP01_SHRGB1C_31");
    const s = new WizSender(W.host); await stream(s, 1000); await sleep(50);
    assert.ok(W.pilots.length >= 8 && W.pilots.length <= 11, `about 10 a second (${W.pilots.length})`);
    s.power(false); await sleep(30); assert.equal(W.pilots.at(-1).state, false); s.close();
  } finally { W.close(); }
});

test("Kasa: XOR autokey, sysinfo over TCP, discovery over UDP, bulbs and strips (one colour or per zone)", async () => {
  const e = kasaEncrypt('{"system":{"get_sysinfo":{}}}'); assert.deepEqual([...e.subarray(0, 4)], [0xd0, 0xf2, 0x81, 0xf8]); assert.equal(kasaDecrypt(e), '{"system":{"get_sysinfo":{}}}');
  const red = kasaCommand(new Uint8Array([255, 0, 0]))["smartlife.iot.smartbulb.lightingservice"].transition_light_state;
  assert.deepEqual(red, { ignore_default: 1, transition_period: 0, on_off: 1, hue: 0, saturation: 100, brightness: 100, color_temp: 0 });
  const groups = kasaCommand(new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0]), { strip: true, zones: 3 })["smartlife.iot.lightStrip"].set_light_state.groups;
  assert.deepEqual(groups, [[0, 1, 0, 100, 100, 0], [2, 2, 0, 0, 0, 0]], "neighbours with one colour are one group");
  const B = await fakeKasa(), S = await fakeKasa({ strip: true, zones: 16 }), P = await fakeKasa({ plug: true });
  try {
    assert.deepEqual(await kasaInfo(B.host), { name: "Lamp", model: "KL130(EU)", mac: "50C7BF000001", strip: false, zones: 1, color: true, version: "1.0.10" });
    assert.equal((await kasaInfo(S.host)).zones, 16); await assert.rejects(kasaInfo(P.host), /isn't a light/);
    const found = await discoverKasa({ targets: [["127.0.0.1", B.port], ["127.0.0.1", S.port], ["127.0.0.1", P.port]], timeoutMs: 300 });
    assert.deepEqual(found.map(f => f.name).sort(), ["Lamp", "TV strip"], "plugs aren't lights");
    const b = new KasaSender(B.host); await stream(b, 600); await sleep(50);
    assert.ok(B.cmds.length >= 4 && B.cmds.length <= 8, `about 10 a second (${B.cmds.length})`); assert.ok(B.cmds.every(c => c["smartlife.iot.smartbulb.lightingservice"]));
    b.power(false); await sleep(30); assert.equal(B.cmds.at(-1)["smartlife.iot.smartbulb.lightingservice"].transition_light_state.on_off, 0); b.close();
    const st = new KasaSender(S.host, { strip: true, zones: 16, perZone: true }); st.send(new Uint8Array(48).fill(200)); await until(() => S.cmds.length, 500);
    assert.deepEqual(S.cmds[0]["smartlife.iot.lightStrip"].set_light_state.groups, [[0, 15, 0, 0, 78, 0]]); st.close();
  } finally { B.close(); S.close(); P.close(); }
});

test("Yeelight: discovery headers, music mode (the light connects back), 20 a second, slow fallback without it", async () => {
  assert.deepEqual(yeelightColour(255, 0, 0), ["set_scene", ["color", 0xff0000, 100]]); assert.deepEqual(yeelightColour(0, 0, 1), ["set_power", ["off", "sudden", 0]]);
  assert.equal(parseYeelightAd("HTTP/1.1 200 OK\r\nLocation: yeelight://10.0.0.9:55443\r\nname: Hall\r\n").host, "10.0.0.9");
  const Y = await fakeYeelight();
  try {
    const [d] = await discoverYeelight({ target: ["127.0.0.1", Y.ssdpPort], timeoutMs: 300 }); assert.equal(d.host, Y.host); assert.equal(d.name, "Sofa lamp"); assert.ok(d.support.includes("set_music"));
    assert.equal((await yeelightInfo(Y.host)).name, "Sofa lamp");
    const s = new YeelightSender(Y.host); await stream(s, 1200); await sleep(50);
    assert.equal(s.mode, "music"); assert.equal(Y.musicConnections, 1); const sm = Y.cmds.find(c => c.method === "set_music"); assert.equal(sm.params[1], "127.0.0.1");
    const t = Y.music.filter(c => c.method === "set_scene"); assert.ok(t.length >= 12 && t.length <= 25, `up to 20 a second in music mode (${t.length})`);
    assert.equal(Y.cmds.filter(c => c.method === "set_scene").length, 0, "colours don't use the limited connection");
    Y.musicSock.destroy(); await sleep(50); assert.equal(s.mode, "slow", "the light dropped music mode");
    s.power(false); await sleep(50); assert.deepEqual(Y.cmds.at(-1).params[0], "off"); s.close();
  } finally { Y.close(); }
  const N = await fakeYeelight({ music: false });
  try { const s = new YeelightSender(N.host, { musicTimeoutMs: 200, retryMs: 60000 }); await stream(s, 1600); await sleep(50);
    assert.equal(s.mode, "slow"); const n = N.cmds.filter(c => c.method === "set_scene").length; assert.ok(n >= 1 && n <= 2, `one a second without music mode (${n})`); s.close();
  } finally { N.close(); }
});

test("Twinkly: login and verify, gestalt, layout, realtime mode, protocol 3 fragments of 900 bytes, RGBW, discovery, off", async () => {
  const pk = twinklyPackets(Buffer.from("12345678").toString("base64"), Buffer.alloc(1000), 3);
  assert.deepEqual(pk.map(p => [p[0], p.subarray(1, 9).toString(), p[9], p[10], p[11], p.length - 12]), [[3, "12345678", 0, 0, 0, 900], [3, "12345678", 0, 0, 1, 100]]);
  const T = await fakeTwinkly({ leds: 400 });
  try {
    const i = await twinklyInfo(T.host); assert.deepEqual({ leds: i.leds, rgbw: i.rgbw, protocol: i.protocol, name: i.name }, { leds: 400, rgbw: false, protocol: 3, name: "Tree" });
    const { token } = await twinklyLogin(T.host), l = await twinklyLayout(T.host, token); assert.equal(l.source, "2d"); assert.equal(l.points.length, 400);
    assert.deepEqual(await discoverTwinkly({ targets: [["127.0.0.1", T.discoveryPort]], timeoutMs: 300 }), [{ host: "127.0.0.1", name: "Tree" }]);
    const s = new TwinklySender(T.host, { leds: 400, rtPort: T.rtPort }), rgb = new Uint8Array(1200); rgb.set([10, 20, 30]); rgb.set([1, 2, 3], 1197);
    const t0 = Date.now(); while (Date.now() - t0 < 1000) { s.send(rgb); await sleep(4); } await sleep(50);
    assert.equal(T.mode, "rt"); assert.ok(T.frames.length >= 18 && T.frames.length <= 26, `about 25 frames a second (${T.frames.length})`);
    assert.equal(T.frames[0].length, 1200); assert.deepEqual(T.frames[0].slice(0, 3), [10, 20, 30]); assert.deepEqual(T.frames[0].slice(-3), [1, 2, 3]);
    assert.ok(T.packets.every(p => p.subarray(1, 9).equals(Buffer.from(T.token, "base64").subarray(0, 8))), "the token is in every packet");
    await s.power(false); assert.equal(T.mode, "off"); s.close();
  } finally { T.close(); }
  const W = await fakeTwinkly({ leds: 2, rgbw: true });
  try { const s = new TwinklySender(W.host, { leds: 2, rgbw: true, rtPort: W.rtPort }); await until(async () => { s.send(new Uint8Array([200, 100, 50, 255, 255, 255])); await sleep(45); return W.frames.length >= 2; });
    assert.deepEqual(W.frames[0], [50, 150, 50, 0, 255, 0, 0, 0], "W R G B: white takes the common part"); s.close();
  } finally { W.close(); }
});
