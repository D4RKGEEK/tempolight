// Pretend smart lights for tests, each speaking its protocol on 127.0.0.1: LIFX, WiZ, Kasa, Yeelight, Twinkly.
// Each records what it was sent, so tests can check the bytes.
import dgram from "node:dgram";
import net from "node:net";
import http from "node:http";
import { lifxPacket, lifxParse, LIFX } from "../src/lifx.js";
import { kasaEncrypt, kasaDecrypt } from "../src/kasa.js";

const udp = () => new Promise(r => { const s = dgram.createSocket("udp4"); s.bind(0, "127.0.0.1", () => r(s)); });
const u16s = (p, o, n) => Array.from({ length: n }, (_, i) => p.readUInt16LE(o + i * 2));

/** LIFX: a bulb (zones 1) or a strip (zones > 1, answers the extended multizone messages) */
export async function fakeLifx({ zones = 1, label = "Desk", mac = "d073d5112233", product = zones > 1 ? 38 : 27 } = {}) {
  const s = await udp(), port = s.address().port, F = { port, host: `127.0.0.1:${port}`, got: [], colors: [], zonesSet: [], power: [], close: () => s.close() };
  s.on("message", (b, r) => { const m = lifxParse(b); if (!m) return; F.got.push({ type: m.type, target: m.target, at: Date.now() });
    const reply = (type, payload) => { const p = lifxPacket(type, payload, { target: mac, source: m.source, seq: m.seq }); s.send(p, r.port, r.address); };
    if (m.type === LIFX.GetService) { const p = Buffer.alloc(5); p[0] = 1; p.writeUInt32LE(port, 1); reply(LIFX.StateService, p); }
    else if (m.type === LIFX.GetLabel) { const p = Buffer.alloc(32); p.write(label); reply(LIFX.StateLabel, p); }
    else if (m.type === LIFX.GetVersion) { const p = Buffer.alloc(12); p.writeUInt32LE(1, 0); p.writeUInt32LE(product, 4); reply(LIFX.StateVersion, p); }
    else if (m.type === LIFX.GetExtendedColorZones && zones > 1) { const p = Buffer.alloc(5 + 82 * 8); p.writeUInt16LE(zones, 0); p[4] = Math.min(82, zones); reply(LIFX.StateExtendedColorZones, p); }
    else if (m.type === LIFX.SetColor) F.colors.push(u16s(m.payload, 1, 4));
    else if (m.type === LIFX.SetExtendedColorZones) { const p = m.payload; F.zonesSet.push({ apply: p[4], index: p.readUInt16LE(5), count: p[7], first: u16s(p, 8, 4) }); }
    else if (m.type === LIFX.SetLightPower) F.power.push(m.payload.readUInt16LE(0)); });
  return F;
}

/** WiZ: answers registration and getSystemConfig, records setPilot */
export async function fakeWiz({ mac = "a8bb50aabbcc" } = {}) {
  const s = await udp(), port = s.address().port, F = { port, host: `127.0.0.1:${port}`, pilots: [], close: () => s.close() };
  s.on("message", (b, r) => { let j; try { j = JSON.parse(b); } catch { return; } const reply = o => s.send(Buffer.from(JSON.stringify({ method: j.method, env: "pro", ...o })), r.port, r.address);
    if (j.method === "registration") reply({ result: { mac, success: true } });
    else if (j.method === "getSystemConfig") reply({ result: { mac, moduleName: "ESP01_SHRGB1C_31", fwVersion: "1.26.1" } });
    else if (j.method === "setPilot") { F.pilots.push({ ...j.params, at: Date.now() }); reply({ result: { success: true } }); } });
  return F;
}

/** Kasa: TCP and UDP on the same port; a bulb, or a strip with `zones` zones */
export async function fakeKasa({ strip = false, zones = 16, alias = strip ? "TV strip" : "Lamp", plug = false } = {}) {
  const tcp = net.createServer(c => { let buf = Buffer.alloc(0); c.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const j = JSON.parse(kasaDecrypt(buf.subarray(4, 4 + buf.readUInt32BE(0)))), e = kasaEncrypt(JSON.stringify(answer(j))), h = Buffer.alloc(4); h.writeUInt32BE(e.length); c.end(Buffer.concat([h, e])); } }); });
  await new Promise(r => tcp.listen(0, "127.0.0.1", r)); const port = tcp.address().port;
  const s = dgram.createSocket("udp4"); await new Promise(r => s.bind(port, "127.0.0.1", r));
  const F = { port, host: `127.0.0.1:${port}`, cmds: [], close: () => { s.close(); tcp.close(); } };
  const sysinfo = plug ? { alias, model: "HS100(EU)", mic_type: "IOT.SMARTPLUGSWITCH", relay_state: 1 }
    : { alias, model: strip ? "KL430(US)" : "KL130(EU)", sw_ver: "1.0.10", mic_type: "IOT.SMARTBULB", mic_mac: "50C7BF000001", is_color: 1, light_state: { on_off: 1 }, ...(strip ? { length: zones } : {}) };
  function answer(j) { if (j.system?.get_sysinfo) return { system: { get_sysinfo: sysinfo } }; F.cmds.push({ ...j, at: Date.now() }); return { ok: 1 }; }
  s.on("message", (b, r) => { const a = answer(JSON.parse(kasaDecrypt(b))); s.send(kasaEncrypt(JSON.stringify(a)), r.port, r.address); });
  return F;
}

/** Yeelight: the command port (TCP), music mode (connects back to the address set_music gives), and the discovery answer */
export async function fakeYeelight({ music = true } = {}) {
  const F = { cmds: [], music: [], musicConnections: 0, ctlConnections: 0, close: null };
  const conns = new Set();
  const srv = net.createServer(c => { F.ctlConnections++; conns.add(c); let buf = ""; c.on("error", () => {}); c.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\r\n")) >= 0) { const j = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 2); F.cmds.push(j);
    if (j.method === "get_prop") c.write(JSON.stringify({ id: j.id, result: ["on", "80", "Sofa lamp", F.musicConnections ? "1" : "0"] }) + "\r\n");
    else if (j.method === "set_music" && j.params[0] === 1 && music) { const m = net.connect({ host: j.params[1], port: j.params[2] }); conns.add(m); m.on("error", () => {}); F.musicConnections++; F.musicSock = m;
      let mb = ""; m.on("data", d2 => { mb += d2; let k; while ((k = mb.indexOf("\r\n")) >= 0) { F.music.push({ ...JSON.parse(mb.slice(0, k)), at: Date.now() }); mb = mb.slice(k + 2); } }); }
    else c.write(JSON.stringify({ id: j.id, result: ["ok"] }) + "\r\n"); } }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); F.port = srv.address().port; F.host = `127.0.0.1:${F.port}`;
  const ssdp = await udp(); F.ssdpPort = ssdp.address().port;
  ssdp.on("message", (b, r) => { if (!/M-SEARCH/.test(b) || !/wifi_bulb/.test(b)) return;
    ssdp.send(Buffer.from(`HTTP/1.1 200 OK\r\nCache-Control: max-age=3600\r\nLocation: yeelight://127.0.0.1:${F.port}\r\nid: 0x000000000015243f\r\nmodel: color\r\nfw_ver: 18\r\nsupport: get_prop set_power set_scene set_music\r\npower: on\r\nbright: 80\r\nname: Sofa%20lamp\r\n`), r.port, r.address); });
  F.close = () => { for (const c of conns) c.destroy(); srv.close(); ssdp.close(); };
  return F;
}

/** Twinkly: the xled HTTP API, realtime frames over UDP, and the discovery answer */
export async function fakeTwinkly({ leds = 400, rgbw = false, layout = "2d", fw = "2.8.15" } = {}) {
  const token = Buffer.from("0123456789abcdefTOKEN").toString("base64"), F = { token, mode: "movie", frames: [], packets: [], logins: 0, modes: [], close: null };
  const coords = Array.from({ length: leds }, (_, i) => ({ x: (i % 20) / 19, y: Math.floor(i / 20) / Math.max(1, Math.ceil(leds / 20) - 1), z: 0 }));
  const srv = http.createServer((q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { const j = (o, code = 200) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    const authed = q.headers["x-auth-token"] === token;
    if (q.url === "/xled/v1/login" && q.method === "POST") { F.logins++; assert(JSON.parse(b).challenge); return j({ authentication_token: token, authentication_token_expires_in: 14400, "challenge-response": "abc", code: 1000 }); }
    if (q.url === "/xled/v1/verify") return authed ? j({ code: 1000 }) : j({}, 401);
    if (q.url === "/xled/v1/gestalt") return j({ product_name: "Twinkly", device_name: "Tree", number_of_led: leds, led_profile: rgbw ? "RGBW" : "RGB", fw_family: "F", code: 1000 });
    if (q.url === "/xled/v1/fw/version") return j({ version: fw, code: 1000 });
    if (!authed) return j({}, 401);
    if (q.url === "/xled/v1/led/layout/full") return j({ source: layout, synthesized: false, coordinates: coords, code: 1000 });
    if (q.url === "/xled/v1/led/mode" && q.method === "POST") { F.mode = JSON.parse(b).mode; F.modes.push(F.mode); return j({ code: 1000 }); }
    j({}, 404); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); F.host = `127.0.0.1:${srv.address().port}`;
  const rt = await udp(); F.rtPort = rt.address().port; let cur = null;
  rt.on("message", b => { F.packets.push(b); if (b[0] !== 3) return; const frag = b[11]; if (frag === 0) { if (cur) F.frames.push(cur); cur = []; } if (cur) cur.push(...b.subarray(12)); });
  const disc = await udp(); F.discoveryPort = disc.address().port;
  disc.on("message", (b, r) => { if (b.toString("latin1") !== "\x01discover") return; disc.send(Buffer.concat([Buffer.from([1, 0, 0, 127]), Buffer.from("OKTree\0")]), r.port, r.address); });
  F.close = () => { srv.closeAllConnections?.(); srv.close(); rt.close(); disc.close(); };
  return F;
}
function assert(v) { if (!v) throw new Error("fake light: bad request"); }
