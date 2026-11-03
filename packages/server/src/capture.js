// Listening on the computer Tempolight runs on (a Raspberry Pi next to the speakers, or a PC), using whatever audio
// tool the system already has. Each source is a command that writes raw 16-bit mono samples at 22,050 Hz to stdout.
// When the app is opened in a browser, the browser can send its audio instead (see the Music page); this file is for
// headless setups.
import { spawn, spawnSync } from "node:child_process";

export const RATE = 22050;
const has = cmd => { try { const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }); return r.status === 0; } catch { return false; } };

/** Audio sources this computer can capture from, best first. */
export function listSources() {
  const out = [], raw = ["-f", "s16le", "-ac", "1", "-ar", String(RATE), "-"], q = ["-hide_banner", "-loglevel", "error"];
  if (process.platform === "linux") {
    if (has("parec")) {
      out.push({ id: "parec-monitor", label: "What's playing on this computer (PulseAudio / PipeWire)", cmd: ["parec", "--device=@DEFAULT_MONITOR@", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--raw", "--latency-msec=20"] });
      out.push({ id: "parec-input", label: "Microphone or line-in (PulseAudio / PipeWire)", cmd: ["parec", "--device=@DEFAULT_SOURCE@", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--raw", "--latency-msec=20"] });
    }
    if (has("arecord")) out.push({ id: "alsa", label: "Sound card input (ALSA, e.g. USB sound card on a Pi)", cmd: ["arecord", "-q", "-f", "S16_LE", "-r", String(RATE), "-c", "1", "-t", "raw", "--buffer-time=40000"] });
    if (has("ffmpeg")) out.push({ id: "ffmpeg-pulse", label: "Default input via ffmpeg (PulseAudio)", cmd: ["ffmpeg", ...q, "-f", "pulse", "-i", "default", ...raw] });
  } else if (process.platform === "darwin") {
    if (has("ffmpeg")) out.push({ id: "ffmpeg-avf", label: "Default input via ffmpeg (for system sound install BlackHole and pick it as input)", cmd: ["ffmpeg", ...q, "-f", "avfoundation", "-i", ":0", ...raw] });
  } else if (process.platform === "win32") {
    if (has("ffmpeg")) out.push({ id: "ffmpeg-dshow", label: "Stereo Mix via ffmpeg (enable Stereo Mix in Windows sound settings)", cmd: ["ffmpeg", ...q, "-f", "dshow", "-i", "audio=Stereo Mix", ...raw] });
  }
  return out;
}

/** A command that plays a file in real time as a source (for testing a setup without a sound card). */
export function fileSource(file) {
  return { id: "file", label: `File: ${file}`, cmd: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(RATE), "-"] };
}

/**
 * Start capturing. onSamples gets Int16Array chunks; onExit(reason) when the process ends.
 * @param {string[]} cmd
 */
export function startCapture(cmd, onSamples, onExit) {
  let left = null, stderr = "";
  const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", d => {
    if (left) { d = Buffer.concat([left, d]); left = null; }
    const n = d.length >> 1; if (d.length & 1) left = d.subarray(d.length - 1);
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
