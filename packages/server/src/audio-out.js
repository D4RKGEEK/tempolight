// Lookahead mode's sound output: Tempolight plays the music to the real speakers itself (a few seconds late, see
// passthrough.js), through a tool the computer already has:
//
//   macOS    ffmpeg's AudioToolbox output: `ffmpeg -f s16le -ar 44100 -ac 2 -i - -f audiotoolbox -audio_device_index N -`.
//            The speakers are listed with `ffmpeg -f lavfi -i anullsrc -f audiotoolbox -list_devices true -`
//            ("[0]  BlackHole 2ch, BlackHole2ch_UID"); the index can change when a device comes or goes, so the
//            speaker is remembered by name and its index looked up each time.
//   Linux    PulseAudio / PipeWire: ffmpeg's pulse output (`-f pulse -device <sink>`), else pacat.
//   Windows  Not yet: ffmpeg has no sound output on Windows. (Lookahead mode says so; everything else works.)
//
// ffmpeg reports how much it has played (-progress, out_time_us); passthrough.js follows that clock so the delay
// doesn't creep. Node only (app.js starts lookahead mode, like hearing.js).
import { spawn } from "node:child_process";

export const OUT_RATE = 44100; // (the live analyser halves it to the 22,050 Hz it is tuned for)
const Q = ["-hide_banner", "-loglevel", "error", "-nostdin"];

/** `ffmpeg ... -f audiotoolbox -list_devices true`: [{index, name, uid}] (it prints them on stderr). */
export function parseAudioToolboxDevices(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /\[(\d+)\]\s+(.+?),\s*(\S+)\s*$/.exec(line.replace(/^\[[^\]]*@[^\]]*\]\s*/, "")); // "[AudioToolbox @ 0x…] [2]   Stone 620, 00-11-…:output"
    if (m && !out.some(d => d.index === Number(m[1]))) out.push({ index: Number(m[1]), name: m[2].trim(), uid: m[3] });
  }
  return out;
}

/** Speakers that suit lookahead mode best first: not BlackHole (that is where the music comes from), not a Multi-Output Device. */
export function rankOutputs(list) {
  const bad = d => /blackhole|multi-?output|aggregate|tempolight/i.test(d.name) ? 2 : 0, bt = d => d.bluetooth || /^([0-9a-f]{2}-){5}[0-9a-f]{2}/i.test(d.uid || "") || (/speaker|stone|jbl|bose|sonos|airpods|headphone|buds|boom/i.test(d.name) && !/macbook|imac|built-?in|display/i.test(d.name)) ? -1 : 0; // an external speaker before the built-in one
  return [...list].sort((a, b) => (bad(a) + bt(a)) - (bad(b) + bt(b)));
}

/**
 * The command that plays raw 16-bit stereo from stdin to a speaker.
 * @param {{platform:string, device:{index?:number, name:string, sink?:string}, rate?:number, has?:(cmd:string)=>boolean}} o
 * @returns {{cmd:string[], progress:boolean}|null} progress: it reports what it has played (ffmpeg)
 */
export function outputCommand({ platform, device, rate = OUT_RATE, has = () => true }) {
  const input = ["-f", "s16le", "-ar", String(rate), "-ac", "2", "-i", "-"], prog = ["-progress", "pipe:2", "-stats_period", "0.25"];
  if (platform === "darwin") return device && Number.isInteger(device.index) && has("ffmpeg") ? { cmd: ["ffmpeg", ...Q, "-fflags", "nobuffer", ...input, ...prog, "-f", "audiotoolbox", "-audio_device_index", String(device.index), "-"], progress: true } : null;
  if (platform === "linux") {
    const sink = device?.sink || device?.name; if (!sink) return null;
    if (has("ffmpeg")) return { cmd: ["ffmpeg", ...Q, "-fflags", "nobuffer", ...input, ...prog, "-f", "pulse", "-buffer_duration", "40", "-device", sink, "Tempolight (lookahead)"], progress: true };
    if (has("pacat")) return { cmd: ["pacat", "--playback", `--device=${sink}`, "--format=s16le", `--rate=${rate}`, "--channels=2", "--raw", "--latency-msec=40", "--client-name=Tempolight", "--stream-name=Tempolight (lookahead)"], progress: false };
    return null;
  }
  return null;
}

/**
 * Start playing. write(Int16Array) sends samples; onPlayed(frames, at) when the tool says how much it has played;
 * onExit(reason) when it ends.
 */
export function startOutput(cmd, { rate = OUT_RATE, onPlayed = null, onExit = null, spawnFn = spawn } = {}) {
  const p = spawnFn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "pipe"] }); let err = "", buf = "", closed = false;
  p.stdin.on("error", () => {}); // (it ended: onExit says why)
  p.stderr.on("data", d => {
    buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // (ffmpeg's out_time_ms is in microseconds too)
      if (m) { onPlayed && onPlayed(Number(m[1]) / 1e6 * rate, performance.now()); continue; }
      if (!/^\w+=/.test(line) && line) err = (err + "\n" + line).slice(-1500); }
  });
  p.on("error", e => { closed = true; onExit && onExit(`Couldn't start ${cmd[0]}: ${e.message}`); });
  p.on("exit", code => { closed = true; onExit && onExit(code ? `${cmd[0]} stopped (exit ${code}) ${err.trim().split("\n").pop() || ""}`.trim() : "ended"); });
  return {
    write(a) { if (closed || !p.stdin.writable) return false; return p.stdin.write(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); },
    stop() { closed = true; try { p.stdin.end(); } catch {} try { p.kill(); } catch {} },
    get pid() { return p.pid; },
  };
}
