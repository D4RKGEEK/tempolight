import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { deviceLatency, audioDelay, noteRtt, level, ANALYSIS_MS } from "../src/latency.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
const kinds = r => r.warnings.map(w => w.kind).sort();

test("latency: audio + analysis + network + frame - offset, with a colour", () => {
  const h = { online: true, rttMs: 10, signal: 90, live: true, fps: 60 };
  const r = deviceLatency({ dev: { id: "a", enabled: true }, health: h, fps: 50, offsetMs: 0, audio: { audioMs: 30, analysisMs: ANALYSIS_MS } });
  assert.equal(r.latency.networkMs, 5, "UDP one way is half the HTTP round trip");
  assert.equal(r.latency.frameMs, 20);
  assert.equal(r.latencyMs, 30 + ANALYSIS_MS + 5 + 20); assert.equal(r.latencyLevel, "ok"); assert.deepEqual(r.warnings, []);
  const early = deviceLatency({ dev: { id: "a" }, health: h, fps: 50, offsetMs: 150, audio: { audioMs: 0, analysisMs: 0 } });
  assert.equal(early.latencyMs, 5 + 20 - 150, "a positive timing offset shows the light earlier"); assert.equal(early.latencyLevel, "slow");
  assert.equal(deviceLatency({ dev: { id: "v", virtual: true }, health: { online: true }, fps: 60 }).latency.networkMs, 0);
  assert.equal(deviceLatency({ dev: { id: "h", kind: "hue" }, health: { online: true, rttMs: 20 }, fps: 60 }).latency.frameMs, 100, "Hue updates slowly");
  assert.deepEqual([level(null), level(12), level(-50), level(120)], ["none", "good", "ok", "slow"]);
});

test("latency: the audio part depends on the source", () => {
  assert.deepEqual(audioDelay({ source: "song", live: { kind: "browser", inMs: 40 } }), { audioMs: 0, analysisMs: 0 }, "songs follow their play clock");
  assert.deepEqual(audioDelay({ source: "browser", live: { kind: "browser", inMs: 40, chunkMs: 23 } }), { audioMs: 40, analysisMs: ANALYSIS_MS });
  assert.deepEqual(audioDelay({ source: "capture", live: { kind: "capture", chunkMs: 46.4 } }), { audioMs: 46, analysisMs: ANALYSIS_MS });
  assert.deepEqual(audioDelay({ source: "idle", live: null }), { audioMs: 0, analysisMs: 0 });
  const h = {}; for (const ms of [30, 8, 12, 50]) noteRtt(h, ms); assert.equal(h.rttMs, 8, "the best recent round trip (WLED busy time isn't network)");
  for (let i = 0; i < 6; i++) noteRtt(h, 20); assert.equal(h.rttMs, 20, "old round trips are forgotten");
});

test("latency warnings: offline, weak Wi-Fi, dropped frames, not live, power limits", () => {
  const dev = { id: "a", enabled: true }, base = { online: true, rttMs: 4, signal: 90, rssi: -50, live: true, fps: 58 };
  const w = (health, more = {}) => kinds(deviceLatency({ dev, health: { ...base, ...health }, fps: 60, streaming: true, streamingFor: 10, ...more }));
  assert.deepEqual(w({}), []);
  const off = deviceLatency({ dev, health: { online: false, error: "timeout" }, fps: 60 }); assert.deepEqual(kinds(off), ["offline"]); assert.equal(off.latencyMs, null);
  assert.deepEqual(w({ signal: 35 }), ["wifi"]); assert.match(deviceLatency({ dev, health: { ...base, signal: 15 }, fps: 60 }).warnings[0].text, /Very weak/);
  assert.deepEqual(w({ signal: undefined, rssi: -80 }), ["wifi"], "rssi alone is enough");
  assert.deepEqual(w({ fps: 20 }), ["frames"]); assert.match(deviceLatency({ dev, health: { ...base, fps: 20 }, fps: 60, streaming: true, streamingFor: 10 }).warnings[0].text, /20 of the 60/);
  assert.deepEqual(w({ fps: 20 }, { streamingFor: 1 }), [], "no frame warning before the controller had time to catch up");
  assert.deepEqual(w({ fps: 0 }), [], "fps 0 means WLED doesn't say");
  assert.deepEqual(w({ live: false }), ["notlive"]); assert.deepEqual(w({ live: false }, { streaming: false }), [], "not streaming (power off)");
  assert.deepEqual(w({ power: 845, maxPower: 850 }), ["power"]);
  assert.deepEqual(w({}, { out: { limited: true } }), ["power"]);
  assert.deepEqual(kinds(deviceLatency({ dev: { id: "g", kind: "govee" }, health: { online: true, live: false, fps: 1 }, fps: 60, streamingFor: 10 })), [], "only WLED reports fps and live");
  assert.deepEqual(w({ rttMs: 200 }), ["slow"]);
});

test("GET /api/status: devices carry latencyMs and warnings from the real WLED checks", async () => {
  const wled = await startFakeWled({ leds: 60 }), dir = mkdtempSync(path.join(os.tmpdir(), "tl-lat-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => (await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const dev = () => call("GET", "/api/status").then(s => s.devices[0]);
  try {
    const d = await call("POST", "/api/devices", { host: wled.host }); await call("PATCH", `/api/devices/${d.id}`, { ddpPort: wled.ddpPort });
    assert.ok(await until(() => wled.frames > 20));
    let h = await call("POST", `/api/devices/${d.id}/check`);
    assert.ok(h.rttMs >= 0, "the round trip was measured");
    h = await dev(); assert.equal(typeof h.latencyMs, "number"); assert.ok(h.latency.networkMs >= 0 && h.latency.frameMs > 0); assert.equal(h.latencyLevel, "good");
    assert.deepEqual(h.warnings, []); assert.equal(h.rtts, undefined, "the raw samples stay on the server");
    wled.override.wifi = { signal: 20, rssi: -86 }; await call("POST", `/api/devices/${d.id}/check`);
    h = await dev(); assert.deepEqual(kinds(h), ["wifi"]);
    // after a few seconds of streaming, a controller that shows far fewer frames than we send is reported
    wled.override = { leds: { fps: 9 } }; await sleep(4300); await call("POST", `/api/devices/${d.id}/check`);
    h = await dev(); assert.deepEqual(kinds(h), ["frames"]);
    wled.override = { live: false }; await call("POST", `/api/devices/${d.id}/check`); assert.deepEqual(kinds(await dev()), ["notlive"]);
    wled.override = {}; await call("PATCH", `/api/devices/${d.id}`, { maxAmps: 0.1 });
    assert.ok(await until(async () => kinds(await dev()).includes("power")), "the power limiter is reported");
    await call("PATCH", "/api/settings", { syncOffsetMs: 200 }); h = await dev(); assert.ok(h.latencyMs < 0 && h.latency.offsetMs === 200, "the timing offset counts");
    wled.close(); await call("POST", `/api/devices/${d.id}/check`); h = await dev(); assert.ok(kinds(h).includes("offline")); assert.equal(h.latencyMs, null);
  } finally { await app.close(); wled.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("setup wizard flag: a fresh start wants setup; setupDone sticks across a restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-wiz-"));
  let app = await createApp({ dataDir: dir, discover: false, logger: null });
  try {
    let st = await app.core.handle("GET", "/api/state"); assert.equal(st.firstRun, true); assert.equal(st.settings.setupDone, false); assert.equal(st.devices.length, 0);
    await app.core.handle("PATCH", "/api/settings", { body: { setupDone: true } }); await app.close();
    app = await createApp({ dataDir: dir, discover: false, logger: null });
    st = await app.core.handle("GET", "/api/state"); assert.equal(st.settings.setupDone, true); assert.equal(st.firstRun, false);
    await app.core.handle("PATCH", "/api/settings", { body: { setupDone: false } }); assert.equal(app.store.data.settings.setupDone, false, "Run setup again can clear it");
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
