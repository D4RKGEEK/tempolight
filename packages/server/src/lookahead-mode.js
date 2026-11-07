// Lookahead mode: "Tempolight hears the song before you do". Tempolight records the music, the analyser hears it at
// once, and Tempolight plays it to the real speaker itself a few seconds later (passthrough.js holds it back,
// audio-out.js plays it). So when the room hears a moment, the lights already know the next few seconds: a drop is
// counted down for certain and the build-up ramps exactly into it (engine lookahead.js), and the lights are drawn
// for the moment the speaker plays (the passthrough knows which sample that is).
//
//   macOS    The Mac's sound output is BlackHole 2ch only (not a Multi-Output Device); Tempolight records BlackHole
//            and plays to the speaker (a Bluetooth speaker too) with ffmpeg.
//   Linux    PulseAudio / PipeWire: Tempolight adds a silent output, "Tempolight Lookahead", makes it the default,
//            records its monitor and plays to the speaker that was the default. Turning it off puts that back.
//   Windows  Not yet (ffmpeg has no sound output there).
//
// Not for video or games: everything you hear is a few seconds late. Node only (app.js starts it).
import { startCapture as realStartCapture, splitCommand } from "./capture.js";
import { startOutput as realStartOutput, outputCommand, parseAudioToolboxDevices, rankOutputs, OUT_RATE } from "./audio-out.js";
import { createPassthrough, LA_DEFAULT_MS, LA_MIN_MS, LA_MAX_MS, LA_MARGIN_MS } from "./passthrough.js";
import { parsePactlSinks } from "./hearing.js";
import { nodeRunner } from "./nowplaying.js";
import { HttpError } from "./core.js";
import { LookaheadTimeline } from "../../engine/src/lookahead.js";
import { spawnSync } from "node:child_process";

const NULL_SINK = "tempolight_ahead";
const realHas = cmd => { try { return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0; } catch { return false; } };
const q = ["-hide_banner", "-loglevel", "error", "-nostdin"];

/** The settings, with their limits. */
export function laSettings(s) {
  const l = s?.lookahead || {};
  return { enabled: !!l.enabled, delayMs: Math.round(Math.max(LA_MIN_MS, Math.min(LA_MAX_MS, Number(l.delayMs) || LA_DEFAULT_MS))), volume: Math.max(0, Math.min(1.5, l.volume ?? 1)), output: l.output ? String(l.output).slice(0, 160) : "" };
}

/**
 * @param {{core:object, store:object, runtime:object, platform?:string, runner?:{run:Function}, has?:(cmd:string)=>boolean,
 *   startCapture?:Function, startOutput?:Function, captureCommand?:string[]|null, listOutputs?:()=>Promise<object[]>, tickMs?:number}} o
 *   startCapture / startOutput / captureCommand / listOutputs: a pretend computer (tests)
 */
export function startLookahead({ core, store, runtime, platform = process.platform, runner = nodeRunner, has = realHas, startCapture = realStartCapture, startOutput = realStartOutput,
  captureCommand = null, listOutputs: fakeOutputs = null, tickMs = 10 }) {
  const rt = runtime.rt, set = () => laSettings(store.data.settings);
  const run = (cmd, args, timeout = 6000) => runner.run(cmd, args, { timeout }).catch(e => ({ code: 1, stdout: "", stderr: String(e?.message || e) }));
  const M = { P: null, cap: null, out: null, timer: null, tl: new LookaheadTimeline({ keep: LA_MAX_MS / 1000 + 4 }), an: null, base: 0, error: null, device: null, linux: null, retry: null, outputs: null, outputsAt: 0, startedAt: 0 };

  // ---------------------------------------------------------------- what this computer can do
  function why() {
    if (platform === "win32") return "Lookahead mode isn't available on Windows yet: Tempolight can't play sound there by itself. Everything else works.";
    if (platform === "darwin" && !has("ffmpeg")) return "Lookahead mode plays the music with ffmpeg, which isn't installed. Install it (brew install ffmpeg), then check again.";
    if (platform === "linux" && !has("pactl")) return "Lookahead mode needs PulseAudio or PipeWire (pactl isn't installed: sudo apt install pulseaudio-utils).";
    if (platform === "linux" && !has("ffmpeg") && !(has("parec") && has("pacat"))) return "Lookahead mode needs ffmpeg, or parec and pacat (sudo apt install pulseaudio-utils).";
    if (!["darwin", "linux"].includes(platform)) return "Lookahead mode isn't available on this computer.";
    return null;
  }
  /** The speakers it can play to: [{id, name, bluetooth, index?, sink?}], best first. */
  async function listOutputs(force = false) {
    if (fakeOutputs) return fakeOutputs();
    if (!force && M.outputs && Date.now() - M.outputsAt < 10000) return M.outputs;
    let list = [];
    if (platform === "darwin") { const r = await run("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "anullsrc", "-t", "0.01", "-f", "audiotoolbox", "-list_devices", "true", "-"]);
      list = parseAudioToolboxDevices(`${r.stderr}\n${r.stdout}`).map(d => ({ id: d.name, name: d.name, index: d.index, bluetooth: /bluetooth/i.test(d.uid) || /^([0-9a-f]{2}-){5}[0-9a-f]{2}/i.test(d.uid) })); }
    else if (platform === "linux") { let r = await run("pactl", ["--format=json", "list", "sinks"]); let sinks = r.code === 0 ? parsePactlSinks(r.stdout) : [];
      if (!sinks.length) { r = await run("pactl", ["list", "sinks"]); sinks = r.code === 0 ? parsePactlSinks(r.stdout) : []; }
      list = sinks.filter(s => s.name !== NULL_SINK).map(s => ({ id: s.name, name: s.description, sink: s.name, bluetooth: s.bluetooth })); }
    M.outputs = rankOutputs(list); M.outputsAt = Date.now(); return M.outputs;
  }
  async function pickOutput() {
    const want = set().output, list = await listOutputs(true);
    if (platform === "linux" && M.linux?.prevDefault && !want) { const p = list.find(d => d.sink === M.linux.prevDefault); if (p) return p; } // the speaker that was playing
    return list.find(d => d.id === want) || list.find(d => d.name === want) || (want ? null : list[0]) || null;
  }

  // ---------------------------------------------------------------- Linux: the silent output the music goes to
  async function linuxRoute() {
    const def = await run("pactl", ["get-default-sink"]), prev = def.code === 0 ? def.stdout.trim().split("\n")[0].trim() : null;
    const mods = await run("pactl", ["list", "short", "modules"]);
    let id = (mods.stdout.split("\n").find(l => l.includes(`sink_name=${NULL_SINK}`)) || "").split(/\s+/)[0] || null, ours = false;
    if (!id) { const r = await run("pactl", ["load-module", "module-null-sink", `sink_name=${NULL_SINK}`, "sink_properties=device.description=Tempolight-Lookahead"]); if (r.code !== 0) throw new Error(`Couldn't add the Tempolight Lookahead output: ${r.stderr.trim() || "pactl failed"}`); id = r.stdout.trim(); ours = true; }
    M.linux = { prevDefault: prev && prev !== NULL_SINK ? prev : M.linux?.prevDefault || null, module: id, ours };
    await run("pactl", ["set-default-sink", NULL_SINK]);
    const ins = await run("pactl", ["list", "short", "sink-inputs"]); // what plays now moves there too
    for (const l of ins.stdout.split("\n")) { const n = l.split(/\s+/)[0]; if (/^\d+$/.test(n)) await run("pactl", ["move-sink-input", n, NULL_SINK]); }
  }
  async function linuxUnroute() {
    const L = M.linux; if (!L) return; M.linux = null;
    if (L.prevDefault) await run("pactl", ["set-default-sink", L.prevDefault]);
    if (L.module && L.ours) await run("pactl", ["unload-module", L.module]); // (its streams move back to the default)
  }

  // ---------------------------------------------------------------- running
  function capCommand() {
    if (captureCommand) return captureCommand;
    const raw = ["-f", "s16le", "-ac", "2", "-ar", String(OUT_RATE), "-"];
    if (platform === "darwin") { const bh = rt.hearing?.info?.().blackhole || "BlackHole 2ch"; return ["ffmpeg", ...q, "-fflags", "nobuffer", "-f", "avfoundation", "-i", `:${bh}`, ...raw]; }
    if (has("parec")) return ["parec", `--device=${NULL_SINK}.monitor`, "--format=s16le", `--rate=${OUT_RATE}`, "--channels=2", "--raw", "--latency-msec=20"];
    return ["ffmpeg", ...q, "-f", "pulse", "-i", `${NULL_SINK}.monitor`, ...raw];
  }
  const label = () => `Lookahead (${M.device?.name || "speaker"})`;
  function onSamples(a) {
    const P = M.P; if (!P) return; P.push(a, performance.now());
    runtime.pushPcm(a, "capture", label(), "lookahead", OUT_RATE, 0, 2);
    const live = rt.live; if (!live || live.clientId !== "lookahead") return;
    if (live.an !== M.an) { M.an = live.an; M.base = P.inFrames - (a.length >> 1); } // a new analyser: its sample 0 is this chunk's first frame
    M.tl.record(live.an);
  }
  function tick() {
    const P = M.P; if (!P) return;
    const buf = P.tick(performance.now()); if (buf && M.out) M.out.write(buf);
  }
  async function start() {
    stop(false); const w = why(); if (w) { M.error = w; return; }
    const s = set();
    try {
      if (platform === "linux" && !captureCommand) await linuxRoute();
      const dev = await pickOutput(); if (!dev) throw new Error(s.output ? `The speaker “${s.output}” isn't connected.` : "No speaker found to play to.");
      const oc = outputCommand({ platform, device: dev, rate: OUT_RATE, has }); if (!oc) throw new Error(`Can't play to ${dev.name} here.`);
      M.device = dev; M.error = null; M.startedAt = performance.now();
      runtime.stopCaptureSource?.(); // (lookahead mode records the music itself)
      M.P = createPassthrough({ rate: OUT_RATE, channels: 2, delayMs: s.delayMs + LA_MARGIN_MS, volume: s.volume });
      M.tl.reset(); M.an = null;
      const P = M.P;
      M.out = startOutput(oc.cmd, { rate: OUT_RATE, onPlayed: oc.progress ? (f, at) => { if (M.P === P) P.reportPlayed(f, at); } : null,
        onExit: r => { if (M.P !== P) return; fail(`Playing to ${dev.name}: ${r === "ended" ? "it stopped" : r}`); } });
      M.cap = startCapture(Array.isArray(capCommand()) ? capCommand() : splitCommand(capCommand()), onSamples, r => { if (M.P !== P) return; fail(`Recording the music: ${r === "ended" ? "it stopped" : r}`); }, 2);
      M.timer = setInterval(tick, tickMs); M.timer.unref?.();
      runtime.setOutput({ key: `la:${dev.name}`, name: dev.name, bluetooth: !!dev.bluetooth }); // its own light timing
      runtime.note(`Lookahead mode on: the music plays on ${dev.name} ${(s.delayMs / 1000).toFixed(1)} s late, the lights know what comes`);
    } catch (e) { fail(e.message || String(e)); }
  }
  function fail(msg) {
    const was = !!M.P; stop(false); M.error = msg; runtime.note(`Lookahead mode: ${msg}`, "warn");
    if (was && set().enabled) { clearTimeout(M.retry); M.retry = setTimeout(() => { if (set().enabled && !M.P) start(); }, 5000); M.retry.unref?.(); }
  }
  function stop(restore = true) {
    clearTimeout(M.retry); clearInterval(M.timer); M.timer = null;
    const had = !!M.P; M.P = null; M.cap?.stop(); M.out?.stop(); M.cap = M.out = null; M.an = null; M.tl.reset();
    if (had) runtime.stopLive("lookahead");
    if (restore) { if (platform === "linux") linuxUnroute().catch(() => {}); if (had && store.data.settings.capture?.enabled) runtime.startCaptureSource?.(); }
  }

  // ---------------------------------------------------------------- what the runtime asks (runtime.js currentView)
  const active = () => !!(M.P && M.P.started && rt.live && rt.live.clientId === "lookahead" && M.an === rt.live.an);
  rt.lookahead = {
    active,
    /** The analyser's clock at the moment the speaker plays (s), or null before it plays. */
    heardT(now) { const P = M.P; if (!P) return null; const f = P.heardFrame(now); return f == null ? null : (f - M.base) / OUT_RATE; },
    /** How far the analyser has heard beyond what plays now (s). */
    aheadS(now) { const t = this.heardT(now); return t == null || !M.an ? 0 : Math.max(0, M.an.now - t); },
    view: (t, o) => M.tl.view(t, o), extras: t => M.tl.extras(t),
    get output() { return M.P && M.device ? { key: `la:${M.device.name}`, name: M.device.name, bluetooth: !!M.device.bluetooth } : null; },
    info,
  };
  function info() {
    const s = set(), P = M.P, st = P ? P.stats() : null, now = performance.now();
    return { on: s.enabled, running: !!P, playing: !!P?.started, delayMs: s.delayMs, volume: s.volume, output: M.device ? M.device.name : s.output || null,
      aheadMs: P && P.started ? Math.round(rt.lookahead.aheadS(now) * 1000) : null, measuredMs: st ? st.measuredMs : null, error: M.error,
      fixes: st ? { dropped: st.dropped, doubled: st.inserted, underruns: st.underruns } : null, clockPpm: st ? st.clockPpm : null };
  }

  // ---------------------------------------------------------------- the API
  async function view(force = false) {
    const w = why(), outputs = w ? [] : await listOutputs(force).catch(() => []), s = set();
    const steps = [];
    if (platform === "darwin") {
      const o = rt.output && !String(rt.output.key).startsWith("la:") ? rt.output : null, bh = rt.hearing?.info?.().blackhole || null;
      steps.push({ id: "blackhole", label: bh ? `${bh} installed` : "BlackHole installed", state: bh ? "ok" : "no", detail: bh ? "" : "brew install blackhole-2ch, or existential.audio/blackhole" });
      steps.push({ id: "ffmpeg", label: "ffmpeg installed", state: has("ffmpeg") ? "ok" : "no", detail: has("ffmpeg") ? "" : "brew install ffmpeg" });
      steps.push({ id: "system", label: "The Mac's sound output is BlackHole 2ch only", state: M.P && M.an ? "ok" : o?.blackhole ? "ok" : o ? "no" : "maybe",
        detail: o?.blackhole ? "" : o ? `It is ${o.name} now. In System Settings → Sound → Output, pick BlackHole 2ch (not the Multi-Output Device): Tempolight plays to your speaker itself.` : "System Settings → Sound → Output: pick BlackHole 2ch." });
      steps.push({ id: "speaker", label: M.device ? `Tempolight plays to ${M.device.name}` : "Pick the speaker Tempolight plays to", state: M.P?.started ? "ok" : outputs.length ? "todo" : "no" });
    } else if (platform === "linux") {
      steps.push({ id: "route", label: "Music goes to “Tempolight Lookahead” (done for you)", state: M.linux ? "ok" : "todo" });
      steps.push({ id: "speaker", label: M.device ? `Tempolight plays to ${M.device.name}` : "Pick the speaker Tempolight plays to", state: M.P?.started ? "ok" : outputs.length ? "todo" : "no" });
    }
    return { supported: !w, why: w, platform, ...info(), outputs: outputs.map(d => ({ id: d.id, name: d.name, bluetooth: !!d.bluetooth })), steps, settings: s,
      limits: { minMs: LA_MIN_MS, maxMs: LA_MAX_MS, defaultMs: LA_DEFAULT_MS }, marginMs: LA_MARGIN_MS };
  }
  core.route("GET", "/api/lookahead", null, () => view(false));
  core.route("PUT", "/api/lookahead", "admin", async ctx => {
    const b = ctx.body || {}, s = store.data.settings, before = laSettings(s), l = s.lookahead = { ...before };
    if (b.enabled !== undefined) l.enabled = !!b.enabled;
    if (b.delayMs !== undefined) { const v = Number(b.delayMs); if (!Number.isFinite(v)) throw new HttpError(400, "The delay is a number of milliseconds"); l.delayMs = Math.round(Math.max(LA_MIN_MS, Math.min(LA_MAX_MS, v))); }
    if (b.volume !== undefined) { const v = Number(b.volume); if (!Number.isFinite(v)) throw new HttpError(400, "The volume is 0 to 1.5"); l.volume = Math.max(0, Math.min(1.5, v)); }
    if (b.output !== undefined) l.output = String(b.output || "").slice(0, 160);
    if (l.enabled && why()) { l.enabled = before.enabled; throw new HttpError(400, why()); }
    store.save();
    if (M.P) M.P.volume = l.volume;
    if (!l.enabled && before.enabled) { stop(true); M.error = null; runtime.note("Lookahead mode off: the music plays as usual again"); }
    else if (l.enabled && (!before.enabled || l.output !== before.output || l.delayMs !== before.delayMs || !M.P)) await start();
    core.broadcast({ type: "changed", what: "lookahead" });
    return view(false);
  });

  if (set().enabled) start();
  return { start, stop, view, info, get passthrough() { return M.P; }, get timeline() { return M.tl; },
    close() { stop(true); delete rt.lookahead; } };
}
