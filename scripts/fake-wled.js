#!/usr/bin/env node
// A pretend WLED controller for development and tests: answers the JSON API and receives DDP frames.
//   node scripts/fake-wled.js --leds 300 --name "Desk" --http 18080 --ddp 4048
// Then add "127.0.0.1:18080" as a device in Tempolight (set its DDP port if not 4048).
import http from "node:http";
import dgram from "node:dgram";
import { fileURLToPath } from "node:url";

export async function startFakeWled({ name = "Fake WLED", leds = 300, httpPort = 0, ddpPort = 0, quiet = true } = {}) {
  const dev = { name, leds, frames: 0, badPackets: 0, lastFrame: new Uint8Array(leds * 3), maxPixel: 0, state: { on: true, bri: 128, seg: [{ id: 0, start: 0, stop: leds, n: "Main" }] }, posts: [], frameTimes: [],
    override: {} }; // tests set override.wifi {rssi, signal}, override.leds {fps, pwr, maxpwr} or override.live to pretend trouble
  const pending = new Uint8Array(leds * 3);
  const udp = dgram.createSocket("udp4");
  udp.on("message", msg => {
    if (msg.length < 10 || (msg[0] & 0xc0) !== 0x40 || msg[2] !== 0x0b) { dev.badPackets++; return; }
    const off = msg.readUInt32BE(4), len = msg.readUInt16BE(8);
    if (msg.length !== 10 + len) { dev.badPackets++; return; }
    pending.set(msg.subarray(10, 10 + Math.max(0, Math.min(len, pending.length - off))), off);
    dev.maxPixel = Math.max(dev.maxPixel, (off + len) / 3);
    if (msg[0] & 0x01) { dev.frames++; dev.lastFrame.set(pending); dev.lastFrameAt = Date.now(); dev.frameTimes.push(dev.lastFrameAt); if (dev.frameTimes.length > 400) dev.frameTimes.splice(0, 200); }
  });
  await new Promise(r => udp.bind(ddpPort, "127.0.0.1", r));
  dev.ddpPort = udp.address().port;
  const fps = () => { const now = Date.now(); return dev.frameTimes.filter(t => now - t < 1000).length; }; // frames shown in the last second, as WLED reports it
  const info = () => { const o = dev.override; return { ver: "0.15.0", vid: 2412100, name: dev.name, arch: "esp32", mac: "aabbccddeeff", udpport: 21324, live: o.live ?? Date.now() - (dev.lastFrameAt || 0) < 2500,
    leds: { count: dev.leds, fps: fps(), pwr: 400, maxpwr: 850, rgbw: false, ...o.leds }, wifi: { bssid: "x", rssi: -55, signal: 90, channel: 6, ...o.wifi } }; };
  const srv = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const send = j => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/json/info") return send(info());
    if (req.url === "/json/state" && req.method === "POST") { const b = JSON.parse(body || "{}"); dev.posts.push(b); Object.assign(dev.state, b); return send({ success: true }); }
    if (req.url === "/json/state") return send(dev.state);
    if (req.url === "/json") return send({ state: dev.state, info: info() });
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(httpPort, "127.0.0.1", r));
  dev.httpPort = srv.address().port; dev.host = `127.0.0.1:${dev.httpPort}`;
  dev.close = () => { srv.close(); try { udp.close(); } catch {} };
  if (!quiet) console.log(`Fake WLED "${name}" with ${leds} LEDs: JSON API on http://${dev.host}, DDP on UDP ${dev.ddpPort}`);
  return dev;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
  const dev = await startFakeWled({ name: arg("name", "Fake WLED"), leds: Number(arg("leds", 300)), httpPort: Number(arg("http", 18080)), ddpPort: Number(arg("ddp", 4048)), quiet: false });
  setInterval(() => { const f = dev.lastFrame; let s = 0; for (let i = 0; i < f.length; i++) s += f[i];
    process.stdout.write(`\r${dev.frames} frames, ${dev.badPackets} bad packets, average level ${(s / Math.max(1, f.length)).toFixed(1)}   `); }, 1000);
}
