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
import { edm, ballad } from "../../engine/test/synth.js";
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
    await until(() => got.hello && got.status > 0 && got.frames > 0, 8000); // slow CI machines need a moment
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

test("screen sync: one browser at a time, it lets go when it stops or leaves, and a locked guest is told why", { skip: typeof WebSocket === "undefined" && "this Node.js has no WebSocket client (Node 22+)" }, async () => {
  const s = await setup(), open = async (q = "") => { const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws${q}`), got = []; ws.onmessage = e => { try { got.push(JSON.parse(e.data)); } catch {} }; await new Promise(r => ws.onopen = r); return { ws, got }; };
  const pic = (c, label) => JSON.stringify({ type: "screen", w: 4, h: 2, px: Buffer.alloc(24, c).toString("base64"), label });
  const label = async () => (await s.call("GET", "/api/status")).body.screen;
  try {
    const a = await open(), b = await open();
    a.ws.send(pic(200, "Film")); assert.ok(await until(async () => await label() === "Film"));
    b.ws.send(pic(10, "Game")); assert.ok(await until(() => b.got.some(m => m.type === "screen-refused" && m.why === "busy")), "the second browser is told someone else shares");
    assert.equal(await label(), "Film", "the first browser's picture stays"); assert.equal(s.app.runtime.status().screen, "Film");
    a.ws.send(JSON.stringify({ type: "screen", end: true })); assert.ok(await until(async () => await label() === null), "stopping lets go straight away");
    b.ws.send(pic(10, "Game")); assert.ok(await until(async () => await label() === "Game"), "then the other browser can share");
    b.ws.close(); assert.ok(await until(async () => await label() === null), "a browser that leaves lets go");
    a.ws.close();
    const l = await s.call("POST", "/api/lock", { pin: "1357" }); await s.call("PATCH", "/api/settings", { guest: { effects: false } }, { "x-tempolight-token": l.body.token });
    const g = await open(); g.ws.send(pic(200, "Guest")); assert.ok(await until(() => g.got.some(m => m.type === "screen-refused" && m.why === "locked")), "a guest who may not pick effects is told");
    assert.equal(await label(), null); g.ws.close();
  } finally { await s.done(); }
});

test("camera mapping: a browser that leaves mid-scan ends it, the power-off show goes dark again, Govee lights a whole segment", { skip: typeof WebSocket === "undefined" && "this Node.js has no WebSocket client (Node 22+)" }, async () => {
  const wled = await startFakeWled({ leds: 40 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }); await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: wled.ddpPort });
    const lit = () => { const f = wled.lastFrame || [], on = []; for (let i = 0; i < f.length / 3; i++) if (f[i * 3] + f[i * 3 + 1] + f[i * 3 + 2] > 0) on.push(i); return on; };
    await s.call("POST", "/api/power", { on: false }); await sleep(800);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); await new Promise(r => ws.onopen = r);
    ws.send(JSON.stringify({ type: "map", device: add.body.id, led: 5 })); assert.ok(await until(() => lit().join() === "5"), "mapping lights the LED even with the show off");
    ws.close(); assert.ok(await until(() => s.app.runtime.status().mapping === null, 1000), "leaving ends mapping at once (not after 5 s)");
    assert.ok(await until(() => lit().length === 0, 1500), "and the LED goes dark again, as the show is off");
    // a pretend Govee light in segment mode (4 segments of 10 LEDs): mapping LED 13 lights the whole second segment
    const sock = dgram.createSocket("udp4"), got = []; await new Promise(r => sock.bind(0, "127.0.0.1", r)); sock.on("message", b => got.push(JSON.parse(b.toString()).msg));
    try {
      await s.call("POST", "/api/power", { on: true });
      const gv = await s.call("POST", "/api/devices", { host: "127.0.0.1", kind: "govee", name: "Strip" }); await s.call("PATCH", `/api/devices/${gv.body.id}`, { ddpPort: sock.address().port, goveeMode: "segments", goveeSegments: 4, leds: 40 });
      await s.call("POST", "/api/map", { device: gv.body.id, led: 13 });
      assert.ok(await until(() => got.some(m => { if (m.cmd !== "razer") return false; const b = Buffer.from(m.data.pt, "base64"); return b[5] === 4 && b[9] >= 190 && b[6] === 0 && b[12] === 0; })), "segment 2 at full brightness, the others dark");
    } finally { await s.call("POST", "/api/map", { end: true }); sock.close(); }
  } finally { await s.done(); wled.close(); }
});

test("room: points shapes don't need a count, and points must be numbers", async () => {
  const wled = await startFakeWled({ leds: 10 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }), room = (await s.call("GET", "/api/room")).body;
    const ok = await s.call("PUT", "/api/room", { ...room, shapes: [{ type: "points", name: "Mapped", dev: add.body.id, pts: [[1, 1], [2, 1]] }] }); assert.equal(ok.status, 200); assert.equal(ok.body.shapes[0].count, 2);
    const bad = await s.call("PUT", "/api/room", { ...room, shapes: [{ type: "points", name: "Mapped", dev: add.body.id, pts: [[1, 1], ["x", null]] }] }); assert.equal(bad.status, 400); assert.match(bad.body.error, /two numbers/);
  } finally { await s.done(); wled.close(); }
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
    await s.call("PATCH", `/api/devices/${add.body.id}`, { goveeSegments: 6 });
    assert.ok(await until(() => got.some(m => m.cmd === "razer" && Buffer.from(m.data.pt, "base64")[5] === 6)), "a new segment count takes effect without changing the mode");
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
  const net = await import("node:net"), got = []; let open = 0;
  const srv = net.createServer(sk => { let buf = Buffer.alloc(0); open++; sk.on("close", () => open--); sk.on("error", () => {}); sk.on("data", d => { buf = Buffer.concat([buf, d]);
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
    assert.ok(open > 0); assert.equal((await s.call("DELETE", `/api/devices/${add.body.id}`)).status, 200);
    assert.ok(await until(() => open === 0), "deleting the device closes its connection to OpenRGB");
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
    const patched = await s.call("PATCH", `/api/devices/${add.body.id}`, { name: "Wall panels" }); assert.equal(patched.body.name, "Wall panels"); assert.equal(patched.body.nanoleaf.token, undefined, "nor after a change");
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

test("Philips Hue: pairs with the link button, each light gets its colour (rate-limited)", async () => {
  const http = await import("node:http"), { rgbToXy } = await import("../../outputs/src/hue.js"); let pressed = false; const puts = [];
  const xy = rgbToXy(255, 0, 0); assert.ok(xy.xy[0] > 0.6 && xy.bri === 254, "red is red"); assert.equal(rgbToXy(0, 0, 0).bri, 0);
  const bridge = http.createServer((q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { const j = o => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.method === "POST" && q.url === "/api") return j(pressed ? [{ success: { username: "USER1" } }] : [{ error: { type: 101, description: "link button not pressed" } }]);
    if (q.url === "/api/USER1/lights") return j({ 1: { name: "Sofa", state: { on: true, bri: 100, xy: [0.3, 0.3] } }, 2: { name: "Shelf", state: { on: true, bri: 100, xy: [0.3, 0.3] } }, 3: { name: "Plug", state: { on: true } } });
    const m = /^\/api\/USER1\/lights\/(\d+)\/state$/.exec(q.url); if (m && q.method === "PUT") { puts.push({ id: m[1], t: Date.now(), ...JSON.parse(b) }); return j([{ success: {} }]); }
    j([{ error: { type: 1, description: "unauthorized user" } }]); }); });
  await new Promise(r => bridge.listen(0, "127.0.0.1", r));
  const s = await setup(), host = `127.0.0.1:${bridge.address().port}`;
  try {
    const no = await s.call("POST", "/api/devices", { host, kind: "hue" }); assert.equal(no.status, 400); assert.match(no.body.error, /link button/);
    pressed = true; const add = await s.call("POST", "/api/devices", { host, kind: "hue" }); assert.equal(add.status, 200); assert.equal(add.body.leds, 2, "plugs without colour are left out");
    assert.equal(add.body.hue.user, undefined, "the bridge user name isn't sent to browsers");
    assert.equal((await s.call("PATCH", `/api/devices/${add.body.id}`, { name: "Lounge" })).body.hue.user, undefined, "nor after a change");
    await s.call("PATCH", "/api/show", { effect: "solar" });
    assert.ok(await until(() => puts.some(p => p.id === "1") && puts.some(p => p.id === "2")), "both lights get colours");
    await sleep(1000); const t0 = Date.now() - 1000, recent = puts.filter(p => p.t >= t0); assert.ok(recent.length <= 12, `at most about 10 commands a second (${recent.length})`);
    assert.ok(puts.every(p => p.on === false || (p.xy && p.bri > 0)));
  } finally { await s.done(); await new Promise(r => bridge.close(r)); }
});

test("your own effects: create, play, change, delete", async () => {
  const wled = await startFakeWled({ leds: 60 }), s = await setup();
  try {
    const add = await s.call("POST", "/api/devices", { host: wled.host }); await s.call("PATCH", `/api/devices/${add.body.id}`, { ddpPort: wled.ddpPort });
    assert.equal((await s.call("POST", "/api/custom-effects", { pattern: "nope" })).status, 400);
    assert.equal((await s.call("POST", "/api/custom-effects", { pattern: "wave", colors: ["red", "blue"] })).status, 400);
    const e = (await s.call("POST", "/api/custom-effects", { name: "Pink waves", pattern: "wave", axis: "x", drive: "time", colors: ["#ff0066", "#ff99cc"], speed: 2 })).body;
    assert.match(e.id, /^u-/); assert.ok((await s.call("GET", "/api/state")).body.effects.some(x => x.id === e.id && x.custom));
    assert.equal((await s.call("PATCH", "/api/show", { effect: e.id })).status, 200);
    const rgb = () => { const f = wled.lastFrame; let r = 0, g = 0, b = 0; for (let i = 0; i < f.length; i += 3) { r += f[i]; g += f[i + 1]; b += f[i + 2]; } return [r, g, b]; };
    assert.ok(await until(() => { const [r, g, b] = rgb(); return r > 500 && r > g * 2; }), "pink waves reach the LEDs");
    await s.call("PUT", `/api/custom-effects/${e.id}`, { ...e, colors: ["#00ff44", "#00aa22"] });
    assert.ok(await until(() => { const [r, g] = rgb(); return g > r * 2; }), "changing it changes the light");
    assert.equal((await s.call("DELETE", `/api/custom-effects/${e.id}`)).status, 200);
    const st = (await s.call("GET", "/api/state")).body; assert.ok(!st.effects.some(x => x.id === e.id)); assert.equal(st.show.mode, "auto", "deleting the playing effect goes back to automatic");
  } finally { await s.done(); wled.close(); }
});

test("Pro DJ Link: real packet layout, mixers and other packets, no tempo", async () => {
  const { parseBeat, parseOnAir, beatPacket, onAirPacket } = await import("../src/prolink.js");
  const b = beatPacket({ device: 3, name: "XDJ-XZ", bpm: 120, pitch: 0.95, beatInBar: 4 });
  assert.equal(b.length, 0x60); assert.equal(b[0x0a], 0x28); assert.equal(b.readUInt16BE(0x5a), 12000); assert.equal(b.readUIntBE(0x55, 3), Math.round(0.95 * 0x100000)); assert.equal(b[0x5c], 4); assert.equal(b[0x5f], 3);
  assert.equal(b.readUInt32BE(0x24), Math.round(60000 / 114), "next beat in ms");
  assert.equal(parseBeat(b).bpm, 114);
  const zero = beatPacket({ beatInBar: 0 }); assert.equal(parseBeat(zero).beatInBar, 0, "beat-in-bar 0 means unknown");
  const stopped = beatPacket({ pitch: 0 }); assert.equal(parseBeat(stopped), null, "pitch at -100%: no tempo");
  const other = Buffer.from(b); other[0x0a] = 0x02; assert.equal(parseBeat(other), null, "fader start and other packets aren't beats");
  assert.equal(parseBeat(b.subarray(0, 0x50)), null); assert.equal(parseBeat("text"), null);
  assert.deepEqual(parseOnAir(onAirPacket([2, 3])).onAir, { 1: false, 2: true, 3: true, 4: false }); assert.equal(parseOnAir(b), null);
});

test("Pro DJ Link: one deck leads, the grid is smooth and counts on, and a stopped deck lets go", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const rt = s.app.runtime, P = 60000 / 128, beat = (device, at, beatInBar, extra = {}) => rt.djBeat({ device, name: `CDJ ${device}`, bpm: 128, trackBpm: 128, pitch: 1, beatInBar, at, ...extra });
    const t0 = performance.now() - 20 * P, jitter = [0, 7, -4, 9, 2, -6, 8, 1, -3, 6, 0, 5, -2, 9, 3, -5];
    for (let k = 0; k < 16; k++) { beat(1, t0 + k * P + jitter[k], (k % 4) + 1); beat(2, t0 + k * P + 190, ((k + 2) % 4) + 1); } // deck 2 plays too, off the beat
    assert.equal(rt.rt.dj.device, 1, "the deck that was leading keeps the grid"); assert.equal(rt.rt.dj.beatInBar, 4);
    assert.ok(Math.abs(rt.rt.dj.at - (t0 + 15 * P)) < 6, `Wi-Fi jitter is smoothed (${(rt.rt.dj.at - t0 - 15 * P).toFixed(1)} ms off)`);
    const n = rt.rt.dj.n; assert.ok(n >= 15, "the beat counter counts on");
    beat(1, t0 + 17 * P, 2); assert.equal(rt.rt.dj.n, n + 2, "a lost packet still counts its beat");
    beat(1, t0 + 18 * P, 0); assert.equal(rt.rt.dj.beatInBar, 3, "beat-in-bar 0: counted on from the last beat");
    // a mixer echoing the tempo doesn't take over from a player; the mixer's on-air channels do decide between two players
    beat(0x21, t0 + 18 * P + 100, 1); assert.equal(rt.rt.dj.device, 1);
    rt.djOnAir({ device: 0x21, onAir: { 1: false, 2: true }, at: performance.now() }); beat(2, t0 + 18 * P + 190, 1);
    assert.equal(rt.rt.dj.device, 2, "the deck on air takes over"); assert.ok(rt.rt.dj.n > n + 2, "and the count doesn't go back");
    rt.djOnAir({ device: 0x21, onAir: { 1: true, 2: true }, at: performance.now() });
    // no audio: a steady show on the deck's beat; the grid in the view matches the deck
    for (let k = 19; k <= 20; k++) beat(2, performance.now() - (20 - k) * P - 5, ((k + 1) % 4) + 1);
    await sleep(60); let st = rt.status(); assert.equal(st.source, "djlink"); assert.equal(st.beat, rt.rt.dj.beatInBar - 1); assert.equal(rt.rt.view.g.idx, rt.rt.dj.n);
    // the deck stops: within about two beats the room falls back to nothing playing
    await sleep(2 * P + 400); st = rt.status(); assert.equal(st.source, "idle"); assert.equal(st.djlink, null);
    beat(1, performance.now(), 1); assert.equal(rt.rt.dj.device, 1, "a deck that starts later leads once the other has stopped");
  } finally { await s.done(); }
});

test("Pro DJ Link: in automatic mode the effect still changes every few bars", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true }); await s.call("PATCH", "/api/show", { mode: "auto", everyBeats: 4, style: "party" });
    const rt = s.app.runtime, P = 60000 / 180; let k = 0, seen = new Set();
    const timer = setInterval(() => rt.djBeat({ device: 1, name: "CDJ", bpm: 180, trackBpm: 180, pitch: 1, beatInBar: (k++ % 4) + 1, at: performance.now() }), P);
    await until(() => { seen.add(rt.status().effect); return seen.size >= 3; }, 9000); clearInterval(timer);
    assert.ok(seen.size >= 3, `effects shown: ${[...seen].join(", ")}`);
  } finally { await s.done(); }
});

test("Pro DJ Link: a port another app holds is reported, not silently ignored", { skip: process.platform === "win32" && "Windows lets both apps share the port (SO_REUSEADDR), so there is nothing to report" }, async () => {
  const s = await setup(), port = 52000 + Math.floor(Math.random() * 900), hog = dgram.createSocket({ type: "udp4", reuseAddr: false });
  try {
    await new Promise(r => hog.bind(port, r));
    await s.call("PATCH", "/api/settings", { djlink: { enabled: true, port } });
    assert.ok(await until(() => s.app.runtime.log.some(e => e.level === "warn" && /DJ Link can't listen.*in use/.test(e.msg))), "a warning in the log");
    await s.call("PATCH", "/api/settings", { djlink: { enabled: "false" } }); assert.equal(s.app.store.data.settings.djlink.enabled, false);
  } finally { hog.close(); await s.done(); }
});

test("your own effects: deleting one leaves nothing pointing at it; backups are checked; saving keeps the pads", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const e = (await s.call("POST", "/api/custom-effects", { name: "<img src=x onerror=alert(1)>", pattern: "breathe", tag: "calm", bg: 0, width: 0, speed: "NaN" })).body;
    assert.equal(e.bg, 0, "no background glow is a choice, not a missing value"); assert.equal(e.width, 0.01); assert.equal(e.speed, 1);
    assert.equal((await s.call("POST", "/api/custom-effects", "wave")).status, 400);
    // use it everywhere, then delete it
    await s.call("PATCH", "/api/settings", { ambient: e.id }); await s.call("PATCH", "/api/show", { layer: { effect: e.id, amount: 0.5 } });
    await s.call("PATCH", `/api/effects/${e.id}`, { pref: 1, params: { speed: 2 } });
    const sc = (await s.call("POST", "/api/scenes", { name: "Mine", show: { mode: "manual", effect: e.id, layer: { effect: e.id, amount: 1 } } })).body;
    await s.call("PUT", "/api/zones", { zones: [{ id: "z1", name: "Desk", mode: "effect", effect: e.id }] });
    const d = s.app.store.data; d.songs.push({ id: "m1", name: "Song", show: [{ t0: 0, t1: 10, part: "calm", effect: e.id }], showEdited: true }, { id: "m2", name: "Other", show: [{ t0: 0, t1: 10, part: "drop", effect: e.id }] });
    await s.call("PATCH", "/api/show", { effect: e.id }); assert.ok(await until(() => s.app.runtime.director.state.cur === e.id));
    s.app.runtime.action({ type: "blackout", on: true });
    assert.equal((await s.call("PUT", `/api/custom-effects/${e.id}`, { ...e, colors: ["#112233", "#445566"] })).status, 200);
    assert.equal(s.app.runtime.director.state.overlay.blackout, true, "saving an effect doesn't undo the blackout pad"); assert.equal(s.app.runtime.director.state.cur, e.id);
    s.app.runtime.action({ type: "cancel" });
    assert.equal((await s.call("DELETE", `/api/custom-effects/${e.id}`)).status, 200);
    const st = (await s.call("GET", "/api/state")).body, used = JSON.stringify({ settings: st.settings, show: st.show, scenes: st.scenes, room: st.room, songs: d.songs });
    assert.ok(!used.includes(e.id), "nothing points at the deleted effect"); assert.equal(st.settings.ambient, "northern", "the room doesn't go dark when idle");
    assert.equal(st.scenes.find(x => x.id === sc.id).show.mode, "auto"); assert.equal(st.room.zones[0].mode, "follow");
    assert.equal(d.songs[0].show[0].part, "calm"); assert.ok(st.effects.find(x => x.id === d.songs[0].show[0].effect).tag === "calm", "a hand-edited show gets a built-in effect for that part");
    assert.equal(d.songs[1].show, null, "a planned show is planned again");
    assert.equal((await s.call("PUT", "/api/songs/m1/show", { show: d.songs[0].show })).status, 200, "the edited show can still be saved");
    // restore: bad entries are dropped, ids are checked, at most 100
    const backup = (await s.call("GET", "/api/backup")).body;
    backup.data.customEffects = [{ id: "shock", pattern: "wave" }, { id: 'u-1"><script>', pattern: "wave" }, { id: "u-ok", pattern: "nope" }, { id: "u-good", pattern: "chase", speed: 1e9 }, { id: "u-good", pattern: "fill" },
      ...Array.from({ length: 150 }, (_, i) => ({ id: `u-n${i}`, pattern: "wave" }))];
    assert.equal((await s.call("POST", "/api/restore", backup)).status, 200);
    const ce = (await s.call("GET", "/api/custom-effects")).body; assert.equal(ce.length, 100); assert.equal(ce[0].id, "u-good"); assert.equal(ce[0].speed, 8); assert.equal(ce[0].pattern, "chase");
    assert.equal((await s.call("POST", "/api/custom-effects", { pattern: "wave" })).status, 400, "the 100-effect cap");
  } finally { await s.done(); }
});

test("other websites can't change things: cross-site API calls and WebSocket connections are refused", async () => {
  const s = await setup(), http = await import("node:http");
  try {
    const raw = (method, p, headers, body) => new Promise((res, rej) => { const r = http.request({ host: "127.0.0.1", port: s.port, method, path: p, headers: { "content-type": "application/json", ...headers } }, x => { let d = ""; x.on("data", c => d += c); x.on("end", () => res({ status: x.statusCode, body: d })); }); r.on("error", rej); if (body) r.write(body); r.end(); });
    assert.equal((await raw("POST", "/api/power", { origin: "https://evil.example" }, '{"on":false}')).status, 403);
    assert.equal((await raw("POST", "/api/power", { origin: "null" }, '{"on":false}')).status, 403, "sandboxed pages too");
    assert.equal(s.app.store.data.show.power, true, "nothing changed");
    assert.equal((await raw("POST", "/api/power", { origin: `http://127.0.0.1:${s.port}` }, '{"on":false}')).status, 200, "the app itself is fine");
    assert.equal((await raw("POST", "/api/power", {}, '{"on":true}')).status, 200, "scripts and Home Assistant send no Origin: fine");
    assert.equal((await raw("GET", "/api/state", { origin: "https://evil.example" })).status, 200, "reading is unchanged");
    const up = origin => new Promise(res => { const r = http.request({ host: "127.0.0.1", port: s.port, path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...(origin ? { origin } : {}) } });
      r.on("upgrade", (x, sock) => { sock.destroy(); res(101); }); r.on("response", x => res(x.statusCode)); r.on("error", () => res(0)); r.end(); });
    assert.equal(await up("https://evil.example"), 403); assert.equal(await up(`http://127.0.0.1:${s.port}`), 101); assert.equal(await up(null), 101);
  } finally { await s.done(); }
});

// song memory, harder cases: play remembered songs "live" through the capture source, half a second of audio at a time
async function playLive(s, x, gain = 0.9, each = () => {}) {
  const chunk = 11025; for (let i = 0; i < x.length; i += chunk) { const pcm = new Int16Array(chunk); for (let k = 0; k < chunk; k++) pcm[k] = Math.round(Math.max(-1, Math.min(1, (x[i + k] || 0) * gain)) * 32767);
    s.app.runtime.pushPcm(pcm, "capture", "Line in", null, 22050); await sleep(25); if (each(s.app.runtime.status().recognised, i / 22050) === false) return; }
}
async function rememberSong(s, name, song) { const pre = await preAnalyseCore(song.x, song.sr);
  await s.call("POST", "/api/song", { name, analysis: { ...pre, env: Array.from(pre.env) } }); await s.call("DELETE", "/api/song"); return pre; }

test("song memory: a loud song is followed through its repetitive drop to the end, then let go; nothing extra is saved", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await rememberSong(s, "Anthem", song), rec = [];
    await playLive(s, song.x, 0.95, (r, t) => { rec.push([t, r]); }); // nearly full scale: the live fingerprint must not clip
    const first = rec.findIndex(([, r]) => r); assert.ok(first >= 0 && rec[first][0] < 20, "recognised");
    const after = rec.slice(first).filter(([t]) => t < pre.dur - 2); assert.ok(after.every(([, r]) => r && r.name === "Anthem"), "never lets go mid-song");
    await playLive(s, new Float32Array(22050 * 4)); assert.equal(s.app.runtime.status().recognised, null, "the song ended: back to live listening");
    let wrong = 0; await playLive(s, ballad(22050).x, 0.9, r => { if (r) wrong++; }); assert.equal(wrong, 0, "an unknown song isn't taken for it");
    const saved = JSON.stringify(s.app.store.data.songs); assert.ok(!/_fp|_shape/.test(saved) && saved.length < 30000, `saved songs stay small (${saved.length})`);
  } finally { await s.done(); }
});

test("song memory: skipping to another remembered song follows the new one; turning memory off lets go", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const a = edm(22050), b = { x: edm(22050).x.reverse(), sr: 22050 }; await rememberSong(s, "Anthem", a); await rememberSong(s, "Backwards", b);
    let got = null; await playLive(s, a.x, 0.5, r => { got = r; return !r; }); assert.equal(got?.name, "Anthem");
    let switched = null; await playLive(s, b.x.subarray(3 * 22050), 0.5, (r, t) => { if (r && r.name === "Backwards") { switched = t; return false; } });
    assert.ok(switched != null && switched < 22, `follows the new song (after ${switched} s)`);
    await s.call("PATCH", "/api/settings", { songMemory: false }); await sleep(100); await playLive(s, b.x.subarray(25 * 22050, 27 * 22050), 0.5);
    assert.equal(s.app.runtime.status().recognised, null, "song memory off: stops following");
  } finally { await s.done(); }
});

test("key and mood: shown in /api/status for a played song; a drumless ballad heard live from its middle is recognised", async () => {
  const { minorBallad } = await import("../../engine/test/synth.js");
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = minorBallad(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Slow one", analysis: { ...pre, env: Array.from(pre.env) } });
    await s.call("POST", "/api/song/clock", { pos: 20, playing: true, rate: 1 }); await sleep(100);
    const st = (await s.call("GET", "/api/status")).body;
    assert.deepEqual([st.key?.name, st.mood?.name, st.hears], ["F# minor", "melancholic", "F# minor · melancholic"]);
    assert.ok(st.mood.valence < 0.5 && st.mood.energy < 0.5 && st.key.confidence > 0.3, JSON.stringify(st.mood));
    assert.equal(s.app.store.data.settings.moodColours, true, "mood colours are on by default");
    await s.call("PATCH", "/api/settings", { moodColours: false }); assert.equal(s.app.runtime.director.settings.moodColours, false, "the setting reaches the director");
    await s.call("DELETE", "/api/song");
    const saved = s.app.store.data.songs[0]; assert.ok(saved.ch && saved.key === "F#" && saved.mood, "remembered with its chroma, key and mood");
    let found = null, heard = 0; await playLive(s, song.x.subarray(30 * 22050), 0.6, (r, t) => { if (r) { found = r; heard = t; return false; } });
    assert.ok(found && found.name === "Slow one" && heard < 20, `recognised after ${heard} s`);
    const truth = 30 + s.app.runtime.rt.live.an.t; assert.ok(Math.abs(found.pos - truth) < 0.4, `position ${found.pos} vs ${truth}`);
    assert.equal(s.app.runtime.status().hears, "F# minor · melancholic", "a recognised song shows its stored key and mood");
  } finally { await s.done(); }
});

test("shows: edits that overlap, don't fit the song or aren't numbers are refused; long songs and many songs fit the budget", async () => {
  const s = await setup();
  try {
    const song = edm(22050), pre = await rememberSong(s, "Showtime", song), id = (await s.call("GET", "/api/songs")).body[0].id;
    const put = show => s.call("PUT", `/api/songs/${id}/show`, { show });
    assert.equal((await put([{ t0: 0, t1: 20, effect: "laser" }, { t0: 10, t1: 30, effect: "solar" }])).status, 400, "overlap");
    assert.equal((await put([{ t0: 0, t1: "1e999", effect: "laser" }])).status, 400, "not a finite number");
    assert.equal((await put([{ t0: pre.dur + 50, t1: pre.dur + 60, effect: "laser" }])).status, 400, "after the song ends");
    const ok = await put([{ t0: 10, t1: 9999, effect: "solar" }, { t0: 0, t1: 10, effect: "laser" }]); assert.equal(ok.status, 200, "unsorted is fine");
    assert.deepEqual(ok.body.show.map(b => [b.t0, b.effect]), [[0, "laser"], [10, "solar"]]); assert.ok(ok.body.show[1].t1 <= pre.dur + 1.01, "clipped to the song");
    const rt = s.app.runtime, big = { ...pre, dur: 9000, kicks: Array.from({ length: 60000 }, (_, i) => i * 0.13), env: new Float32Array(450000) };
    assert.ok(rt.remember("A whole DJ set", big) === null, "too long to remember"); assert.ok(!s.app.store.data.songs.some(e => e.name === "A whole DJ set"));
    const mid = { ...pre, kicks: Array.from({ length: 4000 }, (_, i) => i * 0.4567), dur: 1800 };
    for (let i = 0; i < 80; i++) rt.remember(`Song ${i}`, i % 2 ? mid : pre);
    const list = s.app.store.data.songs; assert.ok(list.length <= 60 && JSON.stringify(list).length <= 2000000, `${list.length} songs, ${JSON.stringify(list).length} chars`);
    assert.equal(list.at(-1).name, "Song 79", "the newest are kept");
  } finally { await s.done(); }
});
