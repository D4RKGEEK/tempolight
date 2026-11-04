// Light timing: lights that are late by different amounts all show a kick at the same moment, on the beat.
// Three pretend WLED controllers stand in for lights 10, 50 and 120 ms slow (a fast strip, a LIFX bulb, Hue): each
// frame "shows" when it arrives plus that delay. The metronome's beats fall at known times, so the moment each light
// shows a kick can be checked against the beat.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { lightLatency, timingPlan, audioDelay, LOOKAHEAD_CAP_MS, ANALYSIS_MS } from "../src/latency.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

test("light timing: each kind's own delay, a delay set by hand, the lookahead and the holds", () => {
  assert.equal(lightLatency({ id: "w" }, { rttMs: 6 }, 60).ms, 3 + 17, "WLED: half the round trip and one of our frames");
  assert.equal(lightLatency({ id: "w" }, {}, 60).ms, 5 + 17, "not measured yet: a home network's few ms");
  assert.equal(lightLatency({ id: "h", kind: "hue" }, { rttMs: 20 }, 60).ms, 110, "Hue (basic) updates slowly");
  assert.equal(lightLatency({ id: "h", kind: "hue", hue: { ent: { on: true } } }, { rttMs: 20 }, 60).ms, 30, "Hue fast mode");
  assert.equal(lightLatency({ id: "z", kind: "wiz" }, {}, 60).ms, 105);
  assert.equal(lightLatency({ id: "v", virtual: true }, {}, 50).ms, 20);
  const own = lightLatency({ id: "x", kind: "wiz", lightLatencyMs: 140 }, { rttMs: 4 }, 60); assert.deepEqual([own.ms, own.auto], [140, false], "set by hand");
  const p = timingPlan({ devices: [{ id: "wled", ms: 20 }, { id: "hue", ms: 110 }, { id: "wiz", ms: 105 }] });
  assert.equal(p.lookaheadMs, 110); assert.equal(p.slowest, "hue"); assert.deepEqual(Object.fromEntries(p.holds), { wled: 90, hue: 0, wiz: 5 });
  const slow = timingPlan({ devices: [{ id: "a", ms: 20 }, { id: "b", ms: 400 }] });
  assert.equal(slow.lookaheadMs, LOOKAHEAD_CAP_MS, "capped"); assert.equal(slow.holds.get("b"), 0); assert.equal(slow.holds.get("a"), LOOKAHEAD_CAP_MS - 20);
  const re = timingPlan({ devices: [{ id: "a", ms: 20 }, { id: "b", ms: 110 }], ahead: false });
  assert.equal(re.lookaheadMs, 0); assert.deepEqual([...re.holds.values()], [0, 0], "beats not known ahead: nothing is held back");
  assert.equal(audioDelay({ source: "browser", live: { kind: "browser", inMs: 30 } }).analysisMs, ANALYSIS_MS);
  assert.equal(audioDelay({ source: "browser", live: { kind: "browser", inMs: 30, an: { sampleT: 12.5 } } }).analysisMs, 0, "an analyser that says where its newest sample is isn't behind");
});

test("light timing: a kick lands on the beat on lights 10, 50 and 120 ms slow, at the same moment (±10 ms)", async () => {
  const LAT = [10, 50, 120], N = 30, BPM = 123, P = 60000 / BPM;
  const fakes = await Promise.all(LAT.map((_, i) => startFakeWled({ name: `Light ${i}`, leds: N })));
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-timing-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const call = (m, p, body) => app.core.handle(m, p, { body });
  try {
    const shown = LAT.map(() => []); // per light: [when it shows the frame, its brightness]
    fakes.forEach((f, i) => { f.onFrame = (rgb, at) => { let sum = 0; for (let k = 0; k < rgb.length; k++) sum += rgb[k]; shown[i].push([at + LAT[i], sum]); }; });
    const ids = [];
    for (let i = 0; i < fakes.length; i++) { const d = await call("POST", "/api/devices", { host: fakes[i].host }); ids.push(d.id);
      await call("PATCH", `/api/devices/${d.id}`, { ddpPort: fakes[i].ddpPort, lightLatencyMs: LAT[i] }); }
    const st = app.store.data; st.room.shapes = ids.map((id, i) => ({ type: "line", name: `Strip ${i}`, dev: id, count: N, pts: [[0.2, 1 + i], [1.6, 1 + i]] }));
    st.settings.metronome = { enabled: true, bpm: BPM }; st.settings.safe = false; st.settings.dropFlash = false; app.store.save(); app.runtime.rebuild();
    await call("PATCH", "/api/show", { effect: "heart", palette: "mono" }); // Heartbeat: dark just before each beat, bright on it
    await sleep(1200); for (const s of shown) s.length = 0; // settle (the plan, the first health checks)
    const status = app.runtime.status();
    assert.equal(status.timing.mode, "ahead"); assert.equal(status.timing.lookaheadMs, 120, "drawn ahead by the slowest light's delay");
    assert.deepEqual(ids.map(id => status.devices.find(d => d.id === id).timing.holdMs), [110, 70, 0], "each light held back by the difference");
    await sleep(5000);
    // a kick: the first bright frame after the darkest ones, just before the beat (the second, smaller beat of the
    // heartbeat comes after a frame that isn't quite as dark)
    const onsets = shown.map(list => { const v = list.map(x => x[1]), max = Math.max(...v), min = Math.min(...v), out = [];
      for (let k = 1; k < list.length; k++) if (v[k - 1] < min + (max - min) * 0.05 && v[k] > min + (max - min) * 0.6) out.push(list[k][0]); return out; });
    const errs = onsets.map(list => list.map(at => { const k = Math.round(at / P); return at - k * P; })); // from the nearest beat (the metronome's beats fall on multiples of P)
    for (let i = 0; i < LAT.length; i++) {
      assert.ok(onsets[i].length >= 8, `light ${i} showed ${onsets[i].length} kicks in 5 s`);
      const within = errs[i].filter(e => Math.abs(e) <= 10).length;
      t_diag(`light ${LAT[i]} ms: kick lands ${errs[i].map(e => Math.round(e)).join(", ")} ms from the beat`);
      assert.ok(within >= errs[i].length * 0.9, `light ${LAT[i]} ms: only ${within} of ${errs[i].length} kicks within ±10 ms of the beat (${errs[i].map(Math.round)})`);
      assert.ok(Math.abs(median(errs[i])) <= 10, `light ${LAT[i]} ms: kicks land ${Math.round(median(errs[i]))} ms from the beat`);
    }
    // the same kick on every light at the same moment
    const spread = []; for (const at of onsets[2]) { const same = onsets.map(l => l.find(x => Math.abs(x - at) < P / 2)); if (same.every(x => x != null)) spread.push(Math.max(...same) - Math.min(...same)); }
    t_diag(`spread between the lights, per kick: ${spread.map(x => Math.round(x * 10) / 10).join(", ")} ms`);
    assert.ok(spread.length >= 8 && spread.filter(x => x <= 10).length >= spread.length * 0.9, `the lights show a kick at different times: ${spread.map(Math.round)} ms apart`);
    // the frame loop runs evenly
    const fr = app.runtime.status().timing.frame; t_diag(`frame interval ${fr.intervalMs} ms, jitter ${fr.jitterMs} ms, worst ${fr.worstMs} ms`);
    assert.ok(Math.abs(fr.intervalMs - 1000 / 60) < 1.5, `frames every ${fr.intervalMs} ms`);
    // a light's delay can go back to automatic; a wrong one is refused
    await call("PATCH", `/api/devices/${ids[2]}`, { lightLatencyMs: null }); assert.equal(st.devices.find(d => d.id === ids[2]).lightLatencyMs, undefined);
    await assert.rejects(call("PATCH", `/api/devices/${ids[2]}`, { lightLatencyMs: 900 }), /0 to 500 ms/);
  } finally { await app.close(); for (const f of fakes) f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("light timing: listening live without beat prediction holds nothing back", async () => {
  const fakes = await Promise.all([0, 1].map(i => startFakeWled({ name: `L${i}`, leds: 10 })));
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-timing-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const call = (m, p, body) => app.core.handle(m, p, { body });
  try {
    for (const [i, f] of fakes.entries()) { const d = await call("POST", "/api/devices", { host: f.host }); await call("PATCH", `/api/devices/${d.id}`, { ddpPort: f.ddpPort, lightLatencyMs: i ? 150 : 10 }); }
    await call("PATCH", "/api/settings", { predict: false });
    const noise = new Float32Array(2205).map(() => (Math.random() - 0.5) * 0.4);
    for (let k = 0; k < 12; k++) { app.runtime.pushPcm(noise, "browser", "Test", "c1", 22050, 30); await sleep(100); }
    const tm = app.runtime.status(); assert.equal(tm.source, "browser"); assert.equal(tm.timing.mode, "reactive"); assert.equal(tm.timing.lookaheadMs, 0);
    assert.ok(tm.devices.every(d => d.timing.holdMs === 0 && d.timing.shownMs === d.latencyMs), "each light as fast as it can; the meter shows the whole delay");
    await call("PATCH", "/api/settings", { predict: true });
    for (let k = 0; k < 5; k++) { app.runtime.pushPcm(noise, "browser", "Test", "c1", 22050, 30); await sleep(100); }
    const on = app.runtime.status(); assert.equal(on.timing.mode, "ahead"); assert.equal(on.timing.lookaheadMs, 150);
    assert.equal(on.timing.audioMs, 30, "the sound's way in is made up for too (the analyser has a newest-sample clock, sampleT, so no analysis delay on top)");
    assert.ok(on.devices.every(d => Math.abs(d.timing.shownMs) <= 1), `lined up: ${on.devices.map(d => d.timing.shownMs)}`);
  } finally { await app.close(); for (const f of fakes) f.close(); rmSync(dir, { recursive: true, force: true }); }
});

function t_diag(msg) { if (process.env.TIMING_VERBOSE) console.log(`# ${msg}`); }
