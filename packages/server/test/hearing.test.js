// How Tempolight hears music: the guided set-up with pretend computers. A fake command runner prints what ffmpeg,
// system_profiler, pactl and PowerShell print on a real Mac, Linux box or Windows PC (fixtures/hearing), and the
// "BlackHole" input is a small Node process that writes a sine wave (or silence) instead of ffmpeg.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { parseAvfDevices, parseDshowDevices, parseMacAudio, macOutput, parsePactlSinks, parsePactlInfo, linuxOutput, parseWinEndpoints, winOutput, isLoopback, computerSource } from "../src/hearing.js";
import { sourceFor } from "../src/capture.js";

const fx = f => readFileSync(new URL(`./fixtures/hearing/${f}`, import.meta.url), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; }
const tone = amp => [process.execPath, "-e", `const r=22050,n=1103,b=Buffer.alloc(n*2);let t=0;process.stdout.on("error",()=>process.exit(0));setInterval(()=>{for(let i=0;i<n;i++,t++)b.writeInt16LE(Math.round(${amp}*Math.sin(t*2*Math.PI*220/r)),i*2);process.stdout.write(b)},50)`];
const SINE = tone(9000), SILENCE = tone(0);

/** A pretend Mac: `state.avf` (blackhole | none) and `state.profile` (multi-bt | speakers | broken) can change during a test. */
function fakeMac(state) {
  const calls = [];
  return { calls, async run(cmd, args) { calls.push([cmd, ...args]);
    if (cmd === "ffmpeg") return state.ffmpeg === false ? { code: 127, stdout: "", stderr: "", missing: true } : { code: 1, stdout: "", stderr: fx(`ffmpeg-avf-${state.avf}.txt`) };
    if (cmd === "system_profiler") { if (state.profile === "broken") return { code: 1, stdout: "", stderr: "boom" }; const j = JSON.parse(fx(`system-profiler-${state.profile}.json`)); if (!args.includes("SPBluetoothDataType")) delete j.SPBluetoothDataType; return { code: 0, stdout: JSON.stringify(j), stderr: "" }; }
    return { code: 127, stdout: "", stderr: "", missing: true }; } };
}
async function setup(hearing, dir = mkdtempSync(path.join(os.tmpdir(), "tl-hear-"))) {
  const app = await createApp({ dataDir: dir, discover: false, logger: null, homekit: { mdns: false, host: "127.0.0.1" }, hearing }), port = await app.listen(0, "127.0.0.1");
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, dir, call, st: () => app.runtime.status(), async done(keep) { await app.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}
const step = (v, id) => v.computer.steps.find(s => s.id === id);

test("hearing: reads ffmpeg's device lists, system_profiler, pactl and PowerShell", () => {
  const avf = parseAvfDevices(fx("ffmpeg-avf-blackhole.txt"));
  assert.deepEqual(avf.audio.map(d => d.name), ["MacBook Pro Microphone", "BlackHole 16ch", "BlackHole 2ch", "Microsoft Teams Audio"]);
  assert.deepEqual(avf.video.map(d => d.index), [0, 1]); assert.equal(avf.audio[2].index, 2);
  assert.deepEqual(parseAvfDevices(fx("ffmpeg-avf-none.txt")).audio.map(d => d.name), ["MacBook Air Microphone"]);

  const mac = parseMacAudio(fx("system-profiler-multi-bt.json"));
  assert.equal(mac.devices.length, 5); assert.deepEqual(mac.btConnected, ["JBL Flip 5"], "the mouse isn't a speaker, and AirPods aren't connected");
  const bh = mac.devices.find(d => d.blackhole); assert.equal(bh.input, 2); assert.equal(bh.transport, "virtual");
  assert.deepEqual(macOutput(mac), { key: "mac:Multi-Output Device + JBL Flip 5", name: "Multi-Output Device (JBL Flip 5)", bluetooth: true, multi: true, guess: true });
  assert.deepEqual(macOutput(parseMacAudio(fx("system-profiler-speakers.json"))), { key: "mac:MacBook Air Speakers", name: "MacBook Air Speakers", bluetooth: false });
  const direct = JSON.parse(fx("system-profiler-multi-bt.json")); for (const d of direct.SPAudioDataType[0]._items) d.coreaudio_default_audio_output_device = d._name === "JBL Flip 5" ? "spaudio_yes" : undefined;
  assert.deepEqual(macOutput(parseMacAudio(direct)), { key: "mac:JBL Flip 5", name: "JBL Flip 5", bluetooth: true }, "a Bluetooth speaker as the output itself");
  for (const d of direct.SPAudioDataType[0]._items) d.coreaudio_default_audio_output_device = d._name === "BlackHole 2ch" ? "spaudio_yes" : undefined;
  assert.equal(macOutput(parseMacAudio(direct)).blackhole, true, "BlackHole itself as the output: the speakers are silent");
  assert.deepEqual(parseMacAudio("not json"), { devices: [], btConnected: [] });

  const sinks = parsePactlSinks(fx("pactl-sinks.txt"));
  assert.deepEqual(sinks, [{ name: "alsa_output.platform-bcm2835_audio.stereo-fallback", description: "Built-in Audio", bluetooth: false }, { name: "bluez_output.B8_F6_53_00_00_02.1", description: "JBL Flip 5", bluetooth: true }]);
  assert.deepEqual(parsePactlSinks(fx("pactl-sinks.json")).map(s => s.bluetooth), [false, true]);
  const info = parsePactlInfo(fx("pactl-info.txt")); assert.equal(info.defaultSink, "bluez_output.B8_F6_53_00_00_02.1"); assert.match(info.server, /PipeWire/);
  assert.deepEqual(linuxOutput(info.defaultSink, sinks), { key: "pulse:bluez_output.B8_F6_53_00_00_02.1", name: "JBL Flip 5", bluetooth: true });
  assert.equal(linuxOutput("bluez_sink.00_11.a2dp_sink", []).bluetooth, true, "PulseAudio's own Bluetooth sink names"); assert.equal(linuxOutput(null, sinks), null);

  assert.deepEqual(parseDshowDevices(fx("ffmpeg-dshow.txt")), { audio: ["Microphone Array (Realtek(R) Audio)", "Stereo Mix (Realtek(R) Audio)"], video: ["Integrated Webcam"] });
  assert.deepEqual(parseDshowDevices(fx("ffmpeg-dshow-old.txt")), { audio: ["Microphone (USB Audio Device)"], video: ["HD Webcam"] });
  assert.ok(isLoopback("Stereo Mix (Realtek(R) Audio)") && isLoopback("CABLE Output (VB-Audio Virtual Cable)") && !isLoopback("Microphone Array (Realtek(R) Audio)"));
  const eps = parseWinEndpoints(fx("win-endpoints.json")); assert.deepEqual(eps.map(e => e.bluetooth), [false, true, true, false]);
  assert.deepEqual(winOutput(eps), { key: "win:Headphones (WH-1000XM4 Stereo)", name: "Headphones (WH-1000XM4 Stereo)", bluetooth: true, guess: true }, "the stereo endpoint, not the hands-free one");

  assert.match(sourceFor("avf:BlackHole 2ch").cmd.join(" "), /^ffmpeg .*-f avfoundation -i :BlackHole 2ch -f s16le -ac 1 -ar 22050 -$/);
  assert.ok(sourceFor("dshow:Stereo Mix (Realtek(R) Audio)").cmd.includes("audio=Stereo Mix (Realtek(R) Audio)") && sourceFor("dshow:x").cmd.includes("-audio_buffer_size"));
  assert.equal(sourceFor("parec-monitor"), null); assert.equal(sourceFor("auto"), null);
  assert.deepEqual(computerSource({ platform: "darwin", blackhole: { name: "BlackHole 2ch" }, ffmpeg: true }), { id: "avf:BlackHole 2ch" });
  assert.match(computerSource({ platform: "darwin", blackhole: { name: "BlackHole 2ch" }, ffmpeg: false }).why, /brew install ffmpeg/);
});

test("hearing on a Mac: BlackHole checklist, turn it on, it hears; it starts by itself after a restart", async () => {
  const state = { avf: "none", profile: "multi-bt" }, runner = fakeMac(state), opts = { platform: "darwin", runner, interval: 0, listSources: () => [], commandFor: id => /BlackHole 2ch/.test(id) ? SINE : null };
  let s = await setup(opts); const dir = s.dir;
  try {
    let v = (await s.call("GET", "/api/hearing")).body;
    assert.equal(v.platform, "darwin"); assert.equal(v.recommended, "computer");
    assert.equal(step(v, "blackhole").state, "ok", "system_profiler lists BlackHole even when this ffmpeg list doesn't"); // (installed, ffmpeg not restarted)
    state.avf = "none"; state.profile = "speakers"; v = (await s.call("POST", "/api/hearing/check")).body;
    assert.equal(step(v, "blackhole").state, "no"); assert.equal(step(v, "output").state, "no"); assert.match(step(v, "output").detail, /MacBook Air Speakers/);
    let r = await s.call("POST", "/api/hearing/use", { choice: "computer" }); assert.equal(r.status, 400); assert.match(r.body.error, /BlackHole isn't installed/);
    assert.equal(s.app.store.data.settings.capture.enabled, false);

    state.avf = "blackhole"; state.profile = "multi-bt"; v = (await s.call("POST", "/api/hearing/check")).body;
    assert.equal(step(v, "blackhole").label, "BlackHole 2ch installed", "2ch is preferred over 16ch"); assert.equal(step(v, "output").state, "maybe", "a Multi-Output Device: confirmed once sound arrives");
    assert.equal(step(v, "hears").state, "todo"); assert.equal(v.computer.source, "avf:BlackHole 2ch");
    r = await s.call("POST", "/api/hearing/use", { choice: "computer" }); assert.equal(r.status, 200);
    assert.deepEqual(s.app.store.data.settings.capture, { enabled: true, source: "avf:BlackHole 2ch", command: "" }); assert.equal(s.app.store.data.settings.hearing.method, "computer");
    assert.ok(await until(() => s.st().hearing.sound), "Tempolight hears the BlackHole input");
    assert.equal(s.st().hearing.via, "capture"); assert.ok(s.st().hearing.level > 0.2); assert.ok(await until(() => s.st().source === "capture"), "the lights follow it");
    v = (await s.call("GET", "/api/hearing")).body;
    assert.deepEqual(v.computer.steps.map(x => x.state), ["ok", "ok", "ok", "ok"]); assert.ok(v.computer.on && v.computer.running);
    assert.equal(v.output.key, "mac:Multi-Output Device + JBL Flip 5", "the output was read when the service started");
    await s.done(true);

    s = await setup(opts, dir); // a restart: listening comes back with no browser and nothing to press
    assert.ok(await until(() => s.app.runtime.rt.capture?.proc && s.st().hearing.sound), "capture started by itself after the restart");
    assert.equal(s.app.runtime.rt.capture.sourceId, "avf:BlackHole 2ch");

    r = await s.call("POST", "/api/hearing/use", { choice: "mic" }); assert.equal(r.status, 200); // the microphone instead: server capture stops
    assert.equal(s.app.store.data.settings.capture.enabled, false); assert.equal(s.app.store.data.settings.hearing.method, "mic"); assert.equal(s.app.runtime.rt.capture, null);
    assert.equal((await s.call("POST", "/api/hearing/use", { choice: "telepathy" })).status, 400);
    assert.equal((await s.call("PATCH", "/api/settings", { hearing: { method: "nope" } })).status, 400);
  } finally { await s.done(); }
});

test("hearing on a Mac: silence from BlackHole while music plays says so; a named input never falls back to the microphone", async () => {
  const state = { avf: "blackhole", profile: "speakers" }, s = await setup({ platform: "darwin", runner: fakeMac(state), interval: 0, listSources: () => [{ id: "ffmpeg-avf", label: "Default input", cmd: SINE }], commandFor: id => /BlackHole/.test(id) ? SILENCE : false });
  try {
    await s.call("POST", "/api/hearing/use", { choice: "computer" });
    assert.ok(await until(() => s.st().hearing.capture?.running && s.app.runtime.rt.heardBy.capture), "capture runs");
    s.app.runtime.rt.nowPlaying = { info: () => ({ playing: true, title: "Song" }), follow: () => null, memId: null }; // Spotify plays
    const v = (await s.call("GET", "/api/hearing")).body;
    assert.equal(step(v, "hears").state, "no"); assert.equal(step(v, "output").state, "no", "the output isn't the Multi-Output Device"); assert.equal(s.st().hearing.sound, false);
    await s.call("PATCH", "/api/settings", { capture: { source: "avf:Missing Device" } });
    assert.match(s.st().capture.error, /“Missing Device” can't be used/); assert.equal(s.st().hearing.sound, false, "the microphone (the first source) wasn't used instead");
  } finally { await s.done(); }
});

test("hearing: light timing per sound output, switched when the output changes; the general timing is the fallback", async () => {
  const state = { avf: "blackhole", profile: "multi-bt" }, s = await setup({ platform: "darwin", runner: fakeMac(state), interval: 40, listSources: () => [] });
  const out = () => s.st().hearing.output, BT = "mac:Multi-Output Device + JBL Flip 5", SPK = "mac:MacBook Air Speakers";
  try {
    assert.ok(await until(() => out()?.key === BT)); assert.equal(out().bluetooth, true); assert.equal(out().own, false, "no timing of its own yet: the prompt shows");
    await s.call("PATCH", "/api/settings", { syncOffsetMs: -180 });
    const set = s.app.store.data.settings; assert.equal(set.syncOffsetMs, 0, "the general timing is kept"); assert.deepEqual(set.syncOffsets[BT], { ms: -180, name: "Multi-Output Device (JBL Flip 5)", bt: true });
    assert.equal(s.st().offsetMs, -180); assert.equal(out().own, true); assert.equal(s.app.runtime.syncOffset(), -180);

    state.profile = "speakers"; assert.ok(await until(() => out()?.key === SPK), "the output change is seen");
    assert.equal(s.st().offsetMs, 0, "the laptop speakers use the general timing"); assert.ok(s.app.runtime.log.some(e => /Sound output is now MacBook Air Speakers: light timing 0 ms/.test(e.msg)));
    await s.call("PATCH", "/api/settings", { syncOffsetMs: 15 }); assert.equal(set.syncOffsets[SPK].ms, 15); assert.equal(set.syncOffsetMs, 0);

    state.profile = "multi-bt"; assert.ok(await until(() => out()?.key === BT)); assert.equal(s.st().offsetMs, -180, "back to the Bluetooth speaker's timing");
    await s.call("PATCH", "/api/settings", { syncOffsetMs: 40, output: SPK }); assert.equal(set.syncOffsets[SPK].ms, 40, "an output named explicitly"); assert.equal(s.st().offsetMs, -180);
    await s.call("PATCH", "/api/settings", { syncOffsets: { [BT]: null } }); assert.equal(set.syncOffsets[BT], undefined); assert.equal(s.st().offsetMs, 0, "forgotten: the fallback");

    state.profile = "broken"; assert.ok(await until(() => out() === null), "output unknown");
    await s.call("PATCH", "/api/settings", { syncOffsetMs: 25 }); assert.equal(set.syncOffsetMs, 25, "unknown output: the general timing is set"); assert.equal(s.st().offsetMs, 25);
  } finally { await s.done(); }
});

test("hearing on Linux (PipeWire, Bluetooth speaker) and Windows (Stereo Mix, or none)", async () => {
  const pactl = { async run(cmd, args) {
    if (cmd !== "pactl") return { code: 127, stdout: "", stderr: "", missing: true };
    if (args[0] === "get-default-sink") return { code: 1, stdout: "", stderr: "No valid command specified." }; // an older pactl: read `pactl info` instead
    if (args[0] === "info") return { code: 0, stdout: fx("pactl-info.txt"), stderr: "" };
    if (args[0] === "--format=json") return { code: 1, stdout: "", stderr: "unknown option" };
    return { code: 0, stdout: fx("pactl-sinks.txt"), stderr: "" }; } };
  let s = await setup({ platform: "linux", runner: pactl, interval: 0, listSources: () => [{ id: "parec-monitor", label: "What's playing on this computer (PulseAudio / PipeWire)", cmd: SINE }, { id: "alsa", label: "Sound card input", cmd: SILENCE }] });
  try {
    let v = (await s.call("GET", "/api/hearing")).body;
    assert.equal(v.recommended, "computer"); assert.equal(v.computer.source, "parec-monitor"); assert.equal(v.computer.device, "bluez_output.B8_F6_53_00_00_02.1.monitor");
    assert.equal(step(v, "output").label, "Plays to JBL Flip 5 (Bluetooth)"); assert.ok(v.pi.available);
    assert.ok(await until(() => s.st().hearing.output?.bluetooth === true)); assert.equal(s.st().hearing.output.name, "JBL Flip 5");
    assert.equal((await s.call("POST", "/api/hearing/use", { choice: "computer" })).status, 200); assert.equal(s.app.store.data.settings.capture.source, "parec-monitor");
    assert.ok(await until(() => s.st().hearing.sound), "hears the monitor");
    assert.equal((await s.call("POST", "/api/hearing/use", { choice: "pi" })).status, 200); assert.equal(s.app.store.data.settings.capture.source, "auto"); assert.equal(s.app.store.data.settings.hearing.method, "pi");
  } finally { await s.done(); }

  const win = files => ({ async run(cmd) { if (cmd === "ffmpeg") return { code: 1, stdout: "", stderr: fx(files.ff) }; if (cmd === "powershell.exe") return { code: 0, stdout: fx("win-endpoints.json"), stderr: "" }; return { code: 127, stdout: "", stderr: "", missing: true }; } });
  s = await setup({ platform: "win32", runner: win({ ff: "ffmpeg-dshow.txt" }), interval: 0, listSources: () => [], commandFor: id => id.startsWith("dshow:Stereo Mix") ? SINE : null });
  try {
    const v = (await s.call("GET", "/api/hearing")).body;
    assert.equal(v.recommended, "computer"); assert.equal(v.computer.source, "dshow:Stereo Mix (Realtek(R) Audio)"); assert.deepEqual(v.computer.steps.map(x => x.state), ["ok", "ok", "todo"]);
    assert.ok(await until(() => s.st().hearing.output?.key === "win:Headphones (WH-1000XM4 Stereo)"), "a Bluetooth headphone, best effort");
    assert.equal((await s.call("POST", "/api/hearing/use", { choice: "computer" })).status, 200); assert.ok(await until(() => s.st().hearing.sound));
  } finally { await s.done(); }
  s = await setup({ platform: "win32", runner: win({ ff: "ffmpeg-dshow-old.txt" }), interval: 0, listSources: () => [] });
  try {
    const v = (await s.call("GET", "/api/hearing")).body; assert.equal(v.recommended, "mic", "no loopback input: the microphone"); assert.equal(step(v, "loopback").state, "no");
    const r = await s.call("POST", "/api/hearing/use", { choice: "computer" }); assert.equal(r.status, 400); assert.match(r.body.error, /Stereo Mix.*microphone/);
  } finally { await s.done(); }
});
