#!/usr/bin/env node
// @tempolight/server: serves the web UI, exposes a small JSON API, and runs the render loop that streams
// effects to WLED controllers. Node built-ins only. Audio capture is not wired in yet: until it is,
// the loop follows a steady metronome (see ROADMAP in the README).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout, exampleRoom, segmentRanges, createEffects, metronomeView, buildSignals, toRGB8 } from "../../engine/src/index.js";
import { DDPSender } from "../../outputs/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const configPath = process.env.TEMPOLIGHT_CONFIG || path.join(root, "tempolight.config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const PORT = Number(process.env.PORT || config.port || 8080);
const FPS = Number(config.fps || 60);

// ---- room, effects, devices
const shapes = config.room || exampleRoom();
const layout = buildLayout(shapes);
const fx = createEffects(layout);
const ranges = segmentRanges(shapes);
const devices = (config.devices || []).map(d => ({ ...d, sender: new DDPSender(d.host, d.port), size: Math.max(0, ...ranges.filter(r => r.dev === d.name).map(r => r.end + 1)) }));
const state = { effect: config.effect || "laser", bpm: Number(config.bpm || 128), brightness: Number(config.brightness ?? 0.8), palette: "neon", running: true, frames: 0, startedAt: Date.now() };
const col = new Float32Array(layout.N * 3), rgb = new Uint8Array(layout.N * 3);

function renderFrame(t) {
  const V = metronomeView(t, state.bpm);
  const S = buildSignals(V, t, { pal: fx.palettes[state.palette] || fx.palettes.neon, fixed: state.palette !== "auto" });
  fx.render(state.effect, S, col);
  toRGB8(col, rgb, state.brightness);
  // copy each shape's LEDs into its controller's buffer at its segment range
  for (const d of devices) {
    const buf = d.buf || (d.buf = new Uint8Array(d.size * 3));
    shapes.forEach((s, si) => { if (s.dev !== d.name) return; const r = ranges[si], a = layout.chainStart[si];
      buf.set(rgb.subarray(a * 3, (a + s.count) * 3), r.start * 3); });
    d.sender.send(buf);
  }
  state.frames++;
}
const t0 = performance.now();
setInterval(() => { if (state.running) renderFrame((performance.now() - t0) / 1000); }, 1000 / FPS);

// ---- HTTP: static web UI + JSON API
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp3": "audio/mpeg", ".json": "application/json", ".svg": "image/svg+xml" };
const STATIC = { "/": "apps/playground/index.html", "/demo.mp3": "apps/playground/demo.mp3", "/console": "apps/mockups/console.html" };
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") return json(res, 200, { ...state, leds: layout.N, devices: devices.map(d => ({ name: d.name, host: d.host, leds: d.size })), uptime: (Date.now() - state.startedAt) / 1000 });
    if (url.pathname === "/api/effects") return json(res, 200, fx.list);
    if (url.pathname === "/api/state" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c; const b = JSON.parse(body || "{}");
      if (b.effect && !fx.list.some(e => e.id === b.effect)) return json(res, 400, { error: `Unknown effect "${b.effect}". GET /api/effects lists them.` });
      for (const k of ["effect", "bpm", "brightness", "palette", "running"]) if (k in b) state[k] = b[k];
      return json(res, 200, state);
    }
    const file = STATIC[url.pathname];
    if (file) { const p = path.join(root, file); await stat(p); res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); return res.end(await readFile(p)); }
    json(res, 404, { error: "Not found" });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, () => {
  console.log(`Tempolight running on http://localhost:${PORT}  (playground at /, dashboard mock-up at /console)`);
  console.log(devices.length ? `Streaming ${layout.N} LEDs to ${devices.map(d => `${d.name} (${d.host})`).join(", ")}` : "No devices configured: copy tempolight.config.example.json to tempolight.config.json to stream to WLED.");
});
