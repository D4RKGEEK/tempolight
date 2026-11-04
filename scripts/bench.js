#!/usr/bin/env node
// How much CPU Tempolight needs, part by part: runs the real server and runtime headless (pretend DDP controllers on
// this computer, a synthetic song fed through the live analyser at real time, remembered songs to recognise, browsers
// watching the preview and phones as lights) and reports CPU milliseconds per second for each part.
//   node scripts/bench.js [--seconds 20] [--leds 700] [--songs 12] [--mode auto|full|lite] [--speed 1] [--json]
// 1000 ms/s is one CPU core. Worst frame and p99 show hitches: a frame that takes longer than the frame time (16.7 ms at
// 60 fps) is a visible stutter on the lights.
import os from "node:os";
import dgram from "node:dgram";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg("seconds", 20)), LEDS = Number(arg("leds", 700)), SONGS = Number(arg("songs", 12)), MODE = arg("mode", null), SPEED = Number(arg("speed", 1)), JSON_OUT = process.argv.includes("--json");
const now = () => performance.now();

// ---------------------------------------------------------------- timers: the frame loop and the status broadcast
// The runtime's frame loop is a setInterval of 1000/fps ms; the status broadcast one of 250 ms. They are timed from
// outside, so this script measures any version of Tempolight the same way.
const T = { frame: [], status: 0, statusN: 0 };
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...a) => {
  if (ms > 0 && ms < 100) return realSetInterval(() => { const t0 = now(); try { fn(...a); } finally { T.frame.push(now() - t0); } }, ms);
  if (ms === 250) return realSetInterval(() => { const t0 = now(); try { fn(...a); } finally { T.status += now() - t0; T.statusN++; } }, ms);
  return realSetInterval(fn, ms, ...a);
};

const { createApp } = await import(path.join(root, "packages/server/src/app.js"));
const engine = await import(path.join(root, "packages/engine/src/index.js"));
const { FingerprintTap } = await import(path.join(root, "packages/engine/src/memory.js"));
const { ChromaTap } = await import(path.join(root, "packages/engine/src/tonal.js"));
const { DDPSender } = await import(path.join(root, "packages/outputs/src/index.js"));
const synth = await import(path.join(root, "packages/engine/test/synth.js"));

// ---------------------------------------------------------------- wrap the parts that can be wrapped from outside
const acc = {}; const add = (k, ms) => { acc[k] = (acc[k] || 0) + ms; };
function wrap(proto, name, key) { const f = proto[name]; if (!f) return; proto[name] = function (...a) { const t0 = now(); try { return f.apply(this, a); } finally { add(key, now() - t0); } }; }
wrap(engine.LiveAnalyser.prototype, "push", "analysis");
wrap(engine.LiveAnalyser.prototype, "vocalHop", "analysis.vocal");
wrap(ChromaTap.prototype, "frame", "analysis.chroma");
wrap(FingerprintTap.prototype, "push", "analysis.fingerprint");
wrap(DDPSender.prototype, "send", "senders");

// ---------------------------------------------------------------- the songs: remembered ones, and one heard live
const sr = 22050;
process.stderr.write("Making and analysing the test songs… ");
const kinds = [{ tonic: 2, mode: "major", seed: 9 }, { tonic: 7, mode: "minor", seed: 3 }, { tonic: 9, mode: "major", seed: 21 }, { tonic: 4, mode: "minor", seed: 14 }];
const tracks = [];
for (const k of kinds.slice(0, Math.max(1, Math.min(4, SONGS)))) { const s = synth.piece({ ...k, bpm: 120, bars: 90, drums: true }, sr); tracks.push({ x: s.x, pre: await engine.preAnalyseCore(s.x, sr) }); }
process.stderr.write("done\n");

const dir = mkdtempSync(path.join(os.tmpdir(), "tl-bench-"));
const sink = dgram.createSocket("udp4"); let udpBytes = 0; sink.on("message", m => { udpBytes += m.length; });
await new Promise(r => sink.bind(0, "127.0.0.1", r)); const sinkPort = sink.address().port;
const app = await createApp({ dataDir: dir, discover: false, logger: null });
const { runtime, store, core } = app, d = store.data;
d.settings.capture.enabled = false; d.settings.nowPlaying = { ...(d.settings.nowPlaying || {}), enabled: false };
if (MODE) d.settings.performance = MODE;

// three controllers, the LEDs shared out between them, each a few strips on the wall
const devs = 3, per = Math.floor(LEDS / devs);
d.devices = []; d.room.shapes = [];
for (let i = 0; i < devs; i++) {
  const leds = i === devs - 1 ? LEDS - per * (devs - 1) : per, id = "bench" + i;
  d.devices.push({ id, name: `Bench ${i + 1}`, host: `127.0.0.1:${sinkPort}`, ddpPort: sinkPort, leds, enabled: true, virtual: false, kind: undefined });
  const strips = 3, each = Math.floor(leds / strips);
  for (let k = 0; k < strips; k++) { const y = 1 + (i * strips + k) * 7 / (devs * strips); d.room.shapes.push({ type: "line", name: `Strip ${i}-${k}`, dev: id, start: k * each, count: k === strips - 1 ? leds - each * (strips - 1) : each, pts: [[1, y], [15, y]], rot: 0, rev: false, from: null }); }
}
for (let i = 0; i < SONGS; i++) runtime.remember(`Bench song ${i + 1}`, tracks[i % tracks.length].pre); // (every one has a tempo that fits: the worst case)
store.save(); runtime.rebuild();
if (MODE) try { await core.handle("PATCH", "/api/settings", { headers: {}, query: {}, body: { performance: MODE } }); } catch {}
runtime.startLoop();

// the director and effects: wrapped on the director object (made again by rebuild())
let wrappedD = null; function wrapDirector() { const D = runtime.director; if (D === wrappedD) return; wrappedD = D; const f = D.frame.bind(D); D.frame = (...a) => { const t0 = now(); try { return f(...a); } finally { add("director", now() - t0); } }; }
wrapDirector();

// browsers: two watching status (one with the preview), and five phones as lights
const bytes = { status: 0, preview: 0, phones: 0, msgs: 0 };
const client = kind => ({ open: true, busy: false, data: {}, send(m) { bytes.msgs++; const n = typeof m === "string" ? m.length : m.length; if (typeof m === "string") bytes.status += n; else if (m[0] === 1) bytes.preview += n; else bytes.phones += n; }, sendJSON(o) { this.send(JSON.stringify(o)); }, kind });
const conns = [];
for (let i = 0; i < 2; i++) { const c = client("ui"), h = core.connect(c, {}); conns.push(h); if (i === 0) h.message(JSON.stringify({ type: "preview", on: true }), false); }
for (let i = 0; i < 5; i++) { const c = client("phone"), h = core.connect(c, {}); conns.push(h); h.message(JSON.stringify({ type: "phone", on: true }), false); }

// ---------------------------------------------------------------- play the first song live, at real time (or faster)
const live = tracks[0].x, CH = Math.round(sr * 0.05 * SPEED); let pos = 0;
const warm = 3; // seconds before measuring: the analyser and recognition get going
const feed = realSetInterval(() => { const pcm = new Int16Array(CH); for (let k = 0; k < CH; k++) pcm[k] = Math.round((live[(pos + k) % live.length] || 0) * 0.6 * 32767); pos += CH; runtime.pushPcm(pcm, "capture", "Bench", "bench", sr); }, 50);
await new Promise(r => setTimeout(r, warm * 1000));
for (const k of Object.keys(acc)) acc[k] = 0; T.frame = []; T.status = 0; T.statusN = 0; for (const k of Object.keys(bytes)) bytes[k] = 0;
const perf0 = runtime.rt.perf ? JSON.parse(JSON.stringify(runtime.rt.perf.acc || {})) : null;
const cpu0 = process.cpuUsage(), t0 = now();
const rewrap = realSetInterval(wrapDirector, 500);
// recognition, measured the same way on any version: the same call song memory makes once a second, on the same input
// (a shadow copy: its time is reported, and left out of the process total below)
let shadow = 0, shadowN = 0; const shadowT = realSetInterval(() => { const an = runtime.rt.live?.an; if (!an) return; const t1 = now(); engine.recognise(an.tap.q, d.songs, an.memoryQuery()); shadow += now() - t1; shadowN++; }, 1000);
await new Promise(r => setTimeout(r, SECONDS * 1000));
const el = (now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
clearInterval(feed); clearInterval(rewrap); clearInterval(shadowT);

// ---------------------------------------------------------------- report
const perS = ms => Math.round(ms / el * 10) / 10;
const fr = T.frame.slice().sort((a, b) => a - b), frameSum = fr.reduce((a, b) => a + b, 0), q = p => fr.length ? Math.round(fr[Math.min(fr.length - 1, Math.floor(p * fr.length))] * 100) / 100 : 0;
const P = runtime.rt.perf, perfAcc = P && perf0 ? Object.fromEntries(Object.entries(P.acc).map(([k, v]) => [k, v - (perf0[k] || 0)])) : null;
const rec = runtime.status().recognised;
const out = {
  version: JSON.parse((await import("node:fs")).readFileSync(path.join(root, "package.json"), "utf8")).version,
  mode: P ? P.mode : "full (no performance setting)", leds: LEDS, songs: SONGS, seconds: Math.round(el * 10) / 10, speed: SPEED, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
  fps: Math.round(fr.length / el * 10) / 10, recognised: rec ? rec.name : null,
  msPerSecond: {
    "live analysis (all)": perS(acc.analysis || 0),
    "  chroma/tonal tap": perS(acc["analysis.chroma"] || 0),
    "  vocal estimate": perS(acc["analysis.vocal"] || 0),
    "  fingerprint tap": perS(acc["analysis.fingerprint"] || 0),
    "song-memory recognition (same call, timed alone)": perS(shadow),
    "song-memory recognition (runtime's counter)": perfAcc ? perS(perfAcc.memory || 0) : "n/a: runs inside the frame loop",
    "frame loop (all)": perS(frameSum),
    "  director + effects": perS(acc.director || 0),
    "  DDP senders": perS(acc.senders || 0),
    "  rest (view, toRGB8, copy, preview, phones)": perS(frameSum - (acc.director || 0) - (acc.senders || 0)),
    "status broadcast": perS(T.status),
    "process total (user+sys)": perS((cpu.user + cpu.system) / 1000 - shadow),
  },
  recognitionMsPerCall: shadowN ? Math.round(shadow / shadowN * 100) / 100 : null,
  frameMs: { mean: fr.length ? Math.round(frameSum / fr.length * 100) / 100 : 0, p50: q(0.5), p99: q(0.99), max: q(1), over16ms: fr.filter(x => x > 16.7).length },
  messagesPerSecond: { all: perS(bytes.msgs), statusKBps: perS(bytes.status / 1000), previewKBps: perS(bytes.preview / 1000), phonesKBps: perS(bytes.phones / 1000) },
  udpKBps: perS(udpBytes / 1000),
};
if (perfAcc) out.runtimeCounters = Object.fromEntries(Object.entries(perfAcc).map(([k, v]) => [k, perS(v)]));
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`Tempolight ${out.version} · ${out.mode} · ${LEDS} LEDs · ${SONGS} remembered songs · ${out.seconds} s at ${SPEED}x · ${out.cores} × ${out.cpu}`);
  console.log(`frame loop ${out.fps} fps · recognised: ${out.recognised || "no"}`);
  console.log("\nCPU ms per second (1000 = one core)");
  for (const [k, v] of Object.entries(out.msPerSecond)) console.log(`  ${k.padEnd(46)} ${typeof v === "number" ? v.toFixed(1).padStart(7) : v}`);
  console.log(`\nrecognition: ${out.recognitionMsPerCall} ms per call, once a second`);
  console.log(`frame time ms: mean ${out.frameMs.mean} · p50 ${out.frameMs.p50} · p99 ${out.frameMs.p99} · worst ${out.frameMs.max} · frames over 16.7 ms: ${out.frameMs.over16ms}`);
  console.log(`messages to browsers: ${out.messagesPerSecond.all}/s (status ${out.messagesPerSecond.statusKBps} kB/s, preview ${out.messagesPerSecond.previewKBps} kB/s, phones ${out.messagesPerSecond.phonesKBps} kB/s) · DDP ${out.udpKBps} kB/s`);
  if (out.runtimeCounters) console.log("runtime's own counters, ms/s:", JSON.stringify(out.runtimeCounters));
}
for (const h of conns) h.close();
await app.close(); sink.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
