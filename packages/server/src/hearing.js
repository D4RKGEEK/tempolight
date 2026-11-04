// How Tempolight hears your music, on the computer it runs on: the guided set-up on the Music page ("How should
// Tempolight hear your music?") and the sound output that decides the light timing.
//
//   macOS    Apps can't record the Mac's own sound, so the free BlackHole driver does: a Multi-Output Device in Audio
//            MIDI Setup plays to the speakers and to BlackHole at once, and Tempolight records BlackHole with ffmpeg
//            (capture.js sourceFor "avf:BlackHole 2ch"). Found with `ffmpeg -f avfoundation -list_devices true -i ""`
//            and `system_profiler SPAudioDataType SPBluetoothDataType -json` (which also says which output is the
//            default, whether it is a Multi-Output Device, and which Bluetooth speakers are connected).
//   Linux    PulseAudio / PipeWire: the monitor of the default output (parec), no set-up. `pactl` names the output
//            (bluez_* is a Bluetooth speaker).
//   Windows  "Stereo Mix" or another loopback input through ffmpeg (dshow), when the sound card has one.
//
// The output is read again every 15 seconds; the runtime keeps a light timing per output (a Bluetooth speaker plays
// ~200 ms late) and switches to it by itself (runtime.js setOutput, settings.syncOffsets).
//
// Node only: the online demo never loads this file (app.js starts it, like nowplaying.js).
import { nodeRunner } from "./nowplaying.js";
import { listSources as realListSources } from "./capture.js";
import { HttpError } from "./core.js";

// ---------------------------------------------------------------- parsing what the commands print
/** ffmpeg's avfoundation device list (it prints it on stderr): {video, audio}: [{index, name}]. */
export function parseAvfDevices(text) {
  const out = { video: [], audio: [] }; let sec = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) { sec = "video"; continue; }
    if (/AVFoundation audio devices/i.test(line)) { sec = "audio"; continue; }
    const m = /\]\s*\[(\d+)\]\s+(.+?)\s*$/.exec(line); if (m && sec) out[sec].push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

/** ffmpeg's DirectShow device list, old (sections) and new ("Name" (audio)) styles: {audio, video}: names. */
export function parseDshowDevices(text) {
  const out = { audio: [], video: [] }; let sec = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/DirectShow video devices/i.test(line)) { sec = "video"; continue; }
    if (/DirectShow audio devices/i.test(line)) { sec = "audio"; continue; }
    if (/Alternative name/i.test(line)) continue;
    const m = /"([^"]+)"\s*(?:\((audio|video|none)\))?\s*$/.exec(line); if (!m) continue;
    const kind = m[2] || sec; if ((kind === "audio" || kind === "video") && !out[kind].includes(m[1])) out[kind].push(m[1]);
  }
  return out;
}

const AUDIO_BT = /headphone|speaker|headset|audio|portable|earbud|hifi/i;
/**
 * `system_profiler SPAudioDataType [SPBluetoothDataType] -json`: the sound devices and the Bluetooth ones connected.
 * @returns {{devices: {name, input, output, transport, defaultOutput, defaultInput, bluetooth, aggregate, blackhole}[], btConnected: string[]}}
 */
export function parseMacAudio(json) {
  let j = json; if (typeof j === "string") { try { j = JSON.parse(j); } catch { return { devices: [], btConnected: [] }; } }
  const items = []; for (const g of (j && j.SPAudioDataType) || []) for (const x of g._items || []) items.push(x);
  const devices = items.filter(x => x && x._name).map(x => {
    const transport = String(x.coreaudio_device_transport || "").replace(/^coreaudio_device_type_/, ""), name = String(x._name);
    return { name, input: Number(x.coreaudio_device_input) || 0, output: Number(x.coreaudio_device_output) || 0, transport,
      defaultOutput: x.coreaudio_default_audio_output_device === "spaudio_yes", defaultInput: x.coreaudio_default_audio_input_device === "spaudio_yes",
      bluetooth: transport === "bluetooth", aggregate: transport === "aggregate" || /multi-?output|aggregate|mehreren ausg/i.test(name), blackhole: /blackhole/i.test(name) };
  });
  const btConnected = [];
  for (const g of (j && j.SPBluetoothDataType) || []) for (const e of g.device_connected || []) for (const [name, d] of Object.entries(e || {})) {
    if (AUDIO_BT.test(String(d?.device_minorType || "")) || /A2DP|AudioSink|Audio/i.test(String(d?.device_services || ""))) btConnected.push(name); }
  return { devices, btConnected };
}

/**
 * The Mac's sound output, for the light timing: {key, name, bluetooth, multi?, blackhole?, guess?} or null.
 * A Multi-Output Device doesn't say which speakers it holds, so a connected Bluetooth speaker counts as one of them
 * (guess: true); "Multi-Output Device + JBL Flip 5" then keeps a timing of its own, apart from the device alone.
 */
export function macOutput(p) {
  const devs = p?.devices || [], d = devs.find(x => x.defaultOutput); if (!d) return null;
  if (d.aggregate) { const bt = [...new Set([...devs.filter(x => x.bluetooth && x.output).map(x => x.name), ...(p.btConnected || [])])][0];
    return { key: `mac:${d.name}${bt ? ` + ${bt}` : ""}`, name: bt ? `${d.name} (${bt})` : d.name, bluetooth: !!bt, multi: true, ...(bt ? { guess: true } : {}) }; }
  return { key: `mac:${d.name}`, name: d.name, bluetooth: d.bluetooth, ...(d.blackhole ? { blackhole: true } : {}) };
}

/** `pactl --format=json list sinks` or plain `pactl list sinks`: [{name, description, bluetooth}]. */
export function parsePactlSinks(text) {
  const s = String(text || "").trim(); if (!s) return [];
  if (s[0] === "[") { try { return JSON.parse(s).map(x => { const pr = x.properties || {}; return { name: String(x.name), description: String(x.description || pr["device.description"] || x.name), bluetooth: /^bluez_/.test(x.name) || pr["device.bus"] === "bluetooth" || pr["device.api"] === "bluez5" }; }); } catch { return []; } }
  return s.split(/^\S.*#\d+\s*$/m).map(b => { // "Sink #52" (the heading is translated, the properties aren't)
    const name = (/^\s*Name:\s*(\S+)/m.exec(b) || /node\.name = "([^"]*)"/.exec(b) || [])[1]; if (!name) return null;
    const description = (/device\.description = "([^"]*)"/.exec(b) || /^\s*Description:\s*(.+)$/m.exec(b) || [])[1] || name;
    return { name, description: description.trim(), bluetooth: /^bluez_/.test(name) || /device\.bus = "bluetooth"/.test(b) || /device\.api = "bluez5"/.test(b) };
  }).filter(Boolean);
}
/** `pactl info`: the default output and input. */
export function parsePactlInfo(text) {
  const g = re => (re.exec(String(text || "")) || [])[1]?.trim() || null;
  return { defaultSink: g(/^Default Sink:\s*(.+)$/m), defaultSource: g(/^Default Source:\s*(.+)$/m), server: g(/^Server Name:\s*(.+)$/m) };
}
export function linuxOutput(defaultSink, sinks) {
  if (!defaultSink) return null; const s = (sinks || []).find(x => x.name === defaultSink);
  return { key: `pulse:${defaultSink}`, name: s ? s.description : defaultSink, bluetooth: s ? s.bluetooth : /^bluez_/.test(defaultSink) };
}

/** PowerShell's audio endpoints (Get-PnpDevice -Class AudioEndpoint as JSON): [{name, bluetooth}]. */
export function parseWinEndpoints(json) {
  let j; try { j = JSON.parse(String(json || "").trim() || "[]"); } catch { return []; }
  return (Array.isArray(j) ? j : [j]).filter(x => x && x.FriendlyName).map(x => ({ name: String(x.FriendlyName), bluetooth: /bluetooth|hands-?free|airpods|buds|a2dp|\bbt\b|wh-1000|jbl|bose|beats/i.test(x.FriendlyName) || /BTH/i.test(String(x.InstanceId || "")) }));
}
/** Best effort: Windows doesn't say the default output without extra modules; a Bluetooth headphone or speaker
 *  endpoint that is connected is most likely it. */
export function winOutput(eps) {
  const bt = (eps || []).find(e => e.bluetooth && /^(headphones|speakers?|lautsprecher|kopfh)/i.test(e.name)) || (eps || []).find(e => e.bluetooth && !/hands-?free|headset|microphone|mikrofon/i.test(e.name));
  return bt ? { key: `win:${bt.name}`, name: bt.name, bluetooth: true, guess: true } : null;
}
/** Loopback inputs: they record what the computer plays. */
export const isLoopback = n => /stereo ?mix|what ?u ?hear|wave ?out|loopback|cable output|voicemeeter out|virtual-audio-capturer|stereomix/i.test(String(n));
const WIN_ENDPOINTS = "Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | Where-Object Status -eq 'OK' | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress";

// ---------------------------------------------------------------- detection
/**
 * @param {{platform?:string, runner?:{run:Function}, listSources?:()=>object[]}} o runner and listSources are replaced in tests
 */
export function createHearing({ platform = process.platform, runner = nodeRunner, listSources = realListSources } = {}) {
  let cache = null, at = 0, pending = null;
  const run = (cmd, args, timeout = 6000) => runner.run(cmd, args, { timeout }).catch(e => ({ code: 1, stdout: "", stderr: String(e?.message || e), missing: false }));
  async function pactl() {
    const [def, info] = await Promise.all([run("pactl", ["get-default-sink"]), run("pactl", ["info"])]);
    if (def.missing && info.missing) return { pactl: false, defaultSink: null, sinks: [] };
    const defaultSink = (def.code === 0 && def.stdout.trim().split("\n")[0].trim()) || parsePactlInfo(info.stdout).defaultSink;
    let r = await run("pactl", ["--format=json", "list", "sinks"]); let sinks = r.code === 0 ? parsePactlSinks(r.stdout) : [];
    if (!sinks.length) { r = await run("pactl", ["list", "sinks"]); sinks = r.code === 0 ? parsePactlSinks(r.stdout) : []; }
    return { pactl: true, defaultSink, sinks, server: parsePactlInfo(info.stdout).server };
  }
  async function macProfile(withBt) { const r = await run("system_profiler", ["SPAudioDataType", ...(withBt ? ["SPBluetoothDataType"] : []), "-json"], 15000); return r.code === 0 ? parseMacAudio(r.stdout) : null; }
  async function winEndpoints() { const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_ENDPOINTS], 10000); return r.code === 0 ? parseWinEndpoints(r.stdout) : null; }

  async function fresh() {
    const sources = (() => { try { return listSources(); } catch { return []; } })();
    if (platform === "darwin") {
      const [ff, mac] = await Promise.all([run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]), macProfile(true)]);
      const avf = parseAvfDevices(`${ff.stderr}\n${ff.stdout}`), bhs = avf.audio.filter(d => /blackhole/i.test(d.name));
      const inProfile = (mac?.devices || []).filter(d => d.blackhole && d.input);
      const pick = list => list.find(d => /2ch/i.test(d.name)) || list[0];
      const bh = pick(bhs) || pick(inProfile);
      return { platform, ffmpeg: !ff.missing, inputs: avf.audio.map(d => d.name), blackhole: bh ? { name: bh.name, ffmpegSees: bhs.some(d => d.name === bh.name) } : null,
        profiler: !!mac, output: mac ? macOutput(mac) : null, devices: mac ? mac.devices : null, btConnected: mac ? mac.btConnected : [], sources };
    }
    if (platform === "win32") {
      const [ff, eps] = await Promise.all([run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]), winEndpoints()]);
      const ds = parseDshowDevices(`${ff.stderr}\n${ff.stdout}`);
      return { platform, ffmpeg: !ff.missing, inputs: ds.audio, loopback: ds.audio.find(isLoopback) || null, output: eps ? winOutput(eps) : null, sources };
    }
    const p = await pactl();
    return { platform, pactl: p.pactl, defaultSink: p.defaultSink, server: p.server || null, output: linuxOutput(p.defaultSink, p.sinks),
      monitor: sources.some(s => s.id === "parec-monitor"), ffmpegPulse: sources.some(s => s.id === "ffmpeg-pulse"), sources };
  }
  /** Everything about hearing on this computer; cached for 4 s (the panel asks every couple of seconds). */
  function detect(force = false) {
    if (!force && cache && Date.now() - at < 4000) return Promise.resolve(cache);
    if (!pending) pending = fresh().then(d => { cache = d; at = Date.now(); return d; }).finally(() => { pending = null; });
    return pending;
  }
  /** Only the sound output (cheaper: no ffmpeg, no Bluetooth list), for the timing every 15 s. */
  async function output() {
    if (platform === "darwin") { const mac = await macProfile(false); return mac ? macOutput(mac) : null; }
    if (platform === "win32") { const eps = await winEndpoints(); return eps ? winOutput(eps) : null; }
    const p = await pactl(); return linuxOutput(p.defaultSink, p.sinks);
  }
  return { platform, detect, output, cached: () => cache };
}

/** The input "This computer's sound" uses: {id} or {why} when it can't yet. */
export function computerSource(d) {
  if (d.platform === "darwin") {
    if (!d.blackhole) return { why: "BlackHole isn't installed yet. Install it (brew install blackhole-2ch, or from existential.audio/blackhole), then check again." };
    if (!d.ffmpeg) return { why: "Tempolight reads BlackHole with ffmpeg, which isn't installed. Install it (brew install ffmpeg), then check again." };
    return { id: `avf:${d.blackhole.name}` };
  }
  if (d.platform === "win32") {
    if (!d.ffmpeg) return { why: "Tempolight records Windows sound with ffmpeg, which isn't installed. Install it (winget install ffmpeg), then check again." };
    if (!d.loopback) return { why: "This computer has no Stereo Mix or other loopback input turned on. Turn on Stereo Mix (Sound settings → More sound settings → Recording → right-click → Show disabled devices → Enable), install VB-CABLE, or use the microphone instead." };
    return { id: `dshow:${d.loopback}` };
  }
  if (d.monitor) return { id: "parec-monitor" };
  if (d.ffmpegPulse && d.defaultSink) return { id: `pulse:${d.defaultSink}.monitor` };
  return { why: d.pactl ? "parec isn't installed (sudo apt install pulseaudio-utils), so Tempolight can't record what this computer plays." : "No PulseAudio or PipeWire here (a Raspberry Pi without a desktop?): use Raspberry Pi / Linux: automatic, with a USB sound card or microphone." };
}

// ---------------------------------------------------------------- the service: /api/hearing and the output watch
/**
 * @param {{core:object, store:object, runtime:object, interval?:number, platform?:string, runner?:object, listSources?:()=>object[]}} o
 *   interval: how often the output is read (ms; 0: never, in tests). platform, runner, listSources: pretend computers (tests).
 */
export function startHearing({ core, store, runtime, interval = 15000, platform = process.platform, runner, listSources = realListSources }) {
  const H = createHearing({ platform, runner, listSources }), rt = runtime.rt, set = () => store.data.settings;
  const playing = () => !!(rt.spotify?.info()?.track?.playing || rt.nowPlaying?.info()?.playing);
  const capH = () => rt.heardBy.capture;
  // where the capture runs from the input that "This computer's sound" picks
  const capturing = () => { const s = set(), c = rt.capture; return !!(s.capture.enabled && c && c.proc && !c.error); };
  function problem() {
    const s = set(), c = rt.capture, h = capH(), now = performance.now();
    if (s.capture.enabled && c && c.error) return `Listening on the server stopped: ${c.error}`;
    if (capturing() && playing() && h && now - h.at < 1500 && now - Math.max(h.soundAt, c.startedAt || 0) > 8000 && rt.live?.kind !== "browser")
      return platform === "darwin" && /blackhole/i.test(s.capture.source) ? "BlackHole is silent while music plays: make the Multi-Output Device (your speakers + BlackHole) the Mac's sound output, and allow Terminal (or Tempolight) to use the microphone in System Settings → Privacy & Security → Microphone."
        : "Tempolight's input is silent while music plays. Check that the music plays on this computer's default output.";
    if (s.hearing?.method === "mic" && playing() && rt.live?.kind !== "browser" && !s.capture.enabled) return "The microphone listens in a browser tab: keep Tempolight open in a tab on this computer (or phone), with the microphone allowed.";
    return null;
  }
  rt.hearing = { info: () => ({ platform, problem: problem(), blackhole: H.cached()?.blackhole?.name || null }) };

  async function view(force = false) {
    const d = await H.detect(force), s = set(), hi = runtime.hearingInfo(), cap = hi.capture, now = performance.now(), src = computerSource(d), h = capH();
    const onIt = !!(src.id && s.capture.enabled && s.capture.source === src.id && !s.capture.command), running = onIt && capturing();
    const heard = running && !!cap?.sound, heardLately = running && !!h && now - h.soundAt < 120000;
    const st = c => c === true ? "ok" : c === false ? "no" : c; // "maybe" and "todo" pass through
    let steps;
    if (platform === "darwin") {
      const o = d.output;
      const outState = heardLately ? "ok" : o?.blackhole ? "no" : o?.multi ? "maybe" : o ? "no" : "maybe";
      steps = [
        { id: "blackhole", label: d.blackhole ? `${d.blackhole.name} installed` : "BlackHole installed", state: st(!!d.blackhole) },
        { id: "ffmpeg", label: "ffmpeg installed (Tempolight reads BlackHole with it)", state: st(d.ffmpeg) },
        { id: "output", label: "Multi-Output Device with your speakers + BlackHole is the Mac's output", state: outState,
          detail: heardLately ? `Sound arrives through BlackHole${o ? ` (output: ${o.name})` : ""}.` : o?.blackhole ? "The Mac's output is BlackHole itself, so the speakers are silent. Make a Multi-Output Device (below) and pick that instead."
            : o?.multi ? `The output is ${o.name}. Play something in Spotify: when Tempolight hears it, this is confirmed.` : o ? `The output is ${o.name}, so BlackHole gets nothing. Pick the Multi-Output Device as the output.` : "Couldn't read the output; play something and Tempolight checks by listening." },
        { id: "hears", label: "Tempolight hears it", state: heard ? "ok" : running ? (playing() ? "no" : "todo") : "todo", level: running ? cap?.level || 0 : 0,
          detail: heard ? "" : running ? (playing() ? "Silence from BlackHole while music plays." : "Listening. Play something in Spotify.") : "Turn on listening below." },
      ];
    } else if (platform === "win32") {
      steps = [
        { id: "ffmpeg", label: "ffmpeg installed", state: st(d.ffmpeg) },
        { id: "loopback", label: d.loopback ? `${d.loopback} is on` : "Stereo Mix (or another loopback input) is on", state: st(!!d.loopback) },
        { id: "hears", label: "Tempolight hears it", state: heard ? "ok" : running ? (playing() ? "no" : "todo") : "todo", level: running ? cap?.level || 0 : 0 },
      ];
    } else {
      steps = [
        { id: "pulse", label: "PulseAudio / PipeWire found", state: st(!!(d.monitor || (d.ffmpegPulse && d.defaultSink))), detail: d.server || "" },
        ...(d.output ? [{ id: "output", label: `Plays to ${d.output.name}${d.output.bluetooth ? " (Bluetooth)" : ""}`, state: "ok" }] : []),
        { id: "hears", label: "Tempolight hears it", state: heard ? "ok" : running ? (playing() ? "no" : "todo") : "todo", level: running ? cap?.level || 0 : 0 },
      ];
    }
    const all = d.sources || [];
    return {
      platform, method: s.hearing?.method || "", problem: problem(),
      recommended: platform === "darwin" ? "computer" : platform === "win32" ? (d.loopback ? "computer" : "mic") : src.id ? "computer" : all.length ? "pi" : "mic",
      computer: { kind: platform === "darwin" ? "blackhole" : platform === "win32" ? "loopback" : "pulse", source: src.id || null, why: src.why || null, on: onIt, running, steps,
        device: platform === "darwin" ? d.blackhole?.name || null : platform === "win32" ? d.loopback : d.defaultSink ? `${d.defaultSink}.monitor` : null, inputs: d.inputs || null },
      pi: { available: platform === "linux" && all.length > 0, source: all[0]?.id || null, label: all[0]?.label || null, on: s.capture.enabled && s.capture.source === "auto" && !s.capture.command },
      capture: { enabled: s.capture.enabled, source: s.capture.source, command: s.capture.command, label: cap?.label || null, running: !!cap?.running, error: cap?.error || null, level: cap?.level || 0, sound: !!cap?.sound },
      output: runtime.hearingInfo().output, detectedOutput: d.output || null, bluetoothConnected: d.btConnected || [],
    };
  }

  async function watchOutput() { try { const o = await H.output(); if (runtime.setOutput(o)) core.broadcast({ type: "changed", what: "output" }); } catch {} }
  const timer = interval > 0 ? setInterval(watchOutput, interval) : null; if (timer?.unref) timer.unref();
  if (interval >= 0) watchOutput();

  core.route("GET", "/api/hearing", null, () => view(false));
  core.route("POST", "/api/hearing/check", null, async () => { const v = await view(true); await watchOutput(); return { ...v, output: runtime.hearingInfo().output }; });
  core.route("POST", "/api/hearing/use", "admin", async ctx => {
    const choice = String(ctx.body?.choice ?? ""), s = set();
    if (choice === "computer") { const d = await H.detect(true), src = computerSource(d); if (!src.id) throw new HttpError(400, src.why);
      core.applySettings({ capture: { enabled: true, source: src.id, command: "" }, hearing: { method: "computer" } }); runtime.note(`Hearing music: this computer's sound (${src.id.replace(/^\w+:/, "")}), on the server: no browser needed`); }
    else if (choice === "pi") { const all = (() => { try { return listSources(); } catch { return []; } })(); if (!all.length) throw new HttpError(400, "No sound input found on this computer: plug in a USB sound card or microphone (and install alsa-utils or pulseaudio-utils).");
      core.applySettings({ capture: { enabled: true, source: "auto", command: "" }, hearing: { method: "pi" } }); runtime.note(`Hearing music: ${all[0].label}, automatically`); }
    else if (choice === "mic") { core.applySettings({ hearing: { method: "mic" }, ...(s.capture.enabled && ["computer", "pi"].includes(s.hearing?.method) ? { capture: { enabled: false } } : {}) }); runtime.note("Hearing music: a browser's microphone (keep the tab open)"); }
    else if (choice === "") { core.applySettings({ hearing: { method: "" }, ...(["computer", "pi"].includes(s.hearing?.method) ? { capture: { enabled: false } } : {}) }); }
    else throw new HttpError(400, "Choose computer, mic or pi");
    return view(false);
  });
  return { hearing: H, view, watchOutput, close() { if (timer) clearInterval(timer); delete rt.hearing; } };
}
