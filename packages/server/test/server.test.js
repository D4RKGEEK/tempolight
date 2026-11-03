import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { due, nextRun, startScheduler } from "../src/scheduler.js";
import { oscMessage, parseOsc } from "../src/osc.js";
import { fileSource } from "../src/capture.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";
import { edm } from "../../engine/test/synth.js";
import { preAnalyseCore } from "../../engine/src/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
async function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-test-")), app = await createApp({ dataDir: dir, discover: false, logger: null, ...opts });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, base, port, call, dir, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const lum = d => d.lastFrame.reduce((a, b) => a + b, 0) / d.lastFrame.length;

test("devices, room presets, segments and DDP output work end to end", async () => {
  const wled = await startFakeWled({ leds: 300 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }); assert.equal(add.status, 200); assert.equal(add.body.leds, 300);
    await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: wled.ddpPort });
    assert.ok(await until(() => wled.frames > 10), "frames arrive"); assert.equal(wled.badPackets, 0); assert.equal(wled.maxPixel, 300);
    const bad = await s.call("POST", "/api/devices", { host: "127.0.0.1:1" }); assert.equal(bad.status, 400); assert.match(bad.body.error, /Couldn't reach/);
    const room = await s.call("POST", "/api/room/preset", { id: "fourwalls" }); assert.deepEqual(room.body.shapes.map(x => x.count), [50, 100, 50, 100]);
    const seg = await s.call("POST", `/api/devices/${add.body.id}/segments`); assert.equal(seg.status, 200);
    assert.deepEqual(wled.state.seg.map(x => [x.start, x.stop]), [[0, 50], [50, 150], [150, 200], [200, 300]]);
    assert.equal((await s.call("PATCH", "/api/show", { effect: "nope" })).status, 400);
    assert.equal((await s.call("PATCH", "/api/show", { effect: "solar" })).body.mode, "manual");
    assert.equal((await s.call("GET", "/api/nothing")).status, 404);
    const shapes = room.body.shapes.map(x => ({ ...x })); shapes[0].count = 0;
    assert.equal((await s.call("PUT", "/api/room", { shapes })).status, 400, "invalid shapes are refused");
    await s.call("POST", "/api/power", { on: false }); await sleep(800); assert.equal(lum(wled), 0, "power off is dark"); assert.equal(wled.state.on, false, "WLED told to turn off");
  } finally { await s.done(); wled.close(); }
});

test("settings survive a restart, and a broken settings file is set aside", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-test-"));
  let app = await createApp({ dataDir: dir, discover: false, logger: null });
  await app.listen(0, "127.0.0.1"); app.store.data.devices.push({ id: "dx", name: "Kept", host: "10.9.9.9", leds: 10, enabled: true }); app.store.save(); await app.close();
  app = await createApp({ dataDir: dir, discover: false, logger: null }); assert.equal(app.store.data.devices[0].name, "Kept"); await app.close();
  writeFileSync(path.join(dir, "tempolight.json"), "{ not json");
  const warn = console.warn; console.warn = () => {};
  app = await createApp({ dataDir: dir, discover: false, logger: null }); console.warn = warn;
  assert.equal(app.store.data.devices.length, 0); await app.close(); rmSync(dir, { recursive: true, force: true });
});

test("PIN lock: admin pages need the PIN, guests keep the parts allowed to them", async () => {
  const s = await setup();
  try {
    const l = await s.call("POST", "/api/lock", { pin: "1357" }); assert.ok(l.body.token);
    assert.equal((await s.call("POST", "/api/devices", { virtual: true })).status, 403);
    assert.equal((await s.call("PATCH", "/api/settings", { fps: 30 })).status, 403);
    assert.equal((await s.call("POST", "/api/action", { type: "flash" })).status, 200, "guests can use pads");
    assert.equal((await s.call("PATCH", "/api/show", { effect: "laser" })).status, 200, "guests can pick effects");
    assert.equal((await s.call("POST", "/api/unlock", { pin: "0000" })).status, 403);
    const u = await s.call("POST", "/api/unlock", { pin: "1357" });
    assert.equal((await s.call("POST", "/api/devices", { virtual: true }, { "x-tempolight-token": u.body.token })).status, 200);
    await s.call("PATCH", "/api/settings", { guest: { pads: false } }, { "x-tempolight-token": u.body.token });
    assert.equal((await s.call("POST", "/api/action", { type: "flash" })).status, 403, "pads can be locked too");
    assert.equal((await s.call("GET", "/api/state")).body.lock, undefined, "the PIN hash is never sent");
  } finally { await s.done(); }
});

test("schedules fire once at their minute and apply scenes", async () => {
  const sc = { id: "a", enabled: true, time: "18:30", days: [1, 2, 3, 4, 5] };
  assert.ok(due(sc, new Date(2026, 10, 2, 18, 30, 5))); // Monday
  assert.ok(!due(sc, new Date(2026, 10, 1, 18, 30))); // Sunday
  assert.equal(nextRun(sc, new Date(2026, 10, 6, 19, 0)).getDay(), 1, "after Friday evening the next run is Monday");
  let now = new Date(2026, 10, 2, 18, 30, 1), runs = 0;
  const sch = startScheduler(() => [sc], () => runs++, () => now); sch.tick(); now = new Date(2026, 10, 2, 18, 30, 40); sch.tick(); sch.stop();
  assert.equal(runs, 1);
  const s = await setup();
  try {
    const t = await s.call("POST", "/api/schedules", { name: "Chill", time: "21:00", action: { type: "scene", scene: "chill" } }); assert.equal(t.status, 200);
    assert.equal((await s.call("POST", "/api/schedules", { time: "25:00" })).status, 400);
    await s.call("POST", `/api/schedules/${t.body.id}/run`); assert.equal(s.app.store.data.show.style, "chill"); assert.equal(s.app.store.data.settings.brightness, 0.55);
  } finally { await s.done(); }
});

test("WebSocket: a browser can stream audio, get status and preview frames", { skip: typeof WebSocket === "undefined" && "this Node.js has no WebSocket client (Node 22+)" }, async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); ws.binaryType = "arraybuffer";
    const got = { hello: false, status: 0, frames: 0 };
    ws.onmessage = e => { if (typeof e.data === "string") { const m = JSON.parse(e.data); if (m.type === "hello") got.hello = true; if (m.type === "status") got.status++; } else if (new Uint8Array(e.data)[0] === 1) got.frames++; };
    await new Promise(r => ws.onopen = r);
    ws.send(JSON.stringify({ type: "preview", on: true })); ws.send(JSON.stringify({ type: "audio-start", rate: 22050, label: "Test browser" }));
    const song = edm(22050), x = song.x;
    for (let i = Math.floor(15 * 22050); i < Math.floor(27 * 22050); i += 2048) { // drop section, faster than real time
      const n = Math.min(2048, x.length - i), b = new Int16Array(n); for (let k = 0; k < n; k++) b[k] = Math.round(x[i + k] * 32000); ws.send(b.buffer); if ((i / 2048) % 8 === 0) await sleep(5); }
    await sleep(400);
    const st = s.app.runtime.status();
    assert.ok(got.hello && got.status > 0 && got.frames > 0, JSON.stringify(got));
    assert.equal(st.source, "browser"); assert.ok(Math.abs(st.bpm - 128) < 3, `bpm ${st.bpm}`); assert.ok(st.bands.some(v => v > 0));
    ws.send(JSON.stringify({ type: "action", action: { type: "blackout", on: true } })); await sleep(100); assert.ok(s.app.runtime.status().overlay.blackout);
    ws.close(); await sleep(200); assert.equal(s.app.runtime.rt.live, null, "closing the page stops its audio");
  } finally { await s.done(); }
});

test("songs analysed in the browser follow the playback clock", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    assert.equal((await s.call("POST", "/api/song", { name: "Synth", analysis: { ...pre, env: Array.from(pre.env) } })).status, 200);
    await s.call("POST", "/api/song/clock", { pos: 20, playing: true }); await sleep(100);
    const st = s.app.runtime.status(); assert.equal(st.source, "song"); assert.equal(st.part, "drop"); assert.equal(st.song.name, "Synth");
    await s.call("POST", "/api/action", { type: "build", seconds: 2 }); await sleep(100); assert.equal(s.app.runtime.status().part, "build");
    await sleep(2100); assert.equal(s.app.runtime.status().part, "drop", "build-up ends in a drop");
  } finally { await s.done(); }
});

test("OSC messages control effects, scenes and pads", async () => {
  const p = parseOsc(oscMessage("/tempolight/brightness", 0.25)); assert.equal(p[0].address, "/tempolight/brightness"); assert.ok(Math.abs(p[0].args[0] - 0.25) < 1e-6);
  const s = await setup(), port = 19000 + Math.floor(Math.random() * 500);
  try {
    await s.call("PATCH", "/api/settings", { osc: { enabled: true, port } });
    const u = dgram.createSocket("udp4"), send = m => new Promise(r => u.send(m, port, "127.0.0.1", r));
    await send(oscMessage("/tempolight/effect", "laser")); await send(oscMessage("/tempolight/blackout", 1)); await send(oscMessage("/tempolight/brightness", 0.5));
    await sleep(150); u.close();
    assert.equal(s.app.store.data.show.effect, "laser"); assert.ok(s.app.runtime.status().overlay.blackout); assert.equal(s.app.store.data.settings.brightness, 0.5);
  } finally { await s.done(); }
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test("server-side capture: listens to a sound source with no browser open", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const song = edm(22050), from = Math.floor(15 * 22050), n = Math.floor(9 * 22050), dir = mkdtempSync(path.join(os.tmpdir(), "tl-wav-")), wav = path.join(dir, "t.wav");
  const b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(song.x[from + i] * 30000), 44 + i * 2); writeFileSync(wav, b);
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    await s.call("PATCH", "/api/settings", { capture: { enabled: true, command: fileSource(wav).cmd.join(" ") } });
    assert.ok(await until(() => s.app.runtime.status().source === "capture", 4000), "capture became the source");
    assert.ok(await until(() => Math.abs((s.app.runtime.status().bpm || 0) - 128) < 3, 7000), `tempo from capture ${s.app.runtime.status().bpm}`);
    await s.call("PATCH", "/api/settings", { capture: { enabled: false } }); assert.equal(s.app.runtime.status().capture, null);
  } finally { await s.done(); rmSync(dir, { recursive: true, force: true }); }
});

test("effect likes/bans and settings, zones, and the power limit", async () => {
  const wled = await startFakeWled({ leds: 100 }), s = await setup();
  try {
    const d = (await s.call("POST", "/api/devices", { host: wled.host })).body; await s.call("PATCH", `/api/devices/${d.id}`, { ddpPort: wled.ddpPort });
    await s.call("PATCH", "/api/show", { effect: "strobechase" }); await s.call("PATCH", "/api/effects/strobechase", { params: { intensity: 3 } });
    await s.call("POST", "/api/brightness", { value: 1 }); await sleep(400);
    const before = wled.lastFrame.reduce((a, b) => a + b, 0);
    await s.call("PATCH", `/api/devices/${d.id}`, { maxAmps: 0.5, mAperLed: 60 }); await sleep(700);
    const after = wled.lastFrame.reduce((a, b) => a + b, 0), mA = 100 + after * 20 / 255;
    assert.ok(mA <= 520, `limited to 0.5 A (estimate ${mA.toFixed(0)} mA, before ${before})`);
    const st = s.app.runtime.status().devices[0]; assert.ok(st.amps <= 0.55, `reported ${st.amps} A`);
    const r = await s.call("PATCH", "/api/effects/laser", { pref: -1, params: { speed: 2, mirror: true } });
    assert.equal(r.body.pref, -1); assert.equal(r.body.params.speed, 2); assert.equal(s.app.runtime.director.settings.prefs.laser, -1);
    assert.equal((await s.call("PATCH", "/api/effects/nope", { pref: 1 })).status, 404);
    const shapes = s.app.store.data.room.shapes.map(x => ({ ...x, zone: "desk" }));
    assert.equal((await s.call("PUT", "/api/room", { shapes })).status, 200);
    const z = await s.call("PUT", "/api/zones", { zones: [{ id: "desk", name: "Desk", mode: "off" }] }); assert.equal(z.status, 200);
    await sleep(300); assert.equal(wled.lastFrame.reduce((a, b) => a + b, 0), 0, "zone off is dark");
    assert.equal((await s.call("PUT", "/api/zones", { zones: [{ id: "desk", mode: "effect", effect: "nope" }] })).status, 400);
    const sc = await s.call("POST", "/api/scenes", { name: "With settings" }); assert.ok(sc.body.show.params.strobechase, "scenes keep effect settings");
  } finally { await s.done(); wled.close(); }
});
