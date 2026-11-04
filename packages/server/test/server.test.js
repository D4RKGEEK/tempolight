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

test("night mode, sunset schedules, backup and restore, E1.31 output", async () => {
  const { sunTimes, resolveTime, inWindow } = await import("../src/sun.js");
  const ldn = sunTimes(new Date("2026-06-21T12:00:00Z"), 51.5074, -0.1278);
  assert.ok(Math.abs(ldn.sunrise.getUTCHours() * 60 + ldn.sunrise.getUTCMinutes() - (3 * 60 + 43)) <= 3, "London midsummer sunrise about 03:43 UTC");
  assert.ok(Math.abs(ldn.sunset.getUTCHours() * 60 + ldn.sunset.getUTCMinutes() - (20 * 60 + 21)) <= 3, "London midsummer sunset about 20:21 UTC");
  assert.equal(resolveTime("18:30", new Date(), null), "18:30"); assert.equal(resolveTime("sunset", new Date(), null), null);
  assert.ok(inWindow("23:00", "07:00", new Date(2026, 0, 1, 2, 0)) && !inWindow("23:00", "07:00", new Date(2026, 0, 1, 12, 0)), "night window across midnight");
  const udp = (await import("node:dgram")).default.createSocket("udp4"), got = []; udp.on("message", m => got.push(m));
  await new Promise(r => udp.bind(0, "127.0.0.1", r));
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/api/schedules", { time: "sunset", action: { type: "on" } })).status, 400, "sunset needs a location");
    await s.call("PATCH", "/api/settings", { location: { lat: 19.076, lon: 72.8777 } });
    const sch = await s.call("POST", "/api/schedules", { name: "Dusk", time: "sunset-15", action: { type: "on" } }); assert.equal(sch.status, 200);
    assert.ok((await s.call("GET", "/api/schedules")).body.find(x => x.id === sch.body.id).next, "next sunset run is known");
    const now = new Date(), hm = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await s.call("PATCH", "/api/settings", { brightness: 1, night: { enabled: true, from: hm(new Date(now - 60000)), to: hm(new Date(+now + 3600000)), maxBrightness: 0.2 } });
    s.app.runtime.updateNight(); assert.equal(s.app.runtime.status().night, true); assert.equal(s.app.runtime.director.settings.safe, true, "no strobes at night");
    const dev = (await s.call("POST", "/api/devices", { host: "127.0.0.1", force: true, leds: 200 })).body;
    await s.call("PATCH", `/api/devices/${dev.id}`, { protocol: "e131", universe: 1 });
    assert.equal(s.app.store.data.devices[0].protocol, "e131");
    const port = udp.address().port, { E131Sender } = await import("../../outputs/src/e131.js"); const es = new E131Sender("127.0.0.1", { port }); es.send(new Uint8Array(600).fill(9)); await sleep(100); es.close();
    assert.equal(got.length, 2, "two universes for 200 pixels"); assert.equal(got[0][126], 9);
    const backup = (await s.call("GET", "/api/backup")).body; assert.equal(backup.data.devices.length, 1); assert.equal(backup.data.lock, undefined);
    await s.call("POST", "/api/reset"); assert.equal(s.app.store.data.devices.length, 0);
    assert.equal((await s.call("POST", "/api/restore", { nope: 1 })).status, 400);
    assert.equal((await s.call("POST", "/api/restore", backup)).status, 200); assert.equal(s.app.store.data.devices.length, 1); assert.equal(s.app.store.data.settings.location.lat, 19.076);
  } finally { await s.done(); udp.close(); }
});

test("phones as lights: each phone gets the colour of its part of the room", { skip: typeof WebSocket === "undefined" && "this Node.js has no WebSocket client (Node 22+)" }, async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true }); await s.call("PATCH", "/api/show", { effect: "solar" });
    const net = await s.call("GET", "/api/network"); assert.ok(Array.isArray(net.body.addresses));
    const open = () => new Promise(r => { const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); ws.binaryType = "arraybuffer"; ws.got = []; ws.onmessage = e => { if (typeof e.data !== "string") { const a = new Uint8Array(e.data); if (a[0] === 2) ws.got.push(a); } }; ws.onopen = () => { ws.send(JSON.stringify({ type: "phone", on: true })); r(ws); }; });
    const a = await open(), b = await open();
    assert.ok(await until(() => a.got.length > 5 && b.got.length > 5), "both phones get colours");
    assert.equal(a.got.at(-1).length, 5); assert.notEqual(a.got.at(-1)[4], b.got.at(-1)[4], "phones get different places in the room");
    assert.ok(a.got.some(x => x[1] + x[2] + x[3] > 0), "the colour is not black");
    assert.equal((await s.call("GET", "/api/status")).body.phones, 2);
    a.close(); assert.ok(await until(async () => (await s.call("GET", "/api/status")).body.phones === 1), "a phone that leaves is removed");
    b.close();
  } finally { await s.done(); }
});

test("screen sync: a shared screen's colours reach the LEDs", { skip: typeof WebSocket === "undefined" && "this Node.js has no WebSocket client (Node 22+)" }, async () => {
  const wled = await startFakeWled({ leds: 60 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }); await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: wled.ddpPort });
    await s.call("POST", "/api/room/preset", { id: "fourwalls" }); await s.call("PATCH", "/api/show", { effect: "screen" });
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); await new Promise(r => ws.onopen = r);
    const red = Buffer.alloc(8 * 4 * 3); for (let i = 0; i < red.length; i += 3) red[i] = 255;
    const timer = setInterval(() => ws.send(JSON.stringify({ type: "screen", w: 8, h: 4, px: red.toString("base64"), label: "Test" })), 50);
    const rgb = () => { const f = wled.lastFrame; let r = 0, g = 0, b = 0; for (let i = 0; i < f.length; i += 3) { r += f[i]; g += f[i + 1]; b += f[i + 2]; } return [r, g, b]; };
    assert.ok(await until(() => { const [r, g, b] = rgb(); return r > 1000 && r > 5 * (g + b); }), "the room turns the screen's red");
    assert.equal((await s.call("GET", "/api/status")).body.screen, "Test");
    clearInterval(timer); ws.close();
  } finally { await s.done(); await wled.close(); }
});

test("Govee lights: added without WLED, get the room's colour over the LAN API", async () => {
  const sock = dgram.createSocket("udp4"), got = []; await new Promise(r => sock.bind(0, "127.0.0.1", r)); sock.on("message", b => got.push(JSON.parse(b.toString()).msg));
  const s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: "127.0.0.1", kind: "govee", name: "Lamp" }); assert.equal(add.status, 200); assert.equal(add.body.kind, "govee");
    await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: sock.address().port }); await s.call("PATCH", "/api/show", { effect: "solar" });
    assert.ok(await until(() => got.some(m => m.cmd === "colorwc")), "colour commands arrive");
    const st = (await s.call("GET", "/api/status")).body.devices.find(d => d.id === add.body.id); assert.equal(st.online, true);
    await s.call("PATCH", `/api/devices/${add.body.id}`, { goveeMode: "segments", goveeSegments: 4 });
    assert.ok(await until(() => got.some(m => m.cmd === "razer" && Buffer.from(m.data.pt, "base64")[5] === 4)), "segment frames arrive");
    await s.call("POST", "/api/power", { on: false }); assert.ok(await until(() => got.some(m => m.cmd === "turn" && m.data.value === 0)), "power off reaches Govee");
  } finally { await s.done(); sock.close(); }
});

test("song memory: a song played once is recognised later when heard live, and its beat map is used", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Synth anthem", analysis: { ...pre, env: Array.from(pre.env) } }); await s.call("DELETE", "/api/song");
    const list = (await s.call("GET", "/api/songs")).body; assert.equal(list.length, 1); assert.equal(list[0].name, "Synth anthem");
    const start = 5, x = song.x.subarray(start * 22050), chunk = 11025; let i = 0, found = null;
    while (i < x.length && !found) { const pcm = new Int16Array(chunk); for (let k = 0; k < chunk; k++) pcm[k] = Math.round((x[i + k] || 0) * 0.4 * 32767);
      s.app.runtime.pushPcm(pcm, "capture", "Line in", null, 22050); i += chunk; await sleep(25); found = s.app.runtime.status().recognised; }
    assert.ok(found, "recognised"); assert.equal(found.name, "Synth anthem");
    const heard = i / 22050, truth = start + s.app.runtime.rt.live.an.t;
    assert.ok(Math.abs(found.pos - truth) < 0.15, `position ${found.pos} vs ${truth}`); assert.ok(heard < 20, `took ${heard} s`);
    assert.match(s.app.runtime.status().sourceLabel, /Synth anthem \(recognised\)/);
    assert.equal((await s.call("DELETE", `/api/songs/${list[0].id}`)).status, 200); assert.equal((await s.call("GET", "/api/songs")).body.length, 0);
    assert.equal(s.app.runtime.status().recognised, null, "forgetting a song stops following it");
  } finally { await s.done(); }
});

test("Pro DJ Link: beats from a CDJ set the tempo and the bar", async () => {
  const { parseBeat, beatPacket } = await import("../src/prolink.js");
  const p = parseBeat(beatPacket({ device: 2, name: "CDJ-3000", bpm: 124, pitch: 1.02, beatInBar: 3 }));
  assert.equal(p.device, 2); assert.equal(p.name, "CDJ-3000"); assert.equal(p.trackBpm, 124); assert.ok(Math.abs(p.bpm - 126.48) < 0.02); assert.equal(p.beatInBar, 3);
  assert.equal(parseBeat(Buffer.from("not a beat")), null);
  const s = await setup(), port = 51000 + Math.floor(Math.random() * 900);
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    assert.equal((await s.call("PATCH", "/api/settings", { djlink: { enabled: true, port } })).status, 200);
    const sock = dgram.createSocket("udp4"); let beat = 0;
    const timer = setInterval(() => sock.send(beatPacket({ bpm: 128, beatInBar: (beat++ % 4) + 1 }), port, "127.0.0.1"), 60000 / 128);
    assert.ok(await until(() => s.app.runtime.status().djlink), "beats arrive");
    const st = s.app.runtime.status(); assert.equal(st.source, "djlink"); assert.equal(st.bpm, 128); assert.match(st.sourceLabel, /CDJ-3000/);
    await sleep(60000 / 128 * 0.25); // a quarter into a beat: the bar position matches the deck's last beat
    assert.equal(s.app.runtime.status().beat, s.app.runtime.rt.dj.beatInBar - 1);
    clearInterval(timer); sock.close(); await s.call("PATCH", "/api/settings", { djlink: { enabled: false } });
  } finally { await s.done(); }
});

test("guest song requests: guests ask and vote, the host marks them played; works when locked", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/lock", { pin: "4321" });
    const a = await s.call("POST", "/api/requests", { title: "Daft Punk – One More Time", by: "Sam" }); assert.equal(a.status, 200);
    const b = await s.call("POST", "/api/requests", { title: "daft punk one more time!" }); assert.equal(b.body.merged, true, "same song merges into one request");
    await s.call("POST", "/api/requests", { title: "Robyn - Dancing On My Own" });
    await s.call("POST", "/api/requests", { title: "x" }).then(r => assert.equal(r.status, 400));
    let list = (await s.call("GET", "/api/requests")).body; assert.equal(list.requests.length, 2); assert.equal(list.requests[0].votes, 2, "most votes first");
    await s.call("POST", `/api/requests/${list.requests[1].id}/vote`); await s.call("POST", `/api/requests/${list.requests[1].id}/vote`);
    list = (await s.call("GET", "/api/requests")).body; assert.match(list.requests[0].title, /Robyn/);
    assert.equal((await s.call("PATCH", `/api/requests/${list.requests[0].id}`, { done: true })).status, 403, "only the host marks songs played");
    const tok = (await s.call("POST", "/api/unlock", { pin: "4321" })).body.token, H = { "x-tempolight-token": tok };
    assert.equal((await s.call("PATCH", `/api/requests/${list.requests[0].id}`, { done: true }, H)).status, 200);
    assert.equal((await s.call("GET", "/api/requests")).body.requests.length, 1);
    await s.call("PATCH", "/api/settings", { requests: false }, H);
    assert.equal((await s.call("POST", "/api/requests", { title: "Another one" })).status, 403);
    const page = await fetch(s.base + "/request"); assert.equal(page.status, 200); assert.match(await page.text(), /Request a song/);
  } finally { await s.done(); }
});

test("OpenRGB devices: added with their LED count and streamed in direct mode", async () => {
  const net = await import("node:net"), got = [];
  const srv = net.createServer(sk => { let buf = Buffer.alloc(0); sk.on("error", () => {}); sk.on("data", d => { buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) { const dev = buf.readUInt32LE(4), id = buf.readUInt32LE(8), size = buf.readUInt32LE(12); if (buf.length < 16 + size) break; buf = buf.subarray(16 + size); got.push(id);
      const reply = b => { const h = Buffer.alloc(16); h.write("ORGB"); h.writeUInt32LE(dev, 4); h.writeUInt32LE(id, 8); h.writeUInt32LE(b.length, 12); sk.write(Buffer.concat([h, b])); };
      if (id === 0) reply(Buffer.from([1, 0, 0, 0]));
      if (id === 1) { const str = t => { const l = Buffer.alloc(2); l.writeUInt16LE(t.length + 1); return Buffer.concat([l, Buffer.from(t + "\0")]); }, u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
        const body = Buffer.concat([Buffer.alloc(4), str("Fan ring"), str(""), str(""), str(""), str(""), u16(0), Buffer.alloc(4), u16(0), u16(12)]), sz = Buffer.alloc(4); sz.writeUInt32LE(body.length + 4); reply(Buffer.concat([sz, body])); } } }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: "127.0.0.1", kind: "openrgb", index: 0, ddpPort: srv.address().port });
    assert.equal(add.status, 200); assert.equal(add.body.leds, 12); assert.equal(add.body.name, "Fan ring");
    assert.ok(await until(() => got.includes(1100) && got.filter(x => x === 1050).length > 3), "direct mode, then LED updates");
    assert.ok(await until(async () => (await s.call("GET", "/api/status")).body.devices.find(d => d.id === add.body.id)?.online === true), "shows online");
  } finally { await s.done(); (await import("../../outputs/src/openrgb.js")).closeOpenRGB(); await new Promise(r => srv.close(r)); }
});

test("Nanoleaf: pairs, places the panels where they are, streams extControl frames", async () => {
  const http = await import("node:http"); let paired = false, streaming = false; const frames = [];
  const udp = dgram.createSocket("udp4"); await new Promise(r => udp.bind(0, "127.0.0.1", r)); udp.on("message", b => frames.push(b));
  const api = http.createServer((q, r) => { let body = ""; q.on("data", c => body += c); q.on("end", () => {
    const j = (code, o) => { r.writeHead(code, { "content-type": "application/json" }); r.end(o ? JSON.stringify(o) : ""); };
    if (q.method === "POST" && q.url === "/api/v1/new") return paired ? j(200, { auth_token: "TOKEN1" }) : j(403);
    if (q.url.startsWith("/api/v1/TOKEN1/effects") && q.method === "PUT") { streaming = JSON.parse(body).write.animType === "extControl"; return j(204); }
    if (q.url === "/api/v1/TOKEN1") return j(200, { name: "Shapes 1A2B", model: "NL42", panelLayout: { layout: { numPanels: 4, positionData: [
      { panelId: 0, x: 0, y: 0, o: 0, shapeType: 12 }, { panelId: 11, x: 0, y: 0, o: 0, shapeType: 7 }, { panelId: 22, x: 100, y: 0, o: 60, shapeType: 7 }, { panelId: 33, x: 50, y: 86, o: 0, shapeType: 7 }] } } });
    j(404); }); });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  const s = await setup(), host = `127.0.0.1:${api.address().port}`;
  try {
    const first = await s.call("POST", "/api/devices", { host, kind: "nanoleaf" }); assert.equal(first.status, 400); assert.match(first.body.error, /power button/);
    paired = true; const add = await s.call("POST", "/api/devices", { host, kind: "nanoleaf", ddpPort: udp.address().port });
    assert.equal(add.status, 200); assert.equal(add.body.leds, 3, "the controller isn't a panel"); assert.equal(add.body.nanoleaf.token, undefined, "the token isn't sent to browsers");
    const sh = (await s.call("GET", "/api/room")).body.shapes.find(x => x.dev === add.body.id); assert.equal(sh.type, "points"); assert.equal(sh.pts.length, 3);
    assert.ok(sh.pts[2][1] < sh.pts[0][1], "a panel higher up on the wall is higher in the room");
    assert.ok(await until(() => streaming && frames.length > 3), "streaming starts and frames arrive");
    const f = frames.at(-1); assert.equal(f.readUInt16BE(0), 3); assert.deepEqual([f.readUInt16BE(2), f.readUInt16BE(10), f.readUInt16BE(18)], [11, 22, 33]);
    const st = (await s.call("GET", "/api/state")).body.devices.find(d => d.id === add.body.id); assert.equal(st.nanoleaf.token, undefined);
  } finally { await s.done(); udp.close(); await new Promise(r => api.close(r)); }
});

test("auto-generated shows: a remembered song gets a timeline the director follows, and blocks can be changed", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Showtime", analysis: { ...pre, env: Array.from(pre.env) } });
    const id = s.app.runtime.status().song.memId; assert.ok(id, "the song is remembered");
    const sh = (await s.call("GET", `/api/songs/${id}/show`)).body; assert.ok(sh.show.length >= 3); assert.equal(sh.show[0].t0, 0);
    assert.ok(sh.show.some(b => b.part === "build") && sh.show.some(b => b.part === "drop"), "build-up and drop blocks");
    const dropBlk = sh.show.find(b => b.part === "drop"), mid = (dropBlk.t0 + dropBlk.t1) / 2;
    await s.call("POST", "/api/song/clock", { pos: mid, playing: true }); await sleep(150);
    assert.equal(s.app.runtime.status().effect, dropBlk.effect, "the director plays the show's block");
    const edited = sh.show.map(b => b === dropBlk || (b.t0 === dropBlk.t0) ? { ...b, effect: "fireworks" } : b);
    assert.equal((await s.call("PUT", `/api/songs/${id}/show`, { show: edited })).status, 200);
    assert.equal((await s.call("PUT", `/api/songs/${id}/show`, { show: [{ t0: 0, t1: 5, effect: "nope" }] })).status, 400);
    await s.call("POST", "/api/song/clock", { pos: mid, playing: true }); await sleep(150); assert.equal(s.app.runtime.status().effect, "fireworks");
    await s.call("PATCH", "/api/settings", { shows: false }); await sleep(150); assert.equal(s.app.runtime.director.settings.plan, null, "shows can be turned off");
    await s.call("PATCH", "/api/settings", { shows: true });
    const fresh = (await s.call("DELETE", `/api/songs/${id}/show`)).body; assert.ok(fresh.show.length >= 3); assert.equal((await s.call("GET", `/api/songs/${id}/show`)).body.edited, false);
  } finally { await s.done(); }
});

test("camera mapping: one LED at a time, then back to the show", async () => {
  const wled = await startFakeWled({ leds: 50 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }); await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: wled.ddpPort });
    await s.call("PATCH", "/api/show", { effect: "solar" }); assert.ok(await until(() => lum(wled) > 3));
    await s.call("POST", "/api/map", { device: add.body.id, led: 7 });
    const lit = () => { const f = wled.lastFrame, on = []; for (let i = 0; i < f.length / 3; i++) if (f[i * 3] + f[i * 3 + 1] + f[i * 3 + 2] > 0) on.push(i); return on; };
    assert.ok(await until(() => { const on = lit(); return on.length === 1 && on[0] === 7; }), "only LED 7 is lit");
    await s.call("POST", "/api/map", { device: add.body.id, led: -1 }); assert.ok(await until(() => lit().length === 0), "all dark for the reference picture");
    await s.call("POST", "/api/map", { end: true }); assert.ok(await until(() => lit().length > 10), "the show comes back");
    assert.equal((await s.call("POST", "/api/map", { device: "nope", led: 1 })).status, 404);
    const pts = [[1, 1], [2, 1], [3, 2]], room = (await s.call("GET", "/api/room")).body;
    const put = await s.call("PUT", "/api/room", { ...room, shapes: [{ type: "points", name: "Mapped", count: 3, dev: add.body.id, pts, from: 0 }] }); assert.equal(put.status, 200);
    assert.deepEqual(s.app.runtime.layoutInfo().n ?? s.app.runtime.layout.N, 3);
  } finally { await s.done(); wled.close(); }
});
