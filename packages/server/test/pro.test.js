// DMX fixtures, MIDI clock and Ableton Link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createFixtures, aim, FOG_WINDOW } from "../src/fixtures.js";
import { createMidiClock, TICK, START, STOP, CONTINUE, SPP } from "../src/midiclock.js";
import { parseDiscovery, discoveryMessage, parseMeasurement, pingMessage, pongMessage, pongPoints, startLink, ALIVE, BYEBYE, PONG } from "../src/ableton-link.js";
import { startFakeLinkPeer } from "../../../scripts/fake-link.js";
import { metronomeView, gridAt } from "../../engine/src/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-pro-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, call, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const freePort = async () => { const s = dgram.createSocket("udp4"); await new Promise(r => s.bind(0, "127.0.0.1", r)); const p = s.address().port; s.close(); return p; };

// a music view: the metronome's beat grid, with a song part and drops put where a test wants them
const view = (t, o = {}) => ({ ...metronomeView(t, 120), state: "calm", dropT: -9, nextDrop: null, ...o });
const FOG = { id: "fog1", name: "Fog", profile: "fog", address: 1 }, LASER = { id: "las1", name: "Laser", profile: "laser", address: 2 };
const dev = { id: "d1", fixtures: [FOG, LASER, { id: "h1", name: "Head", profile: "moving-head", address: 10 }, { id: "s1", name: "Strobe", profile: "strobe", address: 30 }] };
const rgb = new Uint8Array(12).fill(200);
function frame(F, wall, V, t, cfg, extra = {}) { F.begin({ V, t, wall, cfg, ...extra }); return F.render(dev, rgb, [[2, 1], [4, 1], [8, 1], [12, 1]]); }

test("DMX fog: a burst before a known drop, a cool-down between bursts, never when off", () => {
  const F = createFixtures(), cfg = { fog: true, fogWhen: "before", fogLead: 4, fogBurst: 3, fogCooldown: 60, fogMaxDuty: 0.2 };
  // fog off (the default): nothing, even right before a drop
  for (let w = 0; w < 10; w += 0.1) assert.equal(frame(F, w, view(90 + w, { state: "build", nextDrop: 96 }), 90 + w, {})[0], 0);
  const F2 = createFixtures(); let on = [];
  for (let w = 0; w <= 20; w = Math.round((w + 0.1) * 10) / 10) { const t = 90 + w, V = t < 96 ? view(t, { state: "build", nextDrop: 96 }) : view(t, { state: "drop", dropT: 96, nextDrop: 200 });
    if (frame(F2, w, V, t, cfg)[0] === 255) on.push(w); }
  assert.ok(on.length, "fog came on"); assert.ok(Math.abs(on[0] - 2) < 0.15, `fog starts 4 s before the drop (at ${on[0]})`);
  assert.ok(Math.abs(on.at(-1) - on[0] - 3) < 0.15, "the burst lasts 3 s"); assert.ok(on.length < 32, "one burst only for one drop");
  // another drop 30 s later: still cooling down; one 80 s later: fog again
  let second = false; for (let w = 40; w < 50; w += 0.1) second ||= frame(F2, w, view(200 + w - 40, { state: "build", nextDrop: 205 }), 200 + w - 40, cfg)[0] > 0;
  assert.equal(second, false, "no fog during the cool-down"); assert.match(F2.status(45).fog.why, /Cooling down/);
  let third = false; for (let w = 90; w < 100; w += 0.1) third ||= frame(F2, w, view(300 + w - 90, { state: "build", nextDrop: 305 }), 300 + w - 90, cfg)[0] > 0;
  assert.ok(third, "fog again once the cool-down is over");
  // live audio: no drop known in advance, so the burst comes at the drop
  const F3 = createFixtures(); let at = null;
  for (let w = 0; w < 10; w = Math.round((w + 0.1) * 10) / 10) { const t = 50 + w, V = t < 55 ? view(t, { state: "build" }) : view(t, { state: "drop", dropT: 55 }); if (frame(F3, w, V, t, cfg)[0] > 0 && at == null) at = w; }
  assert.ok(Math.abs(at - 5) < 0.15, `fog at the drop (at ${at})`);
  // lights off, DMX master off: no fog
  const F4 = createFixtures(); let any = false;
  for (let w = 0; w < 10; w += 0.1) { const t = 90 + w, V = view(t, { state: "build", nextDrop: 96 }); any ||= frame(F4, w, V, t, cfg, { power: false })[0] > 0 || frame(F4, w, V, t, { ...cfg, enabled: false })[0] > 0; }
  assert.equal(any, false);
});

test("DMX fog: the duty cycle caps bursts; the manual fog pad", () => {
  const F = createFixtures(), cfg = { fog: true, fogWhen: "drop", fogBurst: 5, fogCooldown: 10, fogMaxDuty: 0.02 }; // 6 s of fog in 5 minutes
  const fogFor = (w0, drop) => { let n = 0; for (let w = w0; w < w0 + 20; w = Math.round((w + 0.1) * 10) / 10) { const t = drop - 5 + (w - w0), V = t < drop ? view(t, { state: "build" }) : view(t, { state: "drop", dropT: drop }); if (frame(F, w, V, t, cfg)[0] > 0) n++; } return n / 10; };
  assert.ok(Math.abs(fogFor(0, 100) - 5) < 0.2, "first burst: 5 s");
  assert.ok(Math.abs(fogFor(30, 200) - 1) < 0.2, "second burst: only what's left of 6 s");
  assert.equal(fogFor(60, 300), 0, "then none"); assert.match(F.status(80).fog.why, /duty/);
  assert.equal(fogFor(30 + FOG_WINDOW + 10, 400), 5, "back after the window has passed");
  // manual pad
  const M = createFixtures(), mc = { fog: true, fogMaxDuty: 0.1 };
  frame(M, 0, null, 0, mc); assert.equal(M.manualFog(true, 0).ok, true); assert.equal(frame(M, 0.1, null, 0.1, mc)[0], 255, "fog while held");
  M.manualFog(false, 1); assert.equal(frame(M, 1.1, null, 1.1, mc)[0], 0, "stops when released");
  M.manualFog(true, 2); let w = 2.1; while (w < 20 && frame(M, w, null, w, mc)[0]) w += 0.1; assert.ok(Math.abs(w - 12) < 0.2, `held too long: stops after 10 s (${w})`);
  const off = createFixtures(); frame(off, 0, null, 0, {}); assert.equal(off.manualFog(true, 0).ok, false, "manual fog refused while fog is off"); assert.equal(frame(off, 0.1, null, 0.1, {})[0], 0);
});

test("DMX lasers: only during drops, never in safe mode, night mode, blackout, or when off", () => {
  const F = createFixtures(), on = { lasers: true }, drop = t => view(t, { state: "drop", dropT: t - 2 });
  assert.equal(frame(F, 0, drop(10), 10, {})[1], 0, "off by default");
  assert.equal(frame(F, 0, drop(10), 10, on)[1], 255, "on during a drop");
  assert.equal(frame(F, 0, view(10, { state: "calm" }), 10, on)[1], 0, "not in a calm part");
  assert.equal(frame(F, 0, view(10, { state: "build", nextDrop: 12 }), 10, on)[1], 0, "not in a build-up");
  assert.equal(frame(F, 0, metronomeView(10, 128), 10, on)[1], 0, "not for the metronome's endless 'drop'");
  assert.equal(frame(F, 0, view(100, { state: "drop", dropT: 10 }), 100, on)[1], 0, "not after laserMaxSec");
  assert.equal(frame(F, 0, drop(10), 10, on, { safe: true })[1], 0, "safe mode");
  assert.equal(frame(F, 0, drop(10), 10, on, { night: true })[1], 0, "night mode");
  assert.equal(frame(F, 0, drop(10), 10, on, { overlay: { blackout: true } })[1], 0, "blackout");
  assert.equal(frame(F, 0, drop(10), 10, on, { power: false })[1], 0, "lights off");
  assert.equal(frame(F, 0, null, 10, on)[1], 0, "nothing playing");
  frame(F, 0, drop(10), 10, on, { safe: true }); assert.match(F.status().lasers.why, /safe/);
  // strobes: the strobe pad and the start of a drop, never in safe mode
  const start = view(10, { state: "drop", dropT: 9.5 }); assert.ok(frame(F, 0, start, 10, {})[30] > 0, "strobe at the start of a drop"); assert.equal(frame(F, 0, start, 10, {}, { safe: true })[30], 0); assert.equal(frame(F, 0, start, 10, {}, { night: true })[30], 0);
  assert.ok(frame(F, 0, view(10), 10, {}, { overlay: { strobe: true } })[30] > 0); assert.equal(frame(F, 0, view(10), 10, {})[30], 0);
});

test("DMX moving heads move on the beat, brighten on drops, and can point at a place in the room", () => {
  const F = createFixtures(), pans = [];
  for (let t = 10; t < 14; t += 0.5) pans.push(frame(F, t, view(t), t, {})[9]);
  assert.ok(new Set(pans).size >= 5, `pan moves from beat to beat: ${pans}`);
  const calm = frame(F, 0, view(20, { loud: 0.2 }), 20, {})[12], dropped = frame(F, 0, view(20, { state: "drop", dropT: 19.5, loud: 0.2 }), 20, {})[12];
  assert.ok(dropped > calm + 60, `brighter on a drop (${calm} -> ${dropped})`);
  assert.equal(frame(F, 0, view(20), 20, {}, { overlay: { blackout: true } })[12], 0, "dark in a blackout");
  assert.deepEqual(aim([8, 1], [8, 1]), [0.5, 0.5]); const [p, t] = aim([8, 1], [12, 5]); assert.ok(p > 0.5 && t > 0.5, "right and down");
  const P = createFixtures(), d = { id: "p", fixtures: [{ id: "x", profile: "moving-head-16", address: 1, pattern: "point", target: [8, 5] }] };
  P.begin({ V: view(5), t: 5, wall: 5 }); const u = P.render(d, rgb, [[8, 1]]); const tilt = (u[2] << 8 | u[3]) / 65535;
  assert.ok(Math.abs((u[0] << 8 | u[1]) / 65535 - 0.5) < 0.001, "straight ahead in pan"); assert.ok(Math.abs(tilt - aim([8, 1], [8, 5])[1]) < 0.02);
});

test("DMX devices end to end: fixtures added by API, Art-Net and sACN packets with each fixture's values, live channel view", async () => {
  const rx = dgram.createSocket("udp4"), got = []; rx.on("message", b => got.push(b)); await new Promise(r => rx.bind(0, "127.0.0.1", r));
  const s = await setup();
  try {
    assert.equal(s.app.store.data.settings.dmx.lasers, false, "lasers off by default"); assert.equal(s.app.store.data.settings.dmx.fog, false, "fog off by default");
    const add = await s.call("POST", "/api/devices", { kind: "dmx", host: `127.0.0.1:${rx.address().port}`, name: "Truss", universe: 2 }); assert.equal(add.status, 200, JSON.stringify(add.body));
    const id = add.body.id; assert.equal(add.body.kind, "dmx"); assert.equal(add.body.protocol, "artnet");
    const fx = async b => (await s.call("POST", `/api/devices/${id}/fixtures`, b));
    assert.equal((await fx({ profile: "rgb", address: 1, name: "Par L" })).status, 200);
    assert.equal((await fx({ profile: "rgbw", address: 4, name: "Par R", x: 14, y: 2 })).status, 200);
    assert.equal((await fx({ profile: "moving-head-16", address: 10, name: "Head", pattern: "figure8" })).status, 200);
    assert.equal((await fx({ profile: "laser", address: 30 })).status, 200); assert.equal((await fx({ profile: "fog", address: 40 })).status, 200);
    assert.equal((await fx({ profile: "custom", address: 50, channels: ["dimmer", "red", "green", "blue", "fixed:42"] })).status, 200);
    assert.equal((await fx({ profile: "moving-head", address: 509 })).status, 400, "past channel 512");
    assert.equal((await fx({ profile: "nope", address: 1 })).status, 400); assert.equal((await fx({ profile: "custom", address: 1, channels: ["sparkle"] })).status, 400);
    const ov = await fx({ profile: "dimmer", address: 2 }); assert.match(ov.body.warnings.join(), /share DMX channels/);
    await s.call("DELETE", `/api/devices/${id}/fixtures/${ov.body.fixture.id}`);
    const shape = s.app.store.data.room.shapes.find(x => x.dev === id); assert.equal(shape.type, "points"); assert.equal(shape.count, 6); assert.deepEqual(shape.pts[1], [14, 2]);
    await s.call("POST", "/api/action", { type: "hold", color: "#ff0000" }); // every point red
    got.length = 0; await until(() => got.length > 5);
    const p = got.at(-1); assert.equal(p.toString("latin1", 0, 7), "Art-Net"); assert.equal(p[14], 2, "universe 2"); assert.equal(p.readUInt16BE(16), 512);
    const ch = n => p[18 + n - 1];
    assert.ok(ch(1) > 100 && ch(2) === 0 && ch(3) === 0, "par L red"); assert.ok(ch(4) > 100 && ch(5) === 0 && ch(7) === 0, "par R red, no white");
    assert.ok(ch(15) > 0, "head dimmer up"); assert.equal(ch(17), 255, "head red at full strength");
    assert.equal(ch(30), 0, "laser off (lasers not enabled)"); assert.equal(ch(40), 0, "fog off (fog not enabled)");
    assert.equal(ch(51), 255); assert.equal(ch(54), 42, "custom fixed channel");
    const live = (await s.call("GET", "/api/dmx")).body.devices[0]; assert.equal(live.values.length, 512); assert.equal(live.fixtures[5].live[4].value, 42); assert.equal(live.fixtures[2].kind, "head");
    // manual fog: refused while fog is off; with fog on, the fog channel comes up
    await s.call("POST", "/api/action", { type: "fog", on: true }); await sleep(100); assert.equal((await s.call("GET", "/api/dmx")).body.devices[0].values[39], 0);
    await s.call("PATCH", "/api/settings", { dmx: { fog: true } }); await s.call("POST", "/api/action", { type: "fog", on: true });
    assert.ok(await until(async () => (await s.call("GET", "/api/dmx")).body.devices[0].values[39] === 255, 2000), "manual fog");
    await s.call("POST", "/api/action", { type: "fog", on: false }); assert.ok(await until(async () => (await s.call("GET", "/api/dmx")).body.devices[0].values[39] === 0, 2000));
    // power off: everything dark but DMX keeps being sent (nodes hold the last values)
    await s.call("POST", "/api/power", { on: false }); await sleep(200); got.length = 0; await until(() => got.length > 3);
    assert.ok(got.length > 3, "still sending"); assert.equal(got.at(-1)[18], 0); assert.equal(got.at(-1)[18 + 14], 0, "head dimmer 0");
    // sACN
    assert.equal((await s.call("PATCH", `/api/devices/${id}`, { protocol: "ddp" })).status, 400);
    await s.call("PATCH", `/api/devices/${id}`, { protocol: "e131", universe: 5 }); got.length = 0; await until(() => got.some(b => b.toString("latin1", 4, 13) === "ASC-E1.17"));
    const e = got.findLast(b => b.toString("latin1", 4, 13) === "ASC-E1.17"); assert.ok(e, "sACN packets"); assert.equal(e.readUInt16BE(113), 5); assert.equal(e.length, 126 + 512);
    assert.ok((await s.call("GET", "/api/status")).body.dmx, "status has the DMX state");
  } finally { await s.done(); rx.close(); }
});

// ---------------------------------------------------------------- MIDI clock
function feed(c, { bpm, from = 0, beats = 8, jitter = 0, t0 = 1000, seed = 1 }) {
  let r = seed; const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const ms = 60000 / bpm / 24; let t = t0;
  for (let k = 0; k < beats * 24; k++) { c.event(TICK, t + rnd() * jitter); t += ms; }
  return t;
}
test("MIDI clock: steady tempo through jitter, beats on the clocks, bar from Start and Song Position Pointer", () => {
  const c = createMidiClock(); c.event(START, 999);
  const end = feed(c, { bpm: 124, beats: 8, jitter: 2.5 });
  const now = end - 60000 / 124 / 24; // the last clock
  assert.ok(Math.abs(c.bpm - 124) < 0.4, `tempo ${c.bpm}`);
  const g = c.grid(now, 50), G = gridAt(g, 50); assert.equal(G.idx % 4, 3, "8 beats in: the last clock is in beat 7, the 4th of its bar"); assert.ok(G.phase > 0.9, `phase ${G.phase}`);
  assert.ok(Math.abs(gridAt(c.grid(1000 + 4 * 60000 / 124, 10), 10).phase - 0) < 0.03 || gridAt(c.grid(1000 + 4 * 60000 / 124, 10), 10).phase > 0.97, "beat 4 lands on clock 96");
  // tempo change
  const end2 = feed(c, { bpm: 140, beats: 4, t0: end, jitter: 1 }); assert.ok(Math.abs(c.bpm - 140) < 1, `follows the new tempo: ${c.bpm}`);
  // stop: no grid; clocks while stopped don't count
  c.event(STOP, end2); assert.equal(c.grid(end2 + 5, 1), null); feed(c, { bpm: 140, beats: 2, t0: end2 + 10 }); assert.equal(c.grid(end2 + 600, 1), null);
  // song position 2 bars + 1 beat (36 16ths), continue: the next clock is beat 9
  c.event(SPP, end2 + 700, 36); c.event(CONTINUE, end2 + 701); const e3 = feed(c, { bpm: 140, beats: 1, t0: end2 + 702 });
  const G3 = gridAt(c.grid(e3 - 60000 / 140 / 24, 0), 0); assert.equal(G3.idx, 9); assert.equal(G3.beatInBar, 1);
  // nothing for half a second: not running
  assert.equal(c.grid(e3 + 600, 0), null); assert.equal(c.status(e3 + 600).running, false);
});

test("MIDI clock over the WebSocket: the server follows a browser's clock as the beat grid", async () => {
  const s = await setup();
  try {
    const sent = [], c = { data: {}, open: true, busy: false, send() {}, sendJSON: m => sent.push(m) }, h = s.app.core.connect(c, {});
    const P = 60000 / 132, tick = P / 24, t0 = performance.now(); let k = 0;
    h.message(JSON.stringify({ type: "midi-clock", events: [[START, t0]], now: performance.now(), label: "TR-8" }), false);
    const timer = setInterval(() => { const now = performance.now(), ev = []; while (t0 + k * tick <= now) { ev.push([TICK, t0 + k * tick]); k++; }
      h.message(JSON.stringify({ type: "midi-clock", events: ev, now: performance.now(), label: "TR-8" }), false); }, 40); timer.unref(); // a failed assertion skips clearInterval: don't keep the test file alive
    assert.ok(await until(() => s.app.runtime.rt.source === "midiclock", 3000), `source ${s.app.runtime.rt.source}`);
    const st = s.app.runtime.status(); assert.ok(Math.abs(st.bpm - 132) < 0.6, `bpm ${st.bpm}`); assert.equal(st.midiClock.input, "TR-8"); assert.match(st.sourceLabel, /MIDI clock/);
    const beat = (performance.now() - t0) / P, V = s.app.runtime.rt.view; assert.ok(Math.abs(((V.g.idx + V.g.phase) - beat + 0.5) % 1 - 0.5) < 0.08, "phase follows the clocks");
    clearInterval(timer); h.close(); assert.equal(s.app.runtime.status().midiClock, null, "the browser went away");
  } finally { await s.done(); }
});

// ---------------------------------------------------------------- Ableton Link
test("Ableton Link wire format: discovery and measurement messages", () => {
  const msg = discoveryMessage({ type: ALIVE, ttl: 5, nodeId: "0102030405060708", sessionId: "0102030405060708", timeline: { microsPerBeat: 500000, beatOrigin: 4000000, timeOrigin: 123456789 }, playing: true, endpoint: { address: "192.168.1.9", port: 50123 } });
  assert.equal(msg.toString("latin1", 0, 7), "_asdp_v"); assert.equal(msg[7], 1); assert.equal(msg[8], 1); assert.equal(msg[9], 5); assert.equal(msg.readUInt16BE(10), 0);
  assert.equal(msg.subarray(12, 20).toString("hex"), "0102030405060708"); assert.equal(msg.toString("latin1", 20, 24), "tmln"); assert.equal(msg.readUInt32BE(24), 24); assert.equal(Number(msg.readBigInt64BE(28)), 500000);
  const m = parseDiscovery(msg); assert.deepEqual(m.timeline, { microsPerBeat: 500000, beatOrigin: 4000000, timeOrigin: 123456789 }); assert.equal(m.playing, true); assert.deepEqual(m.endpoint, { address: "192.168.1.9", port: 50123 });
  // an unknown entry is skipped by its size
  const odd = Buffer.concat([msg.subarray(0, 20), Buffer.from("zzzz\0\0\0\x03abc", "latin1"), msg.subarray(20)]); assert.equal(parseDiscovery(odd).timeline.microsPerBeat, 500000);
  assert.equal(parseDiscovery(discoveryMessage({ type: BYEBYE, nodeId: "0102030405060708" })).type, BYEBYE); assert.equal(parseDiscovery(Buffer.from("nonsense here, not link")), null);
  const ping = pingMessage(1000, 777); assert.equal(ping.toString("latin1", 0, 8), "_link_v\x01"); assert.equal(ping[8], 1);
  const pong = parseMeasurement(pongMessage("0102030405060708", 51000, parseMeasurement(ping).payload)); assert.equal(pong.type, PONG); assert.equal(pong.ghostTime, 51000); assert.equal(pong.hostTime, 1000); assert.equal(pong.prevGhostTime, 777);
  assert.deepEqual(pongPoints({ ghostTime: 51000, hostTime: 1000, prevGhostTime: 50000 }, 1200), [51000 - 1100, 50500 - 1000]);
});

test("Ableton Link: a fake peer's tempo, beat and clock offset are followed, tempo changes and leaving too", async () => {
  const port = await freePort(), peer = await startFakeLinkPeer({ bpm: 123, targets: [{ address: "127.0.0.1", port }] });
  let st = null; const L = startLink({ port, onState: x => { st = x; } });
  try {
    assert.ok(await until(() => st && st.measured, 4000), "measured the peer's clock"); assert.ok(peer.pings > 10);
    assert.equal(st.peers, 1); assert.ok(Math.abs(st.offset - 987654321) < 2000, `offset ${st.offset}`); assert.ok(Math.abs(60e6 / st.microsPerBeat - 123) < 0.01);
    const beatsAt = ms => st.beatOrigin / 1e6 + (ms * 1000 + st.offset - st.timeOrigin) / st.microsPerBeat, now = performance.now();
    assert.ok(Math.abs(beatsAt(now) - peer.beatsAt(now)) < 0.01, `beat ${beatsAt(now)} vs ${peer.beatsAt(now)}`);
    const before = peer.beatsAt(performance.now()); peer.setTempo(140);
    assert.ok(await until(() => Math.abs(60e6 / st.microsPerBeat - 140) < 0.01, 2000), "new tempo"); const n2 = performance.now();
    assert.ok(Math.abs(beatsAt(n2) - peer.beatsAt(n2)) < 0.01 && peer.beatsAt(n2) > before, "beat carries on through the change");
    peer.close(); assert.ok(await until(() => st.peers === 0, 2000), "peer said bye-bye");
  } finally { L.close(); peer.close(); }
  // a peer that never answers pings: not measured, and it says why
  const port2 = await freePort(), mute = await startFakeLinkPeer({ bpm: 100, targets: [{ address: "127.0.0.1", port: port2 }], answerPings: false }); let s2 = null;
  const L2 = startLink({ port: port2, onState: x => { s2 = x; } });
  try { assert.ok(await until(() => s2 && s2.error, 3000)); assert.equal(s2.measured, false); assert.match(s2.error, /didn't answer/); } finally { L2.close(); mute.close(); }
});

test("Ableton Link in the server: a Settings toggle, the session's beat as the beat grid", async () => {
  const s = await setup(), port = await freePort(), peer = await startFakeLinkPeer({ bpm: 126, targets: [{ address: "127.0.0.1", port }] });
  try {
    assert.equal(s.app.store.data.settings.link.enabled, false, "off by default");
    await s.call("PATCH", "/api/settings", { link: { enabled: true, port } });
    assert.ok(await until(() => s.app.runtime.rt.source === "link", 4000), `source ${s.app.runtime.rt.source}`);
    const st = (await s.call("GET", "/api/status")).body; assert.equal(st.link.peers, 1); assert.equal(st.link.following, true); assert.ok(Math.abs(st.bpm - 126) < 0.2); assert.match(st.sourceLabel, /Ableton Link/);
    const V = s.app.runtime.rt.view, b = peer.beatsAt(performance.now()); assert.ok(Math.abs(((V.g.idx + V.g.phase) - b + 0.5) % 1 - 0.5) < 0.05, "on the session's beat"); assert.equal(V.g.beatInBar, ((Math.floor(b) % 4) + 4) % 4);
    await s.call("PATCH", "/api/settings", { link: { enabled: false } }); assert.ok(await until(() => s.app.runtime.rt.source !== "link", 2000));
  } finally { peer.close(); await s.done(); }
});
