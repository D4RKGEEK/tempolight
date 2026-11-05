// Listening on the computer Tempolight runs on (a Raspberry Pi next to the speakers, or a PC), using whatever audio
// tool the system already has. Each source is a command that writes raw 16-bit samples at 22,050 Hz to stdout: mono, or
// interleaved stereo (channels: 2) for what the computer plays (a monitor, BlackHole, Stereo Mix, a file), so the lights
// can follow left and right (a mono source sent as stereo is noticed and treated as mono).
// When the app is opened in a browser, the browser can send its audio instead (see the Music page); this file is for
// headless setups.
import { spawn, spawnSync } from "node:child_process";

export const RATE = 22050;
const has = cmd => { try { const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }); return r.status === 0; } catch { return false; } };

/** Audio sources this computer can capture from, best first. */
export function listSources() {
  const out = [], raw = ["-f", "s16le", "-ac", "2", "-ar", String(RATE), "-"], q = ["-hide_banner", "-loglevel", "error"];
  if (process.platform === "linux") {
    if (has("parec")) {
      out.push({ id: "parec-monitor", label: "What's playing on this computer (PulseAudio / PipeWire)", channels: 2, cmd: ["parec", "--device=@DEFAULT_MONITOR@", "--format=s16le", `--rate=${RATE}`, "--channels=2", "--raw", "--latency-msec=20"] });
      out.push({ id: "parec-input", label: "Microphone or line-in (PulseAudio / PipeWire)", cmd: ["parec", "--device=@DEFAULT_SOURCE@", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--raw", "--latency-msec=20"] });
    }
    if (has("arecord")) out.push({ id: "alsa", label: "Sound card input (ALSA, e.g. USB sound card on a Pi)", cmd: ["arecord", "-q", "-f", "S16_LE", "-r", String(RATE), "-c", "1", "-t", "raw", "--buffer-time=40000"] });
    if (has("ffmpeg")) out.push({ id: "ffmpeg-pulse", label: "Default input via ffmpeg (PulseAudio)", channels: 2, cmd: ["ffmpeg", ...q, "-f", "pulse", "-i", "default", ...raw] });
  } else if (process.platform === "darwin") {
    if (has("ffmpeg")) out.push({ id: "ffmpeg-avf", label: "Default input via ffmpeg (for system sound install BlackHole and pick it as input)", channels: 2, cmd: ["ffmpeg", ...q, "-f", "avfoundation", "-i", ":0", ...raw] });
  } else if (process.platform === "win32") {
    if (has("ffmpeg")) out.push({ id: "ffmpeg-dshow", label: "Stereo Mix via ffmpeg (enable Stereo Mix in Windows sound settings)", channels: 2, cmd: ["ffmpeg", ...q, "-f", "dshow", "-i", "audio=Stereo Mix", ...raw] });
  }
  return out;
}

/**
 * A source for one named input, as the guided "How should Tempolight hear your music?" panel picks it (hearing.js):
 *   avf:<name>    macOS input by name through ffmpeg (BlackHole 2ch); a name, unlike an index, survives a new device
 *   dshow:<name>  Windows input by name through ffmpeg (Stereo Mix, CABLE Output); a 20 ms buffer instead of 500 ms
 *   pulse:<name>  a PulseAudio / PipeWire source (the monitor of a sink), with parec, else ffmpeg
 * null for any other id (the fixed ones are in listSources).
 */
export function sourceFor(id) {
  const m = /^(avf|dshow|pulse):(.+)$/.exec(String(id || "")); if (!m) return null;
  const name = m[2], raw = ["-f", "s16le", "-ac", "2", "-ar", String(RATE), "-"], q = ["-hide_banner", "-loglevel", "error"];
  if (m[1] === "avf") return { id, label: `${name} (macOS input)`, channels: 2, cmd: ["ffmpeg", ...q, "-fflags", "nobuffer", "-f", "avfoundation", "-i", `:${name}`, ...raw] };
  if (m[1] === "dshow") return { id, label: `${name} (Windows input)`, channels: 2, cmd: ["ffmpeg", ...q, "-fflags", "nobuffer", "-f", "dshow", "-audio_buffer_size", "20", "-i", `audio=${name}`, ...raw] };
  return { id, label: `${name} (PulseAudio / PipeWire)`, channels: 2, cmd: has("parec") ? ["parec", `--device=${name}`, "--format=s16le", `--rate=${RATE}`, "--channels=2", "--raw", "--latency-msec=20"] : ["ffmpeg", ...q, "-f", "pulse", "-i", name, ...raw] };
}

/** A command that plays a file in real time as a source (for testing a setup without a sound card). */
export function fileSource(file) {
  return { id: "file", label: `File: ${file}`, channels: 2, cmd: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", file, "-f", "s16le", "-ac", "2", "-ar", String(RATE), "-"] };
}

/**
 * Start capturing. onSamples gets Int16Array chunks (interleaved left/right for channels 2, whole frames only);
 * onExit(reason) when the process ends.
 * @param {string[]} cmd @param {number} [channels] 1 or 2
 */
export function startCapture(cmd, onSamples, onExit, channels = 1) {
  let left = null, stderr = "";
  const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] }), frame = channels === 2 ? 4 : 2;
  p.stdout.on("data", d => {
    if (left) { d = Buffer.concat([left, d]); left = null; }
    const whole = d.length - d.length % frame, n = whole >> 1; if (whole < d.length) left = d.subarray(whole);
    const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = d.readInt16LE(i * 2);
    onSamples(a);
  });
  p.stderr.on("data", d => { stderr = (stderr + d).slice(-2000); });
  p.on("error", e => onExit && onExit(`Couldn't start ${cmd[0]}: ${e.message}`));
  p.on("exit", code => onExit && onExit(code ? `${cmd[0]} stopped (exit ${code}) ${stderr.trim().split("\n").pop() || ""}`.trim() : "ended"));
  return { stop: () => { try { p.kill(); } catch {} }, pid: p.pid };
}

/** Split a command line typed by the user into words (supports "quoted words"). */
export function splitCommand(s) { return (String(s).match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^["']|["']$/g, "")); }
