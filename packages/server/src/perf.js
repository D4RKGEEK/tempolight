// Performance modes for small computers (Raspberry Pi Zero 2 W, Pi 3, old laptops). No Node.js modules: the runtime
// uses this in the browser demo too; the Node server passes in what it knows about the computer (node-io.js hostInfo).
//   full: everything at the frame rate you set.
//   lite: at most 30 fps, the preview at 15 fps, phones and status messages at half rate, and the live analyser skips
//         part of its heavier extras (chroma every 2nd frame, the vocal estimate at half rate).
//   auto: lite on a weak computer (see weakHost), or when the frame loop can't keep up (see createPerf's check).

export const LITE = { fps: 30, previewFps: 15, phoneFps: 15, statusEvery: 2 }; // statusEvery: every 2nd status message (500 ms)
export const MODES = ["auto", "full", "lite"];

/**
 * Is this a computer that should start in low-power mode?
 * @param {{cores?:number, cpus?:{model?:string, speed?:number}[], arch?:string, model?:string, cpuinfo?:string}} h
 *   cores/cpus: os.cpus(); arch: process.arch; model: /proc/device-tree/model; cpuinfo: /proc/cpuinfo
 * @returns {{weak:boolean, why:string}}
 */
export function weakHost(h = {}) {
  const model = String(h.model || "").replace(/\0/g, "").trim(), info = String(h.cpuinfo || "");
  const cores = h.cores ?? (Array.isArray(h.cpus) ? h.cpus.length : 0);
  const speeds = (h.cpus || []).map(c => Number(c.speed) || 0).filter(v => v > 0), mhz = speeds.length ? Math.max(...speeds) : 0;
  const pi = model || (/^Model\s*:\s*(.+)$/m.exec(info) || [])[1] || "";
  if (/Raspberry Pi (Zero|[123]\b|Model [AB]|Compute Module [123]\b)/i.test(pi)) return { weak: true, why: pi.trim() };
  if (h.arch === "arm" || /ARMv[67]/i.test(info) || /^CPU architecture\s*:\s*[67]\s*$/m.test(info)) return { weak: true, why: "a 32-bit ARM processor" };
  if (cores === 1) return { weak: true, why: "a single CPU core" };
  if (cores > 0 && cores <= 2 && mhz > 0 && mhz < 1600) return { weak: true, why: `${cores} slow CPU cores (${mhz} MHz)` };
  return { weak: false, why: "" };
}

/**
 * The runtime's performance state: which mode is on, the frame time and how much of the CPU the hot paths use.
 * @param {{setting:()=>string, host:()=>object|null, note:(msg:string, level?:string)=>void, cpuUsage?:()=>{user:number, system:number}|null, clock?:()=>number}} o
 */
export function createPerf({ setting, host, note, cpuUsage = null, clock = () => performance.now() }) {
  const hw = weakHost(host() || {});
  const P = {
    mode: "full", why: "", stepped: false, // stepped: auto stepped down because the frame loop couldn't keep up
    frameMs: 0, fps: 0, cpu: null, load: 0, // frameMs: average work per frame; load: share of one core the measured parts use
    acc: { analysis: 0, memory: 0, render: 0, output: 0, broadcast: 0 }, // ms spent, since start (the bench reads these)
    win: { t: clock(), work: 0, frames: 0, other: 0, slow: 0 }, cpu0: null,
    get lite() { return P.mode === "lite"; },
    /** Work out the mode again (the setting changed). Returns true if it changed. */
    update() {
      const s = MODES.includes(setting()) ? setting() : "auto", was = P.mode;
      if (s !== "auto") { P.stepped = false; P.mode = s; P.why = "set in Settings"; }
      else if (hw.weak) { P.mode = "lite"; P.why = `auto: ${hw.why}`; }
      else if (P.stepped) { P.mode = "lite"; P.why = "auto: the frame loop couldn't keep up"; }
      else { P.mode = "full"; P.why = "auto"; }
      return P.mode !== was;
    },
    add(k, ms) { P.acc[k] = (P.acc[k] || 0) + ms; if (k !== "render" && k !== "output") P.win.other += ms; },
    /**
     * Called after every frame with its work time. Every 5 s: the averages; in auto mode, two windows in a row where the
     * frame work takes most of the frame time (or frames come late while the hot paths keep a core busy) step down to lite.
     * Returns true when the mode changed (the loop must restart at the new rate).
     */
    frame(workMs, targetFps) {
      const w = P.win; w.work += workMs; w.frames++;
      const now = clock(), el = now - w.t; if (el < 5000) return false;
      P.frameMs = Math.round(w.work / Math.max(1, w.frames) * 100) / 100; P.fps = Math.round(w.frames * 1000 / el * 10) / 10;
      P.load = Math.round((w.work + w.other) / el * 100) / 100;
      if (cpuUsage) { const c = cpuUsage(); if (c && P.cpu0) P.cpu = Math.round(((c.user - P.cpu0.user) + (c.system - P.cpu0.system)) / 1000 / el * 100); P.cpu0 = c; }
      const budget = 1000 / targetFps, behind = P.frameMs > budget * 0.7 || (P.fps < targetFps * 0.8 && P.load > 0.5);
      w.slow = behind ? w.slow + 1 : 0; w.t = now; w.work = 0; w.frames = 0; w.other = 0;
      if (P.mode === "full" && setting() !== "full" && w.slow >= 2 && !P.stepped) {
        P.stepped = true; P.update(); note(`This computer can't keep up at ${targetFps} fps (${P.frameMs} ms a frame): switched to low-power mode (Settings, Performance)`, "warn"); return true; }
      return false;
    },
    // cpu: percent of one core the whole process uses (the Node server), or the measured parts alone (the browser demo)
    status() { return { mode: P.mode, setting: MODES.includes(setting()) ? setting() : "auto", why: P.why, fps: P.fps, frameMs: P.frameMs, cpu: P.cpu ?? Math.round(P.load * 100) }; },
  };
  P.update();
  return P;
}
