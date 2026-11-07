// Lookahead mode: Tempolight plays the music itself, a few seconds late, while the analyser hears it at once.
// A pretend sound card (its clock runs fast) and a pretend speaker (its clock runs slow) on a simulated clock: the delay
// must stay steady, and the lights must know a drop is coming before it is heard, and flash when it is heard.
// Then the same through the app, with a pretend recording and a pretend speaker.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createPassthrough, LA_MARGIN_MS } from "../src/passthrough.js";
import { parseAudioToolboxDevices, outputCommand, rankOutputs } from "../src/audio-out.js";
import { LiveAnalyser } from "../../engine/src/live.js";
import { LookaheadTimeline } from "../../engine/src/lookahead.js";
import { edm } from "../../engine/test/synth.js";

// ---------------------------------------------------------------- a simulated sound card and speaker
/**
 * Runs a passthrough for `seconds` of simulated time (1 ms steps). Each frame is 4 channels: the music (left, right)
 * and its own index (low 15 bits, the rest), so the speaker knows which input frame it plays, and when.
 * ppmIn/ppmOut: how fast the sound card / speaker clocks run against the computer's; reports: the speaker says how
 * much it has played (like ffmpeg's progress), every 250 ms, rounded down to its 1024-frame packets.
 * music(i): the music's frame i as [left, right] (Int16), else silence; onPush(stereo chunk, T); onFrame(T, P) every 5 ms.
 */
function simulate({ seconds = 60, rate = 48000, delayMs = 3250, ppmIn = 0, ppmOut = 0, reports = true, chunk = 512, jitterMs = 8, devLatencyMs = 30, seed = 3, music = null, onPush = null, onFrame = null } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let T = 0; const P = createPassthrough({ rate, channels: 4, delayMs, now: () => T });
  const rateIn = rate * (1 + ppmIn * 1e-6), rateOut = rate * (1 + ppmOut * 1e-6);
  const pending = []; let made = 0; // chunks captured, waiting to arrive (late by up to jitterMs)
  let written = 0, devFree = null; const plays = []; // [input frame, when it plays], every 48th frame
  for (; T < seconds * 1000; T += 1) {
    while ((made + chunk) / rateIn * 1000 <= T) { // the sound card makes a chunk every chunk/rateIn seconds; it arrives a little late
      const a = new Int16Array(chunk * 4), st = music ? new Int16Array(chunk * 2) : null;
      for (let i = 0; i < chunk; i++) { const k = made + i, m = music ? music(k) : null; if (m) { a[4 * i] = st[2 * i] = m[0]; a[4 * i + 1] = st[2 * i + 1] = m[1]; } a[4 * i + 2] = k & 0x7fff; a[4 * i + 3] = (k >> 15) & 0x7fff; }
      made += chunk; pending.push({ at: made / rateIn * 1000 + rnd() * jitterMs, a, st });
    }
    while (pending.length && pending[0].at <= T) { const c = pending.shift(); P.push(c.a, T); if (onPush) onPush(c.st, T); }
    if (T % 5 === 0) {
      const out = P.tick(T);
      if (out) for (let i = 0; i < out.length; i += 4) { // the speaker plays each frame in turn at its own rate (never before it got it)
        const at = devFree == null ? T + devLatencyMs : Math.max(devFree, T + devLatencyMs); devFree = at + 1000 / rateOut; written++;
        const k = out[i + 2] + (out[i + 3] << 15); if (k && written % 48 === 0) plays.push([k, at]); }
      if (onFrame) onFrame(T, P);
    }
    if (reports && T % 250 === 0 && devFree != null) { // frames played by now, in whole packets
      const playedNow = Math.max(0, written - Math.max(0, (devFree - T) * rateOut / 1000)); P.reportPlayed(Math.floor(playedNow / 1024) * 1024, T); }
  }
  // the true delay of each input frame: from when the sound card made it to when the speaker played it
  const delay = plays.map(([k, at]) => [at / 1000, at - k / rateIn * 1000]);
  /** When the speaker played input frame k (ms). */
  const playedAt = k => { let lo = 0, hi = plays.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (plays[m][0] < k) lo = m + 1; else hi = m; } const [k1, at] = plays[lo]; return at - (k1 - k) / rateOut * 1000; };
  return { P, delay, playedAt, rateIn };
}
const spread = (list, from) => { let min = Infinity, max = -Infinity, n = 0; for (const [t, v] of list) if (t >= from) { n++; if (v < min) min = v; if (v > max) max = v; } return { min, max, n: n * 48 }; };

test("lookahead passthrough: the delay stays steady (±10 ms over 60 s) with the sound card 400 ppm fast and the speaker 300 ppm slow", () => {
  const { P, delay } = simulate({ ppmIn: 400, ppmOut: -300 });
  const r = spread(delay, 10), mid = (r.max + r.min) / 2, st = P.stats();
  assert.ok(r.n > 40 * 48000, `frames played: ${r.n}`);
  assert.ok(r.max - r.min <= 20, `delay from ${r.min.toFixed(1)} to ${r.max.toFixed(1)} ms (${(r.max - r.min).toFixed(1)} ms apart)`);
  assert.ok(Math.abs(mid - 3250 - 30) < 15, `the delay is what was asked (+ the speaker's own 30 ms): ${mid.toFixed(1)} ms`);
  assert.ok(st.dropped > 0, `frames dropped to keep the delay: ${st.dropped}`);
  assert.ok(Math.abs(st.clockPpm + 300) < 120, `the speaker's clock found: ${st.clockPpm} ppm`);
  assert.ok(st.dropped + st.inserted < 0.002 * r.n, `rarely: ${st.dropped} dropped, ${st.inserted} doubled`);
  if (process.env.TL_LA_REPORT) console.log(JSON.stringify({ spreadMs: r.max - r.min, mid, ...st }));
  // without fixing anything it would have moved by ~700 ppm × 50 s = 35 ms
});

test("lookahead passthrough: a slow sound card (frames played twice), and an output that can't report its clock", () => {
  const { P, delay } = simulate({ ppmIn: -350, ppmOut: 0, reports: false, seconds: 60 });
  const r = spread(delay, 10), st = P.stats();
  assert.ok(r.max - r.min <= 20, `delay from ${r.min.toFixed(1)} to ${r.max.toFixed(1)} ms`);
  assert.ok(st.inserted > 0 && st.dropped < st.inserted, `${st.inserted} doubled, ${st.dropped} dropped`);
  assert.ok(Math.abs(st.measuredMs - 3250) < 3, `measured ${st.measuredMs} ms`);
});

test("lookahead passthrough: heardFrame says which input frame plays now; the volume scales the samples", () => {
  let T = 0; const P = createPassthrough({ rate: 48000, delayMs: 1000, now: () => T });
  const a = new Int16Array(480 * 2).fill(10000);
  for (; T <= 3000; T += 10) { P.push(a, T); P.tick(T); }
  const heard = P.heardFrame(T), newest = P.inFrames;
  assert.ok(Math.abs((newest - heard) / 48 - 1000) < 15, `heard ${((newest - heard) / 48).toFixed(1)} ms behind the newest`);
  P.volume = 0.5; let out = null; for (let k = 0; k < 20; k++) { T += 10; P.push(a, T); out = P.tick(T) || out; }
  assert.equal(out[out.length - 1], 5000);
  assert.equal(LA_MARGIN_MS, 250);
});

// ---------------------------------------------------------------- the lights know what comes
test("lookahead mode: the analyser hears the future, a drop is counted down ≥ 3 s early for certain, and the flash lands on the delayed drop", () => {
  const R = 44100, e = edm(R), n = e.x.length, dropFrame = Math.round(e.dropStart * R);
  const music = k => { const v = k < n ? Math.round(e.x[k] * 20000) : 0; return [v, v]; };
  const an = new LiveAnalyser(R), tl = new LookaheadTimeline(), TRIM = -30; // TRIM: the light timing for this speaker (its own 30 ms), as the timing fix would set it
  let countdown = null, flashAt = null, ahead = [], plainFirst = null;
  const sim = simulate({ rate: R, seconds: 24, ppmIn: 250, ppmOut: -200, music,
    onPush: (st, T) => { an.push(st, 2); tl.record(an); const V = an.view(an.now); if (plainFirst == null && V.nextDrop != null) plainFirst = { T, conf: V.dropConf }; },
    onFrame: (T, P) => {
      const f = P.heardFrame(T); if (f == null) return;
      const t = f / R + TRIM / 1000, V = tl.view(t); if (!V) return;
      ahead.push(V.aheadS);
      if (!countdown && V.nextDrop != null && V.dropSource === "lookahead" && Math.abs(V.nextDrop - e.dropStart) < 0.1) countdown = { T, t, at: V.nextDrop, conf: V.dropConf, state: V.state };
      if (flashAt == null && V.state === "drop" && t - V.dropT >= 0 && Math.abs(V.dropT - e.dropStart) < 0.1) flashAt = { T, dropT: V.dropT };
    } });
  const dropHeardAt = sim.playedAt(dropFrame); // when the room hears the drop
  const midAhead = ahead.slice(ahead.length >> 1).reduce((a, b) => a + b, 0) / (ahead.length - (ahead.length >> 1));
  assert.ok(Math.abs(midAhead - 3.25 - 0.03) < 0.05, `the analyser hears ${midAhead.toFixed(3)} s ahead of the speaker`);
  assert.ok(countdown, "a countdown to the drop at 15 s"); // (the analyser also calls a short false drop in the build-up; lookahead reports what it heard)
  assert.equal(countdown.conf, 1); assert.notEqual(countdown.state, "silent");
  assert.ok(dropHeardAt - countdown.T >= 3000, `the countdown starts ${((dropHeardAt - countdown.T) / 1000).toFixed(2)} s before the drop is heard`);
  assert.ok(Math.abs(countdown.at - e.dropStart) < 0.03, `the countdown points at ${countdown.at.toFixed(3)} s (the drop is at ${e.dropStart} s)`);
  assert.ok(flashAt, "a flash");
  assert.ok(Math.abs(flashAt.T - dropHeardAt) <= 20, `the flash is ${(flashAt.T - dropHeardAt).toFixed(1)} ms from the drop the room hears`);
  // the build-up ramps into it: buildP reaches 1 at the drop
  const V1 = tl.view(e.dropStart - 0.05), V0 = tl.view(e.dropStart - 3);
  assert.ok(V0.buildP < V1.buildP && V1.buildP > 0.97, `buildP ${V0.buildP.toFixed(2)} → ${V1.buildP.toFixed(2)}`);
  assert.ok(V0.upcoming.some(u => u.state === "drop"), "the part change is known");
  if (process.env.TL_LA_REPORT) console.log(JSON.stringify({ countdownS: (dropHeardAt - countdown.T) / 1000, flashMs: flashAt.T - dropHeardAt, aheadS: midAhead }));
  void plainFirst;
});

test("lookahead audio out: the Mac's speaker list, the commands and the speaker it picks", () => {
  const list = parseAudioToolboxDevices(`[AudioToolbox @ 0x7f8] CoreAudio devices:
[AudioToolbox @ 0x7f8] [0]                  BlackHole 2ch, BlackHole2ch_UID
[AudioToolbox @ 0x7f8] [1]       MacBook Pro Speakers, BuiltInSpeakerDevice
[AudioToolbox @ 0x7f8] [2]                  Stone 620, 41-42-8D-00-11-22:output
[AudioToolbox @ 0x7f8] [3]      Multi-Output Device, ~:AMS2_StackedOutput:0`);
  assert.deepEqual(list.map(d => [d.index, d.name]), [[0, "BlackHole 2ch"], [1, "MacBook Pro Speakers"], [2, "Stone 620"], [3, "Multi-Output Device"]]);
  assert.equal(rankOutputs(list)[0].name, "Stone 620", "a speaker first, never BlackHole or the Multi-Output Device");
  assert.equal(rankOutputs(list).at(-1).name.match(/BlackHole|Multi/) !== null, true);
  const mac = outputCommand({ platform: "darwin", device: list[2] });
  assert.ok(mac.progress && mac.cmd.join(" ").includes("-f audiotoolbox -audio_device_index 2"));
  const lin = outputCommand({ platform: "linux", device: { name: "JBL", sink: "bluez_output.X.1" } });
  assert.ok(lin.cmd.join(" ").includes("-f pulse") && lin.cmd.includes("bluez_output.X.1"));
  assert.equal(outputCommand({ platform: "linux", device: { sink: "s" }, has: c => c === "pacat" }).progress, false);
  assert.equal(outputCommand({ platform: "win32", device: { name: "x" } }), null, "not on Windows yet");
});

// ---------------------------------------------------------------- through the app
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

test("lookahead mode in the app: a pretend recording and speaker, the API, the light clock is the speaker's", async () => {
  const { createApp } = await import("../src/app.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-la-")), wav = "/tmp/claude-0/realsongs/roadtrip-techno.wav";
  // the pretend recording: the synth song (or a real one, locally), in real time, 44.1 kHz stereo
  const e = edm(44100), src = existsSync(wav) ? wavFrames(readFileSync(wav)) : null;
  const caps = [], outs = [];
  const startCapture = (cmd, onSamples, onExit) => { let k = 0; const per = 441, t0 = performance.now(); let sent = 0;
    const timer = setInterval(() => { const want = Math.floor((performance.now() - t0) / 10); while (sent < want) { const a = new Int16Array(per * 2);
      for (let i = 0; i < per; i++, k++) { const v = src ? src(k) : [Math.round((e.x[k % e.x.length] || 0) * 20000)]; a[2 * i] = v[0]; a[2 * i + 1] = v[1] ?? v[0]; } onSamples(a); sent++; } }, 10);
    const c = { cmd, stop() { clearInterval(timer); } }; caps.push(c); return c; };
  const startOutput = (cmd, o) => { const out = { cmd, frames: 0, write(a) { this.frames += a.length / 2; return true; }, stop() { this.stopped = true; } }; outs.push(out); return out; };
  const outputs = [{ id: "Stone 620", name: "Stone 620", bluetooth: true, index: 2 }, { id: "MacBook Pro Speakers", name: "MacBook Pro Speakers", index: 1 }];
  const app = await createApp({ dataDir: dir, discover: false, logger: null, homekit: { mdns: false, host: "127.0.0.1" }, hearing: { interval: 0 },
    lookahead: { platform: "darwin", has: () => true, startCapture, startOutput, listOutputs: async () => outputs, captureCommand: ["pretend"] } });
  const port = await app.listen(0, "127.0.0.1");
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await call("GET", "/api/lookahead");
    assert.equal(r.body.supported, true); assert.equal(r.body.on, false); assert.deepEqual(r.body.outputs.map(o => o.name), ["Stone 620", "MacBook Pro Speakers"]);
    assert.equal((await call("PUT", "/api/lookahead", { enabled: true, delayMs: 1000, volume: 0.8 })).status, 200);
    assert.equal(outs.length, 1); assert.equal(caps.length, 1); assert.equal(app.store.data.settings.lookahead.delayMs, 1000);
    assert.ok(await until(() => app.runtime.status().lookahead?.playing), "it starts playing after the delay");
    assert.ok(await until(() => app.runtime.status().source === "capture"), "the lights follow it");
    await sleep(600);
    const st = app.runtime.status();
    assert.equal(st.lookahead.output, "Stone 620"); assert.equal(st.hearing.output.key, "la:Stone 620", "the speaker keeps a light timing of its own");
    assert.ok(Math.abs(st.lookahead.aheadMs - 1250) < 120, `hearing ahead ${st.lookahead.aheadMs} ms`);
    assert.ok(Math.abs(st.timing.passthroughMs - 1250) < 120 && st.timing.audioMs === 0 && st.timing.mode === "ahead", JSON.stringify(st.timing));
    const an = app.runtime.rt.live.an; assert.ok(an.now - app.runtime.rt.t > 1.0, `the analyser (${an.now.toFixed(2)} s) is ahead of the lights (${app.runtime.rt.t.toFixed(2)} s)`);
    assert.ok(outs[0].frames > 0);
    assert.equal((await call("PUT", "/api/lookahead", { delayMs: 99999 })).body.delayMs, 8000, "at most 8 s");
    assert.equal((await call("PUT", "/api/lookahead", { enabled: false })).status, 200);
    assert.ok(outs.every(o => o.stopped)); assert.equal(app.runtime.status().lookahead.running, false);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("lookahead mode isn't offered on Windows yet", async () => {
  const { createApp } = await import("../src/app.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-la-"));
  const app = await createApp({ dataDir: dir, discover: false, logger: null, homekit: { mdns: false, host: "127.0.0.1" }, hearing: { interval: 0 }, lookahead: { platform: "win32" } });
  const port = await app.listen(0, "127.0.0.1");
  try {
    const g = await (await fetch(`http://127.0.0.1:${port}/api/lookahead`)).json(); assert.equal(g.supported, false); assert.match(g.why, /Windows/);
    const p = await fetch(`http://127.0.0.1:${port}/api/lookahead`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(p.status, 400);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** A 16-bit PCM WAV as frame(k) → [left, right] (resampled to 44.1 kHz by picking the nearest frame). */
function wavFrames(b) {
  let o = 12, fmt = null, data = null; while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }; if (id === "data") { data = { at: o + 8, n: sz }; break; } o += 8 + sz + (sz & 1); }
  if (!fmt || !data || fmt.bits !== 16) return null; const frames = Math.floor(data.n / (2 * fmt.ch));
  return k => { const i = Math.floor(k * fmt.sr / 44100) % frames, p = data.at + i * 2 * fmt.ch; const l = b.readInt16LE(p); return [l, fmt.ch > 1 ? b.readInt16LE(p + 2) : l]; };
}
